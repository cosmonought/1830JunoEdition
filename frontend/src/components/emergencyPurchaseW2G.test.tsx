/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W2-G (harness), RECONCILED TO RULES v13: THE EMERGENCY SURFACE PRESENTS W3-K's STATE MACHINE
// ==================================================================
//
// Every board here is a rules-revision-2 (v13) board, judged by the REAL authority (`emergencyFundingFor(...).automatic`,
// `emergencyPortfolioRefusal`, `forgoTrainTradeRefusal`, `forgoPrivateFundingRefusal`, `fundingPrivateOfferRefusal`,
// `proposeTrainPurchaseRefusal`), and every decision the harness "sends" can be applied through the REAL reducer --
// so what the surface shows next is the authority's next answer, not a mock's.
//
//   viewer scope              obligated president / another seat / spectator / watcher
//   trade window              open: the authority's candidates, offer / direct buy; ForgoTrainTrade with the projected
//                             consequence; closed: never offered again
//   atomic portfolio          ONE EmergencySellPortfolio, several corporations, the president's order; either of two
//                             legal rescue portfolios; duplicate legs impossible to compose and refused by the authority;
//                             no SellStock anywhere
//   private funding           relevant (offer + ForgoPrivateFunding); irrelevant (no fictitious wait)
//   automatic purchase        funded: a status, no Buy; the no-server path forwards it once, and a reload does not repeat it
//   bankruptcy                automatic: no DeclareBankruptcy control or message anywhere; the ended board unmounts both
//   W2-A holds                the dock greys for every seat; the hold lets exactly the modal's decisions through
//   latch                     one press, one message; greyed while a send is in flight

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ModalLayerHost } from "./ModalPortal";
import {
  EmergencyTrainPurchaseModal,
  buildEmergencyPurchasePlan,
  type EmergencyPurchasePlan,
  type EmergencyTrainPurchaseModalProps,
} from "./EmergencyTrainPurchaseModal";
import { EmergencyPurchaseWaitingCard } from "./EmergencyPurchaseWaitingCard";
import { WAITING_STATUS_ATTRIBUTE } from "./WaitingStatusBanner";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import {
  emergencyFundingFor,
  emergencyPortfolioRefusal,
  forgoPrivateFundingRefusal,
  forgoTrainTradeRefusal,
  type EmergencyFunding,
  type EmergencySaleLeg,
} from "../gameEngine/emergencyFunding";
import { authoritativeHoldRefusal } from "../gameEngine/authoritativeHolds";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { marketCellForPrice } from "../gameEngine/marketGeometry";
import { STATIC_BOARD_HEXES } from "./hexBoardData";
import {
  EMPTY_PORTFOLIO_DRAFT,
  decisionConsequenceFor,
  emergencyStageFor,
  emergencyViewerIsPresident,
  emergencyWaitingSentence,
  fundingAnswerRefusalForViewer,
  fundingOfferDraftRefusal,
  intercorporateOfferRefusal,
  intercorporateStepFor,
  portfolioLegs,
  portfolioVerdictFor,
  trainSourceName,
  withPortfolioChoice,
} from "../utils/emergencyPurchaseView";
import { dockHoldView } from "../utils/dockHoldView";
import { noServerDerivedToSend } from "../utils/noServerDerivedForwarding";
import { readShell, readStripped } from "../utils/sourceScan";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "./hexContractTypes";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ */
/* v13 boards (the `rulesV13EmergencyFunding.test.ts` shapes)          */
/* ------------------------------------------------------------------ */

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

const CO = 5; // the corporation without a train
const NYC = 2;
const PRR = 1;
const BO = 4;
const P1 = "p1"; // C&O's president
const P2 = "p2";
const P3 = "p3";
const NAMES: Record<string, string> = { [P1]: "Alice", [P2]: "Bob", [P3]: "Cara" };
const label = (address: string) => NAMES[address] ?? address;

interface Corp {
  id: number;
  ticker: string;
  president: string;
  trains: string[];
  treasury: string;
  holdings: Array<[string, number]>;
  pool?: number;
  price: number;
}

const cell = (price: number) => marketCellForPrice(price)!;

function board(input: {
  corps: Corp[];
  step?: string;
  cash: Record<string, number>;
  privates?: Array<{ private_id: number; owner: string; cost: string }>;
  returned?: string[];
  rules?: number;
}): GameStateResponse {
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
    ...(input.returned ? { returned_trains: input.returned } : {}),
    market_positions: Object.fromEntries(
      input.corps.map((corp, index) => [corp.id, { price: corp.price, x: cell(corp.price).x, y: cell(corp.price).y, enteredAt: index + 1 }]),
    ),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id, ticker: corp.ticker, is_floated: true, president: corp.president, par_value: String(corp.price),
      ipo_pool_percentage: 0, bank_pool_percentage: corp.pool ?? 0, treasury: corp.treasury, owned_trains: corp.trains,
      player_holdings: corp.holdings.map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [[H16.q, H16.r]], station_tokens: [[H16.q, H16.r, 0]], station_token_limit: 3, home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

const providers = sandboxReplayProviders();
/** The reducer exactly as `RoomEngine` hands it a message (grid, chart injections, market context). */
const apply = (state: GameStateResponse, msg: unknown, actor: string) =>
  applySandboxAction(state, msg as never, {
    actor, mapGrid: CORRIDOR, ...providers.chartInjections(state),
    marketContext: providers.marketContext(state, msg as never, actor), parCellFor: providers.parCellFor,
  });
const fundingOf = (state: GameStateResponse) => emergencyFundingFor(state, CORRIDOR)!;
const held = (state: GameStateResponse, id: number, player: string) =>
  state.public_companies.find((entry) => entry.company_id === id)!.player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
const ADVANCE = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: CO } };
const enter = (state: GameStateResponse) => apply({ ...state, operating_sub_phase: "Dividends" } as GameStateResponse, ADVANCE, P1);

