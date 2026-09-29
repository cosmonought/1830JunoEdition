// frontend/src/routeOracle/index.ts
//
// ==================================================================
//  ROUTE v12 R12-1: THE INDEPENDENT ROUTE ORACLE (TEST-ONLY)
// ==================================================================
//
// The one entry point: a board, a grid, every corporation's stations and licences, the running corporation and
// its fleet, and the off-board tier -> every legal route, the exact best combination, and a witness set in the
// wire's own waypoint shape. See `oracleGraph.ts` (topology), `oracleRoutes.ts` (the law and the enumeration),
// `oracleOptimum.ts` (the packing) and `oracleJudge.ts` (judging a submission). The R12-1 report
// (Project: claude/ROUTE_V12_R12_1_ORACLE_2026-09-29.md) is the design record.
//
// NEVER IMPORTED BY THE APPLICATION. `routeOracleIndependence.test.ts` enforces both directions: no production
// file imports this directory, and this directory imports no production logic (data and types only).

import { buildOracleGraph, type OracleCaseInput, type OracleGraph, type ValidityFinding } from "./oracleGraph";
import { enumerateRoutes, type OracleRoute } from "./oracleRoutes";
import { optimumRouteSet, type OptimumResult } from "./oracleOptimum";
import { waypointsOf, type OracleWaypoint } from "./oracleJudge";
import { oracleTrainStops } from "./oracleManifest";

export * from "./oracleGraph";
export * from "./oracleRoutes";
export * from "./oracleOptimum";
export * from "./oracleJudge";
export * from "./oracleManifest";

export interface OracleSolveInput extends OracleCaseInput {
  fleet: readonly string[];
  enumerationBudget?: number;
  packingBudget?: number;
  selfCheck?: boolean;
}

export interface OracleSolution {
  graph: OracleGraph;
  validity: ValidityFinding[];
  routes: OracleRoute[];
  expansions: number;
  /** A budget ran out, a train model is unknown, or a route could stop at a printed stop whose figure is
   *  UNRESOLVED (Norfolk): the optimum is not an answer. Every applicable reason, joined. */
  undecided: string | null;
  /** The same, as kinds. `["unresolved-value"]` alone means the enumeration and packing are COMPLETE and only a
   *  figure is missing: the optimum is then exact with that stop priced at a placeholder $0, i.e. a LOWER BOUND. */
  undecidedKinds: UndecidedKind[];
  optimum: OptimumResult;
  witness: Array<{ trainIndex: number; model: string; value: number; waypoints: OracleWaypoint[] }>;
}

export type UndecidedKind = "unknown-model" | "unresolved-value" | "enumeration-budget" | "packing-budget";

export const DEFAULT_ENUMERATION_BUDGET = 5_000_000;
export const DEFAULT_PACKING_BUDGET = 20_000_000;

export function solveOracleCase(input: OracleSolveInput): OracleSolution {
  const graph = buildOracleGraph(input);
  const caps = input.fleet.map((model) => oracleTrainStops(model));
  const unknown = input.fleet.filter((_, i) => caps[i] === null);
  const maxStops = caps.some((cap) => cap === "unlimited")
    ? Number.POSITIVE_INFINITY
    : Math.max(0, ...caps.filter((cap): cap is number => typeof cap === "number"));
  const enumeration = enumerateRoutes(graph, {
    maxStops,
    budget: input.enumerationBudget ?? DEFAULT_ENUMERATION_BUDGET,
    selfCheck: input.selfCheck ?? true,
  });
  const optimum = optimumRouteSet(
    enumeration.routes,
    input.fleet.map((model, trainIndex) => ({ trainIndex, model })),
    input.packingBudget ?? DEFAULT_PACKING_BUDGET,
  );
  // A stop whose figure the oracle does not know (`ORACLE_UNRESOLVED_PRINTED_STOPS`): if any legal route could
  // count it, the optimum depends on a number nobody has established, so the case is not decided.
  const unresolved = Array.from(
    new Set(
      enumeration.routes.flatMap((route) =>
        route.visits.flatMap((visit) => (visit.element.kind === "node" && visit.element.node.unresolvedValue ? [visit.element.node.unresolvedValue] : [])),
      ),
    ),
  );
  // Every reason is kept: an unresolved figure must never hide an exhausted budget (the R12-1 repair review, M2).
  const reasons: Array<[UndecidedKind, string]> = [];
  if (unknown.length > 0) reasons.push(["unknown-model", `unknown train model(s): ${unknown.join(", ")}`]);
  if (unresolved.length > 0) reasons.push(["unresolved-value", `unresolved printed value: ${unresolved.join("; ")}`]);
  if (enumeration.exhausted) reasons.push(["enumeration-budget", "enumeration budget exhausted"]);
  if (optimum.exhausted) reasons.push(["packing-budget", "packing budget exhausted"]);
  const undecided = reasons.length > 0 ? reasons.map(([, text]) => text).join("; ") : null;
  return {
    graph,
    validity: graph.validity,
    routes: enumeration.routes,
    expansions: enumeration.expansions,
    undecided,
    undecidedKinds: reasons.map(([kind]) => kind),
    optimum,
    witness: optimum.assignment.map((entry) => ({
      trainIndex: entry.trainIndex,
      model: entry.model,
      value: entry.route.value,
      waypoints: waypointsOf(entry.route.visits, graph),
    })),
  };
}
