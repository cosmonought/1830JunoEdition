// frontend/src/utils/tileSupply.test.ts
//
// ==================================================================
//  DESIGN NOTE 626/627 (harness): THE MIRROR AND THE ARITHMETIC
// ==================================================================
//
// Two things are pinned here and they fail for different reasons.
//
// THE MIRRORED QUANTITIES are a hand-copied column from `hexmap.rs`, which is
// the shape of data this codebase has got wrong before (design note #607's
// C&O home hex was one wrong entry in a column of eight right ones). These
// assertions name the counts that decide opening play, so a bad paste shows
// up as a rule changing rather than as a number changing.
//
// THE DERIVATION is small and total, and its only interesting cases are the
// boundaries: a tile at full supply, a tile part-used, the last copy, and an
// id the catalog does not carry.

import { TILE_CATALOG, TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { tileStock, tileStockTable } from "./tileSupply";
import type { MapGridResponse } from "../components/hexContractTypes";

/** A board holding the given tile ids, one per hex. Coordinates are
 *  irrelevant to supply -- only how many copies are out. */
function boardWith(tileIds: number[]): MapGridResponse {
  return {
    game_id: 1,
    tiles: tileIds.map((tile_id, index) => ({
      q: index,
      r: 0,
      tile_id,
      orientation: 0,
    })),
  } as unknown as MapGridResponse;
}

describe("the mirrored tray counts", () => {
  it("carries a real printed count for all 46 tiles", () => {
    /* Design note #626: `UNLIMITED_TILE_SUPPLY` (u32::MAX) is deliberately
       not modelled because nothing uses it. If the backend ever does, this
       is the assertion that says so before anyone renders "4294967295
       left". */
    expect(TILE_CATALOG).toHaveLength(46);
    for (const entry of TILE_CATALOG) {
      expect(Number.isInteger(entry.quantity)).toBe(true);
      expect(entry.quantity).toBeGreaterThan(0);
      expect(entry.quantity).toBeLessThan(100);
    }
  });

  it("keeps the yellow scarcity that decides the opening", () => {
    /* The facts a player most needs and currently cannot see. #57 is the
       ONLY yellow city tile in this catalog, and eight corporations need a
       home station. */
    const yellowCities = TILE_CATALOG.filter(
      (entry) => entry.color === "Yellow" && entry.terrain === "MajorCityHub",
    );
    expect(yellowCities.map((entry) => entry.tileId)).toEqual([57]);
    expect(yellowCities[0].quantity).toBe(4);

    // Every yellow double-town is a single physical copy.
    for (const id of [1, 2, 55, 56, 69]) {
      expect(TILE_CATALOG_BY_ID.get(id)?.quantity).toBe(1);
    }
    // The plain yellows are the plentiful ones, which is the contrast.
    expect(TILE_CATALOG_BY_ID.get(8)?.quantity).toBe(8);
    expect(TILE_CATALOG_BY_ID.get(9)?.quantity).toBe(7);
  });

  it("keeps the green city counts", () => {
    expect(TILE_CATALOG_BY_ID.get(14)?.quantity).toBe(3);
    expect(TILE_CATALOG_BY_ID.get(15)?.quantity).toBe(2);
    // New York's green upgrade is unique.
    expect(TILE_CATALOG_BY_ID.get(54)?.quantity).toBe(1);
  });
});

describe("tileStock", () => {
  it("reports the full tray on an empty board", () => {
    expect(tileStock(boardWith([]), 57)).toEqual({ printed: 4, placed: 0, remaining: 4 });
  });

  it("subtracts what is currently on the map", () => {
    expect(tileStock(boardWith([57, 57, 8]), 57)).toEqual({
      printed: 4,
      placed: 2,
      remaining: 2,
    });
  });

  it("reaches zero on the last copy", () => {
    expect(tileStock(boardWith([57, 57, 57, 57]), 57)?.remaining).toBe(0);
  });

  it("counts a single-copy tile correctly", () => {
    // Design note #627: the case where the number changes a decision.
    expect(tileStock(boardWith([]), 54)?.remaining).toBe(1);
    expect(tileStock(boardWith([54]), 54)?.remaining).toBe(0);
  });

  it("never reports a negative remainder", () => {
    /* More copies on the board than exist is a data fault, not a supply
       state. "-1 left" would read as a rendering bug rather than as the
       inconsistency it is. */
    expect(tileStock(boardWith([54, 54, 54]), 54)?.remaining).toBe(0);
  });

  it("returns null for a tile the catalog does not carry", () => {
    // Absent evidence is not evidence of absence -- answering "none left"
    // would dress a mirror gap up as a supply problem.
    expect(tileStock(boardWith([]), 999)).toBeNull();
  });

  it("treats a missing map as an untouched tray", () => {
    // Before the first `GetMapGrid` resolves there is no board to count.
    expect(tileStock(null, 57)?.remaining).toBe(4);
    expect(tileStock(undefined, 57)?.remaining).toBe(4);
  });
});

describe("tileStockTable", () => {
  it("covers every catalog entry", () => {
    const table = tileStockTable(boardWith([57, 8]));
    expect(table.size).toBe(46);
    expect(table.get(57)?.remaining).toBe(3);
    expect(table.get(8)?.remaining).toBe(7);
    // Untouched tiles report their full printed count.
    expect(table.get(9)?.remaining).toBe(7);
  });
});
