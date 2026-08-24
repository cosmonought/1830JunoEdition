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

## Process

| File | Covers |
|---|---|
| [working_agreement.md](working_agreement.md) | How changes get verified: `npm run verify`, batch size, playtest boundaries, and the invariants a new ref or cache has to declare. Written after #757 produced #762, #766 and #767 in a row. |

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
| [utils_layer.md](utils_layer.md) | The `utils/` layer: hand-kept `msg.rs` mirrors, polling hooks, certificate and net-worth derivation, who-acts-next resolution |
| [rules_and_sourcing.md](rules_and_sourcing.md) | Where the 1830 numbers come from, how they were verified, and the rule corrections that verification forced |

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
13. **A rule stated in prose and nowhere else is worse than one not stated at all**, because the game
    teaches the player a rule and then does not keep it. `baltimorePrivate.ts #660` found both B&O
    private rules written verbatim in `privateCatalog.ts` and on screen in the powers panel, with
    nothing enforcing either; `StockMarketRenderer.tsx #652`'s "GAME END" tooltip on a cell that ended
    nothing is the same defect. Copy that describes a rule is a specification, and something must
    implement it.
14. **Derive it; do not keep a second copy.** The repeat fix across this batch and the last:
    `auctionEscrow.ts #1` (available cash from the bid list rather than a deducted balance kept in
    step through six operations), `passedSeats.ts #610` (read `consecutive_passes` rather than track a
    "who passed" set), `privateReservations.ts #1` (read the live roster rather than bake a hex list),
    `tileSupply.ts #627` (count the board rather than mirror `REMAINING_TILES`). Where a second
    implementation is accepted, the two conditions that make it safe are stated: it must be **total**
    rather than incremental, so it cannot drift; and it must be **read-only**, so a wrong answer
    mislabels a control rather than losing a piece.
15. **A transition is noticed; a state is not.** Habituation is not a contrast problem, it is a
    "nothing is happening" problem — a continuous animation is already running when you look back, so
    it carries no arrival. `animations.ts #597` replaced a permanent band and a continuous pulse with
    a one-shot sweep keyed on the acting seat, because motion that *starts* is caught peripherally and
    motion that ends costs nothing for the rest of the turn.

## Batch status

| Batch | Scope | State |
|---|---|---|
| 0 | Scaffold this directory | Done |
| 1 | `frontend/src/App.tsx` | Done |
| 2 | Firebase middleware (`sandboxSession`, `sandboxState`, `sandboxRoom`, `config/firebase`, `actionLog`, `feed`) | Done |
| 3 | Canvas rendering + tile math (incl. the Phase 0 legacy fold) | Done |
| 4 | Stock market + trading UI (`StockMarketRenderer`, `StockRoundPanel`, `WaterfallAuctionDashboard`, `ContextualActionBar`) | Done |
| 5A | JSX residue (`App.tsx`, `HexGridRenderer.tsx`) + the eight heaviest tail files (`appStyles`, `RadialTileSelector`, `TrainPurchasePanel`, `gameState`, `RulesReference`, `hexContractTypes`, `TileSelectionPopup`, `FinancialLedger`) | Done |
| 5B | The 19 heaviest remaining frontend files (`TopTicker`, `gameSetup`, `RoutePlannerPanel`, `routeAutoTrace`, `PlayerCards`, `Lobby`, `sandboxTileLegality`, `PrivatePowerPanel`, `SeatOrderTrail`, `trackReach`, `stationTokens`, `gamePhase`, `ContextualSubPanel`, `hexTileCatalog`, `PrivateTradePanel`, `lobby`, `OperatingSubPhaseStepper`, `privateCatalog`, `trackSegments`) | Done |
| 5C | The remaining 56 small frontend files (auction/game-over/tutorial modals, the tab strip and top bar, `context/`, `styles/`, and 27 `utils/` modules) | Done |
| 6A | Rust backend: `hexmap.rs` (58 blocks, the 952-line module doc) | Done |
| 6B | Rust backend: the remaining 17 `.rs` files | Done |

**Rust verification.** Batches 6A/6B were verified with a real toolchain bootstrapped inside the
extraction sandbox: the Rust **token stream** is byte-identical for all 18 files, `cargo check` and
`cargo check --all-targets` both exit 0, and `cargo test --doc` confirms the crate has **zero doctests**,
which is what made rewriting `///` and `//!` blocks safe. Before trusting the lexer, every comment was
stripped from all 18 files and that crate compiled — proving no `//` inside a string was ever mistaken
for a comment. See [rust_contract_architecture.md](rust_contract_architecture.md).

Test files (`src/tests.rs`, `frontend/src/**/*.test.ts`) are out of scope by decision — they
are self-documenting.

> **JSX residue from batches 1–3: cleared in Batch 5A.** Those passes scanned *own-line* comment groups
> only, so JSX comment containers (`{/* … */}`) were skipped — 33 blocks in `App.tsx` and 3 in
> `HexGridRenderer.tsx`; the `.ts` files carry none. Batch 4 onward extracts both forms.

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

---

## Anchor index — Batch 5A

Every `#N` these seven files cite, and where it resolves. A row whose section names a **different** source
file is a cross-reference: that file owns the note, and this one cites it by number.

### appStyles.ts

| anchor | document | section |
|---|---|---|
| `appStyles.ts #1` | [ui_shell_layout.md](ui_shell_layout.md) | App.tsx #233 — The offer ledger appears when there is one |
| `appStyles.ts #7` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #299 / #456 / #46 — The tab row |
| `appStyles.ts #8` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `appStyles.ts #9` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #9 — The artwork is the content |
| `appStyles.ts #10` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #10 — Off-board pre-printed track |
| `appStyles.ts #11` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #11 — Off-board value plates print both tiers |
| `appStyles.ts #12` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #12 — Gray hexes and OO hexes |
| `appStyles.ts #13` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #13 (layout un-clamping) — `minHeight`, not `height: 100vh` |
| `appStyles.ts #14` | [contract_economy.md](contract_economy.md) | App.tsx #14 — Buy Private Company action tray |
| `appStyles.ts #18` | [ui_shell_layout.md](ui_shell_layout.md) | App.tsx #18 (item 4) / #21 — Turn alerts mount off bare `isMyTurn` |
| `appStyles.ts #19` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #19 / #27 — Viewport maximisation, then true proportional scale |
| `appStyles.ts #20` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |
| `appStyles.ts #22` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #22 — The opening bid is face value PLUS the increment |
| `appStyles.ts #25` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |
| `appStyles.ts #30` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #30 — Reverted: the board is not a scroll window |
| `appStyles.ts #31` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts (smaller entries) |
| `appStyles.ts #34` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #34 — One slim top bar |
| `appStyles.ts #35` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #34 / #35 — Blank city hexes and their real values |
| `appStyles.ts #36` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #36 (station tokens prop) — Structural assignability |
| `appStyles.ts #40` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #40 — The rails must GROW, not merely exist |
| `appStyles.ts #46` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #299 / #456 / #46 — The tab row |
| `appStyles.ts #47` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #47 / #364 / #366 — The reservation badge and its tooltip line |
| `appStyles.ts #141` | [ui_shell_layout.md](ui_shell_layout.md) | App.tsx (smaller entries) |
| `appStyles.ts #164` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #164 — The Operating Round panel is two rows |
| `appStyles.ts #214` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts (smaller entries) |
| `appStyles.ts #228` | [state_machine.md](state_machine.md) | App.tsx #228 — The acting corporation, resolved once |
| `appStyles.ts #236` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts (smaller entries) |
| `appStyles.ts #266` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts (smaller entries) |
| `appStyles.ts #279` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #279 — No placeholder where a control should be |
| `appStyles.ts #295` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #295 / #655 — A ceiling on a wrapping row has no version that is right |
| `appStyles.ts #297` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #297 / #426 — Sticky, and what stopped it behaving like it |
| `appStyles.ts #298` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #298 — What a pinned bar is allowed to keep  *[reversed by #590]* |
| `appStyles.ts #299` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #299 / #456 / #46 — The tab row |
| `appStyles.ts #317` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts (smaller entries) |
| `appStyles.ts #371` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #299 / #371 — 3px was one pixel too few |
| `appStyles.ts #379` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #379 (strip half) — Privates the company owns |
| `appStyles.ts #390` | [ui_shell_layout.md](ui_shell_layout.md) | App.tsx #427 — The reference tabs get a way back |
| `appStyles.ts #406` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #601 / #631 — Two dead fallbacks in one `??` |
| `appStyles.ts #426` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #297 / #426 — Sticky, and what stopped it behaving like it |
| `appStyles.ts #427` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #427 / #603 — The return bar, and why a card is a rectangle |
| `appStyles.ts #451` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #451 — Undo, and what it would undo |
| `appStyles.ts #456` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #299 / #456 / #46 — The tab row |
| `appStyles.ts #458` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #426 / #654 — True-centred, which the spacer pair was not |
| `appStyles.ts #481` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts (smaller entries) |
| `appStyles.ts #482` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #426 / #654 — True-centred, which the spacer pair was not |
| `appStyles.ts #489` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #31 / #489 / #504 — The operating snapshot strip |
| `appStyles.ts #490` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts (smaller entries) |
| `appStyles.ts #494` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #494 — The per-train route ink |
| `appStyles.ts #498` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #498 — Except during Run Routes, which IS the board |
| `appStyles.ts #509a` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #509a — Show the money moving, do not describe it |
| `appStyles.ts #518` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #518 — The sub-phase trail is one object with divisions |
| `appStyles.ts #563` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts (smaller entries) |
| `appStyles.ts #575` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts (smaller entries) |
| `appStyles.ts #578` | [ui_shell_layout.md](ui_shell_layout.md) | App.tsx #537c / #578 — The hotseat toolbar was a solo tool, then went entirely |
| `appStyles.ts #581` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #581 / #599 / #614 — The status-line dock |
| `appStyles.ts #589` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #575 / #589 / #410 / #465 — The bar names a corporation the way the card does |
| `appStyles.ts #599` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #581 / #599 / #614 — The status-line dock |
| `appStyles.ts #600` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #600 — `flex: 1` means `flex-basis: 0`, and that is the bug |
| `appStyles.ts #601` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #601 / #631 — Two dead fallbacks in one `??` |
| `appStyles.ts #603` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #427 / #603 — The return bar, and why a card is a rectangle |
| `appStyles.ts #605` | [ui_shell_layout.md](ui_shell_layout.md) | App.tsx #605 — Reserving the height is only half of it |
| `appStyles.ts #614` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #581 / #599 / #614 — The status-line dock |
| `appStyles.ts #619` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #619 — A `Record<string, T>` style sheet cannot catch a phantom key |
| `appStyles.ts #631` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #601 / #631 — Two dead fallbacks in one `??` |
| `appStyles.ts #636` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #636 — The same three rows as an Operating Round |
| `appStyles.ts #654` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #426 / #654 — True-centred, which the spacer pair was not |
| `appStyles.ts #655` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #295 / #655 — A ceiling on a wrapping row has no version that is right |

### RadialTileSelector.tsx

