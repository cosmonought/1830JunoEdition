// frontend/src/components/stationTokenArt.test.ts
//
// ==================================================================
//  DESIGN NOTE 487 (harness): ONE PIECE, SEEN AT DIFFERENT SIZES
// ==================================================================
//
// The reported bug: subsequent station tokens wear a strange ring border
// that makes them look non-uniform beside home tokens.
//
// WHAT MAKES THIS HARD TO TEST is that both tokens go through the SAME
// draw call with the same colours. Nothing about the code path differs --
// only the RADIUS does, and the ring width was not a function of it. So the
// property under test is a RELATIONSHIP between two numbers, and asserting
// either one alone would pass against the bug:
//
//   `ctx.lineWidth = Math.max(2, size * 0.05)` is a perfectly reasonable
//   line on its own. It is wrong only next to `tileCityTokenRadius`, which
//   is roughly two thirds of the radius the same constant was tuned for.
//
// So the tests below compute the ring/radius RATIO at each radius the board
// actually draws tokens at and assert the ratios match. That is the thing
// the eye is judging when it calls two circles "non-uniform", and it is
// what fails against the old code at every docked radius on the board.
//
// THE DRAW CALL IS NOT INVOKED. It needs a real `CanvasRenderingContext2D`,
// which jsdom does not provide, and stubbing one would test the stub. The
// width rule is a single expression over exported constants, so it is
// reproduced here from those constants -- if either constant moves, this
// moves with it, and if the RULE changes the test has to be rewritten,
// which is the correct amount of friction for a rule that has now been
// wrong once.

import {
  STATION_TOKEN_RING,
  STATION_TOKEN_RING_WIDTH_RATIO,
} from "./hexContractTypes";
import {
  SLOT_RING_RATIO,
  STATION_RADIUS_RATIO,
  tileCityTokenRadius,
} from "./TileGraphics";

/* Design note #699 retired `TOKEN_DOCK_INSET`, which this file used to reach for whenever it wanted "the
   radius of a token that is smaller than a preprinted one". That is now a real catalog figure rather than an
   arithmetic one: tile #62 is the only tile whose cities are BOTH shared, and it therefore draws the smallest
   token the board has. Asking the catalog keeps this harness measuring the board rather than a formula. */
const SHARED_CITY_RADIUS = tileCityTokenRadius(62, 40) as number;

/** `drawStationTokenMarker`'s non-muted stroke width, as the source states
 *  it. Kept in one place here so every case below measures the same rule. */
function ringWidth(radius: number): number {
  return Math.max(1, radius * STATION_TOKEN_RING_WIDTH_RATIO);
}

const HEX_SIZE = 40;
/** The preprinted / fallback radius -- what a home token on an untiled city
 *  is drawn at. `drawStationTokenMarker`'s `size * 0.22`. */
const PREPRINTED_RADIUS = HEX_SIZE * STATION_RADIUS_RATIO;

describe("the ring is proportional to the token", () => {
  it("is the same fraction of the radius at every radius", () => {
    // THE PROPERTY. Two circles look like the same piece when their collars
    // are the same share of them, which is what "uniform" means to an eye.
    const radii = [PREPRINTED_RADIUS, PREPRINTED_RADIUS * 0.86, PREPRINTED_RADIUS * 0.6, 12, 20];
    const ratios = radii.map((radius) => ringWidth(radius) / radius);
    for (const ratio of ratios) {
      expect(ratio).toBeCloseTo(STATION_TOKEN_RING_WIDTH_RATIO, 6);
    }
  });

  it("reproduces the old width exactly at the preprinted radius", () => {
    /* The compatibility check. Design note #487 changed the RULE, not the
       appearance of the tokens the rule was originally tuned for -- a
       preprinted home token must be pixel-identical, or the fix would have
       moved every token on the board to correct some of them. */
    expect(ringWidth(PREPRINTED_RADIUS)).toBeCloseTo(HEX_SIZE * 0.05, 6);
  });

  it("draws a THINNER ring on a docked token, not the same one", () => {
    // The bug, stated as a number. A docked token is smaller, so its collar
    // must be smaller; under the old absolute width it was not.
    const docked = SHARED_CITY_RADIUS;
    expect(docked).toBeLessThan(PREPRINTED_RADIUS);
    expect(ringWidth(docked)).toBeLessThan(ringWidth(PREPRINTED_RADIUS));
  });

  it("would have looked heavier under the old rule -- measurably", () => {
    /* What the player was seeing, quantified, so the test says why it
       mattered rather than only that it changed. The old width on a docked
       token was a visibly larger share of that token than the same width on
       a preprinted one. */
    const docked = SHARED_CITY_RADIUS;
    const oldWidth = Math.max(2, HEX_SIZE * 0.05);
    const oldRatioOnDocked = oldWidth / docked;
    const oldRatioOnPreprinted = oldWidth / PREPRINTED_RADIUS;
    expect(oldRatioOnDocked / oldRatioOnPreprinted).toBeGreaterThan(1.35);
    // And the new rule collapses that difference to nothing.
    expect(ringWidth(docked) / docked).toBeCloseTo(ringWidth(PREPRINTED_RADIUS) / PREPRINTED_RADIUS, 6);
  });
});