/** Two holdings each too small alone: NYC 10% @ $40 and PRR 10% @ $50 against an $80 shortfall ($90 together). */
const twoHoldings = () =>
  board({
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 10]], price: 40 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 10]], price: 50 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
  });

/** Owner ruling 1: $50 short; { PRR 10% } ($100) and { NYC 10% } ($60) are each a legal rescue. */
const choice = () =>
  board({
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "30", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 10]], price: 60 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 10]], price: 100 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
  });

/** Treasury $30 + cash $100 cover the $80 2-train. `nycTrains` gives NYC a train to sell (the trade window). */
const funded = (nycTrains: string[] = [], returned?: string[]) =>
  board({
    returned,
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "30", holdings: [[P1, 60], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: nycTrains, treasury: "500", holdings: [[P2, 30], [P1, 20]], price: 100 },
    ],
    cash: { [P1]: 100, [P2]: 300, [P3]: 300 },
  });

/** $30 + $30 = $60 < $80; no legal share sale; NYC (Alice presides) owns a 2-train: the window is the only rescue. */
const tradeOnly = () =>
  board({
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "30", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P1, trains: ["2"], treasury: "100", holdings: [[P1, 20], [P2, 10]], price: 100 },
      { id: PRR, ticker: "PRR", president: P3, trains: ["2"], treasury: "500", holdings: [[P3, 40]], price: 50 },
    ],
    cash: { [P1]: 30, [P2]: 300, [P3]: 300 },
  });

/** Phase 3 (NYC owns a 3): the 3-train at $180, nothing liquid; Alice owns private 2 of the given face. */
const privateOnly = (face: string, nycTreasury = "500") =>
  board({
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3"], treasury: nycTreasury, holdings: [[P2, 30]], price: 100 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "100", holdings: [[P3, 40]], price: 50 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    privates: [{ private_id: 2, owner: P1, cost: face }],
  });

/** Owner ruling 5 case A: two $100 privates and ONE buyer with $150 -- the loose bound says $300, the exact law $150. */
const boundOnly = () =>
  board({
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3"], treasury: "150", holdings: [[P2, 30]], price: 100 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "40", holdings: [[P3, 40]], price: 50 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    privates: [{ private_id: 2, owner: P1, cost: "100" }, { private_id: 3, owner: P1, cost: "100" }],
  });

/** Shortfall $180, legal liquidation $100 at most: the bankruptcy is certain on entering Buy Trains. */
const insolvent = () =>
  board({
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3"], treasury: "500", holdings: [[P2, 40], [P1, 30]], pool: 30, price: 40 },
      { id: PRR, ticker: "PRR", president: P1, trains: [], treasury: "500", holdings: [[P1, 20], [P3, 10]], price: 50 },
      { id: BO, ticker: "B&O", president: P3, trains: [], treasury: "500", holdings: [[P3, 60], [P1, 10]], price: 20 },
    ],
    cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
  });

const planOf = (state: GameStateResponse): EmergencyPurchasePlan => {
  const funding = fundingOf(state);
  return buildEmergencyPurchasePlan({
    funding,
    stage: emergencyStageFor(state, funding),
    labelForAddress: label,
    privateOfferBuyerPresident: state.private_purchase_offer?.funding
      ? state.public_companies.find((entry) => entry.company_id === state.private_purchase_offer!.buyer_protocol_id)?.president ?? null
      : null,
    rulesRevision: typeof state.variants?.rules === "number" ? state.variants.rules : 0,
  });
};

const PORTFOLIO = (...legs: Array<[number, number]>) => ({
  EmergencySellPortfolio: { game_id: 1, sales: legs.map(([protocol_id, percentage]) => ({ protocol_id, percentage })) },
});
const FORGO_TRADE = { ForgoTrainTrade: { game_id: 1 } };
const FORGO_PRIVATE = { ForgoPrivateFunding: { game_id: 1 } };
const OFFER = (privateId: number, buyer: number, price: number) => ({ OfferPrivateForFunding: { game_id: 1, private_id: privateId, buyer_protocol_id: buyer, price } });

/* ================================================================== */
/*  The view helper, against the authority                             */
/* ================================================================== */

