// frontend/src/utils/settlementGoldenBoards.ts
//
// ==================================================================
//  SET-0B (test support): THE THIRTEEN SET-0A GOLDEN BOARDS, REBUILT IN-REPO
// ==================================================================
//
// SET-0A delivered its thirteen terminal boards as canonical JSON text outside the repository. SET-0A §19.1 asked
// SET-0B to rebuild them "in-repo from builders (the SET-0A recipes, deterministic)" instead of copying ~150 KB of
// board text, and that is what this module does. Each recipe is the one the golden file's `source` records:
//
//   SYN-01  GR.certificationStart() with Gentle Rust off, bank $0 + latch, played by RoomSession to GameEnd
//           (each corporation: Advance, then End Turn when still on turn -- 20 submissions, as recorded)
//   SYN-02  the same with Gentle Rust on, GR.SCRIPT submitted, then every remaining turn played to GameEnd
//   SYN-03  UR.playCertificationGame({ tail: "A", stop: atStockRound(7) }), then GameEnd + bank_broken grafted
//   SYN-04  SYN-01 + bankrupt_president p1, bank_broken removed, bank $1,500
//   SYN-05  JUNO-Z6C through 494 (development-corpus replay) + GameEnd, bank_broken, rules_engine_version 10
//   SYN-06  JUNO-G6J frozen golden log, same grafts
//   SYN-07  SYN-05 + N&W double certificate held by p-je0gw2v0 (+20% from the IPO), Dynamic Market on, PRR at $450
//   SYN-08  SYN-01 + Delayed Auction on, auction incomplete, every private unsold and open
//   SYN-09  SYN-08 with every private closed
//   SYN-10  SYN-01 + p4 ($0, nothing else), max_players 4
//   SYN-11  SYN-01 + p4 $310, p5 $0, p6 $1, max_players 6
//   SYN-12  SYN-01 + p4 $360, p5 $360, p6 $0, p7 $5, max_players 7, LPF + 18XX+ map/tiles
//   SYN-13  JUNO-CV4 frozen golden log, same grafts as SYN-05
//
// THE PROOF OF FIDELITY IS THE HASH. `settlementGoldens.test.ts` pins every rebuilt board's
// `terminal_state_hash_v1` to the value in the SET-0A rev 2 golden file; a SHA-256 match means the rebuilt board's
// canonical bytes ARE the golden file's. If a future reducer change moves one of these boards, that test says so
// by name -- and a moved board means a moved appraisal input, which is a rules-version question (SET-0A §19.3).

import { readFileSync } from "fs";
import { join } from "path";

import { entriesFromExport, replayLog, type ExportedEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { resolveVariants } from "../gameEngine/gameVariants";
import type { GameStateResponse } from "../gameEngine/gameState";
import { RoomSession } from "./roomSession";
import * as GR from "./gentleRustCertificationGame";
import * as UR from "./unpredictableRevenueCertificationGame";

type Board = GameStateResponse;
type Loose = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* Corpus replay                                                      */
/* ------------------------------------------------------------------ */

export const FIXTURES_DIR = join(__dirname, "__fixtures__");
export const FROZEN_LOG_DIR = join(FIXTURES_DIR, "replayGolden", "logs");
export const SERVER_DATA_DIR = join(__dirname, "..", "..", "..", "server", "data");
export const EXPORT_DIR = join(__dirname, "..", "..");

export const readJsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExportedEntry);

export const readExport = (file: string): ExportedEntry[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
  return raw.actions ?? raw.entries ?? [];
};

/** Replays a log under the development-corpus policy. `onBoard` sees every board the observer sees (the board
 *  before each entry), then the final board with `index: -1`. */
export function replayBoards(entries: ExportedEntry[], onBoard?: (index: number, board: Board) => void): Board {
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
    [],
  );
  const result = replayLog(
    entriesFromExport(entries),
    sandboxReplayProviders(),
    { state: seedState, waterfall: seedWaterfall },
    ({ entry, stateBefore }) => onBoard?.(entry.index, stateBefore),
    DEVELOPMENT_CORPUS_POLICY,
  );
  onBoard?.(-1, result.state);
  return result.state;
}

/* ------------------------------------------------------------------ */
/* Gentle Rust fixture rooms (SYN-01, SYN-02)                         */
/* ------------------------------------------------------------------ */

/** The GR-4 room, with the fixture's own documented market as the room's initial market (SET-0A F-6: the GR-4
 *  harness itself omits this, which is why its final board has no NYC mark). */
function grRoom(seed: Board): RoomSession {
  let minted = 0;
  return new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: GR.EMPTY_GRID, initialMarket: seed.market_positions as never },
    seed: { state: seed, waterfall: null },
    build: "gr4",
    mintId: () => `gr4-${(minted += 1)}`,
    now: () => 0,
    mintSeed: () => 1,
  });
}

