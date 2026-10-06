//! Storage: escrow facts only.
//!
//! Stored per game: the roster (wallets, consent keys, join tickets, exact
//! per-seat deposit split), the frozen terms, the pool, the settlement domain,
//! sequence/time bookkeeping, the signed payloads the contract accepted (their
//! commitments and weights, never a board or a log) and the dispute/outcome.
//!
//! Not stored, by design (ESCROW-1.5 §2, §9.3): boards, routes, markets, trains,
//! companies, gameplay logs, gameplay player/principal ids, signatures.

use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, HexBinary, Timestamp, Uint128, Uint64};
use cw_storage_plus::{Item, Map};

/// Global configuration.
#[cw_serde]
pub struct Config {
    /// Governance: pause, key registry, operator/resolver/treasury, parameters
    /// for future games. No path to player funds.
    pub admin: Addr,
    /// The only address that may `Start` a funded game.
    pub operator: Addr,
    /// The join-admission key (33-byte compressed secp256k1): `Join` succeeds
    /// only with its signature over the JOIN digest naming the joining wallet
    /// (`crypto::join_admission_digest`). Held by the hosted server, never a
    /// settlement signer key; the admin replaces it with `SetAdmissionKey`,
    /// which invalidates every admission signed under the previous key.
    pub admission_pubkey: HexBinary,
    /// The resolver a game adopts at `Start`. `SetResolver` therefore only
    /// changes the adjudicator of games started afterwards.
    pub resolver: Addr,
    /// Receives deposit subsidies and payout dust (snapshotted into each game).
    pub treasury: Addr,
    /// The one native denom accepted (`ujuno` on Juno, `ujunox` on its testnet).
    /// Fixed at instantiate.
    pub denom: String,
    /// Economic parameters copied into every game created while they are current.
    pub params: GameParams,
    /// Global pause flag. Not a game state.
    pub paused: bool,
}

/// Economic parameters. A game copies them when it is created, so a later
/// `SetParams` never changes a game that already exists.
#[cw_serde]
pub struct GameParams {
    /// Basis points of EVERY deposit (creator and joiners) sent to the treasury.
    pub subsidy_bps: u16,
    /// Smallest gross ante `CreateGame` accepts.
    pub min_ante: Uint128,
    /// Bond = max(bond_floor, ante_net · bond_bps / 10_000), fixed at `Start`.
    pub bond_bps: u16,
    pub bond_floor: Uint128,
    /// Challenge window after a settlement is stored, per mode.
    pub challenge_window_live_secs: u64,
    pub challenge_window_async_secs: u64,
    /// Time from `CreateGame` to the funding deadline, per mode.
    pub funding_period_live_secs: u64,
    pub funding_period_async_secs: u64,
    /// After a SETTLEABLE game's `window_end`, the wait before a seated wallet
    /// may `LivenessSettle` it. (Escrow 2.0.0 games also used it as the
    /// IN_PROGRESS inactivity window; 2.1.0 games have no IN_PROGRESS exit.)
    pub liveness_window_secs: u64,
    /// DISPUTED time after which a seated wallet may `LivenessSettle`.
    pub resolver_timeout_secs: u64,
}

/// Escrow 2.1.0 owner policy (2026-10-06): the Live action clock. Every
/// required gameplay action gets 20 minutes; a first or second expiry makes the
/// acting seat OVERDUE, curable until 30:00 (`LIVE_CURE_WINDOW_SECS` after the
/// expiry); a third expiry forecloses at once. Frozen into a Live game's terms.
pub const LIVE_ACTION_SECS: u64 = 20 * 60;
/// See [`LIVE_ACTION_SECS`]: the 20:00–30:00 cure / approval window.
pub const LIVE_CURE_WINDOW_SECS: u64 = 10 * 60;
/// The paces a Timed Async host may choose (12 h, 24 h, 2 d, 3 d, 7 d). An
/// expired allowance makes the responsible seat OVERDUE; nothing happens
/// automatically.
pub const ASYNC_PACES_SECS: [u64; 5] = [43_200, 86_400, 172_800, 259_200, 604_800];
/// The exceptional review's delay (owner policy, 2026-10-06: 7 days), from a
/// seated wallet's request to the earliest `ReviewAnnul`. A contract constant,
/// snapshotted into every 2.1.0 game's terms at CreateGame.
pub const REVIEW_DELAY_SECS: u64 = 7 * 24 * 60 * 60;
/// A remedy attestation is refused once block time reaches its `expires_at`,
/// and `expires_at` may lie at most this long after its `attested_at` (which
/// is itself at most the block time): no signed attestation stays usable for
/// more than an hour. A final remedy that did not land in time (an admin
/// pause, a relayer or AWS outage) is attested again, never extended; a
/// pre-outage attestation dies within the hour, and the server decides afresh
/// (the system-pause rules) whether to attest again.
pub const MAX_REMEDY_TTL_SECS: u64 = 60 * 60;

