//! Governance: pause, the signer-key registry, role setters, parameters for
//! future games, instantiate validation and migrate. None of it moves funds or
//! changes an existing game.

mod common;

use common::*;
use cosmwasm_std::testing::{mock_dependencies, mock_env};
use cosmwasm_std::{coins, Addr, HexBinary, Uint128};
use cw_multi_test::Executor;
use eighteen_cosmos_escrow::contract::{migrate, CONTRACT_NAME, CONTRACT_VERSION};
use eighteen_cosmos_escrow::msg::{
    ExecuteMsg, InstantiateMsg, MigrateMsg, QueryMsg, ResolveOutcome, SeatSignature,
    SignerKeyResponse, SignerKeysResponse,
};
use eighteen_cosmos_escrow::state::{Game, GameParams, GameState, Mode};
use eighteen_cosmos_escrow::ContractError;

/// `execute::admin::MAX_DURATION_SECS` (10 years); the module is private.
const MAX_DURATION_SECS: u64 = 10 * 365 * 24 * 60 * 60;

fn admin_exec(
    s: &mut Suite,
    msg: &ExecuteMsg,
) -> Result<cw_multi_test::AppResponse, ContractError> {
    let admin = s.admin.clone();
    s.exec(&admin, msg, &[])
}

fn signer_key(s: &Suite, key_id: u16) -> SignerKeyResponse {
    s.app
        .wrap()
        .query_wasm_smart(s.contract.clone(), &QueryMsg::SignerKey { key_id })
        .unwrap()
}

fn off_curve_key() -> HexBinary {
    // x = 5: 5³ + 7 is not a square mod p, so no point has this x.
    let mut k = vec![0x02u8];
    k.extend_from_slice(&[0u8; 31]);
    k.push(5);
    HexBinary::from(k)
}

fn field_modulus_key() -> HexBinary {
    let p = HexBinary::from_hex("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f")
        .unwrap();
    HexBinary::from([&[0x03u8][..], p.as_slice()].concat())
}

fn all_admin_messages(s: &Suite) -> Vec<ExecuteMsg> {
    vec![
        ExecuteMsg::Pause {},
        ExecuteMsg::Unpause {},
        ExecuteMsg::AddSignerKey {
            pubkey: Key::signer(7).pubkey,
        },
        ExecuteMsg::RetireSignerKey {
            key_id: 1,
            compromised: true,
        },
        ExecuteMsg::SetOperator {
            operator: s.addr("operator-2").to_string(),
        },
        ExecuteMsg::SetResolver {
            resolver: s.addr("resolver-2").to_string(),
        },
        ExecuteMsg::SetTreasury {
            treasury: s.addr("treasury-2").to_string(),
        },
        ExecuteMsg::SetParams {
            params: GameParams {
                subsidy_bps: 9_000,
                ..default_params()
            },
        },
    ]
}

#[test]
fn pause_and_unpause_are_admin_only_and_idempotent() {
    let mut s = Suite::new();
    let id = s.started(2);
    for who in [
        s.operator.clone(),
        s.resolver.clone(),
        s.treasury.clone(),
        s.players[0].clone(),
        s.outsider.clone(),
    ] {
        for msg in [ExecuteMsg::Pause {}, ExecuteMsg::Unpause {}] {
            assert_eq!(
                s.exec(&who, &msg, &[]).unwrap_err(),
                ContractError::Unauthorized {
                    role: "admin".to_string()
                }
            );
        }
    }
    let admin = s.admin.clone();
    assert_eq!(
        s.exec(&admin, &ExecuteMsg::Pause {}, &coins(1, DENOM))
            .unwrap_err(),
        ContractError::NonPayable {}
    );
    for _ in 0..2 {
        admin_exec(&mut s, &ExecuteMsg::Pause {}).unwrap();
        assert!(s.config().config.paused);
        assert!(s.game(id).paused);
    }
    for _ in 0..2 {
        admin_exec(&mut s, &ExecuteMsg::Unpause {}).unwrap();
        assert!(!s.config().config.paused);
        assert!(!s.game(id).paused);
    }
}

