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
import { gridOf, productionAuthority, productionDemonstrated, productionSearch, probeState, reducerAllowsSkip, reducerApplies, skipRefusal, type ProbeCase, type SubmittedSet } from "./productionProbe";
import type { CorpusBoard } from "./corpus";
import { solveOracleCase, judgeRouteSet, type OraclePolicy, type OracleSolution } from "..";

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
  /** Production's set admits several readings the oracle cannot choose between (a wire-format finding). */
  | "wire-ambiguous";

export interface CaseResult {
  board: string;
  companyId: number;
  fleet: readonly string[];
  phaseConsistent: boolean;
  validity: string[];
  oracle: { total: number; routes: number; expansions: number; ms: number; undecided: string | null; witness: OracleSolution["witness"] };
  production: { demonstrated: number | null; total: number; ms: number; set: SubmittedSet };
  /** The authority's own law on production's set (evaluateRouteSet + the Coal River gate). */
  authorityOnProductionSet: string;
  /** The oracle's law on production's set. */
  oracleOnProductionSet: string;
  /** The authority on the oracle's witness (does the authority accept the legal optimum at all?). */
  authorityOnWitness: string;
  reducer?: { appliesProductionSet: boolean; appliesWitness: boolean; allowsSkip: boolean };
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
  "sound-optimal",
];

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
  const oracleLegal = oracleJudge !== null && oracleJudge.kind === "legal";
  // THE ORACLE IS CHECKED FIRST: a set it calls legal may never beat its own optimum.
  if (oracleLegal && oracleJudge.total > optimum) flags.push("oracle-incomplete");
  if (oracleJudge !== null && oracleJudge.kind === "ambiguous") flags.push("wire-ambiguous");
  // Production's figure must be the price of the set it shows -- by the oracle's count and by the authority's.
  const priceMismatch =
    (oracleLegal && oracleJudge.total !== produced) || (authority !== null && authority.kind === "legal" && authority.total !== produced);
  if (priceMismatch) flags.push("price-disagreement");
  const illegal = (oracleJudge !== null && oracleJudge.kind === "illegal") || (!oracleLegal && produced > optimum);
  if (illegal) flags.push("emits-illegal-optimum");
  if (produced <= 0 && optimum > 0) flags.push("fails-to-find-legal-route");

  let reducer: CaseResult["reducer"];
  const notes: string[] = [];
  if (options.reducer) {
    const allowsSkip = reducerAllowsSkip(probe, state);
    reducer = {
      appliesProductionSet: hasSet ? reducerApplies(probe, search.set, state) : false,
      appliesWitness: witnessSet.routes.length > 0 ? reducerApplies(probe, witnessSet, state) : false,
      allowsSkip,
    };
    if (allowsSkip && optimum > 0) flags.push("permits-skip-despite-legal-route");
    // STRANDED (the R12-1 review, M2: defined by the reducer's answers, not by prices): the reducer refuses
    // production's own set, the oracle's legal optimum (when there is one) and the skip. When the witness is
    // refused because the demonstration is above it, every legal set is (the S6-3 shortfall); when it is refused
    // for another reason, the note says so.
    if (!allowsSkip && !reducer.appliesProductionSet && (optimum === 0 || !reducer.appliesWitness)) {
      flags.push("route-phase-stranding");
      if (optimum > 0 && produced <= optimum) notes.push("stranded although the demonstration does not exceed the legal optimum");
    }
  } else {
    // Without the reducer the skip is measured by the scoped predicate, and stranding is only PREDICTED.
    const allowsSkip = skipRefusal(probe, state) === null;
    if (allowsSkip && optimum > 0) flags.push("permits-skip-despite-legal-route");
    const witnessRefused = witnessAuthority === null || witnessAuthority.kind === "refused";
    if (!allowsSkip && authority !== null && authority.kind === "refused" && (optimum === 0 || produced > optimum || witnessRefused)) {
      flags.push("route-phase-stranding");
      notes.push("stranding predicted without the reducer");
    }
  }
  if (!illegal && !flags.includes("oracle-incomplete") && produced > 0) flags.push(produced === optimum ? "sound-optimal" : "sound-suboptimal");
  if (!illegal && produced <= 0 && optimum <= 0) flags.push("sound-optimal");
  const primary = SEVERITY.find((cls) => flags.includes(cls)) ?? "sound-optimal";
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
    oracle: { total: optimum, routes: solution.routes.length, expansions: solution.expansions, ms: oracleMs, undecided: solution.undecided, witness: solution.witness },
    production: { demonstrated, total: produced, ms: search.ms, set: search.set },
    authorityOnProductionSet: verdictText(authority),
    oracleOnProductionSet: oracleJudge === null ? "no set" : oracleJudge.kind === "legal" ? `legal $${oracleJudge.total}` : `${oracleJudge.kind.toUpperCase()}: ${oracleJudge.reason}`,
    authorityOnWitness: verdictText(witnessAuthority),
    reducer,
    flags,
    primary,
    notes,
    delta: optimum - produced,
  };
}

export function routeText(route: ReadonlyArray<{ hex: string; bypass?: boolean; city_node?: number }>): string {
  return route.map((wp) => `${wp.hex}${wp.bypass ? "*" : ""}${wp.city_node !== undefined ? `:${wp.city_node}` : ""}`).join(">");
}
