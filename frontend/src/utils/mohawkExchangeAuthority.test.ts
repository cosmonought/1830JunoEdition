/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1630 (harness): THE M&H EXCHANGE, JUDGED (Slice 8.4, S8-10)
// ==================================================================
//
// S8-10: the `ExchangePrivate` arm applied whatever the message said and re-derived nothing -- the source, the
// corporation, `keep_open`, the ownership, the 60% cap, the certificate limit, the share's physical
// availability, the timing window, the float threshold and the presidency were all unjudged.
//
// Owner rulings R1 / R2 (Stage-8 review 2026-09-16) decide the two questions the rulebook leaves to the table:
// the exchange is a FREE INTERJECTION (no purchase consumed, no seat, streak or Priority Deal moved), and an
// off-turn request made while another turn is underway is QUEUED and settled -- after full revalidation -- at
// the next between-turns boundary. QUEUING VESTS NOTHING: the first 5-train can close the M&H out from under a
// queued request, and a chosen pile that empties cancels it rather than switching to the other pile.
//
// EVERY CASE GOES THROUGH `applySandboxAction` with the room's own injections (`sandboxReplayProviders`), which
// is the server's reducer path, and the premises each case depends on -- who is seated, what is in which pile,
// what the queue holds -- are asserted before the case relies on them, so a fixture drifting fails loudly here
// instead of quietly testing something else.

import { applySandboxAction } from "../gameEngine/sandboxSession";
import {
  applyMhExchange,
  mhExchangeDisposition,
  mhExchangeRefusal,
  mhExchangeRequestRefusal,
  mhSettlementFor,
  mhSourceRefusal,
  settleMhExchange,
} from "../gameEngine/mohawkExchange";
/* #1634: the canonical physical-availability reading and the 7.2 sale authority -- asked directly, so §13
   proves the pre-presidency case against the SAME functions the reducer asks rather than against a copy. */
import {
  chartContextFromState,
  isPresidentPurchase,
  ordinaryPercentAvailable,
  stockSaleRefusal,
} from "../gameEngine/stockTransactionAuthority";
import { metFloatThreshold, soldFromIpoPercent } from "../gameEngine/floatThreshold";
import { MH_PRIVATE_ID } from "../gameEngine/privateExchange";
import { buildOperatingOrder } from "../gameEngine/operatingOrder";
import { certificateBreakdown } from "../gameEngine/gameState";
import { CURRENT_RULES_REVISION } from "../gameEngine/gameVariants";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { RoomEngine, type ReplayEntry } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { marketZoneForPrice } from "../gameEngine/marketGeometry";
import { cellAt } from "../components/marketChart";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { GameplayExecuteMsg } from "./sessionKey";

const P1 = "p1";
const P2 = "p2";
const P3 = "p3";

const PRR = 1;
const NYC = 2;
const BO = 4;

/* ---- the chart and the board ------------------------------------------------------------------------------ */

function at(x: number, y: number): { x: number; y: number; price: number } {
  const cell = cellAt(x, y);
  if (!cell) throw new Error(`no chart cell at (${x}, ${y})`);
  return { x, y, price: cell.price };
}

const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
const EMPTY_GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

interface Corp {
  id: number;
  ticker: string;
  president: string | null;
  x: number;
  y: number;
  arrival: number;
  holdings?: Array<[string, number]>;
  ipo?: number;
  pool?: number;
  floated?: boolean;
  par?: string | null;
  trains?: string[];
  treasury?: string;
  station?: boolean;
}

interface Priv {
  id: number;
  name: string;
  owner?: string | null;
  corporation?: number | null;
  closed?: boolean;
}

function board(input: {
  round: "StockRound" | "OperatingRound" | "WaterfallAuction" | "GameEnd";
  corps: Corp[];
  privates?: Priv[];
  order?: number[];
  operating?: number;
  step?: string;
  seat?: number;
  passes?: number;
  cash?: Record<string, number>;
  pending?: GameStateResponse["pending_mh_exchange"];
  boughtThisTurn?: number;
  stage?: "sell" | "buy";
  acted?: boolean;
  priority?: number;
  lastTrader?: number | null;
  soldThisRound?: Record<string, number[]>;
  returned?: string[];
}): GameStateResponse {
  const H16 = hex("H16");
  const players = [P1, P2, P3];
  const inOr = input.round === "OperatingRound";
  const order = inOr ? input.order ?? input.corps.filter((c) => c.floated !== false).map((c) => c.id) : [];
  const index = inOr ? Math.max(0, order.indexOf(input.operating ?? order[0])) : 0;
  const operatingPresident = inOr ? input.corps.find((corp) => corp.id === order[index])?.president : undefined;
  return {
    game_id: 1,
    /* #1443: Sell-Buy-Sell, the revision this engine deals -- so a purchase leaves the seat with the buyer and
       the turn ends on a Pass, which is what makes "the exchange consumed nothing" an observable claim. */
    variants: { rules: CURRENT_RULES_REVISION },
    player_addresses: players,
    player_cash: players.map((player) => ({ player, cash_vgp: String(input.cash?.[player] ?? 500) })),
    virtual_bank_vgp: "10000",
    rules_engine_version: 5,
    private_companies: (input.privates ?? [{ id: MH_PRIVATE_ID, name: "Mohawk & Hudson", owner: P1 }]).map((priv) => ({
      private_id: priv.id,
      name: priv.name,
      cost: "110",
      revenue_per_or: "20",
      owner: priv.corporation != null ? null : priv.owner ?? null,
      owner_protocol_id: priv.corporation ?? null,
      closed: priv.closed ?? false,
    })),
    current_round_type: input.round,
    macro_round_number: 3,
    active_player_index: inOr ? Math.max(0, players.indexOf(operatingPresident ?? P1)) : input.seat ?? 0,
    priority_deal_index: input.priority ?? 0,
    last_trader_index: input.lastTrader === undefined ? null : input.lastTrader,
    consecutive_passes: inOr ? 0 : input.passes ?? 0,
    active_operating_order: order,
    active_corporation_index: index,
    sub_round_index: inOr ? 1 : 0,
    operating_round_sequence_length: 1,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    current_global_era: "Yellow",
    bought_this_turn: input.boughtThisTurn ?? 0,
    turn_action_taken: input.acted ?? false,
    ...(input.stage ? { stock_turn_stage: input.stage } : {}),
    ...(input.soldThisRound ? { sold_this_round: input.soldThisRound } : {}),
    ...(input.returned ? { returned_trains: input.returned } : {}),
    ...(input.pending !== undefined ? { pending_mh_exchange: input.pending } : {}),
    ...(inOr ? { operating_sub_phase: input.step ?? "Track" } : {}),
    market_positions: Object.fromEntries(
      input.corps.map((corp) => [corp.id, { ...at(corp.x, corp.y), enteredAt: corp.arrival }]),
    ),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: corp.floated ?? true,
      president: corp.president,
      par_value: corp.par === undefined ? "100" : corp.par,
      ipo_pool_percentage: corp.ipo ?? 0,
      bank_pool_percentage: corp.pool ?? 0,
      treasury: corp.treasury ?? "300",
      owned_trains: corp.trains ?? [],
      player_holdings: (corp.holdings ?? (corp.president ? [[corp.president, 60]] : [])).map(([player, percentage]) => ({
        player,
        percentage,
      })),
      station_token_hexes: corp.station ? [[H16.q, H16.r]] : [],
      station_tokens: corp.station ? [[H16.q, H16.r, 0]] : [],
      station_token_limit: 3,
      home_hex_label: null,
      last_route_revenue: "0",
    })),
  } as unknown as GameStateResponse;
}

/** The reducer as a room's engine calls it. */
function room(
  state: GameStateResponse,
  msg: unknown,
  actor: string,
  mapGrid: MapGridResponse = EMPTY_GRID,
): GameStateResponse {
  const providers = sandboxReplayProviders();
  return applySandboxAction(state, msg as GameplayExecuteMsg, {
    ...providers.chartInjections(state),
    actor,
    mapGrid,
    marketContext: providers.marketContext(state, msg as GameplayExecuteMsg, actor),
    parCellFor: providers.parCellFor,
  });
}

const homeHexToAxial = sandboxReplayProviders().chartInjections(board({ round: "StockRound", corps: [] })).homeHexToAxial!;

const PASS = { PassTurn: { game_id: 1 } };
/** #1443: a Stock Round turn opens on SELL -- the first Pass walks to BUY, the second ends the turn. The two
 *  messages are spelled out at the boundary cases below rather than hidden, because "the first Pass is not a
 *  boundary" is itself one of the things this slice has to be right about. */