/// Live or async; its byte (0 or 1) is part of the settlement domain.
#[cw_serde]
#[derive(Copy)]
pub enum Mode {
    Live,
    Async,
}

impl Mode {
    /// The `u8(mode)` of the domain: 0 = live, 1 = async.
    pub fn as_byte(self) -> u8 {
        match self {
            Mode::Live => 0,
            Mode::Async => 1,
        }
    }
}

/// The frozen game lifecycle (ESCROW-1.5 §9). SETTLED, CANCELLED and ANNULLED
/// are terminal and accept no message.
#[cw_serde]
#[derive(Copy, Eq, Hash)]
pub enum GameState {
    Funding,
    Funded,
    InProgress,
    Settleable,
    Disputed,
    Settled,
    Cancelled,
    Annulled,
}

impl GameState {
    pub fn as_str(self) -> &'static str {
        match self {
            GameState::Funding => "funding",
            GameState::Funded => "funded",
            GameState::InProgress => "in_progress",
            GameState::Settleable => "settleable",
            GameState::Disputed => "disputed",
            GameState::Settled => "settled",
            GameState::Cancelled => "cancelled",
            GameState::Annulled => "annulled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            GameState::Settled | GameState::Cancelled | GameState::Annulled
        )
    }
}

/// The exit rules a game was funded under (escrow 2.1.0). Written once at
/// `CreateGame` and never changed by any message, `SetParams` or a migration.
///
/// A game stored without a policy (`GameTerms::policy == None`) was created by
/// escrow 2.0.0 code and keeps every 2.0.0 path, including the IN_PROGRESS
/// standings-based `LivenessSettle`. Every game created by 2.1.0 code carries
/// one of these:
///
/// * neither has an IN_PROGRESS inactivity exit: no time spent without chain
///   activity ever moves money (`LivenessExitRemoved`);
/// * neither ever promotes a stored checkpoint into its settlement: where
///   2.0.0 would (a SETTLEABLE or DISPUTED settlement whose signer key was
///   retired as compromised), the game refunds every net deposit. (A terminal
///   `Settle` payload, or a resolver `Replace`, still carries whatever vector
///   its signer or the resolver chose, as in 2.0.0.)
///
/// Every 2.1.0 game, whatever its policy, also has the universal unanimous
/// neutral annulment (`AnnulByConsent`, IN_PROGRESS / SETTLEABLE / DISPUTED)
/// and the exceptional review (`RequestReview` / `ReviewAnnul`, a neutral
/// refund decided by the game's snapshotted resolver after 7 days).
///
/// The variants are versioned by meaning: a later escrow version that changes
/// the remedies must add a NEW variant for the games it creates, so a code
/// migration can never change the remedies of a game funded under one.
#[cw_serde]
#[derive(Copy, Eq)]
pub enum GamePolicy {
    /// A table with an action deadline (every Live table; an Async table with
    /// one of [`ASYNC_PACES_SECS`]) under the remedy model of 2026-10-06
    /// (`SubmitRemedy`): an off-chain overdue fact enters the contract only as
    /// an attestation of the dedicated REMEDY key (`crypto::remedy_digest`),
    /// plus, where the policy requires it, the approval of every non-defaulting
    /// seat (`crypto::remedy_approve_digest`).
    ///
    /// * Live, first/second overdue, uncured at 30:00: neutral TimeoutAnnul
    ///   (no approvals), or foreclosure with every N−1 approval;
    /// * Live, third overdue: foreclosure at the 20:00 expiry, stored as a
    ///   challengeable settlement (`SettlementSource::RemedyStrike3`);
    /// * Timed Async, overdue: neutral annulment or foreclosure, each with
    ///   every N−1 approval, final at once.
    TimedRemedyV1,
    /// An Async table with no action deadline. Inactivity never moves money:
    /// no overdue, no remedy (`SubmitRemedy` is refused). It ends by
    /// completion, unanimous annulment, or the exceptional review.
    NoDeadline,
}

