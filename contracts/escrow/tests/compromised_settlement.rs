//! ESCROW-2.2: once the signer key of a stored settlement is marked
//! compromised, no ordinary payout path distributes that settlement. It stays
//! on record as evidence; the SETTLEABLE `LivenessSettle` exit is the recovery
//! route, so nothing is trapped.
//!
//! Paths that can pay a stored settlement after its Settle transaction:
//! `Finalize` and the completing `Consent` (both now refuse a compromised
//! settlement), the SETTLEABLE and DISPUTED liveness timeouts (which already
//! paid only a trusted settlement), and a resolver `Uphold` (an adjudicated
//! payout; unchanged, pinned below).
//!
//! Escrow 2.1.0: a game created by 2.1.0 code never falls back to a checkpoint
//! (it refunds instead), and has no IN_PROGRESS liveness promotion. The two
//! tests that rely on either run on games stored by 2.0.0 code
//! (`Suite::new_legacy`); `tests/escrow21.rs` runs the same emergency rotation
//! on 2.1.0 games.

mod common;

use common::*;
use cw_multi_test::AppResponse;
use eighteen_cosmos_escrow::msg::{
    ExecuteMsg, QueryMsg, ResolveOutcome, SeatSignature, SeatsResponse,
};
use eighteen_cosmos_escrow::payload::Payload;
use eighteen_cosmos_escrow::state::{GameState, Route, SettlementSource};
use eighteen_cosmos_escrow::ContractError;

const LIVENESS: u64 = 14 * DAY;

fn compromised(key_id: u16) -> ContractError {
    ContractError::CompromisedSettlement { key_id }
}

fn finalize(s: &mut Suite, id: u64) -> Result<AppResponse, ContractError> {
    let who = s.outsider.clone();
    s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
}

fn consent_msg(s: &Suite, id: u64, p: &Payload, seat: u8, key: &Key) -> ExecuteMsg {
    ExecuteMsg::Consent {
        chain_game_id: id,
        seat_index: seat,
        signature: key.sign(&s.consent_digest(id, p)),
    }
}

fn consent(
    s: &mut Suite,
    id: u64,
    p: &Payload,
    seat: u8,
    key: &Key,
) -> Result<AppResponse, ContractError> {
    let msg = consent_msg(s, id, p, seat, key);
    let who = s.outsider.clone();
    s.exec(&who, &msg, &[])
}

fn checkpoint_by(s: &mut Suite, id: u64, key_id: u16, key: &Key, log_len: u64, w: &[u128]) {
    let (_, signed) = s.signed_checkpoint(id, key_id, key, log_len, w);
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::Checkpoint {
            chain_game_id: id,
            payload: signed.payload,
            signature: signed.signature,
        },
        &[],
    )
    .unwrap();
}

/// Every balance a payout could touch.
fn balances(s: &Suite) -> Vec<u128> {
    let mut v: Vec<u128> = s.players.iter().map(|p| s.balance(p)).collect();
    v.push(s.balance(&s.treasury));
    v.push(s.contract_balance());
    v
}

fn consented(s: &Suite, id: u64) -> Vec<bool> {
    let seats: SeatsResponse = s
        .app
        .wrap()
        .query_wasm_smart(s.contract.clone(), &QueryMsg::Seats { chain_game_id: id })
        .unwrap();
    seats.seats.iter().map(|x| x.consented).collect()
}

fn route(s: &Suite, id: u64) -> Option<Route> {
    s.game(id).game.outcome.map(|o| o.route)
}

fn amounts(s: &Suite, id: u64) -> Vec<u128> {
    s.game(id)
        .game
        .outcome
        .unwrap()
        .amounts
        .iter()
        .map(|a| a.u128())
        .collect()
}

