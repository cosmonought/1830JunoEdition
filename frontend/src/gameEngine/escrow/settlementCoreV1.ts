// frontend/src/gameEngine/escrow/settlementCoreV1.ts
//
// ==================================================================
//  GNOLAND-1: SettlementCoreV1 -- THE CHAIN-NEUTRAL SETTLEMENT MATERIAL, BUILT AROUND THE FROZEN SET-0C CODE
// ==================================================================
//
// WHAT IS CORE (identical on every backend, by construction -- the same functions run):
//   * the payload's fourteen fields, their meaning, and the 136 + 16·n big-endian layout (SET-0C encoder/decoder,
//     shape rules, wire JSON);
//   * seq = 2·log_len + kind, kind/reason coupling, A1, n ∈ 2..7, Σw > 0 (SET-0C `checkSettlementPayloadV1`);
//   * the ONE commitment: `appraisal_state_hash` and the base vector from the same canonical bytes (SET-0B
//     `commitAndAppraise` / `appraiseCommittedState`, including the historical `18JUNO/STATE/v1\n` tag, which is a
//     chain-neutral state commitment despite its name and is never renamed);
//   * the terminal weight policy (SET-0B `terminalSettlementWeights`) and the payout arithmetic (SET-0B
//     `payoutPreview`: floor(pool·w/Σw), dust stays in the pool), which is denomination-agnostic;
//   * seat order: chain seat order, never turn order; player_id ↔ chain_seat_index from ONE list.
//
// WHAT IS NOT CORE (the codec's, escrowCodec.ts): the address rule, the roster commitment, the domain, every digest
// tag, and which signature scheme signs what. The core never names a chain, an address format, a denomination, a
// contract, a realm, a curve or a signature encoding. `domain` is an opaque 32-byte value the codec vouches for.
//
// THE PROOF THAT NOTHING MOVED FOR JUNO. `buildSettlementCoreV1(JUNO_CODEC_V1, args)` is the same composition as
// SET-0C's certified `buildSettlementPayloadV1(args)`, step for step and refusal for refusal, with the two Juno
// calls (`settlementDomainV1`, `rosterHashV1`) reached through the codec. escrowJunoRegressionOracle.test.ts builds
// every SET-0C golden through both and requires byte identity, then compares both with the frozen vector files.
// `buildSettlementPayloadV1` stays exported and certified; nothing here edits it.

import type { GameStateResponse } from "../gameState";
import {
  SETTLEMENT_PAYLOAD_KIND,
  SETTLEMENT_PAYLOAD_REASON,
  SETTLEMENT_PAYLOAD_VERSION,
  SettlementPayloadError,
  U64_MAX,
  checkSettlementPayloadV1,
  decodeSettlementPayloadV1,
  encodeSettlementPayloadV1,
  bytesToHex,
  settlementPayloadToWire,
  type SettlementPayloadUse,
  type SettlementPayloadV1,
  type SettlementPayloadV1Wire,
} from "../settlementPayload";
import { MAX_SETTLEMENT_SEATS, MIN_SETTLEMENT_SEATS, type SeatAppraisal, type SettlementSeat } from "../settlementAppraisal";
import { appraiseCommittedState, commitAndAppraise } from "../settlementDigest";
import { SETTLEMENT_REASON_CODE, terminalSettlementWeights, type EscrowTerms, type TerminalOutcome } from "../settlementPolicy";
import { verifySettlementPayloadV1, type SettlementPayloadVerification } from "../settlementConformance";
import { payoutPreview, type PayoutPreview } from "../settlementPreview";
import type { CodecCommitment, CodecDigest, EscrowCodec, EscrowCodecId } from "./escrowCodec";

/* Re-exports: the core's vocabulary, from the certified modules, under one import. Nothing is moved or copied. */
export {
  SETTLEMENT_PAYLOAD_VERSION,
  SETTLEMENT_PAYLOAD_KIND,
  SETTLEMENT_PAYLOAD_REASON,
  SETTLEMENT_PAYLOAD_FIXED_LEN,
  SETTLEMENT_PAYLOAD_WEIGHT_LEN,
  SettlementPayloadError,
  checkSettlementPayloadShape,
  checkSettlementPayloadV1,
  decodeSettlementPayloadV1,
  encodeSettlementPayloadV1,
  encodeSettlementPayloadV1Hex,
  settlementPayloadFromWire,
  settlementPayloadToWire,
} from "../settlementPayload";
export type { SettlementPayloadUse, SettlementPayloadV1, SettlementPayloadV1Wire } from "../settlementPayload";
export { payoutPreview } from "../settlementPreview";
export type { PayoutPreview } from "../settlementPreview";

