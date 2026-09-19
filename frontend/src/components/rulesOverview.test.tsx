/** @jest-environment jsdom */
//
// ==================================================================
//  RULES REFERENCE (harness): OVERVIEW IS THE DASHBOARD, AND IT STAYS PUT
// ==================================================================
//
// CLAIMS THIS SUITE EXISTS FOR, none of which a source scan can check, because every one is about what the
// DOM contains after a render with particular props:
//   1. the reference OPENS on Overview, whatever round is live, and a ROUND CHANGE never moves the page;
//   2. Overview's content -- the action flow, the explanation, the lookup, the reminders -- is selected from
//      the LIVE STATE, so one component renders a different page for every cursor;
//   3. EACH FACT APPEARS IN EXACTLY ONE REGION. The first pass put the blocked-city rule in the Current
//      Action bullets AND in Watch For, the train-limit schedule in a bullet directly above the table that
//      lists it, and the forced purchase on both sides of the page. These cases count occurrences;
//   4. a reminder is shown only where it is TRUE -- the first-Stock-Round sale ban in Stock Round 1 and
//      nowhere else;
//   5. the Game Flow disclosure is collapsed while a round is live and open when none is.
//
// AND TWO CLAIMS A SCAN IS THE RIGHT TOOL FOR, so they are here too. Every Watch For string and every lookup
// table is SELECTED from a constant elsewhere in the file by a prefix or a column name; that indirection is
// what stops Overview from growing a stale copy of the rules, and its failure mode is silent. The resolution
// cases make it loud. The narrow-width rules are real CSS media queries, which jsdom does not apply, so those
// cases assert the two halves that can go wrong independently: the element carries the class, and the
// stylesheet carries the rule.
//
// NO `@testing-library/react` IN THE TREE, so this is `createRoot` + `React.act`, the pattern
// `turnAttention.test.ts` established. `act` comes from `react`, never `react-dom/test-utils`: the latter
// warns on every call in 18.3 and a harness that prints a deprecation notice teaches everyone to skim it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RulesReference, { lookupFor, watchItemsFor, type RulesReferenceProps, type RulesWatchKey } from "./RulesReference";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const SOURCE = fs.readFileSync(path.join(__dirname, "RulesReference.tsx"), "utf8");
/* #490a: an ABSENCE assertion is made against a comment-stripped copy, or a design note explaining why a
   property was removed satisfies the search for that property. Order matters -- JSX comments first. */
const { stripComments } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");
const STRIPPED = stripComments(SOURCE);

let container: HTMLDivElement;
let root: Root;

const PHASE_2: RulesReferenceProps["phase"] = { label: "Phase 2", tier: "2", trainLimit: 4 };
const PHASE_3: RulesReferenceProps["phase"] = { label: "Phase 3", tier: "3", trainLimit: 4 };
const PHASE_6: RulesReferenceProps["phase"] = { label: "Phase 6", tier: "6", trainLimit: 2 };

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

/** Render (or re-render) into the same root, so a second call is the shell seeing new props -- which is the
 *  only way to test that a ROUND CHANGE does not move the page. */
function mount(props: RulesReferenceProps = {}) {
  act(() => {
    root.render(<RulesReference {...props} />);
  });
}

