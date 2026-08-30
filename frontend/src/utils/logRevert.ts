// Which actions still count, after the undos.
//
// Design note #591 (cont.): `RevertTo { index }` says "everything from `index`
// onward did not happen". This is deliberately the ONLY place that decision is
// made -- the drain, the undo controls and the tests all ask this one function.
//
// PURE, so it can be tested exhaustively. The hard part of undo in an
// event-sourced system is not the state change, it is agreeing on the history;
// the state change is then just a replay.
//
// See docs/ai_architecture/firebase_middleware.md, logRevert.ts #591.

import { isRevertToMsg } from "./gameSetup";

/** The shape this needs from a log entry -- structurally compatible with
 *  `SandboxAction` but declared here so this module has no dependency on the
 *  Firestore bridge. */
export interface RevertableAction {
  index: number;
  /** ==================================================================
   *   DESIGN NOTE 1026: THE ENTRY'S OWN IDENTITY, WHICH `index` WAS STANDING IN FOR
   *  ==================================================================
   *
   * REPORTED, of a room that rebuilt shorter than it had been: "restarting the server caused the active game
   * room to roll back to a much earlier state."
   *
   * `dead` WAS A `Set<number>` OF INDICES, and indices were not unique. `appendSandboxAction` took the index
   * from the caller and wrote it unchecked (#1026 there), so two clients dispatching at once both wrote the
   * same one -- and `SandboxAction`'s own field comment has said so all along: the document id is "the
   * deterministic tie-break for two entries that raced onto the same index."
   *
   * SO ONE `RevertTo` KILLED BOTH. An undo aimed at a shared index marked that number dead, and the filter
   * then dropped every entry carrying it -- including the one nobody undid. Invisible while a client holds
   * the game in memory, and permanent from the next replay onward, which is exactly the shape of the report.
   *
   * REQUIRED, NOT OPTIONAL. An `id?: string` with a fallback to `index` would reproduce the bug for every
   * caller that forgot it, silently. Making it required turns each such caller into a type error, which is
   * the difference between a fix and a convention. */
  id: string;
  payload: string;
  actor: string;
  /** Design note #668: the game dispatched this, not the player. Optional
   *  because `effectiveActions` neither reads nor needs it -- a derived action
   *  really happened and really counts. Only `undoReachFor` cares, and only
   *  about where a press LANDS. */
  derived?: boolean;
}

/** The index a `RevertTo` entry targets, or `null` for an ordinary action.
 *
 *  A corrupt payload reads as an ordinary action rather than throwing: a log
 *  entry nobody can parse must not be able to erase the game, which is the worst
 *  thing an unreadable revert could be allowed to mean. */
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

/** The actions that still count, in order.
 *
 *  Design note #591a: THE LAST REVERT WINS, SO IT IS READ FIRST. The first
 *  version walked forward and popped a kept-list, claiming undo-the-undo "falls
 *  out of the rule" -- and a test failed immediately, because a revert that has
 *  been popped is no longer in the kept-list, so a LATER revert reaching over it
 *  has nothing to cancel. Redo was silently impossible and the comment asserted
 *  the opposite.
 *
 *  Reading BACKWARD, the last revert is authoritative: nothing follows it, so
 *  nothing can cancel it. It kills every entry in `[target, its own index)`
 *  INCLUDING earlier reverts, and a killed revert no longer takes anything back
 *  -- which is precisely "undo the undo". One pass, no redo stack.
 *
 *  `actions` MUST already be sorted by index, which `subscribeSandboxLog`
 *  guarantees. Sorting here would hide a caller that had stopped guaranteeing it. */
export function effectiveActions<T extends RevertableAction>(
  actions: readonly T[],
): T[] {
  const dead = new Set<string>();

  for (let at = actions.length - 1; at >= 0; at -= 1) {
    const action = actions[at];
    // A revert that was itself reverted does nothing.
    if (dead.has(action.id)) continue;
    const target = revertTargetOf(action);
    if (target === null) continue;

    /* The revert is never a game action -- it is an instruction about the
       log, and replaying it would mean the reducer had to know about it. */
    dead.add(action.id);
    /* ==================================================================
       DESIGN NOTE 1026: THE RANGE IS STILL INDICES; THE KILL LIST IS IDENTITIES
       ==================================================================
       `RevertTo { index }` means "everything from here onward did not happen", which is a statement about
       POSITIONS -- so the range test keeps reading `index` and is unchanged.
       WHAT CHANGES IS WHAT GETS MARKED. Each entry in that range is killed by its own id, so an entry that
       merely shares a number with one of them survives. `< action.index` also leaves an entry sitting on the
       revert's own index alive: whether an undo swallows something written at the same instant is genuinely
       ambiguous, and this fix exists to stop valid actions being destroyed, so the ambiguous case resolves
       toward keeping them. Once allocation is transactional (#1026 in `sandboxRoom.ts`) no new log can
       produce the case at all -- this is what protects the logs that already have. */
    for (const other of actions) {
      if (other.index >= target && other.index < action.index) dead.add(other.id);
    }
  }

  return actions.filter((action) => !dead.has(action.id) && revertTargetOf(action) === null);
}

