# Round-affinity cues on the game-room tab strip — visual review

Design notes **#1626** (`styles/palette.ts`, the shared round tokens) and **#1627** (`components/MainTabBar.tsx`,
the strip's treatment). Uncommitted; this folder is **disposable** — nothing in the app references it.

## The treatment

A **2px inset rule in the round's hue, on the tab's inner top edge**, and nothing else:
`box-shadow: inset 0 2px 0 0 <hue>`. On the selected tab it is composed with that tab's existing lift
(`inset 0 2px 0 0 <hue>, 0 -1px 6px rgba(0,0,0,0.35)`) rather than replacing it.

It is an **inset shadow on purpose**: it paints inside the padding box and takes part in no layout, so no
border grows, no padding moves and no tab changes width — see the measurements below.

The **top** edge rather than the bottom, which is the one place this departs from the Rules Reference nav's
own accent rule. That nav's tabs are pills with four borders and nothing docked beneath them, so its 2px rule
sits under the label. These are folder tabs (`border-bottom-width: 0`, the selected tab's bottom border
painted in the panel's own colour so it docks seamlessly into the surface below). That bottom edge is the
seam; a coloured rule in it would either break the dock or read as an underline of the selected tab.

## The mapping, derived from behaviour

`roundAffinityFor` is `surfaceTabFor` read backwards — the function that already decides which tab each round
acts in — so a tab cannot acquire an affinity the app does not already believe.

| Tab | Affinity | Why |
|---|---|---|
| `Auction` (`phase`) | **auction violet** `#c08ae8` | `surfaceTabFor("WaterfallAuction")`; exists only during the auction |
| `Stocks` (`corps`) | **stock blue** `#6fa3f7` | `surfaceTabFor("StockRound")`; "Stocks IS the Stock Round's surface" (#28) |
| `Rail Map` (`map`) | **operating magenta** `#e879b0` | `surfaceTabFor("OperatingRound")`; "the rail map is the operating round's own surface" |
| `Stock Market` (`stock`) | **neutral** | Owns a board (#45), so not merely a lookup — but nobody's acting surface, and its chart is moved by BOTH rounds (sales and the sold-out rise in a Stock Round; every dividend in an Operating Round). A blue edge would claim it for one round and be wrong for half the game. |
| `Game Ledger` (`ledger`) | **neutral** | Lookup in every round |
| `Tiles` (`tiles`) | **neutral** | Lookup in every round (#677) |
| `Rules Reference` (`rules`) | **neutral** | Must not tint the strip above the page whose job is to own these colours |

The three rounds own **one tab each**. The accent is **constant** across inactive / active / hover / focus and
across the current round matching or not matching the tab, so it reads as a property of the surface rather
than as a state of the control.

## How these were captured

The same substrate as `_game-tabs-export/` and `_rules-reference-export/`: those folders' **real rendered DOM
snapshots**, with their game-room strip replaced by the strip freshly rendered from the working-tree
`MainTabBar` (`react-dom/server`, the real component, the real `appStyles` and `palette`). Shot in headless
Chromium at device-pixel-ratio 2.

Pages 02–05 carry a Stock-Round or Operating-Round strip over a page body captured during the auction, because
one auction state is what the source export contains; judge the **strip**, and read the body as context.
Page 06 is the real Rules Reference Overview DOM with the game-room strip composed above it — its `rr-root`
is built with `border-radius: 0 0 10px 10px` precisely to dock under that strip.

`pages/` are the capture pages; `pages-before/` are the same pages with the accent stripped and nothing else
touched — the A/B baseline the measurements below use.

## Screenshots (`screenshots/`)

| State | 430 | 1024 | 1440 | 200% zoom |
|---|---|---|---|---|
| 1. Auction selected during the auction | `01-…-430.png` | `01-…-1024.png` | `01-…-1440.png` | `01-…-zoom200.png` |
| 2. Stocks selected during a stock round | `02-…-430.png` | `02-…-1024.png` | `02-…-1440.png` | `02-…-zoom200.png` |
| 3. Stock Market selected during a stock round | `03-…-430.png` | `03-…-1024.png` | `03-…-1440.png` | `03-…-zoom200.png` |
| 4. Rail Map selected during an operating round | `04-…-430.png` | `04-…-1024.png` | `04-…-1440.png` | `04-…-zoom200.png` |
| 5. Game Ledger selected (neutral utility tab) | `05-…-430.png` | `05-…-1024.png` | `05-…-1440.png` | `05-…-zoom200.png` |
| 6. **Rules Reference Overview under the strip** | `06-…-430.png` | `06-…-1024.png` | `06-…-1440.png` | `06-…-zoom200.png` |

`200% zoom` is a 720 CSS-px viewport at device-pixel-ratio 2 — the same physical area as 1440 px at 200% page
zoom, which is how a browser's page zoom actually presents.

States, at 1440:

| File | State |
|---|---|
| `states-hover-rail-map-1440.png` | pointer hover on an **accented inactive** tab |
| `states-hover-game-ledger-1440.png` | pointer hover on a **neutral inactive** tab |
| `states-focus-1440.png` | **keyboard focus-visible** on an accented inactive tab |

Inactive, active, current-round-matching and current-round-not-matching are all visible in shots 1–6: shot 1
has the accented tab selected, shots 3 and 5 have a neutral tab selected with two accented tabs beside it,
and every shot shows at least one accented tab whose round is not the live one.

## Measurements — the accent changes no geometry

`pages-before` (no accent) against `pages` (accent), same page, same viewport. Every tab's bounding rectangle,
the number of wrapped rows, the strip's height and the document's horizontal overflow, at five widths:

| Page | 360 | 390 | 430 | 1024 | 1440 |
|---|---|---|---|---|---|
| 01 auction | 0 / 0 · 3 rows | 0 / 0 · 3 | 0 / 0 · 3 | 0 / 0 · 1 | 0 / 0 · 1 |
| 02 stocks | 0 / 0 · 3 | 0 / 0 · 3 | 0 / 0 · 3 | 0 / 0 · 1 | 0 / 0 · 1 |
| 03 stock market | 868 / 868 · 3 | 838 / 838 · 3 | 798 / 798 · 3 | 204 / 204 · 1 | 0 / 0 · 1 |
| 04 rail map | 0 / 0 · 3 | 0 / 0 · 3 | 0 / 0 · 3 | 0 / 0 · 1 | 0 / 0 · 1 |
| 05 game ledger | 156 / 156 · 3 | 126 / 126 · 3 | 86 / 86 · 3 | 0 / 0 · 1 | 0 / 0 · 1 |
| 06 rules reference | 406 / 406 · 4 | 376 / 376 · 4 | 336 / 336 · 3 | 0 / 0 · 2 | 0 / 0 · 2 |

Cells are `document overflow before / after` in px, then the strip's wrapped row count (identical before and
after). **Every tab rectangle is identical before and after at every width**, the strip's height is identical
(105 px wrapped, 39 px single-row), and the overflow figures are equal to the pixel.

The non-zero figures are the **captured page bodies**, not the strip: the Stock Market's chart matrix and the
Game Ledger's table do not reflow in a static snapshot, and page 06 composes a reference page captured at
1440 into a narrow viewport. They are unchanged by this slice, which is what the before/after equality says.

A second, independent check compares the untouched `_game-tabs-export/01-auction.htm` against the accented
page in the same state: tab rectangles identical and document `scrollWidth` identical at 360, 390, 430, 1024
and 1440.

## Accessibility

- **Selection without colour**: the selected tab keeps the white edge, the brighter ink, the heavier weight,
  the lift and `aria-current="page"`. Five signals, none a hue — see shot 3 or 5, where the selected tab is
  neutral and still unmistakable.
- **Focus-visible** keeps its own `2px solid #8a8a86` outline at `outline-offset: -2px`. It is a full ring in
  a neutral grey; the affinity is a hue on one edge. They sit adjacent by 1 px and read as different things
  (`states-focus-1440.png`).
- **Hover** keeps its own border and ground, on accented and neutral tabs alike.
- **Disabled** is not a state this strip has: a tab that does not apply to the round is absent from
  `orderedMainTabs` entirely, rather than dimmed.
- **Forced colours**: `@media (forced-colors: active)` drops the box-shadow explicitly and restates the focus
  outline in `currentColor`, so the accent disappears and the two signals that carry meaning — the selected
  tab's border and the focus ring, both repainted by the forced palette — are the only things left.
- **No ARIA** describes the accent. The one attribute added is `data-round-affinity`, inert to assistive
  technology, so the mapping is assertable in the DOM and in this capture.
- **Tab order and keyboard behaviour** are untouched.
