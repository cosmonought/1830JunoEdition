//! Pathfinding Revenue Engine: traces the best-value route SET a floated company
//! can run across `MAP_GRID` (`rules.md` Step 3).
//!
//! Audit G-9 closed three gaps in one traversal:
//!
//!   Edge-to-edge routing  the old walk read the flat `connections` mask and
//!     never asked which edge that track JOINS. On real tile #1 -- two
//!     independent towns -- a train could enter on edge 0 and leave on edge 3,
//!     across track that does not physically touch. The walk now follows specific
//!     edge PAIRS from `Tile::paths`.
//!   Multi-train isolation  the engine priced exactly ONE route and had no
//!     concept of the others. Every owned train now runs against a shared
//!     claimed-segment ledger, so no two reuse the same track.
//!   Token blockades  were modelled off each rival's FIRST LAID TILE -- a track
//!     record, not a token record -- and blocked that hex outright. They now read
//!     `PROTOCOL_STATION_HEXES` and apply the real rule: blocked only if every
//!     slot in the city is taken.
//!
//! Key invariants:
//!
//!   A route starts at the company's own home hex -- `PROTOCOL_NETWORK_HEXES`'s
//!   first entry, i.e. the first tile it ever LAID, not its station token.
//!
//!   `max_route_distance` caps REVENUE CENTRES, not hexes -- the real rule, and
//!   the only reading consistent with the two-centre minimum. Connector hexes are
//!   bounded separately by `MAX_ROUTE_HEXES`, purely as a gas guard.
//!
//!   The search state is `(hex, city_node)`, so a route may serve BOTH stations
//!   of a two-city hex but never the same station twice, and can never cross
//!   between them inside the hex.
//!
//!   Deterministic by construction, which a consensus contract requires:
//!   segments are visited in catalog order, ties keep the first best route, and
//!   no `HashSet` iteration order ever influences a decision.
//!
//!   Multi-train assignment is GREEDY (biggest train first), not jointly
//!   optimal -- that is an exponential search this contract cannot afford at
//!   block gas limits. Greedy can only under-report revenue, never over-report.
//!
//! See docs/ai_architecture/rust_contract_architecture.md, pathfinding.rs -- and
//! note the recorded divergence: `operations::execute_run_manual_route` still
//! caps HEXES rather than revenue centres.

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

/// Hard ceiling on hexes in one route, connectors included. NOT a game rule --
/// 1830 caps STOPS, which `max_route_distance` already does -- purely a gas guard,
/// so a pathological board of interlocking junction tiles cannot make this search
/// run away inside a block.
pub const MAX_ROUTE_HEXES: usize = 24;

/// Hard ceiling on how many partial-route states one train's search may
/// expand before it stops looking and returns the best route found so far.
/// Same purpose as `MAX_ROUTE_HEXES` and same non-game-rule status; this one
/// bounds the search's BREADTH where that one bounds its depth. Exceeding it
/// is not an error -- the search degrades to "best found within budget",
/// which is deterministic (the expansion order is fixed) and can only
/// under-report revenue.
pub const MAX_SEARCH_STATES: u32 = 20_000;

