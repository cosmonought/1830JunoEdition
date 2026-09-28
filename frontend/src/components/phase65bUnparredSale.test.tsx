/** @jest-environment jsdom */
//
// ==================================================================
//  6.5-B (K-08) HARNESS: NO LIVE SELL FOR A GRANTED SHARE OF A CORPORATION NOBODY HAS STARTED
// ==================================================================
//
// Playtest row S-13: in Stock Round 2 the C&A's owner holds the 10% PRR share the private granted, and nobody has
// bought PRR's President's Certificate. The card offered a live "Sell 10% Bundle" -- its verdict was `shareSaleBlock`,
// which has no par check -- and the server refused the sale (rulebook p.15, `stockSaleRefusal` rule 4).
//
// The shell's verdict is now `unstartedCorporationSaleRefusal ?? shareSaleBlock` (`App.saleBlockFor`); this drives the
// real Stock Round panel with exactly that composition, and the real room with the sale.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import StockRoundPanel from "./StockRoundPanel";
import type { GameStateResponse, RoundType } from "../gameEngine/gameState";
import { shareSaleBlock } from "../gameEngine/shareSale";
import { stockSaleRefusal } from "../gameEngine/stockTransactionAuthority";
import { unstartedCorporationSaleRefusal } from "../utils/stockRoundSaleBlock";
import * as F from "../utils/offerFixtures74";
import * as S from "../utils/offerMatrix74Support";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { P1, P2, PRR, NYC, CA } = F;
const UNSTARTED = "PRR has not been started yet — a share of it cannot be sold until its President's Certificate has been bought and its par set.";

/** S-13: SR2, Alice seated; Alice owns the C&A and the 10% PRR share it granted; PRR has no president and no par. NYC
 *  is started, and Alice holds 20% of it (the control). */
function s13(): GameStateResponse {
  const built = F.board({
    round: "StockRound",
    corps: [
      { id: PRR, ticker: "PRR", president: null, parValue: null, floated: false, holdings: [[P1, 10]], ipo: 90, treasury: "0" },
      { id: NYC, ticker: "NYC", president: P2, price: 90, holdings: [[P2, 30], [P1, 20]], ipo: 50 },
    ],
    privates: [{ id: CA, owner: P1, cost: "160" }],
    cash: { [P1]: 300, [P2]: 300 },
    players: [P1, P2],
  });
  return built;
}

/** `App.saleBlockFor`'s composition (after its Sell-Buy-Sell stage gate, which this legacy-revision board skips). */
const shellSaleBlock = (state: GameStateResponse, seller: string) => (companyId: number, percentage: number) =>
  unstartedCorporationSaleRefusal({ state, seller, companyId, percentage }) ??
  shareSaleBlock({ state, seller, companyId, percentage });

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

const click = (node: Element | null) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("K-08: the verdict is the sale authority's for an unstarted corporation, and shareSaleBlock's otherwise", () => {
  it("S-13: the shared rule has no par check (the hole); the shell's verdict is the authority's own sentence", () => {
    const board = s13();
    expect(shareSaleBlock({ state: board, seller: P1, companyId: PRR, percentage: 10 })).toBeNull();
    expect(stockSaleRefusal({ state: board, sell: { companyId: PRR, percentage: 10 }, actor: P1 })).toBe(UNSTARTED);
    expect(shellSaleBlock(board, P1)(PRR, 10)).toBe(UNSTARTED);
  });

  it("the server refuses that sale with the same sentence and moves nothing", () => {
    const board = s13();
    const t = S.roomFor(board);
    expect(t.submit(P1, S.M.sellStock(PRR, 10))).toMatchObject({ kind: "refused", reason: UNSTARTED });
    expect(t.room.entries).toHaveLength(0);
  });

  it("a started corporation is untouched: the verdict is exactly shareSaleBlock's", () => {
    const board = s13();
    expect(unstartedCorporationSaleRefusal({ state: board, seller: P1, companyId: NYC, percentage: 10 })).toBeNull();
    expect(shellSaleBlock(board, P1)(NYC, 10)).toBe(shareSaleBlock({ state: board, seller: P1, companyId: NYC, percentage: 10 }));
    expect(shellSaleBlock(board, P1)(NYC, 10)).toBeNull();
    // And for a bundle `shareSaleBlock` refuses, its sentence -- not the unstarted one.
    expect(shellSaleBlock(board, P1)(NYC, 30)).toBe(shareSaleBlock({ state: board, seller: P1, companyId: NYC, percentage: 30 }));
    expect(shellSaleBlock(board, P1)(NYC, 30)).not.toBe(UNSTARTED);
  });
});

describe("K-08: the Stock Round card shows the PRR Sell greyed with that sentence", () => {
  const draw = (board: GameStateResponse) =>
    act(() => {
      root.render(
        <StockRoundPanel
          publicCompanies={board.public_companies}
          privateCompanies={board.private_companies}
          parValueFor={() => "90"}
          onSelectParValue={() => undefined}
          onBuyShare={() => undefined}
          onSellShares={() => undefined}
          sessionReady
          isMyTurn
          connectedAddress={P1}
          macroRoundNumber={board.macro_round_number}
          playerCash={300}
          roundType={"StockRound" as RoundType}
          saleBlockFor={shellSaleBlock(board, P1)}
        />,
      );
    });
  const open = (ticker: string) => click(host.querySelector(`button[aria-label="${ticker} — show share actions"]`));
  const sellButton = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => /^Sell \d+% Bundle$/.test(button.textContent ?? ""));

  it("PRR (unstarted): Sell is disabled and the reason under it is the server's", () => {
    draw(s13());
    open("PRR");
    expect(sellButton()?.disabled).toBe(true);
    expect(host.textContent).toContain(UNSTARTED);
  });

  it("NYC (started): Sell is live", () => {
    draw(s13());
    open("NYC");
    expect(sellButton()?.disabled).toBe(false);
    expect(host.textContent).not.toContain(UNSTARTED);
  });
});
