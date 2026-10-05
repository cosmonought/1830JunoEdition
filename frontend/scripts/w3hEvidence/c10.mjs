// VF/C-10 driver: observe the roster row-glide FLIP (useRosterReorderFlip) on a presidency takeover.
// Records, per animation frame, every PRR ownership row's computed transform and layout position;
// a Playwright trace (kept out of git, summarised); and CDP screencast frames across the glide.
import { serve, launch, writeJson, EVIDENCE } from "./lib.mjs";
import { join } from "node:path";
import { writeFileSync, statSync, mkdirSync } from "node:fs";

const TRACE_DIR = process.env.W3H_TRACE_DIR || join(process.env.W3H_BUNDLE_DIR || ".", "traces");
mkdirSync(TRACE_DIR, { recursive: true });
const { server, base } = await serve();
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 880, height: 600 } });
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/c10.html`);
await page.waitForFunction(() => window.__ready === true);
await page.waitForTimeout(300);
const T = await page.evaluate(() => window.__transfer);

const cdp = await context.newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async (f) => {
  frames.push({ ts: f.metadata.timestamp * 1000, data: f.data });
  try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
});
await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
await page.waitForTimeout(300);

const SAMPLE_MS = 900;
const sampling = page.evaluate((ms) => new Promise((done) => {
  const table = document.querySelector('[aria-label="PRR ownership"]');
  const out = [];
  const t0 = performance.now();
  const step = () => {
    const now = performance.now();
    const rows = {};
    table.querySelectorAll("[data-stock-cell]").forEach((cell) => {
      const row = cell.parentElement;
      const cs = getComputedStyle(row);
      rows[cell.getAttribute("data-stock-cell")] = {
        computed: cs.transform,
        inline: row.style.transform,
        transition: row.style.transition,
        offsetTop: row.offsetTop,
        visualTop: +(row.getBoundingClientRect().top - table.getBoundingClientRect().top).toFixed(2),
      };
    });
    out.push({ t: +(now - t0).toFixed(1), wall: performance.timeOrigin + now, rows });
    if (now - t0 < ms) requestAnimationFrame(step); else done(out);
  };
  requestAnimationFrame(step);
}), SAMPLE_MS);
await page.waitForTimeout(30);
const runAt = await page.evaluate(() => { const w = performance.timeOrigin + performance.now(); window.__run(1); return w; });
const samples = await sampling;
await page.waitForTimeout(200);
await cdp.send("Page.stopScreencast");
const tracePath = join(TRACE_DIR, "c10_trace.zip");
await context.tracing.stop({ path: tracePath });

// translateY out of a computed matrix.
const ty = (m) => (m === "none" ? 0 : +m.match(/matrix\(([^)]+)\)/)[1].split(",")[5]);
const holders = Object.keys(samples[0].rows);
const perRow = {};
for (const h of holders) {
  perRow[h] = samples
    .map((s) => ({ t: +(s.wall - runAt).toFixed(1), ty: +ty(s.rows[h].computed).toFixed(2), offsetTop: s.rows[h].offsetTop, visualTop: s.rows[h].visualTop }))
    .filter((x, i, a) => i === 0 || x.ty !== a[i - 1].ty || x.offsetTop !== a[i - 1].offsetTop || i === a.length - 1);
}
const moved = holders.filter((h) => perRow[h].some((x) => x.ty !== 0));
const glide = {};
for (const h of moved) {
  const nonZero = perRow[h].filter((x) => x.ty !== 0);
  glide[h] = {
    startMsAfterRun: nonZero[0].t,
    endMsAfterRun: perRow[h].find((x) => x.t > nonZero[nonZero.length - 1].t)?.t ?? null,
    firstTranslateY: nonZero[0].ty,
    translateYSequence: nonZero.map((x) => x.ty),
    offsetTopBefore: perRow[h][0].offsetTop,
    offsetTopAfter: perRow[h][perRow[h].length - 1].offsetTop,
    visualTopSequence: perRow[h].map((x) => [x.t, x.visualTop]),
    monotonic: nonZero.every((x, i, a) => i === 0 || Math.abs(x.ty) <= Math.abs(a[i - 1].ty) + 0.01),
  };
}

// Pick screencast frames around the REORDER glide (the segment where some row is displaced by >= 2px; a
// sub-pixel layout nudge earlier in the sequence also FLIPs by 1px, which is reported separately).
const big = samples.filter((s) => Object.values(s.rows).some((r) => Math.abs(ty(r.computed)) >= 2));
const gs = big.length ? big[0].wall : runAt;
const ge = big.length ? big[big.length - 1].wall + 17 : runAt + 600;
const pick = [];
const before = frames.filter((f) => f.ts < gs - 2).pop();
const inside = frames.filter((f) => f.ts >= gs && f.ts <= ge);
if (before) pick.push(["before", before]);
if (inside.length) pick.push(["early", inside[Math.floor(inside.length / 4)]]);
if (inside.length > 1) pick.push(["late", inside[Math.floor((inside.length * 3) / 4)]]);
const shots = [];
pick.forEach(([label, f], i) => {
  const name = `c10_glide_${i + 1}_${label}.png`;
  writeFileSync(join(EVIDENCE, name), Buffer.from(f.data, "base64"));
  shots.push({ file: `docs/phase3/evidence/w3h/${name}`, msAfterRun: +(f.ts - runAt).toFixed(1) });
});
// The screencast stops emitting once nothing changes, so the settled frame is a plain screenshot.
{
  const name = `c10_glide_${pick.length + 1}_after.png`;
  await page.screenshot({ path: join(EVIDENCE, name) });
  shots.push({ file: `docs/phase3/evidence/w3h/${name}`, msAfterRun: "settled (screenshot taken after sampling)" });
}
const reorderGlide = { startMsAfterRun: +(gs - runAt).toFixed(1), lastDisplacedFrameMsAfterRun: +(ge - 17 - runAt).toFixed(1), framesDisplaced: big.length };

const result = {
  row: "VF/C-10",
  date: "2026-10-04",
  browser: browser.version(),
  fixture: "stockCardFocus.test.tsx 'a buy that takes the presidency' + CAROL 10% bystander",
  constants: { TRANSFER_RESOLVE_AT_MS: T.TRANSFER_RESOLVE_AT_MS, HANDOVER_AT_MS: T.HANDOVER_AT_MS, HANDOVER_MS: T.HANDOVER_MS, PRESIDENCY_MS: T.PRESIDENCY_MS },
  rafSamples: samples.length,
  meanFrameMs: +((samples[samples.length - 1].t - samples[0].t) / (samples.length - 1)).toFixed(2),
  holders,
  movedRows: moved,
  glide,
  reorderGlide,
  screencastFrames: frames.length,
  screencastFramesInsideGlide: inside.length,
  screenshots: shots,
  presidencyCues: await page.evaluate(() => window.__cues ?? 0),
  trace: { file: "(not committed) c10_trace.zip", bytes: statSync(tracePath).size, contents: "Playwright trace: screencast + DOM snapshots across the run; rerun c10.mjs to regenerate (W3H_TRACE_DIR)." },
  pageErrors: errors,
};
writeJson("c10_row_glide.json", result);
console.log(JSON.stringify({ ...result, glide: Object.fromEntries(Object.entries(glide).map(([k, v]) => [k, { ...v, visualTopSequence: undefined }])) }, null, 1));
await browser.close();
server.close();
