//! START and the signed-payload path: Checkpoint, Settle, Consent, Finalize.

use cosmwasm_std::{Deps, DepsMut, Env, HexBinary, MessageInfo, Response, Uint128, Uint64};

use crate::crypto::{
    roster_hash, settle_digest, settlement_domain, verify_settlement_signature, DomainInputs,
};
use crate::error::ContractError;
use crate::helpers::{
    active_signer_key, add_secs, check_payload_for_game, full_mask, load_game, nonpayable, pay_out,
    payload_record, require_not_paused, require_state, save_game, seat_bit, stored_consent_digest,
    verify_seat_signatures,
};
use crate::msg::{SeatSignature, SettlementPayloadV1};
use crate::payload::{fixed_bytes, Payload, PayloadUse};
use crate::payout::bond_amount;
use crate::state::{
    CheckpointRecord, GameState, PayloadRecord, Route, SettlementRecord, SettlementSource,
    CHECKPOINTS, CONFIG,
};

/// Operator only, FUNDED, not paused. The operator's roster hash must equal the
/// hash of the on-chain roster; the domain, bond and start times are frozen.
pub fn start(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    provided_roster_hash: HexBinary,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::Funded])?;
    if info.sender != config.operator {
        return Err(ContractError::Unauthorized {
            role: "operator".to_string(),
        });
    }
    require_not_paused(&config)?;
    let provided = fixed_bytes::<32>("roster_hash", &provided_roster_hash)?;
    let wallets: Vec<&str> = game.seats.iter().map(|s| s.wallet.as_str()).collect();
    let computed = roster_hash(&wallets)?;
    if computed != provided {
        return Err(ContractError::RosterHashMismatch {});
    }
    let variants_digest = fixed_bytes::<32>("variants_digest", &game.variants_digest)?;
    let domain = settlement_domain(&DomainInputs {
        chain_id: &env.block.chain_id,
        contract_addr: env.contract.address.as_str(),
        chain_game_id,
        roster_hash: computed,
        rules_engine_version: game.rules_engine_version,
        variants_digest,
        ante_gross: game.ante_gross.u128(),
        mode: game.mode.as_byte(),
    })?;
    let bond = bond_amount(game.ante_net, game.terms.bond_bps, game.terms.bond_floor)?;
    let now = env.block.time;
    game.roster_hash = Some(HexBinary::from(computed.as_slice()));
    game.domain = Some(HexBinary::from(domain.as_slice()));
    game.bond = Some(bond);
    game.started_at = Some(now);
    game.last_activity = Some(now);
    game.state = GameState::InProgress;
    save_game(deps.storage, &game)?;
    Ok(Response::new()
        .add_attribute("action", "start")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("roster_hash", HexBinary::from(computed.as_slice()).to_hex())
        .add_attribute("domain", HexBinary::from(domain.as_slice()).to_hex())
        .add_attribute("bond", bond)
        .add_attribute("pool", game.pool)
        .add_attribute("state", game.state.as_str()))
}

/// Converts, validates against the game and verifies the settlement signature.
/// Returns the payload and its SETTLE digest.
fn accept_signed_payload(
    deps: Deps,
    game: &crate::state::Game,
    wire: &SettlementPayloadV1,
    signature: &HexBinary,
    usage: PayloadUse,
) -> Result<(Payload, [u8; 32]), ContractError> {
    let payload = Payload::try_from(wire)?;
    check_payload_for_game(game, &payload, usage)?;
    let key = active_signer_key(deps.storage, payload.signer_key_id)?;
    let digest = settle_digest(&payload.encode()?);
    verify_settlement_signature(
        deps.api,
        &digest,
        signature.as_slice(),
        key.pubkey.as_slice(),
    )?;
    Ok((payload, digest))
}

/// Anyone may post a validly signed Checkpoint while IN_PROGRESS and not paused.
/// It supersedes older checkpoints by seq and refreshes `last_activity`.
pub fn checkpoint(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    wire: SettlementPayloadV1,
    signature: HexBinary,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::InProgress])?;
    require_not_paused(&config)?;
    let (payload, digest) = accept_signed_payload(
        deps.as_ref(),
        &game,
        &wire,
        &signature,
        PayloadUse::Checkpoint,
    )?;
    let now = env.block.time;
    let record = CheckpointRecord {
        payload: payload_record(&payload, &digest),
        accepted_at: now,
    };
    CHECKPOINTS.save(
        deps.storage,
        (chain_game_id, payload.signer_key_id),
        &record,
    )?;
    game.last_seq = Uint64::new(payload.seq);
    game.last_activity = Some(now);
    save_game(deps.storage, &game)?;
    Ok(Response::new()
        .add_attribute("action", "checkpoint")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("seq", payload.seq.to_string())
        .add_attribute("log_len", payload.log_len.to_string())
        .add_attribute("signer_key_id", payload.signer_key_id.to_string())
        .add_attribute(
            "payload_digest",
            HexBinary::from(digest.as_slice()).to_hex(),
        ))
}