#[test]
fn every_admin_message_works_while_paused() {
    let mut s = Suite::new();
    s.pause();
    for msg in all_admin_messages(&s) {
        if matches!(msg, ExecuteMsg::Unpause {}) {
            continue;
        }
        admin_exec(&mut s, &msg).unwrap();
    }
    admin_exec(&mut s, &ExecuteMsg::Unpause {}).unwrap();
}

#[test]
fn set_params_applies_to_games_created_afterwards_only() {
    let mut s = Suite::new();
    let old = s.create(0, 2, Mode::Live, ANTE);
    let new_params = GameParams {
        subsidy_bps: 500,
        min_ante: Uint128::new(5_000_000),
        bond_bps: 10_000,
        bond_floor: Uint128::new(3_000_000),
        challenge_window_live_secs: 2 * DAY,
        challenge_window_async_secs: 3 * DAY,
        funding_period_live_secs: 3 * DAY,
        funding_period_async_secs: 9 * DAY,
        liveness_window_secs: 20 * DAY,
        resolver_timeout_secs: 40 * DAY,
    };
    admin_exec(
        &mut s,
        &ExecuteMsg::SetParams {
            params: new_params.clone(),
        },
    )
    .unwrap();
    assert_eq!(s.config().config.params, new_params);

    // The existing game keeps its terms: 2 JUNO joins, 2.5 % subsidy.
    let treasury = s.treasury.clone();
    let t0 = s.balance(&treasury);
    s.join(old, 1, ANTE);
    assert_eq!(s.balance(&treasury) - t0, SUBSIDY);
    s.start(old);
    let g = s.game(old).game;
    assert_eq!(g.terms.subsidy_bps, 250);
    assert_eq!(g.terms.challenge_window_secs, DAY);
    assert_eq!(g.terms.liveness_window_secs, 14 * DAY);
    assert_eq!(g.terms.resolver_timeout_secs, 30 * DAY);
    assert_eq!(g.bond.unwrap().u128(), 1_000_000);
    assert_eq!(g.pool.u128(), 2 * NET);

    // A new game uses the new parameters.
    let creator = s.players[2].clone();
    assert_eq!(
        s.exec(
            &creator,
            &Suite::create_msg(2, Mode::Live, 2),
            &coins(ANTE, DENOM)
        )
        .unwrap_err(),
        ContractError::BelowMinAnte {
            min: Uint128::new(5_000_000),
            got: Uint128::new(ANTE)
        }
    );
    let new = s.create(2, 2, Mode::Live, 5_000_000);
    let g = s.game(new).game;
    assert_eq!(g.subsidy_per_seat.u128(), 250_000);
    assert_eq!(g.ante_net.u128(), 4_750_000);
    assert_eq!(g.terms.challenge_window_secs, 2 * DAY);
    assert_eq!(g.funding_deadline, s.now().plus_seconds(3 * DAY));
    let bob = s.players[3].clone();
    s.exec(&bob, &Suite::join_msg(new, 3), &coins(5_000_000, DENOM))
        .unwrap();
    s.start(new);
    // max(3 JUNO, 100 % of 4.75 JUNO).
    assert_eq!(s.bond(new), 4_750_000);
    s.assert_custody();
}

