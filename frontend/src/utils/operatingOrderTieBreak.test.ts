// frontend/src/utils/operatingOrderTieBreak.test.ts
//
// ==================================================================
//  DESIGN NOTES 646/647 (harness): PRICE, THEN COLUMN, THEN ARRIVAL
// ==================================================================
//
// INSTRUCTED: "there are two essential rules: i) corporations act in
// descending market value, and ii) corporations on the same cell act in the
// order in which they reached the cell: so a first company to par at $100
// goes first, and a second company that also pars at $100 goes second. If two
// corporations markers move into the same cell, the first one to enter goes
// first."
//
// Rule (i) was already implemented. Rule (ii) was a placeholder that sorted
// ties by `company_id`, which made turn order a function of the contract's
// roster numbering -- so PRR (id 1) beat B&O (id 4) at equal price forever,
// whichever had actually parred first.
//
// THE TESTS ARE WRITTEN AGAINST THE REPORT'S OWN EXAMPLES, because the rule
// is easy to state and easy to invert, and a test that merely asserts "some
// stable order" would pass on the version that was wrong.

import { buildOperatingOrder } from "./sandboxSession";
import { nextArrival, withArrival, placeParMark } from "./sandboxState";
import type { SandboxMarketPrices } from "./sandboxState";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const ALICE = "juno1alice";

function company(
  companyId: number,
  ticker: string,
  par: string,
): PublicCompanyState {
  return {
    company_id: companyId,
    ticker,
    is_floated: true,
    treasury: "500",
    total_shares_issued: 10,
    par_value: par,
    president: ALICE,
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    player_holdings: [],
    home_hex_label: null,
    station_token_hexes: [],
    station_token_limit: 4,
    owned_trains: [],
    last_route_revenue: "0",
  } as unknown as PublicCompanyState;
}

function board(companies: PublicCompanyState[]): GameStateResponse {
  return { public_companies: companies } as unknown as GameStateResponse;
}

/** The chart, as the game builds it: a par box resolver that gives every
 *  price its own cell, so "same price" and "same cell" coincide. */
const parCell = (price: number) => ({ x: price, y: 0 });

const priceFrom = (prices: SandboxMarketPrices) => (id: number) =>
  prices[id]?.price ?? null;
/* Design note #647: the whole mark, because the comparator reads the column
   as well as the arrival. */
const markFrom = (prices: SandboxMarketPrices) => (id: number) => prices[id] ?? null;

