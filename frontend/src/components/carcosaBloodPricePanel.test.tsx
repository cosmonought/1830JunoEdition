/** @jest-environment jsdom */
//
// ==================================================================
//  UR-4 (harness): THE NORMAL UI NAMES THE COPY, AND WARNS THE BUYER -- THE RENDERED HALF
// ==================================================================
//
// OD-UR-5(c) = 5c-2 made the copy part of the sale, and the authority now REFUSES an unnamed sale of a model the seller
// holds both gold-trimmed and ordinary (`trainSaleRefusal`). A legal ordinary action must not require a crafted
// message (Playtest Readiness gate), so the Buy Trains panel has to be able to send both copies: the gilded badge sends
// `gilded: true` (the Blood Price), an ordinary badge of the same model sends `gilded: false`, and a seller with no
// gilding sends no copy at all -- the unnamed sale every panel sent before UR-4, byte for byte.
// OD-UR-5(b): the warning names the BUYING corporation's price (1 Left, 1 Down) and shows only for the gilded copy; the
// consent prompt tells the seller which copy it is answering for. The board is the reducer's (UR-4's constructed phase-6
// table), and the assertions read the rendered DOM.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import TrainPurchasePanel, { TrainTradePrompt, type TrainPurchaseCompany, type TrainTradeProposal } from "./TrainPurchasePanel";
import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";
import { depotInventory, openDepotTiers } from "../gameEngine/gamePhase";
import { gildedSalePositions } from "../gameEngine/trainSaleAuthority";
import * as S from "../utils/yellowSignRunBoundSupport";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { CO, BO, NYC, P1, P3, urBoard, companyOf } = S;

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
const render = (node: React.ReactElement) => act(() => root.render(node));
const click = (node: Element | null | undefined) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const GILDED_6 = { is_carcosan: true, carcosan_trains: ["6"], ghost_trains: ["6"] } as Partial<PublicCompanyState>;

/** Phase 6: B&O (P1 presides it and C&O) holds a real 6 and the gilded 6; C&O buys at Purchase Trains. */
const mixed = (boExtra: Partial<PublicCompanyState> = GILDED_6) =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 1000 },
      { id: BO, president: P1, trains: ["6", "6"], extra: boExtra },
      { id: NYC, president: P3, trains: ["5", "5"] },
    ],
    step: "Hardware",
    macro: 6,
  });

function renderPanel(state: GameStateResponse, onProposeTrade: (proposal: TrainTradeProposal) => void) {
  render(
    <TrainPurchasePanel
      depot={depotInventory(state)}
      buyer={companyOf(state, CO) as unknown as TrainPurchaseCompany}
      companies={state.public_companies as unknown as TrainPurchaseCompany[]}
      sessionReady
      canAct
      blockedReason={null}
      onBuyFromBank={() => undefined}
      openTiers={openDepotTiers(state)}
      onProposeTrade={onProposeTrade}
      labelForAddress={(address) => address}
      defaultCorporateOpen
    />,
  );
}

/** The seller roster row for `ticker`. */
function sellerBadges(ticker: string): HTMLButtonElement[] {
  const rows = Array.from(host.querySelectorAll("div")).filter(
    (node) => node.querySelector("button") !== null && (node.textContent ?? "").startsWith(ticker),
  );
  const row = rows[rows.length - 1];
  if (!row) throw new Error(`no roster row for ${ticker}`);
  return Array.from(row.querySelectorAll<HTMLButtonElement>("button"));
}
const warning = () => host.querySelector('[role="note"]')?.textContent ?? null;
const buyNow = () => Array.from(host.querySelectorAll("button")).find((node) => /^(Buy Now|Send Offer)$/.test(node.textContent ?? ""));

