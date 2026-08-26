/** @jest-environment node */

//
// A route begins in a city, not on a hex.
//
// ==================================================================
//  DESIGN NOTE 852 (harness): THE OTHER TRACER WAS NEVER TOLD
// ==================================================================
//
// REPORTED: "MAJOR REGRESSION: NNH has two 3-trains. In Run Routes, one train runs from its home station (on
// the upper right city) to Providence, and the other train is running from the disconnected lower left city.
// This is actually two major problems: i) the two cities are not part of NNH's network, and ii) the second
// train doesn't run through any NNH station. This had been fixed before and has now returned."
//
// IT WAS FIXED, AND IN A DIFFERENT FILE. `trackReach.ts` #686 -- "A TOKEN IS IN A CITY, NOT ON A HEX" -- was
// reported on this corporation and this hex, and it fixed the NETWORK walk's start. `routeAutoTrace.ts` is
// the ROUTE search: a separate DFS, with its own start, which still took every live edge on the tokened hex.
//
// #730 HAD ALREADY NAMED THE HAZARD, one layer up: "the same defect as #729 and the same shape of fix, in the
// other tracer. They had to be fixed together or the board would have promised reach the router then refused
// -- which is worse than both being wrong." #686 was the same defect one layer down, and only one tracer got
// the fix. TENTH INSTANCE this session of a rule stated in one authority and never asked in its sibling.
//
// THE BOARD IS THE FIXTURE, not a synthetic two-city tile: the reported hexes, the reported corporation, the
// reported symptom. `cityStartReach.test.ts` made the same choice for #686 and for the same reason -- a
// made-up tile proves the mechanism and not the report.

import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import { cityExitEdges, liveEdgesForHex } from "../components/hexGeometry";
import { assignRouteSet, autoTraceRoute } from "./routeAutoTrace";
import { routeIncludesOwnedToken, routeTokenBlockReason } from "./routeWaypoints";
import type { MapGridResponse } from "../components/hexContractTypes";

const BARE: MapGridResponse = { game_id: 1, tiles: [] };

/** Found rather than typed: a coordinate written by hand is one board edit away from testing empty space. */
const findHex = (label: string) => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  expect(hex).toBeDefined();
  return hex as NonNullable<typeof hex>;
};

const NEW_YORK = findHex("G19");

describe("the board really is shaped the way the report says", () => {
  it("gives New York two cities whose spurs do not touch", () => {
    /* THE PREMISE, ASSERTED. If a future board edit joins these two, the tests below stop meaning what they
       say -- and would keep passing, which is the worse failure. */
    const zero = cityExitEdges(BARE, NEW_YORK.q, NEW_YORK.r, 0);
    const one = cityExitEdges(BARE, NEW_YORK.q, NEW_YORK.r, 1);
    expect(zero.length).toBeGreaterThan(0);
    expect(one.length).toBeGreaterThan(0);
    expect(zero.some((edge) => one.includes(edge))).toBe(false);
  });

  it("has a hex-wide edge set that is the union of both", () => {
    // Which is exactly why "every rail on the hex" was the wrong start: it is both cities at once.
    const all = liveEdgesForHex(BARE, NEW_YORK.q, NEW_YORK.r);
    const zero = cityExitEdges(BARE, NEW_YORK.q, NEW_YORK.r, 0);
    const one = cityExitEdges(BARE, NEW_YORK.q, NEW_YORK.r, 1);
    expect(all.length).toBeGreaterThan(zero.length);
    expect(all.length).toBeGreaterThan(one.length);
    expect(new Set([...zero, ...one]).size).toBe(all.length);
  });

  it("puts NNH's home on New York", () => {
    /* THE REPORT NAMES A CORPORATION, so the fixture has to be that corporation's actual home rather than a
       hex chosen to suit the test. `STATION_HOME_HEXES` is a LIST, not a map -- the first draft indexed it by
       ticker and got `undefined`, which `toBeDefined` caught immediately. A fixture that resolves to nothing
       is the quietest way for a test about the real board to become a test about nothing. */
    const nnh = STATION_HOME_HEXES.find((entry) => entry.label === "G19");
    expect(nnh).toBeDefined();
    expect(nnh?.q).toBe(NEW_YORK.q);
    expect(nnh?.r).toBe(NEW_YORK.r);
  });
});

