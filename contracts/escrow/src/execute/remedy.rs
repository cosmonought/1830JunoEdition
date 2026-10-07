//! Escrow 2.1.0 timed remedies (owner decisions of 2026-10-06): `SubmitRemedy`.
//!
//! The contract never measures an action clock. The authoritative server
//! resolves every timing race (cure vs. finality, approvals, system and
//! voluntary pauses, outages) and, only once a remedy is FINAL, the dedicated
//! REMEDY key attests it (`remedy::RemedyAttestation`, `crypto::remedy_digest`).
//! The contract checks that the attestation is well formed for this game and
//! its funded terms, final, unexpired, not stale against the game's trusted
//! sequence, and signed by an active remedy key; where the policy requires it,
//! that every non-defaulting seat approved (`crypto::remedy_approve_digest`);
//! and then moves the game to exactly one outcome:
//!
//! | remedy | mode  | strike | final_at              | approvals | outcome |
//! |--------|-------|--------|-----------------------|-----------|---------|
//! | 1 LiveTimeoutAnnul     | live  | 1, 2 | ≥ overdue_at + 600 | none | refund all, ANNULLED |
//! | 2 LiveForeclose        | live  | 1, 2 | ≥ overdue_at + 600 | N−1  | foreclosure, SETTLED |
//! | 3 LiveStrike3Foreclose | live  | 3    | overdue_at       | none   | foreclosure stored, SETTLEABLE (challenge window) |
//! | 4 AsyncAnnul           | async | 0    | ≥ overdue_at     | N−1    | refund all, ANNULLED |
//! | 5 AsyncForeclose       | async | 0    | ≥ overdue_at     | N−1    | foreclosure, SETTLED |
//!
//! Replay: every remedy needs an IN_PROGRESS game and ends that state, so an
//! attestation (or any other remedy, `Settle` or annulment) can take effect at
//! most once per game. Staleness: `2·log_len + 1` must exceed the trusted
//! sequence, so a checkpoint beyond the attested log position (play went on)
//! voids it; an attestation is also refused from its `expires_at`, which may
//! lie at most `MAX_REMEDY_TTL_SECS` (one hour) after its `attested_at`, itself
//! at or after `final_at` and at or before the block time: a final remedy that
//! did not land is attested again, never extended. Live 1/2: `final_at` is at
//! least `overdue_at + 600` (later by exactly the time a voluntary or system
//! pause froze the cure window, which the clock evidence accounts for); every
//! remedy's `overdue_at` lies at least one allowance after the game's start.
//! Approvals (owner ruling, 2026-10-07): each must have been valid when the
//! remedy became FINAL — `final_at < approve_until`, signed under the key the
//! seat held at `final_at` — and is never measured against the block time, so
//! a sealed decision survives a later approval horizon, a later key rotation,
//! an outage and a late relay (attested again with the same `final_at`), while
//! an approval that lapsed or was re-keyed at or before finality never counts.
//! Pause: no foreclosing remedy (2, 3, 5) ENTERS while the contract is paused;
//! the neutral ones (1, 4) do. (A third strike already stored keeps the 2.0.0
//! pause semantics of any stored settlement: `Finalize` and `Consent` wait,
//! the resolver and the liveness exits work.) Nothing here carries an address
//! or an amount.

use cosmwasm_std::{BankMsg, DepsMut, Env, HexBinary, MessageInfo, Response, Uint128, Uint64};

use crate::crypto::{remedy_digest, verify_settlement_signature};
use crate::error::ContractError;
use crate::helpers::{
    active_remedy_key, add_secs, game_domain, load_game, nonpayable, pay_foreclosure, refund_all,
    require_not_paused, require_state, save_game, trusted_seq, verify_remedy_approvals,
};
use crate::msg::{RemedyApproval, RemedyAttestationV1};
use crate::payload::KIND_TERMINAL;
use crate::remedy::{RemedyAttestation, REMEDY_VERSION};
use crate::state::{
    Game, GamePolicy, GameState, Mode, PayloadRecord, RemedyKind, RemedyRecord, Route,
    SettlementRecord, SettlementSource, CONFIG, MAX_REMEDY_TTL_SECS,
};

fn timing(reason: &str) -> ContractError {
    ContractError::RemedyTiming {
        reason: reason.to_string(),
    }
}

