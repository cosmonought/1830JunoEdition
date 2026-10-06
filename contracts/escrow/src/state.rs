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
    /// Escrow 2.1.0: the wait from a No-deadline game's first review request
    /// to the earliest `ReviewAnnul`, so the table can notice (and finish and
    /// `Settle`, or post a checkpoint, which withdraws the request) before a
    /// resolver acts. Snapshotted into each game at CreateGame. Validated like
    /// the other durations (1 s … 10 y); the value is a deployment choice. A
    /// configuration carried over from 2.0.0 reads 0 here, and a No-deadline
    /// game cannot be created until the admin sets it (`SetParams`).
    #[serde(default)]
    pub review_delay_secs: u64,
}

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
/// The variants are versioned by meaning: a later escrow version that adds the
/// timed remedies must add a NEW variant for the games it creates, so a code
/// migration can never hand remedies to a game funded as
/// `TimedNoRemedies`.
#[cw_serde]
#[derive(Copy, Eq)]
pub enum GamePolicy {
    /// A table with an action deadline (every Live table; an Async table with a
    /// fixed pace) under THIS build's rules: it ends only by completion or
    /// unanimous annulment. The timed default / foreclosure remedies are not in
    /// this build (their trust bridge, how the contract learns an off-chain
    /// overdue fact, awaits an owner decision), so one absent seat can hold
    /// such a game indefinitely. Not for money tables until the remedies exist.
    TimedNoRemedies,
    /// An Async table with no action deadline. Inactivity never moves money; it
    /// ends by completion, unanimous annulment, or the exceptional review: the
    /// game's resolver may refund every net deposit after a seated wallet asked
    /// for review (`RequestReview` / `ReviewAnnul`).
    NoDeadline,
}

impl GamePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            GamePolicy::TimedNoRemedies => "timed_no_remedies",
            GamePolicy::NoDeadline => "no_deadline",
        }
    }
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
    /// Escrow 2.1.0, No-deadline games: `GameParams::review_delay_secs` at
    /// CreateGame. 0 on 2.0.0 and Timed games (no review applies to them).
    #[serde(default)]
    pub review_delay_secs: u64,
    /// `None` = created by escrow 2.0.0 code (2.0.0 semantics, see
    /// [`GamePolicy`]); every 2.1.0 game has `Some`. The per-game gate that
    /// keeps a code migration from changing the terms a game was funded under.
    #[serde(default)]
    pub policy: Option<GamePolicy>,
}

/// A seated wallet's request for the exceptional review of a No-deadline game
/// (`RequestReview`). Only the first request is recorded; an accepted
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
    /// Escrow 2.1.0, No-deadline game: the game's resolver approved a seated
    /// wallet's review request; every net deposit refunded.
    ReviewAnnul,
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
    /// Escrow 2.1.0, No-deadline games only: the first seated request for the
    /// exceptional review. Absent on every 2.0.0 game.
    #[serde(default)]
    pub review_request: Option<ReviewRequest>,
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
// Games live under the `games` namespace, owned by the private `storage`
// module (storage-only `StoredGame` shape; read and written only through
// `helpers::{load_game, save_game}` and the `Games` query).

/// (chain_game_id, signer key_id) → the latest checkpoint signed by that key.
pub const CHECKPOINTS: Map<(u64, u16), CheckpointRecord> = Map::new("checkpoints");
