/** @jest-environment node */
//
// The rail map hands the page back to the browser in the mode it does not pan. No React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 773 (harness): A PROMISE THE MAP DID NOT KEEP
// ==================================================================
//
// REPORTED: "This may be a 'mobile only' issue, but a player on an iPad cannot scroll when looking at the
// rail map."
//
// WHY THIS IS A SOURCE SCAN AND NOT A RENDER TEST, said plainly because it is the weakness of this file:
// jsdom has no compositor and no scroller. It will happily report `touch-action: none` and can tell you
// nothing about whether a finger moves the page, so a passing render test here would be pure theatre. What
// CAN be pinned exactly is the declaration itself and the rule that produces it -- and the bug was in the
// declaration: a literal `"none"` that no mode ever reconsidered.
//
// SO THE PLAYTEST IS PART OF THE VERIFICATION, not an afterthought to it. These tests say the canvas asks
// `canvasTouchAction` and that `canvasTouchAction` answers correctly. Whether an iPad then scrolls is a
// question only an iPad answers.
//
// #490a: the scan strips comments first, because the notes above and in the renderer both QUOTE the wrong
// declaration in the course of explaining it.

import {
  MAP_TOUCH_ACTION,
  isTapGesture,
  tapSlopPx,
  MOUSE_TAP_SLOP_PX,
  TOUCH_TAP_SLOP_PX,
} from "./mapGesture";

const RENDERER = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", "components", "HexGridRenderer.tsx"), "utf8");
})();

/** The renderer with every comment removed -- #490a: a note explaining the old literal must not read as the
 *  old literal. */
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ==================================================================
   DESIGN NOTE 1014 (harness): #773's RULE OUTLIVED ITS FUNCTION
   ==================================================================
   `canvasTouchAction(detailedView)` is gone -- the camera is locked, so there is no second mode for it to
   answer about. Every case below that took an argument now asserts the single constant, and the RULE they
   were written to protect is unchanged and still asserted: the page must stay scrollable under a finger, and
   a tap must not sit behind a double-tap-zoom delay. What is new is the third property, which this batch
   asked for: a pinch must not scale anything.
   -- THE THIRD PROPERTY IS WITHDRAWN BY #1618. The first two are not.

   ==================================================================
   DESIGN NOTE 1618 (harness): ASSERT WHAT THE VALUE PERMITS, NOT HOW IT IS SPELLED
   ==================================================================
   #1014's third property was never a property of the MAP. The canvas had no zoom for a pinch to reach either
   before or after it, so "a pinch must not scale anything" was the page-level viewport lock reaching down into
   a style object. `public/index.html` #1618 withdraws that lock, so the property goes with it and the value
   returns to the one #773 reasoned its way to.

   THE TABLE IS THE POINT OF THIS REWRITE. Every version of this block turned on what a `touch-action` value
   MEANS, and every version was written as a substring match that could not say so -- which is how `pan-x`
   plus `pan-y` came to stand in for "the page scrolls" and then had to be edited when the spelling changed
   under a property that had not. Below is the CSS spec's answer for the four values this constant has ever
   held; the cases assert permissions against it. jsdom still cannot move a page (see the header), so this is
   as close to behaviour as this file can get -- an iPad is still the only thing that answers for certain. */
const PERMITS: Record<string, { pageScroll: boolean; pinch: boolean; doubleTapDelay: boolean }> = {
  none: { pageScroll: false, pinch: false, doubleTapDelay: false },
  "pan-x pan-y": { pageScroll: true, pinch: false, doubleTapDelay: false },
  manipulation: { pageScroll: true, pinch: true, doubleTapDelay: false },
  auto: { pageScroll: true, pinch: true, doubleTapDelay: true },
};

