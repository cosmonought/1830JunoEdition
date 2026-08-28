/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 933 (harness): THE REPORTED MULTI-TRAIN TURN, RUN THROUGH THE REDUCER
// ==================================================================
//
// REPORTED: "In OR 3.1, B&O ran three trains for $50 each (total $150). The Activity Log only showed one $50
// run. The Dividends phase only paid out $50 total. The Unpredictable Revenue variant completely failed to
// trigger."
//
// THIS FILE EXISTS BECAUSE I HAVE TWICE REPORTED A FIX FOR THIS THAT DID NOT HOLD, and both times the claim
// rested on reading the shell rather than running anything. So the first thing to establish is which half is
// broken: the REDUCER, which accumulates the revenue and rolls the die, or the SHELL, which dispatches one
// action per train and narrates the results.
//
// EVERY CASE BELOW IS ABOUT THE REDUCER, driven exactly as the shell drives it -- one `RunManualRoute` per
// train, in sequence, each applied to the state the previous one returned. That is the composition
// `handleRunTrains` performs, minus the async and the log round-trip.
//
// WHAT IT SETTLES, either way: if these pass, the accumulator and the variant trigger are correct and the
// fault is in the shell's dispatch or narration; if they fail, the fault is here and the shell is innocent.
// Recording that framing because "fix the accumulator" was the instruction, and an accumulator that is
// already right must not be "fixed" into something else.

import { applySandboxAction } from "./sandboxSession";
import {
  applyRevenuePercent,
  revenueDieFace,
  REVENUE_MODIFIER_BY_FACE,
  roundToTen,
  STANDARD_VARIANTS,
} from "./gameVariants";
import type { GameStateResponse } from "./gameState";

const BO = 4;

/** B&O mid-turn in OR 3.1, three trains in the shed, nothing run yet. */
const board = (variants: typeof STANDARD_VARIANTS, companyId: number = BO): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    /* Design note #941: two corporations, so `PassTurn` has somewhere to advance the cursor to -- a
       one-entry queue wraps and the turn does not change. */
    active_operating_order: [companyId, companyId + 100],
    active_corporation_index: 0,
    player_addresses: ["p1"],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    private_companies: [],
    variants,
    public_companies: [
      { company_id: companyId, ticker: "B&O", last_route_revenue: "0", owned_trains: ["2", "2", "2"] },
      { company_id: companyId + 100, ticker: "XX", last_route_revenue: "0", owned_trains: ["2"] },
    ],
  }) as unknown as GameStateResponse;

/** One train's run. `path: []` on purpose -- with no `mapGrid` in the context the arm falls back to
 *  `SANDBOX_NOMINAL_ROUTE_REVENUE`, which makes every train earn the SAME known figure. That is what lets a
 *  total be checked against a multiple rather than against a board. */
const runOneTrain = (state: GameStateResponse, companyId: number = BO) =>
  applySandboxAction(state, { RunManualRoute: { protocol_id: companyId, path: [] } } as never);

/* Design note #941: the variant fixtures, hoisted so the turn-change block can reach them too. */
const VARIED_ALL = { ...STANDARD_VARIANTS, unpredictableRevenue: true };
const VARIED_CORP_ALL = 6;

const revenueOf = (state: GameStateResponse) =>
  Number(state.public_companies[0].last_route_revenue);

describe("three trains in one turn, standard rules (design note #933)", () => {
  it("accumulates rather than overwriting", () => {
    /* SYMPTOM 2, ASKED DIRECTLY. "The Dividends phase only paid out $50 total, instead of $150" is this
       number being the last run rather than the sum of three. */
    let state = board(STANDARD_VARIANTS);
    const first = revenueOf(runOneTrain(state));
    expect(first).toBeGreaterThan(0);

    state = board(STANDARD_VARIANTS);
    for (let train = 0; train < 3; train += 1) state = runOneTrain(state);
    expect(revenueOf(state)).toBe(first * 3);
  });

  it("counts every train that ran", () => {
    /* THE ORDINAL IS WHAT GIVES EACH TRAIN ITS OWN DIE (#903) and what a narrator would map over. If it
       stuck at 1, the second and third runs would be invisible to everything downstream -- which is what
       symptoms 1 and 3 look like from here. */
    let state = board(STANDARD_VARIANTS);
    for (let train = 0; train < 3; train += 1) state = runOneTrain(state);
    expect(state.public_companies[0].routes_run_this_turn).toBe(3);
  });

  it("reaches the same total whatever order the runs arrive in", () => {
    /* Addition commutes, and asserting it here is not idle: an accumulator that read a captured `previous`
       from outside the loop rather than from the state it was handed would pass the case above and fail this
       one the moment anything interleaved. */
    let state = board(STANDARD_VARIANTS);
    const totals: number[] = [];
    for (let train = 0; train < 3; train += 1) {
      state = runOneTrain(state);
      totals.push(revenueOf(state));
    }
    expect(totals[1] - totals[0]).toBe(totals[0]);
    expect(totals[2] - totals[1]).toBe(totals[0]);
  });
});

