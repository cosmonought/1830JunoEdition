// frontend/src/utils/logRevert.test.ts
//
// ==================================================================
//  DESIGN NOTE 591 (harness): AGREEING ON HISTORY
// ==================================================================
//
// REPORTED: Undo does nothing — "if a player accidentally buys a share and
// needs to undo their turn, there's no way to do it."
//
// The hard part of undo in an event-sourced game is not the state change. It
// is that every client must agree on WHICH actions still count, from the same
// log, without talking to each other. The state change afterwards is only a
// replay, and a replay has no inverses to get wrong.
//
// So this is where the tests are. `effectiveActions` is the single place that
// decision is made, and every case below is a way two clients could otherwise
// have come to different answers.

import {
  effectiveActions,
  revertTargetOf,
  undoReachFor,
  undoToRoundStart,
  type RevertableAction,
} from "./logRevert";

const ADA = "p-ada";
const BEN = "p-ben";

/* Design note #1026: `id` is required now, and these fixtures mint one from the index. That is EXACTLY the
   identity the old code assumed -- one entry per index -- so every case below keeps testing what it always
   tested. The cases that are about a COLLISION supply their own ids, because minting from the index is the
   thing they need not to do. */
const act = (index: number, actor: string, what = "BuyStock"): RevertableAction => ({
  index,
  id: `a${index}`,
  actor,
  payload: JSON.stringify({ [what]: { game_id: 1 } }),
});

/** Design note #668: an action the GAME dispatched -- the auto-skip walking the
 *  sub-phase cursor, or the forced $0 withhold. It really happened and really
 *  counts; it is simply not a decision anybody made. */
const derived = (
  index: number,
  actor: string,
  what = "AdvanceOperatingSubPhase",
): RevertableAction => ({ ...act(index, actor, what), derived: true });

const revert = (index: number, to: number, actor: string): RevertableAction => ({
  index,
  id: `r${index}`,
  actor,
  payload: JSON.stringify({ RevertTo: { index: to, player: actor, summary: "x" } }),
});

const indices = (actions: readonly RevertableAction[]) => actions.map((a) => a.index);
const describe_ = (a: RevertableAction) => `action ${a.index}`;

describe("revertTargetOf", () => {
  it("reads the target off a revert", () => {
    expect(revertTargetOf(revert(5, 3, ADA))).toBe(3);
  });

  it("returns null for an ordinary action", () => {
    expect(revertTargetOf(act(1, ADA))).toBeNull();
  });

  it("treats an unparseable payload as an ordinary action", () => {
    /* A log entry nobody can read must not be able to erase the game. That
       is the worst available reading of a corrupt revert, so it gets the
       harmless one instead. */
    expect(revertTargetOf({ payload: "{not json" })).toBeNull();
    expect(revertTargetOf({ payload: JSON.stringify({ RevertTo: { index: "x" } }) })).toBeNull();
  });
});

