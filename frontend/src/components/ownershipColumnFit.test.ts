// frontend/src/components/ownershipColumnFit.test.ts
//
// ==================================================================
//  DESIGN NOTE 507 (harness): A TRACK NARROWER THAN ITS CONTENT
// ==================================================================
//
// REPORTED: on the Stocks tab a widening of the Shares column pushed Price
// right, clipping it at the edge of the card.
//
// The ownership table wrote its numeric column width twice -- once as a grid
// track (`46px`) and once as the cell's `minWidth` (`68px`) -- and design
// note #466 updated only the second. A grid item cannot shrink below its own
// `min-width` and a grid track does not clip what overflows it, so each
// numeric cell spilled 22px past its track and the rightmost column left the
// card.
//
// WHY THIS IS A SOURCE TEST. The failure is a RELATIONSHIP between two CSS
// declarations, and it is invisible from either one: 46px is a reasonable
// track and 68px is a correct minimum. jsdom does not lay out grid, so a
// render test cannot measure the overflow either -- it would report both
// elements at zero width and pass against the bug. What can be checked is
// that the two numbers are no longer two numbers.

import fs from "fs";
import path from "path";

const CARD = path.join(__dirname, "StockRoundPanel.tsx");
const SOURCE = fs.readFileSync(CARD, "utf8");
/* Comments discuss the old literals by name -- `46px` appears in the design
   note explaining why it was wrong. Same trap `corporationCardText.test.ts`
   documents, same subject: absence checks read the stripped copy. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the ownership table's numeric columns", () => {
  it("declares its width exactly once", () => {
    /* THE FIX. One constant, read by the track and by the cell, so "the
       track is at least as wide as its content requires" holds by
       construction rather than by two edits staying in step. */
    expect(CODE).toContain("const OWNERSHIP_NUM_WIDTH");
    expect(CODE).toMatch(/const OWNERSHIP_GRID = .*OWNERSHIP_NUM_WIDTH.*OWNERSHIP_NUM_WIDTH/);
  });

  it("builds both grid rows from that one constant", () => {
    // Header and body must agree, or the columns misalign even when neither
    // overflows.
    const uses = CODE.match(/gridTemplateColumns: OWNERSHIP_GRID/g) ?? [];
    expect(uses).toHaveLength(2);
  });

  it("sizes the cell from the same constant", () => {
    expect(CODE).toMatch(/minWidth: OWNERSHIP_NUM_WIDTH/);
  });

  it("no longer hardcodes a track narrower than the cell minimum", () => {
    /* The bug, stated as the thing that must not come back: a literal track
       width in the ownership grid is exactly how the two drifted apart. */
    expect(CODE).not.toMatch(/gridTemplateColumns: "minmax\(0, 1fr\) \d+px \d+px"/);
  });

  it("keeps the flexible column able to give up its space", () => {
    /* Where the width comes from, and the reason it can: `minmax(0, 1fr)`
       has a zero floor, so the Entity column yields rather than forcing the
       row wider than the card. A bare `1fr` is `minmax(auto, 1fr)` and would
       refuse to shrink below its own content -- reintroducing the overflow
       from the other side. */
    expect(CODE).toMatch(/OWNERSHIP_GRID = `minmax\(0, 1fr\)/);
  });
});
