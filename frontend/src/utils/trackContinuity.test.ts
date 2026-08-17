// frontend/src/utils/trackContinuity.test.ts
//
// ==================================================================
//  DESIGN NOTE 483 (harness): TWO CURVES ARE NOT A JUNCTION
// ==================================================================
//
// The reported bug: the network calculator traces connectivity through
// discontinuous track on a hex, so a corporation is offered tile lays it
// cannot legally make.
//
// TILE #20 IS THE WHOLE TEST. It is two straights -- edges 0-3 and 1-4 --
// that cross visually and never touch, so it is the smallest board on which
// "reached the hex" and "reached this edge of the hex" give different
// answers. A corporation arriving on edge 3 may leave by edge 0 and by
// nothing else; edges 1 and 4 belong to a rail it cannot get onto.
//
// THE COORDINATES ARE DERIVED, NOT TYPED. The test finds a real board hex
// with four usable neighbours rather than naming one, because a hardcoded
// triple is a test that starts failing when the board data is edited for
// unrelated reasons -- and because the property under test is about tile
// geometry, not about any particular corner of Pennsylvania.
//
// WHAT WOULD PASS AGAINST THE OLD CODE, and therefore is not worth
// asserting alone: that the near hexes are reachable. The old walk got
// those right. Every expectation below that matters is a NEGATIVE one --
// the far arm is not reachable, not a port, and not a build candidate.

import { HEX_NEIGHBOR_OFFSETS, evaluateHexForTileLaying } from "../components/hexGeometry";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { hexKey, layableHexes, portKey, reachableTrack } from "./trackReach";

const BOARD = new Set(STATIC_BOARD_HEXES.map((hex) => hexKey(hex.q, hex.r)));

function neighbour(q: number, r: number, edge: number): { q: number; r: number } {
  const [dq, dr] = HEX_NEIGHBOR_OFFSETS[edge];
  return { q: q + dq, r: r + dr };
}

/** A board hex whose neighbours across all four of #20's edges are board
 *  hexes that could TAKE a tile -- the middle of the three-hex patch design
 *  note #4 measured the original bug on.
 *
 *  Eligibility is part of the search, not an afterthought: if the far arm
 *  pointed at open water, `layableHexes` would exclude those hexes for a
 *  reason that has nothing to do with connectivity and the negative
 *  assertions below would pass against the bug. */
function findCrossroads(): { q: number; r: number } {
  const bare: MapGridResponse = { game_id: 1, tiles: [] };
  for (const hex of STATIC_BOARD_HEXES) {
    const usable = [0, 1, 3, 4].every((edge) => {
      const n = neighbour(hex.q, hex.r, edge);
      return BOARD.has(hexKey(n.q, n.r)) && evaluateHexForTileLaying(n.q, n.r, bare).eligible;
    });
    if (usable) return { q: hex.q, r: hex.r };
  }
  throw new Error("no board hex has four buildable neighbours across tile #20's edges");
}

const CENTRE = findCrossroads();
/** Enters `CENTRE` at edge 3. `WEST` is across `CENTRE`'s edge 3, so from
 *  `WEST` the shared edge is 0. */
const WEST = neighbour(CENTRE.q, CENTRE.r, 3);
/** The far end of the SAME straight -- legitimately reachable. */
const EAST = neighbour(CENTRE.q, CENTRE.r, 0);
/** The two ends of the OTHER straight. Physically present on the tile,
 *  unreachable from `WEST`, and the whole point of the exercise. */
const OTHER_A = neighbour(CENTRE.q, CENTRE.r, 1);
const OTHER_B = neighbour(CENTRE.q, CENTRE.r, 4);

function tile(q: number, r: number, tileId: number, orientation = 0): MapTileEntry {
  // `landmark` is required on the contract shape and irrelevant here.
  // Spelled out rather than cast: Jest compiles through Babel and would not
  // have noticed it missing, and `tsc` catching what the suite cannot is a
  // recurring lesson on this project rather than a one-off.
  return { q, r, tile_id: tileId, orientation, landmark: null };
}

/** #9 (a straight, edges 0-3) on `WEST`, #20 (two crossing straights) on
 *  `CENTRE`. Nothing else laid, so the far hexes are bare cardboard. */
const GRID: MapGridResponse = {
  game_id: 1,
  tiles: [tile(WEST.q, WEST.r, 9), tile(CENTRE.q, CENTRE.r, 20)],
};

/** One token, on the hex at the far end of the straight from the crossover. */
const TOKENS: ReadonlyArray<readonly [number, number]> = [[WEST.q, WEST.r]];