/* Design note #592: who may undo what. INSTRUCTED that players undo their own
   turns and the host may reach further, with the abuse case named and dismissed
   -- "this could be abused if a Host is petulant, but in that case players would
   presumably stop playing". The alternative is a voting mechanism nobody wants
   in a two-player test game, and the log makes the protection legible: every
   revert is a permanent entry naming who asked for it.

   ANY PLAYER may undo back to just after their own last action, and no further
   -- the actions after it are other people's. THE HOST may undo to any point,
   which is what makes "back to the start of the round" possible. */
export interface UndoReach {
  /** The log index to revert to, or `null` when there is nothing to undo. */
  index: number | null;
  /** What is being taken back, for the button and the log line. */
  summary: string;
  /** Why nothing can be undone, when `index` is `null`. */
  blockedReason: string | null;
}

/** How far back this player may revert.
 *
 *  `describe` turns an action into the sentence the log already used for it, so
 *  the undo button quotes the move rather than describing it a second way.
 *
 *  Design note #668: UNDO LANDS ON A DECISION, NOT ON WHATEVER IS ON TOP.
 *
 *  REPORTED: Undo during Run Routes "simply refreshes the Run Routes action"
 *  instead of returning the player to Lay Track or Place Token. The top of the
 *  log in an Operating Round is almost never the player's move -- it is the
 *  auto-skip's `AdvanceOperatingSubPhase`, dispatched by the game to walk the
 *  cursor onto Routes. Reverting THAT put the cursor back one step, the auto-skip
 *  effect re-armed (a rebuild clears its once-per-turn guards) and it advanced
 *  straight back to Routes. The press was working perfectly and undoing nothing a
 *  player had done.
 *
 *  `undoTarget.ts` #475 settled this for the local stack -- automatic dispatches
 *  do not snapshot -- but the room's history is a Firestore log that records
 *  every dispatch, so the same rule has to be applied when READING it. Walking
 *  back to the last non-derived action is that rule. The revert then removes the
 *  derived entries stacked on top too, because `RevertTo` kills everything from
 *  its target onward and the game re-derives them on replay -- which is the
 *  property that makes this safe rather than lossy.
 *
 *  Ownership is judged on the action Undo would LAND on, not on the top entry: a
 *  derived action's actor is the seat the game acted for, so a player was told
 *  "other players have acted since your last move" about the game's own
 *  bookkeeping. */
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

  /* The topmost entry a player actually chose. `findLast` is ES2023 and this
     builds to es5, so the reverse-find idiom the rest of this module already
     uses stands in for it. */
  const last = [...live].reverse().find((action) => action.derived !== true);
  if (!last) {
    return {
      index: null,
      summary: "",
      blockedReason:
        "There is nothing to undo yet — every action so far was taken by the game.",
    };
  }

  /* THE HOST reverts the last action whoever took it. Everybody else may
     only reach their own -- and only when it IS the last one, because
     undoing an action with other people's moves stacked on top of it would
     silently take those back too. */
  if (isHost || last.actor === player) {
    return { index: last.index, summary: describe(last), blockedReason: null };
  }

  /* Design note #668: derived entries are excluded here too. An auto-skip
     recorded against this player's seat is not an action they have "taken", and
     counting it would answer "you have not acted yet" with the wrong message. */
  const mine = [...live]
    .reverse()
    .find((action) => action.actor === player && action.derived !== true);
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

/** The host's deeper reach: back to the first action after `boundaryIndex`.
 *
 *  `boundaryIndex` is the log index of the action that opened the current round
 *  -- the caller knows which that is, because it knows what a round boundary
 *  looks like and this module deliberately does not. */
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
