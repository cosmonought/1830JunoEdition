# AI Architecture Notes — Index

Extracted design commentary for **1830: Juno Edition** (React/Canvas frontend, Rust/CosmWasm
backend, Firebase middleware). This directory is the archive that source files used to carry
inline. Code keeps a 1–2 line comment naming the note; the reasoning lives here.

> **One exception to per-file numbering:** the five rail-map modules
> (`HexGridRenderer.tsx`, `hexCanvasPrimitives.ts`, `hexGeometry.ts`, `TileGraphics.ts`,
> `hexBoardData.ts`) share a **single** `#N` space, because the monolith split moved code *and* its
> notes out of one original file. All five are anchored `HexGridRenderer.tsx #N`.

## How to use this

Source comments reference notes by number, e.g. `// see design note #481`. Every note in this
directory is anchored as **`<source file> #<N>`**, so:

- `Ctrl+F` for `#481` lands on the note.
- The file prefix disambiguates — numbering is **per source file**, so `#3` in `Lobby.tsx` and
  `#3` in `App.tsx` are unrelated notes. Always search the number; the prefix tells you which
  one you found.
- A few notes carry letter suffixes (`#591b`, `#537a`, `#549a`). These are follow-up passes on
  the base note and are filed immediately after it.
- Superseded notes are retained and marked **`[superseded by #N]`** rather than deleted. The
  reasoning trail is the point.

## Domain files

| File | Covers |
|---|---|
| [state_machine.md](state_machine.md) | Round types, Operating Round sub-phase cursor, turn gating, auto-skip, float events, home stations, undo/revert semantics |
| [sandbox_reducer.md](sandbox_reducer.md) | The local reducer's charter, the Operating Round machine, determinism under replay, and the fixtures (`sandboxSession.ts`, `sandboxState.ts`) |
| [firebase_middleware.md](firebase_middleware.md) | Event-sourced room log, replay drain, setup event, presence, chat transport, the chain/Firestore boundary, room codes, Firebase config |
| [canvas_rendering.md](canvas_rendering.md) | The rail map renderer: radial tile selector, board veil/dimming, cursor modes, tile preview, the camera, margin labels, layer order, route overlays |
| [hex_tile_math.md](hex_tile_math.md) | Bezier track splines, the hand-authored artwork catalog, the 13-slot placement engine, station/token docking geometry, board data and palettes |
| [stock_market.md](stock_market.md) | Par values, IPO vs bank pool pricing, market chart marks and moves, stock round cards |
| [contract_economy.md](contract_economy.md) | Treasuries, token pricing, train purchase and the depot queue, emergency funding, bankruptcy, private companies, the waterfall auction |
| [routing_pathfinding.md](routing_pathfinding.md) | Route drafting, waypoints and bridging, revenue centres vs hexes, train capacity, auto-route |
| [ui_shell_layout.md](ui_shell_layout.md) | Tabs, top ticker and activity feed, dock height reservation, turn notifications, inline styles |
| [session_keys_wallet.md](session_keys_wallet.md) | Wallet and `x/authz` session keys, spectator/read-only mode, viewer identity, sandbox identity |

## Recurring principles

These arguments appear across many notes and are worth reading once:

1. **One question, one answer.** The project's most common bug class is two values that are
   supposed to encode the same fact drifting apart (`#559`, `#576`, `#580`, `#587`, `#601`).
   When a rule needs enforcing twice, share the predicate rather than reimplementing it.
2. **Gate at the dispatch, not on the button.** Disabled controls are a courtesy; the guarantee
   is the check inside `runGameplayAction`. See `App.tsx #23`, `#536`.
3. **Ignorance permits — usually.** `null` means "not asked" and must be distinguished from a
   real `0`. Which direction is safe depends on the cost of each mistake: see `#293b` and
   `#433` for the same field being read the opposite way in two places, deliberately.
4. **Derive the question, do not latch it.** State derived from the board cannot go stale,
   cannot be raised twice, and cannot survive the thing that resolved it (`#565`, `#416`).
5. **The contract is the authority.** The frontend may pre-check to save a signature and a gas
   fee, never to become a second rulebook. A client-side copy of a rule can only drift.
6. **Fire on the edge, not on the condition.** Effects that dispatch must compare against a
   previous-value ref, or they re-broadcast on every render until the next poll lands.
7. **If the reducer needs it to decide, it travels in the message.** Context (`ctx`) is only for
   things identical on every client by construction — the map, the era. A shared fact derived from a
   per-browser value diverges silently under replay: `sandboxSession.ts #549` (the actor), `#553`
   (the par ladder), `#579` (the price) are the same bug three times.
