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

const act = (index: number, actor: string, what = "BuyStock"): RevertableAction => ({
  index,
  actor,
  payload: JSON.stringify({ [what]: { game_id: 1 } }),
});

const revert = (index: number, to: number, actor: string): RevertableAction => ({
  index,
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
