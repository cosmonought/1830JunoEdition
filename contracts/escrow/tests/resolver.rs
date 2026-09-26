//! Resolve: Uphold, Replace and Annul, by the configured resolver address only.

mod common;

use common::*;
use cosmwasm_std::{coins, Addr, Uint128};
use cw_multi_test::AppResponse;
use eighteen_cosmos_escrow::msg::{ExecuteMsg, ResolveOutcome};
use eighteen_cosmos_escrow::payload::{Payload, REASON_RESOLVER_CORRECTION};
use eighteen_cosmos_escrow::state::{
    DisputeResolution, GameParams, GameState, Route, SettlementSource,
};
use eighteen_cosmos_escrow::ContractError;

fn replace(p: &Payload) -> ResolveOutcome {
    ResolveOutcome::Replace {
        payload: Suite::wire(p),
    }
}

fn correction(s: &Suite, id: u64, log_len: u64, weights: &[u128]) -> Payload {
    s.terminal_payload(id, REASON_RESOLVER_CORRECTION, log_len, weights)
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

fn u(v: &[u128]) -> Vec<Uint128> {
    v.iter().map(|x| Uint128::new(*x)).collect()
}

#[test]
fn only_the_resolver_may_resolve_and_it_takes_no_funds() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(3);
    for who in [
        s.admin.clone(),
        s.operator.clone(),
        s.outsider.clone(),
        s.players[0].clone(),
        s.players[1].clone(),
        s.treasury.clone(),
    ] {
        for outcome in [ResolveOutcome::Uphold {}, ResolveOutcome::Annul {}] {
            assert_eq!(
                s.exec(
                    &who,
                    &ExecuteMsg::Resolve {
                        chain_game_id: id,
                        outcome,
                    },
                    &[],
                )
                .unwrap_err(),
                ContractError::Unauthorized {
                    role: "resolver".to_string()
                }
            );
        }
    }
    let resolver = s.resolver.clone();
    assert_eq!(
        s.exec(
            &resolver,
            &ExecuteMsg::Resolve {
                chain_game_id: id,
                outcome: ResolveOutcome::Uphold {},
            },
            &coins(1, DENOM),
        )
        .unwrap_err(),
        ContractError::NonPayable {}
    );
    assert_eq!(s.state(id), GameState::Disputed);
    s.assert_custody();
}

#[test]
fn uphold_adds_the_bond_to_the_pool_and_pays_the_stored_vector() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(3);
    let bond = s.bond(id);
    assert_eq!(bond, 1_000_000);
    s.advance(DAY);
    let t = s.now();
    let (d, dust, res) = deltas(&mut s, 3, |s| {
        s.resolve(id, ResolveOutcome::Uphold {}).unwrap()
    });
    assert_eq!(attr(&res, "outcome"), "uphold");
    assert_eq!(d, vec![1_141_666, 2_283_333, 3_425_000]);
    assert_eq!(dust, 1);
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settled);
    assert_eq!(g.pool, Uint128::zero());
    let o = g.outcome.unwrap();
    assert_eq!(o.route, Route::ResolverUphold);
    assert_eq!(o.amounts, u(&[1_141_666, 2_283_333, 3_425_000]));
    assert_eq!(o.distributed.u128(), 3 * NET + bond);
    assert_eq!(o.bond_to_pool.u128(), bond);
    assert_eq!(o.bond_returned, Uint128::zero());
    let dispute = g.dispute.unwrap();
    assert_eq!(dispute.resolution, Some(DisputeResolution::Upheld));
    assert_eq!(dispute.resolved_at, Some(t));
    assert_eq!(s.contract_balance(), 0);
    s.assert_custody();
}

