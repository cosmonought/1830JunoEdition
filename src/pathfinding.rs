//! Pathfinding Revenue Engine: traces the best-value route set a floated
//! public company can run across `MAP_GRID`, per `rules.md` section 3,
//! Step 3 ("Revenue Generation & Yield Routing" -- "The Validator traces
//! valid grid paths using the Protocol's active 'Hardware' (Trains) to
//! calculate total network yield. Path tracing must obey connection paths
//! and cannot bypass blocking enemy Nodes.").
//!
//! ## Audit G-9 -- what this pass changed
//!
//! Three gaps, all in the same traversal:
//!
//! 1. **Edge-to-edge routing.** The old walk read a tile's flat `u8`
//!    `connections` bitmask: "does edge `e` carry track?" It never asked
//!    which edge that track actually joins. On real tile #1 -- two
//!    INDEPENDENT towns, one joining edges 1 and 3, the other joining edges
//!    0 and 4 -- a train could enter on edge 0 and leave on edge 3,
//!    route-jumping between two segments that never physically touch. The
//!    walk below now follows specific edge-PAIRS (`state::Tile::paths`, laid
//!    down per-tile from the real 1830 manifest in `hexmap::TILE_CATALOG`):
//!    having entered a hex through edge `e`, the only legal exits are the
//!    other ends of segments that actually contain `e`.
//! 2. **Multi-train route isolation.** The engine priced exactly ONE route
//!    -- a company's best train -- and had no concept of the others. Real
//!    1830 runs every owned train in the same Operating Round, and no two
//!    of a company's trains may reuse the same piece of track.
//!    `trace_best_route_set` below runs them all against a shared
//!    `HashSet<(q, r, (u8, u8))>` claimed-segment ledger.
//! 3. **Token blockades and route validity.** Blockades were modeled off
//!    each rival's FIRST LAID TILE (`PROTOCOL_NETWORK_HEXES[0]`), which is a
//!    track record, not a token record, and blocked that hex outright. They
//!    now read `PROTOCOL_STATION_HEXES` -- the real token registry -- and
//!    apply the real rule: blocked only if every slot in the city is taken.
//!    A minimum-two-revenue-centres check is also enforced, which the old
//!    engine explicitly flagged as missing (its design note #5).
//!
//! ## Design notes
//!
//! 1. **Where a route starts.** From the company's own home hex, its first
//!    `PROTOCOL_NETWORK_HEXES` entry -- deliberately UNCHANGED by G-9. That
//!    registry tracks laid tiles and `PROTOCOL_STATION_HEXES` tracks token
//!    placements; `hexmap.rs`'s module doc comment #23 keeps the two
//!    "DELIBERATELY DECOUPLED", and G-9's scope is the BLOCKADE source, not
//!    the origin. Repointing the origin as well would make a company's
//!    routes start at its preprinted `corporation_home_hex` regardless of
//!    where it has actually built, which is a separate change with its own
//!    board-wide consequences.
//! 2. **Hex/city values.** Unchanged from before this pass. Each visited
//!    hex's value comes from `effective_tile_and_value` below: a real laid
//!    tile's `hexmap::tile_base_value` (Plain/Mountain $0, Small Town $10,
//!    Major City Hub $20, and so on via `hexmap::terrain_base_value`), or,
//!    for the six individually-sourced preprinted hexes
//!    (`hexmap::landmark_start_value_at`) and every other real GRAY
//!    preprinted hex (`hexmap::gray_preprinted_name_at`), a synthetic
//!    read-only overlay tile at that hex's real printed figure. Nothing is
//!    ever written to `MAP_GRID`. See that function's own doc comment for
//!    the full history of both overlays.
//!
//!    The overlays remain deliberately PERMISSIVE in geometry -- a synthetic
//!    tile is fully connected, every edge to every other edge -- rather than
//!    carrying each preprinted hex's exact printed track shape. G-9 gave
//!    real LAID tiles exact edge-pairs; it did not narrow the overlays,
//!    because this engine's absolute edge numbering is a mirror of the
//!    source manifest's (see `hexmap::TILE_CATALOG`'s "Edge numbering"
//!    paragraph), and for a preprinted hex -- unlike a freely-rotatable tray
//!    tile -- that reflection is NOT immaterial: it would point real printed
//!    track at the wrong neighbours. Narrowing them on a mirrored numbering
//!    would sever whole board regions, the exact failure `hexmap.rs`'s
//!    module doc comment #20 had to repair once already. Tightening them is
//!    tracked as residual work, and is a strict tightening: nothing routable
//!    today would gain a path.
//! 3. **What counts as a revenue centre.** Any visited hex whose
//!    `effective_tile_and_value` figure is non-zero. Plain and Mountain
//!    track price at $0 and are therefore pure connectors -- passed through
//!    freely, never counted against a train's capacity and never counted
//!    toward the two-centre minimum. Towns and cities price above $0 and
//!    count as one stop each.
//! 4. **Distance budget.** A train's `max_route_distance` caps the number of
//!    REVENUE CENTRES its route may visit, not the number of hexes -- the
//!    real 1830 rule, and the only reading consistent with requirement 3's
//!    `visited_revenue_centres >= 2` minimum. (Pre-G-9 it capped visited
//!    hexes, under which a 2-train could not have run two towns joined by a
//!    single plain connector -- three hexes -- even though that is the most
//!    ordinary route in the game.) Connector hexes are instead bounded by
//!    `MAX_ROUTE_HEXES` purely as a gas guard.
//! 5. **Search algorithm.** Depth-first over `(hex, arrival edge)` states,
//!    exhaustive within the caps above, taking the highest-valued route
//!    found. Deterministic by construction, which a consensus contract
//!    requires: candidate segments are visited in the fixed order
//!    `TILE_CATALOG` lists them, a strictly-greater comparison keeps the
//!    first best route found on ties, and no iteration order over a
//!    `HashSet` ever influences a decision (the ledger is consulted only by
//!    `contains`, and route hexes are accumulated in an ordered `Vec`).
//!
//!    A route runs THROUGH the home station, not merely out of it: both ends
//!    of one segment on the home tile can be arms of the same route (see
//!    `best_route_for_train`). A hex is still visited at most once per route
//!    -- real 1830 permits re-entering a hex on genuinely separate track,
//!    and this engine does not, a pre-existing simplification G-9 did not
//!    change. It can only under-report revenue.
//! 6. **Multi-train assignment is greedy, not globally optimal.** Trains run
//!    biggest-first, each taking the best route still available to it given
//!    what earlier trains already claimed. A jointly-optimal assignment is
//!    an exponential search this contract cannot afford at block gas limits.
//!    Greedy-by-capacity is the standard 18xx heuristic, is deterministic,
//!    and can only under-report, never over-report, revenue.

