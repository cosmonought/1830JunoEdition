//! Storage round-trip, shape and seam tests for [`StoredGame`] (ESCROW-2.3).
//!
//! Games come from two sources: hand-shaped fixtures for every lifecycle state
//! (2 and 7 seats, 43/63/90-character addresses), and a seeded SplitMix64
//! generator that sets every field independently, legal combination or not,
//! with extreme values mixed in. The storage layer must be lossless for all of
//! them.
use std::collections::BTreeSet;

use cosmwasm_std::testing::{mock_dependencies, mock_env, MockStorage};
use cosmwasm_std::{from_json, to_json_vec, Addr, HexBinary, Storage, Timestamp, Uint128, Uint64};

use super::{StoredGame, StoredGameView, GAMES};
use crate::helpers::{load_game, save_game};
use crate::msg::{GameResponse, GamesResponse, QueryMsg, SeatsResponse};
use crate::state::{
    Config, DisputeRecord, DisputeResolution, Game, GameParams, GamePolicy, GameState, GameTerms,
    Mode, Outcome, PayloadRecord, RemedyKind, RemedyRecord, ReviewRequest, Route, Seat,
    SettlementRecord, SettlementSource, CONFIG,
};

// ------------------------------------------------------------------ variants

fn all_states() -> Vec<GameState> {
    let all = vec![
        GameState::Funding,
        GameState::Funded,
        GameState::InProgress,
        GameState::Settleable,
        GameState::Disputed,
        GameState::Settled,
        GameState::Cancelled,
        GameState::Annulled,
    ];
    for s in &all {
        // A new variant must be added to the list above.
        match s {
            GameState::Funding
            | GameState::Funded
            | GameState::InProgress
            | GameState::Settleable
            | GameState::Disputed
            | GameState::Settled
            | GameState::Cancelled
            | GameState::Annulled => {}
        }
    }
    all
}

fn all_routes() -> Vec<Route> {
    let all = vec![
        Route::AllConsentsAtSettle,
        Route::ConsentCompleted,
        Route::Finalized,
        Route::ResolverUphold,
        Route::ResolverReplace,
        Route::ResolverAnnul,
        Route::ResolverTimeoutPayout,
        Route::ResolverTimeoutRefund,
        Route::AnnulByConsent,
        Route::CreatorCancel,
        Route::DeadlineCancel,
        Route::LivenessRefund,
        Route::SettleableTimeoutPayout,
        Route::SettleableTimeoutRefund,
        Route::ReviewAnnul,
        Route::RemedyTimeoutAnnul,
        Route::RemedyAnnul,
        Route::RemedyForeclosure,
    ];
    for r in &all {
        match r {
            Route::AllConsentsAtSettle
            | Route::ConsentCompleted
            | Route::Finalized
            | Route::ResolverUphold
            | Route::ResolverReplace
            | Route::ResolverAnnul
            | Route::ResolverTimeoutPayout
            | Route::ResolverTimeoutRefund
            | Route::AnnulByConsent
            | Route::CreatorCancel
            | Route::DeadlineCancel
            | Route::LivenessRefund
            | Route::SettleableTimeoutPayout
            | Route::SettleableTimeoutRefund
            | Route::ReviewAnnul
            | Route::RemedyTimeoutAnnul
            | Route::RemedyAnnul
            | Route::RemedyForeclosure => {}
        }
    }
    all
}

fn all_resolutions() -> Vec<DisputeResolution> {
    let all = vec![
        DisputeResolution::Upheld,
        DisputeResolution::Replaced,
        DisputeResolution::Annulled,
        DisputeResolution::ResolverTimeout,
        DisputeResolution::AnnulledByConsent,
    ];
    for r in &all {
        match r {
            DisputeResolution::Upheld
            | DisputeResolution::Replaced
            | DisputeResolution::Annulled
            | DisputeResolution::ResolverTimeout
            | DisputeResolution::AnnulledByConsent => {}
        }
    }
    all
}

