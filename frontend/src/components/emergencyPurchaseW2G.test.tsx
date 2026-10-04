/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W2-G (harness): THE GUIDED, NON-DISMISSIBLE EMERGENCY TRAIN PURCHASE
// ==================================================================
//
// The owner's ruling (OD-4, OD-1 viewer scope), case by case, on REAL boards judged by the REAL authority
// (`emergencyFundingFor`, `proposeTrainPurchaseRefusal`, `fundingPrivateOfferRefusal`, ...) -- the view helper and the
// modal are given what the shell gives them, and every sale the harness "makes" is a real `SellStock` through the
// reducer, so "updates after every actual sale" is a property of the authority's next answer, not of a mock.
//
//   president / other seat / watcher        viewer scope; non-presidents never see a funding or bankruptcy control
//   treasury-only figures                   the treasury is applied automatically; a president with no cash
//   treasury + president cash               both applied automatically, shown as figures, the buy label names them
//   share-sale shortfall                    legal bundles only; one actual sale per press; re-read after it
//   optional private funding                legality from `fundingPrivateOfferRefusal`; labelled optional
//   intercorporate step                     first; the authority's candidates; offer / direct buy; withdrawal
//   Skip consequence                        notice, and PROMINENT when no share sale can fund the Bank purchase
//   no dismiss / escape                     `closedby="none"`, no close control, no `onClose`
//   double-send latch                       one press, one message; greyed while a send is in flight
//   Bank vs Bank Pool                       from the required train's actual source (K-25)

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
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { emergencyFundingFor, emergencyPurchaseRefusal, type EmergencyFunding } from "../gameEngine/emergencyFunding";
import { STATIC_BOARD_HEXES } from "./hexBoardData";
import {
  emergencyViewerIsPresident,
  emergencyWaitingSentence,
  fundingAnswerRefusalForViewer,
  fundingOfferDraftRefusal,
  intercorporateOfferRefusal,
  intercorporateStepFor,
  skipConsequenceFor,
  trainSourceName,
} from "../utils/emergencyPurchaseView";
import { readShell, readStripped } from "../utils/sourceScan";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "./hexContractTypes";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ */
/* Boards (the `emergencyFunding.test.ts` shape: a corridor C&O can run) */
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
const ERIE = 3;
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
  price: number;
  x?: number;
  y?: number;
}

function board(input: {
  corps: Corp[];
  cash: Record<string, number>;
  returned?: string[];
  privates?: Array<{ private_id: number; owner: string; cost: string }>;
}): GameStateResponse {
  const order = input.corps.map((corp) => corp.id);
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
    active_corporation_index: order.indexOf(CO),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: "Hardware",
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
      bank_pool_percentage: 0,
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

/** Phase 2: nobody owns a train, so the required train is the 2 at $80 from the Bank Depot. C&O (Alice) holds $30;
 *  Alice holds shares in C&O, NYC ($100) and PRR ($50). */
function phaseTwo(over: Partial<{ treasury: string; cash: number; returned: string[] }> = {}) {
  return board({
    returned: over.returned,
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: over.treasury ?? "30", holdings: [[P1, 60], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "500", holdings: [[P2, 30], [P1, 20]], price: 100, x: 8, y: 8 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "500", holdings: [[P3, 40], [P1, 10]], price: 50, x: 3 },
    ],
    cash: { [P1]: over.cash ?? 20, [P2]: 300, [P3]: 300 },
  });
}

/** Phase 3 (NYC owns a 3, so the required train is the 3 at $180). C&O holds `treasury`; Alice holds only C&O's
 *  president block, so no share sale is legal; ERIE (also Alice's) owns a 2; Alice owns private 2 (face $160). */
