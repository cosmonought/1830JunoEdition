// frontend/src/utils/trackSegments.ts
//
// What a train can actually do inside one hex.
//
// Design note #0: A HEX IS NOT A NODE. Every path-walking surface asked "does hex A carry rail toward hex B,
// and B back toward A?" -- which is `liveEdgesForHex` on both sides, and treats a hex as a NODE through which
// everything connects to everything. Most hexes are, so the answer is usually right; on the ones that are not
// it is silently and badly wrong. Tile #20 is TWO SEPARATE STRAIGHTS authored as two rails that cross visually
// and do not touch, so a corporation meeting edge 0 was told it reached whatever sits beyond edge 1 --
// confirmed on the real board. The OO and double-city tiles have the same shape, and New York's two spurs are
// the loudest case: `hexCanvasPrimitives.ts #226` already had to fix the ROUTE GLOW for exactly this reason,
// and the connectivity layer never got the same treatment.
// So this module answers the question a hex actually poses: entering at edge E, which edges may I leave by,
// and along WHICH rail? The first half is connectivity, the second is occupancy.
//
// Design note #1: the answer already existed and nothing consumed it -- `pathsForTraversal` in
// `TileGraphics.ts` has resolved this since #217. No new geometry is invented here; the geometry was correct
// and only the renderer was asking.
//
// Design notes #2/#3/#484: see `docs/ai_architecture/routing_pathfinding.md`.

import {
  HEX_NEIGHBOR_OFFSETS,
  isBoardHex,
  liveEdgesForHex,
} from "../components/hexGeometry";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import {
  TILE_GRAPHICS_CATALOG,
  artworkPathsForTraversal,
  printedArtwork,
  printedPathsForTraversal,
} from "../components/TileGraphics";
import type { MapGridResponse } from "../components/hexContractTypes";

/** `"q,r"` -- the same key every other module on this board uses. */
export function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

const LABEL_BY_COORD: ReadonlyMap<string, string> = new Map(
  STATIC_BOARD_HEXES.map((hex) => [hexKey(hex.q, hex.r), hex.label]),
);

/* Design note #484: A RED OFF-BOARD AREA IS A TERMINUS, NOT A JUNCTION. Off-board track is a bare edge list
   with no per-rail structure, so it fell through to #2's "every live edge connects to every other" fallback --
   which is the conservative direction for ORDINARY track and is not conservative at all here, because the
   surplus reach is not a longer path through real rail. It is a WORMHOLE.
   Chicago (F2) prints stubs on edges 0, 1 and 5, so a corporation whose rail met F4 was told it reached E3 and
   G3 too. Every red zone has the same shape -- A11 spliced B10 to B12, K13 spliced J14 to J12, B24 spliced B22
   to C23, J2 spliced J4 to I3: five false junctions, each fusing two unrelated networks into one.
   1830 IS UNAMBIGUOUS HERE: a red area is a revenue destination where a route ENDS. A train runs in and stops.
   SO THERE IS NO TRAVERSAL -- not a restricted one, none -- which is the identical answer this function already
   gives for two curves that never touch. Stating it once here reaches every caller.
   THE HEX ITSELF IS STILL REACHED, and that distinction is the whole fix: this answers "may I pass THROUGH",
   not "may I get here". `neighbourAcross` is untouched, so a red zone still joins the network and still counts
   as a destination. What it no longer does is hand out the hexes behind it.
   DERIVED FROM `type: "RedOffboard"`, the same discriminator `evaluateHexForTileLaying` gates on, so the two
   tables cannot drift into disagreeing about which hexes are red. */
const OFFBOARD_TERMINAL_COORDS: ReadonlySet<string> = new Set(
  STATIC_BOARD_HEXES.filter((hex) => hex.type === "RedOffboard").map((hex) =>
    hexKey(hex.q, hex.r),
  ),
);

/** True when `(q, r)` is a red off-board revenue terminal -- a hex a route
 *  may END at but never pass through. See design note #484. */
export function isOffboardTerminal(q: number, r: number): boolean {
  return OFFBOARD_TERMINAL_COORDS.has(hexKey(q, r));
}

/* `isBoardHex` lives in `hexGeometry` -- it is a question about board
   geometry, and the tile-legality filter asks it too. Re-exported here so a
   route-walking caller does not need a second import for it. */
export { isBoardHex };

export function boardLabelAt(q: number, r: number): string | undefined {
  return LABEL_BY_COORD.get(hexKey(q, r));
}

/** A single, board-wide identity for one piece of rail -- design note #3.
 *  1830 forbids two of a corporation's trains from running over the same track. Barring whole HEXES was
 *  documented as deliberately stricter than the rule, and it forbids the commonest legal shape on a busy board:
 *  two trains crossing the same hex on the two arms of a crossover, or reaching the two separate stations of an
 *  OO tile. On a late-game map that costs real revenue.
 *  A segment key is `q,r#index`, where `index` is the authored rail's own position in its hex's artwork. Two
 *  trains sharing a hex are fine; two trains sharing a `q,r#index` are not.
 *  A hex with no per-rail structure (design note #2) reports `q,r#*` -- one shared identity for the whole hex,
 *  reproducing the old exclusion exactly where nothing better is knowable. */
export type SegmentKey = string;

const WHOLE_HEX_SEGMENT = "*";

function segmentKey(q: number, r: number, index: number | typeof WHOLE_HEX_SEGMENT): SegmentKey {
  return `${hexKey(q, r)}#${index}`;
}

/** One legal way through a hex: in at `entryEdge`, out at `exitEdge`, over
 *  these rails. */
