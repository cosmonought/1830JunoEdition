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
import { fixtureBoard } from "./harness/knownDefects";
import { LPF_BOARD } from "../components/hexBoardDataLpf";

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

/** [board, corporation, fleet, oracle optimum, production's demonstration, production class, every flag, the best set
 *  under PRODUCTION's data].
 *
 *  R12-1 CLOSURE (owner data, 2026-09-29): #62 pays $80 per city; on the 1830+ map Montreal pays $40 / $60 and
 *  Norfolk $30 / $50, and each has TWO station circles. Production has #62 at $90, Montreal and Norfolk flat
 *  ($40, $20) and each at one circle -- recorded production data defects (R12-2). (No sample board has a
 *  Montreal token; the Montreal case is the separate fixture below.) The last column is the
 *  oracle's law run on production's data: where the two differ, the case carries `production-data-defect`, and
 *  stranding / shortfall are judged against the production-data set (which the authority must accept). On the Z6C
 *  boards N&W's home fills production's one Norfolk circle, so production shuts Norfolk to everyone else; the law
 *  keeps it open, which is most of the Z6C optima's rise. */
const SAMPLE: ReadonlyArray<readonly [string, number, readonly string[], number, number, string, readonly string[], number]> = [
  // Standard 1830, Brown: ordinary positions, a PRR bow case, two Diesels.
  ["Y8V@651", 5, ["3"], 170, 150, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"], 180],
  ["Y8V@651", 2, ["3"], 180, 190, "production-data-defect", ["production-data-defect", "sound-optimal"], 190], // $190 = the law's $180 + #62's extra $10
  ["Y8V@651", 1, ["4", "6"], 470, 460, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"], 490], // the preflight's $500 used a bare-token bow run (IL-7)
  ["Y8V@651", 6, ["D"], 780, 680, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"], 800],
  ["Y8V@651", 8, ["6", "D"], 840, 730, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"], 860],
  // Level Playing Field, Gray: the herald join and the Coal River endpoint strand PRR / C&O (the production-data
  // optima $660 < $710 and $720 < $730 are the preflight's pairs); B&O and N&W are licensed.
  ["Z6C@494", 1, ["D"], 820, 710, "route-phase-stranding", ["emits-illegal-optimum", "route-phase-stranding", "production-data-defect"], 660],
  ["Z6C@494", 1, ["6"], 290, 260, "emits-illegal-optimum", ["emits-illegal-optimum"], 300],
  ["Z6C@494", 5, ["6", "D"], 870, 730, "route-phase-stranding", ["emits-illegal-optimum", "route-phase-stranding", "production-data-defect"], 720],
  ["Z6C@494", 4, ["D"], 870, 780, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"], 780], // short only through Norfolk's circles
  ["Z6C@494", 10, ["D"], 870, 850, "production-data-defect", ["production-data-defect", "sound-optimal"], 850], // N&W's licence (393) opens Coal River to it
  ["Z6C@608", 2, ["6", "D"], 990, 790, "emits-illegal-optimum", ["emits-illegal-optimum", "production-data-defect"], 820],
  ["Z6C@608", 10, ["3", "4", "4"], 530, 510, "sound-suboptimal", ["production-data-defect", "sound-suboptimal"], 510], // the preflight's "unsound" row: N&W is licensed
  ["Z6C@608", 1, ["3"], 160, 130, "sound-suboptimal", ["sound-suboptimal"], 160],
];

describe("a bounded sample of the dense corpus, production classified against the oracle (KNOWN-RED where not optimal)", () => {
  it.each(SAMPLE.map((row) => [`${row[0]} company ${row[1]} [${row[2].join(",")}]`, row] as const))("%s", (_name, row) => {
    const [boardId, companyId, fleet, optimum, demonstrated, primary, flags, productionData] = row;
    const board = boards.get(boardId)!;
    const result = compareCase(board, companyId, fleet, phaseConsistent(fleet, board.era), { reducer: true });
    expect(result.oracle.undecided).toBeNull();
    expect(result.validity).toEqual([]);
    expect(result.oracle.total).toBe(optimum);
    expect(result.production.demonstrated).toBe(demonstrated);
    expect(result.primary).toBe(primary);
    expect(result.flags).toEqual([...flags]);
    expect(result.productionDataOptimum).toBe(productionData);
    // The authority accepts the best set under production's data, at exactly its price ...
    expect(result.authorityOnProductionDataWitness).toBe(`legal $${productionData}`);
    // ... and the law's witness at the oracle's price plus exactly the recorded premium -- unless production's one
    // circle at Montreal / Norfolk shuts it out, which is then the ONLY reason given.
    if (result.witnessRefusedByCircles) expect(result.authorityOnWitness).toMatch(/^REFUSED: Route \d+: (A19|L16) is tokened out by other corporations/);
    else expect(result.authorityOnWitness).toBe(`legal $${optimum + result.witnessDataPremium}`);
  }, 120_000);
});

describe("Montreal's one production circle is recognised as the data defect, and only that (the Montreal correction)", () => {
  it("one CPR token at Montreal: the law runs ERIE through it ($80); production shuts it; the authority accepts the production-data set", () => {
    // The Montreal law fixture (routeOracleLaw.test.ts) as a corpus board: Ottawa B16 #57 turned 1 (ERIE), the B20
    // town #55 turned 1, CPR in one of Montreal's two circles; a 4-train, before the first 5-train.
    const board = fixtureBoard("MONTREAL-CIRCLES", LPF_BOARD, { expandedMap: true, plusTiles: true, levelPlayingField: true }, "Yellow", [["B16", 57, 1], ["B20", 55, 1]], [
      { companyId: 6, tokens: [["B16", 0]] },
      { companyId: 3, tokens: [["A19", 0]] },
    ]);
    const result = compareCase(board, 6, ["4"], true, { reducer: true });
    expect(result.validity).toEqual([]);
    expect(result.oracle.total).toBe(80); // town B20 - Montreal - Ottawa - Kingston
    expect(result.productionDataOptimum).toBe(70); // Montreal shut by one circle: Montreal - Ottawa - Kingston
    expect(result.witnessRefusedByCircles).toBe(true);
    expect(result.authorityOnWitness).toMatch(/^REFUSED: Route 1: A19 is tokened out by other corporations/);
    expect(result.authorityOnProductionDataWitness).toBe("legal $70");
    expect(result.flags).toContain("production-data-defect");
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
      expect([summary.corpus, summary.authorityRefusesProductionDataWitness]).toEqual([summary.corpus, []]);
    }
    expect(summaries[0].invalid).toBe(0);
  }, 6 * 60 * 60 * 1000);
});
