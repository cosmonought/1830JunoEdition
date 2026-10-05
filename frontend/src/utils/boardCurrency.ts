// frontend/src/utils/boardCurrency.ts
//
/* ==================================================================
    PHASE 3 W3-J (AUD-25.16, OD-19): IS THE BOARD ON SCREEN THE ROOM'S BOARD?
   ==================================================================
   OWNER-OBSERVED: a tab showed a board one turn behind the game and offered the player their turn on it. Three facts
   made that possible (`phase3W3GWatchDefect.test.tsx`):
     - the drain counts an entry applied BEFORE dispatching it and has no catch, so a throw ends the pass with the rest
       of the batch unapplied, the board at rest behind the room, and nothing on screen (the next pass then skips the
       entry for good);
     - a board that has never matched the server's digest is a console note only (`divergenceVerdict`, #1223), so a
       replay that silently disagreed with the room's left the tab behind with no notice either;
     - the room link stamped a click with the position it had RECEIVED, so the server's staleness guard (`baseIndex <
       watermark` -> catch-up, not applied) never fired: the click was judged on a board the player never saw, and
       LANDED when it happened to be legal there.
   OD-19 (RULED 2026-10-04): while replay, catch-up or divergence is unresolved, gameplay controls are non-actionable,
   and the submission must carry, and be bound to, the position actually APPLIED to the board.
   THIS FILE DECIDES NOTHING ABOUT THE GAME. It turns two facts the shell already holds -- a drain that failed, and the
   digest comparison's standing verdict -- into one answer ("current", or why not), and the position the link may stamp
   a submission with. The server's existing anchored staleness guard does the rejecting (`RoomSession.submit` steps
   2-3: behind -> catch-up, ahead -> `ahead`, a different anchor -> `resync`). */

/** A drain pass threw: the board stopped part-way through what the room sent, and later passes skip what it missed. */
export const BOARD_DRAIN_FAILED_NOTICE =
  "This tab could not apply the room's latest moves, so the board on screen is out of date. Reload the page to catch up before you act.";
/** The settle point's digest comparison disagrees: the board on screen is not the room's. */
export const BOARD_DIVERGED_NOTICE =
  "This tab's board does not match the room's, so it is not shown as live. Reload the page to catch up before you act.";
/** A Watch tab (OD-19): the read-only spectator view sends nothing, whoever is signed in. The sentence is the one the
 *  shell already says to a watcher (`undoBlockedReason`). */
export const WATCHING_NO_SEAT = "You are watching this table; you have no seat.";

export type BoardCurrency =
  | { readonly current: true }
  | { readonly current: false; readonly reason: "drain-failed" | "diverged"; readonly notice: string };

export const BOARD_CURRENT: BoardCurrency = Object.freeze({ current: true });

/** Whether the board on screen is the room's, from the two standing facts. A drain failure outranks a divergence:
 *  its board is not merely different, it is incomplete. */
export function boardCurrencyFor(input: {
  /** A drain pass for THIS room threw (latched for the tab's life on the room: later passes skip what it missed). */
  drainFailed: boolean;
  /** The settle point's standing divergence (`divergenceReportedAtRef`): non-null while the last comparison
   *  disagreed -- whether or not the two boards ever agreed before (OD-19: an unresolved divergence is not current). */
  divergedAt: number | null;
}): BoardCurrency {
  if (input.drainFailed) return { current: false, reason: "drain-failed", notice: BOARD_DRAIN_FAILED_NOTICE };
  if (input.divergedAt !== null) return { current: false, reason: "diverged", notice: BOARD_DIVERGED_NOTICE };
  return BOARD_CURRENT;
}

/** Why this tab may not send a gameplay move now (a Watch tab, or a board that is not current), or `null`. */
export function boardSendRefusal(input: { watchOnly: boolean; currency: BoardCurrency }): string | null {
  if (input.watchOnly) return WATCHING_NO_SEAT;
  return input.currency.current ? null : input.currency.notice;
}

/** The position a submission is bound to: the last log entry the board has APPLIED. */
export type AppliedPosition = { readonly index: number; readonly id: string | undefined } | { readonly notCurrent: string };

/** The position the link may stamp a submission with -- the last entry of the log the last COMPLETED drain pass
 *  applied (`-1` before any) -- or why it may stamp none. `log` is the drain's own record of the history it applied
 *  (`sandboxLogRef`, written at the top of each pass; a pass that throws latches `drainFailed`, so a log whose pass
 *  did not complete is never stamped). `replaying` is the drain in progress (a board mid-pass is no position). */
export function appliedPositionFor(input: {
  watchOnly: boolean;
  currency: BoardCurrency;
  replaying: boolean;
  log: ReadonlyArray<{ readonly index: number; readonly id: string }>;
  catchingUpNotice: string;
}): AppliedPosition {
  const refusal = boardSendRefusal(input);
  if (refusal !== null) return { notCurrent: refusal };
  if (input.replaying) return { notCurrent: input.catchingUpNotice };
  const last = input.log.length > 0 ? input.log[input.log.length - 1] : null;
  return last === null ? { index: -1, id: undefined } : { index: last.index, id: last.id };
}
