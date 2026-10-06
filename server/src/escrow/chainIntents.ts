// server/src/escrow/chainIntents.ts
//
// ==================================================================
//  ESCROW-3B: DURABLE CHAIN INTENTS -- ONE PER SLOT, PERSISTED BEFORE EVERY EXTERNAL SIDE EFFECT
// ==================================================================
//
// Every transaction the server ever sends to the escrow is the attempt of a DURABLE INTENT, and every step that could
// have an effect outside this process is written down BEFORE it happens:
//
//   prepare   the intent: its SLOT (GNOLAND-1 `EscrowIntentKey`: start / checkpoint seq / settle seq / finalize seq /
//             relay-consent seq+seat / annul trusted_seq), its SUBJECT (the roster hash, or the codec digests it
//             carries) and the exact execute message -- create-if-absent by `intent_id = H(instance, slot)`. A second,
//             DIFFERENT subject for an occupied slot is refused (the caller HOLDS); it can never become a second intent
//             that also broadcasts.
//   sign      the transaction bytes are built from the chain's AUTHORITATIVE account sequence and signed ...
//   persist   ... and the attempt -- tx hash, account, sequence, timeout height, gas, fee and THE SIGNED BYTES -- is
//             written (compare-and-swap) and journalled (`signingJournal.ts`) before the bytes leave the process;
//   broadcast only then; the CheckTx answer is recorded;
//   observe   inclusion is learned from the chain (the tx by hash, the account sequence, the timeout height, the
//             contract's own state) -- never from a timer, never from "not found";
//   confirm   the intent's EFFECT is seen on chain (by this transaction or by any other): the intent is done.
//
// So a crash at any instruction boundary restarts into one of: nothing signed (the bytes never left: sign again from
// a fresh sequence), or a named attempt (observe it: rebroadcast THE SAME BYTES while it can still land, confirm it,
// or prove it dead and only then attempt again). A fresh, "equivalent" transaction is never built while a prior one
// might still land. No transaction hash is ever invented: every hash here is SHA-256 of bytes this server signed.
//
// Phases of an attempt (GNOLAND-1 §14): signed -> broadcast -> included-success | included-failure | dead.
// Status of an intent:
//   pending     prepared; no live attempt (it may have dead or failed ones); runnable at `retry.next_at`
//   in-flight   its newest attempt is signed or broadcast and its outcome is not yet known
//   confirmed   its effect is on chain -- TERMINAL
//   superseded  it will never be needed (a newer checkpoint covers it; the escrow left the state it needs) -- TERMINAL,
//               and only ever decided while no attempt is live
//   held        it cannot proceed without an operator (a never-retry refusal, absurd gas, a chain that contradicts it)
//
// Stored at `games/chain-intents/<game_id>/<intent_id>.json` (LIVE-3B durable replacement, the data directory's lock),
// create-if-absent and CAS on `record_version` -- the LIVE-5 conditional writes are `attribute_not_exists(intent_id)`
// and `record_version = :expected` (+ the writer epoch), exactly as the financial record's.
//
// LIVE-4 (L4-4): an intent file this build cannot read has a CLASS, read from its `format` and `schema` alone
// (`formatFactOf`): `newer` (a later build wrote it), `older-unread` (an earlier one), or `corrupt` (not an intent of any
// schema, or a damaged current one). The first two are another build's financial data: the relayer never parses or
// rewrites them (the game is not continued here); none of the three is ever overwritten.
//
// FINANCIAL PROTOCOL 4 (Phase 3 escrow 2.1, 2026-10-06): schema 2. It adds the `submit-remedy` intent (the dedicated
// REMEDY key's attestation and the seats' approvals, relayed to an escrow 2.1.0 game) and moves every intent this build
// writes to schema 2, so a protocol-3 build reads each of them as `newer` -- never parsed, never relayed, never
// rewritten -- and this build reads a protocol-3 (schema 1) intent as `older-unread`. A game has AT MOST ONE OPEN remedy
// intent and nothing after one landed (`remedyFence`): a remedy's slot is (decision, attestation expiry), so a fresh
// attestation of the same final decision is new work in its own slot, and a later decision (the Live neutral
// TimeoutAnnul once a foreclosure can no longer land; a new Async proposal) is prepared only after every earlier one
// ended without effect. A stored remedy intent whose message, key, op and subject disagree is unreadable.

import * as path from "path";

import { nodeStoreFs, type StoreFs } from "../fileLogStore";
import { durableReplace } from "../persistence/durableReplace";
import { COMMITTED, type StoreWriteOutcome } from "../persistence/storeResult";
import { GAME_ID_PATTERN } from "../rooms/gameRecord";
import {
  intentIdOf,
  sameIntentSubject,
  type DeathProof,
  type EscrowError,
  type EscrowIntentKey,
  type EscrowIntentSubject,
} from "../../../frontend/src/gameEngine/escrow/escrowModel";
import type { Coin } from "./juno/cosmosTx";
import { formatFactOf, type FormatFact } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { remedyDecisionDigestV1, remedyDigestV1, type RemedyAttestationV1, type RemedyKindByte } from "../../../frontend/src/gameEngine/escrow/junoRemedyV1";

export const CHAIN_INTENT_FORMAT = "gs-chain-intent";
export const CHAIN_INTENT_SCHEMA = 2;

export type ChainIntentStatus = "pending" | "in-flight" | "confirmed" | "superseded" | "held";
export const TERMINAL_INTENT_STATUSES: readonly ChainIntentStatus[] = Object.freeze(["confirmed", "superseded"]);

/** `consumed`: the attempt's account sequence was used on chain and no node can say by which transaction (an index that
 *  is off or pruned) -- its bytes can never be included from now on, which is all the relayer needs to know; whether
 *  the intent's EFFECT happened is read from the contract, never inferred from this. */
export type AttemptPhase = "signed" | "broadcast" | "included-success" | "included-failure" | "consumed" | "dead";

