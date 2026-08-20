// When a `position: sticky` panel should switch to its condensed form.
//
// Design note #480: the old test was `window.scrollY > 24`, which measures "has
// the page moved", not "is the panel pinned". Those coincide only if the panel
// is first on the page, and it is not -- a room strip, a tab rail and a header
// sit above it. So it collapsed while still mid-viewport with its full height
// available, throwing away rows of content to reclaim space that was not under
// pressure, 24 pixels into a wheel gesture.
//
// A sticky element is PINNED exactly when its top edge reaches its sticky
// offset, so the measurement is `getBoundingClientRect().top - stickyTop`. It is
// self-correcting: anything above can change height and the number still means
// the same thing.
//
// WHY NOT AN INTERSECTION OBSERVER SENTINEL -- the canonical trick, and the
// first thing tried. It needs a zero-height marker above the sticky node, and
// this panel's parent is a flex column, where a zero-height child still collects
// the container's `gap`. The cure would have been a negative margin cancelling a
// height that exists only to be observed.
//
// Design note #480a: collapsing shortens the document, the browser CLAMPS the
// scroll near the bottom of a page, and the clamp pushes the panel back below
// the trigger line -- a loop that presents as the bar flickering. The asymmetric
// threshold breaks it: collapse exactly at the pin line, release only a few
// pixels clear of it.
//
// See docs/ai_architecture/ui_shell_layout.md, stickyCollapse.ts #480 / #480a.

/** How far below the pin line the panel's top edge must return before the
 *  condensed form is released. See design note #480a -- this is a loop
 *  breaker, not a comfort margin, which is why it is single digits. */
export const STICKY_RELEASE_SLACK_PX = 8;

/** Whether a sticky panel should render its condensed form.
 *
 *  `distanceToPin` is `element.getBoundingClientRect().top - stickyTop`: positive
 *  while the panel is still travelling toward its pin line, zero at the moment it
 *  pins and for as long as it stays pinned (a stuck element's rect top IS its
 *  sticky offset). `wasCondensed` is the current state, because the threshold is
 *  deliberately asymmetric -- see design note #480a. */
export function shouldCondenseSticky(distanceToPin: number, wasCondensed: boolean): boolean {
  // A `NaN` here would make both comparisons false and silently latch the
  // panel expanded. Treating an unmeasurable panel as "not pinned" is the
  // same answer, but arrived at on purpose.
  if (!Number.isFinite(distanceToPin)) return false;
  return wasCondensed ? distanceToPin <= STICKY_RELEASE_SLACK_PX : distanceToPin <= 0;
}

/** The sticky offset a node is pinned at, read from its own computed style.
 *
 *  Read rather than assumed: `actionBar` uses `top: 0` today, and a panel that
 *  later pins below a fixed header would otherwise collapse a header's height too
 *  early -- the same class of error design note #480 is about. `auto` and any
 *  unparseable value mean "not offset", which for a sticky element is 0. */
export function stickyTopOffset(declaredTop: string | null | undefined): number {
  const parsed = Number.parseFloat(declaredTop ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
