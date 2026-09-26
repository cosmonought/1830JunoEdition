//! The escrow invariants, each with a targeted test, plus a seeded
//! random-sequence checker that drives many games through every message and
//! re-verifies all of them after every step against an independent model.
//!
//!  1. custody: the contract holds exactly Σ pools + held bonds
//!  2. no double pay: a game pays out (or refunds) at most once
//!  3. payouts + dust = distributed pool
//!  4. vector order: payout i goes to the wallet at chain_seat_index i
//!  5. a terminal game's pool is 0
//!  6. the subsidy is taken exactly once per deposit
//!  7. every refund equals the seat's net deposit
//!  8. a retired signer's payload is never accepted
//!  9. sequences (split in ESCROW-2.1): (a) raw history — `last_seq` never
//!     decreases; (b) authority — `trusted_seq ≤ last_seq`, every accepted
//!     payload exceeds it, and it falls only when a signer key is marked
//!     compromised
//! 10. no cross-game replay of payloads, consents or annul signatures
//! 11. neither the admin nor the creator can take custody of pooled funds
//! 12. pause never disables a refund or liveness route
//! 13. a pause cannot permanently trap FUNDING, FUNDED, IN_PROGRESS,
//!     SETTLEABLE or DISPUTED funds (the checker drains every live game under a
//!     permanent pause at the end of each sequence)
//! 14. a compromised signer's seq cannot permanently block trusted progress
//! 15. a resolver change cannot affect an already-started game
//! 16. consent keys are unique within a game
//! 17. a stored settlement signed by a currently compromised signer is never
//!     the source of a direct payout (Finalize, the completing Consent, the
//!     liveness timeouts); Finalize and Consent refuse it with
//!     `CompromisedSettlement` (ESCROW-2.2). A resolver Uphold is an
//!     adjudicated payout and outside this rule.

mod common;

use std::collections::{BTreeMap, BTreeSet, HashMap};

use common::*;
use cosmwasm_std::{coins, Addr, Coin, HexBinary, Uint128, Uint256};
use cw_multi_test::{AppResponse, Executor};
use eighteen_cosmos_escrow::crypto;
use eighteen_cosmos_escrow::msg::{
    ExecuteMsg, ResolveOutcome, SeatSignature, SettlementPayloadV1, SignedCheckpoint,
};
use eighteen_cosmos_escrow::payload::{Payload, KIND_CHECKPOINT, KIND_TERMINAL};
use eighteen_cosmos_escrow::state::{Game, GameState, Mode, Route, SettlementSource};
use eighteen_cosmos_escrow::ContractError;

// ===================================================================== model

/// splitmix64: tiny, deterministic, good enough to explore.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
    fn pick<T: Clone>(&mut self, v: &[T]) -> T {
        v[self.below(v.len() as u64) as usize].clone()
    }
}

/// floor(pool·w_i/Σw) in 256-bit arithmetic, dust = the remainder.
fn split(pool: u128, weights: &[Uint128]) -> (Vec<u128>, u128) {
    let sum = weights
        .iter()
        .fold(Uint256::zero(), |a, w| a + Uint256::from(*w));
    let amounts: Vec<u128> = weights
        .iter()
        .map(|w| {
            let v = Uint256::from(pool) * Uint256::from(*w) / sum;
            Uint128::try_from(v).unwrap().u128()
        })
        .collect();
    let dust = pool - amounts.iter().sum::<u128>();
    (amounts, dust)
}

#[derive(Clone, Debug, PartialEq)]
struct Snap {
    /// Live games only. A game is frozen the step it turns terminal and then
    /// re-verified against the chain periodically (and whenever targeted).
    games: BTreeMap<u64, Game>,
    /// `GameResponse::trusted_seq` of each live game.
    trusted: BTreeMap<u64, u64>,
    balances: BTreeMap<String, u128>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Act {
    Create,
    Join,
    Withdraw,
    Cancel,
    SetKey,
    Start,
    Checkpoint,
    Settle,
    Consent,
    Finalize,
    Challenge,
    Resolve,
    Annul,
    Liveness,
    Advance,
    PauseToggle,
    RotateSigner,
    Replay,
    /// Leave an IN_PROGRESS, SETTLEABLE or DISPUTED game idle until its exit
    /// opens (sometimes under pause), then take the exit.
    Stall,
    /// A leaked key posts a checkpoint at a huge seq; the admin marks it
    /// compromised and registers a new key; honest progress must resume.
    ForgeHugeSeq,
    /// The admin moves the global resolver.
    RotateResolver,
    /// OD-ESC2-2 emergency flow: Pause → RetireSignerKey(old, compromised) →
    /// AddSignerKey(new) → a fresh Checkpoint for every IN_PROGRESS game while
    /// paused (Settle stays refused) → Unpause.
    EmergencyRotation,
}

struct Done {
    act: Act,
    game: Option<u64>,
    sender: Addr,
    res: Result<AppResponse, ContractError>,
    /// A resubmission of an accepted message.
    replay: bool,
    /// Signed under a key id that was retired before submission.
    retired_signer: bool,
    /// Resolve{Uphold}.
    uphold: bool,
    /// Admin message: must never move funds or touch a game.
    admin: bool,
    /// The step marked a signer key compromised (trusted_seq may fall).
    compromise: bool,
}

struct Fuzz {
    s: Suite,
    rng: Rng,
    games: Vec<u64>,
    /// Current consent key of (game, player index).
    keys: HashMap<(u64, usize), Key>,
    key_counter: u64,
    /// Every registered settlement key.
    signers: Vec<(u16, Key)>,
    retired: BTreeSet<u16>,
    next_signer_label: usize,
    treasury_expected: u128,
    accepted: Vec<(u64, ExecuteMsg)>,
    ok: BTreeMap<Act, usize>,
    err: BTreeMap<Act, usize>,
    states_seen: BTreeSet<&'static str>,
    routes_seen: BTreeSet<String>,
    paused: bool,
    frozen: BTreeMap<u64, Game>,
    view: BTreeMap<u64, Game>,
    view_trusted: BTreeMap<u64, u64>,
    checkpointed: BTreeSet<u64>,
    /// `CONFIG.resolver` as the model knows it.
    current_resolver: Addr,
    /// LivenessSettle calls whose carried checkpoint was promoted (OD-ESC2-4).
    carried_ok: usize,
    /// Ordinary checkpoints accepted while paused (OD-ESC2-2).
    paused_checkpoints: usize,
    /// Signer keys marked compromised, as the model knows them (17).
    compromised: BTreeSet<u16>,
    /// Finalize/Consent refused with `CompromisedSettlement` (17).
    compromised_refusals: usize,
    /// Direct payouts checked against (17).
    direct_payouts: usize,
}

const MAX_GAMES: usize = 24;

impl Fuzz {
    fn new(seed: u64) -> Fuzz {
        let s = Suite::new();
        let treasury_expected = s.balance(&s.treasury);
        let signer = s.signer.clone();
        let resolver = s.resolver.clone();
        Fuzz {
            s,
            rng: Rng(seed),
            games: Vec::new(),
            keys: HashMap::new(),
            key_counter: 0,
            signers: vec![(1, signer)],
            retired: BTreeSet::new(),
            next_signer_label: 2,
            treasury_expected,
            accepted: Vec::new(),
            ok: BTreeMap::new(),
            err: BTreeMap::new(),
            states_seen: BTreeSet::new(),
            routes_seen: BTreeSet::new(),
            paused: false,
            frozen: BTreeMap::new(),
            view: BTreeMap::new(),
            view_trusted: BTreeMap::new(),
            checkpointed: BTreeSet::new(),
            current_resolver: resolver,
            carried_ok: 0,
            paused_checkpoints: 0,
            compromised: BTreeSet::new(),
            compromised_refusals: 0,
            direct_payouts: 0,
        }
    }

    fn known(&self) -> Vec<Addr> {
        let mut v = self.s.players.clone();
        v.extend([
            self.s.admin.clone(),
            self.s.operator.clone(),
            self.s.resolver.clone(),
            self.s.outsider.clone(),
            self.s.treasury.clone(),
            self.s.contract.clone(),
        ]);
        v
    }

    fn snap(&self) -> Snap {
        let mut games = BTreeMap::new();
        let mut trusted = BTreeMap::new();
        for id in self.games.iter().filter(|id| !self.frozen.contains_key(id)) {
            let r = self.s.game(*id);
            trusted.insert(*id, r.trusted_seq.u64());
            games.insert(*id, r.game);
        }
        Snap {
            games,
            trusted,
            balances: self
                .known()
                .iter()
                .map(|a| (a.to_string(), self.s.balance(a)))
                .collect(),
        }
    }

    /// The game as of the snapshot taken before this step.
    fn game_of(&self, id: u64) -> Game {
        self.view
            .get(&id)
            .or_else(|| self.frozen.get(&id))
            .cloned()
            .expect("known game")
    }

    fn state_of(&self, id: u64) -> GameState {
        self.view
            .get(&id)
            .or_else(|| self.frozen.get(&id))
            .map(|g| g.state)
            .expect("known game")
    }

    fn roster_hash_of(g: &Game) -> HexBinary {
        let wallets: Vec<String> = g.seats.iter().map(|s| s.wallet.to_string()).collect();
        HexBinary::from(crypto::roster_hash(&wallets).unwrap().as_slice())
    }

    fn verify_frozen(&self) {
        for (id, g) in &self.frozen {
            assert_eq!(&self.s.game(*id).game, g, "terminal game {id} changed");
        }
    }

    fn fresh_key(&mut self) -> Key {
        self.key_counter += 1;
        Key::from_label(&format!("18JUNO/TEST/fuzz/consent/{}", self.key_counter))
    }

    fn player_index(&self, who: &Addr) -> Option<usize> {
        self.s.players.iter().position(|p| p == who)
    }

    fn seated(&self, g: &Game) -> Vec<usize> {
        g.seats
            .iter()
            .filter_map(|seat| self.player_index(&seat.wallet))
            .collect()
    }

    fn pick_game(&mut self, prefer: &[GameState]) -> Option<u64> {
        if self.games.is_empty() {
            return None;
        }
        if !prefer.is_empty() && self.rng.chance(85) {
            let candidates: Vec<u64> = self
                .games
                .iter()
                .copied()
                .filter(|id| prefer.contains(&self.state_of(*id)))
                .collect();
            if !candidates.is_empty() {
                return Some(self.rng.pick(&candidates));
            }
        }
        Some(self.rng.pick(&self.games))
    }

    fn any_caller(&mut self) -> Addr {
        let mut all = self.s.players.clone();
        all.push(self.s.outsider.clone());
        all.push(self.s.operator.clone());
        self.rng.pick(&all)
    }

    /// A seated wallet of `g` most of the time, anyone otherwise.
    fn seated_caller(&mut self, g: &Game) -> Addr {
        if !g.seats.is_empty() && self.rng.chance(85) {
            let i = self.rng.below(g.seats.len() as u64) as usize;
            g.seats[i].wallet.clone()
        } else {
            self.any_caller()
        }
    }

    fn weights(&mut self, n: usize) -> Vec<u128> {
        match self.rng.below(10) {
            0 => vec![0; n],
            1 => (0..n)
                .map(|_| u128::MAX - u128::from(self.rng.below(3)))
                .collect(),
            _ => (0..n).map(|_| u128::from(self.rng.below(7))).collect(),
        }
    }

    /// An active signer most of the time; sometimes a retired one.
    fn pick_signer(&mut self) -> (u16, Key) {
        let active: Vec<(u16, Key)> = self
            .signers
            .iter()
            .filter(|(id, _)| !self.retired.contains(id))
            .cloned()
            .collect();
        if active.is_empty() || (self.rng.chance(10) && !self.retired.is_empty()) {
            self.rng.pick(&self.signers)
        } else {
            self.rng.pick(&active)
        }
    }

    fn domain_of(g: &Game) -> [u8; 32] {
        g.domain
            .as_ref()
            .map(|d| <[u8; 32]>::try_from(d.as_slice()).unwrap())
            .unwrap_or([0u8; 32])
    }

    fn payload_for(
        g: &Game,
        kind: u8,
        reason: u8,
        log_len: u64,
        weights: Vec<u128>,
        key_id: u16,
    ) -> Payload {
        Payload {
            version: 1,
            domain: Self::domain_of(g),
            seq: log_len.saturating_mul(2).saturating_add(u64::from(kind)),
            kind,
            reason,
            log_len,
            log_hash: sha256(&[b"fuzz-log", &log_len.to_be_bytes()]),
            appraisal_log_len: log_len,
            appraisal_state_hash: sha256(&[b"fuzz-state", &log_len.to_be_bytes()]),
            state_schema_version: 1,
            settlement_weights: weights,
            signer_key_id: key_id,
            issued_at: 1_790_000_000,
        }
    }

    fn current_key(&self, id: u64, g: &Game, seat: usize) -> Key {
        let wallet = &g.seats[seat].wallet;
        let p = self.player_index(wallet).expect("seats are players");
        self.keys
            .get(&(id, p))
            .cloned()
            .expect("every seat's key is tracked")
    }

    fn exec(
        &mut self,
        who: &Addr,
        msg: &ExecuteMsg,
        funds: &[Coin],
    ) -> Result<AppResponse, ContractError> {
        self.s.exec(who, msg, funds)
    }

    fn done(
        act: Act,
        game: Option<u64>,
        sender: Addr,
        res: Result<AppResponse, ContractError>,
    ) -> Done {
        Done {
            act,
            game,
            sender,
            res,
            replay: false,
            retired_signer: false,
            uphold: false,
            admin: false,
            compromise: false,
        }
    }