export interface ChainAttempt {
  readonly n: number;
  readonly account: string;
  readonly account_number: string;
  readonly sequence: string;
  /** The attempt's expiry: after this height the chain can never include these bytes. */
  readonly timeout_height: string;
  readonly gas_limit: string;
  readonly fee: Coin;
  /** SHA-256 of `tx_bytes` (upper-case hex): the attempt's identity. */
  readonly tx_hash: string;
  /** The signed TxRaw (base64), kept so a retry rebroadcasts exactly these bytes. Public once broadcast; no secret. */
  readonly tx_bytes: string;
  readonly phase: AttemptPhase;
  readonly signed_at: number;
  /** The last CheckTx answer (code 0 = accepted into a mempool). Never inclusion. */
  readonly broadcast: { readonly at: number; readonly code: number; readonly codespace: string; readonly log: string } | null;
  readonly broadcasts: number;
  readonly inclusion: { readonly height: string; readonly code: number; readonly codespace: string; readonly log: string } | null;
  readonly error: EscrowError | null;
  readonly death: DeathProof | null;
  readonly observed_at: number | null;
  /** How many observations found nothing decisive (bounded: past the budget the intent is held for an operator). */
  readonly unknown_observations: number;
  /** The height of the chain read that ended it (its inclusion, the death proof, the account read that found its
   *  sequence spent); null while live, or when the answering node did not say. A decision that relies on "this attempt
   *  can never land" (the reversible roster freeze) reads the escrow at or above this height. */
  readonly resolved_height: string | null;
}

/** What the intent submits, kept whole so it can be rebuilt and verified (never re-derived from live state).
 *  ESCROW-4: `consent` relays ONE seat's CONSENT signature (made by that seat's own consent key, verified by the server
 *  against the chain's CURRENT key before the intent exists) to the stored settlement `seq`/`settle_digest`; `annul`
 *  relays every seat's ANNUL signature over (domain, `trusted_seq`). The server never makes either signature. */
export type ChainIntentOp =
  | { readonly kind: "start"; readonly chain_game_id: string; readonly roster_hash: string }
  | { readonly kind: "checkpoint"; readonly chain_game_id: string; readonly seq: string; readonly log_len: number; readonly round_key: string; readonly settle_digest: string; readonly signer_key_id: number }
  | { readonly kind: "settle"; readonly chain_game_id: string; readonly seq: string; readonly log_len: number; readonly settle_digest: string; readonly signer_key_id: number }
  | { readonly kind: "finalize"; readonly chain_game_id: string; readonly seq: string }
  | { readonly kind: "consent"; readonly chain_game_id: string; readonly seq: string; readonly seat_index: number; readonly settle_digest: string; readonly consent_pubkey: string }
  | { readonly kind: "annul"; readonly chain_game_id: string; readonly trusted_seq: string; readonly seats: number; readonly keys_digest: string }
  /** FP4: one remedy attestation (`junoRemedyV1.ts`), relayed with the approvals it needs. `remedy_digest` is what the
   *  REMEDY key signed (the chain records it in `game.remedy.remedy_digest`); `decision` is the remedy's identity without
   *  its attestation time, expiry and key id. The server never makes an approval: each is a seat's own consent-key
   *  signature. Every field here is the message's own (`isChainIntentRecord` recomputes them from `msg_json`). */
  | {
      readonly kind: "remedy";
      readonly chain_game_id: string;
      readonly remedy: 1 | 2 | 3 | 4 | 5;
      readonly defaulting_seat: number;
      readonly strike: number;
      readonly overdue_epoch: string;
      readonly log_len: string;
      readonly final_at: string;
      readonly attested_at: string;
      readonly expires_at: string;
      /** The first block second this intent can no longer land: min(attestation expiry, every approval's horizon). */
      readonly usable_until: string;
      readonly remedy_key_id: number;
      readonly remedy_digest: string;
      readonly decision: string;
      /** Bit i = seat i's REMEDY-APPROVE signature is carried (0 for remedies 1 and 3). */
      readonly approvals: number;
    };

export interface ChainIntentRecord {
  readonly format: typeof CHAIN_INTENT_FORMAT;
  readonly schema: typeof CHAIN_INTENT_SCHEMA;
  readonly intent_id: string;
  readonly game_id: string;
  readonly instance: string;
  readonly key: EscrowIntentKey;
  readonly subject: EscrowIntentSubject;
  readonly op: ChainIntentOp;
  /** The exact execute message (JSON text) every attempt carries. Fixed at creation. */
  readonly msg_json: string;
  readonly status: ChainIntentStatus;
  readonly record_version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly attempts: readonly ChainAttempt[];
  readonly confirmation: { readonly how: "tx" | "chain-state"; readonly tx_hash: string | null; readonly height: string | null; readonly detail: string; readonly at: number } | null;
  readonly superseded: { readonly why: string; readonly at: number } | null;
  readonly hold: { readonly code: string; readonly detail: string; readonly at: number } | null;
  readonly retry: { readonly failures: number; readonly next_at: number };
}

export const MAX_ATTEMPTS = 32;

export function newChainIntent(input: {
  readonly game_id: string;
  readonly instance: string;
  readonly key: EscrowIntentKey;
  readonly subject: EscrowIntentSubject;
  readonly op: ChainIntentOp;
  readonly msg_json: string;
  readonly now: number;
}): ChainIntentRecord {
  return {
    format: CHAIN_INTENT_FORMAT,
    schema: CHAIN_INTENT_SCHEMA,
    intent_id: intentIdOf(input.instance, input.key),
    game_id: input.game_id,
    instance: input.instance,
    key: input.key,
    subject: input.subject,
    op: input.op,
    msg_json: input.msg_json,
    status: "pending",
    record_version: 1,
    created_at: input.now,
    updated_at: input.now,
    attempts: [],
    confirmation: null,
    superseded: null,
    hold: null,
    retry: { failures: 0, next_at: input.now },
  };
}

/* ------------------------------------------------------------------ */
/* Shape and invariants                                                */
/* ------------------------------------------------------------------ */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const KEYS = ["format", "schema", "intent_id", "game_id", "instance", "key", "subject", "op", "msg_json", "status", "record_version", "created_at", "updated_at", "attempts", "confirmation", "superseded", "hold", "retry"];
const STATUSES: readonly ChainIntentStatus[] = ["pending", "in-flight", "confirmed", "superseded", "held"];
const PHASES: readonly AttemptPhase[] = ["signed", "broadcast", "included-success", "included-failure", "consumed", "dead"];
export const isLiveAttempt = (attempt: ChainAttempt): boolean => attempt.phase === "signed" || attempt.phase === "broadcast";

