// frontend/src/components/NativeModal.tsx
//
/* ==================================================================
    DESIGN NOTE 1651: ONE NATIVE DIALOG, AND EVERYTHING ELSE LEFT TO THE SURFACE
   ==================================================================
   THIS IS AN EXTRACTION, NOT A DESIGN. Every line below already ran in `HostSetupCard` under #1650 and was
   measured in Chromium 141 against the real Lobby. What this file adds is the correction #1650 got wrong and
   the platform feature that replaced its workaround.

   THE CORRECTION. #1650 shipped `<dialog role="presentation">` wrapping `<div role="dialog" aria-modal>`.
   Measured with `Accessibility.getFullAXTree`, that produced TWO dialog nodes in the accessibility tree: the
   native element (unnamed -- Chromium ignores `role="presentation"` on a `<dialog>`, as the ARIA in HTML rules
   require) and the card ("Host a game"). A `<dialog>` has an implicit `dialog` role and permits only
   `alertdialog` as an alternative. So the NATIVE ELEMENT is now the dialog, it carries the name, and the card
   inside it is an ordinary `<div>`. One named dialog, and the visual DOM is unchanged.

   THE POLICY, NOT THE WORKAROUND. #1650 refused the native `cancel` unconditionally and put the dialog back
   with `showModal()` when Chromium overruled the refusal -- because a refused close request may be overruled
   by an insistent reader, which was measured (six Escapes ~90 ms apart: the second `cancel` arrives with
   `cancelable: false` and the dialog closes). `closedby` expresses the same policy as a STATE rather than as a
   fight, and Chromium 141 supports it. Measured here:

     closedby="none"          Escape does nothing at all -- no `cancel`, no `close`, and it survived six rapid
                              Escapes and a backdrop click. This is the busy gate and the forced notice.
     closedby="closerequest"  Escape fires `cancel` then `close`, exactly once. This is ordinary dismissal.
     (attribute absent)       reflects as `closerequest`.
     switching while open     takes effect immediately.

   So there is ONE Escape path and it is the platform's: no `window` listener, no `preventDefault`, no reopen,
   and therefore no frame in which the dialog is closed and comes back. `defaultPrevented` first refusal is
   still there and is still free -- measured, a nested surface that calls `preventDefault()` on the Escape
   keydown suppresses the close request entirely, under `closerequest` as it did before.

   WHERE `closedby` IS ABSENT, the fallback is explicit and is the #1650 behaviour, kept only for that case:
   refuse `cancel` when the surface is not dismissible, and put the dialog back if the engine overrules the
   refusal. It is a fallback, not the design.

   WHY THE OPENER CAPTURE LIVES HERE and not in `useDialogDismissal`. `showModal()` moves focus into the
   dialog, so whatever captures the opener must run BEFORE it. Layout effects run child-first, and this
   component is a CHILD of every surface that uses it -- a `useLayoutEffect` in the surface would run after
   this one and would record the control `showModal()` had just focused. The capture and `showModal()` are one
   ordered pair and cannot be split across the boundary. Restoring is still the surface's decision, which is
   what `restoreOpener` is for: the four forced notices never had restoration (batch 4B stopped short of
   deciding their focus target) and must not acquire it here.

   WHAT THIS DOES NOT OWN, and must not grow to own: the card and its styling, where focus goes when the
   dialog opens, whether the scrim dismisses, what Escape means beyond "may it close", what focus is restored
   TO, the form, and any reset behaviour. Those are twenty different answers and they stay at their twenty
   sites.

   Z-INDEX IS GONE from every surface converted to this. The top layer is above the whole document by
   definition, so the 60..40000 range these scrims used to declare decided nothing; leaving the numbers in
   would have left the next reader an ordering contract that is no longer real. */

import React, { useEffect, useLayoutEffect, useRef } from "react";

import { ModalPortal } from "./ModalPortal";
import { useScrollLock } from "../utils/useScrollLock";

/** The attribute the `::backdrop` rule and the tests find these by. */
export const NATIVE_MODAL_ATTRIBUTE = "data-native-modal";

