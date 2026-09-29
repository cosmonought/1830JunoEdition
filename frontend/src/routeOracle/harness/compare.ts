// frontend/src/routeOracle/harness/compare.ts
//
// ==================================================================
//  ROUTE v12 R12-1: ONE CASE, BOTH SIDES, ONE CLASSIFICATION
// ==================================================================
//
// TEST-ONLY. For one (board, corporation, fleet): the oracle's exact optimum and witness, production's
// demonstrated value and set, the authority's and the oracle's verdicts on production's set, and -- when asked
// -- the reducer's answers on production's set, on the oracle's legal witness and on the skip. Then the brief's
// section-7 classification (several flags may hold at once; `primary` picks the most severe).

import { TILE_CATALOG_BY_ID } from "../../components/hexTileCatalog";
import { withBoard } from "../../components/hexBoardData";
import { hexValueForEra } from "../../components/hexGeometry";
import { citySlotCount } from "../../gameEngine/stationTokens";
import { gridOf, productionAuthority, productionDemonstrated, productionSearch, probeState, reducerAllowsSkip, reducerApplies, skipRefusal, type ProbeCase, type SubmittedSet } from "./productionProbe";
import type { CorpusBoard } from "./corpus";
import {
  solveOracleCase,
  judgeRouteSet,
  judgeWaypoints,
  optimumRouteSet,
  waypointsOf,
  buildOracleGraph,
  enumerateRoutes,
  oracleTrainStops,
  DEFAULT_ENUMERATION_BUDGET,
  DEFAULT_PACKING_BUDGET,
  ORACLE_EXPANSION_PRINTED_CITY_SLOTS,
  ORACLE_EXPANSION_BOARD_IDS,
  ORACLE_EXPANSION_PRINTED_TIERS,
  ORACLE_STANDARD_TILES,
  type OracleCaseInput,
  type OracleGraph,
  type OracleNode,
  type OraclePolicy,
  type OracleRoute,
  type OracleSolution,
  type OracleWaypoint,
} from "..";

export type ProductionClass =
  | "sound-optimal"
  | "sound-suboptimal"
  | "emits-illegal-optimum"
  | "fails-to-find-legal-route"
  | "permits-skip-despite-legal-route"
  | "route-phase-stranding"
  | "oracle-undecided"
  | "invalid-state"
  /** A set the ORACLE judges legal is worth more than the oracle's own optimum: the oracle is wrong, not
   *  production. Most severe: nothing else about the case can be trusted. */
  | "oracle-incomplete"
  /** Production's own figure for its set differs from the oracle's price of that set, or the authority's. */
  | "price-disagreement"
  /** A recorded production DATA defect (owner-ruled; known-red for R12-2) explains part of the case, exactly:
   *  production's figure is the law's price plus the data premium (#62 at $90 against $80; Montreal / Norfolk
   *  priced flat against $40 / $60 and $30 / $50); or production's set is the best under its own data but not the
   *  law's; or the law's witness is refused only by Norfolk's one production circle (owner: two). Optimality is
   *  judged at the law's price. */
  | "production-data-defect"
  /** Production's set admits several readings the oracle cannot choose between (a wire-format finding). */
  | "wire-ambiguous";

