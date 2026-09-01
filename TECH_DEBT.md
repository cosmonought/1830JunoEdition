# Technical Debt Register — 1830: Juno Edition (Frontend)

Deferred items, logged rather than fixed. Each entry records what was wrong,
why it was left, and what the fix cost — so a later pass can judge priority
without re-deriving the analysis.

Opened 2026-08-16, during the OR turn-progression bug fix.
**All open items closed 2026-08-16.** Resolutions are kept below rather than
deleted: the reasoning is what makes a future recurrence recognisable.

---

## ✅ TD-1 — The canonical corporation palette existed in three hand-copied places

**Status:** RESOLVED — design note #428
**Was:** medium (correctness risk, latent)
**Scope:** `components/hexContractTypes.ts`, `components/StockMarketRenderer.tsx`, `components/StockRoundPanel.tsx`

The eight canonical corporation colours from design note #408 were defined
three separate times — `STATION_TICKER_COLORS` plus two module-local
`TICKER_COLORS`. All three were byte-identical, and the duplication was
acknowledged in the source rather than accidental: #408 ended "ALL THREE
MIRRORS ARE UPDATED TOGETHER", and `StockRoundPanel`'s copy was headed
"hand-kept duplicate of StockMarketRenderer.tsx's module-local (unexported)
`TICKER_COLORS`".

That is a correctness requirement enforced by a comment. `styles/palette.ts`
had already argued the opposite case against it — "The fix is not 'pick a
better hex twice'. It is to have ONE value that both files import" — and
`StockRoundPanel`'s design note #389 already *claimed* the unified
arrangement ("one table, not a second palette that looks close") while
reading its own private copy.

**Resolution.** New `styles/corporationLivery.ts` holds the table, the
fallback, `corporationLiveryColor()`, `relativeLuminance` and
`bestContrastTextColor`. `hexContractTypes.ts` re-exports
`STATION_TICKER_COLORS` / `STATION_FALLBACK_TICKER_COLOR` and both contrast
helpers under their existing names, so all eight-plus call sites are
untouched; `stationTickerColor` delegates. Both module-local tables deleted.

The contrast helpers moved with the table deliberately — a palette whose
legibility function lives elsewhere can be recoloured without its guarantee
being re-checked, which is exactly the audit #408 performed by hand.

**Guarded by** `styles/corporationLivery.test.ts`, which asserts the
re-export is the *same object* (not merely equal), that both readers agree,
and that no other source file carries three or more of the eight hex values.
That last test is the one that matters: a duplicate table typechecks, lints,
and renders correctly on whichever screen its author is looking at. Note it
counts *cardinality*, not presence — `#1a1a1a` legitimately appears in an SVG
cursor and in the tile-tier strokes, so forbidding a colour outright would
have produced a false positive and a test the next person deletes.

The same file now also pins #408's contrast audit (AA for all eight, floor at
B&M 5.35:1, ink flipping to black for exactly C&O/ERIE/NNH), which was
previously a paragraph asserting the numbers had been checked.

---

## ✅ TD-2 — Historical logos reached two of four corporation surfaces

**Status:** RESOLVED — design notes #429, #430
**Was:** low (cosmetic inconsistency)

> **Correction to the original entry.** This item claimed the market chart
> was a `<canvas>` surface and grouped it with the hex map. That was wrong.
> `StockMarketRenderer` is DOM/CSS grid — its own design note #2 says so
> explicitly, and it has no `getContext` call anywhere. Only the hex map
> draws to canvas.
>
> The error mattered, because it made the planned fix (an image preload/cache
> helper for canvas draws) look necessary when it was not. With the market
> chart on the DOM and the 18px map tokens deliberately staying on text, a
> canvas logo cache would have had no caller at all — dead infrastructure of
> exactly the kind this codebase's notes repeatedly delete as "a standing
> invitation" to misuse. No cache was built.

