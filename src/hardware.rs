//! Hardware Store (Train Pool): the global, sequential Hardware supply,
//! its automated "Rusting" obsolescence sweeps, and the Validator Liability
//! / Emergency Buy backstop, per `rules.md` section 4 ("Hardware Asset
//! Upgrades (Train Cycles)").
//!
//! Design notes / assumptions, since `rules.md` describes the shape of
//! this mechanic but not its exact numbers:
//!
//! 1. **The catalog.** `TRAIN_CATALOG` gives each tier's baseline cost,
//!    max route distance, and bank quantity. The 2/3/4/5/6 figures are the
//!    real 1830 values (costs $80/$180/$300/$450/$630; bank quantities
//!    6/5/4/3/2; route distance equal to the tier number). `rules.md` also
//!    names a "Type-D" (Diesel) tier but gives it no numbers; real 1830's
//!    Diesel has *unlimited* bank supply, which this contract's
//!    fixed-length `HARDWARE_POOL` queue can't represent exactly, so it's
//!    modeled with a large-but-finite stand-in quantity (20) at the real
//!    1830 cost ($1100) instead.
//! 2. **No model selection.** `BuyHardwareFromPool` takes only `game_id`
//!    and `protocol_id` -- no model type -- matching rules.md's "purchased
//!    *sequentially* from a fixed global supply pool." `HARDWARE_POOL` is
//!    seeded once, in full tier order (all 2s, then all 3s, then all 4s,
//!    ...), and every purchase (by any company, including an emergency
//!    buy) removes exactly the front element. A buyer can never skip ahead
//!    to a later tier while an earlier one still has stock.
//! 3. **Rusting triggers.** Three triggers are wired up: the first Type-4
//!    purchased rusts every Type-2 out of every company's inventory; the
//!    first Type-6 purchased rusts every Type-3; the first Type-D
//!    purchased rusts every Type-4 (added per an explicit later request --
//!    the real classic 1830 rule, not speculative; `rules.md`'s own
//!    original spec only named the first two). `RUST_TRIGGERS` is a small
//!    table so it stays easy to see all three at a glance and to extend
//!    further if ever needed. Because `HARDWARE_POOL` is strictly sequential, a tier's stock
//!    is always fully exhausted before the next tier's first unit can be
//!    bought, so rusting only ever needs to sweep company inventories, not
//!    the pool itself. `record_purchase_and_apply_rusting` is the shared
//!    helper both `execute_buy_hardware_from_pool` and
//!    `execute_emergency_buy_hardware` funnel through, so this logic only
//!    lives in one place.
//! 4. **"First unit ever" detection.** Tracked via
//!    `state::TRAINS_PURCHASED_COUNT` rather than inferred from queue
//!    position, so the exactly-once firing behavior doesn't silently break
//!    if this module's buying rules ever change.
//! 5. **Where the purchase cost goes.** Paid out of the company's own
//!    `PublicCompany::treasury` (mirroring `hexmap::execute_lay_tile`'s
//!    terrain-cost handling) and credited into `GameSession::virtual_bank_vgp`,
//!    keeping VGP circulating in the bank rather than deleting it from
//!    state. An emergency buy credits the *full* cost -- the treasury's
//!    entire (insufficient) balance plus the President's personal deficit
//!    contribution -- into the same bank pool.
//! 6. **Validator Liability / Emergency Buy.** `EmergencyBuyHardware`
//!    implements rules.md's rule ("If a Protocol owns 0 active hardware
//!    assets during its OR step, the Validator address is legally forced
//!    to inject personal funds to purchase a new piece of hardware at
//!    baseline market cost. Failure to afford this triggers a liquidation
//!    event."). It requires the calling company to own zero Hardware,
//!    rejects the call outright if the treasury alone can already afford
//!    the next pool unit (pointing the caller at the ordinary
//!    `BuyHardwareFromPool` instead), and otherwise tops up the shortfall
//!    from the President's own `PLAYER_CASH_VGP`. There's still no
//!    OR-step sequencing in this contract, so nothing calls this
//!    automatically yet -- it's available to be called (by the President)
//!    whenever the zero-Hardware condition applies, rather than being
//!    enforced as a forced step of a turn structure that doesn't exist.
//! 7. **Bankruptcy halts the session via a successful transaction, not an
//!    error.** Earlier this returned `Err(HardwareError::Bankrupt)`, but
//!    CosmWasm reverts *every* state write made during a call that returns
//!    `Err(..)` -- there's no partial commit -- so an error return could
//!    never durably flip `GameSession::is_active` to false. To make the
//!    halt actually stick on-chain, `execute_emergency_buy_hardware` now
//!    treats an unaffordable combined total as a normal, successful
//!    outcome instead of raising an error, then returns `Ok(Response)`
//!    carrying a dedicated `Event::new("bankruptcy")` plus matching
//!    top-level attributes. No train is awarded, and the deficit itself is
//!    never actually collected on this path.
//!
//!    UPDATED (Bankruptcy Hard Halt): this outcome now calls
//!    `contract::finalize_and_distribute_payouts` -- the SAME final
//!    net-worth liquidation routine every other game-end trigger in this
//!    contract already uses -- rather than only flipping `is_active` to
//!    `false` and saving. That routine still flips `is_active` to `false`
//!    (so every other message against this `game_id` -- `BuyStock`,
//!    `LayTile`, `ExecuteOperatingRound`, etc. -- immediately starts
//!    failing with their own `GameNotActive` checks, which is also exactly
//!    what "abort every remaining queued corporation's turn this Operating
//!    Round" means in practice here, matching that routine's own doc
//!    comment), but ALSO now computes every player's final VGP net worth
//!    and dispatches the real-JUNO payout `BankMsg::Send`s -- unlike a plain
//!    halt, a bankruptcy no longer leaves the lobby's real JUNO pool
//!    stranded in contract state. Contrast the Deferred Bank-Break Halt
//!    (`GameSession::bank_is_broken`, `state.rs`/`operations.rs`), which
//!    reaches this same liquidation routine but only once the CURRENT
//!    scheduled block of Operating Rounds finishes naturally -- this path
//!    is the immediate, mid-turn version of that same final step.
//! 8. **Tech Era Color-Locking.** The real classic 1830 rule that buying
//!    the first-ever 3-train unlocks Green tiles, and the first-ever
//!    5-train unlocks Brown tiles (`hexmap.rs`'s module doc comment #8).
//!    `record_purchase_and_apply_rusting` -- already the single place that
//!    detects "first-ever unit of this tier" for the Rusting sweep -- also
//!    checks `ERA_UNLOCK_TRIGGERS` there and advances
//!    `GameSession::current_global_era` in the same pass, so the two
//!    "first-ever purchase" triggers (Rusting, Era Color-Locking) can never
//!    drift out of sync with each other.
//! 9. **Operating Round Corporation Turn Queue gating.** Layered on top of
//!    `execute_buy_hardware_from_pool`'s existing President-only
//!    authorization: whenever `GameSession::active_operating_order` is
//!    non-empty, `protocol_id` must be whichever corporation
//!    `active_corporation_index` currently points to, or the call is
//!    rejected with `NotYourOperatingTurn` (see `hexmap.rs`'s module doc
//!    comment #13 for the shared design and `operations.rs` for how the
//!    queue itself is computed). Deliberately *not* applied to
//!    `execute_emergency_buy_hardware` -- the Validator Liability backstop
//!    is meant to be callable whenever its own zero-Hardware/treasury
//!    conditions apply, not restricted to a scheduled turn.
//! 10a. **Train Limits (capacity caps).** Real 1830 caps how many trains a
//!     single corporation may hold at once, and that cap shrinks as the
//!     game's highest-available tier advances: 4 trains while Phase 2/3 is
//!     current, 3 while Phase 4 is current, 2 once Phase 5/6/D is current.
//!     `train_limit_for_phase` maps the result of
//!     `highest_train_tier_purchased` (the SAME "highest tier ever bought
//!     in the room" reading `operating_round_sequence_length_for_tier`
//!     already uses for pacing, module doc comment #10) to that cap, and
//!     `execute_buy_hardware_from_pool` rejects a purchase outright with
//!     `TrainLimitExceeded` if the buying corporation's current
//!     `COMPANY_HARDWARE` count is already at or above it. This check runs
//!     BEFORE the purchase touches the pool, treasury, or the Rusting
//!     sweep -- deliberately using the phase as it stands right now (prior
//!     to this purchase), not a projected post-purchase phase, and
//!     deliberately NOT looking ahead to whether this same purchase would
//!     immediately rust away some of the corporation's own older trains:
//!     a corporation already at its cap is blocked outright, full stop,
//!     even in the case where the purchase would itself trigger a Rusting
//!     sweep that (as a side effect) would have brought it back under the
//!     cap. Real 1830 separately has an optional "discard down to the new,
//!     lower limit" event triggered by a phase advancing -- that's a
//!     different rule (forcibly shrinking EVERY corporation's holdings,
//!     not just gating one corporation's purchase) and is out of scope
//!     here; only the buy-time cap check was requested.
//! 10. **Pacing Automation.** `OR_SEQUENCE_LENGTH_BY_TIER` gives the classic
//!     1830 rule for how many consecutive Operating Round sub-rounds a
//!     macro round runs once a Stock Round concludes, keyed off the highest
//!     Hardware tier any company has purchased *anywhere in the room* so
//!     far: 1 OR for a 2-train (or if nothing has been bought yet -- see
//!     below), 2 ORs for a 3-train or 4-train, 3 ORs for a 5-train, 6-train,
//!     or Diesel. `highest_train_tier_purchased` reads this off the same
//!     `TRAINS_PURCHASED_COUNT` map `record_purchase_and_apply_rusting`
//!     already maintains (rather than re-deriving it from `COMPANY_HARDWARE`
//!     inventories, which Rusting can delete units from -- a rusted-away
//!     2-train should *not* make the room forget a 2-train was ever bought
//!     for pacing purposes), checking tiers from highest to lowest so a
//!     later, higher purchase always wins even if an earlier tier's units
//!     later rusted away. `operating_round_sequence_length_for_tier` maps
//!     the result through `OR_SEQUENCE_LENGTH_BY_TIER`, defaulting to `1`
//!     when no Hardware has ever been purchased yet in the room (mirroring
//!     the 2-train's own baseline pacing, since a room with no trains
//!     bought hasn't reached even the first pacing threshold).
//!     `operations::execute_begin_operating_round` calls both, every time an
//!     Operating Round begins, and writes the result into
//!     `GameSession::operating_round_sequence_length` -- see that field's
//!     own doc comment in `state.rs` for exactly which "Stock Round
//!     concludes" moment this hooks (this contract's only existing explicit
//!     stock-round-to-operating-round transition point).
//! 11. **B&O Special Closure.** The real 1830 rule that the Baltimore &
//!     Ohio private company closes automatically the instant the PUBLIC
//!     B&O corporation buys its very first train -- independent of which
//!     tier that train is, and a company-scoped event distinct from the
//!     room-wide "first-ever unit of tier X" detection design note #4
//!     already covers. `record_purchase_and_apply_rusting` detects this
//!     by checking whether `protocol_id`'s own `COMPANY_HARDWARE` was
//!     empty before this call's `owned.push(asset.clone())`, unconditional
//!     on which tier was bought or whether that tier triggers Rusting/an
//!     era unlock. A no-op if the B&O private is already `closed` (already
//!     fired, or independently closed by design note #12's Phase 5
//!     closure first) or if `PRIVATE_COMPANIES` somehow has no entry for
//!     it (defensive; shouldn't happen -- every game room spawns all six
//!     core privates at creation).
//! 12. **Phase 5 Private Closure.** The real 1830 rule that EVERY private
//!     company still open closes automatically the instant Phase 5
//!     begins, regardless of whether it's player-owned, corporation-owned
//!     (`trading::execute_buy_private_company`), or unowned. This engine
//!     has no separate `Phase` type (see `hexmap.rs`'s module doc comment
//!     #24 for the full mapping); Phase 5 is modeled as the room's
//!     `TileColor::Brown` era, which `ERA_UNLOCK_TRIGGERS` above already
//!     unlocks on the room's first-ever 5-train purchase -- so this closure
//!     is hooked directly into that existing era-advance branch, firing
//!     only the instant `current_global_era` newly becomes `Brown` (not on
//!     every later 5-train/6-train/Diesel purchase once the room is
//!     already Brown). Iterates the same canonical `CORE_PRIVATE_COMPANIES`
//!     list `operations::execute_operating_round`'s Phase 1 already uses,
//!     so the set of privates closed can never drift out of sync with what
//!     was actually spawned.