/** A stored intent is exactly this shape and obeys its invariants, or it is unreadable (never guessed at). */
export function isChainIntentRecord(value: unknown): value is ChainIntentRecord {
  if (!isObject(value) || Object.keys(value).length !== KEYS.length || !KEYS.every((key) => key in value)) return false;
  if (value.format !== CHAIN_INTENT_FORMAT || value.schema !== CHAIN_INTENT_SCHEMA) return false;
  if (typeof value.intent_id !== "string" || !/^[0-9a-f]{64}$/.test(value.intent_id)) return false;
  if (typeof value.game_id !== "string" || !GAME_ID_PATTERN.test(value.game_id) || typeof value.instance !== "string") return false;
  if (!isObject(value.key) || !isObject(value.subject) || !isObject(value.op) || typeof value.msg_json !== "string") return false;
  if (!(STATUSES as readonly unknown[]).includes(value.status)) return false;
  if (!Number.isSafeInteger(value.record_version) || (value.record_version as number) < 1) return false;
  if (!Array.isArray(value.attempts) || value.attempts.length > MAX_ATTEMPTS) return false;
  let intentId: string;
  try {
    intentId = intentIdOf(value.instance as string, value.key as unknown as EscrowIntentKey);
  } catch {
    return false;
  }
  if (intentId !== value.intent_id) return false;
  /* FP4: a remedy intent's key, subject and op name ONE decision and ONE attestation (a damaged file must never relay an
     attestation its slot was not made for). */
  const key = value.key as Record<string, unknown>;
  const subject = value.subject as Record<string, unknown>;
  const op = value.op as Record<string, unknown>;
  const remedy = key.op === "submit-remedy";
  if (remedy !== (op.kind === "remedy") || remedy !== (subject.kind === "remedy")) return false;
  if (remedy && (op.decision !== key.decision || op.expires_at !== key.expires_at || subject.decision !== key.decision || subject.remedy_digest !== op.remedy_digest || subject.protocol !== "18JUNO/REMEDY/v1")) return false;
  if (remedy && !remedyMessageAgrees(op, value.msg_json as string)) return false;
  const attempts = value.attempts as unknown[];
  for (let at = 0; at < attempts.length; at += 1) {
    const attempt = attempts[at];
    if (!isObject(attempt) || attempt.n !== at + 1 || !(PHASES as readonly unknown[]).includes(attempt.phase)) return false;
    if (typeof attempt.tx_hash !== "string" || !/^[0-9A-F]{64}$/.test(attempt.tx_hash) || typeof attempt.tx_bytes !== "string") return false;
    /* At most one live attempt, and only the newest. */
    if (at < attempts.length - 1 && (attempt.phase === "signed" || attempt.phase === "broadcast")) return false;
  }
  const newest = attempts[attempts.length - 1] as { phase?: string } | undefined;
  const live = newest !== undefined && (newest.phase === "signed" || newest.phase === "broadcast");
  if ((value.status === "in-flight") !== live && !(value.status === "held" && live)) return false;
  if ((value.status === "confirmed") !== (value.confirmation !== null)) return false;
  if ((value.status === "superseded") !== (value.superseded !== null)) return false;
  if ((value.status === "held") !== (value.hold !== null)) return false;
  if (value.status === "superseded" && live) return false;
  return isObject(value.retry) && Number.isSafeInteger(value.retry.failures) && Number.isSafeInteger(value.retry.next_at);
}

/** FP4: whether a remedy intent's message is exactly the attestation its op names -- the chain game, every attested
 *  field, the REMEDY digest and decision recomputed from the message itself, the approvals' seats (the op's bitmap,
 *  each once, each with a u64 horizon and a 64-byte hex signature) and the usable life (`usable_until`: the expiry or
 *  the earliest horizon). A damaged record never relays an attestation its slot was not made for. */
export function remedyMessageAgrees(op: Record<string, unknown>, msgJson: string): boolean {
  const lead = /^\{"submit_remedy":\{"chain_game_id":(0|[1-9][0-9]{0,19}),/.exec(msgJson);
  if (lead === null || lead[1] !== op.chain_game_id) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(msgJson);
  } catch {
    return false;
  }
  if (!isObject(parsed) || Object.keys(parsed).length !== 1 || !isObject(parsed.submit_remedy)) return false;
  const body = parsed.submit_remedy;
  if (!isObject(body.attestation) || typeof body.signature !== "string" || !/^[0-9a-f]{128}$/.test(body.signature) || !Array.isArray(body.approvals)) return false;
  const w = body.attestation;
  const big = (field: string): bigint => {
    const v = w[field];
    if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(v)) throw new Error(field);
    return BigInt(v);
  };
  let a: RemedyAttestationV1;
  let digest: string;
  let decision: string;
  try {
    a = {
      version: w.version as 1,
      domain: w.domain as string,
      chain_game_id: big("chain_game_id"),
      remedy: w.remedy as RemedyKindByte,
      defaulting_seat: w.defaulting_seat as number,
      strike: w.strike as number,
      overdue_epoch: big("overdue_epoch"),
      log_len: big("log_len"),
      log_hash: w.log_hash as string,
      allowance_secs: big("allowance_secs"),
      overdue_at: big("overdue_at"),
      final_at: big("final_at"),
      attested_at: big("attested_at"),
      expires_at: big("expires_at"),
      evidence_hash: w.evidence_hash as string,
      remedy_key_id: w.remedy_key_id as number,
    };
    digest = remedyDigestV1(a);
    decision = remedyDecisionDigestV1(a);
  } catch {
    return false;
  }
  if (Object.keys(w).length !== 16 || a.chain_game_id.toString() !== op.chain_game_id) return false;
  if (digest !== op.remedy_digest || decision !== op.decision) return false;
  const same: ReadonlyArray<[unknown, unknown]> = [
    [a.remedy, op.remedy],
    [a.defaulting_seat, op.defaulting_seat],
    [a.strike, op.strike],
    [a.overdue_epoch.toString(), op.overdue_epoch],
    [a.log_len.toString(), op.log_len],
    [a.final_at.toString(), op.final_at],
    [a.attested_at.toString(), op.attested_at],
    [a.expires_at.toString(), op.expires_at],
    [a.remedy_key_id, op.remedy_key_id],
  ];
  if (!same.every(([x, y]) => x === y)) return false;
  let bitmap = 0;
  let usableUntil = a.expires_at;
  for (const entry of body.approvals as unknown[]) {
    if (!isObject(entry) || Object.keys(entry).length !== 3 || !Number.isInteger(entry.seat_index) || (entry.seat_index as number) < 0 || (entry.seat_index as number) > 7) return false;
    if (typeof entry.signature !== "string" || !/^[0-9a-f]{128}$/.test(entry.signature)) return false;
    if (typeof entry.approve_until !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(entry.approve_until)) return false;
    const until = BigInt(entry.approve_until);
    if (until > (BigInt(1) << BigInt(64)) - BigInt(1)) return false;
    if (until < usableUntil) usableUntil = until;
    const bit = 1 << (entry.seat_index as number);
    if ((bitmap & bit) !== 0) return false;
    bitmap |= bit;
  }
  return bitmap === op.approvals && usableUntil.toString() === op.usable_until;
}

