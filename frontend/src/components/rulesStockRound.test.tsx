/** @jest-environment jsdom */
//
// ==================================================================
//  RULES REFERENCE (harness): THE STOCK ROUND PAGE HAS A SHAPE NOW
// ==================================================================
//
// The page was seven equally weighted sections behind seven disclosures under one `Expand all`, and the same
// rule was stated in three places. The redesign gives it an order that answers the five questions a player
// arrives with, and gives every rule ONE home. Both of those are claims about the rendered page:
//   1. the sections appear in order, and every jump link points at one that exists;
//   2. the turn is a SHAPE, not three controls -- nothing in it is clickable, because the app cannot tell
//      which of the two sells a player is taking and must not imply that it can;
//   3. the bulk toggle is gone from THIS page and still present on the pages that still have accordions;
//   4. the principal Priority Deal sentence and the brown-zone purchase rule are each rendered ONCE;
//   5. every wide table sits in its own scroll region, so none of them widens the page;
//   6. no implementation-facing sentence about missing display state survives anywhere on it.
//
// And one source-scan, for the thing a render cannot check: the three market-zone swatches are copied from
// `StockMarketRenderer.tsx`'s `ZONE_TEXT_COLORS` rather than imported (that module is the whole chart), so
// this suite is what stops the copy from drifting.

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
const MARKET_SOURCE = fs.readFileSync(path.join(__dirname, "StockMarketRenderer.tsx"), "utf8");
const { stripComments } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");
const STRIPPED = stripComments(SOURCE);

let container: HTMLDivElement;
let root: Root;

const PHASE_3: RulesReferenceProps["phase"] = { label: "Phase 3", tier: "3", trainLimit: 4 };

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

/** Render and open the Stock Round page. */
function stockPage(props: RulesReferenceProps = {}): HTMLElement {
  render(props);
  click(container.querySelector('[data-testid="rules-page-stock"]'));
  const page = container.querySelector<HTMLElement>('[data-testid="rules-stock-turn"]')?.closest("div[style]")?.parentElement;
  if (!page) throw new Error("the Stock Round page did not render");
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

/** How many times a sentence appears anywhere in the rendered page. */
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
/* Stubbed geometry, for the overflow cue                              */
/* ------------------------------------------------------------------ */

/** jsdom reports 0 for every box, so a container never "overflows" there. These stubs make the two lookup
 *  regions 384px wide around 620px of table — the 430px case — and are removed again after each use. */
const BOX_KEYS = ["scrollWidth", "clientWidth"] as const;

function fakeNarrowTables() {
  const isScroller = (node: HTMLElement) => node.style.overflowX === "auto";
  const stubs: Record<string, (this: HTMLElement) => number> = {
    scrollWidth() {
      return isScroller(this) ? 620 : 0;
    },
    clientWidth() {
      return isScroller(this) ? 384 : 0;
    },
  };
  BOX_KEYS.forEach((key) => Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: stubs[key] }));
}

function restoreBoxes() {
  BOX_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(HTMLElement.prototype, key)) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });
}

/* ------------------------------------------------------------------ */

describe("the page is ordered by the questions a player arrives with", () => {
  const ORDER = ["rules-section-sell", "rules-section-buy", "rules-section-float", "rules-section-ownership", "rules-section-market"];

  it("renders Round Flow, the jump row and the five sections in order", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    expect(testId("rules-stock-turn")).not.toBeNull();
    expect(testId("rules-stock-cadence")).not.toBeNull();
    expect(testId("rules-stock-jump")).not.toBeNull();

    const seen = ORDER.map((id) => {
      const node = document.getElementById(id);
      return node ? { id, at: Array.prototype.indexOf.call(container.querySelectorAll("[id]"), node) } : null;
    });
    expect(seen.every((entry) => entry !== null)).toBe(true);
    const positions = seen.map((entry) => entry?.at ?? -1);
    /* Strictly increasing: Sell, Buy, Start & Float, Ownership & Limits, Market Effects. */
    positions.forEach((at, index) => {
      if (index > 0) expect([ORDER[index], at > positions[index - 1]]).toEqual([ORDER[index], true]);
    });
  });

  it("gives every jump link a section that exists", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const jump = required("rules-stock-jump");
    const labels = Array.from(jump.querySelectorAll("button")).map((node) => node.textContent ?? "");
    expect(labels).toEqual(["Sell", "Buy", "Start & Float", "Ownership & Limits", "Market Effects"]);
    /* The anchors the row names, and the two Overview links into this page, all resolve. */
    ORDER.forEach((id) => expect([id, document.getElementById(id) !== null]).toEqual([id, true]));
    expect(document.getElementById("rules-section-movement")).not.toBeNull();
  });

  it("keeps the anchors clear of the sticky page strip", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    ORDER.forEach((id) => {
      const node = document.getElementById(id);
      expect([id, (node as HTMLElement).style.scrollMarginTop]).toEqual([id, "170px"]);
    });
  });
});