| anchor | document | section |
|---|---|---|
| `RadialTileSelector.tsx #0` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #0 — Why the ring is DOM and the preview is canvas |
| `RadialTileSelector.tsx #1` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #1 — Anchored to the board, not to the viewport |
| `RadialTileSelector.tsx #2` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #2 — Two stages, one overlay |
| `RadialTileSelector.tsx #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `RadialTileSelector.tsx #57s` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #628 / #629 — Scarcity, where the choice is made |
| `RadialTileSelector.tsx #168` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #168 — The backdrop must not swallow board clicks |
| `RadialTileSelector.tsx #173` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #512 — Two captions, one of them saying nothing |
| `RadialTileSelector.tsx #174` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #174 — The radius is solved for, not picked |
| `RadialTileSelector.tsx #174b` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #471 / #174b — Sizing the candidates |
| `RadialTileSelector.tsx #181` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #181 — The price is on the button |
| `RadialTileSelector.tsx #200` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #200 — The confirm ring is its own component |
| `RadialTileSelector.tsx #260` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #260 / #270 / #290 — A prop with no callers is the bug waiting to be re-enabled |
| `RadialTileSelector.tsx #266` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #512 — Two captions, one of them saying nothing |
| `RadialTileSelector.tsx #270` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #260 / #270 / #290 — A prop with no callers is the bug waiting to be re-enabled |
| `RadialTileSelector.tsx #271b` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #271b / #488b — Which half of the split city your station ends up in |
| `RadialTileSelector.tsx #290` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #260 / #270 / #290 — A prop with no callers is the bug waiting to be re-enabled |
| `RadialTileSelector.tsx #369` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #369 — The chrome was the other half of the rectangle |
| `RadialTileSelector.tsx #462` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #200 — The confirm ring is its own component |
| `RadialTileSelector.tsx #471` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #471 / #174b — Sizing the candidates |
| `RadialTileSelector.tsx #488b` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #271b / #488b — Which half of the split city your station ends up in |
| `RadialTileSelector.tsx #506` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #506 — The ring was measured in the wrong unit |
| `RadialTileSelector.tsx #506a` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #506a — A halo, solved rather than nudged |
| `RadialTileSelector.tsx #512` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #512 — Two captions, one of them saying nothing |
| `RadialTileSelector.tsx #628` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #628 / #629 — Scarcity, where the choice is made |
| `RadialTileSelector.tsx #629` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #628 / #629 — Scarcity, where the choice is made |

### TrainPurchasePanel.tsx

| anchor | document | section |
|---|---|---|
| `TrainPurchasePanel.tsx #0` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #0 — Why bank and corporation are not one control |
| `TrainPurchasePanel.tsx #1` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #1 — The quantity field is a convenience, not a batch |
| `TrainPurchasePanel.tsx #2` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #2 / #282 — A train badge is the whole interaction |
| `TrainPurchasePanel.tsx #3` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #3 — One train per trade |
| `TrainPurchasePanel.tsx #182` | [contract_economy.md](contract_economy.md) | App.tsx #207 — The train being run is observed, not picked  *[superseded by #227]* |
| `TrainPurchasePanel.tsx #203` | [contract_economy.md](contract_economy.md) | App.tsx #203 — Render the whole depot, tier by tier |
| `TrainPurchasePanel.tsx #219` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #219 — The cap moves while the field is sitting there |
| `TrainPurchasePanel.tsx #230` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #230 — The train limit is a second, tighter ceiling |
| `TrainPurchasePanel.tsx #232` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #232 — Only list corporations that have something to sell |
| `TrainPurchasePanel.tsx #247` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #247 — A dropdown that lists what is buyable |
| `TrainPurchasePanel.tsx #248` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #247 — A dropdown that lists what is buyable |
| `TrainPurchasePanel.tsx #281` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #281 — The limit is on holdings, not on the bank |
| `TrainPurchasePanel.tsx #282` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #2 / #282 — A train badge is the whole interaction |
| `TrainPurchasePanel.tsx #283` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #283 — What happens to this tier, next |
| `TrainPurchasePanel.tsx #294` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #247 — A dropdown that lists what is buyable |
| `TrainPurchasePanel.tsx #296` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #296 — The number was already in the future tense |
| `TrainPurchasePanel.tsx #298` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #508 — Condensed, because a sticky panel costs the board its height |
| `TrainPurchasePanel.tsx #485` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #281 — The limit is on holdings, not on the bank |
| `TrainPurchasePanel.tsx #491` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #508 — Condensed, because a sticky panel costs the board its height |
| `TrainPurchasePanel.tsx #508` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #508 — Condensed, because a sticky panel costs the board its height |
| `TrainPurchasePanel.tsx #617` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #617 — A train that looks like a train, and counts |
| `TrainPurchasePanel.tsx #618` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #618 / #633 / #634 — Six rows, then one row and a caret |
| `TrainPurchasePanel.tsx #632` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #632 / #635 — The era palette, and a cursor that promised nothing |
| `TrainPurchasePanel.tsx #633` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #618 / #633 / #634 — Six rows, then one row and a caret |
| `TrainPurchasePanel.tsx #634` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #618 / #633 / #634 — Six rows, then one row and a caret |
| `TrainPurchasePanel.tsx #635` | [contract_economy.md](contract_economy.md) | TrainPurchasePanel.tsx #632 / #635 — The era palette, and a cursor that promised nothing |

### gameState.ts

| anchor | document | section |
|---|---|---|
| `gameState.ts #1` | [utils_layer.md](utils_layer.md) | gameState.ts #1 — Hand-kept mirror, not codegen |
| `gameState.ts #2` | [utils_layer.md](utils_layer.md) | gameState.ts #2 — What this deliberately does NOT expose, because the backend does not either |
| `gameState.ts #3` | [utils_layer.md](utils_layer.md) | gameState.ts #3 — Derived but EXACT, not a backend count |
| `gameState.ts #4` | [utils_layer.md](utils_layer.md) | gameState.ts #4 — Polling, not a subscription |
| `gameState.ts #6` | [utils_layer.md](utils_layer.md) | gameState.ts #6 — Net worth is a separate hook, not a field |
| `gameState.ts #7` | [utils_layer.md](utils_layer.md) | gameState.ts #7 (waterfall) — A third independent hook, gated by the caller |
| `gameState.ts #11` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #11 — Off-board value plates print both tiers |
| `gameState.ts #12` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #12 — Gray hexes and OO hexes |
| `gameState.ts #17` | [utils_layer.md](utils_layer.md) | gameState.ts (player privates) — Two lists, deliberately |
| `gameState.ts #329` | [utils_layer.md](utils_layer.md) | gameState.ts #379 — A private can belong to a company, not a player |
| `gameState.ts #338` | [utils_layer.md](utils_layer.md) | gameState.ts #544 — A mini-auction suspends the turn order |
| `gameState.ts #351` | [utils_layer.md](utils_layer.md) | gameState.ts #553 — A corporation's par is the corporation's, not yours |
| `gameState.ts #352` | [utils_layer.md](utils_layer.md) | gameState.ts #352 / #656 / #662 — Sandbox-only fields, marked as such |
| `gameState.ts #353` | [utils_layer.md](utils_layer.md) | gameState.ts (priority deal) — A real field the contract does not yet move |
| `gameState.ts #379` | [utils_layer.md](utils_layer.md) | gameState.ts #379 — A private can belong to a company, not a player |
| `gameState.ts #411` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #411 — The operating queue has to be built by somebody |
| `gameState.ts #497` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #4 / #497 / #497a — The chain first, then the board |
| `gameState.ts #497a` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #4 / #497 / #497a — The chain first, then the board |
| `gameState.ts #507` | [utils_layer.md](utils_layer.md) | gameState.ts #526 — The certificate-limit table has one home |
| `gameState.ts #526` | [utils_layer.md](utils_layer.md) | gameState.ts #526 — The certificate-limit table has one home |
| `gameState.ts #544` | [utils_layer.md](utils_layer.md) | gameState.ts #544 — A mini-auction suspends the turn order |
| `gameState.ts #545` | [utils_layer.md](utils_layer.md) | gameState.ts #544 — A mini-auction suspends the turn order |
| `gameState.ts #549` | [utils_layer.md](utils_layer.md) | gameState.ts #553 — A corporation's par is the corporation's, not yours |
| `gameState.ts #553` | [utils_layer.md](utils_layer.md) | gameState.ts #553 — A corporation's par is the corporation's, not yours |
| `gameState.ts #560` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #134 / #560 — A hex is not a city |
| `gameState.ts #642` | [utils_layer.md](utils_layer.md) | gameState.ts #352 / #656 / #662 — Sandbox-only fields, marked as such |
| `gameState.ts #656` | [utils_layer.md](utils_layer.md) | gameState.ts #352 / #656 / #662 — Sandbox-only fields, marked as such |
| `gameState.ts #662` | [utils_layer.md](utils_layer.md) | gameState.ts #352 / #656 / #662 — Sandbox-only fields, marked as such |

### RulesReference.tsx

| anchor | document | section |
|---|---|---|
| `RulesReference.tsx #1` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #1 — Sourced, not remembered — but presented clean, not annotated |
| `RulesReference.tsx #2` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #2 — Reference-only content: this tab reads no live game state |
| `RulesReference.tsx #3` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #3 — Two rules confirmed against this contract, not just the source engine |
| `RulesReference.tsx #4` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #4 — The president's certificate counts as exactly 1 |
| `RulesReference.tsx #5` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #5 — Game Flow summaries, and two honesty notes |
| `RulesReference.tsx #6` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #6 / #9(1) — Two legibility passes |
| `RulesReference.tsx #7` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #7 → #10 → #140 → #17 — Where the current-round panel lives |
| `RulesReference.tsx #8` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #8 — The step that was missing entirely |
| `RulesReference.tsx #9` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #9(3) — The narrative section, and the two end-condition audits |
| `RulesReference.tsx #10` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #7 → #10 → #140 → #17 — Where the current-round panel lives |
| `RulesReference.tsx #17` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #7 → #10 → #140 → #17 — Where the current-round panel lives |
| `RulesReference.tsx #29` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #29 — Buy Private Company is FIRST, not last |
| `RulesReference.tsx #30` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #30 / #37 — Signals, and where a note belongs |
| `RulesReference.tsx #31` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #28 / #31 — Measure the label, not just the anchor |
| `RulesReference.tsx #37` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #30 / #37 — Signals, and where a note belongs |
| `RulesReference.tsx #140` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #7 → #10 → #140 → #17 — Where the current-round panel lives |
| `RulesReference.tsx #141` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #141 — Station tokens: the reference denied a control that exists |
| `RulesReference.tsx #143` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #143 — Which rounds are expanded: state plus an effect, not a derived value |
| `RulesReference.tsx #144` | [contract_economy.md](contract_economy.md) | App.tsx #144 (routes skip) — Disabled with the reason, not dispatched to fail |
| `RulesReference.tsx #640` | [rules_and_sourcing.md](rules_and_sourcing.md) | RulesReference.tsx #640 — Which build the browser is actually running |

### TileSelectionPopup.tsx

| anchor | document | section |
|---|---|---|
| `TileSelectionPopup.tsx #1` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #1 — Self-contained dispatch, observer-only callback out |
| `TileSelectionPopup.tsx #2` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #2 — The rotation became a binding choice |
| `TileSelectionPopup.tsx #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `TileSelectionPopup.tsx #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `TileSelectionPopup.tsx #5` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `TileSelectionPopup.tsx #6` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #6 / #8 — The picker without a chain, stated three times and blocked twice |
| `TileSelectionPopup.tsx #7` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `TileSelectionPopup.tsx #8` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #6 / #8 — The picker without a chain, stated three times and blocked twice |
| `TileSelectionPopup.tsx #9` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #9 — The artwork is the content |
| `TileSelectionPopup.tsx #10` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `TileSelectionPopup.tsx #14` | [contract_economy.md](contract_economy.md) | App.tsx #14 — Buy Private Company action tray |
| `TileSelectionPopup.tsx #29` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #21 / #26 / #29 — The hover card |
| `TileSelectionPopup.tsx #39` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #39 / #70 / #109 — Adaptive placement, and the offset that moved four times |
| `TileSelectionPopup.tsx #47` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #47 / #364 / #366 — The reservation badge and its tooltip line |
| `TileSelectionPopup.tsx #55` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #55 — Strict canvas layering hierarchy |
| `TileSelectionPopup.tsx #57` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `TileSelectionPopup.tsx #58` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #52 / #56 / #58 / #73 / #77 — The two-node coordinate, five passes |
| `TileSelectionPopup.tsx #162` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #162 — Click the preview to rotate it |

### FinancialLedger.tsx

