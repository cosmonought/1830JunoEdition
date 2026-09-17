/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1620 (harness): THE CROWN GOES CLOCKWISE (Slice 8.3, S8-2)
// ==================================================================
//
// Rulebook §5.4: "As a corporation's president, you only remain president as long as your share total in that
// corporation is not exceeded by another player. ... If multiple players exceed your share total, and they
// each have the same number of shares, the new president is the player closest to you going in a clockwise
// direction. A president's certificate can never end up in the bank pool."
//
// TWO FACTS DECIDE EVERY CASE BELOW, and the whole point of this file is that they are the ONLY two:
// percentage, then seat. The repaired `presidentFor` reads `player_holdings` for percentages and
// `player_addresses` for the circle, and nothing else -- not the ORDER of `player_holdings`, which is what
// the defect was.
//
// SO EVERY TIE CASE HERE STATES THE SEATING EXPLICITLY AND LISTS THE HOLDINGS IN A DIFFERENT ORDER. A test
// whose fixture happens to list holders in seat order cannot tell the old code from the new one --
// `presidencyTransfer.test.ts`'s own tie case was exactly that, and it passed before the repair and after it.
// The pair of cases that discriminate are "holdings reordered, seating fixed" (answer must not move) and
// "seating reordered, holdings fixed" (answer must move).
//
// AND THE PREDICTION IS PINNED AGAINST THE SETTLEMENT, not against a hand-written expectation. Stage 5
// refuses a forced sale that would move the crown (6.6.3), so `presidentAfterSale` and `settlePresidencies`
// disagreeing would make a legality answer differ from its own consequence. The last describe block applies
// each sale for real and compares.

export {};

const { presidentFor, presidentAfterSale, settlePresidencies } =
  require("../gameEngine/presidencyTransfer") as typeof import("../gameEngine/presidencyTransfer");
const { forcedSaleRefusal } = require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { certificateCount } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { marketZoneForPrice, parBoxCellFor, projectShareSaleMove } =
  require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type PublicCompanyState = import("../gameEngine/gameState").PublicCompanyState;

/* Four players, so a clockwise wraparound is distinguishable from "the lowest seat index". */
const A = "p-a";
const B = "p-b";
const C = "p-c";
const D = "p-d";

/* ==================================================================================================
   THE HELPER, ASKED DIRECTLY
   ================================================================================================== */

/** One corporation, its holders in the order GIVEN (which is `player_holdings` order -- first-acquisition
 *  order on a real board) and its incumbent named separately. */
const company = (
  holdings: ReadonlyArray<readonly [string, number]>,
  president: string | null,
): PublicCompanyState =>
  ({
    company_id: 1,
    ticker: "PRR",
    par_value: "100",
    president,
    player_holdings: holdings.map(([player, percentage]) => ({ player, percentage })),
  }) as unknown as PublicCompanyState;

const SEATS = [A, B, C, D] as const;

