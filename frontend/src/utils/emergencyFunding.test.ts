/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1540 (harness): THE FORCED PURCHASE, ONE REAL ACTION AT A TIME
// ==================================================================
//
// Rulebook 6.6.2 / 6.6.3 / 6.7 (quoted in `emergencyFunding.ts`). The obligation is derived from the board;
// every case below builds a board, sends real messages, and reads the obligation back after each. Boards
// carry a chart (`market_positions`) so sales have prices, which means a chart state is rebuilt on every
// apply (#1196) and refusals are proven by digest rather than by identity.

export {};

const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { emergencyFundingFor, forcedSaleRefusal, emergencyFundingBlock, emergencyPurchaseRefusal, legalForcedSales, fundingPrivateOfferRefusal, fundingPrivateAnswerRefusal, declareBankruptcyRefusal, fundedTradeRefusal } =
  require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { rankPlayers } = require("../gameEngine/endgame") as typeof import("../gameEngine/endgame");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { replayLog, RoomEngine } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxWaterfallState, sandboxScenarioState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { DEVELOPMENT_CORPUS_POLICY, RULES_ENGINE_VERSION, RULES_ENGINE_CHANGELOG, RULES_ENGINE_VERSION_FIELD, SUPPORTED_RULES_ENGINE_VERSIONS } =
  require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { validateGameplayMessage } = require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type MapGridResponse = import("../components/hexContractTypes").MapGridResponse;
type ServerLogEntry = import("./roomSession").ServerLogEntry;

const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
const H16 = hex("H16");
const I17 = hex("I17");
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
  x?: number;
  y?: number;
}

function board(input: {
  corps: Corp[];
  operating?: number;
  step?: string;
  cash: Record<string, number>;
  returned?: string[];
  privates?: Array<{ private_id: number; owner: string; cost: string }>;
}): GameStateResponse {
  const order = input.corps.map((corp) => corp.id);
  const operating = input.operating ?? CO;
  return {
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: String(input.cash[player] ?? 0) })),
    virtual_bank_vgp: "10000",
    private_companies: (input.privates ?? []).map((priv) => ({
      private_id: priv.private_id,
      name: `Private ${priv.private_id}`,
      cost: priv.cost,
      revenue_per_or: "10",
      owner: priv.owner,
      owner_protocol_id: null,
      closed: false,
    })),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(operating),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: input.step ?? "Hardware",
    ...(input.returned ? { returned_trains: input.returned } : {}),
    market_positions: Object.fromEntries(
      input.corps.map((corp, index) => [corp.id, { price: corp.price, x: corp.x ?? 5 + index, y: corp.y ?? 6, enteredAt: index + 1 }]),
    ),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: true,
      president: corp.president,
      par_value: String(corp.price),
      ipo_pool_percentage: 0,
      bank_pool_percentage: corp.pool ?? 0,
      treasury: corp.treasury,
      owned_trains: corp.trains,
      player_holdings: corp.holdings.map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [[H16.q, H16.r]],
      station_tokens: [[H16.q, H16.r, 0]],
      station_token_limit: 3,
      home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

const company = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;
const cash = (state: GameStateResponse, player: string) => Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);
const held = (state: GameStateResponse, id: number, player: string) =>
  company(state, id).player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
const bank = (state: GameStateResponse) => Number(state.virtual_bank_vgp);
/** Every dollar on the board: players, treasuries, bank. Conserved by every purchase and sale. */
const allMoney = (state: GameStateResponse) =>
  bank(state) +
  state.player_cash.reduce((sum, entry) => sum + Number(entry.cash_vgp), 0) +
  state.public_companies.reduce((sum, entry) => sum + Number(entry.treasury), 0);

const apply = (state: GameStateResponse, msg: never, actor: string) => applySandboxAction(state, msg, { actor, mapGrid: CORRIDOR });
/** The real providers with the corridor as the board they seed -- the engine's grid comes from the providers
 *  (and from `LayTile` entries), not from the fixture state. */
const corridorProviders = () => ({ ...sandboxReplayProviders(), initialGrid: CORRIDOR });
const same = (a: GameStateResponse, b: GameStateResponse) => stateDigest(a) === stateDigest(b);
const funding = (state: GameStateResponse) => emergencyFundingFor(state, CORRIDOR);

const SELL = (id: number, percentage: number) => ({ SellStock: { game_id: 1, protocol_id: id, percentage } }) as never;
const EMERGENCY = (id: number) => ({ EmergencyBuyHardware: { game_id: 1, protocol_id: id } }) as never;
const BUY = (id: number) => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id } }) as never;
const BUY_MODEL = (id: number, model: string) => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, model_type: model } }) as never;
const PASS = { PassTurn: { game_id: 1 } } as never;
const ADVANCE = (id: number) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } }) as never;
const CLOSE = { CloseRoom: {} } as never;

/** Phase 2 (nobody owns a train), so the required train is the 2-train at $80. C&O (P1) has a legal route
 *  through the corridor and no train; P1 also holds NYC and PRR shares to sell. */
function base(over: Partial<{ treasury: string; cash: Record<string, number>; coHoldings: Array<[string, number]>; nycHoldings: Array<[string, number]>; prrHoldings: Array<[string, number]>; nycPrice: number; prrPrice: number; privates: Array<{ private_id: number; owner: string; cost: string }> }> = {}) {
  return board({
    privates: over.privates,
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: over.treasury ?? "30", holdings: over.coHoldings ?? [[P1, 60], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: over.nycHoldings ?? [[P2, 30], [P1, 20]], price: over.nycPrice ?? 100, x: 8, y: 8 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: over.prrHoldings ?? [[P3, 40], [P1, 10]], price: over.prrPrice ?? 50, x: 3 },
    ],
    cash: over.cash ?? { [P1]: 20, [P2]: 300, [P3]: 300 },
  });
}

/* ------------------------------------------------------------------ */
/* 1-3: when the obligation stands, and the money                        */
/* ------------------------------------------------------------------ */