/// Resolves the tile actually in play at `(q, r)` for route tracing, with its
/// scored value. Prefers a real laid `Tile`; falls back to a synthetic, unowned
/// overlay at the six individually-sourced preprinted hexes and then at every
/// other real GRAY preprinted hex. `None` for any other untiled hex.
///
/// Nothing is ever written to `MAP_GRID` -- a read-only overlay for this trace.
///
/// Audit G-9: the overlays carry a `paths` list too, since that is what the
/// traversal follows -- an overlay with an empty list would be unroutable,
/// silently reintroducing the dead-zone bug module doc #20 fixed. They stay
/// FULLY CONNECTED, exactly as permissive as their mask always was.
///
/// `pub(crate)` so the manual route reuses it: a hand-declared route and an
/// automatically-traced one can never disagree about whether an untiled landmark
/// hex is passable or what it is worth.
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
    // Every OTHER real GRAY preprinted hex can never receive a laid `Tile` (Gray Hex
    // Immutability), so without this fallback `MAP_GRID.may_load` would permanently
    // return `None` for them and each would become a silent unroutable dead zone --
    // no route passing through, no value scored -- even though its real printed
    // track genuinely connects to the rest of the board. A gray city scores the flat
    // city figure, a gray town the flat town figure, and a bare connector $0, still
    // passable.
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
    /// other.
    ///
    /// **Step 4.5 Batch 2, item 1: entries MAY now repeat.** A route that
    /// serves both stations of a two-city hex (#62 brown New York, the OO
    /// tiles) lists that hex twice, once per station reached. It is
    /// `PartialRoute::visited_nodes` -- keyed on `(hex, city_node)` -- that
    /// guarantees no STOP is served twice; the hex list is a travel record,
    /// not the uniqueness constraint. `segments` below remains strictly
    /// duplicate-free, and that is the invariant a caller should audit
    /// against.
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

/// Every hex holding at least one RIVAL Station Token, mapped to how many.
///
/// Audit G-9's repointed blockade source. It used to read each rival's first
/// LAID TILE, which is the wrong registry twice over: a track record rather than
/// a token record, and exactly one hex per rival no matter how many tokens that
/// rival had actually placed.
/* ------------------------------------------------------------------ */
/* HEX-LEVEL BLOCKADE ROLL-UP -- test-only in a non-test build          */
/* ------------------------------------------------------------------ */
// `cargo check` reports the five functions in this block as `dead_code`.
// THEY ARE NOT DEAD, AND DELETING THEM BREAKS THE TEST SUITE.
//
// `cargo check` compiles only the library target and `mod tests` is behind
// `#[cfg(test)]`, so the compiler cannot see the callers. `cargo check
// --all-targets` or `cargo test` reports no warning. Live callers, all in
// `src/tests.rs`: `opponent_station_hexes` (4 blockade tests),
// `passability_at`, and `tokened_hexes`/`passability_for_hex`/`hex_passability`
// transitively.
//
// They lost their PRODUCTION callers to Audit G-13, which made routing
// city-granular: the hex-level question -- "is this hex closed to me ENTIRELY"
// -- is too coarse to route on, because a hex is not a city. They are kept
// because that question is still real and correct, just not the one the router
// asks; it is the right question for a caller with a hex and no track, such as a
// map overlay. Keeping them also keeps the four blockade regression tests, which
// are the coverage proving rival tokens blockade at all -- rewriting those
// against the per-city API would trade real coverage for a silenced warning.
//
// `#[allow(dead_code)]` is therefore an ASSERTION, not a suppression.

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

/// The hexes a rival blockade forbids `protocol_id` from routing THROUGH -- every
/// hex where rivals hold tokens and no open slot remains.
///
/// Kept under its original name and shape because the manual route consumes it
/// directly; only the source and rule changed. Two consequences, both strictly
/// more faithful: a rival's mere laid tile no longer blocks anything, and neither
/// does a part-tokened city with a slot open.
///
/// Read this set as "cities no route may pass THROUGH", never as "hexes no route
/// may touch" -- a route may always run INTO a fully-blockaded city and end there.
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

/// Whether `protocol_id` may run THROUGH `(q, r)` entering on `in_edge` and
/// leaving on `out_edge` -- Audit G-13's city-granular transit test for a route
/// whose track is known.
///
/// The same question the DFS asks internally, exposed for the manual route, whose
/// declared path fixes both edges by axial deltas and so knows exactly as much
/// about the track as the search does. Sharing one implementation is what stops
/// the two route paths disagreeing about a blockade.
///
/// `Open` when no segment joins those two edges: the hop is impossible for
/// CONNECTIVITY reasons, a different rejection with a different error. Reporting
/// it as blocked would attribute a connectivity failure to a rival's tokens.
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

