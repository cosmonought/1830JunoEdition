/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1007 (harness): THE HEADING NAMES THE TIER, AND EVERY TIER IS NAMED THE SAME WAY
// ==================================================================
//
// REPORTED: "The current subpanel header reads statically as 'Buy Trains from the Bank Depot'. Update this
// string to dynamically inject the name/type of the current cheapest available train in the depot ...
// 'Buy 3-Trains from the Bank Depot' or 'Buy Diesels from the Bank Depot'."
//
// THIS FILE'S FIRST DRAFT ASSERTED THE OPPOSITE OF WHAT IT NOW ASSERTS, and the reversal is left visible
// because a harness that quietly flips is a harness nobody can trust. It required `trainTierName("D")` to be
// "Diesel" and carried a case titled "never says D-Train for any tier the game has" -- written to enforce a
// claim I had made without checking, that "D-train" is not real usage. It is: the player who plays these games
// pushed back, and they are right. The spec sentence above is quoted unchanged, because it is what was asked
// for at the time and the change of mind belongs on the record next to it.
//
// WHAT THE FILE IS FOR DID NOT CHANGE. The bug was ever only that two surfaces spelled one train two ways.
//
// TWO ASSERTIONS OF DIFFERENT KINDS, and the split is deliberate. The NAMING is a pure function and is tested
// as one -- called, with its answers compared -- because that is the half where "D-Trains" would be wrong and
// no amount of reading source text would say so. The WIRING is a source scan, because this repo has no
// component renderer: there is no `@testing-library/react` in the tree and no suite anywhere renders JSX, so
// the strongest available claim about the heading is what the file says it renders.
//
// WHICH IS WORTH BEING HONEST ABOUT: a scan cannot prove the string reaches the screen. What it CAN do is
// pin the two things that would silently make it wrong -- the heading calling the helper rather than
// interpolating the bare tier, and the fallback surviving an empty depot -- and the pure tests cover
// everything the helper decides. The gap is the JSX itself, and it is the same gap every other UI assertion
// in this repo has.

import { TIER_ORDER, trainTierName, trainTierNamePlural } from "./gamePhase";
import { readSource, readStripped, sliceBetween } from "./sourceScan";

describe("a tier is named the way a player says it", () => {
  it("names the numbered tiers by their number", () => {
    expect(trainTierName("2")).toBe("2-Train");
    expect(trainTierName("3")).toBe("3-Train");
    expect(trainTierNamePlural("3")).toBe("3-Trains");
    expect(trainTierNamePlural("6")).toBe("6-Trains");
  });

  it("names the last tier by its symbol, like every other tier", () => {
    /* THE REVERSED CASE. It read `expect(trainTierName("D")).toBe("Diesel")` and was titled "names the last
       tier a Diesel". "D-Train" is ordinary 18xx usage, so there was never a correctness argument for the
       special case -- only a preference I had presented as one. */
    expect(trainTierName("D")).toBe("D-Train");
    expect(trainTierNamePlural("D")).toBe("D-Trains");
  });

  it("special-cases no tier at all", () => {
    /* ASKED OVER `TIER_ORDER` RATHER THAN OVER A LIST TYPED HERE, so a seventh tier added to the game is
       covered by this file the day it exists rather than the day somebody remembers to widen the test.
       THIS IS THE CASE THAT REPLACES "never says D-Train", and it is a stronger claim than either spelling:
       whatever the naming rule is, it is the SAME rule for every tier. A future change back to "Diesel" would
       have to fail this deliberately rather than slip past it. */
    for (const tier of TIER_ORDER) {
      expect(trainTierName(tier)).toBe(`${tier}-Train`);
    }
  });

  it("keeps the plural exactly one letter from the singular", () => {
    /* THE PROPERTY, NOT SIX MORE LITERALS. Stated this way because the singular is the form that composes
       with `countPhrase`, and a plural that drifted from it -- "D-Trainss", or a special case for one tier --
       would put two spellings of one train in front of the same player. */
    for (const tier of TIER_ORDER) {
      expect(trainTierNamePlural(tier)).toBe(`${trainTierName(tier)}s`);
    }
  });

  it("leaves the rust badge asking the same function", () => {
    /* THE SITE WHERE "Diesel" ENTERED THE TREE. `TrainBadges.tsx` carried `trigger === "D" ? "Diesel" : ...`
       inline since v1.0alpha; every other surface spelling it that way was copying this line. An inline
       ternary restored here would put two spellings back in front of one player -- which is the entire defect
       -- and no assertion about the helper alone would notice. */
    const BADGES = readStripped("components/TrainBadges.tsx");
    expect(BADGES).toContain("const triggerName = trainTierName(trigger);");
    expect(BADGES).not.toContain('trigger === "D" ? "Diesel"');
  });

  it("leaves the depot's stock readout asking it too", () => {
    /* THE OTHER HALF OF THE SAME PANEL. The heading below was converted in Batch 30; the tooltip a few lines
       under it still said "Diesels are unlimited" and interpolated a bare `${tier}-train` on the other branch
       -- one panel, three spellings, which is how this defect stays alive after a fix. */
    const PANEL_RAW = readStripped("components/TrainPurchasePanel.tsx");
    expect(PANEL_RAW).toContain("trainTierNamePlural(nextTier.tier)} are unlimited");
    expect(PANEL_RAW).not.toContain('"Diesels are unlimited');
  });
});

