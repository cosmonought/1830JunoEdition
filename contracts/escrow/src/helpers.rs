//! Shared guards and money movement for the execute handlers.
//!
//! Check order used by every game handler, so refusals are predictable:
//! 1. the game exists; 2. its state allows the message; 3. the caller's role;
//! 4. the global pause (only for messages the design blocks while paused);
//! 5. funds, time and payload checks.
//!
//! Sequence authority: a payload must exceed [`trusted_seq`], the highest seq
//! among accepted evidence whose signer key is not compromised. `Game.last_seq`
//! keeps the raw historical maximum for audit, but is never an authority gate,
//! so a forged payload under a key later marked compromised cannot block honest
//! progress (OD-ESC2-3).
//!
//! Every payout goes through [`pay_out`] and every refund through [`refund_all`].
//! Both zero the pool and move the game to a terminal state in the same
//! transaction as their `BankMsg`s, and neither ever emits a zero-amount coin
//! (the bank module rejects those, which would revert the whole exit).

use cosmwasm_std::{
    Addr, Api, BankMsg, Coin, HexBinary, MessageInfo, Order, Storage, Timestamp, Uint128, Uint64,
};

use crate::crypto::{check_signature, consent_digest};
use crate::error::ContractError;
use crate::msg::SeatSignature;
use crate::payload::{fixed_bytes, Payload, PayloadUse};
use crate::payout::{proportional_split, weights_have_positive_sum};
use crate::state::{
    CheckpointRecord, Config, Game, GameState, Outcome, PayloadRecord, Route, SignerKey,
    CHECKPOINTS, GAMES, SIGNER_KEYS,
};

/// Roster bounds (A3: Level Playing Field money rooms may seat 7).
pub const MIN_PLAYERS: u8 = 2;
pub const MAX_PLAYERS: u8 = 7;

const NANOS_PER_SECOND: u64 = 1_000_000_000;

pub fn nonpayable(info: &MessageInfo) -> Result<(), ContractError> {
    if info.funds.is_empty() {
        Ok(())
    } else {
        Err(ContractError::NonPayable {})
    }
}

/// Exactly one non-zero coin of `denom`; returns its amount.
pub fn one_coin(info: &MessageInfo, denom: &str) -> Result<Uint128, ContractError> {
    match info.funds.as_slice() {
        [coin] if coin.denom == denom && !coin.amount.is_zero() => Ok(coin.amount),
        _ => Err(ContractError::InvalidFunds {
            denom: denom.to_string(),
        }),
    }
}

pub fn load_game(storage: &dyn Storage, chain_game_id: u64) -> Result<Game, ContractError> {
    GAMES
        .may_load(storage, chain_game_id)?
        .ok_or(ContractError::GameNotFound { chain_game_id })
}

pub fn save_game(storage: &mut dyn Storage, game: &Game) -> Result<(), ContractError> {
    GAMES.save(storage, game.chain_game_id, game)?;
    Ok(())
}

pub fn require_state(game: &Game, allowed: &[GameState]) -> Result<(), ContractError> {
    if allowed.contains(&game.state) {
        return Ok(());
    }
    let expected = allowed
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(" or ");
    Err(ContractError::WrongState {
        expected,
        actual: game.state.as_str().to_string(),
    })
}

pub fn require_not_paused(config: &Config) -> Result<(), ContractError> {
    if config.paused {
        Err(ContractError::Paused {})
    } else {
        Ok(())
    }
}

pub fn seat_index_of(game: &Game, who: &Addr) -> Option<usize> {
    game.seats.iter().position(|seat| seat.wallet == *who)
}

pub fn require_seated(game: &Game, who: &Addr) -> Result<usize, ContractError> {
    seat_index_of(game, who).ok_or(ContractError::NotSeated {
        chain_game_id: game.chain_game_id,
    })
}

/// `t + secs` with every step checked (`Timestamp::plus_seconds` multiplies
/// unchecked inside a `const fn`).
pub fn add_secs(t: Timestamp, secs: u64) -> Result<Timestamp, ContractError> {
    let nanos = secs
        .checked_mul(NANOS_PER_SECOND)
        .ok_or(ContractError::Overflow {})?;
    let total = t
        .nanos()
        .checked_add(nanos)
        .ok_or(ContractError::Overflow {})?;
    Ok(Timestamp::from_nanos(total))
}

