//! Escrow 2.1.0 timed remedies (owner decisions of 2026-10-06): the dedicated
//! REMEDY key, `SubmitRemedy`, the Live 20/30 model, the challengeable third
//! strike, the Timed Async N−1 remedies, the universal unanimous annulment and
//! the remedy key registry.
//!
//! Adversarial focus: a remedy executes only on the exact game, policy, seat,
//! strike, epoch, log position, allowance, finality and freshness its REMEDY
//! key attested, with every non-defaulting seat's approval where required and
//! never the defaulter's; no signature made for another purpose verifies; it
//! executes at most once; a foreclosure is never manufactured by a pause; the
//! money is exactly the neutral refund or the foreclosure split, with no
//! address and no amount supplied by anyone.

mod common;

use common::*;
use cosmwasm_std::{coins, HexBinary, Uint128, Uint64};
use cw_multi_test::Executor;
use eighteen_cosmos_escrow::crypto;
use eighteen_cosmos_escrow::msg::{
    ExecuteMsg, QueryMsg, RemedyApproval, RemedyAttestationV1, RemedyKeyResponse,
    RemedyKeysResponse, ResolveOutcome, SeatSignature,
};

/// One seat's REMEDY-APPROVE for `a` under an explicit consent `key`.
fn approval_by(a: &RemedyAttestation, seat: u8, key: &Key, until: u64) -> RemedyApproval {
    RemedyApproval {
        seat_index: seat,
        approve_until: Uint64::new(until),
        signature: key.sign(&crypto::remedy_approve_digest(
            &a.domain,
            a.chain_game_id,
            a.remedy,
            a.defaulting_seat,
            a.strike,
            a.overdue_epoch,
            a.log_len,
            &a.log_hash,
            a.overdue_at,
            until,
            seat,
        )),
    }
}
use eighteen_cosmos_escrow::remedy::RemedyAttestation;
use eighteen_cosmos_escrow::state::{
    DisputeResolution, GameState, Mode, RemedyKind, Route, SettlementSource, ASYNC_PACES_SECS,
    LIVE_ACTION_SECS, LIVE_CURE_WINDOW_SECS, MAX_REMEDY_TTL_SECS,
};
use eighteen_cosmos_escrow::ContractError;

const LIVE_KINDS: [RemedyKind; 3] = [
    RemedyKind::LiveTimeoutAnnul,
    RemedyKind::LiveForeclose,
    RemedyKind::LiveStrike3Foreclose,
];
const ASYNC_KINDS: [RemedyKind; 2] = [RemedyKind::AsyncAnnul, RemedyKind::AsyncForeclose];

/// An IN_PROGRESS Live game with `n` seats that has run for an hour.
fn live(s: &mut Suite, n: usize) -> u64 {
    let id = s.started_with(n, Mode::Live, ANTE);
    s.advance(HOUR);
    id
}

/// An IN_PROGRESS Timed Async game with `n` seats and the given pace, past
/// one full allowance.
fn timed_async(s: &mut Suite, n: usize, pace: u64) -> u64 {
    s.async_pace = pace;
    let id = s.started_with(n, Mode::Async, ANTE);
    s.async_pace = DAY;
    s.advance(pace + HOUR);
    id
}

fn no_deadline(s: &mut Suite, n: usize) -> u64 {
    s.no_deadline = true;
    let id = s.started(n);
    s.no_deadline = false;
    s.advance(HOUR);
    id
}

/// `SubmitRemedy` for `a` signed by `key` with explicit approvals.
fn msg_with(
    s: &Suite,
    a: &RemedyAttestation,
    key: &Key,
    approvals: Vec<RemedyApproval>,
) -> ExecuteMsg {
    s.remedy_msg_by(a, key, approvals)
}

/// The CONSENT digest for a game's stored settlement.
fn stored_consent_digest(s: &Suite, id: u64) -> [u8; 32] {
    let st = s.game(id).game.settlement.unwrap();
    crypto::consent_digest(
        &s.domain(id),
        st.payload.seq.u64(),
        &st.payload.payload_digest.as_slice().try_into().unwrap(),
    )
}

/// A refusal changes nothing: game, checkpoints, balances.
fn refused(s: &mut Suite, msg: &ExecuteMsg) -> ContractError {
    let id = match msg {
        ExecuteMsg::SubmitRemedy { chain_game_id, .. } => *chain_game_id,
        _ => unreachable!(),
    };
    let game = s.game(id).game;
    let balance = s.contract_balance();
    let treasury = s.balance(&s.treasury.clone());
    let err = s.submit(msg).unwrap_err();
    assert_eq!(s.game(id).game, game, "a refused remedy changed the game");
    assert_eq!(s.contract_balance(), balance);
    assert_eq!(s.balance(&s.treasury.clone()), treasury);
    err
}

fn sends_to(res: &cw_multi_test::AppResponse, who: &cosmwasm_std::Addr) -> u128 {
    bank_sends(res)
        .iter()
        .filter(|(to, _)| to == who.as_str())
        .map(|(_, a)| *a)
        .sum()
}

// =========================================================== remedy signatures

/// Only the REMEDY key signs a remedy: a settlement signer, the admission key,
/// a seat's consent key, an unregistered key or a high-s form of the right
/// signature all fail, and change nothing.
#[test]
fn only_the_registered_remedy_key_signs_a_remedy() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let a = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 0);
    for key in [
        Key::signer(1),
        Key::admission(1),
        Key::seat(0),
        Key::seat(2),
        Key::remedy(2),
        Key::from_label("18JUNO/TEST/stranger"),
    ] {
        let msg = msg_with(&s, &a, &key, vec![]);
        assert_eq!(refused(&mut s, &msg), ContractError::InvalidSignature {});
    }
    let digest = Suite::remedy_digest(&a);
    let mut msg = s.remedy_msg(&a);
    if let ExecuteMsg::SubmitRemedy { signature, .. } = &mut msg {
        *signature = s.remedy.sign_high_s(&digest);
    }
    assert_eq!(refused(&mut s, &msg), ContractError::HighS {});
    if let ExecuteMsg::SubmitRemedy { signature, .. } = &mut msg {
        *signature = HexBinary::from(vec![1u8; 63]);
    }
    assert_eq!(
        refused(&mut s, &msg),
        ContractError::BadSignatureLength { got: 63 }
    );
    let msg = s.remedy_msg(&a);
    s.submit(&msg).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
}

/// Domain separation: the remedy key's signature over any other digest (a
/// SETTLE, CONSENT, ANNUL, JOIN or REMEDY-APPROVE digest, or the raw encoding)
/// never verifies as a remedy, and a seat's REMEDY-APPROVE signature never
/// verifies as an ANNUL or CONSENT signature.
#[test]
fn no_signature_made_for_another_purpose_verifies() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    let encoded = a.encode().unwrap();
    let domain = s.domain(id);
    let mut wrong_purpose: Vec<[u8; 32]> = vec![
        crypto::settle_digest(&encoded),
        crypto::consent_digest(&domain, 1, &Suite::remedy_digest(&a)),
        crypto::annul_digest(&domain, 0),
        crypto::remedy_approve_digest(
            &domain,
            id,
            2,
            2,
            1,
            1,
            0,
            &a.log_hash,
            a.overdue_at,
            u64::MAX,
            0,
        ),
        sha256(&[&encoded]),
        sha256(&[b"18JUNO/REMEDY/v2", &encoded]),
    ];
    wrong_purpose.push(
        crypto::join_admission_digest("juno-1", s.contract.as_str(), id, "x", &[0; 32], 9).unwrap(),
    );
    let approvals = s.approvals(&a, &[0, 1]);
    for digest in wrong_purpose {
        let msg = ExecuteMsg::SubmitRemedy {
            chain_game_id: id,
            attestation: RemedyAttestationV1::from(&a),
            signature: s.remedy.sign(&digest),
            approvals: approvals.clone(),
        };
        assert_eq!(refused(&mut s, &msg), ContractError::InvalidSignature {});
    }
    // A seat's remedy approval is not an annul (or consent) signature.
    let as_annul: Vec<SeatSignature> = s
        .approvals(&a, &[0, 1, 2])
        .into_iter()
        .map(|x| SeatSignature {
            seat_index: x.seat_index,
            signature: x.signature,
        })
        .collect();
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents: as_annul,
            },
            &[]
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    // And an annul signature is not an approval.
    let until = Uint64::new(s.now().seconds() + DAY);
    let annul = s
        .annul_sigs(id, &[0, 1], 0)
        .into_iter()
        .map(|x| RemedyApproval {
            seat_index: x.seat_index,
            approve_until: until,
            signature: x.signature,
        })
        .collect();
    let msg = msg_with(&s, &a, &s.remedy.clone(), annul);
    assert_eq!(
        refused(&mut s, &msg),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    let msg = s.remedy_msg(&a);
    s.submit(&msg).unwrap();
}

/// Every attested field is bound: changing any one of them after signing
/// (seat, remedy, strike, epoch, log position, log hash, allowance, times,
/// expiry, evidence hash, key id) invalidates the signature, or is refused
/// by the rule it breaks before the signature is even checked.
#[test]
fn every_attested_field_is_bound_by_the_signature() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let base = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 5);
    let signature = s.remedy.sign(&Suite::remedy_digest(&base));
    type Mutate = fn(&mut RemedyAttestation);
    let cases: Vec<(&str, Mutate, ContractError)> = vec![
        (
            "seat",
            |a| a.defaulting_seat = 1,
            ContractError::InvalidSignature {},
        ),
        (
            "strike",
            |a| a.strike = 2,
            ContractError::InvalidSignature {},
        ),
        (
            "epoch",
            |a| a.overdue_epoch += 1,
            ContractError::InvalidSignature {},
        ),
        (
            "log_len",
            |a| a.log_len += 1,
            ContractError::InvalidSignature {},
        ),
        (
            "log_hash",
            |a| a.log_hash[0] ^= 1,
            ContractError::InvalidSignature {},
        ),
        (
            "evidence (stale clock evidence)",
            |a| a.evidence_hash[31] ^= 1,
            ContractError::InvalidSignature {},
        ),
        (
            "expires_at",
            |a| a.expires_at -= 1,
            ContractError::InvalidSignature {},
        ),
        (
            "both times",
            |a| {
                a.overdue_at -= 1;
                a.final_at -= 1;
            },
            ContractError::InvalidSignature {},
        ),
        (
            "remedy",
            |a| a.remedy = 2,
            // A foreclosure needs approvals; with none the signature fails
            // first (it is checked before the approvals).
            ContractError::InvalidSignature {},
        ),
        (
            "key id",
            |a| a.remedy_key_id = 2,
            ContractError::UnknownRemedyKey { key_id: 2 },
        ),
    ];
    for (name, mutate, expected) in cases {
        let mut a = base.clone();
        mutate(&mut a);
        let msg = ExecuteMsg::SubmitRemedy {
            chain_game_id: id,
            attestation: RemedyAttestationV1::from(&a),
            signature: signature.clone(),
            approvals: vec![],
        };
        assert_eq!(refused(&mut s, &msg), expected, "{name}");
    }
    let msg = ExecuteMsg::SubmitRemedy {
        chain_game_id: id,
        attestation: RemedyAttestationV1::from(&base),
        signature,
        approvals: vec![],
    };
    s.submit(&msg).unwrap();
}

