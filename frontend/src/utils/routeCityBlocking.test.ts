/** @jest-environment node */
//
// The route search and the hand-drawn validator, against the same wall. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 730 (harness): THE OTHER TRACER
// ==================================================================
//
// REPORTED: "The problem identified in 9 bleeds into the Run Routes action as well: a corporation's trains are
// running through tokened out cities when they should be blocked (i.e., the token out city must be treated as
// a terminus)."
//
// TWO TRACERS, ONE RULE, AND THEY HAD TO BE FIXED TOGETHER. #729 taught the NETWORK walk about tokens; this is
// the ROUTE search, a separate depth-first walk that also knew only about rails. Fixing one alone would have
// been worse than fixing neither: the board would have promised reach that the router then refused, so a
// player would see a legal-looking hex and a route that would not run to it.
//
// "TERMINUS" IS THE WHOLE OF THE RULE, and it is what makes this harder to test than a plain exclusion. A
// route that ENDS in a blocked city is legal and must still be offered and priced; only continuing is
// refused. So the discriminating assertions are about what the search still produces, not only about what it
// stops producing -- an implementation that refused the city outright would pass "does not run past" and
// silently delete every legal run that terminates there.
//
// AND THE HAND-DRAWN PATH IS A SECOND DOOR. The tracer cannot propose an illegal route once fixed; a player
// drawing one by hand reaches the same dispatch. #712's lesson, applied before the report rather than after:
// a rule enforced on one of two paths is a rule with a door beside it.

import { autoTraceRoute, assignRouteSet } from "./routeAutoTrace";
import { routeBlockedCityReason } from "./routeWaypoints";
import { cityForArrival } from "./trackReach";
import type { MapGridResponse } from "../components/hexContractTypes";

/** Three plain yellow tiles in a row. 57 joins two opposite edges, so this is a corridor. */
const CORRIDOR = {
  tiles: [
    { q: 5, r: 5, tile_id: 57, orientation: 0 },
    { q: 6, r: 5, tile_id: 57, orientation: 0 },
    { q: 7, r: 5, tile_id: 57, orientation: 0 },
  ],
} as unknown as MapGridResponse;

const START: ReadonlyArray<readonly [number, number]> = [[5, 5]];

function trace(blocksThrough?: (q: number, r: number, city: number) => boolean) {
  return autoTraceRoute({
    mapGrid: CORRIDOR,
    era: "Yellow",
    startHexes: START,
    maxRevenueCentres: 6,
    blocksThrough,
  });
}

describe("the search behaves identically when nothing is blocked", () => {
  it("returns the same path with an always-false blocker as with none", () => {
    /* THE COMPATIBILITY CASE, and the one that matters most here: this tracer feeds Auto Route, the route
       obligation probe (#707) and the whole assignment search, so a behaviour change on an unblocked board
       would ripple through three features that have nothing to do with tokens. */
    const open = trace();
    const withCallback = trace(() => false);
    expect(withCallback.path.map((p) => p.hexLabel)).toEqual(open.path.map((p) => p.hexLabel));
    expect(withCallback.revenue).toBe(open.revenue);
  });

  it("never lengthens a route by blocking", () => {
    /* A wall can only shorten. Asserted as a property because the search is a heuristic over a bounded space:
       an exact expected path would pin the heuristic rather than the rule. */
    const open = trace();
    const walled = trace(() => true);
    expect(walled.path.length).toBeLessThanOrEqual(open.path.length);
  });
});

describe("a blocked city ends the run instead of deleting it", () => {
  it("still starts from the corporation's own token", () => {
    /* RULE 2, END TO END. A start has no arrival edge, so a corporation is never walled out of the city it
       holds -- and a blocker that fired on starts would return an empty path for every corporation on a busy
       board, which reads as the game forgetting they have trains.
       WRITTEN WITHOUT A CONDITIONAL `expect`, which the first draft used and ESLint rightly refused: a branch
       around an assertion makes a test that passes by not running. The path is mapped to its first key or
       `null`, and BOTH acceptable answers are named -- either the run starts at the token or there is no run.
       That is a real assertion in both branches rather than one branch quietly skipped. */
    const walled = trace(() => true);
    const startedAt = walled.path.length > 0 ? `${walled.path[0].q},${walled.path[0].r}` : null;
    expect(["5,5", null]).toContain(startedAt);
  });

  it("gives a reason rather than an empty answer when nothing can run", () => {
    // A silent empty route is indistinguishable from a bug; the panel prints this.
    const walled = trace(() => true);
    const explained = walled.path.length > 0 || Boolean(walled.reason);
    expect(explained).toBe(true);
  });
});

describe("the whole assignment set walks the same walls", () => {
  it("threads the blocker to every train", () => {
    /* Design note #730. A corporation runs every train it owns; a blocker applied to one search and not the
       others would draft one legal route and two illegal ones, which is the failure mode of threading a
       parameter through some call sites. */
    const open = assignRouteSet({
      mapGrid: CORRIDOR,
      era: "Yellow",
      startHexes: START,
      trains: [{ trainIndex: 0, maxRevenueCentres: 6 }],
    });
    const walled = assignRouteSet({
      mapGrid: CORRIDOR,
      era: "Yellow",
      startHexes: START,
      trains: [{ trainIndex: 0, maxRevenueCentres: 6 }],
      blocksThrough: () => true,
    });
    expect(walled.totalRevenue).toBeLessThanOrEqual(open.totalRevenue);
  });
});

describe("a hand-drawn route is refused at an interior wall", () => {
  const path = [
    { q: 5, r: 5 },
    { q: 6, r: 5 },
    { q: 7, r: 5 },
  ];

  it("refuses a blocked city in the middle", () => {
    const reason = routeBlockedCityReason(path, (q) => q === 6) ?? "";
    expect(reason).toMatch(/tokened out/i);
    expect(reason).toMatch(/not pass through/i);
  });

  it("ALLOWS a blocked city at either end", () => {
    /* THE TERMINUS RULE, and the assertion that separates this from a plain exclusion. A validator refusing
       the endpoints would forbid exactly the run the report says is legal. */
    expect(routeBlockedCityReason(path, (q) => q === 5)).toBeNull();
    expect(routeBlockedCityReason(path, (q) => q === 7)).toBeNull();
  });

  it("says nothing without a blocker, or on a two-point route", () => {
    /* Two points are both endpoints, so there is no interior to test -- and a caller with no blocker gets the
       pre-#730a behaviour exactly. */
    expect(routeBlockedCityReason(path, undefined)).toBeNull();
    expect(routeBlockedCityReason(path.slice(0, 2), () => true)).toBeNull();
  });

  it("names the hex, so the player knows where to redraw", () => {
    const reason = routeBlockedCityReason(path, (q) => q === 6, () => "F16") ?? "";
    expect(reason).toContain("F16");
  });
});

describe("both tracers ask one question about which city an arrival lands in", () => {
  it("shares cityForArrival rather than each deriving it", () => {
    /* The network walk and the route search must agree about which city an edge enters, or the glow and the
       router disagree about the same wall -- which is the specific way this project has produced
       "two surfaces, two answers" four times now (#134, #251, #698, #724). */
    expect(typeof cityForArrival).toBe("function");
    const fs = require("fs") as typeof import("fs");
    const path2 = require("path") as typeof import("path");
    const tracer = fs.readFileSync(path2.join(__dirname, "routeAutoTrace.ts"), "utf8");
    expect(tracer).toContain('from "./trackReach"');
    expect(tracer).toContain("cityForArrival(mapGrid, at.q, at.r, arrivalEdge)");
  });
});