8. **A value that must be correct, read from a field nothing writes.** The other repeat offender:
   `sandboxSession.ts #411`, `#431`, `#621` and `#642` are one defect in four places. Stamp every
   bookkeeping value where the round opens, together, so a reader sees the whole opening position.
9. **A UI quoting a transaction the state does not perform.** The renderer drew $80 while the
   reducer charged $20 (`#432`); the modal promised the president's money and nothing took it
   (`#333`); the badge promised an auto-award nothing performed (`#336`). When a surface describes an
   action, something must actually do it.
10. **Sort comparators must be total.** `NaN` or an incomparable pair makes `sort` produce an order
    that is not an order — which lands the Operating Round cursor on a corporation that has already
    operated (`#468`, `#646`).
11. **Disabled claims; hidden does not.** A disabled control asserts "this action is available here,
    blocked for a reason you might fix." The discriminator is whether the player can *ever* act here:
    a rule that lifts next round is worth a disabled button carrying its reason (`StockRoundPanel.tsx
    #418`, `#36`), a round the action does not belong to is worth no button at all
    (`StockRoundPanel.tsx #417`, `ContextualActionBar.tsx #413`).
12. **A flag that is provably always false is not a switch.** Dead branches compile and lint, and
    everything around them keeps looking live — so the next reader (or the next legend) treats them as
    real: `StockMarketRenderer.tsx #652` (a `false &&` game-end cell that got its own legend row),
    `ContextualActionBar.tsx #601` (forty lines of unreachable render behind two conditions that were
    one condition), `#654` (a three-column grid given two children).

## Batch status

| Batch | Scope | State |
|---|---|---|
| 0 | Scaffold this directory | Done |
| 1 | `frontend/src/App.tsx` | Done |
| 2 | Firebase middleware (`sandboxSession`, `sandboxState`, `sandboxRoom`, `config/firebase`, `actionLog`, `feed`) | Done |
| 3 | Canvas rendering + tile math (incl. the Phase 0 legacy fold) | Done |
| 4 | Stock market + trading UI (`StockMarketRenderer`, `StockRoundPanel`, `WaterfallAuctionDashboard`, `ContextualActionBar`) | Done |
| 5 | Remaining frontend files | Pending |
| 6 | Rust contract backend | Pending |

Test files (`src/tests.rs`, `frontend/src/**/*.test.ts`) are out of scope by decision — they
are self-documenting.

> **Known residue from batches 1–3.** Those passes scanned *own-line* comment groups only, so JSX
> comment containers (`{/* … */}`) were skipped. `App.tsx` (368 lines / 33 blocks) and
> `HexGridRenderer.tsx` (27 lines / 3 blocks) still carry theirs; the `.ts` files carry none. Batch 4
> extracts both forms. Scheduled for the final verification pass.

---

## Anchor index — Batch 4 (stock market, roster, auction, action bar)

Every `#N` these four files cite, and the document section that covers it. Numbering is per source
file; a few notes are discussed inside a combined section, which is why the heading may name a
different number.

### StockMarketRenderer.tsx

