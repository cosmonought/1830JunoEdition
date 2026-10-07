// server/src/escrow/juno/remedyIntents.ts
//
// ==================================================================
//  FINANCIAL PROTOCOL 4 (PHASE 3 ESCROW 2.1): THE DURABLE REMEDY INTENT
// ==================================================================
//
// A timed remedy (escrow 2.1.0 `SubmitRemedy`) is a financial operation of its own: the dedicated REMEDY key's
// attestation (`junoRemedyV1.ts`) and, where the policy needs them, every non-defaulting seat's REMEDY-APPROVE
// signature, relayed to the chain by the relayer through a durable `submit-remedy` chain intent. This module is the
// ONLY place that intent is made:
//
//   - `remedyChainIntent`  builds the record from one FINAL attestation (pure; refuses anything the contract would
//                          refuse on shape alone or against the game's start, approvals that do not match the remedy
//                          and the roster or whose seat's own horizon (`approve_until`) is not after the decision's
//                          `final_at`, and any signature that does not verify -- low-s ECDSA -- against the REMEDY key
//                          and the consent key each seat held AT `final_at` (owner ruling, 2026-10-07: approvals are
//                          judged at finality, never at the block time; the caller read the keys and their retired
//                          history from the chain);
//   - `prepareRemedyIntent` writes it once, behind the per-game fence (`remedyFence`, chainIntents.ts): never two open
//                          remedy intents for a game, nothing after one landed, idempotent across a restart (the same
//                          slot holding the same work answers `exists`); an earlier intent refused for good (held, no
//                          live attempt) is superseded first; a DIFFERENT decision waits until the chain's observed
//                          block time has passed every earlier attestation of another decision (its usable life).
//
// Restart safety, replay and durable status are the relayer's generic intent machinery (a signed-or-broadcast attempt
// is resolved by its transaction hash before anything else is signed; `effectOf` reads `game.remedy` -- the chain's
// own record of the accepted REMEDY digest -- so a remedy that landed is `confirmed` whoever submitted it, another
// remedy is `inconsistent`, and a game that ended another way or whose play went on is `moot`; an expired attestation
// is `moot` too); the chain itself accepts at most one remedy per game (every remedy needs IN_PROGRESS and ends it).
// Before relaying, the escrow service asks the remedy lane's gate (`EscrowServiceDeps.remedyGate`; absent: nothing is
// relayed), where the server clock lane's system pause will hold a pre-outage remedy.
//
// What is NOT here (the server clock / system-pause lane, not complete in Phase 3's escrow 2.1 pass): deciding that a
// remedy is final -- the 20/30 race, the strike count, the N-1 vote, voluntary and system pauses, outage continuity --
// the KMS REMEDY signer, and the gate. A caller hands this module a FINAL, signed attestation; nothing here signs.

import {
  JUNO_REMEDY_PROTOCOL_V1,
  encodeRemedyAttestationV1,
  remedyApprovalWire,
  remedyApproveDigestV1,
  remedyAttestationWire,
  remedyDecisionDigestV1,
  remedyDigestV1,
  remedyNeedsApprovals,
  remedyShapeProblem,
  type RemedyAttestationV1,
  type RemedyKindByte,
} from "../../../../frontend/src/gameEngine/escrow/junoRemedyV1";
import { ChainIntentUnreadableError, newChainIntent, remedyFence, supersededIntent, type ChainIntentRecord, type ChainIntentStore } from "../chainIntents";
import { RELAYER_EXECUTE } from "./junoContract";
import { verifyDigest } from "./secp256k1";

/** The escrow's roster bounds (`contracts/escrow/src/helpers.rs` MIN_PLAYERS..=MAX_PLAYERS: 2..=7 seats). */
const MIN_SEATS = 2;
const MAX_SEATS = 7;
const PUBKEY = /^0[23][0-9a-f]{64}$/;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const SIGNATURE = /^[0-9a-f]{128}$/;

