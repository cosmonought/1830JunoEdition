//! Operating Round Revenue Execution: connects private and public
//! companies to the player cash pools once per Operating Round, in two
//! sequential phases.
//!
//! Design notes / assumptions, since neither `rules.md` nor the existing
//! message/state definitions cover a batched Operating Round message:
//!
//! 1. **Authorization.** Unlike `DeclareDividends` (called per-company by
//!    that company's own `PROTOCOL_PRESIDENT`), `ExecuteOperatingRound`
//!    processes every private and every submitted public company in a
//!    single transaction, so there's no single president to authorize it.
//!    This mirrors `EndGameAndDistribute`'s model instead: only the game
//!    room's `creator` (its Validator/organizer) may call it.
//! 2. **Phase 1 (Private Assets).** Iterates the same canonical
//!    `auction::CORE_PRIVATE_COMPANIES` list used to seed the game, so the
//!    set of private ids processed can never drift out of sync with what
//!    was actually spawned. Companies with no current owner (unsold, or --
//!    not currently possible, but defensively handled -- somehow cleared)
//!    are skipped rather than erroring, since an unowned private simply has
//!    no one to pay.
//! 3. **Phase 2 (Public Corporations).** Only processes companies actually
//!    listed in `public_company_choices`; a company must already be
//!    `is_floated` (`CompanyNotFloated` otherwise), since an unfloated
//!    company has no shareholders, no treasury capitalization, and no
//!    market position to move. Revenue is no longer a caller-supplied
//!    number -- it's computed automatically via
//!    `pathfinding::trace_best_route` (the Pathfinding Revenue Engine,
//!    `rules.md` Step 3), bounded by the company's best owned Hardware's
//!    `max_route_distance`; the caller only chooses, per listed company,
//!    whether to distribute or retain whatever that route earns. The
//!    `payout: true` split replicates `trading::execute_declare_dividends`'s
//!    "distribute across all 100% of shares, credit the pool's/bank's
//!    share to `GameSession::virtual_bank_vgp`" pattern exactly, for
//!    consistency between the two dividend paths.
//! 4. **Treasury divergence -- RESOLVED (Audit G-2).** Withheld
//!    (`payout: false`) public earnings are credited to
//!    `PublicCompany::treasury`, the field introduced for the Public
//!    Company Initialization Engine. `trading::execute_declare_dividends`'s
//!    `distribute: false` path used to credit a SEPARATE
//!    `PROTOCOL_TREASURY_VGP` map instead, and the two were never
//!    reconciled -- so a company's "true" treasury balance was split across
//!    two ledgers, only one of which anything could actually spend from.
//!    That map is now deleted (see `state.rs`'s removal note) and both
//!    withhold paths, plus the IPO pool's dividend share, write
//!    `PublicCompany::treasury` exclusively. There is now exactly one
//!    corporate cash ledger, and this module's branches below were already
//!    on the correct side of it -- they are unchanged by the fix.
//! 5. **Market position.** Both payout branches call
//!    `market::ensure_protocol_position` before moving the price, exactly
//!    like `trading.rs`, so a public company that floated without ever
//!    trading still has a valid grid position to move from.
//! 6. **Zero-revenue companies are skipped, not erroring.** A listed
//!    company that owns no Hardware, or has laid no track (so
//!    `pathfinding::trace_best_route` returns zero), is still validated
//!    (must exist and be floated) but contributes no cash movement or
//!    market shift for that phase -- there's nothing to distribute or
//!    retain and no meaningful price movement to make.
//!
//! ---
//!
//! **The Operating Round Corporation Turn Queue (Step 1 of the per-company
//! OR turn structure).** `execute_operating_round` above is a *separate*,
//! pre-existing mechanic: one batched, creator-only transaction that runs
//! every listed company's revenue in one shot. `calculate_operating_order`/
//! `execute_begin_operating_round` below start building a different,
//! *sequential* structure on top of it -- the classic 1830 rule that
//! Operating Round corporations act one at a time, in a fixed order, each
//! taking as many of its own actions (lay track, buy Hardware, declare
//! dividends) as it wants before the next corporation's turn:
//!
//! 7. **Ordering rule.** `calculate_operating_order` queries every currently
//!    floated `PUBLIC_COMPANIES` entry, reads its live price off
//!    `PROTOCOL_MARKET`/`MARKET_GRID` (via `market::current_cell`), and
//!    sorts highest price first -- the real 1830 rule ("operate in stock
//!    price order, highest first"). Unfloated companies never appear in the
//!    order; they have no shareholders or treasury to run an OR turn with.
//! 8. **Tie-breaker.** Two companies sharing the exact same price are
//!    ordered by `ProtocolMarketState::arrival_sequence` (higher first) --
//!    whichever protocol's marker most recently moved or was placed
//!    anywhere on the grid. This is the practical stand-in for the real
//!    1830 rule ("whichever token is stacked on top of the shared price
//!    cell acts first"): since this contract's invented linear price
//!    formula (`market::seed_default_price_grid`) can coincidentally give
//!    two *different* cells the same price, "most recently arrived,
//!    per-protocol" is used instead of "physically on top of one specific
//!    cell's token stack" -- see `arrival_sequence`'s doc comment in
//!    `state.rs`.
//! 9. **`execute_begin_operating_round` populates the queue.** Authorized
//!    exactly like `execute_operating_round` (creator/Validator-only, since
//!    starting an Operating Round is a room-level administrative action,
//!    not any one company's). It calls `calculate_operating_order`, writes
//!    the result into `GameSession::active_operating_order`, and resets
//!    `active_corporation_index` to `0` -- errors with
//!    `NoFloatedCompanies` if the order comes back empty, since a queue
//!    with nothing in it can't meaningfully gate anything.
//! 10. **`EndOperatingRoundTurn` (Step 2): advances the queue.** A follow-up
//!     to Step 1 above -- `hexmap::execute_lay_tile`,
//!     `hardware::execute_buy_hardware_from_pool`, and
//!     `trading::execute_declare_dividends` were already wrapped to
//!     *enforce* the queue (see each module's own doc comment), but nothing
//!     used to advance `active_corporation_index` from one corporation to
//!     the next once it was populated -- only the very first corporation in
//!     the order could ever act. `execute_end_operating_round_turn` closes
//!     that gap: called by whichever protocol's President is currently
//!     pointed to by `active_corporation_index` (`NotYourOperatingTurn`
//!     otherwise, the identical check `LayTile`/`BuyHardwareFromPool`/
//!     `DeclareDividends` already perform), it moves the pointer to the next
//!     corporation in `active_operating_order`. This deliberately does *not*
//!     itself validate that the ending corporation actually took an action
//!     this turn (laid track, bought Hardware, declared dividends) --
//!     passing turn with zero actions taken is legal in 1830 (a company can
//!     have nothing useful to do), so requiring at least one prior action
//!     here would be an invented restriction, not a rule this contract's
//!     other modules establish. `EndOperatingRoundTurn` is not recorded to
//!     `GAME_LOG` (see `gamelog.rs`'s module doc comment #2), for the same
//!     reconciliation reasons `ExecuteOperatingRound`/`BeginOperatingRound`
//!     already aren't.
//! 11. **Macro Round Tracker / Pacing Automation.** `execute_begin_operating_round`
//!     is this contract's one existing explicit "a Stock Round concludes, an
//!     Operating Round begins" transition point (design note #9) -- there is
//!     no automatic pass-streak-based Stock Round ending anywhere in this
//!     codebase (`GameSession::consecutive_passes` is explicitly "tracked
//!     but not yet consumed," per its own doc comment), so Pacing Automation
//!     is hooked in here rather than at an invented new trigger. On every
//!     successful call, `session.current_round_type` flips to
//!     `RoundType::OperatingRound`, `session.sub_round_index` resets to `1`
//!     (the first sub-round of the new Operating Round phase), and
//!     `session.operating_round_sequence_length` is recomputed via
//!     `hardware::highest_train_tier_purchased` /
//!     `hardware::operating_round_sequence_length_for_tier` -- the classic
//!     1830 rule that a 2-train paces 1 OR, a 3/4-train paces 2 ORs, and a
//!     5-train-or-higher paces 3 ORs (see `hardware.rs`'s module doc comment
//!     #10 for the full lookup).
//! 12. **Macro Round Loop Advancement.** `GameSession::macro_round_number`
//!     used to be left untouched everywhere -- nothing in this contract
//!     detected a full macro-round cycle completing to know when to bump
//!     it. `execute_end_operating_round_turn` (design note #10) now closes
//!     this loop: whenever advancing `active_corporation_index` would run
//!     past the end of `active_operating_order` (every corporation has had
//!     its turn this OR sub-round), one of two things happens. If
//!     `session.sub_round_index` hasn't yet reached
//!     `session.operating_round_sequence_length`, the Pacing Automation
//!     schedule (design note #11) isn't done yet: `sub_round_index`
//!     increments by one, `active_corporation_index` resets to `0`, and
//!     `active_operating_order` is *recomputed* via
//!     `calculate_operating_order` rather than simply replayed -- stock
//!     prices can move mid-sub-round (Distribute Yield moves a company's
//!     marker right, Slash/Retain moves it left), so the next sub-round's
//!     operating order should reflect prices as of when it starts, exactly
//!     like `execute_begin_operating_round` computes a fresh order rather
//!     than reusing a stale one. If `sub_round_index` has already reached
//!     `operating_round_sequence_length`, the entire paced Operating Round
//!     phase is done: `session.macro_round_number` increments by one,
//!     `sub_round_index` resets to `0`, `current_round_type` flips back to
//!     `RoundType::StockRound`, and `active_operating_order`/
//!     `active_corporation_index` are cleared -- mirroring exactly what
//!     `gamelog::reapply_game_log`'s genesis reset already does to those
//!     five fields, since a Stock Round has no operating queue to enforce.
//!     LIMITATION (flagged, not fixed here): this doesn't yet gate re-entry
//!     into a Stock Round behind anything (e.g. `BuyStock`/`SellStock` were
//!     never gated *out* during an Operating Round in the first place -- see
//!     `trading.rs`'s own doc comments), so `current_round_type` is
//!     currently informational/display-oriented (surfaced through
//!     `GetGameState`) rather than itself an enforcement gate on trading
//!     messages; wiring that up is future work, not assumed here.
//! 13. **Manual Route Validation.** `execute_run_manual_route` is a THIRD way
//!     to earn Operating Round revenue for a single company, alongside the
//!     batched `execute_operating_round` (design notes #1-#6) and the
//!     step-by-step queue this file otherwise assumes. Instead of trusting
//!     `pathfinding::trace_best_route`'s automatic search, the caller
//!     submits their own `hex_path` (real board labels, e.g. `["G19",
//!     "F20"]`), which is validated hop-by-hop against the identical rules
//!     that search already enforces implicitly -- connectivity via
//!     `hexmap::rotate_connections`, the "home hex is the company's only
//!     modeled station" stand-in, and rival-station blocking
//!     (`pathfinding::opponent_station_hexes`, now `pub(crate)` so both
//!     paths share one implementation and can never disagree). See that
//!     function's own doc comment for the full five-step validation and why
//!     it always Distribute-Yields (no retain choice on this message) and
//!     always advances the Operating Round Corporation Turn Queue
//!     afterward, via the `advance_operating_round_turn` helper factored out
//!     of `execute_end_operating_round_turn` (design note #10) for exactly
//!     this reuse. Not recorded to `GAME_LOG`, for the same
//!     live-track-state reconciliation reasons `ExecuteOperatingRound`
//!     already isn't (see `gamelog.rs`'s module doc comment #2).
//! 14. **Automatic Pre-OR Revenue Payout.** Every private company's fixed
//!     `revenue_per_or` is now paid automatically at the ABSOLUTE
//!     initialization step of every Operating Round in the sequential
//!     per-corporation-turn structure (design notes #7-#12) -- before the
//!     very first queued corporation's own Track sub-phase ever runs.
//!     `pay_private_company_revenues` (shared, called from both places
//!     below) mirrors `execute_operating_round`'s own pre-existing Phase 1
//!     loop, plus the corporate-ownership branch `PrivateCompany`'s doc
//!     comment in `state.rs` describes: a player-owned private credits
//!     `PLAYER_CASH_VGP` directly, a corporation-owned one credits that
//!     corporation's own `PublicCompany::treasury` instead, and a `closed`
//!     private is skipped entirely. "Every Operating Round" means every
//!     PACED SUB-ROUND, not just the first one of a macro round -- Pacing
//!     Automation (design note #11) can schedule 1-3 sub-rounds per macro
//!     round, and real 1830 pays private revenue at the start of each one
//!     individually, not once per macro round -- so this is hooked into
//!     BOTH `execute_begin_operating_round` (the very first sub-round) AND
//!     `advance_operating_round_turn`'s "advanced_to_next_sub_round" branch
//!     (every sub-round after the first).
//!
//!     NOT wired into `execute_operating_round` (design notes #1-#6): that
//!     remains a separate, legacy, creator-batched mechanic with its own
//!     pre-existing Phase 1, left unchanged here. A room that calls BOTH
//!     `BeginOperatingRound`/a sub-round advance AND `ExecuteOperatingRound`
//!     within what a player would consider the "same" Operating Round will
//!     have every active private paid twice, once per mechanism -- a real,
//!     known interaction, flagged here exactly the way design note #4's
//!     Treasury Divergence already is rather than resolved, since unifying
//!     the two OR mechanics outright is a larger change than this feature
//!     asked for.

