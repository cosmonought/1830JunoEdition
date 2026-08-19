// frontend/src/utils/logRevert.ts
//
// WHICH ACTIONS STILL COUNT, after the undos.
//
// ==================================================================
//  DESIGN NOTE 591 (cont.): THE LOG IS APPEND-ONLY, THE GAME IS NOT
// ==================================================================
//
// `RevertTo { index }` says "everything from `index` onward did not happen".
// This turns the raw log into the list of actions a client should actually
// apply, and it is deliberately the ONLY place that decision is made -- the
// drain, the undo controls and the tests all ask this one function, so no two
// of them can disagree about what has been undone.
//
// PURE, so it can be tested exhaustively. The hard part of undo in an
// event-sourced system is not the state change, it is agreeing on the
// history; the state change is then just a replay.

import { isRevertToMsg } from "./gameSetup";

/** The shape this needs from a log entry -- structurally compatible with
 *  `SandboxAction` but declared here so this module has no dependency on the
 *  Firestore bridge. */
export interface RevertableAction {
  index: number;
  payload: string;
  actor: string;
}

/** The index a `RevertTo` entry targets, or `null` for an ordinary action.
 *
 *  A corrupt payload reads as an ordinary action rather than throwing: a log
 *  entry nobody can parse must not be able to erase the game, which is the
 *  worst thing an unreadable revert could be allowed to mean. */
export function revertTargetOf(action: { payload: string }): number | null {
  try {
    const parsed: unknown = JSON.parse(action.payload);
    if (!isRevertToMsg(parsed)) return null;
    const target = parsed.RevertTo.index;
    return Number.isFinite(target) ? target : null;
  } catch {
    return null;
  }
}

/**
 * The actions that still count, in order.
 *
 * ==================================================================
 *  DESIGN NOTE 591a: THE LAST REVERT WINS, SO IT IS READ FIRST
 * ==================================================================
 *
 * The first version of this walked FORWARD and popped a kept-list, and its
 * comment claimed that undoing an undo "falls out of the rule rather than
 * needing a special case". A test written against that claim failed
 * immediately, and the claim was wrong for a reason worth keeping: a revert
 * that has been popped is no longer in the kept-list, so a LATER revert
 * reaching back over it has nothing to cancel. Redo was silently impossible,
 * and the comment asserted the opposite.
 *
 * SO IT READS BACKWARD. The last revert is authoritative -- nothing can
 * cancel it, because nothing follows it. It kills every entry in
 * `[target, its own index)`, INCLUDING earlier reverts; and an earlier revert
 * that has been killed no longer takes anything back, which is precisely
 * "undo the undo". One pass, no redo stack, and the property is real this
 * time rather than asserted.
 *
 * `actions` MUST already be sorted by index, which is what
 * `subscribeSandboxLog` guarantees. Sorting here would hide a caller that
 * had stopped guaranteeing it.
 */
export function effectiveActions<T extends RevertableAction>(
  actions: readonly T[],
): T[] {
  const dead = new Set<number>();

  for (let at = actions.length - 1; at >= 0; at -= 1) {
    const action = actions[at];
    // A revert that was itself reverted does nothing.
    if (dead.has(action.index)) continue;
    const target = revertTargetOf(action);
    if (target === null) continue;

    /* The revert is never a game action -- it is an instruction about the
       log, and replaying it would mean the reducer had to know about it. */
    dead.add(action.index);
    for (const other of actions) {
      if (other.index >= target && other.index < action.index) dead.add(other.index);
    }
  }

  return actions.filter((action) => !dead.has(action.index) && revertTargetOf(action) === null);
}

/* ==================================================================
 *  DESIGN NOTE 592: WHO MAY UNDO WHAT
 * ==================================================================
 *
 * INSTRUCTED: "while individual players should be able to undo their own
 * turns, it may be useful for the Host to be able to Undo through all
 * players' turns if necessary" -- with the abuse case named and dismissed:
 * "this could be abused if a Host is petulant, but in that case players
 * would presumably stop playing".
 *
 * That is the right call and worth recording as a principle, because the
 * alternative is a voting mechanism nobody wants in a two-player test game.
 * The protection against a bad host is social, and the log makes it legible:
 * every revert is a permanent entry naming who asked for it, so a host who
 * rewinds other people's turns leaves a record of having done so.
 *
 * TWO REACHES:
 *
 *   ANY PLAYER may undo back to just after their own last action -- which in
 *   practice means "undo my accidental buy", the reported case. They may not
 *   reach past it, because the actions after it are other people's and
 *   undoing those is not theirs to do.
 *
 *   THE HOST may undo to any point, which is what makes "back to the start
 *   of the round" possible when the mistake was three players ago.
 */
export interface UndoReach {
  /** The log index to revert to, or `null` when there is nothing to undo. */
  index: number | null;
  /** What is being taken back, for the button and the log line. */
  summary: string;
  /** Why nothing can be undone, when `index` is `null`. */
  blockedReason: string | null;
}

/**
 * How far back this player may revert.
 *
 * `describe` turns an action into the sentence the log already used for it,
 * so the undo button quotes the move rather than describing it a second way.
 */
export function undoReachFor(
  actions: readonly RevertableAction[],
  player: string,
  isHost: boolean,
  describe: (action: RevertableAction) => string,
): UndoReach {
  const live = effectiveActions(actions);
  if (live.length === 0) {
    return {
      index: null,
      summary: "",
      blockedReason: "There is nothing to undo yet — no action has been taken.",
    };
  }

  const last = live[live.length - 1];

  /* THE HOST reverts the last action whoever took it. Everybody else may
     only reach their own -- and only when it IS the last one, because
     undoing an action with other people's moves stacked on top of it would
     silently take those back too. */
  if (isHost || last.actor === player) {
    return { index: last.index, summary: describe(last), blockedReason: null };
  }

  const mine = [...live].reverse().find((action) => action.actor === player);
  if (!mine) {
    return {
      index: null,
      summary: "",
      blockedReason: "You have not taken an action in this game yet.",
    };
  }
  return {
    index: null,
    summary: "",
    blockedReason:
      "Other players have acted since your last move. Only the host can undo past somebody else's turn.",
  };
}

/**
 * The host's deeper reach: back to the first action after `boundaryIndex`.
 *
 * `boundaryIndex` is the log index of the action that opened the current
 * round -- the caller knows which that is, because it knows what a round
 * boundary looks like and this module deliberately does not.
 */
export function undoToRoundStart(
  actions: readonly RevertableAction[],
  boundaryIndex: number | null,
): UndoReach {
  const live = effectiveActions(actions);
  if (boundaryIndex === null || live.length === 0) {
    return {
      index: null,
      summary: "",
      blockedReason: "This round has no actions to undo.",
    };
  }
  const first = live.find((action) => action.index > boundaryIndex);
  if (!first) {
    return {
      index: null,
      summary: "",
      blockedReason: "This round has no actions to undo.",
    };
  }
  const count = live.filter((action) => action.index >= first.index).length;
  return {
    index: first.index,
    summary: `${count} action${count === 1 ? "" : "s"} back to the start of the round`,
    blockedReason: null,
  };
}
