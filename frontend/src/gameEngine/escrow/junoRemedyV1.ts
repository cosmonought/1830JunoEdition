// frontend/src/gameEngine/escrow/junoRemedyV1.ts
//
// ==================================================================
//  PHASE 3 ESCROW 2.1 (FINANCIAL PROTOCOL 4): THE JUNO REMEDY ATTESTATION -- WHAT THE DEDICATED REMEDY KEY SIGNS
// ==================================================================
//
// Owner decision R1 (2026-10-06): an off-chain timing fact (a seat OVERDUE on the Live action clock or a Timed Async
// pace, the 30:00 finality, a third strike, a completed N-1 consensus) reaches escrow 2.1.0 only as an attestation of
// the DEDICATED REMEDY KEY -- a key class of its own, never the settlement signer, the join-admission key or the
// relayer -- plus, where the policy requires it, one REMEDY-APPROVE signature per non-defaulting seat:
//
//   remedy  = SHA-256("18JUNO/REMEDY/v1" ‖ encode)
//   encode  = u8(1) ‖ domain(32) ‖ u64(chain_game_id) ‖ u8(remedy) ‖ u8(defaulting_seat) ‖ u8(strike)
//             ‖ u64(overdue_epoch) ‖ u64(log_len) ‖ log_hash(32) ‖ u64(allowance_secs) ‖ u64(overdue_at)
//             ‖ u64(final_at) ‖ u64(attested_at) ‖ u64(expires_at) ‖ evidence_hash(32) ‖ u16(remedy_key_id)
//                                                                                                   (166 bytes)
//   approve = SHA-256("18JUNO/REMEDY-APPROVE/v1" ‖ domain(32) ‖ u64(chain_game_id) ‖ u8(remedy) ‖ u8(defaulting_seat)
//             ‖ u8(strike) ‖ u64(overdue_epoch) ‖ u64(log_len) ‖ log_hash(32) ‖ u64(overdue_at) ‖ u8(approving_seat))
//
// An approval binds ONE overdue instance (its strike, epoch, exact log position and overdue moment -- each must equal
// the attestation's), never finality or expiry: a cured overdue's approvals are dead for any later attestation, and a
// final decision that did not land in time is attested again (a fresh `attested_at`, at most one hour of bearer life)
// with the same approvals.
//
// Every integer fixed-width big-endian, no JSON anywhere. This is the ONLY TypeScript spelling of those bytes. Three
// independent implementations agree on them: this file, the contract (`contracts/escrow/src/remedy.rs`,
// `crypto::remedy_digest` / `remedy_approve_digest`), and the Python generator of the frozen vectors
// (`contracts/escrow/testdata/gen_remedy_vectors.py` -> `remedy_vectors_v1.json`), pinned by
// `frontend/src/utils/escrowRemedyVectors.test.ts`. It is NOT a settlement byte: SET-0C / `18JUNO/v1` are untouched;
// the remedy protocol is versioned on its own (`JUNO_REMEDY_PROTOCOL_V1`).
//
// What is NOT here (the server clock / system-pause lane, not complete in this pass): deciding that a remedy is final
// (the 20/30 race, the strike count, the N-1 vote, voluntary and system pauses, outage continuity) and the KMS remedy
// signer. This module only spells the bytes, validates their shape and builds the wire message.

import { sha256HexOfBytes, utf8Bytes } from "../sha256";

export const JUNO_REMEDY_PROTOCOL_V1 = "18JUNO/REMEDY/v1";
export const JUNO_REMEDY_TAG_V1 = "18JUNO/REMEDY/v1";
export const JUNO_REMEDY_APPROVE_TAG_V1 = "18JUNO/REMEDY-APPROVE/v1";
/** The decision identity (server-side only, never signed or sent): the attestation without its expiry and key id, so
 *  a renewed or re-keyed attestation of the SAME decision is recognised as the same work. */
export const JUNO_REMEDY_DECISION_TAG_V1 = "18COSMOS/REMEDY-DECISION/v1";
export const REMEDY_ENCODED_LEN = 166;

/** Escrow 2.1.0 policy constants (`contracts/escrow/src/state.rs`). */
export const LIVE_ACTION_SECS = 20 * 60;
export const LIVE_CURE_WINDOW_SECS = 10 * 60;
export const ASYNC_PACES_SECS: readonly number[] = Object.freeze([43_200, 86_400, 172_800, 259_200, 604_800]);
export const REVIEW_DELAY_SECS = 7 * 24 * 60 * 60;
/** An attestation's bearer life: `expires_at` at most this long after its `attested_at` (contract `state.rs`). */
export const MAX_REMEDY_TTL_SECS = 60 * 60;

/** The `remedy` byte. */
export const REMEDY_KIND = Object.freeze({
  LIVE_TIMEOUT_ANNUL: 1,
  LIVE_FORECLOSE: 2,
  LIVE_STRIKE3_FORECLOSE: 3,
  ASYNC_ANNUL: 4,
  ASYNC_FORECLOSE: 5,
} as const);
export type RemedyKindByte = (typeof REMEDY_KIND)[keyof typeof REMEDY_KIND];