use cosmwasm_std::{
    Addr, Attribute, DepsMut, Env, Event, MessageInfo, Response, StdError, StdResult, Storage, Uint128,
};
use thiserror::Error;

use crate::auction::{BO_PUBLIC_COMPANY_ID, CORE_PRIVATE_COMPANIES, PRIVATE_BO_ID};
use crate::market::{self, MarketError};
use crate::public_company::CORE_PUBLIC_COMPANIES;
use crate::or_phase;
use crate::state::{
    GameSession, HardwareAsset, OperatingSubPhase, PrivateCompany, PublicCompany, TileColor,
    BANK_POOL_SHARES,
    COMPANY_HARDWARE, HARDWARE_POOL, PLAYER_CASH_VGP, PLAYER_SHARES, PRIVATE_COMPANIES,
    PROTOCOL_PRESIDENT, PUBLIC_COMPANIES, SESSIONS, TRAINS_PURCHASED_COUNT,
};
use crate::trading::{BANK_POOL_CAP_PERCENTAGE, PERCENT_PER_SHARE, PRESIDENT_MIN_PERCENTAGE};

/// The fixed Hardware catalog: `(model_type, baseline cost in VGP, max
/// route distance, bank quantity)`. See module doc comment #1 for where
/// these numbers come from, including the Diesel ("D") stand-in quantity.
pub const TRAIN_CATALOG: &[(&str, u128, u32, u32)] = &[
    ("2", 80, 2, 6),
    ("3", 180, 3, 5),
    ("4", 300, 4, 4),
    ("5", 450, 5, 3),
    ("6", 630, 6, 2),
    ("D", 1_100, 999, 20),
];