/// A `BankMsg::Send` of one coin, or `None` for zero (never emitted).
pub fn send(to: &Addr, amount: Uint128, denom: &str) -> Option<BankMsg> {
    if amount.is_zero() {
        return None;
    }
    Some(BankMsg::Send {
        to_address: to.to_string(),
        amount: vec![Coin {
            denom: denom.to_string(),
            amount,
        }],
    })
}

/// Bit mask with the low `n` bits set (`n` ≤ 8).
pub fn full_mask(n: usize) -> Result<u8, ContractError> {
    let shift = u32::try_from(n).map_err(|_| ContractError::Overflow {})?;
    let wide = 1u16
        .checked_shl(shift)
        .and_then(|v| v.checked_sub(1))
        .ok_or(ContractError::Overflow {})?;
    u8::try_from(wide).map_err(|_| ContractError::Overflow {})
}

pub fn seat_bit(index: usize) -> Result<u8, ContractError> {
    let shift = u32::try_from(index).map_err(|_| ContractError::Overflow {})?;
    if shift >= 8 {
        return Err(ContractError::Overflow {});
    }
    1u8.checked_shl(shift).ok_or(ContractError::Overflow {})
}

/// The game's frozen settlement domain.
pub fn game_domain(game: &Game) -> Result<[u8; 32], ContractError> {
    let domain = game
        .domain
        .as_ref()
        .ok_or_else(|| ContractError::Invariant {
            reason: "game has no settlement domain".to_string(),
        })?;
    fixed_bytes::<32>("domain", domain)
}

/// Every payload rule that depends on the game: the A1/A2 shape rules for this
/// message, the domain, the roster length, Σw > 0, and `seq > floor`, where
/// `floor` is the caller's trusted sequence floor ([`trusted_seq`] for
/// Checkpoint and Settle, [`trusted_checkpoint_seq`] for a resolver Replace).
pub fn check_payload_for_game(
    game: &Game,
    payload: &Payload,
    usage: PayloadUse,
    floor: u64,
) -> Result<(), ContractError> {
    payload.check_shape(usage)?;
    if payload.domain != game_domain(game)? {
        return Err(ContractError::DomainMismatch {});
    }
    if payload.settlement_weights.len() != game.seats.len() {
        return Err(ContractError::RosterLengthMismatch {
            expected: game.seats.len(),
            got: payload.settlement_weights.len(),
        });
    }
    let weights: Vec<Uint128> = payload
        .settlement_weights
        .iter()
        .map(|w| Uint128::new(*w))
        .collect();
    if !weights_have_positive_sum(&weights)? {
        return Err(ContractError::ZeroSumWeights {});
    }
    if payload.seq <= floor {
        return Err(ContractError::StaleSeq {
            seq: payload.seq,
            trusted_seq: floor,
        });
    }
    Ok(())
}

/// A registered, unretired signer key.
pub fn active_signer_key(storage: &dyn Storage, key_id: u16) -> Result<SignerKey, ContractError> {
    let key = SIGNER_KEYS
        .may_load(storage, key_id)?
        .ok_or(ContractError::UnknownSignerKey { key_id })?;
    if key.retired_at.is_some() {
        return Err(ContractError::RetiredSignerKey { key_id });
    }
    Ok(key)
}

/// `false` if the key was retired as compromised (or is unknown). Evidence
/// under an untrusted key is neither usable by `LivenessSettle` nor counted in
/// the trusted sequence floor.
pub fn key_is_trusted(storage: &dyn Storage, key_id: u16) -> Result<bool, ContractError> {
    Ok(match SIGNER_KEYS.may_load(storage, key_id)? {
        Some(key) => !key.compromised,
        None => false,
    })
}

/// The highest seq among this game's stored checkpoints whose signer key is not
/// compromised (0 when there is none). The floor a resolver `Replace` must
/// exceed: the disputed settlement itself never constrains its correction.
pub fn trusted_checkpoint_seq(
    storage: &dyn Storage,
    chain_game_id: u64,
) -> Result<u64, ContractError> {
    Ok(best_checkpoint(storage, chain_game_id, true)?
        .map(|c| c.payload.seq.u64())
        .unwrap_or(0))
}

