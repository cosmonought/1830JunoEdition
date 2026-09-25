/** @jest-environment jsdom */
//
// ==================================================================
//  UR-6 (Variant Certification 1B -- Unpredictable Revenue): THE PLAYERS ARE TOLD WHAT THE AUTHORITY WILL DO
// ==================================================================
//
// UR-6 is replay-neutral presentation: nothing here changes a rule. Each case builds its board with the real reducer
// (the composed context a server builds), asks the canonical predicates the shell asks, renders the component the shell
// renders, and reads the DOM or the sentence. Owner rulings (VARIANT_CERT_UNPREDICTABLE_REVENUE_AUDIT_2026-09-24.md):
//   OD-UR-5(a) = 5a-1  the Blood Price CURES the train -- the buyer receives an ordinary train (D-48).
//   OD-UR-5(b)         the BUYER pays: its marker moves Left 1 / Down 1; the seller's never moves (D-50).
//   OD-UR-5(c) = 5c-2  the sale names the COPY: only the gold-trimmed copy's sale is the Blood Price (D-48).
//   OD-UR-7 = 7-A      a gold-trimmed train is never a Diesel trade-in; an ordinary copy still is (D-41).
//   OD-UR-2            the gold-trimmed train vanishes at the END of the Operating Round set after the doom trigger (D-38).
//   OD-UR-12 = 12-A    the variant is "Unpredictable Revenue" (D-45).
//
// WHAT IT CLOSES:
//   D1 (independent UR-4 review) -- the consent prompt / pending-offer view disclosed the Blood Price only for an offer
//     NAMING the gilded copy; an unnamed offer the authority settles as the Blood Price (the seller holds only the
//     gold-trimmed copy) read as "a 6-train".
//   U-42 -- the Activity Log's offer, answer and trade lines named the model, not the copy.
//   UR-F12 -- the gilded chip's tooltip said "until this Operating Round ends".
//   UR-F14 -- "Unpredictable Routes" on the host setup and the room list.
//   Appendix B item 13 -- Carcosan Railways' blurb ("never paid the Blood Price to be rid of it").
//   UR-3's deferrals -- the Diesel trade-in row's greyed gilded chip; the fog's ruled sound and film at the boundary.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import TrainPurchasePanel, { TrainTradePrompt, type TrainPurchaseCompany, type TrainTradeProposal } from "./TrainPurchasePanel";
import { TrainChips, CARCOSA_CHIP_TOOLTIP } from "./TrainBadges";
import { HOUSE_RULE_ROWS } from "./HostSetupCard";
import { ruleTitlesFor } from "./LobbyRoomList";
import type { GameStateResponse, PublicCompanyState, TrainPurchaseOffer } from "../gameEngine/gameState";
import { applySandboxAction, sandboxChartStepReport } from "../gameEngine/sandboxSession";
import { sandboxActionContext } from "../gameEngine/actionContext";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { nextDerivedAction } from "../gameEngine/derivedActions";
import { derivePhase, depotInventory, openDepotTiers } from "../gameEngine/gamePhase";
import { tileEraFor } from "../gameEngine/gameConstants";
import { resolveVariants } from "../gameEngine/gameVariants";
import { dieselExchangeOfferFor, dieselExchangeRefusal, exchangeableTrains, gildedExchangeCopies } from "../gameEngine/dieselExchange";
import { describeGameplayAction } from "../utils/actionLog";
import { offerSettlesAsBloodPrice, saleCopyKind } from "../utils/saleCopyDisclosure";
import { ACCOLADE_SPEC_BY_KEY } from "../utils/accolades";
import { variantCueFor, CARCOSA_FOG_AUDIO, CARCOSA_FOG_VIDEO } from "../utils/variantSfx";
import { CARCOSA_FOG_LINE } from "../gameEngine/yellowSign";
import { readStripped } from "../utils/sourceScan";
import * as S from "../utils/yellowSignRunBoundSupport";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { CO, BO, NYC, P1, P2, P3, GULF, urBoard, companyOf } = S;

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

