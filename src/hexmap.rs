//! Hexagonal Grid Map Engine: lets floated public corporations lay track
//! tiles onto a single shared hex map, per `rules.md` section 3, Step 1
//! ("Network Infrastructure & Tile Placement" -- "The Validator pays Gas
//! from the Protocol Treasury to place ... a hex tile on the shared map
//! network. Connection edges (0-5) dictate valid physical path routing.").
//!
//! This module now sticks to classic, pure 1830 naming and rules wherever
//! this engine's own simplified hex/bitmask board can faithfully express
//! them: `TileColor` (Yellow/Green/Brown) tile-era color-locking gated by
//! the real 1830 3-train/5-train phase triggers, a company's "Token Station
//! (Node)" as the anchor every new tile must trace an unbroken path back
//! to, real 1830 topology-retention upgrade rules, and New York/Boston/
//! Baltimore as reserved major-destination-city landmarks. See design notes
//! #8-#11 below for each, and #2 for exactly which parts of the *board
//! itself* (the hex coordinate system, the tile-artwork catalog, per-tile
//! terrain costs) remain this contract's own invented approximation rather
//! than a literal transcription of the printed 1830 map.
//!
//! Design notes / assumptions, since neither `rules.md` nor the existing
//! message/state definitions pin down a hex coordinate system, a tile
//! catalog, or terrain costs:
//!
//! 1. **Coordinate system.** `(q, r)` are axial hex coordinates. Edge
//!    indices 0-5 run around a tile in the fixed order given by
//!    `HEX_NEIGHBOR_OFFSETS`: edge `i` on the tile at `(q, r)` touches edge
//!    `(i + 3) % 6` (the opposite edge) on the neighboring tile at
//!    `(q, r) + HEX_NEIGHBOR_OFFSETS[i]`. This is the standard axial
//!    neighbor-direction convention (as used by, e.g., redblobgames' hex
//!    grid reference); nothing here is 1830-specific.
//! 2. **Tile catalog: real 1830 color governance over an invented board.**
//!    There's no predefined game board with fixed per-hex terrain, so --
//!    unlike the physical 1830 map, where mountains, rivers, and city
//!    values are properties of specific printed board hexes -- terrain cost
//!    here is modeled as a property of the tile artwork itself
//!    (`TILE_CATALOG`, a small fixed roster analogous to
//!    `auction::CORE_PRIVATE_COMPANIES`). `tile_id` numbers below are this
//!    engine's own sequential catalog IDs, *not* claims about which
//!    specific numbered tile a real 1830 tile tray uses for that shape --
//!    what *is* pure, classic 1830 here is each tile's `TileColor` tier and
//!    the era-unlock rule gating it (design note #8), the Token Station
//!    (Node) connectivity requirement (#9), the topology-retention upgrade
//!    rule (#10), and the three reserved landmark cities (#11).
//! 3. **Connection bitmask.** A tile's `connections` bitmask records which
//!    of its six edges carry a track stub, not how those edges pair up
//!    internally into a routed path through the tile. That level of detail
//!    belongs to the revenue path-tracing engine (`rules.md` Step 3,
//!    `pathfinding.rs`), which validates a full route rather than a single
//!    placement.
//! 4. **Orientation is a player-chosen strategic decision, validated, not
//!    auto-picked.** `ExecuteMsg::LayTile` (see `msg.rs`) takes an explicit
//!    `orientation: u32` field. STRUCTURAL FIX (supersedes an earlier pass
//!    of this feature, which had `execute_lay_tile` silently try `tile_id`'s
//!    six rotations in order and commit whichever one happened to be legal
//!    first): real 1830 lets a player choose exactly which direction a new
//!    tile's track extends -- which hex it reaches toward next is a
//!    meaningful strategic decision, not an implementation detail the
//!    contract should decide on the player's behalf. `execute_lay_tile` now
//!    rejects any `orientation` outside `0..=5` outright
//!    (`InvalidOrientation`), then evaluates *exactly* the submitted
//!    rotation -- and no other -- against the placement's legality rule
//!    (design notes #9/#10), erroring with
//!    `NoLegalConnection`/`TopologyNotPreserved` if that specific angle
//!    doesn't satisfy it (even if some *other* rotation would have).
//!    `legal_tile_placements` (backing `QueryMsg::GetLegalTilePlacements`)
//!    is the intended way for a caller to discover which `(tile_id,
//!    orientation)` pairs are currently legal before submitting one -- see
//!    that function's own doc comment. A protocol's very first tile ever
//!    still has no existing network to connect to, so any submitted
//!    orientation 0-5 is unconditionally accepted for it, standing in for
//!    that protocol's home hex/Token Station (there's no separate "assign
//!    home location" message yet, and a home hex's own facing has no
//!    connectivity to validate against).
//! 5. **Where the terrain cost goes.** Paid out of the protocol's own
//!    `PublicCompany::treasury` (per rules.md's "pays Gas from the
//!    Protocol Treasury") and credited into `GameSession::virtual_bank_vgp`
//!    -- consistent with how every other VGP sink/source in this contract
//!    keeps funds circulating in the bank rather than deleting them from
//!    state outright. See design note #12 for exactly when this fee is
//!    charged (only the initial Yellow placement onto empty land -- color
//!    upgrades are free, the real 1830 rule).
//! 6. **Base revenue value: a static terrain lookup, not per-tile numbers.**
//!    `TILE_CATALOG`'s terrain field tags each tile artwork with a
//!    `state::TerrainType` (`Plain`, `MountainRugged`, `SmallTown`,
//!    `MajorCityHub`) rather than a raw invented VGP figure. The actual
//!    revenue value comes from `terrain_base_value`, a static lookup keyed
//!    purely by that classification. REVENUE PATHING CORRECTION (see that
//!    function's own doc comment for the full rationale): Plain $0,
//!    Mountain/Rugged $0, Small Town $10, Major City Hub $20 -- plain and
//!    mountain track is a pure connector with no printed revenue value of
//!    its own, matching real 1830; only a route that actually reaches a
//!    town or city hex earns anything. `pathfinding.rs` (the Pathfinding
//!    Revenue Engine, `rules.md` Step 3) reads every visited hex's value
//!    through this same lookup (via `tile_base_value`), and only ever does
//!    so for a hex that actually has a `Tile` in `MAP_GRID` -- an
//!    unbuilt/blank hex is skipped outright during route tracing rather
//!    than defaulting to any terrain, so it contributes $0 regardless of
//!    what a hypothetical tile there would be worth (see
//!    `pathfinding.rs`'s own module doc comment #2). There's still no fixed
//!    board with per-hex terrain, so the classification is tied to the
//!    tile artwork laid there rather than the hex position itself.
//! 7. **A protocol's Token Station (Node).** `rules.md` describes a
//!    separate "Token Station Placement" step that isn't built yet (see
//!    `pathfinding.rs`'s own design notes); until it exists, a protocol's
//!    Token Station is modeled as the very first tile it ever laid
//!    (`PROTOCOL_NETWORK_HEXES`'s first entry), exactly as before this
//!    feature. What's new is that every *other* tile in the protocol's
//!    network must now trace an unbroken, currently-live track path back to
//!    it -- see design note #9.
//! 8. **Tech Era Color-Locking.** `GameSession::current_global_era` starts
//!    at `TileColor::Yellow`; every yellow tile is unlocked from genesis.
//!    Buying the first-ever 3-train from the Hardware pool unlocks
//!    `TileColor::Green`; buying the first-ever 5-train unlocks
//!    `TileColor::Brown` (`hardware::record_purchase_and_apply_rusting`) --
//!    the real 1830 phase-chart rule. `execute_lay_tile` rejects any
//!    placement or upgrade whose tile's color exceeds the room's current
//!    era (`EraLocked`), for both a brand-new tile and an upgrade.
//! 9. **Path Connectivity to an existing Token Station (Node).** A
//!    protocol's very first tile ever is unconditionally accepted as its
//!    Token Station (design note #7). Every tile laid after that must have
//!    at least one edge, at some rotation, that legally meets a neighboring
//!    tile whose opposite edge is also live *and* which itself has a
//!    continuous, unbroken track path back to the Token Station under the
//!    map's *current* laid connections -- verified fresh on every call by
//!    `station_reachable_hexes`, a breadth-first walk from the Token
//!    Station outward along each tile's actual (rotated) connections,
//!    rather than trusted from the historical `PROTOCOL_NETWORK_HEXES`
//!    membership list alone. Recomputing this fresh (instead of reusing
//!    the incremental list) matters now that tiles can be upgraded (design
//!    note #10): an upgrade elsewhere in the network can add edges that
//!    change what's currently reachable, which a purely historical list
//!    wouldn't reflect.
//! 10. **Topology Retention Upgrades.** Laying a tile at an already-occupied
//!     `(q, r)` is now legal exactly when it's a genuine one-tier color
//!     upgrade of the tile already there (`Yellow -> Green` or
//!     `Green -> Brown`, via `next_tile_color`; anything else --
//!     same-color, skipping a tier, or upgrading an already-`Brown` tile --
//!     is rejected as `InvalidColorUpgrade`/`AlreadyMaxColor`). The upgrade
//!     must also preserve every one of the old tile's actual (rotated)
//!     edges: `execute_lay_tile` searches the new tile's six rotations for
//!     one whose actual edge set is a *superset* of the old tile's, i.e.
//!     `old_actual & !new_actual == 0` -- no track can be deleted or
//!     disconnected by an upgrade's rotation, per this feature's request.
//!     `NoLegalConnection`'s station-reachability search is skipped for an
//!     upgrade: preserving every old edge automatically preserves whatever
//!     connectivity the old tile already had verified, so nothing new needs
//!     re-checking.
//! 11. **Landmark Reservation.** `LANDMARK_HEXES` fixes axial coordinates
//!     for 1830's three core major-destination cities -- New York, Boston,
//!     and Baltimore. A landmark hex may only ever receive a
//!     `TerrainType::MajorCityHub` tile (never a generic plain-track curve
//!     or terrain tile: `LandmarkRequiresHubTile`), and, symmetrically, a
//!     `MajorCityHub` tile may only ever be laid at one of these three
//!     reserved hexes (`HubTileMustBeOnLandmark`) -- so the designated
//!     multi-city hub artwork and the three landmark cities are mutually
//!     exclusive to each other and to every other hex on the board.
//! 12. **Terrain Fee Timing: paid once, on the initial placement only.**
//!     Real 1830 charges a tile's terrain fee (water, mountains, and so on)
//!     only when the *first* (always-Yellow) tile is laid onto empty land;
//!     every later color upgrade of that same hex (`Yellow -> Green`,
//!     `Green -> Brown`) is free, since the terrain itself doesn't change,
//!     only the track drawn on top of it. `execute_lay_tile` now charges
//!     `TILE_CATALOG`'s listed cost only when `existing_tile` is `None` (a
//!     fresh placement); an upgrade (design note #10, `existing_tile` is
//!     `Some`) always charges `Uint128::zero()` regardless of what
//!     `TILE_CATALOG` lists for the upgrade tile's own entry -- superseding
//!     design note #5's earlier "full listed cost, same as a fresh
//!     placement" behavior, which was an intentional simplification at the
//!     time but not the real 1830 rule.
//! 13. **Operating Round Turn Queue gating.** In addition to the existing
//!     President-only authorization, `execute_lay_tile` now also checks
//!     `GameSession::active_corporation_index` (see that field's doc
//!     comment in `state.rs`, and `operations.rs` for how the queue itself
//!     is computed and populated): whenever the room has an active,
//!     non-empty `active_operating_order`, `protocol_id` must be the one
//!     currently pointed to, or the call is rejected with
//!     `NotYourOperatingTurn` before any other check runs. A room that has
//!     never begun an Operating Round turn queue (`active_operating_order`
//!     still empty) is unaffected -- this check is purely additive.
//! 14. **Off-Board Reservation.** `OFFBOARD_HEXES` fixes axial coordinates
//!     for 1830's seven real red off-board revenue terminals (Chicago,
//!     Canadian West x2, Gulf x2, Deep South, Maritime Provinces -- see that
//!     constant's doc comment for the per-hex breakdown). Unlike a landmark
//!     hex (design note #11), which accepts exactly one designated tile
//!     type, an off-board hex accepts *no* tile artwork at all -- it's a
//!     printed revenue destination on the physical board, not track a
//!     Protocol lays onto. `execute_lay_tile` rejects any placement attempt
//!     there outright with `OffboardHexNotBuildable`, checked before the
//!     Landmark Reservation check (design note #11) since the two reserved-
//!     hex sets are disjoint and off-board takes priority as the more
//!     absolute restriction; `legal_tile_placements` mirrors this by
//!     returning an empty result for any off-board `(q, r)` before
//!     evaluating any `TILE_CATALOG` entry.
//! 15. **Coordinate Symmetries (traceability, not a storage change).**
//!     `(q, r)` axial pairs remain this contract's actual storage and
//!     message key throughout -- they already are the literal,
//!     un-abstracted transform of the real 1830 board's own printed labels
//!     (design note #1's neighbor math needs integers to work at all), not
//!     a "simplified array index" divorced from the physical board.
//!     `BOARD_HEX_LABELS` is the authoritative 93-entry label<->axial table
//!     (a byte-for-byte port of the frontend's identical
//!     `STATIC_BOARD_HEXES`) that `label_for_axial`/`axial_for_label`/
//!     `describe_hex` read from; every `HexMapError` variant that carries a
//!     coordinate also carries `hex_label` (via `describe_hex`), and
//!     `execute_lay_tile`'s response and `query::MapTileEntry`/
//!     `query::LegalTilePlacementsResponse` do the same, so nothing this
//!     contract ever surfaces about a hex requires hand-computing the axial
//!     transform to check it against the physical board or
//!     `HexGridRenderer.tsx`'s canvas.
//! 16. **Rigid On-Chain Tile Matching.** Generalizes design note #11's
//!     Landmark Reservation into a full preprinted-infrastructure gate
//!     covering every one of the real board's 93 hexes, not just the three
//!     landmarks: `CITY_DESIGNATED_HEXES` fixes the six real pre-printed
//!     GRAY city hexes (Lansing D2, Cleveland F6, Altoona H12, Rochester
//!     D14, Richmond K15, Montreal A19), the four pre-printed YELLOW "OO"
//!     double-city hexes (Detroit & Windsor E5, Hamilton & Toronto D10,
//!     Dunkirk & Buffalo E11, Philadelphia & Trenton H18), and (added by a
//!     later pass -- see that constant's own doc comment) eight ordinary
//!     WHITE city hexes with a bare city placeholder and no printed track
//!     (Toledo F4, Providence F22, Pittsburgh H10, Columbus H4, Washington
//!     J14, Lancaster H16, Ottawa B16, Barrie B10) -- together with
//!     `LANDMARK_HEXES`, every hex whose printed infrastructure includes a
//!     City, tracked or blank alike.
//!     `TOWN_DESIGNATED_HEXES` fixes the three real pre-printed GRAY
//!     single-town hexes (Kingston C15, Atlantic City I19, Mansfield F24),
//!     four ordinary white single-town hexes with a bare town placeholder
//!     and no printed track (London E7, Burlington B20, Flint D4, Erie
//!     F10), and three ordinary white DOUBLE-town hexes (Akron & Canton G7,
//!     Reading & Allentown G17, New Haven & Hartford F20) -- matching the
//!     real sourced counts of 4 preprinted Single-Town hexes and 3
//!     preprinted Double-Town hexes, all verbatim-sourced from
//!     `tobymao/18xx`'s `g_1830/map.rb` `HEXES` hash. `execute_lay_tile` now
//!     rejects, symmetrically in both directions (mirroring design note
//!     #11's own landmark match exactly): a `MajorCityHub` tile anywhere
//!     that isn't a landmark or `CITY_DESIGNATED_HEXES` entry
//!     (`HubTileMustBeOnLandmark`), a non-`MajorCityHub` tile AT a landmark
//!     or `CITY_DESIGNATED_HEXES` entry (`LandmarkRequiresHubTile`), a
//!     `SmallTown`/`DoubleTown` tile anywhere that isn't a
//!     `TOWN_DESIGNATED_HEXES` entry (`TownTileMustBeOnTownDesignation`),
//!     and a non-`SmallTown`/`DoubleTown` tile AT a `TOWN_DESIGNATED_HEXES`
//!     entry (`TownDesignationRequiresTownTile`). Every hex that is none of
//!     landmark/city-designated/town-designated/off-board is therefore left
//!     accepting only `Plain`/`MountainRugged` track -- the third bullet
//!     ("blank plains, mountain, or river hexes can only receive plain
//!     track") falls out of the first two symmetric gates rather than
//!     needing its own separate rule. `legal_tile_placements` mirrors both
//!     new gates identically (see that function's own MAINTENANCE NOTE).
//! 17. **Landmark Pathfinder Revenue Fix.** A later pass reversed
//!     `pathfinding.rs`'s original "no separate landmark special case"
//!     design (that module's own doc comment, item 2, "Hex/city values"):
//!     a route that reaches a preprinted landmark or gray-city hex with
//!     real starting track -- the three `LANDMARK_HEXES` (New York, Boston,
//!     Baltimore) plus two of `CITY_DESIGNATED_HEXES`' six real-track GRAY
//!     cities (Montreal, Cleveland) -- must score its real, individually-
//!     sourced starting face value ($40/$30/$30/$40/$30) even before any
//!     Protocol has laid a tile there, matching real 1830 where these five
//!     hexes are physically pre-printed and active from turn one.
//!     `LANDMARK_START_VALUE_OVERRIDE`/`landmark_start_value_at` below hold
//!     the coordinate -> $ table (kept in lockstep with the frontend's own
//!     `HEX_START_VALUE_OVERRIDE` in `HexGridRenderer.tsx`, same five
//!     hexes, same figures, same sourcing). This does NOT reach any other
//!     `CITY_DESIGNATED_HEXES`/`OO_DESIGNATED_HEXES` entry (the eight blank
//!     white city markers, or -- after note #18 below split them out of
//!     `CITY_DESIGNATED_HEXES` -- the four OO hexes) -- none of those have
//!     any real printed track to route across before a tile is laid, so
//!     "pass through it untiled" isn't a coherent scenario for them the way
//!     it is for these five. See `pathfinding.rs`'s own updated doc comment
//!     and its `effective_tile_and_value` helper for exactly how this is
//!     applied -- as a read-only, query-time overlay inside the route
//!     tracer only, never a `MAP_GRID` write, so it has zero effect on tile
//!     legality (`execute_lay_tile` below, untouched by this pass), on a
//!     Protocol's ability to lay its own first tile at one of these five
//!     hexes to establish its home station (also untouched), or on
//!     `terrain_base_value`'s own flat, hex-agnostic live-payout table
//!     below (also untouched, per that function's own doc comment's
//!     already-settled reasoning against making it hex-specific) -- the
//!     override applies ONLY to the synthetic pre-tile window, and steps
//!     aside the moment a real tile (any tile_id) is actually laid at one
//!     of these five hexes, reverting to the ordinary flat lookup exactly
//!     as before this pass.
//! 18. **OO Double-City Tile Catalog Enforcement.** A later request asked
//!     this contract to actually verify (not just log) that the four
//!     preprinted OO double-city hexes -- Detroit & Windsor (E5), Hamilton
//!     & Toronto (D10), Dunkirk & Buffalo (E11), Philadelphia & Trenton
//!     (H18) -- can only ever be upgraded with real double-city artwork,
//!     never an ordinary single-city hub tile. That check DIDN'T actually
//!     exist: before this pass, `TerrainType` had no double-city variant at
//!     all, and every one of `CITY_DESIGNATED_HEXES`' eighteen entries --
//!     the three landmarks aside -- required nothing more specific than
//!     plain `MajorCityHub`, uniformly, whether the hex was a real
//!     single-city GRAY city (Cleveland), a blank single-city marker
//!     (Toledo), or a real two-station OO hex (Detroit & Windsor). A player
//!     genuinely could upgrade Detroit & Windsor with the same generic hub
//!     tile as any other city -- nothing on-chain distinguished them.
//!     Fixed by: a new `TerrainType::DoubleCityHub` variant
//!     (`state.rs`); a new, disjoint `OO_DESIGNATED_HEXES` list holding
//!     exactly the four OO hexes, split out of `CITY_DESIGNATED_HEXES`
//!     (which now holds the remaining fourteen -- the six real-track GRAY
//!     cities and eight blank city markers); a new `oo_designation_name_at`
//!     lookup mirroring `landmark_name_at`/`city_designation_name_at`; and
//!     a City Reservation rewrite (both here and `legal_tile_placements`,
//!     kept in lockstep per that function's own MAINTENANCE NOTE) that
//!     requires `DoubleCityHub` at an OO hex and rejects it everywhere
//!     else, leaving the original landmark/plain-city `MajorCityHub` match
//!     completely untouched for every non-OO reserved hex. `TILE_CATALOG`
//!     gains exactly one new entry: a Green-tier `DoubleCityHub` tile
//!     (real, sourced 1830 tile 59, `city=revenue:40` on each of its two
//!     separate stations, verified against `tobymao/18xx`'s
//!     `config/tile.rb`/`g_1830/map.rb`) -- and ONLY Green, deliberately: OO
//!     hexes start pre-printed Yellow already (so there's no "Yellow lay"
//!     for a player to ever make there, matching how a landmark's own first
//!     action is likewise its Yellow hub, never a truly blank placement),
//!     and the real 1830 tile set has no Brown OO tile at all -- green tile
//!     59 is the final upgrade those four hexes ever receive, independently
//!     verified against the same sources' full `TILES` manifest. Connection
//!     bitmask kept at `0b11_1111` (all six edges) for the same reason
//!     every other hub tile already uses it (module doc comment #2's own
//!     tile-artwork abstraction) -- this engine has no per-edge-to-station
//!     routing model, so a "real" two-node edge pattern for tile 59 would
//!     be more misleading than informative without that deeper model (see
//!     the note on revenue below). `terrain_base_value` prices a
//!     `DoubleCityHub` tile flat at $40 -- exactly `DoubleTown`'s own
//!     already-established "two stops sharing one hex, priced at 2x the
//!     single-stop figure" precedent ($10 SmallTown -> $20 DoubleTown; here
//!     $20 MajorCityHub -> $40 DoubleCityHub), NOT a genuine two-separate-
//!     revenue-events model: `pathfinding::trace_best_route`/
//!     `operations::execute_run_manual_route` still visit a hex once and
//!     price it once, same as any other hex, so a route through a
//!     `DoubleCityHub` tile earns a single flat $40, not two independent
//!     $40 station stops. A true two-station model (crediting BOTH of a
//!     double-city tile's revenue centers when a route's track genuinely
//!     threads through both, in one continuous pass -- NOT by revisiting
//!     the hex a second time, which the existing "no hex revisited within
//!     one route" rule, `pathfinding.rs` module doc comment #3, already and
//!     correctly forbids) would need real per-edge-to-station track data
//!     this engine doesn't model anywhere yet. Flagged as a real, deeper
//!     simplification -- not fixed here, matching this file's and
//!     `pathfinding.rs`'s own established convention of naming a
//!     simplification explicitly rather than silently leaving it unstated.
//! 19. **Gray Hex Immutability.** The same request also asked that the real
//!     pre-printed GRAY hexes -- fixed, permanent starting track on the
//!     physical 1830 board -- can never be upgraded at all, unlike a
//!     Yellow pre-printed hex (a landmark or OO hex), which starts with
//!     real track too but is explicitly meant to be built on top of later.
//!     This also DIDN'T actually exist: nothing before this pass
//!     distinguished a real GRAY city/town (Cleveland, Kingston, ...) from
//!     an ordinary blank white city/town marker (Toledo, London, ...) for
//!     placement-legality purposes -- both were just "this hex requires
//!     terrain X," identically buildable. A player genuinely could lay a
//!     brand-new tile at Cleveland as though it were an ordinary
//!     undeveloped hex. Fixed by a new `GRAY_PREPRINTED_HEXES` list (the
//!     nine hexes already independently identified as real GRAY by
//!     `CITY_DESIGNATED_HEXES`'s six cities and `TOWN_DESIGNATED_HEXES`'s
//!     three towns -- no new coordinate sourcing needed, just a structural
//!     split of data already on record) and a `gray_preprinted_name_at`
//!     lookup, checked unconditionally in both `execute_lay_tile` and
//!     `legal_tile_placements` immediately after Off-Board Reservation --
//!     same "checked first since disjoint from, and more absolute than,
//!     every rule below" placement Off-Board Reservation itself already
//!     uses. This ALSO retroactively strengthens note #17 above: the
//!     Landmark Pathfinder Revenue Fix's synthetic-tile overlay for
//!     Montreal/Cleveland already assumed those two hexes would never have
//!     a real `Tile` land in `MAP_GRID` -- previously true only because no
//!     player happened to; now it's a hard on-chain guarantee. Originally
//!     scoped to the nine real GRAY city/town hexes only, matching that
//!     request's own city-progression framing, and explicitly flagged as
//!     leaving the real board's plain GRAY connector hexes (fixed track, no
//!     city/town marker -- e.g. E9) out of scope, "left for an explicit
//!     future request." See module doc comment #20 for that request.
//! 20. **Rigid Global Gray-Hex Lockout (board-wide extension).** A follow-up
//!     request explicitly closed the gap #19 flagged: EVERY preprinted GRAY
//!     hex, not just the nine with a city/town, must be permanently
//!     un-upgradable -- including the real board's three bare GRAY
//!     connector hexes (E9, A17, D24), which have real fixed pre-printed
//!     track but no station of any kind. `GRAY_PREPRINTED_HEXES` grows from
//!     nine entries to twelve; `gray_preprinted_name_at`'s existing
//!     unconditional-reject call sites in `execute_lay_tile` and
//!     `legal_tile_placements` need no further change at all -- they
//!     already reject anything the table lists, so widening the table alone
//!     closes the gap. Coordinates for the three new entries came from this
//!     file's own `BOARD_HEX_LABELS` (already on record) and were
//!     cross-checked against the frontend's `GRAY_HEXES` constant, which
//!     already had complete twelve-hex, board-wide data (it draws the real
//!     printed track for all twelve, connector hexes included) -- so this
//!     was a data-widening fix, not new external sourcing.
//!
//!     This pass also caught and fixed a real latent bug the *original*
//!     #19 lockout silently introduced: once a real GRAY hex can never
//!     receive a laid `Tile`, `pathfinding::effective_tile_and_value`'s
//!     `MAP_GRID.may_load` branch can now NEVER fire for that hex again --
//!     and, before this pass, only five of the nine (`LANDMARK_START_VALUE_OVERRIDE`'s
//!     New York/Boston/Baltimore/Montreal/Cleveland) had a synthetic virtual
//!     tile standing in for that missing real one. The other four real GRAY
//!     city/town hexes (Lansing, Altoona, Rochester, Richmond) and all
//!     three real GRAY towns (Kingston, Atlantic City, Fall River) had no
//!     such fallback, so `effective_tile_and_value` returned `None` for
//!     them -- meaning, since the day #19 shipped, those seven hexes were
//!     silently unroutable dead zones: no route could pass through them or
//!     score any value there at all, contradicting their real printed track
//!     actually connecting to the rest of the board. This was never caught
//!     by `tests.rs` because #19's own tests exercise placement legality,
//!     not route tracing. Widening the lockout to the three bare connectors
//!     here would have made this bug considerably worse (E9/A17/D24 are
//!     pure through-connectors -- losing them could sever board regions
//!     entirely, not just zero out one city's revenue). Fixed by extending
//!     `effective_tile_and_value`'s synthetic-tile fallback (`pathfinding.rs`)
//!     to cover every `gray_preprinted_name_at` hex, not just the five in
//!     `LANDMARK_START_VALUE_OVERRIDE`: any gray hex still checked first
//!     against that override (unchanged, highest-precision path), then
//!     against `city_designation_name_at` (flat `MajorCityHub` value) or
//!     `town_designation_at` (flat `SmallTown`/`DoubleTown` value), then
//!     falling back to `$0` for a bare connector -- always using the same
//!     permissive full-six-edge virtual tile artwork (tile_id 10) the
//!     original five already used, so none of these hexes can itself block
//!     a route, consistent with that established precedent rather than
//!     introducing new per-edge precision this pass wasn't asked for.
//!
//!     Also corrected, while re-deriving these hexes' real sourced values:
//!     Altoona (H12) is genuinely a City on the real board (verified twice
//!     against `tobymao/18xx`'s `g_1830/map.rb`: `'city=revenue:10,loc:2.5;...'`
//!     -- a `city=` entry, not `town=`) worth a real, sourced $10 -- NOT the
//!     generic flat `$20` `MajorCityHub` figure it fell through to before,
//!     and NOT a Town reclassification either (a paired request this same
//!     turn asked for both; the $10 figure is correct, the Town
//!     reclassification is not, per this same sourced text). Added to
//!     `LANDMARK_START_VALUE_OVERRIDE` as a sixth entry rather than
//!     reclassifying `Altoona`'s `TerrainType` -- its station marker, badge
//!     color, and placement-legality rules all stay exactly as a
//!     `MajorCityHub`'s; only its priced $ figure changes, via the same
//!     override mechanism Montreal/Cleveland already use for the identical
//!     reason (a real sourced figure that diverges from the flat generic
//!     one). Lansing/Rochester/Richmond are left on the generic flat `$20`
//!     -- no individually-sourced figure for them has been verified in any
//!     pass to date, matching `LANDMARK_START_VALUE_OVERRIDE`'s own
//!     established "don't guess a number" precedent.
//!
//!     Separately, also revisited while re-deriving `DoubleCityHub`'s real
//!     source text (module doc comment #18): that note already quoted real
//!     tile 59's code as `city=revenue:40` on EACH of its two stations, but
//!     `terrain_base_value` priced the whole tile at a flat `$40` anyway, by
//!     analogy by to `DoubleTown`'s "$10 stop -> $20 double" 2x pattern --
//!     silently treating each station as if it were $20, not the $40
//!     already sourced and quoted in that very same paragraph. Corrected to
//!     `$80` (2 x the real, already-cited $40 per station), a one-line
//!     internal-consistency fix, not a new sourcing exercise. This is
//!     unrelated to, and does NOT resolve, that same note's larger flagged
//!     gap: `trace_best_route`/`execute_run_manual_route` still visit a
//!     `DoubleCityHub` hex once and price it once (now $80 instead of $40),
//!     not two independently-gated $40 station stops. A request this same
//!     turn asked for exactly that genuine two-station model, described as
//!     a route "exiting the hex, wrapping around, and re-entering along a
//!     different track" to reach the second station -- re-verified this
//!     turn (independent research pass, real 18xx route-validation source +
//!     rules-difference references) to still be factually incorrect: the
//!     authentic mechanic is a SINGLE continuous pass touching both
//!     stations via real printed track, never hex re-entry, and re-entry
//!     would also violate this engine's own already-correct, already-
//!     documented "no hex revisited within one route" invariant
//!     (`pathfinding.rs` module doc comment #3) -- the same conclusion, and
//!     the same rejection, as the first time this exact mechanic was
//!     proposed (module doc comment #18's own paragraph above). Genuine
//!     single-pass dual-station crediting remains unbuilt: it would need
//!     real per-edge-to-station track data this engine has never modeled
//!     (tile 59's real path data, independently sourced this pass, is in
//!     fact two disconnected one-edge stubs -- edge 0 to station A, edge 2
//!     to station B, with NO path between them at all -- meaning a fully
//!     accurate model wouldn't just split revenue, it would make this hex
//!     a dead-end for through-routing entirely, a materially larger and
//!     riskier change to core route connectivity than this turn's request
//!     described or scoped). Left as the flat, corrected $80 rather than
//!     guessing at a partial implementation of a mechanic already rejected
//!     twice on factual grounds.
//!
//!     REVENUE VALUE FOLLOW-UP CORRECTION: the $80 figure above was itself
//!     an error, caught on further review of this very paragraph's own
//!     conclusion. Tile 59's real path data -- already independently
//!     sourced immediately above -- is two disconnected one-edge stubs
//!     (edge 0 to station A, edge 2 to station B, no path between them).
//!     Because a route can only ever enter/exit this hex via ONE of those
//!     two edges in a single continuous transit, it can only ever reach
//!     ONE of the two stations per visit -- never both -- so crediting
//!     $80 (both stations at once) on every pass silently assumed exactly
//!     the "touches both stations in one continuous pass" scenario this
//!     same paragraph had just finished ruling out as unbuilt (and, per
//!     the real disconnected topology, actually impossible on this
//!     specific tile regardless of implementation effort). Corrected back
//!     to a flat `$40` -- the real, sourced revenue of whichever single
//!     station a route's track actually reaches -- matching what a real
//!     single continuous train transit through this hex can genuinely
//!     collect. This does not reopen the larger two-station-crediting gap
//!     above: that model remains correctly flagged as unbuilt (and, for
//!     this specific tile's real topology, not buildable as "both in one
//!     pass" at all); this is strictly a revert of the earlier pass's
//!     $80 overcorrection back to the value consistent with a single-
//!     visit, single-station model.
//! 21. **DoubleTown Revenue Correction (backporting the DoubleCityHub
//!     fix).** A later request pointed out that `TerrainType::DoubleTown`
//!     was still priced at a flat $20 -- exactly the "two $10 stops sharing
//!     one hex, priced at 2x the single-stop figure" model module doc
//!     comment #18 explicitly named as `DoubleCityHub`'s OWN original
//!     precedent, before that same precedent was proven wrong and corrected
//!     (twice: to $80, then back down to a flat $40) by comment #18's tail
//!     paragraph and comment #20's follow-up correction. That correction's
//!     reasoning -- a route can only ever enter/exit a hex via ONE edge in a
//!     single continuous transit, so it can only ever reach ONE of a
//!     double-station hex's two stops per visit, never both, exactly as a
//!     `DoubleCityHub` tile's two stations don't connect intra-hex and
//!     aren't both credited on a single pass -- applies identically to
//!     `DoubleTown`, which was simply never revisited when the
//!     `DoubleCityHub` fix landed. Corrected here the same way: flat $10,
//!     the same figure a single `SmallTown` scores, not $20. This is a pure
//!     `terrain_base_value` change -- `TILE_CATALOG` entry 6's own $20
//!     field is a SEPARATE number (the VGP terrain-lay cost charged once
//!     when the tile is first placed, module doc comment #12), untouched by
//!     this fix and correctly still distinct from the hex's revenue value.
//! 22. **Impassable Border Edges.** A request identified four specific
//!     board-edge crossings that must never carry track, even though a
//!     tile may still be laid in either hex the border separates: the
//!     E7/F8, D12/C11, D12/C13, and C17/B16 borders (`IMPASSABLE_HEX_EDGES`,
//!     each of the eight `(q, r, edge)` entries independently sourced from
//!     this same file's own `BOARD_HEX_LABELS`/axial-conversion formula --
//!     see that table's own doc comment -- and cross-checked against
//!     `HEX_NEIGHBOR_OFFSETS`' edge convention, module doc comment #1).
//!     Unlike Off-Board Reservation or Gray Hex Immutability (#14/#19),
//!     which reject an entire hex outright, this is a per-EDGE restriction:
//!     the hex itself stays ordinarily buildable, but no orientation of any
//!     tile may leave a live connection on the specific blocked edge.
//!     Enforced in `execute_lay_tile` (a new, disjoint check against the
//!     candidate placement's own rotated connections, checked right after
//!     Gray Hex Immutability for the same "absolute, unrelated to
//!     terrain/city/town matching" reason those checks are grouped there)
//!     and mirrored in `legal_tile_placements` per that function's own
//!     MAINTENANCE NOTE. Listed as symmetric `(q, r, edge)` pairs -- both
//!     hexes on each side of a border carry their own entry for their own
//!     edge facing the crossing -- so the block holds regardless of which
//!     side's tile would have been the one to route track across it.
//!     `pathfinding.rs` needs no matching change: since no tile can ever
//!     legally carry a live edge across one of these borders in the first
//!     place, a route can never actually traverse one either, the same
//!     "structural placement-time guarantee, no redundant runtime check
//!     needed" reasoning module doc comment #19 already established for
//!     Gray Hex Immutability. This is a custom board-geometry restriction
//!     specified directly for this engine, not sourced from the real 1830
//!     rulebook -- unlike this file's other terrain/value facts, which are
//!     independently verified against real 1830 sources where noted, this
//!     one has no such source to check against.
//! 23. **Station Tokens: home cities and a real per-corporation token
//!     limit/cost.** Requested: preprint each corporation's real home city
//!     as a station-token marker, and enforce that each corporation only
//!     ever places a fixed, limited number of Station Tokens, at a real
//!     cost. `CORPORATION_HOME_HEX` gives seven of the eight corporations'
//!     home hex (sourced from this same file's own already-verified
//!     `LANDMARK_HEXES`/`CITY_DESIGNATED_HEXES`/`OO_DESIGNATED_HEXES`
//!     entries -- PRR/Altoona H12, NYC/New York G19, CPR/Montreal A19,
//!     B&O/Baltimore I15, C&O/Cleveland F6, ERIE/Dunkirk & Buffalo E11,
//!     B&M/Boston E23); NNH originally had no assigned home hex on this
//!     custom board and was deliberately left out of `CORPORATION_HOME_HEX`
//!     -- flagged, not guessed. HISTORICAL as of module doc comment #25's
//!     house rule: NNH is now assigned New York G19, and NYC is reassigned
//!     to Albany E19; see #25 for the current mapping and why.
//!     `STATION_TOKEN_LIMIT`/`station_token_limit` gives each
//!     corporation's total token count (home token included): PRR/NYC/CPR
//!     4, B&O/C&O/ERIE 3, NNH/B&M 2. `station_token_cost` prices the token
//!     currently being placed: the 1st (home) token is free, the 2nd costs
//!     40 VGP, every one after that costs 100 VGP -- a flat progression, not
//!     scaled per-corporation (this project's own source-check turned up
//!     genuine disagreement between the official rulebook, which only says
//!     "2-4" tokens per corporation without listing specifics, and a
//!     secondary source's per-company table that contradicts the
//!     rulebook's own stated max -- the exact counts and cost figures used
//!     here came directly from the requester rather than either
//!     conflicting source).
//!
//!     DELIBERATELY DECOUPLED from the Token Station (Node)/
//!     `PROTOCOL_NETWORK_HEXES` system above (module doc comment #7/#9):
//!     the free home token granted at float (`grant_home_station_token`,
//!     called from `auction::award_bo_president_share` and
//!     `trading::execute_buy_stock`'s float branch) only ever writes to the
//!     new `PROTOCOL_STATION_HEXES`/`state.rs` registry, never to
//!     `PROTOCOL_NETWORK_HEXES` -- so it does NOT retroactively become
//!     "the first tile this protocol ever laid" for
//!     `station_reachable_hexes`'s connectivity BFS, and does NOT require
//!     this engine's existing `execute_lay_tile`/`station_reachable_hexes`
//!     machinery (built, tested, and load-bearing for the whole tile-laying
//!     rule set) to be reworked to special-case a station hex with no
//!     `MAP_GRID` tile on it yet. This is an accepted, intentional
//!     simplification: today, a corporation's real historical home-city
//!     marker is purely a Station Token/informational object (see
//!     `execute_place_station_token`'s own reachability check, which reads
//!     from `station_reachable_hexes` but never writes to it) and does not
//!     itself anchor where that corporation's track network is allowed to
//!     grow from -- that remains governed by wherever its President's
//!     first `LayTile` call happens to land, exactly as before this
//!     feature. Matches this module's own precedent of flagging a known,
//!     deliberately out-of-scope gap (module doc comment #7) rather than
//!     silently pretending the two systems are unified. Per the same
//!     scoping decision, per-hex "how many different corporations may
//!     token this one city" capacity is NOT modeled here either (no city
//!     hex constant carries a station-slot count) -- only requested was a
//!     per-corporation token limit/cost/turn-cadence, not a shared-city
//!     capacity system, so none is invented.
//!
//!     `execute_place_station_token` (the paid, in-Operating-Round action
//!     for every token after the free home one) additionally requires: the
//!     target hex already holds a laid `MajorCityHub`/`DoubleCityHub` tile
//!     (`StationTokenHexNotACity`); that hex is reachable from this
//!     protocol's existing `PROTOCOL_NETWORK_HEXES` track network, read via
//!     the very same `station_reachable_hexes` the tile-laying engine
//!     already uses (`StationTokenHexNotReachable`) -- called read-only,
//!     never mutated; the protocol doesn't already have a token there
//!     (`StationTokenAlreadyOnHex`); its token count hasn't hit
//!     `station_token_limit` (`StationTokenLimitReached`); and it hasn't
//!     already placed a token this same Operating Round sub-round
//!     (`StationTokenAlreadyPlacedThisSubRound`, tracked by
//!     `PROTOCOL_LAST_TOKEN_SUBROUND` against `GameSession::
//!     macro_round_number`/`sub_round_index`) -- there was no existing
//!     "already did X this turn" tracking anywhere in this contract to
//!     reuse (every other per-turn action is unlimited-per-turn), so this
//!     is a new pattern, scoped to this one action.
//!
//!     ERIE's home hex (E11, Dunkirk & Buffalo) is a shared
//!     `OO_DESIGNATED_HEXES` double-city hex, printed with two separate
//!     city markers -- real 1830 has Erie's President choose one of the two
//!     on Erie's first Operating Round turn after floating, rather than a
//!     fixed single spot the way the other six corporations' homes work.
//!     That per-corner choice isn't modeled by this pass (E11 is recorded
//!     as this engine's one `(q, r)` axial coordinate for the hex, same as
//!     every other token target); flagged as a further known simplification,
//!     historically of the same kind as NNH's then-missing home (see #25 --
//!     NNH now has an assigned home, but ERIE's own per-corner choice is
//!     still not modeled), not silently assumed away.
//! 24. **Private-Company-Reserved Hexes.** Two board hexes -- "B20"
//!     (Burlington, axial `(9, 1)`, already a `TOWN_DESIGNATED_HEXES`
//!     Single-Town entry) and "F16" (axial `(5, 5)`, an otherwise ordinary,
//!     undesignated hex) -- are strictly off-limits to track laying by ANY
//!     public company, unless that specific company is the CORPORATE owner
//!     of the linked private company: Delaware & Hudson (private_id 3) for
//!     B20, Mohawk & Hudson (private_id 4) for F16. See
//!     `trading::execute_buy_private_company` (module doc comment #17
//!     there) for how a private ever becomes corporate-owned in the first
//!     place. Deliberately keyed off `PrivateCompany::owner_protocol_id`,
//!     NOT `PrivateCompany::owner` -- per an explicit clarification, these
//!     two privates' hex-reservation powers only ever activate once a
//!     CORPORATION owns them, never while a player (even the private's own
//!     owner) merely holds the certificate. The block lifts globally and
//!     unconditionally, for every reserved hex, the instant
//!     `PrivateCompany::closed` is true for that hex's linked private --
//!     which happens to EVERY still-open private automatically the moment
//!     the room's first 5-train is bought (`hardware.rs`'s Phase 5 Private
//!     Closure, module doc comment #12 there), i.e. "Phase 5 launches" in
//!     this feature's own request wording. This engine has no separate
//!     `Phase` type: Phase 3 (the 3-train era gating
//!     `execute_buy_private_company` itself) maps to `TileColor::Green`,
//!     and Phase 5 maps to `TileColor::Brown`, both via `hardware.rs`'s
//!     existing `ERA_UNLOCK_TRIGGERS` ("3" unlocks Green, "5" unlocks
//!     Brown) -- so this gate itself never needs to read
//!     `current_global_era` directly, only `PrivateCompany::closed`.
//!     `private_reserved_hex_blocks` is the shared check, called from both
//!     `execute_lay_tile` (right after Impassable Border Edges, for the
//!     same "absolute, unrelated to terrain/city/town matching" grouping
//!     reason those checks sit there) and `legal_tile_placements` (right
//!     after Gray Hex Immutability, per that function's own MAINTENANCE
//!     NOTE) -- an unconditional whole-hex block, like Off-Board
//!     Reservation/Gray Hex Immutability, not a per-edge restriction like
//!     Impassable Border Edges. This is a custom house rule specified
//!     directly for this engine, not a real 1830 mechanic (real 1830's
//!     Delaware & Hudson/Mohawk & Hudson privates carry no hex-reservation
//!     power at all) -- like module doc comment #22's Impassable Border
//!     Edges, there's no rulebook source to check this against.
//! 25. **House-Rule Home Reassignment: NYC/Albany, NYNH/New York.** An
//!     explicit, repeated request (asked three times, the first two
//!     including NYC/Albany and NYNH/New York specifically, after this
//!     module's own doc comments -- see module doc comment #23 and the
//!     `CITY_DESIGNATED_HEXES` comment above -- twice flagged that this
//!     diverges from the real 1830 board, where NYC's home is New York
//!     G19 and NYNH shares that same hex rather than having a separate
//!     home) requested this exact swap be implemented as this custom
//!     board's own deliberate house rule, not a factual claim about real
//!     1830: `CORPORATION_HOME_HEX` now gives NYC (company_id 2) Albany
//!     E19 `(7, 4)` instead of New York G19, and gives NNH (company_id 7,
//!     "NYNH" in the request's own naming -- see `public_company.rs`'s
//!     `CORE_PUBLIC_COMPANIES` for the real on-chain ticker) New York G19
//!     `(6, 6)`, which NYC now vacates -- a clean swap, no collision.
//!     Superseding the "seven of eight, NNH deliberately absent" and
//!     "NYC/New York G19" claims in module doc comment #23 and the
//!     `CITY_DESIGNATED_HEXES` comment above; those are left in place
//!     un-deleted (per this file's own convention of not silently erasing
//!     a prior pass's own reasoning, module doc comment #17/#29's
//!     precedent) but are now HISTORICAL -- superseded by this note for
//!     current behavior.
//!
//!     MECHANICAL VERIFICATION done before applying this: `grant_home_station_token`
//!     performs a plain, unconditional
//!     `PROTOCOL_STATION_HEXES` write with no assertion against
//!     `LANDMARK_HEXES`/`GRAY_PREPRINTED_HEXES`/`OO_DESIGNATED_HEXES`
//!     membership, and the free home token is (module doc comment #23's own
//!     "DELIBERATELY DECOUPLED" paragraph, unchanged) purely a Station
//!     Token/informational marker -- it was NEVER wired to
//!     `PROTOCOL_NETWORK_HEXES`/tile-laying/route legality for ANY
//!     corporation, so moving NYC's marker onto Albany (a blank
//!     `CITY_DESIGNATED_HEXES` city with no preprinted track, unlike NYC's
//!     previous real-track landmark home) changes nothing mechanically:
//!     every corporation, NYC included, already lays its own first tile
//!     from scratch wherever its President chooses, same as the existing
//!     Altoona/PRR precedent (`tests.rs`'s
//!     `execute_place_station_token_enforces_city_reachability_duplicate_and_subround_rules`,
//!     where PRR's home token already sits on a hex -- Altoona -- that can
//!     never itself receive a laid tile at all, per Gray Hex Immutability).
//!     KNOWN CONSEQUENCE, flagged rather than silently accepted: NYC is now
//!     the only corporation whose home hex carries zero printed starting
//!     value/track of its own (every other corporation's home is a
//!     landmark, real-track gray city, or OO hex) -- a genuine gameplay
//!     asymmetry versus the other seven, not a bug, since nothing in this
//!     engine's mechanics depends on it either way.
//!
//!     `CITY_DESIGNATED_HEXES` itself is UNCHANGED by this note -- Albany
//!     was already added there by a prior pass (see that constant's own
//!     comment) and needed no further edit for NYC's home token to attach
//!     to it; `grant_home_station_token` doesn't consult that list at all
//!     (see the mechanical verification above).
//! 26. **Canonical Tile Upgrade Restrictions: "B" / "NY" / "OO".** Real 1830
//!     labels three of this board's hexes with a letter code restricting
//!     which tile artwork may legally upgrade them: Boston ("B"), New York
//!     ("NY"), and the four OO double-city hexes ("OO", module doc comment
//!     #18, already enforced before this pass). This pass extends the same
//!     "a hex label restricts which tile artwork is legal there, AND that
//!     tile artwork is illegal everywhere else" pattern #18 established for
//!     OO to Boston and New York specifically -- previously, both hexes
//!     accepted (and any other landmark's) ordinary `MajorCityHub` artwork
//!     at every color tier alike, which real 1830 does not: Boston/New
//!     York's GREEN upgrade is restricted to one dedicated tile apiece
//!     (verified against `tobymao/18xx`'s `g_1830/map.rb`: Boston's hex
//!     carries `label=B`, New York's carries `label=NY`), while their
//!     YELLOW start and BROWN upgrade remain the ordinary shared hub
//!     artwork every landmark uses -- this Green-tier scoping is the
//!     request's own explicit wording ("...strictly to 'B'/'NY' designation
//!     GREEN tiles") and matches #18's own precedent of a label-restricted
//!     tile existing at Green only, with no Yellow or Brown entry.
//!
//!     Implemented via two new `TerrainType` variants, `BostonHub` and
//!     `NewYorkHub` (`state.rs`, mirroring `DoubleCityHub`'s own addition
//!     for OO), each with exactly one new Green `TILE_CATALOG` entry (tile
//!     16 for Boston, tile 17 for New York, both `0b11_1111` per this
//!     engine's existing hub-tile abstraction -- see tile 15/module doc
//!     comment #18 for why exact real edge geometry isn't replicated here
//!     either). `execute_lay_tile`'s City Reservation block and
//!     `legal_tile_placements`' mirrored per-catalog-entry loop both gained
//!     two more disjoint branches (checked in the same
//!     OO-then-Boston-then-New-York-then-generic-landmark order, before
//!     falling through to the unchanged Baltimore/plain-city path): a
//!     `BostonHub`/`NewYorkHub` tile is illegal anywhere but Boston/New
//!     York's own Green upgrade (`BostonHubTileMustBeOnBostonHex`/
//!     `NewYorkHubTileMustBeOnNewYorkHex`), and Boston/New York's Green
//!     upgrade specifically requires it (`BostonHexRequiresBostonHubTile`/
//!     `NewYorkHexRequiresNewYorkHubTile`) -- four new `HexMapError`
//!     variants, mirroring `OOHexRequiresDoubleCityHubTile`/
//!     `DoubleCityHubTileMustBeOnOOHex`'s own shape exactly.
//!     `execute_place_station_token`'s "is this hex a real, tokenable city"
//!     check (previously `MajorCityHub || DoubleCityHub`) was extended to
//!     include both new terrains too -- Boston/New York's restriction only
//!     changes WHICH tile artwork is legal there, not whether the result,
//!     once laid, still counts as a real city for Station Token purposes.
//!     `terrain_base_value` prices `BostonHub` in the same flat $20 bucket
//!     as `MajorCityHub` (single city) and `NewYorkHub` in the same flat
//!     $40 bucket as `DoubleCityHub` (double city, one station reachable
//!     per pass, same reasoning as that constant's own note) -- real
//!     1830's own $30/$40 figures for these two hexes are DELIBERATELY not
//!     hex-specific here, same "not live payout math" reasoning
//!     `terrain_base_value`'s own doc comment already gives for every other
//!     landmark; a per-hex preview figure remains frontend-only
//!     (`HEX_START_VALUE_OVERRIDE`).
//!
//!     No client-side re-validation was added to the frontend tile picker
//!     for this restriction, matching that component's own already-
//!     established, explicit "no client-side re-validation of legality"
//!     policy (`TileSelectionPopup.tsx` design note #4) -- like every other
//!     placement rule in this module, the frontend automatically reflects
//!     whatever `legal_tile_placements` returns, with no separate catalog
//!     to keep in sync. The frontend gained purely informational "B"/"NY"/
//!     "OO" corner badges instead (see `HexGridRenderer.tsx`'s own design
//!     note), which is cosmetic and carries no enforcement responsibility
//!     of its own.
//!
//!     UPDATE (module doc comment #27): extended to Baltimore and to the
//!     Brown tier -- see that note for the current, full design; this note
//!     is left as-is for history rather than rewritten.
//!
//! 27. **"B"/"NY"/"OO" Restrictions: Baltimore and the Brown Tier.** A
//!     follow-up request asked for three things #26 didn't cover: (a)
//!     Baltimore, not just Boston, carries the "B" label in real 1830 --
//!     standard, widely-documented 1830 tile convention: "B" names a
//!     *label* shared by two hexes, not a single hex, the same way "OO"
//!     already names four -- (b) the "B" and "NY" restrictions extend to
//!     the BROWN tier too, not just Green, mirroring how real 1830 gates
//!     each labeled hex's Brown upgrade to its own dedicated tile, distinct
//!     from the Green one, and (c) the four OO hexes' Brown upgrade is
//!     ALSO label-restricted, to any one of five distinct double-city Brown
//!     tile artworks (real 1830 uses more than one Brown OO layout across
//!     the four hexes' actual upgrade paths).
//!
//!     VERIFICATION STATUS -- stated plainly rather than silently asserted:
//!     this session's own attempts to re-confirm Baltimore's "B" label and
//!     the specific real-1830 tray numbers below against `tobymao/18xx`'s
//!     `g_1830/map.rb` (the same source #26 cites for Boston/New York/OO)
//!     returned internally inconsistent hex-to-label results across
//!     separate fetches, and a follow-up fetch of that repo's `TILES.md`
//!     confirmed it does not enumerate specific tile numbers at all (it is
//!     a cross-game tile-*shape* glossary, not a per-game manifest), nor
//!     does `g_1830/game.rb` define a `TILES` quantity hash of its own.
//!     Baltimore carrying "B" alongside Boston matches ordinary,
//!     widely-known 1830 rules-reference material and the request's own
//!     explicit wording, so it's implemented as such -- but unlike #26's
//!     Boston/New York/OO sourcing (each independently confirmed against a
//!     primary source during this session), it is NOT re-confirmed against
//!     a primary source this pass. The specific real-1830 tray numbers the
//!     request supplied -- Green "B" #55, Green "NY" #57, Green "OO" #59
//!     (this one WAS independently confirmed, module doc comment #18/tile
//!     15's own comment), Brown "B" #61, Brown "NY" #62, and Brown "OO"
//!     #64-#68 -- are recorded ONLY as inline `TILE_CATALOG` comments citing
//!     "per request, not independently re-verified this pass," never as a
//!     confirmed/sourced fact the way tile 15's #59 citation is. As module
//!     doc comment #2 already establishes, none of this matters for the
//!     engine's own on-chain enforcement either way: `TILE_CATALOG`'s
//!     `tile_id` values are this codebase's own synthetic, sequential
//!     catalog IDs, never the literal 1830 tray number, so an unverified
//!     real-world number never leaks into contract logic -- it only ever
//!     appears in a comment.
//!
//!     Mechanically, both extensions reuse #26's existing terrain variants
//!     rather than inventing new ones, since neither the City Reservation
//!     match logic nor `terrain_base_value` cares which specific `tile_id`
//!     backs a `TerrainType::BostonHub`/`NewYorkHub`/`DoubleCityHub` entry --
//!     only the terrain tag itself:
//!     - Baltimore: added to the same landmark check Boston already used,
//!       via a new `is_b_label_hex` helper (`landmark == Some("Boston") ||
//!       landmark == Some("Baltimore")`) -- `TerrainType::BostonHub` is now
//!       legal at either hex's Green-or-Brown upgrade, and illegal
//!       everywhere else, exactly as #26 already enforced for Boston alone.
//!       The Rust identifier `BostonHub` is unchanged (see its own doc
//!       comment in `state.rs` for why a rename wasn't worth the diff), but
//!       `HexMapError::BostonHexRequiresBostonHubTile`/
//!       `BostonHubTileMustBeOnBostonHex` -- whose ERROR MESSAGES hardcoded
//!       the word "Boston" -- are renamed to `BHexRequiresBHubTile`/
//!       `BHubTileMustBeOnBHex` and now carry their own `b_hex_name` field
//!       (mirroring `OOHexRequiresDoubleCityHubTile`'s existing
//!       `oo_hex_name` pattern) so the message correctly names whichever of
//!       the two hexes was actually involved.
//!     - Brown tier: the Boston/New York branches' `new_color ==
//!       TileColor::Green` guard widens to `new_color == TileColor::Green
//!       || new_color == TileColor::Brown` in both `execute_lay_tile` and
//!       `legal_tile_placements`; three new Brown `TILE_CATALOG` entries
//!       (tile 18 `BostonHub`, tile 19 `NewYorkHub`) plus five new Brown
//!       `DoubleCityHub` entries (tiles 20-24, one per real tray number
//!       #64-#68 per the request) give the widened branches something
//!       legal to match against. The OO branch's own condition (`terrain ==
//!       DoubleCityHub`) was already tier-agnostic -- it needed no logic
//!       change at all, only the five new catalog rows, to accept Brown OO
//!       upgrades; this mirrors #18's own precedent of the terrain check
//!       being the single source of truth, unaware of how many distinct
//!       tile artworks share it.
//!     - `terrain_base_value` needs no Brown-specific entries: it already
//!       keys off `TerrainType`, not `TileColor` + `TerrainType`, so the
//!       existing `BostonHub => 20`/`NewYorkHub => 40`/`DoubleCityHub => 40`
//!       flat buckets apply automatically to the new Brown tiles too, same
//!       "not live payout math" reasoning as #26.
//!     - `execute_place_station_token`'s tokenable-city check already
//!       included `BostonHub`/`NewYorkHub`/`DoubleCityHub` in its `matches!`
//!       (added preemptively by #26/#18) -- no change needed there.
//!
//!     Frontend: this pass ALSO reverses two of #47's own decisions
//!     (`HexGridRenderer.tsx` design note #47) -- restriction badges are no
//!     longer hidden once a hex is tiled, and no longer draw a dark
//!     background pill. See that file's design note #49 for the full
//!     reasoning; #47 is left in place, not deleted, per this module's own
//!     established convention (see e.g. #17 superseding #11's revenue
//!     figure, #21 backporting #18's correction, #25's "UPDATED by" markers
//!     elsewhere in this file).
//!
//! 28. **Real Tile Data Correction & Yellow-Tier "B"/"NY" Restriction.**
//!     #27's own VERIFICATION STATUS paragraph flagged its real-1830 tray
//!     numbers and every Green/Brown "B"/"NY"/"OO" `TILE_CATALOG` entry's
//!     `0b11_1111` (all-six-edges) connection bitmask as unverified
//!     placeholders. Both are now independently confirmed against
//!     `tobymao/18xx`'s `lib/engine/config/tile.rb` (the actual per-tile
//!     manifest, not the `TILES.md` glossary #27 found insufficient) and
//!     `lib/engine/game/g_1830/map.rb` (the board's own preprinted-hex
//!     definitions), fetched twice independently for cross-check:
//!
//!     - Tray numbers CORRECTED: Green "B" is real tile #53, NOT #55 as #27
//!       recorded (#55 is an unrelated plain double-town tile carrying no
//!       "B" label at all); Green "NY" is real tile #54, NOT #57 (#57 is an
//!       unrelated generic unlabeled green city tile used all over the
//!       board). Green "OO" #59, Brown "B" #61, Brown "NY" #62, and Brown
//!       "OO" #64-#68 were already correct.
//!     - Every one of those seven `TILE_CATALOG` entries' `0b11_1111`
//!       placeholder is REPLACED with the real tile's own edge pattern (2-4
//!       live edges out of 6, never all six) -- see each entry's own
//!       updated comment in `TILE_CATALOG` for the exact source string and
//!       edge list. `HexGridRenderer.tsx`'s own design note #52 mirrors
//!       these same corrected values.
//!     - New finding, NOT covered by the original request: Boston (E23),
//!       Baltimore (I15), and New York (G19) are each a corporation's own
//!       home station (B&M, B&O, NYNH) in real 1830, and NEVER take a plain
//!       Yellow tile at all -- their first real lay is straight to their
//!       own dedicated Green tile. The OLD `is_b_label_hex(landmark) &&
//!       is_upgradeable_tier` / `landmark == Some("New York") &&
//!       is_upgradeable_tier` guards in both `execute_lay_tile` and
//!       `legal_tile_placements` let the Yellow-tier `MajorCityHub` tile
//!       (tile_id 10) slip through to these three hexes via the generic
//!       landmark fallback, since the guard only ever fired at Green/Brown.
//!       `&& is_upgradeable_tier` is REMOVED from both branches in both
//!       functions -- the "B"/"NY" restriction now applies at every tier,
//!       matching real 1830, and a Yellow attempt at any of these three
//!       hexes is now rejected with the same `BHexRequiresBHubTile`/
//!       `NewYorkHexRequiresNewYorkHubTile` errors the Green/Brown case
//!       already used. OO hexes needed no equivalent fix -- there was never
//!       a Yellow `DoubleCityHub` `TILE_CATALOG` entry for `city_ok` to
//!       admit in the first place, so Yellow lays were already illegal
//!       there.
//!
//!     SAFETY CHECK, since this genuinely changes what's legal at three
//!     home-station hexes and this session cannot run `cargo test`: a
//!     corporation's very first `LayTile` call ever (at its home hex or
//!     anywhere else) is unconditionally legal regarding connectivity --
//!     `station.is_none()` in both `station_reachable_hexes`'s and
//!     `station_token_reachable_hexes`'s callers checks whether
//!     `PROTOCOL_NETWORK_HEXES` is still empty, which it is until a tile is
//!     actually laid (`grant_home_station_token` writes only to the
//!     SEPARATE `PROTOCOL_STATION_HEXES` registry, "deliberately never
//!     touching `PROTOCOL_NETWORK_HEXES`" per its own doc comment -- module
//!     doc comment #23). So this change does not strand a freshly-floated
//!     B&M/B&O/NYNH: its first tile at its home hex is still unconditionally
//!     legal at any orientation, it's just now required to be the
//!     hex-appropriate Green tile (16/18 for B, 17/19 for NY) rather than
//!     the generic Yellow hub -- which in turn requires the room's Green
//!     era to already be unlocked by the time that corporation floats and
//!     lays its first tile. If a room's Green era unlocks well after these
//!     corporations typically float, they would have zero legal tile
//!     options at their home hex until then (no track upgrade there, though
//!     `effective_connections_at`'s existing permissive-untiled-neighbor
//!     fallback still lets a network extend outward FROM an untiled home
//!     hex) -- a real, disclosed behavior change from before this pass, not
//!     silently absorbed. `tests.rs` updates the six affected tests
//!     (`lay_tile_enforces_landmark_reservation`,
//!     `lay_tile_enforces_boston_b_label_restriction`,
//!     `lay_tile_enforces_baltimore_b_label_restriction`,
//!     `lay_tile_enforces_b_label_restriction_brown_tier`,
//!     `lay_tile_enforces_new_york_ny_label_restriction`,
//!     `lay_tile_enforces_new_york_ny_label_restriction_brown_tier`, plus
//!     `query_map_grid_and_markdown_reflect_laid_tiles_and_landmarks`) to
//!     match, but could not be run against `cargo test` in this session (no
//!     `Cargo.toml` present) -- only checked for brace/paren balance and
//!     reasoned through by hand against the exact code paths above.