describe("the turn is a shape, not three controls", () => {
  it("draws Sell → Buy 1 certificate → Sell with nothing clickable in it", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const turn = required("rules-stock-turn");
    expect(turn.textContent).toContain("Sell");
    expect(turn.textContent).toContain("Buy 1 certificate");
    expect((turn.textContent ?? "").indexOf("Sell")).not.toBe((turn.textContent ?? "").lastIndexOf("Sell"));
    expect(turn.textContent).toContain("→");
    /* NOT BUTTONS, and no `aria-current`: the app cannot tell which of the two sells is being taken. */
    expect(turn.querySelectorAll("button")).toHaveLength(0);
    expect(turn.querySelectorAll("[aria-current]")).toHaveLength(0);
    expect(turn.querySelectorAll("[aria-pressed]")).toHaveLength(0);
  });

  it("states who starts, how it continues and how it ends, once each", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const cadence = required("rules-stock-cadence");
    expect(cadence.children).toHaveLength(3);
    const text = cadence.textContent ?? "";
    expect(text).toContain("Starts");
    expect(text).toContain("Continues");
    expect(text).toContain("Ends");
    /* Rulebook 5.0: the card's holder goes first, then the TURN moves clockwise. */
    expect(text).toContain("The holder of the Priority Deal Card.");
    expect(text).toContain("Clockwise, one turn each.");
    /* THE CARD IS NOT A BATON. It is assigned once, at the end, and the page must not say otherwise. */
    expect(text).not.toContain("Priority Deal passes");
    expect(text).not.toContain("after each turn the Priority Deal");
    expect(text).toContain("The Priority Deal Card then goes to the player to the left of the last one who bought or sold");
    expect(text).toContain("it does not change hands");
  });

  it("leads with one sentence rather than narrating the diagram beneath it", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const flow = required("rules-stock-turn").parentElement as HTMLElement;
    expect(flow.textContent).toContain("Players buy and sell stock in the public railroad corporations.");
    /* The turn's shape and the round-end condition are drawn below; the lead no longer says them too. */
    expect(flow.textContent).not.toContain("Each turn is Sell → Buy → Sell");
    expect(flow.textContent).not.toContain("until every player has passed consecutively.");
  });

  it("says selling is closed only while the first Stock Round is live, without disabling a stage", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR1", phase: PHASE_3 });
    expect(required("rules-stock-first-round").textContent).toContain("no certificates may be sold this round");
    /* Both sells stay in the general reference; neither is drawn as a disabled control. */
    const turn = required("rules-stock-turn");
    expect((turn.textContent ?? "").split("Sell").length - 1).toBe(2);
    expect(turn.querySelectorAll("button")).toHaveLength(0);

    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    expect(testId("rules-stock-first-round")).toBeNull();
    stockPage({});
    expect(testId("rules-stock-first-round")).toBeNull();
  });
});

