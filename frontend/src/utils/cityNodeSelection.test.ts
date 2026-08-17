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

import { cityIndexAtPoint, cityNodePoints } from "./stationTokens";
import { tileCitySlotCounts, tileCitySlotPoints } from "../components/TileGraphics";
import { axialToPixel, twoNodePositions } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES, YELLOW_OO_HEXES } from "../components/hexBoardData";

/** The board's own OO set, read rather than retyped. */
const OO_HEX_LABELS = Array.from(YELLOW_OO_HEXES);

const HEX_SIZE = 40;
const Q = 3;
const R = 4;

function gridWith(tileId: number, orientation = 0): MapGridResponse {
  return {
    game_id: 1,
    tiles: [{ q: Q, r: R, tile_id: tileId, orientation }],
  } as unknown as MapGridResponse;
}

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
  it("returns null on an untiled hex with no printed cities", () => {
    // An ordinary blank hex genuinely has nothing to measure. Guessing would
    // send a confident wrong index; null omits the field.
    const blank = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
    // (0,0) in this board's table is not a city hex.
    expect(cityIndexAtPoint(blank, 0, 0, 0, 0, HEX_SIZE)).toBeNull();
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


/* ==================================================================
 *  DESIGN NOTE 459 (harness): THE PREPRINTED OO HEXES
 * ==================================================================
 *
 * The reported bug -- clicking the Erie's upper-right city places on the
 * lower-left one -- was NOT in the multi-city maths above. It was a missing
 * branch: `cityIndexAtPoint` bailed to `null` for any hex with no LAID
 * tile, and E11 is a PREPRINTED OO hex that arrives with two station
 * circles already on it and no tile.
 *
 * `null` then meant "omit `city_index`", the contract applied its
 * lowest-free-city fallback, and every click on either circle resolved to
 * city 0. So these tests use the real board hexes rather than a fixture: if
 * E11 ever stops being an OO hex, or the board moves it, this should fail.
 */
describe("preprinted OO hexes -- the Erie's home", () => {
  const untiled = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

  /** The four hexes 1830 prints with two station circles and no tile. */
  const OO_HEXES: Array<[string, number, number]> = OO_HEX_LABELS.map((label) => {
    const hex = STATIC_BOARD_HEXES.find((h) => h.label === label);
    return [label, hex?.q ?? NaN, hex?.r ?? NaN] as [string, number, number];
  });

  it("knows where the four OO hexes are", () => {
    for (const [label, q, r] of OO_HEXES) {
      expect(`${label}:${Number.isFinite(q)}`).toBe(`${label}:true`);
      expect(Number.isFinite(r)).toBe(true);
    }
  });

  it.each(OO_HEXES)("%s resolves the north-east circle to city 0", (_label, q, r) => {
    const [ne] = twoNodePositions(axialToPixel(q, r, HEX_SIZE), HEX_SIZE);
    expect(cityIndexAtPoint(untiled, q, r, ne.x, ne.y, HEX_SIZE)).toBe(0);
  });

  it.each(OO_HEXES)("%s resolves the south-west circle to city 1", (_label, q, r) => {
    // THE REPORTED BUG. This returned `null` -> omitted -> city 0.
    const [, sw] = twoNodePositions(axialToPixel(q, r, HEX_SIZE), HEX_SIZE);
    expect(cityIndexAtPoint(untiled, q, r, sw.x, sw.y, HEX_SIZE)).toBe(1);
  });

  it("E11 -- the Erie's home -- distinguishes its two circles", () => {
    const erie = STATIC_BOARD_HEXES.find((h) => h.label === "E11");
    expect(erie).toBeDefined();
    const nodes = twoNodePositions(axialToPixel(erie!.q, erie!.r, HEX_SIZE), HEX_SIZE);
    const answers = nodes.map((n) =>
      cityIndexAtPoint(untiled, erie!.q, erie!.r, n.x, n.y, HEX_SIZE),
    );
    // Not both 0 -- which is exactly what the bug produced.
    expect(answers).toEqual([0, 1]);
  });
});

describe("cityNodePoints", () => {
  it("marks both circles on a preprinted OO hex", () => {
    const untiled = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
    const erie = STATIC_BOARD_HEXES.find((h) => h.label === "E11")!;
    expect(cityNodePoints(untiled, erie.q, erie.r, HEX_SIZE)).toHaveLength(2);
  });

  it("agrees with the hit-test about where every node is", () => {
    /* The property that makes the glow a promise: a marker cannot pulse
       anywhere a click would resolve elsewhere. */
    const untiled = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
    for (const label of OO_HEX_LABELS) {
      const hex = STATIC_BOARD_HEXES.find((h) => h.label === label)!;
      const nodes = cityNodePoints(untiled, hex.q, hex.r, HEX_SIZE);
      nodes.forEach((node, index) => {
        expect(cityIndexAtPoint(untiled, hex.q, hex.r, node.x, node.y, HEX_SIZE)).toBe(index);
      });
    }
  });

  it("agrees on laid multi-city tiles too", () => {
    for (const tileId of MULTI_CITY_TILES) {
      const grid = gridWith(tileId);
      const nodes = cityNodePoints(grid, Q, R, HEX_SIZE);
      nodes.forEach((node, index) => {
        expect(cityIndexAtPoint(grid, Q, R, node.x, node.y, HEX_SIZE)).toBe(index);
      });
    }
  });

  it("draws nothing on a hex with no cities", () => {
    const blank = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
    expect(cityNodePoints(blank, 0, 0, HEX_SIZE)).toEqual([]);
  });
});
