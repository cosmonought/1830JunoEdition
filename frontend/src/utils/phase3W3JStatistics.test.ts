/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W3-J (AUD-25.13 item 5; W3-K's residual R2, owner ruled FIX IN W3-J): THE v13 SALES IN THE STATISTICS
// ==================================================================
//
// The post-game statistics (`gameHistory.ts`) counted share trades only off `BuyStock` / `SellStock` entries, so rules
// revision 2's ONE `EmergencySellPortfolio` entry (whose legs run inside the reducer) and the automatic bankruptcy's
// liquidation (recorded as `bankruptcy_record` inside whatever entry proved it) were invisible; and the forced purchase's
// personal contribution was booked to the `EmergencyBuyHardware` entry's actor -- on the derived path, the seat whose
// submission provoked it, which can be somebody else.
//
// Every board is the real reducer's. Two harnesses, the W2-L / UR-5 pair (`postgameStatisticsResiduals.test.ts`):
//   * THE REPLAY: a hosted room's actual log (`RoomSession`: the real ingress, reducer and derived loop) replayed by the
//     real engine, seeded with the constructed v13 board;
//   * THE SCRIPT: the replay engine replaced by a script of boards, each the reducer's answer to the board before it, so
//     a constructed later Stock Round (a NEUTRAL step) can judge the legs' prices.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

let mockScript: GameStateResponse[] | null = null;
let mockSeeded: { providers: unknown; seed: { state: GameStateResponse; waterfall: null } } | null = null;

jest.mock("../gameEngine/replayLog", () => {
  const actual = jest.requireActual("../gameEngine/replayLog");
  function RoomEngine(this: unknown, ...args: unknown[]) {
    if (mockScript !== null) return { snapshot: { state: mockScript[0], grid: { game_id: 1, tiles: [] } } };
    if (mockSeeded !== null) return new actual.RoomEngine(mockSeeded.providers, mockSeeded.seed);
    return new actual.RoomEngine(...args);
  }
  function LegacyLogAdapters(this: unknown, ...args: unknown[]) {
    if (mockScript === null) return new actual.LegacyLogAdapters(...args);
    return {
      apply(engine: { snapshot: { state: GameStateResponse; grid: unknown } }, entry: { index: number }) {
        engine.snapshot = { ...engine.snapshot, state: mockScript![entry.index + 1] };
      },
    };
  }
  return { ...actual, RoomEngine, LegacyLogAdapters };
});

const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { marketCellForPrice } = require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const { gameHistoryFrom } = require("./gameHistory") as typeof import("./gameHistory");

type MapGridResponse = import("../components/hexContractTypes").MapGridResponse;
type History = ReturnType<typeof gameHistoryFrom>;

/* ------------------------------------------------------------------ */
/* The v13 boards (rulesV13EmergencyFunding.test.ts's, rebuilt here)   */
/* ------------------------------------------------------------------ */

const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
const H16 = hex("H16");
const I17 = hex("I17");
/** C&O's station at H16 and two tiles: a legal two-stop route, so a trainless C&O owes a train at Buy Trains. */
const CORRIDOR: MapGridResponse = {
  game_id: 1,
  tiles: [
    { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
    { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
  ],
} as unknown as MapGridResponse;

const CO = 5; // the corporation without a train
const NYC = 2;
const PRR = 1;
const BO = 4;
const P1 = "p1"; // C&O's president
const P2 = "p2";
const P3 = "p3";

interface Corp {
  id: number;
  ticker: string;
  president: string;
  trains: string[];
  treasury: string;
  holdings: Array<[string, number]>;
  pool?: number;
  price: number;
}

const cell = (price: number) => marketCellForPrice(price)!;

/** A v13 board (rules revision 2, pin 13): C&O at Buy Trains (or `step`), trainless, with a legal route. */
function board(input: { corps: Corp[]; step?: string; cash: Record<string, number>; privates?: Array<{ private_id: number; owner: string; cost: string }> }): GameStateResponse {
  const order = input.corps.map((corp) => corp.id);
  return {
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: String(input.cash[player] ?? 0) })),
    virtual_bank_vgp: "10000",
    variants: { rules: 2 },
    rules_engine_version: 13,
    private_companies: (input.privates ?? []).map((priv) => ({
      private_id: priv.private_id, name: `Private ${priv.private_id}`, cost: priv.cost, revenue_per_or: "10",
      owner: priv.owner, owner_protocol_id: null, closed: false,
    })),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(CO),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: input.step ?? "Hardware",
    market_positions: Object.fromEntries(
      input.corps.map((corp, index) => [corp.id, { price: corp.price, x: cell(corp.price).x, y: cell(corp.price).y, enteredAt: index + 1 }]),
    ),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id, ticker: corp.ticker, is_floated: true, president: corp.president, par_value: String(corp.price),
      ipo_pool_percentage: 0, bank_pool_percentage: corp.pool ?? 0, treasury: corp.treasury, owned_trains: corp.trains,
      player_holdings: corp.holdings.map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [[H16.q, H16.r]], station_tokens: [[H16.q, H16.r, 0]], station_token_limit: 3, home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

/** P1 must raise $80 for C&O's 2-train: NYC 10% at $40 and PRR 10% at $50, nothing else he may sell. */
const twoHoldings = () =>
  board({
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 10]], price: 40 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 10]], price: 50 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
  });