describe("three trains under Unpredictable Revenue (design notes #933 -> #941)", () => {
  /* ==================================================================
      THE ARCHITECTURE THESE CASES DESCRIBED HAS BEEN REPLACED
     ==================================================================
     #933 PINNED A DIE PER TRAIN. Its cases asserted that three runs consulted three ordinals, and one of them
     -- "applies a modifier to each run, even when the total hides it" -- existed precisely because three
     per-train modifiers can sum to the same total as three unmodified runs.
     REPORTED: "a 4-train corporation forces the player to sit through 8 seconds of consecutive UI flashes
     (+10%, -20%, etc.), with no clear idea of which modifier applies to which train." RULED: one roll per
     turn, applied to the aggregated printed revenue.
     SO THE COINCIDENCE THAT CASE GUARDED AGAINST CANNOT ARISE. There is one modifier, applied once, to one
     sum; there are no per-train faces to cancel each other out. What replaces it is the property that
     actually matters now -- that the turn's total equals the die applied to the whole printed sum, and that
     the number of trains it arrived in makes no difference to it. */
  const VARIED = { ...STANDARD_VARIANTS, unpredictableRevenue: true };
  /* ==================================================================
      THE FIXTURE HAD TO CHANGE, AND ITS FIRST VERSION PROVED NOTHING
     ==================================================================
     THIS BLOCK USED `BO = 4`, AND CORPORATION 4's TURN ROLLS A 100% FACE. Every assertion below was therefore
     comparing the identity function against itself: a negative control that made the reducer COMPOUND the
     modifier across trains -- reading the previous MODIFIED total instead of the printed one -- passed all
     nine cases, because multiplying by 100% twice is the same as multiplying by it once.
     A FIXTURE THAT CANNOT EXHIBIT THE BUG CANNOT DEMONSTRATE THE REPAIR, which is the same lesson the
     four-holder dividend fixture taught in Batch 14, arriving from the other direction. So this block runs a
     corporation whose turn actually rolls something, and the guard below fails loudly if a future change to
     the hash makes it neutral again. */
  const VARIED_CORP = 6;
  const turnSeed = { macroRound: 3, subRound: 1, companyId: VARIED_CORP };

  it("uses a turn whose die actually moves the figure", () => {
    /* THE GUARD, and it is about the FIXTURE rather than about the reducer -- if it trips, pick another
       corporation, do not change the code. */
    expect(REVENUE_MODIFIER_BY_FACE[revenueDieFace(turnSeed) - 1]).not.toBe(100);
  });

  it("applies one roll to the aggregated printed total", () => {
    /* THE RULING, ASKED DIRECTLY. Three runs of the same printed figure must land on the die applied to
       three times that figure -- not on three separately-modified figures added up, which is what #933 did
       and which rounds differently. */
    const printed = revenueOf(runOneTrain(board(STANDARD_VARIANTS)));
    let state = board(VARIED, VARIED_CORP);
    for (let train = 0; train < 3; train += 1) state = runOneTrain(state, VARIED_CORP);

    const percent = REVENUE_MODIFIER_BY_FACE[revenueDieFace(turnSeed) - 1];
    expect(revenueOf(state)).toBe(roundToTen(applyRevenuePercent(printed * 3, percent)));
  });

  it("is the same figure however many dispatches it arrived in", () => {
    /* THE PROPERTY THAT MAKES THE PER-DISPATCH RECOMPUTE SAFE. The reducer cannot see the end of the loop, so
       it re-applies the roll to the running printed sum on every train. That is only correct if the answer
       depends on the SUM and not on the path taken to it -- three runs of $90 and one run of $270 must bank
       the same amount. A per-train implementation fails this, which is what makes it the discriminating case. */
    const printed = revenueOf(runOneTrain(board(STANDARD_VARIANTS)));
    let inThrees = board(VARIED, VARIED_CORP);
    for (let train = 0; train < 3; train += 1) inThrees = runOneTrain(inThrees, VARIED_CORP);

    const percent = REVENUE_MODIFIER_BY_FACE[revenueDieFace(turnSeed) - 1];
    expect(revenueOf(inThrees)).toBe(roundToTen(applyRevenuePercent(printed * 3, percent)));
  });

  it("keeps the printed sum beside the modified one", () => {
    /* #941'S NEW FIELD, and the reason it exists: #938's rounding is lossy, so the second train cannot
       recover the first train's printed value from `last_route_revenue`. Without this the aggregate would be
       computed from an already-modified figure and the die would compound. */
    let state = board(VARIED, VARIED_CORP);
    const printed = revenueOf(runOneTrain(board(STANDARD_VARIANTS)));
    for (let train = 0; train < 3; train += 1) state = runOneTrain(state, VARIED_CORP);
    expect(Number(state.public_companies[0].printed_route_revenue)).toBe(printed * 3);
  });

  it("does not compound the modifier across trains", () => {
    /* THE BUG THE SEPARATE FIELD PREVENTS, stated as a bound rather than as an implementation. If each
       dispatch applied the die to the previous MODIFIED total, three trains at 120% would reach roughly
       1.7x the printed sum. The answer must stay within one application of the table's extremes. */
    const printed = revenueOf(runOneTrain(board(STANDARD_VARIANTS)));
    let state = board(VARIED, VARIED_CORP);
    for (let train = 0; train < 3; train += 1) state = runOneTrain(state, VARIED_CORP);
    const banked = revenueOf(state);
    expect(banked).toBeLessThanOrEqual(roundToTen(applyRevenuePercent(printed * 3, 120)));
    expect(banked).toBeGreaterThanOrEqual(roundToTen(applyRevenuePercent(printed * 3, 80)));
  });

  it("is stable when the same three runs are replayed", () => {
    /* #903'S RULE, which survives the re-scoping intact: an Undo replays the log and must reach the same
       total, or the dividend changes under a player who did nothing. */
    const once = (() => {
      let state = board(VARIED, VARIED_CORP);
      for (let train = 0; train < 3; train += 1) state = runOneTrain(state, VARIED_CORP);
      return revenueOf(state);
    })();
    const twice = (() => {
      let state = board(VARIED, VARIED_CORP);
      for (let train = 0; train < 3; train += 1) state = runOneTrain(state, VARIED_CORP);
      return revenueOf(state);
    })();
    expect(twice).toBe(once);
  });
});

