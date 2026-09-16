/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1600 (harness): THE OPERATING QUEUE, SETTLED ONCE PER ENTRY (Stage 8.1)
// ==================================================================
//
// S8-1: the queue that opens an Operating Round is read off the COMMITTED post-rise chart. S8-3: during the round a
// not-yet-operated corporation's new share value decides its place among the corporations still waiting, while the
// operated corporations and the one operating now never move (owner ruling R4, D-32). And the safety the
// representation promises: membership frozen at the opening, the cursor / seat / `turnGuardKey` stable for a whole
// turn, no corporation operating twice or skipped, the order reproduced by replay.
//
// EVERY BOARD CARRIES A CHART ON REAL CELLS of the standard 1830 market, and every premise a case depends on (a price,
// the cell a rise or a sale lands on, the order a whole-queue re-sort WOULD produce) is asserted against the chart
// before the case relies on it -- so a chart change fails here loudly instead of quietly testing something else.
// Messages go through `applySandboxAction` with the room's own injections (`sandboxReplayProviders`), and the replay
// cases through `RoomEngine.apply`, which is the server's reducer path.

import { applySandboxAction } from "../gameEngine/sandboxSession";
import {
  buildOperatingOrder,
  compareOperatingOrder,
  operatingOrderKey,
  operatingRoundOpenedBetween,
  settleOperatingQueue,
} from "../gameEngine/operatingOrder";
import { operatingCorporationId } from "../gameEngine/dividendGate";
import { emergencyFundingFor } from "../gameEngine/emergencyFunding";
import { derivedEntryKey, nextDerivedAction } from "../gameEngine/derivedActions";
import { RoomEngine, type ReplayEntry } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { stateDigest } from "../gameEngine/stateDigest";
import { operatingTurnKey, turnGuardKey } from "../gameEngine/turnGuardKey";
import { projectDividendCellMove, projectRiseMove, projectShareSaleMove } from "../gameEngine/marketGeometry";
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
const CO = 5;
const ERIE = 6;
const BM = 8;

/* ---- the chart and the board ------------------------------------------------------------------------------------- */

/** A real cell of the chart in effect, or a loud failure. */
function at(x: number, y: number): { x: number; y: number; price: number } {
  const cell = cellAt(x, y);
  if (!cell) throw new Error(`no chart cell at (${x}, ${y})`);
  return { x, y, price: cell.price };
}

/* The board's hexes are a live binding (#1300): derive them inside the calls that need them, never at import. */
const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
const EMPTY_GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
/** Batch 5's corridor: tile 57 on H16, tile 7 on I17 -- a corporation with a station on H16 has a route to run. */
function corridor(): MapGridResponse {
  const H16 = hex("H16");
  const I17 = hex("I17");
  return {
    game_id: 1,
    tiles: [
      { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
      { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
    ],
  } as unknown as MapGridResponse;
}

interface Corp {
  id: number;
  ticker: string;
  president: string;
  /** The chart cell and the arrival ordinal (#646) the corporation's token holds. */
  x: number;
  y: number;
  arrival: number;
  holdings?: Array<[string, number]>;
  trains?: string[];
  treasury?: string;
  /** IPO / Bank Pool percentages; both 0 (the default) is "sold out". */
  ipo?: number;
  pool?: number;
  floated?: boolean;
  lastRun?: string;
  /** A station on H16 -- with the corridor, a route to run. */
  station?: boolean;
}

function board(input: {
  round: "OperatingRound" | "StockRound";
  corps: Corp[];
  /** Operating Round: the queue (defaults to `corps` order) and the corporation under the cursor. */
  order?: number[];
  operating?: number;
  step?: string;
  cash?: Record<string, number>;
  /** Stock Round: the seat and the pass streak (three players: 2 passes + this pass closes the round). */
  seat?: number;
  passes?: number;
}): GameStateResponse {
  const H16 = hex("H16");
  const players = [P1, P2, P3];
  const inOr = input.round === "OperatingRound";
  const order = inOr ? input.order ?? input.corps.map((corp) => corp.id) : [];
  const index = inOr ? Math.max(0, order.indexOf(input.operating ?? order[0])) : 0;
  const operatingPresident = inOr ? input.corps.find((corp) => corp.id === order[index])?.president : undefined;
  return {
    game_id: 1,
    player_addresses: players,
    player_cash: players.map((player) => ({ player, cash_vgp: String(input.cash?.[player] ?? 300) })),
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: input.round,
    macro_round_number: 3,
    active_player_index: inOr ? Math.max(0, players.indexOf(operatingPresident ?? P1)) : input.seat ?? 0,
    priority_deal_index: 0,
    last_trader_index: null,
    consecutive_passes: inOr ? 0 : input.passes ?? 2,
    active_operating_order: order,
    active_corporation_index: index,
    sub_round_index: inOr ? 1 : 0,
    operating_round_sequence_length: 1,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    ...(inOr ? { operating_sub_phase: input.step ?? "Track" } : {}),
    market_positions: Object.fromEntries(
      input.corps.map((corp) => [corp.id, { ...at(corp.x, corp.y), enteredAt: corp.arrival }]),
    ),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: corp.floated ?? true,
      president: corp.president,
      par_value: "100",
      ipo_pool_percentage: corp.ipo ?? 0,
      bank_pool_percentage: corp.pool ?? 0,
      treasury: corp.treasury ?? "300",
      owned_trains: corp.trains ?? [],
      player_holdings: (corp.holdings ?? [[corp.president, 60]]).map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: corp.station ? [[H16.q, H16.r]] : [],
      station_tokens: corp.station ? [[H16.q, H16.r, 0]] : [],
      station_token_limit: 3,
      // No home label: a labelled corporation with no token owes its home (#763); these boards are about the order.
      home_hex_label: null,
      last_route_revenue: corp.lastRun ?? "0",
    })),
  } as unknown as GameStateResponse;
}

