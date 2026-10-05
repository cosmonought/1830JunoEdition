/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W3-J (AUD-25.13 item 4, from the W2-J review): ONE FLOAT, ONE SENTENCE
// ==================================================================
//
// RECORDED LOW (W2-J, K-22): "on a float through an M&H exchange or a C&A grant the treasury diagnostic still prints
// beside the new float line on the same entry." Owner ruling: FIX IN W3-J, where the duplication is player-visible.
//
// IT WAS VISIBLE. The shell's apply half (RED R2) prints #750's diagnostic for every treasury the reducer moved
// (`describeTreasuryMoves`, suppressed only when the MESSAGE's sentence states its own treasury --
// `sentenceStatesTreasury`), then W2-J's float line for every corporation whose `is_floated` went false -> true
// (`describeFloat`). A `BuyStock` float was already one line (#1343: `BuyStock` is a stated-treasury sentence). The
// other three float paths were not:
//   - the C&A grant, inside an auction step (`grantCamdenBenefit`, Delayed Auction): "PRR received $670 -- treasury
//     $0 -> $670. UNEXPLAINED -- no rule in Sandbox room moves a treasury." beside "PRR has floated. It received $670."
//   - the M&H exchange on the owner's own Stock Round turn (`ExchangePrivate`): the same UNEXPLAINED alarm for NYC;
//   - a queued M&H exchange settled at a turn boundary, inside a `PassTurn` (Stock Round seat boundary, Operating
//     Round corporation boundary): "NYC received $1000 -- treasury $0 -> $1000." beside the float line.
// A message-key fix cannot reach the last two: a `PassTurn` that opens an Operating Round also pays corporation-owned
// privates, and #750's line is that payment's only record.
//
// THE FIX IS IN `treasuryProvenance.ts`, not in the shell: a corporation that floats on this transition from an
// empty treasury has its whole movement stated by the float line, so `describeTreasuryMoves` does not report it. The
// shell's loop -- RED R2 -- is untouched, and pinned so here.
//
// Every case runs the real reducer. The narration is composed in the shell's order with the shell's exact predicate
// (the K-22 harness's approach, `phase3W2JNarration.test.ts`): the message's sentence, the #750 loop, the M&H
// settlement line, the float lines. (The shell also prints the auction's "Private Won" / "Private Power" lines on the
// C&A entry; they read the auction transition, not a treasury, and are not composed here.)

import {
  applySandboxAction,
  describeFloat,
  operatingRoundSequenceLength,
} from "../gameEngine/sandboxSession";
import { RoomEngine, entriesFromExport } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { withEmptyRoster, waterfallForRoster } from "../gameEngine/gameSetup";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { actingAddress, type GameStateResponse } from "../gameEngine/gameState";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { MH_PRIVATE_ID } from "../gameEngine/privateExchange";
import { runYellowSignWritten } from "../gameEngine/yellowSign";
import { cellAt } from "../components/marketChart";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { MapGridResponse } from "../components/hexContractTypes";
import { describeTreasuryMoves, treasuryMoveLine } from "./treasuryProvenance";
import { describeGameplayAction, sentenceStatesTreasury, type ActionLogContext } from "./actionLog";
import { mhSettlementSentence } from "./mhQueuedExchange";
import { expectOrder, readShell, sliceBetween } from "./sourceScan";
import type { GameplayExecuteMsg } from "./sessionKey";

type State = GameStateResponse;
type Msg = Record<string, unknown>;

const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
/** The server path's fallback label (the room drain dispatches every entry as "Sandbox room"). */
const FALLBACK_LABEL = "Sandbox room";
const label = (address: string) => address;

/* ================================================================================================================= */
/*  THE SHELL'S NARRATION OF ONE APPLIED ENTRY                                                                        */
/* ================================================================================================================= */