describe("1. the incumbent rule (§5.4: not EXCEEDED)", () => {
  it("keeps the incumbent when a challenger merely equals them, at 20% and at 30%", () => {
    /* The two cases the brief names, and the reason #596b gave for the rule: without it the crown flickers
       between two players buying alternately to the same level. */
    expect(presidentFor(company([[A, 20], [B, 20]], A), SEATS)).toBe(A);
    expect(presidentFor(company([[A, 30], [B, 30]], A), SEATS)).toBe(A);
    /* And the incumbent keeps it however the holdings are ordered -- the tie is decided by the comparison,
       not by who is listed first. */
    expect(presidentFor(company([[B, 30], [A, 30]], A), SEATS)).toBe(A);
  });

  it("moves the crown to a challenger who exceeds them", () => {
    expect(presidentFor(company([[A, 20], [B, 30]], A), SEATS)).toBe(B);
  });

  it("takes the largest challenger, not the first one", () => {
    /* incumbent 30, challengers 40 and 30: only the 40 EXCEEDS, so the 30 is not a challenger at all. */
    expect(presidentFor(company([[A, 30], [B, 30], [C, 40]], A), SEATS)).toBe(C);
    expect(presidentFor(company([[A, 30], [C, 40], [B, 30]], A), SEATS)).toBe(C);
  });

  it("does not crown a holder under 20%, whatever else is true of the board", () => {
    // Nobody can hold a 20% certificate on 10% of the company.
    expect(presidentFor(company([[B, 10]], null), SEATS)).toBeNull();
    expect(presidentFor(company([[B, 10], [C, 10]], null), SEATS)).toBeNull();
    /* And a 10% holder does not displace a president who is under 20% either -- which is the board the
       `SellStock` arm hands this function mid-settlement, before the crown has moved. `null` is "nobody
       qualifies" and NOT "vacate the crown": #748b's contract is that `settlePresidencies` leaves the
       incumbent standing on a board that should not exist, because a stale president is at least a
       president and the corporation stays able to lay track and spend its treasury. */
    expect(presidentFor(company([[A, 10], [B, 10]], A), SEATS)).toBeNull();
    const shouldNotExist = board({
      corps: [{ id: PRR, ticker: "PRR", president: A, ipo: 80, pool: 0, holdings: [[A, 10], [B, 10]] }],
    });
    expect(settlePresidencies(shouldNotExist).state).toBe(shouldNotExist);
    expect(corpOf(settlePresidencies(shouldNotExist).state, PRR).president).toBe(A);
  });
});

describe("2. the clockwise tie-break (§5.4: closest to you going clockwise)", () => {
  it("picks the next seat clockwise from the displaced president", () => {
    /* Incumbent at seat 0 on 10%; seats 1 and 2 tied at 20%. d(seat 1) = 1, d(seat 2) = 2. */
    expect(presidentFor(company([[C, 20], [A, 10], [B, 20]], A), SEATS)).toBe(B);
  });

  it("wraps: an incumbent at seat 2 is succeeded by seat 0 before seat 1", () => {
    /* d(seat 0) = (0 - 2 + 4) mod 4 = 2; d(seat 1) = (1 - 2 + 4) mod 4 = 3. Seat 0 is CLOSER clockwise even
       though it is behind in array order -- the case a plain `indexOf` sort gets wrong. */
    expect(presidentFor(company([[A, 30], [B, 30], [C, 10]], C), SEATS)).toBe(A);
  });

  it("wraps the other way: an incumbent at seat 1 is succeeded by seat 3 before seat 0", () => {
    /* d(seat 3) = (3 - 1 + 4) mod 4 = 2; d(seat 0) = (0 - 1 + 4) mod 4 = 3. */
    expect(presidentFor(company([[A, 30], [D, 30], [B, 10]], B), SEATS)).toBe(D);
  });

  it("never lets proximity outrank percentage", () => {
    /* A 40% holder three seats clockwise beats a 30% holder in the very next seat. The clockwise rule is a
       TIE-break; a "closest challenger wins" implementation passes every case above and fails this one. */
    expect(presidentFor(company([[A, 20], [B, 30], [D, 40]], A), SEATS)).toBe(D);
  });
});

describe("3. the two cases that separate seating from holdings order (S8-2's actual defect)", () => {
  /* Incumbent A at seat 0 on 10%; B (seat 1) and C (seat 2) tied at 20%. */
  const holdings = [[A, 10], [B, 20], [C, 20]] as ReadonlyArray<readonly [string, number]>;

  it("reordering player_holdings changes nothing", () => {
    /* `moveShares` PUSHES a holder on their first purchase and SPLICES them out when they fall to nothing,
       and the B&O auction grant moves its winner to the end -- so this array's order is first-acquisition
       order and a player who sells out and buys back moves. None of that may touch the crown. */
       const orders: Array<ReadonlyArray<readonly [string, number]>> = [
      holdings,
      [[C, 20], [B, 20], [A, 10]],
      [[B, 20], [C, 20], [A, 10]],
      [[C, 20], [A, 10], [B, 20]],
    ];
    for (const order of orders) {
      expect(presidentFor(company(order, A), SEATS)).toBe(B);
    }
  });

  it("reordering the seating moves the crown", () => {
    /* Identical holdings, C seated between A and B: the answer must follow the table. This is the assertion
       the old implementation could not pass -- it never read the roster. */
    expect(presidentFor(company(holdings, A), [A, C, B, D])).toBe(C);
    expect(presidentFor(company(holdings, A), [A, B, C, D])).toBe(B);
    /* And the origin is the INCUMBENT's seat, not seat 0: seat A last, so clockwise from A reaches B first
       by wrapping past D. */
    expect(presidentFor(company(holdings, A), [C, D, B, A])).toBe(C);
  });
});

