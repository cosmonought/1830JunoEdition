// frontend/src/utils/mapGesture.ts
//
// Which touch gestures the rail map claims, and what counts as a tap rather than a drag.
//
// ==================================================================
//  DESIGN NOTE 773: CLAIM A GESTURE ONLY WHERE YOU USE ONE
// ==================================================================
//
// REPORTED: "This may be a 'mobile only' issue, but a player on an iPad cannot scroll when looking at the
// rail map."
//
// THE CANVAS SAID `touch-action: none` UNCONDITIONALLY. That is a promise to the browser -- "every gesture
// starting here is mine, never scroll, never pinch" -- and the map only keeps that promise in ONE of its two
// modes. `detailedView` false is the locked baseline, and `handlePointerMove` returns early there without
// panning anything. So on a tablet the board swallowed every swipe and did nothing with it, and the board is
// most of the screen: there was nowhere left to put a finger to move the page.
//
// INVISIBLE ON A DESKTOP, WHICH IS WHY IT SHIPPED. A mouse scrolls with a wheel, and the wheel goes through
// a different handler; `touch-action` never governs it. The declaration was written for the drag-to-pan
// feature and was simply never scoped to the mode that has one.
//
// THE RULE IS THE FIX AND IT IS ONE SENTENCE: the canvas claims the gesture in the mode where it uses the
// gesture, and hands it back in the mode where it does not. `manipulation` rather than `auto` at the
// baseline, because a tap must still select a hex -- it permits scroll and pinch while suppressing the
// double-tap-zoom delay that would otherwise sit in front of every selection.
//
// THE WHEEL IS THE SAME ARGUMENT AND IS DELIBERATELY NOT CHANGED HERE. `handleWheel` calls `preventDefault`
// unconditionally, so a desktop player cannot scroll the page with the cursor over the map either -- and
// since #67 removed wheel-zoom outright, the canvas now blocks that gesture while using nothing. By the rule
// above it should stop. It is left alone because that `preventDefault` is a deliberate desktop choice
// ("scroll containment"), it was not what was reported, and a mouse and a finger want different answers
// often enough that assuming they want the same one is how the original bug got written.
// -- #773's OBJECTION WAS CORRECT AND #1619 ACTS ON IT. The premise it deferred to was not: the canvas was
// not containing scroll, because React registers the delegated `wheel` listener as passive and that
// `preventDefault` could not cancel anything. The handler is gone. `HexGridRenderer` #1619 has the
// measurement; the app's guarantee is now just this -- it does not intercept or cancel wheel gestures over
// the Rail Map -- and what a browser does with the event afterwards is that browser's policy, not ours.
//
// A TAP IS NOT A CLICK, second half. The click-vs-drag test used a flat 4px dead zone, which is right for a
// mouse and wrong for a finger: a fingertip covers about 40px and rolls several pixels in the act of
// pressing. At 4px a genuine tap reads as a drag and selects nothing -- so a player who worked out that they
// had to unlock the view to move the map would then find the map unresponsive to taps. Not part of the
// report; fixed here because it is the same surface, the same input and the same next bug report.

/* ==================================================================
    DESIGN NOTE 1014: THERE IS ONLY ONE MODE NOW, SO THERE IS ONLY ONE ANSWER
   ==================================================================
   `canvasTouchAction(detailedView)` is GONE. #773's rule survives it exactly -- "the canvas claims the gesture
   in the mode where it uses the gesture, and hands it back in the mode where it does not" -- and this batch
   removed the mode that used one. A function whose parameter can only ever take one value is not a decision.

   `pan-x pan-y` RATHER THAN #773's `manipulation`, and the difference is the whole of this batch's second
   instruction. Both permit a finger to scroll the page, which is what #773 was reporting from an iPad. But
   `manipulation` also permits PINCH, and the map no longer has a zoom for a pinch to reach -- so the gesture
   would either do nothing or scale the page under a board that is meant to be locked. This value refuses the
   pinch and keeps everything #773 won.
   -- THE SECOND PARAGRAPH IS WITHDRAWN BY #1618. The first still holds.

   TAPS STILL ARRIVE, which is the property that made `manipulation` right over `auto`: neither of these
   values reinstates the double-tap-zoom delay in front of every hex selection. */

