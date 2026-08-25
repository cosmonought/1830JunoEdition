// frontend/src/utils/cityBypass.ts
//
// Track that goes AROUND a city, and when a route has to take it.
//
// ==================================================================
//  DESIGN NOTE 808: THE BOW WAS EXPRESSIBLE, ROUTABLE, AND UNREACHABLE
// ==================================================================
//
// REPORTED, as two problems that turned out to be three instances of one:
//   "when a corporation tried to manually run through the tile, it showed the route going into and out of the
//    station (and counting its $10 revenue) rather than following the bypass ... when I clicked 'run route' it
//    spit back the error that Altoona is tokened out."
//   "the auto-route did not select the highest value route ... it could have run Pittsburgh to Baltimore
//    (bypassing the tokened out Altoona) for $80 [but ran] Cleveland to Chicago for $70."
//
// H12 IS THE PENNSYLVANIA'S HOME, WHICH IS WHY THIS IS NOT A CORNER CASE. Altoona is a one-slot city, and the
// PRR's home token goes in it. From the moment the PRR floats, the middle of the board is walled for the other
// seven corporations for the rest of the game -- which is exactly why 1830 prints a bow around this one hex,
// and why a bow that does not work is not a missing flourish.
//
// #737 DID THE HARD HALF AND STOPPED ONE STEP SHORT. It made the two arms distinguishable (`traversalsFrom`
// yields one entry per WAY through, not per exit), priceable (`sandboxRouteBreakdown` reads a `bypass` flag,
// paying nothing and spending no stop) and reachable by the depth-first search. What it did not do is tell the
// three places that decide whether a crossing is LEGAL:
//
//   1. THE AUTO-TRACER asked `blocksThrough` on ARRIVAL at a hex and used the answer to gate the whole
//      expansion loop. The bow is a property of the ARM, and no arm had been chosen yet -- so the walk arrived
//      at H12, recorded the run that ends there (#730's terminus rule, correct), and refused to go further.
//      Measured before it was fixed: the tracer returns `["H14","H12"]` where `["H14","H12","H10"]` is legal.
//   2. THE MANUAL CHECK tests interior hexes BY POSITION, which #730a chose deliberately and wrote down:
//      "a drawn route is a list of hexes with no recorded entry side". It cannot ask which arm, so it assumed
//      the one through the station and refused the route.
//   3. AND `RoutePoint` COULD NOT CARRY THE ANSWER ANYWAY. `App` converts a traced path to route points and
//      drops `variant` and `bypass` on the way, so even a bow the tracer had correctly chosen was re-priced
//      through the station. That is why the manual readout showed the $10: the flag existed at both ends of
//      the pipe and nothing carried it across the middle.
//
// THE RULE THIS MODULE ENCODES, and the one the report settled: TAKE THE BOW WHEN THE STATION IS SHUT TO YOU.
// Asked directly, the answer was "PRR is the only corporation that would run through the station if it has to
// for route legality; every other corporation would likely choose to skip a $10 revenue center even if it
// wasn't tokened out."
//   THOSE TWO RULES AGREE FOR THE WHOLE GAME IN PRACTICE, because after the PRR places its home token the
//   station IS shut to everybody else -- so "skip it by preference" and "skip it because you must" pick the
//   same arm on every turn that matters. They diverge only before the PRR floats, and there taking the $10 is
//   free money for a train with a stop to spare.
//   WHAT IS NOT BUILT, stated rather than left to be discovered: a corporation that COULD enter the city
//   cannot choose the bow by hand. That case is the PRR wanting to skip its own home to save a stop, and it
//   needs a control on the waypoint -- new UI on exactly one hex of the board. Recorded as known debt in the
//   same spirit as #730a's own.
//
// INTERIOR ONLY, and for a different reason than #730a's. A route that ENDS on a hex stops there by
// definition; you cannot bypass a centre you are terminating at. So the first and last points are never
// marked, which also keeps #730's terminus rule intact -- a run into a shut city is still a legal run.

import type { MapGridResponse } from "../components/hexContractTypes";
import { traversalsFrom } from "./trackSegments";

/** Design note #730's shape, re-stated rather than imported, so this module depends on no router. */
export type BlocksThrough = (q: number, r: number, cityIndex: number) => boolean;

/** Whether any way through `(q, r)` misses its revenue centre.
 *
 *  Every entry edge is tried because the question is about the HEX, not about one crossing -- and a caller
 *  working from a drawn route has no entry edge to offer. On the shipped board exactly one hex answers true;
 *  the loop is cheap and it means a future tile with a bow is covered without this file being edited. */
export function hexOffersBypass(mapGrid: MapGridResponse, q: number, r: number): boolean {
  for (let entry = 0; entry < 6; entry += 1) {
    if (traversalsFrom(mapGrid, q, r, entry).some((way) => way.bypass === true)) return true;
  }
  return false;
}

/** Whether any city on `(q, r)` is shut against the corporation `blocksThrough` was bound to.
 *
 *  Both cities, like `routeBlockedCityReason` -- and for its reason: without an entry edge there is no way to
 *  say which one a crossing would enter. On a two-city hex this is the strict direction. */
export function cityShutAt(
  q: number,
  r: number,
  blocksThrough: BlocksThrough | undefined,
): boolean {
  if (!blocksThrough) return false;
  for (let city = 0; city < 2; city += 1) {
    if (blocksThrough(q, r, city)) return true;
  }
  return false;
}

/** THE ONE PREDICATE. Whether a route crossing `(q, r)` must go around the centre rather than through it.
 *
 *  Consulted by the auto-tracer, by the manual legality check and by the manual pricing, so the three cannot
 *  answer differently -- which is the failure this codebase keeps finding (#748a, #775, #791) and the failure
 *  that produced this report in the first place. */
export function bypassForcedAt(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  blocksThrough: BlocksThrough | undefined,
): boolean {
  return cityShutAt(q, r, blocksThrough) && hexOffersBypass(mapGrid, q, r);
}

/** A drawn route with its forced crossings marked.
 *
 *  Returns the SAME point objects where nothing changes, so a caller can compare by reference and so a route
 *  on a board with no shut cities is untouched -- the compatibility property #737 asserted for its own change
 *  and the reason every other route on the board still prices exactly as before. */
export function withForcedBypass<T extends { q: number; r: number }>(
  points: readonly T[],
  mapGrid: MapGridResponse,
  blocksThrough: BlocksThrough | undefined,
): T[] {
  if (!blocksThrough || points.length < 3) return points.slice();
  return points.map((point, at) => {
    // Interior only: a route that ends here stops here, and #730 says that is legal.
    if (at === 0 || at === points.length - 1) return point;
    if (!bypassForcedAt(mapGrid, point.q, point.r, blocksThrough)) return point;
    return { ...point, bypass: true };
  });
}
