# Mobile-usability pass — Game Ledger and Tiles

All captures: offline sandbox, room `HARNES`, 4 seats (Ada = viewer/host), opening Waterfall Auction,
Phase 2, printed game. App zoom is the app's own width default — **100 %** at 430, **90 %** at 1440.
"Before" = the state captured in `../screenshots/`, i.e. after the cross-app consistency pass and before this one.

| File | What it shows |
|---|---|
| `compare-430-ledger.png` | Game Ledger at 430, before vs after |
| `compare-1440-ledger.png` | Game Ledger at 1440, before vs after (unchanged) |
| `compare-430-tiles.png` | Tiles at 430, before vs after — the height change |
| `compare-1440-tiles.png` | Tiles at 1440, before vs after (grid unchanged, directory added) |
| `after-430-ledger-viewport.png` | **One 430 viewport, as a player sees it** — Game Ledger |
| `after-430-tiles-viewport.png` | **One 430 viewport, as a player sees it** — Tiles, with the directory |
| `after-430-ledger-cue-detail.png` | The cue at 4×, under Bank Treasury |
| `after-430-*.png` / `after-1440-*.png` | Full-page captures of each tab at each width |

## Measured

| | 430 before | 430 after | 1024 after | 1440 after |
|---|---|---|---|---|
| Ledger — Bank Treasury | 480 px in 309, no cue | 480 in 309, **cue** | fits, no cue | fits, no cue |
| Ledger — Bank Depot | 986 in 309, no cue | 986 in 309, **cue** | 986 in 903, **cue** | fits, no cue |
| Ledger — Corporation Assets | 1265 in 309, no cue | 1265 in 309, **cue** | 1265 in 903, **cue** | fits, no cue |
| Ledger cues rendered | 0 | **3** | **2** | **0** |
| Tiles — grid tracks | 1 × 306 px | **2 × 147 px** | 5 × 170 (unchanged) | 9 × 138 (unchanged) |
| Tiles — tile artwork | 84 px | **84 px** | 84 px | 84 px |
| Tiles — page height | 8 902 px | **5 184 px** (−42 %) | 2 887 | 1 865 |

No column was dropped, narrowed, reordered or squeezed; the tables' own `min-width: 480px` still stands.
