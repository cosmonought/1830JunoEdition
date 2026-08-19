// frontend/src/utils/tileSupply.ts
//
// HOW MANY COPIES OF A TILE ARE STILL IN THE TRAY.
//
// ===================================================================
//  DESIGN NOTE 627: DERIVED FROM THE BOARD, AND WHY THAT IS EXACT
// ===================================================================
//
// The contract owns this figure: `state::REMAINING_TILES` is seeded per game
// at each tile's printed quantity and decremented as tiles are laid. No
// `QueryMsg` exposes it, so the frontend cannot read it back.
//
// IT CAN BE DERIVED WITHOUT GUESSING, because of a rule that makes the
// arithmetic closed: a tile is either on the board or in the tray, and
// nothing else can hold one. Upgrading does not consume the tile underneath
// -- 1830 returns it to the tray -- so a yellow tile replaced by a green one
// stops being on the map and becomes available again, which is exactly what
// counting the CURRENT map says. There is no third place for a tile to be
// and no history to replay:
//
//     remaining(id) = printed(id) - (tiles with that id currently on the map)
//
// THIS IS STILL A SECOND IMPLEMENTATION OF A FACT THE CONTRACT OWNS, and
// this codebase has been bitten repeatedly by exactly that shape (design
// notes #411, #431, #621). It is accepted here for two reasons that do not
// apply to those: the derivation is total rather than incremental -- it reads
// the whole board every time, so it cannot drift out of step the way a
// counter can -- and it is READ-ONLY. Nothing dispatches on this number; the
// contract still refuses an unavailable tile on its own. The worst a wrong
// answer can do is mislabel a candidate, not lose a tile.
//
// THE RIGHT EVENTUAL SHAPE IS A QUERY. `GetTileSupply` would make this a
// read rather than a re-derivation, and this module would become its parser.
// Until then the note above is the argument for why the interim is sound.

import { TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
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
  const placed = (mapGrid?.tiles ?? []).reduce(
    (total, tile) => (tile.tile_id === tileId ? total + 1 : total),
    0,
  );
  return {
    printed: entry.quantity,
    placed,
    // Clamped at zero. A negative would mean the board holds more copies than
    // exist, which is a data fault rather than a supply state -- and "-1
    // left" on a candidate would read as a rendering bug rather than as the
    // inconsistency it is.
    remaining: Math.max(0, entry.quantity - placed),
  };
}

/** Every tile id the catalog knows, with its current stock. For a manifest
 *  view; the selector asks per candidate. */
export function tileStockTable(
  mapGrid: MapGridResponse | null | undefined,
): ReadonlyMap<number, TileStock> {
  const table = new Map<number, TileStock>();
  TILE_CATALOG_BY_ID.forEach((_entry, tileId) => {
    const stock = tileStock(mapGrid, tileId);
    if (stock) table.set(tileId, stock);
  });
  return table;
}
