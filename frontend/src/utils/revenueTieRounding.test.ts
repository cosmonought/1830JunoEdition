/** @jest-environment node */
//
// ==================================================================
//  UR-7 (Variant Certification 1B -- Unpredictable Revenue): OD-UR-10 = 10-C, AN EXACT $5 TIE ROUNDS TOWARD PRINTED
// ==================================================================
//
// OWNER RULING OD-UR-10 = 10-C (VARIANT_CERT_UNPREDICTABLE_REVENUE_AUDIT_2026-09-24.md, "Owner rulings"; backlog D-47):
// "When the modified Unpredictable Revenue amount lands exactly halfway between two $10 increments, round toward the
// corporation's original printed revenue." Any other amount still rounds to the nearest $10. The owner's examples:
//   printed $50:  -10% = $45 -> $50,  +10% = $55 -> $50
//   printed $150: -10% = $135 -> $140, +10% = $165 -> $160
//   printed $250: -10% = $225 -> $230, +10% = $275 -> $270
// The die modifies the corporation's WHOLE turn total (#941), so the tie is judged against that total's printed figure;
// Private Company income is never rolled (UR-N12). Replaces the ordinary half-up rounding of an exact tie -- UR-F20.
//
// WHAT THIS FILE PINS: the helper (`roundRevenueTowardPrinted`) across the owner's matrix A - H; the die's own step
// (`rollTurnRevenue`) against an independent exact-rational oracle over printed $10 ... $1,000 x every face; and the
// consequences on the authority -- the paid figure on the board, the declaration the Dividends step accepts, the cash a
// payout moves, the Activity Log's sentence, and a hosted room's replay, restore and undo (OD-UR-11: the undo reuses the
// committed draw and reaches the same rounded figure).

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

