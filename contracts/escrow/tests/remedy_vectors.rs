//! Cross-language REMEDY vectors (escrow 2.1.0, owner decision R1): the
//! contract's REMEDY and REMEDY-APPROVE digests against
//! `testdata/remedy_vectors_v1.json`, which an independent Python
//! implementation (`testdata/gen_remedy_vectors.py`) wrote from the
//! specification text. Every byte is reproduced here (the encoding, both
//! digests, the games' domains), and every replayable vector is then EXECUTED
//! ON CHAIN in a fresh game at its recorded block time, with exactly the
//! verdict the generator recorded: the six valid remedies (the five kinds and
//! a re-attested foreclosure) move the game to their state; every mutated,
//! mis-signed, stale, expired, premature, future-dated or mis-approved one is
//! refused with the recorded error and changes nothing.

mod common;

use common::*;
use cosmwasm_std::{HexBinary, Uint64};
use eighteen_cosmos_escrow::crypto::{self, DomainInputs};
use eighteen_cosmos_escrow::msg::{ExecuteMsg, RemedyAttestationV1, SeatSignature};
use eighteen_cosmos_escrow::remedy::{RemedyAttestation, REMEDY_ENCODED_LEN};
use eighteen_cosmos_escrow::state::{GameState, Mode};
use serde_json::Value;
use sha2::{Digest, Sha256};

const FILE: &str = include_str!("../testdata/remedy_vectors_v1.json");
/// The frozen file. Regenerating it is a certified-byte change.
const FILE_SHA256: &str = "de7f8dfc2817afea22998153f6224f9b0a536dfaf75a8b22c427f3a0c684127b";

fn doc() -> Value {
    serde_json::from_str(FILE).unwrap()
}

fn hex(v: &Value) -> Vec<u8> {
    HexBinary::from_hex(v.as_str().unwrap()).unwrap().to_vec()
}

fn h32(v: &Value) -> [u8; 32] {
    hex(v).try_into().unwrap()
}

fn dec(v: &Value) -> u64 {
    v.as_str().unwrap().parse().unwrap()
}

fn small(v: &Value) -> u64 {
    v.as_u64().unwrap()
}

/// The attestation exactly as the vector spells it.
fn attestation(v: &Value) -> RemedyAttestation {
    let a = &v["attestation"];
    RemedyAttestation {
        version: small(&a["version"]) as u8,
        domain: h32(&a["domain"]),
        chain_game_id: dec(&a["chain_game_id"]),
        remedy: small(&a["remedy"]) as u8,
        defaulting_seat: small(&a["defaulting_seat"]) as u8,
        strike: small(&a["strike"]) as u8,
        overdue_epoch: dec(&a["overdue_epoch"]),
        log_len: dec(&a["log_len"]),
        log_hash: h32(&a["log_hash"]),
        allowance_secs: dec(&a["allowance_secs"]),
        overdue_at: dec(&a["overdue_at"]),
        final_at: dec(&a["final_at"]),
        attested_at: dec(&a["attested_at"]),
        expires_at: dec(&a["expires_at"]),
        evidence_hash: h32(&a["evidence_hash"]),
        remedy_key_id: small(&a["remedy_key_id"]) as u16,
    }
}

fn approvals(v: &Value) -> Vec<SeatSignature> {
    v["approvals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| SeatSignature {
            seat_index: small(&x["seat_index"]) as u8,
            signature: HexBinary::from(hex(&x["signature"])),
        })
        .collect()
}

#[test]
fn the_file_is_the_frozen_one() {
    let digest: [u8; 32] = Sha256::digest(FILE.as_bytes()).into();
    assert_eq!(HexBinary::from(digest.as_slice()).to_hex(), FILE_SHA256);
    let d = doc();
    assert_eq!(d["format"], "18JUNO/REMEDY/vectors/v1");
    assert_eq!(d["tag"].as_str().unwrap().as_bytes(), crypto::TAG_REMEDY);
    assert_eq!(
        d["approve_tag"].as_str().unwrap().as_bytes(),
        crypto::TAG_REMEDY_APPROVE
    );
    assert_eq!(
        dec(&serde_json::json!(d["genesis_secs"].to_string())),
        GENESIS_SECS
    );
    let names: Vec<&str> = d["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["valid"] == true)
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "live-timeout-annul",
            "live-foreclose",
            "live-strike3",
            "async-annul",
            "async-foreclose",
            "reattested-foreclose"
        ]
    );
    assert_eq!(d["vectors"].as_array().unwrap().len(), 38);
}

