//! Checkpoint: signed round-boundary payloads while IN_PROGRESS.

mod common;

use common::*;
use cosmwasm_std::{coins, HexBinary, Uint128, Uint64};
use cw_multi_test::AppResponse;
use eighteen_cosmos_escrow::crypto;
use eighteen_cosmos_escrow::msg::{ExecuteMsg, SettlementPayloadV1};
use eighteen_cosmos_escrow::payload::{Payload, KIND_CHECKPOINT, KIND_TERMINAL};
use eighteen_cosmos_escrow::state::GameState;
use eighteen_cosmos_escrow::ContractError;

fn submit(
    s: &mut Suite,
    id: u64,
    payload: SettlementPayloadV1,
    signature: HexBinary,
) -> Result<AppResponse, ContractError> {
    let who = s.outsider.clone();
    s.exec(
        &who,
        &ExecuteMsg::Checkpoint {
            chain_game_id: id,
            payload,
            signature,
        },
        &[],
    )
}

fn sign_and_submit(s: &mut Suite, id: u64, p: &Payload) -> Result<AppResponse, ContractError> {
    let (w, sig) = s.signed(p);
    submit(s, id, w, sig)
}

/// Asserts nothing about the game moved.
fn assert_untouched(s: &Suite, id: u64, last_seq: u64) {
    let g = s.game(id).game;
    assert_eq!(g.state, GameState::InProgress);
    assert_eq!(g.last_seq.u64(), last_seq);
    s.assert_custody();
}

#[test]
fn a_valid_checkpoint_is_stored_and_refreshes_activity() {
    let mut s = Suite::new();
    let id = s.started(3);
    let before = s.contract_balance();
    s.advance(HOUR);
    let t = s.now();
    let p = s.checkpoint_payload(id, 120, &[1, 2, 3]);
    let res = sign_and_submit(&mut s, id, &p).unwrap();
    let digest = Suite::settle_digest(&p);
    assert_eq!(attr(&res, "seq"), "240");
    assert_eq!(attr(&res, "log_len"), "120");
    assert_eq!(attr(&res, "signer_key_id"), "1");
    assert_eq!(
        attr(&res, "payload_digest"),
        HexBinary::from(digest.as_slice()).to_hex()
    );
    assert!(bank_sends(&res).is_empty());

    let gr = s.game(id);
    assert_eq!(gr.game.state, GameState::InProgress);
    assert_eq!(gr.game.last_seq.u64(), 240);
    assert_eq!(gr.game.last_activity, Some(t));
    assert_eq!(gr.game.pool.u128(), 3 * NET);
    let latest = gr.latest_checkpoint.unwrap();
    assert_eq!(latest.accepted_at, t);
    let rec = latest.payload;
    assert_eq!(rec.seq.u64(), 240);
    assert_eq!(rec.kind, KIND_CHECKPOINT);
    assert_eq!(rec.reason, 0);
    assert_eq!(rec.log_len.u64(), 120);
    assert_eq!(rec.appraisal_log_len.u64(), 120);
    assert_eq!(rec.log_hash.to_vec(), p.log_hash.to_vec());
    assert_eq!(
        rec.appraisal_state_hash.to_vec(),
        p.appraisal_state_hash.to_vec()
    );
    assert_eq!(rec.state_schema_version, 1);
    assert_eq!(
        rec.settlement_weights,
        vec![Uint128::new(1), Uint128::new(2), Uint128::new(3)]
    );
    assert_eq!(rec.signer_key_id, 1);
    assert_eq!(rec.issued_at.u64(), p.issued_at);
    assert_eq!(rec.payload_digest.to_vec(), digest.to_vec());
    // Liveness is now measured from the checkpoint.
    assert_eq!(
        gr.deadlines.liveness_available_at,
        Some(t.plus_seconds(14 * DAY))
    );
    let cps = s.checkpoints(id);
    assert_eq!(cps.checkpoints.len(), 1);
    assert_eq!(cps.liveness_candidate_seq, Some(Uint64::new(240)));
    assert_eq!(s.contract_balance(), before);
    s.assert_custody();
}