impl GamePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            GamePolicy::TimedRemedyV1 => "timed_remedy_v1",
            GamePolicy::NoDeadline => "no_deadline",
        }
    }
}

/// The remedies a `SubmitRemedy` attestation can carry (its `remedy` byte).
/// Each one is checked against the game's mode and the strike it names.
#[cw_serde]
#[derive(Copy, Eq)]
pub enum RemedyKind {
    /// 1. Live, strike 1 or 2, uncured at `final_at = overdue_at + 10 min`, no
    ///    complete N−1 approval: every net deposit refunded (ANNULLED). No
    ///    approvals are carried.
    LiveTimeoutAnnul,
    /// 2. Live, strike 1 or 2, uncured at `final_at = overdue_at + 10 min`,
    ///    every non-defaulting seat approved: foreclosure (SETTLED).
    LiveForeclose,
    /// 3. Live, strike 3, `final_at = overdue_at` (no cure, no vote): the
    ///    foreclosure is stored as a settlement and enters the challenge
    ///    window (SETTLEABLE). No approvals are carried.
    LiveStrike3Foreclose,
    /// 4. Timed Async, overdue, every non-defaulting seat approved: every net
    ///    deposit refunded (ANNULLED).
    AsyncAnnul,
    /// 5. Timed Async, overdue, every non-defaulting seat approved:
    ///    foreclosure (SETTLED).
    AsyncForeclose,
}

impl RemedyKind {
    pub fn from_byte(byte: u8) -> Option<RemedyKind> {
        match byte {
            1 => Some(RemedyKind::LiveTimeoutAnnul),
            2 => Some(RemedyKind::LiveForeclose),
            3 => Some(RemedyKind::LiveStrike3Foreclose),
            4 => Some(RemedyKind::AsyncAnnul),
            5 => Some(RemedyKind::AsyncForeclose),
            _ => None,
        }
    }

    pub fn as_byte(self) -> u8 {
        match self {
            RemedyKind::LiveTimeoutAnnul => 1,
            RemedyKind::LiveForeclose => 2,
            RemedyKind::LiveStrike3Foreclose => 3,
            RemedyKind::AsyncAnnul => 4,
            RemedyKind::AsyncForeclose => 5,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            RemedyKind::LiveTimeoutAnnul => "live_timeout_annul",
            RemedyKind::LiveForeclose => "live_foreclose",
            RemedyKind::LiveStrike3Foreclose => "live_strike3_foreclose",
            RemedyKind::AsyncAnnul => "async_annul",
            RemedyKind::AsyncForeclose => "async_foreclose",
        }
    }

    /// The mode the remedy belongs to.
    pub fn mode(self) -> Mode {
        match self {
            RemedyKind::LiveTimeoutAnnul
            | RemedyKind::LiveForeclose
            | RemedyKind::LiveStrike3Foreclose => Mode::Live,
            RemedyKind::AsyncAnnul | RemedyKind::AsyncForeclose => Mode::Async,
        }
    }

    /// Takes a seat's net deposit (blocked while the contract is paused, like
    /// every payout by a signed vector). The neutral kinds refund every seat
    /// and stay available while paused.
    pub fn forecloses(self) -> bool {
        matches!(
            self,
            RemedyKind::LiveForeclose
                | RemedyKind::LiveStrike3Foreclose
                | RemedyKind::AsyncForeclose
        )
    }

