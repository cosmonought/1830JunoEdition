// frontend/src/utils/gentleRustCertificationGame.ts
//
// TEST SUPPORT ONLY for GR-4 (Gentle Rust certification, design note #1703). Nothing in the app imports this.
//
// ==================================================================
//  DESIGN NOTE 1703 (support): THE CONSTRUCTED LEGAL CERTIFICATION GAME
// ==================================================================
//
// A CONSTRUCTED LEGAL CERTIFICATION GAME -- NOT A HISTORICAL GAME, NOT A GOLDEN. It is never exported, never added
// to the development corpus and never blessed: it is a starting board plus a fixed list of messages, driven through
// the same `RoomSession` a server runs, so that the three rust boundaries of 1830 (first 4, first 6, first D) are
// proved to COMPOSE under Gentle Rust in one game rather than only in isolated boards.
//
// PROVENANCE OF THE STARTING BOARD (every nontrivial fact, and why it is reachable by legal play):
//   * Rules: `variants` = `resolveVariants({ gentleRust: true })` (standard 1830 otherwise); pinned to the engine's
//     `RULES_ENGINE_VERSION` (8 when GR-4 wrote this; 9 since the GR-5 closure, #1705 -- the version standalone Gentle
//     Rust is certified at), so it replays under `SERVER_REPLAY_POLICY` -- no legacy adapter is involved.
//   * Cursor: Operating Round 3.1 of a two-round set (phase 3 sets are two rounds), NYC -- first in the order -- at
//     the START of its turn (Lay Track). The round's opening -- operating order and private income -- has happened.
//   * Phase 3, limit 4: all six 2-trains and all five 3-trains are owned, none in the Bank Pool, so the depot's head
//     is the first 4-train. The pool is empty because the limit did not drop between phase 2 and phase 3 (4 -> 4),
//     so no excess discard -- the only way a train reaches the pool before a Diesel -- has happened yet. (The same
//     fact is why no LEGAL board can hold a 2-train in the Bank Pool when the first 4 arrives.)
//   * Five corporations floated -- NYC, PRR, CPR, B&O, C&O -- each with its home station token on its REAL 1830
//     home hex (`STATION_HOME_HEXES`), so no home station is owed; ERIE, NNH and B&M unfloated (100% in the IPO,
//     no token, no train). Each floated corporation's certificates are all in players' hands (10 shares issued).
//   * Fleets (all within limit 4): NYC [2,2,3], PRR [2,3,3], CPR [3,3], B&O [2,2], C&O [2].
//   * Share prices on real chart cells of one row (`marketCellForPrice`): NYC 112, PRR 100, CPR 90, B&O 82,
//     C&O 76 -- which is the operating order.
//   * Private companies: all six sold in the opening auction. The B&O private is CLOSED because the B&O corporation
//     has bought a train (#660); the other five are open, player-owned, and close at the first 5-train.
//   * Money: every dollar of the $12,000 bank is accounted for -- bank + player cash + treasuries = 12,000.
//   * The map is the printed board with no tile laid yet (legal: laying track is never compulsory). The FIRST
//     message lays one: NYC's yellow straight city on its own home, Albany, through the ordinary `LayTile`
//     authority. That gives NYC track but no second revenue location, so no corporation has an earnable route
//     anywhere, the room's own derived actions skip every Routes step and force every dividend to a $0 withhold --
//     which is exactly the "a turn, not a guaranteed run" shape (GR-S17): every grace turn in this game expires
//     WITHOUT a run. (An EMPTY grid would not do: `earnableRevenueVerdict` reads it as "the board has not loaded"
//     and skips nothing.) The run itself is certified separately (GR-1's real reprieved route).
// After this board the game advances ONLY by the messages below, submitted through `RoomSession.submit` with the
// acting president (or the Stock Round seat) as the author; the room appends its own derived entries (auto-skips,
// forced withholds, the train-limit end of turn). No board is patched between steps.