use std::collections::{HashMap, HashSet};

use cosmwasm_std::{StdError, Storage, Uint128};
use thiserror::Error;

use crate::hexmap::{
    city_designation_name_at, city_occupancy, city_slot_counts_at, effective_tile_paths,
    gray_preprinted_name_at, hex_token_occupants, landmark_start_value_at, normalize_path,
    terrain_base_value, tile_base_value, tile_segment_cities, town_designation_at,
    HEX_NEIGHBOR_OFFSETS,
};
use crate::public_company::CORE_PUBLIC_COMPANIES;
use crate::state::{
    TerrainType, Tile, COMPANY_HARDWARE, MAP_GRID, PROTOCOL_NETWORK_HEXES, PROTOCOL_STATION_HEXES,
};

/// Hard ceiling on how many hexes a single route may contain, connector
/// hexes included. Not a game rule -- 1830 caps STOPS, which
/// `max_route_distance` already does (design note #4) -- purely a gas guard,
/// so a pathological board of interlocking brown junction tiles cannot make
/// this search run away inside a block. Comfortably above any route a real
/// 1830 board can produce: the longest train in the game is a Diesel, and
/// even a Diesel's stops cannot be spread over more than a handful of
/// connectors each on a 74-hex map.
pub const MAX_ROUTE_HEXES: usize = 24;

/// Hard ceiling on how many partial-route states one train's search may
/// expand before it stops looking and returns the best route found so far.
/// Same purpose as `MAX_ROUTE_HEXES` and same non-game-rule status; this one
/// bounds the search's BREADTH where that one bounds its depth. Exceeding it
/// is not an error -- the search degrades to "best found within budget",
/// which is deterministic (the expansion order is fixed) and can only
/// under-report revenue.
pub const MAX_SEARCH_STATES: u32 = 20_000;

/// Resolves the tile actually in play at `(q, r)` for route-tracing
/// purposes, together with its scored value -- the Landmark Pathfinder
/// Revenue Fix (`hexmap.rs` module doc comment #17) and its board-wide
/// Gray-Hex extension (#20). Prefers any real `Tile` a Protocol has actually
/// laid via `LayTile`, scored the ordinary way through `tile_base_value`.
/// Falls back to a synthetic, unowned virtual tile at the six hexes
/// `hexmap::landmark_start_value_at` covers -- real preprinted 1830
/// landmark/gray-city hexes with genuine starting track -- scored at that
/// hex's own real starting face value, and then at every OTHER real GRAY
/// preprinted hex (`hexmap::gray_preprinted_name_at`), scored at the flat
/// `terrain_base_value` figure for whatever marker it carries. Returns
/// `None` for every other untiled hex. Nothing is ever written to
/// `MAP_GRID`; this is a read-only overlay for this trace alone.
///
/// **Audit G-9.** The synthetic tiles now also carry a `paths` list, since
/// `Tile::paths` is what the traversal below actually follows -- an overlay
/// left with an empty list would be unroutable, silently reintroducing the
/// dead-zone bug #20 fixed. `FULLY_CONNECTED_PATHS` keeps them exactly as
/// permissive as their `0b11_1111` mask always was, so this pass changes
/// nothing about which overlay hexes a route can cross; see design note #2
/// for why narrowing them to their real printed shapes is deliberately NOT
/// part of this batch. `tile_id` 10 is retained as the overlays' marker id
/// (it is not, and never was, a real `TILE_CATALOG` entry -- the value
/// returned alongside is authoritative, never a `tile_base_value` lookup on
/// this id).
///
/// `pub(crate)`, not private: `operations::execute_run_manual_route`
/// (Manual Route Validation) reuses this too, so a manually-declared route
/// and an automatically-traced one can never disagree about whether an
/// untiled landmark hex is passable or what it's worth.
pub(crate) fn effective_tile_and_value(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
) -> Result<Option<(Tile, Uint128)>, PathfindingError> {
    if let Some(tile) = MAP_GRID.may_load(storage, (game_id, q, r))? {
        let value = tile_base_value(tile.tile_id).unwrap_or_default();
        return Ok(Some((tile, value)));
    }
    if let Some(value) = landmark_start_value_at(q, r) {
        return Ok(Some((synthetic_overlay_tile(q, r), value)));
    }
    // Module doc comment #20 (Rigid Global Gray-Hex Lockout, `hexmap.rs`):
    // every OTHER real GRAY pre-printed hex -- the ones not already covered
    // by `landmark_start_value_at` above -- can, since `hexmap.rs` module
    // doc comment #19/#20, never receive a real laid `Tile` either (the
    // Gray Hex Immutability lock rejects every `LayTile` attempt there
    // unconditionally). Without this fallback, `MAP_GRID.may_load` above
    // would permanently return `None` for these hexes and this function
    // would fall all the way through to the final `Ok(None)` below --
    // silently making each one an unroutable dead zone (no route could ever
    // pass through it or score any value there), even though its real
    // printed track genuinely connects to the rest of the board. A real
    // GRAY city scores the flat `MajorCityHub` figure, a real GRAY town the
    // flat `SmallTown`/`DoubleTown` figure, and a bare connector `$0` --
    // still passable, preserving through-routing across it.
    if gray_preprinted_name_at(q, r).is_some() {
        let value = if city_designation_name_at(q, r).is_some() {
            terrain_base_value(TerrainType::MajorCityHub)
        } else if let Some((_, is_double)) = town_designation_at(q, r) {
            terrain_base_value(if is_double {
                TerrainType::DoubleTown
            } else {
                TerrainType::SmallTown
            })
        } else {
            Uint128::zero()
        };
        return Ok(Some((synthetic_overlay_tile(q, r), value)));
    }
    Ok(None)
}

/// Every unordered pair of two distinct edges on a six-edge hex, in
/// canonical `(min, max)` order -- the edge-pair spelling of the
/// `0b11_1111` "fully connected" mask the synthetic overlay tiles have
/// always carried. See `effective_tile_and_value`'s doc comment.
const FULLY_CONNECTED_PATHS: &[(u8, u8)] = &[
    (0, 1),
    (0, 2),
    (0, 3),
    (0, 4),
    (0, 5),
    (1, 2),
    (1, 3),
    (1, 4),
    (1, 5),
    (2, 3),
    (2, 4),
    (2, 5),
    (3, 4),
    (3, 5),
    (4, 5),
];

/// Builds the read-only synthetic tile `effective_tile_and_value` overlays
/// onto a preprinted hex that can hold no real `Tile`. Orientation `0` and
/// canonical paths, so `hexmap::effective_tile_paths` returns
/// `FULLY_CONNECTED_PATHS` unrotated and unchanged.
pub(crate) const SYNTHETIC_OVERLAY_TILE_ID: u32 = 10;

