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
//! 12. pause never disables a refund, liveness or review route
//! 13. a pause cannot permanently trap FUNDING, FUNDED, SETTLEABLE or DISPUTED
//!     funds, nor an escrow 2.0.0 game's IN_PROGRESS funds (the checker drains
//!     every live game under a permanent pause at the end of each sequence). An
//!     escrow 2.1.0 IN_PROGRESS game has no inactivity exit: under a permanent
//!     pause it leaves by unanimous AnnulByConsent, the resolver's ReviewAnnul
//!     after a seated request, or (Timed) a neutral remedy; the drain uses
//!     those
//! 14. a compromised signer's seq cannot permanently block trusted progress
//! 15. a resolver change cannot affect an already-started game
//! 16. consent keys are unique within a game
//! 17. a stored settlement signed by a currently compromised signer is never
//!     the source of a direct payout (Finalize, the completing Consent, the
//!     liveness timeouts); Finalize and Consent refuse it with
//!     `CompromisedSettlement` (ESCROW-2.2). A resolver Uphold is an
//!     adjudicated payout and outside this rule.
//! 18. escrow 2.1.0 policy: a game's `terms.policy` never changes after
//!     CreateGame; a 2.1.0 game never leaves IN_PROGRESS by LivenessSettle
//!     (`LivenessExitRemoved`, whatever the time or pause) and never stores a
//!     checkpoint as its settlement (it never pays round-boundary standings)
//! 19. escrow 2.1.0 review: RequestReview succeeds only for a seated wallet of
//!     an IN_PROGRESS 2.1.0 game (any policy) and records only the first
//!     request; ReviewAnnul succeeds only for that game's own resolver after a
//!     request and the 7-day delay, and its only outcome is every seat's own
//!     net deposit back
//! 20. escrow 2.1.0 remedies: SubmitRemedy succeeds exactly when an
//!     independent model of its rules says so (policy, kind/mode, domain,
//!     seat, strike, allowance, timing, finality, expiry, sequence, the
//!     REMEDY key's status and signature, every N−1 approval and no other);
//!     the foreclosing kinds never succeed while paused; a neutral remedy
//!     refunds every net deposit, a foreclosure pays the defaulting seat 0
//!     and every other seat its net deposit plus ⌊net_D/(N−1)⌋ with the
//!     remainder to the treasury, and a third strike stores a challengeable
//!     1/0 settlement; a third-strike settlement whose REMEDY key is
//!     compromised is never paid directly (17)
//!
//! The checker mixes three kinds of game: escrow 2.1.0 `TimedRemedyV1` (Live
//! and paced Async) and `NoDeadline` games, and games rewritten into the shape
//! escrow 2.0.0 stored (`Suite::make_legacy`), which keep every 2.0.0 path.

mod common;

use std::collections::{BTreeMap, BTreeSet, HashMap};

use common::*;
use cosmwasm_std::{coins, Addr, Coin, HexBinary, Uint128, Uint256};
use cw_multi_test::{AppResponse, Executor};
use eighteen_cosmos_escrow::crypto;
use eighteen_cosmos_escrow::msg::{
    DeadlineChoice, ExecuteMsg, RemedyAttestationV1, ResolveOutcome, SeatSignature,
    SettlementPayloadV1, SignedCheckpoint,
};
use eighteen_cosmos_escrow::payload::{Payload, KIND_CHECKPOINT, KIND_TERMINAL};
use eighteen_cosmos_escrow::remedy::RemedyAttestation;
use eighteen_cosmos_escrow::state::{
    Game, GamePolicy, GameState, Mode, RemedyKind, Route, SettlementRecord, SettlementSource,
    ASYNC_PACES_SECS, MAX_REMEDY_TTL_SECS,
};
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
    /// Escrow 2.1.0: a wallet asks for the exceptional review (19).
    RequestReview,
    /// Escrow 2.1.0: someone sends ReviewAnnul (19).
    ReviewAnnul,
    /// Escrow 2.1.0: someone relays a remedy attestation, valid or not (20).
    Remedy,
    /// Escrow 2.1.0: the admin registers a remedy key and retires an old one,
    /// sometimes as compromised (20, 17).
    RotateRemedyKey,
}

/// A remedy as the fuzzer built it, with what the model needs to predict it.
struct RemedyPlan {
    a: RemedyAttestation,
    msg: ExecuteMsg,
    /// Registered and unretired / registered and retired / unknown.
    key_status: &'static str,
    /// The signature is by the key registered under `a.remedy_key_id`.
    sig_ok: bool,
    /// (seat index, signed by that seat's current key over the right digest).
    approvals: Vec<(u8, bool)>,
}

