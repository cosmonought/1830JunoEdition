/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1702 (harness): GR-3 -- WHAT THE PLAYER ACTUALLY SEES (the rendered half)
// ==================================================================
//
// The engine half (`utils/gentleRustPresentation.test.ts`) proves each sentence is TRUE of the board. This half proves
// the surfaces SHOW it: every prop below is built from a board the real reducer produced, by the same function the
// shell calls (`finalRunScheduleFor`, `dieselExchangeOfferFor`, `dieselExchangeMayFollowPurchase`, `autoSkipExit` over
// `stepsFor`, `pendingTrainDiscards`), and the assertions read the rendered DOM -- enabled / disabled controls, their
// accessible names, the visible text. Strings are checked by the concept they carry, not by punctuation.
//
// REPRESENTATION-ONLY boards are labelled: two identical copies of one model with one marked cannot arise in play (a
// phase change marks every copy), but the multiset authority answers it and the brief requires the surfaces to.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TrainChips } from "./TrainBadges";
import TrainPurchasePanel, { TrainDiscardPrompt, type TrainPurchaseCompany } from "./TrainPurchasePanel";
import RulesReference from "./RulesReference";
import type { GameStateResponse } from "../gameEngine/gameState";
import { derivePhase, depotInventory, openDepotTiers } from "../gameEngine/gamePhase";
import { resolveVariants } from "../gameEngine/gameVariants";
import { dieselExchangeMayFollowPurchase, dieselExchangeOfferFor } from "../gameEngine/dieselExchange";
import { autoSkipExit } from "../gameEngine/autoSkipExit";
import { stepsFor } from "../gameEngine/operatingCursor";
import { pendingTrainDiscards } from "../gameEngine/trainDiscard";
import { finalRunScheduleFor } from "../utils/finalRunTiming";
import * as S from "../utils/gentleRustPresentationSupport";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { PRR, NYC, BO, CO, board, company, send, BUY, BUY_RETURNED, SALE, PASS, advanceTo, acting, marksOf } = S;

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
const click = (node: Element | null) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

/* ------------------------------------------------------------------ */
/* Boards (the engine half's, rebuilt here)                          */
/* ------------------------------------------------------------------ */

/** Phase 3, the next depot purchase the first 4; NYC operates first at Buy Trains, then PRR, then B&O. */
const firstFourByNyc = (gentle = true) =>
  board({
    corps: [
      { id: NYC, trains: ["2", "2", "3"] },
      { id: PRR, trains: ["2", "2", "3", "3"] },
      { id: BO, trains: ["2", "2", "3", "3"] },
    ],
    operating: NYC,
    gentle,
  });

const dieselStart = (prr: string[], opts: { gentle?: boolean; lpf?: boolean; returned?: string[] } = {}) =>
  opts.lpf
    ? board({ corps: [{ id: PRR, trains: prr }, { id: NYC, trains: ["6"] }], operating: PRR, lpf: true, gentle: opts.gentle })
    : board({
        corps: [{ id: PRR, trains: prr }, { id: NYC, trains: ["6", "6"] }, { id: BO, trains: ["4"] }],
        operating: PRR,
        gentle: opts.gentle,
        returned: opts.returned,
      });

/** Hand-sets a mark: REPRESENTATION-ONLY boards, labelled where used. */
const markedBy = (state: GameStateResponse, id: number, marks: string[]): GameStateResponse =>
  ({
    ...state,
    public_companies: state.public_companies.map((entry) => (entry.company_id === id ? { ...entry, pending_rust_trains: marks } : entry)),
  }) as GameStateResponse;

/* ------------------------------------------------------------------ */
/* Rendering the surfaces exactly as the shell wires them             */
/* ------------------------------------------------------------------ */

function chipTitles(state: GameStateResponse, id: number, opts: { withTiming?: boolean } = { withTiming: true }): string[] {
  const entry = company(state, id);
  render(
    <TrainChips
      trains={entry.owned_trains}
      phase={derivePhase(state)}
      surface="dark"
      reprieved={entry.pending_rust_trains}
      reprievedThisTurn={opts.withTiming ? finalRunScheduleFor(state, id).thisTurn : undefined}
    />,
  );
  return Array.from(host.querySelectorAll<HTMLElement>("span[title]")).map((node) => node.getAttribute("title") ?? "");
}

