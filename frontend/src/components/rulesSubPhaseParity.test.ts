//
// Phase 3 W1-L: the Rules Reference calls each Operating Round step what the action bar calls it.
//
// `SUB_PHASE_DISPLAY` (the CURRENT breadcrumb and the game-flow chips) is a hand-held copy of the stepper's
// `stepLabel`s -- deriving it is S10-14's Phase-5 consolidation. Until then this holds the two equal, key for key,
// so a renamed step cannot leave the reference naming it the old way.

import { SUB_PHASE_DISPLAY } from "./RulesReference";
import { OPERATING_SUB_PHASE_LABELS } from "../gameEngine/operatingSubPhase";

describe("SUB_PHASE_DISPLAY == OPERATING_SUB_PHASE_LABELS[*].stepLabel", () => {
  it("names the same cursor values", () => {
    expect(Object.keys(SUB_PHASE_DISPLAY).sort()).toEqual(Object.keys(OPERATING_SUB_PHASE_LABELS).sort());
  });

  it("calls every step by the stepper's own label", () => {
    for (const [phase, label] of Object.entries(OPERATING_SUB_PHASE_LABELS)) {
      expect({ phase, display: SUB_PHASE_DISPLAY[phase as keyof typeof SUB_PHASE_DISPLAY] }).toEqual({
        phase,
        display: label.stepLabel,
      });
    }
  });
});