    fn pick_act(&mut self) -> Act {
        // Pause episodes stay short so the sequences still get deep.
        if self.paused && self.rng.chance(30) {
            return Act::PauseToggle;
        }
        let table: [(Act, u64); 22] = [
            (Act::Create, 6),
            (Act::Join, 16),
            (Act::Withdraw, 2),
            (Act::Cancel, 2),
            (Act::SetKey, 3),
            (Act::Start, 9),
            (Act::Checkpoint, 9),
            (Act::Settle, 9),
            (Act::Consent, 8),
            (Act::Finalize, 5),
            (Act::Challenge, 5),
            (Act::Resolve, 4),
            (Act::Annul, 2),
            (Act::Liveness, 3),
            (Act::Advance, 8),
            (Act::PauseToggle, 1),
            (Act::RotateSigner, 1),
            (Act::Replay, 4),
            (Act::Stall, 2),
            (Act::ForgeHugeSeq, 1),
            (Act::RotateResolver, 1),
            (Act::EmergencyRotation, 1),
        ];
        let total: u64 = table.iter().map(|(_, w)| w).sum();
        let mut r = self.rng.below(total);
        for (act, w) in table {
            if r < w {
                return act;
            }
            r -= w;
        }
        unreachable!()
    }

    fn perform(&mut self, act: Act) -> Option<Done> {
        use GameState::*;
        match act {
            Act::Create => {
                if self.games.len() >= MAX_GAMES {
                    return None;
                }
                let p = self.rng.below(8) as usize;
                let who = self.s.players[p].clone();
                let max_players = match self.rng.below(10) {
                    0..=4 => 2,
                    5..=7 => 3,
                    8 => 4 + self.rng.below(2) as u8,
                    _ => 6 + self.rng.below(2) as u8,
                };
                let mode = if self.rng.chance(50) {
                    Mode::Live
                } else {
                    Mode::Async
                };
                let ante = self.rng.pick(&[ANTE, 3_000_000, 5_000_001, 1_999_999]);
                let key = self.fresh_key();
                let msg = ExecuteMsg::CreateGame {
                    max_players,
                    mode,
                    rules_engine_version: RULES_ENGINE_VERSION,
                    variants_digest: variants_digest(),
                    consent_pubkey: key.pubkey.clone(),
                    join_ticket: ticket("fuzz"),
                };
                let res = self.exec(&who, &msg, &coins(ante, DENOM));
                let mut game = None;
                if let Ok(r) = &res {
                    let id: u64 = attr(r, "chain_game_id").parse().unwrap();
                    self.games.push(id);
                    self.keys.insert((id, p), key);
                    game = Some(id);
                }
                Some(Self::done(act, game, who, res))
            }
            Act::Join => {
                let id = self.pick_game(&[Funding])?;
                let g = self.game_of(id);
                let seated = self.seated(&g);
                let free: Vec<usize> = (0..8).filter(|p| !seated.contains(p)).collect();
                let p = if !free.is_empty() && self.rng.chance(85) {
                    self.rng.pick(&free)
                } else {
                    self.rng.below(8) as usize
                };
                let who = self.s.players[p].clone();
                // (16) Sometimes try another seat's current key.
                let reuse = !g.seats.is_empty() && self.rng.chance(10);
                let key = if reuse {
                    let seat = self.rng.below(g.seats.len() as u64) as usize;
                    self.current_key(id, &g, seat)
                } else {
                    self.fresh_key()
                };
                let amount = if self.rng.chance(90) {
                    g.ante_gross.u128()
                } else {
                    g.ante_gross.u128() + 1
                };
                let msg = ExecuteMsg::Join {
                    chain_game_id: id,
                    consent_pubkey: key.pubkey.clone(),
                    join_ticket: ticket("fuzz"),
                };
                let res = self.exec(&who, &msg, &coins(amount, DENOM));
                assert!(!(reuse && res.is_ok()), "a duplicate consent key joined");
                if res.is_ok() {
                    self.keys.insert((id, p), key);
                }
                Some(Self::done(act, Some(id), who, res))
            }
            Act::Withdraw => {
                let id = self.pick_game(&[Funding, Funded])?;
                let g = self.game_of(id);
                let who = self.seated_caller(&g);
                let res = self.exec(&who, &ExecuteMsg::Withdraw { chain_game_id: id }, &[]);
                Some(Self::done(act, Some(id), who, res))
            }
            Act::Cancel => {
                let id = self.pick_game(&[Funding, Funded])?;
                let g = self.game_of(id);
                let who = if self.rng.chance(60) {
                    g.creator.clone()
                } else {
                    self.any_caller()
                };
                let res = self.exec(&who, &ExecuteMsg::Cancel { chain_game_id: id }, &[]);
                Some(Self::done(act, Some(id), who, res))
            }
            Act::SetKey => {
                let id = self.pick_game(&[Funding, Funded, InProgress, Settleable])?;
                let g = self.game_of(id);
                let who = self.seated_caller(&g);
                let own = g.seats.iter().position(|x| x.wallet == who);
                // (16) Sometimes try another seat's current key.
                let other = own.and_then(|o| (0..g.seats.len()).find(|i| *i != o));
                let reuse = other.is_some() && self.rng.chance(10);
                let key = match (reuse, other) {
                    (true, Some(i)) => self.current_key(id, &g, i),
                    _ => self.fresh_key(),
                };
                let msg = ExecuteMsg::SetConsentKey {
                    chain_game_id: id,
                    new_pubkey: key.pubkey.clone(),
                };
                let res = self.exec(&who, &msg, &[]);
                assert!(!(reuse && res.is_ok()), "rotated onto another seat's key");
                if res.is_ok() {
                    let p = self.player_index(&who).unwrap();
                    self.keys.insert((id, p), key);
                }
                Some(Self::done(act, Some(id), who, res))
            }
            Act::Start => {
                let id = self.pick_game(&[Funded])?;
                let who = if self.rng.chance(90) {
                    self.s.operator.clone()
                } else {
                    self.any_caller()
                };
                let roster_hash = if self.rng.chance(92) {
                    Self::roster_hash_of(&self.game_of(id))
                } else {
                    HexBinary::from(vec![1u8; 32])
                };
                let msg = ExecuteMsg::Start {
                    chain_game_id: id,
                    roster_hash,
                };
                let res = self.exec(&who, &msg, &[]);
                Some(Self::done(act, Some(id), who, res))
            }
            Act::Checkpoint | Act::Settle => {
                let id = self.pick_game(&[InProgress])?;
                let g = self.game_of(id);
                // Honest progress builds on the trusted sequence, not on raw
                // (possibly forged) history.
                let base = self.view_trusted.get(&id).copied().unwrap_or(0);
                let log_len = base / 2 + self.rng.below(4);
                let weights = self.weights(g.seats.len());
                let (key_id, key) = self.pick_signer();
                let retired_signer = self.retired.contains(&key_id);
                let who = self.any_caller();
                let msg = if act == Act::Checkpoint {
                    let p = Self::payload_for(&g, KIND_CHECKPOINT, 0, log_len, weights, key_id);
                    let (payload, signature) = self.s.signed_by(&p, &key);
                    ExecuteMsg::Checkpoint {
                        chain_game_id: id,
                        payload,
                        signature,
                    }
                } else {
                    let reason = if self.rng.chance(90) {
                        1 + self.rng.below(4) as u8
                    } else {
                        self.rng.pick(&[0u8, 5, 9])
                    };
                    let p = Self::payload_for(&g, KIND_TERMINAL, reason, log_len, weights, key_id);
                    let (payload, signature) = self.s.signed_by(&p, &key);
                    let consent = crypto::consent_digest(
                        &Self::domain_of(&g),
                        p.seq,
                        &Suite::settle_digest(&p),
                    );
                    let mut consents = Vec::new();
                    for seat in 0..g.seats.len() {
                        if self.rng.chance(55) {
                            let k = if self.rng.chance(95) {
                                self.current_key(id, &g, seat)
                            } else {
                                Key::from_label("18JUNO/TEST/fuzz/wrong")
                            };
                            consents.push(SeatSignature {
                                seat_index: seat as u8,
                                signature: k.sign(&consent),
                            });
                        }
                    }
                    ExecuteMsg::Settle {
                        chain_game_id: id,
                        payload,
                        signature,
                        consents,
                    }
                };
                let res = self.exec(&who, &msg, &[]);
                if res.is_ok() {
                    if act == Act::Checkpoint {
                        self.checkpointed.insert(id);
                        if self.paused {
                            self.paused_checkpoints += 1;
                        }
                    }
                    self.accepted.push((id, msg));
                }
                let mut d = Self::done(act, Some(id), who, res);
                d.retired_signer = retired_signer;
                Some(d)
            }
            Act::Consent => {
                let id = self.pick_game(&[Settleable])?;
                let g = self.game_of(id);
                let seat = self.rng.below(g.seats.len() as u64 + 1) as usize;
                let signature = match (&g.settlement, seat < g.seats.len()) {
                    (Some(st), true) => {
                        let settle: [u8; 32] =
                            st.payload.payload_digest.as_slice().try_into().unwrap();
                        let digest = crypto::consent_digest(
                            &Self::domain_of(&g),
                            st.payload.seq.u64(),
                            &settle,
                        );
                        self.current_key(id, &g, seat).sign(&digest)
                    }
                    _ => Key::seat(0).sign(&[9u8; 32]),
                };
                let msg = ExecuteMsg::Consent {
                    chain_game_id: id,
                    seat_index: seat as u8,
                    signature,
                };
                let who = self.any_caller();
                let res = self.exec(&who, &msg, &[]);
                if res.is_ok() {
                    self.accepted.push((id, msg));
                }
                Some(Self::done(act, Some(id), who, res))
            }
            Act::Finalize => {
                let id = self.pick_game(&[Settleable])?;
                let who = self.any_caller();
                let res = self.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[]);
                Some(Self::done(act, Some(id), who, res))
            }
            Act::Challenge => {
                let id = self.pick_game(&[Settleable])?;
                let g = self.game_of(id);
                let who = self.seated_caller(&g);
                let bond = g.bond.map(|b| b.u128()).unwrap_or(1_000_000);
                let amount = match self.rng.below(10) {
                    0 => bond + 1,
                    1 => bond.saturating_sub(1),
                    _ => bond,
                };
                let funds = if amount == 0 {
                    vec![]
                } else {
                    coins(amount, DENOM)
                };
                let msg = ExecuteMsg::Challenge {
                    chain_game_id: id,
                    evidence_hash: HexBinary::from(vec![0xabu8; 32]),
                };
                let res = self.exec(&who, &msg, &funds);
                Some(Self::done(act, Some(id), who, res))
            }
            Act::Resolve => {
                let id = self.pick_game(&[Disputed])?;
                let g = self.game_of(id);
                // (15) Mostly the game's own resolver; sometimes the current
                // global one (which may differ) or anyone.
                // (Pre-start games have none; any Resolve on them is refused.)
                let frozen = g
                    .resolver
                    .clone()
                    .unwrap_or_else(|| self.current_resolver.clone());
                let who = match self.rng.below(10) {
                    0..=7 => frozen.clone(),
                    8 => self.current_resolver.clone(),
                    _ => self.any_caller(),
                };
                let mut uphold = false;
                let outcome = match self.rng.below(20) {
                    0..=7 => {
                        uphold = true;
                        ResolveOutcome::Uphold {}
                    }
                    8..=12 => ResolveOutcome::Annul {},
                    _ => {
                        // Only the trusted checkpoint floor constrains a
                        // correction; the disputed terminal never does.
                        let floor = self
                            .s
                            .checkpoints(id)
                            .liveness_candidate_seq
                            .map(|x| x.u64())
                            .unwrap_or(0);
                        let log_len = (floor / 2).saturating_sub(1) + self.rng.below(4);
                        let weights = self.weights(g.seats.len());
                        let p = Self::payload_for(&g, KIND_TERMINAL, 5, log_len, weights, 1);
                        ResolveOutcome::Replace {
                            payload: Suite::wire(&p),
                        }
                    }
                };
                let msg = ExecuteMsg::Resolve {
                    chain_game_id: id,
                    outcome,
                };
                let res = self.exec(&who, &msg, &[]);
                let mut d = Self::done(act, Some(id), who, res);
                d.uphold = uphold;
                Some(d)
            }
            Act::Annul => {
                let id = self.pick_game(&[InProgress, Settleable])?;
                let g = self.game_of(id);
                let trusted = self.view_trusted.get(&id).copied().unwrap_or(0);
                let digest = crypto::annul_digest(&Self::domain_of(&g), trusted);
                let skip = if g.seats.is_empty() || self.rng.chance(85) {
                    usize::MAX
                } else {
                    self.rng.below(g.seats.len() as u64) as usize
                };
                let mut consents = Vec::new();
                if g.domain.is_some() {
                    for seat in 0..g.seats.len() {
                        if seat != skip {
                            consents.push(SeatSignature {
                                seat_index: seat as u8,
                                signature: self.current_key(id, &g, seat).sign(&digest),
                            });
                        }
                    }
                }
                let msg = ExecuteMsg::AnnulByConsent {
                    chain_game_id: id,
                    consents,
                };
                let who = self.any_caller();
                let res = self.exec(&who, &msg, &[]);
                if res.is_ok() {
                    self.accepted.push((id, msg));
                }
                Some(Self::done(act, Some(id), who, res))
            }
            Act::Liveness => {
                // Prefer a game whose exit is open, so the path is exercised.
                let now = self.s.now();
                let open: Vec<u64> = self
                    .view
                    .iter()
                    .filter(|(_, g)| match g.state {
                        InProgress => {
                            let from = g.last_activity.max(g.started_at).unwrap();
                            from.plus_seconds(g.terms.liveness_window_secs) <= now
                        }
                        Settleable => {
                            let end = g.settlement.as_ref().unwrap().window_end;
                            end.plus_seconds(g.terms.liveness_window_secs) <= now
                        }
                        Disputed => {
                            let at = g.dispute.as_ref().unwrap().disputed_at;
                            at.plus_seconds(g.terms.resolver_timeout_secs) <= now
                        }
                        _ => false,
                    })
                    .map(|(id, _)| *id)
                    .collect();
                let id = if !open.is_empty() && self.rng.chance(70) {
                    self.rng.pick(&open)
                } else {
                    self.pick_game(&[InProgress, Settleable, Disputed])?
                };
                let g = self.game_of(id);
                let who = self.seated_caller(&g);
                // OD-ESC2-4: sometimes carry a newer checkpoint (occasionally a
                // bad one, which must fail the whole transaction).
                let mut carried: Option<Payload> = None;
                let mut retired_signer = false;
                let checkpoint = if g.state == InProgress && self.rng.chance(40) {
                    let base = self.view_trusted.get(&id).copied().unwrap_or(0);
                    let log_len = base / 2 + 1 + self.rng.below(3);
                    let weights = self.weights(g.seats.len());
                    let (key_id, key) = self.pick_signer();
                    retired_signer = self.retired.contains(&key_id);
                    let p = Self::payload_for(&g, KIND_CHECKPOINT, 0, log_len, weights, key_id);
                    let (payload, mut signature) = self.s.signed_by(&p, &key);
                    if self.rng.chance(10) {
                        signature = Key::from_label("18JUNO/TEST/fuzz/forger").sign(&[1u8; 32]);
                        retired_signer = true; // i.e. must not be accepted
                    }
                    carried = Some(p);
                    Some(SignedCheckpoint { payload, signature })
                } else {
                    None
                };
                let res = self.exec(
                    &who,
                    &ExecuteMsg::LivenessSettle {
                        chain_game_id: id,
                        checkpoint,
                    },
                    &[],
                );
                if let (Ok(_), Some(p)) = (&res, &carried) {
                    // The carried checkpoint is the one promoted.
                    let st = self.s.game(id).game.settlement.unwrap();
                    assert_eq!(
                        st.payload.payload_digest.to_vec(),
                        Suite::settle_digest(p).to_vec()
                    );
                    self.checkpointed.insert(id);
                    self.carried_ok += 1;
                }
                let mut d = Self::done(act, Some(id), who, res);
                d.retired_signer = retired_signer;
                Some(d)
            }
            Act::Advance => {
                let secs = match self.rng.below(100) {
                    0..=69 => 1 + self.rng.below(HOUR),
                    70..=84 => 6 * HOUR,
                    85..=94 => DAY,
                    95..=98 => 15 * DAY,
                    _ => 31 * DAY,
                };
                self.s.advance(secs);
                None
            }
            Act::PauseToggle => {
                let msg = if self.paused {
                    ExecuteMsg::Unpause {}
                } else {
                    ExecuteMsg::Pause {}
                };
                let admin = self.s.admin.clone();
                let res = self.exec(&admin, &msg, &[]);
                self.paused = !self.paused;
                assert_eq!(self.s.config().config.paused, self.paused);
                let mut d = Self::done(act, None, admin, res);
                d.admin = true;
                Some(d)
            }
            Act::RotateSigner => {
                // Register a new key, then retire one old key (sometimes as
                // compromised); at least one key always stays active.
                let admin = self.s.admin.clone();
                let key = Key::signer(self.next_signer_label);
                self.next_signer_label += 1;
                let res = self.exec(
                    &admin,
                    &ExecuteMsg::AddSignerKey {
                        pubkey: key.pubkey.clone(),
                    },
                    &[],
                );
                let key_id: u16 = attr(res.as_ref().unwrap(), "key_id").parse().unwrap();
                self.signers.push((key_id, key));
                let old: Vec<u16> = self
                    .signers
                    .iter()
                    .map(|(id, _)| *id)
                    .filter(|id| *id != key_id && !self.retired.contains(id))
                    .collect();
                let mut d = if old.is_empty() {
                    Self::done(act, None, admin, res)
                } else {
                    let victim = self.rng.pick(&old);
                    let compromised = self.rng.chance(40);
                    let res = self.exec(
                        &admin,
                        &ExecuteMsg::RetireSignerKey {
                            key_id: victim,
                            compromised,
                        },
                        &[],
                    );
                    self.retired.insert(victim);
                    if compromised {
                        self.compromised.insert(victim);
                    }
                    let mut d = Self::done(act, None, admin, res);
                    d.compromise = compromised;
                    d
                };
                d.admin = true;
                Some(d)
            }
            Act::ForgeHugeSeq => {
                // (14) A leaked key's far-future checkpoint must not block the
                // honest next checkpoint once the key is marked compromised.
                let candidates: Vec<u64> = self
                    .view
                    .iter()
                    .filter(|(_, g)| g.state == InProgress)
                    .map(|(id, _)| *id)
                    .collect();
                let active: Vec<(u16, Key)> = self
                    .signers
                    .iter()
                    .filter(|(id, _)| !self.retired.contains(id))
                    .cloned()
                    .collect();
                if candidates.is_empty() || active.is_empty() {
                    return None;
                }
                let id = self.rng.pick(&candidates);
                let g = self.game_of(id);
                let (leaked_id, leaked) = self.rng.pick(&active);
                let honest_base = self.view_trusted.get(&id).copied().unwrap_or(0);
                let n = g.seats.len();
                let huge = u64::MAX / 2 - self.rng.below(3);
                let forged = Self::payload_for(&g, KIND_CHECKPOINT, 0, huge, vec![1; n], leaked_id);
                let (payload, signature) = self.s.signed_by(&forged, &leaked);
                let who = self.any_caller();
                self.exec(
                    &who,
                    &ExecuteMsg::Checkpoint {
                        chain_game_id: id,
                        payload,
                        signature,
                    },
                    &[],
                )
                .expect("a leaked but still trusted key's checkpoint is accepted");
                self.checkpointed.insert(id);
                let admin = self.s.admin.clone();
                let key = Key::signer(self.next_signer_label);
                self.next_signer_label += 1;
                let res = self
                    .exec(
                        &admin,
                        &ExecuteMsg::AddSignerKey {
                            pubkey: key.pubkey.clone(),
                        },
                        &[],
                    )
                    .unwrap();
                let key_id: u16 = attr(&res, "key_id").parse().unwrap();
                self.signers.push((key_id, key.clone()));
                self.exec(
                    &admin,
                    &ExecuteMsg::RetireSignerKey {
                        key_id: leaked_id,
                        compromised: true,
                    },
                    &[],
                )
                .unwrap();
                self.retired.insert(leaked_id);
                self.compromised.insert(leaked_id);
                let honest = Self::payload_for(
                    &g,
                    KIND_CHECKPOINT,
                    0,
                    honest_base / 2 + 1,
                    vec![1; n],
                    key_id,
                );
                let (payload, signature) = self.s.signed_by(&honest, &key);
                let res = self.exec(
                    &who,
                    &ExecuteMsg::Checkpoint {
                        chain_game_id: id,
                        payload,
                        signature,
                    },
                    &[],
                );
                assert!(
                    res.is_ok(),
                    "honest progress blocked by a forged seq: {res:?}"
                );
                let mut d = Self::done(act, Some(id), who, res);
                d.compromise = true;
                Some(d)
            }
            Act::RotateResolver => {
                let options = [
                    self.s.resolver.clone(),
                    self.s.addr("resolver-2"),
                    self.s.addr("resolver-3"),
                ];
                let next = self.rng.pick(&options);
                let admin = self.s.admin.clone();
                let res = self.exec(
                    &admin,
                    &ExecuteMsg::SetResolver {
                        resolver: next.to_string(),
                    },
                    &[],
                );
                self.current_resolver = next;
                let mut d = Self::done(act, None, admin, res);
                d.admin = true;
                Some(d)
            }
            Act::Stall => {
                // Leave a game idle until its exit opens (sometimes under
                // pause), then exit. IN_PROGRESS without a checkpoint refunds;
                // otherwise the exit carries a newer checkpoint (OD-ESC2-4) or
                // promotes the best stored one. SETTLEABLE pays or falls back
                // (OD-ESC2-1); DISPUTED pays or falls back after the resolver
                // timeout.
                let candidates: Vec<u64> = self
                    .view
                    .iter()
                    .filter(|(_, g)| matches!(g.state, InProgress | Settleable | Disputed))
                    .map(|(id, _)| *id)
                    .collect();
                if candidates.is_empty() {
                    return None;
                }
                let id = self.rng.pick(&candidates);
                if !self.paused && self.rng.chance(30) {
                    let admin = self.s.admin.clone();
                    let before = self.begin();
                    let res = self.exec(&admin, &ExecuteMsg::Pause {}, &[]);
                    self.paused = true;
                    let mut d = Self::done(Act::PauseToggle, None, admin, res);
                    d.admin = true;
                    self.check(&d, &before);
                }
                let g = self.game_of(id);
                let open_at = match g.state {
                    InProgress => g
                        .last_activity
                        .max(g.started_at)
                        .unwrap()
                        .plus_seconds(g.terms.liveness_window_secs),
                    Settleable => g
                        .settlement
                        .as_ref()
                        .unwrap()
                        .window_end
                        .plus_seconds(g.terms.liveness_window_secs),
                    _ => g
                        .dispute
                        .as_ref()
                        .unwrap()
                        .disputed_at
                        .plus_seconds(g.terms.resolver_timeout_secs),
                };
                let now = self.s.now();
                if open_at > now {
                    self.s.advance(open_at.seconds() - now.seconds());
                }
                let before = self.begin();
                let who = g.seats[0].wallet.clone();
                let carry = g.state == InProgress
                    && (self.checkpointed.contains(&id) || self.rng.chance(50))
                    && self.rng.chance(70);
                let (msg, carried) = if carry {
                    let (p, payload, signature) = self.honest_checkpoint(id, &g);
                    let msg = ExecuteMsg::LivenessSettle {
                        chain_game_id: id,
                        checkpoint: Some(SignedCheckpoint { payload, signature }),
                    };
                    (msg, Some(p))
                } else {
                    (Suite::liveness_msg(id), None)
                };
                let res = self.exec(&who, &msg, &[]);
                assert!(res.is_ok(), "{:?} exit refused: {res:?}", g.state);
                if let Some(p) = &carried {
                    let st = self.s.game(id).game.settlement.unwrap();
                    assert_eq!(
                        st.payload.payload_digest.to_vec(),
                        Suite::settle_digest(p).to_vec(),
                        "the carried checkpoint is the one promoted"
                    );
                    self.checkpointed.insert(id);
                    self.carried_ok += 1;
                }
                let d = Self::done(act, Some(id), who, res);
                self.check(&d, &before);
                None
            }
            Act::EmergencyRotation => {
                self.emergency_rotation();
                None
            }
            Act::Replay => {
                if self.accepted.is_empty() || self.games.len() < 2 {
                    return None;
                }
                let (src, msg) = self.rng.pick(&self.accepted);
                let target = if self.rng.chance(50) {
                    src
                } else {
                    let others: Vec<u64> =
                        self.games.iter().copied().filter(|g| *g != src).collect();
                    self.rng.pick(&others)
                };
                let msg = retarget(msg, target);
                let who = self.any_caller();
                let res = self.exec(&who, &msg, &[]);
                if target != src {
                    assert!(
                        res.is_err(),
                        "cross-game replay {src} → {target} accepted: {msg:?}"
                    );
                }
                let mut d = Self::done(act, Some(target), who, res);
                d.replay = true;
                Some(d)
            }
        }
    }

