// frontend/src/utils/trackSegments.ts
//
// What a train can actually do inside one hex.
//
// ===================================================================
//  DESIGN NOTE 0: A HEX IS NOT A NODE
// ===================================================================
//
// Every path-walking surface in this app -- the network reach used to gate
// tile laying, the Auto-Route tracer, the manual waypoint bridge -- asked
// the same question of the board and got the same wrong answer:
//
//     "does hex A carry rail toward hex B, and B back toward A?"
//
// That is `liveEdgesForHex` on both sides, and it treats a hex as a NODE
// through which everything connects to everything. Most hexes are, so the
// answer is usually right. On the ones that are not, it is silently and
// badly wrong:
//
//   TILE #20 IS TWO SEPARATE STRAIGHTS -- edges 0-3 and 1-4, authored as
//   two rails that cross visually and do not touch. The edge test reports
//   all four edges present and therefore all four mutually reachable, so a
//   corporation whose track meets edge 0 was told it reaches whatever sits
//   beyond edge 1. Confirmed on the real board before this file existed: a
//   three-hex patch with #20 in the middle reported the far hex as part of
//   the network across two rails that never meet.
//
//   THE OO TILES AND THE DOUBLE-CITY TILES have the same shape -- two
//   stations, each with its own pair of edges, no path between them. New
//   York (#54/#62) is the loudest case: its two spurs are physically
//   disconnected, and design note #226 in `hexCanvasPrimitives.ts` already
//   had to fix the ROUTE GLOW for exactly this reason. The connectivity
//   layer never got the same treatment.
//
// So this module answers the question a hex actually poses: entering at
// edge E, which edges may I leave by, and along WHICH rail? Both halves
// matter -- the first is connectivity (design note #1), the second is
// occupancy (design note #2).
//
// ===================================================================
//  DESIGN NOTE 1: THE ANSWER ALREADY EXISTED; NOTHING CONSUMED IT
// ===================================================================
//
// `pathsForTraversal` in `TileGraphics.ts` has resolved exactly this since
// design note #217 -- it returns the authored rail(s) joining two edges, or
// `[]` when they are not joined, and it already knows that two hub spokes
// only connect if their interior ends MEET. The route overlay has used it
// for several passes to stroke the one rail a train runs along.
//
// This module is that primitive lifted to the whole board: laid tile,
// preprinted hex, or neither, one call. No new geometry is invented here;
// the geometry was correct and only the renderer was asking.
//
// ===================================================================
//  DESIGN NOTE 2: WHERE THERE IS NO ARTWORK, EVERYTHING CONNECTS
// ===================================================================
//
// Landmarks and off-board red hexes carry track that `hexBoardData` records
// as a bare EDGE LIST -- `LANDMARK_TRACKS`, `OFFBOARD_TRACKS` -- with no
// per-rail structure at all. There is nothing to be precise with, so those
// fall back to the old behaviour: every live edge connects to every other.
//
// That is the conservative direction for connectivity (it can only report
// MORE reach, never less, so it cannot hide a legal move) and it is stated
// here rather than left implicit, because it is the one place this module
// still gives the answer design note #0 calls wrong. Closing it needs those
// two tables to gain rail structure, which is a data change rather than a
// logic one.
//
// The same fallback covers a hex whose tile id is absent from the artwork
// catalog -- a catalog gap should not make the board less connected than it
// is, and `TILE_CATALOG_SIZE` already guards against gaps appearing.

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

/* `isBoardHex` lives in `hexGeometry` -- it is a question about board
   geometry, and the tile-legality filter asks it too. Re-exported here so a
   route-walking caller does not need a second import for it. */
export { isBoardHex };

export function boardLabelAt(q: number, r: number): string | undefined {
  return LABEL_BY_COORD.get(hexKey(q, r));
}

/**
 * A single, board-wide identity for one piece of rail.
 *
 * DESIGN NOTE 3: WHY OCCUPANCY NEEDS THIS AND HEX IDs DO NOT SUFFICE.
 *
 * 1830 forbids two of a corporation's trains from running over the same
 * track. The previous drafter approximated that by barring whole HEXES,
 * documented at the time as deliberately stricter than the rule -- safe for
 * a suggestion, but it forbids the commonest legal shape on a busy board:
 * two trains crossing the same hex on the two arms of a crossover, or
 * reaching the two separate stations of an OO tile. On a late-game map that
 * approximation costs real revenue.
 *
 * A segment key is `q,r#index`, where `index` is the authored rail's own
 * position in its hex's artwork. Two trains sharing a hex are fine; two
 * trains sharing a `q,r#index` are not.
 *
 * A hex with no per-rail structure (design note #2) reports `q,r#*` -- one
 * shared identity for the whole hex, which reproduces the old whole-hex
 * exclusion exactly where nothing better is knowable.
 */
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

/** The authored rails joining `entryEdge` to `exitEdge` on this hex, or
 *  `null` when the two are not joined by continuous track.
 *
 *  `null` is the whole point: it is the answer `liveEdgesForHex` cannot
 *  give, and the reason design note #0's bug existed. */
export function traversalSegments(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  entryEdge: number,
  exitEdge: number,
): readonly SegmentKey[] | null {
  if (entryEdge === exitEdge) return null;

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
  // New York is authored outside `PRINTED_GRAPHICS_CATALOG` (design note
  // #229), and `printedPathsForTraversal` already resolves it -- but
  // `printedArtwork` does not see it, so it is asked for explicitly rather
  // than falling through to "everything connects", which is exactly the
  // claim its two disconnected spurs must not make.
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

/** Every way out of this hex, having entered at `entryEdge`.
 *
 *  Only exits whose neighbour is a real board hex carrying matching rail --
 *  the both-sides rule (`trackReach`'s design note #1), applied here so no
 *  caller has to remember it. */
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
  /* Derived by asking which exits this edge reaches: the rails carrying
     those transits are the rails touching it. A terminus on a hub uses only
     its own spoke, so the entry spoke is the intersection of every
     traversal's segment list -- but taking the FIRST traversal's first
     segment is both simpler and correct, because `pathsForTraversal`
     always returns the entry rail first. */
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
