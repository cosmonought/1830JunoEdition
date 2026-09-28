//! FUNDED → IN_PROGRESS: operator Start, roster hash, domain and bond.

mod common;

use common::*;
use cosmwasm_std::{coins, HexBinary};
use eighteen_cosmos_escrow::crypto::{self, DomainInputs};
use eighteen_cosmos_escrow::msg::ExecuteMsg;
use eighteen_cosmos_escrow::state::{GameState, Mode};
use eighteen_cosmos_escrow::ContractError;

fn start_msg(id: u64, roster_hash: HexBinary) -> ExecuteMsg {
    ExecuteMsg::Start {
        chain_game_id: id,
        roster_hash,
    }
}

#[test]
fn only_the_operator_may_start() {
    let mut s = Suite::new();
    let id = s.funded(3);
    let rh = s.roster_hash(id);
    for who in [
        s.admin.clone(),
        s.resolver.clone(),
        s.players[0].clone(),
        s.outsider.clone(),
    ] {
        assert_eq!(
            s.exec(&who, &start_msg(id, rh.clone()), &[]).unwrap_err(),
            ContractError::Unauthorized {
                role: "operator".to_string()
            }
        );
    }
    let op = s.operator.clone();
    s.exec(&op, &start_msg(id, rh), &[]).unwrap();
    assert_eq!(s.state(id), GameState::InProgress);
}

#[test]
fn roster_hash_must_match_the_on_chain_roster() {
    let mut s = Suite::new();
    let id = s.funded(3);
    let op = s.operator.clone();
    let g = s.game(id).game;
    let mut wallets: Vec<String> = g.seats.iter().map(|x| x.wallet.to_string()).collect();
    wallets.swap(1, 2);
    let permuted = HexBinary::from(crypto::roster_hash(&wallets).unwrap().as_slice());
    let partial = HexBinary::from(crypto::roster_hash(&wallets[..2]).unwrap().as_slice());
    for wrong in [permuted, partial, HexBinary::from(vec![0u8; 32])] {
        assert_eq!(
            s.exec(&op, &start_msg(id, wrong), &[]).unwrap_err(),
            ContractError::RosterHashMismatch {}
        );
    }
    assert_eq!(
        s.exec(&op, &start_msg(id, HexBinary::from(vec![0u8; 31])), &[])
            .unwrap_err(),
        ContractError::BadLength {
            field: "roster_hash".to_string(),
            expected: 32,
            got: 31
        }
    );
    assert_eq!(s.state(id), GameState::Funded);
}

#[test]
fn start_is_refused_while_paused_and_before_funded() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    let rh = s.roster_hash(id);
    let op = s.operator.clone();
    assert!(matches!(
        s.exec(&op, &start_msg(id, rh), &[]).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    s.join(id, 2, ANTE);
    s.pause();
    let rh = s.roster_hash(id);
    assert_eq!(
        s.exec(&op, &start_msg(id, rh.clone()), &[]).unwrap_err(),
        ContractError::Paused {}
    );
    s.unpause();
    s.exec(&op, &start_msg(id, rh), &[]).unwrap();
}

#[test]
fn start_freezes_the_domain_bond_and_times() {
    let mut s = Suite::new();
    let id = s.funded(3);
    s.advance(HOUR);
    let t = s.now();
    s.start(id);
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::InProgress);
    assert_eq!(g.started_at, Some(t));
    assert_eq!(g.last_activity, Some(t));
    // bond = max(1 JUNO, 50 % of 1.95 JUNO) = 1 JUNO.
    assert_eq!(g.bond.unwrap().u128(), 1_000_000);
    let wallets: Vec<String> = g.seats.iter().map(|x| x.wallet.to_string()).collect();
    let rh = crypto::roster_hash(&wallets).unwrap();
    assert_eq!(g.roster_hash.unwrap().to_vec(), rh.to_vec());
    let expected = crypto::settlement_domain(&DomainInputs {
        chain_id: MAINNET,
        contract_addr: s.contract.as_str(),
        chain_game_id: id,
        roster_hash: rh,
        rules_engine_version: RULES_ENGINE_VERSION,
        variants_digest: sha256(&[b"18JUNO/TEST/variants"]),
        ante_gross: ANTE,
        mode: 0,
    })
    .unwrap();
    assert_eq!(s.domain(id), expected);
    assert_eq!(s.last_seq(id), 0);
}

#[test]
fn bond_is_max_of_floor_and_half_the_net_ante() {
    let mut s = Suite::new();
    let id = s.started_with(2, Mode::Async, 10_000_000);
    // net 9_750_000 → 50 % = 4_875_000 > floor.
    assert_eq!(s.bond(id), 4_875_000);
}

#[test]
fn second_start_and_pre_start_exits_are_refused_after_start() {
    let mut s = Suite::new();
    let id = s.started(3);
    let op = s.operator.clone();
    let rh = s.roster_hash(id);
    assert!(matches!(
        s.exec(&op, &start_msg(id, rh), &[]).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    s.advance(10 * DAY);
    for seat in 0..3 {
        let who = s.players[seat].clone();
        assert!(matches!(
            s.exec(&who, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
                .unwrap_err(),
            ContractError::WrongState { .. }
        ));
        assert!(matches!(
            s.exec(&who, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
                .unwrap_err(),
            ContractError::WrongState { .. }
        ));
    }
    let who = s.outsider.clone();
    assert!(matches!(
        s.exec(&who, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
            .unwrap_err(),
        ContractError::WrongState { .. }
    ));
    let late = s.players[5].clone();
    assert!(matches!(
        s.exec(&late, &s.join_msg(id, 5), &coins(ANTE, DENOM))
            .unwrap_err(),
        ContractError::WrongState { .. }
    ));
    assert_eq!(s.game(id).game.pool.u128(), 3 * NET);
    s.assert_custody();
}

#[test]
fn start_takes_no_funds() {
    let mut s = Suite::new();
    let id = s.funded(2);
    let rh = s.roster_hash(id);
    let op = s.operator.clone();
    assert_eq!(
        s.exec(&op, &start_msg(id, rh), &coins(1, DENOM))
            .unwrap_err(),
        ContractError::NonPayable {}
    );
}

#[test]
fn a_seven_seat_game_starts() {
    let mut s = Suite::new();
    let id = s.started(7);
    let g = s.game(id).game;
    assert_eq!(g.seats.len(), 7);
    assert_eq!(g.pool.u128(), 7 * NET);
    s.assert_custody();
}
