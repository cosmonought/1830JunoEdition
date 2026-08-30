// frontend/src/utils/routeConnection.ts
//
// Whether a drafted route may step from where it is to where the player clicked -- asked of the RAIL, not of
// the hex.
//
// ==================================================================
//  DESIGN NOTE 1025: THE MANUAL DRAW WAS THE LAST HEX-AS-A-NODE HOLDOUT
// ==================================================================
//
// REPORTED, three symptoms of one model error:
//   "The manual router allows visually jumping between disconnected tracks on the same hex (e.g., Tile 45 and
//    Brown OO tiles). If a player clicks an adjacent hex that connects to the other track on their current
//    hex, the UI draws the line as if it were legal."
//   "Players receive an error that they cannot re-enter a hex, even when using a completely separate track
//    segment that does not touch a previously visited city/node."
//   "the router throws a 'hex already visited' error instead of a 'no legal connection' error."
//
// `editRouteDraft` RULE 6 APPENDED ANY ADJACENT CLICK WITH NO CONNECTIVITY TEST AT ALL. #276 made that
// deliberate -- "this is what keeps hex-by-hex drawing available for disambiguating a branch" -- and the
// disambiguation it was built for is exactly the case it gets wrong: on a hex with two unconnected tracks,
// which arm the route is ON decides which neighbours it can reach, and the rule asked neither.
//
// THIS IS THE MODEL ERROR THIS CODEBASE HAS BEEN REMOVING ONE WALK AT A TIME. `trackSegments` #0 took it out
// of the pricing, `trackReach` #4 out of the network reach ("a three-hex patch with #20 in the middle reported
// the far hex as networked, across two rails with no connection between them"), #852 out of the route search,
// and #9 out of the manual bridge. The one walk nobody had converted is the one the player drives by hand.
//
// SO THE STATE IS `(hex, arrival edge)` HERE TOO, and it is derived from the draft rather than stored: the
// point before `last` names the edge the route came in on, which is all `traversalsFrom` needs to say which
// exits that arm actually reaches.
//
// AND THE VISITED RULE FOLLOWS FROM THE SAME CHANGE. Once a route is a chain of TRANSITS rather than a list of
// hexes, "have I been here" is a question about rails: 1830 forbids running the same track twice, not
// entering the same hex twice, and on a two-track hex those differ. `segmentsUsedBy` is that rule stated in
// the units the tile actually has.

import { HEX_NEIGHBOR_OFFSETS, liveEdgesForHex } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";
import { neighbourAcross, traversalsFrom, type SegmentKey } from "./trackSegments";

/** The minimum a drafted point carries for this module. */
export interface ConnectablePoint {
  q: number;
  r: number;
}

/** The edge of `from` that faces `to`, or `-1` when they are not neighbours. */
export function edgeToward(from: ConnectablePoint, to: ConnectablePoint): number {
  return HEX_NEIGHBOR_OFFSETS.findIndex(
    (offset) => from.q + offset[0] === to.q && from.r + offset[1] === to.r,
  );
}

/** One step of a drafted route: which rails it used crossing a hex, and which way it left. */
export interface RouteTransit {
  /** The hex being crossed. */
  q: number;
  r: number;
  exitEdge: number;
  /** Design note #737: which authored way through, where a hex offers more than one. */
  variant?: number;
  /** Design note #737: that way never reached the hex's revenue centre. */
  bypass?: boolean;
  segments: readonly SegmentKey[];
}

/** Every rail the drafted route has already run along.
 *
 *  ==================================================================
 *   DESIGN NOTE 1025: "VISITED" IS ABOUT RAILS, NOT ABOUT HEXES
 *  ==================================================================
 *
 * REPORTED: "Players receive an error that they cannot re-enter a hex, even when using a completely separate
 * track segment that does not touch a previously visited city/node."
 *
 * AND 1830 AGREES WITH THE PLAYER. The rule is that a train may not run over the same track twice; a hex
 * carrying two unconnected tracks offers two, and using both is one route over two rails rather than two
 * routes over one. `editRouteDraft` compared COORDINATES, which is the same rule stated in a unit the tile
 * does not have.
 *
 * DERIVED, NOT STORED. The draft is a list of points and this walks it, so there is no second record of the
 * route to fall out of step with the first -- the failure `App.tsx` #275's mirror produced two batches ago.
 *
 * A HEX WITH ONE WAY THROUGH BEHAVES EXACTLY AS BEFORE: its single transit yields its rails, and re-entering
 * it would reuse them. What changes is only the hexes where the old rule was answering a question the board
 * does not ask. */
