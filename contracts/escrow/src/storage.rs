//! The storage-only shape of a game (ESCROW-2.3).
//!
//! Handlers, queries and the schema only ever see the public [`Game`]. Under
//! `GAMES` a game is stored as a [`StoredGame`]: the same 29 fields (27 in 2.0.0), with the
//! same names and the same JSON encodings, regrouped into four nested objects:
//!
//! | group      | fields |
//! |------------|--------|
//! | `created`  | chain_game_id, creator, max_players, mode, rules_engine_version, variants_digest, denom, terms, created_at, funding_deadline |
//! | `money`    | ante_gross, subsidy_per_seat, ante_net, pool, bond |
//! | `roster`   | seats, roster_hash, domain, resolver, started_at |
//! | `progress` | state, last_activity, last_seq, settlement, consent_bitmap, dispute, outcome, review_request, remedy |
//!
//! Why: CosmWasm VM 2.2.9 / 3.0.9 (wasmvm v2.2.8 / v3.0.7) refuse a contract
//! with a function that declares more than 100 locals. The derived visitor of
//! the flat 27-field `Game` alone had 100, and the optimizer's `wasm-opt -Os`
//! inlines every nested visitor into `from_json::<Game>` (135). With four
//! groups, each boxed, the top-level visitor keeps four pointers instead of 27
//! live accumulators, and the group visitors (and the boxed `settlement`,
//! `dispute`, `outcome`) run one after another, so their locals coalesce.
//!
//! Rules:
//! * The conversion is lossless in both directions, field by field, with no
//!   defaults and nothing recomputed. Every conversion destructures without
//!   `..`, so adding, removing or renaming a field of `Game` or of a group is a
//!   compile error here.
//! * Saving serializes a borrowed [`StoredGameView`] with exactly the same JSON
//!   shape, so a save neither clones the game nor inflates `save_game`.
//! * `GAMES` is private to this module. The only ways in or out are
//!   [`load_game`], [`save_game`] (used by the same-named `helpers`) and
//!   [`games_after`] (the `Games` query), and each converts explicitly, so no
//!   other code can read or write the stored shape. A source scan
//!   (`storage_seams_are_the_only_games_access`) also keeps the `"games"`
//!   namespace literal in this file and rejects `#[path]`/`include!`.
//! * No compatibility with the previous flat JSON: nothing was ever deployed,
//!   so there is no stored state to migrate. That is the only reason this
//!   storage change needs no migration.
//! * Escrow 2.1.0 adds fields that are all optional or defaulted and read as
//!   absent from a game stored by 2.0.0 code: `terms.policy`,
//!   `terms.review_delay_secs`, `terms.allowance_secs`,
//!   `terms.cure_window_secs` (inside `created`), `progress.review_request` and
//!   `progress.remedy` (boxed). A 2.0.0 game read by this code therefore has
//!   `policy == None` and keeps 2.0.0 semantics (`state::GamePolicy`); nothing
//!   else in the stored shape changed.
use cosmwasm_schema::cw_serde;
use cosmwasm_std::{
    to_json_vec, Addr, HexBinary, Order, StdResult, Storage, Timestamp, Uint128, Uint64,
};
use cw_storage_plus::{Bound, Map};
use serde::Serialize;

use crate::state::{
    DisputeRecord, Game, GameState, GameTerms, Mode, Outcome, RemedyRecord, ReviewRequest, Seat,
    SettlementRecord,
};

/// `chain_game_id` → the game in its storage-only shape.
const GAMES: Map<u64, StoredGame> = Map::new("games");

/// The stored game, converted to the public [`Game`].
pub(crate) fn load_game(storage: &dyn Storage, chain_game_id: u64) -> StdResult<Option<Game>> {
    Ok(GAMES.may_load(storage, chain_game_id)?.map(Game::from))
}

/// Stores `game` under its id. Serializes a borrowed [`StoredGameView`] (no
/// clone) with the same key and codec `Map::save` uses.
pub(crate) fn save_game(storage: &mut dyn Storage, game: &Game) -> StdResult<()> {
    let bytes = to_json_vec(&StoredGameView::from(game))?;
    storage.set(&GAMES.key(game.chain_game_id), &bytes);
    Ok(())
}