describe("4. the incumbent's seat survives their percentage", () => {
  it("counts from the former president's seat even though they are no longer eligible", () => {
    /* The brief's explicit instruction, and the case it matters in: A is at 10% and cannot preside, but A is
       still the player §5.4 measures "closest to you" from. Counting from the leader's seat, or from seat 0,
       gives C here instead of D. */
    expect(presidentFor(company([[C, 20], [D, 20], [A, 10]], A), [C, A, D, B])).toBe(D);
  });

  it("falls back to seat 0 only when there is no incumbent at all", () => {
    /* #748b: unreachable for a parred corporation, and a fixture can still build it. Deterministic and
       stated: highest percentage, ties by earliest seat counted from seat 0. */
    expect(presidentFor(company([[D, 20], [C, 20], [B, 20]], null), SEATS)).toBe(B);
    expect(presidentFor(company([[D, 20], [B, 20], [A, 20]], null), SEATS)).toBe(A);
    // Percentage still leads: the seat-3 holder's 30% beats the seat-1 holder's 20%.
    expect(presidentFor(company([[B, 20], [D, 30]], null), SEATS)).toBe(D);
  });
});

describe("5. what the source guarantees about the seating (§4 of the brief)", () => {
  it("cannot be handed an unseated holder by the reducer -- an unseated actor buys nothing", () => {
    /* THE INVARIANT, ASSERTED AT ITS SOURCE. `applySandboxActionInner` resolves its actor as
       `logged !== null && state.player_addresses.includes(logged) ? logged : null` (#549), and `moveShares`
       writes a holding only `if (holder)`. The M&H grant's holder is the private's owner and the B&O grant's
       is a bidder, both seated. So `player_holdings` cannot name a player the roster does not seat, and the
       clockwise rule always has a circle to count on. */
    const before = board();
    const after = apply(before, BUY(PRR), "p-nobody");
    expect(stateDigest(after)).toBe(stateDigest(before));
    expect(held(after, PRR, "p-nobody")).toBe(0);
  });

  it("answers a malformed fixture deterministically rather than by holdings order", () => {
    /* Not a rule -- a guarantee that a hand-built board cannot make two clients disagree. An unseated
       challenger has no place on the circle, so it sorts last; where the circle cannot answer at all, the
       address does, and the address is log-derived where `player_holdings` order is not. */
    const unseated = "p-z";
    // B is seated and the unseated holder is not: B wins on distance whichever way round they are listed.
    expect(presidentFor(company([[unseated, 20], [B, 20], [A, 10]], A), SEATS)).toBe(B);
    expect(presidentFor(company([[B, 20], [unseated, 20], [A, 10]], A), SEATS)).toBe(B);
    // A board that seats nobody has no circle: the answer is by address, and it does not move with the array.
    expect(presidentFor(company([[C, 20], [B, 20], [A, 10]], A), [])).toBe(B);
    expect(presidentFor(company([[B, 20], [C, 20], [A, 10]], A), [])).toBe(B);
    // An incumbent the roster does not seat gives no origin, so the circle is counted from seat 0.
    expect(presidentFor(company([[D, 20], [B, 20]], unseated), SEATS)).toBe(B);
  });
});

/* ==================================================================================================
   THROUGH THE REDUCER -- the settlement, not the selector
   ================================================================================================== */

const PRR = 1;