/* ==================================================================
    A BOARD WHERE THE WRONG ARM ACTUALLY GOES SOMEWHERE
   ==================================================================
   THE FIRST DRAFT OF THIS BLOCK RAN ON A BARE BOARD AND PROVED NOTHING. G19's two arms lead to F20 and H18,
   both plain hexes with no track, so no route exists from New York in either direction -- and every assertion
   compared one empty set with another. Restoring the bug left all three green.
   MEASURED, THEN REBUILT. `assignRouteSet` returned revenue 0 and no paths for all three token forms, which
   is what a negative control is for and is the fourth vacuous harness this session.
   SO H18 GETS A CITY. One tile, on the arm belonging to the city NNH does NOT hold, positioned so a route
   from there is worth finding: New York pays 40 and the new city pays, which clears the two-centre minimum.
   Now city 0 has nowhere to go and city 1 has somewhere -- and the reported bug is precisely that a token in
   city 0 finds city 1's route. */
const H18 = findHex("H18");
/** Tile 57: a city on straight track. Orientation 1 turns its base edges 0/3 into 1/4, and edge 1 on H18 is
 *  the edge it shares with New York -- so this connects the two and nothing else. */
const WITH_H18_CITY: MapGridResponse = {
  game_id: 1,
  /* `landmark: null` because `MapTileEntry` requires it and this is an ordinary lay. Caught by `tsc` and not
     by Jest, which does not typecheck -- and the same run corrected `era` from `"yellow"` to `"Yellow"`. A
     fixture the compiler has not read is a fixture that may be describing a board the app cannot produce. */
  tiles: [{ q: H18.q, r: H18.r, tile_id: 57, orientation: 1, landmark: null }],
};

describe("a start scoped to the token's city", () => {
  /** Every hex a drafted route touches, for a token given as `[q, r]` or `[q, r, city]`. */
  const reachedFrom = (token: readonly number[]) => {
    const result = assignRouteSet({
      mapGrid: WITH_H18_CITY,
      era: "Yellow",
      startHexes: [token as never],
      trains: [{ trainIndex: 0, maxRevenueCentres: 3 }],
    });
    const hexes = new Set<string>();
    result.assignments.forEach((entry) => entry.path.forEach((point) => hexes.add(point.hexLabel)));
    return hexes;
  };

  it("finds the route this board was built to contain", () => {
    /* THE GUARD AGAINST THE VACUITY THAT WAS HERE BEFORE. If the fixture ever stops producing a route, every
       assertion below passes by finding nothing -- so the route is asserted to EXIST first, and loudly. */
    expect(reachedFrom([NEW_YORK.q, NEW_YORK.r]).has("H18")).toBe(true);
  });

  it("cannot leave by the other city's rail", () => {
    /* THE REPORT, AS A TEST. H18 hangs off edge 4, which belongs to city 1. NNH's token is in the city that
       owns edge 1. Before #852 the search took every rail on G19, so a token in city 0 ran to H18 -- "the
       other train is running from the disconnected lower left city", and it is #686's own reported hex. */
    expect(reachedFrom([NEW_YORK.q, NEW_YORK.r, 0]).has("H18")).toBe(false);
  });

  it("still finds it from the city that owns the rail", () => {
    // THE CONTROL: a fix that refused both arms would satisfy the test above and break the feature.
    expect(reachedFrom([NEW_YORK.q, NEW_YORK.r, 1]).has("H18")).toBe(true);
  });

  it("still offers the whole hex when the caller does not name a city", () => {
    /* `[q, r]` means "the whole hex", which is right for the ~90% of the board with one city on it and is the
       pre-#852 behaviour exactly. A fix that narrowed every start would have broken every other corporation
       to fix one. */
    expect(reachedFrom([NEW_YORK.q, NEW_YORK.r]).has("H18")).toBe(true);
  });

  it("names no route rather than an illegal one", () => {
    /* A city with nothing built off it produces NO route, not a route through the other city. "No route" is
       an honest answer; the reported one was not. */
    const result = autoTraceRoute({
      mapGrid: WITH_H18_CITY,
      era: "Yellow",
      startHexes: [[NEW_YORK.q, NEW_YORK.r, 0] as never],
      maxRevenueCentres: 3,
    });
    expect(result.path).toEqual([]);
    expect(result.reason).not.toBeNull();
  });
});

