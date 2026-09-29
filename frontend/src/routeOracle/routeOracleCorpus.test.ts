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

/** [board, corporation, fleet, oracle optimum, production's demonstration, production class] */
const SAMPLE: ReadonlyArray<readonly [string, number, readonly string[], number, number, string]> = [
  // Standard 1830, Brown: ordinary positions, a PRR bow case, two Diesels.
  ["Y8V@651", 5, ["3"], 180, 150, "sound-suboptimal"],
  ["Y8V@651", 2, ["3"], 190, 190, "sound-optimal"],
  ["Y8V@651", 1, ["4", "6"], 490, 460, "sound-suboptimal"], // the preflight's $500 used a bare-token bow run (IL-7)
  ["Y8V@651", 6, ["D"], 800, 680, "sound-suboptimal"], // 16,187 legal routes
  ["Y8V@651", 8, ["6", "D"], 860, 730, "sound-suboptimal"],
  // Level Playing Field, Gray: the herald join and the Coal River endpoint strand PRR; B&O is licensed.
  ["Z6C@494", 1, ["D"], 660, 710, "route-phase-stranding"],
  ["Z6C@494", 1, ["6"], 300, 260, "emits-illegal-optimum"],
  ["Z6C@494", 5, ["6", "D"], 720, 730, "route-phase-stranding"],
  ["Z6C@494", 4, ["D"], 780, 780, "sound-optimal"],
  ["Z6C@494", 10, ["D"], 850, 850, "sound-optimal"], // N&W's licence (393) opens Coal River to it
  ["Z6C@608", 2, ["6", "D"], 820, 790, "emits-illegal-optimum"],
  ["Z6C@608", 10, ["3", "4", "4"], 510, 510, "sound-optimal"], // the preflight's "unsound" row: N&W is licensed
  ["Z6C@608", 1, ["3"], 160, 130, "sound-suboptimal"],
];

describe("a bounded sample of the dense corpus, production classified against the oracle (KNOWN-RED where not optimal)", () => {
  it.each(SAMPLE.map((row) => [`${row[0]} company ${row[1]} [${row[2].join(",")}]`, row] as const))("%s", (_name, row) => {
    const [boardId, companyId, fleet, optimum, demonstrated, primary] = row;
    const board = boards.get(boardId)!;
    const result = compareCase(board, companyId, fleet, phaseConsistent(fleet, board.era), { reducer: true });
    expect(result.oracle.undecided).toBeNull();
    expect(result.validity).toEqual([]);
    expect(result.oracle.total).toBe(optimum);
    expect(result.production.demonstrated).toBe(demonstrated);
    expect(result.primary).toBe(primary);
    // The oracle's witness is a set the authority itself accepts, at the oracle's price.
    expect(result.authorityOnWitness).toBe(`legal $${optimum}`);
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
      expect([summary.corpus, summary.oracleUndecided]).toEqual([summary.corpus, 0]);
      expect([summary.corpus, summary.oracleBeatenByLegalSet]).toEqual([summary.corpus, []]);
      expect([summary.corpus, summary.authorityRefusesWitness]).toEqual([summary.corpus, []]);
    }
    expect(summaries[0].invalid).toBe(0);
  }, 6 * 60 * 60 * 1000);
});