import type { GameStateResponse, PublicCompanyState, PrivateCompanyState } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import { RoomSession, type ServerLogEntry } from "./roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { resolveVariants } from "../gameEngine/gameVariants";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { marketCellForPrice } from "../gameEngine/marketGeometry";
import { stateDigest } from "../gameEngine/stateDigest";

export const P1 = "p1";
export const P2 = "p2";
export const P3 = "p3";

export const PRR = 1;
export const NYC = 2;
export const CPR = 3;
export const BO = 4;
export const CO = 5;

export const TICKER: Record<number, string> = { 1: "PRR", 2: "NYC", 3: "CPR", 4: "B&O", 5: "C&O", 6: "ERIE", 7: "NNH", 8: "B&M" };
/** 1830's printed station allowance, home token included (`sandboxState.ts` #237). */
const TOKENS: Record<number, number> = { 1: 4, 2: 4, 3: 4, 4: 3, 5: 3, 6: 3, 7: 2, 8: 2 };

export const BANK_SIZE = 12_000;

interface Floated {
  id: number;
  president: string;
  holdings: Array<[string, number]>;
  treasury: number;
  trains: string[];
  price: number;
}

/** The five floated corporations of the starting board. */
export const FLOATED: readonly Floated[] = [
  { id: NYC, president: P2, holdings: [[P2, 50], [P1, 30], [P3, 20]], treasury: 1_500, trains: ["2", "2", "3"], price: 112 },
  { id: PRR, president: P1, holdings: [[P1, 60], [P2, 20], [P3, 20]], treasury: 700, trains: ["2", "3", "3"], price: 100 },
  { id: CPR, president: P3, holdings: [[P3, 60], [P1, 20], [P2, 20]], treasury: 600, trains: ["3", "3"], price: 90 },
  { id: BO, president: P3, holdings: [[P3, 60], [P2, 30], [P1, 10]], treasury: 2_000, trains: ["2", "2"], price: 82 },
  { id: CO, president: P1, holdings: [[P1, 50], [P3, 30], [P2, 20]], treasury: 1_000, trains: ["2"], price: 76 },
];

export const PLAYER_CASH: Readonly<Record<string, number>> = { [P1]: 600, [P2]: 500, [P3]: 700 };

/** Every private sold in the opening auction; the B&O private closed when the B&O bought its first train (#660). */
const PRIVATES: ReadonlyArray<{ id: number; name: string; cost: number; revenue: number; owner: string; closed: boolean }> = [
  { id: 1, name: "Schuylkill Valley", cost: 20, revenue: 5, owner: P3, closed: false },
  { id: 2, name: "Champlain & St. Lawrence", cost: 40, revenue: 10, owner: P2, closed: false },
  { id: 3, name: "Delaware & Hudson", cost: 70, revenue: 15, owner: P1, closed: false },
  { id: 4, name: "Mohawk & Hudson", cost: 110, revenue: 20, owner: P2, closed: false },
  { id: 5, name: "Camden & Amboy", cost: 160, revenue: 25, owner: P1, closed: false },
  { id: 6, name: "Baltimore & Ohio", cost: 220, revenue: 30, owner: P3, closed: true },
];

const home = (id: number) => STATION_HOME_HEXES.find((entry) => entry.companyId === id)!;

/** The printed board with no tile laid. */
export const EMPTY_GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