function tab(id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-testid="rules-page-${id}"]`);
  if (!found) throw new Error(`no page tab: ${id}`);
  return found;
}

function testId(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function required(id: string): HTMLElement {
  const found = testId(id);
  if (!found) throw new Error(`not rendered: ${id}`);
  return found;
}

function buttonSaying(fragment: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((node) => (node.textContent ?? "").indexOf(fragment) !== -1) ?? null;
}

function click(node: Element | null) {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function selected(): string {
  const active = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]')).find((node) => node.getAttribute("aria-selected") === "true");
  return active?.getAttribute("data-testid")?.replace("rules-page-", "") ?? "none";
}

/** Every bullet the Current Action is showing. */
function actionBullets(): string[] {
  return Array.from(required("rules-current-action").querySelectorAll("li")).map((node) => node.textContent ?? "");
}

/** Every reminder Watch For is showing, text only. */
function watchTexts(): string[] {
  const watch = testId("rules-watch-for");
  if (!watch) return [];
  return Array.from(watch.querySelectorAll("li")).map((node) => (node.textContent ?? "").trim());
}

/** How many times a phrase appears anywhere in the rendered Overview. */
function occurrences(phrase: string): number {
  const text = container.textContent ?? "";
  let count = 0;
  let at = text.indexOf(phrase);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(phrase, at + phrase.length);
  }
  return count;
}


/* ------------------------------------------------------------------ */
/* Stubbed geometry, for the one thing jsdom has none of               */
/* ------------------------------------------------------------------ */

/** jsdom reports 0 for every box, so the action scroller's centring can only be exercised against stubs. A
 *  400px-wide row holding six 100px chips at 110px intervals; restored after each case that uses it. */
const LAYOUT_KEYS = ["clientWidth", "scrollWidth", "offsetWidth", "offsetLeft"] as const;

function fakeLayout() {
  const isRow = (node: HTMLElement) => node.getAttribute("data-testid") === "rules-action-flow";
  const stubs: Record<string, (this: HTMLElement) => number> = {
    clientWidth() {
      return isRow(this) ? 400 : 0;
    },
    scrollWidth() {
      return isRow(this) ? 1100 : 0;
    },
    offsetWidth() {
      return this.tagName === "BUTTON" ? 100 : 0;
    },
    offsetLeft() {
      if (this.tagName !== "BUTTON" || !this.parentElement) return 0;
      const chips = Array.from(this.parentElement.querySelectorAll("button"));
      return 110 * Math.max(0, chips.indexOf(this as HTMLButtonElement));
    },
  };
  LAYOUT_KEYS.forEach((key) => Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: stubs[key] }));
}

function restoreLayout() {
  LAYOUT_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(HTMLElement.prototype, key)) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });
}

/* ------------------------------------------------------------------ */

describe("the reference opens on Overview", () => {
  it("lands on Overview with no live round", () => {
    mount({});
    expect(selected()).toBe("overview");
  });

  it("lands on Overview while an Operating Round is live", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3, roundLabel: "OR 2.1" });
    expect(selected()).toBe("overview");
    /* The live round still ANNOUNCES itself -- it just does not take the wheel. */
    expect(tab("operating").querySelector('[title="The live round is on this page"]')).not.toBeNull();
    expect(testId("rules-open-current")).not.toBeNull();
  });

  it("lands on Overview while the auction is live", () => {
    mount({ roundType: "WaterfallAuction" });
    expect(selected()).toBe("overview");
  });
});

describe("a round change never moves the page", () => {
  it("leaves a reader on the page they chose", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1" });
    click(tab("tables"));
    expect(selected()).toBe("tables");
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3 });
    expect(selected()).toBe("tables");
    mount({ roundType: "StockRound", roundLabel: "SR2" });
    expect(selected()).toBe("tables");
  });

  it("leaves a reader on Overview when the round rolls over", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1" });
    expect(selected()).toBe("overview");
    mount({ roundType: "OperatingRound", operatingSubPhase: "Dividends", phase: PHASE_3 });
    expect(selected()).toBe("overview");
  });

  it("updates the live marker and the contextual strip as the round changes", () => {
    mount({ roundType: "StockRound", roundLabel: "SR2" });
    click(tab("tables"));
    expect(tab("stock").querySelector('[title="The live round is on this page"]')).not.toBeNull();
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", roundLabel: "OR 3.1", phase: PHASE_3 });
    expect(tab("stock").querySelector('[title="The live round is on this page"]')).toBeNull();
    expect(tab("operating").querySelector('[title="The live round is on this page"]')).not.toBeNull();
    expect(container.textContent).toContain("Operating Round 3.1");
  });
});

describe("existing current-page navigation is preserved", () => {
  it("still takes the player to the live round on request", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3, roundLabel: "OR 1.1" });
    const open = required("rules-open-current");
    /* Renamed for what it does: it opens that round's rules at the live step, rather than scrolling. */
    expect(open.textContent).toContain("Open current rules");
    click(open);
    expect(selected()).toBe("operating");
    /* And the offer withdraws once it has been taken. */
    expect(testId("rules-open-current")).toBeNull();
  });

  it("still switches pages by click and by arrow key", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1" });
    click(tab("stock"));
    expect(selected()).toBe("stock");
    act(() => {
      tab("stock").closest('[role="tablist"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(selected()).toBe("operating");
  });
});

describe("the auction page is named for what it holds", () => {
  it("labels the page strip Auction & Privates", () => {
    mount({});
    expect(tab("auction").textContent).toContain("Auction & Privates");
    expect(tab("auction").getAttribute("aria-label")).toBe("Auction & Privates");
  });

  it("generates cross-page link labels from the same name", () => {
    mount({});
    expect(required("rules-game-flow-open").textContent).toContain("Auction & Privates");
  });

  it("uses it on the auction's own lookup link", () => {
    mount({ roundType: "WaterfallAuction" });
    expect(required("rules-lookup-excerpt").textContent).toContain("Auction & Privates");
  });
});

describe("the Game Flow disclosure", () => {
  it("is collapsed whenever a round is live", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3 });
    expect(testId("rules-game-flow-open")).toBeNull();
    expect(required("rules-game-flow-toggle").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens itself when no round is live, because orientation is all there is", () => {
    mount({});
    expect(testId("rules-game-flow-open")).not.toBeNull();
    expect(required("rules-game-flow-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the whole progression with the loop as a glyph and no spelled-out repeat", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1" });
    const chain = required("rules-game-flow-chain").textContent ?? "";
    expect(chain).toContain("Auction");
    expect(chain).toContain("Stock Round");
    expect(chain).toContain("Operating Rounds");
    expect(chain).toContain("Game End");
    expect(chain).toContain("⇄");
    /* THE WORDS ARE GONE. Spelled out, the line wrapped and floated `REPEAT` between two unrelated rows. */
    expect(chain.toLowerCase()).not.toContain("repeat");
    /* The heading and the control share a row; the flow has its own. */
    expect(required("rules-game-flow-toggle").parentElement?.textContent).toContain("How the game progresses");
    expect(required("rules-game-flow-toggle").parentElement?.textContent).not.toContain("Stock Round");
  });

  it("carries a short spelling for narrow screens beside the full one", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1" });
    const chain = required("rules-game-flow-chain");
    expect(Array.from(chain.querySelectorAll(".rr-narrow")).map((n) => n.textContent)).toEqual(["Auction", "Stock", "Operating", "End"]);
  });

  it("marks the auction current, delayed or completed", () => {
    mount({ roundType: "WaterfallAuction" });
    expect(required("rules-game-flow-chain").textContent).toContain("Now");

    mount({ roundType: "StockRound", roundLabel: "SR1" });
    /* A standard game opens on the auction, so any other live round means it is done: ticked, not labelled. */
    expect(required("rules-game-flow-chain").querySelector('[aria-label="completed"]')).not.toBeNull();

    mount({ roundType: "StockRound", roundLabel: "SR1", variants: { delayedAuction: true } as RulesReferenceProps["variants"], auctionComplete: false });
    expect(required("rules-game-flow-chain").textContent).toContain("Delayed");
  });

  it("opens and closes on demand", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1" });
    click(required("rules-game-flow-toggle"));
    expect(testId("rules-game-flow-open")).not.toBeNull();
    /* Four columns, and no closing paragraph restating them. */
    expect(required("rules-game-flow-open").children).toHaveLength(4);
    click(required("rules-game-flow-toggle"));
    expect(testId("rules-game-flow-open")).toBeNull();
  });
});

describe("At a Glance is one data strip", () => {
  it("shows five scan targets and one link to the tables", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3, playerCount: 4 });
    const strip = required("rules-glance-strip");
    expect(strip.children).toHaveLength(5);
    const text = strip.textContent ?? "";
    expect(text).toContain("Current phase");
    expect(text).toContain("Operating rounds");
    expect(text).toContain("Private companies");
    expect(text).toContain("Certificate limit");
    expect(text).toContain("Tile colors");
    /* Presidency is a static rule, not a live condition; it lives in the Stock Round's reminders and Tables. */
    expect(text).not.toContain("Presidency");
    expect(text).toContain("Phase 3");
    expect(text).toContain("First 3-train");
    expect(text).toContain("16");
    /* ONE consolidated link, not one per cell. */
    expect(strip.querySelectorAll("button")).toHaveLength(0);
  });

  it("reads the Level Playing Field's own certificate table when that variant is on", () => {
    mount({ phase: PHASE_3, playerCount: 4, variants: { levelPlayingField: true } as RulesReferenceProps["variants"] });
    expect(required("rules-glance-strip").textContent).toContain("18");
  });

  it("lets Tile colors span the narrow grid rather than ending on a half row", () => {
    mount({ phase: PHASE_3, playerCount: 4 });
    const last = required("rules-glance-last");
    expect(last.textContent).toContain("Tile colors");
    expect(last.querySelector('[data-testid="rules-tile-colors"]')).not.toBeNull();
    expect(last.className).toContain("rr-glance-last");
    /* jsdom applies no media queries, so the rule itself is asserted against the stylesheet. */
    expect(SOURCE).toContain(".rr-glance-last { grid-column: 1 / -1; }");
  });

  it("ranks the five labels, with the phase brightest and neither grey on the disabled step", () => {
    mount({ phase: PHASE_3, playerCount: 4 });
    const labelInk = (index: number) =>
      required("rules-glance-strip").children[index].querySelector<HTMLElement>("span")?.style.color ?? "";
    const rgb = (hex: string) => {
      const n = hex.replace("#", "");
      return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`;
    };
    /* CURRENT PHASE is the primary orientation fact, so its label is the brightest in the strip -- and a
       NEUTRAL, not the Operating Round's magenta, not a tile-era hue, not live green. */
    expect(labelInk(0)).toBe(rgb("#c8c6c0"));
    /* The three round labels keep their hues, untouched by this pass. */
    expect(labelInk(1)).toBe(rgb("#e879b0"));
    expect(labelInk(2)).toBe(rgb("#c08ae8"));
    expect(labelInk(3)).toBe(rgb("#6fa3f7"));
    /* TILE COLORS stays neutral and stays below CURRENT PHASE, but off `INK_TEXT_FAINT` -- which the palette
       defines as the ink for DISABLED labels, and which is what both greys were wearing. */
    expect(labelInk(4)).toBe(rgb("#a8a6a0"));
    expect([labelInk(0), labelInk(4)]).not.toContain(rgb("#8a8a86"));
    /* The value still outranks its own label: the label is not the cell's primary ink. */
    const phaseCell = required("rules-glance-strip").children[0];
    expect(phaseCell.querySelectorAll("span")[1]?.getAttribute("style")).toContain("rgb(242, 240, 235)");
  });
});

