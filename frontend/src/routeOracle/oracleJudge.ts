// frontend/src/routeOracle/oracleJudge.ts
//
// ==================================================================
//  ROUTE v12 R12-1: THE ORACLE AS A JUDGE OF A SUBMITTED ROUTE SET
// ==================================================================
//
// TEST-ONLY. A `RunMultipleRoutes` names hexes, not sections of track. Turning a waypoint list into track is a
// POLICY (the preflight's section 7.7), so it is written down here once and applied the same way to every
// submission -- production's own set, a hand-drawn set, the oracle's own witness:
//
//   - consecutive waypoints must be neighbours; the edge between them is the only one they share;
//   - an END waypoint is a revenue centre with a spoke on that edge (`city_node`, when given, names which);
//   - an INTERIOR waypoint WITHOUT `bypass` enters a centre that joins its two edges if the hex has one (that is
//     what the route "runs through"), and otherwise runs along a plain section joining them;
//   - an INTERIOR waypoint WITH `bypass: true` runs along a plain section joining its two edges and visits
//     nothing (the Altoona bow; the herald's owner passing it uncounted); on a hex with no centre, or together
//     with `city_node`, the flag is refused rather than ignored;
//   - an INTERIOR `city_node` names the centre the route runs through; if that centre does not join the two
//     edges the waypoint is refused (never re-read as plain track).
//
// When more than one realisation fits a waypoint list, every one is judged; they must agree or the verdict is
// AMBIGUOUS -- a finding about the wire format, not something to guess.

import type { OracleGraph, OracleNode } from "./oracleGraph";
import { neighbourLabel, nodeJoins } from "./oracleGraph";
import { oppositeEdge, oracleTrainStops } from "./oracleManifest";
import { judgeRoute, type RouteVisit } from "./oracleRoutes";

export interface OracleWaypoint {
  hex: string;
  city_node?: number;
  bypass?: boolean;
}

export type WaypointVerdict =
  | { kind: "legal"; visits: RouteVisit[]; stops: number; value: number; boundaries: number[] }
  | { kind: "illegal"; reason: string }
  | { kind: "ambiguous"; reasons: string[] };

const REALISATION_CAP = 64;

/** The stop number a waypoint's `city_node` refers to: the city index, or a town's ordinal on its hex. */
function stopNumber(node: OracleNode): number | null {
  if (node.kind === "city") return node.cityIndex;
  const match = /(\d+)$/.exec(node.id);
  return match ? Number(match[1]) : null;
}

export function realisationsOf(graph: OracleGraph, waypoints: readonly OracleWaypoint[]): RouteVisit[][] | string {
  if (waypoints.length < 2) return "A route needs at least two waypoints.";
  const edges: number[] = [];
  for (let i = 0; i + 1 < waypoints.length; i += 1) {
    const here = waypoints[i].hex;
    const there = waypoints[i + 1].hex;
    if (!graph.hexes.has(here)) return `${here} is not on this board.`;
    let found = -1;
    for (let edge = 0; edge < 6; edge += 1) if (neighbourLabel(graph, here, edge) === there) found = edge;
    if (found < 0) return `${here} and ${there} are not neighbours.`;
    edges.push(found);
  }
  if (!graph.hexes.has(waypoints[waypoints.length - 1].hex)) return `${waypoints[waypoints.length - 1].hex} is not on this board.`;

  const options: RouteVisit[][] = [];
  for (let i = 0; i < waypoints.length; i += 1) {
    const wp = waypoints[i];
    const hex = graph.hexes.get(wp.hex)!;
    const entry = i > 0 ? oppositeEdge(edges[i - 1]) : null;
    const exit = i < waypoints.length - 1 ? edges[i] : null;
    const named = (node: OracleNode) => wp.city_node === undefined || stopNumber(node) === wp.city_node;
    const here: RouteVisit[] = [];
    if (entry === null || exit === null) {
      if (wp.bypass === true) return `${wp.hex} is an end of the route, so it cannot be bypassed.`;
      const edge = (entry ?? exit)!;
      for (const node of hex.nodes) {
        if (node.spokes.includes(edge) && named(node)) here.push({ hex: wp.hex, element: { kind: "node", node }, entry, exit });
      }
      if (here.length === 0) return `${wp.hex} has no revenue centre on the track toward its neighbour.`;
    } else {
      // The flags must mean something here (the R12-1 review, M8): a named city the track does not run through
      // is not "plain track instead", and a bypass on a hex with no centre bypasses nothing.
      if (wp.bypass === true && wp.city_node !== undefined) return `${wp.hex} is both bypassed and named as a stop.`;
      if (wp.bypass === true && hex.nodes.length === 0) return `${wp.hex} has no revenue centre, so there is nothing to bypass.`;
      const nodeWays = wp.bypass === true ? [] : hex.nodes.filter((node) => named(node) && nodeJoins(node, entry, exit));
      nodeWays.forEach((node) => here.push({ hex: wp.hex, element: { kind: "node", node }, entry, exit }));
      if (here.length === 0 && wp.city_node !== undefined) return `${wp.hex}: the route's track does not run through stop ${wp.city_node}.`;
      if (here.length === 0) {
        for (const path of hex.paths) {
          if ((path.a === entry && path.b === exit) || (path.b === entry && path.a === exit)) {
            here.push({ hex: wp.hex, element: { kind: "path", path }, entry, exit });
          }
        }
      }
      if (here.length === 0) return `No track through ${wp.hex} joins edge ${entry} to edge ${exit}.`;
    }
    options.push(here);
  }

  let out: RouteVisit[][] = [[]];
  for (const choices of options) {
    const next: RouteVisit[][] = [];
    for (const prefix of out) for (const choice of choices) next.push([...prefix, choice]);
    out = next;
    if (out.length > REALISATION_CAP) return `The waypoint list has more than ${REALISATION_CAP} readings.`;
  }
  return out;
}