    /// Transfers out of the contract that the model predicts for an accepted step.
    fn expected_transfers(
        &mut self,
        d: &Done,
        before: &Snap,
        after: &Snap,
    ) -> BTreeMap<String, u128> {
        let mut out: BTreeMap<String, u128> = BTreeMap::new();
        let mut add = |who: &Addr, amount: u128| {
            if amount > 0 {
                *out.entry(who.to_string()).or_default() += amount;
            }
        };
        let Some(id) = d.game else {
            return BTreeMap::new();
        };
        let Some(a) = after.games.get(&id) else {
            return BTreeMap::new();
        };
        let treasury = self.s.treasury.clone();
        let b = match before.games.get(&id) {
            None => {
                // CreateGame: exactly one subsidy of the creator's deposit.
                add(&treasury, a.ante_gross.u128() * 250 / 10_000);
                return out;
            }
            Some(b) => b.clone(),
        };
        if a.seats.len() == b.seats.len() + 1 && d.act == Act::Join {
            add(&treasury, a.ante_gross.u128() * 250 / 10_000);
        }
        if d.act == Act::Withdraw && a.seats.len() + 1 == b.seats.len() {
            let gone = b.seats.iter().find(|s| s.wallet == d.sender).unwrap();
            add(&d.sender, gone.net_deposit.u128());
        }
        let held_bond = |g: &Game| {
            if g.state == GameState::Disputed {
                g.dispute
                    .as_ref()
                    .map(|x| (x.challenger.clone(), x.bond.u128()))
            } else {
                None
            }
        };
        if a.state.is_terminal() && !b.state.is_terminal() {
            let o = a.outcome.as_ref().unwrap();
            self.routes_seen.insert(format!("{:?}", o.route));
            if a.state == GameState::Settled {
                let st = a.settlement.as_ref().unwrap();
                match (&b.settlement, &o.route) {
                    (_, Route::ResolverReplace) => {
                        assert_eq!(st.source, SettlementSource::ResolverReplacement)
                    }
                    (None, Route::AllConsentsAtSettle) => {
                        assert_eq!(st.source, SettlementSource::TerminalPayload)
                    }
                    // Every other route pays exactly the stored vector.
                    (Some(prev), _) => assert_eq!(prev.payload, st.payload, "{:?}", o.route),
                    (None, route) => panic!("{route:?} settled without a stored settlement"),
                }
                let bond = held_bond(&b);
                let pool = b.pool.u128()
                    + if d.uphold {
                        bond.as_ref().unwrap().1
                    } else {
                        0
                    };
                let (amounts, dust) = split(pool, &st.payload.settlement_weights);
                assert_eq!(o.distributed.u128(), pool, "{:?}", o.route);
                assert_eq!(
                    o.amounts.iter().map(|x| x.u128()).collect::<Vec<_>>(),
                    amounts
                );
                assert_eq!(o.dust.u128(), dust);
                for (seat, amount) in b.seats.iter().zip(amounts.iter()) {
                    add(&seat.wallet, *amount);
                }
                add(&a.terms.treasury, dust);
                if let (Some((challenger, bond)), false) = (bond, d.uphold) {
                    add(&challenger, bond);
                }
            } else {
                for seat in &b.seats {
                    add(&seat.wallet, seat.net_deposit.u128());
                }
                if let Some((challenger, bond)) = held_bond(&b) {
                    add(&challenger, bond);
                }
            }
        } else if b.state == GameState::Disputed && a.state == GameState::Settleable {
            // Resolver timeout on a compromised settlement: fallback checkpoint.
            assert_eq!(
                a.settlement.as_ref().unwrap().source,
                SettlementSource::LivenessCheckpoint
            );
            let (challenger, bond) = held_bond(&b).unwrap();
            add(&challenger, bond);
        }
        out
    }

