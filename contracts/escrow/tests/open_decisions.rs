//! Behaviour pinned where the frozen design documents contradict themselves.
//!
//! Each test below reproduces a contradiction found in the adversarial review
//! of ESCROW-2. The contract implements the §9.1 transition table literally
//! (the amended document governs), and these tests pin exactly that, so an
//! owner decision that changes a rule has to change a named test here.
//! The report (claude/ESCROW2_CONTRACT_IMPLEMENTATION_2026-09-25.md) lists the
//! options for each.

mod common;

use common::*;
use cosmwasm_std::{coins, HexBinary, Uint128};
use eighteen_cosmos_escrow::msg::{ExecuteMsg, ResolveOutcome};
use eighteen_cosmos_escrow::payload::REASON_RESOLVER_CORRECTION;
use eighteen_cosmos_escrow::state::GameState;
use eighteen_cosmos_escrow::ContractError;

fn post_by(
    s: &mut Suite,
    id: u64,
    key_id: u16,
    key: &Key,
    log_len: u64,
    w: &[u128],
) -> Result<(), ContractError> {
    let mut p = s.checkpoint_payload(id, log_len, w);
    p.signer_key_id = key_id;
    let (payload, signature) = s.signed_by(&p, key);
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::Checkpoint {
            chain_game_id: id,
            payload,
            signature,
        },
        &[],
    )
    .map(|_| ())
}

/// OD-ESC2-1. §9.1 Finalize: "not paused … pause delays; liveness path below
/// still exits"; but LivenessSettle is defined only for IN_PROGRESS and
/// DISPUTED. While paused, a SETTLEABLE game whose window has closed can only
/// leave by a unanimous AnnulByConsent.
#[test]
fn od1_a_paused_settleable_game_has_no_exit_but_unanimous_annul() {
    let mut s = Suite::new();
    let (id, p) = s.settleable(3);
    s.advance(DAY);
    s.pause();
    s.advance(6 * 365 * DAY);
    let who = s.outsider.clone();
    let seat = s.players[0].clone();
    assert_eq!(
        s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
            .unwrap_err(),
        ContractError::Paused {}
    );
    let digest = s.consent_digest(id, &p);
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::Consent {
                chain_game_id: id,
                seat_index: 0,
                signature: Key::seat(0).sign(&digest),
            },
            &[],
        )
        .unwrap_err(),
        ContractError::Paused {}
    );
    assert!(matches!(
        s.exec(
            &seat,
            &ExecuteMsg::LivenessSettle { chain_game_id: id },
            &[]
        )
        .unwrap_err(),
        ContractError::WrongState { .. }
    ));
    let bond = s.bond(id);
    assert!(matches!(
        s.exec(
            &seat,
            &ExecuteMsg::Challenge {
                chain_game_id: id,
                evidence_hash: HexBinary::from(vec![1u8; 32]),
            },
            &coins(bond, DENOM),
        )
        .unwrap_err(),
        ContractError::WindowClosed { .. }
    ));
    assert_eq!(s.game(id).game.pool.u128(), 3 * NET);
    // The only exit while paused: every seat signs ANNUL.
    let sigs = s.annul_sigs(id, &[0, 1, 2], p.seq);
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents: sigs,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
    s.assert_custody();
}

/// OD-ESC2-1 (cont.). The IN_PROGRESS liveness exit works while paused, but it
/// leads into SETTLEABLE, where Finalize is paused.
#[test]
fn od1_the_liveness_exit_under_pause_ends_in_a_paused_settleable_game() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.post_checkpoint(id, 10, &[1, 3]);
    s.pause();
    s.advance(14 * DAY);
    let seat = s.players[1].clone();
    s.exec(
        &seat,
        &ExecuteMsg::LivenessSettle { chain_game_id: id },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Settleable);
    s.advance(DAY);
    assert_eq!(
        s.exec(&seat, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
            .unwrap_err(),
        ContractError::Paused {}
    );
    s.unpause();
    s.exec(&seat, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
        .unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

/// OD-ESC2-1 (cont.). Checkpoint is paused but the liveness clock is not: a
/// pause longer than the liveness window lets any seat settle the game on the
/// last checkpoint posted before the pause.
#[test]
fn od1_a_long_pause_lets_a_seat_settle_on_a_stale_checkpoint() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.post_checkpoint(id, 10, &[5, 1]);
    s.pause();
    let newer = s.checkpoint_payload(id, 500, &[1, 5]);
    let msg = s.checkpoint_msg(id, &newer);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &msg, &[]).unwrap_err(),
        ContractError::Paused {}
    );
    s.advance(14 * DAY);
    let favoured = s.players[0].clone();
    s.exec(
        &favoured,
        &ExecuteMsg::LivenessSettle { chain_game_id: id },
        &[],
    )
    .unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(st.payload.log_len.u64(), 10);
}

/// OD-ESC2-2. §10: "Emergency: Pause → RetireSignerKey{compromised:true} →
/// AddSignerKey → re-post fresh checkpoints → Unpause", but §9.1 refuses
/// Checkpoint while paused; the re-post has to wait for Unpause.
#[test]
fn od2_the_emergency_rotation_cannot_repost_while_paused() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.post_checkpoint(id, 10, &[1, 1]);
    s.pause();
    s.retire_key(1, true);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    assert_eq!(
        post_by(&mut s, id, 2, &key2, 11, &[1, 1]).unwrap_err(),
        ContractError::Paused {}
    );
    s.unpause();
    post_by(&mut s, id, 2, &key2, 11, &[1, 1]).unwrap();
}

