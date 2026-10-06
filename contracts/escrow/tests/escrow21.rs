//! Escrow 2.1.0 (owner policy 2026-10-05): the per-game exit policy, the
//! removed IN_PROGRESS standings exit, the No-deadline exceptional review, and
//! the settled foreclosure arithmetic.
//!
//! What this build does NOT contain, by design: any timed default, overdue,
//! cure or foreclosure path. The chain cannot see gameplay actions, and how an
//! off-chain overdue fact would become trustworthy to the contract (the trust
//! bridge) is an open owner decision. Only the money formula exists, as pure
//! tested arithmetic (`payout::foreclosure_split`).
//!
//! Adversarial focus: no message, role, pause, time or migration can give a
//! 2.1.0 game an inactivity payout, a standings payout, a review outcome other
//! than the neutral refund, or a review by anyone but the resolver the game
//! adopted at Start.

mod common;

use common::*;
use cosmwasm_std::{coins, Uint128};
use cw_multi_test::Executor;
use eighteen_cosmos_escrow::msg::{ExecuteMsg, SignedCheckpoint};
use eighteen_cosmos_escrow::payout::foreclosure_split;
use eighteen_cosmos_escrow::state::{GamePolicy, GameState, Mode, Route, SettlementSource};
use eighteen_cosmos_escrow::ContractError;

const YEARS_10: u64 = 10 * 365 * DAY;

fn no_deadline_game(s: &mut Suite, n: usize) -> u64 {
    s.no_deadline = true;
    let id = s.started(n);
    s.no_deadline = false;
    assert_eq!(s.game(id).game.terms.policy, Some(GamePolicy::NoDeadline));
    id
}

fn request(
    s: &mut Suite,
    id: u64,
    seat: usize,
) -> Result<cw_multi_test::AppResponse, ContractError> {
    let who = s.players[seat].clone();
    s.exec(&who, &ExecuteMsg::RequestReview { chain_game_id: id }, &[])
}

fn review(
    s: &mut Suite,
    id: u64,
    who: &cosmwasm_std::Addr,
) -> Result<cw_multi_test::AppResponse, ContractError> {
    let msg = s.review_annul_msg(id);
    s.exec(who, &msg, &[])
}

// ===================================================================== policy

#[test]
fn create_records_the_policy_and_a_live_table_is_always_timed() {
    let mut s = Suite::new();
    let creator = s.players[0].clone();
    for (mode, no_deadline, expected) in [
        (Mode::Live, false, GamePolicy::TimedNoRemedies),
        (Mode::Async, false, GamePolicy::TimedNoRemedies),
        (Mode::Async, true, GamePolicy::NoDeadline),
    ] {
        let res = s
            .exec(
                &creator,
                &Suite::create_msg_with(3, mode, 0, no_deadline),
                &coins(ANTE, DENOM),
            )
            .unwrap();
        let id: u64 = attr(&res, "chain_game_id").parse().unwrap();
        assert_eq!(attr(&res, "policy"), expected.as_str());
        assert_eq!(s.game(id).game.terms.policy, Some(expected));
        assert_eq!(s.game(id).game.review_request, None);
    }
    // A Live table with no deadline is refused before any fund moves.
    let next = s.config().next_chain_game_id;
    let balance = s.balance(&creator);
    let treasury = s.balance(&s.treasury.clone());
    assert_eq!(
        s.exec(
            &creator,
            &Suite::create_msg_with(3, Mode::Live, 0, true),
            &coins(ANTE, DENOM)
        )
        .unwrap_err(),
        ContractError::NoDeadlineNeedsAsync {}
    );
    assert_eq!(s.config().next_chain_game_id, next);
    assert_eq!(s.balance(&creator), balance);
    assert_eq!(s.balance(&s.treasury.clone()), treasury);
    s.assert_custody();
}

/// The deadline class is never chosen by default: the CreateGame JSON an
/// escrow 2.0.0 client sends (no `no_deadline`) does not decode, so nothing is
/// created and no fund moves.
#[test]
fn the_escrow_2_0_create_json_without_a_deadline_class_is_refused() {
    let mut s = Suite::new();
    let creator = s.players[0].clone();
    let contract = s.contract.clone();
    let json = serde_json::json!({ "create_game": {
        "max_players": 2,
        "mode": "async",
        "rules_engine_version": RULES_ENGINE_VERSION,
        "variants_digest": variants_digest().to_hex(),
        "consent_pubkey": Key::seat(0).pubkey.to_hex(),
        "join_ticket": ticket("creator").to_hex(),
    }});
    let balance = s.balance(&creator);
    let err = s
        .app
        .execute_contract(creator.clone(), contract, &json, &coins(ANTE, DENOM))
        .unwrap_err();
    assert!(
        format!("{err:?}").contains("missing field `no_deadline`"),
        "{err:?}"
    );
    assert_eq!(s.balance(&creator), balance);
    assert_eq!(s.config().next_chain_game_id, 1);
}