| anchor | document | section |
|---|---|---|
| `FinancialLedger.tsx #1` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #1 / #3 — Real data, and an honest design gap |
| `FinancialLedger.tsx #3` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #1 / #3 — Real data, and an honest design gap |
| `FinancialLedger.tsx #4` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #4 / #497 / #497a — The chain first, then the board |
| `FinancialLedger.tsx #5` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx (smaller entries) |
| `FinancialLedger.tsx #6` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx (smaller entries) |
| `FinancialLedger.tsx #7` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #7 / #14 — One table, not a table plus a tree; one table, not two |
| `FinancialLedger.tsx #8` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx (smaller entries) |
| `FinancialLedger.tsx #9` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #9 — The artwork is the content |
| `FinancialLedger.tsx #12` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx (smaller entries) |
| `FinancialLedger.tsx #13` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx (smaller entries) |
| `FinancialLedger.tsx #14` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #7 / #14 — One table, not a table plus a tree; one table, not two |
| `FinancialLedger.tsx #15` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx (smaller entries) |
| `FinancialLedger.tsx #16` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #16 — The bank depot inventory |
| `FinancialLedger.tsx #170` | [ui_shell_layout.md](ui_shell_layout.md) | FinancialLedger.tsx #170 — See `ContextualSubPanel.tsx #170` |
| `FinancialLedger.tsx #379` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx (smaller entries) |
| `FinancialLedger.tsx #405` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #405 — One Player Assets table, two places |
| `FinancialLedger.tsx #407` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #423 / #407 — The same pills the auction uses, carrying the revenue |
| `FinancialLedger.tsx #423` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #423 / #407 — The same pills the auction uses, carrying the revenue |
| `FinancialLedger.tsx #497` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #4 / #497 / #497a — The chain first, then the board |
| `FinancialLedger.tsx #497a` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #4 / #497 / #497a — The chain first, then the board |
| `FinancialLedger.tsx #552` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx (smaller entries) |
| `FinancialLedger.tsx #555` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #555 — This is arithmetic, not an estimate |
| `FinancialLedger.tsx #559` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #405 — One Player Assets table, two places |

---

## Anchor index — Batch 5B

Every `#N` these files cite, and where it resolves. A row whose section names a **different** source file is a
cross-reference: that file owns the note, and this one cites it by number.

### TopTicker.tsx

| anchor | document | section |
|---|---|---|
| `TopTicker.tsx #1` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #1–#7 — Charter |
| `TopTicker.tsx #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `TopTicker.tsx #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `TopTicker.tsx #5` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `TopTicker.tsx #6` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #6 — The static board is the authentic 93 hexes |
| `TopTicker.tsx #7` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #1–#7 — Charter |
| `TopTicker.tsx #20` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #457 — The log belongs to the chat, not to the tabs |
| `TopTicker.tsx #21` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #1–#7 — Charter |
| `TopTicker.tsx #425` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #425 — One string, and no pictures in it |
| `TopTicker.tsx #457` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #457 — The log belongs to the chat, not to the tabs |
| `TopTicker.tsx #458` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #458 — The latest line, where the player is looking |
| `TopTicker.tsx #476` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #476 — The whole game, not the last seven lines |
| `TopTicker.tsx #477` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #477 — The time leads |
| `TopTicker.tsx #581` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #598 / #600 / #614 — The Chat toggle, and the row that did not know about it |
| `TopTicker.tsx #598` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #598 / #600 / #614 — The Chat toggle, and the row that did not know about it |
| `TopTicker.tsx #600` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #598 / #600 / #614 — The Chat toggle, and the row that did not know about it |
| `TopTicker.tsx #614` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #598 / #600 / #614 — The Chat toggle, and the row that did not know about it |
| `TopTicker.tsx #615` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #615 — Five rows, now that five rows is not a limit |
| `TopTicker.tsx #616` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #616 — Unread CHAT MESSAGES, not unread feed items |

### gameSetup.ts

| anchor | document | section |
|---|---|---|
| `gameSetup.ts #178` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #591 — Undo is an event, not a rewind |
| `gameSetup.ts #461` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #546 / #550 — Every decision goes in the log, or it is not shared |
| `gameSetup.ts #468` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #546 / #550 — Every decision goes in the log, or it is not shared |
| `gameSetup.ts #492` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #538 — A room never boots the fixture's roster |
| `gameSetup.ts #514` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #538 — A room never boots the fixture's roster |
| `gameSetup.ts #522` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #591 — Undo is an event, not a rewind |
| `gameSetup.ts #526` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #526 — The third copy that did not get written |
| `gameSetup.ts #526a` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #526a / #526b — Purity, and a shuffle that runs once |
| `gameSetup.ts #526b` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #526a / #526b — Purity, and a shuffle that runs once |
| `gameSetup.ts #530` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #530 — The setup action is shaped like a message |
| `gameSetup.ts #536` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #662 — An offer nobody else could see |
| `gameSetup.ts #537a` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #538 — A room never boots the fixture's roster |
| `gameSetup.ts #538` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #538 — A room never boots the fixture's roster |
| `gameSetup.ts #542` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #542 — The auction is a fourth atom, and it was missed |
| `gameSetup.ts #546` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #546 / #550 — Every decision goes in the log, or it is not shared |
| `gameSetup.ts #549` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #546 / #550 — Every decision goes in the log, or it is not shared |
| `gameSetup.ts #550` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #546 / #550 — Every decision goes in the log, or it is not shared |
| `gameSetup.ts #560` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #134 / #560 — A hex is not a city |
| `gameSetup.ts #569` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #570 — The bar wears whose turn it is |
| `gameSetup.ts #573` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #573 — The resolved grant travels, not the request |
| `gameSetup.ts #576` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #350 → #576 — Camden & Amboy, added and then un-buttoned |
| `gameSetup.ts #578` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #662 — An offer nobody else could see |
| `gameSetup.ts #587` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #594 — An unstarted corporation has no price either |
| `gameSetup.ts #591` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #591 — Undo is an event, not a rewind |
| `gameSetup.ts #594` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #594 — An unstarted corporation has no price either |
| `gameSetup.ts #611` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #611 — The phase was a written thing too |
| `gameSetup.ts #662` | [sandbox_reducer.md](sandbox_reducer.md) | gameSetup.ts #662 — An offer nobody else could see |

### RoutePlannerPanel.tsx

| anchor | document | section |
|---|---|---|
| `RoutePlannerPanel.tsx #0` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #0 — The step was spread across three places |
| `RoutePlannerPanel.tsx #1` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #1 → #493 — There was never a manual mode to enter |
| `RoutePlannerPanel.tsx #2` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #2 — The run button carries the number, and its own gate |
| `RoutePlannerPanel.tsx #3` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #3 / #4 — Why the red text is gone, and what stayed |
| `RoutePlannerPanel.tsx #4` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #3 / #4 — Why the red text is gone, and what stayed |
| `RoutePlannerPanel.tsx #5` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #5 — A corporation runs every train it owns |
| `RoutePlannerPanel.tsx #6` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #9 / #494 / #499 / #6 — The route table |
| `RoutePlannerPanel.tsx #7` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #1 → #493 — There was never a manual mode to enter |
| `RoutePlannerPanel.tsx #9` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #9 / #494 / #499 / #6 — The route table |
| `RoutePlannerPanel.tsx #266` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #623 — The step's primary action, on the step's toolbar |
| `RoutePlannerPanel.tsx #274` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #274 — Which stops paid, and how much each |
| `RoutePlannerPanel.tsx #474` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #9 / #494 / #499 / #6 — The route table |
| `RoutePlannerPanel.tsx #493` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #1 → #493 — There was never a manual mode to enter |
| `RoutePlannerPanel.tsx #494` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #9 / #494 / #499 / #6 — The route table |
| `RoutePlannerPanel.tsx #499` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #9 / #494 / #499 / #6 — The route table |
| `RoutePlannerPanel.tsx #619` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #619 — Say the obligation, do not only refuse it |
| `RoutePlannerPanel.tsx #623` | [routing_pathfinding.md](routing_pathfinding.md) | RoutePlannerPanel.tsx #623 — The step's primary action, on the step's toolbar |

### routeAutoTrace.ts

| anchor | document | section |
|---|---|---|
| `routeAutoTrace.ts #0` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #0 — A client-side SUGGESTION, not an oracle |
| `routeAutoTrace.ts #1` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #1 / #6 — The walk follows rails, and spends them |
| `routeAutoTrace.ts #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `routeAutoTrace.ts #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `routeAutoTrace.ts #4` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #0 — A client-side SUGGESTION, not an oracle |
| `routeAutoTrace.ts #5` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #5 / #9 — Clicking two cities should not mean clicking nine hexes |
| `routeAutoTrace.ts #6` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #1 / #6 — The walk follows rails, and spends them |
| `routeAutoTrace.ts #7` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #7 / #8 — The best set, and why the optimiser must not be able to lose |
| `routeAutoTrace.ts #8` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #7 / #8 — The best set, and why the optimiser must not be able to lose |
| `routeAutoTrace.ts #9` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #5 / #9 — Clicking two cities should not mean clicking nine hexes |
| `routeAutoTrace.ts #20` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #1 / #6 — The walk follows rails, and spends them |
| `routeAutoTrace.ts #56` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #5 / #9 — Clicking two cities should not mean clicking nine hexes |
| `routeAutoTrace.ts #216` | [routing_pathfinding.md](routing_pathfinding.md) | routeAutoTrace.ts #5 / #9 — Clicking two cities should not mean clicking nine hexes |

### PlayerCards.tsx

| anchor | document | section |
|---|---|---|
| `PlayerCards.tsx #391` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #391 — The catalog moved to `utils/privateCatalog.ts` |
| `PlayerCards.tsx #423` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #583 / #609 / #658 — Two tables that have to agree |
| `PlayerCards.tsx #562` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #562 / #562a — An em dash, and the gap that is the point |
| `PlayerCards.tsx #562a` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #562 / #562a — An em dash, and the gap that is the point |
| `PlayerCards.tsx #563` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #563 — A table scans, a card reads |
| `PlayerCards.tsx #563a` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #563 — A table scans, a card reads |
| `PlayerCards.tsx #567` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #567 — What came off the card, and why |
| `PlayerCards.tsx #568` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #583 / #609 / #658 — Two tables that have to agree |
| `PlayerCards.tsx #569` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #570 — The bar wears whose turn it is |
| `PlayerCards.tsx #583` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #583 / #609 / #658 — Two tables that have to agree |
| `PlayerCards.tsx #593` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #593 / #595 / #606 — The cards state the turn order, they do not imply it |
| `PlayerCards.tsx #595` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #593 / #595 / #606 — The cards state the turn order, they do not imply it |
| `PlayerCards.tsx #606` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #593 / #595 / #606 — The cards state the turn order, they do not imply it |
| `PlayerCards.tsx #606a` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #606 — Lifted out of the row, in the seat's own colour |
| `PlayerCards.tsx #609` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #583 / #609 / #658 — Two tables that have to agree |
| `PlayerCards.tsx #611` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #583 / #609 / #658 — Two tables that have to agree |
| `PlayerCards.tsx #658` | [ui_shell_layout.md](ui_shell_layout.md) | PlayerCards.tsx #583 / #609 / #658 — Two tables that have to agree |

### Lobby.tsx

| anchor | document | section |
|---|---|---|
| `Lobby.tsx #0` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #0 — Stage off-chain, launch on-chain |
| `Lobby.tsx #1` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #1 / #2 — The ante is the contract's rule; the game id comes from the transaction |
| `Lobby.tsx #2` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #1 / #2 — The ante is the contract's rule; the game id comes from the transaction |
| `Lobby.tsx #3` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #3 — The silent-button bug, and the rule that replaced it |
| `Lobby.tsx #24` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #24 / #524 / #525 / #586 — The escape hatch, and parking the Web3 lobby |
| `Lobby.tsx #522` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #24 / #524 / #525 / #586 — The escape hatch, and parking the Web3 lobby |
| `Lobby.tsx #524` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #24 / #524 / #525 / #586 — The escape hatch, and parking the Web3 lobby |
| `Lobby.tsx #525` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #24 / #524 / #525 / #586 — The escape hatch, and parking the Web3 lobby |
| `Lobby.tsx #527` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx (entry points) — Enter, spectate, sandbox |
| `Lobby.tsx #578` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #24 / #524 / #525 / #586 — The escape hatch, and parking the Web3 lobby |
| `Lobby.tsx #586` | [firebase_middleware.md](firebase_middleware.md) | Lobby.tsx #24 / #524 / #525 / #586 — The escape hatch, and parking the Web3 lobby |