describe("one rule, one home", () => {
  it("states the round-end Priority Deal rule exactly once", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    expect(occurrences("The Priority Deal Card then goes to the player to the left of the last one who bought or sold")).toBe(1);
    /* And in none of the five sections below it: the Priority Deal belongs to the cadence row alone. */
    ["rules-section-sell", "rules-section-buy", "rules-section-float", "rules-section-ownership", "rules-section-market"].forEach((id) => {
      const section = document.getElementById(id);
      expect([id, (section?.textContent ?? "").indexOf("Priority Deal")]).toEqual([id, -1]);
    });
  });

  it("states the brown box accurately in Buy and in full only in the zone table", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    /* The table's own sentence stays the single full statement. */
    expect(occurrences("On your Stock Round turn you may buy any number of its Bank Pool certificates at once")).toBe(1);
    expect(required("rules-stock-zones").textContent).toContain("still counts as your one purchase for the turn");

    /* Rulebook 4.4 in Buy, as a pointer that cannot be read as a second purchase. "Relaxes the
       one-certificate rule" -- the line this replaces -- could be. */
    const buy = document.getElementById("rules-section-buy");
    expect(buy?.textContent).toContain("Brown box: that one purchase may take any number of that corporation’s Bank Pool certificates");
    expect(buy?.textContent).toContain("still a single purchase, not an extra one");
    expect(buy?.textContent).not.toContain("relaxes the one-certificate rule");
    expect(buy?.textContent).toContain("Market Effects");
  });

  it("does not claim every coloured box relaxes both limits", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const ownership = document.getElementById("rules-section-ownership");
    /* Rulebook 4.4: three zones exempt the overall limit, two of them lift the individual one. */
    expect(ownership?.textContent).toContain("Yellow, orange and brown boxes exempt");
    expect(ownership?.textContent).toContain("orange and brown also allow holding more than the individual corporation limit");
    expect(ownership?.textContent).not.toContain("relaxes the first two");
    expect(ownership?.textContent).toContain("Market Effects");
  });

  it("obtains the President's Certificate rather than always buying it", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const sequence = required("rules-stock-float-sequence").textContent ?? "";
    /* Rulebook 3.0 hands the BO private's owner the B&O presidency without payment; 5.2 still makes them
       set the par value. */
    expect(sequence).toContain("Obtain President's Certificate · set par");
    expect(sequence).not.toContain("Buy President's Certificate");
  });

  it("points the presidency consequence at Ownership & Limits instead of restating it", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const sell = document.getElementById("rules-section-sell");
    expect(sell?.textContent).toContain("The President's Certificate is never sold.");
    expect(sell?.textContent).toContain("Ownership & Limits");
    /* The old inline pointer wording is gone; the link is the pointer. */
    expect(sell?.textContent).not.toContain("see Change of President");
  });
});

describe("the reference is scannable without opening anything", () => {
  it("has no Expand all / Collapse all on this page", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    expect(container.textContent).not.toContain("Expand all");
    expect(container.textContent).not.toContain("Collapse all");
    expect(container.textContent).not.toContain("More detail");
  });

  it("leaves no bulk toggle anywhere in the reference", () => {
    /* WAS the Operating Round page, then Auction & Privates. Both were rebuilt in later passes and
       `BulkToggle` left the file with the second of them, so the claim is now about the whole reference. */
    render({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    ["overview", "stock", "operating", "auction", "tables"].forEach((page) => {
      click(container.querySelector(`[data-testid="rules-page-${page}"]`));
      expect(container.textContent).not.toContain("Expand all");
    });
  });
});

describe("lookups are tables, and tables contain their own overflow", () => {
  it("shows the market zones as a matrix with an em dash where nothing applies", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const zones = required("rules-stock-zones");
    expect(Array.from(zones.querySelectorAll("th")).map((n) => n.textContent)).toEqual([
      "Zone",
      "Certificate-limit effect",
      "Holding-limit effect",
      "Purchase effect",
    ]);
    const rows = Array.from(zones.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector("td")?.textContent)).toEqual(["Yellow", "Orange", "Brown"]);
    /* Yellow adds nothing to holding or purchase; Orange adds nothing to purchase. */
    expect(Array.from(rows[0].querySelectorAll("td")).slice(2).map((n) => n.textContent)).toEqual(["—", "—"]);
    expect(Array.from(rows[1].querySelectorAll("td")).slice(3).map((n) => n.textContent)).toEqual(["—"]);
  });

  it("shows share-value movement with the round each trigger belongs to", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const movement = required("rules-stock-movement");
    expect(Array.from(movement.querySelectorAll("th")).map((n) => n.textContent)).toEqual(["Trigger", "Movement", "When"]);
    const when = Array.from(movement.querySelectorAll("tbody tr")).map((r) => r.querySelectorAll("td")[2]?.textContent);
    /* A SALE IS NOT STOCK-ROUND-ONLY: rulebook 6.6.3 forces one during a train purchase, in an Operating
       Round. The other three are where the table always said they were. */
    expect(when).toEqual([
      "Stock Round, or a forced sale in an Operating Round",
      "Stock Round",
      "Operating Round",
      "Operating Round",
    ]);
    /* Stacking order is a note under the table, not a fifth row. */
    expect(movement.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(document.getElementById("rules-section-movement")?.textContent).toContain("goes to the bottom of the stack");
  });

  it("gives every wide table its own horizontal scroll region", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    [required("rules-stock-zones"), required("rules-stock-movement")].forEach((table) => {
      const wrapper = table.parentElement as HTMLElement;
      expect([table.getAttribute("data-testid"), wrapper.style.overflowX]).toEqual([table.getAttribute("data-testid"), "auto"]);
      /* The wrapper is what scrolls; the table inside it is allowed to be wider. */
      expect(table.style.minWidth).not.toBe("");
    });
  });
});