#[test]
fn replace_pays_the_corrected_vector_and_returns_the_bond() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(3);
    let bond = s.bond(id);
    let p = correction(&s, id, 101, &[3, 2, 1]);
    let (d, dust, res) = deltas(&mut s, 3, |s| s.resolve(id, replace(&p)).unwrap());
    assert_eq!(attr(&res, "outcome"), "replace");
    // Seat 1 is the challenger: its share plus its bond back.
    assert_eq!(d, vec![2_925_000, 1_950_000 + bond, 975_000]);
    assert_eq!(dust, 0);
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settled);
    assert_eq!(g.last_seq.u64(), 203);
    assert_eq!(g.consent_bitmap, 0);
    let st = g.settlement.unwrap();
    assert_eq!(st.source, SettlementSource::ResolverReplacement);
    assert_eq!(st.payload.reason, REASON_RESOLVER_CORRECTION);
    assert_eq!(st.payload.seq.u64(), 203);
    assert_eq!(st.payload.settlement_weights, u(&[3, 2, 1]));
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&p).to_vec()
    );
    let o = g.outcome.unwrap();
    assert_eq!(o.route, Route::ResolverReplace);
    assert_eq!(o.bond_returned.u128(), bond);
    assert_eq!(o.bond_to_pool, Uint128::zero());
    assert_eq!(o.distributed.u128(), 3 * NET);
    assert_eq!(
        g.dispute.unwrap().resolution,
        Some(DisputeResolution::Replaced)
    );
    assert_eq!(s.contract_balance(), 0);
    s.assert_custody();
}

#[test]
fn replace_refusals_leave_the_dispute_open() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(3); // stored settlement: log 100, seq 201
    let other = s.started(3);
    let mut cases: Vec<(Payload, ContractError)> = vec![
        (
            correction(&s, other, 101, &[1, 1, 1]),
            ContractError::DomainMismatch {},
        ),
        (
            s.terminal_payload(id, 1, 101, &[1, 1, 1]),
            ContractError::ReasonNotAllowed { reason: 1 },
        ),
        (
            s.terminal_payload(id, 4, 101, &[1, 1, 1]),
            ContractError::ReasonNotAllowed { reason: 4 },
        ),
        (
            s.checkpoint_payload(id, 101, &[1, 1, 1]),
            ContractError::WrongKind {
                expected: "terminal".to_string(),
            },
        ),
        (
            correction(&s, id, 101, &[0, 0, 0]),
            ContractError::ZeroSumWeights {},
        ),
        (
            correction(&s, id, 101, &[1, 1]),
            ContractError::RosterLengthMismatch {
                expected: 3,
                got: 2,
            },
        ),
    ];
    let mut early = correction(&s, id, 101, &[1, 1, 1]);
    early.appraisal_log_len = 100;
    cases.push((
        early,
        ContractError::BadAppraisalLogLen {
            appraisal_log_len: 100,
            log_len: 101,
        },
    ));
    let mut bad_seq = correction(&s, id, 101, &[1, 1, 1]);
    bad_seq.seq = 202;
    cases.push((bad_seq, ContractError::BadSeq { seq: 202 }));
    let mut v2 = correction(&s, id, 101, &[1, 1, 1]);
    v2.version = 2;
    cases.push((v2, ContractError::BadVersion { got: 2 }));
    let mut reserved = correction(&s, id, 101, &[1, 1, 1]);
    reserved.reason = 9;
    cases.push((reserved, ContractError::UnknownReason { got: 9 }));
    for (p, expected) in cases {
        assert_eq!(s.resolve(id, replace(&p)).unwrap_err(), expected);
    }
    // seat_count disagreeing with the vector.
    let mut w = Suite::wire(&correction(&s, id, 101, &[1, 1, 1]));
    w.seat_count = 2;
    assert_eq!(
        s.resolve(id, ResolveOutcome::Replace { payload: w })
            .unwrap_err(),
        ContractError::SeatCountMismatch {
            seat_count: 2,
            weights: 3
        }
    );
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Disputed);
    assert_eq!(g.last_seq.u64(), 201);
    assert!(g.dispute.unwrap().resolution.is_none());
    s.assert_custody();
}

#[test]
fn replace_is_authorised_by_the_resolver_not_by_the_signer_registry() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(2);
    // The signer who produced the disputed settlement is retired as compromised;
    // the correction names an unknown key id. Neither matters to Replace.
    s.retire_key(1, true);
    let mut p = correction(&s, id, 150, &[1, 4]);
    p.signer_key_id = 999;
    s.resolve(id, replace(&p)).unwrap();
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settled);
    assert_eq!(g.settlement.unwrap().payload.signer_key_id, 999);
    assert_eq!(
        g.outcome.unwrap().amounts,
        u(&[2 * NET / 5, 2 * NET * 4 / 5])
    );
}

