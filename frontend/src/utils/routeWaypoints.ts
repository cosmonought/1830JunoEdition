// frontend/src/utils/routeWaypoints.ts
//
// THE MANUAL ROUTE-POINT VOCABULARY, moved out of `App.tsx` unchanged.
//
// `RoutePoint` is the shape the map hands back when a player clicks a hex;
// `routePointsToWaypoints` converts a list of them into the DTO the contract
// takes; `axialHexDistance` is what decides whether two clicked points are
// actually adjacent. One type and the two functions that read it.
//
// As the design note below already argues, none of this depends on
// `HexGridRenderer`'s pixel geometry -- only on `{ q, r }` being a
// conventional axial pair. That independence is what makes the group safe to
// lift out on its own, and stating it here keeps the reason visible from the
// file that now holds the code.

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
   *  `undefined` -- the normal case -- means "this hex has one stop, or
   *  none": a town, plain connector track, or a single-city tile. Only a
   *  genuinely multi-city hex (New York's #62, the OO tiles) needs it, and
   *  the map has no two-city picker yet, so nothing sets it today. It is
   *  carried on the point rather than bolted on at dispatch time so that
   *  `routePointsToWaypoints` stays a pure rename of fields, and so adding
   *  that picker later is a change to ONE click handler rather than to the
   *  payload shape. */
  cityNode?: number;
}

/** Converts the map's in-progress route into the contract's
 *  `RunManualRoute` payload -- Step 4.5 Batch 3, item 1.
 *
 *  This is the single place the UI's route representation becomes the wire
 *  format, so the deprecated `hex_path: string[]` shape cannot survive
 *  anywhere by accident. `city_node` is omitted entirely (rather than sent
 *  as `null`) when a point names no station: the field is `Option<usize>`
 *  with `#[serde(default)]`-style optionality on the Rust side, and an
 *  absent key is the cleaner encoding of "unspecified". */

export function routePointsToWaypoints(points: readonly RoutePoint[]): RouteWaypointDto[] {
  return points.map((point) =>
    point.cityNode === undefined
      ? { hex: point.hexLabel }
      : { hex: point.hexLabel, city_node: point.cityNode },
  );
}

/** Standard axial-coordinate hex distance -- the number of hex-to-hex steps
 *  between `a` and `b`. This formula only depends on `(q, r)` being a
 *  conventional axial hex coordinate pair (which `HexGridRenderer`'s
 *  `pixelToAxial` already produces, design note #11), not on that file's own
 *  pointy-top pixel geometry/edge-numbering internals -- so this file can
 *  validate route-point adjacency without importing anything from that
 *  component beyond the plain `{ q, r }` values its `onHexClick` already
 *  reports. */
export function axialHexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  const dq = b.q - a.q;
  const dr = b.r - a.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

/* ==================================================================
 *  DESIGN NOTE 474: A ROUTE MUST CONTAIN A TOKEN, NOT START AT ONE
 * ==================================================================
 *
 * REPORTED (critical): the Run Routes validator requires a route to begin
 * at, or contain, the corporation's HOME station token.
 *
 * The audit found something slightly different from the report and worse:
 * the manual validator checked no token at all. `handleRunTrains` filtered
 * drafts on revenue, train distance and terminus, and nothing else -- so a
 * player could draw a run across somebody else's network entirely, price
 * it, and dispatch it for the contract to refuse.
 *
 * Where the HOME hex genuinely was load-bearing is the auto-router
 * (`assignRouteSet`), which starts its search from `station_token_hexes`.
 * That is correct as a search strategy and would be wrong as a rule, and it
 * is easy to mistake one for the other -- the two arms it builds through a
 * token put that token in the MIDDLE of the route, which is exactly what
 * 1830 requires.
 *
 * THE RULE, stated once so both halves agree: a route is legal if at least
 * one hex on it carries a station token belonging to the running
 * corporation. Not the first hex. Not the home hex. Any hex, any token.
 *
 * WHY "ANY TOKEN" AND NOT "THE HOME TOKEN" MATTERS IN PLAY. A corporation
 * that has placed a second or third token can run routes nowhere near where
 * it started -- that is most of what the extra tokens are FOR. Requiring
 * the home hex would forbid the ordinary mid-game run and get more wrong as
 * the game went on, which is the shape of bug that looks fine in testing
 * and breaks a real session.
 *
 * COMPARED BY COORDINATE, never by label. `hexLabel` on a `RoutePoint` is a
 * display name ("New York (G19)") per `boardHexLabel`'s design note #242,
 * and `station_token_hexes` is `(q, r)` pairs. Matching on the human string
 * would work until the first hex whose name has a place in it.
 */
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
 *  Phrased for the player rather than as a boolean, because the two failing
 *  cases call for different actions and the difference is not obvious from
 *  the board:
 *
 *    NO TOKENS AT ALL -- the corporation has not placed its home station
 *    yet, which since design note #416 is a thing the president must do
 *    deliberately. The route is fine; the corporation is not ready.
 *
 *    TOKENS, BUT NOT ON THIS ROUTE -- the run is somewhere the corporation
 *    does not reach. That is a routing mistake, and the fix is to redraw.
 *
 *  A route SHORTER THAN TWO HEXES is not judged here at all: it is not yet
 *  a route, and design note #256's own message already covers it. */
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