/** The reducer as a room's engine calls it: the providers' injections, the author, the grid (`RoomEngine.apply`). */
function room(state: GameStateResponse, msg: unknown, actor: string, mapGrid: MapGridResponse = EMPTY_GRID): GameStateResponse {
  const providers = sandboxReplayProviders();
  return applySandboxAction(state, msg as GameplayExecuteMsg, {
    ...providers.chartInjections(state),
    actor,
    mapGrid,
    marketContext: providers.marketContext(state, msg as GameplayExecuteMsg, actor),
    parCellFor: providers.parCellFor,
  });
}

const PASS = { PassTurn: { game_id: 1 } };
const SELL = (id: number, percentage: number) => ({ SellStock: { game_id: 1, protocol_id: id, percentage } });
const EMERGENCY = (id: number) => ({ EmergencyBuyHardware: { game_id: 1, protocol_id: id } });
const DIVIDEND = (id: number, distribute: boolean, revenue: string) => ({
  DeclareDividends: { game_id: 1, protocol_id: id, distribute, revenue_amount: revenue },
});

const queue = (state: GameStateResponse) => [...state.active_operating_order];
/** The president of the corporation under the cursor -- the author of that corporation's End Turn. */
const operatingPresident = (state: GameStateResponse): string => {
  const operating = operatingCorporationId(state);
  return state.public_companies.find((entry) => entry.company_id === operating)!.president!;
};
const mark = (state: GameStateResponse, id: number) => state.market_positions![id]!;
const seatOf = (state: GameStateResponse, player: string) => state.player_addresses.indexOf(player);
const cashOf = (state: GameStateResponse, player: string) =>
  Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);
/** What a WHOLE-queue re-sort of this board would say -- the order the frozen prefix must NOT be rewritten to. */
const wholeSort = (state: GameStateResponse) => buildOperatingOrder({ ...state, current_round_type: "OperatingRound" });

/* ================================================================================================================== */
/* S8-1 -- the opening queue is read off the committed, post-rise chart                                                */
/* ================================================================================================================== */