#[test]
fn annul_refunds_every_net_ante_and_returns_the_bond() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(3);
    let bond = s.bond(id);
    let (d, dust, res) = deltas(&mut s, 3, |s| {
        s.resolve(id, ResolveOutcome::Annul {}).unwrap()
    });
    assert_eq!(attr(&res, "outcome"), "annul");
    assert_eq!(d, vec![NET, NET + bond, NET]);
    assert_eq!(dust, 0);
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Annulled);
    assert_eq!(g.pool, Uint128::zero());
    let o = g.outcome.unwrap();
    assert_eq!(o.route, Route::ResolverAnnul);
    assert_eq!(o.amounts, u(&[NET, NET, NET]));
    assert_eq!(o.bond_returned.u128(), bond);
    assert_eq!(
        g.dispute.unwrap().resolution,
        Some(DisputeResolution::Annulled)
    );
    assert_eq!(s.contract_balance(), 0);
    s.assert_custody();
}

#[test]
fn resolve_needs_a_disputed_game_and_happens_once() {
    let mut s = Suite::new();
    let in_progress = s.started(2);
    let (settleable, _) = s.settleable(2);
    let settled = s.settled(2);
    for (id, actual) in [
        (in_progress, "in_progress"),
        (settleable, "settleable"),
        (settled, "settled"),
    ] {
        assert_eq!(
            s.resolve(id, ResolveOutcome::Uphold {}).unwrap_err(),
            ContractError::WrongState {
                expected: "disputed".to_string(),
                actual: actual.to_string()
            }
        );
    }
    let (id, _) = s.disputed(2);
    s.resolve(id, ResolveOutcome::Uphold {}).unwrap();
    for outcome in [
        ResolveOutcome::Uphold {},
        ResolveOutcome::Annul {},
        replace(&correction(&s, id, 500, &[1, 1])),
    ] {
        assert!(matches!(
            s.resolve(id, outcome).unwrap_err(),
            ContractError::WrongState { .. }
        ));
    }
    assert_eq!(
        s.resolve(77, ResolveOutcome::Uphold {}).unwrap_err(),
        ContractError::GameNotFound { chain_game_id: 77 }
    );
    s.assert_custody();
}

#[test]
fn resolve_works_while_paused() {
    let mut s = Suite::new();
    let (a, _) = s.disputed(2);
    let (b, _) = s.disputed(2);
    let (c, _) = s.disputed(2);
    s.pause();
    s.resolve(a, ResolveOutcome::Uphold {}).unwrap();
    let p = correction(&s, b, 300, &[1, 1]);
    s.resolve(b, replace(&p)).unwrap();
    s.resolve(c, ResolveOutcome::Annul {}).unwrap();
    assert_eq!(s.state(a), GameState::Settled);
    assert_eq!(s.state(b), GameState::Settled);
    assert_eq!(s.state(c), GameState::Annulled);
    s.assert_custody();
}

#[test]
fn resolve_still_works_after_the_resolver_timeout_until_someone_exits() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(2);
    s.advance(31 * DAY);
    s.resolve(id, ResolveOutcome::Annul {}).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
    let alice = s.players[1].clone();
    assert!(matches!(
        s.exec(
            &alice,
            &ExecuteMsg::LivenessSettle {
                chain_game_id: id,
                checkpoint: None
            },
            &[]
        )
        .unwrap_err(),
        ContractError::WrongState { .. }
    ));
}

