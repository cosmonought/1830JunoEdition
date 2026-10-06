//! SETTLED, CANCELLED and ANNULLED accept no message, whichever route reached
//! them, from any caller, paused or not; queries keep working.

mod common;

use common::*;
use cosmwasm_std::{coins, Addr, Coin, HexBinary, Uint128};
use eighteen_cosmos_escrow::msg::{
    ExecuteMsg, GamesResponse, QueryMsg, ResolveOutcome, SeatSignature, SeatsResponse,
    SettlementPreviewResponse, SignedCheckpoint,
};
use eighteen_cosmos_escrow::payload::{Payload, REASON_RESOLVER_CORRECTION};
use eighteen_cosmos_escrow::remedy::RemedyAttestation;
use eighteen_cosmos_escrow::state::{GameState, Mode, RemedyKind, Route};
use eighteen_cosmos_escrow::ContractError;

/// One terminal game per route into a terminal state.
fn terminal_games(s: &mut Suite) -> Vec<(Route, u64)> {
    let mut out = Vec::new();

    out.push((Route::AllConsentsAtSettle, s.settled(3)));

    let (id, p) = s.settleable(3);
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
    out.push((Route::ConsentCompleted, id));

    let (id, _) = s.settleable(3);
    s.advance(DAY);
    s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
        .unwrap();
    out.push((Route::Finalized, id));

    let (id, _) = s.disputed(3);
    s.resolve(id, ResolveOutcome::Uphold {}).unwrap();
    out.push((Route::ResolverUphold, id));

    let (id, _) = s.disputed(3);
    let fix = s.terminal_payload(id, REASON_RESOLVER_CORRECTION, 101, &[1, 1, 1]);
    s.resolve(
        id,
        ResolveOutcome::Replace {
            payload: Suite::wire(&fix),
        },
    )
    .unwrap();
    out.push((Route::ResolverReplace, id));

    let (id, _) = s.disputed(3);
    s.resolve(id, ResolveOutcome::Annul {}).unwrap();
    out.push((Route::ResolverAnnul, id));

    let (id, _) = s.disputed(3);
    s.advance(30 * DAY);
    let alice = s.players[1].clone();
    s.exec(
        &alice,
        &ExecuteMsg::LivenessSettle {
            chain_game_id: id,
            checkpoint: None,
        },
        &[],
    )
    .unwrap();
    out.push((Route::ResolverTimeoutPayout, id));

    out.push((Route::AnnulByConsent, s.annulled(3)));
    out.push((Route::CreatorCancel, s.cancelled(3)));

    let id = s.create(0, 3, Mode::Live, ANTE);
    s.join(id, 1, ANTE);
    s.advance(DAY);
    s.exec(&who, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
        .unwrap();
    out.push((Route::DeadlineCancel, id));

    // The IN_PROGRESS liveness refund exists only for a game stored by escrow
    // 2.0.0 code (2.1.0 games refuse it).
    let id = s.started(3);
    s.make_legacy(id);
    s.advance(14 * DAY);
    s.exec(
        &alice,
        &ExecuteMsg::LivenessSettle {
            chain_game_id: id,
            checkpoint: None,
        },
        &[],
    )
    .unwrap();
    out.push((Route::LivenessRefund, id));

    // Escrow 2.1.0: the exceptional review of a No-deadline game.
    s.no_deadline = true;
    let id = s.started(3);
    s.no_deadline = false;
    s.exec(
        &alice,
        &ExecuteMsg::RequestReview { chain_game_id: id },
        &[],
    )
    .unwrap();
    s.advance(7 * DAY);
    let resolver = s.resolver.clone();
    s.exec(&resolver, &s.review_annul_msg(id), &[]).unwrap();
    out.push((Route::ReviewAnnul, id));

    let (id, _) = s.settleable(3);
    s.advance(DAY + 14 * DAY);
    s.exec(
        &alice,
        &ExecuteMsg::LivenessSettle {
            chain_game_id: id,
            checkpoint: None,
        },
        &[],
    )
    .unwrap();
    out.push((Route::SettleableTimeoutPayout, id));

    // Escrow 2.1.0 remedies (remedy key 1, independent of signer key 1).
    for (kind, mode, route) in [
        (
            RemedyKind::LiveTimeoutAnnul,
            Mode::Live,
            Route::RemedyTimeoutAnnul,
        ),
        (RemedyKind::AsyncAnnul, Mode::Async, Route::RemedyAnnul),
        (
            RemedyKind::LiveForeclose,
            Mode::Live,
            Route::RemedyForeclosure,
        ),
        (
            RemedyKind::AsyncForeclose,
            Mode::Async,
            Route::RemedyForeclosure,
        ),
    ] {
        let id = s.started_with(3, mode, ANTE);
        s.remedy_ready(id);
        let a = s.attestation(id, kind, 2, 10);
        let msg = s.remedy_msg(&a);
        s.submit(&msg).unwrap();
        out.push((route, id));
    }
    // A third-strike foreclosure, finalized after its challenge window.
    let id = s.started_with(3, Mode::Live, ANTE);
    s.remedy_ready(id);
    let a = s.attestation(id, RemedyKind::LiveStrike3Foreclose, 1, 10);
    let msg = s.remedy_msg(&a);
    s.submit(&msg).unwrap();
    s.advance(DAY);
    s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
        .unwrap();
    out.push((Route::Finalized, id));
    // Universal unanimous annulment of a 2.1.0 DISPUTED game.
    let (id, _) = s.disputed(3);
    let trusted = s.trusted_seq(id);
    let consents = s.annul_sigs(id, &[0, 1, 2], trusted);
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents,
        },
        &[],
    )
    .unwrap();
    out.push((Route::AnnulByConsent, id));

    // Last: retiring key 1 as compromised would break the fixtures above.
    let (settleable, _) = s.settleable(3);
    let (disputed, _) = s.disputed(3);
    s.retire_key(1, true);
    s.advance(30 * DAY);
    for id in [settleable, disputed] {
        s.exec(
            &alice,
            &ExecuteMsg::LivenessSettle {
                chain_game_id: id,
                checkpoint: None,
            },
            &[],
        )
        .unwrap();
    }
    out.push((Route::SettleableTimeoutRefund, settleable));
    out.push((Route::ResolverTimeoutRefund, disputed));
    s.add_key(&Key::signer(2));
    out
}