describe("viewer scope (OD-1): the obligated president, another seat, a spectator, a watcher", () => {
  it("gives the workflow to the obligated president's own, non-spectating screen only", () => {
    expect(emergencyViewerIsPresident({ spectator: false, president: P1, viewerAddress: P1 })).toBe(true);
    expect(emergencyViewerIsPresident({ spectator: false, president: P1, viewerAddress: P2 })).toBe(false); // another seat
    expect(emergencyViewerIsPresident({ spectator: false, president: P1, viewerAddress: "" })).toBe(false); // a watcher
    expect(emergencyViewerIsPresident({ spectator: true, president: P1, viewerAddress: P1 })).toBe(false); // spectate mode
  });

  it("the authority refuses every decision from anyone but the obligated president -- the surface never offers them", () => {
    const state = privateOnly("160");
    const owed = fundingOf(state);
    for (const actor of [P2, P3, ""]) {
      expect(forgoPrivateFundingRefusal(state, owed, actor)).toContain("Only C&O's president");
      expect(emergencyPortfolioRefusal(state, owed, [{ protocol_id: NYC, percentage: 10 }], actor)).toContain("Only C&O's president");
      expect(fundingOfferDraftRefusal(state, owed, actor, { privateId: 2, buyerId: NYC, price: "200" })).toContain("Only C&O's president");
    }
    const window = fundingOf(tradeOnly());
    expect(forgoTrainTradeRefusal(tradeOnly(), window, P2)).toContain("Only C&O's president");
    expect(intercorporateStepFor(tradeOnly(), window, CORRIDOR, P2).legal).toEqual([]);
  });

  it("tells everybody else, in one sentence, who the table is waiting on -- or that the game is buying the train", () => {
    const base = { ticker: "C&O", presidentLabel: "Alice", privateOffer: null, trainOffer: null };
    expect(emergencyWaitingSentence(base)).toBe("C&O is resolving an emergency train purchase — waiting on Alice.");
    expect(
      emergencyWaitingSentence({ ...base, privateOffer: { privateName: "Private 2", buyerTicker: "NYC", buyerPresidentLabel: "Bob" } }),
    ).toBe("C&O is resolving an emergency train purchase — Private 2 is on offer to NYC; waiting on Bob.");
    expect(
      emergencyWaitingSentence({ ...base, trainOffer: { sellerTicker: "NYC", model: "2", price: "60", sellerPresidentLabel: "Bob", accepted: false } }),
    ).toBe("C&O is resolving an emergency train purchase — it has offered $60 for NYC's 2-train; waiting on Bob.");
    expect(emergencyWaitingSentence({ ...base, automaticPurchase: true })).toBe(
      "C&O is resolving an emergency train purchase — the purchase is funded and the game is buying the train automatically.",
    );
  });
});

describe("the stage is the authority's, in its own priority order", () => {
  it("reads every v13 state off `emergencyFundingFor(...).automatic`", () => {
    expect(emergencyStageFor(tradeOnly(), fundingOf(tradeOnly()))).toBe("trade-window");
    expect(emergencyStageFor(funded(), fundingOf(funded()))).toBe("automatic-purchase");
    expect(emergencyStageFor(twoHoldings(), fundingOf(twoHoldings()))).toBe("funding");
    expect(emergencyStageFor(insolvent(), fundingOf(insolvent()))).toBe("bankruptcy");
    const offered = apply(privateOnly("160"), OFFER(2, NYC, 200), P1);
    expect(emergencyStageFor(offered, fundingOf(offered))).toBe("private-offer");
    const proposed = apply(
      tradeOnly(),
      { ProposeTrainPurchase: { game_id: 1, seller_protocol_id: PRR, seller_ticker: "PRR", seller_president: P3, buyer_protocol_id: CO, buyer_ticker: "C&O", model_type: "2", price: "60" } },
      P1,
    );
    expect(proposed.train_purchase_offer).toMatchObject({ seller_protocol_id: PRR, buyer_protocol_id: CO });
    expect(emergencyStageFor(proposed, fundingOf(proposed))).toBe("train-offer");
    // A legacy (revision-1) board has no automatic sequence: the v12 manual controls are not presented.
    const legacy = { ...twoHoldings(), variants: { rules: 1 }, rules_engine_version: 12 } as GameStateResponse;
    expect(fundingOf(legacy).automatic).toBeUndefined();
    expect(emergencyStageFor(legacy, fundingOf(legacy))).toBe("legacy");
  });

  it("names the required train's actual source (K-25)", () => {
    expect(trainSourceName("depot")).toBe("Bank Depot");
    expect(trainSourceName("pool")).toBe("Bank Pool");
    expect(planOf(funded()).trainSourceName).toBe("Bank Depot");
    const pooled = funded([], ["2"]);
    expect(fundingOf(pooled).train.source).toBe("pool");
    expect(planOf(pooled).trainSourceName).toBe("Bank Pool");
  });
});

describe("the forgo consequence is the authority's projection, not prose of ours", () => {
  it("ForgoTrainTrade on a funded board: the game then buys the train", () => {
    const state = funded(["2"]);
    expect(fundingOf(state).automatic).toMatchObject({ tradeWindow: "open", autoPurchase: false });
    const consequence = decisionConsequenceFor(state, fundingOf(state), CORRIDOR, "trade_window_closed", "Alice")!;
    expect(consequence).toEqual({
      outcome: "automatic-purchase",
      severity: "notice",
      text: "The game then buys the 2-train from the Bank Depot automatically: C&O pays its whole treasury ($30) and Alice pays $50 of personal cash.",
    });
    // And the reducer agrees: the forgo, then the derived purchase.
    const after = apply(state, FORGO_TRADE, P1);
    expect(fundingOf(after).automatic).toMatchObject({ tradeWindow: "closed", autoPurchase: true });
  });

  it("ForgoTrainTrade when the window is the only rescue: bankruptcy, prominently -- and the reducer ends the game", () => {
    const state = tradeOnly();
    const consequence = decisionConsequenceFor(state, fundingOf(state), CORRIDOR, "trade_window_closed", "Alice")!;
    expect(consequence.outcome).toBe("bankruptcy");
    expect(consequence.severity).toBe("prominent");
    expect(consequence.text).toContain("sold as far as the rules allow");
    const after = apply(state, FORGO_TRADE, P1);
    expect(after.current_round_type).toBe("GameEnd");
    expect(after.bankrupt_president).toBe(P1);
  });

  it("ForgoPrivateFunding when a private is the only rescue: bankruptcy, prominently", () => {
    const state = privateOnly("160");
    const consequence = decisionConsequenceFor(state, fundingOf(state), CORRIDOR, "private_funding_forgone", "Alice")!;
    expect(consequence.outcome).toBe("bankruptcy");
    expect(apply(state, FORGO_PRIVATE, P1).current_round_type).toBe("GameEnd");
  });
});

