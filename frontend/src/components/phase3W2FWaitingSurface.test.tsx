/**
 * Phase 3 W2-F — one "waiting on X" surface (OD-1).
 *
 *   AUD-09.09 (U-6)  every consent prompt prints ONE waiting line: who decides, and the authority's own hold sentence
 *                    (`describeStandingOffer` inside `pendingOfferBlock`, the funding offer's `emergencyFundingBlock`),
 *                    the same sentence on every seat -- the shell's one hold answer, `dockHold.turnHoldReason`.
 *   AUD-09.08 (U-5)  the excess-train discard prompt joins it (`pendingDiscardBlock`).
 *   AUD-03.10 (I-3)  the fixed pointer never covers the Private Companies card: on the Stocks tab, where that section
 *                    carries the offer itself, the pointer stands aside.
 *   Residue (W2-A)   the Stock Round share controls read the one hold answer, asked with the kinds they send
 *                    (`BuyStock`, `SellStock`), instead of 6.5-B's `privateTradeHoldReason`.
 *
 * Boards are real (the Batch-7.4 fixtures, offers made through the reducer); sentences are asked of the authority and
 * compared, never retyped.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import StockRoundPanel from "./StockRoundPanel";
import { PrivateTradePrompt } from "./PrivateTradePanel";
import { FundingPrivateOfferPrompt, TrainDiscardPrompt, TrainTradePrompt } from "./TrainPurchasePanel";
import { PlayerPrivateTradePrompt } from "./PrivateCompaniesSection";
import { waitingOnLead } from "./WaitingOnLine";
import type { MapGridResponse } from "./hexContractTypes";
import type { GameStateResponse, RoundType } from "../gameEngine/gameState";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import { authoritativeHoldRefusal } from "../gameEngine/authoritativeHolds";
import { describeStandingOffer, standingOrdinaryOffer } from "../gameEngine/pendingOfferHold";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { chartContextFromState, stockPurchaseRefusal, stockSaleRefusal } from "../gameEngine/stockTransactionAuthority";
import { resolveVariants } from "../gameEngine/gameVariants";
import { routeRulesRevisionOf, withRules } from "../gameEngine/boardSelection";
import { dockHoldView, heldFirst, NO_DOCK_HOLD, type DockHoldView } from "../utils/dockHoldView";
import { CA, DH, MH, operatingBoard, stockRoundBoard } from "../utils/offerFixtures74";
import { apply, corridor, fundingBoard, GRID, M, NYC, P1, P2, P3, PRR, CO, withCorp, withState } from "../utils/offerMatrix74Support";
import { labelSentence, privateTradeSectionModel } from "../utils/stockRoundPrivateTrade";
import { readStripped, sliceBetween } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const LABELS: Record<string, string> = { [P1]: "Ann", [P2]: "Ben", [P3]: "Cy" };
const labelFor = (address: string) => LABELS[address] ?? address;

/* ---- boards (the W2-A matrix's, so the two suites judge the same tables) ----------------------------------------- */

const orBoard = () =>
  operatingBoard({
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: CA, owner: P3, cost: "160" },
      { id: MH, owner: P1, cost: "110" },
    ],
  });
const srBoard = () =>
  stockRoundBoard({
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]], ipo: 50 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, holdings: [[P2, 30], [P3, 10], [P1, 10]], ipo: 50 },
    ],
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: CA, owner: P3, cost: "160" },
      { id: MH, owner: P1, cost: "110" },
    ],
  });
const PRIVATE_OFFERED = () => apply(orBoard(), M.proposePrivate(DH, PRR, 100), P1);
const TRAIN_OFFERED = () => apply(orBoard(), M.proposeTrain(NYC, PRR, "3", "150"), P1);
const TRADE_OFFERED = () => apply(srBoard(), M.proposeTrade(DH, P2, P1, 50), P1);
const HOME_OWED = () => withCorp(orBoard(), PRR, { home_hex_label: "H12", station_token_hexes: [], station_tokens: [] });
const DISCARD_OWED = () =>
  withCorp(withCorp(operatingBoard(), PRR, { owned_trains: ["4"] }), CO, { owned_trains: ["3", "3", "3", "3"] });
const FORCED = () => fundingBoard(100, { privates: [{ id: DH, owner: P1, cost: "70" }] });
const FUNDING_OFFERED = () =>
  ({
    ...FORCED(),
    private_purchase_offer: {
      private_id: DH,
      private_name: "Delaware & Hudson",
      owner: P1,
      buyer_protocol_id: NYC,
      buyer_ticker: "NYC",
      price: 70,
      funding: true as const,
    },
  }) as GameStateResponse;
