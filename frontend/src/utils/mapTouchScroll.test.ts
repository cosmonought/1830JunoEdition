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
  canvasTouchAction,
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

describe("the canvas claims a gesture only where it uses one", () => {
  it("hands the gesture back at the locked baseline", () => {
    /* THE REPORT. `detailedView` false is where `handlePointerMove` returns without panning, so the browser
       must be free to scroll the page. */
    expect(canvasTouchAction(false)).toBe("manipulation");
  });

  it("keeps taps working while it does", () => {
    /* `manipulation` rather than `auto`: both scroll, but `auto` leaves the double-tap-zoom delay sitting in
       front of every hex selection. Stated as an assertion because "auto" is the obvious thing for a later
       reader to simplify this to. */
    expect(canvasTouchAction(false)).not.toBe("auto");
  });

  it("claims the gesture once drag-to-pan is live", () => {
    // The one mode where the promise is kept: the finger is panning the board, not the page.
    expect(canvasTouchAction(true)).toBe("none");
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
    expect(CODE).toContain("touchAction: canvasTouchAction(detailedView)");
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

  it("captures only where the pan is live", () => {
    // Following a pointer outside the element is what capture is for, and the baseline has nothing to follow.
    const down = CODE.slice(
      CODE.indexOf("const handlePointerDown"),
      CODE.indexOf("const handlePointerCancel"),
    );
    expect(down).toContain("if (detailedView) {");
    expect(down).toContain("setPointerCapture(event.pointerId)");
  });
});

describe("what this pass deliberately did not touch", () => {
  it("leaves the wheel handler containing scroll", () => {
    /* RECORDED AS A DECISION, NOT AN OVERSIGHT. By #773's own rule `handleWheel` should stop calling
       `preventDefault` -- #67 removed wheel-zoom, so it now blocks a gesture while using nothing, and a
       desktop player cannot scroll the page with the cursor over the map. It stays because that containment
       is a deliberate desktop choice, it is not what was reported, and a mouse and a finger wanting the same
       answer is the assumption that wrote the original bug. If it is reported, this is the line to change. */
    expect(CODE).toContain("const handleWheel");
    expect(CODE).toContain("event.preventDefault()");
  });

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
