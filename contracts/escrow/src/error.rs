//! Every refusal the escrow contract can answer with.
//!
//! Variant names follow the ESCROW-1.5 §9.1 vocabulary where the design names
//! an error (`WrongState`, `StaleSeq`, `AlreadyJoined`, `NotSeated`); the rest
//! are specific enough that a relayer, a frontend or a test can tell exactly
//! which precondition failed.

use cosmwasm_std::{
    ConversionOverflowError, DivideByZeroError, OverflowError, StdError, Timestamp, Uint128,
};
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    // ---------------------------------------------------------------- roles
    #[error("unauthorized: only the {role} may do this")]
    Unauthorized { role: String },

    #[error("sender is not seated in game {chain_game_id}")]
    NotSeated { chain_game_id: u64 },

    #[error("this wallet is already seated in game {chain_game_id}")]
    AlreadyJoined { chain_game_id: u64 },

    // ------------------------------------------------------------ lifecycle
    #[error("game {chain_game_id} not found")]
    GameNotFound { chain_game_id: u64 },

    #[error("wrong state: game is {actual}, this message needs {expected}")]
    WrongState { expected: String, actual: String },

    #[error("the contract is paused")]
    Paused {},

    #[error("the game has no free seat")]
    GameFull {},

    #[error("the funding deadline has passed")]
    FundingClosed {},

    // ---------------------------------------------------------------- funds
    #[error("this message does not accept funds")]
    NonPayable {},

    #[error("expected exactly one non-zero coin of {denom}")]
    InvalidFunds { denom: String },

    #[error("deposit {got} is below the minimum ante {min}")]
    BelowMinAnte { min: Uint128, got: Uint128 },

    #[error("deposit must equal the game's gross ante {expected}, got {got}")]
    WrongAnte { expected: Uint128, got: Uint128 },

    #[error("the challenge bond must be exactly {expected}, got {got}")]
    WrongBond { expected: Uint128, got: Uint128 },

    // --------------------------------------------------------- game inputs
    #[error("max_players must be between 2 and 7, got {got}")]
    BadMaxPlayers { got: u8 },

    #[error("{field} must be {expected} bytes, got {got}")]
    BadLength {
        field: String,
        expected: usize,
        got: usize,
    },

    #[error("{field} must be a valid 33-byte compressed secp256k1 public key")]
    BadPubkey { field: String },

    /// Consent keys are unique within a game: no two seats hold the same key at
    /// once.
    #[error("this consent key is already used by seat {seat_index} of this game")]
    ConsentKeyInUse { seat_index: u8 },

    #[error("the roster hash does not match the on-chain roster")]
    RosterHashMismatch {},

    // ------------------------------------------------------------- payloads
    #[error("unsupported payload version {got}")]
    BadVersion { got: u8 },

    #[error("the payload domain does not match this game")]
    DomainMismatch {},

    #[error("invalid payload kind {got}")]
    BadKind { got: u8 },

    #[error("this message needs a {expected} payload")]
    WrongKind { expected: String },

    #[error("reason {got} is reserved or unknown")]
    UnknownReason { got: u8 },

    #[error("reason {reason} is not allowed for this message")]
    ReasonNotAllowed { reason: u8 },

    #[error("seq {seq} does not equal 2*log_len + kind_bit")]
    BadSeq { seq: u64 },

    #[error("appraisal_log_len {appraisal_log_len} is not valid for log_len {log_len} and this kind/reason")]
    BadAppraisalLogLen {
        appraisal_log_len: u64,
        log_len: u64,
    },

    #[error("seat_count {seat_count} does not match the {weights} settlement weights")]
    SeatCountMismatch { seat_count: u8, weights: usize },

    #[error("the payload carries {got} settlement weights, the roster has {expected} seats")]
    RosterLengthMismatch { expected: usize, got: usize },

    #[error("the settlement weights sum to zero")]
    ZeroSumWeights {},

    /// `trusted_seq` is the game's sequence authority: the highest seq among
    /// accepted evidence whose signer key is not compromised (for `Replace`,
    /// among trusted checkpoints only).
    #[error("seq {seq} does not exceed the trusted sequence {trusted_seq}")]
    StaleSeq { seq: u64, trusted_seq: u64 },

    #[error("payload is malformed: {reason}")]
    MalformedPayload { reason: String },

    // ----------------------------------------------------------- signatures
    #[error("signer key {key_id} is not registered")]
    UnknownSignerKey { key_id: u16 },

    #[error("signer key {key_id} is retired")]
    RetiredSignerKey { key_id: u16 },

    /// The stored settlement was signed by a key that has since been marked
    /// compromised. It stays on record as evidence but has lost its payout
    /// authority: `Finalize` and `Consent` refuse it, while `Challenge`,
    /// `AnnulByConsent` and the SETTLEABLE `LivenessSettle` recovery remain.
    /// Distinct from `RetiredSignerKey`: a key retired without compromise stays
    /// trusted.
    #[error("the stored settlement's signer key {key_id} is compromised; it can no longer be finalized or consented to")]
    CompromisedSettlement { key_id: u16 },

    #[error("a signature must be 64 bytes r||s, got {got}")]
    BadSignatureLength { got: usize },

    #[error("the signature is not low-s normalised")]
    HighS {},

    #[error("invalid signature")]
    InvalidSignature {},

    #[error("seat index {seat_index} is out of range")]
    SeatIndexOutOfRange { seat_index: u8 },

    #[error("duplicate signature for seat {seat_index}")]
    DuplicateConsent { seat_index: u8 },

    #[error("invalid signature for seat {seat_index}")]
    InvalidConsent { seat_index: u8 },

    #[error("every seat must sign; seat {seat_index} is missing")]
    MissingConsent { seat_index: u8 },

    // ------------------------------------------------------------ admission
    /// `Join` carried no valid signature of the admission key over (this chain,
    /// this contract, this game, the SENDER, this ticket, this expiry): a
    /// malformed, high-s, copied, foreign or forged admission alike.
    #[error("the join admission does not authorize this wallet for this game")]
    InvalidAdmission {},

    /// Block time (whole seconds) has reached the admission's `expires_at`.
    #[error("the join admission expired at {expires_at}")]
    AdmissionExpired { expires_at: u64 },

    // --------------------------------------------------------------- timing
    #[error("the challenge window is open until {until}")]
    WindowOpen { until: Timestamp },

    #[error("the challenge window closed at {closed}")]
    WindowClosed { closed: Timestamp },

    #[error("the liveness window has not elapsed; available at {at}")]
    LivenessNotReached { at: Timestamp },

    #[error("the resolver timeout has not elapsed; available at {at}")]
    ResolverTimeoutNotReached { at: Timestamp },

    // ---------------------------------------------------------------- admin
    #[error("invalid parameter: {reason}")]
    InvalidParams { reason: String },

    #[error("this public key is already registered as signer key {key_id}")]
    DuplicateSignerKey { key_id: u16 },

    /// At most `MAX_SIGNER_KEYS` keys are ever registered (retired keys
    /// included), which bounds every liveness scan over a game's checkpoints.
    #[error("the signer key registry is full")]
    KeyIdsExhausted {},

    // ------------------------------------------------------------ arithmetic
    #[error("arithmetic overflow")]
    Overflow {},

    #[error("internal invariant violated: {reason}")]
    Invariant { reason: String },

    // -------------------------------------------------------------- migrate
    #[error("cannot migrate from contract {contract}")]
    MigrateForeignContract { contract: String },

    #[error("cannot migrate from version {from} to older version {to}")]
    MigrateDowngrade { from: String, to: String },

    #[error("unparseable contract version {version}")]
    BadContractVersion { version: String },

    /// A stored version whose state this code cannot read (before 2.0.0 there
    /// was no admission key): deploy a new contract instead.
    #[error(
        "cannot migrate from version {from}: its state predates this code; deploy a new contract"
    )]
    MigrateUnsupported { from: String },
}

impl From<OverflowError> for ContractError {
    fn from(_: OverflowError) -> Self {
        ContractError::Overflow {}
    }
}

impl From<DivideByZeroError> for ContractError {
    fn from(_: DivideByZeroError) -> Self {
        ContractError::Overflow {}
    }
}

impl From<ConversionOverflowError> for ContractError {
    fn from(_: ConversionOverflowError) -> Self {
        ContractError::Overflow {}
    }
}