const operating = (state: Board): number | null =>
  state.current_round_type === "OperatingRound" ? (state.active_operating_order[state.active_corporation_index] ?? null) : null;

function submit(room: RoomSession, actor: string, msg: unknown): { kind: string; reason?: string } {
  return room.submit({ actor, build: "gr4", host: GR.P1, msg: msg as never, baseIndex: room.nextIndex - 1 }) as {
    kind: string;
    reason?: string;
  };
}

/** Every remaining Operating Round turn, played to GameEnd: advance, then end the turn if the room has not. */
function playToGameEnd(room: RoomSession): number {
  let submissions = 0;
  for (let guard = 0; room.state.current_round_type !== "GameEnd"; guard += 1) {
    if (guard > 40) throw new Error("the fixture room never reached GameEnd");
    const id = operating(room.state);
    if (id === null) throw new Error(`unexpected round ${room.state.current_round_type}`);
    const president = room.state.public_companies.find((c) => c.company_id === id)!.president!;
    const advanced = submit(room, president, GR.ADVANCE(id));
    submissions += 1;
    if (advanced.kind !== "applied") throw new Error(`advance refused: ${advanced.reason ?? ""}`);
    if (operating(room.state) === id) {
      const ended = submit(room, president, GR.PASS);
      submissions += 1;
      if (ended.kind !== "applied") throw new Error(`end refused: ${ended.reason ?? ""}`);
    }
  }
  return submissions;
}

const bankBrokeAtStart = (board: Board): Board => ({ ...board, virtual_bank_vgp: "0", bank_broken: true }) as Board;

export function syn01ClassicBankBreak(): { board: Board; submissions: number } {
  const room = grRoom(bankBrokeAtStart({ ...GR.certificationStart(), variants: resolveVariants({}) } as Board));
  const submissions = playToGameEnd(room);
  return { board: room.state, submissions };
}

export function syn02GentleRustBankBreak(): Board {
  const room = grRoom(bankBrokeAtStart(GR.certificationStart()));
  for (const step of GR.SCRIPT) {
    if (step.ifStillTurn && operating(room.state) !== step.corp) continue;
    const answer = submit(room, step.actor, step.msg);
    const kind = answer.kind === "applied" ? "applied" : answer.kind;
    if (kind !== step.expect) throw new Error(`${step.label}: expected ${step.expect}, got ${answer.kind}`);
  }
  playToGameEnd(room);
  return room.state;
}

/* ------------------------------------------------------------------ */
/* Grafts                                                             */
/* ------------------------------------------------------------------ */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/* ==================================================================
    DA-8: THE GOLDEN BOARDS CARRY THE CERTIFIED PIN, NOT THE ENGINE'S
   ==================================================================
   SET-0A certified these thirteen boards at rules engine 10, and their `terminal_state_hash_v1` covers the pin like every
   other field. Nine of them are dealt through a room (SYN-01's and SYN-02's GR-4 rooms, SYN-03's UR-7 game, and the
   grafts on SYN-01), and a room stamps the CURRENT engine -- 11 since DA-8 -- so, left alone, the rebuild would follow the
   gameplay engine and every certified hash would move with a number that says nothing about the appraisal. The owner's
   DA-8 ruling keeps the two axes apart: settlement is certified for v10, and these ARE the v10 boards. So every board is
   stamped with the certified pin at the end of its recipe (the corpus grafts always were). The hash test in
   `settlementGoldens.test.ts` is then the proof that the v11 reducer rebuilds each certified board byte for byte, the
   pin aside -- no appraisal input moved across the bump -- and `da8RulesV11Closure.test.ts` pins that the unstamped
   rebuild carries the current engine and differs in that one field only. A v11 golden set is the v11 recertification's
   to build, beside these, never over them. */
export const SET0A_CERTIFIED_RULES_ENGINE_VERSION = 10;

/** A board stamped with the pin SET-0A certified it at (see above). Never the engine's current version. */
export const atCertifiedSettlementPin = (board: Board): Board =>
  ({ ...board, rules_engine_version: SET0A_CERTIFIED_RULES_ENGINE_VERSION }) as Board;

/** The corpus graft (SYN-05, 06, 13): terminal, bank broken, pinned so the strict appraiser accepts the board. */
export const corpusTerminalGraft = (board: Board): Board =>
  atCertifiedSettlementPin({ ...board, current_round_type: "GameEnd", bank_broken: true } as Board);

function syn03(): Board {
  const board = UR.playCertificationGame({ tail: "A", stop: UR.atStockRound(7) }).room.state;
  return { ...board, current_round_type: "GameEnd", bank_broken: true } as Board;
}

function syn04(syn01: Board): Board {
  const board = { ...clone(syn01), bankrupt_president: "p1", virtual_bank_vgp: "1500" } as Loose;
  delete board.bank_broken;
  return board as unknown as Board;
}

