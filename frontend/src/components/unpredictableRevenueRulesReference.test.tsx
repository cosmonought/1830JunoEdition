/** @jest-environment jsdom */
//
// ==================================================================
//  UR-6 (UR-F13; OD-UR-8 = 8-B, backlog D-42): THE RULES REFERENCE STATES THE IMPLEMENTED VARIANT -- AND KEEPS THE EGG
// ==================================================================
//
// The page carried one sentence on Unpredictable Revenue. OD-UR-8 rules what it must disclose -- what a player needs
// for informed decisions: the die and its rounding, the gold-trimmed train's train-limit treatment and its
// disappearance, the Blood Price's consequences (OD-UR-5, fully decided) -- and what it must NOT: the Yellow Sign's
// trigger conditions or odds. Each concept below is the implemented rule as of UR-6 and names the ruling it states.
// OD-UR-10 = 10-C (an exact $5 tie rounds toward printed) is decided but not implemented -- UR-F20 is UR-7's -- so the
// page says "rounded to the nearest $10" and no tie direction.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RulesReference from "./RulesReference";
import { REVENUE_MODIFIER_BY_FACE, resolveVariants } from "../gameEngine/gameVariants";
import { markPayout } from "../gameEngine/yellowSign";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

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

type Flags = { unpredictableRevenue?: boolean; gentleRust?: boolean };
function openPage(flags: Flags, page: "overview" | "stock" | "operating" | "auction" | "tables" = "operating") {
  act(() => root.render(<RulesReference variants={resolveVariants(flags)} />));
  click(host.querySelector(`[data-testid="rules-page-${page}"]`));
  return host;
}
const flat = (node: Element | null | undefined) => (node?.textContent ?? "").replace(/\s+/g, " ");
const dieBlock = () => host.querySelector<HTMLElement>('[data-testid="rules-operating-unpredictable-revenue"]');
const carcosaBlock = () => host.querySelector<HTMLElement>('[data-testid="rules-operating-carcosa-trains"]');
/** Every page of the reference, as one text. */
function wholeReference(flags: Flags): string {
  return (["overview", "stock", "operating", "auction", "tables"] as const).map((page) => flat(openPage(flags, page))).join(" \n ");
}

describe("where the rule lives: two tagged blocks, on the steps where they act", () => {
  it("the die and the Yellow Sign's consequences in Dividends; the gold-trimmed train and the Blood Price in Buy Trains", () => {
    openPage({ unpredictableRevenue: true });
    const dividends = host.querySelector("#rules-section-revenue")!;
    const buyTrains = host.querySelector("#rules-section-buyTrains")!;
    expect(dividends.contains(dieBlock())).toBe(true);
    expect(buyTrains.contains(carcosaBlock())).toBe(true);
    expect(dieBlock()!.querySelector("h4")?.textContent).toMatch(/^Unpredictable Revenue/);
    expect(carcosaBlock()!.querySelector("h4")?.textContent).toMatch(/^Gold-trimmed Carcosa trains/);
    // Each wears the variant's tag, as the Gentle Rust block does.
    for (const block of [dieBlock()!, carcosaBlock()!]) expect(block.querySelector("h4")?.textContent).toMatch(/Unpredictable revenue$/);
    // The old one-sentence note is gone rather than repeated beside the block.
    expect(host.textContent).not.toContain("This table plays unpredictable revenue");
  });
});

