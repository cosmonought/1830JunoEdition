/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W2-B (OD-2, RULES v13): ONE "PASS TURN", ONE MESSAGE, ONE TURN
// ==================================================================
//
// AUD-03.04 (SBS-1 / SBS-2, the presentation half) and AUD-03.07. The owner's OD-2 rule: sell whenever legal; at most
// one ordinary Buy; after it Buy is unavailable and Sell stays legal; ONE control named "Pass Turn" ends the turn in
// ONE click; only an untouched turn's Pass is a true pass. Rules revision 2 made that the reducer's (W3-K); this file
// proves the shell presents it and sends nothing else:
//
//   1. the bar draws one "Pass Turn" and no stage walk, whatever the turn has done;
//   2. one click sends one `PassTurn` -- driven through the real bar into the real reducer -- and that one message
//      ends an untouched turn as a true pass and an acted turn without counting; nothing else on the bar sends one;
//   3. Sell / Buy availability on the Stocks tab is the stock authority's: after the one Buy, Buy greys with the
//      authority's sentence and Sell stays live;
//   4. W2-A's holds and the must-sell debt still grey the one Pass, and a greyed Pass sends nothing;
//   5. the must-sell banner is the authority's debt, said once at the top of the panel;
//   6. Auto-Buy sends no stage Pass: it buys from the turn's first moment, then ends the bought turn with ONE Pass.

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

import ContextualActionBar from "./ContextualActionBar";
import StockRoundPanel from "../components/StockRoundPanel";
import { applySandboxAction, stockTurnStage } from "../gameEngine/sandboxSession";
import { CURRENT_RULES_REVISION, STANDARD_VARIANTS, resolveVariants } from "../gameEngine/gameVariants";
import { chartContextFromState, stockPurchaseRefusal, stockSaleRefusal } from "../gameEngine/stockTransactionAuthority";
import { marketCellForPrice } from "../gameEngine/marketGeometry";
import { chartForDivestment, divestmentDebt, divestmentPassRefusal, divestmentRefusal } from "../gameEngine/forcedDivestment";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { routeRulesRevisionOf, withRules } from "../gameEngine/boardSelection";
import { PASS_LABEL, passButtonTitle } from "../gameEngine/turnAction";
import { armAutoBuy, autoBuyDecision, autoBuyTurnStep } from "../utils/autoBuy";
import { mustSellBannerOf } from "../utils/mustSellBanner";
import { expectOrder, readShell, readStripped, sliceBetween } from "../utils/sourceScan";
import type { GameStateResponse, RoundType } from "../gameEngine/gameState";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* ---- a v13 Stock Round (pin 13, rules revision 2), the shape `rulesV13StockRound.test.ts` uses ------------------- */

const SEATS = ["p0", "p1", "p2", "p3"];
const PRR = 1;
const NYC = 3;
const HOLD =
  "PRR's offer of $150 for NYC's 3-train is waiting for the selling president's answer; nothing else can happen until it is answered or withdrawn.";

function mark(company_id: number, price: number, enteredAt: number) {
  const cell = marketCellForPrice(price);
  if (!cell) throw new Error(`no cell for ${price}`);
  return { x: cell.x, y: cell.y, price, enteredAt, company_id };
}