| anchor | document | section |
|---|---|---|
| `StockMarketRenderer.tsx #1` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #1 — The chart is a sourced mask, not a formula |
| `StockMarketRenderer.tsx #2` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #2 — DOM/CSS grid, not canvas |
| `StockMarketRenderer.tsx #3` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #3 — The zones are cumulative, and that is this project's reading |
| `StockMarketRenderer.tsx #4` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #4 — The par boxes are at their true board coordinates |
| `StockMarketRenderer.tsx #5` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #5 — Token stacking, via an independent grid item |
| `StockMarketRenderer.tsx #6` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #6 / #428 — One livery table, three former mirrors |
| `StockMarketRenderer.tsx #7` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #7 — Cell boundary lines |
| `StockMarketRenderer.tsx #8` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #8 — Defensive token placement |
| `StockMarketRenderer.tsx #10` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #10 — The Par/IPO tray  *[data source superseded by #24]* |
| `StockMarketRenderer.tsx #13` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #12 / #13 — Measured cell size, derived font size |
| `StockMarketRenderer.tsx #14` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #14 (helper deletion) — `isRealMarketCell` removed rather than silenced |
| `StockMarketRenderer.tsx #16` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #14 (palette decoupling) / #16 / #22 — Tray palette, tooltips, terminology |
| `StockMarketRenderer.tsx #17` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #11 / #17 — Gradients are clipped to their own cell |
| `StockMarketRenderer.tsx #18` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #18 — Final visual theme pass |
| `StockMarketRenderer.tsx #19` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #19 — Legend relocation and grid-scale maximization |
| `StockMarketRenderer.tsx #20` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #15 — The column-6 hard-block, and the accuracy correction it surfaced  *[superseded by #20]* |
| `StockMarketRenderer.tsx #21` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #21 — Page-level scrolling, and why this needs no height math |
| `StockMarketRenderer.tsx #22` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #14 (palette decoupling) / #16 / #22 — Tray palette, tooltips, terminology |
| `StockMarketRenderer.tsx #23` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #23(3) / #24(2) — Station-token circles, sized and clustered |
| `StockMarketRenderer.tsx #24` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #10 — The Par/IPO tray  *[data source superseded by #24]* |
| `StockMarketRenderer.tsx #25` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #25 / #26 — The matrix dominates |
| `StockMarketRenderer.tsx #26` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #25 / #26 — The matrix dominates |
| `StockMarketRenderer.tsx #27` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #9 / #27 / #652 — $350 is a ceiling, not an ending |
| `StockMarketRenderer.tsx #43` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #43 / #43a — A cliff is a property of the ROW, and only if there is somewhere to go |
| `StockMarketRenderer.tsx #43a` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #43 / #43a — A cliff is a property of the ROW, and only if there is somewhere to go |
| `StockMarketRenderer.tsx #187` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #187 — Projecting the dividend move  *[superseded by #434]* |
| `StockMarketRenderer.tsx #196` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #196 — The zones are a vocabulary, not this chart's decor |
| `StockMarketRenderer.tsx #385` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #387 — No par, no token. Enforced at the renderer. |
| `StockMarketRenderer.tsx #387` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #387 — No par, no token. Enforced at the renderer. |
| `StockMarketRenderer.tsx #402` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #402 — The gold frame sits in the grid, not on it |
| `StockMarketRenderer.tsx #415` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #415 — The par box is a coordinate, not a price match |
| `StockMarketRenderer.tsx #428` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #6 / #428 — One livery table, three former mirrors |
| `StockMarketRenderer.tsx #429` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #429 — The herald is bounded to the circle |
| `StockMarketRenderer.tsx #430` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #430 — Where a herald stops being legible |
| `StockMarketRenderer.tsx #434` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #187 — Projecting the dividend move  *[superseded by #434]* |
| `StockMarketRenderer.tsx #452` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #452 — A crowded cell has to be readable |
| `StockMarketRenderer.tsx #648` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #648 — The cell is the hover target, not the token |
| `StockMarketRenderer.tsx #649` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #24(1) — Par-cell number clipping  *[undone by #649]* |
| `StockMarketRenderer.tsx #650` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #650 — The par cells are tinted, not framed |
| `StockMarketRenderer.tsx #651` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #651 — The colours have to say what they mean |
| `StockMarketRenderer.tsx #652` | [stock_market.md](stock_market.md) | StockMarketRenderer.tsx #9 / #27 / #652 — $350 is a ceiling, not an ending |

### StockRoundPanel.tsx

