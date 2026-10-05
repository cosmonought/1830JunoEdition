// frontend/src/utils/useNoticeChain.ts
//
/* ==================================================================
    W3-A / OD-5(b)+(c): THE CHAIN, AND WHERE FOCUS LANDS WHEN IT ENDS
   ==================================================================
   `presentedNotice` (noticeChain.ts) picks which due notice takes the screen; this hook feeds it the live
   foreign-dialog fact and owns the one focus move OD-5(b) rules: "after the forced-notice chain completes, focus
   lands" on the game-screen heading -- and "do not repeatedly steal focus during ordinary gameplay".

   SO FOCUS MOVES ON ONE EDGE ONLY: a notice was presented in this mount, and now NO notice is due at all. A
   notice that is merely HELD (a foreign dialog took the screen) is not the end of the chain, and a render with
   nothing due and nothing shown is ordinary play. Each completed chain moves focus once.

   AFTER THE NOTICE'S OWN TEARDOWN. This is a passive effect of the shell, and React runs every passive unmount
   cleanup -- including `NativeModal`'s guarded opener restore -- before any passive update effect, so the heading
   is the last word rather than racing the restore.

   NEVER INTO ANOTHER SURFACE'S FOCUS. If focus is already inside an open dialog when the chain ends, that dialog
   owns it and the heading waits for the next completed chain. `preventScroll`, because the heading is a focus
   target, not a destination the page should jump to. */

import { useEffect, useRef, useSyncExternalStore } from "react";

import { anyNoticeDue, presentedNotice, type DueNotices, type NoticeKind } from "./noticeChain";
import { foreignNativeModalCount, subscribeNativeModals } from "./nativeModalRegistry";

/** Whether a native dialog that is not a chained notice is open, live. */
export function useForeignNativeModalOpen(): boolean {
  return useSyncExternalStore(
    subscribeNativeModals,
    () => foreignNativeModalCount() > 0,
    () => false,
  );
}

function focusIsInsideAnotherSurface(): boolean {
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (!(active instanceof Element)) return false;
  if (active === document.body || active === document.documentElement) return false;
  return active.closest("dialog[open], [aria-modal='true']") !== null;
}

export function useNoticeChain(
  due: DueNotices,
  headingRef: { readonly current: HTMLElement | null },
): { presented: NoticeKind | null } {
  const foreignDialogOpen = useForeignNativeModalOpen();
  const presented = presentedNotice(due, foreignDialogOpen);
  const exhausted = !anyNoticeDue(due);
  /** True from the first presented notice until the chain that followed it has been closed off with a focus move. */
  const shownRef = useRef(false);

  useEffect(() => {
    if (presented !== null) {
      shownRef.current = true;
      return;
    }
    if (!exhausted || !shownRef.current) return;
    shownRef.current = false;
    const heading = headingRef.current;
    if (!heading || !heading.isConnected) return;
    if (focusIsInsideAnotherSurface()) return;
    heading.focus({ preventScroll: true });
  }, [presented, exhausted, headingRef]);

  return { presented };
}