export function segmentsUsedBy(
  mapGrid: MapGridResponse,
  points: readonly ConnectablePoint[],
): Set<SegmentKey> {
  const used = new Set<SegmentKey>();
  for (let at = 1; at < points.length - 1; at += 1) {
    const arrivalEdge = edgeToward(points[at], points[at - 1]);
    const exitEdge = edgeToward(points[at], points[at + 1]);
    if (arrivalEdge < 0 || exitEdge < 0) continue;
    /* THE FIRST TRANSIT MATCHING THE EXIT, which is the same tie-break `bridgeWaypoints` takes and is exact
       on the shipped board: the only hex with two ways through is Altoona, whose arms share both edges, and
       both arms use rails the route would be reusing either way. */
    const transit = traversalsFrom(mapGrid, points[at].q, points[at].r, arrivalEdge).find(
      (way) => way.exitEdge === exitEdge,
    );
    transit?.segments.forEach((key) => used.add(key));
  }
  return used;
}

/** How the route would leave `last` to reach `click`, or `null` when no rail joins them.
 *
 *  ==================================================================
 *   DESIGN NOTE 1025: WHICH ARM THE ROUTE IS ON DECIDES WHERE IT CAN GO
 *  ==================================================================
 *
 * THE FIRST STEP LEAVES BY ANY RAIL. `points.length === 1` is the player standing in a city they have not yet
 * left, and a route starts INSIDE the station -- so every live edge of that hex is available. The same
 * exemption `bridgeWaypoints` makes for its start and `reachableTrack` makes for a token (#4).
 *
 * EVERY LATER STEP IS BOUND BY ITS ARRIVAL. Having come in on one rail, only the exits that rail reaches are
 * offered -- which is the whole of item 1: on Tile 45 or a Brown OO tile the two tracks join different edges,
 * and the old rule let a click hop between them because both were "on the hex".
 *
 * AND BOTH SIDES MUST CARRY RAIL. `neighbourAcross` is the two-sided test (#1: "a dead-end stub otherwise
 * reads as connected to whatever sits beyond it"), so a click on a neighbour whose tile does not reach the
 * shared edge is refused here rather than drawn and refused later. */
export function connectionForClick(
  mapGrid: MapGridResponse,
  points: readonly ConnectablePoint[],
  click: ConnectablePoint,
): RouteTransit | null {
  const last = points[points.length - 1];
  if (!last) return null;

  const exitEdge = edgeToward(last, click);
  if (exitEdge < 0) return null;

  // Both sides, or it is a stub facing a blank.
  const across = neighbourAcross(mapGrid, last.q, last.r, exitEdge);
  if (!across || across.q !== click.q || across.r !== click.r) return null;

  const previous = points[points.length - 2];
  if (previous === undefined) {
    /* The start: inside the city, free to leave by any of its rails. `liveEdgesForHex` is what the other two
       walks ask in the same position, so the three agree about what a start may do. */
    return liveEdgesForHex(mapGrid, last.q, last.r).includes(exitEdge)
      ? { q: last.q, r: last.r, exitEdge, segments: [] }
      : null;
  }

  const arrivalEdge = edgeToward(last, previous);
  /* A DRAFT CAN CONTAIN A JUMP the drawing surface did not enforce -- and an arrival edge of `-1` fed to
     `traversalsFrom` would name no rail. Treated as "cannot say" rather than as "no connection", so the
     caller keeps the permissive pre-#1025 behaviour on a malformed draft rather than refusing a route it
     cannot evaluate. */
  if (arrivalEdge < 0) {
    return { q: last.q, r: last.r, exitEdge, segments: [] };
  }

  const transit = traversalsFrom(mapGrid, last.q, last.r, arrivalEdge).find(
    (way) => way.exitEdge === exitEdge,
  );
  if (!transit) return null;
  return {
    q: last.q,
    r: last.r,
    exitEdge,
    variant: transit.variant,
    bypass: transit.bypass,
    segments: transit.segments,
  };
}
