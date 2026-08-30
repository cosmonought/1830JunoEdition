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
// Design note #1025: the rail-level connection and visited rules, derived from the draft itself.
import { connectionForClick, segmentsUsedBy } from "./routeConnection";
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
  /** ==================================================================
   *   DESIGN NOTE 1023: WHOSE CITIES ARE SHUT, FOR THE BRIDGE
   *  ==================================================================
   *
   * REPORTED: "it completely refuses to draw a path along the bypass track, no matter which adjacent hexes
   * the player clicks to force it."
   *
   * THE BRIDGE HAD NO IDEA A CITY COULD BE SHUT. Every other walk in this app takes this predicate -- the
   * network reach since #729, the auto-tracer since #730 -- and the one that fills the gap between two clicked
   * hexes never did. So it proposed crossings through Altoona's station, which the submit-path validator then
   * refused: the router and the validator disagreeing, which is the shape the previous batch fixed one layer
   * up and this is the layer beneath it.
   *
   * INJECTED, keeping this module's charter: "it takes no refs, no setters, and no React". The caller holds
   * the token board; this holds the drawing rules.
   *
   * OMITTED MEANS NO BLOCKING, which reproduces every pre-#1023 caller exactly. */
  blocksThrough?: (q: number, r: number, cityIndex: number) => boolean;
}

/** How many of these points pay. The cap counts revenue CENTRES, not hexes travelled (#156). */
function centresIn(mapGrid: MapGridResponse, points: readonly RoutePoint[]): number {
  return points.reduce(
    (total, entry) => (isRevenueCentreHex(mapGrid, entry.hexLabel) ? total + 1 : total),
    0,
  );
}

export function editRouteDraft(input: RouteDraftEditInput): RouteDraftEdit {
  const { mapGrid, points, click, displayLabel, maxDistance, blocksThrough } = input;
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

  /* ==================================================================
      DESIGN NOTE 1025: CONNECTION FIRST, THEN VISITED -- AND BOTH AT RAIL LEVEL
     ==================================================================
     RULES 5 AND 6 HAVE SWAPPED AND BOTH HAVE CHANGED UNITS. What was here:

       RULE 5  refuse if any point shares the clicked hex's COORDINATES
       RULE 6  if adjacent, append with no connectivity test at all

     REPORTED, and each sentence names one of those two lines:
       "The manual router allows visually jumping between disconnected tracks on the same hex ... the UI draws
        the line as if it were legal."                                            <- rule 6 asked nothing
       "an error that they cannot re-enter a hex, even when using a completely separate track segment"
                                                                                  <- rule 5 asked coordinates
       "throws a 'hex already visited' error instead of a 'no legal connection' error."
                                                                                  <- rule 5 ran first

     THE ORDER IS THE THIRD FIX AND IT IS NOT COSMETIC. A player clicking a neighbour they have no rail to is
     told the truth about the rail; being told the hex is "already visited" sends them to look at the wrong
     part of their own route. #883's rule for this file is that the ORDER of these refusals is a decision
     about what a player most needs to know -- it was expressed only as source order and nothing asserted it.
     Now something does.

     WHY THIS ONLY GOVERNS THE ADJACENT PATH. A non-adjacent click goes to the bridge below, which walks
     `(hex, arrival edge)` states of its own (#9) and keeps a hex-keyed `avoid` set. Re-entry by a second rail
     is a thing a player DRAWS deliberately, hex by hex; a bridge is a convenience that fills a gap, and
     teaching it to propose re-entries is a larger change than this report asks for. Stated rather than left
     to be discovered. */
  if (axialHexDistance(last, click) === 1) {
    /* ==================================================================
       A TRAIN CANNOT REVERSE, AND THAT IS NOT "NO TRACK"
       ==================================================================
       Clicking the point BEFORE last asks the route to leave a hex by the edge it entered on, which
       `traversalsFrom` refuses by construction (`exitEdge === entryEdge` is not a traversal). The connection
       check therefore answers `null` -- correctly -- and the generic sentence would then tell a player about
       two separate tracks on a hex that has one, which is a true rule and the wrong explanation.
       CAUGHT BEFORE THE GENERIC ARM because the order of these refusals is a decision about what a player
       most needs to know (#883), and "you have already been here, click the last hex to step back" is what
       they can act on. */
    const previous = points[points.length - 2];
    if (previous && previous.q === click.q && previous.r === click.r) {
      return {
        ok: false,
        reason: `${click.hexLabel} is already on this route — a train cannot reverse back down the track it just ran. Click ${last.hexLabel} to step back instead.`,
      };
    }

    const transit = connectionForClick(mapGrid, points, click);
    if (!transit) {
      return {
        ok: false,
        reason: `No track connects ${last.hexLabel} to ${click.hexLabel} on the rail this route is running. A hex can carry two separate tracks that never meet — click a hex the current track actually reaches.`,
      };
    }

    /* RULE 5, IN THE UNITS THE TILE HAS. A route may not run the same RAIL twice; re-entering a hex on a
       track it has not used is legal and is what the report is about. `segmentsUsedBy` derives the answer
       from the draft rather than storing a second copy of it -- #275's mirror is the reason this codebase
       does not keep two records of one route.
       ASKED OF THE ROUTE SO FAR, and compared against the rails this step would add. The first draft of this
       block computed `segmentsUsedBy(..., [...points, click])` -- the set INCLUDING the new step -- and then
       looked for overlap with the new step, which finds itself every time. Rewritten rather than patched,
       because a check whose answer is always "yes" is a refusal of everything. */
    const alreadyRun = segmentsUsedBy(mapGrid, points);
    if (transit.segments.some((key) => alreadyRun.has(key))) {
      return {
        ok: false,
        reason: `This route already runs that track through ${last.hexLabel}. A train may not run the same track twice — click ${last.hexLabel} to step back, or take the other track.`,
      };
    }
    return commit([...points, click]);
  }

  /* RULE 5 (bridge path) -- NO HEX TWICE, unchanged for a gap the player asked to be filled. See the note
     above for why the rail-level rule governs the adjacent path only. */
  if (points.some((entry) => entry.q === click.q && entry.r === click.r)) {
    return {
      ok: false,
      reason: `${click.hexLabel} is already on this route. A route may not visit the same hex twice — click ${last.hexLabel} to step back instead.`,
    };
  }

  /* RULE 7 -- A GAP IS BRIDGED, OR REFUSED. `bridgeWaypoints` prefers plain track over a third city, and may
     not loop back through hexes already routed over: a route is a simple path. A failed bridge is a refusal,
     not a silent no-op, because the player asked for something specific. */
  const bridge = bridgeWaypoints(
    mapGrid,
    last,
    click,
    new Set(points.map((entry) => `${entry.q},${entry.r}`)),
    /* Design note #1023: a shut city is impassable to the bridge, so the bow becomes the only way across
       Altoona and the path the player was clicking for is the one they get. */
    blocksThrough,
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
