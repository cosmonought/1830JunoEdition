//! escrow-gasbench — gas for the optimized escrow wasm, measured in a real
//! CosmWasm VM.
//!
//! * VM: cosmwasm-vm 3.0.5 (Juno v30.0.0 → wasmvm v3.0.4 → cosmwasm-vm 3.0.5),
//!   singlepass + metering, the same engine a Juno node runs. The artifact is
//!   stored *checked*, so the VM's own static validation must accept it.
//! * Measured: `used_internally` (wasm ops + host calls, CosmWasm gas).
//! * Modelled (wasmd v0.54/v0.61 defaults + Cosmos SDK KV gas config), counted
//!   from the exact storage operations the contract performed:
//!   - wasm → SDK gas: VM gas / 140_000 (DefaultGasMultiplier, floor);
//!   - instance load: 60_000 (DefaultInstanceCost, unpinned code);
//!   - KV: read 1000 + 3/B, write 2000 + 30/B, delete 1000, iterator 30 per
//!     seek/next + 3/B per item; key bytes include wasmd's 33-byte contract
//!     store prefix (0x03 ‖ 32-byte contract address);
//!   - events: 10 per attribute + 1/B beyond a 100-byte free tier, 20 per custom
//!     event + its type length (wasmd EventCosts).
//! * Estimated only: each BankMsg::Send dispatched by the response (SDK bank
//!   keeper KV work, ≈12_600 SDK gas; see BANK_SEND_EST). Ante-handler / tx
//!   size / signature costs of the enclosing transaction are not modelled.
//!
//! Output: a Markdown report on stdout and every row as JSON (argv[2]).
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use bech32::{Bech32, Hrp};
use cosmwasm_std::{Binary, Checksum, Order, Record};
use cosmwasm_std_v1::{HexBinary, Uint128};
use cosmwasm_vm::testing::{MockApi, MockQuerier, MockStorage};
use cosmwasm_vm::{
    call_execute_raw, call_instantiate_raw, call_query_raw, capabilities_from_csv, Backend,
    BackendResult, Cache, CacheOptions, InstanceOptions, Size, Storage,
};
use eighteen_cosmos_escrow::crypto;
use eighteen_cosmos_escrow::msg::{
    CheckpointsResponse, ExecuteMsg, GameResponse, InstantiateMsg, QueryMsg, ResolveOutcome,
    SeatSignature, SettlementPayloadV1, SignedCheckpoint,
};
use eighteen_cosmos_escrow::payload::{
    Payload, KIND_CHECKPOINT, KIND_TERMINAL, REASON_BANK_BROKEN, REASON_RESOLVER_CORRECTION,
    REASON_ROUND_BOUNDARY,
};
use eighteen_cosmos_escrow::state::{GameParams, Mode};
use k256::ecdsa::signature::hazmat::PrehashSigner;
use k256::ecdsa::{Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// ------------------------------------------------------------------ model
const CAPABILITIES: &str = "iterator,staking,stargate,cosmwasm_1_1,cosmwasm_1_2,cosmwasm_1_3,cosmwasm_1_4,cosmwasm_2_0,cosmwasm_2_1,cosmwasm_2_2";
const GAS_MULTIPLIER: u64 = 140_000;
const INSTANCE_COST: u64 = 60_000;
const PREFIX_LEN: u64 = 33;
/// SDK v0.50/0.53 bank `SendCoins` of one denom from the contract to an
/// existing account: 3 reads (sender balance, sender account for locked coins,
/// recipient balance) ≈ 3×1_150, 1 has (recipient account) 1_000, 1 read of
/// the send-enabled entry ≈ 1_050, 2 balance writes ≈ 2×3_450. Estimate only.
const BANK_SEND_EST: u64 = 12_600;
const VM_GAS_LIMIT: u64 = 1 << 55;
const CHAIN_ID: &str = "uni-7";
const DENOM: &str = "ujuno";
const ANTE: u128 = 2_000_000;
const DAY: u64 = 86_400;
const GENESIS: u64 = 1_790_000_000;

#[derive(Default, Clone, Copy, Debug)]
struct Ops {
    reads: u64,
    read_bytes: u64,
    writes: u64,
    write_bytes: u64,
    removes: u64,
    scans: u64,
    nexts: u64,
    next_bytes: u64,
}

impl Ops {
    fn kv_gas(&self) -> u64 {
        1_000 * self.reads
            + 3 * self.read_bytes
            + 2_000 * self.writes
            + 30 * self.write_bytes
            + 1_000 * self.removes
            + 30 * (self.scans + self.nexts)
            + 3 * self.next_bytes
    }
}

/// MockStorage plus an exact count of what the contract asked of the store.
struct Metered {
    inner: MockStorage,
    ops: Arc<Mutex<Ops>>,
}

impl Storage for Metered {
    fn get(&self, key: &[u8]) -> BackendResult<Option<Vec<u8>>> {
        let (r, g) = self.inner.get(key);
        if let Ok(v) = &r {
            let mut o = self.ops.lock().unwrap();
            o.reads += 1;
            o.read_bytes +=
                PREFIX_LEN + key.len() as u64 + v.as_ref().map_or(0, |v| v.len() as u64);
        }
        (r, g)
    }

    fn scan(
        &mut self,
        start: Option<&[u8]>,
        end: Option<&[u8]>,
        order: Order,
    ) -> BackendResult<u32> {
        self.ops.lock().unwrap().scans += 1;
        self.inner.scan(start, end, order)
    }

    fn next(&mut self, iterator_id: u32) -> BackendResult<Option<Record>> {
        let (r, g) = self.inner.next(iterator_id);
        if let Ok(Some((k, v))) = &r {
            let mut o = self.ops.lock().unwrap();
            o.nexts += 1;
            o.next_bytes += PREFIX_LEN + k.len() as u64 + v.len() as u64;
        }
        (r, g)
    }

    fn set(&mut self, key: &[u8], value: &[u8]) -> BackendResult<()> {
        {
            let mut o = self.ops.lock().unwrap();
            o.writes += 1;
            o.write_bytes += PREFIX_LEN + key.len() as u64 + value.len() as u64;
        }
        self.inner.set(key, value)
    }

    fn remove(&mut self, key: &[u8]) -> BackendResult<()> {
        self.ops.lock().unwrap().removes += 1;
        self.inner.remove(key)
    }
}

type VmCache = Cache<MockApi, Metered, MockQuerier>;

// ------------------------------------------------------------------ keys
fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

#[derive(Clone)]
struct Key {
    sk: SigningKey,
    pubkey: HexBinary,
}

impl Key {
    fn from_label(label: &str) -> Key {
        let sk = SigningKey::from_slice(&sha256(&[label.as_bytes()])).unwrap();
        let pubkey = HexBinary::from(sk.verifying_key().to_encoded_point(true).as_bytes());
        Key { sk, pubkey }
    }
    fn seat(i: usize) -> Key {
        Key::from_label(&format!("18JUNO/TEST/seat/{i}"))
    }
    fn signer(n: usize) -> Key {
        Key::from_label(&format!("18JUNO/TEST/signer/{n}"))
    }
    fn sign(&self, digest: &[u8; 32]) -> HexBinary {
        let sig: Signature = self.sk.sign_prehash(digest).unwrap();
        let sig = sig.normalize_s().unwrap_or(sig);
        HexBinary::from(sig.to_bytes().as_slice())
    }
}

/// 20-byte account (43 chars) or 32-byte contract (63 chars) `juno1…` address.
fn addr(label: &str, len: usize) -> String {
    bech32::encode::<Bech32>(
        Hrp::parse("juno").unwrap(),
        &sha256(&[label.as_bytes()])[..len],
    )
    .unwrap()
}

fn params() -> GameParams {
    GameParams {
        subsidy_bps: 250,
        min_ante: Uint128::new(ANTE),
        bond_bps: 5_000,
        bond_floor: Uint128::new(1_000_000),
        challenge_window_live_secs: DAY,
        challenge_window_async_secs: 2 * DAY,
        funding_period_live_secs: DAY,
        funding_period_async_secs: 7 * DAY,
        liveness_window_secs: 14 * DAY,
        resolver_timeout_secs: 30 * DAY,
    }
}

// ------------------------------------------------------------------ rows
#[derive(Clone, Debug)]
struct Row {
    group: String,
    path: String,
    shape: String,
    seats: usize,
    keys: usize,
    ckpts: usize,
    vm_gas: u64,
    ops: Ops,
    event_gas: u64,
    sends: usize,
    msg_bytes: usize,
}

impl Row {
    fn wasm_sdk(&self) -> u64 {
        self.vm_gas / GAS_MULTIPLIER
    }
    /// Contract-side SDK gas: instance + wasm + KV + events (no bank dispatch).
    fn contract_gas(&self) -> u64 {
        INSTANCE_COST + self.wasm_sdk() + self.ops.kv_gas() + self.event_gas
    }
    fn est_total(&self) -> u64 {
        self.contract_gas() + self.sends as u64 * BANK_SEND_EST
    }
    fn json(&self) -> Value {
        json!({
            "group": self.group, "path": self.path, "shape": self.shape,
            "seats": self.seats, "signer_keys": self.keys, "checkpoints": self.ckpts,
            "vm_gas_used_internally": self.vm_gas, "wasm_sdk_gas": self.wasm_sdk(),
            "kv": {"reads": self.ops.reads, "read_bytes": self.ops.read_bytes,
                   "writes": self.ops.writes, "write_bytes": self.ops.write_bytes,
                   "removes": self.ops.removes, "iterators": self.ops.scans,
                   "iter_items": self.ops.nexts, "iter_bytes": self.ops.next_bytes,
                   "kv_sdk_gas": self.ops.kv_gas()},
            "event_sdk_gas": self.event_gas, "instance_sdk_gas": INSTANCE_COST,
            "contract_sdk_gas": self.contract_gas(), "bank_sends": self.sends,
            "est_total_sdk_gas_incl_bank": self.est_total(), "msg_bytes": self.msg_bytes,
        })
    }
}

fn event_gas(ok: &Value) -> u64 {
    fn attr_cost(attrs: &[Value], free: &mut u64) -> u64 {
        let bytes: u64 = attrs
            .iter()
            .map(|a| (a["key"].as_str().unwrap().len() + a["value"].as_str().unwrap().len()) as u64)
            .sum();
        let charged = if bytes <= *free {
            *free -= bytes;
            0
        } else {
            let c = bytes - *free;
            *free = 0;
            c
        };
        charged + 10 * attrs.len() as u64
    }
    let mut free = 100;
    let empty = vec![];
    let mut gas = attr_cost(ok["attributes"].as_array().unwrap_or(&empty), &mut free);
    for e in ok["events"].as_array().unwrap_or(&empty) {
        gas += 20 + e["type"].as_str().unwrap().len() as u64;
        gas += attr_cost(e["attributes"].as_array().unwrap_or(&empty), &mut free);
    }
    gas
}

fn bank_sends(ok: &Value) -> usize {
    ok["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter(|s| s["msg"]["bank"]["send"].is_object())
                .count()
        })
        .unwrap_or(0)
}

