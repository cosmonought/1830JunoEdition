/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 934 + 935 (harness): THE TWO PLACES A MULTI-TRAIN TURN LOST ITS MONEY
// ==================================================================
//
// `multiTrainRun.test.ts` established that the REDUCER is not the bug -- three sequential `RunManualRoute`
// dispatches accumulate to the full total and roll a die per train. This file covers the two surfaces
// DOWNSTREAM of it that were reporting a different number than the one the reducer banked:
//
//   #934  the Dividends step, which preferred a total read before the runs had landed
//   #935  the Activity Log line, which quoted the printed figure while the reducer banked the modified one
//
// BOTH ARE THE SAME SHAPE AS #917, which is the reason to record them together: a figure derived where it
// was convenient instead of read from the authority that owns it. #917 fixed one instance and I reported the
// area healthy; these are two more of it, in the same turn.

import { dividendDeclaration } from "./dividendStep";
import { describeGameplayAction } from "./actionLog";
import { STANDARD_VARIANTS } from "./gameVariants";
import type { GameStateResponse } from "./gameState";

describe("the dividend spends the reducer's own total (design note #934)", () => {
  /* ==================================================================
      THE FIRST FIX I WROTE FOR THIS, AND WHY IT IS NOT THE ONE THAT SHIPPED
     ==================================================================
     REPORTED: "three trains for $50 each (total $150) ... The Dividends phase only paid out $50 total."
     THE CAUSE IS A CLOCK, NOT A CALCULATION. In a sandbox room the shell appends each `RunManualRoute` to the
     log and returns; the reducer runs from the snapshot afterwards. The shell then read `last_route_revenue`
     the instant the loop finished, caught the one run that had landed, and committed $50 -- and
     `dividendDeclaration` preferred that commitment over the field, so it CAPPED the payout.
     MY FIRST FIX TOOK THE LARGER OF THE TWO. It repaired the reported turn, and it broke four unrelated cases
     in `dividendStep.test.ts` -- among them #492's committed zero, which exists precisely to stop a
     corporation declaring money for a run that did not happen. Recorded because the failures were the useful
     part: reconciling two authorities with an arithmetic tiebreak is the shape this project keeps finding
     bugs in, and the four tests that caught it were right to.
     SO THE COMMITMENT WAS REMOVED INSTEAD, at the call site, and `dividendStep` is untouched. Its rules are
     unchanged and its own suite still governs them; what changed is that the shell no longer has a racing
     figure to hand it. These cases assert the behaviour the Dividends step now sees. */

  it("pays the full multi-train total from the field", () => {
    /* THE REPORTED TURN, as the step now receives it: no commitment, and a field the reducer has finished
       accumulating by the time the player declares. */
    const declaration = dividendDeclaration({
      lastRouteRevenue: "150",
      committedRevenue: null,
      skippedRoutes: false,
    });
    expect([declaration.revenue, declaration.perShare]).toEqual([150, 15]);
  });

  it("is not capped by however many snapshots had landed", () => {
    /* THE REGRESSION, STATED AS THE THING THAT MUST NOT COME BACK. A commitment of $50 beside a field of $150
       is exactly the mid-flight read, and the only reason it cannot arise now is that nothing constructs one
       -- which `variantWiring.test.ts` asserts against the shell's source. This case pins the consequence:
       were a commitment to reappear, the step would still prefer it, and the payout would still be a third of
       the run. It is a live rule of `dividendDeclaration`, not a dead one. */
    expect(
      dividendDeclaration({
        lastRouteRevenue: "150",
        committedRevenue: 50,
        skippedRoutes: false,
      }).revenue,
    ).toBe(50);
  });

  it("still refuses to pay for a turn that skipped Routes", () => {
    /* #486, and the reason removing the commitment is safe: with no commitment the skip inference decides,
       and it must keep deciding. `routesRunThisTurn` is what supplies this flag, and it is the half of #492
       the shell still records. */
    expect(
      dividendDeclaration({
        lastRouteRevenue: "150",
        committedRevenue: null,
        skippedRoutes: true,
      }).revenue,
    ).toBe(0);
  });

  it("pays a corporation that ran and earned nothing exactly nothing", () => {
    /* THE CASE #492'S CACHE EXISTED FOR, reached without it: every route was worth $0, the corporation did
       not skip, and #777 has cleared the field. The answer is $0 from the field rather than $0 from a
       commitment -- same result, one authority. */
    const declaration = dividendDeclaration({
      lastRouteRevenue: "0",
      committedRevenue: null,
      skippedRoutes: false,
    });
    expect([declaration.revenue, declaration.mustWithhold]).toEqual([0, true]);
  });
});