describe("real docking radii from the tile catalog", () => {
  /* Not a synthetic radius: these are the numbers `HexGridRenderer` passes as `radiusOverride` for tiles
     actually on the board. A rule that is proportional in the abstract and wrong for the catalog's own
     figures would pass every test above.
     Design note #699 split this list, because the old one asserted every docked token was SMALLER than a
     preprinted one -- which was true, and was the bug. */

  /** Cities that hold ONE token. Nothing about them is shared, so nothing about them should shrink. */
  const UNSHARED: readonly [number, number][] = [
    [57, 0], // yellow single city
    [54, 0], // New York's green -- TWO one-slot cities, the reported case
    [54, 1],
    [64, 0], // brown OO, one slot each
    [64, 1],
  ];

  /** Cities that hold two. These are the only tokens with a reason to be smaller. */
  const SHARED: readonly [number, number][] = [
    [63, 0], // one 2-slot city, alone on its tile
    [62, 0], // two 2-slot cities -- the one tile whose pills genuinely crowd
    [62, 1],
  ];

  const ALL = [...UNSHARED, ...SHARED];

  it("draws an unshared city's token at the full preprinted radius", () => {
    /* THE REPORT, as a number. "NNH shrinks on the green upgrade to G19 even though that is still a
       single-station city" -- tile 54, city 0 or 1, which used to come back at 0.614 of this. */
    for (const [tileId, cityIndex] of UNSHARED) {
      expect(tileCityTokenRadius(tileId, HEX_SIZE, cityIndex)).toBeCloseTo(PREPRINTED_RADIUS, 6);
    }
  });

  it("shrinks a shared city's token exactly to the ring the pill draws it", () => {
    /* `drawStationPill` strokes an inner ring per slot at `radius * SLOT_RING_RATIO`; the token fills it and
       nothing further is subtracted. #62 takes the extra 0.85 on top because its two PILLS crowd -- the one
       case the marker-count shrink was ever really about. */
    expect(tileCityTokenRadius(63, HEX_SIZE, 0)).toBeCloseTo(PREPRINTED_RADIUS * SLOT_RING_RATIO, 6);
    for (const cityIndex of [0, 1]) {
      expect(tileCityTokenRadius(62, HEX_SIZE, cityIndex)).toBeCloseTo(
        PREPRINTED_RADIUS * 0.85 * SLOT_RING_RATIO,
        6,
      );
    }
  });

  it("never draws a shared city's token larger than an unshared one", () => {
    /* The old rule ran BACKWARDS here: #63 is a genuine 2-slot city carrying one marker, so it escaped the
       marker-count shrink and drew LARGER than #54's unshared city. This is the assertion that would have
       caught it. */
    const largestShared = Math.max(
      ...SHARED.map(([id, city]) => tileCityTokenRadius(id, HEX_SIZE, city) as number),
    );
    const smallestUnshared = Math.min(
      ...UNSHARED.map(([id, city]) => tileCityTokenRadius(id, HEX_SIZE, city) as number),
    );
    expect(largestShared).toBeLessThanOrEqual(smallestUnshared);
  });

  it("wears the same proportional collar as a preprinted token", () => {
    const reference = ringWidth(PREPRINTED_RADIUS) / PREPRINTED_RADIUS;
    for (const [tileId, cityIndex] of ALL) {
      const radius = tileCityTokenRadius(tileId, HEX_SIZE, cityIndex) as number;
      expect(ringWidth(radius) / radius).toBeCloseTo(reference, 6);
    }
  });

  it("keeps a visible ring even on the smallest token the board draws", () => {
    // The floor exists so a proportional ring cannot vanish. It must not be
    // reached at any radius the real board uses, or it becomes the absolute
    // width this note is about.
    const smallest = Math.min(
      ...ALL.map(([id, city]) => tileCityTokenRadius(id, HEX_SIZE, city) as number),
    );
    expect(ringWidth(smallest)).toBeGreaterThan(1);
  });

  it("returns undefined for a tile with no city at that index", () => {
    expect(tileCityTokenRadius(55, HEX_SIZE, 0)).toBeUndefined(); // two towns, no city
    expect(tileCityTokenRadius(57, HEX_SIZE, 1)).toBeUndefined(); // only one city
  });
});

describe("the ring colour is unchanged", () => {
  it("is still charcoal", () => {
    /* Design note #234 chose this against the white city circle underneath. #487 was about WIDTH only; a
       colour change there would have been a different decision smuggled in with a geometry fix.
       #699 raises the stakes rather than lowering them: with the collar gone, this stroke IS the token's
       edge -- the only line between a brand-coloured disc and the tile under it. */
    expect(STATION_TOKEN_RING).toBe("#334155");
  });
});
