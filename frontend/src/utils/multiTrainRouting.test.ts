// frontend/src/utils/multiTrainRouting.test.ts
//
// ==================================================================
//  DESIGN NOTE 492b (harness): THE ROUTER WAS NOT THE BUG
// ==================================================================
//
// REPORTED: "auto-route only calculates a path for a single train, even if
// multiple trains and valid routes exist."
//
// It does not, and this file is the evidence. `assignRouteSet` runs three
// strategies (sequential widest-first, sequential narrowest-first, and a
// joint combination search) plus a fill pass, and it assigns every train it
// can find distinct rails for. The report is real but its cause is one layer
// downstream -- `RunManualRoute` is one message per train and each write
// replaced `last_route_revenue`, so a correct three-train plan arrived at
// Dividends worth one train. See design note #492 in `dividendStep.ts`.
//
// This harness exists because that distinction is easy to lose. Without it,
// the next person reading the report edits the router -- which is where the
// investigation naturally starts and where there is nothing to fix.
//
// THE FIXTURE IS THE HARD PART, and two earlier attempts at it were wrong in
// a way worth recording. Laying city tiles across board hexes at a UNIFORM
// orientation builds one corridor, so only one route exists and one train is
// the correct answer. Laying them at ROTATING orientations builds almost
// nothing, because `neighbourAcross` needs matching rail on both sides and
// randomly-turned straights rarely have it. Both produced "one assignment
// for three trains" and both would have been read as confirming the bug.
//
// So the corridors here are DERIVED: the orientation at which the tile is a
// 0-3 straight is searched for rather than assumed, and two disjoint runs of
// board hexes are found by walking edge 0's own neighbour offset. That gives
// a board where two genuinely separate routes exist, which is the only board
// on which "does it route more than one train" is a real question.

import { HEX_NEIGHBOR_OFFSETS, liveEdgesForHex } from "../components/hexGeometry";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { assignRouteSet } from "./routeAutoTrace";

const BOARD = new Set(STATIC_BOARD_HEXES.map((h) => `${h.q},${h.r}`));
const key = (q: number, r: number) => `${q},${r}`;
/** The ordinary yellow city -- every plain-city hex's first upgrade. */
const YELLOW_CITY = 57;

function tile(q: number, r: number, tileId: number, orientation: number): MapTileEntry {
  return { q, r, tile_id: tileId, orientation, landmark: null };
}

/** The rotation at which `tileId` genuinely joins edges 0 and 3, measured
 *  off `liveEdgesForHex` rather than assumed from the catalog's base mask. */
function straightOrientation(tileId: number): number | null {
  for (let o = 0; o < 6; o += 1) {
    const grid: MapGridResponse = { game_id: 1, tiles: [tile(0, 0, tileId, o)] };
    const edges = liveEdgesForHex(grid, 0, 0);
    if (edges.includes(0) && edges.includes(3)) return o;
  }
  return null;
}

/** A run of up to `len` real board hexes stepping along edge 0. */
function corridorFrom(q0: number, r0: number, len: number) {
  const [dq, dr] = HEX_NEIGHBOR_OFFSETS[0];
  const out: Array<{ q: number; r: number }> = [];
  for (let i = 0; i < len; i += 1) {
    const q = q0 + dq * i;
    const r = r0 + dr * i;
    if (!BOARD.has(key(q, r))) break;
    out.push({ q, r });
  }
  return out;
}

/** Two disjoint straight corridors, each long enough to carry a route. */
function twoCorridors(): Array<Array<{ q: number; r: number }>> {
  const found: Array<Array<{ q: number; r: number }>> = [];
  const claimed = new Set<string>();
  for (const hex of STATIC_BOARD_HEXES) {
    if (found.length >= 2) break;
    const run = corridorFrom(hex.q, hex.r, 6);
    if (run.length < 5) continue;
    if (run.some((h) => claimed.has(key(h.q, h.r)))) continue;
    run.forEach((h) => claimed.add(key(h.q, h.r)));
    found.push(run);
  }
  return found;
}

const ORIENTATION = straightOrientation(YELLOW_CITY);
const CORRIDORS = twoCorridors();

function boardOf(runs: Array<Array<{ q: number; r: number }>>): MapGridResponse {
  const tiles: MapTileEntry[] = [];
  for (const run of runs) for (const h of run) tiles.push(tile(h.q, h.r, YELLOW_CITY, ORIENTATION ?? 0));
  return { game_id: 1, tiles };
}

