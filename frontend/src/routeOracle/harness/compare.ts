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
import { gridOf, productionAuthority, productionDemonstrated, productionSearch, probeState, reducerAllowsSkip, reducerApplies, skipRefusal, type ProbeCase, type SubmittedSet } from "./productionProbe";
import type { CorpusBoard } from "./corpus";
import {
  solveOracleCase,
  judgeRouteSet,
  judgeWaypoints,
  optimumRouteSet,
  waypointsOf,
  DEFAULT_PACKING_BUDGET,
  ORACLE_STANDARD_TILES,
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
  /** The price difference is EXACTLY a recorded production data defect (#62 at $90 against the owner-ruled $80,
   *  R12-1 repair): known-red for R12-2, not an unexplained disagreement. Optimality is then judged on the
   *  oracle's (lawful) price of production's set. */
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
  /** What production's own prices add to the oracle's price of the witness at the recorded data points (#62's
   *  catalog $90; Norfolk's $20 against the oracle's placeholder): the authority prices the witness at the
   *  oracle's optimum plus this. 0 on a board with neither. */
  witnessDataPremium: number;
  /** The best legal set at PRODUCTION's prices (the same legal routes, re-priced at the data points) -- what the
   *  S6-3 demonstration rule compares with. `null` when the oracle's enumeration is incomplete. */
  productionPricedOptimum: number | null;
  /** `appliesProductionPricedWitness`: the reducer on the best legal set at production's prices (only when that
   *  set differs in price from the oracle's witness). */
  reducer?: { appliesProductionSet: boolean; appliesWitness: boolean; appliesProductionPricedWitness: boolean | null; allowsSkip: boolean };
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

/** Where production's price of a stop is KNOWN to differ from the oracle's for a recorded data reason: a #62 city
 *  (catalog $90, owner-ruled $80: a production data defect) or an unresolved printed stop (Norfolk: production
 *  prices it by its gray-city bucket; the oracle has only a placeholder $0). Keyed by node id; the amount is
 *  production's price minus the oracle's. */
export type PremiumTable = ReadonlyMap<string, { kind: "62" | "unresolved"; amount: number }>;

export function premiumTable(board: CorpusBoard, graph: OracleGraph): PremiumTable {
  const table = new Map<string, { kind: "62" | "unresolved"; amount: number }>();
  const tileOn = new Map<string, number>();
  for (const lay of board.lays) {
    const label = graph.byCoord.get(`${lay.q},${lay.r}`);
    if (label) tileOn.set(label, lay.tile_id);
  }
  const era = board.era === "Brown" || board.era === "Gray" ? "Brown" : "Yellow";
  const grid = gridOf(board.lays);
  Array.from(graph.nodes.values()).forEach((node: OracleNode) => {
    if (node.unresolvedValue !== undefined) {
      const hex = graph.hexes.get(node.hex)!;
      const price = withBoard(board.board, () => hexValueForEra(grid, hex.q, hex.r, era));
      table.set(node.id, { kind: "unresolved", amount: price - node.value });
      return;
    }
    const tileId = tileOn.get(node.hex);
    if (tileId === undefined || ORACLE_STANDARD_TILES[tileId]?.productionDefect === undefined) return;
    const catalog = TILE_CATALOG_BY_ID.get(tileId)?.revenue;
    if (typeof catalog === "number" && catalog !== node.value) table.set(node.id, { kind: "62", amount: catalog - node.value });
  });
  return table;
}

export interface DataPremium {
  /** Production's price minus the oracle's, over every counted stop of the routes the oracle can read. */
  total: number;
  /** Of which from #62 cities. */
  data62: number;
  /** How many counted stops have an unresolved figure (Norfolk). */
  unresolvedVisits: number;
}

/** The data premium of a submitted set (each route read the way the oracle judges it; a route the oracle cannot
 *  read contributes nothing -- it is classified elsewhere). */
export function dataPremium(graph: OracleGraph, table: PremiumTable, routes: ReadonlyArray<readonly OracleWaypoint[]>): DataPremium {
  const out: DataPremium = { total: 0, data62: 0, unresolvedVisits: 0 };
  for (const route of routes) {
    const verdict = judgeWaypoints(graph, route);
    if (verdict.kind !== "legal") continue;
    for (const visit of verdict.visits) {
      if (visit.element.kind !== "node") continue;
      const premium = table.get(visit.element.node.id);
      if (!premium) continue;
      out.total += premium.amount;
      if (premium.kind === "62") out.data62 += premium.amount;
      else out.unresolvedVisits += 1;
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

/** The best legal set at PRODUCTION's prices: the oracle's own legal routes, re-priced at the data points, packed
 *  again. Exact whenever the enumeration is complete. */
function productionPricedOptimum(
  solution: OracleSolution,
  table: PremiumTable,
  fleet: readonly string[],
): { total: number; set: SubmittedSet; differs: boolean } {
  const repriced = solution.routes.map((route) => ({ route, premium: routePremium(table, route) }));
  if (repriced.every((entry) => entry.premium === 0)) {
    return {
      total: solution.optimum.total,
      set: { routes: solution.witness.map((entry) => entry.waypoints), trainIndices: solution.witness.map((entry) => entry.trainIndex) },
      differs: false,
    };
  }
  const packed = optimumRouteSet(
    repriced.map(({ route, premium }) => ({ ...route, value: route.value + premium })).sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    fleet.map((model, trainIndex) => ({ trainIndex, model })),
    DEFAULT_PACKING_BUDGET,
  );
  return {
    total: packed.total,
    set: { routes: packed.assignment.map((entry) => waypointsOf(entry.route.visits, solution.graph)), trainIndices: packed.assignment.map((entry) => entry.trainIndex) },
    differs: true,
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

export function oracleFor(board: CorpusBoard, companyId: number, fleet: readonly string[], policy?: OraclePolicy): OracleSolution {
  return solveOracleCase({
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
    fleet,
    policy,
  });
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

  // WHAT THE ORACLE CAN STILL SAY (the R12-1 repair review, M1 / M3).
  //   decided  -- a complete enumeration and packing, every figure known: the optimum is exact.
  //   complete -- the enumeration and packing are complete but a figure is UNRESOLVED (Norfolk, priced $0): the
  //               optimum is a LOWER BOUND on the law's, every route's legality is exact, and so is the price of
  //               any set that does not count the unresolved stop.
  //   otherwise (a budget, an unknown train) nothing that needs the enumeration is trusted.
  const decided = solution.undecided === null;
  const complete = decided || (solution.undecidedKinds.length === 1 && solution.undecidedKinds[0] === "unresolved-value");
  const table = premiumTable(board, solution.graph);
  const oracleLegal = oracleJudge !== null && oracleJudge.kind === "legal";
  // THE ORACLE IS CHECKED FIRST: a set it calls legal may never beat its own optimum (both price an unresolved
  // stop at the same placeholder, so the check holds on a complete enumeration too).
  if (complete && oracleLegal && oracleJudge.total > optimum) flags.push("oracle-incomplete");
  if (oracleJudge !== null && oracleJudge.kind === "ambiguous") flags.push("wire-ambiguous");
  // Production's figure must be the price of the set it shows -- by the oracle's count and by the authority's.
  // A difference that is EXACTLY #62's recorded premium is that data defect, not a disagreement. A set counting an
  // unresolved stop has no oracle price to compare.
  const setPremium = hasSet ? dataPremium(solution.graph, table, search.set.routes) : { total: 0, data62: 0, unresolvedVisits: 0 };
  const setPriced = oracleLegal && complete && setPremium.unresolvedVisits === 0;
  const authorityMismatch = authority !== null && authority.kind === "legal" && authority.total !== produced;
  const oracleMismatch = setPriced && oracleJudge.total !== produced;
  const explainedByDefect = oracleMismatch && setPremium.data62 !== 0 && oracleJudge.total + setPremium.data62 === produced;
  if (authorityMismatch || (oracleMismatch && !explainedByDefect)) flags.push("price-disagreement");
  if (explainedByDefect) flags.push("production-data-defect");
  // Production's set at the LAW's price (the oracle's) -- what optimality is judged on; and the best legal set at
  // PRODUCTION's prices -- what the S6-3 demonstration rule compares with (never the witness plus its premium,
  // which is only a lower bound: the review's L4).
  const lawProduced = oracleLegal ? oracleJudge.total : produced;
  const productionPriced = complete ? productionPricedOptimum(solution, table, fleet) : null;
  const witnessPremium = witnessSet.routes.length > 0 ? dataPremium(solution.graph, table, witnessSet.routes).total : 0;
  const illegal =
    (oracleJudge !== null && oracleJudge.kind === "illegal") || (productionPriced !== null && !oracleLegal && produced > productionPriced.total);
  if (illegal) flags.push("emits-illegal-optimum");
  if (complete && produced <= 0 && optimum > 0) flags.push("fails-to-find-legal-route");

  let reducer: CaseResult["reducer"];
  const notes: string[] = [];
  if (options.reducer) {
    const allowsSkip = reducerAllowsSkip(probe, state);
    const appliesWitness = witnessSet.routes.length > 0 ? reducerApplies(probe, witnessSet, state) : false;
    // The reducer prices at production's figures, so the law's witness may be refused only because another legal
    // set is worth more THERE: ask about that set too before calling the case stranded (the review's M3).
    const appliesProductionPricedWitness =
      productionPriced !== null && productionPriced.differs && productionPriced.set.routes.length > 0 ? reducerApplies(probe, productionPriced.set, state) : null;
    reducer = {
      appliesProductionSet: hasSet ? reducerApplies(probe, search.set, state) : false,
      appliesWitness,
      appliesProductionPricedWitness,
      allowsSkip,
    };
    if (complete && allowsSkip && optimum > 0) flags.push("permits-skip-despite-legal-route");
    // STRANDED (the R12-1 review, M2: defined by the reducer's answers, not by prices): the reducer refuses
    // production's own set, every candidate legal optimum (the law's and production-priced) and the skip. When
    // they are refused because the demonstration is above them, every legal set is (the S6-3 shortfall); when for
    // another reason, the note says so.
    // "No legal set worth anything": on a decided case the optimum says so; with only a figure unresolved, the
    // placeholder may price a Norfolk-only route at $0, so only "no legal route at all" counts.
    const noLegalValue = decided ? optimum === 0 : solution.routes.length === 0;
    const legalRefused = noLegalValue || (!appliesWitness && appliesProductionPricedWitness !== true);
    if (complete && !allowsSkip && !reducer.appliesProductionSet && legalRefused) {
      flags.push("route-phase-stranding");
      if (optimum > 0 && productionPriced !== null && produced <= productionPriced.total) {
        notes.push("stranded although the demonstration does not exceed the best legal set at production's prices");
      }
    }
  } else {
    // Without the reducer the skip is measured by the scoped predicate, and stranding is only PREDICTED.
    const allowsSkip = skipRefusal(probe, state) === null;
    if (complete && allowsSkip && optimum > 0) flags.push("permits-skip-despite-legal-route");
    const witnessRefused = witnessAuthority === null || witnessAuthority.kind === "refused";
    const shortfall = productionPriced !== null && produced > productionPriced.total;
    if (complete && !allowsSkip && authority !== null && authority.kind === "refused" && (optimum === 0 || shortfall || witnessRefused)) {
      flags.push("route-phase-stranding");
      notes.push("stranding predicted without the reducer");
    }
  }
  if (!illegal && !flags.includes("oracle-incomplete") && produced > 0) {
    if (decided) flags.push(lawProduced === optimum ? "sound-optimal" : "sound-suboptimal");
    // Only a figure is unresolved: the placeholder optimum is a LOWER bound, so a set that avoids the unresolved
    // stop and is priced below it is certainly suboptimal; nothing can be called optimal.
    else if (setPriced && lawProduced < optimum) flags.push("sound-suboptimal");
  }
  if (decided && !illegal && produced <= 0 && optimum <= 0) flags.push("sound-optimal");
  if (flags.includes("sound-suboptimal") && productionPriced !== null && productionPriced.differs && produced === productionPriced.total) {
    notes.push("suboptimal only at the law's prices: production's set is the best at its own (#62) prices");
  }
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
    productionPricedOptimum: productionPriced === null ? null : productionPriced.total,
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
