/** @jest-environment node */
// frontend/src/components/buyPrivateWindow.test.ts
//
// Design note #1440: buying a private is NOT a step. `visibleSubPhases` never lists it; `privatesBuyableNow`
// is the rule the standing action-bar button asks -- Phases 3 and 4, with something left to buy -- and a
// turn opens on Track in every era.

import { initialOrSubPhase, privatesBuyableNow, visibleSubPhases } from "./OperatingSubPhaseStepper";

const BUYABLE = [{ closed: false, owner_protocol_id: null }];

describe("the private purchase is a standing button, not a step (design note #1440)", () => {
  it("never appears in the step sequence, whatever the phase", () => {
    for (const tier of ["2", "3", "4", "5", "6", "D", null, undefined]) {
      expect(visibleSubPhases("Green", BUYABLE, tier)).toEqual(["Track", "Tokens", "Routes", "Dividends", "Hardware"]);
    }
  });

  it("every turn opens on Track", () => {
    for (const era of ["Yellow", "Green", "Brown", null, undefined]) expect(initialOrSubPhase(era)).toBe("Track");
  });
});

describe("the button is offered in Phases 3 and 4 only", () => {
  it("is hidden in Phase 2", () => {
    expect(privatesBuyableNow("Yellow", BUYABLE, "2")).toBe(false);
  });

  it("is shown in Phases 3 and 4", () => {
    expect(privatesBuyableNow("Green", BUYABLE, "3")).toBe(true);
    expect(privatesBuyableNow("Green", BUYABLE, "4")).toBe(true);
  });

  it("is hidden from Phase 5 on, even if a private still reports open", () => {
    for (const tier of ["5", "6", "D"]) expect(privatesBuyableNow("Brown", BUYABLE, tier)).toBe(false);
  });

  it("stays hidden in Phase 3 when nothing is left to buy", () => {
    const allTaken = [{ closed: false, owner_protocol_id: 4 }, { closed: true, owner_protocol_id: null }];
    expect(privatesBuyableNow("Green", allTaken, "3")).toBe(false);
  });

  it("falls back to the era when no tier is given, and hides itself when the era is unknown too", () => {
    expect(privatesBuyableNow("Yellow", BUYABLE, null)).toBe(false);
    expect(privatesBuyableNow("Green", BUYABLE, null)).toBe(true);
    expect(privatesBuyableNow(null, BUYABLE, undefined)).toBe(false);
  });
});
