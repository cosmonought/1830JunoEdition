/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1570 (harness): THE STOCK TRANSACTION, JUDGED BY THE AUTHORITY (Batch 7.2)
// ==================================================================
//
// Every case below builds a board, sends a REAL message through `applySandboxAction`, and reads the result
// back -- and asks `turnRefusal` the same question, so the two locks are pinned as agreeing rather than
// assumed to. Boards carry a chart (`market_positions`) because the price is now a fact about the board, so
// a chart state is rebuilt on every apply (#1196) and refusals are proven by DIGEST, never by object
// identity (S7-17 / S10-1).
//
// EVERY REFUSAL HAS AN ACCEPTANCE BESIDE IT. A suite of refusals can be satisfied by an engine that refuses
// everything; each rule here is therefore tested at the boundary -- the legal side and the illegal side of
// the same fact, one dollar or one certificate apart -- so no case can pass vacuously.
//
// Rulebook: §5.0 (the Stock Round turn), §5.1 (no sales in the first Stock Round; bundles), §5.2 (buy from
// the IPO at par, from the pool at market), §4.2 (par ∈ the ladder, the President's Certificate costs twice
// it), §4.4 (the Brown Bank Pool allowance is certificates of ONE corporation), p.15 (a granted share cannot
// be sold before the President's Certificate is bought), p.27 (the B&O private's free certificate).
// Owner rulings D-17 (Q4), D-22 (Q9), D-25 (Q13); design §7.2 / §7.3.

export {};

const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { moneyConservationBreach } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { marketZoneForPrice, parBoxCellFor, projectShareSaleMove, PAR_BOX_PRICES } =
  require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const { emergencyFundingFor, forcedSaleRefusal } =
  require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const {
  chartContextFromState,
  isFirstStockRound,
  ordinaryPercentAvailable,
  parLadderRefusal,
  priceStockPurchase,
  purchaseIntentOf,
  stockPurchaseRefusal,
  stockSaleRefusal,
} = require("../gameEngine/stockTransactionAuthority") as typeof import("../gameEngine/stockTransactionAuthority");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type MapGridResponse = import("../components/hexContractTypes").MapGridResponse;

const P1 = "p1";
const P2 = "p2";
const P3 = "p3";

/* Corporations, and what each is for.
     PRR   parred at $100, Normal zone, stock in both pools  -- the ordinary purchase and the forged par
     NYC   UNPARRED, a full IPO                              -- the President's Certificate and the ladder
     B&O   UNPARRED                                          -- SetBoPar
     ERIE  parred, BOTH POOLS EMPTY                          -- m9, the source that cannot deliver
     NYNH  parred, Brown ($30), a 40% Bank Pool              -- the Brown continuation
     C&O   parred, Orange ($40), a 40% Bank Pool             -- Orange gets no such allowance
     B&M   parred, Brown ($30), a 40% Bank Pool              -- the Brown continuation's OTHER corporation */
const PRR = 1;
const NYC = 2;
const BO = 3;
const ERIE = 4;
const NYNH = 5;
const CO = 6;
const BM = 7;
const NW = 8;

interface CorpSpec {
  id: number;
  ticker: string;
  president: string | null;
  par: number | null;
  ipo: number;
  pool: number;
  holdings?: Array<[string, number]>;
  price?: number | null;
  /** #1324: where the LPF 20% standard certificate is, when the corporation has one. */
  double?: "Ipo" | "Bank";
}

const CORPS: CorpSpec[] = [
  { id: PRR, ticker: "PRR", president: P2, par: 100, ipo: 30, pool: 20, holdings: [[P2, 20], [P1, 30]], price: 100 },
  { id: NYC, ticker: "NYC", president: null, par: null, ipo: 100, pool: 0, price: null },
  { id: BO, ticker: "B&O", president: null, par: null, ipo: 100, pool: 0, price: null },
  { id: ERIE, ticker: "ERIE", president: P3, par: 76, ipo: 0, pool: 0, holdings: [[P3, 100]], price: 76 },
  { id: NYNH, ticker: "NYNH", president: P3, par: 71, ipo: 0, pool: 40, holdings: [[P3, 60]], price: 30 },
  { id: CO, ticker: "C&O", president: P3, par: 82, ipo: 0, pool: 40, holdings: [[P3, 60]], price: 40 },
  { id: BM, ticker: "B&M", president: P3, par: 67, ipo: 0, pool: 40, holdings: [[P3, 60]], price: 30 },
  { id: NW, ticker: "N&W", president: null, par: null, ipo: 100, pool: 0, price: null, double: "Ipo" },
];

/** A Stock Round board with a chart, a pin and three players.
 *
 *  `rules: 1` (Sell-Buy-Sell, #1443) so a purchase does NOT move the seat -- which is what makes the Brown
 *  continuation reachable as a second message in one turn, the representation ruling Q9/D-22 preserves. */
