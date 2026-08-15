//! Public Company registry: seeds the fixed roster of classic 1830
//! railroad corporations into a game room, all unfloated, when the room is
//! created. See `auction.rs` for how the Baltimore & Ohio private company
//! floats its corresponding public company early and automatically, and
//! `trading.rs` / `market.rs` for the share-trading and price-grid
//! mechanics a floated `PublicCompany` participates in via its
//! `company_id` (used as the `protocol_id` in those modules' storage maps).
//!
//! Design notes:
//! 1. **The eight corporations.** Matches the physical 1830 game's fixed
//!    roster: Pennsylvania Railroad (PRR), New York Central (NYC),
//!    Canadian Pacific (CPR), Baltimore & Ohio (B&O), Chesapeake & Ohio
//!    (C&O), Erie (ERIE), New York, New Haven & Hartford (NNH), and Boston
//!    & Maine (B&M).
//! 2. **Unfloated by default.** Every seeded `PublicCompany` starts with
//!    `is_floated: false`, zero treasury, zero shares issued, and a
//!    placeholder `(0, 0)` market position -- no par value has been chosen
//!    and no shares exist yet. Flotation happens later: for B&O
//!    specifically, automatically and for free the moment its private
//!    company is won (see `auction::award_bo_president_share`); for every
//!    other corporation, automatically the moment ordinary Stock Round
//!    `BuyStock` purchases push its total real-player-owned stake to 60%
//!    or more (see `trading::execute_buy_stock`'s module doc comment #7),
//!    at which point its treasury is capitalized at 10x the price it was
//!    just bought at.

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