const endStockTurn = (state: GameStateResponse, player: string) => room(room(state, PASS, player), PASS, player);
const EXCHANGE = (source: "Ipo" | "Bank" = "Ipo", player = P1, company = NYC, priv = MH_PRIVATE_ID, extra = {}) => ({
  ExchangePrivate: { game_id: 1, private_id: priv, company_id: company, player, source, ...extra },
});
const BUY = (id: number, source: "Ipo" | "Bank" = "Ipo") => ({
  BuyStock: { game_id: 1, protocol_id: id, quantity: 1, source, par_value: "100" },
});

const privOf = (state: GameStateResponse, id = MH_PRIVATE_ID) =>
  state.private_companies.find((entry) => entry.private_id === id)!;
const corpOf = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)!;
const heldBy = (state: GameStateResponse, id: number, player: string) =>
  corpOf(state, id).player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
const seatOf = (state: GameStateResponse, player: string) => state.player_addresses.indexOf(player);
const request = (player = P1, source: "Ipo" | "Bank" = "Ipo", company = NYC) => ({
  private_id: MH_PRIVATE_ID,
  company_id: company,
  player,
  source,
});

/** A PRR whose president is well under the 60% cap, so an ordinary purchase of it is legal. */
const prr = (over: Partial<Corp> = {}): Corp => ({
  id: PRR,
  ticker: "PRR",
  president: P2,
  x: 10,
  y: 7,
  arrival: 1,
  ipo: 40,
  holdings: [[P2, 40], [P3, 20]],
  ...over,
});

/** NYC part-sold: 50% in the IPO, so ONE exchanged certificate takes 60% out of it -- the float line (5.3). */
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
  ...over,
});

/* ================================================================================================================= */
/* 1. REQUEST-TIME AUTHORITY -- ownership, the private, the target, the window                                        */
/* ================================================================================================================= */

describe("1. request-time authority: who, what, and when (#1630)", () => {
  const sr = (over: Partial<Parameters<typeof board>[0]> = {}) =>
    board({
      round: "StockRound",
      seat: 0,
      corps: [
        prr({ president: P1, holdings: [[P1, 40], [P3, 20]] }),
        nycFloating(),
      ],
      ...over,
    });

  it("1.1 the M&H's owner, on their own Stock Round turn, is accepted and executes", () => {
    const before = sr();
    expect(before.player_addresses[before.active_player_index]).toBe(P1); // premise: P1 is seated
    expect(mhExchangeRequestRefusal(before, request(), P1)).toBeNull();
    expect(mhExchangeDisposition(before, request())).toBe("execute");
    const after = room(before, EXCHANGE(), P1);
    expect(heldBy(after, NYC, P1)).toBe(10);
    expect(privOf(after).closed).toBe(true);
    expect(after.pending_mh_exchange ?? null).toBeNull();
  });

  it("1.2 a player who does not own the M&H is refused, and nothing is recorded", () => {
    const before = sr({ seat: 1 });
    expect(mhExchangeRequestRefusal(before, request(P2), P2)).toMatch(/not yours to exchange/);
    const after = room(before, EXCHANGE("Ipo", P2), P2);
    expect(after.pending_mh_exchange ?? null).toBeNull();
    expect(heldBy(after, NYC, P2)).toBe(50);
    expect(privOf(after).closed).toBe(false);
  });

  it("1.3 a FORGED sender -- the message names the owner, the socket says somebody else -- is refused in the reducer", () => {
    const before = sr();
    // Ingress refuses it ...
    expect(
      turnRefusal({ state: before, waterfall: null, msg: EXCHANGE() as unknown as GameplayExecuteMsg, actor: P2 }),
    ).toMatch(/owner can exchange it/);
    // ... and so does the reducer, asked with the same pair, so a message arriving another way cannot mint.
    expect(mhExchangeRequestRefusal(before, request(), P2)).toMatch(/owner can exchange it/);
    const after = room(before, EXCHANGE(), P2);
    expect(privOf(after).closed).toBe(false);
    expect(heldBy(after, NYC, P1)).toBe(0);
  });

  it("1.4 a CORPORATION-owned M&H cannot be exchanged -- the power is a player's (p. 27)", () => {
    const before = sr({ privates: [{ id: MH_PRIVATE_ID, name: "Mohawk & Hudson", corporation: PRR }] });
    expect(mhExchangeRequestRefusal(before, request(), P1)).toMatch(/belongs to a corporation/);
    expect(room(before, EXCHANGE(), P1).private_companies[0].closed).toBe(false);
  });

  it("1.5 a closed M&H is refused", () => {
    const before = sr({ privates: [{ id: MH_PRIVATE_ID, name: "Mohawk & Hudson", owner: P1, closed: true }] });
    expect(mhExchangeRequestRefusal(before, request(), P1)).toMatch(/already been exchanged or closed/);
    expect(heldBy(room(before, EXCHANGE(), P1), NYC, P1)).toBe(0);
  });

  it("1.6 a private that is not the M&H is refused -- the C&A's share is a purchase bonus, not an exchange (#576)", () => {
    const before = sr({
      privates: [
        { id: MH_PRIVATE_ID, name: "Mohawk & Hudson", owner: P1 },
        { id: 5, name: "Camden & Amboy", owner: P1 },
      ],
    });
    expect(mhExchangeRequestRefusal(before, { ...request(), private_id: 5 }, P1)).toMatch(/Only the Mohawk & Hudson/);
    const after = room(before, EXCHANGE("Ipo", P1, PRR, 5), P1);
    expect(after.private_companies.find((p) => p.private_id === 5)!.closed).toBe(false);
    expect(heldBy(after, PRR, P1)).toBe(40);
  });

  it("1.7 a target that is not the NYC is refused", () => {
    const before = sr();
    expect(mhExchangeRequestRefusal(before, request(P1, "Ipo", PRR), P1)).toMatch(/exchanges for a NYC certificate/);
    const after = room(before, EXCHANGE("Ipo", P1, PRR), P1);
    expect(privOf(after).closed).toBe(false);
    expect(corpOf(after, PRR).ipo_pool_percentage).toBe(40);
  });

  it("1.8 `keep_open: true` is refused -- the exchange closes the M&H and a client may not say otherwise", () => {
    const before = sr();
    expect(mhExchangeRequestRefusal(before, { ...request(), keep_open: true }, P1)).toMatch(/cannot be kept open/);
    const after = room(before, EXCHANGE("Ipo", P1, NYC, MH_PRIVATE_ID, { keep_open: true }), P1);
    expect(privOf(after).closed).toBe(false);
    expect(heldBy(after, NYC, P1)).toBe(0);
  });

  it("1.9 the window is the Stock Round and the Operating Round -- the auction and a finished game are refused", () => {
    for (const round of ["WaterfallAuction", "GameEnd"] as const) {
      const before = board({ round, corps: [nycFloating()], seat: 0 });
      expect(mhExchangeRequestRefusal(before, request(), P1)).toMatch(/only be exchanged during a Stock Round/);
      const after = room(before, EXCHANGE(), P1);
      expect(after.pending_mh_exchange ?? null).toBeNull();
      expect(privOf(after).closed).toBe(false);
    }
  });

  it("1.10 an already-pending request refuses a second one, and does NOT overwrite its source (#1630b)", () => {
    const before = sr({ seat: 1, pending: { player: P1, private_id: MH_PRIVATE_ID, company_id: NYC, source: "Ipo" } });
    expect(mhExchangeRequestRefusal(before, request(P1, "Bank"), P1)).toMatch(/already pending/);
    const after = room(before, EXCHANGE("Bank"), P1);
    expect(after.pending_mh_exchange).toEqual({ player: P1, private_id: MH_PRIVATE_ID, company_id: NYC, source: "Ipo" });
  });
});

/* ================================================================================================================= */
/* 2. SOURCE CHOICE, AND NO MINTING FROM AN EMPTY PILE                                                                */
/* ================================================================================================================= */

