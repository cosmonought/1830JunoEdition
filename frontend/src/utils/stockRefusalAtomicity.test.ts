/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1570 (atomicity): A REFUSED STOCK TRANSACTION DOES NOT HAPPEN BY HALVES (Batch 7.2)
// ==================================================================
//
// Batch 7.1 proved this for the two transactions its LEDGER refused; Batch 7.2 adds a dozen rules in front of
// that boundary, and every one of them is a new way for an arm to be entered and then abandoned. A share that
// moved without being paid for, a par written on a corporation nobody could pay to start, a `bought_this_turn`
// spent on a purchase that did not occur, a Bank Pool drawn down by a purchase that was refused -- each is a
// board no replay can reproduce.
//
// THE METHOD IS 7.1's, DELIBERATELY: compare `fieldDigests` across the WHOLE state and assert the exact list
// of top-level fields that differ, so an arm that later writes something new before its gate fails this file
// rather than passing it. The primary cases assert `[]` -- literal whole-state equality -- because Batch 7.2
// asks its predicates in `applySandboxActionCore` AHEAD of every stage, so a refused message never reaches
// the settle chain at all and the board comes back by identity.
//
// AND THE SALE HAS A SECOND HALF THE PURCHASE DOES NOT. The chart atom advances BEFORE the board (#272/#273),
// so a refused sale has two ways to leave a mark: the money, and the TOKEN. `saleRefused` (#748a) asks the
// same predicate the core will, and the cases below assert the token is exactly where it began -- cell,
// price and arrival ordinal -- for every refused sale.
//
// Every case names the rule it refuses under, and every rule has an ACCEPTANCE CONTROL, so no case can be
// satisfied by an engine that refuses everything.

export {};

const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { fieldDigests, stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { moneyConservationBreach } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { marketZoneForPrice, parBoxCellFor } =
  require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const { projectShareSaleMove } = require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const P1 = "p1";
const P2 = "p2";
const PRR = 1;
const NYC = 2;

/** Every top-level field whose canonical form differs. The empty array is the strongest claim this file can
 *  make; a short, named array is the second strongest. */
const differingFields = (before: GameStateResponse, after: GameStateResponse): string[] => {
  const was = fieldDigests(before);
  const now = fieldDigests(after);
  return Object.keys({ ...was, ...now })
    .filter((key) => was[key] !== now[key])
    .sort();
};

/** The transaction facts a half-applied purchase or sale would disturb, read one by one -- because the field
 *  list above is only as good as its reader. */
const transactionFacts = (state: GameStateResponse) => ({
  cashP1: state.player_cash.find((entry) => entry.player === P1)?.cash_vgp,
  cashP2: state.player_cash.find((entry) => entry.player === P2)?.cash_vgp,
  bank: state.virtual_bank_vgp,
  bankBroken: state.bank_broken,
  prr: state.public_companies.find((entry) => entry.company_id === PRR),
  nyc: state.public_companies.find((entry) => entry.company_id === NYC),
  boughtThisTurn: state.bought_this_turn,
  boughtThisTurnCompany: state.bought_this_turn_company,
  turnActionTaken: state.turn_action_taken,
  stockTurnStage: state.stock_turn_stage,
  lastTrader: state.last_trader_index,
  activePlayer: state.active_player_index,
  priorityDeal: state.priority_deal_index,
  consecutivePasses: state.consecutive_passes,
  soldThisRound: state.sold_this_round,
  market: state.market_positions,
});

function board(over: Partial<GameStateResponse> = {}, cash: Record<string, number> = {}): GameStateResponse {
  return {
    current_round_type: "StockRound",
    macro_round_number: 2,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    /* The two fields the settle chain derives from the board on EVERY message (`settleEra` #1303,
       `settleOperatingCursor` #656), supplied up front so these cases can assert literal whole-state
       equality rather than name a normalisation. 7.1 §9a proves they are the pipeline's and not the
       transaction's; this file does not re-prove it. */
    current_global_era: "Yellow",
    rules_engine_version: 4,
    variants: { rules: 1 },
    player_addresses: [P1, P2],
    player_cash: [P1, P2].map((player) => ({ player, cash_vgp: String(cash[player] ?? 60) })),
    virtual_bank_vgp: "9000",
    private_companies: [],
    market_positions: {
      [PRR]: { price: 100, ...parBoxCellFor(100)!, enteredAt: 1 },
    },
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        president: P2,
        par_value: "100",
        is_floated: true,
        treasury: "0",
        owned_trains: [],
        ipo_pool_percentage: 30,
        bank_pool_percentage: 20,
        player_holdings: [
          { player: P2, percentage: 20 },
          { player: P1, percentage: 30 },
        ],
        station_token_hexes: [],
        station_tokens: [],
        total_shares_issued: 0,
      },
      {
        company_id: NYC,
        ticker: "NYC",
        president: null,
        par_value: null,
        is_floated: false,
        treasury: "0",
        owned_trains: [],
        ipo_pool_percentage: 100,
        bank_pool_percentage: 0,
        player_holdings: [],
        station_token_hexes: [],
        station_tokens: [],
        total_shares_issued: 0,
      },
    ],
    ...over,
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
    /* THE REAL PROJECTION, not a stub: a sale that is allowed through MUST move the token, or the control
       below would be satisfied by a chart that never moves and the refusals would prove nothing. */
    marketContext: { projectSale: (from: { x: number; y: number; price: number }, blocks: number) => projectShareSaleMove(from, blocks) },
  };
};