/// Nothing after CreateGame changes a game's policy: no admin message, no
/// pause, no key rotation, no play.
#[test]
fn the_policy_is_frozen_at_create() {
    let mut s = Suite::new();
    let timed = s.started(3);
    let nd = no_deadline_game(&mut s, 3);
    let admin = s.admin.clone();
    let mut params = default_params();
    params.liveness_window_secs = 1;
    params.challenge_window_async_secs = 1;
    for msg in [
        ExecuteMsg::SetParams { params },
        ExecuteMsg::SetResolver {
            resolver: s.addr("resolver-2").to_string(),
        },
        ExecuteMsg::SetTreasury {
            treasury: s.addr("treasury-2").to_string(),
        },
        ExecuteMsg::Pause {},
        ExecuteMsg::Unpause {},
        ExecuteMsg::AddSignerKey {
            pubkey: Key::signer(2).pubkey,
        },
        ExecuteMsg::RetireSignerKey {
            key_id: 2,
            compromised: true,
        },
    ] {
        s.exec(&admin, &msg, &[]).unwrap();
    }
    s.post_checkpoint(timed, 10, &[1, 1, 1]);
    s.post_checkpoint(nd, 10, &[1, 1, 1]);
    request(&mut s, nd, 2).unwrap();
    assert_eq!(
        s.game(timed).game.terms.policy,
        Some(GamePolicy::TimedNoRemedies)
    );
    assert_eq!(s.game(nd).game.terms.policy, Some(GamePolicy::NoDeadline));
    // A game created after SetParams gets the new params, still a 2.1.0 policy.
    let later = s.started(2);
    assert_eq!(
        s.game(later).game.terms.policy,
        Some(GamePolicy::TimedNoRemedies)
    );
    assert_eq!(s.game(later).game.terms.liveness_window_secs, 1);
}

// ============================================== the removed IN_PROGRESS exit

/// 2.1.0 cannot use the IN_PROGRESS standings liveness exit: not at the
/// window, not after ten years, not paused, not with a carried checkpoint
/// (good or forged), not for any seat, Timed or No-deadline. A refusal moves
/// nothing and stores nothing.
#[test]
fn in_progress_liveness_is_refused_at_any_time_paused_or_not_with_or_without_a_checkpoint() {
    for no_deadline in [false, true] {
        let mut s = Suite::new();
        let id = if no_deadline {
            no_deadline_game(&mut s, 3)
        } else {
            s.started(3)
        };
        s.post_checkpoint(id, 10, &[5, 1, 1]);
        assert_eq!(s.game(id).deadlines.liveness_available_at, None);
        for (wait, paused) in [
            (0, false),
            (14 * DAY, false),
            (14 * DAY, true),
            (YEARS_10, false),
            (1, true),
        ] {
            s.advance(wait);
            if paused {
                s.pause();
            }
            for seat in 0..3 {
                let game = s.game(id).game;
                let checkpoints = s.checkpoints(id);
                let balance = s.contract_balance();
                assert_eq!(
                    s.liveness(id, seat, None).unwrap_err(),
                    ContractError::LivenessExitRemoved {}
                );
                // A valid newer checkpoint carried in is not stored either.
                let signer = s.signer.clone();
                let (_, cp) = s.signed_checkpoint(id, 1, &signer, 50 + seat as u64, &[1, 9, 1]);
                assert_eq!(
                    s.liveness(id, seat, Some(cp)).unwrap_err(),
                    ContractError::LivenessExitRemoved {}
                );
                // Nor a forged one (the refusal comes first, whatever it holds).
                let forged = SignedCheckpoint {
                    payload: Suite::wire(&s.checkpoint_payload(id, 60, &[1, 1, 1])),
                    signature: Key::from_label("forger").sign(&[9u8; 32]),
                };
                assert_eq!(
                    s.liveness(id, seat, Some(forged)).unwrap_err(),
                    ContractError::LivenessExitRemoved {}
                );
                assert_eq!(s.game(id).game, game);
                assert_eq!(s.checkpoints(id), checkpoints);
                assert_eq!(s.contract_balance(), balance);
            }
            if paused {
                s.unpause();
            }
        }
        // An outsider is still told it is not seated (role before policy).
        let outsider = s.outsider.clone();
        assert_eq!(
            s.exec(&outsider, &Suite::liveness_msg(id), &[])
                .unwrap_err(),
            ContractError::NotSeated { chain_game_id: id }
        );
        assert_eq!(s.state(id), GameState::InProgress);
        assert_eq!(s.game(id).deadlines.liveness_available_at, None);
        // The carried checkpoints were genuinely valid: the same payload is
        // accepted by an ordinary Checkpoint (nothing above stored it).
        let signer = s.signer.clone();
        let (_, cp) = s.signed_checkpoint(id, 1, &signer, 50, &[1, 9, 1]);
        let who = s.outsider.clone();
        s.exec(
            &who,
            &ExecuteMsg::Checkpoint {
                chain_game_id: id,
                payload: cp.payload,
                signature: cp.signature,
            },
            &[],
        )
        .unwrap();
        assert_eq!(s.trusted_seq(id), 100);
        s.assert_custody();
    }
}

/// A paused game cannot be liveness-settled. The voluntary Live pause is
/// off-chain (the chain has no gameplay clock to pause); the admin pause,
/// however long, opens nothing either.
#[test]
fn a_paused_game_cannot_be_liveness_settled() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.pause();
    s.advance(YEARS_10);
    assert_eq!(
        s.liveness(id, 0, None).unwrap_err(),
        ContractError::LivenessExitRemoved {}
    );
    s.unpause();
    assert_eq!(
        s.liveness(id, 1, None).unwrap_err(),
        ContractError::LivenessExitRemoved {}
    );
    assert_eq!(s.state(id), GameState::InProgress);
}

/// No-deadline cannot be inactivity-settled: years of silence, checkpoints or
/// none, move nothing.
#[test]
fn no_deadline_cannot_be_inactivity_settled() {
    let mut s = Suite::new();
    let bare = no_deadline_game(&mut s, 2);
    let checkpointed = no_deadline_game(&mut s, 2);
    s.post_checkpoint(checkpointed, 7, &[0, 1]);
    s.advance(YEARS_10);
    for id in [bare, checkpointed] {
        for seat in 0..2 {
            assert_eq!(
                s.liveness(id, seat, None).unwrap_err(),
                ContractError::LivenessExitRemoved {}
            );
        }
        assert_eq!(s.state(id), GameState::InProgress);
        assert_eq!(s.game(id).game.pool.u128(), 2 * NET);
    }
}