/* ==================================================================
    DESIGN NOTE 1618: #773's ANSWER WAS RIGHT; #1014 ONLY CHANGED IT TO SERVE THE PAGE LOCK
   ==================================================================
   Read #1014's second paragraph again and notice what it does NOT say. It does not say the map needs the
   pinch, or that a pinch breaks anything the canvas does. Its two reasons were that the gesture "would either
   do nothing" -- which is not a harm -- and that it would "scale the page under a board that is meant to be
   locked", which is a restatement of the page-level lock in `public/index.html`, not a property of this file.
   That lock is withdrawn (#1618 there), so the only argument for `pan-x pan-y` is gone with it, and the value
   goes back to the one #773 reasoned its way to.

   NOTHING ON THE CANVAS COMPETES WITH A PINCH, which is the check that had to be made before changing this
   rather than after. `HexGridRenderer` has no pan, no `setPointerCapture` and no internal zoom: `handlePointerMove`
   does hover only, `handlePointerDown` records an origin purely as the click-vs-drag test, and `setView` is
   called once, on the fit pass. And `handlePointerCancel` already exists, already clears the press state, and
   was written for exactly this -- "the browser took the gesture over". A second finger landing on the board
   now ends a press that was going nowhere and zooms the page, which is the correct outcome for both.

   THE DIFFERENCE FROM `none`, AND WHY THIS IS NOT A REGRESSION OF #773: `manipulation` permits scroll AND
   pinch and suppresses the double-tap-zoom delay. It is strictly more permissive than `pan-x pan-y`, so every
   gesture that worked under #1014 still works; the page still scrolls under a finger resting on the board, and
   a tap still selects a hex with no 300ms wait. `auto` would have reinstated that wait, so it is still wrong.

   WHAT IS STILL NOT CHANGED HERE: `handleWheel`'s unconditional `preventDefault`. #773 explained why it is
   left alone and that reasoning is untouched -- but note for the record that it also swallows Ctrl+wheel, so a
   DESKTOP mouse cannot browser-zoom while the cursor is over the canvas. That is a separate defect with a
   separate one-line fix (`if (event.ctrlKey) return;` ahead of the `preventDefault`), and desktop mouse
   behaviour was explicitly out of scope for this pass. It is recorded, not fixed.
   -- CORRECTED BY #1619. The record above was read from the source and is wrong about the browser: the
   `preventDefault` was inert, so nothing was being swallowed and the one-line fix would have changed nothing.
   The handler is removed instead. This is the second time this file has reasoned about the wheel from the
   source alone and the second time the source read stronger than the behaviour -- the lesson is in
   `HexGridRenderer` #1619. Platform findings about modifier conventions were gathered for that pass and live
   in `claude/railmap-wheel-zoom-2026-09-17.md` with their platforms, versions and sources; nothing in this
   repository keeps them current, so re-check them before relying on any of them. */
export const MAP_TOUCH_ACTION = "manipulation";

/** A mouse is precise and its dead zone should stay tight, or a genuine drag of a few pixels registers as a
 *  click. A finger is not, and 10px is roughly the slop the platform's own controls allow. */
export const MOUSE_TAP_SLOP_PX = 4;
export const TOUCH_TAP_SLOP_PX = 10;

/** The dead zone for this pointer. Anything that is not a mouse -- touch, pen, or a browser that declines to
 *  say -- gets the generous figure: mistaking a tap for a drag loses the action outright, while mistaking a
 *  small drag for a tap opens a picker the player can dismiss. The cheap failure is the right default. */
export function tapSlopPx(pointerType: string | undefined): number {
  return pointerType === "mouse" ? MOUSE_TAP_SLOP_PX : TOUCH_TAP_SLOP_PX;
}

/** Whether a press that moved `movedDistancePx` should be treated as a selection rather than the tail of a
 *  drag. */
export function isTapGesture(pointerType: string | undefined, movedDistancePx: number): boolean {
  return movedDistancePx <= tapSlopPx(pointerType);
}