describe("rule (i): descending market value", () => {
  it("puts the most valuable corporation first", () => {
    let prices: SandboxMarketPrices = {};
    prices = placeParMark(prices, 1, 67, parCell);
    prices = placeParMark(prices, 4, 100, parCell);
    prices = placeParMark(prices, 5, 82, parCell);

    const order = buildOperatingOrder(
      board([company(1, "PRR", "67"), company(4, "B&O", "100"), company(5, "C&O", "82")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 5, 1]);
  });
});

describe("rule (ii): ties go to whoever reached the cell first", () => {
  it("orders two corporations that parred at the same price by who parred first", () => {
    /* The report's own example. B&O pars at $100 first; PRR pars at $100
       second; B&O operates first -- and note that `company_id` alone would
       have said the opposite, since PRR is id 1. */
    let prices: SandboxMarketPrices = {};
    prices = placeParMark(prices, 4, 100, parCell); // B&O, first to $100
    prices = placeParMark(prices, 1, 100, parCell); // PRR, second

    const order = buildOperatingOrder(
      board([company(1, "PRR", "100"), company(4, "B&O", "100")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });

  it("is not merely the roster order dressed up", () => {
    // The same two corporations, parred the other way round, must invert.
    let prices: SandboxMarketPrices = {};
    prices = placeParMark(prices, 1, 100, parCell); // PRR first this time
    prices = placeParMark(prices, 4, 100, parCell);

    const order = buildOperatingOrder(
      board([company(1, "PRR", "100"), company(4, "B&O", "100")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([1, 4]);
  });

  it("orders by arrival when two markers MOVE into one cell", () => {
    /* "If two corporations markers move into the same cell, the first one to
       enter goes first." Both start apart and converge on $90 -- the one that
       got there first leads, regardless of where it came from. */
    let prices: SandboxMarketPrices = {};
    prices = placeParMark(prices, 1, 100, parCell);
    prices = placeParMark(prices, 4, 82, parCell);

    const shared = { price: 90, x: 90, y: 0 };
    // B&O moves onto $90 first...
    prices = { ...prices, 4: withArrival(prices, 4, shared) };
    // ...then PRR.
    prices = { ...prices, 1: withArrival(prices, 1, shared) };

    const order = buildOperatingOrder(
      board([company(1, "PRR", "100"), company(4, "B&O", "82")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });

  it("does not re-stamp a marker that lands where it already stood", () => {
    /* A move that resolves to the same cell is not a re-entry. Re-stamping
       would send a corporation to the back of its own tie for standing
       still -- which is how a withheld dividend at the bottom of the chart
       could silently reorder the round. */
    let prices: SandboxMarketPrices = {};
    prices = placeParMark(prices, 4, 100, parCell);
    prices = placeParMark(prices, 1, 100, parCell);
    const before = prices[4]?.enteredAt;

    prices = { ...prices, 4: withArrival(prices, 4, { price: 100, x: 100, y: 0 }) };
    expect(prices[4]?.enteredAt).toBe(before);

    const order = buildOperatingOrder(
      board([company(1, "PRR", "100"), company(4, "B&O", "100")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });

  it("price still outranks arrival", () => {
    // A late arrival at a higher price operates before an early one below it.
    let prices: SandboxMarketPrices = {};
    prices = placeParMark(prices, 1, 82, parCell); // early, cheap
    prices = placeParMark(prices, 4, 100, parCell); // late, dear

    const order = buildOperatingOrder(
      board([company(1, "PRR", "82"), company(4, "B&O", "100")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });
});

describe("the arrival ordinal", () => {
  it("is derived from the chart, so a replay reproduces it", () => {
    /* Design note #646: a counter held outside the state would keep climbing
       across a rebuild and give the same game different orders on different
       clients. `nextArrival` reads the marks, so replaying the same landings
       yields the same numbers. */
    let a: SandboxMarketPrices = {};
    a = placeParMark(a, 4, 100, parCell);
    a = placeParMark(a, 1, 100, parCell);

    let b: SandboxMarketPrices = {};
    b = placeParMark(b, 4, 100, parCell);
    b = placeParMark(b, 1, 100, parCell);

    expect(a).toEqual(b);
    expect(nextArrival(a)).toBe(nextArrival(b));
  });

  it("advances past the highest already on the chart", () => {
    let prices: SandboxMarketPrices = {};
    expect(nextArrival(prices)).toBe(1);
    prices = placeParMark(prices, 4, 100, parCell);
    expect(nextArrival(prices)).toBe(2);
    prices = placeParMark(prices, 1, 90, parCell);
    expect(nextArrival(prices)).toBe(3);
  });
});

describe("a board with no recorded history", () => {
  it("sorts corporations without an arrival after those with one", () => {
    /* A fixture seeded straight onto the chart has no arrivals. Guessing one
       would invent a turn order; the unknowns go last and fall through to a
       stable `company_id` tie-break, which is arbitrary and says so. */
    const prices: SandboxMarketPrices = {
      1: { price: 100, x: 100, y: 0 }, // no `enteredAt`
      4: { price: 100, x: 100, y: 0, enteredAt: 7 },
    };
    const order = buildOperatingOrder(
      board([company(1, "PRR", "100"), company(4, "B&O", "100")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });

  it("stays a total order when nothing has an arrival at all", () => {
    // The property design note #468 guards: an incomparable pair makes `sort`
    // produce something that is not an order, and the cursor can then land on
    // a corporation that has already operated.
    const prices: SandboxMarketPrices = {
      1: { price: 100, x: 100, y: 0 },
      4: { price: 100, x: 100, y: 0 },
      5: { price: 100, x: 100, y: 0 },
    };
    const order = buildOperatingOrder(
      board([company(5, "C&O", "100"), company(1, "PRR", "100"), company(4, "B&O", "100")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([1, 4, 5]);
  });
});

describe("rule (iii): equal price on different cells goes to the rightmost", () => {
  /* ==================================================================
   *  DESIGN NOTE 647 (harness)
   * ==================================================================
   *
   * INSTRUCTED: "if two corporations have the same share value but are on
   * different cells, the corporation whose token is furthest right on the
   * matrix goes first."
   *
   * These build marks by hand rather than through `placeParMark`, because the
   * whole point is two cells that share a PRICE and differ in COLUMN -- which
   * a par-box resolver mapping price to a unique cell cannot produce. The
   * real 1830 chart does: a price repeats across columns as the marker walks.
   */
  const at = (price: number, x: number, y: number, enteredAt: number) =>
    ({ price, x, y, enteredAt });

  it("puts the further-right token first at equal price", () => {
    const prices: SandboxMarketPrices = {
      1: at(90, 3, 4, 1), // PRR, left
      4: at(90, 7, 2, 2), // B&O, right
    };
    const order = buildOperatingOrder(
      board([company(1, "PRR", "90"), company(4, "B&O", "90")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });

  it("outranks arrival, because the cells differ", () => {
    /* THE CASE THAT SEPARATES RULES (ii) AND (iii). PRR reached its cell
       first, so an arrival-only comparator would put it first -- but the two
       are on DIFFERENT cells, which is rule (iii)'s ground, and rule (ii)
       never applies. Column wins. */
    const prices: SandboxMarketPrices = {
      1: at(90, 3, 4, 1), // earlier arrival, further LEFT
      4: at(90, 7, 2, 9), // later arrival, further RIGHT
    };
    const order = buildOperatingOrder(
      board([company(1, "PRR", "90"), company(4, "B&O", "90")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });

  it("does not disturb the same-cell rule", () => {
    /* Two tokens on ONE cell share a column, so the column comparison is a
       no-op and arrival decides -- which is rule (ii), unchanged. The two
       rules cannot reach each other's ground. */
    const prices: SandboxMarketPrices = {
      1: at(90, 5, 3, 8), // same cell, arrived later
      4: at(90, 5, 3, 2), // same cell, arrived first
    };
    const order = buildOperatingOrder(
      board([company(1, "PRR", "90"), company(4, "B&O", "90")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });

  it("falls through to arrival for two cells in one column", () => {
    /* Same price, same column, different rows. "Furthest right" cannot
       separate them -- they are equally right -- so this lands on arrival.
       Not the stated rule, because the rules do not legislate this case;
       recorded so the behaviour is a decision rather than an accident. */
    const prices: SandboxMarketPrices = {
      1: at(90, 5, 1, 8),
      4: at(90, 5, 6, 2),
    };
    const order = buildOperatingOrder(
      board([company(1, "PRR", "90"), company(4, "B&O", "90")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });

  it("still yields to price", () => {
    // A leftmost token at a higher price beats a rightmost one below it.
    const prices: SandboxMarketPrices = {
      1: at(100, 1, 0, 1), // dear, far left
      4: at(90, 9, 0, 2), // cheap, far right
    };
    const order = buildOperatingOrder(
      board([company(1, "PRR", "100"), company(4, "B&O", "90")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([1, 4]);
  });

  it("sorts a positionless corporation last, not first", () => {
    /* A floated corporation with no mark falls back to its par for the price
       and has no column at all. It must not be handed precedence by the
       absence of information -- `-Infinity` puts it left of every real
       column, which under a rightmost-first rule is last. */
    const prices: SandboxMarketPrices = { 4: at(90, 6, 2, 1) };
    const order = buildOperatingOrder(
      board([company(1, "PRR", "90"), company(4, "B&O", "90")]),
      priceFrom(prices),
      markFrom(prices),
    );
    expect(order).toEqual([4, 1]);
  });
});