/// The test keys are the Suite's: remedy key id 1, signer 1, admission 1,
/// seats 0..2.
#[test]
fn the_vector_keys_are_the_suites_keys() {
    let d = doc();
    let k = &d["keys"];
    assert_eq!(hex(&k["remedy"]["pubkey"]), Key::remedy(1).pubkey.to_vec());
    assert_eq!(
        hex(&k["other_remedy"]["pubkey"]),
        Key::remedy(2).pubkey.to_vec()
    );
    assert_eq!(
        hex(&k["settlement"]["pubkey"]),
        Key::signer(1).pubkey.to_vec()
    );
    assert_eq!(
        hex(&k["admission"]["pubkey"]),
        Key::admission(1).pubkey.to_vec()
    );
    for (i, seat) in k["seats"].as_array().unwrap().iter().enumerate() {
        assert_eq!(hex(&seat["pubkey"]), Key::seat(i).pubkey.to_vec());
    }
}

/// The games' roster hashes and domains, from the contract's own functions.
#[test]
fn the_games_domains_are_reproduced() {
    let d = doc();
    for (name, g) in d["games"].as_object().unwrap() {
        let wallets: Vec<&str> = g["wallets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w.as_str().unwrap())
            .collect();
        let roster = crypto::roster_hash(&wallets).unwrap();
        assert_eq!(roster.to_vec(), hex(&g["roster_hash"]), "{name}");
        let domain = crypto::settlement_domain(&DomainInputs {
            chain_id: g["chain_id"].as_str().unwrap(),
            contract_addr: g["contract_addr"].as_str().unwrap(),
            chain_game_id: dec(&g["chain_game_id"]),
            roster_hash: roster,
            rules_engine_version: small(&g["rules_engine_version"]) as u32,
            variants_digest: h32(&g["variants_digest"]),
            ante_gross: dec(&g["ante_gross"]) as u128,
            mode: small(&g["mode"]) as u8,
        })
        .unwrap();
        assert_eq!(domain.to_vec(), hex(&g["domain"]), "{name}");
    }
}

/// Every vector's encoding, preimage, REMEDY digest and REMEDY-APPROVE
/// digests, byte for byte; the strict decoder inverts the encoding.
#[test]
fn every_encoding_and_digest_is_reproduced() {
    let d = doc();
    for v in d["vectors"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let a = attestation(v);
        let enc = a.encode().unwrap();
        assert_eq!(enc.len(), REMEDY_ENCODED_LEN);
        assert_eq!(enc, hex(&v["encoding"]), "{name}");
        let mut pre = crypto::TAG_REMEDY.to_vec();
        pre.extend_from_slice(&enc);
        assert_eq!(pre, hex(&v["preimage"]), "{name}");
        assert_eq!(
            crypto::remedy_digest(&enc).to_vec(),
            hex(&v["digest"]),
            "{name}"
        );
        assert_eq!(RemedyAttestation::decode(&enc).unwrap(), a, "{name}");
        // The JSON wire form converts to the same fixed-width attestation.
        let wire: RemedyAttestationV1 = serde_json::from_value(v["attestation"].clone()).unwrap();
        assert_eq!(RemedyAttestation::try_from(&wire).unwrap(), a, "{name}");
        for x in v["approvals"].as_array().unwrap() {
            let seat = small(&x["seat_index"]) as u8;
            let digest = crypto::remedy_approve_digest(
                &a.domain,
                a.chain_game_id,
                a.remedy,
                a.defaulting_seat,
                a.strike,
                a.overdue_epoch,
                a.log_len,
                &a.log_hash,
                a.overdue_at,
                seat,
            );
            assert_eq!(digest.to_vec(), hex(&x["digest"]), "{name} seat {seat}");
            assert_eq!(
                Sha256::digest(hex(&x["preimage"])).to_vec(),
                digest.to_vec(),
                "{name} seat {seat}"
            );
            // The recorded verdict on the seat's signature is the contract's
            // own (current consent key = the Suite's seat key).
            let api = cosmwasm_std::testing::MockApi::default();
            let ok = crypto::check_signature(
                &api,
                &digest,
                &hex(&x["signature"]),
                Key::seat(usize::from(seat)).pubkey.as_slice(),
            )
            .is_ok();
            assert_eq!(ok, x["signature_verifies"] == true, "{name} seat {seat}");
        }
    }
}

/// Every replayable vector, EXECUTED in a fresh game at its block time, gets
/// exactly the recorded verdict; a refusal changes nothing.
#[test]
fn every_vector_replays_on_chain_with_the_recorded_verdict() {
    let d = doc();
    let mut replayed = 0;
    for v in d["vectors"].as_array().unwrap() {
        if v["replay"] != true {
            continue;
        }
        let name = v["name"].as_str().unwrap();
        let g = &d["games"][v["game"].as_str().unwrap()];
        let mode = if small(&g["mode"]) == 0 {
            Mode::Live
        } else {
            Mode::Async
        };
        let mut s = Suite::new();
        s.async_pace = dec(&g["allowance_secs"]);
        let id = s.started_with(3, mode, dec(&g["ante_gross"]) as u128);
        assert_eq!(id, dec(&g["chain_game_id"]));
        assert_eq!(s.domain(id).to_vec(), hex(&g["domain"]), "{name}");
        assert_eq!(
            s.game(id).game.started_at.unwrap().seconds(),
            dec(&g["started_at"])
        );
        assert_eq!(
            s.game(id).game.terms.allowance_secs,
            dec(&g["allowance_secs"])
        );
        let at = dec(&v["block_time"]);
        let now = s.now().seconds();
        s.advance(at - now);
        let msg = ExecuteMsg::SubmitRemedy {
            chain_game_id: id,
            attestation: serde_json::from_value(v["attestation"].clone()).unwrap(),
            signature: HexBinary::from(hex(&v["signature"])),
            approvals: approvals(v),
        };
        let before = s.game(id).game;
        let balance = s.contract_balance();
        let expect = v["expect"].as_str().unwrap();
        match (s.submit(&msg), expect.strip_prefix("ok:")) {
            (Ok(_), Some(state)) => {
                assert_eq!(s.state(id).as_str(), state, "{name}");
                let r = s.game(id).game.remedy.unwrap();
                assert_eq!(r.remedy_digest.to_vec(), hex(&v["digest"]), "{name}");
            }
            (Err(e), None) => {
                assert_eq!(format!("{e:?}"), expect, "{name}");
                assert_eq!(s.game(id).game, before, "{name} changed the game");
                assert_eq!(s.contract_balance(), balance, "{name}");
                assert_eq!(s.state(id), GameState::InProgress);
            }
            (got, _) => panic!("{name}: got {got:?}, the vectors say {expect}"),
        }
        s.assert_custody();
        replayed += 1;
    }
    assert_eq!(replayed, 37);
}

/// The signature verdict the generator recorded (low-s ECDSA by remedy key
/// 1 over the digest) is the contract's own `check_signature` verdict.
#[test]
fn every_signature_verdict_is_the_contracts() {
    let d = doc();
    let api = cosmwasm_std::testing::MockApi::default();
    let key = Key::remedy(1).pubkey;
    for v in d["vectors"].as_array().unwrap() {
        let digest = h32(&v["digest"]);
        let ok =
            crypto::check_signature(&api, &digest, &hex(&v["signature"]), key.as_slice()).is_ok();
        assert_eq!(
            ok,
            v["signature_verifies"] == true,
            "{}",
            v["name"].as_str().unwrap()
        );
    }
    let _ = Uint64::zero();
}
