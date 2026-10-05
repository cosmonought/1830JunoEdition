// W3-H evidence, VF/D-16: the tile flourish's hand-over at pixel level.
//
// For every distinct accepted upgrade pair reached by tileTransition.test.ts's own walk (standard rules, the same
// ten city/town labels), draw on a real canvas:
//   - the STATIC tile pass, copied statement for statement from HexGridRenderer.tsx's per-tile loop
//     (drawHexPath + ERA_TILE_FILL fill + COLOR_TIER_STROKE 2px rim, then drawTrackPath(..., false, undefined, false)
//     inside withHexClip), for the old tile and for the new one;
//   - the TRANSITION frame, through the board's own painter (drawTileTransitionFill + withHexClip(drawTileTransitionArt)),
//     at t = 0 (first frame), at the last frame the renderer can draw before t >= 1 hands over (t = 1 - 16.7ms/duration),
//     and at t = 1.
// and diff them per pixel. Also: a confirmed proposal's plan at t = 0 against proposedTileFrame (#1471).
import { planTileTransition, sampleTileTransition, proposedTileFrame, type TileTransitionFrame } from "../../../src/components/tileTransition";
import { drawTileTransitionArt, drawTileTransitionFill } from "../../../src/components/tileTransitionCanvas";
import { drawHexPath, drawTrackPath, withHexClip } from "../../../src/components/hexCanvasPrimitives";
import { COLOR_TIER_STROKE, ERA_TILE_FILL, STATIC_BOARD_HEXES } from "../../../src/components/hexBoardData";
import { TILE_CATALOG_BY_ID } from "../../../src/components/hexTileCatalog";
import { filterSandboxPlacements } from "../../../src/components/sandboxTileLegality";

type From = { kind: "tile"; tileId: number; orientation: number } | { kind: "printed"; label: string };
const BG = "#1e1f24";
const EVERY_FACING = Array.from(TILE_CATALOG_BY_ID.keys()).flatMap((tileId) =>
  [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: tileId, orientation })),
);
const TIERS = ["Yellow", "Green", "Brown", "Gray"] as const;

