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
  /** A budget ran out or a train model is unknown: the optimum is not an answer. */
  undecided: string | null;
  optimum: OptimumResult;
  witness: Array<{ trainIndex: number; model: string; value: number; waypoints: OracleWaypoint[] }>;
}

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
  const undecided = unknown.length > 0
    ? `unknown train model(s): ${unknown.join(", ")}`
    : enumeration.exhausted
      ? "enumeration budget exhausted"
      : optimum.exhausted
        ? "packing budget exhausted"
        : null;
  return {
    graph,
    validity: graph.validity,
    routes: enumeration.routes,
    expansions: enumeration.expansions,
    undecided,
    optimum,
    witness: optimum.assignment.map((entry) => ({
      trainIndex: entry.trainIndex,
      model: entry.model,
      value: entry.route.value,
      waypoints: waypointsOf(entry.route.visits, graph),
    })),
  };
}