use std::collections::HashSet;

use cosmwasm_std::{Attribute, DepsMut, Env, MessageInfo, Response, StdError, Storage, Uint128};
use thiserror::Error;

use crate::auction::CORE_PRIVATE_COMPANIES;
use crate::hardware;
use crate::hexmap::{
    axial_for_label, city_slot_counts_at, edge_between, rotate_connections, HEX_NEIGHBOR_OFFSETS,
};
use crate::market::{self, MarketError};
use crate::msg::{PayoutStrategy, RouteWaypoint};
use crate::pathfinding::{self, PathfindingError};
use crate::public_company::CORE_PUBLIC_COMPANIES;
use crate::or_phase;
use crate::train_trade;
use crate::state::{
    GameSession, OperatingSubPhase, PrivateCompany, PublicCompany, RoundType, Tile, COMPANY_HARDWARE,
    HARDWARE_POOL,
    PLAYER_CASH_VGP, PLAYER_SHARES, PRIVATE_COMPANIES, PROTOCOL_MARKET, PROTOCOL_NETWORK_HEXES,
    PROTOCOL_PRESIDENT, PUBLIC_COMPANIES, SESSIONS,
};
use crate::trading::{self, FULL_POOL_PERCENTAGE};

#[derive(Error, Debug)]
pub enum OperationsError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Market(#[from] MarketError),

    #[error("{0}")]
    Pathfinding(#[from] PathfindingError),

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    /// Audit G-8: the classic 1830 rule that a corporation owning no train
    /// MUST buy one before its Operating Round turn can end.
    #[error(
        "Protocol {protocol_id} owns no Hardware and cannot end its Operating Round turn -- 1830 requires a trainless corporation to buy a train (BuyHardwareFromPool, or EmergencyBuyHardware if its treasury falls short). {pool_units_remaining} unit(s) remain in the pool"
    )]
    MustPurchaseTrain {
        game_id: u64,
        protocol_id: u32,
        pool_units_remaining: u32,
    },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error(
        "Game room {game_id}'s Pre-Game Waterfall Auction is still in progress -- Operating Rounds cannot begin until every private company is allocated and Stock Round 1 opens"
    )]
    WaterfallAuctionInProgress { game_id: u64 },

    #[error("Unauthorized: only the game room creator may execute an Operating Round")]
    Unauthorized {},

    #[error("Public company {company_id} was not found in game room {game_id}")]
    PublicCompanyNotFound { game_id: u64, company_id: u32 },

    #[error(
        "Public company {company_id} has not floated yet and cannot earn Operating Round revenue"
    )]
    CompanyNotFloated { company_id: u32 },

    #[error(
        "Game room {game_id} has no currently floated public companies; the Operating Round Corporation Turn Queue cannot be started"
    )]
    NoFloatedCompanies { game_id: u64 },

    #[error("Arithmetic overflow/underflow while processing Operating Round revenue")]
    Overflow {},

    #[error(
        "Protocol {protocol_id} has no registered President in game room {game_id}, so it cannot end an Operating Round turn"
    )]
    NoPresidentAssigned { game_id: u64, protocol_id: u32 },

    #[error(
        "Unauthorized: only protocol {protocol_id}'s registered President may end its Operating Round turn"
    )]
    NotPresident { protocol_id: u32 },

    #[error(
        "Game room {game_id} has no active Operating Round Corporation Turn Queue -- BeginOperatingRound must run first"
    )]
    NoActiveOperatingOrder { game_id: u64 },

    /// Audit G-15b: the corporation has an unanswered train offer standing.
    /// It may still buy from the Bank, but it cannot end its turn -- and it
    /// can always clear this itself with `RescindTrainOffer`.
    #[error(
        "protocol {protocol_id} cannot end its turn: train offer {offer_id} to protocol {seller_protocol_id} is still unanswered. Wait for a reply, or rescind it."
    )]
    PendingTrainOfferBlocksTurn {
        protocol_id: u32,
        offer_id: u64,
        seller_protocol_id: u32,
    },

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
    /// Audit G-14: `AdvanceOperatingSubPhase` was called on a phase that may
    /// not be skipped. `Routes` is skippable only by a corporation owning no
    /// train; `Dividends` never is.
    #[error(
        "protocol {protocol_id} may not skip Operating Round phase {phase}: {reason}"
    )]
    OperatingSubPhaseNotSkippable {
        protocol_id: u32,
        phase: String,
        reason: String,
    },
    #[error(
        "It is not protocol {protocol_id}'s turn in game room {game_id}'s Operating Round Corporation Turn Queue; protocol {expected_protocol_id} must act first"
    )]
    NotYourOperatingTurn {
        game_id: u64,
        protocol_id: u32,
        expected_protocol_id: u32,
    },

    // ---- Manual Route Validation -- see `execute_run_manual_route`. ----
    /// **Step 4.5 Batch 3, item 1.** A waypoint named a city index the hex's
    /// artwork does not have -- e.g. `city_node: Some(1)` on a single-city
    /// tile. Rejected rather than coerced to city 0: paying revenue for a
    /// station that does not exist is worse than refusing a malformed route.
    #[error(
        "Hex {label} has {cities} city/cities, so city_node {city_node} does not exist there"
    )]
    NoSuchCityOnHex {
        label: String,
        city_node: usize,
        cities: usize,
    },

    #[error("RunManualRoute's path cannot be empty")]
    EmptyRoutePath { protocol_id: u32 },

    #[error("\"{label}\" is not a real 1830 board hex label")]
    InvalidHexLabel { label: String },

    #[error("Hex \"{label}\" appears more than once in this route -- a route cannot revisit a hex")]
    DuplicateHexInRoute { label: String },

    #[error(
        "Protocol {protocol_id} has laid no track yet, so it has no home station a manual route could touch"
    )]
    CompanyHasNoHomeStation { protocol_id: u32 },

    #[error(
        "This route never touches protocol {protocol_id}'s own station (its home hex) -- a route must run to or through a station the operating company actually owns"
    )]
    RouteMustTouchOwnStation { protocol_id: u32 },

    #[error(
        "Hex \"{label}\" is a city whose every station slot is taken by rival tokens, so this route cannot pass THROUGH it -- a route may still end there, by listing it as its first or last hex"
    )]
    RouteBlockedByRivalStation { label: String },

    #[error("Protocol {protocol_id} owns no Hardware (trains), so it cannot run any route")]
    NoHardwareOwned { protocol_id: u32 },

    #[error(
        "This route visits {distance} hexes, exceeding protocol {protocol_id}'s best-owned Hardware's max route distance of {max_distance}"
    )]
    RouteExceedsMaxDistance {
        protocol_id: u32,
        distance: u32,
        max_distance: u32,
    },

    #[error("Hex \"{label}\" has no tile laid at all, so it carries no track this route could use")]
    NoTileAtHex { label: String },

    #[error(
        "\"{from}\" and \"{to}\" are not connected by a legal track edge -- a manual route must be an unbroken chain"
    )]
    DisconnectedRouteSegment { from: String, to: String },
}