/// Anyone may post a validly signed Terminal payload while IN_PROGRESS and not
/// paused. Every supplied consent must verify against the seat's current key;
/// if every seat consented the game settles now, otherwise the settlement is
/// stored and the challenge window starts.
pub fn settle(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    wire: SettlementPayloadV1,
    signature: HexBinary,
    consents: Vec<SeatSignature>,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::InProgress])?;
    require_not_paused(&config)?;
    let (payload, digest) =
        accept_signed_payload(deps.as_ref(), &game, &wire, &signature, PayloadUse::Settle)?;
    let domain = crate::helpers::game_domain(&game)?;
    let consent = crate::crypto::consent_digest(&domain, payload.seq, &digest);
    let mask = verify_seat_signatures(deps.api, &game, &consent, &consents, false)?;

    let now = env.block.time;
    let record: PayloadRecord = payload_record(&payload, &digest);
    let weights = record.settlement_weights.clone();
    game.settlement = Some(SettlementRecord {
        source: SettlementSource::TerminalPayload,
        payload: record,
        accepted_at: now,
        window_end: add_secs(now, game.terms.challenge_window_secs)?,
    });
    game.last_seq = Uint64::new(payload.seq);
    game.consent_bitmap = mask;

    let mut response = Response::new()
        .add_attribute("action", "settle")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("seq", payload.seq.to_string())
        .add_attribute("reason", payload.reason.to_string())
        .add_attribute("signer_key_id", payload.signer_key_id.to_string())
        .add_attribute(
            "payload_digest",
            HexBinary::from(digest.as_slice()).to_hex(),
        )
        .add_attribute("consent_bitmap", mask.to_string());
    if mask == full_mask(game.seats.len())? {
        let pool = game.pool;
        let msgs = pay_out(
            &mut game,
            &weights,
            pool,
            Route::AllConsentsAtSettle,
            now,
            Uint128::zero(),
            Uint128::zero(),
        )?;
        response = response.add_messages(msgs);
    } else {
        game.state = GameState::Settleable;
    }
    save_game(deps.storage, &game)?;
    Ok(response.add_attribute("state", game.state.as_str()))
}

/// Anyone may add one seat's consent to the stored settlement while SETTLEABLE
/// and not paused (it can pay out). Idempotent per seat; the last missing
/// consent settles the game.
pub fn consent(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
    seat_index: u8,
    signature: HexBinary,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::Settleable])?;
    require_not_paused(&config)?;
    let digest = stored_consent_digest(&game)?;
    let mask = verify_seat_signatures(
        deps.api,
        &game,
        &digest,
        &[SeatSignature {
            seat_index,
            signature,
        }],
        false,
    )?;
    let already = game.consent_bitmap & seat_bit(usize::from(seat_index))? != 0;
    game.consent_bitmap |= mask;
    let now = env.block.time;
    let mut response = Response::new()
        .add_attribute("action", "consent")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("chain_seat_index", seat_index.to_string())
        .add_attribute("already_consented", already.to_string())
        .add_attribute("consent_bitmap", game.consent_bitmap.to_string());
    if game.consent_bitmap == full_mask(game.seats.len())? {
        let weights = game
            .settlement
            .as_ref()
            .map(|s| s.payload.settlement_weights.clone())
            .ok_or_else(|| ContractError::Invariant {
                reason: "no stored settlement".to_string(),
            })?;
        let pool = game.pool;
        let msgs = pay_out(
            &mut game,
            &weights,
            pool,
            Route::ConsentCompleted,
            now,
            Uint128::zero(),
            Uint128::zero(),
        )?;
        response = response.add_messages(msgs);
    }
    save_game(deps.storage, &game)?;
    Ok(response.add_attribute("state", game.state.as_str()))
}

/// Anyone, SETTLEABLE, once block time reaches the window end, not paused.
pub fn finalize(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    chain_game_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    let mut game = load_game(deps.storage, chain_game_id)?;
    require_state(&game, &[GameState::Settleable])?;
    require_not_paused(&config)?;
    let settlement = game
        .settlement
        .as_ref()
        .ok_or_else(|| ContractError::Invariant {
            reason: "no stored settlement".to_string(),
        })?;
    let now = env.block.time;
    if now < settlement.window_end {
        return Err(ContractError::WindowOpen {
            until: settlement.window_end,
        });
    }
    let weights = settlement.payload.settlement_weights.clone();
    let pool = game.pool;
    let msgs = pay_out(
        &mut game,
        &weights,
        pool,
        Route::Finalized,
        now,
        Uint128::zero(),
        Uint128::zero(),
    )?;
    save_game(deps.storage, &game)?;
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "finalize")
        .add_attribute("chain_game_id", chain_game_id.to_string())
        .add_attribute("state", game.state.as_str()))
}
