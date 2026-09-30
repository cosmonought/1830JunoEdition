// frontend/src/gameEngine/routeWalk.ts
//
// ==================================================================
//  ROUTE v12 R12-2: ONE ROUTE, JUDGED ALONE -- THE WALK THE AUTHORITY AND THE SEARCH BOTH ASK
// ==================================================================
//
// `walkRoute` is the route authority's single-route judge (`routeAuthority.ts`, design note #1550), MOVED here
// unchanged in shape so that the route SEARCH (`routeAutoTrace.ts`) can ask exactly the same question of every
// route it is about to demonstrate. Before R12-2 the search had its own, weaker idea of a legal route, and the
// demonstrated set (the S6-3 shortfall figure, the skip refusal, the auto-skip, the forced-purchase probe) could be
// one the authority then refused: the H12 herald fork (S6-16), a join through two unconnected cities of a bare
// token's hex (ING-1), the same red area at both ends, an unlicensed Coal River end. A corporation shown a figure
// no legal set reaches, and refused the skip, was stranded at Run Trains. One judge, two callers, and that class of
// disagreement is closed by construction. (`routeAuthority.ts` cannot be imported by the search: it imports
// `derivedActions.ts`, which imports the search.)
//
// WHAT R12-2 CHANGED IN THE LAW ITSELF (the owner's rulings, formalised by the independent R12-1 oracle,
// `frontend/src/routeOracle/`, which this module never imports):
//
//   * A RED AREA IS ONE CITY ACROSS ITS HEXES (rulebook 6.4.2's DABCFED example; IL-5). Canadian West (A9 + A11),
//     the Gulf (I1 + J2), Chattanooga (K1 + L2): the same area may not be both ends of one route. Two DIFFERENT
//     areas may. The key is the area's name (`OFFBOARD_LABELS`), so a Level Playing Field warehouse -- a red area
//     run through -- is also on a route at most once.
//   * A STATION COUNTS ONLY WHERE THE ROUTE VISITS IT (IL-7, and the herald's IL-3 NO). A token recorded without
//     a city used to "stand for the hex" before the bypass was looked at, so a run over Altoona's bow borrowed
//     PRR's station from a city it never entered, and an uncounted pass of the H12 herald borrowed PRR's home. A
//     bare token now counts only at a waypoint the route actually stops in (not a bypass).
//   * COAL RIVER IS CLOSED TO AN UNLICENSED CORPORATION ALTOGETHER (#1323): not passed, and not ended at. The
//     reducer's separate gate (`sandboxSession.ts`) already refused such a run; the walk now does, so ingress, the
//     authority, the gate and the search give one answer.
//
// ONLY ON A v12 BOARD. Each of the three is a refusal a stored log could meet, so it is asked only where the board
// in effect plays the v12 route rules (`routeRulesV12InEffect`: every pinned board); an unpinned legacy board -- the
// development corpus, and the frozen settlement goldens built by replaying it -- keeps the pre-v12 walk exactly.
//
// Everything else is the #1550 walk as it stood: continuous rail, no reversal at a junction, no crossover change,
// no section of track twice, full cities and red areas not run through, a named city the one the rail enters, no
// city twice (different cities of one hex are different cities), a station on the route, two or more cities.
// Re-entering a hex by a different section of track is legal and always was here (IL-11); the search now looks for
// it too.

import type { MapGridResponse } from "../components/hexContractTypes";
import type { TileColorTier } from "../components/hexTileCatalog";
import { HEX_NEIGHBOR_OFFSETS, liveEdgesForHex } from "../components/hexGeometry";
import { OFFBOARD_LABELS, boardMemo, heraldAt, routeRulesV12InEffect } from "../components/hexBoardData";
import {
  isOffboardTerminal,
  neighbourAcross,
  segmentsTouchingEdge,
  traversalsFrom,
  type HexTraversal,
  type SegmentKey,
} from "./trackSegments";
import { cityForArrival, stopEnteredFrom, type StationToken } from "./trackReach";
import { LICENSE_REFUSALS } from "./kanawhaLicense";
import { isRevenueCentreHex, isRouteTerminusHex, sandboxRouteBreakdown } from "./sandboxSession";

