// frontend/src/components/radialRingGeometry.test.ts
//
// ==================================================================
//  DESIGN NOTE 506 (harness): A GUARANTEE, NOT A SCREENSHOT
// ==================================================================
//
// REPORTED: the candidate tiles in the radial menu are too small and overlap
// the central hex.
//
// One cause, and the file's own header had already flagged it as a known
// limitation: "STILL NOT FOLLOWED: pan and zoom of the board itself." The
// ring was laid out in fixed CSS pixels against a hex drawn at
// `hexSize * zoom`, so every constant was calibrated for one zoom level and
// wrong by exactly the zoom factor at every other. At 2x the hex's radius
// (84px) exceeded the whole ring radius (76px) and the candidates landed
// inside the thing they were replacing.
//
// WHY THIS IS TESTED AND NOT EYEBALLED. "No overlap" is a claim about every
// combination of zoom and candidate count, and the failure appears only at
// the combinations nobody happens to open during review -- the bug survived
// because the default zoom is the one case that worked. A test sweeps the
// space; a screenshot samples one point of it.
//
// THE ASSERTIONS ARE INEQUALITIES over the real geometry rather than
// expected pixel values. Pinning "radius === 86" would pass against a
// formula that is right at one zoom and wrong at the next, which is the
// exact bug being fixed.

import {
  CANDIDATE_HEX_FRACTION,
  candidateThumbSize,
  ringPosition,
  ringRadiusFor,
} from "./RadialTileSelector";

/** `DEFAULT_HEX_SIZE` in `HexGridRenderer` -- the board's centre-to-corner
 *  radius before zoom. Restated rather than imported: importing the renderer
 *  drags a canvas component into a pure geometry test, and the number's role
 *  here is as a realistic input, not as the value under test. */
const BOARD_HEX_SIZE = 42;

/** The zoom range a player can actually reach: `minZoom` can sit well below
 *  1 on a small viewport, and Detailed View allows roughly 3x above it. */
const ZOOMS = [0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3];
/** One candidate through a crowded hex. */
const COUNTS = [1, 2, 3, 4, 5, 6, 8, 10, 12];

