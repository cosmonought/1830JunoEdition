//! Read-only Game State Queries: `QueryMsg` handlers that assemble a game
//! room's live state into clean, JSON-serializable response structs, plus a
//! Markdown/ASCII map renderer for local inspection. See `contract::query`
//! for the CosmWasm `query` entry point that dispatches into this module,
//! and `msg.rs` for each `QueryMsg` variant's own doc comment.
//!
//! Design notes:
//! 1. **Errors are plain `StdError`.** Unlike every `execute_*` module in
//!    this contract, these handlers return `cosmwasm_std::StdResult<T>`
//!    directly rather than a dedicated `thiserror` enum -- this matches the
//!    CosmWasm convention that a contract's `query` entry point always
//!    returns `StdResult<Binary>`, and none of these handlers have
//!    multiple distinct failure modes worth a typed enum for (only "the
//!    requested game room doesn't exist," surfaced via
//!    `StdError::generic_err` from `load_session`). Where a helper from
//!    another module returns its own error type (e.g.
//!    `market::MarketError`), it's either converted with
//!    `.map_err(|e| StdError::generic_err(e.to_string()))` or, for a purely
//!    cosmetic lookup, downgraded to `None` via `.ok()` -- see design note
//!    #3.
//! 2. **"Ownership registries."** `GameStateResponse` reports every
//!    registered player's cash, and, per public/private company: its
//!    treasury, floated status, par value, President, IPO/Bank pool
//!    percentages, and every player's nonzero share holding. Player shares
//!    at exactly `0%` are omitted from `player_holdings` (matching this
//!    contract's existing convention elsewhere that an absent/zero holding
//!    means "no position") rather than listing every registered player
//!    against every company.
//! 3. **`GetMarketGrid` includes every core public company, not just
//!    floated ones.** `market::initialize_game_market` seeds a market
//!    position for all eight `CORE_PUBLIC_COMPANIES` the moment a room is
//!    created (see that function's doc comment), so "the active coordinate
//!    positions of all company stock tokens" is read literally here: every
//!    company always has *a* token position from genesis, whether or not
//!    it has floated. `MarketPositionEntry::price` is `None` only in the
//!    defensive case where a position was somehow recorded but its
//!    `MARKET_GRID` cell isn't seeded -- shouldn't happen after
//!    `contract::instantiate`'s `market::seed_default_price_grid`, but a
//!    query handler should never hard-fail an entire response over one
//!    company's cosmetic price lookup.
//! 4. **`print_markdown_map` cannot literally "print to the terminal" from
//!    inside a deployed contract.** CosmWasm's Wasm execution sandbox has
//!    no stdout, no filesystem, and no host import for `println!`-style
//!    I/O -- a smart contract can only ever *return* data to whoever
//!    queried it; there is no way for on-chain code to write to anyone's
//!    terminal. `print_markdown_map` therefore builds and returns the
//!    rendered Markdown/ASCII `String`; `QueryMsg::GetMapGridMarkdown`
//!    exposes it as an ordinary query response. The actual "print to a
//!    terminal" step happens off-chain, in whatever queried it -- a CLI
//!    script piping `wasmd query wasm contract-state smart ...` through a
//!    formatter, a test calling this function directly with
//!    `cargo test -- --nocapture` (see `tests.rs`), or a frontend. This
//!    module's own tests demonstrate exactly that off-chain usage.
//! 5. **The ASCII sketch is an approximation, not true hex tiling.**
//!    `render_ascii_grid` plots `(q, r)` axial coordinates directly onto a
//!    plain rectangular character grid (columns by `q`, rows by `r`)
//!    rather than a geometrically accurate offset hex rendering -- good
//!    enough to eyeball where track has been laid and whether the three
//!    landmark cities are connected, not a substitute for a real hex-grid
//!    renderer. Its bounding box spans every laid tile's coordinate plus
//!    all three `LANDMARK_HEXES` (so a city always shows up, even before
//!    anyone has laid its hub tile) -- a single tile laid very far from
//!    everything else will produce a correspondingly large, mostly-empty
//!    sketch, which is an accepted characteristic of a bounding-box
//!    rendering rather than a bug.
//! 6. **`GetLegalTilePlacements` mirrors, rather than reuses,
//!    `execute_lay_tile`'s legality checks.** `query_legal_tile_placements`
//!    delegates entirely to `hexmap::legal_tile_placements`, a read-only
//!    function that independently re-implements the same three rules
//!    (era-locking, landmark reservation, connectivity/topology) rather
//!    than sharing code with `execute_lay_tile` itself -- see that
//!    function's own doc comment for the maintenance implication (the two
//!    must be kept in sync by hand). It deliberately does not check
//!    President authorization, treasury affordability, or Operating Round
//!    turn-queue position -- see `QueryMsg::GetLegalTilePlacements`'s doc
//!    comment for why those are out of scope for a placement-legality
//!    query.
//! 7. **Coordinate Symmetries.** `query_map_grid`'s `MapTileEntry` and
//!    `query_legal_tile_placements`'s `LegalTilePlacementsResponse` both
//!    carry a `hex_label` field (via `hexmap::describe_hex`) alongside
//!    every `(q, r)` they report -- the real 1830 board label (e.g.
//!    `"G19"`), not just the bare axial pair -- and `print_markdown_map`'s
//!    table leads with that same label column. See `hexmap.rs`'s module
//!    doc comment #15 for the full rationale: `(q, r)` is still the actual
//!    storage/query key, this is purely added traceability.
//! 8. **Player Net Worth (`query_player_net_worth`).** The one handler in
//!    this module that takes a caller-supplied address rather than only
//!    `game_id`/coordinates -- `wallet_address: String` is validated into a
//!    real `Addr` via `deps.api.addr_validate`, matching every `execute_*`
//!    handler's own convention for a caller-supplied address, rather than
//!    silently accepting a malformed string. Net worth is the authentic
//!    1830 figure: liquid `PLAYER_CASH_VGP` cash plus the LIVE market value
//!    of every share certificate held (each company's `PLAYER_SHARES`
//!    percentage, converted to a certificate count and priced at that
//!    company's current `MARKET_GRID` cell via `market::current_cell`) --
//!    deliberately NOT each company's fixed `PROTOCOL_PAR_VALUE`, since par
//!    value only prices a fresh IPO purchase, not what an existing
//!    certificate is actually worth on today's market. Placed in this
//!    module (not `operations.rs`) to match `contract::query`'s own
//!    documented dispatch convention -- "dispatches each `QueryMsg` variant
//!    to its assembly function in `query.rs`" -- and this module's design
//!    note #1 (`Deps`, plain `StdResult`, no dedicated error enum), the
//!    same shape every other handler here already follows; `operations.rs`
//!    is exclusively `DepsMut` execute handlers with their own
//!    `thiserror` conventions, and has never held a query.

