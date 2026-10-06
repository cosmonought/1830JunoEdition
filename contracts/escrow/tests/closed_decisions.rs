//! Regression tests for the ESCROW-2 owner decisions, all CLOSED in ESCROW-2.1.
//!
//! These cases pinned contradictions in the frozen documents during ESCROW-2
//! (`open_decisions.rs`). The owner decided each one; the tests below now pin
//! the decided behaviour:
//!
//! * OD-ESC2-1 — a SETTLEABLE liveness exit (`window_end + liveness_window`,
//!   works while paused) and Checkpoint allowed while paused: a pause may delay
//!   normal operation but never trap funds.
//! * OD-ESC2-2 — the emergency rotation re-posts a fresh checkpoint while still
//!   paused.
//! * OD-ESC2-3 — evidence signed by a key later marked compromised loses its
//!   sequence authority; a resolver correction may use the same (or an earlier)
//!   terminal log position.
//! * OD-ESC2-4 — `LivenessSettle` may carry the newer checkpoint and promote it
//!   in the same transaction.
//! * OD-ESC2-5 — each game freezes its resolver at Start.
//!
//! Plus the required hardening: consent keys are unique within a game.
//!
//! Escrow 2.1.0: the IN_PROGRESS halves of OD-ESC2-1 and OD-ESC2-4 (the
//! in-progress liveness exit, and a checkpoint carried into it) are 2.0.0
//! semantics, kept only by a game stored by 2.0.0 code; those tests run on
//! such games (`Suite::new_legacy`). A 2.1.0 game refuses the IN_PROGRESS exit
//! (`tests/escrow21.rs`), so for it OD-ESC2-1 holds for SETTLEABLE and
//! DISPUTED only: an indefinite admin pause blocks `Settle`, and an
//! IN_PROGRESS 2.1.0 game then exits only by unanimous `AnnulByConsent` (or, if
//! No-deadline, the resolver's `ReviewAnnul`).

mod common;

use common::*;
use cosmwasm_std::{coins, Uint128};
use cw_multi_test::Executor;
use eighteen_cosmos_escrow::msg::{ExecuteMsg, ResolveOutcome, SeatSignature};
use eighteen_cosmos_escrow::payload::REASON_RESOLVER_CORRECTION;
use eighteen_cosmos_escrow::state::{GameState, Mode, Route};
use eighteen_cosmos_escrow::ContractError;

const LIVENESS: u64 = 14 * DAY;

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

// ------------------------------------------------------------ OD-ESC2-1

/// Previously: a paused SETTLEABLE game past its window could only leave by
/// unanimous annul. Now LivenessSettle pays it from `window_end + liveness`.
#[test]
fn od1_a_paused_settleable_game_exits_by_liveness() {
    let mut s = Suite::new();
    let (id, p) = s.settleable(3);
    s.advance(DAY);
    s.pause();
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
            .unwrap_err(),
        ContractError::Paused {},
        "Finalize itself stays blocked while paused"
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
    s.advance(LIVENESS);
    s.liveness(id, 0, None).unwrap();
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settled);
    assert_eq!(g.outcome.unwrap().route, Route::SettleableTimeoutPayout);
    assert!(s.config().config.paused, "never unpaused");
    assert_eq!(s.contract_balance(), 0);
}

/// Previously: the IN_PROGRESS liveness exit led into a paused SETTLEABLE game.
/// Now the whole path completes without an unpause.
#[test]
fn od1_the_whole_liveness_path_completes_under_a_permanent_pause() {
    let mut s = Suite::new_legacy();
    let id = s.started(2);
    s.post_checkpoint(id, 10, &[1, 3]);
    s.pause();
    s.advance(LIVENESS);
    s.liveness(id, 1, None).unwrap();
    assert_eq!(s.state(id), GameState::Settleable);
    s.advance(DAY + LIVENESS);
    s.liveness(id, 1, None).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    assert_eq!(
        s.game(id).game.outcome.unwrap().amounts,
        vec![Uint128::new(975_000), Uint128::new(2_925_000)]
    );
    assert!(s.config().config.paused);
}

