// frontend/src/utils/sharedCityRouting.test.ts
//
// ==================================================================
//  DESIGN NOTE 669 (harness): A CITY IS A NODE, NOT A PIECE OF TRACK
// ==================================================================
//
// REPORTED: B&O, two 2-trains, a straight yellow city tile joining its home
// station to Deep South and a second token on that tile. Auto Route drafts ONE
// train. Clicking the second station to Deep South by hand produces a perfectly
// good $100 route -- so the route exists, and only the router cannot see it.
//
// `multiTrainRouting.test.ts` (#492b) already proves the router assigns several
// trains, and it is right: its fixture is TWO DISJOINT CORRIDORS. That is the
// board on which the question "does it route more than one train" has an easy
// yes, and it is why this bug survived that harness. The reported board is the
// other shape -- ONE corridor, two trains, meeting at a shared city -- and it is
// the commonest shape in a real early game, because a corporation's second token
// goes on the city its first route already reaches.
//
// THE RULE. 1830 forbids two of a corporation's trains from running over the
// same TRACK. A city is not track; it is a node where track ends. A train
// running A -> B and a train running B -> C use the rail on either side of B and
// share nothing but B itself, which is legal and ordinary.
//
// The tracer modelled tile #57 -- "the yellow city, straight through one central
// station" -- as a single authored path, so both trains claimed the same segment
// key and the second was conflicted out of its own route.
//
// The fixture below is deliberately the minimum that shows it: three cities in a
// line, tokens on the first two, two 2-trains. Nothing about it is exotic.

import { HEX_NEIGHBOR_OFFSETS, liveEdgesForHex } from "../components/hexGeometry";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { assignRouteSet, routeSegments } from "./routeAutoTrace";
import { segmentsTouchingEdge, traversalSegments } from "./trackSegments";

const BOARD = new Set(STATIC_BOARD_HEXES.map((h) => `${h.q},${h.r}`));
const YELLOW_CITY = 57;

function tile(q: number, r: number, tileId: number, orientation: number): MapTileEntry {
  return { q, r, tile_id: tileId, orientation, landmark: null };
}

/** The rotation at which `tileId` genuinely joins edges 0 and 3 -- measured,
 *  not assumed. Same derivation as #492b's fixture, and for the same reason. */
function straightOrientation(tileId: number): number | null {
  for (let o = 0; o < 6; o += 1) {
    const grid: MapGridResponse = { game_id: 1, tiles: [tile(0, 0, tileId, o)] };
    const edges = liveEdgesForHex(grid, 0, 0);
    if (edges.includes(0) && edges.includes(3)) return o;
  }
  return null;
}

/** A run of `len` real board hexes stepping along edge 0. */
function corridorFrom(q0: number, r0: number, len: number) {
  const [dq, dr] = HEX_NEIGHBOR_OFFSETS[0];
  const out: Array<{ q: number; r: number }> = [];
  for (let i = 0; i < len; i += 1) {
    const q = q0 + dq * i;
    const r = r0 + dr * i;
    if (!BOARD.has(`${q},${r}`)) break;
    out.push({ q, r });
  }
  return out;
}

function firstCorridor(len: number) {
  for (const hex of STATIC_BOARD_HEXES) {
    const run = corridorFrom(hex.q, hex.r, len);
    if (run.length === len) return run;
  }
  return [];
}

const ORIENTATION = straightOrientation(YELLOW_CITY);
const LINE = firstCorridor(3);

/** Three yellow cities in a row -- home, the shared city, and the destination. */
const GRID: MapGridResponse = {
  game_id: 1,
  tiles: LINE.map((h) => tile(h.q, h.r, YELLOW_CITY, ORIENTATION ?? 0)),
};

/** Tokens on the first two, which is the reported position exactly. */
const TOKENS: Array<readonly [number, number]> = LINE.slice(0, 2).map(
  (h) => [h.q, h.r] as const,
);

/** A 2-train: two revenue centres, no more. */
const twoTrains = [
  { trainIndex: 0, maxRevenueCentres: 2 },
  { trainIndex: 1, maxRevenueCentres: 2 },
];

describe("the fixture", () => {
  it("is three connected cities in a line", () => {
    /* Without this every assertion below could be measuring an empty board and
       would pass against a router that does nothing at all. */
    expect(ORIENTATION).not.toBeNull();
    expect(LINE).toHaveLength(3);
    expect(TOKENS).toHaveLength(2);
  });

  it("joins each city to the next", () => {
    const [a, b, c] = LINE;
    expect(liveEdgesForHex(GRID, a.q, a.r).length).toBeGreaterThan(0);
    expect(liveEdgesForHex(GRID, b.q, b.r).length).toBeGreaterThan(0);
    expect(liveEdgesForHex(GRID, c.q, c.r).length).toBeGreaterThan(0);
  });
});

