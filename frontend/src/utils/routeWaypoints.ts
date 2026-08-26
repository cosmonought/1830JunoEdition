// The manual route-point vocabulary, moved out of `App.tsx` unchanged:
// `RoutePoint`, `routePointsToWaypoints` and `axialHexDistance`.
//
// None of it depends on `HexGridRenderer`'s pixel geometry -- only on `{ q, r }`
// being a conventional axial pair, which is what makes the group safe to lift
// out on its own.

import type { RouteWaypointDto } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import { HEX_NEIGHBOR_OFFSETS, cityExitEdges } from "../components/hexGeometry";
import type { StationToken } from "./trackReach";

/* ------------------------------------------------------------------ */
/* Manual Route Point UI -- see design note #11                       */
/* ------------------------------------------------------------------ */

/** One player-clicked point in a manually-built route path -- mirrors
 *  `HexGridRenderer`'s own `onHexClick` payload shape (minus the raw pixel
 *  coordinates, which this feature has no use for once the click is
 *  recorded). */
export interface RoutePoint {
  q: number;
  r: number;
  hexLabel: string;
  /** Step 4.5 Batch 3, item 1: which station on this hex the stop is.
   *
   *  `undefined` -- the normal case -- means "this hex has one stop, or none": a
   *  town, plain connector track, or a single-city tile. Only a genuinely
   *  multi-city hex (New York's #62, the OO tiles) needs it, and the map has no
   *  two-city picker yet. Carried on the point rather than added at dispatch time
   *  so `routePointsToWaypoints` stays a pure rename of fields, and so adding that
   *  picker later changes ONE click handler rather than the payload shape. */
  cityNode?: number;
  /** Design note #808: WHICH WAY THROUGH, carried at last.
   *
   *  `variant` names the authored rail chain and `bypass` says that chain misses the hex's revenue centre.
   *  #737 put both on `TracedHex` and taught `sandboxRouteBreakdown` to read `bypass`; `RoutePoint` -- which
   *  sits between them, and is what every drafted route actually is -- had neither. So `App` converted a
   *  traced path to route points, dropped the two fields, and the route was re-priced through the station.
   *  The reported "$10 counted rather than the bypass followed" is that gap, and it applied to an AUTO route
   *  as much as to a hand-drawn one -- the flag existed at both ends of the pipe and nothing carried it. */
  variant?: number;
  bypass?: boolean;
}

/** Converts the map's in-progress route into the contract's `RunManualRoute`
 *  payload -- Step 4.5 Batch 3, item 1.
 *
 *  The single place the UI's route representation becomes the wire format, so the
 *  deprecated `hex_path: string[]` shape cannot survive anywhere by accident.
 *  `city_node` is omitted entirely (rather than sent as `null`) when a point names
 *  no station: the field is `Option<usize>` on the Rust side, and an absent key is
 *  the cleaner encoding of "unspecified". */

export function routePointsToWaypoints(points: readonly RoutePoint[]): RouteWaypointDto[] {
  return points.map((point) => {
    const waypoint: RouteWaypointDto = { hex: point.hexLabel };
    if (point.cityNode !== undefined) waypoint.city_node = point.cityNode;
    /* Design note #808: only when TRUE. `bypass` is absent on every hex but Altoona's bow, and an explicit
       `false` on 40 waypoints would be noise on the wire and a diff on every route -- the same argument the
       paragraph above makes for omitting `city_node` rather than sending null. #737's own compatibility case
       asserts that an unflagged route prices exactly as it did before, and this keeps that true by default. */
    if (point.bypass === true) waypoint.bypass = true;
    return waypoint;
  });
}

/** Standard axial-coordinate hex distance -- the number of hex-to-hex steps
 *  between `a` and `b`.
 *
 *  Depends only on `(q, r)` being a conventional axial pair (which `pixelToAxial`
 *  already produces, design note #11), not on `HexGridRenderer`'s pointy-top
 *  pixel geometry or edge numbering -- so this file can validate route-point
 *  adjacency without importing anything from that component. */
export function axialHexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  const dq = b.q - a.q;
  const dr = b.r - a.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