describe("2. the owner chooses the source, and an empty pile has nothing to give (R2, #1630)", () => {
  const withPiles = (ipo: number, pool: number) =>
    board({
      round: "StockRound",
      seat: 0,
      corps: [nycFloating({ ipo, pool, holdings: [[P2, 100 - ipo - pool]] })],
    });

  it("2.1 IPO only -> the IPO is accepted and the Bank Pool is refused", () => {
    const before = withPiles(40, 0);
    expect(mhExchangeRefusal(before, request(P1, "Ipo"), P1)).toBeNull();
    expect(mhExchangeRefusal(before, request(P1, "Bank"), P1)).toMatch(/Bank Pool holds no NYC certificate/);
    const after = room(before, EXCHANGE("Ipo"), P1);
    expect([corpOf(after, NYC).ipo_pool_percentage, corpOf(after, NYC).bank_pool_percentage]).toEqual([30, 0]);
  });

  it("2.2 pool only -> the pool is accepted and the IPO is refused", () => {
    const before = withPiles(0, 30);
    expect(mhExchangeRefusal(before, request(P1, "Bank"), P1)).toBeNull();
    expect(mhExchangeRefusal(before, request(P1, "Ipo"), P1)).toMatch(/IPO holds no NYC certificate/);
    const after = room(before, EXCHANGE("Bank"), P1);
    expect([corpOf(after, NYC).ipo_pool_percentage, corpOf(after, NYC).bank_pool_percentage]).toEqual([0, 20]);
  });

  it("2.3 both legal -> whichever the owner NAMED is the one that is taken; there is no IPO-first rule here", () => {
    const both = withPiles(30, 30);
    const fromIpo = room(both, EXCHANGE("Ipo"), P1);
    expect([corpOf(fromIpo, NYC).ipo_pool_percentage, corpOf(fromIpo, NYC).bank_pool_percentage]).toEqual([20, 30]);
    const fromPool = room(both, EXCHANGE("Bank"), P1);
    expect([corpOf(fromPool, NYC).ipo_pool_percentage, corpOf(fromPool, NYC).bank_pool_percentage]).toEqual([30, 20]);
  });

  it("2.4 NOTHING IS MINTED: an empty selected pile is refused, and the state comes back untouched", () => {
    const before = withPiles(0, 0);
    expect(room(before, EXCHANGE("Ipo"), P1).public_companies).toEqual(before.public_companies);
    expect(room(before, EXCHANGE("Bank"), P1).public_companies).toEqual(before.public_companies);
    // The clamp in `applyPrivateExchange` is the thing this refusal makes unreachable.
    expect(corpOf(room(before, EXCHANGE("Ipo"), P1), NYC).ipo_pool_percentage).toBe(0);
    expect(privOf(room(before, EXCHANGE("Ipo"), P1)).closed).toBe(false);
  });

  it("2.5 the source is never substituted at EXECUTION either -- `applyMhExchange` refuses rather than reroutes", () => {
    const poolOnly = withPiles(0, 30);
    expect(applyMhExchange(poolOnly, request(P1, "Ipo"), homeHexToAxial)).toBeNull();
    expect(corpOf(applyMhExchange(poolOnly, request(P1, "Bank"), homeHexToAxial)!, NYC).bank_pool_percentage).toBe(20);
  });
});

/* ================================================================================================================= */
/* 3. OWNERSHIP AND CERTIFICATE LIMITS, PROJECTED                                                                      */
/* ================================================================================================================= */

describe("3. 'provided he may hold another share' -- §4.3's two rules, on the board the exchange LEAVES (#1630a)", () => {
  it("3.1 the 60% cap refuses an exchange that would exceed it", () => {
    const before = board({
      round: "StockRound",
      seat: 0,
      // $100 is a Normal-zone price, so the cap is in force.
      corps: [nycFloating({ president: P1, ipo: 40, holdings: [[P1, 60]] })],
    });
    expect(mhExchangeRefusal(before, request(), P1)).toMatch(/no player may exceed 60%/);
    expect(heldBy(room(before, EXCHANGE(), P1), NYC, P1)).toBe(60);
  });

  it("3.2 the Orange/Brown zone exemption is preserved -- the same board, with the token in the Orange zone", () => {
    const orange = at(0, 6); // $32 -- an Orange-zone cell of the chart in effect
    const before = board({
      round: "StockRound",
      seat: 0,
      corps: [nycFloating({ president: P1, ipo: 40, holdings: [[P1, 60]], x: orange.x, y: orange.y })],
    });
    expect(mhExchangeRefusal(before, request(), P1)).toBeNull();
    expect(heldBy(room(before, EXCHANGE(), P1), NYC, P1)).toBe(70);
  });

  /** A board carrying `privateCount` open privates for P1 plus 13 corporate cards, every presidency ALREADY
   *  settled -- so the only thing the exchange changes about the count is the exchange itself. (An unsettled
   *  crown would move on the same `settlePresidencies` the arm runs and take a card with it, which is a real
   *  consequence of the exchange and would make this case measure two things at once.) */
  const limitBoard = (privateCount: number, nyc: Partial<Corp> = {}) =>
    board({
      round: "StockRound",
      seat: 0,
      privates: [
        { id: MH_PRIVATE_ID, name: "Mohawk & Hudson", owner: P1 },
        ...Array.from({ length: privateCount - 1 }, (_, n) => ({ id: 10 + n, name: `Filler ${n}`, owner: P1 })),
      ],
      corps: [
        // 9 cards for P1: a 20% president's certificate and eight 10%s.
        { id: PRR, ticker: "PRR", president: P1, x: 10, y: 7, arrival: 1, ipo: 0, holdings: [[P1, 100]] },
        // 4 more, and P3 keeps the crown on 60% -- nothing here is waiting to be re-settled.
        { id: BO, ticker: "B&O", president: P3, x: 7, y: 8, arrival: 3, ipo: 0, holdings: [[P3, 60], [P1, 40]] },
        nycFloating(nyc),
      ],
    });

  it("3.3 the certificate limit is judged on the PROJECTED count: a player exactly at the limit is NOT refused", () => {
    /* Three players -> a limit of 20. The board puts P1 exactly ON it with the M&H as one of the cards, so a
       naive "current + 1" would refuse a move that replaces one certificate with one certificate. */
    const before = limitBoard(7);
    const prices = { [PRR]: 110, [BO]: 90, [NYC]: 100 };
    const now = certificateBreakdown(P1, before, prices, marketZoneForPrice);
    // Premise: 7 privates + 9 PRR cards + 4 B&O cards = 20, exactly the limit.
    expect(now.limit).toBe(20);
    expect(now.counted).toBe(20);
    expect(mhExchangeRefusal(before, request(), P1)).toBeNull();

    const after = room(before, EXCHANGE(), P1);
    const then = certificateBreakdown(P1, after, prices, marketZoneForPrice);
    // One card out (the closed M&H), one card in (the NYC 10%): the count is unchanged, not increased.
    expect(then.counted).toBe(20);
    expect(privOf(after).closed).toBe(true);
    expect(heldBy(after, NYC, P1)).toBe(10);
  });

  it("3.4 an exchange that WOULD put the player over the limit is refused", () => {
    const before = limitBoard(8);
    const now = certificateBreakdown(P1, before, { [PRR]: 110, [BO]: 90, [NYC]: 100 }, marketZoneForPrice);
    expect(now.counted).toBe(21); // already over, by another rule's doing
    expect(mhExchangeRefusal(before, request(), P1)).toMatch(/against a limit of 20/);
    expect(privOf(room(before, EXCHANGE(), P1)).closed).toBe(false);
  });

  it("3.5 an exchange into a limit-EXEMPT zone frees a card, and is allowed from a board exactly at the limit", () => {
    const yellow = at(0, 8); // $46 -- a Yellow-zone price: certificates there do not count (#7)
    const before = limitBoard(7, { x: yellow.x, y: yellow.y });
    const prices = { [PRR]: 110, [BO]: 90, [NYC]: yellow.price };
    expect(certificateBreakdown(P1, before, prices, marketZoneForPrice).counted).toBe(20);
    expect(mhExchangeRefusal(before, request(), P1)).toBeNull();
    const after = room(before, EXCHANGE(), P1);
    const then = certificateBreakdown(P1, after, prices, marketZoneForPrice);
    expect([then.counted, then.exempt]).toEqual([19, 1]);
  });

  it("3.6 NOTHING from the purchase gate is applied: no price is paid, no `sold_this_round` lockout, no turn count", () => {
    const before = board({
      round: "StockRound",
      seat: 0,
      boughtThisTurn: 1,
      acted: true,
      soldThisRound: { [P1]: [NYC] },
      cash: { [P1]: 0 },
      corps: [nycFloating()],
    });
    expect(mhExchangeRefusal(before, request(), P1)).toBeNull();
    const after = room(before, EXCHANGE(), P1);
    expect(heldBy(after, NYC, P1)).toBe(10);
    expect(Number(after.player_cash.find((e) => e.player === P1)!.cash_vgp)).toBe(0);
  });
});