/// Previously: Checkpoint was paused while the liveness clock ran, so a long
/// pause let a seat settle on a stale checkpoint. Now the newer checkpoint can
/// be posted during the pause and restarts the clock.
#[test]
fn od1_checkpoints_keep_flowing_during_a_pause() {
    let mut s = Suite::new_legacy();
    let id = s.started(2);
    s.post_checkpoint(id, 10, &[5, 1]);
    s.pause();
    s.advance(10 * DAY);
    s.post_checkpoint(id, 500, &[1, 5]);
    s.advance(10 * DAY);
    let favoured = s.players[0].clone();
    assert!(matches!(
        s.exec(&favoured, &Suite::liveness_msg(id), &[])
            .unwrap_err(),
        ContractError::LivenessNotReached { .. }
    ));
    s.advance(4 * DAY);
    s.exec(&favoured, &Suite::liveness_msg(id), &[]).unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(
        st.payload.log_len.u64(),
        500,
        "the newest checkpoint is used"
    );
}

/// Checkpoint is allowed while paused; Settle is not.
#[test]
fn od1_pause_admits_checkpoint_but_not_settle() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.pause();
    s.post_checkpoint(id, 10, &[1, 1]);
    let p = s.terminal_payload(id, 1, 20, &[1, 1]);
    let msg = s.settle_msg(id, &p, &[0, 1]);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &msg, &[]).unwrap_err(),
        ContractError::Paused {}
    );
    s.unpause();
    s.exec(&who, &msg, &[]).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

// ------------------------------------------------------------ OD-ESC2-2

