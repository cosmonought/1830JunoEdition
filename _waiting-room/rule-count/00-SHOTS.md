# Waiting Room — rule-count layout and the settings intro (design note #1446)

Disposable review folder. All captures at 1440×900 unless the name says 430.
`before-one-rule-1440.png` is #1445's single-rule state — the full-height rail holding one short item.

| File | Active House rules | Layout |
|---|---|---|
| `plain-1440.png` | **0** (standard game) | compact 720 px, `House rules · NONE` |
| `shortbank-1440.png` | **0** (18XX+, $4,500 bank) | compact 720 px |
| `host-1440.png` | **1** (Gentle rust) | compact 720 px, rules as a section after Game settings |
| `two-1440.png` | **2** (Gentle rust, Delayed auction) | compact 720 px, same |
| `three-1440.png` | **3** | 1040 px, two columns, full-height divider |
| `guest-1440.png` | **5** (private, exactly 4, $20,000, 1.5 JUNO) | 1040 px, two columns |
| `watch-1440.png` / `watch-430.png` | 1, watch-only | compact; `WATCHING`, no Ready |
| `guest-430.png` | 5, mobile | one column, rules last |

The "connection error" line is the harness's deliberately invalid `wss://sandbox.invalid/ws`.

## The switch

`RULES_FOR_RAIL = 3`; `railed = houseRules.length >= RULES_FOR_RAIL`. The count decides and nothing else —
no rendered height, no viewport, no `matchMedia`, no `ResizeObserver`, no `getBoundingClientRect` anywhere in
the component. A layout chosen by measuring text changes when a word is edited and cannot be asserted without
a browser; this one is the same number on every client and in a unit test.

`railed` drives three things together: the grid (`wr-columns` vs `wr-columns-solo`), the surface cap
(1040 → 720 px) and which parent the House rules section is rendered into. The hairline is the second
region's own left border, so no second region means no hairline.

**One element, two parents.** `houseRulesSection` is built once and placed either in the left flow or in the
rail, so the two cases cannot drift into two designs with two sets of copy. One `VARIANT_TOGGLES.filter`, one
`houseRules.map` — a rule cannot render twice or in two orders.

## Measured — zero horizontal overflow everywhere

| Fixture | rules | 1440 content / page | 430 content / page | overflow 1440 / 430 |
|---|---|---|---|---|
| `plain` | 0 | 648 / 998 px | 390 / 1,322 px | 0 / 0 |
| `shortbank` | 0 | 648 / 1,015 px | 390 / 1,359 px | 0 / 0 |
| `host` | 1 | 648 / 1,099 px | 390 / 1,474 px | 0 / 0 |
| `two` | 2 | 648 / 1,159 px | 390 / 1,559 px | 0 / 0 |
| `three` | 3 | **936** / 977 px | 390 / 1,619 px | 0 / 0 |
| `guest` | 5 | **936** / 1,065 px | 390 / 1,984 px | 0 / 0 |
| `watch` | 1 | 648 / 1,021 px | 390 / 1,386 px | 0 / 0 |

Also 0 at 360, 390 and 1024.

## The settings intro

`Set by the host before this room opened. You are agreeing to them when you press Ready.`
→ **`Fixed when the room opened.`**

One sentence for every reader — no role-specific variant to keep in step. The old one was false for a
watcher, who has no Ready control by design, and odd for the host, who chose the settings. A test pins that
`when you press Ready` appears nowhere in the file.
