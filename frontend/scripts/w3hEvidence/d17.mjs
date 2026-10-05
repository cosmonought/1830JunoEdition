// VF/D-17 driver: frame times of the real HexGridRenderer while a lay flourish repaints the whole board, under
// CDP CPU throttling (rates 1, 4, 6) at devicePixelRatio 1 and 2. rAF deltas over the flourish, plus an idle
// window on the same page for comparison, whole-board repaint counts, and Long Animation Frame entries.
import { serve, launch, writeJson, stats } from "./lib.mjs";

const REFRESH_MS = 1000 / 60;
const CONFIGS = [
  { rate: 1, dpr: 1 }, { rate: 4, dpr: 1 }, { rate: 6, dpr: 1 },
  { rate: 1, dpr: 2 }, { rate: 4, dpr: 2 }, { rate: 6, dpr: 2 },
];
const REPS = 2;
const { server, base } = await serve();
const browser = await launch();

function frameStats(deltas) {
  const s = stats(deltas);
  const late = deltas.filter((d) => d > REFRESH_MS * 1.5);
  const dropped = deltas.reduce((n, d) => n + Math.max(0, Math.round(d / REFRESH_MS) - 1), 0);
  return { ...s, framesOver25ms: late.length, droppedFrames: dropped, effectiveFps: +(1000 / s.mean).toFixed(1) };
}

async function runOnce({ rate, dpr }) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/d17.html`);
  await page.waitForFunction(() => window.__ready === true);
  await page.waitForTimeout(800);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await page.waitForTimeout(500);
  const meta = await page.evaluate(() => window.__meta);
  const window_ = meta.flourish.durationMs + 150;
  const measured = await page.evaluate((ms) => new Promise((done) => {
    const loaf = [];
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => list.getEntries().forEach((e) => loaf.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration })));
      observer.observe({ type: "long-animation-frame", buffered: false });
    } catch {}
    const sampleFor = (duration, onStart) => new Promise((ok) => {
      const stamps = [];
      let t0 = null;
      const step = (now) => {
        if (t0 === null) { t0 = now; onStart?.(); }
        stamps.push(now);
        if (now - t0 < duration) requestAnimationFrame(step); else ok(stamps);
      };
      requestAnimationFrame(step);
    });
    (async () => {
      const r0 = window.__boardRepaints;
      const idle = await sampleFor(ms);
      const r1 = window.__boardRepaints;
      window.__repaintMs = [];
      let layAt = 0;
      const flourish = await sampleFor(ms, () => { layAt = performance.now(); window.__lay(); });
      const r2 = window.__boardRepaints;
      observer?.disconnect();
      const canvas = document.querySelector("canvas");
      done({
        idle, flourish, layAt,
        repaintsIdle: r1 - r0, repaintsFlourish: r2 - r1,
        repaintMs: window.__repaintMs.slice(),
        canvas: [canvas.width, canvas.height],
        loaf: loaf.filter((e) => e.start >= layAt),
      });
    })();
  }), window_);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await context.close();
  const deltas = (stamps) => stamps.slice(1).map((t, i) => t - stamps[i]);
  const fl = deltas(measured.flourish);
  return {
    rate, dpr, canvasBackingPx: measured.canvas, meta,
    idle: frameStats(deltas(measured.idle)),
    flourish: frameStats(fl),
    flourishExcludingTriggerFrame: frameStats(fl.slice(1)),
    triggerFrameMs: +fl[0].toFixed(2),
    repaintsIdle: measured.repaintsIdle,
    repaintsFlourish: measured.repaintsFlourish,
    boardRepaintJsMs: measured.repaintMs.length ? stats(measured.repaintMs) : null,
    rawRepaintJsMs: measured.repaintMs.map((d) => +d.toFixed(1)),
    longAnimationFrames: {
      count: measured.loaf.length,
      maxDurationMs: measured.loaf.length ? +Math.max(...measured.loaf.map((e) => e.duration)).toFixed(1) : 0,
      totalBlockingMs: +measured.loaf.reduce((s, e) => s + (e.blocking || 0), 0).toFixed(1),
    },
    rawFlourishDeltasMs: fl.map((d) => +d.toFixed(1)),
    pageErrors: errors,
  };
}

const runs = [];
for (const cfg of CONFIGS) for (let rep = 0; rep < REPS; rep++) {
  const r = await runOnce(cfg);
  runs.push({ rep, ...r });
  console.log(`rate ${cfg.rate} dpr ${cfg.dpr} rep ${rep}: flourish median ${r.flourish.median} p95 ${r.flourish.p95} max ${r.flourish.max} dropped ${r.flourish.droppedFrames} (idle median ${r.idle.median}, p95 ${r.idle.p95}); repaints ${r.repaintsFlourish}; repaint JS median ${r.boardRepaintJsMs?.median} max ${r.boardRepaintJsMs?.max}; LoAF ${r.longAnimationFrames.count}`);
}
const pooled = CONFIGS.map((cfg) => {
  const mine = runs.filter((r) => r.rate === cfg.rate && r.dpr === cfg.dpr);
  return {
    ...cfg,
    flourish: frameStats(mine.flatMap((r) => r.rawFlourishDeltasMs)),
    flourishExcludingTriggerFrame: frameStats(mine.flatMap((r) => r.rawFlourishDeltasMs.slice(1))),
    triggerFrameMs: mine.map((r) => r.triggerFrameMs),
    idleMedianMs: mine.map((r) => r.idle.median),
    repaintsFlourish: mine.map((r) => r.repaintsFlourish),
    boardRepaintJsMs: stats(mine.flatMap((r) => r.rawRepaintJsMs)),
  };
});
writeJson("d17_flourish_frame_times.json", {
  row: "VF/D-17",
  date: "2026-10-04",
  browser: browser.version(),
  host: "headless Chromium on the W3-H container (software raster, no GPU); CPU throttle via CDP Emulation.setCPUThrottlingRate. Absolute numbers depend on the host; the throttled rates approximate a low-end device, they are not one.",
  board: "standard board, initialGridFor + accepted yellow lays (see meta.laid), viewport 1366x900; flourish = real HexGridRenderer transition started by a mapGrid change (see meta.flourish)",
  method: "rAF timestamps for durationMs+150 ms from the frame that applies the lay; an idle window of the same length on the same page first. droppedFrames = sum(round(delta/16.67)-1). Trigger frame = the rAF delta right after the frame that calls the lay. boardRepaintJsMs = time from the board's full clearRect to its last restore() (JS cost of issuing one whole-board repaint; raster may be deferred, so a lower bound).",
  pooled,
  runs,
});
await browser.close();
server.close();
