// frontend/src/components/ModalPortal.tsx
//
/* ==================================================================
    DESIGN NOTE 1648: A MODAL LAYER BESIDE THE APPLICATION, NOT INSIDE IT
   ==================================================================
   THE PROBLEM THIS EXISTS TO SOLVE IS NOT ITS OWN. The modal audit's H1 -- twenty-one surfaces declaring
   `aria-modal="true"` with the background still reachable by keyboard -- is fixed by making the background
   `inert` while a modal is open. That is impossible today for a structural reason: every modal renders INSIDE
   the screen it covers, so `inert` on the screen would make the modal inert with it. This note is the
   prerequisite, and nothing else: it moves the modal markup out of the screen's subtree and leaves `inert`
   for a later batch.

   THE TOPOLOGY, BEFORE AND AFTER. `GameRouter` renders one screen at a time -- the Lobby or the game shell --
   and each returns its own root `<div>` carrying `chromeZoomFor(uiScale)`. There is no wrapper above them, so
   the "background subtree" that will eventually go inert IS that root div. The layer is therefore rendered as
   its SIBLING:

     #root
       |- <Lobby> or <AppShell> root div   zoom: uiScale     <- the future `inert` target
       `- <div data-modal-layer>           zoom: uiScale     <- this

   SCALE IS APPLIED ONCE, HERE, AND IT HAD TO BE. The screens carry `zoom` on their own roots, so a modal
   inside one inherits the reader's chosen scale for free. A portal to `document.body` -- the obvious move,
   and what `RevenueModifierFlash` does -- lands OUTSIDE every zoomed root and would draw the dialog at 100%
   beside chrome at 63%. `RevenueModifierFlash` is exempt for the reason its own note gives: it is a picture
   at viewport size, not chrome. A dialog is chrome (#1144: "THE MODALS ARE DELIBERATELY NOT DOING THIS"), so
   the layer takes the same `zoom` the screen root takes, from the same `useUiScale()`, and nothing inside it
   re-applies or cancels one.

   NOT `chromeZoomFor`, DELIBERATELY. That helper pairs the zoom with `minHeight: 100/scale vh`, which is the
   GROUND under a screen -- exactly what a layer that must occupy no space while empty cannot have. The zoom
   is the only half that transfers, and taking it alone is why this is written out rather than shared.

   FIXED GEOMETRY IS UNCHANGED. #1144 measured it: a `position: fixed` layer inside a `zoom` still resolves
   against the whole window, because the fixed containing block is itself zoom-adjusted. Every modal backdrop
   in this app is `position: fixed; inset: 0`, so each still covers the viewport, at the same scale as before,
   from inside the layer.

   RENDERED AFTER THE SCREEN, so it paints above it by document order without a `z-index` of its own. The
   layer sets no stacking policy; each modal keeps the `z-index` it already had, now resolved within this
   layer's stacking context rather than the screen's.

   WHAT THIS FILE DOES NOT OWN, and must not grow to own: Escape, focus restoration, initial focus, focus
   containment, backdrop clicks, `inert`, `aria-hidden`, scroll locking, modal semantics, and any registry of
   what is open. Dismissal belongs to `useDialogDismissal` (#1641); the rest belongs to each dialog. This is a
   destination, not a primitive. */

import React from "react";
import { createPortal } from "react-dom";

import { useUiScale } from "../utils/useUiScale";

/** The attribute the layer is found by. An attribute rather than an `id`, so a test harness that mounts two
 *  trees does not silently share one host with the app. */
export const MODAL_LAYER_ATTRIBUTE = "data-modal-layer";

/** The one host. Rendered by `GameRouter` beside whichever screen is up, never per modal, and present before
 *  any modal asks for it. Empty it is a zero-height block that lays nothing out and scrolls nothing. */
export function ModalLayerHost() {
  const uiScale = useUiScale();
  /* The zoom alone -- see the note above on why `chromeZoomFor` is not used here. */
  return <div {...{ [MODAL_LAYER_ATTRIBUTE]: "true" }} style={{ zoom: uiScale }} />;
}

/** Renders `children` into the layer. Nothing else.
 *
 *  THROWS WHEN THE LAYER IS ABSENT rather than falling back to `document.body`: a silent fallback would put
 *  the dialog outside every zoomed root, where it would draw at the wrong size and, later, would not be
 *  excluded from the background `inert` -- both failures a reader would have to measure to notice. A test
 *  harness that mounts a modal must mount `<ModalLayerHost />` too, which is the explicit requirement this
 *  message states. */
const MISSING_LAYER =
  "ModalPortal: no modal layer found. Render <ModalLayerHost /> beside the screen root " +
  "(GameRouter does this in the application) before rendering a modal through ModalPortal.";

function findLayer(): Element | null {
  return typeof document === "undefined" ? null : document.querySelector(`[${MODAL_LAYER_ATTRIBUTE}]`);
}

/* #1651: THE LAYER MUST ALREADY BE IN THE DOM. `createPortal` needs its container during RENDER, so a layer
   rendered as a sibling in the SAME commit does not exist yet at that moment. `GameRouter` mounts the layer
   with the screen and a modal opens later, so the application never meets this; a test harness must commit
   the layer before it renders a modal, which is what every modal suite's `mount()` now does. Deferring the
   look-up to a layout effect was tried and rejected: it made the portal render `null` for one commit, which
   silently skipped the `[]`-dependency effect each dialog uses to place its initial focus. */
export function ModalPortal({ children }: { children: React.ReactNode }) {
  const host = findLayer();
  if (!host) throw new Error(MISSING_LAYER);
  return createPortal(children, host);
}

export default ModalPortal;