describe("the walk", () => {
  const { hexes, ports } = reachableTrack(GRID, TOKENS);

  it("reaches along the straight it entered on", () => {
    expect(hexes.has(hexKey(WEST.q, WEST.r))).toBe(true);
    expect(hexes.has(hexKey(CENTRE.q, CENTRE.r))).toBe(true);
  });

  it("records the exit edge of the rail it is on as a port", () => {
    // Entered at edge 3, so the 0-3 straight offers edge 0 and only edge 0.
    expect(ports.has(portKey(CENTRE.q, CENTRE.r, 0))).toBe(true);
  });

  it("does NOT record the other straight's edges as ports", () => {
    // THE BUG. Edges 1 and 4 are live edges of this tile and belong to a
    // rail the corporation cannot get onto.
    expect(ports.has(portKey(CENTRE.q, CENTRE.r, 1))).toBe(false);
    expect(ports.has(portKey(CENTRE.q, CENTRE.r, 4))).toBe(false);
  });

  it("does not reach the far arm's hexes", () => {
    expect(hexes.has(hexKey(OTHER_A.q, OTHER_A.r))).toBe(false);
    expect(hexes.has(hexKey(OTHER_B.q, OTHER_B.r))).toBe(false);
  });

  it("stops at bare cardboard rather than walking onto it", () => {
    // `EAST` is where the corporation's rail points and has no tile, so it
    // is a build site rather than part of the network. The port survives
    // where the hex does not -- design note #483's asymmetry.
    expect(hexes.has(hexKey(EAST.q, EAST.r))).toBe(false);
    expect(ports.has(portKey(CENTRE.q, CENTRE.r, 0))).toBe(true);
  });

  it("finds nothing at all from a corporation with no tokens", () => {
    const empty = reachableTrack(GRID, []);
    expect(empty.hexes.size).toBe(0);
    expect(empty.ports.size).toBe(0);
  });

  it("treats a station as entered from inside", () => {
    // A token sits IN the city, so every rail leaving that hex is available
    // to it -- there is no arrival edge to constrain a start. Both of the
    // straight's edges on `WEST` are ports.
    expect(ports.has(portKey(WEST.q, WEST.r, 0))).toBe(true);
    expect(ports.has(portKey(WEST.q, WEST.r, 3))).toBe(true);
  });
});

describe("where a tile may be laid", () => {
  const result = layableHexes({ mapGrid: GRID, stationHexes: TOKENS });

  it("is a real answer, not the unconstrained fallback", () => {
    // If this were `true` the assertions below would be vacuous -- the
    // caller drops the veil entirely and everything is clickable.
    expect(result.unconstrained).toBe(false);
  });

  it("offers the hex the reachable straight points at", () => {
    expect(result.hexes.has(hexKey(EAST.q, EAST.r))).toBe(true);
  });

  it("does NOT offer the hexes beyond the unreachable straight", () => {
    // The reported symptom, stated as the thing that must not happen.
    expect(result.hexes.has(hexKey(OTHER_A.q, OTHER_A.r))).toBe(false);
    expect(result.hexes.has(hexKey(OTHER_B.q, OTHER_B.r))).toBe(false);
  });

  it("excludes them for CONNECTIVITY, not because they are unbuildable", () => {
    /* The assertion that stops the one above being vacuous. Both far hexes
       would take a tile perfectly happily; the only thing keeping them out
       of the set is that the corporation's track cannot reach them. Against
       the old hex-as-a-node extension both were offered. */
    for (const far of [OTHER_A, OTHER_B]) {
      expect(evaluateHexForTileLaying(far.q, far.r, GRID).eligible).toBe(true);
      expect(result.hexes.has(hexKey(far.q, far.r))).toBe(false);
    }
  });

  it("carries the ports out to the rotation filter", () => {
    // `sandboxTileLegality` needs them and cannot re-derive them; design
    // note #483 exists because it tried.
    expect(result.ports.has(portKey(CENTRE.q, CENTRE.r, 0))).toBe(true);
    expect(result.ports.has(portKey(CENTRE.q, CENTRE.r, 1))).toBe(false);
  });

  it("agrees with the walk about where the network is", () => {
    // Two halves of one picture (design note #4). If these ever came from
    // separate traversals they could disagree about where track ends.
    const walk = reachableTrack(GRID, TOKENS);
    expect(Array.from(result.network).sort()).toEqual(Array.from(walk.hexes).sort());
    expect(Array.from(result.ports).sort()).toEqual(Array.from(walk.ports).sort());
  });
});

describe("a corporation with no token on the board", () => {
  it("is unconstrained rather than blocked", () => {
    // Design note #2: dimming the whole board over missing data would tell
    // a player they may build nowhere, which is wrong and looks broken.
    const result = layableHexes({ mapGrid: GRID, stationHexes: [] });
    expect(result.unconstrained).toBe(true);
    expect(result.hexes.size).toBe(0);
    expect(result.ports.size).toBe(0);
  });
});
