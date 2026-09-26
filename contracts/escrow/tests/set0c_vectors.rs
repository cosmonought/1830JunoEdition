//! SET-0C cross-language conformance, pinned on the Rust side.
//!
//! `frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json`
//! is written by the TypeScript settlement builder (`buildSettlementPayloadV1`,
//! through `frontend/src/utils/settlementPayloadGoldens.test.ts`) from the
//! SET-0A rev 2 golden boards. Every value in it is re-derived here with the
//! contract's own code: the settlement domains and roster hashes
//! (`crypto::settlement_domain`, `crypto::roster_hash`), the 136 + 16·n payload
//! bytes (`Payload::encode` / `Payload::decode`), the SETTLE and CONSENT
//! digests, the kind / reason / seq / A1 shape rules for the declared message
//! and no other, the proportional payouts and dust (`payout::proportional_split`)
//! and the contract's JSON form of the payload.
//!
//! The mutation table mirrors, case for case and with the same expected
//! outcome, the wire-representable cases that
//! `frontend/src/utils/settlementPayloadMutation.test.ts` judges with
//! `checkSettlementPayloadV1`, so the contract and the TypeScript rules refuse
//! the same inputs under the same name. The decoder test pins the refusal
//! wording TypeScript copies and classifies every single-byte alteration of
//! every Python and TypeScript vector.
//!
//! Only files inside the repository are read (through `include_str!`), and
//! nothing depends on the environment or on test order.

use cosmwasm_std::{HexBinary, Uint128, Uint64};
use eighteen_cosmos_escrow::crypto::{self, DomainInputs};
use eighteen_cosmos_escrow::helpers::{MAX_PLAYERS, MIN_PLAYERS};
use eighteen_cosmos_escrow::msg::SettlementPayloadV1;
use eighteen_cosmos_escrow::payload::{Payload, PayloadUse};
use eighteen_cosmos_escrow::payout::{proportional_split, weights_have_positive_sum};
use eighteen_cosmos_escrow::ContractError;
use serde_json::Value;

/// The TypeScript-generated SET-0C vectors.
fn set0c() -> Value {
    serde_json::from_str(include_str!(
        "../../../frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json"
    ))
    .unwrap()
}

/// The independent Python vectors (also read by `tests/vectors.rs`).
fn python_vectors() -> Value {
    serde_json::from_str(include_str!("../testdata/payload_vectors_v1.json")).unwrap()
}

fn hex(v: &Value) -> Vec<u8> {
    HexBinary::from_hex(v.as_str().unwrap()).unwrap().to_vec()
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn wire_of(doc: &Value, name: &str) -> SettlementPayloadV1 {
    let v = doc["payload_vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == name)
        .unwrap_or_else(|| panic!("no vector {name}"));
    serde_json::from_value(v["payload"].clone()).unwrap()
}

fn usage(s: &str) -> PayloadUse {
    match s {
        "Checkpoint" => PayloadUse::Checkpoint,
        "Settle" => PayloadUse::Settle,
        "ResolverReplace" => PayloadUse::ResolverReplace,
        other => panic!("unknown usage {other}"),
    }
}

const USES: [PayloadUse; 3] = [
    PayloadUse::Checkpoint,
    PayloadUse::Settle,
    PayloadUse::ResolverReplace,
];

/// The TypeScript `SettlementPayloadError` code for the same refusal.
fn code(e: &ContractError) -> &'static str {
    match e {
        ContractError::BadVersion { .. } => "BAD_VERSION",
        ContractError::BadKind { .. } => "BAD_KIND",
        ContractError::UnknownReason { .. } => "UNKNOWN_REASON",
        ContractError::ReasonNotAllowed { .. } => "REASON_NOT_ALLOWED",
        ContractError::WrongKind { .. } => "WRONG_KIND",
        ContractError::BadSeq { .. } => "BAD_SEQ",
        ContractError::BadAppraisalLogLen { .. } => "BAD_APPRAISAL_LOG_LEN",
        ContractError::SeatCountMismatch { .. } => "SEAT_COUNT_MISMATCH",
        ContractError::BadLength { .. } => "BAD_LENGTH",
        ContractError::ZeroSumWeights {} => "SETTLEMENT_ZERO_SUM",
        ContractError::MalformedPayload { .. } => "MALFORMED_PAYLOAD",
        other => panic!("no TypeScript code for {other:?}"),
    }
}

/// Every game-independent payload rule, in the contract's order: the wire
/// conversion (`TryFrom`), `check_shape` for the message, the 2..=7 roster
/// bound, then Σ weights > 0. TypeScript's `checkSettlementPayloadV1` applies
/// the same rules in the same order.
fn judge(wire: &SettlementPayloadV1, u: PayloadUse) -> &'static str {
    let p = match Payload::try_from(wire) {
        Ok(p) => p,
        Err(e) => return code(&e),
    };
    if let Err(e) = p.check_shape(u) {
        return code(&e);
    }
    let n = p.settlement_weights.len();
    if n < MIN_PLAYERS as usize || n > MAX_PLAYERS as usize {
        return "BAD_SEAT_COUNT";
    }
    if !weights_have_positive_sum(&wire.settlement_weights).unwrap() {
        return "SETTLEMENT_ZERO_SUM";
    }
    "OK"
}