| anchor | document | section |
|---|---|---|
| `StockRoundPanel.tsx #3` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #3 — The par grid only matters pre-float |
| `StockRoundPanel.tsx #8` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #8 — The corporation roster, and why the president is the point |
| `StockRoundPanel.tsx #9` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #9 — Paper cards |
| `StockRoundPanel.tsx #10` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #10 — Actions live in the card |
| `StockRoundPanel.tsx #11` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #11 — Responsive without a media query |
| `StockRoundPanel.tsx #13` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #13 (market price prop) — A separate prop, because it is separate data |
| `StockRoundPanel.tsx #15` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #9 — Paper cards |
| `StockRoundPanel.tsx #16` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #16 / #26 — The entire card surface is the toggle |
| `StockRoundPanel.tsx #17` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #10 — Actions live in the card |
| `StockRoundPanel.tsx #18` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #18 — Buy source is local |
| `StockRoundPanel.tsx #19` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #19 / #22 / #30 — The slashed sell row |
| `StockRoundPanel.tsx #20` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #20 — Sell size is local too, and this is what fixes the stuck highlight |
| `StockRoundPanel.tsx #21` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #21 — Only sources that actually hold certificates  *[superseded by #36]* |
| `StockRoundPanel.tsx #22` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #19 / #22 / #30 — The slashed sell row |
| `StockRoundPanel.tsx #23` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #23 — `start`, not `stretch`; and the whole card is the toggle |
| `StockRoundPanel.tsx #24` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #4 / #24 / #445 — Float is the 60% rule, with no exceptions |
| `StockRoundPanel.tsx #25` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #25 — No holding, no Sell |
| `StockRoundPanel.tsx #26` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #26 — The card paradigm test  *[superseded by #388]* |
| `StockRoundPanel.tsx #28` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #28 — The call to action on an unparred company |
| `StockRoundPanel.tsx #29` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #29 — The target company travels with the click |
| `StockRoundPanel.tsx #30` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #19 / #22 / #30 — The slashed sell row |
| `StockRoundPanel.tsx #31` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #31 / #489 / #504 — The operating snapshot strip |
| `StockRoundPanel.tsx #32` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #32 — Trading is a Stock Round action  *[superseded by #417]* |
| `StockRoundPanel.tsx #33` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #33 — The Brown zone's multi-buy |
| `StockRoundPanel.tsx #34` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #34 — Hotseat, and who is up |
| `StockRoundPanel.tsx #35` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #35 — The buy button always prices itself |
| `StockRoundPanel.tsx #36` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #35 / #36 / #587 — The first purchase is a President's Certificate |
| `StockRoundPanel.tsx #345` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #345 — One float readout, not two |
| `StockRoundPanel.tsx #346` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #346 — The source is a switch, not two buttons |
| `StockRoundPanel.tsx #347` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #347 / #466 — Disabled controls compute their own look |
| `StockRoundPanel.tsx #348` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #348 — A flipped card belongs to whoever flipped it |
| `StockRoundPanel.tsx #355` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #388 — The flip is gone |
| `StockRoundPanel.tsx #356` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #356 — Nobody sells in Stock Round 1 |
| `StockRoundPanel.tsx #357` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #357 — A player cannot spend what they do not have |
| `StockRoundPanel.tsx #378` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #378 / #466 / #507 — The ownership table is a grid, and its width is one number |
| `StockRoundPanel.tsx #387` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #387 — No par, no market figure |
| `StockRoundPanel.tsx #388` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #26 — The card paradigm test  *[superseded by #388]* |
| `StockRoundPanel.tsx #389` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #389 / #501 / #503 — Livery stripe, herald, captioned badge |
| `StockRoundPanel.tsx #391` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #391 / #395 — The canonical rules text a private row expands to |
| `StockRoundPanel.tsx #392` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #393 / #409 / #392 — What rides on the card, and what does not |
| `StockRoundPanel.tsx #393` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #393 / #409 / #392 — What rides on the card, and what does not |
| `StockRoundPanel.tsx #394` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #394 — Entity / Shares / Price |
| `StockRoundPanel.tsx #395` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #391 / #395 — The canonical rules text a private row expands to |
| `StockRoundPanel.tsx #396` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #396 — One card holds the controls |
| `StockRoundPanel.tsx #397` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #397 — Par comes before the President's Share |
| `StockRoundPanel.tsx #398` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #398 — The par selection is a lookup, not a value |
| `StockRoundPanel.tsx #399` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #399 / #415 — The ladder is derived from the board's own par boxes |
| `StockRoundPanel.tsx #408` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #408 — The palette is the physical board's |
| `StockRoundPanel.tsx #409` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #393 / #409 / #392 — What rides on the card, and what does not |
| `StockRoundPanel.tsx #410` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #410 — The historical herald replaces the acronym |
| `StockRoundPanel.tsx #415` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #399 / #415 — The ladder is derived from the board's own par boxes |
| `StockRoundPanel.tsx #417` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #32 — Trading is a Stock Round action  *[superseded by #417]* |
| `StockRoundPanel.tsx #418` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #418 — The SR1 ban reached the selector, not the button |
| `StockRoundPanel.tsx #421` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #421 — The highlight follows the reader |
| `StockRoundPanel.tsx #423` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #423 — Two renderers of one fact drift apart |
| `StockRoundPanel.tsx #424` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #424 — The capacity, drawn |
| `StockRoundPanel.tsx #428` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #428 — One livery table |
| `StockRoundPanel.tsx #445` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #4 / #24 / #445 — Float is the 60% rule, with no exceptions |
| `StockRoundPanel.tsx #446` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #446 — Floated companies sorted to the front  *[superseded by #464]* |
| `StockRoundPanel.tsx #447` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #393 / #409 / #392 — What rides on the card, and what does not |
| `StockRoundPanel.tsx #448` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #448 — Nine certificates, not ten |
| `StockRoundPanel.tsx #464` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #464 — Order recomputed at the Operating Round boundary |
| `StockRoundPanel.tsx #465` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #465 — The acronym comes back |
| `StockRoundPanel.tsx #466` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #378 / #466 / #507 — The ownership table is a grid, and its width is one number |
| `StockRoundPanel.tsx #488` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #389 / #501 / #503 — Livery stripe, herald, captioned badge |
| `StockRoundPanel.tsx #489` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #31 / #489 / #504 — The operating snapshot strip |
| `StockRoundPanel.tsx #490` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #490 / #552 — The crown, as a drawing |
| `StockRoundPanel.tsx #501` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #389 / #501 / #503 — Livery stripe, herald, captioned badge |
| `StockRoundPanel.tsx #502` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #502 — The `$` |
| `StockRoundPanel.tsx #503` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #389 / #501 / #503 — Livery stripe, herald, captioned badge |
| `StockRoundPanel.tsx #504` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #31 / #489 / #504 — The operating snapshot strip |
| `StockRoundPanel.tsx #507` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #378 / #466 / #507 — The ownership table is a grid, and its width is one number |
| `StockRoundPanel.tsx #552` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #490 / #552 — The crown, as a drawing |
| `StockRoundPanel.tsx #577` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #393 / #409 / #392 — What rides on the card, and what does not |
| `StockRoundPanel.tsx #587` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #35 / #36 / #587 — The first purchase is a President's Certificate |