/** What the Activity Log shows for one applied entry, in the shell's composition:
 *    1. the message's own sentence (`describeGameplayAction` on the before / after boards);
 *    2. #750's diagnostic -- App.tsx's loop with App.tsx's predicate, word for word:
 *         const statedInLine = sentenceStatesTreasury(gameplay) || markInRun;
 *         for (const move of describeTreasuryMoves(msg, before, after)) {
 *           if (!move.unexplained && statedInLine) continue;
 *           logInfo(..., treasuryMoveLine(move, fallbackLabel));
 *         }
 *    3. the queued M&H settlement line (`mhSettlementSentence`);
 *    4. the float lines (`describeFloat` over every corporation present on both boards). */
function narrate(msg: Msg, before: State, after: State): string[] {
  const lines: string[] = [];
  const context: ActionLogContext = {
    gameState: before,
    afterState: after,
    mapGrid: GRID,
    era: "yellow" as never,
    labelForAddress: label,
  };
  const sentence = describeGameplayAction(msg as never, context);
  if (sentence) lines.push(sentence);

  const run = (msg as { RunMultipleRoutes?: { protocol_id: number } }).RunMultipleRoutes;
  const markInRun = run !== undefined && runYellowSignWritten(before, after, run.protocol_id)?.stage === "mark";
  const statedInLine = sentenceStatesTreasury(msg as never) || markInRun;
  for (const move of describeTreasuryMoves(msg, before, after)) {
    if (!move.unexplained && statedInLine) continue;
    lines.push(treasuryMoveLine(move, FALLBACK_LABEL));
  }

  const settled = mhSettlementSentence(before, after, label);
  if (settled) lines.push(settled);

  for (const company of after.public_companies) {
    const previously = before.public_companies.find((entry) => entry.company_id === company.company_id);
    const line = previously ? describeFloat(previously, company) : null;
    if (line) lines.push(line);
  }
  return lines;
}

const companyOf = (state: State, ticker: string) => state.public_companies.find((entry) => entry.ticker === ticker)!;
const corpOf = (state: State, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;
/** The premise every float case relies on: the corporation floated on THIS transition, from an empty treasury. */
function expectFloatedFromEmpty(before: State, after: State, ticker: string, capital: number) {
  expect([ticker, companyOf(before, ticker).is_floated ?? false, Number(companyOf(before, ticker).treasury)]).toEqual([
    ticker,
    false,
    0,
  ]);
  expect([ticker, companyOf(after, ticker).is_floated, Number(companyOf(after, ticker).treasury)]).toEqual([
    ticker,
    true,
    capital,
  ]);
}
/** No #750 line of either shape names this corporation. */
const treasuryLinesFor = (lines: readonly string[], ticker: string) =>
  lines.filter((line) => line.startsWith(`${ticker} received $`) || line.startsWith(`${ticker} spent $`));

/* ================================================================================================================= */
/*  A REAL ROOM (the DA-5 / K-22 harness shape): every message through ingress, then the room engine                  */
/* ================================================================================================================= */

type Engine = InstanceType<typeof RoomEngine>;

const A = "p-w3j-a01";
const B = "p-w3j-b02";
const C = "p-w3j-c03";
const CA = 5; // the Camden & Amboy's private id in the dealt catalogue (DA-5's constant)

const PASS_TURN = { PassTurn: { game_id: 0 } };
const BUY_LOWEST = { WaterfallBuyLowest: { game_id: 0 } };

let serial = 0;
const entry = (actor: string, msg: unknown) =>
  entriesFromExport([{ index: serial, id: `w3j-float-${serial}`, actor, at: (serial += 1), msg: msg as never }])[0];

const seedBoard = (): State => {
  const state = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const waterfall = waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []);
  return { ...state, waterfall } as State;
};
/** A room's chart is seeded from its providers' `initialMarket` (#1197), so a hand-shaped board's chart travels. */
const engineFrom = (board: State): Engine =>
  new RoomEngine(
    { ...sandboxReplayProviders(), ...(board.market_positions ? { initialMarket: board.market_positions } : {}) } as never,
    { state: board, waterfall: board.waterfall ?? null } as never,
  );
