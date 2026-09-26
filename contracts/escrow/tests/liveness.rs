//! LivenessSettle: the exit nobody can switch off. IN_PROGRESS inactivity
//! (ESCROW-1.5 §7.5, cases 1–5) and DISPUTED past the resolver timeout (§8.3).

mod common;

use common::*;
use cosmwasm_std::{coins, Addr, HexBinary, Uint128, Uint64};
use cw_multi_test::AppResponse;
use eighteen_cosmos_escrow::msg::{ExecuteMsg, ResolveOutcome, SignedCheckpoint};
use eighteen_cosmos_escrow::payload::{Payload, REASON_RESOLVER_CORRECTION};
use eighteen_cosmos_escrow::state::{DisputeResolution, GameState, Mode, Route, SettlementSource};
use eighteen_cosmos_escrow::ContractError;

const LIVENESS: u64 = 14 * DAY;
const RESOLVER_TIMEOUT: u64 = 30 * DAY;

fn liveness(s: &mut Suite, id: u64, seat: usize) -> Result<AppResponse, ContractError> {
    let who = s.players[seat].clone();
    s.exec(
        &who,
        &ExecuteMsg::LivenessSettle {
            chain_game_id: id,
            checkpoint: None,
        },
        &[],
    )
}

fn post_checkpoint_by(
    s: &mut Suite,
    id: u64,
    key_id: u16,
    key: &Key,
    log_len: u64,
    weights: &[u128],
) -> Payload {
    let mut p = s.checkpoint_payload(id, log_len, weights);
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
    .unwrap();
    p
}

fn deltas<F: FnOnce(&mut Suite) -> AppResponse>(
    s: &mut Suite,
    n: usize,
    f: F,
) -> (Vec<u128>, u128, AppResponse) {
    let players: Vec<Addr> = s.players[..n].to_vec();
    let treasury = s.treasury.clone();
    let before: Vec<u128> = players.iter().map(|a| s.balance(a)).collect();
    let t0 = s.balance(&treasury);
    let res = f(s);
    let after: Vec<u128> = players.iter().map(|a| s.balance(a)).collect();
    let d = after
        .iter()
        .zip(before.iter())
        .map(|(a, b)| a - b)
        .collect();
    (d, s.balance(&treasury) - t0, res)
}

fn split(pool: u128, weights: &[u128]) -> Vec<u128> {
    let sum: u128 = weights.iter().sum();
    weights.iter().map(|w| pool * w / sum).collect()
}

fn finalize(s: &mut Suite, id: u64) {
    let who = s.outsider.clone();
    s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
        .unwrap();
}

// ------------------------------------------------------------- IN_PROGRESS

#[test]
fn not_before_the_liveness_window_and_exactly_at_it() {
    let mut s = Suite::new();
    let id = s.started(3);
    let at = s.now().plus_seconds(LIVENESS);
    assert_eq!(s.game(id).deadlines.liveness_available_at, Some(at));
    s.advance(LIVENESS - 1);
    for seat in 0..3 {
        assert_eq!(
            liveness(&mut s, id, seat).unwrap_err(),
            ContractError::LivenessNotReached { at }
        );
    }
    s.advance(1);
    liveness(&mut s, id, 2).unwrap();
    assert_eq!(s.state(id), GameState::Cancelled);
}

#[test]
fn case_1_no_checkpoint_refunds_every_net_ante() {
    let mut s = Suite::new();
    let id = s.started(3);
    s.advance(LIVENESS);
    let (d, t, res) = deltas(&mut s, 3, |s| liveness(s, id, 1).unwrap());
    assert_eq!(attr(&res, "path"), "refund");
    assert_eq!(attr(&res, "state"), "cancelled");
    assert_eq!(d, vec![NET, NET, NET]);
    assert_eq!(t, 0);
    let g = s.game(id).game;
    assert_eq!(g.pool, Uint128::zero());
    let o = g.outcome.unwrap();
    assert_eq!(o.route, Route::LivenessRefund);
    assert_eq!(o.distributed.u128(), 3 * NET);
    assert_eq!(s.contract_balance(), 0);
    // Repeats and every other message are refused now.
    assert!(matches!(
        liveness(&mut s, id, 1).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    s.assert_custody();
}

#[test]
fn case_2_a_checkpoint_becomes_the_settlement_with_a_fresh_window() {
    let mut s = Suite::new();
    let id = s.started(3);
    let weights = [4u128, 1, 2];
    let p = s.post_checkpoint(id, 50, &weights);
    s.advance(LIVENESS);
    let t = s.now();
    let res = liveness(&mut s, id, 0).unwrap();
    assert_eq!(attr(&res, "path"), "checkpoint");
    assert!(bank_sends(&res).is_empty());
    let gr = s.game(id);
    let g = gr.game;
    assert_eq!(g.state, GameState::Settleable);
    assert_eq!(g.consent_bitmap, 0);
    assert_eq!(g.last_seq.u64(), 100);
    let st = g.settlement.unwrap();
    assert_eq!(st.source, SettlementSource::LivenessCheckpoint);
    assert_eq!(st.accepted_at, t);
    assert_eq!(st.window_end, t.plus_seconds(DAY));
    assert_eq!(st.payload.seq.u64(), 100);
    assert_eq!(st.payload.reason, 0, "recorded as RoundBoundary");
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&p).to_vec()
    );
    assert_eq!(gr.deadlines.challenge_window_end, Some(t.plus_seconds(DAY)));
    s.advance(DAY);
    let (d, _, _) = deltas(&mut s, 3, |s| {
        let who = s.outsider.clone();
        s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
            .unwrap()
    });
    assert_eq!(d, split(3 * NET, &weights));
    assert_eq!(s.game(id).game.outcome.unwrap().route, Route::Finalized);
    s.assert_custody();
}

