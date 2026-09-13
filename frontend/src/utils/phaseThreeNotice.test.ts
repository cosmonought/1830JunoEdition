/** @jest-environment node */
// frontend/src/utils/phaseThreeNotice.test.ts -- design notes #1440/#1441.
import { readStripped } from "./sourceScan";

describe("the Phase 3 notice (design note #1441)", () => {
  const app = readStripped("App.tsx");
  const modal = readStripped("components/PhaseThreeNoticeModal.tsx");

  it("is raised on the 2 -> 3 edge of the derived phase, seeded from the first observation", () => {
    expect(app).toContain('if (previous === "2" && tier === "3") setPhaseThreeNotice(true);');
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
