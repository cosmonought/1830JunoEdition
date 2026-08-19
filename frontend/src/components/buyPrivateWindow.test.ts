// frontend/src/components/buyPrivateWindow.test.ts
//
// ==================================================================
//  DESIGN NOTE 613: THE WINDOW PRIVATES CAN BE BOUGHT IN
// ==================================================================
//
// The 1830 rule: a corporation may buy a private company from a player from
// the moment the first 3-train is sold (Phase 3) until the first 5-train
// closes every private (Phase 5). So the step belongs to Phases 3 and 4, and
// to no others.
//
// These pin both ends and the two fallbacks, because the reported bug --
// "the Operating Round now begins in Buy Private, but this action is
// unavailable until Phase 3" -- was a phase being read wrongly rather than
// this rule being written wrongly, and the rule had no test to say so.

import { visibleSubPhases, initialOrSubPhase } from "./OperatingSubPhaseStepper";

/** A private nobody has bought and nothing has closed. */
const BUYABLE = [{ closed: false, owner_protocol_id: null }];

const shows = (steps: readonly string[]) => steps.includes("BuyPrivate");

describe("Buy Private is offered in Phases 3 and 4 only", () => {
  it("is hidden in Phase 2", () => {
    // The reported bug. A brand-new game opens here.
    expect(shows(visibleSubPhases("Yellow", BUYABLE, "2"))).toBe(false);
  });

  it("is shown in Phases 3 and 4", () => {
    expect(shows(visibleSubPhases("Green", BUYABLE, "3"))).toBe(true);
    expect(shows(visibleSubPhases("Green", BUYABLE, "4"))).toBe(true);
  });

  it("is hidden from Phase 5 on, even if a private still reports open", () => {
    /* Phase 5 closes every private, so in a settled state `hasBuyablePrivate`
       would answer this on its own. The point of the phase test is the
       UNSETTLED state: a client that has seen the phase advance but not yet
       the closures. Passing a still-open private here is what makes this
       assert the phase rule rather than the closure rule. */
    for (const tier of ["5", "6", "D"]) {
      expect(shows(visibleSubPhases("Brown", BUYABLE, tier))).toBe(false);
    }
  });

  it("stays hidden in Phase 3 when nothing is left to buy", () => {
    // Design note #385: a step with nothing in it is not a step. The phase
    // rule is necessary, not sufficient.
    const allTaken = [{ closed: false, owner_protocol_id: 4 }, { closed: true, owner_protocol_id: null }];
    expect(shows(visibleSubPhases("Green", allTaken, "3"))).toBe(false);
  });
});

describe("the era fallback, for when the phase is not yet knowable", () => {
  /* Design note #3 in `gamePhase.ts`: if no corporation has reported
     `owned_trains`, there is no phase number to test. The era is the best
     evidence available and the old behaviour is what runs. */
  it("falls back to the era when no tier is given", () => {
    expect(shows(visibleSubPhases("Yellow", BUYABLE))).toBe(false);
    expect(shows(visibleSubPhases("Green", BUYABLE))).toBe(true);
    expect(shows(visibleSubPhases("Yellow", BUYABLE, null))).toBe(false);
    expect(shows(visibleSubPhases("Green", BUYABLE, null))).toBe(true);
  });

  it("hides the step when the era is unknown too", () => {
    // Nothing known at all is the pre-first-poll state, and `initialOrSubPhase`
    // already answers `Track` for it. Offering a locked step would be worse
    // than briefly omitting an available one.
    expect(shows(visibleSubPhases(null, BUYABLE))).toBe(false);
    expect(shows(visibleSubPhases(undefined, BUYABLE))).toBe(false);
  });
});

describe("the contract cursor mirror is left alone", () => {
  it("still opens a turn on Track before Phase 3 and Buy Private after", () => {
    /* Design note #613: `initialOrSubPhase` mirrors
       `or_phase::initial_sub_phase` and decides where the CURSOR starts,
       which is the contract's call. Only the DISPLAY rule moved to testing
       the phase number. A mirror that stops matching its original is worse
       than an imprecise one. */
    expect(initialOrSubPhase("Yellow")).toBe("Track");
    expect(initialOrSubPhase(null)).toBe("Track");
    expect(initialOrSubPhase(undefined)).toBe("Track");
    expect(initialOrSubPhase("Green")).toBe("BuyPrivate");
    expect(initialOrSubPhase("Brown")).toBe("BuyPrivate");
  });
});
