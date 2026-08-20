//! Hardware Store (Train Pool): the global sequential supply, its automatic
//! Rusting sweeps, and the Validator Liability / Emergency Buy backstop.
//!
//!   Catalog        real 1830 costs and quantities ($80/$180/$300/$450/$630,
//!                  6/5/4/3/2). The Diesel has unlimited supply in 1830; see
//!                  `ensure_pool_not_empty` for how a `Vec` expresses that.
//!   No selection   `BuyHardwareFromPool` takes no model. The pool is seeded in
//!                  full tier order and every purchase removes the FRONT
//!                  element, so a buyer can never skip ahead while an earlier
//!                  tier still has stock -- which is also why rusting only ever
//!                  needs to sweep company inventories, never the pool.
//!   Rusting        the first 4-train rusts every 2; the first 6 rusts every 3;
//!                  the first Diesel rusts every 4.
//!   Era unlocks    the first 3-train unlocks Green tiles, the first 5-train
//!                  Brown. Detected in the SAME pass as rusting, so the two
//!                  first-ever-purchase triggers can never drift apart.
//!   First-ever     tracked in `TRAINS_PURCHASED_COUNT`, not inferred from queue
//!                  position, so exactly-once firing does not silently break if
//!                  the buying rules change.
//!   Train limits   4 trains in Phase 2/3, 3 in Phase 4, 2 from Phase 5 --
//!                  checked BEFORE the pool, treasury or rusting sweep, using
//!                  the phase as it stands.
//!   Pacing         a 2-train paces 1 Operating Round, a 3/4-train 2, a 5 or
//!                  better 3.
//!   Closures       the B&O private closes when the public B&O buys its first
//!                  train; EVERY open private closes when Phase 5 begins.
//!
//! Bankruptcy halts via a SUCCESSFUL transaction, not an error: CosmWasm reverts
//! every state write made during a call returning `Err`, so an error return could
//! never durably flip `is_active` to false. The halt runs the same final
//! liquidation every other game-end trigger uses, so a bankruptcy no longer
//! leaves the lobby's real JUNO stranded in contract state.
//!
//! See docs/ai_architecture/rust_contract_architecture.md, hardware.rs.

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

/// Maps the highest tier ever purchased to that phase's train-limit cap. `None`
/// (nothing purchased) is Phase 2's baseline of 4, same as a first 2-train would
/// read; an unrecognized model also falls back to 4 rather than panicking.
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

/// `(trigger_model, unlocked_color)`: buying the FIRST-EVER unit of the trigger
/// advances `current_global_era` room-wide. `TileColor`'s derived `Ord` means this
/// can never regress the era even if triggers ever fired out of order.
pub const ERA_UNLOCK_TRIGGERS: &[(&str, TileColor)] =
    &[("3", TileColor::Green), ("5", TileColor::Brown)];

/// `(model_type, operating_round_sequence_length)`: the classic 1830 Pacing
/// Automation rule -- see module doc comment #10 for the full rationale and
/// `highest_train_tier_purchased`/`operating_round_sequence_length_for_tier`
/// for how this is looked up. Listed in the same tier order as
/// `TRAIN_CATALOG` so the two stay easy to eyeball against each other.
pub const OR_SEQUENCE_LENGTH_BY_TIER: &[(&str, u32)] =
    &[("2", 1), ("3", 2), ("4", 2), ("5", 3), ("6", 3), ("D", 3)];

/// The highest-tier model ever purchased in `game_id`, or `None`. Checks tiers
/// highest-to-lowest against `TRAINS_PURCHASED_COUNT` rather than live
/// inventories, which Rusting can empty -- so a tier that later fully rusted away
/// is still correctly remembered as having been reached.
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

