//! Settle, Consent and Finalize: the signed terminal path.

mod common;

use common::*;
use cosmwasm_std::{coins, Addr, HexBinary, Uint128};
use cw_multi_test::AppResponse;
use eighteen_cosmos_escrow::msg::{
    ExecuteMsg, QueryMsg, SeatSignature, SeatsResponse, SettlementPreviewResponse,
};
use eighteen_cosmos_escrow::payload::Payload;
use eighteen_cosmos_escrow::state::{GameState, Mode, Route, SettlementSource};
use eighteen_cosmos_escrow::ContractError;

fn consent_msg(id: u64, seat_index: u8, signature: HexBinary) -> ExecuteMsg {
    ExecuteMsg::Consent {
        chain_game_id: id,
        seat_index,
        signature,
    }
}

fn finalize(s: &mut Suite, id: u64) -> Result<AppResponse, ContractError> {
    let who = s.outsider.clone();
    s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
}

fn post_settle(
    s: &mut Suite,
    id: u64,
    p: &Payload,
    seats: &[usize],
) -> Result<AppResponse, ContractError> {
    let msg = s.settle_msg(id, p, seats);
    let who = s.outsider.clone();
    s.exec(&who, &msg, &[])
}

fn expected_split(pool: u128, weights: &[u128]) -> (Vec<u128>, u128) {
    let sum: u128 = weights.iter().sum();
    let amounts: Vec<u128> = weights.iter().map(|w| pool * w / sum).collect();
    let dust = pool - amounts.iter().sum::<u128>();
    (amounts, dust)
}

fn balances(s: &Suite, who: &[Addr]) -> Vec<u128> {
    who.iter().map(|a| s.balance(a)).collect()
}

/// Players' and treasury's balance deltas across `f`.
fn deltas<F: FnOnce(&mut Suite)>(s: &mut Suite, n: usize, f: F) -> (Vec<u128>, u128) {
    let players: Vec<Addr> = s.players[..n].to_vec();
    let treasury = s.treasury.clone();
    let before = balances(s, &players);
    let t0 = s.balance(&treasury);
    f(s);
    let after = balances(s, &players);
    let d = after
        .iter()
        .zip(before.iter())
        .map(|(a, b)| a - b)
        .collect();
    (d, s.balance(&treasury) - t0)
}

fn seats_consented(s: &Suite, id: u64) -> Vec<bool> {
    let r: SeatsResponse = s
        .app
        .wrap()
        .query_wasm_smart(s.contract.clone(), &QueryMsg::Seats { chain_game_id: id })
        .unwrap();
    r.seats.iter().map(|v| v.consented).collect()
}

#[test]
fn fast_settle_pays_exact_amounts_and_dust_to_the_treasury() {
    let mut s = Suite::new();
    let id = s.started(3);
    let weights = [1u128, 2, 4];
    let pool = 3 * NET;
    let (amounts, dust) = expected_split(pool, &weights);
    assert_eq!(amounts, vec![835_714, 1_671_428, 3_342_857]);
    assert_eq!(dust, 1);
    let (d, t) = deltas(&mut s, 3, |s| {
        let p = s.terminal_payload(id, 1, 500, &weights);
        let res = post_settle(s, id, &p, &[0, 1, 2]).unwrap();
        assert_eq!(attr(&res, "consent_bitmap"), "7");
        assert_eq!(attr(&res, "state"), "settled");
    });
    assert_eq!(d, amounts);
    assert_eq!(t, dust);
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::Settled);
    assert_eq!(g.pool, Uint128::zero());
    let o = g.outcome.unwrap();
    assert_eq!(o.route, Route::AllConsentsAtSettle);
    assert_eq!(
        o.amounts,
        amounts.iter().map(|a| Uint128::new(*a)).collect::<Vec<_>>()
    );
    assert_eq!(o.dust.u128(), 1);
    assert_eq!(o.distributed.u128(), pool);
    assert_eq!(s.last_seq(id), 1001);
    assert_eq!(s.contract_balance(), 0);
    s.assert_custody();
}

