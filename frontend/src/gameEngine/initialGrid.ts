// frontend/src/utils/initialGrid.ts
//
// The tile grid a game opens on -- design note #1301.
//
// EMPTY FOR THE STANDARD BOARD, which is what `MOCK_MAP_GRID` always was. The expansion prints one catalog
// tile on the board (green #24 at H12), and a printed tile is realised as an ordinary `MapTileEntry` flagged
// `printed` so that every reader of the grid sees a tile without learning a second kind of hex. The three
// places a game's grid begins -- the shell's `SetupGame` branch, the replay engine's, and the room reset --
// all begin it here.

import type { BoardDefinition } from "../components/hexBoardData";
import { TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { printedTileRevenue } from "../components/tileRevenue";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { MOCK_GRID_GAME_ID } from "./mockFixtures";

export function initialGridFor(board: BoardDefinition): MapGridResponse {
  const tiles: MapTileEntry[] = board.hexes.flatMap((hex) => {
    if (!hex.printedTile) return [];
    const entry = TILE_CATALOG_BY_ID.get(hex.printedTile.tileId);
    const printed = printedTileRevenue(hex.printedTile.tileId); // Route v12: the one revenue accessor (`tileRevenue.ts`)
    return [
      {
        q: hex.q,
        r: hex.r,
        tile_id: hex.printedTile.tileId,
        orientation: hex.printedTile.orientation,
        // The same two derived fields `applySandboxLayTile` writes for a laid tile.
        paths: entry?.paths ?? null,
        revenue: printed === undefined ? undefined : String(printed),
        landmark: null,
        printed: true,
      },
    ];
  });
  return { game_id: MOCK_GRID_GAME_ID, tiles };
}