const apply = (state: GameStateResponse, msg: unknown, actor: string | null) =>
  applySandboxAction(state, msg as never, ctxFor(state, actor) as never);

const BUY = (id: number, over: Record<string, unknown> = {}) => ({
  BuyStock: { game_id: 0, protocol_id: id, source: "Ipo", ...over },
});
const SELL = (id: number, percentage: number) => ({ SellStock: { game_id: 0, protocol_id: id, percentage } });

/* ==================================================================================================== */

describe("every refused purchase leaves the board exactly as it was", () => {
  const cases: Array<[string, GameStateResponse, unknown, string]> = [
    [
      "an Operating Round purchase (S7-13)",
      board({ current_round_type: "OperatingRound", operating_sub_phase: "Hardware", active_operating_order: [PRR], active_corporation_index: 0 }, { [P1]: 1000 }),
      BUY(PRR),
      "round",
    ],
    [
      "a purchase during the private auction (S7-13)",
      board({ current_round_type: "WaterfallAuction", macro_round_number: 1 }, { [P1]: 1000 }),
      BUY(PRR),
      "round",
    ],
    ["an unaffordable ordinary purchase (C3)", board({}, { [P1]: 99 }), BUY(PRR), "cash"],
    ["an unaffordable President's Certificate (C3)", board({}, { [P1]: 199 }), BUY(NYC, { par_value: "100" }), "cash"],
    ["an off-ladder par (S8-9)", board({}, { [P1]: 1000 }), BUY(NYC, { par_value: "85" }), "ladder"],
    ["an omitted par (m8)", board({}, { [P1]: 1000 }), BUY(NYC), "ladder"],
    [
      "a purchase from an empty IPO (m9)",
      board({ public_companies: board().public_companies.map((c) => (c.company_id === PRR ? { ...c, ipo_pool_percentage: 0 } : c)) } as unknown as Partial<GameStateResponse>, { [P1]: 1000 }),
      BUY(PRR),
      "source",
    ],
    [
      "a purchase from an empty Bank Pool (m9)",
      board({ public_companies: board().public_companies.map((c) => (c.company_id === PRR ? { ...c, bank_pool_percentage: 0 } : c)) } as unknown as Partial<GameStateResponse>, { [P1]: 1000 }),
      BUY(PRR, { source: "Bank" }),
      "source",
    ],
    [
      "a multi-certificate request the pool cannot fill (Q13 / D-25)",
      board({}, { [P1]: 1000 }),
      BUY(PRR, { source: "Bank", quantity: 3 }),
      "source",
    ],
    [
      "a Brown continuation naming a second corporation (S7-18)",
      board({ bought_this_turn: 1, bought_this_turn_company: NYC } as Partial<GameStateResponse>, { [P1]: 1000 }),
      BUY(PRR),
      "continuation",
    ],
  ];

  for (const [label, before, msg] of cases) {
    it(`${label}: no field moves at all`, () => {
      const after = apply(before, msg, P1);
      expect([label, differingFields(before, after)]).toEqual([label, []]);
      expect([label, after]).toEqual([label, before]); // literal whole-state equality
      expect([label, transactionFacts(after)]).toEqual([label, transactionFacts(before)]);
      expect([label, moneyConservationBreach(before, after)]).toEqual([label, null]);
    });
  }

  it("the control: a purchase that IS legal moves exactly the fields a purchase moves", () => {
    /* WITHOUT THIS EVERY CASE ABOVE IS VACUOUS -- an engine that refused everything would satisfy them all. */
    const before = board({}, { [P1]: 1000 });
    const after = apply(before, BUY(PRR), P1);
    expect(differingFields(before, after)).toEqual(
      /* No `active_player_index` and no `stock_turn_stage`: under Sell-Buy-Sell (#1443) the purchase is the
         MIDDLE of the turn, so the seat stays with the buyer and neither seat-moving function runs. */
      [
        "bought_this_turn",
        "bought_this_turn_company",
        "last_trader_index",
        "player_cash",
        "public_companies",
        "turn_action_taken",
        "virtual_bank_vgp",
      ].sort(),
    );
    expect(after.player_cash.find((e) => e.player === P1)?.cash_vgp).toBe("900");
    expect(after.virtual_bank_vgp).toBe("9100");
    expect(after.bought_this_turn_company).toBe(PRR);
    expect(moneyConservationBreach(before, after)).toBeNull();
  });

  it("the President's Certificate control: the presidency, the par and the 20% move together, or not at all", () => {
    const short = board({}, { [P1]: 199 });
    const refusedState = apply(short, BUY(NYC, { par_value: "100" }), P1);
    const nyc = refusedState.public_companies.find((c) => c.company_id === NYC)!;
    expect(nyc.president).toBeNull();
    expect(nyc.par_value).toBeNull();
    expect(nyc.is_floated).toBe(false);
    expect(nyc.treasury).toBe("0"); // NO 10 x par capitalisation
    expect(nyc.ipo_pool_percentage).toBe(100);

    const enough = board({}, { [P1]: 200 });
    const started = apply(enough, BUY(NYC, { par_value: "100" }), P1);
    const crowned = started.public_companies.find((c) => c.company_id === NYC)!;
    expect(crowned.president).toBe(P1);
    expect(crowned.par_value).toBe("100");
    expect(crowned.ipo_pool_percentage).toBe(80);
    expect(moneyConservationBreach(enough, started)).toBeNull();
  });
});

