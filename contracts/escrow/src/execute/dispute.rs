//! Disputes and exits: Challenge, Resolve, AnnulByConsent, LivenessSettle, and
//! the escrow 2.1.0 exceptional review (RequestReview, ReviewAnnul).

use cosmwasm_std::{
    BankMsg, DepsMut, Env, HexBinary, MessageInfo, Response, Storage, Timestamp, Uint128, Uint64,
};

use crate::crypto::{annul_digest, settle_digest};
use crate::error::ContractError;
use crate::execute::play::{accept_signed_payload, store_checkpoint};
use crate::helpers::{
    add_secs, best_checkpoint, check_payload_for_game, game_domain, key_is_trusted, load_game,
    nonpayable, pay_out, payload_record, refund_all, require_seated, require_state, save_game,
    seat_index_of, send, trusted_checkpoint_seq, trusted_seq, verify_seat_signatures,
};
use crate::msg::{ResolveOutcome, SeatSignature, SignedCheckpoint};
use crate::payload::{fixed_bytes, Payload, PayloadUse};
use crate::state::{
    DisputeRecord, DisputeResolution, Game, GamePolicy, GameState, ReviewRequest, Route,
    SettlementRecord, SettlementSource,
};

/// A seated wallet challenges the stored settlement before the window closes,
/// with exactly the game's bond (no funds at all when the bond is zero).
/// Works while paused.
pub fn challenge(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    evidence_hash: HexBinary,
) -> Result<Response, ContractError> {
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::Settleable])?;
    require_seated(&game, &info.sender)?;
    let window_end = game
        .settlement
        .as_ref()
        .map(|s| s.window_end)
        .ok_or_else(|| ContractError::Invariant {
            reason: "no stored settlement".to_string(),
        })?;
    let now = env.block.time;
    if now >= window_end {
        return Err(ContractError::WindowClosed { closed: window_end });
    }
    fixed_bytes::<32>("evidence_hash", &evidence_hash)?;
    let bond = game.bond.ok_or_else(|| ContractError::Invariant {
        reason: "no frozen bond".to_string(),
    })?;
    if bond.is_zero() {
        nonpayable(&info)?;
    } else {
        let paid = match info.funds.as_slice() {
            [coin] if coin.denom == game.denom => coin.amount,
            [] => Uint128::zero(),
            _ => {
                return Err(ContractError::InvalidFunds {
                    denom: game.denom.clone(),
                })
            }
        };
        if paid != bond {
            return Err(ContractError::WrongBond {
                expected: bond,
                got: paid,
            });
        }
    }
    game.dispute = Some(DisputeRecord {
        challenger: info.sender.clone(),
        bond,
        evidence_hash,
        disputed_at: now,
        resolution: None,
        resolved_at: None,
    });
    game.state = GameState::Disputed;
    save_game(deps.storage, &game)?;
    Ok(Response::new()
        .add_attribute("action", "challenge")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("challenger", info.sender.as_str())
        .add_attribute("bond", bond)
        .add_attribute("state", game.state.as_str()))
}

/// Marks the dispute resolved and returns the bond message to the challenger
/// (or nothing when the bond is zero or goes to the pool).
fn close_dispute(
    game: &mut Game,
    resolution: DisputeResolution,
    now: Timestamp,
    return_bond: bool,
) -> Result<(Uint128, Option<BankMsg>), ContractError> {
    let denom = game.denom.clone();
    let dispute = game
        .dispute
        .as_mut()
        .ok_or_else(|| ContractError::Invariant {
            reason: "no dispute record".to_string(),
        })?;
    dispute.resolution = Some(resolution);
    dispute.resolved_at = Some(now);
    let bond = dispute.bond;
    let msg = if return_bond {
        send(&dispute.challenger, bond, &denom)
    } else {
        None
    };
    Ok((bond, msg))
}

fn stored_weights(game: &Game) -> Result<Vec<Uint128>, ContractError> {
    game.settlement
        .as_ref()
        .map(|s| s.payload.settlement_weights.clone())
        .ok_or_else(|| ContractError::Invariant {
            reason: "no stored settlement".to_string(),
        })
}