/// Whether a route may run THROUGH this hex's revenue centre or only stop there,
/// evaluated independently per city: open if this company holds a token in THAT
/// city (never blocked out of its own station, however full), or if that city
/// still has a slot no rival occupies. A 2-slot city holding ONE rival token
/// blocks nobody; the same city holding TWO blocks everybody else.
///
/// The HEX is `StopOnly` only when EVERY city on it is closed -- a train may
/// still end its route there and score it, it just cannot continue past.
///
/// WHY "any open city opens the hex", stated plainly because it is the one
/// approximation left here: this level is hex-granular and does not track which
/// city a route entered, so the honest question is "can this company get through
/// this hex at all". Tightening it requires the search itself to carry city
/// identity through each hop -- a change to the traversal, not to this function.
///
/// What G-12 fixed is the layer beneath: slot counts and occupants are now
/// per-city, so a hex is no longer judged by a POOLED total that could report
/// room on a hex whose every city was full (#62 carries two 2-slot cities; the
/// pooled count said 4 and could not tell 2+2 from 4+0).
#[allow(dead_code)]
pub(crate) fn passability_at(
    slot_counts: &[u32],
    occupants: &[(u32, u8)],
    protocol_id: u32,
) -> Passability {
    hex_passability(&city_passability_at(slot_counts, occupants, protocol_id))
}

/// The per-city answer, one entry per city, indexed by `city_index` (Audit G-13).
/// This is the primitive; every other passability question here is a roll-up of
/// it. Per city: open if this company holds a token in THAT city -- holding New
/// York's western station does not entitle you to run through its eastern one --
/// or if a slot no rival occupies remains. Otherwise closed.
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

/// Whether a hex is passable AT ALL -- open if ANY city admits this company, and
/// for a hex with no cities.
///
/// A STRICTLY WEAKER question than `HexInfo::transit_passability`, and the
/// distinction is the entire point of Audit G-13. Use it only where the specific
/// track is genuinely unknown. The DFS never uses it: it knows exactly which
/// segment it is traversing, so it asks about that segment's own city.
///
/// `pub(crate)` so the ghost-routing regression can assert the CONTRAST directly:
/// on a tile whose city 0 is blockaded and city 1 open, this roll-up answers
/// `Open` -- which is exactly the ghost route -- while `transit_passability`
/// answers `StopOnly` for city 0's own track. Having both callable side by side
/// is what makes that test evidence rather than assertion.
#[allow(dead_code)]
pub(crate) fn hex_passability(per_city: &[Passability]) -> Passability {
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
    /// Whether a route may run THROUGH this hex along `segment_index` -- Audit G-13,
    /// and the check the DFS actually makes. Resolves to the passability of the ONE
    /// city that segment runs through, so a blockade on city 0 stops a route using
    /// city 0's track while leaving city 1's open -- which is what real 1830 does and
    /// what makes tokening a contested city a defensive move at all.
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

    /// Which NODE a route occupies on this hex. A hex is not a node: #62 and every OO
    /// tile carry TWO independent city nodes on physically separate, non-intersecting
    /// track, and the route history keys on what this returns -- so a route may
    /// legitimately visit both stations while never visiting the same one twice.
    ///
    /// `None` is the SINGLE-NODE answer (treat the whole hex as one indivisible
    /// stop), returned in exactly three deliberately conservative cases: the hex has
    /// no cities at all; the segment-to-city correspondence is not knowable (today,
    /// only a synthesized overlay); or the arriving edge is claimed by two DIFFERENT
    /// cities, which no real 1830 tile does and therefore means the catalog and the
    /// slot table disagree.
    ///
    /// THE ASYMMETRY IS THE WHOLE POINT: guessing `None` can only ever cost a route
    /// revenue it was owed, while guessing a specific node wrongly would hand a train
    /// a second visit to a station it already used -- the exact double-count this
    /// granularity exists to prevent.
    ///
    /// A route still crosses a plain hex at most once even where real 1830 would
    /// allow two passes on separate track. That under-report is deliberately
    /// unchanged: widening it has nothing to do with ghost routing and would enlarge
    /// the search space for no rules benefit.
    pub(crate) fn arrival_city_node(&self, entry_segment_indices: &[usize]) -> Option<u8> {
        if self.city_passability.is_empty() {
            return None;
        }

        let mut resolved: Option<u8> = None;
        for &segment_index in entry_segment_indices {
            match self.segment_cities.get(segment_index).copied().flatten() {
                // Unknown correspondence -- collapse the hex to one node.
                None => return None,
                Some(city_index) => match resolved {
                    None => resolved = Some(city_index),
                    Some(previous) if previous == city_index => {}
                    // Two cities claim the same arriving edge.
                    Some(_) => return None,
                },
            }
        }
        resolved
    }
}

