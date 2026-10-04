// frontend/src/utils/settlementV13Vectors.ts
//
// TEST SUPPORT ONLY for the Phase 3 dedicated rules-v13 settlement certification (`settlementV13Certification.test.ts`).
// Nothing in the app imports this.
//
// ==================================================================
//  PHASE 3: THE v13 TERMINAL BOARDS SETTLEMENT MUST READ -- REACHED BY PLAY, NEVER HAND-BUILT
// ==================================================================
//
// `docs/phase3/V13_SETTLEMENT_CERTIFICATION_VECTORS.md` asks for v13 terminal boards "reached by replaying a log through
// RoomEngine, never hand-built". The thirteen SET-0A recipes cannot show a v13 terminal: their histories are revision 0
// (no v13 correction in force) or unpinned corpus logs. So each vector below is A CONSTRUCTED STARTING BOARD plus a FIXED
// SCRIPT of messages, played through the same `RoomSession` a server runs -- ingress, the reducer, the room's own derived
// entries (the skips, the forced withhold, the automatic purchase, the automatic bankruptcy) -- exactly as GR-4's and
// UR-7's certification games and R12-3's forks are. The terminal is the room's board after the last entry; no board is
// patched between steps and no terminal field is grafted (the bank-break vectors end by the reducer's own set-end rule
// on a latched bank; the bankruptcy vectors end in the transition that proved the bankruptcy).
//
// PROVENANCE OF THE STARTING BOARDS (constructed, named, each fact legal on its own):
//   * Rules: standard 1830 at RULES REVISION 2, pinned 13 -- what every hosted v13 deal is stamped with -- replayed under
//     `SERVER_REPLAY_POLICY`; no legacy adapter is involved.
//   * Seats p1, p2, p3 (p4 on V13-12b). p1 presides the C&O in every emergency-funding vector (all but V13-01, 02, 12b, 18).
//   * THE OBLIGATION (the emergency vectors; constructed, as UR-7 constructs C&O's I5 station): the C&O is trainless,
//     its station on H16 with a yellow city there and a curve on I17 -- the corridor the W3-K emergency suites use, a
//     legal two-stop route -- so it owes a train at Buy Trains. The cursor is the C&O's Lay Track step; p1's one "advance" walks the turn there through
//     the room's own derived skips and forced $0 withhold. Every other corporation's token is on its REAL home hex with
//     no track: none of them has a route, so its turns are ordinary (GR-4's device).
//   * Phase: 2 (no corporation owns a 3; the 2-train costs $80; corporations may not buy privates), or 3 (NYC or CPR owns
//     a 3; the 3-train costs $180; privates may be sold to corporations for half to twice face). Fleets within limits.
//   * Corporations: the eight, three to five of them parred with par values from the printed ladder and share prices on
//     real chart cells (constructed, as UR-7's are); holdings, IPO and Bank Pool always sum to 100%; the rest unstarted.
//   * Privates: the six, all sold in the opening auction -- the five player privates open with the owners named, the
//     B&O private closed (#660).
//   * Money: the bankruptcy vectors' bank holds every dollar of the $12,000 not in a hand or a treasury; the bank-break
//     vectors' bank is $0 and latched broken by the payout before the board (SYN-01's device), so the set ends the game.
// What is CONSTRUCTED rather than earned is named above; everything after the seed is the room's.
//
// THE VECTORS (V13-13 is the determinism of every one of them; V13-14, the v12 log, is in the test file):
//   V13-01  SYN-01's GR-4 room at revision 2: an ordinary bank break with no emergency.
//   V13-02  a Stock Round of one-click PassTurns, a Brown Bank Pool continuation and an all-pass ending, then two ORs.
//   V13-03  automatic bankruptcy: every legal leg liquidated, still short.
//   V13-04  ... where the presidency rule keeps shares (a President's Certificate nobody can take) unsold.
//   V13-05  ... where the 50% Bank Pool cap limits a leg.
//   V13-06  ... with no saleable share at all: only the cash moves.
//   V13-07  bankruptcy after ForgoTrainTrade closed the window (a liquidation-sized trade refused first).
//   V13-08  bankruptcy after ForgoPrivateFunding.
//   V13-09  immediate bankruptcy with the bankrupt's privates still open (private funding irrelevant).
//   V13-10  a rescue by EmergencySellPortfolio (the smallest legal overshoot), then play to a bank break.
//   V13-11  the automatic EmergencyBuyHardware (derived, keyed) after a forgone window, then a bank break.
//   V13-12  ties at the top: (a) the bankrupt ties p2; (b) two seats tie in a four-seat bank break.
//   V13-15  the maximal mixed liquidation: a Pool-capped leg, a presidency-locked holding and a fully sold one.
//   V13-16  (a) a loose bound only -- one buyer cannot pay for both privates: the game ends at once; (b) one legal
//           private sale -- the game waits, then rescues.
//   V13-17  (a) a private sale then a portfolio; (b) two private sales to two buyers -- each completes a rescue.
//   V13-18  a Brown continuation interrupted by p1's accepted private trade (a) or M&H exchange (b); an off-turn
//           rejection in between does not interrupt it.
//   V13-19  an atomic three-corporation portfolio in the submitted order, with NYC's presidency passing inside it.
//   V13-20  one obligation rescued by the $100 card (a) and by the $60 card (b): both legal (owner ruling 1).
//   V13-21  (a) an intercorporate trade inside the window; (b) the same obligation after a liquidation closed it.

import type { GameStateResponse, PublicCompanyState, PrivateCompanyState } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import { marketCellForPrice } from "../gameEngine/marketGeometry";
import { resolveVariants } from "../gameEngine/gameVariants";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { logHash } from "../gameEngine/logHash";
import { RoomEngine, replayLog } from "../gameEngine/replayLog";
import { SERVER_REPLAY_POLICY } from "../gameEngine/rulesVersion";
import { terminalStateHashV1 } from "../gameEngine/settlementDigest";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { sandboxActionContext } from "../gameEngine/actionContext";
import { routeRulesRevisionOf, withRules } from "../gameEngine/boardSelection";
import { RoomSession, type ServerLogEntry } from "./roomSession";
import * as GR from "./gentleRustCertificationGame";

export type Board = GameStateResponse;

export const P1 = "p1";
export const P2 = "p2";
export const P3 = "p3";

export const PRR = 1;
export const NYC = 2;
export const CPR = 3;
export const BO = 4;
export const CO = 5;

export const TICKER: Record<number, string> = { 1: "PRR", 2: "NYC", 3: "CPR", 4: "B&O", 5: "C&O", 6: "ERIE", 7: "NNH", 8: "B&M" };
export const BANK_SIZE = 12_000;
const TOKENS: Record<number, number> = { 1: 4, 2: 4, 3: 4, 4: 3, 5: 3, 6: 3, 7: 2, 8: 2 };