const ENDED = () => withState(operatingBoard(), { current_round_type: "GameEnd" });

const viewOf = (state: GameStateResponse, grid: MapGridResponse = GRID, scrubbing = false): DockHoldView =>
  dockHoldView({ state, mapGrid: grid, homeHexToAxial: boardHomeHexToAxial, labelFor, scrubbing });
/** The authority's own sentence for a message, with names for seat ids -- what every surface must print. */
const authority = (state: GameStateResponse, msg: SandboxLogMsg, grid: MapGridResponse = GRID) => {
  const held = authoritativeHoldRefusal(state, msg, { mapGrid: grid, homeHexToAxial: boardHomeHexToAxial });
  return held === null ? null : labelSentence(held, state.player_addresses ?? [], labelFor);
};
const BUY = { BuyStock: { game_id: 1, protocol_id: NYC, source: "Ipo", par_value: null } } as unknown as SandboxLogMsg;
const SELL = { SellStock: { game_id: 1, protocol_id: NYC, percentage: 10 } } as unknown as SandboxLogMsg;
const PASS = { PassTurn: { game_id: 1 } } as unknown as SandboxLogMsg;

/* ---- rendering -------------------------------------------------------------------------------------------------- */

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
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const line = () => q("waiting-on-line")?.textContent ?? null;
const who = () => q("waiting-on-who")?.textContent ?? null;
const sentence = () => q("waiting-on-sentence")?.textContent ?? null;

/* ================================================================================================================ */
describe("Residue: the Stock Round share controls read the one hold answer, asked with the kinds they send", () => {
  it("no hold: Buy, Sell and the panel flag are all null (ordinary behaviour untouched)", () => {
    const view = viewOf(srBoard());
    expect([view.buyStock, view.sellStock, view.shareControls]).toEqual([null, null, null]);
  });

  it("the player trade offer refuses both kinds: the flag carries the authority's sentence", () => {
    const board = TRADE_OFFERED();
    const view = viewOf(board);
    const buy = authority(board, BUY);
    expect(buy).toMatch(/between Ben and Ann for \$50 and is waiting for an answer; nothing else can happen until it is answered or withdrawn\.$/);
    expect(view.buyStock).toBe(buy);
    expect(view.sellStock).toBe(authority(board, SELL));
    expect(view.shareControls).toBe(buy);
  });

  it.each([
    ["standing private purchase offer", PRIVATE_OFFERED, GRID],
    ["standing train purchase offer", TRAIN_OFFERED, GRID],
    ["excess-train discard", DISCARD_OWED, GRID],
    ["home-station obligation", HOME_OWED, GRID],
    ["funding private offer", FUNDING_OFFERED, corridor()],
    ["finished game", ENDED, GRID],
  ] as const)("%s: each kind is the authority's answer for exactly that message", (_label, make, grid) => {
    const board = make();
    const view = viewOf(board, grid);
    expect(view.buyStock).toBe(authority(board, BUY, grid));
    expect(view.sellStock).toBe(authority(board, SELL, grid));
    expect(view.buyStock).not.toBeNull();
    expect(view.shareControls).toBe(view.sellStock === null ? null : view.buyStock);
  });

  it("an unrelated hold does not grey an unrelated control: the v12 funding obligation refuses Buy and lets Sell through", () => {
    const board = FORCED();
    const view = viewOf(board, corridor());
    expect(view.buyStock).toBe(authority(board, BUY, corridor()));
    expect(view.buyStock).toMatch(/must buy a 3-train/);
    // The forced sale is one way out of the obligation, so the hold passes `SellStock` (its own legality is judged elsewhere).
    expect(view.sellStock).toBeNull();
    expect(authority(board, SELL, corridor())).toBeNull();
    // ...so the panel's single flag stays clear, and only Buy is greyed -- on its own control.
    expect(view.shareControls).toBeNull();
    expect(heldFirst(view.buyStock, () => null)).toBe(view.buyStock);
    expect(heldFirst(view.sellStock, () => "the sale's own answer")).toBe("the sale's own answer");
  });

  it("scrubbing a past board reports no hold (the same read-only rule as before): fail-safe, nothing invented", () => {
    const view = viewOf(TRADE_OFFERED(), GRID, true);
    expect(view).toBe(NO_DOCK_HOLD);
    expect([view.buyStock, view.sellStock, view.shareControls]).toEqual([null, null, null]);
  });

  it("heldFirst asks the hold first and the control's own authority only when no hold refuses it", () => {
    const own = jest.fn(() => "own");
    expect(heldFirst("held", own)).toBe("held");
    expect(own).not.toHaveBeenCalled();
    expect(heldFirst(null, own)).toBe("own");
    expect(own).toHaveBeenCalledTimes(1);
  });
});