/// Builds a bare `HexInfo` for unit tests (Audit G-13), so the ghost-routing
/// regression can be asserted against the exact decision function the DFS uses,
/// without standing up a game session, a board, eight corporations and a token
/// registry just to reach it.
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
                // Audit G-13: derived from the SAME list, so index `i` in `segment_cities`
                // always describes `paths[i]`. A synthesized overlay's id is deliberately not a
                // real catalog entry, so this comes back all-`None` and `transit_passability`
                // takes its conservative branch -- the correct handling for artwork whose
                // segments carry no city information.
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

/// One node a route has already occupied: `(q, r, city_node)`.
///
/// **Step 4.5 Batch 2, item 1.** This replaced a bare `(q, r)` hex key. See
/// `HexInfo::arrival_city_node` for how the third component is resolved and
/// why `None` collapses a hex back to a single node.
type RouteNode = (i32, i32, Option<u8>);

/// A route under construction during the depth-first search.
#[derive(Clone)]
struct PartialRoute {
    /// Every hex the route runs across, in discovery order. **May now repeat**
    /// -- a route that visits both cities of a two-city hex lists that hex
    /// twice, once per station. `visited_nodes`, not this list, is what
    /// enforces "never the same stop twice".
    hexes: Vec<(i32, i32)>,
    /// Every ledger key this route consumes -- both real through segments
    /// and the half-edge crossing markers described on `hop_claims`.
    claims: Vec<(i32, i32, (u8, u8))>,
    /// **Step 4.5 Batch 2, item 1: the city-granular path history.**
    ///
    /// Was `visited_hexes: HashSet<(i32, i32)>`. Keying on the hex alone
    /// conflated two genuinely different rules -- "a train may not stop at
    /// the same city twice" (real) and "a train may not enter the same hex
    /// twice" (not a rule) -- and on a multi-city tile it enforced the wrong
    /// one, silently refusing the legal route that serves both of New York's
    /// stations.
    ///
    /// Note what does NOT change: a train still cannot jump between the two
    /// stations INSIDE the hex. `expand` only ever moves along
    /// `HEX_NEIGHBOR_OFFSETS` into a neighbouring hex, so reaching the second
    /// station requires physically leaving and coming back on that station's
    /// own track, and `claims` independently forbids reusing any track or
    /// crossing already consumed. Ghost routing is impossible by
    /// construction, not by this set.
    visited_nodes: HashSet<RouteNode>,
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

        // Step 4.5 Batch 2, item 1: the route starts AT a specific station,
        // not merely "on the home hex". On a two-city home (ERIE's E11 is an
        // OO hex) leaving by this segment means starting from THIS segment's
        // city -- so the start state is built per segment rather than once,
        // and the other city remains unvisited and reachable later in the
        // same route.
        let home_node = (home.0, home.1, home_info.arrival_city_node(&[segment_index]));
        let start = PartialRoute {
            hexes: vec![home],
            claims: Vec::new(),
            visited_nodes: HashSet::from([home_node]),
            revenue_centres: u32::from(home_info.is_revenue_centre),
            value: home_info.value,
        };
        // Audit G-13: the home hex needs the same per-city transit test as every other,
        // and it is NOT covered by "you always hold a token at home". A company's home
        // token sits in ONE city; a home hex with TWO cities (ERIE's E11 is an OO hex)
        // can have its other city filled by rivals, and that city's track is then closed
        // to the company whose home it is.
        //
        // Only the two-armed JOIN is a transit -- a single arm starts at home and
        // leaves, passing through nothing -- so the flag is computed here and consulted
        // only where it applies.
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

