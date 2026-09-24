// frontend/src/utils/gentleRustPresentationSupport.ts
//
// TEST SUPPORT ONLY for GR-3 (design note #1702): `gentleRustPresentation.test.ts` (the engine half: timing,
// warnings, narration, screens) and `components/gentleRustPresentation.test.tsx` (the rendered half). Nothing in the
// app imports this.
//
// THE BOARDS ARE GR-1 / GR-2 / DT-1's: legal pinned v8 Operating Rounds, the depot derived from the fleets, a
// station token on each corporation's home hex so no home station is owed, a chart, both train lists always
// reported (#232). Every Gentle Rust mark a case relies on is written by a real phase-changing purchase dispatched
// through `applySandboxAction` with the acting president as the actor -- never by hand -- and a refusal is judged by
// digest (S10-1: a board with a chart comes back as a new object even when nothing moved).

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withRules } from "../gameEngine/boardSelection";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { stateDigest } from "../gameEngine/stateDigest";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { depotInventory, derivePhase } from "../gameEngine/gamePhase";
import { pendingTrainDiscards } from "../gameEngine/trainDiscard";

export const PRR = 1;
export const NYC = 2;
export const BO = 4;
export const CO = 5;
export const P1 = "p1";
export const P2 = "p2";
export const P3 = "p3";

const TICKER: Record<number, string> = { [PRR]: "PRR", [NYC]: "NYC", [BO]: "B&O", [CO]: "C&O" };
/** P1 presides over PRR and C&O -- the same-president sale that settles on the spot (#1592). */
const PRESIDENT: Record<number, string> = { [PRR]: P1, [NYC]: P2, [BO]: P3, [CO]: P1 };
const HOME: Record<number, string> = { [PRR]: "H6", [NYC]: "I9", [BO]: "J6", [CO]: "I5" };
const PRICE: Record<number, number> = { [PRR]: 100, [NYC]: 90, [BO]: 80, [CO]: 70 };

function at(label: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  return { q: hex.q, r: hex.r };
}

export interface Corp {
  id: number;
  trains: string[];
  treasury?: string;
}

/** A legal pinned Operating Round: the listed corporations operate in the listed order, `operating` is on `step`
 *  (Buy Trains by default), round `sub` of a set of `length`. Gentle Rust only when `gentle`; the Level Playing
 *  Field only when `lpf` (its map rebinds the hex table, so the home LABEL is dropped and the token kept). */
export function board(input: {
  corps: Corp[];
  operating: number;
  step?: string;
  sub?: number;
  length?: number;
  gentle?: boolean;
  lpf?: boolean;
  returned?: string[];
}): GameStateResponse {
  const order = input.corps.map((entry) => entry.id);
  return {
    game_id: 1,
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "12000",
    private_companies: [],
    variants: resolveVariants({
      ...(input.gentle ? { gentleRust: true } : {}),
      ...(input.lpf ? { levelPlayingField: true } : {}),
    }),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: input.sub ?? 1,
    operating_round_sequence_length: input.length ?? 2,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(input.operating),
    operating_sub_phase: input.step ?? "Hardware",
    rules_engine_version: RULES_ENGINE_VERSION,
    returned_trains: input.returned ?? [],
    market_positions: Object.fromEntries(
      input.corps.map((entry, index) => [entry.id, { price: PRICE[entry.id], x: 5 + index, y: 4, enteredAt: index + 1 }]),
    ),
    public_companies: input.corps.map((entry) => ({
      company_id: entry.id,
      ticker: TICKER[entry.id],
      is_floated: true,
      president: PRESIDENT[entry.id],
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: entry.treasury ?? "3000",
      owned_trains: entry.trains,
      pending_rust_trains: [],
      player_holdings: [{ player: PRESIDENT[entry.id], percentage: 60 }],
      station_token_hexes: [[at(HOME[entry.id]).q, at(HOME[entry.id]).r]],
      station_tokens: [[at(HOME[entry.id]).q, at(HOME[entry.id]).r, 0]],
      station_token_limit: 3,
      home_hex_label: input.lpf ? null : HOME[entry.id],
    })),
  } as unknown as GameStateResponse;
}

export const company = (state: GameStateResponse, id: number): PublicCompanyState =>
  state.public_companies.find((entry) => entry.company_id === id)!;
export const fleetOf = (state: GameStateResponse, id: number) => [...(company(state, id).owned_trains ?? [])];
export const marksOf = (state: GameStateResponse, id: number) => [...(company(state, id).pending_rust_trains ?? [])];
export const treasuryOf = (state: GameStateResponse, id: number) => Number(company(state, id).treasury);
export const acting = (state: GameStateResponse): number | null =>
  state.current_round_type === "OperatingRound" ? (state.active_operating_order[state.active_corporation_index] ?? null) : null;
const actorOf = (state: GameStateResponse): string => {
  const id = acting(state);
  if (id !== null) return company(state, id).president!;
  return state.player_addresses[state.active_player_index];
};
const where = (state: GameStateResponse) =>
  `${state.current_round_type} ${state.macro_round_number}.${state.sub_round_index} corp ${acting(state)} @ ${state.operating_sub_phase}`;

export type Msg = SandboxLogMsg;
/** The reducer as a room calls it: the table's rules in scope, the acting president (or seat) as the actor. */
export const dispatch = (state: GameStateResponse, msg: Msg) =>
  withRules(resolveVariants(state.variants), () => applySandboxAction(state, msg, { actor: actorOf(state) }));

