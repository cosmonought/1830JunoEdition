# Rules Reference — static export for independent design & wording review

Generated 2026-09-15 from `frontend/src/components/RulesReference.tsx` in the **working tree
(uncommitted)**, together with the data it derives from (`utils/privateCatalog.ts`,
`gameEngine/gamePhase.ts`, `gameEngine/depotSchedule.ts`, `gameEngine/gameSetup.ts`,
`gameEngine/gameVariants.ts`, `styles/palette.ts`, `styles/typography.ts`).

Each `.htm` is a **snapshot of the rendered DOM**, not a template and not a transcription. Open any
of them directly in a browser: no server, no scripts, no network requests, no webfonts.

This whole folder is disposable — delete `_rules-reference-export/` when the review is done. Nothing
in the app references it.

---

## The shared review state

Every export uses one state, so the five tabs are directly comparable.

| Prop | Value |
|---|---|
| `roundType` | `"OperatingRound"` |
| `roundLabel` | `"OR 2.1"` |
| `operatingSubPhase` | **`"Routes"`** — renders as **Run Routes**, step 3 of 5 |
| `activeCorporation` | **`{ ticker: "PRR", fullName: "Pennsylvania Railroad" }`** |
| `phase` | `{ label: "Phase 3", tier: "3", trainLimit: 4 }` (Phase D in the LPF / 18XX+ exports) |
| `playerCount` | `4` |
| `auctionComplete` | `true` |
| `rulesetLabel` | derived as the app does: `GAME_TYPE_COPY[gameTypeOf(variants)].label` |
| `stockRoundAction` | omitted — still unwired in `App.tsx` |

The contextual breadcrumb therefore reads **`Operating Round 2.1 → PRR → Run Routes`** on all nine
exports, and the live-state cues (the green dot on the Operating Round tab, `Current` on step 3, the
live phase row, the live seat-count row) are the same everywhere.

`operatingSubPhase: "Routes"` was chosen deliberately over `"Track"`: it puts the live marker on a
**middle** step rather than the first, which is a stronger test of whether the live treatment reads as
"you are here" rather than as "start here".

---

## Files

| File | Tab | Variants | Phase | Ruleset pill | Viewport captured |
|---|---|---|---|---|---|
| `01-overview-base.htm` | Overview | none (printed game) | Phase 3 | 18XX | 1440 × 900 |
| `02-stock-round-base.htm` | Stock Round | none | Phase 3 | 18XX | 1440 × 900 |
| `03-operating-round-base.htm` | Operating Round | none | Phase 3 | 18XX | 1440 × 900 |
| `04-auction-privates-base.htm` | Auction & Privates | none | Phase 3 | 18XX | 1440 × 900 |
| `05-tables-base.htm` | Tables | none | Phase 3 | 18XX | 1440 × 900 |
| `06-auction-privates-delayed-auction.htm` | Auction & Privates | `delayedAuction` | Phase 3 | 18XX | 1440 × 900 |
| `07-tables-lpf-phase-d.htm` | Tables | `levelPlayingField` + `expandedMap` + `plusTiles` | **Phase D** | 18XX+: Level Playing Field | 1440 × 900 |
| `08-overview-lpf-phase-d.htm` | Overview | `levelPlayingField` + `expandedMap` + `plusTiles` | **Phase D** | 18XX+: Level Playing Field | 1440 × 900 |
| `09-tables-plustiles-phase-d.htm` | Tables | `plusTiles` only | **Phase D** | 18XX | 1440 × 900 |

Each file repeats its own props and variants in an HTML comment at the top.

### Why those variants, and only those

Only states that **materially change page content** are exported.

- **`06` Delayed Auction** — the page's opening line drops its timing clause, the closing line drops
  *"The first Stock Round follows."*, and a labelled `Variant in play on this table` block appears
  after the base procedure. Verified present in `06` and absent in `04`, and vice versa.
