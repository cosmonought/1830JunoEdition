/** @jest-environment jsdom */
//
// ==================================================================
//  RULES REFERENCE (harness): AUCTION & PRIVATES IS FOUR SECTIONS NOW
// ==================================================================
//
// The page drew three ALTERNATIVES as a flow with arrows through them, then hid the thing that makes this
// auction hard to learn -- a bid on the cheapest company stops ordinary turns -- inside one of nine
// identically styled `More detail` sections, and then restated most of those sections in a Timing Quick
// Reference at the foot. The redesign is checked here as claims about the rendered page:
//   1. an ordinary turn is a CHOICE of three: no arrows, nothing clickable, and the same three names the
//      Overview's chips use;
//   2. the interrupt is a BRANCH off that choice, above the fold, carrying the pause, the one-bidder and
//      many-bidder cases, and the resume condition;
//   3. the Priority Deal Card's two states are stated once each -- it moves on a buy, not on a resolution;
//   4. all-players-pass is its own small branch with both of 1.2.3's conditions;
//   5. the 1.2.2 detail lives in Resolving bids, below the flow, not in the opening;
//   6. the catalog is DERIVED: the variant seventh private appears because the game has it, tagged, and the
//      page never hard-codes a count;
//   7. the cross-round rules are separate from the auction and never say an unqualified "Phase 3+";
//   8. nothing on this page -- or anywhere in the reference now -- is behind a disclosure.
//
// And one source scan: `RuleSection`, `MoreToggle` and `BulkToggle` left the file with this page, so a future
// pass cannot quietly reintroduce an accordion by calling one of them.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RulesReference, { type RulesReferenceProps } from "./RulesReference";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const SOURCE = fs.readFileSync(path.join(__dirname, "RulesReference.tsx"), "utf8");
const { stripComments } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");
const STRIPPED = stripComments(SOURCE);

let container: HTMLDivElement;
let root: Root;

const PHASE_2: RulesReferenceProps["phase"] = { label: "Phase 2", tier: "2", trainLimit: 4 };
const LIVE_AUCTION: RulesReferenceProps = { roundType: "WaterfallAuction", playerCount: 4, phase: PHASE_2 };
const LPF: RulesReferenceProps = {
  roundType: "StockRound",
  roundLabel: "SR2",
  playerCount: 5,
  phase: { label: "Phase 3", tier: "3", trainLimit: 4 },
  variants: {
    expandedMap: false,
    levelPlayingField: true,
    delayedAuction: true,
    gentleRust: false,
    unpredictableRevenue: false,
    dynamicStockMarket: false,
    plusTiles: false,
  },
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: RulesReferenceProps = {}) {
  act(() => {
    root.render(<RulesReference {...props} />);
  });
}

function click(node: Element | null) {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function auctionPage(props: RulesReferenceProps = LIVE_AUCTION): HTMLElement {
  render(props);
  click(container.querySelector('[data-testid="rules-page-auction"]'));
  const page = container.querySelector<HTMLElement>('[data-testid="rules-auction-page"]');
  if (!page) throw new Error("the Auction & Privates page did not render");
  return page;
}

function testId(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function required(id: string): HTMLElement {
  const found = testId(id);
  if (!found) throw new Error(`not rendered: ${id}`);
  return found;
}

function section(id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`#${id}`);
  if (!found) throw new Error(`no section: ${id}`);
  return found;
}

function occurrences(phrase: string, within: Element = container): number {
  const text = within.textContent ?? "";
  let count = 0;
  let at = text.indexOf(phrase);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(phrase, at + phrase.length);
  }
  return count;
}

/* ------------------------------------------------------------------ */