fn all_sources() -> Vec<SettlementSource> {
    let all = vec![
        SettlementSource::TerminalPayload,
        SettlementSource::LivenessCheckpoint,
        SettlementSource::ResolverReplacement,
        SettlementSource::RemedyStrike3,
    ];
    for s in &all {
        match s {
            SettlementSource::TerminalPayload
            | SettlementSource::LivenessCheckpoint
            | SettlementSource::ResolverReplacement
            | SettlementSource::RemedyStrike3 => {}
        }
    }
    all
}

fn all_remedy_kinds() -> Vec<RemedyKind> {
    let all: Vec<RemedyKind> = (0..=255u8).filter_map(RemedyKind::from_byte).collect();
    assert_eq!(all.len(), 5);
    for k in &all {
        assert_eq!(RemedyKind::from_byte(k.as_byte()), Some(*k));
        match k {
            RemedyKind::LiveTimeoutAnnul
            | RemedyKind::LiveForeclose
            | RemedyKind::LiveStrike3Foreclose
            | RemedyKind::AsyncAnnul
            | RemedyKind::AsyncForeclose => {}
        }
    }
    all
}

fn all_policies() -> Vec<Option<GamePolicy>> {
    let all = vec![
        None,
        Some(GamePolicy::TimedRemedyV1),
        Some(GamePolicy::NoDeadline),
    ];
    for p in all.iter().flatten() {
        match p {
            GamePolicy::TimedRemedyV1 | GamePolicy::NoDeadline => {}
        }
    }
    all
}

// ----------------------------------------------------------------- generator

/// SplitMix64: deterministic, dependency-free.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn coin(&mut self) -> bool {
        self.next() & 1 == 1
    }
    fn pick<T: Clone>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize].clone()
    }
    fn u64(&mut self) -> u64 {
        match self.below(6) {
            0 => 0,
            1 => 1,
            2 => u64::MAX,
            3 => 1_790_000_000_000_000_000,
            _ => self.next(),
        }
    }
    fn u128(&mut self) -> u128 {
        match self.below(6) {
            0 => 0,
            1 => 1,
            2 => u128::MAX,
            3 => 1_950_000,
            _ => (u128::from(self.next()) << 64) | u128::from(self.next()),
        }
    }
    fn uint128(&mut self) -> Uint128 {
        Uint128::new(self.u128())
    }
    fn time(&mut self) -> Timestamp {
        Timestamp::from_nanos(self.u64())
    }
    fn bytes(&mut self, len: usize) -> HexBinary {
        HexBinary::from((0..len).map(|_| self.next() as u8).collect::<Vec<u8>>())
    }
    fn hex(&mut self) -> HexBinary {
        let len = self.pick(&[0usize, 1, 32, 33, 64]);
        self.bytes(len)
    }
    /// A 43-, 63- or 90-character (bech32 maximum) address, or an odd string:
    /// storage must not care what an `Addr` contains.
    fn addr(&mut self) -> Addr {
        let body: String = (0..90).map(|_| self.pick(&CHARSET)).collect();
        Addr::unchecked(match self.below(5) {
            0 => format!("juno1{}", &body[..38]),
            1 => format!("juno1{}", &body[..58]),
            2 => format!("juno1{}", &body[..85]),
            3 => "a \"quoted\" \\ addr \u{1F600}\u{0000}".to_string(),
            _ => String::new(),
        })
    }
    fn opt<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> Option<T> {
        if self.coin() {
            Some(f(self))
        } else {
            None
        }
    }
}

const CHARSET: [char; 32] = [
    'q', 'p', 'z', 'r', 'y', '9', 'x', '8', 'g', 'f', '2', 't', 'v', 'd', 'w', '0', 's', '3', 'j',
    'n', '5', '4', 'k', 'h', 'c', 'e', '6', 'm', 'u', 'a', '7', 'l',
];

fn seat(rng: &mut Rng) -> Seat {
    Seat {
        wallet: rng.addr(),
        consent_pubkey: rng.hex(),
        consent_key_rotated_at: rng.opt(Rng::time),
        join_ticket: rng.hex(),
        gross_deposit: rng.uint128(),
        subsidy_paid: rng.uint128(),
        net_deposit: rng.uint128(),
        joined_at: rng.time(),
    }
}

