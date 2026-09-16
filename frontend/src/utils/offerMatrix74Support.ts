// frontend/src/utils/offerMatrix74Support.ts
//
// TEST SUPPORT ONLY for the Batch 7.4 exhaustive authority matrix (`offerMatrix74*.test.ts`). Nothing in the engine
// imports this. It builds on Fable's legal boards (`offerFixtures74.ts`) and adds what a one-fact matrix needs:
// single-fact mutators, message builders, the two locks (the reducer judged by digest, ingress judged by its
// sentence), a room harness on the server path, and the Batch-5 corridor board the D-6 cases need.
//
// THE MATRIX DISCIPLINE. Every table row starts from a board on which the transaction is legal, changes exactly
// one fact, and asks both locks. A refusal is asserted by the authority's own sentence (so predicate-order drift
// shows up as a different sentence) and by `stateDigest` equality (S10-1: a board with a chart comes back as a new
// object even when nothing moved, so identity proves nothing here).

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { GameplayExecuteMsg } from "./sessionKey";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { fieldDigests, stateDigest } from "../gameEngine/stateDigest";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { RoomSession, type ServerLogEntry } from "./roomSession";
import { P1, P2, P3, PRR, NYC, CO } from "./offerFixtures74";

export const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

/* ---- the two locks ---------------------------------------------------------------------------------------- */

/** The reducer, as the fixture suites call it: an author, the empty grid, no room injections. */
export const apply = (state: GameStateResponse, msg: unknown, actor: string | null = null, mapGrid: MapGridResponse = GRID) =>
  applySandboxAction(state, msg as GameplayExecuteMsg, { actor, mapGrid });

/** The reducer exactly as a room's engine calls it: the providers' chart injections (the home-token label table
 *  among them), the author and the grid. */
export const applyAsRoom = (state: GameStateResponse, msg: unknown, actor: string, mapGrid: MapGridResponse = GRID) =>
  applySandboxAction(state, msg as GameplayExecuteMsg, {
    ...sandboxReplayProviders().chartInjections(state),
    actor,
    mapGrid,
  });

/** Ingress (`turnRefusal`), with a host and an empty log so the room-message owners are asked. */
export const ingress = (state: GameStateResponse, actor: string, msg: unknown, mapGrid: MapGridResponse = GRID) =>
  turnRefusal({ state, waterfall: null, actor, msg: msg as GameplayExecuteMsg, host: P1, log: [], mapGrid });

export const same = (a: GameStateResponse, b: GameStateResponse) => stateDigest(a) === stateDigest(b);

/** The top-level fields whose digests differ (a field present on one side only counts). */
export const differing = (a: GameStateResponse, b: GameStateResponse) => {
  const was = fieldDigests(a);
  const now = fieldDigests(b);
  return Object.keys({ ...was, ...now })
    .filter((key) => was[key] !== now[key])
    .sort();
};

/* ---- one-fact mutators ------------------------------------------------------------------------------------ */

type Corp = GameStateResponse["public_companies"][number];
type Priv = GameStateResponse["private_companies"][number];

export const withCorp = (state: GameStateResponse, id: number, patch: Partial<Corp> | Record<string, unknown>): GameStateResponse => ({
  ...state,
  public_companies: state.public_companies.map((entry) => (entry.company_id === id ? ({ ...entry, ...patch } as Corp) : entry)),
});

export const withPriv = (state: GameStateResponse, id: number, patch: Partial<Priv> | Record<string, unknown>): GameStateResponse => ({
  ...state,
  private_companies: state.private_companies.map((entry) => (entry.private_id === id ? ({ ...entry, ...patch } as Priv) : entry)),
});

export const withCash = (state: GameStateResponse, player: string, cash: number): GameStateResponse => ({
  ...state,
  player_cash: state.player_cash.map((entry) => (entry.player === player ? { ...entry, cash_vgp: String(cash) } : entry)),
});

export const withState = (state: GameStateResponse, patch: Record<string, unknown>): GameStateResponse =>
  ({ ...state, ...patch }) as GameStateResponse;

