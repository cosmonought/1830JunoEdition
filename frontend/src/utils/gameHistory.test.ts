/** @jest-environment node */
// frontend/src/utils/gameHistory.test.ts -- design note #1411.
import { readFileSync } from "fs";
import { join } from "path";

import { gameHistoryFrom, roundLabelOf as roundLabelOfState } from "./gameHistory";
import { readStripped } from "./sourceScan";
import { activateBoard, STANDARD_BOARD } from "../components/hexBoardData";
import { replayLog, entriesFromExport, type ExportedEntry } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { stateDigest } from "../gameEngine/stateDigest";
import { homeTokenBlock } from "../gameEngine/homeTokenGate";
import type { GameStateResponse } from "../gameEngine/gameState";
import FIXTURE from "./__fixtures__z6cLog.json";

/* ==================================================================
    BATCH 7.5: THE COMPLETED GAME THESE TESTS READ IS JUNO-CV4, NOT JUNO-Z6C
   ==================================================================
   These cases were written against JUNO-Z6C's own log through OR 9.3 -- the room the epilogue was asked for.
   Under rules engine version 5 that log no longer derives a completed game: Batch 7.3's C5 correction starts a
   cascade that leaves the board frozen at index 33 behind the authoritative home-token hold, and its timeline is
   `[SR 1, Final]` (pinned, with every step of the cause, in the characterization at the end of this file). That
   is an expected historical-log incompatibility, not a gameplay failure, and the stored log is not rewritten.
   So the completed-game behaviour moves to the frozen golden copy of JUNO-CV4 (committed beside the golden
   master): fourteen samples, seven Operating Rounds, dividends, fleets and every core accolade, and Batch 7 changes
   nothing about it but the Bank's balance. Z6C-only coverage (the Yellow Sign's Mark, rust) is recorded as a
   fixture task in the ledger (S10-21), not asserted against a frozen board.
   SLICE 8.2 (#1614a): JUNO-CV4 is a legacy log whose home placements sit in Stock Rounds, so every CV4 case below
   names `DEVELOPMENT_CORPUS_POLICY` at its call. The epilogue's default -- the shell's call, no adapter -- stops at
   B&O's first operating turn (`[SR 1, OR 1.1, Final]`). Measured: under the development corpus's policy the CV4
   history (every sample, tally, accolade and autopsy row) is identical to the pre-8.2 epilogue's. */
const CV4_GOLDEN = join(__dirname, "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl");
const LOG = readFileSync(CV4_GOLDEN, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line)) as ReadonlyArray<{ index: number; id: string; actor: string; payload: string; at: number }>;
const Z6C_LOG = FIXTURE.entries as ReadonlyArray<{ index: number; id: string; actor: string; payload: string; at: number }>;

describe("the log replayed as a timeline (design note #1411)", () => {
  afterAll(() => activateBoard(STANDARD_BOARD));

  it("samples once per round boundary, in order, and ends on Final", () => {
    const history = gameHistoryFrom(LOG as never, DEVELOPMENT_CORPUS_POLICY);
    expect(history.rounds.length).toBeGreaterThan(2);
    expect(history.rounds[history.rounds.length - 1].label).toBe("Final");
    const labels = history.rounds.map((r) => r.label);
    expect(labels[0]).toBe("SR 1");
    /* Batch 7.5: on JUNO-CV4 the whole timeline is pinned, because the golden log is frozen and replays to the
       same rounds under versions 4 and 5 -- including a two-OR set (OR 5.1 / OR 5.2) and the phase-3 sets after it.
       (Batch 6's relaxation of the Z6C timeline to "OR 5.1 and more than ten ORs" is superseded by the move.) */
    expect(labels).toEqual([
      "SR 1", "OR 1.1", "SR 2", "OR 2.1", "SR 3", "OR 3.1", "SR 4", "OR 4.1",
      "SR 5", "OR 5.1", "OR 5.2", "SR 6", "OR 6.1", "Final",
    ]);
    expect(labels.filter((label) => label.startsWith("OR ")).length).toBe(7);
    // No two consecutive samples share a label -- a boundary is a change.
    for (let i = 1; i < labels.length; i += 1) expect(labels[i]).not.toBe(labels[i - 1]);
  });

  it("carries every player and every corporation on every sample", () => {
    const history = gameHistoryFrom(LOG as never, DEVELOPMENT_CORPUS_POLICY);
    for (const round of history.rounds) {
      expect(round.players.map((p) => p.address)).toEqual(history.players);
      expect(round.corporations.map((c) => c.companyId)).toEqual(history.corporations.map((c) => c.companyId));
    }
  });

  it("prices come off the chart and net worth is cash plus stock", () => {
    const history = gameHistoryFrom(LOG as never, DEVELOPMENT_CORPUS_POLICY);
    const final = history.rounds[history.rounds.length - 1];
    expect(final.corporations.some((c) => c.price !== null)).toBe(true);
    for (const p of final.players) {
      if (p.cash !== null && p.stockValue !== null && p.netWorth !== null) {
        expect(p.netWorth).toBeGreaterThanOrEqual(p.cash + p.stockValue);
      }
    }
  });

  it("an empty log yields no rounds rather than throwing", () => {
    const empty = gameHistoryFrom([]);
    expect(empty.rounds).toEqual([]);
    expect(empty.autopsy).toEqual([]);
    expect(empty.accolades.every((a) => a.holder === null)).toBe(true);
  });
});

