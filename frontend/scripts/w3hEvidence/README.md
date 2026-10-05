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
| `fixtures.ts` | Shared corporation fixtures (shape of `stockCardFocus.test.tsx`). |
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
node e5.mjs     # VF/E-5  float card vs sticky dock stacking (+ ref-cycle defect check)
node c10.mjs    # VF/C-10 roster row-glide FLIP, per-frame transforms (trace -> $W3H_TRACE_DIR, not committed)
node d16.mjs    # VF/D-16 tile flourish first/last frame vs static tile pass, pixel diffs
node d17.mjs    # VF/D-17 board frame times during a lay flourish, CPU throttle 1/4/6, DPR 1/2 (~1 min)
W3H_RATE=4 node d17trace.mjs   # VF/D-17 Chromium trace summary (raw trace -> $W3H_TRACE_DIR, not committed)
```

Each driver overwrites its own PNG/JSON files under `docs/phase3/evidence/w3h/`. The JSON records the
browser version, page errors, and every number quoted in the backlog ledger.

## Notes

- `d17.mjs` patches `CanvasRenderingContext2D.prototype.clearRect`/`restore` **inside the harness page only**
  (`entries/d17.tsx`) to count whole-board repaints and time them; the product is not modified.
- Traces (`c10_trace.zip`, `d17_trace_rate*.json`) exceed 1 MB and are not committed; the drivers write their
  summaries into the evidence JSON. Set `W3H_TRACE_DIR` to keep them somewhere specific.
- Absolute timings are the host's. The W3-H evidence was captured in headless Chromium 1243 with software
  raster on a container, which is not a low-end device.
