// frontend/src/gameEngine/settlementPreview.ts
//
// ==================================================================
//  SET-0B: THE PAYOUT PREVIEW -- THE CONTRACT'S ARITHMETIC, IN BIGINT, LABELLED A PREVIEW
// ==================================================================
//
//   payout_i = floor(pool · w_i / Σ w)        dust = pool − Σ payout_i   (dust → treasury)
//
// A PREVIEW, NEVER THE AUTHORITY. The escrow contract computes the split from the signed `settlement_weights`; this
// shows a player the same figure beforehand, the way `utils/anteMath.ts` previews a deposit.
//
// NO PRODUCT CAP (ESCROW-2 amendment A2). Weights are unsigned u128 each with no product-level cap below u128; the
// contract computes Σw, pool·w_i and the division in a wider checked intermediate (Uint256). `bigint` has arbitrary
// precision, so this preview needs no intermediate bound at all and reproduces the wide-intermediate golden vectors
// P11-P13 exactly. The superseded rev-1 rule `pool · Σw ≤ 2^128 − 1` is NOT imposed.
//
// WHAT IS CHECKED is what the contract and the payload builder check (SET-0A §11, A2, A3):
//   * 2..7 weights (`BAD_SEAT_COUNT`);
//   * each weight and the pool are non-negative bigints encodable as u128 (`MALFORMED_AMOUNT`, `AMOUNT_OUT_OF_RANGE`);
//   * Σw > 0 (`SETTLEMENT_ZERO_SUM`) -- an all-zero vector is refused here and by the contract, never by the appraiser.
// And what must hold afterwards is asserted, not assumed: every payout ≤ pool, Σ payouts + dust = pool, 0 ≤ dust < n.

import {
  MAX_SETTLEMENT_SEATS,
  MIN_SETTLEMENT_SEATS,
  SettlementAppraisalError,
} from "./settlementAppraisal";

const ZERO = BigInt(0);
/** 2^128 − 1: the largest `Uint128` / u128 value. */
export const U128_MAX = BigInt("340282366920938463463374607431768211455");
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

export interface PayoutPreview {
  pool: bigint;
  weights: readonly bigint[];
  sum: bigint;
  /** Per seat, in the weights' (chain seat) order. */
  payouts: readonly bigint[];
  /** What the floors leave; the contract sends it to the treasury. */
  dust: bigint;
}

/** A refusal-safe rendering of any value (`JSON.stringify` throws on a bigint). */
function describe(value: unknown): string {
  if (typeof value === "bigint") return `${value.toString()}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function u128(value: unknown, where: string): bigint {
  if (typeof value !== "bigint") {
    throw new SettlementAppraisalError("MALFORMED_AMOUNT", `${where} is a ${typeof value}, not a bigint`);
  }
  if (value < ZERO || value > U128_MAX) {
    throw new SettlementAppraisalError("AMOUNT_OUT_OF_RANGE", `${where}=${value.toString()} is not a u128`);
  }
  return value;
}

/** The contract's payout split, previewed exactly. */
export function payoutPreview(pool: bigint, weights: readonly bigint[]): PayoutPreview {
  const poolValue = u128(pool, "pool");
  if (!Array.isArray(weights)) throw new SettlementAppraisalError("MALFORMED_STATE", "weights is not an array");
  const n = weights.length;
  if (n < MIN_SETTLEMENT_SEATS || n > MAX_SETTLEMENT_SEATS) {
    throw new SettlementAppraisalError("BAD_SEAT_COUNT", `n=${n}`);
  }
  /* AN INDEX LOOP, NOT map: `map` skips holes and would carry one through as a seat with no payout. */
  const checked: bigint[] = [];
  for (let index = 0; index < n; index += 1) {
    if (!(index in weights)) throw new SettlementAppraisalError("MALFORMED_AMOUNT", `weights[${index}] is missing`);
    checked.push(u128(weights[index], `weights[${index}]`));
  }
  const sum = checked.reduce((total, weight) => total + weight, ZERO);
  if (sum === ZERO) throw new SettlementAppraisalError("SETTLEMENT_ZERO_SUM", "sum of weights is zero");

  const payouts = checked.map((weight) => (poolValue * weight) / sum); // bigint division floors for non-negatives
  const paid = payouts.reduce((total, payout) => total + payout, ZERO);
  const dust = poolValue - paid;

  /* THE INVARIANTS THE CONTRACT RELIES ON, CHECKED. Each can only fail if the arithmetic above were wrong. */
  if (payouts.some((payout) => payout < ZERO || payout > poolValue) || dust < ZERO || dust >= BigInt(n)) {
    throw new Error(`payoutPreview invariant broken: pool ${poolValue.toString()} paid ${paid.toString()}`);
  }
  return Object.freeze({
    pool: poolValue,
    weights: Object.freeze(checked),
    sum,
    payouts: Object.freeze(payouts),
    dust,
  });
}

/** A canonical decimal string (the wire's money spelling) as a bigint; anything else is refused, never coerced. */
export function parseSettlementDecimal(value: unknown, where: string): bigint {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    throw new SettlementAppraisalError("MALFORMED_AMOUNT", `${where}=${describe(value)}`);
  }
  return BigInt(value);
}

/** `payoutPreview` over decimal strings, answered in decimal strings -- the cross-language vector format. */
export function payoutPreviewDecimal(
  pool: string,
  weights: readonly string[],
): { pool: string; weights: string[]; sum: string; payouts: string[]; dust: string } {
  if (!Array.isArray(weights)) throw new SettlementAppraisalError("MALFORMED_STATE", "weights is not an array");
  const parsed: bigint[] = [];
  for (let index = 0; index < weights.length; index += 1) {
    if (!(index in weights)) throw new SettlementAppraisalError("MALFORMED_AMOUNT", `weights[${index}] is missing`);
    parsed.push(parseSettlementDecimal(weights[index], `weights[${index}]`));
  }
  const preview = payoutPreview(parseSettlementDecimal(pool, "pool"), parsed);
  return {
    pool: preview.pool.toString(),
    weights: preview.weights.map((weight) => weight.toString()),
    sum: preview.sum.toString(),
    payouts: preview.payouts.map((payout) => payout.toString()),
    dust: preview.dust.toString(),
  };
}