fn some_payload(s: &Suite, id: u64, kind_terminal: bool) -> Payload {
    let domain = s
        .game(id)
        .game
        .domain
        .map(|d| <[u8; 32]>::try_from(d.as_slice()).unwrap())
        .unwrap_or([0u8; 32]);
    let log_len = 5_000;
    Payload {
        version: 1,
        domain,
        seq: 2 * log_len + u64::from(kind_terminal),
        kind: u8::from(kind_terminal),
        reason: u8::from(kind_terminal),
        log_len,
        log_hash: [1; 32],
        appraisal_log_len: log_len,
        appraisal_state_hash: [2; 32],
        state_schema_version: 1,
        settlement_weights: vec![1; s.game(id).game.seats.len()],
        signer_key_id: 2,
        issued_at: 0,
    }
}

/// Every per-game message, with the funds a caller would plausibly attach.
fn battery(s: &Suite, id: u64) -> Vec<(ExecuteMsg, Vec<Coin>)> {
    let key2 = Key::signer(2);
    let g = s.game(id).game;
    let remedy = RemedyAttestation {
        version: 1,
        domain: g
            .domain
            .map(|d| <[u8; 32]>::try_from(d.as_slice()).unwrap())
            .unwrap_or([0u8; 32]),
        chain_game_id: id,
        remedy: 1,
        defaulting_seat: 0,
        strike: 1,
        overdue_epoch: 1,
        log_len: 5_000,
        log_hash: [1; 32],
        allowance_secs: 1_200,
        overdue_at: s.now().seconds() - 600,
        final_at: s.now().seconds(),
        attested_at: s.now().seconds(),
        expires_at: s.now().seconds() + HOUR,
        evidence_hash: [5; 32],
        remedy_key_id: 1,
    };
    let cp = some_payload(s, id, false);
    let tp = some_payload(s, id, true);
    let sig = |p: &Payload| key2.sign(&Suite::settle_digest(p));
    let seat_sig = SeatSignature {
        seat_index: 0,
        signature: Key::seat(0).sign(&[3u8; 32]),
    };
    vec![
        (s.join_msg(id, 7), coins(ANTE, DENOM)),
        (ExecuteMsg::Withdraw { chain_game_id: id }, vec![]),
        (ExecuteMsg::Cancel { chain_game_id: id }, vec![]),
        (
            ExecuteMsg::SetConsentKey {
                chain_game_id: id,
                new_pubkey: Key::seat(9).pubkey,
            },
            vec![],
        ),
        (
            ExecuteMsg::Start {
                chain_game_id: id,
                roster_hash: HexBinary::from(vec![0u8; 32]),
            },
            vec![],
        ),
        (
            ExecuteMsg::Checkpoint {
                chain_game_id: id,
                payload: Suite::wire(&cp),
                signature: sig(&cp),
            },
            vec![],
        ),
        (
            ExecuteMsg::Settle {
                chain_game_id: id,
                payload: Suite::wire(&tp),
                signature: sig(&tp),
                consents: vec![seat_sig.clone()],
            },
            vec![],
        ),
        (
            ExecuteMsg::Consent {
                chain_game_id: id,
                seat_index: 0,
                signature: seat_sig.signature.clone(),
            },
            vec![],
        ),
        (ExecuteMsg::Finalize { chain_game_id: id }, vec![]),
        (
            ExecuteMsg::Challenge {
                chain_game_id: id,
                evidence_hash: HexBinary::from(vec![4u8; 32]),
            },
            coins(1_000_000, DENOM),
        ),
        (
            ExecuteMsg::Resolve {
                chain_game_id: id,
                outcome: ResolveOutcome::Uphold {},
            },
            vec![],
        ),
        (
            ExecuteMsg::Resolve {
                chain_game_id: id,
                outcome: ResolveOutcome::Annul {},
            },
            vec![],
        ),
        (
            ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents: vec![seat_sig],
            },
            vec![],
        ),
        (
            ExecuteMsg::LivenessSettle {
                chain_game_id: id,
                checkpoint: None,
            },
            vec![],
        ),
        (ExecuteMsg::RequestReview { chain_game_id: id }, vec![]),
        (s.review_annul_msg(id), vec![]),
        (s.remedy_msg_by(&remedy, &s.remedy, vec![]), vec![]),
        (
            ExecuteMsg::LivenessSettle {
                chain_game_id: id,
                checkpoint: Some(SignedCheckpoint {
                    payload: Suite::wire(&cp),
                    signature: sig(&cp),
                }),
            },
            vec![],
        ),
    ]
}