export interface RemedyIntentInput {
  readonly game_id: string;
  /** The Juno escrow instance of the chain game (`junoInstanceOf`), whose last part is the attestation's chain game. */
  readonly instance: string;
  /** A FINAL attestation, as the REMEDY key signed it. */
  readonly attestation: RemedyAttestationV1;
  /** The REMEDY key's 64-byte low-s signature over `remedyDigestV1(attestation)` (lowercase hex). */
  readonly signature: string;
  /** The active REMEDY key `attestation.remedy_key_id` names, as the chain's registry holds it (33-byte hex). */
  readonly remedy_pubkey: string;
  /** Every seat's CURRENT consent key, in chain seat order, as the chain holds it now (the roster size is its length). */
  readonly consent_pubkeys: readonly string[];
  /** The key each seat HELD at the attestation's `final_at` (chain seat order), as the contract's `consent_key_at`
   *  query answered it once a block past `final_at` existed: what the contract verifies each approval against (an
   *  approval under a key replaced at or before `final_at` is refused here first). Absent: `consent_pubkeys` (no seat
   *  rotated since). */
  readonly approval_keys?: readonly string[];
  /** The chain game's `started_at` (Unix seconds) as the chain holds it: no seat is overdue before one whole allowance
   *  has run since it (the contract's floor). */
  readonly started_at: bigint;
  /** Each non-defaulting seat's REMEDY-APPROVE (its own consent key's signature over the digest naming its own
   *  `approve_until`), for remedies 2, 4 and 5; none else. */
  readonly approvals: readonly { readonly seat_index: number; readonly approve_until: bigint; readonly signature: string }[];
  /** Wall-clock milliseconds. */
  readonly now: number;
}

export class RemedyIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemedyIntentError";
  }
}

const verifies = (pubkeyHex: string, digestHex: string, signatureHex: string): boolean =>
  SIGNATURE.test(signatureHex) && verifyDigest(Buffer.from(pubkeyHex, "hex"), Buffer.from(digestHex, "hex"), Buffer.from(signatureHex, "hex"));

/** Why this input cannot become a remedy intent, or null. Everything here the contract also refuses: an intent that
 *  could only fail on chain is never written. */