function stockRound(over: Partial<GameStateResponse> = {}, cash: Record<string, number> = {}): GameStateResponse {
  return {
    current_round_type: "StockRound",
    macro_round_number: 2,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    rules_engine_version: 4,
    variants: { rules: 1 },
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: String(cash[player] ?? 1000) })),
    virtual_bank_vgp: "9000",
    private_companies: [],
    market_positions: Object.fromEntries(
      CORPS.filter((corp) => corp.price != null).map((corp) => [
        corp.id,
        { price: corp.price, ...(parBoxCellFor(corp.par ?? 0) ?? { x: 2, y: 3 }), enteredAt: corp.id },
      ]),
    ),
    public_companies: CORPS.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      president: corp.president,
      par_value: corp.par === null ? null : String(corp.par),
      is_floated: corp.par !== null,
      treasury: "0",
      owned_trains: [],
      ipo_pool_percentage: corp.ipo,
      bank_pool_percentage: corp.pool,
      player_holdings: (corp.holdings ?? []).map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [],
      station_tokens: [],
      total_shares_issued: 0,
      ...(corp.double ? { double_certificate: { at: corp.double } } : {}),
    })),
    ...over,
  } as unknown as GameStateResponse;
}

/** The reducer's own injections, assembled the way `chartInjections` does -- off the state, never off a copy
 *  (#1196), so the harness cannot hand the reducer a chart the board does not have (#1194). */
const ctxFor = (state: GameStateResponse, actor: string | null, mapGrid?: MapGridResponse) => {
  const positions = state.market_positions ?? {};
  const priceFor = (companyId: number): number | null => positions[companyId]?.price ?? null;
  return {
    actor,
    mapGrid,
    parCellFor: parBoxCellFor,
    marketZoneFor: (companyId: number) => marketZoneForPrice(priceFor(companyId)),
    zoneForPrice: marketZoneForPrice,
    marketPricesByCompany: Object.fromEntries(
      Object.entries(positions).map(([id, mark]) => [Number(id), mark?.price ?? null]),
    ) as Record<number, number | null>,
    /* THE REAL PROJECTION, never a stub: "the token did not move" is only evidence if a legal sale WOULD
       have moved it. #748a's whole subject. */
    marketContext: {
      projectSale: (from: { x: number; y: number; price: number }, blocks: number) => projectShareSaleMove(from, blocks),
    },
  };
};

const apply = (state: GameStateResponse, msg: unknown, actor: string | null, mapGrid?: MapGridResponse) =>
  applySandboxAction(state, msg as never, ctxFor(state, actor, mapGrid) as never);

/** A refused message leaves the board it was handed, byte for byte. */
const refused = (before: GameStateResponse, after: GameStateResponse) => stateDigest(before) === stateDigest(after);

const ingress = (state: GameStateResponse, actor: string, msg: unknown, mapGrid?: MapGridResponse) =>
  turnRefusal({ state, waterfall: null, actor, msg: msg as never, mapGrid });

const cashOf = (state: GameStateResponse, player: string) =>
  Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);
const heldBy = (state: GameStateResponse, id: number, player: string) =>
  state.public_companies.find((entry) => entry.company_id === id)!.player_holdings.find((h) => h.player === player)
    ?.percentage ?? 0;
const corp = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)!;

const BUY = (id: number, over: Record<string, unknown> = {}) => ({
  BuyStock: { game_id: 0, protocol_id: id, source: "Ipo", ...over },
});
const POOL = (id: number, over: Record<string, unknown> = {}) => BUY(id, { source: "Bank", ...over });
const SELL = (id: number, percentage: number) => ({ SellStock: { game_id: 0, protocol_id: id, percentage } });

/* ==================================================================================================== */

describe("1. a stock purchase is a Stock Round action (S7-13, rulebook §5.0)", () => {
  it("refuses a purchase in an Operating Round, and says so at ingress", () => {
    const or = stockRound({
      current_round_type: "OperatingRound",
      operating_sub_phase: "Hardware",
      active_operating_order: [PRR],
      active_corporation_index: 0,
    });
    const after = apply(or, BUY(PRR, { par_value: "100" }), P1);
    expect(refused(or, after)).toBe(true);
    expect(ingress(or, P2, BUY(PRR, { par_value: "100" }))).toContain("only be bought during a Stock Round");
  });

  it("refuses a purchase during the private company auction", () => {
    const auction = stockRound({ current_round_type: "WaterfallAuction", macro_round_number: 1 });
    const after = apply(auction, BUY(PRR, { par_value: "100" }), P1);
    expect(refused(auction, after)).toBe(true);
    expect(stockPurchaseRefusal({
      state: auction,
      buy: purchaseIntentOf(BUY(PRR).BuyStock as never),
      actor: P1,
      ctx: chartContextFromState(auction),
    })).toContain("private company auction");
  });

  it("allows the same purchase in a Stock Round (the control)", () => {
    const before = stockRound();
    const after = apply(before, BUY(PRR, { par_value: "100" }), P1);
    expect(refused(before, after)).toBe(false);
    expect(heldBy(after, PRR, P1)).toBe(40); // 30% held, one certificate more
    expect(ingress(before, P1, BUY(PRR, { par_value: "100" }))).toBeNull();
  });
});

