// VF/D-17 attribution: one Chromium performance trace of the flourish at CPU throttle 4x (dpr 1), summarised
// by where main-thread and raster time goes. The raw trace stays out of git ($W3H_TRACE_DIR).
import { serve, launch, writeJson } from "./lib.mjs";
import { join } from "node:path";
import { readFileSync, statSync, mkdirSync } from "node:fs";

const RATE = Number(process.env.W3H_RATE || 4);
const TRACE_DIR = process.env.W3H_TRACE_DIR || join(process.env.W3H_BUNDLE_DIR || ".", "traces");
mkdirSync(TRACE_DIR, { recursive: true });
const { server, base } = await serve();
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.goto(`${base}/d17.html`);
await page.waitForFunction(() => window.__ready === true);
await page.waitForTimeout(800);
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: RATE });
await page.waitForTimeout(400);
const tracePath = join(TRACE_DIR, `d17_trace_rate${RATE}.json`);
await browser.startTracing(page, { path: tracePath, screenshots: false, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink", "cc", "gpu", "toplevel", "v8"] });
const duration = await page.evaluate(() => window.__meta.flourish.durationMs);
await page.evaluate(() => { performance.mark("w3h-lay"); window.__lay(); });
await page.waitForTimeout(duration + 200);
await browser.stopTracing();
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

const trace = JSON.parse(readFileSync(tracePath, "utf8"));
const events = trace.traceEvents || trace;
const threads = {};
for (const e of events) if (e.ph === "M" && e.name === "thread_name") threads[`${e.pid}:${e.tid}`] = e.args.name;
const mainKey = Object.entries(threads).find(([, n]) => n === "CrRendererMain")?.[0];
const onMain = events.filter((e) => e.ph === "X" && `${e.pid}:${e.tid}` === mainKey);
// Window: from the first main-thread slice after tracing started (the lay is issued immediately) for the
// transition's duration + 100 ms.
const t0 = Math.min(...onMain.map((e) => e.ts));
const t1 = t0 + (duration + 100) * 1000;
const win = onMain.filter((e) => e.ts >= t0 && e.ts <= t1);
const ms = (e) => (e.dur || 0) / 1000;
const per = (name, minMs = 0) => {
  const xs = win.filter((e) => e.name === name).map(ms).filter((d) => d > minMs).sort((a, b) => a - b);
  if (!xs.length) return null;
  return { count: xs.length, totalMs: +xs.reduce((a, b) => a + b, 0).toFixed(1), median: +xs[Math.floor(xs.length / 2)].toFixed(1), max: +xs[xs.length - 1].toFixed(1) };
};
const summary = {
  rate: RATE, dpr: 1, windowMs: duration + 100,
  traceFile: `(not committed) ${tracePath.split("/").pop()}`, traceBytes: statSync(tracePath).size,
  perFrame: {
    beginMainFrame: per("ProxyMain::BeginMainFrame"),
    fireAnimationFrame: per("FireAnimationFrame"),
    jsFunctionCallOver1ms: per("FunctionCall", 1),
    canvasFinalizeFrame: per("CanvasRenderingContext2D::FinalizeFrame", 1),
    minorGC: per("MinorGC"),
  },
  note: "Renderer main thread only, wall-clock durations under CDP CPU throttling. FunctionCall = JS (the frame clock's setState, React's render of HexGridRenderer, the board draw issuing canvas commands). CanvasRenderingContext2D::FinalizeFrame = the 2D canvas flushing (rasterising) the frame's recorded draw commands, which runs on the main thread for this software-raster canvas.",
};
writeJson(`d17_trace_summary_rate${RATE}.json`, summary);
console.log(JSON.stringify(summary, null, 1));
await browser.close();
server.close();