const boardOf = (engine: Engine): State => ({ ...engine.snapshot.state, waterfall: engine.snapshot.waterfall }) as State;
const seatOf = (board: State) => board.player_addresses[board.active_player_index];
const actorOf = (board: State) => actingAddress(board, board.waterfall ?? null) as string;

/** One message as `actor`: ingress must accept it, the room engine applies it. The two boards either side. */
function send(engine: Engine, actor: string, msg: Msg): { before: State; after: State } {
  const before = boardOf(engine);
  const kind = Object.keys(msg)[0];
  expect([kind, turnRefusal({ state: before, waterfall: before.waterfall ?? null, actor, msg: msg as never })]).toEqual([
    kind,
    null,
  ]);
  engine.apply(entry(actor, msg));
  return { before, after: boardOf(engine) };
}

function dealt(delayedAuction: boolean): Engine {
  const engine = engineFrom(seedBoard());
  engine.apply(
    entry(A, {
      SetupGame: {
        players: [
          { id: A, nickname: "A" },
          { id: B, nickname: "B" },
          { id: C, nickname: "C" },
        ],
        variants: { delayedAuction, length: "standard", rules: 1 },
        rules_engine_version: RULES_ENGINE_VERSION,
      },
    }),
  );
  return engine;
}

const SHARE = (board: State, ticker: string, par?: number) => ({
  BuyStock: {
    game_id: 0,
    protocol_id: companyOf(board, ticker).company_id,
    source: "Ipo",
    ...(par === undefined ? {} : { par_value: String(par) }),
  },
});

/** One Stock Round turn for the seat: declines to sell (#1443), buys one certificate, ends the turn. The purchase's
 *  own transition is returned. */
function stockBuy(engine: Engine, ticker: string, par?: number): { msg: Msg; before: State; after: State } {
  const player = seatOf(boardOf(engine));
  send(engine, player, PASS_TURN);
  const msg = SHARE(boardOf(engine), ticker, par);
  const bought = send(engine, player, msg);
  send(engine, player, PASS_TURN);
  return { msg, ...bought };
}

/** The seat passes its turn (both Passes of a rules-1 turn, while the turn and the round are still its own). */
function stockPass(engine: Engine): void {
  const start = boardOf(engine);
  const player = seatOf(start);
  for (let n = 0; n < 2; n += 1) {
    const now = boardOf(engine);
    if (now.current_round_type !== "StockRound" || now.macro_round_number !== start.macro_round_number) break;
    if (seatOf(now) !== player) break;
    send(engine, player, PASS_TURN);
  }
}

function finishStockRound(engine: Engine): State {
  const start = boardOf(engine).macro_round_number;
  for (let guard = 0; ; guard += 1) {
    const now = boardOf(engine);
    if (now.current_round_type !== "StockRound" || now.macro_round_number !== start) return now;
    if (guard > 12) throw new Error("the Stock Round did not end");
    stockPass(engine);
  }
}

/* ================================================================================================================= */
/*  1. THE C&A GRANT FLOAT -- DA-5 test 6's path (`da5PrivateConsequences.test.ts`)                                   */
/* ================================================================================================================= */

/** The end of the Operating Round set in which the first 3-train was bought, hand-shaped on the real board exactly
 *  as DA-5's `operatingRoundEnd` does: NYC floated under C (the last operating president), trains 2 + 3. */
function operatingRoundEnd(real: State): State {
  const nyc = companyOf(real, "NYC");
  return {
    ...real,
    current_round_type: "OperatingRound",
    sub_round_index: operatingRoundSequenceLength({ public_companies: [{ company_id: 1, owned_trains: ["3"] }] } as never),
    active_operating_order: [nyc.company_id],
    active_corporation_index: 0,
    active_player_index: real.player_addresses.indexOf(C),
    public_companies: real.public_companies.map((company) =>
      company.company_id === nyc.company_id
        ? {
            ...company,
            is_floated: true,
            president: C,
            par_value: "100",
            owned_trains: ["2", "3"],
            player_holdings: [{ player: C, percentage: 60 }],
            ipo_pool_percentage: 40,
            station_token_hexes: ["G19"],
          }
        : company,
    ),
  } as State;
}

