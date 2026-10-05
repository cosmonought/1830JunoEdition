// Shared helpers for the W3-H evidence drivers: a tiny static server over the bundle dir and a
// Chromium launcher. Playwright is resolved from $PLAYWRIGHT_MODULE (absolute path to the
// `playwright` package dir) or normal module resolution.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright");
export const OUT = resolve(process.env.W3H_BUNDLE_DIR || join(here, ".out"));
export const EVIDENCE = resolve(here, "../../../docs/phase3/evidence/w3h");
mkdirSync(EVIDENCE, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

export function serve() {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const path = join(OUT, decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!existsSync(path)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
      res.end(readFileSync(path));
    });
    server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

export async function launch() {
  return playwright.chromium.launch({ headless: true });
}

export function writeJson(name, data) {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(data, null, 2) + "\n");
}

export function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return {
    n: s.length,
    min: +s[0].toFixed(2),
    median: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
  };
}