interface CorpSpec {
  id: number;
  ticker: string;
  president: string | null;
  ipo: number;
  pool: number;
  holdings: ReadonlyArray<readonly [string, number]>;
}

/** A Stock Round board with a chart and an explicit roster.
 *
 *  `rules: 1` (Sell-Buy-Sell) so a purchase does not move the seat, and `macro_round_number: 2` so the
 *  first-Stock-Round sale ban is not the rule under test. `seating` is the argument this whole file is
 *  about, and it is deliberately NOT the order the holdings are listed in. */
function board(
  over: {
    seating?: readonly string[];
    corps?: readonly CorpSpec[];
    cash?: Record<string, number>;
    state?: Partial<GameStateResponse>;
  } = {},
): GameStateResponse {
  const seating = over.seating ?? SEATS;
  const corps = over.corps ?? [
    { id: PRR, ticker: "PRR", president: A, ipo: 30, pool: 0, holdings: [[C, 20], [A, 30], [B, 20]] },
  ];
  return {
    current_round_type: "StockRound",
    macro_round_number: 2,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    variants: { rules: 1 },
    player_addresses: [...seating],
    player_cash: seating.map((player) => ({ player, cash_vgp: String(over.cash?.[player] ?? 2000) })),
    virtual_bank_vgp: "9000",
    private_companies: [],
    market_positions: Object.fromEntries(
      corps.map((corp) => [corp.id, { price: 100, ...(parBoxCellFor(100) ?? { x: 2, y: 3 }), enteredAt: corp.id }]),
    ),
    public_companies: corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      president: corp.president,
      par_value: "100",
      is_floated: true,
      treasury: "0",
      owned_trains: [],
      ipo_pool_percentage: corp.ipo,
      bank_pool_percentage: corp.pool,
      player_holdings: corp.holdings.map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [],
      station_tokens: [],
      total_shares_issued: 0,
    })),
    ...over.state,
  } as unknown as GameStateResponse;
}

const ctxFor = (state: GameStateResponse, actor: string | null) => {
  const positions = state.market_positions ?? {};
  const priceFor = (companyId: number): number | null => positions[companyId]?.price ?? null;
  return {
    actor,
    parCellFor: parBoxCellFor,
    marketZoneFor: (companyId: number) => marketZoneForPrice(priceFor(companyId)),
    zoneForPrice: marketZoneForPrice,
    marketPricesByCompany: Object.fromEntries(
      Object.entries(positions).map(([id, mark]) => [Number(id), mark?.price ?? null]),
    ) as Record<number, number | null>,
    marketContext: {
      projectSale: (from: { x: number; y: number; price: number }, blocks: number) => projectShareSaleMove(from, blocks),
    },
  };
};

const apply = (state: GameStateResponse, msg: unknown, actor: string | null) =>
  applySandboxAction(state, msg as never, ctxFor(state, actor) as never);

const BUY = (id: number, over: Record<string, unknown> = {}) => ({
  BuyStock: { game_id: 0, protocol_id: id, source: "Ipo", ...over },
});
const SELL = (id: number, percentage: number) => ({ SellStock: { game_id: 0, protocol_id: id, percentage } });

const corpOf = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)!;
const held = (state: GameStateResponse, id: number, player: string) =>
  corpOf(state, id).player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;

/** Every card of one corporation, wherever it sits -- nine for a printed corporation whose President's
 *  Certificate is out (one 20% card plus eight 10%s), ten while it is still an unsold 20% in the IPO.
 *
 *  WHAT IS ASSERTED IS CONSERVATION, NOT THE FIGURE. #596a's swap moves cards between two hands and creates
 *  none, and counting cards is the only way to SEE the exchange happen: the percentages are identical whether
 *  the certificate was exchanged with the successor or (illegally) sold to the Bank. */
const cardsOf = (state: GameStateResponse, id: number, players: readonly string[]) =>
  players.reduce((sum, player) => sum + certificateCount(player, state), 0) +
  corpOf(state, id).ipo_pool_percentage / 10 +
  corpOf(state, id).bank_pool_percentage / 10;

