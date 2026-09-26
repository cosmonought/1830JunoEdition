//! Read-only queries. Nothing here is secret: join tickets are server
//! commitments (hashes), consent keys are public keys, signatures are never
//! stored.

use cosmwasm_std::{
    to_json_binary, Binary, Deps, Env, Order, StdError, StdResult, Timestamp, Uint64,
};
use cw_storage_plus::Bound;

use crate::contract::{CONTRACT_NAME, CONTRACT_VERSION};
use crate::error::ContractError;
use crate::helpers::{add_secs, best_checkpoint, load_game, trusted_seq};
use crate::msg::{
    CheckpointView, CheckpointsResponse, ConfigResponse, GameDeadlines, GameResponse, GameSummary,
    GamesResponse, QueryMsg, SeatView, SeatsResponse, SettlementPreviewResponse, SignerKeyResponse,
    SignerKeysResponse,
};
use crate::payout::proportional_split;
use crate::state::{
    Game, GameState, CHECKPOINTS, CONFIG, GAMES, NEXT_GAME_ID, NEXT_SIGNER_KEY_ID, SIGNER_KEYS,
};

const DEFAULT_LIMIT: u32 = 10;
const MAX_LIMIT: u32 = 30;

fn std_err(err: ContractError) -> StdError {
    match err {
        ContractError::Std(e) => e,
        other => StdError::generic_err(other.to_string()),
    }
}

pub fn dispatch(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&config(deps)?),
        QueryMsg::Game { chain_game_id } => to_json_binary(&game(deps, chain_game_id)?),
        QueryMsg::Games { start_after, limit } => to_json_binary(&games(deps, start_after, limit)?),
        QueryMsg::Seats { chain_game_id } => to_json_binary(&seats(deps, chain_game_id)?),
        QueryMsg::Checkpoints { chain_game_id } => {
            to_json_binary(&checkpoints(deps, chain_game_id)?)
        }
        QueryMsg::SignerKey { key_id } => to_json_binary(&SignerKeyResponse {
            key: SIGNER_KEYS.load(deps.storage, key_id)?,
        }),
        QueryMsg::SignerKeys { start_after, limit } => {
            let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
            let keys = SIGNER_KEYS
                .range(
                    deps.storage,
                    start_after.map(Bound::exclusive),
                    None,
                    Order::Ascending,
                )
                .take(limit)
                .map(|item| item.map(|(_, key)| key))
                .collect::<StdResult<Vec<_>>>()?;
            to_json_binary(&SignerKeysResponse { keys })
        }
        QueryMsg::SettlementPreview { chain_game_id } => {
            to_json_binary(&settlement_preview(deps, chain_game_id)?)
        }
    }
}

fn config(deps: Deps) -> StdResult<ConfigResponse> {
    Ok(ConfigResponse {
        config: CONFIG.load(deps.storage)?,
        next_chain_game_id: NEXT_GAME_ID.load(deps.storage)?,
        next_signer_key_id: NEXT_SIGNER_KEY_ID.load(deps.storage)?,
        contract_name: CONTRACT_NAME.to_string(),
        contract_version: CONTRACT_VERSION.to_string(),
    })
}

fn deadlines(game: &Game) -> GameDeadlines {
    let liveness_available_at = match (game.state, game.started_at, &game.settlement) {
        (GameState::InProgress, Some(started), _) => {
            let active = game.last_activity.unwrap_or(started);
            let reference: Timestamp = if active > started { active } else { started };
            add_secs(reference, game.terms.liveness_window_secs).ok()
        }
        (GameState::Settleable, _, Some(settlement)) => {
            add_secs(settlement.window_end, game.terms.liveness_window_secs).ok()
        }
        _ => None,
    };
    let challenge_window_end = match (game.state, &game.settlement) {
        (GameState::Settleable, Some(settlement)) => Some(settlement.window_end),
        _ => None,
    };
    let resolver_timeout_at = match (game.state, &game.dispute) {
        (GameState::Disputed, Some(dispute)) => {
            add_secs(dispute.disputed_at, game.terms.resolver_timeout_secs).ok()
        }
        _ => None,
    };
    GameDeadlines {
        funding_deadline: game.funding_deadline,
        liveness_available_at,
        challenge_window_end,
        resolver_timeout_at,
    }
}