describe("effectiveActions", () => {
  it("keeps everything when nothing was undone", () => {
    const log = [act(0, ADA), act(1, BEN), act(2, ADA)];
    expect(indices(effectiveActions(log))).toEqual([0, 1, 2]);
  });

  it("drops the action a revert reaches back to, and the revert itself", () => {
    /* THE REPORTED CASE: an accidental buy, taken back. The revert is an
       instruction about the log rather than a move, so the reducer never
       sees it. */
    const log = [act(0, ADA), act(1, BEN), act(2, ADA), revert(3, 2, ADA)];
    expect(indices(effectiveActions(log))).toEqual([0, 1]);
  });

  it("drops a whole run when the revert reaches further back", () => {
    const log = [act(0, ADA), act(1, BEN), act(2, ADA), act(3, BEN), revert(4, 1, ADA)];
    expect(indices(effectiveActions(log))).toEqual([0]);
  });

  it("lets play continue after an undo", () => {
    const log = [act(0, ADA), act(1, BEN), revert(2, 1, BEN), act(3, BEN)];
    expect(indices(effectiveActions(log))).toEqual([0, 3]);
  });

  it("undoes an undo, restoring the action the first revert took back", () => {
    /* WRITTEN BEFORE THE IMPLEMENTATION SUPPORTED IT, and it failed --
       which is the whole reason it is here. The first version walked the log
       forward popping a kept-list, so a revert that had been popped was gone
       and a later revert had nothing to cancel. Redo was impossible and the
       code comment claimed it worked.

       Reading backward makes it real: the revert at 3 kills the revert at 2,
       and a dead revert takes nothing back, so action 1 counts again. */
    const log = [act(0, ADA), act(1, BEN), revert(2, 1, BEN), revert(3, 2, BEN)];
    expect(indices(effectiveActions(log))).toEqual([0, 1]);
  });

  it("survives a revert that reaches past the start of the log", () => {
    const log = [act(0, ADA), act(1, BEN), revert(2, 0, ADA)];
    expect(effectiveActions(log)).toEqual([]);
  });

  it("ignores a revert pointing past the end", () => {
    // Nothing at or after that index exists, so nothing is dropped.
    const log = [act(0, ADA), act(1, BEN), revert(2, 99, ADA)];
    expect(indices(effectiveActions(log))).toEqual([0, 1]);
  });

  it("gives the same answer however many times it is asked", () => {
    /* THE PROPERTY EVERY CLIENT DEPENDS ON. Each browser calls this on its
       own snapshot of the log; if it were not a pure function of the list,
       two of them would build different games from one history. */
    const log = [act(0, ADA), act(1, BEN), act(2, ADA), revert(3, 1, ADA), act(4, BEN)];
    const once = indices(effectiveActions(log));
    expect(indices(effectiveActions(log))).toEqual(once);
    expect(indices(effectiveActions([...log]))).toEqual(once);
  });
});

