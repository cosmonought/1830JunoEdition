//! AnnulByConsent: every seat signs ANNUL over (domain, last_seq); anyone may
//! submit; IN_PROGRESS or SETTLEABLE; works while paused; net antes refunded.

mod common;

use common::*;
use cosmwasm_std::{coins, HexBinary, Uint128};
use cw_multi_test::AppResponse;
use eighteen_cosmos_escrow::crypto::annul_digest;
use eighteen_cosmos_escrow::msg::{ExecuteMsg, SeatSignature};
use eighteen_cosmos_escrow::state::{GameState, Mode, Route};
use eighteen_cosmos_escrow::ContractError;

fn annul(
    s: &mut Suite,
    id: u64,
    consents: Vec<SeatSignature>,
) -> Result<AppResponse, ContractError> {
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents,
        },
        &[],
    )
}

fn sig_by(s: &Suite, id: u64, seat: u8, key: &Key, last_seq: u64) -> SeatSignature {
    SeatSignature {
        seat_index: seat,
        signature: key.sign(&annul_digest(&s.domain(id), last_seq)),
    }
}

fn assert_open(s: &Suite, id: u64, state: GameState) {
    let g = s.game(id).game;
    assert_eq!(g.state, state);
    assert!(!g.pool.is_zero());
    s.assert_custody();
}

#[test]
fn every_seat_must_sign() {
    let mut s = Suite::new();
    let id = s.started(3);
    for (seats, missing) in [
        (vec![0usize, 1], 2u8),
        (vec![1, 2], 0),
        (vec![0, 2], 1),
        (vec![], 0),
    ] {
        let sigs = s.annul_sigs(id, &seats, 0);
        assert_eq!(
            annul(&mut s, id, sigs).unwrap_err(),
            ContractError::MissingConsent {
                seat_index: missing
            }
        );
    }
    assert_open(&s, id, GameState::InProgress);
}

#[test]
fn success_from_in_progress_refunds_net_antes_only() {
    let mut s = Suite::new();
    let id = s.started(3);
    let treasury = s.treasury.clone();
    let t0 = s.balance(&treasury);
    let before: Vec<u128> = (0..3).map(|i| s.balance(&s.players[i])).collect();
    let sigs = s.annul_sigs(id, &[2, 0, 1], 0);
    let res = annul(&mut s, id, sigs).unwrap();
    assert_eq!(attr(&res, "state"), "annulled");
    for (i, b) in before.iter().enumerate() {
        assert_eq!(s.balance(&s.players[i]), b + NET);
    }
    // The subsidy is not clawed back from the treasury.
    assert_eq!(s.balance(&treasury), t0);
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Annulled);
    assert_eq!(g.pool, Uint128::zero());
    let o = g.outcome.unwrap();
    assert_eq!(o.route, Route::AnnulByConsent);
    assert_eq!(o.amounts, vec![Uint128::new(NET); 3]);
    assert_eq!(o.bond_returned, Uint128::zero());
    assert_eq!(s.contract_balance(), 0);
    s.assert_custody();
}