#[test]
fn async_games_get_the_async_window_after_liveness() {
    let mut s = Suite::new();
    let id = s.started_with(2, Mode::Async, ANTE);
    s.post_checkpoint(id, 5, &[1, 1]);
    s.advance(LIVENESS);
    let t = s.now();
    liveness(&mut s, id, 1).unwrap();
    assert_eq!(
        s.game(id).game.settlement.unwrap().window_end,
        t.plus_seconds(2 * DAY)
    );
}

#[test]
fn every_checkpoint_refreshes_the_liveness_clock() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.advance(10 * DAY);
    s.post_checkpoint(id, 10, &[1, 1]);
    let at = s.now().plus_seconds(LIVENESS);
    assert_eq!(s.game(id).deadlines.liveness_available_at, Some(at));
    s.advance(5 * DAY);
    assert_eq!(
        liveness(&mut s, id, 0).unwrap_err(),
        ContractError::LivenessNotReached { at }
    );
    // Documented: a checkpoint posted after the window opened pushes it back
    // (last_activity = block time of the last Start/Checkpoint, §7.5).
    s.advance(10 * DAY);
    s.post_checkpoint(id, 20, &[1, 1]);
    let at = s.now().plus_seconds(LIVENESS);
    assert_eq!(
        liveness(&mut s, id, 0).unwrap_err(),
        ContractError::LivenessNotReached { at }
    );
    s.advance(LIVENESS);
    liveness(&mut s, id, 0).unwrap();
    assert_eq!(s.game(id).game.settlement.unwrap().payload.seq.u64(), 40);
}

#[test]
fn works_while_paused_and_only_for_seated_wallets() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.advance(LIVENESS);
    s.pause();
    for who in [
        s.admin.clone(),
        s.operator.clone(),
        s.resolver.clone(),
        s.outsider.clone(),
        s.players[4].clone(),
    ] {
        assert_eq!(
            s.exec(
                &who,
                &ExecuteMsg::LivenessSettle {
                    chain_game_id: id,
                    checkpoint: None
                },
                &[]
            )
            .unwrap_err(),
            ContractError::NotSeated { chain_game_id: id }
        );
    }
    let alice = s.players[1].clone();
    assert_eq!(
        s.exec(
            &alice,
            &ExecuteMsg::LivenessSettle {
                chain_game_id: id,
                checkpoint: None
            },
            &coins(1, DENOM)
        )
        .unwrap_err(),
        ContractError::NonPayable {}
    );
    liveness(&mut s, id, 1).unwrap();
    assert_eq!(s.state(id), GameState::Cancelled);
    s.assert_custody();
}

#[test]
fn case_5_compromised_key_falls_back_to_the_previous_usable_checkpoint() {
    let mut s = Suite::new();
    let id = s.started(3);
    let key1 = Key::signer(1);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    post_checkpoint_by(&mut s, id, 1, &key1, 100, &[1, 1, 1]);
    let honest = post_checkpoint_by(&mut s, id, 2, &key2, 150, &[2, 3, 5]);
    // Key 1 leaks; a forged checkpoint pays everything to seat 0.
    post_checkpoint_by(&mut s, id, 1, &key1, 200, &[1, 0, 0]);
    s.pause();
    s.retire_key(1, true);
    let cps = s.checkpoints(id);
    assert_eq!(cps.liveness_candidate_seq, Some(Uint64::new(300)));
    s.advance(LIVENESS);
    liveness(&mut s, id, 2).unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(st.payload.signer_key_id, 2);
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&honest).to_vec()
    );
    s.unpause();
    s.advance(DAY);
    let (d, _, _) = deltas(&mut s, 3, |s| {
        let who = s.outsider.clone();
        s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
            .unwrap()
    });
    assert_eq!(d, split(3 * NET, &[2, 3, 5]));
    s.assert_custody();
}