/** The same, with a named actor -- the president answering an obligation off-turn (a `DiscardTrain`, #1530). */
export const dispatchAs = (state: GameStateResponse, msg: Msg, actor: string) =>
  withRules(resolveVariants(state.variants), () => applySandboxAction(state, msg, { actor }));

/** Applies a message the board must accept; a refusal is a harness failure naming the board's position. */
export function send(state: GameStateResponse, msg: Msg): GameStateResponse {
  const after = dispatch(state, msg);
  if (stateDigest(after) === stateDigest(state)) throw new Error(`refused at ${where(state)}: ${JSON.stringify(msg)}`);
  return after;
}
export const refused = (state: GameStateResponse, msg: Msg) => stateDigest(dispatch(state, msg)) === stateDigest(state);

export const BUY = (id: number, model?: string) =>
  ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, ...(model ? { model_type: model } : {}) } }) as unknown as Msg;
export const BUY_RETURNED = (id: number, model: string) =>
  ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, returned_model_type: model } }) as unknown as Msg;
export const EXCHANGE = (id: number, model: string) =>
  ({ ExchangeTrainForDiesel: { game_id: 1, protocol_id: id, model_type: model } }) as unknown as Msg;
export const SALE = (buyer: number, seller: number, model: string, price = "1") =>
  ({ BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: buyer, seller_protocol_id: seller, model_type: model, price } }) as unknown as Msg;
export const DISCARD = (id: number, model: string) =>
  ({ DiscardTrain: { game_id: 1, protocol_id: id, model_type: model } }) as unknown as Msg;
export const ADVANCE = (state: GameStateResponse) =>
  ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: acting(state) } }) as unknown as Msg;
export const PASS = { PassTurn: { game_id: 1 } } as unknown as Msg;

/** Advances the acting corporation's cursor to `step` (Track -> Tokens -> Routes -> Dividends -> Hardware). */
export function advanceTo(state: GameStateResponse, step: string): GameStateResponse {
  let now = state;
  for (let guard = 0; now.operating_sub_phase !== step; guard += 1) {
    if (guard > 6) throw new Error(`never reached ${step} from ${where(state)}`);
    now = send(now, ADVANCE(now));
  }
  return now;
}

/** Passes the whole Stock Round, seat by seat, into the next Operating Round. */
export function passStockRound(state: GameStateResponse): GameStateResponse {
  let now = state;
  for (let guard = 0; now.current_round_type === "StockRound"; guard += 1) {
    if (guard > 12) throw new Error(`the Stock Round never ended: ${where(now)}`);
    now = send(now, PASS);
  }
  return now;
}

/** Every board a sequence of messages passes through, one entry per accepted message: what was sent, the board
 *  before and after, and whose turn and which step the cursor was on before it. */
export interface Stepped {
  msg: Msg;
  before: GameStateResponse;
  after: GameStateResponse;
}

/** Plays whole turns (every step, no run, no purchase, then End Turn -- the Stock Round passed seat by seat) until
 *  `stop` answers true, recording every board. */
export function playUntil(state: GameStateResponse, stop: (now: GameStateResponse) => boolean, limit = 80): Stepped[] {
  const steps: Stepped[] = [];
  let now = state;
  for (let guard = 0; !stop(now); guard += 1) {
    if (guard > limit) throw new Error(`playUntil ran away at ${where(now)}`);
    const msg =
      now.current_round_type === "StockRound" ? PASS : now.operating_sub_phase === "Hardware" ? PASS : ADVANCE(now);
    const after = send(now, msg);
    steps.push({ msg, before: now, after });
    now = after;
  }
  return steps;
}

/** The depot's head: the tier the next plain depot purchase buys. */
export const headTier = (state: GameStateResponse) => depotInventory(state).find((row) => (row.remaining ?? 0) > 0)?.tier;

/** A limit drop that leaves corporations owing a discard -- natural play. Phase 3, NYC first: NYC buys the first 4
 *  (every 2 rusts -- or, under Gentle Rust, is marked) and two more 4s; B&O buys the last 4 and the first 5, which
 *  drops the limit to 2 with NYC and B&O over it. Under Gentle Rust NYC still holds its 2s (rusted by its own
 *  purchase, so owed its NEXT turn); B&O's were owed B&O's turn and went at its Run Routes, before it bought. */
export function discardBoard(gentle: boolean): GameStateResponse {
  let state = board({
    corps: [
      { id: NYC, trains: ["2", "2"] },
      { id: BO, trains: ["2", "2", "3"] },
      { id: CO, trains: ["3", "3"] },
      { id: PRR, trains: ["2", "2", "3", "3"] },
    ],
    operating: NYC,
    gentle,
  });
  if (headTier(state) !== "4") throw new Error("discardBoard: the depot's head is not the first 4");
  state = send(state, BUY(NYC));
  state = send(state, BUY(NYC));
  state = send(state, BUY(NYC));
  state = send(state, PASS);
  state = advanceTo(state, "Hardware");
  if (acting(state) !== BO) throw new Error("discardBoard: B&O is not operating");
  state = send(state, BUY(BO));
  if (headTier(state) !== "5") throw new Error("discardBoard: the depot's head is not the first 5");
  state = send(state, BUY(BO));
  if (derivePhase(state)?.trainLimit !== 2 || pendingTrainDiscards(state) === null) {
    throw new Error("discardBoard: the first 5 left nobody over the limit");
  }
  return state;
}
