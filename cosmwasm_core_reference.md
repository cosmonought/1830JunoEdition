# CosmWasm Core Implementation Reference
This document serves as the foundational development reference for writing secure, deterministic CosmWasm smart contracts.

## 1. Project Configuration (Cargo.toml)
```toml
[package]
name = "juno-18xx-game"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
cosmwasm-std = "1.5.0"
cosmwasm-schema = "1.5.0"
cw-storage-plus = "1.2.0"
cw2 = "1.1.2"
schemars = "0.8.16"
serde = { version = "1.0.197", default-features = false, features = ["derive"] }
thiserror = "1.0.58"
```

## 2. Interface Definition (msg.rs)
```rust
use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;

#[cw_serde]
pub struct InstantiateMsg {
    pub game_id: String,
    pub admin: String,
    pub native_denom: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    BuyShare { company_id: String, percentage: u8 },
    PayoutDividends { company_id: String, amount: Uint128 },
    WithholdRevenues { company_id: String },
    LayTile { q: i16, r: i16, tile_id: u32, rotation: u8 },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(GameStateResponse)]
    GetGameState {},
    #[returns(CompanyResponse)]
    GetCompany { id: String },
}

#[cw_serde]
pub struct GameStateResponse {
    pub current_round: String,
    pub active_player: String,
}

#[cw_serde]
pub struct CompanyResponse {
    pub id: String,
    pub cash: Uint128,
    pub share_price: Uint128,
}
```

## 3. Storage Layer (state.rs)
```rust
use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    pub native_denom: String,
}

#[cw_serde]
pub struct HexTile {
    pub tile_id: u32,
    pub rotation: u8,
    pub connections: u8, // Packed bitmask representation
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const SHARE_OWNERSHIP: Map<(&str, &Addr), u8> = Map::new("shares"); // (CompanyId, PlayerAddress) -> %
pub const HEX_GRID: Map<(i16, i16), HexTile> = Map::new("grid"); // (q, r) -> Tile
```

## 4. Contract Logic Entrypoints (contract.rs)
```rust
#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult, to_json_binary};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::state::{Config, CONFIG};

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> StdResult<Response> {
    let config = Config {
        admin: deps.api.addr_validate(&msg.admin)?,
        native_denom: msg.native_denom,
    };
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(
    _deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: ExecuteMsg,
) -> StdResult<Response> {
    // Execution handlers routing logic
    Ok(Response::default())
}

#[entry_point]
pub fn query(_deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetGameState {} => Ok(to_json_binary(&"{}")?),
        QueryMsg::GetCompany { .. } => Ok(to_json_binary(&"{}")?),
    }
}
```