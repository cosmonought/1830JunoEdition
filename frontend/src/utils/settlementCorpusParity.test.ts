/** @jest-environment node */
// frontend/src/utils/settlementCorpusParity.test.ts
//
// ==================================================================
//  SET-0B: CANONICAL APPRAISER vs rankPlayers, ON EVERY BOARD THE CORPUS REACHES
// ==================================================================
//
// SET-0A §13 step 1: on every board of every corpus log, `rankPlayers(state, prices = state.market_positions,
// bankrupt = state.bankrupt_president)` must equal the canonical per-player total wherever the canonical appraiser
// accepts the board, and a board it refuses is asserted as refused. `rankPlayers` is not changed here (SET-0C /
// ESCROW-4 make it a wrapper).
//
// THE CORPUS IN THIS CLONE is five logs (three frozen goldens, FCJ's 96-entry prefix, Z6C through 494); the counts are
// pinned below so a log that stops being swept fails loudly. `server/data` and the client exports are swept too WHEN
// PRESENT (the owner's machine), with parity asserted but no count pinned -- that store grows.
//
// Every corpus log is legacy (unpinned). The appraiser refuses unpinned boards (`UNPINNED_BOARD`), so for this
// measurement only each board is appraised as a pinned copy -- SET-0A did the same. Every board is appraised under
// its turn order AND under the reversed mapping, and the two must be permutations of each other.

import { existsSync, readdirSync } from "fs";
import { join } from "path";

import { appraiseSeats, SettlementAppraisalError, type SettlementSeat } from "../gameEngine/settlementAppraisal";
import { terminalStateHashV1 } from "../gameEngine/settlementDigest";
import { rankPlayers } from "../gameEngine/endgame";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { ExportedEntry } from "../gameEngine/replayLog";
import {
  EXPORT_DIR,
  FIXTURES_DIR,
  FROZEN_LOG_DIR,
  SERVER_DATA_DIR,
  readExport,
  readJsonl,
  replayBoards,
} from "./settlementGoldenBoards";
import * as GR from "./gentleRustCertificationGame";
import * as UR from "./unpredictableRevenueCertificationGame";

const seatsOf = (ids: readonly string[]): SettlementSeat[] => ids.map((player_id, seat_index) => ({ seat_index, player_id }));
const pinned = (board: GameStateResponse): GameStateResponse => ({ ...board, rules_engine_version: 10 }) as GameStateResponse;

function rankedWorth(state: GameStateResponse): Record<string, number> {
  const marks = (state.market_positions ?? {}) as Record<number, { price: number } | null>;
  const out: Record<string, number> = {};
  for (const row of rankPlayers({
    state,
    priceForCompany: (id) => marks[id]?.price ?? null,
    labelForAddress: (address) => address,
    bankruptAddress: state.bankrupt_president ?? null,
  })) {
    out[row.address] = row.netWorth;
  }
  return out;
}

/** ESCROW-1.5 §6.5's tripwire: every number on a real board is a safe integer, so `String(n)` never switches to
 *  exponent form and the canonical text is the same in every language that re-reads it. Returns the offending paths. */
function nonIntegerNumbers(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "number" && !Number.isSafeInteger(value)) out.push(`${path}=${value}`);
  else if (Array.isArray(value)) value.forEach((entry, at) => nonIntegerNumbers(entry, `${path}[${at}]`, out));
  else if (value && typeof value === "object") for (const key of Object.keys(value)) nonIntegerNumbers((value as Record<string, unknown>)[key], `${path}.${key}`, out);
  return out;
}

interface Sweep {
  boards: number;
  unhashable: string[];
  nonInteger: string[];
  mismatches: string[];
  refusals: string[];
  finalVector: string[];
  finalRound: string;
}