/* ------------------------------------------------------------------ */
/* Neutral inputs                                                     */
/* ------------------------------------------------------------------ */

/** One money seat, chain-neutral: the backend's seat address (exactly as the backend stores it) and the log's
 *  player id. No principal, no turn position. */
export interface CoreSeatBinding {
  chain_seat_index: number;
  player_id: string;
  payout_address: string;
}

/**
 * The policy's chain facts in BASE UNITS of the binding's asset (ujuno, ugnot, ...). SET-0B's `EscrowTerms` spells
 * the same two numbers `pool_net_ujuno` / `ante_net_ujuno`: historical names, chain-neutral meaning, not renamed
 * (renaming would touch certified files). No reason certified today reads them (Forfeit/Clemency are refused).
 */
export interface SettlementTermsV1 {
  pool_net: bigint;
  ante_net: bigint;
}

export type SettlementCoreIntent =
  | { kind: "Checkpoint" }
  | { kind: "Terminal"; outcome: TerminalOutcome; terms: SettlementTermsV1 };

export interface BuildSettlementCoreArgs {
  /** The sealed board at `appraisal_log_len` (exactly one of the two, as SET-0C). */
  board: { state: GameStateResponse } | { canonical_text: string };
  /** The frozen roster, chain seat order. */
  bindings: readonly CoreSeatBinding[];
  /** The game's domain as stored on chain (lowercase hex). */
  domain: string;
  /** The backend's domain inputs (the codec reads them once and must hash them to `domain`). */
  domain_inputs: unknown;
  intent: SettlementCoreIntent;
  log_len: bigint;
  log_hash: string;
  appraisal_log_len: bigint;
  state_schema_version: number;
  signer_key_id: number;
  issued_at: bigint;
}

/** A built payload, stamped with the codec whose domain it binds and whose SETTLE digest the signer will sign. */
export interface BuiltSettlementCoreV1 {
  codec: EscrowCodecId;
  payload: SettlementPayloadV1;
  wire: SettlementPayloadV1Wire;
  usage: SettlementPayloadUse;
  encoded_hex: string;
  settle: CodecDigest<"settle">;
  domain: CodecCommitment<"domain">;
  roster: CodecCommitment<"roster">;
  canonical_text: string;
  seats: readonly SettlementSeat[];
  base_vector: readonly bigint[];
  appraisals: readonly SeatAppraisal[];
}

/* ------------------------------------------------------------------ */
/* The builder                                                        */
/* ------------------------------------------------------------------ */