### sandboxTileLegality.ts

| anchor | document | section |
|---|---|---|
| `sandboxTileLegality.ts #0` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #0 — Why this does not violate "no client-side re-validation" |
| `sandboxTileLegality.ts #1` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #1 / #2 — No tile ids, and no hex coordinates either |
| `sandboxTileLegality.ts #2` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #1 / #2 — No tile ids, and no hex coordinates either |
| `sandboxTileLegality.ts #3` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #3 — A preprinted hex is already at a tier |
| `sandboxTileLegality.ts #4` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #4 — Strict path preservation |
| `sandboxTileLegality.ts #6` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #6 / #483 — An orientation has to join the network |
| `sandboxTileLegality.ts #7` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #7 — Track cannot run off the edge of the board |
| `sandboxTileLegality.ts #9` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #6 / #483 — An orientation has to join the network |
| `sandboxTileLegality.ts #20` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #6 / #483 — An orientation has to join the network |
| `sandboxTileLegality.ts #57` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #4 — Strict path preservation |
| `sandboxTileLegality.ts #70` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #4 — Strict path preservation |
| `sandboxTileLegality.ts #483` | [hex_tile_math.md](hex_tile_math.md) | sandboxTileLegality.ts #6 / #483 — An orientation has to join the network |

### PrivatePowerPanel.tsx

| anchor | document | section |
|---|---|---|
| `PrivatePowerPanel.tsx #0` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #0 / #1 — What these buttons honestly are |
| `PrivatePowerPanel.tsx #1` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #0 / #1 — What these buttons honestly are |
| `PrivatePowerPanel.tsx #2` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #2 / #349 / #470 — Two gates, and how coarse they may be |
| `PrivatePowerPanel.tsx #349` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #2 / #349 / #470 — Two gates, and how coarse they may be |
| `PrivatePowerPanel.tsx #350` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #350 → #576 — Camden & Amboy, added and then un-buttoned |
| `PrivatePowerPanel.tsx #387` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #441 (B&O) — The row is gone, not restricted |
| `PrivatePowerPanel.tsx #399` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #441 (B&O) — The row is gone, not restricted |
| `PrivatePowerPanel.tsx #441` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #441 — Who owns a power is not who owns the private |
| `PrivatePowerPanel.tsx #442` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #442 — The D&H is two powers, and F16 is not free |
| `PrivatePowerPanel.tsx #443` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #573b / #443 — Why it refused, and what it costs to find out |
| `PrivatePowerPanel.tsx #470` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #2 / #349 / #470 — Two gates, and how coarse they may be |
| `PrivatePowerPanel.tsx #573b` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #573b / #443 — Why it refused, and what it costs to find out |
| `PrivatePowerPanel.tsx #576` | [contract_economy.md](contract_economy.md) | PrivatePowerPanel.tsx #350 → #576 — Camden & Amboy, added and then un-buttoned |

### SeatOrderTrail.tsx

| anchor | document | section |
|---|---|---|
| `SeatOrderTrail.tsx #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `SeatOrderTrail.tsx #317` | [contract_economy.md](contract_economy.md) | App.tsx #317 — During the auction, show AVAILABLE cash |
| `SeatOrderTrail.tsx #342` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #639 — Rivals' money here, yours on your card |
| `SeatOrderTrail.tsx #545` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualActionBar.tsx #545 — What the mini-auction chase animation meant |
| `SeatOrderTrail.tsx #567` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #597c / #599 (chips) — What the segments do not carry |
| `SeatOrderTrail.tsx #595` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #595 — An ordinal is not an order |
| `SeatOrderTrail.tsx #597b` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #597b → #599 → #603 → #603a — Three passes to stop being five pills |
| `SeatOrderTrail.tsx #597c` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #597c / #599 (chips) — What the segments do not carry |
| `SeatOrderTrail.tsx #599` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #597b → #599 → #603 → #603a — Three passes to stop being five pills |
| `SeatOrderTrail.tsx #603` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #597b → #599 → #603 → #603a — Three passes to stop being five pills |
| `SeatOrderTrail.tsx #603a` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #597b → #599 → #603 → #603a — Three passes to stop being five pills |
| `SeatOrderTrail.tsx #610` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #610 — This seat has passed since anyone last acted |
| `SeatOrderTrail.tsx #637` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #639 — Rivals' money here, yours on your card |
| `SeatOrderTrail.tsx #639` | [ui_shell_layout.md](ui_shell_layout.md) | SeatOrderTrail.tsx #639 — Rivals' money here, yours on your card |

### trackReach.ts

| anchor | document | section |
|---|---|---|
| `trackReach.ts #0` | [routing_pathfinding.md](routing_pathfinding.md) | trackReach.ts #0 — A hint about reach, not a ruling about legality |
| `trackReach.ts #1` | [routing_pathfinding.md](routing_pathfinding.md) | trackReach.ts #1 — Connectivity is checked from both sides |
| `trackReach.ts #2` | [routing_pathfinding.md](routing_pathfinding.md) | trackReach.ts #2 — A corporation with no token is unconstrained |
| `trackReach.ts #3` | [routing_pathfinding.md](routing_pathfinding.md) | trackReach.ts #3 — A tile lay extends a route; it does not touch a hex |
| `trackReach.ts #4` | [routing_pathfinding.md](routing_pathfinding.md) | trackReach.ts #4 — A network follows rails, not hex adjacency; and the network is shown, not hidden |
| `trackReach.ts #20` | [routing_pathfinding.md](routing_pathfinding.md) | trackReach.ts #4 — A network follows rails, not hex adjacency; and the network is shown, not hidden |
| `trackReach.ts #483` | [routing_pathfinding.md](routing_pathfinding.md) | trackReach.ts #483 — A network ends at PORTS, not at hexes |

### stationTokens.ts

| anchor | document | section |
|---|---|---|
| `stationTokens.ts #0` | [contract_economy.md](contract_economy.md) | stationTokens.ts #0 — The price escalates; it was a constant |
| `stationTokens.ts #1` | [contract_economy.md](contract_economy.md) | stationTokens.ts #1 — The allowance is per corporation, not a constant |
| `stationTokens.ts #2` | [contract_economy.md](contract_economy.md) | stationTokens.ts #2 — Three refusals, before a signature |
| `stationTokens.ts #221` | [contract_economy.md](contract_economy.md) | stationTokens.ts #453 / #459 / #463 / #580 — Which city node the click landed on |
| `stationTokens.ts #293b` | [contract_economy.md](contract_economy.md) | App.tsx #293 / App.tsx #293b — "Owns none" is not "we were not told" |
| `stationTokens.ts #438` | [contract_economy.md](contract_economy.md) | stationTokens.ts #438 — Why this corporation cannot place a station |
| `stationTokens.ts #453` | [contract_economy.md](contract_economy.md) | stationTokens.ts #453 / #459 / #463 / #580 — Which city node the click landed on |
| `stationTokens.ts #459` | [contract_economy.md](contract_economy.md) | stationTokens.ts #453 / #459 / #463 / #580 — Which city node the click landed on |
| `stationTokens.ts #463` | [contract_economy.md](contract_economy.md) | stationTokens.ts #453 / #459 / #463 / #580 — Which city node the click landed on |
| `stationTokens.ts #580` | [contract_economy.md](contract_economy.md) | stationTokens.ts #453 / #459 / #463 / #580 — Which city node the click landed on |

### gamePhase.ts

| anchor | document | section |
|---|---|---|
| `gamePhase.ts #1` | [utils_layer.md](utils_layer.md) | gamePhase.ts #1 — The phase is derived, not queried — and it has to be |
| `gamePhase.ts #2` | [utils_layer.md](utils_layer.md) | gamePhase.ts #2 / #4 — The depot count is derived the same way, and is exact |
| `gamePhase.ts #3` | [utils_layer.md](utils_layer.md) | gamePhase.ts #3 — Unknown is a state, not a zero |
| `gamePhase.ts #4` | [utils_layer.md](utils_layer.md) | gamePhase.ts #2 / #4 — The depot count is derived the same way, and is exact |
| `gamePhase.ts #5` | [utils_layer.md](utils_layer.md) | gamePhase.ts #5 / #6 / #7 — One countdown, one escalation |
| `gamePhase.ts #6` | [utils_layer.md](utils_layer.md) | gamePhase.ts #5 / #6 / #7 — One countdown, one escalation |
| `gamePhase.ts #7` | [utils_layer.md](utils_layer.md) | gamePhase.ts #5 / #6 / #7 — One countdown, one escalation |
| `gamePhase.ts #8` | [utils_layer.md](utils_layer.md) | gamePhase.ts #8 — A tier's fate is a property of the tier |
| `gamePhase.ts #40` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #40 — The rails must GROW, not merely exist |
| `gamePhase.ts #612` | [utils_layer.md](utils_layer.md) | gamePhase.ts #612 / #632 — Naming the phase, and colouring the train |
| `gamePhase.ts #632` | [utils_layer.md](utils_layer.md) | gamePhase.ts #612 / #632 — Naming the phase, and colouring the train |

### ContextualSubPanel.tsx

| anchor | document | section |
|---|---|---|
| `ContextualSubPanel.tsx #1` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #1–#5 — Charter |
| `ContextualSubPanel.tsx #2` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #1–#5 — Charter |
| `ContextualSubPanel.tsx #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `ContextualSubPanel.tsx #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `ContextualSubPanel.tsx #5` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #1–#5 — Charter |
| `ContextualSubPanel.tsx #8` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #11 / #8 / #572 — Table mechanics |
| `ContextualSubPanel.tsx #9` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #9 — The artwork is the content |
| `ContextualSubPanel.tsx #10` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #10 — What this table can and cannot source |
| `ContextualSubPanel.tsx #11` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #11 / #8 / #572 — Table mechanics |
| `ContextualSubPanel.tsx #170` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #170 — Show the person, not the hash |
| `ContextualSubPanel.tsx #405` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #405 — One Player Assets table, two places |
| `ContextualSubPanel.tsx #449` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #449 — Operating order, and unfloated dimmed |
| `ContextualSubPanel.tsx #511` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #645 — Both sides of "of" are round numbers |
| `ContextualSubPanel.tsx #552` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #490 / #552 — The crown, as a drawing |
| `ContextualSubPanel.tsx #559` | [contract_economy.md](contract_economy.md) | FinancialLedger.tsx #405 — One Player Assets table, two places |
| `ContextualSubPanel.tsx #572` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #11 / #8 / #572 — Table mechanics |
| `ContextualSubPanel.tsx #645` | [ui_shell_layout.md](ui_shell_layout.md) | ContextualSubPanel.tsx #645 — Both sides of "of" are round numbers |

### PrivateTradePanel.tsx

| anchor | document | section |
|---|---|---|
| `PrivateTradePanel.tsx #0` | [contract_economy.md](contract_economy.md) | PrivateTradePanel.tsx #0 — The consent step is not on chain yet |
| `PrivateTradePanel.tsx #1` | [contract_economy.md](contract_economy.md) | PrivateTradePanel.tsx #1 — The price band is mirrored, not invented |
| `PrivateTradePanel.tsx #2` | [contract_economy.md](contract_economy.md) | PrivateTradePanel.tsx #0 — The consent step is not on chain yet |
| `PrivateTradePanel.tsx #235` | [state_machine.md](state_machine.md) | OperatingSubPhaseStepper.tsx #235 — Skip and Undo swapped lines |
| `PrivateTradePanel.tsx #386` | [contract_economy.md](contract_economy.md) | PrivateTradePanel.tsx #386 — Show the unsold ones, disabled |
| `PrivateTradePanel.tsx #660` | [contract_economy.md](contract_economy.md) | PrivateTradePanel.tsx #660a — A rule enforced in a function that never runs |
| `PrivateTradePanel.tsx #660a` | [contract_economy.md](contract_economy.md) | PrivateTradePanel.tsx #660a — A rule enforced in a function that never runs |
| `PrivateTradePanel.tsx #661` | [contract_economy.md](contract_economy.md) | PrivateTradePanel.tsx #661 — A row per private, at a readable size |