/** PRR Normal ($100; 30% in its IPO, 10% in its pool), NYC Normal ($90); p0 holds PRR 20% and NYC 10%. */
function board(over: Partial<GameStateResponse> = {}, rules = CURRENT_RULES_REVISION): GameStateResponse {
  return {
    player_addresses: SEATS,
    player_cash: SEATS.map((player) => ({ player, cash_vgp: "2000" })),
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 4,
    active_player_index: 0,
    consecutive_passes: 0,
    priority_deal_index: 0,
    last_trader_index: null,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    rules_engine_version: rules >= 2 ? 13 : 12,
    variants: { ...STANDARD_VARIANTS, rules },
    public_companies: [
      {
        company_id: PRR, ticker: "PRR", president: "p1", par_value: "100", is_floated: true,
        ipo_pool_percentage: 30, bank_pool_percentage: 10,
        player_holdings: [ { player: "p0", percentage: 20 }, { player: "p1", percentage: 40 } ],
        station_token_hexes: [],
      },
      {
        company_id: NYC, ticker: "NYC", president: "p3", par_value: "90", is_floated: true,
        ipo_pool_percentage: 40, bank_pool_percentage: 0,
        player_holdings: [ { player: "p0", percentage: 10 }, { player: "p3", percentage: 50 } ],
        station_token_hexes: [],
      },
    ],
    market_positions: { [PRR]: mark(PRR, 100, 1), [NYC]: mark(NYC, 90, 2) },
    ...over,
  } as unknown as GameStateResponse;
}

/** p0 holds 70% of PRR with its token in the Normal zone: a curable excess over the 60% cap (the must-sell debt). */
function overCap(): GameStateResponse {
  const base = board();
  return {
    ...base,
    public_companies: base.public_companies.map((company) =>
      company.company_id === PRR
        ? { ...company, president: "p0", ipo_pool_percentage: 0, bank_pool_percentage: 0, player_holdings: [{ player: "p0", percentage: 70 }, { player: "p1", percentage: 30 }] }
        : company,
    ),
  } as GameStateResponse;
}

const seatOf = (s: GameStateResponse) => s.player_addresses[s.active_player_index];
const ctxOf = (s: GameStateResponse) => {
  const chart = chartContextFromState(s);
  return { actor: seatOf(s), marketZoneFor: chart.marketZoneFor, marketPricesByCompany: chart.marketPricesByCompany, zoneForPrice: chart.zoneForPrice } as never;
};
type Msg = Record<string, unknown>;
const PASS: Msg = { PassTurn: { game_id: 1 } };
const BUY = (id: number, source: "Ipo" | "Bank"): Msg => ({ BuyStock: { game_id: 1, protocol_id: id, source } });
const SELL = (id: number, percentage = 10): Msg => ({ SellStock: { game_id: 1, protocol_id: id, percentage } });
const apply = (s: GameStateResponse, msg: Msg) => applySandboxAction(s, msg as never, ctxOf(s));
const holding = (s: GameStateResponse, id: number, who = "p0") =>
  s.public_companies.find((c) => c.company_id === id)!.player_holdings.find((h) => h.player === who)?.percentage ?? 0;
const ingress = (s: GameStateResponse, actor: string, msg: Msg) => turnRefusal({ state: s, waterfall: null, actor, msg: msg as never });

/** The shell's composition of the stock gates (`App.purchaseBlockFor` / `App.saleBlockFor`), for the viewer. */
function gates(state: GameStateResponse, viewer: string) {
  const scoped = (ask: () => string | null) => withRules(resolveVariants(state.variants), ask, routeRulesRevisionOf(state));
  return {
    purchaseBlockFor: (companyId: number, source: "Ipo" | "Bank", quantity: number) =>
      scoped(() =>
        stockPurchaseRefusal({
          state,
          buy: { companyId, source, parValue: null, quantity, certificate: null },
          actor: viewer,
          ctx: chartContextFromState(state),
        }),
      ),
    saleBlockFor: (companyId: number, percentage: number) =>
      scoped(() => stockSaleRefusal({ state, sell: { companyId, percentage }, actor: viewer, ctx: chartContextFromState(state) })),
  };
}

/** The shell's Pass gate for the viewer (`App.passDisabledReason`): the hold first, then the must-sell debt. */
const passGate = (state: GameStateResponse, viewer: string, hold: string | null = null) =>
  hold ?? divestmentRefusal(divestmentDebt({ state, player: viewer, ...chartForDivestment(state) }));

/* ---- rendering ---------------------------------------------------------------------------------------------------- */

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