fn payload(rng: &mut Rng, n: usize) -> PayloadRecord {
    PayloadRecord {
        seq: Uint64::new(rng.u64()),
        kind: rng.next() as u8,
        reason: rng.next() as u8,
        log_len: Uint64::new(rng.u64()),
        log_hash: rng.hex(),
        appraisal_log_len: Uint64::new(rng.u64()),
        appraisal_state_hash: rng.hex(),
        state_schema_version: rng.next() as u16,
        settlement_weights: (0..n).map(|_| rng.uint128()).collect(),
        signer_key_id: rng.pick(&[0u16, 1, 2, 63, 64, u16::MAX]),
        issued_at: Uint64::new(rng.u64()),
        payload_digest: rng.hex(),
    }
}

fn settlement(rng: &mut Rng, n: usize) -> SettlementRecord {
    SettlementRecord {
        source: rng.pick(&all_sources()),
        payload: payload(rng, n),
        accepted_at: rng.time(),
        window_end: rng.time(),
    }
}

fn dispute(rng: &mut Rng) -> DisputeRecord {
    let resolutions = all_resolutions();
    DisputeRecord {
        challenger: rng.addr(),
        bond: rng.uint128(),
        evidence_hash: rng.hex(),
        disputed_at: rng.time(),
        resolution: rng.opt(|r| r.pick(&resolutions)),
        resolved_at: rng.opt(Rng::time),
    }
}

fn outcome(rng: &mut Rng, n: usize) -> Outcome {
    Outcome {
        route: rng.pick(&all_routes()),
        at: rng.time(),
        amounts: (0..n).map(|_| rng.uint128()).collect(),
        dust: rng.uint128(),
        distributed: rng.uint128(),
        bond_returned: rng.uint128(),
        bond_to_pool: rng.uint128(),
    }
}

fn terms(rng: &mut Rng) -> GameTerms {
    GameTerms {
        subsidy_bps: rng.next() as u16,
        bond_bps: rng.next() as u16,
        bond_floor: rng.uint128(),
        challenge_window_secs: rng.u64(),
        liveness_window_secs: rng.u64(),
        resolver_timeout_secs: rng.u64(),
        treasury: rng.addr(),
        review_delay_secs: rng.u64(),
        allowance_secs: rng.u64(),
        cure_window_secs: rng.u64(),
        policy: rng.pick(&all_policies()),
    }
}

fn remedy(rng: &mut Rng) -> RemedyRecord {
    RemedyRecord {
        kind: rng.pick(&all_remedy_kinds()),
        defaulting_seat: rng.next() as u8,
        strike: rng.next() as u8,
        overdue_epoch: Uint64::new(rng.u64()),
        log_len: Uint64::new(rng.u64()),
        log_hash: rng.hex(),
        allowance_secs: Uint64::new(rng.u64()),
        overdue_at: Uint64::new(rng.u64()),
        final_at: Uint64::new(rng.u64()),
        expires_at: Uint64::new(rng.u64()),
        evidence_hash: rng.hex(),
        remedy_key_id: rng.pick(&[0u16, 1, 2, 64, u16::MAX]),
        remedy_digest: rng.hex(),
        approvals_bitmap: rng.next() as u8,
        accepted_at: rng.time(),
    }
}

fn review(rng: &mut Rng) -> ReviewRequest {
    ReviewRequest {
        seat_index: rng.next() as u8,
        requested_at: rng.time(),
        trusted_seq: Uint64::new(rng.u64()),
    }
}