/// The model's label for a remedy refusal.
fn remedy_err_label(e: &ContractError) -> &'static str {
    match e {
        ContractError::WrongState { .. } => "wrong state",
        ContractError::RemedyNotAvailable {} => "not available",
        ContractError::BadRemedyKind { .. } => "bad kind",
        ContractError::Paused {} => "paused",
        ContractError::BadVersion { .. } => "bad version",
        ContractError::RemedyNotForMode { .. } => "not for mode",
        ContractError::DomainMismatch {} => "domain",
        ContractError::SeatIndexOutOfRange { .. } => "seat range",
        ContractError::BadStrike { .. } => "strike",
        ContractError::AllowanceMismatch { .. } => "allowance",
        ContractError::RemedyTiming { .. } => "timing",
        ContractError::RemedyNotFinal { .. } => "not final",
        ContractError::RemedyExpired { .. } => "expired",
        ContractError::StaleSeq { .. } => "stale",
        ContractError::UnknownRemedyKey { .. } => "unknown key",
        ContractError::RetiredRemedyKey { .. } => "retired key",
        ContractError::InvalidSignature {} => "invalid signature",
        ContractError::DefaulterCannotApprove { .. } => "defaulter",
        ContractError::DuplicateConsent { .. } => "duplicate",
        ContractError::InvalidConsent { .. } => "invalid consent",
        ContractError::MissingConsent { .. } => "missing",
        ContractError::ApprovalsNotAllowed { .. } => "approvals not allowed",
        other => panic!("unexpected remedy refusal {other:?}"),
    }
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
    /// Each game's exit policy as created (18); `None` = a 2.0.0-shaped game.
    policy: BTreeMap<u64, Option<GamePolicy>>,
    /// IN_PROGRESS LivenessSettle refused on a 2.1.0 game (18).
    liveness_removed: usize,
    /// Live + no_deadline CreateGame refused (18).
    live_no_deadline_refused: usize,
    /// Every registered remedy key (20).
    remedy_keys: Vec<(u16, Key)>,
    remedy_retired: BTreeSet<u16>,
    remedy_compromised: BTreeSet<u16>,
    next_remedy_label: usize,
    /// Accepted remedies by kind (20).
    remedies_ok: BTreeMap<&'static str, usize>,
    /// Remedies refused, by the model's label (20).
    remedies_refused: BTreeMap<&'static str, usize>,
    /// Third-strike settlements that reached a terminal state (20).
    strike3_closed: BTreeMap<String, usize>,
    /// Remedy-focused sequences: only 2.1.0 games (mostly Timed), started
    /// eagerly, and many more (and more often broken) remedies.
    focus: bool,
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
            policy: BTreeMap::new(),
            liveness_removed: 0,
            live_no_deadline_refused: 0,
            remedy_keys: vec![(1, Key::remedy(1))],
            remedy_retired: BTreeSet::new(),
            remedy_compromised: BTreeSet::new(),
            next_remedy_label: 2,
            remedies_ok: BTreeMap::new(),
            remedies_refused: BTreeMap::new(),
            strike3_closed: BTreeMap::new(),
            focus: false,
        }
    }

    fn new_focused(seed: u64) -> Fuzz {
        let mut f = Fuzz::new(seed);
        f.focus = true;
        f
    }

    /// Whether a stored settlement's key is compromised, as the model knows
    /// it, in the registry its source names (17, 20).
    fn settlement_compromised(&self, st: &SettlementRecord) -> bool {
        let key = st.payload.signer_key_id;
        if st.source == SettlementSource::RemedyStrike3 {
            self.remedy_compromised.contains(&key)
        } else {
            self.compromised.contains(&key)
        }
    }

    fn policy_of(&self, id: u64) -> Option<GamePolicy> {
        self.policy.get(&id).copied().flatten()
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
        if self.focus {
            let table: [(Act, u64); 19] = [
                (Act::Create, 6),
                (Act::Join, 16),
                (Act::Start, 10),
                (Act::Checkpoint, 9),
                (Act::Remedy, 30),
                (Act::Advance, 10),
                (Act::PauseToggle, 2),
                (Act::RotateRemedyKey, 2),
                (Act::Challenge, 5),
                (Act::Resolve, 4),
                (Act::Finalize, 3),
                (Act::Consent, 2),
                (Act::Annul, 2),
                (Act::Liveness, 3),
                (Act::SetKey, 2),
                (Act::RequestReview, 1),
                (Act::ReviewAnnul, 1),
                (Act::Replay, 2),
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
        let table: [(Act, u64); 26] = [
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
            (Act::RequestReview, 2),
            (Act::ReviewAnnul, 2),
            (Act::Remedy, 4),
            (Act::RotateRemedyKey, 1),
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
                // Remedy-focused sequences end games fast: cap the live ones.
                let live = self
                    .games
                    .iter()
                    .filter(|id| !self.frozen.contains_key(id))
                    .count();
                if self.games.len() >= MAX_GAMES && !(self.focus && live < 10) {
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
                // (18) Escrow 2.1.0 Timed / No-deadline games and 2.0.0-shaped
                // games side by side. A Live table asking for no deadline is
                // refused.
                let kind = self.rng.below(100);
                let legacy = kind < 30 && !self.focus;
                let no_deadline = if self.focus { kind >= 90 } else { kind >= 65 };
                // A no-deadline request is an Async table, except now and then
                // a Live one, which must be refused.
                let mode = if no_deadline && !self.rng.chance(12) {
                    Mode::Async
                } else {
                    mode
                };
                let deadline = match (no_deadline, mode) {
                    (true, _) => DeadlineChoice::NoDeadline {},
                    (false, Mode::Live) => DeadlineChoice::LiveActionClock {},
                    // The focused run mostly plays the 12-hour pace, so an
                    // overdue can exist without the world clock jumping days.
                    (false, Mode::Async) => DeadlineChoice::AsyncPace {
                        allowance_secs: if self.focus && self.rng.chance(85) {
                            ASYNC_PACES_SECS[0]
                        } else {
                            self.rng.pick(&ASYNC_PACES_SECS)
                        },
                    },
                };
                let msg = ExecuteMsg::CreateGame {
                    max_players,
                    mode,
                    rules_engine_version: RULES_ENGINE_VERSION,
                    variants_digest: variants_digest(),
                    consent_pubkey: key.pubkey.clone(),
                    join_ticket: ticket("fuzz"),
                    deadline,
                };
                let res = self.exec(&who, &msg, &coins(ante, DENOM));
                if no_deadline && mode == Mode::Live {
                    // Refused before any fund moves (pause is checked first).
                    if self.paused {
                        assert!(matches!(res, Err(ContractError::Paused {})), "{res:?}");
                    } else {
                        assert!(
                            matches!(res, Err(ContractError::DeadlineNotForMode {})),
                            "a live no-deadline game: {res:?}"
                        );
                        self.live_no_deadline_refused += 1;
                    }
                }
                let mut game = None;
                if let Ok(r) = &res {
                    let id: u64 = attr(r, "chain_game_id").parse().unwrap();
                    let created = self.s.game(id).game.terms.policy;
                    let expected = if no_deadline {
                        GamePolicy::NoDeadline
                    } else {
                        GamePolicy::TimedRemedyV1
                    };
                    assert_eq!(created, Some(expected), "CreateGame policy");
                    let policy = if legacy && !no_deadline {
                        self.s.make_legacy(id);
                        None
                    } else {
                        Some(expected)
                    };
                    self.policy.insert(id, policy);
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
                    admission: self.s.admission_for(id, &who, &ticket("fuzz")),
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
                // Escrow 2.1.0: DISPUTED too (universal unanimous annulment).
                let id = self.pick_game(&[InProgress, Settleable, Disputed])?;
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
                        InProgress if g.terms.policy.is_none() => {
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
                // (18) a 2.1.0 game has no IN_PROGRESS exit, whatever the time,
                // the pause or a carried checkpoint (good or bad).
                if g.state == InProgress && self.policy_of(id).is_some() {
                    assert!(res.is_err(), "a 2.1.0 game left IN_PROGRESS by liveness");
                    if g.seats.iter().any(|x| x.wallet == who) {
                        assert_eq!(
                            res.as_ref().unwrap_err(),
                            &ContractError::LivenessExitRemoved {}
                        );
                        self.liveness_removed += 1;
                    }
                }
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
                // Now and then a player's wallet, so a game may adopt a
                // resolver that holds one of its seats (escrow 2.1.0 review).
                let options = [
                    self.s.resolver.clone(),
                    self.s.addr("resolver-2"),
                    self.s.addr("resolver-3"),
                    self.s.players[7].clone(),
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
                if g.state == InProgress && self.policy_of(id).is_some() {
                    // (18) A 2.1.0 game never opens an inactivity exit, however
                    // long it idles; it leaves by unanimity or the review.
                    self.s.advance(DAY * (15 + self.rng.below(800)));
                    self.stall_v21(id);
                    return None;
                }
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
            Act::RequestReview => {
                // Prefer an IN_PROGRESS 2.1.0 game.
                let open: Vec<u64> = self
                    .view
                    .iter()
                    .filter(|(_, g)| g.state == InProgress && g.terms.policy.is_some())
                    .map(|(id, _)| *id)
                    .collect();
                let id = if !open.is_empty() && self.rng.chance(70) {
                    self.rng.pick(&open)
                } else {
                    self.pick_game(&[InProgress])?
                };
                let g = self.game_of(id);
                let who = self.seated_caller(&g);
                let res = self.exec(&who, &ExecuteMsg::RequestReview { chain_game_id: id }, &[]);
                self.expect_request_review(id, &g, &who, &res);
                Some(Self::done(act, Some(id), who, res))
            }
            Act::ReviewAnnul => {
                // Prefer a No-deadline game whose review was requested.
                let requested: Vec<u64> = self
                    .view
                    .iter()
                    .filter(|(_, g)| g.state == InProgress && g.review_request.is_some())
                    .map(|(id, _)| *id)
                    .collect();
                let id = if !requested.is_empty() && self.rng.chance(70) {
                    self.rng.pick(&requested)
                } else {
                    self.pick_game(&[InProgress])?
                };
                let g = self.game_of(id);
                let who = match self.rng.below(10) {
                    0..=6 => g
                        .resolver
                        .clone()
                        .unwrap_or_else(|| self.s.resolver.clone()),
                    7 => self.current_resolver.clone(),
                    8 => self.s.admin.clone(),
                    _ => self.any_caller(),
                };
                // Name the pending request, now and then a wrong one (19).
                let named = match (&g.review_request, self.rng.chance(15)) {
                    (Some(r), false) => r.requested_at,
                    (Some(r), true) => r.requested_at.plus_seconds(1),
                    (None, _) => self.s.now(),
                };
                let msg = ExecuteMsg::ReviewAnnul {
                    chain_game_id: id,
                    requested_at: named,
                };
                let res = self.exec(&who, &msg, &[]);
                self.expect_review_annul(id, &g, &who, named, &res);
                Some(Self::done(act, Some(id), who, res))
            }
            Act::Remedy => {
                // Prefer an IN_PROGRESS TimedRemedyV1 game.
                let timed: Vec<u64> = self
                    .view
                    .iter()
                    .filter(|(_, g)| {
                        g.state == InProgress && g.terms.policy == Some(GamePolicy::TimedRemedyV1)
                    })
                    .map(|(id, _)| *id)
                    .collect();
                let id = if !timed.is_empty() && self.rng.chance(85) {
                    self.rng.pick(&timed)
                } else if timed.is_empty() && (self.focus || self.rng.chance(75)) {
                    return None;
                } else {
                    self.pick_game(&[InProgress])?
                };
                let g = self.game_of(id);
                let kinds: Vec<RemedyKind> = match g.mode {
                    Mode::Live => vec![
                        RemedyKind::LiveTimeoutAnnul,
                        RemedyKind::LiveForeclose,
                        RemedyKind::LiveStrike3Foreclose,
                    ],
                    Mode::Async => vec![RemedyKind::AsyncAnnul, RemedyKind::AsyncForeclose],
                };
                let kind = self.rng.pick(&kinds);
                let defaulting = self.rng.below(g.seats.len().max(1) as u64) as u8;
                // An overdue needs the game to have run one whole allowance
                // (Live: plus the cure window) -- the server cannot attest one
                // sooner: mostly let the clock run that far first (time alone
                // changes nothing); now and then the attestation is too early
                // and the model predicts the timing refusal.
                if let (Some(started), true) = (g.started_at, self.rng.chance(90)) {
                    let earliest =
                        started.seconds() + g.terms.allowance_secs + g.terms.cure_window_secs + 1;
                    let now = self.s.now().seconds();
                    if now < earliest {
                        self.s.advance(earliest - now + self.rng.below(120));
                    }
                }
                let mutation = if self.rng.chance(if self.focus { 50 } else { 30 }) {
                    Some(self.rng.below(18))
                } else {
                    None
                };
                if mutation == Some(8) && g.state == InProgress {
                    // A stale attestation: first an honest checkpoint (its
                    // own checked step), then a remedy at a log position
                    // below it.
                    let before = self.begin();
                    let (_, payload, signature) = self.honest_checkpoint(id, &g);
                    let who = self.any_caller();
                    let res = self.exec(
                        &who,
                        &ExecuteMsg::Checkpoint {
                            chain_game_id: id,
                            payload,
                            signature,
                        },
                        &[],
                    );
                    assert!(res.is_ok(), "honest checkpoint refused: {res:?}");
                    self.checkpointed.insert(id);
                    if self.paused {
                        self.paused_checkpoints += 1;
                    }
                    let d = Self::done(Act::Checkpoint, Some(id), who, res);
                    self.check(&d, &before);
                    let before = self.begin();
                    let g = self.game_of(id);
                    let plan = self.build_remedy(id, &g, kind, defaulting, mutation);
                    let who = self.any_caller();
                    let res = self.exec(&who, &plan.msg, &[]);
                    self.expect_remedy(id, &g, &plan, &res);
                    let d = Self::done(act, Some(id), who, res);
                    self.check(&d, &before);
                    return None;
                }
                let plan = self.build_remedy(id, &g, kind, defaulting, mutation);
                let who = self.any_caller();
                let res = self.exec(&who, &plan.msg, &[]);
                let retired = plan.key_status == "retired";
                self.expect_remedy(id, &g, &plan, &res);
                if res.is_ok() {
                    self.accepted.push((id, plan.msg.clone()));
                }
                let mut d = Self::done(act, Some(id), who, res);
                d.retired_signer = retired;
                Some(d)
            }
            Act::RotateRemedyKey => {
                let admin = self.s.admin.clone();
                let key = Key::remedy(self.next_remedy_label);
                self.next_remedy_label += 1;
                let res = self.exec(
                    &admin,
                    &ExecuteMsg::AddRemedyKey {
                        pubkey: key.pubkey.clone(),
                    },
                    &[],
                );
                let key_id: u16 = attr(res.as_ref().unwrap(), "key_id").parse().unwrap();
                self.remedy_keys.push((key_id, key));
                let old: Vec<u16> = self
                    .remedy_keys
                    .iter()
                    .map(|(id, _)| *id)
                    .filter(|id| *id != key_id && !self.remedy_retired.contains(id))
                    .collect();
                let mut d = if old.is_empty() {
                    Self::done(act, None, admin, res)
                } else {
                    let victim = self.rng.pick(&old);
                    let compromised = self.rng.chance(40);
                    let res = self.exec(
                        &admin,
                        &ExecuteMsg::RetireRemedyKey {
                            key_id: victim,
                            compromised,
                        },
                        &[],
                    );
                    self.remedy_retired.insert(victim);
                    if compromised {
                        self.remedy_compromised.insert(victim);
                    }
                    let mut d = Self::done(act, None, admin, res);
                    d.compromise = compromised;
                    d
                };
                d.admin = true;
                Some(d)
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
            if b.settlement
                .as_ref()
                .is_some_and(|st| st.source == SettlementSource::RemedyStrike3)
            {
                *self
                    .strike3_closed
                    .entry(format!("{:?}", o.route))
                    .or_default() += 1;
            }
            if o.route == Route::RemedyForeclosure {
                // (20) The foreclosure formula, from an independent model.
                assert_eq!(a.state, GameState::Settled);
                assert!(a.settlement.is_none(), "a foreclosure stores no settlement");
                let r = a.remedy.as_ref().unwrap();
                let d_seat = usize::from(r.defaulting_seat);
                let others = b.seats.len() as u128 - 1;
                let forfeited = b.seats[d_seat].net_deposit.u128();
                let (share, dust) = (forfeited / others, forfeited % others);
                let amounts: Vec<u128> = b
                    .seats
                    .iter()
                    .enumerate()
                    .map(|(i, seat)| {
                        if i == d_seat {
                            0
                        } else {
                            seat.net_deposit.u128() + share
                        }
                    })
                    .collect();
                assert_eq!(
                    o.amounts.iter().map(|x| x.u128()).collect::<Vec<_>>(),
                    amounts
                );
                assert_eq!(o.dust.u128(), dust);
                assert_eq!(o.distributed.u128(), b.pool.u128());
                for (seat, amount) in b.seats.iter().zip(amounts.iter()) {
                    add(&seat.wallet, *amount);
                }
                add(&a.terms.treasury, dust);
            } else if a.state == GameState::Settled {
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
            // Resolver timeout on a compromised settlement: fallback checkpoint
            // (a 2.0.0-shaped game only; a 2.1.0 game refunds instead).
            assert_eq!(
                a.terms.policy, None,
                "a 2.1.0 game fell back to a checkpoint"
            );
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
                        | Act::RequestReview
                        | Act::ReviewAnnul
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
                        .filter(|st| self.settlement_compromised(st))
                        .map(|st| st.payload.signer_key_id);
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
                // (20) a foreclosing remedy never succeeds while paused.
                if self.paused && d.act == Act::Remedy {
                    let route = d
                        .game
                        .and_then(|id| after.games.get(&id))
                        .and_then(|g| g.outcome.as_ref())
                        .map(|o| o.route);
                    assert!(
                        matches!(route, Some(Route::RemedyTimeoutAnnul | Route::RemedyAnnul)),
                        "a foreclosing remedy succeeded while paused: {route:?}"
                    );
                }
                // (8)
                assert!(!d.retired_signer, "a retired signer's payload was accepted");
                // (17) Finalize and Consent never accept a stored settlement
                // whose key is compromised, and no direct payout ever comes
                // from one.
                if let (Some(id), true) = (d.game, matches!(d.act, Act::Finalize | Act::Consent)) {
                    if let Some(st) = before.games.get(&id).and_then(|g| g.settlement.as_ref()) {
                        assert!(
                            !self.settlement_compromised(st),
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
                        let st = a.settlement.as_ref().unwrap();
                        assert!(
                            !self.settlement_compromised(st),
                            "(17) game {id} paid a settlement signed by compromised key {}",
                            st.payload.signer_key_id
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
            // (18) the policy a game was created with never changes, and a
            // 2.1.0 game never stores a checkpoint as its settlement.
            if let Some(policy) = self.policy.get(id) {
                assert_eq!(&g.terms.policy, policy, "policy of {id} changed");
            }
            if g.terms.policy.is_some() {
                if let Some(st) = &g.settlement {
                    assert_ne!(
                        st.source,
                        SettlementSource::LivenessCheckpoint,
                        "2.1.0 game {id} promoted a checkpoint"
                    );
                }
            }
            // (19) only a 2.1.0 game is ever asked to review, and the first
            // request is never overwritten.
            if g.review_request.is_some() {
                assert!(g.terms.policy.is_some());
            }
            // (20) only a TimedRemedyV1 game ever holds a remedy.
            if g.remedy.is_some() {
                assert_eq!(g.terms.policy, Some(GamePolicy::TimedRemedyV1));
            }
            if let Some(b) = before.games.get(id) {
                if b.review_request.is_some() && b.review_request != g.review_request {
                    // Only an accepted Checkpoint message withdraws a request
                    // (ForgeHugeSeq posts one under a leaked key: a signer can
                    // withdraw requests, never move money).
                    assert!(
                        g.review_request.is_none()
                            && matches!(d.act, Act::Checkpoint | Act::ForgeHugeSeq)
                            && d.res.is_ok(),
                        "review request of {id} changed by {:?}",
                        d.act
                    );
                }
                if b.state == GameState::InProgress
                    && g.state != GameState::InProgress
                    && g.terms.policy.is_some()
                {
                    // A 2.1.0 game leaves IN_PROGRESS only by Settle, unanimity,
                    // the review or a remedy.
                    let route = g.outcome.as_ref().map(|o| o.route);
                    let source = g.settlement.as_ref().map(|st| st.source);
                    assert!(
                        g.state == GameState::Settleable
                            && (source == Some(SettlementSource::TerminalPayload)
                                || source == Some(SettlementSource::RemedyStrike3)
                                    && d.act == Act::Remedy)
                            || matches!(
                                route,
                                Some(
                                    Route::AllConsentsAtSettle
                                        | Route::AnnulByConsent
                                        | Route::ReviewAnnul
                                )
                            )
                            || matches!(
                                route,
                                Some(
                                    Route::RemedyTimeoutAnnul
                                        | Route::RemedyAnnul
                                        | Route::RemedyForeclosure
                                )
                            ) && d.act == Act::Remedy,
                        "2.1.0 game {id} left IN_PROGRESS by {route:?} ({:?})",
                        g.state
                    );
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
                        .is_some_and(|st| self.settlement_compromised(st))
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
                if g.state == GameState::InProgress && g.terms.policy.is_some() {
                    // (13)/(18) No inactivity exit: unanimity or the review,
                    // both of which work while paused.
                    self.stall_v21_exit(id, true);
                    continue;
                }
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

    /// (19) The oracle for RequestReview, from the state before it.
    fn expect_request_review(
        &mut self,
        id: u64,
        g: &Game,
        who: &Addr,
        res: &Result<AppResponse, ContractError>,
    ) {
        let seat = g.seats.iter().position(|x| x.wallet == *who);
        let seated_resolver = g
            .resolver
            .as_ref()
            .is_some_and(|r| g.seats.iter().any(|x| x.wallet == *r));
        let expected = if g.state != GameState::InProgress {
            Err("wrong state")
        } else if seat.is_none() {
            Err("not seated")
        } else if g.terms.policy.is_none() {
            Err("not available")
        } else if seated_resolver {
            Err("seated")
        } else {
            Ok(())
        };
        match (res, expected) {
            (Ok(_), Ok(())) => {
                let after = self.s.game(id).game;
                match &g.review_request {
                    Some(first) => assert_eq!(after.review_request.as_ref(), Some(first)),
                    None => {
                        let r = after.review_request.unwrap();
                        assert_eq!(usize::from(r.seat_index), seat.unwrap());
                        assert_eq!(r.requested_at, self.s.now());
                    }
                }
                assert_eq!(after.state, GameState::InProgress);
            }
            (Err(ContractError::WrongState { .. }), Err("wrong state")) => {}
            (Err(ContractError::NotSeated { .. }), Err("not seated")) => {}
            (Err(ContractError::ReviewNotAvailable {}), Err("not available")) => {}
            (Err(ContractError::ResolverIsSeated {}), Err("seated")) => {}
            (got, want) => panic!("RequestReview on {id}: got {got:?}, expected {want:?}"),
        }
    }

    /// (19) The oracle for ReviewAnnul, from the state before it.
    fn expect_review_annul(
        &mut self,
        id: u64,
        g: &Game,
        who: &Addr,
        named: cosmwasm_std::Timestamp,
        res: &Result<AppResponse, ContractError>,
    ) {
        let seated_resolver = g
            .resolver
            .as_ref()
            .is_some_and(|r| g.seats.iter().any(|x| x.wallet == *r));
        let expected = if g.state != GameState::InProgress {
            Err("wrong state")
        } else if g.resolver.as_ref() != Some(who) {
            Err("unauthorized")
        } else if seated_resolver {
            Err("seated")
        } else if g.terms.policy.is_none() {
            Err("not available")
        } else {
            match g.review_request.as_ref() {
                None => Err("not requested"),
                Some(request) if request.requested_at != named => Err("mismatch"),
                Some(request)
                    if self.s.now()
                        < request.requested_at.plus_seconds(g.terms.review_delay_secs) =>
                {
                    Err("delay")
                }
                Some(_) => Ok(()),
            }
        };
        match (res, expected) {
            (Ok(_), Ok(())) => {
                let after = self.s.game(id).game;
                assert_eq!(after.state, GameState::Annulled);
                let o = after.outcome.unwrap();
                assert_eq!(o.route, Route::ReviewAnnul);
                let nets: Vec<Uint128> = g.seats.iter().map(|x| x.net_deposit).collect();
                assert_eq!(o.amounts, nets);
                assert!(o.dust.is_zero());
            }
            (Err(ContractError::WrongState { .. }), Err("wrong state")) => {}
            (Err(ContractError::Unauthorized { role }), Err("unauthorized")) => {
                assert_eq!(role, "resolver")
            }
            (Err(ContractError::ReviewNotAvailable {}), Err("not available")) => {}
            (Err(ContractError::ReviewNotRequested { .. }), Err("not requested")) => {}
            (Err(ContractError::ResolverIsSeated {}), Err("seated")) => {}
            (Err(ContractError::ReviewRequestMismatch { requested_at }), Err("mismatch")) => {
                assert_eq!(
                    Some(*requested_at),
                    g.review_request.as_ref().map(|r| r.requested_at)
                );
            }
            (Err(ContractError::ReviewDelayNotElapsed { at }), Err("delay")) => {
                let r = g.review_request.as_ref().unwrap();
                assert_eq!(*at, r.requested_at.plus_seconds(g.terms.review_delay_secs));
            }
            (got, want) => panic!("ReviewAnnul on {id}: got {got:?}, expected {want:?}"),
        }
    }

    /// (20) A remedy for game `id` of `kind` against `defaulting`, timed to be
    /// final now, under an active remedy key (mostly), with every N−1
    /// approval when the kind needs them; `mutation` breaks one rule.
    fn build_remedy(
        &mut self,
        id: u64,
        g: &Game,
        kind: RemedyKind,
        defaulting: u8,
        mutation: Option<u64>,
    ) -> RemedyPlan {
        let n = g.seats.len();
        let now = self.s.now().seconds();
        let started = g.started_at.map(|t| t.seconds()).unwrap_or(0);
        let trusted = self.view_trusted.get(&id).copied().unwrap_or(0);
        // The earliest overdue is one allowance after the start; Live 1/2 are
        // final at least one cure window after it (later when a pause froze
        // it). A game too young for that gets an attestation the contract
        // refuses on timing, as the model predicts.
        let cure = match kind {
            RemedyKind::LiveTimeoutAnnul | RemedyKind::LiveForeclose => g.terms.cure_window_secs,
            _ => 0,
        };
        let earliest = started + g.terms.allowance_secs;
        let slack = now.saturating_sub(earliest + cure);
        let final_at = now - self.rng.below(slack.min(120) + 1);
        let overdue_at = match kind {
            RemedyKind::LiveTimeoutAnnul | RemedyKind::LiveForeclose => {
                // Now and then a cure window a pause stretched.
                let room = final_at.saturating_sub(cure).saturating_sub(earliest);
                let paused = if self.rng.chance(4) {
                    self.rng.below(room.min(900) + 1)
                } else {
                    0
                };
                final_at.saturating_sub(cure + paused)
            }
            RemedyKind::LiveStrike3Foreclose => final_at,
            RemedyKind::AsyncAnnul | RemedyKind::AsyncForeclose => {
                let room = final_at.saturating_sub(earliest);
                final_at - self.rng.below(room.min(g.terms.allowance_secs) + 1)
            }
        };
        let attested_at = final_at + self.rng.below(now - final_at + 1);
        let strike = match kind {
            RemedyKind::LiveTimeoutAnnul | RemedyKind::LiveForeclose => 1 + self.rng.below(2) as u8,
            RemedyKind::LiveStrike3Foreclose => 3,
            RemedyKind::AsyncAnnul | RemedyKind::AsyncForeclose => 0,
        };
        let active: Vec<(u16, Key)> = self
            .remedy_keys
            .iter()
            .filter(|(k, _)| !self.remedy_retired.contains(k))
            .cloned()
            .collect();
        // A well-formed remedy (no mutation) always uses an active key; a
        // mutated one now and then a retired key (refused as such).
        let (mut key_id, key) = if active.is_empty() || (mutation.is_some() && self.rng.chance(12))
        {
            self.rng.pick(&self.remedy_keys)
        } else {
            self.rng.pick(&active)
        };
        let mut a = RemedyAttestation {
            version: 1,
            domain: Self::domain_of(g),
            chain_game_id: id,
            remedy: kind.as_byte(),
            defaulting_seat: defaulting,
            strike,
            overdue_epoch: 1 + self.rng.below(5),
            log_len: trusted / 2 + self.rng.below(3),
            log_hash: sha256(&[b"fuzz-remedy-log", &trusted.to_be_bytes()]),
            allowance_secs: g.terms.allowance_secs,
            overdue_at,
            final_at,
            attested_at,
            expires_at: attested_at + 1 + self.rng.below(MAX_REMEDY_TTL_SECS),
            evidence_hash: sha256(&[b"fuzz-clock", &final_at.to_be_bytes()]),
            remedy_key_id: key_id,
        };
        let mut signer = key.clone();
        let mut approval_seats: Vec<u8> = if kind.needs_approvals() {
            (0..n as u8).filter(|i| *i != defaulting).collect()
        } else {
            vec![]
        };
        let mut bad_approval: Option<usize> = None;
        let mut stale_approvals = false;
        match mutation {
            Some(0) => {
                // The other mode's remedy.
                a.remedy = match g.mode {
                    Mode::Live => self.rng.pick(&[4u8, 5]),
                    Mode::Async => self.rng.pick(&[1u8, 2, 3]),
                }
            }
            Some(1) => a.remedy = self.rng.pick(&[0u8, 6, 255]),
            Some(2) => {
                // A strike this remedy does not allow.
                a.strike = match kind {
                    RemedyKind::LiveTimeoutAnnul | RemedyKind::LiveForeclose => {
                        self.rng.pick(&[0u8, 3, 4, 9])
                    }
                    RemedyKind::LiveStrike3Foreclose => self.rng.pick(&[0u8, 1, 2, 4]),
                    RemedyKind::AsyncAnnul | RemedyKind::AsyncForeclose => {
                        self.rng.pick(&[1u8, 2, 3])
                    }
                }
            }
            Some(3) => a.defaulting_seat = n as u8 + self.rng.below(2) as u8,
            Some(4) => a.allowance_secs += 1,
            Some(5) => {
                // Not final yet.
                let ahead = 1 + self.rng.below(DAY);
                a.overdue_at += ahead;
                a.final_at += ahead;
                a.attested_at += ahead;
                a.expires_at += ahead;
            }
            Some(6) => a.expires_at = now - self.rng.below(2),
            Some(7) => a.expires_at = a.attested_at + MAX_REMEDY_TTL_SECS + 1 + self.rng.below(9),
            Some(8) => a.log_len = (trusted / 2).saturating_sub(1 + self.rng.below(2)),
            Some(9) => {
                signer = self.rng.pick(&[
                    Key::signer(1),
                    Key::seat(0),
                    Key::admission(1),
                    Key::remedy(99),
                ])
            }
            Some(10) => {
                a.remedy_key_id = 200;
                key_id = 200;
            }
            Some(11) => {
                if approval_seats.is_empty() {
                    approval_seats.push(self.rng.below(n.max(1) as u64) as u8);
                } else {
                    approval_seats.remove(self.rng.below(approval_seats.len() as u64) as usize);
                }
            }
            Some(12) => approval_seats.push(defaulting),
            Some(13) => {
                if let Some(first) = approval_seats.first().copied() {
                    approval_seats.push(first);
                }
            }
            Some(14) => {
                if !approval_seats.is_empty() {
                    bad_approval = Some(self.rng.below(approval_seats.len() as u64) as usize);
                }
            }
            Some(16) => {
                // Attested "after" the block time (a signer clock ahead), or
                // before its own finality.
                if self.rng.chance(50) {
                    a.attested_at = now + 1 + self.rng.below(60);
                    a.expires_at = a.attested_at + 1 + self.rng.below(MAX_REMEDY_TTL_SECS);
                } else {
                    a.attested_at = a.final_at.saturating_sub(1 + self.rng.below(60));
                }
            }
            Some(17) => {
                // Approvals collected for ANOTHER overdue instance (a cured
                // one: an earlier overdue moment or log position).
                if !approval_seats.is_empty() {
                    stale_approvals = true;
                }
            }
            Some(_) => {
                // Another game's domain (cross-game confusion).
                a.domain = sha256(&[b"another-game", &a.domain]);
            }
            None => {}
        }
        let _ = key_id;
        // Approvals: each listed seat's current key over the digest naming it
        // (an out-of-range seat signs with a stranger's key).
        let domain = Self::domain_of(g);
        let mut approvals = Vec::new();
        let mut meta = Vec::new();
        for (k, seat) in approval_seats.iter().enumerate() {
            // A stale set names the instance's earlier position (one seat of
            // it, at random, still signs the current one).
            let stale = stale_approvals && k != 0;
            let (log_len, overdue_at) = if stale {
                (
                    a.log_len.saturating_sub(1 + self.rng.below(3)),
                    a.overdue_at.saturating_sub(1 + self.rng.below(DAY)),
                )
            } else {
                (a.log_len, a.overdue_at)
            };
            let digest = crypto::remedy_approve_digest(
                &domain,
                id,
                a.remedy,
                a.defaulting_seat,
                a.strike,
                a.overdue_epoch,
                log_len,
                &a.log_hash,
                overdue_at,
                *seat,
            );
            let in_range = usize::from(*seat) < n;
            let good = in_range && bad_approval != Some(k) && !stale;
            let signer_key = if good {
                self.current_key(id, g, usize::from(*seat))
            } else {
                Key::from_label("18JUNO/TEST/fuzz/approval-forger")
            };
            approvals.push(SeatSignature {
                seat_index: *seat,
                signature: signer_key.sign(&digest),
            });
            meta.push((*seat, good));
        }
        let registered = self
            .remedy_keys
            .iter()
            .find(|(k, _)| *k == a.remedy_key_id)
            .map(|(_, key)| key.clone());
        let key_status = match &registered {
            None => "unknown",
            Some(_) if self.remedy_retired.contains(&a.remedy_key_id) => "retired",
            Some(_) => "active",
        };
        let sig_ok = registered.is_some_and(|k| k.pubkey == signer.pubkey);
        let digest = crypto::remedy_digest(&a.encode().unwrap());
        let msg = ExecuteMsg::SubmitRemedy {
            chain_game_id: id,
            attestation: RemedyAttestationV1::from(&a),
            signature: signer.sign(&digest),
            approvals,
        };
        RemedyPlan {
            a,
            msg,
            key_status,
            sig_ok,
            approvals: meta,
        }
    }

    /// (20) The independent model of `SubmitRemedy`, in the contract's check
    /// order, from the game as it stood before the message.
    fn predict_remedy(&self, id: u64, g: &Game, plan: &RemedyPlan) -> Result<(), &'static str> {
        let a = &plan.a;
        let now = self.s.now().seconds();
        let n = g.seats.len();
        if g.state != GameState::InProgress {
            return Err("wrong state");
        }
        if g.terms.policy != Some(GamePolicy::TimedRemedyV1) {
            return Err("not available");
        }
        let Some(kind) = RemedyKind::from_byte(a.remedy) else {
            return Err("bad kind");
        };
        if kind.forecloses() && self.paused {
            return Err("paused");
        }
        if a.version != 1 {
            return Err("bad version");
        }
        if kind.mode() != g.mode {
            return Err("not for mode");
        }
        if a.domain != Self::domain_of(g) || a.chain_game_id != id {
            return Err("domain");
        }
        if usize::from(a.defaulting_seat) >= n {
            return Err("seat range");
        }
        let strike_ok = match kind {
            RemedyKind::LiveTimeoutAnnul | RemedyKind::LiveForeclose => {
                a.strike == 1 || a.strike == 2
            }
            RemedyKind::LiveStrike3Foreclose => a.strike == 3,
            _ => a.strike == 0,
        };
        if !strike_ok {
            return Err("strike");
        }
        if a.allowance_secs != g.terms.allowance_secs {
            return Err("allowance");
        }
        let started = g.started_at.unwrap().seconds();
        let final_ok = match kind {
            RemedyKind::LiveTimeoutAnnul | RemedyKind::LiveForeclose => {
                a.final_at >= a.overdue_at + g.terms.cure_window_secs
            }
            RemedyKind::LiveStrike3Foreclose => a.final_at == a.overdue_at,
            _ => a.final_at >= a.overdue_at,
        };
        if a.overdue_at < started + g.terms.allowance_secs
            || !final_ok
            || a.attested_at < a.final_at
            || a.expires_at <= a.attested_at
            || a.expires_at > a.attested_at + MAX_REMEDY_TTL_SECS
        {
            return Err("timing");
        }
        if now < a.final_at {
            return Err("not final");
        }
        if now < a.attested_at {
            return Err("timing");
        }
        if now >= a.expires_at {
            return Err("expired");
        }
        let trusted = self.view_trusted.get(&id).copied().unwrap_or(0);
        // The contract's rule, spelled as it is: seq = 2·log_len + 1 must
        // exceed the trusted sequence.
        let seq = 2 * a.log_len + 1;
        if seq <= trusted {
            return Err("stale");
        }
        match plan.key_status {
            "unknown" => return Err("unknown key"),
            "retired" => return Err("retired key"),
            _ => {}
        }
        if !plan.sig_ok {
            return Err("invalid signature");
        }
        if kind.needs_approvals() {
            let mut seen = BTreeSet::new();
            for (seat, good) in &plan.approvals {
                if usize::from(*seat) >= n {
                    return Err("seat range");
                }
                if *seat == a.defaulting_seat {
                    return Err("defaulter");
                }
                if !seen.insert(*seat) {
                    return Err("duplicate");
                }
                if !good {
                    return Err("invalid consent");
                }
            }
            if (0..n as u8).any(|i| i != a.defaulting_seat && !seen.contains(&i)) {
                return Err("missing");
            }
        } else if !plan.approvals.is_empty() {
            return Err("approvals not allowed");
        }
        Ok(())
    }

    /// (20) Compares a SubmitRemedy result with the model, and an accepted
    /// remedy's effect with its kind.
    fn expect_remedy(
        &mut self,
        id: u64,
        g: &Game,
        plan: &RemedyPlan,
        res: &Result<AppResponse, ContractError>,
    ) {
        let want = self.predict_remedy(id, g, plan);
        match (res, want) {
            (Ok(_), Ok(())) => {
                let kind = RemedyKind::from_byte(plan.a.remedy).unwrap();
                *self.remedies_ok.entry(kind.as_str()).or_default() += 1;
                let after = self.s.game(id).game;
                let r = after
                    .remedy
                    .as_ref()
                    .expect("an accepted remedy is recorded");
                assert_eq!(r.kind, kind);
                assert_eq!(r.defaulting_seat, plan.a.defaulting_seat);
                assert_eq!(
                    r.remedy_digest.to_vec(),
                    crypto::remedy_digest(&plan.a.encode().unwrap()).to_vec()
                );
                let route = after.outcome.as_ref().map(|o| o.route);
                match kind {
                    RemedyKind::LiveTimeoutAnnul => {
                        assert_eq!(after.state, GameState::Annulled);
                        assert_eq!(route, Some(Route::RemedyTimeoutAnnul));
                    }
                    RemedyKind::AsyncAnnul => {
                        assert_eq!(after.state, GameState::Annulled);
                        assert_eq!(route, Some(Route::RemedyAnnul));
                    }
                    RemedyKind::LiveForeclose | RemedyKind::AsyncForeclose => {
                        assert_eq!(after.state, GameState::Settled);
                        assert_eq!(route, Some(Route::RemedyForeclosure));
                    }
                    RemedyKind::LiveStrike3Foreclose => {
                        assert_eq!(after.state, GameState::Settleable);
                        let st = after.settlement.as_ref().unwrap();
                        assert_eq!(st.source, SettlementSource::RemedyStrike3);
                        assert_eq!(st.payload.seq.u64(), 2 * plan.a.log_len + 1);
                        assert_eq!(st.payload.signer_key_id, plan.a.remedy_key_id);
                        let weights: Vec<u128> = st
                            .payload
                            .settlement_weights
                            .iter()
                            .map(|w| w.u128())
                            .collect();
                        let expected: Vec<u128> = (0..g.seats.len() as u8)
                            .map(|i| u128::from(i != plan.a.defaulting_seat))
                            .collect();
                        assert_eq!(weights, expected, "a third strike pays 1/0, no standings");
                        assert_eq!(
                            st.window_end,
                            self.s.now().plus_seconds(g.terms.challenge_window_secs)
                        );
                    }
                }
            }
            (Err(e), Err(label)) => {
                assert_eq!(remedy_err_label(e), label, "SubmitRemedy on {id}: {e:?}");
                *self.remedies_refused.entry(label).or_default() += 1;
            }
            (got, want) => panic!("SubmitRemedy on {id}: got {got:?}, expected {want:?}"),
        }
    }

    /// (18) A 2.1.0 IN_PROGRESS game that has idled: the liveness exit stays
    /// refused; then it sometimes leaves by unanimity or the review.
    fn stall_v21(&mut self, id: u64) {
        let before = self.begin();
        let g = self.game_of(id);
        let who = g.seats[0].wallet.clone();
        let res = self.exec(&who, &Suite::liveness_msg(id), &[]);
        assert_eq!(
            res.as_ref().unwrap_err(),
            &ContractError::LivenessExitRemoved {},
            "a 2.1.0 game must never open an inactivity exit"
        );
        self.liveness_removed += 1;
        let d = Self::done(Act::Liveness, Some(id), who, res);
        self.check(&d, &before);
        if self.rng.chance(60) {
            self.stall_v21_exit(id, false);
        }
    }

    /// Takes a 2.1.0 IN_PROGRESS game out by unanimous AnnulByConsent, a
    /// seated RequestReview followed by the game resolver's ReviewAnnul, or
    /// (Timed) a neutral remedy relayed under an active remedy key. Every
    /// sub-step is checked on its own; with `must` the game must end terminal
    /// (all three work while paused).
    fn stall_v21_exit(&mut self, id: u64, must: bool) {
        self.begin();
        let g = self.game_of(id);
        let seated_resolver = g
            .resolver
            .as_ref()
            .is_some_and(|r| g.seats.iter().any(|x| x.wallet == *r));
        let route = self.rng.below(3);
        if g.terms.policy == Some(GamePolicy::TimedRemedyV1) && route == 0 {
            // An overdue can be final only once a whole allowance (Live: plus
            // the cure window) has run since the start.
            let ready =
                g.started_at.unwrap().seconds() + g.terms.allowance_secs + g.terms.cure_window_secs;
            let now = self.s.now().seconds();
            if now < ready {
                self.s.advance(ready - now);
            }
            let before = self.begin();
            let g = self.game_of(id);
            let kind = match g.mode {
                Mode::Live => RemedyKind::LiveTimeoutAnnul,
                Mode::Async => RemedyKind::AsyncAnnul,
            };
            let defaulting = self.rng.below(g.seats.len() as u64) as u8;
            let plan = self.build_remedy(id, &g, kind, defaulting, None);
            let who = self.any_caller();
            let res = self.exec(&who, &plan.msg, &[]);
            assert!(res.is_ok(), "neutral remedy refused: {res:?}");
            self.expect_remedy(id, &g, &plan, &res);
            let d = Self::done(Act::Remedy, Some(id), who, res);
            self.check(&d, &before);
        } else if !seated_resolver && route == 1 {
            if g.review_request.is_none() {
                let before = self.begin();
                let who = g.seats[self.rng.below(g.seats.len() as u64) as usize]
                    .wallet
                    .clone();
                let res = self.exec(&who, &ExecuteMsg::RequestReview { chain_game_id: id }, &[]);
                assert!(res.is_ok(), "review request refused: {res:?}");
                self.expect_request_review(id, &g, &who, &res);
                let d = Self::done(Act::RequestReview, Some(id), who, res);
                self.check(&d, &before);
            }
            // The review delay runs from the request.
            self.s.advance(g.terms.review_delay_secs);
            let before = self.begin();
            let g = self.game_of(id);
            let resolver = g.resolver.clone().unwrap();
            let named = g.review_request.as_ref().unwrap().requested_at;
            let msg = ExecuteMsg::ReviewAnnul {
                chain_game_id: id,
                requested_at: named,
            };
            let res = self.exec(&resolver, &msg, &[]);
            assert!(res.is_ok(), "review annulment refused: {res:?}");
            self.expect_review_annul(id, &g, &resolver, named, &res);
            let d = Self::done(Act::ReviewAnnul, Some(id), resolver, res);
            self.check(&d, &before);
        } else {
            let before = self.begin();
            let g = self.game_of(id);
            let trusted = self.view_trusted.get(&id).copied().unwrap_or(0);
            let digest = crypto::annul_digest(&Self::domain_of(&g), trusted);
            let consents = (0..g.seats.len())
                .map(|seat| SeatSignature {
                    seat_index: seat as u8,
                    signature: self.current_key(id, &g, seat).sign(&digest),
                })
                .collect();
            let who = self.any_caller();
            let msg = ExecuteMsg::AnnulByConsent {
                chain_game_id: id,
                consents,
            };
            let res = self.exec(&who, &msg, &[]);
            assert!(res.is_ok(), "unanimous annulment refused: {res:?}");
            let d = Self::done(Act::Annul, Some(id), who, res);
            self.check(&d, &before);
        }
        if must {
            assert!(self.s.state(id).is_terminal());
        }
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
        ExecuteMsg::SubmitRemedy {
            attestation,
            signature,
            approvals,
            ..
        } => ExecuteMsg::SubmitRemedy {
            chain_game_id: to,
            attestation,
            signature,
            approvals,
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
    let mut liveness_removed = 0;
    let mut live_no_deadline_refused = 0;
    let mut policies: BTreeMap<String, usize> = BTreeMap::new();
    let mut remedies_ok: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut remedies_refused: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut strike3_closed: BTreeMap<String, usize> = BTreeMap::new();
    // Escrow 2.1.0: more seeds and longer sequences than ESCROW-2.x (14 × 700
    // with the remedies), so the three policy kinds and the remedy messages
    // share the depth the old suite reached alone.
    for seed in 0..14u64 {
        let mut f = Fuzz::new(0x18_c0_5e_5e_ed ^ seed.wrapping_mul(0x1000_0001));
        f.run(700);
        games += f.games.len();
        carried += f.carried_ok;
        paused_checkpoints += f.paused_checkpoints;
        compromised_refusals += f.compromised_refusals;
        direct_payouts += f.direct_payouts;
        liveness_removed += f.liveness_removed;
        live_no_deadline_refused += f.live_no_deadline_refused;
        for p in f.policy.values() {
            *policies.entry(format!("{p:?}")).or_default() += 1;
        }
        for (k, n) in &f.remedies_ok {
            *remedies_ok.entry(k).or_default() += n;
        }
        for (k, n) in &f.remedies_refused {
            *remedies_refused.entry(k).or_default() += n;
        }
        for (k, n) in &f.strike3_closed {
            *strike3_closed.entry(k.clone()).or_default() += n;
        }
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
    eprintln!(
        "fuzz (18/19): games by policy {policies:?}; {liveness_removed} IN_PROGRESS \
         liveness refusals on 2.1.0 games; {live_no_deadline_refused} live no-deadline creates refused"
    );
    assert_eq!(
        policies.len(),
        3,
        "every policy kind was created: {policies:?}"
    );
    assert!(
        liveness_removed > 0,
        "no 2.1.0 IN_PROGRESS liveness refusal"
    );
    assert!(
        live_no_deadline_refused > 0,
        "no live no-deadline create was refused"
    );
    assert!(
        compromised_refusals > 0,
        "no Finalize/Consent ever met a compromised settlement"
    );
    eprintln!(
        "fuzz (20): remedies accepted {remedies_ok:?}; refused {remedies_refused:?}; \
         third-strike settlements closed by {strike3_closed:?}"
    );
    // Remedies mixed into the whole workload; `remedy_focused_sequences_…`
    // drives every kind and every refusal.
    assert!(
        remedies_ok.len() >= 3,
        "too few remedy kinds accepted in the mixed workload: {remedies_ok:?}"
    );
    assert!(
        remedies_refused.len() >= 4,
        "too few remedy refusals in the mixed workload: {remedies_refused:?}"
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
        "ReviewAnnul",
        "RemedyTimeoutAnnul",
        "RemedyAnnul",
        "RemedyForeclosure",
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
        Act::RequestReview,
        Act::ReviewAnnul,
        Act::Remedy,
        Act::RotateRemedyKey,
    ] {
        assert!(
            ok.get(&act).copied().unwrap_or(0) > 0,
            "{act:?} never succeeded"
        );
    }
}

/// (20) Remedy-focused sequences: 2.1.0 games only, most of them Timed, many
/// remedies (half of them broken one rule at a time) among the other
/// messages, pauses and remedy-key rotations; every invariant is checked after
/// every step, and every remedy against the independent model.
#[test]
fn remedy_focused_sequences_preserve_every_invariant() {
    let mut remedies_ok: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut remedies_refused: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut strike3_closed: BTreeMap<String, usize> = BTreeMap::new();
    let mut routes: BTreeSet<String> = BTreeSet::new();
    for seed in 0..16u64 {
        let mut f = Fuzz::new_focused(0x2e_3e_d1_e5 ^ seed.wrapping_mul(0x9000_0011));
        f.run(700);
        for (k, n) in &f.remedies_ok {
            *remedies_ok.entry(k).or_default() += n;
        }
        for (k, n) in &f.remedies_refused {
            *remedies_refused.entry(k).or_default() += n;
        }
        for (k, n) in &f.strike3_closed {
            *strike3_closed.entry(k.clone()).or_default() += n;
        }
        routes.extend(f.routes_seen.iter().cloned());
    }
    eprintln!(
        "remedy fuzz: accepted {remedies_ok:?}; refused {remedies_refused:?}; \
         third-strike settlements closed by {strike3_closed:?}; routes {routes:?}"
    );
    for kind in [
        "live_timeout_annul",
        "live_foreclose",
        "live_strike3_foreclose",
        "async_annul",
        "async_foreclose",
    ] {
        assert!(
            remedies_ok.get(kind).copied().unwrap_or(0) > 0,
            "remedy {kind} never accepted: {remedies_ok:?}"
        );
    }
    for label in [
        "wrong state",
        "not available",
        "bad kind",
        "paused",
        "not for mode",
        "domain",
        "seat range",
        "strike",
        "allowance",
        "timing",
        "not final",
        "expired",
        "stale",
        "unknown key",
        "retired key",
        "invalid signature",
        "defaulter",
        "duplicate",
        "invalid consent",
        "missing",
        "approvals not allowed",
    ] {
        assert!(
            remedies_refused.get(label).copied().unwrap_or(0) > 0,
            "no remedy was refused as {label:?}: {remedies_refused:?}"
        );
    }
    for route in ["Finalized", "ResolverUphold", "ResolverAnnul"] {
        assert!(
            strike3_closed.contains_key(route),
            "no third-strike settlement closed by {route}: {strike3_closed:?}"
        );
    }
    for route in ["RemedyTimeoutAnnul", "RemedyAnnul", "RemedyForeclosure"] {
        assert!(routes.contains(route), "never took route {route}");
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
            Route::ReviewAnnul,
            Box::new(|s: &mut Suite| {
                s.no_deadline = true;
                let id = s.started(3);
                s.no_deadline = false;
                let seat = s.players[1].clone();
                s.exec(&seat, &ExecuteMsg::RequestReview { chain_game_id: id }, &[])
                    .unwrap();
                s.advance(400 * DAY);
                let resolver = s.resolver.clone();
                s.exec(&resolver, &s.review_annul_msg(id), &[]).unwrap();
                id
            }),
        ),
        (
            Route::LivenessRefund,
            Box::new(|s: &mut Suite| {
                // An escrow 2.0.0 game's IN_PROGRESS exit.
                let id = s.started(3);
                s.make_legacy(id);
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
                admission_pubkey: Key::admission(1).pubkey,
                remedy_keys: vec![Key::remedy(1).pubkey],
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
    // The IN_PROGRESS liveness exit of an escrow 2.0.0 game.
    let liveness = s.started(3);
    s.make_legacy(liveness);
    let (timeout, _) = s.disputed(3);
    // Escrow 2.1.0: the exceptional review, and the removed exit, which
    // answers LivenessExitRemoved, never Paused.
    s.no_deadline = true;
    let review = s.started(3);
    s.no_deadline = false;
    let timed = s.started(3);
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
    s.exec(
        &p1,
        &ExecuteMsg::RequestReview {
            chain_game_id: review,
        },
        &[],
    )
    .unwrap();
    s.advance(7 * DAY);
    let resolver = s.resolver.clone();
    s.exec(&resolver, &s.review_annul_msg(review), &[]).unwrap();
    assert_eq!(
        s.exec(&p1, &Suite::liveness_msg(timed), &[]).unwrap_err(),
        ContractError::LivenessExitRemoved {}
    );
    assert!(s.config().config.paused);
    for (id, state) in [
        (review, GameState::Annulled),
        (timed, GameState::InProgress),
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
    // Escrow 2.0.0 games (the IN_PROGRESS liveness exit and the checkpoint
    // fallback are 2.0.0 semantics; `inv13b` covers escrow 2.1.0 games).
    let mut s = Suite::new_legacy();
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

/// (13) for escrow 2.1.0 games: a permanent pause cannot trap FUNDING, FUNDED,
/// SETTLEABLE or DISPUTED funds, and an IN_PROGRESS game, which has no
/// inactivity exit, still leaves by unanimous annulment or (No-deadline) the
/// review, both of which work while paused. A compromised settlement falls
/// back to a refund, never to a trusted checkpoint's standings.
#[test]
fn inv13b_a_pause_traps_no_settled_result_and_v21_in_progress_needs_unanimity_or_review() {
    let mut s = Suite::new();
    let k2 = Key::signer(2);
    let k2_id = s.add_key(&k2);
    let funded = s.funded(3);
    let timed = s.started(3);
    s.post_checkpoint(timed, 10, &[1, 2, 3]);
    s.no_deadline = true;
    let no_deadline = s.started(3);
    s.no_deadline = false;
    let (settleable, _) = s.settleable(3);
    let (disputed, _) = s.disputed(3);
    // A settlement under key 2, compromised during the pause, on a game that
    // also holds a trusted checkpoint: 2.0.0 would promote that checkpoint.
    let fallback = s.started(3);
    s.post_checkpoint(fallback, 10, &[3, 2, 1]);
    let mut p = s.terminal_payload(fallback, 1, 20, &[1, 0, 0]);
    p.signer_key_id = k2_id;
    let (payload, signature) = s.signed_by(&p, &k2);
    let op = s.operator.clone();
    s.exec(
        &op,
        &ExecuteMsg::Settle {
            chain_game_id: fallback,
            payload,
            signature,
            consents: vec![],
        },
        &[],
    )
    .unwrap();

    s.pause();
    s.retire_key(k2_id, true);
    let seat0 = s.players[0].clone();
    let outsider = s.outsider.clone();
    s.advance(10 * 365 * DAY);
    s.exec(
        &outsider,
        &ExecuteMsg::Cancel {
            chain_game_id: funded,
        },
        &[],
    )
    .unwrap();
    for id in [settleable, disputed, fallback] {
        s.exec(&seat0, &Suite::liveness_msg(id), &[]).unwrap();
    }
    // Ten years idle: still no inactivity exit for either IN_PROGRESS game.
    for id in [timed, no_deadline] {
        assert_eq!(
            s.exec(&seat0, &Suite::liveness_msg(id), &[]).unwrap_err(),
            ContractError::LivenessExitRemoved {}
        );
        assert_eq!(s.state(id), GameState::InProgress);
    }
    // Unanimity (works while paused) ...
    let trusted = s.trusted_seq(timed);
    let consents = s.annul_sigs(timed, &[0, 1, 2], trusted);
    s.exec(
        &outsider,
        &ExecuteMsg::AnnulByConsent {
            chain_game_id: timed,
            consents,
        },
        &[],
    )
    .unwrap();
    // ... or the review of a No-deadline game (works while paused).
    let seat1 = s.players[1].clone();
    s.exec(
        &seat1,
        &ExecuteMsg::RequestReview {
            chain_game_id: no_deadline,
        },
        &[],
    )
    .unwrap();
    s.advance(7 * DAY);
    let resolver = s.resolver.clone();
    s.exec(&resolver, &s.review_annul_msg(no_deadline), &[])
        .unwrap();
    let route = |s: &Suite, id: u64| s.game(id).game.outcome.map(|o| o.route);
    assert_eq!(route(&s, funded), Some(Route::DeadlineCancel));
    assert_eq!(route(&s, settleable), Some(Route::SettleableTimeoutPayout));
    assert_eq!(route(&s, disputed), Some(Route::ResolverTimeoutPayout));
    assert_eq!(route(&s, fallback), Some(Route::SettleableTimeoutRefund));
    assert_eq!(
        s.game(fallback).game.outcome.unwrap().amounts,
        vec![Uint128::new(NET); 3],
        "a refund, not the checkpoint's [3, 2, 1]"
    );
    assert_eq!(route(&s, timed), Some(Route::AnnulByConsent));
    assert_eq!(route(&s, no_deadline), Some(Route::ReviewAnnul));
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
    // LivenessSettle's choice is a 2.0.0 path: `d` is a 2.0.0-shaped game.
    s.make_legacy(d);
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
        admission: s.admission_for(id, &p1, &ticket(PLAYER_LABELS[1])),
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
    // The fallback to a trusted checkpoint is a 2.0.0 path (a 2.1.0 game
    // refunds instead: `inv13b`, `tests/escrow21.rs`).
    s.make_legacy(settleable);
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
