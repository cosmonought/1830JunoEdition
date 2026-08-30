/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 968 (harness): ONE MESSAGE, AND WHY THAT IS THE FIX
// ==================================================================
//
// REPORTED, with the diagnostic detail that finally located it: a LIVE ROOM, three trains on one turn and
// four on another, only one paying out, submitted through the one button that exists.
//
// THE LOOP WAS THE CAUSE AND I HAD BEEN LOOKING AROUND IT FOR THREE BATCHES. Each `RunManualRoute` appended
// at `appliedIndexRef.current`, and the snapshot handler REASSIGNS that ref from the last action it can see
// -- so a snapshot carrying only the first append rewinds the cursor while the rest are in flight, and they
// land on an index already taken. `effectiveActions` keys on `index`.
//
// WHAT THESE CASES CAN AND CANNOT SHOW. They drive the reducer, which is where the aggregation now happens,
// and they pin the dispatch's shape in the shell's source. They CANNOT exercise Firestore, so the claim
// "this resolves it in a live room" rests on the argument rather than on a run: with one action there is no
// second index to collide with, no ordering between appends, and no window for a snapshot to land inside.
// That is a structural guarantee, and it is worth separating from the things below that are demonstrated.

import { applySandboxAction } from "./sandboxSession";
import { describeGameplayAction } from "./actionLog";
import { dividendDeclaration } from "./dividendStep";
import {
  applyRevenuePercent,
  REVENUE_MODIFIER_BY_FACE,
  revenueDieFace,
  roundToTen,
  STANDARD_VARIANTS,
} from "./gameVariants";
import type { GameStateResponse } from "./gameState";
import { readStripped, sliceBetween } from "./sourceScan";

const BO = 6;
const TURN = { macroRound: 3, subRound: 1, companyId: BO };
const LEG = [{ hex: "F2" }, { hex: "A9" }];

const board = (unpredictable = true): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_sub_phase: "Routes",
    active_operating_order: [BO, 7],
    active_corporation_index: 0,
    player_addresses: ["p1"],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    private_companies: [],
    variants: { ...STANDARD_VARIANTS, unpredictableRevenue: unpredictable },
    public_companies: [
      { company_id: BO, ticker: "B&O", last_route_revenue: "0", owned_trains: ["4", "4", "4", "4"] },
      { company_id: 7, ticker: "XX", last_route_revenue: "0", owned_trains: ["2"] },
    ],
  }) as unknown as GameStateResponse;

const runBulk = (state: GameStateResponse, count: number) =>
  applySandboxAction(state, {
    RunMultipleRoutes: {
      protocol_id: BO,
      routes: Array.from({ length: count }, () => LEG),
    },
  } as never);

const runSingle = (state: GameStateResponse) =>
  applySandboxAction(state, { RunManualRoute: { protocol_id: BO, path: LEG } } as never);