/** The C&A's purchase that brings PRR to 60% sold: A 30, B 10, C 10 in a real Delayed-Auction Stock Round 1, the
 *  auction armed by the reducer's own transition, B SV, C C&SL, A D&H, B M&H, then C buys the C&A at face. */
function caGrantFloat(): { msg: Msg; before: State; after: State } {
  const engine = dealt(true);
  stockBuy(engine, "PRR", 67);
  stockBuy(engine, "PRR");
  stockBuy(engine, "PRR");
  stockBuy(engine, "PRR");
  const sr2 = finishStockRound(engine);
  expect([sr2.current_round_type, sr2.macro_round_number]).toEqual(["StockRound", 2]); // nothing floated
  expect(companyOf(sr2, "PRR").is_floated ?? false).toBe(false);

  const auction = engineFrom(operatingRoundEnd(sr2));
  send(auction, C, PASS_TURN); // the set ends; the reducer inserts and arms the Delayed Auction
  expect(boardOf(auction).current_round_type).toBe("WaterfallAuction");
  expect(actorOf(boardOf(auction))).toBe(B);
  for (let n = 0; n < 4; n += 1) send(auction, actorOf(boardOf(auction)), BUY_LOWEST);
  expect(actorOf(boardOf(auction))).toBe(C);
  return { msg: BUY_LOWEST, ...send(auction, C, BUY_LOWEST) };
}

describe("AUD-25.13 #4 (1): the C&A grant float is one sentence", () => {
  it("the C&A's purchase floats PRR with its full capital, and the entry says so once -- no treasury echo, no false alarm", () => {
    const { msg, before, after } = caGrantFloat();
    expect(before.private_companies.find((entry) => entry.private_id === CA)?.owner ?? null).toBeNull();
    expect(after.private_companies.find((entry) => entry.private_id === CA)?.owner).toBe(C);
    expect(100 - companyOf(after, "PRR").ipo_pool_percentage).toBe(60);
    expectFloatedFromEmpty(before, after, "PRR", 670); // 10 x its $67 par
    // The auction message is not a stated-treasury sentence: the omission, not the predicate, is what silences it.
    expect(sentenceStatesTreasury(msg as never)).toBe(false);

    const lines = narrate(msg, before, after);
    expect(lines).toEqual([`${C} bought the cheapest private company at face value.`, "PRR has floated. It received $670."]);
    expect(treasuryLinesFor(lines, "PRR")).toEqual([]);
    expect(lines.join("\n")).not.toContain("UNEXPLAINED");
    expect(describeTreasuryMoves(msg, before, after).filter((move) => move.ticker === "PRR")).toEqual([]);
  });
});

/* ================================================================================================================= */
/*  2. THE M&H EXCHANGE FLOAT, ON THE OWNER'S OWN TURN AND QUEUED TO A STOCK ROUND BOUNDARY -- a real standard game  */
/* ================================================================================================================= */

/** A real standard game: the opening auction bought out at face (the B&O's buyer pars it), Stock Round 1 opened, and
 *  NYC parred and bought to 50% out of the IPO in ordinary turns -- so one exchanged certificate floats it. */
function nycAtFiftyPercent(): { engine: Engine; owner: string; nycId: number } {
  const engine = dealt(false);
  const buyers: string[] = [];
  for (let n = 0; n < 6; n += 1) {
    const actor = actorOf(boardOf(engine));
    buyers.push(actor);
    send(engine, actor, BUY_LOWEST);
  }
  send(engine, buyers[5], { SetBoPar: { player: buyers[5], par_value: "100" } });
  send(engine, A, { OpenStockRound: {} });
  expect(boardOf(engine).current_round_type).toBe("StockRound");
  const owner = boardOf(engine).private_companies.find((entry) => entry.private_id === MH_PRIVATE_ID)!.owner!;
  const nycId = companyOf(boardOf(engine), "NYC").company_id;
  stockBuy(engine, "NYC", 100);
  while (100 - corpOf(boardOf(engine), nycId).ipo_pool_percentage < 50) stockBuy(engine, "NYC");
  const board = boardOf(engine);
  expect(100 - corpOf(board, nycId).ipo_pool_percentage).toBe(50);
  expect(corpOf(board, nycId).is_floated ?? false).toBe(false);
  expect(board.private_companies.find((entry) => entry.private_id === MH_PRIVATE_ID)?.closed ?? false).toBe(false);
  return { engine, owner, nycId };
}

