// frontend/src/utils/undoTarget.test.ts
//
// ==================================================================
//  DESIGN NOTE 439 (harness): THE SEQUENCES THAT PRODUCED THE BUG
// ==================================================================
//
// The tests below are named after real turns rather than after list shapes,
// because the bug was never about lists -- it was about which of a turn's
// dispatches were the player's. Reading them should tell you what a
// corporation did, not what an array contained.

import { undoSkippedCount, undoTargetIndex } from "./undoTarget";

/** A snapshot the player created -- a click. */
const manual = { automatic: false };
/** A snapshot the game created -- an auto-skip or a forced withhold. */
const auto = { automatic: true };

describe("undoTargetIndex", () => {
  it("returns null for an empty stack", () => {
    expect(undoTargetIndex([])).toBeNull();
  });

  it("takes the top entry when the player acted last", () => {
    expect(undoTargetIndex([manual, manual])).toBe(1);
  });

  it("walks past the auto-skips of a trainless turn", () => {
    // The reported case: lay a tile, then the game skips Tokens, skips
    // Routes and forces a $0 withhold. One press should undo the TILE.
    const turn = [manual, auto, auto, auto];
    expect(undoTargetIndex(turn)).toBe(0);
    expect(undoSkippedCount(turn)).toBe(3);
  });

  it("stops at the most recent player action, not the oldest", () => {
    // Two turns' worth: an older manual action must not be reached past a
    // newer one.
    const twoTurns = [manual, auto, manual, auto];
    expect(undoTargetIndex(twoTurns)).toBe(2);
    expect(undoSkippedCount(twoTurns)).toBe(1);
  });

  it("undoes a single automatic action when that is all there is", () => {
    // A corporation whose entire turn was skipped leaves no player entry.
    // Index 0 is the furthest back this stack can honestly go; returning
    // null would make Undo dead at the moment it is most wanted.
    expect(undoTargetIndex([auto])).toBe(0);
    expect(undoTargetIndex([auto, auto, auto])).toBe(0);
  });

  it("reports how many automatic steps a press discards", () => {
    expect(undoSkippedCount([])).toBe(0);
    expect(undoSkippedCount([manual])).toBe(0);
    expect(undoSkippedCount([manual, auto])).toBe(1);
    expect(undoSkippedCount([manual, auto, auto])).toBe(2);
  });

  it("never targets an index outside the stack", () => {
    for (const stack of [[manual], [auto], [manual, auto], [auto, manual], [auto, auto]]) {
      const target = undoTargetIndex(stack);
      expect(target).not.toBeNull();
      expect(stack[target!]).toBeDefined();
    }
  });
});

describe("repeated presses walk back through a turn", () => {
  it("reaches each player action in turn, skipping what the game did", () => {
    // Lay tile -> [skip Tokens] -> run route -> [forced withhold]
    let stack: Array<{ automatic: boolean }> = [manual, auto, manual, auto];
    const landings: number[] = [];

    for (let press = 0; press < 2; press += 1) {
      const target = undoTargetIndex(stack);
      expect(target).not.toBeNull();
      landings.push(target!);
      stack = stack.slice(0, target!);
    }

    // First press lands on the route run (index 2), second on the tile lay
    // (index 0). Neither lands on an automatic step.
    expect(landings).toEqual([2, 0]);
    expect(stack).toEqual([]);
  });

  it("empties the stack rather than looping", () => {
    let stack: Array<{ automatic: boolean }> = [manual, auto, auto];
    let presses = 0;
    while (undoTargetIndex(stack) !== null && presses < 10) {
      stack = stack.slice(0, undoTargetIndex(stack)!);
      presses += 1;
    }
    expect(stack).toEqual([]);
    expect(presses).toBe(1);
  });
});