/// The game's resolver — the address it adopted at `Start`, not the current
/// `CONFIG.resolver` (OD-ESC2-5) — adjudicates a disputed game. Not blocked by
/// pause (the frozen transition table gives `Resolve` no pause prerequisite).
pub fn resolve(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    outcome: ResolveOutcome,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::Disputed])?;
    let resolver = game
        .resolver
        .as_ref()
        .ok_or_else(|| ContractError::Invariant {
            reason: "a started game has no resolver".to_string(),
        })?;
    if info.sender != *resolver {
        return Err(ContractError::Unauthorized {
            role: "resolver".to_string(),
        });
    }
    let now = env.block.time;
    let mut msgs: Vec<BankMsg> = Vec::new();
    let label = match outcome {
        ResolveOutcome::Uphold {} => {
            // The bond joins the pool, then the pool is paid by the stored vector.
            let (bond, _) = close_dispute(&mut game, DisputeResolution::Upheld, now, false)?;
            let weights = stored_weights(&game)?;
            let pool = game.pool.checked_add(bond)?;
            msgs.extend(pay_out(
                &mut game,
                &weights,
                pool,
                Route::ResolverUphold,
                now,
                Uint128::zero(),
                bond,
            )?);
            "uphold"
        }
        ResolveOutcome::Replace { payload: wire } => {
            // Authorised by this transaction's sender, not by a signature: the
            // settlement signer may be the party that cheated. The disputed
            // settlement never constrains its correction (the same log position
            // is legal, and a compromised signer's seq has no authority); the
            // correction must only lie beyond the latest trusted checkpoint.
            let payload = Payload::try_from(&wire)?;
            let floor = trusted_checkpoint_seq(deps.storage, chain_game_id)?;
            check_payload_for_game(&game, &payload, PayloadUse::ResolverReplace, floor)?;
            let digest = settle_digest(&payload.encode()?);
            let record = payload_record(&payload, &digest);
            let weights = record.settlement_weights.clone();
            game.settlement = Some(SettlementRecord {
                source: SettlementSource::ResolverReplacement,
                payload: record,
                accepted_at: now,
                window_end: now,
            });
            game.last_seq = game.last_seq.max(Uint64::new(payload.seq));
            game.consent_bitmap = 0;
            let (bond, bond_msg) =
                close_dispute(&mut game, DisputeResolution::Replaced, now, true)?;
            msgs.extend(bond_msg);
            let pool = game.pool;
            msgs.extend(pay_out(
                &mut game,
                &weights,
                pool,
                Route::ResolverReplace,
                now,
                bond,
                Uint128::zero(),
            )?);
            "replace"
        }
        ResolveOutcome::Annul {} => {
            let (bond, bond_msg) =
                close_dispute(&mut game, DisputeResolution::Annulled, now, true)?;
            msgs.extend(bond_msg);
            msgs.extend(refund_all(
                &mut game,
                GameState::Annulled,
                Route::ResolverAnnul,
                now,
                bond,
            )?);
            "annul"
        }
    };
    save_game(deps.storage, &game)?;
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "resolve")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("outcome", label)
        .add_attribute("state", game.state.as_str()))
}

/// Every seat signs the ANNUL digest over (domain, trusted_seq): the game's
/// current sequence authority, so a newer trusted checkpoint voids older annul
/// signatures while a compromised signer's seq never enters the digest. Anyone
/// may submit it while IN_PROGRESS or SETTLEABLE; works while paused. Net antes
/// refunded.
pub fn annul_by_consent(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    consents: Vec<SeatSignature>,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::InProgress, GameState::Settleable])?;
    let digest = annul_digest(&game_domain(&game)?, trusted_seq(deps.storage, &game)?);
    verify_seat_signatures(deps.api, &game, &digest, &consents, true)?;
    let now = env.block.time;
    let msgs = refund_all(
        &mut game,
        GameState::Annulled,
        Route::AnnulByConsent,
        now,
        Uint128::zero(),
    )?;
    save_game(deps.storage, &game)?;
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "annul_by_consent")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("state", game.state.as_str()))
}