#[test]
fn every_checkpoint_compromised_means_refund() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.post_checkpoint(id, 100, &[0, 1]);
    s.retire_key(1, true);
    s.advance(LIVENESS);
    let (d, _, res) = deltas(&mut s, 2, |s| liveness(s, id, 1).unwrap());
    assert_eq!(attr(&res, "path"), "refund");
    assert_eq!(d, vec![NET, NET]);
    assert_eq!(s.state(id), GameState::Cancelled);
}

#[test]
fn a_planned_retirement_keeps_its_checkpoints_usable() {
    let mut s = Suite::new();
    let id = s.started(2);
    let p = s.post_checkpoint(id, 100, &[3, 1]);
    s.add_key(&Key::signer(2));
    s.retire_key(1, false);
    s.advance(LIVENESS);
    liveness(&mut s, id, 0).unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&p).to_vec()
    );
}

#[test]
fn a_forged_huge_seq_checkpoint_loses_authority_once_its_key_is_compromised() {
    // OD-ESC2-3: compromised signer evidence loses sequence authority.
    let mut s = Suite::new();
    let id = s.started(2);
    let key1 = Key::signer(1);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    post_checkpoint_by(&mut s, id, 2, &key2, 40, &[1, 1]);
    // Key 1 leaks and posts the largest representable checkpoint.
    let mut forged = s.checkpoint_payload(id, u64::MAX / 2, &[1, 0]);
    forged.signer_key_id = 1;
    let (payload, signature) = s.signed_by(&forged, &key1);
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
    .unwrap();
    assert_eq!(s.last_seq(id), u64::MAX - 1);
    assert_eq!(s.trusted_seq(id), u64::MAX - 1);
    let next = |s: &Suite| {
        let mut p = s.checkpoint_payload(id, 60, &[2, 1]);
        p.signer_key_id = 2;
        let (payload, signature) = s.signed_by(&p, &Key::signer(2));
        (
            p,
            ExecuteMsg::Checkpoint {
                chain_game_id: id,
                payload,
                signature,
            },
        )
    };
    // Until the key is marked compromised, the forgery keeps its authority.
    let (_, msg) = next(&s);
    assert_eq!(
        s.exec(&who, &msg, &[]).unwrap_err(),
        ContractError::StaleSeq {
            seq: 120,
            trusted_seq: u64::MAX - 1
        }
    );
    // Once it is, the floor falls back to the honest evidence ...
    s.retire_key(1, true);
    assert_eq!(s.trusted_seq(id), 80);
    assert_eq!(
        s.last_seq(id),
        u64::MAX - 1,
        "raw history is kept for audit"
    );
    // ... and the honest key resumes forward progress.
    let (honest_next, msg) = next(&s);
    s.exec(&who, &msg, &[]).unwrap();
    assert_eq!(s.trusted_seq(id), 120);
    // Liveness uses the newest honest boundary, never the forgery.
    s.advance(LIVENESS);
    liveness(&mut s, id, 1).unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&honest_next).to_vec()
    );
    s.advance(DAY);
    finalize(&mut s, id);
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(
        o.amounts,
        vec![Uint128::new(2_600_000), Uint128::new(1_300_000)]
    );
}

#[test]
fn consents_can_complete_a_liveness_settlement_early() {
    let mut s = Suite::new();
    let id = s.started(3);
    let p = s.post_checkpoint(id, 70, &[1, 2, 3]);
    s.advance(LIVENESS);
    liveness(&mut s, id, 0).unwrap();
    let digest = s.consent_digest(id, &p);
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
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settled);
    assert_eq!(g.outcome.unwrap().route, Route::ConsentCompleted);
    s.assert_custody();
}

#[test]
fn a_liveness_settlement_can_be_challenged_resolved_or_annulled() {
    let mut s = Suite::new();
    // Challenged, then replaced by the resolver.
    let a = s.started(2);
    s.post_checkpoint(a, 70, &[1, 0]);
    s.advance(LIVENESS);
    liveness(&mut s, a, 0).unwrap();
    s.challenge(a, 1);
    let fix = s.terminal_payload(a, REASON_RESOLVER_CORRECTION, 90, &[1, 1]);
    s.resolve(
        a,
        ResolveOutcome::Replace {
            payload: Suite::wire(&fix),
        },
    )
    .unwrap();
    assert_eq!(
        s.game(a).game.outcome.unwrap().amounts,
        vec![Uint128::new(NET), Uint128::new(NET)]
    );
    // Annulled by every seat at the checkpoint's seq.
    let b = s.started(2);
    s.post_checkpoint(b, 70, &[1, 0]);
    s.advance(LIVENESS);
    liveness(&mut s, b, 0).unwrap();
    let consents = s.annul_sigs(b, &[0, 1], 140);
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: b,
            consents,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(b), GameState::Annulled);
    s.assert_custody();
}