/// Pause → RetireSignerKey(old, compromised) → AddSignerKey(new) → post a fresh
/// Checkpoint while still paused → Unpause.
#[test]
fn od2_the_emergency_rotation_reposts_while_paused() {
    let mut s = Suite::new();
    let id = s.started(2);
    post_by(&mut s, id, 1, &Key::signer(1), 10, &[1, 1]).unwrap();
    // The leaked key forges a far-future checkpoint before anyone reacts.
    post_by(&mut s, id, 1, &Key::signer(1), 1_000_000, &[1, 0]).unwrap();
    s.pause();
    s.retire_key(1, true);
    let key2 = Key::signer(2);
    assert_eq!(s.add_key(&key2), 2);
    post_by(&mut s, id, 2, &key2, 11, &[1, 1]).unwrap();
    assert_eq!(s.trusted_seq(id), 22);
    s.unpause();
    // Normal play continues from the honest boundary.
    let mut t = s.terminal_payload(id, 1, 30, &[3, 1]);
    t.signer_key_id = 2;
    let (payload, signature) = s.signed_by(&t, &key2);
    let consents = s.consents(id, &t, &[0, 1]);
    let op = s.operator.clone();
    s.exec(
        &op,
        &ExecuteMsg::Settle {
            chain_game_id: id,
            payload,
            signature,
            consents,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

// ------------------------------------------------------------ OD-ESC2-3

/// Previously: a forged checkpoint at a huge seq blocked every later payload
/// and the game could only end by liveness refund. Now honest progress resumes
/// and ends in a normal settlement.
#[test]
fn od3_a_leaked_key_cannot_jam_the_sequence() {
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
    // Every key-1 checkpoint is gone from the authority, honest or forged.
    assert_eq!(s.trusted_seq(id), 0);
    post_by(&mut s, id, 2, &key2, 41, &[1, 1]).unwrap();
    assert_eq!(s.trusted_seq(id), 82);
    s.unpause();
    // Anti-replay among trusted evidence still holds.
    assert_eq!(
        post_by(&mut s, id, 2, &key2, 41, &[1, 1]).unwrap_err(),
        ContractError::StaleSeq {
            seq: 82,
            trusted_seq: 82
        }
    );
    assert_eq!(
        post_by(&mut s, id, 2, &key2, 30, &[1, 1]).unwrap_err(),
        ContractError::StaleSeq {
            seq: 60,
            trusted_seq: 82
        }
    );
    // A retired key's old honest checkpoint cannot come back either.
    assert_eq!(
        post_by(&mut s, id, 1, &key1, 42, &[1, 1]).unwrap_err(),
        ContractError::RetiredSignerKey { key_id: 1 }
    );
    let mut t = s.terminal_payload(id, 1, 50, &[1, 3]);
    t.signer_key_id = 2;
    let (payload, signature) = s.signed_by(&t, &key2);
    let consents = s.consents(id, &t, &[0, 1]);
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::Settle {
            chain_game_id: id,
            payload,
            signature,
            consents,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Settled, "not a refund");
    assert_eq!(
        s.last_seq(id),
        u64::MAX - 1,
        "raw history is kept for audit"
    );
}

/// Previously: a forged terminal at seq = u64::MAX left the resolver Uphold or
/// Annul only. Now Replace corrects it at the real, lower log position.
#[test]
fn od3_a_forged_max_seq_terminal_is_replaced_at_the_real_log_position() {
    let mut s = Suite::new();
    let id = s.started(2);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    post_by(&mut s, id, 2, &key2, 90, &[1, 1]).unwrap();
    // Key 1 leaks: a forged terminal at the largest seq there is.
    s.settle(id, 1, u64::MAX / 2, &[1, 0], &[]);
    assert_eq!(s.last_seq(id), u64::MAX);
    s.challenge(id, 1);
    s.retire_key(1, true);
    assert_eq!(
        s.trusted_seq(id),
        180,
        "the forged terminal lost its authority"
    );
    // Below the latest trusted checkpoint: still refused (old trusted replay).
    let early = s.terminal_payload(id, REASON_RESOLVER_CORRECTION, 89, &[1, 1]);
    assert_eq!(
        s.resolve(
            id,
            ResolveOutcome::Replace {
                payload: Suite::wire(&early)
            }
        )
        .unwrap_err(),
        ContractError::StaleSeq {
            seq: 179,
            trusted_seq: 180
        }
    );
    let real = s.terminal_payload(id, REASON_RESOLVER_CORRECTION, 100, &[1, 3]);
    s.resolve(
        id,
        ResolveOutcome::Replace {
            payload: Suite::wire(&real),
        },
    )
    .unwrap();
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settled);
    assert_eq!(g.settlement.unwrap().payload.log_len.u64(), 100);
    assert_eq!(
        g.outcome.unwrap().amounts,
        vec![Uint128::new(975_000), Uint128::new(2_925_000)]
    );
}

/// A forged CHECKPOINT under the compromised key does not raise the Replace
/// floor either: only trusted checkpoints constrain a correction (review
/// finding, ESCROW-2.1).
#[test]
fn od3_a_forged_checkpoint_does_not_raise_the_replace_floor() {
    let mut s = Suite::new();
    let id = s.started(2);
    let key1 = Key::signer(1);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    post_by(&mut s, id, 2, &key2, 40, &[1, 1]).unwrap();
    post_by(&mut s, id, 1, &key1, 1_000_000, &[1, 0]).unwrap();
    s.settle(id, 1, 1_000_001, &[1, 0], &[]);
    s.challenge(id, 1);
    s.retire_key(1, true);
    assert_eq!(s.checkpoints(id).liveness_candidate_seq.unwrap().u64(), 80);
    let behind = s.terminal_payload(id, REASON_RESOLVER_CORRECTION, 39, &[1, 3]);
    assert_eq!(
        s.resolve(
            id,
            ResolveOutcome::Replace {
                payload: Suite::wire(&behind)
            }
        )
        .unwrap_err(),
        ContractError::StaleSeq {
            seq: 79,
            trusted_seq: 80
        }
    );
    let fix = s.terminal_payload(id, REASON_RESOLVER_CORRECTION, 60, &[1, 3]);
    s.resolve(
        id,
        ResolveOutcome::Replace {
            payload: Suite::wire(&fix),
        },
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    assert_eq!(s.last_seq(id), 2_000_003, "raw history is kept");
}

/// A resolver correction may name the same terminal log position as the
/// disputed (honestly signed but wrong) terminal.
#[test]
fn od3_a_same_log_position_correction_is_legal() {
    let mut s = Suite::new();
    let (id, disputed) = s.disputed(2); // terminal at log 100
    let fix = s.terminal_payload(id, REASON_RESOLVER_CORRECTION, 100, &[1, 1]);
    assert_eq!(fix.seq, disputed.seq);
    s.resolve(
        id,
        ResolveOutcome::Replace {
            payload: Suite::wire(&fix),
        },
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

// ------------------------------------------------------------ OD-ESC2-4

/// Previously: a Checkpoint reset `last_activity`, so it could never share a
/// transaction with LivenessSettle. Now LivenessSettle carries it.
#[test]
fn od4_checkpoint_and_liveness_share_one_transaction() {
    let mut s = Suite::new_legacy();
    let id = s.started(2);
    s.post_checkpoint(id, 10, &[1, 1]);
    s.advance(LIVENESS);
    let (newer, carried) = s.signed_checkpoint(id, 1, &Key::signer(1), 20, &[2, 1]);
    s.liveness(id, 0, Some(carried)).unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&newer).to_vec()
    );
    // An ordinary Checkpoint still restarts the clock (checked elsewhere too).
    let other = s.started(2);
    s.advance(LIVENESS);
    s.post_checkpoint(other, 10, &[1, 1]);
    assert!(matches!(
        s.liveness(other, 0, None).unwrap_err(),
        ContractError::LivenessNotReached { .. }
    ));
}

/// The ABI change is additive: the ESCROW-2 JSON (no `checkpoint` field) and
/// an explicit `null` both still decode to, and execute as, the plain exit.
#[test]
fn od4_the_escrow_2_liveness_json_still_executes() {
    let legacy = br#"{"liveness_settle":{"chain_game_id":7}}"#;
    let explicit_null = br#"{"liveness_settle":{"chain_game_id":7,"checkpoint":null}}"#;
    for raw in [&legacy[..], &explicit_null[..]] {
        assert_eq!(
            cosmwasm_std::from_json::<ExecuteMsg>(raw).unwrap(),
            ExecuteMsg::LivenessSettle {
                chain_game_id: 7,
                checkpoint: None
            }
        );
    }
    let mut s = Suite::new_legacy();
    let id = s.started(2);
    s.advance(LIVENESS);
    let who = s.players[0].clone();
    let contract = s.contract.clone();
    s.app
        .execute_contract(
            who,
            contract,
            &serde_json::json!({ "liveness_settle": { "chain_game_id": id } }),
            &[],
        )
        .unwrap();
    assert_eq!(s.state(id), GameState::Cancelled);
}

// ------------------------------------------------------------ OD-ESC2-5

/// Previously: admin → SetResolver(self) → Uphold routed a started game's pool.
/// Now the game keeps the resolver it adopted at Start.
#[test]
fn od5_the_admin_cannot_become_a_started_games_resolver() {
    let mut s = Suite::new();
    let id = s.started(3);
    let rogue = Key::from_label("18JUNO/TEST/rogue-admin-key");
    let key_id = s.add_key(&rogue);
    let mut t = s.terminal_payload(id, 1, 50, &[0, 0, 1]);
    t.signer_key_id = key_id;
    let (payload, signature) = s.signed_by(&t, &rogue);
    let admin = s.admin.clone();
    // Documented residual: the admin controls the signer registry, so admin
    // compromise escalates to signer compromise; the forged terminal still
    // lands in SETTLEABLE and has to survive the challenge window.
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
    assert_eq!(s.state(id), GameState::Settleable);
    s.challenge(id, 0);
    s.exec(
        &admin,
        &ExecuteMsg::SetResolver {
            resolver: admin.to_string(),
        },
        &[],
    )
    .unwrap();
    assert_eq!(
        s.exec(
            &admin,
            &ExecuteMsg::Resolve {
                chain_game_id: id,
                outcome: ResolveOutcome::Uphold {},
            },
            &[],
        )
        .unwrap_err(),
        ContractError::Unauthorized {
            role: "resolver".to_string()
        }
    );
    // The game's own resolver adjudicates: here, a refund.
    let before = s.balance(&s.players[2]);
    s.resolve(id, ResolveOutcome::Annul {}).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
    assert_eq!(s.balance(&s.players[2]) - before, NET);
    s.assert_custody();
}

// ------------------------------------------------ consent-key uniqueness

/// Previously documented as delegation: a shared consent key signed for two
/// seats. Keys are now unique per game.
#[test]
fn consent_keys_are_unique_within_a_game() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    let bob = s.players[2].clone();
    assert_eq!(
        s.exec(
            &bob,
            &ExecuteMsg::Join {
                chain_game_id: id,
                consent_pubkey: Key::seat(1).pubkey,
                join_ticket: ticket("bob"),
                admission: s.admission_for(id, &bob, &ticket("bob")),
            },
            &coins(ANTE, DENOM),
        )
        .unwrap_err(),
        ContractError::ConsentKeyInUse { seat_index: 1 }
    );
    s.join(id, 2, ANTE);
    s.start(id);
    let alice = s.players[1].clone();
    assert_eq!(
        s.exec(
            &alice,
            &ExecuteMsg::SetConsentKey {
                chain_game_id: id,
                new_pubkey: Key::seat(2).pubkey,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::ConsentKeyInUse { seat_index: 2 }
    );
    // One key's signature can satisfy only its own seat.
    let p = s.terminal_payload(id, 1, 40, &[1, 1, 1]);
    let digest = s.consent_digest(id, &p);
    let sig = Key::seat(0).sign(&digest);
    let (payload, signature) = s.signed(&p);
    let op = s.operator.clone();
    assert_eq!(
        s.exec(
            &op,
            &ExecuteMsg::Settle {
                chain_game_id: id,
                payload,
                signature,
                consents: vec![
                    SeatSignature {
                        seat_index: 0,
                        signature: sig.clone(),
                    },
                    SeatSignature {
                        seat_index: 1,
                        signature: sig,
                    },
                ],
            },
            &[],
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 1 }
    );
}