#[test]
fn missing_consents_store_the_settlement_and_open_the_window() {
    let mut s = Suite::new();
    let id = s.started(3);
    s.advance(HOUR);
    let t = s.now();
    let p = s.terminal_payload(id, 2, 400, &[3, 2, 1]);
    let res = post_settle(&mut s, id, &p, &[0, 2]).unwrap();
    assert!(bank_sends(&res).is_empty());
    assert_eq!(attr(&res, "state"), "settleable");
    let gr = s.game(id);
    let g = gr.game;
    assert_eq!(g.state, GameState::Settleable);
    assert_eq!(g.consent_bitmap, 0b101);
    assert_eq!(g.pool.u128(), 3 * NET);
    assert_eq!(g.last_seq.u64(), 801);
    let st = g.settlement.unwrap();
    assert_eq!(st.source, SettlementSource::TerminalPayload);
    assert_eq!(st.accepted_at, t);
    assert_eq!(st.window_end, t.plus_seconds(DAY));
    assert_eq!(st.payload.seq.u64(), 801);
    assert_eq!(st.payload.reason, 2);
    assert_eq!(
        st.payload.payload_digest.to_vec(),
        Suite::settle_digest(&p).to_vec()
    );
    assert_eq!(gr.deadlines.challenge_window_end, Some(t.plus_seconds(DAY)));
    // OD-ESC2-1: a SETTLEABLE game has its own liveness exit.
    assert_eq!(
        gr.deadlines.liveness_available_at,
        Some(t.plus_seconds(DAY + 14 * DAY))
    );
    assert_eq!(seats_consented(&s, id), vec![true, false, true]);
    let preview: SettlementPreviewResponse = s
        .app
        .wrap()
        .query_wasm_smart(
            s.contract.clone(),
            &QueryMsg::SettlementPreview { chain_game_id: id },
        )
        .unwrap();
    let (amounts, dust) = expected_split(3 * NET, &[3, 2, 1]);
    assert_eq!(
        preview.payouts,
        amounts.iter().map(|a| Uint128::new(*a)).collect::<Vec<_>>()
    );
    assert_eq!(preview.dust.u128(), dust);
    s.assert_custody();
}

#[test]
fn finalize_respects_the_window_boundary() {
    let mut s = Suite::new();
    let (id, p) = s.settleable(3);
    let end = s.game(id).game.settlement.unwrap().window_end;
    s.advance(DAY - 1);
    assert_eq!(
        finalize(&mut s, id).unwrap_err(),
        ContractError::WindowOpen { until: end }
    );
    s.advance(1);
    assert_eq!(s.now(), end);
    let (amounts, dust) = expected_split(3 * NET, &p.settlement_weights);
    let (d, t) = deltas(&mut s, 3, |s| {
        let res = finalize(s, id).unwrap();
        assert_eq!(attr(&res, "state"), "settled");
    });
    assert_eq!(d, amounts);
    assert_eq!(t, dust);
    let o = s.game(id).game.outcome.unwrap();
    assert_eq!(o.route, Route::Finalized);
    assert_eq!(o.at, end);
    s.assert_custody();
}

#[test]
fn finalize_long_after_the_window_still_pays_the_stored_vector() {
    let mut s = Suite::new();
    let (id, p) = s.settleable(2);
    s.advance(365 * DAY);
    let (amounts, dust) = expected_split(2 * NET, &p.settlement_weights);
    let (d, t) = deltas(&mut s, 2, |s| {
        finalize(s, id).unwrap();
    });
    assert_eq!(d, amounts);
    assert_eq!(t, dust);
}