/// Moves the game to SETTLEABLE on the best usable checkpoint, or refunds
/// everyone (CANCELLED) when there is none. `bond_returned` is recorded in the
/// outcome when the refund happens.
///
/// Escrow 2.1.0: a game with a policy never pays from a round-boundary
/// checkpoint's standings, so it always takes the refund, whatever checkpoints
/// it holds. Only a 2.0.0 game (`terms.policy == None`) promotes one.
fn settle_on_checkpoint_or_refund(
    storage: &dyn Storage,
    game: &mut Game,
    now: Timestamp,
    refund_route: Route,
    bond_returned: Uint128,
) -> Result<(Vec<BankMsg>, &'static str), ContractError> {
    let candidate = if game.terms.policy.is_some() {
        None
    } else {
        best_checkpoint(storage, game.chain_game_id, true)?
    };
    match candidate {
        Some(checkpoint) => {
            game.settlement = Some(SettlementRecord {
                source: SettlementSource::LivenessCheckpoint,
                payload: checkpoint.payload,
                accepted_at: now,
                window_end: add_secs(now, game.terms.challenge_window_secs)?,
            });
            game.consent_bitmap = 0;
            game.state = GameState::Settleable;
            Ok((Vec::new(), "checkpoint"))
        }
        None => {
            let msgs = refund_all(game, GameState::Cancelled, refund_route, now, bond_returned)?;
            Ok((msgs, "refund"))
        }
    }
}