#[test]
fn anyone_may_post_a_checkpoint() {
    let mut s = Suite::new();
    let id = s.started(3);
    let posters = [
        s.admin.clone(),
        s.operator.clone(),
        s.resolver.clone(),
        s.players[0].clone(),
        s.players[2].clone(),
        s.outsider.clone(),
        s.players[6].clone(),
    ];
    for (i, who) in posters.iter().enumerate() {
        let log_len = 10 * (i as u64 + 1);
        let p = s.checkpoint_payload(id, log_len, &[1, 1, 1]);
        let msg = s.checkpoint_msg(id, &p);
        s.exec(who, &msg, &[]).unwrap();
        assert_eq!(s.last_seq(id), 2 * log_len);
    }
}

#[test]
fn seq_must_strictly_increase() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.post_checkpoint(id, 120, &[1, 1]);
    for (log_len, seq) in [(120u64, 240u64), (119, 238), (1, 2)] {
        let p = s.checkpoint_payload(id, log_len, &[1, 1]);
        assert_eq!(
            sign_and_submit(&mut s, id, &p).unwrap_err(),
            ContractError::StaleSeq { seq, last_seq: 240 }
        );
    }
    s.post_checkpoint(id, 121, &[1, 1]);
    assert_eq!(s.last_seq(id), 242);
}

#[test]
fn a_checkpoint_at_log_len_zero_is_stale() {
    // seq 0 is the genesis value of last_seq; the first checkpoint needs
    // log_len >= 1.
    let mut s = Suite::new();
    let id = s.started(2);
    let p = s.checkpoint_payload(id, 0, &[1, 1]);
    assert_eq!(
        sign_and_submit(&mut s, id, &p).unwrap_err(),
        ContractError::StaleSeq {
            seq: 0,
            last_seq: 0
        }
    );
    s.post_checkpoint(id, 1, &[1, 1]);
    assert_eq!(s.last_seq(id), 2);
}

#[test]
fn kind_and_reason_rules() {
    let mut s = Suite::new();
    let id = s.started(3);
    let w = [1u128, 2, 3];

    let terminal = s.terminal_payload(id, 1, 50, &w);
    assert_eq!(
        sign_and_submit(&mut s, id, &terminal).unwrap_err(),
        ContractError::WrongKind {
            expected: "checkpoint".to_string()
        }
    );
    for kind in [2u8, 3, 0x80, 0xff] {
        let mut p = s.checkpoint_payload(id, 50, &w);
        p.kind = kind;
        assert_eq!(
            sign_and_submit(&mut s, id, &p).unwrap_err(),
            ContractError::BadKind { got: kind }
        );
    }
    for reason in 1..=5u8 {
        let mut p = s.checkpoint_payload(id, 50, &w);
        p.reason = reason;
        assert_eq!(
            sign_and_submit(&mut s, id, &p).unwrap_err(),
            ContractError::ReasonNotAllowed { reason }
        );
    }
    for reason in [6u8, 7, 100, 0xff] {
        let mut p = s.checkpoint_payload(id, 50, &w);
        p.reason = reason;
        assert_eq!(
            sign_and_submit(&mut s, id, &p).unwrap_err(),
            ContractError::UnknownReason { got: reason }
        );
    }
    assert_untouched(&s, id, 0);
}

#[test]
fn version_must_be_one() {
    let mut s = Suite::new();
    let id = s.started(2);
    for version in [0u8, 2, 0xff] {
        let mut p = s.checkpoint_payload(id, 10, &[1, 1]);
        p.version = version;
        assert_eq!(
            sign_and_submit(&mut s, id, &p).unwrap_err(),
            ContractError::BadVersion { got: version }
        );
    }
    assert_untouched(&s, id, 0);
}

#[test]
fn seq_must_be_twice_log_len() {
    let mut s = Suite::new();
    let id = s.started(2);
    for delta in [-2i64, -1, 1, 2] {
        let mut p = s.checkpoint_payload(id, 10, &[1, 1]);
        p.seq = (20 + delta) as u64;
        assert_eq!(
            sign_and_submit(&mut s, id, &p).unwrap_err(),
            ContractError::BadSeq { seq: p.seq }
        );
    }
    // 2·log_len would overflow u64: refused, never wrapped.
    let mut p = s.checkpoint_payload(id, 10, &[1, 1]);
    p.log_len = u64::MAX / 2 + 1;
    p.appraisal_log_len = p.log_len;
    p.seq = p.log_len.wrapping_mul(2);
    assert_eq!(
        sign_and_submit(&mut s, id, &p).unwrap_err(),
        ContractError::BadSeq { seq: 0 }
    );
    // The largest representable checkpoint is accepted.
    let mut p = s.checkpoint_payload(id, 10, &[1, 1]);
    p.log_len = u64::MAX / 2;
    p.appraisal_log_len = p.log_len;
    p.seq = u64::MAX - 1;
    sign_and_submit(&mut s, id, &p).unwrap();
    assert_eq!(s.last_seq(id), u64::MAX - 1);
}