/// The end-to-end emergency rotation. Two SETTLEABLE games carry a terminal
/// signed by key 1 with seats 0 and 1 of 3 already consented and a vector that
/// would hand seat 0 the whole pool; `fallback` also holds a key-2 checkpoint
/// posted before its Settle, `orphan` holds none.
#[test]
fn emergency_rotation_end_to_end() {
    let mut s = Suite::new_legacy();
    let key2 = Key::signer(2);
    s.add_key(&key2);
    let fallback = s.started(3);
    checkpoint_by(&mut s, fallback, 2, &key2, 40, &[1, 1, 2]);
    let orphan = s.started(3);
    let in_play = s.started(3);

    // 1–2. Accepted terminal settlements; some but not all seats consented.
    let p_fallback = s.settle(fallback, 1, 100, &[5, 0, 0], &[0, 1]);
    let p_orphan = s.settle(orphan, 1, 100, &[5, 0, 0], &[0, 1]);
    for id in [fallback, orphan] {
        let g = s.game(id).game;
        assert_eq!(g.state, GameState::Settleable);
        assert_eq!(g.consent_bitmap, 0b011);
    }

    // 3–5. Pause, mark key 1 compromised, register the replacement signer and
    // re-post a fresh checkpoint for the game still in play.
    s.pause();
    s.retire_key(1, true);
    let key3 = Key::signer(3);
    assert_eq!(s.add_key(&key3), 3);
    checkpoint_by(&mut s, in_play, 3, &key3, 10, &[1, 1, 1]);
    assert_eq!(s.trusted_seq(in_play), 20);

    // 6. While paused the ordinary payout paths stay blocked, as before.
    s.advance(DAY);
    for (id, p) in [(fallback, &p_fallback), (orphan, &p_orphan)] {
        assert_eq!(finalize(&mut s, id).unwrap_err(), ContractError::Paused {});
        assert_eq!(
            consent(&mut s, id, p, 2, &Key::seat(2)).unwrap_err(),
            ContractError::Paused {}
        );
    }

    // 7. Unpause deliberately.
    s.unpause();

    // 8. Neither Finalize nor the last missing consent can pay it, and a
    // refusal changes nothing.
    for (id, p) in [(fallback, &p_fallback), (orphan, &p_orphan)] {
        let game = s.game(id).game;
        let before = balances(&s);
        assert_eq!(finalize(&mut s, id).unwrap_err(), compromised(1));
        assert_eq!(
            consent(&mut s, id, p, 2, &Key::seat(2)).unwrap_err(),
            compromised(1)
        );
        assert_eq!(s.game(id).game, game, "no state or bitmap change");
        assert_eq!(balances(&s), before, "no funds moved");
        assert_eq!(consented(&s, id), vec![true, true, false]);
    }

    // 9. The SETTLEABLE liveness deadline.
    let at = s
        .game(fallback)
        .game
        .settlement
        .unwrap()
        .window_end
        .plus_seconds(LIVENESS);
    assert_eq!(s.game(fallback).deadlines.liveness_available_at, Some(at));
    let now = s.now();
    s.advance(at.seconds() - now.seconds() - 1);
    assert_eq!(
        s.liveness(fallback, 0, None).unwrap_err(),
        ContractError::LivenessNotReached { at }
    );
    s.advance(1);

    // 10. The trusted checkpoint takes over in a fresh window ...
    let res = s.liveness(fallback, 0, None).unwrap();
    assert_eq!(attr(&res, "path"), "settleable_timeout_checkpoint");
    assert!(bank_sends(&res).is_empty());
    let g = s.game(fallback).game;
    assert_eq!(g.state, GameState::Settleable);
    assert_eq!(g.consent_bitmap, 0, "consents reset");
    let st = g.settlement.unwrap();
    assert_eq!(st.source, SettlementSource::LivenessCheckpoint);
    assert_eq!(st.payload.signer_key_id, 2);
    assert_eq!(st.window_end, at.plus_seconds(DAY));
    // ... and, its key being trusted, the ordinary path pays it.
    assert!(matches!(
        finalize(&mut s, fallback).unwrap_err(),
        ContractError::WindowOpen { .. }
    ));
    s.advance(DAY);
    finalize(&mut s, fallback).unwrap();
    assert_eq!(route(&s, fallback), Some(Route::Finalized));
    assert_eq!(amounts(&s, fallback), vec![1_462_500, 1_462_500, 2_925_000]);

    // Without a trusted checkpoint the same exit refunds every net deposit.
    let res = s.liveness(orphan, 1, None).unwrap();
    assert_eq!(attr(&res, "path"), "settleable_timeout_refund");
    assert_eq!(route(&s, orphan), Some(Route::SettleableTimeoutRefund));
    assert_eq!(amounts(&s, orphan), vec![NET, NET, NET]);

    // The compromised vector [5, 0, 0] never reached a BankMsg.
    s.assert_custody();
    assert_eq!(s.game(in_play).game.pool.u128(), 3 * NET);
}

