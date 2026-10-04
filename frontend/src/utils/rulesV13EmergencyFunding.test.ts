/** @jest-environment node */
// frontend/src/utils/rulesV13EmergencyFunding.test.ts
//
// ==================================================================
//  PHASE 3 W3-K (RULES ENGINE v13, OD-4): AUTOMATIC EMERGENCY TRAIN FUNDING
// ==================================================================
//
// The owner's final rulings (2026-10-03), one block per vector of the brief's list K (1-30), on rules-revision-2
// boards: the intercorporate window and `ForgoTrainTrade`; the automatic treasury + president's cash and the derived
// purchase; ONE atomic `EmergencySellPortfolio` (no sequential emergency sale, no self-created bankruptcy, "only
// enough" for the whole portfolio with the smallest legal overshoot allowed); optional private funding and
// `ForgoPrivateFunding`; the automatic bankruptcy, which still liquidates the president's shares as far as legally
// possible and hands his money to the obligated corporation; `DeclareBankruptcy` retired.
//
// Converted from the verification vectors V1-V8 (`docs/phase3/v13_evidence/od4AutomaticBankruptcy.test.ts.txt`,
// 9b3f60b) and revised for the final rulings (O-5: an insufficient portfolio is refused, not landed; O-6: bankruptcy
// liquidates rather than letting the president keep the shares).

export {};

const { applySandboxAction, projectEmergencySellPortfolio } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const {
  emergencyFundingFor,
  emergencyPortfolioRefusal,
  forgoTrainTradeRefusal,
  forgoPrivateFundingRefusal,
  fundedTradeRefusal,
  retiredDeclarationRefusal,
  emergencyObligationKey,
} = require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const emergencyModule = require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { trainSaleRefusal } = require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const { nextDerivedAction, derivedEntryKey } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { marketCellForPrice, projectShareSaleMove } = require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const { parseGameplayMessage } = require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { rankPlayers } = require("../gameEngine/endgame") as typeof import("../gameEngine/endgame");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type MapGridResponse = import("../components/hexContractTypes").MapGridResponse;
type ServerLogEntry = import("./roomSession").ServerLogEntry;

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
  x?: number;
  y?: number;
  double?: string;
}

const cell = (price: number) => marketCellForPrice(price)!;

/** A v13 board (rules revision 2, pin 13): C&O at Buy Trains (or `step`), trainless, with a legal route. */
function board(input: { corps: Corp[]; step?: string; cash: Record<string, number>; privates?: Array<{ private_id: number; owner: string; cost: string }>; rules?: number }): GameStateResponse {
  const order = input.corps.map((corp) => corp.id);
  const rules = input.rules ?? 2;
  return {
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: String(input.cash[player] ?? 0) })),
    virtual_bank_vgp: "10000",
    variants: { rules },
    rules_engine_version: rules >= 2 ? 13 : 12,
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
      input.corps.map((corp, index) => [corp.id, { price: corp.price, x: corp.x ?? cell(corp.price).x, y: corp.y ?? cell(corp.price).y, enteredAt: index + 1 }]),
    ),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id, ticker: corp.ticker, is_floated: true, president: corp.president, par_value: String(corp.price),
      ipo_pool_percentage: 0, bank_pool_percentage: corp.pool ?? 0, treasury: corp.treasury, owned_trains: corp.trains,
      player_holdings: corp.holdings.map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [[H16.q, H16.r]], station_tokens: [[H16.q, H16.r, 0]], station_token_limit: 3, home_hex_label: "F6",
      ...(corp.double ? { double_certificate: { at: corp.double } } : {}),
    })),
  } as unknown as GameStateResponse;
}

const providers = sandboxReplayProviders();
/** The reducer exactly as `RoomEngine` hands it a message: grid, chart injections and market context, so a sale walks
 *  the chart. */
const apply = (state: GameStateResponse, msg: unknown, actor: string) =>
  applySandboxAction(state, msg as never, {
    actor, mapGrid: CORRIDOR, ...providers.chartInjections(state),
    marketContext: providers.marketContext(state, msg as never, actor), parCellFor: providers.parCellFor,
  });
const funding = (state: GameStateResponse) => emergencyFundingFor(state, CORRIDOR);
const company = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;
const cash = (state: GameStateResponse, player: string) => Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);
const held = (state: GameStateResponse, id: number, player: string) => company(state, id).player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
const treasury = (state: GameStateResponse, id: number) => Number(company(state, id).treasury);
const allMoney = (state: GameStateResponse) =>
  Number(state.virtual_bank_vgp) +
  state.player_cash.reduce((sum, entry) => sum + Number(entry.cash_vgp), 0) +
  state.public_companies.reduce((sum, entry) => sum + Number(entry.treasury), 0);
const same = (a: GameStateResponse, b: GameStateResponse) => stateDigest(a) === stateDigest(b);
const ingress = (state: GameStateResponse, actor: string, msg: unknown) =>
  turnRefusal({ state, waterfall: null, actor, msg: msg as never, mapGrid: CORRIDOR });

const SELL = (id: number, percentage: number) => ({ SellStock: { game_id: 1, protocol_id: id, percentage } });
const PORTFOLIO = (...sales: Array<[number, number]>) => ({ EmergencySellPortfolio: { game_id: 1, sales: sales.map(([protocol_id, percentage]) => ({ protocol_id, percentage })) } });
const FORGO_TRADE = { ForgoTrainTrade: { game_id: 1 } };
const FORGO_PRIVATE = { ForgoPrivateFunding: { game_id: 1 } };
const EMERGENCY = (id: number) => ({ EmergencyBuyHardware: { game_id: 1, protocol_id: id } });
const DECLARE = { DeclareBankruptcy: { game_id: 1 } };
const ADVANCE = (id: number) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } });
const PASS = { PassTurn: { game_id: 1 } };
const PROPOSE = (seller: number, buyer: number, model: string, price: string) =>
  ({ ProposeTrainPurchase: { game_id: 1, seller_protocol_id: seller, seller_ticker: "x", seller_president: null, buyer_protocol_id: buyer, buyer_ticker: "x", model_type: model, price } });
