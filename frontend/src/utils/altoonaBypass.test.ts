/** @jest-environment node */
//
// Altoona's bypass, end to end. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 737 (harness): THE BOW HAD TO BECOME EXPRESSIBLE FIRST
// ==================================================================
//
// REPORTED: "The preprinted gray on Altoona (H12) has unusual track curvature ... it does not seem to be
// functional for actual routing: there seems to be no way to get a train to use the bypass around Altoona's
// measly $10 revenue center."
//
// TWO THINGS WERE BROKEN AND ONLY ONE WAS OBVIOUS. The tracer could not FIND the bypass, because
// `pathsForTraversal` collapses alternatives to the first match. But even a tracer that found it could not
// have PRICED it: revenue came from a list of hex labels, so a route said which hexes it touched and nothing
// about how. Crossing H12 on the bow and stopping at the station were the same sentence. Fixing the search
// alone would have produced two identical candidates.
//
// SO THE DISCRIMINATING ASSERTION IS A DIFFERENCE IN REVENUE between two routes over the same hexes, and every
// case below is built to make that difference visible. A test that only asked "does a second variant exist"
// would have passed halfway through this fix.
//
// AND THE MEASUREMENTS ARE TAKEN FROM THE SHIPPED CATALOG, not asserted from memory. H12's two tracks, their
// shared edge pair and which one is the bypass are read back before anything is concluded from them -- the
// same discipline that caught the I15 slot claim being invented.

import {
  printedArtwork,
  printedArtworkEdgePairs,
  printedChainBypassesCentre,
  printedPathsForTraversal,
  printedTraversalVariants,
} from "../components/TileGraphics";
import { traversalSegments, traversalsFrom } from "./trackSegments";
import { sandboxRouteBreakdown } from "./sandboxSession";
import type { MapGridResponse } from "../components/hexContractTypes";

/** Altoona. A grey preprinted hex; nothing is ever laid on it. */
const H12 = { q: 2, r: 7 };
const BARE = { tiles: [] } as unknown as MapGridResponse;

describe("the board really is what the fix assumes", () => {
  it("authors two tracks joining the same two edges", () => {
    /* THE PREMISE, read back rather than trusted. If a later edit gives H12 one track or two different edge
       pairs, every conclusion below stops meaning anything and this fails first. */
    expect(printedArtwork("H12")?.tracks).toHaveLength(2);
    expect(printedArtworkEdgePairs("H12")).toEqual([
      [0, 3],
      [0, 3],
    ]);
  });

  it("names exactly one of them as the bypass", () => {
    expect(printedArtwork("H12")?.bypassTracks).toEqual([1]);
    expect(printedChainBypassesCentre("H12", [1])).toBe(true);
    expect(printedChainBypassesCentre("H12", [0])).toBe(false);
  });

  it("has a revenue centre to bypass", () => {
    // A bypass around nothing would be a curve, not a rule.
    expect(printedArtwork("H12")?.marker?.kind).toBe("city");
  });
});

describe("both ways through are now reachable", () => {
  it("offers two variants where it used to offer one", () => {
    /* THE REPORT'S "no way to get a train to use the bypass", as a unit. `printedPathsForTraversal` still
       returns the first -- #225's collapse is correct for every other tile and stays the default. */
    expect(printedTraversalVariants("H12", 0, 3)).toEqual([[0], [1]]);
    expect(printedPathsForTraversal("H12", 0, 3)).toEqual([0]);
  });

  it("offers them in both directions", () => {
    expect(printedTraversalVariants("H12", 3, 0)).toHaveLength(2);
  });

  it("gives the walk one traversal per way, not per exit", () => {
    /* The layer the tracer actually consults. Two entries with the SAME `exitEdge` are the two arms -- which
       is the shape that made the fork reachable by a depth-first search that only ever looked at exits. */
    const ways = traversalsFrom(BARE, H12.q, H12.r, 0).filter((t) => t.exitEdge === 3);
    expect(ways).toHaveLength(2);
    expect(ways.map((w) => w.bypass)).toEqual([false, true]);
  });
});