/** The constructed legal starting board. A fresh object every call. */
export function certificationStart(): GameStateResponse {
  const treasuries = FLOATED.reduce((sum, entry) => sum + entry.treasury, 0);
  const cash = Object.values(PLAYER_CASH).reduce((sum, value) => sum + value, 0);
  const order = FLOATED.map((entry) => entry.id);
  const floated = (entry: Floated): PublicCompanyState =>
    ({
      company_id: entry.id,
      ticker: TICKER[entry.id],
      is_floated: true,
      treasury: String(entry.treasury),
      total_shares_issued: 10,
      par_value: String(entry.price),
      last_route_revenue: "0",
      president: entry.president,
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      player_holdings: entry.holdings.map(([player, percentage]) => ({ player, percentage })),
      home_hex_label: home(entry.id).label,
      station_token_hexes: [[home(entry.id).q, home(entry.id).r]],
      station_tokens: [[home(entry.id).q, home(entry.id).r, 0]],
      station_token_limit: TOKENS[entry.id],
      owned_trains: [...entry.trains],
      pending_rust_trains: [],
    }) as unknown as PublicCompanyState;
  const unfloated = (id: number): PublicCompanyState =>
    ({
      company_id: id,
      ticker: TICKER[id],
      is_floated: false,
      treasury: "0",
      total_shares_issued: 0,
      par_value: null,
      last_route_revenue: "0",
      president: null,
      ipo_pool_percentage: 100,
      bank_pool_percentage: 0,
      player_holdings: [],
      home_hex_label: home(id).label,
      station_token_hexes: [],
      station_tokens: [],
      station_token_limit: TOKENS[id],
      owned_trains: [],
      pending_rust_trains: [],
    }) as unknown as PublicCompanyState;
  return {
    game_id: 1,
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: String(PLAYER_CASH[player]) })),
    virtual_bank_vgp: String(BANK_SIZE - treasuries - cash),
    virtual_bank_start: String(BANK_SIZE),
    private_companies: PRIVATES.map(
      (entry) =>
        ({
          private_id: entry.id,
          name: entry.name,
          cost: String(entry.cost),
          revenue_per_or: String(entry.revenue),
          owner: entry.owner,
          owner_protocol_id: null,
          closed: entry.closed,
        }) as PrivateCompanyState,
    ),
    variants: resolveVariants({ gentleRust: true }),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: order,
    active_corporation_index: 0,
    operating_sub_phase: "Track",
    rules_engine_version: RULES_ENGINE_VERSION,
    returned_trains: [],
    market_positions: Object.fromEntries(
      FLOATED.map((entry, index) => [entry.id, { price: entry.price, ...marketCellForPrice(entry.price)!, enteredAt: index + 1 }]),
    ),
    public_companies: [
      ...FLOATED.map(floated),
      unfloated(6),
      unfloated(7),
      unfloated(8),
    ].sort((a, b) => a.company_id - b.company_id),
  } as unknown as GameStateResponse;
}

/* ------------------------------------------------------------------ */
/* The fixed script                                                   */
/* ------------------------------------------------------------------ */

type Msg = SandboxLogMsg;
const m = (msg: unknown) => msg as Msg;
export const ADVANCE = (id: number) => m({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } });
export const PASS = m({ PassTurn: { game_id: 1 } });
export const BUY = (id: number) => m({ BuyHardwareFromPool: { game_id: 1, protocol_id: id } });
export const EXCHANGE = (id: number, model: string) =>
  m({ ExchangeTrainForDiesel: { game_id: 1, protocol_id: id, model_type: model } });
export const DISCARD = (id: number, model: string) => m({ DiscardTrain: { game_id: 1, protocol_id: id, model_type: model } });

/** One submitted message. `corp` is the corporation whose turn the board must be on when it is sent (`null` for a
 *  Stock Round seat or an off-turn discard); `expect` is the room's answer; `label` names a checkpoint the test
 *  inspects (the board after the message and every derived entry it caused). An `ifStillTurn` step (an End Turn) is
 *  sent only when the board is still on `corp`'s turn -- when the room's own train-limit auto-skip has not already
 *  ended it. Whether it is sent is a function of the board alone, so the script stays fixed and replayable. */
export interface ScriptStep {
  label: string;
  actor: string;
  msg: Msg;
  corp: number | null;
  expect: "applied" | "refused";
  ifStillTurn?: boolean;
}

const step = (label: string, actor: string, msg: Msg, corp: number | null, expect: "applied" | "refused" = "applied"): ScriptStep => ({
  label,
  actor,
  msg,
  corp,
  expect,
});
const endTurn = (label: string, actor: string, corp: number): ScriptStep => ({ ...step(label, actor, PASS, corp), ifStillTurn: true });

/** Albany (E19, NYC's home city): the one tile laid in this game -- a yellow straight city, laid by NYC in its own
 *  Lay Track step through the ordinary `LayTile` authority. It gives NYC track but no second revenue location, so no
 *  corporation has an earnable route anywhere (and the board is a loaded map, not an empty one). */
