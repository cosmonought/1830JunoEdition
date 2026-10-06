//! Governance: pause, the signer-key registry, role addresses and parameters for
//! future games. Nothing here can move player funds, settle, cancel or annul a
//! game, or change a game that already exists.

use cosmwasm_std::{Addr, DepsMut, Env, HexBinary, MessageInfo, Response, Timestamp};

use crate::crypto::{parse_compressed_pubkey, pubkey_on_curve};
use crate::error::ContractError;
use crate::helpers::nonpayable;
use crate::payout::BPS_DENOMINATOR;
use crate::state::{
    Config, GameParams, SignerKey, ADMISSION_KEYS, CONFIG, NEXT_SIGNER_KEY_ID, SIGNER_KEYS,
    SIGNER_PUBKEY_INDEX,
};

/// Upper bound for every configured duration (10 years), so deadline arithmetic
/// on block time can never overflow.
pub const MAX_DURATION_SECS: u64 = 10 * 365 * 24 * 60 * 60;

/// Upper bound on signer keys ever registered (ids 1..=64; retired keys count).
///
/// `LivenessSettle` and the game queries scan a game's checkpoints, one stored
/// per signer key. Without a bound, an admin (or a compromised admin multisig)
/// could register thousands of keys, post one checkpoint under each, and make
/// the liveness exit too expensive to execute. The frozen design requires that
/// exit to be immune to the admin, so the registry is bounded. Raising the
/// bound needs a code migration.
pub const MAX_SIGNER_KEYS: u16 = 64;

fn require_admin(config: &Config, info: &MessageInfo) -> Result<(), ContractError> {
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {
            role: "admin".to_string(),
        });
    }
    Ok(())
}

/// Admin messages: admin only, no funds. They are not blocked by pause
/// (`Unpause` obviously must not be).
fn admin_guard(deps: &DepsMut, info: &MessageInfo) -> Result<Config, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    require_admin(&config, info)?;
    nonpayable(info)?;
    Ok(config)
}

pub fn validate_params(params: &GameParams) -> Result<(), ContractError> {
    let invalid = |reason: &str| ContractError::InvalidParams {
        reason: reason.to_string(),
    };
    if u128::from(params.subsidy_bps) > BPS_DENOMINATOR {
        return Err(invalid("subsidy_bps must be at most 10000"));
    }
    if params.min_ante.is_zero() {
        return Err(invalid("min_ante must be positive"));
    }
    for (name, value) in [
        (
            "challenge_window_live_secs",
            params.challenge_window_live_secs,
        ),
        (
            "challenge_window_async_secs",
            params.challenge_window_async_secs,
        ),
        ("funding_period_live_secs", params.funding_period_live_secs),
        (
            "funding_period_async_secs",
            params.funding_period_async_secs,
        ),
        ("liveness_window_secs", params.liveness_window_secs),
        ("resolver_timeout_secs", params.resolver_timeout_secs),
        ("review_delay_secs", params.review_delay_secs),
    ] {
        if value == 0 || value > MAX_DURATION_SECS {
            return Err(ContractError::InvalidParams {
                reason: format!("{name} must be between 1 and {MAX_DURATION_SECS} seconds"),
            });
        }
    }
    Ok(())
}

/// A native denom as the Cosmos SDK accepts it: `[a-zA-Z][a-zA-Z0-9/:._-]{2,127}`.
pub fn validate_denom(denom: &str) -> Result<(), ContractError> {
    let bytes = denom.as_bytes();
    let first_ok = bytes.first().is_some_and(|b| b.is_ascii_alphabetic());
    let rest_ok = bytes
        .iter()
        .skip(1)
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b':' | b'.' | b'_' | b'-'));
    if !(3..=128).contains(&bytes.len()) || !first_ok || !rest_ok {
        return Err(ContractError::InvalidParams {
            reason: format!("invalid denom {denom:?}"),
        });
    }
    Ok(())
}

/// Registers a compressed secp256k1 key under the next key id. The same key
/// material can never be registered twice, even after retirement, so retiring a
/// key (as compromised) always retires the key itself. A current or former
/// join-admission key is refused: the two roles never share key material.
pub fn register_signer_key(
    deps: &mut DepsMut,
    now: Timestamp,
    pubkey: HexBinary,
) -> Result<u16, ContractError> {
    let key = parse_compressed_pubkey("pubkey", pubkey.as_slice())?;
    if !pubkey_on_curve(deps.api, &key) {
        return Err(ContractError::BadPubkey {
            field: "pubkey".to_string(),
        });
    }
    if let Some(existing) = SIGNER_PUBKEY_INDEX.may_load(deps.storage, key.as_slice())? {
        return Err(ContractError::DuplicateSignerKey { key_id: existing });
    }
    if ADMISSION_KEYS.has(deps.storage, key.as_slice()) {
        return Err(ContractError::InvalidParams {
            reason: "a settlement signer key cannot be a current or former join-admission key"
                .to_string(),
        });
    }
    let key_id = NEXT_SIGNER_KEY_ID.load(deps.storage)?;
    if key_id > MAX_SIGNER_KEYS {
        return Err(ContractError::KeyIdsExhausted {});
    }
    let next = key_id
        .checked_add(1)
        .ok_or(ContractError::KeyIdsExhausted {})?;
    NEXT_SIGNER_KEY_ID.save(deps.storage, &next)?;
    SIGNER_KEYS.save(
        deps.storage,
        key_id,
        &SignerKey {
            key_id,
            pubkey,
            added_at: now,
            retired_at: None,
            compromised: false,
        },
    )?;
    SIGNER_PUBKEY_INDEX.save(deps.storage, key.as_slice(), &key_id)?;
    Ok(key_id)
}