#[test]
fn set_params_is_validated() {
    let mut s = Suite::new();
    let base = default_params();
    let mut bad: Vec<GameParams> = vec![
        GameParams {
            subsidy_bps: 10_001,
            ..base.clone()
        },
        GameParams {
            min_ante: Uint128::zero(),
            ..base.clone()
        },
    ];
    for i in 0..6 {
        for value in [0, MAX_DURATION_SECS + 1] {
            let mut p = base.clone();
            match i {
                0 => p.challenge_window_live_secs = value,
                1 => p.challenge_window_async_secs = value,
                2 => p.funding_period_live_secs = value,
                3 => p.funding_period_async_secs = value,
                4 => p.liveness_window_secs = value,
                _ => p.resolver_timeout_secs = value,
            }
            bad.push(p);
        }
    }
    assert_eq!(bad.len(), 14);
    for params in bad {
        assert!(matches!(
            admin_exec(&mut s, &ExecuteMsg::SetParams { params }).unwrap_err(),
            ContractError::InvalidParams { .. }
        ));
    }
    assert_eq!(s.config().config.params, base);
    // Boundaries are accepted.
    let edge = GameParams {
        subsidy_bps: 10_000,
        min_ante: Uint128::new(1),
        bond_bps: 0,
        bond_floor: Uint128::zero(),
        challenge_window_live_secs: 1,
        challenge_window_async_secs: MAX_DURATION_SECS,
        funding_period_live_secs: 1,
        funding_period_async_secs: MAX_DURATION_SECS,
        liveness_window_secs: MAX_DURATION_SECS,
        resolver_timeout_secs: 1,
    };
    admin_exec(
        &mut s,
        &ExecuteMsg::SetParams {
            params: edge.clone(),
        },
    )
    .unwrap();
    assert_eq!(s.config().config.params, edge);
    let outsider = s.outsider.clone();
    assert_eq!(
        s.exec(&outsider, &ExecuteMsg::SetParams { params: base }, &[])
            .unwrap_err(),
        ContractError::Unauthorized {
            role: "admin".to_string()
        }
    );
}

#[test]
fn set_treasury_applies_to_games_created_afterwards_only() {
    let mut s = Suite::new();
    let old_treasury = s.treasury.clone();
    let new_treasury = s.addr("treasury-2");
    let old = s.create(0, 2, Mode::Live, ANTE);
    admin_exec(
        &mut s,
        &ExecuteMsg::SetTreasury {
            treasury: new_treasury.to_string(),
        },
    )
    .unwrap();
    assert_eq!(s.config().config.treasury, new_treasury);
    let t_old = s.balance(&old_treasury);
    s.join(old, 1, ANTE);
    assert_eq!(s.balance(&old_treasury) - t_old, SUBSIDY);
    assert_eq!(s.balance(&new_treasury), 0);
    let new = s.funded(2);
    assert_eq!(s.balance(&new_treasury), 2 * SUBSIDY);
    assert_eq!(s.game(new).game.terms.treasury, new_treasury);
    // Dust of the old game still goes to the old treasury.
    s.start(old);
    let t_old = s.balance(&old_treasury);
    // 3.9 JUNO split 2:5 leaves 1 ujuno of dust.
    s.settle(old, 1, 10, &[2, 5], &[0, 1]);
    assert_eq!(s.balance(&old_treasury) - t_old, 1);
    assert_eq!(s.balance(&new_treasury), 2 * SUBSIDY);
}

#[test]
fn signer_keys_are_added_with_increasing_ids() {
    let mut s = Suite::new();
    assert_eq!(s.config().next_signer_key_id, 2);
    let t = s.now();
    assert_eq!(s.add_key(&Key::signer(2)), 2);
    assert_eq!(s.add_key(&Key::signer(3)), 3);
    let k = signer_key(&s, 2).key;
    assert_eq!(k.key_id, 2);
    assert_eq!(k.pubkey, Key::signer(2).pubkey);
    assert_eq!(k.added_at, t);
    assert!(k.retired_at.is_none() && !k.compromised);
    assert_eq!(s.config().next_signer_key_id, 4);
    for n in 4..=6 {
        s.add_key(&Key::signer(n));
    }
    let page: SignerKeysResponse = s
        .app
        .wrap()
        .query_wasm_smart(
            s.contract.clone(),
            &QueryMsg::SignerKeys {
                start_after: Some(2),
                limit: Some(2),
            },
        )
        .unwrap();
    let ids: Vec<u16> = page.keys.iter().map(|k| k.key_id).collect();
    assert_eq!(ids, vec![3, 4]);
}

