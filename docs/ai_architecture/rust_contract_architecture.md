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
| 13 | **NEW (6B): the two route validators disagree about what a train's range MEANS.** `pathfinding.rs:1248` caps **REVENUE CENTRES** (`route.revenue_centres >= max_revenue_centres`); `operations.rs:1315` caps **HEXES** (`axial_path.len() > max_distance`). Capping hexes is precisely the pre-G-9 bug `pathfinding.rs #4` records — *"a 2-train could not have run two towns joined by a single plain connector — three hexes — even though that is the most ordinary route in the game."* **The automatic tracer was fixed; the manual declarer was not.** A president hand-declaring that ordinary route is rejected with `RouteExceedsMaxDistance` while the auto-router runs it. `operations.rs`'s own doc comment asserts the opposite — that it matches `trace_best_route`'s check. | `operations.rs` / `pathfinding.rs` | `pathfinding.rs #4`; `operations.rs #26` step 4 |
| 14 | **NEW (6B): the manual route does not enforce the two-revenue-centre minimum.** `pathfinding.rs` requires `MIN_REVENUE_CENTRES`; `operations.rs` has no reference to it at all. A hand-declared "route" touching one city (or none) is accepted where the automatic tracer refuses it. | `operations.rs` | `pathfinding.rs #3`/`#4` |
| 15 | **NEW (6B): `auction::award_bo_president_share` FLOATS the B&O and capitalizes its treasury**, bypassing the 60% threshold every other corporation must cross. Real 1830 hands the B&O private's winner the **President's certificate**; the corporation still floats normally. This is divergence #2, now precisely located — and it is *documented as intentional* in `auction.rs #4`, not an accident. | `auction.rs` | `trading.rs #7`; `public_company.rs #2`; `hexmap.rs #23` |
| 16 | **NEW (6B): ~48 stale references to a DELETED handler.** Audit G-13 removed `execute_operating_round` and the `ExecuteOperatingRound` variant, but eleven source files still describe it as live — `operations.rs` (23), `msg.rs` (7), `contract.rs` (5), `gamelog.rs` (4), `state.rs` (4), and six others. Likewise **9 references to `PROTOCOL_TREASURY_VGP`**, the map Audit G-2 deleted, including `msg.rs`'s claim that the split-treasury divergence is still open. Most are removed by this extraction pass; the remainder are flagged. | repo-wide | `operations.rs` B6; `state.rs` B46 |
| 17 | **CORRECTION to #1 (the $350 trigger).** `market.rs`'s module doc states plainly that `GAME_END_PRICE_TRIGGER` is **"this project's own explicit, user-requested house rule, not a transcription of the software engine's behavior"** — the verbatim `MARKET` array does not tag that cell, and the real rulebook's primary end condition is the bank breaking. So #1 is **not a backend bug**: it is a deliberate house rule the FRONTEND then removed as un-1830. The two layers disagree about a rule each documents as correct. | `market.rs` | frontend `rules_and_sourcing.md` |
| 18 | **NEW (6B): a corporation's home station token does not anchor its routes.** `pathfinding.rs #1` starts every route at `PROTOCOL_NETWORK_HEXES[0]` — **the first tile the corporation ever laid** — not at its home hex or any station token, because `hexmap.rs #23` keeps the two registries "DELIBERATELY DECOUPLED". A corporation's real historical home city is therefore purely informational. | `pathfinding.rs` / `hexmap.rs` | `hexmap.rs #23`; `pathfinding.rs #1` |


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

---

# state.rs — the storage layer and its migration discipline

1,412 lines, 72% comment. Almost every field carries a `#[serde(default)]` argument, and they are worth
reading as one policy rather than one at a time.

## The `#[serde(default)]` policy — it is required, not stylistic

Every additive field on a persisted struct carries it, and the reason is always the same:

> **Every record already written predates the new field; without the attribute those records stop
> deserializing the moment the contract is upgraded, bricking every game in flight.**

The defaults are chosen so the absent value reads as an honest statement rather than a plausible lie:
`last_route_revenue` defaults to zero, which reads as *"has not run routes yet"*; `room_ante` reads as
zero and **the join path falls back to the old lookup for exactly that case**; `last_stock_actor` reads
`None`, *"we have no record of a last actor"*; `ActionRecord::BuyStock.quantity` reads `None`, which
`execute_buy_stock` resolves to **exactly the single certificate that log entry originally bought, so
historical logs replay to the identical state they always did**.

## Round and turn state

### RoundType — one strictly one-directional phase, then a cycle
`WaterfallAuction` is the room's **true genesis phase** (changed from an earlier "genesis starts in
StockRound"). `waterfall::conclude_waterfall` is **the one and only `WaterfallAuction → StockRound`
transition; nothing ever sets it back.** `StockRound`/`OperatingRound` are the repeating cycle.

**Declared in chronological order purely for readability — nothing derives `Ord` for this enum**,
in deliberate contrast to `TileColor` **just above, which does**: `TileColor`'s declaration order
(Yellow first) is what makes `Green > Yellow` and `Brown > Green` true, so the era can never regress.