#[test]
fn liveness_needs_in_progress_settleable_or_disputed() {
    let mut s = Suite::new();
    let funding = s.create(0, 3, Mode::Live, ANTE);
    let funded = s.funded(2);
    let settled = s.settled(2);
    let cancelled = s.cancelled(2);
    let annulled = s.annulled(2);
    s.advance(60 * DAY);
    for (id, actual) in [
        (funding, "funding"),
        (funded, "funded"),
        (settled, "settled"),
        (cancelled, "cancelled"),
        (annulled, "annulled"),
    ] {
        assert_eq!(
            liveness(&mut s, id, 0).unwrap_err(),
            ContractError::WrongState {
                expected: "in_progress or settleable or disputed".to_string(),
                actual: actual.to_string()
            }
        );
    }
    s.assert_custody();
}

// ---------------------------------------------------------------- DISPUTED

#[test]
fn resolver_timeout_not_before_thirty_days() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(2);
    let at = s.now().plus_seconds(RESOLVER_TIMEOUT);
    assert_eq!(s.game(id).deadlines.resolver_timeout_at, Some(at));
    s.advance(RESOLVER_TIMEOUT - 1);
    assert_eq!(
        liveness(&mut s, id, 1).unwrap_err(),
        ContractError::ResolverTimeoutNotReached { at }
    );
    s.advance(1);
    liveness(&mut s, id, 1).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

#[test]
fn resolver_timeout_pays_the_stored_settlement_and_returns_the_bond() {
    let mut s = Suite::new();
    let (id, p) = s.disputed(3);
    let bond = s.bond(id);
    s.advance(RESOLVER_TIMEOUT);
    let t = s.now();
    let (d, dust, res) = deltas(&mut s, 3, |s| liveness(s, id, 0).unwrap());
    assert_eq!(attr(&res, "path"), "resolver_timeout_payout");
    let mut expected = split(3 * NET, &p.settlement_weights);
    let expected_dust = 3 * NET - expected.iter().sum::<u128>();
    expected[1] += bond; // seat 1 challenged: bond back, not forfeited
    assert_eq!(d, expected);
    assert_eq!(dust, expected_dust);
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settled);
    let o = g.outcome.unwrap();
    assert_eq!(o.route, Route::ResolverTimeoutPayout);
    assert_eq!(o.bond_returned.u128(), bond);
    assert_eq!(o.bond_to_pool, Uint128::zero());
    let dispute = g.dispute.unwrap();
    assert_eq!(dispute.resolution, Some(DisputeResolution::ResolverTimeout));
    assert_eq!(dispute.resolved_at, Some(t));
    assert_eq!(s.contract_balance(), 0);
    s.assert_custody();
}

#[test]
fn resolver_timeout_works_while_paused_for_any_seat() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(3);
    s.pause();
    s.advance(RESOLVER_TIMEOUT);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::LivenessSettle {
                chain_game_id: id,
                checkpoint: None
            },
            &[]
        )
        .unwrap_err(),
        ContractError::NotSeated { chain_game_id: id }
    );
    liveness(&mut s, id, 2).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    s.assert_custody();
}

#[test]
fn resolver_timeout_on_a_compromised_settlement_falls_back_to_a_checkpoint() {
    let mut s = Suite::new();
    let id = s.started(3);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    let honest = post_checkpoint_by(&mut s, id, 2, &key2, 80, &[1, 1, 2]);
    // Key 1 leaks and settles everything to seat 0.
    s.settle(id, 1, 500, &[1, 0, 0], &[]);
    s.challenge(id, 2);
    let bond = s.bond(id);
    s.retire_key(1, true);
    s.advance(RESOLVER_TIMEOUT);
    let t = s.now();
    let (d, _, res) = deltas(&mut s, 3, |s| liveness(s, id, 1).unwrap());
    assert_eq!(attr(&res, "path"), "resolver_timeout_checkpoint");
    assert_eq!(d, vec![0, 0, bond], "only the bond moves now");
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settleable);
    let st = g.settlement.unwrap();
    assert_eq!(st.source, SettlementSource::LivenessCheckpoint);
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&honest).to_vec()
    );
    assert_eq!(st.window_end, t.plus_seconds(DAY));
    assert_eq!(
        g.dispute.unwrap().resolution,
        Some(DisputeResolution::ResolverTimeout)
    );
    s.assert_custody();
    s.advance(DAY);
    let (d, _, _) = deltas(&mut s, 3, |s| {
        let who = s.outsider.clone();
        s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
            .unwrap()
    });
    assert_eq!(d, split(3 * NET, &[1, 1, 2]));
    s.assert_custody();
}

