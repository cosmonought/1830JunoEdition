// frontend/src/utils/useLinkQueue.ts
//
/* ==================================================================
    PHASE 3 W3-I (AUD-19.01 / AUD-02.05 / AUD-02.06 / AUD-03.11): THE LINK'S QUEUE, FOR THE FORMS
   ==================================================================
   One small hook over the active room link's read-only queue state (`serverLink.ts` `getActiveLinkQueue`), outside the
   drain: the shell reads it once and hands the forms a view. On a path with no room link (the Firestore / hotseat
   transport) it is always idle, and every form behaves exactly as before.

   `linkQueueView` is presentation only. It decides nothing about legality -- the authority still answers every
   proposal -- and it never sends, cancels or reorders anything: it only says whether this tab's last submission is
   still held by the link (so a second press would be a second message) and whether it is waiting for a socket. */

import { useSyncExternalStore } from "react";

import { getActiveLinkQueue, subscribeActiveLinkQueue, type LinkQueueState } from "./serverLink";

/** The plan's sentence for a submission waiting for a socket. */
export const LINK_QUEUED_NOTE = "Queued — will send on reconnect.";
/** A submission on the wire, not yet answered: the same sentence as the shell's latch (#1173). */
export const LINK_SENDING_NOTE = "Sending your last action — one moment.";

export interface LinkQueueView {
  /** The link still holds a submission from this tab: a second press now would be a second message. */
  blocked: boolean;
  /** At least one submission is waiting for the link to reconnect. */
  queued: boolean;
  /** Why the form is waiting (`LINK_QUEUED_NOTE` while queued, else `LINK_SENDING_NOTE`), or `null` when nothing is held. */
  reason: string | null;
}

export const IDLE_LINK_QUEUE_VIEW: LinkQueueView = Object.freeze({ blocked: false, queued: false, reason: null });

export function linkQueueView(queue: LinkQueueState): LinkQueueView {
  if (queue.unsettled === 0) return IDLE_LINK_QUEUE_VIEW;
  const queued = queue.unsent > 0;
  return { blocked: true, queued, reason: queued ? LINK_QUEUED_NOTE : LINK_SENDING_NOTE };
}

/** The active room link's queue state; `IDLE_LINK_QUEUE` when there is no link. */
export function useLinkQueue(): LinkQueueState {
  return useSyncExternalStore(subscribeActiveLinkQueue, getActiveLinkQueue, getActiveLinkQueue);
}
