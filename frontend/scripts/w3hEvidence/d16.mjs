// VF/D-16 driver: pixel-level hand-over of the tile flourish (first/last frames vs the static tile pass).
import { serve, launch, writeJson, EVIDENCE, stats } from "./lib.mjs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const { server, base } = await serve();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/d16.html`);
await page.waitForFunction(() => window.__ready === true);
const out = await page.evaluate(() => window.__run());
writeFileSync(join(EVIDENCE, "d16_handover_montage.png"), Buffer.from(out.montages.worstAndTypical.split(",")[1], "base64"));
writeFileSync(join(EVIDENCE, "d16_proposal_montage.png"), Buffer.from(out.montages.proposalWorst.split(",")[1], "base64"));

const summary = {};
for (const cfg of ["40@1x", "64@2x"]) {
  const [size, dpr] = cfg.split("@").map((s) => parseInt(s, 10));
  const rows = out.rows.filter((r) => r.size === size && r.dpr === dpr && r.last_t1);
  const block = {};
  for (const metric of ["first_t0", "last_drawn", "last_t1", "proposal_first_t0"]) {
    const vals = rows.filter((r) => r[metric]).map((r) => r[metric]);
    if (!vals.length) continue;
    block[metric] = {
      transitions: vals.length,
      identical: vals.filter((v) => v.any === 0).length,
      maxChannelDelta: stats(vals.map((v) => v.max)),
      pixelsAnyDelta: stats(vals.map((v) => v.any)),
      pixelsDeltaOver8: stats(vals.map((v) => v.over8)),
      pixelsDeltaOver32: stats(vals.map((v) => v.over32)),
      pixelsDeltaOver96: stats(vals.map((v) => v.over96)),
      canvasPixels: vals[0].pixels,
      worst: rows.filter((r) => r[metric]).sort((a, b) => b[metric].over32 - a[metric].over32).slice(0, 5).map((r) => ({ key: r.key, label: r.label, ...r[metric] })),
    };
  }
  summary[cfg] = block;
}
const result = {
  row: "VF/D-16",
  date: "2026-10-04",
  browser: browser.version(),
  method: "Static tile pass copied from HexGridRenderer.tsx's per-tile loop vs drawTileTransitionFill + withHexClip(drawTileTransitionArt) on the same canvas size; background #1e1f24; per-pixel max RGB channel delta. last_drawn = the last frame the board's clock can paint before t >= 1 hands over (t = 1 - 16.7 ms / durationMs). Pairs = tileTransition.test.ts's walk (standard rules, 10 city/town labels, one accepted facing per distinct pair).",
  pairs: out.pairs,
  proposalMontage: "docs/phase3/evidence/w3h/d16_proposal_montage.png (proposal drawn solid | confirmed plan t=0 | |diff|x4, 4 worst at 64px@2x)",
  summary,
  montage: "docs/phase3/evidence/w3h/d16_handover_montage.png (rows: static | frame | |diff|x4 at 64px@2x: 2 worst last frames, 2 worst first frames by >32-delta pixel count, then a median last and a median first frame)",
  perTransition: out.rows.map((r) => ({ key: r.key, label: r.label, size: r.size, dpr: r.dpr, first_t0: r.first_t0 && [r.first_t0.any, r.first_t0.over32, r.first_t0.max], last_drawn: r.last_drawn && [r.last_drawn.any, r.last_drawn.over32, r.last_drawn.max], last_t1: r.last_t1 && [r.last_t1.any, r.last_t1.over32, r.last_t1.max], proposal_first_t0: r.proposal_first_t0 && [r.proposal_first_t0.any, r.proposal_first_t0.over32, r.proposal_first_t0.max] })),
  perTransitionLegend: "[pixels with any delta, pixels with delta > 32, max channel delta]",
  pageErrors: errors,
};
writeJson("d16_handover_pixels.json", result);
console.log(JSON.stringify({ pairs: out.pairs, summary }, null, 1).slice(0, 9000));
await browser.close();
server.close();