fn attr(ok: &Value, key: &str) -> String {
    ok["attributes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["key"] == key)
        .unwrap_or_else(|| panic!("attribute {key} missing: {ok}"))["value"]
        .as_str()
        .unwrap()
        .to_string()
}

// ------------------------------------------------------------------ world
struct World {
    cache: Rc<VmCache>,
    checksum: Checksum,
    storage: Option<MockStorage>,
    ops: Arc<Mutex<Ops>>,
    api: MockApi,
    height: u64,
    time: u64,
    contract: String,
    admin: String,
    operator: String,
    resolver: String,
    outsider: String,
    players: Vec<String>,
    signers: Vec<Key>,
}

struct Outcome {
    ok: Value,
    vm_gas: u64,
    ops: Ops,
    msg_bytes: usize,
}

enum Call<'a> {
    Instantiate(&'a str, &'a [u8], u128),
    Execute(&'a str, &'a [u8], u128),
    Query(&'a [u8]),
}

impl World {
    fn new(cache: Rc<VmCache>, checksum: Checksum, player_addr_len: usize) -> World {
        let players = (0..7)
            .map(|i| addr(&format!("player/{i}"), player_addr_len))
            .collect();
        let mut w = World {
            cache,
            checksum,
            storage: Some(MockStorage::new()),
            ops: Arc::new(Mutex::new(Ops::default())),
            api: MockApi::default().with_prefix("juno"),
            height: 1_000,
            time: GENESIS,
            contract: addr("contract/escrow", 32),
            admin: addr("admin", 20),
            operator: addr("operator", 20),
            resolver: addr("resolver", 20),
            outsider: addr("outsider", 20),
            players,
            signers: vec![Key::signer(1)],
        };
        let msg = serde_json::to_vec(&InstantiateMsg {
            admin: w.admin.clone(),
            operator: w.operator.clone(),
            resolver: w.resolver.clone(),
            treasury: addr("treasury", 20),
            denom: DENOM.to_string(),
            params: params(),
            signer_keys: vec![Key::signer(1).pubkey],
        })
        .unwrap();
        let admin = w.admin.clone();
        w.run(Call::Instantiate(&admin, &msg, 0))
            .expect("instantiate");
        w
    }

    fn env(&self) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "block": {"height": self.height, "time": (self.time * 1_000_000_000).to_string(), "chain_id": CHAIN_ID},
            "transaction": {"index": 0},
            "contract": {"address": self.contract},
        }))
        .unwrap()
    }

    fn info(sender: &str, funds: u128) -> Vec<u8> {
        let funds = if funds == 0 {
            json!([])
        } else {
            json!([{"denom": DENOM, "amount": funds.to_string()}])
        };
        serde_json::to_vec(&json!({"sender": sender, "funds": funds})).unwrap()
    }

    fn run(&mut self, call: Call) -> Result<Outcome, String> {
        *self.ops.lock().unwrap() = Ops::default();
        self.height += 1;
        let backend = Backend {
            api: self.api,
            storage: Metered {
                inner: self.storage.take().unwrap(),
                ops: self.ops.clone(),
            },
            querier: MockQuerier::new(&[]),
        };
        let mut instance = self
            .cache
            .get_instance(
                &self.checksum,
                backend,
                InstanceOptions {
                    gas_limit: VM_GAS_LIMIT,
                },
            )
            .unwrap();
        let env = self.env();
        let (raw, msg_bytes) = match call {
            Call::Instantiate(sender, msg, funds) => (
                call_instantiate_raw(&mut instance, &env, &Self::info(sender, funds), msg),
                msg.len(),
            ),
            Call::Execute(sender, msg, funds) => (
                call_execute_raw(&mut instance, &env, &Self::info(sender, funds), msg),
                msg.len(),
            ),
            Call::Query(msg) => (call_query_raw(&mut instance, &env, msg), msg.len()),
        };
        let report = instance.create_gas_report();
        let backend = instance.recycle().expect("recycle");
        self.storage = Some(backend.storage.inner);
        let raw = raw.map_err(|e| format!("vm error: {e}"))?;
        let v: Value = serde_json::from_slice(&raw).unwrap();
        let ops = *self.ops.lock().unwrap();
        match v.get("ok") {
            Some(ok) => Ok(Outcome {
                ok: ok.clone(),
                vm_gas: report.used_internally,
                ops,
                msg_bytes,
            }),
            None => Err(v["error"].as_str().unwrap_or("?").to_string()),
        }
    }

    fn exec(&mut self, sender: &str, msg: &ExecuteMsg, funds: u128) -> Outcome {
        let bytes = serde_json::to_vec(msg).unwrap();
        let sender = sender.to_string();
        self.run(Call::Execute(&sender, &bytes, funds))
            .unwrap_or_else(|e| {
                panic!(
                    "execute failed: {e}\nmsg: {}",
                    String::from_utf8_lossy(&bytes)
                )
            })
    }

    fn query_raw(&mut self, msg: &QueryMsg) -> (Vec<u8>, Outcome) {
        let bytes = serde_json::to_vec(msg).unwrap();
        let out = self.run(Call::Query(&bytes)).expect("query");
        let b64: String = serde_json::from_value(out.ok.clone()).unwrap();
        (Binary::from_base64(&b64).unwrap().to_vec(), out)
    }

    fn game(&mut self, id: u64) -> GameResponse {
        let (b, _) = self.query_raw(&QueryMsg::Game { chain_game_id: id });
        serde_json::from_slice(&b).unwrap()
    }

    fn advance(&mut self, secs: u64) {
        self.time += secs;
        self.height += (secs / 5).max(1);
    }

    // -------------------------------------------------------------- funding
    fn create_msg(max_players: u8, seat: usize) -> ExecuteMsg {
        ExecuteMsg::CreateGame {
            max_players,
            mode: Mode::Live,
            rules_engine_version: 10,
            variants_digest: HexBinary::from(sha256(&[b"18JUNO/TEST/variants"]).as_slice()),
            consent_pubkey: Key::seat(seat).pubkey,
            join_ticket: HexBinary::from(
                sha256(&[b"18JUNO/TEST/ticket/", &[seat as u8]]).as_slice(),
            ),
        }
    }

    fn join_msg(id: u64, seat: usize) -> ExecuteMsg {
        ExecuteMsg::Join {
            chain_game_id: id,
            consent_pubkey: Key::seat(seat).pubkey,
            join_ticket: HexBinary::from(
                sha256(&[b"18JUNO/TEST/ticket/", &[seat as u8]]).as_slice(),
            ),
        }
    }

    fn create(&mut self, n: u8) -> (u64, Outcome) {
        let p0 = self.players[0].clone();
        let out = self.exec(&p0, &Self::create_msg(n, 0), ANTE);
        (attr(&out.ok, "chain_game_id").parse().unwrap(), out)
    }

    fn join(&mut self, id: u64, seat: usize) -> Outcome {
        let p = self.players[seat].clone();
        self.exec(&p, &Self::join_msg(id, seat), ANTE)
    }

    fn funded(&mut self, n: usize) -> u64 {
        let (id, _) = self.create(n as u8);
        for s in 1..n {
            self.join(id, s);
        }
        id
    }

    fn start_msg(&mut self, id: u64) -> ExecuteMsg {
        let wallets: Vec<String> = self
            .game(id)
            .game
            .seats
            .iter()
            .map(|s| s.wallet.to_string())
            .collect();
        ExecuteMsg::Start {
            chain_game_id: id,
            roster_hash: HexBinary::from(crypto::roster_hash(&wallets).unwrap().as_slice()),
        }
    }

    fn start(&mut self, id: u64) -> Outcome {
        let msg = self.start_msg(id);
        let op = self.operator.clone();
        self.exec(&op, &msg, 0)
    }

    fn started(&mut self, n: usize) -> u64 {
        let id = self.funded(n);
        self.start(id);
        id
    }

    // ------------------------------------------------------------- payloads
    fn domain(&mut self, id: u64) -> [u8; 32] {
        self.game(id)
            .game
            .domain
            .unwrap()
            .as_slice()
            .try_into()
            .unwrap()
    }

    fn payload(
        &mut self,
        id: u64,
        kind: u8,
        reason: u8,
        log_len: u64,
        n: usize,
        key_id: u16,
    ) -> Payload {
        Payload {
            version: 1,
            domain: self.domain(id),
            seq: 2 * log_len + u64::from(kind),
            kind,
            reason,
            log_len,
            log_hash: sha256(&[b"log", &log_len.to_be_bytes()]),
            appraisal_log_len: log_len,
            appraisal_state_hash: sha256(&[b"state", &log_len.to_be_bytes()]),
            state_schema_version: 1,
            settlement_weights: (1..=n as u128).collect(),
            signer_key_id: key_id,
            issued_at: GENESIS,
        }
    }

    fn signed(&self, p: &Payload) -> (SettlementPayloadV1, HexBinary) {
        let key = &self.signers[usize::from(p.signer_key_id) - 1];
        (
            SettlementPayloadV1::try_from(p).unwrap(),
            key.sign(&crypto::settle_digest(&p.encode().unwrap())),
        )
    }

    fn checkpoint_msg(&mut self, id: u64, log_len: u64, n: usize, key_id: u16) -> ExecuteMsg {
        let p = self.payload(
            id,
            KIND_CHECKPOINT,
            REASON_ROUND_BOUNDARY,
            log_len,
            n,
            key_id,
        );
        let (payload, signature) = self.signed(&p);
        ExecuteMsg::Checkpoint {
            chain_game_id: id,
            payload,
            signature,
        }
    }

    fn checkpoint(&mut self, id: u64, log_len: u64, n: usize, key_id: u16) -> Outcome {
        let msg = self.checkpoint_msg(id, log_len, n, key_id);
        let who = self.outsider.clone();
        self.exec(&who, &msg, 0)
    }

    fn consent_sigs(&mut self, id: u64, p: &Payload, seats: &[usize]) -> Vec<SeatSignature> {
        let digest = crypto::consent_digest(
            &self.domain(id),
            p.seq,
            &crypto::settle_digest(&p.encode().unwrap()),
        );
        seats
            .iter()
            .map(|&i| SeatSignature {
                seat_index: i as u8,
                signature: Key::seat(i).sign(&digest),
            })
            .collect()
    }

    fn settle_msg(
        &mut self,
        id: u64,
        log_len: u64,
        n: usize,
        key_id: u16,
        consent: &[usize],
    ) -> (Payload, ExecuteMsg) {
        let p = self.payload(id, KIND_TERMINAL, REASON_BANK_BROKEN, log_len, n, key_id);
        let (payload, signature) = self.signed(&p);
        let consents = self.consent_sigs(id, &p, consent);
        (
            p,
            ExecuteMsg::Settle {
                chain_game_id: id,
                payload,
                signature,
                consents,
            },
        )
    }

    fn settle(
        &mut self,
        id: u64,
        log_len: u64,
        n: usize,
        key_id: u16,
        consent: &[usize],
    ) -> (Payload, Outcome) {
        let (p, msg) = self.settle_msg(id, log_len, n, key_id, consent);
        let op = self.operator.clone();
        (p, self.exec(&op, &msg, 0))
    }

    fn consent(&mut self, id: u64, p: &Payload, seat: usize) -> Outcome {
        let sig = self.consent_sigs(id, p, &[seat]).remove(0);
        let who = self.players[seat].clone();
        self.exec(
            &who,
            &ExecuteMsg::Consent {
                chain_game_id: id,
                seat_index: seat as u8,
                signature: sig.signature,
            },
            0,
        )
    }

    fn liveness(&mut self, id: u64, checkpoint: Option<SignedCheckpoint>) -> Outcome {
        let who = self.players[1].clone();
        self.exec(
            &who,
            &ExecuteMsg::LivenessSettle {
                chain_game_id: id,
                checkpoint,
            },
            0,
        )
    }

    fn challenge(&mut self, id: u64) -> Outcome {
        let bond = self.game(id).game.bond.unwrap().u128();
        let who = self.players[1].clone();
        self.exec(
            &who,
            &ExecuteMsg::Challenge {
                chain_game_id: id,
                evidence_hash: HexBinary::from(sha256(&[b"evidence"]).as_slice()),
            },
            bond,
        )
    }

    fn resolve(&mut self, id: u64, outcome: ResolveOutcome) -> Outcome {
        let who = self.resolver.clone();
        self.exec(
            &who,
            &ExecuteMsg::Resolve {
                chain_game_id: id,
                outcome,
            },
            0,
        )
    }

    fn annul(&mut self, id: u64, n: usize) -> Outcome {
        let g = self.game(id);
        let domain: [u8; 32] = g.game.domain.unwrap().as_slice().try_into().unwrap();
        let digest = crypto::annul_digest(&domain, g.trusted_seq.u64());
        let consents = (0..n)
            .map(|i| SeatSignature {
                seat_index: i as u8,
                signature: Key::seat(i).sign(&digest),
            })
            .collect();
        let who = self.outsider.clone();
        self.exec(
            &who,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents,
            },
            0,
        )
    }

    /// Every stored record, grouped by cw-storage-plus namespace.
    fn dump_into(&mut self, sizes: &mut Sizes) {
        let st = self.storage.as_mut().unwrap();
        let (it, _) = st.scan(None, None, Order::Ascending);
        let it = it.unwrap();
        loop {
            let (next, _) = st.next(it);
            let Some((k, v)) = next.unwrap() else { break };
            let ns = if k.len() > 2 {
                let l = usize::from(u16::from_be_bytes([k[0], k[1]]));
                if l > 0 && 2 + l <= k.len() && k[2..2 + l].iter().all(|c| c.is_ascii_graphic()) {
                    String::from_utf8_lossy(&k[2..2 + l]).to_string()
                } else {
                    String::from_utf8_lossy(&k).to_string()
                }
            } else {
                String::from_utf8_lossy(&k).to_string()
            };
            let e = sizes.by_ns.entry(ns).or_insert((0, 0, 0, 0));
            e.0 += 1;
            e.1 = e.1.max(v.len());
            e.2 += v.len();
            e.3 = e.3.max(k.len());
        }
    }

    // ---------------------------------------------------------------- admin
    fn add_key(&mut self) -> (u16, Outcome) {
        let n = self.signers.len() + 1;
        let key = Key::signer(n);
        let admin = self.admin.clone();
        let out = self.exec(
            &admin,
            &ExecuteMsg::AddSignerKey {
                pubkey: key.pubkey.clone(),
            },
            0,
        );
        let id: u16 = attr(&out.ok, "key_id").parse().unwrap();
        assert_eq!(usize::from(id), n, "key ids are sequential");
        self.signers.push(key);
        (id, out)
    }

    fn retire(&mut self, key_id: u16, compromised: bool) -> Outcome {
        let admin = self.admin.clone();
        self.exec(
            &admin,
            &ExecuteMsg::RetireSignerKey {
                key_id,
                compromised,
            },
            0,
        )
    }

    fn admin_exec(&mut self, msg: ExecuteMsg) -> Outcome {
        let admin = self.admin.clone();
        self.exec(&admin, &msg, 0)
    }
}

