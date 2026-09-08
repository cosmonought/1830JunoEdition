// frontend/src/components/tileTray.ts
//
// The tray: which tiles are in THIS game, and how many of each -- design note #1311.
//
// ==================================================================
//  DESIGN NOTE 1311: THE TRAY IS A VALUE, LIKE THE BOARD
// ==================================================================
//
// `TILE_CATALOG` describes every tile that exists in either game -- its track, its stations, its colour. What
// it no longer decides is whether a tile is in the box on the table. That is the tray's question, and the
// two games answer it differently: the standard tray is 1830's printed counts, and the Project 18XX+ tray
// (`PLUS_TRAY`, `tileTrayPlus.ts`) changes eight counts and adds thirty tiles, including a Gray tier.
//
// A TILE WITH NO TRAY ENTRY IS NOT IN THE GAME. Legality asks the tray before it asks anything else, so a
// green town or a gray city cannot be offered at a standard table even though the catalog knows how to draw
// it. And the tray is what `tileSupply` counts against, so "3 left" means three in this tray.
//
// ONE TRAY IN EFFECT, set by the same authority that sets the board (`rulesFor` in `boardSelection.ts`),
// with the same scoped override and the same per-value memo -- see hexBoardData.ts #1300 for why that shape
// is safe and what its one hazard is.

import { TILE_CATALOG, type TileCatalogEntry } from "./hexTileCatalog";

export type TrayId = "standard" | "plus" | "lpf";

export interface TileTray {
  id: TrayId;
  /** Printed copies per tile id. Absent means "not in this game". */
  counts: ReadonlyMap<number, number>;
}

/** 1830's tray: every catalog entry that is not marked as belonging to the expansion only, at its printed count. */
export const STANDARD_TRAY: TileTray = {
  id: "standard",
  counts: new Map(
    TILE_CATALOG.filter((entry) => entry.plusOnly !== true).map((entry) => [entry.tileId, entry.quantity]),
  ),
};

let trayNow: TileTray = STANDARD_TRAY;

export function trayInEffect(): TileTray {
  return trayNow;
}

export function activateTray(tray: TileTray): void {
  trayNow = tray;
}

export function withTray<T>(tray: TileTray, fn: () => T): T {
  const previous = trayNow;
  trayNow = tray;
  try {
    return fn();
  } finally {
    trayNow = previous;
  }
}

/** Printed copies of `tileId` in the tray in effect; `0` when the tile is not in this game. */
export function trayCountOf(tileId: number): number {
  return trayNow.counts.get(tileId) ?? 0;
}

/** Whether `tileId` is in the tray in effect at all. */
export function inTray(tileId: number): boolean {
  return trayNow.counts.has(tileId);
}

/** The catalog entries in the tray in effect, in catalog order. */
export function trayEntries(): TileCatalogEntry[] {
  return TILE_CATALOG.filter((entry) => trayNow.counts.has(entry.tileId));
}

/** A derivation over the tray, cached per tray object (hexBoardData.ts #1300's `boardMemo`, for the tray). */
export function trayMemo<T>(build: (tray: TileTray) => T): () => T {
  const cache = new WeakMap<TileTray, T>();
  return () => {
    const cached = cache.get(trayNow);
    if (cached !== undefined) return cached;
    const built = build(trayNow);
    cache.set(trayNow, built);
    return built;
  };
}
