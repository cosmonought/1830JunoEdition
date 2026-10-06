//! FUNDING / FUNDED: deposits, withdrawals, cancellation and consent keys.

use cosmwasm_std::{
    to_json_binary, Addr, Api, DepsMut, Env, HexBinary, MessageInfo, Response, Uint128, Uint64,
};

use crate::crypto::{check_signature, join_admission_digest, parse_compressed_pubkey};
use crate::error::ContractError;
use crate::helpers::{
    add_secs, load_game, nonpayable, one_coin, refund_all, require_not_paused, require_seated,
    require_state, require_unique_consent_key, save_game, seat_bit, seat_index_of, send,
    MAX_PLAYERS, MIN_PLAYERS,
};
use crate::msg::{CreateGameResponse, JoinAdmission};
use crate::payload::fixed_bytes;
use crate::payout::{bond_amount, subsidy_cut};
use crate::state::{
    Game, GamePolicy, GameState, GameTerms, Mode, Route, Seat, CONFIG, NEXT_GAME_ID,
};

#[allow(clippy::too_many_arguments)]
pub fn create_game(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    max_players: u8,
    mode: Mode,
    rules_engine_version: u32,
    variants_digest: HexBinary,
    consent_pubkey: HexBinary,
    join_ticket: HexBinary,
    no_deadline: bool,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    require_not_paused(&config)?;
    if !(MIN_PLAYERS..=MAX_PLAYERS).contains(&max_players) {
        return Err(ContractError::BadMaxPlayers { got: max_players });
    }
    // Escrow 2.1.0: every game this code creates carries an exit policy; a
    // Live table always has an action deadline.
    let policy = match (mode, no_deadline) {
        (_, false) => GamePolicy::Timed,
        (Mode::Async, true) => GamePolicy::NoDeadline,
        (Mode::Live, true) => return Err(ContractError::NoDeadlineNeedsAsync {}),
    };
    fixed_bytes::<32>("variants_digest", &variants_digest)?;
    parse_compressed_pubkey("consent_pubkey", consent_pubkey.as_slice())?;
    fixed_bytes::<32>("join_ticket", &join_ticket)?;

    let gross = one_coin(&info, &config.denom)?;
    let params = &config.params;
    if gross < params.min_ante {
        return Err(ContractError::BelowMinAnte {
            min: params.min_ante,
            got: gross,
        });
    }
    let subsidy = subsidy_cut(gross, params.subsidy_bps)?;
    let net = gross.checked_sub(subsidy)?;
    // The bond is frozen at Start from these terms; refuse a game whose bond
    // could not be represented, so Start can never fail on arithmetic.
    bond_amount(net, params.bond_bps, params.bond_floor)?;

    let (challenge_window_secs, funding_period_secs) = match mode {
        Mode::Live => (
            params.challenge_window_live_secs,
            params.funding_period_live_secs,
        ),
        Mode::Async => (
            params.challenge_window_async_secs,
            params.funding_period_async_secs,
        ),
    };
    let now = env.block.time;
    let funding_deadline = add_secs(now, funding_period_secs)?;

    let chain_game_id = NEXT_GAME_ID.load(deps.storage)?;
    let next = chain_game_id
        .checked_add(1)
        .ok_or(ContractError::Overflow {})?;
    NEXT_GAME_ID.save(deps.storage, &next)?;

    let terms = GameTerms {
        subsidy_bps: params.subsidy_bps,
        bond_bps: params.bond_bps,
        bond_floor: params.bond_floor,
        challenge_window_secs,
        liveness_window_secs: params.liveness_window_secs,
        resolver_timeout_secs: params.resolver_timeout_secs,
        treasury: config.treasury.clone(),
        policy: Some(policy),
    };
    let game = Game {
        chain_game_id,
        state: GameState::Funding,
        creator: info.sender.clone(),
        max_players,
        mode,
        rules_engine_version,
        variants_digest,
        denom: config.denom.clone(),
        ante_gross: gross,
        subsidy_per_seat: subsidy,
        ante_net: net,
        terms,
        created_at: now,
        funding_deadline,
        pool: net,
        seats: vec![Seat {
            wallet: info.sender.clone(),
            consent_pubkey,
            consent_key_rotated_at: None,
            join_ticket,
            gross_deposit: gross,
            subsidy_paid: subsidy,
            net_deposit: net,
            joined_at: now,
        }],
        roster_hash: None,
        domain: None,
        bond: None,
        resolver: None,
        started_at: None,
        last_activity: None,
        last_seq: Uint64::zero(),
        settlement: None,
        consent_bitmap: 0,
        dispute: None,
        outcome: None,
        review_request: None,
    };
    save_game(deps.storage, &game)?;

    let mut response = Response::new()
        .add_attribute("action", "create_game")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("creator", info.sender.as_str())
        .add_attribute("chain_seat_index", "0")
        .add_attribute("max_players", max_players.to_string())
        .add_attribute("ante_gross", gross)
        .add_attribute("subsidy", subsidy)
        .add_attribute("ante_net", net)
        .add_attribute("policy", policy.as_str())
        .add_attribute("state", game.state.as_str())
        .set_data(to_json_binary(&CreateGameResponse { chain_game_id })?);
    if let Some(msg) = send(&game.terms.treasury, subsidy, &game.denom) {
        response = response.add_message(msg);
    }
    Ok(response)
}

