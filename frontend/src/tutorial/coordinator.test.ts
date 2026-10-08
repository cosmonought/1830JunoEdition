// frontend/src/tutorial/coordinator.test.ts -- PHASE 3 FINAL PLAY TUTORIAL: ARBITRATION (pure).

import { coordinateTutorial, type CoordinatorInput, type TutorialBlockers } from "./coordinator";

const CLEAR: TutorialBlockers = {
  cinematic: false,
  nativeDialogOpen: false,
  forcedNoticeDue: false,
  boardInteraction: false,
  scrubbing: false,
};
const input = (patch: Partial<CoordinatorInput> = {}): CoordinatorInput => ({
  pending: [{ id: "orientation.goal" }, { id: "orientation.flow" }],
  auto: true,
  seated: true,
  blockers: CLEAR,
  relevant: () => true,
  ...patch,
});

describe("one coach, one lesson", () => {
  it("shows the oldest relevant pending lesson, and only that one", () => {
    expect(coordinateTutorial(input())).toEqual({ present: { id: "orientation.goal" }, hold: null, withdraw: [] });
    expect(coordinateTutorial(input({ pending: [] }))).toEqual({ present: null, hold: null, withdraw: [] });
  });
});

describe("a card being read is not swapped", () => {
  it("the lesson on screen stays while it is still due, even if an earlier one becomes eligible", () => {
    const decision = coordinateTutorial(input({ pending: [{ id: "operating.track" }, { id: "stock.float", subject: 1 }], showing: "stock.float" }));
    expect(decision.present).toEqual({ id: "stock.float", subject: 1 });
  });
});

describe("tutorials yield to everything mandatory", () => {
  for (const blocker of Object.keys(CLEAR) as (keyof TutorialBlockers)[]) {
    it(`holds the lesson -- unacknowledged, still pending -- while ${blocker}`, () => {
      const decision = coordinateTutorial(input({ blockers: { ...CLEAR, [blocker]: true } }));
      expect(decision.present).toBeNull();
      expect(decision.hold).toBe(blocker);
    });
  }

  it("a film outranks a dialog in the reported hold, but either holds", () => {
    expect(coordinateTutorial(input({ blockers: { ...CLEAR, cinematic: true, nativeDialogOpen: true } })).hold).toBe("cinematic");
  });

  it("the lesson comes back once the way is clear", () => {
    const held = coordinateTutorial(input({ blockers: { ...CLEAR, forcedNoticeDue: true } }));
    expect(held.present).toBeNull();
    expect(coordinateTutorial(input()).present).toEqual({ id: "orientation.goal" });
  });
});

describe("who gets automatic tutorials", () => {
  it("nobody while they are off, and no watcher ever", () => {
    expect(coordinateTutorial(input({ auto: false }))).toEqual({ present: null, hold: "off", withdraw: [] });
    expect(coordinateTutorial(input({ seated: false }))).toEqual({ present: null, hold: "not-seated", withdraw: [] });
  });
});

describe("relevance", () => {
  it("withdraws a lesson whose moment passed, and shows the next relevant one", () => {
    const decision = coordinateTutorial(
      input({ pending: [{ id: "operating.track" }, { id: "stock.float", subject: 1 }], relevant: (entry) => entry.id !== "operating.track" }),
    );
    expect(decision.withdraw).toEqual(["operating.track"]);
    expect(decision.present).toEqual({ id: "stock.float", subject: 1 });
  });

  it("withdraws stale lessons even while held, but never judges relevance against a replay scrub", () => {
    const held = coordinateTutorial(
      input({ pending: [{ id: "operating.track" }], relevant: () => false, blockers: { ...CLEAR, nativeDialogOpen: true } }),
    );
    expect(held.withdraw).toEqual(["operating.track"]);
    const scrub = coordinateTutorial(input({ pending: [{ id: "operating.track" }], relevant: () => false, blockers: { ...CLEAR, scrubbing: true } }));
    expect(scrub).toEqual({ present: null, hold: "scrubbing", withdraw: [] });
  });

  it("an UNKNOWN relevance (no dealt board yet: the waiting room, a reload still catching up) holds and never withdraws", () => {
    const decision = coordinateTutorial(
      input({ pending: [{ id: "operating.track" }, { id: "orientation.flow" }], relevant: (entry) => (entry.id === "operating.track" ? "unknown" : true) }),
    );
    expect(decision.withdraw).toEqual([]);
    expect(decision.present).toEqual({ id: "orientation.flow" });
  });

  it("a decision lesson still settling is held, not withdrawn, and the next lesson may show", () => {
    const decision = coordinateTutorial(
      input({ pending: [{ id: "operating.dividends" }, { id: "stock.float", subject: 2 }], settling: (entry) => entry.id === "operating.dividends" }),
    );
    expect(decision).toEqual({ present: { id: "stock.float", subject: 2 }, hold: null, withdraw: [] });
  });
});