### lobby.ts

| anchor | document | section |
|---|---|---|
| `lobby.ts #0` | [firebase_middleware.md](firebase_middleware.md) | lobby.ts #0 — What is and is not authoritative here |
| `lobby.ts #1` | [firebase_middleware.md](firebase_middleware.md) | lobby.ts #1 — Presence is a heartbeat, and is clock-skew-immune |
| `lobby.ts #644` | [firebase_middleware.md](firebase_middleware.md) | lobby.ts (schema and transport) |

### OperatingSubPhaseStepper.tsx

| anchor | document | section |
|---|---|---|
| `OperatingSubPhaseStepper.tsx #0` | [state_machine.md](state_machine.md) | OperatingSubPhaseStepper.tsx #0 — This replaces a text label, and that is the point |
| `OperatingSubPhaseStepper.tsx #1` | [state_machine.md](state_machine.md) | OperatingSubPhaseStepper.tsx #1 / #212 — The strip is a read-only indicator, in every mode |
| `OperatingSubPhaseStepper.tsx #2` | [state_machine.md](state_machine.md) | OperatingSubPhaseStepper.tsx #2 — Five steps or six, depending on the era |
| `OperatingSubPhaseStepper.tsx #142` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #142 / #266 — Running trains is its own phase |
| `OperatingSubPhaseStepper.tsx #212` | [state_machine.md](state_machine.md) | OperatingSubPhaseStepper.tsx #1 / #212 — The strip is a read-only indicator, in every mode |
| `OperatingSubPhaseStepper.tsx #235` | [state_machine.md](state_machine.md) | OperatingSubPhaseStepper.tsx #235 — Skip and Undo swapped lines |
| `OperatingSubPhaseStepper.tsx #299` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #299 / #456 / #46 — The tab row |
| `OperatingSubPhaseStepper.tsx #385` | [state_machine.md](state_machine.md) | OperatingSubPhaseStepper.tsx #385 — A step with nothing in it is not a step |
| `OperatingSubPhaseStepper.tsx #613` | [state_machine.md](state_machine.md) | OperatingSubPhaseStepper.tsx #613 — The rule is a phase number, so say the phase number |

### privateCatalog.ts

| anchor | document | section |
|---|---|---|
| `privateCatalog.ts #13` | [contract_economy.md](contract_economy.md) | privateCatalog.ts #13 — The enforcement badges are gone, and what that costs |
| `privateCatalog.ts #312` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #312 — Two privates cannot reserve one hex |
| `privateCatalog.ts #341` | [contract_economy.md](contract_economy.md) | privateCatalog.ts #423 — The acronym is a name, not a number |
| `privateCatalog.ts #391` | [contract_economy.md](contract_economy.md) | privateCatalog.ts #391 — One copy of the descriptions |
| `privateCatalog.ts #423` | [contract_economy.md](contract_economy.md) | privateCatalog.ts #423 — The acronym is a name, not a number |
| `privateCatalog.ts #548` | [contract_economy.md](contract_economy.md) | privateCatalog.ts #548 — Described, not quoted |
| `privateCatalog.ts #660` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #660 — The B&O is not for sale to a corporation |
| `privateCatalog.ts #661` | [contract_economy.md](contract_economy.md) | privateCatalog.ts #661 — The power, in one line, before the paragraph |

### trackSegments.ts

| anchor | document | section |
|---|---|---|
| `trackSegments.ts #0` | [routing_pathfinding.md](routing_pathfinding.md) | trackSegments.ts #0 — A hex is not a node |
| `trackSegments.ts #1` | [routing_pathfinding.md](routing_pathfinding.md) | trackSegments.ts #1 — The answer already existed; nothing consumed it |
| `trackSegments.ts #2` | [routing_pathfinding.md](routing_pathfinding.md) | trackSegments.ts #2 — Where there is no artwork, everything connects |
| `trackSegments.ts #3` | [routing_pathfinding.md](routing_pathfinding.md) | trackSegments.ts #3 — A segment key, because a hex id could not be one |
| `trackSegments.ts #20` | [routing_pathfinding.md](routing_pathfinding.md) | trackSegments.ts #0 — A hex is not a node |
| `trackSegments.ts #229` | [routing_pathfinding.md](routing_pathfinding.md) | trackSegments.ts (traversals) — `null` is the whole point |
| `trackSegments.ts #484` | [routing_pathfinding.md](routing_pathfinding.md) | trackSegments.ts #484 — A red off-board area is a terminus, not a junction |

## Anchor index — Batch 5C

Every `#N` these files cite, and where it resolves. A row whose section names a **different** source file is a
cross-reference: that file owns the note, and this one cites it by number. Files citing no numbers are omitted.

### AuctionPromptModal.tsx

| anchor | document | section |
|---|---|---|
| `AuctionPromptModal.tsx #399` | [contract_economy.md](contract_economy.md) | AuctionPromptModal.tsx #399 (UI half) — Set the B&O's price, now |
| `AuctionPromptModal.tsx #543` | [contract_economy.md](contract_economy.md) | AuctionPromptModal.tsx #543 — A prize is shown to whoever won it |
| `AuctionPromptModal.tsx #547` | [contract_economy.md](contract_economy.md) | AuctionPromptModal.tsx #547 — One card, not two modals in a row |

### ChatBox.tsx

| anchor | document | section |
|---|---|---|
| `ChatBox.tsx #0` | [firebase_middleware.md](firebase_middleware.md) | ChatBox.tsx #0 — The primary export is the hook, not the component |
| `ChatBox.tsx #1` | [firebase_middleware.md](firebase_middleware.md) | ChatBox.tsx #1 — Chat is off-chain and carries no authority |
| `ChatBox.tsx #2` | [firebase_middleware.md](firebase_middleware.md) | ChatBox.tsx #2 — Why ordering uses a client timestamp, not serverTimestamp |
| `ChatBox.tsx #5` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `ChatBox.tsx #644` | [firebase_middleware.md](firebase_middleware.md) | ChatBox.tsx #644 — The sandbox had no chat, twice over |

### ConnectWalletButton.tsx

| anchor | document | section |
|---|---|---|
| `ConnectWalletButton.tsx #0` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #0 — Why the ring is DOM and the preview is canvas |
| `ConnectWalletButton.tsx #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `ConnectWalletButton.tsx #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |

### CorporateLogo.tsx

| anchor | document | section |
|---|---|---|
| `CorporateLogo.tsx #410` | [ui_shell_layout.md](ui_shell_layout.md) | CorporateLogo.tsx #410 — The historical logo, with the ticker behind it |
| `CorporateLogo.tsx #429` | [ui_shell_layout.md](ui_shell_layout.md) | CorporateLogo.tsx #429 — A circle needs a tighter cap than a stripe |

### EmergencyTrainPurchaseModal.tsx

| anchor | document | section |
|---|---|---|
| `EmergencyTrainPurchaseModal.tsx #0` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #0 — Why the ring is DOM and the preview is canvas |
| `EmergencyTrainPurchaseModal.tsx #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `EmergencyTrainPurchaseModal.tsx #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `EmergencyTrainPurchaseModal.tsx #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `EmergencyTrainPurchaseModal.tsx #6` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #6 — The static board is the authentic 93 hexes |

### GameOverModal.tsx

| anchor | document | section |
|---|---|---|
| `GameOverModal.tsx #0` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #0 — Why the ring is DOM and the preview is canvas |
| `GameOverModal.tsx #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |

### HomeStationPrompt.tsx

| anchor | document | section |
|---|---|---|
| `HomeStationPrompt.tsx #416` | [state_machine.md](state_machine.md) | HomeStationPrompt.tsx #416 (UI half) — Place the home station, deliberately |
| `HomeStationPrompt.tsx #440` | [state_machine.md](state_machine.md) | HomeStationPrompt.tsx #440 — It is a map click now |

### InlineQuickChat.tsx

| anchor | document | section |
|---|---|---|
| `InlineQuickChat.tsx #0` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #0 — Why the ring is DOM and the preview is canvas |
| `InlineQuickChat.tsx #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `InlineQuickChat.tsx #5` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `InlineQuickChat.tsx #457` | [ui_shell_layout.md](ui_shell_layout.md) | TopTicker.tsx #457 — The log belongs to the chat, not to the tabs |

### MainTabBar.tsx

| anchor | document | section |
|---|---|---|
| `MainTabBar.tsx #26` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #21 / #26 / #29 — The hover card |
| `MainTabBar.tsx #28` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #28 / #31 — Measure the label, not just the anchor |
| `MainTabBar.tsx #41` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #41 / #49 / #54c — Stacked dual names move to centre |
| `MainTabBar.tsx #46` | [ui_shell_layout.md](ui_shell_layout.md) | MainTabBar.tsx #46 — Hover states need real CSS |
| `MainTabBar.tsx #158` | [ui_shell_layout.md](ui_shell_layout.md) | MainTabBar.tsx #158 — The Tutorials front door is not a fifth tab |
| `MainTabBar.tsx #213` | [ui_shell_layout.md](ui_shell_layout.md) | MainTabBar.tsx #213 — One answer to "which tab is this round played on" |
| `MainTabBar.tsx #390` | [ui_shell_layout.md](ui_shell_layout.md) | MainTabBar.tsx #390 — The tabs that are not a place to act |
| `MainTabBar.tsx #404` | [ui_shell_layout.md](ui_shell_layout.md) | MainTabBar.tsx #404 — Reference tabs get the bar too |

### PresidentCrown.tsx

| anchor | document | section |
|---|---|---|
| `PresidentCrown.tsx #15` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #15 — Restored Boston/New York nameplates |
| `PresidentCrown.tsx #490` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #188 / #490 / #509 — The consequence belongs to the button |
| `PresidentCrown.tsx #552` | [ui_shell_layout.md](ui_shell_layout.md) | PresidentCrown.tsx #552 — Our own crown, drawn not typed |

### PrivateCompanyPills.tsx

| anchor | document | section |
|---|---|---|
| `PrivateCompanyPills.tsx #423` | [contract_economy.md](contract_economy.md) | components/PrivateCompanyPills.tsx #423 (UI half) — Named pills, not numbered chips |

### SandboxRoomBar.tsx

| anchor | document | section |
|---|---|---|
| `SandboxRoomBar.tsx #521` | [firebase_middleware.md](firebase_middleware.md) | #521 — Why not a modal |
| `SandboxRoomBar.tsx #521a` | [firebase_middleware.md](firebase_middleware.md) | #521a — What the strip says when it cannot work |

### SandboxWaitingRoom.tsx

| anchor | document | section |
|---|---|---|
| `SandboxWaitingRoom.tsx #528` | [firebase_middleware.md](firebase_middleware.md) | sandboxRoom.ts #528 — Who this browser is |
| `SandboxWaitingRoom.tsx #529` | [firebase_middleware.md](firebase_middleware.md) | App.tsx #529 / App.tsx #533 — No board until there is a game |
| `SandboxWaitingRoom.tsx #529a` | [firebase_middleware.md](firebase_middleware.md) | #529a — Ready is a claim, Start is an act |
| `SandboxWaitingRoom.tsx #569` | [ui_shell_layout.md](ui_shell_layout.md) | playerLabels.ts #569 — A seat colour that does a job |

### StationTokenRow.tsx