type BarProps = ComponentProps<typeof ContextualActionBar>;
const noop = () => undefined;

/** The bar as the shell mounts it in a Stock Round, read off `state` for `viewer`. */
function barProps(state: GameStateResponse, viewer: string, onPassTurn: () => void, hold: string | null = null): BarProps {
  const mine = seatOf(state) === viewer;
  return {
    roundType: state.current_round_type as RoundType,
    orSubPhase: "Track", // read only in an Operating Round
    sessionReady: mine,
    isMyTurn: mine,
    onPassTurn,
    passDisabledReason: passGate(state, viewer, hold),
    turnHoldReason: hold,
    turnActionTaken: state.turn_action_taken === true,
    onPlaceStationTokenHint: noop,
    stationTokenCost: 40,
    activeCorporation: null,
    onSkipSubPhase: noop,
    onOpenPrivateTrade: noop,
    ownsAnyTrain: false,
    mustBuyTrain: false,
    activePlayerName: viewer,
    activePlayerCash: 2000,
    activePlayerEscrow: 0,
    privateCompanies: [],
    onRunTrains: noop,
    onPayDividends: noop,
    onWithholdRevenue: noop,
    dividendRevenue: 0,
    dividendRevenueIsThisTurn: false,
    dividendPerShare: 0,
    dividendPayouts: [],
    rustOutlookForBar: null,
    dividendPrice: null,
    payProjection: null,
    withholdProjection: null,
    selectedHardwareModel: "2",
    onEndOperatingTurn: noop,
    onUndoLastAction: noop,
    onAutoRoute: noop,
    onSelectRouteTrain: noop,
    highlightedRouteIndex: null,
    onHighlightRoute: noop,
    trainDrafts: [],
    activeTrainIndex: 0,
    routeFeedback: null,
    onClearRoute: noop,
    currentGlobalEra: null,
    maxRouteRevenue: 0,
  } as BarProps;
}

function renderBar(props: BarProps) {
  act(() => root.render(<ContextualActionBar {...props} />));
}

const click = (node: Element | null) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const allButtons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
const text = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
const passButtons = () => allButtons().filter((button) => button.getAttribute("data-testid") === "pass-turn-button");
const passButton = () => {
  const found = passButtons();
  expect(found).toHaveLength(1);
  return found[0];
};

/** The table: a board, the messages the viewer's UI sent, and the reducer applying each one. */
function table(start: GameStateResponse) {
  const sent: string[] = [];
  let state = start;
  const dispatch = (msg: Msg) => {
    sent.push(Object.keys(msg)[0]);
    state = apply(state, msg);
  };
  return {
    sent,
    dispatch,
    get state() {
      return state;
    },
  };
}

/* ================================================================================================================ */
describe("1. the bar draws one Pass Turn and no stage walk", () => {
  const turns: ReadonlyArray<[string, (s: GameStateResponse) => GameStateResponse]> = [
    ["an untouched turn", (s) => s],
    ["after a sale", (s) => apply(s, SELL(NYC))],
    ["after the one Buy", (s) => apply(s, BUY(PRR, "Ipo"))],
    ["after a Buy and then a sale", (s) => apply(apply(s, BUY(PRR, "Ipo")), SELL(NYC))],
  ];

  it.each(turns)("%s: one control, labelled Pass Turn, and nothing that names a stage", (_label, step) => {
    const state = step(board());
    expect(state.active_player_index).toBe(0); // the turn is still p0's
    renderBar(barProps(state, "p0", noop));
    expect(text(passButton())).toBe(PASS_LABEL);
    expect(PASS_LABEL).toBe("Pass Turn");
    expect(host.querySelector('[data-testid="stock-stage-button"]')).toBeNull();
    for (const button of allButtons()) {
      expect(text(button)).not.toMatch(/^(Sell Shares|Buy a Share|End Turn|Pass|Skip Buy Share)$/);
    }
    expect(host.textContent ?? "").not.toMatch(/Done selling|move on to buying/);
    for (const button of allButtons()) expect(button.title).not.toMatch(/Done selling|move on to buying/);
  });

  it("the title says which of #745's two meanings the one press has, off the reducer's flag", () => {
    renderBar(barProps(board(), "p0", noop));
    expect(passButton().title).toBe(passButtonTitle(false, true));
    expect(passButton().title).toMatch(/is a pass/);
    renderBar(barProps(apply(board(), BUY(PRR, "Ipo")), "p0", noop));
    expect(passButton().title).toBe(passButtonTitle(true, true));
    expect(passButton().title).toMatch(/does not count as a pass/);
  });
});

