/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 883 (harness): THE ORDER IS THE RULE
// ==================================================================
//
// Extracted from `App.handleRunTrains` by audit. The runnable filter is ordinary; the REFUSAL ORDER is the
// rule worth rescuing -- four `if`s in source order inside an async dispatch callback, load-bearing and
// asserted nowhere. Several complaints can be true of one board at once, and the player sees one sentence.
//
// AND THE EXTRACTION FOUND A CASE WITH NO ARM: a route that is lawful in every respect and pays $0.

import { runnableDrafts, runTrainsRefusal, type RunnableDraftShape } from "./runTrainsRules";

const draft = (over: Partial<RunnableDraftShape> = {}): RunnableDraftShape => ({
  value: 90,
  exceedsMaxDistance: false,
  endsOffTerminus: false,
  tokenBlockReason: null,
  hexLabels: ["A9", "A11"],
  ...over,
});

describe("which drafts may run", () => {
  it("runs a good one", () => {
    expect(runnableDrafts([draft()])).toHaveLength(1);
    expect(runTrainsRefusal([draft()])).toBeNull();
  });

  it("skips the bad one and keeps the good one", () => {
    /* #275: invalid drafts are SKIPPED, not refused -- the good routes are not hostage to the bad one. A
       gate here instead of a filter would lose a legal run to an illegal sibling. */
    const drafts = [draft({ tokenBlockReason: "no token" }), draft()];
    expect(runnableDrafts(drafts)).toHaveLength(1);
    expect(runTrainsRefusal(drafts)).toBeNull();
  });

  it.each([
    ["an unpriced route", { value: null }],
    ["a worthless route", { value: 0 }],
    ["an over-long route", { exceedsMaxDistance: true }],
    ["a route ending nowhere", { endsOffTerminus: true }],
    ["a route touching no token", { tokenBlockReason: "no token" }],
  ])("refuses %s", (_label, over) => {
    expect(runnableDrafts([draft(over as Partial<RunnableDraftShape>)])).toHaveLength(0);
  });

  it("keeps $0 out, matching the obligation", () => {
    /* `routeStep.ts` SETTLED THIS FROM THE OTHER SIDE: "0 is a real answer that permits Skip", so a
       corporation whose only route is worthless is not compelled to run it. If this filter admitted $0 the
       two rules would disagree about whether a worthless route counts. */
    expect(runnableDrafts([draft({ value: 0 })])).toHaveLength(0);
  });
});

describe("which complaint wins", () => {
  it("asks for a route before anything else", () => {
    /* Not a mistake -- a step not yet taken, so it is not phrased as a refusal.
       `value: null` GOES WITH `hexLabels: []`, and the first draft of this test omitted it: a draft with no
       hexes and a $90 value is a state `trainDrafts` cannot produce, because it prices only routes of two or
       more points. The fixture was impossible and the test failed for it -- the same lesson #882's fixtures
       taught an hour earlier, which is that a fake that does not model the real shape proves nothing. */
    expect(runTrainsRefusal([draft({ hexLabels: [], value: null })])).toContain(
      "Select at least two connected hexes",
    );
  });

  it("puts the token first, above the ending", () => {
    /* #474: "the token warning comes first, because a tokenless route is wrong about where it runs." BOTH
       are true of this draft, which is what makes the assertion about ORDER rather than about detection. */
    const both = draft({ tokenBlockReason: "NNH has no token on this route.", endsOffTerminus: true });
    expect(runTrainsRefusal([both])).toBe("NNH has no token on this route.");
  });

  it("puts the ending above the length", () => {
    const both = draft({ endsOffTerminus: true, exceedsMaxDistance: true, hexLabels: ["A9", "F18"] });
    expect(runTrainsRefusal([both])).toContain("cannot END a route");
  });

  it("names the offending last hex", () => {
    const result = runTrainsRefusal([draft({ endsOffTerminus: true, hexLabels: ["A9", "F18"] })]);
    expect(result).toContain("F18");
    // And says both ways out: finish properly, or step back.
    expect(result).toContain("step back");
  });

  it("reports a too-long route when nothing worse is true", () => {
    expect(runTrainsRefusal([draft({ exceedsMaxDistance: true })])).toContain("more stops than the train");
  });
});

describe("the lawful route worth nothing (design note #883)", () => {
  it("explains itself instead of falling through", () => {
    /* THE GAP THE ORDER WAS HIDING. Albany is a blank $0 printed city and 1830 prints others, so two of them
       joined by track is a lawful route paying zero -- and before this arm the player was told "No drafted
       route can run yet", which is true and tells them nothing. */
    const result = runTrainsRefusal([draft({ value: 0 })]);
    expect(result).toContain("pays $0");
    expect(result).not.toBe("No drafted route can run yet.");
  });

  it("offers both ways forward", () => {
    // Extend it, or skip -- and skipping IS available, because the obligation declines to compel a $0 run.
    const result = runTrainsRefusal([draft({ value: 0 })]);
    expect(result).toContain("Extend it");
    expect(result).toContain("skip");
  });

  it("does not claim a route that is broken for another reason", () => {
    /* THE ARM IS LAST, AND ITS POSITION IS WHAT MAKES IT NARROW. A $0 route that ALSO ends nowhere is an
       ending problem -- the more actionable complaint -- and this must not steal it.
       A NEGATIVE CONTROL SHARPENED THIS. The arm originally re-checked the three faults above it as well,
       and stripping those guards changed nothing: the earlier arms had already returned. So this test does
       not prove the predicate is narrow, it proves the ORDER is -- which is the property actually worth
       holding, and the guards were deleted as unreachable. */
    expect(runTrainsRefusal([draft({ value: 0, endsOffTerminus: true })])).toContain("cannot END");
    expect(runTrainsRefusal([draft({ value: 0, tokenBlockReason: "no token" })])).toBe("no token");
    expect(runTrainsRefusal([draft({ value: 0, exceedsMaxDistance: true })])).toContain("more stops");
  });

  it("keeps the old fallthrough for a case nothing above explains", () => {
    // An unpriced draft: `value === null` is ignorance, which none of the named arms should claim.
    expect(runTrainsRefusal([draft({ value: null })])).toBe("No drafted route can run yet.");
  });
});

describe("the shell kept only the dispatch", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs
      .readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  })();

  it("asks both rules instead of holding them", () => {
    expect(APP).toContain("const runnable = runnableDrafts(trainDrafts);");
    expect(APP).toContain("setRouteFeedback(runTrainsRefusal(trainDrafts));");
  });

  it("keeps no copy of the order or the filter", () => {
    expect(APP).not.toContain("tokenBlockReason !== null");
    expect(APP).not.toContain("cannot END a route");
    expect(APP).not.toContain("No drafted route can run yet");
    expect(APP).not.toContain("draft.value > 0");
  });
});