/* ==================================================================================================== */

describe("every refused sale leaves the market token exactly where it began (#748a)", () => {
  const tokenOf = (state: GameStateResponse) => state.market_positions?.[PRR] ?? null;

  const cases: Array<[string, GameStateResponse, unknown, string]> = [
    ["an ordinary sale in an Operating Round (S7-13)", board({ current_round_type: "OperatingRound", operating_sub_phase: "Hardware", active_operating_order: [PRR], active_corporation_index: 0 }), SELL(PRR, 10), P1],
    ["a sale in the first Stock Round (S8-7)", board({ macro_round_number: 1 }), SELL(PRR, 10), P1],
    ["a fractional bundle (S7-16)", board(), SELL(PRR, 15), P1],
    ["a bundle bigger than the holding", board(), SELL(PRR, 40), P1],
    [
      "a sale into a Bank Pool with no room",
      board({ public_companies: board().public_companies.map((c) => (c.company_id === PRR ? { ...c, bank_pool_percentage: 50 } : c)) } as unknown as Partial<GameStateResponse>),
      SELL(PRR, 10),
      P1,
    ],
    [
      /* P2 presides on 20% and no other holder reaches 20%, so there is nobody to hand the certificate to
         (#713/#6: per player, never a sum). `shareSaleBlock`'s rule, composed rather than forked. */
      "a presidency nobody can succeed to",
      board({
        public_companies: board().public_companies.map((c) =>
          c.company_id === PRR
            ? { ...c, ipo_pool_percentage: 50, player_holdings: [{ player: P2, percentage: 20 }, { player: P1, percentage: 10 }] }
            : c,
        ),
      } as unknown as Partial<GameStateResponse>),
      SELL(PRR, 20),
      P2,
    ],
  ];

  for (const [label, before, msg, actor] of cases) {
    it(`${label}: no token, no cash, no certificate`, () => {
      const after = apply(before, msg, actor);
      expect([label, differingFields(before, after)]).toEqual([label, []]);
      /* THE HALF THE PURCHASE DOES NOT HAVE. Asserted on the mark itself -- cell, price and arrival -- rather
         than on the digest alone, because a token that moved and came back would satisfy a digest. */
      expect([label, tokenOf(after)]).toEqual([label, tokenOf(before)]);
      expect([label, stateDigest(after)]).toEqual([label, stateDigest(before)]);
      expect([label, moneyConservationBreach(before, after)]).toEqual([label, null]);
    });
  }

  it("the control: a sale that IS legal pays the seller and drops the token one row per certificate", () => {
    const before = board();
    const after = apply(before, SELL(PRR, 20), P1);
    expect(differingFields(before, after)).not.toEqual([]);
    expect(after.player_cash.find((e) => e.player === P1)?.cash_vgp).toBe("260"); // 60 + 2 x $100, priced BEFORE the drop
    expect(after.virtual_bank_vgp).toBe("8800");
    expect(after.public_companies[0].bank_pool_percentage).toBe(40);
    /* The token MOVED -- two certificates, two rows down -- which is what makes the refusals above evidence. */
    expect(tokenOf(after)).not.toEqual(tokenOf(before));
    expect(Number(tokenOf(after)!.price)).toBeLessThan(Number(tokenOf(before)!.price));
    expect(moneyConservationBreach(before, after)).toBeNull();
  });

  it("the unparred-share control: refused before par, sold after it (S8-8)", () => {
    const granted = board({
      public_companies: board().public_companies.map((c) =>
        c.company_id === NYC ? { ...c, ipo_pool_percentage: 90, player_holdings: [{ player: P1, percentage: 10 }] } : c,
      ),
    } as unknown as Partial<GameStateResponse>);
    const refusedState = apply(granted, SELL(NYC, 10), P1);
    expect(differingFields(granted, refusedState)).toEqual([]);
    expect(refusedState.market_positions?.[NYC]).toBeUndefined(); // and no token was invented for it either

    const parred = board({
      market_positions: { ...(board().market_positions ?? {}), [NYC]: { price: 100, ...parBoxCellFor(100)!, enteredAt: 2 } },
      public_companies: board().public_companies.map((c) =>
        c.company_id === NYC
          ? { ...c, par_value: "100", president: P2, is_floated: true, ipo_pool_percentage: 70, player_holdings: [{ player: P1, percentage: 10 }, { player: P2, percentage: 20 }] }
          : c,
      ),
    } as unknown as Partial<GameStateResponse>);
    const sold = apply(parred, SELL(NYC, 10), P1);
    expect(differingFields(parred, sold)).not.toEqual([]);
    expect(sold.player_cash.find((e) => e.player === P1)?.cash_vgp).toBe("160");
  });
});