const exchange = (owner: string, nycId: number) => ({
  ExchangePrivate: { game_id: 0, private_id: MH_PRIVATE_ID, company_id: nycId, player: owner, source: "Ipo" },
});

describe("AUD-25.13 #4 (2): the M&H exchange float is one sentence -- a real standard game", () => {
  it("on the owner's own Stock Round turn: the exchange's sentence and the float line, and nothing about the treasury", () => {
    const { engine, owner, nycId } = nycAtFiftyPercent();
    while (seatOf(boardOf(engine)) !== owner) stockPass(engine);
    const msg = exchange(owner, nycId);
    const { before, after } = send(engine, owner, msg);
    expect(after.pending_mh_exchange ?? null).toBeNull(); // executed at once, never queued
    expectFloatedFromEmpty(before, after, "NYC", 1000);
    expect(sentenceStatesTreasury(msg as never)).toBe(false);

    const lines = narrate(msg, before, after);
    expect(lines).toEqual([
      `M&H exchange EXECUTED — ${owner} exchanged the Mohawk & Hudson for a 10% share of NYC from the IPO. The private company closes.`,
      "NYC has floated. It received $1000.",
    ]);
    expect(treasuryLinesFor(lines, "NYC")).toEqual([]);
    expect(lines.join("\n")).not.toContain("UNEXPLAINED");
  });

  it("queued during another seat's turn and settled when that turn ends: the Pass, the settlement, the float -- once each", () => {
    const { engine, owner, nycId } = nycAtFiftyPercent();
    const seated = seatOf(boardOf(engine));
    expect(seated).not.toBe(owner);
    const requested = send(engine, owner, exchange(owner, nycId));
    expect(requested.after.pending_mh_exchange).toMatchObject({ player: owner, company_id: nycId, source: "Ipo" });
    expect(corpOf(requested.after, nycId).is_floated ?? false).toBe(false);

    // Rules 1: the first Pass walks Sell -> Buy (not a boundary); the second ends the seat's turn, and the reducer
    // settles the request there.
    const walked = send(engine, seated, PASS_TURN);
    expect(walked.after.pending_mh_exchange).not.toBeNull();
    const { before, after } = send(engine, seated, PASS_TURN);
    expect(after.pending_mh_exchange ?? null).toBeNull();
    expectFloatedFromEmpty(before, after, "NYC", 1000);

    const lines = narrate(PASS_TURN, before, after);
    expect(lines).toEqual([
      expect.stringContaining(seated),
      `M&H exchange EXECUTED — ${owner} exchanged the Mohawk & Hudson for a 10% share of NYC from the IPO. The private company closes.`,
      "NYC has floated. It received $1000.",
    ]);
    expect(treasuryLinesFor(lines, "NYC")).toEqual([]);
  });
});

/* ================================================================================================================= */
/*  3. HAND-SHAPED BOARDS (the `mohawkExchangeAuthority.test.ts` fixture, minimal copy): the Operating Round          */
/*     boundary, the precision control, and the #750 controls                                                         */
/* ================================================================================================================= */

const P1 = "p1";
const P2 = "p2";
const P3 = "p3";
const PRR = 1;
const NYC = 2;
const BO = 4;
const DH = 3;

interface Corp {
  id: number;
  ticker: string;
  president: string | null;
  x: number;
  y: number;
  arrival: number;
  holdings?: Array<[string, number]>;
  ipo?: number;
  floated?: boolean;
  treasury?: string;
  station?: boolean;
  home?: string | null;
}

function at(x: number, y: number): { x: number; y: number; price: number } {
  const cell = cellAt(x, y);
  if (!cell) throw new Error(`no chart cell at (${x}, ${y})`);
  return { x, y, price: cell.price };
}