#[test]
fn resolver_timeout_on_a_compromised_settlement_without_checkpoints_refunds() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(3);
    let bond = s.bond(id);
    s.retire_key(1, true);
    s.advance(RESOLVER_TIMEOUT);
    let (d, dust, res) = deltas(&mut s, 3, |s| liveness(s, id, 0).unwrap());
    assert_eq!(attr(&res, "path"), "resolver_timeout_refund");
    assert_eq!(d, vec![NET, NET + bond, NET]);
    assert_eq!(dust, 0);
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Cancelled);
    let o = g.outcome.unwrap();
    assert_eq!(o.route, Route::ResolverTimeoutRefund);
    assert_eq!(o.bond_returned.u128(), bond);
    assert_eq!(s.contract_balance(), 0);
    s.assert_custody();
}

#[test]
fn a_fallback_settlement_can_be_challenged_again() {
    let mut s = Suite::new();
    let id = s.started(2);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    post_checkpoint_by(&mut s, id, 2, &key2, 30, &[1, 1]);
    s.settle(id, 1, 500, &[1, 0], &[]);
    s.challenge(id, 1);
    s.retire_key(1, true);
    s.advance(RESOLVER_TIMEOUT);
    liveness(&mut s, id, 1).unwrap();
    assert_eq!(s.state(id), GameState::Settleable);
    // A second dispute over the fallback settlement is a fresh dispute.
    s.challenge(id, 0);
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Disputed);
    let d = g.dispute.unwrap();
    assert_eq!(d.challenger, s.players[0]);
    assert!(d.resolution.is_none());
    s.assert_custody();
    s.resolve(id, ResolveOutcome::Uphold {}).unwrap();
    s.assert_custody();
}

#[test]
fn a_zero_bond_resolver_timeout_sends_no_bond_message() {
    let params = eighteen_cosmos_escrow::state::GameParams {
        bond_bps: 0,
        bond_floor: Uint128::zero(),
        ..default_params()
    };
    let mut s = SuiteBuilder::default().params(params).build();
    let id = s.started(2);
    s.settle(id, 1, 100, &[1, 3], &[]);
    let alice = s.players[1].clone();
    s.exec(
        &alice,
        &ExecuteMsg::Challenge {
            chain_game_id: id,
            evidence_hash: HexBinary::from(vec![5u8; 32]),
        },
        &[],
    )
    .unwrap();
    s.advance(RESOLVER_TIMEOUT);
    let (d, _, res) = deltas(&mut s, 2, |s| liveness(s, id, 1).unwrap());
    assert_eq!(d, split(2 * NET, &[1, 3]));
    assert_eq!(bank_sends(&res).len(), 2);
    s.assert_custody();
}

#[test]
fn liveness_with_every_registry_slot_holding_a_checkpoint() {
    // The worst case the bounded registry allows: 64 keys, each with its own
    // stored checkpoint for the same game; the newest usable one wins.
    let mut s = Suite::new();
    let id = s.started(2);
    let mut keys = vec![(1u16, Key::signer(1))];
    for n in 2..=64usize {
        let key = Key::signer(n);
        let key_id = s.add_key(&key);
        keys.push((key_id, key));
    }
    let mut best = None;
    for (i, (key_id, key)) in keys.iter().enumerate() {
        let p = post_checkpoint_by(&mut s, id, *key_id, key, 10 + i as u64, &[1, 1 + i as u128]);
        best = Some(p);
    }
    assert_eq!(s.checkpoints(id).checkpoints.len(), 64);
    // The newest key is compromised: the fallback is the next newest.
    s.retire_key(64, true);
    s.advance(LIVENESS);
    liveness(&mut s, id, 0).unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(st.payload.signer_key_id, 63);
    assert_eq!(st.payload.log_len.u64(), 10 + 62);
    assert_ne!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&best.unwrap()).to_vec()
    );
}

// -------------------------------------------------------------- SETTLEABLE

/// How the stored settlement relates to the signer registry at the deadline.
#[derive(Clone, Copy, Debug)]
enum Signer {
    Trusted,
    CompromisedWithCheckpoint,
    CompromisedNoCheckpoint,
}

/// A SETTLEABLE game whose settlement was signed by key 1, seat 0 already
/// consented. With a checkpoint, key 2 posted one at log 50 first.
fn settleable_game(s: &mut Suite, with_checkpoint: bool) -> (u64, Option<Payload>) {
    let id = s.started(3);
    let cp = if with_checkpoint {
        let key2 = Key::signer(2);
        if s.config().next_signer_key_id == 2 {
            s.add_key(&key2);
        }
        Some(post_checkpoint_by(s, id, 2, &key2, 50, &[1, 1, 2]))
    } else {
        None
    };
    s.settle(id, 1, 100, &[1, 2, 3], &[0]);
    (id, cp)
}