// REMOVED (Audit G-13): `execute_operating_round`, the legacy batched
// Operating Round handler, together with its `ExecuteMsg::ExecuteOperatingRound`
// variant and `msg::PublicCompanyPayoutChoice`.
//
// Two independent Operating Round mechanics coexisted in this module: this
// creator-authorized batch, which ran every listed company's revenue in one
// transaction, and the sequential `BeginOperatingRound` /
// `EndOperatingRoundTurn` corporation queue below. BOTH paid out every
// private company's `revenue_per_or`, and nothing reconciled them -- so a
// room that drove both within what a player would consider one Operating
// Round paid every private TWICE. That was flagged in this module's own doc
// comment #14 and is now fixed by deletion rather than reconciliation: the
// sequential queue is the sole source of truth for Operating Round
// execution, and `pay_private_company_revenues` has exactly one caller
// chain again.
//
// Nothing is lost. Revenue tracing lives in `pathfinding::trace_best_route`
// (still used by `execute_run_manual_route`), the distribute/retain split
// lives in `trading::execute_declare_dividends`, and per-sub-round private
// revenue lives in `pay_private_company_revenues`, which the queue already
// calls at every sub-round boundary.

/// Computes `game_id`'s Operating Round Corporation Turn Queue: every
/// currently floated `PUBLIC_COMPANIES` entry, sorted by its live
/// `MARKET_GRID` price (highest first), ties broken by
/// `ProtocolMarketState::arrival_sequence` (higher -- i.e. more recently
/// arrived -- first). See the module doc comment (design notes #7/#8) for
/// the full rationale. Pure and read-only: callers decide what to do with
/// the resulting order (`execute_begin_operating_round` writes it into
/// `GameSession::active_operating_order`; tests may call this directly to
/// assert the ordering itself).
pub fn calculate_operating_order(
    storage: &dyn Storage,
    game_id: u64,
) -> Result<Vec<u32>, OperationsError> {
    let mut entries: Vec<(u32, Uint128, u64)> = Vec::new();

    for (company_id, _ticker) in CORE_PUBLIC_COMPANIES.iter().copied() {
        let company: Option<PublicCompany> =
            PUBLIC_COMPANIES.may_load(storage, (game_id, company_id))?;
        let Some(company) = company else {
            continue;
        };
        if !company.is_floated {
            continue;
        }

        let price = market::current_cell(storage, game_id, company_id)?.price;
        let position = PROTOCOL_MARKET
            .may_load(storage, (game_id, company_id))?
            .ok_or(MarketError::ProtocolNotFound {
                game_id,
                protocol_id: company_id,
            })?;

        entries.push((company_id, price, position.arrival_sequence));
    }

    // Highest price first; ties broken by the higher (more recently
    // arrived) `arrival_sequence` first -- see design note #8.
    entries.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));

    Ok(entries
        .into_iter()
        .map(|(company_id, _, _)| company_id)
        .collect())
}

/// Automatic Pre-OR Revenue Payout (module doc comment #14): pays every
/// active (not `closed`) private company's fixed `revenue_per_or` to its
/// current owner -- a player-owned private credits `PLAYER_CASH_VGP`
/// directly; a corporation-owned one (see `PrivateCompany`'s own doc
/// comment in `state.rs`) credits that corporation's own
/// `PublicCompany::treasury` instead; an unowned private pays no one.
/// Iterates the same canonical `CORE_PRIVATE_COMPANIES` list
/// `execute_operating_round`'s pre-existing Phase 1 already uses, so the
/// set of privates processed can never drift out of sync with what was
/// actually spawned. Called from both `execute_begin_operating_round` and
/// `advance_operating_round_turn`'s next-sub-round branch -- see module
/// doc comment #14 for why both call sites are needed.
/// `pub(crate)` since Step 4.5 Batch 4: `waterfall::execute_waterfall_pass`
/// reuses this for the canonical 1830 all-pass rule, where every already-owned
/// private pays its printed revenue the moment a full round of passes
/// completes. That is a different TRIGGER from the Operating Round one, but it
/// is the same PAYOUT, and two copies of "privates pay their owners" would be
/// two places for the corporation-owned branch to drift.
pub(crate) fn pay_private_company_revenues(
    storage: &mut dyn Storage,
    game_id: u64,
) -> Result<Vec<Attribute>, OperationsError> {
    let mut attrs = Vec::new();
    for (private_id, _, _, _) in CORE_PRIVATE_COMPANIES.iter().copied() {
        let private: Option<PrivateCompany> =
            PRIVATE_COMPANIES.may_load(storage, (game_id, private_id))?;
        let Some(private) = private else {
            continue;
        };
        if private.closed || private.revenue_per_or.is_zero() {
            continue;
        }

        if let Some(owner) = private.owner.clone() {
            let balance = PLAYER_CASH_VGP
                .may_load(storage, (game_id, owner.clone()))?
                .unwrap_or_default();
            let new_balance = balance
                .checked_add(private.revenue_per_or)
                .map_err(|_| OperationsError::Overflow {})?;
            PLAYER_CASH_VGP.save(storage, (game_id, owner.clone()), &new_balance)?;
            attrs.push(Attribute::new("private_revenue_recipient", owner.as_str()));
            attrs.push(Attribute::new(
                "private_revenue_paid",
                private.revenue_per_or.to_string(),
            ));
        } else if let Some(owner_protocol_id) = private.owner_protocol_id {
            let company: Option<PublicCompany> =
                PUBLIC_COMPANIES.may_load(storage, (game_id, owner_protocol_id))?;
            if let Some(mut company) = company {
                company.treasury = company
                    .treasury
                    .checked_add(private.revenue_per_or)
                    .map_err(|_| OperationsError::Overflow {})?;
                PUBLIC_COMPANIES.save(storage, (game_id, owner_protocol_id), &company)?;
                attrs.push(Attribute::new(
                    "private_revenue_recipient_protocol_id",
                    owner_protocol_id.to_string(),
                ));
                attrs.push(Attribute::new(
                    "private_revenue_paid",
                    private.revenue_per_or.to_string(),
                ));
            }
        }
    }
    Ok(attrs)
}

