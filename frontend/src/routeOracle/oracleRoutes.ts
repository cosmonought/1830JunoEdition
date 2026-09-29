// frontend/src/routeOracle/oracleRoutes.ts
//
// ==================================================================
//  ROUTE v12 R12-1: THE ORACLE'S ROUTE LAW AND ITS EXHAUSTIVE ENUMERATION
// ==================================================================
//
// TEST-ONLY. Two independent pieces that must agree with each other:
//
//   `judgeRoute` -- a STANDALONE checker of one whole route, written directly from the rulebook (2018 Lookout
//   1830, 6.4 / 6.4.1 / 6.4.2 / 6.3.3 / 6.5) plus the recorded owner rulings (the R12-1 brief: the same red
//   area may not be both ends; a bypassed city is not visited; a tile may be re-entered on a different section
//   of track; Coal River is closed to an unlicensed corporation; a Y-junction may not be reversed through).
//
//   `enumerateRoutes` -- an exhaustive depth-first generator. It is NOT production's strategy: production grows
//   independent "arms" from a token, keeps the top few of each, and JOINS two arms at the token afterwards
//   (`routeAutoTrace.candidateRoutes`), which is where the herald / ING-1 defect lives. Here a route is grown
//   as ONE object from an anchor (a node holding the corporation's station, or its herald), first to one end
//   and then -- carrying the whole first half's state, so nothing is ever joined after the fact -- to the other
//   end. Nothing is pruned except by the law itself and the fleet's largest stop count. Every generated route is
//   re-judged by `judgeRoute` when `selfCheck` is on, so the generator cannot emit what the checker refuses.
//
// NO FLOATING POINT: values and counts are integers throughout.

import {
  type OracleGraph,
  type OracleNode,
  type OraclePath,
  neighbourLabel,
  nodeClosedToTransit,
  nodeJoins,
} from "./oracleGraph";
import { oppositeEdge } from "./oracleManifest";

export type VisitElement = { kind: "node"; node: OracleNode } | { kind: "path"; path: OraclePath };

export interface RouteVisit {
  hex: string;
  element: VisitElement;
  /** The edge the route enters this hex by; `null` where the route begins. */
  entry: number | null;
  /** The edge the route leaves this hex by; `null` where the route ends. */
  exit: number | null;
}

export type RouteJudgement =
  | { legal: true; stops: number; value: number; boundaries: number[] }
  | { legal: false; reason: string };

const elementId = (visit: RouteVisit) => (visit.element.kind === "node" ? visit.element.node.id : visit.element.path.id);

/** The route's identity: the sequence of sections and centres it uses, read in whichever direction sorts
 *  first. Never a hex-label chain (production's dedupe key, which conflates different routes through the same
 *  hexes). */
export function canonicalRouteKey(visits: readonly RouteVisit[]): string {
  const ids = visits.map(elementId);
  const forward = ids.join(">");
  const backward = [...ids].reverse().join(">");
  return forward <= backward ? forward : backward;
}