### WaterfallAuctionDashboard.tsx

| anchor | document | section |
|---|---|---|
| `WaterfallAuctionDashboard.tsx #2` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #2 — Always all six, in the query's own ascending order |
| `WaterfallAuctionDashboard.tsx #11` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #11 — Stacked, not side by side |
| `WaterfallAuctionDashboard.tsx #12` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #12 / #18 — Certificates, one fill, state at the edges |
| `WaterfallAuctionDashboard.tsx #13` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #13 — No enforcement badge on a special power |
| `WaterfallAuctionDashboard.tsx #14` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #14 (action selection) — Each card offers exactly one thing |
| `WaterfallAuctionDashboard.tsx #17` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #14 → #17 — Flat actions, no accordion |
| `WaterfallAuctionDashboard.tsx #18` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #12 / #18 — Certificates, one fill, state at the edges |
| `WaterfallAuctionDashboard.tsx #19` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #19 — One standings table per card |
| `WaterfallAuctionDashboard.tsx #20` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #20 / #21 — The buttons form a line, and the bid table must not grow the card |
| `WaterfallAuctionDashboard.tsx #21` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #20 / #21 — The buttons form a line, and the bid table must not grow the card |
| `WaterfallAuctionDashboard.tsx #22` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #22 — The opening bid is face value PLUS the increment |
| `WaterfallAuctionDashboard.tsx #23` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #23 (status) — Bid counts map to the real cascade semantics |
| `WaterfallAuctionDashboard.tsx #26` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #32 / #320 / #344 — The mini-auction chaser |
| `WaterfallAuctionDashboard.tsx #27` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #27 — Input, Raise and Drop Out on one line |
| `WaterfallAuctionDashboard.tsx #28` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #28 / #30 — A won private holds its slot and greys out |
| `WaterfallAuctionDashboard.tsx #29` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #29 / #302 / #422 — Competing bids, the leader, and the turn |
| `WaterfallAuctionDashboard.tsx #30` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #30 — Hotseat has no wallet to compare against |
| `WaterfallAuctionDashboard.tsx #31` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #31 — The sandbox seats were distinct and looked identical |
| `WaterfallAuctionDashboard.tsx #32` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #32 / #320 / #344 — The mini-auction chaser |
| `WaterfallAuctionDashboard.tsx #38` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #38 — The lowest-offered card's border is neutral |
| `WaterfallAuctionDashboard.tsx #302` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #29 / #302 / #422 — Competing bids, the leader, and the turn |
| `WaterfallAuctionDashboard.tsx #303` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #303 — What each private actually sold for |
| `WaterfallAuctionDashboard.tsx #304` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #304 — The printed number |
| `WaterfallAuctionDashboard.tsx #305` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #305 — One line, not three saying the same thing |
| `WaterfallAuctionDashboard.tsx #306` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #306 — "Is concluding" is not a state a player can leave |
| `WaterfallAuctionDashboard.tsx #308` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #308 — The acting player, named and funded |
| `WaterfallAuctionDashboard.tsx #312` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #312 — Two privates cannot reserve one hex |
| `WaterfallAuctionDashboard.tsx #314` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #314 — Whose money the controls are about to spend |
| `WaterfallAuctionDashboard.tsx #315` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #315 — The affordability gate |
| `WaterfallAuctionDashboard.tsx #319` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #319 / #321 — Cursors and glyphs that stopped meaning anything |
| `WaterfallAuctionDashboard.tsx #320` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #32 / #320 / #344 — The mini-auction chaser |
| `WaterfallAuctionDashboard.tsx #321` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #319 / #321 — Cursors and glyphs that stopped meaning anything |
| `WaterfallAuctionDashboard.tsx #322` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #322 — One answer to "whose turn is it" |
| `WaterfallAuctionDashboard.tsx #340` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #340 — Winning a company should not erase it |
| `WaterfallAuctionDashboard.tsx #341` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #341 — The table is the panel |
| `WaterfallAuctionDashboard.tsx #344` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #32 / #320 / #344 — The mini-auction chaser |
| `WaterfallAuctionDashboard.tsx #384` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #384 — One bid per private, in the waterfall proper |
| `WaterfallAuctionDashboard.tsx #391` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #391 — The catalog moved to `utils/privateCatalog.ts` |
| `WaterfallAuctionDashboard.tsx #422` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #29 / #302 / #422 — Competing bids, the leader, and the turn |
| `WaterfallAuctionDashboard.tsx #547` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #547 — The concluding button moved to `AuctionPromptModal` |
| `WaterfallAuctionDashboard.tsx #593` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #604 — The player cards arrive as a node |
| `WaterfallAuctionDashboard.tsx #602` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #604 — The player cards arrive as a node |
| `WaterfallAuctionDashboard.tsx #604` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #604 — The player cards arrive as a node |
| `WaterfallAuctionDashboard.tsx #610` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #610 — The pass counter moved to the seats it counted |