#[test]
fn appraisal_log_len_must_equal_log_len() {
    let mut s = Suite::new();
    let id = s.started(2);
    for appraisal in [0u64, 99, 101, u64::MAX] {
        let mut p = s.checkpoint_payload(id, 100, &[1, 1]);
        p.appraisal_log_len = appraisal;
        assert_eq!(
            sign_and_submit(&mut s, id, &p).unwrap_err(),
            ContractError::BadAppraisalLogLen {
                appraisal_log_len: appraisal,
                log_len: 100
            }
        );
    }
    assert_untouched(&s, id, 0);
}

#[test]
fn bad_signatures_are_refused() {
    let mut s = Suite::new();
    let id = s.started(3);
    let p = s.checkpoint_payload(id, 60, &[5, 6, 7]);
    let digest = Suite::settle_digest(&p);
    let good = s.signer.sign_bytes(&digest);
    let w = Suite::wire(&p);

    let stranger = Key::from_label("18JUNO/TEST/not-a-signer");
    let cases: Vec<(HexBinary, ContractError)> = vec![
        (stranger.sign(&digest), ContractError::InvalidSignature {}),
        (s.signer.sign_high_s(&digest), ContractError::HighS {}),
        (
            HexBinary::from(&good[..63]),
            ContractError::BadSignatureLength { got: 63 },
        ),
        (
            HexBinary::from([&good[..], &[0u8]].concat()),
            ContractError::BadSignatureLength { got: 65 },
        ),
        (
            HexBinary::from(Vec::<u8>::new()),
            ContractError::BadSignatureLength { got: 0 },
        ),
        (
            HexBinary::from(vec![0u8; 64]),
            ContractError::InvalidSignature {},
        ),
        (
            HexBinary::from(vec![1u8; 64]),
            ContractError::InvalidSignature {},
        ),
        // Another payload's signature.
        (
            s.signer.sign(&Suite::settle_digest(&s.checkpoint_payload(
                id,
                61,
                &[5, 6, 7],
            ))),
            ContractError::InvalidSignature {},
        ),
        // The right bytes without the SETTLE tag (domain separation).
        (
            s.signer.sign(&sha256(&[&p.encode().unwrap()])),
            ContractError::InvalidSignature {},
        ),
        // A consent-style signature over the same payload.
        (
            s.signer.sign(&s.consent_digest(id, &p)),
            ContractError::InvalidSignature {},
        ),
        // r and s swapped.
        (
            HexBinary::from([&good[32..], &good[..32]].concat()),
            ContractError::InvalidSignature {},
        ),
    ];
    for (sig, expected) in cases {
        let got = submit(&mut s, id, w.clone(), sig.clone());
        match (&got, &expected) {
            // Swapping r and s can produce a high-s value; either refusal is fine.
            (Err(ContractError::HighS {}), ContractError::InvalidSignature {}) => {}
            _ => assert_eq!(got.unwrap_err(), expected, "signature {sig}"),
        }
    }
    assert_untouched(&s, id, 0);
    submit(&mut s, id, w, HexBinary::from(good.as_slice())).unwrap();
    assert_eq!(s.last_seq(id), 120);
}

#[test]
fn signer_key_id_must_name_the_registered_signing_key() {
    let mut s = Suite::new();
    let id = s.started(2);
    // Unknown id.
    let mut p = s.checkpoint_payload(id, 10, &[1, 1]);
    p.signer_key_id = 7;
    assert_eq!(
        sign_and_submit(&mut s, id, &p).unwrap_err(),
        ContractError::UnknownSignerKey { key_id: 7 }
    );
    // Key 2 exists, but the payload claims key 2 while key 1 signed.
    let key2 = Key::signer(2);
    assert_eq!(s.add_key(&key2), 2);
    p.signer_key_id = 2;
    assert_eq!(
        sign_and_submit(&mut s, id, &p).unwrap_err(),
        ContractError::InvalidSignature {}
    );
    // Claims key 1 while key 2 signed.
    let mut q = s.checkpoint_payload(id, 10, &[1, 1]);
    q.signer_key_id = 1;
    let (w, sig) = s.signed_by(&q, &key2);
    assert_eq!(
        submit(&mut s, id, w, sig).unwrap_err(),
        ContractError::InvalidSignature {}
    );
    // Key 2 signing as key 2 is accepted.
    let (w, sig) = s.signed_by(&p, &key2);
    submit(&mut s, id, w, sig).unwrap();
    assert_eq!(s.last_seq(id), 20);
}

