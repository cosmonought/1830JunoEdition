# P3-N028 reopened: the homepage tables boundary, before and after

**Owner report (2026-10-06):** "Your Tables" covers the Host / Join Game controls again, at about 300% viewing scale.

**Invariant checked:** the first table-related box ("Your tables", its rows and error, the public list and its loading / empty states) starts at or below the bottom of the Host / Join action region. The script checks this after the page settles and in every frame painted on the way there. Host and Join must also be fully visible and hit-testable.

**Script:** `homepage_tables_boundary.mjs`, in this directory. Full results: `homepage_tables_boundary_results.json`.

## How it was run

- **App:** the real app from a CRA dev server, built with `REACT_APP_GAME_SERVER_URL=wss://game.test/gs` and `REACT_APP_DEV_IDENTITY=0`. The game server is faked at the network edge: the session bootstrap returns signed out or signed in, and the lobby WebSocket answers `rooms-watch` and `room-op my-tables`.
- **Browser:** Chromium 1194, headless, through playwright-core 1.56.
- **Command:** `node docs/phase3/evidence/p3acct/homepage_tables_boundary.mjs --url http://127.0.0.1:3123 --tag <before|after>`. Add `--quick` for a 96-case subset that takes about 2 minutes. The full run takes about 35 minutes.
- **Scenarios:**
  - signed out;
  - signed in with 0, 1 and 14 tables (24 public rooms);
  - loading (neither answer arrives);
  - "Your tables" error;
  - long table metadata;
  - sign-in after render (the socket closes 4401 and the bootstrap now names a profile);
  - font reflow (a 24px default font, then a late text-size injection on the doors and rows);
  - resize cycles;
  - a load at every size.
- **Viewports:**
  - DPR 1: 320x568, 360x740, 375x667, 768x1024, 1024x768, 1366x768, 1440x900, 1920x1080, 1920x600 and 2560x1440.
  - Browser or display zoom 200–300%: 960x540 and 683x384 at DPR 2; 768x432 at DPR 2.5; 640x360, 640x300, 853x480, 455x256 and 1280x650 at DPR 3. The 300% rows are physical windows of 1920x1080, 1920x1000 (window chrome), 2560x1440, 1366x768 and 3840x2160 (display scaling).
  - A 390x844 phone at DPR 3.
- **UI scale:** every step (63, 75, 90, 100, 110 and 125%), in every scenario.
- **Resize after render:** every row except the first in a group is measured after a resize. Each page is loaded at one of the group's sizes, rotating through them, then resized to the others.

## Result

| Scenario | Before (`caad745`) failing / cases | After failing / cases |
|---|---|---|
| signed out | 14 / 114 | 0 / 114 |
| signed in, 0 tables | 16 / 114 | 0 / 114 |
| signed in, 1 table | 17 / 114 | 0 / 114 |
| signed in, many tables | 18 / 114 | 0 / 114 |
| signed in, many tables: resize cycle | 12 / 24 | 0 / 24 |
| loading | 15 / 114 | 0 / 114 |
| "Your tables" error | 18 / 114 | 0 / 114 |
| long table metadata | 14 / 114 | 0 / 114 |
| long table metadata: resize cycle | 11 / 24 | 0 / 24 |
| sign-in after render: signed-out layout | 2 / 24 | 0 / 24 |
| sign-in after render | 10 / 114 | 0 / 114 |
| font reflow | 19 / 114 | 0 / 114 |
| load at size (every size × every UI scale) | 35 / 114 | 0 / 114 |
| **Total** | **201 / 1212** | **0 / 1212** |

| Painted frames | Before | After |
|---|---|---|
| Frames sampled | 35,993 | 36,354 |
| Frames with table content above the doors' foot | 210 | 0 |

**Before, by viewport:**

- The 300% rows at DPR 3 failed 79 of 378 cases:
  - display300 at 1280x650: 33 / 61;
  - zoom300 at 640x300: 12 / 61;
  - zoom300 at 640x360: 9 / 61;
  - zoom300 at 455x256: 6 / 61;
  - phone at 390x844: 7 / 61;
  - zoom300 at 853x480: 2 / 61.
- The resize cycle to 1920x600 failed 12 / 12 at DPR 1 and 10 / 12 at DPR 3.
- The 768x1024 tablet failed 45 / 60.

**Before, by box:** in 103 failing cases the first box over the doors was "Your tables". In the other 98 it was the public list.

**Before, by phase:**

- after a resize: 101;
- the load itself: 73;
- a resize cycle: 23;
- a late text reflow: 3;
- the sign-in: 1.

**Deepest overlap:** 98–99 px. "Your tables" was drawn over the doors in the frame after a resize to 768x1024 or 1920x600 at the 125% UI scale.

**Settled layout, before:** no case failed once the page had settled. A first run without the frame monitor (1098 cases) passed completely. A probe that emulated WebKit-style zoom-divided client rects also found no settled overlap (0 / 28). In Chromium the old measured clamp ends up correct after its observers fire and React re-renders. Until then, each load, resize, sign-in or reflow paints the list over the doors.

## Why the first fix failed

The doors were absolutely positioned inside the `cover` photograph, at 70% of the scene and clamped into the window. The list was in normal flow. The first fix connected the two with a measurement: the doors' foot was read with `getBoundingClientRect`, divided by the zoom, tracked with `ResizeObserver` and `resize`, and written back as the height of an empty spacer.

So the boundary was a copy, and it landed at least one render after any layout change. Chromium shows that gap in the frames listed above. Where the measurement is late, never re-fires, or disagrees with the zoom arithmetic, the gap does not close.

## The structural fix

- **Top region (`lobby-top`):** one normal-flow block holding the account corner, the title and the Host / Join row, all in flow. Its height is its content's, with the hero window as a minimum height (a floor, not a fixed height).
- **Photograph:** now only that region's background (`sceneClip`, absolute, `inset: 0`, clipped to the region, `pointer-events: none`, under the flow content).
- **Boundary (`lobby-boundary`):** an explicit element that follows the top region.
- **Tables region (`lobby-tables`):** follows the boundary as a normal-flow sibling. It has no position, offset, transform or negative margin.
- **No measurement:** there is no `ResizeObserver` and no `getBoundingClientRect`.
- **Composition (#1131):** kept as CSS margins computed from the scene's own size, not from measurements. The title's foot aims at 0.4 of the scene, and the doors' centre at 0.7, clamped into the hero window. On 1920x1080, 1366x768 and 1920x600 at 100%, the title and doors sit at the same pixels as before.
- **Very short windows (~300%):** the wordmark's 230px minimum width gives way to half the window height. Before, the title was drawn over the account corner. Now the corner, title and doors stack inside the window: Host / Join at 229–275 px in a 360 px window, and 227–273 px in a 300 px window.