export function remedyIntentProblem(input: RemedyIntentInput): string | null {
  const a = input.attestation;
  let shape: string | null;
  try {
    encodeRemedyAttestationV1(a); // every field in range, every hex field lowercase and exact (else nothing is written)
    shape = remedyShapeProblem(a);
  } catch (error) {
    return `the attestation is not encodable: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (shape !== null) return shape;
  if (typeof input.started_at !== "bigint" || input.started_at < BigInt(0)) return "the chain game's start time is unknown";
  if (a.overdue_at < input.started_at + a.allowance_secs) return "overdue_at precedes the end of the first allowance after the game's start";
  const seats = input.consent_pubkeys.length;
  if (seats < MIN_SEATS || seats > MAX_SEATS) return `a roster of ${seats} seats is not an escrow roster`;
  if (!input.consent_pubkeys.every((key) => PUBKEY.test(key))) return "a seat's consent key is not a 33-byte compressed key (lowercase hex)";
  if (a.defaulting_seat >= seats) return `the defaulting seat ${a.defaulting_seat} is not one of the ${seats} seats`;
  const id = a.chain_game_id.toString();
  if (!input.instance.endsWith(`|${id.length}:${id}`)) return `the instance is not chain game ${id}'s`;
  if (!PUBKEY.test(input.remedy_pubkey)) return "the REMEDY key is not a 33-byte compressed key (lowercase hex)";
  if (!SIGNATURE.test(input.signature)) return "the REMEDY signature is not 64 bytes of lowercase hex";
  if (!verifies(input.remedy_pubkey, remedyDigestV1(a), input.signature)) return "the REMEDY signature does not verify (low-s ECDSA) under the named REMEDY key";
  const kind = a.remedy as RemedyKindByte;
  if (!remedyNeedsApprovals(kind)) return input.approvals.length === 0 ? null : `remedy ${kind} carries no seat approvals`;
  const seen = new Set<number>();
  for (const approval of input.approvals) {
    if (!Number.isInteger(approval.seat_index) || approval.seat_index < 0 || approval.seat_index >= seats) return `approval seat ${String(approval.seat_index)} is not one of the ${seats} seats`;
    if (approval.seat_index === a.defaulting_seat) return `the defaulting seat ${a.defaulting_seat} cannot approve a remedy against itself`;
    if (seen.has(approval.seat_index)) return `seat ${approval.seat_index} approves twice`;
    if (typeof approval.approve_until !== "bigint" || approval.approve_until < BigInt(0) || approval.approve_until > U64_MAX) return `seat ${approval.seat_index}'s approve_until is not a u64`;
    /* The contract judges an approval at the decision's own final_at (owner ruling, 2026-10-07): its horizon must lie
       after final_at. A horizon already past at the attestation or block time changes nothing. */
    if (approval.approve_until <= a.final_at) return `seat ${approval.seat_index}'s approval ended (${approval.approve_until}) at or before the remedy became final (${a.final_at})`;
    if (!SIGNATURE.test(approval.signature)) return `seat ${approval.seat_index}'s approval is not 64 bytes of lowercase hex`;
    const held = input.approval_keys === undefined ? input.consent_pubkeys[approval.seat_index] : input.approval_keys[approval.seat_index];
    if (typeof held !== "string" || !PUBKEY.test(held)) return `seat ${approval.seat_index}'s consent key at final_at is not a 33-byte compressed key (lowercase hex)`;
    if (!verifies(held, remedyApproveDigestV1(a, approval.approve_until, approval.seat_index), approval.signature)) {
      return `seat ${approval.seat_index}'s approval does not verify under the consent key it held at final_at (for this overdue instance and horizon)`;
    }
    seen.add(approval.seat_index);
  }
  /* The policy's consensus is COMPLETE: every non-defaulting seat (N-1), never fewer. */
  if (seen.size !== seats - 1) return `remedy ${kind} needs all ${seats - 1} non-defaulting approvals, not ${seen.size}`;
  return null;
}

/** The `submit-remedy` intent for one FINAL attestation (throws `RemedyIntentError` on any `remedyIntentProblem`).
 *  Its slot is (decision, expiry); its subject binds the exact REMEDY digest; its message is the contract's
 *  `submit_remedy` with the approvals in seat order; `usable_until` is the first block second it can no longer land:
 *  the attestation's expiry (approvals are judged at `final_at`, so their horizons never end its usable life). */
export function remedyChainIntent(input: RemedyIntentInput): ChainIntentRecord {
  const problem = remedyIntentProblem(input);
  if (problem !== null) throw new RemedyIntentError(problem);
  const a = input.attestation;
  const decision = remedyDecisionDigestV1(a);
  const remedyDigest = remedyDigestV1(a);
  const approvals = [...input.approvals].sort((x, y) => x.seat_index - y.seat_index).map((x) => remedyApprovalWire(x));
  const bitmap = approvals.reduce((mask, x) => mask | (1 << x.seat_index), 0);
  const expiresAt = a.expires_at.toString();
  const usableUntil = expiresAt;
  return newChainIntent({
    game_id: input.game_id,
    instance: input.instance,
    key: { op: "submit-remedy", decision, expires_at: expiresAt },
    subject: { kind: "remedy", protocol: JUNO_REMEDY_PROTOCOL_V1, decision, remedy_digest: remedyDigest },
    op: {
      kind: "remedy",
      chain_game_id: a.chain_game_id.toString(),
      remedy: a.remedy as 1 | 2 | 3 | 4 | 5,
      defaulting_seat: a.defaulting_seat,
      strike: a.strike,
      overdue_epoch: a.overdue_epoch.toString(),
      log_len: a.log_len.toString(),
      final_at: a.final_at.toString(),
      attested_at: a.attested_at.toString(),
      expires_at: expiresAt,
      usable_until: usableUntil,
      remedy_key_id: a.remedy_key_id,
      remedy_digest: remedyDigest,
      decision,
      approvals: bitmap,
    },
    msg_json: RELAYER_EXECUTE.submitRemedy(a.chain_game_id.toString(), remedyAttestationWire(a), input.signature, approvals),
    now: input.now,
  });
}

export type PrepareRemedyOutcome =
  | { readonly kind: "created"; readonly record: ChainIntentRecord }
  /** The same work already occupies the slot (an idempotent re-prepare: a restart, a retried request). */
  | { readonly kind: "exists"; readonly record: ChainIntentRecord }
  /** Refused before anything was written: a remedy already landed, an earlier one is still open, another build's
   *  intent files, or different work in this slot. */
  | { readonly kind: "hold"; readonly why: string }
  | { readonly kind: "failed"; readonly detail: string };

/** Writes `candidate` (a `remedyChainIntent`) once, behind the fence. Reads the game's intents first: a game whose
 *  intent files another build wrote (`newer` / `older-unread`) or that are damaged is never added to here. An earlier
 *  remedy intent refused for good (held, no live attempt) is superseded before the candidate is written. A created
 *  (or already present, still open) intent is handed to the relayer (`poke`), as every intent writer does. Callers
 *  serialize per game, and pass the latest block time they read from the chain (`chainTime`, seconds): without it a
 *  different decision never follows an earlier one that ended without effect. */
export async function prepareRemedyIntent(store: ChainIntentStore, candidate: ChainIntentRecord, options: { readonly poke?: (gameId: string, intentId: string) => void; readonly now?: number; readonly chainTime?: number } = {}): Promise<PrepareRemedyOutcome> {
  const outcome = await prepare(store, candidate, options.now ?? candidate.created_at, options.chainTime ?? null);
  if ((outcome.kind === "created" || outcome.kind === "exists") && outcome.record.status !== "confirmed" && outcome.record.status !== "superseded") options.poke?.(candidate.game_id, candidate.intent_id);
  return outcome;
}

async function prepare(store: ChainIntentStore, candidate: ChainIntentRecord, now: number, chainTime: number | null): Promise<PrepareRemedyOutcome> {
  if (candidate.op.kind !== "remedy") return { kind: "hold", why: "not a remedy intent" };
  if (store.formatOf !== undefined) {
    const format = await store.formatOf(candidate.game_id);
    if (format !== "current") return { kind: "hold", why: `the game's intent files are ${format}: this build does not add to them` };
  }
  let existing: ChainIntentRecord[];
  try {
    existing = await store.listGame(candidate.game_id);
  } catch (error) {
    if (error instanceof ChainIntentUnreadableError) return { kind: "hold", why: `the game's intent files are ${error.format}: this build does not add to them` };
    throw error;
  }
  const fence = remedyFence(existing, candidate, chainTime);
  if (fence.kind === "hold") return fence;
  if (fence.kind === "same") return { kind: "exists", record: existing.find((x) => x.intent_id === candidate.intent_id) as ChainIntentRecord };
  for (const earlier of fence.retire) {
    const put = await store.put(supersededIntent(earlier, "replaced by a later remedy intent (this one was refused for good)", now), earlier.record_version);
    if (put.kind !== "committed") return { kind: "hold", why: `an earlier remedy intent could not be retired now (${put.kind}); prepare again` };
  }
  const created = await store.create(candidate);
  if (created.kind === "created") return created;
  if (created.kind === "failed") return created;
  /* A racing writer made the slot between the read and the write: the same work is `exists`, other work is a hold. */
  return created.same ? { kind: "exists", record: created.record } : { kind: "hold", why: "a different attestation occupies this remedy slot" };
}