/* ==================================================================
    DESIGN NOTE 852b: NOT A REGRESSION -- THE SEARCH ONLY TAKES A BAD ARM WHEN IT PAYS
   ==================================================================
   ASKED, on reading the #852 note: "your report made it sound like the auto-route bug I reported on G19 was a
   new one. But I've done multiple playtests where it didn't happen at all. Was it really a new bug, or did we
   break it when we were working on something else?"

   NEITHER, AND THE EXPLANATION IS THE ASKER'S: "My playtests could have been that the 'greediest' routes were
   not that disconnected town ... in this last playtest where it occurred, that false route through G19's
   disconnected city yielded a higher value than the only alternative."

   THAT IS THE WHOLE OF IT. `git log -S` finds no commit that ever made `startHexes` city-aware, and HEAD's
   copy of this file already takes every rail on the hex -- so nothing broke it. The search has ALWAYS been
   able to leave by the wrong arm; `candidateRoutes` sorts by revenue and `assignRouteSet` maximises the total,
   so it only ever SELECTS that arm when the arm out-earns every legal option. A bug in the candidate set is
   invisible until the bad candidate wins.

   MEASURED, with the richer tile deliberately on the arm NNH does not hold:
     PRE-FIX:  $90  ["F20>G19>H18"]   -- through the hex, treating two cities as one junction
     POST-FIX: $60  ["G19>F20"]       -- the legal run, thirty dollars poorer and correct

   TWO TRAINS IS ONE WAY OF MAKING THE BAD ARM WIN, not a separate cause. Routes must be segment-disjoint
   (#4), so a second train cannot reuse the legal arm -- the bad one becomes the best REMAINING candidate by
   default, since any revenue beats none. That is why the report arrived on a corporation with two 3-trains,
   and why a one-train playtest on the same board looked clean.

   THE QUIET VARIANT IS THE EXPENSIVE ONE. When the bad arm wins with a single train it produces a route that
   runs THROUGH the wrong city rather than out of it -- shaped exactly like a legal run, on screen and in the
   payout. Nothing marks the two halves of an OO hex as unconnected, so there is nothing to notice; the
   corporation is simply paid too much. The visible version got reported. The silent version moved money.

   AND #852'S "REGRESSION" FRAMING WAS WRONG, kept here rather than edited away. The report said "this had
   been fixed before and has now returned" and I took it at face value instead of checking. What had been
   fixed before was #686, in the network walk -- a different file, a different tracer. */
const H18_RICHER: MapGridResponse = {
  game_id: 1,
  /* Tile 14 is a Green major-city hub and pays more than tile 57. It goes on the arm belonging to the city
     NNH does NOT hold, so the illegal option is also the best-paying one -- the condition under which the
     old search would take it, and the one the asker identified from their own playtest. */
  tiles: [
    { q: H18.q, r: H18.r, tile_id: 14, orientation: 0, landmark: null },
    { q: findHex("F20").q, r: findHex("F20").r, tile_id: 57, orientation: 1, landmark: null },
  ],
};