/// An attestation names exactly one game of one contract on one chain: it is
/// refused by every other game (same roster, same id on another instance,
/// same domain under another id), and its approvals never transfer.
#[test]
fn a_remedy_for_one_game_is_refused_by_every_other() {
    let mut s = Suite::new();
    let a_id = live(&mut s, 3);
    let b_id = live(&mut s, 3);
    let a = s.attestation(a_id, RemedyKind::LiveForeclose, 2, 0);
    let msg = s.remedy_msg(&a);
    // Replayed to game B (same roster, same terms): domain mismatch.
    let replay = match msg.clone() {
        ExecuteMsg::SubmitRemedy {
            attestation,
            signature,
            approvals,
            ..
        } => ExecuteMsg::SubmitRemedy {
            chain_game_id: b_id,
            attestation,
            signature,
            approvals,
        },
        _ => unreachable!(),
    };
    assert_eq!(refused(&mut s, &replay), ContractError::DomainMismatch {});
    // A's attestation re-signed with B's id but A's domain: still refused.
    let mut mixed = a.clone();
    mixed.chain_game_id = b_id;
    let m = s.remedy_msg(&mixed);
    assert_eq!(refused(&mut s, &m), ContractError::DomainMismatch {});
    // B's attestation with A's approvals: the approvals bind B's domain.
    let b = s.attestation(b_id, RemedyKind::LiveForeclose, 2, 0);
    let foreign = s.approvals(&a, &[0, 1]);
    let m = msg_with(&s, &b, &s.remedy.clone(), foreign);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    s.submit(&msg).unwrap();
    assert_eq!(s.state(a_id), GameState::Settled);
    assert_eq!(s.state(b_id), GameState::InProgress);
    s.assert_custody();
}

/// A second instance of the contract on the same chain (another address,
/// another domain) refuses the first instance's remedies.
#[test]
fn a_remedy_is_refused_by_another_contract_instance() {
    let mut s = Suite::new();
    let id = live(&mut s, 2);
    let a = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 1, 0);
    let msg = s.remedy_msg(&a);
    let admin = s.admin.clone();
    let other = s
        .app
        .instantiate_contract(
            s.code_id,
            admin.clone(),
            &eighteen_cosmos_escrow::msg::InstantiateMsg {
                admin: admin.to_string(),
                operator: s.operator.to_string(),
                resolver: s.resolver.to_string(),
                treasury: s.treasury.to_string(),
                denom: DENOM.to_string(),
                params: default_params(),
                signer_keys: vec![Key::signer(1).pubkey],
                admission_pubkey: Key::admission(1).pubkey,
                remedy_keys: vec![Key::remedy(1).pubkey],
            },
            &[],
            "escrow-2",
            None,
        )
        .unwrap();
    let original = std::mem::replace(&mut s.contract, other);
    let twin = s.started_with(2, Mode::Live, ANTE);
    assert_eq!(twin, id);
    assert_eq!(
        s.submit(&msg).unwrap_err(),
        ContractError::DomainMismatch {}
    );
    s.contract = original;
    s.submit(&msg).unwrap();
}

/// Replay: an executed remedy, or any other remedy, cannot execute again.
#[test]
fn a_remedy_executes_at_most_once() {
    for kind in [
        RemedyKind::LiveTimeoutAnnul,
        RemedyKind::LiveForeclose,
        RemedyKind::LiveStrike3Foreclose,
    ] {
        let mut s = Suite::new();
        let id = live(&mut s, 3);
        let a = s.attestation(id, kind, 2, 0);
        let msg = s.remedy_msg(&a);
        s.submit(&msg).unwrap();
        let state = s.state(id);
        assert!(matches!(
            refused(&mut s, &msg),
            ContractError::WrongState { .. }
        ));
        // Any other remedy (another seat, another kind, a later epoch) too.
        for other in LIVE_KINDS {
            let mut b = s.attestation(id, other, 0, 0);
            b.overdue_epoch = 9;
            let m = s.remedy_msg(&b);
            assert!(matches!(
                refused(&mut s, &m),
                ContractError::WrongState { .. }
            ));
        }
        assert_eq!(s.state(id), state);
        s.assert_custody();
    }
}

/// Freshness: refused from `expires_at` on, refused before `final_at`, and
/// `expires_at` may lie at most `MAX_REMEDY_TTL_SECS` after `attested_at`.
#[test]
fn expiry_and_ttl_are_enforced() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let mut a = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 0);
    a.expires_at = a.attested_at + 60;
    let msg = s.remedy_msg(&a);
    s.advance(59);
    // Still valid one second before expiry.
    let probe = s.game(id).game;
    s.advance(1);
    assert_eq!(
        refused(&mut s, &msg),
        ContractError::RemedyExpired {
            expires_at: a.expires_at
        }
    );
    assert_eq!(s.game(id).game, probe);
    // A TTL beyond the cap is refused even while unexpired.
    let mut b = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 0);
    b.expires_at = b.attested_at + MAX_REMEDY_TTL_SECS + 1;
    let m = s.remedy_msg(&b);
    assert!(matches!(
        refused(&mut s, &m),
        ContractError::RemedyTiming { .. }
    ));
    // expires_at must lie after attested_at.
    let mut c = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 0);
    c.expires_at = c.attested_at;
    let m = s.remedy_msg(&c);
    assert!(matches!(
        refused(&mut s, &m),
        ContractError::RemedyTiming { .. }
    ));
    // Exactly at the cap is accepted.
    let mut d = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 0);
    d.expires_at = d.attested_at + MAX_REMEDY_TTL_SECS;
    let m = s.remedy_msg(&d);
    s.submit(&m).unwrap();
}

/// A stale timing fact can never execute once its window passed: after an
/// outage longer than the TTL, the pre-outage attestation is dead, and it
/// cannot be stretched: only a NEW attestation (a fresh `attested_at`, which
/// the server lane issues only under its system-pause rules) could act.
#[test]
fn a_pre_outage_attestation_cannot_execute_after_the_outage() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    let pre_outage = s.remedy_msg(&a);
    s.advance(MAX_REMEDY_TTL_SECS + 1);
    assert!(matches!(
        refused(&mut s, &pre_outage),
        ContractError::RemedyExpired { .. }
    ));
    // Stretching the old attestation's life (its own attested_at, a fresh
    // expiry) is impossible.
    let mut b = a.clone();
    b.expires_at = s.now().seconds() + 60;
    let m = s.remedy_msg(&b);
    assert!(matches!(
        refused(&mut s, &m),
        ContractError::RemedyTiming { .. }
    ));
    assert_eq!(s.state(id), GameState::InProgress);
}

/// The trusted sequence makes a remedy stale: a checkpoint beyond the attested
/// log position (play went on: a cure) voids it; one at the same position does
/// not.
#[test]
fn a_checkpoint_beyond_the_attested_position_makes_a_remedy_stale() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    s.post_checkpoint(id, 20, &[1, 1, 1]);
    let at_boundary = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 20);
    let below = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 19);
    let m = s.remedy_msg(&below);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::StaleSeq {
            seq: 39,
            trusted_seq: 40
        }
    );
    // The overdue player cured; the server posted the next boundary.
    s.post_checkpoint(id, 21, &[1, 1, 1]);
    let m = s.remedy_msg(&at_boundary);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::StaleSeq {
            seq: 41,
            trusted_seq: 42
        }
    );
    let fresh = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 21);
    let m = s.remedy_msg(&fresh);
    s.submit(&m).unwrap();
}

/// Retired and compromised remedy keys are refused; the remedy key registry
/// is separate from the signer registry (retiring signer key 1 does not touch
/// remedy key 1, and vice versa).
#[test]
fn retired_and_compromised_remedy_keys_are_refused() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let admin = s.admin.clone();
    // Retiring settlement signer key 1 leaves remedy key 1 alone.
    s.retire_key(1, true);
    let a = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 0);
    let ok_msg = s.remedy_msg(&a);
    for compromised in [false, true] {
        let mut s2 = Suite::new();
        let id2 = live(&mut s2, 3);
        let admin2 = s2.admin.clone();
        s2.exec(
            &admin2,
            &ExecuteMsg::RetireRemedyKey {
                key_id: 1,
                compromised,
            },
            &[],
        )
        .unwrap();
        let a2 = s2.attestation(id2, RemedyKind::LiveTimeoutAnnul, 2, 0);
        let m = s2.remedy_msg(&a2);
        assert_eq!(
            refused(&mut s2, &m),
            ContractError::RetiredRemedyKey { key_id: 1 }
        );
        // A newly added key works.
        s2.exec(
            &admin2,
            &ExecuteMsg::AddRemedyKey {
                pubkey: Key::remedy(2).pubkey,
            },
            &[],
        )
        .unwrap();
        let mut b = a2.clone();
        b.remedy_key_id = 2;
        let m = msg_with(&s2, &b, &Key::remedy(2), vec![]);
        s2.submit(&m).unwrap();
    }
    s.submit(&ok_msg).unwrap();
    // Unknown key id.
    let id = live(&mut s, 3);
    let mut c = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 0);
    c.remedy_key_id = 7;
    let m = s.remedy_msg(&c);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::UnknownRemedyKey { key_id: 7 }
    );
    let _ = admin;
}

// ============================================== Live first / second overdue

/// The neutral TimeoutAnnul at 30:00: refused one second before finality,
/// accepted at it, with no approvals; every seat gets exactly its own net
/// deposit back, nothing to the treasury, the relayer or a winner.
#[test]
fn live_timeout_annul_is_neutral_and_executes_exactly_at_finality() {
    for strike in [1u8, 2] {
        let mut s = Suite::new();
        let id = live(&mut s, 3);
        let now = s.now().seconds();
        let mut a = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 1, 0);
        a.strike = strike;
        a.final_at = now + 1;
        a.overdue_at = now + 1 - LIVE_CURE_WINDOW_SECS;
        a.attested_at = now + 1;
        a.expires_at = now + HOUR;
        let msg = s.remedy_msg(&a);
        assert_eq!(
            refused(&mut s, &msg),
            ContractError::RemedyNotFinal { final_at: now + 1 }
        );
        s.advance(1);
        let treasury = s.balance(&s.treasury.clone());
        let relayer = s.outsider.clone();
        let relayer_before = s.balance(&relayer);
        let res = s.submit(&msg).unwrap();
        assert_eq!(attr(&res, "remedy"), "live_timeout_annul");
        let g = s.game(id).game;
        assert_eq!(g.state, GameState::Annulled);
        let o = g.outcome.unwrap();
        assert_eq!(o.route, Route::RemedyTimeoutAnnul);
        assert_eq!(o.amounts, vec![Uint128::new(NET); 3]);
        assert!(o.dust.is_zero());
        for i in 0..3 {
            assert_eq!(sends_to(&res, &s.players[i]), NET);
        }
        assert_eq!(s.balance(&s.treasury.clone()), treasury);
        assert_eq!(s.balance(&relayer), relayer_before);
        let r = g.remedy.unwrap();
        assert_eq!(r.kind, RemedyKind::LiveTimeoutAnnul);
        assert_eq!(r.strike, strike);
        assert_eq!(r.approvals_bitmap, 0);
        s.assert_custody();
    }
}