describe("S8-1: the queue that opens an Operating Round is the 6.0 order of the COMMITTED post-rise chart (#1600)", () => {
  /** Stock Round, two passes in: NYC ($100) is sold out; PRR ($110) and B&O ($90) are not. */
  function overtake(): GameStateResponse {
    return board({
      round: "StockRound",
      seat: 2,
      corps: [
        { id: PRR, ticker: "PRR", president: P1, x: 10, y: 7, arrival: 1, ipo: 40 },
        { id: NYC, ticker: "NYC", president: P2, x: 9, y: 7, arrival: 2 },
        { id: BO, ticker: "B&O", president: P3, x: 7, y: 8, arrival: 3, ipo: 40 },
      ],
    });
  }

  it("1. a sold-out rise that overtakes the leader decides who operates first, and the table is seated there", () => {
    const before = overtake();
    // Premises, off the chart: NYC rises one row from $100 to $111, past PRR's $110. Without the rise PRR leads.
    expect([mark(before, PRR).price, mark(before, NYC).price, mark(before, BO).price]).toEqual([110, 100, 90]);
    expect(projectRiseMove(mark(before, NYC))).toEqual({ x: 9, y: 8, price: 111 });
    expect(wholeSort(before)).toEqual([PRR, NYC, BO]);

    const after = room(before, PASS, P3);
    expect(after.current_round_type).toBe("OperatingRound");
    expect(after.active_corporation_index).toBe(0);
    expect(queue(after)).toEqual([NYC, PRR, BO]);
    expect(operatingCorporationId(after)).toBe(NYC);
    // `syncSeatToActingCorporation` ran on the FINAL order: NYC's president holds the seat, not PRR's.
    expect(after.active_player_index).toBe(seatOf(after, P2));
    // The derived loop and every other reader of the cursor see NYC's turn.
    expect(derivedEntryKey(after, PASS as GameplayExecuteMsg)).toBe(turnGuardKey(after, NYC, after.operating_sub_phase!));
  });

  it("2. the opening queue equals the 6.0 sort of the committed positions -- the rise is on the state it is read from", () => {
    const before = overtake();
    const after = room(before, PASS, P3);
    // The rise is COMMITTED (and stamped as the next arrival, #646) ...
    expect(mark(after, NYC)).toEqual({ x: 9, y: 8, price: 111, enteredAt: 4 });
    // ... and the queue is exactly the canonical order of that chart ...
    expect(queue(after)).toEqual(buildOperatingOrder(after));
    const keyOf = (id: number) => operatingOrderKey(id, mark(after, id).price, "100", mark(after, id));
    expect(queue(after)).toEqual([...queue(after)].sort((a, b) => compareOperatingOrder(keyOf(a), keyOf(b))));
    // ... not of the pre-rise chart, which is what the retired #746a overlay let the queue lock on.
    expect(queue(after)).not.toEqual(wholeSort(before));
    // Membership: every floated corporation with a president, once each.
    expect([...queue(after)].sort((a, b) => a - b)).toEqual([PRR, NYC, BO]);
    expect(operatingRoundOpenedBetween(before, after)).toBe(true);
  });

  it("3. equal share values in different columns: the rightmost operates first -- decided on the risen cell", () => {
    const before = board({
      round: "StockRound",
      seat: 2,
      corps: [
        { id: PRR, ticker: "PRR", president: P1, x: 8, y: 8, arrival: 1, ipo: 40 },
        { id: NYC, ticker: "NYC", president: P2, x: 9, y: 6, arrival: 2 },
      ],
    });
    // Premises: PRR $100 in column 8; NYC $90 rises to $100 in column 9.
    expect(mark(before, PRR).price).toBe(100);
    expect(projectRiseMove(mark(before, NYC))).toEqual({ x: 9, y: 7, price: 100 });
    expect(wholeSort(before)).toEqual([PRR, NYC]);

    const after = room(before, PASS, P3);
    expect(mark(after, NYC)).toMatchObject({ x: 9, y: 7, price: 100 });
    expect(queue(after)).toEqual([NYC, PRR]);
    expect(after.active_player_index).toBe(seatOf(after, P2));
  });

  it("4. equal share values in one column: the uppermost operates first -- decided on the risen cell", () => {
    const before = board({
      round: "StockRound",
      seat: 2,
      corps: [
        // Both on the $67 cell of column 6, row 4; PRR on top of the stack.
        { id: PRR, ticker: "PRR", president: P1, x: 6, y: 4, arrival: 1, ipo: 40 },
        { id: NYC, ticker: "NYC", president: P2, x: 6, y: 4, arrival: 2 },
      ],
    });
    // Premises: column 6 repeats $67 on rows 3, 4 and 5 -- NYC's rise keeps its price and gains a row.
    expect(mark(before, PRR).price).toBe(67);
    expect(projectRiseMove(mark(before, NYC))).toEqual({ x: 6, y: 5, price: 67 });
    expect(wholeSort(before)).toEqual([PRR, NYC]); // one cell: the token on top first

    const after = room(before, PASS, P3);
    expect(mark(after, NYC)).toMatchObject({ x: 6, y: 5, price: 67 });
    expect(queue(after)).toEqual([NYC, PRR]);
  });

  it("5. one cell: the token on top operates first, and a riser arriving there joins the bottom of the stack", () => {
    const before = board({
      round: "StockRound",
      seat: 2,
      corps: [
        { id: PRR, ticker: "PRR", president: P1, x: 8, y: 8, arrival: 5, ipo: 40 },
        { id: BM, ticker: "B&M", president: P3, x: 8, y: 8, arrival: 2, ipo: 40 },
        { id: NYC, ticker: "NYC", president: P2, x: 8, y: 7, arrival: 1 },
      ],
    });
    // Premises: B&M sits on top of PRR on the $100 cell; NYC ($90) rises INTO that cell.
    expect(mark(before, PRR).price).toBe(100);
    expect(projectRiseMove(mark(before, NYC))).toEqual({ x: 8, y: 8, price: 100 });

    const after = room(before, PASS, P3);
    expect(mark(after, NYC)).toEqual({ x: 8, y: 8, price: 100, enteredAt: 6 });
    // Stack order (earliest arrival on top), not company id order ([PRR, NYC, B&M]) and not catalog order.
    expect(queue(after)).toEqual([BM, PRR, NYC]);
    expect(queue(after)).toEqual(buildOperatingOrder(after));
    expect(after.active_player_index).toBe(seatOf(after, P3));
  });
});