export const ALBANY_LAY = m({
  LayTile: { game_id: 1, protocol_id: NYC, q: home(NYC).q, r: home(NYC).r, tile_id: 57, orientation: 0 },
});

/** The whole fixed progression, in order. Phase 3 -> first 4 -> first 5 -> first 6 -> first D. */
export const SCRIPT: readonly ScriptStep[] = [
  // ---- OR 3.1: NYC, PRR, CPR, B&O, C&O ----
  step("3.1 NYC lays Albany", P2, ALBANY_LAY, NYC),
  endTurn("3.1 NYC ends (has operated)", P2, NYC),
  step("3.1 PRR track", P1, ADVANCE(PRR), PRR),
  step("3.1 PRR buys the FIRST 4", P1, BUY(PRR), PRR),
  endTurn("3.1 PRR ends", P1, PRR),
  step("3.1 CPR track", P3, ADVANCE(CPR), CPR),
  step("3.1 CPR buys a 4", P3, BUY(CPR), CPR),
  endTurn("3.1 CPR ends", P3, CPR),
  step("3.1 B&O grace turn", P3, ADVANCE(BO), BO),
  step("3.1 B&O buys a 4", P3, BUY(BO), BO),
  step("3.1 B&O buys the last 4", P3, BUY(BO), BO),
  step("3.1 B&O buys the FIRST 5", P3, BUY(BO), BO),
  step("3.1 PRR may not discard its reprieved 2", P1, DISCARD(PRR, "2"), null, "refused"),
  step("3.1 PRR discards a 3", P1, DISCARD(PRR, "3"), null),
  step("3.1 CPR discards its 4", P3, DISCARD(CPR, "4"), null),
  step("3.1 B&O discards its 5", P3, DISCARD(BO, "5"), null),
  endTurn("3.1 B&O ends", P3, BO),
  step("3.1 C&O grace turn", P1, ADVANCE(CO), CO),
  step("3.1 C&O buys a 5", P1, BUY(CO), CO),
  step("3.1 C&O buys the last 5", P1, BUY(CO), CO),
  endTurn("3.1 C&O ends", P1, CO),
  // ---- OR 3.2 ----
  step("3.2 NYC grace turn", P2, ADVANCE(NYC), NYC),
  step("3.2 NYC buys the FIRST 6", P2, BUY(NYC), NYC),
  step("3.2 NYC buys the last 6", P2, BUY(NYC), NYC),
  endTurn("3.2 NYC ends", P2, NYC),
  step("3.2 PRR grace turn", P1, ADVANCE(PRR), PRR),
  endTurn("3.2 PRR ends", P1, PRR),
  step("3.2 CPR grace turn", P3, ADVANCE(CPR), CPR),
  endTurn("3.2 CPR ends", P3, CPR),
  step("3.2 B&O track", P3, ADVANCE(BO), BO),
  step("3.2 B&O trades an ordinary 4 for the FIRST D", P3, EXCHANGE(BO, "4"), BO),
  step("3.2 B&O may not trade in its reprieved 4", P3, EXCHANGE(BO, "4"), BO, "refused"),
  endTurn("3.2 B&O ends", P3, BO),
  step("3.2 C&O track", P1, ADVANCE(CO), CO),
  endTurn("3.2 C&O ends", P1, CO),
];

/** The Stock Round and the next set are played by the same rule, so they are generated rather than listed: each
 *  seat passes, and every corporation of the next set advances once and ends its turn. Still a fixed list -- it
 *  depends on nothing but the board the fixed steps above produce. */
export interface Played {
  step: ScriptStep;
  kind: string;
  reason: string | null;
  /** Every entry the submission appended (its own and the derived ones), as `Kind` / `Kind*`. */
  entries: string[];
  /** Their log indices, in the same order. */
  indices: number[];
  before: GameStateResponse;
  after: GameStateResponse;
}

