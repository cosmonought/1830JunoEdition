//! Challenge: a seated wallet disputes the stored settlement inside the window,
//! posting exactly the game's bond.

mod common;

use common::*;
use cosmwasm_std::{coin, coins, Coin, HexBinary, Uint128};
use cw_multi_test::AppResponse;
use eighteen_cosmos_escrow::msg::ExecuteMsg;
use eighteen_cosmos_escrow::state::{GameParams, GameState, Mode};
use eighteen_cosmos_escrow::ContractError;

fn evidence() -> HexBinary {
    HexBinary::from(sha256(&[b"18JUNO/EVIDENCE/v1", b"exported log"]).as_slice())
}

fn challenge_msg(id: u64, evidence_hash: HexBinary) -> ExecuteMsg {
    ExecuteMsg::Challenge {
        chain_game_id: id,
        evidence_hash,
    }
}

fn challenge_as(
    s: &mut Suite,
    id: u64,
    seat: usize,
    funds: &[Coin],
) -> Result<AppResponse, ContractError> {
    let who = s.players[seat].clone();
    s.exec(&who, &challenge_msg(id, evidence()), funds)
}

#[test]
fn a_seated_wallet_challenges_with_the_exact_bond() {
    let mut s = Suite::new();
    let (id, _) = s.settleable(3);
    let bond = s.bond(id);
    assert_eq!(bond, 1_000_000, "max(1 JUNO, 50 % of 1.95 JUNO)");
    s.advance(HOUR);
    let t = s.now();
    let alice = s.players[1].clone();
    let before = s.balance(&alice);
    let res = challenge_as(&mut s, id, 1, &coins(bond, DENOM)).unwrap();
    assert_eq!(attr(&res, "state"), "disputed");
    assert_eq!(attr(&res, "bond"), bond.to_string());
    assert_eq!(s.balance(&alice), before - bond);
    let gr = s.game(id);
    assert_eq!(gr.game.state, GameState::Disputed);
    let d = gr.game.dispute.unwrap();
    assert_eq!(d.challenger, alice);
    assert_eq!(d.bond.u128(), bond);
    assert_eq!(d.evidence_hash, evidence());
    assert_eq!(d.disputed_at, t);
    assert!(d.resolution.is_none() && d.resolved_at.is_none());
    assert_eq!(
        gr.deadlines.resolver_timeout_at,
        Some(t.plus_seconds(30 * DAY))
    );
    assert_eq!(gr.deadlines.challenge_window_end, None);
    // The pool is untouched; the bond is held beside it.
    assert_eq!(gr.game.pool.u128(), 3 * NET);
    assert_eq!(s.contract_balance(), 3 * NET + bond);
    s.assert_custody();
}

#[test]
fn the_creator_can_challenge() {
    let mut s = Suite::new();
    let (id, _) = s.settleable(2);
    let bond = s.bond(id);
    challenge_as(&mut s, id, 0, &coins(bond, DENOM)).unwrap();
    assert_eq!(s.game(id).game.dispute.unwrap().challenger, s.players[0]);
}

#[test]
fn a_seat_that_already_consented_may_still_challenge() {
    let mut s = Suite::new();
    let id = s.started(3);
    s.settle(id, 1, 100, &[1, 1, 1], &[1]);
    let bond = s.bond(id);
    challenge_as(&mut s, id, 1, &coins(bond, DENOM)).unwrap();
    assert_eq!(s.state(id), GameState::Disputed);
}

#[test]
fn only_seated_wallets_may_challenge() {
    let mut s = Suite::new();
    let (id, _) = s.settleable(3);
    let bond = s.bond(id);
    for who in [
        s.admin.clone(),
        s.operator.clone(),
        s.resolver.clone(),
        s.outsider.clone(),
        s.treasury.clone(),
        s.players[3].clone(),
    ] {
        if who == s.treasury {
            // The treasury holds no balance in this harness; send it one.
            let admin = s.admin.clone();
            cw_multi_test::Executor::send_tokens(
                &mut s.app,
                admin,
                who.clone(),
                &coins(bond, DENOM),
            )
            .unwrap();
        }
        assert_eq!(
            s.exec(&who, &challenge_msg(id, evidence()), &coins(bond, DENOM))
                .unwrap_err(),
            ContractError::NotSeated { chain_game_id: id }
        );
    }
    assert_eq!(s.state(id), GameState::Settleable);
    s.assert_custody();
}