describe("the Private Companies cell says what they are actually doing", () => {
  const status = (props: RulesReferenceProps) => {
    mount(props);
    return (required("rules-glance-strip").children[2].textContent ?? "").replace("Private companies", "");
  };

  it("reports a live auction as a live auction", () => {
    /* THE BUG THIS FIXES: "Not yet available — From Phase 3" printed over a round in which the players are
       buying the companies. True about corporations, useless to the player reading it. */
    expect(status({ roundType: "WaterfallAuction", playerCount: 4 })).toBe("Being auctionedPlayers purchase them now");
  });

  it("reports player ownership before Phase 3", () => {
    expect(status({ roundType: "StockRound", roundLabel: "SR1", phase: PHASE_2, playerCount: 4 })).toBe("Player-ownedCorporations may buy from Phase 3");
  });

  it("reports corporate purchase in Phases 3 and 4", () => {
    expect(status({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3, playerCount: 4 })).toBe(
      "Corporations may buyUntil the first 5-train",
    );
  });

  it("reports closure from Phase 5", () => {
    expect(status({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_6, playerCount: 4 })).toBe("ClosedWith the first 5-train");
  });

  it("reports a pending delayed auction", () => {
    expect(
      status({
        roundType: "OperatingRound",
        operatingSubPhase: "Track",
        phase: PHASE_3,
        playerCount: 4,
        variants: { delayedAuction: true } as RulesReferenceProps["variants"],
        auctionComplete: false,
      }),
    ).toBe("Not yet in playDelayed Auction pending");
  });

  it("reports a live delayed auction as a live auction too", () => {
    expect(
      status({
        roundType: "WaterfallAuction",
        playerCount: 4,
        variants: { delayedAuction: true } as RulesReferenceProps["variants"],
        auctionComplete: false,
      }),
    ).toBe("Being auctionedPlayers purchase them now");
  });

  it("says Phase 1 has no Operating Rounds rather than showing a dash", () => {
    mount({ roundType: "WaterfallAuction", playerCount: 4 });
    const operatingRounds = required("rules-glance-strip").children[1].textContent ?? "";
    expect(operatingRounds).toContain("None");
    expect(operatingRounds).toContain("The Auction precedes the first Stock Round");
  });
});