/// Every field set independently (legal or not).
fn arbitrary_game(rng: &mut Rng) -> Game {
    let n = rng.pick(&[0usize, 1, 2, 3, 7, 8]);
    let states = all_states();
    Game {
        chain_game_id: rng.u64(),
        state: rng.pick(&states),
        creator: rng.addr(),
        max_players: rng.next() as u8,
        mode: rng.pick(&[Mode::Live, Mode::Async]),
        rules_engine_version: rng.next() as u32,
        variants_digest: rng.hex(),
        denom: rng.pick(&[
            "ujuno".to_string(),
            "ujunox".to_string(),
            "ibc/ABC".to_string(),
            String::new(),
        ]),
        ante_gross: rng.uint128(),
        subsidy_per_seat: rng.uint128(),
        ante_net: rng.uint128(),
        terms: terms(rng),
        created_at: rng.time(),
        funding_deadline: rng.time(),
        pool: rng.uint128(),
        seats: (0..n).map(|_| seat(rng)).collect(),
        roster_hash: rng.opt(Rng::hex),
        domain: rng.opt(Rng::hex),
        bond: rng.opt(Rng::uint128),
        resolver: rng.opt(Rng::addr),
        started_at: rng.opt(Rng::time),
        last_activity: rng.opt(Rng::time),
        last_seq: Uint64::new(rng.u64()),
        settlement: rng.opt(|r| settlement(r, n)),
        consent_bitmap: rng.next() as u8,
        dispute: rng.opt(dispute),
        outcome: rng.opt(|r| outcome(r, n)),
        review_request: rng.opt(review),
        remedy: rng.opt(remedy),
    }
}

fn even(v: usize) -> bool {
    v & 1 == 0
}

/// A plausible game in `state` with `n` seats and `addr_len`-character wallets.
fn shaped_game(state: GameState, n: usize, addr_len: usize, variant: usize) -> Game {
    let mut rng = Rng(0x2300 + variant as u64);
    let wallet = |i: usize| -> Addr {
        let body: String = (0..addr_len.saturating_sub(5))
            .map(|k| CHARSET[(i * 7 + k * 3) % 32])
            .collect();
        Addr::unchecked(format!("juno1{body}"))
    };
    // Cancelled covers both a cancel before Start (even variants) and after.
    let unstarted = matches!(state, GameState::Funding | GameState::Funded)
        || (state == GameState::Cancelled && even(variant));
    let started = !unstarted;
    let seated = if state == GameState::Funding {
        n - 1
    } else {
        n
    };
    let seats: Vec<Seat> = (0..seated)
        .map(|i| Seat {
            wallet: wallet(i),
            consent_pubkey: rng.bytes(33),
            consent_key_rotated_at: (i % 3 == 1).then(|| Timestamp::from_seconds(1_790_000_100)),
            join_ticket: rng.bytes(32),
            gross_deposit: Uint128::new(2_000_000),
            subsidy_paid: Uint128::new(50_000),
            net_deposit: Uint128::new(1_950_000),
            joined_at: Timestamp::from_seconds(1_790_000_000 + i as u64),
        })
        .collect();
    let with_settlement = matches!(
        state,
        GameState::Settleable | GameState::Disputed | GameState::Settled
    ) || (state == GameState::Annulled && !even(variant));
    let settlement = with_settlement.then(|| SettlementRecord {
        source: all_sources()[variant % all_sources().len()],
        payload: payload(&mut rng, n),
        accepted_at: Timestamp::from_seconds(1_790_086_400),
        window_end: Timestamp::from_seconds(1_790_172_800),
    });
    let disputed = state == GameState::Disputed
        || (state == GameState::Settled && even(variant))
        || (state == GameState::Annulled && !even(variant));
    let resolution = match state {
        GameState::Disputed => None,
        _ => Some(all_resolutions()[variant % all_resolutions().len()]),
    };
    let dispute = disputed.then(|| DisputeRecord {
        challenger: wallet(1),
        bond: Uint128::new(1_000_000),
        evidence_hash: rng.bytes(32),
        disputed_at: Timestamp::from_seconds(1_790_090_000),
        resolution,
        resolved_at: resolution.map(|_| Timestamp::from_seconds(1_790_200_000)),
    });
    let terminal = state.is_terminal();
    let routes = all_routes();
    let outcome = terminal.then(|| Outcome {
        route: routes[variant % routes.len()],
        at: Timestamp::from_seconds(1_790_300_000),
        amounts: (0..seated)
            .map(|i| Uint128::new(1_000_000 + i as u128))
            .collect(),
        dust: Uint128::new(3),
        distributed: Uint128::new(1_950_000 * seated as u128),
        bond_returned: Uint128::new(if even(variant) { 1_000_000 } else { 0 }),
        bond_to_pool: Uint128::new(if !even(variant) { 1_000_000 } else { 0 }),
    });
    Game {
        chain_game_id: 1 + variant as u64,
        state,
        creator: wallet(0),
        max_players: n as u8,
        mode: if even(variant) {
            Mode::Live
        } else {
            Mode::Async
        },
        rules_engine_version: 10,
        variants_digest: rng.bytes(32),
        denom: "ujunox".to_string(),
        ante_gross: Uint128::new(2_000_000),
        subsidy_per_seat: Uint128::new(50_000),
        ante_net: Uint128::new(1_950_000),
        terms: GameTerms {
            subsidy_bps: 250,
            bond_bps: 5_000,
            bond_floor: Uint128::new(1_000_000),
            challenge_window_secs: 86_400,
            liveness_window_secs: 14 * 86_400,
            resolver_timeout_secs: 30 * 86_400,
            treasury: wallet(9),
            review_delay_secs: [0, 7 * 86_400, 7 * 86_400][variant % 3],
            allowance_secs: [0, if even(variant) { 1_200 } else { 86_400 }, 0][variant % 3],
            cure_window_secs: [0, if even(variant) { 600 } else { 0 }, 0][variant % 3],
            policy: all_policies()[variant % 3],
        },
        created_at: Timestamp::from_seconds(1_790_000_000),
        funding_deadline: Timestamp::from_seconds(1_790_086_400),
        pool: Uint128::new(if terminal {
            0
        } else {
            1_950_000 * seated as u128
        }),
        seats,
        roster_hash: started.then(|| rng.bytes(32)),
        domain: started.then(|| rng.bytes(32)),
        bond: started.then(|| Uint128::new(1_000_000)),
        resolver: started.then(|| wallet(8)),
        started_at: started.then(|| Timestamp::from_seconds(1_790_050_000)),
        last_activity: started.then(|| Timestamp::from_seconds(1_790_060_000)),
        last_seq: Uint64::new(if started { 41 } else { 0 }),
        settlement,
        consent_bitmap: if with_settlement {
            (variant as u8).wrapping_mul(37) & ((1u8 << n.min(7)) - 1)
        } else {
            0
        },
        dispute,
        outcome,
        review_request: (started && variant % 3 == 2 && variant % 2 == 0).then(|| ReviewRequest {
            seat_index: (variant % n.max(1)) as u8,
            requested_at: Timestamp::from_seconds(1_790_070_000),
            trusted_seq: Uint64::new(40),
        }),
        remedy: (started && variant % 3 == 1 && variant % 4 != 0).then(|| {
            let kinds = all_remedy_kinds();
            RemedyRecord {
                kind: kinds[variant % kinds.len()],
                defaulting_seat: (variant % n.max(1)) as u8,
                strike: (variant % 4) as u8,
                overdue_epoch: Uint64::new(3),
                log_len: Uint64::new(41),
                log_hash: rng.bytes(32),
                allowance_secs: Uint64::new(1_200),
                overdue_at: Uint64::new(1_790_070_000),
                final_at: Uint64::new(1_790_070_600),
                expires_at: Uint64::new(1_790_074_200),
                evidence_hash: rng.bytes(32),
                remedy_key_id: 1,
                remedy_digest: rng.bytes(32),
                approvals_bitmap: 0b0110,
                accepted_at: Timestamp::from_seconds(1_790_070_601),
            }
        }),
    }
}