describe("the share portfolio: one EmergencySellPortfolio, composed from the authority's bundles", () => {
  it("one leg per corporation by construction, in the president's order", () => {
    let draft = withPortfolioChoice(EMPTY_PORTFOLIO_DRAFT, PRR, 10);
    draft = withPortfolioChoice(draft, NYC, 10);
    expect(portfolioLegs(draft)).toEqual([{ protocol_id: PRR, percentage: 10 }, { protocol_id: NYC, percentage: 10 }]);
    // Choosing PRR again replaces its leg in place -- a duplicate leg cannot be composed.
    draft = withPortfolioChoice(draft, PRR, 20);
    expect(portfolioLegs(draft)).toEqual([{ protocol_id: PRR, percentage: 20 }, { protocol_id: NYC, percentage: 10 }]);
    draft = withPortfolioChoice(draft, PRR, 0);
    expect(portfolioLegs(draft)).toEqual([{ protocol_id: NYC, percentage: 10 }]);
  });

  it("duplicate-corporation legs are the authority's refusal (owner ruling 4)", () => {
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
        { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 20]], price: 40 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    });
    const split: EmergencySaleLeg[] = [{ protocol_id: PRR, percentage: 10 }, { protocol_id: PRR, percentage: 10 }];
    expect(emergencyPortfolioRefusal(state, fundingOf(state), split, P1)).toContain("Each corporation appears once");
    // The surface's draft can only ever say "PRR 20%", which the authority accepts.
    const whole = portfolioVerdictFor(state, fundingOf(state), P1, withPortfolioChoice(EMPTY_PORTFOLIO_DRAFT, PRR, 20));
    expect(whole).toEqual({ legs: [{ protocol_id: PRR, percentage: 20 }], total: 80, refusal: null });
  });

  it("two different legal rescue portfolios: either is permitted, both together are not (owner ruling 1)", () => {
    const state = choice();
    const owed = fundingOf(state);
    expect(owed.shortfall).toBe(50);
    const viaPrr = portfolioVerdictFor(state, owed, P1, withPortfolioChoice(EMPTY_PORTFOLIO_DRAFT, PRR, 10));
    const viaNyc = portfolioVerdictFor(state, owed, P1, withPortfolioChoice(EMPTY_PORTFOLIO_DRAFT, NYC, 10));
    expect([viaPrr.total, viaPrr.refusal]).toEqual([100, null]); // the larger overshoot is NOT refused
    expect([viaNyc.total, viaNyc.refusal]).toEqual([60, null]);
    const both = portfolioVerdictFor(state, owed, P1, withPortfolioChoice(withPortfolioChoice(EMPTY_PORTFOLIO_DRAFT, PRR, 10), NYC, 10));
    expect(both.refusal).toContain("Only enough may be sold");
  });
});

/* ================================================================== */
/*  The modal                                                          */
/* ================================================================== */

let host: HTMLDivElement;
let root: Root;
let layerHost: HTMLDivElement;
let layerRoot: Root;

interface Calls {
  proposals: Array<[string, string]>;
  rescindTrades: number[];
  forgoTrades: number;
  portfolios: EmergencySaleLeg[][];
  offers: Array<[number, number, number]>;
  rescindPrivates: number[];
  answers: Array<[number, boolean]>;
  forgoPrivates: number;
}
let calls: Calls;
let state: GameStateResponse;
let inFlight = false;
let viewer = P1;

function freshCalls(): Calls {
  return { proposals: [], rescindTrades: [], forgoTrades: 0, portfolios: [], offers: [], rescindPrivates: [], answers: [], forgoPrivates: 0 };
}

/** The shell's wiring, reduced to what the modal needs: every prop computed from `state` by the real helpers. Each
 *  decision is applied through the real reducer, so the next render is the authority's next answer. */
function propsFor(current: GameStateResponse, overrides: Partial<EmergencyTrainPurchaseModalProps> = {}): EmergencyTrainPurchaseModalProps {
  const funding: EmergencyFunding | null = emergencyFundingFor(current, CORRIDOR);
  const plan = funding ? planOf(current) : null;
  return {
    plan,
    sandbox: true,
    actionInFlight: inFlight,
    labelForAddress: label,
    intercorporate: funding ? intercorporateStepFor(current, funding, CORRIDOR, viewer) : null,
    intercorporateOfferRefusal: (draft) => (funding ? intercorporateOfferRefusal(current, funding, CORRIDOR, viewer, draft) : "none"),
    onProposeTrade: (option, price) => calls.proposals.push([option.key, price]),
    onRescindTrade: (sellerId) => calls.rescindTrades.push(sellerId),
    forgoTrade: {
      refusal: funding ? forgoTrainTradeRefusal(current, funding, viewer) : "none",
      consequence: funding ? decisionConsequenceFor(current, funding, CORRIDOR, "trade_window_closed", label(P1)) : null,
    },
    onForgoTrainTrade: () => {
      calls.forgoTrades += 1;
      state = apply(state, FORGO_TRADE, viewer);
    },
    portfolioVerdict: (draft) => (funding ? portfolioVerdictFor(current, funding, viewer, draft) : { legs: [], total: 0, refusal: "none" }),
    onSellPortfolio: (legs) => {
      calls.portfolios.push(legs);
      state = apply(state, { EmergencySellPortfolio: { game_id: 1, sales: legs } }, viewer);
    },
    privateOfferRefusal: (draft) => (funding ? fundingOfferDraftRefusal(current, funding, viewer, draft) : "none"),
    onOfferPrivate: (privateId, buyer, price) => calls.offers.push([privateId, buyer, price]),
    onRescindPrivateOffer: (privateId) => calls.rescindPrivates.push(privateId),
    fundingAnswerRefusal: current.private_purchase_offer?.funding ? fundingAnswerRefusalForViewer(current, CORRIDOR, viewer) : "none",
    onAnswerFundingOffer: (privateId, accept) => calls.answers.push([privateId, accept]),
    forgoPrivate: {
      refusal: funding ? forgoPrivateFundingRefusal(current, funding, viewer) : "none",
      consequence: funding ? decisionConsequenceFor(current, funding, CORRIDOR, "private_funding_forgone", label(P1)) : null,
    },
    onForgoPrivateFunding: () => {
      calls.forgoPrivates += 1;
      state = apply(state, FORGO_PRIVATE, viewer);
    },
    ...overrides,
  };
}