#[test]
fn retired_signers_are_refused_and_other_keys_keep_working() {
    let mut s = Suite::new();
    let id = s.started(2);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    s.retire_key(1, false);
    let p = s.checkpoint_payload(id, 10, &[1, 1]);
    assert_eq!(
        sign_and_submit(&mut s, id, &p).unwrap_err(),
        ContractError::RetiredSignerKey { key_id: 1 }
    );
    s.retire_key(1, true);
    assert_eq!(
        sign_and_submit(&mut s, id, &p).unwrap_err(),
        ContractError::RetiredSignerKey { key_id: 1 }
    );
    let mut q = p.clone();
    q.signer_key_id = 2;
    let (w, sig) = s.signed_by(&q, &key2);
    submit(&mut s, id, w, sig).unwrap();
}

#[test]
fn domain_and_fixed_length_fields_must_be_exact() {
    let mut s = Suite::new();
    let a = s.started(2);
    let b = s.started(2); // same wallets, another chain_game_id
    assert_ne!(s.domain(a), s.domain(b));
    let p_b = s.checkpoint_payload(b, 10, &[1, 1]);
    assert_eq!(
        sign_and_submit(&mut s, a, &p_b).unwrap_err(),
        ContractError::DomainMismatch {}
    );
    let mut zero = s.checkpoint_payload(a, 10, &[1, 1]);
    zero.domain = [0u8; 32];
    assert_eq!(
        sign_and_submit(&mut s, a, &zero).unwrap_err(),
        ContractError::DomainMismatch {}
    );

    let p = s.checkpoint_payload(a, 10, &[1, 1]);
    let (w, sig) = s.signed(&p);
    let cut = |bytes: &HexBinary, len: usize| HexBinary::from(&bytes.as_slice()[..len]);
    let long = |bytes: &HexBinary| HexBinary::from([bytes.as_slice(), &[0u8]].concat());
    let mut cases: Vec<(SettlementPayloadV1, &str, usize)> = Vec::new();
    let mut x = w.clone();
    x.domain = cut(&w.domain, 31);
    cases.push((x, "payload.domain", 31));
    let mut x = w.clone();
    x.domain = long(&w.domain);
    cases.push((x, "payload.domain", 33));
    let mut x = w.clone();
    x.log_hash = cut(&w.log_hash, 0);
    cases.push((x, "payload.log_hash", 0));
    let mut x = w.clone();
    x.log_hash = long(&w.log_hash);
    cases.push((x, "payload.log_hash", 33));
    let mut x = w.clone();
    x.appraisal_state_hash = cut(&w.appraisal_state_hash, 16);
    cases.push((x, "payload.appraisal_state_hash", 16));
    for (wire, field, got) in cases {
        assert_eq!(
            submit(&mut s, a, wire, sig.clone()).unwrap_err(),
            ContractError::BadLength {
                field: field.to_string(),
                expected: 32,
                got
            }
        );
    }
    assert_untouched(&s, a, 0);
}