#[test]
fn async_games_get_a_48_hour_window() {
    let mut s = Suite::new();
    let id = s.started_with(2, Mode::Async, ANTE);
    let t = s.now();
    s.settle(id, 1, 100, &[1, 1], &[]);
    let end = s.game(id).game.settlement.unwrap().window_end;
    assert_eq!(end, t.plus_seconds(2 * DAY));
    s.advance(DAY);
    assert_eq!(
        finalize(&mut s, id).unwrap_err(),
        ContractError::WindowOpen { until: end }
    );
    s.advance(DAY);
    finalize(&mut s, id).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

#[test]
fn a_settled_game_accepts_nothing_more() {
    let mut s = Suite::new();
    let id = s.settled(3);
    let who = s.outsider.clone();
    let p = s.terminal_payload(id, 1, 200, &[1, 1, 1]);
    let msgs = vec![
        s.settle_msg(id, &p, &[0, 1, 2]),
        s.checkpoint_msg(id, &s.checkpoint_payload(id, 300, &[1, 1, 1])),
        consent_msg(id, 0, Key::seat(0).sign(&s.consent_digest(id, &p))),
        ExecuteMsg::Finalize { chain_game_id: id },
        ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents: s.annul_sigs(id, &[0, 1, 2], s.last_seq(id)),
        },
    ];
    for msg in msgs {
        assert!(matches!(
            s.exec(&who, &msg, &[]).unwrap_err(),
            ContractError::WrongState { .. }
        ));
    }
    let alice = s.players[1].clone();
    assert!(matches!(
        s.exec(
            &alice,
            &ExecuteMsg::Challenge {
                chain_game_id: id,
                evidence_hash: HexBinary::from(vec![1u8; 32]),
            },
            &coins(1_000_000, DENOM),
        )
        .unwrap_err(),
        ContractError::WrongState { .. }
    ));
    assert_eq!(s.game(id).game.pool, Uint128::zero());
    s.assert_custody();
}

#[test]
fn consent_completes_the_settlement_and_is_idempotent() {
    let mut s = Suite::new();
    let id = s.started(3);
    let weights = [5u128, 0, 7];
    let p = s.settle(id, 4, 100, &weights, &[0]);
    let digest = s.consent_digest(id, &p);
    let who = s.outsider.clone();
    // Seat 0 again: accepted, flagged, nothing changes.
    let res = s
        .exec(&who, &consent_msg(id, 0, Key::seat(0).sign(&digest)), &[])
        .unwrap();
    assert_eq!(attr(&res, "already_consented"), "true");
    assert_eq!(s.game(id).game.consent_bitmap, 0b001);
    let res = s
        .exec(&who, &consent_msg(id, 2, Key::seat(2).sign(&digest)), &[])
        .unwrap();
    assert_eq!(attr(&res, "already_consented"), "false");
    assert_eq!(attr(&res, "state"), "settleable");
    assert_eq!(s.game(id).game.consent_bitmap, 0b101);
    assert_eq!(seats_consented(&s, id), vec![true, false, true]);

    let (amounts, dust) = expected_split(3 * NET, &weights);
    let (d, t) = deltas(&mut s, 3, |s| {
        let res = s
            .exec(&who, &consent_msg(id, 1, Key::seat(1).sign(&digest)), &[])
            .unwrap();
        assert_eq!(attr(&res, "state"), "settled");
        // A zero payout is never sent.
        let players = s.players.clone();
        assert!(bank_sends(&res)
            .iter()
            .all(|(to, _)| to != players[1].as_str()));
    });
    assert_eq!(d, amounts);
    assert_eq!(t, dust);
    assert_eq!(
        s.game(id).game.outcome.unwrap().route,
        Route::ConsentCompleted
    );
    s.assert_custody();
}

