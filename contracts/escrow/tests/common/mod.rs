//! Shared cw-multi-test harness for the escrow contract.
//!
//! * Addresses are real `juno1…` bech32 (`MockApiBech32`), contract addresses
//!   follow wasmd's classic derivation (`MockAddressGenerator`), and the chain id
//!   is configurable, so settlement domains are realistic and match the Python
//!   vectors in `testdata/payload_vectors_v1.json`.
//! * Keys are deterministic: secret = SHA-256(label). The settlement signer is
//!   "18JUNO/TEST/signer/1" (key id 1); seat i's consent key is
//!   "18JUNO/TEST/seat/i" for the player at index i of `PLAYER_LABELS`; the
//!   join-admission key is "18JUNO/TEST/admission/1"; the escrow 2.1.0 remedy
//!   key is "18JUNO/TEST/remedy/1" (remedy key id 1).
//! * Every `Join` built here carries a valid admission for its SENDER (expiry
//!   `ADMISSION_TTL` after the current block time), so the older suites keep
//!   testing what they tested; `tests/join_admission.rs` attacks the admission.
//! * Signatures are RFC 6979 (k256), low-s.
#![allow(dead_code)]

use cosmwasm_std::{coin, coins, Addr, BlockInfo, Coin, HexBinary, Timestamp, Uint128, Uint64};
use cw_multi_test::addons::{MockAddressGenerator, MockApiBech32};
use cw_multi_test::{
    App, AppBuilder, AppResponse, BankKeeper, ContractWrapper, Executor, WasmKeeper,
};
use eighteen_cosmos_escrow::contract::{execute, instantiate, migrate, query};
use eighteen_cosmos_escrow::crypto;
use eighteen_cosmos_escrow::msg::{
    CheckpointsResponse, ConfigResponse, DeadlineChoice, ExecuteMsg, GameResponse, InstantiateMsg,
    JoinAdmission, QueryMsg, RemedyApproval, RemedyAttestationV1, ResolveOutcome, SeatSignature,
    SettlementPayloadV1, SignedCheckpoint,
};
use eighteen_cosmos_escrow::payload::{Payload, KIND_CHECKPOINT, KIND_TERMINAL};
use eighteen_cosmos_escrow::remedy::RemedyAttestation;
use eighteen_cosmos_escrow::state::{GameParams, GameState, Mode, RemedyKind};
use eighteen_cosmos_escrow::ContractError;
use k256::ecdsa::signature::hazmat::PrehashSigner;
use k256::ecdsa::{Signature, SigningKey};
use sha2::{Digest, Sha256};

pub type TestApp = App<BankKeeper, MockApiBech32>;

pub const DENOM: &str = "ujuno";
pub const MAINNET: &str = "juno-1";
pub const TESTNET: &str = "uni-7";
pub const GENESIS_SECS: u64 = 1_790_000_000;
pub const ANTE: u128 = 2_000_000;
pub const NET: u128 = 1_950_000;
pub const SUBSIDY: u128 = 50_000;
pub const RULES_ENGINE_VERSION: u32 = 10;
pub const DAY: u64 = 24 * 60 * 60;
pub const HOUR: u64 = 60 * 60;
pub const RICH: u128 = 1_000_000_000_000_000_000_000_000_000_000_000;
/// How long a test admission stays valid after the block it was issued in.
pub const ADMISSION_TTL: u64 = 15 * 60;

/// Wallet labels, seat i uses consent key "18JUNO/TEST/seat/i".
pub const PLAYER_LABELS: [&str; 8] = [
    "creator", "alice", "bob", "carol", "dave", "erin", "frank", "grace",
];

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

pub fn variants_digest() -> HexBinary {
    HexBinary::from(sha256(&[b"18JUNO/TEST/variants"]).as_slice())
}

pub fn ticket(label: &str) -> HexBinary {
    HexBinary::from(sha256(&[b"18JUNO/TEST/ticket/", label.as_bytes()]).as_slice())
}

