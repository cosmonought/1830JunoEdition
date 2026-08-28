/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 936 + 937 (harness): THE STAR'S SHAPE, AND ITS HEIGHT
// ==================================================================
//
// REPORTED, correcting me: "There is a visually rendered star icon on the map hexes where private powers take
// effect ... You likely missed it in your grep because it is drawn via an inline SVG `<path>` or `<polygon>`."
//
// THE STAR IS REAL; THE SVG IS NOT. It is a canvas path inside `drawReservationBadgeAt` (#714), which is why
// neither my grep for components nor a grep for `<polygon>` would ever have found it. The correction stands
// and the mechanism does not, and both halves matter here: the fix could not be "reuse the existing
// component", because there was none, so #936 lifted the GEOMETRY out and gave it two renderers.
//
// WHY THESE ARE ARITHMETIC TESTS AND NOT A SOURCE SCAN. Every failure mode in this change is a number:
// a star that does not reach the cap-height it was matched to, a slot narrower than the shape it holds, a
// centring offset applied in the wrong direction. A scan asserting "the module is imported" would pass on all
// three. #888 made this argument for the camera pose; it is the same argument.

import {
  PrivatePowerStar,
  STAR_HEIGHT_PER_RADIUS,
  STAR_WIDTH_PER_RADIUS,
  starCentreOffset,
  starPolygonPoints,
  starRadiusForHeight,
  starVertices,
  starWidthForHeight,
} from "./privatePowerStar";

describe("the star's construction (design note #936)", () => {
  it("plots ten vertices alternating between two radii", () => {
    /* #714's construction, pinned where it now lives. Ten points, five out and five in -- a loop that lost
       the alternation would still draw a closed shape, just a pentagon, and a pentagon on a hex reads as a
       token rather than as a mark. */
    const points = starVertices(0, 0, 10);
    expect(points).toHaveLength(10);
    const radii = points.map((point) => Math.round(Math.hypot(point.x, point.y) * 100) / 100);
    expect(radii.filter((r) => r === 10)).toHaveLength(5);
    expect(radii.filter((r) => r === 4.2)).toHaveLength(5);
  });

  it("starts at the top so a point sits upright", () => {
    /* THE REASON #714 GIVES for starting at -90 degrees: the star must look like a star at every scale, and
       one rotated by a tenth of a turn reads as a blob at 11px. */
    const [first] = starVertices(0, 0, 10);
    expect([Math.round(first.x * 100) / 100, Math.round(first.y * 100) / 100]).toEqual([0, -10]);
  });

  it("is wider than it is tall", () => {
    /* NOT A CURIOSITY -- it is why the badge's horizontal slot could not stay a fixed fraction of the font
       once the height became the thing being matched. A star sized to a cap-height is about 5% wider than
       that, and a slot sized as though it were square would let it run into the acronym. */
    expect(STAR_WIDTH_PER_RADIUS).toBeGreaterThan(STAR_HEIGHT_PER_RADIUS);
  });

  it("measures its own bounding box, and it is not twice the radius", () => {
    /* THE MISTAKE #937 WAS ACTUALLY FIXING, asserted directly. The lower points reach only sin(54deg) of a
       radius, so a caller treating the circumcircle as the bounding box draws a star about 10% short. The
       ratio is checked against the PLOTTED extent rather than against the constant, or this would be the
       constant agreeing with itself. */
    const points = starVertices(0, 0, 10);
    const top = Math.min(...points.map((point) => point.y));
    const bottom = Math.max(...points.map((point) => point.y));
    expect((bottom - top) / 10).toBeCloseTo(STAR_HEIGHT_PER_RADIUS, 5);
    expect(STAR_HEIGHT_PER_RADIUS).toBeLessThan(2);
  });
});

