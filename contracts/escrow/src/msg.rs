//! The contract's message ABI.
//!
//! Byte fields are lowercase or uppercase hex (`HexBinary`); fixed lengths are
//! enforced by the handlers. u64 fields that are part of a signed payload are
//! `Uint64` (JSON strings) so JavaScript clients never lose precision; money is
//! `Uint128` (JSON strings). `chain_game_id` is this contract's u64 counter; the
//! server's `game_id` (`g_…`) never appears on chain.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{HexBinary, Timestamp, Uint128, Uint64};

use crate::state::{
    CheckpointRecord, Config, Game, GameParams, GamePolicy, GameState, Mode, RemedyKey, Seat,
    SignerKey,
};

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub operator: String,
    pub resolver: String,
    pub treasury: String,
    /// The one native denom accepted for antes and bonds (fixed for the
    /// contract's life).
    pub denom: String,
    pub params: GameParams,
    /// Settlement-signer keys to register at instantiation (33-byte compressed).
    /// They receive key ids 1, 2, … in order.
    pub signer_keys: Vec<HexBinary>,
    /// The join-admission key (33-byte compressed secp256k1, on the curve, not
    /// one of `signer_keys`). Every `Join` needs its signature.
    pub admission_pubkey: HexBinary,
    /// Escrow 2.1.0: REMEDY attestation keys to register at instantiation
    /// (33-byte compressed, on the curve, never a signer or admission key).
    /// They receive remedy key ids 1, 2, … in order. May be empty.
    pub remedy_keys: Vec<HexBinary>,
}

/// Escrow 2.1.0: the deadline class a game is funded under (`CreateGame`),
/// frozen into its terms and policy.
#[cw_serde]
pub enum DeadlineChoice {
    /// Live only: the 20-minute action clock with the 30:00 cure / approval
    /// window and the third-strike foreclosure (`GamePolicy::TimedRemedyV1`).
    LiveActionClock {},
    /// Async only: a fixed pace, one of 43200 (12 h), 86400 (24 h), 172800
    /// (2 d), 259200 (3 d), 604800 (7 d) seconds (`GamePolicy::TimedRemedyV1`).
    AsyncPace { allowance_secs: u64 },
    /// Async only: no action deadline, no timed remedy
    /// (`GamePolicy::NoDeadline`).
    NoDeadline {},
}

/// `RemedyAttestationV1` (see `remedy`), in field order. All times are Unix
/// seconds. The contract re-encodes it to the canonical 166 bytes before
/// hashing; nothing here is hashed as JSON.
#[cw_serde]
pub struct RemedyAttestationV1 {
    /// Exactly 1.
    pub version: u8,
    /// 32 bytes: the game's settlement domain.
    pub domain: HexBinary,
    pub chain_game_id: Uint64,
    /// 1 LiveTimeoutAnnul, 2 LiveForeclose, 3 LiveStrike3Foreclose,
    /// 4 AsyncAnnul, 5 AsyncForeclose.
    pub remedy: u8,
    pub defaulting_seat: u8,
    /// Live: 1, 2 (remedies 1–2) or 3 (remedy 3). Async: 0.
    pub strike: u8,
    pub overdue_epoch: Uint64,
    pub log_len: Uint64,
    /// 32 bytes.
    pub log_hash: HexBinary,
    pub allowance_secs: Uint64,
    pub overdue_at: Uint64,
    pub final_at: Uint64,
    /// When the REMEDY key signed: `final_at ≤ attested_at ≤` block time.
    pub attested_at: Uint64,
    pub expires_at: Uint64,
    /// 32 bytes.
    pub evidence_hash: HexBinary,
    pub remedy_key_id: u16,
}

/// The hosted server's authorization for the `Join` transaction's SENDER to
/// take a seat in this game with this join ticket (`crypto::join_admission_digest`).
/// It names no wallet: the digest is rebuilt from `info.sender`, so an
/// admission copied into another wallet's `Join` never verifies.
#[cw_serde]
pub struct JoinAdmission {
    /// Unix seconds; `Join` needs block time (whole seconds) strictly before it.
    pub expires_at: Uint64,
    /// 64-byte low-s `r ‖ s` by `Config::admission_pubkey` over the JOIN digest.
    pub signature: HexBinary,
}

