// frontend/src/tutorial/placement.test.ts -- PHASE 3 FINAL PLAY TUTORIAL: coach placement (deterministic geometry).

import { coachWidth, overlaps, placeCoach, type Box } from "./placement";

const VIEWPORT = { width: 1280, height: 800 };
const CARD = { width: 360, height: 200 };
const box = (top: number, left: number, width: number, height: number): Box => ({ top, left, width, height });
const cardAt = (placement: { top: number; left: number }) => box(placement.top, placement.left, CARD.width, CARD.height);
const inside = (b: Box, margin = 12) =>
  b.left >= margin && b.top >= margin && b.left + b.width <= VIEWPORT.width - margin && b.top + b.height <= VIEWPORT.height - margin;

describe("placeCoach", () => {
  it("prefers below the target, centred on it", () => {
    const target = box(100, 500, 120, 40);
    const placed = placeCoach({ target, card: CARD, viewport: VIEWPORT });
    expect(placed.side).toBe("below");
    expect(placed.top).toBe(152);
    expect(placed.left).toBe(500 + 60 - 180);
    expect(overlaps(cardAt(placed), target)).toBe(false);
  });

  it("goes above when there is no room below, then right, then left", () => {
    expect(placeCoach({ target: box(650, 500, 120, 40), card: CARD, viewport: VIEWPORT }).side).toBe("above");
    expect(placeCoach({ target: box(20, 300, 120, 760), card: CARD, viewport: VIEWPORT }).side).toBe("right");
    expect(placeCoach({ target: box(20, 900, 120, 760), card: CARD, viewport: VIEWPORT }).side).toBe("left");
  });

  it("never covers the target and always stays inside the viewport", () => {
    for (let top = 0; top < 800; top += 37) {
      for (let left = 0; left < 1280; left += 53) {
        const target = box(top, left, 90, 30);
        const placed = cardAt(placeCoach({ target, card: CARD, viewport: VIEWPORT }));
        expect([top, left, overlaps(placed, target)]).toEqual([top, left, false]);
        expect([top, left, inside(placed)]).toEqual([top, left, true]);
      }
    }
  });

  it("keeps clear of the fixed chrome when a side allows it", () => {
    const dock = box(0, 0, 1280, 120); // the sticky action dock
    const target = box(60, 600, 100, 40); // a button inside it
    const placed = placeCoach({ target, card: CARD, viewport: VIEWPORT, avoid: [dock] });
    expect(overlaps(cardAt(placed), dock)).toBe(false);
    expect(placed.side).toBe("below");
  });

  it("with no target, floats bottom-right above the bottom dock and below the top one", () => {
    const top = box(0, 0, 1280, 100);
    const status = box(740, 0, 1280, 60);
    const placed = placeCoach({ target: null, card: CARD, viewport: VIEWPORT, avoid: [top, status] });
    expect(placed.side).toBe("floating");
    expect(placed.left).toBe(1280 - 360 - 12);
    expect(placed.top).toBe(740 - 12 - 200);
    expect(overlaps(cardAt(placed), status)).toBe(false);
  });

  it("falls back to floating when no side fits without covering the target", () => {
    const huge = box(0, 0, 1280, 800);
    const placed = placeCoach({ target: huge, card: CARD, viewport: VIEWPORT });
    expect(placed.side).toBe("floating");
  });

  it("a whole-panel target with no room around it gets the corner that covers the least of it", () => {
    const panel = box(60, 200, 880, 700); // nothing fits above, below, left or right of it
    const placed = placeCoach({ target: panel, card: CARD, viewport: VIEWPORT });
    expect(placed.side).toBe("floating");
    const covered = (b: Box) =>
      Math.max(0, Math.min(b.left + b.width, panel.left + panel.width) - Math.max(b.left, panel.left)) *
      Math.max(0, Math.min(b.top + b.height, panel.top + panel.height) - Math.max(b.top, panel.top));
    const centred = box(VIEWPORT.height - 200 - 12, 460, 360, 200); // the old fallback, centred on the panel
    expect(covered(cardAt(placed))).toBeLessThan(covered(centred));
    // The panel's middle -- where its controls are -- stays clear.
    expect(overlaps(cardAt(placed), box(300, 500, 280, 200))).toBe(false);
  });

  it("is the same answer at any UI scale: geometry in, geometry out", () => {
    /* The shell's zoom changes the target's viewport box, never the coach's own (the coach renders outside the zoomed
       shell). Scaling the target's box scales the anchor point and nothing else. */
    const at1 = placeCoach({ target: box(100, 400, 100, 40), card: CARD, viewport: VIEWPORT });
    const at125 = placeCoach({ target: box(125, 500, 125, 50), card: CARD, viewport: VIEWPORT });
    expect(at1.side).toBe("below");
    expect(at125.side).toBe("below");
    expect(at125.top).toBe(125 + 50 + 12);
  });

  it("narrows the card on a small screen", () => {
    expect(coachWidth(1280)).toBe(360);
    expect(coachWidth(320)).toBe(296);
    expect(coachWidth(150)).toBe(126); // never wider than the viewport allows
    expect(coachWidth(1280, 12, 1.25)).toBe(450); // follows the player's UI scale
    expect(coachWidth(1280, 12, 0.63)).toBe(227);
  });
});