describe("the page never talks about its own wiring", () => {
  it("has no fallback sentence about missing display state", () => {
    [
      { roundType: "StockRound" as const, roundLabel: "SR2", phase: PHASE_3 },
      { roundType: "StockRound" as const, roundLabel: null, phase: PHASE_3 },
      {},
    ].forEach((props) => {
      stockPage(props);
      const text = container.textContent ?? "";
      expect(text).not.toContain("stockRoundAction");
      expect(text).not.toContain("The table reports");
      expect(text).not.toContain("not which part of the turn");
      expect(text).not.toContain("not yet wired");
    });
  });
});

describe("the first-Stock-Round ban is readable always and marked only in Stock Round 1", () => {
  const BAN = "No certificates may be sold in the first Stock Round.";

  it("is in the Sell section whatever round it is", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR4", phase: PHASE_3 });
    expect(document.getElementById("rules-section-sell")?.textContent).toContain(BAN);
    stockPage({});
    expect(document.getElementById("rules-section-sell")?.textContent).toContain(BAN);
  });

  it("carries the warning mark only while Stock Round 1 is live", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR1", phase: PHASE_3 });
    expect(document.getElementById("rules-section-sell")?.querySelectorAll('[aria-label="warning"]')).toHaveLength(1);
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    expect(document.getElementById("rules-section-sell")?.querySelectorAll('[aria-label="warning"]')).toHaveLength(0);
    stockPage({});
    expect(document.getElementById("rules-section-sell")?.querySelectorAll('[aria-label="warning"]')).toHaveLength(0);
  });
});

describe("the live round still steers without taking over", () => {
  it("marks Round Flow current in a live Stock Round", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    expect(container.textContent).toContain("← Current");
    stockPage({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3 });
    expect(document.getElementById("rules-section-sell")).not.toBeNull();
    expect(container.textContent).not.toContain("← Current");
  });
});

describe("the market-zone swatches are the chart's own colours", () => {
  it("has not drifted from ZONE_TEXT_COLORS", () => {
    /* Copied rather than imported -- `StockMarketRenderer.tsx` is the whole chart, logos and all -- so this
       case is what the import would otherwise have guaranteed. */
    const canonical = /ZONE_TEXT_COLORS[\s\S]*?Yellow: "(#[0-9a-f]{6})",\s*Orange: "(#[0-9a-f]{6})",\s*Brown: "(#[0-9a-f]{6})"/.exec(MARKET_SOURCE);
    expect(canonical).not.toBeNull();
    const copy = /MARKET_ZONE_SWATCH[\s\S]*?Yellow: "(#[0-9a-f]{6})",\s*Orange: "(#[0-9a-f]{6})",\s*Brown: "(#[0-9a-f]{6})"/.exec(STRIPPED);
    expect(copy).not.toBeNull();
    expect([copy?.[1], copy?.[2], copy?.[3]]).toEqual([canonical?.[1], canonical?.[2], canonical?.[3]]);
  });

  it("never lets a swatch be the only thing saying which zone a row is", () => {
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const zones = required("rules-stock-zones");
    Array.from(zones.querySelectorAll("tbody tr")).forEach((row) => {
      const cell = row.querySelector("td") as HTMLElement;
      expect(cell.querySelector("span[aria-hidden='true']")).not.toBeNull();
      expect((cell.textContent ?? "").length).toBeGreaterThan(3);
    });
  });
});