/** One stop of a proposed route, exactly as `RunMultipleRoutes.routes[i][j]` carries it. */
export interface ProposedWaypoint {
  hex: string;
  city_node?: number;
  bypass?: boolean;
}

/** What the walk needs to know about the corporation and the board. */
export interface RouteWalkContext {
  mapGrid: MapGridResponse;
  era: TileColorTier;
  /** The corporation running (its herald, if the board prints one). `undefined` only from a search caller that
   *  did not say -- then no herald is anybody's. */
  companyId: number | undefined;
  /** The corporation's station roots: `stationTokensOf` (a `[q, r, city]` token, a `[q, r]` token recorded
   *  without a city, and the herald root). */
  tokens: ReadonlyArray<StationToken>;
  /** Whether this corporation is shut out of running THROUGH city `cityIndex` on `(q, r)` (`cityBlockerFor`). */
  blocksThrough: (q: number, r: number, cityIndex: number) => boolean;
  /** `"q,r"` keys this corporation may not touch at all -- Coal River without a Kanawha Licence (#1323). */
  barredHexes?: ReadonlySet<string>;
}

/** One route the walk accepts. */
export interface WalkedRoute {
  /** The waypoints with `bypass` normalised to the way through the hex actually offers. */
  path: ProposedWaypoint[];
  revenue: number;
  centres: number;
  /** Every section of track the route occupies. */
  segments: Set<SegmentKey>;
}

const coordsByLabel = boardMemo(
  (board): ReadonlyMap<string, { q: number; r: number }> =>
    new Map(board.hexes.map((hex) => [hex.label, { q: hex.q, r: hex.r }])),
);

/** The edge of `from` facing `to`, or `-1` when they are not neighbours. */
function edgeToward(from: { q: number; r: number }, to: { q: number; r: number }): number {
  return HEX_NEIGHBOR_OFFSETS.findIndex(([dq, dr]) => from.q + dq === to.q && from.r + dr === to.r);
}

/** R12-2 (IL-5): which CITY a revenue centre on `label` is, for "no city twice". A red area is one city across
 *  every hex that carries its name; any other stop is its hex and the stop the rail enters (#1318/#1319). On a
 *  pre-v12 board every hex is its own key, as it always was. */
export function routeCityKey(label: string, stop: number | null): string {
  const area = routeRulesV12InEffect() ? OFFBOARD_LABELS[label] : undefined;
  return area ? `area:${area}` : `${label}:${stop ?? 0}`;
}

interface WalkedWaypoint {
  q: number;
  r: number;
  label: string;
  /** The stop (city / town) this waypoint stands in, by the rail it uses; `null` on plain track. */
  stop: number | null;
  bypass: boolean;
}

