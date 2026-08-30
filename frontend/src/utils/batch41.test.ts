/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1022 (harness): ONE HEX, TWO CITIES, TWO ANSWERS
// ==================================================================
//
// REPORTED: "The auto-router correctly routes a D-train through an empty city in a Brown OO hex (E11).
// However, because the other city in that same hex has a rival station, clicking 'Run Routes' throws an error
// claiming the hex is tokened out, blocking the legal run."
//
// THE ASYMMETRY IS THE SUBJECT, so the cases below assert the two walks TOGETHER wherever they can: what the
// router offers and what the validator accepts, over one board. A test of either alone would have passed
// throughout the bug -- each was internally consistent, and the report is about the gap between them.
//
// E11 IS THE REAL HEX, from `hexBoardData`: ERIE's home, an OO pair whose two cities do not share a spur
// (`hexBoardData` #391). A synthetic two-city tile would prove the mechanism and miss the board the report
// names.

export {};

const { routeBlockedCityReason } =
  require("./routeWaypoints") as typeof import("./routeWaypoints");
const { cityEnteredFrom, cityForArrival } =
  require("./trackReach") as typeof import("./trackReach");
const { cityBlockerFor } = require("./cityBlocking") as typeof import("./cityBlocking");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

/** The reported hex and its neighbours, FOUND rather than typed -- #686's rule. */
const E11 = STATIC_BOARD_HEXES.find((hex) => hex.label === "E11")!;

/* A two-city tile laid on E11, with a straight through each city. Tile 15 carries one 2-slot city and four
   spokes; what this fixture needs is only that `citySlotsAt` answers for two distinct indices, which the
   injected slot resolver below supplies directly -- the blocking rule takes its counts from the caller
   (`cityBlocking` #729), so the fixture states them rather than deriving them from artwork. */
const BOARD = { game_id: 1, tiles: [] } as never;

const OTHER = 4;
const MINE = 6;

/** `cityBlocking`'s real predicate, bound to a board where city 0 of E11 is full of a rival's tokens and city
 *  1 is empty. Two slots each, so "full" means one rival token in a one-slot city. */
const blocksThrough = cityBlockerFor({
  actingCompanyId: MINE,
  companies: [{ company_id: OTHER, station_token_hexes: [[E11.q, E11.r]] }],
  slotsAt: () => 1,
  // The rival's token sits in city 0. City 1 is the empty one the route uses.
  cityOf: () => 0,
});

const at = (q: number, r: number) => ({ q, r });

describe("the blocking rule itself distinguishes the two cities", () => {
  /* THE FIXTURE'S OWN ASSUMPTION. Every case below is vacuous if the predicate answers the same for both
     cities -- and a vacuous pass is this project's most frequent failure. */
  it("shuts the tokened city and leaves the empty one open", () => {
    expect(blocksThrough(E11.q, E11.r, 0)).toBe(true);
    expect(blocksThrough(E11.q, E11.r, 1)).toBe(false);
  });
});

