//! Cross-language vectors: the contract's encoder, digests and signature checks
//! against `testdata/payload_vectors_v1.json`, which an independent Python
//! implementation (`testdata/gen_payload_vectors.py`) wrote from the frozen
//! specification. Every Python-signed payload that names a registered key is
//! also replayed on chain against a game whose domain equals the Python domain.

mod common;

use common::*;
use cosmwasm_std::testing::MockApi;
use cosmwasm_std::{coins, Addr, Api, HexBinary};
use cw_multi_test::Executor;
use eighteen_cosmos_escrow::crypto::{self, DomainInputs};
use eighteen_cosmos_escrow::msg::{ExecuteMsg, ResolveOutcome, SeatSignature, SettlementPayloadV1};
use eighteen_cosmos_escrow::payload::{Payload, FIXED_ENCODED_LEN, WEIGHT_ENCODED_LEN};
use eighteen_cosmos_escrow::state::{GameState, Mode};
use eighteen_cosmos_escrow::ContractError;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../testdata/payload_vectors_v1.json")).unwrap()
}

fn hex32(v: &Value) -> [u8; 32] {
    hex(v).try_into().unwrap()
}

fn hex(v: &Value) -> Vec<u8> {
    HexBinary::from_hex(v.as_str().unwrap()).unwrap().to_vec()
}

fn payload_vector<'a>(doc: &'a Value, name: &str) -> &'a Value {
    doc["payload_vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == name)
        .unwrap_or_else(|| panic!("no vector {name}"))
}

fn domain_vector<'a>(doc: &'a Value, name: &str) -> &'a Value {
    doc["domain_vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["name"] == name)
        .unwrap()
}

fn wire(v: &Value) -> SettlementPayloadV1 {
    serde_json::from_value(v["payload"].clone()).unwrap()
}

#[test]
fn format_and_counts() {
    let doc = vectors();
    assert_eq!(doc["format"], "18JUNO/ESCROW2/payload-vectors/v1");
    assert_eq!(doc["payload_vectors"].as_array().unwrap().len(), 11);
    assert_eq!(doc["roster_vectors"].as_array().unwrap().len(), 3);
    assert_eq!(doc["domain_vectors"].as_array().unwrap().len(), 5);
    assert_eq!(doc["annul_vectors"].as_array().unwrap().len(), 3);
}

#[test]
fn test_keys_match_the_python_keys() {
    let doc = vectors();
    assert_eq!(
        Key::signer(1).pubkey.to_vec(),
        hex(&doc["keys"]["signer"]["pubkey"])
    );
    for (i, seat) in doc["keys"]["seats"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            Key::seat(i).pubkey.to_vec(),
            hex(&seat["pubkey"]),
            "seat {i}"
        );
    }
}

#[test]
fn roster_hashes_match() {
    let doc = vectors();
    let api = cw_multi_test::addons::MockApiBech32::new("juno");
    for v in doc["roster_vectors"].as_array().unwrap() {
        let wallets: Vec<String> = v["wallets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            crypto::roster_hash(&wallets).unwrap(),
            hex32(&v["roster_hash"]),
            "{}",
            v["name"]
        );
    }
    // The Python bech32 reproduces the harness wallets exactly.
    let two: Vec<String> = doc["roster_vectors"][0]["wallets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        two,
        vec![
            api.addr_make("creator").to_string(),
            api.addr_make("alice").to_string()
        ]
    );
}

#[test]
fn domains_match() {
    let doc = vectors();
    for v in doc["domain_vectors"].as_array().unwrap() {
        let domain = crypto::settlement_domain(&DomainInputs {
            chain_id: v["chain_id"].as_str().unwrap(),
            contract_addr: v["contract_addr"].as_str().unwrap(),
            chain_game_id: v["chain_game_id"].as_u64().unwrap(),
            roster_hash: hex32(&v["roster_hash"]),
            rules_engine_version: v["rules_engine_version"].as_u64().unwrap() as u32,
            variants_digest: hex32(&v["variants_digest"]),
            ante_gross: v["ante_gross"].as_str().unwrap().parse().unwrap(),
            mode: v["mode"].as_u64().unwrap() as u8,
        })
        .unwrap();
        assert_eq!(domain, hex32(&v["domain"]), "{}", v["name"]);
    }
}

