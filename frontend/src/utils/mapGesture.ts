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
//
// A TAP IS NOT A CLICK, second half. The click-vs-drag test used a flat 4px dead zone, which is right for a
// mouse and wrong for a finger: a fingertip covers about 40px and rolls several pixels in the act of
// pressing. At 4px a genuine tap reads as a drag and selects nothing -- so a player who worked out that they
// had to unlock the view to move the map would then find the map unresponsive to taps. Not part of the
// report; fixed here because it is the same surface, the same input and the same next bug report.

/** What the map canvas should declare for `touch-action`, given whether drag-to-pan is live.
 *  `"none"`: the canvas owns the gesture and pans with it.
 *  `"manipulation"`: the browser may scroll and pinch; taps still reach the canvas. */
export function canvasTouchAction(detailedView: boolean): "none" | "manipulation" {
  return detailedView ? "none" : "manipulation";
}

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
