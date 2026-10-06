//! Cross-language join-admission vectors: the contract's JOIN digest and its
//! admission check against `testdata/join_admission_vectors_v1.json`, which an
//! independent Python implementation (`testdata/gen_join_admission_vectors.py`)
//! wrote from the specification text. Every byte is reproduced here, every
//! vector's validity is the contract's own verdict, and every vector is then
//! replayed ON CHAIN: the valid ones seat their wallet, the invalid ones
//! (each a copied or mutated admission) are refused with `InvalidAdmission`
//! and change nothing.

mod common;

use common::*;
use cosmwasm_std::testing::MockApi;
use cosmwasm_std::{coins, Addr, HexBinary, Timestamp, Uint64};
use cw_multi_test::Executor;
use eighteen_cosmos_escrow::crypto::{self, check_signature};
use eighteen_cosmos_escrow::msg::{ExecuteMsg, InstantiateMsg, JoinAdmission};
use eighteen_cosmos_escrow::state::Mode;
use eighteen_cosmos_escrow::ContractError;
use serde_json::Value;
use sha2::{Digest, Sha256};

const FILE: &str = include_str!("../testdata/join_admission_vectors_v1.json");
/// The frozen file. Regenerating it is a certified-byte change.
const FILE_SHA256: &str = "cacc9ea3d0086253e27d8a67b7c16266f7113799526e888fe810197d16763cfb";

fn doc() -> Value {
    serde_json::from_str(FILE).unwrap()
}

fn hex(v: &Value) -> Vec<u8> {
    HexBinary::from_hex(v.as_str().unwrap()).unwrap().to_vec()
}

fn dec(v: &Value) -> u64 {
    v.as_str().unwrap().parse().unwrap()
}

fn vector<'a>(doc: &'a Value, name: &str) -> &'a Value {
    doc["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == name)
        .unwrap_or_else(|| panic!("no vector {name}"))
}

struct Inputs {
    chain_id: String,
    contract_addr: String,
    chain_game_id: u64,
    wallet: String,
    join_ticket: [u8; 32],
    expires_at: u64,
}

fn inputs(v: &Value) -> Inputs {
    let i = &v["inputs"];
    Inputs {
        chain_id: i["chain_id"].as_str().unwrap().to_string(),
        contract_addr: i["contract_addr"].as_str().unwrap().to_string(),
        chain_game_id: dec(&i["chain_game_id"]),
        wallet: i["wallet"].as_str().unwrap().to_string(),
        join_ticket: hex(&i["join_ticket"]).try_into().unwrap(),
        expires_at: dec(&i["expires_at"]),
    }
}

/// `u16(len) ‖ bytes`.
fn length_prefixed(out: &mut Vec<u8>, text: &str) {
    out.extend(u16::try_from(text.len()).unwrap().to_be_bytes());
    out.extend(text.as_bytes());
}

/// The preimage written out field by field from the spec (not via the crate).
fn preimage(i: &Inputs) -> Vec<u8> {
    let mut out = b"18JUNO/JOIN/v1".to_vec();
    length_prefixed(&mut out, &i.chain_id);
    length_prefixed(&mut out, &i.contract_addr);
    out.extend(i.chain_game_id.to_be_bytes());
    length_prefixed(&mut out, &i.wallet);
    out.extend(i.join_ticket);
    out.extend(i.expires_at.to_be_bytes());
    out
}