const H16 = STATIC_BOARD_HEXES.find((entry) => entry.label === "H16")!;

/** The M&H authority suite's board, cut to what these cases need. A D&H owned by PRR (the corporation) when asked. */
function board(input: {
  round: "StockRound" | "OperatingRound";
  corps: Corp[];
  order?: number[];
  operating?: number;
  seat?: number;
  passes?: number;
  dhOwnedByPrr?: boolean;
}): State {
  const players = [P1, P2, P3];
  const inOr = input.round === "OperatingRound";
  const order = inOr ? input.order ?? input.corps.filter((c) => c.floated !== false).map((c) => c.id) : [];
  const index = inOr ? Math.max(0, order.indexOf(input.operating ?? order[0])) : 0;
  const operatingPresident = inOr ? input.corps.find((corp) => corp.id === order[index])?.president : undefined;
  return {
    game_id: 1,
    variants: { rules: 1 },
    player_addresses: players,
    player_cash: players.map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "10000",
    rules_engine_version: 5,
    private_companies: [
      { private_id: MH_PRIVATE_ID, name: "Mohawk & Hudson", cost: "110", revenue_per_or: "20", owner: P1, owner_protocol_id: null, closed: false },
      ...(input.dhOwnedByPrr
        ? [{ private_id: DH, name: "Delaware & Hudson", cost: "70", revenue_per_or: "15", owner: null, owner_protocol_id: PRR, closed: false }]
        : []),
    ],
    current_round_type: input.round,
    macro_round_number: 3,
    active_player_index: inOr ? Math.max(0, players.indexOf(operatingPresident ?? P1)) : input.seat ?? 0,
    priority_deal_index: 0,
    last_trader_index: null,
    consecutive_passes: inOr ? 0 : input.passes ?? 0,
    active_operating_order: order,
    active_corporation_index: index,
    sub_round_index: inOr ? 1 : 0,
    operating_round_sequence_length: 1,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    current_global_era: "Yellow",
    bought_this_turn: 0,
    turn_action_taken: false,
    ...(inOr ? { operating_sub_phase: "Track" } : {}),
    market_positions: Object.fromEntries(input.corps.map((corp) => [corp.id, { ...at(corp.x, corp.y), enteredAt: corp.arrival }])),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: corp.floated ?? true,
      president: corp.president,
      par_value: "100",
      ipo_pool_percentage: corp.ipo ?? 0,
      bank_pool_percentage: 0,
      treasury: corp.treasury ?? "300",
      owned_trains: [],
      player_holdings: (corp.holdings ?? (corp.president ? [[corp.president, 60]] : [])).map(([player, percentage]) => ({
        player,
        percentage,
      })),
      station_token_hexes: corp.station ? [[H16.q, H16.r]] : [],
      station_tokens: corp.station ? [[H16.q, H16.r, 0]] : [],
      station_token_limit: 3,
      home_hex_label: corp.home ?? null,
      last_route_revenue: "0",
    })),
  } as unknown as State;
}

/** The reducer as a room's engine calls it. */
function room(state: State, msg: Msg, actor: string): State {
  const providers = sandboxReplayProviders();
  return applySandboxAction(state, msg as unknown as GameplayExecuteMsg, {
    ...providers.chartInjections(state),
    actor,
    mapGrid: GRID,
    marketContext: providers.marketContext(state, msg as unknown as GameplayExecuteMsg, actor),
    parCellFor: providers.parCellFor,
  });
}

const PASS = { PassTurn: { game_id: 1 } };
const EXCHANGE = { ExchangePrivate: { game_id: 1, private_id: MH_PRIVATE_ID, company_id: NYC, player: P1, source: "Ipo" } };