/* ================================================================================================================= */
/* 4. THE IMMEDIATE EXCHANGE IS INVISIBLE TO STOCK ROUND TURN ACCOUNTING (R1)                                          */
/* ================================================================================================================= */

describe("4. R1: a free interjection -- no purchase, no seat, no streak, no Priority Deal (#1630)", () => {
  const markers = (state: GameStateResponse) => ({
    seat: state.active_player_index,
    bought: state.bought_this_turn ?? 0,
    boughtCompany: state.bought_this_turn_company,
    stage: state.stock_turn_stage,
    acted: state.turn_action_taken ?? false,
    passes: state.consecutive_passes,
    priority: state.priority_deal_index,
    lastTrader: state.last_trader_index ?? null,
    sold: state.sold_this_round,
  });

  const own = (over: Partial<Parameters<typeof board>[0]> = {}) =>
    board({
      round: "StockRound",
      seat: 0,
      passes: 2,
      priority: 2,
      lastTrader: 1,
      corps: [prr(), nycFloating()],
      ...over,
    });

  it("4.1 every Stock Round marker is byte-identical before and after -- including the pass streak", () => {
    const before = own();
    const after = room(before, EXCHANGE(), P1);
    expect(markers(after)).toEqual(markers(before));
    expect(heldBy(after, NYC, P1)).toBe(10); // and the exchange really happened
  });

  it("4.2 exchange, then an ordinary purchase: the purchase is still available and is the turn's first", () => {
    const exchanged = room(own(), EXCHANGE(), P1);
    expect(exchanged.bought_this_turn ?? 0).toBe(0);
    const bought = room(exchanged, BUY(PRR), P1);
    expect(bought.bought_this_turn).toBe(1);
    expect(heldBy(bought, PRR, P1)).toBe(10);
  });

  it("4.3 an ordinary purchase, THEN the exchange: a player who has already bought may still use the power", () => {
    const bought = room(own(), BUY(PRR), P1);
    expect(bought.bought_this_turn).toBe(1);
    const exchanged = room(bought, EXCHANGE(), P1);
    expect(exchanged.bought_this_turn).toBe(1); // not consumed, not incremented
    expect(exchanged.bought_this_turn_company).toBe(bought.bought_this_turn_company);
    expect(exchanged.active_player_index).toBe(bought.active_player_index);
    expect(heldBy(exchanged, NYC, P1)).toBe(10);
  });

  it("4.4 the exchange does not convert a later Pass into activity -- the Pass still counts in the streak", () => {
    const before = own({ passes: 0 });
    const exchanged = room(before, EXCHANGE(), P1);
    expect(exchanged.turn_action_taken ?? false).toBe(false);
    const passed = endStockTurn(exchanged, P1);
    expect(passed.consecutive_passes).toBe(1);
    expect(passed.active_player_index).toBe(seatOf(passed, P2));
  });

  it("4.5 Sell-Buy-Sell is untouched: the stage the turn was in is the stage it is still in", () => {
    for (const stage of [undefined, "buy"] as const) {
      const before = own({ stage });
      const after = room(before, EXCHANGE(), P1);
      expect(after.stock_turn_stage).toBe(before.stock_turn_stage);
    }
  });
});

/* ================================================================================================================= */
/* 5. QUEUED IN A STOCK ROUND -- another player's turn is not interrupted                                             */
/* ================================================================================================================= */

describe("5. a request during another player's Stock Round turn QUEUES and settles at the turn's end (R1, #1633)", () => {
  const otherSeated = (over: Partial<Parameters<typeof board>[0]> = {}) =>
    board({
      round: "StockRound",
      seat: 1, // P2 is seated; P1 owns the M&H
      corps: [prr(), nycFloating()],
      ...over,
    });

  it("5.1 the request is recorded, and NOTHING else moves -- no share, no closure, no seat, no reservation", () => {
    const before = otherSeated();
    expect(mhExchangeDisposition(before, request())).toBe("queue");
    const after = room(before, EXCHANGE(), P1);
    expect(after.pending_mh_exchange).toEqual({ player: P1, private_id: MH_PRIVATE_ID, company_id: NYC, source: "Ipo" });
    expect(heldBy(after, NYC, P1)).toBe(0);
    expect(privOf(after).closed).toBe(false);
    expect(corpOf(after, NYC).ipo_pool_percentage).toBe(50); // the pile is NOT reserved
    expect(after.active_player_index).toBe(before.active_player_index);
    expect(after.consecutive_passes).toBe(before.consecutive_passes);
  });

  it("5.2 an untouched turn is STILL that player's turn -- `turn_action_taken === false` is not 'between turns'", () => {
    const before = otherSeated();
    expect(before.turn_action_taken ?? false).toBe(false);
    expect(before.stock_turn_stage).toBeUndefined();
    expect(mhExchangeDisposition(before, request())).toBe("queue");
  });

  it("5.3 the seated player's own actions are uninterrupted while the request stands", () => {
    const queued = room(otherSeated(), EXCHANGE(), P1);
    const bought = room(queued, BUY(PRR), P2);
    expect(heldBy(bought, PRR, P2)).toBe(50);
    expect(bought.pending_mh_exchange).toEqual(queued.pending_mh_exchange); // still only intent
    expect(heldBy(bought, NYC, P1)).toBe(0);
  });

  it("5.4 when that turn really ends, the exchange settles BEFORE the next player acts -- and the seat is unchanged by it", () => {
    const queued = room(otherSeated(), EXCHANGE(), P1);
    /* #1443: the first Pass walks P2's turn from SELL to BUY. The turn is still theirs, so this is NOT a
       boundary and the request must still be standing -- which is #1630c's rule, observed. */
    const midTurn = room(queued, PASS, P2);
    expect(midTurn.active_player_index).toBe(queued.active_player_index);
    expect(midTurn.pending_mh_exchange).toEqual(queued.pending_mh_exchange);
    expect(heldBy(midTurn, NYC, P1)).toBe(0);

    const passed = room(midTurn, PASS, P2);
    expect(passed.pending_mh_exchange).toBeNull();
    expect(heldBy(passed, NYC, P1)).toBe(10);
    expect(privOf(passed).closed).toBe(true);
    // The seat is where `recordPass` put it -- the settlement did not move it.
    expect(passed.active_player_index).toBe(seatOf(passed, P3));
    expect(passed.consecutive_passes).toBe(1);
  });

  it("5.5 if the NEXT player is the M&H owner, the exchange happens first and they still get a whole normal turn", () => {
    const queued = room(otherSeated({ seat: 2 }), EXCHANGE(), P1); // P3 seated; P1 is next
    const passed = endStockTurn(queued, P3);
    expect(passed.active_player_index).toBe(seatOf(passed, P1));
    expect(heldBy(passed, NYC, P1)).toBe(10);
    expect([passed.bought_this_turn ?? 0, passed.turn_action_taken ?? false]).toEqual([0, false]);
    const bought = room(passed, BUY(PRR), P1);
    expect(bought.bought_this_turn).toBe(1); // a full normal turn, unspent by the exchange
  });
});

/* ================================================================================================================= */
/* 6. THE SR -> OR BOUNDARY -- a float settled there IS in the round that opens                                        */
/* ================================================================================================================= */

