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
  STICKY_RELEASE_VIEWPORT_SHARE,
  canPinWithoutTrapping,
  shouldCondenseSticky,
  shouldReleasePin,
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
       node it is handed, which is why the count below is still one here.
       Design note #863 CHANGED THE CALL THIS NAMED. It used to read
         expect(bar).toContain('canPinWithoutTrapping(restingHeight(node), window.innerHeight, stickyTop)');
       and the property it was defending is unchanged: the pin test reads `restingHeight(node)`, not the rect.
       Only the function asking has changed, so the needle follows it. */
    expect(bar).toContain("wasPinned ? rect.height : restingHeight(node)");
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

// ==================================================================
//  DESIGN NOTE 863 (harness): THE BAND BETWEEN THE TWO THRESHOLDS
// ==================================================================
//
// REPORTED TWICE, IDENTICALLY. 4d: "when I closed that Upcoming trans section, the Action Bar stayed pinned
// instead of becoming sticky again." 5d: "Like 4d before, closing the PC leaves the Action Bar pinned and
// doesn't return it to being sticky."
//
// THE ARITHMETIC IS THE PROOF, so it is asserted rather than described. A bar whose resting height sits
// between the two thresholds -- above 50% of the usable viewport, below 80% -- was sticky (nothing under 80%
// ever released it) and, once released by a fold the player opened, could not come back (nothing above 50%
// ever readmitted it). The first test below pins that band down as a real, non-empty set of heights; the
// second shows the old rule refusing and the new rule allowing on the SAME number.
describe("a bar released by a fold comes back when the fold closes", () => {
  /* The file's own 900px laptop, pinned at the top, so every figure below is a share of the same 900.
     The bar's own height with everything foldable CLOSED -- 60% of the viewport. Above the comfort
     threshold, below the trapping one: the band both reports landed in. */
  const RESTING = 540;
  /* The same bar with a five-private list or the train roster open. */
  const EXPANDED = 800;

  it("puts a real range of heights between the two thresholds", () => {
    /* THE BAND IS NOT EMPTY, which is what makes this a bug rather than a corner. If the constants ever move
       so that the comfort threshold meets or passes the trapping one, this whole class of fault disappears
       and so should the test -- so it asserts the relationship rather than the numbers. */
    expect(STICKY_MAX_VIEWPORT_SHARE).toBeLessThan(STICKY_RELEASE_VIEWPORT_SHARE);
    expect(RESTING).toBeGreaterThan(VIEWPORT * STICKY_MAX_VIEWPORT_SHARE);
    expect(RESTING).toBeLessThan(VIEWPORT * STICKY_RELEASE_VIEWPORT_SHARE);
  });

  it("released the bar for the right reason", () => {
    // The expansion is genuinely trapping, so #758's release is correct and stays.
    expect(shouldReleasePin(EXPANDED, VIEWPORT, TOP)).toBe(true);
    // And the resting form never was.
    expect(shouldReleasePin(RESTING, VIEWPORT, TOP)).toBe(false);
  });

  it("would have refused to take it back under the old comfort test", () => {
    /* THE BUG, PRESERVED AS ARITHMETIC. This is what the return edge used to ask, and on a bar that had been
       happily sticky at this exact height one second earlier it answers no -- permanently, because closing
       the fold does not change the resting height it is judging. */
    expect(canPinWithoutTrapping(RESTING, VIEWPORT, TOP)).toBe(false);
  });

  it("takes it back on the trapping test the release used", () => {
    // The new return edge: same height, same viewport, and the answer a player expects.
    expect(shouldReleasePin(RESTING, VIEWPORT, TOP)).toBe(false);
  });

  it("still refuses a bar that is oversized at rest", () => {
    /* THE OTHER SIDE, so "come back" is not "always come back". A bar past the trapping threshold with
       everything closed has nothing to fold away and must stay put -- #720's outcome, reached by the rule
       that actually runs. */
    const OVERSIZED = 760; // 84% of 900
    expect(OVERSIZED).toBeGreaterThan(VIEWPORT * STICKY_RELEASE_VIEWPORT_SHARE);
    expect(shouldReleasePin(OVERSIZED, VIEWPORT, TOP)).toBe(true);
  });
});

describe("the bar asks the two questions of the two heights", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  };
  const BAR = read("panels/ContextualActionBar.tsx");
  const CODE = BAR.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("keeps #851's split of resting from actual", () => {
    /* THE HYSTERESIS IS THE HEIGHT SOURCE. A pinned bar is judged on the pixels on screen, an unpinned one on
       its resting form -- which is what lets a deliberately opened fold release the pin and closing it undo
       that. Collapsing these to one height in either direction is the regression. */
    expect(CODE).toContain("wasPinned ? rect.height : restingHeight(node)");
  });

  it("asks one threshold on both edges", () => {
    /* #863: the comfort test is no longer a decision anywhere in the hook. Asserted as an ABSENCE from the
       hook rather than from the file, because the fit probe still consults it as an instrument and that is
       deliberate -- see the next test. */
    const start = CODE.indexOf("function useCondensedWhenPinned(");
    expect(start).toBeGreaterThan(-1);
    const end = CODE.indexOf("function useStickyFitProbe(", start);
    expect(end).toBeGreaterThan(start);
    const hook = CODE.slice(start, end);
    expect(hook).not.toContain("canPinWithoutTrapping");
    expect(hook).toContain("shouldReleasePin(");
  });

  it("leaves the comfort rule available to the instrument", () => {
    /* NOT DELETED, AND THE DISTINCTION MATTERS. #720's constant still describes something true -- half the
       viewport is where a companion becomes a passenger -- and the fit probe reports that verdict so a
       playtest can see it. What #863 withdrew is its power to decide, not its opinion. */
    expect(CODE).toContain("canPinWithoutTrapping(resting, viewport, stickyTop)");
  });

  it("still carries the player when it releases (design note #861)", () => {
    /* ASKED AGAIN FOR THIS PANEL: "I think 4e's solution is necessary here as well: if the Action Bar is
       going to abruptly pin, it needs to carry the player with it through an auto-scroll."
       IT ALREADY DOES, AND THIS IS WHY -- the scroll lives in `measure`, which is one function serving every
       step. There is no per-panel path for it to miss. Asserted here rather than assumed, because "the
       general mechanism covers this case" is a claim, and an untested claim about a shared code path is how
       #862's list fell out of date. */
    expect(CODE).toContain("if (wasPinned && !pinnable) node.scrollIntoView(");
  });
});
