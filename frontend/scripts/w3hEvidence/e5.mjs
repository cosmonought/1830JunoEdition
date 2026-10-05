// VF/E-5 driver: does the VF-3 lifted float card settle behind the sticky action dock (zIndex 50)?
//
// A. Full motion, real product path: trigger the float on a bottom-row card of a scrolled roster and sample
//    every animation frame for the card's transform / stamp / flip. (Checks the reported ref defect.)
// B. Reduced motion, real product path: the reduced ceremony's own transform (inner scale 1.12) on a card
//    whose top edge is tucked under the dock; elementFromPoint across the overlap.
// C. Synthetic lift: the exact transform/transition/zIndex StockRoundPanel would apply in full motion
//    (same dx/dy/scale formula as useFloatCardTarget), applied by the harness to the real card element,
//    because path A cannot reach it. elementFromPoint across the dock/card overlap mid-lift and at rest.
import { serve, launch, writeJson, EVIDENCE } from "./lib.mjs";
import { join } from "node:path";

const TARGET = "B&O"; // bottom-left card in the opening (spectrum) order
const { server, base } = await serve();
const browser = await launch();
const result = { row: "VF/E-5", date: "2026-10-04", browser: browser.version(), viewport: "1280x720", target: TARGET };

async function open(reduced) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${base}/e5.html`);
  await page.waitForFunction(() => window.__ready === true);
  await page.waitForTimeout(300);
  return { page, errors };
}

const geometry = (page) =>
  page.evaluate((ticker) => {
    const card = document.querySelector(`[aria-label="${ticker} ownership"]`).closest(".app-stock-card");
    const grid = card.parentElement;
    const dock = document.querySelector('[data-sticky-dock="true"]');
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return { card: r(card), grid: r(grid), dock: r(dock), scrollY: window.scrollY };
  }, TARGET);

// Hit-test a grid of points in the intersection of the dock's rect and the card's current (transformed)
// rect. Returns how many land in the dock vs in the card.
const hitTest = (page) =>
  page.evaluate((ticker) => {
    const card = document.querySelector(`[aria-label="${ticker} ownership"]`).closest(".app-stock-card");
    const dock = document.querySelector('[data-sticky-dock="true"]');
    const c = card.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    const x0 = Math.max(c.left, d.left) + 2, x1 = Math.min(c.right, d.right) - 2;
    const y0 = Math.max(c.top, d.top, 0) + 2, y1 = Math.min(c.bottom, d.bottom) - 2;
    const out = { overlap: { x0, x1, y0, y1 }, points: 0, dock: 0, card: 0, other: 0, samples: [] };
    if (x1 <= x0 || y1 <= y0) return { ...out, note: "no overlap" };
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 3; j++) {
      const x = x0 + ((x1 - x0) * i) / 8, y = y0 + ((y1 - y0) * j) / 3;
      const el = document.elementFromPoint(x, y);
      out.points++;
      const who = dock.contains(el) ? "dock" : card.contains(el) ? "card" : "other";
      out[who]++;
      if (out.samples.length < 4) out.samples.push({ x: Math.round(x), y: Math.round(y), hit: who, tag: el?.tagName });
    }
    // Control: a point inside the card but below the dock -- must be the card (it overlays its siblings).
    const cx = (c.left + c.right) / 2, cy = Math.min(c.bottom - 4, d.bottom + 30);
    const ctl = document.elementFromPoint(cx, cy);
    out.controlBelowDock = { x: Math.round(cx), y: Math.round(cy), hit: dock.contains(ctl) ? "dock" : card.contains(ctl) ? "card" : "other" };
    return out;
  }, TARGET);

// rAF sampler for the card over `ms`.
const sample = (page, ms) =>
  page.evaluate(([ticker, ms]) => new Promise((done) => {
    const card = document.querySelector(`[aria-label="${ticker} ownership"]`).closest(".app-stock-card");
    const t0 = performance.now();
    const frames = [];
    const step = () => {
      const t = performance.now() - t0;
      const inner = card.firstElementChild;
      frames.push({
        t: Math.round(t),
        cardTransform: getComputedStyle(card).transform,
        cardZ: getComputedStyle(card).zIndex,
        innerTransform: inner ? getComputedStyle(inner).transform : null,
        stamp: !!card.querySelector(".app-float-stamp"),
        flip: !!card.querySelector(".app-float-flip"),
        muted: !!card.querySelector('[style*="saturate"]'),
        top: Math.round(card.getBoundingClientRect().top),
      });
      if (t < ms) requestAnimationFrame(step); else done(frames);
    };
    requestAnimationFrame(step);
  }), [TARGET, ms]);

const summarise = (frames) => ({
  frames: frames.length,
  anyCardTransform: frames.some((f) => f.cardTransform !== "none"),
  anyStamp: frames.some((f) => f.stamp),
  anyFlip: frames.some((f) => f.flip),
  anyMuted: frames.some((f) => f.muted),
  distinctInnerTransforms: [...new Set(frames.map((f) => f.innerTransform))].slice(0, 6),
  distinctCardZ: [...new Set(frames.map((f) => f.cardZ))],
});

// ---------- A. full motion, real product ----------
{
  const { page, errors } = await open(false);
  const c = await page.evaluate(() => window.__floatConstants);
  let g = await geometry(page);
  const gridCentrePageY = g.grid.y + g.scrollY + g.grid.h / 2;
  const scrollTo = Math.round(gridCentrePageY - (g.dock.y + g.dock.h / 2)); // grid centre behind the dock
  await page.evaluate((y) => window.scrollTo(0, y), scrollTo);
  await page.waitForTimeout(100);
  g = await geometry(page);
  const sampling = sample(page, c.FLOAT_TOTAL_MS + 100);
  await page.evaluate(() => window.__float(4, 1));
  await page.waitForTimeout(Math.round(c.FLOAT_LIFT_MS / 2));
  // W3-H (after the ref-cycle fix, 4c89333): the REAL lifted card, hit-tested against the dock mid-lift and
  // once it has settled at the centre (the stamp beat), which is the question E-5 asks.
  const realMidLift = await hitTest(page);
  await page.screenshot({ path: join(EVIDENCE, "e5_fullmotion_midlift.png") });
  await page.waitForTimeout(Math.round(c.FLOAT_LIFT_MS / 2) + 120);
  const realLifted = await hitTest(page);
  await page.screenshot({ path: join(EVIDENCE, "e5_fullmotion_lifted.png") });
  const frames = await sampling;
  result.fullMotion = {
    hitTestMidLift: realMidLift,
    hitTestLifted: realLifted,
    scrollY: scrollTo,
    geometryBefore: g,
    constants: { FLOAT_LIFT_MS: c.FLOAT_LIFT_MS, FLOAT_TOTAL_MS: c.FLOAT_TOTAL_MS, FLOAT_SCALE: c.FLOAT_SCALE },
    summary: summarise(frames),
    floatCuesFired: await page.evaluate(() => window.__cues ?? 0),
    firstFrames: frames.slice(0, 3),
    pageErrors: errors,
    screenshots: ["docs/phase3/evidence/w3h/e5_fullmotion_midlift.png", "docs/phase3/evidence/w3h/e5_fullmotion_lifted.png"],
  };
  await page.close();
}

// ---------- B. reduced motion, real product ----------
{
  const { page, errors } = await open(true);
  const c = await page.evaluate(() => window.__floatConstants);
  let g = await geometry(page);
  // Tuck the card's top 20px under the dock.
  const scrollTo = Math.round(g.card.y + g.scrollY - (g.dock.y + g.dock.h - 20));
  await page.evaluate((y) => window.scrollTo(0, y), scrollTo);
  await page.waitForTimeout(100);
  const sampling = sample(page, c.FLOAT_REDUCED_TOTAL_MS + 100);
  await page.evaluate(() => window.__float(4, 2));
  await page.waitForTimeout(c.FLOAT_REDUCED_STAMP_AT_MS + 120);
  await page.screenshot({ path: join(EVIDENCE, "e5_reduced_stamp_under_dock.png") });
  const hits = await hitTest(page);
  const frames = await sampling;
  result.reducedMotion = {
    scrollY: scrollTo,
    summary: summarise(frames),
    hitTestAtStamp: hits,
    floatCuesFired: await page.evaluate(() => window.__cues ?? 0),
    pageErrors: errors,
    screenshot: "docs/phase3/evidence/w3h/e5_reduced_stamp_under_dock.png",
  };
  await page.close();
}

// ---------- C. synthetic lift (product transform, applied by the harness) ----------
{
  const { page, errors } = await open(false);
  const c = await page.evaluate(() => window.__floatConstants);
  let g = await geometry(page);
  const gridCentrePageY = g.grid.y + g.scrollY + g.grid.h / 2;
  const scrollTo = Math.round(gridCentrePageY - (g.dock.y + g.dock.h / 2));
  await page.evaluate((y) => window.scrollTo(0, y), scrollTo);
  await page.waitForTimeout(100);
  // useFloatCardTarget's formula, verbatim in effect: dx/dy centre-to-centre, scale clamped to 92% of grid width.
  const target = await page.evaluate(([ticker, FLOAT_SCALE, liftMs]) => {
    const card = document.querySelector(`[aria-label="${ticker} ownership"]`).closest(".app-stock-card");
    const grid = card.parentElement;
    const cr = card.getBoundingClientRect(), gr = grid.getBoundingClientRect();
    const dx = gr.left + gr.width / 2 - (cr.left + cr.width / 2);
    const dy = gr.top + gr.height / 2 - (cr.top + cr.height / 2);
    const scale = Math.min(FLOAT_SCALE, Math.max(1, (gr.width * 0.92) / cr.width));
    card.style.transform = "translate(0px, 0px) scale(1)";
    void card.offsetWidth;
    card.style.transition = `transform ${liftMs}ms ease-out`;
    card.style.zIndex = "5";
    card.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    return { dx, dy, scale };
  }, [TARGET, c.FLOAT_SCALE, c.FLOAT_LIFT_MS]);
  await page.waitForTimeout(Math.round(c.FLOAT_LIFT_MS / 2));
  await page.screenshot({ path: join(EVIDENCE, "e5_synthetic_midlift.png") });
  const mid = await hitTest(page);
  await page.waitForTimeout(c.FLOAT_LIFT_MS);
  await page.screenshot({ path: join(EVIDENCE, "e5_synthetic_lifted.png") });
  const rest = await hitTest(page);
  const transform = await page.evaluate((ticker) => getComputedStyle(document.querySelector(`[aria-label="${ticker} ownership"]`).closest(".app-stock-card")).transform, TARGET);
  result.syntheticLift = {
    scrollY: scrollTo,
    target,
    computedTransformAtRest: transform,
    hitTestMidLift: mid,
    hitTestLifted: rest,
    pageErrors: errors,
    screenshots: ["docs/phase3/evidence/w3h/e5_synthetic_midlift.png", "docs/phase3/evidence/w3h/e5_synthetic_lifted.png"],
  };
  await page.close();
}

writeJson("e5_float_stacking.json", result);
console.log(JSON.stringify(result, null, 1).slice(0, 6000));
await browser.close();
server.close();
