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

None.
