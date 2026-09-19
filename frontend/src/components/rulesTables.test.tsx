/** @jest-environment jsdom */
//
// ==================================================================
//  RULES REFERENCE (harness): TABLES IS A LOOKUP SHEET
// ==================================================================
//
// The page was two tables and then `Other Reference` -- one heading over a grid of five unrelated lookups,
// four of which could not be linked to and none of which appeared anywhere as a name. The redesign makes each
// one a findable section under a generated directory, and these are claims about the rendered page:
//   1. the directory names seven sections and every entry points at one that exists;
//   2. every incoming link from Overview, Stock Round and Operating Round still reaches its heading;
//   3. the two real tables are still TABLES, with the green live mark on this game's seat count and on the
//      phase in force -- and the phase column PINS, so a scrolled row can still be named;
//   4. the tile column is DERIVED from `gamePhase.ts`, so the 18XX+ tile set's Gray Diesel era appears
//      without this page carrying a second schedule;
//   5. the delayed auction's two false phase cells are replaced and tagged, not left as a base-game claim;
//   6. Game End and Forced Train Purchase scan as trigger → outcome, and the winner rule -- which is a
//      definition, not an outcome -- is prose rather than a row pretending to be one.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RulesReference, { type RulesReferenceProps } from "./RulesReference";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const PHASE_3: RulesReferenceProps["phase"] = { label: "Phase 3", tier: "3", trainLimit: 4 };
const BASE: RulesReferenceProps = { roundType: "OperatingRound", roundLabel: "OR 2.1", operatingSubPhase: "Track", playerCount: 4, phase: PHASE_3 };

function variants(partial: Partial<NonNullable<RulesReferenceProps["variants"]>>): RulesReferenceProps["variants"] {
  return {
    expandedMap: false,
    levelPlayingField: false,
    delayedAuction: false,
    gentleRust: false,
    unpredictableRevenue: false,
    dynamicStockMarket: false,
    plusTiles: false,
    ...partial,
  };
}

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

