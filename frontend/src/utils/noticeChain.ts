// frontend/src/utils/noticeChain.ts
//
/* ==================================================================
    W3-A / OD-5(c): ONE FORCED NOTICE AT A TIME, IN THE RULED ORDER
   ==================================================================
   RULED (OD-5(c), 2026-10-04): "Use this deterministic priority when multiple forced notices are due:
   1. Emergency 2. Fleet Loss 3. Private Revenue 4. Phase Three 5. Herald 6. Tutorial. Only one forced notice is
   presented at a time." After an acknowledgement the next due notice presents; when none is due, focus goes to
   the game-screen heading (OD-5(b), `useNoticeChain`).

   PRESENTATION ONLY. Whether a notice is DUE is still each notice's own question -- the reducer's emergency
   obligation, the fleet-loss queue, the payout phase, the phase edge, the float, a tutorial's own arming. This
   file answers the one question none of them can: which of several due notices takes the screen.

   NO NOTICE STACKS WITH ANOTHER NATIVE DIALOG (AUD-13.07): while a native dialog that is not one of these notices
   is open (`nativeModalRegistry`), every notice waits -- the emergency included, because the ruling admits no two
   native dialogs at once. Nothing outranks the emergency, so in practice that wait is only ever for a dialog the
   president opened before the obligation arose (the market peek, Auto-Pass): every background control is inert
   under the emergency's own `showModal()`, so none can be opened over it. */

export const NOTICE_PRIORITY = [
  "emergency",
  "fleetLoss",
  "privateRevenue",
  "phaseThree",
  "herald",
  "tutorial",
] as const;

export type NoticeKind = (typeof NOTICE_PRIORITY)[number];

export type DueNotices = Readonly<Record<NoticeKind, boolean>>;

/** Whether any notice is due at all -- held or presented. */
export function anyNoticeDue(due: DueNotices): boolean {
  return NOTICE_PRIORITY.some((kind) => due[kind]);
}

/** The one notice that takes the screen now, or `null`.
 *
 *  `foreignDialogOpen`: a native dialog that is not a chained notice is open. Every notice waits for it to
 *  close. */
export function presentedNotice(due: DueNotices, foreignDialogOpen: boolean): NoticeKind | null {
  if (foreignDialogOpen) return null;
  for (const kind of NOTICE_PRIORITY) {
    if (due[kind]) return kind;
  }
  return null;
}
