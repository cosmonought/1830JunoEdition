/** @jest-environment node */
//
// Segment identity across the whole tile catalog. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 731 (harness): TWO NAMES FOR ONE PIECE OF TRACK
// ==================================================================
//
// REPORTED: "TRACK CAN NEVER BE REUSED: this rule should be obvious on F6 having two trains run the same track
// to G5, but the G5 track (and tracks like it) may be subtler: tile #24 features a fork, and the very tiny bit
// of shared track before the fork prohibits two trains from running over it. This second case of subtle
// forking needs to be checked against tiles 23-29 and virtually every brown tile."
//
// THE LAST SENTENCE IS THE TEST, AND IT ASKS FOR A SWEEP RATHER THAN A CASE. Checking tile 24 by hand would
// fix tile 24. What is actually wanted is the INVARIANT behind it -- if two ways through a tile touch the same
// edge, they are sharing track and must share a key -- and that can be asserted over every tile in the
// catalog at once, including the brown ones and any tile added later. So the sweep below is the primary test
// and the tile-24 case is kept beneath it as the worked example the report named.
//
// WHY AN EDGE AND NOT A RAIL. Tile 24 is authored `paths: [[0, 2], [0, 3]]`: two rails, both reaching edge 0,
// which on cardboard is one stub splitting inside the tile. The old keys were `rail@edge`, giving `#0@0` and
// `#1@0` -- two names for one piece of track. An edge carries exactly one track on every 18xx tile, which is
// why tiles connect at all, so the edge is the sounder unit and the fix is to name it.
//
// AND THE INVERSE MUST STILL HOLD. Two trains crossing one hex by genuinely separate curves touch four
// different edges and must STILL be allowed -- design note #4 removed a whole-hex bar precisely because it
// forbade that. A fix that made every tile exclusive would pass every test above and quietly halve the
// revenue of every corporation with two trains.

import { traversalSegments } from "./trackSegments";
import { TILE_CATALOG } from "../components/hexTileCatalog";
import type { MapGridResponse } from "../components/hexContractTypes";

const AT = { q: 5, r: 5 };

function boardWith(tileId: number, orientation = 0): MapGridResponse {
  return { tiles: [{ ...AT, tile_id: tileId, orientation }] } as unknown as MapGridResponse;
}

/** Every (entry, exit) pair the tile actually joins, with the keys that transit claims. */
function transitsOf(tileId: number): { entry: number; exit: number; keys: readonly string[] }[] {
  const grid = boardWith(tileId);
  const out: { entry: number; exit: number; keys: readonly string[] }[] = [];
  for (let entry = 0; entry < 6; entry += 1) {
    for (let exit = 0; exit < 6; exit += 1) {
      if (entry === exit) continue;
      const keys = traversalSegments(grid, AT.q, AT.r, entry, exit);
      if (keys && keys.length > 0) out.push({ entry, exit, keys });
    }
  }
  return out;
}

const shares = (a: readonly string[], b: readonly string[]) => a.some((key) => b.includes(key));

describe("every tile in the catalog: sharing an edge means sharing track", () => {
  /* THE SWEEP THE REPORT ASKED FOR, over the shipped catalog rather than a list transcribed by hand -- so
     tiles 23-29, every brown tile, and anything added next year are all covered without anybody remembering
     to add them. */
  const tileIds = TILE_CATALOG.map((entry) => entry.tileId);

  it("covers the tiles the report named", () => {
    // A sweep over an empty or truncated catalog would pass silently, which is the failure mode of a sweep.
    for (const id of [23, 24, 25, 26, 27, 28, 29]) {
      expect(tileIds).toContain(id);
    }
    expect(tileIds.length).toBeGreaterThan(20);
  });

  it.each(TILE_CATALOG.map((entry) => [entry.tileId, entry.color] as const))(
    "tile %i (%s) gives two transits over one edge a shared key",
    (tileId) => {
      const transits = transitsOf(tileId);
      for (let a = 0; a < transits.length; a += 1) {
        for (let b = a + 1; b < transits.length; b += 1) {
          const first = transits[a];
          const second = transits[b];
          const touchesSameEdge =
            first.entry === second.entry ||
            first.entry === second.exit ||
            first.exit === second.entry ||
            first.exit === second.exit;
          if (!touchesSameEdge) continue;
          /* Two transits meeting at an edge are running over the same stub of track, whatever rails the
             catalog authored them as. Written as an implication rather than an equality: they need not share
             EVERY key, only enough that one train claiming the first bars the second. */
          expect(shares(first.keys, second.keys)).toBe(true);
        }
      }
    },
  );
});

describe("tile 24, the worked example from the report", () => {
  const grid = boardWith(24);

  it("authors two rails that both reach edge 0", () => {
    // The fixture's premise, asserted rather than assumed -- a catalog edit would otherwise silently void this.
    const entry = TILE_CATALOG.find((tile) => tile.tileId === 24);
    expect(entry?.paths).toEqual([
      [0, 2],
      [0, 3],
    ]);
  });

  it("bars a second train from the shared stub before the fork", () => {
    /* THE REPORT, EXACTLY. Two trains taking the two arms of the fork both cross edge 0 -- "the very tiny bit
       of shared track" -- and used to hold `#0@0` and `#1@0`, which never collided. */
    const armA = traversalSegments(grid, AT.q, AT.r, 0, 2) ?? [];
    const armB = traversalSegments(grid, AT.q, AT.r, 0, 3) ?? [];
    expect(armA.length).toBeGreaterThan(0);
    expect(armB.length).toBeGreaterThan(0);
    expect(shares(armA, armB)).toBe(true);
  });

  it("is symmetric: the arms clash whichever way they are driven", () => {
    // A route may run the fork in either direction, and the keys must not depend on which.
    const armA = traversalSegments(grid, AT.q, AT.r, 2, 0) ?? [];
    const armB = traversalSegments(grid, AT.q, AT.r, 3, 0) ?? [];
    expect(shares(armA, armB)).toBe(true);
  });
});

describe("separate track on one hex is still separate", () => {
  /* THE INVERSE, and the reason this fix is not "make every hex exclusive". #4 removed a whole-hex bar because
     it forbade two trains crossing one hex on two different curves, and reaching the two stations of an OO
     tile. Both must survive. */
  it("lets two transits with four distinct edges coexist somewhere in the catalog", () => {
    let foundDisjointPair = false;
    for (const entry of TILE_CATALOG) {
      const transits = transitsOf(entry.tileId);
      for (let a = 0; a < transits.length && !foundDisjointPair; a += 1) {
        for (let b = a + 1; b < transits.length; b += 1) {
          const first = transits[a];
          const second = transits[b];
          const edges = new Set([first.entry, first.exit, second.entry, second.exit]);
          if (edges.size !== 4) continue;
          if (!shares(first.keys, second.keys)) {
            foundDisjointPair = true;
            break;
          }
        }
      }
      if (foundDisjointPair) break;
    }
    /* If NOTHING in the catalog admits two disjoint transits, the fix has over-constrained the board -- every
       corporation with two trains would be running one. This is the tripwire for that. */
    expect(foundDisjointPair).toBe(true);
  });
});
