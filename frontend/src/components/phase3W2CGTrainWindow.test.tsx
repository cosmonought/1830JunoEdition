/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 WAVE-2 B+C+G INTEGRATION: W2-C's TRAIN ROSTER OVER W3-K / W2-G's v13 EMERGENCY TRADE WINDOW
// ==================================================================
//
// The residue the Wave-2A v13 verification recorded as R1: on a revision-2 board the corporate train roster's Propose
// stayed live after the emergency trade window closed, because the panel asked only W2-A's hold (which lets
// `ProposeTrainPurchase` through) and never the sale's own authority. W2-C binds the roster to
// `proposeTrainPurchaseRefusal` / `trainSaleRefusal` (`utils/offerAuthorityView.ts`); on v13 that predicate reaches
// `fundedTradeRefusal`, which refuses once the window is closed. This suite proves the two together on the integrated
// tree, with the REAL reducer closing the window and the REAL panel rendered exactly as the shell binds it:
//
//   OPEN WINDOW     a legal candidate is offered and sent (one proposal, the canonical price)
//   CLOSED WINDOW   closed by ForgoTrainTrade, and closed by liquidation (EmergencySellPortfolio): no badge and no
//                   submit is usable, nothing is sent, and the sentence shown IS the authority's (no local window test)
//
// Every board is a rules-revision-2 (v13) board in the shapes of `emergencyPurchaseW2G.test.tsx`.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import TrainPurchasePanel, { type TrainPurchaseCompany, type TrainTradeProposal } from "./TrainPurchasePanel";
import { STATIC_BOARD_HEXES } from "./hexBoardData";
import type { MapGridResponse } from "./hexContractTypes";
import type { GameStateResponse } from "../gameEngine/gameState";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { marketCellForPrice } from "../gameEngine/marketGeometry";
import { depotInventory, openDepotTiers } from "../gameEngine/gamePhase";
import { emergencyFundingFor } from "../gameEngine/emergencyFunding";
import { proposeTrainPurchaseRefusal } from "../gameEngine/trainSaleAuthority";
import { dockHoldView } from "../utils/dockHoldView";
import { trainOfferRefusal } from "../utils/offerAuthorityView";
import { readShell, readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ */
/* v13 boards                                                          */
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

const CO = 5; // the corporation that owes a train
const NYC = 2;
const PRR = 1;
const P1 = "p1"; // C&O's president
const P2 = "p2"; // NYC's president
const P3 = "p3";
const NAMES: Record<string, string> = { [P1]: "Alice", [P2]: "Bob", [P3]: "Cara" };
const labelFor = (address: string) => NAMES[address] ?? address;
const noop = () => undefined;

interface Corp {
  id: number;
  ticker: string;
  president: string;
  trains: string[];
  treasury: string;
  holdings: Array<[string, number]>;
  price: number;
}

const cell = (price: number) => marketCellForPrice(price)!;

function board(corps: Corp[], cash: Record<string, number>): GameStateResponse {
  const order = corps.map((corp) => corp.id);
  return {
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: String(cash[player] ?? 0) })),
    virtual_bank_vgp: "10000",
    variants: { rules: 2 },
    rules_engine_version: 13,
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(CO),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: "Hardware",
    market_positions: Object.fromEntries(
      corps.map((corp, index) => [corp.id, { price: corp.price, x: cell(corp.price).x, y: cell(corp.price).y, enteredAt: index + 1 }]),
    ),
    public_companies: corps.map((corp) => ({
      company_id: corp.id, ticker: corp.ticker, is_floated: true, president: corp.president, par_value: String(corp.price),
      ipo_pool_percentage: 0, bank_pool_percentage: 0, treasury: corp.treasury, owned_trains: corp.trains,
      player_holdings: corp.holdings.map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [[H16.q, H16.r]], station_tokens: [[H16.q, H16.r, 0]], station_token_limit: 3, home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

/** Treasury $30 + Alice's $100 cover the $80 2-train; NYC (Bob) owns a 2-train: the window is open. */
const funded = () =>
  board(
    [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "30", holdings: [[P1, 60], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "500", holdings: [[P2, 30], [P1, 20]], price: 100 },
    ],
    { [P1]: 100, [P2]: 300, [P3]: 300 },
  );

/** Treasury $30, Alice $0: $50 short of the $80 2-train. NYC (Bob) owns a 2-train (the window is open: up to $30 from
 *  the treasury), and Alice's PRR 10% ($100) is a legal rescue -- selling it closes the window (owner ruling, OD-4). */
const liquidatable = () =>
  board(
    [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "30", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "500", holdings: [[P2, 30], [P1, 10]], price: 60 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 10]], price: 100 },
    ],
    { [P1]: 0, [P2]: 300, [P3]: 300 },
  );

