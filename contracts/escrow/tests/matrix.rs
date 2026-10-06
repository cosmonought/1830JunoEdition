//! The full permission matrix: EVERY execute message × every game state ×
//! paused/unpaused × every caller role, against an independent oracle written
//! from the frozen transition table (ESCROW-1.5 §9.1).
//!
//! Each cell runs in a fresh environment. The message carries everything else
//! it needs to succeed (exact funds, a valid signature, the right time), so the
//! oracle only has to decide state → role → pause, in that order. Every cell
//! also checks custody, and a refused cell checks that nothing changed.
//!
//! ESCROW-2.1 rows and rules: Checkpoint works while paused (OD-ESC2-1/2);
//! LivenessSettle covers SETTLEABLE (OD-ESC2-1) and may carry a checkpoint
//! (OD-ESC2-4); Resolve checks the game's frozen resolver, including after
//! `SetResolver` moved the global one (OD-ESC2-5).
//!
//! ESCROW-2.2 rows: Finalize and Consent after the stored settlement's signer
//! key was marked compromised. No cell of these rows can succeed; the key
//! check comes after state and pause.
//!
//! Escrow 2.1.0 rows and rules: every fixture is created by 2.1.0 code (a
//! `Timed` game unless the row says No-deadline), so the IN_PROGRESS
//! LivenessSettle cells answer `LivenessExitRemoved` (after state and role).
//! The `…Legacy` rows rerun LivenessSettle on fixtures rewritten into the
//! shape escrow 2.0.0 stored, which keep the 2.0.0 exit. RequestReview and
//! ReviewAnnul run on No-deadline fixtures (and, refused, on Timed ones):
//! state → role → policy → request, in that order; neither is blocked by
//! pause.

mod common;

use common::*;
use cosmwasm_std::{coins, Addr, Coin, HexBinary, Uint128};
use eighteen_cosmos_escrow::msg::{ExecuteMsg, ResolveOutcome, SeatSignature, SignedCheckpoint};
use eighteen_cosmos_escrow::payload::{Payload, KIND_CHECKPOINT, KIND_TERMINAL};
use eighteen_cosmos_escrow::state::{GameParams, GamePolicy, GameState, Mode, Route};
use eighteen_cosmos_escrow::ContractError;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Role {
    Admin,
    Operator,
    Resolver,
    Creator,
    Seat1,
    Outsider,
}

const ROLES: [Role; 6] = [
    Role::Admin,
    Role::Operator,
    Role::Resolver,
    Role::Creator,
    Role::Seat1,
    Role::Outsider,
];

const STATES: [GameState; 8] = [
    GameState::Funding,
    GameState::Funded,
    GameState::InProgress,
    GameState::Settleable,
    GameState::Disputed,
    GameState::Settled,
    GameState::Cancelled,
    GameState::Annulled,
];

#[derive(Clone, Copy, Debug)]
enum Msg {
    Join,
    Withdraw,
    /// Cancel before the funding deadline (creator only).
    CancelNow,
    /// Cancel once the funding deadline has passed (anyone).
    CancelAfterDeadline,
    SetConsentKey,
    Start,
    Checkpoint,
    Settle,
    Consent,
    Finalize,
    Challenge,
    Resolve,
    /// Resolve after the admin moved the global resolver to the outsider.
    ResolveAfterResolverChange,
    AnnulByConsent,
    LivenessSettle,
    /// LivenessSettle carrying a newer signed checkpoint.
    LivenessSettleWithCheckpoint,
    /// Finalize after the window, once key 1 (the signer of every fixture's
    /// stored settlement) was marked compromised.
    FinalizeCompromised,
    /// Consent once key 1 was marked compromised.
    ConsentCompromised,
    /// LivenessSettle on a fixture stored in the escrow 2.0.0 shape.
    LivenessSettleLegacy,
    /// LivenessSettle carrying a checkpoint, on a 2.0.0-shaped fixture.
    LivenessSettleWithCheckpointLegacy,
    /// RequestReview on a No-deadline fixture.
    RequestReview,
    /// RequestReview on a Timed fixture (never available).
    RequestReviewTimed,
    /// ReviewAnnul on a No-deadline fixture whose review seat 1 requested
    /// (IN_PROGRESS is the only state a request can be made in).
    ReviewAnnul,
    /// ReviewAnnul as above, after the admin moved the global resolver to the
    /// outsider: only the resolver the game adopted at Start may act.
    ReviewAnnulAfterResolverChange,
    /// ReviewAnnul on a No-deadline fixture nobody asked to review.
    ReviewAnnulWithoutRequest,
    /// ReviewAnnul on a Timed fixture (never available).
    ReviewAnnulTimed,
}