/** The Buy Trains panel for the operating corporation, with the shell's props (App.tsx's `trainPurchase`). */
function renderPanel(state: GameStateResponse, opts: { corporateOpen?: boolean } = {}) {
  const buyerId = acting(state)!;
  render(
    <TrainPurchasePanel
      depot={depotInventory(state)}
      buyer={company(state, buyerId) as unknown as TrainPurchaseCompany}
      companies={state.public_companies as unknown as TrainPurchaseCompany[]}
      sessionReady
      canAct
      blockedReason={null}
      onBuyFromBank={() => undefined}
      openTiers={openDepotTiers(state)}
      endsTurnAtLimit={autoSkipExit("Hardware", stepsFor(state)) === "end-turn"}
      dieselExchange={dieselExchangeOfferFor(state, buyerId)}
      onExchangeForDiesel={() => undefined}
      exchangeMayFollowPurchase={(tier, price) => dieselExchangeMayFollowPurchase(state, buyerId, tier, price)}
      onProposeTrade={() => undefined}
      labelForAddress={(address) => address}
      defaultCorporateOpen={opts.corporateOpen === true}
    />,
  );
}

const payButton = () =>
  Array.from(host.querySelectorAll("button")).find((node) => /^(Pay \$|Train Limit Reached)/.test(node.textContent ?? ""))!;
const exchangeButton = () => Array.from(host.querySelectorAll("button")).find((node) => /^Exchange and Pay/.test(node.textContent ?? ""));
const radios = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]'));

/** The seller roster row for `ticker` (corporate section open). */
function sellerBadges(ticker: string): HTMLButtonElement[] {
  const rows = Array.from(host.querySelectorAll("div")).filter(
    (node) => node.querySelector("button") !== null && (node.textContent ?? "").startsWith(ticker),
  );
  const row = rows[rows.length - 1];
  if (!row) throw new Error(`no roster row for ${ticker}`);
  return Array.from(row.querySelectorAll<HTMLButtonElement>("button"));
}
const saleNotes = () => Array.from(host.querySelectorAll('[data-testid="sale-final-run-note"]')).map((node) => node.textContent);

/* ================================================================================================= */
/* U-1 -- THE CHIP TOOLTIP                                                                           */
/* ================================================================================================= */