describe("the current round is the centre of the page", () => {
  it("shows the Operating Round sequence with the live step marked", () => {
    mount({
      roundType: "OperatingRound",
      operatingSubPhase: "Routes",
      roundLabel: "OR 2.1",
      activeCorporation: { ticker: "C&O" },
      phase: PHASE_3,
    });
    const round = required("rules-current-round");
    expect(round.textContent).toContain("Operating Round 2.1");
    expect(round.textContent).toContain("C&O");

    const flow = required("rules-action-flow");
    expect(flow.querySelectorAll("button")).toHaveLength(5);
    expect(flow.textContent).toContain("Lay Track");
    expect(flow.textContent).toContain("Buy Trains");

    const live = flow.querySelector('[aria-current="step"]');
    expect(live?.textContent).toContain("Run Routes");
    expect(live?.textContent).toContain("Current");

    const action = required("rules-current-action");
    expect(action.textContent).toContain("Run Routes");
    expect(action.textContent).toContain("Each train runs once on one legal route.");
    expect(actionBullets().length).toBeLessThanOrEqual(4);
    expect(action.textContent).toContain("Open full Run Routes rules");
  });

  it("keeps Buy Private Company outside the five-step sequence, and only when it is legal", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3 });
    const aside = required("rules-buy-private-aside");
    expect(aside.textContent).toContain("Also available during the turn · Phases 3 and 4, until the first 5-train");
    expect(aside.textContent).toContain("Buy Private Company");
    /* NOT IN THE SCROLLER. Inside it, it took width from the five numbered steps and arrived at the end of
       the scroll exactly where a sixth step would be. */
    expect(required("rules-action-flow").contains(aside)).toBe(false);
    expect(required("rules-action-flow").textContent).not.toContain("Buy Private Company");
    /* A SIBLING AFTER THE ROW, not necessarily the next one: the `First turn only` home-station note now sits
       between them, which is the same "beside the sequence, outside it" shelf and the Operating Round page's
       own order (flow, home station, side action). */
    expect(required("rules-action-flow").parentElement).toBe(aside.parentElement);
    expect(required("rules-action-flow").compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(required("rules-action-flow").querySelectorAll("button")).toHaveLength(5);

    /* The legality is unchanged: not before Phase 3 ... */
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_2 });
    expect(testId("rules-buy-private-aside")).toBeNull();
    /* ... and not once the companies have closed. */
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_6 });
    expect(testId("rules-buy-private-aside")).toBeNull();
    /* Nor while a delayed auction is still pending. */
    mount({
      roundType: "OperatingRound",
      operatingSubPhase: "Track",
      phase: PHASE_3,
      variants: { delayedAuction: true } as RulesReferenceProps["variants"],
      auctionComplete: false,
    });
    expect(testId("rules-buy-private-aside")).toBeNull();
  });

  it("does not tell the player the Priority Deal Card moves after every turn", () => {
    /* THE SHARED SENTENCE. Overview renders `STOCK_ROUND_OVERVIEW.quick`, so the Stock Round page's
       correction had to be made in the constant, not beside it. Rulebook 5.0: the holder takes the first
       turn and play proceeds clockwise; the card itself is assigned once, at the end of the round. */
    mount({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const round = required("rules-current-round").textContent ?? "";
    expect(round).toContain("The holder of the Priority Deal Card takes the first turn; play then proceeds clockwise.");
    expect(round).not.toContain("After each turn, the Priority Deal passes");
    expect(round).not.toContain("passes to the next player");
    /* And the end of the round names the direction the rulebook names: 5.0 gives the card to "the player to
       the left of the last player that bought or sold a certificate". */
    expect(round).toContain("The player to the left of the last player to buy or sell takes the Priority Deal Card");
    expect(round).not.toContain("The player after the last one to buy or sell");
  });

  it("shows the Stock Round turn with no wiring commentary", () => {
    mount({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const flow = required("rules-action-flow");
    expect(flow.textContent).toContain("Sell");
    expect(flow.textContent).toContain("Buy 1 certificate");
    expect(flow.querySelectorAll("button")).toHaveLength(3);
    expect(flow.querySelector('[aria-current="step"]')).toBeNull();
    /* NO IMPLEMENTATION TALK. The player does not need to be told what the interface was handed. */
    const round = required("rules-current-round").textContent ?? "";
    expect(round).not.toContain("The table reports");
    expect(round).not.toContain("not which part of the turn is open");
    expect(round).toContain("The Stock Round turn");
    expect(round).toContain("Open Stock Round rules");
  });

  it("marks both sell opportunities when a sale is reported, in the player's terms", () => {
    mount({ roundType: "StockRound", roundLabel: "SR2", stockRoundAction: "Sell", phase: PHASE_3 });
    const flow = required("rules-action-flow");
    expect(flow.querySelectorAll('[aria-current="step"]')).toHaveLength(2);
    const round = required("rules-current-round").textContent ?? "";
    expect(round).toContain("a turn may sell before buying and after buying");
    expect(round).not.toContain("reports");
  });

  it("presents the auction's three choices as choices, not a sequence", () => {
    mount({ roundType: "WaterfallAuction" });
    const flow = required("rules-action-flow");
    expect(flow.querySelectorAll("button")).toHaveLength(3);
    expect(flow.textContent).toContain("Pass");
    expect(flow.textContent).toContain("Buy lowest");
    expect(flow.textContent).toContain("Bid");
    expect(flow.textContent).not.toContain("→");
    expect(required("rules-current-round").textContent).toContain("On your turn, choose one.");
  });

  it("previews another action without disturbing the live one", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3 });
    const chips = Array.from(required("rules-action-flow").querySelectorAll("button"));
    click(chips.find((node) => (node.textContent ?? "").indexOf("Lay Track") !== -1) ?? null);

    const action = required("rules-current-action");
    expect(action.textContent).toContain("Preview");
    expect(action.textContent).toContain("Place 1 new tile OR upgrade 1 existing tile.");
    expect(action.textContent).toContain("Open full Lay Track rules");
    const live = required("rules-action-flow").querySelector('[aria-current="step"]');
    expect(live?.textContent).toContain("Run Routes");
    expect(required("rules-action-flow").querySelectorAll('[aria-current="step"]')).toHaveLength(1);

    click(buttonSaying("Back to the current action"));
    expect(required("rules-current-action").textContent).not.toContain("Preview");
  });

  it("names each detailed link for the section it opens", () => {
    const cases: [RulesReferenceProps["operatingSubPhase"], string][] = [
      ["Track", "Open full Lay Track rules"],
      ["Tokens", "Open full Station Tokens rules"],
      ["Routes", "Open full Run Routes rules"],
      ["Dividends", "Open full Dividends rules"],
      ["Hardware", "Open full Buy Trains rules"],
    ];
    cases.forEach(([subPhase, label]) => {
      mount({ roundType: "OperatingRound", operatingSubPhase: subPhase, phase: PHASE_3 });
      expect([subPhase, (required("rules-current-action").textContent ?? "").indexOf(label) !== -1]).toEqual([subPhase, true]);
    });
    /* And the section it names is addressable on the detailed page, so the link lands on it. */
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3 });
    click(buttonSaying("Open full Run Routes rules"));
    expect(selected()).toBe("operating");
    expect(container.querySelector("#rules-section-routes")).not.toBeNull();
  });
});

