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
// WRITTEN CONSERVATIVELY for the APP-TEST-0A reader migration (not merged; not depended on): every scan reads the
// comment-stripped `App.tsx` (`readStripped`, #490a) and every bounded region is taken with `sliceBetween`, which
// throws on a missing anchor, so nothing here can pass against an empty slice. When `readShell()` lands, the reads
// convert one-for-one.

import { readStripped, sliceBetween } from "./sourceScan";

const APP = readStripped("App.tsx");

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
    expect(APP).toContain("viewerIsOwner={privateProposal?.ownerAddress === viewerAddress}");
    expect(APP).toContain("liveTrainOffer !== null || sandboxTrainProposal?.sellerPresident === viewerAddress");
  });

  it("both prompts gate Reject on that same prop, with a disabled look (#681)", () => {
    for (const [file, prop] of [
      ["components/PrivateTradePanel.tsx", "viewerIsOwner"],
      ["components/TrainPurchasePanel.tsx", "viewerIsSeller"],
    ] as const) {
      const SOURCE = readStripped(file);
      const reject = sliceBetween(SOURCE, "onClick={onReject}", "Reject\n");
      expect(reject).toContain(`disabled={!${prop}}`);
      expect(reject).toContain("styles.buttonDisabled");
    }
  });
});

describe("K-08: the Stock Round sale verdict asks the sale authority first for an unparred corporation", () => {
  it("`saleBlockFor` = the Sell-Buy-Sell stage gate, then `unstartedCorporationSaleRefusal`, then `shareSaleBlock`", () => {
    const body = sliceBetween(APP, "const saleBlockFor = useCallback(", "const [marketPeek, setMarketPeek]");
    const stage = body.indexOf('stockTurnStage(gameState) === "buy"');
    const unstarted = body.indexOf("unstartedCorporationSaleRefusal({ state: gameState, seller: viewerAddress, companyId, percentage })");
    const shared = body.indexOf("return shareSaleBlock({ state: gameState, seller: viewerAddress, companyId, percentage });");
    expect(stage).toBeGreaterThan(-1);
    expect(unstarted).toBeGreaterThan(stage);
    expect(shared).toBeGreaterThan(unstarted);
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
    expect(modal).toContain("parPending={boParOwner !== null && boParOwner === viewerAddress}");
    expect(modal).toContain("boParOwner !== null && boParOwner !== viewerAddress");
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
    expect(derived).toContain("scrubbing ? null : privateTradeHoldReason(gameState, privateTradeLabel)");
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
    expect(panel).toContain("offerHoldReason={privateTradeHold}");
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

  it("Pass is greyed with the hold, right after the home-token block", () => {
    const pass = sliceBetween(APP, "passDisabledReason={", "turnActionTaken=");
    const home = pass.indexOf("homeTokenBlock({");
    const hold = pass.indexOf("privateTradeHold ??");
    expect(home).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(home);
  });

  it("the M&H's Stock Round exchange chip is greyed with the hold (it is not turn-gated, so only the hold refuses it)", () => {
    const memo = sliceBetween(APP, "const stockRoundPowerOffers = useMemo(", "const privatePowerOffersRef");
    expect(memo).toContain("stockRoundExchangeOffers({");
    expect(memo).toContain("privateTradeHoldReason(gameState,");
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
  it("the rules version is still 11 and settlement is still certified for exactly [10, 11]", () => {
    const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
    const { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } =
      require("../gameEngine/settlementAppraisal") as typeof import("../gameEngine/settlementAppraisal");
    expect(RULES_ENGINE_VERSION).toBe(11);
    expect([...SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS]).toEqual([10, 11]);
  });
});
