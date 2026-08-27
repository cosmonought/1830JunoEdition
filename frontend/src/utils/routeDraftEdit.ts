// frontend/src/utils/routeDraftEdit.ts
//
// What one click does to a hand-drawn route.
//
// ==================================================================
//  DESIGN NOTE 882: SEVEN RULES INSIDE A CLICK HANDLER
// ==================================================================
//
// EXTRACTED FROM `App.handleRouteHexClick` AFTER AN AUDIT, not after a report -- which is the point of doing
// it. That callback was the file's densest rule-holder: 84 lines, 29 decisions, and seven distinct rules
// about what a route is, every one of them reachable only through a React state setter. Grep was the only
// way to test any of them, and grep cannot tell you that clicking the last hex twice steps back exactly once.
//
// AND NOTHING ASSERTED ANY OF IT. Before this module there was not a single test naming any of these
// refusals -- the strings do not appear in any harness. The rules that decide whether a player may draw a
// route at all were the least-covered code in the app.
//
// THE SPLIT IS THE SAME ONE THAT WORKED FOR #875 AND #878: the decision leaves, the plumbing stays. This
// returns the next points or a sentence explaining the refusal; the shell writes state and shows the
// sentence. It takes no refs, no setters, and no React.
//
// #881 IS ALREADY HERE and is why the capacity arm is a call rather than a comparison: an unknown train is
// unlimited for DRAWING and the smallest one for FLAGGING, and this is the drawing end.

import { bridgeWaypoints } from "./routeAutoTrace";
import { axialHexDistance, type RoutePoint } from "./routeWaypoints";
import { isRevenueCentreHex, isRouteTerminusHex } from "./sandboxSession";
import { isUnlimitedReach, reachForDrafting } from "./trainReach";
import { liveEdgesForHex } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";

/** The next draft, or the reason there isn't one. */
export type RouteDraftEdit =
  | { ok: true; points: RoutePoint[] }
  | { ok: false; reason: string };

export interface RouteDraftEditInput {
  mapGrid: MapGridResponse;
  /** The draft as it stands for the train being drawn. */
  points: readonly RoutePoint[];
  /** The clicked hex, keyed by its CANONICAL board label (#243) -- what the pricing table and the contract
   *  both use. Never the display string. */
  click: RoutePoint;
  /** The display name for messages ("New York (G19)"), which is not the key. */
  displayLabel: string;
  /** The train's reach in revenue centres, raw from the roster. `undefined` is a model this build's catalog
   *  does not carry, and #881 decides what that means here. */
  maxDistance: number | null | undefined;
}

/** How many of these points pay. The cap counts revenue CENTRES, not hexes travelled (#156). */
function centresIn(mapGrid: MapGridResponse, points: readonly RoutePoint[]): number {
  return points.reduce(
    (total, entry) => (isRevenueCentreHex(mapGrid, entry.hexLabel) ? total + 1 : total),
    0,
  );
}

export function editRouteDraft(input: RouteDraftEditInput): RouteDraftEdit {
  const { mapGrid, points, click, displayLabel, maxDistance } = input;
  const last = points[points.length - 1];

  /* RULE 1 -- WHERE A ROUTE MAY START. A route runs between two revenue centres, so the FIRST click is
     refused outright if it is not one; the LAST is left to the readout, because a player mid-draw has not
     finished yet. Towns are not termini (#264). */
  if (points.length === 0 && !isRouteTerminusHex(mapGrid, click.hexLabel)) {
    return {
      ok: false,
      reason: `${displayLabel} cannot START a route. Routes begin at a city or a red off-board hex — towns and plain track are passed through.`,
    };
  }

  /* RULE 2 -- A WAYPOINT NEEDS TRACK. `liveEdgesForHex` counts preprinted rails as well as laid tiles (#186),
     so a preprinted city with no tile on it is a legal waypoint and a blank hex is not. */
  if (liveEdgesForHex(mapGrid, click.q, click.r).length === 0) {
    return {
      ok: false,
      reason: `${displayLabel} has no track. Lay a tile there first, or pick a hex the network already runs through.`,
    };
  }

  /* RULE 3 -- CLICKING THE LAST POINT AGAIN STEPS BACK. A quick one-step undo, rather than a no-op or a
     rejected duplicate. Checked BEFORE the revisit rule below, which would otherwise refuse it. */
  if (last && last.q === click.q && last.r === click.r) {
    return { ok: true, points: points.slice(0, -1) };
  }

  /* RULE 4 -- THE CAPACITY, applied to whatever the click produces. Checked on the COMMIT rather than per
     click so a bridge's extra stops count (#624), and applied to the first point as well: a one-stop cap is
     not a state 1830 has, but a uniform check is what keeps it honest for the Diesel. */
  const cap = reachForDrafting(maxDistance);
  const commit = (next: RoutePoint[]): RouteDraftEdit => {
    if (!isUnlimitedReach(cap)) {
      const centres = centresIn(mapGrid, next);
      if (centres > cap) {
        return {
          ok: false,
          reason: `That would give this train ${centres} stops and it can only run ${cap}. Click ${last?.hexLabel ?? "a hex on the route"} to step back, or select a longer train.`,
        };
      }
    }
    return { ok: true, points: next };
  };

  if (points.length === 0 || last === undefined) return commit([click]);

  /* RULE 5 -- NO HEX TWICE. Clicking a hex the route already passes through, other than the last one, would
     make the chain visit it twice -- and 1830 pays a hex once per pass, so the drawing and the pricing would
     disagree. Refused with the reason rather than silently ignored. */
  if (points.some((entry) => entry.q === click.q && entry.r === click.r)) {
    return {
      ok: false,
      reason: `${click.hexLabel} is already on this route. A route may not visit the same hex twice — click ${last.hexLabel} to step back instead.`,
    };
  }

  /* RULE 6 -- AN ADJACENT CLICK IS APPENDED AS-IS (#276). This is what keeps hex-by-hex drawing available for
     disambiguating a branch; the bridge below only fills gaps the player chose to leave. */
  if (axialHexDistance(last, click) === 1) return commit([...points, click]);

  /* RULE 7 -- A GAP IS BRIDGED, OR REFUSED. `bridgeWaypoints` prefers plain track over a third city, and may
     not loop back through hexes already routed over: a route is a simple path. A failed bridge is a refusal,
     not a silent no-op, because the player asked for something specific. */
  const bridge = bridgeWaypoints(
    mapGrid,
    last,
    click,
    new Set(points.map((entry) => `${entry.q},${entry.r}`)),
  );
  if (!bridge) {
    return {
      ok: false,
      reason: `No track path from ${last.hexLabel} to ${click.hexLabel}. Lay the missing tiles, or click through the hexes you want the route to take.`,
    };
  }
  // The bridge may add several paying stops at once (#624), so the cap is checked after it lands.
  return commit([...points, ...bridge]);
}