/** LIVE-4 (L4-4): the intent-file schemas this build reads and writes (`CHAIN_INTENT_SCHEMA`). */
export const READABLE_INTENT_SCHEMAS: readonly number[] = Object.freeze([CHAIN_INTENT_SCHEMA]);

/** LIVE-4 (L4-4): the class of a parsed intent document stored at `<gameId>/<intentId>.json`. A newer or older document
 *  is classified by its `format` and `schema` alone -- the rest is another build's and is never read here. */
export function chainIntentFormat(parsed: unknown, gameId: string, intentId: string): FormatFact {
  if (!isObject(parsed) || parsed.format !== CHAIN_INTENT_FORMAT) return "corrupt";
  const fact = formatFactOf(parsed.schema, READABLE_INTENT_SCHEMAS);
  if (fact !== "current") return fact;
  return isChainIntentRecord(parsed) && parsed.game_id === gameId && parsed.intent_id === intentId ? "current" : "corrupt";
}

/** LIVE-4 (L4-4): one class for a game's whole set of intent files, in the verdict's precedence: another build's
 *  writing (newer, then older-unread) outranks damage, and damage outranks current. No file at all is current. */
export function worstFormat(facts: readonly FormatFact[]): FormatFact {
  for (const fact of ["newer", "older-unread", "corrupt"] as const) if (facts.includes(fact)) return fact;
  return "current";
}

/* ------------------------------------------------------------------ */
/* Instances (review #5) and Start epochs (the reversible roster freeze) */
/* ------------------------------------------------------------------ */

/** GNOLAND-1's length-prefixed join (escrowModel.ts `framed`), replicated so configuration alone names an instance. */
const framedParts = (parts: readonly string[]): string => parts.map((part) => `${part.length}:${part}`).join("|");

/** The Juno escrow instance of a chain game from configuration alone: equal to GNOLAND-1 `escrowInstanceKey(binding)`
 *  for every Juno binding (its deployment id IS the contract address; pinned by a test). */
export function junoInstanceOf(chainId: string, contract: string, chainGameId: string): string {
  return framedParts(["juno-cosmwasm", chainId, contract, chainGameId]);
}

/** A Start is attempted once per ROSTER FREEZE (`FinancialGameRecord.roster_epoch`). The first freeze's Start is the
 *  GNOLAND-1 start slot of the instance itself; a freeze after a proven rollback gets its own slot, so a released
 *  freeze's (terminal) Start intent is never revived and a new roster never reuses its slot. */
export function startInstanceOf(instance: string, epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`start epoch ${String(epoch)} is not a positive integer`);
  return epoch === 1 ? instance : `${instance}|${framedParts(["start-epoch", String(epoch)])}`;
}

/** The Start epoch an intent's instance names for `instance` (1 for the instance itself), or null if it is not one. */
export function startEpochOf(intentInstance: string, instance: string): number | null {
  if (intentInstance === instance) return 1;
  const prefix = `${instance}|${"start-epoch".length}:start-epoch|`;
  if (!intentInstance.startsWith(prefix)) return null;
  const rest = intentInstance.slice(prefix.length);
  const match = /^([1-9][0-9]{0,8}):([1-9][0-9]{0,8})$/.exec(rest);
  if (match === null || Number(match[1]) !== match[2].length) return null;
  const epoch = Number(match[2]);
  return epoch >= 2 && startInstanceOf(instance, epoch) === intentInstance ? epoch : null;
}

/** ESCROW-4: a seat's CONSENT is relayed once per (stored settlement seq, chain seat, CONSENT KEY). A key rotation
 *  (`SetConsentKey`, the seat's wallet) clears the seat's consent on chain, so a consent signed by the NEW key is a new
 *  piece of work -- its own slot family, never a "different subject" at the old key's slot (which would hold it). */
export function consentInstanceOf(instance: string, consentPubkey: string): string {
  if (!/^0[23][0-9a-f]{64}$/.test(consentPubkey)) throw new Error("consentInstanceOf: not a 33-byte compressed key (lowercase hex)");
  return `${instance}|${framedParts(["consent-key", consentPubkey])}`;
}

/** ESCROW-4: an ANNUL is relayed once per (trusted sequence, the SET of consent keys that signed it). A key rotation
 *  between the collection and the transaction makes the collected set unusable on chain (the contract checks each seat's
 *  CURRENT key); the new set is new work in its own slot family. `keysDigest`: SHA-256 hex of the keys, in seat order. */
export function annulInstanceOf(instance: string, keysDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(keysDigest)) throw new Error("annulInstanceOf: the keys digest is not 32 bytes of lowercase hex");
  return `${instance}|${framedParts(["annul-keys", keysDigest])}`;
}

/** Whether an intent belongs to this chain game's instance (a Start of any epoch, a consent under any key, an annul
 *  under any key set, or any other slot of the instance -- a remedy's included). */
export function intentBelongsTo(intent: ChainIntentRecord, instance: string): boolean {
  if (intent.op.kind === "start") return startEpochOf(intent.instance, instance) !== null;
  if (intent.op.kind === "consent" || intent.op.kind === "annul") {
    try {
      return intent.instance === (intent.op.kind === "consent" ? consentInstanceOf(instance, intent.op.consent_pubkey) : annulInstanceOf(instance, intent.op.keys_digest));
    } catch {
      return false;
    }
  }
  return intent.instance === instance;
}