/// Games with an id above `start_after`, ascending, each converted to the
/// public [`Game`].
pub(crate) fn games_after(
    storage: &dyn Storage,
    start_after: Option<u64>,
) -> impl Iterator<Item = StdResult<Game>> + '_ {
    GAMES
        .range(
            storage,
            start_after.map(Bound::exclusive),
            None,
            Order::Ascending,
        )
        .map(|item| item.map(|(_, stored)| Game::from(stored)))
}

/// A game as stored under `GAMES`. Never returned by a query.
#[cw_serde]
struct StoredGame {
    created: Box<StoredCreated>,
    money: Box<StoredMoney>,
    roster: Box<StoredRoster>,
    progress: Box<StoredProgress>,
}

/// Fixed when the game is created.
#[cw_serde]
struct StoredCreated {
    chain_game_id: u64,
    creator: Addr,
    max_players: u8,
    mode: Mode,
    rules_engine_version: u32,
    variants_digest: HexBinary,
    denom: String,
    terms: GameTerms,
    created_at: Timestamp,
    funding_deadline: Timestamp,
}

/// Deposit amounts, the pool and the bond.
#[cw_serde]
struct StoredMoney {
    ante_gross: Uint128,
    subsidy_per_seat: Uint128,
    ante_net: Uint128,
    pool: Uint128,
    bond: Option<Uint128>,
}

/// Seats and what `Start` froze about them.
#[cw_serde]
struct StoredRoster {
    seats: Vec<Seat>,
    roster_hash: Option<HexBinary>,
    domain: Option<HexBinary>,
    resolver: Option<Addr>,
    started_at: Option<Timestamp>,
}

/// Lifecycle, sequence bookkeeping and adjudication.
#[cw_serde]
struct StoredProgress {
    state: GameState,
    last_activity: Option<Timestamp>,
    last_seq: Uint64,
    settlement: Option<Box<SettlementRecord>>,
    consent_bitmap: u8,
    dispute: Option<Box<DisputeRecord>>,
    outcome: Option<Box<Outcome>>,
    /// Escrow 2.1.0; absent in a game stored by 2.0.0 code (read as `None`).
    #[serde(default)]
    review_request: Option<ReviewRequest>,
    /// Escrow 2.1.0; absent in a game stored by 2.0.0 code (read as `None`).
    #[serde(default)]
    remedy: Option<Box<RemedyRecord>>,
}

// A destructured field left unused is a dropped field: refuse to compile.
#[deny(unused_variables)]
impl From<Game> for StoredGame {
    fn from(game: Game) -> Self {
        let Game {
            chain_game_id,
            state,
            creator,
            max_players,
            mode,
            rules_engine_version,
            variants_digest,
            denom,
            ante_gross,
            subsidy_per_seat,
            ante_net,
            terms,
            created_at,
            funding_deadline,
            pool,
            seats,
            roster_hash,
            domain,
            bond,
            resolver,
            started_at,
            last_activity,
            last_seq,
            settlement,
            consent_bitmap,
            dispute,
            outcome,
            review_request,
            remedy,
        } = game;
        StoredGame {
            created: Box::new(StoredCreated {
                chain_game_id,
                creator,
                max_players,
                mode,
                rules_engine_version,
                variants_digest,
                denom,
                terms,
                created_at,
                funding_deadline,
            }),
            money: Box::new(StoredMoney {
                ante_gross,
                subsidy_per_seat,
                ante_net,
                pool,
                bond,
            }),
            roster: Box::new(StoredRoster {
                seats,
                roster_hash,
                domain,
                resolver,
                started_at,
            }),
            progress: Box::new(StoredProgress {
                state,
                last_activity,
                last_seq,
                settlement: settlement.map(Box::new),
                consent_bitmap,
                dispute: dispute.map(Box::new),
                outcome: outcome.map(Box::new),
                review_request,
                remedy: remedy.map(Box::new),
            }),
        }
    }
}