/** Shortfall $180 and nothing can rescue it: the bankruptcy liquidates NYC 20% (the pool's ceiling) and B&O 10%. */
const insolvent = (step?: string) =>
  board({
    step,
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3"], treasury: "500", holdings: [[P2, 40], [P1, 30]], pool: 30, price: 40 },
      { id: PRR, ticker: "PRR", president: P1, trains: [], treasury: "500", holdings: [[P1, 20], [P3, 10]], price: 50 },
      { id: BO, ticker: "B&O", president: P3, trains: [], treasury: "500", holdings: [[P3, 60], [P1, 10]], price: 20 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
  });

/** Phase 3 (NYC owns a 3), the 3-train at $180; P1's only way out is selling his $160 private to NYC. */
const privateOnly = () =>
  board({
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3"], treasury: "500", holdings: [[P2, 30]], price: 100 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "100", holdings: [[P3, 40]], price: 50 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    privates: [{ private_id: 2, owner: P1, cost: "160" }],
  });

const PORTFOLIO = (...sales: Array<[number, number]>) => ({ EmergencySellPortfolio: { game_id: 1, sales: sales.map(([protocol_id, percentage]) => ({ protocol_id, percentage })) } });
const ADVANCE = (id: number) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } });
const OFFER = (privateId: number, buyer: number, price: number) => ({ OfferPrivateForFunding: { game_id: 1, private_id: privateId, buyer_protocol_id: buyer, price } });
const ANSWER = (privateId: number, accept: boolean) => ({ AnswerFundingPrivateOffer: { game_id: 1, private_id: privateId, accept } });
const NEUTRAL = { W3JNeutral: {} };

const providers = sandboxReplayProviders();
/** The reducer exactly as `RoomEngine` hands it a message. */
const apply = (state: GameStateResponse, msg: unknown, actor: string) =>
  applySandboxAction(state, msg as never, {
    actor, mapGrid: CORRIDOR, ...providers.chartInjections(state),
    marketContext: providers.marketContext(state, msg as never, actor), parCellFor: providers.parCellFor,
  });

/* ------------------------------------------------------------------ */
/* The two harnesses                                                   */
/* ------------------------------------------------------------------ */

const roomProvidersFor = (seed: GameStateResponse) => ({ ...sandboxReplayProviders(), initialGrid: CORRIDOR, initialMarket: seed.market_positions! });