/// The SETTLEABLE and DISPUTED exits of a finished 2.1.0 game are unchanged:
/// a trusted stored result is paid after its timeout, paused or not.
#[test]
fn settleable_and_disputed_exits_still_pay_a_trusted_result() {
    let mut s = Suite::new();
    let (settleable, _) = s.settleable(3);
    let (disputed, _) = s.disputed(3);
    s.pause();
    s.advance(DAY + 14 * DAY);
    let res = s.liveness(settleable, 0, None).unwrap();
    assert_eq!(attr(&res, "path"), "settleable_timeout_payout");
    s.advance(30 * DAY);
    let res = s.liveness(disputed, 2, None).unwrap();
    assert_eq!(attr(&res, "path"), "resolver_timeout_payout");
    for id in [settleable, disputed] {
        let o = s.game(id).game.outcome.unwrap();
        // ramp(3) = [1, 2, 3] over 3 · NET.
        assert_eq!(
            o.amounts,
            vec![
                Uint128::new(975_000),
                Uint128::new(1_950_000),
                Uint128::new(2_925_000)
            ]
        );
    }
    s.assert_custody();
}

/// A 2.1.0 game never pays from round-boundary standings: where 2.0.0 would
/// promote the best trusted checkpoint (a SETTLEABLE or DISPUTED settlement
/// whose key was retired as compromised), it refunds every net deposit, even
/// with a trusted checkpoint on record.
#[test]
fn a_compromised_settlement_refunds_and_never_promotes_a_checkpoint() {
    let mut s = Suite::new();
    let key2 = Key::signer(2);
    let k2 = s.add_key(&key2);
    let settleable = s.started(3);
    let disputed = s.started(3);
    for id in [settleable, disputed] {
        // A trusted (key 1) checkpoint that 2.0.0 would fall back to.
        s.post_checkpoint(id, 10, &[9, 1, 1]);
        let mut p = s.terminal_payload(id, 1, 20, &[0, 0, 1]);
        p.signer_key_id = k2;
        let msg = s.settle_msg_by(id, &p, &key2);
        let op = s.operator.clone();
        s.exec(&op, &msg, &[]).unwrap();
    }
    s.challenge(disputed, 0);
    let challenger = s.players[0].clone();
    let bond = s.bond(disputed);
    s.retire_key(k2, true);
    assert_eq!(
        s.checkpoints(settleable)
            .liveness_candidate_seq
            .map(|v| v.u64()),
        Some(20),
        "a trusted checkpoint exists"
    );
    s.advance(30 * DAY);
    let res = s.liveness(settleable, 1, None).unwrap();
    assert_eq!(attr(&res, "path"), "settleable_timeout_refund");
    let before = s.balance(&challenger);
    let res = s.liveness(disputed, 1, None).unwrap();
    assert_eq!(attr(&res, "path"), "resolver_timeout_refund");
    assert_eq!(
        s.balance(&challenger) - before,
        NET + bond,
        "net deposit + bond back"
    );
    for (id, route) in [
        (settleable, Route::SettleableTimeoutRefund),
        (disputed, Route::ResolverTimeoutRefund),
    ] {
        let g = s.game(id).game;
        assert_eq!(g.state, GameState::Cancelled);
        let o = g.outcome.unwrap();
        assert_eq!(o.route, route);
        assert_eq!(o.amounts, vec![Uint128::new(NET); 3]);
        assert_ne!(
            g.settlement.unwrap().source,
            SettlementSource::LivenessCheckpoint
        );
    }
    s.assert_custody();
}

/// OD-ESC2-2's emergency rotation on 2.1.0 games: the compromised vector is
/// never paid, and the recovery is a refund (2.0.0 recovered by the trusted
/// checkpoint: `compromised_settlement.rs`).
#[test]
fn emergency_rotation_on_2_1_games_recovers_by_refund() {
    let mut s = Suite::new();
    let key2 = Key::signer(2);
    s.add_key(&key2);
    let fallback = s.started(3);
    let mut cp = s.checkpoint_payload(fallback, 40, &[1, 1, 2]);
    cp.signer_key_id = 2;
    let (payload, signature) = s.signed_by(&cp, &key2);
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::Checkpoint {
            chain_game_id: fallback,
            payload,
            signature,
        },
        &[],
    )
    .unwrap();
    let in_play = s.started(3);
    s.settle(fallback, 1, 100, &[5, 0, 0], &[0, 1]);
    s.pause();
    s.retire_key(1, true);
    let key3 = Key::signer(3);
    assert_eq!(s.add_key(&key3), 3);
    s.unpause();
    let at = s
        .game(fallback)
        .game
        .settlement
        .unwrap()
        .window_end
        .plus_seconds(14 * DAY);
    let now = s.now();
    s.advance(at.seconds() - now.seconds());
    let res = s.liveness(fallback, 0, None).unwrap();
    assert_eq!(attr(&res, "path"), "settleable_timeout_refund");
    assert_eq!(
        s.game(fallback).game.outcome.unwrap().amounts,
        vec![Uint128::new(NET); 3]
    );
    assert_eq!(s.game(in_play).game.pool.u128(), 3 * NET);
    s.assert_custody();
}

// ========================================================== the review path