/// SettlementPayloadV1, amended layout (SET-0A rev 2 §21), in field order.
/// The contract re-encodes it to the canonical `136 + 16·n` bytes before
/// hashing; nothing here is hashed as JSON.
#[cw_serde]
pub struct SettlementPayloadV1 {
    /// Exactly 1.
    pub version: u8,
    /// 32 bytes: this game's settlement domain.
    pub domain: HexBinary,
    /// `2·log_len + kind_bit`.
    pub seq: Uint64,
    /// 0 = Checkpoint, 1 = Terminal.
    pub kind: u8,
    /// 0 RoundBoundary, 1 BankBroken, 2 Bankruptcy, 3 Forfeit, 4 Clemency,
    /// 5 ResolverCorrection; anything else is refused.
    pub reason: u8,
    pub log_len: Uint64,
    /// 32 bytes.
    pub log_hash: HexBinary,
    pub appraisal_log_len: Uint64,
    /// 32 bytes.
    pub appraisal_state_hash: HexBinary,
    pub state_schema_version: u16,
    /// Must equal `settlement_weights.len()` and the roster length.
    pub seat_count: u8,
    /// Unsigned u128 weights in `chain_seat_index` order; Σ > 0.
    pub settlement_weights: Vec<Uint128>,
    pub signer_key_id: u16,
    pub issued_at: Uint64,
}

/// A seat's consent (or annul) signature: 64-byte low-s `r ‖ s`.
#[cw_serde]
pub struct SeatSignature {
    pub seat_index: u8,
    pub signature: HexBinary,
}

/// A non-defaulting seat's approval of a remedy (escrow 2.1.0): its consent
/// key's 64-byte low-s `r ‖ s` over the REMEDY-APPROVE digest, which binds
/// `approve_until` (Unix seconds, compared with block time): the seat's own
/// bound on how long its approval may be used. From that second on the
/// approval is refused (`ApprovalExpired`), whatever the REMEDY key attests.
#[cw_serde]
pub struct RemedyApproval {
    pub seat_index: u8,
    pub approve_until: Uint64,
    pub signature: HexBinary,
}

/// A signed Checkpoint payload carried inside `LivenessSettle`.
#[cw_serde]
pub struct SignedCheckpoint {
    pub payload: SettlementPayloadV1,
    pub signature: HexBinary,
}