/* ================================================================================================================ */
describe("2. one click sends ONE PassTurn, and that one message ends the turn", () => {
  const cases: ReadonlyArray<[string, Msg[], number, number]> = [
    // label, the turn's actions before Pass Turn, streak before, streak after
    ["a no-action turn ends as a TRUE pass (counts toward the all-pass close)", [], 2, 3],
    ["a sold turn ends on the one PassTurn without counting", [SELL(NYC)], 2, 0],
    ["a bought turn ends on the one PassTurn without counting", [BUY(PRR, "Ipo")], 2, 0],
    ["a bought-then-sold turn ends on the one PassTurn without counting", [BUY(PRR, "Ipo"), SELL(NYC)], 2, 0],
    ["a sold-then-bought turn ends on the one PassTurn without counting", [SELL(NYC), BUY(PRR, "Ipo")], 2, 0],
  ];

  it.each(cases)("%s", (_label, actions, before, after) => {
    const t = table(board({ consecutive_passes: before } as Partial<GameStateResponse>));
    for (const msg of actions) t.dispatch(msg);
    expect(t.state.active_player_index).toBe(0); // buying or selling never moved the seat
    const passesBefore = t.sent.filter((kind) => kind === "PassTurn").length;
    expect(passesBefore).toBe(0);

    renderBar(barProps(t.state, "p0", () => t.dispatch(PASS)));
    click(passButton());

    // Exactly ONE PassTurn left the UI for the whole turn, and it ended the turn.
    expect(t.sent.filter((kind) => kind === "PassTurn")).toHaveLength(1);
    expect(t.sent[t.sent.length - 1]).toBe("PassTurn");
    expect(t.state.active_player_index).toBe(1);
    expect(t.state.consecutive_passes).toBe(after);
    expect(t.state.stock_turn_stage).toBeUndefined(); // no stage is ever written under revision 2
    // The old walk's second Pass is not owed -- p0 could not even send it now: the turn is p1's.
    expect(ingress(t.state, "p0", PASS)).not.toBeNull();
  });

  it("nothing else on the Stock Round bar sends a PassTurn -- the one control is the only path", () => {
    let calls = 0;
    const props = barProps(board(), "p0", () => {
      calls += 1;
    });
    renderBar({
      ...props,
      autoPass: { armed: false, canArm: true, onOpenSettings: noop, onDisarm: noop } as never,
      autoBuy: { armed: false, canArm: true, onOpenSettings: noop, onDisarm: noop },
    });
    for (const button of allButtons()) {
      if (button.getAttribute("data-testid") === "pass-turn-button") continue;
      if (!button.disabled) click(button);
    }
    expect(calls).toBe(0);
    click(passButton());
    expect(calls).toBe(1);
  });
});