/** A hosted room over `seed`: the real ingress, the real reducer, the real derived loop. */
function roomOver(seed: GameStateResponse) {
  let n = 0;
  const room = new RoomSession({ providers: roomProvidersFor(seed), seed: { state: seed, waterfall: null }, build: "b", mintId: () => `m${(n += 1)}` });
  const submit = (actor: string, msg: unknown) => room.submit({ actor, build: "b", msg: msg as never, baseIndex: room.nextIndex - 1 });
  return { room, submit };
}
const kinds = (entries: readonly { payload: string; derived?: boolean }[]) =>
  entries.map((entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`);

/** THE REPLAY: the room's own log, replayed by the real engine from `seed`. */
function replayed(seed: GameStateResponse, entries: ReadonlyArray<{ index: number; id: string; actor: string | null; payload: string; derived?: boolean }>): History {
  mockSeeded = { providers: roomProvidersFor(seed), seed: { state: seed, waterfall: null } };
  try {
    return gameHistoryFrom(entries.map((entry) => ({ ...entry })) as never);
  } finally {
    mockSeeded = null;
  }
}

/** THE SCRIPT: `boards[i + 1]` is the board after `steps[i]`. */
function scripted(boards: GameStateResponse[], steps: Array<{ msg: unknown; actor: string | null }>): History {
  expect(boards).toHaveLength(steps.length + 1);
  mockScript = boards;
  try {
    return gameHistoryFrom(steps.map((step, index) => ({ index, id: `w3j-${index}`, actor: step.actor, payload: JSON.stringify(step.msg), derived: false })) as never);
  } finally {
    mockScript = null;
  }
}

const accolade = (history: History, key: string) => history.accolades.find((entry) => entry.key === key)!;
const top = (history: History, key: string) => [accolade(history, key).holder, accolade(history, key).value];
const autopsyOf = (history: History, companyId: number) => history.autopsy.find((row) => row.companyId === companyId)!;
const held = (state: GameStateResponse, id: number, player: string) =>
  state.public_companies.find((entry) => entry.company_id === id)!.player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
const cash = (state: GameStateResponse, player: string) => Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);

/* ================================================================== */

describe("W3-J AUD-25.13 item 5: an EmergencySellPortfolio's legs are sales by the president who made them", () => {
  it("the room's one portfolio entry is two certificates sold by P1 (the Market Manipulator)", () => {
    const seed = twoHoldings();
    const { room, submit } = roomOver(seed);
    expect(submit(P1, PORTFOLIO([NYC, 10], [PRR, 10])).kind).toBe("applied");
    expect(kinds(room.entries)).toEqual(["EmergencySellPortfolio", "EmergencyBuyHardware*"]);
    expect(room.entries.some((entry) => JSON.parse(entry.payload).SellStock !== undefined)).toBe(false); // no SellStock entry
    const history = replayed(seed, room.entries);
    expect(top(history, "market-manipulator")).toEqual([P1, 2]);
  });

  it("each leg is priced at what it raised: the next Stock Round judges NYC at $40 and PRR at $50, not their average", () => {
    const seed = twoHoldings();
    const sold = apply(seed, PORTFOLIO([NYC, 10], [PRR, 10]), P1);
    expect([held(sold, NYC, P1), held(sold, PRR, P1), cash(sold, P1)]).toEqual([0, 0, 90]); // $40 + $50, one entry
    // A constructed later Stock Round: NYC recovered to $70, PRR fell to $45.
    const later = {
      ...sold,
      current_round_type: "StockRound",
      macro_round_number: 4,
      sub_round_index: 0,
      operating_sub_phase: undefined,
      market_positions: { ...sold.market_positions, [NYC]: { ...sold.market_positions![NYC]!, price: 70 }, [PRR]: { ...sold.market_positions![PRR]!, price: 45 } },
    } as GameStateResponse;
    const history = scripted([seed, sold, later], [
      { msg: PORTFOLIO([NYC, 10], [PRR, 10]), actor: P1 },
      { msg: NEUTRAL, actor: null },
    ]);
    // The Human Stop-Loss: NYC sold at $40 now worth $70 -> $30; PRR sold at $50 now $45 -> nothing. (At the $45
    // average the NYC leg would read $25.)
    expect(top(history, "human-stop-loss")).toEqual([P1, 30]);
    expect(top(history, "market-manipulator")).toEqual([P1, 2]);
  });

  it("a refused portfolio moved nothing and counts nothing", () => {
    const seed = twoHoldings();
    const refused = apply(seed, PORTFOLIO([PRR, 10]), P1); // $50 of an $80 need: refused whole, by identity
    expect(refused).toBe(seed);
    const history = scripted([seed, refused], [{ msg: PORTFOLIO([PRR, 10]), actor: P1 }]);
    expect(top(history, "market-manipulator")).toEqual([null, 0]);
  });
});

describe("W3-J AUD-25.13 item 5: the automatic bankruptcy's liquidation is sales by the bankrupt president", () => {
  it("NYC 20% and B&O 10%, sold inside the transition that proved the bankruptcy, are three certificates for P1", () => {
    const seed = insolvent("Dividends");
    const { room, submit } = roomOver(seed);
    submit(P1, ADVANCE(CO));
    expect(room.state.current_round_type).toBe("GameEnd");
    expect(room.state.bankruptcy_record).toMatchObject({ president: P1, sold: [{ company_id: NYC, percentage: 20 }, { company_id: BO, percentage: 10 }], liquidation_proceeds: 100 });
    expect(kinds(room.entries).some((kind) => kind.startsWith("SellStock") || kind.startsWith("EmergencySellPortfolio"))).toBe(false);
    const history = replayed(seed, room.entries);
    expect(top(history, "market-manipulator")).toEqual([P1, 3]);
  });

  it("booked once: the record standing on later boards is not a second liquidation", () => {
    const seed = insolvent("Dividends");
    const ended = apply(seed, ADVANCE(CO), P1);
    expect(ended.bankruptcy_record?.president).toBe(P1);
    const history = scripted([seed, ended, ended], [
      { msg: ADVANCE(CO), actor: P1 },
      { msg: NEUTRAL, actor: null },
    ]);
    expect(top(history, "market-manipulator")).toEqual([P1, 3]);
  });
});

describe("W3-J AUD-25.13 item 5: the forced purchase's personal contribution is the president's, not the entry actor's", () => {
  it("P2's yes provokes the derived purchase (attributed to P2); P1's $180 is P1's Fundraiser, C&O's price and train spend", () => {
    const seed = privateOnly();
    const { room, submit } = roomOver(seed);
    expect(submit(P1, OFFER(2, NYC, 200)).kind).toBe("applied");
    expect(submit(P2, ANSWER(2, true)).kind).toBe("applied");
    expect(kinds(room.entries)).toEqual(["OfferPrivateForFunding", "AnswerFundingPrivateOffer", "EmergencyBuyHardware*"]);
    expect(room.entries[2].actor).toBe(P2); // the derived purchase carries the provoking seat, not C&O's president
    expect(cash(room.state, P1)).toBe(20); // $200 from the private, $180 of it into the train
    const history = replayed(seed, room.entries);
    expect(top(history, "fundraiser")).toEqual([P1, 180]);
    const ledger = autopsyOf(history, CO).fleetLedger.find((row) => row.model === "3");
    expect(ledger).toMatchObject({ count: 1, paid: 180 });
    expect(autopsyOf(history, CO).payback).toBe(-180); // the train spend includes the president's $180
  });
});
