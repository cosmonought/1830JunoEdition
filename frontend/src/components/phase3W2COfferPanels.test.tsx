/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W2-C (AUD-09.02 / U-21, AUD-09.03 / U-20): THE OFFER PANELS READ THEIR AUTHORITY -- RENDERED
// ==================================================================
//
// Both panels are rendered for real against the Batch 7.4 legal boards, with the authority bound exactly as the shell
// binds it (`utils/offerAuthorityView.ts`), and read off the DOM:
//
//   Buy Private Company (`ProposePrivatePurchase`, embedded):
//     - a corporation-owned private is not offered (the U-20 half the audit stated);
//     - a legal proposal stays live and sends the price typed;
//     - the 1/2x and 2x band edges, the treasury, the B&O, the same-president shortcut -- each card's state and each
//       refusal is the authority's own sentence, on the title and the problem line alike;
//     - W2-A's hold still greys every submit with the hold's sentence, and the authority is not asked under it;
//     - the submit is latched: two presses in one task send one proposal, the shell's in-flight latch greys it, and
//       once the proposal lands the hold it raises keeps a repeat press dead; a press that sent nothing never sticks.
//   Buy Trains from a Corporation (`TrainPurchasePanel`'s roster):
//     - a legal offer stays live and sends the canonical price; the floor, the treasury, the limit, a seller with no
//       president and D-6's face-value cap are the authority's sentences; the same-president sale is offered as Buy Now;
//     - W2-A's hold still comes first.
//   And the wiring: the shell binds both authorities beside its one hold answer, and the bar forwards them.

import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ProposePrivatePurchase } from "./PrivateTradePanel";
import TrainPurchasePanel, { type TrainPurchaseCompany, type TrainTradeProposal } from "./TrainPurchasePanel";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "./hexContractTypes";
import { depotInventory, openDepotTiers } from "../gameEngine/gamePhase";
import { proposePrivatePurchaseRefusal } from "../gameEngine/privatePurchaseAuthority";
import { dockHoldView } from "../utils/dockHoldView";
import { CONSENT_IN_FLIGHT_TITLE } from "../utils/offerConsentView";
import { BO, CA, CO, DH, MH, NYC, operatingBoard, P1, P2, P3, PRR } from "../utils/offerFixtures74";
import { apply, corridor, fundingBoard, M, withCorp } from "../utils/offerMatrix74Support";
import { privateProposalRefusal, trainOfferRefusal, type OfferAuthorityInput, type TrainOfferIntent } from "../utils/offerAuthorityView";
import { readShell, readSource, readStripped, sliceBetween } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const LABELS: Record<string, string> = { [P1]: "Ann", [P2]: "Ben", [P3]: "Cy" };
const labelFor = (address: string) => LABELS[address] ?? address;
const noop = () => undefined;

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

const textOf = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (label: string | RegExp) =>
  Array.from(host.querySelectorAll("button")).filter((button) =>
    typeof label === "string" ? textOf(button).startsWith(label) : label.test(textOf(button)),
  );
const one = (label: string | RegExp) => {
  const found = buttons(label);
  expect(found.length).toBeGreaterThan(0);
  return found[0];
};
const live = (button: HTMLButtonElement) => !button.disabled;
const press = (button: HTMLButtonElement) =>
  act(() => {
    button.click();
  });
/** Types into a React-controlled input the way a browser does: the native setter, then an `input` event. */
const typeInto = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

/** PRR (Ann) operating at Purchase Trains with $500, phase 3. The D&H ($70) is Ben's, the C&A a CORPORATION's (NYC's),
 *  the M&H ($110) Ann's own, and the B&O private ($100) Ben's. */
const board = (): GameStateResponse =>
  operatingBoard({
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: CA, owner: null, ownerCorp: NYC, cost: "160" },
      { id: MH, owner: P1, cost: "110" },
      { id: BO, owner: P2, cost: "100" },
    ],
  });
const bound = (state: GameStateResponse, actor: string = P1, buyerId: number = PRR, mapGrid?: MapGridResponse): OfferAuthorityInput => ({
  state,
  actor,
  buyerId,
  mapGrid,
  labelFor,
});