describe("2. the price is a fact about the board, not a field on the message (D-17 / Q4)", () => {
  it("charges the corporation's own par for an IPO share, whatever the payload says", () => {
    const before = stockRound({}, { [P1]: 500 });
    /* THE HOSTILE CASE. A $100 share, a payload that says the par is $1. */
    const forged = apply(before, BUY(PRR, { par_value: "1" }), P1);
    expect(cashOf(forged, P1)).toBe(400);
    expect(Number(forged.virtual_bank_vgp)).toBe(9100);
    expect(heldBy(forged, PRR, P1)).toBe(40);
    expect(moneyConservationBreach(before, forged)).toBeNull();

    // A payload that says $999, and one that says nothing at all, buy the same share for the same $100.
    expect(cashOf(apply(before, BUY(PRR, { par_value: "999" }), P1), P1)).toBe(400);
    expect(cashOf(apply(before, BUY(PRR), P1), P1)).toBe(400);
    expect(corp(forged, PRR).par_value).toBe("100");
  });

  it("prices a Bank Pool share from the authoritative market position, not from the payload", () => {
    const before = stockRound({}, { [P1]: 500 });
    const bought = apply(before, POOL(PRR, { par_value: "1" }), P1);
    expect(cashOf(bought, P1)).toBe(400); // PRR's token stands on $100
    expect(corp(bought, PRR).bank_pool_percentage).toBe(10);
    expect(moneyConservationBreach(before, bought)).toBeNull();

    // And a Brown-zone pool share costs what ITS token stands on, not what PRR's does.
    expect(cashOf(apply(before, POOL(NYNH), P1), P1)).toBe(470);
  });

  it("refuses a pool purchase of a corporation with no market position on a pinned board", () => {
    /* A corporation with stock in the Bank Pool and no token is a board no play can reach -- stock reaches
       the pool by being sold, and a sale needs a par -- which is exactly why it is worth refusing rather than
       pricing at the reducer's nominal (§7.2 rule 4). NYC is unparred, so nothing re-places a par mark for it
       (`reconcileParMarks`, #688) and the refusal is whole-state identical. */
    const before = stockRound({
      public_companies: stockRound().public_companies.map((c) =>
        c.company_id === NYC ? { ...c, bank_pool_percentage: 40 } : c,
      ),
    } as unknown as Partial<GameStateResponse>);
    expect(before.market_positions?.[NYC]).toBeUndefined();
    expect(refused(before, apply(before, POOL(NYC), P1))).toBe(true);
    expect(ingress(before, P1, POOL(NYC))).toContain("no price on the market chart");

    /* AND THE LEGACY BOARD IS NOT REFUSED (D-9): the development corpus and the hand-built fixtures predate
       the invariant that every parred corporation has a mark, so an unpinned board keeps the nominal it was
       played on rather than being stranded by a rule its game never had. */
    const { rules_engine_version: _pin, ...legacy } = before;
    expect(refused(legacy as GameStateResponse, apply(legacy as GameStateResponse, POOL(NYC), P1))).toBe(false);
  });
});