describe("no fact is rendered in two regions at once", () => {
  /* THE GENERAL RULE, checked on every cursor the fixtures can reach: a reminder never repeats a bullet the
     Current Action is showing on the same screen. */
  const STATES: [string, RulesReferenceProps][] = [
    ["auction", { roundType: "WaterfallAuction", playerCount: 4 }],
    ["stock round 1", { roundType: "StockRound", roundLabel: "SR1", phase: PHASE_3, playerCount: 4 }],
    ["stock round 2", { roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3, playerCount: 4 }],
    ["lay track", { roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3, playerCount: 4 }],
    ["station tokens", { roundType: "OperatingRound", operatingSubPhase: "Tokens", phase: PHASE_3, playerCount: 4 }],
    ["run routes", { roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3, playerCount: 4 }],
    ["dividends", { roundType: "OperatingRound", operatingSubPhase: "Dividends", phase: PHASE_3, playerCount: 4 }],
    ["buy trains", { roundType: "OperatingRound", operatingSubPhase: "Hardware", phase: PHASE_6, playerCount: 4 }],
    ["buy private", { roundType: "OperatingRound", operatingSubPhase: "BuyPrivate", phase: PHASE_3, playerCount: 4 }],
    ["operating round, no step", { roundType: "OperatingRound", phase: PHASE_3, playerCount: 4 }],
  ];

  it.each(STATES)("%s renders each reminder once", (_name, props) => {
    mount(props);
    const bullets = actionBullets();
    const repeated = watchTexts().filter((text) => bullets.some((bullet) => text.indexOf(bullet) !== -1 || bullet.indexOf(text) !== -1));
    expect(repeated).toEqual([]);
  });

  it("states the blocked-city restriction once, while running routes", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3 });
    expect(occurrences("A route cannot pass through a fully blocked large city or a red off-board area.")).toBe(1);
    /* It is Watch For's, and the Current Action keeps the definition, the range and the continuity. */
    expect(watchTexts().join(" ")).toContain("fully blocked large city");
    expect(actionBullets().join(" ")).not.toContain("fully blocked");
    expect(actionBullets().join(" ")).toContain("at least 2 cities");
  });

  it("does not print the train-limit schedule above the table that lists it", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Hardware", phase: PHASE_6 });
    expect(actionBullets().join(" ")).not.toContain("Train limit:");
    expect(required("rules-lookup-excerpt").textContent).toContain("Train limit");
    /* The forced purchase is a reminder, and only a reminder. */
    expect(actionBullets().join(" ")).not.toContain("cheapest");
    expect(watchTexts().join(" ")).toContain("cheapest train available");
    expect(actionBullets().join(" ")).toContain("Bank Pool");
  });

  it("keeps the station cost table out of the token bullets", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Tokens", phase: PHASE_3 });
    expect(actionBullets().join(" ")).not.toContain("First additional station: $40");
    expect(required("rules-lookup-excerpt").textContent).toContain("$40");
  });

  it("says the auction's bid-money rule and Priority Deal behaviour once each", () => {
    mount({ roundType: "WaterfallAuction" });
    expect(occurrences("Bid money is set aside until the bid is resolved.")).toBe(1);
    expect(actionBullets()).toEqual([]);
    /* The Buy chip's own caption is not repeated as a reminder. */
    expect(watchTexts().join(" ")).not.toContain("purchase the unsold Private Company with the lowest face value at its current price");
    expect(watchTexts().join(" ")).toContain("does not change hands");
  });
});

describe("Watch For is contextual, bounded and true where it is shown", () => {
  const KEYS: RulesWatchKey[] = [
    "auction",
    "stock",
    "or",
    "or:BuyPrivate",
    "or:Track",
    "or:Tokens",
    "or:Routes",
    "or:Dividends",
    "or:Hardware",
  ];

  it.each(KEYS)("%s resolves its reminders out of the verified content", (key) => {
    const items = watchItemsFor(key, { firstStockRound: true });
    /* Every spec is a PREFIX lookup into `GOTCHAS`, a card's `quick`, a detail paragraph or list item, or
       `BANKRUPTCY_WARNING`. Reword one of those and its spec silently stops resolving -- here, loudly. */
    expect([key, items.length > 0 && items.length <= 3]).toEqual([key, true]);
    items.forEach((item) => {
      expect([key, item.label.length > 0]).toEqual([key, true]);
      expect([key, item.text.length > 20]).toEqual([key, true]);
    });
  });

  it("has nothing to say when no round is live", () => {
    expect(watchItemsFor("none", { firstStockRound: null })).toEqual([]);
  });

  it("shows no more than three, and never an auction reminder in an Operating Round", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Hardware", phase: PHASE_6 });
    const watch = required("rules-watch-for");
    expect(watch.querySelectorAll("li")).toHaveLength(3);
    expect(watch.textContent).not.toContain("buy-bid-turns");
    expect(watch.textContent).not.toContain("lowest-priced Private Company");
    expect(watch.textContent).toContain("Forced purchase");
  });

  it("changes with the action inside one round", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3 });
    expect(required("rules-watch-for").textContent).toContain("Privates on the map");
    mount({ roundType: "OperatingRound", operatingSubPhase: "Dividends", phase: PHASE_3 });
    expect(required("rules-watch-for").textContent).toContain("Treasury");
    expect(required("rules-watch-for").textContent).not.toContain("Privates on the map");
  });

  it("spends the orange mark on the consequential ones only", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1" });
    expect(required("rules-watch-for").querySelectorAll('[aria-label="warning"]')).toHaveLength(0);
    mount({ roundType: "OperatingRound", operatingSubPhase: "Hardware", phase: PHASE_3 });
    expect(required("rules-watch-for").querySelectorAll('[aria-label="warning"]')).toHaveLength(2);
  });
});

describe("the first-Stock-Round sale ban is shown only in the first Stock Round", () => {
  const BAN = "No certificates may be sold in the first Stock Round.";

  it("appears in Stock Round 1", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1", phase: PHASE_3 });
    expect(required("rules-watch-for").textContent).toContain(BAN);
    expect(required("rules-watch-for").textContent).toContain("First round");
  });

  it("is gone by Stock Round 2", () => {
    mount({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    expect(required("rules-watch-for").textContent).not.toContain(BAN);
    expect(required("rules-watch-for").querySelectorAll("li")).toHaveLength(2);
  });

  it("stays gone in a late Stock Round", () => {
    mount({ roundType: "StockRound", roundLabel: "SR7", phase: PHASE_6 });
    expect(required("rules-watch-for").textContent).not.toContain(BAN);
  });

  it("is omitted rather than guessed at when the round tag cannot be read", () => {
    mount({ roundType: "StockRound", roundLabel: null, phase: PHASE_3 });
    expect(required("rules-watch-for").textContent).not.toContain(BAN);
    mount({ roundType: "StockRound", roundLabel: "Stock Round", phase: PHASE_3 });
    expect(required("rules-watch-for").textContent).not.toContain(BAN);
  });

  it("is never in an Operating Round", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3 });
    expect(required("rules-watch-for").textContent).not.toContain(BAN);
  });
});