use std::fmt::Write as _;

use cosmwasm_std::{Deps, Order, StdError, StdResult, Uint128};

use crate::auction::CORE_PRIVATE_COMPANIES;
use crate::contract;
use crate::hexmap::{self, TILE_CATALOG};
use crate::market;
use crate::msg::{
    GameStateResponse, LegalTilePlacement, LegalTilePlacementsResponse, MapGridMarkdownResponse,
    MapGridResponse, MapTileEntry, MarketGridResponse, MarketPositionEntry, PlayerCashEntry,
    TrainOfferEntry, TrainOffersResponse,
    PlayerNetWorthResponse, PlayerShareEntry, PrivateCompanyState, PublicCompanyState,
    WaterfallBidEntry, WaterfallMiniAuctionStatus, WaterfallPrivateStatus, WaterfallStateResponse,
};
use crate::public_company::CORE_PUBLIC_COMPANIES;
use crate::train_trade;
use crate::state::{
    GameSession, WaterfallMiniAuction, BANK_POOL_SHARES, COMPANY_HARDWARE, IPO_POOL_SHARES,
    MAP_GRID,
    PLAYER_CASH_VGP, PLAYER_SHARES, PRIVATE_BIDS, PRIVATE_COMPANIES, PROTOCOL_MARKET,
    PROTOCOL_PAR_VALUE, PROTOCOL_PRESIDENT, PROTOCOL_STATION_HEXES, PUBLIC_COMPANIES, SESSIONS,
    WATERFALL_MINI_AUCTION,
};
// `trading::PERCENT_PER_SHARE` is no longer imported here: the
// percentage-to-certificate-count conversion it backed moved into
// `contract::appraise_player_net_worth_breakdown` alongside the rest of
// the shared appraiser (Audit G-1).