describe("the die, as implemented (UR-N4 ... UR-N18)", () => {
  it("one roll per turn on the total, the faces' percentages, the rounding, and what the paid figure drives", () => {
    openPage({ unpredictableRevenue: true });
    const text = flat(dieBlock());
    const concepts: Array<[string, RegExp]> = [
      ["UR-N4 one roll per turn, on the aggregate", /one die is rolled for the whole turn and applied to the total revenue of all its routes/i],
      ["UR-N6 rounding to $10", /rounded to the nearest \$10/],
      ["UR-N6 the rounding can widen the swing (no tie example)", /\$80 run at 80% is \$64, which rounds to \$60/],
      ["UR-N13 never $0 for a positive run", /at least \$10/],
      ["UR-N10/N11 printed values for choosing routes", /highest revenue rule at their printed values.*die applies only when the run is made/i],
      ["UR-N7/N9 the paid figure is the turn's revenue", /revenue after the die is the corporation's revenue for the turn: what it pays out or withholds, and what moves its share price/i],
      ["UR-N12 private income untouched", /Private Company income is never rolled/i],
      ["UR-N18 / OD-UR-11 an undo does not re-roll", /Undoing a run does not roll again/i],
    ];
    for (const [concept, pattern] of concepts) expect([concept, pattern.test(text)]).toEqual([concept, true]);
  });

  it("the table is the engine's own face table, and it sits in a scroll region (narrow screens)", () => {
    openPage({ unpredictableRevenue: true });
    const table = dieBlock()!.querySelector("table")!;
    expect((table.parentElement as HTMLElement).style.overflowX).toBe("auto");
    const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent));
    expect(rows).toEqual([
      ["1", "80%"],
      ["2", "90%"],
      ["3 or 4", "100%"],
      ["5", "110%"],
      ["6", "120%"],
    ]);
    // Read against the reducer's constant, so the page cannot drift from the die.
    const faces = REVENUE_MODIFIER_BY_FACE.map((pct, index) => `${index + 1}:${pct}%`);
    expect(faces).toEqual(["1:80%", "2:90%", "3:100%", "4:100%", "5:110%", "6:120%"]);
  });

  it("the rounding names no tie direction -- 10-C is UR-7's (UR-F20), and the engine still rounds a tie up", () => {
    openPage({ unpredictableRevenue: true });
    const text = `${flat(dieBlock())} ${flat(carcosaBlock())}`;
    expect(text).not.toMatch(/\btie|halfway|toward(s)? (the )?printed|rounds? up|half[- ]up|\$45|\$55|\$165|\$275/i);
  });
});