/* ================================================================================================================== */
/* S8-3 -- the running round: frozen prefix, dynamic tail                                                               */
/* ================================================================================================================== */

/** C&O (P1) operating at Hardware with no train, a route through the corridor, $30 and P1's $20: the 2-train costs $80,
 *  so the forced purchase is owed with a $30 shortfall and P1 must sell (Batch 5) -- the one engine path that moves a
 *  not-yet-operated corporation's token during an Operating Round. */
const RESCUED: Corp = { id: CO, ticker: "C&O", president: P1, x: 11, y: 8, arrival: 1, treasury: "30", holdings: [[P1, 60]], station: true };
function rescueBoard(corps: Corp[], operating = CO): GameStateResponse {
  return board({ round: "OperatingRound", step: "Hardware", operating, cash: { [P1]: 20, [P2]: 300, [P3]: 300 }, corps });
}

describe("S8-3: during a round only the not-yet-operated tail is re-sorted, on the current chart (#1600)", () => {
  /** C&O $140 operating; waiting NYC $111 (P1 holds 20 %), PRR $110, B&O $100. */
  function aheadBoard(): GameStateResponse {
    return rescueBoard([
      RESCUED,
      { id: NYC, ticker: "NYC", president: P2, x: 9, y: 8, arrival: 2, holdings: [[P2, 30], [P1, 20]] },
      { id: PRR, ticker: "PRR", president: P3, x: 10, y: 7, arrival: 3, holdings: [[P3, 40]] },
      { id: BO, ticker: "B&O", president: P3, x: 8, y: 8, arrival: 4, holdings: [[P3, 60]] },
    ]);
  }

  it("6. a forced sale moves a not-yet-operated corporation AHEAD of another waiting corporation", () => {
    const before = aheadBoard();
    // Premises: a log-shaped board (the queue is the chart's order), the forced purchase owed, and NYC's sale landing
    // on $100 -- below PRR's $110, still above B&O's $100 by column.
    expect([140, 111, 110, 100]).toEqual([CO, NYC, PRR, BO].map((id) => mark(before, id).price));
    expect(queue(before)).toEqual(wholeSort(before));
    expect(emergencyFundingFor(before, corridor())).toMatchObject({ companyId: CO, shortfall: 30, canPurchase: false });
    expect(projectShareSaleMove(mark(before, NYC), 1)).toEqual({ x: 9, y: 7, price: 100 });

    const after = room(before, SELL(NYC, 10), P1, corridor());
    expect(cashOf(after, P1)).toBe(20 + 111); // the sale happened, at the price before the drop
    expect(mark(after, NYC)).toMatchObject({ x: 9, y: 7, price: 100 });
    // PRR now waits ahead of NYC; B&O keeps its place; C&O is untouched at the cursor.
    expect(queue(after)).toEqual([CO, PRR, NYC, BO]);
    expect(after.active_corporation_index).toBe(0);
    expect(operatingCorporationId(after)).toBe(CO);
    expect(after.active_player_index).toBe(seatOf(after, P1));
    expect(queue(after).slice(1)).toEqual(buildOperatingOrder(after).filter((id) => id !== CO));
  });

  it("7. a forced sale moves a not-yet-operated corporation BEHIND another waiting corporation", () => {
    const before = rescueBoard([
      RESCUED,
      { id: NYC, ticker: "NYC", president: P2, x: 9, y: 8, arrival: 2, holdings: [[P2, 60]] },
      { id: PRR, ticker: "PRR", president: P3, x: 7, y: 9, arrival: 3, holdings: [[P3, 40], [P1, 10]] },
      { id: BO, ticker: "B&O", president: P3, x: 8, y: 7, arrival: 4, holdings: [[P3, 60]] },
    ]);
    // Premises: C&O $140, NYC $111, PRR $100 (column 7), B&O $90 (column 8); PRR's sale lands on $90 in column 7.
    expect([140, 111, 100, 90]).toEqual([CO, NYC, PRR, BO].map((id) => mark(before, id).price));
    expect(queue(before)).toEqual(wholeSort(before));
    expect(projectShareSaleMove(mark(before, PRR), 1)).toEqual({ x: 7, y: 8, price: 90 });

    const after = room(before, SELL(PRR, 10), P1, corridor());
    expect(mark(after, PRR)).toMatchObject({ x: 7, y: 8, price: 90 });
    // Equal $90: B&O is further right, so PRR now waits behind it. NYC is still next.
    expect(queue(after)).toEqual([CO, NYC, BO, PRR]);
    expect(operatingCorporationId(after)).toBe(CO);
  });

  describe("8. the operating corporation's own price movement never displaces it", () => {
    /** NYC $111 has operated; B&O $110 is operating at Dividends having run $120; PRR $100 (column 10) and C&O $90 wait. */
    function dividendBoard(): GameStateResponse {
      return board({
        round: "OperatingRound",
        step: "Dividends",
        operating: BO,
        corps: [
          { id: NYC, ticker: "NYC", president: P2, x: 9, y: 8, arrival: 1 },
          { id: BO, ticker: "B&O", president: P3, x: 10, y: 7, arrival: 2, lastRun: "120" },
          { id: PRR, ticker: "PRR", president: P1, x: 10, y: 6, arrival: 3 },
          { id: CO, ticker: "C&O", president: P1, x: 7, y: 8, arrival: 4 },
        ],
      });
    }

    it("a payout that lifts it above a corporation that has already operated leaves the whole prefix in place", () => {
      const before = dividendBoard();
      expect(queue(before)).toEqual(wholeSort(before));
      expect(projectDividendCellMove(mark(before, BO), "pay")).toEqual({ x: 11, y: 7, price: 120 });
      const after = room(before, DIVIDEND(BO, true, "120"), P3);
      expect(mark(after, BO)).toMatchObject({ x: 11, y: 7, price: 120 });
      expect(after.operating_sub_phase).toBe("Hardware"); // the declaration was accepted
      // A whole-queue re-sort would put B&O ($120) ahead of NYC ($111); the prefix does not move.
      expect(wholeSort(after)).toEqual([BO, NYC, PRR, CO]);
      expect(queue(after)).toEqual([NYC, BO, PRR, CO]);
      expect(after.active_corporation_index).toBe(1);
      expect(operatingCorporationId(after)).toBe(BO);
      expect(after.active_player_index).toBe(seatOf(after, P3));
    });

    it("a withhold that drops it below a waiting corporation leaves it operating, at its index", () => {
      const before = dividendBoard();
      expect(projectDividendCellMove(mark(before, BO), "withhold")).toEqual({ x: 9, y: 7, price: 100 });
      const after = room(before, DIVIDEND(BO, false, "120"), P3);
      expect(mark(after, BO)).toMatchObject({ x: 9, y: 7, price: 100 });
      // A whole-queue re-sort would put PRR ($100, column 10) ahead of B&O ($100, column 9).
      expect(wholeSort(after)).toEqual([NYC, PRR, BO, CO]);
      expect(queue(after)).toEqual([NYC, BO, PRR, CO]);
      expect(operatingCorporationId(after)).toBe(BO);
      expect(turnGuardKey(after, BO, "Dividends")).toBe(turnGuardKey(before, BO, "Dividends"));
    });
  });

  it("9. the operated prefix is byte-for-byte unchanged even when a corporation that has operated loses value", () => {
    // NYC $125 and PRR $120 have operated; C&O $111 is operating (and owes the forced purchase); B&O $100, B&M $90 wait.
    const before = rescueBoard(
      [
        { id: NYC, ticker: "NYC", president: P2, x: 10, y: 8, arrival: 1, holdings: [[P2, 30], [P1, 20]] },
        { id: PRR, ticker: "PRR", president: P3, x: 11, y: 7, arrival: 2 },
        { ...RESCUED, x: 9, y: 8, arrival: 3 },
        { id: BO, ticker: "B&O", president: P3, x: 8, y: 8, arrival: 4 },
        { id: BM, ticker: "B&M", president: P2, x: 7, y: 8, arrival: 5 },
      ],
      CO,
    );
    expect([125, 120, 111, 100, 90]).toEqual([NYC, PRR, CO, BO, BM].map((id) => mark(before, id).price));
    expect(queue(before)).toEqual(wholeSort(before));
    expect(before.active_corporation_index).toBe(2);
    expect(projectShareSaleMove(mark(before, NYC), 1)).toEqual({ x: 10, y: 7, price: 110 });

    const after = room(before, SELL(NYC, 10), P1, corridor());
    expect(mark(after, NYC)).toMatchObject({ x: 10, y: 7, price: 110 });
    // NYC ($110) would now sort behind C&O ($111) -- but NYC has operated: it stays where it is, and cannot re-enter.
    expect(wholeSort(after)).toEqual([PRR, CO, NYC, BO, BM]);
    expect(after.active_operating_order).toBe(before.active_operating_order); // the very same array: nothing rewritten
    expect(queue(after)).toEqual([NYC, PRR, CO, BO, BM]);
    expect(after.active_corporation_index).toBe(2);
    expect(operatingCorporationId(after)).toBe(CO);
  });

  it("10. no corporation operates twice and none is skipped: the next corporation is the highest one still waiting", () => {
    let state = room(aheadBoard(), SELL(NYC, 10), P1, corridor());
    expect(queue(state)).toEqual([CO, PRR, NYC, BO]);
    state = room(state, EMERGENCY(CO), P1, corridor());
    expect(state.public_companies.find((entry) => entry.company_id === CO)?.owned_trains).toEqual(["2"]);
    const turns: number[] = [operatingCorporationId(state)!];
    const seats: number[] = [state.active_player_index];
    for (let step = 0; step < 10 && state.current_round_type === "OperatingRound"; step += 1) {
      const next = room(state, PASS, operatingPresident(state), corridor());
      expect(next).not.toBe(state);
      state = next;
      if (state.current_round_type === "OperatingRound") {
        turns.push(operatingCorporationId(state)!);
        seats.push(state.active_player_index);
      }
    }
    // PRR (re-sorted ahead of NYC by the sale) follows C&O; every member of the round operates exactly once.
    expect(turns).toEqual([CO, PRR, NYC, BO]);
    expect(seats).toEqual([P1, P3, P2, P3].map((player) => seatOf(state, player)));
    expect(state.current_round_type).toBe("StockRound");
  });

  it("11. a corporation that floats after the round's membership was fixed is not inserted; it operates in the next round", () => {
    // ERIE ($130, above everyone) is floated with a president but absent from the queue: it floated between turns
    // (5.3: "It begins operating in the next operating round").
    const before = rescueBoard([
      RESCUED,
      { id: NYC, ticker: "NYC", president: P2, x: 9, y: 8, arrival: 2, holdings: [[P2, 30], [P1, 20]] },
      { id: PRR, ticker: "PRR", president: P3, x: 10, y: 7, arrival: 3, holdings: [[P3, 40]] },
      { id: BO, ticker: "B&O", president: P3, x: 8, y: 8, arrival: 4, holdings: [[P3, 60]] },
      { id: ERIE, ticker: "ERIE", president: P2, x: 12, y: 7, arrival: 5, ipo: 40 },
    ]);
    const inRound = { ...before, active_operating_order: [CO, NYC, PRR, BO] } as GameStateResponse;
    expect(mark(inRound, ERIE).price).toBe(130);
    expect(buildOperatingOrder(inRound)).toContain(ERIE); // a whole re-derivation WOULD admit it

    let state = room(inRound, SELL(NYC, 10), P1, corridor()); // the chart moves: the settle runs
    expect(queue(state)).toEqual([CO, PRR, NYC, BO]);
    expect(queue(state)).not.toContain(ERIE);
    state = room(state, EMERGENCY(CO), P1, corridor());
    const turns: number[] = [];
    for (let step = 0; step < 10 && state.current_round_type === "OperatingRound"; step += 1) {
      turns.push(operatingCorporationId(state)!);
      state = room(state, PASS, operatingPresident(state), corridor());
      if (state.current_round_type === "OperatingRound") expect(queue(state)).not.toContain(ERIE);
    }
    expect(turns).toEqual([CO, PRR, NYC, BO]);
    // The Stock Round that follows closes on three passes; the next round's membership admits ERIE.
    expect(state.current_round_type).toBe("StockRound");
    for (let pass = 0; pass < 3; pass += 1) {
      state = room(state, PASS, state.player_addresses[state.active_player_index], corridor());
    }
    expect(state.current_round_type).toBe("OperatingRound");
    expect(queue(state)).toContain(ERIE);
    expect(queue(state)).toEqual(buildOperatingOrder(state));
  });

  describe("12. a settle that changes nothing is an identity", () => {
    it("a forced sale that moves a waiting token without changing its place rewrites nothing", () => {
      const before = rescueBoard([
        RESCUED,
        { id: NYC, ticker: "NYC", president: P2, x: 9, y: 8, arrival: 2, holdings: [[P2, 30], [P1, 20]] },
        { id: PRR, ticker: "PRR", president: P3, x: 7, y: 8, arrival: 3, holdings: [[P3, 40]] },
      ]);
      expect(mark(before, PRR).price).toBe(90);
      const after = room(before, SELL(NYC, 10), P1, corridor());
      expect(mark(after, NYC).price).toBe(100); // it moved ...
      expect(after.active_operating_order).toBe(before.active_operating_order); // ... and the queue is the same object
      // The helper, asked again of the same pair, hands back the board it was given.
      expect(settleOperatingQueue(before, after)).toBe(after);
    });

    it("an entry that moves no token and opens no round never touches the queue -- not even an unsorted fixture's", () => {
      // A hand-built tail out of chart order (PRR $90 ahead of NYC $111). Only a token move re-sorts it.
      const fixture = rescueBoard([
        RESCUED,
        { id: PRR, ticker: "PRR", president: P3, x: 7, y: 8, arrival: 3, holdings: [[P3, 40]] },
        { id: NYC, ticker: "NYC", president: P2, x: 9, y: 8, arrival: 2, holdings: [[P2, 30], [P1, 20]] },
      ]);
      // A refused message (P2 is not the president owing the purchase): the board is unchanged, queue included.
      const refused = room(fixture, SELL(NYC, 10), P2, corridor());
      expect(stateDigest(refused)).toBe(stateDigest(fixture));
      // An accepted message that moves nothing on the chart: the queue is carried through untouched.
      const advanced = room({ ...fixture, operating_sub_phase: "Track" } as GameStateResponse, { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: CO } }, P1, corridor());
      expect(advanced.market_positions).toBe(fixture.market_positions);
      expect(advanced.active_operating_order).toBe(fixture.active_operating_order);
      // The trigger, stated directly: the same boards with a moved (new) chart WOULD have the waiting tail re-sorted.
      const moved = { ...fixture, market_positions: { ...fixture.market_positions } } as GameStateResponse;
      expect(settleOperatingQueue(fixture, fixture)).toBe(fixture);
      expect(queue(settleOperatingQueue(fixture, moved))).toEqual([CO, NYC, PRR]);
    });
  });

  it("13. a tail re-sort leaves the operating corporation's identity, index, seat and turnGuardKey exactly as they were", () => {
    const before = aheadBoard();
    const after = room(before, SELL(NYC, 10), P1, corridor());
    expect(queue(after)).not.toEqual(queue(before)); // the tail DID reorder
    expect(operatingCorporationId(after)).toBe(operatingCorporationId(before));
    expect(after.active_corporation_index).toBe(before.active_corporation_index);
    expect(after.active_player_index).toBe(before.active_player_index);
    expect(operatingTurnKey(after)).toBe(operatingTurnKey(before));
    expect(turnGuardKey(after, CO, "Hardware")).toBe(turnGuardKey(before, CO, "Hardware"));
    expect(derivedEntryKey(after, PASS as GameplayExecuteMsg)).toBe(derivedEntryKey(before, PASS as GameplayExecuteMsg));
    // No key was ever emitted for a waiting corporation: the derived loop keys only the corporation at the cursor.
    const derived = nextDerivedAction({ state: after, mapGrid: corridor(), emitted: new Set() });
    if (derived !== null) expect(derived.key.startsWith(`${operatingTurnKey(after)}:${CO}:`)).toBe(true);
  });
});

