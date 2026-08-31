/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 876 (harness): A SKIP THAT LOGGED ITSELF AND DID NOTHING
// ==================================================================
//
// ASKED: "When a corporation is at the train limit, I think the game should auto-skip to end their turn
// instead of making them click it. When a corporation is not at the train limit but does not have enough
// money to buy from the bank, it can still buy from another corporation, so it's fine to make these
// corporations manually end their turn."
//
// THE RULE WAS ALREADY WRITTEN AND DID NOTHING. `autoSkipReason` has named the train limit since #249, and
// the effect reading it dispatched `AdvanceOperatingSubPhase` -- which `nextSubPhase` turns into a no-op at
// the end of the list. The guard then marked the turn handled, so it fired once, wrote a log line claiming a
// skip, and never ran again. A reader of the Activity Log would have seen the feature working.

import { autoSkipExit } from "./autoSkipExit";
import type { OperatingSubPhase } from "../components/OperatingSubPhaseStepper";

/** The full sequence, and the one with `BuyPrivate` already spent -- both real. */
const FULL: readonly OperatingSubPhase[] = [
  "BuyPrivate",
  "Track",
  "Tokens",
  "Routes",
  "Dividends",
  "Hardware",
];
const AFTER_PRIVATES: readonly OperatingSubPhase[] = [
  "Track",
  "Tokens",
  "Routes",
  "Dividends",
  "Hardware",
];

describe("skipping the last step ends the turn", () => {
  it("ends the turn on Buy Trains", () => {
    /* THE REPORTED CASE. `AdvanceOperatingSubPhase` here is the no-op that made the feature invisible. */
    expect(autoSkipExit("Hardware", FULL)).toBe("end-turn");
  });

  it("advances on every step that has a successor", () => {
    FULL.slice(0, -1).forEach((step) => {
      expect(autoSkipExit(step, FULL)).toBe("advance");
    });
  });

  it("follows the list rather than the name", () => {
    /* `stepsFor` DROPS `BuyPrivate` once the last private is bought, and #613 varies the list by phase. A
       hardcoded `=== "Hardware"` would agree with this by luck today and stop agreeing the moment the order
       changes; asking for the last POSITION keeps the shell and the reducer on one answer. */
    expect(autoSkipExit("Hardware", AFTER_PRIVATES)).toBe("end-turn");
    expect(autoSkipExit("Dividends", AFTER_PRIVATES)).toBe("advance");
    // And the proof that the predicate is positional: make Dividends last and it ends the turn.
    expect(autoSkipExit("Dividends", ["Track", "Dividends"])).toBe("end-turn");
    expect(autoSkipExit("Hardware", ["Track", "Dividends"])).toBe("advance");
  });
});

describe("it refuses to end a turn it cannot account for", () => {
  it("advances for a step the list does not contain", () => {
    /* THE SAFER OF TWO MISTAKES. A cursor naming a step this game does not have is a disagreement between two
       parts of the app; `settleSubPhase` exists to absorb exactly that, whereas an unearned `PassTurn` takes
       somebody's turn away with nothing to catch it. */
    expect(autoSkipExit("BuyPrivate", AFTER_PRIVATES)).toBe("advance");
  });

  it("advances with no step and with no list", () => {
    expect(autoSkipExit(null, FULL)).toBe("advance");
    expect(autoSkipExit("Hardware", [])).toBe("advance");
  });
});

describe("the shell wires it, and only for the train limit", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  };
  const APP = read("App.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("chooses the exit from the reducer's own list", () => {
    /* `stepsFor` IS THE REDUCER'S FUNCTION. Asking a second list here is how the shell and the reducer come
       to disagree about where the turn ends -- the failure this codebase keeps finding. */
    expect(APP).toContain("autoSkipExit(orSubPhase, stepsFor(gameState))");
    expect(APP).toContain('if (exit === "end-turn") endTurnAutomatically();');
    /* Design note #1070: the call carries the shell's own reason now, so the one line the skip prints can
       say WHY rather than just that. What this case is for is unchanged: the two exits are the automatic
       entry points, so Undo rewinds past a turn the game ended on the player's behalf. */
    expect(APP).toContain("else skipSubPhaseAutomatically(autoSkipReason);");
  });

  it("ends the turn through the automatic entry point", () => {
    /* #439: automatic dispatches carry `{ automatic, derived }` so Undo rewinds PAST a turn the game ended
       on the player's behalf, rather than stopping at it and asking them to undo it twice. */
    const at = APP.indexOf("const endTurnAutomatically");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, at + 400);
    expect(body).toContain('"PassTurn"');
    expect(body).toContain("{ automatic: true, derived: true }");
  });

  it("never auto-ends a turn for want of money", () => {
    /* THE OTHER HALF OF THE REQUEST, and it needs no code because the predicate was never about money:
       "When a corporation is not at the train limit but does not have enough money to buy from the bank, it
       can still buy from another corporation, so it's fine to make these corporations manually end their
       turn." `atTrainLimitNow` counts trains against the limit and consults no treasury -- asserted so a
       future convenience cannot quietly add one. */
    const at = APP.indexOf("const atTrainLimitNow");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf("}, [gameState, actingProtocolId, depot]);", at));
    expect(body).toContain("isTrainLocked(");
    expect(body).not.toContain("treasury");
    expect(body).not.toContain("cash");
    // And the Hardware arm of the reason names the limit and nothing else.
    expect(APP).toContain('if (orSubPhase === "Hardware" && atTrainLimitNow) {');
  });

  it("still refuses to act on an unreported fleet", () => {
    /* `owned_trains` UNDEFINED IS NOT AN EMPTY FLEET. Ending a turn on a guess about what a corporation owns
       is the one failure worse than making the player click. */
    const at = APP.indexOf("const atTrainLimitNow");
    const body = APP.slice(at, APP.indexOf("}, [gameState, actingProtocolId, depot]);", at));
    expect(body).toContain("if (owned === undefined) return false;");
  });
});
