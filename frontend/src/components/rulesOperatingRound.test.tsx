/** @jest-environment jsdom */
//
// ==================================================================
//  RULES REFERENCE (harness): THE OPERATING ROUND PAGE IS A SPINE NOW
// ==================================================================
//
// The page was a flow diagram over five identically shaped `More detail` sections under one `Expand all`,
// with Buy Private Company as a sixth section of the same shape. The redesign makes it a numbered spine with
// a different treatment per kind of rule, and puts three rules back where the rulebook puts them. All of
// those are claims about the rendered page, so this suite checks them there:
//   1. the five sections appear in the turn's order, every flow stage jumps to one that exists, and the
//      anchors the Overview links into are all still on the page;
//   2. the flow is HEADINGS: five stages, no sixth, nothing with a box around it, and no claim about a live
//      sub-phase -- green and the word CURRENT appear only when `operatingSubPhase` is actually supplied;
//   3. the home station is beside the flow and NOT inside step 2, which is only the optional station;
//   4. Buy Private Company is outside the numbered spine and its availability names both ends of the window;
//   5. S6-10 -- the rulebook's definition of "city", the begin/end-versus-pass-through distinction and the
//      counting rule are in the VISIBLE Run Routes text, each said once;
//   6. nothing on this page is behind a disclosure, and the pages that still have accordions still do;
//   7. every wide lookup sits in its own scroll region, so none of them widens the page.
//
// And two source scans, for what a render cannot check: the page holds no `MoreToggle`/`BulkToggle`, and
// every `styles.op*` key this pass added is actually used (design note #490a: absence assertions run against
// a comment-stripped copy, or a design note mentioning a name would satisfy them).

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
const { stripComments, sliceBetween } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");
const STRIPPED = stripComments(SOURCE);

let container: HTMLDivElement;
let root: Root;

const PHASE_4: RulesReferenceProps["phase"] = { label: "Phase 4", tier: "4", trainLimit: 3 };