describe("6. an ordinary BuyStock settles the crown immediately", () => {
  it("hands it over when the purchase makes the buyer exceed the incumbent", () => {
    /* A presides on 20%, B buys to 30%. §5.4 "immediately": the same dispatch that moves the share. */
    const before = board({
      corps: [{ id: PRR, ticker: "PRR", president: A, ipo: 40, pool: 0, holdings: [[A, 20], [B, 20], [C, 20]] }],
    });
    const after = apply(before, BUY(PRR), B);
    expect(held(after, PRR, B)).toBe(30);
    expect(corpOf(after, PRR).president).toBe(B);
    // #596a: no percentage moved but the buyer's; the card counts are what changed.
    expect(held(after, PRR, A)).toBe(20);
    expect(certificateCount(B, after)).toBe(2); // the 20% card plus one 10%
    expect(certificateCount(A, after)).toBe(2); // two ordinary 10%s
    expect(cardsOf(after, PRR, SEATS)).toBe(cardsOf(before, PRR, SEATS));
  });

  it("leaves it alone when the purchase only ties the incumbent", () => {
    /* B buys to 30% and A holds 30%. Not exceeded, so not transferred -- and the crown must not move even
       though B is now joint-largest. */
    const before = board({
      corps: [{ id: PRR, ticker: "PRR", president: A, ipo: 30, pool: 0, holdings: [[A, 30], [B, 20], [C, 20]] }],
    });
    const after = apply(before, BUY(PRR), B);
    expect(held(after, PRR, B)).toBe(30);
    expect(corpOf(after, PRR).president).toBe(A);
    expect(cardsOf(after, PRR, SEATS)).toBe(cardsOf(before, PRR, SEATS));
  });
});

describe("7. an ordinary SellStock settles the crown by the same rule", () => {
  /* A presides on 30%; B (seat 1) and C (seat 2) hold 20% each. A sells 20% and drops to 10%, under both.
     THE HOLDINGS LIST C FIRST, so a settlement reading the array crowns C and one reading the table crowns
     B -- which is the whole of S8-2, asserted through the reducer rather than through the helper. */
  const beforeSale = (seating: readonly string[]) =>
    board({
      seating,
      corps: [{ id: PRR, ticker: "PRR", president: A, ipo: 30, pool: 0, holdings: [[C, 20], [A, 30], [B, 20]] }],
    });

  it("hands it to the challenger closest clockwise, not the first in the holdings", () => {
    const after = apply(beforeSale(SEATS), SELL(PRR, 20), A);
    expect(held(after, PRR, A)).toBe(10);
    expect(corpOf(after, PRR).bank_pool_percentage).toBe(20);
    expect(corpOf(after, PRR).president).toBe(B); // seat 1, one clockwise from A
  });

  it("follows the table when the table changes and the holdings do not", () => {
    const after = apply(beforeSale([A, C, B, D]), SELL(PRR, 20), A);
    expect(corpOf(after, PRR).president).toBe(C); // now seat 1
  });

  it("leaves the incumbent when the sale only ties them with the top holder", () => {
    /* A sells 10% and lands on 20%, level with B and C. Selling down TO the certificate is legal and does
       not transfer: a tie is not an excess. */
    const after = apply(beforeSale(SEATS), SELL(PRR, 10), A);
    expect(held(after, PRR, A)).toBe(20);
    expect(corpOf(after, PRR).president).toBe(A);
  });

  it("never puts the President's Certificate in the Bank Pool", () => {
    /* §5.4's last sentence. The pool takes the seller's ORDINARY cards; the 20% certificate is exchanged with
       the successor, so a parred corporation still has a president and the ten cards still add up. */
    for (const bundle of [10, 20]) {
      const after = apply(beforeSale(SEATS), SELL(PRR, bundle), A);
      expect(corpOf(after, PRR).president).not.toBeNull();
      expect(held(after, PRR, corpOf(after, PRR).president as string)).toBeGreaterThanOrEqual(20);
      expect(corpOf(after, PRR).bank_pool_percentage).toBe(bundle);
      expect(cardsOf(after, PRR, SEATS)).toBe(cardsOf(beforeSale(SEATS), PRR, SEATS));
    }
  });

  it("conserves the percentages and the card counts across the transfer", () => {
    const before = beforeSale(SEATS);
    const after = apply(before, SELL(PRR, 20), A);
    const total = (state: GameStateResponse) =>
      corpOf(state, PRR).player_holdings.reduce((sum, entry) => sum + entry.percentage, 0) +
      corpOf(state, PRR).ipo_pool_percentage +
      corpOf(state, PRR).bank_pool_percentage;
    expect(total(before)).toBe(100);
    expect(total(after)).toBe(100);
    /* B's 20% is now the single President's card; A's 10% is one ordinary card; C keeps two. */
    expect(certificateCount(B, after)).toBe(1);
    expect(certificateCount(A, after)).toBe(1);
    expect(certificateCount(C, after)).toBe(2);
  });
});

