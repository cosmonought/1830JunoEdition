//! Operating Round sub-phase sequencing -- Audit G-14.
//!
//! # What this enforces
//!
//! A corporation's Operating Round turn runs through six phases, in this
//! order, and the contract now refuses any action taken out of order:
//!
//! | # | Phase        | Action                              | Skippable |
//! |---|--------------|-------------------------------------|-----------|
//! | 1 | `BuyPrivate` | `BuyPrivateCompany` (Phase 3+ only) | yes       |
//! | 2 | `Track`      | `LayTile`                           | yes       |
//! | 3 | `Tokens`     | `PlaceStationToken`                 | yes       |
//! | 4 | `Routes`     | `RunManualRoute` / `ExecuteOperatingRound` | only with NO train |
//! | 5 | `Dividends`  | `DeclareDividends`                  | **never** |
//! | 6 | `Hardware`   | `BuyHardwareFromPool`               | yes       |
//!
//! # Why this exists
//!
//! Before G-14 the order was a CLIENT-SIDE CONVENTION and nothing more.
//! `App.tsx` walked its own `OperatingSubPhase` state machine and drew the
//! matching buttons, while every one of the six messages was gated only on
//! "is it your corporation's turn". A player dispatching directly -- or any
//! second client -- could declare dividends before running trains, place a
//! token before laying track, or buy a train and then go back and lay track
//! afterwards. The UI told an orderly story the chain did not enforce.
//!
//! That matters beyond tidiness because two of these phases are ORDER
//! DEPENDENT in the rules themselves: dividends are declared against revenue
//! that running trains produced, and a token may only be placed into a city
//! the corporation's network reaches, which the tile it just laid may be what
//! connects. Allowing them out of order does not merely look wrong, it lets a
//! player declare a payout for revenue that was never computed.
//!
//! # The two conditional rules, and why they are conditional
//!
//! **`Routes` is skippable only by a corporation that owns no train.** A
//! company with a train MUST run it. In 1830 running is not optional -- you
//! may not decline to earn in order to dodge a dividend, and you may not
//! withhold by simply never running. A company with no train has nothing to
//! run and would otherwise be stuck forever, so it alone may pass through.
//!
//! **`Dividends` is never skippable.** Having run, the corporation must say
//! what happens to the money: pay it out or withhold it. Both are legal, so
//! there is no case where "neither" is a legitimate answer -- and letting the
//! phase be skipped would leave revenue in an undefined state with the turn
//! already over.
//!
//! # Phase 1 and the pre-Phase-3 board
//!
//! `BuyPrivate` leads the turn, per the real sequence, but the action behind
//! it is locked until the game reaches Phase 3 (`trading.rs`'s own
//! `PrivatePurchaseLockedBeforePhase3`). Rather than force every corporation
//! to burn a no-op skip transaction every turn for the whole Yellow era,
//! `initial_sub_phase` starts the cursor at `Track` while the era is Yellow
//! and at `BuyPrivate` from Green onward. The phase is not skipped; for that
//! part of the game it does not yet exist.
//!
//! # Actions per phase
//!
//! `LayTile` advances the cursor on success, which is what makes 1830's real
//! ONE-TILE-LAY-PER-TURN rule fall out of the sequencing -- there was no such
//! limit before this, and a corporation could lay unlimited tiles in a turn.
//!
//! `BuyHardwareFromPool` deliberately does NOT advance: a corporation may buy
//! as many trains as it can afford up to the phase's train limit
//! (`hardware::train_limit_for_phase`), so the cursor stays on `Hardware`
//! until the turn ends. Every other phase advances on its own action.
//!
//! # Storage and replay
//!
//! The cursor lives in `PROTOCOL_OR_SUB_PHASE`, keyed per (game,
//! corporation), and is reset by `reset_for_turn` whenever the operating turn
//! moves on. A missing entry reads as `initial_sub_phase`, so a game in
//! flight when this ships simply starts every corporation at the top of its
//! next turn rather than needing a migration.

use cosmwasm_std::{StdError, Storage};