function collectPairs() {
  const pairs: Array<{ label: string; from: From; to: { tileId: number; orientation: number } }> = [];
  const seen = new Set<string>();
  const walk = (label: string, from: From, tierIndex: number, depth: number) => {
    const next = TIERS[tierIndex + 1];
    if (!next || depth > 3) return;
    const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
    const tiles = from.kind === "tile" ? [{ q: hex.q, r: hex.r, tile_id: from.tileId, orientation: from.orientation, landmark: null }] : [];
    const allowed = filterSandboxPlacements(EVERY_FACING as any, { mapGrid: { game_id: 1, tiles } as any, q: hex.q, r: hex.r, era: next } as any);
    for (const placement of allowed) {
      if (TILE_CATALOG_BY_ID.get(placement.tile_id)?.color !== next) continue;
      const fromKey = from.kind === "tile" ? `${from.tileId}` : `printed:${label}`;
      const key = `${fromKey}->${placement.tile_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ label, from, to: { tileId: placement.tile_id, orientation: placement.orientation } });
      walk(label, { kind: "tile", tileId: placement.tile_id, orientation: placement.orientation }, TIERS.indexOf(next), depth + 1);
    }
  };
  for (const label of ["H10", "I15", "E23", "G19", "E11", "G7", "E7", "D10", "B20", "F20"]) {
    const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
    if (!hex) continue;
    walk(label, { kind: "printed", label }, hex.printedColor === "Yellow" ? 0 : -1, 0);
  }
  return pairs;
}

function canvasFor(size: number, dpr: number) {
  const side = Math.ceil(size * 2.3);
  const canvas = document.createElement("canvas");
  canvas.width = side * dpr;
  canvas.height = side * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, side, side);
  return { canvas, ctx, center: { x: side / 2, y: side / 2 } };
}

/** HexGridRenderer.tsx's per-tile loop body for a laid, catalogued tile. */
function staticPass(tileId: number, orientation: number, size: number, dpr: number) {
  const { canvas, ctx, center } = canvasFor(size, dpr);
  const catalogEntry = TILE_CATALOG_BY_ID.get(tileId)!;
  drawHexPath(ctx, center, size);
  ctx.fillStyle = catalogEntry ? ERA_TILE_FILL[catalogEntry.color] : "#dddddd";
  ctx.fill();
  ctx.strokeStyle = catalogEntry ? COLOR_TIER_STROKE[catalogEntry.color] : "#9a9a9a";
  ctx.lineWidth = 2;
  ctx.stroke();
  withHexClip(ctx, center, size, () => {
    drawTrackPath(ctx, center, size, catalogEntry, orientation, false, undefined, false);
  });
  return canvas;
}

/** HexGridRenderer.tsx's staged-frame branch. */
function framePass(frame: TileTransitionFrame, size: number, dpr: number, rimDash?: number[]) {
  const { canvas, ctx, center } = canvasFor(size, dpr);
  drawTileTransitionFill(ctx, center, size, frame, rimDash ? { rimDash } : {});
  withHexClip(ctx, center, size, () => drawTileTransitionArt(ctx, center, size, frame));
  return canvas;
}

function diff(a: HTMLCanvasElement, b: HTMLCanvasElement) {
  const da = a.getContext("2d")!.getImageData(0, 0, a.width, a.height).data;
  const db = b.getContext("2d")!.getImageData(0, 0, b.width, b.height).data;
  let any = 0, over8 = 0, over32 = 0, over96 = 0, max = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    if (d > 0) any++;
    if (d > 8) over8++;
    if (d > 32) over32++;
    if (d > 96) over96++;
    if (d > max) max = d;
  }
  return { pixels: da.length / 4, any, over8, over32, over96, max };
}

/** static | frame | |diff| x4, side by side, for the montage. */
function triptych(a: HTMLCanvasElement, b: HTMLCanvasElement, label: string) {
  const w = a.width, h = a.height;
  const out = document.createElement("canvas");
  out.width = w * 3 + 8;
  out.height = h + 16;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(a, 0, 16);
  ctx.drawImage(b, w + 4, 16);
  const ia = a.getContext("2d")!.getImageData(0, 0, w, h);
  const ib = b.getContext("2d")!.getImageData(0, 0, w, h);
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < ia.data.length; i += 4) {
    for (let c = 0; c < 3; c++) id.data[i + c] = Math.min(255, Math.abs(ia.data[i + c] - ib.data[i + c]) * 4);
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, w * 2 + 8, 16);
  ctx.fillStyle = "#ddd";
  ctx.font = "11px sans-serif";
  ctx.fillText(label, 2, 12);
  return out;
}

const CONFIGS = [
  { size: 40, dpr: 1 },
  { size: 64, dpr: 2 },
];

function run() {
  const pairs = collectPairs();
  const rows: any[] = [];
  const montages: Record<string, string> = {};
  const worst: Array<{ score: number; tri: HTMLCanvasElement }> = [];
  const proposalWorst: Array<{ score: number; tri: HTMLCanvasElement }> = [];
  const firstWorst: Array<{ score: number; tri: HTMLCanvasElement }> = [];
  for (const { size, dpr } of CONFIGS) {
    for (const pair of pairs) {
      const plan = planTileTransition({ from: pair.from, to: pair.to });
      if (!plan) { rows.push({ ...pair, size, dpr, plan: false }); continue; }
      const lastT = 1 - 16.7 / plan.durationMs;
      const toStatic = staticPass(pair.to.tileId, pair.to.orientation, size, dpr);
      const row: any = {
        key: `${pair.from.kind === "tile" ? pair.from.tileId : "printed:" + pair.label}->${pair.to.tileId}`,
        label: pair.label, size, dpr, durationMs: plan.durationMs,
        last_t1: diff(framePass(sampleTileTransition(plan, 1), size, dpr), toStatic),
        last_drawn: diff(framePass(sampleTileTransition(plan, lastT), size, dpr), toStatic),
      };
      if (pair.from.kind === "tile") {
        const fromStatic = staticPass(pair.from.tileId, pair.from.orientation, size, dpr);
        const firstFrame = framePass(sampleTileTransition(plan, 0), size, dpr);
        row.first_t0 = diff(firstFrame, fromStatic);
        const score = row.first_t0.over32;
        if (size === 64) firstWorst.push({ score, tri: triptych(fromStatic, firstFrame, `${row.key} first frame vs old tile pass (static | frame | diff x4)`) });
      }
      const lastFrame = framePass(sampleTileTransition(plan, 1), size, dpr);
      if (size === 64) worst.push({ score: row.last_t1.over32, tri: triptych(toStatic, lastFrame, `${row.key} last frame (t=1) vs new tile pass`) });
      // Confirmed proposal: its plan's first frame against the proposal drawn on the hex (dashed rim while proposed,
      // solid once sent -- compared solid to solid here, since the dash is the one intended difference).
      const provisionalPlan = planTileTransition({ from: pair.from, to: pair.to, provisional: true });
      const proposal = proposedTileFrame(pair.to.tileId, pair.to.orientation);
      if (provisionalPlan && proposal) {
        const proposalCanvas = framePass(proposal, size, dpr);
        const confirmedFirst = framePass(sampleTileTransition(provisionalPlan, 0), size, dpr);
        row.proposal_first_t0 = diff(confirmedFirst, proposalCanvas);
        if (size === 64) proposalWorst.push({ score: row.proposal_first_t0.over32, tri: triptych(proposalCanvas, confirmedFirst, `${row.key} proposal (solid rim) vs confirmed plan t=0`) });
      }
      rows.push(row);
    }
  }
  const montage = (chosen: Array<{ tri: HTMLCanvasElement }>) => {
    const w = Math.max(...chosen.map((c) => c.tri.width));
    const h = chosen.reduce((s, c) => s + c.tri.height + 6, 0);
    const m = document.createElement("canvas");
    m.width = w; m.height = h;
    const mc = m.getContext("2d")!;
    let y = 0;
    for (const c of chosen) { mc.drawImage(c.tri, 0, y); y += c.tri.height + 6; }
    return m.toDataURL("image/png");
  };
  worst.sort((a, b) => b.score - a.score);
  proposalWorst.sort((a, b) => b.score - a.score);
  firstWorst.sort((a, b) => b.score - a.score);
  // Montage at 64px/2x, ranked by >32-delta pixel count: the 2 worst last frames, the 2 worst first frames, then a
  // typical (median) last frame and first frame.
  montages.worstAndTypical = montage([
    ...worst.slice(0, 2), ...firstWorst.slice(0, 2),
    worst[Math.floor(worst.length / 2)], firstWorst[Math.floor(firstWorst.length / 2)],
  ]);
  montages.proposalWorst = montage(proposalWorst.slice(0, 4));
  return { pairs: pairs.length, rows, montages };
}

(window as any).__run = run;
(window as any).__ready = true;