fn senders(s: &Suite) -> Vec<Addr> {
    vec![
        s.players[0].clone(),
        s.players[1].clone(),
        s.operator.clone(),
        s.resolver.clone(),
        s.admin.clone(),
        s.outsider.clone(),
    ]
}

fn assert_all_refused(s: &mut Suite, games: &[(Route, u64)]) -> usize {
    let mut checked = 0;
    for (route, id) in games {
        let g = s.game(*id).game;
        assert!(g.state.is_terminal(), "{route:?}");
        assert_eq!(g.pool, Uint128::zero(), "{route:?}");
        assert_eq!(g.outcome.as_ref().unwrap().route, *route);
        let actual = g.state.as_str().to_string();
        let balance = s.contract_balance();
        for (msg, funds) in battery(s, *id) {
            for who in senders(s) {
                let err = s.exec(&who, &msg, &funds).unwrap_err();
                match err {
                    ContractError::WrongState { actual: a, .. } => {
                        assert_eq!(a, actual, "{route:?} {msg:?}")
                    }
                    other => panic!("{route:?} {msg:?} from {who}: {other:?}"),
                }
                checked += 1;
            }
        }
        assert_eq!(s.contract_balance(), balance);
        assert_eq!(s.game(*id).game, g, "{route:?} changed");
    }
    checked
}

