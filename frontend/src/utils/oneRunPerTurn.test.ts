/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1183 (harness): $540 WAS $270 TWICE
// ==================================================================
//
// FROM THE EXPORTED LOG of room JUNO-3XD, indices 318 and 319: the same corporation, the same two routes, six
// seconds apart, both stamped `revenue_turn: "7.1.7"`, each carrying its own `revenue_seed`. Index 320 then
// declared dividends on $540 -- exactly twice what those routes earn.
//
// `seedAlreadyRolled` EXISTS TO CATCH THIS AND COULD NOT. It searches the RAW log so an undone run can find
// its earlier roll (#1051), and in a room the raw log does not hold the first run until its snapshot returns.
// The second click outran it, drew a fresh seed, and the revenue landed twice.
//
// THE KEY WAS ALREADY IN THE MESSAGE. `revenue_turn` is round.cycle.corporation, so two runs bearing one key
// are one turn's run sent twice -- and both sides of the check come out of the log, which is what makes this
// safe in a replay where #1174's actor check was not.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const REDUCER = readStripped("utils/sandboxSession.ts");
const STATE = readStripped("utils/gameState.ts");
const ARM = sliceBetween(REDUCER, 'if ("RunMultipleRoutes" in msg) {', "\n  if (\"");

describe("a turn's run is applied once", () => {
  it("reads the key the message already carries", () => {
    expect(ARM).toContain("const runTurnKey = msg.RunMultipleRoutes.revenue_turn;");
  });

  it("refuses a second run bearing a key the board has already applied", () => {
    /* ==================================================================
        NO WINDOW, BECAUSE I HAVE NOW MISSIZED ONE TWICE
       ==================================================================
       #1182's harness used `slice(at, at + 90)` and failed on the arm with the longest reason string; this
       one used 60 and clipped `return state;` at offset 58. Both times the code was correct and the test
       reported on its own width. The refusal is a contiguous block, so it is asserted as one -- a form with
       no number in it cannot be wrong about the number. */
    expect(ARM).toContain(
      [
        "      state.last_run_turn_key === runTurnKey",
        "    ) {",
        "      return state;",
        "    }",
      ].join("\n"),
    );
  });

  it("records the key on the run that succeeds", () => {
    /* Both halves in one arm: a check with nothing writing the field would never fire, which is #712's own
       fault -- a rule encoded as a predicate and never reached. */
    expect(ARM).toContain("{ last_run_turn_key: runTurnKey }");
  });

  it("treats an absent key as absent rather than as a value", () => {
    /* #232's rule. A run from before #1051 carries no `revenue_turn`, and two of those must not collide on
       `undefined` -- which would refuse a legitimate second corporation's run. */
    expect(ARM).toContain('typeof runTurnKey === "string"');
    expect(ARM).toContain('runTurnKey !== ""');
  });

  it("keeps the field on the state the replay rebuilds", () => {
    /* Log-derived on both sides, which is what an undo depends on: reverting drops the first run from the
       effective history, the rebuild never records its key, and the honest re-dispatch is accepted. */
    const at = STATE.indexOf("last_run_turn_key?: string | null;");
    expect(at).toBeGreaterThan(STATE.indexOf("export interface GameStateResponse"));
  });

  it("leaves the seed lookup in place, since it answers the other question", () => {
    /* `seedAlreadyRolled` is not replaced. It exists so an undone-and-rerun turn shows the SAME die face
       (#1051); this stops a turn being run twice at all. Two different questions about one key. */
    expect(readStripped("utils/turnSeed.ts")).toContain("export function seedAlreadyRolled(");
  });
});