/// `(trigger_model, rusted_model)`: buying the *first-ever* unit of
/// `trigger_model` permanently deletes every `rusted_model` unit from
/// every company's `COMPANY_HARDWARE` inventory. See module doc comment #3
/// for these three pairs.
pub const RUST_TRIGGERS: &[(&str, &str)] = &[("4", "2"), ("6", "3"), ("D", "4")];

/// `(highest_tier_purchased_so_far, train_limit)`: the classic 1830 Train
/// Limit rule -- see module doc comment #10a. `None` (nothing bought yet in
/// the room -- Phase 2 baseline) also maps to `4` via
/// `train_limit_for_phase`'s own `match`, not a table row here, since there
/// is no model-type string to key a `None` row on.
pub const TRAIN_LIMIT_BY_PHASE: &[(&str, u32)] = &[
    ("2", 4),
    ("3", 4),
    ("4", 3),
    ("5", 2),
    ("6", 2),
    ("D", 2),
];

/// Maps the highest Hardware tier ever purchased in the room (from
/// `highest_train_tier_purchased`) to that phase's train-limit cap -- see
/// module doc comment #10a. `None` (nothing purchased yet) is Phase 2's own
/// baseline cap, `4`, same as an actual first 2-train purchase would read.
/// An unrecognized model type (shouldn't happen -- every `TRAIN_CATALOG`
/// entry has a matching `TRAIN_LIMIT_BY_PHASE` row) also falls back to `4`
/// rather than panicking, matching `operating_round_sequence_length_for_tier`'s
/// own defensive-fallback convention just above.
pub fn train_limit_for_phase(model_type: Option<&str>) -> u32 {
    match model_type {
        None => 4,
        Some(model_type) => TRAIN_LIMIT_BY_PHASE
            .iter()
            .find(|(tier, _)| *tier == model_type)
            .map(|(_, limit)| *limit)
            .unwrap_or(4),
    }
}

/// `(trigger_model, unlocked_color)`: buying the *first-ever* unit of
/// `trigger_model` advances `GameSession::current_global_era` to
/// `unlocked_color`, room-wide -- the real classic 1830 Tech Era rule (see
/// `hexmap.rs`'s module doc comment #8). `TileColor`'s derived `Ord`
/// (declared Yellow < Green < Brown) means this can never regress the era
/// even if triggers ever fired out of order.
pub const ERA_UNLOCK_TRIGGERS: &[(&str, TileColor)] =
    &[("3", TileColor::Green), ("5", TileColor::Brown)];

