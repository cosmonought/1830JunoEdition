/** @jest-environment node */
//
// The corporation card says when a player has run out of room. No React.
//
// ==================================================================
//  DESIGN NOTE 780 (harness): THE RULE WAS ONLY IN A TOOLTIP
// ==================================================================
//
// REPORTED: "in addition to disabling the Buy button, I wonder if we could somehow indicate it on the
// corporation card ... that shares column entry reads '5 (60%, max)'" -- after a purchase was refused at the
// cap with nothing on screen saying why.
//
// A DISABLED BUTTON IS A REFUSAL WITH NO REASON unless you hover it, and hovering does not exist on a
// tablet. #712 wrote the reason and #681 put it in the `title`; both were right and neither reaches a player
// who is looking at the roster rather than at the button.
//
// THE PREDICATE IS SHARED, WHICH IS THE POINT. `atHoldingCap` sits in `sharePurchase.ts` beside the rule
// that refuses the purchase, so the card and the Buy button read one answer. A local `percentage >= 60` in
// the panel would have been three lines and would have produced the specific, ugly failure this project
// keeps meeting: a roster reading "60% max" beside a button that correctly allows the buy.
//
// AND THE ZONE IS THE WHOLE DIFFICULTY. Orange and Brown lift this cap. "Max" printed there states a rule
// that does not apply, and a player who believes it stops trying -- worse than silence.

import { atHoldingCap } from "./sharePurchase";

describe("the cap applies where the cap applies", () => {
  it("marks a player at 60% in an ordinary zone", () => {
    expect(atHoldingCap(60, "Normal")).toBe(true);
  });

  it("says nothing at 50%", () => {
    expect(atHoldingCap(50, "Normal")).toBe(false);
  });

  it("marks a holding above the cap too", () => {
    /* Reachable: a player can carry 70% out of the Orange zone when the price falls back. The board is then
       legal and frozen, and "max" is the honest word for it. */
    expect(atHoldingCap(70, "Normal")).toBe(true);
  });

  it("is silent in Orange and Brown", () => {
    /* THE CASE THAT MAKES THIS A RULE RATHER THAN A COMPARISON. Both zones waive the 60% cap, so a player
       there is not at any maximum and printing one would send them away from a legal purchase. */
    expect(atHoldingCap(60, "Orange")).toBe(false);
    expect(atHoldingCap(90, "Brown")).toBe(false);
  });

  it("still applies in Yellow", () => {
    /* Yellow exempts certificates from the LIMIT and does not touch the 60% cap. The two rules are easy to
       conflate -- an earlier pass conflated them -- so this is pinned separately. */
    expect(atHoldingCap(60, "Yellow")).toBe(true);
  });

  it("applies when there is no zone at all", () => {
    // An unfloated corporation has no market price and therefore no waiver.
    expect(atHoldingCap(60, null)).toBe(true);
  });
});

describe("the card is wired to the shared rule", () => {
  const PANEL = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(
      path.join(__dirname, "..", "components", "StockRoundPanel.tsx"),
      "utf8",
    );
    // #490a: the notes quote the rejected `>= 60` while explaining why it is not there.
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  })();

  it("asks the shared predicate", () => {
    expect(PANEL).toContain("atHoldingCap(holding.percentage, marketZoneForPrice(market))");
  });

  it("has no local sixty in the roster", () => {
    /* The whole file, because a second implementation anywhere is the drift. `sharePurchase.ts` owns the
       number; nothing here should be repeating it. */
    expect(PANEL).not.toMatch(/percentage\s*>=\s*60/);
  });

  it("prints the word without a comma", () => {
    // "5 (60% max)". The comma costs a character in a fixed-width column and buys nothing.
    expect(PANEL).toContain('{capped ? " max" : ""}');
    expect(PANEL).not.toContain('", max"');
  });

  it("widened the column for the longest value it can now hold", () => {
    /* THE REPORT'S OWN CAVEAT: "make sure to leave enough room on that column for it to live on one line
       instead of spilling into a second". "9 (100% max)" is four characters longer than the value #466 sized
       this for. */
    expect(PANEL).toContain('const OWNERSHIP_NUM_WIDTH = "92px"');
    expect(PANEL).not.toContain('const OWNERSHIP_NUM_WIDTH = "68px"');
  });

  it("keeps the cell on one line", () => {
    // The widening is pointless if the cell wraps anyway.
    const cell = PANEL.slice(PANEL.indexOf("ownershipNum: {"), PANEL.indexOf("ownershipRule: {"));
    expect(cell).toContain('whiteSpace: "nowrap"');
  });

  it("marks it by weight as well as by colour", () => {
    // #732: colour alone is not a distinction every player can read.
    expect(PANEL).toContain("ownershipNumCapped: { fontWeight: 800");
  });

  it("explains the rule on the row rather than only in the figure", () => {
    /* The figure says WHAT; the title says why, and names the zones that lift it -- so a player who has run
       out of room learns the one thing that would give them more. */
    expect(PANEL).toContain("The Orange and Brown zones lift this cap.");
  });
});