#[test]
fn success_from_settleable_at_the_settlements_seq() {
    let mut s = Suite::new();
    let (id, p) = s.settleable(3);
    assert_eq!(s.last_seq(id), p.seq);
    let stale = s.annul_sigs(id, &[0, 1, 2], 0);
    assert_eq!(
        annul(&mut s, id, stale).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    let sigs = s.annul_sigs(id, &[0, 1, 2], p.seq);
    annul(&mut s, id, sigs).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
    s.assert_custody();
}

#[test]
fn a_newer_checkpoint_voids_older_annul_signatures() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.post_checkpoint(id, 100, &[1, 1]);
    let collected = s.annul_sigs(id, &[0, 1], 200);
    s.post_checkpoint(id, 150, &[1, 1]);
    assert_eq!(
        annul(&mut s, id, collected).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    let fresh = s.annul_sigs(id, &[0, 1], 300);
    annul(&mut s, id, fresh).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
}

#[test]
fn bad_signatures_are_refused() {
    let mut s = Suite::new();
    let id = s.started(3);
    let digest = annul_digest(&s.domain(id), 0);
    let good0 = Key::seat(0).sign_bytes(&digest);
    let cases: Vec<(SeatSignature, u8)> = vec![
        (sig_by(&s, id, 1, &Key::seat(2), 0), 1),
        (
            SeatSignature {
                seat_index: 1,
                signature: Key::seat(1).sign_high_s(&digest),
            },
            1,
        ),
        (
            SeatSignature {
                seat_index: 1,
                signature: HexBinary::from(&good0[..63]),
            },
            1,
        ),
        (
            SeatSignature {
                seat_index: 1,
                signature: HexBinary::from(vec![0u8; 64]),
            },
            1,
        ),
    ];
    for (bad, seat) in cases {
        let mut sigs = s.annul_sigs(id, &[0, 2], 0);
        sigs.push(bad);
        assert_eq!(
            annul(&mut s, id, sigs).unwrap_err(),
            ContractError::InvalidConsent { seat_index: seat }
        );
    }
    assert_open(&s, id, GameState::InProgress);
}

#[test]
fn another_domain_or_digest_kind_is_refused() {
    let mut s = Suite::new();
    let a = s.started(2);
    let b = s.started(2);
    let from_b = s.annul_sigs(b, &[0, 1], 0);
    assert_eq!(
        annul(&mut s, a, from_b).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    // A CONSENT signature over a settlement is not an ANNUL signature.
    let p = s.terminal_payload(a, 1, 10, &[1, 1]);
    let consents = s.consents(a, &p, &[0, 1]);
    assert_eq!(
        annul(&mut s, a, consents).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    assert_open(&s, a, GameState::InProgress);
    assert_open(&s, b, GameState::InProgress);
}

#[test]
fn duplicate_and_out_of_range_seats_are_refused() {
    let mut s = Suite::new();
    let id = s.started(3);
    let mut dup = s.annul_sigs(id, &[0, 1, 2], 0);
    dup.insert(1, dup[0].clone());
    assert_eq!(
        annul(&mut s, id, dup).unwrap_err(),
        ContractError::DuplicateConsent { seat_index: 0 }
    );
    let mut extra = s.annul_sigs(id, &[0, 1, 2], 0);
    extra.push(sig_by(&s, id, 3, &Key::seat(3), 0));
    assert_eq!(
        annul(&mut s, id, extra).unwrap_err(),
        ContractError::SeatIndexOutOfRange { seat_index: 3 }
    );
    assert_open(&s, id, GameState::InProgress);
}

#[test]
fn a_repeat_is_refused() {
    for (legacy, expected) in [
        (true, "in_progress or settleable"),
        (false, "in_progress or settleable or disputed"),
    ] {
        let mut s = Suite::new();
        s.legacy = legacy;
        let id = s.started(2);
        let sigs = s.annul_sigs(id, &[0, 1], 0);
        annul(&mut s, id, sigs.clone()).unwrap();
        assert_eq!(
            annul(&mut s, id, sigs).unwrap_err(),
            ContractError::WrongState {
                expected: expected.to_string(),
                actual: "annulled".to_string()
            }
        );
        s.assert_custody();
    }
}

#[test]
fn neither_the_admin_nor_the_creator_can_annul_alone() {
    let mut s = Suite::new();
    let id = s.started(3);
    let admin_key = Key::from_label("18JUNO/TEST/admin-key");
    // The admin signs for every seat with its own key.
    let forged: Vec<SeatSignature> = (0..3u8).map(|i| sig_by(&s, id, i, &admin_key, 0)).collect();
    let admin = s.admin.clone();
    assert_eq!(
        s.exec(
            &admin,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents: forged,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    assert_eq!(
        s.exec(
            &admin,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents: vec![],
            },
            &[],
        )
        .unwrap_err(),
        ContractError::MissingConsent { seat_index: 0 }
    );
    // The creator signs for everyone with the creator's key.
    let creator_all: Vec<SeatSignature> = (0..3u8)
        .map(|i| sig_by(&s, id, i, &Key::seat(0), 0))
        .collect();
    let creator = s.players[0].clone();
    assert_eq!(
        s.exec(
            &creator,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents: creator_all,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 1 }
    );
    let only_creator = s.annul_sigs(id, &[0], 0);
    assert_eq!(
        s.exec(
            &creator,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents: only_creator,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::MissingConsent { seat_index: 1 }
    );
    // With every real signature, the admin (or anyone) may relay it.
    let all = s.annul_sigs(id, &[0, 1, 2], 0);
    s.exec(
        &admin,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents: all,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
}

#[test]
fn works_while_paused() {
    let mut s = Suite::new();
    let a = s.started(2);
    let (b, p) = s.settleable(2);
    s.pause();
    let sigs = s.annul_sigs(a, &[0, 1], 0);
    annul(&mut s, a, sigs).unwrap();
    let sigs = s.annul_sigs(b, &[0, 1], p.seq);
    annul(&mut s, b, sigs).unwrap();
    assert_eq!(s.state(a), GameState::Annulled);
    assert_eq!(s.state(b), GameState::Annulled);
    s.assert_custody();
}

/// Escrow 2.0.0 games: IN_PROGRESS or SETTLEABLE only. Escrow 2.1.0 games
/// also accept DISPUTED (the universal unanimous annulment, `tests/remedy.rs`);
/// FUNDING, FUNDED and every terminal state refuse both.
#[test]
fn only_in_progress_or_settleable() {
    let mut s = Suite::new_legacy();
    let funding = s.create(0, 3, Mode::Live, ANTE);
    let funded = s.funded(2);
    let (disputed, _) = s.disputed(2);
    let settled = s.settled(2);
    let cancelled = s.cancelled(2);
    for (id, actual) in [
        (funding, "funding"),
        (funded, "funded"),
        (disputed, "disputed"),
        (settled, "settled"),
        (cancelled, "cancelled"),
    ] {
        assert_eq!(
            annul(&mut s, id, vec![]).unwrap_err(),
            ContractError::WrongState {
                expected: "in_progress or settleable".to_string(),
                actual: actual.to_string()
            }
        );
    }
    s.legacy = false;
    let funding = s.create(0, 3, Mode::Live, ANTE);
    let funded = s.funded(2);
    let (disputed, _) = s.disputed(2);
    let settled = s.settled(2);
    let cancelled = s.cancelled(2);
    for (id, actual) in [
        (funding, "funding"),
        (funded, "funded"),
        (settled, "settled"),
        (cancelled, "cancelled"),
    ] {
        assert_eq!(
            annul(&mut s, id, vec![]).unwrap_err(),
            ContractError::WrongState {
                expected: "in_progress or settleable or disputed".to_string(),
                actual: actual.to_string()
            }
        );
    }
    // A 2.1.0 DISPUTED game passes the state gate (and then needs every seat).
    assert_eq!(
        annul(&mut s, disputed, vec![]).unwrap_err(),
        ContractError::MissingConsent { seat_index: 0 }
    );
    let who = s.outsider.clone();
    let id = s.started(2);
    let sigs = s.annul_sigs(id, &[0, 1], 0);
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents: sigs,
            },
            &coins(1, DENOM),
        )
        .unwrap_err(),
        ContractError::NonPayable {}
    );
    s.assert_custody();
}

#[test]
fn a_rotated_seat_must_sign_with_its_new_key() {
    let mut s = Suite::new();
    let id = s.started(2);
    let new_key = Key::from_label("18JUNO/TEST/seat/0/rotated-for-annul");
    let creator = s.players[0].clone();
    s.exec(
        &creator,
        &ExecuteMsg::SetConsentKey {
            chain_game_id: id,
            new_pubkey: new_key.pubkey.clone(),
        },
        &[],
    )
    .unwrap();
    let old = s.annul_sigs(id, &[0, 1], 0);
    assert_eq!(
        annul(&mut s, id, old).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    let sigs = vec![
        sig_by(&s, id, 0, &new_key, 0),
        sig_by(&s, id, 1, &Key::seat(1), 0),
    ];
    annul(&mut s, id, sigs).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
}