/// `(model_type, operating_round_sequence_length)`: the classic 1830 Pacing
/// Automation rule -- see module doc comment #10 for the full rationale and
/// `highest_train_tier_purchased`/`operating_round_sequence_length_for_tier`
/// for how this is looked up. Listed in the same tier order as
/// `TRAIN_CATALOG` so the two stay easy to eyeball against each other.
pub const OR_SEQUENCE_LENGTH_BY_TIER: &[(&str, u32)] =
    &[("2", 1), ("3", 2), ("4", 2), ("5", 3), ("6", 3), ("D", 3)];

/// Returns the highest-tier Hardware model type ever purchased in `game_id`,
/// or `None` if nothing has been bought yet. Checks `TRAIN_CATALOG`'s tiers
/// from highest to lowest against `TRAINS_PURCHASED_COUNT` (rather than
/// live `COMPANY_HARDWARE` inventories, which Rusting can empty out) so a
/// tier that later fully rusted away is still correctly remembered as
/// having been reached -- see module doc comment #10.
pub fn highest_train_tier_purchased(
    storage: &dyn Storage,
    game_id: u64,
) -> StdResult<Option<String>> {
    for (model_type, ..) in TRAIN_CATALOG.iter().rev().copied() {
        let purchased = TRAINS_PURCHASED_COUNT
            .may_load(storage, (game_id, model_type.to_string()))?
            .unwrap_or(0);
        if purchased > 0 {
            return Ok(Some(model_type.to_string()));
        }
    }
    Ok(None)
}

/// Maps a highest-purchased model type (from `highest_train_tier_purchased`)
/// through `OR_SEQUENCE_LENGTH_BY_TIER` to the number of Operating Round
/// sub-rounds the upcoming macro round should run for. `None` (no Hardware
/// purchased yet in the room) defaults to `1`, the same baseline pacing as
/// an actual 2-train purchase -- see module doc comment #10. An unrecognized
/// model type (shouldn't happen -- every `TRAIN_CATALOG` entry has a
/// matching `OR_SEQUENCE_LENGTH_BY_TIER` row) also falls back to `1` rather
/// than panicking, since this is a display/pacing convenience, not a
/// funds-moving calculation.
pub fn operating_round_sequence_length_for_tier(model_type: Option<&str>) -> u32 {
    match model_type {
        None => 1,
        Some(model_type) => OR_SEQUENCE_LENGTH_BY_TIER
            .iter()
            .find(|(tier, _)| *tier == model_type)
            .map(|(_, length)| *length)
            .unwrap_or(1),
    }
}

#[derive(Error, Debug)]
pub enum HardwareError {
    #[error("{0}")]
    Std(#[from] StdError),

    /// Audit G-8: Emergency Asset Liquidation reads and moves the stock
    /// market (`market::current_cell`/`market::move_down`) while force-
    /// selling a President's shares, so this module now has to carry
    /// `MarketError` the same way `trading.rs` and `operations.rs` already
    /// do -- identical `#[error("{0}")]` passthrough shape, so the
    /// underlying market error text surfaces unchanged.
    #[error("{0}")]
    Market(#[from] MarketError),

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error("Public company {company_id} was not found in game room {game_id}")]
    PublicCompanyNotFound { game_id: u64, company_id: u32 },

    #[error(
        "Protocol {protocol_id} has no registered President; someone must hold a qualifying stake before it can buy Hardware"
    )]
    NoPresidentAssigned { protocol_id: u32 },

    #[error(
        "Unauthorized: only protocol {protocol_id}'s registered President may buy Hardware for it"
    )]
    NotPresident { protocol_id: u32 },

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
    #[error(
        "It is not protocol {protocol_id}'s turn in game room {game_id}'s Operating Round Corporation Turn Queue; protocol {expected_protocol_id} must act first"
    )]
    NotYourOperatingTurn {
        game_id: u64,
        protocol_id: u32,
        expected_protocol_id: u32,
    },

    #[error(
        "The Hardware pool for game room {game_id} is empty; no more units are available to buy"
    )]
    PoolEmpty { game_id: u64 },

    #[error("Protocol {company_id}'s treasury holds {available} VGP, which is less than the {required} VGP baseline cost")]
    InsufficientTreasury {
        company_id: u32,
        required: Uint128,
        available: Uint128,
    },

    #[error(
        "Protocol {protocol_id} already owns {owned} train(s), at or above the {limit}-train limit for the current phase (highest tier purchased so far: {phase}); no more can be bought until the limit rises or its fleet shrinks"
    )]
    TrainLimitExceeded {
        protocol_id: u32,
        owned: u32,
        limit: u32,
        phase: String,
    },

    #[error(
        "Protocol {protocol_id} still owns {count} active Hardware unit(s); EmergencyBuyHardware only applies when a company owns zero"
    )]
    CompanyHasHardware { protocol_id: u32, count: u32 },

    #[error(
        "Protocol {protocol_id}'s treasury already holds {treasury} VGP, enough to cover the {cost} VGP next Hardware unit -- use BuyHardwareFromPool instead of EmergencyBuyHardware"
    )]
    TreasuryCanAffordNormalPurchase {
        protocol_id: u32,
        cost: Uint128,
        treasury: Uint128,
    },

    #[error("Arithmetic overflow/underflow while processing a Hardware purchase")]
    Overflow {},
}

/// Seeds `game_id` with the full `TRAIN_CATALOG` supply, in strict tier
/// order, as `HARDWARE_POOL`'s starting queue. Called once, when a game
/// room is created (see `contract::execute_create_game_room`).
pub fn spawn_hardware_pool(storage: &mut dyn Storage, game_id: u64) -> StdResult<()> {
    let mut pool = Vec::new();
    for (model_type, cost, max_route_distance, quantity) in TRAIN_CATALOG.iter().copied() {
        for _ in 0..quantity {
            pool.push(HardwareAsset {
                model_type: model_type.to_string(),
                cost: Uint128::new(cost),
                max_route_distance,
            });
        }
    }
    HARDWARE_POOL.save(storage, game_id, &pool)?;
    Ok(())
}