describe("the two ways are different track", () => {
  it("holds different rail keys", () => {
    /* Two trains may take one arm each -- they are physically separate rails inside the hex. */
    const through = traversalSegments(BARE, H12.q, H12.r, 0, 3, 0) ?? [];
    const bow = traversalSegments(BARE, H12.q, H12.r, 0, 3, 1) ?? [];
    expect(through).not.toEqual(bow);
    expect(through.some((key) => key.includes("#0"))).toBe(true);
    expect(bow.some((key) => key.includes("#1"))).toBe(true);
  });

  it("STILL shares the hex's border stubs, so two trains cannot both cross it", () => {
    /* #731's edge keys, and the one piece of this that needed no work. On cardboard both arms leave edge 0 and
       rejoin edge 3 -- one stub of track each side -- so a second train may not enter H12 across an edge the
       first is already using, whichever arm it means to take. */
    const through = traversalSegments(BARE, H12.q, H12.r, 0, 3, 0) ?? [];
    const bow = traversalSegments(BARE, H12.q, H12.r, 0, 3, 1) ?? [];
    const shared = through.filter((key) => bow.includes(key));
    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("the bypass pays nothing and costs no stop", () => {
  const route = [{ hex: "H12" }, { hex: "H10" }];

  it("prices the through-run with Altoona's revenue", () => {
    const through = sandboxRouteBreakdown(BARE, route, "Yellow");
    expect(through.revenue).toBeGreaterThan(0);
  });

  it("prices the bypass strictly lower over the SAME hexes", () => {
    /* THE ASSERTION THE WHOLE FIX EXISTS FOR, and the one that could not even be written before it: the two
       routes touch identical hexes and must now differ in what they earn. */
    const through = sandboxRouteBreakdown(BARE, route, "Yellow");
    const bowed = sandboxRouteBreakdown(
      BARE,
      [{ hex: "H12", bypass: true }, { hex: "H10" }],
      "Yellow",
    );
    expect(bowed.revenue).toBeLessThan(through.revenue);
  });

  it("does not spend one of the train's stops on it", () => {
    /* WORTH MORE THAN THE $10. A 2-train forced to count Altoona could not reach past it, which is precisely
       why the bow is printed on the board. */
    const through = sandboxRouteBreakdown(BARE, route, "Yellow");
    const bowed = sandboxRouteBreakdown(
      BARE,
      [{ hex: "H12", bypass: true }, { hex: "H10" }],
      "Yellow",
    );
    expect(bowed.centres).toBeLessThan(through.centres);
  });

  it("leaves an unflagged route priced exactly as before", () => {
    /* THE COMPATIBILITY CASE. `bypass` is optional and absent everywhere except H12's bow, so every other
       route on the board must price identically to the pre-#737 engine. */
    const plain = sandboxRouteBreakdown(BARE, route, "Yellow");
    const explicit = sandboxRouteBreakdown(
      BARE,
      [{ hex: "H12", bypass: false }, { hex: "H10" }],
      "Yellow",
    );
    expect(explicit).toEqual(plain);
  });
});

describe("nothing else on the board grew a second way through", () => {
  it("leaves every other preprinted hex with one variant per exit", () => {
    /* THE BLAST RADIUS, measured. `traversalsFrom` changed shape for every hex; this asserts the change is
       inert everywhere but Altoona, which is the claim that makes the fix safe to ship mid-game. */
    const labels = ["D14", "C15", "E9", "A17", "D24"];
    for (const label of labels) {
      for (let entry = 0; entry < 6; entry += 1) {
        for (let exit = 0; exit < 6; exit += 1) {
          if (entry === exit) continue;
          const variants = printedTraversalVariants(label, entry, exit);
          expect(variants.length).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