pub fn default_params() -> GameParams {
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

/// A deterministic secp256k1 test key.
#[derive(Clone)]
pub struct Key {
    pub sk: SigningKey,
    pub pubkey: HexBinary,
}

impl Key {
    pub fn from_label(label: &str) -> Key {
        let secret = sha256(&[label.as_bytes()]);
        let sk = SigningKey::from_slice(&secret).expect("valid test scalar");
        let pubkey = HexBinary::from(sk.verifying_key().to_encoded_point(true).as_bytes());
        Key { sk, pubkey }
    }

    pub fn seat(i: usize) -> Key {
        Key::from_label(&format!("18JUNO/TEST/seat/{i}"))
    }

    pub fn signer(n: usize) -> Key {
        Key::from_label(&format!("18JUNO/TEST/signer/{n}"))
    }

    pub fn admission(n: usize) -> Key {
        Key::from_label(&format!("18JUNO/TEST/admission/{n}"))
    }

    /// Escrow 2.1.0: the n-th test REMEDY attestation key.
    pub fn remedy(n: usize) -> Key {
        Key::from_label(&format!("18JUNO/TEST/remedy/{n}"))
    }

    pub fn sign_bytes(&self, digest: &[u8; 32]) -> [u8; 64] {
        let sig: Signature = self.sk.sign_prehash(digest).expect("sign");
        let bytes: [u8; 64] = sig.to_bytes().into();
        bytes
    }

    pub fn sign(&self, digest: &[u8; 32]) -> HexBinary {
        HexBinary::from(self.sign_bytes(digest).as_slice())
    }

    /// The same signature with `s` replaced by `n − s` (valid, but high-s).
    pub fn sign_high_s(&self, digest: &[u8; 32]) -> HexBinary {
        HexBinary::from(high_s(self.sign_bytes(digest)).as_slice())
    }
}

/// secp256k1 group order.
pub const ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// `r ‖ (n − s)`.
pub fn high_s(sig: [u8; 64]) -> [u8; 64] {
    let mut out = sig;
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut v = ORDER[i] as i16 - sig[32 + i] as i16 - borrow;
        if v < 0 {
            v += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[32 + i] = v as u8;
    }
    out
}

/// Extracts the contract's own error from a cw-multi-test error (the wasm
/// layer adds context; anyhow downcasts through it).
pub fn contract_err(err: anyhow::Error) -> ContractError {
    match err.downcast::<ContractError>() {
        Ok(e) => e,
        Err(other) => panic!("not a contract error: {other:?}"),
    }
}

/// A test environment: one instantiated escrow contract and a cast of wallets.
pub struct Suite {
    pub app: TestApp,
    pub code_id: u64,
    pub contract: Addr,
    pub admin: Addr,
    pub operator: Addr,
    pub resolver: Addr,
    pub treasury: Addr,
    pub outsider: Addr,
    /// `PLAYER_LABELS` wallets; players[i] signs consents with `Key::seat(i)`.
    pub players: Vec<Addr>,
    pub signer: Key,
    /// Signs the admissions `join_msg` builds (the contract's current key).
    pub admission: Key,
    /// Escrow 2.1.0: the remedy key registered as remedy key id 1.
    pub remedy: Key,
    /// Escrow 2.1.0: when set, every game `create` (and so every fixture
    /// helper) makes is an Async No-deadline game, whatever mode the caller
    /// names. Default: off (a Timed game in the named mode: Live action clock,
    /// or the Async pace `async_pace`).
    pub no_deadline: bool,
    /// The pace of the Timed Async games `create` makes (default 1 day).
    pub async_pace: u64,
    /// When set, every game `create` makes is an Async game, whatever mode
    /// the caller names (a Timed Async game unless `no_deadline`).
    pub force_async: bool,
    /// When set, every game `create` makes is immediately rewritten into the
    /// shape escrow 2.0.0 code stored (`make_legacy`): the 2.0.0 semantics a
    /// migrated 2.0.0 game keeps. The 2.0.0 suites (liveness, OD-ESC2-1/4, the
    /// compromised-settlement recovery) run on such games.
    pub legacy: bool,
}

pub struct SuiteBuilder {
    pub chain_id: String,
    pub params: GameParams,
    pub signer_keys: Vec<HexBinary>,
    pub remedy_keys: Vec<HexBinary>,
    pub balance: u128,
    pub admission: Key,
}

impl Default for SuiteBuilder {
    fn default() -> Self {
        SuiteBuilder {
            chain_id: MAINNET.to_string(),
            params: default_params(),
            signer_keys: vec![Key::signer(1).pubkey],
            remedy_keys: vec![Key::remedy(1).pubkey],
            balance: RICH,
            admission: Key::admission(1),
        }
    }
}

impl SuiteBuilder {
    pub fn chain_id(mut self, chain_id: &str) -> Self {
        self.chain_id = chain_id.to_string();
        self
    }

    pub fn params(mut self, params: GameParams) -> Self {
        self.params = params;
        self
    }

    pub fn build(self) -> Suite {
        let api = MockApiBech32::new("juno");
        let admin = api.addr_make("admin");
        let operator = api.addr_make("operator");
        let resolver = api.addr_make("resolver");
        let treasury = api.addr_make("treasury");
        let outsider = api.addr_make("mallory");
        let players: Vec<Addr> = PLAYER_LABELS.iter().map(|l| api.addr_make(l)).collect();
        let mut funded: Vec<Addr> = players.clone();
        funded.extend([
            admin.clone(),
            operator.clone(),
            resolver.clone(),
            outsider.clone(),
        ]);
        let balance = self.balance;
        let mut app: TestApp = AppBuilder::new()
            .with_api(api)
            .with_wasm(WasmKeeper::new().with_address_generator(MockAddressGenerator))
            .with_block(BlockInfo {
                height: 1,
                time: Timestamp::from_seconds(GENESIS_SECS),
                chain_id: self.chain_id.clone(),
            })
            .build(|router, _api, storage| {
                for who in &funded {
                    router
                        .bank
                        .init_balance(
                            storage,
                            who,
                            vec![coin(balance, DENOM), coin(balance, "uatom")],
                        )
                        .unwrap();
                }
            });
        let code_id = app.store_code(Box::new(
            ContractWrapper::new(execute, instantiate, query).with_migrate(migrate),
        ));
        let contract = app
            .instantiate_contract(
                code_id,
                admin.clone(),
                &InstantiateMsg {
                    admin: admin.to_string(),
                    operator: operator.to_string(),
                    resolver: resolver.to_string(),
                    treasury: treasury.to_string(),
                    denom: DENOM.to_string(),
                    params: self.params,
                    signer_keys: self.signer_keys,
                    admission_pubkey: self.admission.pubkey.clone(),
                    remedy_keys: self.remedy_keys,
                },
                &[],
                "18cosmos-escrow",
                Some(admin.to_string()),
            )
            .unwrap();
        Suite {
            app,
            code_id,
            contract,
            admin,
            operator,
            resolver,
            treasury,
            outsider,
            players,
            signer: Key::signer(1),
            admission: self.admission,
            remedy: Key::remedy(1),
            no_deadline: false,
            async_pace: DAY,
            force_async: false,
            legacy: false,
        }
    }
}

impl Suite {
    pub fn new() -> Suite {
        SuiteBuilder::default().build()
    }

    /// A suite whose games all have escrow 2.0.0 semantics (see `legacy`).
    pub fn new_legacy() -> Suite {
        let mut s = Suite::new();
        s.legacy = true;
        s
    }

    pub fn addr(&self, label: &str) -> Addr {
        self.app.api().addr_make(label)
    }

    // ------------------------------------------------------------ execution
    pub fn exec(
        &mut self,
        sender: &Addr,
        msg: &ExecuteMsg,
        funds: &[Coin],
    ) -> Result<AppResponse, ContractError> {
        self.app
            .execute_contract(sender.clone(), self.contract.clone(), msg, funds)
            .map_err(contract_err)
    }

    pub fn now(&self) -> Timestamp {
        self.app.block_info().time
    }

    pub fn advance(&mut self, secs: u64) {
        self.app.update_block(|b| {
            b.time = b.time.plus_seconds(secs);
            b.height += 1.max(secs / 5);
        });
    }

    pub fn balance(&self, who: &Addr) -> u128 {
        self.app
            .wrap()
            .query_balance(who.to_string(), DENOM)
            .unwrap()
            .amount
            .u128()
    }

    pub fn contract_balance(&self) -> u128 {
        self.balance(&self.contract)
    }

    // --------------------------------------------------------------- queries
    pub fn game(&self, id: u64) -> GameResponse {
        self.app
            .wrap()
            .query_wasm_smart(self.contract.clone(), &QueryMsg::Game { chain_game_id: id })
            .unwrap()
    }

    pub fn state(&self, id: u64) -> GameState {
        self.game(id).game.state
    }

    pub fn config(&self) -> ConfigResponse {
        self.app
            .wrap()
            .query_wasm_smart(self.contract.clone(), &QueryMsg::Config {})
            .unwrap()
    }

    pub fn checkpoints(&self, id: u64) -> CheckpointsResponse {
        self.app
            .wrap()
            .query_wasm_smart(
                self.contract.clone(),
                &QueryMsg::Checkpoints { chain_game_id: id },
            )
            .unwrap()
    }

    pub fn domain(&self, id: u64) -> [u8; 32] {
        let d = self.game(id).game.domain.expect("started game");
        d.as_slice().try_into().unwrap()
    }

    /// Raw history: the highest seq ever accepted.
    pub fn last_seq(&self, id: u64) -> u64 {
        self.game(id).game.last_seq.u64()
    }

    /// Sequence authority: the highest seq among evidence whose key is trusted.
    pub fn trusted_seq(&self, id: u64) -> u64 {
        self.game(id).trusted_seq.u64()
    }

    /// The resolver the game adopted at Start.
    pub fn game_resolver(&self, id: u64) -> Option<Addr> {
        self.game(id).game.resolver
    }

    // ------------------------------------------------------------- funding
    pub fn create_msg(max_players: u8, mode: Mode, seat: usize) -> ExecuteMsg {
        Self::create_msg_with(max_players, mode, seat, false)
    }

    /// `CreateGame` with `no_deadline` choosing the escrow 2.1.0 deadline
    /// class: `true` = `NoDeadline`, `false` = the mode's timed class (Live
    /// action clock, or a 1-day Async pace).
    pub fn create_msg_with(
        max_players: u8,
        mode: Mode,
        seat: usize,
        no_deadline: bool,
    ) -> ExecuteMsg {
        let deadline = match (no_deadline, mode) {
            (true, _) => DeadlineChoice::NoDeadline {},
            (false, Mode::Live) => DeadlineChoice::LiveActionClock {},
            (false, Mode::Async) => DeadlineChoice::AsyncPace {
                allowance_secs: DAY,
            },
        };
        Self::create_msg_deadline(max_players, mode, seat, deadline)
    }

    /// `CreateGame` with an explicit escrow 2.1.0 deadline class.
    pub fn create_msg_deadline(
        max_players: u8,
        mode: Mode,
        seat: usize,
        deadline: DeadlineChoice,
    ) -> ExecuteMsg {
        ExecuteMsg::CreateGame {
            max_players,
            mode,
            rules_engine_version: RULES_ENGINE_VERSION,
            variants_digest: variants_digest(),
            consent_pubkey: Key::seat(seat).pubkey,
            join_ticket: ticket(PLAYER_LABELS[seat]),
            deadline,
        }
    }

    /// The JOIN digest for `wallet` on this suite's chain and contract.
    pub fn admission_digest(
        &self,
        id: u64,
        wallet: &Addr,
        ticket: &HexBinary,
        expires_at: u64,
    ) -> [u8; 32] {
        let chain_id = self.app.block_info().chain_id;
        crypto::join_admission_digest(
            &chain_id,
            self.contract.as_str(),
            id,
            wallet.as_str(),
            &ticket.as_slice().try_into().expect("32-byte ticket"),
            expires_at,
        )
        .unwrap()
    }

    /// A valid admission for `wallet` (the future sender) until `expires_at`.
    pub fn admission_until(
        &self,
        id: u64,
        wallet: &Addr,
        ticket: &HexBinary,
        expires_at: u64,
    ) -> JoinAdmission {
        JoinAdmission {
            expires_at: Uint64::new(expires_at),
            signature: self
                .admission
                .sign(&self.admission_digest(id, wallet, ticket, expires_at)),
        }
    }

    /// A valid admission for `wallet`, expiring `ADMISSION_TTL` from now.
    pub fn admission_for(&self, id: u64, wallet: &Addr, ticket: &HexBinary) -> JoinAdmission {
        let expires_at = self.now().seconds() + ADMISSION_TTL;
        self.admission_until(id, wallet, ticket, expires_at)
    }

    /// `players[seat]` joins with seat `seat`'s consent key and ticket.
    pub fn join_msg(&self, id: u64, seat: usize) -> ExecuteMsg {
        let wallet = self.players[seat].clone();
        self.join_msg_as(id, &wallet, seat)
    }

    /// `sender` joins with seat `seat`'s consent key and ticket, admitted for
    /// `sender` itself.
    pub fn join_msg_as(&self, id: u64, sender: &Addr, seat: usize) -> ExecuteMsg {
        let join_ticket = ticket(PLAYER_LABELS[seat]);
        ExecuteMsg::Join {
            chain_game_id: id,
            consent_pubkey: Key::seat(seat).pubkey,
            admission: self.admission_for(id, sender, &join_ticket),
            join_ticket,
        }
    }

    /// Creates a game with `players[creator]` and returns its id.
    pub fn create(&mut self, creator: usize, max_players: u8, mode: Mode, ante: u128) -> u64 {
        let who = self.players[creator].clone();
        let mode = if self.force_async { Mode::Async } else { mode };
        let msg = if self.no_deadline {
            Self::create_msg_with(max_players, Mode::Async, creator, true)
        } else if mode == Mode::Async {
            Self::create_msg_deadline(
                max_players,
                mode,
                creator,
                DeadlineChoice::AsyncPace {
                    allowance_secs: self.async_pace,
                },
            )
        } else {
            Self::create_msg(max_players, mode, creator)
        };
        let res = self.exec(&who, &msg, &coins(ante, DENOM)).unwrap();
        let id = res
            .events
            .iter()
            .flat_map(|e| e.attributes.iter())
            .find(|a| a.key == "chain_game_id")
            .unwrap()
            .value
            .parse()
            .unwrap();
        if self.legacy {
            self.make_legacy(id);
        }
        id
    }

    pub fn join(&mut self, id: u64, seat: usize, ante: u128) {
        let who = self.players[seat].clone();
        let msg = self.join_msg(id, seat);
        self.exec(&who, &msg, &coins(ante, DENOM)).unwrap();
    }

    /// FUNDED game whose seat i is players[i], for i in 0..n.
    pub fn funded(&mut self, n: usize) -> u64 {
        self.funded_with(n, Mode::Live, ANTE)
    }

    pub fn funded_with(&mut self, n: usize, mode: Mode, ante: u128) -> u64 {
        let id = self.create(0, n as u8, mode, ante);
        for seat in 1..n {
            self.join(id, seat, ante);
        }
        id
    }

    pub fn roster_hash(&self, id: u64) -> HexBinary {
        let g = self.game(id).game;
        let wallets: Vec<String> = g.seats.iter().map(|s| s.wallet.to_string()).collect();
        HexBinary::from(crypto::roster_hash(&wallets).unwrap().as_slice())
    }

    pub fn start(&mut self, id: u64) {
        let rh = self.roster_hash(id);
        let op = self.operator.clone();
        self.exec(
            &op,
            &ExecuteMsg::Start {
                chain_game_id: id,
                roster_hash: rh,
            },
            &[],
        )
        .unwrap();
    }

    /// IN_PROGRESS game with n seats.
    pub fn started(&mut self, n: usize) -> u64 {
        let id = self.funded(n);
        self.start(id);
        id
    }

    pub fn started_with(&mut self, n: usize, mode: Mode, ante: u128) -> u64 {
        let id = self.funded_with(n, mode, ante);
        self.start(id);
        id
    }

    // -------------------------------------------------------------- payloads
    pub fn payload(
        &self,
        id: u64,
        kind: u8,
        reason: u8,
        log_len: u64,
        weights: &[u128],
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
            settlement_weights: weights.to_vec(),
            signer_key_id: 1,
            issued_at: 1_790_000_000,
        }
    }

    pub fn checkpoint_payload(&self, id: u64, log_len: u64, weights: &[u128]) -> Payload {
        self.payload(id, KIND_CHECKPOINT, 0, log_len, weights)
    }

    pub fn terminal_payload(&self, id: u64, reason: u8, log_len: u64, weights: &[u128]) -> Payload {
        self.payload(id, KIND_TERMINAL, reason, log_len, weights)
    }

    pub fn settle_digest(p: &Payload) -> [u8; 32] {
        crypto::settle_digest(&p.encode().unwrap())
    }

    pub fn wire(p: &Payload) -> SettlementPayloadV1 {
        SettlementPayloadV1::try_from(p).unwrap()
    }

    /// Wire payload + signer-1 signature.
    pub fn signed(&self, p: &Payload) -> (SettlementPayloadV1, HexBinary) {
        self.signed_by(p, &self.signer.clone())
    }

    pub fn signed_by(&self, p: &Payload, key: &Key) -> (SettlementPayloadV1, HexBinary) {
        (Self::wire(p), key.sign(&Self::settle_digest(p)))
    }

    pub fn checkpoint_msg(&self, id: u64, p: &Payload) -> ExecuteMsg {
        let (payload, signature) = self.signed(p);
        ExecuteMsg::Checkpoint {
            chain_game_id: id,
            payload,
            signature,
        }
    }

    /// A checkpoint at `log_len` signed by `key` under `key_id`, ready to be
    /// carried by `LivenessSettle`.
    pub fn signed_checkpoint(
        &self,
        id: u64,
        key_id: u16,
        key: &Key,
        log_len: u64,
        weights: &[u128],
    ) -> (Payload, SignedCheckpoint) {
        let mut p = self.checkpoint_payload(id, log_len, weights);
        p.signer_key_id = key_id;
        let (payload, signature) = self.signed_by(&p, key);
        (p, SignedCheckpoint { payload, signature })
    }

    pub fn post_checkpoint(&mut self, id: u64, log_len: u64, weights: &[u128]) -> Payload {
        let p = self.checkpoint_payload(id, log_len, weights);
        let msg = self.checkpoint_msg(id, &p);
        let who = self.outsider.clone();
        self.exec(&who, &msg, &[]).unwrap();
        p
    }

    pub fn consent_digest(&self, id: u64, p: &Payload) -> [u8; 32] {
        crypto::consent_digest(&self.domain(id), p.seq, &Self::settle_digest(p))
    }

    pub fn consents(&self, id: u64, p: &Payload, seats: &[usize]) -> Vec<SeatSignature> {
        let digest = self.consent_digest(id, p);
        seats
            .iter()
            .map(|&i| SeatSignature {
                seat_index: i as u8,
                signature: Key::seat(i).sign(&digest),
            })
            .collect()
    }

    pub fn settle_msg(&self, id: u64, p: &Payload, consent_seats: &[usize]) -> ExecuteMsg {
        let (payload, signature) = self.signed(p);
        ExecuteMsg::Settle {
            chain_game_id: id,
            payload,
            signature,
            consents: self.consents(id, p, consent_seats),
        }
    }

    /// `Settle` signed by `key` (the payload names its key id), no consents.
    pub fn settle_msg_by(&self, id: u64, p: &Payload, key: &Key) -> ExecuteMsg {
        let (payload, signature) = self.signed_by(p, key);
        ExecuteMsg::Settle {
            chain_game_id: id,
            payload,
            signature,
            consents: vec![],
        }
    }

    /// Settle with the given consents; returns the payload.
    pub fn settle(
        &mut self,
        id: u64,
        reason: u8,
        log_len: u64,
        weights: &[u128],
        consent_seats: &[usize],
    ) -> Payload {
        let p = self.terminal_payload(id, reason, log_len, weights);
        let msg = self.settle_msg(id, &p, consent_seats);
        let who = self.operator.clone();
        self.exec(&who, &msg, &[]).unwrap();
        p
    }

    pub fn annul_sigs(&self, id: u64, seats: &[usize], last_seq: u64) -> Vec<SeatSignature> {
        let digest = crypto::annul_digest(&self.domain(id), last_seq);
        seats
            .iter()
            .map(|&i| SeatSignature {
                seat_index: i as u8,
                signature: Key::seat(i).sign(&digest),
            })
            .collect()
    }

    /// The plain liveness exit.
    pub fn liveness_msg(id: u64) -> ExecuteMsg {
        ExecuteMsg::LivenessSettle {
            chain_game_id: id,
            checkpoint: None,
        }
    }

    /// `LivenessSettle` by `players[seat]`, optionally carrying a checkpoint.
    pub fn liveness(
        &mut self,
        id: u64,
        seat: usize,
        checkpoint: Option<SignedCheckpoint>,
    ) -> Result<AppResponse, ContractError> {
        let who = self.players[seat].clone();
        self.exec(
            &who,
            &ExecuteMsg::LivenessSettle {
                chain_game_id: id,
                checkpoint,
            },
            &[],
        )
    }

    pub fn bond(&self, id: u64) -> u128 {
        self.game(id).game.bond.unwrap().u128()
    }

    pub fn challenge(&mut self, id: u64, seat: usize) {
        let bond = self.bond(id);
        let who = self.players[seat].clone();
        let funds = if bond == 0 {
            vec![]
        } else {
            coins(bond, DENOM)
        };
        self.exec(
            &who,
            &ExecuteMsg::Challenge {
                chain_game_id: id,
                evidence_hash: HexBinary::from(sha256(&[b"evidence"]).as_slice()),
            },
            &funds,
        )
        .unwrap();
    }

    pub fn resolve(
        &mut self,
        id: u64,
        outcome: ResolveOutcome,
    ) -> Result<AppResponse, ContractError> {
        let who = self.resolver.clone();
        self.exec(
            &who,
            &ExecuteMsg::Resolve {
                chain_game_id: id,
                outcome,
            },
            &[],
        )
    }

    pub fn pause(&mut self) {
        let admin = self.admin.clone();
        self.exec(&admin, &ExecuteMsg::Pause {}, &[]).unwrap();
    }

    pub fn unpause(&mut self) {
        let admin = self.admin.clone();
        self.exec(&admin, &ExecuteMsg::Unpause {}, &[]).unwrap();
    }

    pub fn retire_key(&mut self, key_id: u16, compromised: bool) {
        let admin = self.admin.clone();
        self.exec(
            &admin,
            &ExecuteMsg::RetireSignerKey {
                key_id,
                compromised,
            },
            &[],
        )
        .unwrap();
    }

    pub fn add_key(&mut self, key: &Key) -> u16 {
        let admin = self.admin.clone();
        let res = self
            .exec(
                &admin,
                &ExecuteMsg::AddSignerKey {
                    pubkey: key.pubkey.clone(),
                },
                &[],
            )
            .unwrap();
        res.events
            .iter()
            .flat_map(|e| e.attributes.iter())
            .find(|a| a.key == "key_id")
            .unwrap()
            .value
            .parse()
            .unwrap()
    }

    // ------------------------------------------------------------ fixtures
    /// Weights 1, 2, …, n.
    pub fn ramp(n: usize) -> Vec<u128> {
        (1..=n as u128).collect()
    }

    /// SETTLEABLE: an n-seat game settled (BankBroken, log 100) with no consents.
    pub fn settleable(&mut self, n: usize) -> (u64, Payload) {
        let id = self.started(n);
        let p = self.settle(id, 1, 100, &Self::ramp(n), &[]);
        (id, p)
    }

    /// DISPUTED: `settleable(n)` challenged by seat 1.
    pub fn disputed(&mut self, n: usize) -> (u64, Payload) {
        let (id, p) = self.settleable(n);
        self.challenge(id, 1);
        (id, p)
    }

    /// SETTLED by a fast settle carrying every consent.
    pub fn settled(&mut self, n: usize) -> u64 {
        let id = self.started(n);
        let seats: Vec<usize> = (0..n).collect();
        self.settle(id, 1, 100, &Self::ramp(n), &seats);
        id
    }

    /// CANCELLED by the creator while FUNDED.
    pub fn cancelled(&mut self, n: usize) -> u64 {
        let id = self.funded(n);
        let creator = self.players[0].clone();
        self.exec(&creator, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
            .unwrap();
        id
    }

    /// ANNULLED by every seat's consent while IN_PROGRESS.
    pub fn annulled(&mut self, n: usize) -> u64 {
        let id = self.started(n);
        let seats: Vec<usize> = (0..n).collect();
        let consents = self.annul_sigs(id, &seats, 0);
        let who = self.outsider.clone();
        self.exec(
            &who,
            &ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents,
            },
            &[],
        )
        .unwrap();
        id
    }

    /// `ReviewAnnul` naming the game's pending review request (the epoch
    /// when there is none: the refusal then comes from the missing request).
    pub fn review_annul_msg(&self, id: u64) -> ExecuteMsg {
        ExecuteMsg::ReviewAnnul {
            chain_game_id: id,
            requested_at: self
                .game(id)
                .game
                .review_request
                .map(|r| r.requested_at)
                .unwrap_or(Timestamp::from_nanos(0)),
        }
    }

    // ------------------------------------------------- escrow 2.0.0 fixtures
    /// `inner` (a key inside the contract's own storage) as a raw key of the
    /// multi-test app: the wasm prefix, then this contract's namespace.
    fn raw_key(&self, inner: &[u8]) -> Vec<u8> {
        fn prefixed(ns: &[u8]) -> Vec<u8> {
            let mut out = (ns.len() as u16).to_be_bytes().to_vec();
            out.extend_from_slice(ns);
            out
        }
        let mut key = prefixed(b"wasm");
        key.extend(prefixed(
            format!("contract_data/{}", self.contract.as_str()).as_bytes(),
        ));
        key.extend_from_slice(inner);
        key
    }

    /// The raw storage key of game `id`: `Map<u64, _>("games")`'s key.
    fn raw_game_key(&self, id: u64) -> Vec<u8> {
        let mut inner = 5u16.to_be_bytes().to_vec();
        inner.extend_from_slice(b"games");
        inner.extend_from_slice(&id.to_be_bytes());
        self.raw_key(&inner)
    }

    /// Writes `value` under `inner` in this contract's own storage.
    pub fn set_raw(&mut self, inner: &[u8], value: &[u8]) {
        let key = self.raw_key(inner);
        cosmwasm_std::Storage::set(self.app.storage_mut(), &key, value);
    }

    /// Removes `inner` from this contract's own storage.
    pub fn remove_raw(&mut self, inner: &[u8]) {
        let key = self.raw_key(inner);
        cosmwasm_std::Storage::remove(self.app.storage_mut(), &key);
    }

    /// The game's stored JSON, exactly as the contract wrote it.
    pub fn raw_game(&self, id: u64) -> serde_json::Value {
        let bytes = cosmwasm_std::Storage::get(self.app.storage(), &self.raw_game_key(id))
            .expect("game stored");
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Replaces the game's stored JSON.
    pub fn set_raw_game(&mut self, id: u64, json: &serde_json::Value) {
        let key = self.raw_game_key(id);
        let bytes = serde_json::to_vec(json).unwrap();
        cosmwasm_std::Storage::set(self.app.storage_mut(), &key, &bytes);
    }

    /// Rewrites game `id` into exactly the shape escrow 2.0.0 code stored: the
    /// same JSON without the fields 2.1.0 added (`created.terms.policy`,
    /// `.review_delay_secs`, `.allowance_secs`, `.cure_window_secs`,
    /// `progress.review_request`, `progress.remedy`). This is the state a 2.0.0
    /// game has after a code migration to 2.1.0, so the game must keep every
    /// 2.0.0 path.
    pub fn make_legacy(&mut self, id: u64) {
        let mut json = self.raw_game(id);
        let terms = json["created"]["terms"].as_object_mut().unwrap();
        for field in [
            "policy",
            "review_delay_secs",
            "allowance_secs",
            "cure_window_secs",
        ] {
            terms
                .remove(field)
                .unwrap_or_else(|| panic!("a 2.1.0 game stores terms.{field}"));
        }
        let progress = json["progress"].as_object_mut().unwrap();
        for field in ["review_request", "remedy"] {
            progress
                .remove(field)
                .unwrap_or_else(|| panic!("a 2.1.0 game stores progress.{field}"));
        }
        self.set_raw_game(id, &json);
        let g = self.game(id).game;
        assert_eq!(g.terms.policy, None);
        assert_eq!(g.terms.review_delay_secs, 0);
        assert_eq!(g.terms.allowance_secs, 0);
        assert_eq!(g.terms.cure_window_secs, 0);
    }

    // ------------------------------------------------ escrow 2.1.0 remedies
    /// A well-formed, final, unexpired attestation of `kind` against
    /// `defaulting` for game `id` at `log_len`, under remedy key id 1, timed so
    /// that it is final and attested exactly now: Live 1/2 overdue 10 min ago;
    /// Live 3 overdue now; Async overdue one allowance ago (never before one
    /// allowance after the start). Expires in one hour (the TTL). Valid once a
    /// whole allowance (Live: plus the cure window) has run since the start --
    /// `remedy_ready` moves the clock there.
    pub fn attestation(
        &self,
        id: u64,
        kind: RemedyKind,
        defaulting: u8,
        log_len: u64,
    ) -> RemedyAttestation {
        let g = self.game(id).game;
        let now = self.now().seconds();
        let (strike, overdue_at) = match kind {
            RemedyKind::LiveTimeoutAnnul | RemedyKind::LiveForeclose => {
                (1, now - g.terms.cure_window_secs)
            }
            RemedyKind::LiveStrike3Foreclose => (3, now),
            RemedyKind::AsyncAnnul | RemedyKind::AsyncForeclose => (
                0,
                now.saturating_sub(g.terms.allowance_secs)
                    .max(g.started_at.unwrap().seconds() + g.terms.allowance_secs),
            ),
        };
        RemedyAttestation {
            version: 1,
            domain: self.domain(id),
            chain_game_id: id,
            remedy: kind.as_byte(),
            defaulting_seat: defaulting,
            strike,
            overdue_epoch: 1,
            log_len,
            log_hash: sha256(&[b"log", &log_len.to_be_bytes()]),
            allowance_secs: g.terms.allowance_secs,
            overdue_at,
            final_at: now,
            attested_at: now,
            expires_at: now + HOUR,
            evidence_hash: sha256(&[b"18JUNO/TEST/clock-evidence"]),
            remedy_key_id: 1,
        }
    }

    /// Moves block time far enough past game `id`'s start that an overdue can
    /// exist and be final now: one allowance plus (Live) the cure window.
    pub fn remedy_ready(&mut self, id: u64) {
        let g = self.game(id).game;
        let ready =
            g.started_at.unwrap().seconds() + g.terms.allowance_secs + g.terms.cure_window_secs;
        let now = self.now().seconds();
        if now < ready {
            self.advance(ready - now);
        }
    }

    pub fn remedy_digest(a: &RemedyAttestation) -> [u8; 32] {
        crypto::remedy_digest(&a.encode().unwrap())
    }

    /// REMEDY-APPROVE approvals of `seats` (by their consent keys) for `a`,
    /// each usable for one day from the current block time.
    pub fn approvals(&self, a: &RemedyAttestation, seats: &[usize]) -> Vec<RemedyApproval> {
        let until = self.now().seconds() + DAY;
        self.approvals_until(a, seats, until)
    }

    /// REMEDY-APPROVE approvals of `seats` for `a`, usable until `until`.
    pub fn approvals_until(
        &self,
        a: &RemedyAttestation,
        seats: &[usize],
        until: u64,
    ) -> Vec<RemedyApproval> {
        seats
            .iter()
            .map(|&i| RemedyApproval {
                seat_index: i as u8,
                approve_until: Uint64::new(until),
                signature: Key::seat(i).sign(&crypto::remedy_approve_digest(
                    &a.domain,
                    a.chain_game_id,
                    a.remedy,
                    a.defaulting_seat,
                    a.strike,
                    a.overdue_epoch,
                    a.log_len,
                    &a.log_hash,
                    a.overdue_at,
                    until,
                    i as u8,
                )),
            })
            .collect()
    }

    /// Every seat but the defaulting one, for an n-seat game.
    pub fn others(n: usize, defaulting: u8) -> Vec<usize> {
        (0..n).filter(|&i| i != usize::from(defaulting)).collect()
    }

    /// `SubmitRemedy` for `a` signed by `key`, with `approvals`.
    pub fn remedy_msg_by(
        &self,
        a: &RemedyAttestation,
        key: &Key,
        approvals: Vec<RemedyApproval>,
    ) -> ExecuteMsg {
        ExecuteMsg::SubmitRemedy {
            chain_game_id: a.chain_game_id,
            attestation: RemedyAttestationV1::from(a),
            signature: key.sign(&Self::remedy_digest(a)),
            approvals,
        }
    }

    /// `SubmitRemedy` for `a` signed by remedy key 1, with the approvals of
    /// every non-defaulting seat when the kind needs them (none otherwise).
    pub fn remedy_msg(&self, a: &RemedyAttestation) -> ExecuteMsg {
        let kind = RemedyKind::from_byte(a.remedy).expect("known remedy");
        let approvals = if kind.needs_approvals() {
            let n = self.game(a.chain_game_id).game.seats.len();
            self.approvals(a, &Self::others(n, a.defaulting_seat))
        } else {
            vec![]
        };
        self.remedy_msg_by(a, &self.remedy.clone(), approvals)
    }

    /// Relays `msg` as the outsider (anyone may relay a remedy).
    pub fn submit(&mut self, msg: &ExecuteMsg) -> Result<AppResponse, ContractError> {
        let who = self.outsider.clone();
        self.exec(&who, msg, &[])
    }

    /// Σ over every game of (pool + bond held while DISPUTED).
    pub fn accounted_custody(&self) -> u128 {
        let mut total = 0u128;
        let next = self.config().next_chain_game_id;
        for id in 1..next {
            let g = self.game(id).game;
            total += g.pool.u128();
            if g.state == GameState::Disputed {
                total += g.dispute.as_ref().unwrap().bond.u128();
            }
        }
        total
    }

    /// Invariant 1: the contract holds exactly the pools plus held bonds.
    pub fn assert_custody(&self) {
        assert_eq!(
            self.contract_balance(),
            self.accounted_custody(),
            "contract balance must equal Σ pools + held bonds"
        );
    }
}

impl Default for Suite {
    fn default() -> Self {
        Suite::new()
    }
}

pub fn u64s(v: u64) -> Uint64 {
    Uint64::new(v)
}

/// The value of the first attribute named `key` in any event of a response.
pub fn attr(res: &AppResponse, key: &str) -> String {
    res.events
        .iter()
        .flat_map(|e| e.attributes.iter())
        .find(|a| a.key == key)
        .map(|a| a.value.clone())
        .unwrap_or_else(|| panic!("no attribute {key:?} in {res:?}"))
}

/// Every coin sent by a bank message in a response.
pub fn bank_sends(res: &AppResponse) -> Vec<(String, u128)> {
    let mut out = Vec::new();
    for event in &res.events {
        if event.ty == "transfer" {
            let mut recipient = None;
            let mut amount = None;
            for a in &event.attributes {
                if a.key == "recipient" {
                    recipient = Some(a.value.clone());
                }
                if a.key == "amount" {
                    amount = Some(a.value.clone());
                }
            }
            if let (Some(r), Some(a)) = (recipient, amount) {
                let digits: String = a.chars().take_while(|c| c.is_ascii_digit()).collect();
                out.push((r, digits.parse().unwrap_or(0)));
            }
        }
    }
    out
}