    fn check(&mut self, d: &Done, before: &Snap) {
        let after = self.snap();
        let total = |s: &Snap| s.balances.values().sum::<u128>();
        // Nothing is minted and nothing leaves the known set of wallets (11).
        assert_eq!(total(before), total(&after), "{:?}", d.act);
        // (2) a message aimed at a terminal game never changes it.
        if let Some(id) = d.game {
            if let Some(f) = self.frozen.get(&id) {
                assert_eq!(&self.s.game(id).game, f, "terminal game {id} changed");
            }
        }
        match &d.res {
            Err(e) => {
                *self.err.entry(d.act).or_default() += 1;
                assert_eq!(
                    *before, after,
                    "{:?} was refused ({e:?}) but changed state",
                    d.act
                );
                // (12) exits never answer Paused.
                if matches!(
                    d.act,
                    Act::Withdraw
                        | Act::Cancel
                        | Act::Checkpoint
                        | Act::Liveness
                        | Act::Stall
                        | Act::Annul
                        | Act::Challenge
                        | Act::Resolve
                        | Act::SetKey
                ) {
                    assert_ne!(*e, ContractError::Paused {}, "{:?} blocked by pause", d.act);
                }
                // (17) Finalize and Consent refuse a stored settlement whose
                // key is compromised with exactly this error, and only then.
                if let (Some(id), true) = (d.game, matches!(d.act, Act::Finalize | Act::Consent)) {
                    let key = before
                        .games
                        .get(&id)
                        .filter(|g| g.state == GameState::Settleable)
                        .and_then(|g| g.settlement.as_ref())
                        .map(|st| st.payload.signer_key_id)
                        .filter(|k| self.compromised.contains(k));
                    match (key, self.paused) {
                        (Some(key_id), false) => {
                            assert_eq!(
                                *e,
                                ContractError::CompromisedSettlement { key_id },
                                "{:?}",
                                d.act
                            );
                            self.compromised_refusals += 1;
                        }
                        _ => assert!(
                            !matches!(e, ContractError::CompromisedSettlement { .. }),
                            "{:?}: {e:?}",
                            d.act
                        ),
                    }
                }
            }
            Ok(res) => {
                *self.ok.entry(d.act).or_default() += 1;
                // Pause blocks exactly the entries and the paying steps
                // (Settle stays blocked even though Checkpoint is allowed).
                assert!(
                    !(self.paused
                        && matches!(
                            d.act,
                            Act::Create
                                | Act::Join
                                | Act::Start
                                | Act::Settle
                                | Act::Consent
                                | Act::Finalize
                        )),
                    "{:?} accepted while paused",
                    d.act
                );
                // (8)
                assert!(!d.retired_signer, "a retired signer's payload was accepted");
                // (17) Finalize and Consent never accept a stored settlement
                // whose key is compromised, and no direct payout ever comes
                // from one.
                if let (Some(id), true) = (d.game, matches!(d.act, Act::Finalize | Act::Consent)) {
                    if let Some(st) = before.games.get(&id).and_then(|g| g.settlement.as_ref()) {
                        assert!(
                            !self.compromised.contains(&st.payload.signer_key_id),
                            "{:?} accepted on a compromised settlement",
                            d.act
                        );
                    }
                }
                for (id, a) in &after.games {
                    let Some(b) = before.games.get(id) else {
                        continue;
                    };
                    if b.state.is_terminal() || !a.state.is_terminal() {
                        continue;
                    }
                    let direct = matches!(
                        a.outcome.as_ref().map(|o| &o.route),
                        Some(
                            Route::AllConsentsAtSettle
                                | Route::ConsentCompleted
                                | Route::Finalized
                                | Route::SettleableTimeoutPayout
                                | Route::ResolverTimeoutPayout
                        )
                    );
                    if direct {
                        let key = a.settlement.as_ref().unwrap().payload.signer_key_id;
                        assert!(
                            !self.compromised.contains(&key),
                            "(17) game {id} paid a settlement signed by compromised key {key}"
                        );
                        self.direct_payouts += 1;
                    }
                }
                // (16) a real key rotation withdraws that seat's recorded
                // consent and nothing else; re-setting the same key is a no-op.
                if d.act == Act::SetKey {
                    let id = d.game.unwrap();
                    let (b, a) = (&before.games[&id], &after.games[&id]);
                    let i = b.seats.iter().position(|x| x.wallet == d.sender).unwrap();
                    let bit = 1u8 << i;
                    if a.seats[i].consent_pubkey == b.seats[i].consent_pubkey {
                        assert_eq!(a, b, "re-setting the same consent key changed the game");
                    } else {
                        assert_eq!(a.consent_bitmap, b.consent_bitmap & !bit);
                    }
                }
                // (15) only the game's own resolver adjudicates.
                if d.act == Act::Resolve {
                    let id = d.game.unwrap();
                    assert_eq!(
                        before.games[&id].resolver.as_ref(),
                        Some(&d.sender),
                        "resolved by someone other than the game's resolver"
                    );
                }
                if d.replay || d.admin {
                    assert_eq!(before.games, after.games, "{:?} changed a game", d.act);
                }
                let expected = self.expected_transfers(d, before, &after);
                let contract = self.s.contract.to_string();
                let mut got: BTreeMap<String, u128> = BTreeMap::new();
                for (to, amount) in bank_sends(res) {
                    if to != contract {
                        *got.entry(to).or_default() += amount;
                    }
                }
                assert_eq!(got, expected, "{:?} moved unexpected funds", d.act);
                // (6) the treasury only ever receives subsidies and dust.
                self.treasury_expected +=
                    expected.get(self.s.treasury.as_str()).copied().unwrap_or(0);
            }
        }
        assert_eq!(
            after.balances[self.s.treasury.as_str()],
            self.treasury_expected,
            "treasury drifted"
        );
        for (id, g) in &after.games {
            self.states_seen.insert(g.state.as_str());
            let trusted = after.trusted[id];
            // (9b) the authority never exceeds raw history.
            assert!(
                trusted <= g.last_seq.u64(),
                "trusted_seq above last_seq on {id}"
            );
            if let Some(b) = before.games.get(id) {
                if b.state.is_terminal() {
                    assert_eq!(b, g, "terminal game {id} changed"); // (2)
                }
                // (9a) raw history never decreases.
                assert!(g.last_seq >= b.last_seq, "last_seq decreased on {id}");
                // (9b) the authority only falls when a key is marked compromised.
                if !d.compromise && !g.state.is_terminal() {
                    assert!(
                        trusted >= before.trusted[id],
                        "trusted_seq fell on {id} without a compromise ({:?})",
                        d.act
                    );
                }
                // (15) a started game keeps its resolver; a game starting now
                // adopts the current global one.
                match (&b.resolver, &g.resolver) {
                    (Some(r0), r1) => assert_eq!(Some(r0), r1.as_ref(), "resolver of {id} moved"),
                    (None, Some(r1)) => assert_eq!(r1, &self.current_resolver),
                    (None, None) => {}
                }
            }
            // (16) consent keys are unique within the game.
            let mut keys: Vec<&[u8]> = g
                .seats
                .iter()
                .map(|x| x.consent_pubkey.as_slice())
                .collect();
            keys.sort();
            keys.dedup();
            assert_eq!(keys.len(), g.seats.len(), "shared consent key in game {id}");
            for seat in &g.seats {
                // (6) one subsidy per deposit, recorded on the seat.
                assert_eq!(seat.gross_deposit, g.ante_gross);
                assert_eq!(seat.subsidy_paid.u128(), g.ante_gross.u128() * 250 / 10_000);
                assert_eq!(seat.net_deposit, g.ante_gross - seat.subsidy_paid);
            }
            if g.state.is_terminal() {
                assert!(g.pool.is_zero(), "terminal game {id} holds funds"); // (5)
                let o = g.outcome.as_ref().unwrap();
                let paid: Uint128 = o.amounts.iter().copied().sum();
                assert_eq!(paid + o.dust, o.distributed); // (3)
                assert_eq!(o.amounts.len(), g.seats.len());
                if g.state != GameState::Settled {
                    // (7) refunds are exactly the net deposits.
                    let nets: Vec<Uint128> = g.seats.iter().map(|s| s.net_deposit).collect();
                    assert_eq!(o.amounts, nets);
                    assert!(o.dust.is_zero());
                }
            } else {
                let nets: u128 = g.seats.iter().map(|s| s.net_deposit.u128()).sum();
                assert_eq!(
                    g.pool.u128(),
                    nets,
                    "pool of {id} differs from its deposits"
                );
                assert!(g.outcome.is_none());
            }
        }
        // (1) custody, from the snapshot: frozen games hold nothing.
        let held: u128 = after
            .games
            .values()
            .map(|g| {
                g.pool.u128()
                    + match (&g.state, &g.dispute) {
                        (GameState::Disputed, Some(x)) => x.bond.u128(),
                        _ => 0,
                    }
            })
            .sum();
        assert_eq!(
            after.balances[self.s.contract.as_str()],
            held,
            "contract balance must equal Σ pools + held bonds"
        );
        for (id, g) in &after.games {
            if g.state.is_terminal() {
                self.frozen.insert(*id, g.clone());
            }
        }
    }

    fn run(&mut self, steps: usize) {
        for step in 0..steps {
            let act = self.pick_act();
            let before = self.snap();
            self.view = before.games.clone();
            self.view_trusted = before.trusted.clone();
            if let Some(d) = self.perform(act) {
                self.check(&d, &before);
            }
            if step % 64 == 63 {
                self.verify_frozen();
            }
        }
        self.drain_under_permanent_pause();
        self.verify_frozen();
        self.s.assert_custody();
    }

    /// Snapshot before a sub-step that is checked on its own.
    fn begin(&mut self) -> Snap {
        let before = self.snap();
        self.view = before.games.clone();
        self.view_trusted = before.trusted.clone();
        before
    }