#[test]
fn settleable_liveness_deadline_for_every_signer_case_paused_and_unpaused() {
    // OD-ESC2-1: now >= window_end + liveness_window, while paused or not.
    for signer in [
        Signer::Trusted,
        Signer::CompromisedWithCheckpoint,
        Signer::CompromisedNoCheckpoint,
    ] {
        for paused in [false, true] {
            let case = format!("{signer:?} paused={paused}");
            let mut s = Suite::new();
            let with_cp = matches!(signer, Signer::CompromisedWithCheckpoint);
            let (id, cp) = settleable_game(&mut s, with_cp);
            let window_end = s.game(id).game.settlement.unwrap().window_end;
            let at = window_end.plus_seconds(LIVENESS);
            assert_eq!(
                s.game(id).deadlines.liveness_available_at,
                Some(at),
                "{case}"
            );
            if !matches!(signer, Signer::Trusted) {
                s.retire_key(1, true);
            }
            if paused {
                s.pause();
            }
            s.advance(DAY + LIVENESS - 1);
            assert_eq!(
                liveness(&mut s, id, 2).unwrap_err(),
                ContractError::LivenessNotReached { at },
                "{case}: one second early"
            );
            s.advance(1);
            assert_eq!(s.now(), at);
            let (d, dust, res) = deltas(&mut s, 3, |s| liveness(s, id, 2).unwrap());
            let g = s.game(id).game;
            match signer {
                Signer::Trusted => {
                    assert_eq!(attr(&res, "path"), "settleable_timeout_payout", "{case}");
                    assert_eq!(g.state, GameState::Settled);
                    assert_eq!(g.outcome.unwrap().route, Route::SettleableTimeoutPayout);
                    let expected = split(3 * NET, &[1, 2, 3]);
                    assert_eq!(d, expected, "{case}");
                    assert_eq!(dust, 3 * NET - expected.iter().sum::<u128>());
                }
                Signer::CompromisedWithCheckpoint => {
                    assert_eq!(attr(&res, "path"), "settleable_timeout_checkpoint");
                    assert!(bank_sends(&res).is_empty(), "{case}: nothing paid");
                    assert_eq!(g.state, GameState::Settleable);
                    assert_eq!(g.consent_bitmap, 0, "{case}: consents reset");
                    let st = g.settlement.unwrap();
                    assert_eq!(st.source, SettlementSource::LivenessCheckpoint);
                    assert_eq!(
                        st.payload.payload_digest.to_vec(),
                        Suite::settle_digest(cp.as_ref().unwrap()).to_vec()
                    );
                    assert_eq!(st.window_end, at.plus_seconds(DAY), "{case}: fresh window");
                    // Still paused or not, the fallback settlement exits too.
                    s.advance(DAY + LIVENESS);
                    let (d, _, res) = deltas(&mut s, 3, |s| liveness(s, id, 0).unwrap());
                    assert_eq!(attr(&res, "path"), "settleable_timeout_payout");
                    assert_eq!(d, split(3 * NET, &[1, 1, 2]), "{case}");
                }
                Signer::CompromisedNoCheckpoint => {
                    assert_eq!(attr(&res, "path"), "settleable_timeout_refund");
                    assert_eq!(g.state, GameState::Cancelled);
                    assert_eq!(g.outcome.unwrap().route, Route::SettleableTimeoutRefund);
                    assert_eq!(d, vec![NET, NET, NET], "{case}");
                    assert_eq!(dust, 0);
                }
            }
            assert!(
                s.game(id).game.state != GameState::Settleable
                    || matches!(signer, Signer::CompromisedWithCheckpoint)
            );
            assert_eq!(s.contract_balance(), 0, "{case}: nothing trapped");
            s.assert_custody();
        }
    }
}

#[test]
fn a_permanent_pause_cannot_trap_a_settleable_game() {
    // The ESCROW-2 open decision: Finalize and Consent are paused, the window
    // is closed, and the admin never unpauses.
    let mut s = Suite::new();
    let (id, _) = s.settleable(3);
    s.pause();
    s.advance(DAY);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
            .unwrap_err(),
        ContractError::Paused {}
    );
    s.advance(LIVENESS);
    liveness(&mut s, id, 1).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    assert!(s.config().config.paused);
    assert_eq!(s.contract_balance(), 0);
}

