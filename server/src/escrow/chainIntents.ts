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

export const CHAIN_INTENT_FORMAT = "gs-chain-intent";
export const CHAIN_INTENT_SCHEMA = 1;

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
  | { readonly kind: "annul"; readonly chain_game_id: string; readonly trusted_seq: string; readonly seats: number; readonly keys_digest: string };

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
 *  under any key set, or any other slot of the instance). */
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
}

type IntentSlot = ChainIntentRecord | "unreadable" | Exclude<FormatFact, "current" | "corrupt">;
const slotFormat = (slot: Exclude<IntentSlot, ChainIntentRecord>): Exclude<FormatFact, "current"> => (slot === "unreadable" ? "corrupt" : slot);

/** `records`: a string marks a file this build cannot read -- `"unreadable"` (damage), `"newer"` or `"older-unread"`. */
export function createMemoryChainIntentStore(): ChainIntentStore & { readonly records: Map<string, IntentSlot>; readonly failNext: Array<"definite" | "uncertain">; readonly writes: { count: number } } {
  const records = new Map<string, IntentSlot>();
  const failNext: Array<"definite" | "uncertain"> = [];
  const writes = { count: 0 };
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
    async create(record) {
      const existing = records.get(keyOf(record.game_id, record.intent_id));
      if (typeof existing === "string") return { kind: "failed", detail: "an unreadable intent is never overwritten" };
      if (existing !== undefined) return { kind: "exists", record: copy(existing), same: sameChainIntent(existing, record) };
      if (!isChainIntentRecord(record) || record.record_version !== 1) return { kind: "failed", detail: "not a new chain intent" };
      const written = write(record);
      return written.kind === "committed" ? { kind: "created", record: copy(record) } : { kind: "failed", detail: written.detail };
    },
    async put(next, expectedVersion) {
      const current = records.get(keyOf(next.game_id, next.intent_id));
      if (typeof current === "string") return { kind: "definite", detail: "an unreadable intent is never overwritten" };
      if (current === undefined || current.record_version !== expectedVersion) return { kind: "conflict", current: current === undefined ? null : copy(current) };
      if (!isChainIntentRecord(next) || next.record_version !== expectedVersion + 1) return { kind: "definite", detail: "not the next version of the intent" };
      return write(next);
    },
    async load(gameId, intentId) {
      const record = records.get(keyOf(gameId, intentId));
      if (typeof record === "string") throw new ChainIntentUnreadableError(`intent ${intentId} of ${gameId} is unreadable (${slotFormat(record)})`, gameId, intentId, slotFormat(record));
      return record === undefined ? null : copy(record);
    },
    async listGame(gameId) {
      const out: ChainIntentRecord[] = [];
      for (const [key, record] of records) {
        if (!key.startsWith(`${gameId}/`)) continue;
        if (typeof record === "string") throw new ChainIntentUnreadableError(`an intent of ${gameId} is unreadable (${slotFormat(record)})`, gameId, key.slice(gameId.length + 1), slotFormat(record));
        out.push(copy(record));
      }
      return out.sort((a, b) => a.created_at - b.created_at || a.intent_id.localeCompare(b.intent_id));
    },
    async games() {
      return [...new Set([...records.keys()].map((key) => key.split("/")[0]))].sort();
    },
    async formatOf(gameId) {
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