describe("6. the queued exchange settles on the correct side of the OR membership freeze (#1633, §11 case C)", () => {
  /** Two passes in; one more closes the Stock Round. NYC is 50% out of the IPO and NOT floated. */
  const lastTurn = () =>
    board({
      round: "StockRound",
      seat: 2,
      passes: 2,
      corps: [
        prr(),
        nycFloating(),
      ],
    });

  it("6.1 the exchange floats NYC at the boundary, and NYC IS in the Operating Round that opens", () => {
    const queued = room(lastTurn(), EXCHANGE(), P1);
    expect(queued.pending_mh_exchange).not.toBeNull();
    // Premise: NYC is not floated and so is not in the queue this board would build.
    expect(corpOf(queued, NYC).is_floated).toBe(false);
    expect(buildOperatingOrder(queued)).toEqual([PRR]);

    const opened = endStockTurn(queued, P3);
    expect(opened.current_round_type).toBe("OperatingRound");
    expect(opened.pending_mh_exchange).toBeNull();
    expect(corpOf(opened, NYC).is_floated).toBe(true);
    expect([...opened.active_operating_order].sort((a, b) => a - b)).toEqual([PRR, NYC]);
    expect(privOf(opened).closed).toBe(true);
  });

  it("6.2 the float is a real float: capitalisation is paid exactly once, out of the bank", () => {
    const queued = room(lastTurn(), EXCHANGE(), P1);
    const bankBefore = Number(queued.virtual_bank_vgp);
    const opened = endStockTurn(queued, P3);
    // $100 par x 10 (#376), into a treasury that was $300 on the fixture.
    expect(Number(corpOf(opened, NYC).treasury)).toBe(300 + 1000);
    expect(Number(opened.virtual_bank_vgp)).toBe(bankBefore - 1000);
  });

  it("6.3 an exchange that does NOT reach the threshold floats nothing", () => {
    const short = board({
      round: "StockRound",
      seat: 2,
      passes: 2,
      corps: [
        prr(),
        nycFloating({ ipo: 70, holdings: [[P2, 30]] }),
      ],
    });
    const opened = endStockTurn(room(short, EXCHANGE(), P1), P3);
    expect(corpOf(opened, NYC).ipo_pool_percentage).toBe(60);
    expect(corpOf(opened, NYC).is_floated).toBe(false);
    expect(opened.active_operating_order).toEqual([PRR]);
  });

  it("6.4 a POOL-sourced exchange is not a newly sold IPO share and cannot float on its own", () => {
    const pooled = board({
      round: "StockRound",
      seat: 2,
      passes: 2,
      corps: [
        prr(),
        nycFloating({ ipo: 50, pool: 20, holdings: [[P2, 30]] }),
      ],
    });
    const opened = endStockTurn(room(pooled, EXCHANGE("Bank"), P1), P3);
    expect(corpOf(opened, NYC).ipo_pool_percentage).toBe(50); // untouched: the float measure did not move
    expect(corpOf(opened, NYC).bank_pool_percentage).toBe(10);
    expect(corpOf(opened, NYC).is_floated).toBe(false);
  });

  it("6.5 an already-floated NYC is not capitalised a second time", () => {
    const floated = board({
      round: "StockRound",
      seat: 2,
      passes: 2,
      corps: [
        prr(),
        nycFloating({ floated: true, ipo: 40, holdings: [[P2, 60]] }),
      ],
    });
    const queued = room(floated, EXCHANGE(), P1);
    const bankBefore = Number(queued.virtual_bank_vgp);
    const opened = endStockTurn(queued, P3);
    expect(Number(corpOf(opened, NYC).treasury)).toBe(300);
    expect(Number(opened.virtual_bank_vgp)).toBe(bankBefore);
  });
});

/* ================================================================================================================= */
/* 7. QUEUED IN AN OPERATING ROUND -- between corporations, never inside one                                          */
/* ================================================================================================================= */

describe("7. a request during a corporation's Operating turn QUEUES and settles at the corporation boundary (#1632)", () => {
  const or = (over: Partial<Parameters<typeof board>[0]> = {}) =>
    board({
      round: "OperatingRound",
      order: [PRR, BO],
      operating: PRR,
      corps: [
        { id: PRR, ticker: "PRR", president: P2, x: 10, y: 7, arrival: 1, station: true },
        { id: BO, ticker: "B&O", president: P3, x: 7, y: 8, arrival: 3, station: true },
        nycFloating(),
      ],
      ...over,
    });

  it("7.1 any corporation's turn queues -- including one the M&H owner presides over", () => {
    const mine = or({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, x: 10, y: 7, arrival: 1, station: true },
        { id: BO, ticker: "B&O", president: P3, x: 7, y: 8, arrival: 3, station: true },
        nycFloating(),
      ],
    });
    expect(mine.public_companies.find((c) => c.company_id === PRR)!.president).toBe(P1);
    expect(mhExchangeDisposition(mine, request())).toBe("queue");
    expect(room(mine, EXCHANGE(), P1).pending_mh_exchange).not.toBeNull();
  });

  it("7.2 it does NOT execute between the corporation's own steps", () => {
    const queued = room(or(), EXCHANGE(), P1);
    expect(queued.pending_mh_exchange).not.toBeNull();
    const stepped = room(queued, { AdvanceOperatingSubPhase: { game_id: 1 } }, P2);
    expect(stepped.pending_mh_exchange).toEqual(queued.pending_mh_exchange);
    expect(heldBy(stepped, NYC, P1)).toBe(0);
    expect(privOf(stepped).closed).toBe(false);
  });

  it("7.3 it settles only when the corporation's turn is complete, and the next corporation then acts", () => {
    const queued = room(or(), EXCHANGE(), P1);
    const advanced = room(queued, PASS, P2);
    expect(advanced.pending_mh_exchange).toBeNull();
    expect(heldBy(advanced, NYC, P1)).toBe(10);
    expect(advanced.active_operating_order[advanced.active_corporation_index]).toBe(BO);
  });

  it("7.4 a float settled mid-OR does NOT join the round already open -- membership is frozen (5.3)", () => {
    const queued = room(or(), EXCHANGE(), P1);
    const advanced = room(queued, PASS, P2);
    expect(corpOf(advanced, NYC).is_floated).toBe(true);
    expect(advanced.active_operating_order).toEqual([PRR, BO]);
    expect(advanced.active_operating_order).not.toContain(NYC);
    // And the queue `buildOperatingOrder` WOULD build now does contain it -- the exclusion is the rule, not an accident.
    expect(buildOperatingOrder(advanced)).toContain(NYC);
  });

  it("7.5 it settles at the END of the set too, before the Stock Round opens", () => {
    const last = or({ order: [PRR], operating: PRR });
    const queued = room(last, EXCHANGE(), P1);
    const ended = room(queued, PASS, P2);
    expect(ended.current_round_type).toBe("StockRound");
    expect(ended.pending_mh_exchange).toBeNull();
    expect(heldBy(ended, NYC, P1)).toBe(10);
  });
});

/* ================================================================================================================= */
/* 8. PRESIDENCY AND SEAT SYNC                                                                                        */
/* ================================================================================================================= */

describe("8. the presidency settles through the canonical Stage-8.3 authority, and the seat follows it (#1620)", () => {
  it("8.1 an exchange that does not exceed the incumbent moves no crown", () => {
    const before = board({
      round: "StockRound",
      seat: 0,
      corps: [nycFloating({ floated: true, president: P2, ipo: 20, holdings: [[P2, 50], [P1, 30]] })],
    });
    const after = room(before, EXCHANGE(), P1);
    expect(heldBy(after, NYC, P1)).toBe(40);
    expect(corpOf(after, NYC).president).toBe(P2);
  });

  it("8.2 an exchange that lifts the holder above the incumbent transfers the presidency immediately", () => {
    const before = board({
      round: "StockRound",
      seat: 0,
      corps: [nycFloating({ floated: true, president: P2, ipo: 20, holdings: [[P2, 30], [P1, 50]] })],
    });
    const after = room(before, EXCHANGE(), P1);
    expect(heldBy(after, NYC, P1)).toBe(60);
    expect(corpOf(after, NYC).president).toBe(P1);
  });

  it("8.3 a queued exchange that crowns the NEXT operating corporation's president seats the NEW president", () => {
    const before = board({
      round: "OperatingRound",
      order: [PRR, NYC],
      operating: PRR,
      corps: [
        { id: PRR, ticker: "PRR", president: P2, x: 10, y: 7, arrival: 1, station: true },
        nycFloating({ floated: true, president: P2, ipo: 20, holdings: [[P2, 30], [P1, 50]], x: 8, y: 7 }),
      ],
    });
    expect(before.active_operating_order).toEqual([PRR, NYC]);
    const queued = room(before, EXCHANGE(), P1);
    const advanced = room(queued, PASS, P2);
    // NYC is the corporation now operating, its president is P1, and the table is seated on P1.
    expect(advanced.active_operating_order[advanced.active_corporation_index]).toBe(NYC);
    expect(corpOf(advanced, NYC).president).toBe(P1);
    expect(advanced.active_player_index).toBe(seatOf(advanced, P1));
    // The ORDER is unchanged -- a presidency change does not reorder the round.
    expect(advanced.active_operating_order).toEqual([PRR, NYC]);
  });

  it("8.4 the President's Certificate never reaches a pool: an unparred NYC crowns nobody on the exchange", () => {
    const before = board({
      round: "StockRound",
      seat: 0,
      corps: [nycFloating({ floated: false, president: null, par: null, ipo: 100, holdings: [] })],
    });
    const after = room(before, EXCHANGE(), P1);
    expect(heldBy(after, NYC, P1)).toBe(10);
    expect(corpOf(after, NYC).ipo_pool_percentage).toBe(90);
    expect(corpOf(after, NYC).president).toBeNull();
    expect(corpOf(after, NYC).is_floated).toBe(false);
  });
});

/* ================================================================================================================= */
/* 9. QUEUING VESTS NOTHING -- revalidation, the first 5-train, and no source switch                                  */
/* ================================================================================================================= */