#[test]
fn settleable_liveness_is_for_seated_wallets_and_takes_no_funds() {
    let mut s = Suite::new();
    let (id, _) = s.settleable(2);
    s.advance(DAY + LIVENESS);
    for who in [
        s.admin.clone(),
        s.operator.clone(),
        s.resolver.clone(),
        s.outsider.clone(),
    ] {
        assert_eq!(
            s.exec(&who, &Suite::liveness_msg(id), &[]).unwrap_err(),
            ContractError::NotSeated { chain_game_id: id }
        );
    }
    let alice = s.players[1].clone();
    assert_eq!(
        s.exec(&alice, &Suite::liveness_msg(id), &coins(1, DENOM))
            .unwrap_err(),
        ContractError::NonPayable {}
    );
    liveness(&mut s, id, 1).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

#[test]
fn a_liveness_checkpoint_settlement_has_the_settleable_exit_too() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.post_checkpoint(id, 10, &[1, 3]);
    s.advance(LIVENESS);
    liveness(&mut s, id, 0).unwrap();
    let window_end = s.game(id).game.settlement.unwrap().window_end;
    s.pause();
    s.advance(DAY + LIVENESS - 1);
    assert_eq!(
        liveness(&mut s, id, 0).unwrap_err(),
        ContractError::LivenessNotReached {
            at: window_end.plus_seconds(LIVENESS)
        }
    );
    s.advance(1);
    liveness(&mut s, id, 0).unwrap();
    assert_eq!(
        s.game(id).game.outcome.unwrap().amounts,
        vec![Uint128::new(975_000), Uint128::new(2_925_000)]
    );
}

// ------------------------------------------ LivenessSettle + checkpoint (OD-ESC2-4)

#[test]
fn a_carried_checkpoint_is_promoted_without_restarting_the_clock() {
    let mut s = Suite::new();
    let id = s.started(3);
    s.post_checkpoint(id, 10, &[1, 1, 1]);
    let activity = s.game(id).game.last_activity;
    s.advance(LIVENESS);
    let t = s.now();
    let (newer, carried) = s.signed_checkpoint(id, 1, &Key::signer(1), 20, &[5, 1, 1]);
    let res = s.liveness(id, 2, Some(carried)).unwrap();
    assert_eq!(attr(&res, "path"), "checkpoint");
    assert_eq!(attr(&res, "supplied_checkpoint_seq"), "40");
    let g = s.game(id);
    assert_eq!(g.game.state, GameState::Settleable);
    assert_eq!(
        g.game.last_activity, activity,
        "the liveness clock was not restarted"
    );
    assert_eq!(g.game.last_seq.u64(), 40);
    assert_eq!(g.trusted_seq.u64(), 40);
    // The newer checkpoint is the one used ...
    let st = g.game.settlement.unwrap();
    assert_eq!(st.source, SettlementSource::LivenessCheckpoint);
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&newer).to_vec()
    );
    assert_eq!(st.window_end, t.plus_seconds(DAY), "normal fresh window");
    // ... and it is stored like any accepted checkpoint.
    let cps = s.checkpoints(id);
    assert_eq!(cps.checkpoints.len(), 1);
    assert_eq!(cps.checkpoints[0].checkpoint.payload.seq.u64(), 40);
    assert_eq!(cps.checkpoints[0].checkpoint.accepted_at, t);
    s.assert_custody();
}

#[test]
fn an_ordinary_checkpoint_restarts_the_clock_where_a_carried_one_does_not() {
    // Same evidence, two routes: posted on its own it refreshes last_activity
    // and liveness moves 14 days away; carried by an eligible LivenessSettle it
    // is promoted at once.
    let mut s = Suite::new();
    let a = s.started(2);
    let b = s.started(2);
    s.advance(LIVENESS);
    let (_, carried_a) = s.signed_checkpoint(a, 1, &Key::signer(1), 20, &[1, 1]);
    let (_, carried_b) = s.signed_checkpoint(b, 1, &Key::signer(1), 20, &[1, 1]);
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::Checkpoint {
            chain_game_id: a,
            payload: carried_a.payload,
            signature: carried_a.signature,
        },
        &[],
    )
    .unwrap();
    assert_eq!(
        liveness(&mut s, a, 0).unwrap_err(),
        ContractError::LivenessNotReached {
            at: s.now().plus_seconds(LIVENESS)
        }
    );
    s.liveness(b, 0, Some(carried_b)).unwrap();
    assert_eq!(s.state(b), GameState::Settleable);
    assert_eq!(s.state(a), GameState::InProgress);
}