function trains(count: number, maxRevenueCentres = 4) {
  return Array.from({ length: count }, (_, i) => ({ trainIndex: i, maxRevenueCentres }));
}

describe("the fixture", () => {
  it("found a real straight rotation and two disjoint corridors", () => {
    /* If either of these fails, every assertion below is measuring an empty
       board and would pass against a router that does nothing at all. */
    expect(ORIENTATION).not.toBeNull();
    expect(CORRIDORS).toHaveLength(2);
    expect(CORRIDORS[0].length).toBeGreaterThanOrEqual(5);
    expect(CORRIDORS[1].length).toBeGreaterThanOrEqual(5);
  });
});

describe("assignRouteSet across several trains", () => {
  const grid = boardOf(CORRIDORS);
  const starts: Array<readonly [number, number]> = [
    [CORRIDORS[0][0].q, CORRIDORS[0][0].r],
    [CORRIDORS[1][0].q, CORRIDORS[1][0].r],
  ];

  it("routes one train when there is one train", () => {
    const result = assignRouteSet({ mapGrid: grid, era: "Yellow", startHexes: starts, trains: trains(1) });
    expect(result.assignments).toHaveLength(1);
    expect(result.totalRevenue).toBeGreaterThan(0);
  });

  it("routes BOTH trains when two disjoint corridors exist", () => {
    // THE ASSERTION THE REPORT IS ABOUT. One assignment here would be the
    // reported bug; two is the behaviour the router already had.
    const result = assignRouteSet({ mapGrid: grid, era: "Yellow", startHexes: starts, trains: trains(2) });
    expect(result.assignments).toHaveLength(2);
    expect(result.reason).toBeNull();
  });

  it("earns strictly more with two trains than with one", () => {
    /* The stronger claim, and the one a "returns two entries" test alone
       would not make: the second train has to be carrying REVENUE, not
       merely occupying a slot in the array. */
    const one = assignRouteSet({ mapGrid: grid, era: "Yellow", startHexes: starts, trains: trains(1) });
    const two = assignRouteSet({ mapGrid: grid, era: "Yellow", startHexes: starts, trains: trains(2) });
    expect(two.totalRevenue).toBeGreaterThan(one.totalRevenue);
  });

  it("gives every assigned train a distinct, runnable path", () => {
    const result = assignRouteSet({ mapGrid: grid, era: "Yellow", startHexes: starts, trains: trains(2) });
    const signatures = new Set<string>();
    for (const assignment of result.assignments) {
      // A route is two paying stops or it is not a route.
      expect(assignment.path.length).toBeGreaterThanOrEqual(2);
      expect(assignment.revenue).toBeGreaterThan(0);
      signatures.add(assignment.path.map((p) => p.hexLabel).join(">"));
    }
    // Two trains cannot be handed the same rails.
    expect(signatures.size).toBe(result.assignments.length);
  });

  it("totals what the individual assignments add up to", () => {
    /* The seam the reported bug actually lives at, asserted at the router so
       the two halves stay distinguishable: the ROUTER's total is the sum of
       its per-train figures. What went wrong downstream was that only one of
       those figures survived the dispatch. */
    const result = assignRouteSet({ mapGrid: grid, era: "Yellow", startHexes: starts, trains: trains(3) });
    const summed = result.assignments.reduce((sum, a) => sum + a.revenue, 0);
    expect(result.totalRevenue).toBe(summed);
  });

  it("leaves a surplus train idle rather than inventing work for it", () => {
    /* Two corridors, three trains. `assignRouteSet`'s own design note #7:
       "trains that get nothing are not a failure" -- a third route drawn
       over rails the first two hold would be refused by the contract. */
    const result = assignRouteSet({ mapGrid: grid, era: "Yellow", startHexes: starts, trains: trains(3) });
    expect(result.assignments.length).toBeLessThanOrEqual(2);
    expect(result.assignments.length).toBeGreaterThanOrEqual(2);
  });

  it("reports a reason, not an empty success, when nothing can run", () => {
    const bare: MapGridResponse = { game_id: 1, tiles: [] };
    const result = assignRouteSet({ mapGrid: bare, era: "Yellow", startHexes: starts, trains: trains(2) });
    expect(result.assignments).toHaveLength(0);
    expect(result.reason).not.toBeNull();
  });

  it("reports a reason when the corporation has no token at all", () => {
    const result = assignRouteSet({ mapGrid: grid, era: "Yellow", startHexes: [], trains: trains(2) });
    expect(result.assignments).toHaveLength(0);
    expect(result.reason).not.toBeNull();
  });
});