describe("the page is four sections, in the order a player meets them", () => {
  it("renders the three sections below the flow, in order", () => {
    const page = auctionPage();
    const ids = Array.from(page.querySelectorAll<HTMLElement>("section[id]")).map((node) => node.id);
    expect(ids).toEqual(["rules-section-bids", "rules-section-companies", "rules-section-holding"]);
  });

  it("points every jump link at a section that exists", () => {
    auctionPage();
    const links = Array.from(required("rules-auction-jump").querySelectorAll("button"));
    expect(links.length).toBe(3);
    links.forEach((link) => {
      click(link);
    });
    ["rules-section-bids", "rules-section-companies", "rules-section-holding"].forEach((id) => {
      expect(document.getElementById(id)).not.toBeNull();
    });
  });
});

describe("an ordinary turn is a choice, not a sequence", () => {
  it("offers exactly three alternatives", () => {
    auctionPage();
    const choices = required("rules-auction-choices");
    expect(choices.children).toHaveLength(3);
    const text = choices.textContent ?? "";
    expect(text).toContain("Pass");
    expect(text).toContain("Buy the lowest unsold");
    expect(text).toContain("Bid on another unsold");
  });

  it("draws no arrows between them and nothing to press", () => {
    auctionPage();
    const choices = required("rules-auction-choices");
    /* THREE THINGS YOU MAY DO, not three things you do in turn. An arrow between alternatives is a claim
       about order that the rulebook does not make. */
    expect((choices.textContent ?? "").indexOf("→")).toBe(-1);
    expect(choices.querySelectorAll("button")).toHaveLength(0);
    Array.from(choices.querySelectorAll<HTMLElement>("*")).forEach((node) => {
      expect(node.style.border).toBe("");
      expect(node.style.backgroundColor).toBe("");
    });
  });

  it("says who starts and which way the turn passes", () => {
    const page = auctionPage();
    expect(page.textContent).toContain("Starting with the holder of the Priority Deal Card, turns proceed clockwise");
  });
});