### ContextualActionBar.tsx

| anchor | document | section |
|---|---|---|
| `ContextualActionBar.tsx #0` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #237 — Tokens, not a fraction |
| `ContextualActionBar.tsx #1` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #144 / #212 — The stepper is read-only, and Skip is a real message |
| `ContextualActionBar.tsx #4` | [ui_shell_layout.md](ui_shell_layout.md) | Short notes and cross-references — `ContextualActionBar.tsx` |
| `ContextualActionBar.tsx #7` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #248 / #259 / #372 — The train limit, and the rust countdown |
| `ContextualActionBar.tsx #8` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #10 (item 2) / marketplace tray — Phase 4 selection is cosmetic |
| `ContextualActionBar.tsx #9` | [ui_shell_layout.md](ui_shell_layout.md) | Short notes and cross-references — `ContextualActionBar.tsx` |
| `ContextualActionBar.tsx #10` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #10 (item 2) / marketplace tray — Phase 4 selection is cosmetic |
| `ContextualActionBar.tsx #11` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #33 — The route toggle is a run-trains tool, not a global one |
| `ContextualActionBar.tsx #14` | [ui_shell_layout.md](ui_shell_layout.md) | Short notes and cross-references — `ContextualActionBar.tsx` |
| `ContextualActionBar.tsx #18` | [ui_shell_layout.md](ui_shell_layout.md) | Short notes and cross-references — `ContextualActionBar.tsx` |
| `ContextualActionBar.tsx #29` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #29 — Dead props are not free |
| `ContextualActionBar.tsx #31` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #31 — One bar, everywhere |
| `ContextualActionBar.tsx #33` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #33 — The route toggle is a run-trains tool, not a global one |
| `ContextualActionBar.tsx #47` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #47 — Hover and focus states inline styles cannot express |
| `ContextualActionBar.tsx #142` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #142 / #266 — Running trains is its own phase |
| `ContextualActionBar.tsx #144` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #144 / #212 — The stepper is read-only, and Skip is a real message |
| `ContextualActionBar.tsx #159` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #159 — Whether station-token targeting is armed |
| `ContextualActionBar.tsx #164` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #164 — The Operating Round panel is two rows |
| `ContextualActionBar.tsx #165` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #165 — The inline Buy-Private tray is gone |
| `ContextualActionBar.tsx #181` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #181 — The price is on the button |
| `ContextualActionBar.tsx #182` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #203 / #508 — One purchase component, at a new address |
| `ContextualActionBar.tsx #188` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #188 / #490 / #509 — The consequence belongs to the button |
| `ContextualActionBar.tsx #196` | [stock_market.md](stock_market.md) | ContextualActionBar.tsx #197 — The market move line |
| `ContextualActionBar.tsx #197` | [stock_market.md](stock_market.md) | ContextualActionBar.tsx #197 — The market move line |
| `ContextualActionBar.tsx #203` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #203 / #508 — One purchase component, at a new address |
| `ContextualActionBar.tsx #212` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #144 / #212 — The stepper is read-only, and Skip is a real message |
| `ContextualActionBar.tsx #214` | [stock_market.md](stock_market.md) | ContextualActionBar.tsx #214 — The arrow carries the meaning  *[glyph superseded by #489]* |
| `ContextualActionBar.tsx #228` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #228 — Whose turn is it, and what do they have |
| `ContextualActionBar.tsx #235` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #258 / #263 — Skip is an action, so it sits with the actions |
| `ContextualActionBar.tsx #236` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #236 — The bar wears the corporation's colour |
| `ContextualActionBar.tsx #237` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #237 — Tokens, not a fraction |
| `ContextualActionBar.tsx #248` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #248 / #259 / #372 — The train limit, and the rust countdown |
| `ContextualActionBar.tsx #258` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #258 / #263 — Skip is an action, so it sits with the actions |
| `ContextualActionBar.tsx #259` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #248 / #259 / #372 — The train limit, and the rust countdown |
| `ContextualActionBar.tsx #263` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #258 / #263 — Skip is an action, so it sits with the actions |
| `ContextualActionBar.tsx #266` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #142 / #266 — Running trains is its own phase |
| `ContextualActionBar.tsx #275` | [ui_shell_layout.md](ui_shell_layout.md) | Short notes and cross-references — `ContextualActionBar.tsx` |
| `ContextualActionBar.tsx #278` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #278 — A corporation that earned cannot decline |
| `ContextualActionBar.tsx #279` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #279 — No placeholder where a control should be |
| `ContextualActionBar.tsx #293` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #293 — A corporation must own a train |
| `ContextualActionBar.tsx #293b` | [ui_shell_layout.md](ui_shell_layout.md) | Short notes and cross-references — `ContextualActionBar.tsx` |
| `ContextualActionBar.tsx #297` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #297 / #298 — Pinned to the top, so the bar sheds its chrome |
| `ContextualActionBar.tsx #298` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #298 — What a pinned bar is allowed to keep  *[reversed by #590]* |
| `ContextualActionBar.tsx #300` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #300 — The player's own money was nowhere on this panel |
| `ContextualActionBar.tsx #308` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #308 — The auction bar had neither name nor money |
| `ContextualActionBar.tsx #309` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #636 — The same three rows as an Operating Round |
| `ContextualActionBar.tsx #317` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #601 — The roster pills were unreachable |
| `ContextualActionBar.tsx #325` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #325 / #326 — Two pockets, one row, constant confusion |
| `ContextualActionBar.tsx #326` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #325 / #326 — Two pockets, one row, constant confusion |
| `ContextualActionBar.tsx #329` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #379 (strip half) — Privates the company owns |
| `ContextualActionBar.tsx #339` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #339 — The auction is a round, and the bar said it was not |
| `ContextualActionBar.tsx #342` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #601 — The roster pills were unreachable |
| `ContextualActionBar.tsx #362` | [ui_shell_layout.md](ui_shell_layout.md) | Short notes and cross-references — `ContextualActionBar.tsx` |
| `ContextualActionBar.tsx #372` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #248 / #259 / #372 — The train limit, and the rust countdown |
| `ContextualActionBar.tsx #373` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #373 — The shared route cursor, owned by the shell |
| `ContextualActionBar.tsx #375` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #375 — Interactive only during Run Routes |
| `ContextualActionBar.tsx #379` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #379 (strip half) — Privates the company owns |
| `ContextualActionBar.tsx #390` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #390 / #404 — One button, and nothing else |
| `ContextualActionBar.tsx #404` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #390 / #404 — One button, and nothing else |
| `ContextualActionBar.tsx #406` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #601 — The roster pills were unreachable |
| `ContextualActionBar.tsx #407` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #407 — Revenue shown, not hovered |
| `ContextualActionBar.tsx #410` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #575 / #589 / #410 / #465 — The bar names a corporation the way the card does |
| `ContextualActionBar.tsx #413` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #413 — The bar now asks whose turn it is |
| `ContextualActionBar.tsx #414` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #414 — There is no such thing as paying $0 |
| `ContextualActionBar.tsx #426` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #482 — A `1fr` track refuses to shrink below its content |
| `ContextualActionBar.tsx #436` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #436 — $0 is a decision too, and Skip is not it |
| `ContextualActionBar.tsx #439` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #451 — Undo, and what it would undo |
| `ContextualActionBar.tsx #441` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #441 — A corporate power belongs to the corporation operating |
| `ContextualActionBar.tsx #442` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #442 — Keyed by ACTION, not by private id |
| `ContextualActionBar.tsx #451` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #451 — Undo, and what it would undo |
| `ContextualActionBar.tsx #458` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #482 — A `1fr` track refuses to shrink below its content |
| `ContextualActionBar.tsx #465` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #575 / #589 / #410 / #465 — The bar names a corporation the way the card does |
| `ContextualActionBar.tsx #480` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #480 — Measure the panel, not the page |
| `ContextualActionBar.tsx #481` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #481 — The stepper row was a row for one word |
| `ContextualActionBar.tsx #482` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #482 — A `1fr` track refuses to shrink below its content |
| `ContextualActionBar.tsx #485` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #485 — Skip is never a dividend declaration |
| `ContextualActionBar.tsx #485a` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #485a — One revenue figure, four surfaces |
| `ContextualActionBar.tsx #486` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #485a — One revenue figure, four surfaces |
| `ContextualActionBar.tsx #489` | [stock_market.md](stock_market.md) | ContextualActionBar.tsx #214 — The arrow carries the meaning  *[glyph superseded by #489]* |
| `ContextualActionBar.tsx #490` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #188 / #490 / #509 — The consequence belongs to the button |
| `ContextualActionBar.tsx #491` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #203 / #508 — One purchase component, at a new address |
| `ContextualActionBar.tsx #493` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #493 — Re-run the tracer. An action, not a mode. |
| `ContextualActionBar.tsx #494` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #494 — The per-train route ink |
| `ContextualActionBar.tsx #498` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #498 — Except during Run Routes, which IS the board |
| `ContextualActionBar.tsx #500` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #500 — The ticker leaves the bar entirely |
| `ContextualActionBar.tsx #508` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #203 / #508 — One purchase component, at a new address |
| `ContextualActionBar.tsx #509` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #188 / #490 / #509 — The consequence belongs to the button |
| `ContextualActionBar.tsx #509a` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #509a — Show the money moving, do not describe it |
| `ContextualActionBar.tsx #510` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #510 — A jump button with nothing to jump to |
| `ContextualActionBar.tsx #517` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #517 — Which Operating Round this is |
| `ContextualActionBar.tsx #518` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #518 — The trail, when there is room for it |
| `ContextualActionBar.tsx #540` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #540 — A divider needs something on both sides |
| `ContextualActionBar.tsx #545` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #545 — What the mini-auction chase animation meant |
| `ContextualActionBar.tsx #552` | [ui_shell_layout.md](ui_shell_layout.md) | Short notes and cross-references — `ContextualActionBar.tsx` |
| `ContextualActionBar.tsx #569` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #570 — The bar wears whose turn it is |
| `ContextualActionBar.tsx #570` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #570 — The bar wears whose turn it is |
| `ContextualActionBar.tsx #573b` | [ui_shell_layout.md](ui_shell_layout.md) | Short notes and cross-references — `ContextualActionBar.tsx` |
| `ContextualActionBar.tsx #575` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #575 / #589 / #410 / #465 — The bar names a corporation the way the card does |
| `ContextualActionBar.tsx #589` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #575 / #589 / #410 / #465 — The bar names a corporation the way the card does |
| `ContextualActionBar.tsx #590` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #298 — What a pinned bar is allowed to keep  *[reversed by #590]* |
| `ContextualActionBar.tsx #592c` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #592c — One Undo button, not two |
| `ContextualActionBar.tsx #592d` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #592d — Undo is not a move, so it is not turn-gated |
| `ContextualActionBar.tsx #595` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #595 / #595a — The seat-order trail, for the two seat-driven rounds |
| `ContextualActionBar.tsx #595a` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #595 / #595a — The seat-order trail, for the two seat-driven rounds |
| `ContextualActionBar.tsx #597` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #597 / #597a — The handoff band |
| `ContextualActionBar.tsx #597a` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #597 / #597a — The handoff band |
| `ContextualActionBar.tsx #601` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #601 — The roster pills were unreachable |
| `ContextualActionBar.tsx #613` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #613 — `Buy Private` shows in Phases 3 and 4 only |
| `ContextualActionBar.tsx #619` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #619 — Say the obligation, do not only refuse it |
| `ContextualActionBar.tsx #623` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #623 — `RunRoutesButton` joins the step's finishing action to the bar |
| `ContextualActionBar.tsx #630` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #630 — Both rounds put their track in the same place |
| `ContextualActionBar.tsx #631` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #631 — The seat card, built like the corporation card |
| `ContextualActionBar.tsx #636` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #636 — The same three rows as an Operating Round |
| `ContextualActionBar.tsx #654` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #654 — The grid had three columns and two children |