describe("3. the President's Certificate: the corporation's state decides, the ladder validates (S8-9)", () => {
  const start = (over: Record<string, unknown>, cash = 1000) =>
    ({ before: stockRound({}, { [P1]: cash }), msg: BUY(NYC, over) });

  it("is what an IPO purchase of an unparred corporation IS -- and it needs a par", () => {
    const { before, msg } = start({}); // no par_value at all
    expect(refused(before, apply(before, msg, P1))).toBe(true);
    expect(ingress(before, P1, msg)).toContain("cannot be started without a par value");
    /* THERE IS NO $67 FALLBACK (m8). The old engine converted this into a president's purchase at $67. */
    expect(corp(apply(before, msg, P1), NYC).par_value).toBeNull();
    expect(corp(apply(before, msg, P1), NYC).president).toBeNull();
  });

  it("refuses a par that is not a par space on the chart in effect", () => {
    for (const par of ["85", "1", "999", "0", "-67", "90.5", "abc"]) {
      const { before, msg } = start({ par_value: par });
      expect([par, refused(before, apply(before, msg, P1))]).toEqual([par, true]);
      expect([par, ingress(before, P1, msg)]).toEqual([par, expect.stringContaining("par")]);
    }
    // ...and every price on the printed ladder is accepted (the control).
    for (const par of PAR_BOX_PRICES) {
      const { before, msg } = start({ par_value: String(par) }, 2 * par);
      const after = apply(before, msg, P1);
      expect([par, corp(after, NYC).par_value]).toEqual([par, String(par)]);
      expect([par, corp(after, NYC).president]).toEqual([par, P1]);
      expect([par, cashOf(after, P1)]).toEqual([par, 0]);
    }
  });

  it("costs exactly twice par, to the dollar (rulebook §4.2)", () => {
    const enough = stockRound({}, { [P1]: 200 });
    const crowned = apply(enough, BUY(NYC, { par_value: "100" }), P1);
    expect(cashOf(crowned, P1)).toBe(0);
    expect(Number(crowned.virtual_bank_vgp)).toBe(9200);
    expect(heldBy(crowned, NYC, P1)).toBe(20);
    expect(corp(crowned, NYC).ipo_pool_percentage).toBe(80);
    expect(moneyConservationBreach(enough, crowned)).toBeNull();

    /* ONE DOLLAR SHORT. The boundary, on the side the rule is about. */
    const short = stockRound({}, { [P1]: 199 });
    expect(refused(short, apply(short, BUY(NYC, { par_value: "100" }), P1))).toBe(true);
    expect(ingress(short, P1, BUY(NYC, { par_value: "100" }))).toContain("$200");
  });

  it("is one certificate, and never the LPF double", () => {
    const before = stockRound({}, { [P1]: 1000 });
    expect(refused(before, apply(before, BUY(NYC, { par_value: "100", quantity: 2 }), P1))).toBe(true);
    expect(ingress(before, P1, BUY(NYC, { par_value: "100", quantity: 2 }))).toContain("one President's Certificate");
    /* N&W carries the LPF 20% standard certificate in its IPO (#1324), so the double IS where the payload
       says it is -- and the purchase that STARTS a corporation is still the President's 20%, never that card. */
    expect(refused(before, apply(before, BUY(NW, { par_value: "100", certificate: "double" }), P1))).toBe(true);
    expect(ingress(before, P1, BUY(NW, { par_value: "100", certificate: "double" }))).toContain("President's Certificate");
    // ...and the same corporation starts normally when the payload does not name the double (the control).
    expect(corp(apply(before, BUY(NW, { par_value: "100" }), P1), NW).president).toBe(P1);
  });

  it("refuses when the 20% card is not in the IPO to be taken", () => {
    const drained = stockRound({
      public_companies: stockRound().public_companies.map((c) =>
        c.company_id === NYC ? { ...c, ipo_pool_percentage: 10 } : c,
      ),
    } as unknown as Partial<GameStateResponse>);
    expect(refused(drained, apply(drained, BUY(NYC, { par_value: "100" }), P1))).toBe(true);
    expect(ingress(drained, P1, BUY(NYC, { par_value: "100" }))).toContain("President's Certificate");
  });

  it("distinguishes the corporation's par from the message's, which is the confusion m8 was made of", () => {
    /* `corporation.par_value === null` is a fact about the board; `message.par_value === null` is a field a
       client chose to send. PRR is parred, so a payload with NO par is an ORDINARY purchase at PRR's par --
       not a presidency grab; NYC is unparred, so the same payload is refused rather than converted. */
    const before = stockRound({}, { [P1]: 1000 });
    const ordinary = apply(before, BUY(PRR), P1);
    expect(heldBy(ordinary, PRR, P1)).toBe(40);
    expect(corp(ordinary, PRR).par_value).toBe("100"); // unchanged: this purchase sets no par
    expect(cashOf(ordinary, P1)).toBe(900); // one share at PRR's par, not two at a par the payload chose
    /* The presidency does move -- to the largest holder, by `settlePresidencies` (#596), which is a
       consequence of the HOLDINGS and not of this being a president's purchase. Batch 7.2 does not touch it. */
    expect(corp(ordinary, PRR).president).toBe(P1);
    expect(refused(before, apply(before, BUY(NYC), P1))).toBe(true);
  });
});

describe("4. the certificate has to be in the source (m9, ruled Q13 / D-25)", () => {
  it("refuses a purchase from an empty IPO and from an empty Bank Pool -- outright", () => {
    const before = stockRound({}, { [P1]: 1000 });
    expect(refused(before, apply(before, BUY(ERIE), P1))).toBe(true);
    expect(refused(before, apply(before, POOL(ERIE), P1))).toBe(true);
    expect(ingress(before, P1, BUY(ERIE))).toContain("IPO");
    expect(ingress(before, P1, POOL(ERIE))).toContain("Bank Pool");
    // Nothing charged and nothing delivered: the exact shape of m9, closed.
    expect(cashOf(apply(before, BUY(ERIE), P1), P1)).toBe(1000);
    expect(heldBy(apply(before, BUY(ERIE), P1), ERIE, P1)).toBe(0);
  });

  it("refuses a multi-certificate request the pool cannot fill -- never caps it, never charges less", () => {
    /* NYNH is Brown with 40% (four certificates) in the pool. Five is refused; four is the control. */
    const before = stockRound({}, { [P1]: 1000 });
    expect(refused(before, apply(before, POOL(NYNH, { quantity: 5 }), P1))).toBe(true);
    expect(ingress(before, P1, POOL(NYNH, { quantity: 5 }))).toContain("40%");

    const four = apply(before, POOL(NYNH, { quantity: 4 }), P1);
    expect(heldBy(four, NYNH, P1)).toBe(40);
    expect(cashOf(four, P1)).toBe(1000 - 4 * 30);
    expect(corp(four, NYNH).bank_pool_percentage).toBe(0);
    expect(moneyConservationBreach(before, four)).toBeNull();
  });

  it("does not count the President's Certificate reserved in an unparred IPO as ordinary stock", () => {
    const before = stockRound();
    const nyc = corp(before, NYC);
    expect(ordinaryPercentAvailable(nyc, "Ipo")).toBe(80); // 100% less the 20% card that starts it
    expect(ordinaryPercentAvailable(corp(before, PRR), "Ipo")).toBe(30); // parred: nothing is reserved
  });
});