/// The review's only outcome: every seat's own net deposit back to its own
/// deposit wallet. Nothing to the resolver, the treasury or a "winner", no
/// dust, at 2, 3 and 7 seats.
#[test]
fn review_annul_refunds_each_seats_own_net_deposit_and_nothing_else() {
    for n in [2usize, 3, 7] {
        let mut s = Suite::new();
        let id = no_deadline_game(&mut s, n);
        s.post_checkpoint(id, 10, &Suite::ramp(n));
        request(&mut s, id, n - 1).unwrap();
        s.advance(400 * DAY);
        let resolver = s.resolver.clone();
        let treasury = s.treasury.clone();
        let before: Vec<u128> = (0..n).map(|i| s.balance(&s.players[i])).collect();
        let resolver_before = s.balance(&resolver);
        let treasury_before = s.balance(&treasury);
        let res = review(&mut s, id, &resolver).unwrap();
        let sends = bank_sends(&res);
        assert_eq!(sends.len(), n, "one refund per seat and nothing else");
        for i in 0..n {
            assert_eq!(
                sends[i],
                (s.players[i].to_string(), NET),
                "seat {i} gets its own net deposit"
            );
            assert_eq!(s.balance(&s.players[i]) - before[i], NET);
        }
        assert_eq!(s.balance(&resolver), resolver_before);
        assert_eq!(s.balance(&treasury), treasury_before);
        let g = s.game(id).game;
        assert_eq!(g.state, GameState::Annulled);
        assert_eq!(g.pool, Uint128::zero());
        let o = g.outcome.unwrap();
        assert_eq!(o.route, Route::ReviewAnnul);
        assert_eq!(o.amounts, vec![Uint128::new(NET); n]);
        assert_eq!(o.dust, Uint128::zero());
        assert_eq!(o.distributed.u128(), NET * n as u128);
        s.assert_custody();
    }
}

/// The resolver snapshot cannot be retargeted after Start: only the resolver
/// the game adopted may review it, even after `SetResolver` moved the global
/// one; a game started after the move belongs to the new resolver. No other
/// role (admin, operator, creator, any seat, outsider, treasury) may review.
#[test]
fn only_the_games_own_resolver_may_review_and_the_snapshot_cannot_be_retargeted() {
    let mut s = Suite::new();
    let old_resolver = s.resolver.clone();
    let id = no_deadline_game(&mut s, 3);
    request(&mut s, id, 1).unwrap();
    let admin = s.admin.clone();
    let new_resolver = s.addr("resolver-2");
    s.exec(
        &admin,
        &ExecuteMsg::SetResolver {
            resolver: new_resolver.to_string(),
        },
        &[],
    )
    .unwrap();
    let later = no_deadline_game(&mut s, 3);
    request(&mut s, later, 0).unwrap();
    let mut impostors = vec![
        admin.clone(),
        s.operator.clone(),
        s.outsider.clone(),
        s.treasury.clone(),
        new_resolver.clone(),
    ];
    impostors.extend(s.players[..3].iter().cloned());
    for who in &impostors {
        let game = s.game(id).game;
        assert_eq!(
            review(&mut s, id, who).unwrap_err(),
            ContractError::Unauthorized {
                role: "resolver".to_string()
            },
            "{who}"
        );
        assert_eq!(s.game(id).game, game);
    }
    // The old resolver cannot review the game started after the move.
    assert_eq!(
        review(&mut s, later, &old_resolver).unwrap_err(),
        ContractError::Unauthorized {
            role: "resolver".to_string()
        }
    );
    s.advance(7 * DAY);
    review(&mut s, id, &old_resolver).unwrap();
    review(&mut s, later, &new_resolver).unwrap();
    assert_eq!(s.game(id).game.resolver, Some(old_resolver));
    assert_eq!(s.game(later).game.resolver, Some(new_resolver));
    s.assert_custody();
}

/// The resolver cannot annul a game nobody asked about; only a seated wallet
/// can ask.
#[test]
fn a_review_needs_a_seated_request_first() {
    let mut s = Suite::new();
    let id = no_deadline_game(&mut s, 3);
    let resolver = s.resolver.clone();
    assert_eq!(
        review(&mut s, id, &resolver).unwrap_err(),
        ContractError::ReviewNotRequested { chain_game_id: id }
    );
    for who in [
        resolver.clone(),
        s.admin.clone(),
        s.operator.clone(),
        s.outsider.clone(),
        s.players[3].clone(),
    ] {
        assert_eq!(
            s.exec(&who, &ExecuteMsg::RequestReview { chain_game_id: id }, &[])
                .unwrap_err(),
            ContractError::NotSeated { chain_game_id: id }
        );
    }
    assert_eq!(s.game(id).game.review_request, None);
    // Funds are refused on both messages.
    let seat = s.players[0].clone();
    assert_eq!(
        s.exec(
            &seat,
            &ExecuteMsg::RequestReview { chain_game_id: id },
            &coins(1, DENOM)
        )
        .unwrap_err(),
        ContractError::NonPayable {}
    );
    request(&mut s, id, 0).unwrap();
    assert_eq!(
        s.exec(&resolver, &s.review_annul_msg(id), &coins(1, DENOM))
            .unwrap_err(),
        ContractError::NonPayable {}
    );
    s.advance(7 * DAY);
    review(&mut s, id, &resolver).unwrap();
}

/// The first request is recorded; a later one (any seat, the same seat)
/// changes nothing.
#[test]
fn the_first_review_request_wins_and_repeats_are_idempotent() {
    let mut s = Suite::new();
    let id = no_deadline_game(&mut s, 3);
    s.advance(HOUR);
    let first_at = s.now();
    let res = request(&mut s, id, 2).unwrap();
    assert_eq!(attr(&res, "already_requested"), "false");
    let recorded = s.game(id).game.review_request.unwrap();
    assert_eq!(recorded.seat_index, 2);
    assert_eq!(recorded.requested_at, first_at);
    s.advance(DAY);
    for seat in [0, 2, 1] {
        let res = request(&mut s, id, seat).unwrap();
        assert_eq!(attr(&res, "already_requested"), "true");
        assert_eq!(s.game(id).game.review_request.as_ref(), Some(&recorded));
    }
}