| anchor | document | section |
|---|---|---|
| `StationTokenRow.tsx #0` | [hex_tile_math.md](hex_tile_math.md) | StationTokenRow.tsx #0 — "2/4" is a count; the row is an inventory |
| `StationTokenRow.tsx #1` | [hex_tile_math.md](hex_tile_math.md) | StationTokenRow.tsx #1 — The row sits on the corporation's own colour |
| `StationTokenRow.tsx #362` | [hex_tile_math.md](hex_tile_math.md) | StationTokenRow.tsx #362 — The home token's caption is its hex, not its price |
| `StationTokenRow.tsx #450` | [hex_tile_math.md](hex_tile_math.md) | StationTokenRow.tsx #450 — No slash through the home hex |
| `StationTokenRow.tsx #487a` | [hex_tile_math.md](hex_tile_math.md) | StationTokenRow.tsx #487a — The halo was restating the order |

### TopBar.tsx

| anchor | document | section |
|---|---|---|
| `TopBar.tsx #0` | [ui_shell_layout.md](ui_shell_layout.md) | TopBar.tsx #0 — A pure move |
| `TopBar.tsx #9` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #9 — The artwork is the content |
| `TopBar.tsx #28` | [ui_shell_layout.md](ui_shell_layout.md) | TopBar.tsx #28 — Phase tab vs reference boards |
| `TopBar.tsx #34` | [ui_shell_layout.md](ui_shell_layout.md) | TopBar.tsx #34 — One top bar |
| `TopBar.tsx #41` | [ui_shell_layout.md](ui_shell_layout.md) | TopBar.tsx #41 — "corps", the persistent Stocks tab |

### TrainBadges.tsx

| anchor | document | section |
|---|---|---|
| `TrainBadges.tsx #0` | [contract_economy.md](contract_economy.md) | TrainBadges.tsx #0 — Shared because the Rust rule must not fork |
| `TrainBadges.tsx #1` | [contract_economy.md](contract_economy.md) | TrainBadges.tsx #1 — Two surfaces, because this app has two |
| `TrainBadges.tsx #2` | [contract_economy.md](contract_economy.md) | TrainBadges.tsx #2 — Colour means one thing each |
| `TrainBadges.tsx #3` | [contract_economy.md](contract_economy.md) | TrainBadges.tsx #3 — The empty and unknown states are chips too |
| `TrainBadges.tsx #4` | [contract_economy.md](contract_economy.md) | TrainBadges.tsx #4 — Every chip says something, and the counts agree |
| `TrainBadges.tsx #7` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #7 — Three places by design, not by accident |
| `TrainBadges.tsx #370` | [contract_economy.md](contract_economy.md) | TrainBadges.tsx #370 — A chip's height was font metrics, not a number |
| `TrainBadges.tsx #375` | [contract_economy.md](contract_economy.md) | TrainBadges.tsx #375 — A chip is a train, and a train runs a route |

### TrainTradePanel.tsx

| anchor | document | section |
|---|---|---|
| `TrainTradePanel.tsx #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `TrainTradePanel.tsx #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `TrainTradePanel.tsx #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `TrainTradePanel.tsx #5` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `TrainTradePanel.tsx #6` | [contract_economy.md](contract_economy.md) | TrainTradePanel.tsx #6 — The compose form moved, the ledger stayed |

### TutorialModal.tsx

| anchor | document | section |
|---|---|---|
| `TutorialModal.tsx #0` | [ui_shell_layout.md](ui_shell_layout.md) | TutorialModal.tsx #0 — What this must not become |
| `TutorialModal.tsx #1` | [ui_shell_layout.md](ui_shell_layout.md) | TutorialModal.tsx #1 — The preference is global and persistent |
| `TutorialModal.tsx #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `TutorialModal.tsx #4` | [ui_shell_layout.md](ui_shell_layout.md) | TutorialModal.tsx #4 — Page shell |
| `TutorialModal.tsx #44` | [ui_shell_layout.md](ui_shell_layout.md) | TutorialModal.tsx #44 (referenced) — The Stock Market explainer |
| `TutorialModal.tsx #158` | [ui_shell_layout.md](ui_shell_layout.md) | TutorialModal.tsx #158 — The tutorials had no front door |
| `TutorialModal.tsx #159` | [ui_shell_layout.md](ui_shell_layout.md) | TutorialModal.tsx #159 — Forgetting is not the same as being told to stop |
| `TutorialModal.tsx #412` | [ui_shell_layout.md](ui_shell_layout.md) | TutorialModal.tsx #412 — Tutorial mode is opt-in, and nothing else is |

### config.ts

| anchor | document | section |
|---|---|---|
| `config.ts #0` | [session_keys_wallet.md](session_keys_wallet.md) | config.ts #0 — Why this file does not throw at import |
| `config.ts #1` | [session_keys_wallet.md](session_keys_wallet.md) | config.ts #1 — Why a shared module at all |
| `config.ts #2` | [session_keys_wallet.md](session_keys_wallet.md) | config.ts #2 — CRA substitutes REACT_APP_* at build time |
| `config.ts #3` | [session_keys_wallet.md](session_keys_wallet.md) | config.ts #3 — Validation is shape-only |
| `config.ts #120` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #120 / #139 — The picker's offline path |

### WalletContext.tsx

| anchor | document | section |
|---|---|---|
| `WalletContext.tsx #0` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #0 — Why the ring is DOM and the preview is canvas |
| `WalletContext.tsx #1` | [session_keys_wallet.md](session_keys_wallet.md) | WalletContext.tsx #1 — What the master signer is for |
| `WalletContext.tsx #3` | [session_keys_wallet.md](session_keys_wallet.md) | WalletContext.tsx #3 — Only a public address is cached |
| `WalletContext.tsx #5` | [session_keys_wallet.md](session_keys_wallet.md) | WalletContext.tsx #5 — VERSION CAVEAT (unresolved) |

### ReturnToTurnBar.tsx

| anchor | document | section |
|---|---|---|
| `ReturnToTurnBar.tsx #427` | [ui_shell_layout.md](ui_shell_layout.md) | ReturnToTurnBar.tsx #427 — A way back from the reference tabs |

### animations.ts

| anchor | document | section |
|---|---|---|
| `animations.ts #35` | [ui_shell_layout.md](ui_shell_layout.md) | animations.ts #35 — White, not red |
| `animations.ts #46` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #46 / #48 / #116 / #513 / #564 — Token typography and livery |
| `animations.ts #597` | [ui_shell_layout.md](ui_shell_layout.md) | animations.ts #597 — A transition is noticed; a state is not |
| `animations.ts #601` | [ui_shell_layout.md](ui_shell_layout.md) | animations.ts #601 — The mini-auction chaser is gone |

### corporationLivery.ts

| anchor | document | section |
|---|---|---|
| `corporationLivery.ts #46` | [ui_shell_layout.md](ui_shell_layout.md) | corporationLivery.ts #46 — The contrast maths |
| `corporationLivery.ts #408` | [ui_shell_layout.md](ui_shell_layout.md) | corporationLivery.ts #408 — The colours the board uses |
| `corporationLivery.ts #428` | [ui_shell_layout.md](ui_shell_layout.md) | corporationLivery.ts #428 — One palette, imported three times |

### palette.ts

| anchor | document | section |
|---|---|---|
| `palette.ts #5` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |

### routeLivery.ts

| anchor | document | section |
|---|---|---|
| `routeLivery.ts #268` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #255 → #268 — Three attempts at a route line |
| `routeLivery.ts #373` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #373 — One route is the one being looked at |
| `routeLivery.ts #494` | [routing_pathfinding.md](routing_pathfinding.md) | routeLivery.ts #494 — The colour was the corporation's, not the train's |
| `routeLivery.ts #494a` | [routing_pathfinding.md](routing_pathfinding.md) | routeLivery.ts #494a — Why not the corporation's livery |
| `routeLivery.ts #494b` | [routing_pathfinding.md](routing_pathfinding.md) | routeLivery.ts #494b — Picked for separation, not for prettiness |
| `routeLivery.ts #495` | [routing_pathfinding.md](routing_pathfinding.md) | routeLivery.ts #495 — The highlight had both ends and no middle |

### typography.ts

| anchor | document | section |
|---|---|---|
| `typography.ts #3` | [ui_shell_layout.md](ui_shell_layout.md) | typography.ts #3 — The third pass, and why it goes the other way |
| `typography.ts #30` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #30 — Reverted: the board is not a scroll window |

### activeGame.ts

| anchor | document | section |
|---|---|---|
| `activeGame.ts #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `activeGame.ts #23` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |
| `activeGame.ts #24` | [firebase_middleware.md](firebase_middleware.md) | activeGame.ts #24 — The three ways to be looking at a board |
| `activeGame.ts #551` | [firebase_middleware.md](firebase_middleware.md) | activeGame.ts #551 — A refresh must not cost you the room |

### auctionEscrow.ts

| anchor | document | section |
|---|---|---|
| `auctionEscrow.ts #0` | [contract_economy.md](contract_economy.md) | auctionEscrow.ts #0 — The money was committed and nothing said so |
| `auctionEscrow.ts #1` | [contract_economy.md](contract_economy.md) | auctionEscrow.ts #1 — Derived, not deducted |
| `auctionEscrow.ts #2` | [contract_economy.md](contract_economy.md) | auctionEscrow.ts #2 — What counts as committed |

### baltimorePrivate.ts

| anchor | document | section |
|---|---|---|
| `baltimorePrivate.ts #573a` | [contract_economy.md](contract_economy.md) | privateExchange.ts #573a — Exchanged is not spent |
| `baltimorePrivate.ts #657` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #657 — The era has to move when the phase does |
| `baltimorePrivate.ts #660` | [contract_economy.md](contract_economy.md) | utils/baltimorePrivate.ts #660 — The B&O private has two rules and had neither |

### buildStamp.ts

| anchor | document | section |
|---|---|---|
| `buildStamp.ts #640` | [ui_shell_layout.md](ui_shell_layout.md) | utils/buildStamp.ts #640 — Which build is the browser actually running |

### corporationCardOrder.ts

| anchor | document | section |
|---|---|---|
| `corporationCardOrder.ts #446` | [stock_market.md](stock_market.md) | StockRoundPanel.tsx #446 — Floated companies sorted to the front  *[superseded by #464]* |
| `corporationCardOrder.ts #464` | [stock_market.md](stock_market.md) | utils/corporationCardOrder.ts #464 — The cards hold still while you are trading |

### corporationNames.ts

| anchor | document | section |
|---|---|---|
| `corporationNames.ts #1` | [utils_layer.md](utils_layer.md) | corporationNames.ts #1 — Why this is a frontend table and not a query |
| `corporationNames.ts #2` | [utils_layer.md](utils_layer.md) | corporationNames.ts #2 — Ticker spelling is not consistent, so lookup normalises |
| `corporationNames.ts #582` | [utils_layer.md](utils_layer.md) | corporationNames.ts #582 — A standing order for the eight |

### dividendStep.ts

| anchor | document | section |
|---|---|---|
| `dividendStep.ts #275` | [contract_economy.md](contract_economy.md) | App.tsx #275 — The roster, not the set of models |
| `dividendStep.ts #486` | [stock_market.md](stock_market.md) | dividendStep.ts #486 — One answer, not three approximations |
| `dividendStep.ts #486a` | [stock_market.md](stock_market.md) | dividendStep.ts #486a — Skip is never a declaration |
| `dividendStep.ts #489a` | [stock_market.md](stock_market.md) | dividendStep.ts #489a — Which way the money went |
| `dividendStep.ts #492` | [stock_market.md](stock_market.md) | dividendStep.ts #492 — One field cannot hold three trains |

### endgame.ts

| anchor | document | section |
|---|---|---|
| `endgame.ts #0` | [stock_market.md](stock_market.md) | endgame.ts #0 — The funding cascade is an order, not a total |
| `endgame.ts #1` | [stock_market.md](stock_market.md) | endgame.ts #1 — Which shares may be sold, and why the set is small |
| `endgame.ts #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `endgame.ts #3` | [stock_market.md](stock_market.md) | endgame.ts #3 — Scoring a game that has stopped |
| `endgame.ts #4` | [stock_market.md](stock_market.md) | endgame.ts #4 — The payout is proportional, and it is a placeholder |
| `endgame.ts #5` | [stock_market.md](stock_market.md) | endgame.ts #5 — Somebody still wins |
| `endgame.ts #6` | [stock_market.md](stock_market.md) | endgame.ts #6 — The presidency can be dumped, under two conditions |