//! 29. **The full 46-tile 1830 manifest + hex-based terrain fees (Audit
//!     G-5 final phase and G-10).** `TILE_CATALOG` now holds the complete
//!     physical 1830 tile set -- all 46 distinct tile artworks, 85 physical
//!     copies in total -- keyed by their REAL printed tray numbers (#1-#70,
//!     with the gaps the real game has). It previously held 21 entries
//!     under an internal, invented numbering that collided with real tray
//!     numbers while meaning something different, so `GetLegalTilePlacements`
//!     handed a player "tile 16" when the physical game calls that tile #53.
//!
//!     Every tile id, quantity, edge mask, colour tier and label was taken
//!     from `tobymao/18xx`'s `g_1830/map.rb` (the `TILES` quantity hash) and
//!     `lib/engine/config/tile.rb` (per-tile `path=`/`city=`/`town=`/`label=`
//!     data). The 85-copy total independently corroborates the "85 hex
//!     tiles" figure printed on the physical game's own component list.
//!
//!     **Five invented tiles are deleted**, not renumbered: the old 4/5
//!     ("river crossing"/"mountain pass"), 12 (green mountain), 11 (green
//!     straight track, a shape 1830 has no green tile for), and 13 (an
//!     all-six-edges green city matching neither real #14 nor #15). The
//!     first three existed only to carry a terrain build cost on the tile,
//!     which was the G-10 bug: because the fee rode on the ARTWORK rather
//!     than the HEX, laying an ordinary plain tile onto a genuine river or
//!     mountain hex was completely free, while laying "mountain pass" onto
//!     flat grassland charged $80 for nothing. `RIVER_HEXES`/
//!     `MOUNTAIN_HEXES`/`terrain_build_fee` now model terrain the way the
//!     physical board does, and `execute_lay_tile` charges from the hex.
//!
//!     `TerrainType::MountainRugged` survives as an enum variant with no
//!     tile carrying it -- see `terrain_base_value`'s own note for why it
//!     wasn't removed. `TILE_CATALOG`'s `cost` field survives too, now
//!     uniformly `0`: the tuple shape is load-bearing for `query.rs`'s
//!     map renderer, and a per-tile price may return for a future variant.

