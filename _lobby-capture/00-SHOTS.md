# Lobby / Join — capture set (design notes #1440 + #1441)

Disposable review folder. Nothing here is part of the app; delete when done.

**Harness.** The working tree (uncommitted) bundled with esbuild, served at `127.0.0.1:8811`, driven with
Chromium/Playwright. Three seams exist **only in the cloud scratch copy — never in the repo**:
`roomDocOnServer()` returns true when a fixture is present, `subscribeSandboxRoom` serves
`window.__HARNESS_ROOM__`, and `useSandboxRooms` serves `window.__HARNESS_ROOMS__`.
The five source files behind these shots were verified byte-identical (md5) to the repo's working tree.

**Fixture.** `FIXTURE-24-rooms.mjs` — 24 deterministic public rooms in the `summariseSandboxRoom` shape the
server broadcasts: 16 open (3 of them full) and 8 under way; live and async; 18XX, 18XX+ and Level Playing
Field; seat caps 2–7, some "exactly N"; $4,500 / $12,000 / $20,000 banks; varied house rules. No clock, no
randomness.

**App zoom.** The lobby's own text-size control, at its default for each width: **90% at 1440**, **100% at 430**.

## The three row states (#1441)

| Room | Action shown |
|---|---|
| public, waiting, seat free | **Join** (filled green, 700) then **Watch** (outline, 600, muted ink) |
| public, waiting, full | **FULL** as status text, then **Watch** |
| public, under way | **Watch** |

`detail-rows-1440.png` / `detail-rows-430.png` show all three together.

| File | What it shows | Viewport |
|---|---|---|
| `lobby-1440-viewport.png` / `lobby-430-viewport.png` | Populated lobby, first screen, incl. the action row | both |
| `detail-actions-1440.png` / `detail-actions-430.png` | The Host / Join / Rejoin row, cropped | both |
| `detail-rows-1440.png` / `detail-rows-430.png` | Available, full and ongoing rows together | both |
| `lobby-1440-list.png` / `lobby-430-list.png` | The list, scrolled | both |
| `lobby-1440-foot.png` / `lobby-430-foot.png` | Foot: full tables, Under way, footer | both |
| `watch-waiting-room-1440.png` / `-430.png` | Watch pressed on an **open** table: no seat taken | both |
| `join-dialog-1440.png` / `join-dialog-430.png` | Private-code dialog | both |
| `state-*-empty / -loading / -error` | The three genuine subscription states | both |
| `host-step1-*` / `host-step2-*` | Host Game; step 2 shows **Bank Size = $12,000** | both |
| `waiting-room-1440.png` / `-430.png` | Waiting Room terms, **Bank $12,000** | both |

## Measured

### The Lobby action row at 430×932 (viewport 0 → 430)

| Control | left | right | width | height |
|---|---|---|---|---|
| Host game | **21.3** | 140.0 | 118.7 | 46 |
| Join game | 150.0 | 266.0 | 116.0 | 46 |
| Rejoin game | 276.0 | **408.7** | 132.7 | 46 |

Anchor box **16 → 414** (width 398). All three on one line, fully inside the viewport.
`documentElement.scrollWidth` = **430** = `innerWidth` → **0 px horizontal overflow**.

Before the fix, for comparison: Host game began at **x −34.7** and Rejoin game ended at **x 464.7**.

Narrower screens, same rule: 390×844 and 360×800 both wrap to two lines, every button inside the viewport,
`scrollWidth − innerWidth` = 0. Desktop is untouched — at 1440 the row is one line at x 495 → 944.9.

### The list

| | 1440×900 (zoom 90%) | 430×932 (zoom 100%) |
|---|---|---|
| "Public games" heading below the action buttons | 15 px | 18 px |
| First public row below the action buttons | 93 px | 81 px |
| Page height, 24 rooms | 2,186 px | 2,823 px |
| `documentElement.scrollWidth − innerWidth` | **0** | **0** |
| Rows / Join / Watch / Full | 24 / 13 / 24 / 3 | same |
| Row action button | 51 × 25 px | **55 × 44 px** |
| Row height | 52 px | 73–92 px |

Keyboard walks `Any pace → Live → Async → Join(4T2) → Watch(4T2) → Join(9KP) → Watch(9KP) → …` in visual
order — Join always before Watch within a row. Every control takes a 2 px `#8a8a86` ring at 2 px offset.

### Watch on a table that has not started

Pressing Watch on an open room lands in the waiting room with **no seat claimed**: the roster does not
contain the viewer, Ready is disabled, and the screen says *"You are watching this table. Take a seat from
the Lobby if you want to play; the host may start without you."*

## Known artefacts of the harness, not of the app

* The red "[server] Could not load the room list…" banner is the **Web3 staging list** (`useLobbyRooms`)
  failing against the harness's deliberately invalid `wss://sandbox.invalid/ws`. Not the public list.
* "Offline · sandbox active" is the chain pill, likewise a harness fact.