/** Whether a remedy takes the defaulting seat's deposit (refused by the contract while it is paused). */
export const remedyForecloses = (kind: RemedyKindByte): boolean => kind === 2 || kind === 3 || kind === 5;
/** Whether a remedy needs one REMEDY-APPROVE signature from every non-defaulting seat. */
export const remedyNeedsApprovals = (kind: RemedyKindByte): boolean => kind === 2 || kind === 4 || kind === 5;
/** The mode a remedy belongs to (0 live, 1 async). */
export const remedyMode = (kind: RemedyKindByte): 0 | 1 => (kind <= 3 ? 0 : 1);

/** The attestation's fields, exactly as the contract re-encodes them. Hex is lowercase; u64s are bigints. */
export interface RemedyAttestationV1 {
  readonly version: 1;
  readonly domain: string;
  readonly chain_game_id: bigint;
  readonly remedy: RemedyKindByte;
  readonly defaulting_seat: number;
  readonly strike: number;
  readonly overdue_epoch: bigint;
  readonly log_len: bigint;
  readonly log_hash: string;
  readonly allowance_secs: bigint;
  readonly overdue_at: bigint;
  readonly final_at: bigint;
  /** When the REMEDY key signed: `final_at ≤ attested_at ≤` block time at execution. */
  readonly attested_at: bigint;
  readonly expires_at: bigint;
  readonly evidence_hash: string;
  readonly remedy_key_id: number;
}

export class RemedyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemedyInputError";
  }
}

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const HEX32 = /^[0-9a-f]{64}$/;

function u8(value: unknown, where: string): Uint8Array {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xff) throw new RemedyInputError(`${where} must be a u8`);
  return Uint8Array.of(value);
}

function u16(value: unknown, where: string): Uint8Array {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff) throw new RemedyInputError(`${where} must be a u16`);
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

function u64(value: unknown, where: string): Uint8Array {
  if (typeof value !== "bigint" || value < BigInt(0) || value > U64_MAX) throw new RemedyInputError(`${where} must be a u64 bigint`);
  const out = new Uint8Array(8);
  let rest = value;
  for (let at = 7; at >= 0; at -= 1) {
    out[at] = Number(rest & BigInt(0xff));
    rest >>= BigInt(8);
  }
  return out;
}

