// frontend/src/components/tokenTextFit.test.ts
//
// ==================================================================
//  DESIGN NOTE 564 (harness): MEASURE THE CIRCLE, NOT THE BOX
// ==================================================================
//
// REPORTED: every acronym except ERIE's runs into the token's ring.
//
// The previous fix (design note #513) narrowed the allowance for tickers
// longer than three characters and left the majority on a flat
// `radius * 1.7`. That is 85% of the DIAMETER, and a glyph sitting in a
// circle never gets the diameter -- it gets the chord at the top of its own
// letterforms. The three-letter case was over by a hair, on every token, and
// looked like a rendering artefact rather than an arithmetic error.
//
// These tests are geometry, not rendering: `tokenTextChordWidth` is pure
// arithmetic over a radius, a ring width and a font size, so the property
// that matters -- the text box fits inside the circle -- can be checked
// exactly rather than by looking at a canvas.

import { tokenTextChordWidth } from "./hexCanvasPrimitives";

/** The token's ordinary radius at the default hex size (42 * 0.22). */
const R = 42 * 0.22;
/** The muted reservation badge's fixed ring. */
const RING = 1.75;

/** Does a text box of this width and font size sit entirely inside the
 *  circle, clear of the ring? The check the drawing code cannot make for
 *  itself, written out independently so it is not the same arithmetic
 *  twice. */
function fitsInsideDisc(
  width: number,
  fontPx: number,
  radius: number,
  ringWidth: number,
): boolean {
  const halfW = width / 2;
  const halfH = fontPx * 0.72 * 0.5;
  const inner = radius - ringWidth / 2;
  // The corner of the text box is the furthest point from the centre.
  return Math.hypot(halfW, halfH) <= inner;
}

describe("tokenTextChordWidth", () => {
  it("keeps a three-letter ticker inside the ring", () => {
    /* THE REPORTED BUG. The old allowance was `radius * 1.7`; this asserts
       the new one is actually containable, which the old one was not. */
    const width = tokenTextChordWidth(R, RING, 9);
    expect(fitsInsideDisc(width, 9, R, RING)).toBe(true);
  });

  it("is narrower than the old flat ratio it replaces", () => {
    // Not a style preference -- the old figure did not fit.
    expect(tokenTextChordWidth(R, RING, 9)).toBeLessThan(R * 1.7);
    expect(fitsInsideDisc(R * 1.7, 9, R, RING)).toBe(false);
  });

  it("narrows as the font grows, because the chord does", () => {
    /* The whole reason the fitter has to iterate: the budget is not a
       constant the caller can be handed once. */
    const small = tokenTextChordWidth(R, RING, 7);
    const large = tokenTextChordWidth(R, RING, 11);
    expect(large).toBeLessThan(small);
  });

  it("charges for the ring", () => {
    // Stroked ON the circle, so half of it is interior -- which is why the
    // symptom reads as "blending with the border" as often as "clipped".
    expect(tokenTextChordWidth(R, 4, 9)).toBeLessThan(tokenTextChordWidth(R, 0, 9));
  });

  it("widens with the token, at every zoom", () => {
    expect(tokenTextChordWidth(R * 2, RING, 9)).toBeGreaterThan(
      tokenTextChordWidth(R, RING, 9),
    );
  });

  it("returns zero rather than a negative width when nothing fits", () => {
    /* A negative maxWidth would make every measurement fail and the fitter
       would silently return its floor -- the exact mechanism that made this
       bug invisible. Zero fails honestly. */
    expect(tokenTextChordWidth(2, RING, 24)).toBe(0);
    expect(tokenTextChordWidth(2, RING, 24)).not.toBeLessThan(0);
  });

  it("holds for every 1830 ticker length at the default radius", () => {
    /* Design note #513 wanted "scaled, not special-cased" and implemented a
       length threshold instead. This is the property that threshold was
       standing in for: whatever the string, the size the fitter settles on
       must fit -- so a future corporation with a five-letter acronym needs
       no new branch. */
    for (const fontPx of [11, 10, 9, 8, 7, 6]) {
      const width = tokenTextChordWidth(R, RING, fontPx);
      expect(fitsInsideDisc(width, fontPx, R, RING)).toBe(true);
    }
  });
});
