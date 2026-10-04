/** @jest-environment node */
//
// ==================================================================
//  6.5-B HARNESS: THE SHELL'S WIRING FOR THE SIX FIX-BEFORE ITEMS
// ==================================================================
//
// `AppShell` cannot be rendered in a test (App audit F5: not exported, no harness yet), so each fix's BEHAVIOUR is
// proved in its own suite against the component and a real room (`phase65b*.test.tsx`, `phase65bPrivateTradeRoom`),
// using the same pure functions the shell calls. What only the shell's source can show is that it calls them, with
// the right inputs, in the right place -- that is this file.
//
// READS THE SHELL, NOT THE FILE (APP-TEST-0A, Integration Pass 2). Every scan reads `readShell()` -- the
// comment-stripped `App.tsx` plus every future `src/shell/**` module (#490a) -- so each assertion keeps testing the
// wiring after the App decomposition moves it, and cannot pass because the code left `App.tsx`. Every bounded
// region is a `sliceBetween`, which throws on a missing anchor or a region that would cross a file, and every
// ordering is an `expectOrder`, which throws on a missing anchor or anchors in two files. Nothing here reads
// `App.tsx` alone: none of these facts belongs to the composition root.

import { expectOrder, readShell, readStripped, sliceBetween } from "./sourceScan";

const APP = readShell();

describe("K-10: the ordinary private prompt never represents a funding offer", () => {
  it("`privateProposal` is the pure view, which is null for `funding: true`", () => {
    const memo = sliceBetween(APP, "const privateProposal = useMemo<PrivateTradeProposal | null>(", "const privateTradeLabel");
    expect(memo).toContain("ordinaryPrivateProposalView(");
    expect(memo).toContain("gameState?.private_purchase_offer ?? null");
    const VIEW = readStripped("utils/privateProposalView.ts");
    expect(VIEW).toContain("if (offer.funding === true) return null;");
  });

  it("the funding prompt keeps its own answer message", () => {
    expect(APP).toContain("{ AnswerFundingPrivateOffer: { game_id: 0, private_id: privateId, accept } }");
  });
});

describe("K-09: the consent props that now gate Reject as well as Accept are unchanged", () => {
  it("the owner and the selling president, compared by wallet", () => {
    // Phase 3 W1-D (P3-N006): compared against the authority's answerer (`utils/offerConsentView.ts`).
    expect(APP).toContain("viewerIsOwner={privateOfferRoles.viewerIsAnswerer}");
    expect(APP).toContain("viewerIsSeller={trainOfferRoles.viewerIsAnswerer}");
    // K-10's funding prompt: the buying president answers. `phase65bConsentPrompts` renders a copy of this
    // expression, so the shell's own is pinned here (Integration Pass 2 review).
    expect(APP).toContain(
      "viewerIsBuyerPresident={fundingPrivateOffer !== null && fundingPrivateOffer.buyerPresident === viewerAddress}",
    );
  });

  it("both prompts gate Reject on that same prop, with a disabled look (#681)", () => {
    for (const [file, prop] of [
      ["components/PrivateTradePanel.tsx", "viewerIsOwner"],
      ["components/TrainPurchasePanel.tsx", "viewerIsSeller"],
    ] as const) {
      const SOURCE = readStripped(file);
      const reject = sliceBetween(SOURCE, "onClick={onReject}", "Reject\n");
      // Phase 3 W1-D: the gate is `canAnswer` = that prop AND not in flight (the double-send latch).
      expect(reject).toContain("disabled={!canAnswer}");
      expect(reject).toContain("styles.buttonDisabled");
      expect(SOURCE).toContain(`const canAnswer = ${prop} && !actionInFlight;`);
    }
  });
});

describe("K-08: the Stock Round sale verdict asks the sale authority first for an unparred corporation", () => {
  it("`saleBlockFor` is the sale authority itself (Phase 3 W1-A), so the unstarted corporation's rule 4 answers with its own sentence", () => {
    const body = sliceBetween(APP, "const saleBlockFor = useCallback(", "const [marketPeek, setMarketPeek]");
    expect(body).toContain("stockSaleRefusal({");
    expect(body).toContain("actor: viewerAddress,");
    expect(body).toContain("ctx: chartContextFromState(gameState),");
    // The shell-only Sell-Buy-Sell stage refusal is gone (S-4: the server has no such rule).
    expect(body).not.toContain("stockTurnStage(");
    expect(readStripped("gameEngine/stockTransactionAuthority.ts")).toContain("if (company.par_value === null || company.par_value === undefined) {");
  });

  it("the shared `shareSaleBlock` gained no par check of its own", () => {
    expect(readStripped("gameEngine/shareSale.ts")).not.toContain("par_value");
  });
});