fn game(deps: Deps, chain_game_id: u64) -> StdResult<GameResponse> {
    let game = load_game(deps.storage, chain_game_id).map_err(std_err)?;
    let latest_checkpoint = best_checkpoint(deps.storage, chain_game_id, false).map_err(std_err)?;
    let trusted_seq = Uint64::new(trusted_seq(deps.storage, &game).map_err(std_err)?);
    let paused = CONFIG.load(deps.storage)?.paused;
    let deadlines = deadlines(&game);
    Ok(GameResponse {
        game,
        paused,
        latest_checkpoint,
        trusted_seq,
        deadlines,
    })
}

fn games(deps: Deps, start_after: Option<u64>, limit: Option<u32>) -> StdResult<GamesResponse> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
    let games = GAMES
        .range(
            deps.storage,
            start_after.map(Bound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit)
        .map(|item| {
            item.map(|(_, g)| GameSummary {
                chain_game_id: g.chain_game_id,
                state: g.state,
                creator: g.creator.to_string(),
                mode: g.mode,
                max_players: g.max_players,
                seats_filled: u8::try_from(g.seats.len()).unwrap_or(u8::MAX),
                ante_gross: g.ante_gross,
                pool: g.pool,
            })
        })
        .collect::<StdResult<Vec<_>>>()?;
    Ok(GamesResponse { games })
}

fn seats(deps: Deps, chain_game_id: u64) -> StdResult<SeatsResponse> {
    let game = load_game(deps.storage, chain_game_id).map_err(std_err)?;
    let consent_open = matches!(
        game.state,
        GameState::Settleable | GameState::Settled | GameState::Disputed
    );
    let seats = game
        .seats
        .iter()
        .enumerate()
        .map(|(i, seat)| SeatView {
            chain_seat_index: u8::try_from(i).unwrap_or(u8::MAX),
            seat: seat.clone(),
            consented: consent_open
                && u32::try_from(i)
                    .ok()
                    .and_then(|shift| 1u8.checked_shl(shift))
                    .is_some_and(|bit| game.consent_bitmap & bit != 0),
        })
        .collect();
    Ok(SeatsResponse { seats })
}

fn checkpoints(deps: Deps, chain_game_id: u64) -> StdResult<CheckpointsResponse> {
    load_game(deps.storage, chain_game_id).map_err(std_err)?;
    let mut views = Vec::new();
    for item in CHECKPOINTS
        .prefix(chain_game_id)
        .range(deps.storage, None, None, Order::Ascending)
    {
        let (key_id, checkpoint) = item?;
        let key = SIGNER_KEYS.may_load(deps.storage, key_id)?;
        views.push(CheckpointView {
            checkpoint,
            signer_key_retired: key.as_ref().is_none_or(|k| k.retired_at.is_some()),
            signer_key_compromised: key.as_ref().is_none_or(|k| k.compromised),
        });
    }
    views.sort_by_key(|v| std::cmp::Reverse(v.checkpoint.payload.seq));
    let liveness_candidate_seq = best_checkpoint(deps.storage, chain_game_id, true)
        .map_err(std_err)?
        .map(|c| c.payload.seq);
    Ok(CheckpointsResponse {
        checkpoints: views,
        liveness_candidate_seq,
    })
}

fn settlement_preview(deps: Deps, chain_game_id: u64) -> StdResult<SettlementPreviewResponse> {
    let game = load_game(deps.storage, chain_game_id).map_err(std_err)?;
    let settlement = game
        .settlement
        .as_ref()
        .ok_or_else(|| StdError::generic_err("no stored settlement"))?;
    let weights = settlement.payload.settlement_weights.clone();
    let split = proportional_split(game.pool, &weights).map_err(std_err)?;
    Ok(SettlementPreviewResponse {
        pool: game.pool,
        settlement_weights: weights,
        payouts: split.amounts,
        dust: split.dust,
    })
}