/// The 20/30 shape is enforced: `final_at` lies at least the 10-minute cure
/// window after `overdue_at` (never one second sooner), the overdue at least
/// one 20-minute allowance after the start, the allowance is the 20-minute
/// action clock, and a first/second strike is 1 or 2.
#[test]
fn the_live_20_30_shape_is_enforced() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    assert_eq!(s.game(id).game.terms.allowance_secs, LIVE_ACTION_SECS);
    assert_eq!(
        s.game(id).game.terms.cure_window_secs,
        LIVE_CURE_WINDOW_SECS
    );
    for kind in [RemedyKind::LiveTimeoutAnnul, RemedyKind::LiveForeclose] {
        // Final before 30:00 (less than the cure window after the overdue).
        let mut a = s.attestation(id, kind, 2, 0);
        a.overdue_at += 1;
        let m = s.remedy_msg(&a);
        assert!(matches!(
            refused(&mut s, &m),
            ContractError::RemedyTiming { .. }
        ));
        for strike in [0u8, 3, 4] {
            let mut a = s.attestation(id, kind, 2, 0);
            a.strike = strike;
            let m = s.remedy_msg(&a);
            assert_eq!(
                refused(&mut s, &m),
                ContractError::BadStrike {
                    remedy: kind.as_byte(),
                    strike
                }
            );
        }
        let mut a = s.attestation(id, kind, 2, 0);
        a.allowance_secs = 1_199;
        let m = s.remedy_msg(&a);
        assert_eq!(
            refused(&mut s, &m),
            ContractError::AllowanceMismatch {
                expected: 1_200,
                got: 1_199
            }
        );
    }
    // A defaulting seat outside the roster.
    let a = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 3, 0);
    let m = s.remedy_msg(&a);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::SeatIndexOutOfRange { seat_index: 3 }
    );
    // An overdue before one whole allowance has run since the start (no
    // action clock can have expired yet).
    let started = s.game(id).game.started_at.unwrap().seconds();
    for overdue_at in [started - 1, started, started + LIVE_ACTION_SECS - 1] {
        let mut a = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 0);
        a.overdue_at = overdue_at;
        a.final_at = a.overdue_at + LIVE_CURE_WINDOW_SECS;
        a.attested_at = a.final_at;
        a.expires_at = a.attested_at + HOUR;
        let m = s.remedy_msg(&a);
        assert_eq!(
            refused(&mut s, &m),
            ContractError::RemedyTiming {
                reason: "overdue_at precedes the end of the first allowance after the game's start"
                    .to_string()
            }
        );
    }
    // The earliest possible overdue is valid.
    let mut a = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 0);
    a.overdue_at = started + LIVE_ACTION_SECS;
    a.final_at = a.overdue_at + LIVE_CURE_WINDOW_SECS;
    a.attested_at = s.now().seconds();
    a.expires_at = a.attested_at + HOUR;
    let m = s.remedy_msg(&a);
    s.submit(&m).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
}

/// A voluntary or system pause froze the cure window: the remedy is final
/// later than 30:00 by exactly the frozen time (the clock evidence accounts
/// for it), and the contract accepts any `final_at` at or after
/// `overdue_at + 600` -- never earlier.
#[test]
fn a_paused_cure_window_is_final_later_never_earlier() {
    for kind in [RemedyKind::LiveTimeoutAnnul, RemedyKind::LiveForeclose] {
        let mut s = Suite::new();
        let id = live(&mut s, 3);
        // 4:30 of the cure window remained when the table paused for 25 min.
        let mut a = s.attestation(id, kind, 2, 0);
        a.overdue_at -= 25 * 60;
        let m = s.remedy_msg(&a);
        s.submit(&m).unwrap();
        assert_ne!(s.state(id), GameState::InProgress, "{kind:?}");
    }
}

/// The attestation's own time: at or after its finality, at or before the
/// block time, and it expires at most `MAX_REMEDY_TTL_SECS` (one hour) after
/// it. A final remedy that did not land in time is attested AGAIN (a fresh
/// `attested_at`), with the same approvals; an old attestation never revives.
#[test]
fn attestation_time_bounds_the_bearer_life() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    assert_eq!(MAX_REMEDY_TTL_SECS, HOUR);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    // Attested before its finality.
    let mut early = a.clone();
    early.attested_at = early.final_at - 1;
    let m = s.remedy_msg(&early);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::RemedyTiming {
            reason: "attested_at precedes final_at".to_string()
        }
    );
    // Attested "after" the block time (a signer clock running ahead).
    let mut ahead = a.clone();
    ahead.attested_at = s.now().seconds() + 5;
    ahead.expires_at = ahead.attested_at + 60;
    let m = s.remedy_msg(&ahead);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::RemedyTiming {
            reason: "attested_at lies after the block time".to_string()
        }
    );
    // A bearer life longer than the TTL, or none at all.
    for expires_at in [a.attested_at + MAX_REMEDY_TTL_SECS + 1, a.attested_at] {
        let mut long = a.clone();
        long.expires_at = expires_at;
        let m = s.remedy_msg(&long);
        assert!(matches!(
            refused(&mut s, &m),
            ContractError::RemedyTiming { .. }
        ));
    }
    // The first attestation is not relayed in time (an admin pause, a relayer
    // outage): it expired and never revives ...
    let horizon = s.now().seconds() + 2 * DAY;
    let approvals = s.approvals_until(&a, &[0, 1], horizon);
    let first = msg_with(&s, &a, &s.remedy.clone(), approvals.clone());
    s.advance(DAY);
    assert_eq!(
        refused(&mut s, &first),
        ContractError::RemedyExpired {
            expires_at: a.expires_at
        }
    );
    // ... but the same final decision, attested again now, lands -- with the
    // very same N−1 approvals (they bind the overdue instance and their own
    // horizon, not the attestation's own time).
    let mut again = a.clone();
    again.attested_at = s.now().seconds();
    again.expires_at = again.attested_at + 600;
    let m = msg_with(&s, &again, &s.remedy.clone(), approvals);
    s.submit(&m).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    // The record names the attestation that took effect.
    let r = s.game(id).game.remedy.unwrap();
    assert_eq!(
        (r.final_at.u64(), r.attested_at.u64(), r.expires_at.u64()),
        (again.final_at, again.attested_at, again.expires_at)
    );
}

/// N−1 foreclosure: every non-defaulting seat must approve; a missing, a
/// duplicated, an invalid, a rotated-away or an out-of-range approval fails,
/// and the defaulting seat can never count. The complete set forecloses.
#[test]
fn live_n_minus_1_foreclosure_needs_every_other_seat_and_never_the_defaulter() {
    let mut s = Suite::new();
    let id = live(&mut s, 4);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 1, 0);
    let remedy = s.remedy.clone();
    // Missing one (each in turn).
    for missing in [0usize, 2, 3] {
        let seats: Vec<usize> = [0usize, 2, 3]
            .into_iter()
            .filter(|i| *i != missing)
            .collect();
        let m = msg_with(&s, &a, &remedy, s.approvals(&a, &seats));
        assert_eq!(
            refused(&mut s, &m),
            ContractError::MissingConsent {
                seat_index: missing as u8
            }
        );
    }
    // No approvals at all.
    let m = msg_with(&s, &a, &remedy, vec![]);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::MissingConsent { seat_index: 0 }
    );
    // Duplicate (counted once, so still missing one; refused as duplicate).
    let mut dup = s.approvals(&a, &[0, 2]);
    dup.push(dup[0].clone());
    let m = msg_with(&s, &a, &remedy, dup);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::DuplicateConsent { seat_index: 0 }
    );
    // The defaulter's approval, alone or on top of a complete set.
    for seats in [vec![0usize, 1, 2, 3], vec![1usize]] {
        let m = msg_with(&s, &a, &remedy, s.approvals(&a, &seats));
        assert_eq!(
            refused(&mut s, &m),
            ContractError::DefaulterCannotApprove { seat_index: 1 }
        );
    }
    // Out of range.
    let mut extra = s.approvals(&a, &[0, 2, 3]);
    extra.push(RemedyApproval {
        seat_index: 4,
        approve_until: Uint64::new(u64::MAX),
        signature: Key::seat(4).sign(&[1; 32]),
    });
    let m = msg_with(&s, &a, &remedy, extra);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::SeatIndexOutOfRange { seat_index: 4 }
    );
    // An approval by the wrong key for its seat.
    let mut wrong = s.approvals(&a, &[0, 2, 3]);
    let until = wrong[1].approve_until.u64();
    wrong[1].signature = Key::seat(0).sign(&crypto::remedy_approve_digest(
        &a.domain,
        id,
        2,
        1,
        a.strike,
        a.overdue_epoch,
        a.log_len,
        &a.log_hash,
        a.overdue_at,
        until,
        2,
    ));
    let m = msg_with(&s, &a, &remedy, wrong);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::InvalidConsent { seat_index: 2 }
    );
    // An approval signed for another seat index (seat 0's key, naming seat 2).
    let mut renamed = s.approvals(&a, &[0, 2, 3]);
    renamed[0].seat_index = 0;
    let until = renamed[0].approve_until.u64();
    renamed[0].signature = Key::seat(0).sign(&crypto::remedy_approve_digest(
        &a.domain,
        id,
        2,
        1,
        a.strike,
        a.overdue_epoch,
        a.log_len,
        &a.log_hash,
        a.overdue_at,
        until,
        2,
    ));
    let m = msg_with(&s, &a, &remedy, renamed);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    // A seat that rotated its consent key must approve with the new one.
    let new_key = Key::from_label("18JUNO/TEST/seat/3/rotated");
    let seat3 = s.players[3].clone();
    s.exec(
        &seat3,
        &ExecuteMsg::SetConsentKey {
            chain_game_id: id,
            new_pubkey: new_key.pubkey.clone(),
        },
        &[],
    )
    .unwrap();
    let stale = s.approvals(&a, &[0, 2, 3]);
    let m = msg_with(&s, &a, &remedy, stale);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::InvalidConsent { seat_index: 3 }
    );
    let mut approvals = s.approvals(&a, &[0, 2]);
    let until = s.now().seconds() + DAY;
    approvals.push(RemedyApproval {
        seat_index: 3,
        approve_until: Uint64::new(until),
        signature: new_key.sign(&crypto::remedy_approve_digest(
            &a.domain,
            id,
            2,
            1,
            a.strike,
            a.overdue_epoch,
            a.log_len,
            &a.log_hash,
            a.overdue_at,
            until,
            3,
        )),
    });
    let m = msg_with(&s, &a, &remedy, approvals);
    let treasury = s.balance(&s.treasury.clone());
    let res = s.submit(&m).unwrap();
    // 4 seats, seat 1 defaults: 1_950_000 / 3 = 650_000 each, no dust.
    assert_eq!(attr(&res, "approvals_bitmap"), "13"); // seats 0, 2, 3
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(o.route, Route::RemedyForeclosure);
    assert_eq!(
        o.amounts,
        vec![
            Uint128::new(NET + 650_000),
            Uint128::zero(),
            Uint128::new(NET + 650_000),
            Uint128::new(NET + 650_000)
        ]
    );
    assert!(o.dust.is_zero());
    assert_eq!(sends_to(&res, &s.players[1]), 0);
    assert_eq!(s.balance(&s.treasury.clone()), treasury);
    assert_eq!(s.game(id).game.state, GameState::Settled);
    s.assert_custody();
}