describe("undoReachFor", () => {
  it("lets a player take back their own last action", () => {
    const log = [act(0, BEN), act(1, ADA)];
    const reach = undoReachFor(log, ADA, false, describe_);
    expect(reach.index).toBe(1);
    expect(reach.summary).toBe("action 1");
  });

  it("refuses when somebody else has acted since", () => {
    /* Undoing an action with other people's moves stacked on top would take
       those back too, silently. The message says so rather than the button
       simply failing. */
    const log = [act(0, ADA), act(1, BEN)];
    const reach = undoReachFor(log, ADA, false, describe_);
    expect(reach.index).toBeNull();
    expect(reach.blockedReason).toMatch(/only the host/i);
  });

  it("lets the host reach past somebody else's turn", () => {
    // Design note #592: the protection against a bad host is social, and the
    // log records every revert with the name of whoever asked.
    const log = [act(0, ADA), act(1, BEN)];
    expect(undoReachFor(log, ADA, true, describe_).index).toBe(1);
  });

  it("says so plainly when nothing has happened yet", () => {
    expect(undoReachFor([], ADA, true, describe_).blockedReason).toMatch(/nothing to undo/i);
  });

  it("distinguishes 'you have not acted' from 'you have been overtaken'", () => {
    const log = [act(0, BEN), act(1, BEN)];
    expect(undoReachFor(log, ADA, false, describe_).blockedReason).toMatch(/not taken an action/i);
  });

  it("reads the ALREADY-undone log, not the raw one", () => {
    /* Ada bought at 1, undid it at 2. Her reach is now her earlier action at
       0 -- and if this asked the raw log it would offer to undo an action
       that has already been taken back. */
    const log = [act(0, ADA), act(1, ADA), revert(2, 1, ADA)];
    expect(undoReachFor(log, ADA, false, describe_).index).toBe(0);
  });

  /* ==================================================================
      DESIGN NOTE 668: UNDO LANDS ON A DECISION
     ==================================================================

     REPORTED: Undo during Run Routes "simply refreshes the Run Routes
     action" instead of returning the player to Lay Track or Place Token.

     The top of an Operating Round log is almost never the player's move. The
     auto-skip dispatches a real `AdvanceOperatingSubPhase` to walk the
     cursor onto Routes, so THAT is what a press landed on -- and reverting
     it put the cursor back one step, re-armed the auto-skip (a rebuild
     clears its once-per-turn guards) and advanced straight back to Routes.
     The button worked perfectly and undid nothing anybody had done.

     `undoTarget.ts` #475 settled this for the local stack by never
     snapshotting an automatic dispatch. The room's history is a Firestore
     log that records every dispatch, so the rule has to be applied when
     READING it instead. */

  it("walks past the game's own actions to the player's last decision", () => {
    /* Ada lays a tile; the game then skips Tokens and Routes for her. The
       press must land on the tile lay -- index 0 -- not on the skip at 2. */
    const log = [act(0, ADA, "LayTile"), derived(1, ADA), derived(2, ADA)];
    expect(undoReachFor(log, ADA, false, describe_).index).toBe(0);
  });

  it("quotes the decision, not the step the game walked onto", () => {
    const log = [act(0, ADA, "LayTile"), derived(1, ADA)];
    expect(undoReachFor(log, ADA, false, describe_).summary).toBe("action 0");
  });

  it("still lands on a MANUAL skip, which is a decision", () => {
    /* The Skip button dispatches the same message. #439's split entry points
       are what keep the two apart, and the flag is the whole difference. */
    const log = [act(0, ADA, "LayTile"), act(1, ADA, "AdvanceOperatingSubPhase")];
    expect(undoReachFor(log, ADA, false, describe_).index).toBe(1);
  });

  it("does not let the host land on a derived action either", () => {
    /* The reported case: Player 1 was the host, so the host branch reached
       the top entry -- the auto-skip -- and reverted that. */
    const log = [act(0, BEN, "LayTile"), derived(1, BEN), derived(2, BEN)];
    expect(undoReachFor(log, ADA, true, describe_).index).toBe(0);
  });

  it("judges ownership on the action it would land on, not the top entry", () => {
    /* A derived entry's actor is the SEAT the game acted for, which is not a
       player id. Judging by the top entry told Ada "other players have acted
       since your last move" about the game's own bookkeeping. */
    const log = [act(0, ADA, "LayTile"), derived(1, "juno1prr")];
    const reach = undoReachFor(log, ADA, false, describe_);
    expect(reach.index).toBe(0);
    expect(reach.blockedReason).toBeNull();
  });

  it("still refuses when a real player has acted since", () => {
    // The protection #592 added is unchanged: derived entries are stepped
    // over, another player's move is not.
    const log = [act(0, ADA), act(1, BEN), derived(2, BEN)];
    expect(undoReachFor(log, ADA, false, describe_).index).toBeNull();
  });

  it("says so plainly when the game has acted and nobody else has", () => {
    const log = [derived(0, ADA), derived(1, ADA)];
    const reach = undoReachFor(log, ADA, true, describe_);
    expect(reach.index).toBeNull();
    expect(reach.blockedReason).toMatch(/taken by the game/i);
  });

  it("treats an entry with no flag at all as a decision", () => {
    /* Rooms written before the field existed. Absent must read as "a player
       did this", which is the behaviour those logs already had -- the other
       way round, an old room would have nothing undoable in it. */
    const log = [act(0, ADA, "LayTile"), act(1, ADA, "AdvanceOperatingSubPhase")];
    expect(log.every((entry) => entry.derived === undefined)).toBe(true);
    expect(undoReachFor(log, ADA, false, describe_).index).toBe(1);
  });

  it("leaves effectiveActions alone -- a derived action still happened", () => {
    /* The distinction is about where a press LANDS, not about what counts. A
       revert then removes the derived entries stacked on top anyway, because
       it kills everything from its target onward, and the replay re-derives
       them. */
    const log = [act(0, ADA, "LayTile"), derived(1, ADA), derived(2, ADA)];
    expect(indices(effectiveActions(log))).toEqual([0, 1, 2]);
  });
});

describe("undoToRoundStart", () => {
  it("reaches the first action after the boundary", () => {
    const log = [act(0, ADA), act(1, BEN), act(2, ADA), act(3, BEN)];
    const reach = undoToRoundStart(log, 1);
    expect(reach.index).toBe(2);
    expect(reach.summary).toMatch(/2 actions/);
  });

  it("counts one action in the singular", () => {
    expect(undoToRoundStart([act(0, ADA), act(1, BEN)], 0).summary).toMatch(/1 action back/);
  });

  it("refuses when the round has not been acted in", () => {
    const log = [act(0, ADA), act(1, BEN)];
    expect(undoToRoundStart(log, 1).index).toBeNull();
    expect(undoToRoundStart(log, null).index).toBeNull();
  });

  it("skips actions already undone", () => {
    const log = [act(0, ADA), act(1, BEN), act(2, ADA), revert(3, 2, ADA)];
    const reach = undoToRoundStart(log, 0);
    expect(reach.index).toBe(1);
    expect(reach.summary).toMatch(/1 action back/);
  });
});
