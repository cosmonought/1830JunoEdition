# Live-app screenshots — after the cross-app consistency pass

Every capture is the real application running in its **offline sandbox**, room `HARNES`, four seats
(**Ada** = the viewer and host, Bell, Cyrus, Dara), at the **opening Waterfall Auction**, **Phase 2 (Yellow)**,
printed game, no variants. Full-page captures (the whole scrollable page, not just the viewport).

| File | Tab | Viewport | App zoom | Device pixel ratio | Page height |
|---|---|---|---|---|---|
| `1440-auction.png` | Auction | 1440 × 900 | **90 %** (width default) | 2 | 1007 px |
| `1440-stocks.png` | Stocks | 1440 × 900 | 90 % | 2 | 1071 px |
| `1440-rail-map.png` | Rail Map | 1440 × 900 | 90 % | 2 | 1625 px |
| `1440-stock-market.png` | Stock Market | 1440 × 900 | 90 % | 2 | 1287 px |
| `1440-game-ledger.png` | Game Ledger | 1440 × 900 | 90 % | 2 | 1442 px |
| `1440-tiles.png` | Tiles | 1440 × 900 | 90 % | 2 | 1811 px |
| `430-auction.png` | Auction | 430 × 932 | **100 %** (width default) | 2 | 3180 px |
| `430-game-ledger.png` | Game Ledger | 430 × 932 | 100 % | 2 | 2057 px |
| `430-tiles.png` | Tiles | 430 × 932 | 100 % | 2 | 8902 px |
| `detail-auction-labels.png` | Auction, cropped | 1440 × 900 | 90 % | **4** | — |

> **Superseded 2026-09-17 (design note #1450): the width-based default was removed; a clean first run is now 100% at every width. The paragraph below records what these captures were shot under.**

**App zoom is the app's own width-based default, not a setting I chose**: `defaultUiScaleFor(1440)` resolves to
`0.9` and `defaultUiScaleFor(430)` to `1.0`. Both are shown in the top bar of every capture. No stored
preference existed in these browser profiles, so each is the first-guess value a new player would get at that
width. See the zoom diagnosis for what that means.

**What changed in this pass is visible in:**
- `detail-auction-labels.png` — the darkened caption gold on `SPECIAL POWER`, `STANDING BIDS` and the
  `▾ Full Rules` links, at 4× for legibility. Measured live: **4.96:1** on every one of the 18 occurrences.
- `1440-game-ledger.png` / `430-game-ledger.png` — the Bank Depot table's last row now reads
  **`Phase D (Diesel)`**.
- `1440-stocks.png` and `1440-stock-market.png` — no visual change at all; the headings changed element, not
  appearance. `Corporations` is now an `h2`, `Stock Market` an `h2` and `Par / IPO Tray` an `h3`.

**Known state limits** (unchanged from the export set): during the opening auction no corporation has floated,
so Stocks carries no share prices and the Rail Map carries no track or tokens. Judge those two on chrome.
