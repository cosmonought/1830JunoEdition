// frontend/src/utils/routeTruncate.ts
//
// Removing one stop from a drafted route.
//
// ==================================================================
//  DESIGN NOTE 1024: A ROUTE IS A PATH, SO A STOP CANNOT BE PLUCKED OUT OF THE MIDDLE
// ==================================================================
//
// REQUESTED: "Add a 'Remove' button (such as a small 'X' icon) to each individual hex/stop listed in the
// active route preview UI ... Clicking the 'X' on a specific hex should splice that specific hex (and
// potentially any hexes that follow it, if your routing logic requires contiguous paths from the start node)
// out of the active route array, allowing the player to seamlessly resume drawing from the new end point."
//
// IT DOES REQUIRE A CONTIGUOUS PATH, and the parenthetical is therefore the whole design. `editRouteDraft`
// only ever appends hexes that are adjacent to the last one, or bridges a gap with hexes that are; every
// consumer downstream -- the pricer, the bypass marking, the token-block validator, the reducer -- reads the
// array as an ordered walk. Lifting hex 3 out of six would leave 2 and 4 side by side in a list that claims
// they are joined, and nothing in the pipeline checks that claim: it would price a route no train can run.
//
// SO REMOVAL TRUNCATES, and the tail goes with the hex. That is the honest reading of the request's own "and
// potentially any hexes that follow it", and it is what makes the second half true -- the route ends at the
// stop BEFORE the one removed, which is exactly a point a player can carry on drawing from.
//
// THE ALTERNATIVE WAS CONSIDERED AND DECLINED, and it is worth saying why rather than leaving it to be
// re-proposed. Removing the hex and re-bridging from its predecessor to its successor would often preserve
// the tail -- and would silently route the player through hexes they did not choose, or fail outright where
// the removed hex was the only join. A route the player did not draw, presented as the route they drew, is
// this codebase's most-repeated bug wearing a helpful face (#775, #891). Truncation can surprise a player;
// it cannot lie to them.
//
// PURE, AND NOT IN THE COMPONENT. The splice is a rule about an array, so it is testable as one -- the same
// argument `routeDraftEdit.ts` makes for itself: "it takes no refs, no setters, and no React."

/** The minimum a drafted point has to carry for this module to find it. */
export interface TruncatableRoutePoint {
  hexLabel: string;
}

/** Everything before the first appearance of `hexLabel`.
 *
 *  RETURNS THE SAME ARRAY when the hex is not in the route, so a caller can compare by reference and a stale
 *  click -- the label of a stop that has already gone -- changes nothing rather than clearing the draft. That
 *  is the difference between a no-op and a wipe, and a UI that can double-fire an event needs it to be the
 *  first one.
 *
 *  THE FIRST OCCURRENCE, deliberately. A drafted route is a simple path -- `editRouteDraft` refuses a hex
 *  already routed over -- so a repeat should not arise; if one ever does, truncating at the EARLIER of the two
 *  is the answer that leaves a shorter, certainly-legal route rather than a longer one built on a hex that is
 *  in the array twice. */
export function truncateRouteAtHex<T extends TruncatableRoutePoint>(
  points: readonly T[],
  hexLabel: string,
): readonly T[] {
  const at = points.findIndex((point) => point.hexLabel === hexLabel);
  if (at < 0) return points;
  return points.slice(0, at);
}

/** What removing this stop will cost, for the control's own label.
 *
 *  A BUTTON THAT DROPS FOUR HEXES SHOULD SAY SO. The request asks for an 'X' per stop, and an 'X' reads as
 *  "remove this one" -- which is true only for the last stop. Rather than hide the difference or refuse the
 *  control on interior stops, the caller is given the count so the tooltip can state it: #783's rule, that a
 *  control whose effect a player cannot predict is worse than one they cannot press. */
export function stopsRemovedByTruncating<T extends TruncatableRoutePoint>(
  points: readonly T[],
  hexLabel: string,
): number {
  const at = points.findIndex((point) => point.hexLabel === hexLabel);
  return at < 0 ? 0 : points.length - at;
}