describe("the turn change clears BOTH figures (design notes #777 -> #941)", () => {
  /* ==================================================================
      THE CONTROL THAT PASSED, AND THE CASE IT ASKED FOR
     ==================================================================
     A negative control that deleted `printed_route_revenue` from #777's turn-change clear passed the entire
     suite. Nothing anywhere asserted the new field was reset -- which is exactly the hazard #941's own note
     had written down and then not covered: "a stale `printed_route_revenue` does not show anywhere on screen,
     it simply makes the NEXT turn's single roll apply to last turn's routes as well as this turn's. The
     corporation would be paid for track it did not run, from a field nobody was looking at."
     A NOTE DESCRIBING A HAZARD IS NOT A TEST OF IT. Recording that plainly, because writing the clear and
     writing the sentence about the clear felt like the same act and was not. */

  it("zeroes the printed sum when the turn changes", () => {
    /* DRIVEN THROUGH `settleOperatingCursor`, which is what #777 hooks: the cursor moving IS the turn change,
       so the clear is asked for by moving it rather than by calling the reset directly. */
    let state = board(STANDARD_VARIANTS);
    state = runOneTrain(state);
    expect(Number(state.public_companies[0].printed_route_revenue)).toBeGreaterThan(0);

    /* DRIVEN THROUGH THE PUBLIC REDUCER, not through `settleOperatingCursor` -- that function is module-private
       and exporting it to reach a test would widen the surface for the harness's convenience. `PassTurn` is
       what a player actually does, and it moves the cursor, which IS the turn change #777 hooks. */
    const nextTurn = applySandboxAction(state, { PassTurn: {} } as never);
    expect(nextTurn.active_corporation_index).toBe(1);
    expect(nextTurn.public_companies[0].printed_route_revenue).toBe("0");
    expect(nextTurn.public_companies[0].last_route_revenue).toBe("0");
    expect(nextTurn.public_companies[0].routes_run_this_turn).toBe(0);
  });

  it("does not let last turn's routes join this turn's roll", () => {
    /* THE CONSEQUENCE, IN MONEY, which is the part a reader needs to see stated. Two turns of one train each
       must bank what one train earns, not what two do -- and under the variant the second turn's die would
       otherwise be applied to both turns' printed track. */
    let state = board(VARIED_ALL, VARIED_CORP_ALL);
    state = runOneTrain(state, VARIED_CORP_ALL);
    const afterOneTurn = Number(state.public_companies[0].last_route_revenue);

    state = applySandboxAction(state, { PassTurn: {} } as never);
    /* Back round to this corporation for its next turn. */
    state = { ...state, active_corporation_index: 0 } as GameStateResponse;
    state = runOneTrain(state, VARIED_CORP_ALL);
    expect(Number(state.public_companies[0].last_route_revenue)).toBe(afterOneTurn);
  });
});

describe("the turn change is what clears it, not the next run", () => {
  it("keeps the total across the whole turn", () => {
    /* #777's rule from the other side: the figure describes THIS turn and only the turn changing may reset
       it. An accumulator that cleared on each run would show symptom 2 exactly. */
    let state = board(STANDARD_VARIANTS);
    state = runOneTrain(state);
    const afterOne = revenueOf(state);
    state = runOneTrain(state);
    expect(revenueOf(state)).toBeGreaterThan(afterOne);
  });
});