describe("U-1. a Final Run chip's tooltip tells the truth about its state", () => {
  it("UI1. in the current grace turn: goes after THIS turn's Run Routes -- never 'next depot purchase'", () => {
    const state = send(send(firstFourByNyc(), BUY(NYC)), PASS);
    expect(acting(state)).toBe(PRR);
    const titles = chipTitles(state, PRR);
    expect(titles).toHaveLength(4);
    const finalRun = titles.slice(0, 2);
    for (const title of finalRun) {
      expect(title).toMatch(/Final Run/);
      expect(title).toMatch(/removed after this turn's Run Routes/);
      expect(title).toMatch(/does not count against the train limit/);
      expect(title).toMatch(/still one of the corporation's trains/);
      expect(title).not.toMatch(/depot purchase/i);
    }
    // The 3-trains are ordinary chips with the ordinary outlook.
    for (const title of titles.slice(2)) expect(title).not.toMatch(/Final Run/);
  });

  it("UI2. self-doomed in this turn's Buy Trains: its NEXT Operating Turn", () => {
    const state = send(firstFourByNyc(), BUY(NYC));
    const titles = chipTitles(state, NYC).filter((title) => /Final Run/.test(title));
    expect(titles).toHaveLength(2);
    for (const title of titles) {
      expect(title).toMatch(/next Operating Turn/);
      expect(title).not.toMatch(/this turn's Run Routes/);
    }
  });

  it("UI3. a corporation that is not operating: its NEXT Operating Turn", () => {
    const state = send(firstFourByNyc(), BUY(NYC));
    const titles = chipTitles(state, BO).filter((title) => /Final Run/.test(title));
    expect(titles).toHaveLength(2);
    for (const title of titles) expect(title).toMatch(/next Operating Turn/);
  });

  it("a surface with no board to ask names the rule, not a turn -- and still never a depot purchase", () => {
    const state = send(firstFourByNyc(), BUY(NYC));
    const titles = chipTitles(state, BO, { withTiming: false }).filter((title) => /Final Run/.test(title));
    for (const title of titles) {
      expect(title).toMatch(/first Operating Turn that begins after the rust/);
      expect(title).not.toMatch(/depot purchase/i);
    }
  });

  it("UI5. a chip one purchase from rusting keeps the ordinary warning, standard game and Gentle Rust alike", () => {
    for (const gentle of [false, true]) {
      const titles = chipTitles(firstFourByNyc(gentle), PRR);
      expect(titles.slice(0, 2)).toEqual(["CRITICAL: Rusts on NEXT depot purchase!", "CRITICAL: Rusts on NEXT depot purchase!"]);
    }
  });
});

/* ================================================================================================= */
/* U-11 -- THE SALE ROSTER                                                                          */
/* ================================================================================================= */

describe("U-11. the corporation-to-corporation roster greys what the sale authority refuses", () => {
  /** NYC buys the first 4; PRR (P1, who also presides over C&O) reaches Buy Trains with C&O holding a marked 2. */
  const atPrrHardware = () =>
    advanceTo(
      send(
        send(
          board({
            corps: [
              { id: NYC, trains: ["2", "2", "3"] },
              { id: PRR, trains: ["2", "3", "3"] },
              { id: CO, trains: ["2", "3"] },
              { id: BO, trains: ["2", "2", "3"] },
            ],
            operating: NYC,
            gentle: true,
          }),
          BUY(NYC),
        ),
        PASS,
      ),
      "Hardware",
    );

  it("UI6. a sole Final Run copy is disabled, named as such, and its reason is readable without hovering", () => {
    const state = atPrrHardware();
    expect(marksOf(state, CO)).toEqual(["2"]);
    renderPanel(state, { corporateOpen: true });
    const [two, three] = sellerBadges("C&O");
    expect([two.textContent, two.disabled]).toEqual(["2", true]);
    expect(two.getAttribute("aria-label")).toMatch(/2-train on its Final Run/);
    expect(two.getAttribute("title")).toBe("C&O's 2-train is on its Gentle Rust final run — it cannot be sold to another corporation.");
    expect(two.style.textDecoration).toBe("line-through"); // not colour alone
    expect([three.textContent, three.disabled]).toEqual(["3", false]);
    // Every seller holding Final Run trains explains them in its own row -- NYC (the buyer of the first 4) and
    // B&O hold two each.
    expect(saleNotes()).toEqual([
      "Every 2-train NYC holds is on its Gentle Rust final run — none can be sold to another corporation.",
      "C&O's 2-train is on its Gentle Rust final run — it cannot be sold to another corporation.",
      "Every 2-train B&O holds is on its Gentle Rust final run — none can be sold to another corporation.",
    ]);
  });

  it("UI7 / UI8. REPRESENTATION-ONLY mixed copies: one ordinary 2 stays live; after it is sold the other is disabled", () => {
    const state = markedBy(
      board({
        corps: [{ id: PRR, trains: ["3"] }, { id: NYC, trains: ["2", "2", "2"] }, { id: CO, trains: ["2", "2", "3"] }],
        operating: PRR,
        gentle: true,
      }),
      CO,
      ["2"],
    );
    renderPanel(state, { corporateOpen: true });
    const badges = sellerBadges("C&O");
    expect(badges.map((badge) => [badge.textContent, badge.disabled])).toEqual([
      ["2", true],
      ["2", false],
      ["3", false],
    ]);
    expect(saleNotes()).toEqual([
      "One of C&O's 2-trains is on its Gentle Rust final run and cannot be sold to another corporation; the other can.",
    ]);

    const sold = send(state, SALE(PRR, CO, "2"));
    renderPanel(sold, { corporateOpen: true });
    expect(sellerBadges("C&O").map((badge) => [badge.textContent, badge.disabled])).toEqual([
      ["2", true],
      ["3", false],
    ]);
    expect(saleNotes()).toEqual(["C&O's 2-train is on its Gentle Rust final run — it cannot be sold to another corporation."]);
  });

  it("a standard game's roster is untouched: every badge live, no note", () => {
    const state = board({
      corps: [{ id: PRR, trains: ["3"] }, { id: NYC, trains: ["2", "2", "2"] }, { id: CO, trains: ["2", "2", "3"] }],
      operating: PRR,
    });
    renderPanel(state, { corporateOpen: true });
    expect(sellerBadges("C&O").every((badge) => !badge.disabled)).toBe(true);
    expect(saleNotes()).toEqual([]);
  });
});

/* ================================================================================================= */
/* U-11 + DT-1 -- THE TRADE-IN ROW                                                                   */
/* ================================================================================================= */

describe("U-11 / DT-1. the Diesel trade-in row", () => {
  it("UI9. a sole Final Run 4 is shown, disabled, with the canonical reason -- the row no longer vanishes", () => {
    const state = send(dieselStart(["4"], { gentle: true }), BUY(PRR, "D"));
    expect(marksOf(state, PRR)).toEqual(["4"]);
    renderPanel(state);
    const chips = radios();
    expect(chips.map((chip) => [chip.textContent, chip.disabled])).toEqual([["4", true]]);
    expect(chips[0].getAttribute("aria-label")).toMatch(/4-train on its Final Run/);
    expect(chips[0].style.textDecoration).toBe("line-through");
    expect(exchangeButton()!.disabled).toBe(true);
    expect(host.textContent).toContain(
      "PRR's only 4-, 5- or 6-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.",
    );
  });

  it("UI10. a Final Run 4 beside an ordinary 5: the 5 is selectable and the exchange live; the 4 is explained", () => {
    const withD = send(dieselStart(["4"], { gentle: true, returned: ["5"] }), BUY(PRR, "D"));
    const state = send(withD, BUY_RETURNED(PRR, "5"));
    renderPanel(state);
    expect(radios().map((chip) => [chip.textContent, chip.disabled, chip.getAttribute("aria-checked")])).toEqual([
      ["5", false, "true"],
      ["4", true, "false"],
    ]);
    expect(exchangeButton()!.disabled).toBe(false);
    expect(Array.from(host.querySelectorAll('[data-testid="exchange-final-run-note"]')).map((n) => n.textContent)).toEqual([
      "PRR's 4-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.",
    ]);
  });

  it("UI11. REPRESENTATION-ONLY two identical 4s, one Final Run: one exchangeable 4, one greyed", () => {
    const state = markedBy(dieselStart(["4", "4"], { gentle: true }), PRR, ["4"]);
    renderPanel(state);
    expect(radios().map((chip) => [chip.textContent, chip.disabled])).toEqual([
      ["4", false],
      ["4", true],
    ]);
    expect(exchangeButton()!.disabled).toBe(false);
  });

  it("UI12 / UI20. an ordinary standard exchange: enabled, $800 shown and -$800 projected", () => {
    renderPanel(dieselStart(["4", "5"], { returned: ["5"] }));
    expect(radios().map((chip) => [chip.textContent, chip.disabled])).toEqual([
      ["4", false],
      ["5", false],
    ]);
    const button = exchangeButton()!;
    expect([button.textContent, button.disabled]).toEqual(["Exchange and Pay $800", false]);
    expect(button.getAttribute("aria-label")).toContain("pay $800");
    expect(host.textContent).toContain("Treasury: $3000 > $2200");
    expect(host.querySelector('[data-testid="exchange-final-run-note"]')).toBeNull();
  });

  it("UI13 / UI19. an ordinary Level Playing Field exchange: $750 shown and -$750 projected (was $800)", () => {
    renderPanel(dieselStart(["4", "5"], { lpf: true }));
    const button = exchangeButton()!;
    expect([button.textContent, button.disabled]).toEqual(["Exchange and Pay $750", false]);
    expect(host.textContent).toContain("Treasury: $3000 > $2250");
    expect(host.textContent).not.toContain("$800");
  });

  it("the chip rack wraps, so greyed copies never widen the row (mobile)", () => {
    renderPanel(markedBy(dieselStart(["4", "4"], { gentle: true }), PRR, ["4"]));
    const group = host.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(group.style.flexWrap).toBe("wrap");
  });
});

describe("DT-1. 'Pay $X and End Turn' only where the engine ends the turn", () => {
  it("UI18. phase 6, the last 6 for $630 with a legal exchange to follow: the button promises nothing", () => {
    const state = board({
      corps: [{ id: PRR, trains: ["4"] }, { id: NYC, trains: ["6"] }, { id: BO, trains: ["5", "5"] }],
      operating: PRR,
      returned: ["5"],
    });
    expect(autoSkipExit("Hardware", stepsFor(state))).toBe("end-turn"); // the old label WOULD have promised
    renderPanel(state);
    expect(payButton().textContent).toBe("Pay $630");
  });

  it("UI21. where the turn really ends, the phrase stays: phase 3 filling the limit, and phase 6 without the money", () => {
    renderPanel(board({ corps: [{ id: PRR, trains: ["2", "2", "3"] }, { id: NYC, trains: ["2", "2"] }, { id: BO, trains: ["2", "2"] }], operating: PRR }));
    expect(payButton().textContent).toBe("Pay $180 and End Turn");
    renderPanel(
      board({
        corps: [{ id: PRR, trains: ["4"], treasury: "700" }, { id: NYC, trains: ["6"] }, { id: BO, trains: ["5", "5"] }],
        operating: PRR,
        returned: ["5"],
      }),
    );
    expect(payButton().textContent).toBe("Pay $630 and End Turn");
  });

  it("a purchase that does not fill the limit never said it and still does not", () => {
    renderPanel(board({ corps: [{ id: PRR, trains: ["2", "3"] }, { id: NYC, trains: ["2", "2", "3"] }, { id: BO, trains: ["2", "2", "2"] }], operating: PRR }));
    expect(payButton().textContent).toMatch(/^Pay \$\d+$/);
  });
});

/* ================================================================================================= */
/* U-5 -- THE DISCARD PROMPT                                                                         */
/* ================================================================================================= */

describe("U-5. the excess-discard prompt explains the Final Run exclusion only when there is one", () => {
  const renderPrompt = (state: GameStateResponse, which = 0) => {
    const due = pendingTrainDiscards(state)!.queue[which];
    render(
      <TrainDiscardPrompt
        due={{ ...due, presidentLabel: due.president ?? due.ticker, finalRun: company(state, due.companyId).pending_rust_trains ?? [] }}
        viewerIsPresident
        onDiscard={() => undefined}
      />,
    );
    return due;
  };
  const NOTE = "Final Run trains do not count against the train limit and are not eligible for this discard.";

  it("NYC owes a discard and holds Final Run 2s: the note, and no button for the 2", () => {
    const due = renderPrompt(S.discardBoard(true));
    expect(due.companyId).toBe(NYC);
    expect(host.querySelector('[data-testid="discard-final-run-note"]')?.textContent).toBe(NOTE);
    const buttons = Array.from(host.querySelectorAll("button")).map((node) => node.textContent);
    expect(buttons).toEqual(["Discard 4-train"]);
  });

  it("B&O owes one too, with no Final Run train left: no note", () => {
    const due = renderPrompt(S.discardBoard(true), 1);
    expect(due.companyId).toBe(BO);
    expect(host.querySelector('[data-testid="discard-final-run-note"]')).toBeNull();
  });

  it("a standard game's discard reads exactly as before", () => {
    renderPrompt(S.discardBoard(false));
    expect(host.querySelector('[data-testid="discard-final-run-note"]')).toBeNull();
    expect(host.textContent).not.toContain("Final Run");
  });
});

/* ================================================================================================= */
/* U-4 -- THE RULES REFERENCE                                                                        */
/* ================================================================================================= */

describe("U-4. the Rules Reference states the whole Gentle Rust rule on the Buy Trains section", () => {
  const operatingPage = (gentleRust: boolean) => {
    render(<RulesReference variants={resolveVariants(gentleRust ? { gentleRust: true } : {})} />);
    click(host.querySelector('[data-testid="rules-page-operating"]'));
    const page = host.querySelector<HTMLElement>('[data-testid="rules-operating-page"]');
    if (!page) throw new Error("the Operating Round page did not render");
    return page;
  };

  it("is one tagged block inside Buy Trains, headed and listed in the page's own type -- no table, no disclosure", () => {
    operatingPage(true);
    const section = host.querySelector<HTMLElement>("#rules-section-buyTrains")!;
    const block = section.querySelector<HTMLElement>('[data-testid="rules-operating-gentle-rust"]')!;
    expect(block).not.toBeNull();
    expect(block.querySelector("h4")?.textContent).toMatch(/^Gentle Rust/);
    expect(block.querySelector("h4")?.textContent).toMatch(/Gentle rust$/i); // the variant tag
    expect(block.querySelectorAll("table, details, button")).toHaveLength(0);
    expect(block.querySelectorAll("ul").length).toBeGreaterThan(0);
    // The old one-sentence note is gone rather than repeated beside the block.
    expect(host.textContent).not.toContain("gets one last Operating Round turn before it goes");
  });

  it("carries every concept of the rule (audit U-4 A-H)", () => {
    operatingPage(true);
    const text = (host.querySelector('[data-testid="rules-operating-gentle-rust"]')?.textContent ?? "").replace(/\s+/g, " ");
    const concepts: Array<[string, RegExp]> = [
      ["A. ordinary triggers", /2-trains still rust when the first 4-train is bought, 3-trains when the first 6-train is bought, and 4-trains when the first Diesel/i],
      ["A. delay, not exemption", /never changes which trains rust/i],
      ["B. Final Run = first turn beginning after the rust", /Final Run: the corporation's first Operating Turn that begins after the train rusted/i],
      ["B. rival trigger -> same round", /another corporation's purchase before this corporation has operated this round.*later in the same round/i],
      ["B. self-trigger -> next turn", /own purchase in its Buy Trains step: the current turn does not count.*next Operating Turn/i],
      ["C. owned and usable", /still owned and usable/i],
      ["C. a turn, not a run", /one Operating Turn, not a guaranteed run/i],
      ["E. removed after Run Routes", /removed after Run Routes in its Final Run turn/i],
      ["D. excluded from the train limit", /does not count against the train limit/i],
      ["F. no excess discard", /never a choice when a corporation must discard down to the limit/i],
      ["D/U-10. still owned -> not trainless", /still count as a train the corporation owns.*not trainless/i],
      ["E. forced purchase only after removal", /Only after the train is removed can the corporation become trainless.*ordinary forced train purchase/i],
      ["G. no sale", /may not be sold to another corporation/i],
      ["G. no Diesel trade-in", /may not be traded in for a Diesel/i],
      ["G. other copies unaffected", /other may still be sold or traded in/i],
      ["H. Bank Pool", /Bank Pool get no Final Run/i],
    ];
    for (const [concept, pattern] of concepts) expect([concept, pattern.test(text)]).toEqual([concept, true]);
    // A TRAIN never "doesn't count" without the limit named (SR-1). ("The current turn does not count" is the
    // self-trigger's turn, not a train.)
    expect(text).not.toMatch(/(?:train|it) does(?: not|n't) count(?! against the train limit)/i);
  });

  it("is absent from a game that does not play Gentle Rust", () => {
    const page = operatingPage(false);
    expect(host.querySelector('[data-testid="rules-operating-gentle-rust"]')).toBeNull();
    expect(page.textContent).not.toMatch(/Final Run|Gentle rust/i);
  });
});