/* ==================================================================
    #1653: WHAT TAB CAN REACH, COMPUTED FRESH AT EVERY KEYPRESS
   ==================================================================
   LIFTED FROM `HostSetupCard` LINE FOR LINE (#1630), because it is the only implementation in this codebase
   that has been measured, and because Host Game's Tab order must come out of this pass byte-for-byte
   identical. Recomputing per press is how the set stays right when a step changes or `busy` disables the
   close button, with no subscription to either.

   NO GEOMETRY CHECK, deliberately and with a reason on each side: these cards hide nothing with CSS (an
   off-step control is conditionally RENDERED, so it is absent rather than invisible), and jsdom returns no
   boxes for anything, so a `getClientRects()` filter would be untestable here and would exclude every
   control. `display`/`visibility` are still read, because those are the two an inline style could set. */
const TABBABLE_SELECTOR = "a[href], button, input, select, textarea, [tabindex]";

export function tabbableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter((node) => {
    if (!node.isConnected) return false;
    if (node.hasAttribute("disabled")) return false;
    if (node.hidden) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    if (node.tabIndex < 0) return false;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return true;
  });
}

/** Read at call time rather than at module load, so a test can install or remove the platform feature and
 *  exercise both branches in one file. */
export function closedByIsSupported(): boolean {
  return typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype;
}

/* The real `::backdrop` is left transparent on every one of these: the scrim the player sees is the dialog
   element's own full-viewport box, which covers the pseudo-element entirely, and painting both would darken
   the application twice. Declared once for the attribute rather than per surface. */
const NATIVE_MODAL_CSS = `dialog[${NATIVE_MODAL_ATTRIBUTE}]::backdrop { background: transparent; }`;

/* The UA stylesheet gives a modal `<dialog>` `width: fit-content; height: fit-content; margin: auto; border:
   solid; padding: 1em; background: Canvas; color: CanvasText` and a `max-width`/`max-height` of
   `calc(100% - 6px - 2em)`. Every surface here was written as a full-viewport `<div>` scrim, so each of those
   is cancelled and the surface's own object is layered on top. `display` is deliberately part of the surface's
   object rather than this one: it is also what outranks the UA's `dialog:not([open]) { display: none }`, which
   is what keeps the fallback visible where `showModal` does not exist. */
const UA_RESET: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  margin: 0,
  border: "none",
  width: "auto",
  height: "auto",
  maxWidth: "none",
  maxHeight: "none",
  color: "inherit",
};

export type NativeModalProps = {
  /** The accessible name, as `aria-label`. Give this or `labelledBy`, not both. */
  name?: string;
  /** The accessible name by reference, for a surface whose heading is already on screen. */
  labelledBy?: string;
  /** `aria-describedby`, where the surface already had one. */
  describedBy?: string;
  /** `role="alertdialog"` -- the only role a `<dialog>` may be given instead of its implicit one. */
  alert?: boolean;
  /** May a platform close request (Escape) close this surface? Required, because every surface has an answer
   *  and a default would let one be adopted by accident. */
  dismissible: boolean;
  /** What the platform close actually does. Required when `dismissible`; it is the surface's authoritative
   *  close, the same function its visible controls call. */
  onDismiss?: () => void;
  /** The scrim's own click policy. Omitted means a scrim that does not dismiss. */
  onScrimClick?: (event: React.MouseEvent<HTMLDialogElement>) => void;
  /** Does focus return to whatever held it when this opened? Required for the same reason as `dismissible`. */
  restoreOpener: boolean;
  /** The surface's own scrim: colour, padding, alignment, overflow. Layered over the UA reset. */
  scrimStyle: React.CSSProperties;
  className?: string;
  testId?: string;
  children: React.ReactNode;
};