/** Phase by fleet: the phase is the highest tier any corporation owns (`derivePhase`), so C&O's fleet sets it. */
export const atPhase = (state: GameStateResponse, tier: "2" | "3" | "4" | "5" | "6"): GameStateResponse => {
  if (tier === "2") {
    return state.public_companies.reduce(
      (board, entry) => withCorp(board, entry.company_id, { owned_trains: (entry.owned_trains ?? []).map(() => "2") }),
      state,
    );
  }
  return withCorp(state, CO, { owned_trains: [tier] });
};

/* ---- field readers ---------------------------------------------------------------------------------------- */

export const corp = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;
export const priv = (state: GameStateResponse, id: number) => state.private_companies.find((entry) => entry.private_id === id)!;
export const cash = (state: GameStateResponse, player: string) =>
  Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);
export const treasury = (state: GameStateResponse, id: number) => Number(corp(state, id).treasury);
export const trains = (state: GameStateResponse, id: number) => [...(corp(state, id).owned_trains ?? [])];

/** Everything a refusal may not partially alter, as one comparable record (§17). */
export const guarded = (state: GameStateResponse) => ({
  money: {
    bank: state.virtual_bank_vgp,
    cash: state.player_cash.map((entry) => [entry.player, entry.cash_vgp]),
    treasuries: state.public_companies.map((entry) => [entry.company_id, entry.treasury]),
  },
  privateOwnership: state.private_companies.map((entry) => [entry.private_id, entry.owner ?? null, entry.owner_protocol_id ?? null, entry.closed ?? false]),
  trainOwnership: state.public_companies.map((entry) => [entry.company_id, [...(entry.owned_trains ?? [])]]),
  stockRoundTraders: [
    state.turn_action_taken ?? false,
    state.consecutive_passes,
    state.last_trader_index ?? null,
    state.bought_this_turn ?? 0,
    state.bought_this_turn_company ?? null,
    state.stock_turn_stage ?? null,
  ],
  operatingStep: [state.operating_sub_phase ?? null, state.active_corporation_index],
  seat: state.active_player_index,
  round: [state.current_round_type, state.macro_round_number, state.sub_round_index],
});

/* ---- messages --------------------------------------------------------------------------------------------- */