/** LIVE-5 (L5-5 handoff, applied in L5-2): what an execute message SAYS, without the signature bytes it carries. A
 *  signature is not the thing that was signed -- real AWS KMS secp256k1 ECDSA is not deterministic, so the same payload
 *  signed twice (a retry after a lost answer, a restart that re-signs a reserved digest) yields different bytes -- and a
 *  consent / annul carries each player's own signature. Every `signature` field is removed (at any depth) and the rest
 *  is put in canonical form; everything that is NOT a signature (the payload, the chain game, the seats, the roster) is
 *  still compared. A message that is not JSON is compared as it is. */
export function signedContentOf(msgJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(msgJson);
  } catch {
    return `raw:${msgJson}`;
  }
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) if (key !== "signature") out[key] = strip((value as Record<string, unknown>)[key]);
    return out;
  };
  return `json:${JSON.stringify(strip(parsed))}`;
}

/** Whether an existing intent at this slot is the SAME work as this one (else the caller HOLDS): the same slot, the same
 *  signed subject (the digests, or the roster hash), the same operation (which names the payload digest, the sequence,
 *  the seat and the keys), and the same message apart from its signature bytes (`signedContentOf`). Never the signature
 *  bytes themselves: a re-signed payload is the same work. */
export function sameChainIntent(a: ChainIntentRecord, b: ChainIntentRecord): boolean {
  return a.intent_id === b.intent_id && sameIntentSubject(a.subject, b.subject) && JSON.stringify(a.op) === JSON.stringify(b.op) && signedContentOf(a.msg_json) === signedContentOf(b.msg_json);
}

/* ------------------------------------------------------------------ */
/* FP4: the remedy fence (one open remedy intent per game)              */
/* ------------------------------------------------------------------ */

/** The margin (seconds) by which the server's clock must pass an earlier attestation's usable life before a DIFFERENT
 *  decision is prepared: the chain decides by block time, which may lag the wall clock. */
export const REMEDY_FENCE_CLOCK_MARGIN_SECS = 120;

/** What preparing `candidate` (a `submit-remedy` intent) may do at `nowMs`, given every intent the game already has:
 *  - `same`: the candidate's own slot already holds the same work (an idempotent re-prepare after a restart);
 *  - `hold`: a remedy of this game already LANDED (`confirmed`: nothing more, ever); another remedy intent is still
 *    OPEN -- pending, in flight, or held with a live attempt -- so two could both broadcast; an earlier intent of a
 *    DIFFERENT decision ended without effect here but its attestation could still land if anyone relayed it (its
 *    `usable_until`, plus `REMEDY_FENCE_CLOCK_MARGIN_SECS`, is not yet past: anyone may relay a remedy, and a key
 *    registered or a seat's approval made valid again would revive it); or the candidate's own slot holds different
 *    work;
 *  - `proceed`: every earlier remedy intent ended without effect -- `superseded` (its attestation expired, or the game
 *    or its trusted sequence moved on), or `held` with no live attempt (refused for good: an approver rotated its
 *    consent key, a contradiction) -- and none of another decision can still land. Those held ones are listed in
 *    `retire`: they are superseded first, so a game never has two open remedy intents. A fresh attestation of the same
 *    final decision (an admin pause or an outage outlived the first) proceeds at once (whichever lands, the decision is
 *    the same); a DIFFERENT decision (the Live neutral TimeoutAnnul once the foreclosure can no longer land; a new
 *    Async proposal) only once every earlier one is dead on chain too.
 *  The chain enforces one terminal outcome on its own (every remedy needs IN_PROGRESS and ends it); this fence keeps the
 *  server from ever having two that could race. Callers serialize per game (the escrow service's per-game queue): the
 *  fence reads, then writes. */
export type RemedyFence = { readonly kind: "proceed"; readonly retire: readonly ChainIntentRecord[] } | { readonly kind: "same" } | { readonly kind: "hold"; readonly why: string };

export function remedyFence(existing: readonly ChainIntentRecord[], candidate: ChainIntentRecord, nowMs: number): RemedyFence {
  if (candidate.op.kind !== "remedy") return { kind: "hold", why: "not a remedy intent" };
  const decision = candidate.op.decision;
  const remedies = existing.filter((intent) => intent.op.kind === "remedy");
  const own = remedies.find((intent) => intent.intent_id === candidate.intent_id);
  if (own !== undefined) return sameChainIntent(own, candidate) ? { kind: "same" } : { kind: "hold", why: "a different attestation occupies this remedy slot" };
  const landed = remedies.find((intent) => intent.status === "confirmed");
  if (landed !== undefined) return { kind: "hold", why: "a remedy of this game is already confirmed on chain; nothing more is prepared" };
  const open = remedies.find((intent) => intent.status === "pending" || intent.status === "in-flight" || (intent.status === "held" && intent.attempts.some(isLiveAttempt)));
  if (open !== undefined) return { kind: "hold", why: `an earlier remedy intent of this game is still ${open.status}; it must resolve before another is prepared` };
  const nowSecs = BigInt(Math.floor(nowMs / 1000));
  const margin = BigInt(REMEDY_FENCE_CLOCK_MARGIN_SECS);
  const alive = remedies.find((intent) => intent.op.kind === "remedy" && intent.op.decision !== decision && nowSecs < BigInt(intent.op.usable_until) + margin);
  if (alive !== undefined && alive.op.kind === "remedy") {
    return { kind: "hold", why: `an earlier attestation of another remedy decision could still land until ${alive.op.usable_until} (block time); a different decision waits until it cannot` };
  }
  return { kind: "proceed", retire: remedies.filter((intent) => intent.status === "held") };
}

/* ------------------------------------------------------------------ */
/* Pure moves (every write goes through one of these, then CAS)         */
/* ------------------------------------------------------------------ */

const bump = (record: ChainIntentRecord, at: number, patch: Partial<ChainIntentRecord>): ChainIntentRecord => ({
  ...record,
  ...patch,
  record_version: record.record_version + 1,
  updated_at: at,
});