describe("9. revalidation at the boundary: the request is intent, and intent expires (R1 gotcha, #1630e)", () => {
  /** Every printed 4-train is out (three owned, one in the Bank Pool), so the depot's head is the FIRST 5 --
   *  the purchase that turns Phase 5 and closes every private company. */
  const or = () =>
    board({
      round: "OperatingRound",
      order: [PRR, BO],
      operating: PRR,
      step: "Hardware",
      returned: ["4"],
      corps: [
        prr({ station: true, trains: ["4"], treasury: "2000" }),
        { id: BO, ticker: "B&O", president: P3, x: 7, y: 8, arrival: 3, station: true, trains: ["4", "4"] },
        nycFloating(),
      ],
    });

  it("9.1 THE FIRST 5-TRAIN: Phase 5 closes the M&H, and the queued request retires with no share", () => {
    const queued = room(or(), EXCHANGE(), P1);
    expect(queued.pending_mh_exchange).not.toBeNull();

    const bought = room(queued, { BuyHardwareFromPool: { game_id: 1, protocol_id: PRR } }, P2);
    expect(corpOf(bought, PRR).owned_trains).toEqual(["4", "5"]); // premise: the head really was the first 5
    // Phase 5 closed every private immediately -- the request is untouched and still only intent.
    expect(privOf(bought).closed).toBe(true);
    expect(bought.pending_mh_exchange).toEqual(queued.pending_mh_exchange);
    expect(heldBy(bought, NYC, P1)).toBe(0);

    // At the next boundary revalidation finds the M&H closed and retires the request.
    expect(mhSettlementFor(bought, homeHexToAxial)).toEqual({
      kind: "retired",
      reason: expect.stringMatching(/already been exchanged or closed/),
    });
    const settled = room(bought, PASS, P2);
    expect(settled.pending_mh_exchange).toBeNull();
    expect(heldBy(settled, NYC, P1)).toBe(0);
    expect(corpOf(settled, NYC).ipo_pool_percentage).toBe(50);
    expect(privOf(settled).closed).toBe(true); // not resurrected
  });

  it("9.2 the chosen pile empties before settlement -> CANCEL, never a switch to the other pile", () => {
    const both = board({
      round: "StockRound",
      seat: 1,
      corps: [prr(), nycFloating({ ipo: 10, pool: 30, holdings: [[P2, 40], [P3, 20]] })],
    });
    const queued = room(both, EXCHANGE("Ipo"), P1);
    expect(queued.pending_mh_exchange!.source).toBe("Ipo");
    // P2 takes the last IPO share; the Bank Pool still holds three.
    const taken = room(queued, BUY(NYC, "Ipo"), P2);
    expect(corpOf(taken, NYC).ipo_pool_percentage).toBe(0);
    expect(corpOf(taken, NYC).bank_pool_percentage).toBe(30);

    const settled = endStockTurn(taken, P2);
    expect(settled.pending_mh_exchange).toBeNull();
    expect(heldBy(settled, NYC, P1)).toBe(0);
    expect(corpOf(settled, NYC).bank_pool_percentage).toBe(30); // NOT rerouted
    expect(privOf(settled).closed).toBe(false); // and the M&H survives, unspent
  });

  it("9.3 the reverse: a chosen POOL that empties does not fall back to the IPO", () => {
    const both = board({
      round: "StockRound",
      seat: 1,
      corps: [prr(), nycFloating({ ipo: 30, pool: 10, holdings: [[P2, 40], [P3, 20]] })],
    });
    const queued = room(both, EXCHANGE("Bank"), P1);
    const taken = room(queued, BUY(NYC, "Bank"), P2);
    expect(corpOf(taken, NYC).bank_pool_percentage).toBe(0);
    const settled = endStockTurn(taken, P2);
    expect(settled.pending_mh_exchange).toBeNull();
    expect(corpOf(settled, NYC).ipo_pool_percentage).toBe(30);
    expect(privOf(settled).closed).toBe(false);
  });

  it("9.4 the M&H changes hands before settlement -> CANCEL; the intent does not travel with the company", () => {
    const queued = room(
      board({
        round: "StockRound",
        seat: 1,
        corps: [prr(), nycFloating()],
      }),
      EXCHANGE(),
      P1,
    );
    const sold: GameStateResponse = {
      ...queued,
      private_companies: queued.private_companies.map((priv) =>
        priv.private_id === MH_PRIVATE_ID ? { ...priv, owner: P3 } : priv,
      ),
    };
    expect(mhSettlementFor(sold, homeHexToAxial)).toEqual({
      kind: "retired",
      reason: expect.stringMatching(/not yours to exchange/),
    });
    const settled = settleMhExchange(sold, homeHexToAxial);
    expect(settled.pending_mh_exchange).toBeNull();
    expect(heldBy(settled, NYC, P3)).toBe(0);
    expect(privOf(settled).closed).toBe(false);
  });

  it("9.5 a cancellation is not a failed turn: no seat, streak, Priority Deal or purchase marker moves", () => {
    const before = board({
      round: "StockRound",
      seat: 1,
      passes: 1,
      priority: 2,
      pending: { player: P1, private_id: MH_PRIVATE_ID, company_id: NYC, source: "Ipo" },
      privates: [{ id: MH_PRIVATE_ID, name: "Mohawk & Hudson", owner: P1, closed: true }],
      corps: [prr(), nycFloating()],
    });
    const settled = settleMhExchange(before, homeHexToAxial);
    expect(settled.pending_mh_exchange).toBeNull();
    expect({
      seat: settled.active_player_index,
      passes: settled.consecutive_passes,
      priority: settled.priority_deal_index,
      bought: settled.bought_this_turn ?? 0,
      acted: settled.turn_action_taken ?? false,
    }).toEqual({ seat: 1, passes: 1, priority: 2, bought: 0, acted: false });
    expect(settled.public_companies).toEqual(before.public_companies);
  });
});

/* ================================================================================================================= */
/* 10. HOLDS                                                                                                          */
/* ================================================================================================================= */

describe("10. the established holds keep their authority (owner ruling; #1613)", () => {
  /** A board where PRR is over the train limit -- the discard hold (#1530) stands. */
  const held = (over: Partial<Parameters<typeof board>[0]> = {}) =>
    board({
      round: "OperatingRound",
      order: [PRR, BO],
      operating: PRR,
      corps: [
        { id: PRR, ticker: "PRR", president: P2, x: 10, y: 7, arrival: 1, station: true, trains: ["2", "2", "2", "2", "2"] },
        { id: BO, ticker: "B&O", president: P3, x: 7, y: 8, arrival: 3, station: true },
        nycFloating(),
      ],
      ...over,
    });

  it("10.1 a request arriving while a hold STANDS is refused by the hold, and no request is recorded", () => {
    const before = held();
    // Premise: the hold is real -- ingress says so with the discard's own sentence.
    const refusal = turnRefusal({ state: before, waterfall: null, msg: EXCHANGE() as unknown as GameplayExecuteMsg, actor: P1 });
    expect(refusal).toMatch(/must discard before anything else happens/);
    const after = room(before, EXCHANGE(), P1);
    expect(after.pending_mh_exchange ?? null).toBeNull();
    expect(privOf(after).closed).toBe(false);
  });

  it("10.2 a request QUEUED FIRST survives a later hold, does not settle while it stands, and settles after", () => {
    /* Every printed 3-train is out, so the depot's head is the first 4: buying it turns Phase 4 and drops the
       train limit from four to three, which leaves the B&O -- holding four -- owing a discard (6.6.1). */
    const open = board({
      round: "OperatingRound",
      order: [PRR, BO],
      operating: PRR,
      step: "Hardware",
      corps: [
        prr({ station: true, trains: ["3"], treasury: "2000" }),
        { id: BO, ticker: "B&O", president: P3, x: 7, y: 8, arrival: 3, station: true, trains: ["3", "3", "3", "3"] },
        nycFloating(),
      ],
    });
    const queued = room(open, EXCHANGE(), P1);
    expect(queued.pending_mh_exchange).not.toBeNull();

    // A fifth train arrives and PRR is over the limit: the discard hold now stands.
    const overLimit = room(queued, { BuyHardwareFromPool: { game_id: 1, protocol_id: PRR } }, P2);
    expect(corpOf(overLimit, PRR).owned_trains).toEqual(["3", "4"]); // premise: the head really was the first 4
    expect(
      turnRefusal({ state: overLimit, waterfall: null, msg: PASS as GameplayExecuteMsg, actor: P2 }),
    ).toMatch(/must discard before anything else happens/);
    // The request survives untouched, and the boundary is not crossed: the held Pass is refused by the reducer too.
    expect(overLimit.pending_mh_exchange).toEqual(queued.pending_mh_exchange);
    const heldPass = room(overLimit, PASS, P2);
    expect(heldPass.pending_mh_exchange).toEqual(queued.pending_mh_exchange);
    expect(heldPass.active_corporation_index).toBe(overLimit.active_corporation_index);

    // Resolve the obligation, then reach the next true boundary: now it settles.
    const discarded = room(overLimit, { DiscardTrain: { game_id: 1, protocol_id: BO, model_type: "3" } }, P3);
    expect(discarded.pending_mh_exchange).toEqual(queued.pending_mh_exchange);
    const settled = room(discarded, PASS, P2);
    expect(settled.pending_mh_exchange).toBeNull();
    expect(heldBy(settled, NYC, P1)).toBe(10);
  });
});

