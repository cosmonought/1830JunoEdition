// frontend/src/components/trackInkAndVeil.test.ts
//
// ==================================================================
//  DESIGN NOTES 472 / 473 (harness)
// ==================================================================
//
// Two visual constants whose CORRECTNESS is a relationship rather than a
// value. Neither can be checked by looking at the number.
//
//   THE TRACK INK has to equal the tile track ink, because a red off-board
//   hex butts directly against laid tiles and the seam falls on the edge a
//   player traces a route across. Asserting the literal `#1a1a1a` would
//   pass while the tile table moved out from under it -- which is exactly
//   how the two came apart in the first place (design note #161 deepened
//   tiles and deliberately left the non-tile default alone).
//
//   THE VEIL ALPHAS have to stay ordered and stay short of opaque. The
//   focus veil says "not this hex, right now" and the base veil says "not
//   your reach"; if the first were ever the lighter of the two, opening a
//   ring would make the board brighter, and at 1.0 either would hide the
//   neighbours a tile is being judged against.

import {
  DEFAULT_TRACK_INK,
  LAY_TRACK_DIM_ALPHA,
  LAY_TRACK_FOCUS_DIM_ALPHA,
  STANDARD_TRACK_INK,
  TILE_TRACK_INK,
} from "./hexBoardData";

describe("track ink", () => {
  it("is the same value every tile tier draws with", () => {
    // The relationship, not the literal.
    for (const tier of ["Yellow", "Green", "Brown"] as const) {
      expect(TILE_TRACK_INK[tier]).toBe(STANDARD_TRACK_INK);
    }
  });

  it("is a single colour across all three tiers", () => {
    // Design note #161 unified them; a future split would need to decide
    // what the off-board stubs match, so it should have to notice this.
    expect(new Set(Object.values(TILE_TRACK_INK)).size).toBe(1);
  });

  it("is NOT the legacy non-tile default", () => {
    // `DEFAULT_TRACK_INK` is still correct for gray hexes and landmark
    // stubs on pale printed stock -- but the off-board stubs moved off it,
    // and this asserts the two are genuinely different constants rather
    // than one having quietly been redefined as the other.
    expect(STANDARD_TRACK_INK).not.toBe(DEFAULT_TRACK_INK);
  });

  it("is a well-formed hex colour", () => {
    expect(STANDARD_TRACK_INK).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("veil alphas", () => {
  it("veils harder when a tile selector is open", () => {
    // The whole point of the second constant. If this inverted, opening a
    // ring would LIGHTEN the board.
    expect(LAY_TRACK_FOCUS_DIM_ALPHA).toBeGreaterThan(LAY_TRACK_DIM_ALPHA);
  });

  it("keeps both veils short of opaque", () => {
    // A tile is judged against its neighbours; hiding them entirely would
    // defeat the reason the player opened this hex rather than another.
    for (const alpha of [LAY_TRACK_DIM_ALPHA, LAY_TRACK_FOCUS_DIM_ALPHA]) {
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(1);
    }
  });

  it("keeps the base veil light enough to read a hex through", () => {
    // Design note #420's test: a veiled hex must still read as cardboard.
    // Pinned as a ceiling so a future "make it clearer" pass has to argue
    // with the note rather than nudge past it silently.
    expect(LAY_TRACK_DIM_ALPHA).toBeLessThanOrEqual(0.6);
  });

  it("raised the base veil by roughly the requested 30%", () => {
    // From design note #420's 0.42. Asserted as a band rather than a value
    // so the intent survives a small future retune.
    const previous = 0.42;
    const ratio = LAY_TRACK_DIM_ALPHA / previous;
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(1.45);
  });
});