describe("candidateThumbSize", () => {
  it("is at least 60% of the central hex's height at every zoom", () => {
    // The requirement, as a property. A pointy-top hex is `2R` tall.
    for (const zoom of ZOOMS) {
      const hexRadius = BOARD_HEX_SIZE * zoom;
      const thumb = candidateThumbSize(hexRadius);
      expect(thumb).toBeGreaterThanOrEqual(2 * hexRadius * CANDIDATE_HEX_FRACTION - 1);
    }
  });

  it("grows with the hex rather than staying a fixed pixel size", () => {
    /* THE BUG, stated directly: a constant passes "at least 60%" at one zoom
       and fails it at the next. Doubling the hex must move this number. */
    const small = candidateThumbSize(BOARD_HEX_SIZE);
    const large = candidateThumbSize(BOARD_HEX_SIZE * 2);
    expect(large).toBeGreaterThan(small);
  });

  it("keeps a floor when the board is zoomed out", () => {
    // Below the floor the ratio rule would produce something smaller than
    // design note #471 already rejected as unreadable.
    expect(candidateThumbSize(10)).toBeGreaterThanOrEqual(60);
  });

  it("falls back to the floor when the radius is unknown", () => {
    // A caller that has not been given a radius must get the old constant,
    // not a collapsed ring.
    for (const bad of [null, undefined, 0, -5, Number.NaN]) {
      expect(candidateThumbSize(bad)).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("the ring clears the central hex", () => {
  it("never places a candidate overlapping the hex, at any zoom or count", () => {
    /* THE GUARANTEE. Conservative on both sides: the central hex's extent
       toward the candidate is at most its full radius, and the candidate's
       extent back toward the centre is at most half its own height. If the
       distance between the two centres exceeds the sum, they cannot touch
       whatever their relative orientation. */
    for (const zoom of ZOOMS) {
      const hexRadius = BOARD_HEX_SIZE * zoom;
      const thumb = candidateThumbSize(hexRadius);
      for (const count of COUNTS) {
        const radius = ringRadiusFor(count, hexRadius);
        expect(radius).toBeGreaterThan(hexRadius + thumb / 2);
      }
    }
  });

  it("leaves a visible gap, not merely a tangent", () => {
    // Touching exactly would read as an overlap at any anti-aliased edge.
    for (const zoom of ZOOMS) {
      const hexRadius = BOARD_HEX_SIZE * zoom;
      const thumb = candidateThumbSize(hexRadius);
      const radius = ringRadiusFor(6, hexRadius);
      expect(radius - (hexRadius + thumb / 2)).toBeGreaterThanOrEqual(10);
    }
  });

  it("would have FAILED at high zoom under the old fixed radius", () => {
    /* The regression this file exists for, stated as the thing that used to
       happen: the pre-#506 ring was a flat 76px. At 2x the hex alone is 84px
       in radius, so the old constant put candidate centres inside it. */
    const hexRadiusAt2x = BOARD_HEX_SIZE * 2;
    const OLD_FIXED_RADIUS = 76;
    expect(OLD_FIXED_RADIUS).toBeLessThan(hexRadiusAt2x);
    // And the replacement does not.
    expect(ringRadiusFor(6, hexRadiusAt2x)).toBeGreaterThan(hexRadiusAt2x);
  });

  it("still clears the hex when only one candidate is offered", () => {
    /* `count <= 2` skips the spacing term entirely, so this is the branch
       where the clearance rule is the ONLY thing holding the ring off the
       hex -- and the branch a one-option upgrade actually takes. */
    for (const zoom of ZOOMS) {
      const hexRadius = BOARD_HEX_SIZE * zoom;
      const thumb = candidateThumbSize(hexRadius);
      expect(ringRadiusFor(1, hexRadius)).toBeGreaterThan(hexRadius + thumb / 2);
      expect(ringRadiusFor(2, hexRadius)).toBeGreaterThan(hexRadius + thumb / 2);
    }
  });
});

describe("the candidates clear each other", () => {
  it("keeps neighbouring candidates from touching", () => {
    /* Design note #174's original guarantee, which the clearance rule must
       not have quietly replaced: `2R sin(pi/N)` is the centre-to-centre
       distance between adjacent items on the ring. */
    for (const zoom of ZOOMS) {
      const hexRadius = BOARD_HEX_SIZE * zoom;
      const thumb = candidateThumbSize(hexRadius);
      for (const count of COUNTS.filter((n) => n >= 3)) {
        const radius = ringRadiusFor(count, hexRadius);
        const separation = 2 * radius * Math.sin(Math.PI / count);
        expect(separation).toBeGreaterThanOrEqual(thumb);
      }
    }
  });

  it("opens the ring wider as the count grows", () => {
    const hexRadius = BOARD_HEX_SIZE;
    expect(ringRadiusFor(12, hexRadius)).toBeGreaterThan(ringRadiusFor(3, hexRadius));
  });
});

describe("ringPosition", () => {
  it("puts the first candidate at twelve o'clock", () => {
    const p = ringPosition(0, 6, BOARD_HEX_SIZE);
    expect(Math.abs(p.x)).toBeLessThan(1e-9);
    expect(p.y).toBeLessThan(0);
  });

  it("places every candidate exactly on the ring", () => {
    // The polar maths, checked against the radius it claims to use.
    const hexRadius = BOARD_HEX_SIZE * 1.5;
    const radius = ringRadiusFor(8, hexRadius);
    for (let i = 0; i < 8; i += 1) {
      const p = ringPosition(i, 8, hexRadius);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(radius, 6);
    }
  });

  it("honours the hex radius it is given", () => {
    // A position that ignored the argument would be the original bug.
    const near = Math.hypot(...Object.values(ringPosition(0, 6, BOARD_HEX_SIZE)));
    const far = Math.hypot(...Object.values(ringPosition(0, 6, BOARD_HEX_SIZE * 3)));
    expect(far).toBeGreaterThan(near);
  });
});