const BAND_DH = "The price must be a whole number between $35 and $140 (half to twice Delaware & Hudson's $70 face value).";
const TRAIN_FLOOR = "The price must be a whole number of at least $1 (rulebook 6.6).";

/* ================================================================================================== */
describe("Buy Private Company reads `proposePrivatePurchaseRefusal`", () => {
  function panel(
    state: GameStateResponse,
    over: {
      onPropose?: (privateId: number, price: number) => void;
      blockedReason?: string | null;
      actionInFlight?: boolean;
      proposalRefusal?: (privateId: number, price: string | number) => string | null;
    } = {},
  ) {
    return (
      <ProposePrivatePurchase
        embedded
        open
        buyerTicker="PRR"
        privates={state.private_companies}
        treasury={500}
        labelForAddress={labelFor}
        onPropose={over.onPropose ?? noop}
        onClose={noop}
        blockedReason={over.blockedReason ?? null}
        proposalRefusal={over.proposalRefusal ?? ((privateId, price) => privateProposalRefusal(bound(state), privateId, price))}
        actionInFlight={over.actionInFlight ?? false}
      />
    );
  }
  const openCard = (name: RegExp) => press(one(name));
  const priceField = (name: string) => host.querySelector<HTMLInputElement>(`input[aria-label^="Offer price for ${name}"]`)!;

  it("does not offer a corporation-owned private (U-20's stated half, now pinned)", () => {
    render(panel(board()));
    expect(host.textContent).not.toContain("Camden & Amboy");
    expect(buttons(/Delaware & Hudson/).length).toBe(1);
    expect(buttons(/Mohawk & Hudson/).length).toBe(1);
    expect(buttons(/Baltimore & Ohio/).length).toBe(1);
  });

  it("keeps a legal proposal live, and sends the price typed", () => {
    const sent: Array<[number, number]> = [];
    render(panel(board(), { onPropose: (id, price) => sent.push([id, price]) }));
    openCard(/Delaware & Hudson/);
    const submit = one("Propose Purchase to Ben");
    expect([live(submit), submit.title]).toEqual([true, "Offer $70 to Ben for Delaware & Hudson."]);
    press(submit);
    typeInto(priceField("Delaware & Hudson"), "120");
    press(one("Propose Purchase to Ben"));
    expect(sent).toEqual([
      [DH, 70],
      [DH, 120],
    ]);
  });

  it.each([
    ["the 1/2x edge", "35", null],
    ["a dollar under it", "34", BAND_DH],
    ["the 2x edge", "140", null],
    ["a dollar over it", "141", BAND_DH],
    ["a fraction", "70.5", BAND_DH],
    ["an empty field", "", BAND_DH],
  ])("the band, %s ($%s): the authority's answer on the title and the problem line", (_label, typed, sentence) => {
    const sent: number[] = [];
    render(panel(board(), { onPropose: (_id, price) => sent.push(price) }));
    openCard(/Delaware & Hudson/);
    typeInto(priceField("Delaware & Hudson"), typed);
    const submit = one("Propose Purchase to Ben");
    expect(live(submit)).toBe(sentence === null);
    if (sentence !== null) {
      expect(submit.title).toBe(sentence);
      expect(host.textContent).toContain(sentence);
      press(submit);
      expect(sent).toEqual([]);
    } else {
      expect(host.textContent).not.toContain(BAND_DH);
    }
  });

  it("an all-digit entry's leading zeros are the input's: \"070\" is $70, live, and sent as 70", () => {
    const sent: number[] = [];
    render(panel(board(), { onPropose: (_id, price) => sent.push(price) }));
    openCard(/Delaware & Hudson/);
    typeInto(priceField("Delaware & Hudson"), "070");
    press(one("Propose Purchase to Ben"));
    expect(sent).toEqual([70]);
  });

  it("the refusal shown is the authority's sentence, byte for byte (no panel prose beside it)", () => {
    const state = board();
    render(panel(state));
    openCard(/Delaware & Hudson/);
    typeInto(priceField("Delaware & Hudson"), "141");
    const shown = one("Propose Purchase to Ben").title;
    expect(shown).toBe(proposePrivatePurchaseRefusal(state, { private_id: DH, buyer_protocol_id: PRR, price: "141" }, P1));
    expect(host.textContent).not.toMatch(/below 50%|above 200%|Enter a price|Price must be a whole number/);
  });

  it("the treasury: payable is live, a dollar more is refused; short of the floor, the card offers no form at all", () => {
    const poor = withCorp(board(), PRR, { treasury: "100" });
    render(panel(poor));
    openCard(/Delaware & Hudson/);
    typeInto(priceField("Delaware & Hudson"), "100");
    expect(live(one("Propose Purchase to Ben"))).toBe(true);
    typeInto(priceField("Delaware & Hudson"), "101");
    expect([live(one("Propose Purchase to Ben")), one("Propose Purchase to Ben").title]).toEqual([
      false,
      "PRR's treasury holds $100 — it cannot pay $101.",
    ]);

    const broke = withCorp(board(), PRR, { treasury: "30" });
    render(panel(broke));
    expect(host.textContent).toContain("PRR's treasury holds $30 — it cannot pay $35.");
    expect(priceField("Delaware & Hudson")).toBeNull();
  });

  it("the B&O opens to its rule and the authority's ban, with no form", () => {
    render(panel(board()));
    openCard(/Baltimore & Ohio/);
    expect(host.textContent).toContain("Baltimore & Ohio may never be sold to a corporation.");
    expect(priceField("Baltimore & Ohio")).toBeNull();
  });

  it("the same-president shortcut: Ann's own M&H is offered live, and sends", () => {
    const sent: Array<[number, number]> = [];
    render(panel(board(), { onPropose: (id, price) => sent.push([id, price]) }));
    openCard(/Mohawk & Hudson/);
    const submit = one("Propose Purchase to Ann");
    expect(live(submit)).toBe(true);
    press(submit);
    expect(sent).toEqual([[MH, 110]]);
  });

  describe("W2-A's hold comes first, and is preserved", () => {
    const TRAIN_OFFERED = () => apply(board(), M.proposeTrain(NYC, PRR, "3", "150"), P1);
    const HOLD =
      "PRR's offer of $150 for NYC's 3-train is waiting for the selling president's answer; nothing else can happen until it is answered or withdrawn.";

    it("greys every card's submit with the hold's sentence; the authority is not asked while it stands", () => {
      const held = TRAIN_OFFERED();
      const hold = dockHoldView({ state: held, labelFor }).proposePrivatePurchase;
      expect(hold).toBe(HOLD);
      const asked = jest.fn((privateId: number, price: string | number) => privateProposalRefusal(bound(held), privateId, price));
      render(panel(held, { blockedReason: hold, proposalRefusal: asked }));
      openCard(/Delaware & Hudson/);
      const submit = one("Propose Purchase to Ben");
      expect([live(submit), submit.title]).toEqual([false, HOLD]);
      expect(host.textContent).toContain(HOLD);
      // The predicate's own one-offer sentence never competes with the hold's.
      expect(host.textContent).not.toContain("An offer is already standing");
      expect(asked).not.toHaveBeenCalled();
    });

    it("under the hold even the B&O card opens to its rule and a greyed submit with the hold's sentence (W2-A's wording)", () => {
      const held = TRAIN_OFFERED();
      render(panel(held, { blockedReason: HOLD }));
      openCard(/Baltimore & Ohio/);
      expect(buttons("Propose Purchase to Ben")).toHaveLength(1); // the B&O's own card is the one open
      const submit = one("Propose Purchase to Ben");
      expect([live(submit), submit.title]).toEqual([false, HOLD]);
      // Not restated locally: the ban is the authority's answer once the hold clears (below), not the panel's under it.
      expect(host.textContent).not.toContain("may never be sold to a corporation");
      render(panel(board()));
      expect(host.textContent).toContain("Baltimore & Ohio may never be sold to a corporation.");
    });
  });

  describe("the submit is latched", () => {
    it("two presses before React commits send one proposal", () => {
      const sent: number[] = [];
      render(panel(board(), { onPropose: (id) => sent.push(id) }));
      openCard(/Delaware & Hudson/);
      const submit = one("Propose Purchase to Ben");
      act(() => {
        submit.click();
        submit.click();
      });
      expect(sent).toEqual([DH]);
    });

    it("the shell's in-flight latch greys it, with the in-flight sentence", () => {
      const sent: number[] = [];
      render(panel(board(), { onPropose: (id) => sent.push(id), actionInFlight: true }));
      openCard(/Delaware & Hudson/);
      const submit = one("Propose Purchase to Ben");
      expect([live(submit), submit.title]).toEqual([false, CONSENT_IN_FLIGHT_TITLE]);
      press(submit);
      expect(sent).toEqual([]);
    });

    it("press -> in flight -> the proposal lands -> its hold keeps a repeat press dead (the shell's sequence)", () => {
      const sent: Array<{ privateId: number; price: number }> = [];
      let land: () => void = noop;
      function Shell() {
        const [state, setState] = useState(board());
        const [inFlight, setInFlight] = useState(false);
        land = () => {
          setState((current) => apply(current, M.proposePrivate(DH, PRR, 70), P1));
          setInFlight(false);
        };
        const hold = dockHoldView({ state, labelFor }).proposePrivatePurchase;
        return panel(state, {
          blockedReason: hold,
          actionInFlight: inFlight,
          onPropose: (privateId, price) => {
            sent.push({ privateId, price });
            setInFlight(true); // `runGameplayAction` takes the latch synchronously, in the press (#1173a)
          },
        });
      }
      render(<Shell />);
      openCard(/Delaware & Hudson/);
      press(one("Propose Purchase to Ben"));
      expect(live(one("Propose Purchase to Ben"))).toBe(false);
      press(one("Propose Purchase to Ben"));
      act(() => land());
      const submit = one("Propose Purchase to Ben");
      expect([live(submit), submit.title]).toEqual([
        false,
        "PRR's offer of $70 for Delaware & Hudson is waiting for its owner's answer; nothing else can happen until it is answered or withdrawn.",
      ]);
      press(submit);
      expect(sent).toEqual([{ privateId: DH, price: 70 }]);
    });

    it("a press that sent nothing leaves the submit live -- the latch never sticks", () => {
      let presses = 0;
      render(panel(board(), { onPropose: () => (presses += 1) }));
      openCard(/Delaware & Hudson/);
      press(one("Propose Purchase to Ben"));
      expect(live(one("Propose Purchase to Ben"))).toBe(true);
      press(one("Propose Purchase to Ben"));
      expect(presses).toBe(2);
    });
  });
});