/// The game's sequence authority: the highest seq among the evidence it holds
/// whose signer key is not compromised — every stored checkpoint (the newest
/// per key) and the stored settlement. It can fall below `game.last_seq` when a
/// key is marked compromised; that is recovery, not a monotonicity violation.
/// Checkpoint, Settle and the ANNUL digest use it.
pub fn trusted_seq(storage: &dyn Storage, game: &Game) -> Result<u64, ContractError> {
    let mut floor = trusted_checkpoint_seq(storage, game.chain_game_id)?;
    if let Some(settlement) = &game.settlement {
        if key_is_trusted(storage, settlement.payload.signer_key_id)? {
            floor = floor.max(settlement.payload.seq.u64());
        }
    }
    Ok(floor)
}

/// The index of a seat other than `except` whose current consent key is `key`.
pub fn consent_key_holder(game: &Game, key: &HexBinary, except: Option<usize>) -> Option<usize> {
    game.seats
        .iter()
        .enumerate()
        .find(|(i, seat)| Some(*i) != except && seat.consent_pubkey == *key)
        .map(|(i, _)| i)
}

/// Consent keys are unique within a game: no two seats hold the same key at
/// once. Together with `SetConsentKey` withdrawing a rotating seat's recorded
/// consent, every recorded consent is backed by that seat's own current key, so
/// N-of-N needs N distinct registered keys. Nothing on chain can stop a seat's
/// own wallet from delegating (registering a key someone else controls).
pub fn require_unique_consent_key(
    game: &Game,
    key: &HexBinary,
    except: Option<usize>,
) -> Result<(), ContractError> {
    match consent_key_holder(game, key, except) {
        Some(index) => Err(ContractError::ConsentKeyInUse {
            seat_index: u8::try_from(index).map_err(|_| ContractError::Overflow {})?,
        }),
        None => Ok(()),
    }
}

pub fn payload_record(payload: &Payload, digest: &[u8; 32]) -> PayloadRecord {
    PayloadRecord {
        seq: Uint64::new(payload.seq),
        kind: payload.kind,
        reason: payload.reason,
        log_len: Uint64::new(payload.log_len),
        log_hash: HexBinary::from(payload.log_hash.as_slice()),
        appraisal_log_len: Uint64::new(payload.appraisal_log_len),
        appraisal_state_hash: HexBinary::from(payload.appraisal_state_hash.as_slice()),
        state_schema_version: payload.state_schema_version,
        settlement_weights: payload
            .settlement_weights
            .iter()
            .map(|w| Uint128::new(*w))
            .collect(),
        signer_key_id: payload.signer_key_id,
        issued_at: Uint64::new(payload.issued_at),
        payload_digest: HexBinary::from(digest.as_slice()),
    }
}

/// Verifies seat signatures over `digest` against each seat's CURRENT key.
/// Every supplied signature must verify; an out-of-range or repeated seat index
/// is refused. With `require_all`, every seat must be present (N-of-N).
/// Returns the bit mask of the seats that signed.
pub fn verify_seat_signatures(
    api: &dyn Api,
    game: &Game,
    digest: &[u8; 32],
    signatures: &[SeatSignature],
    require_all: bool,
) -> Result<u8, ContractError> {
    let mut mask = 0u8;
    for entry in signatures {
        let index = usize::from(entry.seat_index);
        let seat = game
            .seats
            .get(index)
            .ok_or(ContractError::SeatIndexOutOfRange {
                seat_index: entry.seat_index,
            })?;
        let bit = seat_bit(index)?;
        if mask & bit != 0 {
            return Err(ContractError::DuplicateConsent {
                seat_index: entry.seat_index,
            });
        }
        check_signature(
            api,
            digest,
            entry.signature.as_slice(),
            seat.consent_pubkey.as_slice(),
        )
        .map_err(|_| ContractError::InvalidConsent {
            seat_index: entry.seat_index,
        })?;
        mask |= bit;
    }
    if require_all {
        for index in 0..game.seats.len() {
            if mask & seat_bit(index)? == 0 {
                return Err(ContractError::MissingConsent {
                    seat_index: u8::try_from(index).map_err(|_| ContractError::Overflow {})?,
                });
            }
        }
    }
    Ok(mask)
}