function render(props: RulesReferenceProps = BASE) {
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

function tablesPage(props: RulesReferenceProps = BASE): HTMLElement {
  render(props);
  click(container.querySelector('[data-testid="rules-page-tables"]'));
  const page = container.querySelector<HTMLElement>('[data-testid="rules-tables-page"]');
  if (!page) throw new Error("the Tables page did not render");
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

/** The heading a section carries. */
function headingOf(id: string): string {
  return section(id).querySelector("h3")?.textContent ?? "";
}

function rowsOf(id: string): HTMLElement[] {
  return Array.from(required(id).querySelectorAll<HTMLElement>("tbody tr"));
}

/* jsdom reports 0 for every box, so a container never "overflows" there. */
const BOX_KEYS = ["scrollWidth", "clientWidth"] as const;

function fakeNarrowTables() {
  const isScroller = (node: HTMLElement) => node.style.overflowX === "auto";
  const stubs: Record<string, (this: HTMLElement) => number> = {
    scrollWidth() {
      return isScroller(this) ? 880 : 0;
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

const SECTION_IDS = [
  /* Phases first: the table a player opens this page for mid-game. */
  "rules-reference-phases",
  "rules-reference-player-limits",
  "rules-reference-terrain",
  "rules-reference-certificates",
  "rules-reference-trains",
  "rules-reference-game-end",
  "rules-reference-forced-purchase",
];

/* ------------------------------------------------------------------ */

describe("the page is found by its sections", () => {
  it("names seven of them in a directory, in page order", () => {
    const page = tablesPage();
    const labels = Array.from(required("rules-tables-directory").querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(labels).toEqual(["Trains & Phases", "Player Limits", "Terrain & Stations", "Certificates & Shares", "Trains", "Game End", "Forced Train Purchase"]);
    const ids = Array.from(page.querySelectorAll<HTMLElement>("section[id]")).map((node) => node.id);
    expect(ids).toEqual(SECTION_IDS);
  });

  it("gives every directory entry a section that exists, headed by its own name", () => {
    tablesPage();
    const labels = Array.from(required("rules-tables-directory").querySelectorAll("button")).map((b) => b.textContent ?? "");
    SECTION_IDS.forEach((id, index) => {
      expect(headingOf(id)).toContain(labels[index]);
    });
  });

  it("clears the sticky page strip on every anchor", () => {
    tablesPage();
    SECTION_IDS.forEach((id) => {
      expect(section(id).style.scrollMarginTop).toBe("170px");
    });
  });

  it("is a directory, not another panel", () => {
    tablesPage();
    const directory = required("rules-tables-directory");
    expect(directory.style.border).toBe("");
    expect(directory.style.backgroundColor).toBe("");
    expect(directory.textContent).toContain("Find a table");
    /* The broad wrapper it replaces. */
    expect(required("rules-tables-page").textContent).not.toContain("Other Reference");
  });
});

describe("every incoming link still reaches its heading", () => {
  it("Stock Round's certificate table points at Player Limits", () => {
    render({ roundType: "StockRound", roundLabel: "SR2", playerCount: 4, phase: PHASE_3 });
    click(container.querySelector('[data-testid="rules-page-stock"]'));
    const link = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").indexOf("Player limits") === 0);
    expect(link).toBeDefined();
    click(link!);
    expect(headingOf("rules-reference-player-limits")).toContain("Player Limits");
  });

  it("Overview's Game End strip points at Game End", () => {
    render({ roundType: "OperatingRound", roundLabel: "OR 1.1", operatingSubPhase: "Track", playerCount: 4, phase: PHASE_3 });
    const link = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").indexOf("Exact timing and valuation") === 0);
    expect(link).toBeDefined();
    click(link!);
    expect(headingOf("rules-reference-game-end")).toContain("Game End");
  });

  it("Operating Round's forced-purchase callout points at Forced Train Purchase", () => {
    render(BASE);
    click(container.querySelector('[data-testid="rules-page-operating"]'));
    const link = required("rules-operating-forced-purchase").querySelector("button");
    click(link);
    expect(headingOf("rules-reference-forced-purchase")).toContain("Forced Train Purchase");
  });
});

describe("the two real tables are still tables", () => {
  it("marks this game's seat count, and swaps the whole table for the variant's", () => {
    tablesPage();
    const live = rowsOf("rules-tables-limits").filter((row) => row.style.boxShadow !== "");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toContain("4");
    expect(live[0].querySelector("[aria-label='this game']")).not.toBeNull();

    tablesPage({ ...BASE, playerCount: 7, variants: variants({ levelPlayingField: true }) });
    expect(section("rules-reference-player-limits").textContent).toContain("LPF");
    const lpfLive = rowsOf("rules-tables-limits").filter((row) => row.style.boxShadow !== "");
    expect(lpfLive).toHaveLength(1);
    expect(lpfLive[0].textContent).toContain("7");
  });

  it("keeps the seven phases as rows, not as cards, with the live one marked", () => {
    tablesPage();
    const rows = rowsOf("rules-tables-phases");
    expect(rows).toHaveLength(7);
    const live = rows.filter((row) => row.style.boxShadow !== "");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toContain("3");
    expect(live[0].querySelector("[aria-label='current phase']")).not.toBeNull();
    expect(required("rules-tables-phases").querySelectorAll("th").length).toBe(8);
  });

  it("pins the phase column so a scrolled row can still be named", () => {
    tablesPage();
    const table = required("rules-tables-phases");
    const head = table.querySelector<HTMLElement>("thead th");
    expect(head?.style.position).toBe("sticky");
    expect(head?.style.left).toBe("0px");
    rowsOf("rules-tables-phases").forEach((row) => {
      const first = row.querySelector<HTMLElement>("td");
      expect(first?.style.position).toBe("sticky");
    });
    /* And the live row's green mark travels with it, since the pinned cell paints over the row's own. */
    const liveCell = rowsOf("rules-tables-phases")
      .filter((row) => row.style.boxShadow !== "")[0]
      .querySelector<HTMLElement>("td");
    expect(liveCell?.style.boxShadow).toContain("inset");
  });

  it("reads the tile colours from the phase module rather than carrying a second schedule", () => {
    tablesPage();
    const rows = rowsOf("rules-tables-phases");
    expect(rows[1].textContent).toContain("Yellow");
    expect(rows[4].textContent).toContain("Yellow, Green, Brown");
    expect(required("rules-tables-phases").textContent).not.toContain("Gray");

    /* #1312: under the 18XX+ tile set the Diesel phase adds Gray -- which the hand-written column never did. */
    tablesPage({ ...BASE, variants: variants({ plusTiles: true }) });
    expect(rowsOf("rules-tables-phases")[6].textContent).toContain("Gray");
  });
});

describe("tables that do not fit say so, and only then", () => {
  afterEach(restoreBoxes);

  it("puts both tables in a scroll region of their own", () => {
    const page = tablesPage();
    [required("rules-tables-limits"), required("rules-tables-phases")].forEach((table) => {
      expect((table.parentElement as HTMLElement).style.overflowX).toBe("auto");
    });
    expect(page.querySelectorAll('[data-testid="rules-scroll-cue"]')).toHaveLength(0);
  });

  it("shows the shared cue when content is genuinely off the edge", () => {
    fakeNarrowTables();
    const page = tablesPage();
    expect(page.querySelectorAll('[data-testid="rules-scroll-cue"]').length).toBeGreaterThan(0);
  });
});

describe("the delayed auction does not leave a base-game claim standing", () => {
  it("replaces the two phase cells it falsifies, and tags them", () => {
    tablesPage({ ...BASE, variants: variants({ delayedAuction: true }) });
    const rows = rowsOf("rules-tables-phases");
    /* Rulebook 2.1 has phase 1 run until the privates are bought; `gameVariants.ts` #905 does not play it. */
    expect(rows[0].textContent).toContain("Not played");
    expect(rows[0].textContent).toContain("end of the Operating Round set in which the first 3-train is bought");
    expect(rows[1].textContent).toContain("Start of the game");
    expect(rows[1].textContent).toContain("no Private Companies in play");
    expect(rows[0].textContent).toContain("Delayed auction");
  });

  it("keeps the base-game cells when the variant is off", () => {
    tablesPage();
    const rows = rowsOf("rules-tables-phases");
    expect(rows[0].textContent).toContain("Start of the game");
    expect(rows[0].textContent).toContain("Ends when all private companies have been purchased");
    expect(rows[1].textContent).toContain("All private companies purchased");
    expect(required("rules-tables-phases").textContent).not.toContain("Not played");
  });

  it("does not mark phase 1 current while a delayed auction runs in a later phase", () => {
    /* Phase 1 IS the auction in the printed game, so the live round names it. A delayed auction runs at the
       end of an Operating Round set in phase 3 or later, where phase 1 would be a wrong answer. */
    tablesPage({ roundType: "WaterfallAuction", playerCount: 4, phase: PHASE_3, variants: variants({ delayedAuction: true }) });
    const live = rowsOf("rules-tables-phases").filter((row) => row.style.boxShadow !== "");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toContain("3");

    tablesPage({ roundType: "WaterfallAuction", playerCount: 4, phase: { label: "Phase 2", tier: "2", trainLimit: 4 } });
    const basLive = rowsOf("rules-tables-phases").filter((row) => row.style.boxShadow !== "");
    expect(basLive[0].textContent).toContain("1");
  });

  it("names the Level Playing Field's extra train without inventing a phase for it", () => {
    tablesPage({ ...BASE, variants: variants({ levelPlayingField: true }) });
    /* #1326: "the 7-train has no effect" -- Phase 6 stays Phase 6. */
    expect(rowsOf("rules-tables-phases")).toHaveLength(7);
    expect(required("rules-tables-lpf-trains").textContent).toContain("7-train between the 6 and the Diesel");
    tablesPage();
    expect(testId("rules-tables-lpf-trains")).toBeNull();
  });
});

describe("the polish pass's own claims", () => {
  it("caps the full-width footnotes at the page's reading measure", () => {
    tablesPage({ ...BASE, variants: variants({ levelPlayingField: true }) });
    const notes = [
      ...Array.from(section("rules-reference-phases").querySelectorAll<HTMLElement>("p")),
      ...Array.from(section("rules-reference-player-limits").querySelectorAll<HTMLElement>("p")),
    ];
    expect(notes.length).toBeGreaterThanOrEqual(3);
    notes.forEach((note) => {
      expect(note.style.maxWidth).toBe("68ch");
    });
  });

  it("qualifies the phase-change rule itself when a train type triggers no phase", () => {
    tablesPage({ ...BASE, variants: variants({ levelPlayingField: true }) });
    const phases = section("rules-reference-phases").textContent ?? "";
    /* `gamePhase.ts` #1326: "the 7-train has no effect" -- so "the first train of the new type" is a rule a
       reader of THIS table would take at its word and wait for a phase that never arrives. */
    expect(phases).toContain("the first train of a new phase-triggering type");
    expect(required("rules-tables-lpf-trains").textContent).toContain("only one of them is a phase change");
    expect(required("rules-tables-lpf-trains").textContent).toContain("LPF");
  });

  it("leaves the base sentence alone when every train type triggers a phase", () => {
    tablesPage();
    expect(section("rules-reference-phases").textContent).toContain("the first train of a new type");
    expect(section("rules-reference-phases").textContent).not.toContain("phase-triggering");
  });

  it("keeps the emphasis for figures and verdicts, and drops it for explanations", () => {
    tablesPage();
    const valueOf = (id: string, label: string) => {
      const row = Array.from(section(id).querySelectorAll("tbody tr")).find((r) => (r.textContent ?? "").indexOf(label) === 0);
      return row?.querySelectorAll<HTMLElement>("td")[1];
    };
    /* Short figures and one-line outcomes stay bold... */
    expect(valueOf("rules-reference-terrain", "Water hex")?.style.fontWeight).toBe("700");
    expect(valueOf("rules-reference-game-end", "A player goes bankrupt")?.style.fontWeight).toBe("700");
    expect(valueOf("rules-reference-forced-purchase", "Cannot raise it")?.style.fontWeight).toBe("700");
    /* ...and anything that has to be read does not compete with them. */
    expect(valueOf("rules-reference-game-end", "…during a Stock Round")?.style.fontWeight).toBe("");
    expect(valueOf("rules-reference-certificates", "Individual corporation limit")?.style.fontWeight).toBe("");
    expect(valueOf("rules-reference-forced-purchase", "Corporation + president")?.style.fontWeight).toBe("");
  });
});

describe("the cross-references point the way the page is actually ordered", () => {
  it("sends Player Limits DOWN to Certificates & Shares, because that is where it is", () => {
    tablesPage();
    const ids = Array.from(container.querySelectorAll('[data-testid="rules-tables-page"] section[id]')).map((n) => n.id);
    const note = section("rules-reference-player-limits").querySelector("p")?.textContent ?? "";
    /* THE DIRECTION IS A FACT ABOUT THE ORDER, so it is asserted against the order rather than pinned as a
       string. The reorder pass moved Player Limits from first to second and flipped this word to "above",
       but Certificates & Shares did not move -- it is still the fourth section, below both of them. */
    expect(ids.indexOf("rules-reference-certificates")).toBeGreaterThan(ids.indexOf("rules-reference-player-limits"));
    expect(note).toContain("see Certificates & Shares below");
    expect(note).not.toContain("above");
  });
});

describe("Phase D, and the purchase that opens Gray", () => {
  const PHASE_D: RulesReferenceProps["phase"] = { label: "Phase D", tier: "D", trainLimit: 2 };
  const dieselRow = () => rowsOf("rules-tables-phases")[6];

  it("names the last phase the way the game names it", () => {
    tablesPage();
    const cells = rowsOf("rules-tables-phases").map((row) => row.querySelectorAll("td")[0]?.textContent ?? "");
    expect(cells).toEqual(["1", "2", "3", "4", "5", "6", "D"]);
    /* `gamePhase.ts` prints `presentation.phaseNumber ?? tier`, so the badge has always said `Phase: D`.
       `7` here was the ordinal of the row, and on an LPF board that digit already names a TRAIN. */
    expect(dieselRow().textContent).toContain("First diesel");
    expect(cells).not.toContain("7");
  });

  it("marks Phase D live when the depot reports a Diesel", () => {
    tablesPage({ ...BASE, phase: PHASE_D });
    const live = rowsOf("rules-tables-phases").filter((row) => row.style.boxShadow !== "");
    expect(live).toHaveLength(1);
    expect(live[0].querySelectorAll("td")[0]?.textContent).toContain("D");
    expect(live[0].querySelector("[aria-label='current phase']")).not.toBeNull();
  });

  it("still closes the private companies in Phase D", () => {
    /* THE REGRESSION THE RENAME COULD HAVE SHIPPED. The Overview read the phase with `Number(livePhase)`,
       and `Number("D")` is `NaN` -- which compares false against 5 and would have reported privates open,
       during the one phase in which every last one of them has been closed for two phases. */
    render({ ...BASE, phase: PHASE_D });
    const strip = required("rules-glance-strip").textContent ?? "";
    expect(strip).toContain("Phase D");
    expect(strip).toContain("Closed");
    expect(strip).not.toContain("Phase 3+");
  });

  it("says which purchase opens Gray, and shows the colour, only with the expanded tile set", () => {
    tablesPage();
    expect(dieselRow().textContent).toContain("Yellow, Green, Brown");
    expect(dieselRow().textContent).not.toContain("Gray");
    expect(testId("rules-tables-unlock-D")).toBeNull();

    tablesPage({ ...BASE, variants: variants({ plusTiles: true }) });
    expect(dieselRow().textContent).toContain("Yellow, Green, Brown, Gray");
    /* Derived from `firstPurchaseEffects`, which is where #1312 adds the Diesel's extra effect. */
    expect(required("rules-tables-unlock-D").textContent).toContain("Unlocks Gray tiles");
    expect(required("rules-tables-unlock-D").textContent).toContain("18XX+ tiles");
    /* The printed effect is still there, and still first. */
    expect(dieselRow().textContent).toContain("4-trains removed from play");
  });

  it("puts the unlock on the Diesel row and nowhere else", () => {
    tablesPage({ ...BASE, variants: variants({ plusTiles: true }) });
    const tagged = rowsOf("rules-tables-phases").filter((row) => (row.textContent ?? "").indexOf("Unlocks Gray tiles") >= 0);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toBe(dieselRow());
  });

  it("deals the tile set with the Level Playing Field even when the flag was not recorded", () => {
    /* `resolveVariants` resolves `plusTiles: levelPlayingField || recorded` (#1320/#1415), so a page that
       derived its own scopes from the raw flag alone would deny a colour the board is dealing. */
    tablesPage({ ...BASE, variants: variants({ levelPlayingField: true }) });
    expect(dieselRow().textContent).toContain("Gray");
    expect(required("rules-tables-unlock-D").textContent).toContain("Unlocks Gray tiles");
  });

  it("tells the two Level Playing Field purchases apart", () => {
    tablesPage({ ...BASE, variants: variants({ levelPlayingField: true }) });
    const note = required("rules-tables-lpf-trains").textContent ?? "";
    /* #1326: the 7-train has no effect -- and it arrives in the same breath as the Diesel, which has two. */
    expect(note).toContain("Buying the first 7-train leaves Phase 6 in force");
    expect(note).toContain("opens no new tile colour");
    expect(note).toContain("Buying the first Diesel starts Phase D");
    expect(note).toContain("brings the Gray tiles with it");
    /* Still no eighth row: the 7-train is a train, not a phase. */
    expect(rowsOf("rules-tables-phases")).toHaveLength(7);
  });
});

describe("the lookup sections do the work of their shape", () => {
  it("heads every one of them with the two things it pairs", () => {
    tablesPage();
    const heads = (id: string) => Array.from(section(id).querySelectorAll("th")).map((n) => n.textContent ?? "");
    expect(heads("rules-reference-terrain")).toEqual(["Placement", "Cost"]);
    expect(heads("rules-reference-certificates")).toEqual(["Item", "Value"]);
    expect(heads("rules-reference-trains")).toEqual(["Situation", "Rule"]);
    expect(heads("rules-reference-game-end")).toEqual(["Trigger", "Outcome"]);
    expect(heads("rules-reference-forced-purchase")).toEqual(["Situation", "Outcome"]);
  });

  it("makes every Game End row a complete outcome, and leaves the winner rule as prose", () => {
    tablesPage();
    const gameEnd = section("rules-reference-game-end");
    /* Rulebook 7.1: each bank case ends with "and then the game ends", which the old rows stopped short of. */
    expect(gameEnd.textContent).toContain("Finish the current set of Operating Rounds, then the game ends");
    expect(gameEnd.textContent).toContain("Finish the Stock Round and one set of Operating Rounds, then the game ends");
    expect(gameEnd.textContent).toContain("The game ends immediately");
    /* 7.2's valuation is a definition, so it is not a row in a trigger/outcome table. */
    const rows = Array.from(gameEnd.querySelectorAll("tbody tr")).map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(4);
    expect(rows.join(" ")).not.toContain("wealthiest");
    expect(gameEnd.querySelector("p")?.textContent).toContain("the wealthiest player");
  });

  it("swaps the market ceiling for the variant rather than stating one as universal", () => {
    tablesPage();
    expect(section("rules-reference-certificates").textContent).toContain("$350");
    tablesPage({ ...BASE, variants: variants({ dynamicStockMarket: true }) });
    const certs = section("rules-reference-certificates").textContent ?? "";
    expect(certs).toContain("$450");
    expect(certs).not.toContain("$350");
    expect(certs).toContain("Dynamic market");
  });

  it("shows the extra terrain tier only on a table that has one", () => {
    tablesPage();
    expect(section("rules-reference-terrain").textContent).not.toContain("Extra terrain tier");
    tablesPage({ ...BASE, variants: variants({ expandedMap: true }) });
    expect(section("rules-reference-terrain").textContent).toContain("Extra terrain tier");
  });
});

describe("the other pages are untouched by this pass", () => {
  it("still renders Overview, Stock Round, Operating Round and Auction as they were", () => {
    render(BASE);
    expect(container.textContent).toContain("At a glance");
    click(container.querySelector('[data-testid="rules-page-stock"]'));
    expect(container.textContent).toContain("Market Effects");
    click(container.querySelector('[data-testid="rules-page-operating"]'));
    expect(container.textContent).toContain("Run Routes");
    click(container.querySelector('[data-testid="rules-page-auction"]'));
    expect(container.textContent).toContain("Private companies");
  });
});
