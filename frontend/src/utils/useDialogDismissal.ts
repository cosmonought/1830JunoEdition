// frontend/src/utils/useDialogDismissal.ts
//
/* ==================================================================
    DESIGN NOTE 1641: THE ONE PART OF A MODAL THAT IS THE SAME EVERYWHERE
   ==================================================================
   The modal audit (`claude/modal-audit-2026-09-18.md`) measured twenty-one surfaces carrying
   `aria-modal="true"` and found the attribute enforced on exactly one of them. It counted eight near-identical
   copies of a `window` keydown listener, two copies of an opener capture, two spellings of the backdrop
   handler and two of initial focus -- drift that had already produced one real weakness: `MarketPeekModal`'s
   restoration is this one minus its three guards.

   THIS IS AN EXTRACTION, NOT A DESIGN. Every line below already ran in `HostSetupCard` under #1629 and #1630
   and is held up by that dialog's fifty behavioural cases. Nothing here is new behaviour, and nothing here was
   decided in this file; it was decided by measurement in Chromium and is recorded in
   `claude/host-dialog-escape-2026-09-18.md` and `claude/host-dialog-focus-2026-09-18.md`.

   WHAT THIS HOOK DELIBERATELY DOES NOT OWN, and why each one stays with its dialog:
     - INITIAL FOCUS. Where focus belongs on open is a judgement about the surface -- Host Game's is the
       selected Game radio, because #1448's roving group already makes it the single Tab stop, so focusing it
       creates no new one. A "first tabbable control" default would have been a guess dressed as a contract.
     - TAB CONTAINMENT. It needs the dialog element and a stop-set policy (Host Game's excludes geometry, for
       reasons argued at its site), and the audit found that the non-modal popovers MUST NOT have it -- a
       popover that contains focus is the defect. Putting it here would invite it into surfaces that must not
       have it.
     - STEP/VIEW TRANSITIONS, BACKDROPS, SEMANTICS, NAMING, PORTALS, `inert`, SCROLL LOCK, NATIVE `<dialog>`.
       None of those has been proven on any surface in this app yet; the audit recommends them as later,
       separate work and names the order.

   ESCAPE STAYS ON `window`, and that is measured rather than stylistic: clicking dead space inside a card
   moves `document.activeElement` to `<body>` in Chromium, and a keydown from `<body>` never reaches a handler
   scoped to the dialog element. A dialog-scoped Escape would be silently dead after an ordinary click on a
   card's header. */

import { useEffect, useLayoutEffect, useRef } from "react";

export type DialogDismissalOptions = {
  /** The AUTHORITATIVE close -- the same function the visible x, Cancel and backdrop call. It is deliberately
   *  not "an Escape handler": the audit's M3 finding is that close routes drift apart, and a hook that took a
   *  callback of its own would be the mechanism for that drift. */
  onDismiss: () => void;
  /** False while the dialog must refuse to be dismissed, so Escape agrees with whatever rule the visible
   *  controls already enforce (`disabled={busy}` on the x, `busy ? undefined : onClose` on the backdrop).
   *  Named for the hook's own condition rather than for a consumer's reason for it -- Host Game's reason is
   *  `busy`, another dialog's might not be. Defaults to true, because a dialog with no such rule should not
   *  have to say so. */
  dismissible?: boolean;
};

/** Escape dismissal and opener restoration, and nothing else.
 *
 *  Returns nothing on purpose. The captured opener is an implementation detail of the restore; handing it back
 *  would invite a consumer to focus it itself and produce a second restoration path -- the shape of defect
 *  this hook exists to remove. */
export function useDialogDismissal({ onDismiss, dismissible = true }: DialogDismissalOptions): void {
  /* THE LATEST VALUES, READ AT KEYPRESS TIME. Before the extraction the listener carried `[busy, onClose]` and
     was torn down and reinstalled whenever either changed -- and `onClose` is an inline arrow in `Lobby`, so
     that was every render of the lobby. The listener is now installed once per mount and reads through this
     ref instead.
     THE TIMING IS THE SAME, not merely similar: a passive effect is exactly when the old effect re-ran, so the
     values this handler can see change at the same point in the commit they changed at before. */
  const latest = useRef({ onDismiss, dismissible });
  useEffect(() => {
    latest.current = { onDismiss, dismissible };
  });

  /* TWO EFFECTS, IN TWO PHASES, AND EACH PHASE IS FORCED BY A MEASUREMENT (#1642, batch 1).
     React commits in this order: DOM mutation (where a native `autoFocus` fires, and where layout-effect
     CLEANUPS for a deleted subtree run), then `restoreSelection`, then layout effects, then paint, then
     passive effects and their cleanups.

     THE CAPTURE IS A LAYOUT EFFECT so that it precedes every consumer's initial focus whatever phase the
     consumer uses. A passive capture is beaten by a consumer's layout-effect focus, and would then record the
     control the dialog had just focused INSIDE itself as the opener -- aiming the restore at a node that
     leaves with the dialog. (A native `autoFocus` still beats even this, because it fires during mutation;
     that is why batch 1 removed the two that existed, and why the consumers' suites assert their absence.)

     THE RESTORE STAYS A PASSIVE CLEANUP, and this was measured rather than assumed: moving it to the layout
     cleanup makes it run DURING the mutation phase, and React's own `ReactInputSelection.restoreSelection`
     then runs afterwards and puts focus back on whatever held it before the commit. Instrumented, the restore
     fired, `document.activeElement` became the opener, and by the time the commit finished focus was back
     where React had saved it. A passive cleanup runs after all of that and is the last word. */
  const openerRef = useRef<Element | null>(null);
  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
  }, []);

  useEffect(
    () => () => {
      const opener = openerRef.current;
      /* THREE GUARDS, each for a way this goes wrong, and each of them the difference between this and the
         copy in `MarketPeekModal` (#1141), which has none and has escaped harm only because its opener is a
         permanent panel control. Not an `HTMLElement`: nothing to focus. `<body>` or the root: focusing those
         IS the accidental behaviour being corrected, so it is refused rather than reproduced. Disconnected:
         a close that replaces the screen leaves the opener detached, and focusing a detached node silently
         sends focus to `<body>` in every engine. */
      if (!(opener instanceof HTMLElement)) return;
      if (opener === document.body || opener === document.documentElement) return;
      if (!opener.isConnected) return;
      opener.focus();
    },
    [],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /* FIRST REFUSAL TO THE INNERMOST SURFACE. A nested transient surface that owns the key handles it and
         calls `preventDefault`, and this stands down rather than closing a second layer on one keypress. (One
         that calls `stopPropagation` instead also wins, because `window` is on the propagation path.) */
      if (event.defaultPrevented) return;
      /* READ, NOT CAPTURED -- so a dialog that becomes undismissable while this listener is mounted starts
         refusing immediately, and one whose close callback is re-created every render never calls a stale
         one. */
      if (!latest.current.dismissible) return;
      latest.current.onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