const refuse = (code: ConstructorParameters<typeof SettlementPayloadError>[0], detail: string): never => {
  throw new SettlementPayloadError(code, detail);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** SET-0C `settlementSeatMapping`, minus the Juno roster hash: seats and addresses from one list, in chain order.
 *  Same checks, same order, same codes; the address rule is the codec's. */
function coreSeatMapping(codec: EscrowCodec<unknown>, bindings: unknown): { seats: readonly SettlementSeat[]; addresses: readonly string[] } {
  if (!Array.isArray(bindings)) return refuse("MALFORMED_INPUT", "the seat bindings are not an array");
  const n = bindings.length;
  if (n < MIN_SETTLEMENT_SEATS || n > MAX_SETTLEMENT_SEATS) refuse("BAD_SEAT_COUNT", `n=${n}`);
  const seats: SettlementSeat[] = [];
  const addresses: string[] = [];
  for (let at = 0; at < n; at += 1) {
    const binding: unknown = bindings[at];
    if (!isRecord(binding)) return refuse("MALFORMED_INPUT", `bindings[${at}] is not a seat binding`);
    const index = binding.chain_seat_index;
    const player = binding.player_id;
    const address = binding.payout_address;
    if (index !== at) refuse("MALFORMED_INPUT", `position ${at} carries chain_seat_index ${describe(index)}`);
    if (typeof player !== "string" || player.length === 0) refuse("MALFORMED_INPUT", `bindings[${at}].player_id=${describe(player)}`);
    codec.canonicalAddress(address, `bindings[${at}].payout_address`);
    for (let before = 0; before < at; before += 1) {
      if (seats[before].player_id === player) refuse("MALFORMED_INPUT", `player ${player as string} holds two seats`);
      if (addresses[before] === address) refuse("MALFORMED_INPUT", `wallet ${address as string} holds two seats`);
    }
    seats.push(Object.freeze({ seat_index: at, player_id: player as string }));
    addresses.push(address as string);
  }
  return { seats: Object.freeze(seats), addresses: Object.freeze(addresses) };
}

/** A u64 carried as a bigint and only a bigint (SET-0C's rule and codes). */
function u64(value: unknown, where: string): bigint {
  if (typeof value !== "bigint") return refuse("MALFORMED_INTEGER", `${where}=${describe(value)} is a ${typeof value}; u64 fields take a bigint`);
  if (value < BigInt(0) || value > U64_MAX) return refuse("INTEGER_OUT_OF_RANGE", `${where}=${value.toString()} is not a u64`);
  return value;
}

/**
 * SET-0B's `EscrowTerms` view of neutral terms, read LAZILY: SET-0C's builder never reads the terms for a reason
 * that does not use them (none certified today does), so neither does this one -- a terms object is touched only if
 * and when the policy reads a field, exactly as before.
 */
const toEscrowTerms = (terms: SettlementTermsV1): EscrowTerms =>
  Object.freeze({
    get pool_net_ujuno(): bigint {
      return terms.pool_net;
    },
    get ante_net_ujuno(): bigint {
      return terms.ante_net;
    },
  });

/**
 * Builds, checks and encodes a SettlementCoreV1 payload for `codec`'s backend from ONE committed snapshot. Refuses
 * exactly what SET-0C's builder refuses, in its order: arguments → board shape → domain (codec) → seats and roster
 * (codec) → intent → the one commitment → rules-engine pin → policy → log_len/seq → the payload rules.
 */
export function buildSettlementCoreV1<I>(codec: EscrowCodec<I>, args: BuildSettlementCoreArgs): BuiltSettlementCoreV1 {
  if (!isRecord(args)) return refuse("MALFORMED_INPUT", "the build arguments are not an object");
  /* EVERY ARGUMENT READ ONCE (SET-0C discipline). */
  const board: unknown = args.board;
  const bindings: unknown = args.bindings;
  const domain: unknown = args.domain;
  const domainInputsRaw: unknown = args.domain_inputs;
  const intent: unknown = args.intent;
  const logLenRaw: unknown = args.log_len;
  const logHash: unknown = args.log_hash;
  const appraisalLogLen: unknown = args.appraisal_log_len;
  const stateSchemaVersion: unknown = args.state_schema_version;
  const signerKeyId: unknown = args.signer_key_id;
  const issuedAt: unknown = args.issued_at;
  if (!isRecord(board)) return refuse("MALFORMED_INPUT", "board is not { state } or { canonical_text }");
  const hasState = Object.prototype.hasOwnProperty.call(board, "state");
  const hasText = Object.prototype.hasOwnProperty.call(board, "canonical_text");
  if (hasState === hasText) return refuse("MALFORMED_INPUT", "board must carry exactly one of state / canonical_text");

  /* THE CHAIN SIDE, THROUGH THE CODEC, PROVEN FIRST. */
  const bound = codec.bindDomain(domainInputsRaw);
  if (bound.domain.codec !== codec.id) refuse("DOMAIN_MISMATCH", "the codec returned another codec's domain");
  if (bound.domain.hex !== domain) refuse("DOMAIN_MISMATCH", `domain ${describe(domain)} is not the inputs' ${bound.domain.hex}`);
  const mapping = coreSeatMapping(codec as EscrowCodec<unknown>, bindings);
  const roster = codec.rosterHash(mapping.addresses);
  if (roster.hex !== bound.roster_hash) {
    refuse("ROSTER_MISMATCH", `the bindings' wallets hash to ${roster.hex}, the domain's roster is ${bound.roster_hash}`);
  }

  /* THE INTENT, READ ONCE. */
  if (!isRecord(intent)) return refuse("MALFORMED_INPUT", "intent is not an object");
  const intentKind: unknown = intent.kind;
  let outcome: TerminalOutcome | null = null;
  let terms: EscrowTerms | null = null;
  if (intentKind === "Terminal") {
    const outcomeRaw: unknown = intent.outcome;
    const termsRaw: unknown = intent.terms;
    terms = toEscrowTerms(termsRaw as SettlementTermsV1); // lazy: nothing is read from the terms here
    if (!isRecord(outcomeRaw)) return refuse("MALFORMED_INPUT", "intent.outcome is not an object");
    const reasonName: unknown = outcomeRaw.reason;
    if (typeof reasonName !== "string" || !Object.prototype.hasOwnProperty.call(SETTLEMENT_REASON_CODE, reasonName)) {
      return refuse("MALFORMED_INPUT", `intent.outcome.reason=${describe(reasonName)} is not a terminal reason`);
    }
    outcome =
      reasonName === "Forfeit" || reasonName === "Clemency"
        ? { reason: reasonName, offender_seat: outcomeRaw.offender_seat as number }
        : ({ reason: reasonName } as TerminalOutcome);
  } else if (intentKind !== "Checkpoint") {
    return refuse("MALFORMED_INPUT", `intent.kind=${describe(intentKind)}`);
  }

  /* THE ONE COMMITMENT (SET-0B). */
  let committed: { canonical_text: string; appraisal_state_hash: string; vector: readonly bigint[]; appraisals: readonly SeatAppraisal[]; state: GameStateResponse };
  if (hasState) {
    committed = commitAndAppraise(board.state as GameStateResponse, mapping.seats);
  } else {
    const text = board.canonical_text as string;
    committed = { ...appraiseCommittedState(text, mapping.seats), canonical_text: text };
  }
  const pin = (committed.state as unknown as { rules_engine_version?: unknown }).rules_engine_version;
  if (bound.rules_engine_version !== pin) {
    refuse(
      "RULES_ENGINE_VERSION_MISMATCH",
      `the domain declares rules engine ${describe(bound.rules_engine_version)}, the board is pinned to ${describe(pin)}`,
    );
  }

  let kind: number;
  let reason: number;
  let weights: readonly bigint[];
  let usage: SettlementPayloadUse;
  if (outcome === null) {
    kind = SETTLEMENT_PAYLOAD_KIND.Checkpoint;
    reason = SETTLEMENT_PAYLOAD_REASON.RoundBoundary;
    weights = committed.vector;
    usage = "Checkpoint";
  } else {
    weights = terminalSettlementWeights(committed.vector, outcome, terms as EscrowTerms);
    kind = SETTLEMENT_PAYLOAD_KIND.Terminal;
    reason = SETTLEMENT_REASON_CODE[outcome.reason];
    usage = outcome.reason === "ResolverCorrection" ? "ResolverReplace" : "Settle";
  }

  const logLen = u64(logLenRaw, "log_len");
  const seq = BigInt(2) * logLen + BigInt(kind);
  if (seq > U64_MAX) refuse("BAD_SEQ", `2·log_len + kind = ${seq.toString()} is not a u64`);

  /* THE PAYLOAD, CHECKED AND ENCODED BY THE CERTIFIED FUNCTIONS; the returned payload is the decoder's frozen
     snapshot of the exact bytes, so nothing downstream can see a value the bytes do not carry. */
  const candidate = {
    version: SETTLEMENT_PAYLOAD_VERSION,
    domain,
    seq,
    kind,
    reason,
    log_len: logLen,
    log_hash: logHash,
    appraisal_log_len: appraisalLogLen,
    appraisal_state_hash: committed.appraisal_state_hash,
    state_schema_version: stateSchemaVersion,
    seat_count: weights.length,
    settlement_weights: weights.slice(),
    signer_key_id: signerKeyId,
    issued_at: issuedAt,
  } as unknown as SettlementPayloadV1;
  checkSettlementPayloadV1(candidate, usage);
  const encoded = encodeSettlementPayloadV1(candidate);
  const payload = decodeSettlementPayloadV1(encoded);
  const encodedHex = bytesToHex(encoded);
  return Object.freeze({
    codec: codec.id,
    payload,
    wire: Object.freeze(settlementPayloadToWire(payload)),
    usage,
    encoded_hex: encodedHex,
    settle: codec.settleDigest(encodedHex),
    domain: bound.domain,
    roster,
    canonical_text: committed.canonical_text,
    seats: mapping.seats,
    base_vector: committed.vector,
    appraisals: committed.appraisals,
  });
}

/**
 * SET-0C's verifier (payload vs the committed board), with the SETTLE digest taken by `codec`. One snapshot of the
 * payload feeds both, so the rule check, the comparison and the digest see the same bytes.
 */
export function verifySettlementCoreV1<I>(
  codec: EscrowCodec<I>,
  payload: SettlementPayloadV1,
  canonicalText: string,
  seats: readonly SettlementSeat[],
  terms: SettlementTermsV1 = { pool_net: BigInt(0), ante_net: BigInt(0) },
  expectedUsage?: SettlementPayloadUse,
): Omit<SettlementPayloadVerification, "settle_digest"> & { settle: CodecDigest<"settle"> } {
  const encoded = encodeSettlementPayloadV1(payload);
  const snap = decodeSettlementPayloadV1(encoded);
  const verified = verifySettlementPayloadV1(snap, canonicalText, seats, toEscrowTerms(terms), expectedUsage);
  return Object.freeze({
    usage: verified.usage,
    appraisal_state_hash: verified.appraisal_state_hash,
    base_vector: verified.base_vector,
    settlement_weights: verified.settlement_weights,
    settle: codec.settleDigest(bytesToHex(encoded)),
  });
}

/** Proportional payout in base units (SET-0B): chain-neutral, denomination-agnostic. */
export function settlementPayouts(pool: bigint, weights: readonly bigint[]): PayoutPreview {
  return payoutPreview(pool, weights);
}