/** One route, judged alone. Returns the route, or the sentence that refuses it. */
export function walkRoute(ctx: RouteWalkContext, path: ReadonlyArray<ProposedWaypoint>): WalkedRoute | string {
  const { mapGrid, companyId, tokens, blocksThrough } = ctx;
  if (path.length < 2) return "A route needs at least two stops.";
  const v12 = routeRulesV12InEffect();

  /* 1. EVERY WAYPOINT IS A HEX OF THIS BOARD, with fields of the declared shape -- and none of them a hex this
        corporation may not touch at all (R12-2: an unlicensed Coal River, passed OR ended at). */
  const points: Array<{ q: number; r: number; label: string; wp: ProposedWaypoint }> = [];
  for (const wp of path) {
    if (typeof wp !== "object" || wp === null || typeof wp.hex !== "string") return "A waypoint must name a hex.";
    const at = coordsByLabel().get(wp.hex);
    if (!at) return `${wp.hex} is not a hex on this board.`;
    if (wp.city_node !== undefined && (!Number.isInteger(wp.city_node) || wp.city_node < 0 || wp.city_node > 1)) {
      return `${wp.hex} names a city (${String(wp.city_node)}) that no hex has.`;
    }
    if (wp.bypass !== undefined && wp.bypass !== true) return `${wp.hex} carries a bypass flag that is not true.`;
    if (v12 && ctx.barredHexes?.has(`${at.q},${at.r}`)) return LICENSE_REFUSALS.unlicensedRoute;
    points.push({ q: at.q, r: at.r, label: wp.hex, wp });
  }

  /* 2. CONTINUOUS TRACK: each step crosses an edge both hexes carry rail to (`neighbourAcross`, the two-sided
        join of trackReach #1), and inside every interior hex an authored rail joins the way in to the way out
        (`traversalsFrom`). A reversal at a junction, a change of track at a crossover, a hop between two
        unconnected curves of one tile and a run through a red area all fail the same test: no rail does that. */
  const segments = new Set<SegmentKey>();
  const walked: WalkedWaypoint[] = [];
  const normalised: ProposedWaypoint[] = [];
  const claim = (keys: readonly SegmentKey[], where: string): string | null => {
    for (const key of keys) {
      if (segments.has(key)) return `The route uses the same section of track twice at ${where}.`;
      segments.add(key);
    }
    return null;
  };

  for (let i = 0; i < points.length; i += 1) {
    const here = points[i];
    const previous = points[i - 1];
    const next = points[i + 1];
    const entry = previous ? edgeToward(here, previous) : -1;
    const exit = next ? edgeToward(here, next) : -1;
    if (previous && entry < 0) return `${previous.label} and ${here.label} are not adjacent.`;
    if (next) {
      if (exit < 0) return `${here.label} and ${next.label} are not adjacent.`;
      const across = neighbourAcross(mapGrid, here.q, here.r, exit);
      if (!across || across.q !== next.q || across.r !== next.r) {
        return `No track joins ${here.label} to ${next.label}.`;
      }
    }

    const heraldOwner = companyId !== undefined && heraldAt(here.label)?.companyId === companyId;
    let bypass = false;
    let stop: number | null;

    if (previous && next) {
      // An interior hex: a transit.
      if (isOffboardTerminal(here.q, here.r)) {
        return `${here.label} is a red off-board area, so a route may start or end there but not run through it.`;
      }
      const ways = traversalsFrom(mapGrid, here.q, here.r, entry).filter((way) => way.exitEdge === exit);
      if (ways.length === 0) {
        return `No rail through ${here.label} joins the way in (from ${previous.label}) to the way out (to ${next.label}) -- a route may not reverse at a junction or change track at a crossover.`;
      }
      const wantsBypass = here.wp.bypass === true;
      let way: HexTraversal | undefined;
      if (wantsBypass) {
        way = ways.find((candidate) => candidate.bypass === true);
        /* #1302: the owner may cross its herald without counting it; the transit is the ordinary one. */
        if (!way && heraldOwner) way = ways.find((candidate) => candidate.bypass !== true) ?? ways[0];
        if (!way) return `${here.label} has no track that goes around its revenue centre, so it cannot be bypassed.`;
        bypass = true;
      } else {
        way = ways.find((candidate) => candidate.bypass !== true);
        if (!way) {
          /* THE ONLY WAY THROUGH MISSES THE CENTRE, and the message did not say so: normalised to the truth so
             a route cannot be paid for a city its rails never touched. */
          way = ways[0];
          bypass = true;
        }
      }
      /* 3. NO CITY RUN THROUGH WHEN IT IS FULL OF OTHERS (§6.3.3 / §6.4.2) -- judged on the circle the arrival
            rail actually enters (#1022), and on a barred hex with any circle (#1323). A bypass does not enter. */
      if (!bypass) {
        const city = cityForArrival(mapGrid, here.q, here.r, entry);
        const shut = city === null ? blocksThrough(here.q, here.r, 0) : blocksThrough(here.q, here.r, city);
        if (shut) {
          return `${here.label} is tokened out by other corporations, so a train may end its run there but not pass through.`;
        }
      }
      const clash = claim(way.segments, here.label);
      if (clash) return clash;
      stop = bypass ? null : stopEnteredFrom(mapGrid, here, previous);
    } else {
      // An endpoint: the run starts or stops inside this hex and holds only the rail it uses.
      if (here.wp.bypass === true) return `${here.label} is where the route ends, so it cannot be bypassed.`;
      const only = previous ? entry : exit;
      if (!liveEdgesForHex(mapGrid, here.q, here.r).includes(only)) {
        return `No track joins ${here.label} to ${(previous ?? next)!.label}.`;
      }
      const clash = claim(segmentsTouchingEdge(mapGrid, here.q, here.r, only), here.label);
      if (clash) return clash;
      stop = stopEnteredFrom(mapGrid, here, (previous ?? next)!);
      /* 4. A ROUTE BEGINS AND ENDS AT A CITY -- large, small (a town), or a red off-board area (§6.4 / §6.4.2;
            #1555). Plain track cannot be an end. */
      if (!isRouteTerminusHex(mapGrid, here.label, companyId)) {
        return `${here.label} cannot ${previous ? "end" : "start"} a route: a route runs between cities, towns or red off-board areas.`;
      }
    }

    /* 5. A NAMED CITY MUST BE THE ONE THE RAIL ENTERS. `city_node` is a claim about which circle of a two-city
          hex the stop is in; the rail already says, and a claim that disagrees would re-key the pricing's
          per-city dedupe (#1318) so one city could be paid twice. */
    if (here.wp.city_node !== undefined && stop !== here.wp.city_node) {
      return `${here.label}: the route's track does not enter city ${here.wp.city_node}.`;
    }

    walked.push({ q: here.q, r: here.r, label: here.label, stop, bypass });
    const copy: ProposedWaypoint = { hex: here.label };
    if (here.wp.city_node !== undefined) copy.city_node = here.wp.city_node;
    if (bypass) copy.bypass = true;
    normalised.push(copy);
  }

  /* 6. NO CITY TWICE. Keyed as the pricing keys its dedupe -- the stop the rail enters (#1318/#1319) -- so a
        second visit to the same circle is refused rather than silently paid once. The other city of the same hex
        is a different key and is allowed (§6.4.2). R12-2 (IL-5): a red area is ONE city across its hexes, so
        Canadian West's A9 and A11 (the Gulf's I1 / J2, Chattanooga's K1 / L2) may not both be on one route --
        rulebook 6.4.2's DABCFED example. Plain track carries no stop and may be crossed again on other rails
        (IL-11); the track rule above is what bounds that. A bypass is not a visit. */
  const visited = new Set<string>();
  for (const point of walked) {
    if (point.bypass) continue;
    if (!isRevenueCentreHex(mapGrid, point.label, companyId)) continue;
    const key = routeCityKey(point.label, point.stop);
    if (visited.has(key)) {
      const area = v12 ? OFFBOARD_LABELS[point.label] : undefined;
      return area
        ? `The route counts ${area} twice; a red off-board area is one city, so it may be on a route only once.`
        : `The route counts ${point.label} twice; a city may be on a route only once.`;
    }
    visited.add(key);
  }

  /* 7. A STATION OF THIS CORPORATION ON THE ROUTE -- in the city the route actually passes through (#853),
        anywhere along it (#474). R12-2 (IL-7; the herald's IL-3 NO): a token recorded without a circle (#686's
        fallback) and the herald root (#1302) count only where the route VISITS the hex's stop -- never at a
        waypoint it crosses on a bypass. Altoona's bow does not reach PRR's station, and an uncounted pass of the
        H12 herald is not PRR's home. */
  const hasStation = walked.some((point) => {
    const match = tokens.find(([q, r]) => q === point.q && r === point.r);
    if (!match) return false;
    // Pre-v12 (the #686 fallback, kept for the unpinned corpus): a bare token stood for its hex, bypass or not.
    if (!v12 && match.length < 3) return true;
    if (point.bypass) return false;
    if (match.length < 3) return true;
    return point.stop === null || point.stop === match[2];
  });
  if (!hasStation) {
    return tokens.length === 0
      ? "This corporation has no station token on the board, so it has no route."
      : "A route must pass through a city this corporation has a station token in.";
  }

  /* 8. PRICE AND COUNT, through the one pricing function the tracer and the readout share. */
  const breakdown = sandboxRouteBreakdown(mapGrid, normalised, ctx.era, companyId);
  if (breakdown.centres < 2) return "A route must include at least two cities.";
  return { path: normalised, revenue: breakdown.revenue, centres: breakdown.centres, segments };
}
