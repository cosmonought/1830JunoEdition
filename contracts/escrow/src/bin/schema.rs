//! Writes the JSON schema of the contract ABI to `./schema`.
//! Run from `contracts/escrow`: `cargo run --bin schema`.

use cosmwasm_schema::write_api;
use eighteen_cosmos_escrow::msg::{ExecuteMsg, InstantiateMsg, MigrateMsg, QueryMsg};

fn main() {
    write_api! {
        instantiate: InstantiateMsg,
        execute: ExecuteMsg,
        query: QueryMsg,
        migrate: MigrateMsg,
    }
}