const prr = (over: Partial<Corp> = {}): Corp => ({
  id: PRR,
  ticker: "PRR",
  president: P2,
  x: 10,
  y: 7,
  arrival: 1,
  ipo: 40,
  holdings: [[P2, 40], [P3, 20]],
  home: "H12",
  ...over,
});
/** NYC 50% out of the IPO, unfloated -- with an EMPTY treasury, as a real unfloated corporation has. */
const nycFloating = (over: Partial<Corp> = {}): Corp => ({
  id: NYC,
  ticker: "NYC",
  president: P2,
  x: 9,
  y: 7,
  arrival: 2,
  ipo: 50,
  floated: false,
  holdings: [[P2, 50]],
  treasury: "0",
  home: "E19",
  ...over,
});

const EXECUTED = `M&H exchange EXECUTED — ${P1} exchanged the Mohawk & Hudson for a 10% share of NYC from the IPO. The private company closes.`;

describe("AUD-25.13 #4 (3): a queued exchange settled at an Operating Round corporation boundary is one sentence", () => {
  it("PRR's turn ends, the request settles, NYC floats -- the entry says the turn, the settlement and the float", () => {
    const or = board({
      round: "OperatingRound",
      order: [PRR, BO],
      operating: PRR,
      corps: [
        prr({ station: true }),
        { id: BO, ticker: "B&O", president: P3, x: 7, y: 8, arrival: 3, station: true, home: "I15" },
        nycFloating(),
      ],
    });
    const queued = room(or, EXCHANGE, P1);
    expect(queued.pending_mh_exchange).toMatchObject({ player: P1, company_id: NYC });
    const advanced = room(queued, PASS, P2);
    expect(advanced.pending_mh_exchange ?? null).toBeNull();
    expect(advanced.active_operating_order[advanced.active_corporation_index]).toBe(BO);
    expectFloatedFromEmpty(queued, advanced, "NYC", 1000);
    expect(sentenceStatesTreasury(PASS as never)).toBe(false);

    const lines = narrate(PASS, queued, advanced);
    expect(lines).toEqual(["PRR ended its turn.", EXECUTED, "NYC has floated. It received $1000."]);
    expect(treasuryLinesFor(lines, "NYC")).toEqual([]);
  });
});

describe("AUD-25.13 #4 (4): the precision control -- only the float's capital is omitted", () => {
  it("the Pass that ends the Stock Round settles the exchange AND pays PRR's D&H: PRR's line stays, NYC's capital goes", () => {
    const lastTurn = board({ round: "StockRound", seat: 2, passes: 2, dhOwnedByPrr: true, corps: [prr(), nycFloating()] });
    const queued = room(lastTurn, EXCHANGE, P1);
    expect(queued.pending_mh_exchange).toMatchObject({ player: P1 });
    const walked = room(queued, PASS, P3); // Sell -> Buy
    expect(walked.current_round_type).toBe("StockRound");
    const opened = room(walked, PASS, P3); // the turn ends, the round ends, the Operating Round opens
    expect(opened.current_round_type).toBe("OperatingRound");
    expect(opened.pending_mh_exchange ?? null).toBeNull();
    expectFloatedFromEmpty(walked, opened, "NYC", 1000);
    expect(Number(corpOf(opened, PRR).treasury)).toBe(315); // the D&H's $15, on the same entry

    const lines = narrate(PASS, walked, opened);
    // A round-opening Pass is a treasury mover whose sentence states no balance, so #750 speaks for PRR -- the
    // payment's only record -- exactly as before.
    expect(treasuryLinesFor(lines, "PRR")).toEqual(["PRR received $15 — treasury $300 → $315."]);
    expect(treasuryLinesFor(lines, "NYC")).toEqual([]);
    expect(lines).toContain(EXECUTED);
    expect(lines.filter((line) => line.startsWith("NYC has floated."))).toEqual(["NYC has floated. It received $1000."]);
    expect(describeTreasuryMoves(PASS, walked, opened)).toEqual([
      { companyId: PRR, ticker: "PRR", from: 300, to: 315, unexplained: false },
    ]);
  });
});