/* ================================================================================================================= */
/* 11. INGRESS / REDUCER PARITY                                                                                       */
/* ================================================================================================================= */

describe("11. ingress and the reducer ask one predicate (#1630, #1249)", () => {
  const sr = (over: Partial<Parameters<typeof board>[0]> = {}) =>
    board({ round: "StockRound", seat: 0, corps: [nycFloating()], ...over });

  const ingress = (state: GameStateResponse, msg: unknown, actor: string) =>
    turnRefusal({ state, waterfall: null, msg: msg as GameplayExecuteMsg, actor });

  it("11.1 every refusal the reducer states, ingress states too -- and with the same sentence", () => {
    const cases: Array<[string, GameStateResponse, unknown, string]> = [
      ["a target that is not the NYC", sr(), EXCHANGE("Ipo", P1, 99), P1],
      ["keep_open", sr(), EXCHANGE("Ipo", P1, NYC, MH_PRIVATE_ID, { keep_open: true }), P1],
      ["an empty pile", sr({ corps: [nycFloating({ ipo: 0, pool: 0, holdings: [[P2, 100]] })] }), EXCHANGE("Ipo"), P1],
      ["the 60% cap", sr({ corps: [nycFloating({ president: P1, ipo: 40, holdings: [[P1, 60]] })] }), EXCHANGE("Ipo"), P1],
      ["a closed M&H", sr({ privates: [{ id: MH_PRIVATE_ID, name: "Mohawk & Hudson", owner: P1, closed: true }] }), EXCHANGE(), P1],
      [
        "a duplicate request",
        sr({ pending: { player: P1, private_id: MH_PRIVATE_ID, company_id: NYC, source: "Ipo" } }),
        EXCHANGE(),
        P1,
      ],
    ];
    for (const [name, state, msg, actor] of cases) {
      const body = (msg as { ExchangePrivate: Parameters<typeof mhExchangeRequestRefusal>[1] }).ExchangePrivate;
      const reducer = mhExchangeRequestRefusal(state, body, actor);
      expect(`${name}: ${reducer ?? "accepted"}`).toBe(`${name}: ${ingress(state, msg, actor) ?? "accepted"}`);
      expect(reducer).not.toBeNull();
    }
  });

  it("11.2 a LEGAL off-turn request is accepted by ingress -- queuing is an accepted message, not a refusal", () => {
    const offTurn = sr({ seat: 1 });
    expect(ingress(offTurn, EXCHANGE(), P1)).toBeNull();
    expect(room(offTurn, EXCHANGE(), P1).pending_mh_exchange).not.toBeNull();
  });
});

/* ================================================================================================================= */
/* 12. REPLAY AND REVERT                                                                                              */
/* ================================================================================================================= */

describe("12. the pending request is a function of the log (#1630)", () => {
  const seed = () =>
    board({
      round: "StockRound",
      seat: 1,
      corps: [prr(), nycFloating()],
    });

  const entry = (index: number, msg: unknown, actor: string): ReplayEntry => ({
    index,
    id: `e${index}`,
    actor,
    derived: false,
    at: 1000 + index,
    /* #1188: `ReplayEntry.payload` is JSON TEXT, minted once by the dispatching client -- not a nested object. */
    payload: JSON.stringify(msg),
  });

  /** The server's reducer path: `RoomEngine.apply`, entry by entry, from a seeded board. */
  function replay(entries: ReplayEntry[], from: GameStateResponse): GameStateResponse[] {
    const engine = new RoomEngine(sandboxReplayProviders(), { state: from, waterfall: null });
    return entries.map((one) => {
      engine.apply(one);
      return engine.snapshot.state;
    });
  }

  it("12.1 replaying the request rebuilds the same pending state, and replaying the boundary settles it identically", () => {
    const from = seed();
    const live = room(from, EXCHANGE(), P1);
    const settled = endStockTurn(live, P2);
    const [replayedRequest, , replayedBoundary] = replay(
      [entry(1, EXCHANGE(), P1), entry(2, PASS, P2), entry(3, PASS, P2)],
      from,
    );
    expect(replayedRequest.pending_mh_exchange).toEqual(live.pending_mh_exchange);
    expect(replayedBoundary.pending_mh_exchange).toBeNull();
    expect(heldBy(replayedBoundary, NYC, P1)).toBe(heldBy(settled, NYC, P1));
    expect(privOf(replayedBoundary).closed).toBe(privOf(settled).closed);
    expect(corpOf(replayedBoundary, NYC).is_floated).toBe(corpOf(settled, NYC).is_floated);
  });

  it("12.2 REVERT: before the request -> no pending; after it -> pending restored; after the boundary -> settled", () => {
    const from = seed();
    const states = replay([entry(1, EXCHANGE(), P1), entry(2, PASS, P2), entry(3, PASS, P2)], from);
    // A revert rebuilds from the surviving prefix, which is exactly a shorter replay of the same entries.
    expect(from.pending_mh_exchange ?? null).toBeNull();
    expect(replay([entry(1, EXCHANGE(), P1)], from)[0].pending_mh_exchange).toEqual(states[0].pending_mh_exchange);
    // Reverted to after the request but before the boundary: the request is back, unsettled.
    expect(states[1].pending_mh_exchange).toEqual(states[0].pending_mh_exchange);
    expect(heldBy(states[1], NYC, P1)).toBe(0);
    // Reverted to after the boundary: the settled result.
    expect(states[2].pending_mh_exchange).toBeNull();
    expect(heldBy(states[2], NYC, P1)).toBe(10);
  });

  it("12.3 a board with no `pending_mh_exchange` field at all deserialises and replays normally (#232)", () => {
    const legacy = seed();
    expect("pending_mh_exchange" in legacy).toBe(false);
    const after = endStockTurn(legacy, P2);
    expect(after.pending_mh_exchange ?? null).toBeNull();
    expect(after.active_player_index).toBe(seatOf(after, P3));
  });
});

/* ================================================================================================================= */
/* 13. BEFORE NYC IS STARTED -- the printed pre-presidency exchange, and the sale restriction that follows it         */
/* ================================================================================================================= */

