// W3-H evidence harness bundler. Not part of the product build; see README.md.
//
// Usage: ESBUILD=/path/to/node_modules/esbuild node build.mjs [outDir]
// Bundles every entry in ./entries/*.tsx against the real frontend/src modules and
// frontend/node_modules (React 18), writing <outDir>/<name>.js and <outDir>/<name>.html.
import { createRequire } from "node:module";
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuildPath = process.env.ESBUILD || "esbuild";
const esbuild = require(esbuildPath);
const outDir = resolve(process.argv[2] || join(here, ".out"));
mkdirSync(outDir, { recursive: true });

const entriesDir = join(here, "entries");
const entries = readdirSync(entriesDir).filter((f) => f.endsWith(".tsx"));
for (const file of entries) {
  const name = basename(file, ".tsx");
  await esbuild.build({
    entryPoints: [join(entriesDir, file)],
    bundle: true,
    outfile: join(outDir, `${name}.js`),
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    sourcemap: false,
    define: { "process.env.NODE_ENV": '"development"', global: "window" },
    nodePaths: [resolve(here, "../../node_modules")],
    loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "css" },
    logLevel: "warning",
  });
  writeFileSync(
    join(outDir, `${name}.html`),
    `<!doctype html><html><head><meta charset="utf-8"><title>w3h ${name}</title>` +
      `<style>html,body{margin:0;background:#111;color:#eee;font-family:system-ui,sans-serif}</style>` +
      `</head><body><div id="root"></div><script src="${name}.js"></script></body></html>\n`,
  );
  console.log(`built ${name}`);
}
