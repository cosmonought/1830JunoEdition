/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1190 (harness): THE ALLOWANCE IS PINNED TO A REAL GAME
// ==================================================================
//
// The settlement clock's two numbers were twice argued from intuition and twice wrong. These cases exist so
// the next revision is a measurement: the arithmetic is pinned on hand-built turns where the right answer is
// obvious by inspection, and the CHOSEN allowance is pinned against the real playtest it was chosen from.
//
// THE LAST CASE IS THE LOAD-BEARING ONE. If `LIVE_ALLOWANCE_SECONDS` is ever lowered to something that would
// have eaten into a player's reserve during `JUNO-3XD`, that is a decision worth making deliberately and not
// by drifting -- so it fails here rather than in a real game two hours in.

export {};

const { readFileSync } = require("fs") as typeof import("fs");
const { join } = require("path") as typeof import("path");
const {
  burnByActor,
  clockStats,
  turnsFromLog,
  worstBurnSeconds,
  LIVE_ALLOWANCE_SECONDS,
} = require("./turnClock") as typeof import("./turnClock");

const at = (index: number, actor: string, seconds: number) => ({
  index,
  id: `id${index}`,
  actor,
  at: seconds * 1000,
});

describe("a turn is a run by one actor, and it owns the wait before it", () => {
  it("groups consecutive entries by the same actor into one turn", () => {
    const turns = turnsFromLog([
      at(0, "a", 0),
      at(1, "a", 10),
      at(2, "a", 20),
      at(3, "b", 30),
    ]);
    expect(turns.map((turn) => [turn.actor, turn.actions])).toEqual([
      ["a", 3],
      ["b", 1],
    ]);
  });

  it("charges the lead-in to the turn that follows it, not the one before", () => {
    /* The gap between b's last action and c's first is c READING THE BOARD -- the interval the allowance
       exists to cover. Measuring from c's first action would miss all of it, and would report the longest
       deliberation in a game as an instantaneous turn. */
    const turns = turnsFromLog([at(0, "b", 0), at(1, "c", 100), at(2, "c", 130)]);
    expect(turns[0]).toEqual({ actor: "b", actions: 1, seconds: 0 });
    expect(turns[1]).toEqual({ actor: "c", actions: 2, seconds: 130 });
  });

  it("skips entries with no timestamp rather than treating absence as zero", () => {
    /* #232: absent is not a value. A zero here would read as an instantaneous turn and drag every
       percentile down -- the measurement would get quieter exactly as the data got worse. */
    const turns = turnsFromLog([
      at(0, "a", 0),
      { index: 1, id: "id1", actor: "a" },
      at(2, "a", 60),
    ]);
    expect(turns).toEqual([{ actor: "a", actions: 2, seconds: 60 }]);
  });
});

describe("the reserve is insurance against absence, not a budget for thinking", () => {
  it("charges nothing for a turn inside the allowance", () => {
    /* THE PROPERTY THE WHOLE DESIGN RESTS ON. A player deliberating for fourteen minutes under a fifteen
       minute allowance burns none of their reserve; it is there for the laptop that closed. */
    const turns = turnsFromLog([at(0, "a", 0), at(1, "b", 14 * 60)]);
    expect(worstBurnSeconds(turns, 15 * 60)).toBe(0);
  });

  it("charges only the overage, and only to the player who ran over", () => {
    const turns = turnsFromLog([
      at(0, "a", 0),
      at(1, "b", 20 * 60), // b's turn: 20 min, 5 over
      at(2, "a", 21 * 60), // a's turn: 1 min, inside
    ]);
    const burn = burnByActor(turns, 15 * 60);
    expect(burn.b).toBe(5 * 60);
    expect(burn.a ?? 0).toBe(0);
  });
});

describe("JUNO-3XD, the game the allowance was chosen from", () => {
  const log = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "sandbox-log-JUNO-3XD.json"), "utf8"),
  ) as { actions: Array<{ index: number; id: string; actor: string; at?: number }> };
  const turns = turnsFromLog(log.actions);

  it("measures the session it was measured from", () => {
    const stats = clockStats(turns);
    /* RANGES, NOT EXACT FIGURES. The point is the shape of the distribution -- turns are dominated by
       sub-minute actions with a thin tail of single-action deliberations -- and an exact assertion would
       break on a re-export without telling anyone anything. */
    expect(stats.turns).toBeGreaterThan(100);
    expect(stats.medianSeconds).toBeLessThan(60);
    expect(stats.p95Seconds).toBeLessThan(5 * 60);
    expect(stats.maxSeconds).toBeLessThan(10 * 60);
  });

  it("does not touch a single player's reserve at the chosen allowance", () => {
    /* THE DECISION, PINNED. 15 minutes was chosen because it clears the longest turn in this session by more
       than double. If someone lowers it far enough to start eating reserves during ordinary play, that
       should be a deliberate change with this test updated beside it -- not something discovered by a
       player who is forfeiting an ante two hours into a game. */
    expect(worstBurnSeconds(turns, LIVE_ALLOWANCE_SECONDS)).toBe(0);
  });

  it("would have bitten at two minutes, which is why the number is not two minutes", () => {
    /* The counter-case, so the test above cannot pass by measuring nothing. */
    expect(worstBurnSeconds(turns, 2 * 60)).toBeGreaterThan(5 * 60);
  });
});
