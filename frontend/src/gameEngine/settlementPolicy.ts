// frontend/src/gameEngine/settlementPolicy.ts
//
// ==================================================================
//  SET-0B: THE TERMINAL POLICY LAYER -- BASE VECTOR IN, SETTLEMENT WEIGHTS OUT
// ==================================================================
//
// THE SPLIT (SET-0A §9). The base vector is a pure function of the hashed board (`settlementAppraisal.ts`), so any
// client or resolver can check "vector = appraisal(state)". A terminal POLICY needs things that are not on the board
// -- the offender (a log fact), the pool and net ante (chain facts), and for Forfeit/Clemency a different board (the
// last completed round boundary, DECISIONS A8) -- so it lives here, on top of the base, and never inside it. Its
// output is `SettlementPayloadV1.settlement_weights` (ESCROW-2 amendment A2).
//
// WHAT IS SUPPORTED NOW. BankBroken, Bankruptcy and ResolverCorrection return the base unchanged:
//   * Bankruptcy is the base by owner decision OD-SET-1 (a): the rulebook's bankrupt wealth (the shares he could not
//     sell), which the appraiser already computes; no penalty is added.
//   * ResolverCorrection is a resolver-authored vector from a corrected board; the policy adds nothing.
//
// FORFEIT AND CLEMENCY ARE REFUSED (`REASON_NOT_SUPPORTED`). Their mathematics is specified (SET-0A §9: forfeit
// w_o = 0; clemency w_o = A·S, w_i = nw_i·(P − A), exact in the contract's floor), but detection, the round-boundary
// board and the server policy belong to ESCROW-3c. A half-wired policy would produce weights for a game nothing yet
// knows how to end that way, so this pass does not ship one. The types already carry what 3c needs
// (`offender_seat`, `EscrowTerms`) so it can be added without touching the appraiser.

import { SettlementAppraisalError } from "./settlementAppraisal";

/** The terminal reasons of ESCROW-1.5 §5.3 and their payload byte (1..5). `0` is `RoundBoundary`, a checkpoint. */
export const SETTLEMENT_REASON_CODE = Object.freeze({
  BankBroken: 1,
  Bankruptcy: 2,
  Forfeit: 3,
  Clemency: 4,
  ResolverCorrection: 5,
} as const);

export type TerminalReason = keyof typeof SETTLEMENT_REASON_CODE;

/** How a game ended, as the policy needs it. */
export type TerminalOutcome =
  | { reason: "BankBroken" | "Bankruptcy" | "ResolverCorrection" }
  | { reason: "Forfeit" | "Clemency"; offender_seat: number };

/** Chain facts frozen at START: the pool and one seat's net ante, in ujuno. */
export interface EscrowTerms {
  pool_net_ujuno: bigint;
  ante_net_ujuno: bigint;
}

const ZERO = BigInt(0);

/**
 * The settlement weights for a terminal payload. For every reason supported in SET-0B the result is the base vector,
 * unchanged (a fresh frozen copy). Forfeit and Clemency throw `REASON_NOT_SUPPORTED` until ESCROW-3c.
 *
 * `base` must be the output of `baseNetWorthVector` (non-negative bigints, one per seat); it is validated here too,
 * because a weight vector that is not a vector of non-negative integers cannot be settled.
 */
export function terminalSettlementWeights(
  base: readonly bigint[],
  outcome: TerminalOutcome,
  terms: EscrowTerms,
): readonly bigint[] {
  void terms; // Unused by every supported reason; Clemency (3c) needs pool and net ante.
  const reason = (outcome as { reason?: unknown } | null)?.reason;
  switch (reason) {
    case "BankBroken":
    case "Bankruptcy":
    case "ResolverCorrection":
      break;
    case "Forfeit":
    case "Clemency":
      throw new SettlementAppraisalError(
        "REASON_NOT_SUPPORTED",
        `${reason}: forfeit/clemency weights arrive with ESCROW-3c (SET-0A §9); SET-0B settles BankBroken, Bankruptcy and ResolverCorrection only`,
      );
    default:
      throw new SettlementAppraisalError("REASON_NOT_SUPPORTED", `unknown terminal reason ${String(reason)}`);
  }
  if (!Array.isArray(base)) throw new SettlementAppraisalError("MALFORMED_STATE", "the base vector is not an array");
  /* AN INDEX LOOP, NOT forEach/map: those skip holes, and a hole in a weight vector is a seat with no weight. */
  const out: bigint[] = [];
  for (let index = 0; index < base.length; index += 1) {
    if (!(index in base)) throw new SettlementAppraisalError("MALFORMED_AMOUNT", `base[${index}] is missing`);
    const weight: unknown = base[index];
    if (typeof weight !== "bigint") {
      throw new SettlementAppraisalError("MALFORMED_AMOUNT", `base[${index}] is a ${typeof weight}, not a bigint`);
    }
    if (weight < ZERO) throw new SettlementAppraisalError("MALFORMED_AMOUNT", `base[${index}]=${weight.toString()} is negative`);
    out.push(weight);
  }
  return Object.freeze(out);
}