#[test]
fn invalid_consents_are_refused_and_change_nothing() {
    let mut s = Suite::new();
    let (id, p) = s.settleable(3);
    let digest = s.consent_digest(id, &p);
    let who = s.outsider.clone();
    let other_game = s.started(3);
    let other_p = s.terminal_payload(other_game, 1, 100, &Suite::ramp(3));
    let other_game_digest = s.consent_digest(other_game, &other_p);
    let mut later = p.clone();
    later.log_len = 101;
    later.appraisal_log_len = 101;
    later.seq = 203;
    let other_seq_digest = eighteen_cosmos_escrow::crypto::consent_digest(
        &s.domain(id),
        203,
        &Suite::settle_digest(&later),
    );
    let good = Key::seat(1).sign_bytes(&digest);
    let cases: Vec<(u8, HexBinary, ContractError)> = vec![
        (
            3,
            Key::seat(1).sign(&digest),
            ContractError::SeatIndexOutOfRange { seat_index: 3 },
        ),
        (
            255,
            Key::seat(1).sign(&digest),
            ContractError::SeatIndexOutOfRange { seat_index: 255 },
        ),
        (
            1,
            Key::seat(2).sign(&digest),
            ContractError::InvalidConsent { seat_index: 1 },
        ),
        (
            1,
            Key::seat(1).sign(&other_game_digest),
            ContractError::InvalidConsent { seat_index: 1 },
        ),
        (
            1,
            Key::seat(1).sign(&other_seq_digest),
            ContractError::InvalidConsent { seat_index: 1 },
        ),
        (
            1,
            Key::seat(1).sign(&Suite::settle_digest(&p)),
            ContractError::InvalidConsent { seat_index: 1 },
        ),
        (
            1,
            Key::seat(1).sign_high_s(&digest),
            ContractError::InvalidConsent { seat_index: 1 },
        ),
        (
            1,
            HexBinary::from(&good[..63]),
            ContractError::InvalidConsent { seat_index: 1 },
        ),
        (
            1,
            HexBinary::from(vec![0u8; 64]),
            ContractError::InvalidConsent { seat_index: 1 },
        ),
        // The settlement signer's signature is not a seat consent.
        (
            1,
            s.signer.sign(&digest),
            ContractError::InvalidConsent { seat_index: 1 },
        ),
    ];
    for (seat_index, sig, expected) in cases {
        assert_eq!(
            s.exec(&who, &consent_msg(id, seat_index, sig), &[])
                .unwrap_err(),
            expected
        );
    }
    assert_eq!(s.game(id).game.consent_bitmap, 0);
    assert_eq!(
        s.exec(
            &who,
            &consent_msg(id, 1, HexBinary::from(good.as_slice())),
            &coins(1, DENOM)
        )
        .unwrap_err(),
        ContractError::NonPayable {}
    );
    s.exec(
        &who,
        &consent_msg(id, 1, HexBinary::from(good.as_slice())),
        &[],
    )
    .unwrap();
    assert_eq!(s.game(id).game.consent_bitmap, 0b010);
}