export interface HexTraversal {
  exitEdge: number;
  /** Every rail the transit runs along. Two for a hub crossing (entry spoke
   *  plus exit spoke), one for a through tile. */
  segments: readonly SegmentKey[];
}

/** The authored rails joining `entryEdge` to `exitEdge` on this hex, or `null` when the two are not joined by
 *  continuous track. `null` is the whole point: it is the answer `liveEdgesForHex` cannot give, and the reason
 *  design note #0's bug existed. */
export function traversalSegments(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  entryEdge: number,
  exitEdge: number,
): readonly SegmentKey[] | null {
  if (entryEdge === exitEdge) return null;

  /* Design note #484: a red off-board area is where a route ends. Tested
     FIRST, ahead of the laid-tile lookup, so the answer cannot depend on a
     chain reporting a tile on a hex that can never hold one -- terminality
     is a property of the board, not of what happens to sit on it. */
  if (isOffboardTerminal(q, r)) return null;

  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laid && TILE_GRAPHICS_CATALOG[laid.tile_id]) {
    const indices = artworkPathsForTraversal(laid.tile_id, laid.orientation, entryEdge, exitEdge);
    return indices.length === 0 ? null : indices.map((index) => segmentKey(q, r, index));
  }

  const label = LABEL_BY_COORD.get(hexKey(q, r));
  if (label !== undefined && printedArtwork(label) !== undefined) {
    const indices = printedPathsForTraversal(label, entryEdge, exitEdge);
    return indices.length === 0 ? null : indices.map((index) => segmentKey(q, r, index));
  }
  // New York is authored outside `PRINTED_GRAPHICS_CATALOG` (design note #229), and `printedPathsForTraversal`
  // already resolves it -- but `printedArtwork` does not see it, so it is asked for explicitly rather than
  // falling through to "everything connects", which is exactly the claim its two disconnected spurs must not
  // make.
  if (label === "G19") {
    const indices = printedPathsForTraversal(label, entryEdge, exitEdge);
    return indices.length === 0 ? null : indices.map((index) => segmentKey(q, r, index));
  }

  /* Design note #2: no per-rail structure here. Fall back to the edge test,
     which is what every caller did before this module existed. */
  const edges = liveEdgesForHex(mapGrid, q, r);
  if (!edges.includes(entryEdge) || !edges.includes(exitEdge)) return null;
  return [segmentKey(q, r, WHOLE_HEX_SEGMENT)];
}

/** Every way out of this hex, having entered at `entryEdge`. STRICTLY PORT TO PORT: an exit appears only when
 *  an authored rail joins the two edges, so two disconnected curves on one tile yield two disjoint answers
 *  rather than one junction.
 *  WHAT THIS DOES NOT CHECK, and the previous version of this comment wrongly claimed it did: whether anything
 *  lies beyond the exit. The both-sides rule lives in `neighbourAcross` and has to stay there -- a tile lay
 *  extends the network across an edge with nothing behind it yet, so a caller looking for build sites needs the
 *  exits WITHOUT that filter. Applying it here would have hidden every extension on the board. */
export function traversalsFrom(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  entryEdge: number,
): HexTraversal[] {
  const out: HexTraversal[] = [];
  for (const exitEdge of liveEdgesForHex(mapGrid, q, r)) {
    if (exitEdge === entryEdge) continue;
    const segments = traversalSegments(mapGrid, q, r, entryEdge, exitEdge);
    if (!segments) continue;
    out.push({ exitEdge, segments });
  }
  return out;
}

/** The neighbour across `edge`, when the two hexes genuinely join.
 *
 *  Design note #1 in `trackReach.ts`: joined only when BOTH sides carry
 *  matching rail. A one-sided test walks off the end of a dead-end stub. */
export function neighbourAcross(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  edge: number,
): { q: number; r: number; arrivalEdge: number } | null {
  const offset = HEX_NEIGHBOR_OFFSETS[edge];
  if (!offset) return null;
  const nq = q + offset[0];
  const nr = r + offset[1];
  if (!isBoardHex(nq, nr)) return null;
  const back = (edge + 3) % 6;
  if (!liveEdgesForHex(mapGrid, nq, nr).includes(back)) return null;
  if (!liveEdgesForHex(mapGrid, q, r).includes(edge)) return null;
  return { q: nq, r: nr, arrivalEdge: back };
}

/** Every rail on this hex that touches `edge` -- what a route TERMINATING
 *  here occupies. A terminus runs in and stops, so it uses the entry rail
 *  and nothing else. */
export function segmentsTouchingEdge(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  edge: number,
): readonly SegmentKey[] {
  /* Derived by asking which exits this edge reaches: the rails carrying those transits are the rails touching it.
     A terminus on a hub uses only its own spoke, so the entry spoke is the intersection of every traversal's
     segment list -- but taking the FIRST traversal's first segment is both simpler and correct, because
     `pathsForTraversal` always returns the entry rail first. */
  for (const exitEdge of liveEdgesForHex(mapGrid, q, r)) {
    if (exitEdge === edge) continue;
    const segments = traversalSegments(mapGrid, q, r, edge, exitEdge);
    if (segments && segments.length > 0) return [segments[0]];
  }
  /* A dead-end: rail reaches this edge and goes nowhere else on the hex.
     Still occupied by a train that stops here, so it needs an identity --
     the whole-hex one, which is the honest answer when no traversal can
     name a rail. */
  return liveEdgesForHex(mapGrid, q, r).includes(edge)
    ? [segmentKey(q, r, WHOLE_HEX_SEGMENT)]
    : [];
}
