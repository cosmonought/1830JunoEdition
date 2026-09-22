/** @jest-environment node */
// frontend/src/utils/phaseThreeNotice.test.ts -- design notes #1440/#1441.
import { readStripped } from "./sourceScan";

describe("the Phase 3 notice (design note #1441)", () => {
  const app = readStripped("App.tsx");
  const modal = readStripped("components/PhaseThreeNoticeModal.tsx");

  it("is raised on the 2 -> 3 edge of the derived phase, seeded from the first observation", () => {
    /* ==================================================================
        AMENDED BY VF-4: THE EDGE IS THE SAME; THE RAISE IS HELD
       ==================================================================
       IT ASSERTED THE WHOLE LINE, `if (previous === "2" && tier === "3") setPhaseThreeNotice(true);`, which
       pinned the EDGE and the TIMING of the raise together in one string -- so a batch changing only the
       second broke a case about the first. RULED for the phase-badge flourish: "do not allow the
       PhaseThreeNoticeModal to cover the badge before the flip is perceptible", and the notice is a modal,
       so it waits for the badge's own sequence to settle (`PHASE_BADGE_NOTICE_HOLD_MS`, half a second).
       #1441'S RULE IS UNTOUCHED AND IS WHAT THIS CASE STILL CHECKS: the same 2 -> 3 comparison on the same
       derived tier, the same seeded first observation, the same modal wiring. The two are now asserted
       separately, so the next batch that moves one is not stopped by a case about the other.
       THE HOLD ITSELF is `phaseBadgeFlip.test.ts`'s ("holds the Phase 3 notice until the plate has
       settled"), which is where the reason for it is recorded. */
    expect(app).toContain('if (previous === "2" && tier === "3") {');
    expect(app).toContain("setPhaseThreeNotice(true)");
    expect(app).toContain("if (previous === undefined) return; // the first observation seeds; it is not an edge");
    expect(app).toContain("<PhaseThreeNoticeModal open={phaseThreeNotice} onAcknowledge={() => setPhaseThreeNotice(false)} />");
  });

  it("says the two things it exists to say", () => {
    expect(modal).toContain("at any time during its turn");
    expect(modal).toContain("close at the start of Phase 5");
    expect(modal).toContain("Buy Private Company");
  });
});

describe("the standing Buy Private Company button (design note #1440)", () => {
  const bar = readStripped("panels/ContextualActionBar.tsx");
  it("sits on the left rail, gated on the acting president, the phase and a private to buy", () => {
    expect(bar.indexOf("styles.orPanelRailLeft")).toBeLessThan(bar.indexOf('data-testid="buy-private-any-time"'));
    expect(bar.indexOf('data-testid="buy-private-any-time"')).toBeLessThan(bar.indexOf("styles.orPanelActions"));
    expect(bar).toContain("privatesBuyableNow(currentGlobalEra, privateCompanies, phase?.known ? phase.tier : null)");
  });
});