describe("the obligation and the money (#1540, tests 1-3)", () => {
  it("1. a corporation that can pay owes no emergency: the ordinary purchase completes and the turn can end", () => {
    const state = base({ treasury: "200" });
    expect(funding(state)).toBeNull();
    expect(emergencyFundingBlock(state, PASS, CORRIDOR)).toBeNull();
    const bought = apply(state, BUY(CO), P1);
    expect(company(bought, CO).owned_trains).toEqual(["2"]);
    expect(Number(company(bought, CO).treasury)).toBe(120);
    expect(allMoney(bought)).toBe(allMoney(state));
    expect(same(apply(bought, PASS, P1), bought)).toBe(false);
    // Negative control: the president's money may not be used when no forced purchase is owed.
    expect(emergencyPurchaseRefusal(state, CO, CORRIDOR, P1)).toContain("No forced train purchase is owed");
    expect(same(apply(state, EMERGENCY(CO), P1), state)).toBe(true);
  });

  it("2. treasury and president cash are conserved through the emergency purchase: all of the treasury, then the difference", () => {
    const state = base({ treasury: "30", cash: { [P1]: 100, [P2]: 300, [P3]: 300 } });
    const owed = funding(state)!;
    expect(owed).toMatchObject({ companyId: CO, president: P1, treasury: 30, presidentCash: 100, shortfall: 0, canPurchase: true, bankrupt: false });
    expect(owed.train).toEqual({ source: "depot", tier: "2", cost: 80, remaining: 6 });
    expect(owed.legalSales).toEqual([]);
    const bought = apply(state, EMERGENCY(CO), P1);
    expect(company(bought, CO).owned_trains).toEqual(["2"]);
    expect(Number(company(bought, CO).treasury)).toBe(0); // "All of the railroad's money must be spent"
    expect(cash(bought, P1)).toBe(50); // the president made up the $50 difference, and no more
    expect(bank(bought)).toBe(bank(state) + 80);
    expect(allMoney(bought)).toBe(allMoney(state));
    expect(funding(bought)).toBeNull();
  });

  it("3. an insufficient treasury with insufficient cash is a shortfall the president must raise; the purchase is refused until it is", () => {
    const state = base(); // treasury 30, cash 20, price 80 -> shortfall 30
    const owed = funding(state)!;
    expect(owed).toMatchObject({ shortfall: 30, canPurchase: false, bankrupt: false });
    // C&O's own shares are sellable too, down to the crown (6.6.3 forbids only a change of presidency).
    expect(owed.legalSales.map((sale) => sale.ticker)).toEqual(["C&O", "NYC", "PRR"]);
    expect(emergencyPurchaseRefusal(state, CO, CORRIDOR, P1)).toContain("$30 short");
    expect(same(apply(state, EMERGENCY(CO), P1), state)).toBe(true);
    expect(allMoney(apply(state, EMERGENCY(CO), P1))).toBe(allMoney(state));
  });
});

/* ------------------------------------------------------------------ */
/* 4-10: the forced sale                                                  */
/* ------------------------------------------------------------------ */

describe("the forced sale (#1540, tests 4-10)", () => {
  it("4-5. the president sells a legal certificate and receives its real proceeds; the share enters the pool", () => {
    const state = base(); // shortfall 30; PRR at $50, NYC at $100
    const sold = apply(state, SELL(PRR, 10), P1);
    expect(same(sold, state)).toBe(false);
    expect(cash(sold, P1)).toBe(70);
    expect(held(sold, PRR, P1)).toBe(0);
    expect(company(sold, PRR).bank_pool_percentage).toBe(10);
    expect(bank(sold)).toBe(bank(state) - 50);
    expect(allMoney(sold)).toBe(allMoney(state));
    // Still owed: $30 was needed, $50 came in, the purchase can now be made.
    expect(funding(sold)).toMatchObject({ shortfall: 0, canPurchase: true });
    const bought = apply(sold, EMERGENCY(CO), P1);
    expect(company(bought, CO).owned_trains).toEqual(["2"]);
    expect(cash(bought, P1)).toBe(20); // 70 - the $50 difference
    expect(funding(bought)).toBeNull();
  });

  it("6. the final certificate may overshoot the shortfall, and its proceeds are not truncated", () => {
    const state = base({ cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, prrHoldings: [[P3, 40], [P1, 0]] }); // shortfall 50; only NYC at $100
    expect(funding(state)?.shortfall).toBe(50);
    const sold = apply(state, SELL(NYC, 10), P1);
    expect(cash(sold, P1)).toBe(100); // $100 for a $50 shortfall: the whole certificate, kept
    expect(funding(sold)).toMatchObject({ shortfall: 0, canPurchase: true });
    const bought = apply(sold, EMERGENCY(CO), P1);
    expect(cash(bought, P1)).toBe(50);
    expect(allMoney(bought)).toBe(allMoney(state));
  });

  it("6b. only enough: a bundle one certificate larger than needed is refused; the exact bundle passes", () => {
    const state = base({ cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, nycHoldings: [[P2, 30], [P1, 30]], prrHoldings: [[P3, 40], [P1, 0]] }); // shortfall 50, NYC $100
    expect(forcedSaleRefusal(state, funding(state)!, P1, NYC, 20)).toContain("Only enough may be sold");
    expect(same(apply(state, SELL(NYC, 20), P1), state)).toBe(true);
    expect(forcedSaleRefusal(state, funding(state)!, P1, NYC, 10)).toBeNull();
    // A shortfall of $150 at $100 needs two certificates: 20% passes, 30% is refused.
    const bigger = base({ treasury: "0", cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, nycHoldings: [[P2, 30], [P1, 30]], prrHoldings: [[P3, 40], [P1, 0]] });
    // 2-train is $80: make the train dearer by owning 2s elsewhere? Simpler: the shortfall is $80 here -> one $100 certificate is enough.
    expect(funding(bigger)?.shortfall).toBe(80);
    expect(forcedSaleRefusal(bigger, funding(bigger)!, P1, NYC, 20)).toContain("Only enough");
    expect(legalForcedSales(bigger, funding(bigger)!).find((sale) => sale.companyId === NYC)?.bundles).toEqual([10]);
  });

  it("7. once treasury and cash cover the price no further sale is allowed -- the purchase must be made", () => {
    const state = base({ cash: { [P1]: 100, [P2]: 300, [P3]: 300 } }); // shortfall 0
    const owed = funding(state)!;
    expect(owed.canPurchase).toBe(true);
    expect(forcedSaleRefusal(state, owed, P1, PRR, 10)).toContain("no further sale is allowed");
    expect(same(apply(state, SELL(PRR, 10), P1), state)).toBe(true);
    /* Batch 7.2 (#1570): the owner may still SEND it -- the seat and owner rules are unchanged -- but ingress
       now answers with the reason instead of leaving the reducer's silent no-op to be the whole reply
       (S10-1 / U-29). `stockSaleRefusal` asks `forcedSaleRefusal` last and unchanged, so the sentence the
       submitter hears is the one the reducer refuses by. */
    expect(turnRefusal({ state, waterfall: null, actor: P1, msg: SELL(PRR, 10), mapGrid: CORRIDOR })).toContain(
      "no further sale is allowed",
    );
    // Negative control: the ordinary sale rule is untouched outside the obligation.
    const ordinary = { ...state, current_round_type: "StockRound" as const, operating_sub_phase: undefined };
    expect(same(apply(ordinary, SELL(PRR, 10), P1), ordinary)).toBe(false);
  });

  it("8. a forced sale moves the market price normally, through the same engine a Stock Round sale uses", () => {
    /* The chart's own projection, exactly as `RoomEngine.apply` hands it to the reducer (#1197); the engine
       itself seeds `market_positions` from the providers, which would discard this fixture's prices. */
    const providers = sandboxReplayProviders();
    const state = base();
    const after = applySandboxAction(state, SELL(NYC, 10), {
      actor: P1,
      mapGrid: CORRIDOR,
      ...providers.chartInjections(state),
      marketContext: providers.marketContext(state, SELL(NYC, 10), P1),
      parCellFor: providers.parCellFor,
    });
    expect(cash(after, P1)).toBe(120);
    const before = base().market_positions![NYC]!;
    const moved = after.market_positions![NYC]!;
    expect(moved.price).toBeLessThan(before.price);
    expect(moved.y).toBe(before.y - 1); // one row down per certificate sold
  });

  it("9. selling another corporation's shares changes its presidency normally and immediately", () => {
    // Shortfall $150 at $100 per share: two certificates are "only enough". P1 30% -> 10%, P2 holds 20%: the crown moves.
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 60], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P1, trains: [], treasury: "500", holdings: [[P1, 30], [P2, 20]], price: 100, x: 8 },
        // Six 2-trains printed: all out (PRR four, B&O two) so the required train is the 3 at $180.
        { id: PRR, ticker: "PRR", president: P3, trains: ["2", "2", "2", "2"], treasury: "500", holdings: [[P3, 60]], price: 50, x: 3 },
        { id: 4, ticker: "B&O", president: P3, trains: ["2", "2"], treasury: "500", holdings: [[P3, 60]], price: 50, x: 2 },
      ],
      cash: { [P1]: 30, [P2]: 300, [P3]: 300 },
    });
    expect(funding(state)).toMatchObject({ shortfall: 150, train: { tier: "3", cost: 180 } });
    expect(forcedSaleRefusal(state, funding(state)!, P1, NYC, 20)).toBeNull();
    const sold = apply(state, SELL(NYC, 20), P1);
    expect(company(sold, NYC).president).toBe(P2);
    expect(held(sold, NYC, P1)).toBe(10);
    expect(cash(sold, P1)).toBe(230);
    expect(funding(sold)).toMatchObject({ shortfall: 0, canPurchase: true });
  });

  it("10. a sale that would change the rescued corporation's presidency is refused; one that would not is allowed", () => {
    // C&O: P1 60%, P2 20%. Selling 40% or more of C&O would drop P1 to 20% or less... 30% -> 30 vs 20 keeps it.
    const state = base({ cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, nycHoldings: [[P2, 30], [P1, 0]], prrHoldings: [[P3, 40], [P1, 0]] }); // shortfall 50; only C&O shares to sell, $90
    const owed = funding(state)!;
    expect(owed.shortfall).toBe(50);
    // One certificate of C&O covers it and leaves P1 at 50% over P2's 20%: allowed (the old plan forbade this outright).
    expect(forcedSaleRefusal(state, owed, P1, CO, 10)).toBeNull();
    expect(owed.legalSales.map((sale) => [sale.ticker, sale.bundles])).toEqual([["C&O", [10]]]);
    // A crafted 50% sale would hand the crown to P2 -- refused for that reason, ahead of "only enough".
    const flipping = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 30], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30]], price: 100, x: 8 },
        { id: PRR, ticker: "PRR", president: P3, trains: ["2", "2", "2", "2"], treasury: "500", holdings: [[P3, 60]], price: 50, x: 3 },
        { id: 4, ticker: "B&O", president: P3, trains: ["2", "2"], treasury: "500", holdings: [[P3, 60]], price: 50, x: 2 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    }); // required: the 3 at $180; shortfall 180
    const owedFlip = funding(flipping)!;
    expect(owedFlip.shortfall).toBe(180);
    expect(forcedSaleRefusal(flipping, owedFlip, P1, CO, 20)).toContain("would hand its presidency");
    expect(same(apply(flipping, SELL(CO, 20), P1), flipping)).toBe(true);
    // 10% keeps P1 at 20% = P2's 20%: strictly-more rule, no change -> allowed, though it cannot cover $180.
    expect(forcedSaleRefusal(flipping, owedFlip, P1, CO, 10)).toBeNull();
    const sold = apply(flipping, SELL(CO, 10), P1);
    expect(company(sold, CO).president).toBe(P1);
    expect(cash(sold, P1)).toBe(90);
  });
});

