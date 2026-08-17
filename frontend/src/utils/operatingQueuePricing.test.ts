// frontend/src/utils/operatingQueuePricing.test.ts
//
// ==================================================================
//  DESIGN NOTE 468 (harness): A QUEUE THAT CANNOT SOFT-LOCK
// ==================================================================
//
// The reported failure: the B&O floats without a market coordinate, the
// queue that sorts on market price "fails", and the Operating Round never
// hands back to the Stock Round.
//
// Two properties keep that from happening, and neither is obvious from
// reading the sort:
//
//   THE PRICE IS ALWAYS A FINITE NUMBER. A `NaN` reaching the comparator
//   makes every comparison false, which yields an order that is not TOTAL --
//   and a non-total order can leave the cursor on a corporation that has
//   already operated, which is an infinite round arriving by a different
//   route than design note #411's empty queue. `NaN` is the interesting
//   input here, not `null`.
//
//   A FLOATED CORPORATION IS ALWAYS IN THE QUEUE, whatever the chart knows
//   about it. Being absent is what would break the round, so the tests below
//   check membership as carefully as they check order.
//
// The termination test is bounded rather than "run until it stops", for the
// reason `operatingRoundTurn.test.ts` records: a test for a hang must not
// hang.

import {
  applySandboxAction,
  beginOperatingRound,
  buildOperatingOrder,
} from "./sandboxSession";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const ALICE = "juno1alice";
const BOB = "juno1bob";

function company(
  over: Partial<PublicCompanyState> & Pick<PublicCompanyState, "company_id" | "ticker">,
): PublicCompanyState {
  return {
    is_floated: true,
    treasury: "500",
    total_shares_issued: 10,
    par_value: "100",
    president: ALICE,
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    player_holdings: [],
    home_hex_label: null,
    station_token_hexes: [],
    station_token_limit: 4,
    owned_trains: [],
    last_route_revenue: "0",
    ...over,
  };
}

function state(companies: PublicCompanyState[]): GameStateResponse {
  return {
    game_id: 1,
    creator: ALICE,
    is_active: true,
    total_juno_pool: "0",
    virtual_bank_vgp: "12000",
    virtual_bank_start: "12000",
    max_players: 2,
    player_addresses: [ALICE, BOB],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [],
    active_corporation_index: 0,
    current_round_type: "OperatingRound",
    macro_round_number: 2,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
    ],
    public_companies: companies,
    private_companies: [],
  };
}

/** The B&O's situation: parred in the auction, floated in a Stock Round,
 *  and -- before the fix -- carrying no market coordinate at all. */
const NO_MARKET_PRICE = () => null;

describe("a floated corporation with no market coordinate", () => {
  const board = state([
    company({ company_id: 1, ticker: "PRR", par_value: "100" }),
    company({ company_id: 4, ticker: "B&O", par_value: "67", president: BOB }),
  ]);

  it("is still in the operating queue", () => {
    // Absence is what breaks the round. Order is secondary.
    expect(buildOperatingOrder(board, NO_MARKET_PRICE)).toContain(4);
  });

  it("is ranked on its par value rather than on zero", () => {
    // PRR 100, B&O 67 -- par order, not "unpriced sorts last".
    expect(buildOperatingOrder(board, NO_MARKET_PRICE)).toEqual([1, 4]);
  });

  it("prefers the market price once the chart knows one", () => {
    // B&O parred at 67 but trading at 112 operates first.
    const prices: Record<number, number> = { 1: 100, 4: 112 };
    expect(buildOperatingOrder(board, (id) => prices[id] ?? null)).toEqual([4, 1]);
  });

  it("falls back per company, not all-or-nothing", () => {
    // One known price and one unknown must still produce a full queue.
    const order = buildOperatingOrder(board, (id) => (id === 1 ? 50 : null));
    expect(order).toHaveLength(2);
    // B&O on par 67 now outranks PRR's marked 50.
    expect(order).toEqual([4, 1]);
  });
});

describe("prices that are not numbers", () => {
  it("survives a null par with no market price", () => {
    const board = state([
      company({ company_id: 1, ticker: "PRR", par_value: null }),
      company({ company_id: 2, ticker: "NYC", par_value: "82" }),
    ]);
    const order = buildOperatingOrder(board, NO_MARKET_PRICE);
    expect(order).toHaveLength(2);
    expect(order).toEqual([2, 1]);
  });

  it("survives a par that is not parseable", () => {
    // `Number("")` is 0 and `Number("abc")` is NaN -- the second is the one
    // that would poison the comparator.
    const board = state([
      company({ company_id: 1, ticker: "PRR", par_value: "abc" }),
      company({ company_id: 2, ticker: "NYC", par_value: "" }),
      company({ company_id: 8, ticker: "B&M", par_value: "90" }),
    ]);
    const order = buildOperatingOrder(board, NO_MARKET_PRICE);
    expect(order).toHaveLength(3);
    expect(order[0]).toBe(8);
    // Total order: every id present exactly once.
    expect(new Set(order).size).toBe(3);
  });

  it("survives a market lookup that returns NaN", () => {
    const board = state([
      company({ company_id: 1, ticker: "PRR", par_value: "100" }),
      company({ company_id: 2, ticker: "NYC", par_value: "82" }),
    ]);
    const order = buildOperatingOrder(board, () => Number.NaN);
    expect(order).toHaveLength(2);
    // Falls through to par rather than producing an unordered pair.
    expect(order).toEqual([1, 2]);
  });

  it("produces a TOTAL order under every hostile input", () => {
    const board = state([
      company({ company_id: 1, ticker: "PRR", par_value: "abc" }),
      company({ company_id: 2, ticker: "NYC", par_value: null }),
      company({ company_id: 4, ticker: "B&O", par_value: "67" }),
      company({ company_id: 8, ticker: "B&M", par_value: "90" }),
    ]);
    for (const priceFor of [
      NO_MARKET_PRICE,
      () => Number.NaN,
      (id: number) => (id % 2 === 0 ? Number.NaN : null),
    ]) {
      const order = buildOperatingOrder(board, priceFor);
      expect(new Set(order).size).toBe(order.length);
      expect(order).toHaveLength(4);
    }
  });
});

describe("the round still terminates", () => {
  it("closes even when no corporation has a market price", () => {
    // The reported soft-lock, bounded so a regression fails rather than
    // hangs the suite.
    let s = beginOperatingRound(
      state([
        company({ company_id: 1, ticker: "PRR", par_value: "100" }),
        company({ company_id: 4, ticker: "B&O", par_value: "67", president: BOB }),
      ]),
      NO_MARKET_PRICE,
    );
    let turns = 0;
    while (!s.operating_round_just_ended && turns < 50) {
      s = applySandboxAction(s, { PassTurn: { game_id: 1 } }, { marketPriceFor: NO_MARKET_PRICE });
      turns += 1;
    }
    expect(s.operating_round_just_ended).toBe(true);
    expect(turns).toBe(2);
  });

  it("closes when the prices are NaN throughout", () => {
    const nan = () => Number.NaN;
    let s = beginOperatingRound(
      state([
        company({ company_id: 1, ticker: "PRR" }),
        company({ company_id: 2, ticker: "NYC", president: BOB }),
        company({ company_id: 8, ticker: "B&M" }),
      ]),
      nan,
    );
    let turns = 0;
    while (!s.operating_round_just_ended && turns < 50) {
      s = applySandboxAction(s, { PassTurn: { game_id: 1 } }, { marketPriceFor: nan });
      turns += 1;
    }
    expect(s.operating_round_just_ended).toBe(true);
    expect(turns).toBe(3);
  });
});