describe("the whole turn arrives in one transition (design note #968)", () => {
  it("uses a turn whose die actually moves the figure", () => {
    /* THE FIXTURE GUARD, learned in Batch 15: a corporation seeded to a 100% face makes every case below
       compare the identity function with itself. */
    expect(REVENUE_MODIFIER_BY_FACE[revenueDieFace(TURN) - 1]).not.toBe(100);
  });

  it("banks every route in the payload", () => {
    /* THE REPORTED TURN. Three routes in one message; the printed sum must be three legs, not one. */
    const oneLeg = Number(runBulk(board(), 1).public_companies[0].printed_route_revenue);
    const three = runBulk(board(), 3);
    expect(Number(three.public_companies[0].printed_route_revenue)).toBe(oneLeg * 3);
  });

  it("pays out the aggregate, not one route", () => {
    /* "In both cases, only 1 train's revenue actually paid out." Driven end to end into the real Dividends
       step, with the expected figure composed from the same two functions the reducer composes. */
    const oneLeg = Number(runBulk(board(), 1).public_companies[0].printed_route_revenue);
    const four = runBulk(board(), 4);
    const percent = REVENUE_MODIFIER_BY_FACE[revenueDieFace(TURN) - 1];
    const expected = roundToTen(applyRevenuePercent(oneLeg * 4, percent));

    expect(Number(four.public_companies[0].last_route_revenue)).toBe(expected);
    expect(
      dividendDeclaration({
        lastRouteRevenue: four.public_companies[0].last_route_revenue,
        committedRevenue: null,
        skippedRoutes: false,
      }).revenue,
    ).toBe(expected);
  });

  it("counts the routes, not the messages", () => {
    /* `routes_run_this_turn` feeds the log and #777's turn-change clear. A four-train turn that arrived as
       one message still ran four trains. */
    expect(runBulk(board(), 4).public_companies[0].routes_run_this_turn).toBe(4);
  });

  it("reaches the same total the old per-route path did", () => {
    /* THE EQUIVALENCE THAT MAKES THIS A DISPATCH CHANGE RATHER THAN A RULES CHANGE. Four separate messages
       and one message of four routes must bank the same figure -- if they differ, the bulk arm is a second
       implementation of the pricing rather than the same one gathered. */
    let sequential = board();
    for (let route = 0; route < 4; route += 1) sequential = runSingle(sequential);
    const atomic = runBulk(board(), 4);
    expect(Number(atomic.public_companies[0].last_route_revenue)).toBe(
      Number(sequential.public_companies[0].last_route_revenue),
    );
    expect(Number(atomic.public_companies[0].printed_route_revenue)).toBe(
      Number(sequential.public_companies[0].printed_route_revenue),
    );
  });

  it("rolls the die once, on the sum", () => {
    /* #941'S RULE, re-asked through the new arm: the payout must be the die applied to the WHOLE printed
       total, not four separately-modified figures added up -- which round differently. */
    const oneLeg = Number(runBulk(board(), 1).public_companies[0].printed_route_revenue);
    const percent = REVENUE_MODIFIER_BY_FACE[revenueDieFace(TURN) - 1];
    const perRouteThenSummed = roundToTen(applyRevenuePercent(oneLeg, percent)) * 4;
    const onTheSum = roundToTen(applyRevenuePercent(oneLeg * 4, percent));
    const banked = Number(runBulk(board(), 4).public_companies[0].last_route_revenue);
    expect(banked).toBe(onTheSum);
    /* Stated only when the two genuinely differ -- on some figures they coincide, and asserting a difference
       that the arithmetic does not produce would be a flaky case by construction. */
    if (perRouteThenSummed !== onTheSum) expect(banked).not.toBe(perRouteThenSummed);
  });

  it("leaves a standard game unmodified", () => {
    /* No variant, no die: the banked figure is exactly the printed sum. */
    const four = runBulk(board(false), 4);
    expect(four.public_companies[0].last_route_revenue).toBe(
      four.public_companies[0].printed_route_revenue,
    );
  });

  it("advances the cursor to Dividends", () => {
    /* The revenue has been computed and the choice of what to do with it is the next step. Omitting this arm
       would leave the cursor on Routes after a turn that had run -- the one state the Dividends controls do
       not render in. */
    expect(runBulk(board(), 3).operating_sub_phase).toBe("Dividends");
  });

  it("adds to a total already standing rather than replacing it", () => {
    /* The UI does not offer a second run in one turn, but the reducer must not silently discard a prior
       total if it ever does -- #777's turn-change clear is what bounds this, not an assumption about the
       caller. */
    const first = runBulk(board(), 2);
    const twice = runBulk(first, 2);
    expect(Number(twice.public_companies[0].printed_route_revenue)).toBe(
      Number(first.public_companies[0].printed_route_revenue) * 2,
    );
    expect(twice.public_companies[0].routes_run_this_turn).toBe(4);
  });

  it("still replays a log full of the old message", () => {
    /* #902'S RULE: an old log replays to the game it was played as. Every game already recorded contains
       `RunManualRoute` entries, so that arm is kept rather than migrated away. */
    let state = board();
    for (let route = 0; route < 3; route += 1) state = runSingle(state);
    expect(Number(state.public_companies[0].last_route_revenue)).toBeGreaterThan(0);
    expect(state.public_companies[0].routes_run_this_turn).toBe(3);
  });
});