export function withNewAttempt(record: ChainIntentRecord, attempt: Omit<ChainAttempt, "n" | "phase" | "broadcast" | "broadcasts" | "inclusion" | "error" | "death" | "observed_at" | "unknown_observations" | "resolved_height">, at: number): ChainIntentRecord {
  if (record.status !== "pending") throw new Error(`an attempt is only signed for a pending intent (this one is ${record.status})`);
  if (record.attempts.some(isLiveAttempt)) throw new Error("an intent never has two live attempts");
  if (record.attempts.length >= MAX_ATTEMPTS) throw new Error("the attempt budget is spent");
  const next: ChainAttempt = { ...attempt, n: record.attempts.length + 1, phase: "signed", broadcast: null, broadcasts: 0, inclusion: null, error: null, death: null, observed_at: null, unknown_observations: 0, resolved_height: null };
  return bump(record, at, { status: "in-flight", attempts: [...record.attempts, next] });
}

/** Updates the newest attempt. When it stops being live the intent is pending again, runnable at once; `failed` counts
 *  the resolution against the intent's failure budget (an attempt that did not land). */
export function withAttemptPatch(record: ChainIntentRecord, patch: Partial<ChainAttempt>, at: number, options: { readonly failed?: boolean } = {}): ChainIntentRecord {
  const newest = record.attempts[record.attempts.length - 1];
  if (newest === undefined) throw new Error("no attempt to update");
  const attempt = { ...newest, ...patch };
  const attempts = [...record.attempts.slice(0, -1), attempt];
  const live = isLiveAttempt(attempt);
  const status: ChainIntentStatus = record.status === "held" ? "held" : live ? "in-flight" : record.status === "in-flight" ? "pending" : record.status;
  const resolvedNow = isLiveAttempt(newest) && !live;
  const retry = resolvedNow ? { failures: record.retry.failures + (options.failed === true ? 1 : 0), next_at: at } : record.retry;
  return bump(record, at, { attempts, status, retry });
}

/** The intent's effect is on chain. Only the confirming transaction may still be live: any OTHER live attempt must be
 *  resolved first (included, consumed or proven dead), so the account sequence it holds is never signed over. */
export function confirmedIntent(record: ChainIntentRecord, how: "tx" | "chain-state", txHash: string | null, height: string | null, detail: string, at: number): ChainIntentRecord {
  if (record.attempts.some((attempt) => isLiveAttempt(attempt) && attempt.tx_hash !== txHash)) throw new Error("a live attempt must be resolved before its intent is confirmed another way");
  const attempts = record.attempts.map((attempt) =>
    isLiveAttempt(attempt) && attempt.tx_hash === txHash ? { ...attempt, phase: "included-success" as const, observed_at: at, resolved_height: height, ...(height !== null ? { inclusion: { height, code: 0, codespace: "", log: "" } } : {}) } : attempt,
  );
  return bump(record, at, {
    attempts,
    status: "confirmed",
    confirmation: { how, tx_hash: txHash, height, detail: detail.slice(0, 300), at },
    hold: null,
  });
}

export function supersededIntent(record: ChainIntentRecord, why: string, at: number): ChainIntentRecord {
  if (record.attempts.some(isLiveAttempt)) throw new Error("an intent with a live attempt is never superseded (observe it first)");
  return bump(record, at, { status: "superseded", superseded: { why: why.slice(0, 300), at }, hold: null });
}

export function heldIntent(record: ChainIntentRecord, code: string, detail: string, at: number): ChainIntentRecord {
  if (record.status === "held") return record;
  return bump(record, at, { status: "held", hold: { code, detail: detail.slice(0, 500), at } });
}

export function deferredIntent(record: ChainIntentRecord, nextAt: number, at: number, failed: boolean): ChainIntentRecord {
  return bump(record, at, { retry: { failures: record.retry.failures + (failed ? 1 : 0), next_at: nextAt } });
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export class ChainIntentUnreadableError extends Error {
  constructor(
    message: string,
    readonly gameId: string,
    readonly intentId: string,
    /** LIVE-4 (L4-4): which build could read it -- a later one, an earlier one, or none (damage). */
    readonly format: Exclude<FormatFact, "current"> = "corrupt",
  ) {
    super(message);
    this.name = "ChainIntentUnreadableError";
  }
}

export type IntentCreateOutcome =
  | { readonly kind: "created"; readonly record: ChainIntentRecord }
  | { readonly kind: "exists"; readonly record: ChainIntentRecord; readonly same: boolean }
  | { readonly kind: "failed"; readonly detail: string };

export type IntentPutOutcome = StoreWriteOutcome | { readonly kind: "conflict"; readonly current: ChainIntentRecord | null };

/** LIVE-5 L5-2 / LIVE-6 L6-7: one relay-queue entry -- an intent the relayer must still see (preflight §9.3). Made with
 *  its intent in ONE write; removed in the one write that makes the intent `confirmed` or `superseded` (never at `held`). */
export interface RelayQueueEntry {
  readonly game_id: string;
  readonly intent_id: string;
  readonly created_at: number;
}

/** LIVE-6 L6-7: a relay-queue entry this build cannot read (a malformed key, an attribute that disagrees with its key,
 *  an attribute too many or missing). The whole queue answer is refused -- an entry that cannot be read may name the
 *  intent holding the account's live attempt, so nothing is guessed and nothing is skipped. */
export class RelayQueueDamageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayQueueDamageError";
  }
}

export interface ChainIntentStore {
  create(record: ChainIntentRecord): Promise<IntentCreateOutcome>;
  put(next: ChainIntentRecord, expectedVersion: number): Promise<IntentPutOutcome>;
  load(gameId: string, intentId: string): Promise<ChainIntentRecord | null>;
  listGame(gameId: string): Promise<ChainIntentRecord[]>;
  /** Every game with intents. */
  games(): Promise<string[]>;
  /** LIVE-4 (L4-4): the class of a game's intent files as a set (`worstFormat`), read without parsing another build's
   *  format and without throwing. Optional for test doubles (absent: current). */
  formatOf?(gameId: string): Promise<FormatFact>;
  /** LIVE-6 L6-7: the relay queue -- the relayer's AUTHORITATIVE work discovery where the store keeps one (AWS:
   *  `RELAYQ#<relayer>`): every entry, oldest first, strongly consistent and complete (every page), and strict -- one
   *  malformed entry refuses the whole answer (`RelayQueueDamageError`). Absent (the file stores): the relayer lists every
   *  game's intents, as before. */
  relayQueue?(): Promise<RelayQueueEntry[]>;
}