/// The consent digest for the game's stored settlement.
pub fn stored_consent_digest(game: &Game) -> Result<[u8; 32], ContractError> {
    let settlement = game
        .settlement
        .as_ref()
        .ok_or_else(|| ContractError::Invariant {
            reason: "no stored settlement".to_string(),
        })?;
    let settle = fixed_bytes::<32>("payload_digest", &settlement.payload.payload_digest)?;
    Ok(consent_digest(
        &game_domain(game)?,
        settlement.payload.seq.u64(),
        &settle,
    ))
}

/// The highest-seq checkpoint of this game whose signer key was not retired as
/// compromised (ESCROW-1.5 §7.5 case 5), with `usable_only`; otherwise simply
/// the highest-seq checkpoint.
pub fn best_checkpoint(
    storage: &dyn Storage,
    chain_game_id: u64,
    usable_only: bool,
) -> Result<Option<CheckpointRecord>, ContractError> {
    let mut best: Option<CheckpointRecord> = None;
    for item in CHECKPOINTS
        .prefix(chain_game_id)
        .range(storage, None, None, Order::Ascending)
    {
        let (key_id, record) = item?;
        if usable_only && !key_is_trusted(storage, key_id)? {
            continue;
        }
        let better = match &best {
            Some(current) => record.payload.seq > current.payload.seq,
            None => true,
        };
        if better {
            best = Some(record);
        }
    }
    Ok(best)
}

/// Pays `pool` out by `weights`: seats in `chain_seat_index` order, dust to the
/// game's treasury. Zeroes the pool and moves the game to SETTLED.
pub fn pay_out(
    game: &mut Game,
    weights: &[Uint128],
    pool: Uint128,
    route: Route,
    now: Timestamp,
    bond_returned: Uint128,
    bond_to_pool: Uint128,
) -> Result<Vec<BankMsg>, ContractError> {
    if weights.len() != game.seats.len() {
        return Err(ContractError::Invariant {
            reason: "settlement vector length differs from the roster".to_string(),
        });
    }
    let split = proportional_split(pool, weights)?;
    let mut msgs = Vec::with_capacity(game.seats.len().saturating_add(1));
    for (seat, amount) in game.seats.iter().zip(split.amounts.iter()) {
        if let Some(msg) = send(&seat.wallet, *amount, &game.denom) {
            msgs.push(msg);
        }
    }
    if let Some(msg) = send(&game.terms.treasury, split.dust, &game.denom) {
        msgs.push(msg);
    }
    game.pool = Uint128::zero();
    game.state = GameState::Settled;
    game.outcome = Some(Outcome {
        route,
        at: now,
        amounts: split.amounts,
        dust: split.dust,
        distributed: pool,
        bond_returned,
        bond_to_pool,
    });
    Ok(msgs)
}

/// Refunds every seat's stored net deposit. The pool must equal their sum.
/// Zeroes the pool and moves the game to `terminal`.
pub fn refund_all(
    game: &mut Game,
    terminal: GameState,
    route: Route,
    now: Timestamp,
    bond_returned: Uint128,
) -> Result<Vec<BankMsg>, ContractError> {
    if !terminal.is_terminal() {
        return Err(ContractError::Invariant {
            reason: "refund must end in a terminal state".to_string(),
        });
    }
    let mut total = Uint128::zero();
    let mut amounts = Vec::with_capacity(game.seats.len());
    let mut msgs = Vec::with_capacity(game.seats.len());
    for seat in &game.seats {
        total = total.checked_add(seat.net_deposit)?;
        amounts.push(seat.net_deposit);
        if let Some(msg) = send(&seat.wallet, seat.net_deposit, &game.denom) {
            msgs.push(msg);
        }
    }
    if total != game.pool {
        return Err(ContractError::Invariant {
            reason: "pool differs from the sum of net deposits".to_string(),
        });
    }
    game.pool = Uint128::zero();
    game.state = terminal;
    game.outcome = Some(Outcome {
        route,
        at: now,
        amounts,
        dust: Uint128::zero(),
        distributed: total,
        bond_returned,
        bond_to_pool: Uint128::zero(),
    });
    Ok(msgs)
}