/// OD-ESC2-3. §7.5 case 5: "The honest operator re-posts a fresh checkpoint
/// with the new key … the game then continues normally." With `seq > last_seq`
/// frozen, a forged checkpoint at a huge seq from the leaked key blocks every
/// later payload; the game can only end by liveness (here: refund, because the
/// only other checkpoint was the leaked key's own) or unanimous annul.
#[test]
fn od3_a_leaked_key_can_jam_last_seq() {
    let mut s = Suite::new();
    let id = s.started(2);
    let key1 = Key::signer(1);
    post_by(&mut s, id, 1, &key1, 40, &[1, 1]).unwrap();
    post_by(&mut s, id, 1, &key1, u64::MAX / 2, &[1, 0]).unwrap();
    assert_eq!(s.last_seq(id), u64::MAX - 1);
    s.pause();
    s.retire_key(1, true);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    s.unpause();
    assert_eq!(
        post_by(&mut s, id, 2, &key2, 41, &[1, 1]).unwrap_err(),
        ContractError::StaleSeq {
            seq: 82,
            last_seq: u64::MAX - 1
        }
    );
    let mut t = s.terminal_payload(id, 1, 41, &[1, 1]);
    t.signer_key_id = 2;
    let (payload, signature) = s.signed_by(&t, &key2);
    let who = s.outsider.clone();
    assert!(matches!(
        s.exec(
            &who,
            &ExecuteMsg::Settle {
                chain_game_id: id,
                payload,
                signature,
                consents: vec![],
            },
            &[],
        )
        .unwrap_err(),
        ContractError::StaleSeq { .. }
    ));
    s.advance(14 * DAY);
    let seat = s.players[0].clone();
    s.exec(
        &seat,
        &ExecuteMsg::LivenessSettle { chain_game_id: id },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Cancelled);
}

/// OD-ESC2-3 (cont.). A forged terminal at seq = u64::MAX leaves the resolver
/// Uphold or Annul only: no Replace can have a larger seq.
#[test]
fn od3_a_forged_max_seq_terminal_leaves_no_replace() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.settle(id, 1, u64::MAX / 2, &[1, 0], &[]);
    assert_eq!(s.last_seq(id), u64::MAX);
    s.challenge(id, 1);
    let fix = s.terminal_payload(id, REASON_RESOLVER_CORRECTION, 100, &[1, 1]);
    assert!(matches!(
        s.resolve(
            id,
            ResolveOutcome::Replace {
                payload: Suite::wire(&fix)
            }
        )
        .unwrap_err(),
        ContractError::StaleSeq { .. }
    ));
    s.resolve(id, ResolveOutcome::Annul {}).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
}

/// OD-ESC2-4. §7.5 case 3: "… or the contract accepts them in one tx if the
/// frontend batches them." A Checkpoint refreshes last_activity (frozen
/// definition), so a LivenessSettle in the same block is refused.
#[test]
fn od4_checkpoint_and_liveness_cannot_share_a_block() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.post_checkpoint(id, 10, &[1, 1]);
    s.advance(14 * DAY);
    s.post_checkpoint(id, 20, &[2, 1]);
    let seat = s.players[0].clone();
    assert!(matches!(
        s.exec(
            &seat,
            &ExecuteMsg::LivenessSettle { chain_game_id: id },
            &[]
        )
        .unwrap_err(),
        ContractError::LivenessNotReached { .. }
    ));
}

/// OD-ESC2-5. §15: admin compromise → "cannot move funds … residual: delay;
/// refund-shaped outcome". The frozen admin powers AddSignerKey + SetResolver
/// combine into a payout to an accomplice seat when an honest seat challenges.
#[test]
fn od5_a_compromised_admin_with_an_accomplice_seat_can_route_a_pool() {
    let mut s = Suite::new();
    let id = s.started(3);
    let rogue = Key::from_label("18JUNO/TEST/rogue-admin-key");
    let key_id = s.add_key(&rogue);
    let mut t = s.terminal_payload(id, 1, 50, &[0, 0, 1]);
    t.signer_key_id = key_id;
    let (payload, signature) = s.signed_by(&t, &rogue);
    let admin = s.admin.clone();
    s.exec(
        &admin,
        &ExecuteMsg::Settle {
            chain_game_id: id,
            payload,
            signature,
            consents: vec![],
        },
        &[],
    )
    .unwrap();
    s.challenge(id, 0);
    let bond = s.bond(id);
    s.exec(
        &admin,
        &ExecuteMsg::SetResolver {
            resolver: admin.to_string(),
        },
        &[],
    )
    .unwrap();
    let accomplice = s.players[2].clone();
    let before = s.balance(&accomplice);
    s.exec(
        &admin,
        &ExecuteMsg::Resolve {
            chain_game_id: id,
            outcome: ResolveOutcome::Uphold {},
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.balance(&accomplice) - before, 3 * NET + bond);
    assert_eq!(s.game(id).game.pool, Uint128::zero());
}
