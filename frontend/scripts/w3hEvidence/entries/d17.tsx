// W3-H evidence, VF/D-17: whole-board repaint while a lay flourish runs.
// Mounts the real HexGridRenderer (standard board, initialGridFor + ~20 accepted yellow lays), then swaps in a
// grid with one city upgrade so the renderer's own layout effect starts a tile transition and its frame clock
// repaints the whole board every animation frame for the transition's duration.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { HexGridRenderer } from "../../../src/components/HexGridRenderer";
import { STANDARD_BOARD, STATIC_BOARD_HEXES } from "../../../src/components/hexBoardData";
import { TILE_CATALOG_BY_ID } from "../../../src/components/hexTileCatalog";
import { filterSandboxPlacements } from "../../../src/components/sandboxTileLegality";
import { initialGridFor } from "../../../src/gameEngine/initialGrid";
import { planTileTransition } from "../../../src/components/tileTransition";
import type { MapGridResponse, MapTileEntry } from "../../../src/components/hexContractTypes";

// Count whole-canvas clears: the draw callback starts every repaint with clearRect(0, 0, width, height), inside a
// save()/restore() pair. The time from that clear to the last restore() before the next clear is the JS cost of
// issuing one whole-board repaint (rasterisation may be deferred past it, so this is a lower bound).
const proto = CanvasRenderingContext2D.prototype as any;
const clear = proto.clearRect;
const restore = proto.restore;
const w0 = window as any;
w0.__boardRepaints = 0;
w0.__repaintMs = [];
w0.__repaintStart = null;
w0.__lastRestore = 0;
proto.restore = function () {
  w0.__lastRestore = performance.now();
  return restore.call(this);
};
proto.clearRect = function (x: number, y: number, w: number, h: number) {
  if (x === 0 && y === 0 && w > 400 && h > 400) {
    w0.__boardRepaints++;
    const now = performance.now();
    if (w0.__repaintStart !== null && w0.__lastRestore > w0.__repaintStart) w0.__repaintMs.push(w0.__lastRestore - w0.__repaintStart);
    w0.__repaintStart = now;
  }
  return clear.call(this, x, y, w, h);
};

const EVERY_FACING = Array.from(TILE_CATALOG_BY_ID.keys()).flatMap((tileId) =>
  [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: tileId, orientation })),
);
const accepted = (grid: MapGridResponse, label: string, era: "Yellow" | "Green") => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) return null;
  const placement = filterSandboxPlacements(EVERY_FACING as any, { mapGrid: grid as any, q: hex.q, r: hex.r, era } as any)
    .find((p) => TILE_CATALOG_BY_ID.get(p.tile_id)?.color === era);
  return placement ? { q: hex.q, r: hex.r, tile_id: placement.tile_id, orientation: placement.orientation } : null;
};

const base = initialGridFor(STANDARD_BOARD);
let grid: MapGridResponse = { ...base, tiles: [...base.tiles] };
const LAY_LABELS = ["H10", "I15", "E23", "G19", "E11", "G7", "E7", "D10", "B20", "F20", "H12", "I13", "G13", "F14", "E19", "D14", "G11", "H8", "F12", "E13", "H14", "I11"];
const laid: string[] = [];
for (const label of LAY_LABELS) {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex || grid.tiles.some((t) => t.q === hex.q && t.r === hex.r)) continue;
  const tile = accepted(grid, label, "Yellow");
  if (!tile) continue;
  grid = { ...grid, tiles: [...grid.tiles, tile as MapTileEntry] };
  laid.push(`${label}:#${tile.tile_id}`);
}
// The flourish: the first laid city hex that accepts a green upgrade.
let upgraded: MapGridResponse | null = null;
let flourish: any = null;
for (const entry of laid) {
  const label = entry.split(":")[0];
  const up = accepted(grid, label, "Green");
  if (!up) continue;
  const from = grid.tiles.find((t) => t.q === up.q && t.r === up.r)!;
  const plan = planTileTransition({ from: { kind: "tile", tileId: from.tile_id, orientation: from.orientation }, to: { tileId: up.tile_id, orientation: up.orientation } });
  if (!plan) continue;
  upgraded = { ...grid, tiles: grid.tiles.map((t) => (t === from ? (up as MapTileEntry) : t)) };
  flourish = { label, from: from.tile_id, to: up.tile_id, durationMs: plan.durationMs };
  break;
}

function Shell() {
  const [mapGrid, setMapGrid] = useState<MapGridResponse>(grid);
  (window as any).__lay = () => setMapGrid(upgraded!);
  (window as any).__reset = () => setMapGrid(grid);
  return <HexGridRenderer mapGrid={mapGrid} />;
}

(window as any).__meta = { tilesOnBoard: grid.tiles.length, laid, flourish };
createRoot(document.getElementById("root")!).render(<Shell />);
(window as any).__ready = true;