export function NativeModal({
  name,
  labelledBy,
  describedBy,
  alert = false,
  dismissible,
  onDismiss,
  onScrimClick,
  restoreOpener,
  scrimStyle,
  className,
  testId,
  children,
}: NativeModalProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const capturedRef = useRef(false);
  /** True once React has begun taking this dialog down, so the `close` the teardown itself fires is not
   *  mistaken for the player closing it. */
  const releasedRef = useRef(false);

  useScrollLock();

  /* THE POLICY, SET BEFORE THE ELEMENT OPENS AND WHENEVER IT CHANGES. Declared before the `showModal` effect
     so the first value is in place before the dialog enters the top layer, and re-run on `dismissible` so a
     surface that becomes busy stops answering close requests at the moment it becomes busy. */
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    /* SET UNCONDITIONALLY, not only where the feature exists. Where `closedby` is supported this IS the
       policy; where it is not, it is an inert attribute that still says out loud what this surface intends,
       which is what the fallback below and every test read. A policy that is invisible in the DOM is a policy
       nobody can check. */
    node.setAttribute("closedby", dismissible ? "closerequest" : "none");
  }, [dismissible]);

  /* ==================================================================
      THE CAPTURE HAPPENS DURING RENDER, WHICH IS THE ONLY PHASE EARLY ENOUGH
     ==================================================================
     MEASURED, and it cost a case to find: React applies a native `autoFocus` during the commit's MUTATION
     phase, before any effect runs. Four of these surfaces use `autoFocus` to place their initial focus
     (#1645's two notices, the wallet dialog's Proceed button, the private-revenue acknowledgment), so a
     capture in a layout effect -- even this component's, even before `showModal()` -- records the control the
     dialog has just focused INSIDE itself. The restore then aims at a node that leaves with the dialog, its
     `isConnected` guard correctly refuses, and focus is left on `<body>`: exactly the defect #1629 fixed.

     Render runs before the mutation phase, so this is the only place that sees the real opener. It is a read
     and a once-only ref write, which is idempotent -- a StrictMode double render records the same element --
     and it is guarded by its own flag rather than by `openerRef.current === null`, because `activeElement`
     can legitimately be null. */
  if (!capturedRef.current) {
    capturedRef.current = true;
    openerRef.current = typeof document === "undefined" ? null : document.activeElement;
  }

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof node.showModal !== "function") return undefined;
    releasedRef.current = false;
    node.showModal();
    return () => {
      releasedRef.current = true;
      if (node.open) node.close();
    };
  }, []);

  /* ==================================================================
      #1653: WITHOUT `closedby`, THE KEY IS REFUSED BEFORE THE ENGINE ACTS ON IT
     ==================================================================
     #1651's fallback refused `cancel` and put the dialog back when the engine overruled the refusal. Measured
     under #1650, an insistent Escape DOES overrule it -- the second `cancel` of a rapid sequence arrives with
     `cancelable: false` -- so on an engine without `closedby` that fallback was one close-and-reopen away
     from a visible flicker.

     `preventDefault()` ON THE KEYDOWN IS THE REAL BOUNDARY, and it was measured: a handler that cancels the
     Escape keydown suppresses the close request ENTIRELY -- no `cancel`, no `close`, nothing to overrule, and
     nothing to put back. It is taken in the CAPTURE phase on the document so it runs before anything in the
     dialog and before the engine begins its own handling.

     INSTALLED ONLY WHERE IT IS NEEDED: not when `closedby` is supported (the engine already refuses), and not
     while the surface is dismissible (Escape must work then). So on Chromium this listener never exists, and
     on an engine without `closedby` it exists only while a nondismissible dialog is up -- which is the one
     state in which a stray global Escape handler cannot be a second dismissal path, because there is no
     dismissal to be a second of.

     `stopPropagation` IS DELIBERATELY NOT CALLED. #1651 recorded the contract that `preventDefault()` claims
     Escape and `stopPropagation()` alone does not; a listener that stopped propagation here would deny the
     key to everything else on the page and quietly change that contract. The `cancel` refusal below stays as
     a second boundary for an engine that dispatches the close request anyway. */
  useEffect(() => {
    if (closedByIsSupported()) return undefined;
    if (dismissible) return undefined;
    const refuse = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
    };
    document.addEventListener("keydown", refuse, true);
    return () => document.removeEventListener("keydown", refuse, true);
  }, [dismissible]);

  /* THE RESTORE IS A PASSIVE CLEANUP, for #1642's measured reason: a layout cleanup runs during the mutation
     phase and React's own `restoreSelection` then puts focus back where it was before the commit. The three
     guards are #1641's, unchanged -- not an `HTMLElement`, `<body>` or the root, or disconnected. */
  useEffect(
    () => () => {
      if (!restoreOpener) return;
      const opener = openerRef.current;
      if (!(opener instanceof HTMLElement)) return;
      if (opener === document.body || opener === document.documentElement) return;
      if (!opener.isConnected) return;
      opener.focus();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /* ==================================================================
      #1653: THE TWO ENDS, SO THE CYCLE HAS NO INVISIBLE STOP
     ==================================================================
     MEASURED, and it is the reason this moved out of Host Game and into the boundary. `showModal()` DOES
     contain focus -- a background control cannot be Tabbed to from any of the fifteen surfaces -- but
     Chromium's own dialog cycle passes through the browser's UI on its way round, and from the page that
     shows up as one press on which `document.activeElement` is `<body>` and no focus ring is anywhere. On a
     surface with a manual trap it never happened; on the other fourteen it happened in both directions, and
     in the dynamically-disabled state as well.

     ONLY THE TWO ENDS ARE INTERCEPTED. Every Tab in the middle is the browser's own, which keeps the order
     the document defines and means this cannot get the sequence wrong -- it can only refuse to let it leave.
     The stop set is recomputed at each press, so a control disabled, hidden or removed since the last one is
     accounted for without any subscription.

     "OUTSIDE" MEANS "NOT ONE OF THE STOPS", which is what makes this identical to the handler it replaces.
     Host Game's card is `tabIndex={-1}` and was never a stop, and its trap treated focus resting there as
     outside so that a Shift+Tab could not walk backwards out of the dialog; a dead-space click puts focus
     there, so it is a position a player reaches by accident and then presses Tab from. The same rule catches
     `<body>` and anything else that is not a stop.

     `defaultPrevented` FIRST, as in #1629: a nested surface that owns the key handles it and this stands
     down. There is no such surface today.

     THERE IS NO `tabIndex` ON THE `<dialog>`, and there must not be -- the HTML Standard forbids it. This
     needs none: it reads `document.activeElement` and moves focus itself. */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab") return;
    if (event.defaultPrevented) return;
    const root = ref.current;
    if (!root) return;
    const stops = tabbableWithin(root);
    /* NO STOPS MEANS NOTHING TO CONTAIN, and inventing one here would be inventing a focus target for a
       surface that has none -- an eligibility question, not a containment one. */
    if (stops.length === 0) return;
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && stops.indexOf(active) >= 0;
    const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
    if (!inside || active === edge) {
      event.preventDefault();
      (event.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
    }
  };

  /* ONLY THE FALLBACK USES THIS. Where `closedby` is supported the platform has already refused on its own and
     no `cancel` arrives for a surface that is not dismissible. */
  const handleCancel = (event: React.SyntheticEvent<HTMLDialogElement, Event>) => {
    if (closedByIsSupported()) return;
    if (!dismissible) event.preventDefault();
  };

  const handleClose = () => {
    if (releasedRef.current) return;
    if (dismissible) {
      onDismiss?.();
      return;
    }
    /* NOT DISMISSIBLE AND IT CLOSED ANYWAY. Only reachable without `closedby`, where an insistent close
       request cannot be refused twice. React is authoritative about whether this surface exists, so the
       element goes back rather than leaving a dialog React believes is on screen and the player cannot see. */
    const node = ref.current;
    if (!node || node.open || typeof node.showModal !== "function") return;
    node.showModal();
  };

  return (
    <ModalPortal>
      <dialog
        ref={ref}
        {...{ [NATIVE_MODAL_ATTRIBUTE]: "true" }}
        className={className}
        /* No `role` unless it is `alertdialog`: the implicit role IS `dialog`, and saying so again is the
           kind of redundancy that invites someone to "correct" it to something the element does not allow. */
        role={alert ? "alertdialog" : undefined}
        aria-label={name}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        data-testid={testId}
        style={{ ...UA_RESET, ...scrimStyle }}
        onClick={onScrimClick}
        onKeyDown={handleKeyDown}
        onCancel={handleCancel}
        onClose={handleClose}
      >
        <style>{NATIVE_MODAL_CSS}</style>
        {children}
      </dialog>
    </ModalPortal>
  );
}

export default NativeModal;