/// Loads `game_id`'s `GameSession`, or a clean `StdError` if the room
/// doesn't exist -- shared by every handler in this module.
fn load_session(deps: Deps, game_id: u64) -> StdResult<GameSession> {
    SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or_else(|| StdError::generic_err(format!("game room {game_id} was not found")))
}

/// Assembles `QueryMsg::GetGameState`'s response -- see module doc comment
/// #2 for exactly what "ownership registries" means here.
pub fn query_game_state(deps: Deps, game_id: u64) -> StdResult<GameStateResponse> {
    let session = load_session(deps, game_id)?;

    let player_cash = session
        .player_addresses
        .iter()
        .map(|player| {
            let cash_vgp = PLAYER_CASH_VGP
                .may_load(deps.storage, (game_id, player.clone()))?
                .unwrap_or_default();
            Ok(PlayerCashEntry {
                player: player.clone(),
                cash_vgp,
            })
        })
        .collect::<StdResult<Vec<_>>>()?;

    let mut public_companies = Vec::with_capacity(CORE_PUBLIC_COMPANIES.len());
    for (company_id, ticker) in CORE_PUBLIC_COMPANIES.iter().copied() {
        let Some(company) = PUBLIC_COMPANIES.may_load(deps.storage, (game_id, company_id))? else {
            continue;
        };

        let par_value = PROTOCOL_PAR_VALUE.may_load(deps.storage, (game_id, company_id))?;
        let president = PROTOCOL_PRESIDENT.may_load(deps.storage, (game_id, company_id))?;
        let ipo_pool_percentage = IPO_POOL_SHARES
            .may_load(deps.storage, (game_id, company_id))?
            .unwrap_or(100);
        let bank_pool_percentage = BANK_POOL_SHARES
            .may_load(deps.storage, (game_id, company_id))?
            .unwrap_or(0);

        let mut player_holdings = Vec::new();
        for player in &session.player_addresses {
            let percentage = PLAYER_SHARES
                .may_load(deps.storage, (game_id, company_id, player.clone()))?
                .unwrap_or(0);
            if percentage > 0 {
                player_holdings.push(PlayerShareEntry {
                    player: player.clone(),
                    percentage,
                });
            }
        }

        // Station Tokens (`hexmap.rs` module doc comment #23).
        let home_hex_label = hexmap::corporation_home_hex(company_id).map(|(_, _, label)| label.to_string());
        let station_token_hexes: Vec<(i32, i32)> = PROTOCOL_STATION_HEXES
            .may_load(deps.storage, (game_id, company_id))?
            .unwrap_or_default();
        // Audit G-12: resolved through `hex_token_occupants`, the same read
        // path the blockade rule uses, so a client can never be shown a token
        // in a city the pathfinder thinks is elsewhere. That helper also
        // reconstructs pre-G-12 tokens against city 0, which is why this
        // reports a city for every hex in the list above rather than only for
        // tokens placed since the upgrade.
        let mut station_tokens: Vec<(i32, i32, u8)> = Vec::with_capacity(station_token_hexes.len());
        for (q, r) in station_token_hexes.iter().copied() {
            let city_index = hexmap::hex_token_occupants(deps.storage, game_id, q, r)?
                .into_iter()
                .find(|(id, _)| *id == company_id)
                .map(|(_, city)| city)
                .unwrap_or(0);
            station_tokens.push((q, r, city_index));
        }

        public_companies.push(PublicCompanyState {
            company_id,
            ticker: ticker.to_string(),
            is_floated: company.is_floated,
            treasury: company.treasury,
            total_shares_issued: company.total_shares_issued,
            par_value,
            president,
            ipo_pool_percentage,
            bank_pool_percentage,
            player_holdings,
            home_hex_label,
            station_token_hexes,
            station_tokens,
            station_token_limit: hexmap::station_token_limit(company_id),
            // Audit G-15c: model strings only -- see the field's doc comment.
            owned_trains: COMPANY_HARDWARE
                .may_load(deps.storage, (game_id, company_id))?
                .unwrap_or_default()
                .into_iter()
                .map(|unit| unit.model_type)
                .collect(),
        });
    }

    let mut private_companies = Vec::with_capacity(CORE_PRIVATE_COMPANIES.len());
    for (private_id, ..) in CORE_PRIVATE_COMPANIES.iter().copied() {
        let Some(private) = PRIVATE_COMPANIES.may_load(deps.storage, (game_id, private_id))? else {
            continue;
        };
        private_companies.push(PrivateCompanyState {
            private_id: private.private_id,
            name: private.name,
            cost: private.cost,
            revenue_per_or: private.revenue_per_or,
            owner: private.owner,
            owner_protocol_id: private.owner_protocol_id,
            closed: private.closed,
        });
    }

    Ok(GameStateResponse {
        game_id,
        creator: session.creator,
        is_active: session.is_active,
        total_juno_pool: session.total_juno_pool,
        virtual_bank_vgp: session.virtual_bank_vgp,
        virtual_bank_start: session.virtual_bank_start,
        max_players: session.max_players,
        player_addresses: session.player_addresses,
        active_player_index: session.active_player_index,
        priority_deal_index: session.priority_deal_index,
        consecutive_passes: session.consecutive_passes,
        current_global_era: session.current_global_era,
        active_operating_order: session.active_operating_order,
        active_corporation_index: session.active_corporation_index,
        current_round_type: session.current_round_type,
        macro_round_number: session.macro_round_number,
        sub_round_index: session.sub_round_index,
        operating_round_sequence_length: session.operating_round_sequence_length,
        player_cash,
        public_companies,
        private_companies,
    })
}

