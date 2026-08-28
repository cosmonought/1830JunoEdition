/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 894 / 895 (harness): THE GRAY HEX'S THIRD ARM, AND THE RED AREA'S RAIL
// ==================================================================
//
// TWO REPORTS, ONE SHAPE. "The route marker cuts off at D14" and "the red off-board segments are not
// coloured" both turned out to be a hex whose track the ROUTER or the OVERLAY could not see, while the base
// board drew it perfectly. In each case the picture was right and the data behind it was not, which is why
// neither was findable by looking at the screen.
//
// BOTH WERE DIAGNOSED BY MEASUREMENT rather than by reading, and the measurements are the assertions below:
//
//   printedArtworkEdgePairs("D14")   ->  [[0,3],[4,null]]   before #894, and edge 4 joined nothing
//   printedArtworkEdgePairs("F2")    ->  []                 before #895, for all seven red hexes
//
// WHY A SOURCE-FREE TEST. Everything here is asked of the shipped functions on the real board data. There is
// no fixture: the board is the subject, and a hand-built one would prove the arithmetic and not the map.

import {
  OFFBOARD_STUB_SHAFT_END_FRACTION,
  OFFBOARD_STUB_TIP_FRACTION,
  printedArtworkEdgePairs,
} from "../components/TileGraphics";
import { traversalsFrom } from "./trackSegments";
import { GRAY_HEXES, OFFBOARD_TRACKS, STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { liveEdgesForHex } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";

/** No laid tiles: every hex under test is preprinted and can never hold one. */
const GRID = { game_id: 0, tiles: [] } as unknown as MapGridResponse;

const at = (label: string) => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no such board hex: ${label}`);
  return hex;
};

/** Every exit `traversalsFrom` offers, having entered at `entryEdge`. */
const exitsFrom = (label: string, entryEdge: number): number[] => {
  const hex = at(label);
  return traversalsFrom(GRID, hex.q, hex.r, entryEdge).map((t) => t.exitEdge).sort();
};

describe("Rochester connects all three of its arms (design note #894)", () => {
  it("declares three edges in the first place", () => {
    /* THE PREMISE. `GRAY_HEXES` is the authority on which edges D14 has, and every assertion below is about
       whether the ARTWORK agrees with it. If this list ever shrank to two the rest would pass vacuously by
       agreeing about less. */
    expect(GRAY_HEXES.D14.edges.slice().sort()).toEqual([0, 3, 4]);
    expect(liveEdgesForHex(GRID, at("D14").q, at("D14").r).slice().sort()).toEqual([0, 3, 4]);
  });

  it("authors them as three spokes into the city", () => {
    /* THE FIX ITSELF, AND THE REASON IT WORKS. `pathVariantsForTraversal` joins two rails through the interior
       only when BOTH are spokes -- "exactly one end on an edge". The old straight rail had both ends on edges,
       so it could never be half of a hub crossing, and edge 4's spoke had nothing to meet.
       Asserted as the SHAPE rather than as path strings: what matters is that each rail lands on one edge and
       dead-ends inside, which is what `null` means here. */
    const pairs = printedArtworkEdgePairs("D14");
    expect(pairs).toHaveLength(3);
    const edges = pairs.map((pair) => {
      expect(pair).not.toBeNull();
      const [a, b] = pair!;
      /* Exactly one end on an edge. `expect(...).toBe` on the count rather than a truthiness check, so a rail
         with BOTH ends interior -- a rail joined to nothing, which would silently vanish -- fails here. */
      expect([a, b].filter((end) => end !== null)).toHaveLength(1);
      return (a ?? b)!;
    });
    expect(edges.slice().sort()).toEqual([0, 3, 4]);
  });

  it("lets a train enter by any arm and leave by either other", () => {
    /* THE REPORTED SYMPTOM, STATED AS THE ROUTER SEES IT. Before #894 this was `4 -> []`: a train arriving at
       Rochester from edge 4 had no way out and no way in, so that whole side of the hex was unroutable and the
       drawn route stopped dead. All three directions are asserted, because a fix that opened one arm and left
       another is the half-fix this codebase keeps producing. */
    expect(exitsFrom("D14", 4)).toEqual([0, 3]);
    expect(exitsFrom("D14", 0)).toEqual([3, 4]);
    expect(exitsFrom("D14", 3)).toEqual([0, 4]);
  });

  it("offers exactly one way through each pair, not two", () => {
    /* THE CONTROL AGAINST OVERSHOOTING. Splitting a rail could have produced duplicate chains for the 0-3
       crossing -- the old whole rail AND the new spoke pair -- which would give the route planner a phantom
       choice and #737's variant machinery something meaningless to pick between. Altoona is the only hex on
       this board with a genuine second way through. */
    const hex = at("D14");
    for (const entry of [0, 3, 4]) {
      const exits = traversalsFrom(GRID, hex.q, hex.r, entry).map((t) => t.exitEdge);
      expect(new Set(exits).size).toBe(exits.length);
    }
  });

  it("leaves the other gray hexes exactly as they were", () => {
    /* THE BLAST RADIUS, MEASURED. #894 changed one catalog entry, and these are the hexes that would show it
       if the change had leaked into the shared join logic instead. Each is a plain edge-to-edge connector and
       must stay one. */
    expect(exitsFrom("A17", 4)).toEqual([5]);
    expect(exitsFrom("F24", 2)).toEqual([3]);
    expect(exitsFrom("F6", 4)).toEqual([5]);
    expect(exitsFrom("C15", 1)).toEqual([3]);
    // Richmond is a dead-end stub and must remain unroutable in both directions.
    expect(exitsFrom("K15", 2)).toEqual([]);
  });
});

describe("the red off-board areas carry rails the overlay can colour (design note #895)", () => {
  const labels = Object.keys(OFFBOARD_TRACKS);

  it("has red areas to test", () => {
    // The `forEach`-over-nothing shape: an empty list would pass every loop below.
    expect(labels.length).toBeGreaterThan(0);
  });

  it("gives every red hex one authored rail per declared edge", () => {
    /* THE BUG, INVERTED INTO AN ASSERTION. `printedArtworkEdgePairs` returned `[]` for all seven, so
       `drawRouteOverlays` had no geometry to stroke and the route simply stopped being drawn at the board's
       edge. Asserted per LABEL rather than as a total, so one hex silently missing cannot be covered by
       another having extra. */
    for (const label of labels) {
      const declared = OFFBOARD_TRACKS[label];
      const pairs = printedArtworkEdgePairs(label);
      /* THE PAIRS, NOT THE `Path2D`s. `printedArtworkPaths` is `tracks.map((d) => new Path2D(d))` and `Path2D`
         does not exist outside a browser, so asserting it here would buy a jsdom dependency for this whole
         file and re-count a list that is already counted. The pairs are DERIVED from the same track strings,
         so an empty catalog entry fails right here. */
      expect([label, pairs.length]).toEqual([label, declared.length]);

      /* Each rail is a SPOKE landing on its own declared edge -- a stub, not a crossing. This is also what
         keeps them inert to routing: a spoke pair can only ever be joined through the interior, and #484
         refuses to cross an off-board hex before this catalog is ever consulted. */
      const edges = pairs.map((pair) => {
        const [a, b] = pair!;
        expect([label, [a, b].filter((end) => end !== null).length]).toEqual([label, 1]);
        return (a ?? b)!;
      });
      expect([label, edges.slice().sort()]).toEqual([label, declared.slice().sort()]);
    }
  });

  it("still refuses to let a route cross one", () => {
    /* THE CONTROL, and the one that would matter most if it broke. Giving the red areas authored rails must
       NOT turn them into through-hexes: a route ENDS at an off-board area, and a train that could run in one
       side and out the other would score two off-board bonuses on one pass. */
    for (const label of labels) {
      const hex = at(label);
      for (const edge of OFFBOARD_TRACKS[label]) {
        expect([label, edge, traversalsFrom(GRID, hex.q, hex.r, edge)]).toEqual([label, edge, []]);
      }
    }
  });

  it("puts the coloured shaft exactly where the drawn shaft is", () => {
    /* THE DRIFT THIS FIX EXISTS TO PREVENT. `drawOffboardTrack` strokes from the edge midpoint to where the
       arrowhead begins; the generated rail must be that same segment or the colour lands beside the track. The
       two are tied by these constants, and this asserts the ARITHMETIC that relates them -- the head is
       0.20 of a hex long and the edge sits one apothem out, so the shaft ends that far short of the tip.
       A bare "the constants are equal" check would pass on two numbers that were both wrong. */
    const apothem = Math.sqrt(3) / 2;
    expect(OFFBOARD_STUB_SHAFT_END_FRACTION).toBeCloseTo(OFFBOARD_STUB_TIP_FRACTION + 0.2 / apothem, 5);
    /* And the rail really starts ON the edge rather than somewhere plausible near it: F2's edge 0 is the
       catalog's own east midpoint, which every other entry in the file also starts from. */
    const pairs = printedArtworkEdgePairs("F2");
    expect(pairs.some((pair) => pair![0] === 0 || pair![1] === 0)).toBe(true);
  });

  it("does not disturb the preprinted hexes that already had artwork", () => {
    /* THE MERGE'S BLAST RADIUS. The generated entries are spread into the same catalog as the hand-authored
       ones, so a label collision would silently replace a real hex's artwork. No off-board label is a gray or
       landmark label today; this asserts that rather than trusting it. */
    for (const label of labels) {
      expect([label, GRAY_HEXES[label]]).toEqual([label, undefined]);
    }
    // And a hand-authored neighbour still reads exactly as before.
    expect(printedArtworkEdgePairs("E23")).toEqual([[1, 5]]);
  });
});