/// An active key and a key retired WITHOUT compromise both keep full payout
/// authority, through Finalize and through the completing consent.
#[test]
fn trusted_keys_still_pay_by_finalize_and_by_the_last_consent() {
    for retire in [false, true] {
        let mut s = Suite::new();
        s.add_key(&Key::signer(2));
        let (a, _) = s.settleable(3);
        let b = s.started(3);
        let pb = s.settle(b, 1, 100, &[1, 2, 3], &[0, 1]);
        if retire {
            s.retire_key(1, false);
            assert!(s.game(a).trusted_seq.u64() > 0, "still trusted");
        }
        s.advance(DAY);
        let res = finalize(&mut s, a).unwrap();
        assert_eq!(route(&s, a), Some(Route::Finalized), "retire={retire}");
        assert_eq!(bank_sends(&res).len(), 3, "three seats, no dust");
        let res = consent(&mut s, b, &pb, 2, &Key::seat(2)).unwrap();
        assert_eq!(attr(&res, "state"), "settled");
        assert_eq!(
            route(&s, b),
            Some(Route::ConsentCompleted),
            "retire={retire}"
        );
        for id in [a, b] {
            assert_eq!(
                amounts(&s, id),
                vec![975_000, 1_950_000, 2_925_000],
                "the stored vector 1:2:3 of 3·NET"
            );
        }
        s.assert_custody();
    }
}

/// The chosen Consent semantics: once the stored settlement is compromised,
/// every Consent is refused (not only the one that would complete N-of-N), and
/// it is refused before any signature is checked or any bit is written.
#[test]
fn every_consent_to_a_compromised_settlement_is_refused_without_mutation() {
    let mut s = Suite::new();
    s.add_key(&Key::signer(2));
    let id = s.started(4);
    let p = s.settle(id, 1, 100, &[1, 1, 1, 1], &[0]);
    s.retire_key(1, true);
    let game = s.game(id).game;
    let before = balances(&s);
    let cases: Vec<ExecuteMsg> = vec![
        // not the last missing consent
        consent_msg(&s, id, &p, 1, &Key::seat(1)),
        // an idempotent re-consent of a seat that already consented
        consent_msg(&s, id, &p, 0, &Key::seat(0)),
        // a bad signature and an out-of-range seat: the key check comes first
        consent_msg(&s, id, &p, 2, &Key::seat(7)),
        consent_msg(&s, id, &p, 9, &Key::seat(0)),
    ];
    let who = s.outsider.clone();
    for msg in &cases {
        assert_eq!(s.exec(&who, msg, &[]).unwrap_err(), compromised(1));
    }
    // Seats 1 and 2 were never recorded; seat 0's pre-compromise bit stays as
    // history and nothing can complete it.
    assert_eq!(s.game(id).game, game);
    assert_eq!(consented(&s, id), vec![true, false, false, false]);
    assert_eq!(balances(&s), before);

    // A Settle-time consent set cannot be topped up either: the final consent
    // of a 3-of-4 game is refused just the same.
    let id = s.started(4);
    let p = {
        let mut t = s.terminal_payload(id, 1, 100, &[1, 1, 1, 1]);
        t.signer_key_id = 2;
        let (payload, signature) = s.signed_by(&t, &Key::signer(2));
        let consents: Vec<SeatSignature> = s.consents(id, &t, &[0, 1, 2]);
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
        t
    };
    assert_eq!(s.game(id).game.consent_bitmap, 0b0111);
    s.add_key(&Key::signer(3));
    s.retire_key(2, true);
    let game = s.game(id).game;
    let before = balances(&s);
    assert_eq!(
        consent(&mut s, id, &p, 3, &Key::seat(3)).unwrap_err(),
        compromised(2)
    );
    assert_eq!(s.game(id).game, game, "no bit recorded, no state change");
    assert_eq!(balances(&s), before, "no payout");
    s.assert_custody();
}

/// Finalize checks the key before the window: a compromised settlement is
/// refused with the same stable error whether its window is open or closed;
/// the pause still answers first.
#[test]
fn finalize_refuses_a_compromised_settlement_inside_and_after_the_window() {
    let mut s = Suite::new();
    s.add_key(&Key::signer(2));
    let (id, _) = s.settleable(2);
    s.retire_key(1, true);
    let game = s.game(id).game;
    assert_eq!(finalize(&mut s, id).unwrap_err(), compromised(1));
    s.advance(DAY);
    assert_eq!(finalize(&mut s, id).unwrap_err(), compromised(1));
    s.advance(100 * DAY);
    assert_eq!(finalize(&mut s, id).unwrap_err(), compromised(1));
    s.pause();
    assert_eq!(finalize(&mut s, id).unwrap_err(), ContractError::Paused {});
    assert_eq!(s.game(id).game, game);
    // The fast path cannot use the compromised key either: a new Settle under
    // it is refused as a retired key's payload, whatever consents it carries.
    s.unpause();
    let fresh = s.started(2);
    let t = s.terminal_payload(fresh, 1, 10, &[1, 1]);
    let msg = s.settle_msg(fresh, &t, &[0, 1]);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &msg, &[]).unwrap_err(),
        ContractError::RetiredSignerKey { key_id: 1 }
    );
}