describe("the other pages are untouched by this pass", () => {
  it("still renders the Operating Round and Auction bodies as they were", () => {
    render({ roundType: "OperatingRound", operatingSubPhase: "Track", phase: PHASE_3 });
    click(container.querySelector('[data-testid="rules-page-operating"]'));
    expect(container.textContent).toContain("Round Flow");
    /* WAS "The Corporation's Turn", the old accordion group heading. The Operating Round page was rebuilt as
       a numbered spine in the pass after this one; what this case is for is that the STOCK pass did not
       disturb it, so it pins a section that page has had throughout. */
    expect(container.textContent).toContain("Run Routes");
    click(container.querySelector('[data-testid="rules-page-auction"]'));
    /* WAS "Private Companies" and "Timing Quick Reference". The Auction pass renamed the first and removed
       the second as a restatement; these are landmarks that page has had throughout. */
    expect(container.textContent).toContain("Private companies");
    expect(container.textContent).toContain("Auction Flow");
    click(container.querySelector('[data-testid="rules-page-tables"]'));
    expect(container.textContent).toContain("Player Limits");
    expect(document.getElementById("rules-reference-player-limits")).not.toBeNull();
  });
});

describe("a lookup table that scrolls says so", () => {
  afterEach(restoreBoxes);

  it("says nothing while the table fits", () => {
    /* jsdom's boxes are all zero, which is the "it fits" case: no cue, no clutter on a desktop width. */
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    expect(container.querySelectorAll('[data-testid="rules-scroll-cue"]')).toHaveLength(0);
  });

  it("names the overflow under each wide table when the region is narrower than it", () => {
    /* THE 430px CASE. The zone table's fourth column, PURCHASE EFFECT, is entirely past the right edge
       there, and before this the table simply looked like it had three columns. */
    fakeNarrowTables();
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const cues = container.querySelectorAll('[data-testid="rules-scroll-cue"]');
    expect(cues).toHaveLength(2);
    cues.forEach((cue) => expect(cue.textContent).toContain("Scroll sideways for the rest of the table"));

    /* One under each of the two wide tables, and nowhere else. */
    [required("rules-stock-zones"), required("rules-stock-movement")].forEach((table) => {
      const wrapper = table.parentElement as HTMLElement;
      expect([table.getAttribute("data-testid"), wrapper.nextElementSibling?.getAttribute("data-testid")]).toEqual([
        table.getAttribute("data-testid"),
        "rules-scroll-cue",
      ]);
    });
  });

  it("is a line of text, not a panel", () => {
    fakeNarrowTables();
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const cue = container.querySelector('[data-testid="rules-scroll-cue"]') as HTMLElement;
    expect(cue.tagName).toBe("SPAN");
    expect(cue.style.border).toBe("");
    expect(cue.style.backgroundColor).toBe("");
    expect(cue.style.borderRadius).toBe("");
    /* The arrow points the way; the words are what carries it. */
    expect(cue.textContent).toContain("→");
    expect((cue.textContent ?? "").replace("→", "").trim().length).toBeGreaterThan(20);
  });

  it("leaves the tables' own content alone", () => {
    fakeNarrowTables();
    stockPage({ roundType: "StockRound", roundLabel: "SR2", phase: PHASE_3 });
    const zones = required("rules-stock-zones");
    expect(Array.from(zones.querySelectorAll("th")).map((n) => n.textContent)).toEqual([
      "Zone",
      "Certificate-limit effect",
      "Holding-limit effect",
      "Purchase effect",
    ]);
    expect(zones.querySelectorAll("tbody tr")).toHaveLength(3);
  });
});
