// frontend/src/components/CinematicTakeover.tsx
//
/* ==================================================================
    PHASE 3 W3-D (OD-15(a), AUD-13.05): A CINEMATIC IS A TAKEOVER OF THE VIEWPORT, NOT A DIALOG AND NOT CHROME
   ==================================================================
   THE OWNER'S RULING. The intro (`GameIntroOverlay`) and the end-game film (`GameOutroOverlay`) are full-viewport
   takeovers. They fill the visual viewport whatever the player's UI scale is, they carry no dialog semantics and
   no modal frame, and they are NOT `NativeModal` surfaces -- OD-15(b)'s native-dialog convergence is for actual
   dialogs and explicitly excludes both.

   WHAT THIS REPLACES. Both overlays used to render INSIDE the zoomed shell root and cancel its scale with
   `zoom: 1 / uiScale` (#1144, #1294). The ruling removes that counter-zoom without replacing it with "scale like
   the modals": the layer is rendered OUTSIDE every scaled root instead, so there is no scale to cancel. The
   effective zoom is 1 because nothing above the layer applies one -- not because a reciprocal multiplied back to
   one -- so a fixed box with its four edges at zero is the viewport, and the skip button and the credit are authored in the
   same CSS pixels they always effectively had.

   WHERE IT GOES: `document.body`, the destination `RevenueModifierFlash` (#956 / #970a) already measured. Body
   carries only `index.html`'s margin, font-size and line-height -- no `zoom`, `transform`, `filter` or
   `contain` -- so a fixed layer there resolves against the viewport. It is NOT the modal layer
   (`ModalLayerHost`): that host carries `zoom: uiScale` on purpose, because dialogs are chrome.

   WHY NOT FOUR ZERO EDGES PLUS `100vw` / `100dvh`. Outside every zoom, viewport units are honest (#1144 measured that
   they are the units an enclosing `zoom` distorts), but `100vw` includes a vertical scrollbar's width and would
   push the layer past the right edge on a page that scrolls. Four zero edges on a fixed box are exactly the viewport
   with nothing to overflow, so it is the geometry, and no width or height is written.

   NOTHING HERE IS A DIALOG. No `role="dialog"`, no `aria-modal`, no `<dialog>`, no `showModal()`, no frame,
   padding, max-width or centred card. Blocking the game underneath is the shell's job and is done to the
   covered surface, not by giving the film modal semantics: the shell root takes `inert` while a takeover is up
   (`cinematicTakeoverActive` below; the shell's root), and this layer, being outside that root, stays live.

   WHAT THIS DOES NOT OWN: the film, its timing, its controls, Escape, the duck, the backstop, the z-order
   relative to the shell's own toasts (each overlay keeps the `zIndex` it had). Those stay in each overlay. */

import React from "react";
import { createPortal } from "react-dom";

/** The attribute the tests and the shell find a takeover by. */
export const CINEMATIC_TAKEOVER_ATTRIBUTE = "data-cinematic-takeover";

/** The whole geometry contract: the viewport, by a fixed box with every edge at zero. Nothing else. */
export const CINEMATIC_TAKEOVER_GEOMETRY: Readonly<React.CSSProperties> = Object.freeze({
  position: "fixed",
  /* The four edges rather than the `inset` shorthand: the same box, and one an engine without `inset` (Safari
     before 14.1) still honours. */
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

export type CinematicTakeoverProps = {
  /** The overlay's own surface: background, z-index, alignment. Laid OVER the geometry, which it must not
   *  override -- the shell's tests assert the geometry survives the merge. */
  style: React.CSSProperties;
  testId?: string;
  /** Passed through for the outro, which hides itself from assistive technology once the modal is up. */
  ariaHidden?: boolean;
  /** Passed through where an overlay already had one (the outro's `role="presentation"`). Never a dialog role. */
  role?: "presentation";
  children: React.ReactNode;
};

export function CinematicTakeover({ style, testId, ariaHidden, role, children }: CinematicTakeoverProps) {
  const layer = (
    <div
      {...{ [CINEMATIC_TAKEOVER_ATTRIBUTE]: "true" }}
      data-testid={testId}
      role={role}
      aria-hidden={ariaHidden}
      style={{ ...style, ...CINEMATIC_TAKEOVER_GEOMETRY }}
    >
      {children}
    </div>
  );
  /* RevenueModifierFlash's guard (#956): no `document` (SSR, a bare node test) renders in place rather than
     throwing -- a worse position and a working component. */
  if (typeof document === "undefined" || !document.body) return layer;
  return createPortal(layer, document.body);
}

/** Is a cinematic covering the game? The shell makes its own root `inert` exactly while this is true, so the
 *  game underneath cannot be reached by pointer or keyboard -- and the takeover, which lives outside that root,
 *  and the modal layer, which is the root's sibling, are unaffected. The outro covers only until its cue: from
 *  then the Game Over dialog is up, and `showModal()` already blocks everything outside it. */
export function cinematicTakeoverActive(introPlaying: boolean, outro: "playing" | "cued" | null): boolean {
  return introPlaying || outro === "playing";
}

/** The attribute spread for the covered root. `inert` is not in React 18's DOM typings, so it is written as a
 *  plain attribute; absent (not `false`) when nothing covers the game, so the root carries no attribute at all. */
export function inertWhileCovered(covered: boolean): Record<string, string> {
  return covered ? { inert: "" } : {};
}

export default CinematicTakeover;