//! 30. **Edge-to-Edge Tile Geometry (Audit G-9).** `TILE_CATALOG` gains a
//!     seventh field: each tile's real internal wiring, as a list of
//!     edge-to-edge track segments, for all 46 entries. #29 above brought in
//!     the correct tile IDs, quantities and EDGE MASKS from the same
//!     `lib/engine/config/tile.rb` data, but stopped at the mask -- "edges 0,
//!     1, 3 and 4 all carry track" -- which is not enough to route on. Real
//!     tile #1 is two INDEPENDENT towns, one joining edges 1 and 3 and the
//!     other joining 0 and 4; a mask cannot distinguish that from a
//!     four-way junction, so `pathfinding.rs` let trains enter on edge 0 and
//!     leave on edge 3, across track that does not exist. The `path=` data
//!     #29 already cited, but only used for edge masks, is now transcribed
//!     in full -- see `TILE_CATALOG`'s own doc comment for the encoding
//!     (including the `(a, a)` terminal spur, which real 1830's yellow "OO"
//!     tile #59 needs and a mask cannot express at all), the decoding rules,
//!     and the per-entry source strings.
//!
//!     **Nothing about tile LAYING changed.** The mask field is retained and
//!     is still the only thing `execute_lay_tile`/`legal_tile_placements`/
//!     `impassable_edge_mask` consult, still what `state::Tile::connections`
//!     stores, and still what the frontend renderer reads. All 46 derived
//!     masks were checked against the pre-G-9 hand-entered ones and every
//!     single one agreed, so this pass altered no tile's edge set and
//!     therefore no placement's legality. `tile_base_connections` re-derives
//!     the mask from the paths so the test suite can hold the two in
//!     lockstep permanently.
//!
//!     Also added here, for `pathfinding.rs`'s repointed rival-blockade
//!     rule: `tile_city_slots`/`preprinted_city_slots`, how many Station
//!     Token slots a city offers (from the same manifest's `slots:` counts),
//!     which is what decides whether a rival-tokened city still has an open
//!     slot for a route to pass through.
//!
//!     VERIFICATION CAVEAT, same as #28's: this session had no Rust
//!     toolchain available (`cargo` is not installed and the sandbox cannot
//!     reach crates.io or the Ubuntu archive), so `cargo check`/`cargo test`
//!     could not be run. The 46-entry path table was generated and
//!     cross-checked programmatically against both the upstream manifest
//!     and the existing masks (zero mismatches), the traversal's semantics
//!     were validated against a faithful model of the algorithm over 400
//!     randomized boards (no determinism, segment-reuse, stop-cap or
//!     minimum-route violations), and the Rust itself was brace-balanced and
//!     reviewed by hand against every call site.

use cosmwasm_std::{DepsMut, Env, MessageInfo, Response, StdError, StdResult, Storage, Uint128};
use std::collections::{HashSet, VecDeque};
use thiserror::Error;

use crate::or_phase;
use crate::public_company::CORE_PUBLIC_COMPANIES;
use crate::state::{
    GameSession, OperatingSubPhase, PrivateCompany, PublicCompany, TerrainType, Tile, TileColor,
    HEX_STATION_TOKENS,
    MAP_GRID, PRIVATE_COMPANIES, PROTOCOL_LAST_TOKEN_SUBROUND, PROTOCOL_NETWORK_HEXES,
    PROTOCOL_PRESIDENT, PROTOCOL_STATION_HEXES, PUBLIC_COMPANIES, REMAINING_TILES, SESSIONS,
};

/// The fixed set of layable tile artworks: `(tile_id, base connection
/// bitmask over edges 0-5, terrain cost in VGP to lay it, terrain
/// classification for revenue purposes, `TileColor` era tier)`. See module
/// doc comment #2 for why the `tile_id` numbers themselves are this
/// engine's own catalog IDs rather than a literal 1830 tile-tray number,
/// #6 for how the terrain *classification* drives revenue *value* via
/// `terrain_base_value`, #8 for the color tier's era-lock, and #11 for why
/// every `MajorCityHub` entry is landmark-reserved.
/// Sentinel `quantity` marking a `TILE_CATALOG` entry as exempt from the
/// Tile Inventory Supply Engine (Audit G-5): never decremented when laid,
/// never incremented when recycled off the board, and never reported as
/// depleted by `legal_tile_placements`.
///
/// Carried by exactly the entries that have no real 1830 tray tile to be
/// faithful to -- the invented River/Mountain artwork (tiles 4, 5, 12; real
/// 1830 charges terrain as a HEX property, not a tile, per audit gap G-10),
/// the invented green straight-track tile 11, and the all-six-edges green
/// city tile 13 (real 1830's green city tiles are #14 at 3 copies and #15
/// at 2, neither of which matches this entry's geometry, so its mapping is
/// genuinely ambiguous). Assigning those five a made-up count would be
/// inventing a second layer of fake data on top of already-invented tiles;
/// they are instead left unlimited until the catalog is expanded to the
/// full 46-entry 1830 manifest and the G-10 terrain overhaul removes them.
///
/// Every OTHER entry carries its real, physically-printed 1830 tray count.
pub const UNLIMITED_TILE_SUPPLY: u32 = u32::MAX;

/// `(tile_id, base connection bitmask, terrain cost in VGP, terrain
/// classification, colour tier, starting tray quantity, base edge-to-edge
/// paths)`.
///
/// The sixth field (Audit G-5) is how many physical copies of this artwork
/// a room starts with -- see `seed_tile_inventory`,
/// `state::REMAINING_TILES`, and `UNLIMITED_TILE_SUPPLY` just above.
///
/// **The seventh field is Audit G-9 (Edge-to-Edge Routing).** The flat
/// second field records only WHICH of the six edges carry a track stub; it
/// says nothing about how those stubs pair up into actual routed track
/// inside the tile. `pathfinding.rs` used to walk that mask alone, so on
/// tile #1 -- two INDEPENDENT towns, one joining edges 1 and 3, the other
/// joining edges 0 and 4 -- a train could legally enter on edge 0 and leave
/// on edge 3, crossing between two track segments that never touch. The
/// seventh field is that tile's real internal wiring:
///
/// - `(a, b)`, `a != b` -- a THROUGH segment joining edges `a` and `b`,
///   traversable in either direction. If the tile is a revenue centre, its
///   city/town sits on this segment and is stopped at in passing.
/// - `(a, a)` -- a TERMINAL SPUR from edge `a` into an interior revenue
///   centre with no second exit. A train may enter and END its route there;
///   it may never pass through. Carried by exactly one catalog entry, the
///   yellow "OO" tile #59, whose two cities are genuinely separate stubs.
///
/// Every pair is listed once, in `(min, max)` order, edges ascending --
/// `pathfinding.rs` normalizes the same way before consulting its
/// claimed-segment ledger, so a segment claimed while travelling `a -> b`
/// is the same ledger entry as one claimed travelling `b -> a`.
///
/// **Sourcing.** Every entry's path list is transcribed from the real 1830
/// tile manifest -- `tobymao/18xx`'s `lib/engine/config/tile.rb`, whose
/// exact source string for that tile is quoted verbatim in the comment
/// above each entry -- decoded by the rule that `path=a:X,b:_N` +
/// `path=a:_N,b:Y` is a through segment `X-Y` via revenue centre `N`, that
/// a revenue centre with `k >= 2` spokes yields all `k*(k-1)/2` pairings of
/// those spokes (a city is one node: any spoke reaches any other), and that
/// a revenue centre with exactly one spoke yields a terminal spur.
///
/// **Invariant.** The second field is exactly the union of the seventh
/// field's edges: `connections == tile_base_connections(tile_id)`. It is
/// retained rather than deleted because it -- not the path list -- is what
/// `execute_lay_tile`/`legal_tile_placements` match adjacent tiles with,
/// what `impassable_edge_mask` is ANDed against, and what the frontend
/// renderer reads back to draw track. All 46 entries were cross-checked
/// against the pre-G-9 hand-entered masks and every one agreed, so this
/// pass changed no tile's edge set and therefore no tile's LAY legality;
/// `tile_paths_and_connections_agree_for_every_catalog_entry` in `tests.rs`
/// pins the invariant going forward.
///
/// **Edge numbering.** Absolute edge indices follow this engine's own
/// `HEX_NEIGHBOR_OFFSETS` convention, which is a mirror of `tobymao/18xx`'s
/// (their edge `e` is this engine's `(4 - e) mod 6` -- derivable from the
/// `IMPASSABLE_HEX_EDGES` borders, which were converted geometrically from
/// the same `g_1830/map.rb`). For a freely-rotatable tray tile that is
/// immaterial: reflection maps the tile set onto itself, exchanging only
/// the mirror-image pairs #23/#24 and #45/#46, each of which is present in
/// identical quantity, so the tray a room can actually lay is unchanged.
/// The numbering is kept as-is deliberately -- it is what the pre-G-9
/// masks, the tests, and the frontend's own catalog mirror all already use.
///
/// Audit G-11 added the EIGHTH element: `Option<u32>`, this tile's own
/// printed revenue, or `None` to fall back to the flat
/// `terrain_base_value` bucket for its `TerrainType`. See `tile_base_value`,
/// which is the single site that resolves the two.
///
/// (Stated here rather than inline on the element: a tuple's fields cannot
/// carry `///` doc comments -- only a struct's can -- and attaching one
/// inside the type is a hard compile error, `expected type, found doc
/// comment`. Ordinary `//` comments are legal there, but a reader looking
/// for what field 8 means will look at the constant, so it lives here.)
pub const TILE_CATALOG: &[(
    u32,
    u8,
    u128,
    TerrainType,
    TileColor,
    u32,
    &[(u8, u8)],
    Option<u32>,
)] = &[
    // ---- Yellow tier: legal from every room's genesis. ----
    // #1 x1 -- two towns, edges 0/1/3/4.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:1,b:_0;path=a:_0,b:3;path=a:0,b:_1;path=a:_1,b:4`
    (1, 0b01_1011, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 4), (1, 3)], Some(10)),
    // #2 x1 -- two towns, edges 0/1/2/3.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:0,b:_0;path=a:_0,b:3;path=a:1,b:_1;path=a:_1,b:2`
    (2, 0b00_1111, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 3), (1, 2)], Some(10)),
    // #3 x2 -- single town, sharp curve.
    // 18xx: `town=revenue:10;path=a:0,b:_0;path=a:_0,b:1`
    (3, 0b00_0011, 0, TerrainType::SmallTown, TileColor::Yellow, 2, &[(0, 1)], Some(10)),
    // #4 x2 -- single town, straight.
    // 18xx: `town=revenue:10;path=a:0,b:_0;path=a:_0,b:3`
    (4, 0b00_1001, 0, TerrainType::SmallTown, TileColor::Yellow, 2, &[(0, 3)], Some(10)),
    // #7 x4 -- plain sharp curve.
    // 18xx: `path=a:0,b:1`
    (7, 0b00_0011, 0, TerrainType::Plain, TileColor::Yellow, 4, &[(0, 1)], None),
    // #8 x8 -- plain gentle curve -- the most common tile in the game.
    // 18xx: `path=a:0,b:2`
    (8, 0b00_0101, 0, TerrainType::Plain, TileColor::Yellow, 8, &[(0, 2)], None),
    // #9 x7 -- plain straight.
    // 18xx: `path=a:0,b:3`
    (9, 0b00_1001, 0, TerrainType::Plain, TileColor::Yellow, 7, &[(0, 3)], None),
    // #55 x1 -- two towns, edges 0/1/3/4.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:0,b:_0;path=a:_0,b:3;path=a:1,b:_1;path=a:_1,b:4`
    (55, 0b01_1011, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 3), (1, 4)], Some(10)),
    // #56 x1 -- two towns, edges 0/1/2/3.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:0,b:_0;path=a:_0,b:2;path=a:1,b:_1;path=a:_1,b:3`
    (56, 0b00_1111, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 2), (1, 3)], Some(10)),
    // #57 x4 -- THE yellow city tile -- every plain-city hex starts here.
    // 18xx: `city=revenue:20;path=a:0,b:_0;path=a:_0,b:3`
    (57, 0b00_1001, 0, TerrainType::MajorCityHub, TileColor::Yellow, 4, &[(0, 3)], Some(20)),
    // #58 x2 -- single town, gentle curve.
    // 18xx: `town=revenue:10;path=a:0,b:_0;path=a:_0,b:2`
    (58, 0b00_0101, 0, TerrainType::SmallTown, TileColor::Yellow, 2, &[(0, 2)], Some(10)),
    // #69 x1 -- two towns, edges 0/2/3/4.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:0,b:_0;path=a:_0,b:3;path=a:2,b:_1;path=a:_1,b:4`
    (69, 0b01_1101, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 3), (2, 4)], Some(10)),

    // ---- Green tier: unlocked by the room's first 3-train. ----
    // #14 x3 -- green city, edges 0/1/3/4.
    // 18xx: `city=revenue:30,slots:2;path=a:0,b:_0;path=a:1,b:_0;path=a:3,b:_0;path=a:4,b:_0`
    (14, 0b01_1011, 0, TerrainType::MajorCityHub, TileColor::Green, 3, &[
        (0, 1), (0, 3), (0, 4), (1, 3), (1, 4), (3, 4)
    ], Some(30)),
    // #15 x2 -- green city, edges 0/1/2/3.
    // 18xx: `city=revenue:30,slots:2;path=a:0,b:_0;path=a:1,b:_0;path=a:2,b:_0;path=a:3,b:_0`
    (15, 0b00_1111, 0, TerrainType::MajorCityHub, TileColor::Green, 2, &[
        (0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)
    ], Some(30)),
    // #16 x1 -- plain, edges 0/1/2/3.
    // 18xx: `path=a:0,b:2;path=a:1,b:3`
    (16, 0b00_1111, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 2), (1, 3)], None),
    // #18 x1 -- plain, edges 0/1/2/3.
    // 18xx: `path=a:0,b:3;path=a:1,b:2`
    (18, 0b00_1111, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 3), (1, 2)], None),
    // #19 x1 -- plain, edges 0/2/3/4.
    // 18xx: `path=a:0,b:3;path=a:2,b:4`
    (19, 0b01_1101, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 3), (2, 4)], None),
    // #20 x1 -- plain, edges 0/1/3/4.
    // 18xx: `path=a:0,b:3;path=a:1,b:4`
    (20, 0b01_1011, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 3), (1, 4)], None),
    // #23 x3 -- plain, edges 0/3/4.
    // 18xx: `path=a:0,b:3;path=a:0,b:4`
    (23, 0b01_1001, 0, TerrainType::Plain, TileColor::Green, 3, &[(0, 3), (0, 4)], None),
    // #24 x3 -- plain, edges 0/2/3.
    // 18xx: `path=a:0,b:3;path=a:0,b:2`
    (24, 0b00_1101, 0, TerrainType::Plain, TileColor::Green, 3, &[(0, 2), (0, 3)], None),
    // #25 x1 -- plain, edges 0/2/4.
    // 18xx: `path=a:0,b:2;path=a:0,b:4`
    (25, 0b01_0101, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 2), (0, 4)], None),
    // #26 x1 -- plain, edges 0/3/5.
    // 18xx: `path=a:0,b:3;path=a:0,b:5`
    (26, 0b10_1001, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 3), (0, 5)], None),
    // #27 x1 -- plain, edges 0/1/3.
    // 18xx: `path=a:0,b:3;path=a:0,b:1`
    (27, 0b00_1011, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 1), (0, 3)], None),
    // #28 x1 -- plain, edges 0/4/5.
    // 18xx: `path=a:0,b:4;path=a:0,b:5`
    (28, 0b11_0001, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 4), (0, 5)], None),
    // #29 x1 -- plain, edges 0/1/2.
    // 18xx: `path=a:0,b:2;path=a:0,b:1`
    (29, 0b00_0111, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 1), (0, 2)], None),
    // #53 x2 -- "B" label -- Boston AND Baltimore, edges 0/2/4.
    // 18xx: `city=revenue:50;path=a:0,b:_0;path=a:2,b:_0;path=a:4,b:_0;label=B`
    (53, 0b01_0101, 0, TerrainType::BostonHub, TileColor::Green, 2, &[(0, 2), (0, 4), (2, 4)], Some(50)),
    // #54 x1 -- "NY" label -- two cities, edges 0/1/2/3.
    // 18xx: `city=revenue:60,loc:0.5;city=revenue:60,loc:2.5;path=a:0,b:_0;path=a:_0,b:1;path=a:2,b:_1;path=a:_1,b:3;label=NY`
    (54, 0b00_1111, 0, TerrainType::NewYorkHub, TileColor::Green, 1, &[(0, 1), (2, 3)], Some(60)),
    // #59 x2 -- "OO" label -- two cities, edges 0/2.
    // 18xx: `city=revenue:40;city=revenue:40;path=a:0,b:_0;path=a:2,b:_1;label=OO`
    // NOTE: 0>stop 2>stop -- `e>stop` is a terminal spur (enter and stop, never pass through).
    (59, 0b00_0101, 0, TerrainType::DoubleCityHub, TileColor::Green, 2, &[(0, 0), (2, 2)], Some(40)),

    // ---- Brown tier: unlocked by the room's first 5-train. ----
    // #39 x1 -- plain, edges 0/1/2.
    // 18xx: `path=a:0,b:2;path=a:0,b:1;path=a:1,b:2`
    (39, 0b00_0111, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 1), (0, 2), (1, 2)], None),
    // #40 x1 -- plain, edges 0/2/4.
    // 18xx: `path=a:0,b:2;path=a:2,b:4;path=a:0,b:4`
    (40, 0b01_0101, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 2), (0, 4), (2, 4)], None),
    // #41 x2 -- plain, edges 0/1/3.
    // 18xx: `path=a:0,b:3;path=a:0,b:1;path=a:1,b:3`
    (41, 0b00_1011, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 1), (0, 3), (1, 3)], None),
    // #42 x2 -- plain, edges 0/3/5.
    // 18xx: `path=a:0,b:3;path=a:3,b:5;path=a:0,b:5`
    (42, 0b10_1001, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 3), (0, 5), (3, 5)], None),
    // #43 x2 -- plain, edges 0/1/2/3.
    // 18xx: `path=a:0,b:3;path=a:0,b:2;path=a:1,b:3;path=a:1,b:2`
    (43, 0b00_1111, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 2), (0, 3), (1, 2), (1, 3)], None),
    // #44 x1 -- plain, edges 0/1/3/4.
    // 18xx: `path=a:0,b:3;path=a:1,b:4;path=a:0,b:1;path=a:3,b:4`
    (44, 0b01_1011, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 1), (0, 3), (1, 4), (3, 4)], None),
    // #45 x2 -- plain, edges 0/2/3/4.
    // 18xx: `path=a:0,b:3;path=a:2,b:4;path=a:0,b:4;path=a:2,b:3`
    (45, 0b01_1101, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 3), (0, 4), (2, 3), (2, 4)], None),
    // #46 x2 -- plain, edges 0/2/3/4.
    // 18xx: `path=a:0,b:3;path=a:2,b:4;path=a:3,b:4;path=a:0,b:2`
    (46, 0b01_1101, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 2), (0, 3), (2, 4), (3, 4)], None),
    // #47 x1 -- plain, edges 0/1/3/4.
    // 18xx: `path=a:0,b:3;path=a:1,b:4;path=a:1,b:3;path=a:0,b:4`
    (47, 0b01_1011, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 3), (0, 4), (1, 3), (1, 4)], None),
    // #61 x2 -- "B" label -- Boston AND Baltimore, edges 0/2/3/4.
    // 18xx: `city=revenue:60;path=a:0,b:_0;path=a:2,b:_0;path=a:3,b:_0;path=a:4,b:_0;label=B`
    (61, 0b01_1101, 0, TerrainType::BostonHub, TileColor::Brown, 2, &[
        (0, 2), (0, 3), (0, 4), (2, 3), (2, 4), (3, 4)
    ], Some(60)),
    // #62 x1 -- "NY" label -- two cities, edges 0/1/2/3.
    // 18xx: `city=revenue:80,slots:2;city=revenue:80,slots:2;path=a:0,b:_0;path=a:_0,b:1;path=a:2,b:_1;path=a:_1,b:3;label=NY`
    (62, 0b00_1111, 0, TerrainType::NewYorkHub, TileColor::Brown, 1, &[(0, 1), (2, 3)], Some(90)),
    // #63 x3 -- brown city, all six edges.
    // 18xx: `city=revenue:40,slots:2;path=a:0,b:_0;path=a:1,b:_0;path=a:2,b:_0;path=a:3,b:_0;path=a:4,b:_0;path=a:5,b:_0`
    (63, 0b11_1111, 0, TerrainType::MajorCityHub, TileColor::Brown, 3, &[
        (0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (1, 2), (1, 3), (1, 4), (1, 5), (2, 3), (2, 4),
        (2, 5), (3, 4), (3, 5), (4, 5)
    ], Some(40)),
    // #64 x1 -- "OO" label, edges 0/2/3/4.
    // 18xx: `city=revenue:50;city=revenue:50,loc:3.5;path=a:0,b:_0;path=a:_0,b:2;path=a:3,b:_1;path=a:_1,b:4;label=OO`
    (64, 0b01_1101, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 2), (3, 4)], Some(50)),
    // #65 x1 -- "OO" label, edges 0/2/3/4.
    // 18xx: `city=revenue:50;city=revenue:50,loc:2.5;path=a:0,b:_0;path=a:_0,b:4;path=a:2,b:_1;path=a:_1,b:3;label=OO`
    (65, 0b01_1101, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 4), (2, 3)], Some(50)),
    // #66 x1 -- "OO" label, edges 0/1/2/3.
    // 18xx: `city=revenue:50;city=revenue:50,loc:1.5;path=a:0,b:_0;path=a:_0,b:3;path=a:1,b:_1;path=a:_1,b:2;label=OO`
    (66, 0b00_1111, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 3), (1, 2)], Some(50)),
    // #67 x1 -- "OO" label, edges 0/2/3/4.
    // 18xx: `city=revenue:50;city=revenue:50;path=a:0,b:_0;path=a:_0,b:3;path=a:2,b:_1;path=a:_1,b:4;label=OO`
    (67, 0b01_1101, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 3), (2, 4)], Some(50)),
    // #68 x1 -- "OO" label, edges 0/1/3/4.
    // 18xx: `city=revenue:50;city=revenue:50;path=a:0,b:_0;path=a:_0,b:3;path=a:1,b:_1;path=a:_1,b:4;label=OO`
    (68, 0b01_1011, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 3), (1, 4)], Some(50)),
    // #70 x1 -- plain, edges 0/1/2/3.
    // 18xx: `path=a:0,b:1;path=a:0,b:2;path=a:1,b:3;path=a:2,b:3`
    (70, 0b00_1111, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 1), (0, 2), (1, 3), (2, 3)], None),
];

