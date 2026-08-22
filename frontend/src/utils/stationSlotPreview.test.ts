// frontend/src/utils/stationSlotPreview.test.ts
//
// Design note #698: THE PREVIEW MUST NAME THE POINT THE PLACEMENT DRAWS.
//
// The reported bug was not a wrong number, it was TWO ANSWERS TO ONE QUESTION -- the ring anchored on a city,
// the token docked into a slot. On the one-slot cities that are most of the board those coincide, which is why
// nothing caught it. So the harness asserts the equality itself rather than any particular coordinate: for a
// two-slot city, the point `nextCitySlotPoint` promises is the point the draw pass's slot list hands back for
// the token that then arrives.

import { nextCitySlotPoint, tokenCityBucket } from "./stationTokens";
import { tileCitySlotCounts, tileCitySlotPoints } from "../components/TileGraphics";
import type { MapGridResponse, StationTokenCompany } from "../components/hexContractTypes";

const CENTER = { x: 0, y: 0 };
const HEX_SIZE = 40;

/** A green two-slot city. Picked by asking the artwork rather than asserting a tile id, so the harness keeps
 *  meaning something if the catalog is renumbered. */
function twoSlotCityTile(): { tileId: number; cityIndex: number } {
  for (const tileId of [14, 15, 63, 62]) {
    const counts = tileCitySlotCounts(tileId);
    const at = counts.findIndex((slots) => slots >= 2);
    if (at >= 0) return { tileId, cityIndex: at };
  }
  throw new Error("no two-slot city in the catalog -- the fixture needs updating");
}

function gridWith(tileId: number): MapGridResponse {
  return {
    tiles: [{ q: 0, r: 0, tile_id: tileId, orientation: 0 }],
  } as unknown as MapGridResponse;
}

function companyOn(id: number, cityIndex: number): StationTokenCompany {
  return {
    company_id: id,
    is_floated: true,
    station_token_hexes: [[0, 0]],
    station_tokens: [[0, 0, cityIndex]],
  } as unknown as StationTokenCompany;
}

describe("station preview anchors on the slot, not the city", () => {
  it("names the first slot when the city is empty", () => {
    const { tileId, cityIndex } = twoSlotCityTile();
    const slots = tileCitySlotPoints(tileId, cityIndex, 0, CENTER, HEX_SIZE);

    const previewed = nextCitySlotPoint(gridWith(tileId), [], 0, 0, cityIndex, CENTER, HEX_SIZE);

    expect(previewed).toEqual(slots[0]);
  });

  it("moves to the second slot once the first is taken", () => {
    const { tileId, cityIndex } = twoSlotCityTile();
    const slots = tileCitySlotPoints(tileId, cityIndex, 0, CENTER, HEX_SIZE);
    const sitting = [companyOn(1, cityIndex)];

    const previewed = nextCitySlotPoint(gridWith(tileId), sitting, 0, 0, cityIndex, CENTER, HEX_SIZE);

    expect(previewed).toEqual(slots[1]);
    // The point that moved is the bug: previewing the SAME place twice is what "in the middle of the tile"
    // looked like from the player's side.
    expect(previewed).not.toEqual(slots[0]);
  });

  it("previews where the draw pass will draw", () => {
    const { tileId, cityIndex } = twoSlotCityTile();
    const slots = tileCitySlotPoints(tileId, cityIndex, 0, CENTER, HEX_SIZE);
    const first = companyOn(1, cityIndex);
    const second = companyOn(2, cityIndex);

    // What the ring promised the second company before it placed.
    const previewed = nextCitySlotPoint(gridWith(tileId), [first], 0, 0, cityIndex, CENTER, HEX_SIZE);

    // What the draw pass then resolves for it: bucket in arrival order, index within the bucket, same slots.
    const bucket = [first, second].filter((company) => tokenCityBucket(company, 0, 0) === cityIndex);
    const drawnAt = slots[bucket.findIndex((company) => company.company_id === 2)];

    expect(previewed).toEqual(drawnAt);
  });

  it("clamps rather than vanishing when the city is full", () => {
    const { tileId, cityIndex } = twoSlotCityTile();
    const slots = tileCitySlotPoints(tileId, cityIndex, 0, CENTER, HEX_SIZE);
    const full = [companyOn(1, cityIndex), companyOn(2, cityIndex), companyOn(3, cityIndex)];

    const previewed = nextCitySlotPoint(gridWith(tileId), full, 0, 0, cityIndex, CENTER, HEX_SIZE);

    expect(previewed).toEqual(slots[slots.length - 1]);
  });

  it("gives up on a multi-city hex it cannot resolve, so the caller keeps its centroid", () => {
    // Tile 62 is an OO pair: two cities, and therefore nothing a missing index could be guessed from.
    expect(tileCitySlotCounts(62).length).toBeGreaterThan(1);
    expect(nextCitySlotPoint(gridWith(62), [], 0, 0, null, CENTER, HEX_SIZE)).toBeNull();
  });

  it("resolves a one-city hex without an index, because there is nothing to guess", () => {
    // Tile 8 is plain track; 57 is the yellow single city. Assert the shape first so a catalog change fails
    // here rather than silently weakening the claim.
    expect(tileCitySlotCounts(57)).toHaveLength(1);
    expect(nextCitySlotPoint(gridWith(57), [], 0, 0, null, CENTER, HEX_SIZE)).not.toBeNull();
  });

  it("returns null for a hex with no laid tile", () => {
    const empty = { tiles: [] } as unknown as MapGridResponse;
    expect(nextCitySlotPoint(empty, [], 0, 0, 0, CENTER, HEX_SIZE)).toBeNull();
  });
});

describe("tokenCityBucket", () => {
  it("reads the recorded city", () => {
    expect(tokenCityBucket(companyOn(1, 1), 0, 0)).toBe(1);
  });

  it("falls to city 0 when the chain recorded none", () => {
    const noIndex = {
      company_id: 9,
      is_floated: true,
      station_token_hexes: [[0, 0]],
      station_tokens: [],
    } as unknown as StationTokenCompany;
    expect(tokenCityBucket(noIndex, 0, 0)).toBe(0);
  });
});