    /// Needs the approval of every non-defaulting seat.
    pub fn needs_approvals(self) -> bool {
        matches!(
            self,
            RemedyKind::LiveForeclose | RemedyKind::AsyncAnnul | RemedyKind::AsyncForeclose
        )
    }
}

/// The accepted remedy of a game: the attested facts, which key attested them
/// and who approved. Written once, by the `SubmitRemedy` that ended the game's
/// play (or, for a third strike, that stored its challengeable foreclosure).
#[cw_serde]
pub struct RemedyRecord {
    pub kind: RemedyKind,
    pub defaulting_seat: u8,
    pub strike: u8,
    pub overdue_epoch: Uint64,
    pub log_len: Uint64,
    pub log_hash: HexBinary,
    pub allowance_secs: Uint64,
    pub overdue_at: Uint64,
    pub final_at: Uint64,
    /// When the remedy key attested the decision that took effect (a
    /// re-attestation of the same final decision differs only here and in
    /// `expires_at`, `remedy_key_id` and the digest).
    pub attested_at: Uint64,
    pub expires_at: Uint64,
    pub evidence_hash: HexBinary,
    pub remedy_key_id: u16,
    /// `SHA-256("18JUNO/REMEDY/v1" ‖ encode(attestation))`.
    pub remedy_digest: HexBinary,
    /// Bit i set = seat i's REMEDY-APPROVE signature verified (0 for the kinds
    /// that carry no approvals).
    pub approvals_bitmap: u8,
    pub accepted_at: Timestamp,
}

/// Terms copied from the configuration when the game was created, plus the
/// game's exit policy (escrow 2.1.0).
#[cw_serde]
pub struct GameTerms {
    pub subsidy_bps: u16,
    pub bond_bps: u16,
    pub bond_floor: Uint128,
    /// This game's challenge window (its mode's value).
    pub challenge_window_secs: u64,
    /// Escrow 2.0.0 games: the IN_PROGRESS inactivity window. 2.1.0 games keep
    /// it only for the SETTLEABLE exit (`window_end + liveness_window`).
    pub liveness_window_secs: u64,
    pub resolver_timeout_secs: u64,
    /// Where this game's subsidies and dust go.
    pub treasury: Addr,
    /// Escrow 2.1.0: [`REVIEW_DELAY_SECS`] at CreateGame (every policy). 0 on
    /// a 2.0.0 game (no review applies to it).
    #[serde(default)]
    pub review_delay_secs: u64,
    /// Escrow 2.1.0, `TimedRemedyV1`: the action allowance a remedy attestation
    /// must name (Live: [`LIVE_ACTION_SECS`]; Timed Async: the host's pace).
    /// 0 for No-deadline and 2.0.0 games.
    #[serde(default)]
    pub allowance_secs: u64,
    /// Escrow 2.1.0, Live: [`LIVE_CURE_WINDOW_SECS`], the gap a first/second
    /// strike remedy's `final_at` must keep from its `overdue_at`. 0 otherwise
    /// (a Timed Async remedy is final once its N−1 consensus completes).
    #[serde(default)]
    pub cure_window_secs: u64,
    /// `None` = created by escrow 2.0.0 code (2.0.0 semantics, see
    /// [`GamePolicy`]); every 2.1.0 game has `Some`. The per-game gate that
    /// keeps a code migration from changing the terms a game was funded under.
    #[serde(default)]
    pub policy: Option<GamePolicy>,
}

/// A seated wallet's request for the exceptional review of an escrow 2.1.0
/// game (`RequestReview`). Only the first request is recorded; an accepted
/// `Checkpoint` above `trusted_seq` (proof the table kept playing after the
/// request) withdraws it.
#[cw_serde]
pub struct ReviewRequest {
    /// `chain_seat_index` of the requesting wallet.
    pub seat_index: u8,
    /// Identifies the request: `ReviewAnnul` must name it.
    pub requested_at: Timestamp,
    /// The game's trusted sequence when the request was made. A checkpoint at
    /// or below it (an emergency re-post of a boundary already reached) does
    /// not withdraw the request.
    pub trusted_seq: Uint64,
}