describe("H-02: the B&O par prompt is the board's `boParOwedTo`, not a latch", () => {
  it("no latch state, setter or writer survives", () => {
    expect(APP).not.toContain("setBoParPrompt");
    expect(APP).not.toContain("boParPrompt");
    expect(APP).not.toContain("boParAlreadySet");
  });

  it("the owner is derived from the LIVE board (never a scrubbed one), once", () => {
    expect(APP).toContain("const boParOwner = liveState ? boParOwedTo(liveState) : null;");
  });

  it("the prompt, its owner, and the Proceed block all read `boParOwner`", () => {
    const modal = sliceBetween(APP, "<AuctionPromptModal", "/>");
    /* Phase 3 W2-H (OD-1): WAS `boParOwner !== null && boParOwner === viewerAddress` (and its negation for the
       waiting name). Both now read the shared viewer rule over the same `boParOwner`, so a spectator holding the
       owner's wallet is never asked and is told who the table waits on. */
    expect(APP).toContain("const boParViewerIsOwner = viewerIsNamedActor({ spectator, actor: boParOwner, viewerAddress });");
    expect(modal).toContain("parPending={boParViewerIsOwner}");
    expect(modal).toContain("boParOwner !== null && !boParViewerIsOwner");
    expect(modal).toContain("viewerActsOnHandoff={auctionHandoffViewerActs}");
    expect(modal).toContain("onConfirmPar={handleConfirmBoPar}");
  });

  it("the confirm clears nothing before it sends, and sends only for the owner", () => {
    const handler = sliceBetween(APP, "const handleConfirmBoPar = useCallback(", "const handleBuyShare = useCallback(");
    expect(handler).toContain("const winner = boParOwner;");
    expect(handler).toContain("if (!winner || winner !== viewerAddress) return undefined;");
    expect(handler).toContain("{ SetBoPar: { player: winner, par_value: parValue } }");
    expect(handler).toContain("return runGameplayActionRef.current?.(");
  });
});

describe("SI-H01: on the hosted server path the Action Bar's step is the live one", () => {
  it("`displayedSubPhase` comes from `displayedOperatingSubPhase`, told whether a game server is configured", () => {
    const decl = sliceBetween(APP, "const displayedSubPhase = displayedOperatingSubPhase({", "});");
    expect(decl).toContain("hostedServerPath: Boolean(GAME_SERVER_URL),");
    expect(decl).toContain("freezeHolding: autoSkipPending,");
    expect(decl).toContain("live: orSubPhase,");
    // The live step is the board's cursor wherever the board has one.
    expect(APP).toContain("const orSubPhase: OperatingSubPhase = gameState?.operating_sub_phase ?? liveOrSubPhase;");
    // And still exactly one prop reads the displayed step (#1094's line).
    expect(APP).toContain("orSubPhase={displayedSubPhase}");
  });
});

