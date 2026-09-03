/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1116 (harness): A LIVERY AS INK, AND THE RULE UNDER IT
// ==================================================================
//
// REPORTED as one corporation -- "the NYC text is disappearing into the dark background" -- and it is the
// worst of four. This file exists because the obvious fix (force NYC white) passes any test written about
// NYC and leaves the B&O, the CPR and the PRR exactly as broken.
//
// SO NOTHING HERE NAMES A CORPORATION. Every case walks all eight liveries out of the same table the app
// reads and asserts a FLOOR, which is the only shape that can fail when a ninth is added or a livery is
// re-cut. The numbers are computed here rather than copied from the component, so a change to the lift
// percentages is caught as a contrast failure rather than as a mismatched literal.

export {};

const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
const { CORPORATION_LIVERY_COLORS } =
  require("../styles/corporationLivery") as typeof import("../styles/corporationLivery");

const LEDGER = readStripped("components/FinancialLedger.tsx");

/* The panel the header row actually sits on -- `INK_VIEWPORT`, read from the palette rather than retyped.
   THIS CONSTANT WAS A LITERAL AND THE LITERAL WAS A GUESS: it said `#141414` while the ledger still had no
   background at all and sat on the `#080808` page, so every ratio below was measured against a surface that
   did not exist. #1117 gave the tab a real ground and #1118 is where that got noticed. Imported now, so the
   suite cannot be right about a colour the app is not using. */
const { INK_VIEWPORT } = require("../styles/palette") as typeof import("../styles/palette");
const LEDGER_PANEL = INK_VIEWPORT;
const CARD_SURFACE = "#f2f0eb";

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const value = parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* The component's own mix, reimplemented rather than imported: `FinancialLedger` is a React module and this
   is a node-environment suite. Reimplementing is safe here ONLY because the assertions below also pin the
   percentages the component uses -- so the two cannot silently disagree. */
function lift(hex: string, percent: number): string {
  const channel = (i: number) => {
    const from = parseInt(hex.slice(i, i + 2), 16);
    const to = parseInt(CARD_SURFACE.slice(i, i + 2), 16);
    return Math.round(from + ((to - from) * percent) / 100);
  };
  return `#${[1, 3, 5].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

const LIVERIES = Object.entries(CORPORATION_LIVERY_COLORS) as [string, string][];

describe("the ledger header is readable for every corporation, not just the one reported", () => {
  it("has eight liveries to answer for", () => {
    // The suite's own assumption. An empty table would make every floor below vacuously true.
    expect(LIVERIES.length).toBeGreaterThanOrEqual(8);
  });

  it("would have failed before the fix, which is why the fix is not about NYC", () => {
    /* THE EVIDENCE FOR THE SCOPE OF THE REPORT, kept as a test rather than as a sentence in a comment: at
       least four of the eight raw liveries are under the text bar on this panel, and at least one is under
       2:1 -- invisible, not faint. If a future re-cut of the liveries makes this case fail, the liveries got
       lighter and the lift may be able to shrink; that is worth knowing and is why it asserts a range. */
    const failing = LIVERIES.filter(([, hex]) => contrast(hex, LEDGER_PANEL) < AA_TEXT);
    expect(failing.length).toBeGreaterThanOrEqual(4);
  });

  it("clears the text bar for all eight once lifted", () => {
    /* Reported as a pair so a failure names the corporation rather than just a number -- eight identical
       "expected 4.5" lines would say which bar broke and not which column. */
    const failing = LIVERIES.map(([id, hex]) => [id, contrast(lift(hex, 55), LEDGER_PANEL)] as const)
      .filter(([, ratio]) => ratio < AA_TEXT)
      .map(([id, ratio]) => `${id}: ${ratio.toFixed(2)}:1`);
    expect(failing).toEqual([]);
  });

  it("clears the non-text bar for all eight underlines", () => {
    /* ==================================================================
        DESIGN NOTE 1116: THE HALF THE FIRST DRAFT GOT WRONG
       ==================================================================
       The rule kept the RAW livery, on the argument that a 2px line answers to 3:1 rather than 4.5:1. The
       argument was correct and the line still failed: the darkest livery is 1.06:1 against this panel, so
       four of the eight underlines were invisible for the same reason the text was.
       THE RULE IS THEREFORE MEASURED TOO, at its own lower bar -- which is what lets it keep more saturation
       than the ink above it. */
    for (const [, hex] of LIVERIES) {
      expect(contrast(lift(hex, 40), LEDGER_PANEL)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("keeps the rule more saturated than the ink, or the two lifts had no reason to differ", () => {
    /* TWO PERCENTAGES ARE ONLY WORTH THE COMPLEXITY IF THEY LAND IN DIFFERENT PLACES. Asserted as an ordering
       rather than as a gap, so re-tuning either number is free until they cross. */
    for (const [, hex] of LIVERIES) {
      expect(relativeLuminance(lift(hex, 40))).toBeLessThan(relativeLuminance(lift(hex, 55)));
    }
  });
});

describe("the component uses the percentages this suite measured", () => {
  it("states both lifts as named constants", () => {
    expect(LEDGER).toContain("const LEDGER_INK_LIFT_PERCENT = 55;");
    expect(LEDGER).toContain("const LEDGER_RULE_LIFT_PERCENT = 40;");
  });

  it("mixes toward paper rather than toward a grey", () => {
    /* `desaturatedLiveryInk` WAS THE TEMPTING REUSE and leaves five of the eight under the bar, because a
       mid-grey is barely lighter than this ground. Named here so the next reader does not re-try it. */
    expect(LEDGER).toContain("CARD_SURFACE.slice(i, i + 2)");
    expect(LEDGER).not.toContain("desaturatedLiveryInk");
  });

  it("sends the lifted colours to the header and keeps one mixer", () => {
    expect(LEDGER).toContain("color: liveryInkOnPanel(company.company_id)");
    expect(LEDGER).toContain("borderBottomColor: liveryRuleOnPanel(company.company_id)");
    // One implementation, two thin wrappers -- so a third call site cannot invent a third mix.
    expect(LEDGER.split("function liftLivery").length - 1).toBe(1);
  });

  it("draws the ground it was measured against", () => {
    /* THE ASSERTION THE FIRST DRAFT OF THIS FILE NEEDED AND DID NOT HAVE. Every ratio above is against
       `INK_VIEWPORT`; if the ledger stops painting it, the numbers go back to describing a hypothetical. */
    expect(LEDGER).toContain("backgroundColor: INK_VIEWPORT");
  });

  it("leaves the token badge on the true livery", () => {
    /* THE LIFT IS FOR INK ON A DARK PANEL AND NOTHING ELSE. The badge further down is a FILLED swatch, where
       the livery is the background and `bestContrastTextColor` already answers the question -- lifting it
       would wash out the one place the colour is meant to be at full strength. */
    expect(LEDGER).toContain("backgroundColor: stationTickerColor(company.company_id)");
  });
});
