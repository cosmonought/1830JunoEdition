// frontend/src/utils/stickyCollapse.test.ts
//
// ==================================================================
//  DESIGN NOTE 480 (harness): PINNED, NOT MERELY SCROLLED
// ==================================================================
//
// The old condition was `window.scrollY > 24`. Every test below fails
// against it, and that is the point of writing them as a threshold rather
// than as a snapshot of the new behaviour: the fault was measuring the page
// instead of the panel, so the tests describe the panel's geometry and say
// nothing about scroll position at all.
//
// THE ASYMMETRY IS THE SUBTLE PART and gets its own block. Collapsing at
// the pin line and releasing a few pixels below it is not a rounding
// allowance -- it is what stops the panel oscillating at the bottom of a
// page, where collapsing shortens the document, the browser clamps the
// scroll, and the clamp pushes the panel back below its own trigger. A test
// that only checked "collapses at 0, expands above 0" would pass against
// the version that flickers.

import {
  STICKY_RELEASE_SLACK_PX,
  shouldCondenseSticky,
  stickyTopOffset,
} from "./stickyCollapse";

describe("collapsing", () => {
  it("stays expanded while the panel is anywhere below the pin line", () => {
    // The reported bug: 24 pixels of page scroll collapsed a panel still
    // sitting in the middle of the viewport. These are all "still on its
    // way there".
    for (const distance of [1, 24, 100, 400, 2000]) {
      expect(shouldCondenseSticky(distance, false)).toBe(false);
    }
  });

  it("collapses exactly when the top edge reaches the pin line", () => {
    // Not before, and not after a grace period -- the requirement is that
    // it "remain fully expanded until its top edge hits the top of the
    // screen", so 0 is the first frame it may condense on.
    expect(shouldCondenseSticky(0, false)).toBe(true);
    expect(shouldCondenseSticky(0.5, false)).toBe(false);
  });

  it("stays collapsed while pinned", () => {
    // A stuck element's rect top IS its sticky offset, so the distance sits
    // at 0 for the whole of a long scroll and must not flicker.
    expect(shouldCondenseSticky(0, true)).toBe(true);
  });

  it("collapses on a negative distance too", () => {
    // Can happen for a frame during a layout shift or a programmatic jump,
    // and it means the panel is past the line rather than short of it.
    expect(shouldCondenseSticky(-40, false)).toBe(true);
    expect(shouldCondenseSticky(-40, true)).toBe(true);
  });
});

describe("releasing", () => {
  it("needs the panel to clear the pin line by more than the slack", () => {
    expect(shouldCondenseSticky(STICKY_RELEASE_SLACK_PX, true)).toBe(true);
    expect(shouldCondenseSticky(STICKY_RELEASE_SLACK_PX + 1, true)).toBe(false);
  });

  it("does not release on a sub-pixel wobble", () => {
    // The oscillation this exists to break: a scroll clamp moves the panel
    // a fraction of a pixel back down its own trigger.
    for (const distance of [0.25, 1, 4]) {
      expect(shouldCondenseSticky(distance, true)).toBe(true);
    }
  });

  it("keeps the slack small enough to be invisible in a real scroll", () => {
    // A loop breaker, not a comfort margin. Pinned as a ceiling so a future
    // "make it less twitchy" pass has to argue with the note rather than
    // nudge past it -- at 40px the expansion would visibly lag the gesture.
    expect(STICKY_RELEASE_SLACK_PX).toBeGreaterThan(0);
    expect(STICKY_RELEASE_SLACK_PX).toBeLessThanOrEqual(12);
  });

  it("is asymmetric -- the same distance means different things each way", () => {
    // The property, stated directly. If a refactor ever collapses the two
    // branches into one comparison, this is what fails.
    const inBand = STICKY_RELEASE_SLACK_PX / 2;
    expect(shouldCondenseSticky(inBand, false)).toBe(false);
    expect(shouldCondenseSticky(inBand, true)).toBe(true);
  });
});

describe("an unmeasurable panel", () => {
  it("is treated as not pinned rather than latching", () => {
    // `NaN` makes every comparison false, which would silently pick one
    // branch. Expanded is the safe answer -- a panel showing too much beats
    // a panel that has thrown rows away for no reason -- but it is chosen
    // here rather than fallen into.
    expect(shouldCondenseSticky(Number.NaN, false)).toBe(false);
    expect(shouldCondenseSticky(Number.NaN, true)).toBe(false);
    expect(shouldCondenseSticky(Number.POSITIVE_INFINITY, true)).toBe(false);
  });
});

describe("stickyTopOffset", () => {
  it("reads the declared offset", () => {
    expect(stickyTopOffset("0px")).toBe(0);
    expect(stickyTopOffset("64px")).toBe(64);
    expect(stickyTopOffset("12.5px")).toBe(12.5);
  });

  it("treats a non-offset as zero", () => {
    // `auto` is what a sticky element without a `top` computes to. Guessing
    // a header's height here would collapse the panel early, which is the
    // very bug being fixed.
    for (const value of ["auto", "", null, undefined, "inherit"]) {
      expect(stickyTopOffset(value)).toBe(0);
    }
  });

  it("does not assume the offset is zero forever", () => {
    // The panel pins at `top: 0` today. This is read rather than hardcoded
    // so a future fixed header does not silently reintroduce the bug.
    expect(stickyTopOffset("48px")).not.toBe(0);
  });
});