describe("8. the forced-sale projection agrees with the settlement (6.6.3)", () => {
  const funding = { companyId: PRR, ticker: "PRR", president: A, shortfall: 100 };

  /** The successor the PREDICTOR names, and the successor the REDUCER actually crowns, for one sale. */
  const both = (state: GameStateResponse, percentage: number) => ({
    predicted: presidentAfterSale(corpOf(state, PRR), A, percentage, state.player_addresses),
    settled: corpOf(apply(state, SELL(PRR, percentage), A), PRR).president,
  });

  it("agrees on the clockwise tie, on the wraparound tie and on a tie with the incumbent", () => {
    /* THE ASSERTION THAT MATTERS, and it is an equality between two code paths rather than against a
       hand-written name: a predictor with its own tie rule would refuse a legal sale, or pass one whose
       settlement then moves a crown 6.6.3 forbids moving. */
    const clockwise = board({
      corps: [{ id: PRR, ticker: "PRR", president: A, ipo: 30, pool: 0, holdings: [[C, 20], [A, 30], [B, 20]] }],
    });
    expect(both(clockwise, 20)).toEqual({ predicted: B, settled: B });
    expect(both(clockwise, 10)).toEqual({ predicted: A, settled: A });

    /* Wraparound: the incumbent at seat 2, the tied challengers at seats 3 and 0. */
    const wraps = board({
      seating: [B, C, A, D],
      corps: [{ id: PRR, ticker: "PRR", president: A, ipo: 30, pool: 0, holdings: [[B, 20], [A, 30], [D, 20]] }],
    });
    expect(both(wraps, 20)).toEqual({ predicted: D, settled: D });
  });

  it("cannot be made to diverge by reordering the holdings", () => {
    const orders: Array<ReadonlyArray<readonly [string, number]>> = [
      [[C, 20], [A, 30], [B, 20]],
      [[A, 30], [B, 20], [C, 20]],
      [[B, 20], [C, 20], [A, 30]],
    ];
    for (const holdings of orders) {
      const state = board({ corps: [{ id: PRR, ticker: "PRR", president: A, ipo: 30, pool: 0, holdings }] });
      const { predicted, settled } = both(state, 20);
      expect(predicted).toBe(settled);
      expect(predicted).toBe(B);
    }
  });

  it("refuses the forced sale precisely when the projected crown moves", () => {
    /* The legality answer the projection feeds. Selling 20% drops A to 10% and hands the crown to B, which a
       forced sale may not do; selling 10% leaves A level at 20% and keeps it, which it may. */
    const state = board({
      corps: [{ id: PRR, ticker: "PRR", president: A, ipo: 30, pool: 0, holdings: [[C, 20], [A, 30], [B, 20]] }],
    });
    expect(forcedSaleRefusal(state, funding, A, PRR, 20)).toMatch(/would hand its presidency to another player/);
    expect(forcedSaleRefusal(state, funding, A, PRR, 10)).toBeNull();
    // And the sale it allows really does leave the crown where it was.
    expect(corpOf(apply(state, SELL(PRR, 10), A), PRR).president).toBe(A);
  });
});