/// The review is only for No-deadline games: a Timed 2.1.0 game and a game
/// stored by 2.0.0 code refuse both messages.
#[test]
fn the_review_is_only_for_no_deadline_games() {
    let mut s = Suite::new();
    let timed = s.started(3);
    let legacy = s.started(3);
    s.make_legacy(legacy);
    let resolver = s.resolver.clone();
    for id in [timed, legacy] {
        assert_eq!(
            request(&mut s, id, 0).unwrap_err(),
            ContractError::ReviewNotAvailable {}
        );
        assert_eq!(
            review(&mut s, id, &resolver).unwrap_err(),
            ContractError::ReviewNotAvailable {}
        );
        assert_eq!(s.state(id), GameState::InProgress);
    }
}

/// A finished result cannot be replaced by a review annulment: a request made
/// while IN_PROGRESS dies with the IN_PROGRESS state. SETTLEABLE, DISPUTED and
/// every terminal state refuse both messages, and so does a game not started.
#[test]
fn a_finished_result_cannot_be_replaced_by_a_review() {
    let mut s = Suite::new();
    let resolver = s.resolver.clone();
    let id = no_deadline_game(&mut s, 3);
    request(&mut s, id, 0).unwrap();
    assert!(s.game(id).deadlines.review_annul_available_at.is_some());
    s.settle(id, 1, 50, &[3, 2, 1], &[]);
    assert_eq!(s.state(id), GameState::Settleable);
    // The record stays as history, but no review deadline is shown any more.
    assert!(s.game(id).game.review_request.is_some());
    assert_eq!(s.game(id).deadlines.review_annul_available_at, None);
    let expect_wrong = |s: &mut Suite, id: u64, actual: &str| {
        let err = review(s, id, &resolver).unwrap_err();
        assert!(
            matches!(&err, ContractError::WrongState { actual: a, .. } if a == actual),
            "{err:?}"
        );
        let err = request(s, id, 1).unwrap_err();
        assert!(
            matches!(&err, ContractError::WrongState { actual: a, .. } if a == actual),
            "{err:?}"
        );
    };
    expect_wrong(&mut s, id, "settleable");
    s.challenge(id, 2);
    expect_wrong(&mut s, id, "disputed");
    s.resolve(id, eighteen_cosmos_escrow::msg::ResolveOutcome::Uphold {})
        .unwrap();
    expect_wrong(&mut s, id, "settled");
    // Before Start.
    s.no_deadline = true;
    let funded = s.funded(3);
    s.no_deadline = false;
    expect_wrong(&mut s, funded, "funded");
    s.assert_custody();
}

/// The reviewer cannot award itself or a "winner": ReviewAnnul carries no
/// payload, weights, amounts or recipient, and the strict JSON decoder refuses
/// any such field outright.
#[test]
fn the_reviewer_cannot_award_a_payout() {
    let mut s = Suite::new();
    let id = no_deadline_game(&mut s, 3);
    request(&mut s, id, 0).unwrap();
    let resolver = s.resolver.clone();
    let contract = s.contract.clone();
    for json in [
        serde_json::json!({ "review_annul": { "chain_game_id": id, "amounts": ["1", "2", "3"] } }),
        serde_json::json!({ "review_annul": { "chain_game_id": id, "recipient": resolver.to_string() } }),
        serde_json::json!({ "review_annul": { "chain_game_id": id, "weights": [0, 0, 1] } }),
        serde_json::json!({ "review_annul": { "chain_game_id": id, "outcome": { "uphold": {} } } }),
    ] {
        let err = s
            .app
            .execute_contract(resolver.clone(), contract.clone(), &json, &[])
            .unwrap_err();
        assert!(format!("{err:?}").contains("unknown field"), "{err:?}");
        assert_eq!(s.state(id), GameState::InProgress);
    }
    s.advance(7 * DAY);
    review(&mut s, id, &resolver).unwrap();
    assert_eq!(
        s.game(id).game.outcome.unwrap().amounts,
        vec![Uint128::new(NET); 3]
    );
}

/// Unanimous annulment is unchanged and still N-of-N on 2.1.0 games, Timed
/// and No-deadline: N − 1 signatures never annul.
#[test]
fn unanimous_annulment_is_still_n_of_n() {
    for no_deadline in [false, true] {
        let mut s = Suite::new();
        let id = if no_deadline {
            no_deadline_game(&mut s, 3)
        } else {
            s.started(3)
        };
        let who = s.outsider.clone();
        for seats in [&[0usize, 1][..], &[1, 2], &[0, 2]] {
            let consents = s.annul_sigs(id, seats, 0);
            let err = s
                .exec(
                    &who,
                    &ExecuteMsg::AnnulByConsent {
                        chain_game_id: id,
                        consents,
                    },
                    &[],
                )
                .unwrap_err();
            assert!(
                matches!(err, ContractError::MissingConsent { .. }),
                "{err:?}"
            );
        }
        let consents = s.annul_sigs(id, &[0, 1, 2], 0);
        s.exec(
            &who,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents,
            },
            &[],
        )
        .unwrap();
        assert_eq!(
            s.game(id).game.outcome.unwrap().route,
            Route::AnnulByConsent
        );
    }
}