describe("with no live round the page gives orientation instead of reminders", () => {
  it("omits Watch For rather than listing three arbitrary rules", () => {
    mount({ playerCount: 4 });
    expect(testId("rules-watch-for")).toBeNull();
    expect(container.textContent).not.toContain("Watch for");
  });

  it("uses the width for the reference summary and puts Game End straight after", () => {
    mount({ playerCount: 4 });
    /* No two-column grid means no empty right-hand column. */
    expect(container.querySelector(".rr-round-grid")).toBeNull();
    const round = required("rules-current-round");
    expect(round.textContent).toContain("No live round");
    expect(round.textContent).toContain("Auction & Privates");
    expect(round.textContent).toContain("Tables");
    expect(round.nextElementSibling?.getAttribute("aria-label")).toBe("Game end");
  });

  it("keeps the neutral contextual treatment", () => {
    mount({ playerCount: 4 });
    expect(container.textContent).toContain("No live round — showing the full reference.");
    expect(testId("rules-open-current")).toBeNull();
  });
});

describe("one compact lookup, chosen for the action", () => {
  it("shows train ranges while running routes", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3 });
    const lookup = required("rules-lookup-excerpt");
    expect(lookup.textContent).toContain("Train range");
    expect(lookup.textContent).toContain("Diesel");
    expect(lookup.querySelectorAll("tbody tr").length).toBeLessThanOrEqual(8);
  });

  it("shows station costs while placing tokens", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Tokens", phase: PHASE_3 });
    expect(required("rules-lookup-excerpt").textContent).toContain("Station costs");
  });

  it("omits it where no small existing lookup helps", () => {
    mount({ roundType: "OperatingRound", phase: PHASE_3 });
    expect(testId("rules-lookup-excerpt")).toBeNull();
    mount({});
    expect(testId("rules-lookup-excerpt")).toBeNull();
  });

  it("resolves a small table from the existing data for every cursor that has one", () => {
    const keys: RulesWatchKey[] = ["auction", "stock", "or:Track", "or:Tokens", "or:Routes", "or:Dividends", "or:Hardware", "or:BuyPrivate"];
    keys.forEach((key) => {
      const excerpt = lookupFor(key, () => true);
      expect([key, excerpt !== null]).toEqual([key, true]);
      expect([key, (excerpt?.table.rows ?? []).length > 0]).toEqual([key, true]);
      expect([key, (excerpt?.table.rows ?? []).length <= 8]).toEqual([key, true]);
    });
    expect(lookupFor("or", () => true)).toBeNull();
    expect(lookupFor("none", () => true)).toBeNull();
  });
});

describe("the narrow layout is one row of navigation, not three", () => {
  it("gives every tab a short spelling and keeps its full accessible name", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1" });
    expect(tab("stock").querySelector(".rr-narrow")?.textContent).toBe("Stock");
    expect(tab("operating").querySelector(".rr-narrow")?.textContent).toBe("Operating");
    expect(tab("auction").querySelector(".rr-narrow")?.textContent).toBe("Privates");
    expect(tab("auction").getAttribute("aria-label")).toBe("Auction & Privates");
    expect(tab("stock").getAttribute("aria-selected")).toBe("false");
    expect(tab("overview").getAttribute("aria-selected")).toBe("true");
  });

  it("scrolls the strip rather than wrapping it", () => {
    mount({});
    expect(container.querySelector(".rr-nav-strip")).not.toBeNull();
    /* The wrap MUST live in the stylesheet: an inline `flexWrap` would win over the media query and put the
       strip back on three rows at phone width without anything failing. */
    expect(SOURCE).toContain(".rr-nav-strip { flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; }");
    expect(SOURCE).not.toContain('navStrip: {\n    position: "sticky",\n    zIndex: 5,\n    display: "flex",\n    flexWrap: "wrap"');
  });

  it("keeps the five operating steps on one scrolling sequence", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3 });
    expect(required("rules-action-flow").className).toContain("rr-action-row");
    expect(SOURCE).toContain(".rr-action-row { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 6px; }");
  });

  it("tightens the shell rather than leaving a thickly padded card", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1" });
    expect(container.querySelector(".rr-context")).not.toBeNull();
    expect(container.querySelector(".rr-root")).not.toBeNull();
    expect(SOURCE).toContain(".rr-context { padding: 6px 10px; margin-bottom: 10px; gap: 2px 8px; min-height: 0; }");
    expect(SOURCE).toContain(".rr-root { margin: 0 8px 12px; padding: 0 14px 24px; }");
  });
});

describe("Game End is compact and unnumbered", () => {
  it("states the two triggers and the winner without ordering them", () => {
    mount({});
    const end = required("rules-game-end");
    expect(end.textContent).toContain("Bank break");
    expect(end.textContent).toContain("Bankruptcy");
    expect(end.textContent).toContain("Winner");
    expect(end.querySelector("ol")).toBeNull();
    expect(end.textContent).not.toContain("1.");
    expect(buttonSaying("Exact timing and valuation")).not.toBeNull();
  });
});

