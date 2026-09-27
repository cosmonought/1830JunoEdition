/** @jest-environment node */
// frontend/src/utils/settlementGoldens.test.ts
//
// ==================================================================
//  SET-0B: THE SET-0A REV 2 GOLDEN CASES, REPRODUCED BY THE CANONICAL PRIMITIVES
// ==================================================================
//
// Source of every expected value: `claude/SET0A_golden_vectors_2026-09-25.json` revision 2, transcribed into
// `__fixtures__/settlement/SET0A_golden_vectors_rev2.derived.json` (provenance recorded in that file). The boards are
// rebuilt in-repo (`settlementGoldenBoards.ts`), and the first test proves each rebuild is byte-identical to the
// golden file's board by its `terminal_state_hash_v1`.
//
// Every case runs the production path ESCROW-3 will run: canonical text once -> hash those bytes -> appraise the
// board parsed from them -> policy -> preview.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

import {
  appraiseCommittedState,
  canonicalStateText,
  terminalStateHashV1,
} from "../gameEngine/settlementDigest";
import { appraiseSeats, baseNetWorthVector, type SettlementSeat } from "../gameEngine/settlementAppraisal";
import { terminalSettlementWeights, SETTLEMENT_REASON_CODE, type TerminalReason } from "../gameEngine/settlementPolicy";
import { payoutPreview } from "../gameEngine/settlementPreview";
import { rankPlayers } from "../gameEngine/endgame";
import type { GameStateResponse } from "../gameEngine/gameState";
import { goldenBoards, SET0A_CERTIFIED_RULES_ENGINE_VERSION } from "./settlementGoldenBoards";

interface GoldenComponent {
  player_id: string;
  bankrupt: boolean;
  cash_in_state: string;
  cash: string;
  shares: string;
  privates: string;
  total: string;
  private_ids: number[];
  holdings: Array<[string, number, string | null, string]>;
}
interface GoldenCase {
  name: string;
  kind: string;
  reason: TerminalReason;
  terminal_state_hash_v1: string;
  turn_order: string[];
  seat_mapping: string[];
  components: GoldenComponent[];
  vector: string[];
  sum: string;
  pool_ujuno: string;
  payouts_ujuno: string[];
  dust_ujuno: string;
}
interface Golden {
  ante: { ante_net_ujuno: string };
  cases: GoldenCase[];
  payout_vectors: Array<{ name: string; pool_ujuno: string; weights: string[]; payouts_ujuno?: string[]; dust_ujuno?: string; error?: string }>;
}

const FIXTURE_DIR = join(__dirname, "__fixtures__", "settlement");
const golden = JSON.parse(readFileSync(join(FIXTURE_DIR, "SET0A_golden_vectors_rev2.derived.json"), "utf8")) as Golden;
const { boards, syn01Submissions } = goldenBoards();

const seatsOf = (ids: readonly string[]): SettlementSeat[] => ids.map((player_id, seat_index) => ({ seat_index, player_id }));
const strings = (values: readonly bigint[]) => values.map((value) => value.toString());
const TERMS = { pool_net_ujuno: BigInt(0), ante_net_ujuno: BigInt(golden.ante.ante_net_ujuno) };

function rankedWorth(state: GameStateResponse): Record<string, number> {
  const marks = (state.market_positions ?? {}) as Record<number, { price: number } | null>;
  const out: Record<string, number> = {};
  for (const row of rankPlayers({
    state,
    priceForCompany: (id) => marks[id]?.price ?? null,
    labelForAddress: (address) => address,
    bankruptAddress: state.bankrupt_president ?? null,
  })) {
    out[row.address] = row.netWorth;
  }
  return out;
}

describe("SET-0A golden boards, rebuilt in-repo", () => {
  it("covers exactly the thirteen SET-0A cases", () => {
    expect(Object.keys(boards).sort()).toEqual(golden.cases.map((entry) => entry.name).sort());
    expect(golden.cases).toHaveLength(13);
  });

  it("SYN-01 is reducer-driven to GameEnd in exactly the 20 submissions the golden file records", () => {
    expect(syn01Submissions).toBe(20);
  });

  for (const entry of golden.cases) {
    it(`${entry.name}: the rebuilt board is byte-identical to the golden board (terminal_state_hash_v1)`, () => {
      const board = boards[entry.name];
      expect(terminalStateHashV1(board)).toBe(entry.terminal_state_hash_v1);
      /* DA-8: the CERTIFIED pin, not the gameplay engine's -- the two axes are independent (owner ruling); the unstamped
         rebuild's pin is `da8RulesV11Closure.test.ts`'s to pin. */
      expect(board.rules_engine_version).toBe(SET0A_CERTIFIED_RULES_ENGINE_VERSION);
      expect(board.current_round_type).toBe("GameEnd");
      expect(board.player_addresses).toEqual(entry.turn_order);
    });
  }
});