    /// OD-ESC2-2. Every sub-step is checked on its own.
    fn emergency_rotation(&mut self) {
        let admin = self.s.admin.clone();
        if !self.paused {
            let before = self.begin();
            let res = self.exec(&admin, &ExecuteMsg::Pause {}, &[]);
            self.paused = true;
            let mut d = Self::done(Act::PauseToggle, None, admin.clone(), res);
            d.admin = true;
            self.check(&d, &before);
        }
        let active: Vec<u16> = self
            .signers
            .iter()
            .map(|(k, _)| *k)
            .filter(|k| !self.retired.contains(k))
            .collect();
        // Prefer the signer of a stored SETTLEABLE settlement, so rule (17) is
        // exercised on real settlements.
        let settleable_keys: Vec<u16> = self
            .games
            .iter()
            .copied()
            .filter(|id| !self.frozen.contains_key(id))
            .filter_map(|id| {
                let g = self.s.game(id).game;
                match (g.state, g.settlement) {
                    (GameState::Settleable, Some(st)) => Some(st.payload.signer_key_id),
                    _ => None,
                }
            })
            .filter(|k| active.contains(k))
            .collect();
        let victim = if !settleable_keys.is_empty() && self.rng.chance(60) {
            self.rng.pick(&settleable_keys)
        } else {
            self.rng.pick(&active)
        };
        let before = self.begin();
        let res = self.exec(
            &admin,
            &ExecuteMsg::RetireSignerKey {
                key_id: victim,
                compromised: true,
            },
            &[],
        );
        self.retired.insert(victim);
        self.compromised.insert(victim);
        let mut d = Self::done(Act::RotateSigner, None, admin.clone(), res);
        d.admin = true;
        d.compromise = true;
        self.check(&d, &before);

        let key = Key::signer(self.next_signer_label);
        self.next_signer_label += 1;
        let before = self.begin();
        let res = self.exec(
            &admin,
            &ExecuteMsg::AddSignerKey {
                pubkey: key.pubkey.clone(),
            },
            &[],
        );
        let key_id: u16 = attr(res.as_ref().unwrap(), "key_id").parse().unwrap();
        self.signers.push((key_id, key));
        let mut d = Self::done(Act::RotateSigner, None, admin.clone(), res);
        d.admin = true;
        self.check(&d, &before);

        // Fresh checkpoints for every IN_PROGRESS game, still paused.
        let in_progress: Vec<u64> = self
            .games
            .iter()
            .copied()
            .filter(|id| !self.frozen.contains_key(id))
            .filter(|id| self.s.game(*id).game.state == GameState::InProgress)
            .collect();
        for id in in_progress {
            let before = self.begin();
            let g = self.game_of(id);
            let who = self.any_caller();
            let (_, payload, signature) = self.honest_checkpoint(id, &g);
            let msg = ExecuteMsg::Checkpoint {
                chain_game_id: id,
                payload: payload.clone(),
                signature: signature.clone(),
            };
            let res = self.exec(&who, &msg, &[]);
            assert!(
                res.is_ok(),
                "emergency checkpoint refused under pause: {res:?}"
            );
            self.paused_checkpoints += 1;
            self.checkpointed.insert(id);
            self.accepted.push((id, msg));
            let d = Self::done(Act::Checkpoint, Some(id), who, res);
            self.check(&d, &before);

            // Checkpoint being allowed does not let Settle through.
            let before = self.begin();
            let g = self.game_of(id);
            let n = g.seats.len();
            let base = self.view_trusted[&id];
            let (key_id, key) = self.signers.last().cloned().unwrap();
            let p = Self::payload_for(&g, KIND_TERMINAL, 1, base / 2 + 1, vec![1; n], key_id);
            let (payload, signature) = self.s.signed_by(&p, &key);
            let who = self.any_caller();
            let res = self.exec(
                &who,
                &ExecuteMsg::Settle {
                    chain_game_id: id,
                    payload,
                    signature,
                    consents: vec![],
                },
                &[],
            );
            assert!(
                matches!(res, Err(ContractError::Paused {})),
                "Settle while paused: {res:?}"
            );
            let d = Self::done(Act::Settle, Some(id), who, res);
            self.check(&d, &before);
        }

        let before = self.begin();
        let res = self.exec(&admin, &ExecuteMsg::Unpause {}, &[]);
        self.paused = false;
        let mut d = Self::done(Act::PauseToggle, None, admin, res);
        d.admin = true;
        self.check(&d, &before);

        // (17) After the deliberate Unpause, neither Finalize nor a valid
        // missing consent may pay a stored settlement whose key is now
        // compromised; `check` asserts the exact refusal.
        let exposed: Vec<u64> = self
            .games
            .iter()
            .copied()
            .filter(|id| !self.frozen.contains_key(id))
            .filter(|id| {
                let g = self.s.game(*id).game;
                g.state == GameState::Settleable
                    && g.settlement
                        .as_ref()
                        .is_some_and(|st| self.compromised.contains(&st.payload.signer_key_id))
            })
            .collect();
        for id in exposed {
            let before = self.begin();
            let who = self.any_caller();
            let res = self.exec(&who, &ExecuteMsg::Finalize { chain_game_id: id }, &[]);
            let d = Self::done(Act::Finalize, Some(id), who, res);
            self.check(&d, &before);

            let before = self.begin();
            let g = self.game_of(id);
            let seat = (0..g.seats.len())
                .find(|i| g.consent_bitmap & (1u8 << i) == 0)
                .unwrap_or(0);
            let st = g.settlement.as_ref().unwrap();
            let settle: [u8; 32] = st.payload.payload_digest.as_slice().try_into().unwrap();
            let digest =
                crypto::consent_digest(&Self::domain_of(&g), st.payload.seq.u64(), &settle);
            let signature = self.current_key(id, &g, seat).sign(&digest);
            let who = self.any_caller();
            let res = self.exec(
                &who,
                &ExecuteMsg::Consent {
                    chain_game_id: id,
                    seat_index: seat as u8,
                    signature,
                },
                &[],
            );
            let d = Self::done(Act::Consent, Some(id), who, res);
            self.check(&d, &before);
        }
        *self.ok.entry(Act::EmergencyRotation).or_default() += 1;
    }

    /// A checkpoint just above the game's trusted sequence, under an active
    /// key, with a positive weight vector.
    fn honest_checkpoint(
        &mut self,
        id: u64,
        g: &Game,
    ) -> (Payload, SettlementPayloadV1, HexBinary) {
        let base = self.view_trusted.get(&id).copied().unwrap_or(0);
        let active: Vec<(u16, Key)> = self
            .signers
            .iter()
            .filter(|(k, _)| !self.retired.contains(k))
            .cloned()
            .collect();
        let (key_id, key) = self.rng.pick(&active);
        let weights = (0..g.seats.len())
            .map(|_| 1 + u128::from(self.rng.below(6)))
            .collect();
        let p = Self::payload_for(g, KIND_CHECKPOINT, 0, base / 2 + 1, weights, key_id);
        let (payload, signature) = self.s.signed_by(&p, &key);
        (p, payload, signature)
    }

    /// (13) Pause the contract for good, then drive every live game to a
    /// terminal state with player exits only (Cancel after the deadline and
    /// LivenessSettle), advancing time. Nothing may stay trapped. On the way,
    /// an ordinary Checkpoint under pause must be accepted and restart the
    /// liveness clock (OD-ESC2-2), and a checkpoint carried by LivenessSettle
    /// under pause must be the one promoted (OD-ESC2-4).
    fn drain_under_permanent_pause(&mut self) {
        if !self.paused {
            let admin = self.s.admin.clone();
            self.exec(&admin, &ExecuteMsg::Pause {}, &[]).unwrap();
            self.paused = true;
        }
        for round in 0..6 {
            let live: Vec<u64> = self
                .games
                .iter()
                .copied()
                .filter(|id| !self.frozen.contains_key(id))
                .collect();
            if live.is_empty() {
                break;
            }
            self.s.advance(31 * DAY);
            for id in live {
                let before = self.snap();
                self.view = before.games.clone();
                self.view_trusted = before.trusted.clone();
                let g = self.game_of(id);
                if g.state == GameState::InProgress && round == 0 && self.rng.chance(50) {
                    // An ordinary checkpoint is accepted under pause and
                    // restarts the clock: the liveness exit is not open yet.
                    let who = g.seats[0].wallet.clone();
                    let (_, payload, signature) = self.honest_checkpoint(id, &g);
                    let msg = ExecuteMsg::Checkpoint {
                        chain_game_id: id,
                        payload,
                        signature,
                    };
                    let res = self.exec(&who, &msg, &[]);
                    assert!(res.is_ok(), "checkpoint refused under pause: {res:?}");
                    self.paused_checkpoints += 1;
                    self.checkpointed.insert(id);
                    let d = Self::done(Act::Checkpoint, Some(id), who.clone(), res);
                    self.check(&d, &before);
                    let before = self.snap();
                    self.view = before.games.clone();
                    self.view_trusted = before.trusted.clone();
                    let res = self.exec(&who, &Suite::liveness_msg(id), &[]);
                    assert!(
                        matches!(res, Err(ContractError::LivenessNotReached { .. })),
                        "an ordinary checkpoint must restart the liveness clock: {res:?}"
                    );
                    let d = Self::done(Act::Liveness, Some(id), who, res);
                    self.check(&d, &before);
                    continue;
                }
                let mut carried: Option<Payload> = None;
                let (act, who, msg) = match g.state {
                    GameState::Funding | GameState::Funded => (
                        Act::Cancel,
                        self.s.outsider.clone(),
                        ExecuteMsg::Cancel { chain_game_id: id },
                    ),
                    GameState::InProgress if self.rng.chance(50) => {
                        let (p, payload, signature) = self.honest_checkpoint(id, &g);
                        carried = Some(p);
                        (
                            Act::Liveness,
                            g.seats[0].wallet.clone(),
                            ExecuteMsg::LivenessSettle {
                                chain_game_id: id,
                                checkpoint: Some(SignedCheckpoint { payload, signature }),
                            },
                        )
                    }
                    _ => (
                        Act::Liveness,
                        g.seats[0].wallet.clone(),
                        Suite::liveness_msg(id),
                    ),
                };
                let res = self.exec(&who, &msg, &[]);
                assert!(
                    res.is_ok(),
                    "{:?} exit refused under pause: {res:?}",
                    g.state
                );
                if let Some(p) = &carried {
                    let st = self.s.game(id).game.settlement.unwrap();
                    assert_eq!(
                        st.payload.payload_digest.to_vec(),
                        Suite::settle_digest(p).to_vec(),
                        "the carried checkpoint is the one promoted"
                    );
                    self.carried_ok += 1;
                }
                let d = Self::done(act, Some(id), who, res);
                self.check(&d, &before);
            }
        }
        let live = self
            .games
            .iter()
            .filter(|id| !self.frozen.contains_key(id))
            .count();
        assert_eq!(live, 0, "games still live after draining under pause");
        assert_eq!(self.s.contract_balance(), 0, "funds trapped under pause");
        assert!(self.s.config().config.paused);
    }
}

fn retarget(msg: ExecuteMsg, to: u64) -> ExecuteMsg {
    match msg {
        ExecuteMsg::Checkpoint {
            payload, signature, ..
        } => ExecuteMsg::Checkpoint {
            chain_game_id: to,
            payload,
            signature,
        },
        ExecuteMsg::Settle {
            payload,
            signature,
            consents,
            ..
        } => ExecuteMsg::Settle {
            chain_game_id: to,
            payload,
            signature,
            consents,
        },
        ExecuteMsg::Consent {
            seat_index,
            signature,
            ..
        } => ExecuteMsg::Consent {
            chain_game_id: to,
            seat_index,
            signature,
        },
        ExecuteMsg::AnnulByConsent { consents, .. } => ExecuteMsg::AnnulByConsent {
            chain_game_id: to,
            consents,
        },
        other => panic!("not a recorded message: {other:?}"),
    }
}

#[test]
fn seeded_random_sequences_preserve_every_invariant() {
    let mut ok: BTreeMap<Act, usize> = BTreeMap::new();
    let mut err: BTreeMap<Act, usize> = BTreeMap::new();
    let mut states: BTreeSet<&'static str> = BTreeSet::new();
    let mut routes: BTreeSet<String> = BTreeSet::new();
    let mut games = 0;
    let mut carried = 0;
    let mut paused_checkpoints = 0;
    let mut compromised_refusals = 0;
    let mut direct_payouts = 0;
    for seed in 0..10u64 {
        let mut f = Fuzz::new(0x18_c0_5e_5e_ed ^ seed.wrapping_mul(0x1000_0001));
        f.run(500);
        games += f.games.len();
        carried += f.carried_ok;
        paused_checkpoints += f.paused_checkpoints;
        compromised_refusals += f.compromised_refusals;
        direct_payouts += f.direct_payouts;
        for (act, n) in &f.ok {
            *ok.entry(*act).or_default() += n;
        }
        for (act, n) in &f.err {
            *err.entry(*act).or_default() += n;
        }
        states.extend(f.states_seen.iter().copied());
        routes.extend(f.routes_seen.iter().cloned());
    }
    eprintln!(
        "fuzz: {games} games; accepted {ok:?}; refused {err:?}; routes {routes:?}; \
         carried checkpoints promoted {carried}; checkpoints under pause {paused_checkpoints}"
    );
    assert!(
        carried > 0,
        "no LivenessSettle ever promoted a carried checkpoint"
    );
    assert!(
        paused_checkpoints > 0,
        "no checkpoint was ever accepted under pause"
    );
    eprintln!(
        "fuzz (17): {direct_payouts} direct payouts checked; \
         {compromised_refusals} Finalize/Consent refused as compromised"
    );
    assert!(direct_payouts > 0, "no direct payout was ever checked");
    assert!(
        compromised_refusals > 0,
        "no Finalize/Consent ever met a compromised settlement"
    );
    // The sequences must actually reach deep states for the checks to mean
    // anything.
    for s in [
        "funding",
        "funded",
        "in_progress",
        "settleable",
        "disputed",
        "settled",
        "cancelled",
        "annulled",
    ] {
        assert!(states.contains(s), "never reached {s}; ok = {ok:?}");
    }
    for r in [
        "AllConsentsAtSettle",
        "ConsentCompleted",
        "Finalized",
        "ResolverUphold",
        "ResolverReplace",
        "ResolverAnnul",
        "AnnulByConsent",
        "CreatorCancel",
        "LivenessRefund",
        "SettleableTimeoutPayout",
        "ResolverTimeoutPayout",
    ] {
        assert!(
            routes.contains(r),
            "never took route {r}; routes = {routes:?}"
        );
    }
    for act in [
        Act::Create,
        Act::Join,
        Act::Withdraw,
        Act::Cancel,
        Act::SetKey,
        Act::Start,
        Act::Checkpoint,
        Act::Settle,
        Act::Consent,
        Act::Finalize,
        Act::Challenge,
        Act::Resolve,
        Act::Annul,
        Act::Liveness,
        Act::ForgeHugeSeq,
        Act::RotateResolver,
        Act::Stall,
        Act::EmergencyRotation,
    ] {
        assert!(
            ok.get(&act).copied().unwrap_or(0) > 0,
            "{act:?} never succeeded"
        );
    }
}