/// The review delay (R-2): from the first request, `ReviewAnnul` is refused
/// until `requested_at + terms.review_delay_secs`, and the deadline is shown.
/// A later request does not move it.
#[test]
fn review_annul_waits_for_the_review_delay() {
    let mut s = Suite::new();
    let id = no_deadline_game(&mut s, 3);
    assert_eq!(s.game(id).game.terms.review_delay_secs, 7 * DAY);
    assert_eq!(s.game(id).deadlines.review_annul_available_at, None);
    request(&mut s, id, 1).unwrap();
    let at = s.now().plus_seconds(7 * DAY);
    assert_eq!(s.game(id).deadlines.review_annul_available_at, Some(at));
    s.advance(DAY);
    request(&mut s, id, 2).unwrap();
    assert_eq!(s.game(id).deadlines.review_annul_available_at, Some(at));
    let resolver = s.resolver.clone();
    s.advance(6 * DAY - 1);
    let game = s.game(id).game;
    assert_eq!(
        review(&mut s, id, &resolver).unwrap_err(),
        ContractError::ReviewDelayNotElapsed { at }
    );
    assert_eq!(s.game(id).game, game);
    s.advance(1);
    review(&mut s, id, &resolver).unwrap();
    assert_eq!(s.game(id).game.outcome.unwrap().route, Route::ReviewAnnul);
}

/// A new round boundary withdraws a pending request (R-3): the table kept
/// playing. A new request starts a new delay. A request never survives into a
/// finished game's review either (IN_PROGRESS only).
#[test]
fn a_checkpoint_withdraws_a_pending_review_request() {
    let mut s = Suite::new();
    let id = no_deadline_game(&mut s, 3);
    request(&mut s, id, 0).unwrap();
    s.advance(30 * DAY);
    let p = s.checkpoint_payload(id, 40, &[1, 1, 1]);
    let msg = s.checkpoint_msg(id, &p);
    let who = s.outsider.clone();
    let res = s.exec(&who, &msg, &[]).unwrap();
    assert_eq!(attr(&res, "review_request_cleared"), "true");
    assert_eq!(s.game(id).game.review_request, None);
    assert_eq!(s.game(id).deadlines.review_annul_available_at, None);
    let resolver = s.resolver.clone();
    assert_eq!(
        review(&mut s, id, &resolver).unwrap_err(),
        ContractError::ReviewNotRequested { chain_game_id: id }
    );
    // A checkpoint with no pending request says nothing about one.
    let p = s.checkpoint_payload(id, 41, &[1, 1, 1]);
    let msg = s.checkpoint_msg(id, &p);
    let res = s.exec(&who, &msg, &[]).unwrap();
    assert!(res
        .events
        .iter()
        .flat_map(|e| e.attributes.iter())
        .all(|a| a.key != "review_request_cleared"));
    // A fresh request, a fresh delay.
    request(&mut s, id, 2).unwrap();
    let at = s.now().plus_seconds(7 * DAY);
    assert_eq!(
        review(&mut s, id, &resolver).unwrap_err(),
        ContractError::ReviewDelayNotElapsed { at }
    );
    s.advance(7 * DAY);
    review(&mut s, id, &resolver).unwrap();
}

/// A resolver that holds a seat in the game cannot review it (R-4): it could
/// otherwise request and approve its own neutral exit alone.
#[test]
fn a_seated_resolver_cannot_review_its_own_game() {
    let mut s = Suite::new();
    let admin = s.admin.clone();
    let seat1 = s.players[1].clone();
    s.exec(
        &admin,
        &ExecuteMsg::SetResolver {
            resolver: seat1.to_string(),
        },
        &[],
    )
    .unwrap();
    let id = no_deadline_game(&mut s, 3);
    assert_eq!(s.game(id).game.resolver, Some(seat1.clone()));
    // No seat can even ask (no review could follow), so no deadline is shown.
    for seat in 0..3 {
        assert_eq!(
            request(&mut s, id, seat).unwrap_err(),
            ContractError::ResolverIsSeated {}
        );
    }
    assert_eq!(s.game(id).game.review_request, None);
    assert_eq!(s.game(id).deadlines.review_annul_available_at, None);
    s.advance(30 * DAY);
    assert_eq!(
        review(&mut s, id, &seat1).unwrap_err(),
        ContractError::ResolverIsSeated {}
    );
    assert_eq!(s.state(id), GameState::InProgress);
}

/// `ReviewAnnul` names the request it decides (review N-2): a decision taken
/// for a request that play has since withdrawn cannot execute against a later
/// request nobody reviewed.
#[test]
fn a_review_decision_is_bound_to_the_request_it_decided() {
    let mut s = Suite::new();
    let id = no_deadline_game(&mut s, 3);
    request(&mut s, id, 0).unwrap();
    let first = s.game(id).game.review_request.unwrap().requested_at;
    // The decision for the first request, prepared but not yet executed.
    let decision = ExecuteMsg::ReviewAnnul {
        chain_game_id: id,
        requested_at: first,
    };
    // Play continues (withdrawing it); later someone asks again.
    s.advance(DAY);
    s.post_checkpoint(id, 30, &[1, 1, 1]);
    assert_eq!(s.game(id).game.review_request, None);
    s.advance(DAY);
    request(&mut s, id, 2).unwrap();
    let second = s.game(id).game.review_request.unwrap().requested_at;
    s.advance(7 * DAY);
    let resolver = s.resolver.clone();
    assert_eq!(
        s.exec(&resolver, &decision, &[]).unwrap_err(),
        ContractError::ReviewRequestMismatch {
            requested_at: second
        }
    );
    assert_eq!(s.state(id), GameState::InProgress);
    review(&mut s, id, &resolver).unwrap();
}

