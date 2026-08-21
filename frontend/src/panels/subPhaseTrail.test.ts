// frontend/src/panels/subPhaseTrail.test.ts
//
// ==================================================================
//  DESIGN NOTES 517 / 518 / 672 (harness): THE HEADER HAS ONE FORM
// ==================================================================
//
// #518 SPLIT the header in two: the expanded panel showed a full sub-phase
// trail, the pinned form kept #481's three-word phrase. This harness pinned
// that split -- each form under exactly one condition.
//
// Design note #672 REMOVED THE SPLIT, and these assertions inverted with it.
// Reported repeatedly: the sticky bar drops the train limit and condenses the
// sub-phase to "[Current Action] x/6", with room to spare for both. #590 had
// already ruled on that and only half-applied its own ruling, which is how a
// note saying NOTHING IS DROPPED WHEN PINNED came to sit six lines above two
// things being dropped when pinned.
//
// SO WHAT IS UNDER TEST FLIPPED, and both halves are asserted. Not just "the
// trail renders" -- that passed before, in one branch of a ternary. The
// condition is that the trail renders with NO condensed branch anywhere near
// it, and that the compact form is GONE rather than merely unreachable: a
// dead branch is how the split comes back, one bug report at a time.
//
// SOURCE-LEVEL, for the reason `corporationCardText.test.ts` records: this
// JSX cannot be rendered without standing up the whole bar and a game state,
// and what is under test is structural rather than visual.

import fs from "fs";
import path from "path";

const BAR = path.join(__dirname, "ContextualActionBar.tsx");
const SOURCE = fs.readFileSync(BAR, "utf8");
/* Design notes here discuss the removed forms by name and at length -- the
   same trap the card harness documents. Order and absence checks read the
   stripped copy. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the Operating Round number", () => {
  it("renders the cycle and index in the round label", () => {
    // Design note #517: "Operating Round 3.2", not just the kind of round.
    expect(CODE).toMatch(/Operating Round \$\{orSequence\.cycle\}\.\$\{orSequence\.index\}/);
  });

  it("falls back to the bare wording before the first poll", () => {
    /* `null` must not print "Operating Round undefined.undefined", and it
       must not print a placeholder pair either -- there genuinely is no
       round number yet. */
    expect(CODE).toMatch(/orSequence\s*\n?\s*\?[\s\S]{0,120}?:\s*"Operating Round"/);
  });

  it("takes the number as a prop rather than reaching for game state", () => {
    // This bar has no game state; deriving here would mean giving it one.
    expect(CODE).toMatch(/orSequence\?: \{ cycle: number; index: number \} \| null;/);
    expect(CODE).not.toContain("macro_round_number");
  });
});

describe("the sub-phase display", () => {
  it("renders the trail without asking whether the bar is pinned", () => {
    /* Design note #672. The gate is the round type and the presence of a
       progress object -- nothing about `condensed`. */
    expect(CODE).toMatch(
      /roundType === "OperatingRound" && orSubPhaseProgress && \(\s*<span\s*style=\{styles\.subPhaseTrail\}/,
    );
  });

  it("has NO condensed branch left around the trail", () => {
    /* The assertion the previous version of this file made in reverse. A
       ternary that still exists is a split that still exists -- and the
       reported bug was, precisely, one branch of it. */
    const trailAt = CODE.indexOf("styles.subPhaseTrail");
    expect(trailAt).toBeGreaterThan(-1);
    expect(CODE.slice(Math.max(0, trailAt - 400), trailAt)).not.toContain("condensed ?");
  });

  it("has DELETED the compact string, not merely stopped reaching it", () => {
    /* Dead code is how this comes back. The phrase, its counter and both
       styles go together or the next reader finds a ready-made pinned form
       and a plausible reason to re-gate it. */
    expect(CODE).not.toContain("actionBarSubPhaseInline");
    expect(CODE).not.toContain("actionBarSubPhaseCount");
  });

  it("keeps the train limit pinned too", () => {
    /* The other half of the same report, and the half #590 claimed to have
       fixed while leaving the gate in. */
    expect(CODE).toMatch(/\{phase\?\.trainLimit !== undefined && \(/);
    expect(CODE).not.toMatch(/!condensed && phase\?\.trainLimit/);
  });

  it("builds the trail from the step list the counter is measured against", () => {
    /* One `visibleSubPhases` result feeding both, so the trail cannot show
       six boxes while the counter says "4/5". That two-numbers-for-one-step
       fault is exactly what the round label's own note records. */
    expect(CODE).toMatch(/steps,/);
    expect(CODE).toMatch(/orSubPhaseProgress\.steps\.map/);
  });

  it("marks the active step for assistive tech, not only in colour", () => {
    // Emphasis that exists only as a fill is emphasis a screen reader
    // cannot report.
    expect(CODE).toMatch(/aria-current=\{isCurrent \? "step" : undefined\}/);
  });

  it("distinguishes past steps from steps still to come", () => {
    /* Three states, not two. A trail that only highlighted the current step
       would read as a set of tags rather than as progress along a
       sequence. */
    expect(CODE).toMatch(/subPhaseStepDone/);
    expect(CODE).toMatch(/subPhaseStepCurrent/);
    expect(CODE).toMatch(/index < orSubPhaseProgress\.position - 1/);
  });
});