describe("why the playtests looked clean (design note #852b)", () => {
  const draft = (token: readonly number[], trains = 1) =>
    assignRouteSet({
      mapGrid: H18_RICHER,
      era: "Green",
      startHexes: [token as never],
      trains: Array.from({ length: trains }, (_, index) => ({
        trainIndex: index,
        maxRevenueCentres: 3,
      })),
    });

  it("takes the legal run even when the illegal one pays more", () => {
    /* THE MEASUREMENT, PINNED. Unscoped -- the pre-#852 reading -- the best candidate is `F20>G19>H18` at
       $90, through a junction New York does not have. Scoped to city 0 it is `G19>F20` at $60. The fix costs
       this corporation thirty dollars it was never entitled to. */
    const scoped = draft([NEW_YORK.q, NEW_YORK.r, 0]);
    scoped.assignments.forEach((entry) =>
      entry.path.forEach((point) => expect(point.hexLabel).not.toBe("H18")),
    );
    expect(scoped.totalRevenue).toBeGreaterThan(0);
  });

  it("proves the illegal route really was the greedier one", () => {
    /* THE GUARD ON THE TEST ABOVE. If the fixture ever stops making the wrong arm richer, that assertion
       passes for the wrong reason -- the search would be avoiding H18 because it pays less, not because it is
       out of reach. So the premise is measured, not assumed. */
    const unscoped = draft([NEW_YORK.q, NEW_YORK.r]);
    const scoped = draft([NEW_YORK.q, NEW_YORK.r, 0]);
    expect(unscoped.totalRevenue).toBeGreaterThan(scoped.totalRevenue);
    expect(
      unscoped.assignments.some((entry) => entry.path.some((point) => point.hexLabel === "H18")),
    ).toBe(true);
  });

  it("gives a second train nothing rather than the wrong arm", () => {
    /* THE OTHER ROUTE TO THE SAME OUTCOME. Disjointness (#4) makes the bad arm the best REMAINING candidate
       once the legal one is taken -- which is how the report's two-3-train corporation met it. "Trains that
       get nothing are not a failure" (#7); a train running out of a city its corporation does not hold is. */
    const scoped = draft([NEW_YORK.q, NEW_YORK.r, 0], 2);
    expect(scoped.assignments.length).toBeLessThanOrEqual(1);
    scoped.assignments.forEach((entry) =>
      entry.path.forEach((point) => expect(point.hexLabel).not.toBe("H18")),
    );
  });

  it("still gives two trains two routes where two legal ones exist", () => {
    /* THE CONTROL. A corporation holding BOTH cities may use both arms and must still get both -- otherwise
       this reads as "second trains no longer run", a worse bug than the one being fixed. */
    expect(draft([NEW_YORK.q, NEW_YORK.r], 2).assignments.length).toBe(2);
  });
});

