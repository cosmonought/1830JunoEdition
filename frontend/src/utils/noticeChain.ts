// frontend/src/utils/noticeChain.ts
//
/* ==================================================================
    W3-A / OD-5(c): ONE FORCED NOTICE AT A TIME, IN THE RULED ORDER
   ==================================================================
   RULED (OD-5, the owner's forced-notice order -- W3-A's "(c)"): the forced-notice chain is "1. Emergency 2. Fleet
   Loss 3. Private Revenue 4. Phase Three 5. Herald. Only one is shown at a time. Tutorial is NOT part of this
   forced-notice chain." After an acknowledgement the next due notice presents; when none is due, focus goes to the
   game-screen heading (OD-5's focus ruling, W3-A's "(b)"; `useNoticeChain`).
   PHASE 3 CONSOLIDATED INTEGRATION (2026-10-05): W3-A had transcribed a sixth entry, Tutorial; the owner's ruling
   has five, so the chain has five. Tutorials keep their own (pre-W3-A) presentation until the FINAL tutorial pass,
   which replaces them with the contextual whitebox / spotlight design -- this file says nothing about them.

   PRESENTATION ONLY. Whether a notice is DUE is still each notice's own question -- the reducer's emergency
   obligation, the fleet-loss queue, the payout phase, the phase edge, the float. This
   file answers the one question none of them can: which of several due notices takes the screen.

   NO NOTICE STACKS WITH ANOTHER NATIVE DIALOG (AUD-13.07): while a native dialog that is not one of these notices
   is open (`nativeModalRegistry`), every notice waits -- the emergency included, because the ruling admits no two
   native dialogs at once. Nothing outranks the emergency, so in practice that wait is for a dialog the president
   opened before the obligation arose (the market peek, Auto-Pass): every background control is inert under the
   emergency's own `showModal()`, so none can be opened over it.

   THE ONE DELIBERATE EXCEPTION (recorded at the Phase-3 consolidated integration, 2026-10-05): W3-J's stale-board
   notice (`BoardBehindNotice`, AUD-25.16 / OD-19). It is a plain `NativeModal` -- registered as FOREIGN, so while
   it stands every forced notice waits behind it -- and it opens itself at once rather than through
   `NativeModalTurn`, so it can open over a dialog that already holds the screen and be the one on top. Both are
   consistent with OD-19's fail-closed requirement: a board that is not the room's must stop the table now, before anything else
   on it is answered. Pinned by `noticeChain.test.tsx`. */

export const NOTICE_PRIORITY = [
  "emergency",
  "fleetLoss",
  "privateRevenue",
  "phaseThree",
  "herald",
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
