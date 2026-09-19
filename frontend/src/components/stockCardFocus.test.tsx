/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1451/1452 (harness): THE CARD BECOMES THE FINAL STATE
// ==================================================================
//
// CLAIMS THIS SUITE EXISTS FOR, none of which a source scan can state, because every one is about what the
// DOM holds at a particular instant of a particular sequence:
//   1. NOTHING LEAVES THE CARD. `document.body` gains no child and the travelling percentage is a descendant
//      of the ownership table it belongs to. This is the visual-language rule -- slide-out movement across
//      the shell is money's vocabulary -- expressed as something a test can fail on;
//   2. THE FIGURES ARE NOT FINAL BEFORE THE GESTURE THAT CAUSES THEM. #1452's whole report: the card used to
//      render `after` and then explain it. The destination row must still read `before` while the proxy is
//      in the air;
//   3. THE TWO STEPS OF A TAKEOVER APPLY IN THE ORDER THE RULES PERFORM THEM -- a buy's purchase lands before
//      its crown, a sale's crown lands before its shares reach the pool -- and each intermediate is visible;
//   4. the card ARRIVES at the committed board, so the release is not a jump;
//   5. supersession leaves nothing behind: no staged holding, no staged crown, no staged order;
//   6. reduced motion keeps the focus and the emphasis and draws no proxy.
//
// THE COMMITTED BOARD IN EVERY CASE BELOW IS `after`, because that is what the shell renders from the moment
// the reducer settles. Any assertion that the card shows something else is therefore an assertion that the
// staged overlay is doing its job.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StockRoundPanel, type StockTransactionEvent } from "./StockRoundPanel";
import {
  CROWN_OUT_MS,
  EXCHANGE_AT_MS,
  HANDOVER_AT_MS,
  PRESIDENCY_MS,
  TRANSFER_MS,
  TRANSFER_RESOLVE_AT_MS,
} from "./stockTransferFocus";
import type { OwnershipSnapshot } from "../utils/stockTransaction";
import type { PublicCompanyState, RoundType } from "../gameEngine/gameState";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const PRR = 1;
const BO = 4;
const ALICE = "juno1alice";
const BOB = "juno1bob";

const holdingRows = (holdings: Record<string, number>) =>
  Object.keys(holdings)
    .filter((player) => holdings[player] > 0)
    .map((player) => ({ player, percentage: holdings[player] }));

/** The four fields the card stages, as the shell captures them. */
const snap = (
  president: string | null,
  holdings: Record<string, number>,
  pools: { ipo: number; bank: number },
  /** Design note #1324: where the 20% STANDARD certificate sits. A different card from the President's. */
  doubleAt?: string,
): OwnershipSnapshot => ({
  ipo_pool_percentage: pools.ipo,
  bank_pool_percentage: pools.bank,
  player_holdings: holdingRows(holdings),
  president,
  double_certificate: doubleAt === undefined ? undefined : { at: doubleAt },
});

const corporation = (
  companyId: number,
  ticker: string,
  holdings: Record<string, number>,
  president: string | null,
  pools: { ipo: number; bank: number },
  doubleAt?: string,
): PublicCompanyState =>
  ({
    double_certificate: doubleAt === undefined ? undefined : { at: doubleAt },
    company_id: companyId,
    ticker,
    is_floated: true,
    treasury: "500",
    total_shares_issued: 10,
    par_value: "90",
    president,
    ipo_pool_percentage: pools.ipo,
    bank_pool_percentage: pools.bank,
    player_holdings: holdingRows(holdings),
    home_hex_label: "H12",
    station_token_hexes: [],
    trains: [],
  }) as unknown as PublicCompanyState;

/** The COMMITTED board -- what the shell renders the instant the reducer settles. */
const board = (
  president: string | null,
  holdings: Record<string, number>,
  pools: { ipo: number; bank: number },
  doubleAt?: string,
) => [
  corporation(PRR, "PRR", holdings, president, pools, doubleAt),
  corporation(BO, "B&O", { [ALICE]: 20 }, ALICE, { ipo: 60, bank: 20 }),
];