use crate::state::{
    GameSession, OperatingSubPhase, TileColor, COMPANY_HARDWARE, PROTOCOL_OR_SUB_PHASE,
};

/// Every phase in turn order. The single source of the ordering -- callers
/// derive "what comes next" from this rather than hand-writing transitions.
pub const OR_PHASE_ORDER: &[OperatingSubPhase] = &[
    OperatingSubPhase::BuyPrivate,
    OperatingSubPhase::Track,
    OperatingSubPhase::Tokens,
    OperatingSubPhase::Routes,
    OperatingSubPhase::Dividends,
    OperatingSubPhase::Hardware,
];

/// Where a corporation's turn starts.
///
/// `Track` before Phase 3, because `BuyPrivate`'s action is locked until then
/// (see the module doc) and a phase whose only move is "skip" is a tax on
/// every turn of the early game, not a rule.
pub fn initial_sub_phase(era: TileColor) -> OperatingSubPhase {
    if era == TileColor::Yellow {
        OperatingSubPhase::Track
    } else {
        OperatingSubPhase::BuyPrivate
    }
}

/// The phase `protocol_id` is currently in.
pub fn current_sub_phase(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
    era: TileColor,
) -> Result<OperatingSubPhase, StdError> {
    Ok(PROTOCOL_OR_SUB_PHASE
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_else(|| initial_sub_phase(era)))
}

/// The phase after `phase`, or `None` if it is the last one.
pub fn next_sub_phase(phase: OperatingSubPhase) -> Option<OperatingSubPhase> {
    let index = OR_PHASE_ORDER.iter().position(|p| *p == phase)?;
    OR_PHASE_ORDER.get(index + 1).copied()
}

/// Whether `protocol_id` may skip `phase` without acting in it.
///
/// See the module doc for why `Routes` is conditional and `Dividends` is
/// absolute. The `Routes` condition is evaluated against live storage rather
/// than passed in, so no caller can get it wrong by supplying a stale answer.
pub fn may_skip(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
    phase: OperatingSubPhase,
) -> Result<bool, StdError> {
    Ok(match phase {
        OperatingSubPhase::BuyPrivate
        | OperatingSubPhase::Track
        | OperatingSubPhase::Tokens
        | OperatingSubPhase::Hardware => true,
        // A corporation holding any train must run it.
        OperatingSubPhase::Routes => !owns_any_train(storage, game_id, protocol_id)?,
        // Pay or withhold -- both legal, so "neither" never is.
        OperatingSubPhase::Dividends => false,
    })
}