function syn07(syn05: Board): Board {
  const board = clone(syn05) as unknown as Loose;
  const companies = board.public_companies as Loose[];
  const nw = companies.find((company) => company.ticker === "N&W")!;
  const holder = (nw.player_holdings as Array<{ player: string; percentage: number }>).find((row) => row.player === "p-je0gw2v0")!;
  holder.percentage += 20;
  nw.ipo_pool_percentage = (nw.ipo_pool_percentage as number) - 20;
  nw.double_certificate = { at: "p-je0gw2v0" };
  board.variants = { ...(board.variants as Loose), dynamicStockMarket: true };
  board.market_positions = { ...(board.market_positions as Loose), 1: { price: 450, x: 18, y: 11, enteredAt: 99 } };
  return board as unknown as Board;
}

function syn08(syn01: Board): Board {
  const board = clone(syn01) as unknown as Loose;
  board.variants = { ...(board.variants as Loose), delayedAuction: true };
  board.private_auction_complete = false;
  board.private_companies = (board.private_companies as Loose[]).map((priv) => ({
    ...priv,
    owner: null,
    owner_protocol_id: null,
    closed: false,
  }));
  return board as unknown as Board;
}

function syn09(syn08Board: Board): Board {
  const board = clone(syn08Board) as unknown as Loose;
  board.private_companies = (board.private_companies as Loose[]).map((priv) => ({ ...priv, closed: true }));
  return board as unknown as Board;
}

/** Adds cash-only seats after the existing roster (SYN-10/11/12). */
export function withExtraSeats(base: Board, extra: Array<[string, string]>, variants?: Loose): Board {
  const board = clone(base) as unknown as Loose;
  board.player_addresses = [...(board.player_addresses as string[]), ...extra.map(([id]) => id)];
  board.player_cash = [
    ...(board.player_cash as Loose[]),
    ...extra.map(([player, cash]) => ({ player, cash_vgp: cash })),
  ];
  board.max_players = (board.player_addresses as string[]).length;
  if (variants) board.variants = { ...(board.variants as Loose), ...variants };
  return board as unknown as Board;
}

/* ------------------------------------------------------------------ */
/* The thirteen                                                       */
/* ------------------------------------------------------------------ */

export interface GoldenBoards {
  boards: Record<string, Board>;
  syn01Submissions: number;
}

let cache: GoldenBoards | null = null;

/** Every SET-0A golden board, keyed by case name. Built once per test file; callers must not mutate (they get the
 *  shared objects -- clone before grafting). */
export function goldenBoards(): GoldenBoards {
  if (cache) return cache;
  const built = syn01ClassicBankBreak();
  // DA-8: SYN-01 is dealt by a room at the current engine; the certified board is the same board at the certified pin.
  const s01 = atCertifiedSettlementPin(built.board);
  const submissions = built.submissions;
  const s05 = corpusTerminalGraft(replayBoards(readExport(join(__dirname, "__fixtures__z6cLog.json"))));
  const s08 = syn08(s01);
  const recipes: Record<string, Board> = {
    "SYN-01-CLASSIC-BANKBREAK": s01,
    "SYN-02-GENTLE-RUST-BANKBREAK": syn02GentleRustBankBreak(),
    "SYN-03-UNPREDICTABLE-REVENUE-END": syn03(),
    "SYN-04-BANKRUPTCY": syn04(s01),
    "SYN-05-Z6C-COMPOSED-END": s05,
    "SYN-06-G6J-UNPARRED-GRANT-END": corpusTerminalGraft(replayBoards(readJsonl(join(FROZEN_LOG_DIR, "JUNO-G6J.log.jsonl")))),
    "SYN-07-DOUBLE-CERT-AND-DYNAMIC-450": syn07(s05),
    "SYN-08-DELAYED-AUCTION-UNSOLD": s08,
    "SYN-09-DELAYED-AUCTION-PHASE5-UNSOLD-CLOSED": syn09(s08),
    "SYN-10-ZERO-VALUE-SEAT-4P": withExtraSeats(s01, [["p4", "0"]]),
    "SYN-11-SIX-PLAYERS": withExtraSeats(s01, [["p4", "310"], ["p5", "0"], ["p6", "1"]]),
    "SYN-12-SEVEN-PLAYERS-LPF": withExtraSeats(
      s01,
      [["p4", "360"], ["p5", "360"], ["p6", "0"], ["p7", "5"]],
      { levelPlayingField: true, expandedMap: true, plusTiles: true },
    ),
    "SYN-13-CV4-TWO-PLAYER-END": corpusTerminalGraft(replayBoards(readJsonl(join(FROZEN_LOG_DIR, "JUNO-CV4.log.jsonl")))),
  };
  // DA-8: every recipe ends at the certified pin (SYN-02 and SYN-03 are room-dealt too).
  const boards: Record<string, Board> = {};
  for (const [name, board] of Object.entries(recipes)) boards[name] = atCertifiedSettlementPin(board);
  cache = { boards, syn01Submissions: submissions };
  return cache;
}