/* ================================================================================================================ */
describe("3. Sell / Buy availability on the Stocks tab is the stock authority's, before and after the one Buy", () => {
  function drawPanel(state: GameStateResponse, viewer = "p0") {
    const g = gates(state, viewer);
    act(() => {
      root.render(
        <StockRoundPanel
          publicCompanies={state.public_companies}
          privateCompanies={state.private_companies}
          parValueFor={() => "100"}
          onSelectParValue={noop}
          onBuyShare={noop}
          onSellShares={noop}
          sessionReady
          isMyTurn={seatOf(state) === viewer}
          connectedAddress={viewer}
          macroRoundNumber={state.macro_round_number}
          playerCash={2000}
          marketPrices={{ [PRR]: 100, [NYC]: 90 }}
          roundType={state.current_round_type as RoundType}
          purchaseBlockFor={g.purchaseBlockFor}
          saleBlockFor={g.saleBlockFor}
        />,
      );
    });
  }
  const open = (ticker: string) => click(host.querySelector(`button[aria-label="${ticker} — show share actions"]`));
  const buyButton = () => allButtons().find((node) => /^Buy (1 share|\d+ shares)/.test(text(node)));
  const sellButton = () => allButtons().find((node) => /^Sell \d+% Bundle$/.test(text(node)));

  it("before any Buy: Buy and Sell are both live, and ingress accepts both", () => {
    const state = board();
    drawPanel(state);
    open("PRR");
    expect(buyButton()!.disabled).toBe(false);
    expect(ingress(state, "p0", BUY(PRR, "Ipo"))).toBeNull();
    drawPanel(state);
    open("NYC");
    expect(sellButton()!.disabled).toBe(false);
    expect(ingress(state, "p0", SELL(NYC))).toBeNull();
  });

  it("after the one Buy: Buy greys with the authority's own sentence, Sell stays live -- both as ingress answers", () => {
    const bought = apply(board(), BUY(PRR, "Ipo"));
    expect(bought.active_player_index).toBe(0);
    drawPanel(bought);
    open("PRR");
    const buy = buyButton()!;
    const refused = ingress(bought, "p0", BUY(PRR, "Ipo"));
    expect(refused).toContain("One certificate purchase per turn");
    expect([buy.disabled, buy.title]).toEqual([true, refused]);
    drawPanel(bought);
    open("NYC");
    expect(sellButton()!.disabled).toBe(false);
    expect(ingress(bought, "p0", SELL(NYC))).toBeNull();
    // And after that sale, Buy is still unavailable while Pass Turn remains the one way to end the turn.
    const sold = apply(bought, SELL(NYC));
    expect(ingress(sold, "p0", BUY(PRR, "Ipo"))).not.toBeNull();
    expect(ingress(sold, "p0", PASS)).toBeNull();
  });
});

/* ================================================================================================================ */
describe("4. W2-A's holds and the must-sell debt still grey the one Pass Turn; a greyed Pass sends nothing", () => {
  it("an authoritative hold: greyed with the hold's sentence, on the acting seat and on a waiting seat", () => {
    let calls = 0;
    renderBar(barProps(board(), "p0", () => (calls += 1), HOLD));
    expect([passButton().disabled, passButton().title]).toEqual([true, HOLD]);
    click(passButton());
    renderBar(barProps(board(), "p2", () => (calls += 1), HOLD));
    expect([passButton().disabled, passButton().title]).toEqual([true, HOLD]);
    click(passButton());
    expect(calls).toBe(0);
  });

  it("the must-sell debt: greyed with the authority's sentence, which the reducer also enforces", () => {
    const over = overCap();
    const authority = divestmentPassRefusal(over);
    expect(authority).not.toBeNull();
    const t = table(over);
    renderBar(barProps(over, "p0", () => t.dispatch(PASS)));
    expect([passButton().disabled, passButton().title]).toEqual([true, authority]);
    click(passButton());
    expect(t.sent).toEqual([]);
    expect(ingress(over, "p0", PASS)).not.toBeNull();
  });

  it("the shell's Pass gate keeps W2-A's order: the one hold answer first, then the must-sell debt", () => {
    const APP = readShell();
    const gate = sliceBetween(APP, "const passDisabledReason =", "return (");
    expectOrder(gate, "dockHold.pass ??", "divestmentRefusal(viewerDivestmentDebt)");
    expect(APP).toContain("passDisabledReason={passDisabledReason}");
    expect(APP).toContain("turnHoldReason={dockHold.turnHoldReason}");
  });
});