/* ================================================================================================== */
describe("Buy Trains from a Corporation reads `proposeTrainPurchaseRefusal` / `trainSaleRefusal`", () => {
  function roster(
    state: GameStateResponse,
    over: {
      buyerId?: number;
      mapGrid?: MapGridResponse;
      blockedReason?: string | null;
      onProposeTrade?: (proposal: TrainTradeProposal) => void;
      offerRefusal?: (offer: TrainOfferIntent) => string | null;
    } = {},
  ) {
    const buyerId = over.buyerId ?? PRR;
    const companies = state.public_companies as unknown as TrainPurchaseCompany[];
    return (
      <TrainPurchasePanel
        depot={depotInventory(state)}
        buyer={companies.find((entry) => entry.company_id === buyerId) ?? null}
        companies={companies}
        sessionReady
        canAct
        blockedReason={over.blockedReason ?? null}
        onBuyFromBank={noop}
        openTiers={openDepotTiers(state)}
        onProposeTrade={over.onProposeTrade ?? noop}
        offerRefusal={over.offerRefusal ?? ((offer) => trainOfferRefusal(bound(state, P1, buyerId, over.mapGrid), offer))}
        labelForAddress={labelFor}
        defaultCorporateOpen
      />
    );
  }
  /** The seller roster row for `ticker` (the last row whose text starts with it, as the UR-4 suite reads it). */
  const sellerBadges = (ticker: string): HTMLButtonElement[] => {
    const rows = Array.from(host.querySelectorAll("div")).filter(
      (node) => node.querySelector("button") !== null && textOf(node).startsWith(ticker),
    );
    const row = rows[rows.length - 1];
    if (!row) throw new Error(`no roster row for ${ticker}`);
    return Array.from(row.querySelectorAll<HTMLButtonElement>("button"));
  };
  const submit = () => one(/^(Buy Now|Send Offer)$/);
  const priceInput = () => host.querySelector<HTMLInputElement>("#trade-price")!;

  it("keeps a legal offer live and sends the canonical price", () => {
    const sent: TrainTradeProposal[] = [];
    render(roster(board(), { onProposeTrade: (proposal) => sent.push(proposal) }));
    const [three] = sellerBadges("NYC");
    expect(live(three)).toBe(true);
    press(three);
    expect([textOf(submit()), live(submit())]).toEqual(["Send Offer", true]);
    typeInto(priceInput(), " 150 ");
    press(submit());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sellerProtocolId: NYC, buyerProtocolId: PRR, modelType: "3", price: "150" });
  });

  it("an all-digit entry's leading zeros are the input's: \"007\" is sent as \"7\", the spelling judged", () => {
    const sent: TrainTradeProposal[] = [];
    render(roster(board(), { onProposeTrade: (proposal) => sent.push(proposal) }));
    press(sellerBadges("NYC")[0]);
    typeInto(priceInput(), "007");
    press(submit());
    expect(sent[0]).toMatchObject({ price: "7" });
  });

  it.each([
    ["$0", "0", TRAIN_FLOOR],
    ["an empty field", "", TRAIN_FLOOR],
    ["a fraction", "1.5", TRAIN_FLOOR],
    ["an exponent", "1e2", TRAIN_FLOOR],
    ["more than the treasury", "501", "PRR's treasury holds $500 — it cannot pay $501; the president's money is never used for a voluntary purchase."],
  ])("the offer form refuses %s in the authority's words", (_label, typed, sentence) => {
    const sent: TrainTradeProposal[] = [];
    render(roster(board(), { onProposeTrade: (proposal) => sent.push(proposal) }));
    press(sellerBadges("NYC")[0]);
    typeInto(priceInput(), typed);
    expect([live(submit()), submit().title]).toEqual([false, sentence]);
    expect(host.textContent).toContain(sentence);
    expect(host.textContent).not.toMatch(/Whole numbers only|must sell for at least|Enter a price\./);
    press(submit());
    expect(sent).toEqual([]);
  });

  it("the train limit: every badge greyed, the authority's sentence said once above the roster", () => {
    render(roster(withCorp(board(), PRR, { owned_trains: ["3", "3", "3", "3"] })));
    const LIMIT = "PRR is already at its train limit and may not buy another train.";
    const badges = [...sellerBadges("NYC"), ...sellerBadges("C&O")];
    expect(badges.length).toBe(3);
    for (const badge of badges) expect([live(badge), badge.title]).toEqual([false, LIMIT]);
    expect(Array.from(host.querySelectorAll("p")).filter((p) => textOf(p) === LIMIT)).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="sale-refusal-note"]')).toHaveLength(0);
  });

  it("a refusal only one seller carries is said under its row; the other seller stays live", () => {
    render(roster(withCorp(board(), NYC, { president: null })));
    const NOBODY = "NYC has no president to answer for it.";
    for (const badge of sellerBadges("NYC")) expect([live(badge), badge.title]).toEqual([false, NOBODY]);
    expect(Array.from(host.querySelectorAll('[data-testid="sale-refusal-note"]')).map(textOf)).toEqual([NOBODY]);
    expect(live(sellerBadges("C&O")[0])).toBe(true);
  });

  it("the same-president shortcut: offered as Buy Now, and sent", () => {
    const sent: TrainTradeProposal[] = [];
    render(roster(withCorp(board(), NYC, { president: P1 }), { onProposeTrade: (proposal) => sent.push(proposal) }));
    press(sellerBadges("NYC")[0]);
    expect([textOf(submit()), live(submit())]).toEqual(["Buy Now", true]);
    press(submit());
    expect(sent[0]).toMatchObject({ sellerProtocolId: NYC, price: "1" });
  });

  it("D-6 under the v12 funding hold: the trade stays live (W2-A), and the face-value cap is the authority's", () => {
    const forced = fundingBoard(500);
    const grid = corridor();
    expect(dockHoldView({ state: forced, mapGrid: grid, labelFor }).proposeTrainPurchase).toBeNull();
    render(roster(forced, { buyerId: CO, mapGrid: grid }));
    press(sellerBadges("PRR")[0]);
    typeInto(priceInput(), "180");
    expect(live(submit())).toBe(true);
    typeInto(priceInput(), "200");
    expect([live(submit()), submit().title]).toEqual([
      false,
      "When the president contributes, a train bought from another corporation may not cost more than its $180 face value (rulebook 6.6.2).",
    ]);
  });

  it("W2-A's hold comes first: every badge carries the hold's sentence and the authority is not asked", () => {
    const HOLD = "Ben's private company trade is waiting for an answer; nothing else can happen until it is answered or withdrawn.";
    const asked = jest.fn(() => null);
    render(roster(board(), { blockedReason: HOLD, offerRefusal: asked }));
    for (const badge of sellerBadges("NYC")) expect([live(badge), badge.title]).toEqual([false, HOLD]);
    expect(host.textContent).toContain(HOLD);
    expect(asked).not.toHaveBeenCalled();
  });
});