impl Msg {
    /// The row's fixtures are No-deadline games.
    fn no_deadline(self) -> bool {
        matches!(
            self,
            Msg::RequestReview
                | Msg::ReviewAnnul
                | Msg::ReviewAnnulAfterResolverChange
                | Msg::ReviewAnnulWithoutRequest
        )
    }

    /// The row's fixture is rewritten into the escrow 2.0.0 stored shape.
    fn legacy(self) -> bool {
        matches!(
            self,
            Msg::LivenessSettleLegacy | Msg::LivenessSettleWithCheckpointLegacy
        )
    }

    /// No cell of the row can succeed.
    fn never_accepted(self) -> bool {
        matches!(
            self,
            Msg::FinalizeCompromised
                | Msg::ConsentCompromised
                | Msg::LivenessSettleWithCheckpoint
                | Msg::RequestReviewTimed
                | Msg::ReviewAnnulWithoutRequest
                | Msg::ReviewAnnulTimed
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Expect {
    Ok(GameState),
    WrongState,
    NotSeated,
    AlreadyJoined,
    Unauthorized(&'static str),
    Paused,
    CompromisedSettlement,
    LivenessExitRemoved,
    ReviewNotAvailable,
    ReviewNotRequested,
}

fn addr(s: &Suite, role: Role) -> Addr {
    match role {
        Role::Admin => s.admin.clone(),
        Role::Operator => s.operator.clone(),
        Role::Resolver => s.resolver.clone(),
        Role::Creator => s.players[0].clone(),
        Role::Seat1 => s.players[1].clone(),
        Role::Outsider => s.outsider.clone(),
    }
}

/// The oracle, written from the transition table rather than from the code.
fn oracle(msg: Msg, state: GameState, role: Role, paused: bool) -> Expect {
    use GameState::*;
    let seated = matches!(role, Role::Creator | Role::Seat1);
    let within = |allowed: &[GameState]| allowed.contains(&state);
    match msg {
        Msg::Join => {
            if !within(&[Funding]) {
                Expect::WrongState
            } else if seated {
                Expect::AlreadyJoined
            } else if paused {
                Expect::Paused
            } else {
                Expect::Ok(Funded) // the fixture leaves one seat of three free
            }
        }
        Msg::Withdraw => {
            if !within(&[Funding, Funded]) {
                Expect::WrongState
            } else if !seated {
                Expect::NotSeated
            } else {
                Expect::Ok(Funding) // works while paused
            }
        }
        Msg::CancelNow => {
            if !within(&[Funding, Funded]) {
                Expect::WrongState
            } else if role != Role::Creator {
                Expect::Unauthorized("creator (or anyone after the funding deadline)")
            } else {
                Expect::Ok(Cancelled)
            }
        }
        Msg::CancelAfterDeadline => {
            if !within(&[Funding, Funded]) {
                Expect::WrongState
            } else {
                Expect::Ok(Cancelled)
            }
        }
        Msg::SetConsentKey => {
            if !within(&[Funding, Funded, InProgress, Settleable]) {
                Expect::WrongState
            } else if !seated {
                Expect::NotSeated
            } else {
                Expect::Ok(state)
            }
        }
        Msg::Start => {
            if !within(&[Funded]) {
                Expect::WrongState
            } else if role != Role::Operator {
                Expect::Unauthorized("operator")
            } else if paused {
                Expect::Paused
            } else {
                Expect::Ok(InProgress)
            }
        }
        Msg::Checkpoint => {
            if !within(&[InProgress]) {
                Expect::WrongState
            } else {
                Expect::Ok(InProgress) // anyone; works while paused (OD-ESC2-1/2)
            }
        }
        Msg::Settle => {
            if !within(&[InProgress]) {
                Expect::WrongState
            } else if paused {
                Expect::Paused
            } else {
                Expect::Ok(Settleable) // no consents attached
            }
        }
        Msg::Consent | Msg::Finalize => {
            if !within(&[Settleable]) {
                Expect::WrongState
            } else if paused {
                Expect::Paused
            } else if matches!(msg, Msg::Consent) {
                Expect::Ok(Settleable) // one consent of three
            } else {
                Expect::Ok(Settled)
            }
        }
        Msg::Challenge => {
            if !within(&[Settleable]) {
                Expect::WrongState
            } else if !seated {
                Expect::NotSeated
            } else {
                Expect::Ok(Disputed) // works while paused
            }
        }
        Msg::Resolve | Msg::ResolveAfterResolverChange => {
            // Only the resolver the game adopted at Start, even after the
            // global one moved (to the outsider, in the second row).
            if !within(&[Disputed]) {
                Expect::WrongState
            } else if role != Role::Resolver {
                Expect::Unauthorized("resolver")
            } else {
                Expect::Ok(Settled) // Uphold; works while paused
            }
        }
        Msg::AnnulByConsent => {
            if !within(&[InProgress, Settleable]) {
                Expect::WrongState
            } else {
                Expect::Ok(Annulled) // anyone relays; works while paused
            }
        }
        Msg::LivenessSettle => {
            if !within(&[InProgress, Settleable, Disputed]) {
                Expect::WrongState
            } else if !seated {
                Expect::NotSeated
            } else if state == InProgress {
                Expect::LivenessExitRemoved // escrow 2.1.0, works paused or not
            } else {
                // SETTLEABLE past window_end + liveness, DISPUTED past the
                // resolver timeout: the (uncompromised) stored vector is paid.
                Expect::Ok(Settled)
            }
        }
        Msg::LivenessSettleLegacy => {
            if !within(&[InProgress, Settleable, Disputed]) {
                Expect::WrongState
            } else if !seated {
                Expect::NotSeated
            } else if state == InProgress {
                Expect::Ok(Cancelled) // no checkpoint was posted
            } else {
                // SETTLEABLE past window_end + liveness, DISPUTED past the
                // resolver timeout: the (uncompromised) stored vector is paid.
                Expect::Ok(Settled)
            }
        }
        Msg::FinalizeCompromised | Msg::ConsentCompromised => {
            // ESCROW-2.2: the stored settlement has lost its payout authority.
            if !within(&[Settleable]) {
                Expect::WrongState
            } else if paused {
                Expect::Paused
            } else {
                Expect::CompromisedSettlement
            }
        }
        Msg::LivenessSettleWithCheckpoint => {
            if !within(&[InProgress, Settleable, Disputed]) {
                Expect::WrongState
            } else if !seated {
                Expect::NotSeated
            } else if state != InProgress {
                Expect::WrongState // a checkpoint is only carried from IN_PROGRESS
            } else {
                Expect::LivenessExitRemoved // and nothing is stored
            }
        }
        Msg::LivenessSettleWithCheckpointLegacy => {
            if !within(&[InProgress, Settleable, Disputed]) {
                Expect::WrongState
            } else if !seated {
                Expect::NotSeated
            } else if state != InProgress {
                Expect::WrongState // a checkpoint is only carried from IN_PROGRESS
            } else {
                Expect::Ok(Settleable) // the carried checkpoint is promoted
            }
        }
        Msg::RequestReview | Msg::RequestReviewTimed => {
            if !within(&[InProgress]) {
                Expect::WrongState
            } else if !seated {
                Expect::NotSeated
            } else if matches!(msg, Msg::RequestReviewTimed) {
                Expect::ReviewNotAvailable
            } else {
                Expect::Ok(InProgress) // moves nothing; works while paused
            }
        }
        Msg::ReviewAnnul
        | Msg::ReviewAnnulAfterResolverChange
        | Msg::ReviewAnnulWithoutRequest
        | Msg::ReviewAnnulTimed => {
            if !within(&[InProgress]) {
                Expect::WrongState
            } else if role != Role::Resolver {
                Expect::Unauthorized("resolver")
            } else if matches!(msg, Msg::ReviewAnnulTimed) {
                Expect::ReviewNotAvailable
            } else if matches!(msg, Msg::ReviewAnnulWithoutRequest) {
                Expect::ReviewNotRequested
            } else {
                Expect::Ok(Annulled) // the neutral refund; works while paused
            }
        }
    }
}

/// A game in `state` with max 3 seats: FUNDING holds [creator, alice]; every
/// later state holds [creator, alice, bob]. Returns the stored settlement
/// payload where there is one.
fn fixture(s: &mut Suite, state: GameState) -> (u64, Option<Payload>) {
    match state {
        GameState::Funding => {
            let id = s.create(0, 3, Mode::Live, ANTE);
            s.join(id, 1, ANTE);
            (id, None)
        }
        GameState::Funded => (s.funded(3), None),
        GameState::InProgress => (s.started(3), None),
        GameState::Settleable => {
            let (id, p) = s.settleable(3);
            (id, Some(p))
        }
        GameState::Disputed => {
            let (id, p) = s.disputed(3);
            (id, Some(p))
        }
        GameState::Settled => (s.settled(3), None),
        GameState::Cancelled => {
            let id = s.create(0, 3, Mode::Live, ANTE);
            s.join(id, 1, ANTE);
            let creator = s.players[0].clone();
            s.exec(&creator, &ExecuteMsg::Cancel { chain_game_id: id }, &[])
                .unwrap();
            (id, None)
        }
        GameState::Annulled => (s.annulled(3), None),
    }
}

fn domain_or_zero(s: &Suite, id: u64) -> [u8; 32] {
    s.game(id)
        .game
        .domain
        .map(|d| <[u8; 32]>::try_from(d.as_slice()).unwrap())
        .unwrap_or([0u8; 32])
}

fn fresh_payload(s: &Suite, id: u64, kind: u8, reason: u8) -> Payload {
    let mut p = s.payload_unchecked(id, kind, reason, 1_000);
    p.domain = domain_or_zero(s, id);
    p
}

fn build(
    s: &Suite,
    msg: Msg,
    id: u64,
    role: Role,
    stored: &Option<Payload>,
) -> (ExecuteMsg, Vec<Coin>) {
    let fresh_key = Key::from_label(&format!("18JUNO/TEST/matrix/{role:?}"));
    match msg {
        Msg::Join => (
            ExecuteMsg::Join {
                chain_game_id: id,
                consent_pubkey: fresh_key.pubkey,
                join_ticket: ticket("matrix"),
                // Admitted for the caller the matrix sends it from: the matrix
                // tests who may Join in which state, not the admission (see
                // join_admission.rs).
                admission: s.admission_for(id, &addr(s, role), &ticket("matrix")),
            },
            coins(ANTE, DENOM),
        ),
        Msg::Withdraw => (ExecuteMsg::Withdraw { chain_game_id: id }, vec![]),
        Msg::CancelNow | Msg::CancelAfterDeadline => {
            (ExecuteMsg::Cancel { chain_game_id: id }, vec![])
        }
        Msg::SetConsentKey => (
            ExecuteMsg::SetConsentKey {
                chain_game_id: id,
                new_pubkey: fresh_key.pubkey,
            },
            vec![],
        ),
        Msg::Start => (
            ExecuteMsg::Start {
                chain_game_id: id,
                roster_hash: s.roster_hash(id),
            },
            vec![],
        ),
        Msg::Checkpoint => {
            let p = fresh_payload(s, id, KIND_CHECKPOINT, 0);
            let (payload, signature) = s.signed(&p);
            (
                ExecuteMsg::Checkpoint {
                    chain_game_id: id,
                    payload,
                    signature,
                },
                vec![],
            )
        }
        Msg::Settle => {
            let p = fresh_payload(s, id, KIND_TERMINAL, 1);
            let (payload, signature) = s.signed(&p);
            (
                ExecuteMsg::Settle {
                    chain_game_id: id,
                    payload,
                    signature,
                    consents: vec![],
                },
                vec![],
            )
        }
        Msg::Consent | Msg::ConsentCompromised => {
            let signature = match stored {
                Some(p) => Key::seat(0).sign(&s.consent_digest(id, p)),
                None => Key::seat(0).sign(&[7u8; 32]),
            };
            (
                ExecuteMsg::Consent {
                    chain_game_id: id,
                    seat_index: 0,
                    signature,
                },
                vec![],
            )
        }
        Msg::Finalize | Msg::FinalizeCompromised => {
            (ExecuteMsg::Finalize { chain_game_id: id }, vec![])
        }
        Msg::Challenge => {
            let bond = s.game(id).game.bond.map(|b| b.u128()).unwrap_or(1_000_000);
            (
                ExecuteMsg::Challenge {
                    chain_game_id: id,
                    evidence_hash: HexBinary::from(vec![0xeeu8; 32]),
                },
                coins(bond, DENOM),
            )
        }
        Msg::Resolve | Msg::ResolveAfterResolverChange => (
            ExecuteMsg::Resolve {
                chain_game_id: id,
                outcome: ResolveOutcome::Uphold {},
            },
            vec![],
        ),
        Msg::AnnulByConsent => {
            let g = s.game(id);
            let consents = match g.game.domain {
                Some(_) => s.annul_sigs(id, &[0, 1, 2], g.trusted_seq.u64()),
                None => vec![SeatSignature {
                    seat_index: 0,
                    signature: Key::seat(0).sign(&[8u8; 32]),
                }],
            };
            (
                ExecuteMsg::AnnulByConsent {
                    chain_game_id: id,
                    consents,
                },
                vec![],
            )
        }
        Msg::LivenessSettle | Msg::LivenessSettleLegacy => (Suite::liveness_msg(id), vec![]),
        Msg::RequestReview | Msg::RequestReviewTimed => {
            (ExecuteMsg::RequestReview { chain_game_id: id }, vec![])
        }
        Msg::ReviewAnnul
        | Msg::ReviewAnnulAfterResolverChange
        | Msg::ReviewAnnulWithoutRequest
        | Msg::ReviewAnnulTimed => (s.review_annul_msg(id), vec![]),
        Msg::LivenessSettleWithCheckpoint | Msg::LivenessSettleWithCheckpointLegacy => {
            let p = fresh_payload(s, id, KIND_CHECKPOINT, 0);
            let (payload, signature) = s.signed(&p);
            (
                ExecuteMsg::LivenessSettle {
                    chain_game_id: id,
                    checkpoint: Some(SignedCheckpoint { payload, signature }),
                },
                vec![],
            )
        }
    }
}

trait Unchecked {
    fn payload_unchecked(&self, id: u64, kind: u8, reason: u8, log_len: u64) -> Payload;
}

impl Unchecked for Suite {
    /// `Suite::payload` without requiring a started game.
    fn payload_unchecked(&self, id: u64, kind: u8, reason: u8, log_len: u64) -> Payload {
        let seats = self.game(id).game.seats.len();
        Payload {
            version: 1,
            domain: [0u8; 32],
            seq: 2 * log_len + u64::from(kind),
            kind,
            reason,
            log_len,
            log_hash: sha256(&[b"log", &log_len.to_be_bytes()]),
            appraisal_log_len: log_len,
            appraisal_state_hash: sha256(&[b"state", &log_len.to_be_bytes()]),
            state_schema_version: 1,
            settlement_weights: (1..=seats as u128).collect(),
            signer_key_id: 1,
            issued_at: 1_790_000_000,
        }
    }
}

/// Runs one cell; returns whether the message succeeded.
fn run_cell(msg: Msg, state: GameState, role: Role, paused: bool) -> bool {
    let mut s = Suite::new();
    s.no_deadline = msg.no_deadline();
    s.legacy = msg.legacy();
    let (id, stored) = fixture(&mut s, state);
    s.no_deadline = false;
    s.legacy = false;
    let policy = s.game(id).game.terms.policy;
    if msg.legacy() {
        assert_eq!(policy, None);
    } else if msg.no_deadline() {
        assert_eq!(policy, Some(GamePolicy::NoDeadline));
    } else {
        assert_eq!(policy, Some(GamePolicy::TimedNoRemedies));
    }
    match msg {
        Msg::CancelAfterDeadline | Msg::Finalize => s.advance(DAY),
        Msg::FinalizeCompromised | Msg::ConsentCompromised => {
            if matches!(msg, Msg::FinalizeCompromised) {
                s.advance(DAY);
            }
            s.retire_key(1, true);
        }
        Msg::LivenessSettle
        | Msg::LivenessSettleWithCheckpoint
        | Msg::LivenessSettleLegacy
        | Msg::LivenessSettleWithCheckpointLegacy => s.advance(30 * DAY),
        Msg::ResolveAfterResolverChange => {
            let admin = s.admin.clone();
            let next = s.outsider.to_string();
            s.exec(&admin, &ExecuteMsg::SetResolver { resolver: next }, &[])
                .unwrap();
        }
        Msg::ReviewAnnul | Msg::ReviewAnnulAfterResolverChange => {
            if state == GameState::InProgress {
                let seat1 = s.players[1].clone();
                s.exec(
                    &seat1,
                    &ExecuteMsg::RequestReview { chain_game_id: id },
                    &[],
                )
                .unwrap();
            }
            if matches!(msg, Msg::ReviewAnnulAfterResolverChange) {
                let admin = s.admin.clone();
                let next = s.outsider.to_string();
                s.exec(&admin, &ExecuteMsg::SetResolver { resolver: next }, &[])
                    .unwrap();
            }
            // Years of inactivity change nothing for a No-deadline game.
            s.advance(3_650 * DAY);
        }
        Msg::ReviewAnnulWithoutRequest | Msg::ReviewAnnulTimed | Msg::RequestReviewTimed => {
            s.advance(3_650 * DAY);
        }
        _ => {}
    }
    if paused {
        s.pause();
    }
    let (execute, funds) = build(&s, msg, id, role, &stored);
    let who = addr(&s, role);
    let before = s.game(id).game;
    let balance = s.contract_balance();
    let caller_balance = s.balance(&who);
    let expected = oracle(msg, state, role, paused);
    let got = s.exec(&who, &execute, &funds);
    let cell = format!("{msg:?} × {state:?} × {role:?} × paused={paused}");
    match (&got, &expected) {
        (Ok(_), Expect::Ok(next)) => {
            assert_eq!(s.state(id), *next, "{cell}");
            if matches!(msg, Msg::Start) {
                // The game adopts the global resolver current at Start.
                assert_eq!(
                    s.game_resolver(id),
                    Some(s.config().config.resolver),
                    "{cell}"
                );
            }
        }
        (Err(ContractError::WrongState { actual, .. }), Expect::WrongState) => {
            assert_eq!(actual, state.as_str(), "{cell}");
        }
        (Err(ContractError::NotSeated { .. }), Expect::NotSeated) => {}
        (Err(ContractError::AlreadyJoined { .. }), Expect::AlreadyJoined) => {}
        (Err(ContractError::Unauthorized { role: r }), Expect::Unauthorized(want)) => {
            assert_eq!(r, want, "{cell}");
        }
        (Err(ContractError::Paused {}), Expect::Paused) => {}
        (Err(ContractError::CompromisedSettlement { key_id }), Expect::CompromisedSettlement) => {
            assert_eq!(*key_id, 1, "{cell}");
        }
        (Err(ContractError::LivenessExitRemoved {}), Expect::LivenessExitRemoved) => {}
        (Err(ContractError::ReviewNotAvailable {}), Expect::ReviewNotAvailable) => {}
        (Err(ContractError::ReviewNotRequested { chain_game_id }), Expect::ReviewNotRequested) => {
            assert_eq!(*chain_game_id, id, "{cell}");
        }
        _ => panic!("{cell}: got {got:?}, oracle says {expected:?}"),
    }
    if got.is_err() {
        assert_eq!(
            s.game(id).game,
            before,
            "{cell}: a refusal changed the game"
        );
        assert_eq!(s.contract_balance(), balance, "{cell}");
        assert_eq!(s.balance(&who), caller_balance, "{cell}");
    } else if matches!(msg, Msg::ReviewAnnul | Msg::ReviewAnnulAfterResolverChange) {
        // The only outcome: every seat's own net deposit, nothing else.
        let outcome = s.game(id).game.outcome.unwrap();
        assert_eq!(outcome.route, Route::ReviewAnnul, "{cell}");
        assert_eq!(outcome.amounts, vec![Uint128::new(NET); 3], "{cell}");
        assert_eq!(outcome.dust, Uint128::zero(), "{cell}");
        assert_eq!(
            s.balance(&who),
            caller_balance,
            "{cell}: the resolver got nothing"
        );
        assert_eq!(s.contract_balance(), balance - 3 * NET, "{cell}");
    }
    s.assert_custody();
    got.is_ok()
}

fn run_row(msg: Msg) {
    let (mut cells, mut accepted, mut compromised) = (0, 0, 0);
    for state in STATES {
        for paused in [false, true] {
            for role in ROLES {
                if run_cell(msg, state, role, paused) {
                    accepted += 1;
                }
                if oracle(msg, state, role, paused) == Expect::CompromisedSettlement {
                    compromised += 1;
                }
                cells += 1;
            }
        }
    }
    assert_eq!(cells, 96);
    if matches!(msg, Msg::FinalizeCompromised | Msg::ConsentCompromised) {
        // Nothing may pay or record consent to a compromised settlement: the
        // unpaused SETTLEABLE cells (one per role) answer CompromisedSettlement.
        assert_eq!(accepted, 0, "{msg:?}");
        assert_eq!(compromised, 6, "{msg:?}");
    } else if msg.never_accepted() {
        // Escrow 2.1.0: a 2.1.0 game never takes a carried checkpoint into
        // the (removed) IN_PROGRESS exit, and the review of a Timed game, or
        // of a game nobody asked to review, never succeeds, whoever sends it.
        assert_eq!(accepted, 0, "{msg:?}");
        assert_eq!(compromised, 0);
    } else {
        // Every other row exercises both sides of the oracle.
        assert!(
            accepted > 0 && accepted < cells,
            "{msg:?}: {accepted} of {cells}"
        );
        assert_eq!(compromised, 0);
    }
}

macro_rules! row {
    ($($name:ident => $msg:expr),* $(,)?) => {
        $(
            #[test]
            fn $name() {
                run_row($msg);
            }
        )*
    };
}

row! {
    matrix_join => Msg::Join,
    matrix_withdraw => Msg::Withdraw,
    matrix_cancel_before_deadline => Msg::CancelNow,
    matrix_cancel_after_deadline => Msg::CancelAfterDeadline,
    matrix_set_consent_key => Msg::SetConsentKey,
    matrix_start => Msg::Start,
    matrix_checkpoint => Msg::Checkpoint,
    matrix_settle => Msg::Settle,
    matrix_consent => Msg::Consent,
    matrix_finalize => Msg::Finalize,
    matrix_challenge => Msg::Challenge,
    matrix_resolve => Msg::Resolve,
    matrix_resolve_after_resolver_change => Msg::ResolveAfterResolverChange,
    matrix_annul_by_consent => Msg::AnnulByConsent,
    matrix_liveness_settle => Msg::LivenessSettle,
    matrix_liveness_settle_with_checkpoint => Msg::LivenessSettleWithCheckpoint,
    matrix_finalize_compromised => Msg::FinalizeCompromised,
    matrix_consent_compromised => Msg::ConsentCompromised,
    matrix_liveness_settle_legacy => Msg::LivenessSettleLegacy,
    matrix_liveness_settle_with_checkpoint_legacy => Msg::LivenessSettleWithCheckpointLegacy,
    matrix_request_review => Msg::RequestReview,
    matrix_request_review_timed => Msg::RequestReviewTimed,
    matrix_review_annul => Msg::ReviewAnnul,
    matrix_review_annul_after_resolver_change => Msg::ReviewAnnulAfterResolverChange,
    matrix_review_annul_without_request => Msg::ReviewAnnulWithoutRequest,
    matrix_review_annul_timed => Msg::ReviewAnnulTimed,
}

// ------------------------------------------------------------ global messages

#[derive(Clone, Copy, Debug)]
enum Global {
    CreateGame,
    /// Escrow 2.1.0: an Async No-deadline game.
    CreateGameNoDeadline,
    Pause,
    Unpause,
    AddSignerKey,
    RetireSignerKey,
    SetOperator,
    SetResolver,
    SetTreasury,
    SetParams,
}

const GLOBALS: [Global; 10] = [
    Global::CreateGame,
    Global::CreateGameNoDeadline,
    Global::Pause,
    Global::Unpause,
    Global::AddSignerKey,
    Global::RetireSignerKey,
    Global::SetOperator,
    Global::SetResolver,
    Global::SetTreasury,
    Global::SetParams,
];

fn global_msg(s: &Suite, g: Global, role: Role) -> (ExecuteMsg, Vec<Coin>) {
    match g {
        Global::CreateGame | Global::CreateGameNoDeadline => (
            ExecuteMsg::CreateGame {
                max_players: 2,
                mode: Mode::Async,
                rules_engine_version: RULES_ENGINE_VERSION,
                variants_digest: variants_digest(),
                consent_pubkey: Key::from_label(&format!("18JUNO/TEST/matrix/{role:?}")).pubkey,
                join_ticket: ticket("matrix-create"),
                no_deadline: matches!(g, Global::CreateGameNoDeadline),
            },
            coins(ANTE, DENOM),
        ),
        Global::Pause => (ExecuteMsg::Pause {}, vec![]),
        Global::Unpause => (ExecuteMsg::Unpause {}, vec![]),
        Global::AddSignerKey => (
            ExecuteMsg::AddSignerKey {
                pubkey: Key::signer(5).pubkey,
            },
            vec![],
        ),
        Global::RetireSignerKey => (
            ExecuteMsg::RetireSignerKey {
                key_id: 1,
                compromised: false,
            },
            vec![],
        ),
        Global::SetOperator => (
            ExecuteMsg::SetOperator {
                operator: s.addr("operator-next").to_string(),
            },
            vec![],
        ),
        Global::SetResolver => (
            ExecuteMsg::SetResolver {
                resolver: s.addr("resolver-next").to_string(),
            },
            vec![],
        ),
        Global::SetTreasury => (
            ExecuteMsg::SetTreasury {
                treasury: s.addr("treasury-next").to_string(),
            },
            vec![],
        ),
        Global::SetParams => (
            ExecuteMsg::SetParams {
                params: GameParams {
                    min_ante: Uint128::new(3_000_000),
                    ..default_params()
                },
            },
            vec![],
        ),
    }
}

#[test]
fn matrix_global_messages() {
    let mut cells = 0;
    for g in GLOBALS {
        for paused in [false, true] {
            for role in ROLES {
                let mut s = Suite::new();
                // Some games in flight, so "global" really is global.
                let live = s.started(2);
                let (open, _) = s.settleable(2);
                if paused {
                    s.pause();
                }
                let games_before = (s.game(live).game, s.game(open).game);
                let (msg, funds) = global_msg(&s, g, role);
                let who = addr(&s, role);
                let got = s.exec(&who, &msg, &funds);
                let cell = format!("{g:?} × {role:?} × paused={paused}");
                match g {
                    Global::CreateGame | Global::CreateGameNoDeadline => {
                        if paused {
                            assert_eq!(got.unwrap_err(), ContractError::Paused {}, "{cell}");
                        } else {
                            got.unwrap();
                        }
                    }
                    _ => {
                        if role == Role::Admin {
                            got.unwrap();
                        } else {
                            assert_eq!(
                                got.unwrap_err(),
                                ContractError::Unauthorized {
                                    role: "admin".to_string()
                                },
                                "{cell}"
                            );
                        }
                    }
                }
                assert_eq!(
                    (s.game(live).game, s.game(open).game),
                    games_before,
                    "{cell}: a global message changed an existing game"
                );
                s.assert_custody();
                cells += 1;
            }
        }
    }
    assert_eq!(cells, 10 * 2 * 6);
}

#[test]
fn matrix_unknown_game() {
    for msg in [
        Msg::Join,
        Msg::Withdraw,
        Msg::CancelNow,
        Msg::SetConsentKey,
        Msg::Checkpoint,
        Msg::Settle,
        Msg::Finalize,
        Msg::Resolve,
        Msg::LivenessSettle,
        Msg::LivenessSettleWithCheckpoint,
        Msg::RequestReview,
        Msg::ReviewAnnul,
    ] {
        for role in ROLES {
            let mut s = Suite::new();
            let (id, stored) = fixture(&mut s, GameState::InProgress);
            let (execute, funds) = build(&s, msg, id, role, &stored);
            let execute = retarget(execute, 404);
            let who = addr(&s, role);
            assert_eq!(
                s.exec(&who, &execute, &funds).unwrap_err(),
                ContractError::GameNotFound { chain_game_id: 404 },
                "{msg:?} {role:?}"
            );
        }
    }
}

fn retarget(msg: ExecuteMsg, to: u64) -> ExecuteMsg {
    match msg {
        ExecuteMsg::Join {
            consent_pubkey,
            join_ticket,
            admission,
            ..
        } => ExecuteMsg::Join {
            chain_game_id: to,
            consent_pubkey,
            join_ticket,
            admission,
        },
        ExecuteMsg::Withdraw { .. } => ExecuteMsg::Withdraw { chain_game_id: to },
        ExecuteMsg::Cancel { .. } => ExecuteMsg::Cancel { chain_game_id: to },
        ExecuteMsg::SetConsentKey { new_pubkey, .. } => ExecuteMsg::SetConsentKey {
            chain_game_id: to,
            new_pubkey,
        },
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
        ExecuteMsg::Finalize { .. } => ExecuteMsg::Finalize { chain_game_id: to },
        ExecuteMsg::Resolve { outcome, .. } => ExecuteMsg::Resolve {
            chain_game_id: to,
            outcome,
        },
        ExecuteMsg::LivenessSettle { checkpoint, .. } => ExecuteMsg::LivenessSettle {
            chain_game_id: to,
            checkpoint,
        },
        ExecuteMsg::RequestReview { .. } => ExecuteMsg::RequestReview { chain_game_id: to },
        ExecuteMsg::ReviewAnnul { requested_at, .. } => ExecuteMsg::ReviewAnnul {
            chain_game_id: to,
            requested_at,
        },
        other => panic!("not retargeted: {other:?}"),
    }
}