describe("SET-0A golden cases through the committed-state pipeline", () => {
  for (const entry of golden.cases) {
    describe(entry.name, () => {
      const board = boards[entry.name];
      const seats = seatsOf(entry.seat_mapping);
      const committed = appraiseCommittedState(canonicalStateText(board), seats);

      it("hashes the committed bytes to the golden appraisal_state_hash", () => {
        expect(committed.appraisal_state_hash).toBe(entry.terminal_state_hash_v1);
      });

      it("reproduces the base vector and its sum, in chain seat order", () => {
        expect(strings(committed.vector)).toEqual(entry.vector);
        expect(committed.vector.reduce((a, b) => a + b, BigInt(0)).toString()).toBe(entry.sum);
        // The live board and the committed bytes appraise identically (they are the same canonical state).
        expect(strings(baseNetWorthVector(board, seats))).toEqual(entry.vector);
      });

      it("reproduces every component: cash in state / counted, shares, privates, holdings lines, private ids", () => {
        expect(committed.appraisals).toHaveLength(entry.components.length);
        committed.appraisals.forEach((seat, index) => {
          const want = entry.components[index];
          expect(seat.seat_index).toBe(index);
          expect(seat.player_id).toBe(want.player_id);
          expect(seat.bankrupt).toBe(want.bankrupt);
          expect(seat.cash_state.toString()).toBe(want.cash_in_state);
          expect(seat.cash_counted.toString()).toBe(want.cash);
          expect(seat.shares.toString()).toBe(want.shares);
          expect(seat.privates.toString()).toBe(want.privates);
          expect(seat.total.toString()).toBe(want.total);
          expect(seat.private_lines.map((line) => line.private_id)).toEqual(want.private_ids);
          expect(
            seat.holdings.map((line) => [line.ticker, line.percent, line.share_value === null ? null : line.share_value.toString(), line.value.toString()]),
          ).toEqual(want.holdings);
        });
      });

      it("passes the policy layer unchanged for its reason", () => {
        expect(["BankBroken", "Bankruptcy"]).toContain(entry.reason);
        expect(SETTLEMENT_REASON_CODE[entry.reason]).toBeGreaterThan(0);
        expect(terminalSettlementWeights(committed.vector, { reason: entry.reason } as never, TERMS)).toEqual(committed.vector);
      });

      it("previews the golden payouts and dust from the golden pool", () => {
        expect(entry.pool_ujuno).toBe((BigInt(entry.seat_mapping.length) * TERMS.ante_net_ujuno).toString());
        const preview = payoutPreview(BigInt(entry.pool_ujuno), committed.vector);
        expect(strings(preview.payouts)).toEqual(entry.payouts_ujuno);
        expect(preview.dust.toString()).toBe(entry.dust_ujuno);
      });

      it("agrees with the current rankPlayers on every seat (parity, SET-0A §13)", () => {
        const ranked = rankedWorth(board);
        for (const seat of committed.appraisals) expect(ranked[seat.player_id]).toBe(Number(seat.total.toString()));
      });
    });
  }
});

describe("seat mapping: chain seat order, never turn order", () => {
  const board = boards["SYN-01-CLASSIC-BANKBREAK"];

  it("Q15: per-player totals are invariant and the vector permutes with the mapping", () => {
    const byMapping = (ids: string[]) => strings(baseNetWorthVector(board, seatsOf(ids)));
    expect(byMapping(["p1", "p2", "p3"])).toEqual(["2448", "2018", "2409"]);
    expect(byMapping(["p3", "p2", "p1"])).toEqual(["2409", "2018", "2448"]);
    expect(byMapping(["p2", "p1", "p3"])).toEqual(["2018", "2448", "2409"]);
  });

  it("a shuffled TURN order with a fixed CHAIN mapping leaves the vector unchanged", () => {
    const seats = seatsOf(["p2", "p1", "p3"]);
    const turnOrders = [["p1", "p2", "p3"], ["p3", "p1", "p2"], ["p2", "p3", "p1"], ["p3", "p2", "p1"]];
    for (const order of turnOrders) {
      const shuffled = { ...board, player_addresses: order, active_player_index: 2, priority_deal_index: 1 } as GameStateResponse;
      expect(strings(baseNetWorthVector(shuffled, seats))).toEqual(["2018", "2448", "2409"]);
    }
  });

  it("every one of the 7! mappings of the 7-seat board permutes the same multiset", () => {
    const seven = boards["SYN-12-SEVEN-PLAYERS-LPF"];
    const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    const worth: Record<string, string> = { p1: "2448", p2: "2018", p3: "2409", p4: "360", p5: "360", p6: "0", p7: "5" };
    let checked = 0;
    const permute = (rest: string[], prefix: string[]) => {
      if (rest.length === 0) {
        expect(strings(baseNetWorthVector(seven, seatsOf(prefix)))).toEqual(prefix.map((id) => worth[id]));
        checked += 1;
        return;
      }
      rest.forEach((id, at) => permute([...rest.slice(0, at), ...rest.slice(at + 1)], [...prefix, id]));
    };
    permute(ids, []);
    expect(checked).toBe(5040);
  });

  it("2 seats and 7 seats are accepted (SYN-06, SYN-13, SYN-12)", () => {
    expect(appraiseSeats(boards["SYN-06-G6J-UNPARRED-GRANT-END"], seatsOf(["p-fdsq3jbg", "p-lzjh2r6u"]))).toHaveLength(2);
    expect(appraiseSeats(boards["SYN-13-CV4-TWO-PLAYER-END"], seatsOf(["p-vmlqoi42", "p-xj8g7vth"]))).toHaveLength(2);
    expect(appraiseSeats(boards["SYN-12-SEVEN-PLAYERS-LPF"], seatsOf(["p6", "p5", "p4", "p3", "p2", "p1", "p7"]))).toHaveLength(7);
  });
});