/** THE LAW FOR ONE ROUTE, checked from scratch. */
export function judgeRoute(graph: OracleGraph, visits: readonly RouteVisit[]): RouteJudgement {
  const refuse = (reason: string): RouteJudgement => ({ legal: false, reason });
  if (visits.length < 2) return refuse("A route needs at least two cities.");
  const first = visits[0];
  const last = visits[visits.length - 1];
  if (first.element.kind !== "node" || last.element.kind !== "node") {
    return refuse("A route begins and ends at a city, town, red area or (for its owner) a herald.");
  }
  if (first.entry !== null || last.exit !== null) return refuse("A route's ends are where it begins and stops.");

  const boundaries = new Set<number>();
  const groups = new Set<string>();
  let stops = 0;
  let value = 0;
  let station = false;
  // IL-11: the owner's herald is one city however the route includes it -- stopped at, or run past uncounted.
  const heraldGroup = heraldGroupOf(graph);

  for (let i = 0; i < visits.length; i += 1) {
    const visit = visits[i];
    const hex = graph.hexes.get(visit.hex);
    if (!hex) return refuse(`${visit.hex} is not on this board.`);
    if (graph.barred.has(visit.hex)) {
      return refuse(`${visit.hex} (Coal River) may not be used by a corporation without a Kanawha Licence.`);
    }
    const interior = i > 0 && i < visits.length - 1;
    if (interior && (visit.entry === null || visit.exit === null)) return refuse(`The route breaks at ${visit.hex}.`);
    if (i === 0 && visit.exit === null) return refuse(`The route never leaves ${visit.hex}.`);
    if (i === visits.length - 1 && visit.entry === null) return refuse(`The route never reaches ${visit.hex}.`);

    if (visit.element.kind === "node") {
      const node = visit.element.node;
      if (node.hex !== visit.hex || !hex.nodes.includes(node)) return refuse(`${node.id} is not on ${visit.hex}.`);
      if (visit.entry !== null && !node.spokes.includes(visit.entry)) return refuse(`No track enters ${node.id} from edge ${visit.entry}.`);
      if (visit.exit !== null && !node.spokes.includes(visit.exit)) return refuse(`No track leaves ${node.id} by edge ${visit.exit}.`);
      if (interior) {
        if (!nodeJoins(node, visit.entry!, visit.exit!)) {
          return refuse(`No rail through ${node.id} joins edge ${visit.entry} to edge ${visit.exit} (no reversal at a junction).`);
        }
        if (nodeClosedToTransit(graph, node)) {
          return refuse(
            node.kind === "offboard"
              ? `${visit.hex} is a red off-board area: a route may begin or end there, never pass through.`
              : `${node.id} is filled with other railroads' stations: a route may end there but not pass through.`,
          );
        }
      }
      if (groups.has(node.group)) return refuse(`The route includes ${node.group} twice.`);
      groups.add(node.group);
      stops += 1;
      value += node.value;
      if (node.kind === "herald") station = true;
      if ((graph.stations.get(node.id) ?? []).includes(graph.companyId)) station = true;
    } else {
      const path = visit.element.path;
      if (path.hex !== visit.hex || !hex.paths.includes(path)) return refuse(`${path.id} is not on ${visit.hex}.`);
      if (!interior) return refuse(`A route cannot begin or end on plain track (${visit.hex}).`);
      const joins = (path.a === visit.entry && path.b === visit.exit) || (path.b === visit.entry && path.a === visit.exit);
      if (!joins) return refuse(`${path.id} does not join edge ${visit.entry} to edge ${visit.exit}.`);
      if (heraldGroup !== null && graph.heraldHex === visit.hex) {
        if (groups.has(heraldGroup)) return refuse(`The route includes the herald on ${visit.hex} twice (IL-11).`);
        groups.add(heraldGroup);
        if (graph.policy.heraldUncountedIsStation) station = true;
      }
    }

    if (i < visits.length - 1) {
      const next = visits[i + 1];
      const edge = visit.exit!;
      const boundary = graph.boundaryAt.get(`${visit.hex}:${edge}`);
      if (boundary === undefined) return refuse(`Track on ${visit.hex} leads off the board (edge ${edge}).`);
      if (neighbourLabel(graph, visit.hex, edge) !== next.hex) return refuse(`${visit.hex} does not border ${next.hex} at edge ${edge}.`);
      if (next.entry !== oppositeEdge(edge)) return refuse(`The route does not arrive on ${next.hex} where it left ${visit.hex}.`);
      if (boundaries.has(boundary)) return refuse(`The route uses the track between ${visit.hex} and ${next.hex} twice.`);
      boundaries.add(boundary);
    }
  }

  if (stops < 2) return refuse("A route needs at least two cities.");
  if (!station) return refuse("A route must include a city holding one of the railroad's stations.");
  return { legal: true, stops, value, boundaries: Array.from(boundaries).sort((a, b) => a - b) };
}

/** The group of the running company's herald node, or `null` when it has none on this board. */
export function heraldGroupOf(graph: OracleGraph): string | null {
  if (graph.heraldHex === null) return null;
  return graph.hexes.get(graph.heraldHex)?.nodes.find((node) => node.kind === "herald")?.group ?? null;
}