#[test]
fn the_bond_must_be_exact_in_amount_and_denom() {
    let mut s = Suite::new();
    let (id, _) = s.settleable(2);
    let bond = s.bond(id);
    let cases: Vec<(Vec<Coin>, ContractError)> = vec![
        (
            coins(bond - 1, DENOM),
            ContractError::WrongBond {
                expected: Uint128::new(bond),
                got: Uint128::new(bond - 1),
            },
        ),
        (
            coins(bond + 1, DENOM),
            ContractError::WrongBond {
                expected: Uint128::new(bond),
                got: Uint128::new(bond + 1),
            },
        ),
        (
            vec![],
            ContractError::WrongBond {
                expected: Uint128::new(bond),
                got: Uint128::zero(),
            },
        ),
        (
            coins(bond, "uatom"),
            ContractError::InvalidFunds {
                denom: DENOM.to_string(),
            },
        ),
        (
            vec![coin(bond, "uatom"), coin(bond, DENOM)],
            ContractError::InvalidFunds {
                denom: DENOM.to_string(),
            },
        ),
    ];
    let alice = s.players[1].clone();
    let before = s.balance(&alice);
    for (funds, expected) in cases {
        assert_eq!(challenge_as(&mut s, id, 1, &funds).unwrap_err(), expected);
    }
    assert_eq!(s.balance(&alice), before);
    assert_eq!(s.state(id), GameState::Settleable);
    challenge_as(&mut s, id, 1, &coins(bond, DENOM)).unwrap();
    s.assert_custody();
}

#[test]
fn the_bond_scales_with_the_net_ante() {
    let mut s = Suite::new();
    let id = s.started_with(2, Mode::Live, 10_000_000);
    s.settle(id, 1, 100, &[1, 1], &[]);
    assert_eq!(s.bond(id), 4_875_000);
    assert!(matches!(
        challenge_as(&mut s, id, 1, &coins(1_000_000, DENOM)).unwrap_err(),
        ContractError::WrongBond { .. }
    ));
    challenge_as(&mut s, id, 1, &coins(4_875_000, DENOM)).unwrap();
    assert_eq!(s.contract_balance(), 2 * 9_750_000 + 4_875_000);
    s.assert_custody();
}

#[test]
fn the_window_closes_exactly_at_window_end() {
    let mut s = Suite::new();
    let (a, _) = s.settleable(2);
    let (b, _) = s.settleable(2);
    let end = s.game(a).game.settlement.unwrap().window_end;
    s.advance(DAY - 1);
    let bond = s.bond(a);
    challenge_as(&mut s, a, 1, &coins(bond, DENOM)).unwrap();
    s.advance(1);
    let end_b = s.game(b).game.settlement.unwrap().window_end;
    assert_eq!(end_b, end);
    assert_eq!(s.now(), end);
    assert_eq!(
        challenge_as(&mut s, b, 1, &coins(bond, DENOM)).unwrap_err(),
        ContractError::WindowClosed { closed: end }
    );
    s.advance(DAY);
    assert_eq!(
        challenge_as(&mut s, b, 1, &coins(bond, DENOM)).unwrap_err(),
        ContractError::WindowClosed { closed: end }
    );
}

#[test]
fn async_games_can_be_challenged_on_the_second_day() {
    let mut s = Suite::new();
    let id = s.started_with(2, Mode::Async, ANTE);
    s.settle(id, 1, 100, &[1, 1], &[]);
    s.advance(DAY + HOUR);
    let bond = s.bond(id);
    challenge_as(&mut s, id, 0, &coins(bond, DENOM)).unwrap();
    assert_eq!(s.state(id), GameState::Disputed);
}

#[test]
fn only_a_settleable_game_can_be_challenged() {
    let mut s = Suite::new();
    let funding = s.create(0, 3, Mode::Live, ANTE);
    let funded = s.funded(2);
    let in_progress = s.started(2);
    let (disputed, _) = s.disputed(2);
    let settled = s.settled(2);
    let cancelled = s.cancelled(2);
    let annulled = s.annulled(2);
    for (id, actual) in [
        (funding, "funding"),
        (funded, "funded"),
        (in_progress, "in_progress"),
        (disputed, "disputed"),
        (settled, "settled"),
        (cancelled, "cancelled"),
        (annulled, "annulled"),
    ] {
        assert_eq!(
            challenge_as(&mut s, id, 0, &coins(1_000_000, DENOM)).unwrap_err(),
            ContractError::WrongState {
                expected: "settleable".to_string(),
                actual: actual.to_string()
            }
        );
    }
    s.assert_custody();
}