/// Fixed axial coordinates of 1830's three core major-destination cities --
/// New York, Boston, and Baltimore -- reserved exclusively for their
/// designated `TerrainType::MajorCityHub` artwork. See module doc comment
/// #11 (Landmark Reservation).
///
/// These are the *verified real* 1830 board coordinates (New York = G19,
/// Boston = E23, Baltimore = I15 on the physical board's row-letter/
/// column-number labeling), converted into this engine's axial system via
/// `r = row_letter_index (A=0..K=10)`, `q = (column_number - 1 - r) / 2` --
/// kept in lockstep with `frontend/src/components/HexGridRenderer.tsx`'s own
/// `LANDMARK_HEXES` constant, which uses the identical coordinates and cites
/// the same sources (the official Lookout Games rulebook and the
/// open-source 18xx.games engine's `g_1830/map.rb`). This supersedes the
/// earlier illustrative placeholder values `(10, 0)`/`(12, -3)`/`(8, 4)`
/// that predated the frontend's own fact-checking pass -- resolving the
/// cross-file consistency gap that pass had flagged.
pub const LANDMARK_HEXES: &[(&str, i32, i32)] =
    &[("New York", 6, 6), ("Boston", 9, 4), ("Baltimore", 3, 8)];

/// Returns the landmark name registered at `(q, r)`, or `None` if it's an
/// ordinary (non-reserved) hex.
pub fn landmark_name_at(q: i32, r: i32) -> Option<&'static str> {
    LANDMARK_HEXES
        .iter()
        .find(|(_, lq, lr)| *lq == q && *lr == r)
        .map(|(name, _, _)| *name)
}

/// True when `landmark` (as returned by `landmark_name_at`) is one of the
/// two real 1830 hexes printed with the "B" label -- Boston and Baltimore
/// (module doc comment #27, "B"/"NY"/"OO" Restrictions: Baltimore and the
/// Brown Tier). Centralizes the "which hexes does `TerrainType::BostonHub`
/// govern" question in one place so the City Reservation block in
/// `execute_lay_tile` and its mirror in `legal_tile_placements` can't drift
/// out of sync on the list.
fn is_b_label_hex(landmark: Option<&str>) -> bool {
    matches!(landmark, Some("Boston") | Some("Baltimore"))
}

/// Fixed axial coordinates of 1830's seven real red off-board revenue
/// terminals: Chicago (F2), Canadian West (A9 and A11 -- two distinct
/// hexes, both feeding the same named destination), Gulf (I1 and J2 --
/// likewise two hexes), Deep South (K13), and Maritime Provinces (B24).
/// Converted into axial coordinates by the identical transform
/// `LANDMARK_HEXES` uses, and kept in lockstep with the frontend's
/// `OFFBOARD_LABELS`/`STATIC_BOARD_HEXES` (`RedOffboard` entries) in
/// `HexGridRenderer.tsx`, which label the same seven hexes. See
/// `offboard_name_at`/`HexMapError::OffboardHexNotBuildable` for how these
/// are enforced as permanently unbuildable -- off-board hexes are printed
/// revenue destinations on the physical board, never track a Protocol lays
/// tile artwork onto.
pub const OFFBOARD_HEXES: &[(&str, i32, i32)] = &[
    ("Chicago", -2, 5),
    ("Canadian West", 4, 0),
    ("Canadian West", 5, 0),
    ("Gulf", -4, 8),
    ("Gulf", -4, 9),
    ("Deep South", 1, 10),
    ("Maritime Provinces", 11, 1),
];

/// Returns the off-board destination name registered at `(q, r)`, or `None`
/// if it's not one of the seven reserved off-board hexes.
pub fn offboard_name_at(q: i32, r: i32) -> Option<&'static str> {
    OFFBOARD_HEXES
        .iter()
        .find(|(_, oq, or_)| *oq == q && *or_ == r)
        .map(|(name, _, _)| *name)
}

/// Fixed axial coordinates of every hex bearing a preprinted CITY marker on
/// the real 1830 board -- module doc comment #16 (Rigid On-Chain Tile
/// Matching). Two groups, unified into one reservation list on the same
/// basis `TOWN_DESIGNATED_HEXES` already unifies its own two groups (see
/// that constant's doc comment): the reservation gate below cares only
/// about which tile TYPE is legal at a hex, not whether that hex also
/// happens to carry real preprinted track, so a hex belongs here whenever
/// the real board prints ANY city marker on it, tracked or not.
///
/// GRAY city hexes with real preprinted track (Lansing D2, Cleveland F6,
/// Altoona H12, Rochester D14, Richmond K15, Montreal A19).
///
/// Design note #34 (frontend `HexGridRenderer.tsx`) / this pass (backend):
/// eight ordinary WHITE city hexes with a bare city placeholder and no
/// printed track -- Toledo F4, Providence F22, Pittsburgh H10, Columbus H4,
/// Washington J14, Lancaster H16, Ottawa B16, Barrie B10 -- verbatim-sourced
/// (independently re-derived three separate times against the raw source
/// text) from `tobymao/18xx`'s `g_1830/map.rb` `HEXES` hash (white-section
/// plain `city=revenue:0` / `city` entries, no `path=` data). Two names in
/// the originating request for this addition did not match that source and
/// were corrected rather than applied as given: B16 is really Ottawa, not
/// "Barrington"; and F24 (already present below, unrelated to this addition)
/// is really Mansfield, not "River Falls" as that request separately asked
/// -- F24 was left unchanged. Kept in lockstep with the frontend's new
/// `BoardHex.cityDesignation` field in `HexGridRenderer.tsx`.
///
/// Design note #42 (frontend `HexGridRenderer.tsx`, Rail Map Overhaul): a
/// NINTH blank white city, Albany E19 (axial `(7, 4)`), added this pass --
/// same category as the eight above (re-verified directly against
/// `tobymao/18xx`'s `g_1830/map.rb` this pass: E19's real source entry is
/// the bare string `'city'`, no `revenue:` figure and no `path=` data,
/// identical shape to Toledo/Providence/etc.). This closes a genuine
/// frontend/backend gap: the frontend already rendered Albany as a
/// `cityDesignation` station circle, but this on-chain reservation list --
/// consulted by the City Reservation tile-legality gate (module doc comment
/// #16) so a real `MajorCityHub` tile can actually be laid there -- had no
/// matching entry, so a Protocol attempting to upgrade Albany would have
/// been illegally rejected. FACTUAL CORRECTION (historical -- see module
/// doc comment #25 for current behavior): a request introducing this entry
/// separately asked for Albany to carry NYC's home station token (implying
/// NYC's real home should move here) and a non-zero $20 starting value --
/// both rejected at the time as factually incorrect versus real 1830, where
/// NYC's home is G19 and Albany's real source entry (verified above) carries
/// no revenue figure at all, matching the flat `$0` every other blank city
/// here already gets from `terrain_base_value` -- not `$20`. That rejection
/// stood for two further repeats of the same request; on a third, explicit,
/// more specific repeat, module doc comment #25 supersedes it: NYC's home in
/// `CORPORATION_HOME_HEX` below IS now Albany E19, as a deliberate house
/// rule for this custom board, not a factual claim about the real game.
/// Albany's `$0` starting value is UNCHANGED by that move (see #25) -- the
/// value objection was about Albany's own printed revenue, which doesn't
/// depend on which corporation's home token happens to sit there.
///
/// Module doc comment #18 (OO Double-City Tile Catalog Enforcement) split
/// the four preprinted YELLOW "OO" double-city hexes (Detroit & Windsor,
/// Hamilton & Toronto, Dunkirk & Buffalo, Philadelphia & Trenton) OUT of
/// this list into their own `OO_DESIGNATED_HEXES` just below -- they're
/// still "every hex whose printed infrastructure includes a City" together
/// with `LANDMARK_HEXES` and `OO_DESIGNATED_HEXES` (see each list's own
/// `..._name_at` lookup), just no longer able to accept the same
/// `MajorCityHub` artwork this list's fourteen remaining entries require.
/// Kept in lockstep with the frontend's `GRAY_HEXES` (`marker: "city"`) in
/// `HexGridRenderer.tsx`.
pub const CITY_DESIGNATED_HEXES: &[(&str, i32, i32)] = &[
    ("Lansing", -1, 3),
    ("Cleveland", 0, 5),
    ("Altoona", 2, 7),
    ("Rochester", 5, 3),
    ("Richmond", 2, 10),
    ("Montreal", 9, 0),
    ("Toledo", -1, 5),
    ("Providence", 8, 5),
    ("Pittsburgh", 1, 7),
    ("Columbus", -2, 7),
    ("Washington", 2, 9),
    ("Lancaster", 4, 7),
    ("Ottawa", 7, 1),
    ("Barrie", 4, 1),
    ("Albany", 7, 4),
];

/// Returns the preprinted city-designation name registered at `(q, r)`, or
/// `None` if it's not one of `CITY_DESIGNATED_HEXES`. See module doc
/// comment #16. Does NOT match one of `OO_DESIGNATED_HEXES`' four
/// entries -- see that list's own `oo_designation_name_at` (module doc
/// comment #18).
pub fn city_designation_name_at(q: i32, r: i32) -> Option<&'static str> {
    CITY_DESIGNATED_HEXES
        .iter()
        .find(|(_, cq, cr)| *cq == q && *cr == r)
        .map(|(name, _, _)| *name)
}

/// Fixed axial coordinates of the four preprinted YELLOW "OO" double-city
/// hexes -- Detroit & Windsor (E5), Hamilton & Toronto (D10), Dunkirk &
/// Buffalo (E11), Philadelphia & Trenton (H18) -- split out of
/// `CITY_DESIGNATED_HEXES` by module doc comment #18 (OO Double-City Tile
/// Catalog Enforcement) into their own reserved list, exclusively requiring
/// `TerrainType::DoubleCityHub` artwork rather than the plain
/// `MajorCityHub` every other reserved City hex requires. Same real
/// coordinates as before the split (verbatim-sourced from `tobymao/18xx`'s
/// `g_1830/map.rb`, unchanged by this pass) -- kept in lockstep with the
/// frontend's `YELLOW_OO_HEXES` in `HexGridRenderer.tsx`.
pub const OO_DESIGNATED_HEXES: &[(&str, i32, i32)] = &[
    ("Detroit & Windsor", 0, 4),
    ("Hamilton & Toronto", 3, 3),
    ("Dunkirk & Buffalo", 3, 4),
    ("Philadelphia & Trenton", 5, 7),
];

/// Returns the preprinted OO double-city-designation name registered at
/// `(q, r)`, or `None` if it's not one of `OO_DESIGNATED_HEXES`' four
/// entries. See module doc comment #18.
pub fn oo_designation_name_at(q: i32, r: i32) -> Option<&'static str> {
    OO_DESIGNATED_HEXES
        .iter()
        .find(|(_, oq, or_)| *oq == q && *or_ == r)
        .map(|(name, _, _)| *name)
}

/// Station Tokens (module doc comment #23; superseded for NYC/NNH by module
/// doc comment #25): `(company_id, q, r, hex_label)` for all eight
/// `public_company::CORE_PUBLIC_COMPANIES`, each with a defined preprinted
/// home city on this custom board -- every `(q, r)` here is copied verbatim
/// from this same file's own `LANDMARK_HEXES`/`CITY_DESIGNATED_HEXES`/
/// `OO_DESIGNATED_HEXES` entries above, never a new coordinate. As of module
/// doc comment #25's house rule, NNH (company_id 7) is no longer absent --
/// it is assigned New York G19 (the hex NYC vacated), and NYC (company_id 2)
/// is reassigned to Albany E19. `corporation_home_hex` now returns `Some`
/// for every one of the eight corporations.
pub const CORPORATION_HOME_HEX: &[(u32, i32, i32, &str)] = &[
    (1, 2, 7, "H12"), // PRR -> Altoona
    (2, 7, 4, "E19"), // NYC -> Albany (house rule, module doc comment #25)
    (3, 9, 0, "A19"), // CPR -> Montreal
    (4, 3, 8, "I15"), // B&O -> Baltimore
    (5, 0, 5, "F6"),  // C&O -> Cleveland
    (6, 3, 4, "E11"), // ERIE -> Dunkirk & Buffalo (shared OO hex, see module doc comment #23)
    (7, 6, 6, "G19"), // NNH ("NYNH") -> New York (house rule, module doc comment #25)
    (8, 9, 4, "E23"), // B&M -> Boston
];

/// Returns `company_id`'s preprinted home hex. As of module doc comment
/// #25's house rule, every one of the eight `CORE_PUBLIC_COMPANIES` has an
/// assigned home, so this returns `Some` in all eight cases; `None` remains
/// possible only for an unrecognized `company_id`. See `CORPORATION_HOME_HEX`.
pub fn corporation_home_hex(company_id: u32) -> Option<(i32, i32, &'static str)> {
    CORPORATION_HOME_HEX
        .iter()
        .find(|(id, ..)| *id == company_id)
        .map(|(_, q, r, label)| (*q, *r, *label))
}

/// Station Tokens (module doc comment #23): each corporation's total token
/// count, home token included -- sourced directly from the requester rather
/// than either of two disagreeing secondary sources (see module doc comment
/// #23's own paragraph on that source conflict).
pub const STATION_TOKEN_LIMIT: &[(u32, u8)] = &[
    (1, 4), // PRR
    (2, 4), // NYC
    (3, 4), // CPR
    (4, 3), // B&O
    (5, 3), // C&O
    (6, 3), // ERIE
    (7, 2), // NNH
    (8, 2), // B&M
];

/// Returns `company_id`'s total Station Token limit (home token included),
/// or a conservative default of `3` for any `company_id` outside
/// `public_company::CORE_PUBLIC_COMPANIES` (shouldn't happen in practice --
/// every core company has an explicit entry above).
pub fn station_token_limit(company_id: u32) -> u8 {
    STATION_TOKEN_LIMIT
        .iter()
        .find(|(id, _)| *id == company_id)
        .map(|(_, limit)| *limit)
        .unwrap_or(3)
}

/// Station Tokens (module doc comment #23): the VGP cost of the token
/// currently being placed, where `token_ordinal` is that token's 1-based
/// position in the corporation's own placement order (`1` for its very
/// first/home token, `2` for its second, and so on) -- i.e. call this with
/// `existing_token_count + 1`, never with a 0-based index. The 1st token is
/// free (the home token, granted automatically at float by
/// `grant_home_station_token` -- never actually charged, but the `1 =>
/// zero()` arm exists so this function stays total/correct if ever called
/// for a corporation's real first token some other way, e.g. NNH's, which
/// has no free auto-grant to fall back on). The 2nd token costs 40 VGP;
/// every token after that costs a flat 100 VGP -- matching both the
/// official EN rulebook and the secondary source's agreeing cost
/// progression (module doc comment #23), the one part of station-token
/// economics those two sources did NOT disagree on.
pub fn station_token_cost(token_ordinal: u8) -> Uint128 {
    match token_ordinal {
        0 | 1 => Uint128::zero(),
        2 => Uint128::new(40),
        _ => Uint128::new(100),
    }
}

/// Grants `company_id`'s free home Station Token the moment it floats, if
/// (and only if) `corporation_home_hex` has an entry for it (module doc
/// comment #23) -- a no-op for NNH, and a no-op if this protocol somehow
/// already has a token recorded (defensive; shouldn't happen, since a
/// company only ever floats once per game per `PublicCompany::is_floated`'s
/// own guard at each call site). Writes only to `PROTOCOL_STATION_HEXES`,
/// deliberately never touching `PROTOCOL_NETWORK_HEXES` or charging the
/// treasury -- see module doc comment #23's "DELIBERATELY DECOUPLED"
/// paragraph. Called from `auction::award_bo_president_share` and
/// `trading::execute_buy_stock`'s float branch, the only two places a
/// `PublicCompany::is_floated` flag ever flips from `false` to `true`.
pub fn grant_home_station_token(
    storage: &mut dyn Storage,
    game_id: u64,
    company_id: u32,
) -> Result<(), StdError> {
    let Some((home_q, home_r, _label)) = corporation_home_hex(company_id) else {
        return Ok(());
    };
    let mut token_hexes: Vec<(i32, i32)> = PROTOCOL_STATION_HEXES
        .may_load(storage, (game_id, company_id))?
        .unwrap_or_default();
    if token_hexes.contains(&(home_q, home_r)) {
        return Ok(());
    }
    token_hexes.push((home_q, home_r));
    PROTOCOL_STATION_HEXES.save(storage, (game_id, company_id), &token_hexes)?;

    // Audit G-12: record WHICH city this home token occupies, not just which
    // hex. Every 1830 corporation's home is a single-city hex, so this is
    // city 0 in practice -- but writing it explicitly means the home token is
    // visible to `hex_token_occupants` through the real registry rather than
    // only through its city-0 reconstruction fallback, and it keeps the
    // invariant that both writers maintain `HEX_STATION_TOKENS`.
    //
    // `first_open_city` rather than a hardcoded 0 so that a home hex which is
    // ever redefined onto multi-city artwork stays correct without this
    // function needing to change. `unwrap_or(0)` covers the "hex has no city
    // slots at all" case, which for a corporation home is unreachable; the
    // fallback keeps the home grant infallible rather than introducing a new
    // way for a float to fail.
    let slot_counts = city_slot_counts_at(storage, game_id, home_q, home_r)?;
    let occupants = hex_token_occupants(storage, game_id, home_q, home_r)?;
    let city_index = first_open_city(slot_counts, &occupants).unwrap_or(0);
    let mut hex_tokens: Vec<(u32, u8)> = HEX_STATION_TOKENS
        .may_load(storage, (game_id, home_q, home_r))?
        .unwrap_or_default();
    if !hex_tokens.iter().any(|(id, _)| *id == company_id) {
        hex_tokens.push((company_id, city_index));
        HEX_STATION_TOKENS.save(storage, (game_id, home_q, home_r), &hex_tokens)?;
    }
    Ok(())
}

/// Real, individually-sourced VGP starting face values for the six
/// preprinted-track hexes covered by the Landmark Pathfinder Revenue Fix
/// (module doc comment #17, extended by #20): the three `LANDMARK_HEXES`
/// (New York $40, Boston $30, Baltimore $30) plus three of
/// `CITY_DESIGNATED_HEXES`' six real-track GRAY cities this fix reaches
/// (Montreal $40, Cleveland $30 -- NOT "Chicago"; Chicago is
/// `OFFBOARD_HEXES`' own separate, unrelated off-board destination at
/// `(-2, 5)`, on its own era-tiered value system this fix doesn't touch --
/// plus Altoona $10, added by module doc comment #20). Figures verified
/// against `tobymao/18xx`'s `g_1830/map.rb` (New York's and Montreal's real
/// printed track carries two and one `city=revenue:40` node respectively;
/// Boston/Baltimore/Cleveland each one `city=revenue:30` node; Altoona one
/// `city=revenue:10` node, independently re-verified twice -- module doc
/// comment #20) -- identical to, and kept in lockstep with, the frontend's
/// `HEX_START_VALUE_OVERRIDE` in `HexGridRenderer.tsx`. Lansing/Rochester/
/// Richmond -- the other three real-track GRAY cities -- are deliberately
/// NOT included here: no individually-sourced starting figure for them has
/// been verified in any pass to date (the frontend's own override table
/// doesn't cover them either), so they're left on the ordinary flat
/// `terrain_base_value` lookup rather than guessing a number.
pub const LANDMARK_START_VALUE_OVERRIDE: &[(i32, i32, u128)] = &[
    (6, 6, 40), // New York (G19)
    (9, 4, 30), // Boston (E23)
    (3, 8, 30), // Baltimore (I15)
    (9, 0, 40), // Montreal (A19)
    (0, 5, 30), // Cleveland (F6) -- NOT "Chicago"; see doc comment above
    (2, 7, 10), // Altoona (H12) -- real City, NOT a Town; see module doc comment #20
];

/// Returns the Landmark Pathfinder Revenue Fix's real starting value at
/// `(q, r)`, or `None` if it's not one of the six hexes
/// `LANDMARK_START_VALUE_OVERRIDE` covers. See module doc comment #17/#20 and
/// `pathfinding.rs`'s `effective_tile_and_value` for how this is applied.
pub fn landmark_start_value_at(q: i32, r: i32) -> Option<Uint128> {
    LANDMARK_START_VALUE_OVERRIDE
        .iter()
        .find(|(lq, lr, _)| *lq == q && *lr == r)
        .map(|(_, _, value)| Uint128::new(*value))
}

/// Fixed axial coordinates of every hex bearing a preprinted Town or
/// Double-Town designation on the real 1830 board -- module doc comment
/// #16 (Rigid On-Chain Tile Matching). Three real pre-printed GRAY
/// single-town hexes with fixed starting track (Kingston C15, Atlantic
/// City I19, F24 -- real board name Mansfield, see below), four ordinary
/// white single-town hexes with a bare town placeholder and no printed
/// track (London E7, Burlington B20, Flint D4, Erie F10), and three
/// ordinary white DOUBLE-town hexes, also with no printed track (Akron &
/// Canton G7, Reading & Allentown G17, New Haven & Hartford F20) --
/// verbatim-sourced from `tobymao/18xx`'s `g_1830/map.rb` `HEXES` hash
/// (white-section `town=revenue:0` / `town=revenue:0;town=revenue:0`
/// entries). The trailing `bool` is `true` for a Double-Town hex, `false`
/// for a Single-Town hex -- used only for `TownDesignationRequiresTownTile`'s
/// error message; both designations currently accept either
/// `TerrainType::SmallTown` or `DoubleTown` tile artwork via
/// `execute_lay_tile`'s Town/Double-Town Reservation gate.
///
/// F24's entry below reads "Fall River", NOT the real board's own
/// "Mansfield" name -- a later pass explicitly requested this as a
/// deliberate custom/house-rule display override (contrasted, in that same
/// request, with B16's explicitly "authentic rulebook name" Ottawa in
/// `CITY_DESIGNATED_HEXES` above), kept in lockstep with the frontend's
/// identical override in `HexGridRenderer.tsx`'s `NAMED_HEX_LABELS`. The
/// real board name remains Mansfield, as recorded here for the historical/
/// sourcing record; this is a cosmetic rename only, surfaced through
/// `TownDesignationRequiresTownTile`'s error message same as any other name
/// here -- it changes no coordinate, no gate, no gameplay rule.
pub const TOWN_DESIGNATED_HEXES: &[(&str, i32, i32, bool)] = &[
    ("Kingston", 6, 2, false),
    ("Atlantic City", 5, 8, false),
    ("Fall River", 9, 5, false), // real board name: Mansfield -- see doc comment above
    ("London", 1, 4, false),
    ("Burlington", 9, 1, false),
    ("Flint", 0, 3, false),
    ("Erie", 2, 5, false),
    ("Akron & Canton", 0, 6, true),
    ("Reading & Allentown", 5, 6, true),
    ("New Haven & Hartford", 7, 5, true),
];

/// Returns `(name, is_double)` for the preprinted Town/Double-Town
/// designation registered at `(q, r)`, or `None` if it's not one of
/// `TOWN_DESIGNATED_HEXES`. See module doc comment #16.
pub fn town_designation_at(q: i32, r: i32) -> Option<(&'static str, bool)> {
    TOWN_DESIGNATED_HEXES
        .iter()
        .find(|(_, tq, tr, _)| *tq == q && *tr == r)
        .map(|(name, _, _, is_double)| (*name, *is_double))
}