fn fixtures() -> Vec<Game> {
    let mut games = vec![];
    for (i, state) in all_states().into_iter().enumerate() {
        for n in [2usize, 7] {
            for addr_len in [43usize, 63, 90] {
                for variant in 0..14 {
                    games.push(shaped_game(state, n, addr_len, i * 100 + variant));
                }
            }
        }
    }
    let mut rng = Rng(0xE5C2_0023);
    games.extend((0..2_000).map(|_| arbitrary_game(&mut rng)));
    games
}

// --------------------------------------------------------------------- tests

#[test]
fn every_game_round_trips_through_stored_game() {
    for game in fixtures() {
        let back = Game::from(StoredGame::from(game.clone()));
        assert_eq!(back, game);
    }
}

#[test]
fn stored_json_round_trips_through_the_storage_codec() {
    // cosmwasm_std::{to_json_vec, from_json} are what cw-storage-plus uses.
    for game in fixtures() {
        let bytes = to_json_vec(&StoredGame::from(game.clone())).unwrap();
        let stored: StoredGame = from_json(&bytes).unwrap();
        assert_eq!(Game::from(stored), game);
    }
}

#[test]
fn view_serializes_exactly_like_stored_game() {
    for game in fixtures() {
        let owned = to_json_vec(&StoredGame::from(game.clone())).unwrap();
        let view = to_json_vec(&StoredGameView::from(&game)).unwrap();
        assert_eq!(view, owned);
    }
}