/// Records `asset` as newly owned by `protocol_id`, bumps
/// `TRAINS_PURCHASED_COUNT`, and -- if this is the first-ever unit of a
/// triggering tier -- runs the cross-company Rusting sweep, adding
/// attributes describing whatever happened onto `response`. Shared by
/// `execute_buy_hardware_from_pool` and `execute_emergency_buy_hardware` so
/// the rusting logic only lives in one place (see module doc comment #3).
fn record_purchase_and_apply_rusting(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
    asset: HardwareAsset,
    mut response: Response,
) -> Result<Response, HardwareError> {
    let mut owned = COMPANY_HARDWARE
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default();
    let is_first_hardware_for_company = owned.is_empty();
    owned.push(asset.clone());
    COMPANY_HARDWARE.save(storage, (game_id, protocol_id), &owned)?;

    // B&O Special Closure (module doc comment #11): fires the instant the
    // PUBLIC B&O corporation buys its own very first train, independent of
    // tier and of the room-wide "first-ever unit of this tier" detection
    // below.
    if is_first_hardware_for_company && protocol_id == BO_PUBLIC_COMPANY_ID {
        if let Some(mut bo_private) =
            PRIVATE_COMPANIES.may_load(storage, (game_id, PRIVATE_BO_ID))?
        {
            if !bo_private.closed {
                bo_private.closed = true;
                PRIVATE_COMPANIES.save(storage, (game_id, PRIVATE_BO_ID), &bo_private)?;
                response = response
                    .add_attribute("bo_private_closed", "true")
                    .add_attribute(
                        "bo_private_close_reason",
                        "public_bo_first_train_purchase",
                    );
            }
        }
    }

    let purchased_before = TRAINS_PURCHASED_COUNT
        .may_load(storage, (game_id, asset.model_type.clone()))?
        .unwrap_or(0);
    let purchased_after = purchased_before
        .checked_add(1)
        .ok_or(HardwareError::Overflow {})?;
    TRAINS_PURCHASED_COUNT.save(
        storage,
        (game_id, asset.model_type.clone()),
        &purchased_after,
    )?;

    // This is the *first-ever* unit of this tier -- run the Rusting sweep
    // if it's a configured trigger.
    if purchased_before == 0 {
        if let Some((_, rusted_model)) = RUST_TRIGGERS
            .iter()
            .find(|(trigger_model, _)| *trigger_model == asset.model_type)
        {
            let mut total_units_rusted = 0u32;
            let mut companies_affected = Vec::new();
            for (company_id, _) in CORE_PUBLIC_COMPANIES.iter().copied() {
                let inventory = COMPANY_HARDWARE
                    .may_load(storage, (game_id, company_id))?
                    .unwrap_or_default();
                let before_count = inventory.len();
                let retained: Vec<HardwareAsset> = inventory
                    .into_iter()
                    .filter(|unit| unit.model_type != *rusted_model)
                    .collect();
                let removed = before_count - retained.len();
                if removed > 0 {
                    COMPANY_HARDWARE.save(storage, (game_id, company_id), &retained)?;
                    total_units_rusted += removed as u32;
                    companies_affected.push(company_id.to_string());
                }
            }

            response = response
                .add_attribute("rusting_triggered", "true")
                .add_attribute("rusted_model", *rusted_model)
                .add_attribute("rusted_units_removed", total_units_rusted.to_string())
                .add_attribute("rusted_companies_affected", companies_affected.join(","));
        }

        // Tech Era Color-Locking (module doc comment #8): this same
        // "first-ever unit of this tier" instant is exactly when the real
        // 1830 phase chart unlocks a new tile color.
        if let Some((_, unlocked_color)) = ERA_UNLOCK_TRIGGERS
            .iter()
            .find(|(trigger_model, _)| *trigger_model == asset.model_type)
        {
            let mut session: GameSession = SESSIONS.load(storage, game_id)?;
            if *unlocked_color > session.current_global_era {
                session.current_global_era = *unlocked_color;
                SESSIONS.save(storage, game_id, &session)?;

                response = response
                    .add_attribute("era_advanced", "true")
                    .add_attribute("new_global_era", format!("{unlocked_color:?}"));

                // Phase 5 Private Closure (module doc comment #12): fires
                // exactly once, the instant the room's era newly becomes
                // Brown -- every still-open private closes, regardless of
                // player/corporation/no ownership.
                if *unlocked_color == TileColor::Brown {
                    let mut closed_private_ids = Vec::new();
                    for (private_id, _, _, _) in CORE_PRIVATE_COMPANIES.iter().copied() {
                        let private: Option<PrivateCompany> =
                            PRIVATE_COMPANIES.may_load(storage, (game_id, private_id))?;
                        if let Some(mut private) = private {
                            if !private.closed {
                                private.closed = true;
                                PRIVATE_COMPANIES.save(
                                    storage,
                                    (game_id, private_id),
                                    &private,
                                )?;
                                closed_private_ids.push(private_id.to_string());
                            }
                        }
                    }
                    if !closed_private_ids.is_empty() {
                        response = response.add_attribute(
                            "phase5_privates_closed",
                            closed_private_ids.join(","),
                        );
                    }
                }
            }
        }
    }

    Ok(response)
}