/** The six 1830 privates: id, name, printed face, revenue. */
export const PRIVATES: ReadonlyArray<{ id: number; name: string; cost: number; revenue: number }> = [
  { id: 1, name: "Schuylkill Valley", cost: 20, revenue: 5 },
  { id: 2, name: "Champlain & St. Lawrence", cost: 40, revenue: 10 },
  { id: 3, name: "Delaware & Hudson", cost: 70, revenue: 15 },
  { id: 4, name: "Mohawk & Hudson", cost: 110, revenue: 20 },
  { id: 5, name: "Camden & Amboy", cost: 160, revenue: 25 },
  { id: 6, name: "Baltimore & Ohio", cost: 220, revenue: 30 },
];
export const SV = 1;
export const CSL = 2;
export const DH = 3;
export const MH = 4;
export const CA = 5;
export const BOP = 6;

const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
const home = (id: number) => STATION_HOME_HEXES.find((entry) => entry.companyId === id)!;

export const H16 = hex("H16");
export const I17 = hex("I17");

/** C&O's corridor: a yellow city at H16 (C&O's constructed station) and a curve at I17 -- a legal two-stop route. */
export const CORRIDOR: MapGridResponse = {
  game_id: 1,
  tiles: [
    { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
    { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
  ],
} as unknown as MapGridResponse;

/** The Stock Round vectors' map: GR-4's Albany lay (a yellow city on NYC's home) and nothing else -- a loaded map on
 *  which no corporation has an earnable route, so every Operating turn after the Stock Round is an ordinary one. */
export const ALBANY: MapGridResponse = {
  game_id: 1,
  tiles: [{ q: home(NYC).q, r: home(NYC).r, tile_id: 57, orientation: 0 }],
} as unknown as MapGridResponse;

export interface CorpSpec {
  id: number;
  president: string;
  holdings: Array<[string, number]>;
  pool?: number;
  par: number;
  price: number;
  treasury: number;
  trains?: string[];
  /** The station hex label; the corporation's real home when absent. */
  station?: string;
}

export interface BoardSpec {
  players?: string[];
  cash: Record<string, number>;
  corps: CorpSpec[];
  privates?: Array<{ id: number; owner?: string | null; corp?: number; closed?: boolean }>;
  /** The bank broke at the payout before this board (SYN-01's device): $0, latched. Otherwise the bank holds every
   *  dollar of the $12,000 not in a player's hand or a treasury. */
  bankBroken?: boolean;
  round:
    | { kind: "OR"; order: number[]; active: number; step: string; sub?: number; length?: number; macro?: number }
    | { kind: "SR"; seat: number; macro?: number; priority?: number };
}

const stationOf = (spec: CorpSpec): { q: number; r: number } => (spec.station ? hex(spec.station) : home(spec.id));

/** A v13 board (pin 13, rules revision 2): parred corporations from `corps`, the rest of the eight unstarted. */
export function v13Board(spec: BoardSpec): Board {
  const players = spec.players ?? [P1, P2, P3];
  const parred = new Map(spec.corps.map((corp) => [corp.id, corp]));
  const companies = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => {
    const corp = parred.get(id);
    if (!corp) {
      return {
        company_id: id, ticker: TICKER[id], is_floated: false, treasury: "0", total_shares_issued: 0, par_value: null,
        last_route_revenue: "0", president: null, ipo_pool_percentage: 100, bank_pool_percentage: 0, player_holdings: [],
        home_hex_label: home(id).label, station_token_hexes: [], station_tokens: [], station_token_limit: TOKENS[id],
        owned_trains: [], pending_rust_trains: [],
      } as unknown as PublicCompanyState;
    }
    const held = corp.holdings.reduce((sum, [, pct]) => sum + pct, 0);
    const pool = corp.pool ?? 0;
    if (held + pool > 100) throw new Error(`${TICKER[id]}: holdings ${held} + pool ${pool} exceed 100`);
    const at = stationOf(corp);
    return {
      company_id: id, ticker: TICKER[id], is_floated: true, treasury: String(corp.treasury), total_shares_issued: 10,
      par_value: String(corp.par), last_route_revenue: "0", president: corp.president,
      ipo_pool_percentage: 100 - held - pool, bank_pool_percentage: pool,
      player_holdings: corp.holdings.map(([player, percentage]) => ({ player, percentage })),
      home_hex_label: home(id).label, station_token_hexes: [[at.q, at.r]], station_tokens: [[at.q, at.r, 0]],
      station_token_limit: TOKENS[id], owned_trains: [...(corp.trains ?? [])], pending_rust_trains: [],
    } as unknown as PublicCompanyState;
  });
  const privates = PRIVATES.map((printed) => {
    const entry = (spec.privates ?? []).find((candidate) => candidate.id === printed.id);
    return {
      private_id: printed.id, name: printed.name, cost: String(printed.cost), revenue_per_or: String(printed.revenue),
      owner: entry?.owner ?? null, owner_protocol_id: entry?.corp ?? null, closed: entry === undefined ? true : (entry.closed ?? false),
    } as PrivateCompanyState;
  });
  const round =
    spec.round.kind === "OR"
      ? {
          current_round_type: "OperatingRound",
          macro_round_number: spec.round.macro ?? 3,
          sub_round_index: spec.round.sub ?? 1,
          operating_round_sequence_length: spec.round.length ?? 1,
          active_player_index: 0,
          priority_deal_index: 0,
          consecutive_passes: 0,
          active_operating_order: spec.round.order,
          active_corporation_index: spec.round.order.indexOf(spec.round.active),
          operating_sub_phase: spec.round.step,
        }
      : {
          current_round_type: "StockRound",
          macro_round_number: spec.round.macro ?? 4,
          active_player_index: spec.round.seat,
          priority_deal_index: spec.round.priority ?? spec.round.seat,
          consecutive_passes: 0,
          last_trader_index: null,
          operating_round_just_ended: false,
          stock_round_just_ended: false,
          active_operating_order: [],
          active_corporation_index: 0,
        };
  return {
    game_id: 1,
    player_addresses: players,
    player_cash: players.map((player) => ({ player, cash_vgp: String(spec.cash[player] ?? 0) })),
    virtual_bank_vgp: String(spec.bankBroken ? 0 : BANK_SIZE - players.reduce((sum, player) => sum + (spec.cash[player] ?? 0), 0) - spec.corps.reduce((sum, corp) => sum + corp.treasury, 0)),
    virtual_bank_start: "12000",
    ...(spec.bankBroken ? { bank_broken: true } : {}),
    private_companies: privates,
    variants: resolveVariants({ rules: 2 }),
    rules_engine_version: 13,
    returned_trains: [],
    ...round,
    market_positions: Object.fromEntries(
      spec.corps.map((corp, index) => [corp.id, { price: corp.price, ...marketCellForPrice(corp.price)!, enteredAt: index + 1 }]),
    ),
    public_companies: companies,
  } as unknown as Board;
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export const ADVANCE = (id: number) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } });
export const PASS = { PassTurn: { game_id: 1 } };
export const PORTFOLIO = (...sales: Array<[number, number]>) => ({ EmergencySellPortfolio: { game_id: 1, sales: sales.map(([protocol_id, percentage]) => ({ protocol_id, percentage })) } });
export const FORGO_TRADE = { ForgoTrainTrade: { game_id: 1 } };
export const FORGO_PRIVATE = { ForgoPrivateFunding: { game_id: 1 } };
export const OFFER = (privateId: number, buyer: number, price: number) => ({ OfferPrivateForFunding: { game_id: 1, private_id: privateId, buyer_protocol_id: buyer, price } });
export const ANSWER = (privateId: number, accept: boolean) => ({ AnswerFundingPrivateOffer: { game_id: 1, private_id: privateId, accept } });
export const TRADE = (seller: number, buyer: number, model: string, price: number) => ({ BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: buyer, seller_protocol_id: seller, model_type: model, price: String(price) } });
export const PROPOSE_TRAIN = (seller: number, buyer: number, model: string, price: number) =>
  ({ ProposeTrainPurchase: { game_id: 1, seller_protocol_id: seller, seller_ticker: TICKER[seller], seller_president: null, buyer_protocol_id: buyer, buyer_ticker: TICKER[buyer], model_type: model, price: String(price) } });
