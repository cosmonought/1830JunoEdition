/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1: PRODUCTION AGAINST THE ORACLE ON REAL BOARDS
// ==================================================================
//
// BY DEFAULT: a bounded, representative sample of the dense-board corpus (standard late game, LPF late game,
// PRR herald cases, Diesel cases, the Coal River stranding cases), every case run through the reducer as well,
// with each case's production class PINNED as it stands today. The classes are KNOWN-RED where they are not
// "sound-optimal": R12-2 is expected to move them, deliberately.
//
// OWNER-RUN (`ROUTE_ORACLE_FULL=1`): the whole B-2 corpus and, when `ROUTE_ORACLE_CORPUS_DIR` names a folder
// holding the owner-local logs (`server/data/*.log.jsonl`, `frontend/sandbox-log-*.json`), the B-1 real
// decision points. Writes `route-oracle-corpus.json` into `ROUTE_ORACLE_OUT` (default: the OS temp folder) and
// asserts only what must hold of ANY corpus: the oracle decides every case, no legal set beats it, and the
// authority accepts every one of its witnesses.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compareCase } from "./harness/compare";
import { denseBoards, licencesFromLog, phaseConsistent, z6cLogEntries } from "./harness/corpus";
import { runDenseCorpus, runRealCorpus, summarise } from "./harness/fullCorpus";

const FULL = process.env.ROUTE_ORACLE_FULL === "1";
const boards = new Map(denseBoards().map((board) => [board.id, board]));

describe("the corpus is built from the logs, not from assumptions", () => {
  it("the Z6C licences are the log's own: B&O by the JK private (136), N&W bought one (393)", () => {
    expect(licencesFromLog(z6cLogEntries(), 494)).toEqual({ 4: 1, 10: 1 });
    // The preflight's probe assumed N&W held none; its Z6C@608 N&W [3,4,4] "Coal River endpoint" was legal.
    const z608 = boards.get("Z6C@608")!;
    expect(z608.companies.find((company) => company.companyId === 10)!.licences).toBe(1);
  });

  it("every dense board is a valid state to the oracle", () => {
    for (const board of Array.from(boards.values())) {
      const result = compareCase(board, board.companies[0].companyId, ["2"], true, { reducer: false });
      expect([board.id, result.validity]).toEqual([board.id, []]);
    }
  });
});

/** [board, corporation, fleet, oracle optimum (`null` = UNDECIDED: a route could stop at Norfolk, whose figure
 *  is unresolved), production's demonstration, production class, every flag].
 *
 *  R12-1 REPAIR: #62 is $80 per city (owner ruling), so every standard / LPF late-game optimum that runs New York
 *  moved by $10 per #62 city counted; production's $90 is recorded as the `production-data-defect` flag and its
 *  set is judged at the law's price. Every Z6C case can reach Norfolk, so each is UNDECIDED; what the oracle can
 *  still say is pinned (the review's M1 / M3): the oracle's "illegal"; stranding, when the reducer refuses the
 *  law's witness AND the best legal set at production's prices; a #62 premium or a certain shortfall below the
 *  placeholder optimum (a lower bound), when production's set avoids Norfolk. */