/// Re-posting a round boundary already reached when the review was requested
/// (the emergency key rotation re-posts it under the new key) does not
/// withdraw the request (review N-1); a later boundary does.
#[test]
fn an_emergency_repost_of_a_reached_boundary_keeps_the_request() {
    let mut s = Suite::new();
    let id = no_deadline_game(&mut s, 3);
    s.post_checkpoint(id, 20, &[1, 1, 1]);
    request(&mut s, id, 0).unwrap();
    let recorded = s.game(id).game.review_request.unwrap();
    assert_eq!(recorded.trusted_seq.u64(), 40);
    // Emergency rotation: key 1 compromised, the same boundary re-posted by
    // key 2 (accepted because key 1's evidence lost its authority).
    let key2 = Key::signer(2);
    let k2 = s.add_key(&key2);
    s.pause();
    s.retire_key(1, true);
    let mut p = s.checkpoint_payload(id, 20, &[1, 1, 1]);
    p.signer_key_id = k2;
    let (payload, signature) = s.signed_by(&p, &key2);
    let who = s.outsider.clone();
    let res = s
        .exec(
            &who,
            &ExecuteMsg::Checkpoint {
                chain_game_id: id,
                payload,
                signature,
            },
            &[],
        )
        .unwrap();
    assert!(res
        .events
        .iter()
        .flat_map(|e| e.attributes.iter())
        .all(|a| a.key != "review_request_cleared"));
    assert_eq!(s.game(id).game.review_request, Some(recorded));
    s.unpause();
    // A boundary beyond it withdraws the request.
    let mut p = s.checkpoint_payload(id, 21, &[1, 1, 1]);
    p.signer_key_id = k2;
    let (payload, signature) = s.signed_by(&p, &key2);
    let res = s
        .exec(
            &who,
            &ExecuteMsg::Checkpoint {
                chain_game_id: id,
                payload,
                signature,
            },
            &[],
        )
        .unwrap();
    assert_eq!(attr(&res, "review_request_cleared"), "true");
    assert_eq!(attr(&res, "action"), "checkpoint");
    assert_eq!(s.game(id).game.review_request, None);
}

/// A configuration carried over from 2.0.0 has no review delay: no
/// No-deadline game can be created until the admin sets one (a Timed game
/// still can); `SetParams` refuses a zero delay.
#[test]
fn a_no_deadline_game_needs_a_configured_review_delay() {
    let mut s = Suite::new();
    // The stored 2.0.0 `Config` has no `params.review_delay_secs`.
    let mut config = serde_json::to_value(s.config().config).unwrap();
    config["params"]
        .as_object_mut()
        .unwrap()
        .remove("review_delay_secs")
        .unwrap();
    s.set_raw(b"config", &serde_json::to_vec(&config).unwrap());
    assert_eq!(s.config().config.params.review_delay_secs, 0);
    let creator = s.players[0].clone();
    assert_eq!(
        s.exec(
            &creator,
            &Suite::create_msg_with(2, Mode::Async, 0, true),
            &coins(ANTE, DENOM)
        )
        .unwrap_err(),
        ContractError::InvalidParams {
            reason: "review_delay_secs is not configured".to_string()
        }
    );
    let timed = s.create(0, 2, Mode::Async, ANTE);
    assert_eq!(s.game(timed).game.terms.review_delay_secs, 0);
    let admin = s.admin.clone();
    let mut params = default_params();
    params.review_delay_secs = 0;
    assert!(matches!(
        s.exec(&admin, &ExecuteMsg::SetParams { params }, &[])
            .unwrap_err(),
        ContractError::InvalidParams { .. }
    ));
    s.exec(
        &admin,
        &ExecuteMsg::SetParams {
            params: default_params(),
        },
        &[],
    )
    .unwrap();
    let res = s
        .exec(
            &creator,
            &Suite::create_msg_with(2, Mode::Async, 0, true),
            &coins(ANTE, DENOM),
        )
        .unwrap();
    let id: u64 = attr(&res, "chain_game_id").parse().unwrap();
    assert_eq!(s.game(id).game.terms.review_delay_secs, 7 * DAY);
    s.assert_custody();
}

/// KNOWN GAP of this build, pinned so it cannot be forgotten (review R-1): a
/// `TimedNoRemedies` game has no exit but completion and unanimity. One absent
/// seat holds it indefinitely: no liveness exit, no review, no cancel, and
/// N - 1 annul signatures fail. The timed remedies (pending the owner's
/// trust-bridge decision) are what must close this before any Timed money
/// table runs on 2.1.0.
#[test]
fn known_gap_a_timed_game_in_this_build_has_no_non_unanimous_exit() {
    let mut s = Suite::new();
    let id = s.started(3);
    assert_eq!(
        s.game(id).game.terms.policy,
        Some(GamePolicy::TimedNoRemedies)
    );
    s.advance(YEARS_10);
    assert_eq!(
        s.liveness(id, 0, None).unwrap_err(),
        ContractError::LivenessExitRemoved {}
    );
    assert_eq!(
        request(&mut s, id, 0).unwrap_err(),
        ContractError::ReviewNotAvailable {}
    );
    let who = s.outsider.clone();
    assert!(matches!(
        s.exec(&who, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
            .unwrap_err(),
        ContractError::WrongState { .. }
    ));
    let consents = s.annul_sigs(id, &[0, 1], 0);
    assert!(matches!(
        s.exec(
            &who,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents
            },
            &[]
        )
        .unwrap_err(),
        ContractError::MissingConsent { seat_index: 2 }
    ));
    assert_eq!(s.state(id), GameState::InProgress);
}

// ========================================================== migration (2.0.0)