/// Every hex with real, permanent, non-upgradeable GRAY pre-printed track
/// on the physical 1830 board -- module doc comment #19/#20 (Gray Hex
/// Immutability, extended to full board-wide scope). Twelve entries: the
/// nine already independently identified elsewhere in this file --
/// `CITY_DESIGNATED_HEXES`'s six real GRAY cities (Lansing, Cleveland,
/// Altoona, Rochester, Richmond, Montreal) plus `TOWN_DESIGNATED_HEXES`'s
/// three real GRAY towns (Kingston, Atlantic City, Fall River/Mansfield) --
/// PLUS the three real GRAY bare connector hexes (E9, A17, D24) that carry
/// fixed pre-printed track but no city/town marker at all, added by module
/// doc comment #20's "Rigid Global Gray-Hex Lockout" pass. Coordinates for
/// the three connectors are sourced from this same file's own
/// `BOARD_HEX_LABELS` table (already on record, no new sourcing needed) and
/// cross-verified against the frontend's `GRAY_HEXES` constant in
/// `HexGridRenderer.tsx`, which already carried the complete twelve-hex
/// dataset (including these three, as `marker: "none"` entries) before this
/// pass -- this backend table was the one place still scoped to nine. Since
/// E9/A17/D24 have no real place name (`LOCATION_NAMES` has no entry for
/// them either, matching the frontend's own `NAMED_HEX_LABELS` doc
/// comment), their display name here is just their board label.
pub const GRAY_PREPRINTED_HEXES: &[(&str, i32, i32)] = &[
    ("Lansing", -1, 3),
    ("Cleveland", 0, 5),
    ("Altoona", 2, 7),
    ("Rochester", 5, 3),
    ("Richmond", 2, 10),
    ("Montreal", 9, 0),
    ("Kingston", 6, 2),
    ("Atlantic City", 5, 8),
    ("Fall River", 9, 5), // real board name: Mansfield -- see TOWN_DESIGNATED_HEXES's own doc comment
    ("E9", 2, 4),   // bare GRAY connector, no city/town -- module doc comment #20
    ("A17", 8, 0),  // bare GRAY connector, no city/town -- module doc comment #20
    ("D24", 10, 3), // bare GRAY connector, no city/town -- module doc comment #20
];

/// Returns the real GRAY pre-printed hex's name registered at `(q, r)`, or
/// `None` if it's not one of `GRAY_PREPRINTED_HEXES`' twelve entries. See
/// module doc comment #19/#20 -- checked unconditionally in both
/// `execute_lay_tile` and `legal_tile_placements`, immediately after
/// Off-Board Reservation, before any tile artwork is even considered.
pub fn gray_preprinted_name_at(q: i32, r: i32) -> Option<&'static str> {
    GRAY_PREPRINTED_HEXES
        .iter()
        .find(|(_, gq, gr)| *gq == q && *gr == r)
        .map(|(name, _, _)| *name)
}

/// Private-Company-Reserved Hexes -- module doc comment #24. Two entries,
/// each `(board label, q, r, private_id)`: B20 (Burlington, `(9, 1)`) is
/// reserved for Delaware & Hudson (`private_id` 3), and F16 (`(5, 5)`) is
/// reserved for Mohawk & Hudson (`private_id` 4). Track may only be laid on
/// either hex by the corporation that owns the matching private company via
/// `owner_protocol_id` -- a player-only `owner` does NOT unlock the hex, per
/// the user's explicit correction. The block lifts permanently once that
/// private's `closed` flag is set (Phase 5 closes every remaining private).
pub const PRIVATE_RESERVED_HEXES: &[(&str, i32, i32, u32)] = &[
    ("B20", 9, 1, 3), // Burlington -- Delaware & Hudson
    ("F16", 5, 5, 4), // Mohawk & Hudson
];

/// Returns `Some((board label, private_id))` if `(q, r)` is one of
/// `PRIVATE_RESERVED_HEXES`' two entries, else `None`. Mirrors
/// `gray_preprinted_name_at`'s shape.
pub fn private_reserved_hex_at(q: i32, r: i32) -> Option<(&'static str, u32)> {
    PRIVATE_RESERVED_HEXES
        .iter()
        .find(|(_, pq, pr, _)| *pq == q && *pr == r)
        .map(|(label, _, _, private_id)| (*label, *private_id))
}

/// Shared check for both `execute_lay_tile` and `legal_tile_placements` --
/// module doc comment #24. Returns `Ok(true)` (blocked) when `(q, r)` is one
/// of `PRIVATE_RESERVED_HEXES`' two hexes AND the reservation hasn't lifted:
/// the private company record is missing entirely (fail-closed -- treated as
/// still blocking) or exists but is neither `closed` nor currently
/// corporation-owned by `protocol_id` (checked via `owner_protocol_id`, never
/// `owner` -- a player owner never unlocks the hex). Returns `Ok(false)` when
/// `(q, r)` isn't reserved at all, or the reserved private's `closed` flag is
/// set (Phase 5 closure lifts the block globally), or `owner_protocol_id`
/// already equals `protocol_id`.
fn private_reserved_hex_blocks(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
) -> Result<bool, HexMapError> {
    let Some((_, private_id)) = private_reserved_hex_at(q, r) else {
        return Ok(false);
    };
    let private: Option<PrivateCompany> = PRIVATE_COMPANIES.may_load(storage, (game_id, private_id))?;
    match private {
        None => Ok(true),
        Some(private) => {
            if private.closed {
                return Ok(false);
            }
            Ok(private.owner_protocol_id != Some(protocol_id))
        }
    }
}

/// Coordinate Symmetries: the complete, authoritative real 1830 board --
/// every one of its 93 hexes' printed row-letter/column-number label (e.g.
/// `"G19"`) paired with the axial `(q, r)` this contract's own coordinate
/// system converts it to. This is the single source of truth
/// `label_for_axial`/`axial_for_label`/`describe_hex` all read from, so
/// every coordinate this contract ever stores, queries, or raises an error
/// about can be resolved back to the exact label a human could check
/// against the physical board or `frontend/src/components/HexGridRenderer.tsx`'s
/// identical `STATIC_BOARD_HEXES` table (this array is a byte-for-byte port
/// of that one, including all 93 entries and their `(q, r)` values) -- a
/// bare `(q, r)` pair alone is not considered sufficient traceability
/// anywhere in this module. `(q, r)` remains the actual storage/message key
/// throughout this contract (unchanged, and itself already the literal,
/// un-abstracted transform of the real board's own labels: `r = row-letter
/// index (A=0..K=10)`, `q = (column_number - 1 - r) / 2`) -- this table adds
/// auditability on top of that, it does not replace it. This includes the
/// three `LANDMARK_HEXES` and seven `OFFBOARD_HEXES` entries too (their
/// labels are re-derivable from here, though those two constants keep their
/// own copies since they also carry the landmark/off-board *names*, not
/// just the printed coordinate).
pub const BOARD_HEX_LABELS: &[(&str, i32, i32)] = &[
    // Row A
    ("A9", 4, 0),
    ("A11", 5, 0),
    ("A17", 8, 0),
    ("A19", 9, 0),
    // Row B
    ("B10", 4, 1),
    ("B12", 5, 1),
    ("B14", 6, 1),
    ("B16", 7, 1),
    ("B18", 8, 1),
    ("B20", 9, 1),
    ("B22", 10, 1),
    ("B24", 11, 1),
    // Row C
    ("C7", 2, 2),
    ("C9", 3, 2),
    ("C11", 4, 2),
    ("C13", 5, 2),
    ("C15", 6, 2),
    ("C17", 7, 2),
    ("C19", 8, 2),
    ("C21", 9, 2),
    ("C23", 10, 2),
    // Row D
    ("D2", -1, 3),
    ("D4", 0, 3),
    ("D6", 1, 3),
    ("D8", 2, 3),
    ("D10", 3, 3),
    ("D12", 4, 3),
    ("D14", 5, 3),
    ("D16", 6, 3),
    ("D18", 7, 3),
    ("D20", 8, 3),
    ("D22", 9, 3),
    ("D24", 10, 3),
    // Row E
    ("E3", -1, 4),
    ("E5", 0, 4),
    ("E7", 1, 4),
    ("E9", 2, 4),
    ("E11", 3, 4),
    ("E13", 4, 4),
    ("E15", 5, 4),
    ("E17", 6, 4),
    ("E19", 7, 4),
    ("E21", 8, 4),
    ("E23", 9, 4), // Boston
    // Row F
    ("F2", -2, 5), // Chicago
    ("F4", -1, 5),
    ("F6", 0, 5),
    ("F8", 1, 5),
    ("F10", 2, 5),
    ("F12", 3, 5),
    ("F14", 4, 5),
    ("F16", 5, 5),
    ("F18", 6, 5),
    ("F20", 7, 5),
    ("F22", 8, 5),
    ("F24", 9, 5),
    // Row G
    ("G3", -2, 6),
    ("G5", -1, 6),
    ("G7", 0, 6),
    ("G9", 1, 6),
    ("G11", 2, 6),
    ("G13", 3, 6),
    ("G15", 4, 6),
    ("G17", 5, 6),
    ("G19", 6, 6), // New York
    // Row H
    ("H2", -3, 7),
    ("H4", -2, 7),
    ("H6", -1, 7),
    ("H8", 0, 7),
    ("H10", 1, 7),
    ("H12", 2, 7),
    ("H14", 3, 7),
    ("H16", 4, 7),
    ("H18", 5, 7),
    // Row I
    ("I1", -4, 8), // Gulf
    ("I3", -3, 8),
    ("I5", -2, 8),
    ("I7", -1, 8),
    ("I9", 0, 8),
    ("I11", 1, 8),
    ("I13", 2, 8),
    ("I15", 3, 8), // Baltimore
    ("I17", 4, 8),
    ("I19", 5, 8),
    // Row J
    ("J2", -4, 9), // Gulf
    ("J4", -3, 9),
    ("J6", -2, 9),
    ("J8", -1, 9),
    ("J10", 0, 9),
    ("J12", 1, 9),
    ("J14", 2, 9),
    // Row K
    ("K13", 1, 10), // Deep South
    ("K15", 2, 10),
];

/// Returns `(q, r)`'s real 1830 board label (e.g. `"G19"`), or `None` if
/// `(q, r)` isn't one of the real board's 93 hexes -- see `BOARD_HEX_LABELS`.
pub fn label_for_axial(q: i32, r: i32) -> Option<&'static str> {
    BOARD_HEX_LABELS
        .iter()
        .find(|(_, lq, lr)| *lq == q && *lr == r)
        .map(|(label, _, _)| *label)
}

/// Returns the axial `(q, r)` a real 1830 board label (e.g. `"G19"`)
/// resolves to, or `None` if `label` isn't one of the real board's 93
/// hexes. The inverse of `label_for_axial` -- mainly useful for tests and
/// any future off-chain tooling that wants to address a hex by its printed
/// label rather than hand-computing the axial transform.
pub fn axial_for_label(label: &str) -> Option<(i32, i32)> {
    BOARD_HEX_LABELS
        .iter()
        .find(|(l, _, _)| *l == label)
        .map(|(_, q, r)| (*q, *r))
}

/// Resolves `(q, r)` to a human-checkable string for every place a
/// coordinate is surfaced -- error messages, query responses, and test
/// assertions -- so nothing ever has to eyeball a bare axial pair against
/// the physical board by hand (see `BOARD_HEX_LABELS`'s doc comment).
/// Unlike `label_for_axial`, this never returns `None`: a coordinate that
/// isn't one of the real board's 93 hexes (e.g. a test deliberately using a
/// far-off coordinate to exercise `NoLegalConnection`) still gets a
/// ready-to-display, clearly-marked string instead of forcing every caller
/// to handle a missing label.
pub fn describe_hex(q: i32, r: i32) -> String {
    match label_for_axial(q, r) {
        Some(label) => label.to_string(),
        None => format!("({q}, {r}) [off the authentic 1830 board]"),
    }
}

/// The static, classic-1830-style VGP revenue value for each `TerrainType`:
/// Plain $0, Mountain/Rugged $0, Small Town $10, Major City Hub $20 --
/// Revenue Pathing Correction (superseding this contract's earlier pass,
/// which had given Plain/Mountain the same $10/$20 figures as Small
/// Town/Major City Hub). Real 1830 draws a hard line here: plain and
/// mountain hexes are pure *connector* track -- they let a route pass
/// through or link two ends of the board together, but carry no printed
/// revenue value of their own -- only a hex with an actual printed town or
/// city (`SmallTown`/`MajorCityHub`) generates money when a route runs
/// through or terminates there. Giving Plain/Mountain a nonzero figure was
/// a straightforward game-design bug, not a deliberate simplification: it
/// let a company earn revenue by laying ordinary track alone, with no town
/// or city anywhere on its route. `MajorCityHub` covers the three
/// `LANDMARK_HEXES` (New York/Boston/Baltimore) equally with any other
/// major city artwork -- no separate landmark-specific bonus is needed
/// here, since a landmark hex can only ever hold `MajorCityHub` tile
/// artwork in the first place (`LandmarkRequiresHubTile`/
/// `HubTileMustBeOnLandmark`, module doc comment #11) and `tile_base_value`
/// resolves every laid tile's terrain the same way regardless of which hex
/// it sits on. The single source of truth both `tile_base_value` (used by
/// the LayTile-side of this module) and `pathfinding::trace_best_route`
/// read from -- there is no other place in the contract that hardcodes a
/// hex's revenue value. NOTE: this is strictly the *revenue* figure, not
/// the *cost to lay* a tile -- `TILE_CATALOG`'s own embedded `u128` cost
/// field (e.g. tile 4's $40, tile 5's $80) is a completely separate number
/// and is untouched by this correction.
///
/// DELIBERATELY NOT MADE HEX-SPECIFIC (design note #35, frontend
/// `HexGridRenderer.tsx`): that pass's "Accurate 1830 Base Value
/// Corrections" gave New York/Boston/Baltimore/Montreal/Cleveland real,
/// individually-sourced $ figures ($40/$30/$30/$40/$30, verified against
/// `tobymao/18xx`'s `g_1830/map.rb`) and asked for the change on "both
/// layers." Applied ONLY on the frontend, as a new
/// `HEX_START_VALUE_OVERRIDE` table layered in front of that file's own
/// `terrainBaseValue` mirror of this function -- deliberately NOT ported
/// here, for two reasons. First, this function is real, live payout math
/// (`tile_base_value` / `pathfinding::trace_best_route`), not a cosmetic
/// preview -- making it hex-specific would permanently change every laid
/// tile's revenue at these five hexes for the entire rest of the game,
/// across every color tier (Yellow through Brown), not just a "starting"
/// figure; the request's own "displays a value plate" framing describes
/// the frontend's on-canvas badge specifically, a much narrower change than
/// silently altering live game payouts. Second, and more fundamentally:
/// per `pathfinding.rs`'s own design notes (module doc comment, "Hex/city
/// values"), this function is never even CALLED for a landmark/city hex
/// before a real tile is laid there -- `trace_best_route` skips any
/// coordinate absent from `MAP_GRID` entirely, scoring it exactly `$0`,
/// deliberately with no landmark special case. So the real, live "starting"
/// value of New York/Boston/Baltimore/Montreal/Cleveland in this contract
/// is ALREADY `$0` today, for every hex uniformly -- ironically the exact
/// behavior that request's OWN item 3 asked for on a different set of
/// hexes ("un-networked cities... lack an active track network at
/// genesis... value must be $0"). The frontend's per-hex $40/$30 figures
/// are a pre-tile PREVIEW/advisory only (what a hex is worth once someone
/// eventually builds it), never a live balance figure this contract pays
/// out -- there is no query response anywhere in this contract that
/// surfaces such a figure today, so there was no existing "layer" here to
/// update in the first place.
pub fn terrain_base_value(terrain: TerrainType) -> Uint128 {
    Uint128::new(match terrain {
        TerrainType::Plain => 0,
        // Audit G-5/G-10: NO tile carries this terrain any more. Real 1830
        // has no mountain tile -- mountains are printed on the BOARD, and
        // their build fee now comes from `terrain_build_fee(q, r)`. The two
        // invented tiles that used to carry `MountainRugged` are deleted.
        // The variant itself is retained (rather than removed from
        // `state::TerrainType`) so this match stays exhaustive, so already-
        // stored `Tile` records deserialize unchanged, and so the frontend's
        // own terrain enum needs no lockstep change. Scored `0` either way:
        // bare mountain track was never a revenue centre.
        TerrainType::MountainRugged => 0,
        TerrainType::SmallTown => 10,
        TerrainType::DoubleTown => 10, // module doc comment #21: corrected DOWN from an earlier "two $10 stops sharing one hex" $20 -- a route visits this hex once and prices it once, same single-visit rule DoubleCityHub's own $80->$40 correction (module doc comment #18/#20) already established; a double town's two circles don't connect intra-hex any more than a double city's two stations do, so only one $10 stop is ever actually reached per pass.
        TerrainType::MajorCityHub => 20,
        TerrainType::DoubleCityHub => 40, // real 1830 tile 59's per-station $40 (module doc comment #18), NOT both stations at once -- corrected back down from an earlier pass's $80, which wrongly credited both of tile 59's stations on a single visit even though the tile's real path data leaves them disconnected, so a single continuous transit can only ever reach ONE station per pass. See module doc comment #20's follow-up correction paragraph for the full reasoning.
        TerrainType::BostonHub => 20, // module doc comment #26: same flat single-city bucket as MajorCityHub -- Boston's own real printed revenue (real 1830: $30, tobymao/18xx-sourced) is DELIBERATELY not ported here either, same "not hex-specific, live payout math" reasoning this function's own doc comment already gives for MajorCityHub/DoubleCityHub; the frontend's HEX_START_VALUE_OVERRIDE remains the only place a real per-hex figure is shown.
        TerrainType::NewYorkHub => 40, // module doc comment #26: same flat per-station bucket as DoubleCityHub (both are two-station hub artwork, single-visit-per-pass pricing per DoubleCityHub's own note above) -- real 1830's own $40/station figure for New York's green tile happens to already match this flat bucket, a coincidence, not a hex-specific override (same reasoning as BostonHub above).
    })
}

/// Looks up `tile_id`'s fixed base revenue value -- its `TerrainType` from
/// `TILE_CATALOG`, resolved through `terrain_base_value` -- or `None` if no
/// such tile exists. Used by `pathfinding.rs` when summing an Operating
/// Round route's total value.
pub fn tile_base_value(tile_id: u32) -> Option<Uint128> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, terrain, _color, _qty, _paths, revenue)| {
            // Audit G-11: the tile's OWN printed revenue wins; the flat
            // `terrain_base_value` bucket is the fallback for entries that
            // have none. This is the single point the whole engine prices a
            // hex through -- `pathfinding::HexInfo.value` and
            // `operations::execute_run_manual_route`'s `tile_values` both
            // resolve here -- so adding the override at this one site moves
            // every payout path at once, with no second implementation to
            // drift.
            //
            // WHY THIS WAS NEEDED: `terrain_base_value` prices by
            // `TerrainType`, of which there are seven, across 46 tiles. That
            // is structurally unable to express real 1830, where revenue is
            // a property of the printed TILE, not of its category: #62 and
            // #64 are both `NewYorkHub`-class two-city brown artwork, yet
            // print $90 and $50. Under the terrain model they were
            // necessarily equal, and both wrong. Same for the whole Green/
            // Brown city ladder -- #14/#15 print $30 and #63 $40, where the
            // flat `MajorCityHub` bucket paid $20 for all three.
            //
            // The bucket is deliberately KEPT rather than deleted: every
            // town tile really does print $10, so `SmallTown`/`DoubleTown`
            // carry explicit values that merely agree with it, and any
            // future tile added without a sourced figure still prices
            // sanely instead of silently paying zero.
            revenue.map_or_else(|| terrain_base_value(terrain), |value| Uint128::new(value as u128))
        })
}

/// `tile_id`'s own printed revenue as published in `TILE_CATALOG`, or `None`
/// when the entry has none and falls back to its terrain bucket (Audit
/// G-11). Surfaced on `msg::MapTileEntry::revenue` so a client renders the
/// same figure the contract will actually pay, rather than re-deriving it
/// from terrain and quietly disagreeing.
pub fn tile_printed_revenue(tile_id: u32) -> Option<u32> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .and_then(|(_, _, _, _terrain, _color, _qty, _paths, revenue)| revenue)
}

/// Looks up `tile_id`'s `TileColor` era tier, or `None` if no such tile
/// exists. Used by `execute_lay_tile` to resolve the color of a tile
/// already sitting on the map (for an upgrade's color-step check) without
/// needing to store the color redundantly on `state::Tile` itself.
pub fn tile_color_for(tile_id: u32) -> Option<TileColor> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, _terrain, color, _qty, _paths, _revenue)| color)
}

/// Looks up `tile_id`'s `TerrainType`, or `None` if no such tile exists.
/// Used by `execute_place_station_token` (module doc comment #23) to check
/// that a Station Token's target hex already holds a laid
/// `MajorCityHub`/`DoubleCityHub` tile, mirroring `tile_color_for`'s exact
/// shape/purpose one field over.
pub fn tile_terrain_for(tile_id: u32) -> Option<TerrainType> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, terrain, _color, _qty, _paths, _revenue)| terrain)
}

/* ------------------------------------------------------------------ */
/* Tile Inventory Supply Engine (Audit G-5)                           */
/* ------------------------------------------------------------------ */

/// Looks up how many physical copies of `tile_id` a room starts with --
/// `TILE_CATALOG`'s sixth field -- or `None` if no such tile exists. See
/// `UNLIMITED_TILE_SUPPLY` for what the sentinel value means.
pub fn tile_starting_quantity(tile_id: u32) -> Option<u32> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, _terrain, _color, quantity, _paths, _revenue)| quantity)
}

/// Seeds `game_id`'s tile tray with a full starting supply of every
/// `TILE_CATALOG` entry. Called once, when a game room is created
/// (`contract::execute_create_game_room`, alongside
/// `hardware::spawn_hardware_pool` and the company/market seeding), and
/// again by `gamelog::reapply_game_log` to reset the tray to genesis before
/// replaying the event log.
///
/// Writes every entry unconditionally (rather than skipping the unlimited
/// ones) so a room's tray is fully self-describing in state and a later
/// read never has to fall back on the catalog to know what it started with.
pub fn seed_tile_inventory(storage: &mut dyn Storage, game_id: u64) -> StdResult<()> {
    for (tile_id, _connections, _cost, _terrain, _color, quantity, _paths, _revenue) in
        TILE_CATALOG.iter().copied()
    {
        REMAINING_TILES.save(storage, (game_id, tile_id), &quantity)?;
    }
    Ok(())
}

/// How many copies of `tile_id` are still unlaid in `game_id`'s tray.
///
/// Falls back to `tile_starting_quantity` when no entry has been written
/// yet -- defensive, so a room created before this feature existed (whose
/// `REMAINING_TILES` prefix is entirely empty) reads as a full tray rather
/// than an instantly-exhausted one, which would have silently frozen every
/// tile lay in every pre-existing room. A `tile_id` that isn't in the
/// catalog at all reads as `0`; `execute_lay_tile` rejects it earlier with
/// `TileNotFound` regardless.
pub fn remaining_tile_count(
    storage: &dyn Storage,
    game_id: u64,
    tile_id: u32,
) -> StdResult<u32> {
    Ok(REMAINING_TILES
        .may_load(storage, (game_id, tile_id))?
        .unwrap_or_else(|| tile_starting_quantity(tile_id).unwrap_or(0)))
}

/// Whether `tile_id` is exempt from depletion -- see
/// `UNLIMITED_TILE_SUPPLY`. Checked against the LIVE tray count rather than
/// the catalog, so the exemption survives `gamelog::reapply_game_log`'s
/// reset and any future per-room override.
fn tile_supply_is_unlimited(remaining: u32) -> bool {
    remaining == UNLIMITED_TILE_SUPPLY
}

/// Removes one copy of `tile_id` from `game_id`'s tray, erroring with
/// `TileSupplyExhausted` if none remain. A no-op for an unlimited entry.
///
/// Callers must have already validated that `tile_id` exists in the
/// catalog.
fn consume_tile_from_tray(
    storage: &mut dyn Storage,
    game_id: u64,
    tile_id: u32,
) -> Result<(), HexMapError> {
    let remaining = remaining_tile_count(storage, game_id, tile_id)?;
    if tile_supply_is_unlimited(remaining) {
        return Ok(());
    }
    if remaining == 0 {
        return Err(HexMapError::TileSupplyExhausted {
            game_id,
            tile_id,
            starting_quantity: tile_starting_quantity(tile_id).unwrap_or(0),
        });
    }
    REMAINING_TILES.save(storage, (game_id, tile_id), &(remaining - 1))?;
    Ok(())
}

/// Returns one copy of `tile_id` to `game_id`'s tray -- the real 1830
/// recycling rule: the tile you LIFT OFF the board during a colour upgrade
/// goes back into the supply, where any company may lay it again later. A
/// no-op for an unlimited entry.
///
/// Saturates at `u32::MAX - 1` rather than wrapping, so a pathological
/// sequence can never accidentally land a finite tile on the
/// `UNLIMITED_TILE_SUPPLY` sentinel and silently make it infinite.
fn return_tile_to_tray(
    storage: &mut dyn Storage,
    game_id: u64,
    tile_id: u32,
) -> StdResult<()> {
    let remaining = remaining_tile_count(storage, game_id, tile_id)?;
    if tile_supply_is_unlimited(remaining) {
        return Ok(());
    }
    let restored = remaining.saturating_add(1).min(UNLIMITED_TILE_SUPPLY - 1);
    REMAINING_TILES.save(storage, (game_id, tile_id), &restored)?;
    Ok(())
}

/// The next `TileColor` tier directly above `color` in the classic 1830
/// progression, or `None` if `color` is already the top (`Brown`) tier with
/// nowhere further to upgrade. See module doc comment #10.
fn next_tile_color(color: TileColor) -> Option<TileColor> {
    match color {
        TileColor::Yellow => Some(TileColor::Green),
        TileColor::Green => Some(TileColor::Brown),
        TileColor::Brown => None,
    }
}

/// Axial-coordinate neighbor offsets, indexed by edge (0-5). Edge `i` on a
/// tile at `(q, r)` touches the tile at
/// `(q + HEX_NEIGHBOR_OFFSETS[i].0, r + HEX_NEIGHBOR_OFFSETS[i].1)`, on that
/// neighbor's opposite edge `(i + 3) % 6`.
pub const HEX_NEIGHBOR_OFFSETS: [(i32, i32); 6] =
    [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)];

/// Fixed set of board-edge crossings across which track may never be built
/// (module doc comment #22). Each entry is `(q, r, edge)`: hex `(q, r)`'s
/// `edge` (this file's 0-5 edge convention, `HEX_NEIGHBOR_OFFSETS` above)
/// may never appear in a laid tile's rotated `connections` bitmask at that
/// hex. Listed as symmetric pairs -- both hexes on either side of a given
/// border carry their own entry for their own edge facing the crossing --
/// so `impassable_edge_mask` closes the border from whichever side a player
/// tries to route track across it. Coordinates come from this file's own
/// `BOARD_HEX_LABELS`; edges were derived from `HEX_NEIGHBOR_OFFSETS`' own
/// axial deltas (e.g. E7 `(1, 4)` -> F8 `(1, 5)` is delta `(0, 1)`, which
/// `HEX_NEIGHBOR_OFFSETS` lists at index 5 -- edge 5 -- so E7's own entry
/// here is edge 5, and F8's reciprocal entry is the opposite edge, `(5 + 3)
/// % 6 = 2`).
/// Audit G-10: every hex the real 1830 board prints as water/river terrain,
/// carrying an `upgrade=cost:80,terrain:water` build fee.
///
/// Verbatim from `tobymao/18xx`'s `g_1830/map.rb` -- the three white
/// `city=revenue:0;upgrade=cost:80,terrain:water` hexes (F4/J14/F22), the
/// four blank water hexes (D6/I17/B18/C19), and the three PREPRINTED yellow
/// hexes that are also water (E5/D10 OO, and G19 New York). Converted to
/// this engine's axial coordinates through this file's own
/// `BOARD_HEX_LABELS` table, so a label here always resolves to the same
/// `(q, r)` the rest of the module uses.
pub const RIVER_HEXES: &[(&str, i32, i32)] = &[
    ("F4", -1, 5),   // Toledo
    ("J14", 2, 9),   // Washington
    ("F22", 8, 5),   // Providence
    ("D6", 1, 3),    // blank water
    ("I17", 4, 8),   // blank water
    ("B18", 8, 1),   // blank water
    ("C19", 8, 2),   // blank water
    ("E5", 0, 4),    // Detroit & Windsor (OO)
    ("D10", 3, 3),   // Hamilton & Toronto (OO)
    ("G19", 6, 6),   // New York & Newark (NY)
];