/// Assembles `QueryMsg::GetMarketGrid`'s response -- see module doc comment
/// #3 for why every core public company appears here, floated or not.
pub fn query_market_grid(deps: Deps, game_id: u64) -> StdResult<MarketGridResponse> {
    load_session(deps, game_id)?;

    let mut positions = Vec::with_capacity(CORE_PUBLIC_COMPANIES.len());
    for (company_id, ticker) in CORE_PUBLIC_COMPANIES.iter().copied() {
        let Some(position) = PROTOCOL_MARKET.may_load(deps.storage, (game_id, company_id))? else {
            continue;
        };

        // A cosmetic lookup only -- see module doc comment #3 for why a
        // failure here is downgraded to `None` rather than failing the
        // whole response.
        let price = market::current_cell(deps.storage, game_id, company_id)
            .map(|cell| cell.price)
            .ok();

        positions.push(MarketPositionEntry {
            company_id,
            ticker: ticker.to_string(),
            x: position.current_x,
            y: position.current_y,
            price,
        });
    }

    Ok(MarketGridResponse { game_id, positions })
}

/// Assembles `QueryMsg::GetMapGrid`'s response: every tile currently laid
/// on `game_id`'s shared `MAP_GRID`, sorted by `(r, q)` for a stable,
/// row-by-row reading order.
/// `QueryMsg::GetTrainOffers` -- Audit G-15.
///
/// Resolves each side's PRESIDENT alongside the raw offer, so a client can
/// decide what to show without a second round-trip: the seller's president
/// sees Accept/Reject, the buyer's president sees Rescind, everyone else sees
/// a read-only row.
pub fn query_train_offers(deps: Deps, game_id: u64) -> StdResult<TrainOffersResponse> {
    load_session(deps, game_id)?;
    let offers = train_trade::pending_offers(deps.storage, game_id)?
        .into_iter()
        .map(|(offer_id, offer)| {
            Ok(TrainOfferEntry {
                offer_id,
                buyer_protocol_id: offer.buyer_protocol_id,
                seller_protocol_id: offer.seller_protocol_id,
                model_type: offer.model_type,
                price: offer.price,
                seller_president: PROTOCOL_PRESIDENT
                    .may_load(deps.storage, (game_id, offer.seller_protocol_id))?,
                buyer_president: PROTOCOL_PRESIDENT
                    .may_load(deps.storage, (game_id, offer.buyer_protocol_id))?,
            })
        })
        .collect::<StdResult<Vec<_>>>()?;

    Ok(TrainOffersResponse { game_id, offers })
}

