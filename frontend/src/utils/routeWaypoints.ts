// The manual route-point vocabulary, moved out of `App.tsx` unchanged:
// `RoutePoint`, `routePointsToWaypoints` and `axialHexDistance`.
//
// None of it depends on `HexGridRenderer`'s pixel geometry -- only on `{ q, r }`
// being a conventional axial pair, which is what makes the group safe to lift
// out on its own.

import type { RouteWaypointDto } from "./sessionKey";

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
  return points.map((point) =>
    point.cityNode === undefined
      ? { hex: point.hexLabel }
      : { hex: point.hexLabel, city_node: point.cityNode },
  );
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
export function routeIncludesOwnedToken(
  points: readonly { q: number; r: number }[],
  tokenHexes: ReadonlyArray<readonly [number, number]>,
): boolean {
  if (points.length === 0 || tokenHexes.length === 0) return false;
  return points.some((point) =>
    tokenHexes.some(([q, r]) => q === point.q && r === point.r),
  );
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
  tokenHexes: ReadonlyArray<readonly [number, number]>,
): string | null {
  if (points.length < 2) return null;
  if (tokenHexes.length === 0) {
    return "This corporation has no station token on the board yet, so no route can include one. Place its home station first.";
  }
  if (!routeIncludesOwnedToken(points, tokenHexes)) {
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
): string | null {
  if (!blocksThrough || points.length < 3) return null;
  for (let at = 1; at < points.length - 1; at += 1) {
    const point = points[at];
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