/// Maps the highest-purchased model to the number of Operating Round sub-rounds
/// the upcoming macro round runs. `None` defaults to `1`, the same baseline as a
/// 2-train, since a room with nothing bought has not reached even the first
/// pacing threshold. An unrecognized model also falls back to `1` rather than
/// panicking, since this is pacing, not funds-moving calculation.
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

    /// Audit G-8: Emergency Asset Liquidation reads and moves the stock market while
    /// force-selling a President's shares, so this module carries `MarketError` the
    /// same way `trading.rs` and `operations.rs` already do.
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

    /// Audit G-17: this corporation has an unanswered train offer standing,
    /// and an emergency purchase is an answer to the same problem. Resolve the
    /// offer first -- `RescindTrainOffer` is the buyer's own unilateral right,
    /// so this is never a deadlock.
    #[error(
        "protocol {protocol_id} cannot emergency-buy while train offer {offer_id} to protocol {seller_protocol_id} is unanswered -- rescind it, or wait for a reply"
    )]
    PendingTrainOfferBlocksEmergencyBuy {
        protocol_id: u32,
        offer_id: u64,
        seller_protocol_id: u32,
    },

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
/// The Diesel's catalog row, looked up once. `expect` rather than a fallible
/// return: a `TRAIN_CATALOG` without a `"D"` entry is a broken build, not a
/// runtime condition any caller could handle.
fn diesel_asset() -> HardwareAsset {
    let (model_type, cost, max_route_distance, _qty) = TRAIN_CATALOG
        .iter()
        .copied()
        .find(|(model, ..)| *model == DIESEL_MODEL)
        .expect("TRAIN_CATALOG must contain the Diesel");
    HardwareAsset {
        model_type: model_type.to_string(),
        cost: Uint128::new(cost),
        max_route_distance,
    }
}

/// The model string for the unlimited top-tier train.
pub const DIESEL_MODEL: &str = "D";

/// Guarantees the pool is never empty -- Audit G-17.
///
/// In 1830 every train type has a fixed supply EXCEPT the Diesel, which is
/// unlimited. That is not a detail: it is the game's terminal state -- Diesels
/// never rust, so the endgame assumes any corporation that can afford one can
/// always buy one.
///
/// `HARDWARE_POOL` is a `Vec`, and "unlimited" has no representation in one. The
/// previous approach seeded 20 Diesels and relied on no real game exhausting
/// them. That is PROBABLY true -- but "probably" is doing load-bearing work in a
/// rule that says "always", and the failure mode is the worst kind: a late-game
/// `PoolEmpty` that looks like a contract bug and strands every corporation at
/// once, in a state the rules say cannot occur.
///
/// So the pool tops itself up: when the last unit is taken, the next call finds
/// it empty and appends a fresh Diesel. The finite tiers are untouched; only the
/// tail is inexhaustible.
///
/// `PoolEmpty` is consequently unreachable from either buy path, and is
/// deliberately KEPT: it is still the honest answer if a future caller reads the
/// pool without going through this, and a removed error variant is a worse
/// outcome than an unused one.
pub fn replenish_pool_if_exhausted(pool: &mut Vec<HardwareAsset>) {
    if pool.is_empty() {
        pool.push(diesel_asset());
    }
}

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

/// Records `asset` as owned by `protocol_id`, bumps `TRAINS_PURCHASED_COUNT` and
/// -- if this is the first-ever unit of a triggering tier -- runs the
/// cross-company Rusting sweep and the era unlock. Shared by both buy paths so
/// this logic lives in one place.
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

    // Operating Round turn-queue gating, layered on top of the President check and
    // only enforced once the room has a non-empty operating order.
    // `EmergencyBuyHardware` is deliberately NOT wrapped: its whole purpose is a
    // backstop usable whenever the zero-Hardware condition applies, not a scheduled
    // turn action.
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

    // Train Limit cap, checked BEFORE the pool, treasury or Rusting sweep are
    // touched at all, using the phase as it stands right now. A corporation already
    // at its cap is rejected outright, even where this exact purchase would itself
    // trigger a Rusting sweep that would bring it back under -- that lookahead is
    // deliberately not performed.
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
    // Audit G-17: Diesels are unlimited, so an exhausted pool refills with one
    // rather than failing. See `replenish_pool_if_exhausted`.
    replenish_pool_if_exhausted(&mut pool);
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

