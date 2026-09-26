//! LivenessSettle: the exit nobody can switch off. IN_PROGRESS inactivity
//! (ESCROW-1.5 §7.5, cases 1–5) and DISPUTED past the resolver timeout (§8.3).

mod common;

use common::*;
use cosmwasm_std::{coins, Addr, HexBinary, Uint128, Uint64};
use cw_multi_test::AppResponse;
use eighteen_cosmos_escrow::msg::{ExecuteMsg, ResolveOutcome};
use eighteen_cosmos_escrow::payload::{Payload, REASON_RESOLVER_CORRECTION};
use eighteen_cosmos_escrow::state::{DisputeResolution, GameState, Mode, Route, SettlementSource};
use eighteen_cosmos_escrow::ContractError;

const LIVENESS: u64 = 14 * DAY;
const RESOLVER_TIMEOUT: u64 = 30 * DAY;

fn liveness(s: &mut Suite, id: u64, seat: usize) -> Result<AppResponse, ContractError> {
    let who = s.players[seat].clone();
    s.exec(&who, &ExecuteMsg::LivenessSettle { chain_game_id: id }, &[])
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
            s.exec(&who, &ExecuteMsg::LivenessSettle { chain_game_id: id }, &[])
                .unwrap_err(),
            ContractError::NotSeated { chain_game_id: id }
        );
    }
    let alice = s.players[1].clone();
    assert_eq!(
        s.exec(
            &alice,
            &ExecuteMsg::LivenessSettle { chain_game_id: id },
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
fn a_forged_huge_seq_checkpoint_blocks_new_posts_until_liveness_recovers() {
    let mut s = Suite::new();
    let id = s.started(2);
    let key1 = Key::signer(1);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    let honest = post_checkpoint_by(&mut s, id, 2, &key2, 40, &[1, 1]);
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
    s.retire_key(1, true);
    // The honest key can no longer post (seq is monotone) ...
    let mut next = s.checkpoint_payload(id, 60, &[2, 1]);
    next.signer_key_id = 2;
    let (payload, signature) = s.signed_by(&next, &key2);
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::Checkpoint {
                chain_game_id: id,
                payload,
                signature,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::StaleSeq {
            seq: 120,
            last_seq: u64::MAX - 1
        }
    );
    // ... but liveness recovers the last honest boundary, not the forgery.
    s.advance(LIVENESS);
    liveness(&mut s, id, 1).unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&honest).to_vec()
    );
    s.advance(DAY);
    finalize(&mut s, id);
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(o.amounts, vec![Uint128::new(NET), Uint128::new(NET)]);
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
fn liveness_needs_in_progress_or_disputed() {
    let mut s = Suite::new();
    let funding = s.create(0, 3, Mode::Live, ANTE);
    let funded = s.funded(2);
    let (settleable, _) = s.settleable(2);
    let settled = s.settled(2);
    let cancelled = s.cancelled(2);
    let annulled = s.annulled(2);
    s.advance(60 * DAY);
    for (id, actual) in [
        (funding, "funding"),
        (funded, "funded"),
        (settleable, "settleable"),
        (settled, "settled"),
        (cancelled, "cancelled"),
        (annulled, "annulled"),
    ] {
        assert_eq!(
            liveness(&mut s, id, 0).unwrap_err(),
            ContractError::WrongState {
                expected: "in_progress or disputed".to_string(),
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
        s.exec(&who, &ExecuteMsg::LivenessSettle { chain_game_id: id }, &[])
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