/* ------------------------------------------------------------------ */
/* 11-15: authority, the hold, the required train, privates              */
/* ------------------------------------------------------------------ */

describe("authority and the hold (#1540, tests 11-15)", () => {
  const state = base(); // shortfall 30

  it("11. a non-president cannot resolve another player's emergency funding", () => {
    for (const actor of [P2, P3]) {
      expect(same(apply(state, SELL(NYC, 10), actor), state)).toBe(true);
      expect(same(apply(state, EMERGENCY(CO), actor), state)).toBe(true);
      expect(turnRefusal({ state, waterfall: null, actor, msg: SELL(NYC, 10), mapGrid: CORRIDOR })).toContain("Only C&O's president");
      expect(turnRefusal({ state, waterfall: null, actor, msg: EMERGENCY(CO), mapGrid: CORRIDOR })).toContain("Only C&O's president");
    }
    expect(turnRefusal({ state, waterfall: null, actor: P1, msg: SELL(NYC, 10), mapGrid: CORRIDOR })).toBeNull();
  });

  it("12-13. ordinary actions -- hand-crafted or not -- cannot bypass the obligation, at the reducer and at the ingress", () => {
    const blocked: Array<[string, never, string]> = [
      ["PassTurn", PASS, P1],
      ["AdvanceOperatingSubPhase", ADVANCE(CO), P1],
      ["a depot purchase it cannot afford", BUY(CO), P1],
      ["a purchase by another corporation", BUY(NYC), P2],
      ["a tile lay", { LayTile: { game_id: 1, protocol_id: CO, q: H16.q, r: H16.r, tile_id: 57, orientation: 0 } } as never, P1],
      ["a stock purchase", { BuyStock: { game_id: 1, protocol_id: PRR, source: "Ipo" } } as never, P1],
      ["a Stock Round opening", { OpenStockRound: {} } as never, P1],
      ["a dividend", { DeclareDividends: { game_id: 1, protocol_id: CO, revenue_amount: "0", mode: "Payout" } } as never, P1],
      ["a private purchase by the corporation", { ProposePrivatePurchase: { game_id: 1, protocol_id: CO, private_id: 1, price: "20" } } as never, P1],
    ];
    for (const [label, msg, actor] of blocked) {
      expect([label, same(apply(state, msg, actor), state)]).toEqual([label, true]);
      expect([label, emergencyFundingBlock(state, msg, CORRIDOR)]).toEqual([label, expect.stringContaining("must fund the purchase before anything else happens")]);
      expect([label, turnRefusal({ state, waterfall: null, actor, msg, mapGrid: CORRIDOR })]).toEqual([label, expect.stringContaining("must fund the purchase")]);
    }
    // The resolving family passes the hold (their own rules still apply).
    for (const msg of [SELL(NYC, 10), EMERGENCY(CO), CLOSE, { RevertTo: { index: 0, player: P1, summary: "x" } } as never]) {
      expect(emergencyFundingBlock(state, msg, CORRIDOR)).toBeNull();
    }
    // Without a grid the hold has no opinion (#757) -- the fixture case, not a bypass a client can reach.
    expect(emergencyFundingBlock(state, PASS, undefined)).toBeNull();
  });

  it("14. the required train is the authority's, and cannot be substituted through a crafted payload", () => {
    // A pooled 2 beside the depot's 2: the required train is the pool copy (Batch 4's tie-break), whatever the client says.
    const pooled = { ...base({ cash: { [P1]: 100, [P2]: 300, [P3]: 300 } }), returned_trains: ["2"] };
    expect(funding(pooled)?.train).toEqual({ source: "pool", tier: "2", cost: 80, remaining: 1 });
    const bought = apply(pooled, EMERGENCY(CO), P1);
    expect(bought.returned_trains).toEqual([]);
    expect(company(bought, CO).owned_trains).toEqual(["2"]);
    // A crafted ordinary purchase naming a dearer tier is held; the emergency message carries no train at all.
    const dear = base({ cash: { [P1]: 1000, [P2]: 300, [P3]: 300 } });
    expect(same(apply(dear, BUY_MODEL(CO, "3"), P1), dear)).toBe(true);
    expect(same(apply(dear, BUY_MODEL(CO, "D"), P1), dear)).toBe(true);
    // The message names no train; a crafted `model_type` is not in its schema and changes nothing.
    expect(validateGameplayMessage({ EmergencyBuyHardware: { protocol_id: CO } }).ok).toBe(true);
    const forged = apply(dear, { EmergencyBuyHardware: { game_id: 1, protocol_id: CO, model_type: "D" } } as never, P1);
    expect(company(forged, CO).owned_trains).toEqual(["2"]);
    const forced = apply(dear, EMERGENCY(CO), P1);
    expect(company(forced, CO).owned_trains).toEqual(["2"]);
    expect(cash(forced, P1)).toBe(950);
  });

  it("15. outside phases 3-4 a private company is no funding path (3.0): nothing is liquidated, and bankruptcy ignores it", () => {
    /* Phase 2 here (nobody owns a 3), so no corporation may buy a private and none can be offered; the private
       stays the president's and the shares being exhausted is bankruptcy outright. The phase-3 sale is proven in
       the #1541 block below. The ordinary corporation-initiated proposal is held like any other message. */
    const withPrivate = base({ cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, nycHoldings: [[P2, 30], [P1, 0]], prrHoldings: [[P3, 40], [P1, 0]], coHoldings: [[P1, 20], [P2, 20]], privates: [{ private_id: 1, owner: P1, cost: "250" }] });
    const owed = funding(withPrivate)!;
    expect(owed.shortfall).toBe(50);
    expect(owed.legalSales).toEqual([]); // the president's block cannot be sold; nothing else is held
    expect(owed.legalPrivateSales).toEqual([]);
    expect(owed.bankrupt).toBe(true);
    expect(emergencyFundingBlock(withPrivate, { ProposePrivatePurchase: { game_id: 1, protocol_id: CO, private_id: 1, price: "250" } } as never, CORRIDOR)).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 16-19: bankruptcy                                                    */
/* ------------------------------------------------------------------ */

describe("bankruptcy (#1540, tests 16-19)", () => {
  it("16. cannot occur while a legal forced sale remains, however far short the president is", () => {
    const state = base({ treasury: "0", cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, nycHoldings: [[P2, 30], [P1, 0]] }); // shortfall 80; PRR 10% at $50 is all P1 can sell
    const owed = funding(state)!;
    expect(owed.shortfall).toBe(80);
    expect(owed.legalSales.map((sale) => sale.ticker)).toEqual(["C&O", "PRR"]);
    expect(owed.bankrupt).toBe(false);
    expect(state.current_round_type).toBe("OperatingRound");
    // A sale that cannot cover the shortfall is still the president's only legal move, and is made.
    const sold = apply(state, SELL(PRR, 10), P1);
    expect(cash(sold, P1)).toBe(50);
    expect(sold.current_round_type).toBe("OperatingRound");
    expect(funding(sold)?.bankrupt).toBe(false);
  });

  it("17-18. occurs when every legal sale is exhausted and the train is still unaffordable, and ends the game at once", () => {
    const state = base({ treasury: "0", cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, nycHoldings: [[P2, 30], [P1, 0]] });
    const sold = apply(state, SELL(PRR, 10), P1); // $50 raised against $80; nothing else to sell (C&O's 60%? -> see below)
    /* C&O is P1's at 60% over P2's 20%: 10% of C&O at $90 IS a legal forced sale (it keeps the crown), so the
       president is not bankrupt yet -- the machine reaches bankruptcy only when the last legal sale is gone. */
    expect(funding(sold)?.legalSales.map((sale) => sale.ticker)).toEqual(["C&O"]);
    expect(sold.current_round_type).toBe("OperatingRound");
    const soldCo = apply(sold, SELL(CO, 10), P1); // +$90 -> $140 >= $80: funded, not bankrupt
    expect(funding(soldCo)).toMatchObject({ shortfall: 0, canPurchase: true });

    // The genuinely exhausted board: P1 holds only C&O's president block and nothing sellable.
    const exhausted = base({ treasury: "0", cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, coHoldings: [[P1, 20], [P2, 20]], nycHoldings: [[P2, 30], [P1, 0]], prrHoldings: [[P3, 40], [P1, 10]] });
    expect(funding(exhausted)?.legalSales.map((sale) => sale.ticker)).toEqual(["PRR"]);
    const lastSale = apply(exhausted, SELL(PRR, 10), P1); // $50 against $80, and now nothing is left
    expect(lastSale.current_round_type).toBe("GameEnd");
    expect(lastSale.bankrupt_president).toBe(P1);
    expect(cash(lastSale, P1)).toBe(50);
    expect(company(lastSale, CO).owned_trains).toEqual([]); // no train was delivered
    expect(allMoney(lastSale)).toBe(allMoney(exhausted));
    // Immediate: not at the next Stock Round, not at the end of the OR. And final: nothing further applies.
    for (const [label, msg, actor] of [["PassTurn", PASS, P1], ["a purchase", BUY(NYC), P2], ["a sale", SELL(NYC, 10), P2]] as Array<[string, never, string]>) {
      expect([label, same(apply(lastSale, msg, actor), lastSale)]).toEqual([label, true]);
      expect([label, turnRefusal({ state: lastSale, waterfall: null, actor, msg, mapGrid: CORRIDOR })]).toEqual([label, expect.stringContaining("The game has ended")]);
    }
    expect(emergencyFundingBlock(lastSale, CLOSE, CORRIDOR)).toBeNull();
    // Reached in the same transition as the action that made it unavoidable: entering Buy Trains with nothing to sell.
    const atDividends = { ...base({ treasury: "0", cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, coHoldings: [[P1, 20], [P2, 20]], nycHoldings: [[P2, 30], [P1, 0]], prrHoldings: [[P3, 40], [P1, 0]] }), operating_sub_phase: "Dividends" as const };
    const entered = apply(atDividends, ADVANCE(CO), P1);
    expect(entered.current_round_type).toBe("GameEnd");
    expect(entered.bankrupt_president).toBe(P1);
  });

  it("19. the bankrupt player is scored by the shares he could not sell, ranked with everybody, and can win", () => {
    const ended = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 60], [P2, 20]], price: 300 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30]], price: 100, x: 8 },
      ],
      cash: { [P1]: 40, [P2]: 700, [P3]: 900 },
    });
    const standings = rankPlayers({
      state: { ...ended, current_round_type: "GameEnd", bankrupt_president: P1 },
      priceForCompany: (id) => ended.market_positions?.[id]?.price ?? null,
      labelForAddress: (address) => address,
      bankruptAddress: P1,
    });
    const p1 = standings.find((row) => row.address === P1)!;
    expect(p1.isBankrupt).toBe(true);
    expect(p1.netWorth).toBe(1800); // six C&O shares at $300; the $40 of cash is not counted (6.6.3)
    expect(p1.cash).toBe(0);
    expect(p1.rank).toBe(1);
    expect(p1.isWinner).toBe(true);
    expect(standings.find((row) => row.address === P3)?.netWorth).toBe(900);
    expect(standings.filter((row) => row.isWinner)).toHaveLength(1);
    // Negative control: with less paper he ranks below and does not win; nobody is excluded, nobody is zeroed.
    const poorer = rankPlayers({
      state: { ...ended, current_round_type: "GameEnd", bankrupt_president: P1 },
      priceForCompany: (id) => (id === CO ? 100 : 100),
      labelForAddress: (address) => address,
      bankruptAddress: P1,
    });
    expect(poorer.find((row) => row.address === P1)).toMatchObject({ netWorth: 600, isWinner: false, rank: 3 });
    expect(poorer.find((row) => row.isWinner)?.address).toBe(P2);
  });
});

