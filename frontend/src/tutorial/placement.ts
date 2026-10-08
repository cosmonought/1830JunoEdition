// frontend/src/tutorial/placement.ts
//
/* ==================================================================
    PHASE 3 FINAL PLAY TUTORIAL: WHERE THE COACH CARD GOES
   ==================================================================
   PURE GEOMETRY, IN VIEWPORT PIXELS, so it is unit-tested deterministically and re-run on every resize, scroll and
   UI-scale change. Inputs are `getBoundingClientRect()` boxes (viewport coordinates, which already include the
   shell's zoom); the coach itself renders outside the zoomed shell (a portal to `document.body`), so its numbers are
   the same pixels.

   RULES:
   1. NEVER COVER THE TARGET. The highlighted element is the thing the player has to act on, so a placement that
      overlaps it is never chosen. Tried in order: below, above, right, left -- each centred on the target and slid
      to stay inside the viewport.
   2. AVOID THE FIXED CHROME (the sticky action dock at the top, the status dock at the bottom) when a placement can;
      only if no side clears them is overlapping chrome accepted (still never the target).
   3. FALL BACK TO AN UNANCHORED CARD -- bottom-right, above the bottom chrome -- when there is no target, or no side
      fits without covering it. */

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacementInput {
  readonly target: Box | null;
  readonly card: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  /** Fixed chrome to keep clear of where possible. */
  readonly avoid?: readonly Box[];
  readonly margin?: number;
}

export type PlacementSide = "below" | "above" | "right" | "left" | "floating";

export interface Placement {
  readonly top: number;
  readonly left: number;
  readonly side: PlacementSide;
}

/** The coach card's width, in viewport pixels, at a viewport width and UI scale: 360px at 100%, growing and
 *  shrinking with the scale, never wider than the viewport allows. */
export function coachWidth(viewportWidth: number, margin = 12, uiScale = 1): number {
  const room = Math.max(0, viewportWidth - margin * 2);
  return Math.min(room, Math.max(200, Math.round(360 * uiScale)));
}

export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

function union(a: Box, b: Box): Box {
  const top = Math.min(a.top, b.top);
  const left = Math.min(a.left, b.left);
  return {
    top,
    left,
    width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top,
  };
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

function fitsViewport(box: Box, viewport: PlacementInput["viewport"], margin: number): boolean {
  return (
    box.left >= margin - 0.5 &&
    box.top >= margin - 0.5 &&
    box.left + box.width <= viewport.width - margin + 0.5 &&
    box.top + box.height <= viewport.height - margin + 0.5
  );
}

/** The floating (unanchored) position: bottom-right, above any chrome pinned to the bottom edge and below any
 *  pinned to the top. */
export function floatingPlacement(input: PlacementInput): Placement {
  const margin = input.margin ?? 12;
  const { card, viewport } = input;
  const avoid = input.avoid ?? [];
  let topLimit = margin;
  let bottomLimit = viewport.height - margin;
  for (const box of avoid) {
    const bottom = box.top + box.height;
    if (box.top <= margin && bottom < viewport.height / 2) topLimit = Math.max(topLimit, bottom + margin);
    if (bottom >= viewport.height - margin && box.top > viewport.height / 2) bottomLimit = Math.min(bottomLimit, box.top - margin);
  }
  const left = clamp(viewport.width - card.width - margin, margin, viewport.width - card.width - margin);
  const top = clamp(bottomLimit - card.height, topLimit, viewport.height - card.height - margin);
  return { top, left, side: "floating" };
}

export function placeCoach(input: PlacementInput): Placement {
  const margin = input.margin ?? 12;
  const { target, card, viewport } = input;
  const avoid = input.avoid ?? [];
  if (!target) return floatingPlacement(input);

  /* A target INSIDE fixed chrome (a button on the sticky action dock) is placed around the chrome it sits in, so the
     card does not cover the rest of that dock either; the spotlight still marks the target itself. */
  const anchor = avoid.filter((chrome) => overlaps(chrome, target)).reduce<Box>(union, target);

  const centredLeft = clamp(target.left + target.width / 2 - card.width / 2, margin, viewport.width - card.width - margin);
  const centredTop = clamp(target.top + target.height / 2 - card.height / 2, margin, viewport.height - card.height - margin);
  const candidates: { side: PlacementSide; box: Box }[] = [
    { side: "below", box: { top: anchor.top + anchor.height + margin, left: centredLeft, ...card } },
    { side: "above", box: { top: anchor.top - margin - card.height, left: centredLeft, ...card } },
    { side: "right", box: { top: centredTop, left: anchor.left + anchor.width + margin, ...card } },
    { side: "left", box: { top: centredTop, left: anchor.left - margin - card.width, ...card } },
    /* Hugging the target itself, should the chrome around it leave no room. */
    { side: "below", box: { top: target.top + target.height + margin, left: centredLeft, ...card } },
    { side: "above", box: { top: target.top - margin - card.height, left: centredLeft, ...card } },
  ];
  const legal = candidates.filter(({ box }) => fitsViewport(box, viewport, margin) && !overlaps(box, target));
  const clear = legal.find(({ box }) => !avoid.some((chrome) => overlaps(box, chrome)));
  const chosen = clear ?? legal[0];
  if (chosen) return { top: chosen.box.top, left: chosen.box.left, side: chosen.side };
  /* No side fits: try the four corners (bottom-right first) and take the first that keeps the target clear, else the
     one that covers the least of it. */
  const floating = floatingPlacement(input);
  const corners: Box[] = [
    { top: floating.top, left: floating.left, ...card },
    { top: floating.top, left: margin, ...card },
    { top: margin, left: floating.left, ...card },
    { top: margin, left: margin, ...card },
  ];
  const area = (a: Box, b: Box) =>
    Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  const best = corners.find((corner) => !overlaps(corner, target)) ?? [...corners].sort((a, b) => area(a, target) - area(b, target))[0];
  return { top: best.top, left: best.left, side: "floating" };
}