#[test]
fn payloads_encode_byte_for_byte_and_round_trip() {
    let doc = vectors();
    for v in doc["payload_vectors"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let payload = Payload::try_from(&wire(v)).unwrap();
        let encoded = payload.encode().unwrap();
        let n = payload.settlement_weights.len();
        assert_eq!(
            encoded.len(),
            FIXED_ENCODED_LEN + WEIGHT_ENCODED_LEN * n,
            "{name}"
        );
        assert_eq!(encoded.len(), 136 + 16 * n, "{name}");
        assert_eq!(
            encoded.len() as u64,
            v["encoded_len"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(encoded, hex(&v["encoded"]), "{name}: encoding");
        assert_eq!(
            Payload::decode(&encoded).unwrap(),
            payload,
            "{name}: decode"
        );
        let settle = crypto::settle_digest(&encoded);
        assert_eq!(settle, hex32(&v["settle_digest"]), "{name}: settle digest");
        let consent = crypto::consent_digest(&payload.domain, payload.seq, &settle);
        assert_eq!(
            consent,
            hex32(&v["consent_digest"]),
            "{name}: consent digest"
        );
        // The wire struct re-serialises to exactly the vector's JSON.
        let back: Value =
            serde_json::from_slice(&cosmwasm_std::to_json_vec(&wire(v)).unwrap()).unwrap();
        assert_eq!(back, v["payload"], "{name}: wire JSON");
    }
}

#[test]
fn byte_order_sentinel_lays_out_every_field_big_endian() {
    let doc = vectors();
    let v = payload_vector(&doc, "two-seat-byte-order-sentinel");
    let bytes = hex(&v["encoded"]);
    // Offsets of the fixed-width layout.
    assert_eq!(bytes[0], 1); // version
    assert_eq!(&bytes[41..42], &[1]); // kind
    assert_eq!(&bytes[42..43], &[1]); // reason
    assert_eq!(&bytes[43..51], &[1, 2, 3, 4, 5, 6, 7, 8]); // log_len
    assert_eq!(&bytes[83..91], &[1, 2, 3, 4, 5, 6, 7, 8]); // appraisal_log_len
    assert_eq!(&bytes[123..125], &[0x21, 0x22]); // state_schema_version
    assert_eq!(bytes[125], 2); // n
    let w0: Vec<u8> = (1..=16).collect();
    let w1: Vec<u8> = (0x11..=0x20).collect();
    assert_eq!(&bytes[126..142], w0.as_slice());
    assert_eq!(&bytes[142..158], w1.as_slice());
    assert_eq!(&bytes[158..160], &[0x31, 0x32]); // signer_key_id
    assert_eq!(
        &bytes[160..168],
        &[0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48]
    ); // issued_at
       // seq = 2·log_len + 1
    assert_eq!(
        &bytes[33..41],
        &(2u64 * 0x0102030405060708 + 1).to_be_bytes()
    );
}

#[test]
fn rfc6979_signatures_are_identical_and_verify() {
    let doc = vectors();
    let api = MockApi::default();
    let signer = Key::signer(1);
    for v in doc["payload_vectors"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let settle = hex32(&v["settle_digest"]);
        let python_sig = hex(&v["signer_signature"]);
        assert_eq!(
            signer.sign(&settle).to_vec(),
            python_sig,
            "{name}: signer signature"
        );
        assert!(crypto::is_low_s(&python_sig.clone().try_into().unwrap()));
        assert!(api
            .secp256k1_verify(&settle, &python_sig, signer.pubkey.as_slice())
            .unwrap());
        let consent = hex32(&v["consent_digest"]);
        for (i, sig) in v["consent_signatures"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            assert_eq!(
                Key::seat(i).sign(&consent).to_vec(),
                hex(sig),
                "{name}: seat {i}"
            );
        }
    }
    for v in doc["annul_vectors"].as_array().unwrap() {
        let domain = hex32(&domain_vector(&doc, v["domain_vector"].as_str().unwrap())["domain"]);
        let last_seq: u64 = v["last_seq"].as_str().unwrap().parse().unwrap();
        let digest = crypto::annul_digest(&domain, last_seq);
        assert_eq!(digest, hex32(&v["annul_digest"]));
        for (i, sig) in v["seat_signatures"].as_array().unwrap().iter().enumerate() {
            assert_eq!(
                Key::seat(i).sign(&digest).to_vec(),
                hex(sig),
                "annul seat {i}"
            );
        }
    }
}

/// Altering any single byte of any vector either breaks the fixed-width
/// structure or produces a different digest the pinned signature does not
/// verify; flipping any single bit always changes the digest.
#[test]
fn every_altered_byte_is_rejected() {
    let doc = vectors();
    let api = MockApi::default();
    let signer = Key::signer(1);
    let mut structural = 0usize;
    let mut signature = 0usize;
    for v in doc["payload_vectors"].as_array().unwrap() {
        let original = hex(&v["encoded"]);
        let original_digest = crypto::settle_digest(&original);
        let sig = hex(&v["signer_signature"]);
        for i in 0..original.len() {
            for bit in 0..8 {
                let mut altered = original.clone();
                altered[i] ^= 1 << bit;
                assert_ne!(crypto::settle_digest(&altered), original_digest);
            }
            let mut altered = original.clone();
            altered[i] ^= 0x01;
            match Payload::decode(&altered) {
                Err(_) => structural += 1,
                Ok(_) => {
                    let digest = crypto::settle_digest(&altered);
                    assert!(
                        !api.secp256k1_verify(&digest, &sig, signer.pubkey.as_slice())
                            .unwrap(),
                        "{} byte {i}",
                        v["name"]
                    );
                    signature += 1;
                }
            }
        }
    }
    assert!(structural > 0 && signature > 0);
}

/// Builds `target_id` as a real game on `suite`: filler games first so the
/// counter reaches `target_id`, then a funded and started game whose seat i is
/// `wallets[i]` with consent key `Key::seat(i)`.
fn onchain_game(
    suite: &mut Suite,
    wallets: &[Addr],
    target_id: u64,
    mode: Mode,
    ante: u128,
) -> u64 {
    let filler = suite.players[7].clone();
    while suite.config().next_chain_game_id < target_id {
        suite
            .exec(
                &filler,
                &Suite::create_msg(2, Mode::Live, 7),
                &coins(ANTE, DENOM),
            )
            .unwrap();
    }
    for w in wallets {
        if suite.balance(w) < ante {
            let rich = suite.outsider.clone();
            suite
                .app
                .send_tokens(rich, w.clone(), &coins(10 * ante, DENOM))
                .unwrap();
        }
    }
    let create = ExecuteMsg::CreateGame {
        max_players: wallets.len() as u8,
        mode,
        rules_engine_version: RULES_ENGINE_VERSION,
        variants_digest: HexBinary::from(sha256(&[b"18JUNO/TEST/variants"]).as_slice()),
        consent_pubkey: Key::seat(0).pubkey,
        join_ticket: ticket("vector-0"),
    };
    suite
        .exec(&wallets[0], &create, &coins(ante, DENOM))
        .unwrap();
    let id = target_id;
    for (i, w) in wallets.iter().enumerate().skip(1) {
        let join = ExecuteMsg::Join {
            chain_game_id: id,
            consent_pubkey: Key::seat(i).pubkey,
            join_ticket: ticket(&format!("vector-{i}")),
        };
        suite.exec(w, &join, &coins(ante, DENOM)).unwrap();
    }
    suite.start(id);
    id
}

fn roster(doc: &Value, name: &str) -> Vec<Addr> {
    doc["roster_vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap()["wallets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| Addr::unchecked(w.as_str().unwrap()))
        .collect()
}

fn python_consents(v: &Value) -> Vec<SeatSignature> {
    v["consent_signatures"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, s)| SeatSignature {
            seat_index: i as u8,
            signature: HexBinary::from(hex(s)),
        })
        .collect()
}

fn python_settle(v: &Value, id: u64, consents: Vec<SeatSignature>) -> ExecuteMsg {
    ExecuteMsg::Settle {
        chain_game_id: id,
        payload: wire(v),
        signature: HexBinary::from(hex(&v["signer_signature"])),
        consents,
    }
}

fn python_checkpoint(v: &Value, id: u64) -> ExecuteMsg {
    ExecuteMsg::Checkpoint {
        chain_game_id: id,
        payload: wire(v),
        signature: HexBinary::from(hex(&v["signer_signature"])),
    }
}

fn outcome_amounts(suite: &Suite, id: u64) -> (Vec<u128>, u128) {
    let o = suite.game(id).game.outcome.unwrap();
    (o.amounts.iter().map(|a| a.u128()).collect(), o.dust.u128())
}

#[test]
fn onchain_two_seat_domain_and_python_signed_payloads() {
    let doc = vectors();
    let mut s = Suite::new();
    let dv = domain_vector(&doc, "mainnet-two-seat-live");
    assert_eq!(s.contract.as_str(), dv["contract_addr"].as_str().unwrap());
    let wallets = roster(&doc, "two-seat");
    let id = onchain_game(&mut s, &wallets, 1, Mode::Live, ANTE);
    assert_eq!(s.domain(id), hex32(&dv["domain"]));
    assert_eq!(
        s.game(id).game.roster_hash.unwrap().to_vec(),
        hex(&dv["roster_hash"])
    );

    // Python-signed checkpoint accepted as is.
    let cp = payload_vector(&doc, "two-seat-checkpoint");
    let who = s.outsider.clone();
    s.exec(&who, &python_checkpoint(cp, id), &[]).unwrap();
    assert_eq!(s.last_seq(id), 240);

    // Python-signed terminal with both Python consents: fast path.
    let t = payload_vector(&doc, "two-seat-terminal-bankbroken");
    s.exec(&who, &python_settle(t, id, python_consents(t)), &[])
        .unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    assert_eq!(outcome_amounts(&s, id), (vec![1_914_195, 1_985_804], 1));
    s.assert_custody();
}

#[test]
fn onchain_python_payload_is_refused_on_another_game_or_chain() {
    let doc = vectors();
    // Game 2 with the same roster has its own domain.
    let mut s = Suite::new();
    let wallets = roster(&doc, "two-seat");
    onchain_game(&mut s, &wallets, 1, Mode::Live, ANTE);
    let id2 = onchain_game(&mut s, &wallets, 2, Mode::Live, ANTE);
    assert_eq!(
        s.domain(id2),
        hex32(&domain_vector(&doc, "mainnet-two-seat-live-game-2")["domain"])
    );
    let cp = payload_vector(&doc, "two-seat-checkpoint");
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(&who, &python_checkpoint(cp, id2), &[]).unwrap_err(),
        ContractError::DomainMismatch {}
    );

    // Same contract address and game id on the testnet chain id: another domain.
    let mut t = SuiteBuilder::default().chain_id(TESTNET).build();
    assert_eq!(t.contract, s.contract);
    let id = onchain_game(&mut t, &wallets, 1, Mode::Live, ANTE);
    assert_eq!(
        t.domain(id),
        hex32(&domain_vector(&doc, "testnet-two-seat-live")["domain"])
    );
    assert_ne!(t.domain(id), s.domain(1));
    let who = t.outsider.clone();
    assert_eq!(
        t.exec(&who, &python_checkpoint(cp, id), &[]).unwrap_err(),
        ContractError::DomainMismatch {}
    );
}