/// One seat, in deposit order. `seats[i]` is `chain_seat_index` i.
#[cw_serde]
pub struct Seat {
    /// Deposit signer: payout and refund destination. Never a gameplay actor.
    pub wallet: Addr,
    /// 33-byte compressed secp256k1 key for CONSENT and ANNUL signatures. The
    /// key current at verification time is the one checked.
    pub consent_pubkey: HexBinary,
    pub consent_key_rotated_at: Option<Timestamp>,
    /// The server-issued opaque join ticket (32 bytes), stored verbatim.
    pub join_ticket: HexBinary,
    pub gross_deposit: Uint128,
    pub subsidy_paid: Uint128,
    /// What entered the pool, and exactly what a refund returns.
    pub net_deposit: Uint128,
    pub joined_at: Timestamp,
}

/// The fields of an accepted `SettlementPayloadV1`, plus its SETTLE digest.
#[cw_serde]
pub struct PayloadRecord {
    pub seq: Uint64,
    pub kind: u8,
    pub reason: u8,
    pub log_len: Uint64,
    pub log_hash: HexBinary,
    pub appraisal_log_len: Uint64,
    pub appraisal_state_hash: HexBinary,
    pub state_schema_version: u16,
    /// In `chain_seat_index` order.
    pub settlement_weights: Vec<Uint128>,
    pub signer_key_id: u16,
    /// Informational; the contract only ever compares block time.
    pub issued_at: Uint64,
    /// `SHA-256("18JUNO/SETTLE/v1" ‖ encode(payload))`, what consents sign over.
    pub payload_digest: HexBinary,
}

/// A checkpoint the contract accepted. The latest one per signer key is kept, so
/// `LivenessSettle` can fall back past a key retired as compromised and the
/// trusted sequence floor can ignore a compromised key's evidence.
#[cw_serde]
pub struct CheckpointRecord {
    pub payload: PayloadRecord,
    pub accepted_at: Timestamp,
}

/// Where a stored settlement came from.
#[cw_serde]
#[derive(Copy)]
pub enum SettlementSource {
    /// A signed Terminal payload submitted with `Settle`.
    TerminalPayload,
    /// The best usable checkpoint, promoted by `LivenessSettle`.
    LivenessCheckpoint,
    /// A resolver `Replace` (reason ResolverCorrection), authorised by the
    /// resolver's transaction rather than a signature.
    ResolverReplacement,
    /// Escrow 2.1.0: a Live third-strike foreclosure (`SubmitRemedy`, remedy
    /// 3). Its `payload` is synthesized from the remedy attestation: kind 1,
    /// `seq = 2·log_len + 1`, weight 1 for every seat but the defaulting one
    /// (0), `signer_key_id` = the REMEDY key id (trust is checked against the
    /// remedy registry, never `SIGNER_KEYS`), `payload_digest` = the REMEDY
    /// digest. It is challengeable like any settlement; a resolver may uphold
    /// it or annul (never `Replace` it).
    RemedyStrike3,
}

#[cw_serde]
pub struct SettlementRecord {
    pub source: SettlementSource,
    pub payload: PayloadRecord,
    pub accepted_at: Timestamp,
    /// `Finalize` is possible from here on; `Challenge` only before.
    pub window_end: Timestamp,
}

#[cw_serde]
#[derive(Copy)]
pub enum DisputeResolution {
    Upheld,
    Replaced,
    Annulled,
    /// Nobody adjudicated before the resolver timeout; the bond went back.
    ResolverTimeout,
    /// Escrow 2.1.0: every seat signed `AnnulByConsent` while the game was
    /// disputed; the bond went back to the challenger, every net deposit to its
    /// seat.
    AnnulledByConsent,
}

#[cw_serde]
pub struct DisputeRecord {
    pub challenger: Addr,
    pub bond: Uint128,
    pub evidence_hash: HexBinary,
    pub disputed_at: Timestamp,
    pub resolution: Option<DisputeResolution>,
    pub resolved_at: Option<Timestamp>,
}