// ==================================================================

const BO = 4;

const logContext = (variants: typeof STANDARD_VARIANTS, routesRun: number) => ({
  gameState: {
    macro_round_number: 3,
    sub_round_index: 1,
    current_round_type: "OperatingRound",
    active_operating_order: [BO],
    active_corporation_index: 0,
    player_addresses: ["p1"],
    active_player_index: 0,
    variants,
    public_companies: [
      {
        company_id: BO,
        ticker: "B&O",
        owned_trains: ["4"],
        routes_run_this_turn: routesRun,
        station_token_hexes: [],
      },
    ],
  } as unknown as GameStateResponse,
  mapGrid: { hexes: [] } as never,
  era: "yellow" as never,
  labelForAddress: (address: string) => address,
});

/* A ROUTE THAT ACTUALLY PRICES. `sandboxRouteBreakdown` reads the board, and the first draft of this file
   passed `path: []` -- which prices at $0, and $0 is unmoved by every modifier, so the varied cases were
   vacuous and said so by failing. These two are OFF-BOARD terminals, valued from the era table by name
   rather than from a laid tile, so they total $70 with no map fixture to build. */
const PRICED_ROUTE = [{ hex: "F2" }, { hex: "A9" }];

const runLine = (variants: typeof STANDARD_VARIANTS, routesRun: number) =>
  describeGameplayAction(
    { RunManualRoute: { protocol_id: BO, path: PRICED_ROUTE } } as never,
    logContext(variants, routesRun) as never,
  ) ?? "";

describe("the run line reports what was earned (design notes #935 -> #939 -> #941)", () => {
  /* ==================================================================
      SUPERSEDED TWICE, AND BOTH MOVES ARE RECORDED RATHER THAN DELETED
     ==================================================================
     #935 fixed a real fault -- the log quoted the PRINTED figure while the reducer banked the modified one --
     and pinned it with:
         expect(line).toContain("B&O ran a $");
         expect(line).toMatch(/ran a \$\d+ route \(printed \$\d+\)/);
     #939 REPLACED THE PARENTHETICAL WITH PROSE, reported as "developer debug text", and this block became two
     cases asserting every amount on the line was a multiple of ten.
     #941 MOVED THE MONEY OFF THIS LINE ENTIRELY. The die is now one roll per TURN, so the per-route sentence
     went back to being factual -- it names the track and the board's printed figure, and says nothing about
     the die. Those amounts are therefore NOT multiples of ten, and should not be: a route's printed value is
     whatever the hexes total.
     WHERE THE RULES LIVE NOW: `revenueRounding.test.ts` governs both halves -- "the turn's one line reads as
     prose" for the consolidated sentence, and "the per-route line went back to being factual" for this one.
     Nothing is left unasserted; this block is a signpost, and keeping it is cheaper than the next reader
     rediscovering why the assertion they remember is gone. */

  it("still names the track it ran", () => {
    /* THE ONE THING THIS LINE IS UNIQUELY PLACED TO SAY, and the reason it survives at all. */
    expect(runLine(STANDARD_VARIANTS, 0)).toContain("through F2 -> A9");
  });
});
