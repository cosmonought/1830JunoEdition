/** @jest-environment node */

//
// Every hex that can hold two tokens can tell them apart.
//
// ==================================================================
//  DESIGN NOTE 854 (harness): THE FIX HAS TO COVER THE WHOLE BOARD
// ==================================================================
//
// ASKED: "This issue arose on G19, a landmark hex, but we need to make sure it doesn't occur on any OO hexes
// and tiles as well. Have you corrected the auto and manual pathing tools to track cities rather than hexes
// so that all hexes and tiles on the board are counted correctly when they have discontinuous track and/or
// multiple cities?"
//
// THE RIGHT QUESTION, and "the primitive generalises" is not an answer to it. #852 and #853 both delegate to
// `cityExitEdges`, which scopes by `cityGroups` on a laid tile and by `LANDMARK_TRACKS` on a landmark -- so
// the coverage question is entirely about whether those two tables are complete. That is checkable, and this
// file checks it across the whole catalog rather than on the one hex that was reported.
//
// WHAT THE SCAN FOUND, recorded because it is the answer:
//   EIGHT TILES CARRY TWO CITY GROUPS -- 54 and 62 (the New York hub upgrades) and 59, 64, 65, 66, 67, 68
//   (the OO double-city tiles). Every one of them is scoped correctly.
//   THE DOUBLE-TOWN TILES (1, 2, 55, 56, 69) have two disjoint track runs and NO city groups, and that is
//   correct rather than missing: a town holds no station token, so no route can START on one and there is no
//   city to scope to. Their discontinuity is a TRANSIT question, and `traversalsFrom` has answered it at the
//   rail level since `trackSegments.ts` #0.
//   THE SINGLE-CITY HUBS (14, 15, 53, 57, 61, 63) have no groups because every edge belongs to their one
//   city -- which is exactly what `cityExitEdges` returns when there are fewer than two groups.
//   NO TILE HAS ONE GROUP THAT IS A STRICT SUBSET OF ITS EDGES. That would be the residual hole -- a single
//   city with track detached from it -- and 1830 does not print one. Asserted below so a future tile cannot
//   introduce it quietly.

import { TILE_CATALOG } from "../components/hexTileCatalog";
import { LANDMARK_HEXES, LANDMARK_TRACKS } from "../components/hexBoardData";
import { cityExitEdges, liveEdgesForHex } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";

/** Terrain names that mean "this hex holds more than one separate STOP". */
const MULTI_STOP = /Double|Hub/i;

const entries = TILE_CATALOG as ReadonlyArray<{
  tileId: number;
  terrain: string;
  cityGroups?: readonly (readonly number[])[];
  paths?: readonly (readonly number[])[];
}>;

const edgesOf = (tile: { paths?: readonly (readonly number[])[] }) => {
  const set = new Set<number>();
  (tile.paths ?? []).forEach((pair) => pair.forEach((edge) => set.add(edge)));
  return set;
};