export const BUY = (id: number, source: "Ipo" | "Bank") => ({ BuyStock: { game_id: 1, protocol_id: id, source } });
export const SELL = (id: number, percentage = 10) => ({ SellStock: { game_id: 1, protocol_id: id, percentage } });
export const PROPOSE_PRIVATE = (privateId: number, seller: string, buyer: string, price: number) => ({ ProposePrivateTrade: { game_id: 1, private_id: privateId, seller, buyer, price } });
export const ANSWER_PRIVATE = (privateId: number, accept: boolean) => ({ AnswerPrivateTrade: { game_id: 1, private_id: privateId, accept } });
export const EXCHANGE_MH = (player: string, source: "Ipo" | "Bank" = "Ipo") => ({ ExchangePrivate: { game_id: 1, private_id: MH, company_id: NYC, player, source } });

/* ------------------------------------------------------------------ */
/* The room                                                            */
/* ------------------------------------------------------------------ */

export interface Step {
  label: string;
  actor: string;
  msg: unknown;
  expect?: "applied" | "refused";
}

export interface Played {
  label: string;
  actor: string;
  msg: unknown;
  kind: string;
  reason: string | null;
  entries: string[];
  before: Board;
  after: Board;
}

export function roomFor(seed: Board, grid: MapGridResponse, name: string): RoomSession {
  let minted = 0;
  return new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: grid, initialMarket: seed.market_positions as never },
    seed: { state: seed, waterfall: null },
    build: "v13-cert",
    mintId: () => `${name}-${(minted += 1)}`,
    now: () => 0,
    mintSeed: () => 1,
  });
}