pub fn query_map_grid(deps: Deps, game_id: u64) -> StdResult<MapGridResponse> {
    load_session(deps, game_id)?;

    let mut tiles: Vec<MapTileEntry> = MAP_GRID
        .sub_prefix(game_id)
        .range(deps.storage, None, None, Order::Ascending)
        .map(|entry| {
            let ((q, r), tile) = entry?;
            Ok(MapTileEntry {
                q,
                r,
                hex_label: hexmap::describe_hex(q, r),
                tile_id: tile.tile_id,
                orientation: tile.orientation,
                // BASE (pre-rotation) edge pairs, resolved through the same
                // stored-list-then-catalog fallback every routing call in
                // the contract already goes through -- `orientation` above
                // is reported separately and the caller applies it, exactly
                // as it already must for `connections`.
                //
                // Deliberately NOT `tile.paths` raw. `Tile::paths` is
                // `#[serde(default)]`, so a tile written to `MAP_GRID`
                // before that field existed deserializes with an empty list;
                // handing that empty list straight to a client would make a
                // legacy tile render as a bare fan forever, even though its
                // real pairing is knowable -- `paths` is a pure function of
                // `tile_id`, which is why `hexmap::effective_tile_paths`
                // resolves it this way for `pathfinding.rs` too. Falling
                // back here keeps the query's answer identical to what the
                // contract itself routes on, rather than inventing a second,
                // weaker notion of what a tile's segments are.
                paths: hexmap::effective_base_tile_paths(&tile).to_vec(),
                // Audit G-11: resolved through the SAME `tile_base_value`
                // the payout engine uses, so this can never report a figure
                // the contract would not pay. `unwrap_or_default()` covers
                // only a `tile_id` absent from the catalog entirely, which
                // `execute_lay_tile` rejects with `TileNotFound`.
                revenue: hexmap::tile_base_value(tile.tile_id).unwrap_or_default(),
                landmark: hexmap::landmark_name_at(q, r).map(|name| name.to_string()),
            })
        })
        .collect::<StdResult<Vec<_>>>()?;

    tiles.sort_by_key(|entry| (entry.r, entry.q));

    Ok(MapGridResponse { game_id, tiles })
}

/// Assembles `QueryMsg::GetMapGridMarkdown`'s response: `query_map_grid`'s
/// tile list, rendered through `print_markdown_map`.
pub fn query_map_grid_markdown(deps: Deps, game_id: u64) -> StdResult<MapGridMarkdownResponse> {
    let map = query_map_grid(deps, game_id)?;
    let markdown = print_markdown_map(game_id, &map.tiles);
    Ok(MapGridMarkdownResponse { game_id, markdown })
}

/// Renders `game_id`'s `MAP_GRID` as a Markdown text block: a data table of
/// every laid tile plus an approximate square-grid ASCII sketch. See module
/// doc comments #4/#5 for what this can and can't do. Pure and read-only --
/// takes an already-sorted tile list (from `query_map_grid`) rather than
/// re-reading storage itself, so a caller that already has the list (e.g.
/// `query_map_grid_markdown` above) doesn't pay for it twice.
pub fn print_markdown_map(game_id: u64, tiles: &[MapTileEntry]) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# Map Grid -- Game {game_id}");
    let _ = writeln!(out);

    if tiles.is_empty() {
        let _ = writeln!(out, "_No tiles have been laid yet._");
        return out;
    }

    let _ = writeln!(
        out,
        "| Label | (q, r) | Tile | Color | Terrain | Landmark | Orientation | Edges |"
    );
    let _ = writeln!(out, "|---|---|---|---|---|---|---|---|");
    for entry in tiles {
        let catalog_entry = TILE_CATALOG
            .iter()
            .copied()
            .find(|(id, ..)| *id == entry.tile_id);
        let (color, terrain) = catalog_entry
            .map(|(_, _, _, terrain, color, _qty, _paths, _revenue)| {
                (format!("{color:?}"), format!("{terrain:?}"))
            })
            .unwrap_or_else(|| ("?".to_string(), "?".to_string()));
        let base_connections = catalog_entry
            .map(|(_, connections, ..)| connections)
            .unwrap_or(0);
        let actual = hexmap::rotate_connections(base_connections, entry.orientation);

        let _ = writeln!(
            out,
            "| {} | ({}, {}) | {} | {} | {} | {} | {} | {} |",
            entry.hex_label,
            entry.q,
            entry.r,
            entry.tile_id,
            color,
            terrain,
            entry.landmark.clone().unwrap_or_else(|| "-".to_string()),
            entry.orientation,
            describe_edges(actual),
        );
    }

    let _ = writeln!(out);
    let _ = writeln!(out, "```");
    let _ = write!(out, "{}", render_ascii_grid(tiles));
    let _ = writeln!(out, "```");
    out
}

