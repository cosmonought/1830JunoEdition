// frontend/src/utils/manualBypass.ts
//
// ==================================================================
//  PHASE 3 W3-E (K-06 / U-17, OD-11): A HAND-DRAWN ROUTE MAY CHOOSE THE BOW
// ==================================================================
//
// `cityBypass.ts` (#808) wrote down the debt this module pays: "a corporation that COULD enter the city cannot
// choose the bow by hand. That case is the PRR wanting to skip its own home to save a stop, and it needs a
// control on the waypoint." The engine has accepted `bypass: true` on an interior waypoint since #737, and the
// route authority (`routeWalk.ts`) refuses it wherever no rail goes around the centre. What was missing was a
// way for a player to SAY it on a route they drew.
//
// WHAT THIS DECIDES, AND WHAT IT DOES NOT:
//   * WHERE THE CHOICE EXISTS. An interior waypoint (never the first or last: a route that ends on a hex stops
//     there) whose ACTUAL crossing -- in by the edge facing the point before, out by the edge facing the point
//     after -- is offered both ways by the rails: one arm through the revenue centre and one around it. Asked
//     of the crossing rather than of the hex, because a hex can carry a bow on one pair of edges and plain
//     track on another; `hexOffersBypass` answers the hex and is not enough here.
//   * WHEN IT IS NOT A CHOICE. `bypassForcedAt` (#808, the one predicate the tracer, the manual check and the
//     pricing already share) says the city is shut to this corporation: the bow is then required, and that is
//     reported as such, never offered as a toggle. Forced marking stays `withForcedBypass`'s, unchanged.
//   * THE REPRESENTATION. `bypass: true` on the `RoutePoint`, exactly the flag `routePointsToWaypoints` already
//     carries to the wire, plus the arm's `variant` so the map draws the bow (#820). Choosing Stop removes the
//     flag, so an unflagged waypoint is the same bytes it always was.
//
// NOT HERE, ON PURPOSE: the auto-router. The search keeps choosing its certified best set (OD-11); a bypass it
// chose arrives in the draft as a flag like any other and is shown as the current choice. Legality is still
// the authority's (`routeSetRefusal`, whole set, shortfall included) -- this only refuses to PUT a flag where
// the rails cannot honour it, so the player is told at the control rather than at Run.

import type { MapGridResponse } from "../components/hexContractTypes";
import { traversalsFrom } from "../gameEngine/trackSegments";
import { bypassForcedAt, type BlocksThrough } from "../gameEngine/cityBypass";
import { edgeToward } from "./routeConnection";
import { routeIncludesOwnedToken, type RoutePoint } from "./routeWaypoints";
import type { StationToken } from "../gameEngine/trackReach";

/** The Stop / Bypass state of one waypoint that has a way around its revenue centre. */
export type BypassChoice =
  | {
      /** Index into the drafted points (the full walk, plain track included). */
      index: number;
      hexLabel: string;
      kind: "choice";
      /** Whether the draft currently goes round (`bypass: true`). */
      bypassed: boolean;
    }
  | {
      index: number;
      hexLabel: string;
      /** The city is closed to this corporation: the bow is the only legal way across. Not a choice. */
      kind: "forced";
    };

interface Ways {
  bowVariant: number;
  throughVariant: number;
}

/** Both arms of the crossing at `index`, or `null` when it is not an interior crossing the rails offer both ways. */
function waysAt(mapGrid: MapGridResponse, points: readonly RoutePoint[], index: number): Ways | null {
  if (index <= 0 || index >= points.length - 1) return null;
  const here = points[index];
  const entry = edgeToward(here, points[index - 1]);
  const exit = edgeToward(here, points[index + 1]);
  if (entry < 0 || exit < 0) return null;
  const ways = traversalsFrom(mapGrid, here.q, here.r, entry).filter((way) => way.exitEdge === exit);
  const bow = ways.find((way) => way.bypass === true);
  const through = ways.find((way) => way.bypass !== true);
  if (!bow || !through) return null;
  return { bowVariant: bow.variant ?? 1, throughVariant: through.variant ?? 0 };
}

/** Whether the crossing at `index` has a rail around its centre -- chosen or forced. The drawing cap asks this:
 *  such a hex may yet cost no stop, so a click is not refused for counting it. */
export function bowAvailableAt(mapGrid: MapGridResponse, points: readonly RoutePoint[], index: number): boolean {
  return waysAt(mapGrid, points, index) !== null;
}

/** The Stop / Bypass state at `index`, or `null` where there is nothing to choose or report. */
export function bypassChoiceAt(
  mapGrid: MapGridResponse,
  points: readonly RoutePoint[],
  index: number,
  blocksThrough: BlocksThrough | undefined,
): BypassChoice | null {
  if (waysAt(mapGrid, points, index) === null) return null;
  const here = points[index];
  if (bypassForcedAt(mapGrid, here.q, here.r, blocksThrough)) {
    return { index, hexLabel: here.hexLabel, kind: "forced" };
  }
  return { index, hexLabel: here.hexLabel, kind: "choice", bypassed: here.bypass === true };
}

