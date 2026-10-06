//! FUNDING: deposits, subsidy, joins, withdrawals and cancellation.

mod common;

use common::*;
use cosmwasm_std::{coin, coins, HexBinary, Uint128};
use eighteen_cosmos_escrow::msg::ExecuteMsg;
use eighteen_cosmos_escrow::state::{GameState, Mode, Route};
use eighteen_cosmos_escrow::ContractError;

#[test]
fn create_with_two_and_seven_seats() {
    for n in [2u8, 7] {
        let mut s = Suite::new();
        let treasury0 = s.balance(&s.treasury.clone());
        let id = s.create(0, n, Mode::Live, ANTE);
        let g = s.game(id).game;
        assert_eq!(g.state, GameState::Funding);
        assert_eq!(g.max_players, n);
        assert_eq!(g.seats.len(), 1);
        assert_eq!(g.seats[0].wallet, s.players[0]);
        assert_eq!(g.creator, s.players[0]);
        assert_eq!(g.pool.u128(), NET);
        assert_eq!(g.seats[0].net_deposit.u128(), NET);
        assert_eq!(g.seats[0].subsidy_paid.u128(), SUBSIDY);
        assert_eq!(s.balance(&s.treasury.clone()) - treasury0, SUBSIDY);
        assert_eq!(s.contract_balance(), NET);
        assert_eq!(
            g.funding_deadline,
            s.now().plus_seconds(DAY),
            "live funding deadline is 24 h"
        );
    }
}

#[test]
fn player_count_bounds_are_two_to_seven() {
    let mut s = Suite::new();
    let who = s.players[0].clone();
    for n in [0u8, 1, 8, 9, 255] {
        assert_eq!(
            s.exec(
                &who,
                &Suite::create_msg(n, Mode::Live, 0),
                &coins(ANTE, DENOM)
            )
            .unwrap_err(),
            ContractError::BadMaxPlayers { got: n }
        );
    }
    for n in 2u8..=7 {
        s.exec(
            &who,
            &Suite::create_msg(n, Mode::Live, 0),
            &coins(ANTE, DENOM),
        )
        .unwrap();
    }
    s.assert_custody();
}

#[test]
fn deposit_must_be_exactly_one_coin_of_the_denom() {
    let mut s = Suite::new();
    let who = s.players[0].clone();
    let msg = Suite::create_msg(3, Mode::Live, 0);
    let invalid = ContractError::InvalidFunds {
        denom: DENOM.to_string(),
    };
    assert_eq!(
        s.exec(&who, &msg, &coins(ANTE, "uatom")).unwrap_err(),
        invalid
    );
    assert_eq!(s.exec(&who, &msg, &[]).unwrap_err(), invalid);
    assert_eq!(
        s.exec(&who, &msg, &[coin(ANTE, "uatom"), coin(ANTE, DENOM)])
            .unwrap_err(),
        invalid
    );
    assert_eq!(s.contract_balance(), 0);
}

#[test]
fn below_min_ante_is_refused_and_min_is_accepted() {
    let mut s = Suite::new();
    let who = s.players[0].clone();
    let msg = Suite::create_msg(3, Mode::Live, 0);
    assert_eq!(
        s.exec(&who, &msg, &coins(ANTE - 1, DENOM)).unwrap_err(),
        ContractError::BelowMinAnte {
            min: Uint128::new(ANTE),
            got: Uint128::new(ANTE - 1)
        }
    );
    s.exec(&who, &msg, &coins(ANTE, DENOM)).unwrap();
    // A larger ante is fine and every joiner must match it exactly.
    s.exec(&who, &msg, &coins(ANTE + 7, DENOM)).unwrap();
}

#[test]
fn subsidy_is_taken_from_every_deposit_exactly_once() {
    let mut s = Suite::new();
    let treasury0 = s.balance(&s.treasury.clone());
    let id = s.funded(4);
    assert_eq!(s.balance(&s.treasury.clone()) - treasury0, 4 * SUBSIDY);
    let g = s.game(id).game;
    assert_eq!(g.pool.u128(), 4 * NET);
    for seat in &g.seats {
        assert_eq!(seat.gross_deposit.u128(), ANTE);
        assert_eq!(seat.subsidy_paid.u128(), SUBSIDY);
        assert_eq!(seat.net_deposit.u128(), NET);
    }
    assert_eq!(s.contract_balance(), 4 * NET);
    s.assert_custody();
}

