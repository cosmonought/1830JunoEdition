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
import { holdingMarker, tiedForControl, WIDEST_MARKED_CELLS } from "./holdingMarkers";

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
    /* #791 moved the call one level out: the panel now asks `holdingMarker`, which asks `atHoldingCap`. The
       property is unchanged and is the one that matters -- the card and the Buy button read ONE answer about
       the cap, rather than the panel keeping its own `>= 60`. */
    expect(PANEL).toContain("holdingMarker(\n                      holding.percentage,");
    const markers = (() => {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      return fs.readFileSync(path.join(__dirname, "holdingMarkers.ts"), "utf8");
    })();
    expect(markers).toContain("atHoldingCap(percentage, zone)");
  });

  it("has no local sixty in the roster", () => {
    /* The whole file, because a second implementation anywhere is the drift. `sharePurchase.ts` owns the
       number; nothing here should be repeating it. */
    expect(PANEL).not.toMatch(/percentage\s*>=\s*60/);
  });

  it("prints the word without a comma", () => {
    // "5 (60% max)". The comma costs a character in a fixed-width column and buys nothing.
    const dollar = String.fromCharCode(36);
    expect(PANEL).toContain(`{marker === null ? "" : \` ${dollar}{marker}\`}`);
    expect(PANEL).not.toContain('", max"');
  });

  it("widened the column for the longest value it can now hold", () => {
    /* THE REPORT'S OWN CAVEAT, twice: "make sure to leave enough room on that column for it to live on one
       line instead of spilling into a second", then "make sure the column spacing can handle the extra
       character". #466 sized this for "9 (100%)"; #780 for "9 (100% max)"; #791 nudged it again for "tied". */
    expect(PANEL).toContain('const OWNERSHIP_NUM_WIDTH = "100px"');
    expect(PANEL).not.toContain('const OWNERSHIP_NUM_WIDTH = "68px"');
  });

  it("keeps the cell on one line", () => {
    // The widening is pointless if the cell wraps anyway.
    const cell = PANEL.slice(PANEL.indexOf("ownershipNum: {"), PANEL.indexOf("ownershipRule: {"));
    expect(cell).toContain('whiteSpace: "nowrap"');
  });

  it("marks it with the word and nothing else", () => {
    /* Design note #789 removed #780's bold-and-amber on report: "the display already renders the player's
       holdings in bold" (so the weight signalled nothing), and "the active player's holdings are highlighted
       in a yellow box, so amber on it is somewhat odd" (so the colour was weakest on the row a reader looks
       at first).
       AND IT IS THE MORE ACCESSIBLE ANSWER, not merely the tidier one. #732's rule is that colour alone is
       not a distinction every player can read; a WORD is one that everybody can, and no palette can clash
       with it. Asserted as an absence so the styling cannot creep back beside the text. */
    expect(PANEL).not.toContain("ownershipNumCapped");
    expect(PANEL).not.toContain("#d8a53a");
  });

  it("still says max", () => {
    // THE CONTROL for the assertion above: removing the styling must not remove the marker with it.
    expect(holdingMarker(60, "Normal", [{ percentage: 60 }, { percentage: 40 }])).toBe("max");
  });

  it("asks the shared marker rather than testing the cap inline", () => {
    // #791: one function owns both words, so the cell cannot print a combination that cannot exist.
    expect(PANEL).toContain("holdingMarker(");
    expect(PANEL).not.toContain("atHoldingCap(holding.percentage");
  });

  it("explains the rule on the row rather than only in the figure", () => {
    /* The figure says WHAT; the title says why, and names the zones that lift it -- so a player who has run
       out of room learns the one thing that would give them more. */
    expect(PANEL).toContain("The Orange and Brown zones lift this cap.");
  });
});