describe("13. the exchange BEFORE NYC's President's Certificate has been purchased (p. 15 / p. 27, #1634)", () => {
  /** NYC unstarted: no par, no president, the President's 20% and eight ordinary 10%s all still in the IPO. */
  const unstarted = (over: Partial<Parameters<typeof board>[0]> = {}) =>
    board({
      round: "StockRound",
      seat: 0,
      corps: [
        prr(),
        nycFloating({ floated: false, president: null, par: null, ipo: 100, pool: 0, holdings: [] }),
      ],
      ...over,
    });

  it("13.1 the exchange is LEGAL: an unstarted NYC's IPO holds ordinary 10%s beside the President's Certificate", () => {
    const before = unstarted();
    // Premises: NYC is genuinely unstarted, and the IPO holds the whole corporation.
    expect(corpOf(before, NYC).par_value).toBeNull();
    expect(corpOf(before, NYC).president).toBeNull();
    expect(corpOf(before, NYC).ipo_pool_percentage).toBe(100);
    expect(isPresidentPurchase(corpOf(before, NYC), "Ipo")).toBe(true);
    /* 100% minus the President's 20% is 80% of ordinary cards -- eight of them. The exchange asks for one. */
    expect(ordinaryPercentAvailable(corpOf(before, NYC), "Ipo")).toBe(80);

    expect(mhSourceRefusal(corpOf(before, NYC), "Ipo")).toBeNull();
    expect(mhExchangeRequestRefusal(before, request(), P1)).toBeNull();
    expect(turnRefusal({ state: before, waterfall: null, msg: EXCHANGE() as unknown as GameplayExecuteMsg, actor: P1 })).toBeNull();
  });

  it("13.2 it delivers exactly one ordinary 10%, closes the M&H, and starts nothing", () => {
    const before = unstarted();
    const cashBefore = before.player_cash.map((entry) => `${entry.player}:${entry.cash_vgp}`);
    const after = room(before, EXCHANGE(), P1);
    const nyc = corpOf(after, NYC);

    expect(heldBy(after, NYC, P1)).toBe(10);
    expect(privOf(after).closed).toBe(true);
    expect(privOf(after).owner).toBeNull();
    // NYC is exactly as unstarted as it was: no par invented, no president crowned, not floated.
    expect(nyc.par_value).toBeNull();
    expect(nyc.president).toBeNull();
    expect(nyc.is_floated).toBe(false);
    // The President's Certificate is still in the IPO and still buyable: 90% left, 70% of it ordinary.
    expect(nyc.ipo_pool_percentage).toBe(90);
    expect(ordinaryPercentAvailable(nyc, "Ipo")).toBe(70);
    expect(isPresidentPurchase(nyc, "Ipo")).toBe(true);
    // Nothing was paid, by anybody, to anybody.
    expect(after.player_cash.map((entry) => `${entry.player}:${entry.cash_vgp}`)).toEqual(cashBefore);
    expect(after.virtual_bank_vgp).toBe(before.virtual_bank_vgp);
    // And no Stock Round marker moved -- R1 holds here exactly as it does on a started corporation.
    expect({
      seat: after.active_player_index,
      bought: after.bought_this_turn ?? 0,
      acted: after.turn_action_taken ?? false,
      passes: after.consecutive_passes,
      priority: after.priority_deal_index,
      stage: after.stock_turn_stage,
    }).toEqual({ seat: 0, bought: 0, acted: false, passes: 0, priority: 0, stage: undefined });
  });

  it("13.3 the certificate it takes is an ORDINARY one: a pile holding only the President's 20% is refused", () => {
    /* NOT REACHABLE IN ORDINARY PLAY -- an unstarted corporation's IPO is 100%, because nothing can be bought
       before the President's Certificate and no share of an unparred corporation can be sold into the pool
       (13.6). It IS reachable by a hand-built or replayed message, which is what this predicate is for. */
    const rigged = board({
      round: "StockRound",
      seat: 0,
      corps: [prr(), nycFloating({ floated: false, president: null, par: null, ipo: 20, pool: 0, holdings: [[P2, 80]] })],
    });
    expect(ordinaryPercentAvailable(corpOf(rigged, NYC), "Ipo")).toBe(0);
    expect(mhSourceRefusal(corpOf(rigged, NYC), "Ipo")).toMatch(/President's Certificate is not an ordinary share/);
    const after = room(rigged, EXCHANGE(), P1);
    expect(heldBy(after, NYC, P1)).toBe(0);
    expect(corpOf(after, NYC).ipo_pool_percentage).toBe(20);
    expect(privOf(after).closed).toBe(false);
  });

  it("13.4 the 10% counts toward the float threshold exactly as any other share out of the IPO does", () => {
    /* The float measure is "out of the IPO" (#749), and a pre-presidency exchange moves it like any other
       withdrawal -- it just cannot reach 60% on its own from a full IPO, which is what this asserts. */
    const after = room(unstarted(), EXCHANGE(), P1);
    expect(soldFromIpoPercent(corpOf(after, NYC))).toBe(10);
    expect(metFloatThreshold(corpOf(after, NYC))).toBe(false);
    // And on a board already at 50% out, the same exchange is the sixtieth percent and floats it (§6 covers
    // the round-boundary case; this is the same arithmetic asserted on the measure itself).
    const nearly = room(board({ round: "StockRound", seat: 0, corps: [prr(), nycFloating()] }), EXCHANGE(), P1);
    expect(soldFromIpoPercent(corpOf(nearly, NYC))).toBe(60);
    expect(metFloatThreshold(corpOf(nearly, NYC))).toBe(true);
  });

  it("13.5 THE SALE RESTRICTION: the share it delivered cannot be sold until NYC's President's Certificate is bought", () => {
    const after = room(unstarted(), EXCHANGE(), P1);
    expect(heldBy(after, NYC, P1)).toBe(10);
    /* Refused by the EXISTING 7.2 authority, on the board fact rather than on any M&H special case (S8-8):
       "an unparred corporation has no price, so there is nothing a sale could be settled at, and that is true
       of every share of it however it was come by". No new rule was added for the exchange. */
    const refusal = stockSaleRefusal({
      state: after,
      sell: { companyId: NYC, percentage: 10 },
      actor: P1,
      ctx: chartContextFromState(after),
    });
    expect(refusal).toMatch(/has not been started yet/);
    expect(refusal).toMatch(/President's Certificate has been bought/);
    // Ingress says the same thing, and the reducer moves nothing.
    expect(
      turnRefusal({
        state: after,
        waterfall: null,
        msg: { SellStock: { game_id: 1, protocol_id: NYC, percentage: 10 } } as unknown as GameplayExecuteMsg,
        actor: P1,
      }),
    ).toMatch(/has not been started yet/);
    const sold = room(after, { SellStock: { game_id: 1, protocol_id: NYC, percentage: 10 } }, P1);
    expect(heldBy(sold, NYC, P1)).toBe(10);
    expect(corpOf(sold, NYC).bank_pool_percentage).toBe(0);
  });

  it("13.6 and that restriction is why an unstarted corporation's shares can never reach the Bank Pool", () => {
    /* Traced rather than constructed (no malformed board is built to test it): every route into the Bank Pool
       is a SALE -- the ordinary `SellStock`, the Batch-5 forced sale, the forced divestment, the LPF
       half-sale -- and `stockSaleRefusal` rule 4 refuses every sale of a corporation with no par, in a Stock
       Round and in the Operating Round's forced-sale exception alike. So "an ordinary NYC 10% in the Bank
       Pool before NYC is parred" has no reachable history, and the exchange needs no special pre-par Pool
       rule: the ordinary source check already answers it. */
    const after = room(unstarted(), EXCHANGE(), P1);
    for (const round of ["StockRound", "OperatingRound"] as const) {
      const refusal = stockSaleRefusal({
        state: { ...after, current_round_type: round },
        sell: { companyId: NYC, percentage: 10 },
        actor: P1,
        ctx: chartContextFromState(after),
      });
      expect(`${round}: ${refusal === null ? "ALLOWED" : "refused"}`).toBe(`${round}: refused`);
    }
    expect(corpOf(after, NYC).bank_pool_percentage).toBe(0);
  });

  it("13.7 once NYC IS started, the ordinary sale authority behaves normally -- the share is not marked by its origin", () => {
    /* The same share, on a board where the President's Certificate has since been bought: P1's 10% arrived by
       exchange and the M&H is long closed, and the sale is judged by the ordinary rules and nothing else. */
    const exchanged = room(unstarted(), EXCHANGE(), P1);
    expect(privOf(exchanged).closed).toBe(true);
    const started: GameStateResponse = {
      ...exchanged,
      public_companies: exchanged.public_companies.map((company) =>
        company.company_id === NYC
          ? {
              ...company,
              par_value: "100",
              president: P2,
              ipo_pool_percentage: 70,
              player_holdings: [...company.player_holdings, { player: P2, percentage: 20 }],
            }
          : company,
      ),
    };
    // Premises: started, presided, and P1 still holds precisely the certificate the exchange delivered.
    expect(isPresidentPurchase(corpOf(started, NYC), "Ipo")).toBe(false);
    expect(heldBy(started, NYC, P1)).toBe(10);
    expect(privOf(started).closed).toBe(true);

    expect(
      stockSaleRefusal({
        state: started,
        sell: { companyId: NYC, percentage: 10 },
        actor: P1,
        ctx: chartContextFromState(started),
      }),
    ).toBeNull();
    const sold = room(started, { SellStock: { game_id: 1, protocol_id: NYC, percentage: 10 } }, P1);
    expect(heldBy(sold, NYC, P1)).toBe(0);
    expect(corpOf(sold, NYC).bank_pool_percentage).toBe(10);

    // And the restriction is the BOARD's, not the share's: the same sale on the unstarted board is refused,
    // and the only difference between the two boards is that NYC has been started.
    expect(
      stockSaleRefusal({
        state: exchanged,
        sell: { companyId: NYC, percentage: 10 },
        actor: P1,
        ctx: chartContextFromState(exchanged),
      }),
    ).toMatch(/has not been started yet/);
  });
});