- **`07` Level Playing Field in Phase D** — the Track tiles column gains **Gray**, the `Also` cell
  gains a tagged *Unlocks Gray tiles* clause, the base phase-change footnote gains the word
  **phase-triggering**, and a second tagged footnote separates the two purchases
  (*"Buying the first 7-train leaves Phase 6 in force and opens no new tile colour. Buying the first
  Diesel starts Phase D and brings the Gray tiles with it."*).
- **`08` Overview under the same state** — the At a Glance strip reads **Phase D / First diesel**,
  Private companies reads **Closed**, and Tile colors shows four hexes including Gray.
- **`09` 18XX+ tiles WITHOUT the Level Playing Field** — included because the copy genuinely differs:
  Gray and the *Unlocks Gray tiles* clause are present, but the **`phase-triggering` qualifier and the
  7-train footnote are not**, because there is no 7-train in that game. This is the pair worth
  diffing against `07`.

No export was made for `gentleRust`, `unpredictableRevenue`, `dynamicStockMarket` or `expandedMap`
alone on the five tabs: they change at most one table cell (the `$450` market ceiling, the extra
terrain tier) and add no new copy, structure or treatment.

---

## Screenshots

`screenshots/<tab>-1440.png` and `screenshots/<tab>-430.png`, full-page, for each of the five
base-game tabs. These are captures of the **live app** at those widths, so they are the reference the
`.htm` files should be checked against — not renders of the `.htm`.

---

## Disclosures, and the content this export would otherwise omit

The reference has exactly **one** disclosure (`aria-expanded`), and one collapsible strip. Both are
**conditionally rendered**, so their content is not in the DOM while closed. Both are captured in
their **normal default state** in the page itself, and their hidden content is appended in a clearly
marked **`EXPORT APPENDIX`** at the bottom of the file, outside the app's root element, with a note on
how to reach it in the running app.

| File | Appendix blocks |
|---|---|
| `01-overview-base.htm`, `08-overview-lpf-phase-d.htm` | **Game Flow, expanded** (collapsed by default while a round is live, open when none is), and the **Current Round explanation for each of the five steps** — the page shows only the live step's (Run Routes); selecting another step swaps that one panel |
| `03-operating-round-base.htm` | **Lay Track → Home hexes — NYC and Erie** — the whole reference's only disclosure, closed by default |

**Ignore the appendix when judging layout, hierarchy, reading width or accent use.** It is not part of
the page. It exists so the wording review can see strings the default render omits.

---

## How to inspect at 1440 and 430

Open the file and resize the browser window. All of the app's responsive CSS — the `<style>` block
carrying every `@media` rule and every `:hover` / `:focus-visible` rule — is inline in the document,
so narrowing the window exercises the same rules the app does. Verified: at 430 the At a Glance grid
restacks to two columns with Tile colors spanning, and the two-column `.rr-stock-pair` / `.rr-op-pair`
comparisons collapse to one.

---

## Limitations of a static export

Measured, not assumed — each of the five base tabs was rendered live and as an export at both widths
and compared pixel by pixel.

1. **JS-measured overflow cues are frozen to the capture width.** `ScrollingLookup` compares
   `scrollWidth` against `clientWidth` through a `ResizeObserver` and renders the line
   *"Scroll sideways for the rest of the table →"* only when a table genuinely overflows. The exports
   were captured at 1440, where nothing overflows, so **that cue is missing when you narrow the export
   to 430** — on the Stock Round's two Market Effects tables and on the Tables page's phase table. In
   the running app it is there. This is the only content difference between the exports and the app.
   The `screenshots/stock-430.png` and `screenshots/tables-430.png` captures show the real behaviour.
2. **The Current Round action row's scroll offset is not carried.** At 430 the row scrolls sideways
   and a layout effect centres the live chip; a static file starts it at offset 0, so the Overview
   export at 430 opens on *1 Lay Track* rather than on *3 Run Routes*. Every chip, label and the
   `Current` cue itself are present and faithful — only the row's initial scroll position differs.
3. **Sticky positioning and anchor jumps are present in the CSS but not exercised.** The page strip is
   `position: sticky` and every section carries `scrollMarginTop: 170px`; both are in the export, but
   whether a jump lands its heading clear of the strip is a browser behaviour these files cannot
   settle. (Measured separately in the app: 76–594 px of clearance depending on the target.)
4. **Controls are inert.** Tab buttons, jump links, `Open current rules →`, the disclosure toggle and
   the action chips do not respond. Their **visible states and labels are faithful**, including which
   tab is selected and which step is marked `Current`.
5. **Tile colours are SVG glyphs, not text.** The four `EraHex` swatches in the At a Glance *Tile
   colors* cell carry their names as `aria-label` / `title` (`"Yellow tiles"`, …, `"Gray tiles"`), so a
   plain-text search of the export will not find the word "Gray" there. Read the attributes.
6. **Everything else is identical.** Of the ten live-vs-export comparisons, three are pixel-identical;
   four differ only by text antialiasing (≤342 pixels, under 0.01% of the frame) with identical DOM
   text; the remaining three are items 1 and 2 above.
7. **Fonts are system stacks** (`system-ui, -apple-system, Segoe UI, sans-serif` and
   `ui-monospace, SFMono-Regular, Menlo, monospace`). Nothing is downloaded, so nothing is missing —
   but the exact glyphs depend on the reviewing machine, exactly as they do in the app.

---

## What the review is for

Whether the five tabs share one design language — heading hierarchy, what each accent *means*
(Auction violet, Stock blue, Operating magenta, Game End slate, neutral for lookup material; green
reserved for live state and never used as a round accent), reading widths, navigation, live-state
cues, and how exceptions are treated — and whether the wording has drifted between tabs.