describe("Tile colors replaces Presidency in the strip", () => {
  /** The colours the key is showing, in order. THE NAMES ARE ACCESSIBLE NAMES NOW, not visible text: the
   *  hexes are drawn at 25px and carry `aria-label` / `title` instead of a caption. */
  function tileNames(): string[] {
    const key = testId("rules-tile-colors");
    if (!key) return [];
    return Array.from(key.children).map((node) => (node.getAttribute("aria-label") ?? "").replace(/ tiles$/, ""));
  }
  /** The cell's muted line and, where there are no colours, its strong value. */
  function tileCell(): string {
    return (required("rules-glance-last").textContent ?? "").replace("Tile colors", "");
  }

  it("shows no tile colours during the Private Company Auction", () => {
    mount({ roundType: "WaterfallAuction", playerCount: 4 });
    expect(tileNames()).toEqual([]);
    expect(tileCell()).toBe("NoneNo track-laying phase yet");
  });

  it("shows yellow only in Phase 2", () => {
    mount({ roundType: "StockRound", roundLabel: "SR1", phase: PHASE_2, playerCount: 4 });
    expect(tileNames()).toEqual(["Yellow"]);
    expect(tileCell()).toContain("Available this phase");
  });

  it("shows yellow and green in Phases 3 and 4", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3, playerCount: 4 });
    expect(tileNames()).toEqual(["Yellow", "Green"]);
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: { label: "Phase 4", tier: "4", trainLimit: 3 }, playerCount: 4 });
    expect(tileNames()).toEqual(["Yellow", "Green"]);
  });

  it("shows yellow, green and brown from Phase 5", () => {
    (["5", "6", "D"] as const).forEach((tier) => {
      mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: { label: `Phase ${tier}`, tier, trainLimit: 2 }, playerCount: 4 });
      expect([tier, tileNames()]).toEqual([tier, ["Yellow", "Green", "Brown"]]);
    });
  });

  it("claims no current colour when no phase is live", () => {
    mount({ playerCount: 4 });
    expect(tileNames()).toEqual([]);
    expect(tileCell()).toBe("Set by phaseSee Trains & Phases");
  });

  it("names every colour it draws, so the meaning is never colour alone", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: { label: "Phase 6", tier: "6", trainLimit: 2 }, playerCount: 4 });
    const key = required("rules-tile-colors");
    /* One hex per colour, and NO VISIBLE CAPTION -- so the accessible name is the whole of the non-colour
       channel and has to be there. `EraHex` draws `role="presentation"`, so the wrapper is the one image. */
    expect(key.querySelectorAll("svg")).toHaveLength(3);
    expect(key.textContent).toBe("");
    expect(tileNames()).toEqual(["Yellow", "Green", "Brown"]);
    Array.from(key.children).forEach((node) => {
      expect(node.getAttribute("role")).toBe("img");
      /* The same words on hover as in the accessibility tree. */
      expect(node.getAttribute("title")).toBe(node.getAttribute("aria-label"));
    });
    key.querySelectorAll("svg").forEach((svg) => expect(svg.getAttribute("role")).toBe("presentation"));
  });

  it("draws them large enough to read as tiles, and never shrinks them to fit", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: { label: "Phase 6", tier: "6", trainLimit: 2 }, playerCount: 4 });
    required("rules-tile-colors")
      .querySelectorAll("svg")
      .forEach((svg) => {
        expect(Number(svg.getAttribute("width"))).toBeGreaterThanOrEqual(24);
        expect(Number(svg.getAttribute("width"))).toBeLessThanOrEqual(26);
      });
    /* A four-colour late game wraps to a second line rather than squeezing four hexes into one. */
    expect(STRIPPED).toContain('tileKeyItem: { display: "inline-flex", alignItems: "center", flex: "0 0 auto" }');
    expect(STRIPPED).toContain('tileKey: { display: "flex", alignItems: "center", flexWrap: "wrap"');
  });

  it("adds the 18XX+ set's fourth colour, in the canonical order", () => {
    mount({
      roundType: "OperatingRound",
      operatingSubPhase: "Track",
      phase: { label: "Phase D", tier: "D", trainLimit: 2 },
      playerCount: 4,
      variants: { plusTiles: true } as RulesReferenceProps["variants"],
    });
    expect(tileNames()).toEqual(["Yellow", "Green", "Brown", "Gray"]);
    expect(required("rules-tile-colors").textContent).toBe("");
  });

  it("reads the depot's own schedule rather than a second one", () => {
    /* THE DRIFT GUARD. `tileErasAt` is what the Bank Train Depot asks; `PHASE_ROWS` is this page's own
       Trains & Phases table. If a future edit moves one, this names the phase where they parted. */
    const rows: [string, string][] = [
      ["2", "Yellow"],
      ["3", "Yellow, green"],
      ["4", "Yellow, green"],
      ["5", "Yellow, green, brown"],
      ["6", "Yellow, green, brown"],
      ["D", "Yellow, green, brown"],
    ];
    rows.forEach(([tier, printed]) => {
      mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: { label: tier, tier, trainLimit: 2 }, playerCount: 4 });
      expect([tier, tileNames().join(", ").toLowerCase()]).toEqual([tier, printed.toLowerCase()]);
    });
  });

  it("leaves the Tables page nothing of its own to drift from", () => {
    /* WAS a per-tier check that the Tables page printed the same literal string (`tiles: "Yellow, green"`).
       The Tables redesign deleted that column's data and derives it from the same `tileErasAt` call this cell
       makes, so the two agree BY CONSTRUCTION and there is no second schedule left to compare against --
       which is what this guard wanted in the first place. */
    expect(STRIPPED.indexOf('tiles: "')).toBe(-1);
    expect(STRIPPED.indexOf("tileErasAt(row.tier as TrainTier, plusTiles)")).toBeGreaterThan(-1);
  });
});

describe("the operating action flow is a scroller its chips cannot collapse", () => {
  it("keeps five chips that never shrink", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3 });
    const flow = required("rules-action-flow");
    expect(flow.querySelectorAll("button")).toHaveLength(5);
    expect(flow.className).toContain("rr-action-row");
    /* THE DEFECT THIS PINS was reproducible, not a stale render: `flex-wrap: nowrap` plus the default
       `flex-shrink: 1` and a `minWidth: 0` floor let the chips compress below their own `nowrap` labels, so
       each label printed over the next chip. Both halves are asserted. */
    const chipStyle = STRIPPED.slice(STRIPPED.indexOf("  actionChip: {"), STRIPPED.indexOf("  actionChipLive:"));
    expect(chipStyle).toContain('flex: "0 0 auto"');
    expect(chipStyle).not.toContain("minWidth: 0");
    expect(SOURCE).toContain('actionArrow: { flex: "0 0 auto"');
    expect(SOURCE).toContain(".rr-action-row { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 6px; }");
  });

  it("scrolls inside itself rather than widening the page", () => {
    /* The row is the scroller. Every ancestor between it and the viewport carries `min-width: 0`, which is
       what keeps a 1100px sequence from widening the whole reference. */
    expect(SOURCE).toContain("overviewPage: { display: \"flex\", flexDirection: \"column\", gap: \"22px\", minWidth: 0 }");
    expect(SOURCE).toContain(".rr-round-grid { display: grid; grid-template-columns: minmax(0, 1fr);");
  });

  it("brings the current step into view on arrival and on every sub-phase change", () => {
    /* jsdom reports zero for every layout box, so the geometry is stubbed: a 400px row holding 1100px of
       chips, each 100px wide at 110px intervals. The assertion is the CENTRING ARITHMETIC and the fact that
       it runs again when the sub-phase moves -- the two things a player notices. */
    fakeLayout();
    try {
      mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3 });
      const row = required("rules-action-flow");
      /* Run Routes is the third chip: 220 - (400 - 100) / 2. */
      expect(row.scrollLeft).toBe(70);

      mount({ roundType: "OperatingRound", operatingSubPhase: "Hardware", phase: PHASE_3 });
      /* Buy Trains is the fifth: 440 - 150. */
      expect(required("rules-action-flow").scrollLeft).toBe(290);

      mount({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3 });
      /* Lay Track is the first, and the row goes back to its start rather than staying where it was. */
      expect(required("rules-action-flow").scrollLeft).toBe(0);
    } finally {
      restoreLayout();
    }
  });

  it("does it before the paint, not after it", () => {
    /* On `useEffect` the first frame drew the row at offset zero with the current step off the right edge. */
    expect(SOURCE).toContain("useLayoutEffect(() => {\n    const row = flowRowRef.current;");
  });

  it("says the row scrolls, and only while it actually does", () => {
    /* MEASURED AT 430 IN A REAL BROWSER: 895px of chips in 384px, no scrollbar gutter and no fade, with the
       centred live step leaving a 36px sliver of STATION TOKENS at the left edge reading as the word "NS". */
    fakeLayout();
    try {
      mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3 });
      const cue = required("rules-flow-scroll-cue");
      expect(cue.textContent).toBe("Scroll sideways for the other steps \u2192");
      /* Not instead of the row: five chips, the live one still marked. */
      expect(required("rules-action-flow").querySelectorAll("button")).toHaveLength(5);
      expect(required("rules-action-flow").textContent).toContain("Current");
      /* It is a line of text, like the table cue -- not a panel and not a second flow. */
      expect(cue.tagName).toBe("SPAN");
      expect(cue.querySelectorAll("*")).toHaveLength(0);
      /* The chips are a choice, not a sequence, in an auction. */
      mount({ roundType: "WaterfallAuction", playerCount: 4 });
      expect(testId("rules-flow-scroll-cue")?.textContent).toBe("Scroll sideways for the other choices \u2192");
    } finally {
      restoreLayout();
    }
  });

  it("stays quiet when the row fits", () => {
    /* No stub: jsdom reports every box as zero, so nothing overflows -- which is the desktop case, where
       `.rr-action-row` wraps instead of scrolling. No media query decides this; the measurement does. */
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3 });
    expect(testId("rules-flow-scroll-cue")).toBeNull();
  });

  it("measures both scrolling regions with one hook", () => {
    /* The table cue's own note argues the case -- a line of text, not a gradient, not a scrollbar a trackpad
       hides -- and this row was the only horizontally scrolling region in the reference not using it. */
    expect(SOURCE).toContain("function useScrollsSideways(");
    expect(SOURCE).toContain("const scrolls = useScrollsSideways(ref);");
    expect(SOURCE).toContain("const flowScrolls = useScrollsSideways(flowRowRef,");
  });
});