#[test]
fn onchain_two_seat_max_u128_weights() {
    let doc = vectors();
    let mut s = Suite::new();
    let id = onchain_game(&mut s, &roster(&doc, "two-seat"), 1, Mode::Live, ANTE);
    let v = payload_vector(&doc, "two-seat-max-u128-weights");
    let who = s.outsider.clone();
    s.exec(&who, &python_settle(v, id, python_consents(v)), &[])
        .unwrap();
    assert_eq!(outcome_amounts(&s, id), (vec![1_950_000, 1_950_000], 0));
    s.assert_custody();
}

fn three_seat_async(s: &mut Suite, doc: &Value) -> u64 {
    let id = onchain_game(s, &roster(doc, "three-seat"), 7, Mode::Async, 5_000_000);
    assert_eq!(
        s.domain(id),
        hex32(&domain_vector(doc, "mainnet-three-seat-async")["domain"])
    );
    id
}

#[test]
fn onchain_bankruptcy_then_resolver_correction() {
    let doc = vectors();
    let mut s = Suite::new();
    let id = three_seat_async(&mut s, &doc);
    let who = s.outsider.clone();
    let b = payload_vector(&doc, "three-seat-terminal-bankruptcy");
    s.exec(&who, &python_settle(b, id, vec![]), &[]).unwrap();
    assert_eq!(s.state(id), GameState::Settleable);
    s.challenge(id, 1);
    let r = payload_vector(&doc, "three-seat-resolver-correction");
    s.resolve(id, ResolveOutcome::Replace { payload: wire(r) })
        .unwrap();
    assert_eq!(s.state(id), GameState::Settled);
    // pool 3 × 4_875_000 by [2018, 1600, 2409]
    assert_eq!(
        outcome_amounts(&s, id),
        (vec![4_896_839, 3_882_528, 5_845_632], 1)
    );
    s.assert_custody();
}