export interface CaseResult {
  board: string;
  companyId: number;
  fleet: readonly string[];
  phaseConsistent: boolean;
  validity: string[];
  oracle: {
    total: number;
    routes: number;
    expansions: number;
    ms: number;
    undecided: string | null;
    undecidedKinds: OracleSolution["undecidedKinds"];
    witness: OracleSolution["witness"];
  };
  production: { demonstrated: number | null; total: number; ms: number; set: SubmittedSet };
  /** The authority's own law on production's set (evaluateRouteSet + the Coal River gate). */
  authorityOnProductionSet: string;
  /** The oracle's law on production's set. */
  oracleOnProductionSet: string;
  /** The authority on the oracle's witness (does the authority accept the legal optimum at all?). */
  authorityOnWitness: string;
  /** What production's own prices add to the oracle's price of the witness at the recorded data defects (#62's
   *  catalog $90; Montreal / Norfolk priced flat on the 1830+ map): the authority prices the witness at the
   *  oracle's optimum plus this (it may be negative). 0 where none is counted. */
  witnessDataPremium: number;
  /** The best set under PRODUCTION's data (the oracle's law with production's prices and station circles at the
   *  recorded data defects) -- what production's search and the S6-3 demonstration rule compare with. `null` when
   *  the oracle is undecided or a budget ran out. */
  productionDataOptimum: number | null;
  /** The authority on that set (the oracle's witness itself when the data change nothing). */
  authorityOnProductionDataWitness: string;
  /** The authority refused the law's witness only because production gives Norfolk one circle. */
  witnessRefusedByNorfolkCircles: boolean;
  /** `appliesProductionDataWitness`: the reducer on the best set under production's data (only when it differs). */
  reducer?: { appliesProductionSet: boolean; appliesWitness: boolean; appliesProductionDataWitness: boolean | null; allowsSkip: boolean };
  flags: ProductionClass[];
  primary: ProductionClass;
  /** Observations that are not classes (e.g. the authority accepting an illegal demonstration). */
  notes: string[];
  delta: number;
}

export interface CompareOptions {
  reducer: boolean;
  policy?: OraclePolicy;
}

const SEVERITY: ProductionClass[] = [
  "oracle-incomplete",
  "invalid-state",
  "oracle-undecided",
  "wire-ambiguous",
  "price-disagreement",
  "route-phase-stranding",
  "emits-illegal-optimum",
  "permits-skip-despite-legal-route",
  "fails-to-find-legal-route",
  "sound-suboptimal",
  // A route-sound case whose only fault is a recorded data defect's price: below every route defect, so it
  // never hides one, and above "sound-optimal", so it is never mistaken for a clean case.
  "production-data-defect",
  "sound-optimal",
];

/** Where production's price of a stop is KNOWN to differ from the oracle's for a RECORDED PRODUCTION DATA DEFECT
 *  (owner-ruled, R12-2): a #62 city (catalog $90, ruled $80), or on the 1830+ map one of the two-value gray cities
 *  production prices flat (Montreal A19 $40 / $60, Norfolk L16 $30 / $50; production: $40, $20). Keyed by node id;
 *  the amount is production's price minus the oracle's (it may be negative). Nothing else is ever excused. */
export type PremiumTable = ReadonlyMap<string, { kind: "tile" | "printed"; amount: number }>;

export function premiumTable(board: CorpusBoard, graph: OracleGraph): PremiumTable {
  const table = new Map<string, { kind: "tile" | "printed"; amount: number }>();
  const tileOn = new Map<string, number>();
  for (const lay of board.lays) {
    const label = graph.byCoord.get(`${lay.q},${lay.r}`);
    if (label) tileOn.set(label, lay.tile_id);
  }
  const era = board.era === "Brown" || board.era === "Gray" ? "Brown" : "Yellow";
  const grid = gridOf(board.lays);
  const expansion = ORACLE_EXPANSION_BOARD_IDS.includes(board.board.id);
  Array.from(graph.nodes.values()).forEach((node: OracleNode) => {
    if (expansion && ORACLE_EXPANSION_PRINTED_TIERS[node.hex] !== undefined && !tileOn.has(node.hex)) {
      const hex = graph.hexes.get(node.hex)!;
      const price = withBoard(board.board, () => hexValueForEra(grid, hex.q, hex.r, era));
      if (price !== node.value) table.set(node.id, { kind: "printed", amount: price - node.value });
      return;
    }
    const tileId = tileOn.get(node.hex);
    if (tileId === undefined || ORACLE_STANDARD_TILES[tileId]?.productionDefect === undefined) return;
    const catalog = TILE_CATALOG_BY_ID.get(tileId)?.revenue;
    if (typeof catalog === "number" && catalog !== node.value) table.set(node.id, { kind: "tile", amount: catalog - node.value });
  });
  return table;
}

export interface DataPremium {
  /** Production's price minus the oracle's, over every counted stop of the routes the oracle can read. */
  total: number;
  /** Of which from #62 cities. */
  tile: number;
  /** Of which from the flat-priced two-value gray cities (Montreal, Norfolk). */
  printed: number;
}