/* ==================================================================================================== */

describe("a refused SetBoPar writes no presidency and no par", () => {
  const withBo = () =>
    board({
      private_companies: [
        { private_id: 6, name: "Baltimore & Ohio", cost: "220", revenue_per_or: "30", owner: P1, owner_protocol_id: null, closed: false },
      ],
      public_companies: board().public_companies.map((c) => (c.company_id === NYC ? { ...c, ticker: "B&O" } : c)),
    } as unknown as Partial<GameStateResponse>);

  it("off the ladder: nothing at all moves", () => {
    const before = withBo();
    const after = apply(before, { SetBoPar: { player: P1, par_value: "85" } }, P1);
    expect(differingFields(before, after)).toEqual([]);
    expect(after).toEqual(before);
  });

  it("on the ladder: the certificate is granted and no money moves (the control, rulebook p.27)", () => {
    const before = withBo();
    const after = apply(before, { SetBoPar: { player: P1, par_value: "90" } }, P1);
    /* `market_positions` moves too, and it is not a charge: `reconcileParMarks` (#688) puts a token in the
       par box of every corporation that has a par, on the action that gives it one. */
    expect(differingFields(before, after)).toEqual(["market_positions", "public_companies"]);
    const bo = after.public_companies.find((c) => c.company_id === NYC)!;
    expect(bo.president).toBe(P1);
    expect(bo.par_value).toBe("90");
    expect(after.player_cash).toEqual(before.player_cash);
    expect(after.virtual_bank_vgp).toBe(before.virtual_bank_vgp);
    expect(moneyConservationBreach(before, after)).toBeNull();
  });
});