/// Approvals bind the remedy kind, the defaulting seat, the strike and the
/// overdue epoch: an approval given for one overdue instance never counts for
/// another (a cure ends an epoch; a later overdue is a new one).
#[test]
fn approvals_are_bound_to_one_overdue_instance() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    let remedy = s.remedy.clone();
    type Change = fn(&mut RemedyAttestation);
    let variants: Vec<(&str, Change)> = vec![
        ("epoch", |x| x.overdue_epoch += 1),
        ("strike", |x| x.strike = 2),
        ("seat", |x| x.defaulting_seat = 1),
        ("kind", |x| x.remedy = 5),
    ];
    for (name, change) in variants {
        let mut other = a.clone();
        change(&mut other);
        let approvals = s.approvals(&other, &[0, 1]);
        let m = msg_with(&s, &a, &remedy, approvals);
        assert!(
            matches!(refused(&mut s, &m), ContractError::InvalidConsent { .. }),
            "{name}"
        );
    }
    let m = s.remedy_msg(&a);
    s.submit(&m).unwrap();
}

/// N−1 approvals collected before 30:00 move nothing: the only message that
/// carries them is `SubmitRemedy`, which is refused until finality. A cure
/// before 30:00 means no attestation is ever signed (the game simply goes
/// on); the approvals then lapse with their epoch.
#[test]
fn approvals_before_finality_move_nothing() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let now = s.now().seconds();
    // Overdue 5 minutes ago: finality is 5 minutes away.
    let mut a = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    a.overdue_at = now - 300;
    a.final_at = now + 300;
    a.attested_at = now + 300;
    a.expires_at = now + HOUR;
    let m = s.remedy_msg(&a);
    let balance = s.contract_balance();
    assert_eq!(
        refused(&mut s, &m),
        ContractError::RemedyNotFinal {
            final_at: now + 300
        }
    );
    s.advance(299);
    assert!(matches!(
        refused(&mut s, &m),
        ContractError::RemedyNotFinal { .. }
    ));
    assert_eq!(s.contract_balance(), balance);
    // Cured at 29:59 and play reached the next boundary: the same signed
    // remedy is now stale, even after finality.
    s.post_checkpoint(id, 1, &[1, 1, 1]);
    s.advance(1);
    assert!(matches!(
        refused(&mut s, &m),
        ContractError::StaleSeq { .. }
    ));
    assert_eq!(s.state(id), GameState::InProgress);
}

/// The neutral TimeoutAnnul and the third strike carry no approvals; a
/// foreclosure-by-consensus cannot be passed off as one.
#[test]
fn remedies_without_a_vote_carry_no_approvals() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    for kind in [
        RemedyKind::LiveTimeoutAnnul,
        RemedyKind::LiveStrike3Foreclose,
    ] {
        let a = s.attestation(id, kind, 2, 0);
        let m = msg_with(&s, &a, &s.remedy.clone(), s.approvals(&a, &[0, 1]));
        assert_eq!(
            refused(&mut s, &m),
            ContractError::ApprovalsNotAllowed {
                remedy: kind.as_byte()
            }
        );
    }
}

// ============================================================ Live third strike