/// The admission key's signature authorizes `sender` (the transaction's own
/// signer) to join `chain_game_id` of this contract on this chain with
/// `join_ticket`, and block time is before its expiry. Every signature fault
/// (length, high-s, wrong digest, wrong key) is the same `InvalidAdmission`.
fn verify_join_admission(
    api: &dyn Api,
    env: &Env,
    admission_pubkey: &HexBinary,
    chain_game_id: u64,
    sender: &Addr,
    join_ticket: &[u8; 32],
    admission: &JoinAdmission,
) -> Result<(), ContractError> {
    let expires_at = admission.expires_at.u64();
    if env.block.time.seconds() >= expires_at {
        return Err(ContractError::AdmissionExpired { expires_at });
    }
    let digest = join_admission_digest(
        &env.block.chain_id,
        env.contract.address.as_str(),
        chain_game_id,
        sender.as_str(),
        join_ticket,
        expires_at,
    )?;
    check_signature(
        api,
        &digest,
        admission.signature.as_slice(),
        admission_pubkey.as_slice(),
    )
    .map_err(|_| ContractError::InvalidAdmission {})
}

/// Takes the next seat. Everything is checked before the seat is written: the
/// game's state, the sender's absence from the roster, pause, deadline, room,
/// the consent key, the ticket's shape, then the ADMISSION (which binds the
/// sender, so neither a copied ticket nor a copied admission seats anyone
/// else), then the exact ante.
#[allow(clippy::too_many_arguments)]
pub fn join(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    consent_pubkey: HexBinary,
    join_ticket: HexBinary,
    admission: JoinAdmission,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::Funding])?;
    if seat_index_of(&game, &info.sender).is_some() {
        return Err(ContractError::AlreadyJoined { chain_game_id });
    }
    require_not_paused(&config)?;
    let now = env.block.time;
    if now >= game.funding_deadline {
        return Err(ContractError::FundingClosed {});
    }
    if game.seats.len() >= usize::from(game.max_players) {
        return Err(ContractError::GameFull {});
    }
    parse_compressed_pubkey("consent_pubkey", consent_pubkey.as_slice())?;
    require_unique_consent_key(&game, &consent_pubkey, None)?;
    let ticket = fixed_bytes::<32>("join_ticket", &join_ticket)?;
    verify_join_admission(
        deps.api,
        &env,
        &config.admission_pubkey,
        chain_game_id,
        &info.sender,
        &ticket,
        &admission,
    )?;

    let gross = one_coin(&info, &game.denom)?;
    if gross != game.ante_gross {
        return Err(ContractError::WrongAnte {
            expected: game.ante_gross,
            got: gross,
        });
    }
    let subsidy = subsidy_cut(gross, game.terms.subsidy_bps)?;
    let net = gross.checked_sub(subsidy)?;
    if subsidy != game.subsidy_per_seat || net != game.ante_net {
        return Err(ContractError::Invariant {
            reason: "deposit split differs from the creator's".to_string(),
        });
    }
    let chain_seat_index = game.seats.len();
    game.seats.push(Seat {
        wallet: info.sender.clone(),
        consent_pubkey,
        consent_key_rotated_at: None,
        join_ticket,
        gross_deposit: gross,
        subsidy_paid: subsidy,
        net_deposit: net,
        joined_at: now,
    });
    game.pool = game.pool.checked_add(net)?;
    if game.seats.len() == usize::from(game.max_players) {
        game.state = GameState::Funded;
    }
    save_game(deps.storage, &game)?;

    let mut response = Response::new()
        .add_attribute("action", "join")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("wallet", info.sender.as_str())
        .add_attribute("chain_seat_index", chain_seat_index.to_string())
        .add_attribute("subsidy", subsidy)
        .add_attribute("ante_net", net)
        .add_attribute("state", game.state.as_str());
    if let Some(msg) = send(&game.terms.treasury, subsidy, &game.denom) {
        response = response.add_message(msg);
    }
    Ok(response)
}

