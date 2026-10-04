/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W1-A: EVERY BUY AND SELL CONTROL IS THE AUTHORITY'S VERDICT
// ==================================================================
//
// AUD-03.01 (U-23 / K-19), AUD-03.02 (U-25), AUD-03.03 (U-39 / K-07), AUD-03.05 (K-12), AUD-03.06 (SBS-5); pre-work
// for AUD-03.12 (S-4).
//
// The real Stock Round panel is driven with the shell's own composition (`App.purchaseBlockFor` / `saleBlockFor`:
// the stock authority, the viewer as the actor, the board's chart, the table's rules in scope -- pinned against the
// shell's source at the bottom). For every Buy and Sell control the card draws, `disabled` is compared with what
// ingress (`turnRefusal`, the server's first lock) answers for the very message that control would send, so
// "greyed" and "the server would refuse it" are one fact, in both directions.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import StockRoundPanel from "./StockRoundPanel";
import type { GameStateResponse, RoundType } from "../gameEngine/gameState";
import {
  chartContextFromState,
  stockPurchaseRefusal,
  stockSaleRefusal,
} from "../gameEngine/stockTransactionAuthority";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { resolveVariants } from "../gameEngine/gameVariants";
import { routeRulesRevisionOf, withRules } from "../gameEngine/boardSelection";
import { marketZoneForPrice } from "../gameEngine/marketGeometry";
import { autoBuyDecision, armAutoBuy } from "../utils/autoBuy";
import { expectOrder, readShell, readStripped, sliceBetween } from "../utils/sourceScan";
import * as F from "../utils/offerFixtures74";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { P1, P2, PRR, NYC, CO, CA } = F;
const PAR = "90";

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

/* ---- the shell's composition (App.purchaseBlockFor / App.saleBlockFor) ------------------------------------------- */

function shell(state: GameStateResponse, viewer: string) {
  const scoped = (ask: () => string | null) => withRules(resolveVariants(state.variants), ask, routeRulesRevisionOf(state));
  return {
    purchaseBlockFor: (companyId: number, source: "Ipo" | "Bank", quantity: number, certificate?: "double") =>
      scoped(() =>
        stockPurchaseRefusal({
          state,
          buy: {
            companyId,
            source,
            parValue: source === "Ipo" ? PAR : null,
            quantity: certificate === "double" ? null : quantity,
            certificate: certificate ?? null,
          },
          actor: viewer,
          ctx: chartContextFromState(state),
        }),
      ),
    saleBlockFor: (companyId: number, percentage: number) =>
      scoped(() =>
        stockSaleRefusal({ state, sell: { companyId, percentage }, actor: viewer, ctx: chartContextFromState(state) }),
      ),
  };
}

/** What the server's ingress answers for a message from the viewer. */
const ingress = (state: GameStateResponse, actor: string, msg: unknown) =>
  turnRefusal({ state, waterfall: null, actor, msg: msg as never });
const BUY = (companyId: number, source: "Ipo" | "Bank", quantity = 1) => ({
  BuyStock: { game_id: 1, protocol_id: companyId, source, quantity, par_value: source === "Ipo" ? PAR : null },
});
const SELL = (companyId: number, percentage: number) => ({ SellStock: { game_id: 1, protocol_id: companyId, percentage } });

/* ---- rendering ---------------------------------------------------------------------------------------------------- */

