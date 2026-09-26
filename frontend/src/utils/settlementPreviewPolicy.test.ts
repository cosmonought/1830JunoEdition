/** @jest-environment node */
// frontend/src/utils/settlementPreviewPolicy.test.ts
//
// ==================================================================
//  SET-0B: THE PAYOUT PREVIEW (P1-P13) AND THE TERMINAL POLICY LAYER
// ==================================================================
//
// The preview is the contract's split in bigint: floor(pool · w_i / Σw), dust to the treasury. SET-0A rev 2 / ESCROW-2
// A2 removed the rev-1 product cap, so P11-P13 -- whose Σw and/or pool · w_i exceed u128 -- must settle exactly. The
// policy layer returns the base unchanged for BankBroken / Bankruptcy / ResolverCorrection and refuses Forfeit and
// Clemency until ESCROW-3c.

import { readFileSync } from "fs";
import { join } from "path";

import {
  U128_MAX,
  parseSettlementDecimal,
  payoutPreview,
  payoutPreviewDecimal,
} from "../gameEngine/settlementPreview";
import {
  SETTLEMENT_REASON_CODE,
  terminalSettlementWeights,
  type TerminalOutcome,
} from "../gameEngine/settlementPolicy";
import { SettlementAppraisalError } from "../gameEngine/settlementAppraisal";

interface PayoutVector {
  name: string;
  pool_ujuno: string;
  weights: string[];
  payouts_ujuno?: string[];
  dust_ujuno?: string;
  error?: string;
  requires_wide_intermediate?: boolean;
  policy?: { reason: "Forfeit" | "Clemency"; offender_seat: number; base_vector: string[]; ante_net_ujuno: string };
}

const golden = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "settlement", "SET0A_golden_vectors_rev2.derived.json"), "utf8"),
) as { payout_vectors: PayoutVector[] };

const b = (value: string | number) => BigInt(value);
const TERMS = { pool_net_ujuno: b(5850000), ante_net_ujuno: b(1950000) };

function code(run: () => unknown): string {
  try {
    run();
    return "OK";
  } catch (error) {
    if (!(error instanceof SettlementAppraisalError)) throw error;
    return error.code;
  }
}

describe("payoutPreview: the golden payout vectors P1-P13", () => {
  it("has all thirteen, three of them flagged as needing the wide intermediate", () => {
    expect(golden.payout_vectors.map((v) => v.name.split(" ")[0])).toEqual(
      ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12", "P13"],
    );
    expect(golden.payout_vectors.filter((v) => v.requires_wide_intermediate).map((v) => v.name.split(" ")[0])).toEqual(["P11", "P12", "P13"]);
  });

  for (const vector of golden.payout_vectors) {
    it(vector.name, () => {
      if (vector.error) {
        expect(vector.name.startsWith("P5")).toBe(true);
        expect(code(() => payoutPreview(b(vector.pool_ujuno), vector.weights.map(b)))).toBe("SETTLEMENT_ZERO_SUM");
        return;
      }
      const preview = payoutPreview(b(vector.pool_ujuno), vector.weights.map(b));
      expect(preview.payouts.map(String)).toEqual(vector.payouts_ujuno);
      expect(preview.dust.toString()).toBe(vector.dust_ujuno);
      expect(preview.payouts.reduce((s, p) => s + p, b(0)) + preview.dust).toBe(preview.pool);
      // The decimal-string wrapper answers the same, in the cross-language spelling.
      const decimal = payoutPreviewDecimal(vector.pool_ujuno, vector.weights);
      expect(decimal.payouts).toEqual(vector.payouts_ujuno);
      expect(decimal.dust).toBe(vector.dust_ujuno);
    });
  }

  it("P11-P13 really do overflow u128 where the golden file says (the preview needs no cap)", () => {
    for (const vector of golden.payout_vectors.filter((v) => v.requires_wide_intermediate)) {
      const pool = b(vector.pool_ujuno);
      const weights = vector.weights.map(b);
      const sum = weights.reduce((s, w) => s + w, b(0));
      const product = weights.reduce((max, w) => (pool * w > max ? pool * w : max), b(0));
      const overflow = (vector as unknown as { u128_overflow: string[] }).u128_overflow;
      expect(sum > U128_MAX).toBe(overflow.includes("sum"));
      expect(product > U128_MAX).toBe(overflow.includes("product"));
    }
  });
});