/// Which path moved the money out of a game.
#[cw_serde]
#[derive(Copy)]
pub enum Route {
    /// `Settle` carried a valid consent from every seat.
    AllConsentsAtSettle,
    /// A `Consent` supplied the last missing seat.
    ConsentCompleted,
    Finalized,
    ResolverUphold,
    ResolverReplace,
    ResolverAnnul,
    /// DISPUTED + resolver timeout, stored settlement paid (uphold-like).
    ResolverTimeoutPayout,
    /// DISPUTED + resolver timeout, the stored settlement's key compromised and
    /// no usable checkpoint (or, for a 2.1.0 game, whatever checkpoints
    /// exist): refund.
    ResolverTimeoutRefund,
    AnnulByConsent,
    CreatorCancel,
    DeadlineCancel,
    /// IN_PROGRESS + liveness window, no usable checkpoint: refund.
    LivenessRefund,
    /// SETTLEABLE + `window_end` + liveness window, stored settlement paid.
    SettleableTimeoutPayout,
    /// SETTLEABLE + `window_end` + liveness window, the stored settlement's key
    /// is compromised and no usable checkpoint exists (or, for a 2.1.0 game,
    /// whatever checkpoints exist): refund.
    SettleableTimeoutRefund,
    /// Escrow 2.1.0: the game's resolver approved a seated wallet's review
    /// request; every net deposit refunded.
    ReviewAnnul,
    /// Escrow 2.1.0, Live remedy 1: the overdue seat did not cure by 30:00 and
    /// no foreclosure was approved; every net deposit refunded.
    RemedyTimeoutAnnul,
    /// Escrow 2.1.0, Timed Async remedy 4: every non-defaulting seat approved
    /// the neutral annulment of an overdue game; every net deposit refunded.
    RemedyAnnul,
    /// Escrow 2.1.0, remedies 2 and 5: the defaulting seat receives 0, every
    /// other seat its own net deposit plus `⌊net_D / (N−1)⌋`, the remainder to
    /// the treasury (`payout::foreclosure_split`). (A third-strike foreclosure
    /// is paid by the ordinary settlement routes from its stored settlement.)
    RemedyForeclosure,
}

/// The terminal money movement of a game.
#[cw_serde]
pub struct Outcome {
    pub route: Route,
    pub at: Timestamp,
    /// Per seat, in `chain_seat_index` order: payout or refund.
    pub amounts: Vec<Uint128>,
    /// Sent to the treasury (payouts only).
    pub dust: Uint128,
    /// The pool the amounts and dust were drawn from.
    pub distributed: Uint128,
    /// Challenger's bond sent back to the challenger in this transaction.
    pub bond_returned: Uint128,
    /// Challenger's bond added to the pool before the split (Uphold).
    pub bond_to_pool: Uint128,
}

#[cw_serde]
pub struct Game {
    pub chain_game_id: u64,
    pub state: GameState,
    /// Sender of `CreateGame`. May `Cancel` before `Start`; nothing after.
    pub creator: Addr,
    pub max_players: u8,
    pub mode: Mode,
    pub rules_engine_version: u32,
    pub variants_digest: HexBinary,
    pub denom: String,
    /// The creator's gross deposit; every joiner must send exactly this.
    pub ante_gross: Uint128,
    pub subsidy_per_seat: Uint128,
    /// Per-seat net ante (identical for every seat).
    pub ante_net: Uint128,
    pub terms: GameTerms,
    pub created_at: Timestamp,
    pub funding_deadline: Timestamp,
    /// Σ net deposits until a payout or refund zeroes it.
    pub pool: Uint128,
    /// Deposit order; frozen at `Start`.
    pub seats: Vec<Seat>,
    // ---- frozen at Start ----
    pub roster_hash: Option<HexBinary>,
    pub domain: Option<HexBinary>,
    pub bond: Option<Uint128>,
    /// `CONFIG.resolver` at `Start`: the only address that may `Resolve` this
    /// game, whatever `SetResolver` does later.
    pub resolver: Option<Addr>,
    pub started_at: Option<Timestamp>,
    /// Block time of the last `Start` or accepted ordinary `Checkpoint` (a
    /// checkpoint carried by `LivenessSettle` does not refresh it).
    pub last_activity: Option<Timestamp>,
    // ---- signed-payload bookkeeping ----
    /// Raw history: the highest seq of any payload ever accepted for this game.
    /// Never decreases. Kept for audit only: it is NOT an authority gate, because
    /// evidence signed by a key later marked compromised loses its sequence
    /// authority (see `helpers::trusted_seq`).
    pub last_seq: Uint64,
    pub settlement: Option<SettlementRecord>,
    /// Bit i set = seat i's consent to the stored settlement verified against
    /// seat i's current consent key (rotating that key clears the bit).
    pub consent_bitmap: u8,
    pub dispute: Option<DisputeRecord>,
    pub outcome: Option<Outcome>,
    /// Escrow 2.1.0: the first seated request for the exceptional review.
    /// Absent on every 2.0.0 game.
    #[serde(default)]
    pub review_request: Option<ReviewRequest>,
    /// Escrow 2.1.0: the accepted timed remedy, if any. Absent on every 2.0.0
    /// game.
    #[serde(default)]
    pub remedy: Option<RemedyRecord>,
}