/* Design note #474: A ROUTE MUST CONTAIN A TOKEN, NOT START AT ONE.

   The audit found something worse than the report: the manual validator checked
   no token at all. `handleRunTrains` filtered on revenue, train distance and
   terminus, so a player could draw a run across somebody else's network
   entirely, price it, and dispatch it for the contract to refuse.

   Where the HOME hex genuinely was load-bearing is the auto-router, which starts
   its search from `station_token_hexes` -- correct as a SEARCH STRATEGY and
   wrong as a RULE, and easy to mistake one for the other, since the two arms it
   builds put that token in the MIDDLE of the route.

   THE RULE: a route is legal if at least one hex on it carries a station token
   belonging to the running corporation. Not the first hex. Not the home hex. Any
   hex, any token -- extra tokens exist precisely so a corporation can run
   nowhere near where it started.

   COMPARED BY COORDINATE, never by label: `hexLabel` is a display name ("New
   York (G19)", design note #242) and `station_token_hexes` is `(q, r)` pairs. */
/* ==================================================================
    DESIGN NOTE 853: THE ROUTE'S OWN SHAPE NAMES THE CITY
   ==================================================================

   ASKED, after #852 fixed the auto-router: "Are you saying a manual route would still be able to run from
   city 1 even without NNH's network connected to it?"

   YES, IT COULD, and the gap was not where I had put it. #852a blamed `bridgeWaypoints` and said the fix
   needed `RouteWaypointDto` to carry a city -- a contract change. That was wrong twice over:

     THE REAL HOLE IS THIS FUNCTION. It compared `(q, r)` pairs, so ANY route touching New York satisfied
     "contains one of your tokens" -- including one that only ever entered by the other city's rail. The
     bridge is a way to draw such a route; this is what accepts it.

     AND NO CONTRACT CHANGE IS NEEDED. A drawn route is a list of hexes, and the hexes on either side of a
     point determine the edges the route uses AT that point. `cityForArrival` needs an arrival edge and #730a
     concluded one "cannot be asked here" -- true of a single hex in isolation, false of a hex with a
     neighbour before or after it. `hexCanvasPrimitives.ts` #689 has been deriving exactly these edges to
     DRAW the route through the right city; the rule simply never asked the same question.

   THE FIRST AND LAST POINTS ARE NOT SPECIAL. A first point has no predecessor and a successor, a last point
   has a predecessor and no successor, and either one is enough to name a city. Only a one-hex "route" has
   neither, and that is not a route (#256).

   `[q, r]` STILL MEANS THE WHOLE HEX, as everywhere else since #686: one city, or a caller that did not say.
   Without `mapGrid` the check also falls back to coordinates, which is the pre-#853 behaviour exactly -- a
   fixture with no board cannot be asked about geometry, and refusing every route would be the worse answer. */

/** The edge index from `(q, r)` toward an adjacent hex, or `null` when they are not neighbours. */
function edgeToward(
  from: { q: number; r: number },
  to: { q: number; r: number } | undefined,
): number | null {
  if (!to) return null;
  const index = HEX_NEIGHBOR_OFFSETS.findIndex(
    ([dq, dr]) => from.q + dq === to.q && from.r + dr === to.r,
  );
  return index < 0 ? null : index;
}

export function routeIncludesOwnedToken(
  points: readonly { q: number; r: number }[],
  tokens: ReadonlyArray<StationToken>,
  /** Design note #853: needed only to resolve a city's edges. Omitted keeps the coordinate-only rule. */
  mapGrid?: MapGridResponse,
): boolean {
  if (points.length === 0 || tokens.length === 0) return false;
  return points.some((point, index) => {
    const match = tokens.find(([q, r]) => q === point.q && r === point.r);
    if (!match) return false;
    const cityIndex = match.length > 2 ? (match[2] as number) : null;
    if (cityIndex === null || mapGrid === undefined) return true;
    /* THE EDGES THIS ROUTE ACTUALLY USES HERE -- toward the hex before, and toward the hex after. A route
       that merely lists the hex is not passing through the token's city unless one of its own rails belongs
       to that city. */
    const used = [
      edgeToward(point, points[index - 1]),
      edgeToward(point, points[index + 1]),
    ].filter((edge): edge is number => edge !== null);
    if (used.length === 0) return true; // a lone point: not a route, and #256 says so elsewhere.
    const owned = cityExitEdges(mapGrid, point.q, point.r, cityIndex);
    return used.some((edge) => owned.includes(edge));
  });
}