export const M = {
  proposePrivate: (privateId: number, buyer: number, price: number, owner = "narration") => ({
    ProposePrivatePurchase: { game_id: 1, private_id: privateId, private_name: "narration", owner, buyer_protocol_id: buyer, buyer_ticker: "narration", price },
  }),
  answerPrivate: (privateId: number, accept: boolean) => ({ AnswerPrivatePurchase: { game_id: 1, private_id: privateId, accept } }),
  rescindPrivate: (privateId: number) => ({ RescindPrivatePurchase: { game_id: 1, private_id: privateId } }),
  buyPrivate: (buyer: number, privateId: number, price: string) => ({
    BuyPrivateCompany: { game_id: 1, protocol_id: buyer, private_id: privateId, price },
  }),
  proposeTrain: (seller: number, buyer: number, model: string, price: string, sellerPresident: string | null = "narration") => ({
    ProposeTrainPurchase: {
      game_id: 1,
      seller_protocol_id: seller,
      seller_ticker: "narration",
      seller_president: sellerPresident,
      buyer_protocol_id: buyer,
      buyer_ticker: "narration",
      model_type: model,
      price,
    },
  }),
  answerTrain: (seller: number, accept: boolean) => ({ AnswerTrainPurchase: { game_id: 1, seller_protocol_id: seller, accept } }),
  rescindTrain: (seller: number) => ({ RescindTrainPurchase: { game_id: 1, seller_protocol_id: seller } }),
  buyTrain: (buyer: number, seller: number, model: string, price: string) => ({
    BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: buyer, seller_protocol_id: seller, model_type: model, price },
  }),
  proposeTrade: (privateId: number, seller: string, buyer: string, price: number) => ({
    ProposePrivateTrade: { game_id: 1, private_id: privateId, seller, buyer, price },
  }),
  answerTrade: (privateId: number, accept: boolean) => ({ AnswerPrivateTrade: { game_id: 1, private_id: privateId, accept } }),
  rescindTrade: (privateId: number) => ({ RescindPrivateTrade: { game_id: 1, private_id: privateId } }),
  pass: { PassTurn: { game_id: 1 } },
  advance: (id: number) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } }),
  buyStock: (id: number, source: "Ipo" | "Bank" = "Ipo") => ({ BuyStock: { game_id: 1, protocol_id: id, source, par_value: null } }),
  sellStock: (id: number, percentage: number) => ({ SellStock: { game_id: 1, protocol_id: id, percentage } }),
  depot: (id: number) => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id } }),
  emergency: (id: number) => ({ EmergencyBuyHardware: { game_id: 1, protocol_id: id } }),
  declare: { DeclareBankruptcy: { game_id: 1 } },
  fundingOffer: (privateId: number, buyer: number, price: number) => ({
    OfferPrivateForFunding: { game_id: 1, private_id: privateId, buyer_protocol_id: buyer, price },
  }),
  layTile: (id: number) => ({ LayTile: { game_id: 1, protocol_id: id, q: 0, r: 0, tile_id: 7, orientation: 0 } }),
  token: (id: number) => ({ PlaceStationToken: { game_id: 1, protocol_id: id, q: 0, r: 0 } }),
  run: (id: number) => ({ RunMultipleRoutes: { game_id: 1, protocol_id: id, routes: [] } }),
  dividend: (id: number) => ({ DeclareDividends: { game_id: 1, protocol_id: id, revenue_amount: "0", distribute: false } }),
  discard: (id: number, model: string) => ({ DiscardTrain: { game_id: 1, protocol_id: id, model_type: model } }),
  revert: (index: number, player: string = P1) => ({ RevertTo: { index, player, summary: "undo" } }),
  closeRoom: { CloseRoom: {} },
};

/* ---- accepted-but-unsettled fixtures (the state the server path never lets survive a burst) --------------- */

/** Proposal by P1 for PRR, accepted by the board's owner. `offered` is the unanswered board. */
export const privateOfferStages = (board: GameStateResponse, privateId: number, price: number, owner: string) => {
  const offered = apply(board, M.proposePrivate(privateId, PRR, price), P1);
  const accepted = apply(offered, M.answerPrivate(privateId, true), owner);
  return { offered, accepted };
};

export const trainOfferStages = (board: GameStateResponse, seller: number, model: string, price: string, sellerPresident: string) => {
  const offered = apply(board, M.proposeTrain(seller, PRR, model, price), P1);
  const accepted = apply(offered, M.answerTrain(seller, true), sellerPresident);
  return { offered, accepted };
};

/* ---- the server path ---------------------------------------------------------------------------------------- */

export interface Room {
  room: RoomSession;
  submit: (actor: string, msg: unknown) => ReturnType<RoomSession["submit"]>;
  /** The message kinds a response appended, derived ones marked with `*`. */
  kinds: (response: ReturnType<RoomSession["submit"]>) => string[];
  /** Every entry of one kind in the room's log. */
  logged: (kind: string) => ServerLogEntry[];
}

