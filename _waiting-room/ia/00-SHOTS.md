# Waiting Room information architecture — design note #1444

Disposable review folder. `before-*` is #1443's structural redesign; `after-*` is the same screen with the
classification and hierarchy corrected. Nothing in #1443's structure was reverted.

**States captured.** `host` = public seated host, ranged count, 3 of 6, mixed readiness, one variant.
`guest` = **private** seated guest, **exactly 4**, full roster, async, **$20,000 bank**, **1.5 JUNO ante**,
all five variants. `plain` = public host, **standard game, standard bank, zero ante, no optional rules**.
`shortbank` = 18XX+ with a **$4,500 bank**, exact-3, **no optional rules**. `watch` = public watch-only.

The "connection error" line in every shot is the harness's deliberately invalid `wss://sandbox.invalid/ws`.

## What changed

| | before (#1443) | after (#1444) |
|---|---|---|
| Header ladder | `Waiting room` 16px → **`JUNO-B3F` 28px green** → visibility sentence | `WAITING ROOM` 12px eyebrow → **game 26px** → `ROOM JUNO-B3F` 15px mono |
| Secondary column | one heading, `House rules`, holding all 11 rows | `Game settings` (6 rows) · rule · `House rules` (variants only) |
| Row label | `Game type` | `Game` |
| Bank | `$20,000` + "**$20,000 bank.** Runs well past the Diesels…" | `$20,000` + "Runs well past the Diesels…", with a `NON-STANDARD` tag beside the value |
| Visibility | sentence beside the code **and** a `Visibility` row | one row: value + its explanation |
| No optional rules | a conditional sentence, only for the printed game | `NONE — no optional rules are switched on.` for every game type |

## Verified

* **Game is more prominent than the code** — 26px vs 15px, and the game comes first in the DOM.
* **`Game`, not `Game type`.**
* **Core settings are not under `House rules`** — a source scan asserts each of the six labels falls between
  the `Game settings` heading and the `House rules` heading, and that `VARIANT_TOGGLES` is not drawn there.
* **Each value is stated once.** `bankSizeLabel(` appears exactly once in the file; the ante total appears
  once as the row's value; the pace, visibility and bank notes are asserted against the *data* not to contain
  their own value, for every option.
* **Optional rules appear only under `House rules`**, from the same `VARIANT_TOGGLES` filter as before — no
  variant changed state, only the heading it is read under.
* **The hierarchy does not fork by visibility** — the header block contains no `visibility ===` branch.
* Structure, behaviour and measurements from #1443 are unchanged: one surface, two unequal regions, one
  vertical hairline, open roster, `3 of 6 seats` beside Players, the corrected certificate-limit line, watch
  mode with no name/colour controls and no disabled Ready, the bounded ante confirmation, the footer-mark fix.

## Measured

| | 1440 | 430 |
|---|---|---|
| `scrollWidth − innerWidth` — every state | **0** | **0** |
| also at 360 / 390 / 1024 | **0 / 0 / 0** | |
| Main content width | 936 px (1024: 984 px) | 390 px |
| Page height — host / guest / plain / shortbank / watch | 900 / 1,035 / 900 / 900 / 900 px | 1,550 / 2,063 / 1,459 / 1,478 / 1,462 px |
| Primary action | 89–116 × 30 px | 99–129 × **44 px** |

The private guest is ~125 px taller at 1440 than under #1443 because `Game` and `Visibility` gained real
explanations; every other state still fits the viewport exactly.

## One judgement call

`Game · 18XX+: Level Playing Field` carries the shared blurb "The Project 18XX+ map and tiles, with warehouse
towns at the red areas, Coal River, …". It names **18XX+** — the base the Level Playing Field is built on —
which is information the value does not carry, so I read it as adding meaning rather than restating. It is
also shared copy (#961a) used by the Host card and the Lobby, so rewording it would reach beyond this screen.
Say the word and I will special-case the note for that one type.
