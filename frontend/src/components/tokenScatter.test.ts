// frontend/src/components/tokenScatter.test.ts
//
// ==================================================================
//  DESIGN NOTE 689 (harness): SHRINKING IN PLACE UNCOVERS NOTHING
// ==================================================================
//
// REPORTED: "the scatter effect on the stock market matrix when there's only
// one token simply shrinks the token in place, but the token (even shrunk)
// still covers the cell's value."
//
// Design note #452 predicted the opposite in writing -- "a lone occupant has a
// zero offset and does not move -- correct, since it only needs the
// scale-down" -- and that sentence is the bug. The arithmetic it skipped:
//
//   #24(2) renders a LONE token at full size, up to 46px.
//   0.72 of 46 is 33.
//   #649 puts every price in the top-left corner.
//   A 33px disc centred in a ~46px cell still covers that corner.
//
// A shrink moves a token's edges toward its own centre, and the centre is
// exactly where the problem is. Nothing about scaling could have fixed this,
// which is why the effect looked like it was doing something and wasn't.
//
// SO THE TESTS ARE GEOMETRIC, not "does it have a transform". The question is
// whether the price corner ends up clear -- stated as a rectangle overlap,
// because that is the claim the report is actually making.

import { deriveTokenScatterOffset } from "./StockMarketRenderer";

/** A representative cell and a lone token at #24(2)'s full size. */
const CELL = 46;
const LONE_DIAMETER = 46;

/** #649: every price sits top-left. A generous box for it -- 9-18px of
 *  monospace plus `priceText`'s 2px/3px padding, rounded up, so a test that
 *  passes here passes for the real text. */
const PRICE_BOX = { left: 0, top: 0, right: 22, bottom: 16 };

/** Where a token's disc lands, given the hover vector. The resting centre is
 *  the cell's centre (`top: calc(50% + offset - d/2)`), and `scale` shrinks
 *  about that translated centre. */
function scatteredBox(
  scatter: { x: number; y: number; scale: number },
  diameter: number,
  cell: number,
) {
  const size = diameter * scatter.scale;
  const cx = cell / 2 + scatter.x;
  const cy = cell / 2 + scatter.y;
  return { left: cx - size / 2, top: cy - size / 2, right: cx + size / 2, bottom: cy + size / 2 };
}

const overlaps = (
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe("a lone token", () => {
  const scatter = deriveTokenScatterOffset({ x: 0, y: 0 }, 1, CELL);

  it("MOVES, rather than only shrinking", () => {
    // The whole report in one assertion.
    expect(scatter.x).toBeGreaterThan(0);
    expect(scatter.y).toBeGreaterThan(0);
  });

  it("clears the price corner", () => {
    /* THE PROPERTY THE REPORT IS ABOUT. Not "is there an effect" but "can the
       player read the number underneath". */
    expect(overlaps(scatteredBox(scatter, LONE_DIAMETER, CELL), PRICE_BOX)).toBe(false);
  });

  it("would NOT have cleared it by shrinking alone", () => {
    /* The old behaviour, pinned as the counter-example so nobody re-derives
       #452's conclusion from scratch. 0.72 in place still lands on the price. */
    const shrinkOnly = { x: 0, y: 0, scale: 0.72 };
    expect(overlaps(scatteredBox(shrinkOnly, LONE_DIAMETER, CELL), PRICE_BOX)).toBe(true);
  });

  it("would NOT have cleared it by moving alone", () => {
    /* And the other half. #452 found "either effect alone is insufficient" for
       a cluster of four; it is true of one token as well, which is the part it
       did not test. */
    const moveOnly = { x: scatter.x, y: scatter.y, scale: 1 };
    expect(overlaps(scatteredBox(moveOnly, LONE_DIAMETER, CELL), PRICE_BOX)).toBe(true);
  });

  it("shrinks further than a cluster member does", () => {
    // A cluster is already several small discs; a lone token is one big one and
    // has further to go.
    const clustered = deriveTokenScatterOffset({ x: 10, y: -10 }, 3, CELL);
    expect(scatter.scale).toBeLessThan(clustered.scale);
  });

  it("stays mostly inside its own cell", () => {
    /* A token that slid fully into the neighbouring cell would read as
       belonging to THAT price, which is a worse misreading than the one being
       fixed. */
    const box = scatteredBox(scatter, LONE_DIAMETER, CELL);
    expect(box.right).toBeLessThanOrEqual(CELL + 6);
    expect(box.bottom).toBeLessThanOrEqual(CELL + 6);
  });

  it("does not run off a small cell", () => {
    // The travel is clamped, so a cell at the minimum size does not fling its
    // token a full cell away.
    const small = deriveTokenScatterOffset({ x: 0, y: 0 }, 1, 20);
    expect(small.x).toBeLessThanOrEqual(20 * 0.28 + 0.01);
  });
});

describe("a cluster", () => {
  it("still travels along its own spoke", () => {
    /* #452's behaviour, unchanged. Each token moves outward from the middle
       rather than across its neighbours, which is what the resting offset
       already encodes. */
    const resting = { x: 12, y: -8 };
    const scatter = deriveTokenScatterOffset(resting, 4, CELL);
    expect(scatter.x / resting.x).toBeCloseTo(scatter.y / resting.y);
    expect(Math.abs(scatter.x)).toBeLessThan(Math.abs(resting.x));
  });

  it("keeps #452's scale", () => {
    expect(deriveTokenScatterOffset({ x: 12, y: -8 }, 4, CELL).scale).toBe(0.72);
  });

  it("moves a token that rests left, further left", () => {
    // Direction is preserved, not just magnitude -- a sign flip would send
    // tokens across each other.
    const scatter = deriveTokenScatterOffset({ x: -12, y: 8 }, 3, CELL);
    expect(scatter.x).toBeLessThan(0);
    expect(scatter.y).toBeGreaterThan(0);
  });
});