function sweep(entries: ExportedEntry[]): Sweep {
  const result: Sweep = { boards: 0, unhashable: [], nonInteger: [], mismatches: [], refusals: [], finalVector: [], finalRound: "" };
  replayBoards(entries, (index, board) => {
    if (board.player_addresses.length === 0) return; // the pre-deal seed board has no roster
    result.boards += 1;
    const state = pinned(board);
    const turn = board.player_addresses;
    try {
      terminalStateHashV1(state);
    } catch (error) {
      result.unhashable.push(`idx ${index}: ${(error as Error).message}`);
    }
    result.nonInteger.push(...nonIntegerNumbers(state).map((entry) => `idx ${index} ${entry}`));
    try {
      const appraised = appraiseSeats(state, seatsOf(turn));
      const reversed = appraiseSeats(state, seatsOf([...turn].reverse()));
      const ranked = rankedWorth(state);
      for (const seat of appraised) {
        if (ranked[seat.player_id] !== Number(seat.total.toString())) {
          result.mismatches.push(`idx ${index} ${seat.player_id}: rankPlayers ${ranked[seat.player_id]} vs canonical ${seat.total}`);
        }
      }
      const forward = appraised.map((seat) => seat.total.toString());
      if (reversed.map((seat) => seat.total.toString()).reverse().join() !== forward.join()) {
        result.mismatches.push(`idx ${index}: the reversed mapping is not a permutation`);
      }
      if (index === -1) {
        result.finalVector = forward;
        result.finalRound = `${board.current_round_type} ${board.macro_round_number}.${board.sub_round_index}`;
      }
    } catch (error) {
      if (!(error instanceof SettlementAppraisalError)) throw error;
      result.refusals.push(`idx ${index}: ${error.message}`);
    }
  });
  return result;
}

/* The five logs this clone carries, with the board counts SET-0A §14 recorded for the same five. */
const IN_CLONE: Array<{ name: string; entries: () => ExportedEntry[]; boards: number; finalVector: string[] }> = [
  { name: "golden/JUNO-7NZ", entries: () => readJsonl(join(FROZEN_LOG_DIR, "JUNO-7NZ.log.jsonl")), boards: 1, finalVector: ["1200", "1200"] },
  { name: "golden/JUNO-G6J", entries: () => readJsonl(join(FROZEN_LOG_DIR, "JUNO-G6J.log.jsonl")), boards: 10, finalVector: ["1230", "1205"] },
  { name: "golden/JUNO-CV4", entries: () => readJsonl(join(FROZEN_LOG_DIR, "JUNO-CV4.log.jsonl")), boards: 143, finalVector: ["1858", "1791"] },
  { name: "prefix/JUNO-FCJ-96", entries: () => readJsonl(join(FIXTURES_DIR, "JUNO-FCJ-prefix96.log.jsonl")), boards: 93, finalVector: ["1380", "1295"] },
  { name: "fixture/JUNO-Z6C-494", entries: () => readExport(join(__dirname, "__fixtures__z6cLog.json")), boards: 492, finalVector: ["2862", "2106", "1933"] },
];

describe("the corpus in this clone: canonical appraiser == rankPlayers on every board", () => {
  const results: Record<string, Sweep> = {};
  beforeAll(() => {
    for (const log of IN_CLONE) results[log.name] = sweep(log.entries());
  });
  for (const log of IN_CLONE) {
    it(`${log.name}: ${log.boards} boards, 0 mismatches, 0 refusals, every board hashable, final vector ${log.finalVector.join("/")}`, () => {
      const result = results[log.name];
      expect(result.mismatches).toEqual([]);
      expect(result.refusals).toEqual([]);
      expect(result.unhashable).toEqual([]);
      expect(result.nonInteger).toEqual([]);
      expect(result.boards).toBe(log.boards);
      expect(result.finalVector).toEqual(log.finalVector);
    });
  }

  it("739 boards in all -- the SET-0A §14 count for these five logs", () => {
    const total = IN_CLONE.reduce((sum, log) => sum + results[log.name].boards, 0);
    expect(total).toBe(739);
  });
});

/* The owner's store and client exports: swept for parity whenever they are present. Not present in an isolated
   cloud clone (untracked), so this block may run zero cases -- which the report must say, not hide. */
