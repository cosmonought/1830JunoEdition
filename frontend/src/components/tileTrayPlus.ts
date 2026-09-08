// frontend/src/components/tileTrayPlus.ts
//
// The Project 18XX+ tray -- design note #1311. The request, verbatim: "The following tiles and tile counts
// may be used as a variant supply for an 1830+ game. Any unlisted tiles remain as they are."
//
// So this is the standard tray with the listed counts written over it. A listed tile that is not in the
// standard tray (every `plusOnly` catalog entry) is added at its catalog count, which IS the listed count.

import { TILE_CATALOG } from "./hexTileCatalog";
import { STANDARD_TRAY, type TileTray } from "./tileTray";

/** The eight standard tiles whose counts the expansion changes. */
const RECOUNTED: ReadonlyArray<readonly [number, number]> = [
  [9, 12],
  [8, 13],
  [7, 7],
  [57, 6],
  [14, 4],
  [15, 4],
  [59, 3],
  [63, 1],
];

export const PLUS_TRAY: TileTray = {
  id: "plus",
  counts: (() => {
    const counts = new Map(STANDARD_TRAY.counts);
    RECOUNTED.forEach(([tileId, quantity]) => counts.set(tileId, quantity));
    TILE_CATALOG.filter((entry) => entry.plusOnly === true).forEach((entry) =>
      counts.set(entry.tileId, entry.quantity),
    );
    return counts;
  })(),
};