/* ------------------------------------------------------------------ */
/* The emergency private sale (#1541) and the declaration              */
/* ------------------------------------------------------------------ */

describe("the emergency private sale (#1541, rulebook 6.6.3 / 3.0 / 3.1)", () => {
  const OFFER = (privateId: number, buyer: number, price: number) =>
    ({ OfferPrivateForFunding: { game_id: 1, private_id: privateId, buyer_protocol_id: buyer, price } }) as never;
  const ANSWER = (privateId: number, accept: boolean) => ({ AnswerFundingPrivateOffer: { game_id: 1, private_id: privateId, accept } }) as never;
  const RESCIND = (privateId: number) => ({ RescindFundingPrivateOffer: { game_id: 1, private_id: privateId } }) as never;
  const DECLARE = { DeclareBankruptcy: { game_id: 1 } } as never;
  const CA = 2; // a private P1 owns, face $160: legal price $80-$320

  /** Phase 3 (NYC owns a 3-train, so the depot's head -- the required train -- is the 3 at $180). P1 holds only
   *  C&O's president block -- no share sale is legal -- and cash $0 against treasury $0: shortfall $180. */
  function phaseThree(over: Partial<{ cash: number; treasury: string; privates: Array<{ private_id: number; owner: string; cost: string }>; nycTrains: string[] }> = {}) {
    return board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: over.treasury ?? "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: over.nycTrains ?? ["3"], treasury: "500", holdings: [[P2, 30]], price: 100, x: 8, y: 8 },
        { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "100", holdings: [[P3, 40]], price: 50, x: 3 },
      ],
      cash: { [P1]: over.cash ?? 0, [P2]: 300, [P3]: 300 },
      privates: over.privates ?? [{ private_id: CA, owner: P1, cost: "160" }],
    });
  }

  it("lists the privates the president may offer, their band, and every corporation that could buy -- never the rescued one", () => {
    const state = phaseThree();
    const owed = funding(state)!;
    expect(owed).toMatchObject({ shortfall: 180, legalSales: [], bankrupt: false, canDeclareBankruptcy: true });
    expect(owed.legalPrivateSales).toEqual([
      { privateId: CA, name: "Private 2", faceValue: 160, minPrice: 80, maxPrice: 320, buyers: [
        { companyId: NYC, ticker: "NYC", president: P2, treasury: 500 },
        { companyId: PRR, ticker: "PRR", president: P3, treasury: 100 },
      ] },
    ]);
    // Phase 2 (nobody owns a 3): corporations may not buy privates (3.0), so nothing can be offered and the
    // shares being exhausted is bankruptcy outright.
    const phaseTwo = phaseThree({ nycTrains: [] });
    expect(funding(phaseTwo)?.legalPrivateSales).toEqual([]);
    expect(funding(phaseTwo)?.bankrupt).toBe(true);
    // Phase 5 (a 5 is owned): the privates have closed (6.6.1/#736 closes them; here the phase alone excludes).
    const phaseFive = phaseThree({ nycTrains: ["5"] });
    expect(funding(phaseFive)?.legalPrivateSales).toEqual([]);
  });

  it("the offer stands, freezes everything else, and is answered by the buying corporation's president", () => {
    const state = phaseThree();
    const offered = apply(state, OFFER(CA, NYC, 200), P1);
    expect(offered.private_purchase_offer).toMatchObject({ private_id: CA, owner: P1, buyer_protocol_id: NYC, buyer_ticker: "NYC", price: 200, funding: true });
    expect(funding(offered)?.privateOffer).not.toBeNull();
    // Frozen: sales, the purchase, the turn, another offer, the declaration -- all held, with the reason.
    for (const [label, msg, actor] of [["a share sale", SELL(CO, 10), P1], ["the purchase", EMERGENCY(CO), P1], ["PassTurn", PASS, P1], ["a second offer", OFFER(CA, PRR, 100), P1], ["the declaration", DECLARE, P1]] as Array<[string, never, string]>) {
      expect([label, same(apply(offered, msg, actor), offered)]).toEqual([label, true]);
      expect([label, turnRefusal({ state: offered, waterfall: null, actor, msg, mapGrid: CORRIDOR })]).toEqual([label, expect.stringContaining("nothing else can happen until")]);
    }
    // The seller cannot answer their own offer, by either message; NYC's president can.
    expect(same(apply(offered, ANSWER(CA, true), P1), offered)).toBe(true);
    expect(turnRefusal({ state: offered, waterfall: null, actor: P1, msg: ANSWER(CA, true), mapGrid: CORRIDOR })).toContain("Only NYC's president");
    expect(same(apply(offered, { AnswerPrivatePurchase: { game_id: 1, private_id: CA, accept: true } } as never, P1), offered)).toBe(true);
    expect(turnRefusal({ state: offered, waterfall: null, actor: P3, msg: ANSWER(CA, true), mapGrid: CORRIDOR })).toContain("Only NYC's president");
    expect(turnRefusal({ state: offered, waterfall: null, actor: P2, msg: ANSWER(CA, true), mapGrid: CORRIDOR })).toBeNull();

    // Accepted: $200 treasury -> P1, the private is NYC's for good, the $180 shortfall is gone, the purchase follows.
    const accepted = apply(offered, ANSWER(CA, true), P2);
    expect(accepted.private_purchase_offer).toBeNull();
    expect(cash(accepted, P1)).toBe(200);
    expect(Number(company(accepted, NYC).treasury)).toBe(300);
    expect(accepted.private_companies.find((priv) => priv.private_id === CA)).toMatchObject({ owner: null, owner_protocol_id: NYC });
    expect(allMoney(accepted)).toBe(allMoney(state));
    expect(funding(accepted)).toMatchObject({ shortfall: 0, canPurchase: true });
    const bought = apply(accepted, EMERGENCY(CO), P1);
    expect(company(bought, CO).owned_trains).toEqual(["3"]);
    expect(cash(bought, P1)).toBe(20); // $200 raised, $180 paid: the overshoot is the president's
    expect(funding(bought)).toBeNull();
  });

  it("a rejection or a withdrawal returns to the obligation with nothing moved", () => {
    const state = phaseThree();
    const offered = apply(state, OFFER(CA, NYC, 200), P1);
    const rejected = apply(offered, ANSWER(CA, false), P2);
    expect(rejected.private_purchase_offer).toBeNull();
    expect(cash(rejected, P1)).toBe(0);
    expect(rejected.private_companies[0].owner).toBe(P1);
    expect(funding(rejected)).toMatchObject({ shortfall: 180, canDeclareBankruptcy: true, bankrupt: false });
    const withdrawn = apply(offered, RESCIND(CA), P1);
    expect(withdrawn.private_purchase_offer).toBeNull();
    expect(cash(withdrawn, P1)).toBe(0);
    expect(withdrawn.private_companies[0].owner).toBe(P1);
    expect(funding(withdrawn)).toMatchObject({ shortfall: 180, privateOffer: null });
    // Only the seller withdraws.
    expect(same(apply(offered, RESCIND(CA), P2), offered)).toBe(true);
    expect(turnRefusal({ state: offered, waterfall: null, actor: P2, msg: RESCIND(CA), mapGrid: CORRIDOR })).toContain("Only the seller");
    // The president may then try another buyer at another price.
    const again = apply(rejected, OFFER(CA, PRR, 100), P1);
    expect(again.private_purchase_offer).toMatchObject({ buyer_protocol_id: PRR, price: 100 });
  });

  it("refuses an offer outside 3.0/3.1 or by the wrong hands: price band, the rescued corporation, an unaffordable buyer, a non-owner, no shortfall", () => {
    const state = phaseThree();
    const owed = funding(state)!;
    expect(fundingPrivateOfferRefusal(state, owed, { private_id: CA, buyer_protocol_id: NYC, price: 79 }, P1)).toContain("between $80 and $320");
    expect(fundingPrivateOfferRefusal(state, owed, { private_id: CA, buyer_protocol_id: NYC, price: 321 }, P1)).toContain("between $80 and $320");
    expect(fundingPrivateOfferRefusal(state, owed, { private_id: CA, buyer_protocol_id: CO, price: 100 }, P1)).toContain("put aside for the train");
    expect(fundingPrivateOfferRefusal(state, owed, { private_id: CA, buyer_protocol_id: PRR, price: 150 }, P1)).toContain("cannot pay $150");
    expect(fundingPrivateOfferRefusal(state, owed, { private_id: CA, buyer_protocol_id: NYC, price: 100 }, P2)).toContain("Only C&O's president");
    expect(fundingPrivateOfferRefusal(state, owed, { private_id: 9, buyer_protocol_id: NYC, price: 100 }, P1)).toContain("not a private company you own");
    for (const msg of [OFFER(CA, NYC, 79), OFFER(CA, CO, 100), OFFER(CA, PRR, 150), OFFER(9, NYC, 100)]) {
      expect(same(apply(state, msg, P1), state)).toBe(true);
    }
    expect(same(apply(state, OFFER(CA, NYC, 100), P2), state)).toBe(true);
    // With the purchase already funded no sale of any kind is allowed.
    const funded = phaseThree({ cash: 200 });
    expect(funding(funded)?.canPurchase).toBe(true);
    expect(fundingPrivateOfferRefusal(funded, funding(funded)!, { private_id: CA, buyer_protocol_id: NYC, price: 100 }, P1)).toContain("no sale is needed");
    expect(same(apply(funded, OFFER(CA, NYC, 100), P1), funded)).toBe(true);
    // A corporation never resells: once NYC owns it, nobody can offer it (the owner is a corporation).
    const sold = apply(apply(state, OFFER(CA, NYC, 200), P1), ANSWER(CA, true), P2);
    expect(funding(sold)).toMatchObject({ shortfall: 0 });
    const poorAgain = { ...sold, player_cash: sold.player_cash.map((entry) => (entry.player === P1 ? { ...entry, cash_vgp: "0" } : entry)) };
    expect(funding(poorAgain)?.legalPrivateSales).toEqual([]);
  });

  it("an acceptance is re-validated in full at settlement: the proposal reserves no legality", () => {
    /* The freeze makes these changes impossible in play; the authority does not rely on that. Each board is
       the offered board with one fact changed underneath the offer, and each acceptance is refused by the
       reducer (digest) with a reason -- and moves no money. */
    const state = phaseThree();
    const offered = apply(state, OFFER(CA, NYC, 200), P1);
    const withCompanies = (edit: (entry: GameStateResponse["public_companies"][number]) => GameStateResponse["public_companies"][number]) => ({
      ...offered,
      public_companies: offered.public_companies.map((entry) => edit(entry)),
    });
    const cases: Array<[string, GameStateResponse, string, string]> = [
      ["the private no longer the president's", { ...offered, private_companies: offered.private_companies.map((priv) => ({ ...priv, owner: P3 })) }, P2, "not a private company you own"],
      ["the private already a corporation's", { ...offered, private_companies: offered.private_companies.map((priv) => ({ ...priv, owner: null, owner_protocol_id: PRR })) }, P2, "not a private company you own"],
      ["the private closed", { ...offered, private_companies: offered.private_companies.map((priv) => ({ ...priv, closed: true })) }, P2, "has closed"],
      ["the buyer's presidency changed hands (the old president answers)", withCompanies((entry) => (entry.company_id === NYC ? { ...entry, president: P3 } : entry)), P2, "Only NYC's president"],
      ["the buyer's treasury drained", withCompanies((entry) => (entry.company_id === NYC ? { ...entry, treasury: "150" } : entry)), P2, "cannot pay $200"],
      ["the phase moved on to 5", withCompanies((entry) => (entry.company_id === NYC ? { ...entry, owned_trains: ["5"] } : entry)), P2, "only during phases 3 and 4"],
      ["the price fallen outside the band", { ...offered, private_companies: offered.private_companies.map((priv) => ({ ...priv, cost: "60" })) }, P2, "between $30 and $120"],
      ["the obligation gone (the corporation has a train)", withCompanies((entry) => (entry.company_id === CO ? { ...entry, owned_trains: ["3"] } : entry)), P2, "No forced train purchase is owed any more"],
      ["the shortfall gone (the president came into money)", { ...offered, player_cash: offered.player_cash.map((entry) => (entry.player === P1 ? { ...entry, cash_vgp: "500" } : entry)) }, P2, "no sale is needed"],
      ["the buyer swapped for the rescued corporation", { ...offered, private_purchase_offer: { ...offered.private_purchase_offer!, buyer_protocol_id: CO, buyer_ticker: "C&O" } }, P1, "put aside for the train"],
      ["the offer re-pointed at the B&O private", { ...offered, private_companies: [...offered.private_companies, { private_id: 6, name: "B&O private", cost: "220", revenue_per_or: "30", owner: P1, owner_protocol_id: null, closed: false }], private_purchase_offer: { ...offered.private_purchase_offer!, private_id: 6, private_name: "B&O private" } }, P2, "may never be sold to a corporation"],
    ];
    for (const [label, board_, actor, reason] of cases) {
      const answered = apply(board_, ANSWER(board_.private_purchase_offer!.private_id, true), actor);
      expect([label, same(answered, board_)]).toEqual([label, true]);
      expect([label, allMoney(answered)]).toEqual([label, allMoney(board_)]);
      expect([label, fundingPrivateAnswerRefusal(board_, { private_id: board_.private_purchase_offer!.private_id, accept: true }, actor, CORRIDOR)]).toEqual([label, expect.stringContaining(reason)]);
    }
    // Fail closed: with no board to judge the obligation on, an acceptance is refused; a rejection is not.
    expect(fundingPrivateAnswerRefusal(offered, { private_id: CA, accept: true }, P2, undefined)).toContain("cannot be settled without the board");
    expect(fundingPrivateAnswerRefusal(offered, { private_id: CA, accept: false }, P2, undefined)).toBeNull();
    expect(same(applySandboxAction(offered, ANSWER(CA, true), { actor: P2 }), offered)).toBe(true);
    // Control: the unchanged offered board settles.
    expect(fundingPrivateAnswerRefusal(offered, { private_id: CA, accept: true }, P2, CORRIDOR)).toBeNull();
    expect(cash(apply(offered, ANSWER(CA, true), P2), P1)).toBe(200);
  });

  it("bankruptcy is derived only when no private could be offered; otherwise it is declared -- never prematurely", () => {
    // Shares exhausted, a private offerable: the game goes on; the president may declare or offer.
    const state = phaseThree();
    expect(state.current_round_type).toBe("OperatingRound");
    const owed = funding(state)!;
    expect(owed.bankrupt).toBe(false);
    expect(owed.canDeclareBankruptcy).toBe(true);
    expect(declareBankruptcyRefusal(owed, P1)).toBeNull();
    expect(declareBankruptcyRefusal(owed, P2)).toContain("Only C&O's president");
    expect(same(apply(state, DECLARE, P2), state)).toBe(true);
    const declared = apply(state, DECLARE, P1);
    expect(declared.current_round_type).toBe("GameEnd");
    expect(declared.bankrupt_president).toBe(P1);
    expect(declared.private_companies[0].owner).toBe(P1); // never liquidated
    // Premature declarations are refused: a share sale remains; the purchase is funded; an offer is outstanding.
    const withShares = base({ treasury: "0", cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, nycHoldings: [[P2, 30], [P1, 0]] });
    expect(declareBankruptcyRefusal(funding(withShares)!, P1)).toContain("A share sale is still possible");
    expect(same(apply(withShares, DECLARE, P1), withShares)).toBe(true);
    expect(turnRefusal({ state: withShares, waterfall: null, actor: P1, msg: DECLARE, mapGrid: CORRIDOR })).toContain("share sale is still possible");
    const funded = phaseThree({ cash: 200 });
    expect(declareBankruptcyRefusal(funding(funded)!, P1)).toContain("the purchase must be made");
    const offered = apply(state, OFFER(CA, NYC, 200), P1);
    expect(same(apply(offered, DECLARE, P1), offered)).toBe(true);
    // No obligation at all: nothing to declare.
    expect(same(apply(base({ treasury: "200" }), DECLARE, P1), base({ treasury: "200" }))).toBe(true);
    // Without a private (or a buyer), the same exhausted board ends by itself, as before.
    const noPrivate = phaseThree({ privates: [] });
    expect(funding(noPrivate)?.bankrupt).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Owner-defined simplification: the intercorporate trade under a forced obligation */
/* ------------------------------------------------------------------ */

describe("the intercorporate train purchase during a forced obligation (owner-defined simplification, #1541)", () => {
  const TRADE = (buyer: number, seller: number, model: string, price: string) =>
    ({ BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: buyer, seller_protocol_id: seller, model_type: model, price } }) as never;
  /** PRR holds two 3-trains (face $180) and could sell one; that makes the phase 3, so the required bank train
   *  is also a 3 at $180; C&O's treasury is $30. */
  const trade = (cash: number) =>
    board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "30", holdings: [[P1, 60], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 20]], price: 100, x: 8, y: 8 },
        { id: PRR, ticker: "PRR", president: P3, trains: ["3", "3"], treasury: "500", holdings: [[P3, 40]], price: 50, x: 3 },
      ],
      cash: { [P1]: cash, [P2]: 300, [P3]: 300 },
    });

  it("is permitted when treasury plus the president's cash covers the agreed price: treasury first, president the rest", () => {
    const state = trade(200);
    expect(funding(state)?.shortfall).toBe(0); // the bank's 3 is affordable with the president's cash
    expect(fundedTradeRefusal(state, funding(state)!, CO, 150, 180)).toBeNull();
    const done = apply(state, TRADE(CO, PRR, "3", "150"), P1);
    expect(company(done, CO).owned_trains).toEqual(["3"]);
    expect(company(done, PRR).owned_trains).toEqual(["3"]);
    expect(Number(company(done, CO).treasury)).toBe(0);
    expect(cash(done, P1)).toBe(80); // 200 - the $120 the treasury could not cover
    expect(Number(company(done, PRR).treasury)).toBe(650);
    expect(allMoney(done)).toBe(allMoney(state));
    expect(funding(done)).toBeNull();
    // A trade the treasury alone covers is the ordinary rule, face value or not.
    const rich = { ...state, public_companies: state.public_companies.map((entry) => (entry.company_id === CO ? { ...entry, treasury: "400" } : entry)) };
    expect(funding(rich)).toBeNull();
    expect(company(apply(rich, TRADE(CO, PRR, "3", "250"), P1), CO).owned_trains).toEqual(["3"]);
  });

  it("is refused when completing it would need a share or private sale, and the accepted offer is retired", () => {
    const state = trade(100); // $130 between them: $50 short of the bank's 3, $20 short of PRR's $150 offer
    expect(fundedTradeRefusal(state, funding(state)!, CO, 150, 180)).toContain("without selling shares or private companies");
    expect(same(apply(state, TRADE(CO, PRR, "3", "150"), P1), state)).toBe(true);
    const withOffer = {
      ...state,
      train_purchase_offer: { seller_protocol_id: PRR, seller_ticker: "PRR", seller_president: P3, buyer_protocol_id: CO, buyer_ticker: "C&O", model_type: "3", price: "150", accepted: true as const },
    } as unknown as GameStateResponse;
    const retired = apply(withOffer, TRADE(CO, PRR, "3", "150"), P1);
    expect(retired.train_purchase_offer).toBeNull();
    expect(company(retired, CO).owned_trains).toEqual([]);
    // The obligation still stands, and the bank's train -- after the forced sale the rules do allow -- is the way out.
    expect(funding(retired)).toMatchObject({ shortfall: 50, canPurchase: false });
    const sold = apply(retired, SELL(NYC, 10), P1); // P1's NYC share at $100 covers the $50
    expect(funding(sold)).toMatchObject({ shortfall: 0, canPurchase: true });
    expect(company(apply(sold, EMERGENCY(CO), P1), CO).owned_trains).toEqual(["3"]);
  });

  it("caps the price at face value whenever the president contributes (rulebook 6.6.2), and not otherwise", () => {
    const state = trade(400);
    expect(fundedTradeRefusal(state, funding(state)!, CO, 200, 180)).toContain("may not cost more than its $180 face value");
    expect(same(apply(state, TRADE(CO, PRR, "3", "200"), P1), state)).toBe(true);
    expect(fundedTradeRefusal(state, funding(state)!, CO, 180, 180)).toBeNull();
    // Another corporation's trade is not this obligation's business.
    expect(fundedTradeRefusal(state, funding(state)!, NYC, 999, 180)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 20-22: replay, RevertTo, the version                                  */
/* ------------------------------------------------------------------ */

describe("the log (#1540, tests 20-22)", () => {
  const seed = () => ({ state: base(), waterfall: null });
  const entry = (index: number, actor: string, msg: unknown) => ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg) });
  const REVERT = (index: number, player: string) => ({ RevertTo: { index, player, summary: "undo" } });

  it("20. a same-version emergency-funding log replays identically, through the engine and through a room", () => {
    const entries = [entry(0, P1, SELL(PRR, 10)), entry(1, P1, EMERGENCY(CO)), entry(2, P1, PASS)];
    const providers = corridorProviders();
    const once = replayLog(entries, providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    const twice = replayLog(entries, providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(once.applied).toBe(3);
    expect(stateDigest(once.state)).toBe(stateDigest(twice.state));
    expect(company(once.state, CO).owned_trains).toEqual(["2"]);
    expect(once.state.active_operating_order[once.state.active_corporation_index]).not.toBe(CO); // the turn ended

    const room = new RoomSession({ providers: corridorProviders(), seed: seed(), build: "b", mintId: () => `m${Math.random()}` });
    const submit = (actor: string, msg: never) => room.submit({ actor, build: "b", msg, baseIndex: room.nextIndex - 1 });
    const held = submit(P1, PASS);
    expect(held.kind).toBe("refused");
    expect((held as { reason: string }).reason).toContain("must fund the purchase");
    expect(submit(P2, SELL(NYC, 10)).kind).toBe("refused");
    expect(submit(P1, EMERGENCY(CO)).kind).toBe("refused"); // $30 short
    expect(submit(P1, SELL(PRR, 10)).kind).toBe("applied");
    expect(submit(P1, EMERGENCY(CO)).kind).toBe("applied");
    expect(company(room.state, CO).owned_trains).toEqual(["2"]);
    const restored = new RoomSession({ providers: corridorProviders(), seed: seed(), build: "b", mintId: () => "x" });
    restored.restore(room.entries as ServerLogEntry[]);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
  });

  it("21. RevertTo across a forced sale reconstructs the obligation exactly", () => {
    const providers = corridorProviders();
    const undone = replayLog([entry(0, P1, SELL(PRR, 10)), entry(1, P1, REVERT(0, P1))], providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(undone.applied).toBe(0);
    expect(funding(undone.state)).toMatchObject({ shortfall: 30, canPurchase: false });
    expect(held(undone.state, PRR, P1)).toBe(10);
    // And a bankruptcy is undone with the sale that made it unavoidable.
    const exhausted = base({ treasury: "0", cash: { [P1]: 0, [P2]: 300, [P3]: 300 }, coHoldings: [[P1, 20], [P2, 20]], nycHoldings: [[P2, 30], [P1, 0]], prrHoldings: [[P3, 40], [P1, 10]] });
    const bankruptcy = replayLog([entry(0, P1, SELL(PRR, 10))], providers, { state: exhausted, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(bankruptcy.state.current_round_type).toBe("GameEnd");
    const revived = replayLog([entry(0, P1, SELL(PRR, 10)), entry(1, P1, REVERT(0, P1))], providers, { state: exhausted, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(revived.state.current_round_type).toBe("OperatingRound");
    expect(revived.state.bankrupt_president).toBeUndefined();
  });

  it("22. RULES_ENGINE_VERSION is at least 3 and a version-2 room is refused before reducer replay", () => {
    /* Batch 6 bumped the pin to 4 (#1550); this case keeps asserting what Batch 5 introduced -- the version-3
       row and the refusal of a version-2 room -- against whatever the current pin is, as Batch 5 itself
       relaxed Batch 4.6's `2` to `>= 2`. */
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(3);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version).slice(0, 3)).toEqual([1, 2, 3]);
    expect(RULES_ENGINE_CHANGELOG[2].note).toMatch(/forced|bankrupt/);
    const seedOf = () => ({
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    });
    const fresh = new RoomSession({ providers: sandboxReplayProviders(), seed: seedOf(), build: "b", mintId: () => "d" });
    expect(fresh.submit({ actor: P1, build: "b", msg: { SetupGame: { players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }], variants: {}, build: "b" } } as never, baseIndex: -1 }).kind).toBe("applied");
    expect(fresh.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
    const versionTwo = fresh.entries.map((row) => {
      const parsed = JSON.parse(row.payload) as { SetupGame?: Record<string, unknown> };
      return parsed.SetupGame ? { ...row, payload: JSON.stringify({ ...parsed, SetupGame: { ...parsed.SetupGame, [RULES_ENGINE_VERSION_FIELD]: 2 } }) } : { ...row };
    });
    const applySpy = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const old = new RoomSession({ providers: sandboxReplayProviders(), seed: seedOf(), build: "b", mintId: () => "x" });
      old.restore(versionTwo as ServerLogEntry[]);
      expect(applySpy).not.toHaveBeenCalled();
      expect(old.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 2, supported: [RULES_ENGINE_VERSION] });
    } finally {
      applySpy.mockRestore();
    }
  });
});