#[test]
fn join_must_match_the_creators_gross_ante() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    let who = s.players[1].clone();
    let msg = s.join_msg(id, 1);
    for wrong in [ANTE - 1, ANTE + 1, 2 * ANTE] {
        assert_eq!(
            s.exec(&who, &msg, &coins(wrong, DENOM)).unwrap_err(),
            ContractError::WrongAnte {
                expected: Uint128::new(ANTE),
                got: Uint128::new(wrong)
            }
        );
    }
    assert_eq!(
        s.exec(&who, &msg, &coins(ANTE, "uatom")).unwrap_err(),
        ContractError::InvalidFunds {
            denom: DENOM.to_string()
        }
    );
    // Exactly one coin: none at all, or the right ante beside a second denom,
    // is refused and seats nobody.
    let invalid = ContractError::InvalidFunds {
        denom: DENOM.to_string(),
    };
    assert_eq!(s.exec(&who, &msg, &[]).unwrap_err(), invalid);
    assert_eq!(
        s.exec(&who, &msg, &[coin(ANTE, DENOM), coin(ANTE, "uatom")])
            .unwrap_err(),
        invalid
    );
    assert_eq!(s.game(id).game.seats.len(), 1);
    assert_eq!(s.contract_balance(), NET);
    s.exec(&who, &msg, &coins(ANTE, DENOM)).unwrap();
}

#[test]
fn a_wallet_can_hold_only_one_seat() {
    let mut s = Suite::new();
    let id = s.create(0, 4, Mode::Live, ANTE);
    let creator = s.players[0].clone();
    assert_eq!(
        s.exec(&creator, &s.join_msg(id, 0), &coins(ANTE, DENOM))
            .unwrap_err(),
        ContractError::AlreadyJoined { chain_game_id: id }
    );
    s.join(id, 1, ANTE);
    let alice = s.players[1].clone();
    assert_eq!(
        s.exec(&alice, &s.join_msg(id, 1), &coins(ANTE, DENOM))
            .unwrap_err(),
        ContractError::AlreadyJoined { chain_game_id: id }
    );
}

#[test]
fn last_seat_funds_the_game_and_no_seat_is_left() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    assert_eq!(s.state(id), GameState::Funding);
    s.join(id, 2, ANTE);
    assert_eq!(s.state(id), GameState::Funded);
    let who = s.players[3].clone();
    let err = s
        .exec(&who, &s.join_msg(id, 3), &coins(ANTE, DENOM))
        .unwrap_err();
    assert!(matches!(err, ContractError::WrongState { .. }), "{err:?}");
}

#[test]
fn joins_close_at_the_funding_deadline() {
    for (mode, period) in [(Mode::Live, DAY), (Mode::Async, 7 * DAY)] {
        let mut s = Suite::new();
        let id = s.create(0, 4, mode, ANTE);
        s.advance(period - 1);
        s.join(id, 1, ANTE);
        s.advance(1);
        let who = s.players[2].clone();
        assert_eq!(
            s.exec(&who, &s.join_msg(id, 2), &coins(ANTE, DENOM))
                .unwrap_err(),
            ContractError::FundingClosed {}
        );
    }
}

