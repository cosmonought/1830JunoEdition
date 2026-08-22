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

/* ==================================================================
 *  DESIGN NOTE 720: A STICKY PANEL TALLER THAN THE VIEWPORT IS A TRAP
 * ==================================================================
 *
 * REPORTED: "The 'Buy Private Company' subpanel is so large and unscrollable that I can't even see it all
 * ... for some reason my scrolling is taking me down the page but not the subpanel. I guess if a subpanel is
 * going to be this huge, it would be better to disable the sticky feature."
 *
 * THE DIAGNOSIS IS IN THE SECOND SENTENCE, and it is a property of `position: sticky` rather than anything
 * about this panel. A sticky element travels with the page until its top edge reaches its offset, and then
 * STOPS. If the element is taller than the space between that offset and the bottom of the viewport, the part
 * hanging below the fold never moves again: the page scrolls underneath it, the element does not, and there is
 * no gesture that reaches the bottom of it. Scrolling "takes you down the page but not the subpanel" is the
 * exact symptom, described precisely.
 *
 * IT IS A REGRESSION OF #715, and worth naming as one. Moving Buy Private out of a modal and into the bar was
 * right -- a modal you have to click into is not a step -- but the bar it moved into is sticky, and nothing
 * checked whether the bar could still hold what was being put in it. The panel was fine floating; it is the
 * COMBINATION that traps.
 *
 * SO THE BAR STICKS ONLY WHILE IT IS SMALL ENOUGH TO STICK -- measured, not assumed, and not keyed to "is a
 * subpanel mounted". A proxy would be wrong in both directions: a short panel on a tall screen would lose the
 * sticky behaviour #297 wants for no reason, and a heavily wrapped bar with no panel at all would still trap
 * on a short screen. The bug is about height, so the condition is about height.
 *
 * HALF THE VIEWPORT, not "does it fit". Fitting is the point at which the panel becomes READABLE; it is not
 * the point at which sticking it is a good idea. A sticky element is a companion to the content it floats
 * over, and past half the screen the content is the passenger. That leaves an enormous margin over a real
 * bar -- 50px of controls against 350 on a small laptop -- so the ordinary case is untouched, which is the
 * property that matters most here.
 *
 * NO INNER SCROLLBAR, which is the other obvious fix and is already twice rejected: #13/item 1 removed
 * `overflow: auto` from the panes as "exactly the inner scrollbar this item asks to eliminate", and #655 found
 * a `maxHeight` on this very bar was "the bug it warned about". A nested scroller here would be a third
 * attempt at a shape this project has twice reported as wrong.
 */

/** The largest share of the usable viewport a sticky panel may occupy and still pin. */
export const STICKY_MAX_VIEWPORT_SHARE = 0.5;

/** Whether a panel is short enough to be worth pinning.
 *
 *  `false` means render it as an ordinary block: it scrolls away with the page, which is the behaviour a tall
 *  panel needs and the only one that lets a player reach its bottom.
 *
 *  UNMEASURABLE MEANS STICK. A zero or non-finite viewport is the first paint, SSR, or a browser that has not
 *  laid out yet -- and the pre-#720 behaviour was to stick always, so an unmeasured panel behaving exactly as
 *  it did before is the change that cannot regress anything. The measurement arrives a frame later. */
export function canPinWithoutTrapping(
  panelHeight: number,
  viewportHeight: number,
  stickyTop: number,
): boolean {
  if (!Number.isFinite(panelHeight) || panelHeight <= 0) return true;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return true;
  const usable = viewportHeight - (Number.isFinite(stickyTop) ? stickyTop : 0);
  if (usable <= 0) return false;
  return panelHeight <= usable * STICKY_MAX_VIEWPORT_SHARE;
}