describe("the canvas hands back every gesture it does not use", () => {
  it("declares a value this file knows the meaning of", () => {
    /* THE GUARD ON THE GUARD. Every case below reads the table, so an unrecognised value would otherwise
       throw on a property of `undefined` and report as a crash rather than as the decision it is. A new value
       here is a deliberate change: add its row, with the spec's answer, and the cases will judge it. */
    expect(Object.keys(PERMITS)).toContain(MAP_TOUCH_ACTION);
  });

  it("leaves the page scrollable under a finger", () => {
    // THE #773 REPORT, and the property that outlived both the camera lock and its withdrawal.
    expect(PERMITS[MAP_TOUCH_ACTION].pageScroll).toBe(true);
  });

  it("never claims the gesture outright", () => {
    /* `none` was the original bug: one word in a style object that disabled the page's scroller on every
       touch device. There is no mode left that would justify it. */
    expect(MAP_TOUCH_ACTION).not.toBe("none");
  });

  it("keeps taps working", () => {
    /* `auto` would reinstate the double-tap-zoom delay in front of every hex selection -- #773's reason for
       preferring `manipulation`, and the reason this value is not simply `auto` now that panning is gone. */
    expect(PERMITS[MAP_TOUCH_ACTION].doubleTapDelay).toBe(false);
    expect(MAP_TOUCH_ACTION).not.toBe("auto");
  });

  it("permits the pinch, which is #1618's correction", () => {
    /* WAS `it("refuses the pinch, which is this batch's instruction")`, asserting `not.toBe("manipulation")`
       and `not.toContain("pinch-zoom")` -- an absence, "because the tempting simplification back to
       `manipulation` reads as equivalent and is not". It was not equivalent, and the difference is exactly
       what #1618 wants back: the board is most of a phone screen, so a canvas that refuses the pinch refuses
       it almost everywhere a reader would put two fingers. Asserted as a presence now, so the reverse
       simplification cannot happen silently either. */
    expect(PERMITS[MAP_TOUCH_ACTION].pinch).toBe(true);
  });

  it("does not enumerate pan axes, which is what refused the pinch", () => {
    /* THE NARROW REGRESSION. `pan-x pan-y` and `manipulation` both scroll the page, so the case above is the
       only one that separates them and it does so through the table. This one names the spelling, because a
       `pan-*` list is the specific thing whose return would quietly re-lock the board. */
    expect(MAP_TOUCH_ACTION).not.toContain("pan-");
  });
});

describe("the finger gets a dead zone a finger can hit", () => {
  it("treats a 6px touch as a tap", () => {
    /* THE SECOND HALF, and the one that would have been reported next: at the old flat 4px a genuine tap
       rolled past the threshold and selected nothing. */
    expect(isTapGesture("touch", 6)).toBe(true);
  });

  it("treats a 6px mouse press as a drag", () => {
    // A mouse is precise, and widening its dead zone would swallow real short drags.
    expect(isTapGesture("mouse", 6)).toBe(false);
  });

  it("holds each pointer to its own figure exactly at the boundary", () => {
    expect(isTapGesture("mouse", MOUSE_TAP_SLOP_PX)).toBe(true);
    expect(isTapGesture("mouse", MOUSE_TAP_SLOP_PX + 0.01)).toBe(false);
    expect(isTapGesture("touch", TOUCH_TAP_SLOP_PX)).toBe(true);
    expect(isTapGesture("touch", TOUCH_TAP_SLOP_PX + 0.01)).toBe(false);
  });

  it("gives an unknown pointer the generous figure", () => {
    /* THE DEFAULT IS CHOSEN BY WHICH FAILURE IS CHEAPER. A tap misread as a drag loses the action with no
       feedback; a small drag misread as a tap opens a picker the player closes. Pen, and any browser that
       declines to name the pointer, get the recoverable one. */
    expect(tapSlopPx(undefined)).toBe(TOUCH_TAP_SLOP_PX);
    expect(tapSlopPx("pen")).toBe(TOUCH_TAP_SLOP_PX);
    expect(tapSlopPx("")).toBe(TOUCH_TAP_SLOP_PX);
  });

  it("still rejects a real pan drag on either pointer", () => {
    expect(isTapGesture("touch", 80)).toBe(false);
    expect(isTapGesture("mouse", 80)).toBe(false);
  });
});

describe("the renderer is wired to the rule rather than to a literal", () => {
  it("asks the rule for its touch-action", () => {
    expect(CODE).toContain("touchAction: MAP_TOUCH_ACTION");
  });

  it("has no hardcoded none left on the canvas", () => {
    /* THE EXACT BUG, pinned as a string. It was one word in a style object and it disabled the page's
       scroller on every touch device. */
    expect(CODE).not.toContain('touchAction: "none"');
  });

  it("asks the rule for its click-vs-drag test", () => {
    expect(CODE).toContain("isTapGesture(event.pointerType, movedDistance)");
    expect(CODE).not.toContain("CLICK_MOVEMENT_THRESHOLD_PX");
  });
});