### gameConstants.ts

| anchor | document | section |
|---|---|---|
| `gameConstants.ts #250` | [ui_shell_layout.md](ui_shell_layout.md) | App.tsx #250 / #291 — Two null-not-zero cases in the Operating Round |
| `gameConstants.ts #285` | [routing_pathfinding.md](routing_pathfinding.md) | App.tsx #285 — The stop count is the stop list |
| `gameConstants.ts #354` | [contract_economy.md](contract_economy.md) | App.tsx #354 — The B&O private hands its winner the presidency, free |
| `gameConstants.ts #398` | [stock_market.md](stock_market.md) | App.tsx #398 — One par selection per corporation |

### logRevert.ts

| anchor | document | section |
|---|---|---|
| `logRevert.ts #591` | [firebase_middleware.md](firebase_middleware.md) | logRevert.ts #591 (cont.) — The log is append-only, the game is not |
| `logRevert.ts #591a` | [firebase_middleware.md](firebase_middleware.md) | logRevert.ts #591a — The last revert wins, so it is read first |
| `logRevert.ts #592` | [firebase_middleware.md](firebase_middleware.md) | logRevert.ts #592 — Who may undo what |

### mockFixtures.ts

| anchor | document | section |
|---|---|---|
| `mockFixtures.ts #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `mockFixtures.ts #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `mockFixtures.ts #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `mockFixtures.ts #15` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #15 — Restored Boston/New York nameplates |
| `mockFixtures.ts #198` | [routing_pathfinding.md](routing_pathfinding.md) | App.tsx #198 — The dividend was always the same $180 |

### operatingCursor.ts

| anchor | document | section |
|---|---|---|
| `operatingCursor.ts #385` | [state_machine.md](state_machine.md) | App.tsx #385 — Never open on a step that is not there |
| `operatingCursor.ts #613` | [state_machine.md](state_machine.md) | OperatingSubPhaseStepper.tsx #613 — The rule is a phase number, so say the phase number |
| `operatingCursor.ts #642` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #642 — The round machine belongs to the reducer |
| `operatingCursor.ts #656` | [state_machine.md](state_machine.md) | operatingCursor.ts #656 — Where the turn cursor lived |
| `operatingCursor.ts #656a` | [state_machine.md](state_machine.md) | operatingCursor.ts #656a — The era field does not move, so do not ask it |

### passedSeats.ts

| anchor | document | section |
|---|---|---|
| `passedSeats.ts #610` | [state_machine.md](state_machine.md) | utils/passedSeats.ts #610 — Derived, not recorded |
| `passedSeats.ts #610a` | [state_machine.md](state_machine.md) | passedSeats.ts #610a — Walking backwards is sound, and has one limit |

### playerFinance.ts

| anchor | document | section |
|---|---|---|
| `playerFinance.ts #549` | [firebase_middleware.md](firebase_middleware.md) | App.tsx #549 / #549a — The actor field held a label |
| `playerFinance.ts #553` | [stock_market.md](stock_market.md) | App.tsx #553 — The merged state, synchronously, for the par resolvers |
| `playerFinance.ts #559` | [ui_shell_layout.md](ui_shell_layout.md) | playerLabels.ts #559 — Two functions with one name |
| `playerFinance.ts #562` | [stock_market.md](stock_market.md) | playerFinance.ts #562 — The arithmetic lives apart from the card |
| `playerFinance.ts #562a` | [stock_market.md](stock_market.md) | playerFinance.ts #562a — Net worth and liquidity are different questions |
| `playerFinance.ts #566` | [stock_market.md](stock_market.md) | playerFinance.ts #566 — Par is a price, not a guess |
| `playerFinance.ts #582` | [utils_layer.md](utils_layer.md) | corporationNames.ts #582 — A standing order for the eight |

### playerLabels.ts

| anchor | document | section |
|---|---|---|
| `playerLabels.ts #535` | [firebase_middleware.md](firebase_middleware.md) | App.tsx #535 — The room's own names |
| `playerLabels.ts #535b` | [ui_shell_layout.md](ui_shell_layout.md) | playerLabels.ts #535b — Module scope, so no hook depends on it |
| `playerLabels.ts #537b` | [ui_shell_layout.md](ui_shell_layout.md) | playerLabels.ts #537b / #578 — No mock names in a real room |
| `playerLabels.ts #559` | [ui_shell_layout.md](ui_shell_layout.md) | playerLabels.ts #559 — Two functions with one name |
| `playerLabels.ts #569` | [ui_shell_layout.md](ui_shell_layout.md) | playerLabels.ts #569 — A seat colour that does a job |

### presidencyTransfer.ts

| anchor | document | section |
|---|---|---|
| `presidencyTransfer.ts #596` | [stock_market.md](stock_market.md) | presidencyTransfer.ts #596 — Being bought out of a presidency |
| `presidencyTransfer.ts #596a` | [stock_market.md](stock_market.md) | presidencyTransfer.ts #596a — It is a swap, not a relabel |
| `presidencyTransfer.ts #596b` | [stock_market.md](stock_market.md) | presidencyTransfer.ts #596b — Strictly more, and ties do not move it |

### privateExchange.ts

| anchor | document | section |
|---|---|---|
| `privateExchange.ts #444` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #444 — One veil, three errands |
| `privateExchange.ts #573` | [contract_economy.md](contract_economy.md) | privateExchange.ts #573 — A button that says "Used" has to have done something |
| `privateExchange.ts #573a` | [contract_economy.md](contract_economy.md) | privateExchange.ts #573a — Exchanged is not spent |
| `privateExchange.ts #573b` | [contract_economy.md](contract_economy.md) | privateExchange.ts #573b — A refusal is not a use |
| `privateExchange.ts #576` | [contract_economy.md](contract_economy.md) | privateExchange.ts #576 — The Camden & Amboy was never an exchange |

### privateReservations.ts

| anchor | document | section |
|---|---|---|
| `privateReservations.ts #0` | [hex_tile_math.md](hex_tile_math.md) | privateReservations.ts #0 — The reservation existed only as prose |
| `privateReservations.ts #1` | [hex_tile_math.md](hex_tile_math.md) | privateReservations.ts #1 — Derived from ownership, not hardcoded on |
| `privateReservations.ts #2` | [hex_tile_math.md](hex_tile_math.md) | privateReservations.ts #2 — The coordinates come from the board, not from here |
| `privateReservations.ts #3` | [hex_tile_math.md](hex_tile_math.md) | privateReservations.ts #3 — Each badge has a fixed home |
| `privateReservations.ts #123` | [hex_tile_math.md](hex_tile_math.md) | Anchor: hexBoardData.ts #123 — F16 had no city, and the board moved to give it one |
| `privateReservations.ts #223` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #223 — The wild blue yonder |
| `privateReservations.ts #312` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #312 — Two privates cannot reserve one hex |
| `privateReservations.ts #364` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #47 / #364 / #366 — The reservation badge and its tooltip line |
| `privateReservations.ts #444` | [hex_tile_math.md](hex_tile_math.md) | privateReservations.ts #444 — The hex a private power acts on |

### roundLabel.ts

| anchor | document | section |
|---|---|---|
| `roundLabel.ts #621` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #621 — The counter was the one field nobody stamped |
| `roundLabel.ts #643` | [firebase_middleware.md](firebase_middleware.md) | App.tsx #643 — The log is rebuilt too, not appended to |
| `roundLabel.ts #659` | [state_machine.md](state_machine.md) | utils/roundLabel.ts #659 — Which round an entry belongs to |

### routeWaypoints.ts

| anchor | document | section |
|---|---|---|
| `routeWaypoints.ts #11` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #11 — Off-board value plates print both tiers |
| `routeWaypoints.ts #62` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |
| `routeWaypoints.ts #256` | [routing_pathfinding.md](routing_pathfinding.md) | App.tsx #256 — A route runs between two paying stops |
| `routeWaypoints.ts #416` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #416 — The token is prompted, not placed |
| `routeWaypoints.ts #474` | [routing_pathfinding.md](routing_pathfinding.md) | routeWaypoints.ts #474 — A route must CONTAIN a token, not START at one |

### sessionKey.ts

| anchor | document | section |
|---|---|---|
| `sessionKey.ts #1` | [session_keys_wallet.md](session_keys_wallet.md) | sessionKey.ts #1 — Key generation |
| `sessionKey.ts #2` | [session_keys_wallet.md](session_keys_wallet.md) | sessionKey.ts #2 — sessionStorage, not localStorage |
| `sessionKey.ts #4` | [session_keys_wallet.md](session_keys_wallet.md) | sessionKey.ts #4 — Wire-format correction vs. the blueprint |
| `sessionKey.ts #5` | [session_keys_wallet.md](session_keys_wallet.md) | sessionKey.ts #5 — Any must be real protobuf bytes |
| `sessionKey.ts #17` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #17 — Standalone camera buttons |
| `sessionKey.ts #54` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #50 → #54 → #78 → #82 — The shield box, four times |
| `sessionKey.ts #62` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |

### stickyCollapse.ts

| anchor | document | section |
|---|---|---|
| `stickyCollapse.ts #480` | [ui_shell_layout.md](ui_shell_layout.md) | utils/stickyCollapse.ts #480 — "Scrolled at all" is not "pinned" |
| `stickyCollapse.ts #480a` | [ui_shell_layout.md](ui_shell_layout.md) | stickyCollapse.ts #480a — The release needs slack, the collapse does not |

### tileSupply.ts

| anchor | document | section |
|---|---|---|
| `tileSupply.ts #411` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #411 — The operating queue has to be built by somebody |
| `tileSupply.ts #431` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #431 — 1830's Operating Round counts |
| `tileSupply.ts #621` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #621 — The counter was the one field nobody stamped |
| `tileSupply.ts #627` | [hex_tile_math.md](hex_tile_math.md) | utils/tileSupply.ts #627 — Derived from the board, and why that is exact |

### tokenMigration.ts

| anchor | document | section |
|---|---|---|
| `tokenMigration.ts #0` | [hex_tile_math.md](hex_tile_math.md) | tokenMigration.ts #0 — The token moves, and nobody was told |
| `tokenMigration.ts #1` | [hex_tile_math.md](hex_tile_math.md) | tokenMigration.ts #1 — Preserve the index, and say so |

### turnGuardKey.ts

| anchor | document | section |
|---|---|---|
| `turnGuardKey.ts #414` | [contract_economy.md](contract_economy.md) | ContextualActionBar.tsx #414 — There is no such thing as paying $0 |
| `turnGuardKey.ts #433` | [contract_economy.md](contract_economy.md) | App.tsx #433 — No route, no obligation |
| `turnGuardKey.ts #511` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #511 — The sequence locks at the start of the cycle |
| `turnGuardKey.ts #642` | [sandbox_reducer.md](sandbox_reducer.md) | sandboxSession.ts #642 — The round machine belongs to the reducer |
| `turnGuardKey.ts #653` | [state_machine.md](state_machine.md) | utils/turnGuardKey.ts #653 — A once-per-game guard on a once-per-turn event |

### undoTarget.ts

| anchor | document | section |
|---|---|---|
| `undoTarget.ts #310` | [state_machine.md](state_machine.md) | App.tsx #310 — The snapshot has to cover every atom an action moves |
| `undoTarget.ts #439` | [state_machine.md](state_machine.md) | undoTarget.ts #439 — The original complaint |
| `undoTarget.ts #475` | [state_machine.md](state_machine.md) | undoTarget.ts #475 — The walk is gone; automatic actions do not snapshot |

**False positive recorded:** `corporationLivery.ts` cites `#000000` and `#FFFFFF`. Those are **hex colours,
not note references** — the same shape trap as `TileGraphics.ts #40`, which is a tile-tray number. A `#`
followed by digits is not automatically an anchor, and both cases are worth remembering before a future
pass tries to resolve one.

