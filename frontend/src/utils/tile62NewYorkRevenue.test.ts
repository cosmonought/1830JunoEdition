/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 (OWNER RULING, 2026-09-29): TILE #62 IS $80; THE 1830+ / LPF NEW YORK TILE #883 IS $90
// ==================================================================
//
// The catalog carried #62 at $90 -- a conflation with #883, the 1830+ / LPF New York tile, which does print $90. The
// owner's ruling corrects #62 to $80 and keeps #883 at $90, folded into rules v12 (v12 had not merged, shipped or
// been settlement-certified, so no v13). Like every v12 replay-affecting change it is PIN-GATED: the unpinned
// development corpus plays the `*_BOARD_PRE_V12` twins, on which #62 still pays the $90 those logs were played at.
//
// This suite keeps the two tiles apart so they cannot be conflated again: by catalog, by the one revenue accessor,
// by the figure a laid tile is stamped with, and by the price a route pays.

import { STANDARD_BOARD, STANDARD_BOARD_PRE_V12, withBoard, type BoardDefinition } from "../components/hexBoardData";
import { EXPANDED_BOARD, EXPANDED_BOARD_PRE_V12 } from "../components/hexBoardDataPlus";
import { LPF_BOARD, LPF_BOARD_PRE_V12 } from "../components/hexBoardDataLpf";
import { TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { PRE_V12_TILE_REVENUE, printedTileRevenue } from "../components/tileRevenue";
import { hexValueForEra } from "../components/hexGeometry";
import { initialGridFor } from "../gameEngine/initialGrid";
import { applySandboxLayTile } from "../gameEngine/sandboxSession";
import { ORACLE_STANDARD_TILES } from "../routeOracle/oracleManifest";

const NY_62 = 62;
const NY_883 = 883;
const V12_BOARDS: readonly BoardDefinition[] = [STANDARD_BOARD, EXPANDED_BOARD, LPF_BOARD];
const PRE_V12_BOARDS: readonly BoardDefinition[] = [STANDARD_BOARD_PRE_V12, EXPANDED_BOARD_PRE_V12, LPF_BOARD_PRE_V12];

/** New York (G19) with `tileId` laid on it, on `board`'s own opening grid, and what a stop there pays in Brown. */
function newYorkWith(board: BoardDefinition, tileId: number): { stamped: unknown; price: number } {
  return withBoard(board, () => {
    const g19 = board.hexes.find((hex) => hex.label === "G19")!;
    const grid = applySandboxLayTile(initialGridFor(board), g19.q, g19.r, tileId, 0);
    const laid = grid.tiles.find((tile) => tile.q === g19.q && tile.r === g19.r)!;
    return { stamped: laid.revenue, price: hexValueForEra(grid, g19.q, g19.r, "Brown") };
  });
}

describe("the catalog: two different New York tiles at two different figures", () => {
  it("#62 (standard 1830 brown New York) is $80; #883 (the 1830+ / LPF New York tile) is $90", () => {
    const t62 = TILE_CATALOG_BY_ID.get(NY_62)!;
    const t883 = TILE_CATALOG_BY_ID.get(NY_883)!;
    expect([t62.terrain, t62.plusOnly, t62.revenue]).toEqual(["NewYorkHub", undefined, 80]);
    expect([t883.terrain, t883.plusOnly, t883.revenue]).toEqual(["NewYorkHub", true, 90]);
    // The oracle's independent transcription agrees, and records no production data defect for #62 any more.
    expect(ORACLE_STANDARD_TILES[NY_62]).toEqual({ value: 80, cities: [[0, 1], [2, 3]] });
  });

  it("the pre-v12 exception names #62 alone, at the $90 the unpinned corpus was played at -- never #883", () => {
    expect(PRE_V12_TILE_REVENUE).toEqual({ 62: 90 });
    expect(Object.isFrozen(PRE_V12_TILE_REVENUE)).toBe(true);
  });
});

describe("the one accessor, under each board's rules", () => {
  it.each(V12_BOARDS.map((board) => [board.id, board] as const))("v12 %s: #62 $80, #883 $90", (_id, board) => {
    expect(withBoard(board, () => [printedTileRevenue(NY_62), printedTileRevenue(NY_883)])).toEqual([80, 90]);
  });
  it.each(PRE_V12_BOARDS.map((board) => [board.id, board] as const))("pre-v12 %s: #62 $90 (as played), #883 $90", (_id, board) => {
    expect(withBoard(board, () => [printedTileRevenue(NY_62), printedTileRevenue(NY_883)])).toEqual([90, 90]);
  });
  it("every other tile's figure is the catalog's on every board, v12 or not", () => {
    for (const board of [...V12_BOARDS, ...PRE_V12_BOARDS]) {
      withBoard(board, () => {
        TILE_CATALOG_BY_ID.forEach((entry, id) => {
          if (id !== NY_62) expect([board.id, id, printedTileRevenue(id)]).toEqual([board.id, id, entry.revenue]);
        });
      });
    }
  });
});

describe("a laid New York tile: the figure it is stamped with and the price a stop there pays", () => {
  it("#62 on New York: stamped and priced $80 on the v12 standard map, $90 on its pre-v12 twin", () => {
    expect(newYorkWith(STANDARD_BOARD, NY_62)).toEqual({ stamped: "80", price: 80 });
    expect(newYorkWith(STANDARD_BOARD_PRE_V12, NY_62)).toEqual({ stamped: "90", price: 90 });
  });

  it("#883 on New York (1830+ / LPF): stamped and priced $90 on v12 and pre-v12 alike", () => {
    for (const board of [EXPANDED_BOARD, LPF_BOARD, EXPANDED_BOARD_PRE_V12, LPF_BOARD_PRE_V12]) {
      expect([board.id, newYorkWith(board, NY_883)]).toEqual([board.id, { stamped: "90", price: 90 }]);
    }
  });

  it("an unstamped #62 (a grid without the wire's revenue field) is priced from the accessor: $80 v12, $90 pre-v12", () => {
    const price = (board: BoardDefinition) =>
      withBoard(board, () => {
        const g19 = board.hexes.find((hex) => hex.label === "G19")!;
        const grid = { game_id: 1, tiles: [{ q: g19.q, r: g19.r, tile_id: NY_62, orientation: 0, landmark: null }] };
        return hexValueForEra(grid, g19.q, g19.r, "Brown");
      });
    expect([price(STANDARD_BOARD), price(STANDARD_BOARD_PRE_V12)]).toEqual([80, 90]);
  });
});
