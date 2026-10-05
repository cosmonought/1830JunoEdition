// VF/K-4 driver: screenshot the fallback capacity glyph beside 4->3 and the rust mark.
import { serve, launch, writeJson, EVIDENCE } from "./lib.mjs";
import { join } from "node:path";

const { server, base } = await serve();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/k4.html`);
await page.waitForFunction(() => window.__ready === true);
await page.waitForTimeout(200);
await page.locator("#root > div").screenshot({ path: join(EVIDENCE, "k4_capacity_marks.png") });

// Measure every mark: the rendered box of the svg/span and its label's font size.
const measurements = await page.evaluate(() =>
  [...document.querySelectorAll("section")].map((section) => {
    const out = { scale: Number(section.dataset.scale), mode: section.dataset.mode, marks: {} };
    for (const badge of section.querySelectorAll("span[data-mark]")) {
      if (out.marks[badge.dataset.mark]) continue;
      const mark = badge.firstElementChild;
      const r = mark.getBoundingClientRect();
      const br = badge.getBoundingClientRect();
      out.marks[badge.dataset.mark] = {
        element: mark.tagName.toLowerCase(),
        markCssPx: { w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        badgeCssPx: { w: +br.width.toFixed(2), h: +br.height.toFixed(2) },
        labelFontSize: getComputedStyle(badge).fontSize,
        // For the fallback: the svg holds exactly the ceiling + arrow paths, no text/numbers.
        svgPaths: mark.tagName === "svg" ? mark.querySelectorAll("path").length : null,
        textContent: mark.textContent,
      };
    }
    return out;
  }),
);
writeJson("k4_capacity_marks.json", {
  row: "VF/K-4",
  date: "2026-10-04",
  browser: browser.version(),
  deviceScaleFactor: 2,
  screenshots: ["docs/phase3/evidence/w3h/k4_capacity_marks.png", "docs/phase3/evidence/w3h/k4_scale063_dsf1.png", "docs/phase3/evidence/w3h/k4_scale063_dsf4.png"],
  note: "Product capsule styles (styles.phaseShiftBadge + Warn/Critical, pulse animation disabled for a stable frame). 'zoom' rows use chromeZoomFor(scale) (the product mechanism); 'font' rows scale the 11px label font-size instead. Rendered sizes for zoom mode are pre-zoom CSS px multiplied by the zoom in getBoundingClientRect.",
  pageErrors: errors,
  measurements,
});
console.log(JSON.stringify(measurements, null, 1), errors);
// Close-ups of the smallest (0.63) row: at deviceScaleFactor 1 (what a 1x display actually rasterises,
// ~8 device px per mark) and at 4 (to see the glyph's shape).
for (const dsf of [1, 4]) {
  const p2 = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: dsf });
  await p2.goto(`${base}/k4.html`);
  await p2.waitForFunction(() => window.__ready === true);
  await p2.locator('section[data-mode="zoom"][data-scale="0.63"]').screenshot({ path: join(EVIDENCE, `k4_scale063_dsf${dsf}.png`) });
  await p2.close();
}
await browser.close();
server.close();