/// The liveness exit, for any seated wallet. It works while paused: a pause may
/// delay normal operation but never trap a settled result (OD-ESC2-1).
///
/// * IN_PROGRESS, escrow 2.0.0 games only (`terms.policy == None`), once
///   `max(started_at, last_activity) + liveness_window` has passed: SETTLEABLE
///   on the highest-seq checkpoint whose signer key is not compromised (a fresh
///   challenge window applies), or CANCELLED with every net ante refunded when
///   there is none. An optional newer `checkpoint` is validated exactly like
///   `Checkpoint` and promoted in the same transaction (OD-ESC2-4); eligibility
///   is decided before it is processed, and it does not restart the liveness
///   clock. A 2.1.0 game refuses the whole message while IN_PROGRESS
///   (`LivenessExitRemoved`), whatever the time, the pause or a carried
///   checkpoint: on chain, inactivity is not an action clock, and a stalled
///   game is never paid by standings.
/// * SETTLEABLE, once `window_end + liveness_window` has passed: the stored
///   settlement is paid, unless its signer key is compromised, in which case the
///   game falls back to the best usable checkpoint (SETTLEABLE again, consents
///   reset, fresh window) or refunds everyone (CANCELLED).
/// * DISPUTED, once `disputed_at + resolver_timeout` has passed: nobody
///   adjudicated, so the challenger's bond is returned and the stored settlement
///   is paid as if upheld, unless its signer key was retired as compromised, in
///   which case the game falls back as above (checkpoint or refund).
///
/// In both fallbacks a 2.1.0 game refunds every net deposit instead of
/// promoting a checkpoint (`settle_on_checkpoint_or_refund`).
pub fn liveness_settle(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    checkpoint: Option<SignedCheckpoint>,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(
        &game,
        &[
            GameState::InProgress,
            GameState::Settleable,
            GameState::Disputed,
        ],
    )?;
    require_seated(&game, &info.sender)?;
    if checkpoint.is_some() {
        // A checkpoint is only accepted where an ordinary Checkpoint would be.
        require_state(&game, &[GameState::InProgress])?;
    }
    let now = env.block.time;
    let mut msgs: Vec<BankMsg> = Vec::new();
    let mut supplied_seq: Option<u64> = None;
    let path: &'static str = match game.state {
        GameState::InProgress => {
            // Escrow 2.1.0: no in-progress inactivity exit. Checked before the
            // clock and before any carried checkpoint, so the refusal moves
            // nothing and stores nothing.
            if game.terms.policy.is_some() {
                return Err(ContractError::LivenessExitRemoved {});
            }
            // Eligibility is decided on the game as it stood before any
            // supplied checkpoint is processed.
            let started = game.started_at.ok_or_else(|| ContractError::Invariant {
                reason: "no start time".to_string(),
            })?;
            let active = game.last_activity.unwrap_or(started);
            let reference = if active > started { active } else { started };
            let available = add_secs(reference, game.terms.liveness_window_secs)?;
            if now < available {
                return Err(ContractError::LivenessNotReached { at: available });
            }
            if let Some(signed) = checkpoint {
                let (payload, digest) = accept_signed_payload(
                    deps.as_ref(),
                    &game,
                    &signed.payload,
                    &signed.signature,
                    PayloadUse::Checkpoint,
                )?;
                // Promoted without refreshing `last_activity`: the eligibility
                // proven above must not be cancelled by the evidence it carries.
                store_checkpoint(deps.storage, &mut game, &payload, &digest, now)?;
                supplied_seq = Some(payload.seq);
            }
            let (refund, label) = settle_on_checkpoint_or_refund(
                deps.storage,
                &mut game,
                now,
                Route::LivenessRefund,
                Uint128::zero(),
            )?;
            msgs.extend(refund);
            label
        }
        GameState::Settleable => {
            let (window_end, settlement_key) = game
                .settlement
                .as_ref()
                .map(|s| (s.window_end, s.payload.signer_key_id))
                .ok_or_else(|| ContractError::Invariant {
                    reason: "no stored settlement".to_string(),
                })?;
            let available = add_secs(window_end, game.terms.liveness_window_secs)?;
            if now < available {
                return Err(ContractError::LivenessNotReached { at: available });
            }
            if key_is_trusted(deps.storage, settlement_key)? {
                let weights = stored_weights(&game)?;
                let pool = game.pool;
                msgs.extend(pay_out(
                    &mut game,
                    &weights,
                    pool,
                    Route::SettleableTimeoutPayout,
                    now,
                    Uint128::zero(),
                    Uint128::zero(),
                )?);
                "settleable_timeout_payout"
            } else {
                let (refund, label) = settle_on_checkpoint_or_refund(
                    deps.storage,
                    &mut game,
                    now,
                    Route::SettleableTimeoutRefund,
                    Uint128::zero(),
                )?;
                msgs.extend(refund);
                if label == "refund" {
                    "settleable_timeout_refund"
                } else {
                    "settleable_timeout_checkpoint"
                }
            }
        }
        _ => {
            let disputed_at = game
                .dispute
                .as_ref()
                .map(|d| d.disputed_at)
                .ok_or_else(|| ContractError::Invariant {
                    reason: "no dispute record".to_string(),
                })?;
            let available = add_secs(disputed_at, game.terms.resolver_timeout_secs)?;
            if now < available {
                return Err(ContractError::ResolverTimeoutNotReached { at: available });
            }
            let (bond, bond_msg) =
                close_dispute(&mut game, DisputeResolution::ResolverTimeout, now, true)?;
            msgs.extend(bond_msg);
            let settlement_key = game
                .settlement
                .as_ref()
                .map(|s| s.payload.signer_key_id)
                .ok_or_else(|| ContractError::Invariant {
                    reason: "no stored settlement".to_string(),
                })?;
            if key_is_trusted(deps.storage, settlement_key)? {
                let weights = stored_weights(&game)?;
                let pool = game.pool;
                msgs.extend(pay_out(
                    &mut game,
                    &weights,
                    pool,
                    Route::ResolverTimeoutPayout,
                    now,
                    bond,
                    Uint128::zero(),
                )?);
                "resolver_timeout_payout"
            } else {
                let (refund, label) = settle_on_checkpoint_or_refund(
                    deps.storage,
                    &mut game,
                    now,
                    Route::ResolverTimeoutRefund,
                    bond,
                )?;
                msgs.extend(refund);
                if label == "refund" {
                    "resolver_timeout_refund"
                } else {
                    "resolver_timeout_checkpoint"
                }
            }
        }
    };
    save_game(deps.storage, &game)?;
    let mut response = Response::new()
        .add_messages(msgs)
        .add_attribute("action", "liveness_settle")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("path", path);
    if let Some(seq) = supplied_seq {
        response = response.add_attribute("supplied_checkpoint_seq", seq.to_string());
    }
    Ok(response.add_attribute("state", game.state.as_str()))
}

