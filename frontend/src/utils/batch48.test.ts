/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1046 (harness): THE EASTER EGG STARTS MOVING MONEY
// ==================================================================
//
// BATCHES 46 AND 47 WERE COSMETIC, and that is what made deriving everything in the shell safe. This one
// deletes a train, pays a treasury and gifts a locomotive -- so it crossed into the reducer, and the cases
// below are shaped by the three things that crossing put at risk:
//
//   THE BOARD. State in this app is what the reducer writes while replaying the log. A shell that mutated a
//   corporation would change one browser and be lost on reload, so the mechanics moved into an ACTION and the
//   reducer applies it. That also retires #1044's determinism burden: only the acting client decides, and the
//   decision is in the log for everyone else to replay.
//
//   THE DEPOT. `derivePhase` computes remaining stock as `TOTAL - owned`, so a gifted train that "does not
//   deplete the bank's supply" contradicts the one function that decides what the bank has left -- and that
//   figure also drives the phase countdown and #1035's privates-closure warning.
//
//   THE LIMIT. #1034 had just finished making one exemption work properly. This adds a second, on a different
//   clock, and the temptation to widen the first one instead is exactly how the two would come to expire
//   together.

export {};

const {
  YELLOW_SIGN_MALUS_LINE,
  YELLOW_SIGN_BONUS_LINE,
  NO_YELLOW_SIGN,
  MARK_APPENDIX,
  ESCALATION_APPENDIX,
  markWindowOpen,
  escalationWindowOpen,
  lowestValueTrain,
  markPayout,
  escalationTier,
  resolveFlavourLine,
} = require("./yellowSign") as typeof import("./yellowSign");
/* Design note #1051: the pre-#1051 die. Every case here was written against the FNV hash, so the fixture
   asks for it by name -- see `batch50.test.ts` for the claim about a real draw. */
const { legacyTurnSeed } = require("./gameVariants") as typeof import("./gameVariants");
const { countableTrainCount } = require("./trainLimit") as typeof import("./trainLimit");
const { derivePhase } = require("./gamePhase") as typeof import("./gamePhase");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const REDUCER = readStripped("utils/sandboxSession.ts");
const PHASE = readStripped("utils/gamePhase.ts");

const parts = (companyId: number) => ({
  macroRound: 3,
  subRound: 1,
  companyId,
  turnSeed: legacyTurnSeed(3, 1, companyId),
});
const resolve = (over: Partial<Parameters<typeof resolveFlavourLine>[0]>) =>
  resolveFlavourLine({
    naturalLine: YELLOW_SIGN_MALUS_LINE,
    bucket: "criticalMalus",
    ticker: "PRR",
    parts: parts(1),
    state: NO_YELLOW_SIGN,
    phaseTier: "4",
    owned: ["2", "4"],
    ...over,
  });

/* ------------------------------------------------------------------ */
/* The windows                                                        */
/* ------------------------------------------------------------------ */

