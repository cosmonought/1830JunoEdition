// frontend/src/utils/stickyCollapse.ts
//
// When a `position: sticky` panel should switch to its condensed form.
//
// ===================================================================
//  DESIGN NOTE 480: "SCROLLED AT ALL" IS NOT "PINNED"
// ===================================================================
//
// REPORTED: the Action Panel collapses the moment the page scrolls off the
// absolute top. It should stay expanded until its own top edge reaches the
// top of the screen.
//
// The old test was `window.scrollY > 24`, and it was measuring the wrong
// thing entirely -- not "is the panel pinned" but "has the page moved".
// Those coincide only if the panel is the first thing on the page, which it
// is not: a room strip, a tab rail and a header sit above it. So the panel
// collapsed while it was still sitting in the middle of the viewport with
// its full height available, which is the one moment collapsing buys
// nothing. It threw away rows of content to reclaim space that was not
// under pressure, and it did it 24 pixels into a wheel gesture.
//
// The condition that actually matters is geometric: a sticky element is
// PINNED exactly when its top edge has reached its sticky offset. Before
// that it scrolls with the page like anything else and is costing the map
// nothing extra. After it, it is occupying viewport the board would
// otherwise have -- which is the entire argument design note #298 makes for
// the condensed form.
//
// SO THE MEASUREMENT IS `getBoundingClientRect().top - stickyTop`, not a
// scroll position. It is self-correcting: whatever sits above the panel can
// change height, the header can wrap, a banner can appear, and the number
// still means the same thing.
//
// WHY NOT AN INTERSECTION OBSERVER SENTINEL. That is the canonical trick
// and it was the first thing tried. It needs a zero-height marker element
// rendered immediately above the sticky node -- and this panel's parent is
// a flex column, where a "zero-height" child is not free: it collects the
// container's `gap` and pushes everything below it down by that gap. The
// cure would have been a negative margin to cancel a height that only
// exists to be observed, which is more layout risk than the scroll read it
// replaces. Measuring the panel itself adds no DOM at all.
//
// ===================================================================
//  DESIGN NOTE 480a: THE RELEASE NEEDS SLACK, THE COLLAPSE DOES NOT
// ===================================================================
//
// Collapsing shortens the panel, which shortens the document. Near the
// bottom of a page the browser then CLAMPS the scroll position -- and a
// clamp moves the panel's top edge back down, below the line that
// triggered the collapse, which expands it, which lengthens the document,
// which lets the scroll return. That is a loop, and it presents as the bar
// flickering at the end of a long page.
//
// The asymmetric threshold below breaks it. Collapsing triggers exactly at
// the pin line, so the behaviour a player sees is precisely what was asked
// for. RELEASING requires the top edge to be a few pixels clear of it, so
// a sub-pixel clamp cannot re-cross the boundary on its own. The slack is
// small enough to be invisible in an ordinary upward scroll and large
// enough that nothing but a deliberate scroll can pay it.

/** How far below the pin line the panel's top edge must return before the
 *  condensed form is released. See design note #480a -- this is a loop
 *  breaker, not a comfort margin, which is why it is single digits. */
export const STICKY_RELEASE_SLACK_PX = 8;

/**
 * Whether a sticky panel should render its condensed form.
 *
 * `distanceToPin` is `element.getBoundingClientRect().top - stickyTop`:
 * positive while the panel is still travelling down the page toward its
 * pin line, zero at the moment it pins, and zero for as long as it stays
 * pinned (a stuck element's rect top IS its sticky offset).
 *
 * `wasCondensed` is the current state, because the threshold is
 * deliberately asymmetric -- see design note #480a.
 */
export function shouldCondenseSticky(distanceToPin: number, wasCondensed: boolean): boolean {
  // A `NaN` here would make both comparisons false and silently latch the
  // panel expanded. Treating an unmeasurable panel as "not pinned" is the
  // same answer, but arrived at on purpose.
  if (!Number.isFinite(distanceToPin)) return false;
  return wasCondensed ? distanceToPin <= STICKY_RELEASE_SLACK_PX : distanceToPin <= 0;
}

/**
 * The sticky offset a node is pinned at, read from its own computed style.
 *
 * Read rather than assumed: `actionBar` uses `top: 0` today, and a panel
 * that later pins below a fixed header would otherwise collapse a header's
 * height too early, which is the same class of error design note #480 is
 * about. `auto` and any unparseable value mean "not offset", which for a
 * sticky element is 0.
 */
export function stickyTopOffset(declaredTop: string | null | undefined): number {
  const parsed = Number.parseFloat(declaredTop ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