#[test]
fn onchain_forfeit_and_clemency_with_earlier_appraisal() {
    let doc = vectors();
    for (name, expected) in [
        (
            "three-seat-forfeit-earlier-appraisal",
            vec![0, 9_750_000, 4_875_000],
        ),
        (
            "three-seat-clemency-earlier-appraisal",
            vec![4_875_000, 6_500_000, 3_250_000],
        ),
    ] {
        let mut s = Suite::new();
        let id = three_seat_async(&mut s, &doc);
        let v = payload_vector(&doc, name);
        assert!(
            wire(v).appraisal_log_len < wire(v).log_len,
            "{name} appraises an earlier board"
        );
        let who = s.outsider.clone();
        s.exec(&who, &python_settle(v, id, python_consents(v)), &[])
            .unwrap();
        assert_eq!(outcome_amounts(&s, id), (expected, 0), "{name}");
        s.assert_custody();
    }
}

#[test]
fn onchain_python_annul_signatures() {
    let doc = vectors();
    let annul = doc["annul_vectors"].as_array().unwrap();
    // last_seq 0: annulled straight after Start.
    let mut s = Suite::new();
    let id = three_seat_async(&mut s, &doc);
    let sigs = |v: &Value| -> Vec<SeatSignature> {
        v["seat_signatures"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, x)| SeatSignature {
                seat_index: i as u8,
                signature: HexBinary::from(hex(x)),
            })
            .collect()
    };
    let who = s.outsider.clone();
    let annul_msg = |id: u64, v: &Value| ExecuteMsg::AnnulByConsent {
        chain_game_id: id,
        consents: sigs(v),
    };
    s.exec(&who, &annul_msg(id, &annul[0]), &[]).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);

    // last_seq 1801: after the bankruptcy payload; the seq-0 signatures are stale.
    let mut s = Suite::new();
    let id = three_seat_async(&mut s, &doc);
    let b = payload_vector(&doc, "three-seat-terminal-bankruptcy");
    s.exec(&who, &python_settle(b, id, vec![]), &[]).unwrap();
    assert_eq!(
        s.exec(&who, &annul_msg(id, &annul[0]), &[]).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    s.exec(&who, &annul_msg(id, &annul[1]), &[]).unwrap();
    assert_eq!(s.state(id), GameState::Annulled);
    s.assert_custody();
}

