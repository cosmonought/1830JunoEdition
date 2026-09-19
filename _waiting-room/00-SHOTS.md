# Waiting Room redesign — design note #1443

Disposable review folder. Nothing here is part of the app; delete when done.

**Harness.** The working tree (uncommitted) bundled with esbuild and driven with Chromium/Playwright.
Room documents are fed through `window.__HARNESS_ROOM__` (cloud scratch copy only — never in the repo).
`SandboxWaitingRoom.tsx`, `NetaMark.tsx` and `appStyles.ts` were verified byte-identical to the repo's
working tree before capture. The "connection error" line in every shot is the harness's deliberately invalid
`wss://sandbox.invalid/ws`, not the screen.

**States captured.** `host` = seated host, public, ranged count, 3 of 6 seated, mixed readiness, one variant.
`guest` = seated guest, **private**, **exactly 4**, **full roster**, async, $20,000 bank, 1.5 JUNO ante, all
five variants (the long-prose case). `watch` = watch-only visitor.

| File | State |
|---|---|
| `before-*` / `after-*` `-host-1440` / `-430` | seated host |
| `before-*` / `after-*` `-guest-1440` / `-430` | seated guest, private, exact, full |
| `before-*` / `after-*` `-watch-1440` / `-430` | watch-only visitor |
| `ready-confirm-1440.png` | the ante confirmation — the one bounded object left |
| `kicked-1440.png` | removed player: the removal line, and no Ready control |

## Measured

| | before | after |
|---|---|---|
| Main content width @1440 | **513 px** | **936 px** (surface capped at 1040) |
| Main content width @1024 | 570 px | 984 px |
| Main content width @430 | 390 px | 390 px |
| Page height @1440, seated host | 1,045 px | **900 px** (fits the viewport) |
| Page height @1440, seated guest (5 variants) | 1,353 px | **910 px** |
| Page height @1440, watch-only | 1,093 px | **900 px** |
| Page height @430, seated host | 1,290 px | 1,479 px |
| Page height @430, seated guest | 1,673 px | 1,893 px |
| Page height @430, watch-only | 1,344 px | 1,391 px |
| `scrollWidth − innerWidth` @430 | **8 px** | **0** |
| `scrollWidth − innerWidth` @390 | **28 px** | **0** |
| `scrollWidth − innerWidth` @360 | **43 px** | **0** |
| `scrollWidth − innerWidth` @1024 / @1440 | 0 | 0 |
| Primary action (Ready) @1440 | 113 × 30 px | 89–116 × 30 px |
| Primary action (Ready) @430 | 125 × **34 px** | 129 × **44 px** |
| Every actionable control @430 | 19–34 px tall | **≥ 44 × 44 px** |
| Document outline | **no headings at all** | `h1 Waiting room` → `h2 Your seat / Players / House rules` → `h3 In force` |

The page is taller at 430 because the controls now meet the 44 px floor and the columns stack in the asked-for
order (identity → roster → action → rules). Nothing was compressed to buy height back.

## Verified

* **Seated host** and **seated guest** keep Ready, Start, the start-gate tooltip, kick, Set PIN / Rejoin, name
  and colour — all reading the same values from the same authorities.
* **Watch-only** has **no Ready control at all** (not a disabled one), no name/colour block, and an explicit
  `WATCHING` tag carrying the existing sentence. The watcher is absent from the roster and from the seat count.
* **Removed player** gets the removal line and, likewise, no Ready control.
* Public and private wording, exact-player and ranged rooms, full roster and available seats, ready/not-ready
  mixtures, and the long async/ante/five-variant prose all captured in the two seated states above.
* Keyboard order follows the visual order — `Your nickname → Set name → the seven colours → the roster's
  controls in row order` — with a 2 px `#8a8a86` focus ring at 2 px offset.
* Contrast: the 0.90 surface fill was **re-measured** for the new width. The lamp that sets the floor
  (rgb 246, 255, 213) is already inside the old 520 px footprint, so the worst case is the same pixel at both
  widths: **4.66:1** for `#8a8a86`, 9.46:1 for `#c8c6c0`, 14.19:1 for `#f2f0eb` over the resulting
  `rgb(32, 33, 30)`. Past AA on the faintest step, which is what sets the number.

## Two defects found by measuring

1. **`certificate limit 18.4 of 4 seats`** — two sentences shared a row with no separator. The seat count now
   lives in the `Players` heading it counts, so the deal line ends in a full stop.
2. **A 300 px footer mark.** `NetaMark`'s `<video>` keeps the UA's intrinsic 300 × 150 whenever the clip cannot
   be decoded, and `width: auto` then resolves to 300 px however small the window is. The Waiting Room is the
   only screen whose root does not clip its own overflow, so it is where that showed as page-wide scroll —
   the 8 / 28 / 43 px above. `#1137` pinned the mark's height; nothing said what it may never exceed.