function draw(state: GameStateResponse, viewer = P1) {
  const gates = shell(state, viewer);
  act(() => {
    root.render(
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
        playerCash={Number(state.player_cash.find((entry) => entry.player === viewer)?.cash_vgp ?? 0)}
        marketPrices={Object.fromEntries(
          Object.entries(state.market_positions ?? {}).map(([id, mark]) => [Number(id), (mark as { price: number }).price]),
        )}
        roundType={state.current_round_type as RoundType}
        purchaseBlockFor={gates.purchaseBlockFor}
        saleBlockFor={gates.saleBlockFor}
      />,
    );
  });
}
const click = (node: Element | null) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const open = (ticker: string) => click(host.querySelector(`button[aria-label="${ticker} — show share actions"]`));
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
const buyButton = () => buttons().find((node) => /^Buy (1 share|\d+ shares|President's Certificate)/.test(node.textContent ?? ""));
const sellButton = () => buttons().find((node) => /^(Sell \d+% Bundle|Selling Opens in SR2)$/.test(node.textContent ?? ""));
const sourceToggle = (label: "IPO" | "Pool") =>
  host.querySelector<HTMLDivElement>('[aria-label="Share source"]')!.querySelectorAll("button")[label === "IPO" ? 0 : 1] as HTMLButtonElement;
const sizeChips = () =>
  Array.from(host.querySelector('[aria-label="Sell size"]')?.querySelectorAll<HTMLButtonElement>("button") ?? []);

/** Board edits the fixture does not take as input. */
function withCompany(state: GameStateResponse, id: number, edit: Record<string, unknown>): GameStateResponse {
  return {
    ...state,
    public_companies: state.public_companies.map((company) => (company.company_id === id ? { ...company, ...edit } : company)),
  } as GameStateResponse;
}
function brownPrice(): number {
  for (let price = 1; price <= 400; price += 1) if (marketZoneForPrice(price) === "Brown") return price;
  throw new Error("no Brown price on the chart");
}

/* ================================================================================================================ */
describe("AUD-03.01 (U-23 / K-19): the first Stock Round's Sell is greyed with the authority's sentence", () => {
  it("SR1: Sell is disabled, its tooltip is rulebook §5.1 as the server words it, and no 'Project 18XX' claim remains", () => {
    const sr1 = F.board({
      round: "StockRound",
      macro: 1,
      corps: [{ id: NYC, ticker: "NYC", president: P1, price: 90, holdings: [[P1, 30]], ipo: 70 }],
      players: [P1, P2],
    });
    draw(sr1);
    open("NYC");
    const sell = sellButton()!;
    expect(sell.disabled).toBe(true);
    const verdict = ingress(sr1, P1, SELL(NYC, 10));
    expect(verdict).toBe("Certificates may not be sold in the first Stock Round.");
    expect(sell.title).toBe(verdict);
    expect(host.innerHTML).not.toContain("Project 18XX");
  });

  it("SR2: the same holding sells, and the button is live exactly because the server accepts it", () => {
    const sr2 = F.board({
      round: "StockRound",
      corps: [{ id: NYC, ticker: "NYC", president: P2, price: 90, holdings: [[P2, 30], [P1, 20]], ipo: 50 }],
      players: [P1, P2],
    });
    draw(sr2);
    open("NYC");
    expect(ingress(sr2, P1, SELL(NYC, 10))).toBeNull();
    expect(sellButton()!.disabled).toBe(false);
    // Every size chip agrees with the server for its own bundle.
    expect(sizeChips()).toHaveLength(5);
    for (const chip of sizeChips()) {
      const pct = Number((chip.textContent ?? "").replace("%", ""));
      expect([pct, chip.disabled]).toEqual([pct, ingress(sr2, P1, SELL(NYC, pct)) !== null]);
    }
  });
});

describe("AUD-03.02 (U-25): sources, quantity and price are the authority's", () => {
  it("an unparred corporation: the IPO offers the President's Certificate at the chosen par; an empty Pool is not offered", () => {
    const board = F.board({
      round: "StockRound",
      corps: [{ id: PRR, ticker: "PRR", president: null, parValue: null, floated: false, holdings: [[P1, 10]], ipo: 90 }],
      privates: [{ id: CA, owner: P1, cost: "160" }],
      players: [P1, P2],
    });
    draw(board);
    open("PRR");
    expect(sourceToggle("Pool").disabled).toBe(true);
    expect(sourceToggle("Pool").title).toBe("The Bank Pool holds no ordinary PRR certificate to sell.");
    const buy = buyButton()!;
    expect(buy.textContent).toContain("President's Certificate");
    expect([buy.disabled, ingress(board, P1, BUY(PRR, "Ipo"))]).toEqual([false, null]);
  });

  it("a reserved-only IPO (the Delayed Auction's C&A share) is never offered; the Pool is, and its Buy is live", () => {
    const base = F.board({
      round: "StockRound",
      corps: [{ id: PRR, ticker: "PRR", president: P2, price: 90, holdings: [[P2, 60], [P1, 20]], ipo: 10 }],
      players: [P1, P2],
    });
    const board = withCompany(base, PRR, { bank_pool_percentage: 10, reserved_certificate: { private_id: CA, percentage: 10 } });
    draw(board);
    open("PRR");
    const ipo = sourceToggle("IPO");
    expect(ipo.disabled).toBe(true);
    const reservedSentence = ingress(board, P1, BUY(PRR, "Ipo"));
    expect(reservedSentence).toContain("held for whoever buys the C&A");
    expect(ipo.title).toBe(reservedSentence);
    // The card switched itself to the Pool, whose share the server sells.
    expect(sourceToggle("Pool").getAttribute("aria-pressed")).toBe("true");
    expect([buyButton()!.disabled, ingress(board, P1, BUY(PRR, "Bank"))]).toEqual([false, null]);
  });

  it("not enough cash: Buy is greyed with the server's price-and-balance sentence (no second local affordability rule)", () => {
    const board = F.board({
      round: "StockRound",
      corps: [{ id: NYC, ticker: "NYC", president: P2, price: 90, holdings: [[P2, 30]], ipo: 70 }],
      cash: { [P1]: 50, [P2]: 500 },
      players: [P1, P2],
    });
    draw(board);
    open("NYC");
    const verdict = ingress(board, P1, BUY(NYC, "Ipo"));
    expect(verdict).toBe("That purchase costs $90 and you hold $50.");
    expect(buyButton()!.disabled).toBe(true);
    expect(buyButton()!.title).toBe(verdict);
  });

  it("Brown Pool: the quantity ceiling is the most the server accepts -- the pool, then the cash", () => {
    const price = brownPrice();
    const brown = (cash: number) =>
      withCompany(
        F.board({
          round: "StockRound",
          corps: [{ id: CO, ticker: "C&O", president: P2, price, holdings: [[P2, 50]], ipo: 20 }],
          cash: { [P1]: cash, [P2]: 500 },
          players: [P1, P2],
        }),
        CO,
        { bank_pool_percentage: 30 },
      );
    const options = () =>
      Array.from(host.querySelectorAll<HTMLOptionElement>('select[aria-label="Number of bank pool shares to buy"] option')).map(
        (option) => Number(option.value),
      );

    const rich = brown(1000);
    draw(rich);
    open("C&O");
    click(sourceToggle("Pool"));
    expect(options()).toEqual([1, 2, 3]);
    for (const n of [1, 2, 3]) expect([n, ingress(rich, P1, BUY(CO, "Bank", n))]).toEqual([n, null]);

    const short = brown(price * 2 + 1);
    draw(short);
    click(sourceToggle("Pool"));
    expect(options()).toEqual([1, 2]);
    expect(ingress(short, P1, BUY(CO, "Bank", 3))).toContain("you hold");
  });
});

describe("AUD-03.03 (U-39 / K-07): the Level Playing Field's fifth Pool certificate sells", () => {
  it("a Pool at 50% holding the 20% card and three 10%s takes a fifth card; the old 50-point cap refused it", () => {
    const base = F.board({
      round: "StockRound",
      corps: [{ id: CO, ticker: "ERIE", president: P2, price: 90, holdings: [[P2, 20], [P1, 20]], ipo: 10 }],
      players: [P1, P2],
    });
    const lpf = withCompany(base, CO, { bank_pool_percentage: 50, double_certificate: { at: "Bank" } });
    draw(lpf);
    open("ERIE");
    expect(ingress(lpf, P1, SELL(CO, 10))).toBeNull();
    const ten = sizeChips().find((chip) => chip.textContent === "10%")!;
    expect(ten.disabled).toBe(false);
    expect(sellButton()!.disabled).toBe(false);
    // The sixth card is the server's refusal, and the chip says so with its sentence.
    const twenty = sizeChips().find((chip) => chip.textContent === "20%")!;
    const refused = ingress(lpf, P1, SELL(CO, 20));
    expect(refused).toContain("caps at 5");
    expect([twenty.disabled, twenty.title]).toEqual([true, refused]);
  });
});

describe("the shell's composition is the one this file drives", () => {
  const APP = readShell();
  it("purchaseBlockFor: the stock authority, the viewer, the card's par, the board's chart, the table's rules", () => {
    const body = sliceBetween(APP, "const purchaseBlockFor = useCallback(", "const saleBlockFor = useCallback(");
    for (const piece of [
      "withRules(",
      "resolveVariants(gameState.variants),",
      "stockPurchaseRefusal({",
      'parValue: source === "Ipo" ? parValueFor(companyId) : null,',
      'quantity: certificate === "double" ? null : quantity,',
      "actor: viewerAddress,",
      "ctx: chartContextFromState(gameState),",
      "routeRulesRevisionOf(gameState),",
    ]) {
      expect([piece, body.includes(piece)]).toEqual([piece, true]);
    }
    expect(body).not.toContain("stockTurnStage(");
  });

  it("saleBlockFor: the sale authority, the same way", () => {
    const body = sliceBetween(APP, "const saleBlockFor = useCallback(", "const [marketPeek, setMarketPeek]");
    for (const piece of ["stockSaleRefusal({", "sell: { companyId, percentage },", "actor: viewerAddress,", "ctx: chartContextFromState(gameState),"]) {
      expect([piece, body.includes(piece)]).toEqual([piece, true]);
    }
  });

  it("the card keeps no local copy of the rules it now asks", () => {
    const PANEL = readStripped("components/StockRoundPanel.tsx");
    for (const gone of ["BANK_POOL_CAP_PERCENT", "sellOptionState(", "cannotAfford", "Insufficient funds", "Project 18XX", "macroRoundNumber === 1"]) {
      expect([gone, PANEL.includes(gone)]).toEqual([gone, false]);
    }
    expect(PANEL).toContain("isFirstStockRound(");
    expect(PANEL).toContain("ordinaryPercentAvailable(company, option) > 0");
  });
});

/* ================================================================================================================ */
describe("AUD-03.05 (K-12) / AUD-03.06 (SBS-5): Auto-Buy", () => {
  it("too little cash disarms with the server's sentence instead of sending a refused buy", () => {
    const board = F.board({
      round: "StockRound",
      corps: [{ id: NYC, ticker: "NYC", president: P2, price: 90, holdings: [[P2, 30]], ipo: 70 }],
      cash: { [P1]: 50, [P2]: 500 },
      players: [P1, P2],
    });
    const plan = armAutoBuy(board, P1, {
      targets: [{ companyId: NYC, maxPercent: 60 }],
      source: "Ipo",
      stopOnPar: false,
      stopOnSale: false,
    });
    const gates = shell(board, P1);
    const decision = autoBuyDecision(board, plan, (companyId, source) => gates.purchaseBlockFor(companyId, source, 1));
    expect(decision.action).toBe("done");
    expect((decision as { reason: string }).reason).toBe(
      "Auto-Buy cannot buy what is left on its list — NYC: That purchase costs $90 and you hold $50.",
    );
    // With the cash, the same plan buys -- and the server accepts that buy.
    const funded = { ...board, player_cash: board.player_cash.map((entry) => (entry.player === P1 ? { ...entry, cash_vgp: "500" } : entry)) };
    const fundedGates = shell(funded as GameStateResponse, P1);
    expect(autoBuyDecision(funded as GameStateResponse, plan, (id, source) => fundedGates.purchaseBlockFor(id, source, 1))).toEqual({
      action: "buy",
      companyId: NYC,
      source: "Ipo",
    });
    expect(ingress(funded as GameStateResponse, P1, BUY(NYC, "Ipo"))).toBeNull();
  });

  it("the must-sell check comes before the Sell-stage Pass, and stops without dispatching", () => {
    const APP = readShell();
    const effect = sliceBetween(APP, "if (homeTokenOwed(gameState, homeHexToAxial)) return;", "const handleSellShares");
    expectOrder(effect, "divestmentDebt({", "if (owed) {", "setAutoBuyPlan(null);", "if (sellBuySellInForce(resolveVariants(gameState.variants))) {");
    const stop = sliceBetween(effect, "if (owed) {", "if (sellBuySellInForce(");
    expect(stop).not.toContain("handlePassTurn");
    expect(stop).not.toContain("buyOneShare");
  });
});
