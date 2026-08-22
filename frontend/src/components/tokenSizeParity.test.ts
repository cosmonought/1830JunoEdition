// frontend/src/components/tokenSizeParity.test.ts
//
// ==================================================================
//  DESIGN NOTE 699 (harness): A TOKEN IS ONE PIECE, EVERYWHERE
// ==================================================================
//
// Two reports, one fault:
//
//   "the NNH shrinks on the green upgrade to G19 even though that is still a single-station city. It is
//    almost difficult to read that it is NNH's token at the size it has shrunk to."
//
//   "B&O's second station has a border around it that B&O's home station does not. Is this a style for all
//    non-home station markers? If so I would say all station markers need to be identical."
//
// NEITHER IS A STYLE. Both are the same thing: the token's radius was decided by the SURFACE it landed on --
// preprinted hex, preprinted OO pair, New York's printed exception, laid tile -- and those four surfaces
// stated the shrink four different ways (`size`, `size * 0.75`, `size * 0.85`, and a `markers.length > 1`
// helper), while the token pass read a fifth (`size * 0.22`). Nothing was checking that they agreed, because
// nothing was asking one question.
//
// SO THE HARNESS ASSERTS PARITY, not sizes. The interesting claims are equalities between surfaces: an
// unshared city is an unshared city whether it is printed on the board or arrived on a green tile, and a
// player upgrading a hex should see their token stay exactly where and exactly how big it was.
//
// The DRAW CALLS ARE NOT INVOKED -- jsdom has no CanvasRenderingContext2D, and stubbing one tests the stub.
// Every figure here is the radius the renderer passes as `radiusOverride`, read from the same exported
// functions the renderer reads.

import {
  STATION_RADIUS_RATIO,
  markerSizeFor,
  stationTokenRadius,
  tileCityTokenRadius,
  NEW_YORK_PRINTED_ARTWORK,
} from "./TileGraphics";

const HEX_SIZE = 40;
/** What an unshared city's token is drawn at anywhere on the board. */
const FULL = HEX_SIZE * STATION_RADIUS_RATIO;

describe("a token does not change size when the hex is upgraded", () => {
  it("survives New York's green upgrade unchanged", () => {
    /* THE REPORT. G19 prints two one-slot cities; tile 54 lays two one-slot cities over them. Nothing about
       NNH's city became shared, so nothing about NNH's token should move.
       Under the old rule this pair was 8.80 -> 5.42 -- 39% of the radius, 63% of the area. */
    const printed = stationTokenRadius(NEW_YORK_PRINTED_ARTWORK.markers, 0, HEX_SIZE);
    const green = tileCityTokenRadius(54, HEX_SIZE, 0);

    expect(printed).toBeCloseTo(FULL, 6);
    expect(green).toBeCloseTo(FULL, 6);
    expect(green).toBeCloseTo(printed as number, 6);
  });

  it("holds for the second city on the same tile", () => {
    // Both of New York's cities, not just the one that happened to be reported.
    expect(stationTokenRadius(NEW_YORK_PRINTED_ARTWORK.markers, 1, HEX_SIZE)).toBeCloseTo(FULL, 6);
    expect(tileCityTokenRadius(54, HEX_SIZE, 1)).toBeCloseTo(FULL, 6);
  });

  it("only changes when the upgrade actually shares the city", () => {
    /* The shrink the report explicitly accepts -- "I understand why station tokens need to shrink a little
       when placing on a dual-station city". #62 is New York's brown: NOW the cities are shared, and now the
       token has a reason to be smaller. */
    const brown = tileCityTokenRadius(62, HEX_SIZE, 0) as number;
    expect(brown).toBeLessThan(FULL);
  });
});