export function judgeWaypoints(graph: OracleGraph, waypoints: readonly OracleWaypoint[]): WaypointVerdict {
  const readings = realisationsOf(graph, waypoints);
  if (typeof readings === "string") return { kind: "illegal", reason: readings };
  const verdicts = readings.map((visits) => ({ visits, verdict: judgeRoute(graph, visits) }));
  const legal = verdicts.filter((entry) => entry.verdict.legal);
  if (legal.length === 0) return { kind: "illegal", reason: (verdicts[0].verdict as { reason: string }).reason };
  if (legal.length < verdicts.length) {
    return { kind: "ambiguous", reasons: verdicts.map((entry) => (entry.verdict.legal ? "legal" : entry.verdict.reason)) };
  }
  const first = legal[0];
  const v = first.verdict as { stops: number; value: number; boundaries: number[] };
  const agree = legal.every((entry) => {
    const w = entry.verdict as { stops: number; value: number; boundaries: number[] };
    return w.stops === v.stops && w.value === v.value && w.boundaries.join(",") === v.boundaries.join(",");
  });
  if (!agree) return { kind: "ambiguous", reasons: ["several legal readings with different prices or track"] };
  return { kind: "legal", visits: first.visits, stops: v.stops, value: v.value, boundaries: v.boundaries };
}

export type SetVerdict =
  | { kind: "legal"; total: number; perRoute: number[] }
  | { kind: "illegal"; reason: string; route?: number }
  | { kind: "ambiguous"; reason: string; route?: number };

/** A whole set: each route legal for its own train; no two routes on the same track; each train once. */
export function judgeRouteSet(
  graph: OracleGraph,
  fleet: readonly string[],
  routes: ReadonlyArray<readonly OracleWaypoint[]>,
  trainIndices: readonly number[],
): SetVerdict {
  if (routes.length !== trainIndices.length) return { kind: "illegal", reason: "routes and trains differ in number" };
  if (new Set(trainIndices).size !== trainIndices.length) return { kind: "illegal", reason: "a train runs twice" };
  const seen = new Set<number>();
  const perRoute: number[] = [];
  for (let i = 0; i < routes.length; i += 1) {
    const model = fleet[trainIndices[i]];
    if (model === undefined) return { kind: "illegal", reason: `no train in slot ${trainIndices[i]}`, route: i };
    const cap = oracleTrainStops(model);
    if (cap === null) return { kind: "ambiguous", reason: `unknown train model ${model}`, route: i };
    const verdict = judgeWaypoints(graph, routes[i]);
    if (verdict.kind === "illegal") return { kind: "illegal", reason: `Route ${i + 1}: ${verdict.reason}`, route: i };
    if (verdict.kind === "ambiguous") return { kind: "ambiguous", reason: `Route ${i + 1}: ${verdict.reasons.join(" | ")}`, route: i };
    if (cap !== "unlimited" && verdict.stops > cap) {
      return { kind: "illegal", reason: `Route ${i + 1} counts ${verdict.stops} cities; a ${model}-train counts ${cap}.`, route: i };
    }
    for (const b of verdict.boundaries) {
      if (seen.has(b)) return { kind: "illegal", reason: `Route ${i + 1} shares track with an earlier route.`, route: i };
    }
    verdict.boundaries.forEach((b) => seen.add(b));
    perRoute.push(verdict.value);
  }
  return { kind: "legal", total: perRoute.reduce((sum, v) => sum + v, 0), perRoute };
}

/** The oracle's own route as the wire's waypoints (what a client would send for it). */
export function waypointsOf(visits: readonly RouteVisit[], graph: OracleGraph): OracleWaypoint[] {
  return visits.map((visit) => {
    const hex = graph.hexes.get(visit.hex)!;
    const wp: OracleWaypoint = { hex: visit.hex };
    if (visit.element.kind === "node") {
      const node = visit.element.node;
      const cities = hex.nodes.filter((entry) => entry.kind === "city");
      if (node.kind === "city" && cities.length > 1) wp.city_node = node.cityIndex!;
    } else if (hex.nodes.length > 0) {
      wp.bypass = true;
    }
    return wp;
  });
}