#[test]
fn onchain_seven_seat_checkpoint_settle_and_consents() {
    let doc = vectors();
    let mut s = Suite::new();
    let wallets = roster(&doc, "seven-seat");
    let id = onchain_game(&mut s, &wallets, 42, Mode::Live, ANTE);
    assert_eq!(
        s.domain(id),
        hex32(&domain_vector(&doc, "mainnet-seven-seat-live")["domain"])
    );
    let who = s.outsider.clone();
    s.exec(
        &who,
        &python_checkpoint(payload_vector(&doc, "seven-seat-checkpoint"), id),
        &[],
    )
    .unwrap();
    let t = payload_vector(&doc, "seven-seat-terminal-bankbroken");
    s.exec(&who, &python_settle(t, id, vec![]), &[]).unwrap();
    for c in python_consents(t) {
        s.exec(
            &who,
            &ExecuteMsg::Consent {
                chain_game_id: id,
                seat_index: c.seat_index,
                signature: c.signature,
            },
            &[],
        )
        .unwrap();
    }
    assert_eq!(s.state(id), GameState::Settled);
    // SYN-12 payout preview (SET-0A rev 2).
    assert_eq!(
        outcome_amounts(&s, id),
        (
            vec![0, 646_578, 646_578, 4_326_690, 3_624_434, 4_396_736, 8_980],
            4
        )
    );
    s.assert_custody();
}

#[test]
fn onchain_seven_seat_annul_and_max_u128() {
    let doc = vectors();
    let wallets = roster(&doc, "seven-seat");
    // Annul at last_seq 3000 (after the seven-seat checkpoint).
    let mut s = Suite::new();
    let id = onchain_game(&mut s, &wallets, 42, Mode::Live, ANTE);
    let who = s.outsider.clone();
    s.exec(
        &who,
        &python_checkpoint(payload_vector(&doc, "seven-seat-checkpoint"), id),
        &[],
    )
    .unwrap();
    let v = &doc["annul_vectors"][2];
    let consents: Vec<SeatSignature> = v["seat_signatures"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, x)| SeatSignature {
            seat_index: i as u8,
            signature: HexBinary::from(hex(x)),
        })
        .collect();
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Annulled);

    // Six u128::MAX weights and one 1 on a 13_650_000 pool: exactly P13.
    let mut s = Suite::new();
    let id = onchain_game(&mut s, &wallets, 42, Mode::Live, ANTE);
    let v = payload_vector(&doc, "seven-seat-max-u128-weights");
    s.exec(&who, &python_settle(v, id, python_consents(v)), &[])
        .unwrap();
    assert_eq!(
        outcome_amounts(&s, id),
        (
            vec![2_274_999, 2_274_999, 2_274_999, 2_274_999, 2_274_999, 2_274_999, 0],
            6
        )
    );
    s.assert_custody();
}