describe("the Yellow Sign: consequences only -- the Easter egg stays (OD-UR-8)", () => {
  it("what follows a taken train: the lowest-value train, no revenue for its route, gone for good, half its price", () => {
    openPage({ unpredictableRevenue: true });
    const text = flat(dieBlock());
    const concepts: Array<[string, RegExp]> = [
      ["the trigger is not revealed", /What calls it is not revealed/],
      ["UR-N31 the lowest-value train", /loses its lowest-value train/],
      ["UR-N32 only that route earns nothing", /That train's route earns nothing this turn; the rest of the run is paid at the same roll/],
      ["OD-UR-13 removed from the game", /removed from the game for good\. It does not return to the Bank or the Bank Pool, and the phase never goes back/],
      ["UR-N33 half its face value", /half the taken train's face value into its treasury/],
      ["UR-N34 trainless -> the ordinary rules", /no train, the ordinary rules for a trainless corporation apply at Buy Trains/],
    ];
    for (const [concept, pattern] of concepts) expect([concept, pattern.test(text)]).toEqual([concept, true]);
    // "Face value" is the engine's figure: `markPayout` is half the printed Bank price, whatever the train was bought for.
    expect(["2", "3", "4"].map(markPayout)).toEqual([40, 90, 150]);
  });

  it("no hidden trigger condition or odds appears anywhere in the reference", () => {
    const hidden: Array<[string, RegExp]> = [
      ["Carcosa's chance", /60 ?%|60 in 100|\b1-in-5\b|one in (five|ten)|seeded tenth|\bchance\b/gi],
      ["the phase windows", /phases? 2\s*[-–]\s*4|phases? 5\s*[-–]\s*D|Phase 2, 3 or 4|Phases? 5 (through|to) D/gi],
      ["the die faces that call it", /(roll|face) of (a )?[16]\b|critical (bonus|malus)/gi],
      ["odds language", /\b(odds|probability|likelihood)\b/gi],
      ["who can be visited next", /Marked corporation|only the (marked|corporation that)/gi],
    ];
    // The two blocks say none of it.
    openPage({ unpredictableRevenue: true, gentleRust: true });
    const blocks = `${flat(dieBlock())} ${flat(carcosaBlock())}`;
    for (const [concept, pattern] of hidden) expect([concept, blocks.match(pattern) ?? []]).toEqual([concept, []]);
    // And the variant adds none of it anywhere in the reference: every page, with and without it, says the same
    // amount of each (the printed game has its own 60% -- the presidency's -- which is not the Sign's).
    const on = wholeReference({ unpredictableRevenue: true, gentleRust: true });
    const off = wholeReference({ gentleRust: true });
    for (const [concept, pattern] of hidden) {
      expect([concept, (on.match(pattern) ?? []).length]).toEqual([concept, (off.match(pattern) ?? []).length]);
    }
  });

  it("Gentle Rust's interaction is stated only where both variants are on (OD-GR-3 = A2)", () => {
    openPage({ unpredictableRevenue: true, gentleRust: true });
    expect(flat(dieBlock())).toMatch(/With Gentle Rust, a rusted train awaiting or on its Final Run is never the train the Yellow Sign takes/);
    openPage({ unpredictableRevenue: true });
    expect(flat(dieBlock())).not.toMatch(/Gentle Rust|Final Run/);
  });
});

describe("the gold-trimmed Carcosa train and the Blood Price, as ruled and implemented (OD-UR-2, -3, -5, -7)", () => {
  it("while gold-trimmed: extra, exempt from the limit, never the phase, no Diesel trade-in, the curse", () => {
    openPage({ unpredictableRevenue: true });
    const text = flat(carcosaBlock());
    const concepts: Array<[string, RegExp]> = [
      ["UR-N39 an extra train, not the Bank's", /an extra train, not one taken from the Bank/],
      ["UR-N41 exempt from the train limit", /does not count against the train limit\. It is still owned: it runs, and a corporation holding it is not trainless/],
      ["OD-UR-3 never the phase", /never changes the phase\. The phase — and with it rust and the train limit — changes only when the first train of its type is bought from the Bank/],
      ["OD-UR-7 no Diesel trade-in; an ordinary copy can", /cannot be traded in for a Diesel\. An ordinary train of the same type still can be/],
      ["UR-N40/N47 the curse; only the Blood Price lifts it", /The fog does not lift the curse; only the Blood Price does/],
    ];
    for (const [concept, pattern] of concepts) expect([concept, pattern.test(text)]).toEqual([concept, true]);
  });

  it("the fog: one more whole Operating Round set after the doom trigger, whether or not it operates, for nothing", () => {
    openPage({ unpredictableRevenue: true });
    const text = flat(carcosaBlock());
    expect(text).toMatch(/Once a Diesel has been bought from the Bank, the gold-trimmed train has one more whole Operating Round set\. It disappears at the end of the set after the one in which that Diesel was bought — or, if a Diesel had already been bought, after the set in which the gold-trimmed train arrived/);
    expect(text).toMatch(/disappears whether or not its corporation operates, and the corporation receives nothing for it/);
    expect(text).toMatch(/A gold-trimmed Diesel does not count as a Diesel bought from the Bank/); // UR-N43
    expect(text).not.toMatch(/next run|on its (next|first) run|end of (this|the) Operating Round\b(?! set)/i); // not #1092's run-borne fog
  });

  it("the Blood Price: the BUYER pays and moves; the seller does not move and is released; the train is cured", () => {
    openPage({ unpredictableRevenue: true });
    const text = flat(carcosaBlock());
    const concepts: Array<[string, RegExp]> = [
      ["ordinary sale rules", /under the ordinary rules for buying a train from another corporation: an agreed price, during the buyer's turn, with the seller's president agreeing/],
      ["OD-UR-5(b) the buyer pays and its marker moves", /The buying corporation pays the agreed price, and its share price moves 1 cell left and 1 cell down/],
      ["OD-UR-5(b) the seller's price does not move", /The selling corporation's share price does not move, and it is released from the Carcosan curse/],
      ["5a-1 an ordinary train, against the limit", /The buyer receives an ordinary train\. It counts against the buyer's train limit, so the buyer needs room for it/],
      ["5a-1 runs, rusts, resold ordinarily, trade-in, no fog", /runs and rusts like any train of its type, may be sold again as an ordinary sale, may be traded in for a Diesel, and never disappears into the fog/],
      ["OD-UR-5(a) rev 6 no phase change", /Buying it changes no phase, even if no train of its type has yet been bought from the Bank — like every purchase from another corporation\. The phase changes when the first one is bought from the Bank/],
      ["5c-2 the copy is named", /the offer names which one is sold\. Selling the ordinary one is an ordinary sale: no Blood Price, and the gold-trimmed train stays gold-trimmed, with its curse and its fog/],
    ];
    for (const [concept, pattern] of concepts) expect([concept, pattern.test(text)]).toEqual([concept, true]);
  });

  it("no stale seller-pays language, no special train class, no implementation vocabulary", () => {
    const text = wholeReference({ unpredictableRevenue: true, gentleRust: true });
    const stale: Array<[string, RegExp]> = [
      ["#1090's seller move", /selling corporation['’]s share price (will )?(immediately )?drop|seller['’]s (stock|share price) (drops|falls|moves (1|one))|seller pays the Blood Price|to be rid of it/i],
      ["a special class of train", /bonus train|ghost train|still gold-trimmed at the buyer|remains a ghost/i],
      ["implementation terms", /ghost_trains|returned_ghost|carcosan_trains|provenance|reducer|replay|rules[_ ]engine|pinned|serial|\bfield\b/i],
      ["the variant's old name", /Unpredictable Routes/i],
    ];
    for (const [concept, pattern] of stale) expect([concept, pattern.test(text)]).toEqual([concept, false]);
  });
});

describe("standard-mode control: a game without the variant renders none of it", () => {
  it("no block, no tag, no Carcosa, Blood Price or Yellow Sign anywhere in the reference", () => {
    const text = wholeReference({});
    expect(text).not.toMatch(/Unpredictable|Carcosa|Blood Price|Yellow Sign|gold-trimmed/i);
    openPage({});
    expect(dieBlock()).toBeNull();
    expect(carcosaBlock()).toBeNull();
  });

  it("Gentle Rust alone renders Gentle Rust's block and none of this", () => {
    openPage({ gentleRust: true });
    expect(host.querySelector('[data-testid="rules-operating-gentle-rust"]')).not.toBeNull();
    expect(dieBlock()).toBeNull();
    expect(carcosaBlock()).toBeNull();
  });
});

describe("layout: the page's own type and measure, nothing new to overflow (mobile)", () => {
  it("both blocks are OpBlocks at the page's measure, with no disclosure, control or fixed-width table", () => {
    openPage({ unpredictableRevenue: true, gentleRust: true });
    for (const block of [dieBlock()!, carcosaBlock()!]) {
      expect(block.style.maxWidth).toBe("68ch");
      expect(block.style.minWidth).toBe("0");
      expect(block.querySelectorAll("details, button, input")).toHaveLength(0);
      block.querySelectorAll("table").forEach((table) => {
        expect((table.parentElement as HTMLElement).style.overflowX).toBe("auto");
        expect((table as HTMLElement).style.tableLayout).not.toBe("fixed");
        expect((table as HTMLElement).style.minWidth).toBe("");
      });
    }
    expect(carcosaBlock()!.querySelectorAll("table")).toHaveLength(0);
  });

  it("the source adds no style key and no disclosure machinery to the Operating page", () => {
    const SOURCE = readStripped("components/RulesReference.tsx");
    const page = SOURCE.slice(SOURCE.indexOf("function OperatingRoundPage("), SOURCE.indexOf("\nfunction AuctionPage("));
    expect(page).toContain('testId="rules-operating-unpredictable-revenue"');
    expect(page).toContain('testId="rules-operating-carcosa-trains"');
    expect(page.indexOf("MoreToggle")).toBe(-1);
  });
});