const LIVE_ROUTES: RulesReferenceProps = {
  roundType: "OperatingRound",
  roundLabel: "OR 2.1",
  operatingSubPhase: "Routes",
  activeCorporation: { ticker: "PRR" },
  playerCount: 4,
  phase: PHASE_4,
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

/** Render and open the Operating Round page. */
function operatingPage(props: RulesReferenceProps = {}): HTMLElement {
  render(props);
  click(container.querySelector('[data-testid="rules-page-operating"]'));
  const page = container.querySelector<HTMLElement>('[data-testid="rules-operating-page"]');
  if (!page) throw new Error("the Operating Round page did not render");
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

/** How many times a sentence appears anywhere in the rendered page. */
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
/* Stubbed geometry, for the lookups that can overflow                 */
/* ------------------------------------------------------------------ */

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

describe("the page is the corporation's turn, in order", () => {
  it("renders the five sections in the turn's order, then the side action", () => {
    const page = operatingPage(LIVE_ROUTES);
    const ids = Array.from(page.querySelectorAll<HTMLElement>("section[id]")).map((node) => node.id);
    expect(ids).toEqual([
      "rules-section-track",
      "rules-section-station",
      "rules-section-routes",
      "rules-section-revenue",
      "rules-section-buyTrains",
      "rules-section-buyPrivate",
    ]);
  });

  it("keeps every anchor the Overview's lookups link into", () => {
    operatingPage(LIVE_ROUTES);
    ["rules-section-track", "rules-section-station", "rules-section-routes", "rules-section-buyTrains"].forEach((id) => {
      expect(document.getElementById(id)).not.toBeNull();
    });
  });

  it("gives every flow stage a section that exists", () => {
    const page = operatingPage(LIVE_ROUTES);
    const stages = Array.from(required("rules-operating-flow").querySelectorAll("button"));
    expect(stages).toHaveLength(5);
    stages.forEach((stage) => {
      const name = stage.getAttribute("aria-label") ?? "";
      expect(name.indexOf("Jump to ")).toBe(0);
    });
    expect(page.querySelectorAll("section[id]").length).toBeGreaterThanOrEqual(stages.length);
  });

  it("opens with the round's cadence, not with a step", () => {
    operatingPage(LIVE_ROUTES);
    const cadence = required("rules-operating-cadence").textContent ?? "";
    expect(cadence).toContain("Private Company");
    expect(cadence).toContain("share-value order");
    /* Rulebook 6.0 is one sentence about the ROUND. The five stages under it are the TURN. */
    expect(cadence).not.toContain("Lay Track");
  });
});

describe("the flow is headings, not gameplay controls", () => {
  it("draws five stages and no sixth", () => {
    operatingPage(LIVE_ROUTES);
    expect(required("rules-operating-flow").querySelectorAll("button")).toHaveLength(5);
    expect(required("rules-operating-flow").textContent).not.toContain("Buy Private");
  });

  it("gives no stage a box of its own", () => {
    operatingPage(LIVE_ROUTES);
    Array.from(required("rules-operating-flow").querySelectorAll<HTMLElement>("button")).forEach((stage) => {
      expect(stage.style.background).toBe("none");
      expect(stage.style.borderStyle).toBe("none");
      /* The only edge a stage carries is the accent rule under the word. */
      expect(stage.style.borderBottomWidth).toBe("2px");
    });
  });

  it("hides the arrows from assistive technology", () => {
    operatingPage(LIVE_ROUTES);
    Array.from(required("rules-operating-flow").children).forEach((node) => {
      if (node.tagName === "SPAN") expect(node.getAttribute("aria-hidden")).toBe("true");
    });
  });
});

describe("green and the word Current are reserved for a known live state", () => {
  it("marks nothing when there is no live round", () => {
    const page = operatingPage({ playerCount: 4, phase: PHASE_4 });
    expect(page.textContent).not.toContain("Current");
  });

  it("marks the live step once in the flow and once on its section", () => {
    const page = operatingPage(LIVE_ROUTES);
    expect(occurrences("Current", page)).toBe(2);
    expect(section("rules-section-routes").textContent).toContain("Current");
    expect(section("rules-section-track").textContent).not.toContain("Current");
  });

  it("moves the mark with the sub-phase", () => {
    const page = operatingPage({ ...LIVE_ROUTES, operatingSubPhase: "Hardware" });
    expect(section("rules-section-buyTrains").textContent).toContain("Current");
    expect(section("rules-section-routes").textContent).not.toContain("Current");
    expect(occurrences("Current", page)).toBe(2);
  });

  it("marks the side action when the live cursor is on it, without numbering it", () => {
    operatingPage({ ...LIVE_ROUTES, operatingSubPhase: "BuyPrivate" });
    expect(section("rules-section-buyPrivate").textContent).toContain("Current");
    expect(required("rules-operating-flow").textContent).not.toContain("Current");
  });
});

describe("the home station is its own rule, beside the flow", () => {
  it("states the timing the rulebook states, before Lay Track", () => {
    operatingPage(LIVE_ROUTES);
    const text = required("rules-operating-home-station").textContent ?? "";
    /* Rulebook 6.1 / 6.3.1. Not "when it floats" -- 5.3 hands over the tokens and says nothing about
       placing one -- and not "on its first Operating Turn" without saying when in the turn. */
    expect(text).toContain("At the start of its first operating turn");
    expect(text).toContain("home-station token");
    expect(text).toContain("for free");
    expect(text).toContain("before Lay Track");
  });

  it("says only that, beside the flow", () => {
    operatingPage(LIVE_ROUTES);
    /* The Erie and NYC home-hex exceptions used to follow it here, four lines of the opening screen spent
       qualifying a rule that applies to two of the eight corporations. They are track rules now. */
    const note = required("rules-operating-home-station").textContent ?? "";
    expect(note).not.toContain("Erie");
    expect(note).not.toContain("NYC");
    const flowBlock = required("rules-operating-home-station").parentElement as HTMLElement;
    expect(flowBlock.textContent).not.toContain("tile #57");
    expect(flowBlock.textContent).not.toContain("E-19");
  });

  it("sits outside the five-step flow and above the first step", () => {
    const page = operatingPage(LIVE_ROUTES);
    const home = required("rules-operating-home-station");
    expect(required("rules-operating-flow").contains(home)).toBe(false);
    expect(home.compareDocumentPosition(section("rules-section-track")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(page.contains(home)).toBe(true);
  });

  it("is not merged into step 2, which is only the optional additional station", () => {
    operatingPage(LIVE_ROUTES);
    const step2 = section("rules-section-station").textContent ?? "";
    expect(step2).toContain("additional station");
    expect(step2).not.toContain("first operating turn");
    expect(step2).not.toContain("first Operating Turn");
    /* And the home station's own timing is stated once on the page, not once per place it could go. */
    expect(occurrences("At the start of its first operating turn")).toBe(1);
  });
});

describe("Buy Private Company is a side action, not a sixth step", () => {
  it("carries no step number and stands outside the numbered spine", () => {
    operatingPage(LIVE_ROUTES);
    const side = section("rules-section-buyPrivate");
    expect(side.textContent).toContain("Side action");
    expect(side.textContent).toContain("Not one of the five steps");
  });

  it("names itself beside the flow instead of denying that it is a step", () => {
    const page = operatingPage(LIVE_ROUTES);
    const line = required("rules-operating-side-line");
    /* WAS a dashed `NOT A STEP` pill -- the page arguing with itself. The flow above is numbered 1 to 5 and
       this line is not in it, which is the whole claim; the label just says what the line is. */
    expect(line.textContent).toContain("Side action · Buy Private Company");
    expect(page.textContent).not.toContain("Not a step");
    expect(line.querySelector("button")?.textContent).toContain("Read the rules");
  });

  it("names both ends of the window rather than implying Phase 3 onward", () => {
    operatingPage(LIVE_ROUTES);
    const line = required("rules-operating-side-line").textContent ?? "";
    /* Rulebook 3.0 ("During phases 3 and 4") and 3.2 ("All private companies are closed when the first
       5-train is bought"). "Phase 3+" alone reads as "from now on". */
    expect(line).toContain("Phases 3 and 4");
    expect(line).toContain("first 3-train");
    expect(line).toContain("5-train");
    expect(line).not.toContain("Phase 3+");
    /* And the section it links to says the same thing, both ends of it. (Not asserted against the whole
       page: "Phase 3+" is also a tile-availability label in the Lay Track lookup, where it is correct.) */
    const side = section("rules-section-buyPrivate").textContent ?? "";
    expect(side).toContain("shuts when the first 5-train is purchased");
    expect(side).not.toContain("Available from Phase 3 onward");
    expect(side).not.toContain("Beginning in Phase 3");
  });
});

describe("S6-10: the route rules the rulebook states, in the visible text", () => {
  it("defines a city as all three kinds", () => {
    operatingPage(LIVE_ROUTES);
    const cities = required("rules-operating-route-cities").textContent ?? "";
    /* 6.4 / glossary p.26. THE DEFINITION ROW ONLY DEFINES: what each city then does -- count, and pay -- is
       the counting row's job, and saying it in both was the repetition this pass removed. */
    expect(cities).toContain("a large city, a small city, or a red off-board area");
    expect(cities).toContain("All three count as cities");
  });

  it("separates beginning or ending at a blocked city from passing through it", () => {
    operatingPage(LIVE_ROUTES);
    const cities = required("rules-operating-route-cities").textContent ?? "";
    expect(cities).toContain("A route may begin or end at any city");
    expect(cities).toContain("A route may not pass through a red off-board area");
    expect(cities).toContain("Either may still be the route's first or last city");
  });

  it("counts every city the route reaches and forbids skipping one", () => {
    operatingPage(LIVE_ROUTES);
    const cities = required("rules-operating-route-cities").textContent ?? "";
    expect(cities).toContain("Every city the route runs through or to counts toward the train's limit");
    expect(cities).toContain("contributes its revenue value");
    expect(cities).toContain("may not skip a city it runs through");
  });

  it("puts them in Run Routes itself, not behind a disclosure or inside a warning", () => {
    const page = operatingPage(LIVE_ROUTES);
    const cities = required("rules-operating-route-cities");
    expect(section("rules-section-routes").contains(cities)).toBe(true);
    expect(page.querySelectorAll("details")).toHaveLength(0);
    expect(page.textContent).not.toContain("More detail");
  });

  it("says each of them once", () => {
    operatingPage(LIVE_ROUTES);
    expect(occurrences("a large city, a small city, or a red off-board area")).toBe(1);
    expect(occurrences("A route may not pass through a red off-board area")).toBe(1);
    expect(occurrences("may not skip a city")).toBe(1);
  });

  it("keeps the highest-revenue rule prominent and free of new procedure", () => {
    operatingPage(LIVE_ROUTES);
    const rule = required("rules-operating-highest-revenue").textContent ?? "";
    expect(rule).toContain("highest possible revenue");
    expect(occurrences("highest possible revenue")).toBe(1);
    /* A rule the PLAYERS follow. Nothing here asks the app to arbitrate a combination. */
    expect(rule).not.toContain("the app");
  });
});

describe("the reference is readable without opening anything", () => {
  it("has no bulk toggle and exactly one disclosure, named for what is inside it", () => {
    const page = operatingPage(LIVE_ROUTES);
    expect(page.textContent).not.toContain("Expand all");
    expect(page.textContent).not.toContain("Collapse all");
    /* NOT a generic accordion: a single exception-specific disclosure, and its label says whose exception it
       is so nobody has to open it to find out whether it concerns them. */
    const toggles = page.querySelectorAll("[aria-expanded]");
    expect(toggles).toHaveLength(1);
    expect(toggles[0].textContent).toContain("Home hexes — NYC and Erie");
    expect(page.textContent).not.toContain("More detail");
  });

  it("leaves no bulk toggle anywhere in the reference", () => {
    /* WAS "leaves the bulk toggle on the page that still has accordions", pointed at Auction & Privates.
       That page was rebuilt in the pass after this one and `BulkToggle` left the file with it, so the claim
       is now about the whole reference. */
    render(LIVE_ROUTES);
    ["overview", "stock", "operating", "auction", "tables"].forEach((page) => {
      click(container.querySelector(`[data-testid="rules-page-${page}"]`));
      expect(container.textContent).not.toContain("Expand all");
      expect(container.textContent).not.toContain("Collapse all");
    });
  });

  it("gives the choice in step 4 two sides", () => {
    operatingPage(LIVE_ROUTES);
    const choice = required("rules-operating-dividend-choice").textContent ?? "";
    expect(choice).toContain("Pay dividends");
    expect(choice).toContain("Withhold");
    expect(choice).toContain("share value to increase");
    expect(choice).toContain("share value decreases");
  });

  it("marks the forced purchase as the exception it is, and points at its table", () => {
    operatingPage(LIVE_ROUTES);
    const forced = required("rules-operating-forced-purchase");
    expect(forced.textContent).toContain("Forced train purchase");
    expect(forced.textContent).toContain("it must immediately purchase a train");
    expect(forced.querySelector("[role='img']")?.getAttribute("aria-label")).toBe("warning");
    click(forced.querySelector("button"));
    /* The link lands on Tables, where the section is titled in the page's own case. */
    expect(container.textContent).toContain("Forced Train Purchase");
    expect(document.getElementById("rules-reference-forced-purchase")).not.toBeNull();
  });
});

describe("the home-hex exceptions are Lay Track's, and behind its one disclosure", () => {
  it("lives in Lay Track, closed, and opens on click", () => {
    operatingPage(LIVE_ROUTES);
    const block = required("rules-operating-home-hexes");
    expect(section("rules-section-track").contains(block)).toBe(true);
    const toggle = block.querySelector("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(block.textContent).not.toContain("tile #57");
    click(toggle);
    expect(block.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("is the page's only statement of the two home-hex tiles", () => {
    operatingPage(LIVE_ROUTES);
    const track = section("rules-section-track");
    /* The visible exceptions list keeps the CSL and DH -- private-company abilities, not home hexes -- and
       the two home hexes are stated once, in the disclosure. */
    expect(track.textContent).toContain("A corporation owning CSL may lay");
    expect(track.textContent).toContain("A corporation owning DH may lay");
    /* The bullets say what a corporation MAY DO, so the list's stem no longer governs them. */
    expect(track.textContent).toContain("Explicit exceptions:");
    expect(track.textContent).not.toContain("Explicit exceptions allow:");
    /* Rulebook 3.0. The CSL is the only exception on this page that buys a SECOND tile. */
    expect(track.textContent).toContain("the CSL hex (B-20)");
    expect(track.textContent).toContain("need not connect to one of its stations, or to any track at all");
    expect(track.textContent).toContain("in addition to its normal tile placement");
    expect(track.textContent).toContain("may lay two tiles that turn");
    /* Rulebook 3.0. The DH's three omitted facts, and the contrast with the CSL directly above it. */
    expect(track.textContent).toContain("the DH hex (F-16) with no connection required");
    expect(track.textContent).toContain("paying the usual $120 mountain cost");
    expect(track.textContent).toContain("station token there for free on that same turn");
    expect(track.textContent).toContain("The tile counts as its normal one-tile placement for the turn");
    /* 3.0 names a tile number for the NYC and the Erie and NOT for the DH, where it says "a track tile". */
    expect(track.textContent).not.toContain("yellow 57 tile on the DH");
    /* The later-station rule stays in step 2, which this pass did not touch. */
    expect(section("rules-section-station").textContent).toContain("The DH Private Company provides an exception to this connection requirement");
    expect(track.textContent).not.toContain("The NYC to place a yellow 57 tile");
    expect(track.textContent).not.toContain("The Erie to place a green 59 tile");
    click(required("rules-operating-home-hexes").querySelector("button"));
    expect(occurrences("E-19", track)).toBe(1);
    expect(occurrences("E-11", track)).toBe(1);
  });

  it("states the rulebook's exception without overstating it", () => {
    operatingPage(LIVE_ROUTES);
    click(required("rules-operating-home-hexes").querySelector("button"));
    const text = required("rules-operating-home-hexes").textContent ?? "";
    /* 6.2.1 / 6.3.1: "The NYC may place an (57) yellow tile on the hex containing its home station (E-19)";
       "The Erie may place a (59) green tile ... (assuming green tiles are available)"; "The Erie does not
       have to place a tile in its starting hex. Similarly, the NYC does not..."; and "Using the normal
       rules, any railroad can place a tile on a hex listed as an exception." */
    expect(text).toContain("Neither corporation must lay a tile on its home hex to place its home-station token");
    expect(text).toContain("yellow tile #57 on E-19");
    expect(text).toContain("green tile #59 on E-11 once green tiles are available");
    expect(text).toContain("without meeting the normal connection requirement");
    expect(text).toContain("not extra track actions");
    expect(text).toContain("optional");
    expect(text).toContain("Neither hex is reserved");
    /* The CSL is the one exception that IS an extra tile lay; these two are not, and must not read as a
       thing the corporation has to come back and do later. */
    expect(text).not.toContain("must place");
    expect(text).not.toContain("on a later turn");
  });
});

describe("each fact has one visible home", () => {
  it("states the track choice once", () => {
    operatingPage(LIVE_ROUTES);
    const track = section("rules-section-track");
    expect(track.textContent).toContain("Place 1 new tile OR upgrade 1 existing tile.");
    /* WAS: the lead, then "a corporation may do one and only one of the following:" with the same two
       options as bullets. The two options now open the two columns that explain them. */
    expect(track.textContent).not.toContain("one and only one of the following");
    expect(occurrences("Place one tile on a hex that does not already contain a tile", track)).toBe(1);
    expect(occurrences("Upgrade one tile already on the board", track)).toBe(1);
  });

  it("says a train runs once, and says it once", () => {
    operatingPage(LIVE_ROUTES);
    const routes = section("rules-section-routes");
    expect(routes.textContent).toContain("Each train runs once on one legal route.");
    expect(routes.textContent).not.toContain("Each train owned by a corporation may run once");
  });

  it("states the two-city minimum once, in the definition of a route", () => {
    operatingPage(LIVE_ROUTES);
    const routes = section("rules-section-routes");
    expect(occurrences("at least two cities", routes) + occurrences("at least 2 cities", routes)).toBe(1);
    expect(routes.textContent).toContain("A route consists of a continuous segment of track connecting at least two cities");
  });

  it("keeps the counting rule and the definition distinct", () => {
    operatingPage(LIVE_ROUTES);
    const cities = required("rules-operating-route-cities").textContent ?? "";
    expect(occurrences("counts toward the train's limit", required("rules-operating-route-cities"))).toBe(1);
    expect(cities).toContain("All three count as cities");
  });

  it("still separates the route restrictions rather than flattening them", () => {
    operatingPage(LIVE_ROUTES);
    const columns = required("rules-operating-route-columns");
    expect(columns.querySelectorAll("li").length).toBeGreaterThanOrEqual(6);
    expect(columns.textContent).toContain("A route may");
    expect(columns.textContent).toContain("A route may not");
  });
});

describe("the breadcrumb omits what it does not know", () => {
  it("names the corporation when there is one", () => {
    render(LIVE_ROUTES);
    const crumbs = container.querySelector(".rr-crumbs")?.textContent ?? "";
    expect(crumbs).toContain("PRR");
    expect(crumbs.indexOf("→→")).toBe(-1);
  });

  it("drops the crumb AND its separator when the corporation is absent or blank", () => {
    /* REPORTED: `Operating Round 2.1 → → Run Routes`. The guard was `if (activeCorporation)`, so a caller
       holding the object but no ticker pushed an empty crumb between two arrows. */
    const shapes: RulesReferenceProps["activeCorporation"][] = [null, undefined, { ticker: "" }, { ticker: "   " }];
    shapes.forEach((shape) => {
      render({ ...LIVE_ROUTES, activeCorporation: shape });
      const node = container.querySelector(".rr-crumbs");
      const crumbs = node?.textContent ?? "";
      expect(crumbs.indexOf("→→")).toBe(-1);
      expect(crumbs).toContain("Operating Round 2.1");
      expect(crumbs).toContain("Run Routes");
      const arrows = Array.from(node?.querySelectorAll("span[aria-hidden='true']") ?? []);
      expect(arrows).toHaveLength(1);
    });
  });
});

describe("lookups are tables, and tables contain their own overflow", () => {
  afterEach(restoreBoxes);

  it("puts every table in a scroll region of its own", () => {
    const page = operatingPage(LIVE_ROUTES);
    const tables = Array.from(page.querySelectorAll("table"));
    expect(tables.length).toBeGreaterThan(0);
    tables.forEach((table) => {
      const wrapper = table.parentElement as HTMLElement | null;
      expect(wrapper?.style.overflowX).toBe("auto");
    });
  });

  it("renders the train range and train limit as tables, not prose", () => {
    const page = operatingPage(LIVE_ROUTES);
    const text = page.textContent ?? "";
    expect(text).toContain("Train range");
    expect(text).toContain("Train limit by phase");
    expect(page.querySelectorAll("table").length).toBeGreaterThanOrEqual(4);
  });

  it("reports the narrow case through the shared cue rather than clipping silently", () => {
    fakeNarrowTables();
    operatingPage(LIVE_ROUTES);
    /* The Operating lookups are narrow enough not to need the cue; what this pins is that if one of them
       ever does overflow, it is inside a region that can say so rather than off the edge of the page. */
    const page = required("rules-operating-page");
    Array.from(page.querySelectorAll("table")).forEach((table) => {
      expect((table.parentElement as HTMLElement).style.overflowX).toBe("auto");
    });
  });
});

describe("the other pages are untouched by this pass", () => {
  it("still renders Overview, Stock Round, Auction and Tables as they were", () => {
    render(LIVE_ROUTES);
    expect(container.textContent).toContain("At a glance");
    click(container.querySelector('[data-testid="rules-page-stock"]'));
    expect(container.textContent).toContain("Round Flow");
    expect(container.textContent).toContain("Market Effects");
    click(container.querySelector('[data-testid="rules-page-auction"]'));
    /* WAS "Timing Quick Reference", which the Auction pass removed as a restatement of the sections above
       it. Pins a landmark that page has had throughout instead. */
    expect(container.textContent).toContain("Private companies");
    click(container.querySelector('[data-testid="rules-page-tables"]'));
    expect(container.textContent).toContain("Player Limits");
    expect(document.getElementById("rules-reference-player-limits")).not.toBeNull();
  });
});

describe("the source says what the page says", () => {
  it("holds no disclosure machinery inside the Operating Round page", () => {
    const page = sliceBetween(STRIPPED, "function OperatingRoundPage(", "\nfunction AuctionPage(");
    expect(page.indexOf("MoreToggle")).toBe(-1);
    expect(page.indexOf("BulkToggle")).toBe(-1);
    expect(page.indexOf("openKeys")).toBe(-1);
  });

  it("uses every style key this page declares", () => {
    const declared = (STRIPPED.match(/\n {2}(op[A-Z][A-Za-z]*):/g) ?? []).map((line) => line.trim().replace(":", ""));
    expect(declared.length).toBeGreaterThan(10);
    declared.forEach((key) => {
      expect(STRIPPED.indexOf(`styles.${key}`)).toBeGreaterThan(-1);
    });
  });
});