#[test]
fn set_resolver_only_affects_games_started_afterwards() {
    // OD-ESC2-5: a game adopts the resolver at Start and keeps it.
    let mut s = Suite::new();
    let a = s.resolver.clone();
    let b = s.addr("resolver-b");
    let started_with_a = s.started(2);
    let funded_before = s.funded(2);
    let (settleable_with_a, _) = s.settleable(2);
    let (disputed_with_a, _) = s.disputed(2);
    for id in [started_with_a, settleable_with_a, disputed_with_a] {
        assert_eq!(s.game_resolver(id), Some(a.clone()));
    }
    assert_eq!(s.game_resolver(funded_before), None, "adopted at Start");
    let admin = s.admin.clone();
    let res = s
        .exec(
            &admin,
            &ExecuteMsg::SetResolver {
                resolver: b.to_string(),
            },
            &[],
        )
        .unwrap();
    assert_eq!(attr(&res, "resolver"), b.to_string());
    assert_eq!(s.config().config.resolver, b);
    // Started before the change: A adjudicates, B cannot — including disputes
    // that only open after the change.
    let later_dispute = {
        s.settle(started_with_a, 1, 100, &[1, 2], &[]);
        s.challenge(started_with_a, 1);
        started_with_a
    };
    s.challenge(settleable_with_a, 0);
    for id in [later_dispute, settleable_with_a, disputed_with_a] {
        assert_eq!(s.game_resolver(id), Some(a.clone()));
        assert_eq!(
            s.exec(
                &b,
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
        s.resolve(id, ResolveOutcome::Uphold {}).unwrap();
        assert_eq!(s.state(id), GameState::Settled);
    }
    // Started after the change (even though funded before it): B.
    s.start(funded_before);
    assert_eq!(s.game_resolver(funded_before), Some(b.clone()));
    let started_with_b = s.started(2);
    assert_eq!(s.game_resolver(started_with_b), Some(b.clone()));
    for id in [funded_before, started_with_b] {
        s.settle(id, 1, 100, &[1, 1], &[]);
        s.challenge(id, 0);
        assert_eq!(
            s.resolve(id, ResolveOutcome::Uphold {}).unwrap_err(),
            ContractError::Unauthorized {
                role: "resolver".to_string()
            }
        );
        s.exec(
            &b,
            &ExecuteMsg::Resolve {
                chain_game_id: id,
                outcome: ResolveOutcome::Annul {},
            },
            &[],
        )
        .unwrap();
        assert_eq!(s.state(id), GameState::Annulled);
    }
    s.assert_custody();
}

#[test]
fn the_admin_cannot_take_over_a_started_games_dispute() {
    // The reported attack: admin → SetResolver(self) → Uphold, on a game that
    // had already started. The game keeps the resolver it adopted at Start.
    let mut s = Suite::new();
    let (id, _) = s.disputed(3);
    let admin = s.admin.clone();
    s.exec(
        &admin,
        &ExecuteMsg::SetResolver {
            resolver: admin.to_string(),
        },
        &[],
    )
    .unwrap();
    for outcome in [
        ResolveOutcome::Uphold {},
        ResolveOutcome::Annul {},
        replace(&correction(&s, id, 150, &[1, 0, 0])),
    ] {
        assert_eq!(
            s.exec(
                &admin,
                &ExecuteMsg::Resolve {
                    chain_game_id: id,
                    outcome,
                },
                &[],
            )
            .unwrap_err(),
            ContractError::Unauthorized {
                role: "resolver".to_string()
            }
        );
    }
    assert_eq!(s.state(id), GameState::Disputed);
    s.resolve(id, ResolveOutcome::Annul {}).unwrap();
    s.assert_custody();
}

#[test]
fn replace_may_correct_the_same_or_an_earlier_terminal_log_position() {
    // The disputed settlement never constrains its correction.
    let mut s = Suite::new();
    let (same, _) = s.disputed(3); // disputed terminal: log 100, seq 201
    let p = correction(&s, same, 100, &[2, 1, 1]);
    s.resolve(same, replace(&p)).unwrap();
    let g = s.game(same).game;
    assert_eq!(g.state, GameState::Settled);
    assert_eq!(g.settlement.unwrap().payload.seq.u64(), 201);
    assert_eq!(g.last_seq.u64(), 201, "raw history keeps the maximum");

    let (earlier, _) = s.disputed(3);
    let p = correction(&s, earlier, 60, &[1, 1, 2]);
    s.resolve(earlier, replace(&p)).unwrap();
    let g = s.game(earlier).game;
    assert_eq!(g.settlement.unwrap().payload.seq.u64(), 121);
    assert_eq!(g.last_seq.u64(), 201, "raw history never decreases");
    s.assert_custody();
}

#[test]
fn replace_must_lie_beyond_the_latest_trusted_checkpoint() {
    let mut s = Suite::new();
    let id = s.started(3);
    s.post_checkpoint(id, 50, &[1, 1, 1]); // trusted checkpoint floor: seq 100
    s.settle(id, 1, 100, &[1, 2, 3], &[]);
    s.challenge(id, 1);
    for log_len in [0u64, 10, 49] {
        let p = correction(&s, id, log_len, &[1, 1, 1]);
        assert_eq!(
            s.resolve(id, replace(&p)).unwrap_err(),
            ContractError::StaleSeq {
                seq: 2 * log_len + 1,
                trusted_seq: 100
            }
        );
    }
    // The checkpoint's own log position is fine (a terminal's seq is 2L + 1).
    let p = correction(&s, id, 50, &[1, 1, 1]);
    s.resolve(id, replace(&p)).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    assert_eq!(s.game(id).game.settlement.unwrap().payload.seq.u64(), 101);
}

#[test]
fn uphold_with_a_zero_bond_and_a_zero_weight_seat() {
    let params = GameParams {
        bond_bps: 0,
        bond_floor: Uint128::zero(),
        ..default_params()
    };
    let mut s = SuiteBuilder::default().params(params).build();
    let id = s.started(3);
    s.settle(id, 2, 100, &[0, 5, 5], &[]);
    let alice = s.players[1].clone();
    s.exec(
        &alice,
        &ExecuteMsg::Challenge {
            chain_game_id: id,
            evidence_hash: cosmwasm_std::HexBinary::from(vec![9u8; 32]),
        },
        &[],
    )
    .unwrap();
    let (d, dust, res) = deltas(&mut s, 3, |s| {
        s.resolve(id, ResolveOutcome::Uphold {}).unwrap()
    });
    assert_eq!(d, vec![0, 2_925_000, 2_925_000]);
    assert_eq!(dust, 0);
    let creator = s.players[0].to_string();
    assert!(bank_sends(&res).iter().all(|(to, _)| *to != creator));
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(o.bond_to_pool, Uint128::zero());
    assert_eq!(o.distributed.u128(), 3 * NET);
    s.assert_custody();
}

#[test]
fn uphold_on_seven_seats_with_near_max_weights_uses_wide_arithmetic() {
    let mut s = Suite::new();
    let id = s.started(7);
    let weights = [u128::MAX, u128::MAX - 1, 0, 0, 0, 0, 1];
    s.settle(id, 1, 900, &weights, &[]);
    s.challenge(id, 1);
    let (d, dust, _) = deltas(&mut s, 7, |s| {
        s.resolve(id, ResolveOutcome::Uphold {}).unwrap()
    });
    // pool 7·1.95 + 1 bond = 14.65 JUNO; Σw = 2·(2^128 − 1) needs 129 bits.
    // Seat 1 is the challenger: its payout only (the bond went to the pool).
    assert_eq!(d, vec![7_325_000, 7_324_999, 0, 0, 0, 0, 0]);
    assert_eq!(dust, 1);
    s.assert_custody();
}

#[test]
fn the_resolver_has_no_power_outside_a_dispute() {
    let mut s = Suite::new();
    let id = s.started(2);
    let resolver = s.resolver.clone();
    // Not seated: no liveness exit, no challenge, no key rotation.
    for msg in [
        ExecuteMsg::LivenessSettle {
            chain_game_id: id,
            checkpoint: None,
        },
        ExecuteMsg::SetConsentKey {
            chain_game_id: id,
            new_pubkey: Key::seat(0).pubkey,
        },
    ] {
        assert_eq!(
            s.exec(&resolver, &msg, &[]).unwrap_err(),
            ContractError::NotSeated { chain_game_id: id }
        );
    }
    // No Start (operator only) and no admin messages.
    let funded = s.funded(2);
    let rh = s.roster_hash(funded);
    assert_eq!(
        s.exec(
            &resolver,
            &ExecuteMsg::Start {
                chain_game_id: funded,
                roster_hash: rh,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::Unauthorized {
            role: "operator".to_string()
        }
    );
    assert_eq!(
        s.exec(&resolver, &ExecuteMsg::Pause {}, &[]).unwrap_err(),
        ContractError::Unauthorized {
            role: "admin".to_string()
        }
    );
    // Not the creator before the deadline: no cancel.
    assert_eq!(
        s.exec(
            &resolver,
            &ExecuteMsg::Cancel {
                chain_game_id: funded
            },
            &[]
        )
        .unwrap_err(),
        ContractError::Unauthorized {
            role: "creator (or anyone after the funding deadline)".to_string()
        }
    );
    s.assert_custody();
}
