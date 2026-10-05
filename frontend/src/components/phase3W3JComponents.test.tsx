/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W3-J -- THE COMPONENT ROWS (AUD-25.10 (a)-(e), AUD-25.13 item 3)
// ==================================================================
//
// Behavioural: each case renders the component exactly as its mount passes it props (react-dom/client + act) and reads
// the DOM -- enabled / disabled controls, their titles, the visible text. Boards are the GR-3 harness's legal pinned
// Operating Rounds (`utils/gentleRustPresentationSupport`), and every refusal a case expects is the authority's own
// answer on that board, asked here the way the reducer asks it.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import TrainPurchasePanel, { FundingPrivateOfferPrompt, type TrainPurchaseCompany } from "./TrainPurchasePanel";
import { CONSENT_IN_FLIGHT_TITLE } from "../utils/offerConsentView";
import StockRoundPanel from "./StockRoundPanel";
import type { RoundType } from "../gameEngine/gameState";
import { IDLE_LINK_QUEUE_VIEW, LINK_QUEUED_NOTE, LINK_SENDING_NOTE, linkQueueView, type LinkQueueView } from "../utils/useLinkQueue";
import * as T from "../utils/stockRoundPrivateTrade";
import * as F from "../utils/offerFixtures74";
import {
  MH_EXCHANGE_EXPIRED_SENTENCE,
  mhExchangeRequestedSentence,
  mhQueuedAcknowledgement,
  mhSettlementSentence,
  pendingMhExchangeView,
  withPendingMhExchangeChip,
} from "../utils/mhQueuedExchange";
import { MH_PRIVATE_ID } from "../gameEngine/privateExchange";
import type { GameStateResponse } from "../gameEngine/gameState";
import { depotInventory, openDepotTiers } from "../gameEngine/gamePhase";
import { trainPurchaseRefusal } from "../gameEngine/trainPurchaseGate";
import { limitInForce } from "../gameEngine/sandboxSession";
import * as S from "../utils/gentleRustPresentationSupport";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { PRR, NYC, board, company } = S;

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
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
const buttonByText = (pattern: RegExp) => buttons().find((node) => pattern.test(node.textContent ?? ""));

/* ================================================================================================= */
/* AUD-25.10 (a) -- THE DEPOT BUY ASKS `trainPurchaseRefusal`                                       */
/* ================================================================================================= */

/** The Buy Trains panel for the operating corporation, with the shell's props (App.tsx's `trainPurchase`). */
function renderDepot(state: GameStateResponse, opts: { withBoard?: boolean; bankBlockedReason?: string | null } = {}) {
  const buyerId = S.acting(state)!;
  const onBuyFromBank = jest.fn();
  render(
    <TrainPurchasePanel
      depot={depotInventory(state)}
      buyer={company(state, buyerId) as unknown as TrainPurchaseCompany}
      companies={state.public_companies as unknown as TrainPurchaseCompany[]}
      sessionReady
      canAct
      blockedReason={null}
      bankBlockedReason={opts.bankBlockedReason ?? null}
      board={opts.withBoard === false ? undefined : state}
      onBuyFromBank={onBuyFromBank}
      openTiers={openDepotTiers(state)}
      onProposeTrade={() => undefined}
      labelForAddress={(address) => address}
    />,
  );
  return onBuyFromBank;
}
const depotBuy = () => buttonByText(/^(Pay \$|Train Limit Reached)/)!;

/** The gate's own answer for the depot head on `state`, asked with the reducer's arguments. */
function authorityFor(state: GameStateResponse): string | null {
  const head = openDepotTiers(state)[0];
  return trainPurchaseRefusal(state, S.acting(state)!, {
    cost: head.cost,
    trainLimit: limitInForce(state) ?? head.trainLimit,
    requireFunds: true,
  });
}

