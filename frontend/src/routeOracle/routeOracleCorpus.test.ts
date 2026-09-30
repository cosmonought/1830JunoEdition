/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1: PRODUCTION AGAINST THE ORACLE ON REAL BOARDS
// ==================================================================
//
// BY DEFAULT: a bounded, representative sample of the dense-board corpus (standard late game, LPF late game,
// PRR herald cases, Diesel cases, the Coal River stranding cases), every case run through the reducer as well,
// with each case's production class PINNED as it stands today.
//
// ROUTE v12 R12-2 moved the pins deliberately: no sample case emits an illegal set or strands any more (the herald
// join, the Coal River end), Montreal / Norfolk are repaired, and what remains is (a) "sound-suboptimal" -- the
// search is still a bounded heuristic whose figure is a LOWER BOUND (S6-3), every demonstrated set legal and applied
// -- and nothing else: #62's catalog $90 (R12-2's one data difference) was corrected to the owner-ruled $80 in v12
// (R12-3), so no sample case carries `production-data-defect` and production's data optimum is the oracle's.
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
 *  THE DATA (R12-1 closure; R12-2; R12-3): on the 1830+ map Montreal pays $40 / $60 and Norfolk $30 / $50, each ONE
 *  city with TWO circles -- production agrees since R12-2. #62 pays $80 per city, and production agrees since the
 *  owner's final ruling was folded into v12 (R12-3; it had been $90, conflated with the 1830+ NY tile #883), so the
 *  last column equals the oracle's optimum everywhere. Before R12-2 (the R12-1 pins, kept in the comments): Z6C@494
 *  PRR [D] and C&O [6,D] stranded (the herald join, Coal River), PRR [6] and NYC@608 [6,D] emitted illegal Coal
 *  River sets, and N&W's home filled production's one Norfolk circle. The R12-2 figures (#62 at $90) are kept in
 *  the comments too. */
const SAMPLE: ReadonlyArray<readonly [string, number, readonly string[], number, number, string, readonly string[], number]> = [
  // Standard 1830, Brown: ordinary positions, a PRR bow case, two Diesels. (R12-2, #62 at $90: 150, 190, 460, 740, 810.)
  ["Y8V@651", 5, ["3"], 170, 150, "sound-suboptimal", ["sound-suboptimal"], 170],
  ["Y8V@651", 2, ["3"], 180, 160, "sound-suboptimal", ["sound-suboptimal"], 180],
  ["Y8V@651", 1, ["4", "6"], 470, 450, "sound-suboptimal", ["sound-suboptimal"], 470], // the preflight's $500 used a bare-token bow run (IL-7, now refused)
  ["Y8V@651", 6, ["D"], 780, 730, "sound-suboptimal", ["sound-suboptimal"], 780], // R12-1: 680 (re-entry and the red-area join widen the search)
  ["Y8V@651", 8, ["6", "D"], 840, 790, "sound-suboptimal", ["sound-suboptimal"], 840], // R12-1: 730
  // Level Playing Field, Gray. R12-1: PRR [D] 710 stranding (the H12 join; production-data optimum 660), PRR [6] 260
  // illegal (Coal River), C&O [6,D] 730 stranding (720), B&O [D] 780 short only through Norfolk's one circle, N&W [D] 850.
  // R12-2 (#62 at $90): 840, 250, 860, 880, 880.
  ["Z6C@494", 1, ["D"], 820, 820, "sound-optimal", ["sound-optimal"], 820],
  ["Z6C@494", 1, ["6"], 290, 250, "sound-suboptimal", ["sound-suboptimal"], 290],
  ["Z6C@494", 5, ["6", "D"], 870, 840, "sound-suboptimal", ["sound-suboptimal"], 870],
  ["Z6C@494", 4, ["D"], 870, 870, "sound-optimal", ["sound-optimal"], 870], // Norfolk's second circle is open now
  ["Z6C@494", 10, ["D"], 870, 870, "sound-optimal", ["sound-optimal"], 870], // N&W's licence (393) opens Coal River to it
  // R12-1: NYC [6,D] 790 illegal (Coal River), N&W [3,4,4] 510 short only through Norfolk's flat $20. R12-2: 860, 540.
  ["Z6C@608", 2, ["6", "D"], 990, 850, "sound-suboptimal", ["sound-suboptimal"], 990],
  ["Z6C@608", 10, ["3", "4", "4"], 530, 530, "sound-optimal", ["sound-optimal"], 530], // the preflight's "unsound" row: N&W is licensed
  ["Z6C@608", 1, ["3"], 160, 130, "sound-suboptimal", ["sound-suboptimal"], 160],
];

describe("a bounded sample of the dense corpus, production classified against the oracle (R12-2: no illegal set, no stranding)", () => {
  it.each(SAMPLE.map((row) => [`${row[0]} company ${row[1]} [${row[2].join(",")}]`, row] as const))("%s", (_name, row) => {
    const [boardId, companyId, fleet, optimum, demonstrated, primary, flags, productionData] = row;
    const board = boards.get(boardId)!;
    const result = compareCase(board, companyId, fleet, phaseConsistent(fleet, board.era), { reducer: true });
    // R12-2: production's own set is accepted by the authority AND applied by the reducer, in every sample case.
    expect(result.authorityOnProductionSet).toBe(`legal $${demonstrated}`);
    expect(result.reducer?.appliesProductionSet).toBe(true);
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

describe("Montreal's two circles (the Montreal correction; R12-1 KNOWN-RED, repaired by R12-2)", () => {
  it("one CPR token at Montreal: the law runs ERIE through it ($80), and so does production now", () => {
    // The Montreal law fixture (routeOracleLaw.test.ts) as a corpus board: Ottawa B16 #57 turned 1 (ERIE), the B20
    // town #55 turned 1, CPR in one of Montreal's two circles; a 4-train, before the first 5-train.
    const board = fixtureBoard("MONTREAL-CIRCLES", LPF_BOARD, { expandedMap: true, plusTiles: true, levelPlayingField: true }, "Yellow", [["B16", 57, 1], ["B20", 55, 1]], [
      { companyId: 6, tokens: [["B16", 0]] },
      { companyId: 3, tokens: [["A19", 0]] },
    ]);
    const result = compareCase(board, 6, ["4"], true, { reducer: true });
    expect(result.validity).toEqual([]);
    expect(result.oracle.total).toBe(80); // town B20 - Montreal - Ottawa - Kingston
    // R12-1 pinned production at $70 (Montreal shut by its one circle) and the witness refused "A19 is tokened out".
    expect(result.productionDataOptimum).toBe(80);
    expect(result.witnessRefusedByCircles).toBe(false);
    expect(result.authorityOnWitness).toBe("legal $80");
    expect(result.production.demonstrated).toBe(80);
    expect(result.authorityOnProductionSet).toBe("legal $80");
    expect(result.flags).toEqual(["sound-optimal"]);
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