/// StoredGame's JSON is exactly Game's JSON regrouped: the four groups
/// partition Game's 29 keys (27 in 2.0.0, plus 2.1.0's `review_request` and
/// `remedy`), and every value is the byte-identical encoding.
#[test]
fn stored_shape_is_exactly_the_public_game_regrouped() {
    let groups = ["created", "money", "roster", "progress"];
    for game in fixtures().into_iter().step_by(3) {
        let flat: serde_json::Value = serde_json::from_slice(&to_json_vec(&game).unwrap()).unwrap();
        let stored: serde_json::Value =
            serde_json::from_slice(&to_json_vec(&StoredGameView::from(&game)).unwrap()).unwrap();
        let flat = flat.as_object().unwrap();
        let stored = stored.as_object().unwrap();
        assert_eq!(flat.len(), 29, "the public Game has 29 fields");
        assert_eq!(
            stored.keys().cloned().collect::<BTreeSet<_>>(),
            groups
                .iter()
                .map(|g| g.to_string())
                .collect::<BTreeSet<_>>()
        );
        let mut seen = BTreeSet::new();
        for group in groups {
            for (key, value) in stored[group].as_object().unwrap() {
                assert!(seen.insert(key.clone()), "{key} stored twice");
                assert_eq!(Some(value), flat.get(key), "{key} differs");
            }
        }
        assert_eq!(seen, flat.keys().cloned().collect::<BTreeSet<_>>());
    }
}

#[test]
fn fixtures_cover_every_variant_and_every_option() {
    let games = fixtures();
    let states: BTreeSet<_> = games.iter().map(|g| g.state.as_str()).collect();
    assert_eq!(states.len(), all_states().len());
    for route in all_routes() {
        assert!(games
            .iter()
            .any(|g| g.outcome.as_ref().map(|o| o.route) == Some(route)));
    }
    for resolution in all_resolutions() {
        assert!(games
            .iter()
            .any(|g| g.dispute.as_ref().and_then(|d| d.resolution) == Some(resolution)));
    }
    assert!(games
        .iter()
        .any(|g| g.dispute.as_ref().is_some_and(|d| d.resolution.is_none())));
    for source in all_sources() {
        assert!(games
            .iter()
            .any(|g| g.settlement.as_ref().map(|s| s.source) == Some(source)));
    }
    for mode in [Mode::Live, Mode::Async] {
        assert!(games.iter().any(|g| g.mode == mode));
    }
    let both = |f: &dyn Fn(&Game) -> bool| games.iter().any(f) && games.iter().any(|g| !f(g));
    assert!(both(&|g| g.roster_hash.is_some()));
    assert!(both(&|g| g.domain.is_some()));
    assert!(both(&|g| g.bond.is_some()));
    assert!(both(&|g| g.resolver.is_some()));
    assert!(both(&|g| g.started_at.is_some()));
    assert!(both(&|g| g.last_activity.is_some()));
    assert!(both(&|g| g.settlement.is_some()));
    assert!(both(&|g| g.dispute.is_some()));
    assert!(both(&|g| g.outcome.is_some()));
    assert!(both(&|g| g.review_request.is_some()));
    assert!(both(&|g| g.remedy.is_some()));
    for policy in all_policies() {
        assert!(games.iter().any(|g| g.terms.policy == policy));
    }
    for kind in all_remedy_kinds() {
        assert!(games
            .iter()
            .any(|g| g.remedy.as_ref().map(|r| r.kind) == Some(kind)));
    }
    assert!(both(&|g| g
        .seats
        .iter()
        .any(|s| s.consent_key_rotated_at.is_some())));
    for n in [0usize, 2, 7] {
        assert!(games.iter().any(|g| g.seats.len() == n));
    }
    let bitmaps: BTreeSet<u8> = games.iter().map(|g| g.consent_bitmap).collect();
    assert!(bitmaps.contains(&0) && bitmaps.contains(&u8::MAX) && bitmaps.len() > 200);
    assert!(games.iter().any(|g| g.pool == Uint128::MAX));
    assert!(games.iter().any(|g| g.last_seq == Uint64::new(u64::MAX)));
    assert!(games.iter().any(|g| g.creator.as_str().len() == 90));
}