/// A registered settlement-signer key.
#[cw_serde]
pub struct SignerKey {
    pub key_id: u16,
    pub pubkey: HexBinary,
    pub added_at: Timestamp,
    /// Payloads under this key are refused from this time on, whatever their
    /// `issued_at`.
    pub retired_at: Option<Timestamp>,
    /// Retired as compromised: its stored checkpoints and settlements are not
    /// usable by `LivenessSettle` and lose their sequence authority (they no
    /// longer raise the trusted floor). Never cleared.
    pub compromised: bool,
}

/// A registered REMEDY attestation key (escrow 2.1.0): the dedicated authority
/// for `SubmitRemedy`, a key class of its own. Never a settlement signer key,
/// never a join-admission key (current or former, either way round).
#[cw_serde]
pub struct RemedyKey {
    pub key_id: u16,
    pub pubkey: HexBinary,
    pub added_at: Timestamp,
    /// Attestations under this key are refused from this time on.
    pub retired_at: Option<Timestamp>,
    /// Retired as compromised: a third-strike foreclosure it attested loses its
    /// payout authority (`Finalize` / `Consent` refuse it; the liveness exits
    /// refund instead). Never cleared.
    pub compromised: bool,
}

pub const CONFIG: Item<Config> = Item::new("config");
/// Next `chain_game_id` (the first game is 1).
pub const NEXT_GAME_ID: Item<u64> = Item::new("next_game_id");
/// Next signer `key_id` (the first key is 1).
pub const NEXT_SIGNER_KEY_ID: Item<u16> = Item::new("next_signer_key_id");
pub const SIGNER_KEYS: Map<u16, SignerKey> = Map::new("signer_keys");
/// Compressed pubkey → key_id, so one key can never be registered twice (a
/// compromised key could otherwise live on under a second id).
pub const SIGNER_PUBKEY_INDEX: Map<&[u8], u16> = Map::new("signer_pubkey_index");
/// Every join-admission key this contract has ever held (compressed pubkey →
/// block time it was first set). A current OR former admission key can never
/// be registered as a settlement signer key: a key rotated out because it
/// leaked must not come back with settlement authority.
pub const ADMISSION_KEYS: Map<&[u8], Timestamp> = Map::new("admission_keys");
/// Next remedy `key_id` (the first key is 1). Absent in a 2.0.0 deployment
/// (read as 1).
pub const NEXT_REMEDY_KEY_ID: Item<u16> = Item::new("next_remedy_key_id");
pub const REMEDY_KEYS: Map<u16, RemedyKey> = Map::new("remedy_keys");
/// Compressed pubkey → remedy key_id: a key is registered at most once.
pub const REMEDY_PUBKEY_INDEX: Map<&[u8], u16> = Map::new("remedy_pubkey_index");
// Games live under the `games` namespace, owned by the private `storage`
// module (storage-only `StoredGame` shape; read and written only through
// `helpers::{load_game, save_game}` and the `Games` query).

/// (chain_game_id, signer key_id) → the latest checkpoint signed by that key.
pub const CHECKPOINTS: Map<(u64, u16), CheckpointRecord> = Map::new("checkpoints");