pub fn pause(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let mut config = admin_guard(&deps, &info)?;
    config.paused = true;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "pause")
        .add_attribute("paused", "true"))
}

pub fn unpause(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let mut config = admin_guard(&deps, &info)?;
    config.paused = false;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "unpause")
        .add_attribute("paused", "false"))
}

pub fn add_signer_key(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    pubkey: HexBinary,
) -> Result<Response, ContractError> {
    admin_guard(&deps, &info)?;
    let key_id = register_signer_key(&mut deps, env.block.time, pubkey)?;
    Ok(Response::new()
        .add_attribute("action", "add_signer_key")
        .add_attribute("key_id", key_id.to_string()))
}

/// Retiring refuses every later payload under the key. `compromised` also stops
/// `LivenessSettle` from using what the key already signed. A retired key may
/// be escalated to compromised; nothing is ever un-retired or un-compromised.
pub fn retire_signer_key(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    key_id: u16,
    compromised: bool,
) -> Result<Response, ContractError> {
    admin_guard(&deps, &info)?;
    let mut key = SIGNER_KEYS
        .may_load(deps.storage, key_id)?
        .ok_or(ContractError::UnknownSignerKey { key_id })?;
    if key.retired_at.is_none() {
        key.retired_at = Some(env.block.time);
    }
    if compromised {
        key.compromised = true;
    }
    SIGNER_KEYS.save(deps.storage, key_id, &key)?;
    Ok(Response::new()
        .add_attribute("action", "retire_signer_key")
        .add_attribute("key_id", key_id.to_string())
        .add_attribute("compromised", key.compromised.to_string()))
}

pub fn set_operator(
    deps: DepsMut,
    info: MessageInfo,
    operator: String,
) -> Result<Response, ContractError> {
    let mut config = admin_guard(&deps, &info)?;
    config.operator = deps.api.addr_validate(&operator)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "set_operator")
        .add_attribute("operator", config.operator.as_str()))
}

pub fn set_resolver(
    deps: DepsMut,
    info: MessageInfo,
    resolver: String,
) -> Result<Response, ContractError> {
    let mut config = admin_guard(&deps, &info)?;
    config.resolver = deps.api.addr_validate(&resolver)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "set_resolver")
        .add_attribute("resolver", config.resolver.as_str()))
}

/// The treasury receives subsidies and dust by bank send. Sending them to this
/// contract itself would strand them outside every pool, so it is refused.
pub fn validate_treasury(env: &Env, treasury: &Addr) -> Result<(), ContractError> {
    if *treasury == env.contract.address {
        return Err(ContractError::InvalidParams {
            reason: "the treasury cannot be this contract".to_string(),
        });
    }
    Ok(())
}

/// Games copy the treasury when they are created, so this only affects games
/// created afterwards.
pub fn set_treasury(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    treasury: String,
) -> Result<Response, ContractError> {
    let mut config = admin_guard(&deps, &info)?;
    config.treasury = deps.api.addr_validate(&treasury)?;
    validate_treasury(&env, &config.treasury)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "set_treasury")
        .add_attribute("treasury", config.treasury.as_str()))
}

/// Parameters for games created afterwards; existing games keep their terms.
pub fn set_params(
    deps: DepsMut,
    info: MessageInfo,
    params: GameParams,
) -> Result<Response, ContractError> {
    let mut config = admin_guard(&deps, &info)?;
    validate_params(&params)?;
    config.params = params;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "set_params"))
}

/// A join-admission key: 33-byte compressed, on the curve, and never a key the
/// signer registry holds or ever held (retired and compromised keys included).
/// Recorded in `ADMISSION_KEYS` once accepted (`record_admission_key`).
pub fn validate_admission_key(deps: &DepsMut, pubkey: &HexBinary) -> Result<(), ContractError> {
    let key = parse_compressed_pubkey("admission_pubkey", pubkey.as_slice())?;
    if !pubkey_on_curve(deps.api, &key) {
        return Err(ContractError::BadPubkey {
            field: "admission_pubkey".to_string(),
        });
    }
    if let Some(key_id) = SIGNER_PUBKEY_INDEX.may_load(deps.storage, key.as_slice())? {
        return Err(ContractError::InvalidParams {
            reason: format!("the join-admission key cannot be settlement signer key {key_id}"),
        });
    }
    Ok(())
}

/// Remembers an accepted admission key for good (first time set is kept).
pub fn record_admission_key(
    deps: &mut DepsMut,
    now: Timestamp,
    pubkey: &HexBinary,
) -> Result<(), ContractError> {
    if !ADMISSION_KEYS.has(deps.storage, pubkey.as_slice()) {
        ADMISSION_KEYS.save(deps.storage, pubkey.as_slice(), &now)?;
    }
    Ok(())
}

/// Replaces the join-admission key. Immediate: an admission signed under the
/// previous key no longer verifies, so a `Join` still in flight fails (moving no
/// funds) and its player asks the server for a new admission. Seats already
/// taken, and every other game fact, are untouched.
pub fn set_admission_key(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    pubkey: HexBinary,
) -> Result<Response, ContractError> {
    let mut config = admin_guard(&deps, &info)?;
    validate_admission_key(&deps, &pubkey)?;
    record_admission_key(&mut deps, env.block.time, &pubkey)?;
    config.admission_pubkey = pubkey;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "set_admission_key")
        .add_attribute("admission_pubkey", config.admission_pubkey.to_hex()))
}