const OFFER = (privateId: number, buyer: number, price: number) => ({ OfferPrivateForFunding: { game_id: 1, private_id: privateId, buyer_protocol_id: buyer, price } });
const ANSWER = (privateId: number, accept: boolean) => ({ AnswerFundingPrivateOffer: { game_id: 1, private_id: privateId, accept } });
const RESCIND = (privateId: number) => ({ RescindFundingPrivateOffer: { game_id: 1, private_id: privateId } });

/** Enter Buy Trains: the transition that creates the obligation (and, when nothing can rescue it, ends the game). */
const enter = (state: GameStateResponse) => apply({ ...state, operating_sub_phase: "Dividends" } as GameStateResponse, ADVANCE(CO), P1);

/** A room over this board: the real ingress, the real reducer, the real derived loop. */
function roomOver(seed: GameStateResponse) {
  const roomProviders = { ...sandboxReplayProviders(), initialGrid: CORRIDOR, initialMarket: seed.market_positions! };
  let n = 0;
  const room = new RoomSession({ providers: roomProviders, seed: { state: seed, waterfall: null }, build: "b", mintId: () => `m${(n += 1)}` });
  const submit = (actor: string, msg: unknown) => room.submit({ actor, build: "b", msg: msg as never, baseIndex: room.nextIndex - 1 });
  const restored = () => {
    const again = new RoomSession({ providers: roomProviders, seed: { state: seed, waterfall: null }, build: "b", mintId: () => "x" });
    again.restore(room.entries as ServerLogEntry[]);
    return again;
  };
  return { room, submit, restored, providers: roomProviders };
}
const kinds = (entries: readonly { payload: string; derived?: boolean }[]) =>
  entries.map((entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`);

/* ------------------------------------------------------------------ */
/* Boards                                                              */
/* ------------------------------------------------------------------ */

/** V1: 2-train $80; treasury 0, cash 0; C&O tied 20/20 (unsellable); P1's PRR 10% at $50 is all he can sell. */
const v1 = (step?: string) =>
  board({
    step,
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30]], price: 100 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 10]], price: 50 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
  });

/** Two holdings each too small alone: NYC 10% @ $40 and PRR 10% @ $50 against a $80 shortfall ($90 together). */
const twoHoldings = (step?: string) =>
  board({
    step,
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 10]], price: 40 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 10]], price: 50 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
  });

/** V6: treasury $30 + cash $100 cover the $80 2-train; nobody else owns a train. */
const funded = (step?: string, nycTrains: string[] = []) =>
  board({
    step,
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "30", holdings: [[P1, 60], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: nycTrains, treasury: "500", holdings: [[P2, 30], [P1, 20]], price: 100 },
    ],
    cash: { [P1]: 100, [P2]: 300, [P3]: 300 },
  });

/** V5: treasury 30 + cash 30 = $60 < $80; no legal share sale; NYC (P1 presides) owns a 2-train. */
const tradeOnly = (step?: string) =>
  board({
    step,
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "30", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P1, trains: ["2"], treasury: "100", holdings: [[P1, 20], [P2, 10]], price: 100 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40]], price: 50 },
    ],
    cash: { [P1]: 30, [P2]: 300, [P3]: 300 },
  });

/** V4: phase 3 (NYC owns a 3), the 3-train at $180, nothing liquid; P1 owns a private of the given face value. */
const privateOnly = (face: string, step?: string) =>
  board({
    step,
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3"], treasury: "500", holdings: [[P2, 30]], price: 100 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "100", holdings: [[P3, 40]], price: 50 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    privates: [{ private_id: 2, owner: P1, cost: face }],
  });

/* ------------------------------------------------------------------ */
/* 1-2, 17: insolvency is proved; nothing futile lands                 */
/* ------------------------------------------------------------------ */

describe("insolvency is proved by the exact legal-portfolio oracle (1, 2, 17)", () => {
  it("1. one insufficient share alone: no pointless sale lands -- the game ends on entering Buy Trains, with the share liquidated by the bankruptcy", () => {
    const atHardware = v1();
    const owed = funding(atHardware)!;
    expect(owed).toMatchObject({ shortfall: 80, bankrupt: true, canDeclareBankruptcy: false });
    expect(owed.automatic).toMatchObject({ tradeWindow: "unavailable", privateFunding: "irrelevant", autoPurchase: false });
    expect(owed.automatic!.rescue).toMatchObject({ maximumProceeds: 50, canFund: false, maximumLiquidation: [{ protocol_id: PRR, percentage: 10 }] });
    const ended = enter(v1());
    expect(ended.current_round_type).toBe("GameEnd");
    expect(ended.bankrupt_president).toBe(P1);
    expect(held(ended, PRR, P1)).toBe(0); // liquidated as far as legally possible
    expect(held(ended, CO, P1)).toBe(20); // the rescued corporation's crown could not move
    expect(cash(ended, P1)).toBe(0);
    expect(treasury(ended, CO)).toBe(50); // the liquidation's proceeds reached C&O
    expect(company(ended, CO).owned_trains).toEqual([]);
    expect(allMoney(ended)).toBe(allMoney(v1()));
  });

  it("2. two individually insufficient holdings: the engine evaluates the complete portfolio, not each holding", () => {
    const state = twoHoldings();
    const owed = funding(state)!;
    expect(owed.shortfall).toBe(80);
    expect(owed.bankrupt).toBe(false);
    expect(owed.automatic!.rescue.canFund).toBe(true);
    expect(owed.automatic!.rescue.maximumProceeds).toBe(90);
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: NYC, percentage: 10 }], P1)).toContain("raises $40, and $80 is needed");
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: PRR, percentage: 10 }], P1)).toContain("raises $50, and $80 is needed");
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: NYC, percentage: 10 }, { protocol_id: PRR, percentage: 10 }], P1)).toBeNull();
    // And entering Buy Trains on this board ends nothing.
    expect(enter(twoHoldings()).current_round_type).toBe("OperatingRound");
  });

  it("17. no legal rescue exists: no futile sale lands, at either lock -- a single sale and an insufficient portfolio are both refused", () => {
    const state = v1(); // 50 < 80: the bankruptcy is derived on entry; here, a board already at Hardware
    for (const msg of [SELL(PRR, 10), PORTFOLIO([PRR, 10])]) {
      expect(same(apply(state, msg, P1), state)).toBe(true);
      expect(ingress(state, P1, msg)).not.toBeNull();
    }
    expect(ingress(state, P1, PORTFOLIO([PRR, 10]))).toContain("no legal sale of your shares can raise enough");
  });

  it("V2: the bound alone is inconclusive and the exact legality decides -- an other-20 that can only be half-sold, with no 10% in the pool", () => {
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 40], [P2, 30]], price: 90, double: P1 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30]], price: 100 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    });
    const owed = funding(state)!;
    expect(owed.shortfall).toBe(80);
    expect(owed.automatic!.rescue.corporations).toEqual([]); // no legal bundle at all
    expect(owed.bankrupt).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3-10, 16, 30: the atomic portfolio                                  */
/* ------------------------------------------------------------------ */

describe("EmergencySellPortfolio is one atomic transaction (3-10, 16, 30)", () => {
  it("3. one legal rescue portfolio is accepted atomically: every leg settles, at today's prices, in one entry", () => {
    const state = twoHoldings();
    const after = apply(state, PORTFOLIO([NYC, 10], [PRR, 10]), P1);
    expect(held(after, NYC, P1)).toBe(0);
    expect(held(after, PRR, P1)).toBe(0);
    expect(cash(after, P1)).toBe(90);
    expect(company(after, NYC).bank_pool_percentage).toBe(10);
    expect(company(after, PRR).bank_pool_percentage).toBe(10);
    expect(after.market_positions![NYC]!.price).toBe(projectShareSaleMove(cell(40), 1)!.price); // each token fell one row
    expect(after.market_positions![PRR]!.price).toBe(projectShareSaleMove(cell(50), 1)!.price);
    expect(funding(after)).toMatchObject({ shortfall: 0, canPurchase: true });
    expect(funding(after)!.automatic).toMatchObject({ tradeWindow: "closed", autoPurchase: true });
    expect(allMoney(after)).toBe(allMoney(state));
  });

  it("4. several corporations are simulated in the deterministic SUBMITTED order -- the order is the president's and it is kept", () => {
    const forward = apply(twoHoldings(), PORTFOLIO([NYC, 10], [PRR, 10]), P1);
    const backward = apply(twoHoldings(), PORTFOLIO([PRR, 10], [NYC, 10]), P1);
    // Same holdings and money either way (legs in different corporations are independent) ...
    expect(cash(forward, P1)).toBe(cash(backward, P1));
    // ... but the chart records which token ARRIVED first, and the 6.0 tie-break reads arrivals: the order matters.
    const arrivals = (state: GameStateResponse) => [state.market_positions![NYC]!.enteredAt!, state.market_positions![PRR]!.enteredAt!];
    expect(arrivals(forward)[0]).toBeLessThan(arrivals(forward)[1]);
    expect(arrivals(backward)[0]).toBeGreaterThan(arrivals(backward)[1]);
    // The schema keeps the submitted order, leg for leg.
    const parsed = parseGameplayMessage(PORTFOLIO([PRR, 10], [NYC, 10]));
    expect(parsed.ok && (parsed.value as { EmergencySellPortfolio: { sales: unknown } }).EmergencySellPortfolio.sales).toEqual([
      { protocol_id: PRR, percentage: 10 },
      { protocol_id: NYC, percentage: 10 },
    ]);
  });

  it("5. a leg that is illegal at the point it executes refuses the WHOLE transaction and the original board is returned", () => {
    // NYC's pool holds 40% (four cards): 10% more fits the five-card ceiling, 20% does not.
    const capped = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 30]], pool: 40, price: 100 },
        { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 10]], price: 50 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    });
    // The first leg would be legal alone; the second (the same corporation again) would breach the ceiling after it.
    const split = PORTFOLIO([NYC, 10], [NYC, 10]);
    expect(same(apply(capped, split, P1), capped)).toBe(true);
    expect(ingress(capped, P1, split)).toContain("Each corporation appears once");
    const breach = PORTFOLIO([PRR, 10], [NYC, 20]);
    expect(same(apply(capped, breach, P1), capped)).toBe(true);
    expect(ingress(capped, P1, breach)).toMatch(/^NYC: /);
    // And the executor itself is all-or-nothing: if any executed leg disagrees with the projection, nothing lands.
    const state = twoHoldings();
    const spy = jest.spyOn(emergencyModule, "projectedPortfolioProceeds").mockReturnValue([40, 51]);
    try {
      expect(same(apply(state, PORTFOLIO([NYC, 10], [PRR, 10]), P1), state)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(same(apply(state, PORTFOLIO([NYC, 10], [PRR, 10]), P1), state)).toBe(false);
  });

  it("6. the rescued corporation's presidency may not change -- a leg that would hand C&O's crown on is refused", () => {
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 50], [P2, 30]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30]], price: 100 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    });
    const owed = funding(state)!;
    expect(owed.automatic!.rescue.corporations.map((corp) => [corp.ticker, corp.options.map((option) => option.percentage)])).toEqual([["C&O", [10, 20]]]);
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: CO, percentage: 30 }], P1)).toContain("would hand its presidency to another player");
    const sold = apply(state, PORTFOLIO([CO, 10]), P1); // $90 covers $80 and keeps P1 at 40% over 30%
    expect(company(sold, CO).president).toBe(P1);
    expect(cash(sold, P1)).toBe(90);
  });

  it("7. another corporation's presidency moves within the transaction, exactly as an ordinary sale moves it", () => {
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 60], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P1, trains: [], treasury: "500", holdings: [[P1, 30], [P2, 20]], price: 100 },
        { id: PRR, ticker: "PRR", president: P3, trains: ["2", "2", "2", "2"], treasury: "500", holdings: [[P3, 60]], price: 50 },
        { id: BO, ticker: "B&O", president: P3, trains: ["2", "2"], treasury: "500", holdings: [[P3, 60]], price: 50 },
      ],
      cash: { [P1]: 30, [P2]: 300, [P3]: 0 },
    }); // the 3-train at $180; shortfall $150; NYC 20% at $100 = $200
    expect(funding(state)).toMatchObject({ shortfall: 150, train: { tier: "3", cost: 180 } });
    const sold = apply(state, PORTFOLIO([NYC, 20]), P1);
    expect(company(sold, NYC).president).toBe(P2);
    expect(held(sold, NYC, P1)).toBe(10);
    expect(funding(sold)).toMatchObject({ shortfall: 0 });
  });

  it("8. the Bank Pool's five-certificate ceiling binds a leg", () => {
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 30]], pool: 40, price: 100 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    });
    const owed = funding(state)!;
    expect(owed.automatic!.rescue.corporations.map((corp) => corp.options.map((option) => option.percentage))).toEqual([[10]]);
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: NYC, percentage: 20 }], P1)).toMatch(/^NYC: /);
    expect(company(apply(state, PORTFOLIO([NYC, 10]), P1), NYC).bank_pool_percentage).toBe(50);
  });

  it("9 + 10. the indivisible other-20: a $100 legal sale rescues a $50 shortfall (the smallest LEGAL overshoot); the card drops the token one row", () => {
    // Shortfall $50; P1's only sellable paper is NYC's other-20 (one card) at $100; no 10% in the pool to exchange.
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "30", holdings: [[P1, 20], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 20]], price: 100, double: P1 },
        { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40]], price: 50 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    });
    const owed = funding(state)!;
    expect(owed.shortfall).toBe(50);
    expect(owed.bankrupt).toBe(false); // v12 jammed here (R4 / V7) and ended the game
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: NYC, percentage: 10 }], P1)).toContain("needs a 10% share in the Bank Pool");
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: NYC, percentage: 20 }], P1)).toBeNull();
    const sold = apply(state, PORTFOLIO([NYC, 20]), P1);
    expect(cash(sold, P1)).toBe(200);
    expect(sold.market_positions![NYC]!.price).toBe(projectShareSaleMove(cell(100), 1)!.price); // one card, one row (S9-13)
    expect(funding(sold)).toMatchObject({ shortfall: 0 });
  });

  it("only enough, for the whole portfolio: a removable leg, or a leg that could be one legal bundle smaller, is refused", () => {
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 30]], price: 40 },
        { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 10]], price: 100 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    }); // shortfall $80
    const owed = funding(state)!;
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: NYC, percentage: 30 }], P1)).toContain("20% of NYC instead of 30%");
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: NYC, percentage: 20 }], P1)).toBeNull(); // $80 exactly
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: PRR, percentage: 10 }, { protocol_id: NYC, percentage: 10 }], P1)).toContain("without NYC's shares");
    expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: PRR, percentage: 10 }], P1)).toBeNull(); // $100: an unavoidable overshoot
  });

  it("16. an insufficient portfolio is refused atomically while a valid one exists -- no self-created bankruptcy", () => {
    // P1 needs $80; PRR 20% at $40 is one legal $80 bundle; 10% alone ($40) would leave him unable to finish.
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30]], price: 100 },
        { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 20]], price: 40 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    });
    const { room, submit } = roomOver(state);
    const partial = submit(P1, PORTFOLIO([PRR, 10]));
    expect(partial.kind).toBe("refused");
    expect((partial as { reason: string }).reason).toContain("raises $40, and $80 is needed");
    expect(submit(P1, SELL(PRR, 10)).kind).toBe("refused"); // and no sequential sale either
    expect(room.entries).toHaveLength(0);
    expect(same(room.state, room.state)).toBe(true);
    expect(held(room.state, PRR, P1)).toBe(20);
    expect(submit(P1, PORTFOLIO([PRR, 20])).kind).toBe("applied");
  });

  it("30. no intermediate partial-sale board is ever committed: the room log holds ONE portfolio entry and the game's derived purchase", () => {
    const { room, submit, restored } = roomOver(twoHoldings());
    const answer = submit(P1, PORTFOLIO([NYC, 10], [PRR, 10]));
    expect(answer.kind).toBe("applied");
    expect(kinds(room.entries)).toEqual(["EmergencySellPortfolio", "EmergencyBuyHardware*"]);
    expect(room.entries.some((entry) => JSON.parse(entry.payload).SellStock !== undefined)).toBe(false);
    expect(company(room.state, CO).owned_trains).toEqual(["2"]);
    expect(stateDigest(restored().state)).toBe(stateDigest(room.state));
  });

  it("sequential emergency SellStock is refused on v13, at the reducer and at ingress", () => {
    const state = twoHoldings();
    expect(same(apply(state, SELL(NYC, 10), P1), state)).toBe(true);
    expect(ingress(state, P1, SELL(NYC, 10))).toContain("one transaction on this table");
  });

  it("the projection the v13 UI shows is the committed transaction's own result", () => {
    const state = twoHoldings();
    const ctx = { actor: P1, mapGrid: CORRIDOR, ...providers.chartInjections(state), marketContext: providers.marketContext(state, PORTFOLIO() as never, P1), parCellFor: providers.parCellFor };
    const good = projectEmergencySellPortfolio(state, [{ protocol_id: NYC, percentage: 10 }, { protocol_id: PRR, percentage: 10 }], ctx);
    expect(good).toMatchObject({ refusal: null, proceeds: [40, 50], total: 90 });
    expect(stateDigest(good.after!)).toBe(stateDigest(apply(state, PORTFOLIO([NYC, 10], [PRR, 10]), P1)));
    const short = projectEmergencySellPortfolio(state, [{ protocol_id: NYC, percentage: 10 }], ctx);
    expect(short.after).toBeNull();
    expect(short.refusal).toContain("raises $40");
  });
});

/* ------------------------------------------------------------------ */
/* 11-13: the intercorporate window                                    */
/* ------------------------------------------------------------------ */

describe("the intercorporate window and ForgoTrainTrade (11-13)", () => {
  it("11. an intercorporate train exists: bankruptcy does NOT pre-empt the trade window", () => {
    const entered = enter(tradeOnly());
    expect(entered.current_round_type).toBe("OperatingRound"); // v12 ended the game here (R3)
    const owed = funding(entered)!;
    expect(owed.automatic!.tradeWindow).toBe("open");
    expect(owed.bankrupt).toBe(false);
    expect(nextDerivedAction({ state: entered, mapGrid: CORRIDOR, emitted: new Set() })).toBeNull(); // nothing automatic yet
    // The trade the owner rule permits: <= treasury + cash ($60), <= face ($80); P1 presides both.
    expect(trainSaleRefusal(entered, { buyerId: CO, sellerId: NYC, model: "2", price: 60 }, P1, CORRIDOR, "settlement")).toBeNull();
    const traded = apply(entered, { BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: CO, seller_protocol_id: NYC, model_type: "2", price: "60" } }, P1);
    expect(company(traded, CO).owned_trains).toEqual(["2"]);
    expect(funding(traded)).toBeNull();
    // ForgoTrainTrade instead: the window closes, nothing else can rescue, and the game ends in that transition.
    const forgone = apply(entered, FORGO_TRADE, P1);
    expect(forgone.current_round_type).toBe("GameEnd");
    expect(forgone.bankrupt_president).toBe(P1);
  });

  it("12. an intercorporate purchase that would need liquidation is refused -- before the window closes by budget, after it for good", () => {
    const entered = enter(tradeOnly());
    // $61 is more than the treasury and the president's cash together: it could only be paid by selling.
    expect(trainSaleRefusal(entered, { buyerId: CO, sellerId: NYC, model: "2", price: 61 }, P1, CORRIDOR, "settlement")).toContain("without selling shares");
    // After a liquidation the window is closed, whatever the liquidation raised.
    const rich = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
        { id: NYC, ticker: "NYC", president: P1, trains: ["2"], treasury: "100", holdings: [[P1, 20], [P2, 10]], price: 100 },
        { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 20]], price: 50 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    }); // budget 0: the window is unavailable; PRR 20% funds the $80 bank train
    expect(funding(rich)!.automatic!.tradeWindow).toBe("unavailable");
    const sold = apply(rich, PORTFOLIO([PRR, 20]), P1);
    expect(cash(sold, P1)).toBe(100);
    expect(funding(sold)!.automatic!.tradeWindow).toBe("closed");
    expect(fundedTradeRefusal(sold, funding(sold)!, CO, 50, 80)).toContain("never with money raised by selling");
    expect(trainSaleRefusal(sold, { buyerId: CO, sellerId: NYC, model: "2", price: 50 }, P1, CORRIDOR, "settlement")).toContain("never with money raised by selling");
    expect(ingress(sold, P1, PROPOSE(NYC, CO, "2", "50"))).toContain("never with money raised by selling");
  });

  it("13. ForgoTrainTrade closes the window for this obligation, survives a rebuild and RevertTo, and is the president's alone", () => {
    const seed = funded(undefined, ["2"]); // treasury + cash cover the bank train, NYC could sell a 2
    expect(funding(seed)!.automatic).toMatchObject({ tradeWindow: "open", autoPurchase: false });
    const { room, submit, restored } = roomOver(seed);
    expect(submit(P2, FORGO_TRADE).kind).toBe("refused"); // not C&O's president
    expect((submit(P2, FORGO_TRADE) as { reason: string }).reason).toContain("Only C&O's president");
    expect(submit(P1, FORGO_TRADE).kind).toBe("applied");
    // The game then buys the bank train itself (14).
    expect(kinds(room.entries)).toEqual(["ForgoTrainTrade", "EmergencyBuyHardware*"]);
    expect(company(room.state, CO).owned_trains).toEqual(["2"]);
    expect(stateDigest(restored().state)).toBe(stateDigest(room.state));
    // The mark is keyed to the obligation: a later obligation (another turn) does not read it.
    const marked = apply(seed, FORGO_TRADE, P1);
    expect(marked.emergency_funding_marks).toEqual({ obligation: emergencyObligationKey(seed, CO), trade_window_closed: true });
    const laterTurn = { ...marked, macro_round_number: 5 } as GameStateResponse;
    expect(funding(laterTurn)!.automatic!.tradeWindow).toBe("open");
    // A second ForgoTrainTrade is refused (already closed).
    expect(forgoTrainTradeRefusal(marked, funding(marked), P1)).toContain("already chosen to buy from the Bank");
    // RevertTo past the decision rebuilds the open window exactly.
    const entry = (index: number, actor: string, msg: unknown) => ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg) });
    const reverted = replayLog(
      [entry(0, P1, FORGO_TRADE), entry(1, P1, { RevertTo: { index: 0, player: P1, summary: "undo" } })],
      { ...sandboxReplayProviders(), initialGrid: CORRIDOR, initialMarket: seed.market_positions! },
      { state: seed, waterfall: null },
      undefined,
      DEVELOPMENT_CORPUS_POLICY,
    );
    expect(funding(reverted.state)!.automatic!.tradeWindow).toBe("open");
  });
});

/* ------------------------------------------------------------------ */
/* 14-15, 29: the automatic purchase                                   */
/* ------------------------------------------------------------------ */

describe("the automatic treasury + president's cash and the derived purchase (14, 15, 29)", () => {
  it("14. treasury + president cash already enough: the game derives the purchase -- all of the treasury, then the difference", () => {
    const state = funded();
    const owed = funding(state)!;
    expect(owed.automatic).toMatchObject({ tradeWindow: "unavailable", autoPurchase: true });
    const derived = nextDerivedAction({ state, mapGrid: CORRIDOR, emitted: new Set() })!;
    expect(derived).toMatchObject({ kind: "forced-purchase", msg: { EmergencyBuyHardware: { protocol_id: CO } } });
    expect(derived.key).toBe(`emergency-purchase:3.1.0:${CO}:Hardware`);
    expect(derivedEntryKey(state, derived.msg)).toBe(derived.key);
    // A player cannot send it on a v13 table: it is the game's.
    expect(ingress(state, P1, EMERGENCY(CO))).toContain("made automatically");
    // Through a room, on entering Buy Trains: the skip and the purchase are one burst.
    // (The room settles what the seed board owes before it judges a submission: C&O's forced $0 withhold, which
    // walks it into Buy Trains, and then the purchase -- one derived burst, no player message needed.)
    const { room, submit } = roomOver(funded("Dividends"));
    submit(P1, ADVANCE(CO));
    expect(kinds(room.entries)).toEqual(["DeclareDividends*", "EmergencyBuyHardware*"]);
    expect(company(room.state, CO).owned_trains).toEqual(["2"]);
    expect(treasury(room.state, CO)).toBe(0); // "All of the railroad's money must be spent"
    expect(cash(room.state, P1)).toBe(50); // the president made up the $50 difference, and no more
  });

  it("15. a stock portfolio makes enough: the automatic purchase follows the accepted portfolio in the same burst", () => {
    const { room, submit } = roomOver(twoHoldings());
    expect(submit(P1, PORTFOLIO([NYC, 10], [PRR, 10])).kind).toBe("applied");
    expect(kinds(room.entries)).toEqual(["EmergencySellPortfolio", "EmergencyBuyHardware*"]);
    expect(company(room.state, CO).owned_trains).toEqual(["2"]);
    expect(cash(room.state, P1)).toBe(10); // $90 raised, $80 spent (C&O had nothing)
    expect(funding(room.state)).toBeNull();
  });

  it("29. the derived purchase is idempotent: a restart, a rebuild or a repeated settle never buys twice", () => {
    const { room, submit, restored } = roomOver(funded("Dividends"));
    submit(P1, ADVANCE(CO)); // the repair burst: the forced withhold, then the purchase
    expect(kinds(room.entries)).toEqual(["DeclareDividends*", "EmergencyBuyHardware*"]);
    submit(P1, ADVANCE(CO)); // a second look owes nothing more
    expect(kinds(room.entries)).toEqual(["DeclareDividends*", "EmergencyBuyHardware*"]);
    const again = restored();
    expect(again.entries).toHaveLength(room.entries.length);
    expect(stateDigest(again.state)).toBe(stateDigest(room.state));
    // The board owes nothing more: the obligation is gone, and the key is recorded.
    expect(nextDerivedAction({ state: room.state, mapGrid: CORRIDOR, emitted: new Set() })).toBeNull();
    const owedBoard = funded();
    const key = nextDerivedAction({ state: owedBoard, mapGrid: CORRIDOR, emitted: new Set() })!.key;
    expect(nextDerivedAction({ state: owedBoard, mapGrid: CORRIDOR, emitted: new Set([key]) })).toBeNull();
    // A duplicate purchase on the bought board is refused by the reducer (no obligation, so the president's money is not used).
    const bought = room.state;
    expect(same(apply(bought, EMERGENCY(CO), P1), bought)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 18-21: optional private funding                                     */
/* ------------------------------------------------------------------ */

describe("optional private funding and ForgoPrivateFunding (18-21)", () => {
  it("18. a private sale is the only possible rescue: no automatic bankruptcy until it is resolved or forgone", () => {
    const entered = enter(privateOnly("160", "Dividends")); // up to $320 from NYC: could cover $180
    expect(entered.current_round_type).toBe("OperatingRound");
    const owed = funding(entered)!;
    expect(owed).toMatchObject({ shortfall: 180, bankrupt: false, canDeclareBankruptcy: false });
    expect(owed.automatic).toMatchObject({ privateFunding: "relevant", privateFundingUpperBound: 320 });
    // A private that could never cover it is no reason to wait (V4b).
    const futile = enter(privateOnly("20", "Dividends"));
    expect(futile.current_round_type).toBe("GameEnd");
  });

  it("19. ForgoPrivateFunding is the president's, survives a rebuild, and -- nothing else remaining -- the bankruptcy follows in that transition", () => {
    const seed = privateOnly("160");
    const { room, submit, restored } = roomOver(seed);
    expect((submit(P2, FORGO_PRIVATE) as { reason: string }).reason).toContain("Only C&O's president");
    expect(submit(P1, FORGO_PRIVATE).kind).toBe("applied");
    expect(room.state.current_round_type).toBe("GameEnd");
    expect(room.state.bankrupt_president).toBe(P1);
    expect(stateDigest(restored().state)).toBe(stateDigest(room.state));
    // Forgone means forgone: an offer for this obligation is then refused.
    const forgone = apply({ ...seed, emergency_funding_marks: { obligation: emergencyObligationKey(seed, CO), private_funding_forgone: true } } as GameStateResponse, OFFER(2, NYC, 200), P1);
    expect(forgone.private_purchase_offer ?? null).toBeNull();
  });

  it("20. an accepted private offer settles at once and the shortfall and every remaining path are recomputed", () => {
    const seed = privateOnly("160");
    const offered = apply(seed, OFFER(2, NYC, 200), P1);
    expect(offered.private_purchase_offer).toMatchObject({ funding: true, price: 200 });
    expect(funding(offered)!.automatic!.tradeWindow).not.toBe("open"); // an offer is a liquidation: the window is shut
    const accepted = apply(offered, ANSWER(2, true), P2);
    expect(cash(accepted, P1)).toBe(200);
    expect(funding(accepted)).toMatchObject({ shortfall: 0, canPurchase: true });
    expect(funding(accepted)!.automatic!.autoPurchase).toBe(true);
    // Through a room: the buying president's yes provokes the game's purchase (attributed to P2, judged by the board).
    const { room, submit } = roomOver(seed);
    submit(P1, OFFER(2, NYC, 200));
    expect(submit(P2, ANSWER(2, true)).kind).toBe("applied");
    expect(kinds(room.entries)).toEqual(["OfferPrivateForFunding", "AnswerFundingPrivateOffer", "EmergencyBuyHardware*"]);
    expect(company(room.state, CO).owned_trains).toEqual(["3"]);
    expect(cash(room.state, P1)).toBe(20);
  });

  it("21. a declined or rescinded offer leaves the other legal options standing, recomputed", () => {
    const seed = privateOnly("160");
    const declined = apply(apply(seed, OFFER(2, NYC, 200), P1), ANSWER(2, false), P2);
    expect(declined.private_purchase_offer).toBeNull();
    expect(declined.current_round_type).toBe("OperatingRound");
    expect(funding(declined)!.automatic).toMatchObject({ privateFunding: "relevant" });
    expect(forgoPrivateFundingRefusal(declined, funding(declined), P1)).toBeNull();
    const rescinded = apply(apply(seed, OFFER(2, NYC, 200), P1), RESCIND(2), P1);
    expect(rescinded.private_purchase_offer).toBeNull();
    expect(funding(rescinded)!.automatic!.privateFunding).toBe("relevant");
    // While an offer stands nothing is decided: no forgo, no portfolio, no bankruptcy.
    const standing = apply(seed, OFFER(2, NYC, 200), P1);
    expect(forgoPrivateFundingRefusal(standing, funding(standing), P1)).toContain("waiting for an answer");
    expect(funding(standing)!.bankrupt).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 22-27: automatic bankruptcy                                         */
/* ------------------------------------------------------------------ */

describe("automatic bankruptcy liquidates as far as legally possible (22-27)", () => {
  /** Shortfall $180 (the 3-train; budget 0); P1: C&O 20 (tied, unsellable), NYC 30% at $40 with 30% already in
   *  NYC's pool (room for two more cards), PRR's President's Certificate 20% that nobody can take, B&O 10% at $20. */
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

  it("22-25. the deterministic maximum legal liquidation, its Pool-cap limit, the unsellable residue, and the proceeds to C&O", () => {
    const owed = funding(insolvent())!;
    expect(owed.shortfall).toBe(180);
    expect(owed.automatic!.rescue).toMatchObject({
      maximumProceeds: 100, // NYC 20% ($80, the pool's ceiling) + B&O 10% ($20)
      maximumLiquidation: [{ protocol_id: NYC, percentage: 20 }, { protocol_id: BO, percentage: 10 }],
      canFund: false,
    });
    const ended = enter(insolvent());
    expect(ended.current_round_type).toBe("GameEnd");
    expect(ended.bankrupt_president).toBe(P1);
    // 22: the maximum legal liquidation applied, through the ordinary sale law (tokens fell, cards entered the pools).
    expect(held(ended, NYC, P1)).toBe(10);
    expect(held(ended, BO, P1)).toBe(0);
    expect(company(ended, NYC).bank_pool_percentage).toBe(50);
    expect(ended.market_positions![NYC]!.price).toBe(projectShareSaleMove(cell(40), 2)!.price);
    // 23: the pool's five-card ceiling left 10% of NYC unsold. 24: the unsellable residue stays in his hand.
    expect(held(ended, PRR, P1)).toBe(20); // the President's Certificate nobody could take
    expect(held(ended, CO, P1)).toBe(20); // the rescued corporation's crown
    // 25: every dollar the president had went to the obligated corporation; money is conserved.
    expect(cash(ended, P1)).toBe(0);
    expect(treasury(ended, CO)).toBe(100);
    expect(allMoney(ended)).toBe(allMoney(insolvent()));
    // No scoring windfall: the bankrupt president is scored by the shares he could NOT sell, at the fallen prices.
    const ranked = rankPlayers({ state: ended, priceForCompany: (id) => ended.market_positions?.[id]?.price ?? null, labelForAddress: (address) => address, bankruptAddress: P1 });
    const p1 = ranked.find((row) => row.address === P1)!;
    // C&O 20% @ $90, NYC 10% at its fallen price, PRR 20% @ $50 -- no cash (it went to C&O), nothing for what was sold.
    expect(p1.isBankrupt).toBe(true);
    expect(p1.netWorth).toBe(2 * 90 + ended.market_positions![NYC]!.price + 2 * 50);
  });

  it("26. the bankruptcy enters GameEnd exactly once: nothing further applies, and a replay ends it at the same entry", () => {
    const ended = enter(insolvent());
    for (const msg of [PASS, SELL(NYC, 10), PORTFOLIO([NYC, 10]), FORGO_PRIVATE, EMERGENCY(CO)]) {
      expect(same(apply(ended, msg, P1), ended)).toBe(true);
    }
    const entry = (index: number, actor: string, msg: unknown) => ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg) });
    const seed = insolvent("Dividends");
    const replayProviders = { ...sandboxReplayProviders(), initialGrid: CORRIDOR, initialMarket: seed.market_positions! };
    const once = replayLog([entry(0, P1, ADVANCE(CO)), entry(1, P1, PASS)], replayProviders, { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
    const twice = replayLog([entry(0, P1, ADVANCE(CO))], replayProviders, { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(once.state.current_round_type).toBe("GameEnd");
    expect(stateDigest(once.state)).toBe(stateDigest(twice.state)); // the later PassTurn moved nothing
  });

  it("27. DeclareBankruptcy is refused on a v13 board -- with or without an obligation, at the reducer and at ingress", () => {
    const owedBoard = privateOnly("160"); // v12 offered the Declare button exactly here
    expect(retiredDeclarationRefusal(owedBoard)).toContain("never declared on this table");
    expect(same(apply(owedBoard, DECLARE, P1), owedBoard)).toBe(true);
    expect(ingress(owedBoard, P1, DECLARE)).toContain("never declared on this table");
    const quiet = { ...owedBoard, operating_sub_phase: "Track" } as GameStateResponse;
    expect(ingress(quiet, P1, DECLARE)).toContain("never declared on this table");
  });

  it("28. RevertTo and a rebuild reproduce the identical board, the bankruptcy included", () => {
    const seed = insolvent("Dividends");
    const { room, submit, restored } = roomOver(seed);
    submit(P1, ADVANCE(CO)); // the room first settles the forced withhold, whose transition ends the game
    expect(kinds(room.entries)).toEqual(["DeclareDividends*"]);
    expect(room.state.current_round_type).toBe("GameEnd");
    expect(stateDigest(restored().state)).toBe(stateDigest(room.state));
    const entry = (index: number, actor: string, msg: unknown) => ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg) });
    const replayProviders = { ...sandboxReplayProviders(), initialGrid: CORRIDOR, initialMarket: seed.market_positions! };
    const undone = replayLog([entry(0, P1, ADVANCE(CO)), entry(1, P1, { RevertTo: { index: 0, player: P1, summary: "undo" } })], replayProviders, { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(undone.state.current_round_type).toBe("OperatingRound");
    expect(undone.state.bankrupt_president).toBeUndefined();
    expect(held(undone.state, NYC, P1)).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* The new messages at the room's door                                 */
/* ------------------------------------------------------------------ */

describe("the three new messages at ingress (actor, phase, obligation, staleness, shape)", () => {
  it("the schema: well-formed frames parse (order kept), malformed ones are refused before any authority", () => {
    expect(parseGameplayMessage(FORGO_TRADE).ok).toBe(true);
    expect(parseGameplayMessage(FORGO_PRIVATE).ok).toBe(true);
    expect(parseGameplayMessage(PORTFOLIO([NYC, 10])).ok).toBe(true);
    for (const malformed of [
      { EmergencySellPortfolio: {} },
      { EmergencySellPortfolio: { sales: "NYC" } },
      { EmergencySellPortfolio: { sales: [{ protocol_id: "NYC", percentage: 10 }] } },
      { EmergencySellPortfolio: { sales: [{ protocol_id: NYC, percentage: 10.5 }] } },
      { EmergencySellPortfolio: { sales: [{ protocol_id: NYC }] } },
      { EmergencySellPortfolio: { sales: Array.from({ length: 17 }, (_, i) => ({ protocol_id: i, percentage: 10 })) } },
    ]) {
      expect(parseGameplayMessage(malformed).ok).toBe(false);
    }
    // An undeclared field is stripped, not carried into the hashed log.
    const stripped = parseGameplayMessage({ EmergencySellPortfolio: { sales: [{ protocol_id: NYC, percentage: 10, price: 999 }] } });
    expect(stripped.ok && JSON.stringify(stripped.value)).toBe(JSON.stringify({ EmergencySellPortfolio: { sales: [{ protocol_id: NYC, percentage: 10 }] } }));
  });

  it("invalid percentages, empty and duplicate portfolios are the authority's refusal, with its sentence", () => {
    const state = twoHoldings();
    expect(ingress(state, P1, PORTFOLIO([NYC, 15]))).toContain("whole 10% certificates");
    expect(ingress(state, P1, PORTFOLIO([NYC, 0]))).toContain("whole 10% certificates");
    expect(ingress(state, P1, PORTFOLIO([NYC, -10]))).toContain("whole 10% certificates");
    expect(ingress(state, P1, PORTFOLIO())).toContain("at least one corporation");
    expect(ingress(state, P1, PORTFOLIO([NYC, 10], [PRR, 10], [NYC, 10]))).toContain("appears once");
    expect(ingress(state, P1, PORTFOLIO([NYC, 20], [PRR, 10]))).toMatch(/^NYC: /); // P1 holds 10%
  });

  it("the wrong actor, the wrong step, no obligation, a stale decision -- each refused at ingress and by the reducer", () => {
    const state = twoHoldings();
    for (const msg of [PORTFOLIO([NYC, 10], [PRR, 10]), FORGO_PRIVATE, FORGO_TRADE]) {
      expect(ingress(state, P2, msg)).not.toBeNull();
      expect(same(apply(state, msg, P2), state)).toBe(true);
    }
    expect(ingress(state, P2, PORTFOLIO([NYC, 10], [PRR, 10]))).toContain("Only C&O's president");
    const notOwed = { ...state, operating_sub_phase: "Track" } as GameStateResponse;
    for (const msg of [PORTFOLIO([NYC, 10], [PRR, 10]), FORGO_PRIVATE, FORGO_TRADE]) {
      expect(ingress(notOwed, P1, msg)).toContain("No forced train purchase is owed");
      expect(same(apply(notOwed, msg, P1), notOwed)).toBe(true);
    }
    // Stale: the window was closed for THIS obligation; nothing to forgo on this board (no trade possible) either.
    expect(ingress(state, P1, FORGO_TRADE)).toContain("no trade to forgo");
    // A decision with nothing to decide: no private could be offered here.
    expect(ingress(state, P1, FORGO_PRIVATE)).toContain("nothing to decline");
  });

  it("a funded board takes no portfolio, and an outstanding offer holds every decision", () => {
    expect(ingress(funded(), P1, PORTFOLIO([NYC, 10]))).toContain("can already pay for the train");
    const standing = apply(privateOnly("160"), OFFER(2, NYC, 200), P1);
    for (const msg of [PORTFOLIO([NYC, 10]), FORGO_PRIVATE, FORGO_TRADE]) {
      expect(ingress(standing, P1, msg)).toContain("is on offer to NYC");
    }
  });
});