describe("payoutPreview: validation", () => {
  const pool = b(5850000);
  it("refuses a zero sum, a negative or non-bigint weight, a weight or pool beyond u128, and n outside 2..7", () => {
    expect(code(() => payoutPreview(pool, [b(0), b(0), b(0)]))).toBe("SETTLEMENT_ZERO_SUM");
    expect(code(() => payoutPreview(pool, [b(1), b(-1), b(5)]))).toBe("AMOUNT_OUT_OF_RANGE");
    expect(code(() => payoutPreview(pool, [b(1), 2 as unknown as bigint]))).toBe("MALFORMED_AMOUNT");
    expect(code(() => payoutPreview(pool, [b(1), U128_MAX + b(1)]))).toBe("AMOUNT_OUT_OF_RANGE");
    expect(code(() => payoutPreview(U128_MAX + b(1), [b(1), b(1)]))).toBe("AMOUNT_OUT_OF_RANGE");
    expect(code(() => payoutPreview(b(-1), [b(1), b(1)]))).toBe("AMOUNT_OUT_OF_RANGE");
    expect(code(() => payoutPreview(5850000 as unknown as bigint, [b(1), b(1)]))).toBe("MALFORMED_AMOUNT");
    expect(code(() => payoutPreview(pool, [b(1)]))).toBe("BAD_SEAT_COUNT");
    expect(code(() => payoutPreview(pool, Array.from({ length: 8 }, () => b(1))))).toBe("BAD_SEAT_COUNT");
    expect(code(() => payoutPreview(pool, [U128_MAX, U128_MAX]))).toBe("OK");
  });

  it("accepts a zero pool (pays zero, no dust) and a single non-zero weight (pays the pool)", () => {
    const empty = payoutPreview(b(0), [b(3), b(4)]);
    expect(empty.payouts.map(String)).toEqual(["0", "0"]);
    expect(empty.dust.toString()).toBe("0");
    expect(payoutPreview(pool, [b(0), b(0), b(7)]).payouts.map(String)).toEqual(["0", "0", "5850000"]);
  });

  it("a hole in the weights is refused, not carried through as a seat with no payout (review L3)", () => {
    const holey = [b(5), b(1)];
    delete (holey as unknown as Record<number, bigint>)[1];
    expect(code(() => payoutPreview(pool, holey))).toBe("MALFORMED_AMOUNT");
    expect(code(() => terminalSettlementWeights(holey, { reason: "BankBroken" }, TERMS))).toBe("MALFORMED_AMOUNT");
  });

  it("odd inputs to the decimal helpers are coded refusals, never a TypeError (review L4)", () => {
    expect(code(() => parseSettlementDecimal(BigInt(5), "x"))).toBe("MALFORMED_AMOUNT");
    expect(code(() => payoutPreviewDecimal("100", "12" as unknown as string[]))).toBe("MALFORMED_STATE");
  });

  it("the decimal wrapper refuses non-canonical spellings", () => {
    for (const bad of ["-1", "1e3", "01", " 1", "1.0", ""]) {
      expect(code(() => payoutPreviewDecimal("100", ["1", bad]))).toBe("MALFORMED_AMOUNT");
    }
    expect(code(() => parseSettlementDecimal(5, "x"))).toBe("MALFORMED_AMOUNT");
  });

  it("holds its invariants on a deterministic sweep of awkward vectors (payout <= pool, Σ + dust = pool, 0 <= dust < n)", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 500; round += 1) {
      const n = 2 + (next() % 6);
      const scale = [b(1), b(1000), b(1) << b(64), U128_MAX][next() % 4];
      const weights = Array.from({ length: n }, () => (b(next()) * scale) % (U128_MAX + b(1)));
      if (weights.every((w) => w === b(0))) weights[0] = b(1);
      const poolValue = [b(0), b(1), b(13650000), U128_MAX][next() % 4];
      const preview = payoutPreview(poolValue, weights);
      const paid = preview.payouts.reduce((s, p) => s + p, b(0));
      expect(paid + preview.dust).toBe(poolValue);
      expect(preview.dust >= b(0) && preview.dust < b(n)).toBe(true);
      expect(preview.payouts.every((p) => p >= b(0) && p <= poolValue)).toBe(true);
    }
  });
});

describe("terminalSettlementWeights", () => {
  const base = [b(3000), b(1000), b(500)];

  it("returns the base unchanged for BankBroken, Bankruptcy (OD-SET-1 (a)) and ResolverCorrection", () => {
    for (const reason of ["BankBroken", "Bankruptcy", "ResolverCorrection"] as const) {
      const weights = terminalSettlementWeights(base, { reason }, TERMS);
      expect(weights).toEqual(base);
      expect(weights).not.toBe(base);
      expect(Object.isFrozen(weights)).toBe(true);
    }
  });

  it("refuses Forfeit and Clemency (REASON_NOT_SUPPORTED) until ESCROW-3c -- P8-P10 stay specifications", () => {
    for (const vector of golden.payout_vectors.filter((v) => v.policy)) {
      const outcome: TerminalOutcome = { reason: vector.policy!.reason, offender_seat: vector.policy!.offender_seat };
      expect(code(() => terminalSettlementWeights(vector.policy!.base_vector.map(b), outcome, TERMS))).toBe("REASON_NOT_SUPPORTED");
      // The SPECIFIED weights still preview to the specified payouts, so 3c inherits working arithmetic.
      const preview = payoutPreview(b(vector.pool_ujuno), vector.weights.map(b));
      expect(preview.payouts.map(String)).toEqual(vector.payouts_ujuno);
    }
  });

  it("refuses an unknown reason and a malformed base", () => {
    expect(code(() => terminalSettlementWeights(base, { reason: "AdminVoid" } as unknown as TerminalOutcome, TERMS))).toBe("REASON_NOT_SUPPORTED");
    expect(code(() => terminalSettlementWeights(base, null as unknown as TerminalOutcome, TERMS))).toBe("REASON_NOT_SUPPORTED");
    expect(code(() => terminalSettlementWeights([b(1), b(-1)], { reason: "BankBroken" }, TERMS))).toBe("MALFORMED_AMOUNT");
    expect(code(() => terminalSettlementWeights([b(1), 2 as unknown as bigint], { reason: "BankBroken" }, TERMS))).toBe("MALFORMED_AMOUNT");
  });

  it("carries the ESCROW-1.5 §5.3 reason bytes", () => {
    expect(SETTLEMENT_REASON_CODE).toEqual({ BankBroken: 1, Bankruptcy: 2, Forfeit: 3, Clemency: 4, ResolverCorrection: 5 });
  });
});