describe("the depot heading is wired to the tier actually for sale", () => {
  /* Sliced to the heading itself. The panel says "from the Bank" in several other places and an unbounded
     scan would be satisfied by any of them -- #886's point about a bounded slice, and `sliceBetween` throws
     rather than returning "" if either anchor moves. */
  const PANEL = readStripped("components/TrainPurchasePanel.tsx");
  const HEADING = sliceBetween(PANEL, "<div style={styles.sectionHeading}>", "</div>");

  it("interpolates the tier instead of stating a category", () => {
    expect(HEADING).toContain("trainTierNamePlural(nextTier.tier)");
    expect(HEADING).toContain("from the Bank Depot");
  });

  it("reads the depot's own queue rather than finding the cheapest tier again", () => {
    /* `nextTier` IS App.tsx #182's ANSWER, applied once by `depotInventory` and read by everything on this
       panel. A heading that ran its own `find` over `depot` would be a second derivation of the same rule --
       and the failure would be a title naming a train the button underneath it will not sell. */
    expect(HEADING).toContain("nextTier");
    expect(HEADING).not.toContain("depot.find");
    expect(HEADING).not.toMatch(/depot\s*\[/);
  });

  it("does not interpolate the bare tier", () => {
    /* THE MUTATION THIS FILE EXISTS TO CATCH. `Buy {nextTier.tier}-Trains` satisfies the report's example
       exactly -- it produces "Buy 3-Trains from the Bank Depot" -- and produces "Buy D-Trains" the moment the
       game reaches its last phase, which is the one case the report named explicitly. */
    expect(HEADING).not.toContain("nextTier.tier}-Train");
    expect(HEADING).not.toContain("nextTier.tier}-train");
  });

  it("keeps the old words when the depot has nothing left to sell", () => {
    /* `nextTier` IS `null` AT THE END OF THE GAME and the body below already branches on it to render the
       sold-out notice instead of the buy row. A heading naming a tier there would contradict the sentence
       directly under it, and "Buy null-Trains" is worse than the static string this replaced. */
    expect(HEADING).toContain('"Trains"');
    expect(HEADING).toContain("nextTier ?");
  });
});

describe("the note and the code agree", () => {
  it("records why the empty depot keeps a static heading", () => {
    /* #490a: the claim is asserted against RAW text, because a stripped copy has no notes in it -- and this
       codebase's signature failure is a note describing an intention the code does not carry out. */
    const RAW = readSource("components/TrainPurchasePanel.tsx");
    expect(RAW).toContain("DESIGN NOTE 1007");
    expect(RAW).toContain("THE EMPTY DEPOT KEEPS THE OLD WORDS");
  });

  it("draws the scope line at the phase, and says so", () => {
    /* SCOPE, PINNED -- AND REDRAWN. This case used to assert the note said the other sites were "converted as
       they are touched rather than in one sweep", which was true while the sweep was an open question. It is
       decided now, so the sentence it guarded is gone and this guards the boundary that replaced it.
       THE BOUNDARY IS TRAIN VERSUS PHASE. "Diesel Era" and "Phase D (Diesel)" name a phase of 1830, which is
       what the game itself calls it, and the tutorial's "2, 3, 4, 5, 6, and Diesel" is prose about capacity.
       None of those names a train a corporation buys. A later sweep that took "Diesel" out of the phase labels
       on a grep would be reading this rule as a spelling ban, which it is not -- so the reason is in the note
       and this is what makes it visible in a test run. */
    // `readSource` resolves from `src/`, not from this file -- #886's one reader, one root.
    const RAW = readSource("utils/gamePhase.ts");
    expect(RAW).toContain("THE PHASE IS NOT THE TRAIN");
    // And the phase labels themselves still say it, which is the fact the note is defending.
    expect(readStripped("utils/gamePhase.ts")).toContain('"Phase D (Diesel)"');
    expect(readStripped("utils/depotSchedule.ts")).toContain('phase: "Diesel Era"');
  });
});