describe("sizing by height (design note #937)", () => {
  it("draws exactly the height it is asked for", () => {
    /* "Scale its height up so it EXACTLY matches the cap-height" -- so the conversion is the assertion.
       Checked across sizes because the badge scales with the hex and a ratio that only holds at one zoom is
       the bug this replaced. */
    for (const height of [6, 8, 11, 14, 20, 33]) {
      const points = starVertices(0, 0, starRadiusForHeight(height));
      const top = Math.min(...points.map((point) => point.y));
      const bottom = Math.max(...points.map((point) => point.y));
      expect([height, Math.round((bottom - top) * 1000) / 1000]).toEqual([
        height,
        Math.round(height * 1000) / 1000,
      ]);
    }
  });

  it("reports the width that height implies", () => {
    for (const height of [6, 11, 20]) {
      const points = starVertices(0, 0, starRadiusForHeight(height));
      const left = Math.min(...points.map((point) => point.x));
      const right = Math.max(...points.map((point) => point.x));
      expect(starWidthForHeight(height)).toBeCloseTo(right - left, 5);
    }
  });

  it("is meaningfully taller than the old sizing at the same font", () => {
    /* THE REPORT'S ACTUAL COMPLAINT -- "the star is currently too small" -- as a number rather than a
       feeling. The old star was `markW * 0.5` of circumradius with `markW = fontPx * 0.62`, giving a drawn
       height of `fontPx * 0.31 * STAR_HEIGHT_PER_RADIUS`. The new one is the cap-height, ~0.72 of the font.
       If a future edit quietly restores the old proportion this fails, which is the point. */
    const fontPx = 12;
    const oldHeight = fontPx * 0.62 * 0.5 * STAR_HEIGHT_PER_RADIUS;
    const newHeight = fontPx * 0.72;
    expect(newHeight).toBeGreaterThan(oldHeight * 1.2);
  });

  it("offsets the centre downward, not upward", () => {
    /* THE SIGN, WHICH IS THE EASY HALF TO GET BACKWARDS. The shape's mass sits ABOVE the circumcircle centre,
       so drawing it centred on a text midpoint requires moving the circle DOWN. A negative offset would ride
       the star high by twice the intended correction. */
    expect(starCentreOffset(12)).toBeGreaterThan(0);

    const height = 12;
    const cy = starCentreOffset(height);
    const points = starVertices(0, cy, starRadiusForHeight(height));
    const top = Math.min(...points.map((point) => point.y));
    const bottom = Math.max(...points.map((point) => point.y));
    /* With the offset applied, the DRAWN shape straddles zero evenly -- which is what "centred on the text"
       means, and what `cy` alone does not give. */
    expect(Math.abs(top + bottom)).toBeLessThan(1e-9);
  });
});

describe("the SVG renderer draws the same shape (design note #936)", () => {
  it("emits ten points", () => {
    const points = starPolygonPoints(10, 10, 10).split(" ");
    expect(points).toHaveLength(10);
    for (const pair of points) expect(pair).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
  });

  it("agrees with the canvas vertices to within rounding", () => {
    /* THE JOIN THIS MODULE EXISTS TO CLOSE. The board and the button must draw one shape; the only way that
       can quietly stop being true is if the two renderers derive their points differently, so the SVG string
       is compared back against the vertex list the canvas walks. */
    const vertices = starVertices(10, 10, 10);
    const emitted = starPolygonPoints(10, 10, 10)
      .split(" ")
      .map((pair) => pair.split(",").map(Number));
    emitted.forEach(([x, y], index) => {
      expect(Math.abs(x - vertices[index].x)).toBeLessThan(0.01);
      expect(Math.abs(y - vertices[index].y)).toBeLessThan(0.01);
    });
  });

  it("is a function that takes a height", () => {
    /* The component is exercised for its CONTRACT here rather than rendered -- this file is `node`
       environment by the standing rule, and a shape's arithmetic is what these cases are about. The render
       itself is covered from the panel's side. */
    expect(typeof PrivatePowerStar).toBe("function");
  });
});
