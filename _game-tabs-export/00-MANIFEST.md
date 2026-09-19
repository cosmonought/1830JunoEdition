# Project 18XX — static export of the game tabs, lobby and setup screens

Companion to `_rules-reference-export/`, for the same independent design and wording review: does the
Rules Reference share a design language with the rest of the app.

Each `.htm` is a **snapshot of the rendered DOM** from the real application — not a template and not a
transcription. Open any of them directly in a browser: no server, no scripts, no network requests, no
webfonts, no missing images.

This whole folder is disposable — delete `_game-tabs-export/` when the review is done. Nothing in the app
references it.

---

## The state every file was captured in

The app was run in its **offline sandbox** mode, in a four-seat room, at the **opening Waterfall Auction**
(Phase 2, Yellow) — the first live round of a new game.

| | |
|---|---|
| Room | `HARNES`, 4 seats, public |
| Seats | **Ada** (the viewer, and the host), Bell, Cyrus, Dara |
| Round | Waterfall Auction — the private-company auction that opens the printed game |
| Phase | Phase 2 (Yellow) |
| Variants | none — the printed game |
| Viewport | 1440 × 900 CSS px |

All six in-game tabs exist simultaneously in this round, which is why it was chosen: the tab set is
computed per round (`MainTabBar.orderedMainTabs`), and **Auction** only exists during a Waterfall Auction.
One state therefore gives every requested tab, and makes them directly comparable to each other and to the
Rules Reference export, which used one state for the same reason.

---

## Files

### Game tabs (this folder)

| File | Tab | Notes |
|---|---|---|
| `01-auction.htm` | Auction | The live round's own surface; the private-company waterfall with the six companies |
| `02-stocks.htm` | Stocks | Corporation cards. Pre-float, so no share prices yet |
| `03-rail-map.htm` | Rail Map | The board. **The board is a `<canvas>`**, flattened to a PNG — see limitations |
| `04-stock-market.htm` | Stock Market | The chart, with no tokens on it yet this early |
| `05-game-ledger.htm` | Game Ledger | Empty this early — "No activity yet" is the honest opening state |
| `06-tiles.htm` | Tiles | The tile catalog. **49 tile `<canvas>` elements**, each flattened to a PNG |

### Lobby and setup (`lobby-and-setup/`)

| File | Screen |
|---|---|
| `01-lobby.htm` | The lobby, with the sandbox bar's Host game / Join game / Rejoin game |
| `02-host-game-step1-type.htm` | **Host Game, step 1** — Game type, Pace, Visibility |
| `03-host-game-step2-house-rules.htm` | **Host Game, step 2** — Set Ante, Player Count, Tile Set, Bank Size, and the four rule variants |
| `04-join-game.htm` | **Join Game** — the public room list and the room-code box |
| `05-waiting-room.htm` | **Waiting Room** — the roster before the host starts |

`HostSetupCard` is two steps, not one form (its own note: *"the first step changes what the second offers"*),
so both are exported. Each file repeats its screen and state in an HTML comment at the top.

---

## How these were produced, and what that means for fidelity

The application was built from the working-tree source and run headlessly. Two things had to be stood in
for, because they need a backend this export has none of:

1. **The room transport.** Rooms, the roster and the action log normally come from the game server. A
   harness shim served **one fixed room document** instead. This affects *which screen you reach*, not what
   the screen renders: every pixel below the room gate is the app's own code on the app's own state.
2. **The game server URL** was defined to an unreachable address so that the lobby renders its real cards
   rather than its "not configured" notice. The connection then fails, which is why a red
   *"lost the connection to the game server"* banner appears on several screens. **That banner is a genuine
   offline state, not an export artifact** — it is what the app shows when the server is unreachable.

**No file in your repository was modified to produce this.** The shim was applied to a throwaway copy of the
source in the cloud workspace, in two functions (`roomDocOnServer`, `subscribeSandboxRoom`), each guarded so
the real path is unchanged unless a harness global is present.

---

## Limitations of a static export

1. **The board and the tiles are `<canvas>`, so they were flattened to PNGs** at capture time — 1 canvas on
   the Rail Map, 49 on the Tiles tab. They look right and are in the file, but they are images: there is no
   markup to inspect, no hex is selectable, and hover/zoom/pan do nothing. Every `<img>` is marked
   `data-export-note` where this was done.
2. **Controls are inert.** Tabs, buttons, selects and checkboxes do not respond. Their **visible states and
   labels are faithful**, including which tab is marked current and which options are selected.
3. **The connection-error banners are real**, as described above. So is the `🧪 OFFLINE SANDBOX` chip.
4. **Rail Map and Stocks are shown at their thinnest.** During an auction no corporation has floated, so the
   map carries no track or tokens and the corporation cards carry no prices. Reaching an Operating Round
   would have meant driving dozens of game actions through the shim; it was not attempted. Judge those two
   tabs on chrome, hierarchy and labelling rather than on data density.
5. **One viewport.** Everything was captured at 1440 × 900. All CSS is inline in the document, so narrowing
   the window still exercises the app's responsive rules, but anything the app computes in JavaScript from a
   measurement is frozen at the captured width.
6. **Audio and video assets were excluded** from the harness build. Nothing visible depends on them.
7. **Fonts are whatever the app asks for**, resolved from the reviewing machine — no webfonts are fetched.

---

## One thing worth a look while you are in there

`03-host-game-step2-house-rules.htm`: the **Bank Size** select reads **`$4,500`** while the helper line under
it reads **"$12,000 bank. The standard game, as printed."** One of the two is wrong. Flagged, not changed —
this export pass touched no application code.