describe("5. affordability, at the dollar (audit C3)", () => {
  it("allows a purchase with exactly the price and refuses it one dollar short", () => {
    const exact = stockRound({}, { [P1]: 100 });
    expect(cashOf(apply(exact, BUY(PRR), P1), P1)).toBe(0);
    const short = stockRound({}, { [P1]: 99 });
    expect(refused(short, apply(short, BUY(PRR), P1))).toBe(true);
    expect(ingress(short, P1, BUY(PRR))).toContain("$100");
  });

  it("applies the same boundary to a multi-certificate Brown purchase", () => {
    const exact = stockRound({}, { [P1]: 120 });
    expect(cashOf(apply(exact, POOL(NYNH, { quantity: 4 }), P1), P1)).toBe(0);
    const short = stockRound({}, { [P1]: 119 });
    expect(refused(short, apply(short, POOL(NYNH, { quantity: 4 }), P1))).toBe(true);
    expect(ingress(short, P1, POOL(NYNH, { quantity: 4 }))).toContain("$120");
  });
});

describe("6. the Brown Bank Pool continuation names ONE corporation (S7-18, ruled Q9 / D-22)", () => {
  const opened = (companyId: number) =>
    stockRound({ bought_this_turn: 1, bought_this_turn_company: companyId } as Partial<GameStateResponse>, {
      [P1]: 1000,
    });

  it("records the corporation the turn's first purchase opened with", () => {
    const before = stockRound({}, { [P1]: 1000 });
    const first = apply(before, POOL(NYNH), P1);
    expect(first.bought_this_turn).toBe(1);
    expect(first.bought_this_turn_company).toBe(NYNH);
  });

  it("allows a second Brown Bank Pool message naming the SAME corporation", () => {
    const before = opened(NYNH);
    const second = apply(before, POOL(NYNH), P1);
    expect(refused(before, second)).toBe(false);
    expect(heldBy(second, NYNH, P1)).toBe(10);
    expect(second.bought_this_turn).toBe(2);
    expect(second.bought_this_turn_company).toBe(NYNH);
    expect(ingress(before, P1, POOL(NYNH))).toBeNull();
  });

  it("refuses a second Brown Bank Pool message naming a DIFFERENT corporation", () => {
    const before = opened(NYNH);
    expect(refused(before, apply(before, POOL(BM), P1))).toBe(true);
    expect(ingress(before, P1, POOL(BM))).toContain("ONE corporation");
  });

  it("does not extend the allowance to the Orange zone", () => {
    /* C&O's token stands at $40 -- Orange, which lifts the 60% cap and the certificate limit and says
       nothing at all about how many certificates one purchase may take. */
    const before = opened(CO);
    expect(refused(before, apply(before, POOL(CO), P1))).toBe(true);
    expect(ingress(before, P1, POOL(CO))).toContain("One certificate purchase per turn");
    expect(refused(stockRound({}, { [P1]: 1000 }), apply(stockRound({}, { [P1]: 1000 }), POOL(CO, { quantity: 2 }), P1))).toBe(true);
  });

  it("clears the record wherever `bought_this_turn` is cleared", () => {
    const before = stockRound({}, { [P1]: 1000 });
    const bought = apply(before, POOL(NYNH), P1);
    expect(bought.bought_this_turn_company).toBe(NYNH);
    /* A Pass moves the seat, and the turn's facts die with the turn (#745 / #1172). */
    const passed = apply(bought, { PassTurn: { game_id: 0 } }, P1);
    expect(passed.bought_this_turn).toBe(0);
    expect(passed.bought_this_turn_company).toBeUndefined();
  });

  it("says nothing about a board that carries no record (#232)", () => {
    /* A board rebuilt mid-turn from a log written before the field existed: absent is "not said", so the
       continuation rule has no opinion and a legacy replay keeps replaying. */
    const legacy = stockRound({ bought_this_turn: 1 } as Partial<GameStateResponse>, { [P1]: 1000 });
    expect(legacy.bought_this_turn_company).toBeUndefined();
    expect(stockPurchaseRefusal({
      state: legacy,
      buy: purchaseIntentOf(POOL(BM).BuyStock as never),
      actor: P1,
      ctx: { ...chartContextFromState(legacy), marketZoneFor: (id: number) => marketZoneForPrice(legacy.market_positions?.[id]?.price ?? null) },
    })).toBeNull();
  });
});

/* ==================================================================================================== */