#[test]
fn set0c_domains_and_roster_hashes_rederive_in_rust() {
    let doc = set0c();
    let domains = doc["domains"].as_array().unwrap();
    for d in domains {
        let name = text(&d["name"]);
        let wallets: Vec<String> = d["roster_wallets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| text(w).to_string())
            .collect();
        let roster = crypto::roster_hash(&wallets).unwrap();
        assert_eq!(
            roster.to_vec(),
            hex(&d["roster_hash"]),
            "{name}: roster hash"
        );
        let domain = crypto::settlement_domain(&DomainInputs {
            chain_id: text(&d["chain_id"]),
            contract_addr: text(&d["contract_addr"]),
            chain_game_id: text(&d["chain_game_id"]).parse().unwrap(),
            roster_hash: roster,
            rules_engine_version: d["rules_engine_version"].as_u64().unwrap() as u32,
            variants_digest: hex(&d["variants_digest"]).try_into().unwrap(),
            ante_gross: text(&d["ante_gross"]).parse().unwrap(),
            mode: d["mode"].as_u64().unwrap() as u8,
        })
        .unwrap();
        assert_eq!(domain.to_vec(), hex(&d["domain"]), "{name}: domain");
    }
    assert_eq!(domains.len(), 5);
}

#[test]
fn set0c_payload_vectors_rederive_in_rust() {
    let doc = set0c();
    let domains = doc["domains"].as_array().unwrap();
    let vectors = doc["payload_vectors"].as_array().unwrap();
    for v in vectors {
        let name = text(&v["name"]);
        let wire: SettlementPayloadV1 = serde_json::from_value(v["payload"].clone()).unwrap();

        // The payload is bound to the domain it names.
        let domain = domains
            .iter()
            .find(|d| d["name"] == v["domain_name"])
            .unwrap_or_else(|| panic!("{name}: no domain {}", v["domain_name"]));
        assert_eq!(
            wire.domain.to_vec(),
            hex(&domain["domain"]),
            "{name}: domain binding"
        );
        assert_eq!(
            wire.settlement_weights.len(),
            domain["roster_wallets"].as_array().unwrap().len(),
            "{name}: roster length"
        );

        // Bytes, decode, digests.
        let p = Payload::try_from(&wire).unwrap();
        let enc = p.encode().unwrap();
        assert_eq!(
            enc.len(),
            136 + 16 * p.settlement_weights.len(),
            "{name}: length"
        );
        assert_eq!(
            enc.len() as u64,
            v["encoded_len"].as_u64().unwrap(),
            "{name}: encoded_len"
        );
        assert_eq!(enc, hex(&v["encoded"]), "{name}: bytes");
        assert_eq!(Payload::decode(&enc).unwrap(), p, "{name}: decode");
        let settle = crypto::settle_digest(&enc);
        assert_eq!(
            settle.to_vec(),
            hex(&v["settle_digest"]),
            "{name}: SETTLE digest"
        );
        assert_eq!(
            crypto::consent_digest(&p.domain, p.seq, &settle).to_vec(),
            hex(&v["consent_digest"]),
            "{name}: CONSENT digest"
        );

        // Shape: accepted for the declared message and refused for the others.
        let declared = usage(text(&v["usage"]));
        for u in USES {
            let outcome = judge(&wire, u);
            if u == declared {
                assert_eq!(outcome, "OK", "{name}: rules for {u:?}");
            } else {
                assert_ne!(outcome, "OK", "{name}: accepted for {u:?}");
            }
        }

        // Payouts and dust.
        let pool = Uint128::new(text(&v["pool_ujuno"]).parse().unwrap());
        let split = proportional_split(pool, &wire.settlement_weights).unwrap();
        let want: Vec<Uint128> = v["payouts_ujuno"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| Uint128::new(text(x).parse().unwrap()))
            .collect();
        assert_eq!(split.amounts, want, "{name}: payouts");
        assert_eq!(
            split.dust.u128().to_string(),
            text(&v["dust_ujuno"]),
            "{name}: dust"
        );
        let paid = split.amounts.iter().fold(Uint128::zero(), |a, b| a + *b);
        assert_eq!(paid + split.dust, pool, "{name}: conservation");

        // The contract's JSON form is the TypeScript wire form.
        let back: Value =
            serde_json::from_slice(&cosmwasm_std::to_json_vec(&wire).unwrap()).unwrap();
        assert_eq!(back, v["payload"], "{name}: wire JSON");
    }
    assert_eq!(vectors.len(), 15);
}

fn plus(x: Uint64, delta: i64) -> Uint64 {
    Uint64::new(x.u64().checked_add_signed(delta).unwrap())
}

fn flip(h: &HexBinary, at: usize) -> HexBinary {
    let mut bytes = h.to_vec();
    bytes[at] ^= 0x01;
    HexBinary::from(bytes)
}

struct Case {
    name: String,
    usage: PayloadUse,
    wire: SettlementPayloadV1,
    want: &'static str,
}

/// The wire-representable cases of `settlementPayloadMutation.test.ts`, in its
/// order, under its names, with the outcome it expects from
/// `checkSettlementPayloadV1`.
fn mutation_cases() -> Vec<Case> {
    use PayloadUse::{Checkpoint, ResolverReplace, Settle};
    let python = python_vectors();
    let sentinel = wire_of(&python, "two-seat-byte-order-sentinel");
    let forfeit = wire_of(&python, "three-seat-forfeit-earlier-appraisal");
    let golden_7 = wire_of(&set0c(), "SYN-12-SEVEN-PLAYERS-LPF/terminal-BankBroken");

    let mut cases = Vec::new();
    let mut add =
        |name: String, usage: PayloadUse, wire: SettlementPayloadV1, want: &'static str| {
            cases.push(Case {
                name,
                usage,
                wire,
                want,
            })
        };

    for (label, base) in [("sentinel", &sentinel), ("golden-7", &golden_7)] {
        let at_last = base.settlement_weights.len() - 1;
        let with = |f: &dyn Fn(&mut SettlementPayloadV1)| {
            let mut w = base.clone();
            f(&mut w);
            w
        };

        add(format!("{label}/base"), Settle, base.clone(), "OK");
        for at in [0, 17, 31] {
            let m = with(&|w| w.domain = flip(&base.domain, at));
            add(format!("{label}/domain-byte-{at}"), Settle, m, "OK");
        }
        for delta in [1i64, 2, -1] {
            let m = with(&|w| w.seq = plus(base.seq, delta));
            let sign = if delta > 0 { "+" } else { "" };
            add(format!("{label}/seq{sign}{delta}"), Settle, m, "BAD_SEQ");
        }
        for kind in [2u8, 255] {
            add(
                format!("{label}/kind-{kind}"),
                Settle,
                with(&|w| w.kind = kind),
                "BAD_KIND",
            );
        }
        add(
            format!("{label}/kind-0-reason-1"),
            Checkpoint,
            with(&|w| w.kind = 0),
            "REASON_NOT_ALLOWED",
        );
        add(
            format!("{label}/as-checkpoint-message"),
            Checkpoint,
            base.clone(),
            "WRONG_KIND",
        );
        let checkpoint = with(&|w| {
            w.kind = 0;
            w.reason = 0;
            w.seq = plus(base.seq, -1);
        });
        add(
            format!("{label}/checkpoint-ok"),
            Checkpoint,
            checkpoint.clone(),
            "OK",
        );
        add(
            format!("{label}/checkpoint-via-settle"),
            Settle,
            checkpoint.clone(),
            "WRONG_KIND",
        );
        let mut odd = checkpoint.clone();
        odd.seq = base.seq;
        add(
            format!("{label}/checkpoint-odd-seq"),
            Checkpoint,
            odd,
            "BAD_SEQ",
        );
        for reason in [6u8, 200, 255] {
            let m = with(&|w| w.reason = reason);
            add(
                format!("{label}/reason-{reason}"),
                Settle,
                m,
                "UNKNOWN_REASON",
            );
        }
        add(
            format!("{label}/reason-0-terminal"),
            Settle,
            with(&|w| w.reason = 0),
            "REASON_NOT_ALLOWED",
        );
        add(
            format!("{label}/reason-5-via-settle"),
            Settle,
            with(&|w| w.reason = 5),
            "REASON_NOT_ALLOWED",
        );
        add(
            format!("{label}/reason-5-via-replace"),
            ResolverReplace,
            with(&|w| w.reason = 5),
            "OK",
        );
        add(
            format!("{label}/reason-1-via-replace"),
            ResolverReplace,
            base.clone(),
            "REASON_NOT_ALLOWED",
        );
        add(
            format!("{label}/reason-2"),
            Settle,
            with(&|w| w.reason = 2),
            "OK",
        );
        let longer = with(&|w| w.log_len = plus(base.log_len, 1));
        add(
            format!("{label}/log_len+1"),
            Settle,
            longer.clone(),
            "BAD_SEQ",
        );
        let mut follows = longer;
        follows.seq = plus(base.seq, 2);
        add(
            format!("{label}/log_len+1-seq-follows"),
            Settle,
            follows,
            "BAD_APPRAISAL_LOG_LEN",
        );
        let m = with(&|w| w.log_hash = flip(&base.log_hash, 9));
        add(format!("{label}/log_hash-byte"), Settle, m, "OK");
        for delta in [-1i64, 1] {
            let m = with(&|w| w.appraisal_log_len = plus(base.appraisal_log_len, delta));
            let sign = if delta > 0 { "+" } else { "" };
            add(
                format!("{label}/appraisal_log_len{sign}{delta}"),
                Settle,
                m,
                "BAD_APPRAISAL_LOG_LEN",
            );
        }
        let m = with(&|w| w.state_schema_version ^= 0x0101);
        add(format!("{label}/state_schema_version"), Settle, m, "OK");
        let m = with(&|w| {
            let x = w.settlement_weights[at_last];
            w.settlement_weights[at_last] = if x == Uint128::MAX {
                x - Uint128::one()
            } else {
                x + Uint128::one()
            };
        });
        add(format!("{label}/weight-{at_last}"), Settle, m, "OK");
        let m = with(&|w| {
            w.settlement_weights
                .iter_mut()
                .for_each(|x| *x = Uint128::zero())
        });
        add(
            format!("{label}/all-zero-weights"),
            Settle,
            m,
            "SETTLEMENT_ZERO_SUM",
        );
        let m = with(&|w| w.signer_key_id ^= 0x0001);
        add(format!("{label}/signer_key_id"), Settle, m, "OK");
        let m = with(&|w| w.issued_at = plus(base.issued_at, 1));
        add(format!("{label}/issued_at+1"), Settle, m, "OK");
    }

    // Forfeit and Clemency may appraise an earlier board, never a later one.
    let f = |g: &dyn Fn(&mut SettlementPayloadV1)| {
        let mut w = forfeit.clone();
        g(&mut w);
        w
    };
    add("forfeit/earlier".into(), Settle, forfeit.clone(), "OK");
    add(
        "forfeit/appraisal-0".into(),
        Settle,
        f(&|w| w.appraisal_log_len = Uint64::zero()),
        "OK",
    );
    add(
        "forfeit/appraisal-equal".into(),
        Settle,
        f(&|w| w.appraisal_log_len = forfeit.log_len),
        "OK",
    );
    add(
        "forfeit/appraisal-later".into(),
        Settle,
        f(&|w| w.appraisal_log_len = plus(forfeit.log_len, 1)),
        "BAD_APPRAISAL_LOG_LEN",
    );
    add(
        "clemency/earlier".into(),
        Settle,
        f(&|w| w.reason = 4),
        "OK",
    );

    // The contract's 2..=7 roster bound.
    let mut one = sentinel.clone();
    one.seat_count = 1;
    one.settlement_weights = vec![Uint128::new(5)];
    add("n=1".into(), Settle, one, "BAD_SEAT_COUNT");
    let mut eight = sentinel.clone();
    eight.seat_count = 8;
    eight.settlement_weights = vec![Uint128::one(); 8];
    add("n=8".into(), Settle, eight, "BAD_SEAT_COUNT");

    cases
}