/// Everything about the attestation that depends only on the game and its
/// funded terms (no signature, no clock).
fn check_attestation_for_game(
    game: &Game,
    kind: RemedyKind,
    a: &RemedyAttestation,
) -> Result<(), ContractError> {
    if a.version != REMEDY_VERSION {
        return Err(ContractError::BadVersion { got: a.version });
    }
    if kind.mode() != game.mode {
        return Err(ContractError::RemedyNotForMode { remedy: a.remedy });
    }
    if a.domain != game_domain(game)? || a.chain_game_id != game.chain_game_id {
        return Err(ContractError::DomainMismatch {});
    }
    if usize::from(a.defaulting_seat) >= game.seats.len() {
        return Err(ContractError::SeatIndexOutOfRange {
            seat_index: a.defaulting_seat,
        });
    }
    let strike_ok = match kind {
        RemedyKind::LiveTimeoutAnnul | RemedyKind::LiveForeclose => a.strike == 1 || a.strike == 2,
        RemedyKind::LiveStrike3Foreclose => a.strike == 3,
        RemedyKind::AsyncAnnul | RemedyKind::AsyncForeclose => a.strike == 0,
    };
    if !strike_ok {
        return Err(ContractError::BadStrike {
            remedy: a.remedy,
            strike: a.strike,
        });
    }
    if a.allowance_secs != game.terms.allowance_secs || a.allowance_secs == 0 {
        return Err(ContractError::AllowanceMismatch {
            expected: game.terms.allowance_secs,
            got: a.allowance_secs,
        });
    }
    let started = game
        .started_at
        .ok_or_else(|| ContractError::Invariant {
            reason: "a started game has no start time".to_string(),
        })?
        .seconds();
    // No seat can be overdue before one whole allowance has run.
    match started.checked_add(a.allowance_secs) {
        Some(earliest) if a.overdue_at >= earliest => {}
        _ => {
            return Err(timing(
                "overdue_at precedes the end of the first allowance after the game's start",
            ))
        }
    }
    let final_ok = match kind {
        RemedyKind::LiveTimeoutAnnul | RemedyKind::LiveForeclose => a
            .overdue_at
            .checked_add(game.terms.cure_window_secs)
            .is_some_and(|earliest| a.final_at >= earliest),
        RemedyKind::LiveStrike3Foreclose => a.final_at == a.overdue_at,
        RemedyKind::AsyncAnnul | RemedyKind::AsyncForeclose => a.final_at >= a.overdue_at,
    };
    if !final_ok {
        return Err(timing(
            "final_at does not follow overdue_at as this remedy requires",
        ));
    }
    if a.attested_at < a.final_at {
        return Err(timing("attested_at precedes final_at"));
    }
    if a.expires_at <= a.attested_at {
        return Err(timing("expires_at must lie after attested_at"));
    }
    match a.attested_at.checked_add(MAX_REMEDY_TTL_SECS) {
        Some(latest) if a.expires_at <= latest => Ok(()),
        _ => Err(timing(
            "expires_at lies more than the remedy TTL after attested_at",
        )),
    }
}

/// The third-strike foreclosure as a stored settlement record (see
/// `SettlementSource::RemedyStrike3`): kind Terminal, reason 0 (no settlement
/// reason: this record is not a `SettlementPayloadV1`; `source` says so), no
/// appraisal, weight 1 per non-defaulting seat and 0 for the defaulting one.
fn strike3_payload_record(
    game: &Game,
    a: &RemedyAttestation,
    seq: u64,
    digest: &[u8; 32],
) -> Result<PayloadRecord, ContractError> {
    // The weight vector pays exactly `payout::foreclosure_split` only over
    // equal net deposits, which every started game has.
    if game
        .seats
        .iter()
        .any(|seat| seat.net_deposit != game.ante_net)
    {
        return Err(ContractError::Invariant {
            reason: "a started game's net deposits differ".to_string(),
        });
    }
    let defaulting = usize::from(a.defaulting_seat);
    Ok(PayloadRecord {
        seq: Uint64::new(seq),
        kind: KIND_TERMINAL,
        reason: 0,
        log_len: Uint64::new(a.log_len),
        log_hash: HexBinary::from(a.log_hash.as_slice()),
        appraisal_log_len: Uint64::zero(),
        appraisal_state_hash: HexBinary::from([0u8; 32].as_slice()),
        state_schema_version: 0,
        settlement_weights: (0..game.seats.len())
            .map(|i| {
                if i == defaulting {
                    Uint128::zero()
                } else {
                    Uint128::one()
                }
            })
            .collect(),
        signer_key_id: a.remedy_key_id,
        issued_at: Uint64::new(a.final_at),
        payload_digest: HexBinary::from(digest.as_slice()),
    })
}