/// The third strike forecloses at the 20:00 expiry (`final_at = overdue_at`),
/// with no cure and no vote, but the MONEY enters the challenge window: the
/// game becomes SETTLEABLE on a 1/0 settlement (no standings), nothing is
/// paid, and Finalize pays the foreclosure split after the window.
#[test]
fn strike3_enters_the_challenge_window_and_finalizes_to_the_foreclosure() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    // Standings that would pay seat 2 most: never used.
    s.post_checkpoint(id, 10, &[1, 1, 9]);
    let a = s.attestation(id, RemedyKind::LiveStrike3Foreclose, 2, 10);
    assert_eq!(a.final_at, a.overdue_at);
    let balance = s.contract_balance();
    let m = s.remedy_msg(&a);
    let res = s.submit(&m).unwrap();
    assert!(bank_sends(&res).is_empty(), "nothing paid at strike 3");
    assert_eq!(s.contract_balance(), balance);
    let r = s.game(id);
    assert_eq!(r.game.state, GameState::Settleable);
    let st = r.game.settlement.clone().unwrap();
    assert_eq!(st.source, SettlementSource::RemedyStrike3);
    assert_eq!(
        st.payload.settlement_weights,
        vec![Uint128::one(), Uint128::one(), Uint128::zero()]
    );
    assert_eq!(st.payload.seq.u64(), 21);
    assert_eq!(st.payload.signer_key_id, 1);
    assert_eq!(
        st.payload.payload_digest,
        HexBinary::from(Suite::remedy_digest(&a).as_slice())
    );
    assert_eq!(st.window_end, s.now().plus_seconds(DAY));
    assert_eq!(r.deadlines.challenge_window_end, Some(st.window_end));
    assert_eq!(r.trusted_seq.u64(), 21);
    // Cannot cure after strike-3 finality: no checkpoint, no settle, no other
    // remedy, no review request.
    let p = s.checkpoint_payload(id, 11, &[1, 1, 1]);
    let cp = s.checkpoint_msg(id, &p);
    let who = s.outsider.clone();
    assert!(matches!(
        s.exec(&who, &cp, &[]).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    let tp = s.terminal_payload(id, 1, 30, &[0, 0, 1]);
    let settle = s.settle_msg(id, &tp, &[]);
    let op = s.operator.clone();
    assert!(matches!(
        s.exec(&op, &settle, &[]).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    let again = s.attestation(id, RemedyKind::LiveTimeoutAnnul, 2, 30);
    let m2 = s.remedy_msg(&again);
    assert!(matches!(
        s.submit(&m2).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    // Finalize before the window: refused; after: the foreclosure split.
    assert!(matches!(
        s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
            .unwrap_err(),
        ContractError::WindowOpen { .. }
    ));
    s.advance(DAY);
    let res = s
        .exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
        .unwrap();
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(o.route, Route::Finalized);
    assert_eq!(
        o.amounts,
        vec![
            Uint128::new(NET + NET / 2),
            Uint128::new(NET + NET / 2),
            Uint128::zero()
        ]
    );
    assert_eq!(sends_to(&res, &s.players[2]), 0);
    s.assert_custody();
}

/// The challenge only disputes the attestation: the defaulter (or anyone
/// seated) challenges with the bond; the resolver either upholds the valid
/// foreclosure (the bond joins the pool) or annuls neutrally (the bond goes
/// back). It can never Replace it with a vector of its choosing.
#[test]
fn strike3_challenge_resolver_upholds_or_annuls_and_never_replaces() {
    // Uphold.
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let a = s.attestation(id, RemedyKind::LiveStrike3Foreclose, 2, 0);
    let m = s.remedy_msg(&a);
    s.submit(&m).unwrap();
    s.challenge(id, 2);
    assert_eq!(s.state(id), GameState::Disputed);
    let bond = s.bond(id);
    let fix = s.terminal_payload(id, 5, 50, &[0, 0, 1]);
    assert_eq!(
        s.resolve(
            id,
            ResolveOutcome::Replace {
                payload: Suite::wire(&fix)
            }
        )
        .unwrap_err(),
        ContractError::RemedySettlementNotReplaceable {}
    );
    s.resolve(id, ResolveOutcome::Uphold {}).unwrap();
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(o.route, Route::ResolverUphold);
    let pool = 3 * NET + bond;
    assert_eq!(o.amounts[2], Uint128::zero());
    assert_eq!(o.amounts[0].u128(), pool / 2);
    assert_eq!(o.dust.u128(), pool % 2);
    s.assert_custody();

    // Neutral annul on an invalid attestation.
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let a = s.attestation(id, RemedyKind::LiveStrike3Foreclose, 2, 0);
    let m = s.remedy_msg(&a);
    s.submit(&m).unwrap();
    s.challenge(id, 2);
    let bond = s.bond(id);
    let defaulter = s.players[2].clone();
    let before = s.balance(&defaulter);
    s.resolve(id, ResolveOutcome::Annul {}).unwrap();
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Annulled);
    assert_eq!(g.outcome.unwrap().amounts, vec![Uint128::new(NET); 3]);
    assert_eq!(s.balance(&defaulter) - before, NET + bond);
    s.assert_custody();
}

/// Approvals bind ONE overdue instance -- its exact log position and its
/// overdue moment as well as its strike and epoch: approvals collected for an
/// overdue that was then cured never count for a later attestation, even one
/// the REMEDY key signs with the same strike and epoch (a compromised or
/// mistaken signer cannot turn them into a foreclosure).
#[test]
fn approvals_bind_the_overdue_instance_not_just_its_epoch() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let first = s.attestation(id, RemedyKind::LiveForeclose, 2, 10);
    // The seats' usual one-day horizon, and a week's.
    let short = s.approvals(&first, &[0, 1]);
    let short_until = short[0].approve_until.u64();
    let stale = s.approvals_until(&first, &[0, 1], s.now().seconds() + 7 * DAY);
    // The seat cured; play went on to log 20; three days later a strike-1,
    // epoch-1 foreclosure at log 30 is attested with the old approvals.
    s.post_checkpoint(id, 20, &[1, 1, 1]);
    s.advance(3 * DAY);
    let later = s.attestation(id, RemedyKind::LiveForeclose, 2, 30);
    assert_eq!(
        (later.strike, later.overdue_epoch),
        (first.strike, first.overdue_epoch)
    );
    // With the one-day horizon the old set is simply dead ...
    let m = msg_with(&s, &later, &s.remedy.clone(), short);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::ApprovalExpired {
            seat_index: 0,
            approve_until: short_until,
            final_at: later.final_at
        }
    );
    // ... and with a week's it still never counts for another instance.
    let m = msg_with(&s, &later, &s.remedy.clone(), stale.clone());
    assert_eq!(
        refused(&mut s, &m),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    // Each bound field on its own: another overdue moment (a valid, later
    // finality), another log hash.
    let base = s.attestation(id, RemedyKind::LiveForeclose, 2, 30);
    let good = s.approvals(&base, &[0, 1]);
    let mut moved = base.clone();
    moved.overdue_at -= 60;
    let m = msg_with(&s, &moved, &s.remedy.clone(), good.clone());
    assert_eq!(
        refused(&mut s, &m),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    let mut rehashed = base.clone();
    rehashed.log_hash = sha256(&[b"another state"]);
    let m = msg_with(&s, &rehashed, &s.remedy.clone(), good.clone());
    assert_eq!(
        refused(&mut s, &m),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    // The approvals of THIS instance land it.
    let m = msg_with(&s, &base, &s.remedy.clone(), good);
    s.submit(&m).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

/// Each approval carries its seat's own horizon (`approve_until`, signed),
/// judged at the moment the remedy became FINAL (owner ruling, 2026-10-07):
/// it counts when `final_at < approve_until`, never when its horizon is at or
/// before `final_at` -- however fresh the attestation -- and it is never
/// extendable by whoever relays it. The block time it lands at plays no part.
/// So the approvals of an overdue the seat later cured never count for a
/// finality after their horizon (crypto re-review R1, restated).
#[test]
fn approvals_are_judged_at_final_at_not_at_landing() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let id2 = live(&mut s, 3);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    let b = s.attestation(id2, RemedyKind::LiveForeclose, 2, 0);
    let until = s.now().seconds() + 600;
    let approvals = s.approvals_until(&a, &[0, 1], until);
    let approvals_b = s.approvals_until(&b, &[0, 1], until);
    // The same sealed decision attested again: same final_at, fresh
    // attestation time.
    let again = |s: &Suite, x: &RemedyAttestation| {
        let mut y = x.clone();
        y.attested_at = s.now().seconds();
        y.expires_at = y.attested_at + 600;
        y
    };
    // Presented with a later horizon than the seat signed: not its approval.
    let mut extended = approvals.clone();
    extended[0].approve_until = Uint64::new(until + DAY);
    let m = msg_with(&s, &a, &s.remedy.clone(), extended);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    // A finality AT or after a seat's horizon: that seat's approval never
    // counts (the decision would have been sealed on a lapsed approval).
    for (offset, wait) in [(0u64, 0u64), (1, 0), (DAY, DAY)] {
        s.advance(wait);
        let mut late = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
        late.final_at = until + offset;
        late.overdue_at = late.final_at - LIVE_CURE_WINDOW_SECS;
        late.attested_at = s.now().seconds().max(late.final_at);
        late.expires_at = late.attested_at + 600;
        if late.attested_at > s.now().seconds() {
            s.advance(late.attested_at - s.now().seconds());
        }
        let m = msg_with(
            &s,
            &late,
            &s.remedy.clone(),
            s.approvals_until(&late, &[0, 1], until),
        );
        assert_eq!(
            refused(&mut s, &m),
            ContractError::ApprovalExpired {
                seat_index: 0,
                approve_until: until,
                final_at: late.final_at
            }
        );
    }
    // Final one second before the horizon (B) -- landing a day after the
    // horizon passed, attested again with the SAME final_at: it lands.
    assert!(s.now().seconds() > until + DAY);
    let m = msg_with(&s, &again(&s, &b), &s.remedy.clone(), approvals_b);
    s.submit(&m).unwrap();
    assert_eq!(s.state(id2), GameState::Settled);
    // A's approvals (valid at A's final_at) land A just as late.
    let m = msg_with(&s, &again(&s, &a), &s.remedy.clone(), approvals);
    s.submit(&m).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    s.assert_custody();
}

/// Owner ruling, 2026-10-07 (SEALED APPROVAL FINALITY): a decision sealed on
/// N−1 approvals valid at `final_at` lands however late, even after every
/// approval's horizon passed AND every approving seat rotated its consent key
/// after finality -- one attestation dying unlanded, attested again with the
/// same decision; no second vote. The retired keys are recorded with the
/// rotation's block time.
#[test]
fn a_sealed_decision_survives_later_expiry_and_later_rotation() {
    let mut s = Suite::new();
    let id = live(&mut s, 4);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 3, 0);
    let final_at = a.final_at;
    let until = final_at + 300;
    let approvals = s.approvals_until(&a, &[0, 1, 2], until);
    // Every approving seat rotates after finality.
    s.advance(60);
    let rotated_at = s.now();
    for seat in 0..3 {
        let wallet = s.players[seat].clone();
        let fresh = Key::from_label(&format!("18JUNO/TEST/seat/{seat}/after-final"));
        s.exec(
            &wallet,
            &ExecuteMsg::SetConsentKey {
                chain_game_id: id,
                new_pubkey: fresh.pubkey.clone(),
            },
            &[],
        )
        .unwrap();
    }
    let g = s.game(id).game;
    for seat in 0..3 {
        assert_eq!(g.seats[seat].retired_consent_keys.len(), 1);
        assert_eq!(
            g.seats[seat].retired_consent_keys[0].pubkey,
            Key::seat(seat).pubkey
        );
        assert_eq!(g.seats[seat].retired_consent_keys[0].retired_at, rotated_at);
    }
    assert!(g.seats[3].retired_consent_keys.is_empty());
    // The first attestation dies unlanded (an outage), every horizon passes.
    s.advance(2 * HOUR);
    assert!(s.now().seconds() > a.expires_at && s.now().seconds() > until);
    let m = msg_with(&s, &a, &s.remedy.clone(), approvals.clone());
    assert_eq!(
        refused(&mut s, &m),
        ContractError::RemedyExpired {
            expires_at: a.expires_at
        }
    );
    // The SAME decision attested again (same final_at, same approvals) lands.
    let mut again = a.clone();
    again.attested_at = s.now().seconds();
    again.expires_at = again.attested_at + HOUR;
    let m = msg_with(&s, &again, &s.remedy.clone(), approvals);
    s.submit(&m).unwrap();
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settled);
    let r = g.remedy.unwrap();
    assert_eq!(r.final_at, Uint64::new(final_at));
    assert_eq!(r.approvals_bitmap, 0b0111);
    s.assert_custody();
}

/// Before finality a rotation still voids the old key's approval: a seat that
/// rotated AT or before `final_at` (the same second included) is checked
/// against its new key, and only an approval under the key it held at
/// `final_at` counts -- across several rotations, each key for exactly its
/// own span. The newest key never rescues a finality it was not yet held at.
#[test]
fn a_rotation_at_or_before_final_at_voids_the_old_approval() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let wallet = s.players[1].clone();
    let k1 = Key::from_label("18JUNO/TEST/seat/1/k1");
    let k2 = Key::from_label("18JUNO/TEST/seat/1/k2");
    let rotate = |s: &mut Suite, key: &Key| {
        s.exec(
            &wallet,
            &ExecuteMsg::SetConsentKey {
                chain_game_id: id,
                new_pubkey: key.pubkey.clone(),
            },
            &[],
        )
        .unwrap();
    };
    let t0 = s.now().seconds();
    let before = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    s.advance(60);
    rotate(&mut s, &k1);
    let t1 = s.now().seconds();
    let at_t1 = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    s.advance(60);
    rotate(&mut s, &k2);
    let t2 = s.now().seconds();
    let at_t2 = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    assert_eq!(
        (before.final_at, at_t1.final_at, at_t2.final_at),
        (t0, t1, t2)
    );
    let until = t2 + DAY;
    let by = |s: &Suite, a: &RemedyAttestation, key: &Key| {
        let mut set = s.approvals_until(a, &[0], until);
        set.push(approval_by(a, 1, key, until));
        set
    };
    let fresh = |s: &Suite, a: &RemedyAttestation| {
        let mut y = a.clone();
        y.attested_at = s.now().seconds();
        y.expires_at = y.attested_at + HOUR;
        y
    };
    let original = Key::seat(1);
    // Final at t1 (the first rotation's own second): k1 only.
    for key in [&original, &k2] {
        let m = msg_with(
            &s,
            &fresh(&s, &at_t1),
            &s.remedy.clone(),
            by(&s, &at_t1, key),
        );
        assert_eq!(
            refused(&mut s, &m),
            ContractError::InvalidConsent { seat_index: 1 }
        );
    }
    // Final at t2: k2 only.
    for key in [&original, &k1] {
        let m = msg_with(
            &s,
            &fresh(&s, &at_t2),
            &s.remedy.clone(),
            by(&s, &at_t2, key),
        );
        assert_eq!(
            refused(&mut s, &m),
            ContractError::InvalidConsent { seat_index: 1 }
        );
    }
    // Final at t0 (before any rotation): the original key only.
    for key in [&k1, &k2] {
        let m = msg_with(
            &s,
            &fresh(&s, &before),
            &s.remedy.clone(),
            by(&s, &before, key),
        );
        assert_eq!(
            refused(&mut s, &m),
            ContractError::InvalidConsent { seat_index: 1 }
        );
    }
    let g = s.game(id).game;
    let history: Vec<(HexBinary, u64)> = g.seats[1]
        .retired_consent_keys
        .iter()
        .map(|r| (r.pubkey.clone(), r.retired_at.seconds()))
        .collect();
    assert_eq!(
        history,
        vec![(original.pubkey.clone(), t1), (k1.pubkey.clone(), t2)]
    );
    // The key held at t1 lands the decision final at t1.
    let m = msg_with(
        &s,
        &fresh(&s, &at_t1),
        &s.remedy.clone(),
        by(&s, &at_t1, &k1),
    );
    s.submit(&m).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    s.assert_custody();
}

/// Timed Async: the same rule. A neutral annulment completed (final) while
/// its approvals were valid lands after they lapse and after a rotation; an
/// approval that lapsed before completion never counts.
#[test]
fn async_approvals_are_judged_at_completion() {
    let mut s = Suite::new();
    let id = timed_async(&mut s, 3, DAY);
    let a = s.attestation(id, RemedyKind::AsyncAnnul, 0, 0);
    let until = a.final_at + HOUR;
    let approvals = s.approvals_until(&a, &[1, 2], until);
    // Lapsed at completion: never counts.
    let mut lapsed = s.approvals_until(&a, &[1], a.final_at);
    lapsed.push(approvals[1].clone());
    let m = msg_with(&s, &a, &s.remedy.clone(), lapsed);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::ApprovalExpired {
            seat_index: 1,
            approve_until: a.final_at,
            final_at: a.final_at
        }
    );
    s.advance(10);
    let wallet = s.players[2].clone();
    s.exec(
        &wallet,
        &ExecuteMsg::SetConsentKey {
            chain_game_id: id,
            new_pubkey: Key::from_label("18JUNO/TEST/seat/2/async-later").pubkey,
        },
        &[],
    )
    .unwrap();
    s.advance(2 * DAY);
    let mut again = a.clone();
    again.attested_at = s.now().seconds();
    again.expires_at = again.attested_at + HOUR;
    let refund_before = s.balance(&s.players[0].clone());
    let m = msg_with(&s, &again, &s.remedy.clone(), approvals);
    s.submit(&m).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
    assert_eq!(s.balance(&s.players[0].clone()) - refund_before, NET);
    s.assert_custody();
}

/// A sealed decision is immutable on chain: once one remedy landed nothing
/// replaces it (another kind, the same kind attested again, an earlier or
/// later final_at), and approvals that were never part of a sealed decision
/// -- an instance whose finality the remedy key never attested -- do nothing
/// on their own (a relayer cannot submit them without a REMEDY signature).
#[test]
fn a_landed_remedy_is_never_replaced_and_unsealed_approvals_do_nothing() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    let approvals = s.approvals(&a, &[0, 1]);
    // Unsealed: the seats' approvals with no REMEDY signature (anyone's key
    // but the remedy key's) never move anything.
    for key in [Key::seat(0), Key::from_label("18JUNO/TEST/relayer")] {
        let m = msg_with(&s, &a, &key, approvals.clone());
        assert_eq!(refused(&mut s, &m), ContractError::InvalidSignature {});
    }
    let m = msg_with(&s, &a, &s.remedy.clone(), approvals.clone());
    s.submit(&m).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    for kind in [RemedyKind::LiveTimeoutAnnul, RemedyKind::LiveForeclose] {
        let mut b = a.clone();
        b.remedy = kind.as_byte();
        b.attested_at = s.now().seconds();
        b.expires_at = b.attested_at + HOUR;
        let m = s.remedy_msg(&b);
        assert!(matches!(
            refused(&mut s, &m),
            ContractError::WrongState { .. }
        ));
    }
}

