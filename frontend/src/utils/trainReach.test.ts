/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 881 (harness): FOUR ANSWERS TO ONE QUESTION
// ==================================================================
//
// FOUND BY AUDIT, not by report. Four places decided how far a train may run and no two agreed: the click
// path had no Diesel sentinel, the draft flag tested `!== 999` where the auto-tracer tested `>= 999`, and an
// unknown train was worth 2 stops to one, 4 to another and infinity to a third.
//
// THE DIESEL CASE IS UNREACHABLE IN PLAY -- nobody clicks a thousand hexes -- which is exactly why it
// survived, and why it is the first test here rather than a footnote.

import { UNLIMITED_REACH, isUnlimitedReach, overrunsReach, reachForDrafting } from "./trainReach";
import { SMALLEST_TRAIN_CAPACITY } from "./gameConstants";

describe("the Diesel is unlimited, whoever asks", () => {
  it("never overruns", () => {
    expect(overrunsReach(1000, UNLIMITED_REACH)).toBe(false);
    expect(overrunsReach(1, UNLIMITED_REACH)).toBe(false);
  });

  it("recognises a bigger sentinel too", () => {
    /* `>=`, NOT `===`. The catalog writes exactly 999 today; a table that ever wrote 1000 to mean the same
       thing would have been flagged over-long by the equality test and treated as unlimited by the other --
       which is precisely the disagreement this module was built to end. */
    expect(isUnlimitedReach(1000)).toBe(true);
    expect(overrunsReach(5000, 1000)).toBe(false);
  });

  it("does not mistake a real train for one", () => {
    expect(isUnlimitedReach(6)).toBe(false);
    expect(overrunsReach(7, 6)).toBe(true);
    expect(overrunsReach(6, 6)).toBe(false);
  });
});

describe("an unknown train is read two ways, on purpose", () => {
  it("is unlimited when deciding what a player may DRAW", () => {
    /* Refusing on ignorance stops a route that may be perfectly legal, with no explanation offered --
       `trackReach.ts` #0's rule that "UNKNOWN OPENS THE BOARD UP". */
    expect(reachForDrafting(undefined)).toBe(UNLIMITED_REACH);
    expect(reachForDrafting(null)).toBe(UNLIMITED_REACH);
    expect(isUnlimitedReach(reachForDrafting(undefined))).toBe(true);
  });

  it("is the smallest train when deciding whether what they DREW is too long", () => {
    /* #285: "an absent figure is ignorance and must not read as one [an unlimited]". Clearing the flag on
       ignorance would let an over-long route reach the dispatch unchallenged. */
    expect(overrunsReach(SMALLEST_TRAIN_CAPACITY + 1, undefined)).toBe(true);
    expect(overrunsReach(SMALLEST_TRAIN_CAPACITY, undefined)).toBe(false);
  });

  it("keeps the two answers genuinely different", () => {
    /* THE ASYMMETRY IS THE DESIGN, so it gets an assertion rather than a comment. A tidy-up that made both
       ends agree would silently pick one failure mode over the other. */
    const centres = SMALLEST_TRAIN_CAPACITY + 3;
    expect(overrunsReach(centres, undefined)).toBe(true);
    expect(isUnlimitedReach(reachForDrafting(undefined))).toBe(true);
  });

  it("respects a known figure at both ends", () => {
    expect(reachForDrafting(4)).toBe(4);
    expect(overrunsReach(5, 4)).toBe(true);
  });
});

describe("nobody keeps a private copy of the rule", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs
      .readFileSync(path.join(__dirname, "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  };
  const APP = read("App.tsx");
  const TRACE = read("utils/routeAutoTrace.ts");
  /* Design note #882 moved the DRAWING end of this rule out of `App.tsx` and into the route-edit module, so
     two of the assertions below follow it. The rule did not change; only its address did. */
  const EDIT = read("utils/routeDraftEdit.ts");

  it("leaves no bare 999 in the callers", () => {
    /* THE MAGIC NUMBER IS THE BUG. Four literal comparisons is how one question got three answers, so the
       absence is the assertion -- the sentinel lives in one module and is named.
       ==================================================================
        NARROWED: A BARE `999` ALSO MATCHED A PILL RADIUS
       ==================================================================
       IT ASSERTED `not.toContain("999")` on the whole of `App.tsx`, and `borderRadius: "999px"` -- the
       standard "make this a pill" idiom, nothing to do with trains -- turned it red. The failure was a false
       positive and the case has been failing on it rather than on anything about reach.
       COMPARISONS, NOT DIGITS. What this rule forbids is a caller ASKING the question itself; `999` appearing
       as a length, a radius or a duration is not that. The sibling assertion on `routeAutoTrace` was already
       written in the narrow form, which is the shape both should have had. */
    expect(APP).not.toContain("=== 999");
    expect(APP).not.toContain("!== 999");
    expect(APP).not.toContain(">= 999");
    expect(TRACE).not.toContain(">= 999");
  });

  it("asks the shared rule at every site, wherever it now lives", () => {
    /* THE FLAG AND THE TWO SEARCH BUDGETS ARE STILL SHELL WORK; the click's own cap left with #882. The
       needles were `const cap = reachForDrafting(` and the click gate, both in `App.tsx` -- pinning the
       address rather than the rule, which is why they broke over a move they had no opinion about. */
    expect(APP).toContain("overrunsReach(centres, train.maxDistance)");
    expect((APP.match(/maxRevenueCentres: reachForDrafting\(train\.maxDistance\)/g) ?? []).length).toBe(2);
    expect(EDIT).toContain("const cap = reachForDrafting(maxDistance);");
  });

  it("has retired the third fallback entirely", () => {
    /* `?? 4` was the auto-router's own guess, agreeing with neither the flag's 2 nor the click's infinity. */
    expect(APP).not.toContain("maxDistance ?? 4");
    expect(APP).not.toContain("?? SMALLEST_TRAIN_CAPACITY");
  });

  it("gates the click on the sentinel rather than on null", () => {
    /* The old test was `cap !== null`, which is why the Diesel was refused: `999` is not null. Now in
       `routeDraftEdit.ts` (#882), and asserted absent from `App.tsx` so a copy cannot reappear there. */
    expect(EDIT).toContain("if (!isUnlimitedReach(cap))");
    expect(APP).not.toContain("if (cap !== null) {");
    expect(APP).not.toContain("isUnlimitedReach");
  });
});