const SAMPLE: ReadonlyArray<readonly [string, number, readonly string[], number | null, number, string, readonly string[]]> = [
  // Standard 1830, Brown: ordinary positions, a PRR bow case, two Diesels. (Was $180 / $190 / $490 / $800 / $860.)
  ["Y8V@651", 5, ["3"], 170, 150, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"]],
  ["Y8V@651", 2, ["3"], 180, 190, "production-data-defect", ["production-data-defect", "sound-optimal"]], // $190 = the law's $180 + #62's extra $10
  ["Y8V@651", 1, ["4", "6"], 470, 460, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"]], // the preflight's $500 used a bare-token bow run (IL-7)
  ["Y8V@651", 6, ["D"], 780, 680, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"]],
  ["Y8V@651", 8, ["6", "D"], 840, 730, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"]],
  // Level Playing Field, Gray: the herald join and the Coal River endpoint still strand PRR / C&O, whatever
  // Norfolk pays; B&O and N&W are licensed.
  ["Z6C@494", 1, ["D"], null, 710, "oracle-undecided", ["oracle-undecided", "emits-illegal-optimum", "route-phase-stranding"]],
  ["Z6C@494", 1, ["6"], null, 260, "oracle-undecided", ["oracle-undecided", "emits-illegal-optimum"]],
  ["Z6C@494", 5, ["6", "D"], null, 730, "oracle-undecided", ["oracle-undecided", "emits-illegal-optimum", "route-phase-stranding"]],
  ["Z6C@494", 4, ["D"], null, 780, "oracle-undecided", ["oracle-undecided", "production-data-defect"]], // its set avoids Norfolk, so its #62 premium is exact
  ["Z6C@494", 10, ["D"], null, 850, "oracle-undecided", ["oracle-undecided"]], // N&W's licence (393) opens Coal River to it
  ["Z6C@608", 2, ["6", "D"], null, 790, "oracle-undecided", ["oracle-undecided", "emits-illegal-optimum"]],
  ["Z6C@608", 10, ["3", "4", "4"], null, 510, "oracle-undecided", ["oracle-undecided"]], // the preflight's "unsound" row: N&W is licensed
  ["Z6C@608", 1, ["3"], null, 130, "oracle-undecided", ["oracle-undecided", "sound-suboptimal"]], // $130 < the $160 lower bound: suboptimal whatever Norfolk pays
];

describe("a bounded sample of the dense corpus, production classified against the oracle (KNOWN-RED where not optimal)", () => {
  it.each(SAMPLE.map((row) => [`${row[0]} company ${row[1]} [${row[2].join(",")}]`, row] as const))("%s", (_name, row) => {
    const [boardId, companyId, fleet, optimum, demonstrated, primary, flags] = row;
    const board = boards.get(boardId)!;
    const result = compareCase(board, companyId, fleet, phaseConsistent(fleet, board.era), { reducer: true });
    expect(result.validity).toEqual([]);
    expect(result.production.demonstrated).toBe(demonstrated);
    expect(result.primary).toBe(primary);
    expect(result.flags).toEqual([...flags]);
    if (optimum === null) {
      expect(result.oracle.undecidedKinds).toEqual(["unresolved-value"]);
      expect(result.oracle.undecided).toMatch(/^unresolved printed value: Norfolk \(L16\)/);
      return;
    }
    expect(result.oracle.undecided).toBeNull();
    expect(result.oracle.total).toBe(optimum);
    // The oracle's witness is a set the authority itself accepts -- at the oracle's price plus exactly what the
    // catalog's #62 adds to it (the recorded production data defect).
    expect(result.authorityOnWitness).toBe(`legal $${optimum + result.witnessDataPremium}`);
  }, 120_000);
});

(FULL ? describe : describe.skip)("the whole corpus (ROUTE_ORACLE_FULL=1; owner-run)", () => {
  it("B-2 dense boards and B-1 real decision points: the oracle decides everything and nothing legal beats it", () => {
    const dense = runDenseCorpus({ reducer: true });
    const real = runRealCorpus(process.env.ROUTE_ORACLE_CORPUS_DIR, { reducer: true });
    const summaries = [summarise("B-2 dense", dense), summarise("B-1 real", real.results)];
    const out = process.env.ROUTE_ORACLE_OUT ?? os.tmpdir();
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, "route-oracle-corpus.json"),
      JSON.stringify({ summaries, dense, real: real.results, historical: real.historical }, null, 1),
    );
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summaries, null, 1));
    for (const summary of summaries) {
      // Norfolk's unresolved figure (the R12-1 repair's blocker) is the only admissible reason to be undecided.
      expect([summary.corpus, summary.oracleUndecided - summary.oracleUndecidedUnresolvedValue]).toEqual([summary.corpus, 0]);
      expect([summary.corpus, summary.oracleBeatenByLegalSet]).toEqual([summary.corpus, []]);
      expect([summary.corpus, summary.authorityRefusesWitness]).toEqual([summary.corpus, []]);
    }
    expect(summaries[0].invalid).toBe(0);
  }, 6 * 60 * 60 * 1000);
});
