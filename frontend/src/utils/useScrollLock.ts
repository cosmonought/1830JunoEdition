// frontend/src/utils/useScrollLock.ts
//
/* ==================================================================
    DESIGN NOTE 1649: THE PAGE BEHIND A NATIVE MODAL STILL SCROLLS, MEASURED
   ==================================================================
   `showModal()` gives real background inertness -- measured in Chromium 141: a background control cannot be
   Tabbed to, cannot be clicked, and `element.focus()` on it is REFUSED (focus stays on the dialog). What it
   does NOT give is a scroll lock. Measured on the same page, with the dialog open and focus inside it:

     wheel over the dialog's own scrim  -> the scrim scrolled (correct -- that is its own overflow)
     wheel over the card                -> `window.scrollY` 0 -> 400
     PageDown from a button in the card -> `window.scrollY` 400 -> 1187
     after the dialog closed            -> `window.scrollY` still 1187

   So the lobby behind the dialog scrolled away under it and stayed where it was left. That is the gap this
   file closes, and nothing else: it is not a modal manager and it does not know what a modal is.

   `overflow: hidden` ON THE ROOT ELEMENT, not `position: fixed` on the body. Both stop the page; only one of
   them keeps the scroll offset. Measured: with `documentElement.style.overflow = "hidden"`, the offset was
   preserved across lock, wheel, PageDown, Space and unlock -- Chromium simply refuses to scroll and leaves
   the position alone. The `position: fixed` dialect has to move the body by `-scrollY` and put it back, which
   is a reflow of the whole page on both edges and the usual source of the "the page jumped" report. The
   offset is still recorded and restored here, because a lock that promises to restore should not depend on a
   browser's choice not to have moved it.

   THE SCROLLBAR GAP IS COMPENSATED so the chrome behind does not step sideways when the bar disappears. It is
   measured (`innerWidth - documentElement.clientWidth`) rather than assumed, so an engine with overlay
   scrollbars -- where the gap is 0 -- gets no padding at all. The padding goes on `<body>`, which is OUTSIDE
   every `zoom`ed screen root (#1450), so it is in the same pixels the scrollbar was.

   REFERENCE COUNTED, because the next batches put more than one modal in the layer and two open at once must
   not have the first one's close unlock the page under the second. The count is module state on purpose: the
   thing being locked is the document, of which there is one.

   PRIOR INLINE STYLES ARE SAVED AND PUT BACK EXACTLY, including the absence of one -- a property that had no
   inline value is REMOVED rather than set to "", so a stylesheet rule that was winning before still wins
   after.

   WHAT THIS DOES NOT TOUCH: browser page zoom, the UI scale, any element's own `overflow`, and the dialog's
   internal scrolling. A card taller than the viewport still scrolls inside itself, which is how the footer
   actions stay reachable at 360px. */

import { useLayoutEffect } from "react";

type SavedStyles = {
  rootOverflow: string;
  bodyPaddingRight: string;
  scrollX: number;
  scrollY: number;
};

let holders = 0;
let saved: SavedStyles | null = null;

/** Take a share of the lock. The first holder locks; the rest only count. */
export function acquireScrollLock(): void {
  holders += 1;
  if (holders > 1) return;
  const root = document.documentElement;
  const body = document.body;
  /* MEASURED, NOT ASSUMED, and only where there is a measurement to take. Overlay scrollbars report a gap of
     0 and must get no padding -- and an environment with no layout at all reports `clientWidth === 0`, which
     would subtract to the WHOLE viewport width and pad the page by it. jsdom is exactly that environment, so
     this is not hypothetical: without the first clause the lock adds `padding-right: 1024px` under test. */
  const client = root.clientWidth;
  const gap = client > 0 ? window.innerWidth - client : 0;
  saved = {
    rootOverflow: root.style.overflow,
    bodyPaddingRight: body.style.paddingRight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
  root.style.overflow = "hidden";
  if (gap > 0) body.style.paddingRight = `${gap}px`;
}

/** Give a share back. The last holder unlocks and restores; an unbalanced release is ignored rather than
 *  allowed to drive the count negative, because the failure it would cause -- a page that never unlocks
 *  again -- is worse than the bookkeeping error it would report. */
export function releaseScrollLock(): void {
  if (holders === 0) return;
  holders -= 1;
  if (holders > 0) return;
  const restore = saved;
  saved = null;
  if (!restore) return;
  const root = document.documentElement;
  const body = document.body;
  if (restore.rootOverflow) root.style.overflow = restore.rootOverflow;
  else root.style.removeProperty("overflow");
  if (restore.bodyPaddingRight) body.style.paddingRight = restore.bodyPaddingRight;
  else body.style.removeProperty("padding-right");
  /* ONLY IF IT MOVED. Measured, `overflow: hidden` keeps the offset, so this is the branch that never runs in
     Chromium -- and not running it is what keeps a restore from fighting a scroll something else performed.
     It is also what keeps jsdom quiet: `window.scrollTo` is one of the methods jsdom 16.7 does not implement,
     and calling it unconditionally printed a "Not implemented" trace on every unmount in the host suites. */
  if (window.scrollX === restore.scrollX && window.scrollY === restore.scrollY) return;
  if (typeof window.scrollTo !== "function") return;
  window.scrollTo(restore.scrollX, restore.scrollY);
}

/** How many holders the lock has. For tests and for a future `inert` owner that needs to ask. */
export function scrollLockHolders(): number {
  return holders;
}

/** Drop the lock and every share of it. Tests only -- the module state outlives one test's render tree. */
export function resetScrollLockForTests(): void {
  holders = 0;
  saved = null;
}

/** Hold the lock for as long as the component is mounted.
 *
 *  A LAYOUT EFFECT, so the page is already locked in the frame the modal first paints in; a passive effect
 *  leaves one painted frame in which a wheel can still move the page behind an apparently-modal dialog. The
 *  cleanup runs in the mutation phase, which is before the modal's own node is removed -- so the page is
 *  unlocked and the offset restored before anything can be scrolled into a gap. */
export function useScrollLock(): void {
  useLayoutEffect(() => {
    acquireScrollLock();
    return releaseScrollLock;
  }, []);
}