/// Assembles `QueryMsg::GetLegalTilePlacements`'s response: every
/// `(tile_id, orientation)` pairing `hexmap::legal_tile_placements`
/// currently considers legal at `(q, r)` for `protocol_id` -- see that
/// function's doc comment for exactly which of `execute_lay_tile`'s rules
/// are (and aren't) checked here. The only failure mode is `game_id` not
/// existing (`hexmap::HexMapError::GameNotFound`), surfaced as a plain
/// `StdError` per this module's design note #1.
pub fn query_legal_tile_placements(
    deps: Deps,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
) -> StdResult<LegalTilePlacementsResponse> {
    let placements = hexmap::legal_tile_placements(deps.storage, game_id, protocol_id, q, r)
        .map_err(|e| StdError::generic_err(e.to_string()))?;

    Ok(LegalTilePlacementsResponse {
        game_id,
        protocol_id,
        q,
        r,
        hex_label: hexmap::describe_hex(q, r),
        placements: placements
            .into_iter()
            .map(|(tile_id, orientation)| LegalTilePlacement {
                tile_id,
                orientation,
            })
            .collect(),
    })
}

/// Assembles `QueryMsg::PlayerNetWorth`'s response -- see that variant's
/// doc comment for the full formula. `wallet_address` is validated into a
/// real `Addr` first (a malformed address is a genuine error, same as
/// every `execute_*` handler's own `deps.api.addr_validate` call); every
/// storage lookup after that treats a missing entry as zero rather than
/// erroring, so an unregistered address prices out at an honest `0`
/// instead of failing the query.
///
/// **Shared appraiser (Audit G-1).** The cash/stock/private summation this
/// function used to perform inline now lives in
/// `contract::appraise_player_net_worth_breakdown`, which
/// `contract::finalize_and_distribute_payouts` also calls -- so the
/// read-only figure reported here and the figure the real-JUNO endgame
/// payout actually divides against are computed by the same code and can
/// never drift apart again. (They previously DID: this handler used the
/// correct certificate-count formula while `contract.rs`'s own appraiser
/// used `price * percentage / 100`, undervaluing stock by 10x in the
/// payout path only.)
///
/// One behavioral change beyond the refactor: `net_worth` now also
/// includes the face value of every unclosed private company the player
/// owns. `PlayerNetWorthResponse` has no `private_company_value` field to
/// report that line separately, so for a player holding privates
/// `net_worth > cash_vgp + stock_portfolio_value`. Adding that field
/// (and its `utils/gameState.ts` mirror) is a deliberate follow-up, kept
/// out of this pass to leave the wire format untouched.
pub fn query_player_net_worth(
    deps: Deps,
    game_id: u64,
    wallet_address: String,
) -> StdResult<PlayerNetWorthResponse> {
    load_session(deps, game_id)?;
    let player = deps.api.addr_validate(&wallet_address)?;

    let breakdown = contract::appraise_player_net_worth_breakdown(deps, game_id, &player)
        .map_err(|e| StdError::generic_err(e.to_string()))?;

    Ok(PlayerNetWorthResponse {
        game_id,
        player,
        cash_vgp: breakdown.cash_vgp,
        stock_portfolio_value: breakdown.stock_portfolio_value,
        private_company_value: breakdown.private_company_value,
        net_worth: breakdown.net_worth,
    })
}

