# W3-H real-browser evidence harness

Evidence-only tooling for Phase 3 slice W3-H (`VISUAL_FLOURISH_BACKLOG.md` rows K-4, E-5, C-10, D-16,
D-17). Nothing here is part of the product build:

- it lives outside `frontend/src`, so `tsc` (`include: ["src"]`) and the react-scripts Jest runner
  (`src/**`) never see it, and no file is named `*.test.*`;
- entries import the **real** components/modules from `frontend/src` and mount them with fixtures; no
  product source is modified.

## Layout

| File | Purpose |
| --- | --- |
| `build.mjs` | Bundles every `entries/*.tsx` with esbuild into an output dir (`<name>.js` + `<name>.html`). |
| `lib.mjs` | Static server over the bundle dir, Chromium launcher, JSON writer, frame-time stats. |
| `entries/<row>.tsx` | One page per backlog row, mounting real components with fixtures. |
| `<row>.mjs` | Playwright driver for that row: screenshots + measurements into `docs/phase3/evidence/w3h/`. |

## Rerun

esbuild and Playwright are not frontend dependencies; install them in any scratch directory.

```sh
SCRATCH=/some/scratch
(cd $SCRATCH && npm init -y && npm i esbuild playwright)
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers      # or wherever Chromium is installed
export PLAYWRIGHT_MODULE=$SCRATCH/node_modules/playwright
export W3H_BUNDLE_DIR=$SCRATCH/out

cd frontend/scripts/w3hEvidence
ESBUILD=$SCRATCH/node_modules/esbuild node build.mjs $W3H_BUNDLE_DIR
node k4.mjs     # VF/K-4  fallback capacity glyph
```

Each driver overwrites its own PNG/JSON files under `docs/phase3/evidence/w3h/`. The JSON records the
browser version, page errors, and every number quoted in the backlog ledger.
