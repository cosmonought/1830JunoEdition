// frontend/src/gameEngine/settlementConformance.ts
//
// ==================================================================
//  SET-0C: CHECKING A PAYLOAD AGAINST THE BOARD IT CLAIMS TO APPRAISE
// ==================================================================
//
// `buildSettlementPayloadV1` (settlementPayload.ts) is how a payload is MADE. This is how one is CHECKED by anybody
// holding the committed board text -- a client verifying a server checkpoint, a resolver checking a disputed
// terminal, a test. It re-derives everything the payload claims from the committed bytes, through the same SET-0B
// primitives, and refuses the first disagreement:
//
//   * the payload passes every game-independent contract rule for its kind/reason (`checkSettlementPayloadV1`);
//   * `appraisal_state_hash` is `terminal_state_hash_v1` of exactly the text supplied (hash of the bytes appraised);
//   * `settlement_weights` is what the policy makes of the appraisal of that text, seat for seat, in chain seat order.
//
// It says nothing about the chain-side facts (domain equality, the roster, `seq > trusted_seq`, the signer key) or
// about whether the text really is `replay(log)[appraisal_log_len]` -- those need the chain and the log.

import type { SettlementSeat } from "./settlementAppraisal";
import { appraiseCommittedState } from "./settlementDigest";
import { terminalSettlementWeights, type EscrowTerms, type TerminalOutcome } from "./settlementPolicy";
import {
  SETTLEMENT_PAYLOAD_KIND,
  SETTLEMENT_PAYLOAD_REASON,
  SettlementPayloadError,
  checkSettlementPayloadV1,
  decodeSettlementPayloadV1,
  encodeSettlementPayloadV1,
  settleDigestV1,
  type SettlementPayloadUse,
  type SettlementPayloadV1,
} from "./settlementPayload";

/** What a successful verification established. */
export interface SettlementPayloadVerification {
  usage: SettlementPayloadUse;
  appraisal_state_hash: string;
  base_vector: readonly bigint[];
  settlement_weights: readonly bigint[];
  settle_digest: string;
}

const TERMINAL_NAMES: Readonly<Record<number, TerminalOutcome["reason"]>> = Object.freeze({
  [SETTLEMENT_PAYLOAD_REASON.BankBroken]: "BankBroken",
  [SETTLEMENT_PAYLOAD_REASON.Bankruptcy]: "Bankruptcy",
  [SETTLEMENT_PAYLOAD_REASON.Forfeit]: "Forfeit",
  [SETTLEMENT_PAYLOAD_REASON.Clemency]: "Clemency",
  [SETTLEMENT_PAYLOAD_REASON.ResolverCorrection]: "ResolverCorrection",
});

const mismatch = (detail: string): never => {
  throw new SettlementPayloadError("PAYLOAD_APPRAISAL_MISMATCH", detail);
};

/**
 * Verifies `payload` against `canonicalText` (the committed board at `appraisal_log_len`) and the chain-order
 * `seats`. `terms` is the policy's chain facts (unused by every reason supported today). Throws the first refusal:
 * a `SettlementPayloadError` (wire rule or `PAYLOAD_APPRAISAL_MISMATCH`) or a `SettlementAppraisalError` (the text
 * or the seats are refused, or the reason's policy is not supported yet).
 */
export function verifySettlementPayloadV1(
  payload: SettlementPayloadV1,
  canonicalText: string,
  seats: readonly SettlementSeat[],
  terms: EscrowTerms = { pool_net_ujuno: BigInt(0), ante_net_ujuno: BigInt(0) },
  /** The message the caller is checking for (e.g. "Checkpoint" when verifying a posted checkpoint). Without it the
   *  usage is read from the payload's own kind/reason and returned for the caller to compare. */
  expectedUsage?: SettlementPayloadUse,
): SettlementPayloadVerification {
  /* ONE READ OF THE PAYLOAD: encoded (every field read once and range-checked) and decoded into a frozen plain
     object, so the rule check and the comparisons below see the same values whatever the caller's object does. */
  const snap = decodeSettlementPayloadV1(encodeSettlementPayloadV1(payload));
  const usage: SettlementPayloadUse =
    snap.kind === SETTLEMENT_PAYLOAD_KIND.Checkpoint
      ? "Checkpoint"
      : snap.reason === SETTLEMENT_PAYLOAD_REASON.ResolverCorrection
        ? "ResolverReplace"
        : "Settle";
  // With an expected message, its kind/reason rules are the ones applied (WRONG_KIND / REASON_NOT_ALLOWED otherwise).
  checkSettlementPayloadV1(snap, expectedUsage === undefined ? usage : expectedUsage);
  const reason = snap.reason;
  const claimedHash = snap.appraisal_state_hash;
  const claimedWeights = snap.settlement_weights;

  const committed = appraiseCommittedState(canonicalText, seats);
  if (committed.appraisal_state_hash !== claimedHash) {
    mismatch(`appraisal_state_hash ${claimedHash} is not the committed text's ${committed.appraisal_state_hash}`);
  }
  const weights =
    usage === "Checkpoint"
      ? committed.vector
      : terminalSettlementWeights(committed.vector, { reason: TERMINAL_NAMES[reason] } as TerminalOutcome, terms);
  if (weights.length !== claimedWeights.length) {
    mismatch(`${claimedWeights.length} settlement weights for ${weights.length} seats`);
  }
  for (let at = 0; at < weights.length; at += 1) {
    if (weights[at] !== claimedWeights[at]) {
      mismatch(`settlement_weights[${at}] is ${claimedWeights[at].toString()}, the appraisal gives ${weights[at].toString()}`);
    }
  }
  return Object.freeze({
    usage,
    appraisal_state_hash: committed.appraisal_state_hash,
    base_vector: committed.vector,
    settlement_weights: Object.freeze(weights.slice()),
    settle_digest: settleDigestV1(snap),
  });
}