describe("K-01: the Stock Round Private Companies section, its handlers, its prompt and its hold", () => {
  it("the section view, the hold and the proposal predicate are derived from the board; read-only while scrubbing", () => {
    const derived = sliceBetween(APP, "const privateTradeLabel = useCallback(", "const pendingDiscard = useMemo(");
    expect(derived).toContain("privateTradeSectionModel(gameState, scrubbing ? null : viewerAddress, privateTradeLabel)");
    /* Phase 3 W2-F: the share controls' hold is no longer 6.5-B's `privateTradeHoldReason`; it is the shell's one hold
       answer (`dockHoldView`, which reports nothing on a scrubbed board -- the same read-only rule). */
    expect(derived).not.toContain("privateTradeHoldReason(");
    expect(derived).toContain("dockHoldView({ state: gameState, mapGrid, homeHexToAxial, labelFor: privateTradeLabel, scrubbing })");
    expect(derived).toContain("privateTradeProposalRefusal(gameState, viewerAddress, intent, privateTradeLabel)");
  });

  it("the three messages are the shared builders; the answer goes off-turn", () => {
    const handlers = sliceBetween(APP, "const handleProposePrivateTrade = useCallback(", "const handleShowPrivateTradeCard = useCallback(");
    expect(handlers).toContain("proposePrivateTradeMsg(gameId, intent)");
    expect(handlers).toContain("answerPrivateTradeMsg(gameId, privateId, accept)");
    expect(handlers).toContain("{ offTurn: true }");
    expect(handlers).toContain("rescindPrivateTradeMsg(gameId, privateId)");
    // Only the answer is off-turn: the proposal and the rescission are the seat holder's own.
    expect(handlers.split("offTurn: true").length - 1).toBe(1);
  });

  it("the Stock Round panel gets the section and the hold", () => {
    const panel = sliceBetween(APP, "<StockRoundPanel", "/>");
    expect(panel).toContain("privateTrade={privateTradeSection}");
    expect(panel).toContain("privateTradeProposalRefusal={privateTradeProposalRefusalFor}");
    expect(panel).toContain("onProposePrivateTrade={handleProposePrivateTrade}");
    expect(panel).toContain("onAnswerPrivateTrade={handleAnswerPrivateTrade}");
    expect(panel).toContain("onRescindPrivateTrade={handleRescindPrivateTrade}");
    // Phase 3 W2-F: the hold on the share controls is the shell's one hold answer, asked with the kinds they send.
    expect(panel).toContain("offerHoldReason={dockHold.shareControls}");
    expect(panel).toContain("purchaseBlockFor={heldPurchaseBlockFor}");
    expect(panel).toContain("saleBlockFor={heldSaleBlockFor}");
  });

  it("the consent slot carries the pointer, after the other prompts", () => {
    const slot = sliceBetween(APP, "<TrainTradePrompt", "<PlayerPrivateTradePrompt");
    expect(slot).toContain("<PrivateTradePrompt");
    const prompt = sliceBetween(APP, "<PlayerPrivateTradePrompt", "/>");
    expect(prompt).toContain("offer={privateTradeSection?.offer ?? null}");
    expect(prompt).toContain("onAnswer={handleAnswerPrivateTrade}");
    expect(prompt).toContain("onRescind={handleRescindPrivateTrade}");
    expect(prompt).toContain("onShowCard={handleShowPrivateTradeCard}");
  });

  it("Pass is greyed with the hold, first among its reasons", () => {
    // P0 S1: the expression is a plain const above the shell's `return (`; the bar reads it by name.
    expect(APP).toContain("passDisabledReason={passDisabledReason}");
    const pass = sliceBetween(APP, "const passDisabledReason =", "return (");
    /* Phase 3 W2-A (OD-1, P3-N001): the trade offer's hold (and the home station's, whose arm was dead here) is read
       from the ONE hold answer -- `dockHold.pass`, the authority's refusal of `PassTurn` -- ahead of the contest and
       the must-sell reasons. No second derivation of either hold remains in this const. */
    expectOrder(pass, "dockHold.pass ??", "divestmentRefusal(");
    expect(pass).not.toContain("privateTradeHold");
    expect(pass).not.toContain("homeTokenBlock");
  });

  it("the M&H's exchange chip is greyed with the hold (it is not turn-gated, so only the hold refuses it)", () => {
    /* Phase 3 W2-D: the hold is the authority's refusal of `ExchangePrivate` from the shell's one hold answer
       (`dockHold.exchangePrivate`), not 6.5-B's trade-offer-only `privateTradeHoldReason` -- in the Operating Round
       a discard, the funding hold, a train / private offer or the home hold can stand as well. The memo therefore
       sits below `dockHold`, and its end anchor is the binding that now follows it. */
    const memo = sliceBetween(APP, "const stockRoundPowerOffers = useMemo(", "const pendingDiscard = useMemo(");
    expect(memo).toContain("stockRoundExchangeOffers({");
    expect(memo).toContain("const hold = dockHold.exchangePrivate;");
    expect(memo).not.toContain("privateTradeHoldReason");
    expect(memo).toContain("blockedReason: hold");
    const BAR = readStripped("panels/ContextualActionBar.tsx");
    const chips = sliceBetween(BAR, "const powerChips: ActionBarButton[] =", "const powerChipNodes");
    expect(chips).toContain("disabled: (offer.blockedReason ?? null) !== null,");
    expect(chips).toContain("title: offer.blockedReason ?? offer.chipTitle ??");
  });

  it("\"Show on Stocks\" switches to the Stocks tab (the corporation listing)", () => {
    const show = sliceBetween(APP, "const handleShowPrivateTradeCard = useCallback(", "}, []);");
    expect(show).toContain('setActiveMainTab("corps")');
    expect(show).toMatch(/private-trade-card-\$\{privateId\}/); // the card's own id, as a template literal
  });
});

describe("no reducer, authority, version or settlement change rides with this pass", () => {
  it("the rules version was still 11 (moved to 12 only by Route v12 R12-2) and settlement was certified for exactly [10, 11] (12 added only by R12-3, 13 only by the v13 certification)", () => {
    const { RULES_ENGINE_VERSION, RULES_ENGINE_CHANGELOG } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
    const { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } =
      require("../gameEngine/settlementAppraisal") as typeof import("../gameEngine/settlementAppraisal");
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(11);
    // No version was added by this pass: every row after 11 is a later pass's own (R12-2's route repair; Phase 3 W3-K's v13).
    expect(RULES_ENGINE_CHANGELOG.filter((row) => row.version > 11).every((row) => /^(Route v12 R12-2|Phase 3 W3-K)/.test(row.note))).toBe(true);
    // No settlement version was added by this pass: 12 is R12-3's own certification, 13 Phase 3's dedicated v13 one.
    expect([...SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS]).toEqual([10, 11, 12, 13]);
  });
});