describe("Buy Private Company is bounded by the window that closes it", () => {
  const aside = () => testId("rules-buy-private-aside")?.textContent?.replace(/\s+/g, " ") ?? null;

  it("gives the phases 3-4 window rather than an open-ended Phase 3+", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3, playerCount: 4 });
    /* 3.0 "during phases 3 and 4" and 3.2's closure at the first 5-train -- the window the Operating Round
       and Auction pages both give. "Phase 3+" read as "from now on". */
    expect(aside()).toContain("Also available during the turn \u00b7 Phases 3 and 4, until the first 5-train");
    expect(aside()).toContain("Buy Private Company");
    /* Nowhere on the Overview, not just in this line. */
    expect(container.textContent).not.toContain("Phase 3+");
  });

  it("still disappears once the Private Companies have closed", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3, playerCount: 4 });
    expect(aside()).not.toBeNull();
    /* Phase-aware rendering is unchanged: `buyPrivateShown` reads the same legality as the strip. */
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_6, playerCount: 4 });
    expect(aside()).toBeNull();
    expect(required("rules-glance-strip").children[2].textContent).toContain("Closed");
  });
});

describe("the Station Tokens preview says what the Operating Round page says", () => {
  const preview = () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3, playerCount: 4 });
    /* NOT THE DEFAULT STATE: the page opens on the live step (Run Routes). This is the panel a player sees
       after selecting step 2, which is the copy the static export could not show. */
    click(required("rules-action-flow").querySelectorAll("button")[1]);
    const panel = required("rules-current-action");
    return { lead: panel.querySelector("p")?.textContent ?? "", bullets: Array.from(panel.querySelectorAll("li")).map((n) => n.textContent ?? "") };
  };

  it("leads with the optional additional station, not with an allowance that counts both", () => {
    expect(preview().lead).toBe("Optional: place one additional station token during the Operating Turn.");
  });

  it("is about additional stations only", () => {
    const { bullets } = preview();
    /* The home station is neither optional nor paid for nor during this step, so it is not in this list at
       all -- it is the labelled note beside the turn flow. `cede` is the mechanism, as it is for the two
       other bullets the cost table and the reminders already own. */
    expect(bullets.join(" ")).not.toContain("home-station token");
    expect(bullets.join(" ")).not.toContain("must be placed on your first Operating Turn");
    expect(bullets.join(" ")).not.toContain("Home station: free");
    bullets.forEach((bullet) => expect(bullet).not.toContain("first operating turn"));
    expect(bullets.length).toBeGreaterThan(0);
  });

  it("states the home station beside the turn flow instead, labelled and outside the sequence", () => {
    mount({ roundType: "OperatingRound", operatingSubPhase: "Routes", phase: PHASE_3, playerCount: 4 });
    const note = required("rules-overview-home-station");
    /* 6.1 and 6.3.1: mandatory, free, and before step 1 -- so it is adjacent to the sequence, not in it. */
    expect(note.textContent).toContain("First turn only");
    expect(note.textContent).toContain(
      "At the start of its first operating turn, the corporation places its home-station token for free \u2014 before Lay Track.",
    );
    /* Outside the five-step row, and after it. */
    expect(required("rules-action-flow").contains(note)).toBe(false);
    expect(required("rules-action-flow").compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    /* The same label the Operating Round page gives the same note. */
    const tag = note.querySelector("span");
    expect(tag?.textContent).toBe("First turn only");
    expect(tag?.style.borderStyle === "dashed" || (tag?.getAttribute("style") ?? "").indexOf("dashed") >= 0).toBe(true);
    /* Not a stray reminder on a Stock Round or an auction turn. */
    mount({ roundType: "StockRound", roundLabel: "SR2", playerCount: 4, phase: PHASE_3 });
    expect(testId("rules-overview-home-station")).toBeNull();
  });

  it("keeps one copy of each sentence, shared with the Operating Round page", () => {
    expect(SOURCE).toContain('text: operatingQuick("station", "At the start of its first operating turn")');
    expect(SOURCE).toContain('const ADDITIONAL_STATION_LEAD = operatingStep("station")?.lead');
  });
});