#[test]
fn weight_vector_must_match_the_roster() {
    let mut s = Suite::new();
    let id = s.started(3);
    for weights in [vec![1u128, 1], vec![1, 1, 1, 1], vec![1; 7]] {
        let p = s.checkpoint_payload(id, 10, &weights);
        assert_eq!(
            sign_and_submit(&mut s, id, &p).unwrap_err(),
            ContractError::RosterLengthMismatch {
                expected: 3,
                got: weights.len()
            }
        );
    }
    // seat_count disagreeing with the vector.
    let p = s.checkpoint_payload(id, 10, &[1, 2, 3]);
    let (mut w, sig) = s.signed(&p);
    for seat_count in [0u8, 2, 4, 255] {
        w.seat_count = seat_count;
        assert_eq!(
            submit(&mut s, id, w.clone(), sig.clone()).unwrap_err(),
            ContractError::SeatCountMismatch {
                seat_count,
                weights: 3
            }
        );
    }
    let p = s.checkpoint_payload(id, 10, &[0, 0, 0]);
    assert_eq!(
        sign_and_submit(&mut s, id, &p).unwrap_err(),
        ContractError::ZeroSumWeights {}
    );
    assert_untouched(&s, id, 0);
    // A single non-zero weight and u128::MAX weights are both fine.
    let p = s.checkpoint_payload(id, 10, &[0, 0, 1]);
    sign_and_submit(&mut s, id, &p).unwrap();
    let p = s.checkpoint_payload(id, 11, &[u128::MAX, u128::MAX, u128::MAX]);
    sign_and_submit(&mut s, id, &p).unwrap();
    assert_eq!(s.last_seq(id), 22);
}

#[test]
fn newer_checkpoints_supersede_per_key_and_the_newest_is_reported() {
    let mut s = Suite::new();
    let id = s.started(2);
    let key2 = Key::signer(2);
    s.add_key(&key2);
    s.post_checkpoint(id, 100, &[1, 1]);
    let mut q = s.checkpoint_payload(id, 150, &[2, 1]);
    q.signer_key_id = 2;
    let (w, sig) = s.signed_by(&q, &key2);
    submit(&mut s, id, w, sig).unwrap();
    s.post_checkpoint(id, 200, &[1, 3]);

    let cps = s.checkpoints(id);
    let seqs: Vec<u64> = cps
        .checkpoints
        .iter()
        .map(|c| c.checkpoint.payload.seq.u64())
        .collect();
    assert_eq!(seqs, vec![400, 300], "one per key, newest first");
    assert_eq!(cps.liveness_candidate_seq, Some(Uint64::new(400)));
    assert_eq!(s.game(id).latest_checkpoint.unwrap().payload.seq.u64(), 400);
    assert!(cps.checkpoints.iter().all(|c| !c.signer_key_retired));

    // Retiring key 1 as compromised: the liveness candidate falls back to key 2.
    s.retire_key(1, true);
    let cps = s.checkpoints(id);
    assert_eq!(cps.liveness_candidate_seq, Some(Uint64::new(300)));
    let first = &cps.checkpoints[0];
    assert_eq!(first.checkpoint.payload.signer_key_id, 1);
    assert!(first.signer_key_retired && first.signer_key_compromised);
    let second = &cps.checkpoints[1];
    assert!(!second.signer_key_retired && !second.signer_key_compromised);
    // The newest checkpoint is still reported as the latest one.
    assert_eq!(s.game(id).latest_checkpoint.unwrap().payload.seq.u64(), 400);
}

#[test]
fn refused_while_paused_outside_in_progress_or_with_funds() {
    let mut s = Suite::new();
    let id = s.started(2);
    s.pause();
    let p = s.checkpoint_payload(id, 10, &[1, 1]);
    assert_eq!(
        sign_and_submit(&mut s, id, &p).unwrap_err(),
        ContractError::Paused {}
    );
    s.unpause();
    let msg = s.checkpoint_msg(id, &p);
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &msg, &coins(1, DENOM)).unwrap_err(),
        ContractError::NonPayable {}
    );
    s.exec(&who, &msg, &[]).unwrap();

    let funded = s.funded(2);
    let err = s
        .exec(
            &who,
            &ExecuteMsg::Checkpoint {
                chain_game_id: funded,
                payload: Suite::wire(&p),
                signature: HexBinary::from(vec![0u8; 64]),
            },
            &[],
        )
        .unwrap_err();
    assert_eq!(
        err,
        ContractError::WrongState {
            expected: "in_progress".to_string(),
            actual: "funded".to_string()
        }
    );
    let (settleable, _) = s.settleable(2);
    let q = s.checkpoint_payload(settleable, 300, &[1, 1]);
    let msg = s.checkpoint_msg(settleable, &q);
    assert!(matches!(
        s.exec(&who, &msg, &[]).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::Checkpoint {
                chain_game_id: 404,
                payload: Suite::wire(&p),
                signature: HexBinary::from(vec![0u8; 64]),
            },
            &[],
        )
        .unwrap_err(),
        ContractError::GameNotFound { chain_game_id: 404 }
    );
}

