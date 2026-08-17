// frontend/src/panels/subPhaseTrail.test.ts
//
// ==================================================================
//  DESIGN NOTES 517 / 518 (harness): THE HEADER'S TWO FORMS
// ==================================================================
//
// Two requirements that pull against each other, which is why they are
// pinned together: the expanded header gains a full sub-phase trail, and the
// pinned header must keep the compact string it already had.
//
// A test that only checked "the trail renders" would pass against a bar that
// showed it in BOTH states -- which is the regression design note #481
// removed a stepper to avoid, and the one #298's rule exists to prevent. So
// the assertions are about the SPLIT: each form appears under exactly one
// condition, and the trail is built from the same step list the counter is
// measured against.
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
  it("branches on the condensed flag", () => {
    /* THE SPLIT. Both forms exist and exactly one renders -- a bar that
       showed the trail while pinned would be spending the row design note
       #481 reclaimed. */
    expect(CODE).toMatch(/condensed \? \([\s\S]{0,600}?actionBarSubPhaseInline/);
    expect(CODE).toMatch(/actionBarSubPhaseInline[\s\S]{0,900}?\) : \([\s\S]{0,300}?subPhaseTrail/);
  });

  it("keeps the compact string for the pinned form", () => {
    // Design note #481's phrase, unchanged, plus its position counter --
    // which is the only thing carrying the position in that form.
    expect(CODE).toContain("actionBarSubPhaseCount");
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