fn synthetic_overlay_tile(q: i32, r: i32) -> Tile {
    Tile {
        q,
        r,
        // Audit G-13: deliberately an id `TILE_CATALOG` does NOT contain, so
        // `hexmap::tile_segment_cities` reports "no attributable city" rather
        // than borrowing some real tile's city layout. Asserted by
        // `synthetic_overlay_tile_id_is_not_a_real_catalog_tile`.
        tile_id: SYNTHETIC_OVERLAY_TILE_ID,
        orientation: 0,
        connections: 0b11_1111,
        paths: FULLY_CONNECTED_PATHS.to_vec(),
    }
}

#[derive(Error, Debug)]
pub enum PathfindingError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Arithmetic overflow while summing a route's revenue value")]
    Overflow {},
}

/// How freely a route may interact with the revenue centre on a given hex,
/// once rival Station Tokens are taken into account (Audit G-9,
/// requirement 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Passability {
    /// No rival blockade applies: the route may stop here or run straight
    /// through. Covers a hex with no rival tokens, a hex with an open
    /// un-tokened slot still available, and any hex where the running
    /// company holds a token of its own (you are never blocked out of your
    /// own station).
    Open,
    /// Every slot in this city is taken by rivals. A train may STOP here to
    /// end its route -- and scores the city's value for doing so -- but may
    /// not pass through and continue onward.
    StopOnly,
}

/// One train's traced route within a company's Operating Round route set.
#[derive(Clone, Debug, PartialEq)]
pub struct TrainRoute {
    /// The train's `HardwareAsset::model_type` ("2", "3", ..., "D").
    pub model_type: String,
    /// That train's `max_route_distance` -- the revenue-centre cap this
    /// particular route was searched under (design note #4).
    pub max_route_distance: u32,
    /// Every hex the route runs across, home hex first, connector hexes
    /// included (they simply contribute `$0`). Discovery order, not strict
    /// travel order: a route that runs THROUGH the home station lists home,
    /// then one arm, then the other, rather than one geographic end to the
    /// other. No two entries repeat.
    pub hexes: Vec<(i32, i32)>,
    /// Every track segment the route consumes, as
    /// `(q, r, (low_edge, high_edge))` with the edge pair in canonical
    /// order -- exactly the keys written into the claimed-segment ledger,
    /// so a caller can audit why a later train was turned away.
    pub segments: Vec<(i32, i32, (u8, u8))>,
    /// How many revenue centres (non-zero-value hexes) the route visits.
    /// Always `>= MIN_REVENUE_CENTRES` for a route that scores.
    pub revenue_centres: u32,
    /// The route's total value.
    pub value: Uint128,
}

/// Real 1830's minimum route length: a route must join at least two revenue
/// centres to score anything at all (Audit G-9, requirement 3). A train
/// sitting on a lone town, or running out along track that reaches no second
/// city, earns nothing -- it does not earn that one town's value, which is
/// what the pre-G-9 engine paid out and its own design note #5 flagged.
pub const MIN_REVENUE_CENTRES: u32 = 2;

