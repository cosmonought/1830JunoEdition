// frontend/src/utils/undoTarget.test.ts
//
// ==================================================================
//  DESIGN NOTE 475 (harness): ONE PRESS, ONE ACTION
// ==================================================================
//
// This file previously tested design note #439's WALK -- push a snapshot for
// every dispatch, then step down past the automatic ones. Those tests passed
// and the behaviour was wrong: a corporation whose turn opened with three
// auto-skips stacked three automatic entries on the previous player's
// `PassTurn`, and one press walked all the way down to it and reverted
// somebody else's turn.
//
// The contract is now the simpler one. Automatic dispatches never enter the
// stack, so it holds only decisions the player made and Undo takes the top
// one. The tests are rewritten to describe that rather than adapted to keep
// passing -- a test suite that survives a contract change unchanged is
// usually testing the implementation.
//
// THE WALK SURVIVES AS A SAFETY NET and is tested as one. If the dispatch
// path ever regresses and pushes an automatic entry, stepping over it beats
// restoring a state the player never chose -- but that is a defect path, and
// the tests say so.

import { undoSkippedCount, undoTargetIndex } from "./undoTarget";

/** A snapshot the player created -- a click. The only kind the dispatch
 *  path pushes. */
const manual = { automatic: false };
/** A snapshot an automatic action created. Design note #475: this should
 *  never reach the stack; it appears below only in the safety-net tests. */
const auto = { automatic: true };

describe("undoTargetIndex -- one press, one action", () => {
  it("returns null for an empty stack", () => {
    expect(undoTargetIndex([])).toBeNull();
  });

  it("takes the top entry", () => {
    expect(undoTargetIndex([manual])).toBe(0);
    expect(undoTargetIndex([manual, manual])).toBe(1);
    expect(undoTargetIndex([manual, manual, manual])).toBe(2);
  });

  it("discards nothing on an ordinary press", () => {
    // The reported bug was Undo reverting MORE than one action. With no
    // automatic entries in the stack there is nothing to discard.
    for (const stack of [[manual], [manual, manual], [manual, manual, manual]]) {
      expect(undoSkippedCount(stack)).toBe(0);
    }
  });

  it("steps back exactly one action per press", () => {
    // A turn's worth of player actions: lay tile, place token, run route,
    // declare dividends. Four presses, four steps, in reverse order.
    let stack: Array<{ automatic: boolean }> = [manual, manual, manual, manual];
    const landings: number[] = [];
    while (undoTargetIndex(stack) !== null) {
      const target = undoTargetIndex(stack)!;
      landings.push(target);
      stack = stack.slice(0, target);
    }
    expect(landings).toEqual([3, 2, 1, 0]);
    expect(stack).toEqual([]);
  });

  it("never reverts past a turn boundary the player did not create", () => {
    /* THE REPORTED BUG, as a property rather than a scenario.
       `PassTurn` is a player action, so it occupies a stack slot of its own.
       One press from the state after it restores the state before it -- and
       cannot reach the previous player's earlier actions, whatever
       preceded. */
    const previousPlayersTurn = [manual, manual];
    const passTurn = [...previousPlayersTurn, manual];
    expect(undoTargetIndex(passTurn)).toBe(passTurn.length - 1);
    expect(undoSkippedCount(passTurn)).toBe(0);
  });
});

describe("the safety net -- automatic entries should not be here", () => {
  it("steps over one that slipped through rather than restoring it", () => {
    // Restoring a state the player never chose is the worse failure of the
    // two, so the net prefers the nearest real decision.
    expect(undoTargetIndex([manual, auto])).toBe(0);
  });

  it("reports how many it stepped over, so the caller can say so", () => {
    // A non-zero count means the dispatch path pushed something it should
    // not have -- the log surfaces it rather than quietly reverting more
    // than one step.
    expect(undoSkippedCount([manual, auto])).toBe(1);
    expect(undoSkippedCount([manual, auto, auto])).toBe(2);
  });

  it("still stops at the most recent player action, not the oldest", () => {
    expect(undoTargetIndex([manual, auto, manual, auto])).toBe(2);
  });

  it("falls back to the oldest entry when every entry is automatic", () => {
    // Nothing else to offer, and a dead Undo button would be worse.
    expect(undoTargetIndex([auto])).toBe(0);
    expect(undoTargetIndex([auto, auto, auto])).toBe(0);
  });

  it("never targets an index outside the stack", () => {
    for (const stack of [[manual], [auto], [manual, auto], [auto, manual], [auto, auto]]) {
      const target = undoTargetIndex(stack);
      expect(target).not.toBeNull();
      expect(stack[target!]).toBeDefined();
    }
  });
});

describe("repeated presses", () => {
  it("empty the stack rather than looping", () => {
    let stack: Array<{ automatic: boolean }> = [manual, manual, manual];
    let presses = 0;
    while (undoTargetIndex(stack) !== null && presses < 10) {
      stack = stack.slice(0, undoTargetIndex(stack)!);
      presses += 1;
    }
    expect(stack).toEqual([]);
    expect(presses).toBe(3);
  });

  it("take one press per player action, not one per turn", () => {
    // The distinction the report turns on: three actions in a turn must
    // cost three presses to unwind, not one.
    const oneTurn = [manual, manual, manual];
    let stack: Array<{ automatic: boolean }> = oneTurn;
    let presses = 0;
    while (undoTargetIndex(stack) !== null) {
      stack = stack.slice(0, undoTargetIndex(stack)!);
      presses += 1;
    }
    expect(presses).toBe(oneTurn.length);
  });
});