describe("the Buy Trains roster: one gold-trimmed badge, and each badge sends its own copy", () => {
  it("marks exactly the gilded copy (the chips' multiset order), and the gilded badge sends gilded: true", () => {
    const state = mixed();
    expect(gildedSalePositions(companyOf(state, BO))).toEqual([true, false]);
    const proposals: TrainTradeProposal[] = [];
    renderPanel(state, (proposal) => proposals.push(proposal));
    const badges = sellerBadges("B&O");
    expect(badges.map((badge) => badge.getAttribute("data-gilded"))).toEqual(["true", null]);
    click(badges[0]);
    expect(warning()).toMatch(/Buying the gold-trimmed Carcosa Train incurs a Blood Price/);
    expect(warning()).toMatch(/The buying\s+corporation's share price will immediately drop \(1 cell Left, 1 cell Down\)/);
    expect(warning()).not.toMatch(/selling/i);
    click(buyNow());
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ sellerProtocolId: BO, buyerProtocolId: CO, modelType: "6", gilded: true });
  });

  it("the ordinary badge of the same model sends gilded: false, with no Blood Price warning", () => {
    const proposals: TrainTradeProposal[] = [];
    renderPanel(mixed(), (proposal) => proposals.push(proposal));
    click(sellerBadges("B&O")[1]);
    expect(warning()).toBeNull();
    click(buyNow());
    expect(proposals[0]).toMatchObject({ sellerProtocolId: BO, modelType: "6", gilded: false });
  });

  it("a seller with no gilding: the badge sends no copy at all -- the unnamed sale, as before UR-4", () => {
    const proposals: TrainTradeProposal[] = [];
    renderPanel(mixed({}), (proposal) => proposals.push(proposal));
    const badges = sellerBadges("B&O");
    expect(badges.map((badge) => badge.getAttribute("data-gilded"))).toEqual([null, null]);
    click(badges[0]);
    expect(warning()).toBeNull();
    click(buyNow());
    expect("gilded" in proposals[0]).toBe(false);
  });
});

describe("the consent prompt tells the seller which copy it is answering for", () => {
  const proposal = (gilded?: boolean): TrainTradeProposal => ({
    sellerProtocolId: BO,
    sellerTicker: "B&O",
    sellerPresident: P3,
    sellerPresidentLabel: "p3",
    buyerProtocolId: CO,
    buyerTicker: "C&O",
    modelType: "6",
    price: "300",
    ...(gilded === undefined ? {} : { gilded }),
  });

  it("the gilded copy: the Blood Price, the BUYER's price drops, the seller is released", () => {
    render(<TrainTradePrompt proposal={proposal(true)} viewerIsSeller onAccept={() => undefined} onReject={() => undefined} />);
    const text = host.textContent ?? "";
    expect(text).toMatch(/C&O wants to buy the gold-trimmed 6-train from B&O/);
    expect(text).toMatch(/This is the Blood Price: C&O's share price will drop \(1 cell Left, 1 cell Down\)/);
    expect(text).toMatch(/B&O is released from the Carcosan curse/);
  });

  it("an ordinary copy: named as ordinary, no Blood Price; an unnamed offer reads as it always did", () => {
    render(<TrainTradePrompt proposal={proposal(false)} viewerIsSeller onAccept={() => undefined} onReject={() => undefined} />);
    expect(host.textContent).toMatch(/C&O wants to buy an ordinary 6-train from B&O/);
    expect(host.textContent).not.toMatch(/Blood Price/);
    render(<TrainTradePrompt proposal={proposal()} viewerIsSeller onAccept={() => undefined} onReject={() => undefined} />);
    expect(host.textContent).toMatch(/C&O wants to buy a 6-train from B&O/);
  });
});

describe("the shell dispatches the copy it was handed (source pins; App.tsx has no render harness)", () => {
  const APP = readStripped("App.tsx");
  it("the proposal, the direct buy and the pending offer all carry `gilded` -- and only when it was named", () => {
    expect(APP).toContain("...(proposal.gilded === undefined ? {} : { gilded: proposal.gilded }),");
    expect(APP).toContain("gilded: proposal.gilded,");
    // Room / sandbox only: the contract has no Carcosa, so the online path never names a copy.
    expect(APP).toContain("...(sandbox && input.gilded !== undefined ? { gilded: input.gilded } : {}),");
    expect(APP).toContain("...(offer.gilded === undefined ? {} : { gilded: offer.gilded }),");
  });
});
