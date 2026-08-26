/** @jest-environment node */
//
// Pure arithmetic plus two source scans; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 720 (harness): THE PANEL WAS ANCHORED, NOT UNSCROLLABLE
// ==================================================================
//
// REPORTED: "The 'Buy Private Company' subpanel is so large and unscrollable that I can't even see it all ...
// for some reason my scrolling is taking me down the page but not the subpanel."
//
// THE SECOND SENTENCE IS THE DIAGNOSIS. A `position: sticky` element stops at its offset; whatever hangs below
// the fold at that moment never moves again, because the page scrolls underneath it and it does not. Nothing
// about the panel was unscrollable -- it was anchored, and no gesture reaches the bottom of an anchored box
// taller than its own pin space.
//
// SO THE CASES BELOW ARE ABOUT HEIGHT AND NOTHING ELSE, which is also the argument against the obvious
// alternative implementation. Keying this to "is a subpanel mounted" would pass a test written around the Buy
// Private panel and still be wrong twice: a short panel on a tall screen would lose the pinning #297 wants,
// and a heavily wrapped bar with no panel would still trap on a short screen. There is no test for "a subpanel
// is mounted" here on purpose.

import {
  STICKY_MAX_VIEWPORT_SHARE,
  canPinWithoutTrapping,
  shouldCondenseSticky,
} from "./stickyCollapse";

/** A 900px laptop viewport with the bar pinned to the very top. */
const VIEWPORT = 900;
const TOP = 0;

describe("an ordinary bar still pins", () => {
  it("pins a one-line control strip", () => {
    // ~50px of buttons against 900 of viewport: the case #297 added sticky for, untouched.
    expect(canPinWithoutTrapping(52, VIEWPORT, TOP)).toBe(true);
  });

  it("pins a wrapped bar on a small laptop", () => {
    /* THE MARGIN THAT MAKES THIS SAFE TO SHIP. Three wrapped rows on a 600px window is still well inside the
       rule, so the change cannot quietly cost the pinning on ordinary screens -- which is the only way a fix
       for a rare panel could make the common case worse. */
    expect(canPinWithoutTrapping(150, 600, TOP)).toBe(true);
  });

  it("respects a pin line below a fixed header", () => {
    /* `stickyTop` is read from the element's own computed style (#480), so the usable space is the viewport
       MINUS the offset. A bar pinning 200px down has 700 to work with, not 900. */
    expect(canPinWithoutTrapping(360, VIEWPORT, 200)).toBe(false);
    expect(canPinWithoutTrapping(340, VIEWPORT, 200)).toBe(true);
  });
});

describe("a bar that would trap does not pin", () => {
  it("refuses a panel taller than the viewport", () => {
    // THE REPORT: the bottom of this is unreachable for the rest of the scroll if it pins.
    expect(canPinWithoutTrapping(1200, VIEWPORT, TOP)).toBe(false);
  });

  it("refuses one that merely fits", () => {
    /* FITTING IS WHERE IT BECOMES READABLE, NOT WHERE PINNING BECOMES A GOOD IDEA. An 880px bar in a 900px
       window is technically reachable and covers the entire page it is supposed to be floating over. */
    expect(canPinWithoutTrapping(880, VIEWPORT, TOP)).toBe(false);
  });

  it("turns over at half the usable height", () => {
    // The boundary, stated against the exported constant rather than a copied number.
    const half = VIEWPORT * STICKY_MAX_VIEWPORT_SHARE;
    expect(canPinWithoutTrapping(half, VIEWPORT, TOP)).toBe(true);
    expect(canPinWithoutTrapping(half + 1, VIEWPORT, TOP)).toBe(false);
  });

  it("refuses when there is no usable space at all", () => {
    expect(canPinWithoutTrapping(50, 100, 100)).toBe(false);
  });
});

describe("an unmeasured bar behaves exactly as it did before #720", () => {
  it.each([
    ["a zero viewport", 400, 0],
    ["a NaN viewport", 400, Number.NaN],
    ["an unmeasured panel", 0, VIEWPORT],
  ])("pins with %s", (_label, height, viewport) => {
    /* THE FALLBACK IS THE OLD BEHAVIOUR, deliberately. First paint, SSR and a browser mid-layout all produce
       these, and the safe answer for a change like this is the one that cannot regress anything: stick, as it
       always did, and correct a frame later when the measurement arrives. */
    expect(canPinWithoutTrapping(height as number, viewport as number, TOP)).toBe(true);
  });
});