describe("the submit validator judges the city the route enters", () => {
  /* A three-point route: in from one neighbour, across E11, out to another. `routeBlockedCityReason` only
     inspects INTERIOR points, which is 1830's rule -- a train may end its run in a city it cannot cross. */
  const throughE11 = [
    at(E11.q + 1, E11.r),
    at(E11.q, E11.r),
    at(E11.q - 1, E11.r),
  ];

  it("refuses when the route enters the tokened city", () => {
    /* THE RULE THAT MUST SURVIVE THE FIX. A node-level check that stopped refusing anything would pass every
       "does not block" case in this file, which is why this one comes first. */
    const reason = routeBlockedCityReason(
      throughE11,
      blocksThrough,
      () => E11.label,
      undefined,
      () => 0,
    );
    expect(reason).toMatch(/tokened out/);
  });

  it("allows the same route when it enters the empty city", () => {
    // THE REPORT. Same hex, same rival token, different circle -- and the run is legal.
    const reason = routeBlockedCityReason(
      throughE11,
      blocksThrough,
      () => E11.label,
      undefined,
      () => 1,
    );
    expect(reason).toBeNull();
  });

  it("refused it before the resolver was injected", () => {
    /* THE BUG, PRESERVED AS A CASE. Omitting `cityEnteredFrom` is the pre-#1022 code path: both cities are
       asked and either one shuts the hex. Asserted so the fallback is a DECISION rather than an accident, and
       so a later reader can see exactly what changed. */
    const reason = routeBlockedCityReason(throughE11, blocksThrough, () => E11.label);
    expect(reason).toMatch(/tokened out/);
  });

  it("keeps refusing a single-city hex that is genuinely shut", () => {
    /* THE REGRESSION THIS FIX COULD MOST EASILY HAVE CAUSED. On a hex with one city, `cityForArrival` answers
       `0` and the check is the same one it always was -- a node-level rule must not become a no-op for the
       ordinary case it was already getting right. */
    const oneCity = cityBlockerFor({
      actingCompanyId: MINE,
      companies: [{ company_id: OTHER, station_token_hexes: [[2, 7]] }],
      slotsAt: (q, r, city) => (q === 2 && r === 7 && city === 0 ? 1 : 0),
      cityOf: () => 0,
    });
    const reason = routeBlockedCityReason(
      [at(3, 7), at(2, 7), at(1, 7)],
      oneCity,
      () => "H12",
      undefined,
      () => 0,
    );
    expect(reason).toMatch(/tokened out/);
  });

  it("still lets a bypass clear the hex before any city is asked", () => {
    /* #808's RULE, UNTOUCHED. A bow goes around the centre, so a full city has nothing to say about it -- and
       the bypass is checked before the city precisely because it clears the HEX rather than one circle. */
    const reason = routeBlockedCityReason(
      throughE11,
      blocksThrough,
      () => E11.label,
      () => true,
      () => 0,
    );
    expect(reason).toBeNull();
  });
});

describe("the resolver is the one the router already uses", () => {
  it("wraps cityForArrival rather than deriving a second answer", () => {
    /* THE REPORT'S SECOND ITEM. "Ensure that the auto-router and the submission validator import and utilize
       the exact same helper" -- in this codebase that helper is `cityForArrival`, which `reachableTrack` and
       the route tracer have both asked since #729. `cityEnteredFrom` converts a PREVIOUS POINT into the
       arrival edge that function wants and then calls it; it does not reimplement it. */
    expect(readStripped("utils/trackReach.ts")).toContain(
      "return cityForArrival(mapGrid, hex.q, hex.r, arrivalEdge);",
    );
  });

  it("agrees with cityForArrival on every edge of a hex", () => {
    /* Asserted as a JOIN over all six edges rather than as a source string, so the two cannot drift: whatever
       `cityForArrival` says about an arrival, `cityEnteredFrom` says about the point it came from. */
    const offsets = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ];
    for (let edge = 0; edge < 6; edge += 1) {
      const from = at(E11.q + offsets[edge][0], E11.r + offsets[edge][1]);
      expect(cityEnteredFrom(BOARD, at(E11.q, E11.r), from)).toBe(
        cityForArrival(BOARD, E11.q, E11.r, edge),
      );
    }
  });

  it("declines to name a city for a point that is not adjacent", () => {
    /* A DRAFTED ROUTE CAN CONTAIN A JUMP -- the drawing surface does not enforce adjacency -- and `-1` handed
       to `cityForArrival` would index nothing and read as "plain track", which is the permissive answer to a
       question nobody asked. `null` sends the caller to the conservative test instead. */
    expect(cityEnteredFrom(BOARD, at(E11.q, E11.r), at(E11.q + 5, E11.r + 5))).toBeNull();
  });

  it("is what the shell passes to the validator", () => {
    /* #1006's LESSON, one batch old: a correct predicate that the deciding caller never asks is not a fix.
       The router's resolver has to actually reach the submit path. */
    expect(readStripped("App.tsx")).toContain("(hex, from) => cityEnteredFrom(mapGrid, hex, from)");
  });
});