/// A DISPUTED game refuses everything but resolution (and, for an escrow
/// 2.1.0 game only, the universal unanimous annulment: `tests/remedy.rs`).
#[test]
fn a_disputed_game_refuses_every_non_resolution_message() {
    for legacy in [true, false] {
        a_disputed_game_refuses_every_non_resolution_message_for(legacy);
    }
}

fn a_disputed_game_refuses_every_non_resolution_message_for(legacy: bool) {
    let mut s = Suite::new();
    s.legacy = legacy;
    let (id, p) = s.disputed(3);
    let who = s.outsider.clone();
    let digest = s.consent_digest(id, &p);
    let later = s.terminal_payload(id, 1, 500, &[1, 1, 1]);
    let mut msgs = vec![
        ExecuteMsg::Finalize { chain_game_id: id },
        ExecuteMsg::Consent {
            chain_game_id: id,
            seat_index: 0,
            signature: Key::seat(0).sign(&digest),
        },
        s.settle_msg(id, &later, &[0, 1, 2]),
        s.checkpoint_msg(id, &s.checkpoint_payload(id, 600, &[1, 1, 1])),
        ExecuteMsg::Withdraw { chain_game_id: id },
        ExecuteMsg::Cancel { chain_game_id: id },
    ];
    if legacy {
        msgs.push(ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents: s.annul_sigs(id, &[0, 1, 2], s.last_seq(id)),
        });
    }
    s.advance(2 * DAY);
    for msg in &msgs {
        for sender in [who.clone(), s.players[0].clone()] {
            assert!(matches!(
                s.exec(&sender, msg, &[]).unwrap_err(),
                ContractError::WrongState { .. }
            ));
        }
    }
    let alice = s.players[1].clone();
    assert!(matches!(
        s.exec(
            &alice,
            &ExecuteMsg::SetConsentKey {
                chain_game_id: id,
                new_pubkey: Key::seat(8).pubkey,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::WrongState { .. }
    ));
    assert_eq!(s.state(id), GameState::Disputed);
    s.assert_custody();
}

#[test]
fn challenge_works_while_paused() {
    let mut s = Suite::new();
    let (id, _) = s.settleable(2);
    s.pause();
    let bond = s.bond(id);
    challenge_as(&mut s, id, 1, &coins(bond, DENOM)).unwrap();
    assert_eq!(s.state(id), GameState::Disputed);
    s.assert_custody();
}

#[test]
fn a_zero_bond_configuration_takes_no_funds() {
    let params = GameParams {
        bond_bps: 0,
        bond_floor: Uint128::zero(),
        ..default_params()
    };
    let mut s = SuiteBuilder::default().params(params).build();
    let (id, _) = s.settleable(2);
    assert_eq!(s.bond(id), 0);
    assert_eq!(
        challenge_as(&mut s, id, 1, &coins(1, DENOM)).unwrap_err(),
        ContractError::NonPayable {}
    );
    let res = challenge_as(&mut s, id, 1, &[]).unwrap();
    assert_eq!(attr(&res, "bond"), "0");
    assert_eq!(s.game(id).game.dispute.unwrap().bond, Uint128::zero());
    assert_eq!(s.contract_balance(), 2 * NET);
    s.assert_custody();
}

#[test]
fn the_evidence_hash_must_be_32_bytes() {
    let mut s = Suite::new();
    let (id, _) = s.settleable(2);
    let bond = s.bond(id);
    let alice = s.players[1].clone();
    for len in [0usize, 31, 33, 64] {
        assert_eq!(
            s.exec(
                &alice,
                &challenge_msg(id, HexBinary::from(vec![0xabu8; len])),
                &coins(bond, DENOM)
            )
            .unwrap_err(),
            ContractError::BadLength {
                field: "evidence_hash".to_string(),
                expected: 32,
                got: len
            }
        );
    }
    assert_eq!(s.state(id), GameState::Settleable);
}

#[test]
fn a_second_challenge_is_refused() {
    let mut s = Suite::new();
    let (id, _) = s.disputed(3);
    let bond = s.bond(id);
    for seat in 0..3 {
        assert!(matches!(
            challenge_as(&mut s, id, seat, &coins(bond, DENOM)).unwrap_err(),
            ContractError::WrongState { .. }
        ));
    }
    assert_eq!(s.contract_balance(), 3 * NET + bond);
    s.assert_custody();
}
