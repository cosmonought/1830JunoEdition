//! Entry points: instantiate, execute, query and migrate.

#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult};
use cw2::{get_contract_version, set_contract_version};

use crate::error::ContractError;
use crate::execute::{admin, dispute, funding, play};
use crate::helpers::nonpayable;
use crate::msg::{ExecuteMsg, InstantiateMsg, MigrateMsg, QueryMsg};
use crate::state::{Config, CONFIG, NEXT_GAME_ID, NEXT_SIGNER_KEY_ID};

/// cw2 contract name. `migrate` refuses any stored contract with another name,
/// so there is no upgrade path from the legacy gameplay contract (which has no
/// cw2 record at all).
pub const CONTRACT_NAME: &str = "crates.io:eighteen-cosmos-escrow";
pub const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = Config {
        admin: deps.api.addr_validate(&msg.admin)?,
        operator: deps.api.addr_validate(&msg.operator)?,
        resolver: deps.api.addr_validate(&msg.resolver)?,
        treasury: deps.api.addr_validate(&msg.treasury)?,
        denom: msg.denom,
        params: msg.params,
        paused: false,
    };
    admin::validate_denom(&config.denom)?;
    admin::validate_params(&config.params)?;
    admin::validate_treasury(&env, &config.treasury)?;
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    CONFIG.save(deps.storage, &config)?;
    NEXT_GAME_ID.save(deps.storage, &1)?;
    NEXT_SIGNER_KEY_ID.save(deps.storage, &1)?;
    let mut key_ids = Vec::with_capacity(msg.signer_keys.len());
    for pubkey in msg.signer_keys {
        key_ids.push(admin::register_signer_key(&mut deps, env.block.time, pubkey)?.to_string());
    }
    let mut response = Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("contract_name", CONTRACT_NAME)
        .add_attribute("contract_version", CONTRACT_VERSION)
        .add_attribute("admin", config.admin.as_str())
        .add_attribute("operator", config.operator.as_str())
        .add_attribute("resolver", config.resolver.as_str())
        .add_attribute("treasury", config.treasury.as_str())
        .add_attribute("denom", config.denom)
        .add_attribute("signer_key_count", key_ids.len().to_string());
    // wasmd rejects an empty attribute value, so the id list is only emitted
    // when there is one (instantiating with no signer keys is allowed).
    if !key_ids.is_empty() {
        response = response.add_attribute("signer_key_ids", key_ids.join(","));
    }
    Ok(response)
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::CreateGame {
            max_players,
            mode,
            rules_engine_version,
            variants_digest,
            consent_pubkey,
            join_ticket,
        } => funding::create_game(
            deps,
            env,
            info,
            max_players,
            mode,
            rules_engine_version,
            variants_digest,
            consent_pubkey,
            join_ticket,
        ),
        ExecuteMsg::Join {
            chain_game_id,
            consent_pubkey,
            join_ticket,
        } => funding::join(deps, env, info, chain_game_id, consent_pubkey, join_ticket),
        ExecuteMsg::Withdraw { chain_game_id } => funding::withdraw(deps, info, chain_game_id),
        ExecuteMsg::Cancel { chain_game_id } => funding::cancel(deps, env, info, chain_game_id),
        ExecuteMsg::SetConsentKey {
            chain_game_id,
            new_pubkey,
        } => funding::set_consent_key(deps, env, info, chain_game_id, new_pubkey),
        ExecuteMsg::Start {
            chain_game_id,
            roster_hash,
        } => play::start(deps, env, info, chain_game_id, roster_hash),
        ExecuteMsg::Checkpoint {
            chain_game_id,
            payload,
            signature,
        } => play::checkpoint(deps, env, info, chain_game_id, payload, signature),
        ExecuteMsg::Settle {
            chain_game_id,
            payload,
            signature,
            consents,
        } => play::settle(deps, env, info, chain_game_id, payload, signature, consents),
        ExecuteMsg::Consent {
            chain_game_id,
            seat_index,
            signature,
        } => play::consent(deps, env, info, chain_game_id, seat_index, signature),
        ExecuteMsg::Finalize { chain_game_id } => play::finalize(deps, env, info, chain_game_id),
        ExecuteMsg::Challenge {
            chain_game_id,
            evidence_hash,
        } => dispute::challenge(deps, env, info, chain_game_id, evidence_hash),
        ExecuteMsg::Resolve {
            chain_game_id,
            outcome,
        } => dispute::resolve(deps, env, info, chain_game_id, outcome),
        ExecuteMsg::AnnulByConsent {
            chain_game_id,
            consents,
        } => dispute::annul_by_consent(deps, env, info, chain_game_id, consents),
        ExecuteMsg::LivenessSettle { chain_game_id } => {
            dispute::liveness_settle(deps, env, info, chain_game_id)
        }
        ExecuteMsg::Pause {} => admin::pause(deps, info),
        ExecuteMsg::Unpause {} => admin::unpause(deps, info),
        ExecuteMsg::AddSignerKey { pubkey } => admin::add_signer_key(deps, env, info, pubkey),
        ExecuteMsg::RetireSignerKey {
            key_id,
            compromised,
        } => admin::retire_signer_key(deps, env, info, key_id, compromised),
        ExecuteMsg::SetOperator { operator } => admin::set_operator(deps, info, operator),
        ExecuteMsg::SetResolver { resolver } => admin::set_resolver(deps, info, resolver),
        ExecuteMsg::SetTreasury { treasury } => admin::set_treasury(deps, env, info, treasury),
        ExecuteMsg::SetParams { params } => admin::set_params(deps, info, params),
    }
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    crate::query::dispatch(deps, env, msg)
}