/// Timeouts stay safe: nobody challenges → the SETTLEABLE liveness exit pays
/// the foreclosure; a challenge nobody resolves → after the resolver timeout
/// the foreclosure is paid and the bond returned. A strike-3 settlement whose
/// REMEDY key is later marked compromised is never paid directly: Finalize
/// and Consent refuse it, and the liveness exit refunds (no standings).
#[test]
fn strike3_timeouts_pay_the_foreclosure_unless_the_remedy_key_is_compromised() {
    let mut s = Suite::new();
    let unchallenged = live(&mut s, 3);
    let disputed = live(&mut s, 3);
    let compromised = live(&mut s, 3);
    for id in [unchallenged, disputed, compromised] {
        let a = s.attestation(id, RemedyKind::LiveStrike3Foreclose, 0, 0);
        let m = s.remedy_msg(&a);
        s.submit(&m).unwrap();
    }
    s.challenge(disputed, 0);
    let bond = s.bond(disputed);
    let challenger = s.players[0].clone();
    let admin = s.admin.clone();
    s.exec(
        &admin,
        &ExecuteMsg::RetireRemedyKey {
            key_id: 1,
            compromised: true,
        },
        &[],
    )
    .unwrap();
    // The compromised key's strike-3 settlement loses its authority ...
    assert_eq!(s.trusted_seq(compromised), 0);
    let who = s.outsider.clone();
    s.advance(DAY);
    // ... but so do the others: they were attested by the same key.
    for id in [unchallenged, compromised] {
        assert_eq!(
            s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
                .unwrap_err(),
            ContractError::CompromisedSettlement { key_id: 1 }
        );
        let digest = stored_consent_digest(&s, id);
        assert_eq!(
            s.exec(
                &who,
                &ExecuteMsg::Consent {
                    chain_game_id: id,
                    seat_index: 1,
                    signature: Key::seat(1).sign(&digest),
                },
                &[]
            )
            .unwrap_err(),
            ContractError::CompromisedSettlement { key_id: 1 }
        );
    }
    s.advance(30 * DAY);
    for id in [unchallenged, compromised] {
        let res = s.liveness(id, 1, None).unwrap();
        assert_eq!(attr(&res, "path"), "settleable_timeout_refund");
        assert_eq!(
            s.game(id).game.outcome.unwrap().amounts,
            vec![Uint128::new(NET); 3]
        );
    }
    let before = s.balance(&challenger);
    let res = s.liveness(disputed, 1, None).unwrap();
    assert_eq!(attr(&res, "path"), "resolver_timeout_refund");
    assert_eq!(s.balance(&challenger) - before, NET + bond);
    s.assert_custody();

    // With the key trusted, the same timeouts pay the foreclosure.
    let mut s = Suite::new();
    let unchallenged = live(&mut s, 3);
    let disputed = live(&mut s, 3);
    for id in [unchallenged, disputed] {
        let a = s.attestation(id, RemedyKind::LiveStrike3Foreclose, 0, 0);
        let m = s.remedy_msg(&a);
        s.submit(&m).unwrap();
    }
    s.challenge(disputed, 0);
    let bond = s.bond(disputed);
    let challenger = s.players[0].clone();
    s.advance(DAY + 14 * DAY);
    let res = s.liveness(unchallenged, 1, None).unwrap();
    assert_eq!(attr(&res, "path"), "settleable_timeout_payout");
    s.advance(30 * DAY);
    let before = s.balance(&challenger);
    let res = s.liveness(disputed, 1, None).unwrap();
    assert_eq!(attr(&res, "path"), "resolver_timeout_payout");
    assert_eq!(s.balance(&challenger) - before, bond, "bond back, no share");
    for id in [unchallenged, disputed] {
        let o = s.game(id).game.outcome.unwrap();
        assert_eq!(o.amounts[0], Uint128::zero());
        assert_eq!(o.amounts[1].u128(), NET + NET / 2);
    }
    s.assert_custody();
}

/// The third-strike shape: strike 3 only, `final_at == overdue_at`, Live
/// only, and every seat's consent pays it at once (the defaulter accepting).
#[test]
fn strike3_shape_and_unanimous_consent() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    for strike in [1u8, 2, 4] {
        let mut a = s.attestation(id, RemedyKind::LiveStrike3Foreclose, 2, 0);
        a.strike = strike;
        let m = s.remedy_msg(&a);
        assert_eq!(
            refused(&mut s, &m),
            ContractError::BadStrike { remedy: 3, strike }
        );
    }
    let mut a = s.attestation(id, RemedyKind::LiveStrike3Foreclose, 2, 0);
    a.overdue_at -= LIVE_CURE_WINDOW_SECS;
    let m = s.remedy_msg(&a);
    assert!(matches!(
        refused(&mut s, &m),
        ContractError::RemedyTiming { .. }
    ));
    let a = s.attestation(id, RemedyKind::LiveStrike3Foreclose, 2, 0);
    let m = s.remedy_msg(&a);
    s.submit(&m).unwrap();
    let digest = crypto::consent_digest(&s.domain(id), 1, &Suite::remedy_digest(&a));
    let who = s.outsider.clone();
    for seat in 0..3u8 {
        s.exec(
            &who,
            &ExecuteMsg::Consent {
                chain_game_id: id,
                seat_index: seat,
                signature: Key::seat(seat as usize).sign(&digest),
            },
            &[],
        )
        .unwrap();
    }
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(o.route, Route::ConsentCompleted);
    assert_eq!(o.amounts[2], Uint128::zero());
    s.assert_custody();
}

// =================================================================== Timed Async

/// An overdue Timed Async game: nothing happens automatically, however long
/// it stays overdue (no liveness exit, no money); N−1 neutral annulment and
/// N−1 foreclosure each execute immediately once the consensus is complete
/// and attested (no grace period), for every pace.
#[test]
fn async_overdue_moves_nothing_until_n_minus_1_consensus() {
    for pace in ASYNC_PACES_SECS {
        for kind in ASYNC_KINDS {
            let mut s = Suite::new();
            let id = timed_async(&mut s, 3, pace);
            assert_eq!(s.game(id).game.terms.allowance_secs, pace);
            // Overdue for years: nothing.
            s.advance(3 * 365 * DAY);
            assert_eq!(
                s.liveness(id, 0, None).unwrap_err(),
                ContractError::LivenessExitRemoved {}
            );
            assert_eq!(s.game(id).game.pool.u128(), 3 * NET);
            // Consensus completed this instant (final_at = now): final at once.
            let now = s.now().seconds();
            let mut a = s.attestation(id, kind, 1, 0);
            a.overdue_at = now - 3 * 365 * DAY;
            a.final_at = now;
            let m = s.remedy_msg(&a);
            s.submit(&m).unwrap();
            let o = s.game(id).game.outcome.unwrap();
            match kind {
                RemedyKind::AsyncAnnul => {
                    assert_eq!(o.route, Route::RemedyAnnul);
                    assert_eq!(o.amounts, vec![Uint128::new(NET); 3]);
                }
                _ => {
                    assert_eq!(o.route, Route::RemedyForeclosure);
                    assert_eq!(
                        o.amounts,
                        vec![
                            Uint128::new(NET + NET / 2),
                            Uint128::zero(),
                            Uint128::new(NET + NET / 2)
                        ]
                    );
                }
            }
            s.assert_custody();
        }
    }
}

/// No added grace period: consensus at the very instant of the overdue
/// (`final_at == overdue_at`) is final.
#[test]
fn async_remedy_has_no_grace_period() {
    let mut s = Suite::new();
    let id = timed_async(&mut s, 2, DAY);
    let now = s.now().seconds();
    let mut a = s.attestation(id, RemedyKind::AsyncForeclose, 0, 0);
    a.overdue_at = now;
    a.final_at = now;
    let m = s.remedy_msg(&a);
    s.submit(&m).unwrap();
    assert_eq!(
        s.game(id).game.outcome.unwrap().amounts,
        vec![Uint128::zero(), Uint128::new(2 * NET)]
    );
    s.assert_custody();
}

/// A cure before the consensus completes prevents the final remedy: a NO
/// (or a missing) approval leaves the game overdue, and once play moved on
/// (a newer checkpoint), the attestation for the old position is stale.
#[test]
fn async_cure_before_complete_consensus_prevents_the_remedy() {
    let mut s = Suite::new();
    let id = timed_async(&mut s, 4, 2 * DAY);
    let a = s.attestation(id, RemedyKind::AsyncAnnul, 3, 0);
    // Seat 2 votes no: two of three approvals.
    let m = msg_with(&s, &a, &s.remedy.clone(), s.approvals(&a, &[0, 1]));
    assert_eq!(
        refused(&mut s, &m),
        ContractError::MissingConsent { seat_index: 2 }
    );
    // The player cured; play went on.
    s.post_checkpoint(id, 3, &[1, 1, 1, 1]);
    let m = s.remedy_msg(&a);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::StaleSeq {
            seq: 1,
            trusted_seq: 6
        }
    );
    assert_eq!(s.state(id), GameState::InProgress);
}