/* ==================================================================
    DESIGN NOTE 1414 (harness): THE TALLIES ARE DIFFS
   ================================================================== */
describe("the accolades and the autopsy, read off the board's diffs (design note #1414)", () => {
  const history = gameHistoryFrom(LOG as never, DEVELOPMENT_CORPUS_POLICY);

  it("names a Robber Baron, a Master of the Line, a Track Boss and a Market Manipulator on a played game", () => {
    const by = Object.fromEntries(history.accolades.map((a) => [a.key, a]));
    for (const key of ["robber-baron", "master-of-the-line", "track-boss", "market-manipulator"]) {
      expect(history.players).toContain(by[key].holder);
      expect(by[key].detail.length).toBeGreaterThan(0);
    }
    expect(by["master-of-the-line"].detail).toMatch(/^\$\d[\d,]* on [A-Z&]+'s \w+-train \(OR \d+\.\d+\)$/);
  });

  it("gives every accolade a holder from the roster, or none", () => {
    for (const a of history.accolades) {
      if (a.holder !== null) expect(history.players).toContain(a.holder);
      else expect(a.detail).toBe("");
    }
  });

  it("the autopsy covers exactly the floated corporations, with lifetime revenue at least the last run's", () => {
    const final = history.rounds[history.rounds.length - 1];
    const floated = final.corporations.filter((c) => c.floated).map((c) => c.companyId);
    expect(history.autopsy.map((c) => c.companyId).sort()).toEqual([...floated].sort());
    for (const corp of history.autopsy) {
      const last = final.corporations.find((c) => c.companyId === corp.companyId)!;
      expect(corp.lifetimeRevenue).toBeGreaterThanOrEqual(last.revenue);
      expect(corp.floatRound).not.toBeNull();
      expect(corp.treasury).toBe(last.treasury);
      expect(corp.fleet).toEqual(last.trains);
    }
  });

  it("a player's equity by corporation sums to their stock value", () => {
    for (const round of history.rounds) {
      for (const p of round.players) {
        expect(p.equity.reduce((sum, [, v]) => sum + v, 0)).toBe(p.stockValue);
      }
    }
  });

  it("samples carry the phase, and it never goes backwards", () => {
    const order = ["2", "3", "4", "5", "6", "7", "D"];
    let at = -1;
    for (const round of history.rounds) {
      if (round.phase === null) continue;
      const here = order.indexOf(round.phase);
      expect(here).toBeGreaterThanOrEqual(at);
      at = here;
    }
  });
});

describe("the fleet ledger behind a click (design note #1431)", () => {
  it("every corporation carries a payback and a ledger whose rows add up to its train spend", () => {
    const history = gameHistoryFrom(LOG as never, DEVELOPMENT_CORPUS_POLICY);
    for (const corp of history.autopsy) {
      expect(typeof corp.payback).toBe("number");
      for (const row of corp.fleetLedger) {
        const fates = Object.values(row.fates).reduce((a, b) => a + b, 0);
        expect(fates).toBe(row.count);
        expect(row.paid).toBeGreaterThanOrEqual(0);
        expect(row.earned).toBeGreaterThanOrEqual(0);
      }
      const paid = corp.fleetLedger.reduce((a, r) => a + r.paid, 0);
      const earned = corp.fleetLedger.reduce((a, r) => a + r.earned, 0);
      expect(corp.payback).toBe(earned - paid);
    }
    expect(history.autopsy.some((c) => c.fleetLedger.length > 0)).toBe(true);
  });

  it("the autopsy table opens a ledger on click", () => {
    const src = readStripped("components/EpilogueCharts.tsx");
    expect(src).toContain("autopsy-ledger-");
    expect(src).toContain("aria-expanded={isOpen}");
    expect(src).toContain("ROI"); // #1436: the Payback column went; the ledger's Net is ROI
  });
});

describe("dividends per player per round (design note #1434)", () => {
  it("each OR sample carries what each player was paid in it, and the rounds add up to the Robber Baron's figure", () => {
    const history = gameHistoryFrom(LOG as never, DEVELOPMENT_CORPUS_POLICY);
    const ors = history.rounds.filter((r) => r.label.startsWith("OR "));
    for (const address of history.players) {
      const sum = ors.reduce((a, r) => a + (r.players.find((p) => p.address === address)?.dividends ?? 0), 0);
      const baron = history.accolades.find((a) => a.key === "robber-baron")!;
      if (baron.holder === address) expect(sum).toBe(baron.value);
    }
    // Somebody was paid something in some round.
    expect(ors.some((r) => r.players.some((p) => p.dividends > 0))).toBe(true);
    // Stock Rounds pay nothing.
    for (const r of history.rounds.filter((r) => r.label.startsWith("SR "))) {
      for (const p of r.players) expect(p.dividends).toBe(0);
    }
  });
});

/* ==================================================================
    BATCH 7.5 CHARACTERIZATION: JUNO-Z6C NO LONGER REACHES A COMPLETED GAME UNDER VERSION 5
   ==================================================================
   An expected historical-log incompatibility under rules engine version 5, pinned so it stays visible and is
   never "fixed" by weakening the rule that causes it:
     9 / 12  WaterfallPass (Batch 7.3, C5 / S7-2 / D-21): the all-pass markdown is the Schuylkill Valley's alone.
             The SV is already sold and the B&O ($220) is the private on offer, so it is NOT marked down (the
             version-4 engine marked it to $215, then $210).
     14      p-lzjh2r6u buys the B&O at $220, $10 more than the table paid.
     31      he then holds $95 and cannot pay $100 for his B&O share: refused, and B&O does not float.
     32      his stored home placement arrives while B&O is unfloated -- no longer timely -- and places nothing.
     33      p-je0gw2v0's B&O share floats it, one entry later than the table did.
     34+     the authoritative home-token hold owes B&O's home station, which no later entry in the log places, so
             every remaining stored entry is a reducer no-op and the log-derived timeline is `[SR 1, Final]`.
   The stored log is not rewritten, and the completed-game tests above read JUNO-CV4 instead.

   SLICE 8.2 RE-PIN (S8-5; design notes #1610 / #1614; predicted by the Stage-8 design's corpus table). THE FREEZE
   AT 34 WAS THE FLOAT-TIME HOLD, AND THAT HOLD IS RETIRED. 9 / 12 / 14 / 31 / 32 / 33 are unchanged. What changed:
     33      the float purchase no longer holds the buyer's seat (#769 retired). The first difference from the
             pre-8.2 replay is the board after 33 (`active_player_index`, `consecutive_passes`, `bought_this_turn`,
             `bought_this_turn_company`, `turn_action_taken`); the first difference in what is accepted is 34, a
             `PassTurn` the old hold refused.
     34+     a Stock Round owes no home station, so SR 1 goes on.
     40      B&O's first operating turn opens after 40. Under the development corpus's policy the choice recorded at
             32 (I15) -- refused there as untimely, and remembered -- is tried at that turn through the reducer and
             lands; NNH's (37), C&O's (56), NYC's (256) and PMQ's (343, Detroit/Windsor circle 1) follow at their own
             first turns, and the log runs on to OR 10.1 on the Batch-7-corrected board. Without the adapter -- the
             epilogue's default, which is the shell's call -- nothing in the stored log places B&O's home at its turn,
             and the log-derived timeline stops there, behind the authoritative home hold: `[SR 1, OR 1.1, Final]`.
   The continuation is still not the table's game (31 is still refused, and many later entries are refused on the
   corrected board), so the completed-game tests keep reading JUNO-CV4. Measured for the Slice-8.2 write-up: at
   every stored entry this replay equals the pre-8.2 engine's with each home placed at its float from the same
   recorded choice, station tokens aside. The stored log is not rewritten. */
describe("JUNO-Z6C under rules engine version 5: an expected historical-log incompatibility (Batch 7.5; re-pinned by Slice 8.2)", () => {
  afterAll(() => activateBoard(STANDARD_BOARD));

  const BO_PRIVATE = 6;
  const BO = 4;
  const BUYER = "p-lzjh2r6u";
  const seedZ6C = () => ({
    state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
    waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
  });
  const bo = (state: GameStateResponse) => state.public_companies.find((entry) => entry.company_id === BO)!;
  /** The development-corpus replay, once: the board handed to every STORED entry by index, and to every synthetic
   *  home entry (#1614) in order -- a synthetic entry shares its index with the stored entry it follows. */
  let replayed: { result: ReturnType<typeof replayLog>; before: Record<number, GameStateResponse>; synthetic: Array<{ index: number; state: GameStateResponse }> } | null = null;
  const z6c = () => {
    if (replayed !== null) return replayed;
    const before: Record<number, GameStateResponse> = {};
    const synthetic: Array<{ index: number; state: GameStateResponse }> = [];
    const result = replayLog(
      entriesFromExport(Z6C_LOG as unknown as ExportedEntry[]),
      sandboxReplayProviders(),
      seedZ6C(),
      ({ entry, stateBefore }) => {
        if (entry.id.includes(":legacy-")) synthetic.push({ index: entry.index, state: stateBefore });
        else before[entry.index] = stateBefore;
      },
      DEVELOPMENT_CORPUS_POLICY,
    );
    replayed = { result, before, synthetic };
    return replayed;
  };

  it("the auction correction at 9 still leaves B&O unfloated at 31, its placement at 32 still places nothing, and 33 floats it", () => {
    const { before } = z6c();
    const offered = (state: GameStateResponse) =>
      (state as GameStateResponse & { waterfall?: { privates: Array<{ private_id: number; face_value: string; is_lowest_offered: boolean }> } })
        .waterfall?.privates.find((entry) => entry.is_lowest_offered);
    const cash = (state: GameStateResponse, player: string) => Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);

    // 9 / 12: the SV is sold, the B&O is on offer, and neither all-pass marks it down.
    expect(before[9].private_companies.find((entry) => entry.private_id === 1)?.owner).not.toBeNull();
    for (const index of [9, 12, 14]) {
      expect(offered(before[index])?.private_id).toBe(BO_PRIVATE);
      expect(offered(before[index])?.face_value).toBe("220");
    }
    // 14: the buyer pays the unmarked $220.
    expect(cash(before[14], BUYER) - cash(before[15], BUYER)).toBe(220);
    expect(before[15].private_companies.find((entry) => entry.private_id === BO_PRIVATE)?.owner).toBe(BUYER);
    // 31: $95 against a $100 share -- refused, B&O unfloated.
    expect(cash(before[31], BUYER)).toBe(95);
    expect(bo(before[31]).is_floated).toBe(false);
    expect(stateDigest(before[32])).toBe(stateDigest(before[31]));
    // 32: the stored home placement finds B&O unfloated and places nothing.
    expect(bo(before[33]).is_floated).toBe(false);
    expect(stateDigest(before[33])).toBe(stateDigest(before[32]));
    // 33: B&O floats on the other player's share.
    expect(bo(before[34]).is_floated).toBe(true);
  });

  it("Slice 8.2: the float holds nothing, B&O's recorded choice lands at its first operating turn, and the log no longer freezes", () => {
    const { result, before, synthetic } = z6c();
    const table = sandboxReplayProviders().chartInjections(before[34]).homeHexToAxial!;
    // 34: a Stock Round owes no home station -- no hold, and the pass moves the board. (Pre-8.2: the float-time hold.)
    expect(before[34].current_round_type).toBe("StockRound");
    expect(homeTokenBlock({ state: before[34], homeHexToAxial: table })).toBeNull();
    expect(stateDigest(before[35])).not.toBe(stateDigest(before[34]));
    // Floated at 33, and no token on the board through the rest of SR 1 (#1610: nothing is placed at the float).
    expect(bo(before[40]).station_token_hexes).toEqual([]);
    // After 40, B&O's first operating turn: its home is owed, and the choice recorded at 32 is the one tried there.
    expect(synthetic[0].index).toBe(40);
    expect(roundLabelOfState(synthetic[0].state)).toBe("OR 1.1");
    expect(homeTokenBlock({ state: synthetic[0].state, homeHexToAxial: table })).toBe(
      "B&O is starting its first operating turn and its home station is not on the board yet. p-lzjh2r6u must place it on I15 before B&O can operate.",
    );
    expect(bo(before[41]).station_token_hexes).toEqual([[3, 8]]);
    expect(result.legacyHomeStations).toEqual([
      { recordedAt: 32, afterIndex: 40, companyId: BO, q: 3, r: 8, cityIndex: null, applied: true },
      { recordedAt: 37, afterIndex: 47, companyId: 7, q: 6, r: 6, cityIndex: 0, applied: true }, // NNH, New York's first circle
      { recordedAt: 56, afterIndex: 59, companyId: 5, q: 0, r: 5, cityIndex: null, applied: true }, // C&O, Cleveland
      { recordedAt: 256, afterIndex: 285, companyId: 2, q: 7, r: 4, cityIndex: 0, applied: true }, // NYC, E19
      { recordedAt: 343, afterIndex: 362, companyId: 9, q: 0, r: 4, cityIndex: 1, applied: true }, // PMQ, Detroit/Windsor circle 1
    ]);
    // The log-derived timeline under the development corpus's policy: the game runs on to OR 10.1.
    expect(gameHistoryFrom(Z6C_LOG as never, DEVELOPMENT_CORPUS_POLICY).rounds.map((round) => round.label)).toEqual([
      "SR 1", "OR 1.1", "SR 2", "OR 2.1", "SR 3", "OR 3.1", "SR 4", "OR 4.1", "SR 5", "OR 5.1", "OR 5.2",
      "SR 6", "OR 6.1", "OR 6.2", "SR 7", "OR 7.1", "OR 7.2", "SR 8", "OR 8.1", "OR 8.2",
      "SR 9", "OR 9.1", "OR 9.2", "SR 10", "OR 10.1", "Final",
    ]);
  });

  it("Slice 8.2: without the development corpus's adapter -- the epilogue's default -- the log stops at B&O's first operating turn", () => {
    expect(gameHistoryFrom(Z6C_LOG as never).rounds.map((round) => round.label)).toEqual(["SR 1", "OR 1.1", "Final"]);
    const held = replayLog(
      entriesFromExport(Z6C_LOG as unknown as ExportedEntry[]),
      sandboxReplayProviders(),
      seedZ6C(),
      undefined,
      { ...DEVELOPMENT_CORPUS_POLICY, legacyHomeTokens: "refuse" },
    );
    expect(held.legacyHomeStations).toEqual([]);
    expect(roundLabelOfState(held.state)).toBe("OR 1.1");
    expect(bo(held.state).station_token_hexes).toEqual([]);
    expect(homeTokenBlock({ state: held.state, homeHexToAxial: sandboxReplayProviders().chartInjections(held.state).homeHexToAxial! })).toBe(
      "B&O is starting its first operating turn and its home station is not on the board yet. p-lzjh2r6u must place it on I15 before B&O can operate.",
    );
  });
});