describe("the corporation card's own transaction", () => {
  let host: HTMLDivElement;
  let root: Root;

  let cues: string[];
  const render = (companies: readonly PublicCompanyState[], transaction: StockTransactionEvent | null) => {
    act(() => {
      root.render(
        <StockRoundPanel
          /* An INLINE arrow on purpose: a fresh identity every render re-runs the cue effect, which is the
             hard case for "once per crown arrival rather than once per render". */
          onPresidencyCue={() => cues.push("presidency")}
          publicCompanies={companies}
          parValueFor={() => "90"}
          onSelectParValue={() => undefined}
          onBuyShare={() => undefined}
          onSellShares={() => undefined}
          sessionReady
          isMyTurn={false}
          connectedAddress={null}
          roundType={"StockRound" as RoundType}
          transaction={transaction}
        />,
      );
    });
  };
  const tick = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  const table = (ticker: string) =>
    host.querySelector<HTMLElement>(`[aria-label="${ticker} ownership"]`) as HTMLElement;
  const card = (ticker: string) => table(ticker).closest(".app-stock-card") as HTMLElement;
  const cellFor = (ticker: string, holder: string) => {
    const cells = table(ticker).querySelectorAll<HTMLElement>("[data-stock-cell]");
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index].getAttribute("data-stock-cell") === holder) return cells[index];
    }
    throw new Error(`no row for ${holder}`);
  };
  /** What the Shares column actually reads for this holder, e.g. "3 (30%)". */
  const shares = (ticker: string, holder: string) => (cellFor(ticker, holder).textContent ?? "").trim();
  const dimmed = (ticker: string, holder: string) =>
    (cellFor(ticker, holder).parentElement as HTMLElement).className.includes("app-stock-row-dim");
  const proxies = (ticker: string) => table(ticker).querySelectorAll(".app-stock-proxy-travel");
  /** The animation class on the span wrapping this row's crown, or "" when it has none / has no crown. */
  const crownClass = (ticker: string, holder: string) => {
    const crown = (cellFor(ticker, holder).parentElement as HTMLElement).querySelector(
      '[aria-label="President"]',
    );
    return crown === null ? "" : ((crown.parentElement as HTMLElement).className ?? "");
  };
  /** The roster, top to bottom, with whoever is wearing the crown marked. */
  const roster = (ticker: string) => {
    const cells = table(ticker).querySelectorAll<HTMLElement>("[data-stock-cell]");
    const out: string[] = [];
    for (let index = 0; index < cells.length; index += 1) {
      const holder = cells[index].getAttribute("data-stock-cell") ?? "";
      if (holder === "Ipo" || holder === "Bank") continue;
      const row = cells[index].parentElement as HTMLElement;
      out.push(row.querySelector('[aria-label="President"]') ? `${holder}*` : holder);
    }
    return out;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    cues = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    jest.useRealTimers();
  });

  /* ---- an ordinary purchase ------------------------------------------------------- */

  describe("an ordinary purchase", () => {
    /* BOB buys 20% out of the Bank Pool. The committed board already says so. */
    const committed = board(ALICE, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 });
    const buy: StockTransactionEvent = {
      token: 1,
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Bank", to: BOB, percentage: 20 },
      presidency: null,
      before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }),
      after: snap(ALICE, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
    };

    it("does nothing at all without a transaction", () => {
      render(committed, null);
      expect(proxies("PRR")).toHaveLength(0);
      expect(dimmed("PRR", "Ipo")).toBe(false);
      expect(shares("PRR", BOB)).toContain("50%");
      expect(document.body.children).toHaveLength(1);
    });

    it("STARTS FROM `before`, with the destination not yet showing its final holding", () => {
      render(committed, buy);
      /* #1452's report, as an assertion. The committed board says 50% and the pool is empty; the card is
         showing the board the purchase started from. */
      expect(shares("PRR", BOB)).toContain("30%");
      expect(shares("PRR", "Bank")).toContain("20%");
    });

    it("advances to `after` on the merge, and not before it", () => {
      render(committed, buy);
      tick(TRANSFER_RESOLVE_AT_MS - 1);
      expect(shares("PRR", BOB)).toContain("30%");
      tick(2);
      expect(shares("PRR", BOB)).toContain("50%");
      expect(shares("PRR", "Bank")).toContain("0%");
      /* The chip is still in the air -- the figures changed underneath it, which is the merge. */
      expect(proxies("PRR")).toHaveLength(1);
    });

    it("subdues everything but the two entities, and draws the percentage inside the table", () => {
      render(committed, buy);
      expect(dimmed("PRR", "Bank")).toBe(false);
      expect(dimmed("PRR", BOB)).toBe(false);
      expect(dimmed("PRR", "Ipo")).toBe(true);
      expect(dimmed("PRR", ALICE)).toBe(true);

      const drawn = proxies("PRR");
      expect(drawn).toHaveLength(1);
      expect(drawn[0].textContent).toBe("20%");
      /* NOT A PORTAL, NOT A FLIGHT. The proxy is a descendant of this corporation's ownership table and
         `document.body` has gained nothing -- which is the rule the first attempt broke. */
      expect(table("PRR").contains(drawn[0])).toBe(true);
      expect(document.body.children).toHaveLength(1);
    });

    it("focuses only the corporation the action named", () => {
      render(committed, buy);
      expect(card("PRR").style.borderColor).not.toBe(card("B&O").style.borderColor);
      expect(proxies("B&O")).toHaveLength(0);
      expect(dimmed("B&O", "Ipo")).toBe(false);
    });

    it("hands back to authoritative rendering with nothing left staged", () => {
      render(committed, buy);
      render(committed, null);
      expect(proxies("PRR")).toHaveLength(0);
      expect(dimmed("PRR", "Ipo")).toBe(false);
      expect(shares("PRR", BOB)).toContain("50%");
      expect(shares("PRR", "Bank")).toContain("0%");
    });
  });

  /* ---- a buy that takes the presidency -------------------------------------------- */

  describe("a buy that takes the presidency", () => {
    /* BOB buys 20% from the pool, reaching 50% against ALICE's 40%, and takes the crown. */
    const committed = board(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 });
    const takeover: StockTransactionEvent = {
      token: 2,
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Bank", to: BOB, percentage: 20 },
      presidency: { from: ALICE, to: BOB },
      before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }),
      after: snap(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
    };

    it("begins from the pre-transaction ownership, order and crown", () => {
      render(committed, takeover);
      expect(roster("PRR")).toEqual([`${ALICE}*`, BOB]);
      expect(shares("PRR", BOB)).toContain("30%");
      expect(dimmed("PRR", "Bank")).toBe(false);
      expect(dimmed("PRR", BOB)).toBe(false);
      /* The displaced president is not lit while the purchase runs. */
      expect(dimmed("PRR", ALICE)).toBe(true);
    });

    it("applies the PURCHASE first, with the crown still on the outgoing president", () => {
      render(committed, takeover);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      expect(shares("PRR", BOB)).toContain("50%");
      expect(shares("PRR", "Bank")).toContain("0%");
      /* The real intermediate: BOB holds the shares, ALICE still holds the certificate. */
      expect(roster("PRR")).toEqual([`${ALICE}*`, BOB]);
    });

    it("then moves the emphasis to the two presidents, without letting go of the card", () => {
      render(committed, takeover);
      tick(TRANSFER_MS + CROWN_OUT_MS / 2);
      expect(dimmed("PRR", "Bank")).toBe(true);
      expect(dimmed("PRR", ALICE)).toBe(false);
      expect(dimmed("PRR", BOB)).toBe(false);
      expect(card("PRR").style.borderColor).toBeTruthy();
    });

    it("crosses two certificates during the exchange, because no stake moves", () => {
      render(committed, takeover);
      tick(TRANSFER_MS + EXCHANGE_AT_MS + 1);
      const crossing = proxies("PRR");
      expect(crossing).toHaveLength(2);
      /* The president's certificate is the one wearing a crown; the 20% of ordinary shares coming back is
         not. One chip would have claimed a stake changed hands, which is exactly what did not happen. */
      expect(crossing[0].querySelector("svg")).not.toBeNull();
      expect(crossing[1].querySelector("svg")).toBeNull();
      expect(crossing[0].textContent).toContain("20%");
    });

    it("reorders the rows and draws the new crown at the handover", () => {
      render(committed, takeover);
      tick(TRANSFER_MS + HANDOVER_AT_MS + 1);
      expect(roster("PRR")).toEqual([`${BOB}*`, ALICE]);
      expect(crownClass("PRR", BOB)).toBe("app-stock-crown-in");
    });

    it("keeps the incumbent's crown solid through the purchase, then fades it (design note #1455)", () => {
      /* The asymmetry is the procedure: a buy is PAID FOR before it is crowned, so fading the incumbent from
         the first frame would announce the takeover ahead of the shares that caused it. */
      render(committed, takeover);
      expect(crownClass("PRR", ALICE)).toBe("");
      tick(TRANSFER_MS + 1);
      expect(crownClass("PRR", ALICE)).toBe("app-stock-crown-out");
    });

    it("arrives at the committed board, so the release is not a jump", () => {
      render(committed, takeover);
      tick(TRANSFER_MS + PRESIDENCY_MS);
      const staged = { roster: roster("PRR"), bob: shares("PRR", BOB), bank: shares("PRR", "Bank") };
      render(committed, null);
      expect({ roster: roster("PRR"), bob: shares("PRR", BOB), bank: shares("PRR", "Bank") }).toEqual(staged);
    });
  });

  /* ---- a sell that loses the presidency ------------------------------------------- */

  describe("a sell that loses the presidency", () => {
    /* ALICE sells 20% into the pool, dropping to 20% against BOB's 30%, and loses the crown. */
    const committed = board(BOB, { [ALICE]: 20, [BOB]: 30 }, { ipo: 10, bank: 20 });
    const takeover: StockTransactionEvent = {
      token: 3,
      companyId: PRR,
      ticker: "PRR",
      kind: "sell",
      transfer: { from: ALICE, to: "Bank", percentage: 20 },
      presidency: { from: ALICE, to: BOB },
      before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 0 }),
      after: snap(BOB, { [ALICE]: 20, [BOB]: 30 }, { ipo: 10, bank: 20 }),
    };

    it("begins from the pre-transaction ownership, order and crown", () => {
      render(committed, takeover);
      expect(roster("PRR")).toEqual([`${ALICE}*`, BOB]);
      expect(shares("PRR", ALICE)).toContain("40%");
      expect(shares("PRR", "Bank")).toContain("0%");
    });

    it("hands the presidency over BEFORE the shares reach the Bank Pool", () => {
      render(committed, takeover);
      tick(HANDOVER_AT_MS + 1);
      /* The real intermediate: the certificate has been exchanged, the sale has not settled. */
      expect(roster("PRR")).toEqual([`${BOB}*`, ALICE]);
      expect(shares("PRR", ALICE)).toContain("40%");
      expect(shares("PRR", "Bank")).toContain("0%");
    });

    it("then moves the emphasis to the seller and the pool, and delivers the shares", () => {
      render(committed, takeover);
      tick(PRESIDENCY_MS + 1);
      expect(dimmed("PRR", ALICE)).toBe(false);
      expect(dimmed("PRR", "Bank")).toBe(false);
      expect(dimmed("PRR", BOB)).toBe(true);
      /* Still not delivered -- the proxy is in the air. */
      expect(shares("PRR", "Bank")).toContain("0%");

      tick(TRANSFER_RESOLVE_AT_MS);
      expect(shares("PRR", ALICE)).toContain("20%");
      expect(shares("PRR", "Bank")).toContain("20%");
    });

    it("arrives at the committed board", () => {
      render(committed, takeover);
      tick(PRESIDENCY_MS + TRANSFER_MS);
      const staged = { roster: roster("PRR"), alice: shares("PRR", ALICE), bank: shares("PRR", "Bank") };
      render(committed, null);
      expect({ roster: roster("PRR"), alice: shares("PRR", ALICE), bank: shares("PRR", "Bank") }).toEqual(staged);
    });
  });

  /* ---- the two semantic edge cases audited before freezing ------------------------ */

  describe("the 20% STANDARD certificate does not leak the presidency exchange", () => {
    /* ==================================================================
        DESIGN NOTE 1324 vs #1452: TWO DIFFERENT 20% CARDS
       ==================================================================
       `double_certificate.at` locates the 20% STANDARD certificate (ERIE and N&W under the Level Playing
       Field) -- a card a player can hold BESIDE the President's. It moves when it is bought or sold and at
       no other time: `withDoubleAt` is called only from the `BuyStock` and `SellStock` arms, and
       `settlePresidencies` writes `president` and nothing else (#596a). So staging it with the transfer is
       staging it with the only thing that moves it.
       WHAT COULD HAVE LEAKED, and does not: `certificateCardsHeld` counts a President's Certificate from
       `company.president`, which is staged on its OWN beat. This case buys the double AND takes the crown in
       one action, so if the two were ever conflated the buyer's card count would jump early. */
    const committed = board(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }, BOB);
    const takeover: StockTransactionEvent = {
      token: 7,
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Bank", to: BOB, percentage: 20 },
      presidency: { from: ALICE, to: BOB },
      before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }, "Bank"),
      after: snap(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }, BOB),
    };

    it("starts with the standard certificate still in the pool and the crown on the incumbent", () => {
      render(committed, takeover);
      /* One card at 20% is the double itself sitting in the Bank Pool. */
      expect(shares("PRR", "Bank")).toBe("1 (20%)");
      expect(shares("PRR", ALICE)).toBe("3 (40%)");
      expect(roster("PRR")).toEqual([`${ALICE}*`, BOB]);
    });

    it("hands over the standard certificate at the purchase beat and the President's at its own", () => {
      render(committed, takeover);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      /* FOUR cards at 50%: the 20% standard card plus three tens. NOT three, which is what he would hold if
         the President's Certificate had come with it -- the crown is still ALICE's. */
      expect(shares("PRR", BOB)).toBe("4 (50%)");
      expect(shares("PRR", ALICE)).toBe("3 (40%)");
      expect(roster("PRR")).toEqual([`${ALICE}*`, BOB]);

      tick(TRANSFER_MS - TRANSFER_RESOLVE_AT_MS + HANDOVER_AT_MS + 1);
      /* And now three: the President's 20%, the standard 20%, and one ten. */
      expect(shares("PRR", BOB)).toBe("3 (50%)");
      expect(shares("PRR", ALICE)).toBe("4 (40%)");
      expect(roster("PRR")).toEqual([`${BOB}*`, ALICE]);
    });
  });

  describe("a corporation's FIRST president (design note #1453)", () => {
    /* ALICE pars the PRR and takes the President's Certificate out of a full IPO. `null -> ALICE` is not a
       handoff -- there is nobody to uncrown -- but the crown must still arrive WITH the certificate. */
    const committed = board(ALICE, { [ALICE]: 20 }, { ipo: 80, bank: 0 });
    const par: StockTransactionEvent = {
      token: 8,
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Ipo", to: ALICE, percentage: 20 },
      presidency: null,
      before: snap(null, {}, { ipo: 100, bank: 0 }),
      after: snap(ALICE, { [ALICE]: 20 }, { ipo: 80, bank: 0 }),
    };

    it("starts with a full IPO holding the President's Certificate and nobody crowned", () => {
      render(committed, par);
      /* NINE cards at 100%: the President's 20% plus eight tens. `certificateCardsInPool` counts the
         President's card in the IPO precisely because `president` is null -- which is the field that makes
         this case delicate. */
      expect(shares("PRR", "Ipo")).toBe("9 (100%)");
      /* ALICE's row exists as the transfer's landing row (#1454) and says so: the absence dash, and no
         crown. A crown here would be the premature claim the staging exists to prevent. */
      expect(roster("PRR")).toEqual([ALICE]);
      expect(shares("PRR", ALICE)).toBe("--");
    });

    it("DRAWS the first crown in rather than popping it (design note #1455)", () => {
      /* The destination end of the presidency language, without the outgoing half: no crown-out anywhere in
         the sequence, and the arriving crown carries the same fade-in a two-player handover uses. */
      render(committed, par);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      expect(crownClass("PRR", ALICE)).toBe("app-stock-crown-in");
    });

    it("crowns the buyer on the SAME beat the certificate arrives, not at release", () => {
      render(committed, par);
      tick(TRANSFER_RESOLVE_AT_MS - 1);
      expect(shares("PRR", "Ipo")).toBe("9 (100%)");
      tick(2);
      /* All three at once: the IPO drops to eight tens, ALICE holds one card, and it wears a crown. Before
         #1453 the crown and both counts snapped at release, with no gesture anywhere near them. */
      expect(shares("PRR", "Ipo")).toBe("8 (80%)");
      expect(shares("PRR", ALICE)).toBe("1 (20%)");
      expect(roster("PRR")).toEqual([`${ALICE}*`]);
    });

    it("plays no exchange animation -- there is no outgoing president to duel", () => {
      render(committed, par);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      /* Never the two crossing chips of a handoff, and exactly one crown on the card. */
      expect(proxies("PRR")).toHaveLength(1);
      expect(table("PRR").querySelectorAll('[aria-label="President"]')).toHaveLength(1);
    });

    it("gives the buyer a landing row so the certificate has somewhere real to go (#1454)", () => {
      /* WITHOUT THIS THERE IS NO ANIMATION AT ALL on a player's first purchase -- `player_holdings` omits a
         0% holder, so the destination cell would not exist when the proxy is measured. The row is an anchor,
         not a claim: the card's absence dash, no crown, no percentage. */
      render(committed, par);
      expect(roster("PRR")).toEqual([ALICE]);
      expect(shares("PRR", ALICE)).toBe("--");
      expect(table("PRR").querySelectorAll('[aria-label="President"]')).toHaveLength(0);
      /* And the chip is drawn, from the IPO to that row. */
      const drawn = proxies("PRR");
      expect(drawn).toHaveLength(1);
      expect(drawn[0].textContent).toBe("20%");
      expect(table("PRR").contains(drawn[0])).toBe(true);
    });

    it("turns the landing row into the ordinary row at the resolution beat", () => {
      render(committed, par);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      expect(shares("PRR", ALICE)).toBe("1 (20%)");
      expect(roster("PRR")).toEqual([`${ALICE}*`]);
      /* And once it is a real holding it stays one, with nothing staged left over. */
      render(committed, null);
      expect(shares("PRR", ALICE)).toBe("1 (20%)");
      expect(roster("PRR")).toEqual([`${ALICE}*`]);
    });

    it("is already at the committed board when the card lets go", () => {
      render(committed, par);
      tick(TRANSFER_MS);
      const staged = { ipo: shares("PRR", "Ipo"), alice: shares("PRR", ALICE), roster: roster("PRR") };
      render(committed, null);
      expect({ ipo: shares("PRR", "Ipo"), alice: shares("PRR", ALICE), roster: roster("PRR") }).toEqual(staged);
    });
  });

  describe("a landing row is an anchor, not a claim (design note #1454)", () => {
    /* BOB buys his first 20% of the PRR out of the Bank Pool. ALICE presides throughout and CAROL, who holds
       nothing and is not in this transaction, must not appear. */
    const CAROL = "juno1carol";
    const committed = board(ALICE, { [ALICE]: 40, [BOB]: 20 }, { ipo: 10, bank: 0 });
    const firstBuy: StockTransactionEvent = {
      token: 9,
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Bank", to: BOB, percentage: 20 },
      presidency: null,
      before: snap(ALICE, { [ALICE]: 40 }, { ipo: 10, bank: 20 }),
      after: snap(ALICE, { [ALICE]: 40, [BOB]: 20 }, { ipo: 10, bank: 0 }),
    };

    it("adds only the participant, and only while the transfer is unresolved", () => {
      render(committed, firstBuy);
      expect(roster("PRR")).toEqual([`${ALICE}*`, BOB]);
      expect(shares("PRR", BOB)).toBe("--");
      /* NOT the union of `before` and `after`, and certainly not every player at the table. */
      expect(roster("PRR")).not.toContain(CAROL);
      /* It is a participant of the CURRENT step, so it is one of the two undimmed rows. */
      expect(dimmed("PRR", BOB)).toBe(false);
      expect(dimmed("PRR", ALICE)).toBe(true);
    });

    it("stops being a landing row the moment the shares arrive", () => {
      render(committed, firstBuy);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      expect(shares("PRR", BOB)).toBe("2 (20%)");
      render(committed, null);
      expect(shares("PRR", BOB)).toBe("2 (20%)");
    });
  });

  describe("a seller keeps their row until the shares have left (design note #1454)", () => {
    /* BOB sells his last 20% into the pool. The staged snapshot already gives this for free -- the holdings
       are `before`'s until the resolve beat -- so this pins the ORDER rather than adding machinery:
       BOB owns shares -> the shares leave BOB -> BOB's row may go. */
    const committed = board(ALICE, { [ALICE]: 40 }, { ipo: 10, bank: 20 });
    const sellOut: StockTransactionEvent = {
      token: 10,
      companyId: PRR,
      ticker: "PRR",
      kind: "sell",
      transfer: { from: BOB, to: "Bank", percentage: 20 },
      presidency: null,
      before: snap(ALICE, { [ALICE]: 40, [BOB]: 20 }, { ipo: 10, bank: 0 }),
      after: snap(ALICE, { [ALICE]: 40 }, { ipo: 10, bank: 20 }),
    };

    it("leaves the proxy from the seller's own Shares cell, with the row still holding", () => {
      render(committed, sellOut);
      expect(roster("PRR")).toEqual([`${ALICE}*`, BOB]);
      /* The real holding, not a dash: this row is not a landing row, it is the source and it still owns the
         shares. A dash here would mean the staged board had already emptied it. */
      expect(shares("PRR", BOB)).toBe("2 (20%)");
      expect(shares("PRR", "Bank")).toBe("0 (0%)");
      const drawn = proxies("PRR");
      expect(drawn).toHaveLength(1);
      expect(drawn[0].textContent).toBe("20%");
    });

    it("drops the row only when the transfer resolves, and never resurrects it as a dash", () => {
      render(committed, sellOut);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      expect(roster("PRR")).toEqual([`${ALICE}*`]);
      expect(shares("PRR", "Bank")).toBe("2 (20%)");
      /* The seller is still a named participant of this stage, so the landing-row rule has to be gated on
         the application as well as on membership -- otherwise the row would come back reading "--" for the
         rest of the stage. */
      tick(TRANSFER_MS);
      expect(roster("PRR")).toEqual([`${ALICE}*`]);
    });
  });

  /* ---- interruption ---------------------------------------------------------------- */

  it("supersedes cleanly, leaving no staged holding, crown or order behind", () => {
    const first = board(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 });
    const takeover: StockTransactionEvent = {
      token: 4,
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Bank", to: BOB, percentage: 20 },
      presidency: { from: ALICE, to: BOB },
      before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }),
      after: snap(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
    };
    render(first, takeover);
    /* Interrupted mid-purchase: staged at ALICE crowned, BOB on 30%. */
    tick(TRANSFER_MS / 2);
    expect(roster("PRR")).toEqual([`${ALICE}*`, BOB]);

    /* ALICE now buys 10% out of the IPO. Its `before` is the board the takeover finished on. */
    const second = board(BOB, { [ALICE]: 50, [BOB]: 50 }, { ipo: 0, bank: 0 });
    render(second, {
      token: 5,
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Ipo", to: ALICE, percentage: 10 },
      presidency: null,
      before: snap(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
      after: snap(BOB, { [ALICE]: 50, [BOB]: 50 }, { ipo: 0, bank: 0 }),
    });

    /* The previous sequence's staged crown and order are GONE -- the card synchronised to the new
       transaction's own `before`, not to a blend of the two. */
    expect(roster("PRR")).toEqual([`${BOB}*`, ALICE]);
    expect(shares("PRR", ALICE)).toContain("40%");
    expect(shares("PRR", "Ipo")).toContain("10%");
    const drawn = proxies("PRR");
    expect(drawn).toHaveLength(1);
    expect(drawn[0].textContent).toBe("10%");

    /* And it still lands on the new committed board. */
    tick(TRANSFER_RESOLVE_AT_MS + 1);
    expect(shares("PRR", ALICE)).toContain("50%");
    expect(shares("PRR", "Ipo")).toContain("0%");
  });

  describe("supersession cannot leak the replacement's final state (design note #1456)", () => {
    /* The first transaction is allowed to RESOLVE before it is superseded, which is the case that used to
       leak: the old reset lived in a passive effect, so one paintable render carried the new sequence's
       snapshots with `applied.transfer` still true from the old one -- and `stagedOwnership` selected the new
       transaction's `after`. The finished board, a frame before its own animation began.
       WHAT A RENDER TEST CAN AND CANNOT SAY: `act` flushes to a settled DOM, so the discarded render is not
       observable from here -- that property is pinned structurally in `stockTransferFocus.test.ts`. What this
       pins is the OUTCOME the ruling names: the first thing the replacement shows is its own `before`. */
    const afterFirst = board(ALICE, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 });
    const afterSecond = board(ALICE, { [ALICE]: 50, [BOB]: 50 }, { ipo: 0, bank: 0 });
    const first: StockTransactionEvent = {
      token: 11,
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Bank", to: BOB, percentage: 20 },
      presidency: null,
      before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }),
      after: snap(ALICE, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
    };
    const second: StockTransactionEvent = {
      token: 12,
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Ipo", to: ALICE, percentage: 10 },
      presidency: null,
      before: snap(ALICE, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
      after: snap(ALICE, { [ALICE]: 50, [BOB]: 50 }, { ipo: 0, bank: 0 }),
    };

    it("shows the replacement's `before`, not its `after` and not a blend of the two", () => {
      render(afterFirst, first);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      /* The first transaction has resolved: BOB has his shares and the pool is empty. */
      expect(shares("PRR", BOB)).toBe("5 (50%)");
      expect(shares("PRR", "Bank")).toBe("0 (0%)");

      render(afterSecond, second);
      /* The replacement's own opening board. `4 (50%)` for ALICE or `0 (0%)` for the IPO would be its
         `after` -- the finished state, before anything had moved. */
      expect(shares("PRR", ALICE)).toBe("3 (40%)");
      expect(shares("PRR", "Ipo")).toBe("1 (10%)");
      /* And not a blend: BOB's holding comes from the replacement's snapshots too. */
      expect(shares("PRR", BOB)).toBe("5 (50%)");
    });

    it("does not resume the superseded sequence", () => {
      render(afterFirst, first);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      render(afterSecond, second);
      /* Long enough for every beat of BOTH sequences to have fired. Only the replacement's may land.
         "tied" is the roster's own marker (#791) -- ALICE's purchase levels her with BOB at 50%, which is
         exactly the kind of downstream fact that has to come out of the STAGED board rather than be
         recomputed, and it does. */
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      expect(shares("PRR", ALICE)).toBe("4 (50% tied)");
      expect(shares("PRR", "Ipo")).toBe("0 (0%)");
      tick(TRANSFER_MS * 4);
      expect(shares("PRR", ALICE)).toBe("4 (50% tied)");
      expect(shares("PRR", "Ipo")).toBe("0 (0%)");
    });
  });

  describe("the presidency cue (design note #1457)", () => {
    it("fires on the handover beat -- not on the crown leaving, not during the exchange", () => {
      const committed = board(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 });
      const takeover: StockTransactionEvent = {
        token: 13,
        companyId: PRR,
        ticker: "PRR",
        kind: "buy",
        transfer: { from: "Bank", to: BOB, percentage: 20 },
        presidency: { from: ALICE, to: BOB },
        before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }),
        after: snap(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
      };
      render(committed, takeover);
      expect(cues).toEqual([]);
      /* The purchase, then the old crown beginning to fade, then the certificates crossing. The sound has
         one meaning -- a president has been INSTALLED -- so none of these is it. */
      tick(TRANSFER_MS + EXCHANGE_AT_MS + 1);
      expect(crownClass("PRR", ALICE)).toBe("app-stock-crown-out");
      expect(cues).toEqual([]);

      tick(HANDOVER_AT_MS - EXCHANGE_AT_MS);
      expect(crownClass("PRR", BOB)).toBe("app-stock-crown-in");
      expect(cues).toEqual(["presidency"]);
    });

    it("fires once for a first president, on the beat the purchase resolves", () => {
      const committed = board(ALICE, { [ALICE]: 20 }, { ipo: 80, bank: 0 });
      const par: StockTransactionEvent = {
        token: 14,
        companyId: PRR,
        ticker: "PRR",
        kind: "buy",
        transfer: { from: "Ipo", to: ALICE, percentage: 20 },
        presidency: null,
        before: snap(null, {}, { ipo: 100, bank: 0 }),
        after: snap(ALICE, { [ALICE]: 20 }, { ipo: 80, bank: 0 }),
      };
      render(committed, par);
      expect(cues).toEqual([]);
      tick(TRANSFER_RESOLVE_AT_MS - 1);
      expect(cues).toEqual([]);
      tick(2);
      expect(crownClass("PRR", ALICE)).toBe("app-stock-crown-in");
      expect(cues).toEqual(["presidency"]);
    });

    it("fires once per arrival, not once per render", () => {
      const committed = board(ALICE, { [ALICE]: 20 }, { ipo: 80, bank: 0 });
      const par: StockTransactionEvent = {
        token: 15,
        companyId: PRR,
        ticker: "PRR",
        kind: "buy",
        transfer: { from: "Ipo", to: ALICE, percentage: 20 },
        presidency: null,
        before: snap(null, {}, { ipo: 100, bank: 0 }),
        after: snap(ALICE, { [ALICE]: 20 }, { ipo: 80, bank: 0 }),
      };
      render(committed, par);
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      expect(cues).toEqual(["presidency"]);
      /* Three more renders of the same beat -- a poll, a parent update, anything. The callback identity is
         fresh each time, so the effect re-runs and the guard is what stops it. */
      render(committed, par);
      render(committed, par);
      tick(TRANSFER_MS);
      expect(cues).toEqual(["presidency"]);
    });

    it("stays silent for a transaction that installs no president", () => {
      const committed = board(ALICE, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 });
      render(committed, {
        token: 16,
        companyId: PRR,
        ticker: "PRR",
        kind: "buy",
        transfer: { from: "Bank", to: BOB, percentage: 20 },
        presidency: null,
        before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }),
        after: snap(ALICE, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
      });
      tick(TRANSFER_MS * 3);
      expect(cues).toEqual([]);
    });

    it("never fires late for a sequence superseded before its crown arrived", () => {
      const afterTakeover = board(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 });
      render(afterTakeover, {
        token: 17,
        companyId: PRR,
        ticker: "PRR",
        kind: "buy",
        transfer: { from: "Bank", to: BOB, percentage: 20 },
        presidency: { from: ALICE, to: BOB },
        before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }),
        after: snap(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
      });
      /* Interrupted well before the handover beat. */
      tick(TRANSFER_MS / 2);
      expect(cues).toEqual([]);

      const afterOrdinary = board(BOB, { [ALICE]: 50, [BOB]: 50 }, { ipo: 0, bank: 0 });
      render(afterOrdinary, {
        token: 18,
        companyId: PRR,
        ticker: "PRR",
        kind: "buy",
        transfer: { from: "Ipo", to: ALICE, percentage: 10 },
        presidency: null,
        before: snap(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
        after: snap(BOB, { [ALICE]: 50, [BOB]: 50 }, { ipo: 0, bank: 0 }),
      });
      /* Past the moment the abandoned takeover's handover would have been. Its timers are gone and its
         progress was discarded, so `applied.presidency` never becomes true for it. */
      tick(TRANSFER_MS * 4);
      expect(cues).toEqual([]);
    });
  });

  it("keeps the focus and the emphasis under reduced motion, and draws no proxy", () => {
    (window as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia = () => ({
      matches: true,
    });
    try {
      const committed = board(ALICE, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 });
      render(committed, {
        token: 6,
        companyId: PRR,
        ticker: "PRR",
        kind: "buy",
        transfer: { from: "Bank", to: BOB, percentage: 20 },
        presidency: null,
        before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }),
        after: snap(ALICE, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
      });
      expect(proxies("PRR")).toHaveLength(0);
      expect(dimmed("PRR", "Ipo")).toBe(true);
      expect(dimmed("PRR", BOB)).toBe(false);
      expect(card("PRR").style.borderColor).toBeTruthy();
      /* The staging still runs: the figures advance on the same clock, they simply are not chased by a
         chip. The reader sees the board change under a focused card rather than nothing at all. */
      expect(shares("PRR", BOB)).toContain("30%");
      tick(TRANSFER_RESOLVE_AT_MS + 1);
      expect(shares("PRR", BOB)).toContain("50%");
    } finally {
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  });
});