/// Pace and mode are bound: an Async remedy names the funded pace; a Live
/// remedy is refused on an Async game and vice versa; an Async remedy carries
/// strike 0.
#[test]
fn async_remedies_are_bound_to_the_funded_pace_and_mode() {
    let mut s = Suite::new();
    let async_id = timed_async(&mut s, 3, 3 * DAY);
    let live_id = live(&mut s, 3);
    let mut a = s.attestation(async_id, RemedyKind::AsyncAnnul, 2, 0);
    a.allowance_secs = DAY;
    let m = s.remedy_msg(&a);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::AllowanceMismatch {
            expected: 3 * DAY,
            got: DAY
        }
    );
    let mut a = s.attestation(async_id, RemedyKind::AsyncAnnul, 2, 0);
    a.strike = 1;
    let m = s.remedy_msg(&a);
    assert_eq!(
        refused(&mut s, &m),
        ContractError::BadStrike {
            remedy: 4,
            strike: 1
        }
    );
    for kind in LIVE_KINDS {
        let mut a = s.attestation(live_id, kind, 2, 0);
        a.domain = s.domain(async_id);
        a.chain_game_id = async_id;
        a.allowance_secs = 3 * DAY;
        let m = s.remedy_msg(&a);
        assert_eq!(
            refused(&mut s, &m),
            ContractError::RemedyNotForMode {
                remedy: kind.as_byte()
            }
        );
    }
    for kind in ASYNC_KINDS {
        let mut a = s.attestation(async_id, kind, 2, 0);
        a.domain = s.domain(live_id);
        a.chain_game_id = live_id;
        a.allowance_secs = LIVE_ACTION_SECS;
        let m = s.remedy_msg(&a);
        assert_eq!(
            refused(&mut s, &m),
            ContractError::RemedyNotForMode {
                remedy: kind.as_byte()
            }
        );
    }
    // An unknown remedy byte.
    for byte in [0u8, 6, 255] {
        let mut a = s.attestation(live_id, RemedyKind::LiveTimeoutAnnul, 2, 0);
        a.remedy = byte;
        let m = s.remedy_msg_by(&a, &s.remedy.clone(), vec![]);
        assert_eq!(
            refused(&mut s, &m),
            ContractError::BadRemedyKind { got: byte }
        );
    }
}

/// No-deadline and 2.0.0 games have no ordinary timeout remedies: every
/// remedy is refused, at any time, whoever relays it.
#[test]
fn no_deadline_and_2_0_0_games_have_no_timeout_remedies() {
    let mut s = Suite::new();
    let nd = no_deadline(&mut s, 3);
    let legacy = live(&mut s, 3);
    s.make_legacy(legacy);
    s.advance(10 * 365 * DAY);
    for id in [nd, legacy] {
        for kind in LIVE_KINDS.into_iter().chain(ASYNC_KINDS) {
            let a = s.attestation(id, kind, 2, 0);
            let m = s.remedy_msg(&a);
            assert_eq!(refused(&mut s, &m), ContractError::RemedyNotAvailable {});
        }
    }
}

// ======================================================== pause / no new power

/// An admin pause never manufactures a foreclosure: the foreclosing remedies
/// are refused while paused, the neutral ones still execute; after the
/// unpause a still-fresh foreclosure attestation executes.
#[test]
fn an_admin_pause_blocks_foreclosure_and_never_blocks_a_neutral_remedy() {
    let mut s = Suite::new();
    let live_annul = live(&mut s, 3);
    let live_fore = live(&mut s, 3);
    let strike3 = live(&mut s, 3);
    let async_annul = timed_async(&mut s, 3, DAY);
    let async_fore = timed_async(&mut s, 3, DAY);
    let msgs: Vec<(u64, RemedyKind, ExecuteMsg)> = [
        (live_annul, RemedyKind::LiveTimeoutAnnul),
        (live_fore, RemedyKind::LiveForeclose),
        (strike3, RemedyKind::LiveStrike3Foreclose),
        (async_annul, RemedyKind::AsyncAnnul),
        (async_fore, RemedyKind::AsyncForeclose),
    ]
    .into_iter()
    .map(|(id, kind)| {
        let a = s.attestation(id, kind, 1, 0);
        (id, kind, s.remedy_msg(&a))
    })
    .collect();
    s.pause();
    for (id, kind, m) in &msgs {
        if kind.forecloses() {
            assert_eq!(refused(&mut s, m), ContractError::Paused {}, "{kind:?}");
            assert_eq!(s.state(*id), GameState::InProgress);
        } else {
            s.submit(m).unwrap();
            assert_eq!(s.state(*id), GameState::Annulled);
        }
    }
    s.advance(30 * 60);
    s.unpause();
    for (id, kind, m) in &msgs {
        if kind.forecloses() {
            s.submit(m).unwrap();
            assert_ne!(s.state(*id), GameState::InProgress);
        }
    }
    s.assert_custody();
}

/// Neither the admin, the operator, the resolver nor a seat gains any power
/// from the remedy machinery: SubmitRemedy names no address and no amount
/// (strict JSON refuses any such field), and nobody without the REMEDY key's
/// signature can produce one.
#[test]
fn no_address_or_amount_can_ride_on_a_remedy() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    let msg = s.remedy_msg(&a);
    let json = serde_json::to_value(&msg).unwrap();
    let contract = s.contract.clone();
    let who = s.outsider.clone();
    for (path, field, value) in [
        (
            "submit_remedy",
            "recipient",
            serde_json::json!(who.to_string()),
        ),
        (
            "submit_remedy",
            "amounts",
            serde_json::json!(["1", "2", "3"]),
        ),
        (
            "submit_remedy",
            "weights",
            serde_json::json!(["0", "0", "1"]),
        ),
        (
            "attestation",
            "payout_address",
            serde_json::json!(who.to_string()),
        ),
        (
            "attestation",
            "settlement_weights",
            serde_json::json!(["1", "0", "0"]),
        ),
    ] {
        let mut j = json.clone();
        let target = if path == "submit_remedy" {
            &mut j["submit_remedy"]
        } else {
            &mut j["submit_remedy"]["attestation"]
        };
        target[field] = value;
        let err = s
            .app
            .execute_contract(who.clone(), contract.clone(), &j, &[])
            .unwrap_err();
        assert!(
            format!("{err:?}").contains("unknown field"),
            "{field}: {err:?}"
        );
    }
    // Funds are refused.
    assert_eq!(
        s.exec(&who, &msg, &coins(1, DENOM)).unwrap_err(),
        ContractError::NonPayable {}
    );
    // Every role relays the same message to the same effect: none of them is
    // privileged, and none is paid.
    let resolver = s.resolver.clone();
    let before = s.balance(&resolver);
    s.exec(&resolver, &msg, &[]).unwrap();
    assert_eq!(s.balance(&resolver), before);
    s.assert_custody();
}

/// Foreclosure dust goes to the game's snapshotted treasury, never to a seat:
/// 4 seats of 1_950_001 net (2_000_001 gross at 250 bps) → 650_000 each and 1
/// base unit of dust; a later SetTreasury does not redirect it. Subsidies and
/// gas are never recreated: the split distributes exactly the pool.
#[test]
fn foreclosure_dust_goes_to_the_snapshotted_treasury() {
    let mut s = Suite::new();
    let id = s.started_with(4, Mode::Live, 2_000_001);
    s.advance(HOUR);
    let game_treasury = s.game(id).game.terms.treasury;
    let admin = s.admin.clone();
    let new_treasury = s.addr("treasury-2");
    s.exec(
        &admin,
        &ExecuteMsg::SetTreasury {
            treasury: new_treasury.to_string(),
        },
        &[],
    )
    .unwrap();
    let net = s.game(id).game.ante_net.u128();
    assert_eq!(net, 1_950_001);
    let a = s.attestation(id, RemedyKind::LiveForeclose, 3, 0);
    let m = s.remedy_msg(&a);
    let before = s.balance(&game_treasury);
    let res = s.submit(&m).unwrap();
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(o.dust.u128(), 1);
    assert_eq!(o.distributed.u128(), 4 * net);
    assert_eq!(
        o.amounts,
        vec![
            Uint128::new(net + 650_000),
            Uint128::new(net + 650_000),
            Uint128::new(net + 650_000),
            Uint128::zero()
        ]
    );
    assert_eq!(s.balance(&game_treasury) - before, 1);
    assert_eq!(sends_to(&res, &new_treasury), 0);
    s.assert_custody();
}

// ============================================== universal unanimous annulment

/// UNANIMOUS NEUTRAL ANNULMENT IS ALWAYS AVAILABLE while a 2.1.0 game is
/// non-terminal and escrow is held: Live active / overdue / (voluntarily or
/// system-) paused, Live pending third-strike foreclosure (SETTLEABLE),
/// DISPUTED, Timed Async active and overdue, No-deadline — admin-paused or
/// not. Every seat gets its own net deposit; a disputed game's bond goes back
/// to its challenger.
#[test]
fn unanimous_annulment_is_available_in_every_non_terminal_escrow_state() {
    for paused in [false, true] {
        let mut s = Suite::new();
        let active_live = live(&mut s, 3);
        let overdue_live = live(&mut s, 3); // overdue off chain: same chain state
        let strike3 = live(&mut s, 3);
        let a = s.attestation(strike3, RemedyKind::LiveStrike3Foreclose, 2, 0);
        let m = s.remedy_msg(&a);
        s.submit(&m).unwrap();
        let strike3_disputed = live(&mut s, 3);
        let a = s.attestation(strike3_disputed, RemedyKind::LiveStrike3Foreclose, 1, 0);
        let m = s.remedy_msg(&a);
        s.submit(&m).unwrap();
        s.challenge(strike3_disputed, 1);
        let (settleable, _) = s.settleable(3);
        let (disputed, _) = s.disputed(3);
        let active_async = timed_async(&mut s, 3, DAY);
        let overdue_async = timed_async(&mut s, 3, DAY);
        s.advance(10 * DAY);
        let nd = no_deadline(&mut s, 3);
        if paused {
            s.pause();
        }
        let who = s.outsider.clone();
        for id in [
            active_live,
            overdue_live,
            strike3,
            strike3_disputed,
            settleable,
            disputed,
            active_async,
            overdue_async,
            nd,
        ] {
            let g = s.game(id).game;
            let challenger = g.dispute.as_ref().map(|d| (d.challenger.clone(), d.bond));
            let challenger_before = challenger.as_ref().map(|(c, _)| s.balance(c));
            let trusted = s.trusted_seq(id);
            // N−1 is never enough.
            let partial = s.annul_sigs(id, &[0, 1], trusted);
            assert!(matches!(
                s.exec(
                    &who,
                    &ExecuteMsg::AnnulByConsent {
                        chain_game_id: id,
                        consents: partial
                    },
                    &[]
                )
                .unwrap_err(),
                ContractError::MissingConsent { seat_index: 2 }
            ));
            let consents = s.annul_sigs(id, &[0, 1, 2], trusted);
            s.exec(
                &who,
                &ExecuteMsg::AnnulByConsent {
                    chain_game_id: id,
                    consents,
                },
                &[],
            )
            .unwrap();
            let after = s.game(id).game;
            assert_eq!(after.state, GameState::Annulled, "game {id}");
            let o = after.outcome.unwrap();
            assert_eq!(o.route, Route::AnnulByConsent);
            assert_eq!(o.amounts, vec![Uint128::new(NET); 3]);
            assert!(o.dust.is_zero());
            if let (Some((c, bond)), Some(b)) = (challenger, challenger_before) {
                let seat = g.seats.iter().position(|x| x.wallet == c).unwrap();
                assert_eq!(o.amounts[seat].u128(), NET);
                assert_eq!(s.balance(&c) - b, NET + bond.u128(), "bond returned");
                assert_eq!(o.bond_returned, bond);
                let d = after.dispute.unwrap();
                assert_eq!(d.resolution, Some(DisputeResolution::AnnulledByConsent));
            }
        }
        s.assert_custody();
        assert_eq!(s.contract_balance(), 0);
    }
}