/** Every waypoint of a draft that has a way around its centre, in route order. Empty for nearly every route. */
export function bypassChoicesFor(
  mapGrid: MapGridResponse,
  points: readonly RoutePoint[],
  blocksThrough: BlocksThrough | undefined,
): BypassChoice[] {
  const out: BypassChoice[] = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const choice = bypassChoiceAt(mapGrid, points, index, blocksThrough);
    if (choice) out.push(choice);
  }
  return out;
}

export type DraftBypassEdit = { ok: true; points: RoutePoint[] } | { ok: false; reason: string };

/** The player's Stop / Bypass choice at `index`, applied -- or the sentence saying why it cannot be.
 *
 *  Refused where the rails do not offer both arms (an endpoint, a crossing on edges the bow does not join,
 *  any hex without a bow) and where the city is closed (the bow is required; Stop is not the player's to
 *  pick). Returns the SAME array when nothing changes. */
export function setDraftBypass(
  mapGrid: MapGridResponse,
  points: readonly RoutePoint[],
  index: number,
  bypass: boolean,
  blocksThrough: BlocksThrough | undefined,
  /** The waypoint the control was rendered for. A draft that changed under the click is refused, not re-aimed. */
  expectedHexLabel?: string,
): DraftBypassEdit {
  const here = points[index];
  if (!here || (expectedHexLabel !== undefined && here.hexLabel !== expectedHexLabel)) {
    return { ok: false, reason: "That stop is no longer on this route." };
  }
  if (index === 0 || index === points.length - 1) {
    return {
      ok: false,
      reason: `${here.hexLabel} is where this route ${index === 0 ? "starts" : "ends"}, so the train stops there — it cannot be bypassed.`,
    };
  }
  const ways = waysAt(mapGrid, points, index);
  if (!ways) {
    return {
      ok: false,
      reason: `No track goes around the revenue centre at ${here.hexLabel} on this route's way through, so it cannot be bypassed.`,
    };
  }
  if (bypassForcedAt(mapGrid, here.q, here.r, blocksThrough)) {
    return bypass
      ? { ok: true, points: points as RoutePoint[] } // already the only way across; `withForcedBypass` marks it
      : {
          ok: false,
          reason: `${here.hexLabel} is closed to this corporation, so a train may pass it only on the track around it.`,
        };
  }
  if ((here.bypass === true) === bypass) return { ok: true, points: points as RoutePoint[] };
  const { bypass: _drop, ...rest } = here;
  void _drop;
  const next = points.slice();
  next[index] = bypass
    ? { ...rest, variant: ways.bowVariant, bypass: true }
    : { ...rest, variant: ways.throughVariant };
  return { ok: true, points: next };
}

/** Why a draft has no station once its bypassed waypoints are taken out, or `null`.
 *
 *  A bypass is not a visit (R12-2, IL-7): the bow does not reach the station on the hex it goes round, so a PRR
 *  that bypasses Altoona with no other station on the route has none -- and the authority refuses that run.
 *  `routeTokenBlockReason` matches tokens by hex and cannot see the flag, so the draft would look runnable
 *  until Run. Asked only of a draft that HAS a bypass flag, and only of the tokens on bypassed hexes, so every
 *  other route (and every auto draft, which the search already judges with the authority's walk) is untouched. */
export function bypassedStationReason(
  points: readonly RoutePoint[],
  tokens: ReadonlyArray<StationToken>,
  mapGrid: MapGridResponse | undefined,
): string | null {
  const passed = points.filter((point) => point.bypass === true);
  if (passed.length === 0) return null;
  const onPassed = (token: StationToken) => passed.some((point) => point.q === token[0] && point.r === token[1]);
  const kept = tokens.filter((token) => !onPassed(token));
  if (kept.length === tokens.length) return null;
  if (routeIncludesOwnedToken(points, kept, mapGrid)) return null;
  const where = passed.filter((point) => tokens.some((token) => point.q === token[0] && point.r === token[1]))[0];
  return `Bypassing ${where?.hexLabel ?? "that city"} leaves this route without one of this corporation's stations — stop there, or run through another of its stations.`;
}

/** A draft with no bypass flag on its first or last point -- a route stops where it starts and ends.
 *
 *  An edit can leave a flagged waypoint at an end (stepping back, removing a later stop); the authority would
 *  refuse that route ("is where the route ends, so it cannot be bypassed") and the pricing would skip the stop.
 *  Applied wherever the shell writes a hand edit. Returns the SAME array when nothing changes. */
export function clearEndpointBypass(points: RoutePoint[]): RoutePoint[] {
  const ends = [0, points.length - 1];
  if (!ends.some((at) => points[at]?.bypass === true)) return points;
  return points.map((point, at) => {
    if (!ends.includes(at) || point.bypass !== true) return point;
    const { bypass: _drop, variant: _variant, ...rest } = point;
    void _drop;
    void _variant;
    return rest;
  });
}