**Resolution.** The DOM market chart renders the `.webp` heralds through the
existing `CorporateLogo` component, which brings its own `onError` fallback
to the acronym — so a missing or undecodable file degrades to precisely what
these badges rendered before. The browser owns the image lifecycle; there is
nothing to preload.

- **Par tray pills** — always show the herald. These are the largest
  corporate badges on the screen (`FONT_SIZE.strong` with 11px padding).
- **Matrix occupant tokens** — show the herald at or above 26px diameter,
  acronym below it. These tokens scale from ~14px (crowded cell, narrow
  chart) to 46px, so a blanket rule would have honoured the letter of the
  requirement and made the crowded cells worse. The threshold is applied to
  the live measurement, so it stays correct as the chart resizes.
- **Map station tokens** — unchanged, text. At 18px the NYC oval and CPR
  beaver are indistinguishable smudges; this is the same judgement the 26px
  threshold above encodes.

`CorporateLogo` gained an optional `maxWidth` (design note #429): its default
cap is `size × 2.4`, sized for the livery *stripe*, which would run a wide
herald out of both sides of a circular token and let `overflow: hidden` crop
it. A cropped herald reads as a rendering fault; an acronym reads as a
decision.

**Incidental fix.** Both badges hardcoded `color: "#ffffff"`, which is
unreadable on the three light liveries (C&O cyan, ERIE yellow, NNH orange).
That is now `bestContrastTextColor` per fill — necessary rather than
cosmetic, since this colour is what the *text fallback* is drawn in, and a
fallback nobody can read is not a fallback.

---

## ✅ TD-3 — Stale comment: C&O was no longer amber

**Status:** RESOLVED
**Scope:** `components/StockRoundPanel.tsx`, design note #389

The note justifying computed contrast ink read: "Hard-coding white would fail
on C&O's amber (`#d68910`); hard-coding black would fail on CPR's purple."

Both examples predated design note #408. C&O is `#5bc8e8` cyan — light, and
therefore takes **black** ink — so the sentence cited it as a case against the
very choice it now requires. CPR is `#7b4a22` brown, not purple.

**Resolution.** Replaced with cases checked against the live table rather than
remembered: white fails on ERIE's yellow `#f5cd3a`; black fails on B&O's dark
blue `#12408f`. Three of the eight take black and five take white, so any
fixed choice is wrong for at least three corporations. The correction is
recorded in place, since the failure mode here is a comment that keeps
arguing after the data beneath it has moved.

---

## ✅ Lint — `isRealMarketCell`

**Status:** RESOLVED

The codebase's last ESLint warning. The function answered "is `(x, y)` a
coordinate this board has", and nothing had called it since design note #43a
moved that question inside `buildPriceGrid`, which precomputes an `occupied`
set for the cliff logic. Deleted rather than silenced with a disable comment:
a second implementation of "which cells exist" is the near-miss duplicate
class TD-1 had just finished consolidating, and an unused export is how the
second copy gets adopted. `cellAt` is the live way to ask.

ESLint now reports **0 errors, 0 warnings**.

---

## Open items

Reopened 2026-08-31, during the Neta DAO re-theme (design note #1092).

Every item below is **pre-existing** — found while sweeping colour values, not
caused by the sweep. They are logged rather than fixed because the re-theme was
scoped to colour VALUES and each of these needs a judgement the sweep had no
mandate to make. Figures re-verified at time of writing.

---

## ✅ TD-4 — Three seat colours failed AA, and one of them wore a corporation's green

**Status:** RESOLVED — design note #1097 (`playerLabels.ts`, `seatColor.test.ts`)

**Was:** medium — legibility, on the badge naming who is acting
**Scope:** `utils/playerLabels.ts`, `styles/appStyles.ts` (the false claim),
`utils/seatColor.test.ts` (the guard that should have caught it)

Two faults, found together. Three of the six seat colours were under 4.5:1 on
the president badge's white plate — Moss 4.10, Teal 3.98, Ochre 3.30. And design
note #569's own rule ("a player stripe in the PRR's red would read as a claim
about the PRR") was being broken by Moss, which sat **8.2 dE from the B&M's
green**.

**Resolution.**

| | before | after |
|---|---|---|
| Moss → **Mulberry** | `#4f8a5c`, 4.10 | `#5a003c`, 14.00 |
| Ochre | `#a88a3f`, 3.30 | `#847400`, 4.69 |
| Teal | `#3f8a94`, 3.98 | `#00686c`, 6.57 |

Moss could not be saved as a green: the B&M owns mid-green, and every green dark
enough to clear the floor lands within ~11 dE of it. Mulberry was chosen over a
tighter green on the owner's call — the player set stops competing for board
hues entirely. It sits 24.8 from its nearest corporation and 26.3 from Plum,
separated from Plum by 27 points of lightness as well as hue.

**The guard was broken too, and that is the part worth remembering.**
`seatColor.test.ts` asserted the seats stayed clear of the liveries — against a
hardcoded list of six colours that had not been liveries since design notes
#408/#428 replaced the invented palette with the physical board's. For eight
corporations it was comparing against nothing and passing by construction. It now
reads `CORPORATION_LIVERY_COLORS` directly and checks *separation* (CIE76, floor
20) rather than exact equality — which the original note already knew was the
right property and settled for equality because it was unarguable. A near-miss
is what actually shipped.

**Two knock-ons recorded rather than left to rot.** `appStyles.ts` carried the
false sentence "all six read on white" — corrected in place. And
`PrivateRevenueModal`'s note argued against a full-surface seat colour *because*
three colours failed 4.5:1; all six now pass, so that argument no longer holds
and the note says so. The decision stands on its other grounds.

**Still open (deliberately):** Brick is 12.9 dE from the CPR's brown — below the
bar this pass used, above the codebase's 8.4 floor, and not one of the three
failing contrast. It is exempted **by name** in the test so it stays a visible
exception rather than quietly setting the standard.

---

## ✅ TD-6 — Gold survived in seven places after the accent moved to pink

**Status:** RESOLVED — design note #1098

Design note #1094 moved "look here" from gold to `BRAND_PINK`, leaving seven
amber survivors chosen to agree with the old accent. Reviewed one at a time with
the owner, because each was a judgement about what the colour MEANS rather than a
ladder lookup.

| What a player sees | Was | Now | Contrast |
|---|---|---|---|
| "You must buy a train" notice | gold | **pink** — the only true obligation of the seven | 9.37 → 9.68 |
| The 🚫 tooltip on a blocked hex | gold | **red** — a refusal is not a warning | 11.74 → 12.84 |
| "Watching game #N" strip | gold | **neutral** — a state, not a summons | 10.21 → 10.79 |
| Cancel-errand button | gold | **neutral** — safe and reversible | 9.97 → 9.98 |
| Emergency purchase confirm | gold | **`ACTION_GREEN`** — it was the last gold confirm | 10.07 → 6.54 |
| "Offline" tag | gold | **kept** — amber for "not right, not broken" | — |
| Wallet connecting dot | gold | **kept** — green/amber/red is a known convention | — |

**The point of the exercise, and it is not tidiness.** Amber was doing two jobs
and can now do one. With look-here moved to pink, gold means "heads up, nothing
is broken" and nothing else — which is why two of the seven were *more* correct
as amber than they had been, and were kept rather than swept.

**Three judgement calls inside the owner's decisions, recorded so they can be
overruled.** The obligation notice took a LIGHTER pink than `BRAND_PINK_INK`
because it is a paragraph rather than a chip (the brand ink would have dropped it
to 4.9); it also lands 18.1 dE from `ALERT_CRITICAL_INK`, further than the brand
pink itself, so putting pink in the action bar does not worsen #1094's one
recorded collision. The blocked-hex red is deliberately 4.6 dE from
`hexClickIndicatorError` rather than identical, because an error is the app
failing and a blocked hex is the board rule holding. And the emergency confirm
lost contrast (10.07 → 6.54) to match every other confirm; the counter-argument —
that this one spends a player's own money and might deserve to feel heavier — is
written at the call site, with the note that the answer would be a distinct
treatment rather than a unique colour.

---

## TD-8 — The recessive-state family sits at 3.3:1, and one of them is not a disabled control

**Status:** PARTLY RESOLVED — `stepDone` fixed by design note #1096; the
disabled family and the turn-order ink stand, the latter pending a look
**Severity:** low — deliberate recession
**Scope:** seven `*Disabled` styles across six components, plus
`OperatingSubPhaseStepper`'s `stepDone`

Seven disabled controls land at **3.25:1** (`#6e6c68` on `#1c1c1c`) and
`stepDone` at **3.66:1** (`#6e6c68` on `#0f0f0f`). All are within a hair of
where they were before the re-theme — the pre-sweep figures were 3.31 and 3.68 —
so nothing here was caused by #1092.

The inactive turn-order chips belong to the same family and are the one place
#1092 did move the number: blending toward `TURN_ORDER_NEUTRAL_INK` now lands
the worst of the eight at **2.58:1**, down from 2.72:1. Accepted deliberately
(design note #1092 in `corporationLivery.ts` records the trade in full — pairwise
separation between the eight improves from 13.9 to 14.5 dE in exchange), but it
is the lowest figure in the register and belongs on the same list.

WCAG exempts disabled controls from contrast minimums, so the seven are
defensible as they stand. `stepDone` is the one worth a second look: it is not a
disabled control, it is a **status indicator** saying a sub-phase is finished,
and status is information rather than an unavailable action. The exemption does
not obviously cover it.

**Fixed (design note #1096).** `stepDone` lifted to `#8a8a86`, **5.53:1**, and
the seven disabled controls left alone. That keeps "completed" recessive relative to the current
step while making it legible as the fact it is. Doing the whole family together
would flatten the distinction between *done* and *unavailable*, which the
stepper currently carries in exactly this contrast difference.

---

## ✅ TD-7 — The canvas still drew on slate-blue

**Status:** RESOLVED — design note #1092
**Was:** low — visible seam, deliberate at the time
**Scope:** `hexCanvasPrimitives.ts`, `hexBoardData.ts`, `StockMarketRenderer.tsx`

> **Correction to the original entry, which repeated TD-2's mistake.** This item
> claimed 32 values across six files, and grouped `StockMarketRenderer` with the
> hex map as canvas work. It is not canvas — it is a DOM/CSS grid with no
> `getContext` call anywhere, exactly as **TD-2's own correction in this file
> already records**. Two passes made the same error four months apart, which is
> a reasonable argument that the file's name is doing the misleading.
>
> The real figure was **8 drawn values**, not 32. The other three were ordinary
> chrome and were swept as such.

**Resolution.** The drawn CHROME was neutralised: the outline around hex badges,
the grey standing in for a muted station token, the offboard tooltip's rim, fill
and inactive-row text, and `LAY_TRACK_DIM_INK`. That last is a 0.8 L\* change
under a 55–82% alpha — invisible in play, taken so the app's one veil is not the
last thing mixing a blue cast into everything beneath it.

**Two values deliberately left, on the owner's call.**

`PRINTED_HEX_FILL.Gray` `#8a8f94` and `PRINTED_HEX_STROKE.Gray` `#4a4e52` —
these "approximate the real board's gray cardstock" (design note #12). That is a
physical-board reference of the same kind as the corporation liveries.
Neutralising them would be re-tinting the board rather than the interface.

`STATION_TOKEN_RING` `#334155` — its design note carries a measured figure,
"charcoal-on-white separates at roughly 10:1", which is 10.35 at this value and
14.35 if neutralised; and it records the B&M as a deliberate edge case whose ring
merges into its own fill at 1.94, which would become 2.68 and stop merging. The
value can move, but only together with those two figures re-derived and that
paragraph rewritten. Swept once by #1092's first pass and reverted for exactly
this reason.

---