/** The data premium of a submitted set (each route read the way the oracle judges it; a route the oracle cannot
 *  read contributes nothing -- it is classified elsewhere). */
export function dataPremium(graph: OracleGraph, table: PremiumTable, routes: ReadonlyArray<readonly OracleWaypoint[]>): DataPremium {
  const out: DataPremium = { total: 0, tile: 0, printed: 0 };
  for (const route of routes) {
    const verdict = judgeWaypoints(graph, route);
    if (verdict.kind !== "legal") continue;
    for (const visit of verdict.visits) {
      if (visit.element.kind !== "node") continue;
      const premium = table.get(visit.element.node.id);
      if (!premium) continue;
      out.total += premium.amount;
      if (premium.kind === "tile") out.tile += premium.amount;
      else out.printed += premium.amount;
    }
  }
  return out;
}

function routePremium(table: PremiumTable, route: OracleRoute): number {
  let premium = 0;
  for (const visit of route.visits) {
    if (visit.element.kind === "node") premium += table.get(visit.element.node.id)?.amount ?? 0;
  }
  return premium;
}

/** THE LAW UNDER PRODUCTION'S DATA: the oracle's own route law, on a graph whose recorded production data
 *  defects are put back the way production has them -- its prices (the premium table: #62, Montreal / Norfolk
 *  flat) and its station circles (Norfolk: one, the superseded #1401 ruling). Its optimum is what production's
 *  search and the S6-3 demonstration rule are aiming at, so it separates a data defect from a search or law
 *  defect. `null` if a budget runs out (never guessed: the repair review's residual Low). */
function productionDataOptimum(
  board: CorpusBoard,
  solution: OracleSolution,
  table: PremiumTable,
  input: OracleCaseInput,
  fleet: readonly string[],
): { total: number; set: SubmittedSet; differs: boolean; circlesMatter: boolean; graph: OracleGraph } | null {
  const graph = buildOracleGraph(input);
  // Production's circles are put back only where they change THIS position (the closure review, M1): the city
  // would be shut to the runner under production's count but is open under the law's.
  let circlesMatter = false;
  if (ORACLE_EXPANSION_BOARD_IDS.includes(board.board.id)) {
    const grid = gridOf(board.lays);
    for (const label of Object.keys(ORACLE_EXPANSION_PRINTED_CITY_SLOTS)) {
      const hex = graph.hexes.get(label);
      const node = hex?.nodes.find((entry) => entry.kind === "city");
      if (!hex || !node) continue;
      const production = withBoard(board.board, () => citySlotCount(grid, hex.q, hex.r, 0));
      const holders = graph.stations.get(node.id) ?? [];
      if (holders.includes(input.companyId)) continue;
      if (holders.length >= production && holders.length < node.slots) {
        (node as { slots: number }).slots = production;
        circlesMatter = true;
      }
    }
  }
  const premiumMatters = solution.routes.some((route) => routePremium(table, route) !== 0);
  if (!circlesMatter && !premiumMatters) {
    return {
      total: solution.optimum.total,
      set: { routes: solution.witness.map((entry) => entry.waypoints), trainIndices: solution.witness.map((entry) => entry.trainIndex) },
      differs: false,
      circlesMatter,
      graph: solution.graph,
    };
  }
  const caps = fleet.map((model) => oracleTrainStops(model));
  if (caps.some((cap) => cap === null)) return null;
  const maxStops = caps.some((cap) => cap === "unlimited") ? Number.POSITIVE_INFINITY : Math.max(0, ...(caps as number[]));
  const enumeration = enumerateRoutes(graph, { maxStops, budget: DEFAULT_ENUMERATION_BUDGET, selfCheck: false });
  if (enumeration.exhausted) return null;
  const packed = optimumRouteSet(
    enumeration.routes
      .map((route) => ({ ...route, value: route.value + routePremium(table, route) }))
      .sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    fleet.map((model, trainIndex) => ({ trainIndex, model })),
    DEFAULT_PACKING_BUDGET,
  );
  if (packed.exhausted) return null;
  return {
    total: packed.total,
    set: { routes: packed.assignment.map((entry) => waypointsOf(entry.route.visits, graph)), trainIndices: packed.assignment.map((entry) => entry.trainIndex) },
    differs: true,
    circlesMatter,
    graph,
  };
}