/// Validator Liability: requires `protocol_id` to own zero Hardware and its
/// treasury to be UNABLE to afford the next pool unit alone (otherwise it points
/// the caller at the ordinary purchase). The President's personal cash covers the
/// shortfall; if that is still short, Emergency Asset Liquidation runs; if even
/// that cannot cover it, the call returns `Ok` with the session durably halted
/// and a `bankruptcy` event -- a successful transaction, not an error, because
/// CosmWasm would revert the halt otherwise.
/// Emergency Asset Liquidation (Audit G-8) -- the tier between "the President's
/// wallet is short" and "the game is over".
///
/// Force-sells the President's PERSONAL holdings into the Bank pool, one
/// certificate at a time, until the deficit is covered or nothing further can
/// legally be sold. The cascade previously jumped straight from "personal cash is
/// short" to a hard bankruptcy halt, declaring games over on presidents who were,
/// in 1830 terms, entirely solvent.
///
/// Rules honoured while liquidating:
///   DETERMINISTIC ORDER -- companies are swept in catalog id order, never
///     storage-iteration order, so the same board always liquidates identically
///     on every node.
///   PER-CERTIFICATE PRICING -- each sells at the price at the moment it sells,
///     and the marker then moves down. This is a SEQUENCE of one-certificate
///     sales, not one bulk sale, so it does not contradict Audit G-4.
///   THE 50% BANK POOL CAP -- a company already at it absorbs nothing more.
///   THE PRESIDENT'S CERTIFICATE IS NEVER FORCE-SOLD -- real 1830 does not let a
///     president be involuntarily stripped of the presidency to fund a train.
///     This also keeps the sweep from ever leaving a floated corporation with
///     nobody able to hold its President's certificate, so no seat has to move.
///   BANK SOLVENCY -- if the bank cannot cover a certificate the sweep stops
///     rather than driving `virtual_bank_vgp` negative.
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

    // Audit G-17: an outstanding train offer must be resolved first. The two
    // mechanisms answer the SAME problem -- this corporation has no train -- and
    // running them concurrently is incoherent. An emergency purchase is the
    // expensive last resort; a pending offer might be about to supply a train at a
    // price the corporation can actually afford.
    //
    // REFUSED, NOT AUTO-RESCINDED, and the distinction is deliberate. Silently
    // withdrawing an offer the player made, as a side effect of a different message,
    // spends their negotiating position without asking -- and the rival might have
    // been one block away from accepting. Refusing hands the decision back.
    //
    // NOT A DEADLOCK: `RescindTrainOffer` is the buyer's own unilateral right, one
    // transaction away, needing nobody's cooperation.
    if let Some((offer_id, offer)) =
        crate::train_trade::pending_offer_for_buyer(deps.storage, game_id, protocol_id)?
    {
        return Err(HardwareError::PendingTrainOfferBlocksEmergencyBuy {
            protocol_id,
            offer_id,
            seller_protocol_id: offer.seller_protocol_id,
        });
    }

    let mut pool = HARDWARE_POOL
        .may_load(deps.storage, game_id)?
        .unwrap_or_default();
    // Audit G-17: Diesels are unlimited -- see `replenish_pool_if_exhausted`.
    replenish_pool_if_exhausted(&mut pool);
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
        // Treasury + personal wallet + everything the President could legally liquidate
        // still cannot cover it -- only NOW is this an immediate Bankruptcy Hard Halt.
        // Unlike the Deferred Bank-Break Halt this does NOT wait for the current
        // scheduled block of Operating Rounds to finish; it halts on the spot, mid-turn.
        // Still a SUCCESSFUL transaction so the halt actually persists. No train is
        // awarded, and the deficit itself is never collected on this path.
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