/* ================================================================================================== */
describe("the wiring: the shell binds both authorities beside its one hold answer, and the bar forwards them", () => {
  it("App binds them once per board from `offerAuthorityView`, after `dockHold`", () => {
    const shell = readShell();
    const binding = sliceBetween(shell, "const dockHold = useMemo(", "const privateTradeProposalRefusalFor");
    expect(binding).toContain("privateProposalRefusal(offerAuthority, privateId, price)");
    expect(binding).toContain("trainOfferRefusal(offerAuthority, offer)");
    expect(binding).toContain("actor: viewerAddress, buyerId: actingProtocolId");
  });

  it("the holds/purchase group hands them in, and W2-A's hold answers are untouched", () => {
    const shell = readShell();
    const privateGroup = sliceBetween(shell, "privatePurchase={", "onOpenPrivateTrade=");
    expect(privateGroup).toContain("blockedReason: dockHold.proposePrivatePurchase,");
    expect(privateGroup).toContain("proposalRefusal: privateOfferRefusal,");
    expect(privateGroup).toContain("actionInFlight,");
    const trainGroup = sliceBetween(shell, "trainPurchase={", "dividendRevenue={");
    expect(trainGroup).toContain("blockedReason: dockHold.proposeTrainPurchase,");
    expect(trainGroup).toContain("bankBlockedReason: dockHold.buyTrainFromBank,");
    expect(trainGroup).toContain("offerRefusal: trainOfferRefusalFor,");
  });

  it("the same-president fork `sellsDirect` mirrors is still the shell's own (one president over both sides)", () => {
    const shell = readShell();
    const train = sliceBetween(shell, "const handleProposeTrainTrade = useCallback(", "ProposeTrainPurchase: {");
    expect(train).toMatch(/const samePresident =\s*!!buyer\?\.president && buyer\.president === proposal\.sellerPresident;/);
    expect(train).toContain("handleMakeTrainOffer({");
    const priv = sliceBetween(shell, "const handleProposePrivatePurchase = useCallback(", "ProposePrivatePurchase: {");
    expect(priv).toContain("if (buyer?.president && buyer.president === target.owner) {");
    expect(priv).toContain("BuyPrivateCompany: {");
  });

  it("the bar forwards them to the embedded panels", () => {
    const bar = readStripped("panels/ContextualActionBar.tsx");
    expect(bar).toContain("proposalRefusal={privatePurchase.proposalRefusal}");
    expect(bar).toContain("actionInFlight={privatePurchase.actionInFlight ?? false}");
    expect(bar).toContain("offerRefusal={trainPurchase.offerRefusal}");
  });

  it("the panels carry no copy of the law any more", () => {
    const privatePanel = readStripped("components/PrivateTradePanel.tsx");
    for (const gone of ["offerPriceProblem", "privatePurchaseBlockReason", "corporateSaleBlockReason", "below 50% of face value", "above 200% of face value"]) {
      expect(privatePanel).not.toContain(gone);
    }
    const trainPanel = readStripped("components/TrainPurchasePanel.tsx");
    for (const gone of ["trainPriceError", "Whole numbers only.", "A train must sell for at least $1."]) {
      expect(trainPanel).not.toContain(gone);
    }
    // The helper restates nothing either: it imports the three predicates and asks them.
    const view = readSource("utils/offerAuthorityView.ts");
    expect(view).toContain('from "../gameEngine/privatePurchaseAuthority"');
    expect(view).toContain('from "../gameEngine/trainSaleAuthority"');
  });
});