describe("W3-J AUD-25.10 (a): the depot Buy is greyed with the purchase authority's sentence", () => {
  it("at the train limit: disabled, titled with exactly the gate's limit sentence", () => {
    const state = board({ corps: [{ id: PRR, trains: ["3", "3", "3", "3"] }, { id: NYC, trains: ["3"] }], operating: PRR });
    const refusal = authorityFor(state);
    expect(refusal).toBe("Train limit reached — PRR already holds 4 of a maximum 4.");
    const onBuy = renderDepot(state);
    expect(depotBuy().disabled).toBe(true);
    expect(depotBuy().title).toBe(refusal);
    expect(host.textContent).toContain(refusal!);
    // The panel's retired wording ("... for this phase.") is not said anywhere.
    expect(host.textContent).not.toContain("for this phase.");
    click(depotBuy());
    expect(onBuy).not.toHaveBeenCalled();
  });

  it("with a poor treasury: disabled, titled with exactly the gate's funds sentence", () => {
    const state = board({ corps: [{ id: PRR, trains: ["3"], treasury: "40" }, { id: NYC, trains: ["3"] }], operating: PRR });
    const refusal = authorityFor(state);
    expect(refusal).toMatch(/^PRR's treasury holds \$40 — it cannot pay \$\d+\.$/);
    renderDepot(state);
    expect(depotBuy().disabled).toBe(true);
    expect(depotBuy().title).toBe(refusal);
  });

  it("a purchase the gate allows stays live; the hold still outranks the gate; no board states no rule", () => {
    const rich = board({ corps: [{ id: PRR, trains: ["3"] }, { id: NYC, trains: ["3"] }], operating: PRR });
    expect(authorityFor(rich)).toBeNull();
    const onBuy = renderDepot(rich);
    expect(depotBuy().disabled).toBe(false);
    click(depotBuy());
    expect(onBuy).toHaveBeenCalledTimes(1);

    const poor = board({ corps: [{ id: PRR, trains: ["3"], treasury: "40" }, { id: NYC, trains: ["3"] }], operating: PRR });
    renderDepot(poor, { bankBlockedReason: "A hold stands." });
    expect(depotBuy().title).toBe("A hold stands.");

    renderDepot(poor, { withBoard: false });
    expect(depotBuy().disabled).toBe(false);
  });
});

/* ================================================================================================= */
/* AUD-25.10 (b) -- THE FUNDING OFFER PROMPT ASKS THE ANSWER'S AUTHORITY                             */
/* ================================================================================================= */

describe("W3-J AUD-25.10 (b): FundingPrivateOfferPrompt greys its answer with the authority's verdicts", () => {
  const OFFER = { privateId: 3, privateName: "Champlain & St.Lawrence", sellerLabel: "Alice", buyerTicker: "B&O", buyerPresidentLabel: "Bob", price: 40 };
  const ACCEPT_REFUSAL = "B&O's treasury holds $30 — it cannot pay $40.";
  const ANSWER_REFUSAL = "A train discard is owed first.";
  function renderPrompt(props: { answerRefusal?: string | null; acceptRefusal?: string | null; actionInFlight?: boolean; viewerIsBuyerPresident?: boolean }) {
    const onAnswer = jest.fn();
    render(
      <FundingPrivateOfferPrompt
        offer={OFFER}
        viewerIsBuyerPresident={props.viewerIsBuyerPresident ?? true}
        onAnswer={onAnswer}
        actionInFlight={props.actionInFlight ?? false}
        answerRefusal={props.answerRefusal}
        acceptRefusal={props.acceptRefusal}
      />,
    );
    return onAnswer;
  }
  const accept = () => buttonByText(/^Accept$/)!;
  const reject = () => buttonByText(/^Reject$/)!;
  const shownRefusal = () => host.querySelector('[data-testid="funding-offer-refusal"]')?.textContent ?? null;

  it("an acceptance the authority refuses: Accept disabled with its sentence as the title; Reject stays live", () => {
    const onAnswer = renderPrompt({ acceptRefusal: ACCEPT_REFUSAL });
    expect(accept().disabled).toBe(true);
    expect(accept().title).toBe(ACCEPT_REFUSAL);
    expect(shownRefusal()).toBe(ACCEPT_REFUSAL);
    click(accept());
    expect(onAnswer).not.toHaveBeenCalled();
    expect(reject().disabled).toBe(false);
    click(reject());
    expect(onAnswer).toHaveBeenCalledWith(3, false);
  });

  it("an answer the authority refuses: both Reject and Accept disabled with that sentence", () => {
    const onAnswer = renderPrompt({ answerRefusal: ANSWER_REFUSAL, acceptRefusal: ACCEPT_REFUSAL });
    expect(reject().disabled).toBe(true);
    expect(reject().title).toBe(ANSWER_REFUSAL);
    expect(accept().disabled).toBe(true);
    expect(accept().title).toBe(ANSWER_REFUSAL);
    click(reject());
    click(accept());
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("without a refusal the prompt is unchanged: both live, Accept titled with the purchase", () => {
    const onAnswer = renderPrompt({});
    expect(reject().disabled).toBe(false);
    expect(accept().disabled).toBe(false);
    expect(accept().title).toBe("Buy Champlain & St.Lawrence for $40.");
    expect(shownRefusal()).toBeNull();
    click(accept());
    expect(onAnswer).toHaveBeenCalledWith(3, true);
  });

  it("the role line and the in-flight latch keep their place ahead of the verdict", () => {
    renderPrompt({ viewerIsBuyerPresident: false, acceptRefusal: ACCEPT_REFUSAL });
    expect(accept().disabled).toBe(true);
    expect(accept().title).toBe("Only Bob can answer.");
    expect(shownRefusal()).toBeNull();
    renderPrompt({ actionInFlight: true, acceptRefusal: ACCEPT_REFUSAL });
    expect(accept().title).toBe(CONSENT_IN_FLIGHT_TITLE);
  });
});

/* ================================================================================================= */
/* AUD-25.10 (c) -- ONE HELD SUBMISSION, ONE BUSY LINE                                               */
/* ================================================================================================= */

describe("W3-J AUD-25.10 (c): the Stock Round panel and its Private Companies section say one thing about one held press", () => {
  const LABELS: Record<string, string> = { [F.P1]: "Alice", [F.P2]: "Bob", [F.P3]: "Carol" };
  const label = (address: string) => LABELS[address] ?? address;
  const srBoard = () =>
    F.stockRoundBoard({
      corps: [
        { id: F.PRR, ticker: "PRR", president: F.P1, trains: ["3"], treasury: "500", holdings: [[F.P1, 30], [F.P2, 20]], ipo: 50 },
        { id: F.NYC, ticker: "NYC", president: F.P2, trains: ["2"], treasury: "400", price: 90, holdings: [[F.P2, 30], [F.P3, 10]], ipo: 60 },
      ],
    });
  const QUEUED = linkQueueView({ unsent: 1, unsettled: 1, settled: 0, lastOutcome: null });
  const SENDING = linkQueueView({ unsent: 0, unsettled: 1, settled: 0, lastOutcome: null });

  function drawPanel(linkQueue: LinkQueueView, actionInFlight = true) {
    const state = srBoard();
    render(
      <StockRoundPanel
        publicCompanies={state.public_companies}
        privateCompanies={state.private_companies}
        parValueFor={() => "90"}
        onSelectParValue={() => undefined}
        onBuyShare={() => undefined}
        onSellShares={() => undefined}
        sessionReady
        isMyTurn
        connectedAddress={F.P1}
        macroRoundNumber={state.macro_round_number}
        playerCash={300}
        roundType={"StockRound" as RoundType}
        privateTrade={T.privateTradeSectionModel(state, F.P1, label)}
        privateTradeProposalRefusal={(intent) => T.privateTradeProposalRefusal(state, F.P1, intent, label)}
        onProposePrivateTrade={() => undefined}
        onAnswerPrivateTrade={() => undefined}
        onRescindPrivateTrade={() => undefined}
        actionInFlight={actionInFlight}
        linkQueue={linkQueue}
      />,
    );
    if (!host.querySelector('button[aria-label="PRR — hide share actions"]')) {
      click(host.querySelector('button[aria-label="PRR — show share actions"]'));
    }
  }
  /** The section's busy line, as its private opener carries it. */
  const sectionLine = () => host.querySelector<HTMLButtonElement>(`[data-testid="private-trade-buy-${F.DH}"]`)!.title;
  /** The panel's busy line, as the share Buy carries it. */
  const panelLine = () =>
    buttons().find((button) => /^Buy\b/.test(button.textContent ?? "") && !button.dataset.testid)!.title;

  it("a press the link holds while queued: both say the link's queued sentence", () => {
    drawPanel(QUEUED);
    expect(sectionLine()).toBe(LINK_QUEUED_NOTE);
    expect(panelLine()).toBe(LINK_QUEUED_NOTE);
  });

  it("a press the link is sending: both say the sending sentence; with an idle link the latch's line is unchanged", () => {
    drawPanel(SENDING);
    expect(sectionLine()).toBe(LINK_SENDING_NOTE);
    expect(panelLine()).toBe(LINK_SENDING_NOTE);
    drawPanel(IDLE_LINK_QUEUE_VIEW);
    expect(sectionLine()).toBe("Sending your last action — one moment.");
    expect(panelLine()).toBe("Sending your last action — one moment.");
  });
});

/* ================================================================================================= */
/* AUD-25.10 (d) -- "QUEUED" MEANS ONE THING                                                         */
/* ================================================================================================= */

describe("W3-J AUD-25.10 (d): the M&H status says requested / executed / expired; only the link note says Queued", () => {
  const P1 = "p1";
  const nameFor = (address: string) => (address === P1 ? "Alice" : address);
  const pending = { player: P1, private_id: MH_PRIVATE_ID, company_id: NYC, source: "Ipo" as const };
  /** A reader's board: the M&H open and owned, NYC on the table, the request standing or not. */
  const withRequest = (standing: boolean): GameStateResponse =>
    ({
      private_companies: [
        { private_id: MH_PRIVATE_ID, name: "Mohawk & Hudson", cost: "110", revenue_per_or: "20", owner: P1, owner_protocol_id: null, closed: false },
      ],
      public_companies: [{ company_id: NYC, ticker: "NYC", player_holdings: [] }],
      pending_mh_exchange: standing ? pending : null,
    }) as unknown as GameStateResponse;
  const before = withRequest(false);
  const after = withRequest(true);

  it("every M&H status line -- log, toast, marker, chip, expiry -- avoids 'queued' and keeps its meaning", () => {
    const view = pendingMhExchangeView(after, nameFor)!;
    const chip = withPendingMhExchangeChip([{ abilityKey: "mh-exchange", chipLabel: "MH exchange" }], view)[0];
    const lines = [
      mhExchangeRequestedSentence(after, pending, nameFor),
      mhQueuedAcknowledgement(before, after, P1)!,
      view.marker,
      view.sentence,
      view.chipLabel,
      chip.blockedReason!,
      mhSettlementSentence(after, before, nameFor)!,
    ];
    for (const line of lines) expect(line).not.toMatch(/queue/i);
    expect(lines[0]).toBe(
      "M&H exchange REQUESTED — Alice asked to exchange the Mohawk & Hudson for a 10% share of NYC from the IPO. " +
        "It is requested, not executed yet — it executes at the next turn boundary only if it is still legal then.",
    );
    expect(lines[1]).toContain("is requested, not executed yet. It executes at the next turn boundary only if it is still legal then");
    expect(lines[1]).toContain("nothing is reserved until it does.");
    expect(view.sentence).toContain("Requested, not executed yet — it executes at the next turn boundary");
    // The generic expiry is unchanged (OD-3: no reason recorded, none guessed).
    expect(lines[6]).toBe(`Alice's ${MH_EXCHANGE_EXPIRED_SENTENCE}`);
    expect(MH_EXCHANGE_EXPIRED_SENTENCE).toBe("M&H exchange request expired before it could execute.");
  });

  it("the W3-I link note is the one status line that says Queued", () => {
    expect(LINK_QUEUED_NOTE).toBe("Queued — will send on reconnect.");
    expect(LINK_QUEUED_NOTE).toMatch(/^Queued\b/);
  });
});