function hex32(value: unknown, where: string): Uint8Array {
  if (typeof value !== "string" || !HEX32.test(value)) throw new RemedyInputError(`${where} must be 32 bytes of lowercase hex`);
  const out = new Uint8Array(32);
  for (let at = 0; at < 32; at += 1) out[at] = parseInt(value.slice(at * 2, at * 2 + 2), 16);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The canonical 166-byte encoding (the contract's `RemedyAttestation::encode`). Throws on any out-of-range field. */
export function encodeRemedyAttestationV1(a: RemedyAttestationV1): Uint8Array {
  if (a.version !== 1) throw new RemedyInputError("version must be 1");
  const out = concat([
    u8(a.version, "version"),
    hex32(a.domain, "domain"),
    u64(a.chain_game_id, "chain_game_id"),
    u8(a.remedy, "remedy"),
    u8(a.defaulting_seat, "defaulting_seat"),
    u8(a.strike, "strike"),
    u64(a.overdue_epoch, "overdue_epoch"),
    u64(a.log_len, "log_len"),
    hex32(a.log_hash, "log_hash"),
    u64(a.allowance_secs, "allowance_secs"),
    u64(a.overdue_at, "overdue_at"),
    u64(a.final_at, "final_at"),
    u64(a.attested_at, "attested_at"),
    u64(a.expires_at, "expires_at"),
    hex32(a.evidence_hash, "evidence_hash"),
    u16(a.remedy_key_id, "remedy_key_id"),
  ]);
  if (out.length !== REMEDY_ENCODED_LEN) throw new RemedyInputError("encoded attestation length");
  return out;
}

/** `tag ‖ encode`: the exact bytes the REMEDY digest is taken over. */
export function remedyPreimageV1(a: RemedyAttestationV1): Uint8Array {
  return concat([utf8Bytes(JUNO_REMEDY_TAG_V1), encodeRemedyAttestationV1(a)]);
}

/** The 32-byte digest the remedy key signs (lowercase hex). */
export function remedyDigestV1(a: RemedyAttestationV1): string {
  return sha256HexOfBytes(remedyPreimageV1(a));
}

/** What a REMEDY-APPROVE binds: the game, the remedy and its defaulting seat, and ONE overdue instance. */
export type RemedyApproveFields = Pick<RemedyAttestationV1, "domain" | "chain_game_id" | "remedy" | "defaulting_seat" | "strike" | "overdue_epoch" | "log_len" | "log_hash" | "overdue_at">;

/** The exact bytes seat `approvingSeat`'s REMEDY-APPROVE digest is taken over. */
export function remedyApprovePreimageV1(a: RemedyApproveFields, approvingSeat: number): Uint8Array {
  return concat([
    utf8Bytes(JUNO_REMEDY_APPROVE_TAG_V1),
    hex32(a.domain, "domain"),
    u64(a.chain_game_id, "chain_game_id"),
    u8(a.remedy, "remedy"),
    u8(a.defaulting_seat, "defaulting_seat"),
    u8(a.strike, "strike"),
    u64(a.overdue_epoch, "overdue_epoch"),
    u64(a.log_len, "log_len"),
    hex32(a.log_hash, "log_hash"),
    u64(a.overdue_at, "overdue_at"),
    u8(approvingSeat, "approving_seat"),
  ]);
}

/** The 32-byte digest a non-defaulting seat's consent key signs to approve the remedy (lowercase hex). A client
 *  builds it from facts it checked itself (never a digest the server hands it): the consent key also signs CONSENT
 *  and ANNUL. */
export function remedyApproveDigestV1(a: RemedyApproveFields, approvingSeat: number): string {
  return sha256HexOfBytes(remedyApprovePreimageV1(a, approvingSeat));
}

/** The DECISION identity: SHA-256 over a distinct tag and the encoding with `attested_at`, `expires_at` and
 *  `remedy_key_id` zeroed. Never signed and never sent: the relayer's fence and its renewal rule use it (a fresh
 *  attestation of the same final decision is the same decision). */
export function remedyDecisionDigestV1(a: RemedyAttestationV1): string {
  return sha256HexOfBytes(concat([utf8Bytes(JUNO_REMEDY_DECISION_TAG_V1), encodeRemedyAttestationV1({ ...a, attested_at: BigInt(0), expires_at: BigInt(0), remedy_key_id: 0 })]));
}

/** The attestation as the contract's JSON (`RemedyAttestationV1` in msg.rs): u64s as decimal strings. */
export function remedyAttestationWire(a: RemedyAttestationV1): Record<string, string | number> {
  encodeRemedyAttestationV1(a); // validates every field
  return {
    version: a.version,
    domain: a.domain,
    chain_game_id: a.chain_game_id.toString(),
    remedy: a.remedy,
    defaulting_seat: a.defaulting_seat,
    strike: a.strike,
    overdue_epoch: a.overdue_epoch.toString(),
    log_len: a.log_len.toString(),
    log_hash: a.log_hash,
    allowance_secs: a.allowance_secs.toString(),
    overdue_at: a.overdue_at.toString(),
    final_at: a.final_at.toString(),
    attested_at: a.attested_at.toString(),
    expires_at: a.expires_at.toString(),
    evidence_hash: a.evidence_hash,
    remedy_key_id: a.remedy_key_id,
  };
}

/** The contract's shape rules that need no chain read (a relayer refuses to prepare anything the contract would
 *  refuse on shape alone): the kind, the strike, the 20/30 Live relations (final at least the cure window after the
 *  overdue -- later by a pause-frozen cure window, never sooner), an Async final at or after the overdue, an attestation
 *  time at or after finality, an expiry after it and at most `MAX_REMEDY_TTL_SECS` after it. Returns the first problem,
 *  or null. (The rule that the overdue lies at least one allowance after the game's start needs the chain: the contract
 *  enforces it.) */
export function remedyShapeProblem(a: RemedyAttestationV1): string | null {
  const kind = a.remedy as number;
  if (![1, 2, 3, 4, 5].includes(kind)) return `remedy ${kind} is unknown`;
  const strikeOk = kind === 1 || kind === 2 ? a.strike === 1 || a.strike === 2 : kind === 3 ? a.strike === 3 : a.strike === 0;
  if (!strikeOk) return `strike ${a.strike} is not valid for remedy ${kind}`;
  if (kind <= 3 && a.allowance_secs !== BigInt(LIVE_ACTION_SECS)) return "a Live remedy names the 20-minute action allowance";
  if (kind >= 4 && !ASYNC_PACES_SECS.map(BigInt).includes(a.allowance_secs)) return "an Async remedy names one of the listed paces";
  if ((kind === 1 || kind === 2) && a.final_at < a.overdue_at + BigInt(LIVE_CURE_WINDOW_SECS)) return "a first/second-strike Live remedy is final no sooner than 10 minutes after the overdue";
  if (kind === 3 && a.final_at !== a.overdue_at) return "a third strike is final at the overdue itself";
  if (kind >= 4 && a.final_at < a.overdue_at) return "an Async remedy cannot be final before the overdue";
  if (a.attested_at < a.final_at) return "attested_at precedes final_at";
  if (a.expires_at <= a.attested_at) return "expires_at must lie after attested_at";
  if (a.expires_at > a.attested_at + BigInt(MAX_REMEDY_TTL_SECS)) return "expires_at lies more than the remedy TTL after attested_at";
  return null;
}