/// Begins `game_id`'s Operating Round Corporation Turn Queue: computes
/// `calculate_operating_order` and writes it into
/// `GameSession::active_operating_order`, resetting
/// `active_corporation_index` back to `0`. Authorized exactly like
/// `execute_operating_round` -- only the room's `creator` may call this, per
/// design note #9. Errors with `NoFloatedCompanies` if the computed order is
/// empty, since an empty queue has nothing to gate.
pub fn execute_begin_operating_round(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
) -> Result<Response, OperationsError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(OperationsError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(OperationsError::GameNotActive { game_id });
    }
    if session.waterfall_auction_active {
        return Err(OperationsError::WaterfallAuctionInProgress { game_id });
    }
    if info.sender != session.creator {
        return Err(OperationsError::Unauthorized {});
    }

    let order = calculate_operating_order(deps.storage, game_id)?;
    if order.is_empty() {
        return Err(OperationsError::NoFloatedCompanies { game_id });
    }

    // Automatic Pre-OR Revenue Payout (module doc comment #14): the
    // absolute initialization step of this Operating Round -- every active
    // private company's revenue is paid out before anything else below (the
    // queue write, Pacing Automation, and certainly before the first queued
    // corporation's own Track sub-phase) ever happens.
    let private_revenue_attrs = pay_private_company_revenues(deps.storage, game_id)?;

    session.active_operating_order = order.clone();
    session.active_corporation_index = 0;

    // Step 4.5 Batch 1, item 3: the Stock Round Buyback Lockout is scoped to
    // a single Stock Round and must never survive into the next one.
    // `trading::conclude_stock_round` already clears it on the natural
    // all-players-passed path, but this call is the one that is guaranteed to
    // run on EVERY Stock-Round-to-Operating-Round transition -- including the
    // creator-driven one that skips the pass-streak entirely. Clearing an
    // already-clear lockout is a no-op, so running both is safe; running only
    // the other one would not be.
    trading::clear_stock_round_sales(deps.storage, game_id, &session.player_addresses);

    // Macro Round Tracker / Pacing Automation (design note #11): this call
    // is the room's one existing explicit "Stock Round concludes, Operating
    // Round begins" transition, so the round-tracker fields and the paced OR
    // sequence length are both set here.
    session.current_round_type = RoundType::OperatingRound;
    session.sub_round_index = 1;
    let highest_tier = hardware::highest_train_tier_purchased(deps.storage, game_id)?;
    session.operating_round_sequence_length =
        hardware::operating_round_sequence_length_for_tier(highest_tier.as_deref());

    SESSIONS.save(deps.storage, game_id, &session)?;

    let order_description = order
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");

    Ok(Response::new()
        .add_attribute("action", "begin_operating_round")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("active_operating_order", order_description)
        .add_attribute("active_corporation_index", "0")
        .add_attribute("active_corporation_id", order[0].to_string())
        .add_attribute(
            "current_round_type",
            format!("{:?}", session.current_round_type),
        )
        .add_attribute("sub_round_index", session.sub_round_index.to_string())
        .add_attribute(
            "operating_round_sequence_length",
            session.operating_round_sequence_length.to_string(),
        )
        .add_attributes(private_revenue_attrs))
}

/// Ends `protocol_id`'s turn in `game_id`'s Operating Round Corporation Turn
/// Queue and advances it -- design notes #10/#12 for the full design. Only
/// `protocol_id`'s registered President may call this, and `protocol_id`
/// must be exactly whichever corporation `active_operating_order[active_corporation_index]`
/// currently points to (`NotYourOperatingTurn` otherwise), the same gating
/// `LayTile`/`BuyHardwareFromPool`/`DeclareDividends` already enforce.
/// Errors with `NoActiveOperatingOrder` if `BeginOperatingRound` hasn't run
/// (or the room's queue was already cleared by a prior macro-round close).
///
/// Three outcomes, depending on how much of the queue and Pacing Automation
/// schedule remain:
/// - **Another corporation is still queued this sub-round:**
///   `active_corporation_index` simply advances to it.
/// - **Every corporation has acted, but more paced sub-rounds remain**
///   (`sub_round_index < operating_round_sequence_length`): `sub_round_index`
///   increments, the operating order is recomputed fresh (stock prices may
///   have moved during the sub-round just finished), and
///   `active_corporation_index` resets to `0`.
/// - **Every corporation has acted AND this was the last paced sub-round**
///   (`sub_round_index == operating_round_sequence_length`): Macro Round
///   Loop Advancement -- `macro_round_number` increments, `sub_round_index`
///   resets to `0`, `current_round_type` flips back to `RoundType::StockRound`,
///   and `active_operating_order`/`active_corporation_index` are cleared.
pub fn execute_end_operating_round_turn(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
) -> Result<Response, OperationsError> {
    let session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(OperationsError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(OperationsError::GameNotActive { game_id });
    }

    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(OperationsError::NoPresidentAssigned {
            game_id,
            protocol_id,
        })?;
    if info.sender != president {
        return Err(OperationsError::NotPresident { protocol_id });
    }

    // Audit G-15b: an unanswered train offer holds the turn open. The buyer
    // may still buy from the Bank -- that is inside the same Buy Trains step
    // -- but it may not walk away leaving a rival's train tied up in a
    // proposition it has already moved on from.
    //
    // Never a deadlock: `RescindTrainOffer` clears this unilaterally, by the
    // same player it constrains, in one transaction.
    if let Some((offer_id, offer)) =
        train_trade::pending_offer_for_buyer(deps.storage, game_id, protocol_id)?
    {
        return Err(OperationsError::PendingTrainOfferBlocksTurn {
            protocol_id,
            offer_id,
            seller_protocol_id: offer.seller_protocol_id,
        });
    }


    if session.active_operating_order.is_empty() {
        return Err(OperationsError::NoActiveOperatingOrder { game_id });
    }

    let expected_protocol_id =
        session.active_operating_order[session.active_corporation_index as usize];
    if protocol_id != expected_protocol_id {
        return Err(OperationsError::NotYourOperatingTurn {
            game_id,
            protocol_id,
            expected_protocol_id,
        });
    }

    // Mandatory Train Purchase (Audit G-8, design note #15): a corporation
    // that owns no Hardware may not end its turn while the pool still has
    // something to sell it. Real 1830 makes buying a train compulsory in
    // exactly this situation -- it is the trigger for the whole Validator
    // Liability / emergency-fundraising cascade in `hardware.rs`, which
    // could previously never fire because a trainless company was free to
    // simply pass.
    //
    // Gated on a NON-EMPTY pool: once every train in the game has been
    // bought there is nothing left to compel, and blocking the turn then
    // would deadlock the room permanently.
    let owns_hardware = !COMPANY_HARDWARE
        .may_load(deps.storage, (game_id, protocol_id))?
        .unwrap_or_default()
        .is_empty();
    let pool_units_remaining = HARDWARE_POOL
        .may_load(deps.storage, game_id)?
        .unwrap_or_default()
        .len() as u32;
    if !owns_hardware && pool_units_remaining > 0 {
        return Err(OperationsError::MustPurchaseTrain {
            game_id,
            protocol_id,
            pool_units_remaining,
        });
    }

    let response = Response::new()
        .add_attribute("action", "end_operating_round_turn")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string());

    advance_operating_round_turn(deps, game_id, session, response)
}