/// Escrow 2.1.0 reads a game stored by 2.0.0 code: exactly the stored JSON
/// without `created.terms.{policy, review_delay_secs, allowance_secs,
/// cure_window_secs}` and `progress.{review_request, remedy}` (the only fields
/// 2.1.0 added). It decodes with `policy == None`, which keeps the 2.0.0 exits,
/// and no review request or remedy; every other field is unchanged. A migrated
/// 2.0.0 game can therefore never acquire 2.1.0 terms.
#[test]
fn a_game_stored_by_escrow_2_0_0_reads_with_no_policy() {
    for mut game in fixtures().into_iter().step_by(5) {
        game.terms.policy = None;
        game.terms.review_delay_secs = 0;
        game.terms.allowance_secs = 0;
        game.terms.cure_window_secs = 0;
        game.review_request = None;
        game.remedy = None;
        let mut json: serde_json::Value =
            serde_json::from_slice(&to_json_vec(&StoredGame::from(game.clone())).unwrap()).unwrap();
        let terms = json["created"]["terms"].as_object_mut().unwrap();
        assert!(terms.remove("policy").is_some());
        for field in ["review_delay_secs", "allowance_secs", "cure_window_secs"] {
            assert_eq!(terms.remove(field), Some(serde_json::json!(0)));
        }
        let progress = json["progress"].as_object_mut().unwrap();
        assert!(progress.remove("review_request").is_some());
        assert!(progress.remove("remedy").is_some());
        let legacy = serde_json::to_vec(&json).unwrap();
        let text = String::from_utf8(legacy.clone()).unwrap();
        for key in [
            "policy",
            "review_request",
            "review_delay_secs",
            "allowance_secs",
            "cure_window_secs",
            "remedy",
        ] {
            assert!(
                !text.contains(&format!("\"{key}\":")),
                "{key} left in {text}"
            );
        }
        let mut storage = MockStorage::new();
        storage.set(&GAMES.key(game.chain_game_id), &legacy);
        let loaded = load_game(&storage, game.chain_game_id).unwrap();
        assert_eq!(loaded, game);
        assert_eq!(loaded.terms.policy, None);
        assert_eq!(loaded.review_request, None);
        assert_eq!(loaded.remedy, None);
    }
}

/// The canonical helpers write the stored shape under the game's key, and
/// neither shape can be misread as the other.
#[test]
fn canonical_helpers_write_the_stored_shape() {
    for game in fixtures().into_iter().step_by(7) {
        let mut storage = MockStorage::new();
        save_game(&mut storage, &game).unwrap();
        assert_eq!(load_game(&storage, game.chain_game_id).unwrap(), game);

        let raw = cosmwasm_std::Storage::get(&storage, &GAMES.key(game.chain_game_id)).unwrap();
        assert_eq!(raw, to_json_vec(&StoredGame::from(game.clone())).unwrap());
        assert!(
            from_json::<Game>(&raw).is_err(),
            "stored bytes must not parse as a Game"
        );
        let flat = to_json_vec(&game).unwrap();
        assert!(
            from_json::<StoredGame>(&flat).is_err(),
            "a flat Game must not parse as stored"
        );
        let typed = GAMES.load(&storage, game.chain_game_id).unwrap();
        assert_eq!(Game::from(typed), game);
    }
}