/* ------------------------------------------------------------------ */
/* The reducer as a server's engine runs it, and the boards            */
/* ------------------------------------------------------------------ */

type Msg = Record<string, unknown>;
const providers = sandboxReplayProviders();
const ctxFor = (state: GameStateResponse, msg: unknown, actor: string | null) =>
  sandboxActionContext(providers, { state, msg: msg as never, actor, grid: GULF, gridBefore: GULF });
const reduce = (state: GameStateResponse, msg: unknown, actor: string | null) =>
  applySandboxAction(state, msg as never, ctxFor(state, msg, actor));
const chartReport = (state: GameStateResponse, msg: unknown) => sandboxChartStepReport(state, msg as never, ctxFor(state, msg, null));

const propose = (model: string, gilded?: boolean): Msg => ({
  ProposeTrainPurchase: {
    game_id: 1,
    seller_protocol_id: BO,
    seller_ticker: "B&O",
    seller_president: P2,
    buyer_protocol_id: CO,
    buyer_ticker: "C&O",
    model_type: model,
    price: "300",
    ...(gilded === undefined ? {} : { gilded }),
  },
});
const answer = (accept: boolean): Msg => ({ AnswerTrainPurchase: { game_id: 1, seller_protocol_id: BO, accept } });

const GILDED_6 = { is_carcosan: true, carcosan_trains: ["6"], ghost_trains: ["6"] } as Partial<PublicCompanyState>;

/** Phase 6: C&O (P1) at Purchase Trains; B&O (P2) holds `boTrains`, the 6 gilded when `gilded`. */
const table = (boTrains: string[], opts: { gilded?: boolean; ur?: boolean } = {}) =>
  urBoard({
    ur: opts.ur ?? true,
    corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 1000 },
      { id: BO, president: P2, trains: boTrains, extra: opts.gilded === false ? {} : GILDED_6 },
      { id: NYC, president: P3, trains: ["6", "5"] },
    ],
    step: "Hardware",
    macro: 6,
  });
/** B&O holds ONLY the gold-trimmed 6 (beside a 5): an unnamed sale of the 6 is unambiguous -- the Blood Price. */
const onlyGilded = () => table(["5", "6"]);
/** B&O holds a real 6 AND the gold-trimmed 6: a sale must name the copy. */
const mixed = () => table(["6", "6"]);
/** The standard game: no variant, no gilding. */
const standard = () => table(["5", "6"], { gilded: false, ur: false });

/** The pending offer on `state`, as `App.tsx`'s `sandboxTrainProposal` builds it (source-pinned below). */
function proposalFrom(state: GameStateResponse): TrainTradeProposal {
  const offer = state.train_purchase_offer as TrainPurchaseOffer;
  return {
    sellerProtocolId: offer.seller_protocol_id,
    sellerTicker: offer.seller_ticker,
    sellerPresident: offer.seller_president,
    sellerPresidentLabel: offer.seller_president ?? "",
    buyerProtocolId: offer.buyer_protocol_id,
    buyerTicker: offer.buyer_ticker,
    modelType: offer.model_type,
    price: offer.price,
    ...(offer.gilded === undefined ? {} : { gilded: offer.gilded }),
    bloodPrice: offerSettlesAsBloodPrice(state, offer),
  };
}

/** Propose from C&O and return the board with the offer standing. */
const offered = (board: GameStateResponse, model: string, gilded?: boolean) => {
  const after = reduce(board, propose(model, gilded), P1);
  expect(after.train_purchase_offer).not.toBeNull();
  return after;
};

/** Accept as B&O's president and settle the derived purchase, exactly as a room does. */
function acceptAndSettle(withOffer: GameStateResponse) {
  const accepted = reduce(withOffer, answer(true), P2);
  const owed = nextDerivedAction({ state: accepted, mapGrid: GULF, emitted: new Set() });
  if (!owed) throw new Error("no settlement was owed");
  const settled = reduce(accepted, owed.msg, null);
  return { accepted, settlement: owed.msg as Msg, settled };
}