/// Advances `protocol_id` past its current Operating Round sub-phase without
/// acting in it -- Audit G-14, the explicit skip.
///
/// This is what makes the sequence enforceable without being a straitjacket:
/// a corporation with no tile worth laying, no reachable city to token and no
/// train to buy still has to reach the phases it cares about, and every skip
/// is a recorded, replayable event rather than an implicit jump.
///
/// REFUSES the two phases that are not the corporation's to skip:
///   - `Routes`, if it owns any train. Running is not optional in 1830 -- you
///     may not decline to earn in order to dodge a dividend. A corporation
///     with NO train has nothing to run and may pass through.
///   - `Dividends`, ever. Pay or withhold are both legal, so "neither" never
///     is, and skipping would end the turn with revenue in an undefined state.
pub fn execute_advance_operating_sub_phase(
    deps: DepsMut,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
) -> Result<Response, OperationsError> {
    let session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(OperationsError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(OperationsError::GameNotActive { game_id });
    }

    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(OperationsError::NoPresidentAssigned {
            game_id,
            protocol_id,
        })?;
    if info.sender != president {
        return Err(OperationsError::NotPresident { protocol_id });
    }

    if let Some(&expected_protocol_id) = session
        .active_operating_order
        .get(session.active_corporation_index as usize)
    {
        if protocol_id != expected_protocol_id {
            return Err(OperationsError::NotYourOperatingTurn {
                game_id,
                protocol_id,
                expected_protocol_id,
            });
        }
    }

    let current = or_phase::current_sub_phase(
        deps.storage,
        game_id,
        protocol_id,
        session.current_global_era,
    )?;

    if !or_phase::may_skip(deps.storage, game_id, protocol_id, current)? {
        let reason = match current {
            OperatingSubPhase::Routes =>
                "this corporation owns at least one train, and a corporation holding a train must run it",
            _ =>
                "the dividend decision is mandatory -- declare a payout or withhold, but it cannot be passed over",
        };
        return Err(OperationsError::OperatingSubPhaseNotSkippable {
            protocol_id,
            phase: or_phase::phase_name(current).to_string(),
            reason: reason.to_string(),
        });
    }

    or_phase::advance(deps.storage, game_id, protocol_id, current)?;
    let now = or_phase::current_sub_phase(
        deps.storage,
        game_id,
        protocol_id,
        session.current_global_era,
    )?;

    Ok(Response::new()
        .add_attribute("action", "advance_operating_sub_phase")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("skipped_phase", or_phase::phase_name(current))
        .add_attribute("current_phase", or_phase::phase_name(now))
        .add_attribute("current_phase_index", or_phase::phase_index(now).to_string()))
}

/// Shared three-way Operating Round Corporation Turn Queue advancement --
/// design notes #10/#12 for the full design. Factored out of
/// `execute_end_operating_round_turn` (which still owns every check BEFORE
/// this point -- loading `session`, verifying `protocol_id`'s President
/// authorized the call, and confirming `active_operating_order`/
/// `active_corporation_index` actually point at `protocol_id`) so
/// `execute_run_manual_route` (Manual Route Validation) can reuse the exact
/// same macro-round bookkeeping after declaring its own route's revenue,
/// instead of duplicating roughly eighty lines of it. Both callers are
/// REQUIRED to have already confirmed `session.active_operating_order` is
/// non-empty and points at the caller's own `protocol_id` -- this function
/// doesn't re-check either, since without that precondition the "every
/// corporation has acted" `else` branch below would fire on an
/// operating-order-less session and incorrectly advance the macro round.
fn advance_operating_round_turn(
    deps: DepsMut,
    game_id: u64,
    mut session: GameSession,
    mut response: Response,
) -> Result<Response, OperationsError> {
    // Audit G-14: every corporation queued this round starts its NEXT turn at
    // the top of the sequence. Cleared here, in the one function BOTH turn-end
    // paths funnel through (`execute_end_operating_round_turn` and
    // `execute_run_manual_route`), so no path can leave a stale cursor behind
    // -- a corporation that ended its turn on `Hardware` would otherwise begin
    // its next one there and be unable to lay track for the rest of the game.
    or_phase::reset_all_for_session(deps.storage, &session);

    let next_index = session.active_corporation_index + 1;

    if (next_index as usize) < session.active_operating_order.len() {
        // Another corporation is still queued this sub-round -- simply
        // advance the pointer to it.
        session.active_corporation_index = next_index;
        response = response
            .add_attribute("outcome", "advanced_to_next_corporation")
            .add_attribute(
                "active_corporation_index",
                session.active_corporation_index.to_string(),
            )
            .add_attribute(
                "active_corporation_id",
                session.active_operating_order[session.active_corporation_index as usize]
                    .to_string(),
            );
    } else if session.sub_round_index < session.operating_round_sequence_length {
        // Every corporation has acted once this sub-round, but Pacing
        // Automation (design note #11) schedules more sub-rounds -- start
        // the next one with a freshly recomputed order (design note #12).
        session.sub_round_index = session
            .sub_round_index
            .checked_add(1)
            .ok_or(OperationsError::Overflow {})?;
        let order = calculate_operating_order(deps.storage, game_id)?;
        session.active_operating_order = order;
        session.active_corporation_index = 0;

        // Automatic Pre-OR Revenue Payout (module doc comment #14): this
        // sub-round is, for real-1830 private-revenue purposes, its own
        // fresh Operating Round -- pay every active private again here,
        // exactly like `execute_begin_operating_round` does for the very
        // first sub-round.
        let private_revenue_attrs = pay_private_company_revenues(deps.storage, game_id)?;

        response = response
            .add_attribute("outcome", "advanced_to_next_sub_round")
            .add_attribute("sub_round_index", session.sub_round_index.to_string())
            .add_attribute("active_corporation_index", "0")
            .add_attribute(
                "active_operating_order",
                session
                    .active_operating_order
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            )
            .add_attributes(private_revenue_attrs);
        if let Some(&first) = session.active_operating_order.first() {
            response = response.add_attribute("active_corporation_id", first.to_string());
        }
    } else {
        // Macro Round Loop Advancement (design note #12): the paced
        // Operating Round phase's very last sub-round just had its very
        // last corporation finish -- the whole macro round is complete.

        // Deferred Bank-Break Halt (see `state.rs`'s `GameSession::bank_is_broken`
        // doc comment): if the bank was driven to zero at any point during
        // this exact scheduled block of Operating Rounds, the engine
        // deliberately let every remaining corporation finish out its
        // actions instead of hard-stopping mid-turn -- this IS that block's
        // very last corporation's very last action concluding, so the game
        // ends HERE, via the same final asset-liquidation routine every
        // other game-end trigger in this contract already uses
        // (`market::price_triggers_game_end`), instead of looping back into
        // a new Stock Round.
        if session.bank_is_broken {
            let end_game_response =
                crate::contract::finalize_and_distribute_payouts(deps, game_id, session)
                    .map_err(|e| OperationsError::Std(StdError::generic_err(e.to_string())))?;
            response = response
                .add_attribute("outcome", "bank_break_halt")
                .add_attribute("game_end_triggered", "true")
                .add_attributes(end_game_response.attributes)
                // See the identical `add_messages` fix (and its full
                // rationale) in `execute_operating_round` above.
                .add_messages(end_game_response.messages.into_iter().map(|m| m.msg));
            return Ok(response);
        }

        session.macro_round_number = session
            .macro_round_number
            .checked_add(1)
            .ok_or(OperationsError::Overflow {})?;
        session.sub_round_index = 0;
        session.current_round_type = RoundType::StockRound;
        session.active_operating_order = Vec::new();
        session.active_corporation_index = 0;

        response = response
            .add_attribute("outcome", "macro_round_advanced")
            .add_attribute("macro_round_number", session.macro_round_number.to_string())
            .add_attribute("sub_round_index", "0")
            .add_attribute(
                "current_round_type",
                format!("{:?}", session.current_round_type),
            );
    }

    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(response)
}