describe("the shell sends one action (design note #968)", () => {
  const APP = readStripped("App.tsx");
  const block = sliceBetween(APP, "const runnable = runnableDrafts(", "setLiveOrSubPhase(");

  it("dispatches the bulk message", () => {
    /* Design note #1020: `turnRoutes` is now an array of `{ train, path }` rather than of bare paths, so the
       message names which train ran which route. #968's ruling -- ONE action for the turn, carrying every
       route -- is untouched and is what the two cases below still check. */
    expect(block).toContain('runGameplayAction("RunMultipleRoutes"');
    expect(block).toContain("routes: turnRoutes.map((entry) => entry.path),");
    expect(block).toContain("trains: turnRoutes.map((entry) => entry.train),");
  });

  it("no longer loops a dispatch per draft", () => {
    /* THE CAUSE, AS AN ABSENCE. Scanned on a comment-stripped copy (#490a) so #968's own note explaining the
       removal cannot satisfy the search. */
    expect(block).not.toContain("for (const draft of runnable)");
    expect(block).not.toContain('runGameplayAction(\n        "RunManualRoute"');
  });

  it("sends exactly one action for the turn", () => {
    /* THE WHOLE POINT, counted. Two dispatches in this block is the race back, whatever they carry. */
    expect(block.match(/await runGameplayAction\(/g)?.length ?? 0).toBe(1);
  });

  it("keeps the per-route bypass marking", () => {
    /* #808: whether a hex must be crossed on a bow is a fact about each route's own path, and the reducer
       prices what it is given. Gathering the DISPATCH does not gather the pricing. */
    expect(block).toContain("withForcedBypass(");
    /* Design note #1020: the points are named `entry.points` now that each route travels beside its train.
       The RULE is unchanged -- every route is bypass-marked individually before it is converted -- and this
       asserts the conversion still happens per route rather than once over a flattened list. */
    expect(block).toContain("routePointsToWaypoints(entry.points)");
  });

  it("builds the payload from the draft STATE, not from the mirror of it", () => {
    /* Design note #1020, and the reason this batch exists: `runnable` is derived from `trainDrafts` -- a memo
       over `routeDrafts` -- while the points came from `routeDraftsRef.current`, written by an effect one
       commit later. A train the memo could see and the ref could not resolved to `[]` and was dropped by the
       two-point guard below, so a two-train turn banked one train's revenue. */
    expect(block).toContain("routeDrafts[draft.trainIndex] ?? []");
    expect(block).not.toContain("routeDraftsRef.current[draft.trainIndex]");
  });

  it("still drops a draft that resolves to fewer than two points", () => {
    /* The guard the loop had, kept: sending it would have the reducer price an empty path at zero and count
       a route that did not run. */
    expect(block).toContain("entry.points.length >= 2");
  });

  it("sends nothing when nothing survives the marking", () => {
    /* An empty `routes` array would advance the cursor past Routes for a turn that ran nothing. */
    expect(block).toContain("if (turnRoutes.length > 0)");
  });
});

describe("the log describes the bulk message (design note #968)", () => {
  const line = (count: number) =>
    describeGameplayAction(
      {
        RunMultipleRoutes: {
          protocol_id: BO,
          routes: Array.from({ length: count }, () => LEG),
        },
      } as never,
      {
        gameState: board(),
        mapGrid: { hexes: [] } as never,
        era: "yellow" as never,
        labelForAddress: (address: string) => address,
      } as never,
    ) ?? "";

  it("reads as one route when there is one", () => {
    /* A corporation with a single train is the common case for most of a game, and "ran 1 routes" would be a
       worse sentence than the one this replaces. */
    expect(line(1)).toMatch(/^B&O ran a \$\d+ route with a 4-train through F2 -> A9\.$/);
  });

  it("names the count and the total for several", () => {
    expect(line(3)).toMatch(/^B&O ran 3 routes for \$\d+/);
  });

  it("totals the routes rather than quoting one", () => {
    /* THE FAILURE THIS CATCHES is the sentence describing the payload's first entry and calling it the turn
       -- which is the reported bug wearing a different hat. */
    const one = Number(line(1).match(/\$(\d+)/)?.[1]);
    const three = Number(line(3).match(/\$(\d+)/)?.[1]);
    expect(three).toBe(one * 3);
  });

  it("says nothing about the die", () => {
    /* #941: the modifier is a fact about the TURN and is stated once, by `turnRevenueSentence`. This line is
       the record of which track was run. */
    for (const text of [line(1), line(3)]) {
      expect(text).not.toContain("bonus");
      expect(text).not.toContain("malus");
    }
  });

  it("is undoable by name", () => {
    /* Every message the shell can send needs an Undo noun, or the confirm reads "undo the last undefined". */
    expect(readStripped("App.tsx")).toContain('RunMultipleRoutes: "the last set of routes"');
  });
});