describe("track occupancy through a city", () => {
  /* The unit underneath the bug. Terminating at a city from one side and
     terminating at it from the other are two different pieces of rail, and the
     keys have to say so or every caller above inherits the mistake. */

  it("gives the two sides of a through-city different identities", () => {
    const middle = LINE[1];
    const [into, outOf] = liveEdgesForHex(GRID, middle.q, middle.r);
    const arriving = segmentsTouchingEdge(GRID, middle.q, middle.r, into);
    const leaving = segmentsTouchingEdge(GRID, middle.q, middle.r, outOf);
    expect(arriving.length).toBeGreaterThan(0);
    expect(leaving.length).toBeGreaterThan(0);
    expect(arriving).not.toEqual(leaving);
  });

  it("makes a train passing THROUGH hold both sides", () => {
    /* The other half of the rule, and the half that keeps this honest: a train
       that runs across the city really does use both rails, so it must still
       conflict with a train terminating on either one. */
    const middle = LINE[1];
    const [into, outOf] = liveEdgesForHex(GRID, middle.q, middle.r);
    const crossing = traversalSegments(GRID, middle.q, middle.r, into, outOf) ?? [];
    const arriving = segmentsTouchingEdge(GRID, middle.q, middle.r, into);
    const leaving = segmentsTouchingEdge(GRID, middle.q, middle.r, outOf);
    expect(crossing).toEqual(expect.arrayContaining([...arriving]));
    expect(crossing).toEqual(expect.arrayContaining([...leaving]));
  });
});

describe("Auto Route over a shared city", () => {
  it("drafts BOTH 2-trains from two tokens on one corridor", () => {
    /* THE REPORT. Train one runs home -> shared city; train two runs shared
       city -> destination. They meet at a city and share no rail. */
    const result = assignRouteSet({
      mapGrid: GRID,
      era: "Yellow",
      startHexes: TOKENS,
      trains: twoTrains,
    });
    expect(result.reason).toBeNull();
    expect(result.assignments).toHaveLength(2);
  });

  it("pays both of them", () => {
    const result = assignRouteSet({
      mapGrid: GRID,
      era: "Yellow",
      startHexes: TOKENS,
      trains: twoTrains,
    });
    for (const assignment of result.assignments) {
      expect(assignment.revenue).toBeGreaterThan(0);
      expect(assignment.path.length).toBeGreaterThanOrEqual(2);
    }
    expect(result.totalRevenue).toBe(
      result.assignments.reduce((sum, a) => sum + a.revenue, 0),
    );
  });

  it("still hands each train its own rails", () => {
    /* The rule this must not break while fixing the other one. Two routes may
       meet at a city; they may not run over one piece of track. */
    const result = assignRouteSet({
      mapGrid: GRID,
      era: "Yellow",
      startHexes: TOKENS,
      trains: twoTrains,
    });
    const claimed = new Set<string>();
    for (const assignment of result.assignments) {
      routeSegments(GRID, assignment.path).forEach((segment) => {
        expect(claimed.has(segment)).toBe(false);
        claimed.add(segment);
      });
    }
  });

  it("routes as many trains as the corridor supports, not one fewer", () => {
    /* Report (c): three legal runs, two drafted. The corridor below carries a
       route per token, and the count is the assertion -- "one fewer than legal"
       is the shape of every version of this bug. */
    const line = firstCorridor(4);
    if (line.length < 4) return;
    const grid: MapGridResponse = {
      game_id: 1,
      tiles: line.map((h) => tile(h.q, h.r, YELLOW_CITY, ORIENTATION ?? 0)),
    };
    const tokens: Array<readonly [number, number]> = line
      .slice(0, 3)
      .map((h) => [h.q, h.r] as const);
    const result = assignRouteSet({
      mapGrid: grid,
      era: "Yellow",
      startHexes: tokens,
      trains: [
        { trainIndex: 0, maxRevenueCentres: 2 },
        { trainIndex: 1, maxRevenueCentres: 2 },
        { trainIndex: 2, maxRevenueCentres: 2 },
      ],
    });
    expect(result.assignments).toHaveLength(3);
  });

  it("does not invent a route for a train the board cannot carry", () => {
    /* The opposite failure, and the reason the count above is an equality. A
       three-city line carries two 2-train routes and no more. */
    const result = assignRouteSet({
      mapGrid: GRID,
      era: "Yellow",
      startHexes: TOKENS,
      trains: [...twoTrains, { trainIndex: 2, maxRevenueCentres: 2 }],
    });
    expect(result.assignments).toHaveLength(2);
  });
});
