// frontend/src/routeOracle/harness/fullCorpus.ts
//
// ==================================================================
//  ROUTE v12 R12-1: THE WHOLE CORPUS, ONE CALL (OWNER-RUN)
// ==================================================================
//
// TEST-ONLY. B-2 (the three dense boards x every corporation with a station or a herald x the twelve stress
// fleets) and, when the owner-local corpus directory is given, B-1 (every real decision point, fixture-style).
// Returns every case and a summary per corpus. `routeOracleCorpus.test.ts` runs a bounded sample by default and
// this whole thing only under `ROUTE_ORACLE_FULL=1`.

import { compareCase, type CaseResult, type ProductionClass } from "./compare";
import { denseBoards, phaseConsistent, STRESS_FLEETS } from "./corpus";
import { realDecisionPoints } from "./realLogs";
import { productionAuthority } from "./productionProbe";
import { probeCaseFor, oracleFor } from "./compare";
import { judgeRouteSet } from "..";

export interface CorpusSummary {
  corpus: string;
  cases: number;
  byPrimary: Partial<Record<ProductionClass, number>>;
  byFlag: Partial<Record<ProductionClass, number>>;
  optimal: number;
  missed: number;
  singleTrain: { cases: number; missed: number };
  gap: { min: number; median: number; max: number } | null;
  phaseConsistent: { cases: number; optimal: number };
  oracleUndecided: number;
  invalid: number;
  /** The authority refused the oracle's own legal optimum: an authority incompleteness or an oracle error. */
  authorityRefusesWitness: string[];
  /** The authority refused the law's witness only because of production's one circle at Montreal / Norfolk (R12-2 data). */
  witnessRefusedByCircles: number;
  /** The authority refused the best set under production's own data: an authority gap, whatever the data. */
  authorityRefusesProductionDataWitness: string[];
  /** Production's set judged LEGAL by the oracle yet worth more than the oracle's optimum: an oracle error. */
  oracleBeatenByLegalSet: string[];
  maxOracleMs: number;
  maxProductionMs: number;
  maxRoutes: number;
}

export interface HistoricalJudgement {
  id: string;
  authority: string;
  oracle: string;
}

export function summarise(corpus: string, results: readonly CaseResult[]): CorpusSummary {
  const count = <K extends string>(keys: K[]) => keys.reduce((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {} as Partial<Record<K, number>>);
  const missedCases = results.filter((r) => r.flags.includes("sound-suboptimal"));
  const gaps = missedCases.map((r) => r.delta).sort((a, b) => a - b);
  const single = results.filter((r) => r.fleet.length === 1);
  const consistent = results.filter((r) => r.phaseConsistent);
  return {
    corpus,
    cases: results.length,
    byPrimary: count(results.map((r) => r.primary)),
    byFlag: count(results.flatMap((r) => r.flags)),
    // Optimal at the LAW's prices, whatever else is flagged (a #62 case is primary `production-data-defect`).
    optimal: results.filter((r) => r.flags.includes("sound-optimal")).length,
    missed: missedCases.length,
    singleTrain: { cases: single.length, missed: single.filter((r) => r.flags.includes("sound-suboptimal")).length },
    gap: gaps.length > 0 ? { min: gaps[0], median: gaps[Math.floor(gaps.length / 2)], max: gaps[gaps.length - 1] } : null,
    phaseConsistent: { cases: consistent.length, optimal: consistent.filter((r) => r.flags.includes("sound-optimal")).length },
    oracleUndecided: results.filter((r) => r.oracle.undecided !== null).length,
    invalid: results.filter((r) => r.validity.length > 0).length,
    // Refusals explained ONLY by production's one circle at Montreal / Norfolk are the data defect, counted apart; the authority
    // must still accept the best set under production's data.
    authorityRefusesWitness: results
      .filter((r) => r.authorityOnWitness.startsWith("REFUSED") && !r.witnessRefusedByCircles)
      .map((r) => `${r.board} ${r.companyId} [${r.fleet}]: ${r.authorityOnWitness}`),
    // Judged at the oracle's own price of production's set (never production's figure, which a recorded data
    // defect such as #62 inflates).
    witnessRefusedByCircles: results.filter((r) => r.witnessRefusedByCircles).length,
    authorityRefusesProductionDataWitness: results
      .filter((r) => r.authorityOnProductionDataWitness.startsWith("REFUSED"))
      .map((r) => `${r.board} ${r.companyId} [${r.fleet}]: ${r.authorityOnProductionDataWitness}`),
    oracleBeatenByLegalSet: results
      .filter((r) => r.flags.includes("oracle-incomplete"))
      .map((r) => `${r.board} ${r.companyId} [${r.fleet}]`),
    maxOracleMs: Math.max(0, ...results.map((r) => r.oracle.ms)),
    maxProductionMs: Math.max(0, ...results.map((r) => r.production.ms)),
    maxRoutes: Math.max(0, ...results.map((r) => r.oracle.routes)),
  };
}

export function runDenseCorpus(options: { reducer: boolean; onCase?: (result: CaseResult) => void }): CaseResult[] {
  const results: CaseResult[] = [];
  for (const board of denseBoards()) {
    const heraldOwners = new Set(board.board.hexes.flatMap((hex) => (hex.herald ? [hex.herald.companyId] : [])));
    for (const company of board.companies) {
      if (company.tokens.length === 0 && !heraldOwners.has(company.companyId)) continue;
      for (const fleet of STRESS_FLEETS) {
        const result = compareCase(board, company.companyId, fleet, phaseConsistent(fleet, board.era), { reducer: options.reducer });
        results.push(result);
        options.onCase?.(result);
      }
    }
  }
  return results;
}

export function runRealCorpus(dir: string | undefined, options: { reducer: boolean; onCase?: (result: CaseResult) => void }): {
  results: CaseResult[];
  historical: HistoricalJudgement[];
} {
  const results: CaseResult[] = [];
  const historical: HistoricalJudgement[] = [];
  for (const point of realDecisionPoints(dir)) {
    const result = compareCase(point.board, point.companyId, point.fleet, true, { reducer: options.reducer });
    results.push(result);
    options.onCase?.(result);
    const authority = productionAuthority(probeCaseFor(point.board, point.companyId, point.fleet), point.submitted);
    const oracle = judgeRouteSet(oracleFor(point.board, point.companyId, point.fleet).graph, point.fleet, point.submitted.routes, point.submitted.trainIndices);
    historical.push({
      id: point.board.id,
      authority: authority.kind === "legal" ? `legal $${authority.total}` : `REFUSED: ${authority.reason}`,
      oracle: oracle.kind === "legal" ? `legal $${oracle.total}` : `${oracle.kind.toUpperCase()}: ${oracle.reason}`,
    });
  }
  return { results, historical };
}