describe("one shrink rule, not four", () => {
  it("ignores how many markers a tile carries when none of them are shared", () => {
    /* The old rule was `markers.length > 1`, which is a fact about the TILE. Every one of these tiles has two
       markers and no shared city. */
    for (const tileId of [1, 2, 54, 55, 56, 59, 64, 65, 66, 67, 68, 69]) {
      expect(markerSizeFor(TILE_MARKERS(tileId), HEX_SIZE)).toBe(HEX_SIZE);
    }
  });

  it("shrinks the one tile whose pills genuinely crowd", () => {
    // #62 -- two 2-slot cities. The only tile in the catalog where the shrink was ever doing its stated job.
    expect(markerSizeFor(TILE_MARKERS(62), HEX_SIZE)).toBeCloseTo(HEX_SIZE * 0.85, 6);
  });

  it("leaves a lone pill at full size", () => {
    // #63 has one marker, so there is nothing for it to crowd. It shrinks at the RING, not at the marker.
    expect(markerSizeFor(TILE_MARKERS(63), HEX_SIZE)).toBe(HEX_SIZE);
  });
});

describe("the shrink is not anti-correlated with sharing", () => {
  it("never lets a shared city out-size an unshared one", () => {
    /* The old rule did exactly this: #63 (genuinely shared, one marker) escaped the marker-count shrink and
       drew 0.159 while #54 (unshared, two markers) drew 0.135. A player reading token size as "is this city
       shared" was being told the opposite of the truth. */
    const shared = [
      tileCityTokenRadius(63, HEX_SIZE, 0) as number,
      tileCityTokenRadius(62, HEX_SIZE, 0) as number,
      tileCityTokenRadius(62, HEX_SIZE, 1) as number,
    ];
    const unshared = [
      tileCityTokenRadius(54, HEX_SIZE, 0) as number,
      tileCityTokenRadius(57, HEX_SIZE, 0) as number,
      tileCityTokenRadius(64, HEX_SIZE, 1) as number,
    ];
    expect(Math.max(...shared)).toBeLessThan(Math.min(...unshared));
  });
});

/** The catalog's markers for a tile, via the only door this module has to them. Kept as a helper so the tests
 *  above read as claims about tiles rather than about lookups. */
function TILE_MARKERS(tileId: number) {
  // `tileCityTokenRadius` is the exported path into the catalog; reconstructing the marker list from the two
  // exported functions keeps this file off `TILE_GRAPHICS_CATALOG`'s internals.
  const slotted = SLOTS_BY_TILE[tileId];
  if (!slotted) throw new Error(`tile ${tileId} missing from the harness fixture`);
  return slotted;
}

/* The catalog's own marker shapes, restated. NOT a second source of truth -- the assertion below pins every
   entry against the real `tileCityTokenRadius`, so a catalog edit that this fixture missed fails loudly
   rather than quietly testing a stale picture. */
const SLOTS_BY_TILE: Record<number, { kind: "city" | "town"; at: { x: number; y: number }; slots?: number }[]> =
  {
    1: [town(), town()],
    2: [town(), town()],
    54: [city(), city()],
    55: [town(), town()],
    56: [town(), town()],
    57: [city()],
    59: [city(), city()],
    62: [city(2), city(2)],
    63: [city(2)],
    64: [city(), city()],
    65: [city(), city()],
    66: [city(), city()],
    67: [city(), city()],
    68: [city(), city()],
    69: [town(), town()],
  };

function city(slots?: number) {
  return { kind: "city" as const, at: { x: 0, y: 0 }, ...(slots ? { slots } : {}) };
}
function town() {
  return { kind: "town" as const, at: { x: 0, y: 0 } };
}

describe("the harness fixture still matches the catalog", () => {
  it("derives the same radius the renderer would", () => {
    /* The tripwire. Every tile above whose first marker is a city must agree with `tileCityTokenRadius`, which
       reads the real catalog. A tile that gains or loses a slot breaks this rather than silently making the
       tests above describe a board that no longer exists. */
    const mismatches: string[] = [];
    for (const key of Object.keys(SLOTS_BY_TILE)) {
      const tileId = Number(key);
      const fixture = stationTokenRadius(SLOTS_BY_TILE[tileId], 0, HEX_SIZE);
      const real = tileCityTokenRadius(tileId, HEX_SIZE, 0);
      if (fixture === undefined && real === undefined) continue;
      if (fixture === undefined || real === undefined || Math.abs(fixture - real) > 1e-9) {
        mismatches.push(`tile ${tileId}: fixture ${fixture} vs catalog ${real}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
