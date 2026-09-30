// frontend/src/components/tileRevenue.ts
//
// ==================================================================
//  ROUTE v12: A TILE'S PRINTED REVENUE, ASKED OF THE RULES IN EFFECT
// ==================================================================
//
// OWNER RULING (2026-09-29, folded into rules v12 before v12 merged or was settlement-certified): brown New York
// tile #62 prints $80 per city. The $90 the catalog carried (design note #135) conflated it with the 1830+ / LPF
// New York tile #883, which does print $90 and is unchanged. The catalog now says $80 for #62.
//
// PIN-GATED, as every R12-2 replay-affecting change is: a stored log replays to what it meant. The unpinned
// development corpus plays the `*_BOARD_PRE_V12` twins (`routeRulesV12InEffect()` false), and on those #62 still
// pays the $90 it paid when those logs were played -- so their replays, and the frozen SET-0A settlement goldens
// rebuilt from them, do not move. Every pinned board (v12) pays $80.
//
// This is the ONE place a tile's catalog revenue is read for pricing, drawing or stamping a lay; nothing outside
// it reads `TileCatalogEntry.revenue` for a figure.

import { TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import { routeRulesV12InEffect } from "./hexBoardData";

/** What the pre-v12 route rules priced differently from the catalog, by tile id. Only #62 ($90). */
export const PRE_V12_TILE_REVENUE: Readonly<Record<number, number>> = Object.freeze({ 62: 90 });

/** The printed revenue of `tileId` under the rules in effect, or `undefined` for a tile with no revenue centre (or
 *  an unknown id). */
export function printedTileRevenue(tileId: number): number | undefined {
  if (!routeRulesV12InEffect()) {
    const legacy = PRE_V12_TILE_REVENUE[tileId];
    if (legacy !== undefined) return legacy;
  }
  return TILE_CATALOG_BY_ID.get(tileId)?.revenue;
}