/// Returns `protocol_id`'s longest `max_route_distance` among everything it
/// owns in `COMPANY_HARDWARE` (its best train), or `None` if it owns no
/// Hardware at all.
///
/// `pub(crate)`, not private: `operations::execute_run_manual_route`
/// (Manual Route Validation) reuses this exact same distance-budget lookup
/// rather than duplicating it, so the two route-revenue paths can never
/// disagree about how far a given company's Hardware can run.
pub(crate) fn best_owned_distance(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<Option<u32>, PathfindingError> {
    let owned = COMPANY_HARDWARE
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default();
    Ok(owned.iter().map(|asset| asset.max_route_distance).max())
}

/// Every hex holding at least one RIVAL Station Token, mapped to how many
/// rival tokens sit there.
///
/// **Audit G-9, requirement 3.** This is the repointed blockade source. It
/// used to read `PROTOCOL_NETWORK_HEXES`' first entry per rival -- that
/// company's first LAID TILE -- which is the wrong registry twice over: it
/// is a track record rather than a token record, and it named exactly one
/// hex per rival no matter how many tokens that rival had actually placed.
/// `PROTOCOL_STATION_HEXES` (`state.rs`) is the real token registry, written
/// by `hexmap::grant_home_station_token` at float and by
/// `hexmap::execute_place_station_token` for every token after that, so
/// every rival token on the board is now accounted for -- and only tokens
/// are.
/* ------------------------------------------------------------------ */
/* HEX-LEVEL BLOCKADE ROLL-UP -- test-only in a non-test build          */
/* ------------------------------------------------------------------ */
//
// `cargo check` reports the five functions in this block as `dead_code`.
// THEY ARE NOT DEAD, AND DELETING THEM BREAKS THE TEST SUITE.
//
// `cargo check` compiles only the library target, and `mod tests` is behind
// `#[cfg(test)]` (see `lib.rs`), so the compiler cannot see the callers.
// `cargo check --all-targets` or `cargo test` reports no warning here. Live
// callers, all in `src/tests.rs`:
//
//   opponent_station_hexes  -- 4 tests, including
//     `run_manual_route_may_end_at_a_fully_blockaded_rival_city` and
//     `run_manual_route_runs_through_the_city_once_the_blockade_is_lifted`
//   passability_at          -- `passability_is_evaluated_per_city_not_per_hex`
//   tokened_hexes / passability_for_hex / hex_passability
//                           -- transitively, via the two above
//
// WHY THEY LOST THEIR PRODUCTION CALLERS. Audit G-13 made routing
// city-granular. `BoardView::info` moved from `passability_for_hex` to
// `city_passability_for_hex`, and `operations::execute_run_manual_route`
// moved from `opponent_station_hexes` to `transit_passability_for_hex`. That
// is the point of G-13: the hex-level question -- "is this hex closed to me
// ENTIRELY" -- is too coarse to route on, because a hex is not a city.
//
// They are kept rather than deleted because the question they answer is
// still a real and correct one, just not the one the router asks. It is the
// right question for any caller that has a hex and no track: a map overlay
// shading unreachable hexes, or a UI hint. Keeping them also keeps the four
// blockade regression tests, which are the coverage that proves rival tokens
// blockade at all -- rewriting those against the per-city API would trade
// real coverage for a silenced warning.
//
// `#[allow(dead_code)]` is therefore an assertion, not a suppression: these
// have callers, and the lint cannot see them.

#[allow(dead_code)]
pub(crate) fn tokened_hexes(
    storage: &dyn Storage,
    game_id: u64,
) -> Result<HashSet<(i32, i32)>, PathfindingError> {
    let mut hexes = HashSet::new();
    for (company_id, _) in CORE_PUBLIC_COMPANIES.iter().copied() {
        for hex in PROTOCOL_STATION_HEXES
            .may_load(storage, (game_id, company_id))?
            .unwrap_or_default()
        {
            hexes.insert(hex);
        }
    }
    Ok(hexes)
}

/// The hexes a rival blockade forbids `protocol_id` from routing THROUGH --
/// every hex where rivals hold tokens and no open slot remains.
///
/// **Audit G-9.** Kept under its original name and `HashSet<(i32, i32)>`
/// shape because `operations::execute_run_manual_route` consumes it
/// directly; only the underlying source and rule changed (see
/// `tokened_hexes`/`passability_at`). Two consequences for that caller, both strictly
/// more faithful than before: a rival's mere first laid tile no longer
/// blocks anything, and a rival-tokened city with a slot still open no
/// longer blocks anything either.
///
/// The residual G-9 left open here -- that `execute_run_manual_route`
/// rejected a declared path containing ANY hex in this set, including as its
/// final hex, so a manual route could not END at a fully-blockaded city the
/// way `trace_best_route_set` below correctly can -- is CLOSED. That
/// function now applies this set to the interior of a declared path only,
/// matching `Passability::StopOnly`. Callers should read this set as "cities
/// no route may pass THROUGH", never as "hexes no route may touch".
#[allow(dead_code)]
pub(crate) fn opponent_station_hexes(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<HashSet<(i32, i32)>, PathfindingError> {
    let mut blocked = HashSet::new();
    // Iterating a `HashSet` is order-dependent, but the RESULT is not: this
    // loop only inserts into a set, and every decision inside it is a pure
    // function of that one hex. Deliberately routed through the same
    // `passability_at` the traversal uses, so the two can never drift.
    for hex in tokened_hexes(storage, game_id)? {
        if passability_for_hex(storage, game_id, hex.0, hex.1, protocol_id)?
            == Passability::StopOnly
        {
            blocked.insert(hex);
        }
    }
    Ok(blocked)
}

/// Whether `protocol_id` may run THROUGH hex `(q, r)` entering on
/// `in_edge` and leaving on `out_edge` -- Audit G-13, the city-granular
/// transit test for a route whose track is known.
///
/// This is the same question `HexInfo::transit_passability` answers inside
/// the DFS, exposed for `operations::execute_run_manual_route`, whose
/// declared `hex_path` fixes both edges by the axial deltas to its
/// neighbours and so knows exactly as much about the track as the search
/// does. Sharing one implementation is what stops the automatic and manual
/// route paths from disagreeing about a blockade.
///
/// `Open` when no segment on the tile joins those two edges: the hop is
/// impossible for connectivity reasons, which is a different rejection with
/// a different error, checked elsewhere. Reporting it as blocked here would
/// attribute a connectivity failure to a rival's tokens.
pub(crate) fn transit_passability_for_hex(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
    protocol_id: u32,
    in_edge: u8,
    out_edge: u8,
) -> Result<Passability, PathfindingError> {
    let Some((tile, _)) = effective_tile_and_value(storage, game_id, q, r)? else {
        return Ok(Passability::Open);
    };
    let paths = effective_tile_paths(&tile);
    let info = HexInfo {
        segment_cities: tile_segment_cities(tile.tile_id, paths.len()),
        paths,
        value: Uint128::zero(),
        is_revenue_centre: false,
        city_passability: city_passability_for_hex(storage, game_id, q, r, protocol_id)?,
    };
    let wanted = normalize_path(in_edge, out_edge);
    let Some(segment_index) = info
        .paths
        .iter()
        .position(|&(a, b)| normalize_path(a, b) == wanted)
    else {
        return Ok(Passability::Open);
    };
    Ok(info.transit_passability(segment_index))
}

/// `passability_at` for a hex, with the two storage reads it needs done here
/// so the pure decision function stays testable without a `Storage`.
#[allow(dead_code)]
pub(crate) fn passability_for_hex(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
    protocol_id: u32,
) -> Result<Passability, PathfindingError> {
    Ok(hex_passability(&city_passability_for_hex(
        storage,
        game_id,
        q,
        r,
        protocol_id,
    )?))
}

/// Audit G-13: passability of EACH city on `(q, r)` independently, indexed by
/// `city_index`. Empty for a hex with no city.
pub(crate) fn city_passability_for_hex(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
    protocol_id: u32,
) -> Result<Vec<Passability>, PathfindingError> {
    let slot_counts = city_slot_counts_at(storage, game_id, q, r)?;
    let occupants = hex_token_occupants(storage, game_id, q, r)?;
    Ok(city_passability_at(slot_counts, &occupants, protocol_id))
}

/// Whether a route may run THROUGH this hex's revenue centre or only stop
/// there (Audit G-9 requirement 3, made PER-CITY by Audit G-12).
///
/// The rule, evaluated independently for each city on the hex:
/// - `protocol_id` holds a token in THAT city -- open. A company is never
///   blocked out of its own station, however full that city is.
/// - That city still has a slot no rival occupies -- open. This is the case
///   the rule exists for: a 2-slot city holding ONE rival token blocks
///   nobody; the same city holding TWO blocks everybody else.
/// - Otherwise that city is closed to this company.
///
/// The hex is `StopOnly` only when EVERY city on it is closed. A train may
/// still end its route there and score it; it just cannot continue past.
///
/// WHY "any open city opens the hex", stated plainly because it is the one
/// approximation left in here: the traversal is hex-granular -- `HexInfo`
/// carries `paths` for the whole tile and does not track which city a route
/// entered -- so at this level the honest question is "can this company get
/// through this hex at all", and it can if any city admits it. Tightening
/// this to "the specific city the route actually uses" requires the search
/// itself to carry city identity through each hop, which is a change to the
/// traversal, not to this function.
///
/// What G-12 fixed is the layer beneath: `slot_counts` and `occupants` are
/// now per-city, so a hex is no longer judged by a POOLED total that could
/// report room on a hex whose every city was full (#62 carries two 2-slot
/// cities; the pooled count said 4 and could not tell 2+2 from 4+0).
#[allow(dead_code)]
pub(crate) fn passability_at(
    slot_counts: &[u32],
    occupants: &[(u32, u8)],
    protocol_id: u32,
) -> Passability {
    hex_passability(&city_passability_at(slot_counts, occupants, protocol_id))
}

/// The per-city answer, one entry per city on the hex, indexed by
/// `city_index` (Audit G-13). Empty for a hex with no city.
///
/// This is the primitive; every other passability question in this module is
/// a roll-up of it. For each city independently:
///
/// - `protocol_id` holds a token in THAT city -- open. Checked per city, not
///   per hex: holding New York's western station does not entitle you to run
///   through its eastern one.
/// - That city still has a slot no rival occupies -- open. A 2-slot city
///   holding ONE rival token blocks nobody; the same city holding TWO blocks
///   everybody else.
/// - Otherwise that city is closed to this company.
pub(crate) fn city_passability_at(
    slot_counts: &[u32],
    occupants: &[(u32, u8)],
    protocol_id: u32,
) -> Vec<Passability> {
    slot_counts
        .iter()
        .enumerate()
        .map(|(index, capacity)| {
            let Ok(city_index) = u8::try_from(index) else {
                // Unreachable on any real board (no tile has 256 cities);
                // closed rather than open, because an index we cannot name is
                // an index we cannot prove is passable.
                return Passability::StopOnly;
            };
            if occupants
                .iter()
                .any(|(id, city)| *id == protocol_id && *city == city_index)
            {
                return Passability::Open;
            }
            if *capacity > occupancy_excluding(occupants, city_index, protocol_id) {
                return Passability::Open;
            }
            Passability::StopOnly
        })
        .collect()
}

/// Whether a hex is passable AT ALL -- open if ANY city on it admits this
/// company, and for a hex with no cities.
///
/// **This is a strictly weaker question than `HexInfo::transit_passability`,
/// and the distinction is the entire point of Audit G-13.** Use this only
/// where the specific track a route runs over is genuinely unknown:
/// `opponent_station_hexes`, whose contract with its callers is "hexes no
/// route may touch at all". The DFS never uses it -- it knows exactly which
/// segment it is traversing, so it asks about that segment's own city.
#[allow(dead_code)]
fn hex_passability(per_city: &[Passability]) -> Passability {
    if per_city.is_empty() || per_city.iter().any(|p| *p == Passability::Open) {
        Passability::Open
    } else {
        Passability::StopOnly
    }
}

/// Tokens in `city_index` that do NOT belong to `protocol_id`.
fn occupancy_excluding(occupants: &[(u32, u8)], city_index: u8, protocol_id: u32) -> u32 {
    let total = city_occupancy(occupants, city_index);
    let mine = occupants
        .iter()
        .filter(|(id, city)| *id == protocol_id && *city == city_index)
        .count() as u32;
    total - mine
}

/// Everything the search needs about one hex, resolved once and cached so a
/// deep search does not re-read the same hex out of storage on every visit.
#[derive(Clone)]
pub(crate) struct HexInfo {
    /// The hex's rotated, on-map edge-pair segments.
    paths: Vec<(u8, u8)>,
    /// Audit G-13: parallel to `paths` -- which city each segment runs
    /// through. `None` means either "no city on this tile" or "the
    /// correspondence is not knowable here"; `city_passability.is_empty()`
    /// tells the two apart. See `hexmap::tile_segment_cities`.
    segment_cities: Vec<Option<u8>>,
    /// Its scored value; `$0` for connector track.
    value: Uint128,
    /// Whether it counts toward the train's stop budget and the two-centre
    /// minimum -- true exactly when `value` is non-zero (design note #3).
    is_revenue_centre: bool,
    /// Audit G-13: whether a rival blockade forbids running through EACH
    /// city on this hex, indexed by `city_index`. Empty for a hex with no
    /// city. Replaces the single per-hex `passability` field, which could
    /// not express "city 0 is closed but city 1 is open" -- the state that
    /// made ghost routing possible.
    city_passability: Vec<Passability>,
}

impl HexInfo {
    /// Whether a route may run THROUGH this hex along segment `segment_index`
    /// -- Audit G-13, and the check the DFS actually makes.
    ///
    /// Resolves to the passability of the ONE city that segment runs through,
    /// so a blockade on city 0 stops a route using city 0's track while
    /// leaving city 1's track open, which is what real 1830 does and what
    /// makes tokening a contested city a defensive move at all.
    pub(crate) fn transit_passability(&self, segment_index: usize) -> Passability {
        // No cities on this hex -- plain track, a town, a bare connector.
        // Nothing to blockade.
        if self.city_passability.is_empty() {
            return Passability::Open;
        }
        match self.segment_cities.get(segment_index).copied().flatten() {
            Some(city_index) => self
                .city_passability
                .get(usize::from(city_index))
                .copied()
                // A segment naming a city the slot table does not have is a
                // catalog inconsistency. Closed, not open: an unprovable
                // claim of passage is exactly what G-13 removes.
                .unwrap_or(Passability::StopOnly),
            // The hex HAS cities but this segment cannot be attributed to one
            // -- today, a synthesized overlay tile standing in for preprinted
            // artwork. Take the STRICTEST city's answer. Being conservative
            // here can only ever refuse a route that might have been legal;
            // being permissive would allow the illegal transit this audit
            // exists to prevent, and those two errors are not equally bad.
            None => {
                if self
                    .city_passability
                    .iter()
                    .any(|p| *p == Passability::StopOnly)
                {
                    Passability::StopOnly
                } else {
                    Passability::Open
                }
            }
        }
    }
}

/// Builds a bare `HexInfo` for unit tests -- Audit G-13.
///
/// Exists so the ghost-routing regression can be asserted against the exact
/// decision function the DFS uses, without standing up a game session, a
/// board, eight corporations and a token registry just to reach it. The
/// fields it does not take (`value`, `is_revenue_centre`) play no part in
/// `transit_passability`.
#[cfg(test)]
pub(crate) fn hex_info_for_test(
    paths: Vec<(u8, u8)>,
    segment_cities: Vec<Option<u8>>,
    city_passability: Vec<Passability>,
) -> HexInfo {
    HexInfo {
        paths,
        segment_cities,
        value: Uint128::zero(),
        is_revenue_centre: false,
        city_passability,
    }
}

/// Resolves and memoizes `HexInfo` for the hexes one route search touches.
struct BoardView<'a> {
    storage: &'a dyn Storage,
    game_id: u64,
    /// Audit G-12: the company this view is being built for. Passability is
    /// now resolved per hex on demand (and memoized in `cache` alongside the
    /// rest of `HexInfo`) rather than from two whole-board token maps built
    /// up front, because the per-city answer needs that hex's own slot
    /// breakdown, which is a per-hex read either way.
    protocol_id: u32,
    cache: HashMap<(i32, i32), Option<HexInfo>>,
}

impl<'a> BoardView<'a> {
    fn new(
        storage: &'a dyn Storage,
        game_id: u64,
        protocol_id: u32,
    ) -> Result<Self, PathfindingError> {
        Ok(BoardView {
            storage,
            game_id,
            protocol_id,
            cache: HashMap::new(),
        })
    }

    /// `None` when the hex holds no routable tile at all (neither laid nor
    /// synthesized) -- off the network entirely, not merely worthless.
    fn info(&mut self, q: i32, r: i32) -> Result<Option<HexInfo>, PathfindingError> {
        if let Some(cached) = self.cache.get(&(q, r)) {
            return Ok(cached.clone());
        }
        let resolved = match effective_tile_and_value(self.storage, self.game_id, q, r)? {
            None => None,
            Some((tile, value)) => {
                let paths = effective_tile_paths(&tile);
                // Audit G-13: derived from the SAME list, so index `i` in
                // `segment_cities` always describes `paths[i]`.
                //
                // `tile.tile_id` for a synthesized overlay is
                // `SYNTHETIC_OVERLAY_TILE_ID`, which is deliberately not a
                // real `TILE_CATALOG` entry -- so this comes back all-`None`
                // and `transit_passability` takes its conservative branch,
                // which is the correct handling for artwork whose segments
                // carry no city information.
                let segment_cities = tile_segment_cities(tile.tile_id, paths.len());
                Some(HexInfo {
                    paths,
                    segment_cities,
                    value,
                    is_revenue_centre: !value.is_zero(),
                    // Audit G-12/G-13: the per-city vector. The hex-level
                    // roll-up `opponent_station_hexes` uses is derived from
                    // this same call, so the DFS and that set can never
                    // disagree about whether a hex is reachable -- they just
                    // ask different questions of it.
                    city_passability: city_passability_for_hex(
                        self.storage,
                        self.game_id,
                        q,
                        r,
                        self.protocol_id,
                    )?,
                })
            }
        };
        self.cache.insert((q, r), resolved.clone());
        Ok(resolved)
    }
}

/// A route under construction during the depth-first search.
#[derive(Clone)]
struct PartialRoute {
    hexes: Vec<(i32, i32)>,
    /// Every ledger key this route consumes -- both real through segments
    /// and the half-edge crossing markers described on `hop_claims`.
    claims: Vec<(i32, i32, (u8, u8))>,
    visited_hexes: HashSet<(i32, i32)>,
    revenue_centres: u32,
    value: Uint128,
}

impl PartialRoute {
    /// Whether this partial route is a legal, scoring route in its own right
    /// -- the two-revenue-centre minimum (`MIN_REVENUE_CENTRES`).
    fn is_scoring(&self) -> bool {
        self.revenue_centres >= MIN_REVENUE_CENTRES
    }

    /// The real, reportable track segments -- `claims` with the half-edge
    /// crossing markers filtered back out.
    fn through_segments(&self) -> Vec<(i32, i32, (u8, u8))> {
        self.claims
            .iter()
            .copied()
            .filter(|(_, _, (a, b))| a != b)
            .collect()
    }
}

/// Every claimed-segment ledger key one hop consumes, travelling out of
/// `from` along `segment`, leaving by `exit_edge`, and arriving at `next` on
/// `arrival_edge`.
///
/// Three keys, not one, and the second and third are the reason:
///
/// 1. `(from, segment)` -- the physical track INSIDE `from` that the train
///    runs over. This is the primary claim requirement 2 describes.
/// 2. `(from, (exit_edge, exit_edge))` and
/// 3. `(next, (arrival_edge, arrival_edge))` -- the two halves of the
///    CROSSING between the hexes. Without these, two of a company's trains
///    could both run the same piece of track between two hexes by entering
///    the shared hex through different edges of the same multi-spoke city:
///    on a green city tile (#14, four spokes into one node) segments
///    `(e_w, e_z)` and `(e_x, e_z)` are distinct ledger keys but share the
///    physical rail leaving on `e_z`. Claiming both halves also makes the
///    crossing direction-agnostic -- a train running `Y -> Z` and one
///    running `Z -> Y` collide on key 3 and key 2 respectively.
///
/// A `(e, e)` half-edge marker can never collide with a real terminal spur
/// from `TILE_CATALOG`, which shares that spelling: a spur is a dead end and
/// `expand` refuses to traverse one, so a spur key is never claimed.
fn hop_claims(
    from: (i32, i32),
    segment: (u8, u8),
    exit_edge: u8,
    next: (i32, i32),
    arrival_edge: u8,
) -> [(i32, i32, (u8, u8)); 3] {
    [
        (from.0, from.1, normalize_path(segment.0, segment.1)),
        (from.0, from.1, (exit_edge, exit_edge)),
        (next.0, next.1, (arrival_edge, arrival_edge)),
    ]
}

/// The best route one train can run, given a ledger of segments earlier
/// trains have already claimed. `None` when it has no legal scoring route at
/// all: no Hardware capacity, no home hex, nothing but its own single town
/// within reach, or every route it could have run already consumed by a
/// bigger train.
///
/// `claimed` is consulted, never mutated -- `trace_best_route_set` writes the
/// winning route's segments into it only once this returns.
fn best_route_for_train(
    board: &mut BoardView,
    home: (i32, i32),
    max_revenue_centres: u32,
    claimed: &HashSet<(i32, i32, (u8, u8))>,
) -> Result<Option<PartialRoute>, PathfindingError> {
    if max_revenue_centres < MIN_REVENUE_CENTRES {
        // A 1-train (were the catalog ever to hold one) can never satisfy
        // the two-centre minimum, so there is nothing to search for.
        return Ok(None);
    }
    let Some(home_info) = board.info(home.0, home.1)? else {
        return Ok(None);
    };

    let start = PartialRoute {
        hexes: vec![home],
        claims: Vec::new(),
        visited_hexes: HashSet::from([home]),
        revenue_centres: u32::from(home_info.is_revenue_centre),
        value: home_info.value,
    };

    let mut best: Option<PartialRoute> = None;
    let mut budget = MAX_SEARCH_STATES;

    // The home hex is an interior stop the route starts AT rather than one
    // it enters through an edge, so each of its through segments is a legal
    // first move -- and, because a real route runs THROUGH a station rather
    // than out of it, both ends of that one segment can be arms of the SAME
    // route. For each home segment `(a, b)`:
    //
    //   1. search the arm leaving by `a`, and the arm leaving by `b`
    //      (each is already a complete route in its own right, and `expand`
    //      records both into `best` as it goes);
    //   2. then continue the better of each arm out of the OTHER end,
    //      producing the two-armed route that passes through home.
    //
    // Step 2 passes the home segment's own ledger key as `exempt`, because
    // the second arm is not a second traversal of that track -- it is the
    // far half of the single traversal the first arm already claimed
    // (entering on `a`, leaving on `b`). Every other key still collides
    // normally, so a two-armed route still cannot double back over itself.
    //
    // A terminal spur `(a, a)` is skipped outright: it is a dead end into an
    // interior stop, so a route cannot begin by leaving along one.
    for (segment_index, &(a, b)) in home_info.paths.iter().enumerate() {
        if a == b {
            continue;
        }
        // Audit G-13: the home hex needs the same per-city transit test as
        // every other hex, and it is NOT covered by "you always hold a token
        // at home". A company's home token sits in ONE city; a home hex with
        // TWO cities (ERIE's E11 is an OO hex) can have its other city filled
        // by rivals, and that city's track is then closed to the company
        // whose home this is, exactly as it would be anywhere else.
        //
        // Only the two-armed JOIN below is a transit -- a single arm starts
        // at home and leaves, which passes through nothing -- so the flag is
        // computed here and consulted only where it applies.
        let may_transit_home =
            home_info.transit_passability(segment_index) == Passability::Open;
        let segment_key = (home.0, home.1, normalize_path(a, b));
        let arm_a = expand(
            board,
            &start,
            home,
            (a, b),
            a,
            max_revenue_centres,
            claimed,
            None,
            &mut best,
            &mut budget,
        )?;
        let arm_b = expand(
            board,
            &start,
            home,
            (a, b),
            b,
            max_revenue_centres,
            claimed,
            None,
            &mut best,
            &mut budget,
        )?;
        if !may_transit_home {
            // Each arm on its own has already been searched and recorded into
            // `best` above; what is refused here is only joining them into a
            // route that runs THROUGH this blockaded home city.
            continue;
        }
        if let Some(arm) = arm_a {
            expand(
                board,
                &arm,
                home,
                (a, b),
                b,
                max_revenue_centres,
                claimed,
                Some(segment_key),
                &mut best,
                &mut budget,
            )?;
        }
        if let Some(arm) = arm_b {
            expand(
                board,
                &arm,
                home,
                (a, b),
                a,
                max_revenue_centres,
                claimed,
                Some(segment_key),
                &mut best,
                &mut budget,
            )?;
        }
    }

    Ok(best)
}

/// Traverses one segment out of hex `from`, then recurses. `segment` is the
/// canonical `(low, high)` pair being consumed on `from`, and `exit_edge` is
/// the end of it the route leaves by.
///
/// Every rule that makes this an EDGE-PAIR walk rather than the old bitmask
/// walk lives here: the exit is the other end of the SAME segment the route
/// arrived on, never merely "some other live edge on this tile", and the
/// neighbour is entered on one of ITS segments containing the facing edge,
/// which is what constrains where the route may go after that.
///
/// `exempt` names at most one ledger key this hop may consume even if it is
/// already claimed -- used only by the through-home arm join in
/// `best_route_for_train`, which see. `None` everywhere else, including in
/// every recursive call below.
///
/// Updates `best` in place with the highest-valued SCORING route seen
/// anywhere in this subtree, and returns the highest-valued route seen
/// (scoring or not), which the arm join uses as the base to grow the route's
/// other end from.
#[allow(clippy::too_many_arguments)]
fn expand(
    board: &mut BoardView,
    route: &PartialRoute,
    from: (i32, i32),
    segment: (u8, u8),
    exit_edge: u8,
    max_revenue_centres: u32,
    claimed: &HashSet<(i32, i32, (u8, u8))>,
    exempt: Option<(i32, i32, (u8, u8))>,
    best: &mut Option<PartialRoute>,
    budget: &mut u32,
) -> Result<Option<PartialRoute>, PathfindingError> {
    if *budget == 0 {
        return Ok(None);
    }
    *budget -= 1;

    // A terminal spur has no far end to leave by -- it is enterable and
    // stoppable, never passable (`TILE_CATALOG`'s `(a, a)` encoding).
    if segment.0 == segment.1 {
        return Ok(None);
    }

    // Defensive: every edge reaching this point has already been through
    // `hexmap::rotate_edge`'s `% 6`, so this cannot fire -- but an
    // out-of-range index would be a panic inside a contract execution
    // rather than a rejected route, which is not a trade worth making.
    if exit_edge > 5 || segment.0 > 5 || segment.1 > 5 {
        return Ok(None);
    }

    let (dq, dr) = HEX_NEIGHBOR_OFFSETS[exit_edge as usize];
    let next = (from.0 + dq, from.1 + dr);
    // MULTI-CITY HEX REVENUE (audit, this pass -- CONFIRMED CORRECT, no
    // patch needed). This one line is what enforces 1830's "a train may
    // include a given hex at most once" rule, and it is why a tile carrying
    // TWO separate city nodes -- #62, the brown New York upgrade, whose four
    // token slots are two 2-slot cities -- can never have its revenue
    // double-counted.
    //
    // The reason it holds is that `visited_hexes` is keyed on `(q, r)`
    // ALONE, not on a city or node id. The engine's whole revenue model is
    // hex-level (module doc comment #2): `HexInfo.value` is one figure per
    // HEX, resolved once from the laid tile's terrain via
    // `hexmap::tile_base_value`, and `extend_route` adds that figure exactly
    // once, at the moment a hex is first entered. There is no per-city
    // accumulator that a second node on the same hex could increment. So
    // even though #62's two cities are genuinely separate destinations on
    // the physical board, this graph cannot represent them as two visits,
    // and `NewYorkHub`'s flat per-station value is added a single time.
    //
    // `terrain_base_value` prices `NewYorkHub` at $40 for exactly this
    // reason -- see its own comment: the two stations are disconnected
    // intra-tile, so a single continuous transit reaches one of them, and
    // the tile is priced per-station rather than as the sum of both.
    if route.visited_hexes.contains(&next) || route.hexes.len() >= MAX_ROUTE_HEXES {
        return Ok(None);
    }

    // Multi-train isolation (requirement 2): track another of this company's
    // trains already ran this Operating Round is simply not there for this
    // one, and no single route may double back over its own track either.
    // See `hop_claims` for why one hop consumes three keys.
    let arrival_edge = (exit_edge + 3) % 6;
    let claims = hop_claims(from, segment, exit_edge, next, arrival_edge);
    let collides = claims.iter().any(|key| {
        Some(*key) != exempt && (claimed.contains(key) || route.claims.contains(key))
    });
    if collides {
        return Ok(None);
    }

    let Some(next_info) = board.info(next.0, next.1)? else {
        return Ok(None);
    };

    // Audit G-13: the segment INDEX is carried alongside the pair now, not
    // discarded. It is what `HexInfo::transit_passability` keys on to find
    // which city this particular piece of track runs through.
    let entry_segments: Vec<(usize, (u8, u8))> = next_info
        .paths
        .iter()
        .copied()
        .enumerate()
        .filter(|&(_, (a, b))| a == arrival_edge || b == arrival_edge)
        .collect();
    if entry_segments.is_empty() {
        return Ok(None);
    }

    let next_is_centre = next_info.is_revenue_centre;
    if next_is_centre && route.revenue_centres >= max_revenue_centres {
        // The train is out of stops. It cannot enter another revenue centre,
        // but it has not failed -- whatever it has already accumulated still
        // stands, and was recorded when that centre was entered.
        return Ok(None);
    }

    let mut extended = route.clone();
    extended.hexes.push(next);
    // Idempotent: the arm join's exempt key is already present on the route
    // being grown, and must not be recorded twice.
    for key in claims.iter() {
        if !extended.claims.contains(key) {
            extended.claims.push(*key);
        }
    }
    extended.visited_hexes.insert(next);
    if next_is_centre {
        extended.revenue_centres += 1;
        extended.value = extended
            .value
            .checked_add(next_info.value)
            .map_err(|_| PathfindingError::Overflow {})?;
    }

    // Record the route as it stands. Strictly-greater keeps the FIRST best
    // route found on a tie, and the expansion order below is fixed, so the
    // winner is deterministic across nodes.
    let improves = match best.as_ref() {
        None => true,
        Some(current) => extended.value > current.value,
    };
    if extended.is_scoring() && improves {
        *best = Some(extended.clone());
    }

    // ==== Audit G-13: PER-CITY TRANSIT. ====
    //
    // A fully-blockaded city may be stopped at -- which the record above just
    // did -- but never run through. What changed here is the GRANULARITY of
    // that test, and it is a rules fix, not a refactor.
    //
    // Previously this was one `next_info.passability == StopOnly` check for
    // the whole hex, evaluated BEFORE the loop and returning early. On a
    // multi-city tile that let a route enter through a fully-tokened city's
    // own track and leave again as long as SOME OTHER city on the same tile
    // had a free slot -- ghost routing straight through the blockade. On #62
    // (brown New York) and the OO tiles the two cities sit on physically
    // separate, non-intersecting track, so this was never a close call: the
    // route was riding rails it had no access to.
    //
    // The check now lives INSIDE the loop and is asked per segment, so a
    // blockade closes exactly the track that runs through the blockaded city
    // and leaves the other city's track open. `expand` is still reached for
    // the hex itself, so the route may still END here and score it.
    let mut deepest = extended.clone();
    for &(segment_index, (a, b)) in entry_segments.iter() {
        if next_info.transit_passability(segment_index) == Passability::StopOnly {
            continue;
        }
        let onward = if a == arrival_edge { b } else { a };
        let found = expand(
            board,
            &extended,
            next,
            (a, b),
            onward,
            max_revenue_centres,
            claimed,
            None,
            best,
            budget,
        )?;
        if let Some(candidate) = found {
            if candidate.value > deepest.value {
                deepest = candidate;
            }
        }
    }

    Ok(Some(deepest))
}

/// Traces one valid route per train `protocol_id` owns, such that no two of
/// its trains reuse the same track segment in a single Operating Round
/// (Audit G-9, requirement 2).
///
/// Trains run biggest-first, each taking the best route still available to
/// it given what earlier trains claimed; see design note #6 on why that is
/// greedy rather than jointly optimal. Returns the summed value of every
/// route found and the routes themselves, in the order they were assigned.
/// A company with no Hardware, no home hex, or nothing but a single revenue
/// centre in reach returns `(zero, empty)` -- as does a train for which no
/// unclaimed route remains, which is simply omitted from the returned list.
pub fn trace_best_route_set(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<(Uint128, Vec<TrainRoute>), PathfindingError> {
    let mut owned = COMPANY_HARDWARE
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default();
    if owned.is_empty() {
        return Ok((Uint128::zero(), Vec::new()));
    }

    let network_hexes = PROTOCOL_NETWORK_HEXES
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default();
    let Some(&home) = network_hexes.first() else {
        return Ok((Uint128::zero(), Vec::new()));
    };

    // Biggest train first (design note #6). `sort_by` is stable, so trains
    // of equal capacity keep their `COMPANY_HARDWARE` order and the result
    // stays deterministic.
    owned.sort_by(|a, b| b.max_route_distance.cmp(&a.max_route_distance));

    let mut board = BoardView::new(storage, game_id, protocol_id)?;
    let mut claimed: HashSet<(i32, i32, (u8, u8))> = HashSet::new();
    let mut routes: Vec<TrainRoute> = Vec::new();
    let mut total = Uint128::zero();

    for asset in owned.iter() {
        if asset.max_route_distance == 0 {
            continue;
        }
        let found = best_route_for_train(
            &mut board,
            home,
            asset.max_route_distance,
            &claimed,
        )?;
        let Some(route) = found else {
            continue;
        };
        for key in route.claims.iter() {
            claimed.insert(*key);
        }
        total = total
            .checked_add(route.value)
            .map_err(|_| PathfindingError::Overflow {})?;
        routes.push(TrainRoute {
            model_type: asset.model_type.clone(),
            max_route_distance: asset.max_route_distance,
            segments: route.through_segments(),
            hexes: route.hexes,
            revenue_centres: route.revenue_centres,
            value: route.value,
        });
    }

    Ok((total, routes))
}

/// Traces `protocol_id`'s single best-value route -- its best train's, with
/// no segments claimed by anything else -- and returns that route's value
/// along with the hexes it visits, sorted, for logging.
///
/// Retained at its original name and signature for callers that price one
/// route rather than a company's whole Operating Round; `trace_best_route_set`
/// above is the G-9 multi-train entry point. Both now share one traversal,
/// so they cannot disagree about what a legal route is.
///
/// Zero and an empty path whenever no legal route exists: the company owns
/// no Hardware, has laid no track, its home hex isn't on the map, or -- new
/// in G-9 -- every route within its best train's reach touches fewer than
/// `MIN_REVENUE_CENTRES` revenue centres. That last case is the deliberate
/// behavioural change: a company alone on a single town hex used to be paid
/// that town's value and is now correctly paid nothing.
pub fn trace_best_route(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<(Uint128, Vec<(i32, i32)>), PathfindingError> {
    let max_distance = match best_owned_distance(storage, game_id, protocol_id)? {
        Some(distance) if distance > 0 => distance,
        _ => return Ok((Uint128::zero(), Vec::new())),
    };

    let network_hexes = PROTOCOL_NETWORK_HEXES
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default();
    let Some(&home) = network_hexes.first() else {
        return Ok((Uint128::zero(), Vec::new()));
    };

    let mut board = BoardView::new(storage, game_id, protocol_id)?;
    let claimed: HashSet<(i32, i32, (u8, u8))> = HashSet::new();
    let Some(route) = best_route_for_train(&mut board, home, max_distance, &claimed)? else {
        return Ok((Uint128::zero(), Vec::new()));
    };

    let mut path = route.hexes;
    path.sort();
    Ok((route.value, path))
}