const GV = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { SERVER_REPLAY_POLICY, RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");

const { roundRevenueTowardPrinted, roundToTen, rollTurnRevenue, applyRevenuePercent, REVENUE_MODIFIER_BY_FACE } = GV;
const { CO, BO, P1, P2, GULF, TWO_ROUTE, urBoard, runMsg, declare, companyOf, partsFor } = S;

/** A turn seed that rolls `face` (the die is `turnSeed % 6 + 1`, #1051). */
const seedForFace = (face: number) => face - 1;
const parts = (face: number) => partsFor(seedForFace(face));

/* ------------------------------------------------------------------ */
/* The independent oracle                                             */
/* ------------------------------------------------------------------ */

/** 10-C computed from the exact rational `printed x percent / 100`, in integers, without the helper under test. The
 *  candidates are the two tens around the exact value; the nearer wins; on an exact tie, the one nearer the printed
 *  figure. (For every printed value the boards can produce -- a multiple of $10 -- the exact value is a whole dollar,
 *  so this and the die's own dollar step agree; the oracle does not rely on that.) */
function oracle(printed: number, percent: number): number {
  const exactTimes100 = printed * percent; // the modified amount x 100, exactly
  const lower = Math.floor(exactTimes100 / 1000) * 10;
  const upper = lower + 10;
  const toLower = exactTimes100 - lower * 100;
  const toUpper = upper * 100 - exactTimes100;
  if (toLower < toUpper) return lower;
  if (toUpper < toLower) return upper;
  const toward = Math.abs(lower - printed) - Math.abs(upper - printed);
  if (toward < 0) return lower;
  if (toward > 0) return upper;
  return upper; // printed itself on the halfway mark (never a route's total): half up, the documented fallback
}

/** Half up, the superseded rule -- kept here only to name what moved. */
const halfUp = (printed: number, percent: number) => roundToTen(applyRevenuePercent(printed, percent));

/* ------------------------------------------------------------------ */
/* The helper: the owner's matrix A - H                               */
/* ------------------------------------------------------------------ */

describe("roundRevenueTowardPrinted: the owner's matrix (OD-UR-10 = 10-C)", () => {
  it("the owner's canonical examples, exactly", () => {
    const cases: Array<[printed: number, adjusted: number, paid: number]> = [
      [50, 45, 50],
      [50, 55, 50],
      [150, 135, 140],
      [150, 165, 160],
      [250, 225, 230],
      [250, 275, 270],
    ];
    for (const [printed, adjusted, paid] of cases) {
      expect([printed, adjusted, roundRevenueTowardPrinted(adjusted, printed)]).toEqual([printed, adjusted, paid]);
    }
  });

  it("A. a non-tie closer to the lower $10 rounds down, whichever side of printed it lies", () => {
    expect(roundRevenueTowardPrinted(44, 50)).toBe(40);
    expect(roundRevenueTowardPrinted(132, 150)).toBe(130);
    expect(roundRevenueTowardPrinted(274, 250)).toBe(270);
    expect(roundRevenueTowardPrinted(64, 80)).toBe(60); // the Rules Reference's own example: $80 at 80% is $64
  });

  it("B. a non-tie closer to the upper $10 rounds up, whichever side of printed it lies", () => {
    expect(roundRevenueTowardPrinted(46, 50)).toBe(50);
    expect(roundRevenueTowardPrinted(56, 50)).toBe(60);
    expect(roundRevenueTowardPrinted(167, 150)).toBe(170);
    expect(roundRevenueTowardPrinted(226, 250)).toBe(230);
  });

  it("C. an exact $5 tie BELOW printed rounds UP, toward printed", () => {
    for (const printed of [50, 150, 250, 450, 950]) {
      const adjusted = printed - 5;
      expect([printed, roundRevenueTowardPrinted(adjusted, printed)]).toEqual([printed, printed]);
    }
    // A tie further below printed still rounds toward it (not reachable with today's faces; the rule is general).
    expect(roundRevenueTowardPrinted(85, 110)).toBe(90);
  });

  it("D. an exact $5 tie ABOVE printed rounds DOWN, toward printed -- never half up", () => {
    for (const printed of [50, 150, 250, 450, 950]) {
      const adjusted = printed + 5;
      expect([printed, roundRevenueTowardPrinted(adjusted, printed)]).toEqual([printed, printed]);
      expect(roundToTen(adjusted)).toBe(printed + 10); // what half up would have paid
    }
    expect(roundRevenueTowardPrinted(135, 110)).toBe(130);
  });

  it("E. a figure already on a $10 is never moved, and printed on a $10 is the reference", () => {
    for (let value = 0; value <= 1000; value += 10) {
      expect(roundRevenueTowardPrinted(value, value)).toBe(value);
      expect(roundRevenueTowardPrinted(value, 500)).toBe(value);
    }
  });

  it("F. low printed values: no face can tie below $50, and nothing positive pays $0", () => {
    for (const printed of [10, 20, 30, 40]) {
      for (let face = 1; face <= 6; face += 1) {
        expect([printed, face, applyRevenuePercent(printed, REVENUE_MODIFIER_BY_FACE[face - 1]) % 10]).not.toEqual([printed, face, 5]);
        const roll = rollTurnRevenue(printed, parts(face));
        expect(roll.adjusted).toBe(oracle(printed, REVENUE_MODIFIER_BY_FACE[face - 1]));
        expect(roll.adjusted).toBeGreaterThanOrEqual(10);
      }
    }
    expect(rollTurnRevenue(0, parts(6)).adjusted).toBe(0);
  });

  it("G / H. mid and high printed values: the ties toward printed, every other face as before", () => {
    const expectations: Array<[printed: number, byFace: number[]]> = [
      // face:     1     2     3     4     5     6
      [150, [120, 140, 150, 150, 160, 180]],
      [250, [200, 230, 250, 250, 270, 300]],
      [450, [360, 410, 450, 450, 490, 540]],
      [1050, [840, 950, 1050, 1050, 1150, 1260]],
    ];
    for (const [printed, byFace] of expectations) {
      expect([printed, byFace.map((_, index) => rollTurnRevenue(printed, parts(index + 1)).adjusted)]).toEqual([printed, byFace]);
    }
  });

  it("integers only, a multiple of $10, never more than $5 from the modified amount", () => {
    for (let adjusted = 0; adjusted <= 1200; adjusted += 1) {
      for (const printed of [0, 10, 45, 50, 55, 150, 1000]) {
        const paid = roundRevenueTowardPrinted(adjusted, printed);
        expect(Number.isInteger(paid)).toBe(true);
        expect(paid % 10).toBe(0);
        expect(Math.abs(paid - adjusted)).toBeLessThanOrEqual(5);
      }
    }
  });

  it("off the printed boards (every printed route value there is a multiple of $10): a tie still goes toward printed; an exact tie ON printed keeps half up", () => {
    // Not reachable in play -- the only non-multiples of ten in the game's data are Private Company incomes, which the
    // die never touches (UR-N12). Pinned so the helper's whole domain is stated.
    expect(roundRevenueTowardPrinted(45, 47)).toBe(50);
    expect(roundRevenueTowardPrinted(45, 43)).toBe(40);
    // Printed exactly on the halfway mark leaves both tens equally near: the one reading that makes no claim is kept.
    expect(roundRevenueTowardPrinted(45, 45)).toBe(roundToTen(45));
  });
});

/* ------------------------------------------------------------------ */
/* The die's own step                                                 */
/* ------------------------------------------------------------------ */

describe("rollTurnRevenue rounds with 10-C (UR-F20): the whole table, $10 ... $1,000 x six faces", () => {
  it("matches the exact oracle at every printed multiple of $10 and every face", () => {
    for (let printed = 10; printed <= 1000; printed += 10) {
      for (let face = 1; face <= 6; face += 1) {
        const percent = REVENUE_MODIFIER_BY_FACE[face - 1];
        expect([printed, face, rollTurnRevenue(printed, parts(face)).adjusted]).toEqual([printed, face, oracle(printed, percent)]);
      }
    }
  });

  it("differs from half up in exactly one place: face 5 (+10%) where printed is $50 mod $100 -- $10 lower", () => {
    const moved: string[] = [];
    for (let printed = 10; printed <= 1000; printed += 10) {
      for (let face = 1; face <= 6; face += 1) {
        const percent = REVENUE_MODIFIER_BY_FACE[face - 1];
        const paid = rollTurnRevenue(printed, parts(face)).adjusted;
        if (paid !== halfUp(printed, percent)) moved.push(`${printed}@${face}:${halfUp(printed, percent)}->${paid}`);
      }
    }
    const expected: string[] = [];
    for (let printed = 50; printed <= 1000; printed += 100) {
      const before = halfUp(printed, 110); // $55 -> $60, $165 -> $170, $275 -> $280 ...
      expected.push(`${printed}@5:${before}->${before - 10}`);
    }
    expect(moved).toEqual(expected);
    expect(moved.slice(0, 3)).toEqual(["50@5:60->50", "150@5:170->160", "250@5:280->270"]);
  });

  it("on the whole integer domain ($1 ... $1,000, off the $10 grid too) 10-C changes EXACT ties and nothing else", () => {
    /* Off the grid no route reaches, the die's dollar step can show a tie that is not one: $41 at 110% is exactly $45.10,
       shown as $45. The tie is judged on the exact product, so that figure keeps the rounding it always had ($50), and
       only an exact halfway amount goes toward printed. */
    expect(rollTurnRevenue(41, parts(5)).adjusted).toBe(50);
    expect(rollTurnRevenue(41, parts(5)).adjusted).toBe(halfUp(41, 110));
    for (let printed = 1; printed <= 1000; printed += 1) {
      for (let face = 1; face <= 6; face += 1) {
        const percent = REVENUE_MODIFIER_BY_FACE[face - 1];
        const exactTie = (printed * percent) % 1000 === 500;
        const paid = rollTurnRevenue(printed, parts(face)).adjusted;
        if (exactTie) expect([printed, face, paid]).toEqual([printed, face, oracle(printed, percent)]);
        else expect([printed, face, paid]).toEqual([printed, face, halfUp(printed, percent)]);
      }
    }
  });

  it("the six-face mean equals the printed figure exactly at every printed multiple of $10 (the owner's symmetry)", () => {
    for (let printed = 10; printed <= 1000; printed += 10) {
      let total = 0;
      for (let face = 1; face <= 6; face += 1) total += rollTurnRevenue(printed, parts(face)).adjusted;
      expect([printed, total]).toEqual([printed, printed * 6]);
    }
  });

  it("a face-5 tie that rounds back to printed is an UNCHANGED outcome: the log says so and names no bonus (UR-N14)", () => {
    const roll = rollTurnRevenue(50, parts(5));
    expect(roll).toEqual({ face: 5, percent: 110, printed: 50, adjusted: 50 });
    expect(GV.revenueOutcome(roll)).toBe("normal");
    expect(GV.flavorBucketFor(roll)).toBe("unchanged");
    const sentence = GV.turnRevenueSentence("C&O", roll, parts(5));
    expect(sentence.startsWith("C&O ran for $50. ")).toBe(true);
    expect(sentence).not.toMatch(/bonus|malus|\$60/);
    // The -10% tie was already paid at printed under half up; it still is, with the same sentence.
    expect(rollTurnRevenue(50, parts(2)).adjusted).toBe(50);
    expect(GV.flavorBucketFor(rollTurnRevenue(50, parts(2)))).toBe("unchanged");
  });

  it("the Yellow Sign's faces never tie: faces 1 and 6 on any printed multiple of $10 are whole tens away from a half", () => {
    for (let printed = 10; printed <= 1000; printed += 10) {
      for (const face of [1, 6]) {
        const exact = applyRevenuePercent(printed, REVENUE_MODIFIER_BY_FACE[face - 1]);
        expect([printed, face, exact % 10 === 5]).toEqual([printed, face, false]);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* The authority                                                      */
/* ------------------------------------------------------------------ */

const CTX = { mapGrid: GULF, era: "Yellow" } as const;
const apply = (state: GameStateResponse, msg: unknown) => applySandboxAction(state, msg as never, CTX);

/** C&O [2] on the Gulf line (I5-I3-J2, printed $50), phase 2 / 3 boards, pinned; B&O holds a 3 elsewhere. */
const tieBoard = () =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["2"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"], treasury: 300 },
    ],
  });
const RUN_2 = (seed?: number) => runMsg(CO, [TWO_ROUTE], [0], ["2"], seed);
const FACE_5 = seedForFace(5);

describe("the authority pays the 10-C figure (UR-F20)", () => {
  it("the run: printed $50 at +10% puts $50 on the board (half up paid $60); the per-train figure stays printed", () => {
    const after = apply(tieBoard(), RUN_2(FACE_5));
    const co = companyOf(after, CO);
    expect(co.printed_route_revenue).toBe("50");
    expect(co.last_route_revenue).toBe("50");
    expect(co.last_run_breakdown).toEqual([{ train_index: 0, model: "2", printed_revenue: "50" }]);
    expect(co.last_run_revenue_seed).toBe(FACE_5);
    expect(after.operating_sub_phase).toBe("Dividends");
  });

  it("the Dividends step accepts $50 and refuses the half-up $60; a payout moves exactly 60% of $50 to the president", () => {
    const ran = apply(tieBoard(), RUN_2(FACE_5));
    const refused = apply(ran, declare(CO, 60, true));
    expect(stateDigest(refused)).toBe(stateDigest(ran));
    const paid = apply(ran, declare(CO, 50, true));
    const cash = (state: GameStateResponse) => Number(state.player_cash.find((row) => row.player === P1)!.cash_vgp);
    expect(cash(paid) - cash(ran)).toBe(30);
    expect(Number(paid.virtual_bank_vgp)).toBe(Number(ran.virtual_bank_vgp) - 30);
    expect(paid.operating_sub_phase).not.toBe("Dividends");
  });

  it("a withhold banks $50 in the treasury", () => {
    const ran = apply(tieBoard(), RUN_2(FACE_5));
    const kept = apply(ran, declare(CO, 50, false));
    expect(Number(companyOf(kept, CO).treasury)).toBe(350);
  });

  it("a standard table never rolls: a $110 run on a +20% draw pays $110 there and $130 on the variant's table (UR-N3)", () => {
    /* At an exact tie 10-C pays printed too, so the tie cannot tell "no die" from "a die"; a face the die MOVES can. */
    const corps = [
      { id: CO, president: P1, trains: ["2", "3"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"], treasury: 300 },
    ];
    // Face 6 on an unmarked table: a critical bonus and nothing else (Carcosa needs the Marked corporation).
    const FACE_6 = seedForFace(6);
    const RUN_23 = runMsg(CO, [TWO_ROUTE, S.THREE_ROUTE], [0, 1], ["2", "3"], FACE_6);
    const standard = apply(urBoard({ ur: false, corps }), RUN_23);
    const variant = apply(urBoard({ corps }), RUN_23);
    expect([companyOf(standard, CO).printed_route_revenue, companyOf(standard, CO).last_route_revenue]).toEqual(["110", "110"]);
    expect([companyOf(variant, CO).printed_route_revenue, companyOf(variant, CO).last_route_revenue]).toEqual(["110", "130"]);
  });
});

describe("hosted: the committed draw replays, restores and survives an undo to the same 10-C figure (OD-UR-11)", () => {
  const room = () => {
    let drawn = 0;
    let minted = 0;
    const seed = tieBoard();
    const session = new RoomSession({
      providers: S.roomProviders(seed, GULF),
      seed: { state: seed, waterfall: null },
      build: "ur3",
      mintId: () => `ur7-${(minted += 1)}`,
      now: () => 0,
      mintSeed: () => {
        drawn += 1;
        if (drawn > 1) throw new Error("the server drew twice for one turn");
        return FACE_5;
      },
    });
    return { session, seed };
  };

  it("the server's draw is committed, and the paid $50 is what every reader of the log reaches", () => {
    const { session, seed } = room();
    expect(S.submitTo(session, P1, RUN_2(987654321)).kind).toBe("applied"); // the client's seed is replaced (#1662)
    expect(JSON.parse(session.entries[0].payload).RunMultipleRoutes.revenue_seed).toBe(FACE_5);
    expect(companyOf(session.state, CO).last_route_revenue).toBe("50");
    const replayed = replayLog(
      session.entries.map((entry) => ({ index: entry.index, id: entry.id, actor: entry.actor, payload: entry.payload })),
      S.roomProviders(seed, GULF),
      { state: seed, waterfall: null },
      undefined,
      SERVER_REPLAY_POLICY,
    );
    expect(stateDigest(replayed.state)).toBe(stateDigest(session.state));
    const restored = new RoomSession({
      providers: S.roomProviders(seed, GULF),
      seed: { state: seed, waterfall: null },
      build: "ur3",
      mintId: () => "x",
      mintSeed: () => {
        throw new Error("a restore must never draw");
      },
    });
    restored.restore(session.entries as never);
    expect(stateDigest(restored.state)).toBe(stateDigest(session.state));
    expect(companyOf(restored.state, CO).last_route_revenue).toBe("50");
  });

  it("undo, run again: the same draw is reused (no second draw) and the same $50 is paid", () => {
    const { session } = room();
    expect(S.submitTo(session, P1, RUN_2()).kind).toBe("applied");
    const first = stateDigest(session.state);
    expect(S.submitTo(session, P1, { RevertTo: { index: 0, player: P1, summary: "undo" } } as never).kind).toBe("applied");
    expect(companyOf(session.state, CO).last_route_revenue).toBe("0");
    expect(S.submitTo(session, P1, RUN_2(5)).kind).toBe("applied"); // throws inside mintSeed if the server drew again
    const rerun = session.entries[session.entries.length - 1];
    expect(JSON.parse(rerun.payload).RunMultipleRoutes.revenue_seed).toBe(FACE_5);
    expect(companyOf(session.state, CO).last_route_revenue).toBe("50");
    expect(stateDigest(session.state)).toBe(first);
  });

  it("the version this ships under is at least 10 -- the tie rule is carried by the deliberate 9 -> 10 boundary (UR-8)", () => {
    /* UR-8: was `toBe(9)` ("owed to the 9 -> 10 boundary"). The boundary is taken (changelog row 10 (7)); the current number
       belongs to `unpredictableRevenueClosure.test.ts`. Version-literal only. */
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(10);
  });
});