describe("Residue, rendered: the real Stock Round panel greys each share control with the authority's sentence", () => {
  const PAR = "90";
  function draw(state: GameStateResponse, view: DockHoldView, viewer = P1) {
    const scoped = (ask: () => string | null) => withRules(resolveVariants(state.variants), ask, routeRulesRevisionOf(state));
    /* The shell's composition (App's `heldPurchaseBlockFor` / `heldSaleBlockFor`): the hold first, then the stock
       authority. */
    const purchaseBlockFor = (companyId: number, source: "Ipo" | "Bank", quantity: number, certificate?: "double") =>
      heldFirst(view.buyStock, () =>
        scoped(() =>
          stockPurchaseRefusal({
            state,
            buy: { companyId, source, parValue: source === "Ipo" ? PAR : null, quantity: certificate === "double" ? null : quantity, certificate: certificate ?? null },
            actor: viewer,
            ctx: chartContextFromState(state),
          }),
        ),
      );
    const saleBlockFor = (companyId: number, percentage: number) =>
      heldFirst(view.sellStock, () =>
        scoped(() => stockSaleRefusal({ state, sell: { companyId, percentage }, actor: viewer, ctx: chartContextFromState(state) })),
      );
    render(
      <StockRoundPanel
        publicCompanies={state.public_companies}
        privateCompanies={state.private_companies}
        parValueFor={() => PAR}
        onSelectParValue={() => undefined}
        onBuyShare={() => undefined}
        onSellShares={() => undefined}
        sessionReady
        isMyTurn
        connectedAddress={viewer}
        macroRoundNumber={state.macro_round_number}
        playerCash={1000}
        roundType={"StockRound" as RoundType}
        purchaseBlockFor={purchaseBlockFor}
        saleBlockFor={saleBlockFor}
        offerHoldReason={view.shareControls}
      />,
    );
  }
  const open = (ticker: string) => {
    if (host.querySelector(`button[aria-label="${ticker} — hide share actions"]`)) return;
    act(() => {
      host.querySelector(`button[aria-label="${ticker} — show share actions"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
  const buy = () => buttons().find((node) => /^Buy (1 share|\d+ shares|President's Certificate)/.test(node.textContent ?? ""));
  const sell = () => buttons().find((node) => /^Sell \d+% Bundle$/.test(node.textContent ?? ""));

  it("no hold: Buy and Sell are live, and no hold notice is drawn", () => {
    const board = srBoard();
    draw(board, viewOf(board));
    open("NYC");
    expect(q("stock-round-offer-hold")).toBeNull();
    expect(buy()?.disabled).toBe(false);
    expect(sell()?.disabled).toBe(false);
  });

  it("the trade offer's hold greys Buy and Sell with the authority's sentence, said once at the top", () => {
    const board = TRADE_OFFERED();
    const view = viewOf(board);
    draw(board, view);
    open("NYC");
    expect(q("stock-round-offer-hold")?.textContent).toBe(view.shareControls);
    expect([buy()?.disabled, buy()?.title]).toEqual([true, authority(board, BUY)]);
    expect([sell()?.disabled, sell()?.title]).toEqual([true, authority(board, SELL)]);
  });

  it("a hold that refuses one kind greys that control alone: Sell stays live, Buy carries the sentence", () => {
    const board = srBoard();
    const view: DockHoldView = { ...NO_DOCK_HOLD, buyStock: "Only buying is held." };
    draw(board, view);
    open("NYC");
    expect(q("stock-round-offer-hold")).toBeNull();
    expect([buy()?.disabled, buy()?.title]).toEqual([true, "Only buying is held."]);
    expect(sell()?.disabled).toBe(false);
  });
});

/* ================================================================================================================ */
describe("AUD-09.09 (U-6): every offer prompt prints one waiting line -- who decides, and the hold's own sentence", () => {
  it("the private purchase offer: the sentence is `describeStandingOffer`'s, the same on every seat", () => {
    const board = PRIVATE_OFFERED();
    const hold = viewOf(board).turnHoldReason!;
    const standing = standingOrdinaryOffer(board)!;
    expect(hold.startsWith(describeStandingOffer(standing))).toBe(true);
    const proposal = { privateId: DH, privateName: "Delaware & Hudson", ownerAddress: P2, ownerLabel: "Ben", buyerProtocolId: PRR, buyerTicker: "PRR", price: 100 };
    for (const [viewerIsOwner, viewerIsProposer, lead] of [
      [true, false, "This is Ben's decision."],
      [false, true, "Waiting on Ben."],
      [false, false, "Waiting on Ben."],
    ] as const) {
      render(
        <PrivateTradePrompt
          proposal={proposal}
          viewerIsOwner={viewerIsOwner}
          viewerIsProposer={viewerIsProposer}
          consentIsBinding
          onAccept={() => undefined}
          onReject={() => undefined}
          onRescind={() => undefined}
          waitingSentence={hold}
        />,
      );
      expect([who(), sentence()]).toEqual([lead, hold]);
      // The proposer's withdrawal is the button, not a second spelling of the waiting line.
      expect(q("private-offer-rescind") !== null).toBe(viewerIsProposer);
    }
  });

  it("the train purchase offer: the selling president decides; every seat reads the hold", () => {
    const board = TRAIN_OFFERED();
    const hold = viewOf(board).turnHoldReason!;
    expect(hold).toMatch(/^PRR's offer of \$150 for NYC's 3-train is waiting for the selling president's answer; nothing else can happen until it is answered or withdrawn\.$/);
    const proposal = {
      sellerProtocolId: NYC,
      sellerTicker: "NYC",
      sellerPresident: P2,
      sellerPresidentLabel: "Ben",
      buyerProtocolId: PRR,
      buyerTicker: "PRR",
      modelType: "3",
      price: "150",
    };
    for (const [viewerIsSeller, lead] of [
      [true, "This is Ben's decision."],
      [false, "Waiting on Ben."],
    ] as const) {
      render(
        <TrainTradePrompt
          proposal={proposal}
          viewerIsSeller={viewerIsSeller}
          viewerIsProposer={!viewerIsSeller}
          onAccept={() => undefined}
          onReject={() => undefined}
          onRescind={() => undefined}
          waitingSentence={hold}
        />,
      );
      expect([who(), sentence()]).toEqual([lead, hold]);
    }
  });

  it("the emergency funding offer: its own hold sentence (`emergencyFundingBlock`), not an invented one", () => {
    const board = FUNDING_OFFERED();
    const hold = viewOf(board, corridor()).turnHoldReason!;
    expect(hold).toBe(authority(board, PASS, corridor()));
    expect(hold).toMatch(/is on offer to NYC; nothing else can happen until its president answers or the seller withdraws\.$/);
    const offer = { privateId: DH, privateName: "Delaware & Hudson", sellerLabel: "Ann", buyerTicker: "NYC", buyerPresidentLabel: "Ben", price: 70 };
    render(<FundingPrivateOfferPrompt offer={offer} viewerIsBuyerPresident={false} onAnswer={() => undefined} waitingSentence={hold} />);
    expect([who(), sentence()]).toEqual(["Waiting on Ben.", hold]);
    render(<FundingPrivateOfferPrompt offer={offer} viewerIsBuyerPresident onAnswer={() => undefined} waitingSentence={hold} />);
    expect([who(), sentence()]).toEqual(["This is Ben's decision.", hold]);
  });

  it("the player <-> player trade pointer: the recipient decides; the proposer and a third seat wait on them", () => {
    const board = TRADE_OFFERED();
    const hold = viewOf(board).turnHoldReason!;
    expect(hold).toBe(viewOf(board).shareControls);
    for (const [viewer, lead] of [
      [P2, "This is your decision."],
      [P1, "Waiting on Ben."],
      [P3, "Waiting on Ben."],
    ] as const) {
      const offer = privateTradeSectionModel(board, viewer, labelFor)!.offer!;
      render(
        <PlayerPrivateTradePrompt
          offer={offer}
          answerBlockedReason={null}
          onAnswer={() => undefined}
          onRescind={() => undefined}
          onShowCard={() => undefined}
          waitingSentence={hold}
        />,
      );
      expect([who(), sentence()]).toEqual([lead, hold]);
    }
  });

  it("no hold reported (a scrubbed board) prints the who-line alone -- never a guessed sentence", () => {
    const proposal = { privateId: DH, privateName: "Delaware & Hudson", ownerAddress: P2, ownerLabel: "Ben", buyerProtocolId: PRR, buyerTicker: "PRR", price: 100 };
    render(
      <PrivateTradePrompt proposal={proposal} viewerIsOwner={false} consentIsBinding onAccept={() => undefined} onReject={() => undefined} waitingSentence={null} />,
    );
    expect(line()).toBe("Waiting on Ben.");
    expect(sentence()).toBeNull();
    expect(waitingOnLead("Ben", false)).toBe("Waiting on Ben.");
    expect(waitingOnLead("Ben", true)).toBe("This is Ben's decision.");
    expect(waitingOnLead("you", true)).toBe("This is your decision.");
  });
});

describe("AUD-09.08 (U-5): the discard prompt joins the one waiting line", () => {
  it("every seat reads the discard hold's own sentence; only the president gets the instruction and live buttons", () => {
    const board = DISCARD_OWED();
    const hold = viewOf(board).turnHoldReason!;
    expect(hold).toBe("C&O holds 1 train more than the limit of 3; C&O's president must discard before anything else happens.");
    const due = { ticker: "C&O", limit: 3, excess: 1, choices: ["3", "3", "3", "3"], presidentLabel: "Cy" };
    render(<TrainDiscardPrompt due={due} viewerIsPresident={false} onDiscard={() => undefined} waitingSentence={hold} />);
    expect([who(), sentence()]).toEqual(["Waiting on Cy.", hold]);
    expect(host.textContent).not.toContain("Choose the train to discard.");
    expect(Array.from(host.querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
    render(<TrainDiscardPrompt due={due} viewerIsPresident onDiscard={() => undefined} waitingSentence={hold} />);
    expect([who(), sentence()]).toEqual(["This is Cy's decision.", hold]);
    expect(host.textContent).toContain("Choose the train to discard.");
    expect(Array.from(host.querySelectorAll("button")).some((button) => !button.disabled)).toBe(true);
  });
});

describe("AUD-03.10 (I-3): the pointer never covers the Private Companies card", () => {
  it("stands aside while the Private Companies section is on screen, and shows exactly as before elsewhere", () => {
    const board = TRADE_OFFERED();
    const offer = privateTradeSectionModel(board, P3, labelFor)!.offer!;
    const pointer = (standAside: boolean) =>
      render(
        <PlayerPrivateTradePrompt
          offer={offer}
          answerBlockedReason={null}
          onAnswer={() => undefined}
          onRescind={() => undefined}
          onShowCard={() => undefined}
          waitingSentence={viewOf(board).turnHoldReason}
          standAside={standAside}
        />,
      );
    pointer(true);
    expect(q("player-private-trade-prompt")).toBeNull();
    pointer(false);
    expect(q("player-private-trade-prompt")).not.toBeNull();
    expect(q("player-private-trade-show")).not.toBeNull();
  });
});

/* ================================================================================================================ */
describe("the shell's wiring (source pins over the comment-stripped App)", () => {
  const APP = readStripped("App.tsx");

  it("every prompt in the consent slot is handed the one hold sentence", () => {
    for (const prompt of ["<TrainTradePrompt", "<FundingPrivateOfferPrompt", "<TrainDiscardPrompt", "<PrivateTradePrompt", "<PlayerPrivateTradePrompt"]) {
      expect(sliceBetween(APP, prompt, "/>")).toContain("waitingSentence={dockHold.turnHoldReason}");
    }
  });

  it("the pointer stands aside exactly where the Private Companies section is drawn (the Stocks tab, a Stock Round model)", () => {
    expect(sliceBetween(APP, "<PlayerPrivateTradePrompt", "/>")).toContain('standAside={activeMainTab === "corps" && privateTradeSection !== null}');
    expect(APP).toMatch(/\{activeMainTab === "corps" && \(\s*<StockRoundPanel/);
  });

  it("no stale `privateTradeHoldReason` path remains on the share controls", () => {
    expect(APP).not.toContain("privateTradeHoldReason");
    expect(APP).not.toContain("privateTradeHold");
    const panel = sliceBetween(APP, "<StockRoundPanel", "/>");
    expect(panel).toContain("offerHoldReason={dockHold.shareControls}");
    expect(panel).toContain("purchaseBlockFor={heldPurchaseBlockFor}");
    expect(panel).toContain("saleBlockFor={heldSaleBlockFor}");
    const held = sliceBetween(APP, "const heldPurchaseBlockFor = useCallback(", "[dockHold.sellStock, saleBlockFor]");
    expect(held).toContain("heldFirst(dockHold.buyStock, () => purchaseBlockFor(companyId, source, quantity, certificate))");
    expect(held).toContain("heldFirst(dockHold.sellStock, () => saleBlockFor(companyId, percentage))");
  });

  it("Auto-Buy still asks the stock authority itself (W2-B unchanged)", () => {
    expect(APP).toContain("(companyId, source) => purchaseBlockFor(companyId, source, 1)");
    expect(APP).not.toContain("heldPurchaseBlockFor(companyId, source, 1)");
  });
});