/// Buys the unit at the front of `game_id`'s `HARDWARE_POOL` queue on
/// behalf of `protocol_id`, charging its cost against the company's
/// treasury, then automatically runs the Rusting sweep if this purchase is
/// the first-ever unit of a triggering tier. See the module doc comment
/// for the full design.
pub fn execute_buy_hardware_from_pool(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
) -> Result<Response, HardwareError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(HardwareError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(HardwareError::GameNotActive { game_id });
    }

    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HardwareError::NoPresidentAssigned { protocol_id })?;
    if info.sender != president {
        return Err(HardwareError::NotPresident { protocol_id });
    }


    // ==== Audit G-14: Operating Round sub-phase gate. ====
    // Deliberately does NOT advance the cursor afterwards: a corporation may buy
    // as many trains as it can afford up to the phase train limit, so it stays
    // on `Hardware` until the turn ends.
    if let Err(mismatch) = or_phase::require_sub_phase(
        deps.storage,
        &session,
        protocol_id,
        OperatingSubPhase::Hardware,
    ) {
        return Err(match mismatch {
            or_phase::PhaseMismatch::Wrong { actual, required } => HardwareError::WrongOperatingSubPhase {
                protocol_id,
                actual: or_phase::phase_name(actual).to_string(),
                actual_index: or_phase::phase_index(actual),
                required: or_phase::phase_name(required).to_string(),
                required_index: or_phase::phase_index(required),
            },
            or_phase::PhaseMismatch::Storage(message) => HardwareError::Std(StdError::generic_err(message)),
        });
    }

    // Operating Round Corporation Turn Queue (see `hexmap.rs`'s module doc
    // comment #13 for the shared design): layered on top of the President
    // check above, only enforced once the room actually has a non-empty
    // `active_operating_order`. `EmergencyBuyHardware` deliberately isn't
    // wrapped by this check -- its whole purpose is a Validator Liability
    // backstop usable whenever the zero-Hardware condition applies, not a
    // scheduled turn action.
    if let Some(&expected_protocol_id) = session
        .active_operating_order
        .get(session.active_corporation_index as usize)
    {
        if protocol_id != expected_protocol_id {
            return Err(HardwareError::NotYourOperatingTurn {
                game_id,
                protocol_id,
                expected_protocol_id,
            });
        }
    }

    let mut company: PublicCompany = PUBLIC_COMPANIES
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HardwareError::PublicCompanyNotFound {
            game_id,
            company_id: protocol_id,
        })?;

    // Train Limit cap (module doc comment #10a) -- checked BEFORE the pool,
    // treasury, or Rusting sweep are touched at all, using the phase as it
    // stands right now (prior to this purchase). A corporation already at
    // its cap is rejected outright, even in the case where this exact
    // purchase would itself trigger a Rusting sweep that would (as a side
    // effect) bring it back under the cap -- see that design note for why
    // that isn't looked ahead to here.
    let owned_count = COMPANY_HARDWARE
        .may_load(deps.storage, (game_id, protocol_id))?
        .unwrap_or_default()
        .len() as u32;
    let current_phase = highest_train_tier_purchased(deps.storage, game_id)?;
    let train_limit = train_limit_for_phase(current_phase.as_deref());
    if owned_count >= train_limit {
        return Err(HardwareError::TrainLimitExceeded {
            protocol_id,
            owned: owned_count,
            limit: train_limit,
            phase: current_phase.unwrap_or_else(|| "2 (none purchased yet)".to_string()),
        });
    }

    let mut pool = HARDWARE_POOL
        .may_load(deps.storage, game_id)?
        .unwrap_or_default();
    if pool.is_empty() {
        return Err(HardwareError::PoolEmpty { game_id });
    }
    let asset = pool.remove(0);

    let new_treasury = company.treasury.checked_sub(asset.cost).map_err(|_| {
        HardwareError::InsufficientTreasury {
            company_id: protocol_id,
            required: asset.cost,
            available: company.treasury,
        }
    })?;
    company.treasury = new_treasury;
    PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

    if !asset.cost.is_zero() {
        session.virtual_bank_vgp = session
            .virtual_bank_vgp
            .checked_add(asset.cost)
            .map_err(|_| HardwareError::Overflow {})?;
    }
    // Inactivity Timeout Safety Valve (see `state.rs`'s
    // `GameSession::last_action_timestamp` doc comment): a successful
    // BuyHardwareFromPool call resets the room's 48-hour inactivity clock.
    session.last_action_timestamp = env.block.time.seconds();
    SESSIONS.save(deps.storage, game_id, &session)?;

    let pool_units_remaining = pool.len();
    HARDWARE_POOL.save(deps.storage, game_id, &pool)?;

    let response = Response::new()
        .add_attribute("action", "buy_hardware_from_pool")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("buyer", info.sender.as_str())
        .add_attribute("model_type", asset.model_type.clone())
        .add_attribute("cost", asset.cost)
        .add_attribute("max_route_distance", asset.max_route_distance.to_string())
        .add_attribute("company_treasury_remaining", company.treasury)
        .add_attribute("pool_units_remaining", pool_units_remaining.to_string());

    record_purchase_and_apply_rusting(deps.storage, game_id, protocol_id, asset, response)
}