/// Query responses embed the public Game, byte for byte as before.
#[test]
fn queries_return_the_public_game() {
    let mut deps = mock_dependencies();
    let config = Config {
        admin: Addr::unchecked("admin"),
        operator: Addr::unchecked("operator"),
        admission_pubkey: HexBinary::from(vec![0x02; 33]),
        resolver: Addr::unchecked("resolver"),
        treasury: Addr::unchecked("treasury"),
        denom: "ujunox".to_string(),
        params: GameParams {
            subsidy_bps: 250,
            min_ante: Uint128::new(2_000_000),
            bond_bps: 5_000,
            bond_floor: Uint128::new(1_000_000),
            challenge_window_live_secs: 86_400,
            challenge_window_async_secs: 172_800,
            funding_period_live_secs: 86_400,
            funding_period_async_secs: 604_800,
            liveness_window_secs: 1_209_600,
            resolver_timeout_secs: 2_592_000,
        },
        paused: false,
    };
    CONFIG.save(deps.as_mut().storage, &config).unwrap();
    let games: Vec<Game> = all_states()
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let mut g = shaped_game(s, 7, 63, i);
            g.chain_game_id = 1 + i as u64;
            g
        })
        .collect();
    for g in &games {
        save_game(deps.as_mut().storage, g).unwrap();
    }
    let q = |msg: QueryMsg| crate::contract::query(deps.as_ref(), mock_env(), msg).unwrap();
    for g in &games {
        let bin = q(QueryMsg::Game {
            chain_game_id: g.chain_game_id,
        });
        let resp: GameResponse = from_json(&bin).unwrap();
        assert_eq!(resp.game, *g);
        // The embedded object is the public Game's exact JSON.
        let v: serde_json::Value = serde_json::from_slice(bin.as_slice()).unwrap();
        let expected: serde_json::Value = serde_json::from_slice(&to_json_vec(g).unwrap()).unwrap();
        assert_eq!(v["game"], expected);
        let seats: SeatsResponse = from_json(q(QueryMsg::Seats {
            chain_game_id: g.chain_game_id,
        }))
        .unwrap();
        assert_eq!(
            seats
                .seats
                .iter()
                .map(|s| s.seat.clone())
                .collect::<Vec<_>>(),
            g.seats
        );
    }
    let listed: GamesResponse = from_json(q(QueryMsg::Games {
        start_after: None,
        limit: Some(30),
    }))
    .unwrap();
    assert_eq!(listed.games.len(), games.len());
    for (summary, g) in listed.games.iter().zip(&games) {
        assert_eq!(summary.chain_game_id, g.chain_game_id);
        assert_eq!(summary.state, g.state);
        assert_eq!(summary.creator, g.creator.to_string());
        assert_eq!(summary.mode, g.mode);
        assert_eq!(summary.max_players, g.max_players);
        assert_eq!(usize::from(summary.seats_filled), g.seats.len());
        assert_eq!(summary.ante_gross, g.ante_gross);
        assert_eq!(summary.pool, g.pool);
    }
}

/// Only `storage` can touch the stored shape: `GAMES` and `StoredGame` are
/// private to it (the compiler enforces that). This scan closes the remaining
/// side doors: a second `Map` handle on the `"games"` namespace, and code
/// pulled in from outside `src/` via `#[path]` or `include!`.
#[test]
fn storage_seams_are_the_only_games_access() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![];
    let mut dirs = vec![src.clone()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                files.push(path);
            }
        }
    }
    let mut namespace = vec![];
    let mut outside = vec![];
    for path in files {
        let rel = path
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if rel == "storage/tests.rs" {
            continue;
        }
        for (n, line) in std::fs::read_to_string(&path).unwrap().lines().enumerate() {
            let code = line.trim();
            if code.starts_with("//") {
                continue;
            }
            let at = format!("{rel}:{}: {code}", n + 1);
            if code.contains("\"games\"") {
                namespace.push(format!("{rel}: {code}"));
            }
            if code.contains("#[path") || code.contains("include!") {
                outside.push(at.clone());
            }
            if rel != "storage.rs" && (code.contains("GAMES") || code.contains("StoredGame")) {
                outside.push(at);
            }
        }
    }
    assert_eq!(
        namespace,
        vec!["storage.rs: const GAMES: Map<u64, StoredGame> = Map::new(\"games\");".to_string()],
        "the games namespace must have exactly one handle, in storage.rs"
    );
    assert!(
        outside.is_empty(),
        "stored-shape access outside storage.rs: {outside:#?}"
    );
}