/** LIVE-6 L6-7: the queue's order (the `RELAYQ#` sort key: `<created_at %013d>#<game>#<intent>`). */
export const relayQueueOrder = (a: RelayQueueEntry, b: RelayQueueEntry): number => a.created_at - b.created_at || (a.game_id < b.game_id ? -1 : a.game_id > b.game_id ? 1 : a.intent_id < b.intent_id ? -1 : a.intent_id > b.intent_id ? 1 : 0);

type IntentSlot = ChainIntentRecord | "unreadable" | Exclude<FormatFact, "current" | "corrupt">;
const slotFormat = (slot: Exclude<IntentSlot, ChainIntentRecord>): Exclude<FormatFact, "current"> => (slot === "unreadable" ? "corrupt" : slot);

/** LIVE-6 L6-7: what the memory store read (tests prove the relayer's startup work is bounded by its queue). */
export interface MemoryIntentReads {
  load: number;
  listGame: number;
  games: number;
  formatOf: number;
  queue: number;
}

/** `records`: a string marks a file this build cannot read -- `"unreadable"` (damage), `"newer"` or `"older-unread"`.
 *  LIVE-6 L6-7: `{ relayQueue: true }` keeps a relay queue as the DynamoDB store does (made with the intent, removed with
 *  its terminal write, kept while held); `queue` is open to tests (a `"malformed"` entry models damage). */
export function createMemoryChainIntentStore(options: { readonly relayQueue?: boolean } = {}): ChainIntentStore & {
  readonly records: Map<string, IntentSlot>;
  readonly failNext: Array<"definite" | "uncertain">;
  readonly writes: { count: number };
  readonly reads: MemoryIntentReads;
  readonly queue: Map<string, RelayQueueEntry | "malformed">;
} {
  const records = new Map<string, IntentSlot>();
  const failNext: Array<"definite" | "uncertain"> = [];
  const writes = { count: 0 };
  const reads: MemoryIntentReads = { load: 0, listGame: 0, games: 0, formatOf: 0, queue: 0 };
  const queue = new Map<string, RelayQueueEntry | "malformed">();
  const queued = options.relayQueue === true;
  const terminal = (status: ChainIntentStatus) => (TERMINAL_INTENT_STATUSES as readonly string[]).includes(status);
  const keyOf = (gameId: string, intentId: string) => `${gameId}/${intentId}`;
  const copy = (record: ChainIntentRecord) => JSON.parse(JSON.stringify(record)) as ChainIntentRecord;
  const write = (record: ChainIntentRecord): StoreWriteOutcome => {
    const fault = failNext.shift();
    if (fault === "definite") return { kind: "definite", detail: "injected intent-store failure (nothing written)" };
    records.set(keyOf(record.game_id, record.intent_id), copy(record));
    writes.count += 1;
    if (fault === "uncertain") return { kind: "uncertain", detail: "injected intent-store failure (outcome unknown)" };
    return COMMITTED;
  };
  return {
    records,
    failNext,
    writes,
    reads,
    queue,
    async create(record) {
      const existing = records.get(keyOf(record.game_id, record.intent_id));
      if (typeof existing === "string") return { kind: "failed", detail: "an unreadable intent is never overwritten" };
      if (existing !== undefined) return { kind: "exists", record: copy(existing), same: sameChainIntent(existing, record) };
      if (!isChainIntentRecord(record) || record.record_version !== 1) return { kind: "failed", detail: "not a new chain intent" };
      const written = write(record);
      /* The queue entry is made with the intent (the DynamoDB store's one transaction). */
      if (queued && written.kind !== "definite") queue.set(keyOf(record.game_id, record.intent_id), { game_id: record.game_id, intent_id: record.intent_id, created_at: record.created_at });
      return written.kind === "committed" ? { kind: "created", record: copy(record) } : { kind: "failed", detail: written.detail };
    },
    async put(next, expectedVersion) {
      const current = records.get(keyOf(next.game_id, next.intent_id));
      if (typeof current === "string") return { kind: "definite", detail: "an unreadable intent is never overwritten" };
      if (current === undefined || current.record_version !== expectedVersion) return { kind: "conflict", current: current === undefined ? null : copy(current) };
      if (!isChainIntentRecord(next) || next.record_version !== expectedVersion + 1) return { kind: "definite", detail: "not the next version of the intent" };
      const written = write(next);
      /* ... and removed in the write that makes it terminal (never at `held`). */
      if (queued && written.kind !== "definite" && terminal(next.status) && !terminal(current.status)) queue.delete(keyOf(next.game_id, next.intent_id));
      return written;
    },
    ...(queued
      ? {
          async relayQueue() {
            reads.queue += 1;
            const out: RelayQueueEntry[] = [];
            for (const [key, entry] of queue) {
              if (entry === "malformed") throw new RelayQueueDamageError(`the relay-queue entry ${key} is damaged`);
              out.push({ ...entry });
            }
            return out.sort(relayQueueOrder);
          },
        }
      : {}),
    async load(gameId, intentId) {
      reads.load += 1;
      const record = records.get(keyOf(gameId, intentId));
      if (typeof record === "string") throw new ChainIntentUnreadableError(`intent ${intentId} of ${gameId} is unreadable (${slotFormat(record)})`, gameId, intentId, slotFormat(record));
      return record === undefined ? null : copy(record);
    },
    async listGame(gameId) {
      reads.listGame += 1;
      const out: ChainIntentRecord[] = [];
      for (const [key, record] of records) {
        if (!key.startsWith(`${gameId}/`)) continue;
        if (typeof record === "string") throw new ChainIntentUnreadableError(`an intent of ${gameId} is unreadable (${slotFormat(record)})`, gameId, key.slice(gameId.length + 1), slotFormat(record));
        out.push(copy(record));
      }
      return out.sort((a, b) => a.created_at - b.created_at || a.intent_id.localeCompare(b.intent_id));
    },
    async games() {
      reads.games += 1;
      return [...new Set([...records.keys()].map((key) => key.split("/")[0]))].sort();
    },
    async formatOf(gameId) {
      reads.formatOf += 1;
      return worstFormat([...records.entries()].filter(([key]) => key.startsWith(`${gameId}/`)).map(([, record]) => (typeof record === "string" ? slotFormat(record) : "current")));
    },
  };
}