const providers = sandboxReplayProviders();
/** The reducer exactly as `RoomEngine` hands it a message. */
const apply = (state: GameStateResponse, msg: unknown, actor: string) =>
  applySandboxAction(state, msg as never, {
    actor, mapGrid: CORRIDOR, ...providers.chartInjections(state),
    marketContext: providers.marketContext(state, msg as never, actor), parCellFor: providers.parCellFor,
  });
const automaticOf = (state: GameStateResponse) => emergencyFundingFor(state, CORRIDOR)?.automatic ?? null;
const FORGO_TRADE = { ForgoTrainTrade: { game_id: 1 } };
const SELL_PRR_10 = { EmergencySellPortfolio: { game_id: 1, sales: [{ protocol_id: PRR, percentage: 10 }] } };

/** The authority's own answer for C&O offering for NYC's 2-train at `price`, as Alice. */
const authority = (state: GameStateResponse, price: string) =>
  proposeTrainPurchaseRefusal(
    state,
    { seller_protocol_id: NYC, buyer_protocol_id: CO, model_type: "2", price },
    P1,
    CORRIDOR,
  );

/* ------------------------------------------------------------------ */
/* The panel, bound exactly as the shell binds it                       */
/* ------------------------------------------------------------------ */

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const textOf = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
const live = (button: HTMLButtonElement) => !button.disabled;
const press = (button: HTMLButtonElement) => act(() => button.click());
const typeInto = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const sellerBadges = (ticker: string): HTMLButtonElement[] => {
  const rows = Array.from(host.querySelectorAll("div")).filter(
    (node) => node.querySelector("button") !== null && textOf(node).startsWith(ticker),
  );
  const row = rows[rows.length - 1];
  if (!row) throw new Error(`no roster row for ${ticker}`);
  return Array.from(row.querySelectorAll<HTMLButtonElement>("button"));
};
const submits = () =>
  Array.from(host.querySelectorAll("button")).filter((button) => /^(Buy Now|Send Offer)$/.test(textOf(button)));
const priceInput = () => host.querySelector<HTMLInputElement>("#trade-price");

/** `TrainPurchasePanel` for C&O on `state`, with the hold (W2-A, `dockHoldView`) and the sale's authority (W2-C,
 *  `trainOfferRefusal`) bound the way `App.tsx` binds them. */
function mountRoster(state: GameStateResponse, sent: TrainTradeProposal[]) {
  const companies = state.public_companies as unknown as TrainPurchaseCompany[];
  const hold = dockHoldView({ state, mapGrid: CORRIDOR, labelFor });
  act(() =>
    root.render(
      <TrainPurchasePanel
        depot={depotInventory(state)}
        buyer={companies.find((entry) => entry.company_id === CO) ?? null}
        companies={companies}
        sessionReady
        canAct
        blockedReason={hold.proposeTrainPurchase}
        bankBlockedReason={hold.buyTrainFromBank}
        onBuyFromBank={noop}
        openTiers={openDepotTiers(state)}
        onProposeTrade={(proposal) => sent.push(proposal)}
        offerRefusal={(offer) =>
          trainOfferRefusal({ state, actor: P1, buyerId: CO, mapGrid: CORRIDOR, labelFor }, offer)
        }
        labelForAddress={labelFor}
        defaultCorporateOpen
      />,
    ),
  );
  return hold;
}