#[test]
fn every_terminal_route_refuses_every_game_message() {
    let mut s = Suite::new();
    let games = terminal_games(&mut s);
    assert_eq!(games.len(), 21, "every route into a terminal state");
    let checked = assert_all_refused(&mut s, &games);
    assert_eq!(checked, 21 * 18 * 6);
    s.pause();
    assert_all_refused(&mut s, &games);
    s.assert_custody();
    assert_eq!(s.contract_balance(), 0);
}

#[test]
fn terminal_states_by_route() {
    let mut s = Suite::new();
    for (route, id) in terminal_games(&mut s) {
        let expected = match route {
            Route::AllConsentsAtSettle
            | Route::ConsentCompleted
            | Route::Finalized
            | Route::ResolverUphold
            | Route::ResolverReplace
            | Route::ResolverTimeoutPayout
            | Route::SettleableTimeoutPayout
            | Route::RemedyForeclosure => GameState::Settled,
            Route::ResolverAnnul
            | Route::AnnulByConsent
            | Route::ReviewAnnul
            | Route::RemedyTimeoutAnnul
            | Route::RemedyAnnul => GameState::Annulled,
            Route::CreatorCancel
            | Route::DeadlineCancel
            | Route::LivenessRefund
            | Route::ResolverTimeoutRefund
            | Route::SettleableTimeoutRefund => GameState::Cancelled,
        };
        assert_eq!(s.state(id), expected, "{route:?}");
    }
}

#[test]
fn queries_keep_working_on_terminal_games() {
    let mut s = Suite::new();
    let games = terminal_games(&mut s);
    let q = s.app.wrap();
    for (route, id) in &games {
        let g = s.game(*id);
        assert!(g.game.state.is_terminal());
        assert_eq!(g.deadlines.liveness_available_at, None);
        assert_eq!(g.deadlines.challenge_window_end, None);
        assert_eq!(g.deadlines.resolver_timeout_at, None);
        let seats: SeatsResponse = q
            .query_wasm_smart(s.contract.clone(), &QueryMsg::Seats { chain_game_id: *id })
            .unwrap();
        assert_eq!(seats.seats.len(), g.game.seats.len());
        s.checkpoints(*id);
        let preview: Result<SettlementPreviewResponse, _> = q.query_wasm_smart(
            s.contract.clone(),
            &QueryMsg::SettlementPreview { chain_game_id: *id },
        );
        match &g.game.settlement {
            Some(_) => {
                let p = preview.unwrap();
                assert_eq!(p.pool, Uint128::zero(), "{route:?}");
                assert!(p.payouts.iter().all(|x| x.is_zero()));
            }
            None => assert!(preview.is_err(), "{route:?}"),
        }
    }
    let all: GamesResponse = q
        .query_wasm_smart(
            s.contract.clone(),
            &QueryMsg::Games {
                start_after: None,
                limit: Some(30),
            },
        )
        .unwrap();
    assert_eq!(all.games.len(), games.len());
    assert!(all
        .games
        .iter()
        .all(|g| g.state.is_terminal() && g.pool.is_zero()));
    // Unknown ids are a query error, not a panic.
    assert!(q
        .query_wasm_smart::<SeatsResponse>(
            s.contract.clone(),
            &QueryMsg::Seats {
                chain_game_id: 9_999
            }
        )
        .is_err());
}
