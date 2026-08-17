// frontend/src/utils/undoTarget.ts
//
// ==================================================================
//  DESIGN NOTE 439: UNDO REWINDS TO A DECISION, NOT TO A STEP
// ==================================================================
//
// REPORTED: pressing Undo after the game has auto-skipped a sub-phase drops
// the player into the sub-phase that was skipped.
//
// The undo stack records one snapshot per dispatch, and the auto-skip and
// forced-withhold effects dispatch real messages. A turn that ran
// Track -> (skip Tokens) -> (skip Routes) -> (withhold $0) therefore left
// four snapshots, three of them recording moves the player never made. One
// press landed on the Dividends step -- and landed there STUCK, because the
// auto-skip guard is keyed by `(corporation, step)` and had already
// recorded that step as handled.
//
// ==================================================================
//  WHY THIS IS A MODULE AND NOT THREE LINES IN THE HANDLER
// ==================================================================
//
// It is index arithmetic over a stack whose entries mean "the state BEFORE
// this action", which is the kind of off-by-one that reads correctly and
// behaves wrongly. Extracted so the walk can be tested against the exact
// sequences that produced the bug, without a React tree, a sandbox reducer
// or a rendered board.
//
// The shell keeps the restore -- which atoms to write, and in what order --
// because that is genuinely its business (design note #310). This owns only
// the question "how far back is the last thing the player chose".

/** The one field of an undo snapshot this reasoning needs. */
export interface UndoStackEntry {
  /** Whether the action this snapshot precedes was dispatched BY THE GAME
   *  rather than by the player. */
  automatic: boolean;
}

/**
 * The index of the snapshot Undo should restore, or `null` when the stack
 * is empty.
 *
 * Walks down from the top past every automatic entry and stops on the first
 * the player created. Restoring that entry undoes their last real action
 * AND every automatic consequence stacked on top of it, which is what one
 * press has always claimed to do.
 *
 * ALL-AUTOMATIC IS A REAL CASE, not a defensive one: a corporation whose
 * whole turn was skipped (no trains, no route, no station slot) produces a
 * stack with no player entry in it at all. Index `0` is then the answer --
 * the oldest thing this stack remembers, and the furthest back Undo can
 * honestly go. Returning `null` there would make the button dead at exactly
 * the moment a player most wants it.
 */
export function undoTargetIndex(stack: readonly UndoStackEntry[]): number | null {
  if (stack.length === 0) return null;
  let target = stack.length - 1;
  while (target > 0 && stack[target].automatic) target -= 1;
  return target;
}

/** How many automatic snapshots a press will discard on the way back --
 *  for the log line, which says so rather than reverting several steps
 *  silently. `0` for an ordinary undo. */
export function undoSkippedCount(stack: readonly UndoStackEntry[]): number {
  const target = undoTargetIndex(stack);
  return target === null ? 0 : stack.length - 1 - target;
}
