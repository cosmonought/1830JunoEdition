// frontend/src/utils/offerFixtures74.ts
//
// Hand-built boards for the Batch 7.4 offer suites (#1590-#1596). TEST SUPPORT ONLY -- nothing in the engine
// imports this. Each board is LEGAL for the transaction its suite is about, so that a refusal in a test is
// the one fact the test changed and not an accident of the fixture: the Operating boards name their queue,
// carry a 3-train (phase 3), a chart (`market_positions`, so refusals are proved by digest -- S7-17), the
// derived era, and privates owned by named players; the Stock Round boards are macro round 2 with seated
// players and cash.

import type { GameStateResponse } from "../gameEngine/gameState";

export const P1 = "p1";
export const P2 = "p2";
export const P3 = "p3";

export const PRR = 1;
export const NYC = 2;
export const CO = 5;

/** Private ids, matching the catalog's numbering where the rules care (the B&O private is 6, the C&A 5, the
 *  M&H 4, the D&H 3, the C&SL 2, the SV 1). */
export const SV = 1;
export const CSL = 2;
export const DH = 3;
export const MH = 4;
export const CA = 5;
export const BO = 6;

const PRIVATE_NAMES: Record<number, string> = {
  1: "Schuylkill Valley",
  2: "Champlain & St. Lawrence",
  3: "Delaware & Hudson",
  4: "Mohawk & Hudson",
  5: "Camden & Amboy",
  6: "Baltimore & Ohio",
};

export interface Corp {
  id: number;
  ticker: string;
  president: string | null;
  trains?: string[];
  treasury?: string;
  holdings?: Array<[string, number]>;
  price?: number;
  floated?: boolean;
  parValue?: string | null;
  ipo?: number;
}

export interface Priv {
  id: number;
  owner: string | null;
  ownerCorp?: number | null;
  cost: string;
  closed?: boolean;
}

export interface BoardInput {
  round: "OperatingRound" | "StockRound";
  corps: Corp[];
  privates?: Priv[];
  cash?: Record<string, number>;
  players?: string[];
  /** Operating: which corporation is operating (default the first) and at which step (default Hardware). */
  operating?: number;
  step?: string;
  /** Stock Round: the seat, macro round number (default 2). */
  seat?: number;
  macro?: number;
  /** Extra fields, spread last. */
  over?: Partial<GameStateResponse>;
}

export function board(input: BoardInput): GameStateResponse {
  const players = input.players ?? [P1, P2, P3];
  const order = input.corps.map((corp) => corp.id);
  const operating = input.operating ?? order[0];
  const anyThree = input.corps.some((corp) => (corp.trains ?? []).some((train) => train === "3" || train === "4"));
  const state = {
    game_id: 1,
    player_addresses: players,
    player_cash: players.map((player) => ({ player, cash_vgp: String(input.cash?.[player] ?? 500) })),
    virtual_bank_vgp: "8000",
    private_companies: (input.privates ?? []).map((priv) => ({
      private_id: priv.id,
      name: PRIVATE_NAMES[priv.id] ?? `Private ${priv.id}`,
      cost: priv.cost,
      revenue_per_or: "10",
      owner: priv.owner,
      owner_protocol_id: priv.ownerCorp ?? null,
      closed: priv.closed ?? false,
    })),
    current_round_type: input.round,
    macro_round_number: input.macro ?? (input.round === "StockRound" ? 2 : 3),
    active_player_index: input.round === "StockRound" ? (input.seat ?? 0) : 0,
    priority_deal_index: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(operating),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    current_global_era: anyThree ? "Green" : "Yellow",
    ...(input.round === "OperatingRound" ? { operating_sub_phase: input.step ?? "Hardware" } : {}),
    rules_engine_version: 4,
    market_positions: Object.fromEntries(
      input.corps.map((corp, index) => [corp.id, { price: corp.price ?? 100, x: 5 + index, y: 6, enteredAt: index + 1 }]),
    ),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: corp.floated ?? true,
      president: corp.president,
      par_value: corp.parValue === undefined ? String(corp.price ?? 100) : corp.parValue,
      ipo_pool_percentage: corp.ipo ?? 0,
      bank_pool_percentage: 0,
      treasury: corp.treasury ?? "500",
      owned_trains: corp.trains ?? [],
      player_holdings: (corp.holdings ?? (corp.president ? [[corp.president, 60]] : [])).map(([player, percentage]) => ({
        player,
        percentage,
      })),
      station_token_hexes: [],
      station_tokens: [],
      station_token_limit: 3,
      /* No home label: a floated corporation with a label and no token OWES its home token (#763), and the
         room's providers inject the label lookup that makes that hold bite. These boards are about offers. */
      home_hex_label: null,
    })),
    ...(input.over ?? {}),
  };
  return state as unknown as GameStateResponse;
}

/** A phase-3 Operating board: PRR (P1) operating at Hardware with $500, NYC (P2) with a 3-train and a 2-train,
 *  C&O (P3) with a 3-train; the D&H ($70) is P2's and the C&A ($160) P3's. */
export function operatingBoard(over: Partial<BoardInput> = {}): GameStateResponse {
  return board({
    round: "OperatingRound",
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "500" },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3", "2"], treasury: "400", price: 90 },
      { id: CO, ticker: "C&O", president: P3, trains: ["3"], treasury: "300", price: 80 },
    ],
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: CA, owner: P3, cost: "160" },
    ],
    cash: { [P1]: 300, [P2]: 300, [P3]: 300 },
    ...over,
  });
}

/** A second Stock Round: P1 seated; the D&H is P2's, the M&H P1's; PRR and NYC parred. */
export function stockRoundBoard(over: Partial<BoardInput> = {}): GameStateResponse {
  return board({
    round: "StockRound",
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]] },
      { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, holdings: [[P2, 30], [P3, 10]] },
    ],
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: MH, owner: P1, cost: "110" },
    ],
    cash: { [P1]: 300, [P2]: 300, [P3]: 300 },
    ...over,
  });
}

export const company = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)!;
export const priv = (state: GameStateResponse, id: number) =>
  state.private_companies.find((entry) => entry.private_id === id)!;
export const cash = (state: GameStateResponse, player: string) =>
  Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);
export const treasury = (state: GameStateResponse, id: number) => Number(company(state, id).treasury);