/// Implements rules.md's Validator Liability rule. Requires `protocol_id`
/// to currently own zero Hardware and its treasury to be *unable* to
/// afford the next `HARDWARE_POOL` unit alone (otherwise it rejects the
/// call and points the caller at `BuyHardwareFromPool`). If the President's
/// own `PLAYER_CASH_VGP` can cover the shortfall, it's deducted, the
/// company's treasury is emptied to zero, and the train is awarded exactly
/// like an ordinary purchase (including the Rusting sweep). If the
/// combined treasury and personal wallet still can't cover it, this
/// returns `Ok(Response)` with `GameSession::is_active` durably flipped to
/// `false` and a `bankruptcy` event attached instead -- see module doc
/// comment #7 for why that's a successful transaction, not an error.
/// Emergency Asset Liquidation (Audit G-8), the tier that sits between "the
/// President's wallet is short" and "the game is over".
///
/// Force-sells `president`'s PERSONAL share holdings into the open-market
/// Bank pool, one certificate at a time, until either `deficit` is covered
/// or nothing further can legally be sold. Returns the total VGP raised --
/// which the caller adds to the President's spendable cash before
/// re-testing affordability.
///
/// Real 1830 requires a president who cannot fund a mandatory train to
/// raise cash by selling shares before bankruptcy is even considered. This
/// cascade previously jumped straight from "personal cash is short" to a
/// hard bankruptcy halt, declaring games over on presidents who were, in
/// 1830 terms, entirely solvent.
///
/// Rules honoured while liquidating:
///
/// - **Deterministic order.** Companies are swept in `CORE_PUBLIC_COMPANIES`
///   id order, never storage-iteration order, so the same board state
///   always liquidates identically on every node.
/// - **Per-certificate pricing.** Each certificate sells at the market
///   price *at the moment it is sold*, and the marker then moves down one
///   row. This is a SEQUENCE of individual one-certificate sales, not one
///   bulk sale, so it does not contradict Audit G-4 (which fixed the price
///   for all certificates within a single `SellStock` call).
/// - **50% Bank pool cap.** A company whose pool is already at
///   `BANK_POOL_CAP_PERCENTAGE` absorbs nothing more; the sweep moves on.
/// - **The President's certificate is never force-sold.** Where the seller
///   is the registered President, liquidation stops at
///   `PRESIDENT_MIN_PERCENTAGE` -- real 1830 does not let a president be
///   involuntarily stripped of the presidency to fund a train. This also
///   keeps the sweep from ever leaving a floated corporation with nobody
///   able to hold its President's certificate, so no seat ever has to move
///   and `trading::recalculate_president` is deliberately not involved.
/// - **Bank solvency.** The game bank funds these buybacks; if it cannot
///   cover a certificate, the sweep stops rather than driving
///   `virtual_bank_vgp` negative.
fn liquidate_president_assets(
    storage: &mut dyn Storage,
    game_id: u64,
    session: &mut GameSession,
    president: &Addr,
    deficit: Uint128,
    attrs: &mut Vec<Attribute>,
) -> Result<Uint128, HardwareError> {
    let mut raised = Uint128::zero();

    for (company_id, _ticker) in CORE_PUBLIC_COMPANIES.iter().copied() {
        if raised >= deficit {
            break;
        }

        let mut held = PLAYER_SHARES
            .may_load(storage, (game_id, company_id, president.clone()))?
            .unwrap_or(0);
        if held < PERCENT_PER_SHARE {
            continue;
        }

        // The floor this company's holding may be sold down to: 0 for an
        // ordinary stake, the President's own certificate for one they
        // preside over.
        let is_president_here = PROTOCOL_PRESIDENT
            .may_load(storage, (game_id, company_id))?
            .as_ref()
            == Some(president);
        let floor_pct = if is_president_here {
            PRESIDENT_MIN_PERCENTAGE
        } else {
            0
        };
        if held <= floor_pct {
            continue;
        }

        let mut bank_pct = BANK_POOL_SHARES
            .may_load(storage, (game_id, company_id))?
            .unwrap_or(0);
        let mut sold_pct: u8 = 0;

        while raised < deficit
            && held >= floor_pct.saturating_add(PERCENT_PER_SHARE)
            && bank_pct.saturating_add(PERCENT_PER_SHARE) <= BANK_POOL_CAP_PERCENTAGE
        {
            let price = market::current_cell(storage, game_id, company_id)?.price;

            // The bank buys these certificates back; it cannot spend what
            // it does not have.
            let Ok(bank_after) = session.virtual_bank_vgp.checked_sub(price) else {
                break;
            };
            session.virtual_bank_vgp = bank_after;
            if session.virtual_bank_vgp.is_zero() {
                // Deferred Bank-Break Halt -- same flag `trading::execute_sell_stock`
                // sets, for the same reason.
                session.bank_is_broken = true;
            }

            held -= PERCENT_PER_SHARE;
            bank_pct += PERCENT_PER_SHARE;
            sold_pct += PERCENT_PER_SHARE;
            raised = raised
                .checked_add(price)
                .map_err(|_| HardwareError::Overflow {})?;

            // Dumped shares drive the price down one row per certificate.
            market::move_down(storage, game_id, company_id)?;
        }

        if sold_pct > 0 {
            PLAYER_SHARES.save(storage, (game_id, company_id, president.clone()), &held)?;
            BANK_POOL_SHARES.save(storage, (game_id, company_id), &bank_pct)?;
            attrs.push(Attribute::new(
                format!("liquidated_protocol_{company_id}_percentage"),
                sold_pct.to_string(),
            ));
        }
    }

    if !raised.is_zero() {
        attrs.push(Attribute::new("liquidation_proceeds", raised.to_string()));
    }
    Ok(raised)
}

