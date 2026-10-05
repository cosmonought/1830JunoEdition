// frontend/src/utils/actionLatch.ts
//
/* ==================================================================
    PHASE 3 W3-B (AUD-25.01 / U-46): THE ACTION LATCH, BOUNDED BY THE LINK -- NOT BY THE CLOCK
   ==================================================================
   The shell's in-flight latch (#1173) greys every gameplay control from a player's press until THAT press is applied
   (the drain releases it against the index it was taken at), with a six-second backstop so a write that failed or a
   listener that dropped can never strand a player (#1173: "a stuck latch is a worse bug than the one it prevents").

   W3-G FOUND THE BACKSTOP FIRING WHILE THE ROOM LINK STILL HELD THE SUBMISSION. On the server path `link.submit` does
   not settle while the socket is down (#1253 queues it for the next hello) or while the server is still committing it
   (LIVE-3A `unavailable`), so after six seconds the OR bar, the Stock Round's Buy / Sell / Pass, the consent prompts
   and the W2-G emergency modal re-armed while the link's queue (W3-I) still said "queued" or "sending" -- and a second
   press became a second message that could legally land (a second sale). Only the par prompt and the three offer
   forms read the queue.

   THE LINK IS THE LONG-DURATION GUARD. Two rules, one answer for every control that reads `actionInFlight`:
     1. BUSY while the link holds a submission from this tab, latch or no latch. (When W3-B's AUD-25.01 landed, the
        `automatic`-flagged presses -- the par answer, the M&H exchange, a home station, Undo -- took no latch yet still
        travelled the link; since W3-B's P3-N021 RED R1 commit every press but a `derived` one takes it.) Every message
        on this link is a game-log submission (`ServerLink.submit` is called from the gameplay dispatch alone), so a
        held one means the board every control is judging is stale.
     2. THE BACKSTOP DOES NOT RUN WHILE THE LINK HOLDS. It starts (afresh) only once the link holds nothing, so the
        ordinary releases decide: the drain on the landed entry (the link settles an `applied` frame in the same turn
        that hands the entries to the shell, whose drain applies them later -- releasing at the link's settlement
        instead would re-arm the controls on a board one round trip old, #1173's own window), the refusal / dropped
        `null` in the submit half, and the backstop only for what neither of those answers.
   RECORDED RESIDUAL (W3-B independent review, LOW): the drain releases the latch by INDEX, so if another seat's entry
   carries the drain past the press's index while the link still holds the press, rule 1 alone keeps the controls busy;
   when the press's own `applied` answer then settles, they re-arm for the drain's few milliseconds before it applies
   that entry. Narrowing that window needs the drain to report the link's own index (RED R5); the baseline re-armed for
   the whole hold. The server still judges any press made in it.
   Without a room link (the Firestore / hotseat path) the queue is idle and the latch behaves exactly as before.

   THE LATCH ITSELF STAYS THE SHELL'S STATE (`useState` in App.tsx, set by the submit half and released by the drain,
   both RED and untouched); this hook only bounds its backstop and answers the busy question.

   NOT AUTHORITY, like #1173 itself: this decides nothing about legality and adds no queue model -- it reads W3-I's
   one view (`linkQueueView(...).blocked`, i.e. `unsettled > 0`) and only greys controls; the dispatch gate is
   unchanged (#916's route loop and #1077's multi-train buy still send several messages from one press). */

import { useEffect, type Dispatch, type SetStateAction } from "react";

import { LINK_SENDING_NOTE, type LinkQueueView } from "./useLinkQueue";

/** The shell's busy answer: a press of this tab's is latched, or the room link still holds one of its submissions. */
export function actionLatchBusy(pendingAppendIndex: number | null, linkHolds: boolean): boolean {
  return pendingAppendIndex !== null || linkHolds;
}

/**
 * The shell's action latch (#1173), bounded by the room link (W3-B). Returns every gameplay control's in-flight flag.
 *
 * @param pendingAppendIndex    the latched press's log index (`null`: no press latched) -- the shell's state.
 * @param setPendingAppendIndex its setter; the backstop releases through it.
 * @param linkHolds             the active room link still holds a submission from this tab
 *                              (`linkQueueView(queue).blocked`); always `false` without a room link.
 * @param backstopMs            how long a latch may stand once the link holds nothing (`ACTION_LATCH_BACKSTOP_MS`).
 */
export function useActionLatch(
  pendingAppendIndex: number | null,
  setPendingAppendIndex: Dispatch<SetStateAction<number | null>>,
  linkHolds: boolean,
  backstopMs: number,
): boolean {
  /* Design note #1173: never longer than a plausible round trip -- once the link has let go (W3-B). */
  useEffect(() => {
    if (pendingAppendIndex === null || linkHolds) return undefined;
    const timer = window.setTimeout(() => setPendingAppendIndex(null), backstopMs);
    return () => window.clearTimeout(timer);
  }, [pendingAppendIndex, setPendingAppendIndex, linkHolds, backstopMs]);
  return actionLatchBusy(pendingAppendIndex, linkHolds);
}

/* ==================================================================
    PHASE 3 W3-B (AUD-14.06): THE ONE SENTENCE FOR THE ONE FLAG
   ==================================================================
   The surfaces AUD-14.06 latched (the licence modal, the private-power modal, the auction prompt, the token confirm,
   Undo) say why they are greyed in the words the Stocks tab already uses for the same held press (W3-J AUD-25.10 (c)):
   the link's own sentence while it holds one of this tab's submissions ("Queued -- will send on reconnect." while it
   waits for a socket), otherwise the latch's. `null` when nothing is in flight. A READING of `actionInFlight` and W3-I's
   view, never a second busy state: it cannot be busy when the flag is not. */
export function actionLatchReason(actionInFlight: boolean, link: LinkQueueView): string | null {
  if (!actionInFlight) return null;
  return link.blocked && link.reason !== null ? link.reason : LINK_SENDING_NOTE;
}