#[test]
fn signer_key_registration_is_validated() {
    let mut s = Suite::new();
    let mut prefix04 = Key::signer(2).pubkey.to_vec();
    prefix04[0] = 0x04;
    let cases: Vec<(HexBinary, ContractError)> = vec![
        (
            Key::signer(1).pubkey,
            ContractError::DuplicateSignerKey { key_id: 1 },
        ),
        (
            HexBinary::from(vec![0x02u8; 32]),
            ContractError::BadPubkey {
                field: "pubkey".to_string(),
            },
        ),
        (
            HexBinary::from(prefix04),
            ContractError::BadPubkey {
                field: "pubkey".to_string(),
            },
        ),
        (
            off_curve_key(),
            ContractError::BadPubkey {
                field: "pubkey".to_string(),
            },
        ),
        (
            field_modulus_key(),
            ContractError::BadPubkey {
                field: "pubkey".to_string(),
            },
        ),
    ];
    for (pubkey, expected) in cases {
        assert_eq!(
            admin_exec(&mut s, &ExecuteMsg::AddSignerKey { pubkey }).unwrap_err(),
            expected
        );
    }
    // A retired key can never be registered again, under any id.
    assert_eq!(s.add_key(&Key::signer(2)), 2);
    s.retire_key(2, false);
    assert_eq!(
        admin_exec(
            &mut s,
            &ExecuteMsg::AddSignerKey {
                pubkey: Key::signer(2).pubkey
            }
        )
        .unwrap_err(),
        ContractError::DuplicateSignerKey { key_id: 2 }
    );
    // Only the admin registers keys.
    let outsider = s.outsider.clone();
    assert_eq!(
        s.exec(
            &outsider,
            &ExecuteMsg::AddSignerKey {
                pubkey: Key::signer(9).pubkey
            },
            &[]
        )
        .unwrap_err(),
        ContractError::Unauthorized {
            role: "admin".to_string()
        }
    );
    assert_eq!(s.config().next_signer_key_id, 3);
}

#[test]
fn retirement_escalates_but_never_downgrades() {
    let mut s = Suite::new();
    s.advance(HOUR);
    let t1 = s.now();
    s.retire_key(1, false);
    let k = signer_key(&s, 1).key;
    assert_eq!(k.retired_at, Some(t1));
    assert!(!k.compromised);
    s.advance(HOUR);
    s.retire_key(1, true);
    let k = signer_key(&s, 1).key;
    assert_eq!(k.retired_at, Some(t1), "first retirement time is kept");
    assert!(k.compromised);
    s.retire_key(1, false);
    assert!(signer_key(&s, 1).key.compromised, "never un-compromised");
    assert_eq!(
        admin_exec(
            &mut s,
            &ExecuteMsg::RetireSignerKey {
                key_id: 42,
                compromised: true
            }
        )
        .unwrap_err(),
        ContractError::UnknownSignerKey { key_id: 42 }
    );
    let op = s.operator.clone();
    assert_eq!(
        s.exec(
            &op,
            &ExecuteMsg::RetireSignerKey {
                key_id: 1,
                compromised: false
            },
            &[]
        )
        .unwrap_err(),
        ContractError::Unauthorized {
            role: "admin".to_string()
        }
    );
}

