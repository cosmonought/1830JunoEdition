// How many copies of a tile are still in the tray.
//
// Design note #627: the contract owns this figure (`state::REMAINING_TILES`) and
// no `QueryMsg` exposes it. It can be derived without guessing because the
// arithmetic is CLOSED: a tile is either on the board or in the tray, and
// upgrading returns the tile underneath to the tray rather than consuming it.
//
//     remaining(id) = printed(id) - (tiles with that id currently on the map)
//
// THIS IS STILL A SECOND IMPLEMENTATION OF A FACT THE CONTRACT OWNS, which has
// bitten this codebase repeatedly (design notes #411, #431, #621). Accepted here
// for two reasons that do not apply to those: the derivation is TOTAL rather
// than incremental, so it cannot drift the way a counter can; and it is
// READ-ONLY -- nothing dispatches on this number and the contract still refuses
// an unavailable tile, so the worst a wrong answer does is mislabel a candidate.
//
// THE RIGHT EVENTUAL SHAPE IS A QUERY. `GetTileSupply` would make this a read
// rather than a re-derivation, and this module would become its parser.
//
// See docs/ai_architecture/hex_tile_math.md, tileSupply.ts #627.

import { TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { inTray, trayCountOf, trayEntries } from "../components/tileTray";
import type { MapGridResponse } from "../components/hexContractTypes";

/** What the tray holds for one tile id.
 *
 *  `printed` is the physical 1830 count; `placed` is how many are on the
 *  board right now; `remaining` is what a player could still lay. */
export interface TileStock {
  printed: number;
  placed: number;
  remaining: number;
}

/** Unknown ids report `null` rather than zero. A tile the catalog has never
 *  heard of is a gap in the mirror, and answering "none left" would dress
 *  that up as a supply problem -- the same "absent evidence is not evidence
 *  of absence" rule `hasBuyablePrivate` applies. */
export function tileStock(
  mapGrid: MapGridResponse | null | undefined,
  tileId: number,
): TileStock | null {
  const entry = TILE_CATALOG_BY_ID.get(tileId);
  if (!entry) return null;
  // Design note #1311: a tile the catalog can draw but this game's tray does not hold is "not in this game",
  // which is the same honest `null` an unknown id gets -- not a zero that reads as "all of them are out".
  if (!inTray(tileId)) return null;
  // #1301: a tile PRINTED on the board never left the tray, so it does not count against it.
  const placed = (mapGrid?.tiles ?? []).reduce(
    (total, tile) => (tile.tile_id === tileId && tile.printed !== true ? total + 1 : total),
    0,
  );
  const printed = trayCountOf(tileId); // #1311: this game's tray, not the catalog's default
  return {
    printed,
    placed,
    // Clamped at zero. A negative would mean the board holds more copies than
    // exist, which is a data fault rather than a supply state -- and "-1
    // left" on a candidate would read as a rendering bug rather than as the
    // inconsistency it is.
    remaining: Math.max(0, printed - placed),
  };
}

/** Every tile id the catalog knows, with its current stock. For a manifest
 *  view; the selector asks per candidate. */
export function tileStockTable(
  mapGrid: MapGridResponse | null | undefined,
): ReadonlyMap<number, TileStock> {
  const table = new Map<number, TileStock>();
  for (const entry of trayEntries()) {
    const stock = tileStock(mapGrid, entry.tileId);
    if (stock) table.set(entry.tileId, stock);
  }
  return table;
}