#[test]
fn set0c_mutation_outcomes_match_typescript() {
    let cases = mutation_cases();
    let mut names: Vec<&str> = cases.iter().map(|c| c.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), cases.len(), "case names are unique");
    let mismatches: Vec<String> = cases
        .iter()
        .filter_map(|c| {
            let got = judge(&c.wire, c.usage);
            (got != c.want).then(|| format!("{}: Rust {got}, TypeScript {}", c.name, c.want))
        })
        .collect();
    assert!(mismatches.is_empty(), "{mismatches:#?}");
    let refused = cases.iter().filter(|c| c.want != "OK").count();
    assert_eq!((cases.len(), refused), (71, 43));
}

#[test]
fn set0c_decoder_refusals_and_single_byte_classification() {
    let python = python_vectors();
    let v = python["payload_vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "two-seat-checkpoint")
        .unwrap();
    let bytes = hex(&v["encoded"]);

    // The refusal wording `decodeSettlementPayloadV1` copies.
    let msg = |b: &[u8]| match Payload::decode(b) {
        Ok(_) => "OK".to_string(),
        Err(ContractError::MalformedPayload { reason }) => format!("MALFORMED_PAYLOAD: {reason}"),
        Err(ContractError::BadVersion { got }) => format!("BAD_VERSION: version {got}"),
        Err(e) => format!("{e:?}"),
    };
    assert_eq!(msg(&bytes), "OK");
    assert_eq!(msg(&bytes[..100]), "MALFORMED_PAYLOAD: truncated");
    assert_eq!(msg(&[]), "MALFORMED_PAYLOAD: truncated");
    let mut longer = bytes.clone();
    longer.push(0);
    assert_eq!(
        msg(&longer),
        "MALFORMED_PAYLOAD: 169 bytes for n = 2, expected exactly 168"
    );
    let mut n3 = bytes.clone();
    n3[125] = 3;
    assert_eq!(
        msg(&n3),
        "MALFORMED_PAYLOAD: 168 bytes for n = 3, expected exactly 184"
    );
    let mut v2 = bytes.clone();
    v2[0] = 2;
    assert_eq!(msg(&v2), "BAD_VERSION: version 2");

    // Every Python and TypeScript vector: a single-byte (^0x01) alteration is
    // refused by the decoder at exactly offsets 0 (version) and 125 (n), and
    // decodes (to a different payload, with a different SETTLE digest)
    // everywhere else; every strict prefix is refused.
    let mut all: Vec<Vec<u8>> = python["payload_vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| hex(&p["encoded"]))
        .collect();
    let python_count = all.len();
    all.extend(
        set0c()["payload_vectors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| hex(&p["encoded"])),
    );
    for enc in &all {
        let original = Payload::decode(enc).unwrap();
        let digest = crypto::settle_digest(enc);
        for i in 0..enc.len() {
            let mut a = enc.clone();
            a[i] ^= 0x01;
            match Payload::decode(&a) {
                Err(_) => assert!(i == 0 || i == 125, "refused at offset {i}"),
                Ok(p) => {
                    assert!(i != 0 && i != 125, "decoded at offset {i}");
                    assert_ne!(p, original, "offset {i}");
                    assert_ne!(crypto::settle_digest(&a), digest, "offset {i}");
                }
            }
        }
        for cut in 0..enc.len() {
            assert!(
                Payload::decode(&enc[..cut]).is_err(),
                "prefix of {cut} bytes"
            );
        }
    }
    assert_eq!((python_count, all.len()), (11, 26));
}