**One deliberate non-replacement:** `ChatBox.tsx B9` fuses a semantic JSDoc block (`@param roomId`,
`@param address`, `@param displayName`) with the `#644` diary block that follows it. The applier hard-fails
on `@param` rather than paraphrasing an API contract, so only the diary half was condensed and the JSDoc
survives byte-identical.

## Anchor index — Batches 6A/6B (Rust)

Every `#N` the Rust sources cite, and where it resolves. Rust numbering is **module doc comment #N**;
Audit codes (`G-1`…`G-17`) are named in the section headings rather than numbered here.

**Known false-positive class, recorded rather than chased.** `#53`, `#57`, `#59`, `#62`, `#63`, `#64`
and `#65` in the Rust sources are **real 1830 printed tray-tile numbers**, not note anchors — the same
`#N`-shaped trap as `TileGraphics.ts #40` (a tile-tray number) and `corporationLivery.ts #000000` (a hex
colour). A `#` followed by digits is not automatically an anchor.

### hexmap.rs

| anchor | document | section |
|---|---|---|
| `hexmap.rs #1` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #1 — Coordinate system |
| `hexmap.rs #2` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #2 — A real colour rule over an invented board |
| `hexmap.rs #3` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #3 — What the connection bitmask is not |
| `hexmap.rs #4` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #4 — Orientation is the player's, validated not auto-picked |
| `hexmap.rs #7` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #7 / #9 — The Token Station, and what connectivity means |
| `hexmap.rs #8` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #8 — Tech-era colour locking |
| `hexmap.rs #9` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #7 / #9 — The Token Station, and what connectivity means |
| `hexmap.rs #10` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #10 — Topology-retention upgrades |
| `hexmap.rs #11` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #11 / #16 — Landmark, City and Town reservation |
| `hexmap.rs #12` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #5 / #12 — Where the terrain cost goes, and when |
| `hexmap.rs #13` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `hexmap.rs #14` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #14 — Off-board reservation |
| `hexmap.rs #15` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #15 — Restored Boston/New York nameplates |
| `hexmap.rs #16` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #11 / #16 — Landmark, City and Town reservation |
| `hexmap.rs #17` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #17 — Standalone camera buttons |
| `hexmap.rs #18` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #18 — "OO": the check that did not exist |
| `hexmap.rs #19` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #19 / #20 — Gray hex immutability, and the routing bug it caused |
| `hexmap.rs #20` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #19 / #20 — Gray hex immutability, and the routing bug it caused |
| `hexmap.rs #22` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #22 — Impassable border edges |
| `hexmap.rs #23` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #23 — Homes, limits, costs, and one deliberate decoupling |
| `hexmap.rs #24` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #24 — Private-company-reserved hexes ⚠️ |
| `hexmap.rs #25` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #25 — House rule: NYC → Albany, NYNH → New York |
| `hexmap.rs #26` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #26 / #27 / #28 — "B" and "NY", three passes to get right |
| `hexmap.rs #27` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #26 / #27 / #28 — "B" and "NY", three passes to get right |
| `hexmap.rs #28` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #26 / #27 / #28 — "B" and "NY", three passes to get right |
| `hexmap.rs #29` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #29 (Audit G-5 + G-10) — the real 46-tile manifest, and terrain moves to the hex |
| `hexmap.rs #30` | [rust_contract_architecture.md](rust_contract_architecture.md) | hexmap.rs #30 (Audit G-9) — edge-to-edge geometry |
| `hexmap.rs #39` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #39 / #70 / #109 — Adaptive placement, and the offset that moved four times |
| `hexmap.rs #40` | [ui_shell_layout.md](ui_shell_layout.md) | appStyles.ts #40 — The rails must GROW, not merely exist |
| `hexmap.rs #41` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #41 / #49 / #54c — Stacked dual names move to centre |
| `hexmap.rs #42` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #42 — Perpendicular Bezier track splines |
| `hexmap.rs #43` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #43 — A floor below the fit |
| `hexmap.rs #44` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #44 — The control cluster left the canvas |
| `hexmap.rs #45` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #36 / #44 / #45 — The home-hex table and the ticker fallback |
| `hexmap.rs #46` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #46 / #48 / #116 / #513 / #564 — Token typography and livery |
| `hexmap.rs #47` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #47 / #364 / #366 — The reservation badge and its tooltip line |
| `hexmap.rs #53` | — | **FALSE POSITIVE: a real 1830 TRAY TILE NUMBER, not a note anchor** |
| `hexmap.rs #54` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #50 → #54 → #78 → #82 — The shield box, four times |
| `hexmap.rs #55` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #55 — Strict canvas layering hierarchy |
| `hexmap.rs #56` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #52 / #56 / #58 / #73 / #77 — The two-node coordinate, five passes |
| `hexmap.rs #57` | — | **FALSE POSITIVE: a real 1830 TRAY TILE NUMBER, not a note anchor** |
| `hexmap.rs #58` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #52 / #56 / #58 / #73 / #77 — The two-node coordinate, five passes |
| `hexmap.rs #59` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #59 / #60 / #61 — The town dit, three sizes |
| `hexmap.rs #61` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #59 / #60 / #61 — The town dit, three sizes |
| `hexmap.rs #62` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |
| `hexmap.rs #63` | — | **FALSE POSITIVE: a real 1830 TRAY TILE NUMBER, not a note anchor** |
| `hexmap.rs #64` | — | **FALSE POSITIVE: a real 1830 TRAY TILE NUMBER, not a note anchor** |
| `hexmap.rs #65` | — | **FALSE POSITIVE: a real 1830 TRAY TILE NUMBER, not a note anchor** |
| `hexmap.rs #66` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |
| `hexmap.rs #67` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #67 — Scroll-wheel zoom removed |
| `hexmap.rs #68` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge |
| `hexmap.rs #69` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #47 / #49 / #69 / #125 — The restriction badge |
| `hexmap.rs #70` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #39 / #70 / #109 — Adaptive placement, and the offset that moved four times |

### state.rs

| anchor | document | section |
|---|---|---|
| `state.rs #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `state.rs #17` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #17 — Standalone camera buttons |
| `state.rs #26` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #21 / #26 / #29 — The hover card |
| `state.rs #27` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #19 / #27 — Viewport maximisation, then true proportional scale |
| `state.rs #54` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #50 → #54 → #78 → #82 — The shield box, four times |
| `state.rs #59` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #59 / #60 / #61 — The town dit, three sizes |
| `state.rs #62` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |
| `state.rs #64` | — | **FALSE POSITIVE: a real 1830 TRAY TILE NUMBER, not a note anchor** |
| `state.rs #68` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #68 / #87 → #102 — The terrain compound badge |

### msg.rs

| anchor | document | section |
|---|---|---|
| `msg.rs #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `msg.rs #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `msg.rs #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `msg.rs #10` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #10 — Off-board pre-printed track |
| `msg.rs #11` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #11 — Off-board value plates print both tiers |
| `msg.rs #12` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #12 — Gray hexes and OO hexes |
| `msg.rs #17` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #17 — Standalone camera buttons |
| `msg.rs #23` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |
| `msg.rs #24` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |
| `msg.rs #55` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #55 — Strict canvas layering hierarchy |
| `msg.rs #56` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #52 / #56 / #58 / #73 / #77 — The two-node coordinate, five passes |
| `msg.rs #62` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |
| `msg.rs #64` | — | **FALSE POSITIVE: a real 1830 TRAY TILE NUMBER, not a note anchor** |
| `msg.rs #69` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #47 / #49 / #69 / #125 — The restriction badge |

### trading.rs

| anchor | document | section |
|---|---|---|
| `trading.rs #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `trading.rs #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `trading.rs #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `trading.rs #9` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #9 — The artwork is the content |
| `trading.rs #10` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #10 — Off-board pre-printed track |
| `trading.rs #12` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #12 — Gray hexes and OO hexes |
| `trading.rs #13` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `trading.rs #16` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #16 — Row letters and column numbers |
| `trading.rs #17` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #17 — Standalone camera buttons |
| `trading.rs #18` | [contract_economy.md](contract_economy.md) | WaterfallAuctionDashboard.tsx #12 / #18 — Certificates, one fill, state at the edges |
| `trading.rs #23` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |

### pathfinding.rs

| anchor | document | section |
|---|---|---|
| `pathfinding.rs #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `pathfinding.rs #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `pathfinding.rs #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `pathfinding.rs #5` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `pathfinding.rs #6` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #6 — The static board is the authentic 93 hexes |
| `pathfinding.rs #14` | [contract_economy.md](contract_economy.md) | App.tsx #14 — Buy Private Company action tray |
| `pathfinding.rs #15` | [canvas_rendering.md](canvas_rendering.md) | App.tsx #15 — Restored Boston/New York nameplates |
| `pathfinding.rs #20` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |
| `pathfinding.rs #53` | — | **FALSE POSITIVE: a real 1830 TRAY TILE NUMBER, not a note anchor** |
| `pathfinding.rs #61` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #59 / #60 / #61 — The town dit, three sizes |
| `pathfinding.rs #62` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |
| `pathfinding.rs #63` | — | **FALSE POSITIVE: a real 1830 TRAY TILE NUMBER, not a note anchor** |

### operations.rs

| anchor | document | section |
|---|---|---|
| `operations.rs #0` | [canvas_rendering.md](canvas_rendering.md) | RadialTileSelector.tsx #0 — Why the ring is DOM and the preview is canvas |
| `operations.rs #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `operations.rs #8` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `operations.rs #11` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #11 — Off-board value plates print both tiers |
| `operations.rs #12` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #12 — Gray hexes and OO hexes |
| `operations.rs #14` | [contract_economy.md](contract_economy.md) | App.tsx #14 — Buy Private Company action tray |
| `operations.rs #16` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #16 — Row letters and column numbers |
| `operations.rs #17` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #17 — Standalone camera buttons |
| `operations.rs #62` | [hex_tile_math.md](hex_tile_math.md) | HexGridRenderer.tsx #62 → #66 — Shape-based iconography, and five sizing passes |

### hardware.rs

| anchor | document | section |
|---|---|---|
| `hardware.rs #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `hardware.rs #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `hardware.rs #8` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `hardware.rs #10` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #10 — Off-board pre-printed track |
| `hardware.rs #10a` | [rust_contract_architecture.md](rust_contract_architecture.md) | hardware.rs — the train-limit cap (module doc comment #10a) |
| `hardware.rs #11` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #11 — Off-board value plates print both tiers |
| `hardware.rs #12` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #12 — Gray hexes and OO hexes |
| `hardware.rs #16` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #16 — Row letters and column numbers |

### contract.rs

| anchor | document | section |
|---|---|---|
| `contract.rs #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `contract.rs #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `contract.rs #8` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `contract.rs #10` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #10 — Off-board pre-printed track |

### gamelog.rs

| anchor | document | section |
|---|---|---|
| `gamelog.rs #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `gamelog.rs #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `gamelog.rs #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `gamelog.rs #5` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `gamelog.rs #8` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `gamelog.rs #23` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |

### waterfall.rs

| anchor | document | section |
|---|---|---|
| `waterfall.rs #1` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #1 — Pointy-top axial geometry, reverse-engineered |
| `waterfall.rs #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `waterfall.rs #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |

### query.rs

| anchor | document | section |
|---|---|---|
| `query.rs #2` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #2 — Client-side catalog mirrors, not queried |
| `query.rs #3` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #3 / #7 / #10 — Anchoring a card that grew 3× wider |
| `query.rs #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `query.rs #5` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #5 / #8 / #13 — Derived fit, clamped pan, locked baseline |
| `query.rs #23` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #20 / #23 / #24 / #25 — The DOM detour, and its reversal |

### auction.rs

| anchor | document | section |
|---|---|---|
| `auction.rs #4` | [canvas_rendering.md](canvas_rendering.md) | TileSelectionPopup.tsx #4 / #5 — No client-side re-validation, and no tile table |
| `auction.rs #11` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #11 — Off-board value plates print both tiers |
| `auction.rs #12` | [canvas_rendering.md](canvas_rendering.md) | HexGridRenderer.tsx #12 — Gray hexes and OO hexes |