function render(overrides: Partial<EmergencyTrainPurchaseModalProps> = {}) {
  act(() => root.render(<EmergencyTrainPurchaseModal {...propsFor(state, overrides)} />));
}

let mounted = false;

function unmountAll() {
  if (!mounted) return;
  act(() => root.unmount());
  act(() => layerRoot.unmount());
  document.body.innerHTML = "";
  mounted = false;
}

function mount(initial: GameStateResponse, overrides: Partial<EmergencyTrainPurchaseModalProps> = {}) {
  unmountAll();
  mounted = true;
  state = initial;
  calls = freshCalls();
  inFlight = false;
  viewer = P1;
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot.render(<ModalLayerHost />));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  render(overrides);
}

afterEach(() => unmountAll());

const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-native-modal]");
const text = () => dialog()?.textContent ?? "";
const buttons = () => Array.from(dialog()?.querySelectorAll("button") ?? []);
const button = (match: RegExp | string) => {
  const found = buttons().find((node) => (typeof match === "string" ? node.textContent === match : match.test(node.textContent ?? "")));
  if (!found) throw new Error(`no button ${String(match)} in: ${buttons().map((node) => node.textContent).join(" | ")}`);
  return found;
};
const hasButton = (match: RegExp) => buttons().some((node) => match.test(node.textContent ?? ""));
const live = (node: HTMLButtonElement) => !node.hasAttribute("disabled");
const click = (node: HTMLElement) => act(() => void node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const choose = (node: HTMLSelectElement | HTMLInputElement, value: string) =>
  act(() => {
    const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
const select = (ariaLabel: string) => dialog()!.querySelector<HTMLSelectElement>(`select[aria-label="${ariaLabel}"]`)!;

describe("the modal: no dismissal, no bankruptcy control, no sequential sale", () => {
  it("cannot be closed or escaped", () => {
    mount(twoHoldings());
    const node = dialog()!;
    expect(node.getAttribute("closedby")).toBe("none");
    expect(buttons().some((entry) => /close|cancel|dismiss|×/i.test(entry.textContent ?? ""))).toBe(false);
    act(() => void node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(dialog()).not.toBeNull();
    expect(text()).toContain("Emergency Train Purchase");
    expect(readStripped("components/EmergencyTrainPurchaseModal.tsx")).not.toContain("onClose");
  });

  it("never offers a bankruptcy control, on any v13 stage", () => {
    for (const board_ of [tradeOnly(), funded(), funded(["2"]), twoHoldings(), choice(), privateOnly("160"), insolvent(), apply(privateOnly("160"), OFFER(2, NYC, 200), P1)]) {
      mount(board_);
      expect(dialog()).not.toBeNull();
      expect(buttons().some((entry) => /bankrupt/i.test(entry.textContent ?? ""))).toBe(false);
    }
  });

  it("no DeclareBankruptcy, SellStock or EmergencyBuyHardware anywhere in the surface's code", () => {
    for (const file of ["components/EmergencyTrainPurchaseModal.tsx", "components/EmergencyPurchaseWaitingCard.tsx", "utils/emergencyPurchaseView.ts"]) {
      const source = readStripped(file);
      expect([file, source.includes("DeclareBankruptcy")]).toEqual([file, false]);
      expect([file, /Declare bankruptcy/i.test(source)]).toEqual([file, false]);
      expect([file, source.includes("SellStock")]).toEqual([file, false]);
      expect([file, source.includes("EmergencyBuyHardware")]).toEqual([file, false]);
      expect([file, source.includes("onDeclareBankruptcy")]).toEqual([file, false]);
    }
    const app = readShell();
    expect(app).not.toMatch(/DeclareBankruptcy: \{/);
    expect(app).not.toContain("onDeclareBankruptcy");
    expect(app).not.toMatch(/SellStock: \{ game_id: gameId/);
    expect(app).not.toMatch(/EmergencyBuyHardware: \{/);
  });
});

describe("the modal: the open trade window", () => {
  it("shows the authority's candidates and the pre-liquidation budget -- and no share or private sale", () => {
    mount(tradeOnly());
    expect(text()).toContain("Step 1 — Buy from another corporation");
    expect(text()).toContain("never money raised by selling shares or private companies");
    const train = select("Train to buy from another corporation");
    expect(Array.from(train.options).map((option) => option.textContent)).toEqual(["NYC — 2-train (face $80)", "PRR — 2-train (face $80)"]);
    // Liquidation is never presented as funding for the trade.
    expect(dialog()!.querySelector('select[aria-label^="Shares of"]')).toBeNull();
    expect(text()).not.toContain("Offer a private company");
    expect(hasButton(/^Sell/)).toBe(false);
    const price = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Price offered"]')!;
    choose(price, "61");
    expect(live(button("Buy for $61"))).toBe(false); // NYC is Alice's: a direct buy, refused above the $60 budget
    expect(text()).toContain("without selling shares");
    choose(price, "60");
    click(button("Buy for $60"));
    expect(calls.proposals).toEqual([["2:2:-", "60"]]);
    choose(train, "1:2:-");
    expect(button("Offer $60")).toBeTruthy(); // PRR is Cara's: an offer she answers
  });

  it("ForgoTrainTrade: confirm with the projected consequence, send it once, and the window never reopens", () => {
    mount(funded(["2"]));
    click(button(/^Buy from the Bank Depot instead$/));
    const warning = dialog()!.querySelector('[role="alert"]')!;
    expect(warning.textContent).toContain("will not be offered again");
    expect(warning.textContent).toContain("The game then buys the 2-train from the Bank Depot automatically");
    click(button("Back")); // nothing sent; the obligation untouched
    expect(calls.forgoTrades).toBe(0);
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
    click(button(/^Buy from the Bank Depot instead$/));
    click(button("Buy from the Bank Depot"));
    expect(calls.forgoTrades).toBe(1);
    render(); // the board the reducer produced
    expect(fundingOf(state).automatic!.tradeWindow).toBe("closed");
    expect(text()).not.toContain("Step 1 — Buy from another corporation");
    expect(dialog()!.querySelector('select[aria-label="Train to buy from another corporation"]')).toBeNull();
    expect(text()).toContain("a train from another corporation is no longer possible");
    // Closed for good: the authority refuses every candidate and a second forgo.
    expect(intercorporateStepFor(state, fundingOf(state), CORRIDOR, P1).legal).toEqual([]);
    expect(forgoTrainTradeRefusal(state, fundingOf(state), P1)).toContain("already chosen to buy from the Bank");
  });

  it("ForgoTrainTrade when it would end the game: the warning is PROMINENT", () => {
    mount(tradeOnly());
    click(button(/^Buy from the Bank Depot instead$/));
    const warning = dialog()!.querySelector('[role="alert"]')!;
    expect(warning.textContent).toContain("Warning: this ends the game in bankruptcy");
    click(button("Buy from the Bank Depot"));
    expect(calls.forgoTrades).toBe(1);
    expect(state.current_round_type).toBe("GameEnd"); // the reducer's automatic bankruptcy, not a declaration
    render();
    expect(dialog()).toBeNull(); // no obligation stands on an ended board
  });

  it("a standing offer: Withdraw only, and nothing else until it is answered", () => {
    mount(
      apply(
        tradeOnly(),
        { ProposeTrainPurchase: { game_id: 1, seller_protocol_id: PRR, seller_ticker: "PRR", seller_president: P3, buyer_protocol_id: CO, buyer_ticker: "C&O", model_type: "2", price: "60" } },
        P1,
      ),
    );
    expect(text()).toContain("Waiting on Cara to answer.");
    expect(hasButton(/instead$/)).toBe(false);
    expect(hasButton(/^Sell/)).toBe(false);
    click(button("Withdraw offer"));
    expect(calls.rescindTrades).toEqual([PRR]);
  });
});

describe("the modal: the atomic share portfolio", () => {
  it("several corporations, ONE EmergencySellPortfolio, in the president's order -- applied as one transaction", () => {
    mount(twoHoldings());
    expect(text()).toContain("Sell shares — one transaction");
    expect(text()).toContain("Still to raise$80");
    const sell = () => button(/^Sell the chosen shares/);
    expect(live(sell())).toBe(false);
    expect(text()).toContain("An emergency sale must name at least one corporation's shares.");
    choose(select("Shares of PRR to sell"), "10");
    // One leg alone is insufficient: the authority's sentence, and no partial sale is possible.
    expect(live(sell())).toBe(false);
    expect(text()).toContain("This sale raises $50, and $80 is needed");
    choose(select("Shares of NYC to sell"), "10");
    expect(text()).toContain("Sold in this order: PRR, NYC.");
    expect(text()).toContain("Your cash $0 → $90 — covers the $80 needed");
    expect(live(sell())).toBe(true);
    click(sell());
    expect(calls.portfolios).toEqual([[{ protocol_id: PRR, percentage: 10 }, { protocol_id: NYC, percentage: 10 }]]);
    // The reducer settled both legs in one transition; the game now owes the automatic purchase.
    expect(held(state, PRR, P1)).toBe(0);
    expect(held(state, NYC, P1)).toBe(0);
    expect(fundingOf(state)).toMatchObject({ shortfall: 0 });
    render();
    expect(text()).toContain("The game buys the 2-train from the Bank Depot automatically");
  });

  it("either of two legal rescue portfolios may be sent; the redundant pair is refused in the authority's words", () => {
    for (const [ticker, total] of [["PRR", 100], ["NYC", 60]] as const) {
      mount(choice());
      choose(select(`Shares of ${ticker} to sell`), "10");
      const sell = button(`Sell the chosen shares together — $${total}`);
      expect(live(sell)).toBe(true);
      click(sell);
      expect(calls.portfolios).toHaveLength(1);
      expect(fundingOf(state).shortfall).toBe(0);
    }
    mount(choice());
    choose(select("Shares of PRR to sell"), "10");
    choose(select("Shares of NYC to sell"), "10");
    expect(live(button(/^Sell the chosen shares/))).toBe(false);
    expect(text()).toContain("Only enough may be sold");
  });

  it("a refused bundle is explained by the authority's own sentence", () => {
    mount(board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0", holdings: [[P1, 50], [P2, 30]], price: 90 },
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30]], price: 100 },
      ],
      cash: { [P1]: 0, [P2]: 300, [P3]: 300 },
    }));
    expect(Array.from(select("Shares of C&O to sell").options).map((option) => option.value)).toEqual(["0", "10", "20"]);
    expect(text()).toContain("Not every bundle is allowed: Selling 30% of C&O would hand its presidency to another player");
  });
});

describe("the modal: private funding", () => {
  it("exact relevance: the optional offer and ForgoPrivateFunding are offered; the portfolio alone cannot fund", () => {
    mount(privateOnly("160"));
    expect(fundingOf(state).automatic!.privateFunding).toBe("relevant");
    expect(text()).toContain("Offer a private company — optional");
    expect(text()).toContain("No share you hold can legally be sold right now.");
    const price = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Price for Private 2"]')!;
    choose(price, "79");
    expect(live(button("Offer"))).toBe(false);
    expect(text()).toContain("between $80 and $320");
    choose(price, "200");
    click(button("Offer"));
    expect(calls.offers).toEqual([[2, NYC, 200]]);
  });

  it("ForgoPrivateFunding: a prominent confirmation, one message, and the automatic bankruptcy", () => {
    mount(privateOnly("160"));
    click(button("Don't sell a private company"));
    const warning = dialog()!.querySelector('[role="alert"]')!;
    expect(warning.textContent).toContain("Warning: this ends the game in bankruptcy");
    const confirm = button("Decline private-company funding");
    click(confirm);
    click(confirm);
    expect(calls.forgoPrivates).toBe(1);
    expect(state.current_round_type).toBe("GameEnd");
    expect(state.bankrupt_president).toBe(P1);
  });

  it("no legal private rescue: no private section, no forgo, no wait -- the reducer does not wait for a fiction", () => {
    // Owner ruling 5 case A: the loose bound says $300, the exact law $150 < $180.
    const atHardware = boundOnly();
    expect(fundingOf(atHardware).automatic).toMatchObject({ privateFunding: "irrelevant", privateFundingUpperBound: 300, privateFundingMaximum: 150 });
    mount(atHardware);
    expect(text()).not.toContain("Offer a private company");
    expect(hasButton(/private company/i)).toBe(false);
    expect(text()).toContain("No legal rescue remains.");
    // And on the real path the game never stops here: entering Buy Trains ends it.
    expect(enter(boundOnly()).current_round_type).toBe("GameEnd");
  });

  it("a standing private offer: the seller may only withdraw; a president over the buyer answers here", () => {
    mount(apply(privateOnly("160"), OFFER(2, NYC, 200), P1));
    expect(text()).toContain("Waiting on Bob");
    expect(hasButton(/^Sell/)).toBe(false);
    expect(hasButton(/^Don/)).toBe(false);
    click(button("Withdraw offer"));
    expect(calls.rescindPrivates).toEqual([2]);
  });
});

describe("the modal: the automatic purchase and the automatic bankruptcy", () => {
  it("a fully funded purchase requires no click: a status, and no button that sends anything", () => {
    mount(funded());
    expect(fundingOf(state).automatic!.autoPurchase).toBe(true);
    expect(text()).toContain("Funded.");
    expect(text()).toContain("C&O pays $30 and you pay $50");
    expect(text()).toContain("There is nothing to press.");
    expect(buttons()).toHaveLength(0);
  });

  it("the derived bankruptcy is shown as the game's result, with no control", () => {
    mount(insolvent());
    expect(text()).toContain("No legal rescue remains.");
    expect(text()).toContain("Bankruptcy is automatic");
    expect(buttons()).toHaveLength(0);
  });

  it("the ended board carries no obligation: the modal and the waiting card unmount, and the shell reads the ending", () => {
    const ended = enter(insolvent());
    expect(ended.current_round_type).toBe("GameEnd");
    expect(ended.bankrupt_president).toBe(P1);
    expect(emergencyFundingFor(ended, CORRIDOR)).toBeNull();
    mount(ended);
    expect(dialog()).toBeNull();
    const app = readShell();
    expect(app).toContain('if (gameState?.current_round_type === "GameEnd" && gameState.bankrupt_president) return "bankruptcy";');
    expect(app).toContain("if (!gameState || !emergencyPurchasePlan || emergencyForPresident) return null;");
  });
});

describe("reload and the no-server path never duplicate the automatic purchase", () => {
  it("the forwarding is W3-K's alone: sent once per key, and a fresh client on the bought board owes nothing", () => {
    const owedBoard = funded();
    const emitted = new Set<string>();
    const owed = noServerDerivedToSend({ state: owedBoard, mapGrid: CORRIDOR, emitted, isMyTurn: true })!;
    expect(owed.key).toMatch(/^emergency-purchase:/);
    emitted.add(owed.key);
    expect(noServerDerivedToSend({ state: owedBoard, mapGrid: CORRIDOR, emitted, isMyTurn: true })).toBeNull();
    // A reload: a fresh surface on the same funded board still has nothing to press.
    mount(owedBoard);
    expect(buttons()).toHaveLength(0);
    mount(owedBoard);
    expect(buttons()).toHaveLength(0);
    const bought = apply(owedBoard, owed.msg, P1);
    expect(emergencyFundingFor(bought, CORRIDOR)).toBeNull();
    expect(noServerDerivedToSend({ state: bought, mapGrid: CORRIDOR, emitted: new Set(), isMyTurn: true })).toBeNull();
    // The shell has exactly one forwarding site and never dispatches the purchase itself.
    const app = readShell();
    expect(app.split("noServerDerivedToSend(").length - 1).toBe(1);
    expect(app).not.toMatch(/EmergencyBuyHardware: \{/);
  });
});

describe("the modal: the double-send latch", () => {
  it("one press sends once, and every control greys while it waits", () => {
    mount(twoHoldings(), { onSellPortfolio: (legs) => calls.portfolios.push(legs) }); // the board does not move
    choose(select("Shares of PRR to sell"), "10");
    choose(select("Shares of NYC to sell"), "10");
    const sell = button(/^Sell the chosen shares/);
    click(sell);
    click(sell);
    expect(calls.portfolios).toHaveLength(1);
    expect(live(button(/^Sell the chosen shares/))).toBe(false);
    expect(text()).toContain("Sending your last action — one moment.");
  });

  it("greys every send while the shell reports one in flight, and releases after", () => {
    mount(privateOnly("160"));
    inFlight = true;
    render();
    expect(live(button("Offer"))).toBe(false);
    expect(live(button("Don't sell a private company"))).toBe(false);
    inFlight = false;
    render();
    expect(live(button("Offer"))).toBe(true);
  });

  it("the forgo confirmation cannot send twice", () => {
    mount(funded(["2"]), { onForgoTrainTrade: () => { calls.forgoTrades += 1; } });
    click(button(/instead$/));
    const confirm = button("Buy from the Bank Depot");
    click(confirm);
    click(confirm);
    expect(calls.forgoTrades).toBe(1);
  });
});

describe("a legacy (revision-1) board", () => {
  it("presents no v12 manual control at all", () => {
    mount({ ...twoHoldings(), variants: { rules: 1 }, rules_engine_version: 12 } as GameStateResponse);
    expect(text()).toContain("before automatic emergency funding");
    expect(buttons()).toHaveLength(0);
  });
});

/* ================================================================== */
/*  W2-A holds                                                         */
/* ================================================================== */

describe("W2-A: the funding hold greys the dock for every seat and lets exactly the surface's decisions through", () => {
  it("the dock's own moves grey with the hold's sentence while the obligation stands", () => {
    const view = dockHoldView({ state: twoHoldings(), mapGrid: CORRIDOR, labelFor: label });
    expect(view.turnHoldReason).toContain("C&O must buy a 2-train ($80) and cannot pay for it");
    expect(view.pass).toBe(view.turnHoldReason);
  });

  it("every message the surface sends passes the hold; the old ones the surface no longer sends are not needed", () => {
    const hold = (current: GameStateResponse, msg: unknown) => authoritativeHoldRefusal(current, msg as never, { mapGrid: CORRIDOR });
    expect(hold(twoHoldings(), PORTFOLIO([NYC, 10], [PRR, 10]))).toBeNull();
    expect(hold(funded(["2"]), FORGO_TRADE)).toBeNull();
    expect(hold(privateOnly("160"), FORGO_PRIVATE)).toBeNull();
    expect(hold(privateOnly("160"), OFFER(2, NYC, 200))).toBeNull();
    // While a private offer stands, the hold admits only its answer and withdrawal -- which is all the surface shows.
    const offered = apply(privateOnly("160"), OFFER(2, NYC, 200), P1);
    expect(hold(offered, FORGO_PRIVATE)).toContain("is on offer to NYC");
    expect(hold(offered, PORTFOLIO([NYC, 10]))).toContain("is on offer to NYC");
    expect(hold(offered, { RescindFundingPrivateOffer: { game_id: 1, private_id: 2 } })).toBeNull();
  });
});

/* ================================================================== */
/*  The waiting card                                                   */
/* ================================================================== */

describe("the waiting card: W2-H's read-only status for everybody else", () => {
  it("renders the sentence in the waiting surface, focusable, with no control", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    layerRoot = createRoot(document.createElement("div"));
    mounted = true;
    act(() => root.render(<EmergencyPurchaseWaitingCard sentence="C&O is resolving an emergency train purchase — waiting on Alice." />));
    const card = host.querySelector(`[${WAITING_STATUS_ATTRIBUTE}]`)!;
    expect(card).not.toBeNull();
    expect(card.getAttribute("tabindex")).toBe("0");
    expect(card.querySelector('[role="status"]')!.textContent).toBe("C&O is resolving an emergency train purchase — waiting on Alice.");
    expect(host.querySelectorAll("button, input, select")).toHaveLength(0);
    act(() => root.render(<EmergencyPurchaseWaitingCard sentence={null} />));
    expect(host.innerHTML).toBe("");
  });
});

/* ================================================================== */
/*  The shell's wiring                                                 */
/* ================================================================== */

describe("the shell's wiring", () => {
  const app = readShell();

  it("mounts the workflow for the obligated president alone, and the waiting card for everybody else", () => {
    expect(app).toContain("emergencyViewerIsPresident({ spectator, president: emergencyPurchasePlan.presidentAddress, viewerAddress })");
    expect(app).toContain("const emergencyModalPlan = emergencyForPresident ? emergencyPurchasePlan : null;");
    expect(app).toContain("<EmergencyPurchaseWaitingCard sentence={emergencyWaiting} />");
    expect(app).toMatch(/const emergencyForPresident =\s*sandbox &&/);
  });

  it("has no opener and no dismissal", () => {
    expect(app).not.toContain("setEmergencyModalOpen");
    expect(app).not.toContain("onEmergencyPurchase:");
  });

  it("sends exactly the v13 decisions, each judged by the authority", () => {
    expect(app).toContain("ForgoTrainTrade: { game_id: gameId }");
    expect(app).toContain("ForgoPrivateFunding: { game_id: gameId }");
    expect(app).toContain("EmergencySellPortfolio: { game_id: gameId, sales:");
    expect(app).toContain("forgoTrainTradeRefusal(gameState, emergencyFunding, viewerAddress)");
    expect(app).toContain("forgoPrivateFundingRefusal(gameState, emergencyFunding, viewerAddress)");
    expect(app).toContain("portfolioVerdictFor(gameState, emergencyFunding, viewerAddress, draft)");
    expect(app).toContain("intercorporateStepFor(gameState, emergencyFunding, mapGrid, viewerAddress)");
    expect(app).toContain("fundingOfferDraftRefusal(gameState, emergencyFunding, viewerAddress, draft)");
    expect(app).toContain("actionInFlight={actionInFlight}");
  });
});