export interface CertificationRun {
  room: RoomSession;
  played: Played[];
  /** The board after the step with this label. */
  at: (label: string) => GameStateResponse;
  /** The board before the step with this label. */
  before: (label: string) => GameStateResponse;
}

export function certificationRoom(seed: GameStateResponse = certificationStart()): RoomSession {
  let minted = 0;
  return new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: EMPTY_GRID },
    seed: { state: seed, waterfall: null },
    build: "gr4",
    mintId: () => `gr4-${(minted += 1)}`,
    now: () => 0,
    mintSeed: () => 1,
  });
}

const operating = (state: GameStateResponse): number | null =>
  state.current_round_type === "OperatingRound" ? (state.active_operating_order[state.active_corporation_index] ?? null) : null;

const seatActor = (state: GameStateResponse): string => state.player_addresses[state.active_player_index];

/** Plays the fixed script, then the Stock Round and every turn of the next Operating Round, through one room.
 *  Throws (with the step's label) when the room's answer differs from the script's expectation or the turn is not
 *  the one the script names. */
export function runCertificationGame(seed: GameStateResponse = certificationStart()): CertificationRun {
  const room = certificationRoom(seed);
  const played: Played[] = [];
  const submit = (s: ScriptStep) => {
    const before = room.state;
    if (s.ifStillTurn && operating(before) !== s.corp) {
      played.push({ step: s, kind: "not-sent", reason: null, entries: [], indices: [], before, after: before });
      return;
    }
    if (s.corp !== null && operating(before) !== s.corp) {
      throw new Error(`${s.label}: expected ${TICKER[s.corp]}'s turn, the board is on ${operating(before)} @ ${before.operating_sub_phase}`);
    }
    const response = room.submit({ actor: s.actor, build: "gr4", host: P1, msg: s.msg, baseIndex: room.nextIndex - 1 }) as {
      kind: string;
      reason?: string;
      entries?: ServerLogEntry[];
    };
    const kind = response.kind === "applied" ? "applied" : response.kind;
    if (kind !== s.expect) {
      const error = new Error(`${s.label}: expected ${s.expect}, the room answered ${response.kind}${response.reason ? ` (${response.reason})` : ""}`);
      (error as Error & { played?: Played[] }).played = played;
      throw error;
    }
    played.push({
      step: s,
      kind,
      reason: response.reason ?? null,
      entries: (response.entries ?? []).map((entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`),
      indices: (response.entries ?? []).map((entry) => entry.index),
      before,
      after: room.state,
    });
  };
  for (const s of SCRIPT) submit(s);

  // The Stock Round: every seat passes.
  for (let guard = 0; room.state.current_round_type === "StockRound"; guard += 1) {
    if (guard > 6) throw new Error("the Stock Round never ended");
    submit(step(`SR ${room.state.macro_round_number} seat passes`, seatActor(room.state), PASS, null));
  }
  // The next set's first round: every corporation advances past Lay Track (the room skips the rest) and, if the
  // room has not already ended its turn, ends it.
  const round = room.state.sub_round_index;
  const macro = room.state.macro_round_number;
  for (let guard = 0; room.state.current_round_type === "OperatingRound" && room.state.sub_round_index === round && room.state.macro_round_number === macro; guard += 1) {
    if (guard > 12) throw new Error("the next Operating Round never ended");
    const id = operating(room.state)!;
    const president = room.state.public_companies.find((entry) => entry.company_id === id)!.president!;
    submit(step(`${macro}.${round} ${TICKER[id]} turn`, president, ADVANCE(id), id));
    submit(endTurn(`${macro}.${round} ${TICKER[id]} ends`, president, id));
  }

  const find = (label: string) => {
    const hit = played.find((entry) => entry.step.label === label);
    if (!hit) throw new Error(`no step labelled ${label}`);
    return hit;
  };
  return { room, played, at: (label) => find(label).after, before: (label) => find(label).before };
}

/** A compact, comparable fingerprint of a run: every step's answer, entries and board digest. */
export const runFingerprint = (run: CertificationRun) =>
  run.played.map((entry) => [entry.step.label, entry.kind, entry.entries.join(" "), stateDigest(entry.after)]);