pub fn execute_emergency_buy_hardware(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
) -> Result<Response, HardwareError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(HardwareError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(HardwareError::GameNotActive { game_id });
    }

    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HardwareError::NoPresidentAssigned { protocol_id })?;
    if info.sender != president {
        return Err(HardwareError::NotPresident { protocol_id });
    }

    let mut company: PublicCompany = PUBLIC_COMPANIES
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HardwareError::PublicCompanyNotFound {
            game_id,
            company_id: protocol_id,
        })?;

    let owned_count = COMPANY_HARDWARE
        .may_load(deps.storage, (game_id, protocol_id))?
        .unwrap_or_default()
        .len();
    if owned_count > 0 {
        return Err(HardwareError::CompanyHasHardware {
            protocol_id,
            count: owned_count as u32,
        });
    }

    let mut pool = HARDWARE_POOL
        .may_load(deps.storage, game_id)?
        .unwrap_or_default();
    if pool.is_empty() {
        return Err(HardwareError::PoolEmpty { game_id });
    }
    let cost = pool[0].cost;

    if company.treasury >= cost {
        return Err(HardwareError::TreasuryCanAffordNormalPurchase {
            protocol_id,
            cost,
            treasury: company.treasury,
        });
    }

    let deficit = cost
        .checked_sub(company.treasury)
        .map_err(|_| HardwareError::Overflow {})?;

    let mut personal_cash = PLAYER_CASH_VGP
        .may_load(deps.storage, (game_id, president.clone()))?
        .unwrap_or_default();

    // Emergency Asset Liquidation (Audit G-8, module doc comment #16): the
    // tier between "wallet is short" and "game over". Before declaring
    // bankruptcy, the President is forced to sell personal shares into the
    // Bank pool to raise the shortfall -- real 1830 demands this, and the
    // cascade used to skip it entirely.
    let mut liquidation_attrs: Vec<Attribute> = Vec::new();
    let mut liquidation_proceeds = Uint128::zero();
    if personal_cash < deficit {
        let shortfall = deficit
            .checked_sub(personal_cash)
            .map_err(|_| HardwareError::Overflow {})?;
        liquidation_proceeds = liquidate_president_assets(
            deps.storage,
            game_id,
            &mut session,
            &president,
            shortfall,
            &mut liquidation_attrs,
        )?;
        if !liquidation_proceeds.is_zero() {
            personal_cash = personal_cash
                .checked_add(liquidation_proceeds)
                .map_err(|_| HardwareError::Overflow {})?;
            // Persist the raised cash immediately: whichever branch runs
            // below, the President genuinely sold those certificates and
            // must be holding the proceeds.
            PLAYER_CASH_VGP.save(deps.storage, (game_id, president.clone()), &personal_cash)?;
            SESSIONS.save(deps.storage, game_id, &session)?;
        }
    }

    if personal_cash < deficit {
        // Treasury + personal wallet + everything the President could
        // legally liquidate still can't cover it -- only NOW is this an
        // absolute immediate Bankruptcy Hard Halt (module doc comment #7,
        // extended here). Unlike the Deferred Bank-Break Halt
        // (`GameSession::bank_is_broken`, see `state.rs`'s own doc comment
        // and `operations.rs`), this does NOT wait for the current
        // scheduled block of Operating Rounds to finish -- a President who
        // cannot personally cover the Validator Liability deficit halts the
        // game on the spot, mid-turn. This is still treated as a
        // *successful* transaction (not an Err) specifically so the halt
        // actually persists -- see module doc comment #7. No train is
        // awarded, and the only funds that move are the final liquidation
        // payout below (`finalize_and_distribute_payouts`, the same
        // net-worth liquidation routine every other game-end trigger in
        // this contract already uses) -- NOT the deficit itself, which is
        // never actually collected on this path.
        let end_game_response = crate::contract::finalize_and_distribute_payouts(deps, game_id, session)?;

        let bankruptcy_event = Event::new("bankruptcy")
            .add_attribute("game_id", game_id.to_string())
            .add_attribute("protocol_id", protocol_id.to_string())
            .add_attribute("president", president.as_str())
            .add_attribute("required_cost", cost)
            .add_attribute("company_treasury", company.treasury)
            .add_attribute("president_personal_cash", personal_cash)
            .add_attribute("deficit", deficit);

        return Ok(Response::new()
            .add_attribute("action", "emergency_buy_hardware")
            .add_attribute("outcome", "bankruptcy")
            .add_attribute("game_id", game_id.to_string())
            .add_attribute("protocol_id", protocol_id.to_string())
            .add_attribute("game_session_halted", "true")
            // Audit G-8: what liquidation DID manage to raise before this
            // still fell short -- the President really did sell those
            // certificates, so the sale is reported either way.
            .add_attributes(liquidation_attrs)
            .add_event(bankruptcy_event)
            .add_attributes(end_game_response.attributes)
            // See `operations.rs`'s identical `add_messages` fix for the
            // full `SubMsg`/`CosmosMsg` rationale.
            .add_messages(end_game_response.messages.into_iter().map(|m| m.msg)));
    }

    let new_personal_cash = personal_cash
        .checked_sub(deficit)
        .map_err(|_| HardwareError::Overflow {})?;
    PLAYER_CASH_VGP.save(
        deps.storage,
        (game_id, president.clone()),
        &new_personal_cash,
    )?;

    let treasury_contribution = company.treasury;
    company.treasury = Uint128::zero();
    PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

    // The full cost (treasury's prior balance plus the President's deficit
    // contribution) flows into the shared bank, same as any other purchase.
    session.virtual_bank_vgp = session
        .virtual_bank_vgp
        .checked_add(cost)
        .map_err(|_| HardwareError::Overflow {})?;
    SESSIONS.save(deps.storage, game_id, &session)?;

    let asset = pool.remove(0);
    let pool_units_remaining = pool.len();
    HARDWARE_POOL.save(deps.storage, game_id, &pool)?;

    let response = Response::new()
        .add_attribute("action", "emergency_buy_hardware")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("president", president.as_str())
        .add_attribute("model_type", asset.model_type.clone())
        .add_attribute("cost", cost)
        .add_attribute("company_treasury_contributed", treasury_contribution)
        .add_attribute("president_personal_contribution", deficit)
        .add_attribute("president_personal_cash_remaining", new_personal_cash)
        .add_attribute("liquidation_proceeds_raised", liquidation_proceeds)
        .add_attribute("pool_units_remaining", pool_units_remaining.to_string())
        .add_attributes(liquidation_attrs);

    record_purchase_and_apply_rusting(deps.storage, game_id, protocol_id, asset, response)
}