describe("a gesture the browser takes over is cleaned up", () => {
  it("handles pointercancel at all", () => {
    /* THE CONSEQUENCE OF GIVING SCROLL BACK: `pointerup` stops being guaranteed. A swipe that becomes a page
       scroll fires `pointercancel` instead, and until this pass nothing listened for it. */
    expect(CODE).toContain("onPointerCancel={handlePointerCancel}");
  });

  it("clears the drag origin on cancel", () => {
    /* #762, #766 and #767 were all one ref with an unclear reset. This one gets its reset written down at
       the same time as the code path that needs it. */
    const cancel = CODE.slice(CODE.indexOf("const handlePointerCancel"));
    expect(cancel.slice(0, 400)).toContain("dragStateRef.current = null");
  });

  it("does not run the selection path on a cancel", () => {
    /* A cancelled press is not a tap. If this handler reached `onHexClick` a player scrolling the page would
       lay a tile on whatever their finger started on. */
    const cancel = CODE.slice(
      CODE.indexOf("const handlePointerCancel"),
      CODE.indexOf("const handlePointerMove"),
    );
    expect(cancel).not.toContain("onHexClick");
    expect(cancel).not.toContain("pixelToAxial");
  });

  it("releases capture through the guarded helper everywhere", () => {
    /* `releasePointerCapture` throws for a pointer that is already gone, which is precisely a cancelled
       one -- so the raw call had to go from both handlers, not just the new one. */
    expect(CODE).not.toContain("event.currentTarget.releasePointerCapture(event.pointerId);\n\n");
    expect(CODE.match(/releaseCapture\(event\)/g)?.length).toBe(2);
    expect(CODE).toContain("hasPointerCapture(event.pointerId)");
  });

  it("no longer captures the pointer at all", () => {
    /* Design note #1014: capture is for following a pointer OUTSIDE the element, which is what a drag needs
       and a tap does not. With the pan gone there is nothing to follow -- and #773's objection to capturing
       at the locked baseline ("one more thing standing between a swipe and the browser's scroller") is now
       the only case there is. */
    const down = CODE.slice(
      CODE.indexOf("const handlePointerDown"),
      CODE.indexOf("const handlePointerCancel"),
    );
    expect(down).not.toContain("setPointerCapture");
  });
});

describe("what this pass deliberately did not touch", () => {
  /* ==================================================================
      DESIGN NOTE 1619 (harness): THE WHEEL CASE MOVED, AND IS NOT RESTATED HERE
     ==================================================================
     WHAT WAS HERE: `it("keeps the wheel handler containing scroll -- now for a reason")`, asserting
     `toContain("const handleWheel")`, and then its inverse asserting `not.toContain("onWheel")`. Three notes
     in a row reasoned about that line from the source and all three were wrong about the browser: React
     registers the delegated `wheel` listener as PASSIVE, so the `preventDefault` could not cancel anything
     and there was no containment to defend. Measured in Chromium 141 before the change -- an ordinary wheel
     over the canvas scrolled the page exactly as far as the same wheel over the header, the event arrived
     `cancelable: false`, and Chrome logged "Unable to preventDefault inside passive event listener
     invocation." each time. The handler was removed.

     WHY THERE IS NO ASSERTION LEFT HERE. The inverse -- "the Rail Map has no wheel handler" -- is too blunt
     to be the rule: the canvas may legitimately use the wheel for a real interaction one day, and only the
     CANCEL-ONLY shape is prohibited. That distinction has one owner, `viewportZoom.test.ts` #1619, which
     checks the handler's body rather than its existence and proves both directions. A second, cruder copy of
     a rule is how two rules come to disagree, so this file states the history and defers.
     `railMapWheel.test.tsx` is the behavioural half. */

  it("leaves the tile picker's drag handle claiming its gesture", () => {
    /* `TileSelectionPopup`'s header is `touch-action: none` and correctly so -- it drags in every mode, so
       the promise there is kept. The rule is not "never say none". */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const popup = fs.readFileSync(
      path.join(__dirname, "..", "components", "TileSelectionPopup.tsx"),
      "utf8",
    );
    expect(popup).toContain('touchAction: "none"');
  });
});