/// Anyone may relay a FINAL remedy for an IN_PROGRESS `TimedRemedyV1` game.
///
/// Check order: funds → game → state → policy → remedy kind → pause (the
/// foreclosing kinds) → shape against the game and its terms → finality, attestation time and
/// expiry against block time → sequence → remedy key → signature → approvals
/// (each: seat range, not the defaulter, not a duplicate, `approve_until`
/// after the attested `final_at` — never the block time — and the signature
/// under the seat's key at `final_at`; then all N−1 present).
/// A refusal changes nothing.
pub fn submit_remedy(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    wire: RemedyAttestationV1,
    signature: HexBinary,
    approvals: Vec<RemedyApproval>,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::InProgress])?;
    if game.terms.policy != Some(GamePolicy::TimedRemedyV1) {
        return Err(ContractError::RemedyNotAvailable {});
    }
    let attestation = RemedyAttestation::try_from(&wire)?;
    let kind = RemedyKind::from_byte(attestation.remedy).ok_or(ContractError::BadRemedyKind {
        got: attestation.remedy,
    })?;
    if kind.forecloses() {
        require_not_paused(&CONFIG.load(deps.storage)?)?;
    }
    check_attestation_for_game(&game, kind, &attestation)?;

    let now = env.block.time;
    let now_secs = now.seconds();
    if now_secs < attestation.final_at {
        return Err(ContractError::RemedyNotFinal {
            final_at: attestation.final_at,
        });
    }
    if now_secs < attestation.attested_at {
        return Err(timing("attested_at lies after the block time"));
    }
    if now_secs >= attestation.expires_at {
        return Err(ContractError::RemedyExpired {
            expires_at: attestation.expires_at,
        });
    }
    let seq = attestation.seq()?;
    let floor = trusted_seq(deps.storage, &game)?;
    if seq <= floor {
        return Err(ContractError::StaleSeq {
            seq,
            trusted_seq: floor,
        });
    }
    let key = active_remedy_key(deps.storage, attestation.remedy_key_id)?;
    let digest = remedy_digest(&attestation.encode()?);
    verify_settlement_signature(
        deps.api,
        &digest,
        signature.as_slice(),
        key.pubkey.as_slice(),
    )?;
    let approvals_bitmap = if kind.needs_approvals() {
        verify_remedy_approvals(deps.api, deps.storage, &game, &attestation, &approvals)?
    } else if approvals.is_empty() {
        0
    } else {
        return Err(ContractError::ApprovalsNotAllowed {
            remedy: attestation.remedy,
        });
    };

    let defaulting = usize::from(attestation.defaulting_seat);
    let mut msgs: Vec<BankMsg> = Vec::new();
    match kind {
        RemedyKind::LiveTimeoutAnnul | RemedyKind::AsyncAnnul => {
            let route = if kind == RemedyKind::LiveTimeoutAnnul {
                Route::RemedyTimeoutAnnul
            } else {
                Route::RemedyAnnul
            };
            msgs.extend(refund_all(
                &mut game,
                GameState::Annulled,
                route,
                now,
                Uint128::zero(),
            )?);
        }
        RemedyKind::LiveForeclose | RemedyKind::AsyncForeclose => {
            msgs.extend(pay_foreclosure(
                &mut game,
                defaulting,
                Route::RemedyForeclosure,
                now,
            )?);
        }
        RemedyKind::LiveStrike3Foreclose => {
            let record = strike3_payload_record(&game, &attestation, seq, &digest)?;
            game.settlement = Some(SettlementRecord {
                source: SettlementSource::RemedyStrike3,
                payload: record,
                accepted_at: now,
                window_end: add_secs(now, game.terms.challenge_window_secs)?,
            });
            game.last_seq = game.last_seq.max(Uint64::new(seq));
            game.consent_bitmap = 0;
            game.state = GameState::Settleable;
        }
    }
    game.remedy = Some(RemedyRecord {
        kind,
        defaulting_seat: attestation.defaulting_seat,
        strike: attestation.strike,
        overdue_epoch: Uint64::new(attestation.overdue_epoch),
        log_len: Uint64::new(attestation.log_len),
        log_hash: HexBinary::from(attestation.log_hash.as_slice()),
        allowance_secs: Uint64::new(attestation.allowance_secs),
        overdue_at: Uint64::new(attestation.overdue_at),
        final_at: Uint64::new(attestation.final_at),
        attested_at: Uint64::new(attestation.attested_at),
        expires_at: Uint64::new(attestation.expires_at),
        evidence_hash: HexBinary::from(attestation.evidence_hash.as_slice()),
        remedy_key_id: attestation.remedy_key_id,
        remedy_digest: HexBinary::from(digest.as_slice()),
        approvals_bitmap,
        accepted_at: now,
    });
    save_game(deps.storage, &game)?;
    let mode = match game.mode {
        Mode::Live => "live",
        Mode::Async => "async",
    };
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "submit_remedy")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("mode", mode)
        .add_attribute("remedy", kind.as_str())
        .add_attribute("defaulting_seat", attestation.defaulting_seat.to_string())
        .add_attribute("strike", attestation.strike.to_string())
        .add_attribute("overdue_epoch", attestation.overdue_epoch.to_string())
        .add_attribute("remedy_key_id", attestation.remedy_key_id.to_string())
        .add_attribute("remedy_digest", HexBinary::from(digest.as_slice()).to_hex())
        .add_attribute("approvals_bitmap", approvals_bitmap.to_string())
        .add_attribute("state", game.state.as_str()))
}