/// Whether `protocol_id` currently owns at least one train.
pub fn owns_any_train(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<bool, StdError> {
    Ok(!COMPANY_HARDWARE
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default()
        .is_empty())
}

/// Moves `protocol_id` to the phase after `from`. A no-op at the last phase --
/// the turn ends by `EndOperatingRoundTurn`, not by running off the end.
pub fn advance(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
    from: OperatingSubPhase,
) -> Result<(), StdError> {
    if let Some(next) = next_sub_phase(from) {
        PROTOCOL_OR_SUB_PHASE.save(storage, (game_id, protocol_id), &next)?;
    }
    Ok(())
}

/// Clears the cursor so `protocol_id`'s NEXT turn starts at the top.
///
/// Removal rather than an explicit write: a missing entry already reads as
/// `initial_sub_phase`, and that resolution depends on the era, which may
/// have advanced by the time the corporation operates again. Writing a
/// concrete phase here would freeze today's answer into storage and start a
/// Green-era turn at `Track`, silently skipping `BuyPrivate`.
pub fn reset_for_turn(storage: &mut dyn Storage, game_id: u64, protocol_id: u32) {
    PROTOCOL_OR_SUB_PHASE.remove(storage, (game_id, protocol_id));
}

/// Clears the cursor for every corporation queued this Operating Round.
/// Called from `advance_operating_round_turn` so no stale cursor survives
/// into a later turn or round.
pub fn reset_all_for_session(storage: &mut dyn Storage, session: &GameSession) {
    for protocol_id in session.active_operating_order.iter().copied() {
        reset_for_turn(storage, session.game_id, protocol_id);
    }
}

/// The gate every sequenced action calls.
///
/// `Ok(())` when `protocol_id` is exactly on `required`. Otherwise
/// `Err((actual, required))` -- returned as a plain tuple rather than a
/// concrete error type on purpose: the six gated actions live in four
/// different modules (`hexmap`, `operations`, `trading`, `hardware`), each
/// with its own error enum, and each maps this into its own
/// `WrongOperatingSubPhase` variant. One rule, six honest error types, no new
/// cross-module error dependency.
///
/// STRICT EQUALITY, not "at or past". Being past a phase must fail just as
/// loudly as being before it -- going back to lay track after declaring
/// dividends is exactly the reordering this audit exists to stop.
#[allow(clippy::result_large_err)]
pub fn require_sub_phase(
    storage: &dyn Storage,
    session: &GameSession,
    protocol_id: u32,
    required: OperatingSubPhase,
) -> Result<(), PhaseMismatch> {
    // NO OPERATING ROUND QUEUE, NO TURN TO SEQUENCE.
    //
    // A sub-phase is a step WITHIN a corporation's Operating Round turn. If
    // the room has no `active_operating_order` it is not in an Operating Round
    // at all -- no corporation is "up", and there is no turn whose steps could
    // be out of order. Enforcing an ordering on a turn that does not exist
    // would reject actions for violating a sequence they were never part of.
    //
    // This is the SAME soft-gate precedent `trading.rs` and `hardware.rs`
    // already set for the turn-queue check itself ("only enforced once the
    // room actually has a non-empty `active_operating_order`"), applied one
    // level down for consistency.
    //
    // It does not weaken the rule in real play: `BeginOperatingRound` builds
    // the queue before any corporation can operate, so every genuine
    // Operating Round action is gated. What it spares is direct unit-level
    // calls made outside an Operating Round entirely.
    if session.active_operating_order.is_empty() {
        return Ok(());
    }

    let actual = current_sub_phase(storage, session.game_id, protocol_id, session.current_global_era)
        .map_err(|error| PhaseMismatch::Storage(error.to_string()))?;
    if actual == required {
        Ok(())
    } else {
        Err(PhaseMismatch::Wrong { actual, required })
    }
}

/// Why `require_sub_phase` refused. See its doc comment for why this is not
/// itself a `thiserror` enum wired into any module's error type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhaseMismatch {
    Wrong {
        actual: OperatingSubPhase,
        required: OperatingSubPhase,
    },
    Storage(String),
}

/// TEST ONLY: puts `protocol_id` directly on `phase`.
///
/// Exists so a test whose SUBJECT is something else -- tile legality, dividend
/// arithmetic, route scoring -- can position the cursor in one line instead of
/// dispatching four `AdvanceOperatingSubPhase` messages it does not care
/// about. The sequencing itself is covered by the dedicated tests in
/// `tests.rs`; using this in those would be circular.
#[cfg(test)]
pub fn force_sub_phase(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
    phase: OperatingSubPhase,
) {
    PROTOCOL_OR_SUB_PHASE
        .save(storage, (game_id, protocol_id), &phase)
        .expect("test-only cursor write cannot fail against mock storage");
}

/// Human-readable phase name, for error messages and response attributes.
pub fn phase_name(phase: OperatingSubPhase) -> &'static str {
    match phase {
        OperatingSubPhase::BuyPrivate => "BuyPrivate",
        OperatingSubPhase::Track => "Track",
        OperatingSubPhase::Tokens => "Tokens",
        OperatingSubPhase::Routes => "Routes",
        OperatingSubPhase::Dividends => "Dividends",
        OperatingSubPhase::Hardware => "Hardware",
    }
}

/// 1-based position of `phase` in the turn, for "step N of 6" reporting.
pub fn phase_index(phase: OperatingSubPhase) -> u8 {
    OR_PHASE_ORDER
        .iter()
        .position(|p| *p == phase)
        .map(|index| u8::try_from(index + 1).unwrap_or(u8::MAX))
        .unwrap_or(0)
}