/* ================================================================================================================== */
/* Replay                                                                                                              */
/* ================================================================================================================== */

describe("14. replay reproduces the settled queue, the cursor, the seat and the derived keys (#1600)", () => {
  interface Snapshot {
    order: number[];
    index: number;
    operating: number | null;
    seat: number;
    round: string;
    turnKey: string | null;
    derived: string | null;
    digest: string;
  }
  const snapshot = (state: GameStateResponse, grid: MapGridResponse): Snapshot => {
    const operating = operatingCorporationId(state);
    return {
      order: queue(state),
      index: state.active_corporation_index,
      operating,
      seat: state.active_player_index,
      round: `${state.current_round_type}:${state.macro_round_number}.${state.sub_round_index}`,
      turnKey: operating !== null && state.operating_sub_phase ? turnGuardKey(state, operating, state.operating_sub_phase) : null,
      derived: nextDerivedAction({ state, mapGrid: grid, emitted: new Set() })?.key ?? null,
      digest: stateDigest(state),
    };
  };
  const entry = (index: number, actor: string, msg: unknown): ReplayEntry => ({
    index,
    id: `e${index}`,
    actor,
    payload: JSON.stringify(msg),
  });
  function replay(seed: GameStateResponse, grid: MapGridResponse, entries: ReplayEntry[]): Snapshot[] {
    const providers = { ...sandboxReplayProviders(), initialGrid: grid, initialMarket: seed.market_positions! };
    const engine = new RoomEngine(providers, { state: seed, waterfall: null });
    return entries.map((next) => {
      engine.apply(next);
      return snapshot(engine.snapshot.state, grid);
    });
  }
  function live(seed: GameStateResponse, grid: MapGridResponse, entries: ReplayEntry[]): Snapshot[] {
    let state = seed;
    return entries.map((next) => {
      state = room(state, JSON.parse(next.payload), next.actor, grid);
      return snapshot(state, grid);
    });
  }

  it("a mid-round reorder: two replays and the live reducer agree after every entry", () => {
    const seed = rescueBoard([
      RESCUED,
      { id: NYC, ticker: "NYC", president: P2, x: 9, y: 8, arrival: 2, holdings: [[P2, 30], [P1, 20]] },
      { id: PRR, ticker: "PRR", president: P3, x: 10, y: 7, arrival: 3, holdings: [[P3, 40]] },
      { id: BO, ticker: "B&O", president: P3, x: 8, y: 8, arrival: 4, holdings: [[P3, 60]] },
    ]);
    const log = [
      entry(0, P1, SELL(NYC, 10)),
      entry(1, P1, EMERGENCY(CO)),
      entry(2, P1, PASS),
      entry(3, P3, PASS),
      entry(4, P2, PASS),
      entry(5, P3, PASS),
    ];
    const first = replay(seed, corridor(), log);
    const second = replay(seed, corridor(), log);
    expect(second).toEqual(first);
    const direct = live(seed, corridor(), log);
    expect(first.map(({ order, index, operating, seat, round, turnKey, derived }) => ({ order, index, operating, seat, round, turnKey, derived }))).toEqual(
      direct.map(({ order, index, operating, seat, round, turnKey, derived }) => ({ order, index, operating, seat, round, turnKey, derived })),
    );
    expect(first[0]).toMatchObject({ order: [CO, PRR, NYC, BO], index: 0, operating: CO });
    expect(first.slice(2, 5).map((snap) => snap.operating)).toEqual([PRR, NYC, BO]);
    expect(first[5].round.startsWith("StockRound")).toBe(true);
  });

  it("an opening settled on the risen chart: two replays and the live reducer seat the same corporation", () => {
    const seed = board({
      round: "StockRound",
      seat: 2,
      corps: [
        { id: PRR, ticker: "PRR", president: P1, x: 10, y: 7, arrival: 1, ipo: 40 },
        { id: NYC, ticker: "NYC", president: P2, x: 9, y: 7, arrival: 2 },
        { id: BO, ticker: "B&O", president: P3, x: 7, y: 8, arrival: 3, ipo: 40 },
      ],
    });
    const log = [entry(0, P3, PASS), entry(1, P2, PASS), entry(2, P1, PASS)];
    const first = replay(seed, EMPTY_GRID, log);
    expect(replay(seed, EMPTY_GRID, log)).toEqual(first);
    expect(live(seed, EMPTY_GRID, log).map((snap) => [snap.order, snap.index, snap.operating, snap.seat])).toEqual(
      first.map((snap) => [snap.order, snap.index, snap.operating, snap.seat]),
    );
    expect(first[0]).toMatchObject({ order: [NYC, PRR, BO], index: 0, operating: NYC, seat: 1 });
    expect(first[1]).toMatchObject({ index: 1, operating: PRR, seat: 0 });
    expect(first[2]).toMatchObject({ index: 2, operating: BO, seat: 2 });
  });
});
