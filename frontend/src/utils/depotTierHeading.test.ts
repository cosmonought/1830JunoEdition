/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1007 (harness): THE HEADING NAMES THE TIER, AND "D" IS NOT A NUMBER
// ==================================================================
//
// REPORTED: "The current subpanel header reads statically as 'Buy Trains from the Bank Depot'. Update this
// string to dynamically inject the name/type of the current cheapest available train in the depot ...
// 'Buy 3-Trains from the Bank Depot' or 'Buy Diesels from the Bank Depot'."
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

  it("names the last tier a Diesel", () => {
    /* THE WHOLE REASON THIS IS A FUNCTION. `${tier}-Train` is correct for five of the six tiers, which is why
       roughly twenty sites in this app do exactly that and why the sixth went unnoticed: "D-train" is
       readable, so it never looked like a bug, it looked like a label. */
    expect(trainTierName("D")).toBe("Diesel");
    expect(trainTierNamePlural("D")).toBe("Diesels");
  });

  it("never says D-Train for any tier the game has", () => {
    /* ASKED OVER `TIER_ORDER` RATHER THAN OVER A LIST TYPED HERE, so a seventh tier added to the game is
       covered by this file the day it exists rather than the day somebody remembers to widen the test. */
    for (const tier of TIER_ORDER) {
      expect(trainTierName(tier)).not.toBe("D-Train");
      expect(trainTierNamePlural(tier)).not.toBe("D-Trains");
    }
  });

  it("keeps the plural exactly one letter from the singular", () => {
    /* THE PROPERTY, NOT SIX MORE LITERALS. Stated this way because the singular is the form that composes
       with `countPhrase`, and a plural that drifted from it -- "Dieselss", or a special case for one tier --
       would put two spellings of one train in front of the same player. */
    for (const tier of TIER_ORDER) {
      expect(trainTierNamePlural(tier)).toBe(`${trainTierName(tier)}s`);
    }
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

  it("leaves the twenty other sites alone, and says so", () => {
    /* SCOPE, PINNED. `trainTierName` is the rule for every "n-train" phrase in the app and this batch changed
       ONE caller. That is a deliberate limit rather than an oversight, so the note has to say it -- otherwise
       the next reader finds a helper with one caller and reasonably concludes it was abandoned.
       This assertion is what makes the limit visible in the test run rather than only in a comment. */
    // `readSource` resolves from `src/`, not from this file -- #886's one reader, one root.
    const RAW = readSource("utils/gamePhase.ts");
    expect(RAW).toContain("converted as they are touched rather than in one sweep");
  });
});