// A destructured field left unused is a dropped field: refuse to compile.
#[deny(unused_variables)]
impl From<StoredGame> for Game {
    fn from(stored: StoredGame) -> Self {
        let StoredGame {
            created,
            money,
            roster,
            progress,
        } = stored;
        let StoredCreated {
            chain_game_id,
            creator,
            max_players,
            mode,
            rules_engine_version,
            variants_digest,
            denom,
            terms,
            created_at,
            funding_deadline,
        } = *created;
        let StoredMoney {
            ante_gross,
            subsidy_per_seat,
            ante_net,
            pool,
            bond,
        } = *money;
        let StoredRoster {
            seats,
            roster_hash,
            domain,
            resolver,
            started_at,
        } = *roster;
        let StoredProgress {
            state,
            last_activity,
            last_seq,
            settlement,
            consent_bitmap,
            dispute,
            outcome,
            review_request,
            remedy,
        } = *progress;
        Game {
            chain_game_id,
            state,
            creator,
            max_players,
            mode,
            rules_engine_version,
            variants_digest,
            denom,
            ante_gross,
            subsidy_per_seat,
            ante_net,
            terms,
            created_at,
            funding_deadline,
            pool,
            seats,
            roster_hash,
            domain,
            bond,
            resolver,
            started_at,
            last_activity,
            last_seq,
            settlement: settlement.map(|s| *s),
            consent_bitmap,
            dispute: dispute.map(|d| *d),
            outcome: outcome.map(|o| *o),
            review_request,
            remedy: remedy.map(|r| *r),
        }
    }
}

/// [`StoredGame`]'s JSON, serialized from a borrowed [`Game`]. Field names and
/// order match the owned groups exactly (`view_serializes_exactly_like_stored_game`).
#[derive(Serialize)]
struct StoredGameView<'a> {
    created: CreatedView<'a>,
    money: MoneyView<'a>,
    roster: RosterView<'a>,
    progress: ProgressView<'a>,
}

#[derive(Serialize)]
struct CreatedView<'a> {
    chain_game_id: &'a u64,
    creator: &'a Addr,
    max_players: &'a u8,
    mode: &'a Mode,
    rules_engine_version: &'a u32,
    variants_digest: &'a HexBinary,
    denom: &'a String,
    terms: &'a GameTerms,
    created_at: &'a Timestamp,
    funding_deadline: &'a Timestamp,
}

#[derive(Serialize)]
struct MoneyView<'a> {
    ante_gross: &'a Uint128,
    subsidy_per_seat: &'a Uint128,
    ante_net: &'a Uint128,
    pool: &'a Uint128,
    bond: &'a Option<Uint128>,
}

#[derive(Serialize)]
struct RosterView<'a> {
    seats: &'a Vec<Seat>,
    roster_hash: &'a Option<HexBinary>,
    domain: &'a Option<HexBinary>,
    resolver: &'a Option<Addr>,
    started_at: &'a Option<Timestamp>,
}

#[derive(Serialize)]
struct ProgressView<'a> {
    state: &'a GameState,
    last_activity: &'a Option<Timestamp>,
    last_seq: &'a Uint64,
    settlement: &'a Option<SettlementRecord>,
    consent_bitmap: &'a u8,
    dispute: &'a Option<DisputeRecord>,
    outcome: &'a Option<Outcome>,
    review_request: &'a Option<ReviewRequest>,
    remedy: &'a Option<RemedyRecord>,
}

// A destructured field left unused is a dropped field: refuse to compile.
#[deny(unused_variables)]
impl<'a> From<&'a Game> for StoredGameView<'a> {
    fn from(game: &'a Game) -> Self {
        let Game {
            chain_game_id,
            state,
            creator,
            max_players,
            mode,
            rules_engine_version,
            variants_digest,
            denom,
            ante_gross,
            subsidy_per_seat,
            ante_net,
            terms,
            created_at,
            funding_deadline,
            pool,
            seats,
            roster_hash,
            domain,
            bond,
            resolver,
            started_at,
            last_activity,
            last_seq,
            settlement,
            consent_bitmap,
            dispute,
            outcome,
            review_request,
            remedy,
        } = game;
        StoredGameView {
            created: CreatedView {
                chain_game_id,
                creator,
                max_players,
                mode,
                rules_engine_version,
                variants_digest,
                denom,
                terms,
                created_at,
                funding_deadline,
            },
            money: MoneyView {
                ante_gross,
                subsidy_per_seat,
                ante_net,
                pool,
                bond,
            },
            roster: RosterView {
                seats,
                roster_hash,
                domain,
                resolver,
                started_at,
            },
            progress: ProgressView {
                state,
                last_activity,
                last_seq,
                settlement,
                consent_bitmap,
                dispute,
                outcome,
                review_request,
                remedy,
            },
        }
    }
}

#[cfg(test)]
mod tests;