#[test]
fn the_file_is_the_frozen_file() {
    let sha: [u8; 32] = Sha256::digest(FILE.as_bytes()).into();
    assert_eq!(HexBinary::from(sha.as_slice()).to_hex(), FILE_SHA256);
    let d = doc();
    assert_eq!(d["format"], "18JUNO/JOIN/admission-vectors/v1");
    assert_eq!(d["tag"], "18JUNO/JOIN/v1");
    assert_eq!(crypto::TAG_JOIN, b"18JUNO/JOIN/v1");
    assert_eq!(d["genesis_secs"].as_u64().unwrap(), GENESIS_SECS);
    let vectors = d["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 20);
    assert_eq!(vectors.iter().filter(|v| v["valid"] == true).count(), 4);
}

#[test]
fn test_keys_match_the_python_keys() {
    let d = doc();
    assert_eq!(
        Key::admission(1).pubkey.to_vec(),
        hex(&d["keys"]["admission"]["pubkey"])
    );
    assert_eq!(
        Key::admission(2).pubkey.to_vec(),
        hex(&d["keys"]["other_admission"]["pubkey"])
    );
    assert_eq!(
        Key::signer(1).pubkey.to_vec(),
        hex(&d["keys"]["settlement"]["pubkey"])
    );
}

#[test]
fn every_preimage_digest_and_verdict_is_reproduced() {
    let d = doc();
    let api = MockApi::default();
    let admission_key = hex(&d["keys"]["admission"]["pubkey"]);
    for v in d["vectors"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let i = inputs(v);
        let pre = preimage(&i);
        assert_eq!(pre, hex(&v["preimage"]), "{name}: preimage");
        let manual: [u8; 32] = Sha256::digest(&pre).into();
        let digest = crypto::join_admission_digest(
            &i.chain_id,
            &i.contract_addr,
            i.chain_game_id,
            &i.wallet,
            &i.join_ticket,
            i.expires_at,
        )
        .unwrap();
        assert_eq!(digest, manual, "{name}: crate digest = spec digest");
        assert_eq!(digest.to_vec(), hex(&v["digest"]), "{name}: digest");
        let verdict = check_signature(&api, &digest, &hex(&v["signature"]), &admission_key).is_ok();
        assert_eq!(verdict, v["valid"].as_bool().unwrap(), "{name}: verdict");
    }
    // Our own RFC 6979 key signs the valid vectors to the same bytes.
    for name in ["base", "testnet", "extremes", "keplr-20-byte-wallet"] {
        let v = vector(&d, name);
        let digest: [u8; 32] = hex(&v["digest"]).try_into().unwrap();
        assert_eq!(
            Key::admission(1).sign(&digest).to_vec(),
            hex(&v["signature"]),
            "{name}: RFC 6979 signature"
        );
    }
}

fn admission_of(v: &Value) -> JoinAdmission {
    JoinAdmission {
        expires_at: Uint64::new(dec(&v["inputs"]["expires_at"])),
        signature: HexBinary::from(hex(&v["signature"])),
    }
}

/// A Join from `sender` into game 1 carrying the vector's ticket and admission.
fn join_of(v: &Value, consent_seat: usize) -> ExecuteMsg {
    ExecuteMsg::Join {
        chain_game_id: dec(&v["inputs"]["chain_game_id"]),
        consent_pubkey: Key::seat(consent_seat).pubkey,
        join_ticket: HexBinary::from(hex(&v["inputs"]["join_ticket"])),
        admission: admission_of(v),
    }
}

/// A suite on `chain_id` whose first game (id 1) is open, at genesis time.
fn suite_with_game(chain_id: &str) -> Suite {
    let mut s = SuiteBuilder::default().chain_id(chain_id).build();
    assert_eq!(s.now(), Timestamp::from_seconds(GENESIS_SECS));
    let id = s.create(0, 4, Mode::Live, ANTE);
    assert_eq!(id, 1);
    s
}

fn assert_refused_and_nothing_moved(s: &mut Suite, sender: &Addr, msg: &ExecuteMsg, name: &str) {
    let before_game = s.game(1).game;
    let before_sender = s.balance(sender);
    let before_contract = s.contract_balance();
    let before_treasury = s.balance(&s.treasury.clone());
    assert_eq!(
        s.exec(sender, msg, &coins(ANTE, DENOM)).unwrap_err(),
        ContractError::InvalidAdmission {},
        "{name}"
    );
    assert_eq!(s.game(1).game, before_game, "{name}: no seat");
    assert_eq!(s.balance(sender), before_sender, "{name}: no ante taken");
    assert_eq!(s.contract_balance(), before_contract, "{name}");
    assert_eq!(
        s.balance(&s.treasury.clone()),
        before_treasury,
        "{name}: no fee taken"
    );
}

#[test]
fn the_valid_vectors_seat_their_own_wallet_on_chain() {
    let d = doc();
    for (name, chain_id, seat) in [("base", MAINNET, 1usize), ("testnet", TESTNET, 2)] {
        let v = vector(&d, name);
        let mut s = suite_with_game(chain_id);
        assert_eq!(
            s.contract.as_str(),
            v["inputs"]["contract_addr"].as_str().unwrap()
        );
        let wallet = s.players[seat].clone();
        assert_eq!(wallet.as_str(), v["inputs"]["wallet"].as_str().unwrap());
        s.exec(&wallet, &join_of(v, seat), &coins(ANTE, DENOM))
            .unwrap();
        let g = s.game(1).game;
        assert_eq!(g.seats.len(), 2);
        assert_eq!(g.seats[1].wallet, wallet);
        assert_eq!(
            g.seats[1].join_ticket.to_vec(),
            hex(&v["inputs"]["join_ticket"])
        );
        s.assert_custody();
    }
}

#[test]
fn every_mutated_or_copied_admission_is_refused_on_chain_and_moves_nothing() {
    let d = doc();
    let base = vector(&d, "base");
    let alice_seat = 1usize;

    // Signature mutations: alice, the right game, the right ticket, bad bytes.
    for v in d["vectors"].as_array().unwrap() {
        if v["mutates"] != "signature" {
            continue;
        }
        let mut s = suite_with_game(MAINNET);
        let alice = s.players[alice_seat].clone();
        assert_refused_and_nothing_moved(
            &mut s,
            &alice,
            &join_of(v, alice_seat),
            v["name"].as_str().unwrap(),
        );
    }

    // another-chain: the base admission (signed for juno-1) submitted on uni-7.
    {
        let v = vector(&d, "mutate-another-chain");
        let mut s = suite_with_game(v["inputs"]["chain_id"].as_str().unwrap());
        let alice = s.players[alice_seat].clone();
        assert_refused_and_nothing_moved(
            &mut s,
            &alice,
            &join_of(base, alice_seat),
            "another-chain",
        );
    }

    // another-contract: a second instance (the next contract address) with the
    // same admission key, same chain, its own game 1.
    {
        let v = vector(&d, "mutate-another-contract");
        let mut s = suite_with_game(MAINNET);
        let admin = s.admin.clone();
        let other = s
            .app
            .instantiate_contract(
                s.code_id,
                admin.clone(),
                &InstantiateMsg {
                    admin: admin.to_string(),
                    operator: s.operator.to_string(),
                    resolver: s.resolver.to_string(),
                    treasury: s.treasury.to_string(),
                    denom: DENOM.to_string(),
                    params: default_params(),
                    signer_keys: vec![Key::signer(1).pubkey],
                    admission_pubkey: Key::admission(1).pubkey,
                    remedy_keys: vec![],
                },
                &[],
                "escrow-2",
                None,
            )
            .unwrap();
        assert_eq!(
            other.as_str(),
            v["inputs"]["contract_addr"].as_str().unwrap()
        );
        let original = std::mem::replace(&mut s.contract, other);
        assert_eq!(s.create(0, 4, Mode::Live, ANTE), 1);
        let alice = s.players[alice_seat].clone();
        assert_refused_and_nothing_moved(
            &mut s,
            &alice,
            &join_of(base, alice_seat),
            "another-contract",
        );
        // ...and the same admission still works where it was issued.
        s.contract = original;
        s.exec(&alice, &join_of(base, alice_seat), &coins(ANTE, DENOM))
            .unwrap();
    }

    // another-game: game 2 of the same contract.
    {
        let mut s = suite_with_game(MAINNET);
        assert_eq!(s.create(0, 4, Mode::Live, ANTE), 2);
        let alice = s.players[alice_seat].clone();
        let mut msg = join_of(base, alice_seat);
        if let ExecuteMsg::Join { chain_game_id, .. } = &mut msg {
            *chain_game_id = 2;
        }
        let before = s.game(2).game;
        assert_eq!(
            s.exec(&alice, &msg, &coins(ANTE, DENOM)).unwrap_err(),
            ContractError::InvalidAdmission {}
        );
        assert_eq!(s.game(2).game, before);
    }

    // another-wallet: mallory copies alice's pending Join (ticket AND admission).
    {
        let v = vector(&d, "mutate-another-wallet");
        let mut s = suite_with_game(MAINNET);
        let mallory = s.outsider.clone();
        assert_eq!(mallory.as_str(), v["inputs"]["wallet"].as_str().unwrap());
        assert_refused_and_nothing_moved(&mut s, &mallory, &join_of(base, 3), "another-wallet");
    }

    // uppercase-wallet: a server that signed alice's account in another
    // spelling produced an admission the chain (lower-case sender) refuses.
    {
        let v = vector(&d, "mutate-uppercase-wallet");
        let mut s = suite_with_game(MAINNET);
        let alice = s.players[alice_seat].clone();
        let digest: [u8; 32] = hex(&v["digest"]).try_into().unwrap();
        let mut msg = join_of(base, alice_seat);
        if let ExecuteMsg::Join { admission, .. } = &mut msg {
            admission.signature = Key::admission(1).sign(&digest);
        }
        assert_refused_and_nothing_moved(&mut s, &alice, &msg, "uppercase-wallet");
    }

    // another-ticket and another-expiry: alice's own Join, one field altered.
    for (name, field) in [
        ("mutate-another-ticket", "ticket"),
        ("mutate-another-expiry", "expiry"),
    ] {
        let v = vector(&d, name);
        let mut s = suite_with_game(MAINNET);
        let alice = s.players[alice_seat].clone();
        let mut msg = join_of(base, alice_seat);
        if let ExecuteMsg::Join {
            join_ticket,
            admission,
            ..
        } = &mut msg
        {
            match field {
                "ticket" => *join_ticket = HexBinary::from(hex(&v["inputs"]["join_ticket"])),
                _ => admission.expires_at = Uint64::new(dec(&v["inputs"]["expires_at"])),
            }
        }
        assert_refused_and_nothing_moved(&mut s, &alice, &msg, name);
    }
}

/// The exact bytes the TypeScript server's `WALLET_EXECUTE.join` writes for the
/// base vector (`server/src/escrow/escrowJoinAdmission.test.ts` pins the same
/// literal): the contract parses them into the admission it verifies, and the
/// Join lands.
const SERVER_WIRE_BASE_JOIN: &str = r#"{"join":{"chain_game_id":1,"consent_pubkey":"03346c3180a0b68922f81f0092a78e124c32bf5575860c1daec7de9d0b405c19fd","join_ticket":"3f1f9142c92994e97aced9dbd5dc92fede9aadebcfbc9b057c8a02f29bc4f444","admission":{"expires_at":"1790000900","signature":"7f6a5af1d02172534e1b31c7c03f6710dc01c691506f3f6af9c4921b258c3e3e1a0c2c8d71362e4fb2dca438caf54af9de3b976736323fb627795f854c25602a"}}}"#;

#[test]
fn the_server_wire_form_parses_and_executes() {
    let d = doc();
    let parsed: ExecuteMsg = cosmwasm_std::from_json(SERVER_WIRE_BASE_JOIN.as_bytes()).unwrap();
    assert_eq!(parsed, join_of(vector(&d, "base"), 1));
    let mut s = suite_with_game(MAINNET);
    let alice = s.players[1].clone();
    s.exec(&alice, &parsed, &coins(ANTE, DENOM)).unwrap();
    assert_eq!(s.game(1).game.seats[1].wallet, alice);
}
