/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W1-I (P3-N014): NO DEVELOPER TEXT IN THE BAR'S TOOLTIPS
// ==================================================================
//
// Two player tooltips carried the software's account of itself: Skip said "Dispatches AdvanceOperatingSubPhase --
// the contract moves its own cursor one step", and the $0 Withhold said "Project 18XX has no $0 dividend -- the
// revenue is withheld" about a turn with no revenue to withhold. Both are rewritten as what the player is doing and
// what the rule does. Source scans over the comment-stripped bar, because the strings are JSX attributes.

import { readStripped, sliceBetween } from "./sourceScan";

const BAR = readStripped("panels/ContextualActionBar.tsx");

describe("the Skip tooltip", () => {
  const SKIP = sliceBetween(BAR, "onClick={onSkipSubPhase}", "</button>");

  it("says what the player is doing", () => {
    expect(SKIP).toContain("title={`Move past ${OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} without acting. The turn goes on to its next step.`}");
  });

  it("names no action type and no contract internals", () => {
    expect(SKIP).not.toContain("AdvanceOperatingSubPhase");
    expect(SKIP).not.toMatch(/contract|cursor|dispatch/i);
  });
});

describe("the $0 Withhold tooltip", () => {
  const WITHHOLD = sliceBetween(BAR, 'key: "withhold-revenue"', "onClick: onWithholdRevenue");
  const TITLE = sliceBetween(BAR, "onClick: onWithholdRevenue", "},");

  it("keeps the $0 label the dividend layout pins", () => {
    expect(WITHHOLD).toContain('"Withhold $0 — Share Price Steps Left"');
  });

  it("states the rule, not a property of the software", () => {
    expect(TITLE).toContain(
      '"No revenue this turn, so there is no dividend to pay. In Project 18XX a corporation that earns nothing withholds, and its share price moves one step left."',
    );
    expect(TITLE).not.toContain("has no $0 dividend");
  });

  it("does not claim revenue is withheld when there is none", () => {
    expect(TITLE).not.toContain("the revenue is withheld");
  });
});