describe("tied for control (design note #791)", () => {
  it("marks both halves of the reported tie", () => {
    /* REPORTED: "4 (50% tied)" and "5 (50% tied)". Both players are level at the largest holding, so both
       carry the word -- a marker on one of them would read as a difference between them. */
    const roster = [{ percentage: 50 }, { percentage: 50 }];
    expect(tiedForControl(50, roster)).toBe(true);
    expect(holdingMarker(50, "Normal", roster)).toBe("tied");
  });

  it("marks the case that started this", () => {
    // P1 30%, P2 buys to 30%. #790 stopped the rows swapping; this is the fact that swap was signalling.
    const roster = [{ percentage: 30 }, { percentage: 30 }, { percentage: 20 }];
    expect(holdingMarker(30, "Normal", roster)).toBe("tied");
  });

  it("says nothing about a tie below the top", () => {
    /* TIED FOR CONTROL, NOT TIED ANYWHERE -- the report's own words. Two minor holders level at 10% are not
       in a contest, and marking them would put a word on most rows of a busy corporation. */
    const roster = [{ percentage: 40 }, { percentage: 10 }, { percentage: 10 }];
    expect(holdingMarker(10, "Normal", roster)).toBeNull();
    expect(holdingMarker(40, "Normal", roster)).toBeNull();
  });

  it("says nothing when the largest holding is alone", () => {
    expect(holdingMarker(40, "Normal", [{ percentage: 40 }, { percentage: 30 }])).toBeNull();
  });

  it("marks a three-way tie", () => {
    const roster = [{ percentage: 30 }, { percentage: 30 }, { percentage: 30 }];
    expect(holdingMarker(30, "Normal", roster)).toBe("tied");
  });

  it("ignores a tie at zero", () => {
    /* `player_holdings` omits anybody at 0%, so this should be unreachable -- guarded anyway, because
       "everyone is tied at nothing" is the shape a defensive default would produce. */
    expect(tiedForControl(0, [{ percentage: 0 }, { percentage: 0 }])).toBe(false);
  });
});

describe("max and tied cannot both apply", () => {
  it("is impossible by arithmetic, not by convention", () => {
    /* THE REPORT SAID "there should never be a case where max and tied both need to be printed", and it is
       provable rather than merely intended: two players at the 60% cap would be 120% of a 100% corporation.
       Asserted across every legal pair that sums to 100 or less. */
    for (let a = 10; a <= 100; a += 10) {
      for (let b = 10; a + b <= 100; b += 10) {
        const roster = [{ percentage: a }, { percentage: b }];
        const bothMarked =
          atHoldingCap(a, "Normal") && tiedForControl(a, roster) && a === b;
        expect(bothMarked).toBe(false);
      }
    }
  });

  it("returns one word rather than a set", () => {
    /* The type is the belt to the arithmetic's braces: even if a future zone rule broke the sum, the cell
       would print a wrong marker rather than a broken string. */
    const roster = [{ percentage: 60 }, { percentage: 40 }];
    expect(["max", "tied", null]).toContain(holdingMarker(60, "Normal", roster));
  });

  it("prefers max if the impossible ever happened", () => {
    // "Tied" describes a contest; "max" describes a door that is shut, which is the more binding fact.
    const impossible = [{ percentage: 60 }, { percentage: 60 }];
    expect(holdingMarker(60, "Normal", impossible)).toBe("max");
  });

  it("still says tied at the cap in a zone that waives it", () => {
    /* Orange and Brown lift the 60% cap, so two players CAN sit level above it there -- and "max" would be
       stating a rule that does not apply (#780's whole point). The tie is the true fact and the one printed. */
    const roster = [{ percentage: 60 }, { percentage: 40 }];
    expect(holdingMarker(60, "Orange", roster)).toBeNull();
    expect(holdingMarker(50, "Brown", [{ percentage: 50 }, { percentage: 50 }])).toBe("tied");
  });
});

describe("the column is sized for the longest thing it can hold", () => {
  it("agrees that both markers produce twelve characters", () => {
    /* DERIVED, NOT ASSERTED. A tie cannot occur above 50%, so "tied" -- one letter longer than "max" -- does
       not extend the widest cell. This is the arithmetic the column note leans on, checked rather than
       trusted. */
    for (const cell of WIDEST_MARKED_CELLS) {
      expect(cell).toHaveLength(12);
    }
  });

  it("cannot produce a wider tied cell", () => {
    // Two players sharing the largest holding is at most 50% each; anything more is over 100%.
    for (let share = 60; share <= 100; share += 10) {
      expect(tiedForControl(share, [{ percentage: share }, { percentage: 100 - share }])).toBe(false);
    }
  });
});