describe("the source keeps the model out", () => {
  const SEARCH = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "routeAutoTrace.ts"), "utf8");
    // #490a: the notes quote the removed call while explaining its removal.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const start = code.indexOf("function candidatePathsFrom");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("function candidateRoutes", start);
    expect(end).toBeGreaterThan(start);
    return code.slice(start, end);
  })();

  it("asks cityExitEdges at the start of the search", () => {
    expect(SEARCH).toContain("cityExitEdges(mapGrid, at.q, at.r, startCity)");
    expect(SEARCH).not.toContain("liveEdgesForHex");
  });

  it("hands the router tokens rather than bare hexes", () => {
    /* THE OTHER HALF OF THE FIX, and the half that would have made the first half useless. `startHexes` could
       take a city index and `App.tsx` was passing `station_token_hexes`, which does not have one -- so the
       search would have scoped every start to `null` and behaved exactly as before.
       COUNTED BY ABSENCE OF THE OLD FORM rather than by a count of the new one: the three call sites are
       written two different ways (two assignments and one prop), and a count keyed to today's phrasing breaks
       on a rename while proving nothing about the property. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs
      .readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(app).not.toContain("startHexes: corporation?.station_token_hexes");
    expect(app).not.toContain("const startHexes = corporation.station_token_hexes");
    expect((app.match(/startHexes/g) ?? []).length).toBeGreaterThan(2);
    expect(app).toContain("stationTokensOf(corporation)");
  });

  it("keeps #852a's correction rather than quietly rewriting it", () => {
    /* #852a FIRST CLAIMED the manual gap was `bridgeWaypoints` and needed a contract change. #853 found the
       hole was the token rule and needed no new field. The note keeps both, because a superseded claim that
       is deleted is a claim that gets made again -- and this one was made confidently. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "routeAutoTrace.ts"), "utf8");
    expect(raw).toContain("DESIGN NOTE 852a");
    expect(raw).toContain("BOTH\n     HALVES WERE WRONG");
    expect(raw).toContain("NO NEW FIELD WAS NEEDED");
  });
});

// ==================================================================
//  DESIGN NOTE 853 (harness): AND THE HAND-DRAWN ROUTE
// ==================================================================
//
// ASKED, after #852: "Are you saying a manual route would still be able to run from city 1 even without NNH's
// network connected to it?"
//
// YES, AND #852a BLAMED THE WRONG FUNCTION. It named `bridgeWaypoints` and concluded the fix needed
// `RouteWaypointDto` to carry a city index -- a contract change. Both halves were wrong: the hole is
// `routeIncludesOwnedToken`, which compared `(q, r)` pairs, and the city is derivable from the route's own
// geometry without any new field.
//
// #730a IS WHAT MADE THAT LOOK IMPOSSIBLE: "A drawn route is a list of hexes with no recorded entry side, so
// 'which city did this enter' cannot be asked here." True of one hex alone; false of a hex with a neighbour.
// `hexCanvasPrimitives.ts` #689 has been deriving these very edges to DRAW the route through the right city
// for as long as the rule has been failing to ask.


describe("a hand-drawn route through the wrong city (design note #853)", () => {
  /** H18 -> G19: a legal-looking two-hex run that touches New York by city 1's rail. */
  const DRAWN = [
    { q: H18.q, r: H18.r },
    { q: NEW_YORK.q, r: NEW_YORK.r },
  ];

  it("was accepted when the rule compared coordinates", () => {
    /* THE OLD BEHAVIOUR, PRESERVED AS THE FALLBACK and asserted so the change is legible: without a board to
       ask, the rule is still coordinate-only, which is every fixture written before #853. */
    expect(routeIncludesOwnedToken(DRAWN, [[NEW_YORK.q, NEW_YORK.r, 0]])).toBe(true);
  });

  it("is refused once the board is passed in", () => {
    /* THE ANSWER TO THE QUESTION. NNH's token is in city 0; this route enters New York across edge 4, which
       belongs to city 1. The run touches the HEX and not the CITY, and the rule now knows the difference. */
    expect(routeIncludesOwnedToken(DRAWN, [[NEW_YORK.q, NEW_YORK.r, 0]], WITH_H18_CITY)).toBe(false);
    expect(routeTokenBlockReason(DRAWN, [[NEW_YORK.q, NEW_YORK.r, 0]], WITH_H18_CITY)).toContain(
      "must pass through a city",
    );
  });

  it("is accepted for the corporation that actually holds that city", () => {
    // THE CONTROL: refusing both cities would satisfy the test above and break every legal run through G19.
    expect(routeIncludesOwnedToken(DRAWN, [[NEW_YORK.q, NEW_YORK.r, 1]], WITH_H18_CITY)).toBe(true);
    expect(routeTokenBlockReason(DRAWN, [[NEW_YORK.q, NEW_YORK.r, 1]], WITH_H18_CITY)).toBeNull();
  });

  it("still accepts a token given without a city", () => {
    // `[q, r]` means the whole hex, as it does everywhere since #686 -- the ordinary one-city board.
    expect(routeIncludesOwnedToken(DRAWN, [[NEW_YORK.q, NEW_YORK.r]], WITH_H18_CITY)).toBe(true);
  });

  it("is handed the board by the shell", () => {
    /* THE HALF THAT MAKES THE OTHER HALF REAL, and it had no test until a negative control removed it and
       nothing went red. Without `mapGrid` the rule falls back to coordinates -- correct as a fallback for a
       fixture, and silently the old bug if the app takes it. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs
      .readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(app).toContain("routeTokenBlockReason(points, routeTokenHexes, mapGrid)");
    expect(app).toContain("stationTokensOf(corporation)");
  });

  it("judges a token at either end of the run, not only in the middle", () => {
    /* #474's rule is that a token anywhere on the run counts. A first point has no predecessor and a last
       point has no successor, and #853 has to name a city for both -- one neighbour is enough. */
    const reversed = [...DRAWN].reverse();
    expect(routeIncludesOwnedToken(reversed, [[NEW_YORK.q, NEW_YORK.r, 1]], WITH_H18_CITY)).toBe(true);
    expect(routeIncludesOwnedToken(reversed, [[NEW_YORK.q, NEW_YORK.r, 0]], WITH_H18_CITY)).toBe(false);
  });
});