/// Manual Route Validation: lets `protocol_id`'s President submit a
/// hand-picked path of real board hex labels (`hex_path`) instead of
/// relying on `pathfinding::trace_best_route`'s automatic best-value search.
/// Unlike that engine, a caller-submitted path must be validated
/// step-by-step against every rule the automatic BFS already enforces
/// implicitly (`pathfinding.rs`'s module doc comments #1-#4):
///
/// 1. **Parse.** Every `RouteWaypoint::hex` must resolve to a real board hex
///    via `hexmap::axial_for_label` (`InvalidHexLabel` otherwise), every
///    `city_node` must name a city that hex actually has
///    (`NoSuchCityOnHex`), and no STOP may repeat
///    (`DuplicateHexInRoute`).
///
///    **Step 4.5 Batch 3, item 1 closed the gap that used to sit here.**
///    Batch 2 moved `pathfinding`'s own history to `(hex, city_node)` keys,
///    so the automatic tracer can serve both stations of a two-city hex. This
///    validator could not: `hex_path` was a list of bare labels with no way
///    to say WHICH of New York's stations an entry meant, so it had to refuse
///    any repeated label rather than guess and risk paying for a stop the
///    train never reached. `RouteWaypoint` carries the node explicitly, the
///    ambiguity is gone, and the uniqueness key is now the stop rather than
///    the hex -- the two route paths agree again.
/// 2. **Touches the operating company's own station.** `pathfinding.rs`'s
///    existing model (module doc comment #1) treats a company's home
///    node/station as the first hex it ever laid track on
///    (`PROTOCOL_NETWORK_HEXES`'s first entry) -- there's no separate Token
///    Station Placement message yet. Unlike `trace_best_route`, which
///    always starts its search exactly there, a manually-drawn path only
///    has to CONTAIN that hex somewhere in the chain (`RouteMustTouchOwnStation`
///    otherwise) -- a real 1830 route runs BETWEEN stations, it isn't
///    required to be listed starting from one.
/// 3. **No rival blockades on an intermediate stop.** Reuses
///    `pathfinding::opponent_station_hexes` (now `pub(crate)` specifically
///    for this) so the two route-revenue paths can never disagree about
///    which cities are blockaded (`RouteBlockedByRivalStation`). That helper
///    lists only cities where rivals hold tokens AND no slot remains open --
///    a rival's mere laid track blocks nothing, and neither does a
///    part-tokened city with a free slot.
///
///    Checked for the INTERIOR of the path only. Real 1830 lets a train run
///    into a fully blockaded city and end its route there, scoring it; what
///    it may not do is run through and out the far side. Both ends of the
///    path are therefore exempt -- the last hex because that is where the
///    train stops, and the first for symmetry, since a route is an
///    undirected run between two ends and reversing how the President typed
///    it must not change whether it is legal. This matches
///    `pathfinding::trace_best_route_set`'s `Passability::StopOnly`
///    handling, so an automatically-traced route and a manually-declared
///    one now agree here too.
/// 4. **Distance budget.** `hex_path.len()` (the visited-hex count, matching
///    `trace_best_route`'s own `visited.len() >= max_distance` check, not a
///    hop count) must not exceed the longest `max_route_distance` among
///    `protocol_id`'s owned Hardware (`pathfinding::best_owned_distance`,
///    also now `pub(crate)`) -- `NoHardwareOwned` if it owns none,
///    `RouteExceedsMaxDistance` if the path is too long.
/// 5. **Connectivity.** Every hex must carry an actually-laid `Tile`
///    (`NoTileAtHex` otherwise), and each consecutive pair must be direct
///    axial neighbors joined by a real track edge -- both tiles' rotated
///    connection bitmasks (`hexmap::rotate_connections`, the identical
///    edge-matching `trace_best_route`'s BFS performs one hop at a time)
///    must agree on the shared edge (`DisconnectedRouteSegment` otherwise).
///
/// On success, the path's summed `hexmap::tile_base_value` is declared
/// according to `payout_strategy`:
/// - `PayoutStrategy::DeclareDividends` -- DISTRIBUTED to shareholders, the
///   same Distribute Yield pattern `execute_operating_round`'s
///   `payout: true` branch and `trading::execute_declare_dividends`'s
///   `distribute: true` branch both already use: split proportionally
///   across every `PLAYER_SHARES` holder, with any un-owned/IPO-held
///   remainder falling to `GameSession::virtual_bank_vgp`, and the market
///   price moves right via `market::move_right`.
/// - `PayoutStrategy::Withhold` -- the full amount is credited straight to
///   `PublicCompany::treasury` (no shareholder payout), and the market
///   price moves left via `market::move_left` -- exactly
///   `execute_operating_round`'s own `payout: false` branch, "matching our
///   standard Operating Round parameters" per this feature's own request.
///   As of Audit G-2 this is simply THE corporate treasury: the separate
///   `PROTOCOL_TREASURY_VGP` map `trading::execute_declare_dividends`'s
///   `distribute: false` branch used to credit is deleted, and that branch
///   now writes this same `PublicCompany::treasury` field (module doc
///   comment #4).
///
/// An earlier pass of this message had no separate retain/withhold choice
/// field at all (always Distribute Yield) -- `payout_strategy` closes that
/// gap. The Operating Round Corporation Turn Queue then advances exactly
/// like `EndOperatingRoundTurn` (`advance_operating_round_turn`, shared
/// above) -- so this message REQUIRES an active queue pointing at
/// `protocol_id` (`NoActiveOperatingOrder`/`NotYourOperatingTurn`
/// otherwise), unlike `DeclareDividends`'s own softer "only enforced if a
/// queue exists" check, since this message always ends by advancing that
/// same queue.
///
/// DELIBERATELY NOT recorded to `GAME_LOG`: like `ExecuteOperatingRound`
/// (`gamelog.rs`'s module doc comment #2), this message's revenue depends on
/// the exact live `MAP_GRID`/`COMPANY_HARDWARE` state at call time --
/// replaying it later against however that state has since diverged is the
/// same "bigger reconciliation problem" that already excludes
/// `ExecuteOperatingRound`/`BeginOperatingRound`/`EndOperatingRoundTurn`.
pub fn execute_run_manual_route(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
    path: Vec<RouteWaypoint>,
    payout_strategy: PayoutStrategy,
) -> Result<Response, OperationsError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(OperationsError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(OperationsError::GameNotActive { game_id });
    }

    // `mut`: the `PayoutStrategy::Withhold` branch below updates
    // `company.treasury`/`current_x`/`current_y` and saves it back to
    // `PUBLIC_COMPANIES`, exactly like `execute_operating_round`'s own
    // `payout: false` branch.
    let mut company: PublicCompany = PUBLIC_COMPANIES
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(OperationsError::PublicCompanyNotFound {
            game_id,
            company_id: protocol_id,
        })?;
    if !company.is_floated {
        return Err(OperationsError::CompanyNotFloated {
            company_id: protocol_id,
        });
    }

    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(OperationsError::NoPresidentAssigned {
            game_id,
            protocol_id,
        })?;
    if info.sender != president {
        return Err(OperationsError::NotPresident { protocol_id });
    }


    // ==== Audit G-14: Operating Round sub-phase gate. ====
    // Running trains is what PRODUCES the revenue the Dividends phase then
    // decides about, which is why the two are separate phases in this order.
    if let Err(mismatch) = or_phase::require_sub_phase(
        deps.storage,
        &session,
        protocol_id,
        OperatingSubPhase::Routes,
    ) {
        return Err(match mismatch {
            or_phase::PhaseMismatch::Wrong { actual, required } => OperationsError::WrongOperatingSubPhase {
                protocol_id,
                actual: or_phase::phase_name(actual).to_string(),
                actual_index: or_phase::phase_index(actual),
                required: or_phase::phase_name(required).to_string(),
                required_index: or_phase::phase_index(required),
            },
            or_phase::PhaseMismatch::Storage(message) => OperationsError::Std(StdError::generic_err(message)),
        });
    }

    // Operating Round Corporation Turn Queue gating -- STRICT, unlike
    // `DeclareDividends`'s "only enforced if a queue exists" check, since
    // this message always ends by advancing that same queue (see this
    // function's own doc comment for why the softer check would be unsafe
    // here).
    if session.active_operating_order.is_empty() {
        return Err(OperationsError::NoActiveOperatingOrder { game_id });
    }
    let expected_protocol_id =
        session.active_operating_order[session.active_corporation_index as usize];
    if protocol_id != expected_protocol_id {
        return Err(OperationsError::NotYourOperatingTurn {
            game_id,
            protocol_id,
            expected_protocol_id,
        });
    }

    // ---- 1. Parse the waypoints into axial coordinates and city nodes. ----
    if path.is_empty() {
        return Err(OperationsError::EmptyRoutePath { protocol_id });
    }

    // Step 4.5 Batch 3, item 1: `hex_path: Vec<String>` became
    // `path: Vec<RouteWaypoint>`. `hex_path` survives here purely as the
    // label list every error message and the response attribute already
    // report against -- deriving it once keeps that reporting unchanged
    // while the validation below works on the richer type.
    let hex_path: Vec<String> = path.iter().map(|waypoint| waypoint.hex.clone()).collect();

    let mut axial_path: Vec<(i32, i32)> = Vec::with_capacity(path.len());
    for label in &hex_path {
        let coord = axial_for_label(label).ok_or_else(|| OperationsError::InvalidHexLabel {
            label: label.clone(),
        })?;
        axial_path.push(coord);
    }

    // Each waypoint's city node, validated against the artwork actually on
    // that hex. `None` stays `None` -- the ordinary case for a town, a
    // connector, or a single-city tile where naming the city adds nothing.
    //
    // A `Some(n)` naming a city the hex does not have is rejected outright
    // rather than silently coerced: a client confused about the board should
    // be told, not quietly paid for a stop that does not exist.
    let mut node_path: Vec<Option<u8>> = Vec::with_capacity(path.len());
    for (waypoint, &(q, r)) in path.iter().zip(axial_path.iter()) {
        match waypoint.city_node {
            None => node_path.push(None),
            Some(city_node) => {
                let cities = city_slot_counts_at(deps.storage, game_id, q, r)?.len();
                if city_node >= cities {
                    return Err(OperationsError::NoSuchCityOnHex {
                        label: waypoint.hex.clone(),
                        city_node,
                        cities,
                    });
                }
                // Narrowed once, after the bound check, to the `u8` every
                // on-chain city registry uses.
                node_path.push(Some(city_node as u8));
            }
        }
    }

    // ---- Duplicate STOPS, not duplicate hexes (Batch 3, item 1). ----
    //
    // This used to key on `(q, r)` alone, which made a repeated hex label an
    // error no matter what it meant. That was the right call while the
    // message could not distinguish New York's two stations -- guessing
    // would have paid out for a stop the train never reached -- but it also
    // made a legal two-station route inexpressible, and the automatic
    // tracer has found those routes since Batch 2. With the city node
    // carried explicitly the ambiguity is gone, so the key is now the STOP:
    // the same station twice is still refused, two different stations on one
    // hex are not.
    let mut seen: HashSet<(i32, i32, Option<u8>)> = HashSet::new();
    for ((label, coord), node) in hex_path.iter().zip(axial_path.iter()).zip(node_path.iter()) {
        if !seen.insert((coord.0, coord.1, *node)) {
            return Err(OperationsError::DuplicateHexInRoute {
                label: label.clone(),
            });
        }
    }

    // ---- 2. Must touch the company's own station. ----
    let network_hexes = PROTOCOL_NETWORK_HEXES
        .may_load(deps.storage, (game_id, protocol_id))?
        .unwrap_or_default();
    let home = network_hexes
        .first()
        .copied()
        .ok_or(OperationsError::CompanyHasNoHomeStation { protocol_id })?;
    if !axial_path.contains(&home) {
        return Err(OperationsError::RouteMustTouchOwnStation { protocol_id });
    }

    // ---- 3. No rival token blockades on any INTERMEDIATE stop. ----
    //
    // Audit G-9 follow-up. This loop used to reject the route if ANY hex in
    // it was blockaded, terminals included. That is not the 1830 rule: a
    // fully-tokened-out rival city blocks a train from running THROUGH it,
    // but a train may always run INTO one and end its route there, scoring
    // the city like any other stop. `pathfinding::trace_best_route_set`
    // already models exactly that (its `Passability::StopOnly`); this
    // manually-declared path was the last place still enforcing the older,
    // stricter reading, and the residual noted on
    // `pathfinding::opponent_station_hexes` is now closed.
    //
    // Only the interior of the path is checked, so both ends are free:
    // - the LAST hex is where the train stops, which is the case above;
    // - the FIRST hex is symmetric. A route is an undirected run between two
    //   ends -- `hex_path` merely lists it in one of the two orders the
    //   President could equally have typed -- so blocking on index `0` would
    //   have rejected a perfectly legal route purely for being written
    //   backwards, and `["A", "B", "C"]` and `["C", "B", "A"]` must accept
    //   or reject identically.
    //
    // Degenerate lengths fall out correctly: a 1-hex path has no interior at
    // all, and a 2-hex path is two terminals with nothing between them, so
    // neither can be blockaded here. Neither is a scoring route anyway --
    // 1830's two-revenue-centre minimum is enforced separately -- and a
    // 0-hex path was already rejected as `EmptyRoutePath` in step 1.
    // ==== Audit G-13: CITY-GRANULAR, not hex-granular. ====
    //
    // `opponent_station_hexes` answers "is this hex closed to me ENTIRELY",
    // which on a multi-city tile is the wrong question: #62 and the OO tiles
    // carry two cities on separate, non-intersecting track, and a route
    // running through the blockaded one is illegal even while the other is
    // wide open. Checking only the hex let a President hand-write exactly the
    // ghost route the automatic search now refuses.
    //
    // A declared `hex_path` knows as much about the track as the DFS does:
    // hex `i`'s inbound edge is fixed by its axial delta to hex `i - 1` and
    // its outbound edge by the delta to hex `i + 1`, so the specific segment
    // -- and therefore the specific city -- is determined. Both paths now go
    // through the same `pathfinding::transit_passability_for_hex`, so they
    // cannot disagree.
    //
    // Only the interior of the path is checked, so both ends are free:
    // - the LAST hex is where the train stops, which is the case above;
    // - the FIRST hex is symmetric. A route is an undirected run between two
    //   ends -- `hex_path` merely lists it in one of the two orders the
    //   President could equally have typed -- so blocking on index `0` would
    //   have rejected a perfectly legal route purely for being written
    //   backwards, and `["A", "B", "C"]` and `["C", "B", "A"]` must accept
    //   or reject identically. An interior hex has both neighbours by
    //   definition, which is exactly what makes its transit edges knowable.
    let interior = axial_path.len().saturating_sub(1);
    for index in 1..interior {
        let (q, r) = axial_path[index];
        let previous = axial_path[index - 1];
        let following = axial_path[index + 1];
        let (Some(in_edge), Some(out_edge)) = (
            edge_between((q, r), previous),
            edge_between((q, r), following),
        ) else {
            // Non-adjacent neighbours in a declared path: a connectivity
            // failure, rejected with its own error by step 5 below. Not this
            // check's business to report.
            continue;
        };
        if pathfinding::transit_passability_for_hex(
            deps.storage,
            game_id,
            q,
            r,
            protocol_id,
            in_edge,
            out_edge,
        )? == pathfinding::Passability::StopOnly
        {
            return Err(OperationsError::RouteBlockedByRivalStation {
                label: hex_path[index].clone(),
            });
        }
    }

    // ---- 4. Distance budget. ----
    let max_distance = match pathfinding::best_owned_distance(deps.storage, game_id, protocol_id)?
    {
        Some(distance) if distance > 0 => distance,
        _ => return Err(OperationsError::NoHardwareOwned { protocol_id }),
    };
    if axial_path.len() as u32 > max_distance {
        return Err(OperationsError::RouteExceedsMaxDistance {
            protocol_id,
            distance: axial_path.len() as u32,
            max_distance,
        });
    }

    // ---- 5. Every hex must carry a laid tile (or be one of the five
    // Landmark Pathfinder Revenue Fix hexes -- `hexmap.rs` module doc
    // comment #17 -- with real preprinted starting track but no tile laid
    // there yet), and consecutive hexes must actually connect via a real
    // track edge. Reuses `pathfinding::effective_tile_and_value` rather
    // than a direct `MAP_GRID.may_load`, so this manually-declared path and
    // `pathfinding::trace_best_route`'s automatic one can never disagree
    // about which untiled hexes are passable or what they're worth (same
    // reasoning as `best_owned_distance`/`opponent_station_hexes` above). ----
    let mut tiles: Vec<Tile> = Vec::with_capacity(axial_path.len());
    let mut tile_values: Vec<Uint128> = Vec::with_capacity(axial_path.len());
    for (label, &(q, r)) in hex_path.iter().zip(axial_path.iter()) {
        let lookup = pathfinding::effective_tile_and_value(deps.storage, game_id, q, r)?;
        let (tile, value) = lookup.ok_or_else(|| OperationsError::NoTileAtHex {
            label: label.clone(),
        })?;
        tiles.push(tile);
        tile_values.push(value);
    }
    for i in 0..axial_path.len().saturating_sub(1) {
        let (from_q, from_r) = axial_path[i];
        let (to_q, to_r) = axial_path[i + 1];
        let dq = to_q - from_q;
        let dr = to_r - from_r;
        let edge = HEX_NEIGHBOR_OFFSETS
            .iter()
            .position(|&offset| offset == (dq, dr));
        let Some(edge) = edge else {
            return Err(OperationsError::DisconnectedRouteSegment {
                from: hex_path[i].clone(),
                to: hex_path[i + 1].clone(),
            });
        };
        let edge = edge as u8;

        let from_actual = rotate_connections(tiles[i].connections, tiles[i].orientation);
        if from_actual & (1u8 << edge) == 0 {
            return Err(OperationsError::DisconnectedRouteSegment {
                from: hex_path[i].clone(),
                to: hex_path[i + 1].clone(),
            });
        }
        let opposite_edge = (edge + 3) % 6;
        let to_actual = rotate_connections(tiles[i + 1].connections, tiles[i + 1].orientation);
        if to_actual & (1u8 << opposite_edge) == 0 {
            return Err(OperationsError::DisconnectedRouteSegment {
                from: hex_path[i].clone(),
                to: hex_path[i + 1].clone(),
            });
        }
    }

    // ---- Revenue: summed tile value across the whole declared path. Uses
    // the values already resolved in step 5 above (real `tile_base_value`
    // for a laid tile, or the Landmark Pathfinder Revenue Fix's real
    // starting figure for one of the five synthetic-tile hexes) rather than
    // re-deriving from `tile.tile_id` here, since a synthetic virtual tile
    // (module doc comment #17 in `hexmap.rs`) always carries tile_id 10's
    // generic $20 -- re-deriving here would silently drop the override.
    let mut revenue_amount = Uint128::zero();
    for value in &tile_values {
        revenue_amount = revenue_amount
            .checked_add(*value)
            .map_err(|_| OperationsError::Overflow {})?;
    }

    // A plain `&str` label for the response attribute below --
    // `PayoutStrategy` isn't `Display`/`Into<String>`, and this project's
    // convention (matching `DeclareDividends`'s own `distribute` flag
    // elsewhere) is a human-legible attribute value, not a raw derive.
    let payout_strategy_label = match payout_strategy {
        PayoutStrategy::DeclareDividends => "declare_dividends",
        PayoutStrategy::Withhold => "withhold",
    };

    // ---- Step 4.5 Batch 2, item 4: record this run's revenue.
    //
    // Written HERE, before the payout/withhold branch below, precisely
    // because the requirement is "whether paying out or withholding". This
    // is the figure the corporation's trains EARNED; what happens to it next
    // is a separate decision and must not change what gets recorded. Writing
    // it once, up front, is also the only way to record it on the paths that
    // never reach a branch at all: a zero-revenue run (no legal route) still
    // overwrites the previous round's figure, which is the correct reading of
    // "last route revenue" -- a corporation that ran nothing this round
    // earned nothing this round, and must not keep displaying a stale number
    // from two rounds ago.
    //
    // The Withhold branch below saves `company` again after crediting the
    // treasury and moving the marker; because it mutates the SAME struct,
    // this field survives that write untouched.
    company.last_route_revenue = revenue_amount;
    PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

    // Audit G-14: trains have run; the revenue figure now exists, so the
    // Dividends phase has something to decide about.
    or_phase::advance(deps.storage, game_id, protocol_id, OperatingSubPhase::Routes)?;

    let mut response = Response::new()
        .add_attribute("action", "run_manual_route")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("hex_path", hex_path.join("->"))
        // Step 4.5 Batch 3, item 1: the same run, but naming each STOP
        // rather than each hex -- `G19#0->F20->G19#1` for a route that
        // serves both of New York's stations. `hex_path` above is kept
        // unchanged so nothing reading it has to change; this is the
        // attribute that can actually describe a two-station route.
        .add_attribute(
            "route_stops",
            hex_path
                .iter()
                .zip(node_path.iter())
                .map(|(label, node)| match node {
                    Some(city) => format!("{label}#{city}"),
                    None => label.clone(),
                })
                .collect::<Vec<String>>()
                .join("->"),
        )
        .add_attribute("revenue_amount", revenue_amount)
        .add_attribute("payout_strategy", payout_strategy_label);

    // $350 Game-End Trigger (see `trading.rs` module doc comment #16 /
    // `execute_operating_round` above): a flag, checked once AFTER the
    // revenue-declaring block below, rather than moving `deps` into
    // `finalize_and_distribute_payouts` from inside a nested conditional --
    // matches this file's own established pattern exactly.
    let mut game_end_triggered = false;

    if !revenue_amount.is_zero() {
        market::ensure_protocol_position(
            deps.storage,
            game_id,
            protocol_id,
            company.current_x,
            company.current_y,
        )?;

        match payout_strategy {
            PayoutStrategy::DeclareDividends => {
                // Distribute Yield -- same pattern as
                // `execute_operating_round`'s `payout: true` branch /
                // `trading::execute_declare_dividends`'s `distribute: true`
                // branch.
                let mut distributed = Uint128::zero();
                for player in session.player_addresses.clone() {
                    let holder_pct = PLAYER_SHARES
                        .may_load(deps.storage, (game_id, protocol_id, player.clone()))?
                        .unwrap_or(0);
                    if holder_pct == 0 {
                        continue;
                    }
                    let share = revenue_amount
                        .checked_mul(Uint128::from(holder_pct))
                        .map_err(|_| OperationsError::Overflow {})?
                        .checked_div(Uint128::from(FULL_POOL_PERCENTAGE))
                        .map_err(|_| OperationsError::Overflow {})?;
                    if share.is_zero() {
                        continue;
                    }
                    let balance = PLAYER_CASH_VGP
                        .may_load(deps.storage, (game_id, player.clone()))?
                        .unwrap_or_default();
                    let new_balance = balance
                        .checked_add(share)
                        .map_err(|_| OperationsError::Overflow {})?;
                    PLAYER_CASH_VGP.save(deps.storage, (game_id, player.clone()), &new_balance)?;
                    distributed = distributed
                        .checked_add(share)
                        .map_err(|_| OperationsError::Overflow {})?;
                    response = response
                        .add_attribute("route_revenue_recipient", player)
                        .add_attribute("route_revenue_payout", share);
                }

                let bank_share = revenue_amount
                    .checked_sub(distributed)
                    .map_err(|_| OperationsError::Overflow {})?;
                session.virtual_bank_vgp = session
                    .virtual_bank_vgp
                    .checked_add(bank_share)
                    .map_err(|_| OperationsError::Overflow {})?;

                let new_cell = market::move_right(deps.storage, game_id, protocol_id)?;
                response = response
                    .add_attribute("route_distributed_to_players", distributed)
                    .add_attribute("route_bank_share", bank_share)
                    .add_attribute("new_price", new_cell.price)
                    .add_attribute("new_x", new_cell.x.to_string())
                    .add_attribute("new_y", new_cell.y.to_string());

                if market::price_triggers_game_end(&new_cell) {
                    game_end_triggered = true;
                }
            }
            PayoutStrategy::Withhold => {
                // Slash/Retain Yield -- 100% of the route's revenue goes
                // straight into the company's own treasury, and its stock
                // token moves left on the market matrix. Exactly
                // `execute_operating_round`'s own `payout: false` branch --
                // and, since Audit G-2 deleted the separate
                // `PROTOCOL_TREASURY_VGP` map, exactly `trading.rs`'s
                // withhold path too (module doc comment #4).
                company.treasury = company
                    .treasury
                    .checked_add(revenue_amount)
                    .map_err(|_| OperationsError::Overflow {})?;

                let new_cell = market::move_left(deps.storage, game_id, protocol_id)?;
                company.current_x = new_cell.x;
                company.current_y = new_cell.y;
                PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

                response = response
                    .add_attribute("route_withheld_to_treasury", revenue_amount)
                    .add_attribute("route_treasury_total", company.treasury)
                    .add_attribute("new_price", new_cell.price)
                    .add_attribute("new_x", new_cell.x.to_string())
                    .add_attribute("new_y", new_cell.y.to_string());

                // NOTE: unlike the DeclareDividends branch above, this
                // doesn't check `price_triggers_game_end` -- matching
                // `execute_operating_round`'s own `payout: false` branch,
                // which likewise never checks it after `move_left` (a
                // withheld-yield price step only ever moves down/left,
                // away from the $350 game-end trigger's high-price
                // territory).
            }
        }
    }

    session.last_action_timestamp = env.block.time.seconds();

    if game_end_triggered {
        let end_game_response =
            crate::contract::finalize_and_distribute_payouts(deps, game_id, session)
                .map_err(|e| OperationsError::Std(StdError::generic_err(e.to_string())))?;
        response = response
            .add_attribute("game_end_triggered", "true")
            .add_attributes(end_game_response.attributes)
            .add_messages(end_game_response.messages.into_iter().map(|m| m.msg));
        return Ok(response);
    }

    advance_operating_round_turn(deps, game_id, session, response)
}