/// A seated wallet leaves before Start: its seat is removed (later seats move
/// up one index; indices are only frozen at Start) and its own net ante is
/// returned. The subsidy is not clawed back. Works while paused.
pub fn withdraw(
    deps: DepsMut,
    info: MessageInfo,
    chain_game_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::Funding, GameState::Funded])?;
    let index = require_seated(&game, &info.sender)?;
    let seat = game.seats.remove(index);
    game.pool = game.pool.checked_sub(seat.net_deposit)?;
    if game.state == GameState::Funded {
        game.state = GameState::Funding;
    }
    save_game(deps.storage, &game)?;

    let mut response = Response::new()
        .add_attribute("action", "withdraw")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("wallet", seat.wallet.as_str())
        .add_attribute("refund", seat.net_deposit)
        .add_attribute("state", game.state.as_str());
    if let Some(msg) = send(&seat.wallet, seat.net_deposit, &game.denom) {
        response = response.add_message(msg);
    }
    Ok(response)
}

/// Before Start: the creator at any time, anyone from the funding deadline on.
/// Every seat's net deposit is refunded. Works while paused.
pub fn cancel(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::Funding, GameState::Funded])?;
    let now = env.block.time;
    let route = if info.sender == game.creator {
        Route::CreatorCancel
    } else if now >= game.funding_deadline {
        Route::DeadlineCancel
    } else {
        return Err(ContractError::Unauthorized {
            role: "creator (or anyone after the funding deadline)".to_string(),
        });
    };
    let msgs = refund_all(&mut game, GameState::Cancelled, route, now, Uint128::zero())?;
    save_game(deps.storage, &game)?;
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "cancel")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("by", info.sender.as_str())
        .add_attribute("state", game.state.as_str()))
}

/// The seat's own wallet replaces its consent key. Allowed in FUNDING, FUNDED,
/// IN_PROGRESS and SETTLEABLE; works while paused. Setting the current key again
/// changes nothing; another seat's current key is refused. A real rotation also
/// withdraws the seat's recorded consent to the stored settlement: a consent
/// counts only while the key that gave it is the seat's current key, so a key
/// that consented for one seat cannot move to another seat and count again.
pub fn set_consent_key(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    new_pubkey: HexBinary,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(
        &game,
        &[
            GameState::Funding,
            GameState::Funded,
            GameState::InProgress,
            GameState::Settleable,
        ],
    )?;
    let index = require_seated(&game, &info.sender)?;
    parse_compressed_pubkey("new_pubkey", new_pubkey.as_slice())?;
    require_unique_consent_key(&game, &new_pubkey, Some(index))?;
    let bit = seat_bit(index)?;
    let seat = game
        .seats
        .get_mut(index)
        .ok_or_else(|| ContractError::Invariant {
            reason: "seat index".to_string(),
        })?;
    let changed = seat.consent_pubkey != new_pubkey;
    let mut consent_withdrawn = false;
    if changed {
        seat.consent_pubkey = new_pubkey;
        seat.consent_key_rotated_at = Some(env.block.time);
        consent_withdrawn = game.consent_bitmap & bit != 0;
        game.consent_bitmap &= !bit;
        save_game(deps.storage, &game)?;
    }
    Ok(Response::new()
        .add_attribute("action", "set_consent_key")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("chain_seat_index", index.to_string())
        .add_attribute("changed", changed.to_string())
        .add_attribute("consent_withdrawn", consent_withdrawn.to_string()))
}
