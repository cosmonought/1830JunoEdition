/** @jest-environment node */

// No runtime imports: the lookup is reproduced here and the rest is source text.
export {};
//
// "Next" on the Later trains accordion means the row after the one you can buy.
//
// ==================================================================
//  DESIGN NOTE 798 (harness): THE FIRST ROW IS NOT THE NEXT ROW
// ==================================================================
//
// REPORTED: "The 'Later trains' accordion: at flush right it says 'next:' but for me it is wrong.
// Corporations own 3-trains and it says 'next: 2-train ($80)'."
//
// TWO JOBS, ONE ARRAY. `laterTiers` is the depot minus the purchasable tier, and #633 chose that on purpose:
// "rusted tiers go with the later ones rather than being dropped: a 2-train that has left play is still the
// reason the board looks the way it does." Correct for the LIST behind the caret. But it leaves the earliest
// tier at index 0, so the collapsed summary -- which read `laterTiers[0]` -- named the oldest train in the
// game and called it next.
//
// THE FIX IS POSITIONAL AND THAT IS THE POINT. The depot is ordered cheapest-first and sells in that order,
// so "the row after this one" is what "next" means, and the caption never has to reason about rusting or
// phases to stay right.
//
// TESTED AS A LOOKUP because that is the whole change: pure, and a jsdom-free test can cover the boundaries
// -- the last tier, an empty depot, a tier that is not in the list -- more thoroughly than a rendered
// fixture could.

interface Tier {
  tier: string;
  cost: number;
  remaining: number | null;
}

/** The panel's lookup, reproduced. The source scan at the bottom keeps the two honest. */
const upcoming = (depot: Tier[], nextTier: Tier | null): Tier | null => {
  if (nextTier === null) return null;
  const at = depot.findIndex((row) => row.tier === nextTier.tier);
  return at === -1 ? null : (depot[at + 1] ?? null);
};

/** The purchasable tier, exactly as the panel computes it: cheapest with stock. */
const purchasable = (depot: Tier[]): Tier | null =>
  depot.find((row) => row.remaining === null || row.remaining > 0) ?? null;

/** A Phase 3 depot: the 2s are gone, 3s are on sale, everything above is waiting. */
const PHASE_THREE: Tier[] = [
  { tier: "2", cost: 80, remaining: 0 },
  { tier: "3", cost: 180, remaining: 4 },
  { tier: "4", cost: 300, remaining: 3 },
  { tier: "5", cost: 450, remaining: 2 },
  { tier: "6", cost: 630, remaining: 2 },
  { tier: "D", cost: 1100, remaining: 6 },
];

describe("the reported board", () => {
  it("offers the 3-train and names the 4-train as next", () => {
    /* THE REPORT, inverted into the right answer. The caption said "2-train $80" -- a tier with nothing left
       in it, two steps behind what the corporation could buy. */
    const next = purchasable(PHASE_THREE);
    expect(next?.tier).toBe("3");
    expect(upcoming(PHASE_THREE, next)).toMatchObject({ tier: "4", cost: 300 });
  });

  it("never names a sold-out tier", () => {
    /* The specific failure. A tier at `remaining: 0` is behind the depot's cursor and cannot be "next" by
       any reading. */
    const named = upcoming(PHASE_THREE, purchasable(PHASE_THREE));
    expect(named?.remaining).not.toBe(0);
  });

  it("never names the tier already on sale", () => {
    // That row is the main buy button a few pixels above; repeating it as "next" says nothing.
    const next = purchasable(PHASE_THREE);
    expect(upcoming(PHASE_THREE, next)?.tier).not.toBe(next?.tier);
  });
});

describe("the boundaries", () => {
  it("says nothing when the purchasable tier is the last one", () => {
    /* Diesels. `null` rather than wrapping to the front of the list, which is precisely the bug being
       replaced -- an index that runs off the end must not become an index at the start. */
    const diesels: Tier[] = [
      { tier: "6", cost: 630, remaining: 0 },
      { tier: "D", cost: 1100, remaining: 6 },
    ];
    expect(upcoming(diesels, purchasable(diesels))).toBeNull();
  });

  it("says nothing when there is nothing to buy", () => {
    // #633's "no available tier is a real state": every tier sold out.
    const empty: Tier[] = [{ tier: "D", cost: 1100, remaining: 0 }];
    expect(purchasable(empty)).toBeNull();
    expect(upcoming(empty, null)).toBeNull();
  });

  it("says nothing for a tier that is not in the depot", () => {
    // Defensive, and it is the case that would otherwise return `depot[0]` via a -1 index.
    expect(upcoming(PHASE_THREE, { tier: "Z", cost: 1, remaining: 1 })).toBeNull();
  });

  it("treats an unlimited tier as purchasable", () => {
    // `remaining: null` means no cap -- the Diesel row. It must not be skipped when looking for the seller.
    const unlimited: Tier[] = [
      { tier: "6", cost: 630, remaining: 0 },
      { tier: "D", cost: 1100, remaining: null },
    ];
    expect(purchasable(unlimited)?.tier).toBe("D");
  });

  it("walks a first-turn depot correctly", () => {
    // Phase 2, nothing sold: the 2-train is on offer and the 3-train is next.
    const fresh: Tier[] = [
      { tier: "2", cost: 80, remaining: 6 },
      { tier: "3", cost: 180, remaining: 5 },
    ];
    expect(upcoming(fresh, purchasable(fresh))).toMatchObject({ tier: "3" });
  });
});

describe("the panel is wired to it", () => {
  const PANEL = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(
      path.join(__dirname, "..", "components", "TrainPurchasePanel.tsx"),
      "utf8",
    );
  })();
  const CODE = PANEL.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("has the positional lookup", () => {
    expect(CODE).toContain("const at = depot.findIndex((row) => row.tier === nextTier.tier);");
    expect(CODE).toContain("depot[at + 1] ?? null");
  });

  it("captions from it rather than from the list", () => {
    expect(CODE).toContain("upcomingTier");
    const dollar = String.fromCharCode(36);
    expect(CODE).not.toContain("`next: " + dollar + "{laterTiers[0].tier}");
  });

  it("keeps the list showing everything else", () => {
    /* #633's choice, untouched: a rusted 2-train behind the caret is context worth having. This pass changed
       the CAPTION's source, not the accordion's contents. */
    expect(CODE).toContain("depot.filter((row) => row.tier !== nextTier.tier)");
    expect(CODE).toContain("laterTiers.map((tier) => (");
  });
});