#[test]
fn settle_refuses_the_whole_transaction_on_any_bad_consent() {
    let mut s = Suite::new();
    let id = s.started(3);
    s.post_checkpoint(id, 50, &[1, 1, 1]);
    let p = s.terminal_payload(id, 1, 100, &[1, 2, 3]);
    let (payload, signature) = s.signed(&p);
    let digest = s.consent_digest(id, &p);
    let sig = |seat: usize, key: usize| SeatSignature {
        seat_index: seat as u8,
        signature: Key::seat(key).sign(&digest),
    };
    let cases: Vec<(Vec<SeatSignature>, ContractError)> = vec![
        (
            vec![sig(0, 0), sig(1, 2)],
            ContractError::InvalidConsent { seat_index: 1 },
        ),
        (
            vec![sig(0, 0), sig(0, 0)],
            ContractError::DuplicateConsent { seat_index: 0 },
        ),
        (
            vec![sig(2, 2), sig(1, 1), sig(2, 2)],
            ContractError::DuplicateConsent { seat_index: 2 },
        ),
        (
            vec![sig(5, 1)],
            ContractError::SeatIndexOutOfRange { seat_index: 5 },
        ),
        (
            vec![SeatSignature {
                seat_index: 0,
                signature: Key::seat(0).sign_high_s(&digest),
            }],
            ContractError::InvalidConsent { seat_index: 0 },
        ),
    ];
    let who = s.outsider.clone();
    for (consents, expected) in cases {
        let msg = ExecuteMsg::Settle {
            chain_game_id: id,
            payload: payload.clone(),
            signature: signature.clone(),
            consents,
        };
        assert_eq!(s.exec(&who, &msg, &[]).unwrap_err(), expected);
        let g = s.game(id).game;
        assert_eq!(g.state, GameState::InProgress);
        assert_eq!(g.last_seq.u64(), 100);
        assert!(g.settlement.is_none());
    }
    // Consents may arrive in any order.
    let msg = ExecuteMsg::Settle {
        chain_game_id: id,
        payload,
        signature,
        consents: vec![sig(2, 2), sig(0, 0), sig(1, 1)],
    };
    s.exec(&who, &msg, &[]).unwrap();
    assert_eq!(s.state(id), GameState::Settled);
}

#[test]
fn settle_accepts_reasons_one_to_four_only() {
    let mut s = Suite::new();
    for reason in 1..=4u8 {
        let id = s.started(2);
        let p = s.terminal_payload(id, reason, 100, &[1, 1]);
        post_settle(&mut s, id, &p, &[]).unwrap();
        assert_eq!(s.game(id).game.settlement.unwrap().payload.reason, reason);
    }
    let id = s.started(2);
    let cases: Vec<(u8, ContractError)> = vec![
        (5, ContractError::ReasonNotAllowed { reason: 5 }),
        (0, ContractError::ReasonNotAllowed { reason: 0 }),
        (6, ContractError::UnknownReason { got: 6 }),
        (255, ContractError::UnknownReason { got: 255 }),
    ];
    for (reason, expected) in cases {
        let p = s.terminal_payload(id, reason, 100, &[1, 1]);
        assert_eq!(post_settle(&mut s, id, &p, &[]).unwrap_err(), expected);
    }
    let c = s.checkpoint_payload(id, 100, &[1, 1]);
    assert_eq!(
        post_settle(&mut s, id, &c, &[]).unwrap_err(),
        ContractError::WrongKind {
            expected: "terminal".to_string()
        }
    );
    assert_eq!(s.state(id), GameState::InProgress);
}

#[test]
fn appraisal_rules_for_terminal_reasons() {
    let mut s = Suite::new();
    // Forfeit and Clemency may appraise an earlier round-boundary board.
    for reason in [3u8, 4] {
        for appraisal in [0u64, 60, 100] {
            let id = s.started(2);
            let mut p = s.terminal_payload(id, reason, 100, &[2, 1]);
            p.appraisal_log_len = appraisal;
            post_settle(&mut s, id, &p, &[0, 1]).unwrap();
            let o = s.game(id).game;
            assert_eq!(o.state, GameState::Settled);
        }
    }
    // BankBroken and Bankruptcy must appraise at log_len; nobody may exceed it.
    let id = s.started(2);
    for (reason, appraisal) in [
        (1u8, 99u64),
        (2, 99),
        (2, 0),
        (1, 101),
        (3, 101),
        (4, u64::MAX),
    ] {
        let mut p = s.terminal_payload(id, reason, 100, &[2, 1]);
        p.appraisal_log_len = appraisal;
        assert_eq!(
            post_settle(&mut s, id, &p, &[0, 1]).unwrap_err(),
            ContractError::BadAppraisalLogLen {
                appraisal_log_len: appraisal,
                log_len: 100
            }
        );
    }
    assert_eq!(s.state(id), GameState::InProgress);
}

