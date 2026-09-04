/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1117-1118 (harness): ONE GROUND, AND THE SEAM IT MADE SAFE
// ==================================================================
//
// REPORTED by eye and reported correctly: "the Stocks and Rail Map have a charcoal-coloured viewport
// background, but Auction and Game Ledger don't. I can't tell if the Stock Market doesn't have it or has a
// different charcoal from the rest."
//
// ALL THREE HALVES OF THAT SENTENCE WERE RIGHT. There were five treatments across the tabs, the Stock Market
// was the ambiguous one because it had the faintest fill AND no border to prove it was a surface, and three
// reference tabs had no ground at all.
//
// THIS FILE EXISTS BECAUSE THE VALUE IS COPIED INTO SEVEN FILES' WORTH OF CALL SITES and a shared colour that
// is retyped is a colour that drifts -- which is the entire history being corrected here. So the assertions
// are about the IMPORT as much as the value: each surface has to read `INK_VIEWPORT`, not match it.

export {};

const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
const { INK_VIEWPORT, INK_PANEL, INK_RAISED } =
  require("../styles/palette") as typeof import("../styles/palette");

/* Every tab that draws a viewport, named as the file that draws it. The Rail Map is in here too even though
   its ground is a canvas `fillStyle` rather than a CSS property -- it is the same surface to a player, and it
   is the call site most likely to be missed by a sweep of style objects. */
const SURFACES: Readonly<Record<string, string>> = {
  "Auction": "components/WaterfallAuctionDashboard.tsx",
  "Stocks": "components/StockRoundPanel.tsx",
  "Stock Market": "components/StockMarketRenderer.tsx",
  "Rail Map": "components/HexGridRenderer.tsx",
  "Game Ledger": "components/FinancialLedger.tsx",
  "Tiles": "components/TileReference.tsx",
  "Rules Reference": "components/RulesReference.tsx",
};

const APP_STYLES = readStripped("styles/appStyles.ts");

/* Design note #1151 superseded the SPELLING of the radius assertions in this file, not their claims. The app held twelve
   near-identical radii doing the work of one; they are three named steps now, so a case that pinned a pixel value was
   testing the literal rather than the property it stood for. Each reads the token it now is. */


function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const value = parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

describe("every tab stands on the same ground", () => {
  it("reads the token rather than matching it", () => {
    /* THE ASSERTION THAT ACTUALLY PREVENTS THE BUG. A file that happens to hardcode `#141414` passes any
       test about the colour and drifts the next time the token moves; a file that imports cannot. Reported as
       a list so a failure names the tab rather than the seventh assertion in a row. */
    const missing = Object.entries(SURFACES)
      .filter(([, path]) => !readStripped(path).includes("INK_VIEWPORT"))
      .map(([tab]) => tab);
    expect(missing).toEqual([]);
  });

  it("leaves no tab holding a private copy of a ground", () => {
    /* THE FIVE ORIGINAL VALUES, named so they cannot quietly come back. `#161616` is here because two wells
       inside the Stocks panel WERE that value: a well one step under the old `#1c1c1c` ground landed on top
       of the new one, and a well level with its floor is not a well. */
    const stale = Object.entries(SURFACES)
      .flatMap(([tab, path]) => {
        const source = readStripped(path);
        return ['"#0f0f0f"', '"#1c1c1c"', '"#161616"']
          .filter((hex) => source.includes(`backgroundColor: ${hex},\n  },`))
          .map((hex) => `${tab} root ${hex}`);
      });
    expect(stale).toEqual([]);
  });

  it("sits between the page and the raised step, using neither", () => {
    /* THE REASON IT IS `#141414` AND NOT EITHER NEIGHBOUR, as an ordering rather than as a hex. `INK_PANEL`
       is the tab strip's own fill, so a viewport wearing it welds the strip to the board -- which is what
       #1118 had to clear before the seam could close. `INK_RAISED` is what sits ON the viewport, and spending
       it as the ground leaves the controls nowhere to go. */
    expect(relativeLuminance(INK_VIEWPORT)).toBeGreaterThan(relativeLuminance(INK_PANEL));
    expect(relativeLuminance(INK_VIEWPORT)).toBeLessThan(relativeLuminance(INK_RAISED));
    expect(INK_VIEWPORT).not.toBe(INK_PANEL);
  });

  it("gives the three reference tabs an edge as well as a fill", () => {
    /* THE STOCK MARKET IS WHY THIS CASE EXISTS. It had a fill and no border and the report could not tell
       whether it had a viewport at all -- so a surface without an outline is only half of one, and the tabs
       that were given a ground were given a border with it. */
    for (const path of [
      "components/FinancialLedger.tsx",
      "components/TileReference.tsx",
      "components/RulesReference.tsx",
    ]) {
      const source = readStripped(path);
      expect(source).toContain('border: "1px solid #2a2a2a"');
      expect(source).toContain('borderRadius: RADIUS.card');
    }
  });
});

describe("the tabs meet their content", () => {
  it("closes the top edge and keeps the other three", () => {
    /* Design note #1118: only the TOP had a gap without a reason. The remaining inset is what keeps the
       panel's own border and radius off the window edge, so it is asserted rather than merely left alone. */
    expect(APP_STYLES).toContain('padding: "0 20px 20px"');
  });

  it("leaves #1084's gap alone, because it was never the one being asked about", () => {
    /* THE MISTAKE THIS CASE RECORDS IS MINE. The request to close the gap "between the tab navigation and the
       viewport content below it" was first answered by pointing at `mainTabBar`'s `marginTop` and calling it
       a conflict with #1084. That margin is on the OTHER SIDE of the strip -- it separates the action bar
       above from the tabs -- and closing it would have answered a question nobody asked while leaving the
       actual gap in place. It stays, and this asserts that it stays. */
    expect(APP_STYLES).toContain('marginTop: "10px"');
  });

  it("keeps a value step across the seam the two now share", () => {
    /* THE PRECONDITION FOR FLUSH, kept as a test because it is the whole argument. Flush against a viewport
       of the strip's own colour, #1084's "one welded assembly" is exactly what a reader would get; the step
       between INK_PANEL and INK_VIEWPORT is what makes touching edges read as attachment instead. If a future
       retone collapses that step, this fails BEFORE anyone notices the tabs have melted into the board. */
    expect(APP_STYLES).toContain('backgroundColor: "#0f0f0f"');
    expect(relativeLuminance(INK_VIEWPORT) - relativeLuminance(INK_PANEL)).toBeGreaterThan(0.002);
  });
});
