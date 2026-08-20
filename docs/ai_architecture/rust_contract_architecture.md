# Rust Contract Architecture — `src/*.rs`

The CosmWasm v1.5 contract behind 18Cosmos / 1830: Juno Edition. This file holds the extracted design
commentary for the Rust backend, on the same terms as the frontend domain files.

Anchors are `<source file> #<N>`. Search the number. Rust's own numbering is **module doc comment #N**
(`//!` items at the head of a file) and Audit item codes (`G-5`, `G-9`, `G-12`, …); both are preserved.

> **Toolchain note.** Several notes below carry a "could not run `cargo check` / `cargo test` in this
> session" caveat — `hexmap.rs #28`, `#30`, and `msg.rs`'s equivalents. **Those caveats are now
> historical.** The extraction pass that produced this document ran `cargo check --all-targets` against
> the real crate and it exits 0. The caveats are left in the source where they explain a *decision*, but
> they no longer describe the project's verification state.

---

## Backend divergences — the standing audit list

Collected while extracting the frontend, and cross-referenced here against the Rust that owns each one.
**None of these were fixed by the extraction passes** — the whole programme is comment-only. This is the
list the Phase 5 Rust Audit inherits.

| # | Divergence | Owner | Cross-reference |
|---|---|---|---|
| 1 | `GAME_END_PRICE_TRIGGER: u128 = 350` still fires. The frontend removed the $350 game-end rule as not-1830; the contract still ends games on it. | `market.rs` | frontend `rules_and_sourcing.md` (the $350 removal); `StockMarketRenderer.tsx #652`, whose "GAME END" tooltip marked a cell that ended nothing |
| 2 | `auction.rs` sets `is_floated` directly. Floating is `trading.rs`'s to decide; a second writer means a corporation can be floated without the share purchase that should have floated it. | `auction.rs` | `hexmap.rs #23` — `grant_home_station_token` is called from `auction::award_bo_president_share` **and** `trading::execute_buy_stock`'s float branch, "the only two places a `PublicCompany::is_floated` flag ever flips" |
| 3 | **F16 belongs to the wrong private.** `hexmap.rs`'s `PRIVATE_RESERVED_HEXES` gives F16 to the **Mohawk & Hudson** (`private_id` 4). The board says F16 is **Scranton**, the **Delaware & Hudson**'s hex; the frontend reserves B20 for the C&SL and F16 for the D&H. | `hexmap.rs #24`, `auction.rs` | frontend `privateReservations.ts #0`–`#2`; `WaterfallAuctionDashboard.tsx #312` |
| 4 | `EndGameAndDistribute` runs the **same** `finalize_and_distribute_payouts` as a natural game end. A host who is ahead can end the game and bank the lead. There is **no refund path, no annulment, and no 48-hour timeout state at all.** | `contract.rs` / `escrow.rs` | frontend `endgame.ts #4` — the payout column is explicitly a `PLACEHOLDER_*` because "the contract has not said which" policy applies |
| 5 | `BuyPrivateCompany` is **single-party with no consent step**, while `TrainOffer` already implements the exact accept / reject / rescind pattern needed. | `trading.rs #17` | `train_trade.rs`; frontend `TrainTradePanel.tsx #1` (three audiences, one panel) |
| 6 | The **C&SL's free tile lay** is described in the UI and not implemented. | `auction.rs` | frontend `privateCatalog.ts`, `PrivatePowerPanel.tsx` |
| 7 | The **C&A's PRR share on purchase** is described in the UI and not implemented. | `auction.rs` | frontend `privateExchange.ts #576` — the share "arrives on PURCHASE and the private stays open" |
| 8 | **No `QueryMsg` exposes** `HARDWARE_POOL`, `COMPANY_HARDWARE` or `TRAIN_CATALOG`. | `query.rs` / `hardware.rs` | frontend `mockFixtures.ts` — `MOCK_TRAIN_CATALOG` is a hand-kept mirror precisely because of this |
| 9 | **No `QueryMsg` exposes route revenue.** | `query.rs` / `pathfinding.rs` | frontend `dividendStep.ts #492` — the frontend has to carry a committed total itself |
| 10 | **NEW (this pass): the manifest is `cargo.toml`, lowercase.** Cargo resolves it on Windows and macOS because those filesystems are case-insensitive. **On Linux — CI, Docker, any release build — `cargo` looks for `Cargo.toml` and does not find it.** This is the same trap as the frontend's `Logos`/`logos` directory (`CorporateLogo.tsx #410`): it cannot fail on the machine it was written on. | repo root | `CorporateLogo.tsx #410` |
| 11 | **NEW (this pass): no `QueryMsg` exposes `state::REMAINING_TILES`.** The frontend re-derives tile supply by counting the board. | `query.rs` / `state.rs` | frontend `tileSupply.ts #627`, which argues the interim is sound and names `GetTileSupply` as the right shape |
| 12 | **NEW (this pass): `LayTile` carries no token destination.** A hex upgrade that splits one city into two cannot express which city the president's token should take, so the frontend can only *declare* the mapping and report genuine ambiguity. | `msg.rs`, `hexmap.rs` | frontend `tokenMigration.ts #1` |