/// Audit G-10: every hex the real 1830 board prints as mountain terrain,
/// carrying an `upgrade=cost:120,terrain:mountain` build fee. Same
/// `g_1830/map.rb` sourcing and same axial conversion as `RIVER_HEXES`
/// above -- the nine blank mountain hexes, C17 (which additionally carries
/// an impassable border edge, tracked separately in `IMPASSABLE_HEX_EDGES`),
/// and F16 Scranton (a mountain hex that is also a city).
pub const MOUNTAIN_HEXES: &[(&str, i32, i32)] = &[
    ("C17", 7, 2),
    ("G15", 4, 6),
    ("C21", 9, 2),
    ("D22", 9, 3),
    ("E17", 6, 4),
    ("E21", 8, 4),
    ("G13", 3, 6),
    ("I11", 1, 8),
    ("J10", 0, 9),
    ("J12", 1, 9),
    ("F16", 5, 5), // Scranton
];

/// The one-time terrain build fee for laying track onto `(q, r)`: $80 for a
/// river/water hex, $120 for a mountain hex, $0 for ordinary clear land.
///
/// **Audit G-10.** This is the real 1830 model: terrain cost is a property
/// of the HEX, printed on the board, and is paid once when that hex is
/// first built on -- regardless of which tile artwork is laid there. It
/// previously lived on `TILE_CATALOG` entries instead, as a per-tile `cost`
/// field, which produced two concrete exploits: laying an ordinary plain
/// tile onto a genuine river or mountain hex was completely FREE, while
/// laying the invented "mountain pass" artwork onto flat grassland charged
/// $80 for nothing. Those two invented tiles existed only to carry the
/// cost and are now deleted along with this fix -- terrain has no tile
/// representation at all any more, exactly as on the physical board.
///
/// The figures match `g_1830/map.rb`'s own `upgrade=cost:` values and the
/// frontend's `TERRAIN_BUILD_COST_LABEL` ($80 river / $120 mountain), so
/// what a player is shown on the canvas is now what the contract actually
/// charges. A hex can never be both (the two lists are disjoint on the real
/// board); river is checked first regardless, so the function is total.
pub fn terrain_build_fee(q: i32, r: i32) -> Uint128 {
    if RIVER_HEXES.iter().any(|(_, hq, hr)| *hq == q && *hr == r) {
        return Uint128::new(RIVER_BUILD_FEE);
    }
    if MOUNTAIN_HEXES.iter().any(|(_, hq, hr)| *hq == q && *hr == r) {
        return Uint128::new(MOUNTAIN_BUILD_FEE);
    }
    Uint128::zero()
}

/// Real 1830's printed water/river build fee.
pub const RIVER_BUILD_FEE: u128 = 80;

/// Real 1830's printed mountain build fee.
pub const MOUNTAIN_BUILD_FEE: u128 = 120;

pub const IMPASSABLE_HEX_EDGES: &[(i32, i32, u8)] = &[
    // E7 (London) / F8 border.
    (1, 4, 5), // E7, edge 5 (toward F8)
    (1, 5, 2), // F8, edge 2 (toward E7)
    // D12 / C11 border.
    (4, 3, 2), // D12, edge 2 (toward C11)
    (4, 2, 5), // C11, edge 5 (toward D12)
    // D12 / C13 border.
    (4, 3, 1), // D12, edge 1 (toward C13)
    (5, 2, 4), // C13, edge 4 (toward D12)
    // C17 / B16 (Ottawa) border.
    (7, 2, 2), // C17, edge 2 (toward B16)
    (7, 1, 5), // B16, edge 5 (toward C17)
];

/// Returns a bitmask (bit `i` set means edge `i` is blocked) of every edge
/// `IMPASSABLE_HEX_EDGES` lists for hex `(q, r)` -- `0` if the hex has no
/// impassable border at all (true for the overwhelming majority of the
/// board). `execute_lay_tile` and `legal_tile_placements` both AND this
/// against a candidate placement's own rotated `connections` to reject any
/// orientation that would leave a live edge on a blocked crossing.
pub(crate) fn impassable_edge_mask(q: i32, r: i32) -> u8 {
    IMPASSABLE_HEX_EDGES
        .iter()
        .filter(|(eq, er, _)| *eq == q && *er == r)
        .fold(0u8, |mask, (_, _, edge)| mask | (1u8 << *edge))
}

#[derive(Error, Debug)]
pub enum HexMapError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    /// Audit G-5: the physical tray has run out of this tile artwork. Real
    /// 1830 ships a finite number of copies of every tile, and running the
    /// supply dry is a genuine, frequently decisive strategic constraint --
    /// not an edge case.
    #[error(
        "Tile {tile_id} is exhausted in game room {game_id}: every one of its {starting_quantity} physical copies is already on the board"
    )]
    TileSupplyExhausted {
        game_id: u64,
        tile_id: u32,
        starting_quantity: u32,
    },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error("Public company {company_id} was not found in game room {game_id}")]
    PublicCompanyNotFound { game_id: u64, company_id: u32 },

    #[error("Public company {company_id} has not floated yet and cannot lay track")]
    CompanyNotFloated { company_id: u32 },

    #[error(
        "Protocol {protocol_id} has no registered President; someone must hold a qualifying stake before tiles can be laid on its behalf"
    )]
    NoPresidentAssigned { protocol_id: u32 },

    #[error(
        "Unauthorized: only protocol {protocol_id}'s registered President may lay tiles for it"
    )]
    NotPresident { protocol_id: u32 },

    #[error(
        "It is not protocol {protocol_id}'s turn in game room {game_id}'s Operating Round Corporation Turn Queue; protocol {expected_protocol_id} must act first"
    )]
    NotYourOperatingTurn {
        game_id: u64,
        protocol_id: u32,
        expected_protocol_id: u32,
    },

    #[error("No tile artwork with id {tile_id} exists in the tile catalog")]
    TileNotFound { tile_id: u32 },

    #[error(
        "Orientation {orientation} is out of range; a tile's rotation must be a number of 60-degree steps between 0 and 5 inclusive"
    )]
    InvalidOrientation { orientation: u32 },

    #[error(
        "Tile {tile_id} is {tile_color:?}, but game room {game_id}'s current Tech Era only has up through {current_era:?} unlocked"
    )]
    EraLocked {
        game_id: u64,
        tile_id: u32,
        tile_color: TileColor,
        current_era: TileColor,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {landmark} preprinted City hex, which only accepts its designated multi-city hub tile artwork, not tile {tile_id}"
    )]
    LandmarkRequiresHubTile {
        /// The landmark's or `CITY_DESIGNATED_HEXES` entry's display name --
        /// module doc comment #16 generalized this check (and this field's
        /// meaning) from landmarks-only to every preprinted City hex.
        landmark: String,
        q: i32,
        r: i32,
        /// The real 1830 board label this coordinate resolves to (e.g.
        /// `"G19"`) -- see `describe_hex`. Coordinate Symmetries: every
        /// `HexMapError` variant that carries `(q, r)` also carries this,
        /// so nothing surfaced to a caller ever requires hand-computing the
        /// axial transform to check against the physical board.
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is a major city hub, which can only be laid at one of the reserved City hexes (a landmark or a preprinted gray city), not {hex_label} ({q}, {r})"
    )]
    HubTileMustBeOnLandmark {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {oo_hex_name} preprinted OO double-city hex, which only accepts its designated double-city hub tile artwork, not tile {tile_id}"
    )]
    OOHexRequiresDoubleCityHubTile {
        /// `OO_DESIGNATED_HEXES`' entry's display name -- module doc comment
        /// #18 (OO Double-City Tile Catalog Enforcement).
        oo_hex_name: String,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is a double-city hub, which can only be laid at one of the four reserved OO hexes, not {hex_label} ({q}, {r})"
    )]
    DoubleCityHubTileMustBeOnOOHex {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is {b_hex_name}, a preprinted \"B\"-labeled City hex, whose Green- or Brown-tier upgrade only accepts its designated B-labeled tile artwork, not tile {tile_id}"
    )]
    // Renamed from `BostonHexRequiresBostonHubTile` (module doc comment
    // #27): the message used to hardcode the word "Boston," which became
    // wrong once Baltimore was added as a second real "B"-labeled hex --
    // `b_hex_name` now names whichever of the two was actually involved,
    // mirroring `OOHexRequiresDoubleCityHubTile`'s existing `oo_hex_name`
    // field.
    BHexRequiresBHubTile {
        b_hex_name: String,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is the \"B\"-labeled hub tile, which can only be laid at a \"B\"-labeled hex (Boston or Baltimore), not {hex_label} ({q}, {r})"
    )]
    // Renamed from `BostonHubTileMustBeOnBostonHex` (module doc comment
    // #27), same "Boston" hardcoding fix as `BHexRequiresBHubTile` above.
    BHubTileMustBeOnBHex {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is New York, the preprinted \"NY\"-labeled City hex, whose Green- or Brown-tier upgrade only accepts its designated NY-labeled double-city tile artwork, not tile {tile_id}"
    )]
    NewYorkHexRequiresNewYorkHubTile {
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is the \"NY\"-labeled New York hub tile, which can only be laid at New York, not {hex_label} ({q}, {r})"
    )]
    NewYorkHubTileMustBeOnNewYorkHex {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {gray_hex_name} preprinted GRAY hex, whose real starting track is permanent -- it never accepts any laid tile artwork (including tile {tile_id}), unlike a Yellow pre-printed landmark or OO hex"
    )]
    GrayHexNotUpgradeable {
        /// `GRAY_PREPRINTED_HEXES`' entry's display name -- module doc
        /// comment #19 (Gray Hex Immutability).
        gray_hex_name: String,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} at orientation {orientation} would route track across edge {edge} of {hex_label} ({q}, {r}), which lies on a permanently impassable border -- the hex may still receive a tile, just not one oriented to carry track across that specific edge"
    )]
    TrackCrossesImpassableEdge {
        /// `IMPASSABLE_HEX_EDGES`' 0-5 edge index (module doc comment #22).
        edge: u8,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
        orientation: u8,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {town_name} preprinted {designation} hex, which only accepts a Single/Double-Town tile artwork, not tile {tile_id}"
    )]
    TownDesignationRequiresTownTile {
        town_name: String,
        /// `"Double-Town"` if the hex is one of `TOWN_DESIGNATED_HEXES`'s
        /// double-town entries, else `"Single-Town"` -- module doc comment
        /// #16.
        designation: &'static str,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is a Single/Double-Town tile, which can only be laid at one of the reserved Town/Double-Town hexes, not {hex_label} ({q}, {r})"
    )]
    TownTileMustBeOnTownDesignation {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {offboard_name} off-board revenue terminal, which never accepts any laid tile artwork (including tile {tile_id})"
    )]
    OffboardHexNotBuildable {
        offboard_name: String,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "The tile already at {hex_label} ({q}, {r}) is Brown, the top color tier -- it has no further upgrade"
    )]
    AlreadyMaxColor { q: i32, r: i32, hex_label: String },

    #[error(
        "{hex_label} ({q}, {r})'s existing tile is {old_color:?}; upgrading it requires a {expected_color:?} tile, not a {attempted_color:?} one"
    )]
    InvalidColorUpgrade {
        q: i32,
        r: i32,
        hex_label: String,
        old_color: TileColor,
        attempted_color: TileColor,
        expected_color: TileColor,
    },

    #[error(
        "No rotation of tile {tile_id} preserves every track connection already on the existing tile at {hex_label} ({q}, {r}); an upgrade can never delete or disconnect existing paths"
    )]
    TopologyNotPreserved {
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} cannot legally connect to protocol {protocol_id}'s Token Station (Node) network at any rotation from {hex_label} ({q}, {r})"
    )]
    NoLegalConnection {
        protocol_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error("Protocol {company_id}'s treasury holds {available} VGP, which is less than the {required} VGP terrain cost")]
    InsufficientTreasury {
        company_id: u32,
        required: Uint128,
        available: Uint128,
    },

    #[error("Arithmetic overflow/underflow while processing a tile placement")]
    Overflow {},

    // ---- Station Tokens (module doc comment #23) ----
    #[error(
        "{hex_label} ({q}, {r}) has no laid MajorCityHub/DoubleCityHub tile yet -- a Station Token can only be placed on an actual city"
    )]
    StationTokenHexNotACity { q: i32, r: i32, hex_label: String },

    #[error(
        "{hex_label} ({q}, {r}) isn't reachable from protocol {protocol_id}'s own track network yet -- a Station Token can only be placed at a city that protocol's own laid track already reaches"
    )]
    StationTokenHexNotReachable {
        protocol_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "Protocol {protocol_id} already has a Station Token on {hex_label} ({q}, {r}) -- a corporation may never place two of its own tokens on the same hex"
    )]
    StationTokenAlreadyOnHex {
        protocol_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "Protocol {protocol_id} already has all {limit} of its Station Tokens placed -- no more may be placed this game"
    )]
    StationTokenLimitReached { protocol_id: u32, limit: u8 },
    /// Audit G-14: this action was attempted outside its Operating Round
    /// sub-phase. The turn runs BuyPrivate -> Track -> Tokens -> Routes ->
    /// Dividends -> Hardware, and the check is strict equality -- being PAST
    /// a phase fails as loudly as being before it, because reordering after
    /// the fact is exactly what this prevents.
    #[error(
        "protocol {protocol_id} is in Operating Round phase {actual} (step {actual_index} of 6); this action requires phase {required} (step {required_index} of 6)"
    )]
    WrongOperatingSubPhase {
        protocol_id: u32,
        actual: String,
        actual_index: u8,
        required: String,
        required_index: u8,
    },
    /// Audit G-12: the requested `city_index` does not exist on this hex --
    /// e.g. city 1 on a single-city tile. Distinguished from
    /// `StationTokenCityFull` on purpose: one is a malformed request, the
    /// other a legal request the board refuses.
    #[error("hex ({q}, {r}) [{hex_label}] has {city_count} city/cities; city_index {requested} does not exist")]
    StationTokenCityIndexOutOfRange {
        q: i32,
        r: i32,
        hex_label: String,
        requested: u8,
        city_count: u8,
    },
    /// Audit G-12: every slot in the requested city is already taken. When no
    /// `city_index` was supplied this means EVERY city on the hex is full.
    #[error("city {city_index} on hex ({q}, {r}) [{hex_label}] is full ({slots} slot(s))")]
    StationTokenCityFull {
        q: i32,
        r: i32,
        hex_label: String,
        city_index: u8,
        slots: u32,
    },

    #[error(
        "Protocol {protocol_id} already placed a Station Token during this Operating Round sub-round (macro round {macro_round_number}, sub-round {sub_round_index}) -- only one Station Token placement is allowed per corporation per sub-round"
    )]
    StationTokenAlreadyPlacedThisSubRound {
        protocol_id: u32,
        macro_round_number: u32,
        sub_round_index: u32,
    },

    #[error(
        "Protocol {company_id}'s treasury holds {available} VGP, which is less than the {required} VGP Station Token cost"
    )]
    InsufficientTreasuryForStationToken {
        company_id: u32,
        required: Uint128,
        available: Uint128,
    },

    // ---- Private-Company-Reserved Hexes (module doc comment #24) ----
    #[error(
        "{hex_label} ({q}, {r}) is reserved for private company id {private_id} -- only the corporation that owns that private company's wrapper (via owner_protocol_id, not a mere player owner) may lay track here, and protocol {protocol_id} does not own it"
    )]
    HexReservedForUnownedPrivate {
        private_id: u32,
        protocol_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },
}

/// Rotates a six-edge connection bitmask by `orientation` steps (0-5),
/// treating the six bits as a circular ring. `pub(crate)` since
/// `pathfinding.rs`'s route-tracing engine needs the same rotation logic to
/// read a laid `Tile`'s actual on-map edges.
pub(crate) fn rotate_connections(mask: u8, orientation: u8) -> u8 {
    let orientation = orientation % 6;
    let mask = mask & 0b0011_1111;
    if orientation == 0 {
        return mask;
    }
    ((mask << orientation) | (mask >> (6 - orientation))) & 0b0011_1111
}

/* ------------------------------------------------------------------ */
/* Edge-to-Edge Path Geometry (Audit G-9)                             */
/* ------------------------------------------------------------------ */

/// Rotates a single base edge index by `orientation` sixths of a turn --
/// the per-edge scalar equivalent of `rotate_connections`' whole-mask
/// circular shift, and the primitive `rotate_paths` below is built from.
///
/// Both operands are reduced mod 6 before adding, so this is total for every
/// `u8` input and can never overflow -- the same defensiveness
/// `rotate_connections` gets from masking to six bits first.
pub(crate) fn rotate_edge(edge: u8, orientation: u8) -> u8 {
    ((edge % 6) + (orientation % 6)) % 6
}

/// Rotates a tile's *base* edge-pair list into its actual on-map segments
/// (Audit G-9). Each `(a, b)` is rotated edge-wise by `orientation` and
/// re-normalized to `(min, max)` so a segment has exactly one canonical
/// spelling regardless of which direction it is later traversed in -- see
/// `TILE_CATALOG`'s doc comment for the encoding, including the `(a, a)`
/// terminal-spur form (which stays a spur under rotation, since rotating
/// both halves of a self-pair keeps them equal).
///
/// Deliberately mirrors `rotate_connections` exactly: `Tile::paths` and
/// `Tile::connections` are both stored pre-rotation, so both must be
/// rotated at read time and can never drift apart.
/// The edge index on hex `from` that faces hex `to`, or `None` when the two
/// are not adjacent -- Audit G-13.
///
/// The inverse of `HEX_NEIGHBOR_OFFSETS`, which this searches rather than
/// re-deriving with its own arithmetic, so the two directions of the same
/// mapping cannot drift apart.
///
/// Added for `operations::execute_run_manual_route`: a declared `hex_path`
/// pins each interior hex's inbound and outbound edges by its axial deltas to
/// its two neighbours, which is what lets the manual path ask the same
/// city-granular transit question the DFS asks.
pub fn edge_between(from: (i32, i32), to: (i32, i32)) -> Option<u8> {
    let delta = (to.0 - from.0, to.1 - from.1);
    HEX_NEIGHBOR_OFFSETS
        .iter()
        .position(|&(dq, dr)| (dq, dr) == delta)
        .and_then(|index| u8::try_from(index).ok())
}

pub(crate) fn rotate_paths(paths: &[(u8, u8)], orientation: u8) -> Vec<(u8, u8)> {
    paths
        .iter()
        .map(|&(a, b)| normalize_path(rotate_edge(a, orientation), rotate_edge(b, orientation)))
        .collect()
}

/// Canonical `(min, max)` spelling of an edge pair -- the single form both
/// `TILE_CATALOG` and `pathfinding.rs`'s claimed-segment ledger use, so
/// traversing a segment `a -> b` and `b -> a` claims the same ledger key.
pub(crate) fn normalize_path(a: u8, b: u8) -> (u8, u8) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Looks up `tile_id`'s *base* (pre-rotation) edge-pair list from
/// `TILE_CATALOG`, or `None` if no such tile exists (Audit G-9).
pub fn tile_paths_for(tile_id: u32) -> Option<&'static [(u8, u8)]> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, _terrain, _color, _qty, paths, _revenue)| paths)
}

/// Re-derives `tile_id`'s flat connection bitmask from its edge-pair list --
/// the union of every edge appearing in any of its segments, terminal spurs
/// included. `None` if no such tile exists.
///
/// This is the machine-checkable half of `TILE_CATALOG`'s stated invariant
/// (`connections == tile_base_connections(tile_id)` for every entry). It is
/// not used on the hot path -- the stored mask is -- it exists so the test
/// suite can prove the two fields never disagree, which is what stops a
/// future hand-edit of one from silently desynchronizing the other.
pub fn tile_base_connections(tile_id: u32) -> Option<u8> {
    tile_paths_for(tile_id).map(path_list_connections)
}

/// The union bitmask of every edge touched by `paths`.
pub(crate) fn path_list_connections(paths: &[(u8, u8)]) -> u8 {
    paths.iter().fold(0u8, |mask, &(a, b)| {
        mask | (1u8 << (a % 6)) | (1u8 << (b % 6))
    })
}

/// The rotated edge-pair segments actually in play on `tile` (Audit G-9).
///
/// Prefers the tile's own stored `paths`, falling back to `TILE_CATALOG`'s
/// entry for its `tile_id` whenever that list is empty. The fallback is not
/// dead code: `Tile::paths` is `#[serde(default)]`, so any tile written to
/// `MAP_GRID` before G-9 existed deserializes with an empty list and would
/// otherwise become permanently unroutable -- a silent board-wide dead zone
/// of exactly the kind module doc comment #20 had to fix once already.
///
/// Returns an empty `Vec` for a `tile_id` that isn't in the catalog at all
/// (unreachable through `execute_lay_tile`, which rejects those with
/// `TileNotFound`, but total by construction rather than by assumption).
pub(crate) fn effective_tile_paths(tile: &Tile) -> Vec<(u8, u8)> {
    rotate_paths(effective_base_tile_paths(tile), tile.orientation)
}

/// `effective_tile_paths` without the rotation step: the BASE (pre-rotation)
/// segments actually in play on `tile`, stored list preferred and
/// `TILE_CATALOG` used as the same backwards-compatibility fallback (see
/// that function for why the fallback is load-bearing rather than dead).
///
/// Split out for `query::query_map_grid`, which surfaces these on
/// `msg::MapTileEntry::paths`. That response reports `orientation` as its
/// own separate field and states edges pre-rotation -- matching the
/// convention `connections` has always used -- so the caller applies the
/// rotation itself and this must hand back base edges, not rotated ones.
/// Routing code inside the contract wants the rotated form and should keep
/// calling `effective_tile_paths`.
pub(crate) fn effective_base_tile_paths(tile: &Tile) -> &[(u8, u8)] {
    if tile.paths.is_empty() {
        tile_paths_for(tile.tile_id).unwrap_or(&[])
    } else {
        &tile.paths
    }
}

/// How many Station Token slots the city artwork on `tile_id` provides, or
/// `0` for a tile with no city at all (plain track and towns -- a town is a
/// revenue stop but never holds a token).
///
/// **Audit G-9**, feeding the rival-blockade rule in `pathfinding.rs`: a
/// route may not pass THROUGH a city whose every slot is already taken by
/// rival tokens, but may always pass through one that still has an open
/// slot. Figures are the `slots:` counts in `tobymao/18xx`'s
/// `lib/engine/config/tile.rb` for the same 46 entries `TILE_CATALOG`
/// carries, summed across both cities on the two-city tiles:
///
/// - Yellow city #57, and the label-restricted #53/#61 ("B"): 1 slot.
/// - Green city #14/#15 (`slots:2`) and brown city #63 (`slots:2`): 2.
/// - Two-city tiles #54 ("NY", 1+1), #59/#64/#65/#66/#67/#68 ("OO", 1+1): 2.
/// - Two-city brown "NY" #62 (`slots:2` twice): 4.
pub fn tile_city_slots(tile_id: u32) -> u32 {
    // Audit G-12: derived from `tile_city_slot_counts` rather than restated,
    // so the total and the per-city breakdown cannot disagree. Values are
    // unchanged from the hand-written table this replaced.
    tile_city_slot_counts(tile_id).iter().sum()
}

/// How many Station Token slots EACH city on `tile_id` offers, one entry per
/// city, in the SAME index order as that tile's `TILE_CATALOG` path list and
/// the frontend's `TILE_GRAPHICS_CATALOG` markers -- so a `city_index` means
/// the same city everywhere it appears.
///
/// **Audit G-12.** Sourced from the `slots:` field of each tile's own 18xx
/// definition string, recorded in the `TILE_CATALOG` comments above:
///
/// - `#53`/`#57`/`#61`  `city=revenue:N` with no `slots:` -- one 1-slot city.
///   Note #61, the BROWN "B" hub, really is 1-slot; its importance on the
///   board invites the assumption that it is 2, and it is not.
/// - `#14`/`#15`/`#63`  `city=revenue:N,slots:2` -- one 2-slot city.
/// - `#54`/`#59`/`#64`-`#68`  two `city=` entries, neither carrying `slots:`
///   -- TWO separate 1-slot cities. Green New York (#54) included.
/// - `#62`  `city=revenue:80,slots:2;city=revenue:80,slots:2` -- TWO separate
///   2-slot cities, and the only tile in 1830 shaped that way. It is the
///   tile that makes pooled per-hex slot counting unsalvageable.
///
/// Empty for any tile with no city at all, which is the signal that nothing
/// can ever be tokened or blockaded there.
pub fn tile_city_slot_counts(tile_id: u32) -> &'static [u32] {
    match tile_id {
        53 | 57 | 61 => &[1],
        14 | 15 | 63 => &[2],
        54 | 59 | 64 | 65 | 66 | 67 | 68 => &[1, 1],
        62 => &[2, 2],
        _ => &[],
    }
}

/// How many Station Token slots hex `(q, r)` offers when NO tile has been
/// laid on it -- the preprinted-artwork counterpart to `tile_city_slots`.
///
/// Only the hexes whose real 1830 printing already carries a city marker
/// have any:
///
/// - New York (`LANDMARK_HEXES`) prints `city=revenue:40;city=revenue:40` --
///   two one-slot cities, so 2.
/// - The four `OO_DESIGNATED_HEXES` print `city=revenue:0;city=revenue:0` --
///   likewise 2.
/// - Boston and Baltimore (the other two landmarks) and every
///   `CITY_DESIGNATED_HEXES` entry print a single city -- 1. That list's six
///   gray cities matter most here: module doc comment #19 made them
///   permanently un-layable, so `MAP_GRID` never holds a `Tile` there and
///   this lookup is the ONLY source of their slot count, forever.
///
/// A preprinted TOWN, a bare gray connector, an off-board terminal, or an
/// ordinary blank hex has no token slot at all and so can never be
/// blockaded.
pub fn preprinted_city_slots(q: i32, r: i32) -> u32 {
    // Audit G-12: derived, not restated -- see `tile_city_slots`.
    preprinted_city_slot_counts(q, r).iter().sum()
}

/// The per-city counterpart to `preprinted_city_slot_counts`' own totals --
/// how many slots each city on a hex with NO laid tile offers (Audit G-12).
///
/// New York and the four OO hexes print TWO cities of one slot each, not one
/// city of two slots, and the difference is exactly the bug this pass
/// exists for: two rivals tokening New York's printed artwork fill both of
/// its cities, whereas the pooled reading saw "2 of 2 slots" only once both
/// happened to land on the same hex regardless of which city each took.
pub fn preprinted_city_slot_counts(q: i32, r: i32) -> &'static [u32] {
    if landmark_name_at(q, r) == Some("New York") || oo_designation_name_at(q, r).is_some() {
        return &[1, 1];
    }
    if landmark_name_at(q, r).is_some() || city_designation_name_at(q, r).is_some() {
        return &[1];
    }
    &[]
}