export function submitStep(room: RoomSession, step: Step): Played {
  const before = room.state;
  const response = room.submit({ actor: step.actor, build: "v13-cert", msg: step.msg as never, baseIndex: room.nextIndex - 1 }) as {
    kind: string;
    reason?: string;
    entries?: ServerLogEntry[];
  };
  const kind = response.kind === "applied" ? "applied" : response.kind;
  const expect = step.expect ?? "applied";
  if (kind !== expect) throw new Error(`${step.label}: expected ${expect}, the room answered ${response.kind}${response.reason ? ` (${response.reason})` : ""}`);
  return {
    label: step.label,
    actor: step.actor,
    msg: step.msg,
    kind,
    reason: response.reason ?? null,
    entries: (response.entries ?? []).map((entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`),
    before,
    after: room.state,
  };
}

const operating = (state: Board): number | null =>
  state.current_round_type === "OperatingRound" ? (state.active_operating_order[state.active_corporation_index] ?? null) : null;

const ended = (room: RoomSession): boolean => room.state.current_round_type === "GameEnd";

/** Every remaining turn, played by the generic rule: a Stock Round seat passes; an operating corporation's president
 *  advances and, if the turn is still his, ends it. */
export function playToGameEnd(room: RoomSession, played: Played[]): void {
  for (let guard = 0; room.state.current_round_type !== "GameEnd"; guard += 1) {
    if (guard > 80) throw new Error("the room never reached GameEnd");
    const state = room.state;
    if (state.current_round_type === "StockRound") {
      played.push(submitStep(room, { label: `SR ${state.macro_round_number} seat passes`, actor: state.player_addresses[state.active_player_index], msg: PASS }));
      continue;
    }
    const id = operating(state);
    if (id === null) throw new Error(`unexpected round ${state.current_round_type}`);
    const president = state.public_companies.find((entry) => entry.company_id === id)!.president!;
    const turn = `${state.macro_round_number}.${state.sub_round_index} ${TICKER[id]}`;
    // At Buy Trains there is no step left to advance to: the turn is ended.
    if (state.operating_sub_phase !== "Hardware") played.push(submitStep(room, { label: `${turn} advances`, actor: president, msg: ADVANCE(id) }));
    if (!ended(room) && operating(room.state) === id) {
      played.push(submitStep(room, { label: `${turn} ends its turn`, actor: president, msg: PASS }));
    }
  }
}

/* ------------------------------------------------------------------ */
/* The vectors                                                         */
/* ------------------------------------------------------------------ */

export type TerminalReason = "BankBroken" | "Bankruptcy";

export interface VectorDef {
  id: string;
  name: string;
  /** The seed's name -- two logs from one seed share it (V13-07 / V13-21a, V13-20 A / B, the Stock Round seed). */
  seedName: string;
  seed: () => Board;
  grid: MapGridResponse;
  steps: Step[];
  /** After the scripted steps, play every remaining turn to the bank's ending. */
  continueToEnd: boolean;
  reason: TerminalReason;
  pins: string;
}

export interface VectorGame extends VectorDef {
  seedBoard: Board;
  played: Played[];
  entries: readonly ServerLogEntry[];
  terminal: Board;
  log_hash: string;
  room: RoomSession;
  at: (label: string) => Played;
}

export function playVector(def: VectorDef): VectorGame {
  const seedBoard = def.seed();
  const room = roomFor(seedBoard, def.grid, def.name);
  const played: Played[] = [];
  for (const step of def.steps) played.push(submitStep(room, step));
  if (def.continueToEnd) playToGameEnd(room, played);
  if (room.state.current_round_type !== "GameEnd") throw new Error(`${def.name}: the vector did not reach GameEnd`);
  const entries = [...room.entries];
  return {
    ...def,
    seedBoard,
    played,
    entries,
    terminal: room.state,
    log_hash: logHash(entries),
    room,
    at: (label) => {
      const hit = played.find((entry) => entry.label === label);
      if (!hit) throw new Error(`${def.name}: no step ${label}`);
      return hit;
    },
  };
}

/* Seeds */

/** The GR-4 start, standard 1830 at rules revision 2 (Gentle Rust off), bank $0 and latched broken. */
const syn01AtRevision2 = (): Board =>
  ({ ...GR.certificationStart(), variants: resolveVariants({ rules: 2 }), virtual_bank_vgp: "0", bank_broken: true }) as Board;

/** The Stock Round seed. */
const stockRoundSeed = (): Board =>
  v13Board({
    cash: { [P1]: 600, [P2]: 500, [P3]: 700 },
    bankBroken: true,
    corps: [
      { id: NYC, president: P2, holdings: [[P2, 50], [P1, 20], [P3, 10]], pool: 0, par: 100, price: 112, treasury: 900, trains: ["3"] },
      { id: PRR, president: P1, holdings: [[P1, 60], [P2, 20], [P3, 20]], par: 100, price: 100, treasury: 700, trains: ["3"] },
      { id: CPR, president: P3, holdings: [[P3, 60], [P1, 10], [P2, 10]], pool: 10, par: 90, price: 82, treasury: 600, trains: ["2"] },
      { id: CO, president: P3, holdings: [[P3, 40], [P2, 20]], pool: 30, par: 76, price: 30, treasury: 300, trains: ["2"] },
    ],
    privates: [{ id: SV, owner: P1 }, { id: CSL, owner: P2 }, { id: DH, owner: P3 }, { id: MH, owner: P1 }, { id: CA, owner: P2 }, { id: BOP, owner: P3, closed: true }],
    round: { kind: "SR", seat: 0, macro: 4 },
  });

/** An Operating Round obligation seed: C&O (station H16, the corridor) at Lay Track, trainless; the rest from `extra`. */
const orSeed = (spec: Omit<BoardSpec, "round"> & { order: number[]; step?: string }): Board =>
  v13Board({ ...spec, round: { kind: "OR", order: spec.order, active: CO, step: spec.step ?? "Track" } });

/** The six privates, all sold in the opening auction: the five player privates open with the owners named (in
 *  private-id order SV, C&StL, D&H, M&H, C&A), the B&O private closed (#660: the B&O bought a train). */
const privatesOwnedBy = (sv: string, csl: string, dh: string, mh: string, ca: string) => [
  { id: SV, owner: sv },
  { id: CSL, owner: csl },
  { id: DH, owner: dh },
  { id: MH, owner: mh },
  { id: CA, owner: ca },
  { id: BOP, owner: P3, closed: true },
];

const C_O_TRACK = (label = "C&O passes on track; the room walks it to Buy Trains"): Step => ({ label, actor: P1, msg: ADVANCE(CO) });

/* Seeds shared by two logs. */

/** V13-07: C&O $20 short; NYC (P1 presides) holds a 2-train within the $60 budget; nothing P1 holds is saleable. */
const forgoTradeSeed = (): Board =>
  orSeed({
    cash: { [P1]: 30, [P2]: 300, [P3]: 300 },
    bankBroken: true,
    order: [CO, NYC, PRR],
    corps: [
      { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 90, price: 90, treasury: 30, station: "H16" },
      { id: NYC, president: P1, holdings: [[P1, 20], [P2, 10], [P3, 10]], par: 76, price: 76, treasury: 100, trains: ["2"] },
      { id: PRR, president: P3, holdings: [[P3, 40], [P2, 20]], par: 67, price: 67, treasury: 200 },
    ],
    privates: privatesOwnedBy(P1, P2, P3, P2, P3),
  });

/** V13-21: the same obligation with a saleable PRR 10% beside it -- the window, or the Bank after a liquidation. */
const tradeWindowSeed = (): Board =>
  orSeed({
    cash: { [P1]: 30, [P2]: 300, [P3]: 300 },
    bankBroken: true,
    order: [CO, NYC, PRR],
    corps: [
      { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 90, price: 90, treasury: 30, station: "H16" },
      { id: NYC, president: P1, holdings: [[P1, 20], [P2, 10], [P3, 10]], par: 76, price: 76, treasury: 100, trains: ["2"] },
      { id: PRR, president: P3, holdings: [[P3, 40], [P2, 20], [P1, 10]], par: 67, price: 50, treasury: 200 },
    ],
    privates: privatesOwnedBy(P2, P1, P3, P3, P2),
  });

/** V13-20: $50 short; P1 holds PRR 10% at $100 and NYC 10% at $60 -- each one legal card that funds alone. */
const overshootSeed = (): Board =>
  orSeed({
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    bankBroken: true,
    order: [PRR, CO, NYC],
    corps: [
      { id: PRR, president: P3, holdings: [[P3, 40], [P2, 10], [P1, 10]], par: 100, price: 100, treasury: 300 },
      { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 90, price: 90, treasury: 30, station: "H16" },
      { id: NYC, president: P2, holdings: [[P2, 40], [P3, 10], [P1, 10]], par: 67, price: 60, treasury: 300 },
    ],
    privates: privatesOwnedBy(P3, P2, P1, P2, P3),
  });

/** Phase 3 private-funding seeds: NYC owns the 3 (the 3-train costs $180); C&O and P1 have $0; P1's only paper is
 *  C&O's tied crown, so a share portfolio raises nothing (or `prr10` adds a saleable PRR 10% at $50). */
const privateSeed = (input: { owners: [string, string, string, string, string]; nyc: number; prr: number; prr10?: boolean; bankBroken?: boolean }): Board =>
  orSeed({
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    bankBroken: input.bankBroken,
    order: [NYC, PRR, CO],
    corps: [
      { id: NYC, president: P2, holdings: [[P2, 40], [P3, 20]], par: 100, price: 100, treasury: input.nyc, trains: ["3"] },
      { id: PRR, president: P3, holdings: input.prr10 ? [[P3, 40], [P2, 20], [P1, 10]] : [[P3, 40], [P2, 20]], par: 67, price: 50, treasury: input.prr },
      { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 82, price: 40, treasury: 0, station: "H16" },
    ],
    privates: privatesOwnedBy(...input.owners),
  });

export function v13VectorDefs(): VectorDef[] {
  return [
    {
      id: "V13-01",
      name: "V13-01-ORDINARY-BANK-BREAK",
      seedName: "syn01-revision-2",
      seed: syn01AtRevision2,
      grid: GR.EMPTY_GRID,
      steps: [],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "The v12 formula carries over unchanged.",
    },
    {
      id: "V13-02",
      name: "V13-02-PASSTURN-BROWN-ALLPASS-BANK-BREAK",
      seedName: "stock-round",
      seed: stockRoundSeed,
      grid: ALBANY,
      steps: [
        { label: "P1 buys C&O from the Bank Pool (Brown: the continuation opens)", actor: P1, msg: BUY(CO, "Bank") },
        { label: "P1's Pool CPR is refused (one corporation only)", actor: P1, msg: BUY(CPR, "Bank"), expect: "refused" },
        { label: "P1 buys C&O from the Bank Pool again (the continuation)", actor: P1, msg: BUY(CO, "Bank") },
        { label: "P1 ends his acted turn with one PassTurn", actor: P1, msg: PASS },
        { label: "P2 passes (a true pass)", actor: P2, msg: PASS },
        { label: "P3 sells NYC 10%", actor: P3, msg: SELL(NYC, 10) },
        { label: "P3 ends his acted turn with one PassTurn", actor: P3, msg: PASS },
        { label: "P1 passes (1)", actor: P1, msg: PASS },
        { label: "P2 passes (2)", actor: P2, msg: PASS },
        { label: "P3 passes (3): all pass, the Stock Round ends", actor: P3, msg: PASS },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "Path-only changes leave valuation alone.",
    },
    {
      id: "V13-03",
      name: "V13-03-FULL-LIQUIDATION",
      seedName: "full-liquidation",
      seed: () =>
        orSeed({
          cash: { [P1]: 0, [P2]: 400, [P3]: 350 },
          order: [NYC, PRR, CO],
          corps: [
            { id: NYC, president: P2, holdings: [[P2, 50], [P1, 10], [P3, 10]], par: 76, price: 50, treasury: 300, trains: ["3"] },
            { id: PRR, president: P3, holdings: [[P3, 50], [P1, 10], [P2, 10]], par: 67, price: 50, treasury: 250, trains: ["3"] },
            { id: CO, president: P1, holdings: [[P1, 30], [P2, 20], [P3, 10]], par: 67, price: 60, treasury: 0, station: "H16" },
          ],
          privates: privatesOwnedBy(P2, P3, P2, P3, P2),
        }),
      grid: CORRIDOR,
      steps: [C_O_TRACK()],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "Cash 0 and privates 0 for the bankrupt; the obligated treasury is credited; rival prices after the drops.",
    },
    {
      id: "V13-04",
      name: "V13-04-PRESIDENCY-LOCKED-RESIDUE",
      seedName: "presidency-locked",
      seed: () =>
        orSeed({
          cash: { [P1]: 0, [P2]: 400, [P3]: 350 },
          order: [NYC, PRR, CO],
          corps: [
            { id: NYC, president: P2, holdings: [[P2, 50], [P1, 10], [P3, 10]], par: 76, price: 50, treasury: 300, trains: ["3"] },
            { id: PRR, president: P1, holdings: [[P1, 40], [P2, 10], [P3, 10]], par: 67, price: 60, treasury: 200 },
            { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 76, price: 71, treasury: 0, station: "H16" },
          ],
          privates: privatesOwnedBy(P3, P2, P3, P2, P3),
        }),
      grid: CORRIDOR,
      steps: [C_O_TRACK()],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "The kept shares count in the share term (O-6).",
    },
    {
      id: "V13-05",
      name: "V13-05-BANK-POOL-CAP-RESIDUE",
      seedName: "pool-cap",
      seed: () =>
        orSeed({
          cash: { [P1]: 0, [P2]: 400, [P3]: 350 },
          order: [NYC, CPR, CO],
          corps: [
            { id: NYC, president: P2, holdings: [[P2, 30], [P1, 30]], pool: 40, par: 76, price: 40, treasury: 300, trains: ["3"] },
            { id: CPR, president: P3, holdings: [[P3, 60], [P1, 10]], par: 67, price: 45, treasury: 300 },
            { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 82, price: 76, treasury: 0, station: "H16" },
          ],
          privates: privatesOwnedBy(P2, P2, P3, P3, P2),
        }),
      grid: CORRIDOR,
      steps: [C_O_TRACK()],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "The cap is respected in liquidation; the remainder is kept and valued.",
    },
    {
      id: "V13-06",
      name: "V13-06-NO-SALEABLE-SHARE",
      seedName: "no-saleable-share",
      seed: () =>
        orSeed({
          cash: { [P1]: 40, [P2]: 400, [P3]: 350 },
          order: [PRR, CO, NYC],
          corps: [
            { id: PRR, president: P1, holdings: [[P1, 20], [P2, 10], [P3, 10]], par: 100, price: 100, treasury: 400 },
            { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 90, price: 90, treasury: 0, station: "H16" },
            { id: NYC, president: P2, holdings: [[P2, 40], [P3, 20]], par: 67, price: 67, treasury: 300 },
          ],
          privates: privatesOwnedBy(P1, P2, P1, P3, P2),
        }),
      grid: CORRIDOR,
      steps: [C_O_TRACK()],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "The terminal portfolio is untouched; only the cash moves.",
    },
    {
      id: "V13-07",
      name: "V13-07-FORGO-TRAIN-TRADE",
      seedName: "forgo-trade",
      seed: forgoTradeSeed,
      grid: CORRIDOR,
      steps: [
        C_O_TRACK("C&O passes on track; the room walks it to Buy Trains and the trade window holds the game"),
        { label: "a $61 trade (beyond treasury + cash) is refused", actor: P1, msg: TRADE(NYC, CO, "2", 61), expect: "refused" },
        { label: "P1 forgoes the train trade: nothing else can rescue, the bankruptcy follows", actor: P1, msg: FORGO_TRADE },
      ],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "The window decision is replayed exactly; no trade-funded terminal.",
    },
    {
      id: "V13-08",
      name: "V13-08-FORGO-PRIVATE-FUNDING",
      seedName: "forgo-private",
      seed: () => privateSeed({ owners: [P2, P3, P2, P3, P1], nyc: 500, prr: 30 }),
      grid: CORRIDOR,
      steps: [
        C_O_TRACK("C&O passes on track; a legal private sale holds the game at Buy Trains"),
        { label: "P1 forgoes private funding: the bankruptcy follows", actor: P1, msg: FORGO_PRIVATE },
      ],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "The bankrupt's privates count 0.",
    },
    {
      id: "V13-09",
      name: "V13-09-IRRELEVANT-PRIVATE-IMMEDIATE",
      seedName: "irrelevant-private",
      seed: () => privateSeed({ owners: [P1, P1, P2, P3, P2], nyc: 500, prr: 30 }),
      grid: CORRIDOR,
      steps: [C_O_TRACK()],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "Face value excluded for the bankrupt only; other players' privates counted.",
    },
    {
      id: "V13-10",
      name: "V13-10-PORTFOLIO-RESCUE-THEN-BANK-BREAK",
      seedName: "portfolio-rescue",
      seed: () =>
        orSeed({
          cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
          bankBroken: true,
          order: [CO, PRR, NYC],
          corps: [
            { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 90, price: 90, treasury: 0, station: "H16" },
            { id: PRR, president: P3, holdings: [[P3, 40], [P2, 10], [P1, 10]], par: 67, price: 50, treasury: 300 },
            { id: NYC, president: P2, holdings: [[P2, 30], [P3, 20], [P1, 10]], par: 67, price: 40, treasury: 300 },
          ],
          privates: privatesOwnedBy(P1, P2, P3, P1, P2),
        }),
      grid: CORRIDOR,
      steps: [
        C_O_TRACK(),
        { label: "P1 sells NYC 10% + PRR 10% in one portfolio ($90 for $80: the smallest legal overshoot)", actor: P1, msg: PORTFOLIO([NYC, 10], [PRR, 10]) },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "The rescue terminal is an ordinary terminal; the overshoot cash is counted.",
    },
    {
      id: "V13-11",
      name: "V13-11-AUTOMATIC-PURCHASE-KEYED",
      seedName: "funded-window",
      seed: () =>
        orSeed({
          cash: { [P1]: 100, [P2]: 300, [P3]: 300 },
          bankBroken: true,
          order: [CO, NYC, PRR],
          corps: [
            { id: CO, president: P1, holdings: [[P1, 30], [P2, 20], [P3, 10]], par: 90, price: 90, treasury: 30, station: "H16" },
            { id: NYC, president: P2, holdings: [[P2, 40], [P1, 20]], par: 76, price: 76, treasury: 300, trains: ["2"] },
            { id: PRR, president: P3, holdings: [[P3, 40], [P2, 20]], par: 67, price: 67, treasury: 300 },
          ],
          privates: privatesOwnedBy(P2, P1, P3, P2, P1),
        }),
      grid: CORRIDOR,
      steps: [
        C_O_TRACK("C&O passes on track; treasury + cash cover the train, the trade window holds the game"),
        { label: "P1 forgoes the trade: the game buys the Bank's train itself", actor: P1, msg: FORGO_TRADE },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "Derived entries replay identically; no duplicate purchase.",
    },
    {
      id: "V13-12a",
      name: "V13-12a-TIE-AT-THE-TOP-WITH-THE-BANKRUPT",
      seedName: "tie-bankrupt",
      seed: () =>
        orSeed({
          cash: { [P1]: 40, [P2]: 0, [P3]: 50 },
          order: [PRR, CO, NYC],
          corps: [
            { id: PRR, president: P1, holdings: [[P1, 20], [P2, 10], [P3, 10]], par: 100, price: 100, treasury: 400 },
            { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 90, price: 90, treasury: 0, station: "H16" },
            { id: NYC, president: P2, holdings: [[P2, 20], [P3, 10]], par: 67, price: 40, treasury: 300 },
          ],
          privates: privatesOwnedBy(P2, P1, P1, P1, P1),
        }),
      grid: CORRIDOR,
      steps: [C_O_TRACK()],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "The tie rule is unchanged under bankruptcy: the bankrupt and P2 share the top, with equal weights and equal payouts.",
    },
    {
      id: "V13-12b",
      name: "V13-12b-TIE-AT-THE-TOP-FOUR-SEATS",
      seedName: "tie-four-seats",
      seed: () =>
        v13Board({
          players: [P1, P2, P3, "p4"],
          cash: { [P1]: 200, [P2]: 300, [P3]: 300, p4: 150 },
          bankBroken: true,
          corps: [
            { id: NYC, president: P2, holdings: [[P2, 30], [P3, 30], [P1, 10]], par: 100, price: 100, treasury: 500, trains: ["2"] },
            { id: PRR, president: P1, holdings: [[P1, 30], [P2, 20], [P3, 20]], par: 76, price: 76, treasury: 400, trains: ["2"] },
          ],
          privates: [{ id: SV, owner: P2 }, { id: CSL, owner: P1 }, { id: DH, owner: P3 }, { id: MH, owner: P3 }, { id: CA, owner: P2 }, { id: BOP, owner: "p4", closed: true }],
          round: { kind: "OR", order: [NYC, PRR], active: NYC, step: "Track" },
        }),
      grid: ALBANY,
      steps: [],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "Two non-bankrupt seats tie at the top of a four-seat bank break: equal weights, equal payouts, a shared first rank.",
    },
    {
      id: "V13-15",
      name: "V13-15-MAXIMAL-MIXED-LIQUIDATION",
      seedName: "mixed-liquidation",
      seed: () =>
        orSeed({
          cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
          order: [NYC, CPR, PRR, CO],
          corps: [
            { id: PRR, president: P1, holdings: [[P1, 20], [P3, 10], [P2, 10]], par: 67, price: 50, treasury: 500 },
            { id: NYC, president: P2, holdings: [[P2, 30], [P1, 30]], pool: 30, par: 76, price: 40, treasury: 500, trains: ["3"] },
            { id: CPR, president: P3, holdings: [[P3, 60], [P1, 20]], par: 67, price: 30, treasury: 500 },
            { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 90, price: 90, treasury: 0, station: "H16" },
          ],
          privates: privatesOwnedBy(P2, P3, P2, P3, P2),
        }),
      grid: CORRIDOR,
      steps: [C_O_TRACK()],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "The exact maximumLiquidation, in public_companies order; every dollar to the obligated treasury; the residue valued.",
    },
    {
      id: "V13-16a",
      name: "V13-16a-LOOSE-BOUND-ONLY-ENDS-AT-ONCE",
      seedName: "private-bound-only",
      seed: () => privateSeed({ owners: [P2, P3, P1, P1, P2], nyc: 150, prr: 30, bankBroken: true }),
      grid: CORRIDOR,
      steps: [C_O_TRACK()],
      continueToEnd: false,
      reason: "Bankruptcy",
      pins: "Only exact legal possibility holds the game: one buyer cannot pay for the two privates the loose bound counts, so the game ends at once.",
    },
    {
      id: "V13-16b",
      name: "V13-16b-LEGAL-PRIVATE-WAITS-THEN-RESCUES",
      seedName: "private-legal",
      seed: () => privateSeed({ owners: [P2, P3, P2, P3, P1], nyc: 500, prr: 30, bankBroken: true }),
      grid: CORRIDOR,
      steps: [
        C_O_TRACK("C&O passes on track; one legal private sale holds the game at Buy Trains"),
        { label: "P1 offers the C&A to NYC for $200", actor: P1, msg: OFFER(CA, NYC, 200) },
        { label: "NYC's president accepts: the sale settles and the game buys the train", actor: P2, msg: ANSWER(CA, true) },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "The game waits for a legal private path and then rescues; the terminal differs from 16a exactly there.",
    },
    {
      id: "V13-17a",
      name: "V13-17a-PRIVATE-THEN-PORTFOLIO",
      seedName: "private-then-portfolio",
      seed: () => privateSeed({ owners: [P2, P3, P1, P2, P3], nyc: 500, prr: 300, prr10: true, bankBroken: true }),
      grid: CORRIDOR,
      steps: [
        C_O_TRACK("C&O passes on track; a private sale plus a portfolio could rescue"),
        { label: "P1 offers the D&H to NYC for $140", actor: P1, msg: OFFER(DH, NYC, 140) },
        { label: "NYC's president accepts ($40 still short)", actor: P2, msg: ANSWER(DH, true) },
        { label: "P1 sells PRR 10% in one portfolio: the game buys the train", actor: P1, msg: PORTFOLIO([PRR, 10]) },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "The sequence replays identically; the buyer's treasury and the private's corporate owner on the terminal board.",
    },
    {
      id: "V13-17b",
      name: "V13-17b-TWO-PRIVATES-TWO-BUYERS",
      seedName: "two-privates-two-buyers",
      seed: () => privateSeed({ owners: [P2, P3, P1, P1, P2], nyc: 100, prr: 100, bankBroken: true }),
      grid: CORRIDOR,
      steps: [
        C_O_TRACK("C&O passes on track; two private sales to two buyers could rescue"),
        { label: "P1 offers the M&H to NYC for $100", actor: P1, msg: OFFER(MH, NYC, 100) },
        { label: "NYC's president accepts ($80 still short)", actor: P2, msg: ANSWER(MH, true) },
        { label: "P1 offers the D&H to PRR for $80", actor: P1, msg: OFFER(DH, PRR, 80) },
        { label: "PRR's president accepts: the game buys the train", actor: P3, msg: ANSWER(DH, true) },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "Two buyer treasuries and two corporate owners on the terminal board; the sequence replays identically.",
    },
    {
      id: "V13-18a",
      name: "V13-18a-BROWN-INTERRUPTED-BY-PRIVATE-TRADE",
      seedName: "stock-round",
      seed: stockRoundSeed,
      grid: ALBANY,
      steps: [
        { label: "P1 buys C&O from the Bank Pool (Brown: the continuation opens)", actor: P1, msg: BUY(CO, "Bank") },
        { label: "P1 proposes the Schuylkill Valley to P2 for $30", actor: P1, msg: PROPOSE_PRIVATE(SV, P1, P2, 30) },
        { label: "P2 rejects off-turn (the purchase stays open)", actor: P2, msg: ANSWER_PRIVATE(SV, false) },
        { label: "P1 buys C&O from the Bank Pool again (the continuation survived)", actor: P1, msg: BUY(CO, "Bank") },
        { label: "P1 proposes the Schuylkill Valley to P2 again", actor: P1, msg: PROPOSE_PRIVATE(SV, P1, P2, 30) },
        { label: "P2 accepts: P1's accepted trade closes the continuation", actor: P2, msg: ANSWER_PRIVATE(SV, true) },
        { label: "P1's third Pool C&O is refused at the interruption", actor: P1, msg: BUY(CO, "Bank"), expect: "refused" },
        { label: "P1 ends his turn with one PassTurn", actor: P1, msg: PASS },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "The second Pool purchase after the accepted trade is refused; the off-turn rejection did not interrupt.",
    },
    {
      id: "V13-18b",
      name: "V13-18b-BROWN-INTERRUPTED-BY-MH-EXCHANGE",
      seedName: "stock-round",
      seed: stockRoundSeed,
      grid: ALBANY,
      steps: [
        { label: "P1 buys C&O from the Bank Pool (Brown: the continuation opens)", actor: P1, msg: BUY(CO, "Bank") },
        { label: "P1 exchanges the M&H for an NYC 10% from the IPO (closes the continuation)", actor: P1, msg: EXCHANGE_MH(P1, "Ipo") },
        { label: "P1's second Pool C&O is refused at the interruption", actor: P1, msg: BUY(CO, "Bank"), expect: "refused" },
        { label: "P1 ends his turn with one PassTurn", actor: P1, msg: PASS },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "The second Pool purchase after the M&H exchange is refused.",
    },
    {
      id: "V13-19",
      name: "V13-19-MULTI-CORPORATION-PORTFOLIO-PRESIDENCY-CHANGE",
      seedName: "multi-corporation-portfolio",
      seed: () =>
        orSeed({
          cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
          bankBroken: true,
          order: [NYC, CO, PRR, CPR],
          corps: [
            { id: NYC, president: P1, holdings: [[P1, 30], [P2, 20], [P3, 10]], par: 67, price: 60, treasury: 300 },
            { id: CO, president: P1, holdings: [[P1, 20], [P2, 20], [P3, 20]], par: 67, price: 50, treasury: 0, station: "H16" },
            { id: PRR, president: P3, holdings: [[P3, 40], [P2, 10], [P1, 10]], par: 67, price: 45, treasury: 300 },
            { id: CPR, president: P3, holdings: [[P3, 50], [P1, 10]], par: 67, price: 30, treasury: 300, trains: ["3"] },
          ],
          privates: privatesOwnedBy(P2, P3, P2, P3, P2),
        }),
      grid: CORRIDOR,
      steps: [
        C_O_TRACK(),
        { label: "P1 sells PRR 10%, NYC 20% and CPR 10% in that order (NYC's presidency passes to P2)", actor: P1, msg: PORTFOLIO([PRR, 10], [NYC, 20], [CPR, 10]) },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "One entry, today's prices per leg, the presidency where the ordinary sale puts it.",
    },
    {
      id: "V13-20a",
      name: "V13-20a-OVERSHOOT-BY-THE-100-CARD",
      seedName: "overshoot-choice",
      seed: overshootSeed,
      grid: CORRIDOR,
      steps: [C_O_TRACK(), { label: "P1 sells PRR 10% ($100 for $50)", actor: P1, msg: PORTFOLIO([PRR, 10]) }],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "Both overshoot choices are legal (owner ruling 1): this is the $100 card's terminal.",
    },
    {
      id: "V13-20b",
      name: "V13-20b-OVERSHOOT-BY-THE-60-CARD",
      seedName: "overshoot-choice",
      seed: overshootSeed,
      grid: CORRIDOR,
      steps: [C_O_TRACK(), { label: "P1 sells NYC 10% ($60 for $50)", actor: P1, msg: PORTFOLIO([NYC, 10]) }],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "Both overshoot choices are legal (owner ruling 1): this is the $60 card's terminal.",
    },
    {
      id: "V13-21a",
      name: "V13-21a-TRADE-INSIDE-THE-WINDOW",
      seedName: "trade-window",
      seed: tradeWindowSeed,
      grid: CORRIDOR,
      steps: [
        C_O_TRACK("C&O passes on track; the trade window holds the game"),
        { label: "C&O buys NYC's 2-train for $60 inside the window (treasury $30, then P1's $30)", actor: P1, msg: TRADE(NYC, CO, "2", 60) },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "The window-funded trade terminal.",
    },
    {
      id: "V13-21b",
      name: "V13-21b-WINDOW-CLOSED-BY-LIQUIDATION",
      seedName: "trade-window",
      seed: tradeWindowSeed,
      grid: CORRIDOR,
      steps: [
        C_O_TRACK("C&O passes on track; the trade window holds the game"),
        { label: "P1 sells PRR 10% instead: the window closes and the game buys the Bank's train", actor: P1, msg: PORTFOLIO([PRR, 10]) },
      ],
      continueToEnd: true,
      reason: "BankBroken",
      pins: "No liquidation-funded trade terminal exists: after the sale the only purchase is the Bank's.",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Playing the vectors (once per test file)                            */
/* ------------------------------------------------------------------ */

let cache: readonly VectorGame[] | null = null;

/** Every vector game, played once per test file. Callers must not mutate the boards. */
export function v13Vectors(): readonly VectorGame[] {
  if (cache) return cache;
  cache = v13VectorDefs().map(playVector);
  return cache;
}

/* ------------------------------------------------------------------ */
/* Determinism: one log, five readers (V13-13)                         */
/* ------------------------------------------------------------------ */

export interface DeterminismEvidence {
  /** `terminal_state_hash_v1` of the live room's board (every entry applied by `RoomEngine.apply` as it was made). */
  live: string;
  /** A fresh room's cold restore of the stored log (`RoomSession.restore` -> rebuild). */
  restore: string;
  /** The batch replay of the stored log (`replayLog`, the server's replay policy). */
  replay: string;
  /** A `RoomEngine` seeded with the board, grid and chart after entry `snapshot_after`, fed the rest of the log. */
  snapshot: string;
  snapshot_after: number;
  /** The RevertTo variant: `live` -- a live room undid the last non-terminal player action and played it again;
   *  `log` -- the vector's only player action ends the game (a room refuses a revert after GameEnd, RV-3), so the
   *  stored log carries the revert entry and the re-played entries, and a cold restore resolves them. */
  revert: { kind: "live" | "log"; reverted_index: number; log_len: number; terminal: string; restored: string; reverted_board: string };
}

const replayProvidersFor = (game: VectorGame) => ({ ...sandboxReplayProviders(), initialGrid: game.grid, initialMarket: game.seedBoard.market_positions as never });

export function restoredBoard(game: VectorGame, entries: readonly ServerLogEntry[] = game.entries): Board {
  const room = roomFor(game.seedBoard, game.grid, `${game.name}-restore`);
  room.restore(entries);
  if (room.incompatible !== null) throw new Error(`${game.name}: the restore was held: ${room.incompatible.reason}`);
  return room.state;
}

export function replayedBoard(game: VectorGame, entries: readonly ServerLogEntry[] = game.entries): Board {
  return replayLog(entries, replayProvidersFor(game), { state: game.seedBoard, waterfall: null }, undefined, SERVER_REPLAY_POLICY).state;
}

/** The board after the first `after` entries, then a `RoomEngine` seeded with exactly that snapshot (board, grid,
 *  chart, auction atom) applying the rest. */
export function snapshotRebuiltBoard(game: VectorGame, after: number): Board {
  const head = new RoomEngine(replayProvidersFor(game), { state: game.seedBoard, waterfall: null });
  for (const entry of game.entries.slice(0, after)) head.apply(entry);
  const snap = head.snapshot;
  const tail = new RoomEngine({ ...sandboxReplayProviders(), initialGrid: snap.grid, initialMarket: snap.state.market_positions as never }, { state: snap.state, waterfall: snap.waterfall });
  for (const entry of game.entries.slice(after)) tail.apply(entry);
  return tail.snapshot.state;
}

const REVERT = (index: number, player: string) => ({ RevertTo: { index, player, summary: "undo" } });

/** The RevertTo variant of a vector (see `DeterminismEvidence.revert`). */
export function revertVariant(game: VectorGame): { kind: "live" | "log"; reverted_index: number; entries: readonly ServerLogEntry[]; terminal: Board; reverted: Board } {
  const applied = game.played.filter((step) => step.kind === "applied");
  // The last applied player step after which the game had not ended: undone live, then made again.
  let k = -1;
  for (let at = applied.length - 1; at >= 0; at -= 1) {
    if (applied[at].after.current_round_type !== "GameEnd") {
      k = at;
      break;
    }
  }
  if (k >= 0) {
    const room = roomFor(game.seedBoard, game.grid, `${game.name}-revert`);
    for (let at = 0; at <= k; at += 1) submitStep(room, { label: applied[at].label, actor: applied[at].actor, msg: applied[at].msg });
    // The undone action is the last non-derived entry: the one step k appended first.
    const target = [...room.entries].reverse().find((entry) => entry.derived !== true)!;
    const reverted = submitStep(room, { label: "revert", actor: applied[k].actor, msg: REVERT(target.index, applied[k].actor) });
    void reverted;
    const atRevert = room.state;
    for (let at = k; at < applied.length; at += 1) submitStep(room, { label: applied[at].label, actor: applied[at].actor, msg: applied[at].msg });
    if (room.state.current_round_type !== "GameEnd") throw new Error(`${game.name}: the revert variant did not reach GameEnd`);
    return { kind: "live", reverted_index: target.index, entries: [...room.entries], terminal: room.state, reverted: atRevert };
  }
  // The only player action ends the game: the stored log carries a revert of it and then the same entries again.
  const first = game.entries.find((entry) => entry.derived !== true)!;
  const actor = first.actor;
  const n = game.entries.length;
  const withRevert: ServerLogEntry[] = [
    ...game.entries,
    { index: n, id: `${game.name}-revert`, actor, payload: JSON.stringify(REVERT(first.index, actor)) },
    ...game.entries.map((entry, at) => ({ ...entry, index: n + 1 + at, id: `${entry.id}-again` })),
  ];
  const revertedOnly = withRevert.slice(0, n + 1);
  return { kind: "log", reverted_index: first.index, entries: withRevert, terminal: restoredBoard(game, withRevert), reverted: restoredBoard(game, revertedOnly) };
}

export function determinismOf(game: VectorGame): DeterminismEvidence {
  const after = Math.max(1, Math.floor(game.entries.length / 2));
  const revert = revertVariant(game);
  return {
    live: terminalStateHashV1(game.terminal),
    restore: terminalStateHashV1(restoredBoard(game)),
    replay: terminalStateHashV1(replayedBoard(game)),
    snapshot: terminalStateHashV1(snapshotRebuiltBoard(game, after)),
    snapshot_after: after,
    revert: {
      kind: revert.kind,
      reverted_index: revert.reverted_index,
      log_len: revert.entries.length,
      terminal: terminalStateHashV1(revert.terminal),
      restored: terminalStateHashV1(restoredBoard(game, revert.entries)),
      reverted_board: terminalStateHashV1(revert.reverted),
    },
  };
}

/* ------------------------------------------------------------------ */
/* V13-11: the derived purchase across a crash                          */
/* ------------------------------------------------------------------ */

/** A server that died after appending entry `cut - 1` comes back with `entries[0, cut)`, restores, and then receives the
 *  next player message the straight game received. Returns the room it ends with. */
export function crashRestart(game: VectorGame, cut: number): RoomSession {
  const room = roomFor(game.seedBoard, game.grid, `${game.name}-crash-${cut}`);
  room.restore(game.entries.slice(0, cut));
  // The player steps still to come: those whose own entry lies at or after the cut, in order.
  const kinds = game.entries.map((entry) => entry.derived === true);
  let seen = 0;
  const pending: Played[] = [];
  for (const step of game.played) {
    if (step.kind !== "applied") continue;
    // The step's own (non-derived) entry is the `seen`-th non-derived entry of the log.
    let position = -1;
    for (let at = 0, count = 0; at < kinds.length; at += 1) {
      if (kinds[at]) continue;
      if (count === seen) {
        position = at;
        break;
      }
      count += 1;
    }
    seen += 1;
    if (position >= cut) pending.push(step);
  }
  for (const step of pending) submitStep(room, { label: step.label, actor: step.actor, msg: step.msg });
  return room;
}

/* ------------------------------------------------------------------ */
/* The board the bankruptcy was proved on                              */
/* ------------------------------------------------------------------ */

/** The board as the engine stood when it proved the bankruptcy: every entry but the last applied by `RoomEngine.apply`,
 *  then the last (the one whose transition ended the game) applied by the same reducer with the same context, with the
 *  bankruptcy settle withheld (`emergencySaleLeg`: for any message but a `SellStock` leg its ONLY effect is that
 *  `settleBankruptcy` does not run). So the obligation stands on this board exactly as `automaticBankruptcy` read it --
 *  its `rescueAnalysis` is the liquidation the reducer then executed. A probe, never a log path. */
export function bankruptcyProofBoard(game: VectorGame): { board: Board; grid: MapGridResponse } {
  const providers = replayProvidersFor(game);
  const engine = new RoomEngine(providers, { state: game.seedBoard, waterfall: null });
  for (const entry of game.entries.slice(0, -1)) engine.apply(entry);
  const last = game.entries[game.entries.length - 1];
  const { state, grid } = engine.snapshot;
  const msg = JSON.parse(last.payload) as never;
  const board = withRules(
    resolveVariants(state.variants),
    () => applySandboxAction(state, msg, { ...sandboxActionContext(providers, { state, msg, actor: last.actor, grid, gridBefore: grid }), emergencySaleLeg: true }),
    routeRulesRevisionOf(state),
  );
  return { board, grid };
}

/** The board after the first `count` entries of a vector's log (a `RoomEngine` applying them). */
export function boardAfter(game: VectorGame, count: number): { board: Board; grid: MapGridResponse } {
  const engine = new RoomEngine(replayProvidersFor(game), { state: game.seedBoard, waterfall: null });
  for (const entry of game.entries.slice(0, count)) engine.apply(entry);
  return { board: engine.snapshot.state, grid: engine.snapshot.grid };
}