export interface OracleRoute {
  key: string;
  visits: RouteVisit[];
  stops: number;
  value: number;
  boundaries: number[];
  mask: Uint32Array;
}

export interface EnumerationOptions {
  /** The fleet's largest stop count (`Infinity` with a Diesel): a route counting more cannot be run by anyone. */
  maxStops: number;
  /** Counted, never timed: steps across a boundary. Exhaustion makes the answer UNDECIDED, never "no route". */
  budget: number;
  /** Re-judge every generated route with `judgeRoute` and throw on disagreement. */
  selfCheck: boolean;
}

export interface EnumerationResult {
  routes: OracleRoute[];
  expansions: number;
  exhausted: boolean;
}

export function maskOf(boundaries: readonly number[], words: number): Uint32Array {
  const mask = new Uint32Array(words);
  for (const b of boundaries) mask[b >>> 5] |= 1 << (b & 31);
  return mask;
}

/** EVERY LEGAL ROUTE the corporation can run with at most `maxStops` stops, each exactly once. */
export function enumerateRoutes(graph: OracleGraph, options: EnumerationOptions): EnumerationResult {
  const words = Math.max(1, Math.ceil(graph.boundaryCount / 32));
  const found = new Map<string, OracleRoute>();
  const used = new Uint8Array(graph.boundaryCount);
  const usedStack: number[] = [];
  const groupIndex = new Map<string, number>();
  Array.from(graph.nodes.values()).forEach((node) => {
    if (!groupIndex.has(node.group)) groupIndex.set(node.group, groupIndex.size);
  });
  const groupUsed = new Uint8Array(groupIndex.size);
  const heraldGroup = heraldGroupOf(graph);
  const heraldIndex = heraldGroup === null ? null : groupIndex.get(heraldGroup) ?? null;

  // Per (hex, arrival edge): the sections and centres a route arriving there can use.
  const pathsAt = new Map<string, OraclePath[]>();
  const nodesAt = new Map<string, OracleNode[]>();
  Array.from(graph.hexes.values()).forEach((hex) => {
    hex.paths.forEach((path) => {
      for (const edge of [path.a, path.b]) {
        const key = `${hex.label}:${edge}`;
        pathsAt.set(key, [...(pathsAt.get(key) ?? []), path]);
      }
    });
    hex.nodes.forEach((node) => {
      for (const edge of node.spokes) {
        const key = `${hex.label}:${edge}`;
        nodesAt.set(key, [...(nodesAt.get(key) ?? []), node]);
      }
    });
  });

  let expansions = 0;
  let exhausted = false;
  let stops = 0;
  let value = 0;

  const emit = (visits: RouteVisit[]) => {
    if (stops < 2) return;
    const key = canonicalRouteKey(visits);
    if (found.has(key)) return;
    const boundaries = [...usedStack].sort((a, b) => a - b);
    const copy = visits.map((visit) => ({ ...visit }));
    if (options.selfCheck) {
      const verdict = judgeRoute(graph, copy);
      if (!verdict.legal) throw new Error(`oracle self-check: generated an illegal route ${key}: ${verdict.reason}`);
      if (verdict.value !== value || verdict.stops !== stops || verdict.boundaries.join(",") !== boundaries.join(",")) {
        throw new Error(`oracle self-check: generator and checker disagree on ${key}`);
      }
    }
    found.set(key, { key, visits: copy, stops, value, boundaries, mask: maskOf(boundaries, words) });
  };

  /** Grow one end of the route: the end currently sits in `fromHex` and leaves it by `edge`. `side` holds that
   *  end's visits in walking order; `onEnd` is told each time the end stops at a centre. */
  const step = (side: RouteVisit[], fromHex: string, edge: number, onEnd: () => void) => {
    if (exhausted) return;
    expansions += 1;
    if (expansions > options.budget) {
      exhausted = true;
      return;
    }
    const boundary = graph.boundaryAt.get(`${fromHex}:${edge}`);
    if (boundary === undefined || used[boundary]) return;
    const next = neighbourLabel(graph, fromHex, edge);
    if (next === null || graph.barred.has(next)) return;
    const arrival = oppositeEdge(edge);
    used[boundary] = 1;
    usedStack.push(boundary);

    for (const path of pathsAt.get(`${next}:${arrival}`) ?? []) {
      const out = path.a === arrival ? path.b : path.a;
      // IL-11: running past the owner's herald includes it; it may not be included again.
      const passesHerald = heraldIndex !== null && next === graph.heraldHex;
      if (passesHerald && groupUsed[heraldIndex!]) continue;
      if (passesHerald) groupUsed[heraldIndex!] = 1;
      side.push({ hex: next, element: { kind: "path", path }, entry: arrival, exit: out });
      step(side, next, out, onEnd);
      side.pop();
      if (passesHerald) groupUsed[heraldIndex!] = 0;
    }
    for (const node of nodesAt.get(`${next}:${arrival}`) ?? []) {
      const g = groupIndex.get(node.group)!;
      if (groupUsed[g]) continue;
      if (stops + 1 > options.maxStops) continue;
      groupUsed[g] = 1;
      stops += 1;
      value += node.value;
      const visit: RouteVisit = { hex: next, element: { kind: "node", node }, entry: arrival, exit: null };
      side.push(visit);
      onEnd();
      if (!nodeClosedToTransit(graph, node)) {
        for (const out of node.spokes) {
          if (out === arrival || !nodeJoins(node, arrival, out)) continue;
          visit.exit = out;
          step(side, next, out, onEnd);
        }
        visit.exit = null;
      }
      side.pop();
      value -= node.value;
      stops -= 1;
      groupUsed[g] = 0;
    }

    usedStack.pop();
    used[boundary] = 0;
  };

  const joinRoute = (left: RouteVisit[], right: RouteVisit[]): RouteVisit[] => {
    const reversed = [...left].reverse().map((visit) => ({ ...visit, entry: visit.exit, exit: visit.entry }));
    return [...reversed, ...right];
  };

  // NODE ANCHORS: the corporation's station cities and its herald.
  for (const anchor of graph.anchors) {
    if (graph.barred.has(anchor.hex)) continue;
    const g = groupIndex.get(anchor.group)!;
    groupUsed[g] = 1;
    stops = 1;
    value = anchor.value;
    const anchorVisit: RouteVisit = { hex: anchor.hex, element: { kind: "node", node: anchor }, entry: null, exit: null };
    const right: RouteVisit[] = [anchorVisit];
    const left: RouteVisit[] = [];
    for (const first of anchor.spokes) {
      anchorVisit.exit = first;
      step(right, anchor.hex, first, () => {
        // The anchor is one end, the far end is here.
        emit(right);
        // ... or the anchor is interior: grow the other end, the first half's state carried whole.
        if (nodeClosedToTransit(graph, anchor)) return;
        for (const second of anchor.spokes) {
          if (second <= first || !nodeJoins(anchor, first, second)) continue;
          anchorVisit.entry = second;
          step(left, anchor.hex, second, () => emit(joinRoute(left, right)));
          anchorVisit.entry = null;
        }
      });
      anchorVisit.exit = null;
    }
    groupUsed[g] = 0;
    stops = 0;
    value = 0;
  }

  // PATH ANCHORS (IL-3, only when the policy says an uncounted herald is still a station): every rail of the
  // herald hex, run past without stopping.
  if (graph.policy.heraldUncountedIsStation && graph.heraldHex !== null && !graph.barred.has(graph.heraldHex)) {
    const hex = graph.hexes.get(graph.heraldHex)!;
    for (const path of hex.paths) {
      stops = 0;
      value = 0;
      if (heraldIndex !== null) groupUsed[heraldIndex] = 1;
      const right: RouteVisit[] = [{ hex: hex.label, element: { kind: "path", path }, entry: path.a, exit: path.b }];
      const left: RouteVisit[] = [];
      step(right, hex.label, path.b, () => {
        step(left, hex.label, path.a, () => emit(joinRoute(left, right)));
      });
      if (heraldIndex !== null) groupUsed[heraldIndex] = 0;
    }
  }

  const routes = Array.from(found.values()).sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { routes, expansions, exhausted };
}