// ============================================================ targeted tests

#[test]
fn inv01_custody_holds_across_a_mixed_workload() {
    let mut s = Suite::new();
    s.assert_custody();
    let a = s.started(3);
    s.assert_custody();
    let (b, _) = s.settleable(4);
    s.assert_custody();
    let (c, _) = s.disputed(5);
    s.assert_custody();
    let d = s.funded(2);
    s.assert_custody();
    s.post_checkpoint(a, 10, &[1, 2, 3]);
    s.resolve(c, ResolveOutcome::Uphold {}).unwrap();
    s.assert_custody();
    s.advance(DAY);
    let who = s.outsider.clone();
    s.exec(&who, &ExecuteMsg::Finalize { chain_game_id: b }, &[])
        .unwrap();
    s.assert_custody();
    let creator = s.players[0].clone();
    s.exec(&creator, &ExecuteMsg::Cancel { chain_game_id: d }, &[])
        .unwrap();
    s.assert_custody();
    assert_eq!(s.contract_balance(), 3 * NET);
}

#[test]
fn inv02_a_game_pays_out_at_most_once() {
    let mut s = Suite::new();
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
    assert_eq!(s.state(id), GameState::Settled);
    let balance = s.contract_balance();
    s.advance(40 * DAY);
    let alice = s.players[1].clone();
    let attempts = vec![
        ExecuteMsg::Finalize { chain_game_id: id },
        ExecuteMsg::Consent {
            chain_game_id: id,
            seat_index: 0,
            signature: Key::seat(0).sign(&digest),
        },
        ExecuteMsg::LivenessSettle {
            chain_game_id: id,
            checkpoint: None,
        },
        ExecuteMsg::AnnulByConsent {
            chain_game_id: id,
            consents: s.annul_sigs(id, &[0, 1, 2], p.seq),
        },
        ExecuteMsg::Cancel { chain_game_id: id },
        ExecuteMsg::Withdraw { chain_game_id: id },
        s.settle_msg(id, &p, &[0, 1, 2]),
    ];
    for msg in attempts {
        assert!(matches!(
            s.exec(&alice, &msg, &[]).unwrap_err(),
            ContractError::WrongState { .. }
        ));
    }
    assert!(matches!(
        s.resolve(id, ResolveOutcome::Uphold {}).unwrap_err(),
        ContractError::WrongState { .. }
    ));
    assert_eq!(s.contract_balance(), balance);
    s.assert_custody();
}

#[test]
fn inv03_payouts_plus_dust_equal_the_pool() {
    let vectors: [&[u128]; 6] = [
        &[1, 1, 1],
        &[1, 2, 4],
        &[0, 0, 1],
        &[u128::MAX, u128::MAX, 1],
        &[7, 11, 13],
        &[999_999_999, 1, 3],
    ];
    for weights in vectors {
        let mut s = Suite::new();
        let id = s.started(3);
        let treasury = s.treasury.clone();
        let t0 = s.balance(&treasury);
        s.settle(id, 1, 10, weights, &[0, 1, 2]);
        let o = s.game(id).game.outcome.unwrap();
        let paid: u128 = o.amounts.iter().map(|x| x.u128()).sum();
        assert_eq!(paid + o.dust.u128(), 3 * NET, "{weights:?}");
        assert_eq!(o.distributed.u128(), 3 * NET);
        assert_eq!(s.balance(&treasury) - t0, o.dust.u128());
        let w: Vec<Uint128> = weights.iter().map(|x| Uint128::new(*x)).collect();
        let (amounts, dust) = split(3 * NET, &w);
        assert_eq!(o.dust.u128(), dust);
        assert_eq!(
            o.amounts.iter().map(|x| x.u128()).collect::<Vec<_>>(),
            amounts
        );
        // Dust is always less than the number of seats.
        assert!(dust < 3);
        assert_eq!(s.contract_balance(), 0);
    }
}

#[test]
fn inv04_payout_i_goes_to_the_wallet_at_seat_i() {
    let mut s = Suite::new();
    // Seats in a scrambled wallet order: players 5, 2, 7.
    let id = s.create(5, 3, Mode::Live, ANTE);
    s.join(id, 2, ANTE);
    s.join(id, 7, ANTE);
    s.start(id);
    let g = s.game(id).game;
    assert_eq!(
        g.seats.iter().map(|x| x.wallet.clone()).collect::<Vec<_>>(),
        vec![
            s.players[5].clone(),
            s.players[2].clone(),
            s.players[7].clone()
        ]
    );
    let p = s.terminal_payload(id, 1, 10, &[0, 1, 3]);
    let digest = s.consent_digest(id, &p);
    let (payload, signature) = s.signed(&p);
    let consents = [(0u8, 5usize), (1, 2), (2, 7)]
        .iter()
        .map(|(seat, key)| SeatSignature {
            seat_index: *seat,
            signature: Key::seat(*key).sign(&digest),
        })
        .collect();
    let before: Vec<u128> = [5, 2, 7]
        .iter()
        .map(|i| s.balance(&s.players[*i]))
        .collect();
    let op = s.operator.clone();
    let res = s
        .exec(
            &op,
            &ExecuteMsg::Settle {
                chain_game_id: id,
                payload,
                signature,
                consents,
            },
            &[],
        )
        .unwrap();
    let after: Vec<u128> = [5, 2, 7]
        .iter()
        .map(|i| s.balance(&s.players[*i]))
        .collect();
    let pool = 3 * NET;
    let expected = [0, pool / 4, pool * 3 / 4];
    for i in 0..3 {
        assert_eq!(after[i] - before[i], expected[i], "seat {i}");
    }
    // The first transfer is to seat 1 (seat 0's zero payout is never sent).
    let sends = bank_sends(&res);
    assert_eq!(sends[0].0, s.players[2].to_string());
    assert_eq!(sends[1].0, s.players[7].to_string());
}

#[test]
fn inv05_every_terminal_game_holds_nothing() {
    let mut s = Suite::new();
    let ids = [s.settled(2), s.cancelled(3), s.annulled(4), {
        let (id, _) = s.disputed(2);
        s.resolve(id, ResolveOutcome::Annul {}).unwrap();
        id
    }];
    for id in ids {
        let g = s.game(id).game;
        assert!(g.state.is_terminal());
        assert_eq!(g.pool, Uint128::zero());
    }
    assert_eq!(s.contract_balance(), 0);
    s.assert_custody();
}