/// WHICH city each of `tile_id`'s track segments runs through, one entry per
/// segment, parallel to `tile_paths_for(tile_id)` (and to the rotated list
/// `effective_tile_paths` returns -- `rotate_paths` maps each segment in
/// place and preserves order, so index `i` means the same segment either
/// way).
///
/// **Audit G-13.** This is the lookup that makes a route's blockade check
/// city-granular instead of hex-granular. Without it the engine can tell
/// that SOME city on a hex is open but not WHICH, so a route could enter a
/// tile through a fully-tokened city's track and leave through it again,
/// "ghost routing" straight past a blockade that in real 1830 is the whole
/// point of having placed those tokens.
///
/// `Some(i)` -- this segment passes through city `i`, whose capacity is
/// `tile_city_slot_counts(tile_id)[i]`.
///
/// `None` -- one of two very different situations, which the caller MUST
/// distinguish by checking whether the hex has any cities at all:
///   - the tile genuinely has no city (plain track, or a town, which is a
///     revenue stop that holds no token) -- nothing can ever block it; or
///   - the segment list does not line up with the city list, which today
///     means a synthesized overlay tile standing in for preprinted artwork
///     (`pathfinding::synthetic_overlay_tile`, a fully-connected virtual
///     tile whose 15 canonical segments carry no city information at all).
///     A caller that finds `None` on a hex that DOES have cities must fall
///     back to the strictest city's answer, never the most permissive one --
///     guessing permissively is exactly the ghost route this exists to stop.
///
/// THE INDEX CORRESPONDENCE IS THE LOAD-BEARING CLAIM, so here it is
/// explicitly, checked against each tile's own 18xx source string recorded
/// in `TILE_CATALOG`. Every multi-city tile in 1830 has exactly one segment
/// per city, and `TILE_CATALOG` lists them in city order:
///
/// - `#54`/`#62` `path=a:0,b:_0;path=a:_0,b:1;path=a:2,b:_1;path=a:_1,b:3`
///   -> city 0 owns edges 0-1, city 1 owns edges 2-3; catalog `[(0,1),(2,3)]`.
/// - `#59` `path=a:0,b:_0;path=a:2,b:_1` -> catalog `[(0,0),(2,2)]`.
/// - `#64` `_0` = edges 0-2, `_1` = edges 3-4; catalog `[(0,2),(3,4)]`.
/// - `#65` `_0` = 0-4, `_1` = 2-3; catalog `[(0,4),(2,3)]`.
/// - `#66` `_0` = 0-3, `_1` = 1-2; catalog `[(0,3),(1,2)]`.
/// - `#67` `_0` = 0-3, `_1` = 2-4; catalog `[(0,3),(2,4)]`.
/// - `#68` `_0` = 0-3, `_1` = 1-4; catalog `[(0,3),(1,4)]`.
///
/// `tile_segment_cities_agree_with_catalog_path_counts` asserts the
/// one-segment-per-city shape for all of them, so a future catalog edit that
/// breaks the correspondence fails the suite rather than silently
/// reintroducing ghost routing.
///
/// `segment_count` is passed rather than read from the catalog because the
/// caller may be working from a `Tile`'s OWN stored `paths` list, which
/// `effective_base_tile_paths` prefers over the catalog. If that stored list
/// has a different length than the catalog's, the correspondence cannot be
/// trusted and every entry comes back `None` -- conservative by
/// construction.
pub fn tile_segment_cities(tile_id: u32, segment_count: usize) -> Vec<Option<u8>> {
    let cities = tile_city_slot_counts(tile_id).len();
    match cities {
        // No city on this tile -- nothing here can ever be blockaded.
        0 => vec![None; segment_count],
        // One city, and every segment on the tile runs through it: the
        // multi-spoke city hubs (#14/#15/#53/#61/#63) and the single
        // straight-through city (#57).
        1 => vec![Some(0); segment_count],
        // One segment per city, in city order.
        n if n == segment_count => (0..segment_count).map(|i| u8::try_from(i).ok()).collect(),
        // Shape we cannot interpret -- see the `None` discussion above.
        _ => vec![None; segment_count],
    }
}

/// Every city on hex `(q, r)` and its slot count -- the laid tile's own
/// breakdown if a tile is there, otherwise the preprinted artwork's.
/// Empty means the hex has no city, so it can never be tokened or blockaded.
pub fn city_slot_counts_at(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
) -> Result<&'static [u32], StdError> {
    if let Some(tile) = MAP_GRID.may_load(storage, (game_id, q, r))? {
        return Ok(tile_city_slot_counts(tile.tile_id));
    }
    Ok(preprinted_city_slot_counts(q, r))
}

/// Every Station Token standing on hex `(q, r)`, as `(protocol_id,
/// city_index)` -- Audit G-12, and the single read path for token occupancy.
///
/// Reads `HEX_STATION_TOKENS`, then RECONSTRUCTS anything that map does not
/// know about from `PROTOCOL_STATION_HEXES`, assigning it `city_index` 0.
/// That backfill is what makes this change safe to deploy over a game
/// already in progress: tokens placed before G-12 exist only in the
/// hex-keyed list, and silently dropping them would delete live blockades
/// mid-game. City 0 is the honest reconstruction -- it is precisely the
/// assumption the pre-G-12 code made -- and it is exactly right for every
/// single-city hex, which is most of the board.
///
/// Idempotent, and safe to call on a hex holding a mix of pre- and post-G-12
/// tokens: a company already named in `HEX_STATION_TOKENS` is never added a
/// second time.
pub fn hex_token_occupants(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
) -> Result<Vec<(u32, u8)>, StdError> {
    let mut occupants: Vec<(u32, u8)> = HEX_STATION_TOKENS
        .may_load(storage, (game_id, q, r))?
        .unwrap_or_default();
    for (company_id, _) in CORE_PUBLIC_COMPANIES.iter().copied() {
        if occupants.iter().any(|(id, _)| *id == company_id) {
            continue;
        }
        let hexes: Vec<(i32, i32)> = PROTOCOL_STATION_HEXES
            .may_load(storage, (game_id, company_id))?
            .unwrap_or_default();
        if hexes.contains(&(q, r)) {
            occupants.push((company_id, 0));
        }
    }
    Ok(occupants)
}

/// How many tokens sit in city `city_index` on this hex.
pub fn city_occupancy(occupants: &[(u32, u8)], city_index: u8) -> u32 {
    occupants
        .iter()
        .filter(|(_, city)| *city == city_index)
        .count() as u32
}

/// The lowest-indexed city on this hex that still has a free slot, or `None`
/// if every city is full. Used to resolve a `PlaceStationToken` that does not
/// name a city, which keeps the message backwards compatible: a client that
/// predates `city_index` still lands somewhere legal rather than being
/// rejected, and on a single-city hex "somewhere legal" is the only city.
pub fn first_open_city(slot_counts: &[u32], occupants: &[(u32, u8)]) -> Option<u8> {
    slot_counts.iter().enumerate().find_map(|(index, capacity)| {
        let city_index = u8::try_from(index).ok()?;
        (city_occupancy(occupants, city_index) < *capacity).then_some(city_index)
    })
}