/** Nothing usable: every NYC badge is dead, no submit is live, and pressing everything sends nothing. */
function expectNoUsableProposal(state: GameStateResponse, sent: TrainTradeProposal[]) {
  const sentence = authority(state, "1");
  expect(sentence).not.toBeNull();
  const badges = sellerBadges("NYC");
  expect(badges.length).toBeGreaterThan(0);
  for (const badge of badges) {
    expect(live(badge)).toBe(false);
    // The sentence is the authority's own (W2-C binds it; there is no local window test to disagree with it).
    expect(badge.title).toBe(sentence);
    press(badge);
  }
  for (const button of submits()) {
    expect(live(button)).toBe(false);
    press(button);
  }
  const input = priceInput();
  if (input) typeInto(input, "10");
  for (const button of submits()) expect(live(button)).toBe(false);
  expect(sent).toEqual([]);
}

/* ================================================================== */
describe("C+G: the corporate train roster follows the v13 emergency trade window through the sale's authority", () => {
  it("OPEN WINDOW: a legal candidate is offered and sent once, at the price the authority judged", () => {
    const state = funded();
    expect(automaticOf(state)).toMatchObject({ tradeWindow: "open" });
    expect(authority(state, "1")).toBeNull();
    expect(authority(state, "30")).toBeNull();
    const sent: TrainTradeProposal[] = [];
    const hold = mountRoster(state, sent);
    // W2-A's hold lets the proposal through on this board -- the window is the sale authority's to judge.
    expect(hold.proposeTrainPurchase).toBeNull();
    const [two] = sellerBadges("NYC");
    expect(live(two)).toBe(true);
    press(two);
    const [submit] = submits();
    expect([textOf(submit), live(submit)]).toEqual(["Send Offer", true]);
    typeInto(priceInput()!, "30");
    expect(live(submits()[0])).toBe(true);
    press(submits()[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sellerProtocolId: NYC, buyerProtocolId: CO, modelType: "2", price: "30" });
  });

  it("CLOSED WINDOW (ForgoTrainTrade): no usable proposal; the badge carries fundedTradeRefusal's sentence", () => {
    const closed = apply(funded(), FORGO_TRADE, P1);
    // The obligation still stands (the derived purchase is owed) and the authority says the window is closed.
    expect(automaticOf(closed)).toMatchObject({ tradeWindow: "closed" });
    expect(authority(closed, "1")).toMatch(/has already chosen to fund the train through the Bank/);
    const sent: TrainTradeProposal[] = [];
    const hold = mountRoster(closed, sent);
    // W2-A's hold still passes ProposeTrainPurchase (the R1 shape): the closure is enforced by the sale authority alone.
    expect(hold.proposeTrainPurchase).toBeNull();
    expectNoUsableProposal(closed, sent);
  });

  it("CLOSED WINDOW (liquidation): after EmergencySellPortfolio the roster offers nothing, in the authority's words", () => {
    const open = liquidatable();
    expect(automaticOf(open)).toMatchObject({ tradeWindow: "open" });
    expect(authority(open, "30")).toBeNull();
    const closed = apply(open, SELL_PRR_10, P1);
    expect(automaticOf(closed)).toMatchObject({ tradeWindow: "closed" });
    // However much the liquidation raised, a liquidation-funded intercorporate purchase is illegal (owner rule).
    expect(authority(closed, "30")).toMatch(/has already chosen to fund the train through the Bank/);
    const sent: TrainTradeProposal[] = [];
    mountRoster(closed, sent);
    expectNoUsableProposal(closed, sent);
  });

  it("the panel and its binding hold no local window / emergency test (the UI follows the authority)", () => {
    const panel = readStripped("components/TrainPurchasePanel.tsx");
    const binding = readStripped("utils/offerAuthorityView.ts");
    for (const source of [panel, binding]) {
      expect(source).not.toMatch(/trade_window_closed|tradeWindowClosed|emergencyTradeWindow|fundedTradeRefusal|emergencyFundingFor/);
    }
    expect(binding).toMatch(/proposeTrainPurchaseRefusal\(/);
    expect(binding).toMatch(/trainSaleRefusal\(/);
    // The shell hands the roster that binding (beside the hold), and the bar only forwards it.
    const shell = readShell();
    expect(shell).toMatch(/trainOfferRefusal\(offerAuthority, offer\)/);
    expect(shell).toMatch(/offerRefusal: trainOfferRefusalFor/);
    expect(shell).toMatch(/blockedReason: dockHold\.proposeTrainPurchase/);
    expect(readStripped("panels/ContextualActionBar.tsx")).toMatch(/offerRefusal=\{trainPurchase\.offerRefusal\}/);
  });
});