export function probeCaseFor(board: CorpusBoard, companyId: number, fleet: readonly string[]): ProbeCase {
  return {
    board: board.board,
    variants: board.variants,
    grid: gridOf(board.lays),
    companies: board.companies.map((company) => ({ ...company, trains: company.companyId === companyId ? fleet : [] })),
    companyId,
    era: board.era,
  };
}

export function oracleInputFor(board: CorpusBoard, companyId: number, policy?: OraclePolicy): OracleCaseInput {
  return {
    board: board.board,
    grid: board.lays,
    catalog: TILE_CATALOG_BY_ID,
    companies: board.companies.map((company) => ({
      companyId: company.companyId,
      tokens: company.tokens.map((token) => ({ q: token[0], r: token[1], city: token.length === 3 ? token[2] : null })),
      licences: company.licences,
    })),
    companyId,
    highTier: board.era === "Brown" || board.era === "Gray",
    licenceRule: board.variants.levelPlayingField === true,
    policy,
  };
}

export function oracleFor(board: CorpusBoard, companyId: number, fleet: readonly string[], policy?: OraclePolicy): OracleSolution {
  return solveOracleCase({ ...oracleInputFor(board, companyId, policy), fleet });
}

export function compareCase(board: CorpusBoard, companyId: number, fleet: readonly string[], phaseOk: boolean, options: CompareOptions): CaseResult {
  const started = Date.now();
  const solution = oracleFor(board, companyId, fleet, options.policy);
  const oracleMs = Date.now() - started;
  const probe = probeCaseFor(board, companyId, fleet);
  const state = probeState(probe);
  const demonstrated = productionDemonstrated(probe, state);
  const search = productionSearch(probe, state);
  if (demonstrated !== null && demonstrated !== search.total) {
    throw new Error(`harness: the replicated search (${search.total}) differs from maxRouteRevenueFor (${demonstrated})`);
  }
  const hasSet = search.set.routes.length > 0;
  const authority = hasSet ? productionAuthority(probe, search.set, state) : null;
  const oracleJudge = hasSet ? judgeRouteSet(solution.graph, fleet, search.set.routes, search.set.trainIndices) : null;
  const witnessSet: SubmittedSet = {
    routes: solution.witness.map((entry) => entry.waypoints),
    trainIndices: solution.witness.map((entry) => entry.trainIndex),
  };
  const witnessAuthority = witnessSet.routes.length > 0 ? productionAuthority(probe, witnessSet, state) : null;

  const optimum = solution.optimum.total;
  const produced = search.total;
  const flags: ProductionClass[] = [];
  const validity = solution.validity.filter((finding) => !(board.synthetic && finding.code === "V10"));
  if (validity.length > 0) flags.push("invalid-state");
  if (solution.undecided !== null) flags.push("oracle-undecided");

  // A budget or an unknown train leaves nothing that needs the enumeration trusted: every price-dependent flag
  // is withheld; the oracle's own verdict on production's set and the reducer's answers stand.
  const decided = solution.undecided === null;
  const table = premiumTable(board, solution.graph);
  const oracleLegal = oracleJudge !== null && oracleJudge.kind === "legal";
  // THE ORACLE IS CHECKED FIRST: a set it calls legal may never beat its own optimum.
  if (decided && oracleLegal && oracleJudge.total > optimum) flags.push("oracle-incomplete");
  if (oracleJudge !== null && oracleJudge.kind === "ambiguous") flags.push("wire-ambiguous");
  // Production's figure must be the price of the set it shows -- by the oracle's count and by the authority's.
  // A difference that is EXACTLY the recorded data defects' premium (#62; Montreal / Norfolk flat) is that data
  // defect, not a disagreement.
  const setPremium = hasSet ? dataPremium(solution.graph, table, search.set.routes) : { total: 0, tile: 0, printed: 0 };
  const authorityMismatch = authority !== null && authority.kind === "legal" && authority.total !== produced;
  const oracleMismatch = decided && oracleLegal && oracleJudge.total !== produced;
  const explainedByDefect = oracleMismatch && setPremium.total !== 0 && oracleJudge.total + setPremium.total === produced;
  if (authorityMismatch || (oracleMismatch && !explainedByDefect)) flags.push("price-disagreement");
  if (explainedByDefect) flags.push("production-data-defect");
  // Production's set at the LAW's price (the oracle's) -- what optimality is judged on; and the best set under
  // PRODUCTION's data (the law with production's prices and circles) -- what the S6-3 demonstration rule compares
  // with (never the witness plus its premium, which is only a lower bound: the repair review's L4).
  const lawProduced = oracleLegal ? oracleJudge.total : produced;
  const productionData = decided ? productionDataOptimum(board, solution, table, oracleInputFor(board, companyId, options.policy), fleet) : null;
  const witnessPremium = witnessSet.routes.length > 0 ? dataPremium(solution.graph, table, witnessSet.routes).total : 0;
  // The law's witness refused ONLY because production shuts Norfolk with its one circle -- the data defect, not an
  // authority gap (the closure review, M1): the circles matter in this position; the oracle's own law, run on
  // production's circles, refuses the witness for exactly that ("L16/city0 is filled"); the authority says so
  // ("L16 is tokened out"); and every witness route that does not run through Norfolk is accepted on its own, so a
  // second refusal cannot hide behind the first. The authority is then held to the production-data set instead.
  const witnessRefusedByCircles = (() => {
    if (productionData === null || !productionData.circlesMatter || witnessAuthority === null || witnessAuthority.kind !== "refused") return false;
    if (!/L16 is tokened out/.test(witnessAuthority.reason)) return false;
    const onProductionCircles = judgeRouteSet(productionData.graph, fleet, witnessSet.routes, witnessSet.trainIndices);
    if (onProductionCircles.kind !== "illegal" || !/L16\/city0 is filled/.test(onProductionCircles.reason)) return false;
    return witnessSet.routes.every(
      (route, i) =>
        // Only a run THROUGH Norfolk is shut by its circles; a route that merely ends there is checked too.
        route.slice(1, -1).some((wp) => wp.hex === "L16" && wp.bypass !== true) ||
        productionAuthority(probe, { routes: [route], trainIndices: [witnessSet.trainIndices[i]] }, state).kind === "legal",
    );
  })();
  const dataWitnessAuthority =
    productionData !== null && productionData.differs && productionData.set.routes.length > 0 ? productionAuthority(probe, productionData.set, state) : null;
  const illegal =
    (oracleJudge !== null && oracleJudge.kind === "illegal") || (productionData !== null && !oracleLegal && produced > productionData.total);
  if (illegal) flags.push("emits-illegal-optimum");
  if (decided && produced <= 0 && optimum > 0) flags.push("fails-to-find-legal-route");

  let reducer: CaseResult["reducer"];
  const notes: string[] = [];
  if (options.reducer) {
    const allowsSkip = reducerAllowsSkip(probe, state);
    const appliesWitness = witnessSet.routes.length > 0 ? reducerApplies(probe, witnessSet, state) : false;
    // The reducer works on production's data, so the law's witness may be refused only because of a data defect
    // (a set worth more at production's prices; Norfolk shut by its one circle): ask about the best set under
    // production's data too before calling the case stranded (the review's M3).
    const appliesProductionDataWitness =
      productionData !== null && productionData.differs && productionData.set.routes.length > 0 ? reducerApplies(probe, productionData.set, state) : null;
    reducer = {
      appliesProductionSet: hasSet ? reducerApplies(probe, search.set, state) : false,
      appliesWitness,
      appliesProductionDataWitness,
      allowsSkip,
    };
    if (decided && allowsSkip && optimum > 0) flags.push("permits-skip-despite-legal-route");
    // STRANDED (the R12-1 review, M2: defined by the reducer's answers, not by prices): the reducer refuses
    // production's own set, every candidate optimum (the law's, and the law's under production's data) and the skip. When
    // they are refused because the demonstration is above them, every legal set is (the S6-3 shortfall); when for
    // another reason, the note says so.
    const legalRefused = optimum === 0 || (!appliesWitness && appliesProductionDataWitness !== true);
    if (decided && !allowsSkip && !reducer.appliesProductionSet && legalRefused) {
      flags.push("route-phase-stranding");
      if (optimum > 0 && productionData !== null && produced <= productionData.total) {
        notes.push("stranded although the demonstration does not exceed the best set under production's data");
      }
    }
  } else {
    // Without the reducer the skip is measured by the scoped predicate, and stranding is only PREDICTED.
    const allowsSkip = skipRefusal(probe, state) === null;
    if (decided && allowsSkip && optimum > 0) flags.push("permits-skip-despite-legal-route");
    // Where only Norfolk's circles refuse the law's witness, ask about the production-data set instead (review L2).
    const judged = witnessRefusedByCircles ? dataWitnessAuthority : witnessAuthority;
    const witnessRefused = judged === null || judged.kind === "refused";
    const shortfall = productionData !== null && produced > productionData.total;
    if (decided && !allowsSkip && authority !== null && authority.kind === "refused" && (optimum === 0 || shortfall || witnessRefused)) {
      flags.push("route-phase-stranding");
      notes.push("stranding predicted without the reducer");
    }
  }
  if (!illegal && !flags.includes("oracle-incomplete") && produced > 0) {
    if (decided) flags.push(lawProduced === optimum ? "sound-optimal" : "sound-suboptimal");
  }
  if (decided && !illegal && produced <= 0 && optimum <= 0) flags.push("sound-optimal");
  // A search that finds the best set under production's own data but not the law's best is short only because of
  // the recorded data defects: flagged as such, so the search is not blamed for them.
  if (flags.includes("sound-suboptimal") && productionData !== null && productionData.differs && produced === productionData.total) {
    notes.push("suboptimal only because of production's data defects: production's set is the best under its own data");
    if (!flags.includes("production-data-defect")) flags.push("production-data-defect");
  }
  if (witnessRefusedByCircles && !flags.includes("production-data-defect")) flags.push("production-data-defect");
  const primary = SEVERITY.find((cls) => flags.includes(cls)) ?? (decided ? "sound-optimal" : "oracle-undecided");
  if (illegal && authority !== null && authority.kind === "legal") {
    notes.push("the authority ACCEPTS production's law-illegal set, so the S6-3 shortfall compels an illegal run");
  }
  if (witnessAuthority !== null && witnessAuthority.kind === "refused") {
    notes.push(`the authority refuses the oracle's legal optimum: ${witnessAuthority.reason}`);
  }

  const verdictText = (v: ReturnType<typeof productionAuthority> | null) => (v === null ? "no set" : v.kind === "legal" ? `legal $${v.total}` : `REFUSED: ${v.reason}`);
  return {
    board: board.id,
    companyId,
    fleet,
    phaseConsistent: phaseOk,
    validity: validity.map((finding) => `${finding.code} ${finding.detail}`),
    oracle: {
      total: optimum,
      routes: solution.routes.length,
      expansions: solution.expansions,
      ms: oracleMs,
      undecided: solution.undecided,
      undecidedKinds: solution.undecidedKinds,
      witness: solution.witness,
    },
    production: { demonstrated, total: produced, ms: search.ms, set: search.set },
    authorityOnProductionSet: verdictText(authority),
    oracleOnProductionSet: oracleJudge === null ? "no set" : oracleJudge.kind === "legal" ? `legal $${oracleJudge.total}` : `${oracleJudge.kind.toUpperCase()}: ${oracleJudge.reason}`,
    authorityOnWitness: verdictText(witnessAuthority),
    witnessDataPremium: witnessPremium,
    productionDataOptimum: productionData === null ? null : productionData.total,
    authorityOnProductionDataWitness: productionData === null ? "no set" : productionData.differs ? verdictText(dataWitnessAuthority) : verdictText(witnessAuthority),
    witnessRefusedByNorfolkCircles: witnessRefusedByCircles,
    reducer,
    flags,
    primary,
    notes,
    delta: optimum - lawProduced,
  };
}

export function routeText(route: ReadonlyArray<{ hex: string; bypass?: boolean; city_node?: number }>): string {
  return route.map((wp) => `${wp.hex}${wp.bypass ? "*" : ""}${wp.city_node !== undefined ? `:${wp.city_node}` : ""}`).join(">");
}