/** Why this route cannot run for want of a token, or `null` when it can.
 *
 *  Phrased for the player rather than as a boolean, because the two failing cases
 *  call for different actions: NO TOKENS AT ALL means the corporation has not
 *  placed its home station yet (a deliberate act since design note #416) and the
 *  route is fine; TOKENS BUT NOT ON THIS ROUTE is a routing mistake, and the fix
 *  is to redraw.
 *
 *  A route shorter than two hexes is not judged here at all -- it is not yet a
 *  route, and design note #256's own message covers it. */
export function routeTokenBlockReason(
  points: readonly { q: number; r: number }[],
  tokens: ReadonlyArray<StationToken>,
  /** Design note #853: the board, so a two-city hex can be judged by the city rather than the coordinate. */
  mapGrid?: MapGridResponse,
): string | null {
  if (points.length < 2) return null;
  if (tokens.length === 0) {
    return "This corporation has no station token on the board yet, so no route can include one. Place its home station first.";
  }
  if (!routeIncludesOwnedToken(points, tokens, mapGrid)) {
    /* THE SENTENCE ALREADY SAID "A CITY", not "a hex", which is what made the old implementation a quiet lie
       rather than a documented simplification. It needs no rewording now that it is true. */
    return "A route must pass through a city this corporation has a station token in — anywhere along the run, not just at the ends.";
  }
  return null;
}


/** Why a hand-drawn route is illegal because of a tokened-out city, or `null`.
 *
 *  ==================================================================
 *   DESIGN NOTE 730a: THE TRACER CANNOT PRODUCE ONE; A PLAYER CAN DRAW ONE
 *  ==================================================================
 *
 *  #730 taught the auto-tracer to stop at a wall, which fixes every route the app proposes. It fixes nothing
 *  about the routes a player draws by hand, and those go to the same dispatch -- so the fix has to exist twice
 *  or the manual path becomes the way around the rule. That is #712's lesson applied before the report rather
 *  than after it: a rule enforced on one of two paths is a rule with a door next to it.
 *
 *  INTERIOR ONLY, which is the whole rule in one word. REPORTED: "the token out city must be treated as a
 *  terminus." A terminus is legal; passing is not. So the first and last points are exempt by position, and
 *  everything between them must be passable.
 *
 *  BY POSITION RATHER THAN BY ARRIVAL EDGE, unlike the two walks. A drawn route is a list of hexes with no
 *  recorded entry side, so "which city did this enter" cannot be asked here. Every city on an interior hex is
 *  therefore tested, which is stricter than the rules on a two-city hex where the route passes through the
 *  unblocked half. Recorded as known debt rather than hidden: the strict direction refuses a legal route
 *  visibly, with a sentence naming the hex, which a player can act on -- where the loose direction would let
 *  an illegal run price up and be refused by the contract with no explanation.
 */
export function routeBlockedCityReason(
  points: readonly { q: number; r: number }[],
  blocksThrough: ((q: number, r: number, cityIndex: number) => boolean) | undefined,
  labelFor?: (q: number, r: number) => string | null,
  /** Design note #808: whether this hex offers a way through that misses its centre.
   *
   *  A CALLBACK, because the paragraph at the top of this file is a promise: it validates route points
   *  "without importing anything from that component", and answering this needs the tile artwork. Injected
   *  like `blocksThrough` and `labelFor` above, and omitted by every caller that has no board to consult --
   *  which reproduces the pre-#808 behaviour exactly. */
  offersBypass?: (q: number, r: number) => boolean,
): string | null {
  if (!blocksThrough || points.length < 3) return null;
  for (let at = 1; at < points.length - 1; at += 1) {
    const point = points[at];
    /* Design note #808: THE ONE HEX WHERE "MAY I PASS" HAS TWO ANSWERS. A full city says nothing about track
       that goes around it, so a hex with a bow is not a wall -- and refusing here is what made Altoona
       impassable for the seven corporations that are not the PRR, whose home token fills its only slot.
       Checked before the cities rather than inside the loop: the bow clears the hex, not one of its cities. */
    if (offersBypass?.(point.q, point.r)) continue;
    for (let city = 0; city < 2; city += 1) {
      if (!blocksThrough(point.q, point.r, city)) continue;
      const where = labelFor?.(point.q, point.r) ?? `${point.q},${point.r}`;
      return (
        `${where} is tokened out by other corporations, so a train may end its run there but not pass ` +
        `through. Redraw the route to stop at ${where} or go around it.`
      );
    }
  }
  return null;
}