/// A pending (non-final) remedy is superseded by the unanimous annulment: once
/// it lands, no remedy attestation can execute.
#[test]
fn unanimous_annulment_supersedes_a_pending_remedy() {
    let mut s = Suite::new();
    let id = live(&mut s, 3);
    let pending = s.attestation(id, RemedyKind::LiveForeclose, 2, 0);
    let m = s.remedy_msg(&pending);
    let consents = s.annul_sigs(id, &[0, 1, 2], 0);
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents,
        },
        &[],
    )
    .unwrap();
    assert!(matches!(
        s.submit(&m).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    assert_eq!(
        s.game(id).game.outcome.unwrap().route,
        Route::AnnulByConsent
    );
}

/// Before Start (FUNDING, FUNDED) the unanimous annulment has no domain to
/// sign over; every seat may instead `Withdraw` its own net deposit alone,
/// paused or not, which is strictly more than a unanimous exit.
#[test]
fn before_start_every_seat_can_leave_alone() {
    let mut s = Suite::new();
    let funded = s.funded(3);
    s.pause();
    for seat in [2usize, 1, 0] {
        let who = s.players[seat].clone();
        let before = s.balance(&who);
        s.exec(
            &who,
            &ExecuteMsg::Withdraw {
                chain_game_id: funded,
            },
            &[],
        )
        .unwrap();
        assert_eq!(s.balance(&who) - before, NET);
    }
    assert_eq!(s.game(funded).game.pool, Uint128::zero());
    s.assert_custody();
}

// ======================================================== remedy key registry

/// The remedy key is its own key class: it can never be (or become) a
/// settlement signer key or a join-admission key, current or former, and the
/// registry refuses duplicates, bad keys and non-admins.
#[test]
fn the_remedy_key_is_a_distinct_authority() {
    let mut s = Suite::new();
    let admin = s.admin.clone();
    let add = |s: &mut Suite, who: &cosmwasm_std::Addr, key: &Key| {
        s.exec(
            who,
            &ExecuteMsg::AddRemedyKey {
                pubkey: key.pubkey.clone(),
            },
            &[],
        )
    };
    // Signer key 1 and the admission key cannot be remedy keys.
    for key in [Key::signer(1), Key::admission(1)] {
        assert!(matches!(
            add(&mut s, &admin, &key).unwrap_err(),
            ContractError::InvalidParams { .. }
        ));
    }
    // A remedy key cannot become a signer key or the admission key.
    assert!(matches!(
        s.exec(
            &admin,
            &ExecuteMsg::AddSignerKey {
                pubkey: Key::remedy(1).pubkey
            },
            &[]
        )
        .unwrap_err(),
        ContractError::InvalidParams { .. }
    ));
    assert!(matches!(
        s.exec(
            &admin,
            &ExecuteMsg::SetAdmissionKey {
                pubkey: Key::remedy(1).pubkey
            },
            &[]
        )
        .unwrap_err(),
        ContractError::InvalidParams { .. }
    ));
    // Duplicates, bad keys, non-admins.
    assert_eq!(
        add(&mut s, &admin, &Key::remedy(1)).unwrap_err(),
        ContractError::DuplicateRemedyKey { key_id: 1 }
    );
    let mut off_curve = vec![0xffu8; 33];
    off_curve[0] = 0x02;
    for bad in [off_curve, vec![0x04; 33], vec![0x02; 32]] {
        assert!(matches!(
            s.exec(
                &admin,
                &ExecuteMsg::AddRemedyKey {
                    pubkey: HexBinary::from(bad)
                },
                &[]
            )
            .unwrap_err(),
            ContractError::BadPubkey { .. }
        ));
    }
    for who in [
        s.operator.clone(),
        s.resolver.clone(),
        s.players[0].clone(),
        s.outsider.clone(),
    ] {
        assert_eq!(
            add(&mut s, &who, &Key::remedy(3)).unwrap_err(),
            ContractError::Unauthorized {
                role: "admin".to_string()
            }
        );
        assert_eq!(
            s.exec(
                &who,
                &ExecuteMsg::RetireRemedyKey {
                    key_id: 1,
                    compromised: true
                },
                &[]
            )
            .unwrap_err(),
            ContractError::Unauthorized {
                role: "admin".to_string()
            }
        );
    }
    // A retired remedy key stays reserved: it can never come back as any
    // role, and a former admission key can never become a remedy key.
    let res = add(&mut s, &admin, &Key::remedy(2)).unwrap();
    assert_eq!(attr(&res, "key_id"), "2");
    s.exec(
        &admin,
        &ExecuteMsg::RetireRemedyKey {
            key_id: 2,
            compromised: false,
        },
        &[],
    )
    .unwrap();
    assert_eq!(
        add(&mut s, &admin, &Key::remedy(2)).unwrap_err(),
        ContractError::DuplicateRemedyKey { key_id: 2 }
    );
    s.exec(
        &admin,
        &ExecuteMsg::SetAdmissionKey {
            pubkey: Key::admission(2).pubkey,
        },
        &[],
    )
    .unwrap();
    assert!(matches!(
        add(&mut s, &admin, &Key::admission(1)).unwrap_err(),
        ContractError::InvalidParams { .. }
    ));
    // Escalation only: retired → compromised; never back.
    s.exec(
        &admin,
        &ExecuteMsg::RetireRemedyKey {
            key_id: 2,
            compromised: true,
        },
        &[],
    )
    .unwrap();
    s.exec(
        &admin,
        &ExecuteMsg::RetireRemedyKey {
            key_id: 2,
            compromised: false,
        },
        &[],
    )
    .unwrap();
    let key: RemedyKeyResponse = s
        .app
        .wrap()
        .query_wasm_smart(s.contract.clone(), &QueryMsg::RemedyKey { key_id: 2 })
        .unwrap();
    assert!(key.key.compromised && key.key.retired_at.is_some());
    let keys: RemedyKeysResponse = s
        .app
        .wrap()
        .query_wasm_smart(
            s.contract.clone(),
            &QueryMsg::RemedyKeys {
                start_after: None,
                limit: None,
            },
        )
        .unwrap();
    assert_eq!(keys.keys.len(), 2);
    assert_eq!(keys.keys[0].pubkey, Key::remedy(1).pubkey);
    assert_eq!(s.config().next_remedy_key_id, 3);
    assert_eq!(
        s.exec(
            &admin,
            &ExecuteMsg::RetireRemedyKey {
                key_id: 9,
                compromised: false
            },
            &[]
        )
        .unwrap_err(),
        ContractError::UnknownRemedyKey { key_id: 9 }
    );
}

/// At instantiation: remedy keys after signer keys, so one equal to a signer
/// key or the admission key is refused; the registry is bounded (64 ids).
#[test]
fn instantiation_registers_remedy_keys_separately_and_bounded() {
    let mut s = Suite::new();
    let admin = s.admin.clone();
    let base = eighteen_cosmos_escrow::msg::InstantiateMsg {
        admin: admin.to_string(),
        operator: s.operator.to_string(),
        resolver: s.resolver.to_string(),
        treasury: s.treasury.to_string(),
        denom: DENOM.to_string(),
        params: default_params(),
        signer_keys: vec![Key::signer(1).pubkey],
        admission_pubkey: Key::admission(1).pubkey,
        remedy_keys: vec![],
    };
    let mut try_init = |msg: &eighteen_cosmos_escrow::msg::InstantiateMsg| {
        s.app
            .instantiate_contract(s.code_id, admin.clone(), msg, &[], "escrow", None)
            .map_err(contract_err)
    };
    for bad in [Key::signer(1), Key::admission(1)] {
        let msg = eighteen_cosmos_escrow::msg::InstantiateMsg {
            remedy_keys: vec![bad.pubkey],
            ..base.clone()
        };
        assert!(matches!(
            try_init(&msg).unwrap_err(),
            ContractError::InvalidParams { .. }
        ));
    }
    let too_many = eighteen_cosmos_escrow::msg::InstantiateMsg {
        remedy_keys: (1..=65).map(|n| Key::remedy(n).pubkey).collect(),
        ..base.clone()
    };
    assert_eq!(
        try_init(&too_many).unwrap_err(),
        ContractError::RemedyKeyIdsExhausted {}
    );
    let ok = eighteen_cosmos_escrow::msg::InstantiateMsg {
        remedy_keys: (1..=64).map(|n| Key::remedy(n).pubkey).collect(),
        ..base
    };
    let addr = try_init(&ok).unwrap();
    let resp: eighteen_cosmos_escrow::msg::ConfigResponse = s
        .app
        .wrap()
        .query_wasm_smart(addr, &QueryMsg::Config {})
        .unwrap();
    assert_eq!(resp.next_remedy_key_id, 65);
}

/// A 2.0.0 deployment migrated to this code has no remedy registry: its next
/// id reads as 1, nothing attests until the admin adds a key, and its own
/// 2.0.0 games refuse every remedy.
#[test]
fn a_migrated_2_0_0_deployment_starts_with_an_empty_remedy_registry() {
    let mut s = Suite::new();
    let old = live(&mut s, 3);
    s.make_legacy(old);
    // Erase the 2.1.0 registry: the 2.0.0 state has none.
    s.remove_raw(b"next_remedy_key_id");
    let mut key = 11u16.to_be_bytes().to_vec();
    key.extend_from_slice(b"remedy_keys");
    key.extend_from_slice(&1u16.to_be_bytes());
    s.remove_raw(&key);
    let mut index = 19u16.to_be_bytes().to_vec();
    index.extend_from_slice(b"remedy_pubkey_index");
    index.extend_from_slice(Key::remedy(1).pubkey.as_slice());
    s.remove_raw(&index);
    assert_eq!(s.config().next_remedy_key_id, 1);
    s.set_raw(
        b"contract_info",
        br#"{"contract":"crates.io:eighteen-cosmos-escrow","version":"2.0.0"}"#,
    );
    let admin = s.admin.clone();
    let contract = s.contract.clone();
    let code_id = s.code_id;
    s.app
        .migrate_contract(
            admin.clone(),
            contract,
            &eighteen_cosmos_escrow::msg::MigrateMsg {},
            code_id,
        )
        .unwrap();
    let a = s.attestation(old, RemedyKind::LiveTimeoutAnnul, 2, 0);
    let m = s.remedy_msg(&a);
    assert_eq!(refused(&mut s, &m), ContractError::RemedyNotAvailable {});
    let new = live(&mut s, 3);
    let a = s.attestation(new, RemedyKind::LiveTimeoutAnnul, 2, 0);
    let m = s.remedy_msg(&a);
    // No remedy key is registered yet.
    assert_eq!(
        refused(&mut s, &m),
        ContractError::UnknownRemedyKey { key_id: 1 }
    );
    let res = s
        .exec(
            &admin,
            &ExecuteMsg::AddRemedyKey {
                pubkey: Key::remedy(1).pubkey,
            },
            &[],
        )
        .unwrap();
    assert_eq!(attr(&res, "key_id"), "1");
    s.submit(&m).unwrap();
    assert_eq!(s.game(new).game.state, GameState::Annulled);
}