#[test]
fn eligibility_is_decided_before_a_carried_checkpoint_and_nothing_is_written() {
    let mut s = Suite::new();
    let id = s.started(2);
    let at = s.now().plus_seconds(LIVENESS);
    s.advance(LIVENESS - 1);
    let (_, carried) = s.signed_checkpoint(id, 1, &Key::signer(1), 20, &[1, 1]);
    assert_eq!(
        s.liveness(id, 0, Some(carried.clone())).unwrap_err(),
        ContractError::LivenessNotReached { at }
    );
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::InProgress);
    assert_eq!(g.last_seq.u64(), 0);
    assert!(s.checkpoints(id).checkpoints.is_empty(), "no partial write");
    // The very same checkpoint is accepted once the window has passed.
    s.advance(1);
    s.liveness(id, 0, Some(carried)).unwrap();
    assert_eq!(s.state(id), GameState::Settleable);
}

#[test]
fn a_bad_carried_checkpoint_fails_the_whole_transaction() {
    let mut s = Suite::new();
    let id = s.started(2);
    let other = s.started(2);
    s.post_checkpoint(id, 10, &[1, 1]);
    s.add_key(&Key::signer(2));
    s.retire_key(1, false);
    s.advance(LIVENESS);
    let before = s.game(id).game;
    let key2 = Key::signer(2);
    let good = |s: &Suite| s.signed_checkpoint(id, 2, &key2, 20, &[1, 1]).1;
    let mut cases: Vec<(SignedCheckpoint, ContractError)> = Vec::new();
    let mut bad_sig = good(&s);
    bad_sig.signature = Key::signer(9).sign(&[1u8; 32]);
    cases.push((bad_sig, ContractError::InvalidSignature {}));
    let mut high_s = good(&s);
    let (p, _) = s.signed_checkpoint(id, 2, &key2, 20, &[1, 1]);
    high_s.signature = key2.sign_high_s(&Suite::settle_digest(&p));
    cases.push((high_s, ContractError::HighS {}));
    cases.push((
        s.signed_checkpoint(id, 2, &key2, 10, &[1, 1]).1,
        ContractError::StaleSeq {
            seq: 20,
            trusted_seq: 20,
        },
    ));
    cases.push((
        s.signed_checkpoint(other, 2, &key2, 20, &[1, 1]).1,
        ContractError::DomainMismatch {},
    ));
    cases.push((
        s.signed_checkpoint(id, 1, &Key::signer(1), 20, &[1, 1]).1,
        ContractError::RetiredSignerKey { key_id: 1 },
    ));
    cases.push((
        s.signed_checkpoint(id, 2, &key2, 20, &[0, 0]).1,
        ContractError::ZeroSumWeights {},
    ));
    let terminal = {
        let mut p = s.terminal_payload(id, 1, 20, &[1, 1]);
        p.signer_key_id = 2;
        let (payload, signature) = s.signed_by(&p, &key2);
        SignedCheckpoint { payload, signature }
    };
    cases.push((
        terminal,
        ContractError::WrongKind {
            expected: "checkpoint".to_string(),
        },
    ));
    for (carried, expected) in cases {
        assert_eq!(s.liveness(id, 0, Some(carried)).unwrap_err(), expected);
        assert_eq!(s.game(id).game, before, "no partial write");
        assert_eq!(s.checkpoints(id).checkpoints.len(), 1);
    }
    // The plain exit still works and uses the stored (retired, uncompromised)
    // checkpoint.
    liveness(&mut s, id, 0).unwrap();
    assert_eq!(s.game(id).game.settlement.unwrap().payload.seq.u64(), 20);
}

#[test]
fn a_carried_checkpoint_works_while_paused() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.pause();
    s.advance(LIVENESS);
    let (p, carried) = s.signed_checkpoint(id, 1, &Key::signer(1), 7, &[1, 2]);
    s.liveness(id, 1, Some(carried)).unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&p).to_vec()
    );
}

#[test]
fn a_carried_checkpoint_is_refused_outside_in_progress() {
    let mut s = Suite::new();
    let (settleable, _) = s.settleable(2);
    let (disputed, _) = s.disputed(2);
    s.advance(40 * DAY);
    for (id, actual) in [(settleable, "settleable"), (disputed, "disputed")] {
        let (_, carried) = s.signed_checkpoint(id, 1, &Key::signer(1), 500, &[1, 1]);
        assert_eq!(
            s.liveness(id, 0, Some(carried)).unwrap_err(),
            ContractError::WrongState {
                expected: "in_progress".to_string(),
                actual: actual.to_string()
            }
        );
        // Not seated comes first.
        let (_, carried) = s.signed_checkpoint(id, 1, &Key::signer(1), 500, &[1, 1]);
        let who = s.outsider.clone();
        assert_eq!(
            s.exec(
                &who,
                &ExecuteMsg::LivenessSettle {
                    chain_game_id: id,
                    checkpoint: Some(carried),
                },
                &[],
            )
            .unwrap_err(),
            ContractError::NotSeated { chain_game_id: id }
        );
    }
    s.assert_custody();
}