describe("the interrupt is a branch off the ordinary turn", () => {
  it("scans as four moves, with every condition and consequence kept", () => {
    auctionPage();
    const branch = required("rules-auction-interrupt");
    const text = branch.textContent ?? "";
    /* WAS three paragraphs that said when the interrupt starts and when it ends twice each. */
    expect(text).toContain("Pause");
    expect(text).toContain("ordinary buy-bid-turns stop as soon as the lowest unsold Private Company has a bid");
    expect(text).toContain("Resolve it");
    expect(text).toContain("Check the new lowest unsold company");
    expect(text).toContain("Resume");
    expect(text).toContain("once the lowest unsold company has no bids");
    /* Both outcomes stay distinguishable inside one move. */
    expect(text).toContain("one bidder buys it for their bid");
    expect(text).toContain("several bidders settle it in an auction among themselves");
    /* And each of the two is said ONCE in the branch, not restated by a closing sentence. */
    expect(occurrences("buy-bid-turn", branch)).toBe(1);
    expect(occurrences("has no bids", branch)).toBe(1);
  });

  it("sits directly under the choice it interrupts, and is not a second flow", () => {
    const page = auctionPage();
    const choices = required("rules-auction-choices");
    const branch = required("rules-auction-interrupt");
    expect(choices.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    /* NOT FIVE STAGES IN A ROW: a branch is text one step in from the thing it interrupts. */
    expect(branch.querySelectorAll("[data-testid='rules-auction-choices']")).toHaveLength(0);
    expect((branch.textContent ?? "").indexOf("→")).toBe(-1);
  });

  it("links to the section that settles a contested company rather than explaining it here", () => {
    auctionPage();
    const link = required("rules-auction-interrupt").querySelector("button");
    expect(link?.textContent).toContain("The mini-auction, and what a bid costs");
    /* The 1.2.2 mechanics belong below; the opening must not carry them. */
    const flow = required("rules-auction-interrupt").textContent ?? "";
    expect(flow).not.toContain("minimum raise");
    expect(flow).not.toContain("Minimum raise");
  });
});

describe("the polish pass's own claims", () => {
  it("offers a way to the catalog from the top of the page", () => {
    auctionPage();
    const lead = required("rules-auction-lead");
    const link = required("rules-auction-page").querySelector<HTMLElement>('[style*="margin-top"] button, button');
    /* A player opening this tab mid-game usually wants a company, not the auction procedure. */
    const jump = Array.from(required("rules-auction-page").querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").indexOf("Private companies") === 0,
    );
    expect(jump).toBeDefined();
    expect(lead.compareDocumentPosition(jump!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(required("rules-auction-choices").contains(jump!)).toBe(false);
    expect(link).not.toBeNull();
  });

  it("does not claim the base game's timing on a delayed-auction table", () => {
    /* `gameVariants.ts` #905: the delayed auction opens on Stock Round 1 with no privates in play and runs at
       the end of the Operating Round set in which the first 3-train is bought. "Before the first Stock
       Round" and "The first Stock Round follows" are both false there. */
    auctionPage(LPF);
    expect(required("rules-auction-lead").textContent).not.toContain("Before the first Stock Round");
    expect(required("rules-auction-ends").textContent).not.toContain("The first Stock Round follows");
    expect(required("rules-auction-ends").textContent).toContain("The auction ends when every Private Company has been bought");
    /* And the real trigger is stated, in the labelled variant block. */
    expect(required("rules-auction-variants").textContent).toContain("end of the Operating Round set in which the first 3-train is bought");
  });

  it("keeps the base game's timing when no variant applies", () => {
    auctionPage();
    expect(required("rules-auction-lead").textContent).toContain("Before the first Stock Round");
    expect(required("rules-auction-ends").textContent).toContain("The first Stock Round follows");
  });

  it("hides the catalog's column headings when the rows stack, and labels the closure cell instead", () => {
    auctionPage();
    /* jsdom applies no media queries, so the rule itself is asserted against the stylesheet. */
    const css = Array.from(document.querySelectorAll("style")).map((n) => n.textContent ?? "").join("\n");
    const narrow = css.slice(css.indexOf("@media (max-width: 760px)"));
    expect(narrow).toContain(".rr-au-head { display: none; }");
    expect(narrow).toContain('.rr-au-close::before { content: "Closes: "; }');
    /* And the elements those rules need are on the page. */
    expect(container.querySelector(".rr-au-head")).not.toBeNull();
    expect(container.querySelector(".rr-au-close")).not.toBeNull();
  });

  it("caps the exception notes shorter than the power bullets beside them", () => {
    auctionPage();
    const dh = required("rules-private-DH");
    const notes = Array.from(dh.querySelectorAll<HTMLElement>("span")).filter((n) => n.style.maxWidth === "58ch");
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe("the Priority Deal Card distinction is visible and said once", () => {
  it("moves on a buy and stays on a resolution", () => {
    auctionPage();
    const priority = required("rules-auction-priority").textContent ?? "";
    /* Rulebook 1.2: the card passes when a player BUYS the lowest company, and "does not change hands after
       an auction". Passing does not move it either. */
    expect(priority).toContain("buys the lowest unsold company on an ordinary turn");
    expect(priority).toContain("player on that buyer’s left");
    expect(priority).toContain("a bid or a mini-auction is resolved");
    expect(priority).toContain("Neither moves the card");
  });
});

describe("all players passing is its own small branch", () => {
  it("states both of 1.2.3's conditions", () => {
    auctionPage();
    const branch = required("rules-auction-all-pass").textContent ?? "";
    expect(branch).toContain("Schuylkill Valley (SV) is still unsold");
    expect(branch).toContain("reduce SV's purchase price by $5");
    expect(branch).toContain("If SV reaches $0, the next player who takes a buy-bid-turn must buy SV for $0");
    expect(branch).toContain("If SV has already been purchased, each owned Private Company pays its normal revenue");
    expect(branch).toContain("resumes with the Priority Deal Card holder");
  });
});

describe("the auction's end, and the variants, are separated from the base procedure", () => {
  it("says what follows the auction", () => {
    auctionPage();
    expect(required("rules-auction-ends").textContent).toContain("The first Stock Round follows");
  });

  it("shows no variant block when no variant applies", () => {
    auctionPage();
    expect(testId("rules-auction-variants")).toBeNull();
  });

  it("labels an active variant and places it after the base procedure", () => {
    auctionPage(LPF);
    const variants = required("rules-auction-variants");
    expect(variants.textContent).toContain("Variant in play on this table");
    expect(variants.textContent).toContain("Delayed auction");
    const ends = required("rules-auction-ends");
    expect(ends.compareDocumentPosition(variants) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    /* And never inside the interruption, which is the base game's. */
    expect(required("rules-auction-interrupt").contains(variants)).toBe(false);
  });
});

describe("Resolving bids holds the 1.2.2 detail, below the flow", () => {
  it("states what a bid costs and how a contested company is settled", () => {
    auctionPage();
    const bids = section("rules-section-bids").textContent ?? "";
    expect(bids).toContain("at least $5");
    expect(bids).toContain("$1 increments");
    expect(bids).toContain("set aside");
    expect(bids).toContain("The starting price is the highest bid already made");
    expect(bids).toContain("Minimum raise is $5");
    expect(bids).toContain("The player with the lowest bid starts");
    expect(bids).toContain("pass and re-enter");
    expect(bids).toContain("When all bidders pass consecutively");
    expect(bids).toContain("Unsuccessful bidders recover their committed bid money");
  });

  it("keeps it out of the opening", () => {
    auctionPage();
    const opening = required("rules-auction-choices").textContent ?? "";
    expect(opening).not.toContain("Minimum raise");
    expect(occurrences("Minimum raise is $5")).toBe(1);
  });
});

describe("the private-company catalog is read from the game, not typed out here", () => {
  it("lists the printed six by default, each scannable", () => {
    auctionPage();
    const rows = Array.from(section("rules-section-companies").querySelectorAll('[data-testid^="rules-private-"]'));
    expect(rows).toHaveLength(6);
    const sv = required("rules-private-SV").textContent ?? "";
    expect(sv).toContain("Schuylkill Valley");
    expect(sv).toContain("$20");
    expect(sv).toContain("$5/OR");
    expect(sv).toContain("G-15");
    expect(sv).toContain("No special power");
    expect(sv).toContain("First 5-train");
  });

  it("lists the variant's seventh private, tagged, when that variant is on", () => {
    auctionPage(LPF);
    const rows = Array.from(section("rules-section-companies").querySelectorAll('[data-testid^="rules-private-"]'));
    expect(rows).toHaveLength(7);
    const jk = required("rules-private-JK").textContent ?? "";
    expect(jk).toContain("James River & Kanawha");
    expect(jk).toContain("LPF");
    expect(jk).toContain("$120");
  });

  it("never hard-codes a count", () => {
    const page = auctionPage();
    expect(page.textContent).not.toContain("There are six private companies");
    expect(page.textContent).not.toContain("six private companies");
  });

  it("marks only the two companies that close early", () => {
    auctionPage();
    expect(required("rules-private-MH").textContent).toContain("On its NYC exchange");
    expect(required("rules-private-BO").textContent).toContain("B&O's first train");
    expect(required("rules-private-CSL").textContent).toContain("First 5-train");
  });

  it("carries an exception note only where one is needed, and reads as a sentence", () => {
    auctionPage();
    const mh = required("rules-private-MH").textContent ?? "";
    /* WAS joined with a capital "And" mid-sentence. */
    expect(mh).not.toContain("; And ");
    /* Rulebook 3.0 states the eligibility as a threshold -- "provided he does not already hold 60% of the NYC
       shares" -- where the player-aid summary softens it to "provided he may hold another share of the NYC".
       The page and `privateCatalog.ts`'s long form now both use the threshold. */
    expect(mh).toContain("hold under 60% of the NYC, and an NYC share must be free in the IPO or the Bank Pool.");
    expect(mh).not.toContain("applicable ownership limit");
    /* Design note #771: the two piles are the IPO and the Bank Pool. */
    expect(mh).not.toContain("Bank or Bank Pool");
    expect(required("rules-private-SV").textContent).not.toContain("Exception");
  });
});

describe("the cross-round rules are separate from the auction", () => {
  it("gives revenue, both ways of changing hands, and closure their own treatments", () => {
    auctionPage();
    const holding = section("rules-section-holding").textContent ?? "";
    expect(holding).toContain("Revenue while open");
    expect(holding).toContain("Player to player");
    expect(holding).toContain("Player to corporation");
    expect(holding).toContain("Closure");
  });

  it("states the player sale window, first Stock Round excluded", () => {
    auctionPage();
    const holding = section("rules-section-holding").textContent ?? "";
    /* Rulebook 3.1. */
    expect(holding).toContain("buyer's or seller's turn of a Stock Round other than the first Stock Round");
    expect(holding).toContain("any mutually agreed price");
  });

  it("bounds the corporation's window at both ends rather than saying Phase 3+", () => {
    const page = auctionPage();
    const holding = section("rules-section-holding").textContent ?? "";
    /* Rulebook 3.0 and 3.2. */
    expect(holding).toContain("During phases 3 and 4");
    expect(holding).toContain("until every Private Company closes at the first 5-train");
    expect(holding).toContain("No less than half the company's face value");
    expect(holding).toContain("No more than twice its face value");
    expect(holding).toContain("publicly declared");
    expect(holding).toContain("may not sell them");
    expect(page.textContent).not.toContain("Phase 3+");
    expect(page.textContent).not.toContain("Beginning in Phase 3");
  });

  it("keeps closure as a lookup with the earlier conditions named", () => {
    auctionPage();
    const holding = section("rules-section-holding").textContent ?? "";
    expect(holding).toContain("The B&O purchases its first train");
    expect(holding).toContain("Exchanged for its 10% NYC share");
    expect(holding).toContain("The first 5-train is purchased");
    expect(holding).toContain("cannot be sold into the Bank Pool");
  });
});

describe("nothing on the page is behind a disclosure", () => {
  it("has no toggles, no bulk toggle and no Timing Quick Reference", () => {
    const page = auctionPage();
    expect(page.querySelectorAll("[aria-expanded]")).toHaveLength(0);
    expect(page.textContent).not.toContain("More detail");
    expect(page.textContent).not.toContain("Expand all");
    /* Every row of it restated a rule from the section above it; the timing now leads those rules. */
    expect(page.textContent).not.toContain("Timing Quick Reference");
  });

  it("left the accordion machinery out of the file", () => {
    expect(STRIPPED.indexOf("function RuleSection(")).toBe(-1);
    expect(STRIPPED.indexOf("function MoreToggle(")).toBe(-1);
    expect(STRIPPED.indexOf("function BulkToggle(")).toBe(-1);
  });
});

describe("the other pages are untouched by this pass", () => {
  it("still renders Overview, Stock Round, Operating Round and Tables as they were", () => {
    render(LIVE_AUCTION);
    expect(container.textContent).toContain("At a glance");
    click(container.querySelector('[data-testid="rules-page-stock"]'));
    expect(container.textContent).toContain("Market Effects");
    click(container.querySelector('[data-testid="rules-page-operating"]'));
    expect(container.textContent).toContain("Run Routes");
    expect(container.textContent).toContain("Home hexes — NYC and Erie");
    click(container.querySelector('[data-testid="rules-page-tables"]'));
    expect(container.textContent).toContain("Player Limits");
    expect(document.getElementById("rules-reference-forced-purchase")).not.toBeNull();
  });

  it("still names the same three choices the Overview's chips use", () => {
    render(LIVE_AUCTION);
    /* `AUCTION_FLOW` is one list rendered by two pages; the Overview shows it with the arrows off. */
    expect(container.textContent).toContain("Buy lowest");
    click(container.querySelector('[data-testid="rules-page-auction"]'));
    expect(container.textContent).toContain("Buy the lowest unsold");
  });
});