describe("7. a sale is a Stock Round action, with the §6.6.3 exception (S7-13 / Batch 5)", () => {
  const or = () =>
    stockRound({
      current_round_type: "OperatingRound",
      operating_sub_phase: "Hardware",
      active_operating_order: [PRR],
      active_corporation_index: 0,
    });

  it("refuses an ordinary sale in an Operating Round", () => {
    const before = or();
    expect(refused(before, apply(before, SELL(PRR, 10), P2))).toBe(true);
    expect(ingress(before, P2, SELL(PRR, 10))).toContain("only be sold during a Stock Round");
  });

  /* The Batch-5 board: C&O operates at Buy Trains with no train, a legal route and no money, so its
     president must sell. The corridor is the two-tile grid `emergencyFunding.test.ts` runs on.
     P1 holds 30 % of PRR at $100 against a $30 shortfall, so ONE certificate is "only enough" (§6.6.3) and
     TWO is not -- which gives the two tests below a legal and an illegal forced sale on one board. */
  const forcedBoard = () => {
    const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
    const H16 = hex("H16");
    const I17 = hex("I17");
    const CORRIDOR = {
      game_id: 1,
      tiles: [
        { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
        { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
      ],
    } as unknown as MapGridResponse;

    const forced = stockRound(
      {
        current_round_type: "OperatingRound",
        operating_sub_phase: "Hardware",
        macro_round_number: 3,
        sub_round_index: 1,
        active_operating_order: [CO],
        active_corporation_index: 0,
        public_companies: stockRound().public_companies.map((c) =>
          c.company_id === CO
            ? {
                ...c,
                president: P1,
                treasury: "30",
                owned_trains: [],
                player_holdings: [{ player: P1, percentage: 60 }, { player: P2, percentage: 20 }],
                station_token_hexes: [[H16.q, H16.r]],
                station_tokens: [[H16.q, H16.r, 0]],
                station_token_limit: 3,
                home_hex_label: "F6",
              }
            : c.company_id === PRR
              ? {
                  ...c,
                  president: P3,
                  ipo_pool_percentage: 10,
                  player_holdings: [{ player: P3, percentage: 40 }, { player: P1, percentage: 30 }],
                }
              : c,
        ),
      } as unknown as Partial<GameStateResponse>,
      { [P1]: 20, [P2]: 300, [P3]: 300 },
    );
    return { forced, CORRIDOR };
  };

  it("keeps the forced sale legal when the §6.6.3 obligation names that president", () => {
    const { forced, CORRIDOR } = forcedBoard();
    const owed = emergencyFundingFor(forced, CORRIDOR);
    expect(owed).not.toBeNull();
    expect(owed!.president).toBe(P1);
    expect(owed!.shortfall).toBe(30);

    /* THE ACCEPTANCE CONTROL, and owner ruling D-28 makes its second line load-bearing: ingress must surface
       the same rule RESULT, so a legal forced sale has to be answered `null` there too -- otherwise "only
       illegal attempts gain an explanatory response" would not be true. */
    expect(stockSaleRefusal({ state: forced, sell: { companyId: PRR, percentage: 10 }, actor: P1, mapGrid: CORRIDOR, ctx: chartContextFromState(forced) })).toBeNull();
    expect(ingress(forced, P1, SELL(PRR, 10), CORRIDOR)).toBeNull();

    const sold = apply(forced, SELL(PRR, 10), P1, CORRIDOR);
    expect(refused(forced, sold)).toBe(false);
    expect(cashOf(sold, P1)).toBe(20 + 100);
    expect(heldBy(sold, PRR, P1)).toBe(20);
    expect(corp(sold, PRR).bank_pool_percentage).toBe(30);
    /* ...and the market DID move for the sale that happened, which is what makes "it did not move" in the
       next test evidence rather than a property of the harness. */
    expect(sold.market_positions?.[PRR]).not.toEqual(forced.market_positions?.[PRR]);

    // ...and nobody else's sale rides on his obligation.
    expect(stockSaleRefusal({ state: forced, sell: { companyId: PRR, percentage: 10 }, actor: P3, mapGrid: CORRIDOR, ctx: chartContextFromState(forced) })).toContain("only be sold during a Stock Round");
  });

  it("answers an ILLEGAL forced sale with the forced-sale predicate's own sentence, at both locks (D-28)", () => {
    /* ==================================================================
        OWNER RULING D-28 (2026-09-15): THE FORCED SALE'S REFUSAL IS VISIBLE AT INGRESS
       ==================================================================
       "An illegal emergency/forced stock sale should return the authoritative refusal reason to the acting
       president rather than remain silent ... ingress must surface the same rule result, not implement a
       competing rule."

       THE CHECK THE RULING ASKS FOR IS STRING IDENTITY, which is why this asserts `toBe` three ways rather
       than `toContain`: `turnRefusal` makes exactly ONE call for a sale, to `stockSaleRefusal`, which asks
       `forcedSaleRefusal` last and unchanged. If anybody ever reconstructs the wording at the boundary --
       the #1184 shape this project has paid for three times -- these equalities are what breaks. */
    const { forced, CORRIDOR } = forcedBoard();
    const owed = emergencyFundingFor(forced, CORRIDOR)!;

    /* Illegal for a FORCED reason only: 20 % of PRR is two certificates at $100 against a $30 shortfall, and
       §6.6.3 is "only enough". The same bundle in a Stock Round is an ordinary, legal sale, so nothing but
       the forced rule is speaking here. */
    const fromTheRule = forcedSaleRefusal(forced, owed, P1, PRR, 20);
    expect(fromTheRule).toContain("Only enough may be sold");

    const fromTheAuthority = stockSaleRefusal({
      state: forced,
      sell: { companyId: PRR, percentage: 20 },
      actor: P1,
      mapGrid: CORRIDOR,
      ctx: chartContextFromState(forced),
    });
    const fromIngress = ingress(forced, P1, SELL(PRR, 20), CORRIDOR);

    // (1) ONE SOURCE: the same string, character for character, at all three layers.
    expect(fromTheAuthority).toBe(fromTheRule);
    expect(fromIngress).toBe(fromTheRule);

    /* (3) AND IT REFUSES BEFORE THE MARKET MOVES AND BEFORE ANY MONEY OR SHARE DOES. The market atom runs
       BEFORE the board (#272/#273), so those are two claims and both are made. */
    const after = apply(forced, SELL(PRR, 20), P1, CORRIDOR);
    expect(refused(forced, after)).toBe(true);
    expect(after.market_positions?.[PRR]).toEqual(forced.market_positions?.[PRR]);
    expect(cashOf(after, P1)).toBe(20);
    expect(heldBy(after, PRR, P1)).toBe(30);
    expect(corp(after, PRR).bank_pool_percentage).toBe(20);
    expect(after.virtual_bank_vgp).toBe(forced.virtual_bank_vgp);
    // The obligation is untouched, so the president may still make the legal sale instead.
    expect(emergencyFundingFor(after, CORRIDOR)!.shortfall).toBe(owed.shortfall);
  });
});

describe("8. no selling in the first Stock Round (S8-7, rulebook §5.1)", () => {
  it("refuses a sale in SR1 and allows the same sale in SR2", () => {
    const sr1 = stockRound({ macro_round_number: 1 });
    expect(isFirstStockRound(sr1)).toBe(true);
    expect(refused(sr1, apply(sr1, SELL(PRR, 10), P1))).toBe(true);
    expect(ingress(sr1, P1, SELL(PRR, 10))).toContain("first Stock Round");

    const sr2 = stockRound({ macro_round_number: 2 });
    expect(refused(sr2, apply(sr2, SELL(PRR, 10), P1))).toBe(false);
    expect(ingress(sr2, P1, SELL(PRR, 10))).toBeNull();
  });

  it("reads the Delayed Auction's first Stock Round the same way, and its SR3 as an ordinary one", () => {
    /* The delayed variant deals ON Stock Round 1 (#905), so SR1 is still macro round 1; the auction is
       inserted later as its own round and takes the next number with it, so the Stock Round after it is
       macro round 3 and sales are allowed there. One reading, both boards (§12a). */
    const delayedSR1 = stockRound({ macro_round_number: 1, variants: { rules: 1, delayedAuction: true } } as Partial<GameStateResponse>);
    expect(isFirstStockRound(delayedSR1)).toBe(true);
    expect(refused(delayedSR1, apply(delayedSR1, SELL(PRR, 10), P1))).toBe(true);

    const delayedSR3 = stockRound({ macro_round_number: 3, variants: { rules: 1, delayedAuction: true } } as Partial<GameStateResponse>);
    expect(isFirstStockRound(delayedSR3)).toBe(false);
    expect(refused(delayedSR3, apply(delayedSR3, SELL(PRR, 10), P1))).toBe(false);
  });
});

describe("9. a share of a corporation that was never started cannot be sold (S8-8 / C&A / M&H, p.15)", () => {
  it("refuses the sale of a granted share before the President's Certificate has been bought", () => {
    /* The C&A grants its owner a PRR share and the M&H exchanges into one; either can be held before
       anybody has parred the corporation. `par_value === null` is the whole rule -- no variant-specific
       duplicate, because an unparred corporation has no price for a sale to be settled at. */
    const granted = stockRound({
      public_companies: stockRound().public_companies.map((c) =>
        c.company_id === NYC ? { ...c, ipo_pool_percentage: 90, player_holdings: [{ player: P1, percentage: 10 }] } : c,
      ),
    } as unknown as Partial<GameStateResponse>);
    expect(corp(granted, NYC).par_value).toBeNull();
    expect(heldBy(granted, NYC, P1)).toBe(10);
    expect(refused(granted, apply(granted, SELL(NYC, 10), P1))).toBe(true);
    expect(ingress(granted, P1, SELL(NYC, 10))).toContain("has not been started yet");

    // The control: once the corporation is parred, the same share sells.
    const parred = stockRound({
      public_companies: stockRound().public_companies.map((c) =>
        c.company_id === NYC
          ? { ...c, par_value: "100", president: P2, ipo_pool_percentage: 70, player_holdings: [{ player: P1, percentage: 10 }, { player: P2, percentage: 20 }] }
          : c,
      ),
      market_positions: { ...(stockRound().market_positions ?? {}), [NYC]: { price: 100, x: 6, y: 10, enteredAt: 9 } },
    } as unknown as Partial<GameStateResponse>);
    expect(refused(parred, apply(parred, SELL(NYC, 10), P1))).toBe(false);
  });
});

describe("10. a bundle is whole certificates (S7-16)", () => {
  it("refuses 15%, 5% and 0%, and allows 10% and 20%", () => {
    const before = stockRound({
      public_companies: stockRound().public_companies.map((c) =>
        c.company_id === PRR ? { ...c, bank_pool_percentage: 0, player_holdings: [{ player: P2, percentage: 20 }, { player: P1, percentage: 30 }] } : c,
      ),
    } as unknown as Partial<GameStateResponse>);
    for (const percentage of [15, 5, 0, -10, 12.5]) {
      expect([percentage, refused(before, apply(before, SELL(PRR, percentage), P1))]).toEqual([percentage, true]);
      expect([percentage, ingress(before, P1, SELL(PRR, percentage))]).toEqual([
        percentage,
        expect.stringContaining("whole 10% certificates"),
      ]);
    }
    expect(refused(before, apply(before, SELL(PRR, 10), P1))).toBe(false);
    expect(refused(before, apply(before, SELL(PRR, 20), P1))).toBe(false);
  });
});

describe("11. the B&O's free par must still be a par space (S8-9, rulebook p.27)", () => {
  const boBoard = () =>
    stockRound({
      private_companies: [
        { private_id: 6, name: "Baltimore & Ohio", cost: "220", revenue_per_or: "30", owner: P1, owner_protocol_id: null, closed: false },
      ],
    } as unknown as Partial<GameStateResponse>);
  const SET = (par: string) => ({ SetBoPar: { player: P1, par_value: par } });

  it("refuses an off-ladder or malformed par, at the reducer and at ingress", () => {
    const before = boBoard();
    for (const par of ["85", "1", "999", "0", "", "abc", "90.5"]) {
      expect([par, refused(before, apply(before, SET(par), P1))]).toEqual([par, true]);
      expect([par, ingress(before, P1, SET(par))]).toEqual([par, expect.stringContaining("par")]);
    }
    expect(corp(apply(before, SET("85"), P1), BO).president).toBeNull();
    expect(corp(apply(before, SET("85"), P1), BO).par_value).toBeNull();
  });

  it("grants the certificate at a legal par -- and charges nobody a cent", () => {
    const before = boBoard();
    const after = apply(before, SET("90"), P1);
    expect(corp(after, BO).president).toBe(P1);
    expect(corp(after, BO).par_value).toBe("90");
    expect(heldBy(after, BO, P1)).toBe(20);
    expect(corp(after, BO).ipo_pool_percentage).toBe(80);
    /* THE PRIVATE'S CERTIFICATE IS FREE (p.27): the par is validated, the money is not moved. */
    expect(cashOf(after, P1)).toBe(cashOf(before, P1));
    expect(Number(after.virtual_bank_vgp)).toBe(Number(before.virtual_bank_vgp));
    expect(moneyConservationBreach(before, after)).toBeNull();
    expect(ingress(before, P1, SET("90"))).toBeNull();
  });

  it("keeps its existing ownership and presidency preconditions", () => {
    const before = boBoard();
    // Not the private's owner: refused by the owner rule, which this batch does not touch.
    expect(ingress(before, P2, SET("90"))).toContain("owner");
    // Already presided: `boPresidencyRefusal`, unchanged.
    const taken = stockRound({
      public_companies: stockRound().public_companies.map((c) => (c.company_id === BO ? { ...c, president: P3 } : c)),
    } as unknown as Partial<GameStateResponse>);
    expect(refused(taken, apply(taken, SET("90"), P1))).toBe(true);
  });
});

describe("12. the unit under the wiring: the predicates themselves", () => {
  it("prices each kind of purchase from the board", () => {
    const state = stockRound();
    const ctx = chartContextFromState(state);
    expect(priceStockPurchase(state, purchaseIntentOf(BUY(PRR, { par_value: "1" }).BuyStock as never), ctx)).toEqual({
      ok: true,
      plan: { kind: "ordinary", certificates: 1, percentage: 10, price: 100, charged: 100, par: null },
    });
    expect(priceStockPurchase(state, purchaseIntentOf(POOL(NYNH, { quantity: 3 }).BuyStock as never), ctx)).toEqual({
      ok: true,
      plan: { kind: "ordinary", certificates: 3, percentage: 30, price: 30, charged: 90, par: null },
    });
    expect(priceStockPurchase(state, purchaseIntentOf(BUY(NYC, { par_value: "82" }).BuyStock as never), ctx)).toEqual({
      ok: true,
      plan: { kind: "president", certificates: 1, percentage: 20, price: 82, charged: 164, par: 82 },
    });
  });

  it("names the printed ladder in its refusal", () => {
    expect(parLadderRefusal("85")).toContain("$67");
    expect(parLadderRefusal("85")).toContain("$100");
    expect(parLadderRefusal(null)).toContain("par value");
    for (const par of PAR_BOX_PRICES) expect(parLadderRefusal(String(par))).toBeNull();
  });
});
