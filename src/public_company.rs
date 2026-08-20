//! Public Company registry: seeds the fixed roster of eight 1830 corporations
//! into a room at creation, all unfloated -- PRR, NYC, CPR, B&O, C&O, ERIE, NNH
//! and B&M.
//!
//! Every seeded company starts with `is_floated: false`, zero treasury, zero
//! shares issued and a placeholder market position: no par has been chosen and no
//! shares exist yet.
//!
//! Flotation happens later, and by two different routes. The B&O floats
//! automatically and for free the moment its private company is won (see
//! `auction::award_bo_president_share`); every other corporation floats when
//! ordinary Stock Round purchases push its real-player-owned stake to 60% or
//! more, at which point its treasury is capitalized at 10x its par value.

use cosmwasm_std::{StdResult, Storage, Uint128};

use crate::state::{PublicCompany, PUBLIC_COMPANIES};

/// The fixed roster of public companies seeded into every new game room:
/// `(company_id, ticker)`. Company ids are stable identifiers reused
/// wherever a "protocol_id" appears in `market.rs`/`trading.rs`. Keep this
/// in sync with `auction::BO_PUBLIC_COMPANY_ID`, which hardcodes B&O's id.
pub const CORE_PUBLIC_COMPANIES: &[(u32, &str)] = &[
    (1, "PRR"),
    (2, "NYC"),
    (3, "CPR"),
    (4, "B&O"),
    (5, "C&O"),
    (6, "ERIE"),
    (7, "NNH"),
    (8, "B&M"),
];

/// Seeds `game_id` with the fixed set of `CORE_PUBLIC_COMPANIES`, all
/// unfloated. Called once, when a game room is created (see
/// `contract::execute_create_game_room`).
pub fn spawn_core_public_companies(storage: &mut dyn Storage, game_id: u64) -> StdResult<()> {
    for (company_id, ticker) in CORE_PUBLIC_COMPANIES.iter().copied() {
        let company = PublicCompany {
            company_id,
            ticker: ticker.to_string(),
            current_x: 0,
            current_y: 0,
            treasury: Uint128::zero(),
            is_floated: false,
            total_shares_issued: 0,
            // Step 4.5 Batch 2, item 4: no routes run yet.
            last_route_revenue: Uint128::zero(),
        };
        PUBLIC_COMPANIES.save(storage, (game_id, company_id), &company)?;
    }
    Ok(())
}