#[test]
fn a_terminal_may_share_the_last_checkpoints_log_len_but_not_precede_it() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.post_checkpoint(id, 100, &[1, 1]);
    let p = s.terminal_payload(id, 1, 100, &[1, 2]);
    post_settle(&mut s, id, &p, &[]).unwrap();
    assert_eq!(s.last_seq(id), 201);

    let id = s.started(2);
    s.post_checkpoint(id, 100, &[1, 1]);
    let p = s.terminal_payload(id, 1, 99, &[1, 2]);
    assert_eq!(
        post_settle(&mut s, id, &p, &[]).unwrap_err(),
        ContractError::StaleSeq {
            seq: 199,
            trusted_seq: 200
        }
    );
    // A terminal at log_len 0 (seq 1) is not stale on a fresh game.
    let id = s.started(2);
    let p = s.terminal_payload(id, 3, 0, &[1, 0]);
    post_settle(&mut s, id, &p, &[]).unwrap();
    assert_eq!(s.last_seq(id), 1);
}

#[test]
fn settle_signature_rules() {
    let mut s = Suite::new();
    let id = s.started(2);
    let p = s.terminal_payload(id, 1, 100, &[1, 2]);
    let digest = Suite::settle_digest(&p);
    let who = s.outsider.clone();
    let settle_with = |sig: HexBinary| ExecuteMsg::Settle {
        chain_game_id: id,
        payload: Suite::wire(&p),
        signature: sig,
        consents: vec![],
    };
    assert_eq!(
        s.exec(&who, &settle_with(s.signer.sign_high_s(&digest)), &[])
            .unwrap_err(),
        ContractError::HighS {}
    );
    assert_eq!(
        s.exec(&who, &settle_with(Key::seat(0).sign(&digest)), &[])
            .unwrap_err(),
        ContractError::InvalidSignature {}
    );
    assert_eq!(
        s.exec(&who, &settle_with(HexBinary::from(vec![7u8; 10])), &[])
            .unwrap_err(),
        ContractError::BadSignatureLength { got: 10 }
    );
    let key2 = Key::signer(2);
    s.add_key(&key2);
    s.retire_key(1, false);
    assert_eq!(
        s.exec(&who, &settle_with(s.signer.sign(&digest)), &[])
            .unwrap_err(),
        ContractError::RetiredSignerKey { key_id: 1 }
    );
    let mut q = p.clone();
    q.signer_key_id = 2;
    let (payload, signature) = s.signed_by(&q, &key2);
    s.exec(
        &who,
        &ExecuteMsg::Settle {
            chain_game_id: id,
            payload,
            signature,
            consents: vec![],
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Settleable);
}

#[test]
fn settle_payload_must_belong_to_this_game() {
    let mut s = Suite::new();
    let a = s.started(2);
    let b = s.started(2);
    let pb = s.terminal_payload(b, 1, 100, &[1, 2]);
    assert_eq!(
        post_settle(&mut s, a, &pb, &[]).unwrap_err(),
        ContractError::DomainMismatch {}
    );
    let pa = s.terminal_payload(a, 1, 100, &[1, 2, 3]);
    assert_eq!(
        post_settle(&mut s, a, &pa, &[]).unwrap_err(),
        ContractError::RosterLengthMismatch {
            expected: 2,
            got: 3
        }
    );
    let pa = s.terminal_payload(a, 1, 100, &[0, 0]);
    assert_eq!(
        post_settle(&mut s, a, &pa, &[]).unwrap_err(),
        ContractError::ZeroSumWeights {}
    );
    let pa = s.terminal_payload(a, 1, 100, &[1, 2]);
    let msg = s.settle_msg(a, &pa, &[]);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &msg, &coins(5, DENOM)).unwrap_err(),
        ContractError::NonPayable {}
    );
    // Consents for game A's payload do not transfer to game B.
    let consents_a = s.consents(a, &pa, &[0, 1]);
    let pb = s.terminal_payload(b, 1, 100, &[1, 2]);
    let (payload, signature) = s.signed(&pb);
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::Settle {
                chain_game_id: b,
                payload,
                signature,
                consents: consents_a,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
}