/// `major.minor.patch`, numeric parts only.
fn parse_version(version: &str) -> Result<(u64, u64, u64), ContractError> {
    let bad = || ContractError::BadContractVersion {
        version: version.to_string(),
    };
    let mut parts = version.split('.');
    let mut next = || -> Result<u64, ContractError> {
        parts
            .next()
            .ok_or_else(bad)?
            .parse::<u64>()
            .map_err(|_| bad())
    };
    let parsed = (next()?, next()?, next()?);
    if parts.next().is_some() {
        return Err(bad());
    }
    Ok(parsed)
}

/// Future escrow versions only. Refuses a contract that is not this escrow
/// contract (including the legacy gameplay contract) and any downgrade. There
/// are no state migrations for 1.x; a same-version migrate is a no-op.
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn migrate(deps: DepsMut, _env: Env, _msg: MigrateMsg) -> Result<Response, ContractError> {
    let stored = get_contract_version(deps.storage)?;
    if stored.contract != CONTRACT_NAME {
        return Err(ContractError::MigrateForeignContract {
            contract: stored.contract,
        });
    }
    let from = parse_version(&stored.version)?;
    let to = parse_version(CONTRACT_VERSION)?;
    if from > to {
        return Err(ContractError::MigrateDowngrade {
            from: stored.version,
            to: CONTRACT_VERSION.to_string(),
        });
    }
    // Explicit per-version state migrations belong here, keyed on `from`.
    // Never a reset.
    if from < to {
        set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    }
    Ok(Response::new()
        .add_attribute("action", "migrate")
        .add_attribute("from_version", stored.version)
        .add_attribute("to_version", CONTRACT_VERSION))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::GameParams;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::Uint128;

    #[test]
    fn the_treasury_cannot_be_the_contract_itself() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let params = GameParams {
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
        };
        let msg = InstantiateMsg {
            admin: "admin".to_string(),
            operator: "operator".to_string(),
            resolver: "resolver".to_string(),
            treasury: env.contract.address.to_string(),
            denom: "ujuno".to_string(),
            params,
            signer_keys: vec![],
        };
        let err = instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("admin", &[]),
            msg.clone(),
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::InvalidParams { .. }));
        let ok = InstantiateMsg {
            treasury: "treasury".to_string(),
            ..msg
        };
        instantiate(deps.as_mut(), env, mock_info("admin", &[]), ok).unwrap();
    }

    #[test]
    fn version_parsing() {
        assert_eq!(parse_version("1.0.0").unwrap(), (1, 0, 0));
        assert_eq!(parse_version("12.3.45").unwrap(), (12, 3, 45));
        assert!(parse_version("1.0").is_err());
        assert!(parse_version("1.0.0.0").is_err());
        assert!(parse_version("1.0.0-rc1").is_err());
        assert!(parse_version("").is_err());
        assert_eq!(parse_version(CONTRACT_VERSION).unwrap(), (1, 0, 0));
    }
}
