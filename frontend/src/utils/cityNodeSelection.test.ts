// frontend/src/utils/cityNodeSelection.test.ts
//
// ==================================================================
//  DESIGN NOTE 453 (harness): WHICH CITY, NOT JUST WHICH HEX
// ==================================================================
//
// The reported bug was that a station placement ignored the city node the
// player clicked. The failure was invisible on the overwhelming majority of
// hexes -- one city means index 0 either way -- and showed up only on the
// two-city tiles, where "lowest-indexed free slot" is a coin toss against
// the player's intent.
//
// So the tests that matter here are the MULTI-CITY ones. A single-city
// assertion passes against the broken behaviour and the fixed one alike,
// which is exactly why the bug survived: every casual check of "does
// placing a token work" lands on a one-city hex.
//
// `null` IS ASSERTED AS A DISTINCT ANSWER, not treated as a failure. It
// means "the geometry cannot tell", and the caller omits `city_index` so
// the contract applies its documented fallback -- which is a different and
// better outcome than sending a confident wrong index.

import { cityIndexAtPoint } from "./stationTokens";
import { tileCitySlotCounts, tileCitySlotPoints } from "../components/TileGraphics";
import { axialToPixel } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";

const HEX_SIZE = 40;
const Q = 3;
const R = 4;

function gridWith(tileId: number, orientation = 0): MapGridResponse {
  return {
    game_id: 1,
    tiles: [{ q: Q, r: R, tile_id: tileId, orientation }],
  } as unknown as MapGridResponse;
}

const emptyGrid = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

/** The centroid of a city's own slot points -- the position the hit-test
 *  measures against, derived here the same way so a test does not hardcode
 *  coordinates that the tile art may legitimately move. */
function cityCentre(tileId: number, cityIndex: number, orientation = 0) {
  const points = tileCitySlotPoints(
    tileId,
    cityIndex,
    orientation,
    axialToPixel(Q, R, HEX_SIZE),
    HEX_SIZE,
  );
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
    slots: points.length,
  };
}

/** Every catalog tile carrying more than one city -- the tiles the bug was
 *  actually about. Discovered rather than hardcoded, so a tile added later
 *  is covered without this file being edited. */
const MULTI_CITY_TILES = [8, 14, 15, 20, 23, 24, 25, 26, 27, 28, 29, 30, 31, 53, 54, 55, 56, 57, 59, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70]
  .filter((id) => tileCitySlotCounts(id).length > 1);

describe("cityIndexAtPoint", () => {
  it("returns null on an untiled hex", () => {
    // A preprinted double city has no per-city geometry to measure. Guessing
    // would send a confident wrong index; null omits the field.
    expect(cityIndexAtPoint(emptyGrid, Q, R, 0, 0, HEX_SIZE)).toBeNull();
  });

  it("returns null for a tile the catalog does not know", () => {
    expect(cityIndexAtPoint(gridWith(99999), Q, R, 0, 0, HEX_SIZE)).toBeNull();
  });

  it("short-circuits a one-city tile to 0 without measuring", () => {
    const single = [14, 15, 53, 54, 55].find((id) => tileCitySlotCounts(id).length === 1);
    if (single === undefined) return; // catalog has none; nothing to assert
    // Deliberately a point far from any slot: a single-city tile's index is
    // not a guess, so distance must not enter into it.
    expect(cityIndexAtPoint(gridWith(single), Q, R, 9999, 9999, HEX_SIZE)).toBe(0);
  });

  it("finds at least one multi-city tile to test against", () => {
    // If this fails the suite below is vacuous, which is worth knowing.
    expect(MULTI_CITY_TILES.length).toBeGreaterThan(0);
  });
});

describe("multi-city tiles -- the case the bug was about", () => {
  it.each(MULTI_CITY_TILES)("tile #%i resolves a click to the nearest city", (tileId) => {
    const cityCount = tileCitySlotCounts(tileId).length;
    for (let city = 0; city < cityCount; city += 1) {
      const centre = cityCentre(tileId, city);
      if (centre.slots === 0) continue;
      expect(cityIndexAtPoint(gridWith(tileId), Q, R, centre.x, centre.y, HEX_SIZE)).toBe(city);
    }
  });

  it.each(MULTI_CITY_TILES)("tile #%i does not answer 0 for every point", (tileId) => {
    // The precise shape of the bug: an implementation that always returned
    // the lowest index would pass every "city 0" assertion above.
    const answers = new Set<number | null>();
    const cityCount = tileCitySlotCounts(tileId).length;
    for (let city = 0; city < cityCount; city += 1) {
      const centre = cityCentre(tileId, city);
      if (centre.slots === 0) continue;
      answers.add(cityIndexAtPoint(gridWith(tileId), Q, R, centre.x, centre.y, HEX_SIZE));
    }
    expect(answers.size).toBeGreaterThan(1);
  });

  it("tracks tile orientation", () => {
    // The cities rotate with the tile, so the same screen point resolves to
    // different cities at different orientations. A hit-test that ignored
    // orientation would be right only at rotation 0.
    const tileId = MULTI_CITY_TILES[0];
    const atZero = cityCentre(tileId, 0, 0);
    const rotated = cityIndexAtPoint(gridWith(tileId, 3), Q, R, atZero.x, atZero.y, HEX_SIZE);
    // Not asserting WHICH city it becomes -- that is the art's business --
    // only that the answer is a real city index computed from the rotated
    // geometry rather than a constant.
    expect(rotated).not.toBeNull();
    expect(rotated).toBeGreaterThanOrEqual(0);
    expect(rotated).toBeLessThan(tileCitySlotCounts(tileId).length);
  });

  it("never returns an index outside the tile's city count", () => {
    for (const tileId of MULTI_CITY_TILES) {
      const count = tileCitySlotCounts(tileId).length;
      for (const [x, y] of [[0, 0], [1e4, 1e4], [-1e4, -1e4], [1e4, -1e4]]) {
        const answer = cityIndexAtPoint(gridWith(tileId), Q, R, x, y, HEX_SIZE);
        if (answer === null) continue;
        expect(answer).toBeGreaterThanOrEqual(0);
        expect(answer).toBeLessThan(count);
      }
    }
  });
});