#[test]
fn pause_blocks_settle_consent_and_finalize() {
    let mut s = Suite::new();
    let id = s.started(3);
    let (sid, sp) = s.settleable(3);
    s.pause();
    let p = s.terminal_payload(id, 1, 100, &[1, 1, 1]);
    assert_eq!(
        post_settle(&mut s, id, &p, &[0, 1, 2]).unwrap_err(),
        ContractError::Paused {}
    );
    let digest = s.consent_digest(sid, &sp);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &consent_msg(sid, 0, Key::seat(0).sign(&digest)), &[])
            .unwrap_err(),
        ContractError::Paused {}
    );
    s.advance(2 * DAY);
    assert_eq!(finalize(&mut s, sid).unwrap_err(), ContractError::Paused {});
    s.unpause();
    finalize(&mut s, sid).unwrap();
    post_settle(&mut s, id, &p, &[0, 1, 2]).unwrap();
    assert_eq!(s.state(sid), GameState::Settled);
    assert_eq!(s.state(id), GameState::Settled);
    s.assert_custody();
}

#[test]
fn anyone_may_settle_consent_or_finalize() {
    let mut s = Suite::new();
    let callers = [
        s.admin.clone(),
        s.resolver.clone(),
        s.players[2].clone(),
        s.outsider.clone(),
    ];
    for who in callers {
        let id = s.started(3);
        let p = s.terminal_payload(id, 1, 100, &[1, 1, 1]);
        let msg = s.settle_msg(id, &p, &[0]);
        s.exec(&who, &msg, &[]).unwrap();
        let digest = s.consent_digest(id, &p);
        s.exec(&who, &consent_msg(id, 1, Key::seat(1).sign(&digest)), &[])
            .unwrap();
        s.advance(DAY);
        s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[])
            .unwrap();
        assert_eq!(s.state(id), GameState::Settled);
    }
    s.assert_custody();
}

#[test]
fn seven_seat_fast_settle() {
    let mut s = Suite::new();
    let id = s.started(7);
    let weights = [9u128, 0, 1, 3, 5, 7, 2];
    let (amounts, dust) = expected_split(7 * NET, &weights);
    let (d, t) = deltas(&mut s, 7, |s| {
        let p = s.terminal_payload(id, 1, 2_000, &weights);
        post_settle(s, id, &p, &[6, 5, 4, 3, 2, 1, 0]).unwrap();
    });
    assert_eq!(d, amounts);
    assert_eq!(t, dust);
    assert_eq!(s.state(id), GameState::Settled);
    s.assert_custody();
}

#[test]
fn a_settleable_game_takes_no_second_settle_or_checkpoint() {
    let mut s = Suite::new();
    let (id, _) = s.settleable(2);
    let p = s.terminal_payload(id, 1, 500, &[1, 1]);
    assert!(matches!(
        post_settle(&mut s, id, &p, &[0, 1]).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    let c = s.checkpoint_payload(id, 500, &[1, 1]);
    let msg = s.checkpoint_msg(id, &c);
    let who = s.outsider.clone();
    assert!(matches!(
        s.exec(&who, &msg, &[]).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    assert_eq!(s.last_seq(id), 201);
}

#[test]
fn consent_and_finalize_need_a_settleable_game() {
    let mut s = Suite::new();
    let id = s.started(2);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(
            &who,
            &consent_msg(id, 0, HexBinary::from(vec![1u8; 64])),
            &[]
        )
        .unwrap_err(),
        ContractError::WrongState {
            expected: "settleable".to_string(),
            actual: "in_progress".to_string()
        }
    );
    assert_eq!(
        finalize(&mut s, id).unwrap_err(),
        ContractError::WrongState {
            expected: "settleable".to_string(),
            actual: "in_progress".to_string()
        }
    );
}
