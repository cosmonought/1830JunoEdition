// frontend/src/routeOracle/oracleOptimum.ts
//
// ==================================================================
//  ROUTE v12 R12-1: THE ORACLE'S EXACT MULTI-TRAIN OPTIMUM
// ==================================================================
//
// TEST-ONLY. Maximum-weight packing of the enumerated routes onto the fleet: each train takes one route it can
// count (or none), no two chosen routes share a boundary (rulebook 6.4.2: a railroad's trains may not use the
// same track; they may meet at cities). Branch and bound with an admissible bound (the running total plus every
// remaining train's best standalone route), so pruning never loses the optimum. Identical trains are symmetric,
// so a train takes only routes AFTER its identical predecessor's in the shared list (an optimality-preserving
// symmetry break). Budgets are counted; exhaustion is UNDECIDED.

import type { OracleRoute } from "./oracleRoutes";
import { oracleTrainStops } from "./oracleManifest";

export interface OracleTrain {
  /** Position in `owned_trains`. */
  trainIndex: number;
  model: string;
}

export interface OptimumResult {
  total: number;
  assignment: Array<{ trainIndex: number; model: string; route: OracleRoute }>;
  explored: number;
  exhausted: boolean;
  /** Models the oracle does not know; such a fleet is UNDECIDED. */
  unknownModels: string[];
}

export function optimumRouteSet(routes: readonly OracleRoute[], fleet: readonly OracleTrain[], budget: number): OptimumResult {
  const unknownModels = fleet.map((train) => train.model).filter((model) => oracleTrainStops(model) === null);
  if (unknownModels.length > 0) return { total: 0, assignment: [], explored: 0, exhausted: false, unknownModels };

  const capOf = (model: string) => {
    const stops = oracleTrainStops(model)!;
    return stops === "unlimited" ? Number.POSITIVE_INFINITY : stops;
  };
  const trains = [...fleet].sort((a, b) => capOf(b.model) - capOf(a.model) || a.trainIndex - b.trainIndex);
  const lists = trains.map((train) => routes.filter((route) => route.stops <= capOf(train.model)));
  const best1 = lists.map((list) => (list.length > 0 ? list[0].value : 0));
  const suffix = new Array<number>(trains.length + 1).fill(0);
  for (let i = trains.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + best1[i];

  const words = routes[0]?.mask.length ?? 1;
  const used = new Uint32Array(words);
  const chosen: Array<OracleRoute | null> = new Array(trains.length).fill(null);
  let best = -1;
  let bestChoice: Array<OracleRoute | null> = [];
  let explored = 0;
  let exhausted = false;

  const disjoint = (mask: Uint32Array) => {
    for (let w = 0; w < words; w += 1) if ((mask[w] & used[w]) !== 0) return false;
    return true;
  };

  /** `previous` is the index the identical predecessor took (-1 = idle, `null` = no identical predecessor). */
  const search = (i: number, total: number, previous: number | null) => {
    if (exhausted) return;
    explored += 1;
    if (explored > budget) {
      exhausted = true;
      return;
    }
    if (total > best) {
      best = total;
      bestChoice = [...chosen];
    }
    if (i === trains.length) return;
    if (total + suffix[i] <= best) return;
    const sameAsPrevious = i > 0 && capOf(trains[i].model) === capOf(trains[i - 1].model);
    const floor = sameAsPrevious ? previous ?? -1 : -1;
    if (sameAsPrevious && floor === -1 && previous === -1) {
      // The identical predecessor is idle: this train idling too is the only non-symmetric option left.
      search(i + 1, total, -1);
      return;
    }
    const list = lists[i];
    for (let k = floor + 1; k < list.length; k += 1) {
      const route = list[k];
      if (total + route.value + suffix[i + 1] <= best) break;
      if (!disjoint(route.mask)) continue;
      for (let w = 0; w < words; w += 1) used[w] |= route.mask[w];
      chosen[i] = route;
      search(i + 1, total + route.value, k);
      chosen[i] = null;
      for (let w = 0; w < words; w += 1) used[w] ^= route.mask[w];
      if (exhausted) return;
    }
    search(i + 1, total, -1);
  };
  search(0, 0, null);

  const assignment = trains.flatMap((train, i) =>
    bestChoice[i] ? [{ trainIndex: train.trainIndex, model: train.model, route: bestChoice[i]! }] : [],
  );
  return { total: Math.max(0, best), assignment, explored, exhausted, unknownModels };
}