describe("AUD-25.13 #4 (5): #750 keeps its job", () => {
  it("a FLOATED corporation re-capitalised on a message with no business moving a treasury is still UNEXPLAINED", () => {
    const before = board({ round: "StockRound", corps: [prr(), nycFloating({ floated: true, treasury: "500" })] });
    const forged = {
      ...before,
      public_companies: before.public_companies.map((company) =>
        company.company_id === NYC ? { ...company, treasury: "1500" } : company,
      ),
    } as State;
    const msg = { SellStock: { game_id: 1, protocol_id: PRR, percentage: 10 } };
    expect(describeTreasuryMoves(msg, before, forged)).toEqual([
      { companyId: NYC, ticker: "NYC", from: 500, to: 1500, unexplained: true },
    ]);
    expect(narrate(msg, before, forged)).toContain(
      "NYC received $1000 — treasury $500 → $1500. UNEXPLAINED — no rule in Sandbox room moves a treasury.",
    );
  });

  it("a float from a NON-EMPTY treasury (300 -> 1300) is still reported: the float line alone would not carry the origin", () => {
    const before = board({ round: "StockRound", seat: 0, corps: [prr(), nycFloating({ treasury: "300" })] });
    const after = room(before, EXCHANGE, P1);
    expect([corpOf(after, NYC).is_floated, corpOf(after, NYC).treasury]).toEqual([true, "1300"]);
    expect(describeTreasuryMoves(EXCHANGE, before, after)).toEqual([
      { companyId: NYC, ticker: "NYC", from: 300, to: 1300, unexplained: true },
    ]);
    expect(treasuryLinesFor(narrate(EXCHANGE, before, after), "NYC")).toEqual([
      "NYC received $1000 — treasury $300 → $1300. UNEXPLAINED — no rule in Sandbox room moves a treasury.",
    ]);
  });

  it("the ordinary BuyStock float is unchanged: the purchase's sentence, then the float -- one line each (K-22)", () => {
    const engine = dealt(true); // Stock Round 1 opens at once
    const purchases = [stockBuy(engine, "PRR", 100), stockBuy(engine, "PRR"), stockBuy(engine, "PRR"), stockBuy(engine, "PRR"), stockBuy(engine, "PRR")];
    const floating = purchases.findIndex(({ before, after }) => !companyOf(before, "PRR").is_floated && companyOf(after, "PRR").is_floated);
    expect(floating).toBe(4); // A 20, B 10, C 10, A 10, B 10 = 60%
    const { msg, before, after } = purchases[floating];
    expectFloatedFromEmpty(before, after, "PRR", 1000);
    expect(sentenceStatesTreasury(msg as never)).toBe(true); // #1343: was already silent through the predicate
    expect(narrate(msg, before, after)).toEqual([`${B} bought a 10% share of PRR from the IPO.`, "PRR has floated. It received $1000."]);
  });
});

/* ================================================================================================================= */
/*  6. THE SHELL IS UNTOUCHED (RED R2): the fix lives in `treasuryProvenance.ts`                                      */
/* ================================================================================================================= */

describe("AUD-25.13 #4 (6): the shell's loop is the one this file composes, and it did not change", () => {
  const shell = readShell();

  it("the #750 block still suppresses only explained movements a stated-treasury sentence carries (batch51's pin)", () => {
    const block = sliceBetween(shell, "const statedInLine = sentenceStatesTreasury(gameplay) || markInRun;", "treasuryMoveLine(move, fallbackLabel)");
    expect(block).toContain("for (const move of describeTreasuryMoves(msg, before, after)) {");
    expect(block).toContain("if (!move.unexplained && statedInLine) continue;");
    expect(block).toContain('move.unexplained ? "Treasury (unexplained)" : "Treasury"');
  });

  it("the diagnostic is read before the float lines, on the same two boards, in the same dispatch", () => {
    expectOrder(
      shell,
      "const statedInLine = sentenceStatesTreasury(gameplay) || markInRun;",
      "describeTreasuryMoves(msg, before, after)",
      "const mhSettled = mhSettlementSentence(",
      "describeFloat(previously, company)",
    );
    const floats = sliceBetween(shell, "const line = previously ? describeFloat(previously, company) : null;", "showCorporationFloat(");
    expect(floats).toContain('if (line) logInfo("Float", line);');
  });
});