#[test]
fn withdraw_refunds_exactly_the_net_ante_and_keeps_deposit_order() {
    let mut s = Suite::new();
    let id = s.create(0, 4, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    s.join(id, 2, ANTE);
    let alice = s.players[1].clone();
    let treasury0 = s.balance(&s.treasury.clone());
    let before = s.balance(&alice);
    s.exec(&alice, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
        .unwrap();
    assert_eq!(s.balance(&alice) - before, NET, "net ante back");
    assert_eq!(
        s.balance(&s.treasury.clone()),
        treasury0,
        "subsidy not clawed back"
    );
    let g = s.game(id).game;
    assert_eq!(g.seats.len(), 2);
    assert_eq!(g.seats[0].wallet, s.players[0]);
    assert_eq!(
        g.seats[1].wallet, s.players[2],
        "later seats move up before START"
    );
    assert_eq!(g.pool.u128(), 2 * NET);
    // No double refund.
    assert_eq!(
        s.exec(&alice, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
            .unwrap_err(),
        ContractError::NotSeated { chain_game_id: id }
    );
    s.assert_custody();
}

#[test]
fn withdraw_from_funded_reopens_funding() {
    let mut s = Suite::new();
    let id = s.funded(3);
    let bob = s.players[2].clone();
    s.exec(&bob, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
        .unwrap();
    assert_eq!(s.state(id), GameState::Funding);
    // The seat can be taken again.
    s.join(id, 3, ANTE);
    assert_eq!(s.state(id), GameState::Funded);
    s.assert_custody();
}

#[test]
fn outsiders_cannot_withdraw_and_withdraw_takes_no_funds() {
    let mut s = Suite::new();
    let id = s.funded(2);
    let mallory = s.outsider.clone();
    assert_eq!(
        s.exec(&mallory, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
            .unwrap_err(),
        ContractError::NotSeated { chain_game_id: id }
    );
    let alice = s.players[1].clone();
    assert_eq!(
        s.exec(
            &alice,
            &ExecuteMsg::Withdraw { chain_game_id: id },
            &coins(1, DENOM)
        )
        .unwrap_err(),
        ContractError::NonPayable {}
    );
}

#[test]
fn creator_can_cancel_funding_and_funded_games() {
    for n_join in [1usize, 2] {
        let mut s = Suite::new();
        let id = s.create(0, 3, Mode::Live, ANTE);
        for seat in 1..=n_join {
            s.join(id, seat, ANTE);
        }
        let balances: Vec<u128> = (0..=n_join)
            .map(|i| s.balance(&s.players[i].clone()))
            .collect();
        let creator = s.players[0].clone();
        s.exec(&creator, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
            .unwrap();
        let g = s.game(id).game;
        assert_eq!(g.state, GameState::Cancelled);
        assert_eq!(g.pool.u128(), 0);
        assert_eq!(g.outcome.unwrap().route, Route::CreatorCancel);
        for (i, before) in balances.iter().enumerate() {
            assert_eq!(s.balance(&s.players[i].clone()) - before, NET);
        }
        // No double refund.
        assert!(matches!(
            s.exec(&creator, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
                .unwrap_err(),
            ContractError::WrongState { .. }
        ));
        s.assert_custody();
    }
}

#[test]
fn anyone_may_cancel_from_the_funding_deadline() {
    let mut s = Suite::new();
    let id = s.funded(3);
    let alice = s.players[1].clone();
    let mallory = s.outsider.clone();
    for who in [&alice, &mallory] {
        assert_eq!(
            s.exec(who, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
                .unwrap_err(),
            ContractError::Unauthorized {
                role: "creator (or anyone after the funding deadline)".to_string()
            }
        );
    }
    s.advance(DAY);
    s.exec(&mallory, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
        .unwrap();
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Cancelled);
    assert_eq!(g.outcome.unwrap().route, Route::DeadlineCancel);
    s.assert_custody();
}

#[test]
fn creator_keeps_cancel_after_withdrawing_their_own_seat() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    let creator = s.players[0].clone();
    s.exec(&creator, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
        .unwrap();
    assert_eq!(s.game(id).game.seats[0].wallet, s.players[1]);
    s.exec(&creator, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
        .unwrap();
    assert_eq!(s.state(id), GameState::Cancelled);
    s.assert_custody();
}

#[test]
fn pause_blocks_deposits_but_never_the_pre_start_exits() {
    let mut s = Suite::new();
    let id = s.create(0, 4, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    s.join(id, 2, ANTE);
    s.pause();
    let who = s.players[5].clone();
    assert_eq!(
        s.exec(
            &who,
            &Suite::create_msg(2, Mode::Live, 5),
            &coins(ANTE, DENOM)
        )
        .unwrap_err(),
        ContractError::Paused {}
    );
    let dave = s.players[3].clone();
    assert_eq!(
        s.exec(&dave, &s.join_msg(id, 3), &coins(ANTE, DENOM))
            .unwrap_err(),
        ContractError::Paused {}
    );
    let alice = s.players[1].clone();
    s.exec(&alice, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
        .unwrap();
    let creator = s.players[0].clone();
    s.exec(&creator, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
        .unwrap();
    assert_eq!(s.state(id), GameState::Cancelled);
    s.assert_custody();
}

#[test]
fn key_ticket_and_digest_lengths_are_enforced() {
    let mut s = Suite::new();
    let who = s.players[0].clone();
    let bad_key = |bytes: Vec<u8>| ExecuteMsg::CreateGame {
        max_players: 2,
        mode: Mode::Live,
        rules_engine_version: 10,
        variants_digest: variants_digest(),
        consent_pubkey: HexBinary::from(bytes),
        join_ticket: ticket("x"),
        no_deadline: false,
    };
    let uncompressed = {
        let k = Key::seat(0);
        k.sk.verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec()
    };
    for key in [
        uncompressed,
        vec![0x04; 33],
        vec![0x02; 32],
        vec![0x02; 34],
        vec![],
    ] {
        assert_eq!(
            s.exec(&who, &bad_key(key), &coins(ANTE, DENOM))
                .unwrap_err(),
            ContractError::BadPubkey {
                field: "consent_pubkey".to_string()
            }
        );
    }
    let bad_ticket = ExecuteMsg::CreateGame {
        max_players: 2,
        mode: Mode::Live,
        rules_engine_version: 10,
        variants_digest: variants_digest(),
        consent_pubkey: Key::seat(0).pubkey,
        join_ticket: HexBinary::from(vec![7u8; 31]),
        no_deadline: false,
    };
    assert_eq!(
        s.exec(&who, &bad_ticket, &coins(ANTE, DENOM)).unwrap_err(),
        ContractError::BadLength {
            field: "join_ticket".to_string(),
            expected: 32,
            got: 31
        }
    );
    let bad_variants = ExecuteMsg::CreateGame {
        max_players: 2,
        mode: Mode::Live,
        rules_engine_version: 10,
        variants_digest: HexBinary::from(vec![7u8; 33]),
        consent_pubkey: Key::seat(0).pubkey,
        join_ticket: ticket("x"),
        no_deadline: false,
    };
    assert_eq!(
        s.exec(&who, &bad_variants, &coins(ANTE, DENOM))
            .unwrap_err(),
        ContractError::BadLength {
            field: "variants_digest".to_string(),
            expected: 32,
            got: 33
        }
    );
}

#[test]
fn join_ticket_and_consent_key_are_stored_verbatim() {
    let mut s = Suite::new();
    let id = s.funded(2);
    let g = s.game(id).game;
    assert_eq!(g.seats[0].join_ticket, ticket("creator"));
    assert_eq!(g.seats[1].join_ticket, ticket("alice"));
    assert_eq!(g.seats[1].consent_pubkey, Key::seat(1).pubkey);
    assert_eq!(g.variants_digest, variants_digest());
    assert_eq!(g.rules_engine_version, RULES_ENGINE_VERSION);
}

#[test]
fn unknown_games_are_not_found() {
    let mut s = Suite::new();
    let who = s.players[1].clone();
    assert_eq!(
        s.exec(&who, &s.join_msg(99, 1), &coins(ANTE, DENOM))
            .unwrap_err(),
        ContractError::GameNotFound { chain_game_id: 99 }
    );
    assert_eq!(
        s.exec(&who, &ExecuteMsg::Cancel { chain_game_id: 99 }, &[])
            .unwrap_err(),
        ContractError::GameNotFound { chain_game_id: 99 }
    );
}

#[test]
fn game_ids_count_up_from_one() {
    let mut s = Suite::new();
    assert_eq!(s.create(0, 2, Mode::Live, ANTE), 1);
    assert_eq!(s.create(1, 2, Mode::Async, ANTE), 2);
    assert_eq!(s.config().next_chain_game_id, 3);
}