export function chainIntentDirectory(dataDir: string): string {
  return path.join(dataDir, "games", "chain-intents");
}

export function createFileChainIntentStore(
  dataDir: string,
  options: { fs?: StoreFs; platform?: string; writerCheck?: () => Promise<boolean>; warn?: (line: string) => void } = {},
): ChainIntentStore & { readonly directory: string; formatOf(gameId: string): Promise<FormatFact> } {
  const io = options.fs ?? nodeStoreFs;
  const directory = chainIntentDirectory(dataDir);
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const gameDir = (gameId: string) => path.join(directory, gameId);
  const fileOf = (gameId: string, intentId: string) => path.join(gameDir(gameId), `${intentId}.json`);
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  };
  const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const validIds = (gameId: string, intentId: string) => GAME_ID_PATTERN.test(gameId) && /^[0-9a-f]{64}$/.test(intentId);

  async function read(gameId: string, intentId: string): Promise<ChainIntentRecord | null> {
    let raw: Buffer;
    try {
      raw = await io.readFile(fileOf(gameId, intentId));
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new ChainIntentUnreadableError(`chain intent ${intentId} of ${gameId} is not JSON`, gameId, intentId);
    }
    const format = chainIntentFormat(parsed, gameId, intentId);
    if (format === "newer") throw new ChainIntentUnreadableError(`chain intent ${intentId} of ${gameId} is in a NEWER format than this build reads (a later build wrote it); never parsed or overwritten here`, gameId, intentId, format);
    if (format === "older-unread") throw new ChainIntentUnreadableError(`chain intent ${intentId} of ${gameId} is in an OLDER format this build no longer reads; never parsed or overwritten here`, gameId, intentId, format);
    if (format !== "current") throw new ChainIntentUnreadableError(`chain intent ${intentId} of ${gameId} is not a valid intent`, gameId, intentId);
    return parsed as ChainIntentRecord;
  }

  /** The class of one intent file, never throwing on its content (a read failure other than "absent" still throws). */
  async function classify(gameId: string, intentId: string): Promise<FormatFact> {
    try {
      await read(gameId, intentId);
      return "current";
    } catch (error) {
      if (error instanceof ChainIntentUnreadableError) return error.format;
      throw error;
    }
  }

  const fenced = async (): Promise<boolean> => options.writerCheck !== undefined && !(await options.writerCheck().catch(() => false));

  async function write(record: ChainIntentRecord): Promise<StoreWriteOutcome> {
    if (await fenced()) return { kind: "definite", detail: "this server no longer owns the data directory (its lock was taken over); nothing was written" };
    try {
      await io.mkdir(gameDir(record.game_id));
    } catch (error) {
      return { kind: "definite", detail: `could not make ${gameDir(record.game_id)}: ${describe(error)}` };
    }
    return durableReplace(io, fileOf(record.game_id, record.intent_id), Buffer.from(`${JSON.stringify(record)}\n`, "utf8"), { platform: options.platform, warn });
  }

  return {
    directory,
    create(record) {
      return serial(`${record.game_id}/${record.intent_id}`, async (): Promise<IntentCreateOutcome> => {
        if (!validIds(record.game_id, record.intent_id) || !isChainIntentRecord(record) || record.record_version !== 1) return { kind: "failed", detail: "not a new chain intent" };
        try {
          const existing = await read(record.game_id, record.intent_id);
          if (existing !== null) return { kind: "exists", record: existing, same: sameChainIntent(existing, record) };
        } catch (error) {
          return { kind: "failed", detail: `the intent cannot be read (${describe(error)}); it is never overwritten` };
        }
        const written = await write(record);
        return written.kind === "committed" ? { kind: "created", record } : { kind: "failed", detail: written.detail };
      });
    },
    put(next, expectedVersion) {
      return serial(`${next.game_id}/${next.intent_id}`, async (): Promise<IntentPutOutcome> => {
        let current: ChainIntentRecord | null;
        try {
          current = await read(next.game_id, next.intent_id);
        } catch (error) {
          return { kind: "definite", detail: `the intent cannot be read (${describe(error)}); it is never overwritten` };
        }
        if (current === null || current.record_version !== expectedVersion) return { kind: "conflict", current };
        if (!isChainIntentRecord(next) || next.record_version !== expectedVersion + 1) return { kind: "definite", detail: "not the next version of the intent" };
        return write(next);
      });
    },
    load(gameId, intentId) {
      if (!validIds(gameId, intentId)) return Promise.resolve(null);
      return serial(`${gameId}/${intentId}`, () => read(gameId, intentId));
    },
    async listGame(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return [];
      let names: string[];
      try {
        names = await io.readdir(gameDir(gameId));
      } catch (error) {
        if (codeOf(error) === "ENOENT") return [];
        throw error;
      }
      const out: ChainIntentRecord[] = [];
      for (const name of names.filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry)).sort()) {
        const record = await read(gameId, name.slice(0, -5));
        if (record !== null) out.push(record);
      }
      return out.sort((a, b) => a.created_at - b.created_at || a.intent_id.localeCompare(b.intent_id));
    },
    async games() {
      let names: string[];
      try {
        names = await io.readdir(directory);
      } catch (error) {
        if (codeOf(error) === "ENOENT") return [];
        throw error;
      }
      return names.filter((name) => GAME_ID_PATTERN.test(name)).sort();
    },
    async formatOf(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return "current";
      let names: string[];
      try {
        names = await io.readdir(gameDir(gameId));
      } catch (error) {
        if (codeOf(error) === "ENOENT") return "current";
        throw error;
      }
      const facts: FormatFact[] = [];
      for (const name of names.filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry)).sort()) facts.push(await serial(`${gameId}/${name.slice(0, -5)}`, () => classify(gameId, name.slice(0, -5))));
      return worstFormat(facts);
    },
  };
}