const external: Array<{ name: string; entries: ExportedEntry[] }> = [];
if (existsSync(SERVER_DATA_DIR)) {
  for (const file of readdirSync(SERVER_DATA_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) {
    external.push({ name: `server/${file}`, entries: readJsonl(join(SERVER_DATA_DIR, file)) });
  }
}
if (existsSync(EXPORT_DIR)) {
  for (const file of readdirSync(EXPORT_DIR).filter((f) => /^sandbox-log-JUNO-.*\.json$/.test(f)).sort()) {
    external.push({ name: `export/${file}`, entries: readExport(join(EXPORT_DIR, file)) });
  }
}

describe("server/data and client exports (present only on the owner's machine)", () => {
  if (external.length === 0) {
    // Reported as SKIPPED rather than passed: an isolated clone has no untracked store, and a vacuous pass would hide it.
    it.skip("no server/data logs or client exports in this checkout -- rerun on the owner's machine", () => undefined);
  }
  for (const log of external) {
    it(`${log.name}: canonical appraiser == rankPlayers on every board, every board hashable`, () => {
      const result = sweep(log.entries);
      expect(result.mismatches).toEqual([]);
      /* A refusal on a real store board is a finding for the report (SET-0A expected none), not something to paper
         over here. */
      expect(result.refusals).toEqual([]);
      expect(result.unhashable).toEqual([]);
      expect(result.nonInteger).toEqual([]);
    });
  }
});

describe("certification boards (reducer-driven, appraised at the certified v10 pin)", () => {
  /* DA-8: these games are dealt at the CURRENT engine (v11); settlement was certified for v10 only, so each board is
     appraised at the certified pin -- the same board, the same appraiser (the owner's two-axis ruling). */
  const turnVector = (board: GameStateResponse) =>
    appraiseSeats(pinned(board), seatsOf(board.player_addresses)).map((seat) => seat.total.toString());
  const parity = (board: GameStateResponse) => {
    const ranked = rankedWorth(board);
    for (const seat of appraiseSeats(pinned(board), seatsOf(board.player_addresses))) {
      expect(ranked[seat.player_id]).toBe(Number(seat.total.toString()));
    }
  };

  it("GR-4 start (OR 3.1, phase 3): parity, [2408, 1988, 2404]", () => {
    const board = GR.certificationStart();
    expect(turnVector(board)).toEqual(["2408", "1988", "2404"]);
    parity(board);
  });

  it("GR-4 final: REFUSED PARRED_WITHOUT_MARK: NYC -- the known harness board (SET-0A F-6) rankPlayers scores NYC at $0", () => {
    const board = GR.runCertificationGame().room.state;
    expect(() => appraiseSeats(pinned(board), seatsOf(board.player_addresses))).toThrow("PARRED_WITHOUT_MARK: NYC");
    // rankPlayers silently values NYC's 50/30/20 at $0 -- the D4 divergence SET-0C removes. Pinned, not fixed here.
    const nyc = board.public_companies.find((c) => c.ticker === "NYC")!;
    expect(nyc.par_value).not.toBeNull();
    expect((board.market_positions as Record<number, unknown>)[nyc.company_id] ?? null).toBeNull();
  });

  it("UR-7 tail A at SR 7: parity, [1748, 1708, 2644]", () => {
    const board = UR.playCertificationGame({ tail: "A", stop: UR.atStockRound(7) }).room.state;
    expect(turnVector(board)).toEqual(["1748", "1708", "2644"]);
    parity(board);
  });

  it("UR-7 tail B at SR 7: parity, [1698, 1658, 2494]", () => {
    const board = UR.playCertificationGame({ tail: "B", stop: UR.atStockRound(7) }).room.state;
    expect(turnVector(board)).toEqual(["1698", "1658", "2494"]);
    parity(board);
  });

  it("UR start with Unpredictable Revenue off: parity, [2476, 2488, 2226]", () => {
    const board = UR.certificationStart({ unpredictableRevenue: false });
    expect(turnVector(board)).toEqual(["2476", "2488", "2226"]);
    parity(board);
  });
});
