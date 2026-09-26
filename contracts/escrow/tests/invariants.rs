//! The twelve escrow invariants, each with a targeted test, plus a seeded
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
//!  9. last_seq never decreases
//! 10. no cross-game replay of payloads, consents or annul signatures
//! 11. neither the admin nor the creator can take custody of pooled funds
//! 12. pause never disables a refund or liveness route

mod common;

use std::collections::{BTreeMap, BTreeSet, HashMap};

use common::*;
use cosmwasm_std::{coins, Addr, Coin, HexBinary, Uint128, Uint256};
use cw_multi_test::{AppResponse, Executor};
use eighteen_cosmos_escrow::crypto;
use eighteen_cosmos_escrow::msg::{ExecuteMsg, ResolveOutcome, SeatSignature};
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
    /// Leave a checkpoint-less game idle past the liveness window, then exit.
    Stall,
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
    checkpointed: BTreeSet<u64>,
}

const MAX_GAMES: usize = 24;

impl Fuzz {
    fn new(seed: u64) -> Fuzz {
        let s = Suite::new();
        let treasury_expected = s.balance(&s.treasury);
        let signer = s.signer.clone();
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
            checkpointed: BTreeSet::new(),
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
        Snap {
            games: self
                .games
                .iter()
                .filter(|id| !self.frozen.contains_key(id))
                .map(|id| (*id, self.s.game(*id).game))
                .collect(),
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
        }
    }

    fn pick_act(&mut self) -> Act {
        // Pause episodes stay short so the sequences still get deep.
        if self.paused && self.rng.chance(30) {
            return Act::PauseToggle;
        }
        let table: [(Act, u64); 19] = [
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
            (Act::Stall, 1),
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
                let key = self.fresh_key();
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
                let key = self.fresh_key();
                let msg = ExecuteMsg::SetConsentKey {
                    chain_game_id: id,
                    new_pubkey: key.pubkey.clone(),
                };
                let res = self.exec(&who, &msg, &[]);
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
                let log_len = g.last_seq.u64() / 2 + self.rng.below(4);
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
                let who = if self.rng.chance(90) {
                    self.s.resolver.clone()
                } else {
                    self.any_caller()
                };
                let mut uphold = false;
                let outcome = match self.rng.below(20) {
                    0..=7 => {
                        uphold = true;
                        ResolveOutcome::Uphold {}
                    }
                    8..=12 => ResolveOutcome::Annul {},
                    _ => {
                        let log_len = g.last_seq.u64() / 2 + 1 + self.rng.below(2);
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
                let digest = crypto::annul_digest(&Self::domain_of(&g), g.last_seq.u64());
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
                    self.pick_game(&[InProgress, Disputed])?
                };
                let g = self.game_of(id);
                let who = self.seated_caller(&g);
                let res = self.exec(&who, &ExecuteMsg::LivenessSettle { chain_game_id: id }, &[]);
                Some(Self::done(act, Some(id), who, res))
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
                    Self::done(act, None, admin, res)
                };
                d.admin = true;
                Some(d)
            }
            Act::Stall => {
                let candidates: Vec<u64> = self
                    .view
                    .iter()
                    .filter(|(id, g)| g.state == InProgress && !self.checkpointed.contains(id))
                    .map(|(id, _)| *id)
                    .collect();
                if candidates.is_empty() {
                    return None;
                }
                let id = self.rng.pick(&candidates);
                let g = self.game_of(id);
                self.s.advance(14 * DAY);
                let who = g.seats[0].wallet.clone();
                let res = self.exec(&who, &ExecuteMsg::LivenessSettle { chain_game_id: id }, &[]);
                assert!(res.is_ok(), "liveness refund refused: {res:?}");
                Some(Self::done(act, Some(id), who, res))
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
                        | Act::Liveness
                        | Act::Stall
                        | Act::Annul
                        | Act::Challenge
                        | Act::Resolve
                        | Act::SetKey
                ) {
                    assert_ne!(*e, ContractError::Paused {}, "{:?} blocked by pause", d.act);
                }
            }
            Ok(res) => {
                *self.ok.entry(d.act).or_default() += 1;
                // (8)
                assert!(!d.retired_signer, "a retired signer's payload was accepted");
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
            if let Some(b) = before.games.get(id) {
                if b.state.is_terminal() {
                    assert_eq!(b, g, "terminal game {id} changed"); // (2)
                }
                assert!(g.last_seq >= b.last_seq, "last_seq decreased on {id}");
                // (9)
            }
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
            if let Some(d) = self.perform(act) {
                self.check(&d, &before);
            }
            if step % 64 == 63 {
                self.verify_frozen();
            }
        }
        self.verify_frozen();
        self.s.assert_custody();
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
    for seed in 0..10u64 {
        let mut f = Fuzz::new(0x18_c0_5e_5e_ed ^ seed.wrapping_mul(0x1000_0001));
        f.run(500);
        games += f.games.len();
        for (act, n) in &f.ok {
            *ok.entry(*act).or_default() += n;
        }
        for (act, n) in &f.err {
            *err.entry(*act).or_default() += n;
        }
        states.extend(f.states_seen.iter().copied());
        routes.extend(f.routes_seen.iter().cloned());
    }
    eprintln!("fuzz: {games} games; accepted {ok:?}; refused {err:?}; routes {routes:?}");
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
        ExecuteMsg::LivenessSettle { chain_game_id: id },
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
                s.exec(&who, &ExecuteMsg::LivenessSettle { chain_game_id: id }, &[])
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
                s.exec(&who, &ExecuteMsg::LivenessSettle { chain_game_id: id }, &[])
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
fn inv09_last_seq_never_decreases() {
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
    // Settle and Replace move it forward too, never back.
    let p = s.settle(id, 1, 21, &[1, 1], &[]);
    assert_eq!(s.last_seq(id), p.seq);
    s.challenge(id, 0);
    let stale = s.terminal_payload(id, 5, 21, &[1, 1]);
    assert!(matches!(
        s.resolve(
            id,
            ResolveOutcome::Replace {
                payload: Suite::wire(&stale)
            }
        )
        .unwrap_err(),
        ContractError::StaleSeq { .. }
    ));
    let fresh = s.terminal_payload(id, 5, 22, &[1, 1]);
    s.resolve(
        id,
        ResolveOutcome::Replace {
            payload: Suite::wire(&fresh),
        },
    )
    .unwrap();
    assert_eq!(s.last_seq(id), 45);
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
        },
        &[],
    )
    .unwrap();
    s.exec(
        &p0,
        &ExecuteMsg::LivenessSettle {
            chain_game_id: timeout,
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