#[test]
fn set_operator_and_set_resolver_move_the_roles() {
    let mut s = Suite::new();
    let id = s.funded(2);
    let op2 = s.addr("operator-2");
    admin_exec(
        &mut s,
        &ExecuteMsg::SetOperator {
            operator: op2.to_string(),
        },
    )
    .unwrap();
    assert_eq!(s.config().config.operator, op2);
    let rh = s.roster_hash(id);
    let old_op = s.operator.clone();
    let start = ExecuteMsg::Start {
        chain_game_id: id,
        roster_hash: rh,
    };
    assert_eq!(
        s.exec(&old_op, &start, &[]).unwrap_err(),
        ContractError::Unauthorized {
            role: "operator".to_string()
        }
    );
    s.exec(&op2, &start, &[]).unwrap();
    assert_eq!(s.state(id), GameState::InProgress);

    let res2 = s.addr("resolver-2");
    admin_exec(
        &mut s,
        &ExecuteMsg::SetResolver {
            resolver: res2.to_string(),
        },
    )
    .unwrap();
    assert_eq!(s.config().config.resolver, res2);
    for bad in [
        "",
        "not-an-address",
        "cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    ] {
        for msg in [
            ExecuteMsg::SetOperator {
                operator: bad.to_string(),
            },
            ExecuteMsg::SetResolver {
                resolver: bad.to_string(),
            },
            ExecuteMsg::SetTreasury {
                treasury: bad.to_string(),
            },
        ] {
            assert!(matches!(
                admin_exec(&mut s, &msg).unwrap_err(),
                ContractError::Std(_)
            ));
        }
    }
    assert_eq!(s.config().config.operator, op2);
}

/// Every game in every non-terminal state, for the "admin cannot touch games" checks.
fn populated(s: &mut Suite) -> Vec<u64> {
    let funding = s.create(0, 3, Mode::Live, ANTE);
    let funded = s.funded(2);
    let in_progress = s.started(3);
    s.post_checkpoint(in_progress, 10, &[1, 2, 3]);
    let (settleable, _) = s.settleable(2);
    let (disputed, _) = s.disputed(3);
    vec![funding, funded, in_progress, settleable, disputed]
}

#[test]
fn no_admin_message_moves_funds_or_changes_a_game() {
    let mut s = Suite::new();
    let ids = populated(&mut s);
    let before: Vec<Game> = ids.iter().map(|id| s.game(*id).game).collect();
    let balance = s.contract_balance();
    for msg in all_admin_messages(&s) {
        let res = admin_exec(&mut s, &msg).unwrap();
        assert!(bank_sends(&res).is_empty(), "{msg:?} moved funds");
        assert_eq!(s.contract_balance(), balance, "{msg:?}");
        let after: Vec<Game> = ids.iter().map(|id| s.game(*id).game).collect();
        assert_eq!(after, before, "{msg:?} changed a game");
    }
    s.assert_custody();
}