/* ================================================================================================================ */
describe("5. the must-sell banner (AUD-03.07) is the authority's debt, said once at the top of the panel", () => {
  function drawPanel(state: GameStateResponse, viewer: string) {
    const banner = mustSellBannerOf(divestmentDebt({ state, player: viewer, ...chartForDivestment(state) }));
    act(() => {
      root.render(
        <StockRoundPanel
          publicCompanies={state.public_companies}
          parValueFor={() => "100"}
          onSelectParValue={noop}
          onBuyShare={noop}
          onSellShares={noop}
          sessionReady
          isMyTurn={seatOf(state) === viewer}
          connectedAddress={viewer}
          roundType={state.current_round_type as RoundType}
          mustSell={banner}
        />,
      );
    });
    return banner;
  }
  const bannerNode = () => host.querySelector<HTMLElement>('[data-testid="stock-round-must-sell"]');

  it("owed: the banner carries the exact sentence the Pass gate and the reducer's lock use, and the floor to go", () => {
    const over = overCap();
    const banner = drawPanel(over, "p0");
    expect(banner).not.toBeNull();
    expect(banner!.reason).toBe(divestmentPassRefusal(over));
    expect(banner!.minimumCertificates).toBe(1);
    const node = bannerNode()!;
    expect(node.getAttribute("role")).toBe("status");
    expect(node.textContent).toContain(banner!.reason);
    expect(node.textContent).toContain("At least 1 certificate to sell.");
    expect(node.textContent).toContain("You must sell before buying or passing");
    // An obligation, not a stage: none of the retired walk's words.
    expect(node.textContent).not.toMatch(/Done selling|move on to buying|Buy a Share|stage/i);
  });

  it("nothing owed -- another seat's debt, a clean holding, an Operating Round -- draws no banner", () => {
    drawPanel(overCap(), "p1");
    expect(bannerNode()).toBeNull();
    drawPanel(board(), "p0");
    expect(bannerNode()).toBeNull();
    const operating = { ...overCap(), current_round_type: "OperatingRound" } as GameStateResponse;
    expect(mustSellBannerOf(divestmentDebt({ state: operating, player: "p0", ...chartForDivestment(operating) }))).toBeNull();
  });

  it("the sale that clears it clears the banner (the debt is re-read from the board)", () => {
    const sold = apply(overCap(), SELL(PRR));
    expect(holding(sold, PRR)).toBe(60);
    drawPanel(sold, "p0");
    expect(bannerNode()).toBeNull();
  });

  it("the shell reads ONE debt for the banner and the Pass gate", () => {
    const APP = readShell();
    expect(APP).toContain("const viewerDivestmentDebt = divestmentDebt({");
    expect(APP).toContain("mustSell={mustSellBannerOf(viewerDivestmentDebt)}");
    expect(sliceBetween(APP, "const passDisabledReason =", "return (")).toContain("divestmentRefusal(viewerDivestmentDebt)");
  });
});