---

# hexmap.rs — the tile-laying engine

4,442 lines, of which 2,487 were comment and a single **952-line module doc comment** carried thirty
numbered notes, several of which supersede or correct each other in place. This section is that history,
in order, with the corrections applied and the dead ends kept.

## The board model

### hexmap.rs #1 — Coordinate system
`(q, r)` axial. **Edge `i` on the tile at `(q, r)` touches edge `(i + 3) % 6` on the neighbour at
`(q, r) + HEX_NEIGHBOR_OFFSETS[i]`** — the standard axial convention, **nothing here is 1830-specific.**

### hexmap.rs #2 — A real colour rule over an invented board
There is no predefined board with fixed per-hex terrain, so — **unlike the physical 1830 map, where
mountains, rivers and city values are properties of specific printed hexes** — terrain was originally
modelled as a property of **the tile artwork**. `tile_id` numbers were **this engine's own sequential
catalog IDs, NOT claims about real tray numbers.**

What *is* pure 1830 even under that model: **each tile's `TileColor` tier and the era-unlock gating it
(#8), the Token Station connectivity requirement (#9), topology-retention upgrades (#10), and the three
reserved landmark cities (#11).**

> **#29 later replaced the invented catalog outright.** See below — the tile IDs are now the real printed
> tray numbers, and terrain moved onto the hex where it belongs.

### hexmap.rs #3 — What the connection bitmask is not
A tile's `connections` records **which of its six edges carry a track stub, not how those edges pair up
internally.** That belongs to the revenue path tracer. **#30 later added the pairing** — see below, and
note that the mask's insufficiency was a real routing bug for as long as it stood alone.

### hexmap.rs #4 — Orientation is the player's, validated not auto-picked
**STRUCTURAL FIX superseding an earlier pass** which had `execute_lay_tile` silently try all six
rotations and commit whichever was legal first. **Real 1830 lets a player choose which direction a new
tile's track extends — which hex it reaches toward next is a meaningful strategic decision, not an
implementation detail the contract should decide on the player's behalf.**

`execute_lay_tile` rejects `orientation` outside `0..=5` (`InvalidOrientation`), then evaluates **exactly
the submitted rotation and no other** — erroring **even if some other rotation would have been legal.**
`legal_tile_placements` (`QueryMsg::GetLegalTilePlacements`) is the intended discovery path.

**A protocol's very first tile has no network to connect to**, so any orientation 0-5 is unconditionally
accepted for it — it stands in for that protocol's home hex/Token Station.

### hexmap.rs #5 / #12 — Where the terrain cost goes, and when
Paid from `PublicCompany::treasury` and credited into `GameSession::virtual_bank_vgp` — **consistent with
how every other VGP sink in this contract keeps funds circulating in the bank rather than deleting them
from state.**

**#12 corrected the timing.** Real 1830 charges terrain **only when the first (always-Yellow) tile is laid
onto empty land; every later colour upgrade is free, since the terrain does not change, only the track
drawn on top of it.** An upgrade charges `Uint128::zero()` regardless of what the catalog lists —
**superseding #5's original "full listed cost, same as a fresh placement", which was an intentional
simplification at the time but not the real rule.**

### hexmap.rs #6 — Revenue is a terrain lookup, not a per-tile number
**REVENUE PATHING CORRECTION:** Plain **$0**, Mountain/Rugged **$0**, Small Town **$10**, Major City Hub
**$20**. Plain and mountain track **is a pure connector with no printed revenue of its own** — only a
route that actually reaches a town or city earns anything.

The earlier figures gave Plain/Mountain the same $10/$20 as Town/City, which **let a company earn revenue
by laying ordinary track alone, with no town or city anywhere on its route. That was a straightforward
game-design bug, not a deliberate simplification.**

`pathfinding.rs` reads every visited hex through this same lookup and **only ever for a hex that actually
has a `Tile` in `MAP_GRID`** — an unbuilt hex is **skipped outright rather than defaulting to any
terrain.** *(#17 and #20 later carve out the preprinted hexes; see below.)*

> **#11 later superseded the flat bucket entirely** — see `#94`/Audit G-11: the tile's **own printed
> revenue** wins, because revenue in real 1830 is a property of the printed TILE, not of its category.
> **#62 and #64 are both two-city brown "NY"-class artwork and print $90 and $50** — under a
> seven-value `TerrainType` model they were necessarily equal, and both wrong.

### hexmap.rs #7 / #9 — The Token Station, and what connectivity means
Until a real Token Station Placement step existed, **a protocol's Token Station is the very first tile it
ever laid** (`PROTOCOL_NETWORK_HEXES`'s first entry).

Every later tile must have **at least one edge that legally meets a neighbouring tile whose opposite edge
is also live AND which itself has a continuous, unbroken path back to the Token Station under the map's
CURRENT laid connections** — verified fresh on every call by `station_reachable_hexes`, a BFS from the
station outward.

**Recomputed fresh rather than trusting the historical membership list, and that matters because of
upgrades (#10): an upgrade elsewhere in the network can add edges that change what is currently
reachable, which a purely historical list would not reflect.**

### hexmap.rs #8 — Tech-era colour locking
`current_global_era` starts Yellow. **The first-ever 3-train purchase unlocks Green; the first-ever
5-train unlocks Brown** (`hardware::record_purchase_and_apply_rusting`) — the real 1830 phase chart. Any
tile whose colour exceeds the room's era is `EraLocked`, **for a fresh placement and an upgrade alike.**

### hexmap.rs #10 — Topology-retention upgrades
Laying at an occupied `(q, r)` is legal **exactly when it is a genuine one-tier colour upgrade**
(`Yellow → Green` or `Green → Brown`; anything else is `InvalidColorUpgrade`/`AlreadyMaxColor`).

The upgrade must **preserve every one of the old tile's actual rotated edges** — the search is for a
rotation where `old_actual & !new_actual == 0`. **No track can be deleted or disconnected by an upgrade.**

**`NoLegalConnection`'s station-reachability search is SKIPPED for an upgrade: preserving every old edge
automatically preserves whatever connectivity the old tile had already verified, so nothing new needs
re-checking.**

## Reserved hexes — five disjoint gates

### hexmap.rs #11 / #16 — Landmark, City and Town reservation
`LANDMARK_HEXES` fixes **New York, Boston, Baltimore**. A landmark hex may **only** receive
`MajorCityHub` artwork, and — **symmetrically** — a `MajorCityHub` tile may only be laid **at** a
reserved hex.

**#16 generalised that into a full preprinted-infrastructure gate over all 93 hexes:**

| List | Contents |
|---|---|
| `CITY_DESIGNATED_HEXES` | six real preprinted **GRAY** cities (Lansing D2, Cleveland F6, Altoona H12, Rochester D14, Richmond K15, Montreal A19) + eight ordinary **WHITE** city hexes with a bare marker and no printed track (Toledo F4, Providence F22, Pittsburgh H10, Columbus H4, Washington J14, Lancaster H16, Ottawa B16, Barrie B10) + Albany E19 (added later) |
| `TOWN_DESIGNATED_HEXES` | three GRAY single-town (Kingston C15, Atlantic City I19, Mansfield F24) + four white single-town (London E7, Burlington B20, Flint D4, Erie F10) + three white **double**-town (Akron & Canton G7, Reading & Allentown G17, New Haven & Hartford F20) |
| `OO_DESIGNATED_HEXES` | four preprinted **YELLOW "OO"** double-city hexes (Detroit & Windsor E5, Hamilton & Toronto D10, Dunkirk & Buffalo E11, Philadelphia & Trenton H18) |

All **verbatim-sourced from `tobymao/18xx`'s `g_1830/map.rb` `HEXES` hash.** **Two names in the
originating request did not match the source and were corrected rather than applied as given: B16 is
Ottawa, not "Barrington".**

**The third rule needs no rule.** "Blank plains, mountain or river hexes can only receive plain track"
**falls out of the two symmetric gates** rather than needing its own check.

### hexmap.rs #14 — Off-board reservation
`OFFBOARD_HEXES` fixes the **seven real red off-board terminals** (Chicago F2, Canadian West A9 + A11,
Gulf I1 + J2, Deep South K13, Maritime Provinces B24). **Unlike a landmark hex, which accepts exactly one
tile type, an off-board hex accepts NO tile artwork at all — it is a printed revenue destination, not
track a Protocol lays onto.** Checked **before** the landmark gate: the sets are disjoint and off-board is
the more absolute restriction.

### hexmap.rs #19 / #20 — Gray hex immutability, and the routing bug it caused
Real preprinted **GRAY** hexes are fixed, permanent starting track and **can never be upgraded at all** —
unlike a preprinted **Yellow** hex (a landmark or OO hex), which starts with real track too **but is
explicitly meant to be built on top of later.**

**This did not exist before #19.** Nothing distinguished a real GRAY city from an ordinary blank white
marker for placement purposes — **a player genuinely could lay a brand-new tile at Cleveland as though it
were undeveloped land.**

**#20 widened the list from nine to twelve**, adding the three bare GRAY **connector** hexes (E9, A17,
D24) — real fixed track, no station of any kind. **A data-widening fix, not new sourcing:** coordinates
came from this file's own `BOARD_HEX_LABELS` and cross-checked against the frontend's `GRAY_HEXES`,
which already carried the complete twelve-hex dataset.

> **#20 also caught the latent bug #19 had silently introduced, and it is the most instructive failure in
> this file.** Once a GRAY hex can never receive a laid `Tile`, `pathfinding::effective_tile_and_value`'s
> `MAP_GRID.may_load` branch **can never fire for that hex again** — and only five of the nine had a
> synthetic virtual tile standing in. **The other seven were, from the day #19 shipped, silently
> unroutable dead zones: no route could pass through them or score anything, contradicting their real
> printed track.** **`tests.rs` never caught it because #19's tests exercise placement legality, not route
> tracing.** Widening to the three bare connectors **would have made it considerably worse — E9/A17/D24
> are pure through-connectors, and losing them could sever board regions entirely.**
>
> Fixed by extending the synthetic-tile fallback to **every** `gray_preprinted_name_at` hex, using the
> same permissive full-six-edge virtual tile (tile_id 10) the original five used, **so none of these hexes
> can itself block a route.**

### hexmap.rs #22 — Impassable border edges
Four board-edge crossings that must never carry track — **E7/F8, D12/C11, D12/C13, C17/B16** — as eight
symmetric `(q, r, edge)` entries, **both hexes on each side carrying their own entry, so the block holds
regardless of which side's tile would have routed across it.**

**A per-EDGE restriction, unlike #14/#19 which reject a whole hex:** the hex stays ordinarily buildable,
but no orientation may leave a live connection on the blocked edge.

**`pathfinding.rs` needs no matching change: since no tile can ever legally carry a live edge across one
of these borders, a route can never traverse one either** — a structural placement-time guarantee rather
than a redundant runtime check.

**This is a custom board-geometry restriction specified directly for this engine, NOT sourced from the
real 1830 rulebook** — unlike this file's other terrain facts, **it has no source to check against.**

### hexmap.rs #24 — Private-company-reserved hexes ⚠️
**B20** (Burlington, `(9, 1)`) is reserved for the **Delaware & Hudson** (`private_id` 3) and **F16**
(`(5, 5)`) for the **Mohawk & Hudson** (`private_id` 4).

> ⚠️ **DIVERGENCE #3.** The frontend has F16 as **Scranton, the D&H's** hex, and gives the **M&H no
> reserved ground at all** (`privateReservations.ts #0`; `WaterfallAuctionDashboard.tsx #312`). **One of
> the two is wrong and they cannot both be applied.** Not resolved by this pass.

**Keyed off `PrivateCompany::owner_protocol_id`, NOT `owner`** — per an explicit clarification, **these
powers only activate once a CORPORATION owns the private, never while a player merely holds the
certificate.** The block **lifts globally the instant `PrivateCompany::closed` is true**, which happens to
every open private when the first 5-train is bought.

**This engine has no separate `Phase` type:** Phase 3 maps to `TileColor::Green` and Phase 5 to
`TileColor::Brown` via `hardware.rs`'s `ERA_UNLOCK_TRIGGERS`, **so this gate never reads
`current_global_era` directly, only `closed`.**

**Also a custom house rule** — real 1830's D&H and M&H **carry no hex-reservation power at all.**

## Station tokens

### hexmap.rs #23 — Homes, limits, costs, and one deliberate decoupling
`CORPORATION_HOME_HEX` sources every coordinate **verbatim from this file's own already-verified
landmark/city/OO lists, never a new coordinate.** `STATION_TOKEN_LIMIT`: **PRR/NYC/CPR 4, B&O/C&O/ERIE 3,
NNH/B&M 2** (home token included). `station_token_cost`: **1st free, 2nd 40 VGP, every one after 100 VGP**
— flat, not per-corporation.

**The sourcing is honest about a conflict:** the official rulebook **only says "2-4" without listing
specifics**, and a secondary source's per-company table **contradicts the rulebook's own stated max**. **The
exact counts came from the requester rather than either conflicting source.** The *cost* progression is
**the one part those two sources did NOT disagree on.**

**DELIBERATELY DECOUPLED from the Token Station / `PROTOCOL_NETWORK_HEXES` system.** The free home token
writes **only** to `PROTOCOL_STATION_HEXES` — **so it does NOT retroactively become "the first tile this
protocol ever laid" for the connectivity BFS**, and the tile-laying machinery does not have to
special-case a station hex with no tile on it.

**An accepted, intentional simplification, stated rather than hidden:** a corporation's home-city marker
is **purely a Station Token / informational object and does not anchor where its track network may grow
from** — that remains wherever its President's first `LayTile` lands.

**Per-hex "how many corporations may token this one city" was NOT modelled here** — only a
per-corporation limit was requested, **so none is invented.** *(Audit G-12 later added exactly that; see
below.)*

`execute_place_station_token` additionally requires: the hex holds a laid city tile
(`StationTokenHexNotACity`); it is reachable from the protocol's track network **read via the very same
`station_reachable_hexes` the tile-laying engine uses, called read-only, never mutated**; no duplicate
token (`StationTokenAlreadyOnHex`); under the limit; and **not already placed this Operating Round
sub-round** (`StationTokenAlreadyPlacedThisSubRound`) — **a new pattern, because there was no existing
"already did X this turn" tracking anywhere in this contract to reuse.**

**ERIE's home E11 is a shared OO double-city hex.** Real 1830 has Erie's President **choose one of the two
cities** on Erie's first OR turn. **That per-corner choice is not modelled** — flagged, not assumed away.

### hexmap.rs #25 — House rule: NYC → Albany, NYNH → New York
**Asked three times.** `CORPORATION_HOME_HEX` now gives **NYC (company_id 2) Albany E19** and **NNH
(company_id 7) New York G19**, which NYC vacates — a clean swap, no collision. **Explicitly a house rule
for this custom board, not a factual claim about real 1830**, where NYC's home is New York G19 and NYNH
shares that same hex.

**MECHANICAL VERIFICATION done before applying:** `grant_home_station_token` performs an unconditional
`PROTOCOL_STATION_HEXES` write with no membership assertion, and the home token was **never wired to
tile-laying or route legality for ANY corporation** — so moving NYC's marker **changes nothing
mechanically.** Precedent: **PRR's home token already sits on Altoona, a hex that can never itself receive
a laid tile at all.**

**KNOWN CONSEQUENCE, flagged rather than silently accepted: NYC is now the only corporation whose home hex
carries zero printed starting value or track** — a genuine gameplay asymmetry, not a bug.

## The label-restricted tiles, and a sourcing failure worth keeping

### hexmap.rs #18 — "OO": the check that did not exist
A request asked the contract to **verify, not just log**, that the four OO hexes can only be upgraded with
real double-city artwork. **That check DIDN'T actually exist:** `TerrainType` had **no double-city variant
at all**, and every city-designated hex required nothing more specific than plain `MajorCityHub` —
**whether it was a real GRAY city, a blank marker, or a real two-station OO hex. A player genuinely could
upgrade Detroit & Windsor with the same generic hub tile as any other city.**

Fixed with a `DoubleCityHub` variant, a disjoint `OO_DESIGNATED_HEXES` list, and a symmetric gate.
`TILE_CATALOG` gained **one Green entry — real sourced tile #59** — and **ONLY Green, deliberately: OO
hexes start preprinted Yellow (so there is no Yellow lay to make there), and the real 1830 tile set has no
Brown OO tile at all.** *(#27 later added five Brown OO tiles; see below — the "no Brown OO" claim was
wrong.)*

### hexmap.rs #26 / #27 / #28 — "B" and "NY", three passes to get right
**#26** restricted Boston's and New York's **Green** upgrade to one dedicated tile apiece, via new
`BostonHub` / `NewYorkHub` terrains.

**#27** extended it: **(a) Baltimore also carries the "B" label** — "B" names a *label shared by two
hexes*, not a single hex, the same way "OO" names four; **(b) the restriction extends to the BROWN tier**;
**(c) the OO hexes' Brown upgrade is also label-restricted**, to five distinct artworks.

> **#27's VERIFICATION STATUS paragraph is the most valuable thing in this file, because it states plainly
> what it could not confirm.** Attempts to re-confirm Baltimore's "B" label and the tray numbers **returned
> internally inconsistent hex-to-label results across separate fetches**, and `TILES.md` turned out to be
> **a cross-game tile-shape glossary, not a per-game manifest.** Baltimore-carries-"B" was implemented on
> ordinary rules-reference material and the request's own wording, **but explicitly NOT re-confirmed
> against a primary source that pass.** The tray numbers were recorded **only as inline comments citing
> "per request, not independently re-verified", never as sourced fact.**
>
> **And #2's abstraction is what made that safe:** `TILE_CATALOG`'s `tile_id`s were the engine's own
> synthetic IDs, **so an unverified real-world number never leaked into contract logic — it only ever
> appeared in a comment.**

**#28 then found the tray numbers were wrong.** Confirmed against `lib/engine/config/tile.rb` (the actual
per-tile manifest #27 had not found) and `g_1830/map.rb`, **fetched twice independently:**

- **Green "B" is real tile #53, NOT #55** (#55 is an unrelated plain double-town tile with no "B" label).
- **Green "NY" is real tile #54, NOT #57** (#57 is an unrelated generic green city tile used all over the
  board).
- Green "OO" #59, Brown "B" #61, Brown "NY" #62 and Brown "OO" #64-#68 were already correct.
- **Every one of those seven entries' `0b11_1111` all-six-edges placeholder was REPLACED with the real
  tile's edge pattern — 2-4 live edges out of 6, never all six.**

**#28's new finding, not in the original request:** Boston, Baltimore and New York are each a
corporation's home station (B&M, B&O, NYNH) and **NEVER take a plain Yellow tile at all — their first real
lay is straight to their own dedicated Green tile.** The `&& is_upgradeable_tier` guard **let the Yellow
`MajorCityHub` tile slip through to these three hexes via the generic landmark fallback.** Removing it
makes the restriction apply **at every tier.**

**The disclosed consequence:** a freshly-floated B&M/B&O/NYNH **now requires the room's Green era to be
unlocked before it has any legal tile at its home hex.** **"If a room's Green era unlocks well after these
corporations typically float, they would have zero legal tile options at their home hex until then" — a
real, disclosed behaviour change, not silently absorbed.** (Its network can still extend outward from the
untiled home hex via the permissive-untiled-neighbour fallback.)

## The two audits that rebuilt the catalog

### hexmap.rs #29 (Audit G-5 + G-10) — the real 46-tile manifest, and terrain moves to the hex
`TILE_CATALOG` now holds **all 46 distinct 1830 tile artworks, 85 physical copies**, keyed by **REAL
printed tray numbers (#1-#70, with the gaps the real game has).**

**It previously held 21 entries under an invented numbering that COLLIDED with real tray numbers while
meaning something different — so `GetLegalTilePlacements` handed a player "tile 16" when the physical game
calls that tile #53.** The **85-copy total independently corroborates the "85 hex tiles" figure printed on
the physical game's own component list.**

**Five invented tiles are DELETED, not renumbered:** the old 4/5 ("river crossing"/"mountain pass"), 12
(green mountain), 11 (green straight track, **a shape 1830 has no green tile for**), and 13 (an
all-six-edges green city **matching neither real #14 nor #15**).

> **The first three existed only to carry a terrain build cost on the tile, and that was the G-10 bug:
> because the fee rode on the ARTWORK rather than the HEX, laying an ordinary plain tile onto a genuine
> river or mountain hex was completely FREE, while laying "mountain pass" onto flat grassland charged $80
> for nothing.**

`RIVER_HEXES` / `MOUNTAIN_HEXES` / `terrain_build_fee` now model terrain **the way the physical board
does — $80 water, $120 mountain, $0 clear land, read from the hex** — matching `g_1830/map.rb`'s own
`upgrade=cost:` values **and the frontend's `TERRAIN_BUILD_COST_LABEL`, so what a player is shown is what
the contract charges.**

`TerrainType::MountainRugged` **survives as a variant no tile carries**, so the match stays exhaustive,
**already-stored `Tile` records deserialize unchanged**, and the frontend's enum needs no lockstep change.

### hexmap.rs #30 (Audit G-9) — edge-to-edge geometry
`TILE_CATALOG` gained a seventh field: **each tile's real internal wiring, as edge-to-edge segments, for
all 46 entries.** #29 brought in the correct masks, **which is not enough to route on:**

> **Real tile #1 is two INDEPENDENT towns, one joining edges 1 and 3 and the other joining 0 and 4. A mask
> cannot distinguish that from a four-way junction, so `pathfinding.rs` let trains enter on edge 0 and
> leave on edge 3, across track that does not exist.**

The encoding:

- **`(a, b)`, `a != b`** — a **THROUGH** segment, traversable either way. A revenue centre on it is
  stopped at in passing.
- **`(a, a)`** — a **TERMINAL SPUR** into an interior revenue centre with no second exit. **A train may
  enter and END there; it may never pass through.** Carried by exactly one entry, **yellow "OO" tile #59,
  whose two cities are genuinely separate stubs — and which a mask cannot express at all.**

Pairs are listed **once, in `(min, max)` order**, so a segment claimed travelling `a → b` is the same
ledger entry as one claimed travelling `b → a`.

**Decoding rule**, applied to `tile.rb`'s quoted source strings: `path=a:X,b:_N` + `path=a:_N,b:Y` is a
through segment `X-Y` via revenue centre `N`; **a centre with `k ≥ 2` spokes yields all `k(k-1)/2`
pairings** (a city is one node — any spoke reaches any other); **a centre with exactly one spoke yields a
terminal spur.**

**NOTHING ABOUT TILE LAYING CHANGED.** The mask is retained and is still the only thing placement,
`impassable_edge_mask` and the frontend renderer consult. **All 46 derived masks were checked against the
pre-G-9 hand-entered ones and every single one agreed**, so no tile's edge set and no placement's legality
moved. `tile_base_connections` re-derives the mask from the paths **so the suite holds the two in lockstep
permanently.**

**Edge numbering** follows this engine's own convention, **which is a MIRROR of `tobymao/18xx`'s (their
edge `e` is this engine's `(4 - e) mod 6`).** For a freely-rotatable tray tile **that is immaterial:
reflection maps the tile set onto itself, exchanging only the mirror-image pairs #23/#24 and #45/#46, each
present in identical quantity, so the tray a room can lay is unchanged.**

## Per-city capacity — Audit G-12 and G-13

### The bug: a hex is not a city
**There was no capacity check at all before G-12** — only "not twice on the same hex" and the company's
own token limit. **Nothing stopped every corporation in the game from tokening the same 1-slot city, which
is the rule that makes contested cities contested in the first place.**

**Checked per CITY, never per hex.** **#62 carries two separate 2-slot cities and #54/#59/#64-#68 two
separate 1-slot cities, so a hex-level "is there room" question has no correct answer on any of them.**
**#62 is the tile that makes pooled per-hex slot counting unsalvageable.**

Slot sourcing, from each tile's own `slots:` field:

- `#53`/`#57`/`#61` — `city=revenue:N` with no `slots:` → **one 1-slot city.** **Note #61, the BROWN "B"
  hub, really is 1-slot; its importance on the board invites the assumption that it is 2, and it is not.**
- `#14`/`#15`/`#63` — `slots:2` → one 2-slot city.
- `#54`/`#59`/`#64`-`#68` — two `city=` entries, neither with `slots:` → **TWO separate 1-slot cities.**
- `#62` — two `slots:2` cities → **TWO separate 2-slot cities, the only tile in 1830 shaped that way.**

**Preprinted hexes have their own counts** (`preprinted_city_slot_counts`): **New York prints
`city=revenue:40;city=revenue:40` — two one-slot cities, so 2**; the four OO hexes likewise 2; Boston,
Baltimore and every city-designated entry 1. **That list's six gray cities matter most: #19 made them
permanently un-layable, so `MAP_GRID` never holds a `Tile` there and this lookup is the ONLY source of
their slot count, forever.**

**The legacy backfill is what makes G-12 safe to deploy mid-game.** `hex_token_occupants` reads
`HEX_STATION_TOKENS`, then **reconstructs anything that map does not know about from
`PROTOCOL_STATION_HEXES`, assigning `city_index` 0** — **silently dropping them would delete live blockades
mid-game.** City 0 is **the honest reconstruction: it is precisely the assumption the pre-G-12 code made,
and it is exactly right for every single-city hex, which is most of the board.** The reconstruction is
**never persisted — writing it back would freeze a guess into storage as though it were a record.**

### hexmap.rs Audit G-13 — which city a segment runs through
`tile_segment_cities` is **the lookup that makes a blockade check city-granular instead of hex-granular.**
**Without it the engine can tell that SOME city on a hex is open but not WHICH, so a route could enter a
tile through a fully-tokened city's track and leave through it again — "ghost routing" straight past a
blockade that in real 1830 is the whole point of having placed those tokens.**

**`None` means one of two very different things** and the caller **MUST** distinguish them by checking
whether the hex has cities at all: the tile genuinely has no city (nothing can block it), **or the segment
list does not line up with the city list** — today a synthesized overlay tile. **A caller that finds
`None` on a hex that DOES have cities must fall back to the strictest city's answer, never the most
permissive one — guessing permissively is exactly the ghost route this exists to stop.**

**THE INDEX CORRESPONDENCE IS THE LOAD-BEARING CLAIM.** Every multi-city tile in 1830 has **exactly one
segment per city**, and the catalog lists them in city order — asserted for all of them by
`tile_segment_cities_agree_with_catalog_path_counts`, **so a future catalog edit that breaks the
correspondence fails the suite rather than silently reintroducing ghost routing.**

`segment_count` is passed rather than read from the catalog **because the caller may be working from a
`Tile`'s OWN stored `paths`; if that list has a different length, the correspondence cannot be trusted and
every entry comes back `None` — conservative by construction.**

## The rest of the machinery

### `effective_base_tile_paths` — the fallback that is not dead code
Prefers the tile's own stored `paths`, falling back to the catalog when empty. **`Tile::paths` is
`#[serde(default)]`, so any tile written before G-9 deserializes with an empty list and would otherwise
become permanently unroutable — a silent board-wide dead zone of exactly the kind #20 had to fix once
already.**

### `legal_tile_placements` — the MAINTENANCE NOTE
This function's per-rotation checks are **independent implementations of the same rules
`execute_lay_tile` enforces, not a shared helper the two call into** — so **any change to one must be
mirrored in the other, or the query starts disagreeing with what `LayTile` actually accepts.**

> **That is not hypothetical. It has already happened twice:** the very-first-tile branch **used to push
> only orientation 0** while `execute_lay_tile` accepted any of the six, **so `GetLegalTilePlacements` was
> silently hiding five of six legal orientations for a protocol's home hex**; and the `is_upgradeable_tier`
> guard had to be removed from **both** copies in #28.

**Ordering is deliberate:** the tray-supply check is **the LAST whole-tile disqualifier rather than the
first**, because era-locking and the reservation checks are pure in-memory comparisons while that one is a
storage read. **Now that the catalog holds all 46 tiles, running the cheap filters first cuts this query's
storage reads from 46 to however few are terrain-compatible with the hex — typically a handful.**

### `execute_lay_tile` — Checks-Effects-Interactions, and why recycle precedes consume
The tray pre-check is **read-only, purely for clean error ordering**; the authoritative decrement happens
in the Effects section via `consume_tile_from_tray`, **which re-validates the same condition. Nothing
between here and there can change the tray.**

**On an upgrade, RECYCLE FIRST, then consume** — the tile lifted off the board returns to the tray before
the new one is taken out — **so a company can legally spend the tray's very last copy in the same action
that returns a different copy to it, and neither operation can ever observe a transiently negative
count.**

### `station_token_reachable_hexes` — a wider reachability, deliberately separate
Mirrors `station_reachable_hexes` but **also treats any GRAY preprinted hex as fully connected on all six
edges.** Without it, a real, permanently-un-layable GRAY city **could never be treated as reachable at
all.**

**A SEPARATE function rather than a shared one**, and that boundary is the point: **reachability for
TOKENS may see further — through permanent gray track — than reachability for LAYING NEW TILES does**,
which stays exactly as strict as before the feature.

### `BOARD_HEX_LABELS` / `describe_hex` — #15, traceability
`(q, r)` remains the storage and message key throughout; **they already ARE the literal, un-abstracted
transform of the printed board's own labels, not a "simplified array index" divorced from it.**
`BOARD_HEX_LABELS` is the **authoritative 93-entry table, a byte-for-byte port of the frontend's
`STATIC_BOARD_HEXES`.** **Every `HexMapError` variant that carries a coordinate also carries `hex_label`**,
so **nothing this contract surfaces about a hex requires hand-computing the axial transform to check it
against the physical board.** `describe_hex` **never returns `None`** — an off-board test coordinate still
gets a clearly-marked string **instead of forcing every caller to handle a missing label.**

### `LANDMARK_START_VALUE_OVERRIDE` — six sourced figures, and three deliberate refusals
**New York $40, Boston $30, Baltimore $30, Montreal $40, Cleveland $30, Altoona $10** — verified against
`g_1830/map.rb`. **Altoona is genuinely a City, not a Town** (`'city=revenue:10,...'` — **a `city=` entry,
not `town=`**, re-verified twice), **worth a real sourced $10, NOT the generic flat $20 it fell through
to** — added as an override **rather than reclassifying its `TerrainType`, so its marker, badge and
placement rules all stay as a `MajorCityHub`'s; only its priced figure changes.**

**Lansing, Rochester and Richmond are deliberately NOT included: no individually-sourced figure for them
has been verified in any pass to date** — the established **"don't guess a number"** precedent.

### The DoubleCityHub revenue correction — wrong, then wrong the other way, then right
1. Priced flat **$40**, by analogy to `DoubleTown`'s "$10 stop → $20 double" pattern — **silently treating
   each station as $20, not the $40 already sourced and quoted in the very same paragraph.**
2. **Corrected to $80** (2 × the cited $40) as an internal-consistency fix.
3. **$80 was itself an error, caught on review of that paragraph's own conclusion.** **Tile #59's real path
   data is two DISCONNECTED one-edge stubs — edge 0 to station A, edge 2 to station B, with no path
   between them at all.** A route entering and leaving via one edge **can only ever reach ONE of the two
   stations per visit — never both — so crediting $80 assumed exactly the "touches both stations in one
   continuous pass" scenario the same paragraph had just ruled out** (and which, on this tile's real
   topology, **is not possible regardless of implementation effort**). **Corrected back to a flat $40.**

**#21 backported the same correction to `DoubleTown`**, which **was simply never revisited when the
DoubleCityHub fix landed: corrected from $20 to a flat $10, the same figure a single `SmallTown` scores.**
**That is a pure `terrain_base_value` change — `TILE_CATALOG`'s own $20 field is a SEPARATE number (the
one-time terrain lay cost) and is correctly still distinct from the hex's revenue value.**

> **The two-station-crediting model remains unbuilt and correctly flagged.** A request described it as a
> route "exiting the hex, wrapping around, and re-entering along a different track" — **re-verified against
> real 18xx route-validation sources to still be factually incorrect: the authentic mechanic is a SINGLE
> continuous pass touching both stations via real printed track, never hex re-entry**, and re-entry would
> **also violate this engine's own already-correct "no hex revisited within one route" invariant.** **The
> same conclusion, and the same rejection, as the first time this exact mechanic was proposed.**
>
> A faithful model **would not merely split revenue — tile #59's real disconnected topology would make
> that hex a dead-end for through-routing entirely, a materially larger and riskier change to core route
> connectivity than the request described or scoped.**

### `terrain_base_value` — deliberately not hex-specific
A frontend pass gave five hexes real sourced figures and asked for the change **"on both layers."**
Applied **only on the frontend**, and the refusal is reasoned:

1. **This function is real, live payout math, not a cosmetic preview** — making it hex-specific **would
   permanently change every laid tile's revenue at those hexes for the rest of the game, across every
   colour tier**, where the request's own "displays a value plate" framing describes a canvas badge.
2. **More fundamentally: it is never even CALLED for a landmark hex before a tile is laid there** —
   `trace_best_route` skips any coordinate absent from `MAP_GRID`. **So the real live "starting" value of
   those five hexes in this contract was ALREADY $0 uniformly — ironically the exact behaviour that same
   request's own item 3 asked for on a different set of hexes.**

**The frontend's per-hex figures are a pre-tile PREVIEW only, never a live balance this contract pays out
— there was no existing "layer" here to update.**