/// Assembles `QueryMsg::GetWaterfallState`'s response -- every still-unowned
/// core private company in ascending face-value order (each with its live
/// standing bids), which one is currently the lowest-offered
/// (face-value-buyable) private, whose turn it is, and -- if a 2+-bidder
/// mini-auction is currently in progress -- that mini-auction's own status.
/// See `waterfall.rs` module doc comment for the full mechanic this mirrors.
pub fn query_waterfall_state(deps: Deps, game_id: u64) -> StdResult<WaterfallStateResponse> {
    let session = load_session(deps, game_id)?;

    let mut privates = Vec::new();
    let mut lowest_found = false;
    for (private_id, name, cost, _revenue_per_or) in CORE_PRIVATE_COMPANIES.iter().copied() {
        let Some(private) = PRIVATE_COMPANIES.may_load(deps.storage, (game_id, private_id))? else {
            continue;
        };
        if private.owner.is_some() || private.owner_protocol_id.is_some() || private.closed {
            continue;
        }

        let bids = PRIVATE_BIDS
            .prefix((game_id, private_id))
            .range(deps.storage, None, None, Order::Ascending)
            .map(|entry| entry.map(|(bidder, bid_amount)| WaterfallBidEntry { bidder, bid_amount }))
            .collect::<StdResult<Vec<_>>>()?;

        let is_lowest_offered = !lowest_found;
        lowest_found = true;

        privates.push(WaterfallPrivateStatus {
            private_id,
            name: name.to_string(),
            face_value: Uint128::new(cost),
            is_lowest_offered,
            bids,
        });
    }

    let current_turn = session
        .player_addresses
        .get(session.active_player_index as usize)
        .cloned()
        .unwrap_or_else(|| session.creator.clone());

    let mini_auction = WATERFALL_MINI_AUCTION
        .may_load(deps.storage, game_id)?
        .map(|mini: WaterfallMiniAuction| {
            let current_turn = mini
                .bidders
                .get(mini.turn_index as usize)
                .cloned()
                .unwrap_or_else(|| mini.high_bidder.clone());
            WaterfallMiniAuctionStatus {
                private_id: mini.private_id,
                bidders: mini.bidders,
                current_turn,
                high_bid: mini.high_bid,
                high_bidder: mini.high_bidder,
            }
        });

    Ok(WaterfallStateResponse {
        game_id,
        waterfall_auction_active: session.waterfall_auction_active,
        privates,
        current_turn,
        mini_auction,
        consecutive_waterfall_passes: session.consecutive_waterfall_passes,
    })
}

/// Formats a 6-bit edge bitmask as a compact, human-readable edge list,
/// e.g. `0b00_1001` (edges 0 & 3) -> `"0,3"`.
fn describe_edges(mask: u8) -> String {
    let edges: Vec<String> = (0..6u8)
        .filter(|edge| mask & (1u8 << edge) != 0)
        .map(|edge| edge.to_string())
        .collect();
    if edges.is_empty() {
        "-".to_string()
    } else {
        edges.join(",")
    }
}

/// Three-character abbreviation for a reserved landmark city name, used by
/// `render_ascii_grid`'s fixed-width cells.
fn landmark_initials(name: &str) -> String {
    match name {
        "New York" => " NY".to_string(),
        "Boston" => " BO".to_string(),
        "Baltimore" => " BA".to_string(),
        other => format!("{:>3}", other.chars().take(3).collect::<String>()),
    }
}

/// Approximate square-grid ASCII sketch of the board -- see module doc
/// comment #5 for exactly what this is (and isn't).
fn render_ascii_grid(tiles: &[MapTileEntry]) -> String {
    let mut min_q = i32::MAX;
    let mut max_q = i32::MIN;
    let mut min_r = i32::MAX;
    let mut max_r = i32::MIN;

    {
        let mut note = |q: i32, r: i32| {
            min_q = min_q.min(q);
            max_q = max_q.max(q);
            min_r = min_r.min(r);
            max_r = max_r.max(r);
        };
        for entry in tiles {
            note(entry.q, entry.r);
        }
        for (_, q, r) in hexmap::LANDMARK_HEXES.iter().copied() {
            note(q, r);
        }
    }

    let mut out = String::new();
    for r in min_r..=max_r {
        let mut row = String::new();
        for q in min_q..=max_q {
            let cell = if let Some(landmark) = hexmap::landmark_name_at(q, r) {
                landmark_initials(landmark)
            } else if let Some(entry) = tiles.iter().find(|t| t.q == q && t.r == r) {
                format!("{:>3}", entry.tile_id)
            } else {
                " . ".to_string()
            };
            row.push_str(&cell);
            row.push(' ');
        }
        let _ = writeln!(out, "r={r:>3}: {row}");
    }
    out
}