export function roomFor(seed: GameStateResponse, mapGrid: MapGridResponse = GRID): Room {
  let minted = 0;
  const room = new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: mapGrid },
    seed: { state: seed, waterfall: null },
    build: "b",
    mintId: () => `m${(minted += 1)}`,
  });
  const submit = (actor: string, msg: unknown) =>
    room.submit({ actor, build: "b", host: P1, msg: msg as GameplayExecuteMsg, baseIndex: room.nextIndex - 1 });
  const kinds = (response: ReturnType<RoomSession["submit"]>) =>
    ((response as { entries?: ServerLogEntry[] }).entries ?? []).map(
      (entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`,
    );
  const logged = (kind: string) =>
    (room.entries as ServerLogEntry[]).filter((entry) => Object.keys(JSON.parse(entry.payload))[0] === kind);
  return { room, submit, kinds, logged };
}

/** A replay entry, as a stored log carries it. */
export const entry = (index: number, actor: string, msg: unknown, derived = false) => ({
  index,
  id: `e${index}`,
  actor,
  payload: JSON.stringify(msg),
  ...(derived ? { derived: true } : {}),
});

/* ---- the Batch-5 corridor (D-6 needs a legal route for the trainless corporation) --------------------------- */

/* Design note #1300: the board tables are read when a case asks, never at module load -- `STATIC_BOARD_HEXES` is a
   live binding `activateBoard` rebinds, so a hex captured at import time would be whichever board happened to be in
   effect then, for the life of the process. The lookup, the corridor grid and `fundingBoard`'s token hex are all
   derived inside the calls that need them. */
function hexAt(label: string) {
  return STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
}

/** The corridor grid: tile 57 on H16 and tile 7 on I17, derived from the board in effect at the call. */
export function corridor(): MapGridResponse {
  const H16 = hexAt("H16");
  const I17 = hexAt("I17");
  return {
    game_id: 1,
    tiles: [
      { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
      { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
    ],
  } as unknown as MapGridResponse;
}

/** `emergencyFunding.test.ts`'s intercorporate board: C&O (P1) operating at Hardware with no train, a legal route
 *  through the corridor and $30; PRR (P3) holds two 3-trains (face $180, so the bank's required train is a 3 at
 *  $180 too); NYC (P2) has $500. `cash` is P1's. */
export function fundingBoard(
  presidentCash: number,
  over: {
    coTreasury?: string;
    coTrains?: string[];
    prrTrains?: string[];
    coHoldings?: Array<[string, number]>;
    nycHoldings?: Array<[string, number]>;
    privates?: Array<{ id: number; owner: string; cost: string }>;
  } = {},
): GameStateResponse {
  const corps = [
    { id: CO, ticker: "C&O", president: P1, trains: over.coTrains ?? ([] as string[]), treasury: over.coTreasury ?? "30", holdings: over.coHoldings ?? ([[P1, 60], [P2, 20]] as Array<[string, number]>), price: 90, x: 5, y: 6 },
    { id: NYC, ticker: "NYC", president: P2, trains: [] as string[], treasury: "500", holdings: over.nycHoldings ?? ([[P2, 30], [P1, 20]] as Array<[string, number]>), price: 100, x: 8, y: 8 },
    { id: PRR, ticker: "PRR", president: P3, trains: over.prrTrains ?? ["3", "3"], treasury: "500", holdings: [[P3, 40]] as Array<[string, number]>, price: 50, x: 3, y: 6 },
  ];
  const order = corps.map((entry) => entry.id);
  const H16 = hexAt("H16");
  return {
    player_addresses: [P1, P2, P3],
    player_cash: [
      { player: P1, cash_vgp: String(presidentCash) },
      { player: P2, cash_vgp: "300" },
      { player: P3, cash_vgp: "300" },
    ],
    virtual_bank_vgp: "10000",
    private_companies: (over.privates ?? []).map((entry) => ({
      private_id: entry.id,
      name: `Private ${entry.id}`,
      cost: entry.cost,
      revenue_per_or: "10",
      owner: entry.owner,
      owner_protocol_id: null,
      closed: false,
    })),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: order,
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: "Hardware",
    rules_engine_version: 4,
    market_positions: Object.fromEntries(corps.map((entry, index) => [entry.id, { price: entry.price, x: entry.x, y: entry.y, enteredAt: index + 1 }])),
    public_companies: corps.map((entry) => ({
      company_id: entry.id,
      ticker: entry.ticker,
      is_floated: true,
      president: entry.president,
      par_value: String(entry.price),
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: entry.treasury,
      owned_trains: entry.trains,
      player_holdings: entry.holdings.map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [[H16.q, H16.r]],
      station_tokens: [[H16.q, H16.r, 0]],
      station_token_limit: 3,
      home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

export { P1, P2, P3, PRR, NYC, CO };