#[derive(Default)]
struct Sizes {
    /// namespace -> (records, max value bytes, total value bytes, max key bytes)
    by_ns: std::collections::BTreeMap<String, (usize, usize, usize, usize)>,
}

// ------------------------------------------------------------------ report
struct Report {
    rows: Vec<Row>,
}

impl Report {
    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        group: &str,
        path: &str,
        shape: &str,
        seats: usize,
        keys: usize,
        ckpts: usize,
        out: &Outcome,
    ) -> Row {
        let row = Row {
            group: group.to_string(),
            path: path.to_string(),
            shape: shape.to_string(),
            seats,
            keys,
            ckpts,
            vm_gas: out.vm_gas,
            ops: out.ops,
            event_gas: event_gas(&out.ok),
            sends: bank_sends(&out.ok),
            msg_bytes: out.msg_bytes,
        };
        self.rows.push(row.clone());
        row
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wasm = std::fs::read(&args[1]).expect("wasm path");
    let json_out = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| "gas-rows.json".to_string());
    let dir = tempfile::tempdir().unwrap();
    let cache: VmCache = unsafe {
        Cache::new(CacheOptions::new(
            dir.path(),
            capabilities_from_csv(CAPABILITIES),
            Size::mebi(200),
            Size::mebi(32),
        ))
        .unwrap()
    };
    // checked = true: cosmwasm-vm 3.0.5 static validation with default limits.
    let checksum = cache
        .store_code(&wasm, true, true)
        .expect("VM 3.0.5 static validation");
    let analysis = cache.analyze(&checksum).unwrap();
    eprintln!(
        "stored checked: {} ({} bytes); required capabilities: {:?}; entrypoints: {:?}",
        checksum,
        wasm.len(),
        analysis.required_capabilities,
        analysis.entrypoints
    );
    let cache = Rc::new(cache);
    let mut r = Report { rows: vec![] };
    let new_world = || World::new(cache.clone(), checksum, 20);
    let mut sizes = Sizes::default();

    // ================================================================ FUNDING
    {
        let mut w = new_world();
        let (id7, out) = w.create(7);
        r.add(
            "funding",
            "CreateGame",
            "7-max Live game, creator funds ante (subsidy send to treasury)",
            1,
            1,
            0,
            &out,
        );
        let out = w.join(id7, 1);
        r.add(
            "funding",
            "Join → seat 2 of 7",
            "second seat, game stays FUNDING",
            2,
            1,
            0,
            &out,
        );
        for s in 2..6 {
            w.join(id7, s);
        }
        let out = w.join(id7, 6);
        r.add(
            "funding",
            "Join → seat 7 of 7",
            "last seat fills the game (→ FUNDED)",
            7,
            1,
            0,
            &out,
        );
        let (id2, _) = w.create(2);
        let out = w.join(id2, 1);
        r.add(
            "funding",
            "Join → seat 2 of 2",
            "2-max game fills (→ FUNDED)",
            2,
            1,
            0,
            &out,
        );
        let out = w.start(id7);
        r.add(
            "funding",
            "Start",
            "operator starts FUNDED 7-seat game (roster hash, resolver snapshot)",
            7,
            1,
            0,
            &out,
        );
        let out = w.start(id2);
        r.add(
            "funding",
            "Start",
            "operator starts FUNDED 2-seat game",
            2,
            1,
            0,
            &out,
        );
    }

    // ============================================================ IN_PROGRESS
    {
        let mut w = new_world();
        let g = w.started(7);
        let out = w.checkpoint(g, 10, 7, 1);
        r.add(
            "in_progress",
            "Checkpoint (first)",
            "no stored checkpoint yet; key 1",
            7,
            1,
            0,
            &out,
        );
        let out = w.checkpoint(g, 20, 7, 1);
        r.add(
            "in_progress",
            "Checkpoint (replace own)",
            "key 1 overwrites its record",
            7,
            1,
            1,
            &out,
        );

        let g2 = w.started(2);
        let (_, out) = w.settle(g2, 30, 2, 1, &[]);
        r.add(
            "in_progress",
            "Settle",
            "2 seats, no consents (→ SETTLEABLE)",
            2,
            1,
            0,
            &out,
        );
        let (_, out) = w.settle(g, 30, 7, 1, &[]);
        r.add(
            "in_progress",
            "Settle",
            "7 seats, no consents, 1 checkpoint stored (→ SETTLEABLE)",
            7,
            1,
            1,
            &out,
        );

        let g2b = w.started(2);
        let (_, out) = w.settle(g2b, 30, 2, 1, &[0, 1]);
        r.add(
            "in_progress",
            "Settle + all consents",
            "2 seats, 2 consents: pays at once",
            2,
            1,
            0,
            &out,
        );
        let g7b = w.started(7);
        let (_, out) = w.settle(g7b, 30, 7, 1, &[0, 1, 2, 3, 4, 5, 6]);
        r.add(
            "in_progress",
            "Settle + all consents",
            "7 seats, 7 consents: pays at once (8 secp256k1 verifies)",
            7,
            1,
            0,
            &out,
        );

        // LivenessSettle from IN_PROGRESS.
        let gl = w.started(7);
        w.checkpoint(gl, 10, 7, 1);
        let gr = w.started(7);
        w.advance(14 * DAY + 60);
        let p = w.payload(gl, KIND_CHECKPOINT, REASON_ROUND_BOUNDARY, 40, 7, 1);
        let (payload, signature) = w.signed(&p);
        let out = w.liveness(gl, Some(SignedCheckpoint { payload, signature }));
        r.add(
            "in_progress",
            "LivenessSettle carrying checkpoint",
            "14 d idle; carried newer key-1 checkpoint recorded then promoted (→ SETTLEABLE)",
            7,
            1,
            1,
            &out,
        );
        let out = w.liveness(gr, None);
        r.add(
            "in_progress",
            "LivenessSettle (no evidence)",
            "14 d idle, no checkpoint: refunds 7 net deposits",
            7,
            1,
            0,
            &out,
        );
        w.dump_into(&mut sizes);
    }

    // ============================================================= SETTLEABLE
    {
        let mut w = new_world();
        let (_, _) = w.add_key(); // key 2
        let (_, _) = w.add_key(); // key 3
        let gc = w.started(7);
        let (p, _) = w.settle(gc, 30, 7, 1, &[]);
        let out = w.consent(gc, &p, 0);
        r.add(
            "settleable",
            "Consent (1 of 7)",
            "first consent, not completing",
            7,
            3,
            0,
            &out,
        );
        for s in 1..6 {
            w.consent(gc, &p, s);
        }
        let out = w.consent(gc, &p, 6);
        r.add(
            "settleable",
            "Consent (7 of 7, completing)",
            "completes N-of-N: pays 7 seats",
            7,
            3,
            0,
            &out,
        );

        let gf = w.started(7);
        w.settle(gf, 30, 7, 1, &[]);
        let gt = w.started(7);
        w.settle(gt, 30, 7, 1, &[]);
        // compromised: checkpoint under key 2, settlement under key 3.
        let gcf = w.started(7);
        w.checkpoint(gcf, 10, 7, 2);
        w.settle(gcf, 30, 7, 3, &[]);
        let gcr = w.started(7);
        w.settle(gcr, 30, 7, 3, &[]);
        w.advance(DAY + 60);
        let out = w.exec(
            &w.outsider.clone(),
            &ExecuteMsg::Finalize { chain_game_id: gf },
            0,
        );
        r.add(
            "settleable",
            "Finalize",
            "after the 1-day window: pays 7 seats",
            7,
            3,
            0,
            &out,
        );
        let out = w.retire(3, true);
        r.add(
            "admin",
            "RetireSignerKey (compromised)",
            "key 3 of 3 marked compromised",
            0,
            3,
            0,
            &out,
        );
        w.advance(14 * DAY);
        let out = w.liveness(gt, None);
        r.add(
            "settleable",
            "LivenessSettle, trusted signer",
            "window_end + 14 d: pays stored settlement (key 1)",
            7,
            3,
            0,
            &out,
        );
        let out = w.liveness(gcf, None);
        r.add(
            "settleable",
            "LivenessSettle, compromised → checkpoint",
            "settlement key 3 compromised; promotes key-2 checkpoint (→ fresh SETTLEABLE)",
            7,
            3,
            1,
            &out,
        );
        let out = w.liveness(gcr, None);
        r.add(
            "settleable",
            "LivenessSettle, compromised → refund",
            "settlement key 3 compromised, no trusted checkpoint: refunds 7",
            7,
            3,
            0,
            &out,
        );
        w.dump_into(&mut sizes);
    }

    // =============================================================== DISPUTED
    {
        let mut w = new_world();
        let gu = w.started(7);
        w.settle(gu, 30, 7, 1, &[]);
        let out = w.challenge(gu);
        r.add(
            "disputed",
            "Challenge",
            "seat posts bond inside the window (→ DISPUTED)",
            7,
            1,
            0,
            &out,
        );
        let out = w.resolve(gu, ResolveOutcome::Uphold {});
        r.add(
            "disputed",
            "Resolve Uphold",
            "pays stored weights + bond to pool",
            7,
            1,
            0,
            &out,
        );

        let grp = w.started(7);
        w.checkpoint(grp, 10, 7, 1);
        w.settle(grp, 30, 7, 1, &[]);
        w.challenge(grp);
        let p = w.payload(grp, KIND_TERMINAL, REASON_RESOLVER_CORRECTION, 31, 7, 1);
        let out = w.resolve(
            grp,
            ResolveOutcome::Replace {
                payload: SettlementPayloadV1::try_from(&p).unwrap(),
            },
        );
        r.add(
            "disputed",
            "Resolve Replace",
            "resolver vector pays 7 seats, bond returned; 1 checkpoint scanned",
            7,
            1,
            1,
            &out,
        );

        let ga = w.started(7);
        w.settle(ga, 30, 7, 1, &[]);
        w.challenge(ga);
        let out = w.resolve(ga, ResolveOutcome::Annul {});
        r.add(
            "disputed",
            "Resolve Annul",
            "refunds 7 net deposits, bond handled",
            7,
            1,
            0,
            &out,
        );

        let gto = w.started(7);
        w.settle(gto, 30, 7, 1, &[]);
        w.challenge(gto);
        w.advance(30 * DAY + 60);
        let out = w.liveness(gto, None);
        r.add(
            "disputed",
            "LivenessSettle, resolver timeout",
            "30 d without resolution: pays stored (trusted) + bond back",
            7,
            1,
            0,
            &out,
        );

        let gab = w.started(7);
        w.checkpoint(gab, 10, 7, 1);
        let out = w.annul(gab, 7);
        r.add(
            "in_progress",
            "AnnulByConsent",
            "7 seat signatures over (domain, trusted_seq): refunds 7",
            7,
            1,
            1,
            &out,
        );
        w.dump_into(&mut sizes);
    }

    // ================================================================= ADMIN
    {
        let mut w = new_world();
        let (_, out) = w.add_key();
        r.add("admin", "AddSignerKey", "registers key 2", 0, 2, 0, &out);
        let out = w.retire(2, false);
        r.add(
            "admin",
            "RetireSignerKey (planned)",
            "key 2 retired, not compromised",
            0,
            2,
            0,
            &out,
        );
        // Emergency rotation: a SETTLEABLE game and an IN_PROGRESS game under key 1.
        let gs = w.started(7);
        w.settle(gs, 30, 7, 1, &[]);
        let gp = w.started(7);
        w.checkpoint(gp, 10, 7, 1);
        let o1 = w.admin_exec(ExecuteMsg::Pause {});
        r.add("admin", "Pause", "emergency rotation step 1", 0, 2, 0, &o1);
        let o2 = w.retire(1, true);
        r.add(
            "admin",
            "RetireSignerKey (compromised)",
            "emergency rotation step 2: key 1",
            0,
            2,
            0,
            &o2,
        );
        let (k3, o3) = w.add_key();
        r.add(
            "admin",
            "AddSignerKey",
            "emergency rotation step 3: key 3",
            0,
            3,
            0,
            &o3,
        );
        let o4 = w.checkpoint(gp, 20, 7, k3);
        r.add(
            "admin",
            "Checkpoint (fresh key, while paused)",
            "emergency rotation step 4: re-post under key 3",
            7,
            3,
            1,
            &o4,
        );
        let o5 = w.admin_exec(ExecuteMsg::Unpause {});
        r.add(
            "admin",
            "Unpause",
            "emergency rotation step 5",
            0,
            3,
            0,
            &o5,
        );
    }

    // ======================================================== 64-KEY SCALING
    let ks = [1usize, 2, 4, 8, 16, 32, 48, 63, 64];
    for &k in &ks {
        let mut w = new_world();
        let mut add_row = None;
        for _ in 2..=k {
            let (_, out) = w.add_key();
            add_row = Some(out);
        }
        if let Some(out) = add_row {
            r.add(
                "scaling",
                "AddSignerKey",
                &format!("registers key {k}"),
                0,
                k,
                0,
                &out,
            );
        }
        let ga = w.started(7);
        let gb = w.started(7);
        let gc = w.started(7);
        let gd = w.started(7);
        let ge = w.started(7);
        for key in 1..k {
            let ll = 10 * key as u64;
            for g in [ga, gb, gc, gd, ge] {
                w.checkpoint(g, ll, 7, key as u16);
            }
        }
        let ll = 10 * k as u64;
        let out = w.checkpoint(ga, ll, 7, k as u16);
        r.add(
            "scaling",
            "Checkpoint",
            &format!("k-th key's first checkpoint over {} stored", k - 1),
            7,
            k,
            k - 1,
            &out,
        );
        for g in [gb, gc, gd, ge] {
            w.checkpoint(g, ll, 7, k as u16);
        }
        let (_, out) = w.settle(ga, ll + 5, 7, 1, &[]);
        r.add(
            "scaling",
            "Settle",
            &format!("7 seats, no consents, {k} checkpoints"),
            7,
            k,
            k,
            &out,
        );
        let out = w.annul(gd, 7);
        r.add(
            "scaling",
            "AnnulByConsent",
            &format!("7 sigs, {k} checkpoints"),
            7,
            k,
            k,
            &out,
        );
        let (_, qo) = w.query_raw(&QueryMsg::Game { chain_game_id: ga });
        r.add(
            "scaling",
            "query Game",
            &format!("{k} checkpoints"),
            7,
            k,
            k,
            &qo,
        );
        let (cb, qo) = w.query_raw(&QueryMsg::Checkpoints { chain_game_id: ga });
        let cr: CheckpointsResponse = serde_json::from_slice(&cb).unwrap();
        assert_eq!(cr.checkpoints.len(), k);
        r.add(
            "scaling",
            "query Checkpoints",
            &format!("{k} checkpoints ({} response bytes)", cb.len()),
            7,
            k,
            k,
            &qo,
        );
        // E: dispute on a settlement over k checkpoints, resolved by Replace.
        w.settle(ge, ll + 5, 7, 1, &[]);
        w.challenge(ge);
        let p = w.payload(ge, KIND_TERMINAL, REASON_RESOLVER_CORRECTION, ll + 6, 7, 1);
        let out = w.resolve(
            ge,
            ResolveOutcome::Replace {
                payload: SettlementPayloadV1::try_from(&p).unwrap(),
            },
        );
        r.add(
            "scaling",
            "Resolve Replace",
            &format!("floor scan over {k} checkpoints; pays 7"),
            7,
            k,
            k,
            &out,
        );
        // C: settlement under key k, later compromised.
        w.settle(gc, ll + 5, 7, k as u16, &[]);
        w.advance(14 * DAY + 60);
        // B: carried checkpoint under key k (still active).
        let p = w.payload(
            gb,
            KIND_CHECKPOINT,
            REASON_ROUND_BOUNDARY,
            ll + 7,
            7,
            k as u16,
        );
        let (payload, signature) = w.signed(&p);
        let out = w.liveness(gb, Some(SignedCheckpoint { payload, signature }));
        r.add(
            "scaling",
            "LivenessSettle carrying checkpoint",
            &format!("IN_PROGRESS, {k} checkpoints"),
            7,
            k,
            k,
            &out,
        );
        let out = w.retire(k as u16, true);
        r.add(
            "scaling",
            "RetireSignerKey (compromised)",
            &format!("key {k} of {k}"),
            0,
            k,
            0,
            &out,
        );
        w.advance(DAY + 60);
        let out = w.liveness(gc, None);
        let route = if k == 1 {
            "refund (no trusted checkpoint)"
        } else {
            "promotes best of k−1 trusted"
        };
        r.add(
            "scaling",
            "LivenessSettle, compromised settlement",
            &format!("{k} checkpoints scanned, key {k} skipped: {route}"),
            7,
            k,
            k,
            &out,
        );
        if k == 64 {
            w.dump_into(&mut sizes);
        }
    }

    // ============================================ WORST-CASE ADDRESS LENGTH
    // Seats held by 32-byte (63-char) addresses, e.g. multisig/DAO contracts.
    {
        let mut w = World::new(cache.clone(), checksum, 32);
        let (id, _) = w.create(7);
        for s in 1..6 {
            w.join(id, s);
        }
        let out = w.join(id, 6);
        r.add(
            "wide_addr",
            "Join → seat 7 of 7",
            "63-char seat addresses",
            7,
            1,
            0,
            &out,
        );
        w.start(id);
        let out = w.checkpoint(id, 10, 7, 1);
        r.add(
            "wide_addr",
            "Checkpoint (first)",
            "63-char seat addresses",
            7,
            1,
            0,
            &out,
        );
        let (_, out) = w.settle(id, 30, 7, 1, &[0, 1, 2, 3, 4, 5, 6]);
        r.add(
            "wide_addr",
            "Settle + all consents",
            "63-char seat addresses, 7 consents",
            7,
            1,
            1,
            &out,
        );
        let g = w.started(7);
        w.checkpoint(g, 10, 7, 1);
        w.settle(g, 30, 7, 1, &[]);
        w.challenge(g);
        let p = w.payload(g, KIND_TERMINAL, REASON_RESOLVER_CORRECTION, 31, 7, 1);
        let out = w.resolve(
            g,
            ResolveOutcome::Replace {
                payload: SettlementPayloadV1::try_from(&p).unwrap(),
            },
        );
        r.add(
            "wide_addr",
            "Resolve Replace",
            "63-char seat addresses; pays 7 + bond",
            7,
            1,
            1,
            &out,
        );
        let gf = w.started(7);
        w.settle(gf, 30, 7, 1, &[]);
        w.advance(DAY + 60);
        let o = w.outsider.clone();
        let out = w.exec(&o, &ExecuteMsg::Finalize { chain_game_id: gf }, 0);
        r.add(
            "wide_addr",
            "Finalize",
            "63-char seat addresses; pays 7",
            7,
            1,
            0,
            &out,
        );
        let mut wide = Sizes::default();
        w.dump_into(&mut wide);
        for (ns, (n, max, total, maxk)) in &wide.by_ns {
            eprintln!("wide-addr state: {ns}: {n} records, max value {max} B, total {total} B, max key {maxk} B");
        }
    }

    // ================================================================ output
    let rows_json: Vec<Value> = r.rows.iter().map(Row::json).collect();
    std::fs::write(&json_out, serde_json::to_string_pretty(&json!({
        "vm": "cosmwasm-vm 3.0.5 (singlepass, metering)",
        "checksum": checksum.to_string(),
        "model": {"gas_multiplier": GAS_MULTIPLIER, "instance_cost": INSTANCE_COST, "prefix_len": PREFIX_LEN,
                  "kv": "read 1000+3/B, write 2000+30/B, delete 1000, iter 30/step + 3/B",
                  "bank_send_estimate": BANK_SEND_EST},
        "rows": rows_json,
    })).unwrap()).unwrap();

    for (ns, (n, max, total, maxk)) in &sizes.by_ns {
        eprintln!("state: {ns}: {n} records, max value {max} B, total {total} B, max key {maxk} B");
    }
    println!("| group | path | shape | seats | keys | ckpts | VM gas (CW) | wasm SDK | KV SDK (r/w/iter) | events | contract SDK | sends | est. total |");
    println!("|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
    for x in &r.rows {
        println!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} ({}/{}/{}) | {} | {} | {} | {} |",
            x.group,
            x.path,
            x.shape,
            x.seats,
            x.keys,
            x.ckpts,
            x.vm_gas,
            x.wasm_sdk(),
            x.ops.kv_gas(),
            x.ops.reads,
            x.ops.writes,
            x.ops.nexts,
            x.event_gas,
            x.contract_gas(),
            x.sends,
            x.est_total()
        );
    }
}