    if route.hexes.len() >= MAX_ROUTE_HEXES {
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

    // ==== Step 4.5 Batch 2, item 1: CITY-GRANULAR PATH HISTORY. ====
    //
    // This check used to read `route.visited_hexes.contains(&next)` and sat
    // ABOVE the claims test, before the tile had even been loaded. It cannot
    // sit there any more, and the relocation IS the change: WHICH node this
    // hop lands on is a property of the track the route arrives on, so the
    // tile's segments must be resolved before the question can be asked. The
    // move is behaviour-neutral in itself -- both orderings reject by
    // returning `Ok(None)`, and neither writes anything.
    //
    // What it fixes: on a tile carrying two independent city nodes -- #62,
    // the brown New York upgrade, and every OO tile -- the hex key refused
    // the second station outright, so a route that legally served both
    // scored only one of them. `terrain_base_value` prices `NewYorkHub` and
    // `DoubleCityHub` PER STATION ($40 each, see their own comments) exactly
    // because the old engine could reach only one per pass; with the node key
    // the per-station price is now applied per station actually reached,
    // which is what those figures always meant.
    //
    // What it does NOT loosen, and this is the part worth being explicit
    // about, because a node key is strictly more permissive than a hex key:
    //
    // - **No intra-hex jump.** Reaching the second station is not a move
    //   inside the hex. `expand` only ever steps to a NEIGHBOUR via
    //   `HEX_NEIGHBOR_OFFSETS`, so the route must physically leave and come
    //   back along the other station's own track.
    // - **No reused rail.** That return trip must clear the `claims` test
    //   above on all three of its keys, including both halves of the
    //   crossing -- so it cannot re-enter over track it already ran.
    // - **No double-counted station.** Two segments of the SAME city resolve
    //   to the same node and collide here, so a multi-spoke city hub
    //   (#14/#15/#53/#61/#63, one city, many segments) still admits exactly
    //   one visit, exactly as before.
    // - **No guessing.** Where the segment-to-city correspondence is
    //   uncertain, `arrival_city_node` collapses the hex to a single node and
    //   the old behavior applies unchanged.
    let entry_segment_indices: Vec<usize> =
        entry_segments.iter().map(|(index, _)| *index).collect();
    let next_node: RouteNode = (
        next.0,
        next.1,
        next_info.arrival_city_node(&entry_segment_indices),
    );
    if route.visited_nodes.contains(&next_node) {
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
    extended.visited_nodes.insert(next_node);
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

    // Audit G-13: PER-CITY TRANSIT. A fully-blockaded city may be STOPPED AT but
    // never run through, and what changed is the GRANULARITY of that test -- a rules
    // fix, not a refactor.
    //
    // This was previously one hex-level check evaluated BEFORE the loop, returning
    // early. On a multi-city tile that let a route enter through a fully-tokened
    // city's own track and leave again as long as SOME OTHER city on the same tile
    // had a free slot -- ghost routing straight through the blockade. On #62 and the
    // OO tiles the two cities sit on physically separate track, so this was never a
    // close call: the route was riding rails it had no access to.
    //
    // The check now lives INSIDE the loop and is asked per segment. `expand` is
    // still reached for the hex itself, so the route may still END here and score it.
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

/// Traces one route per train `protocol_id` owns, such that no two of its trains
/// reuse the same track segment in a single Operating Round (Audit G-9).
///
/// Trains run biggest-first, each taking the best route still available given
/// what earlier trains claimed -- greedy rather than jointly optimal. Returns the
/// summed value and the routes in assignment order. A company with no Hardware,
/// no home hex, or nothing but a single revenue centre in reach returns nothing,
/// as does a train for which no unclaimed route remains.
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