#[cw_serde]
pub enum ResolveOutcome {
    /// The stored settlement stands; the challenger's bond joins the pool.
    Uphold {},
    /// A corrected payload (reason ResolverCorrection) authorised by the
    /// resolver's transaction; the bond goes back to the challenger. Its seq
    /// must exceed the game's trusted checkpoint floor only: the disputed
    /// settlement never constrains it, so the same log position is legal.
    /// Refused for an escrow 2.1.0 third-strike foreclosure
    /// (`RemedySettlementNotReplaceable`): that one is upheld or annulled.
    Replace { payload: SettlementPayloadV1 },
    /// Refund every seat's net ante; the bond goes back to the challenger.
    Annul {},
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Opens a game with the creator's deposit (exactly one coin of the
    /// configured denom, at least `min_ante`). The creator becomes seat 0.
    CreateGame {
        max_players: u8,
        mode: Mode,
        rules_engine_version: u32,
        /// 32 bytes.
        variants_digest: HexBinary,
        /// 33-byte compressed secp256k1 key.
        consent_pubkey: HexBinary,
        /// 32 bytes, stored verbatim.
        join_ticket: HexBinary,
        /// Escrow 2.1.0, required: the game's deadline class, which must suit
        /// `mode` (`DeadlineNotForMode`). Frozen into the game's terms. (An
        /// escrow 2.0.0 CreateGame without the field does not decode: the
        /// deadline class is never chosen by default.)
        deadline: DeadlineChoice,
    },
    /// Takes the next seat with exactly the creator's gross ante. The consent
    /// key must not be another seat's current key. The admission must be the
    /// admission key's signature for (this chain, this contract, this game, the
    /// sender, this ticket, its expiry); it is checked before anything changes.
    Join {
        chain_game_id: u64,
        consent_pubkey: HexBinary,
        /// 32 bytes, stored verbatim.
        join_ticket: HexBinary,
        admission: JoinAdmission,
    },
    /// A seated wallet leaves before `Start` and gets its net ante back.
    Withdraw {
        chain_game_id: u64,
    },
    /// Before `Start`: the creator at any time, anyone after the funding
    /// deadline. Refunds every seat's net ante.
    Cancel {
        chain_game_id: u64,
    },
    /// The seat's own wallet replaces its consent key (never with another
    /// seat's current key). A real rotation withdraws the seat's recorded
    /// consent to the stored settlement; re-setting the current key is a no-op.
    SetConsentKey {
        chain_game_id: u64,
        new_pubkey: HexBinary,
    },
    /// Operator only: freezes the roster, domain, bond and windows.
    Start {
        chain_game_id: u64,
        /// 32 bytes; must equal the on-chain roster's hash.
        roster_hash: HexBinary,
    },
    /// Anyone: posts a signed Checkpoint payload. Works while paused (it moves
    /// no funds).
    Checkpoint {
        chain_game_id: u64,
        payload: SettlementPayloadV1,
        signature: HexBinary,
    },
    /// Anyone: posts a signed Terminal payload plus any seat consents. Every
    /// supplied consent must verify; all seats consenting settles at once.
    Settle {
        chain_game_id: u64,
        payload: SettlementPayloadV1,
        signature: HexBinary,
        consents: Vec<SeatSignature>,
    },
    /// Anyone: adds one seat's consent to the stored settlement.
    Consent {
        chain_game_id: u64,
        seat_index: u8,
        signature: HexBinary,
    },
    /// Anyone, once the challenge window has closed.
    Finalize {
        chain_game_id: u64,
    },
    /// A seated wallet, before the window closes, with exactly the game's bond.
    Challenge {
        chain_game_id: u64,
        /// 32 bytes, stored for the resolver.
        evidence_hash: HexBinary,
    },
    /// Resolver only, on a disputed game.
    Resolve {
        chain_game_id: u64,
        outcome: ResolveOutcome,
    },
    /// Anyone, with a valid ANNUL signature from every seat over the game's
    /// trusted sequence (`GameResponse::trusted_seq`). Works while paused.
    /// IN_PROGRESS or SETTLEABLE; an escrow 2.1.0 game also while DISPUTED
    /// (the challenger's bond goes back to the challenger). Every net deposit
    /// is refunded (ANNULLED).
    AnnulByConsent {
        chain_game_id: u64,
        consents: Vec<SeatSignature>,
    },
    /// A seated wallet: the liveness exit. Works while paused. Available for
    /// SETTLEABLE from `window_end + liveness_window` and for DISPUTED after
    /// the resolver timeout. IN_PROGRESS only for a game created by escrow
    /// 2.0.0 code (after its inactivity window); a 2.1.0 game refuses it while
    /// IN_PROGRESS (`LivenessExitRemoved`), at any time.
    LivenessSettle {
        chain_game_id: u64,
        /// IN_PROGRESS (2.0.0 games) only: a newer signed checkpoint, validated
        /// exactly like `Checkpoint` and promoted in the same transaction.
        /// Eligibility is decided before it is processed, and it does not
        /// restart the liveness clock. Omit it (or pass null) for the plain
        /// exit.
        #[serde(default)]
        checkpoint: Option<SignedCheckpoint>,
    },
    /// Escrow 2.1.0, a seated wallet of any IN_PROGRESS 2.1.0 game: asks the
    /// game's resolver for the exceptional review. Records the first request
    /// (seat and time); a later request changes nothing; an accepted
    /// `Checkpoint` beyond the trusted sequence at the request withdraws it.
    /// Moves no funds; works while paused.
    RequestReview {
        chain_game_id: u64,
    },
    /// Escrow 2.1.0, the game's resolver (the address it adopted at `Start`,
    /// never one of the game's own seats) only, on an IN_PROGRESS 2.1.0 game
    /// whose review was requested at least 7 days (`terms.review_delay_secs`)
    /// ago (`GameDeadlines::review_annul_available_at`): refunds every seat's
    /// net deposit (ANNULLED). It carries no payload and no amounts: the only
    /// outcome it can produce is the neutral refund. Works while paused.
    ReviewAnnul {
        chain_game_id: u64,
        /// The `requested_at` of the request being decided
        /// (`Game::review_request`). A decision taken for an earlier, since
        /// withdrawn request is refused (`ReviewRequestMismatch`).
        requested_at: Timestamp,
    },
    /// Escrow 2.1.0, anyone (a relayer), on an IN_PROGRESS `TimedRemedyV1`
    /// game: executes a FINAL timed remedy attested by an active REMEDY key,
    /// with, where the remedy needs them, the REMEDY-APPROVE signatures of
    /// every non-defaulting seat (and of no other). Remedies 1 and 4 refund
    /// every net deposit (ANNULLED), 2 and 5 foreclose (SETTLED), 3 stores the
    /// foreclosure as a challengeable settlement (SETTLEABLE). The foreclosing
    /// remedies (2, 3, 5) are refused while the contract is paused; the
    /// neutral ones (1, 4) are not. Carries no address and no amount.
    SubmitRemedy {
        chain_game_id: u64,
        attestation: RemedyAttestationV1,
        /// 64-byte low-s `r ‖ s` by the REMEDY key over the REMEDY digest.
        signature: HexBinary,
        /// Remedies 2, 4, 5: one unexpired REMEDY-APPROVE approval per
        /// non-defaulting seat. Remedies 1 and 3: empty.
        approvals: Vec<RemedyApproval>,
    },
    // ------------------------------------------------------------- admin
    Pause {},
    Unpause {},
    AddSignerKey {
        pubkey: HexBinary,
    },
    /// Retire a key; `compromised: true` also stops `LivenessSettle` from using
    /// its checkpoints and settlements and removes their sequence authority. A
    /// retired key may be escalated to compromised later; never the reverse.
    RetireSignerKey {
        key_id: u16,
        compromised: bool,
    },
    SetOperator {
        operator: String,
    },
    /// Applies to games started afterwards: a started game keeps the resolver
    /// it adopted at `Start`.
    SetResolver {
        resolver: String,
    },
    /// Applies to games created afterwards.
    SetTreasury {
        treasury: String,
    },
    /// Applies to games created afterwards.
    SetParams {
        params: GameParams,
    },
    /// Replaces the join-admission key (33-byte compressed, on the curve, never
    /// a registered signer key). Takes effect at once: every admission signed
    /// under the previous key stops verifying; seats already taken are kept.
    SetAdmissionKey {
        pubkey: HexBinary,
    },
    /// Escrow 2.1.0: registers a REMEDY attestation key (33-byte compressed,
    /// on the curve, never a current or former signer or admission key).
    AddRemedyKey {
        pubkey: HexBinary,
    },
    /// Escrow 2.1.0: retires a remedy key (later attestations under it are
    /// refused); `compromised: true` also removes the payout authority of a
    /// third-strike foreclosure it attested. Escalation only, never reversed.
    RetireRemedyKey {
        key_id: u16,
        compromised: bool,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(GameResponse)]
    Game { chain_game_id: u64 },
    #[returns(GamesResponse)]
    Games {
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    /// The roster in `chain_seat_index` order.
    #[returns(SeatsResponse)]
    Seats { chain_game_id: u64 },
    /// The latest checkpoint per signer key, newest first, and which one
    /// `LivenessSettle` would use now.
    #[returns(CheckpointsResponse)]
    Checkpoints { chain_game_id: u64 },
    #[returns(SignerKeyResponse)]
    SignerKey { key_id: u16 },
    #[returns(SignerKeysResponse)]
    SignerKeys {
        start_after: Option<u16>,
        limit: Option<u32>,
    },
    #[returns(RemedyKeyResponse)]
    RemedyKey { key_id: u16 },
    #[returns(RemedyKeysResponse)]
    RemedyKeys {
        start_after: Option<u16>,
        limit: Option<u32>,
    },
    /// What paying the stored settlement's weights from the current pool would
    /// send each seat (and the treasury) right now.
    #[returns(SettlementPreviewResponse)]
    SettlementPreview { chain_game_id: u64 },
}

#[cw_serde]
pub struct MigrateMsg {}

#[cw_serde]
pub struct CreateGameResponse {
    pub chain_game_id: u64,
}

#[cw_serde]
pub struct ConfigResponse {
    pub config: Config,
    pub next_chain_game_id: u64,
    pub next_signer_key_id: u16,
    /// Escrow 2.1.0.
    pub next_remedy_key_id: u16,
    pub contract_name: String,
    pub contract_version: String,
}

/// Deadlines derived from block-time bookkeeping, for display and relayers.
#[cw_serde]
pub struct GameDeadlines {
    /// `Join` needs block time before this; anyone may `Cancel` from it on.
    pub funding_deadline: Timestamp,
    /// IN_PROGRESS, escrow 2.0.0 games only: `LivenessSettle` from this time
    /// (last Start/Checkpoint + liveness window); always `None` for a 2.1.0
    /// game, which has no IN_PROGRESS inactivity exit. SETTLEABLE: from
    /// `challenge_window_end` + liveness window.
    pub liveness_available_at: Option<Timestamp>,
    /// SETTLEABLE: `Challenge` before, `Finalize` from this time.
    pub challenge_window_end: Option<Timestamp>,
    /// DISPUTED: `LivenessSettle` from this time.
    pub resolver_timeout_at: Option<Timestamp>,
    /// Escrow 2.1.0, IN_PROGRESS game with a review request: the resolver may
    /// `ReviewAnnul` from this time (request + 7-day review delay).
    #[serde(default)]
    pub review_annul_available_at: Option<Timestamp>,
}

#[cw_serde]
pub struct GameResponse {
    pub game: Game,
    /// Global pause flag at query time.
    pub paused: bool,
    /// The highest-seq checkpoint accepted for this game, if any (whatever its
    /// key's status; see `Checkpoints` for the liveness candidate).
    pub latest_checkpoint: Option<CheckpointRecord>,
    /// The sequence authority now: the highest seq among the game's stored
    /// evidence whose signer key is not compromised. A new Checkpoint or Settle
    /// must exceed it, and ANNUL signatures sign over it. While the game is
    /// live it equals `game.last_seq` unless a signer key was marked
    /// compromised.
    pub trusted_seq: Uint64,
    pub deadlines: GameDeadlines,
}

#[cw_serde]
pub struct GameSummary {
    pub chain_game_id: u64,
    pub state: GameState,
    pub creator: String,
    pub mode: Mode,
    pub max_players: u8,
    pub seats_filled: u8,
    pub ante_gross: Uint128,
    pub pool: Uint128,
    /// Escrow 2.1.0: the game's exit policy (`None` = stored by 2.0.0 code).
    pub policy: Option<GamePolicy>,
}

#[cw_serde]
pub struct GamesResponse {
    pub games: Vec<GameSummary>,
}

#[cw_serde]
pub struct SeatView {
    pub chain_seat_index: u8,
    pub seat: Seat,
    /// This seat's consent to the stored settlement has been verified.
    pub consented: bool,
}

#[cw_serde]
pub struct SeatsResponse {
    pub seats: Vec<SeatView>,
}

#[cw_serde]
pub struct CheckpointView {
    pub checkpoint: CheckpointRecord,
    pub signer_key_retired: bool,
    pub signer_key_compromised: bool,
}

#[cw_serde]
pub struct CheckpointsResponse {
    pub checkpoints: Vec<CheckpointView>,
    /// Seq of the highest checkpoint whose signer key is not compromised, if
    /// any: the checkpoint an escrow 2.0.0 game's `LivenessSettle` would
    /// promote now, and for every game the floor a resolver `Replace` must
    /// exceed. A 2.1.0 game never promotes a checkpoint.
    pub liveness_candidate_seq: Option<Uint64>,
}

#[cw_serde]
pub struct SignerKeyResponse {
    pub key: SignerKey,
}

#[cw_serde]
pub struct SignerKeysResponse {
    pub keys: Vec<SignerKey>,
}

#[cw_serde]
pub struct RemedyKeyResponse {
    pub key: RemedyKey,
}

#[cw_serde]
pub struct RemedyKeysResponse {
    pub keys: Vec<RemedyKey>,
}

#[cw_serde]
pub struct SettlementPreviewResponse {
    pub pool: Uint128,
    pub settlement_weights: Vec<Uint128>,
    pub payouts: Vec<Uint128>,
    pub dust: Uint128,
}