### The five fields the turn queue is made of
- **`active_player_index`** — the base Turn Priority Queue primitive. Only this player may `PassTurn`,
  and `reapply_game_log` **recomputes it by replaying every `PassTurn` in the log from `0`.**
- **`active_corporation_index`** — checked by `LayTile`, `BuyHardwareFromPool` and `DeclareDividends`
  **in addition to** President authorization. **When `active_operating_order` is empty the check is
  skipped entirely — this opt-in behaviour is what keeps it a purely additive change.**
- **`macro_round_number`** — starts at 1; `reapply_game_log` **deliberately does NOT reset it**, unlike
  the four fields around it. **A macro-round boundary is not "replayable" state the way an in-progress
  turn queue is.**
- **`sub_round_index`** — the `.1` in "OR2.1"; `0` at genesis and after a replay reset.
- **`last_stock_actor` (Batch 4)** — index of whoever took **the last committing action this Stock
  Round**. It exists for exactly one purpose: **1830's Priority Deal passes to the player seated
  immediately to the LEFT of whoever acted last** — and that is **not derivable when the round ends**,
  because by then everyone has passed, the pointer has wrapped an unknown number of times, and
  `consecutive_passes` says how many passes happened **but not who broke the previous streak.** So it is
  recorded at the moment it is known.

  **PASSING DELIBERATELY DOES NOT UPDATE IT.** *"A pass is the absence of an action; if it counted, the
  rule would degenerate into 'the deal passes to the left of whoever passed last', which is every round
  the same seat regardless of what anyone did."*

### `bank_is_broken` — the Deferred Bank-Break Halt
Once `virtual_bank_vgp` is exhausted the game **does NOT hard-stop mid-Operating-Round** — every
corporation finishes out the **current scheduled block** of ORs, and only when that block concludes does
the game end. Set the moment a debit drives the bank to exactly zero; consulted by
`execute_end_operating_round_turn` at the precise moment it would otherwise return to a Stock Round.

**NOT reset by `reapply_game_log`**, on the same reasoning as `macro_round_number`: **once the bank has
genuinely run dry earlier in the log, replaying that log should reach the same broken-bank state again,
not silently forget it.**

### `last_action_timestamp` — the 48-hour valve's clock
Refreshed by **six** named handlers, and **deliberately NOT by every mutating message** (not
`BidOnPrivate`, not `BeginOperatingRound`, not `EmergencyBuyHardware`) — **matching the requested scope.**

## The market zones

### ZoneType — cumulative bands, and an explicit departure from the source
| Zone | Source letter | Engine type | Grants |
|---|---|---|---|
| `YellowZone` | `y` | `:no_cert_limit` | certificates here **don't count toward the hand limit** |
| `OrangeZone` | `o` | `:unlimited` | **also**: a player may exceed the 60% ownership cap |
| `BrownZone` | `b` | `:multiple_buy` | **also**: multiple certificates from the Bank pool in one turn |

**The cumulative/nested reading is this implementation's explicit choice** — the standard rulebook
understanding of the three colour bands — **and is NOT a literal transcription of the engine's own
per-cell letter, since the verbatim `MARKET` array tags each cell with only a single letter (a `b` cell
is never *also* tagged `o`).**

`waives_certificate_limit` is **the single predicate `check_cert_limit` uses BOTH to decide whether the
incoming purchase counts AND to filter the holder's already-owned certificates out of the running
total.** Before Batch 1 the exemption **only skipped the check for the incoming certificate, which
over-counted every previously-bought zone-exempt certificate the player was still holding.**

## The certificate count — a president's card is ONE card

`count_player_certificates` is shared by `execute_buy_stock` and `execute_bid_on_private` **since both
need the exact same count.** It takes the id catalogs **as parameters rather than importing them, so this
data-layer module stays a leaf with no dependency on either business-logic module.**

**THE PRESIDENT'S CERTIFICATE COUNTS AS EXACTLY ONE PHYSICAL CARD, NOT TWO.** A naive
`held_pct / percent_per_share` (`20 / 10 = 2`) **double-counts the President's card as if it were two
ordinary certificates** — wrong per the real rule, **re-verified against the official Lookout Games
rulebook, 18xx.net, and `tobymao/18xx`'s own `num_certs`/`cert_size` implementation, where a president's
`Share` never gets `cert_size: 2`.**

`count_player_certificates_with_exemptions` is **a live, position-derived exemption rather than a sticky
flag stamped at purchase time. A company whose price later climbs back out of the Yellow band has its
certificates start counting again — the colour band is printed on the CHART, not on the certificate.**

> **A consequence worth stating plainly: a player can be legally over the hand limit without having done
> anything wrong, simply because a company they hold moved up out of an exempt band.** `check_cert_limit`
> **only ever blocks NEW purchases; it never retroactively invalidates a holding, and there is no
> forced-sale path in this contract.**

## `PLAYER_SR_SALES` — the Stock Round Buyback Lockout

*A player may not buy back into a corporation they have already sold in the same Stock Round.* **Without
it, a player could sell 30% to crater a rival's price, then immediately re-buy the same stock cheaper in
the same round — a pure-profit wash trade the physical game forbids.**

Stored as a **sorted, deduplicated `Vec<u32>`, not a `HashSet<String>`**, and both halves are deliberate:

- **`Vec`, not `HashSet`** — **`HashSet`'s JSON serialization has no guaranteed element order, which is a
  determinism hazard in a CosmWasm contract: two validators could serialize the same logical set into two
  different byte strings and disagree on the state root.** Lists are at most 8 long, **so a linear scan is
  cheaper than any hashing would be anyway.**
- **`u32` protocol id, not a `String` ticker** — every other share registry is keyed by `protocol_id`, and
  **storing tickers here would introduce a second, drift-prone identity for a corporation.**

## `PROTOCOL_TREASURY_VGP` — REMOVED (Audit G-2, the Split Treasury Divergence)

**A corporation's treasury used to be written to TWO independent places that no code ever reconciled.**
`execute_declare_dividends` credited withheld revenue *and* the IPO pool's dividend share into that map,
while **every debit site** (train purchases, terrain fees, token fees) **and every other credit site**
(flotation capitalization, `operations.rs`'s own withhold branches) read and wrote
`PublicCompany::treasury`.

> **NOTHING ANYWHERE EVER DEBITED THAT MAP, so every VGP a corporation retained through
> `DeclareDividends` was permanently unspendable: a company could withhold for five Operating Rounds to
> save for a 5-train and, on-chain, have saved nothing it could actually spend. That broke the game's
> entire capital-accumulation loop.**

`PublicCompany::treasury` is now the single source of truth. *(⚠️ Nine stale references to the deleted
map survive in doc comments across six files — divergence #16.)*

## `HEX_STATION_TOKENS` — per-city accounting, and why it is a NEW map

`PROTOCOL_STATION_HEXES` records which **HEXES** a company has tokened, which is all the token-limit and
duplicate checks ever needed. **It cannot answer the question the blockade rule actually asks, though: a
hex is not a city.** Pooling slots **reports an OPEN slot on a hex whose relevant city is genuinely full,
and there is no way to recover the distinction after the fact from a `Vec<(i32, i32)>`.**

**Deliberately a SEPARATE map rather than a widened element type: that map's entries are stored as JSON
`[q, r]` pairs, and any struct or 3-tuple replacement fails to deserialize them, which would brick every
game in flight.** A new map **starts empty and absent**, so a pre-G-12 game reads it as "no per-city
detail recorded" and reconstruction fills in city 0.

**INVARIANT, enforced by the only two writers: for any hex, the number of entries naming a given
`city_index` never exceeds that city's slot count.**

## `Tile::paths` and `OperatingSubPhase`

`Tile` carries the Audit G-9 `paths` field alongside `connections` — see the hexmap section for the
encoding. **Retained ALONGSIDE the mask rather than replacing it**, and `#[serde(default)]` so a
pre-G-9 tile still deserializes, with `effective_tile_paths` backfilling from the catalog.

`OperatingSubPhase` **deliberately carries no ordering of its own — no `PartialOrd`, no discriminant
arithmetic — so there is exactly one place a phase sequence can be read from and no second, drifting
copy.** That one place is `or_phase::OR_PHASE_ORDER`. `PROTOCOL_OR_SUB_PHASE`'s **ABSENCE means "at the
start of its turn"**, resolved through `initial_sub_phase`, **which is why `reset_for_turn` REMOVES the
entry rather than writing one: writing a concrete phase would silently skip `BuyPrivate` in a later era.**

`TrainOffer` **records the MODEL, not a specific unit. Trains of a model are interchangeable — same cost,
same range, same rust fate — so pinning an index would only create a way for the offer to go stale when
an unrelated train left the seller's roster.**

---

# trading.rs — the Stock Round

2,618 lines. The module doc carried **22 numbered notes**, several of which record a rule being fixed in
the wrong direction first.

## The three corrections worth keeping

### #6 / Audit G-4 — the sale price is fixed when the sale BEGINS
**All certificates in a single sale transact at the price the marker sat on when the sale began**; the
marker only walks down afterward, one row per certificate.

> **A previous version of this note claimed the OPPOSITE — that later certificates settle at the new,
> lower price, "matching the physical 18xx board" — and the code did exactly that. Both were wrong.**
> Selling 30% settled certificate #2 one row lower than #1 and #3 two rows lower: **the seller was paid a
> progressively worse price the deeper into their own sale they got.** 1830 fixes the price at the start
> of the transaction, **and every reference implementation does the same.**

### #11 / Audit G-7 — an engine that rejects a legal move is as wrong as one that permits an illegal one
The old rule rejected **ANY** sale by a sitting President unless some *other* player already held 20%.

> **That was stricter than real 1830 and blocked legal play: a President holding 60% could not sell a
> single 10% certificate — even though they would still hold 50%, still be the largest holder, and still
> be President afterward — purely because nobody else had reached 20%.** It also meant **the actual dump
> was never executed, only refused.**

The real constraint is **only this: a floated corporation must always have SOMEONE holding its
President's certificate.** Three cases fall out of that one rule, and the classic dump is the third.

**On "transferring the 20% certificate":** ownership is stored as a **raw percentage**, not discrete
cards, **so there is no 20% card to physically move and no pair of 10% cards to hand back.** The
semantics are preserved entirely through `PROTOCOL_PRESIDENT` plus `count_player_certificates` — **when
the seat moves, the incoming President's first 20% automatically starts counting as one certificate and
the outgoing President's remaining 20% automatically reverts to counting as two, which is precisely the
"hand back 2×10%" rule, achieved by re-derivation rather than by shuffling stored cards. Writing an
explicit swap here would either be a no-op or corrupt the percentages.**

### #18 / Audit G-6 — two rules with no enforcement at all
**There were zero references to `macro_round_number` or `current_round_type` anywhere in this file.**

- **Stock Round 1 is buy-or-pass only.** *"Players could previously pump-and-dump on turn one."*
- **`BuyStock`/`SellStock` are Stock Round actions.** **Most importantly during an Operating Round, where
  trading used to be silently legal.** This closed the LIMITATION `operations.rs #12` flagged as future
  work — *"that future work is this note."*

Both run **AFTER** each handler's `waterfall_auction_active` check, so a player acting during the auction
still gets the **more specific** error naming the five dedicated messages.

## The two limits are different rules

| | 60% ownership cap | Global Certificate Limit |
|---|---|---|
| Asks | how much of **one** corporation may you hold | how many cards **across the whole game** |
| Exempted by | **Orange and Brown only** | **Yellow, Orange and Brown** |
| Backstop | `HoldingExceedsTotalIssue` — **"unlimited" in the Orange/Brown bands means "no 60% cap", never "more of a corporation than exists"** | — |

**Yellow alone exempts a certificate from the hand limit even though it does not exempt a holding from
the 60% cap — the two exemption rules are related but not identical in scope.** `execute_bid_on_private`
**has no market-cell concept for a private company, so its own check stays unconditional.**

## Brown Zone — two independent expressions of one privilege
**#15** (turn pacing): a Bank purchase on a Brown cell **does not advance the turn pointer**.
**#19** (atomic multi-buy): `quantity > 1` is legal **only** from the Bank **and only** in Brown.
**Both are real, and both remain legal** — a player may take the whole block in one message, or one
certificate at a time across several messages without surrendering their turn.

**A legal multi-buy settles atomically: one debit, one share write, one pool write — there is no
intermediate state in which some certificates have transferred and others have not, and the price does
not drift between certificates within the action.**

## #13 — Checks-Effects-Interactions
Price, pool percentage and zone type **used to be resolved inside the `source` match, which WROTE
`IPO_POOL_SHARES`/`BANK_POOL_SHARES`/`PROTOCOL_PAR_VALUE` mid-computation.** They now return a
**`PoolEffect` describing what WOULD be written**, applied only after every `Err` path has returned.

Two behaviour-preserving consequences: the first-IPO case **reads the target cell straight out of the
shared template rather than calling `set_protocol_position` and reading it back — the same cell, just
without the write**; and the Bank case **calls `current_cell` directly**, which **surfaces the
(unreachable in practice) missing-position case as a clean error instead of silently seeding a `(0, 0)`
position mid-check.**

## #7 / #8 — flotation and par
The first purchase crossing **60% real-player-owned** floats the corporation and capitalizes its treasury
at **10× PAR VALUE — always par specifically, never a Bank/Market price, even on the rare purchase that
crosses the float line via a Bank buy.** This closed a gap where **only the B&O could ever float, so
ordinary corporations like the PRR had no path to `is_floated: true` at all.**

**The two pools and the two prices are intentionally decoupled**, matching the real distinction between
"buying at the IPO price" and "buying off the open market": IPO always pays the **fixed** par;
Bank always pays the **live** chart price.

## #22 — `conclude_stock_round`
Fired when every player has passed consecutively — **a condition this contract tracked in
`consecutive_passes` but never acted on.** It applies the sold-out rise and clears the lockout, and
**deliberately does NOT flip `current_round_type`**: that belongs to `execute_begin_operating_round`,
**and splitting it would give this contract two competing definitions of when an Operating Round starts.**

---

# pathfinding.rs — the route tracer

## Audit G-9 — three gaps in one traversal

1. **Edge-to-edge routing.** The old walk read the flat mask: *"does edge `e` carry track?"* — **it never
   asked which edge that track actually joins.** On real tile #1 a train could **enter on edge 0 and
   leave on edge 3, route-jumping between two segments that never physically touch.**
2. **Multi-train route isolation.** The engine **priced exactly ONE route — a company's best train — and
   had no concept of the others.** Real 1830 runs every owned train, and **no two may reuse the same
   piece of track.** Now a shared `HashSet<(q, r, (u8, u8))>` claimed-segment ledger.
3. **Token blockades.** Blockades were modelled off each rival's **FIRST LAID TILE**, which is **a track
   record, not a token record**, and blocked that hex outright. Now `PROTOCOL_STATION_HEXES`, with the
   real rule: **blocked only if every slot in the city is taken.**

## #4 — the distance budget is REVENUE CENTRES ⚠️
A train's `max_route_distance` caps **stops, not hexes.** *"Pre-G-9 it capped visited hexes, under which a
2-train could not have run two towns joined by a single plain connector — three hexes — even though that
is the most ordinary route in the game."* Connector hexes are bounded separately by `MAX_ROUTE_HEXES`,
**purely as a gas guard, not a game rule.**

> ⚠️ **DIVERGENCE #13: `operations.rs:1315` still caps HEXES.** The manual declarer was never brought
> across. See the divergence table.

## #5 — the search, and determinism as a consensus requirement
Depth-first over `(hex, arrival edge)`, exhaustive within the caps. **Deterministic by construction,
which a consensus contract requires: candidate segments are visited in the fixed order the catalog lists
them, a strictly-greater comparison keeps the first best route on ties, and no iteration order over a
`HashSet` ever influences a decision** — the ledger is consulted only by `contains`.

**Batch 2 changed what "already visited" means: the state is now `(hex, city_node)`, not `hex`.** G-9 had
left a simplification in place — *"a hex is visited at most once per route"* — and **on a two-city tile
that simplification was not merely conservative, it silently deleted the better half of New York's
revenue.** A route may now serve both stations; **it still may not serve the same station twice, and it
still cannot cross between the two inside the hex, because the only move this search makes is a step to a
NEIGHBOUR over track it has not already claimed.**

**A hex with no city is still crossed at most once. That remains an under-report and is deliberately left
alone: it has nothing to do with station granularity and widening it would only enlarge the search
space.**

## #6 — greedy, and honest about it
Trains run **biggest-first**. **A jointly-optimal assignment is an exponential search this contract cannot
afford at block gas limits.** Greedy-by-capacity **is the standard 18xx heuristic, is deterministic, and
can only under-report, never over-report, revenue.**

## Audit G-13 — the ghost route
`tile_segment_cities` makes the blockade check **city-granular instead of hex-granular**.

> **Previously the `StopOnly` test was asked once for the whole hex, BEFORE the loop. On a multi-city tile
> that let a route enter through a fully-tokened city's own track and leave again as long as SOME OTHER
> city on the same tile had a free slot — ghost routing straight through the blockade. On #62 and the OO
> tiles the two cities sit on physically separate, non-intersecting track, so this was never a close
> call: the route was riding rails it had no access to.**

The check now lives **inside** the loop, per segment. **`expand` is still reached for the hex itself, so
the route may still END there and score it.**

**The home hex needs the same test, and is NOT covered by "you always hold a token at home": a company's
home token sits in ONE city, and a home hex with TWO cities (ERIE's E11 is an OO hex) can have its other
city filled by rivals.**

`city_passability_for_hex` is **the primitive; every other passability question in this module is a
roll-up of it.** `hex_passability` is **a strictly weaker question — use it only where the specific track
is genuinely unknown.** Both are `pub(crate)` **so the ghost-routing regression can assert the CONTRAST
directly: on a tile whose city 0 is blockaded and city 1 open, the hex roll-up answers `Open` — which is
exactly the ghost route — while `transit_passability` answers `StopOnly` for city 0's own track. Having
both callable side by side is what makes that test evidence rather than assertion.**

## `arrival_city_node` — the asymmetry is the whole point
`None` is the single-node answer, returned in **three deliberately conservative cases**: the hex has no
cities; the correspondence is not knowable (a synthesized overlay); or **the arriving edge is claimed by
two DIFFERENT cities — no real 1830 tile does this, so it means the catalog and the slot table disagree.**

> **Guessing `None` can only ever cost a route revenue it was owed, while guessing a specific node wrongly
> would hand a train a second visit to a station it already used — the exact double-count this
> granularity exists to prevent.**

## The five functions `cargo check` calls dead, and the assertion that they are not

> **`cargo check` compiles only the library target, and `mod tests` is behind `#[cfg(test)]`, so the
> compiler cannot see the callers.** `cargo check --all-targets` or `cargo test` reports no warning.

`opponent_station_hexes`, `passability_at`, `tokened_hexes`, `passability_for_hex` and `hex_passability`
**lost their PRODUCTION callers to Audit G-13** — the hex-level question is too coarse to route on — but
keep four blockade regression tests, **which are the coverage that proves rival tokens blockade at all.
Rewriting those against the per-city API would trade real coverage for a silenced warning.**

**`#[allow(dead_code)]` is therefore an ASSERTION, not a suppression: these have callers, and the lint
cannot see them.** *(This is exactly why the extraction verified with `cargo check --all-targets` rather
than plain `cargo check`.)*

## #2 — why the preprinted overlays stay permissive
G-9 gave **real laid tiles** exact edge-pairs and **did not narrow the overlays**, because **this engine's
absolute edge numbering is a MIRROR of the source manifest's** — and for a preprinted hex, **unlike a
freely-rotatable tray tile, that reflection is NOT immaterial: it would point real printed track at the
wrong neighbours.** **Narrowing them on a mirrored numbering would sever whole board regions — the exact
failure `hexmap.rs #20` had to repair once already.** Tightening is **a strict tightening: nothing
routable today would gain a path.**

---

# operations.rs, hardware.rs, contract.rs, escrow.rs and the rest

## operations.rs — the sequential turn queue

**Ordering (#7/#8):** floated companies, **highest price first** — the real rule. Ties break on
`arrival_sequence` (**most recently moved**), which is **the practical stand-in for "whichever token is
stacked on top of the shared price cell acts first": this contract's price formula can coincidentally give
two DIFFERENT cells the same price**, so physical stacking is not expressible.

**#10 — the gap that meant only the first corporation could ever act.** The three gated messages already
*enforced* the queue, **but nothing advanced `active_corporation_index`.** `EndOperatingRoundTurn`
deliberately **does not validate that the ending corporation took an action** — **passing with zero
actions is legal in 1830, so requiring one would be an invented restriction.**

**#12 — Macro Round Loop Advancement.** The order is **RECOMPUTED rather than replayed** between paced
sub-rounds, **because stock prices move mid-sub-round and the next sub-round's order should reflect
prices as of when it starts.**

**#14 — the double-pay bug, and its fix by deletion.** Two Operating Round mechanics coexisted and
**BOTH paid every private's `revenue_per_or`, with nothing reconciling them — so a room that drove both
within one Operating Round paid every private TWICE.** Flagged in `#14`, then **fixed by DELETION rather
than reconciliation (Audit G-13): the sequential queue is the sole source of truth.** *(⚠️ ~48 stale
references to the deleted handler remain — divergence #16.)*

**`reset_for_turn` is cleared in the ONE function both turn-end paths funnel through**, so no path can
leave a stale cursor: **a corporation that ended its turn on `Hardware` would otherwise begin its next one
there and be unable to lay track for the rest of the game.**

**Mandatory Train Purchase (G-8)** is **gated on a NON-EMPTY pool: once every train in the game has been
bought there is nothing left to compel, and blocking the turn then would deadlock the room permanently.**

**Manual route, rule 3 — blockades apply to the INTERIOR only.** Both ends are exempt: the last hex
because **that is where the train stops**, and the first **for symmetry — a route is an undirected run
between two ends, so blocking on index 0 would reject a legal route purely for being written backwards,
and `["A","B","C"]` and `["C","B","A"]` must accept or reject identically.**

## hardware.rs

**#2 — no model selection.** The pool is **strictly sequential**, so **a tier's stock is always fully
exhausted before the next tier's first unit can be bought** — which is *why* rusting **only ever needs to
sweep company inventories, not the pool itself.**

**#4 — "first unit ever" is tracked in `TRAINS_PURCHASED_COUNT`, not inferred from queue position, so the
exactly-once firing does not silently break if the buying rules change.** #10 reads the same map rather
than live inventories, **because a rusted-away 2-train should NOT make the room forget a 2-train was ever
bought for pacing purposes.**

**#7 — bankruptcy halts via a SUCCESSFUL transaction, not an error.** *"CosmWasm reverts every state write
made during a call that returns `Err(..)` — there's no partial commit — so an error return could never
durably flip `is_active` to false."* The halt now also runs the full liquidation, **so a bankruptcy no
longer leaves the lobby's real JUNO stranded in contract state.**

**#10a — the train-limit check uses the phase as it stands, and deliberately does not look ahead.** A
corporation already at its cap is **blocked outright, even where the purchase would itself trigger a
rusting sweep that would have brought it back under.**

**Audit G-17 — the pool tops itself up.** In 1830 the Diesel is **unlimited**, and *"that is not a detail.
It is the game's terminal state — Diesels never rust, so the endgame assumes any corporation that can
afford one can always buy one."* A `Vec` cannot express unlimited; the old stand-in of 20 was **probably**
enough — **"but 'probably' is doing load-bearing work in a rule that says 'always', and the failure mode
is the worst kind: a late-game `PoolEmpty` that looks like a contract bug and strands every corporation at
once, in a state the rules say cannot occur."** `PoolEmpty` is **KEPT though now unreachable: a removed
error variant is a worse outcome than an unused one.**

**Emergency Asset Liquidation (G-8)** — the tier between "the President's wallet is short" and "the game
is over". The cascade **previously jumped straight from personal cash to a hard bankruptcy halt, declaring
games over on presidents who were, in 1830 terms, entirely solvent.** Rules honoured: **deterministic
company order, never storage-iteration order**; **per-certificate pricing** (a SEQUENCE of one-certificate
sales, **which is why it does not contradict G-4**); the 50% pool cap; **the President's certificate is
never force-sold** — *"real 1830 does not let a president be involuntarily stripped of the presidency to
fund a train"*, which also **keeps the sweep from ever leaving a corporation with nobody able to hold its
President's certificate**; and **bank solvency — the sweep stops rather than driving the bank negative.**

**G-17's turn interaction: an outstanding train offer must be resolved first.** The two mechanisms answer
the **same** problem, and **REFUSED, NOT AUTO-RESCINDED — silently withdrawing an offer the player made,
as a side effect of a different message, spends their negotiating position without asking, and the rival
might have been one block away from accepting.**

## contract.rs and escrow.rs

**Audit G-1 — the 10× payout bug.** The endgame appraiser computed `price * percentage / 100`, i.e. it
**treated a cell's price as a whole-company valuation and undervalued every holding by exactly 10×.**

> **Because cash was (correctly) counted at face while stock was counted at a tenth of face, the error did
> NOT cancel out of the proportional split: it systematically transferred real JUNO from stock-heavy
> players to cash-heavy ones.** And `query_player_net_worth` **already used the correct formula, so the
> contract's own payout math and its own net-worth query disagreed by 10× on the same holding.**

One shared appraiser now. Privates are **newly counted** — both appraisers **used to omit them entirely,
booking $0 for a player holding e.g. the $220 B&O at game end.** Company treasuries are **deliberately
excluded: that VGP belongs to the protocol, not to any individual player.**

**Payout and annulment are different machines.** `EndGameAndDistribute` is a **RESULT**; `AnnulGame` is a
**NON-RESULT** — **nobody won, so nothing is scored.** *"Running the proportional split here would hand a
real-JUNO prize to whoever happened to be ahead when the room stalled, which is indistinguishable from a
rage-quit exploit."* `ClaimTimeoutRefund` was **a third, narrower exit** and is **GONE, folded in — one
refund path, so the two can never disagree about what a player is owed.**

**The permissionless escape hatch.** The creator may annul at any time — **there is nobody to protect them
from: every player gets exactly their own money back, so the creator gains nothing by annulling early.**
Any registered player may annul after 48 hours — **without it, a creator who walks away, or loses their
keys, locks every other player's real JUNO in the contract permanently.** The comparison is **`>=`, not
`>`: a player whose funds are already stuck should not be made to wait an extra block for a
strictly-greater-than.**

**Solvency (G-11).** `PLAYER_JUNO_ANTE` records the **GROSS** deposit, but the subsidy leaves immediately,
**so refunding the gross would try to pay out more than the room holds.** Every refund is
`ante - subsidy_cut(ante)`, **which sums to exactly `total_juno_pool` and can never overdraw the
contract.** The Uniform Ante Rule is compared **on the GROSS amount, before the subsidy is taken, so
"every player antes the same" keeps meaning what a player actually sends, not what survives the fee.**

**`MINIMUM_ANTE` is a SAFETY NET, not a pricing mechanism.** **A CosmWasm contract cannot query live gas
prices, so it cannot compute a sensible stake itself** — the frontend does (roughly *gas price × 400
transactions*). Deliberately a **compile-time constant rather than an `InstantiateMsg` parameter: a
deployer-supplied floor could be set to zero, and the value protects players rather than the deployer.**

**`subsidy_cut` assumes `subsidy_fee_percentage` is never updated.** *"If a config-update handler is ever
added, this assumption breaks and the refund path must store the net figure instead of recomputing it."*

## gamelog.rs — event sourcing, and the one thing it cannot replay

**What is in the log:** actions that **(a) move only VGP, never real JUNO, and (b) mutate state through a
single already-pure handler with no side channel this module cannot also reset.**

**What is excluded, and why:** real-JUNO messages **cannot be replayed — there is no way to re-attach
historical `info.funds`, and re-issuing a `BankMsg` during a replay would double-spend real tokens.**
`EmergencyBuyHardware` can **durably halt the session, and undoing past a bankruptcy raises questions
deliberately left for a follow-up rather than answered by assumption.** The queue-populating and cascading
messages **depend on state that a later replay cannot safely re-derive.**

**#5 — replay reuses the LIVE handlers**, called exactly as `contract::execute` does, just with a
synthetic zero-funds `MessageInfo`. **This guarantees replayed behaviour can never drift from what
actually happened, since there is only one implementation of each rule, not two to keep in sync.** Turn
pointers therefore **reconstruct for free: replay re-validates the same turn order the actions already
satisfied live, in the same order, so it can never diverge.**

**The waterfall reset bug.** An earlier version **reset unconditionally back to `WaterfallAuction`
regardless of the room's actual state, which meant ANY `UndoLastAction` on a log containing so much as one
Stock Round action hard-failed with `WaterfallAuctionInProgress` the instant replay reached it** — caught
by a **pre-existing test this waterfall feature had silently regressed.** The flag is now captured
**BEFORE** the reset overwrites it. **One narrower gap remains open and is stated: a legacy `BidOnPrivate`
entry in a post-conclusion replay runs against a private already in its owned state, so it is not
guaranteed to reproduce bit-for-bit. No test exercises that combination today.**

## waterfall.rs — the pre-game auction

**#2 — the cheapest private can only be BOUGHT, never bid on:** otherwise **turn one could immediately
produce a 2+-bid tie on the very first private with zero real information exchanged.**

**#4 — a full round of passes RUNS the waterfall; it does not end it.** The old rule **refunded every bid
and concluded the phase outright** — *"that terminated the auction in exactly the situation where the real
game is only getting started, and it meant a table that collectively did not want the cheapest private
simply skipped the rest of the auction rather than discovering a price at which somebody did."*

Now the price **drops $5, every owned private pays its revenue, and at $0 the company is forced on
whoever's turn it is.** **The phase still always terminates, and now for a better reason: the price is
monotonically non-increasing, $0 is reachable in a finite number of rounds, and a $0 company is forced on
a player rather than offered.**

**Pass is ALWAYS legal (Batch 4).** It used to require that some private already carried a bid, **which
made the opening position of the game a forced move — you could buy or bid, but not decline.**

**The mini-auction skips the leader's own turns** — *"they have nothing to decide while already
winning"* — and is ordered by **seating order, not raw storage/`Addr` order.**

**`refund_all_standing_bids` is necessary in exactly one place**: a full round of passes can end the
auction **while a private OTHER than the current lowest still holds never-cascaded-to bids** — **without
the sweep, that escrowed cash would simply vanish from its bidder's balance forever, permanently unowned
by anyone.**

## market.rs — Cliffs and Ledges

**The real chart is genuinely ragged** — 19 columns at its widest, **as few as 4 populated cells in its
lowest row.** A blank coordinate is treated **exactly like the rectangle's own edge.**

**Batch 1 item 5 changed the boundary behaviour, and it was not cosmetic.** All four edges used to
saturate identically. Real 1830 **deflects a blocked HORIZONTAL movement into a VERTICAL one**:

| Boundary | Behaviour |
|---|---|
| **Right Cliff** | Distribute Yield blocked right → **UP one row.** The chart's only way to climb past a short row into the wider rows above |
| **Left Cliff** | Slash/Retain blocked left → **DOWN one row.** The staircase a repeatedly-withholding company walks down |
| **Bottom Ledge** | **refused, no deflection.** The board's bottom edge is a ledge, not a cliff |
| **Top Ceiling** | **refused.** Nothing goes above $350 |

> **The consequence of the old behaviour: a company parked on the last printed cell of a short row could
> pay dividends forever and its price would never move, so it could never climb into the wider rows above
> and could never reach the $350 trigger at all.**

**Deflection is deliberately NOT recursive** — **real 1830 never chains deflections, and a recursive rule
on a ragged chart could walk a marker an unbounded distance from one dividend.**

**The sold-out rise is called EXACTLY ONCE per Stock Round**, and **must never be invoked speculatively:
two calls in one round would double-raise every sold-out company.** It coexists with the per-purchase
bonus — **a different trigger with different timing, and both exist in the real game.**

**Coordinate convention, stated because the request inverted it:** the requirement said *"move the token
up 1 vertical cell (`y - 1`)"*, the convention of a chart **indexed from its top row downward.** This
module has always used the opposite — **`y = MARKET_MAX_Y` is the TOP row** — so "up one cell" is `y + 1`.
**Both describe the identical physical movement; the function goes through `move_up` so there is exactly
one definition of which way is up.**

## query.rs, or_phase.rs, train_trade.rs, auction.rs

**query.rs #4 — a contract cannot print to a terminal.** *"CosmWasm's Wasm execution sandbox has no
stdout, no filesystem, and no host import for `println!`-style I/O — a smart contract can only ever
RETURN data to whoever queried it."* So the map renderer **builds and returns a `String`**, and the
printing happens off-chain.

**query.rs #5 — the ASCII sketch is an approximation**, plotting axial coordinates onto a rectangular
character grid — **good enough to eyeball where track has been laid, not a substitute for a real hex
renderer.**

**or_phase.rs — the order was a CLIENT-SIDE CONVENTION and nothing more.** `App.tsx` walked its own state
machine and drew the matching buttons **while every one of the six messages was gated only on "is it your
corporation's turn". The UI told an orderly story the chain did not enforce.**

> **That matters beyond tidiness because two of these phases are ORDER DEPENDENT in the rules themselves:
> dividends are declared against revenue that running trains produced, and a token may only be placed into
> a city the corporation's network reaches, which the tile it just laid may be what connects. Allowing
> them out of order does not merely look wrong, it lets a player declare a payout for revenue that was
> never computed.**

**`LayTile` advances the cursor, which is what makes 1830's real ONE-TILE-LAY-PER-TURN rule fall out of
the sequencing — there was no such limit before this, and a corporation could lay unlimited tiles in a
turn.** `BuyHardwareFromPool` deliberately **does not** advance. **`BuyPrivate` leads the turn but starts
the cursor at `Track` while the era is Yellow: the phase is not skipped; for that part of the game it does
not yet exist.**

**train_trade.rs — a transfer is NOT a purchase.** It deliberately does not call
`record_purchase_and_apply_rusting`: **that helper is about a train ENTERING PLAY from the Bank, and
counting a resale again would advance the phase and rust an entire tier out of existence on a move that
introduced no new equipment. The train changes hands; the game's phase does not move.**

**Nothing is escrowed** — **reserving the buyer's VGP at offer time would let a player freeze their own
treasury against a rival's acceptance, and would need unwinding on every rescind, reject and expiry
path.** Everything is **re-validated at ACCEPT: an offer is a proposition, not a reservation.**

**The buyer is never trapped, and that is what makes the turn block safe on-chain rather than a
deadlock** — `RescindTrainOffer` is unilateral. **A timeout would be unwelcome anyway, since
block-time-driven auto-rejection would make the game log non-deterministic to replay, which
`reapply_game_log` depends on.**

**auction.rs #4 — B&O's power.** ⚠️ Winning the B&O private **floats the public B&O automatically and for
free** and capitalizes its treasury at the lowest standard par × 10, **since B&O's president does not get
to choose a par value the way every other corporation's first IPO buyer does.** See **divergence #15**:
real 1830 grants the certificate, not the flotation.
