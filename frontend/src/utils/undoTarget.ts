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

/* ==================================================================
 *  DESIGN NOTE 475: THE WALK IS GONE; AUTOMATIC ACTIONS DO NOT SNAPSHOT
 * ==================================================================
 *
 * REPORTED: Undo reverts entire turns -- pushing a player back to the start
 * of a sub-phase, or undoing the PREVIOUS player's turn outright.
 *
 * Design note #439 fixed the opposite complaint (Undo landing inside an
 * auto-skipped step) by pushing a snapshot for every dispatch and then
 * WALKING PAST the automatic ones. That walk is what produces this
 * complaint, and the mechanism is exact:
 *
 *   A corporation's turn opens. It has no trains, so the game auto-skips
 *   Routes, auto-skips Tokens and forces a $0 withhold -- three automatic
 *   snapshots on top of the previous player's `PassTurn`. The player, who
 *   has not yet done anything, presses Undo. The walk steps down past all
 *   three, finds the `PassTurn` as the last PLAYER action, and reverts it
 *   -- landing them in the previous corporation's turn.
 *
 * Both notes were solving the same problem from the wrong end. If an
 * automatic action never enters the history at all, there is nothing to
 * walk past AND nothing to land on: the stack contains only decisions the
 * player made, and Undo pops exactly one.
 *
 *   #439's bug   cannot occur -- no snapshot exists for a skipped step, so
 *                Undo cannot restore one.
 *   THIS bug     cannot occur -- Undo never reaches past the top entry, so
 *                it cannot cross a turn boundary the player did not create.
 *
 * THE CONSEQUENCES RE-RUN, which is what makes this safe rather than lossy.
 * Restoring the state before a player's action also restores the sub-phase
 * cursor, and the auto-skip effects recompute from there -- see the caller,
 * which clears their once-per-(corporation, step) guards on undo so they
 * are free to fire again. Undo returns the player to the decision; the
 * game re-derives what followed from it.
 *
 * WHAT SURVIVES of #439 is the `automatic` flag itself, now read at PUSH
 * time instead of at pop time. Its two producers are unchanged: the
 * sub-phase auto-skip and the forced $0 withhold, each with its own named
 * entry point so an `onClick` event object can never be mistaken for the
 * flag (that hazard is recorded in the caller and has not gone away).
 */

/** The one field of an undo snapshot this reasoning needs. */
export interface UndoStackEntry {
  /** Whether the action this snapshot precedes was dispatched BY THE GAME
   *  rather than by the player.
   *
   *  Design note #475: an entry with this set should never reach the stack
   *  -- the dispatch path declines to push one. It is kept on the type so
   *  the invariant is expressible, and so `undoTargetIndex` below can state
   *  it rather than assume it. */
  automatic: boolean;
}

/**
 * The index of the snapshot Undo should restore, or `null` when the stack
 * is empty.
 *
 * THE TOP ENTRY, always. One press, one action -- which is what "Undo"
 * means everywhere else and what design note #475 restores.
 *
 * The `automatic` guard below is a SAFETY NET, not the mechanism. Automatic
 * dispatches do not push, so a stack should never contain one; if the
 * dispatch path ever regresses and lets one through, skipping it here is
 * better than restoring a state the player never chose. It is deliberately
 * not the walk #439 built: it steps over automatic entries only to reach
 * the nearest player action, and cannot cross a turn boundary because
 * `PassTurn` is itself a player action and stops it.
 */
export function undoTargetIndex(stack: readonly UndoStackEntry[]): number | null {
  if (stack.length === 0) return null;
  let target = stack.length - 1;
  while (target > 0 && stack[target].automatic) target -= 1;
  return target;
}

/** How many entries a press discards beyond the one it restores.
 *
 *  Design note #475: normally `0`, because automatic actions no longer
 *  reach the stack. A non-zero value means the safety net above caught
 *  something the dispatch path should not have pushed, and the caller says
 *  so in the log rather than reverting several steps silently. */
export function undoSkippedCount(stack: readonly UndoStackEntry[]): number {
  const target = undoTargetIndex(stack);
  return target === null ? 0 : stack.length - 1 - target;
}