/// The rule covers every stored settlement, not only terminal payloads: a
/// checkpoint promoted by LivenessSettle whose key is compromised afterwards
/// loses its payout authority too, and the next liveness exit falls back to
/// the next trusted checkpoint.
#[test]
fn a_liveness_promoted_settlement_loses_payout_authority_too() {
    let mut s = Suite::new_legacy();
    let key2 = Key::signer(2);
    s.add_key(&key2);
    let id = s.started(2);
    checkpoint_by(&mut s, id, 2, &key2, 10, &[1, 3]);
    checkpoint_by(&mut s, id, 1, &Key::signer(1), 20, &[3, 1]);
    s.advance(LIVENESS);
    s.liveness(id, 0, None).unwrap();
    let st = s.game(id).game.settlement.unwrap();
    assert_eq!(
        (st.source, st.payload.signer_key_id),
        (SettlementSource::LivenessCheckpoint, 1)
    );
    s.retire_key(1, true);
    s.advance(DAY);
    let game = s.game(id).game;
    assert_eq!(finalize(&mut s, id).unwrap_err(), compromised(1));
    assert_eq!(s.game(id).game, game);
    s.advance(LIVENESS);
    let res = s.liveness(id, 1, None).unwrap();
    assert_eq!(attr(&res, "path"), "settleable_timeout_checkpoint");
    assert_eq!(s.game(id).game.settlement.unwrap().payload.signer_key_id, 2);
    s.advance(DAY);
    finalize(&mut s, id).unwrap();
    assert_eq!(amounts(&s, id), vec![975_000, 2_925_000]);
    s.assert_custody();
}

/// The other exits of a compromised SETTLEABLE settlement stay open, and the
/// dispute paths keep their ESCROW-2.1 behaviour: the resolver timeout never
/// pays a compromised settlement, while a resolver Uphold is the resolver's
/// adjudication (the frozen resolver policy names no key-trust condition) and
/// is deliberately left unchanged — pinned here so a policy change is visible.
#[test]
fn other_exits_stay_open_and_the_dispute_paths_are_unchanged() {
    let mut s = Suite::new();
    s.add_key(&Key::signer(2));
    let annul = s.started(3);
    let pa = s.settle(annul, 1, 100, &[0, 0, 1], &[]);
    let (challenged, _) = s.settleable(3);
    let (timeout, _) = s.disputed(3);
    let (upheld, _) = s.disputed(3);
    s.retire_key(1, true);
    // AnnulByConsent over the trusted sequence still refunds.
    let trusted = s.trusted_seq(annul);
    assert!(
        trusted < pa.seq,
        "the compromised terminal lost its authority"
    );
    let sigs = s.annul_sigs(annul, &[0, 1, 2], trusted);
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: annul,
            consents: sigs,
        },
        &[],
    )
    .unwrap();
    assert_eq!(amounts(&s, annul), vec![NET, NET, NET]);
    // Challenge still works inside the window.
    s.challenge(challenged, 0);
    assert_eq!(s.state(challenged), GameState::Disputed);
    // Resolver timeout: no payout of the compromised vector; refund, bond back.
    s.advance(30 * DAY);
    let res = s.liveness(timeout, 0, None).unwrap();
    assert_eq!(attr(&res, "path"), "resolver_timeout_refund");
    assert_eq!(amounts(&s, timeout), vec![NET, NET, NET]);
    // Resolver Uphold: unchanged, the resolver's call. It pays the stored
    // (compromised) vector 1:2:3 over pool + bond, exactly as in ESCROW-2.1.
    assert_eq!(s.bond(upheld), 1_000_000);
    s.resolve(upheld, ResolveOutcome::Uphold {}).unwrap();
    assert_eq!(route(&s, upheld), Some(Route::ResolverUphold));
    assert_eq!(amounts(&s, upheld), vec![1_141_666, 2_283_333, 3_425_000]);
    s.assert_custody();
}