/// Breadth-first-walks `protocol_id`'s laid tiles outward from its Token
/// Station (Node) -- `PROTOCOL_NETWORK_HEXES`'s first entry -- following
/// only edges that are actually live (post-rotation) on both sides of each
/// hop, and returns every hex reached (the station itself included), along
/// with the station's own coordinates if one exists yet. See module doc
/// comment #9 for why this is recomputed fresh from the live `MAP_GRID`
/// board on every call rather than trusted from history.
fn station_reachable_hexes(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<(Option<(i32, i32)>, HashSet<(i32, i32)>), HexMapError> {
    let network_hexes: Vec<(i32, i32)> = PROTOCOL_NETWORK_HEXES
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default();
    let station = match network_hexes.first() {
        Some(home) => *home,
        None => return Ok((None, HashSet::new())),
    };

    let mut visited: HashSet<(i32, i32)> = HashSet::from([station]);
    let mut queue: VecDeque<(i32, i32)> = VecDeque::from([station]);

    while let Some(current) = queue.pop_front() {
        let current_tile: Option<Tile> =
            MAP_GRID.may_load(storage, (game_id, current.0, current.1))?;
        let Some(current_tile) = current_tile else {
            continue;
        };
        let current_actual = rotate_connections(current_tile.connections, current_tile.orientation);

        for edge in 0..6u8 {
            if current_actual & (1u8 << edge) == 0 {
                continue;
            }
            let (dq, dr) = HEX_NEIGHBOR_OFFSETS[edge as usize];
            let neighbor = (current.0 + dq, current.1 + dr);
            if visited.contains(&neighbor) {
                continue;
            }

            let neighbor_tile: Option<Tile> =
                MAP_GRID.may_load(storage, (game_id, neighbor.0, neighbor.1))?;
            let Some(neighbor_tile) = neighbor_tile else {
                continue;
            };
            let neighbor_actual =
                rotate_connections(neighbor_tile.connections, neighbor_tile.orientation);
            let opposite_edge = (edge + 3) % 6;
            if neighbor_actual & (1u8 << opposite_edge) == 0 {
                continue;
            }

            visited.insert(neighbor);
            queue.push_back(neighbor);
        }
    }

    Ok((Some(station), visited))
}

/// Tests every `TILE_CATALOG` entry across all six rotations against the
/// same three placement rules `execute_lay_tile` enforces -- Tech Era
/// color-locking (module doc comment #8), Landmark Reservation (#11), and
/// either fresh-placement Path Connectivity to `protocol_id`'s Token
/// Station network (#9, if `(q, r)` is empty) or Topology-Retention upgrade
/// edge preservation (#10, if `(q, r)` is already occupied) -- and returns
/// every `(tile_id, orientation)` pairing that would currently be accepted.
/// Backs `QueryMsg::GetLegalTilePlacements` (see
/// `query::query_legal_tile_placements`) so a frontend can show a player
/// only the choices a live `LayTile` call would actually accept.
///
/// Read-only: takes `&dyn Storage` rather than `DepsMut`, and never charges
/// a treasury, checks President authorization, checks Operating Round Turn
/// Queue position, or writes any state, unlike `execute_lay_tile` itself --
/// see `QueryMsg::GetLegalTilePlacements`'s doc comment for why those three
/// are deliberately out of scope here.
///
/// MAINTENANCE NOTE: this function's per-rotation legality checks are
/// intentionally kept in lockstep with `execute_lay_tile`'s own -- they're
/// independent implementations of the same three rules (not a shared
/// helper the two call into), so any future change to one's placement
/// logic must be mirrored in the other, or this query will start
/// disagreeing with what `LayTile` actually accepts.
pub fn legal_tile_placements(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
) -> Result<Vec<(u32, u8)>, HexMapError> {
    let session: GameSession = SESSIONS
        .may_load(storage, game_id)?
        .ok_or(HexMapError::GameNotFound { game_id })?;

    // Off-Board Reservation (module doc comment #14): an off-board hex
    // accepts no tile artwork at all -- mirrors execute_lay_tile's own
    // unconditional rejection, checked first since it's disjoint from every
    // other rule below.
    if offboard_name_at(q, r).is_some() {
        return Ok(Vec::new());
    }

    // Gray Hex Immutability (module doc comment #19): a preprinted GRAY
    // hex's real starting track is permanent -- mirrors execute_lay_tile's
    // own unconditional rejection, checked right after Off-Board
    // Reservation for the same reason (disjoint from, and more absolute
    // than, every rule below).
    if gray_preprinted_name_at(q, r).is_some() {
        return Ok(Vec::new());
    }

    // Private-Company-Reserved Hexes (module doc comment #24): mirrors
    // execute_lay_tile's own check, per this function's MAINTENANCE NOTE --
    // B20/F16 are blocked unless `protocol_id` owns the matching private
    // company via `owner_protocol_id` (never a mere player `owner`), lifting
    // once that private is `closed`.
    if private_reserved_hex_blocks(storage, game_id, protocol_id, q, r)? {
        return Ok(Vec::new());
    }

    // Impassable Border Edges (module doc comment #22): mirrors
    // `execute_lay_tile`'s own check, per this function's MAINTENANCE NOTE
    // -- computed once here (per-hex, not per-catalog-entry) and ANDed
    // against each candidate orientation's own rotated connections below,
    // in all three placement branches.
    let blocked_edges = impassable_edge_mask(q, r);

    let existing_tile: Option<Tile> = MAP_GRID.may_load(storage, (game_id, q, r))?;
    let landmark = landmark_name_at(q, r);
    let oo_hex = oo_designation_name_at(q, r);
    let plain_city_reserved = city_designation_name_at(q, r);
    let town_designation = town_designation_at(q, r);

    // Topology Retention Upgrade path only (module doc comment #10):
    // precomputed once rather than per catalog entry. `None` means either
    // the hex is empty (fresh-placement path instead, below) or the
    // existing tile is already Brown, the top tier, with no further
    // upgrade possible -- either way no catalog entry can match an
    // upgrade here.
    let upgrade_expected_color = existing_tile
        .as_ref()
        .and_then(|old_tile| tile_color_for(old_tile.tile_id))
        .and_then(next_tile_color);

    // Path Connectivity path only (module doc comment #9): the protocol's
    // current Token Station network, walked once and reused for every
    // catalog/rotation candidate below, exactly mirroring
    // `execute_lay_tile`'s own `station_reachable_hexes` call.
    let (station, reachable) = if existing_tile.is_none() {
        station_reachable_hexes(storage, game_id, protocol_id)?
    } else {
        (None, HashSet::new())
    };

    let mut results = Vec::new();

    for &(tile_id, base_connections, _cost, terrain, new_color, _quantity, _paths, _revenue) in TILE_CATALOG {
        // Tech Era Color-Locking (mirrors execute_lay_tile).
        if new_color > session.current_global_era {
            continue;
        }

        // Tile Inventory Supply Engine (Audit G-5, mirrors
        // execute_lay_tile's own `consume_tile_from_tray` rejection): a
        // tile whose every physical copy is already on the board is not a
        // legal placement, so it must never be offered as one.
        //
        // Deliberately the LAST of the whole-tile disqualifiers rather than
        // the first: era-locking and the city/town reservation checks below
        // are pure in-memory comparisons, while this one is a storage read.
        // Now that the catalog holds all 46 real 1830 tiles, running the
        // cheap filters first cuts this query's storage reads from 46 to
        // however few tiles are terrain-compatible with this specific hex --
        // typically a handful. See the reordered placement further down.

        // City Reservation (mirrors execute_lay_tile, module doc comment
        // #16, split by module doc comment #18, further split by #26,
        // extended to Baltimore and the Brown tier by #27): an OO hex now
        // requires `DoubleCityHub` specifically, and a "B"/"NY"-labeled
        // hex's own Green- OR Brown-tier upgrade now requires their own
        // dedicated `BostonHub`/`NewYorkHub` terrain specifically -- all
        // three disjoint from the landmark/plain-city `MajorCityHub` match
        // below, which is otherwise unchanged, and from each other.
        let is_hub_tile = terrain == TerrainType::MajorCityHub;
        let is_double_city_tile = terrain == TerrainType::DoubleCityHub;
        let is_boston_hub_tile = terrain == TerrainType::BostonHub;
        let is_new_york_hub_tile = terrain == TerrainType::NewYorkHub;
        // design note #28 (module doc comment #28): the `&& is_upgradeable_tier`
        // guard this used to carry on the "B"/"NY" branches below is REMOVED --
        // see that design note for the full real-1830 sourcing (Boston/
        // Baltimore/New York are each a corporation's own home station, never
        // take a plain Yellow `MajorCityHub` tile at all in the physical game,
        // and go straight to their own dedicated Green tile as their very
        // first lay). Restricting these branches to Green/Brown only let a
        // Yellow `MajorCityHub` tile (tile_id 10) slip through to the generic
        // landmark fallback below at these three hexes specifically -- these
        // branches now apply at every tier, so a Yellow attempt at Boston/
        // Baltimore/New York is rejected here directly instead.
        let city_ok = if oo_hex.is_some() {
            is_double_city_tile
        } else if is_double_city_tile {
            false // a double-city tile is illegal anywhere except an OO hex
        } else if is_b_label_hex(landmark) {
            is_boston_hub_tile
        } else if is_boston_hub_tile {
            false // a "B"-labeled hub tile is illegal anywhere but a "B"-labeled hex's own Green/Brown upgrade
        } else if landmark == Some("New York") {
            is_new_york_hub_tile
        } else if is_new_york_hub_tile {
            false // a New York hub tile is illegal anywhere but New York's own Green/Brown upgrade
        } else {
            let city_reserved = landmark.or(plain_city_reserved);
            matches!((city_reserved, is_hub_tile), (Some(_), true) | (None, false))
        };
        if !city_ok {
            continue;
        }

        // Town / Double-Town Reservation (mirrors execute_lay_tile, module
        // doc comment #16).
        let is_town_tile = terrain == TerrainType::SmallTown || terrain == TerrainType::DoubleTown;
        let town_ok = matches!((town_designation, is_town_tile), (Some(_), true) | (None, false));
        if !town_ok {
            continue;
        }

        // Tile Inventory Supply Engine (Audit G-5) -- see the note beside
        // the era gate above for why this storage read sits here, after
        // every cheap in-memory filter, rather than at the top of the loop.
        if remaining_tile_count(storage, game_id, tile_id)? == 0 {
            continue;
        }

        if let Some(old_tile) = &existing_tile {
            // Topology Retention Upgrade (mirrors execute_lay_tile).
            let Some(expected_color) = upgrade_expected_color else {
                continue; // already Brown, or the old tile's own color is unknown
            };
            if new_color != expected_color {
                continue;
            }

            let old_actual = rotate_connections(old_tile.connections, old_tile.orientation);
            for orientation in 0..6u8 {
                let candidate = rotate_connections(base_connections, orientation);
                // old_actual must be a subset of candidate -- no old edge
                // may be missing from the new tile's edge set -- and the
                // candidate itself must not cross an impassable border.
                if old_actual & !candidate == 0 && candidate & blocked_edges == 0 {
                    results.push((tile_id, orientation));
                }
            }
        } else if station.is_none() {
            // protocol_id's very first tile ever: unconditionally legal at
            // ANY orientation (mirrors execute_lay_tile exactly -- no
            // connectivity check applies at all to a brand-new Token
            // Station, module doc comment #9), unless that specific
            // orientation would cross an impassable border.
            //
            // BUGFIX: this used to only ever push orientation 0, but
            // `execute_lay_tile`'s own very-first-tile branch (see its
            // `None => { ... }` arm) accepts whichever orientation the
            // caller actually submitted, 0..=5, with no restriction to 0 --
            // there's no existing network yet to validate connectivity
            // against, so nothing about a home hex's facing constrains it
            // to a single rotation. This function's own MAINTENANCE NOTE
            // requires staying in lockstep with `execute_lay_tile`; leaving
            // this at orientation-0-only meant `GetLegalTilePlacements`
            // was silently hiding 5 of the 6 orientations a live `LayTile`
            // call would actually accept for a protocol's home hex.
            for orientation in 0..6u8 {
                if rotate_connections(base_connections, orientation) & blocked_edges == 0 {
                    results.push((tile_id, orientation));
                }
            }
        } else {
            // Fresh placement onto an already-networked protocol: needs at
            // least one rotation with a live edge that legally reaches the
            // existing network (mirrors execute_lay_tile).
            for orientation in 0..6u8 {
                let actual = rotate_connections(base_connections, orientation);
                let mut connects = false;
                for edge in 0..6u8 {
                    if actual & (1u8 << edge) == 0 {
                        continue;
                    }
                    let (dq, dr) = HEX_NEIGHBOR_OFFSETS[edge as usize];
                    let neighbor = (q + dq, r + dr);
                    if !reachable.contains(&neighbor) {
                        continue;
                    }
                    let neighbor_tile: Option<Tile> =
                        MAP_GRID.may_load(storage, (game_id, neighbor.0, neighbor.1))?;
                    if let Some(neighbor_tile) = neighbor_tile {
                        let neighbor_actual = rotate_connections(
                            neighbor_tile.connections,
                            neighbor_tile.orientation,
                        );
                        let opposite_edge = (edge + 3) % 6;
                        if neighbor_actual & (1u8 << opposite_edge) != 0 {
                            connects = true;
                            break;
                        }
                    }
                }
                // Also mirrors execute_lay_tile's Impassable Border Edges
                // check: a connecting orientation is still illegal if it
                // would carry track across a blocked edge.
                if connects && actual & blocked_edges == 0 {
                    results.push((tile_id, orientation));
                }
            }
        }
    }

    Ok(results)
}

/// Lays hex tile `tile_id`, at the caller-chosen `orientation`, at axial
/// coordinate `(q, r)` on behalf of `protocol_id` -- either onto a
/// currently-empty hex, or as a Topology-Retention Upgrade of the tile
/// already there (module doc comment #10). See the module doc comment
/// (#4) for the full design of why `orientation` is validated rather than
/// auto-picked. Requires:
/// - `orientation` is `0..=5` (`InvalidOrientation` otherwise).
/// - `info.sender` is `protocol_id`'s registered `PROTOCOL_PRESIDENT`.
/// - `protocol_id` is the corporation currently pointed to by
///   `GameSession::active_corporation_index`, whenever the room has a
///   non-empty Operating Round Turn Queue (design note #13).
/// - `protocol_id` has floated and its treasury covers the tile's terrain
///   cost -- a fresh placement onto empty land only; a color upgrade is
///   always free (design note #12).
/// - `tile_id`'s `TileColor` is unlocked under the room's
///   `current_global_era` (design note #8).
/// - `(q, r)`'s landmark status (if any) matches `tile_id`'s terrain
///   classification (design note #11).
/// - If `(q, r)` is empty: `tile_id` rotated to exactly the submitted
///   `orientation` legally connects, with a verified unbroken path, to
///   `protocol_id`'s Token Station (Node) network (waived for that
///   protocol's very first tile, which is always accepted -- at whichever
///   orientation was submitted -- as its home hex/Token Station -- design
///   note #9).
/// - If `(q, r)` is already occupied: `tile_id` is exactly one color tier
///   above the existing tile, and `tile_id` rotated to exactly the
///   submitted `orientation` preserves every one of the existing tile's
///   actual edges (design note #10).
pub fn execute_lay_tile(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
    tile_id: u32,
    orientation: u32,
) -> Result<Response, HexMapError> {
    // Validated first, before any storage access: a pure shape check on the
    // caller's input, independent of game/room state (module doc comment
    // #4). `u8::try_from` also rejects any `orientation` that wouldn't even
    // fit in the six-bit rotation domain `rotate_connections`/`Tile` use
    // internally.
    let orientation: u8 = u8::try_from(orientation)
        .ok()
        .filter(|o| *o < 6)
        .ok_or(HexMapError::InvalidOrientation { orientation })?;

    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(HexMapError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(HexMapError::GameNotActive { game_id });
    }

    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HexMapError::NoPresidentAssigned { protocol_id })?;
    if info.sender != president {
        return Err(HexMapError::NotPresident { protocol_id });
    }

    // Operating Round Corporation Turn Queue (module doc comment #13):
    // layered on top of the President check above, only enforced once the
    // room actually has a non-empty `active_operating_order`.
    if let Some(&expected_protocol_id) = session
        .active_operating_order
        .get(session.active_corporation_index as usize)
    {
        if protocol_id != expected_protocol_id {
            return Err(HexMapError::NotYourOperatingTurn {
                game_id,
                protocol_id,
                expected_protocol_id,
            });
        }
    }

    let mut company: PublicCompany = PUBLIC_COMPANIES
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HexMapError::PublicCompanyNotFound {
            game_id,
            company_id: protocol_id,
        })?;
    if !company.is_floated {
        return Err(HexMapError::CompanyNotFloated {
            company_id: protocol_id,
        });
    }


    // ==== Audit G-14: Operating Round sub-phase gate. ====
    // Strict equality against the persisted cursor -- see `or_phase`'s module
    // doc for the six-phase order and which phases may be skipped. Being PAST
    // a phase fails as loudly as being before it.
    if let Err(mismatch) = or_phase::require_sub_phase(
        deps.storage,
        &session,
        protocol_id,
        OperatingSubPhase::Track,
    ) {
        return Err(match mismatch {
            or_phase::PhaseMismatch::Wrong { actual, required } => HexMapError::WrongOperatingSubPhase {
                protocol_id,
                actual: or_phase::phase_name(actual).to_string(),
                actual_index: or_phase::phase_index(actual),
                required: or_phase::phase_name(required).to_string(),
                required_index: or_phase::phase_index(required),
            },
            or_phase::PhaseMismatch::Storage(message) => HexMapError::Std(StdError::generic_err(message)),
        });
    }

    // Audit G-10: the catalog's `cost` field is now uniformly `0` and is no
    // longer read here -- a hex's build fee comes from the HEX
    // (`terrain_build_fee`, below), never from the tile artwork laid on it.
    // The field is retained in the tuple only so the catalog's shape stays
    // stable for `query.rs`'s renderer and any future per-tile pricing.
    let (base_connections, terrain, new_color, base_paths) = TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, connections, _cost, terrain, color, _qty, paths, _revenue)| (connections, terrain, color, paths))
        .ok_or(HexMapError::TileNotFound { tile_id })?;

    // Tech Era Color-Locking (module doc comment #8): reject outright if
    // this tile's color tier isn't yet unlocked room-wide, before checking
    // anything else about the placement itself.
    if new_color > session.current_global_era {
        return Err(HexMapError::EraLocked {
            game_id,
            tile_id,
            tile_color: new_color,
            current_era: session.current_global_era,
        });
    }

    // Tile Inventory Supply Engine (Audit G-5): reject a tile whose every
    // physical copy is already on the board, before any placement geometry
    // is evaluated and long before the treasury is charged. This is a
    // read-only pre-check purely for clean error ordering and to honor this
    // function's Checks-Effects-Interactions discipline; the authoritative
    // decrement happens in the Effects section below, via
    // `consume_tile_from_tray`, which re-validates the same condition.
    // Nothing between here and there can change the tray.
    let remaining_before = remaining_tile_count(deps.storage, game_id, tile_id)?;
    if remaining_before == 0 {
        return Err(HexMapError::TileSupplyExhausted {
            game_id,
            tile_id,
            starting_quantity: tile_starting_quantity(tile_id).unwrap_or(0),
        });
    }

    // Off-Board Reservation (module doc comment #14): an off-board hex
    // accepts no tile artwork at all, regardless of terrain type -- checked
    // before Landmark Reservation since the two reserved-hex sets are
    // disjoint and this is the more absolute restriction of the two.
    if let Some(offboard_name) = offboard_name_at(q, r) {
        return Err(HexMapError::OffboardHexNotBuildable {
            offboard_name: offboard_name.to_string(),
            q,
            r,
            hex_label: describe_hex(q, r),
            tile_id,
        });
    }

    // Gray Hex Immutability (module doc comment #19): a preprinted GRAY
    // hex's real starting track is permanent -- nothing may ever be laid
    // here, checked right after Off-Board Reservation for the same reason
    // (disjoint from, and more absolute than, every rule below).
    if let Some(gray_name) = gray_preprinted_name_at(q, r) {
        return Err(HexMapError::GrayHexNotUpgradeable {
            gray_hex_name: gray_name.to_string(),
            q,
            r,
            hex_label: describe_hex(q, r),
            tile_id,
        });
    }

    // Impassable Border Edges (module doc comment #22): a fixed set of hex
    // borders across which track may never be built, checked right after
    // Gray Hex Immutability for the same reason (an absolute, structural
    // restriction, disjoint from the terrain/city/town matching rules
    // below) -- unlike those two checks, this one doesn't reject the whole
    // hex, only the specific candidate orientation if it would leave a live
    // edge on one of this hex's blocked crossings.
    let blocked_edges = impassable_edge_mask(q, r);
    if blocked_edges != 0 {
        let requested_connections = rotate_connections(base_connections, orientation);
        if let Some(edge) = (0..6u8).find(|edge| {
            requested_connections & blocked_edges & (1u8 << *edge) != 0
        }) {
            return Err(HexMapError::TrackCrossesImpassableEdge {
                edge,
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
                orientation,
            });
        }
    }

    // Private-Company-Reserved Hexes (module doc comment #24): B20 and F16
    // are strictly blocked against track laying by any public company unless
    // that company's own protocol owns the matching private company (via
    // `owner_protocol_id`, never a mere player `owner`) -- checked right
    // after Impassable Border Edges since it too is an absolute, structural
    // restriction on the whole hex, disjoint from the terrain/city/town
    // matching rules below. The block lifts once the private is `closed`
    // (Phase 5 closes every remaining private globally).
    if private_reserved_hex_blocks(deps.storage, game_id, protocol_id, q, r)? {
        let (hex_label, private_id) = private_reserved_hex_at(q, r)
            .map(|(label, private_id)| (label.to_string(), private_id))
            .unwrap_or_else(|| (describe_hex(q, r), 0));
        return Err(HexMapError::HexReservedForUnownedPrivate {
            private_id,
            protocol_id,
            q,
            r,
            hex_label,
        });
    }

    // City Reservation (module doc comment #11, generalized by #16, split
    // by #18, further split by #26, extended to Baltimore and the Brown
    // tier by #27): a landmark OR a preprinted plain-city hex
    // (`CITY_DESIGNATED_HEXES`) only ever accepts its designated
    // `MajorCityHub` artwork; an OO hex (`OO_DESIGNATED_HEXES`) only ever
    // accepts its designated `DoubleCityHub` artwork instead; a "B"/"NY"-
    // labeled hex's own Green-OR-Brown-tier upgrade is narrower still
    // (module doc comment #26/#27, "Canonical Tile Upgrade Restrictions") --
    // real 1830 labels Boston and Baltimore "B" and New York "NY", and
    // restricts each hex's Green AND Brown upgrade specifically to one
    // dedicated tile apiece per tier, not the generic `MajorCityHub` every
    // other landmark/city hex accepts. Checked in this order (OO, then "B",
    // then "NY", then the generic landmark/city fallback) since each
    // branch's tile-side check (`is_double_city_tile`/`is_boston_hub_tile`/
    // `is_new_york_hub_tile`) would otherwise slip through the next branch
    // down as neither cleanly "true" nor "false". A hub tile of any of
    // these four kinds may only ever be laid at its own matching reserved
    // hex.
    let landmark = landmark_name_at(q, r);
    let oo_hex = oo_designation_name_at(q, r);
    let is_double_city_tile = terrain == TerrainType::DoubleCityHub;
    let is_boston_hub_tile = terrain == TerrainType::BostonHub;
    let is_new_york_hub_tile = terrain == TerrainType::NewYorkHub;
    // design note #28: the old `is_upgradeable_tier` guard is gone from both
    // the "B" and "NY" branches below -- see that design note's own text for
    // why (Boston/Baltimore/New York never take a plain Yellow tile in real
    // 1830; each is a corporation's home station and goes straight to its own
    // dedicated Green tile as its first lay). This is `legal_tile_placements`'s
    // twin change, made here too per this function's own MAINTENANCE NOTE.
    if let Some(oo_name) = oo_hex {
        if !is_double_city_tile {
            return Err(HexMapError::OOHexRequiresDoubleCityHubTile {
                oo_hex_name: oo_name.to_string(),
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
            });
        }
    } else if is_double_city_tile {
        return Err(HexMapError::DoubleCityHubTileMustBeOnOOHex {
            tile_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    } else if is_b_label_hex(landmark) {
        // module doc comment #26/#27/#28: a "B"-labeled hex's Yellow, Green,
        // AND Brown tiles are ALL real-1830 label-restricted now (module doc
        // comment #28 removed the old Yellow exemption -- see that note for
        // why the hex's Yellow start does NOT fall through to the ordinary
        // landmark branch below any more).
        if !is_boston_hub_tile {
            return Err(HexMapError::BHexRequiresBHubTile {
                b_hex_name: landmark.unwrap_or_default().to_string(),
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
            });
        }
    } else if is_boston_hub_tile {
        // A `BostonHub` ("B"-label) tile attempted anywhere other than a
        // "B"-labeled hex's own Green/Brown upgrade (including a "B" hex
        // itself at Yellow, where this terrain never legitimately appears
        // in `TILE_CATALOG` at all -- see module doc comment #26/#27).
        return Err(HexMapError::BHubTileMustBeOnBHex {
            tile_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    } else if landmark == Some("New York") {
        // module doc comment #26/#27/#28: same real-1830 "NY"-label
        // restriction, now Yellow-Green-AND-Brown, mirroring the "B" branch
        // immediately above.
        if !is_new_york_hub_tile {
            return Err(HexMapError::NewYorkHexRequiresNewYorkHubTile {
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
            });
        }
    } else if is_new_york_hub_tile {
        return Err(HexMapError::NewYorkHubTileMustBeOnNewYorkHex {
            tile_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    } else {
        let city_reserved = landmark.or_else(|| city_designation_name_at(q, r));
        let is_hub_tile = terrain == TerrainType::MajorCityHub;
        match (city_reserved, is_hub_tile) {
            (Some(_), true) | (None, false) => {
                // A reserved City hex getting its designated hub tile
                // (including a "B"/"NY"-labeled hex at Yellow, where the
                // ordinary `MajorCityHub` artwork every landmark shares is
                // still exactly right -- module doc comment #26/#27; that
                // hex's Green AND Brown upgrades are both intercepted by the
                // dedicated branches above instead, so this arm no longer
                // sees them), or an ordinary hex getting ordinary track --
                // both legal.
            }
            (Some(name), false) => {
                return Err(HexMapError::LandmarkRequiresHubTile {
                    landmark: name.to_string(),
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    tile_id,
                })
            }
            (None, true) => {
                return Err(HexMapError::HubTileMustBeOnLandmark {
                    tile_id,
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                })
            }
        }
    }

    // Town / Double-Town Reservation (module doc comment #16): a preprinted
    // Town or Double-Town hex (`TOWN_DESIGNATED_HEXES`) only ever accepts a
    // SmallTown/DoubleTown tile, and a SmallTown/DoubleTown tile may only
    // ever be laid at one of these reserved hexes. Symmetric with the City
    // Reservation match above; together the two leave every remaining hex
    // (blank Plain/Mountain/River, and not off-board) accepting only
    // Plain/MountainRugged track, satisfying the third bullet of Rigid
    // On-Chain Tile Matching without a separate rule.
    let town_designation = town_designation_at(q, r);
    let is_town_tile = terrain == TerrainType::SmallTown || terrain == TerrainType::DoubleTown;
    match (town_designation, is_town_tile) {
        (Some(_), true) | (None, false) => {
            // A reserved Town/Double-Town hex getting a matching tile, or
            // an ordinary hex getting non-town track -- both legal.
        }
        (Some((name, is_double)), false) => {
            return Err(HexMapError::TownDesignationRequiresTownTile {
                town_name: name.to_string(),
                designation: if is_double { "Double-Town" } else { "Single-Town" },
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
            })
        }
        (None, true) => {
            return Err(HexMapError::TownTileMustBeOnTownDesignation {
                tile_id,
                q,
                r,
                hex_label: describe_hex(q, r),
            })
        }
    }

    let existing_tile: Option<Tile> = MAP_GRID.may_load(deps.storage, (game_id, q, r))?;
    let mut network_hexes: Vec<(i32, i32)> = PROTOCOL_NETWORK_HEXES
        .may_load(deps.storage, (game_id, protocol_id))?
        .unwrap_or_default();

    // Enforce Chosen Angle: no rotation search here at all -- only the
    // caller's own submitted `orientation` (already bounds-checked to
    // `0..=5` above) is ever evaluated against the placement's legality
    // rule. See module doc comment #4.
    let is_upgrade = match &existing_tile {
        Some(old_tile) => {
            // Topology Retention Upgrade (module doc comment #10).
            let old_color = tile_color_for(old_tile.tile_id).ok_or(HexMapError::TileNotFound {
                tile_id: old_tile.tile_id,
            })?;
            let expected_color =
                next_tile_color(old_color).ok_or(HexMapError::AlreadyMaxColor {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                })?;
            if new_color != expected_color {
                return Err(HexMapError::InvalidColorUpgrade {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    old_color,
                    attempted_color: new_color,
                    expected_color,
                });
            }

            let old_actual = rotate_connections(old_tile.connections, old_tile.orientation);
            let candidate = rotate_connections(base_connections, orientation);
            // Every bit set in old_actual must also be set in candidate --
            // old_actual is a subset of candidate, i.e. no old edge is
            // missing from the new tile's edge set at the submitted
            // orientation specifically.
            if old_actual & !candidate != 0 {
                return Err(HexMapError::TopologyNotPreserved {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    tile_id,
                });
            }
            true
        }
        None => {
            // Path Connectivity to an existing Token Station (Node)
            // (module doc comment #9).
            let (station, reachable) = station_reachable_hexes(deps.storage, game_id, protocol_id)?;
            if station.is_some() {
                // Not protocol_id's first tile -- the submitted
                // orientation specifically must legally reach the existing
                // network; no other rotation is considered.
                let actual = rotate_connections(base_connections, orientation);
                let mut connects = false;
                for edge in 0..6u8 {
                    if actual & (1u8 << edge) == 0 {
                        continue;
                    }
                    let (dq, dr) = HEX_NEIGHBOR_OFFSETS[edge as usize];
                    let neighbor = (q + dq, r + dr);
                    if !reachable.contains(&neighbor) {
                        continue;
                    }
                    let neighbor_tile: Option<Tile> =
                        MAP_GRID.may_load(deps.storage, (game_id, neighbor.0, neighbor.1))?;
                    if let Some(neighbor_tile) = neighbor_tile {
                        let neighbor_actual = rotate_connections(
                            neighbor_tile.connections,
                            neighbor_tile.orientation,
                        );
                        let opposite_edge = (edge + 3) % 6;
                        if neighbor_actual & (1u8 << opposite_edge) != 0 {
                            connects = true;
                            break;
                        }
                    }
                }
                if !connects {
                    return Err(HexMapError::NoLegalConnection {
                        protocol_id,
                        q,
                        r,
                        hex_label: describe_hex(q, r),
                        tile_id,
                    });
                }
            }
            // else: protocol_id's very first tile ever -- becomes its Token
            // Station (Node), unconditionally accepted at whichever
            // orientation the caller submitted (no existing network to
            // validate connectivity against).
            false
        }
    };

    // Terrain Fee Timing (module doc comment #12) + Audit G-10: the real
    // 1830 rule is that a hex's printed terrain fee is paid exactly once,
    // when that hex is first built on -- every later colour upgrade of the
    // same hex is free.
    //
    // The fee is now read from the HEX (`terrain_build_fee(q, r)`: $80
    // river, $120 mountain, $0 clear land) rather than from the tile laid
    // there. That closes both halves of the old exploit: laying an ordinary
    // plain tile onto a real river or mountain hex used to be free, and
    // laying the invented "mountain pass" artwork onto flat grassland used
    // to charge $80 for nothing.
    let effective_terrain_cost = if is_upgrade {
        Uint128::zero()
    } else {
        terrain_build_fee(q, r)
    };

    let new_treasury = company
        .treasury
        .checked_sub(effective_terrain_cost)
        .map_err(|_| HexMapError::InsufficientTreasury {
            company_id: protocol_id,
            required: effective_terrain_cost,
            available: company.treasury,
        })?;

    // All checks passed -- charge the treasury, credit the bank, and
    // persist the (new or upgraded) tile and network membership.
    company.treasury = new_treasury;
    PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

    if !effective_terrain_cost.is_zero() {
        session.virtual_bank_vgp = session
            .virtual_bank_vgp
            .checked_add(effective_terrain_cost)
            .map_err(|_| HexMapError::Overflow {})?;
    }
    // Inactivity Timeout Safety Valve (see `state.rs`'s
    // `GameSession::last_action_timestamp` doc comment): a successful
    // LayTile call -- upgrade or fresh placement, terrain fee or not --
    // resets the room's 48-hour inactivity clock, so this save must happen
    // unconditionally rather than only inside the nonzero-terrain-cost
    // branch above.
    session.last_action_timestamp = env.block.time.seconds();
    SESSIONS.save(deps.storage, game_id, &session)?;

    // Tile Inventory Supply Engine (Audit G-5), Effects half.
    //
    // Order matters: RECYCLE FIRST, then consume. On an upgrade, the tile
    // being lifted off the board returns to the tray before the new one is
    // taken out of it -- so a company can legally spend the tray's very
    // last copy of a tile in the same action that returns a different copy
    // to it, and neither operation can ever observe a transiently negative
    // count. (The two tile_ids always differ here: an upgrade is
    // strictly one colour tier up, so the replaced tile can never be the
    // same artwork as its replacement.)
    if let Some(replaced_tile) = &existing_tile {
        return_tile_to_tray(deps.storage, game_id, replaced_tile.tile_id)?;
    }
    consume_tile_from_tray(deps.storage, game_id, tile_id)?;
    let remaining_after = remaining_tile_count(deps.storage, game_id, tile_id)?;

    let tile = Tile {
        q,
        r,
        tile_id,
        orientation,
        connections: base_connections,
        // Audit G-9: the tile's real internal wiring, stored alongside the
        // flat mask so `pathfinding.rs` can follow specific edge-to-edge
        // segments instead of jumping between unconnected track on the same
        // hex. Base (pre-rotation) pairs, exactly as `TILE_CATALOG` lists
        // them -- `orientation` above is applied at read time by
        // `rotate_paths`, mirroring how `connections` is handled.
        paths: base_paths.to_vec(),
    };
    MAP_GRID.save(deps.storage, (game_id, q, r), &tile)?;

    // Audit G-14: EXACTLY ONE tile lay per turn. Advancing the cursor here is
    // what enforces it -- there was no per-turn tile limit at all before this
    // pass, and a corporation could lay unlimited tiles in a single turn.
    or_phase::advance(deps.storage, game_id, protocol_id, OperatingSubPhase::Track)?;

    if !is_upgrade {
        network_hexes.push((q, r));
        PROTOCOL_NETWORK_HEXES.save(deps.storage, (game_id, protocol_id), &network_hexes)?;
    }

    let mut response = Response::new()
        .add_attribute("action", "lay_tile")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("q", q.to_string())
        .add_attribute("r", r.to_string())
        .add_attribute("hex_label", describe_hex(q, r))
        .add_attribute("tile_id", tile_id.to_string())
        .add_attribute("tile_color", format!("{new_color:?}"))
        .add_attribute("orientation", orientation.to_string())
        .add_attribute("is_upgrade", is_upgrade.to_string())
        .add_attribute("terrain_cost", effective_terrain_cost)
        .add_attribute("company_treasury_remaining", company.treasury)
        .add_attribute(
            "tiles_remaining",
            if remaining_after == UNLIMITED_TILE_SUPPLY {
                "unlimited".to_string()
            } else {
                remaining_after.to_string()
            },
        );

    if let Some(replaced_tile) = &existing_tile {
        response = response
            .add_attribute("recycled_tile_id", replaced_tile.tile_id.to_string())
            .add_attribute(
                "recycled_tile_remaining",
                match remaining_tile_count(deps.storage, game_id, replaced_tile.tile_id)? {
                    UNLIMITED_TILE_SUPPLY => "unlimited".to_string(),
                    n => n.to_string(),
                },
            );
    }

    Ok(response)
}

/// This hex's effective connection bitmask for
/// `station_token_reachable_hexes`'s BFS: a real laid tile's own rotated
/// connections if one exists, else a permissive full-six-edge virtual tile
/// if this is a GRAY preprinted hex (see that function's own doc comment
/// for why), else `None` -- no connectivity at all, an ordinary hex nobody
/// has laid a tile on yet.
fn effective_connections_at(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
) -> Result<Option<u8>, StdError> {
    if let Some(tile) = MAP_GRID.may_load(storage, (game_id, q, r))? {
        return Ok(Some(rotate_connections(tile.connections, tile.orientation)));
    }
    if gray_preprinted_name_at(q, r).is_some() {
        return Ok(Some(0b11_1111));
    }
    Ok(None)
}

/// Station Tokens (module doc comment #23): like `station_reachable_hexes`,
/// but ALSO treats any GRAY preprinted hex (`gray_preprinted_name_at`) as
/// always fully connected on all six edges, matching the same "permissive
/// full-six-edge virtual tile" precedent `pathfinding.rs`'s
/// `effective_tile_and_value` already established for revenue-route tracing
/// (see that module's own doc comment #2, "Board-wide Gray-Hex routing
/// fallback"). Without this, a real, permanently-un-layable GRAY city
/// (Altoona, Cleveland, Montreal, Lansing, Rochester, Richmond) could never
/// be treated as reachable at all, since `MAP_GRID` never holds a `Tile`
/// there (module doc comment #19, Gray Hex Immutability). Deliberately a
/// SEPARATE function from `station_reachable_hexes` rather than a shared
/// one: unlike that function, this one is used ONLY by
/// `execute_place_station_token`, never by `execute_lay_tile`'s own
/// connectivity/legality checks, which stay exactly as strict as before
/// this feature -- module doc comment #23's "DELIBERATELY DECOUPLED"
/// paragraph already covers why the two systems aren't unified, and this is
/// that same boundary: reachability for TOKENS may see further (through
/// permanent gray track) than reachability for LAYING NEW TILES does.
fn station_token_reachable_hexes(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<(Option<(i32, i32)>, HashSet<(i32, i32)>), HexMapError> {
    let network_hexes: Vec<(i32, i32)> = PROTOCOL_NETWORK_HEXES
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default();
    let station = match network_hexes.first() {
        Some(home) => *home,
        None => return Ok((None, HashSet::new())),
    };

    let mut visited: HashSet<(i32, i32)> = HashSet::from([station]);
    let mut queue: VecDeque<(i32, i32)> = VecDeque::from([station]);

    while let Some(current) = queue.pop_front() {
        let Some(current_actual) = effective_connections_at(storage, game_id, current.0, current.1)?
        else {
            continue;
        };

        for edge in 0..6u8 {
            if current_actual & (1u8 << edge) == 0 {
                continue;
            }
            let (dq, dr) = HEX_NEIGHBOR_OFFSETS[edge as usize];
            let neighbor = (current.0 + dq, current.1 + dr);
            if visited.contains(&neighbor) {
                continue;
            }

            let Some(neighbor_actual) =
                effective_connections_at(storage, game_id, neighbor.0, neighbor.1)?
            else {
                continue;
            };
            let opposite_edge = (edge + 3) % 6;
            if neighbor_actual & (1u8 << opposite_edge) == 0 {
                continue;
            }

            visited.insert(neighbor);
            queue.push_back(neighbor);
        }
    }

    Ok((Some(station), visited))
}

/// Places `protocol_id`'s next Station Token at `(q, r)`, at the flat cost
/// `station_token_cost` prices for that token's ordinal position. See
/// module doc comment #23 for the full design and every check below's
/// rationale; this function covers every token AFTER the free home one
/// (that one is granted automatically at float by
/// `grant_home_station_token`, not through this action).
pub fn execute_place_station_token(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
    // Audit G-12: WHICH city on `(q, r)` this token takes. `None` means "the
    // caller did not say", which resolves to the lowest-indexed city with a
    // free slot -- this keeps every pre-G-12 client working unchanged, and on
    // a single-city hex it is the only possible answer anyway.
    // (`//`, not `///`: Rust rejects doc comments on function parameters.)
    city_index: Option<u8>,
) -> Result<Response, HexMapError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(HexMapError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(HexMapError::GameNotActive { game_id });
    }

    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HexMapError::NoPresidentAssigned { protocol_id })?;
    if info.sender != president {
        return Err(HexMapError::NotPresident { protocol_id });
    }

    // Operating Round Corporation Turn Queue -- identical gate to
    // `execute_lay_tile`'s own (module doc comment #13).
    if let Some(&expected_protocol_id) = session
        .active_operating_order
        .get(session.active_corporation_index as usize)
    {
        if protocol_id != expected_protocol_id {
            return Err(HexMapError::NotYourOperatingTurn {
                game_id,
                protocol_id,
                expected_protocol_id,
            });
        }
    }

    let mut company: PublicCompany = PUBLIC_COMPANIES
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HexMapError::PublicCompanyNotFound {
            game_id,
            company_id: protocol_id,
        })?;
    if !company.is_floated {
        return Err(HexMapError::CompanyNotFloated {
            company_id: protocol_id,
        });
    }

    // Target hex must already be a real city (module doc comment #23) -- a
    // Station Token marks an existing city stop, it doesn't lay track of
    // its own. Two ways to qualify: an ordinary landmark/city-designated/OO
    // hex with a laid `MajorCityHub`/`DoubleCityHub` tile, OR one of the six
    // real GRAY preprinted cities (Altoona, Cleveland, Montreal, Lansing,
    // Rochester, Richmond) -- these can NEVER receive a laid tile at all
    // (Gray Hex Immutability, module doc comment #19), so they'd otherwise
    // be permanently untokenable despite being real, always-active cities.
    let existing_tile: Option<Tile> = MAP_GRID.may_load(deps.storage, (game_id, q, r))?;
    // module doc comment #26: `BostonHub`/`NewYorkHub` are two MORE laid-city
    // terrains, alongside `MajorCityHub`/`DoubleCityHub`, that make a hex a
    // real, tokenable city -- Boston/New York's Green-tier restriction only
    // changes WHICH tile artwork may be laid there (module doc comment #26's
    // City Reservation split above), not whether the result still counts as
    // a real city once laid.
    let is_laid_hub_tile = existing_tile
        .as_ref()
        .and_then(|tile| tile_terrain_for(tile.tile_id))
        .is_some_and(|terrain| {
            matches!(
                terrain,
                TerrainType::MajorCityHub
                    | TerrainType::DoubleCityHub
                    | TerrainType::BostonHub
                    | TerrainType::NewYorkHub
            )
        });
    let is_gray_city =
        gray_preprinted_name_at(q, r).is_some() && city_designation_name_at(q, r).is_some();
    if !is_laid_hub_tile && !is_gray_city {
        return Err(HexMapError::StationTokenHexNotACity {
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    }

    // Reachability: `station_token_reachable_hexes` mirrors
    // `execute_lay_tile`'s own `station_reachable_hexes` BFS, but ALSO
    // treats a GRAY preprinted hex as always fully connected -- the same
    // "permissive full-six-edge virtual tile" precedent `pathfinding.rs`'s
    // `effective_tile_and_value` already established for revenue tracing
    // (see that module's own doc comment #2). Read-only; never mutates
    // `PROTOCOL_NETWORK_HEXES` (module doc comment #23's "DELIBERATELY
    // DECOUPLED" paragraph).
    let (station, reachable) = station_token_reachable_hexes(deps.storage, game_id, protocol_id)?;
    let is_reachable = station == Some((q, r)) || reachable.contains(&(q, r));
    if !is_reachable {
        return Err(HexMapError::StationTokenHexNotReachable {
            protocol_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    }

    let mut token_hexes: Vec<(i32, i32)> = PROTOCOL_STATION_HEXES
        .may_load(deps.storage, (game_id, protocol_id))?
        .unwrap_or_default();
    if token_hexes.contains(&(q, r)) {
        return Err(HexMapError::StationTokenAlreadyOnHex {
            protocol_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    }


    // ==== Audit G-14: Operating Round sub-phase gate. ====
    // Strict equality against the persisted cursor -- see `or_phase`'s module
    // doc for the six-phase order and which phases may be skipped.
    if let Err(mismatch) = or_phase::require_sub_phase(
        deps.storage,
        &session,
        protocol_id,
        OperatingSubPhase::Tokens,
    ) {
        return Err(match mismatch {
            or_phase::PhaseMismatch::Wrong { actual, required } => HexMapError::WrongOperatingSubPhase {
                protocol_id,
                actual: or_phase::phase_name(actual).to_string(),
                actual_index: or_phase::phase_index(actual),
                required: or_phase::phase_name(required).to_string(),
                required_index: or_phase::phase_index(required),
            },
            or_phase::PhaseMismatch::Storage(message) => HexMapError::Std(StdError::generic_err(message)),
        });
    }

    // ==== Audit G-12: PER-CITY CAPACITY. ====
    //
    // There was no capacity check here at all before this pass -- only the
    // "not twice on the same hex" check above and the company's own token
    // limit below. Nothing stopped every corporation in the game from
    // tokening the same 1-slot city, which is the rule that makes contested
    // cities contested in the first place.
    //
    // Checked per CITY, never per hex: a hex is not a city. #62 carries two
    // separate 2-slot cities and #54/#59/#64-#68 two separate 1-slot cities,
    // so a hex-level "is there room" question has no correct answer on any
    // of them.
    let slot_counts = city_slot_counts_at(deps.storage, game_id, q, r)?;
    let occupants = hex_token_occupants(deps.storage, game_id, q, r)?;
    let chosen_city = match city_index {
        Some(requested) => {
            if usize::from(requested) >= slot_counts.len() {
                return Err(HexMapError::StationTokenCityIndexOutOfRange {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    requested,
                    city_count: u8::try_from(slot_counts.len()).unwrap_or(u8::MAX),
                });
            }
            let capacity = slot_counts[usize::from(requested)];
            if city_occupancy(&occupants, requested) >= capacity {
                return Err(HexMapError::StationTokenCityFull {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    city_index: requested,
                    slots: capacity,
                });
            }
            requested
        }
        // No city named: take the lowest-indexed one with room. If EVERY city
        // is full the hex is genuinely closed, and that is a rejection rather
        // than a silent overflow into a full city.
        None => first_open_city(slot_counts, &occupants).ok_or_else(|| {
            HexMapError::StationTokenCityFull {
                q,
                r,
                hex_label: describe_hex(q, r),
                city_index: 0,
                slots: slot_counts.first().copied().unwrap_or(0),
            }
        })?,
    };

    let limit = station_token_limit(protocol_id);
    if token_hexes.len() >= usize::from(limit) {
        return Err(HexMapError::StationTokenLimitReached { protocol_id, limit });
    }

    // One placement per Operating Round sub-round.
    let current_subround = (session.macro_round_number, session.sub_round_index);
    if PROTOCOL_LAST_TOKEN_SUBROUND.may_load(deps.storage, (game_id, protocol_id))?
        == Some(current_subround)
    {
        return Err(HexMapError::StationTokenAlreadyPlacedThisSubRound {
            protocol_id,
            macro_round_number: current_subround.0,
            sub_round_index: current_subround.1,
        });
    }

    let token_ordinal = u8::try_from(token_hexes.len() + 1).map_err(|_| HexMapError::Overflow {})?;
    let cost = station_token_cost(token_ordinal);

    let new_treasury =
        company
            .treasury
            .checked_sub(cost)
            .map_err(|_| HexMapError::InsufficientTreasuryForStationToken {
                company_id: protocol_id,
                required: cost,
                available: company.treasury,
            })?;

    company.treasury = new_treasury;
    PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

    if !cost.is_zero() {
        session.virtual_bank_vgp = session
            .virtual_bank_vgp
            .checked_add(cost)
            .map_err(|_| HexMapError::Overflow {})?;
    }
    session.last_action_timestamp = env.block.time.seconds();
    SESSIONS.save(deps.storage, game_id, &session)?;

    PROTOCOL_LAST_TOKEN_SUBROUND.save(deps.storage, (game_id, protocol_id), &current_subround)?;

    token_hexes.push((q, r));
    let tokens_placed = token_hexes.len();
    PROTOCOL_STATION_HEXES.save(deps.storage, (game_id, protocol_id), &token_hexes)?;

    // Audit G-12: the per-city registry, written in the same commit as the
    // hex list above so the two can never disagree about whether a token
    // exists. Re-loaded rather than reusing `occupants` because that vector
    // includes the city-0 reconstruction of any legacy token, which must NOT
    // be persisted -- reconstruction is a read-time fallback, and writing it
    // back would freeze a guess into storage as though it were a record.
    let mut hex_tokens: Vec<(u32, u8)> = HEX_STATION_TOKENS
        .may_load(deps.storage, (game_id, q, r))?
        .unwrap_or_default();
    hex_tokens.push((protocol_id, chosen_city));
    HEX_STATION_TOKENS.save(deps.storage, (game_id, q, r), &hex_tokens)?;

    // Audit G-14: one token placement per turn -- advance past Tokens.
    or_phase::advance(deps.storage, game_id, protocol_id, OperatingSubPhase::Tokens)?;

    Ok(Response::new()
        .add_attribute("action", "place_station_token")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("q", q.to_string())
        .add_attribute("r", r.to_string())
        .add_attribute("hex_label", describe_hex(q, r))
        .add_attribute("city_index", chosen_city.to_string())
        .add_attribute("token_ordinal", token_ordinal.to_string())
        .add_attribute("cost", cost)
        .add_attribute("tokens_placed", tokens_placed.to_string())
        .add_attribute("tokens_remaining", (limit - u8::try_from(tokens_placed).unwrap_or(limit)).to_string())
        .add_attribute("company_treasury_remaining", company.treasury))
}
