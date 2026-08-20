// Design note #439: undo rewinds to a DECISION, not to a step.
//
// REPORTED: pressing Undo after an auto-skipped sub-phase drops the player into
// the sub-phase that was skipped. The stack recorded one snapshot per dispatch,
// and the auto-skip and forced-withhold effects dispatch real messages -- so a
// turn that ran Track, skip Tokens, skip Routes, withhold $0 left four
// snapshots, three of them moves the player never made. One press landed on
// Dividends and landed there STUCK, because the auto-skip guard is keyed by
// `(corporation, step)` and had already recorded that step as handled.
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN THE HANDLER: it is index
// arithmetic over a stack whose entries mean "the state BEFORE this action",
// which is the kind of off-by-one that reads correctly and behaves wrongly.
// Extracted so the walk can be tested against the exact sequences that produced
// the bug, without a React tree, a reducer or a rendered board. The shell keeps
// the restore (design note #310); this owns only "how far back is the last thing
// the player chose".

/* Design note #475: the walk is gone; automatic actions do not snapshot.

   REPORTED: Undo reverts entire turns. #439's fix -- snapshot every dispatch,
   then WALK PAST the automatic ones -- is what produces this: a corporation
   opens with no trains, three automatic snapshots stack on top of the previous
   player's `PassTurn`, and one press steps past all three and reverts the
   `PassTurn`, landing in the previous corporation's turn.

   Both notes were solving the same problem from the wrong end. If an automatic
   action never enters the history at all, there is nothing to walk past AND
   nothing to land on: #439's bug cannot occur because no snapshot exists for a
   skipped step, and this one cannot occur because Undo never reaches past the
   top entry.

   THE CONSEQUENCES RE-RUN, which is what makes this safe rather than lossy:
   restoring the state before a player's action restores the sub-phase cursor,
   and the caller clears the once-per-(corporation, step) guards so the auto-skip
   effects are free to fire again. Undo returns the player to the decision; the
   game re-derives what followed.

   WHAT SURVIVES of #439 is the `automatic` flag, now read at PUSH time instead
   of at pop time, with a named entry point per producer so an `onClick` event
   object can never be mistaken for the flag.

   See docs/ai_architecture/state_machine.md, undoTarget.ts #439 / #475. */

/** The one field of an undo snapshot this reasoning needs. */
export interface UndoStackEntry {
  /** Whether the action this snapshot precedes was dispatched BY THE GAME rather
   *  than by the player.
   *
   *  Design note #475: an entry with this set should never reach the stack -- the
   *  dispatch path declines to push one. Kept on the type so the invariant is
   *  expressible, and so `undoTargetIndex` below can state it rather than assume. */
  automatic: boolean;
}

/** The index of the snapshot Undo should restore, or `null` when the stack is
 *  empty.
 *
 *  THE TOP ENTRY, always. One press, one action -- what "Undo" means everywhere
 *  else and what design note #475 restores.
 *
 *  The `automatic` guard below is a SAFETY NET, not the mechanism: automatic
 *  dispatches do not push, so a stack should never contain one, and if the
 *  dispatch path regresses, skipping it is better than restoring a state the
 *  player never chose. It is deliberately not #439's walk -- it steps over
 *  automatic entries only to reach the nearest player action, and cannot cross a
 *  turn boundary because `PassTurn` is itself a player action and stops it. */
export function undoTargetIndex(stack: readonly UndoStackEntry[]): number | null {
  if (stack.length === 0) return null;
  let target = stack.length - 1;
  while (target > 0 && stack[target].automatic) target -= 1;
  return target;
}

/** How many entries a press discards beyond the one it restores.
 *
 *  Design note #475: normally `0`, because automatic actions no longer reach the
 *  stack. A non-zero value means the safety net caught something the dispatch
 *  path should not have pushed, and the caller says so in the log rather than
 *  reverting several steps silently. */
export function undoSkippedCount(stack: readonly UndoStackEntry[]): number {
  const target = undoTargetIndex(stack);
  return target === null ? 0 : stack.length - 1 - target;
}
