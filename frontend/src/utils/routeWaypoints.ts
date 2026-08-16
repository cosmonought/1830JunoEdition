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
