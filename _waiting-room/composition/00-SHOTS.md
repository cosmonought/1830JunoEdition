# Waiting Room composition — design note #1445

Disposable review folder. `before-*` is #1444 (settings in the right rail); `after-*` is #1445 (settings in
the left flow, right region for House rules only). The "connection error" line is the harness's deliberately
invalid `wss://sandbox.invalid/ws`.

| Fixture | What it exercises |
|---|---|
| `guest` | **five** active House rules · private · exactly 4 · full roster · async · $20,000 bank · 1.5 JUNO ante |
| `host` | **one** active House rule · public · ranged · 3 of 6 · mixed readiness |
| `plain` | **no** House rules · public · standard game · standard bank · zero ante |
| `shortbank` | **no** House rules · 18XX+ · $4,500 bank · exactly 3 |
| `watch` | watch-only visitor, one active rule |

## Composition

**Left region, in order:** `WAITING ROOM` eyebrow → game title → `ROOM <code>` → the game's own sentence →
Your seat → Players (roster, capacity, PIN note) → Ready/Start or Watching → Skip opening titles →
**Game settings** (Pace, Visibility, Bank, Ante).

**Right region:** active House rules and nothing else. Its height is whatever the rules come to.

**With no rules:** the right region is not rendered, the divider is gone, `.wr-columns-solo` collapses the
grid to one track and the surface narrows from 1040 → 720 px. The fact is stated as a quiet
`House rules · NONE` line at the foot of the settings.

## Measured

| | 1440 | 430 |
|---|---|---|
| `scrollWidth − innerWidth`, every fixture | **0** | **0** |
| also at 360 / 390 / 1024 | **0 / 0 / 0** | |
| Surface content width — rules present | 936 px (1024: 984) | 390 px |
| Surface content width — **no rules** | **648 px** | 390 px |
| Page height — guest / host / plain / shortbank / watch | 1,065 / 1,013 / 998 / 1,015 / 935 px | 2,003 / 1,490 / 1,340 / 1,377 / 1,402 px |
| Primary action | 89–116 × 30 px | 99–129 × **44 px** |

## Verified

* **Game and Players appear once each** — the game as the title, the capacity in the `Players` heading. A
  source scan asserts no `label="Game"`, `label="Players"` or `label="Game type"` exists anywhere in the file.
* **Game settings is in the left flow** — asserted by DOM order: action area → skip-intro → settings → the
  right region, and settings strictly after the roster.
* **The right region contains only active House rules** — it renders `houseRules.map` and no `TermRow`.
* **No-rules state** has no right region, no divider and no reserved half-surface.
* **Watcher and seated controls** stay with the roster (the ready control is still gated on `me`).
* **`18XX+: A Level Playing Field`** — the player-facing title only; the internal id, the `lpf` abbreviation
  and `VARIANT_COPY.levelPlayingField.label` are untouched.

## One addition beyond the letter of the brief

Removing the `Game` row would have dropped its description with it, and that sentence is the only statement on
this screen of what the table is actually playing — under the Level Playing Field it is the only place the
map's differences are listed at all. It now sits as a quiet line **after** the room code, so the title/code
pair still reads first. One line to remove if you'd rather not have it.