describe("each stage has a phase window", () => {
  it("opens the mark in 2, 3 and 4 only", () => {
    expect(["2", "3", "4"].every(markWindowOpen)).toBe(true);
    expect(["5", "6", "D"].some(markWindowOpen)).toBe(false);
  });

  it("opens the escalation in 5, 6 and D only", () => {
    expect(["5", "6", "D"].every(escalationWindowOpen)).toBe(true);
    expect(["2", "3", "4"].some(escalationWindowOpen)).toBe(false);
  });

  it("expires the mark when Phase 5 arrives", () => {
    /* RULED: "If Phase 5 begins and this event has not occurred naturally, permanently remove the text from
       the global Malus pool." Nobody is marked and the line is drawn naturally -- and it is skipped anyway,
       because its window has closed. */
    const out = resolve({ phaseTier: "5" });
    expect(out.stage).toBeNull();
    expect(out.line).not.toBe(YELLOW_SIGN_MALUS_LINE);
  });

  it("holds the escalation back until Phase 5", () => {
    /* THE WINDOWS DO NOT OVERLAP, so a corporation marked in Phase 4 cannot escalate in Phase 4 however the
       tenth rolls. Without the gate this would be the one case that fires early and nobody would notice. */
    for (const phaseTier of ["2", "3", "4"]) {
      expect(
        resolve({
          naturalLine: "Business was brisk, and nobody has yet asked why.",
          bucket: "criticalBonus",
          state: { markedTicker: "PRR", carcosaSeen: false },
          phaseTier,
        }).stage,
      ).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Stage 1 mechanics                                                  */
/* ------------------------------------------------------------------ */

describe("the mark takes the cheapest train and pays half", () => {
  it("finds the cheapest by depot value", () => {
    expect(lowestValueTrain(["5", "2", "4"])).toBe("2");
    expect(lowestValueTrain(["6", "D"])).toBe("6");
  });

  it("has nothing to take from an empty fleet", () => {
    /* RULED "fire anyway, even down to zero trains" -- which is ONE becoming NONE. A corporation already at
       none has no train to name in the ruled log line and no value to halve, so the line stays in the pool
       for a corporation that has something to lose. */
    expect(lowestValueTrain([])).toBeNull();
    expect(lowestValueTrain(undefined)).toBeNull();
    expect(resolve({ owned: [] }).stage).toBeNull();
  });

  it("fires when that leaves the corporation with none", () => {
    expect(resolve({ owned: ["2"] }).stage).toBe("mark");
  });

  it("pays half the depot price, floored", () => {
    /* 0.5x, AND THE SPEC FIRST SAID 1.5x -- corrected on sight. The difference is the whole character of the
       event: at 1.5x losing your cheapest train is a windfall, at 0.5x it is a loss with a consolation. */
    expect(markPayout("2")).toBe(40);
    expect(markPayout("4")).toBe(150);
    expect(markPayout("D")).toBe(550);
  });

  it("appends the ruled sentence to the flavour", () => {
    expect(APP).toContain("${flavourLine} ${MARK_APPENDIX}");
    expect(MARK_APPENDIX).toContain("bag of strangely marked gold");
  });

  it("writes the mechanical line under its own step stamp", () => {
    /* RULED: `[OR X.Y--Yellow Sign] The [lowest value]-train disappeared. $[1.5x value] found.` -- the stamp
       is its own step because the event is neither Run Routes nor Dividends, and filing it under either would
       credit a step that did not do it. */
    expect(APP).toContain('operating_sub_phase: "Yellow Sign" as never');
    expect(APP).toContain("`The ${taken}-train disappeared. $${award} found.`");
  });
});

describe("the reducer applies what the shell decided", () => {
  it("carries the figures on the message rather than re-deriving them", () => {
    /* THE REPLAY TRAP. By the time a rebuild reaches this action the fleet has moved on, so a reducer that
       re-derived "the cheapest train" would take a DIFFERENT train than the game did -- #902's "an old log
       replays to the game it was played as", broken. */
    expect(REDUCER).toContain("const { protocol_id, stage, model, cash } = msg.YellowSignEvent;");
  });

  it("zeroes both revenue fields, not just the modified one", () => {
    /* "IT RECEIVES NO STANDARD ROUTE REVENUE FOR THIS SUBMISSION." `printed_route_revenue` is what a later
       dispatch accumulates onto (#941), so leaving it would pay for these routes on the corporation's NEXT
       turn -- the silent double-payment #934 was reported for. */
    expect(REDUCER).toContain('last_route_revenue: "0",\n                printed_route_revenue: "0",');
  });

  it("adds the award to the treasury and sets the flag", () => {
    expect(REDUCER).toContain("has_yellow_sign: true,");
    expect(REDUCER).toContain("treasury: String((Number(entry.treasury ?? 0) || 0) + award),");
  });

  it("refuses rather than mutating when the train is gone", () => {
    // #778: a gate refuses by returning the state it was handed, which is how the drain detects it.
    expect(REDUCER).toContain("if (at < 0) return state;");
  });

  it("gifts the train into the roster and marks it a ghost", () => {
    /* #979's SHAPE: the roster stays the one place a fleet lives and the exception is a mark beside it. A
       separate array of ghost trains would be a second roster to fall out of step with the first. */
    expect(REDUCER).toContain("owned_trains: [...(entry.owned_trains ?? []), model],");
    expect(REDUCER).toContain("ghost_trains: [...(entry.ghost_trains ?? []), model],");
    expect(REDUCER).toContain("has_yellow_sign: false,");
  });
});

/* ------------------------------------------------------------------ */
/* The ghost's two exemptions                                         */
/* ------------------------------------------------------------------ */

describe("a ghost train was never in the depot", () => {
  const board = (owned: string[], ghosts: string[]): any => ({
    public_companies: [{ company_id: 1, ticker: "PRR", owned_trains: owned, ghost_trains: ghosts }],
  });

  it("does not take a train off the shelf", () => {
    /* RULED: "it does not deplete the bank's supply." Six 2-trains are printed; a corporation holding one
       bought and one gifted has taken ONE. */
    expect(derivePhase(board(["2", "2"], ["2"]))?.depotRemaining).toBe(5);
    expect(derivePhase(board(["2", "2"], []))?.depotRemaining).toBe(4);
  });

  it("still counts toward the phase", () => {
    /* THE HALF THAT MUST NOT BE HIDDEN. The phase is "the highest tier anybody owns" (#1), and a gifted train
       is a real train the corporation owns. Subtracting it from the phase as well would be #906's mistake --
       enforcing a rule by withholding a value from every reader. */
    expect(derivePhase(board(["2", "5"], ["5"]))?.tier).toBe("5");
  });

  it("subtracts one ghost per gift, not every train of that tier", () => {
    // The multiset rule, which every list in this feature follows.
    expect(derivePhase(board(["2", "2", "2"], ["2"]))?.depotRemaining).toBe(4);
  });

  it("is asked in the supply tally rather than the roster loop", () => {
    expect(PHASE).toContain("const ghosts = [...(company.ghost_trains ?? [])];");
  });
});

describe("a ghost train occupies no limit slot, for now", () => {
  it("is exempt like a reprieved train", () => {
    expect(countableTrainCount(["4", "5", "6"], [], ["6"])).toBe(2);
  });

  it("stacks with the reprieve rather than replacing it", () => {
    /* TWO EXEMPTIONS ON DIFFERENT CLOCKS. A corporation with one condemned train and one gift has both
       subtracted -- and merging them into one list would be #732's fault, one argument answering two
       questions that expire at different moments. */
    expect(countableTrainCount(["2", "4", "6"], ["2"], ["6"])).toBe(1);
  });

  it("leaves every existing caller unchanged", () => {
    // The third argument is optional, so a standard game counts exactly as it did before this batch.
    expect(countableTrainCount(["4", "5"], [])).toBe(2);
    expect(countableTrainCount(["4", "5"], ["4"])).toBe(1);
  });

  it("expires at the Operating Round boundary and trims", () => {
    /* RULED, when asked: "Becomes an ordinary train; discard if over." The clear and the trim are one
       transition -- clearing without trimming would leave a corporation over the limit indefinitely, because
       `applyPhaseChange` is the only other place that trims and a phase change may never come again. */
    expect(REDUCER).toContain("function expireGhostTrains(state: GameStateResponse)");
    expect(REDUCER).toContain("const settled = expireGhostTrains(expired);");
    expect(REDUCER).toContain("ghost_trains: [],");
  });

  it("reaches every surface that counts", () => {
    /* #1006's SHAPE, which this project meets about once a batch. A new exempt kind of train that only some
       counting sites know about is a limit that disagrees with itself. */
    expect(APP).toContain("company?.ghost_trains,");
    expect(readStripped("utils/trainPurchaseGate.ts")).toContain("company.ghost_trains");
    expect(readStripped("components/TrainPurchasePanel.tsx")).toContain("buyer?.ghost_trains");
    expect(readStripped("components/TrainBadges.tsx")).toContain("countableTrainCount(trains, reprieved, ghosts)");
    expect(readStripped("panels/ContextualActionBar.tsx")).toContain("activeCorporation?.ghostTrains");
  });
});

/* ------------------------------------------------------------------ */
/* Stage 2 and the override                                           */
/* ------------------------------------------------------------------ */

describe("the escalation gifts the phase's own tier", () => {
  it("matches the current phase", () => {
    expect(escalationTier("5")).toBe("5");
    expect(escalationTier("D")).toBe("D");
    expect(escalationTier("nonsense")).toBeNull();
  });

  it("appends the ruled sentence and logs the gift", () => {
    expect(APP).toContain("${flavourLine} ${ESCALATION_APPENDIX}");
    expect(ESCALATION_APPENDIX).toContain("decadent gold trim");
    expect(APP).toContain("`${ticker} received a ${gifted}-train.`");
  });

  it("reads the phase from before the dispatch settled", () => {
    /* THE TURN IS JUDGED BY THE PHASE IT WAS PLAYED IN. Reading `after` would judge it by a phase its own
       train purchase had already turned -- the same "read at the wrong moment" fault #934 records. */
    expect(APP).toContain('phaseTier: derivePhase(before)?.tier ?? "2"');
  });
});

describe("the haunting still plays alone", () => {
  it("suppresses the standard flash for both stages", () => {
    expect(APP).toContain('revenueOutcome(roll) !== "normal" && !cue.suppressStandardVisuals');
  });

  it("sends the mechanics through the log rather than mutating locally", () => {
    /* THE ARCHITECTURAL LINE THIS BATCH CROSSED. A shell that changed a corporation directly would change one
       browser's board, be lost on reload, and be unreachable by Undo. */
    expect(APP).toContain('runGameplayAction("YellowSignEvent"');
    expect(APP).not.toContain("setGameState((prev) => ({ ...prev, public_companies");
  });
});