/* ------------------------------------------------------------------ */
/* The cross-language handoff (ESCROW-2 / SET-0C)                     */
/* ------------------------------------------------------------------ */

/* `settlementCrossLanguageVectors.json` is what a Rust or Python consumer compares against: decimal-string weights,
   pool, payouts, dust, the appraisal state hash and the seat mapping of every golden case, plus P1-P13. It is
   GENERATED by the primitives and PINNED here: the committed file must equal what the code produces, and what the
   code produces equals the SET-0A golden values (asserted above). `UPDATE_SETTLEMENT_VECTORS=1` rewrites it. */
describe("the cross-language vector file", () => {
  const file = join(FIXTURE_DIR, "settlementCrossLanguageVectors.json");

  function generate(): unknown {
    return {
      format: "18JUNO/SET0B/settlement-vectors/v1",
      source: "generated by frontend/src/utils/settlementGoldens.test.ts from the SET-0B primitives; every value equals SET-0A golden vectors rev 2",
      money_encoding: "decimal strings of non-negative integers: weights in whole VGP (base vector) or ratio units; pool, payouts and dust in ujuno",
      payload_mapping: {
        settlement_weights: "cases[].settlement_weights (terminalSettlementWeights of the base vector; identity for BankBroken / Bankruptcy / ResolverCorrection)",
        appraisal_state_hash: "cases[].appraisal_state_hash = terminal_state_hash_v1 of the appraised board",
        appraisal_log_len: "== log_len for every case here (A1); log lengths belong to ESCROW-3's payload vectors",
        reason: "cases[].reason_code (ESCROW-1.5 §5.3)",
      },
      cases: golden.cases.map((entry) => {
        const committed = appraiseCommittedState(canonicalStateText(boards[entry.name]), seatsOf(entry.seat_mapping));
        const weights = terminalSettlementWeights(committed.vector, { reason: entry.reason } as never, TERMS);
        const preview = payoutPreview(BigInt(entry.pool_ujuno), weights);
        return {
          name: entry.name,
          reason: entry.reason,
          reason_code: SETTLEMENT_REASON_CODE[entry.reason],
          appraisal_state_hash: committed.appraisal_state_hash,
          seat_mapping: entry.seat_mapping.map((player_id, seat_index) => ({ seat_index, player_id })),
          settlement_weights: strings(weights),
          pool_ujuno: preview.pool.toString(),
          payouts_ujuno: strings(preview.payouts),
          dust_ujuno: preview.dust.toString(),
        };
      }),
      payout_vectors: golden.payout_vectors.map((vector) => {
        // Carry the golden metadata ESCROW-2 needs: the policy context (P8-P10) and the u128-overflow flags (P11-P13).
        const { payouts_ujuno: _payouts, dust_ujuno: _dust, error: _error, ...metadata } = vector as Record<string, unknown>;
        void _payouts;
        void _dust;
        void _error;
        const base = metadata;
        try {
          const preview = payoutPreview(BigInt(vector.pool_ujuno), vector.weights.map((w) => BigInt(w)));
          return { ...base, payouts_ujuno: strings(preview.payouts), dust_ujuno: preview.dust.toString() };
        } catch (error) {
          return { ...base, error: (error as { code?: string }).code };
        }
      }),
    };
  }

  it("is exactly what the primitives generate", () => {
    const text = `${JSON.stringify(generate(), null, 2)}\n`;
    if (process.env.UPDATE_SETTLEMENT_VECTORS === "1") writeFileSync(file, text);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("carries the golden payout vectors P1-P13, P5 as the zero-sum refusal", () => {
    const vectors = (JSON.parse(readFileSync(file, "utf8")) as { payout_vectors: Array<Record<string, unknown>> }).payout_vectors;
    expect(vectors).toHaveLength(13);
    expect(vectors.filter((v) => v.policy).map((v) => (v.policy as { reason: string }).reason)).toEqual(["Forfeit", "Clemency", "Clemency"]);
    expect(vectors.filter((v) => v.requires_wide_intermediate === true).map((v) => String(v.name).split(" ")[0])).toEqual(["P11", "P12", "P13"]);
    golden.payout_vectors.forEach((want, index) => {
      if (want.payouts_ujuno) {
        expect(vectors[index].payouts_ujuno).toEqual(want.payouts_ujuno);
        expect(vectors[index].dust_ujuno).toBe(want.dust_ujuno);
      } else {
        expect(vectors[index].error).toBe("SETTLEMENT_ZERO_SUM");
      }
    });
  });
});