#[test]
fn the_admin_has_no_path_to_settle_annul_resolve_withdraw_or_exit() {
    let mut s = Suite::new();
    let ids = populated(&mut s);
    let (funding, funded, in_progress, settleable, disputed) =
        (ids[0], ids[1], ids[2], ids[3], ids[4]);
    let admin = s.admin.clone();
    let admin_key = Key::from_label("18JUNO/TEST/admin-key");
    s.advance(40 * DAY);
    let p = {
        let mut p = s.terminal_payload(in_progress, 1, 50, &[1, 0, 0]);
        p.signer_key_id = 1;
        p
    };
    let refusals: Vec<(ExecuteMsg, ContractError)> = vec![
        (
            ExecuteMsg::Withdraw {
                chain_game_id: funding,
            },
            ContractError::NotSeated {
                chain_game_id: funding,
            },
        ),
        (
            ExecuteMsg::Start {
                chain_game_id: funded,
                roster_hash: s.roster_hash(funded),
            },
            ContractError::Unauthorized {
                role: "operator".to_string(),
            },
        ),
        (
            // A payload signed by a key the admin controls but never registered.
            ExecuteMsg::Settle {
                chain_game_id: in_progress,
                payload: Suite::wire(&p),
                signature: admin_key.sign(&Suite::settle_digest(&p)),
                consents: vec![],
            },
            ContractError::InvalidSignature {},
        ),
        (
            ExecuteMsg::AnnulByConsent {
                chain_game_id: in_progress,
                consents: vec![],
            },
            ContractError::MissingConsent { seat_index: 0 },
        ),
        (
            ExecuteMsg::LivenessSettle {
                chain_game_id: in_progress,
                checkpoint: None,
            },
            ContractError::NotSeated {
                chain_game_id: in_progress,
            },
        ),
        (
            ExecuteMsg::Consent {
                chain_game_id: settleable,
                seat_index: 0,
                signature: admin_key.sign(&[0u8; 32]),
            },
            ContractError::InvalidConsent { seat_index: 0 },
        ),
        (
            ExecuteMsg::Challenge {
                chain_game_id: settleable,
                evidence_hash: HexBinary::from(vec![0u8; 32]),
            },
            ContractError::NotSeated {
                chain_game_id: settleable,
            },
        ),
        (
            ExecuteMsg::Resolve {
                chain_game_id: disputed,
                outcome: ResolveOutcome::Annul {},
            },
            ContractError::Unauthorized {
                role: "resolver".to_string(),
            },
        ),
        (
            ExecuteMsg::LivenessSettle {
                chain_game_id: disputed,
                checkpoint: None,
            },
            ContractError::NotSeated {
                chain_game_id: disputed,
            },
        ),
        (
            ExecuteMsg::SetConsentKey {
                chain_game_id: in_progress,
                new_pubkey: admin_key.pubkey.clone(),
            },
            ContractError::NotSeated {
                chain_game_id: in_progress,
            },
        ),
    ];
    let balance = s.contract_balance();
    for (msg, expected) in refusals {
        assert_eq!(s.exec(&admin, &msg, &[]).unwrap_err(), expected, "{msg:?}");
    }
    assert_eq!(s.contract_balance(), balance);
    // Even registering its own key only allows payloads under that key, which
    // still cannot pay out without every consent or an unchallenged window.
    let key_id = s.add_key(&admin_key);
    let mut q = s.terminal_payload(in_progress, 1, 50, &[1, 0, 0]);
    q.signer_key_id = key_id;
    let (payload, signature) = s.signed_by(&q, &admin_key);
    s.exec(
        &admin,
        &ExecuteMsg::Settle {
            chain_game_id: in_progress,
            payload,
            signature,
            consents: vec![SeatSignature {
                seat_index: 0,
                signature: Key::seat(0).sign(&s.consent_digest(in_progress, &q)),
            }],
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(in_progress), GameState::Settleable);
    assert_eq!(s.contract_balance(), balance);
    s.assert_custody();
}

#[test]
fn instantiate_is_validated() {
    let mut s = Suite::new();
    let admin = s.admin.clone();
    let base = InstantiateMsg {
        admin: s.admin.to_string(),
        operator: s.operator.to_string(),
        resolver: s.resolver.to_string(),
        treasury: s.treasury.to_string(),
        denom: DENOM.to_string(),
        params: default_params(),
        signer_keys: vec![Key::signer(1).pubkey],
    };
    let mut try_init = |msg: &InstantiateMsg, funds: &[cosmwasm_std::Coin]| {
        s.app
            .instantiate_contract(s.code_id, admin.clone(), msg, funds, "escrow", None)
            .map_err(contract_err)
    };
    let invalid = |reason: &str| ContractError::InvalidParams {
        reason: reason.to_string(),
    };
    assert_eq!(
        try_init(&base, &coins(1, DENOM)).unwrap_err(),
        ContractError::NonPayable {}
    );
    let too_long = "u".repeat(129);
    for denom in [
        "",
        "u",
        "uj",
        "1juno",
        "uj uno",
        "ujuno!",
        too_long.as_str(),
    ] {
        let msg = InstantiateMsg {
            denom: denom.to_string(),
            ..base.clone()
        };
        assert_eq!(
            try_init(&msg, &[]).unwrap_err(),
            invalid(&format!("invalid denom {denom:?}"))
        );
    }
    for denom in [
        "ujuno",
        "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2",
        "factory/juno1abc/token",
    ] {
        let msg = InstantiateMsg {
            denom: denom.to_string(),
            ..base.clone()
        };
        try_init(&msg, &[]).unwrap();
    }
    let msg = InstantiateMsg {
        params: GameParams {
            liveness_window_secs: 0,
            ..default_params()
        },
        ..base.clone()
    };
    assert!(matches!(
        try_init(&msg, &[]).unwrap_err(),
        ContractError::InvalidParams { .. }
    ));
    let msg = InstantiateMsg {
        signer_keys: vec![Key::signer(1).pubkey, Key::signer(1).pubkey],
        ..base.clone()
    };
    assert_eq!(
        try_init(&msg, &[]).unwrap_err(),
        ContractError::DuplicateSignerKey { key_id: 1 }
    );
    let msg = InstantiateMsg {
        signer_keys: vec![off_curve_key()],
        ..base.clone()
    };
    assert_eq!(
        try_init(&msg, &[]).unwrap_err(),
        ContractError::BadPubkey {
            field: "pubkey".to_string()
        }
    );
    for role in 0..4 {
        let mut msg = base.clone();
        let bad = "juno1notanaddress".to_string();
        match role {
            0 => msg.admin = bad,
            1 => msg.operator = bad,
            2 => msg.resolver = bad,
            _ => msg.treasury = bad,
        }
        assert!(matches!(
            try_init(&msg, &[]).unwrap_err(),
            ContractError::Std(_)
        ));
    }
    // No signer keys at all is allowed (keys can be added later).
    let msg = InstantiateMsg {
        signer_keys: vec![],
        ..base.clone()
    };
    try_init(&msg, &[]).unwrap();
}

#[test]
fn config_query_reports_the_contract_and_counters() {
    let mut s = Suite::new();
    let c = s.config();
    assert_eq!(c.contract_name, CONTRACT_NAME);
    assert_eq!(c.contract_version, CONTRACT_VERSION);
    assert_eq!(c.contract_version, "1.0.0");
    assert_eq!(c.next_chain_game_id, 1);
    assert_eq!(c.next_signer_key_id, 2);
    assert_eq!(c.config.denom, DENOM);
    assert_eq!(c.config.params, default_params());
    assert!(!c.config.paused);
    s.funded(2);
    assert_eq!(s.config().next_chain_game_id, 2);
}

#[test]
fn migrate_to_the_same_version_is_a_no_op_that_keeps_state() {
    let mut s = Suite::new();
    let id = s.started(2);
    let before = s.game(id).game;
    let admin = s.admin.clone();
    let contract = s.contract.clone();
    let code_id = s.code_id;
    let res = s
        .app
        .migrate_contract(admin, contract.clone(), &MigrateMsg {}, code_id)
        .unwrap();
    assert_eq!(attr(&res, "from_version"), "1.0.0");
    assert_eq!(attr(&res, "to_version"), "1.0.0");
    assert_eq!(s.game(id).game, before);
    let info = cw2::query_contract_info(&s.app.wrap(), contract.to_string()).unwrap();
    assert_eq!(info.contract, CONTRACT_NAME);
    assert_eq!(info.version, "1.0.0");
    // Only the chain-level contract admin may migrate at all.
    let outsider = s.outsider.clone();
    assert!(s
        .app
        .migrate_contract(outsider, contract, &MigrateMsg {}, code_id)
        .is_err());
}

#[test]
fn migrate_refuses_foreign_contracts_downgrades_and_bad_versions() {
    let mut deps = mock_dependencies();
    // No cw2 record at all (the legacy gameplay contract has none).
    assert!(matches!(
        migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err(),
        ContractError::Std(_)
    ));
    cw2::set_contract_version(deps.as_mut().storage, "crates.io:juno-1830", "0.1.0").unwrap();
    assert_eq!(
        migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err(),
        ContractError::MigrateForeignContract {
            contract: "crates.io:juno-1830".to_string()
        }
    );
    cw2::set_contract_version(deps.as_mut().storage, CONTRACT_NAME, "9.0.0").unwrap();
    assert_eq!(
        migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err(),
        ContractError::MigrateDowngrade {
            from: "9.0.0".to_string(),
            to: "1.0.0".to_string()
        }
    );
    cw2::set_contract_version(deps.as_mut().storage, CONTRACT_NAME, "1.0.1").unwrap();
    assert!(matches!(
        migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err(),
        ContractError::MigrateDowngrade { .. }
    ));
    cw2::set_contract_version(deps.as_mut().storage, CONTRACT_NAME, "1.0").unwrap();
    assert_eq!(
        migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err(),
        ContractError::BadContractVersion {
            version: "1.0".to_string()
        }
    );
    // An older escrow version is upgraded and re-stamped.
    cw2::set_contract_version(deps.as_mut().storage, CONTRACT_NAME, "0.9.3").unwrap();
    migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap();
    let v = cw2::get_contract_version(deps.as_ref().storage).unwrap();
    assert_eq!(v.version, "1.0.0");
    assert_eq!(v.contract, CONTRACT_NAME);
}

#[test]
fn admin_role_cannot_be_reassigned_by_anyone() {
    // The frozen design has no UpdateAdmin message; the admin is fixed at
    // instantiation (a multisig is expected there). Nothing in ExecuteMsg names
    // the admin, so this checks the config is untouched by every other message.
    let mut s = Suite::new();
    let admin: Addr = s.config().config.admin;
    for msg in all_admin_messages(&s) {
        admin_exec(&mut s, &msg).unwrap();
    }
    assert_eq!(s.config().config.admin, admin);
}

#[test]
fn the_signer_key_registry_is_bounded() {
    // LivenessSettle scans one stored checkpoint per signer key, so the number
    // of keys ever registered is bounded (retired keys count).
    let mut s = Suite::new();
    for n in 2..=64usize {
        assert_eq!(s.add_key(&Key::signer(n)), n as u16);
    }
    assert_eq!(s.config().next_signer_key_id, 65);
    assert_eq!(
        admin_exec(
            &mut s,
            &ExecuteMsg::AddSignerKey {
                pubkey: Key::signer(65).pubkey
            }
        )
        .unwrap_err(),
        ContractError::KeyIdsExhausted {}
    );
    // Retiring a key does not free a slot.
    s.retire_key(64, false);
    assert_eq!(
        admin_exec(
            &mut s,
            &ExecuteMsg::AddSignerKey {
                pubkey: Key::signer(66).pubkey
            }
        )
        .unwrap_err(),
        ContractError::KeyIdsExhausted {}
    );
    // The bound applies at instantiation too.
    let admin = s.admin.clone();
    let msg = InstantiateMsg {
        admin: s.admin.to_string(),
        operator: s.operator.to_string(),
        resolver: s.resolver.to_string(),
        treasury: s.treasury.to_string(),
        denom: DENOM.to_string(),
        params: default_params(),
        signer_keys: (1..=65).map(|n| Key::signer(n).pubkey).collect(),
    };
    assert_eq!(
        s.app
            .instantiate_contract(s.code_id, admin.clone(), &msg, &[], "escrow", None)
            .map_err(contract_err)
            .unwrap_err(),
        ContractError::KeyIdsExhausted {}
    );
    let msg = InstantiateMsg {
        signer_keys: (1..=64).map(|n| Key::signer(n).pubkey).collect(),
        ..msg
    };
    s.app
        .instantiate_contract(s.code_id, admin, &msg, &[], "escrow", None)
        .unwrap();
}

#[test]
fn the_treasury_cannot_be_the_contract_itself() {
    let mut s = Suite::new();
    let contract = s.contract.to_string();
    assert_eq!(
        admin_exec(&mut s, &ExecuteMsg::SetTreasury { treasury: contract }).unwrap_err(),
        ContractError::InvalidParams {
            reason: "the treasury cannot be this contract".to_string()
        }
    );
    assert_eq!(s.config().config.treasury, s.treasury);
}