#[test]
fn every_single_field_mutation_of_a_signed_payload_is_refused() {
    let mut s = Suite::new();
    let id = s.started(3);
    let p = s.checkpoint_payload(id, 77, &[10, 20, 30]);
    let (w, sig) = s.signed(&p);
    let mut mutants: Vec<(&str, SettlementPayloadV1)> = Vec::new();
    let flip = |bytes: &HexBinary| {
        let mut v = bytes.to_vec();
        v[31] ^= 1;
        HexBinary::from(v)
    };
    macro_rules! mutant {
        ($name:expr, |$x:ident| $body:expr) => {{
            let mut $x = w.clone();
            $body;
            mutants.push(($name, $x));
        }};
    }
    mutant!("version", |x| x.version = 2);
    mutant!("domain", |x| x.domain = flip(&w.domain));
    mutant!("seq", |x| x.seq = Uint64::new(156));
    mutant!("kind", |x| x.kind = KIND_TERMINAL);
    mutant!("reason", |x| x.reason = 1);
    mutant!("log_len", |x| x.log_len = Uint64::new(78));
    mutant!("log_hash", |x| x.log_hash = flip(&w.log_hash));
    mutant!("appraisal_log_len", |x| x.appraisal_log_len =
        Uint64::new(76));
    mutant!("appraisal_state_hash", |x| x.appraisal_state_hash =
        flip(&w.appraisal_state_hash));
    mutant!("state_schema_version", |x| x.state_schema_version = 2);
    mutant!("seat_count", |x| x.seat_count = 2);
    mutant!("weight", |x| x.settlement_weights[0] = Uint128::new(11));
    mutant!("weight order", |x| x.settlement_weights.swap(0, 2));
    mutant!("signer_key_id", |x| x.signer_key_id = 2);
    mutant!("issued_at", |x| x.issued_at = Uint64::new(p.issued_at + 1));
    // Consistent (shape-valid) edits: only the signature can catch these.
    mutant!("seq+log_len+appraisal", |x| {
        x.seq = Uint64::new(156);
        x.log_len = Uint64::new(78);
        x.appraisal_log_len = Uint64::new(78);
    });
    mutant!("weights scaled", |x| {
        x.settlement_weights = vec![Uint128::new(20), Uint128::new(40), Uint128::new(60)];
    });
    assert_eq!(mutants.len(), 17);
    for (name, wire) in mutants {
        let err = submit(&mut s, id, wire, sig.clone());
        assert!(err.is_err(), "mutation of {name} was accepted");
    }
    assert_untouched(&s, id, 0);
    submit(&mut s, id, w, sig).unwrap();
    assert_eq!(s.last_seq(id), 154);
}

#[test]
fn every_bit_flip_of_the_encoded_payload_is_refused_on_chain() {
    let mut s = Suite::new();
    let id = s.started(3);
    let p = s.checkpoint_payload(id, 88, &[1, 2, 3]);
    let bytes = p.encode().unwrap();
    assert_eq!(bytes.len(), 136 + 16 * 3);
    let sig = s.signer.sign(&Suite::settle_digest(&p));
    let mut undecodable = Vec::new();
    for i in 0..bytes.len() {
        for bit in [0u8, 7] {
            let mut altered = bytes.clone();
            altered[i] ^= 1 << bit;
            match Payload::decode(&altered) {
                Ok(q) => {
                    let err = submit(&mut s, id, Suite::wire(&q), sig.clone());
                    assert!(err.is_err(), "byte {i} bit {bit} accepted");
                }
                Err(_) => undecodable.push(i),
            }
        }
    }
    // Only the version byte (0) and the seat-count byte (125) cannot be
    // re-read at all; the wire forms of those are covered above.
    undecodable.dedup();
    assert_eq!(undecodable, vec![0, 125]);
    assert_untouched(&s, id, 0);
    // The re-encoded wire form is what the contract hashes: sign the digest of
    // a JSON rendering instead and it fails.
    let json = cosmwasm_std::to_json_vec(&Suite::wire(&p)).unwrap();
    let wrong = s.signer.sign(&crypto::settle_digest(&json));
    assert_eq!(
        submit(&mut s, id, Suite::wire(&p), wrong).unwrap_err(),
        ContractError::InvalidSignature {}
    );
    submit(&mut s, id, Suite::wire(&p), sig).unwrap();
}