describe("a bar that cannot pin must not condense", () => {
  it("would otherwise shed rows just for scrolling past", () => {
    /* THE BUG THIS PAIRING PREVENTS, and the reason the two flags are computed from one measurement. #480's
       predicate reads `rect.top - stickyTop`, which for a STATIC element simply goes negative as it leaves the
       screen -- so an unpinned bar would collapse on the way out, discarding content to reclaim space nothing
       was competing for. The predicate is unchanged and correct; it just must not be asked. */
    expect(shouldCondenseSticky(-400, false)).toBe(true);
    expect(canPinWithoutTrapping(1200, VIEWPORT, TOP)).toBe(false);
  });
});

describe("the bar wires both flags to the same measurement", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  };

  it("measures height and pin distance from one rect", () => {
    /* Two `getBoundingClientRect()` calls would be two forced layouts per frame for figures that have to agree
       with each other -- and the cheapest way for them to disagree is to be read at different moments. */
    const bar = read("panels/ContextualActionBar.tsx");
    /* Design note #837: the PIN TEST reads the resting height and the clearance reads the rect, and both come
       off the one `getBoundingClientRect()` this test guards -- `restingHeight` takes its own total from the
       node it is handed, which is why the count below is still one here. */
    expect(bar).toContain("canPinWithoutTrapping(restingHeight(node), window.innerHeight, stickyTop)");
    expect(bar).toContain("const distanceToPin = rect.top - stickyTop;");
    /* ==================================================================
        SCOPED TO THE HOOK, AND IT WAS NOT (design note #837a)
       ==================================================================
       This counted `getBoundingClientRect()` across the WHOLE FILE and required exactly one -- which stopped
       being true at #813, when `useStickyFitProbe` was added with two reads of its own. The file has had
       three since; the assertion has been false ever since; and it went green anyway because the `toContain`
       above it in the same `it` failed first only today, and passed silently before.
       AN ASSERTION MASKED BY ITS NEIGHBOUR is the fourth flavour of stale harness this session has turned up,
       after the migrating slice boundary, the reproduced-rule copy, and the whole-file absence used as a
       proxy. Two of those were in this same batch of sticky tests.
       THE PROPERTY WAS ALWAYS ABOUT THE HOOK: the pin test and the pin distance must come off ONE rect, so
       they cannot be read at different moments and disagree. The probe is a separate instrument that reads
       separate nodes, and it was never in scope. */
    const hookStart = bar.indexOf("function useCondensedWhenPinned(");
    expect(hookStart).toBeGreaterThan(-1);
    const hook = bar.slice(hookStart, bar.indexOf("function useStickyFitProbe(", hookStart));
    expect(hook.length).toBeGreaterThan(0);
    expect(hook.match(/getBoundingClientRect\(\)/g) ?? []).toHaveLength(1);
  });

  it("applies the unpinned style to every form of the bar", () => {
    /* THE REDIRECT FORM TOO. It is one button tall and will never trip the rule; what it must not become is
       the copy that disagrees once somebody grows it. */
    const bar = read("panels/ContextualActionBar.tsx");
    expect(bar.match(/mayPin \? \{\} : styles\.actionBarUnpinned/g) ?? []).toHaveLength(2);
  });

  it("unpins by position rather than by a nested scroller", () => {
    /* #13/item 1 removed `overflow: auto` from the panes as "exactly the inner scrollbar this item asks to
       eliminate", and #655 found a `maxHeight` on this bar was "the bug it warned about". A third attempt at
       that shape is the regression this asserts against. */
    const styles = read("styles/appStyles.ts");
    const rule = styles.slice(styles.indexOf("  actionBarUnpinned: {"));
    const body = rule.slice(0, rule.indexOf("},"));
    expect(body).toContain('position: "static"');
    expect(body).not.toContain("maxHeight");
    expect(body).not.toContain("overflow");
  });
});