/* ================================================================================================================ */
describe("6. Auto-Buy: no stage Pass -- it buys at once, then ends the bought turn with ONE PassTurn", () => {
  const plan = (state: GameStateResponse) =>
    armAutoBuy(state, "p0", { targets: [{ companyId: PRR, maxPercent: 60 }], source: "Ipo", stopOnPar: false, stopOnSale: false });

  /** The acting effect's dispatch path, step by step (`App`: the must-sell stop, `autoBuyTurnStep`, the decision). */
  function runAutoBuyTurn(start: GameStateResponse) {
    const t = table(start);
    const armed = plan(start);
    for (let step = 0; step < 4 && seatOf(t.state) === "p0"; step++) {
      if (autoBuyTurnStep(t.state) === "end-turn") {
        t.dispatch(PASS);
        continue;
      }
      const g = gates(t.state, "p0");
      const decision = autoBuyDecision(t.state, armed, (companyId, source) => g.purchaseBlockFor(companyId, source, 1));
      if (decision.action !== "buy") break;
      t.dispatch(BUY(decision.companyId, decision.source));
    }
    return t;
  }

  it("v13: the first thing sent is the Buy; the only PassTurn is the one that ends the bought turn", () => {
    const t = runAutoBuyTurn(board({ consecutive_passes: 2 } as Partial<GameStateResponse>));
    expect(t.sent).toEqual(["BuyStock", "PassTurn"]);
    expect(holding(t.state, PRR)).toBe(30);
    expect(t.state.active_player_index).toBe(1);
    expect(t.state.consecutive_passes).toBe(0); // an acted turn's end, never a true pass
  });

  it("what the removed stage Pass did on v13: the old code read the stage as 'sell' and passed -- ending the turn, nothing bought", () => {
    const start = board({ consecutive_passes: 2 } as Partial<GameStateResponse>);
    expect(stockTurnStage(start)).toBe("sell"); // the reading the old effect sent its Pass on
    const passed = apply(start, PASS);
    expect(passed.active_player_index).toBe(1);
    expect(passed.consecutive_passes).toBe(3); // a TRUE pass
    expect(holding(passed, PRR)).toBe(20); // and no purchase
    expect(autoBuyTurnStep(start)).toBe("buy");
  });

  it("revision 1 needed no stage Pass either: the Buy is legal from the opening stage, and one Pass ends the bought turn", () => {
    const t = runAutoBuyTurn(board({}, 1));
    expect(t.sent).toEqual(["BuyStock", "PassTurn"]);
    expect(t.state.active_player_index).toBe(1);
    expect(t.state.consecutive_passes).toBe(0);
  });

  it("autoBuyTurnStep reads only whether the turn's purchase is made", () => {
    expect(autoBuyTurnStep({})).toBe("buy");
    expect(autoBuyTurnStep({ bought_this_turn: 0 })).toBe("buy");
    expect(autoBuyTurnStep({ bought_this_turn: 1 })).toBe("end-turn");
    expect(autoBuyTurnStep({ bought_this_turn: 3 })).toBe("end-turn"); // a Brown Bank Pool continuation
  });

  it("the shell's effect asks autoBuyTurnStep, never the stage, and holds exactly one PassTurn dispatch", () => {
    const APP = readShell();
    const effect = sliceBetween(APP, "if (homeTokenOwed(gameState, homeHexToAxial)) return;", "const handleSellShares");
    expect(effect).not.toContain("stockTurnStage(");
    expect(effect).not.toContain("sellBuySellInForce(");
    expect(effect).not.toContain('stage !== "buy"');
    expect(effect.split("handlePassTurn()").length - 1).toBe(1);
    expectOrder(effect, "divestmentDebt({", "if (owed) {", 'if (autoBuyTurnStep(gameState) === "end-turn") {', "void handlePassTurn();", "autoBuyDecision(", "buyOneShare(");
  });
});

/* ================================================================================================================ */
describe("the bar's source carries no stage walk", () => {
  it("no stage props, no stage button, one Pass Turn wired to onPassTurn", () => {
    const BAR = readStripped("panels/ContextualActionBar.tsx");
    const APP = readShell();
    for (const gone of ["stockStage", "onShowStocks", "stock-stage-button", "passButtonLabel("]) {
      expect([gone, BAR.includes(gone)]).toEqual([gone, false]);
    }
    for (const gone of ["stockStage=", "onShowStocks=", "stockTurnStage("]) {
      expect([gone, APP.includes(gone)]).toEqual([gone, false]);
    }
    expect(BAR.split("onClick={onPassTurn}").length - 1).toBe(1);
    expect(BAR).toContain("{PASS_LABEL}");
  });
});