describe("the tile catalog can name every city it prints", () => {
  it("gives two groups to exactly the double-CITY tiles", () => {
    /* PINNED BY IDENTITY, not by count. A count would survive a tile losing its groups and another gaining
       them, which is the swap most likely to happen in a board edit. */
    const multi = entries
      .filter((tile) => (tile.cityGroups?.length ?? 0) >= 2)
      .map((tile) => tile.tileId)
      .sort((a, b) => a - b);
    expect(multi).toEqual([54, 59, 62, 64, 65, 66, 67, 68]);
  });

  it("leaves no double-CITY tile ungrouped", () => {
    /* THE COVERAGE QUESTION, asked of the catalog rather than of one hex. A DoubleCity tile with no groups
       would be scoped to "every edge" -- silently the pre-#852 bug, on that tile only. */
    const ungrouped = entries
      .filter((tile) => /DoubleCity/i.test(tile.terrain) && (tile.cityGroups?.length ?? 0) < 2)
      .map((tile) => `${tile.tileId} (${tile.terrain})`);
    expect(ungrouped).toEqual([]);
  });

  it("leaves the double-TOWN tiles ungrouped on purpose", () => {
    /* NOT AN OVERSIGHT, and worth an assertion so it is not "fixed" into one. A town holds no token, so no
       route starts there and there is no city to scope to. Their two disjoint runs are a TRANSIT question,
       answered at the rail level by `traversalsFrom` (`trackSegments.ts` #0) -- which this asserts is really
       what they are, by checking the discontinuity is present in `paths`. */
    const towns = entries.filter((tile) => /DoubleTown/i.test(tile.terrain));
    expect(towns.length).toBeGreaterThan(0);
    towns.forEach((tile) => {
      expect(tile.cityGroups).toBeUndefined();
      expect((tile.paths ?? []).length).toBeGreaterThanOrEqual(2);
    });
  });

  it("has no single city with track detached from it", () => {
    /* THE RESIDUAL HOLE, ASSERTED ABSENT. `cityExitEdges` returns EVERY edge when a tile has fewer than two
       groups, which is right only while a one-city tile's city touches all of its rails. A tile breaking that
       would be scoped too widely and nothing else would notice. */
    const partial = entries
      .filter((tile) => tile.cityGroups?.length === 1)
      .filter((tile) => (tile.cityGroups as readonly (readonly number[])[])[0].length < edgesOf(tile).size)
      .map((tile) => `${tile.tileId} (${tile.terrain})`);
    expect(partial).toEqual([]);
  });

  it("covers every multi-stop terrain one way or the other", () => {
    /* THE CATCH-ALL. Any tile whose terrain says "more than one stop" is either grouped (a city pair) or a
       double town (no tokens). A third case would be a tile this analysis has not considered. */
    const unexplained = entries
      .filter((tile) => MULTI_STOP.test(tile.terrain))
      .filter((tile) => (tile.cityGroups?.length ?? 0) < 2 && !/DoubleTown/i.test(tile.terrain))
      .filter((tile) => !/MajorCityHub|BostonHub|NewYorkHub/i.test(tile.terrain))
      .map((tile) => `${tile.tileId} (${tile.terrain})`);
    expect(unexplained).toEqual([]);
  });
});

describe("the landmarks can name their cities too", () => {
  it("scopes every landmark whose track comes in separate runs", () => {
    /* G19 IS NOT THE ONLY ONE. `cityExitEdges` reads `LANDMARK_TRACKS[name]` and scopes when there are two or
       more segments -- so the coverage question for preprinted hexes is whether any landmark has separate
       runs that the table records as one. Checked by construction: for every multi-segment landmark, each
       city's edge set must be a strict subset of the hex's. */
    const BARE: MapGridResponse = { game_id: 1, tiles: [] };
    const multi = LANDMARK_HEXES.filter(
      (entry) => (LANDMARK_TRACKS[entry.name]?.length ?? 0) >= 2,
    );
    expect(multi.length).toBeGreaterThan(0);
    multi.forEach((entry) => {
      const all = liveEdgesForHex(BARE, entry.q, entry.r);
      const zero = cityExitEdges(BARE, entry.q, entry.r, 0);
      const one = cityExitEdges(BARE, entry.q, entry.r, 1);
      expect(zero.length).toBeGreaterThan(0);
      expect(one.length).toBeGreaterThan(0);
      // Scoped, not the whole hex -- the property that failed on New York before #852.
      expect(zero.length).toBeLessThan(all.length);
      expect(one.length).toBeLessThan(all.length);
    });
  });
});

describe("both tracers ask the same primitive", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs
      .readFileSync(path.join(__dirname, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  };

  it("scopes the network walk, the route search and the token rule alike", () => {
    /* THE WHOLE ANSWER TO "have you corrected the auto AND manual tools". Three surfaces, one primitive:
         `trackReach.ts`      -- the network walk's start (#686)
         `routeAutoTrace.ts`  -- the route search's start (#852)
         `routeWaypoints.ts`  -- the token rule for a drawn route (#853)
       A fourth surface deciding this for itself is the failure this codebase keeps finding, so the count is
       the assertion. */
    expect(read("trackReach.ts")).toContain("cityExitEdges(");
    expect(read("routeAutoTrace.ts")).toContain("cityExitEdges(");
    expect(read("routeWaypoints.ts")).toContain("cityExitEdges(");
  });

  it("leaves no tracer taking every rail on a tokened hex", () => {
    /* `liveEdgesForHex` is the hex-as-a-node model. It survives in `routeAutoTrace` for ONE caller --
       `bridgeWaypoints`, which starts where a player clicked rather than at a token -- and nowhere in the
       other two. */
    expect(read("trackReach.ts")).not.toContain("liveEdgesForHex");
    expect((read("routeAutoTrace.ts").match(/liveEdgesForHex\(/g) ?? []).length).toBe(1);
  });
});