/// A 2.0.0 instance migrated to this code (a future instance with a wasm
/// admin; JX-1 has none): every game it already holds keeps the 2.0.0 exit it
/// was funded under, and only games created afterwards get the 2.1.0 policy.
#[test]
fn a_migrated_2_0_0_game_keeps_its_2_0_0_exit_and_new_games_get_2_1() {
    let mut s = Suite::new();
    let old = s.started(3);
    s.make_legacy(old);
    // The 2.0.0 cw2 stamp.
    s.set_raw(
        b"contract_info",
        br#"{"contract":"crates.io:eighteen-cosmos-escrow","version":"2.0.0"}"#,
    );
    let admin = s.admin.clone();
    let contract = s.contract.clone();
    let code_id = s.code_id;
    let res = s
        .app
        .migrate_contract(
            admin,
            contract,
            &eighteen_cosmos_escrow::msg::MigrateMsg {},
            code_id,
        )
        .unwrap();
    assert_eq!(attr(&res, "from_version"), "2.0.0");
    assert_eq!(attr(&res, "to_version"), "2.1.0");
    assert_eq!(s.game(old).game.terms.policy, None);
    let new = s.started(3);
    assert_eq!(
        s.game(new).game.terms.policy,
        Some(GamePolicy::TimedNoRemedies)
    );
    s.advance(14 * DAY);
    // The new game has no IN_PROGRESS exit ...
    assert_eq!(
        s.liveness(new, 0, None).unwrap_err(),
        ContractError::LivenessExitRemoved {}
    );
    // ... the migrated one keeps its 2.0.0 exit (here: no checkpoint, refund),
    // and gains no review path.
    let resolver = s.resolver.clone();
    assert_eq!(
        review(&mut s, old, &resolver).unwrap_err(),
        ContractError::ReviewNotAvailable {}
    );
    s.liveness(old, 0, None).unwrap();
    assert_eq!(
        s.game(old).game.outcome.unwrap().route,
        Route::LivenessRefund
    );
    s.assert_custody();
}

// ======================================================= foreclosure formula

/// splitmix64.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

/// The settled formula (owner policy H) against an independent model, on
/// random rosters: the defaulter receives zero; every other seat its own net
/// deposit plus exactly ⌊net_D / (N − 1)⌋; the remainder is dust (< N − 1);
/// every base unit is accounted for; the result names exactly the N seats, so
/// nothing can be redirected.
#[test]
fn the_foreclosure_formula_matches_an_independent_model() {
    let mut rng = Rng(0x2101_f0c1_05ed);
    let mut cases = 0;
    for _ in 0..5_000 {
        let n = 2 + (rng.next() % 6) as usize;
        let equal = rng.next() % 4 != 0;
        let base = u128::from(rng.next()) * u128::from(rng.next() % 1_000);
        let nets: Vec<u128> = (0..n)
            .map(|_| {
                if equal {
                    base
                } else {
                    u128::from(rng.next() % 10_000_000_000)
                }
            })
            .collect();
        let d = (rng.next() % n as u64) as usize;
        let split = foreclosure_split(
            &nets.iter().map(|v| Uint128::new(*v)).collect::<Vec<_>>(),
            d,
        )
        .unwrap();
        // Model: long division by repeated subtraction of (n - 1) chunks.
        let others = (n - 1) as u128;
        let share = nets[d] / others;
        let rem = nets[d] - share * others;
        assert_eq!(split.amounts.len(), n);
        let mut total = 0u128;
        for (i, amount) in split.amounts.iter().enumerate() {
            let want = if i == d { 0 } else { nets[i] + share };
            assert_eq!(amount.u128(), want, "seat {i} of {n}, defaulter {d}");
            if i != d {
                assert!(amount.u128() >= nets[i], "a non-defaulter lost money");
            }
            total += amount.u128();
        }
        assert_eq!(split.dust.u128(), rem);
        assert!(rem < others);
        assert_eq!(total + rem, nets.iter().sum::<u128>(), "conservation");
        if equal {
            // All non-defaulting shares are identical.
            let first = split.amounts[if d == 0 { 1 } else { 0 }];
            assert!(split
                .amounts
                .iter()
                .enumerate()
                .all(|(i, a)| i == d || *a == first));
        }
        cases += 1;
    }
    assert_eq!(cases, 5_000);
}

/// The formula on the contract's own fixture numbers (2 JUNO gross, 250 bps,
/// so 1_950_000 net): already-spent subsidies are never fabricated back.
#[test]
fn the_foreclosure_formula_on_real_antes() {
    let net = |n: usize| vec![Uint128::new(NET); n];
    // 3 seats: D's 1_950_000 / 2 = 975_000 each, no dust.
    let s3 = foreclosure_split(&net(3), 1).unwrap();
    assert_eq!(
        s3.amounts,
        vec![
            Uint128::new(2_925_000),
            Uint128::zero(),
            Uint128::new(2_925_000)
        ]
    );
    assert!(s3.dust.is_zero());
    // 7 seats: 1_950_000 / 6 = 325_000, no dust.
    let s7 = foreclosure_split(&net(7), 0).unwrap();
    assert_eq!(s7.amounts[0], Uint128::zero());
    assert!(s7.amounts[1..].iter().all(|a| a.u128() == NET + 325_000));
    // 4 seats: 1_950_000 / 3 = 650_000, no dust; the total is the pool, never
    // the 2_000_000 gross (the subsidy went to the treasury at deposit).
    let s4 = foreclosure_split(&net(4), 3).unwrap();
    let paid: u128 = s4.amounts.iter().map(|a| a.u128()).sum();
    assert_eq!(paid + s4.dust.u128(), 4 * NET);
    assert!(paid < 4 * ANTE);
}
