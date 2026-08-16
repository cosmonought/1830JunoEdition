# Technical Debt Register — 1830: Juno Edition (Frontend)

Deferred items, logged rather than fixed. Each entry records what is wrong,
why it was left, and what the fix costs — so a later pass can judge priority
without re-deriving the analysis.

Opened 2026-08-16, during the OR turn-progression bug fix.

---

## TD-1 — The canonical corporation palette exists in three hand-copied places

**Severity:** medium (correctness risk, currently latent)
**Scope:** `components/hexContractTypes.ts`, `components/StockMarketRenderer.tsx`, `components/StockRoundPanel.tsx`

The eight canonical corporation colours from design note #408 are defined
three separate times:

| File | Symbol |
|---|---|
| `components/hexContractTypes.ts` | `STATION_TICKER_COLORS` |
| `components/StockMarketRenderer.tsx` | `TICKER_COLORS` (module-local) |
| `components/StockRoundPanel.tsx` | `TICKER_COLORS` (module-local) |

All three are byte-identical today — verified. The duplication is
**acknowledged in the source rather than accidental**: design note #408 ends
with "ALL THREE MIRRORS ARE UPDATED TOGETHER … so changing one would give the
map and the cards different opinions about who a corporation is", and
`StockRoundPanel`'s copy is commented "hand-kept duplicate of
StockMarketRenderer.tsx's module-local (unexported) `TICKER_COLORS`".

**Why it is worth fixing.** The codebase already argues the opposite case
against itself. `styles/palette.ts` opens by rejecting exactly this pattern:

> The fix is not "pick a better hex twice". It is to have ONE value that both
> files import, so a future pass physically cannot restyle one set without
> the other. Uniformity is now structural rather than a coincidence that
> survives until the next edit.

And design note #389 in `StockRoundPanel` claims the livery stripe uses
"`tickerColor` … one table, not a second palette that looks close" — which is
the intent, but is not structurally true: the stripe reads the panel's own
private copy, not the map's table.

The failure mode is quiet. A future colour change applied to two of three
mirrors gives the map one opinion and the stock cards another, with no type
error and no visible break on the screen the author was looking at.

**Fix.** Extract the table into a shared module — `styles/corporationLivery.ts`
is the natural home, importable by `components/` and `panels/` alike without
creating a component-to-component dependency (the same reasoning
`appStyles.ts` records for its own hoist out of `App.tsx`). Have
`hexContractTypes.ts` re-export `STATION_TICKER_COLORS` from it so the
existing public API and its eight-plus call sites are unchanged. Delete the
two module-local copies.

**Estimate.** Small — one new file, three edits, no behaviour change, fully
covered by `tsc`. Consider moving `bestContrastTextColor` / `relativeLuminance`
alongside it in the same pass, since they are generic colour maths that only
live in `hexContractTypes.ts` by accident of history.

---

## TD-2 — Historical logos reach two of four corporation surfaces

**Severity:** low (cosmetic inconsistency)
**Scope:** `components/HexGridRenderer.tsx` / `hexCanvasPrimitives.ts`, `components/StockMarketRenderer.tsx`

`CorporateLogo` renders the historical `.webp` heralds in two places:

- the Stock Round livery stripe (`StockRoundPanel.tsx`)
- the Contextual Action Bar's corporation strip (`panels/ContextualActionBar.tsx`)

The other two surfaces where a corporation announces itself still draw text
acronyms:

- **station tokens on the hex map** — `hexCanvasPrimitives.ts`, via
  `bestContrastTextColor(badgeFill)` over `STATION_TICKER_COLORS`
- **market chart tokens** — `StockMarketRenderer.tsx`, `parTrayMarkerBadge`
  and the matrix occupant badges

This is not a drop-in. Both are `<canvas>` draws, not DOM, so `CorporateLogo`'s
`<img>` + `onError` fallback does not apply. Rendering a logo there needs:

1. an image cache keyed by ticker, preloaded before the draw pass;
2. a draw path that falls back to the existing acronym while an image is
   pending or failed — the canvas cannot re-render itself on `onload`, so the
   cache has to invalidate the frame;
3. a size check. Station tokens are ~18px circles; several heralds are
   illegible at that size, which may make text the correct answer on the map
   regardless of technical feasibility.

**Fix.** Worth scoping as design work first, not a code task. Item 3 may
conclude the map should keep acronyms, in which case only the market chart's
larger badges are in play. `CorporateLogo.tsx` already exports `logoSrcFor()`
as a pure function precisely so a non-DOM consumer can reuse the path logic.

---

## TD-3 — Stale comment: C&O is no longer amber

**Severity:** trivial (documentation only)
**Scope:** `components/StockRoundPanel.tsx`, design note #389, ~line 343

The note justifying computed contrast ink reads:

> Hard-coding white would fail on C&O's amber (`#d68910`); hard-coding black
> would fail on CPR's purple.

Both examples are stale as of design note #408, which replaced the palette
with the physical game's. C&O is now `#5bc8e8` (cyan) and CPR is `#7b4a22`
(brown). The cyan case now argues the *reverse* of what the sentence says —
cyan is light enough to take **black** ink, so it is an example of
hard-coding *black* succeeding and hard-coding *white* failing.

The conclusion the note draws is still correct; only its illustrations are
wrong. Fix by re-picking two live examples from the current table — e.g.
"ERIE's yellow (`#f5cd3a`)" for the take-black case and "B&O's dark blue
(`#12408f`)" for the take-white case.

**Estimate.** Two minutes. Bundle into TD-1, which touches this file anyway.