const promptText = (proposal: TrainTradeProposal, viewerIsSeller: boolean) => {
  render(<TrainTradePrompt proposal={proposal} viewerIsSeller={viewerIsSeller} onAccept={() => undefined} onReject={() => undefined} />);
  return (host.textContent ?? "").replace(/\s+/g, " ");
};

const logLine = (msg: Msg, before: GameStateResponse, after?: GameStateResponse) =>
  describeGameplayAction(msg as never, {
    gameState: before,
    afterState: after ?? null,
    mapGrid: GULF,
    era: tileEraFor(before),
    labelForAddress: (address) => address,
  });

const c = (state: GameStateResponse, id: number) => companyOf(state, id);

/* ================================================================================================= */
/* D1 -- THE CONSENT PROMPT AND THE PENDING-OFFER VIEW DISCLOSE WHAT THE AUTHORITY WILL SETTLE        */
/* ================================================================================================= */

describe("D1. the consent prompt and the pending-offer view name the Blood Price whenever the authority will settle one", () => {
  it("1. an offer NAMING the gold-trimmed copy: the Blood Price, the buyer's drop, the seller's release", () => {
    const withOffer = offered(mixed(), "6", true);
    const proposal = proposalFrom(withOffer);
    expect(proposal.bloodPrice).toBe(true);
    const text = promptText(proposal, true);
    expect(text).toContain("C&O wants to buy the gold-trimmed 6-train from B&O for $300.");
    expect(text).toContain("This is the Blood Price: C&O's share price will drop (1 cell Left, 1 cell Down), and B&O is released from the Carcosan curse.");
  });

  it("2. an UNNAMED offer for the seller's only gold-trimmed copy: disclosed exactly as a named one -- and the authority agrees", () => {
    const withOffer = offered(onlyGilded(), "6");
    expect("gilded" in (withOffer.train_purchase_offer as object)).toBe(false); // the wire field is absent
    const proposal = proposalFrom(withOffer);
    expect(proposal.bloodPrice).toBe(true);
    const text = promptText(proposal, true);
    expect(text).toContain("C&O wants to buy the gold-trimmed 6-train from B&O for $300.");
    expect(text).toMatch(/This is the Blood Price: C&O's share price will drop \(1 cell Left, 1 cell Down\)/);
    expect(text).toContain("B&O is released from the Carcosan curse");
    expect(host.querySelector('button[title^="Sell the gold-trimmed 6-train to C&O"]')).not.toBeNull();
    // What the seller was shown is what settles: the gilding burns, the curse lifts, the BUYER's marker moves.
    const { settlement, settled } = acceptAndSettle(withOffer);
    expect(chartReport(reduce(withOffer, answer(true), P2), settlement)?.companyId).toBe(CO);
    expect(c(settled, BO).carcosan_trains ?? []).toEqual([]);
    expect(c(settled, BO).is_carcosan).toBe(false);
    expect(c(settled, CO).owned_trains).toEqual(["5", "6"]);
    expect(c(settled, CO).carcosan_trains ?? []).toEqual([]);
    expect(settled.market_positions?.[CO]).not.toEqual(withOffer.market_positions?.[CO]);
    expect(settled.market_positions?.[BO]).toEqual(withOffer.market_positions?.[BO]);
  });

  it("3. an ORDINARY copy beside a gold-trimmed one: named as ordinary, no Blood Price -- and the authority agrees", () => {
    const withOffer = offered(mixed(), "6", false);
    const proposal = proposalFrom(withOffer);
    expect(proposal.bloodPrice).toBe(false);
    const text = promptText(proposal, true);
    expect(text).toContain("C&O wants to buy an ordinary 6-train from B&O for $300.");
    expect(text).not.toMatch(/Blood Price|gold-trimmed/);
    const { settled } = acceptAndSettle(withOffer);
    expect(c(settled, BO).carcosan_trains).toEqual(["6"]); // the gilded copy keeps its gilding
    expect(c(settled, BO).is_carcosan).toBe(true);
    expect(settled.market_positions).toEqual(withOffer.market_positions); // nobody's marker moved
  });

  it("4. the pending-offer view -- the same prompt every other seat reads -- carries the same disclosure", () => {
    const text = promptText(proposalFrom(offered(onlyGilded(), "6")), false);
    expect(text).toContain("Waiting on p2.");
    expect(text).toContain("C&O wants to buy the gold-trimmed 6-train from B&O");
    expect(text).toContain("This is the Blood Price: C&O's share price will drop");
    const ordinary = promptText(proposalFrom(offered(mixed(), "6", false)), false);
    expect(ordinary).toContain("Waiting on p2.");
    expect(ordinary).not.toMatch(/Blood Price/);
  });

  it("5. a seller with no gold-trimmed copy, and the standard game: the prompt reads exactly as it always did", () => {
    for (const board of [table(["5", "6"], { gilded: false }), standard()]) {
      const proposal = proposalFrom(offered(board, "6"));
      expect(proposal.bloodPrice).toBe(false);
      const text = promptText(proposal, true);
      expect(text).toContain("C&O wants to buy a 6-train from B&O for $300.");
      expect(text).not.toMatch(/Blood Price|gold-trimmed|ordinary|curse/);
    }
  });

  it("6. an ambiguous unnamed offer is refused by the authority, so there is nothing to disclose -- and no guess is made", () => {
    const board = mixed();
    const after = reduce(board, propose("6"), P1);
    expect(after.train_purchase_offer ?? null).toBeNull(); // refused at the proposal
    // Were such an offer ever read, the disclosure would not claim a Blood Price the authority refuses to settle.
    expect(offerSettlesAsBloodPrice(board, { seller_protocol_id: BO, model_type: "6" })).toBe(false);
    expect(saleCopyKind(board, BO, "6")).toBe("plain");
  });

  it("7. the shell derives it from the canonical predicate, and the prompt reads the derivation, not the wire field (source pins)", () => {
    const APP = readStripped("App.tsx");
    const memo = APP.slice(APP.indexOf("const sandboxTrainProposal = useMemo"), APP.indexOf("const sandboxTrainProposal = useMemo") + 1600);
    expect(memo).toContain("bloodPrice: offerSettlesAsBloodPrice(gameState, offer),");
    expect(memo).toContain("}, [gameState]);"); // the seller's fleet is the dependency, not only the offer
    const PANEL = readStripped("components/TrainPurchasePanel.tsx");
    const prompt = PANEL.slice(PANEL.indexOf("export function TrainTradePrompt("), PANEL.indexOf("export interface FundingPrivateOfferPromptProps"));
    expect(prompt).toContain("const bloodPrice = proposal.bloodPrice === true;");
    expect(prompt).toContain("{bloodPrice && (");
    expect(prompt).not.toContain("proposal.gilded === true");
    // The predicate is the reducer's own, not a second rules engine.
    const UTIL = readStripped("utils/saleCopyDisclosure.ts");
    expect(UTIL).toContain("isCarcosanTransfer(state, sellerId, model, gilded)");
  });
});

/* ================================================================================================= */
/* U-42 -- THE ACTIVITY LOG NAMES THE COPY                                                           */
/* ================================================================================================= */

describe("U-42. the Activity Log's offer, answer and trade lines name the copy, and the Blood Price is the buyer's", () => {
  it("the gold-trimmed copy (here unnamed, the seller's only one): the offer, the answer and the trade say Blood Price", () => {
    const board = onlyGilded();
    const withOffer = offered(board, "6");
    expect(logLine(propose("6"), board)).toBe("C&O offers $300 for B&O's gold-trimmed 6-train — buying it is the Blood Price. p2 must answer.");
    const { accepted, settlement, settled } = acceptAndSettle(withOffer);
    expect(logLine(answer(true), withOffer)).toBe("p2 accepted $300 for B&O's gold-trimmed 6-train.");
    const trade = logLine(settlement, accepted, settled)!;
    expect(trade).toMatch(
      /^C&O bought B&O's gold-trimmed 6-train for \$300, paying the Blood Price: it is an ordinary 6-train now, and B&O is released from the Carcosan curse\./,
    );
    // Nothing says the seller paid or that the seller's price moved; nothing leaves the buyer a gold-trimmed train.
    expect(trade).not.toMatch(/B&O paid|B&O's (stock|share price)|still gold-trimmed|gold-trimmed 6-train now/);
  });

  it("the buyer-only market consequence: the chart step's report -- the line the Activity Log prints -- names the BUYER", () => {
    const withOffer = offered(onlyGilded(), "6");
    const { accepted, settlement, settled } = acceptAndSettle(withOffer);
    const moved = chartReport(accepted, settlement)!;
    expect(moved).toMatchObject({ companyId: CO, reason: "bloodPrice" });
    expect(settled.market_positions?.[BO]).toEqual(accepted.market_positions?.[BO]);
    // The shell's sentence names the token that moved (`marketResult.moved.companyId`) -- the buyer.
    const APP = readStripped("App.tsx");
    expect(APP).toContain("`The gold-trimmed train was transferred. A Blood Price was paid: ${ticker}'s stock dropped from $${from} to $${to}.`");
    expect(APP).toMatch(/const \{ companyId, from, to, reason \} = marketResult\.moved;\s*const ticker =\s*before\?\.public_companies\.find\(\(entry\) => entry\.company_id === companyId\)/);
  });

  it("an ORDINARY copy of the same model: an ordinary sale, and every line says so -- never the Blood Price", () => {
    const board = mixed();
    const withOffer = offered(board, "6", false);
    const proposeLine = logLine(propose("6", false), board)!;
    expect(proposeLine).toBe("C&O offers $300 for an ordinary 6-train from B&O — not the gold-trimmed one, so no Blood Price. p2 must answer.");
    expect(logLine(answer(true), withOffer)).toBe("p2 accepted $300 for B&O's ordinary 6-train.");
    const { accepted, settlement, settled } = acceptAndSettle(withOffer);
    const trade = logLine(settlement, accepted, settled)!;
    expect(trade).toMatch(/^C&O bought an ordinary 6-train from B&O for \$300 — not the gold-trimmed one, so no Blood Price\./);
    for (const line of [proposeLine, trade]) expect(line).not.toMatch(/is the Blood Price|paying the Blood Price/);
    expect(chartReport(accepted, settlement)).toBeNull();
  });

  it("every other sale keeps its sentence byte for byte -- a seller with no gilding under the variant, and the standard game", () => {
    for (const board of [table(["5", "6"], { gilded: false }), standard()]) {
      const withOffer = offered(board, "6");
      expect(logLine(propose("6"), board)).toBe("C&O offers $300 for one of B&O's 6-trains. p2 must answer.");
      expect(logLine(answer(true), withOffer)).toBe("p2 accepted $300 for B&O's 6-train.");
      const { accepted, settlement, settled } = acceptAndSettle(withOffer);
      expect(logLine(settlement, accepted, settled)).toMatch(/^C&O bought a 6-train from B&O for \$300\. /);
    }
  });

  it("the shell's same-president line names the copy with the same predicate (source pin)", () => {
    const APP = readStripped("App.tsx");
    expect(APP).toContain("const copyKind = saleCopyKind(gameState, proposal.sellerProtocolId, proposal.modelType, proposal.gilded);");
    expect(APP).toContain("bought ${trainPhrase} from ${proposal.sellerTicker}");
  });
});

/* ================================================================================================= */
/* UR-F12 -- THE GOLD-TRIMMED CHIP STATES ITS RULED LIFETIME                                         */
/* ================================================================================================= */

describe("UR-F12. the gold-trimmed chip's tooltip states the ruled lifetime", () => {
  it("says the exemption lasts while it stays gold-trimmed, the fog comes at the end of an Operating Round set, and the buyer pays", () => {
    const board = onlyGilded();
    const bo = c(board, BO);
    render(<TrainChips trains={bo.owned_trains} phase={derivePhase(board)} surface="dark" ghosts={bo.carcosan_trains} />);
    const titles = Array.from(host.querySelectorAll<HTMLElement>("span[title]")).map((node) => node.getAttribute("title") ?? "");
    expect(titles.filter((title) => title === CARCOSA_CHIP_TOOLTIP)).toHaveLength(1); // the 6 only, never the 5
    expect(CARCOSA_CHIP_TOOLTIP).not.toMatch(/until this Operating Round ends|ghost/i);
    expect(CARCOSA_CHIP_TOOLTIP).toMatch(/no train-limit slot while it stays gold-trimmed/);
    expect(CARCOSA_CHIP_TOOLTIP).toMatch(/cannot be traded in for a Diesel/);
    // The deadline is stated against the moment it counts from (OD-UR-2: the end of the set after the doom trigger),
    // never as "the next set" from whenever the chip is read.
    expect(CARCOSA_CHIP_TOOLTIP).toMatch(
      /vanishes into the fog at the end of the Operating Round set after the one in which a Diesel is first bought from the Bank \(or after the set it arrived in, if a Diesel came first\)/,
    );
    expect(CARCOSA_CHIP_TOOLTIP).not.toMatch(/the next Operating Round set/);
    expect(CARCOSA_CHIP_TOOLTIP).toMatch(/another corporation buys it first and pays the Blood Price/);
    expect(host.querySelector('img[alt="Gold-trimmed Carcosa train"]')).not.toBeNull();
  });

  it("a cured train at the buyer wears no sign and no Carcosa tooltip -- it is an ordinary train", () => {
    const { settled } = acceptAndSettle(offered(onlyGilded(), "6"));
    const coTrains = c(settled, CO);
    render(<TrainChips trains={coTrains.owned_trains} phase={derivePhase(settled)} surface="dark" ghosts={coTrains.carcosan_trains} />);
    expect(host.querySelector("img")).toBeNull();
    expect(host.innerHTML).not.toContain("Gold-trimmed Carcosa train");
  });
});

/* ================================================================================================= */
/* UR-3's deferral -- THE DIESEL TRADE-IN ROW SHOWS THE GOLD-TRIMMED COPY IT MAY NOT TAKE            */
/* ================================================================================================= */

describe("OD-UR-7. the Diesel trade-in row greys the gold-trimmed copy, with the refusal's reason", () => {
  /** Phase D (NYC bought a real D); C&O at Buy Trains holding `trains`, its 6 gold-trimmed unless `gilding` is off. */
  const dieselTable = (trains: string[], gilding = true, ur = true) =>
    urBoard({
      ur,
      corps: [
        { id: CO, president: P1, trains, treasury: 1200, extra: gilding ? { ...GILDED_6, carcosan_doom_after_macro_round: 7 } : {} },
        { id: NYC, president: P2, trains: ["D"] },
      ],
      step: "Hardware",
      macro: 6,
    });
  const renderPanel = (state: GameStateResponse) =>
    render(
      <TrainPurchasePanel
        depot={depotInventory(state)}
        buyer={c(state, CO) as unknown as TrainPurchaseCompany}
        companies={state.public_companies as unknown as TrainPurchaseCompany[]}
        sessionReady
        canAct
        blockedReason={null}
        onBuyFromBank={() => undefined}
        openTiers={openDepotTiers(state)}
        dieselExchange={dieselExchangeOfferFor(state, CO)}
        onExchangeForDiesel={() => undefined}
        onProposeTrade={() => undefined}
        labelForAddress={(address) => address}
      />,
    );
  const radios = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]'));
  const exchangeButton = () => Array.from(host.querySelectorAll("button")).find((node) => /^Exchange and Pay/.test(node.textContent ?? ""));

  it("a gold-trimmed 6 beside an ordinary 5: the 5 is live, the 6 is shown greyed and explained", () => {
    const state = dieselTable(["5", "6"]);
    expect(exchangeableTrains(c(state, CO))).toEqual(["5"]);
    expect(gildedExchangeCopies(c(state, CO))).toEqual(["6"]);
    renderPanel(state);
    expect(radios().map((chip) => [chip.textContent, chip.disabled])).toEqual([
      ["5", false],
      ["6", true],
    ]);
    const gilded = host.querySelector<HTMLButtonElement>('[data-testid="exchange-gilded-chip"]')!;
    expect(gilded.getAttribute("aria-label")).toBe("Gold-trimmed 6-train: C&O's 6-train is gold-trimmed by Carcosa — a gilded train cannot be traded in for a Diesel.");
    expect(gilded.style.textDecoration).toBe("line-through");
    expect(exchangeButton()!.disabled).toBe(false);
    expect(Array.from(host.querySelectorAll('[data-testid="exchange-gilded-note"]')).map((node) => node.textContent)).toEqual([
      "C&O's 6-train is gold-trimmed by Carcosa — a gilded train cannot be traded in for a Diesel.",
    ]);
  });

  it("a gold-trimmed 6 beside an ordinary 6: one live 6, one greyed -- the multiset, never the model", () => {
    const state = dieselTable(["6", "6"]);
    renderPanel(state);
    expect(radios().map((chip) => [chip.textContent, chip.disabled])).toEqual([
      ["6", false],
      ["6", true],
    ]);
    expect(host.querySelector('[data-testid="exchange-gilded-chip"]')!.getAttribute("title")).toBe(
      "C&O's gold-trimmed 6-train cannot be traded in for a Diesel; its ordinary one can.",
    );
  });

  it("the only eligible train is gold-trimmed: the row stays, greyed, with the gate's own sentence -- it no longer vanishes", () => {
    const state = dieselTable(["6"]);
    renderPanel(state);
    expect(radios().map((chip) => [chip.textContent, chip.disabled])).toEqual([["6", true]]);
    expect(exchangeButton()!.disabled).toBe(true);
    expect(host.textContent).toContain(dieselExchangeRefusal(state, CO)!);
  });

  it("no gilding -- the variant's ordinary table and the standard game -- builds the offer it always built", () => {
    for (const state of [dieselTable(["5", "6"], false), dieselTable(["5", "6"], false, false)]) {
      const offer = dieselExchangeOfferFor(state, CO)!;
      expect("gilded" in offer).toBe(false);
      renderPanel(state);
      expect(host.querySelector('[data-testid="exchange-gilded-chip"]')).toBeNull();
      expect(radios().map((chip) => [chip.textContent, chip.disabled])).toEqual([
        ["5", false],
        ["6", false],
      ]);
    }
  });
});

/* ================================================================================================= */
/* OD-UR-2 -- THE FOG'S RULED SOUND AND FILM, AT THE BOUNDARY WHERE IT NOW FALLS                     */
/* ================================================================================================= */

describe("OD-UR-2. the fog's ruled cue plays at the set boundary, once, and never on a replay (source pins -- no App harness)", () => {
  const APP = readStripped("App.tsx");
  const START = "let fogFellAtSetEnd = false;";
  const block = APP.slice(APP.indexOf(START));

  it("the boundary's own report drives it -- the same loop that writes the Activity Log line", () => {
    expect(APP.indexOf(START)).toBeGreaterThan(0);
    expect(block).toMatch(
      /^let fogFellAtSetEnd = false;\s*for \(const fog of describeFogAtSetEnd\(settledBefore, settledAfter\)\) \{[\s\S]{0,200}?logInfo\(`\$\{CARCOSA_FOG_LINE\}[^\n]*\n\s*fogFellAtSetEnd = true;/,
    );
  });

  it("guarded by the replay flag, like every ephemeral raiser (#1094), and played once however many trains went", () => {
    const guard = block.indexOf("if (fogFellAtSetEnd && !replayingHistory) {");
    expect(guard).toBeGreaterThan(0);
    const body = block.slice(guard, block.indexOf("if (queuedNotices.length !== pendingFleetNoticesRef.current.length)"));
    expect(body).toContain('variantCueFor({ line: CARCOSA_FOG_LINE, bucket: "unchanged", stage: "fog" })');
    expect(body).toContain("playVariantCue(fogCue.audio, sfxEnabledRef.current && sfxRevenueRef.current);");
    expect(body).toContain("setHaunting({");
    expect(body).not.toMatch(/for \(/); // one cue per boundary
  });

  it("the cue is the fog's ruled one: its own sound and its own film (#1092, #1093)", () => {
    const cue = variantCueFor({ line: CARCOSA_FOG_LINE, bucket: "unchanged", stage: "fog" });
    expect([cue.audio, cue.video, cue.videoHasOwnAudio]).toEqual([CARCOSA_FOG_AUDIO, CARCOSA_FOG_VIDEO, false]);
  });
});

/* ================================================================================================= */
/* UR-F14, Appendix B item 13 and The Redeemer -- THE NAMES AND THE AWARDS                           */
/* ================================================================================================= */

describe("UR-F14. the variant has one name: Unpredictable Revenue", () => {
  it("the host setup's row and the room list both say it", () => {
    expect(HOUSE_RULE_ROWS.find((row) => row.key === "unpredictableRevenue")?.title).toBe("Unpredictable Revenue");
    const titles = ruleTitlesFor(resolveVariants({ unpredictableRevenue: true }));
    expect(titles).toContain("Unpredictable Revenue");
    for (const file of ["components/HostSetupCard.tsx", "components/LobbyRoomList.tsx", "components/Lobby.tsx", "components/RulesReference.tsx"]) {
      expect([file, /Unpredictable Routes/i.test(readStripped(file))]).toEqual([file, false]);
    }
  });
});

describe("Appendix B item 13 and The Redeemer: the award copy matches the buyer-pays logic", () => {
  it("Carcosan Railways no longer implies its president could pay to be rid of the train", () => {
    const blurb = ACCOLADE_SPEC_BY_KEY.get("carcosan-railways")!.blurb;
    expect(blurb).not.toMatch(/rid of it/);
    expect(blurb).toBe("Saw the Yellow Sign touch their railroad, and never paid a Blood Price to buy a gold-trimmed train.");
  });

  it("The Redeemer's copy names the buyer's act, unchanged -- the logic credits the buying president (UR-5)", () => {
    expect(ACCOLADE_SPEC_BY_KEY.get("redeemer")!.blurb).toBe("Paid the Blood Price and took the Carcosan train off another corporation.");
    const HISTORY = readStripped("utils/gameHistory.ts");
    expect(HISTORY).toContain("bump(bloodPrices, buyer.president, 1);");
    expect(HISTORY).not.toContain("bump(bloodPrices, seller.president");
  });
});

describe("Appendix B item 14: the post-game ledger says what its columns count", () => {
  it("Earned is the printed value of completed routes; Runs are completed runs -- true of every game", () => {
    const CHARTS = readStripped("components/EpilogueCharts.tsx");
    expect(CHARTS).toContain('title="The printed value of its completed routes">Earned<');
    expect(CHARTS).toContain('title="Completed runs, counting each train separately">Runs<');
    expect(CHARTS).toContain("What each corporation's trains ran for in every Operating Round.");
  });
});