/// The game is an escrow 2.1.0 No-deadline game: the only kind the exceptional
/// review applies to.
fn require_no_deadline(game: &Game) -> Result<(), ContractError> {
    if game.terms.policy == Some(GamePolicy::NoDeadline) {
        Ok(())
    } else {
        Err(ContractError::ReviewNotAvailable {})
    }
}

/// Escrow 2.1.0: a seated wallet of an IN_PROGRESS No-deadline game asks the
/// game's resolver for the exceptional review. Records the first request only;
/// a later request (by any seat) is accepted and changes nothing. An accepted
/// `Checkpoint` withdraws the request (the table kept playing), after which a
/// new request starts a new delay. Moves no funds and works while paused. The evidence itself (death, explicit
/// permanent abandonment, lost access) is off chain; the request only proves
/// that a seated player asked, so the resolver cannot annul a game nobody
/// asked about.
pub fn request_review(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::InProgress])?;
    let seat = require_seated(&game, &info.sender)?;
    require_no_deadline(&game)?;
    let already = game.review_request.is_some();
    if !already {
        game.review_request = Some(ReviewRequest {
            seat_index: u8::try_from(seat).map_err(|_| ContractError::Overflow {})?,
            requested_at: env.block.time,
        });
        save_game(deps.storage, &game)?;
    }
    Ok(Response::new()
        .add_attribute("action", "request_review")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("chain_seat_index", seat.to_string())
        .add_attribute("already_requested", already.to_string())
        .add_attribute("state", game.state.as_str()))
}

/// Escrow 2.1.0: the game's resolver (the address it adopted at `Start`,
/// whatever `SetResolver` did since, OD-ESC2-5) approves the review of an
/// IN_PROGRESS No-deadline game that a seated wallet asked for, once the
/// game's review delay has passed since that request. The only outcome is the
/// neutral refund: every seat's own net deposit back to its own deposit
/// wallet, nothing to the resolver, the treasury or a "winner" (the message
/// carries no payload and no amounts). Works while paused. Refused when the
/// resolver holds a seat in the game (it could otherwise request and approve
/// its own exit). A finished game (SETTLEABLE and later) is never reviewable:
/// its result stands or is disputed through `Challenge` / `Resolve`. Denying a
/// review is simply not sending this message: the funds stay escrowed.
///
/// Check order: state → role → resolver not seated → policy → request → delay.
pub fn review_annul(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::InProgress])?;
    let resolver = game
        .resolver
        .as_ref()
        .ok_or_else(|| ContractError::Invariant {
            reason: "a started game has no resolver".to_string(),
        })?;
    if info.sender != *resolver {
        return Err(ContractError::Unauthorized {
            role: "resolver".to_string(),
        });
    }
    if seat_index_of(&game, resolver).is_some() {
        return Err(ContractError::ResolverIsSeated {});
    }
    require_no_deadline(&game)?;
    let requested_at = game
        .review_request
        .as_ref()
        .map(|r| r.requested_at)
        .ok_or(ContractError::ReviewNotRequested { chain_game_id })?;
    let available = add_secs(requested_at, game.terms.review_delay_secs)?;
    if env.block.time < available {
        return Err(ContractError::ReviewDelayNotElapsed { at: available });
    }
    let msgs = refund_all(
        &mut game,
        GameState::Annulled,
        Route::ReviewAnnul,
        env.block.time,
        Uint128::zero(),
    )?;
    save_game(deps.storage, &game)?;
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "review_annul")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("state", game.state.as_str()))
}