#[test]
fn inv06_the_subsidy_is_taken_exactly_once_per_deposit() {
    let mut s = Suite::new();
    let treasury = s.treasury.clone();
    let t0 = s.balance(&treasury);
    let id = s.create(0, 3, Mode::Live, ANTE); // deposit 1
    s.join(id, 1, ANTE); // deposit 2
    let alice = s.players[1].clone();
    s.exec(&alice, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
        .unwrap(); // no subsidy back
    s.join(id, 1, ANTE); // deposit 3 (a new deposit pays again)
    s.join(id, 2, ANTE); // deposit 4
    assert_eq!(s.balance(&treasury) - t0, 4 * SUBSIDY);
    s.start(id);
    s.settle(id, 1, 10, &[1, 1, 1], &[0, 1, 2]); // 5.85 / 3 exactly: no dust
    assert_eq!(s.balance(&treasury) - t0, 4 * SUBSIDY);
    let g = s.game(id).game;
    for seat in &g.seats {
        assert_eq!(seat.subsidy_paid.u128(), SUBSIDY);
    }
    // A refund never touches the subsidy either.
    let c = s.cancelled(3);
    assert_eq!(s.balance(&treasury) - t0, 7 * SUBSIDY);
    assert_eq!(s.state(c), GameState::Cancelled);
}

#[test]
fn inv07_every_refund_equals_the_net_deposit() {
    let mut s = Suite::new();
    // Withdraw returns exactly the net deposit.
    let id = s.funded(3);
    let bob = s.players[2].clone();
    let before = s.balance(&bob);
    s.exec(&bob, &ExecuteMsg::Withdraw { chain_game_id: id }, &[])
        .unwrap();
    assert_eq!(s.balance(&bob) - before, NET);
    // Every refunding route: each seat deposited ANTE once and ends exactly
    // SUBSIDY poorer (a challenger's bond comes back in full).
    type Fixture = Box<dyn Fn(&mut Suite) -> u64>;
    let routes: Vec<(Route, Fixture)> = vec![
        (
            Route::CreatorCancel,
            Box::new(|s: &mut Suite| s.cancelled(3)),
        ),
        (
            Route::AnnulByConsent,
            Box::new(|s: &mut Suite| s.annulled(3)),
        ),
        (
            Route::ResolverAnnul,
            Box::new(|s: &mut Suite| {
                let (id, _) = s.disputed(3);
                s.resolve(id, ResolveOutcome::Annul {}).unwrap();
                id
            }),
        ),
        (
            Route::LivenessRefund,
            Box::new(|s: &mut Suite| {
                let id = s.started(3);
                s.advance(14 * DAY);
                let who = s.players[0].clone();
                s.exec(
                    &who,
                    &ExecuteMsg::LivenessSettle {
                        chain_game_id: id,
                        checkpoint: None,
                    },
                    &[],
                )
                .unwrap();
                id
            }),
        ),
        (
            Route::ResolverTimeoutRefund,
            Box::new(|s: &mut Suite| {
                let (id, _) = s.disputed(3);
                s.retire_key(1, true);
                s.advance(30 * DAY);
                let who = s.players[2].clone();
                s.exec(
                    &who,
                    &ExecuteMsg::LivenessSettle {
                        chain_game_id: id,
                        checkpoint: None,
                    },
                    &[],
                )
                .unwrap();
                id
            }),
        ),
    ];
    for (route, fixture) in routes {
        let before: Vec<u128> = (0..3).map(|i| s.balance(&s.players[i])).collect();
        let id = fixture(&mut s);
        let g = s.game(id).game;
        assert_eq!(g.outcome.as_ref().unwrap().route, route);
        for (i, b) in before.iter().enumerate() {
            assert_eq!(b - s.balance(&s.players[i]), SUBSIDY, "{route:?} seat {i}");
        }
        assert_eq!(
            g.outcome.unwrap().amounts,
            vec![Uint128::new(NET); 3],
            "{route:?}"
        );
    }
    s.assert_custody();
}

#[test]
fn inv08_a_retired_signer_is_never_accepted() {
    let mut s = Suite::new();
    let a = s.started(2);
    let b = s.started(3);
    // Payloads signed while the key was active, submitted after retirement.
    let pa = s.checkpoint_payload(a, 10, &[1, 1]);
    let msg_a = s.checkpoint_msg(a, &pa);
    let pb = s.terminal_payload(b, 1, 10, &[1, 1, 1]);
    let msg_b = s.settle_msg(b, &pb, &[0, 1, 2]);
    s.add_key(&Key::signer(2));
    for compromised in [false, true] {
        s.retire_key(1, compromised);
        let who = s.outsider.clone();
        assert_eq!(
            s.exec(&who, &msg_a, &[]).unwrap_err(),
            ContractError::RetiredSignerKey { key_id: 1 }
        );
        assert_eq!(
            s.exec(&who, &msg_b, &[]).unwrap_err(),
            ContractError::RetiredSignerKey { key_id: 1 }
        );
    }
    assert_eq!(s.last_seq(a), 0);
    assert_eq!(s.state(b), GameState::InProgress);
}

#[test]
fn inv09a_raw_last_seq_never_decreases() {
    let mut s = Suite::new();
    let id = s.started(2);
    let mut last = 0;
    let attempts: [u64; 9] = [5, 3, 5, 9, 8, 20, 1, 21, 21];
    for log_len in attempts {
        let p = s.checkpoint_payload(id, log_len, &[1, 1]);
        let msg = s.checkpoint_msg(id, &p);
        let who = s.outsider.clone();
        let res = s.exec(&who, &msg, &[]);
        let seq = s.last_seq(id);
        assert!(seq >= last);
        assert_eq!(res.is_ok(), 2 * log_len > last, "log_len {log_len}");
        last = seq;
    }
    assert_eq!(last, 42);
    // Settle moves it forward. A resolver correction at the disputed
    // terminal's own log position is legal (OD-ESC2-3) and leaves it where it
    // is; one at or behind the trusted checkpoint floor is refused.
    let p = s.settle(id, 1, 21, &[1, 1], &[]);
    assert_eq!(s.last_seq(id), p.seq);
    s.challenge(id, 0);
    let behind = s.terminal_payload(id, 5, 20, &[1, 1]);
    assert_eq!(
        s.resolve(
            id,
            ResolveOutcome::Replace {
                payload: Suite::wire(&behind)
            }
        )
        .unwrap_err(),
        ContractError::StaleSeq {
            seq: 41,
            trusted_seq: 42
        }
    );
    let same = s.terminal_payload(id, 5, 21, &[2, 1]);
    s.resolve(
        id,
        ResolveOutcome::Replace {
            payload: Suite::wire(&same),
        },
    )
    .unwrap();
    assert_eq!(s.last_seq(id), 43);
    // Marking the signer compromised afterwards never rewrites raw history.
    s.add_key(&Key::signer(2));
    s.retire_key(1, true);
    assert_eq!(s.last_seq(id), 43);
}

#[test]
fn inv09b_trusted_seq_is_the_authority_and_only_falls_on_compromise() {
    let mut s = Suite::new();
    let id = s.started(2);
    let who = s.outsider.clone();
    let k2 = Key::signer(2);
    let leaked = s.add_key(&k2);
    s.post_checkpoint(id, 10, &[1, 1]);
    assert_eq!((s.last_seq(id), s.trusted_seq(id)), (20, 20));
    // A leaked key's far-future checkpoint is accepted while the key is still
    // trusted, and is the authority while it stays trusted.
    let huge = u64::MAX / 2 - 1;
    let (_, forged) = s.signed_checkpoint(id, leaked, &k2, huge, &[0, 1]);
    s.exec(
        &who,
        &ExecuteMsg::Checkpoint {
            chain_game_id: id,
            payload: forged.payload,
            signature: forged.signature,
        },
        &[],
    )
    .unwrap();
    assert_eq!((s.last_seq(id), s.trusted_seq(id)), (2 * huge, 2 * huge));
    let next = s.checkpoint_msg(id, &s.checkpoint_payload(id, 11, &[1, 1]));
    assert_eq!(
        s.exec(&who, &next, &[]).unwrap_err(),
        ContractError::StaleSeq {
            seq: 22,
            trusted_seq: 2 * huge
        }
    );
    // Retiring a key without compromise never lowers the authority.
    s.retire_key(leaked, false);
    assert_eq!(s.trusted_seq(id), 2 * huge);
    // Marking it compromised does: the authority falls back to the trusted
    // evidence while raw history keeps the forged maximum.
    s.retire_key(leaked, true);
    assert_eq!((s.last_seq(id), s.trusted_seq(id)), (2 * huge, 20));
    // Anti-replay among trusted evidence is intact.
    for stale in [10, 9] {
        let msg = s.checkpoint_msg(id, &s.checkpoint_payload(id, stale, &[1, 1]));
        assert_eq!(
            s.exec(&who, &msg, &[]).unwrap_err(),
            ContractError::StaleSeq {
                seq: 2 * stale,
                trusted_seq: 20
            }
        );
    }
    // Honest progress resumes and the authority rises again, never above raw
    // history.
    s.exec(&who, &next, &[]).unwrap();
    assert_eq!((s.last_seq(id), s.trusted_seq(id)), (2 * huge, 22));
    assert!(s.trusted_seq(id) <= s.last_seq(id));
}

#[test]
fn inv10_nothing_signed_for_one_game_is_accepted_by_another() {
    let mut s = Suite::new();
    // Same wallets, same ante, same mode: only chain_game_id differs.
    let a = s.started(3);
    let b = s.started(3);
    assert_ne!(s.domain(a), s.domain(b));
    let who = s.outsider.clone();
    let pa = s.checkpoint_payload(a, 10, &[1, 1, 1]);
    let msg = s.checkpoint_msg(a, &pa);
    let replay = retarget(msg.clone(), b);
    assert_eq!(
        s.exec(&who, &replay, &[]).unwrap_err(),
        ContractError::DomainMismatch {}
    );
    s.exec(&who, &msg, &[]).unwrap();
    let ta = s.terminal_payload(a, 1, 20, &[1, 1, 1]);
    let settle_a = s.settle_msg(a, &ta, &[0, 1, 2]);
    assert_eq!(
        s.exec(&who, &retarget(settle_a.clone(), b), &[])
            .unwrap_err(),
        ContractError::DomainMismatch {}
    );
    // Consents for A attached to B's own valid payload.
    let tb = s.terminal_payload(b, 1, 20, &[1, 1, 1]);
    let (payload, signature) = s.signed(&tb);
    let consents = s.consents(a, &ta, &[0, 1, 2]);
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::Settle {
                chain_game_id: b,
                payload,
                signature,
                consents
            },
            &[]
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    // Annul signatures.
    let annul_a = ExecuteMsg::AnnulByConsent {
        chain_game_id: b,
        consents: s.annul_sigs(a, &[0, 1, 2], 0),
    };
    assert_eq!(
        s.exec(&who, &annul_a, &[]).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    // A second escrow instance on the same chain: another contract address,
    // so the same chain_game_id and roster still give another domain.
    let domain_a = s.domain(a);
    let code_id = s.code_id;
    let admin = s.admin.clone();
    let other = s
        .app
        .instantiate_contract(
            code_id,
            admin.clone(),
            &eighteen_cosmos_escrow::msg::InstantiateMsg {
                admin: admin.to_string(),
                operator: s.operator.to_string(),
                resolver: s.resolver.to_string(),
                treasury: s.treasury.to_string(),
                denom: DENOM.to_string(),
                params: default_params(),
                signer_keys: vec![Key::signer(1).pubkey],
            },
            &[],
            "escrow-2",
            None,
        )
        .unwrap();
    let original = std::mem::replace(&mut s.contract, other);
    let twin = s.started(3);
    assert_eq!(twin, a, "same chain_game_id on the second instance");
    assert_ne!(s.domain(twin), domain_a);
    assert_eq!(
        s.exec(&who, &settle_a, &[]).unwrap_err(),
        ContractError::DomainMismatch {}
    );
    s.assert_custody();
    s.contract = original;
    s.assert_custody();
}

#[test]
fn inv11_neither_admin_nor_creator_can_take_custody() {
    let mut s = Suite::new();
    let started = s.started(3);
    let (settleable, _) = s.settleable(3);
    let admin = s.admin.clone();
    let creator = s.players[0].clone();
    let admin_before = s.balance(&admin);
    let creator_before = s.balance(&creator);
    let contract_before = s.contract_balance();
    let admin_msgs = vec![
        ExecuteMsg::Pause {},
        ExecuteMsg::SetTreasury {
            treasury: admin.to_string(),
        },
        ExecuteMsg::SetOperator {
            operator: admin.to_string(),
        },
        ExecuteMsg::RetireSignerKey {
            key_id: 1,
            compromised: true,
        },
        ExecuteMsg::Unpause {},
    ];
    for msg in admin_msgs {
        let res = s.exec(&admin, &msg, &[]).unwrap();
        assert!(bank_sends(&res).is_empty());
    }
    // The creator has no exit after Start.
    for msg in [
        ExecuteMsg::Cancel {
            chain_game_id: started,
        },
        ExecuteMsg::Withdraw {
            chain_game_id: started,
        },
        ExecuteMsg::Finalize {
            chain_game_id: settleable,
        },
        ExecuteMsg::LivenessSettle {
            chain_game_id: started,
            checkpoint: None,
        },
    ] {
        assert!(s.exec(&creator, &msg, &[]).is_err());
    }
    assert_eq!(s.balance(&admin), admin_before);
    assert_eq!(s.balance(&creator), creator_before);
    assert_eq!(s.contract_balance(), contract_before);
    // Before Start the creator's cancel refunds every seat, not the creator.
    let f = s.funded(3);
    let seats: Vec<u128> = (0..3).map(|i| s.balance(&s.players[i])).collect();
    s.exec(&creator, &ExecuteMsg::Cancel { chain_game_id: f }, &[])
        .unwrap();
    for (player, before) in s.players[..3].iter().zip(seats.iter()) {
        assert_eq!(s.balance(player) - before, NET);
    }
    // With the treasury pointed at the admin, the admin only gets the subsidies
    // (and dust) of games created afterwards: `f` (3 deposits) and `later` (2).
    let later = s.funded(2);
    assert_eq!(s.balance(&admin) - admin_before, 5 * SUBSIDY);
    assert_eq!(s.game(later).game.terms.treasury, admin);
    assert_eq!(s.game(started).game.terms.treasury, s.treasury);
    assert_eq!(s.game(settleable).game.terms.treasury, s.treasury);
    s.assert_custody();
}

#[test]
fn inv12_pause_never_disables_a_refund_or_liveness_route() {
    let mut s = Suite::new();
    let withdraw = s.funded(3);
    let creator_cancel = s.funded(3);
    let deadline_cancel = s.create(0, 3, Mode::Live, ANTE);
    let annul = s.started(3);
    let (challenge, _) = s.settleable(3);
    let (resolve, _) = s.disputed(3);
    let liveness = s.started(3);
    let (timeout, _) = s.disputed(3);
    s.pause();
    let p0 = s.players[0].clone();
    let p1 = s.players[1].clone();
    let who = s.outsider.clone();
    s.exec(
        &p1,
        &ExecuteMsg::Withdraw {
            chain_game_id: withdraw,
        },
        &[],
    )
    .unwrap();
    s.exec(
        &p0,
        &ExecuteMsg::Cancel {
            chain_game_id: creator_cancel,
        },
        &[],
    )
    .unwrap();
    let sigs = s.annul_sigs(annul, &[0, 1, 2], 0);
    s.exec(
        &who,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: annul,
            consents: sigs,
        },
        &[],
    )
    .unwrap();
    s.challenge(challenge, 2);
    s.resolve(resolve, ResolveOutcome::Annul {}).unwrap();
    s.advance(DAY);
    s.exec(
        &who,
        &ExecuteMsg::Cancel {
            chain_game_id: deadline_cancel,
        },
        &[],
    )
    .unwrap();
    s.advance(30 * DAY);
    s.exec(
        &p1,
        &ExecuteMsg::LivenessSettle {
            chain_game_id: liveness,
            checkpoint: None,
        },
        &[],
    )
    .unwrap();
    s.exec(
        &p0,
        &ExecuteMsg::LivenessSettle {
            chain_game_id: timeout,
            checkpoint: None,
        },
        &[],
    )
    .unwrap();
    assert!(s.config().config.paused);
    for (id, state) in [
        (creator_cancel, GameState::Cancelled),
        (deadline_cancel, GameState::Cancelled),
        (annul, GameState::Annulled),
        (challenge, GameState::Disputed),
        (resolve, GameState::Annulled),
        (liveness, GameState::Cancelled),
        (timeout, GameState::Settled),
    ] {
        assert_eq!(s.state(id), state);
    }
    assert_eq!(s.game(withdraw).game.seats.len(), 2);
    s.assert_custody();
}

#[test]
fn inv13_a_pause_cannot_permanently_trap_any_live_state() {
    let mut s = Suite::new();
    let k2 = Key::signer(2);
    let k2_id = s.add_key(&k2);
    let funding = s.create(0, 3, Mode::Live, ANTE);
    s.join(funding, 1, ANTE);
    let funded = s.funded(3);
    let bare = s.started(3);
    let checkpointed = s.started(3);
    s.post_checkpoint(checkpointed, 10, &[1, 2, 3]);
    let carried = s.started(3);
    let (settleable, _) = s.settleable(3);
    let (disputed, _) = s.disputed(3);
    // Two settlements under key 2, which is marked compromised during the
    // pause: one game has a trusted checkpoint to fall back to, one has none.
    let fallback = s.started(3);
    s.post_checkpoint(fallback, 10, &[3, 2, 1]);
    let orphan = s.started(3);
    let op = s.operator.clone();
    for id in [fallback, orphan] {
        let mut p = s.terminal_payload(id, 1, 20, &[1, 0, 0]);
        p.signer_key_id = k2_id;
        let (payload, signature) = s.signed_by(&p, &k2);
        s.exec(
            &op,
            &ExecuteMsg::Settle {
                chain_game_id: id,
                payload,
                signature,
                consents: vec![],
            },
            &[],
        )
        .unwrap();
    }
    assert!(s.contract_balance() > 0);

    // A pause that is never lifted.
    s.pause();
    s.retire_key(k2_id, true);
    let seat0 = s.players[0].clone();
    let outsider = s.outsider.clone();
    s.advance(31 * DAY);
    // The pause still blocks the paying steps...
    assert_eq!(
        s.exec(
            &outsider,
            &ExecuteMsg::Finalize {
                chain_game_id: settleable
            },
            &[]
        )
        .unwrap_err(),
        ContractError::Paused {}
    );
    // ...but every live state has an exit.
    for id in [funding, funded] {
        s.exec(&outsider, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
            .unwrap();
    }
    let signer = s.signer.clone();
    let (p, cp) = s.signed_checkpoint(carried, 1, &signer, 12, &[2, 2, 1]);
    s.liveness(carried, 0, Some(cp)).unwrap();
    assert_eq!(
        s.game(carried)
            .game
            .settlement
            .unwrap()
            .payload
            .payload_digest,
        HexBinary::from(Suite::settle_digest(&p).as_slice())
    );
    for id in [bare, checkpointed, settleable, disputed, fallback, orphan] {
        s.exec(&seat0, &Suite::liveness_msg(id), &[]).unwrap();
    }
    let route = |s: &Suite, id: u64| s.game(id).game.outcome.map(|o| o.route);
    assert_eq!(route(&s, funding), Some(Route::DeadlineCancel));
    assert_eq!(route(&s, funded), Some(Route::DeadlineCancel));
    assert_eq!(route(&s, bare), Some(Route::LivenessRefund));
    assert_eq!(route(&s, settleable), Some(Route::SettleableTimeoutPayout));
    assert_eq!(route(&s, disputed), Some(Route::ResolverTimeoutPayout));
    assert_eq!(route(&s, orphan), Some(Route::SettleableTimeoutRefund));
    for id in [checkpointed, carried, fallback] {
        assert_eq!(s.state(id), GameState::Settleable);
    }
    // The fallback is the trusted checkpoint, never the compromised terminal.
    assert_eq!(
        s.game(fallback)
            .game
            .settlement
            .unwrap()
            .payload
            .settlement_weights,
        vec![Uint128::new(3), Uint128::new(2), Uint128::new(1)]
    );
    // Round 2: the promoted settlements time out and pay, still paused.
    s.advance(31 * DAY);
    for id in [checkpointed, carried, fallback] {
        s.exec(&seat0, &Suite::liveness_msg(id), &[]).unwrap();
        assert_eq!(route(&s, id), Some(Route::SettleableTimeoutPayout));
    }
    assert!(s.config().config.paused);
    assert_eq!(s.contract_balance(), 0, "nothing stays trapped");
    s.assert_custody();
}

#[test]
fn inv14_a_compromised_seq_cannot_permanently_block_trusted_progress() {
    let mut s = Suite::new();
    let who = s.outsider.clone();
    let k2 = Key::signer(2);
    let leaked = s.add_key(&k2);
    let huge = u64::MAX / 2 - 1;
    // Every gate: Checkpoint, Settle, the ANNUL digest, LivenessSettle's
    // choice, and a resolver Replace after a forged terminal.
    let [a, b, c, d, e] = [0; 5].map(|_| s.started(2));
    for id in [a, b, c, d, e] {
        s.post_checkpoint(id, 10, &[1, 1]);
    }
    for id in [a, b, c, d] {
        let (_, forged) = s.signed_checkpoint(id, leaked, &k2, huge, &[0, 1]);
        s.exec(
            &who,
            &ExecuteMsg::Checkpoint {
                chain_game_id: id,
                payload: forged.payload,
                signature: forged.signature,
            },
            &[],
        )
        .unwrap();
    }
    let mut forged_terminal = s.terminal_payload(e, 1, huge, &[0, 1]);
    forged_terminal.signer_key_id = leaked;
    let (payload, signature) = s.signed_by(&forged_terminal, &k2);
    s.exec(
        &who,
        &ExecuteMsg::Settle {
            chain_game_id: e,
            payload,
            signature,
            consents: vec![],
        },
        &[],
    )
    .unwrap();
    s.challenge(e, 0);
    for id in [a, b, c, d] {
        assert_eq!(s.trusted_seq(id), 2 * huge);
    }
    assert_eq!(s.trusted_seq(e), 2 * huge + 1);

    s.retire_key(leaked, true);
    for id in [a, b, c, d] {
        assert_eq!((s.trusted_seq(id), s.last_seq(id)), (20, 2 * huge));
    }
    // Checkpoint.
    s.post_checkpoint(a, 11, &[1, 1]);
    assert_eq!(s.trusted_seq(a), 22);
    // Settle, with every consent.
    s.settle(b, 1, 11, &[2, 1], &[0, 1]);
    assert_eq!(s.state(b), GameState::Settled);
    // ANNUL binds the trusted seq; signatures over the raw maximum fail.
    let raw = ExecuteMsg::AnnulByConsent {
        chain_game_id: c,
        consents: s.annul_sigs(c, &[0, 1], 2 * huge),
    };
    assert_eq!(
        s.exec(&who, &raw, &[]).unwrap_err(),
        ContractError::InvalidConsent { seat_index: 0 }
    );
    let trusted = ExecuteMsg::AnnulByConsent {
        chain_game_id: c,
        consents: s.annul_sigs(c, &[0, 1], 20),
    };
    s.exec(&who, &trusted, &[]).unwrap();
    assert_eq!(s.state(c), GameState::Annulled);
    // LivenessSettle promotes the trusted checkpoint, never the forged one.
    s.advance(14 * DAY);
    s.liveness(d, 0, None).unwrap();
    let st = s.game(d).game.settlement.unwrap();
    assert_eq!((st.payload.seq.u64(), st.payload.signer_key_id), (20, 1));
    // The resolver corrects far below the forged terminal, just above the
    // trusted checkpoint floor.
    let fix = s.terminal_payload(e, 5, 10, &[1, 1]);
    s.resolve(
        e,
        ResolveOutcome::Replace {
            payload: Suite::wire(&fix),
        },
    )
    .unwrap();
    assert_eq!(s.state(e), GameState::Settled);
    assert_eq!(s.last_seq(e), 2 * huge + 1, "raw history is kept");
    s.assert_custody();
}

#[test]
fn inv15_a_resolver_change_cannot_affect_a_started_game() {
    let mut s = Suite::new();
    let admin = s.admin.clone();
    let r_a = s.resolver.clone();
    let r_b = s.addr("resolver-b");
    let in_progress = s.started(3);
    let (settleable, _) = s.settleable(3);
    let (disputed, _) = s.disputed(3);
    let later = s.funded(3);
    s.exec(
        &admin,
        &ExecuteMsg::SetResolver {
            resolver: r_b.to_string(),
        },
        &[],
    )
    .unwrap();
    for id in [in_progress, settleable, disputed] {
        assert_eq!(s.game_resolver(id), Some(r_a.clone()));
    }
    assert_eq!(s.game_resolver(later), None);
    s.start(later);
    assert_eq!(s.game_resolver(later), Some(r_b.clone()));
    // A dispute opened before the change and one opened after it both answer
    // to A only.
    s.challenge(settleable, 1);
    let uphold = |id| ExecuteMsg::Resolve {
        chain_game_id: id,
        outcome: ResolveOutcome::Uphold {},
    };
    for id in [disputed, settleable] {
        assert_eq!(
            s.exec(&r_b, &uphold(id), &[]).unwrap_err(),
            ContractError::Unauthorized {
                role: "resolver".to_string()
            }
        );
        s.exec(&r_a, &uphold(id), &[]).unwrap();
    }
    // The game started after the change answers to B only.
    s.settle(later, 1, 100, &Suite::ramp(3), &[]);
    s.challenge(later, 1);
    assert_eq!(
        s.exec(&r_a, &uphold(later), &[]).unwrap_err(),
        ContractError::Unauthorized {
            role: "resolver".to_string()
        }
    );
    s.exec(&r_b, &uphold(later), &[]).unwrap();
    // Moving it again (even back) never rewrites a started game's resolver.
    for next in [r_a.clone(), s.addr("resolver-c")] {
        s.exec(
            &admin,
            &ExecuteMsg::SetResolver {
                resolver: next.to_string(),
            },
            &[],
        )
        .unwrap();
        assert_eq!(s.game_resolver(in_progress), Some(r_a.clone()));
        assert_eq!(s.game_resolver(later), Some(r_b.clone()));
    }
    s.assert_custody();
}

#[test]
fn inv16_consent_keys_are_unique_within_a_game() {
    let mut s = Suite::new();
    let id = s.create(0, 3, Mode::Live, ANTE);
    let p1 = s.players[1].clone();
    let p2 = s.players[2].clone();
    // Join with seat 0's key is refused; a distinct key is accepted.
    let dup = ExecuteMsg::Join {
        chain_game_id: id,
        consent_pubkey: Key::seat(0).pubkey,
        join_ticket: ticket(PLAYER_LABELS[1]),
    };
    assert_eq!(
        s.exec(&p1, &dup, &coins(ANTE, DENOM)).unwrap_err(),
        ContractError::ConsentKeyInUse { seat_index: 0 }
    );
    s.join(id, 1, ANTE);
    s.join(id, 2, ANTE);
    s.start(id);
    // Rotation onto another seat's current key is refused; onto one's own
    // current key it is a no-op; onto a fresh key it is accepted.
    let set = |key: &Key| ExecuteMsg::SetConsentKey {
        chain_game_id: id,
        new_pubkey: key.pubkey.clone(),
    };
    assert_eq!(
        s.exec(&p2, &set(&Key::seat(1)), &[]).unwrap_err(),
        ContractError::ConsentKeyInUse { seat_index: 1 }
    );
    let before = s.game(id).game;
    s.exec(&p2, &set(&Key::seat(2)), &[]).unwrap();
    assert_eq!(s.game(id).game, before);
    let fresh = Key::from_label("18JUNO/TEST/inv16/fresh");
    s.exec(&p2, &set(&fresh), &[]).unwrap();
    // Seat 2's old key is free again, and seat 1 may take it.
    s.exec(&p1, &set(&Key::seat(2)), &[]).unwrap();
    let keys: Vec<HexBinary> = s
        .game(id)
        .game
        .seats
        .iter()
        .map(|x| x.consent_pubkey.clone())
        .collect();
    assert_eq!(
        keys,
        vec![
            Key::seat(0).pubkey,
            Key::seat(2).pubkey,
            fresh.pubkey.clone()
        ]
    );
    // N-of-N needs N distinct keys: one key cannot fill two seats.
    let p = s.terminal_payload(id, 1, 10, &[1, 1, 1]);
    let digest = s.consent_digest(id, &p);
    let (payload, signature) = s.signed(&p);
    let one_key: Vec<SeatSignature> = (0..3u8)
        .map(|seat| SeatSignature {
            seat_index: seat,
            signature: Key::seat(0).sign(&digest),
        })
        .collect();
    let who = s.outsider.clone();
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::Settle {
                chain_game_id: id,
                payload: payload.clone(),
                signature: signature.clone(),
                consents: one_key,
            },
            &[],
        )
        .unwrap_err(),
        ContractError::InvalidConsent { seat_index: 1 }
    );
    let all = vec![
        SeatSignature {
            seat_index: 0,
            signature: Key::seat(0).sign(&digest),
        },
        SeatSignature {
            seat_index: 1,
            signature: Key::seat(2).sign(&digest),
        },
        SeatSignature {
            seat_index: 2,
            signature: fresh.sign(&digest),
        },
    ];
    s.exec(
        &who,
        &ExecuteMsg::Settle {
            chain_game_id: id,
            payload,
            signature,
            consents: all,
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.state(id), GameState::Settled);

    // Across a rotation: a key that consented for seat 0 and then moved to
    // seat 1 still fills one seat only, because seat 0's rotation withdrew its
    // consent.
    let id = s.started(3);
    let p = s.settle(id, 1, 10, &[1, 1, 1], &[0]);
    let digest = s.consent_digest(id, &p);
    let (p0, p1) = (s.players[0].clone(), s.players[1].clone());
    let moved = Key::from_label("18JUNO/TEST/inv16/moved");
    s.exec(&p0, &set_key(id, &moved), &[]).unwrap();
    s.exec(&p1, &set_key(id, &Key::seat(0)), &[]).unwrap();
    s.exec(
        &who,
        &ExecuteMsg::Consent {
            chain_game_id: id,
            seat_index: 1,
            signature: Key::seat(0).sign(&digest),
        },
        &[],
    )
    .unwrap();
    assert_eq!(s.game(id).game.consent_bitmap, 0b010);
}

fn set_key(id: u64, key: &Key) -> ExecuteMsg {
    ExecuteMsg::SetConsentKey {
        chain_game_id: id,
        new_pubkey: key.pubkey.clone(),
    }
}

#[test]
fn inv17_a_compromised_settlement_is_never_the_source_of_a_direct_payout() {
    // Stored vector [0, 0, 1] on both games: paying it would send each whole
    // pool to seat 2. `settleable` also holds a key-2 checkpoint [1, 1, 1].
    let mut s = Suite::new();
    let key2 = Key::signer(2);
    let k2 = s.add_key(&key2);
    let who = s.outsider.clone();
    let settleable = s.started(3);
    let (_, cp) = s.signed_checkpoint(settleable, k2, &key2, 10, &[1, 1, 1]);
    s.exec(
        &who,
        &ExecuteMsg::Checkpoint {
            chain_game_id: settleable,
            payload: cp.payload,
            signature: cp.signature,
        },
        &[],
    )
    .unwrap();
    let p = s.settle(settleable, 1, 20, &[0, 0, 1], &[0, 1]);
    let disputed = s.started(3);
    s.settle(disputed, 1, 20, &[0, 0, 1], &[]);
    s.challenge(disputed, 0);
    s.retire_key(1, true);

    let seat2 = s.players[2].to_string();
    let mut sends: Vec<(String, u128)> = Vec::new();
    // Every ordinary path that could pay the stored vector, in turn.
    s.advance(DAY);
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::Finalize {
                chain_game_id: settleable
            },
            &[]
        )
        .unwrap_err(),
        ContractError::CompromisedSettlement { key_id: 1 }
    );
    let digest = s.consent_digest(settleable, &p);
    assert_eq!(
        s.exec(
            &who,
            &ExecuteMsg::Consent {
                chain_game_id: settleable,
                seat_index: 2,
                signature: Key::seat(2).sign(&digest),
            },
            &[]
        )
        .unwrap_err(),
        ContractError::CompromisedSettlement { key_id: 1 }
    );
    s.advance(30 * DAY);
    for id in [settleable, disputed] {
        sends.extend(bank_sends(&s.liveness(id, 0, None).unwrap()));
    }
    assert_eq!(s.state(settleable), GameState::Settleable);
    assert_eq!(
        s.game(disputed).game.outcome.unwrap().route,
        Route::ResolverTimeoutRefund
    );
    s.advance(DAY);
    let res = s
        .exec(
            &who,
            &ExecuteMsg::Finalize {
                chain_game_id: settleable,
            },
            &[],
        )
        .unwrap();
    sends.extend(bank_sends(&res));
    let g = s.game(settleable).game;
    assert_eq!(g.settlement.unwrap().payload.signer_key_id, k2);
    assert_eq!(g.outcome.unwrap().route, Route::Finalized);
    // Seat 2 received a third of `settleable` (trusted checkpoint) and its net
    // refund from `disputed`; the compromised vector would have given it 6·NET.
    let to_seat2: u128 = sends
        .iter()
        .filter(|(to, _)| *to == seat2)
        .map(|(_, a)| *a)
        .sum();
    assert_eq!(to_seat2, 2 * NET);
    assert_eq!(s.contract_balance(), 0);
    s.assert_custody();
}