function phaseThree(over: Partial<{ treasury: string; cash: number; aliceHoldsNyc: boolean; privates: Array<{ private_id: number; owner: string; cost: string }> }> = {}) {
  return board({
    corps: [
      { id: CO, ticker: "C&O", president: P1, trains: [], treasury: over.treasury ?? "0", holdings: [[P1, 20], [P2, 20]], price: 90 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3"], treasury: "500", holdings: over.aliceHoldsNyc ? [[P2, 30], [P1, 20]] : [[P2, 30]], price: 100, x: 8, y: 8 },
      { id: PRR, ticker: "PRR", president: P3, trains: [], treasury: "100", holdings: [[P3, 40]], price: 50, x: 3 },
      { id: ERIE, ticker: "ERIE", president: P1, trains: ["2"], treasury: "300", holdings: [[P1, 20]], price: 70, x: 4 },
    ],
    cash: { [P1]: over.cash ?? 0, [P2]: 300, [P3]: 300 },
    privates: over.privates ?? [{ private_id: 2, owner: P1, cost: "160" }],
  });
}

const apply = (state: GameStateResponse, msg: unknown, actor: string) =>
  applySandboxAction(state, msg as never, { actor, mapGrid: CORRIDOR });
const fundingOf = (state: GameStateResponse) => emergencyFundingFor(state, CORRIDOR)!;
const planOf = (state: GameStateResponse): EmergencyPurchasePlan =>
  buildEmergencyPurchasePlan({ funding: fundingOf(state), labelForAddress: label });

/* ================================================================== */
/*  The view helper, against the authority                             */
/* ================================================================== */

describe("viewer scope (OD-1)", () => {
  it("gives the workflow to the obligated president's own screen only", () => {
    expect(emergencyViewerIsPresident({ spectator: false, president: P1, viewerAddress: P1 })).toBe(true);
    expect(emergencyViewerIsPresident({ spectator: false, president: P1, viewerAddress: P2 })).toBe(false); // another seat
    expect(emergencyViewerIsPresident({ spectator: false, president: P1, viewerAddress: "" })).toBe(false); // a watcher
    expect(emergencyViewerIsPresident({ spectator: true, president: P1, viewerAddress: P1 })).toBe(false); // spectate mode
    expect(emergencyViewerIsPresident({ spectator: false, president: "", viewerAddress: "" })).toBe(false);
  });

  it("tells everybody else, in one sentence, who the table is waiting on", () => {
    const base = { ticker: "PRR", presidentLabel: "Alice", privateOffer: null, trainOffer: null };
    expect(emergencyWaitingSentence(base)).toBe("PRR is resolving an emergency train purchase — waiting on Alice.");
    expect(
      emergencyWaitingSentence({ ...base, privateOffer: { privateName: "Camden & Amboy", buyerTicker: "NYC", buyerPresidentLabel: "Bob" } }),
    ).toBe("PRR is resolving an emergency train purchase — Camden & Amboy is on offer to NYC; waiting on Bob.");
    expect(
      emergencyWaitingSentence({ ...base, trainOffer: { sellerTicker: "NYC", model: "3", price: "120", sellerPresidentLabel: "Bob", accepted: false } }),
    ).toBe("PRR is resolving an emergency train purchase — it has offered $120 for NYC's 3-train; waiting on Bob.");
  });
});

describe("Bank vs Bank Pool (K-25)", () => {
  it("names the required train's actual source", () => {
    expect(trainSourceName("depot")).toBe("Bank Depot");
    expect(trainSourceName("pool")).toBe("Bank Pool");
    expect(planOf(phaseTwo()).trainSourceName).toBe("Bank Depot");
    // A 2 in the Bank Pool at the same $80: the pool is taken first on a tie (#1512), and the surface says so.
    const pooled = phaseTwo({ returned: ["2"] });
    expect(fundingOf(pooled).train.source).toBe("pool");
    expect(planOf(pooled).trainSourceName).toBe("Bank Pool");
  });
});

describe("the intercorporate step reads the authority", () => {
  it("lists every candidate with the authority's verdict, and judges each composed offer at its own price", () => {
    const state = phaseThree({ treasury: "100", cash: 50 });
    const funding = fundingOf(state);
    const step = intercorporateStepFor(state, funding, CORRIDOR, P1);
    expect(step.legal.map((option) => [option.sellerTicker, option.model, option.faceValue])).toEqual([
      ["NYC", "3", 180],
      ["ERIE", "2", 80],
    ]);
    expect(step.treasury).toBe(100);
    expect(step.presidentCash).toBe(50);
    const nyc = step.legal[0];
    // The treasury pays $100; above that Alice contributes, up to $150 together (owner-defined simplification).
    expect(intercorporateOfferRefusal(state, funding, CORRIDOR, P1, { sellerId: NYC, model: "3", price: "120" })).toBeNull();
    expect(intercorporateOfferRefusal(state, funding, CORRIDOR, P1, { sellerId: NYC, model: "3", price: "160" })).toContain("hold $150 together");
    expect(intercorporateOfferRefusal(state, funding, CORRIDOR, P1, { sellerId: NYC, model: "3", price: "" })).toBe("Enter a price.");
    expect(intercorporateOfferRefusal(state, funding, CORRIDOR, P1, { sellerId: NYC, model: "3", price: "1e2" })).toContain("whole number");
    expect(nyc.sellerPresident).toBe(P2);
    // ERIE is Alice's too: the same president over both, so the shell buys directly.
    expect(step.legal[1].sellerPresident).toBe(P1);
    // Another seat is refused for every candidate, in the authority's words.
    const asBob = intercorporateStepFor(state, funding, CORRIDOR, P2);
    expect(asBob.legal).toEqual([]);
    expect(asBob.options[0].refusal).toContain("Only C&O's president");
  });

  it("reports the corporation's standing offer and who may withdraw it", () => {
    const state = phaseThree({ treasury: "100", cash: 50 });
    const offered = apply(
      state,
      { ProposeTrainPurchase: { game_id: 1, seller_protocol_id: NYC, seller_ticker: "NYC", seller_president: P2, buyer_protocol_id: CO, buyer_ticker: "C&O", model_type: "3", price: "120" } },
      P1,
    );
    expect(offered.train_purchase_offer).toMatchObject({ seller_protocol_id: NYC, buyer_protocol_id: CO });
    const funding = fundingOf(offered);
    const step = intercorporateStepFor(offered, funding, CORRIDOR, P1);
    expect(step.standingOffer).toMatchObject({ seller_protocol_id: NYC, price: "120" });
    expect(step.standingOfferAnswerer).toBe(P2);
    expect(step.rescindRefusal).toBeNull();
    expect(intercorporateStepFor(offered, funding, CORRIDOR, P2).rescindRefusal).toContain("Only C&O's president");
    // One offer at a time: nothing else is legal while it stands.
    expect(step.legal).toEqual([]);
  });
});

describe("the Skip consequence", () => {
  it("states what Skip commits to, from the authority's figures", () => {
    const funded = fundingOf(phaseTwo({ cash: 100 })); // $30 treasury + $50 of $100 cash covers the $80 train
    expect(funded.canPurchase).toBe(true);
    expect(skipConsequenceFor(funded, "Alice")).toEqual({
      severity: "notice",
      text: "If you skip, C&O pays its whole treasury ($30) and Alice pays $50 of personal cash toward the 2-train ($80) from the Bank Depot.",
    });
    const short = skipConsequenceFor(fundingOf(phaseTwo()), "Alice"); // $30 + $20, $30 short, shares to sell
    expect(short.severity).toBe("notice");
    expect(short.text).toContain("$30 to raise by selling shares you are allowed to sell");
  });

  it("is PROMINENT when the authority already says no share sale can fund the Bank purchase", () => {
    const consequence = skipConsequenceFor(fundingOf(phaseThree()), "Alice");
    expect(consequence.severity).toBe("prominent");
    expect(consequence.text).toContain("no share you hold can legally be sold");
    expect(consequence.text).toContain("optional private-company sale");
    expect(consequence.text).toContain("faces bankruptcy");
  });
});

describe("the optional private sale's legality is `fundingPrivateOfferRefusal` (P3-N018)", () => {
  it("admits a legal offer and refuses with the authority's sentence otherwise", () => {
    const state = phaseThree();
    const funding = fundingOf(state);
    expect(fundingOfferDraftRefusal(state, funding, P1, { privateId: 2, buyerId: NYC, price: "200" })).toBeNull();
    expect(fundingOfferDraftRefusal(state, funding, P1, { privateId: 2, buyerId: NYC, price: "79" })).toContain("between $80 and $320");
    expect(fundingOfferDraftRefusal(state, funding, P1, { privateId: 2, buyerId: CO, price: "100" })).toContain("put aside for the train");
    expect(fundingOfferDraftRefusal(state, funding, P1, { privateId: 2, buyerId: PRR, price: "150" })).toContain("cannot pay $150");
    expect(fundingOfferDraftRefusal(state, funding, P2, { privateId: 2, buyerId: NYC, price: "200" })).toContain("Only C&O's president");
    expect(fundingOfferDraftRefusal(state, funding, P1, { privateId: 2, buyerId: NYC, price: "abc" })).toContain("whole number");
  });

  it("knows when the obligated president must answer their own offer (they preside over the buyer too)", () => {
    const state = phaseThree();
    const toNyc = apply(state, { OfferPrivateForFunding: { game_id: 1, private_id: 2, buyer_protocol_id: NYC, price: 200 } }, P1);
    expect(fundingAnswerRefusalForViewer(toNyc, CORRIDOR, P1)).toContain("Only NYC's president");
    expect(fundingAnswerRefusalForViewer(toNyc, CORRIDOR, P2)).toBeNull();
    const toErie = apply(state, { OfferPrivateForFunding: { game_id: 1, private_id: 2, buyer_protocol_id: ERIE, price: 200 } }, P1);
    expect(toErie.private_purchase_offer).toMatchObject({ buyer_protocol_id: ERIE });
    expect(fundingAnswerRefusalForViewer(toErie, CORRIDOR, P1)).toBeNull();
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
  sells: Array<[number, number]>;
  proposals: Array<[string, string]>;
  rescindTrades: number[];
  offers: Array<[number, number, number]>;
  rescindPrivates: number[];
  answers: Array<[number, boolean]>;
  confirms: number;
}
let calls: Calls;
let state: GameStateResponse;
let inFlight = false;

function freshCalls(): Calls {
  return { sells: [], proposals: [], rescindTrades: [], offers: [], rescindPrivates: [], answers: [], confirms: 0 };
}

/** The shell's wiring, reduced to what the modal needs: every prop computed from `state` by the real helpers. */
function propsFor(current: GameStateResponse, overrides: Partial<EmergencyTrainPurchaseModalProps> = {}): EmergencyTrainPurchaseModalProps {
  const funding: EmergencyFunding | null = emergencyFundingFor(current, CORRIDOR);
  const plan = funding ? buildEmergencyPurchasePlan({ funding, labelForAddress: label }) : null;
  return {
    plan,
    sandbox: true,
    actionInFlight: inFlight,
    labelForAddress: label,
    intercorporate: funding ? intercorporateStepFor(current, funding, CORRIDOR, P1) : null,
    intercorporateOfferRefusal: (draft) => (funding ? intercorporateOfferRefusal(current, funding, CORRIDOR, P1, draft) : "none"),
    onProposeTrade: (option, price) => calls.proposals.push([option.key, price]),
    onRescindTrade: (sellerId) => calls.rescindTrades.push(sellerId),
    /* A REAL sale through the reducer: the next render is the authority's next answer. */
    onSellShares: (companyId, percentage) => {
      calls.sells.push([companyId, percentage]);
      state = apply(state, { SellStock: { game_id: 1, protocol_id: companyId, percentage } }, P1);
    },
    privateOfferRefusal: (draft) => (funding ? fundingOfferDraftRefusal(current, funding, P1, draft) : "none"),
    onOfferPrivate: (privateId, buyer, price) => calls.offers.push([privateId, buyer, price]),
    onRescindPrivateOffer: (privateId) => calls.rescindPrivates.push(privateId),
    fundingAnswerRefusal: current.private_purchase_offer?.funding ? fundingAnswerRefusalForViewer(current, CORRIDOR, P1) : "none",
    onAnswerFundingOffer: (privateId, accept) => calls.answers.push([privateId, accept]),
    onConfirm: () => {
      calls.confirms += 1;
    },
    purchaseRefusal: funding ? emergencyPurchaseRefusal(current, funding.companyId, CORRIDOR, P1) : "none",
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
const click = (node: HTMLElement) => act(() => void node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const choose = (node: HTMLSelectElement | HTMLInputElement, value: string) =>
  act(() => {
    const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });

describe("the modal: no dismissal, no bankruptcy button", () => {
  it("cannot be closed or escaped", () => {
    mount(phaseTwo());
    const node = dialog()!;
    expect(node).not.toBeNull();
    expect(node.getAttribute("closedby")).toBe("none");
    expect(buttons().some((entry) => /close|cancel|dismiss|×/i.test(entry.textContent ?? ""))).toBe(false);
    // The engine's close request: refused by policy -- the dialog is still there with its content.
    act(() => void node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(dialog()).not.toBeNull();
    expect(text()).toContain("Emergency Train Purchase");
    expect(readStripped("components/EmergencyTrainPurchaseModal.tsx")).not.toContain("onClose");
  });

  it("never offers the player a bankruptcy control", () => {
    for (const board_ of [phaseTwo(), phaseThree(), phaseThree({ treasury: "100", cash: 50 })]) {
      mount(board_);
      expect(buttons().some((entry) => /bankrupt/i.test(entry.textContent ?? ""))).toBe(false);
    }
    const modal = readStripped("components/EmergencyTrainPurchaseModal.tsx");
    expect(modal).not.toContain("onDeclareBankruptcy");
    expect(modal).not.toMatch(/Declare bankruptcy/i);
  });
});

describe("the modal: the Bank purchase's automatic figures", () => {
  it("treasury only: the whole treasury is applied, the president holds no cash, the rest must be raised", () => {
    mount(phaseTwo({ cash: 0 })); // no train elsewhere, so straight to the Bank step
    expect(text()).toContain("2-train from the Bank Depot");
    expect(text()).toContain("C&O treasury — all of it");
    expect(text()).toContain("−$30");
    expect(text()).toContain("They hold no cash.");
    expect(text()).toContain("Still to raise by selling$50");
    // Nothing to type: no input on the Bank step's money rows.
    expect(dialog()!.querySelectorAll('input[aria-label*="cash" i], input[aria-label*="treasury" i]')).toHaveLength(0);
    const buy = button(/^Buy the 2-train/);
    expect(buy.hasAttribute("disabled")).toBe(true);
    // The authority's own refusal of the purchase, not a sentence of the modal's.
    expect(text()).toContain(emergencyPurchaseRefusal(state, CO, CORRIDOR, P1)!);
    expect(text()).toContain("$50 short; the president must sell shares first.");
  });

  it("treasury + president cash: both applied automatically and named on the button", () => {
    mount(phaseTwo({ cash: 100 }));
    expect(text()).toContain("Applied automatically, of $100 held.");
    const buy = button("Buy the 2-train — C&O pays $30, you pay $50");
    expect(buy.hasAttribute("disabled")).toBe(false);
    expect(text()).toContain("Your cash $100 → $50");
    click(buy);
    expect(calls.confirms).toBe(1);
  });
});

describe("the modal: share sales, one actual sale at a time", () => {
  it("offers only the authority's bundles, sells what was chosen, and re-reads the shortfall after the sale", () => {
    mount(phaseTwo()); // $30 short; C&O 10-40%, NYC 10-20%, PRR 10%
    const select = dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Certificates of NYC to sell"]')!;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(
      fundingOf(state).legalSales.find((sale) => sale.ticker === "NYC")!.bundles.map(String),
    );
    // Each row projects the president's cash after THAT sale against the authority's shortfall.
    expect(text()).toContain("Your cash $20 → $70 — covers the $30 needed");
    // Refused bundles are explained in the authority's own words (6.6.3 "only enough").
    expect(text()).toContain("Not every bundle is allowed: Only enough may be sold");
    const prrRow = dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Certificates of PRR to sell"]')!.closest("div")!;
    click(Array.from(prrRow.querySelectorAll("button")).find((node) => node.textContent === "Sell")!);
    expect(calls.sells).toEqual([[PRR, 10]]);
    render(); // the shell re-renders on the board the reducer produced
    // $50 came in against $30: the authority now says the purchase can (and must) be made.
    expect(fundingOf(state).shortfall).toBe(0);
    expect(text()).toContain("Still to raise by selling$0");
    expect(dialog()!.querySelector('select[aria-label^="Certificates of"]')).toBeNull();
    expect(button(/^Buy the 2-train — C&O pays \$30, you pay \$50$/).hasAttribute("disabled")).toBe(false);
  });

  it("after a sale that still leaves the corporation short, the next choice is made on the new board", () => {
    mount(phaseTwo({ treasury: "0", cash: 0 })); // $80 short
    expect(text()).toContain("Still to raise by selling$80");
    expect(text()).toContain("Your cash $0 → $50 — still $30 short");
    const prrRow = dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Certificates of PRR to sell"]')!.closest("div")!;
    click(Array.from(prrRow.querySelectorAll("button")).find((node) => node.textContent === "Sell")!);
    render();
    expect(calls.sells).toEqual([[PRR, 10]]);
    expect(text()).toContain("Still to raise by selling$30");
    expect(dialog()!.querySelector('select[aria-label="Certificates of PRR to sell"]')).toBeNull(); // nothing left to sell
    expect(text()).toContain("Your cash $50 → $150 — covers the $30 needed"); // NYC, re-read on the new board
  });

  it("states no static legality rule of its own", () => {
    const modal = readStripped("components/EmergencyTrainPurchaseModal.tsx");
    // The old hand-written rule about President's Certificates and the pool cap is gone; restrictions are the
    // authority's own sentences (`LegalForcedSale.restriction`).
    expect(modal).not.toContain("may only be sold when another player already holds");
    expect(modal).not.toContain("50% of its shares in the Bank Pool");
    expect(modal).toContain("sale.restriction");
  });
});

describe("the modal: the optional private sale", () => {
  it("is labelled optional and judged by `fundingPrivateOfferRefusal`", () => {
    mount(phaseThree()); // C&O and Alice hold $0: no traded train is affordable, so straight to the Bank step
    expect(text()).toContain("No train can be bought from another corporation right now");
    expect(text()).toContain("Offer a private company — optional");
    expect(text()).toContain("never required");
    const offer = button("Offer");
    expect(offer.hasAttribute("disabled")).toBe(false); // the default: NYC at the band's minimum, $80
    const price = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Price for Private 2"]')!;
    choose(price, "79");
    expect(button("Offer").hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("between $80 and $320");
    choose(price, "200");
    click(button("Offer"));
    expect(calls.offers).toEqual([[2, NYC, 200]]);
  });

  it("while the offer stands: the seller may withdraw; a president over the buyer answers here", () => {
    mount(apply(phaseThree(), { OfferPrivateForFunding: { game_id: 1, private_id: 2, buyer_protocol_id: NYC, price: 200 } }, P1));
    expect(text()).toContain("Waiting on");
    click(button("Withdraw offer"));
    expect(calls.rescindPrivates).toEqual([2]);
    mount(apply(phaseThree(), { OfferPrivateForFunding: { game_id: 1, private_id: 2, buyer_protocol_id: ERIE, price: 200 } }, P1));
    expect(text()).toContain("You preside over ERIE too");
    click(button("Accept for ERIE"));
    expect(calls.answers).toEqual([[2, true]]);
  });
});

describe("the modal: the intercorporate step comes first", () => {
  it("shows the authority's candidates, sends an offer, and only then the Bank", () => {
    mount(phaseThree({ treasury: "100", cash: 50 }));
    expect(text()).toContain("Step 1 — Buy from another corporation");
    expect(text()).not.toContain("Still to raise by selling");
    const train = dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Train to buy from another corporation"]')!;
    expect(Array.from(train.options).map((option) => option.textContent)).toEqual(["NYC — 3-train (face $180)", "ERIE — 2-train (face $80)"]);
    const price = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Price offered"]')!;
    choose(price, "160");
    expect(button("Offer $160").hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("hold $150 together");
    choose(price, "120");
    click(button("Offer $120"));
    expect(calls.proposals).toEqual([["2:3:-", "120"]]);
    // ERIE is Alice's: the button says it buys outright.
    choose(train, "3:2:-");
    expect(button("Buy for $120")).toBeTruthy();
  });

  it("shows the standing offer with its withdrawal, and no Bank purchase until it is answered", () => {
    mount(
      apply(
        phaseThree({ treasury: "100", cash: 50 }),
        { ProposeTrainPurchase: { game_id: 1, seller_protocol_id: NYC, seller_ticker: "NYC", seller_president: P2, buyer_protocol_id: CO, buyer_ticker: "C&O", model_type: "3", price: "120" } },
        P1,
      ),
    );
    expect(text()).toContain("Waiting on Bob to answer.");
    expect(buttons().some((node) => /^Skip/.test(node.textContent ?? ""))).toBe(false);
    expect(buttons().some((node) => /^Buy the/.test(node.textContent ?? ""))).toBe(false);
    click(button("Withdraw offer"));
    expect(calls.rescindTrades).toEqual([NYC]);
  });

  it("goes straight to the Bank, saying why, when no train can be bought from another corporation", () => {
    mount(phaseTwo());
    expect(text()).not.toContain("Step 1");
    expect(text()).toContain("No other corporation owns a train");
  });
});

describe("the modal: Skip warns before it commits", () => {
  it("an ordinary notice, then the Bank step", () => {
    mount(phaseThree({ treasury: "100", cash: 50, aliceHoldsNyc: true }));
    // $150 against $180, and Alice may sell NYC: an ordinary notice of what Skip commits to.
    expect(fundingOf(state).legalSales.length).toBeGreaterThan(0);
    click(button(/^Skip — buy from the Bank Depot$/));
    const warning = dialog()!.querySelector('[role="alert"]')!;
    expect(warning).not.toBeNull();
    expect(warning.textContent).toContain("If you skip, C&O pays its whole treasury ($100)");
    // Back returns to the step; nothing was sent.
    click(button("Back"));
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
    click(button(/^Skip — buy from the Bank Depot$/));
    click(button("Skip and continue"));
    expect(text()).toContain("Buy from the Bank Depot");
    expect(text()).not.toContain("Step 1 — Buy from another corporation");
  });

  it("PROMINENT when no share sale can fund the Bank purchase", () => {
    mount(phaseThree({ treasury: "100", cash: 50 })); // no legal share sale; a private could still be offered
    click(button(/^Skip — buy from the Bank Depot$/));
    const warning = dialog()!.querySelector('[role="alert"]')!;
    expect(warning.textContent).toContain("Warning: this risks bankruptcy");
    expect(warning.textContent).toContain("no share you hold can legally be sold");
  });
});

describe("the modal: the double-send latch", () => {
  it("one press sends once, and nothing is live while a send is in flight", () => {
    mount(phaseTwo({ cash: 100 }));
    const buy = button(/^Buy the 2-train/);
    click(buy);
    click(buy);
    expect(calls.confirms).toBe(1);
    expect(button(/^Buy the 2-train/).hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("Sending your last action — one moment.");
  });

  it("greys every send while the shell reports one in flight", () => {
    mount(phaseTwo());
    inFlight = true;
    render();
    for (const node of buttons().filter((entry) => entry.textContent === "Sell")) {
      expect(node.hasAttribute("disabled")).toBe(true);
    }
    inFlight = false;
    render();
    expect(buttons().filter((entry) => entry.textContent === "Sell").every((node) => !node.hasAttribute("disabled"))).toBe(true);
  });

  it("releases once the board answers the press", () => {
    mount(phaseTwo());
    const nycRow = dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Certificates of NYC to sell"]')!.closest("div")!;
    const sell = Array.from(nycRow.querySelectorAll("button")).find((node) => node.textContent === "Sell")!;
    click(sell);
    click(sell);
    expect(calls.sells).toHaveLength(1);
    render(); // the board after the sale
    expect(text()).not.toContain("Sending your last action");
  });
});

describe("the waiting card: read-only for everybody else", () => {
  it("renders the sentence and no control", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    layerRoot = createRoot(document.createElement("div"));
    mounted = true;
    act(() => root.render(<EmergencyPurchaseWaitingCard sentence="C&O is resolving an emergency train purchase — waiting on Alice." />));
    const card = host.querySelector('[role="status"]')!;
    expect(card.textContent).toBe("C&O is resolving an emergency train purchase — waiting on Alice.");
    expect(host.querySelectorAll("button, input, select")).toHaveLength(0);
    act(() => root.render(<EmergencyPurchaseWaitingCard sentence={null} />));
    expect(host.innerHTML).toBe("");
  });
});

describe("the shell's wiring", () => {
  const app = readShell();

  it("mounts the workflow for the obligated president alone, and the waiting card for everybody else", () => {
    expect(app).toContain("emergencyViewerIsPresident({ spectator, president: emergencyPurchasePlan.presidentAddress, viewerAddress })");
    expect(app).toContain("const emergencyModalPlan = emergencyForPresident ? emergencyPurchasePlan : null;");
    expect(app).toContain("<EmergencyPurchaseWaitingCard sentence={emergencyWaiting} />");
    expect(app).toContain("if (!gameState || !emergencyPurchasePlan || emergencyForPresident) return null;");
  });

  it("has no opener, no dismissal and no bankruptcy dispatch", () => {
    expect(app).not.toContain("setEmergencyModalOpen");
    expect(app).not.toContain("onDeclareBankruptcy");
    expect(app).not.toMatch(/DeclareBankruptcy: \{/);
  });

  it("asks the authority for every legality it shows", () => {
    expect(app).toContain("intercorporateStepFor(gameState, emergencyFunding, mapGrid, viewerAddress)");
    expect(app).toContain("intercorporateOfferRefusal(gameState, emergencyFunding, mapGrid, viewerAddress, draft)");
    expect(app).toContain("fundingOfferDraftRefusal(gameState, emergencyFunding, viewerAddress, draft)");
    expect(app).toContain("actionInFlight={actionInFlight}");
    expect(app).toContain("emergencyPurchaseRefusal(gameState, emergencyModalPlan.corporationId, mapGrid, viewerAddress)");
  });

  it("never opens the unclosable surface where none of its sends could go (the contract path)", () => {
    expect(app).toMatch(/const emergencyForPresident =\s*sandbox &&/);
  });
});
