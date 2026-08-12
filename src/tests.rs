//! End-to-end simulation of a single 18Cosmos game session, exercised
//! directly against the contract's `instantiate`/`execute` entry points
//! with `cosmwasm_std::testing`'s mock dependencies (no chain or
//! `cw-multi-test` needed, since every call in this test targets the same
//! in-process `DepsMut`). This is the project's first automated test, and
//! is meant as a readable "watch a game play out" smoke test covering the
//! room lifecycle, private auctions, and public-company Operating Round
//! revenue -- not an exhaustive suite for every module's edge cases.
//!
//! Writing it surfaced two real, pre-existing bugs that are fixed alongside
//! this file (see `contract.rs` and `market.rs` for the full explanations):
//! 1. `JoinGameRoom` used to divide `STARTING_CAPITAL_POOL` by the
//!    headcount *at the moment each player joined*, so a 4-player game's
//!    four players actually received four *different* amounts ($1200,
//!    $800, $600, $480), never a uniform $600 each. Fixed by adding
//!    `CreateGameRoom { max_players }`, which fixes the denominator up
//!    front and also lets the room creator be provisioned immediately
//!    (previously they were silently never funded at all).
//! 2. `MARKET_GRID` (the stock-price chart `market.rs` walks protocols
//!    across) was never seeded with any `MarketCell` data anywhere in the
//!    contract, so *any* price movement -- including the one this test's
//!    Operating Round step depends on -- would have failed with
//!    `MarketCellNotFound`. Fixed by seeding a full illustrative price
//!    ladder once, at `instantiate`.

use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{coins, from_json, Addr, BankMsg, CosmosMsg, Uint128};

use crate::auction::AuctionError;
use crate::contract::{
    execute, instantiate, query as query_entry_point, ContractError, NATIVE_DENOM,
};
use crate::hardware::HardwareError;
use crate::hexmap::{self, HexMapError};
use crate::market;
use crate::msg::{
    ExecuteMsg, GameStateResponse, InstantiateMsg, LegalTilePlacementsResponse,
    MapGridMarkdownResponse, MapGridResponse, MarketGridResponse, PayoutStrategy,
    PlayerNetWorthResponse, QueryMsg, SharePurchaseSource,
};
use crate::operations::{self, OperationsError};
use crate::pathfinding;
use crate::query;
use crate::state::{
    HardwareAsset, ProtocolMarketState, RoundType, TerrainType, Tile, TileColor, BANK_POOL_SHARES,
    COMPANY_HARDWARE,
    GAME_LOG, HARDWARE_POOL, IPO_POOL_SHARES, MAP_GRID, MARKET_GRID, PLAYER_CASH_VGP,
    PLAYER_SHARES, PRIVATE_BIDS, PRIVATE_COMPANIES, PROTOCOL_LAST_TOKEN_SUBROUND, PROTOCOL_MARKET,
    PROTOCOL_NETWORK_HEXES, PROTOCOL_PAR_VALUE, PROTOCOL_PRESIDENT, PROTOCOL_STATION_HEXES,
    PUBLIC_COMPANIES, REMAINING_TILES, SESSIONS, TRAINS_PURCHASED_COUNT, WATERFALL_MINI_AUCTION,
};
use crate::trading::TradingError;
use crate::waterfall::WaterfallError;

/// Reads a `String`-valued response attribute by key, panicking with a
/// clear message if it's missing -- keeps the assertions below readable.
fn attr(response: &cosmwasm_std::Response, key: &str) -> String {
    response
        .attributes
        .iter()
        .find(|a| a.key == key)
        .unwrap_or_else(|| panic!("expected response attribute '{key}'"))
        .value
        .clone()
}

/// Test-only convenience that short-circuits `game_id`'s Pre-Game Waterfall
/// Auction (`waterfall.rs`) immediately after room creation, without
/// actually playing through it: flips `waterfall_auction_active` off and
/// `current_round_type` to `RoundType::StockRound` directly in storage --
/// the same end state `waterfall::conclude_waterfall` itself produces once
/// every private company is allocated. Every test in this file below that
/// calls this predates the Waterfall Auction and exercises its own
/// private-company acquisition story directly via
/// `BidOnPrivate`/`BuyPrivateCompany`; calling this once, right after
/// `CreateGameRoom`, keeps each of those tests' downstream cash/turn
/// assertions exactly as they were before the Waterfall Auction existed,
/// rather than requiring every one of them to also play out a full
/// six-private waterfall first (which would additionally spend real VGP
/// cash on whichever privates it happened to buy along the way, shifting
/// every later balance assertion for no test-relevant reason). The
/// Waterfall Auction engine itself is exercised by its own dedicated
/// `waterfall_*` tests further down this file -- this helper is purely a
/// backward-compatibility bypass for this file's many pre-existing
/// scenarios.
fn skip_waterfall_auction(storage: &mut dyn cosmwasm_std::Storage, game_id: u64) {
    let mut session = SESSIONS.load(storage, game_id).unwrap();
    session.waterfall_auction_active = false;
    session.current_round_type = RoundType::StockRound;
    SESSIONS.save(storage, game_id, &session).unwrap();
}

/// Test-only bypass for the Stock Round 1 sale ban (Audit G-6,
/// `trading.rs` module doc comment #18): fast-forwards the room's macro
/// round counter to `2` while leaving it in a Stock Round, exactly as
/// Macro Round Loop Advancement (`operations::execute_end_operating_round_turn`)
/// would after a full Stock-Round-then-Operating-Rounds cycle completes.
///
/// Same motivation as `skip_waterfall_auction` just above: this file has
/// many pre-existing scenarios whose subject is share *selling* mechanics
/// (turn pacing, per-room market independence, net worth, IPO-vs-Bank
/// pricing) and which have no interest in first-round legality. Playing out
/// a real Operating Round in each of them just to reach SR2 would spend
/// treasury, move markers, and shift every later balance assertion for no
/// test-relevant reason. The SR1 ban itself is exercised directly by
/// `stock_round_one_forbids_all_share_sales` further down.
fn advance_past_first_stock_round(storage: &mut dyn cosmwasm_std::Storage, game_id: u64) {
    let mut session = SESSIONS.load(storage, game_id).unwrap();
    session.macro_round_number = 2;
    session.current_round_type = RoundType::StockRound;
    SESSIONS.save(storage, game_id, &session).unwrap();
}

/// Test-only convenience for every `ExecuteMsg::LayTile` call site in this
/// file that predates `orientation` becoming an explicit, player-chosen
/// message field (see `hexmap.rs` module doc comment #4): resolves
/// `tile_id`'s LOWEST currently-legal orientation at `(q, r)` for
/// `protocol_id`, via the same read-only `hexmap::legal_tile_placements`
/// query a frontend would use, so these pre-existing tests keep laying
/// tiles exactly the way they always did (mirroring the OLD auto-pick
/// behavior this feature intentionally removed from the contract itself)
/// without hand-deriving hex-rotation geometry at every call site. Returns
/// `0` if `tile_id` has no currently-legal orientation at all (e.g. a test
/// deliberately exercising a rejection unrelated to orientation, such as
/// `EraLocked` or `OffboardHexNotBuildable`) -- `0` is always in-bounds, and
/// `execute_lay_tile` itself still independently re-validates and correctly
/// rejects the call for whatever reason the test actually expects.
fn lowest_legal_orientation(
    storage: &dyn cosmwasm_std::Storage,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
    tile_id: u32,
) -> u32 {
    hexmap::legal_tile_placements(storage, game_id, protocol_id, q, r)
        .unwrap_or_default()
        .into_iter()
        .find(|(id, _)| *id == tile_id)
        .map(|(_, orientation)| orientation as u32)
        .unwrap_or(0)
}

#[test]
fn full_game_simulation() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    // ---- Step 1: instantiate with a 0.5% (50 basis point) developer
    // subsidy fee ------------------------------------------------------
    let admin_info = mock_info("admin", &[]);
    instantiate(
        deps.as_mut(),
        env.clone(),
        admin_info,
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    // ---- Step 2: create a 4-player room and have all 4 players join,
    // verifying each receives the same $600 VGP starting capital --------
    let player_one = Addr::unchecked("player_one");
    let player_two = Addr::unchecked("player_two");
    let player_three = Addr::unchecked("player_three");
    let player_four = Addr::unchecked("player_four");

    let creator_info = mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM));
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        creator_info,
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 4,
        },
    )
    .expect("create_game_room should succeed");

    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    assert_eq!(attr(&create_res, "starting_cash_vgp"), "600");

    // The creator (player_one) is registered as the room's first player and
    // is provisioned immediately -- no separate JoinGameRoom call needed
    // for them.
    let player_one_balance = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();
    assert_eq!(player_one_balance, Uint128::new(600));

    for player in [&player_two, &player_three, &player_four] {
        // Uniform Ante Rule: every joiner must attach exactly the same
        // 1,000,000 ujuno ante the creator deposited above.
        let join_info = mock_info(player.as_str(), &coins(1_000_000, NATIVE_DENOM));
        execute(
            deps.as_mut(),
            env.clone(),
            join_info,
            ExecuteMsg::JoinGameRoom { game_id },
        )
        .unwrap_or_else(|err| panic!("{player} should be able to join: {err}"));

        let balance = PLAYER_CASH_VGP
            .load(&deps.storage, (game_id, player.clone()))
            .unwrap();
        assert_eq!(
            balance,
            Uint128::new(600),
            "{player} should start with the same $600 VGP as every other player"
        );
    }

    // A 5th join must be rejected: the room is already full at max_players.
    let extra_player = mock_info("player_five", &[]);
    let full_room_err = execute(
        deps.as_mut(),
        env.clone(),
        extra_player,
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(full_room_err, ContractError::RoomFull { .. }),
        "expected ContractError::RoomFull, got: {full_room_err:?}"
    );

    // ---- Step 3: player_one bids on and wins the Schuylkill Valley
    // private company (id 1, $20 face value), confirming their balance
    // drops by exactly $20 ----------------------------------------------
    let balance_before_schuylkill = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 1, // Schuylkill Valley
            bid_amount: Uint128::new(20),
        },
    )
    .expect("player_one's opening bid on Schuylkill Valley should win it");

    let balance_after_schuylkill = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();
    assert_eq!(
        balance_before_schuylkill
            .checked_sub(balance_after_schuylkill)
            .unwrap(),
        Uint128::new(20),
        "winning Schuylkill Valley should cost exactly its $20 face value"
    );

    let schuylkill_valley = PRIVATE_COMPANIES.load(&deps.storage, (game_id, 1)).unwrap();
    assert_eq!(schuylkill_valley.owner, Some(player_one.clone()));

    // `BidOnPrivate` is turn-gated (see `auction::ensure_active_player`),
    // and player_one's winning bid above just advanced the turn pointer to
    // player_two. Cycle player_two, player_three, and player_four's turns
    // via `PassTurn` to bring the pointer back around to player_one before
    // their next bid.
    for player in [&player_two, &player_three, &player_four] {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player.as_str(), &[]),
            ExecuteMsg::PassTurn { game_id },
        )
        .unwrap_or_else(|err| panic!("{player} should be able to pass their turn: {err}"));
    }

    // ---- Step 4: float a public company, lay its home tile, buy a
    // 2-train, and run an Operating Round to verify balances increase via
    // the automatic pathfinding revenue ----------------------------------
    //
    // Only Baltimore & Ohio has an implemented floating trigger today (see
    // `auction::award_bo_president_share`) -- ordinary public companies
    // like PRR have no "60%-purchased" floating mechanic wired up yet
    // (flagged as a known gap, not fixed in this pass). So "floating a
    // public company" here means winning the B&O private, exactly like any
    // other private auction, which automatically floats its public
    // counterpart (company_id 4) as a side effect.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's opening bid on Baltimore & Ohio should win it and float the public B&O");

    let bo_public = PUBLIC_COMPANIES.load(&deps.storage, (game_id, 4)).unwrap();
    assert!(
        bo_public.is_floated,
        "winning the B&O private should float the public B&O"
    );
    assert_eq!(bo_public.treasury, Uint128::new(670)); // 10 certificates x $67 par

    // Lay B&O's home tile: a Small Town tile (tile_id 3, $10 VGP -- see
    // Revenue Pathing Correction in `hexmap::terrain_base_value`'s doc
    // comment) at F10 (2, 5) -- real board label "F10", the preprinted
    // Single-Town-designated hex named Erie (`hexmap::TOWN_DESIGNATED_HEXES`,
    // module doc comment #16). Deliberately NOT a Plain tile: Plain/Mountain
    // track carries $0 printed revenue in the corrected model, and this test
    // wants to exercise the Pathfinding Revenue Engine actually paying out
    // something nonzero downstream. player_one is B&O's President from the
    // float above.
    //
    // CORRECTION (Rigid On-Chain Tile Matching pass): this used to be the
    // map origin `(0, 0)`, legal before the Town/Double-Town Reservation
    // gate existed -- `(0, 0)` isn't a real board hex and carries no Town
    // designation, so a SmallTown tile there is now correctly rejected with
    // `TownTileMustBeOnTownDesignation`. A follow-up request proposed
    // retargeting to `(2, 4)`, described as "F6/Stratford, an authentic
    // pre-printed single-town hex" -- that description doesn't hold up:
    // `(2, 4)` is actually E9 (a real pre-printed GRAY hex, but its own
    // `marker` is `"none"` -- a bare track connector with no town or city at
    // all), and F6 itself is at `(0, 5)`, not `(2, 4)` -- and F6 is
    // Cleveland, a preprinted GRAY CITY hex (`CITY_DESIGNATED_HEXES`), not a
    // town. There is no "Stratford" anywhere in this board's sourced data.
    // `(0, 3)` / D4 / Flint was used next instead -- verified directly
    // against `hexmap::TOWN_DESIGNATED_HEXES`.
    //
    // RETARGETED AGAIN (Rigid Global Gray-Hex Lockout board-wide extension,
    // module doc comment #20): once `pathfinding::effective_tile_and_value`
    // grew a routable/scoreable synthetic fallback for every real GRAY hex
    // (not just the original six-hex override), Flint `(0, 3)` stopped being
    // an isolated test hex by accident of geometry -- its home tile's own
    // fixed edges 1 and 3 (tile_id 3's `0b00_1010` connections, at the
    // orientation `0` this test hardcodes below -- one of several
    // orientations legal for a company's very first tile, but the specific
    // one this test actually submits) put edge 3 pointing directly at
    // Lansing `(-1, 3)`, one of the twelve
    // `GRAY_PREPRINTED_HEXES`. Lansing has no individually-sourced override
    // figure, so it now correctly resolves through the generic flat
    // `MajorCityHub` fallback ($20) as a passable synthetic tile -- meaning
    // `trace_best_route` legitimately hops onto it and the "best route"
    // becomes $10 (Flint) + $20 (Lansing) = $30, not a bug in the coordinate
    // lookups themselves (verified directly: `terrain_base_value`,
    // `LANDMARK_START_VALUE_OVERRIDE`, and `GRAY_PREPRINTED_HEXES` all use
    // plain exact-tuple-equality `.find()` calls with no shared indexing or
    // array structure a neighboring coordinate's value could "bleed"
    // through), but a real, correct consequence of that earlier routing fix
    // colliding with this specific test's home-hex geometry. This test's own
    // stated intent is an ISOLATED single-hex route ("nowhere else to extend
    // to") to independently verify the Pathfinding Revenue Engine's basic
    // math before the Operating Round below -- rather than rewrite that
    // intent (and the Operating Round dividend math a few lines down, which
    // is derived from this same route's value) around an incidental $30,
    // `(2, 5)` / F10 / Erie is used instead: the other ordinary white
    // Single-Town hex confirmed (by direct neighbor-offset check against
    // `HEX_NEIGHBOR_OFFSETS`) to have neither of tile_id 3's two active
    // edges pointing at any of the twelve `GRAY_PREPRINTED_HEXES` or three
    // `LANDMARK_HEXES` entries, so its route genuinely has nowhere to
    // extend to, preserving this test's original single-hex scenario.
    let home_orientation = lowest_legal_orientation(&deps.storage, game_id, 4, 2, 5, 58);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: 4,
            q: 2,
            r: 5,
            tile_id: 58,
            orientation: home_orientation,
        },
    )
    .expect("B&O's President should be able to lay its home tile");

    let home_tile = MAP_GRID.load(&deps.storage, (game_id, 2, 5)).unwrap();
    assert_eq!(home_tile.tile_id, 58);

    // Buy a 2-train from the shared Hardware pool.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: 4,
        },
    )
    .expect("B&O's President should be able to buy the next Hardware unit");

    let bo_hardware = COMPANY_HARDWARE.load(&deps.storage, (game_id, 4)).unwrap();
    assert_eq!(bo_hardware.len(), 1);
    assert_eq!(bo_hardware[0].model_type, "2");
    assert_eq!(bo_hardware[0].max_route_distance, 2);

    // Independently verify the Pathfinding Revenue Engine before running the
    // Operating Round.
    //
    // AUDIT G-9: this used to assert `$10` and `vec![(2, 5)]` -- the lone
    // home hex, priced at its own Small Town value. That was the engine's own
    // acknowledged rules gap (its pre-G-9 design note #5, "Minimum route
    // length isn't enforced"). Real 1830 requires a route to join at least
    // two revenue centres to score anything at all, and this hex reaches
    // none: F10/Erie was chosen precisely because neither of tile 58's live
    // edges points at another revenue centre (see the RETARGETED AGAIN note
    // above). One town is not a route, so the correct figure is `$0` and the
    // correct path is empty. The positive case -- a route that DOES join two
    // centres, and does score -- is covered by
    // `route_scores_once_it_joins_two_revenue_centres` further down.
    let (route_value, route_path) =
        pathfinding::trace_best_route(&deps.storage, game_id, 4).unwrap();
    assert_eq!(
        route_value,
        Uint128::zero(),
        "a lone town reaches only one revenue centre, below the 1830 minimum of {}",
        pathfinding::MIN_REVENUE_CENTRES
    );
    assert!(route_path.is_empty());

    // The Operating Round arithmetic below is this test's actual subject
    // (private-company closure and dividend distribution), not the route
    // tracer's. It declares a fixed $10 -- the figure the traced route used
    // to supply -- so that arithmetic is unchanged by G-9 and keeps testing
    // what it was written to test.
    let declared_revenue = Uint128::new(10);

    // Run the Operating Round through the SEQUENTIAL queue -- the sole
    // Operating Round mechanic since Audit G-13 deleted the legacy batched
    // `ExecuteOperatingRound` (which double-paid private revenue whenever a
    // room drove both mechanics in the same round).
    //
    // Two steps now:
    //   1. `BeginOperatingRound` opens the round and, as its Automatic
    //      Pre-OR Revenue Payout, pays every OPEN private company's owner.
    //   2. `DeclareDividends` distributes $10 of route revenue across B&O's
    //      20% President's Certificate (player_one's $2 cut) and the market
    //      pool's remaining 80% (banked, not paid to any player).
    //
    // **The expected payout drops from $37 to $7, and $7 is the correct
    // figure.** player_one owns two privates: Schuylkill Valley ($5/OR) and
    // the Baltimore & Ohio ($30/OR). But the public B&O bought its first
    // train earlier in this very simulation, which fires the B&O Special
    // Closure (`hardware.rs` module doc comment #11) and permanently closes
    // the B&O PRIVATE. A closed private pays no further Operating Round
    // revenue -- so only Schuylkill Valley's $5 is due, plus the $2
    // dividend below.
    //
    // The old $37 was only ever reachable because the legacy batched
    // `ExecuteOperatingRound` -- deleted by Audit G-13 -- paid out closed
    // privates. Its Phase 1 loop skipped an UNOWNED private but never
    // checked the `closed` flag at all, so it kept paying the B&O private
    // $30 an Operating Round after the rules had removed it from play.
    // `pay_private_company_revenues`, which the sequential queue uses,
    // checks both. That is a SECOND rules bug the legacy mechanic was
    // carrying, independent of the double-payout G-13 was opened for, and
    // this test had been asserting it as correct behaviour.
    let balance_before_or = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]), // player_one is the room creator
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .expect("the room creator should be able to begin an Operating Round");

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]), // player_one is B&O's President
        ExecuteMsg::DeclareDividends {
            game_id,
            protocol_id: 4,
            revenue_amount: declared_revenue,
            distribute: true,
        },
    )
    .expect("B&O's President should be able to distribute its route revenue");

    let balance_after_or = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();
    assert!(
        balance_after_or > balance_before_or,
        "player_one's balance should increase from Operating Round revenue"
    );
    assert_eq!(
        balance_after_or.checked_sub(balance_before_or).unwrap(),
        // $5 Schuylkill Valley (the only still-OPEN private) + $2 B&O
        // dividend. The B&O private closed when the public B&O bought its
        // first train -- see the note above this Operating Round block.
        Uint128::new(7),
    );

    // Pin the closure down directly, so a future regression that starts
    // paying closed privates again fails HERE with a clear cause rather
    // than as an opaque off-by-$30 in the arithmetic above.
    let bo_private_after_or = PRIVATE_COMPANIES.load(&deps.storage, (game_id, 6)).unwrap();
    assert!(
        bo_private_after_or.closed,
        "the B&O private must be closed by the public B&O's first train purchase"
    );
    assert_eq!(
        bo_private_after_or.owner.as_ref(),
        Some(&player_one),
        "closure does not change who holds the certificate -- only that it stops paying"
    );

    // Players holding no privates and no B&O shares are untouched by this
    // Operating Round.
    for player in [&player_two, &player_three, &player_four] {
        let balance = PLAYER_CASH_VGP
            .load(&deps.storage, (game_id, player.clone()))
            .unwrap();
        assert_eq!(balance, Uint128::new(600));
    }
}

/// Revenue Pathing Correction: unit-level check that `terrain_base_value`
/// itself carries the corrected figures -- Plain and Mountain/Rugged are
/// pure connector track with $0 printed revenue, only Small Town ($10) and
/// Major City Hub ($20) actually score. Fast and precise, independent of
/// any board/route setup below.
#[test]
fn terrain_base_value_only_scores_towns_and_cities_not_plain_or_mountain_track() {
    assert_eq!(
        hexmap::terrain_base_value(TerrainType::Plain),
        Uint128::zero()
    );
    assert_eq!(
        hexmap::terrain_base_value(TerrainType::MountainRugged),
        Uint128::zero()
    );
    assert_eq!(
        hexmap::terrain_base_value(TerrainType::SmallTown),
        Uint128::new(10)
    );
    // DoubleTown (module doc comment #21, DoubleTown Revenue Correction):
    // flat $10, the same figure a single SmallTown scores -- NOT $20 (two
    // $10 stops summed). A route can only ever enter/exit this hex via ONE
    // edge in a single continuous transit, so it can only ever reach ONE of
    // the hex's two town stops per visit, never both -- the exact same
    // single-visit reasoning that corrected DoubleCityHub's own analogous
    // $80 overcorrection back down to a flat $40 (module doc comment #18's
    // tail paragraph / #20's follow-up correction), just never backported
    // to DoubleTown until this pass.
    assert_eq!(
        hexmap::terrain_base_value(TerrainType::DoubleTown),
        Uint128::new(10)
    );
    assert_eq!(
        hexmap::terrain_base_value(TerrainType::MajorCityHub),
        Uint128::new(20)
    );
    // DoubleCityHub (Rigid Global Gray-Hex Lockout pass, module doc comment
    // #20 follow-up correction): real 1830 tile 59's per-station $40 --
    // NOT both stations at once. Tile 59's two stations are real,
    // independently-sourced disconnected one-edge stubs (edge 0 -> station
    // A, edge 2 -> station B, no path between them), so a single
    // continuous route transit can only ever reach ONE station per visit.
    // A prior pass had corrected this to a flat $80 (both stations summed)
    // by analogy to DoubleTown's 2x pattern -- that was itself wrong, since
    // it silently assumed a single-pass dual-station visit this tile's
    // real (disconnected) topology can never actually produce.
    assert_eq!(
        hexmap::terrain_base_value(TerrainType::DoubleCityHub),
        Uint128::new(40)
    );
}

/// Revenue Pathing Correction, end to end against the real Pathfinding
/// Revenue Engine: a company whose entire laid network is Plain/Mountain
/// track (no town or city anywhere on it) must earn exactly $0 -- both for
/// an unbuilt hex (never reached `trace_best_route`'s BFS at all, per
/// `pathfinding.rs` module doc comment #2) and for a hex that *does* have a
/// legally-placed Plain tile sitting on it. Extending that same network to
/// reach a Small Town hex must then raise the route's value by exactly that
/// town's $10 -- confirming town/city revenue still flows normally and
/// isn't accidentally zeroed out alongside Plain/Mountain.
#[test]
fn pathfinding_revenue_only_counts_town_and_city_terrain_not_plain_or_mountain_track() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // Buy a 2-train (max_route_distance: 2) up front -- `trace_best_route`
    // short-circuits to $0/empty-path whenever a protocol owns zero
    // Hardware (module doc comment #4), *before* it ever looks at
    // `MAP_GRID`, so without this the BFS would never actually run for any
    // of the checks below, town/city hex or not.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: BO_PUBLIC_ID,
        },
    )
    .expect("B&O's President should be able to buy the next Hardware unit");

    // Before any tile is laid at all: B&O owns Hardware now, but has no
    // home hex yet (`PROTOCOL_NETWORK_HEXES` is still empty), so it's still
    // never reachable by the BFS.
    let (before_any_tile, before_path) =
        pathfinding::trace_best_route(&deps.storage, game_id, BO_PUBLIC_ID).unwrap();
    assert_eq!(before_any_tile, Uint128::zero());
    assert!(before_path.is_empty());

    // Home tile: plain straight track (tile_id 1, edges 0 & 3) -- pure
    // connector, no town or city. Deliberately laid away from the map
    // origin `(0, 0)` at D8 `(2, 3)`, an arbitrary ordinary (non-landmark,
    // non-off-board, non-Town-designated) hex, so this test's coordinates
    // are visibly its own rather than overloading `(0, 0)` the way several
    // *other* tests in this file (each with their own independent
    // `mock_dependencies()` storage) happen to for their own home tile.
    //
    // ORIENTATION FIX (Rigid On-Chain Tile Matching pass): this is now
    // hardcoded to `1` rather than taken from `lowest_legal_orientation`.
    // D8's first-ever tile is unconstrained (module doc comment #9), so the
    // helper would return the lowest orientation checked, `0` (edges {0, 3},
    // facing D10 -- see below for why that neighbor no longer works).
    // Orientation `1` rotates tile 1's opposite-edge pair to {1, 4} instead,
    // whose edge 4 faces E7 `(1, 4)` -- the real Town-designated hex this
    // pass retargets the extension to.
    let home_orientation: u32 = 1;
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 2,
            r: 3,
            tile_id: 9,
            orientation: home_orientation,
        },
    )
    .expect("B&O's home tile should be free to lay");

    let (plain_only, plain_path) =
        pathfinding::trace_best_route(&deps.storage, game_id, BO_PUBLIC_ID).unwrap();
    // The engine still WALKS the Plain hex -- it's a real, legally-placed
    // tile with real track on it -- it just correctly prices that hex's own
    // contribution at exactly $0, since Plain is connector track, not a
    // revenue centre. The dollar figure is what this test (Revenue Pathing
    // Correction) actually cares about, so that's the assertion.
    assert_eq!(
        plain_only,
        Uint128::zero(),
        "a legally-placed Plain tile alone must still score $0 -- it's connector track, not a revenue center"
    );
    // AUDIT G-9: this used to additionally assert `plain_path.contains(&(2, 3))`
    // -- that a $0 route still REPORTS the hexes it crossed. Under the 1830
    // minimum-route rule there is no route here at all to report: a network
    // of pure connector track joins zero revenue centres, which is below the
    // two-centre minimum, so the tracer returns an empty path rather than a
    // worthless one. The $0 assertion above -- this test's actual subject --
    // is unchanged, and now holds for a stronger reason than before.
    assert!(
        plain_path.is_empty(),
        "connector-only track joins no revenue centres, so there is no scoring route to report"
    );

    // Extend to E7 (1, 4) -- a true neighbor of D8 (2, 3) under
    // `hexmap::HEX_NEIGHBOR_OFFSETS[4]` (`(-1, 1)`) -- with a Small Town
    // gentle curve: real 1830 tray #58, base edges {0, 2}.
    //
    // CATALOG MIGRATION (Audit G-5): this used to be the old internal tile
    // 3, whose base edges were {1, 3}, so edge 1 was live at orientation 0
    // and the connection back to the home tile needed no rotation. Real
    // #58 is the same GENTLE-CURVE shape but indexed one step round the
    // hex, so the identical connection is now made at orientation 1
    // ({1, 3}) instead. `lowest_legal_orientation` finds it either way;
    // only the asserted value below changes.
    //
    // CORRECTION (Rigid On-Chain Tile Matching pass): this used to target
    // D10 `(3, 3)` -- legal before the City Reservation gate was extended
    // (module doc comment #16) beyond just the three landmarks to also
    // cover the six preprinted gray cities and four preprinted OO cities.
    // D10 is real-board Hamilton & Toronto, a preprinted OO city hex
    // (`hexmap::CITY_DESIGNATED_HEXES`), so a SmallTown tile there is now
    // correctly rejected with `LandmarkRequiresHubTile`. E7 (real label
    // "E7", the preprinted Single-Town hex London,
    // `hexmap::TOWN_DESIGNATED_HEXES`) is used instead -- a genuine neighbor
    // of D8 confirmed against `HEX_NEIGHBOR_OFFSETS` directly.
    let extend_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 1, 4, 58);
    let extend_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 1,
            r: 4,
            tile_id: 58,
            orientation: extend_orientation,
        },
    )
    .expect("a Small Town tile truly adjacent to the home tile should find a legal rotation");
    assert_eq!(attr(&extend_res, "orientation"), "1");

    // The Small Town hex is now genuinely REACHABLE from the home hex --
    // `hexmap::execute_lay_tile` accepted the placement above precisely
    // because the two tiles' edges connect -- and it prices at $10, which
    // `route_scores_once_it_joins_two_revenue_centres` below verifies
    // directly against `effective_tile_and_value`.
    //
    // AUDIT G-9: this used to assert the traced route was worth $10 over
    // `[(1, 4), (2, 3)]`. It is now $0, and that is the correct 1830 answer:
    // the route joins exactly ONE revenue centre (E7's town -- D8 is Plain
    // connector track worth nothing), and real 1830 pays nothing for a route
    // that does not join two. E7 cannot be extended to a second centre in
    // this test: its only other live edge faces Detroit & Windsor, an OO hex
    // that requires a Green-tier `DoubleCityHub` tile this Yellow-era test
    // can never lay (the same dead end `run_manual_route`'s own test doc
    // comment documents under "CORRECTION 2"). So rather than contort this
    // test's geometry, the positive case moved to its own test below, and
    // what this one now pins down is the boundary: adding a town to a
    // connector-only network is still not enough on its own.
    let (with_town, with_town_path) =
        pathfinding::trace_best_route(&deps.storage, game_id, BO_PUBLIC_ID).unwrap();
    assert_eq!(
        with_town,
        Uint128::zero(),
        "one town plus connector track is a single revenue centre -- below 1830's two-centre minimum"
    );
    assert!(with_town_path.is_empty());

    // Prove the $0 above is the MINIMUM-ROUTE rule and not a connectivity
    // failure that would have zeroed the route anyway: the town hex really
    // is worth $10, and really is on the map.
    let (_, town_value) = pathfinding::effective_tile_and_value(&deps.storage, game_id, 1, 4)
        .unwrap()
        .expect("E7 carries the Small Town tile just laid");
    assert_eq!(town_value, Uint128::new(10));
}

/// Exercises the general company-floating gap fix: an ordinary public
/// corporation (PRR, `company_id` 1 -- deliberately *not* Baltimore & Ohio,
/// which floats for free through a completely separate path in `auction.rs`
/// and so never reaches `trading::execute_buy_stock`'s flotation check)
/// must float automatically -- with no private-company shortcut involved --
/// purely from ordinary `BuyStock` purchases crossing the 60%
/// real-player-ownership threshold.
#[test]
fn public_company_floats_at_sixty_percent_player_ownership() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    // A 2-player room gives its creator $1200 VGP starting capital -- enough
    // for six $100 certificates ($600) with room to spare.
    let buyer = Addr::unchecked("buyer");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const PRR_COMPANY_ID: u32 = 1;

    // PRR starts unfloated, with an empty treasury, exactly like every
    // non-B&O corporation `public_company::spawn_core_public_companies`
    // seeds.
    let prr_before = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert!(!prr_before.is_floated);
    assert_eq!(prr_before.treasury, Uint128::zero());

    // The very first IPO purchase must choose a par value -- $100, the top
    // of the standard ladder, so every certificate below costs exactly
    // $100, matching the numbers this test asserts on.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("buyer's first IPO purchase, with a valid par_value, should succeed");

    // Buy 4 more certificates (50% total): still below the 60% float
    // threshold, and still below the 60% single-player certificate limit,
    // so every one of these must succeed without floating PRR. par_value is
    // omitted -- it's already been set and stays fixed.
    for _ in 0..4 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(buyer.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_COMPANY_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("buyer should be able to buy PRR certificates below the float threshold");
    }
    let prr_at_fifty = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert!(
        !prr_at_fifty.is_floated,
        "PRR must not float before real-player ownership reaches 60%"
    );

    // The 6th certificate pushes the buyer's (and thus the total
    // player-owned) stake to exactly 60% -- PRR must float on this exact
    // call, with no additional action needed.
    let float_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("the 6th certificate purchase (60%) should succeed and float PRR");
    assert_eq!(attr(&float_res, "newly_floated"), "true");

    let prr_after = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert!(
        prr_after.is_floated,
        "PRR should be floated the instant real-player ownership hits 60%"
    );
    assert_eq!(prr_after.total_shares_issued, 10);
    // Treasury = 10x the $100 par value every one of these six IPO
    // certificates was bought at (the pool never emptied -- only 60% of PRR
    // was ever sold -- so no sold-out bump ever moved the market marker).
    assert_eq!(prr_after.treasury, Uint128::new(1_000));

    // The buyer's 60% stake also easily clears PRESIDENT_MIN_PERCENTAGE
    // (20%), so they should be recorded as PRR's President too.
    let president = PROTOCOL_PRESIDENT
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert_eq!(president, buyer);

    // Spent exactly 6 x $100 = $600 of the buyer's $1200 starting capital.
    let buyer_balance = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, buyer.clone()))
        .unwrap();
    assert_eq!(buyer_balance, Uint128::new(600));
}

/// Exercises Par Value Selection end to end: an IPO purchase always pays
/// the protocol's fixed par value (chosen once, on the very first-ever IPO
/// buy), while an Open Market/Bank purchase pays whatever the protocol's
/// `MARKET_GRID` marker has since moved to -- and the two really do
/// diverge, once a Distribute Yield dividend nudges the marker away from
/// its starting par cell.
#[test]
fn ipo_purchases_pay_par_bank_purchases_pay_market_value() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    // Audit G-6: this scenario's subject is share-selling mechanics, not
    // first-round legality -- fast-forward past the Stock Round 1 sale ban.
    advance_past_first_stock_round(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const CPR_COMPANY_ID: u32 = 3;

    // The very first-ever IPO purchase of CPR must choose a par value from
    // the standard ladder -- the lowest, $67, pinned to grid cell (6, 5).
    let first_buy = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: CPR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(67)),
        },
    )
    .expect("player_a's first IPO purchase, with a valid par_value, should succeed");
    assert_eq!(attr(&first_buy, "source"), "ipo");
    assert_eq!(attr(&first_buy, "price_paid"), "67");
    assert_eq!(
        PROTOCOL_PAR_VALUE
            .load(&deps.storage, (game_id, CPR_COMPANY_ID))
            .unwrap(),
        Uint128::new(67)
    );

    // `BuyStock` is turn-gated, and player_a's purchase above just advanced
    // the turn pointer to player_b -- pass it back before player_a's next
    // purchase.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .expect("player_b should be able to pass their turn back to player_a");

    // A second IPO purchase omits par_value entirely -- it's already set --
    // and still pays the same fixed $67, bringing player_a to 20% (enough
    // to become President).
    let second_buy = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: CPR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("player_a's second IPO purchase should reuse the already-chosen par value");
    assert_eq!(attr(&second_buy, "price_paid"), "67");

    let player_a_balance_after_ipo = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    assert_eq!(player_a_balance_after_ipo, Uint128::new(1_200 - 67 - 67));

    let president = PROTOCOL_PRESIDENT
        .load(&deps.storage, (game_id, CPR_COMPANY_ID))
        .unwrap();
    assert_eq!(president, player_a);

    // player_b also buys up to 20% of CPR (two IPO certificates, still
    // reusing the already-chosen $67 par value). This isn't needed for the
    // par-vs-market-price divergence this test is really about, but it
    // gives CPR a legal President successor -- without it, player_a's
    // upcoming sale below would be rejected outright by the President/
    // Validator Transfer rule (trading.rs module doc comment #11), since
    // player_a currently holds the President seat and no one else would
    // qualify. `BuyStock` is turn-gated and just left the pointer on
    // player_b (from player_a's second purchase above), so the first of
    // these needs no `PassTurn`; the second does, to hand the turn back to
    // player_b in between.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: CPR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("player_b's first IPO purchase should succeed");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .expect("player_a should be able to pass their turn back to player_b");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: CPR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("player_b's second IPO purchase should succeed");

    let player_b_balance_after_ipo = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_b.clone()))
        .unwrap();
    assert_eq!(player_b_balance_after_ipo, Uint128::new(1_200 - 67 - 67));

    // Both players now hold 20% -- a tie, so the incumbent (player_a) stays
    // President (see `recalculate_president`'s tie-break rule).
    let president_after_player_b_buys = PROTOCOL_PRESIDENT
        .load(&deps.storage, (game_id, CPR_COMPANY_ID))
        .unwrap();
    assert_eq!(president_after_player_b_buys, player_a);

    // As CPR's President, player_a declares a Distribute Yield dividend --
    // this moves the market marker one cell right, from (6, 5) [$67] to
    // (7, 5) [$71], genuinely diverging from the fixed par value.
    // `DeclareDividends` isn't turn-gated, so this doesn't need a `PassTurn`
    // even though the pointer is currently sitting on player_a already
    // (player_b's second buy just advanced it back to player_a).
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::DeclareDividends {
            game_id,
            protocol_id: CPR_COMPANY_ID,
            revenue_amount: Uint128::new(100),
            distribute: true,
        },
    )
    .expect("CPR's President should be able to declare a dividend");
    // player_a holds 20% of CPR at this moment: payout = 100 * 20% = 20.
    // (player_b also holds 20% and gets their own, separate $20 cut -- that
    // doesn't change player_a's own payout.)
    let player_a_balance_after_dividend = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    assert_eq!(
        player_a_balance_after_dividend,
        player_a_balance_after_ipo + Uint128::new(20)
    );
    let player_b_balance_after_dividend = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_b.clone()))
        .unwrap();
    assert_eq!(
        player_b_balance_after_dividend,
        player_b_balance_after_ipo + Uint128::new(20)
    );

    // player_a sells one certificate (10%) back onto the Bank pool. It
    // settles at the *current* market price ($71, post-dividend) -- proving
    // Bank-pool pricing is independent of the fixed $67 par value. This is
    // turn-gated (still player_a's turn, per the comment above) but --
    // unlike `BuyStock` -- does NOT advance the turn pointer (Turn Pacing,
    // trading.rs module doc comment #9), so no `PassTurn` is needed first.
    let sell_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: CPR_COMPANY_ID,
            percentage: 10,
        },
    )
    .expect("player_a should be able to sell one CPR certificate, since player_b can legally absorb the presidency");
    assert_eq!(attr(&sell_res, "total_proceeds"), "71");
    assert_eq!(
        BANK_POOL_SHARES
            .load(&deps.storage, (game_id, CPR_COMPANY_ID))
            .unwrap(),
        10
    );

    let player_a_balance_after_sell = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    assert_eq!(
        player_a_balance_after_sell,
        player_a_balance_after_dividend + Uint128::new(71)
    );

    // Selling gave up player_a's 20% (down to 10%, below
    // PRESIDENT_MIN_PERCENTAGE) -- but exactly because player_b already
    // held 20%, the presidency transfers to player_b rather than the seat
    // going vacant.
    let president_after_sell = PROTOCOL_PRESIDENT
        .may_load(&deps.storage, (game_id, CPR_COMPANY_ID))
        .unwrap();
    assert_eq!(president_after_sell, Some(player_b.clone()));

    // `SellStock` didn't advance the turn pointer, so it's still player_a's
    // turn -- pass it to player_b before their next turn-gated action.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .expect("player_a should be able to pass their turn to player_b");

    // Supplying par_value on a Bank purchase must be rejected outright, and
    // must not touch player_b's balance or CPR's pools at all.
    let bad_bank_buy = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: CPR_COMPANY_ID,
            source: SharePurchaseSource::Bank,
            par_value: Some(Uint128::new(67)),
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            bad_bank_buy,
            ContractError::Trading(TradingError::ParValueNotApplicableForBankPurchase { .. })
        ),
        "expected ParValueNotApplicableForBankPurchase, got: {bad_bank_buy:?}"
    );
    assert_eq!(
        PLAYER_CASH_VGP
            .load(&deps.storage, (game_id, player_b.clone()))
            .unwrap(),
        player_b_balance_after_dividend,
        "the rejected Bank purchase attempt must not have touched player_b's balance"
    );

    // The real Bank purchase (no par_value) succeeds and pays the current
    // market price. player_a's certificate sale (above) moved CPR's marker
    // down one row on the real 1830 chart, from (7,5)=$71 to the seeded
    // (7,4)=$69 cell -- so player_b pays $69, not the $67 par value and not
    // the pre-sale $71 price.
    let bank_buy = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: CPR_COMPANY_ID,
            source: SharePurchaseSource::Bank,
            par_value: None,
        },
    )
    .expect("player_b's Bank purchase should succeed and pay the market price");
    assert_eq!(attr(&bank_buy, "source"), "bank");
    assert_eq!(attr(&bank_buy, "price_paid"), "69");

    let player_b_balance_final = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_b.clone()))
        .unwrap();
    assert_eq!(
        player_b_balance_final,
        player_b_balance_after_dividend - Uint128::new(69)
    );

    // The Bank pool is empty again (player_a's one dumped certificate was
    // just bought back by player_b); the IPO pool reflects all four IPO
    // buys from the start (100% - 4*10% = 60%); and CPR is still far short
    // of the 60% float threshold (player_a's 10% + player_b's 30% = 40%),
    // so none of this should have floated it.
    assert_eq!(
        BANK_POOL_SHARES
            .load(&deps.storage, (game_id, CPR_COMPANY_ID))
            .unwrap(),
        0
    );
    assert_eq!(
        IPO_POOL_SHARES
            .load(&deps.storage, (game_id, CPR_COMPANY_ID))
            .unwrap(),
        60
    );
    let cpr = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, CPR_COMPANY_ID))
        .unwrap();
    assert!(!cpr.is_floated);
}

/// Proves the `PROTOCOL_MARKET` game-scoping fix: two game rooms trading
/// the exact same `protocol_id` (PRR, `company_id` 1) must never share or
/// clobber each other's price marker. Before this fix, `PROTOCOL_MARKET`
/// was keyed by `protocol_id` alone, so a price movement in one room's PRR
/// (e.g. a dividend) would silently corrupt every other concurrently
/// running room's PRR price too -- this test would have failed against
/// that old code, since Room A's dividend-driven move would have leaked
/// into Room B's Bank-pool sale price below.
#[test]
fn concurrent_game_rooms_have_independent_market_positions() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    const PRR_COMPANY_ID: u32 = 1;

    // Room A.
    let player_a = Addr::unchecked("player_a");
    let create_a = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("room A creation should succeed");
    let game_id_a: u64 = attr(&create_a, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id_a);
    // Audit G-6: this scenario's subject is share-selling mechanics, not
    // first-round legality -- fast-forward past the Stock Round 1 sale ban.
    advance_past_first_stock_round(&mut deps.storage, game_id_a);

    // A second room A player -- needed so player_a (who ends up President)
    // has a legal 20%-holding successor on hand when they later sell down
    // their stake (see the President/Validator Transfer rule).
    let player_a2 = Addr::unchecked("player_a2");
    execute(
        deps.as_mut(),
        env.clone(),
        // Uniform Ante Rule: must match room A's creator (player_a)
        // 1,000,000 ujuno ante.
        mock_info(player_a2.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id: game_id_a },
    )
    .expect("player_a2 should be able to join room A");

    // Room B -- a completely separate, concurrently running game.
    let player_b = Addr::unchecked("player_b");
    let create_b = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("room B creation should succeed");
    let game_id_b: u64 = attr(&create_b, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id_b);
    // Audit G-6: this scenario's subject is share-selling mechanics, not
    // first-round legality -- fast-forward past the Stock Round 1 sale ban.
    advance_past_first_stock_round(&mut deps.storage, game_id_b);
    assert_ne!(game_id_a, game_id_b);

    // A second room B player -- same reason as player_a2 above: player_b
    // ends up President of room B's PRR and later sells part of their
    // stake, which now requires another player already holding a legal
    // 20% successor block.
    let player_c = Addr::unchecked("player_c");
    execute(
        deps.as_mut(),
        env.clone(),
        // Uniform Ante Rule: must match room B's creator (player_b)
        // 1,000,000 ujuno ante.
        mock_info(player_c.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id: game_id_b },
    )
    .expect("player_c should be able to join room B");

    // Room A: player_a and player_a2 alternate turns buying IPO
    // certificates of PRR at par $67, each reaching 20% (enough to be a
    // legal President/successor pair). player_a buys first and last, so
    // the room's turn pointer lands back on player_a (index 0) once both
    // are done -- exactly where it needs to be for player_a's later sale.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id: game_id_a,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(67)),
        },
    )
    .expect("player_a's first IPO purchase in room A should succeed");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a2.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id: game_id_a,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("player_a2's first IPO purchase in room A should succeed");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id: game_id_a,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("player_a's second IPO purchase in room A should succeed");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a2.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id: game_id_a,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("player_a2's second IPO purchase in room A should succeed");

    // Room B: player_b and player_c alternate the same way, but at a
    // completely different par value ($100) -- proving room B's Par Value
    // Selection is independent of room A's. player_b buys first and last
    // so the pointer lands back on player_b for their later sale.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id: game_id_b,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("player_b's first IPO purchase in room B should succeed");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_c.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id: game_id_b,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("player_c's first IPO purchase in room B should succeed");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id: game_id_b,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("player_b's second IPO purchase in room B should succeed");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_c.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id: game_id_b,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("player_c's second IPO purchase in room B should succeed");

    assert_eq!(
        PROTOCOL_PAR_VALUE
            .load(&deps.storage, (game_id_a, PRR_COMPANY_ID))
            .unwrap(),
        Uint128::new(67)
    );
    assert_eq!(
        PROTOCOL_PAR_VALUE
            .load(&deps.storage, (game_id_b, PRR_COMPANY_ID))
            .unwrap(),
        Uint128::new(100)
    );

    // Room A's President declares a Distribute Yield dividend -- this must
    // move *only* room A's PRR marker, from (6, 5)/$67 to (7, 5)/$71.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::DeclareDividends {
            game_id: game_id_a,
            protocol_id: PRR_COMPANY_ID,
            revenue_amount: Uint128::new(100),
            distribute: true,
        },
    )
    .expect("player_a should be able to declare a dividend in room A");

    // Room B: player_b sells one certificate back onto room B's own Bank
    // pool. It must settle at room B's own, untouched $100 par-cell price
    // -- NOT room A's freshly-moved $71 -- proving the two rooms' price
    // markers for the same protocol_id are fully independent.
    let sell_res_b = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id: game_id_b,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .expect("player_b should be able to sell in room B");
    assert_eq!(
        attr(&sell_res_b, "total_proceeds"),
        "100",
        "room B's PRR price must be unaffected by room A's dividend-driven move"
    );

    // Symmetrically, room A's own Bank-pool sale must reflect room A's
    // post-dividend $71, not room B's untouched $100.
    let sell_res_a = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id: game_id_a,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .expect("player_a should be able to sell in room A");
    assert_eq!(attr(&sell_res_a, "total_proceeds"), "71");
}

/// Exercises the Event-Sourced Ledger's `UndoLastAction` end to end. Floats
/// PRR via six IPO purchases (the same setup as
/// `public_company_floats_at_sixty_percent_player_ownership`), then undoes
/// just the 6th, float-triggering purchase and confirms
/// `reapply_game_log`'s reset-then-replay actually recomputes the whole
/// room back to its exact pre-6th-purchase snapshot -- balance, share
/// count, the IPO pool, and PRR's floated/treasury/issuance state -- not
/// merely that the log itself got one entry shorter. Also confirms a
/// *different* registered player (not the one who bought the shares) can
/// trigger the undo, per the "any player in the room" authorization rule.
#[test]
fn undo_last_action_reverts_the_float_triggering_purchase() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let buyer = Addr::unchecked("buyer");
    let second_player = Addr::unchecked("second_player");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        // Uniform Ante Rule: must match the creator's 1,000,000 ujuno ante.
        mock_info(second_player.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("second_player should be able to join");

    const PRR_COMPANY_ID: u32 = 1;

    // `BuyStock` is turn-gated (buyer is the room creator, so starts as the
    // active player at index 0); every purchase advances the pointer to
    // second_player, so second_player passes right back after each one to
    // keep the buyer's next purchase legal. par_values holds each of the
    // first 5 purchases' par_value argument: only the very first-ever IPO
    // buy needs one set.
    let par_values = [Some(Uint128::new(100)), None, None, None, None];
    for par_value in par_values {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(buyer.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_COMPANY_ID,
                source: SharePurchaseSource::Ipo,
                par_value,
            },
        )
        .expect("buyer should be able to buy PRR certificates below the float threshold");
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(second_player.as_str(), &[]),
            ExecuteMsg::PassTurn { game_id },
        )
        .expect("second_player should be able to pass their turn back to the buyer");
    }

    // Snapshot every piece of state `reapply_game_log` is responsible for
    // recomputing, immediately before the float-triggering 6th purchase.
    let balance_before_float = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, buyer.clone()))
        .unwrap();
    let shares_before_float = PLAYER_SHARES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID, buyer.clone()))
        .unwrap();
    let ipo_pool_before_float = IPO_POOL_SHARES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert_eq!(shares_before_float, 50);

    // The 6th certificate pushes real-player ownership to exactly 60%,
    // floating PRR -- exactly like
    // `public_company_floats_at_sixty_percent_player_ownership`.
    let float_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("the 6th certificate purchase (60%) should succeed and float PRR");
    assert_eq!(attr(&float_res, "newly_floated"), "true");

    let prr_after_float = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert!(prr_after_float.is_floated);
    assert_eq!(prr_after_float.total_shares_issued, 10);
    assert_eq!(prr_after_float.treasury, Uint128::new(1_000));

    let log_before_undo = GAME_LOG.load(&deps.storage, game_id).unwrap();
    assert_eq!(
        log_before_undo.len(),
        11,
        "5 turn-gated BuyStock/PassTurn pairs (10 entries) plus the 6th, \
         float-triggering BuyStock should have been recorded to the log"
    );

    // second_player -- who never bought a single share -- triggers the
    // undo, proving any registered player (not just the actor being
    // undone) may call UndoLastAction. It's second_player's turn right
    // now (the float-triggering buy just advanced the pointer to them),
    // but UndoLastAction is deliberately not turn-gated -- undoing is a
    // room-wide safety valve, not a Stock Round action.
    let undo_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(second_player.as_str(), &[]),
        ExecuteMsg::UndoLastAction { game_id },
    )
    .expect("second_player should be able to undo the last action in their game room");
    assert_eq!(attr(&undo_res, "remaining_log_length"), "10");

    let log_after_undo = GAME_LOG.load(&deps.storage, game_id).unwrap();
    assert_eq!(log_after_undo.len(), 10);

    // The float-triggering purchase must be fully un-done: PRR back to
    // unfloated, zero treasury, zero issued shares.
    let prr_after_undo = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert!(
        !prr_after_undo.is_floated,
        "undoing the float-triggering purchase should un-float PRR"
    );
    assert_eq!(prr_after_undo.total_shares_issued, 0);
    assert_eq!(prr_after_undo.treasury, Uint128::zero());

    // The buyer's cash, share count, and the IPO pool must all be back to
    // their exact pre-6th-purchase snapshot -- proof this is a full
    // reset-and-replay, not just a log truncation.
    let balance_after_undo = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, buyer.clone()))
        .unwrap();
    assert_eq!(balance_after_undo, balance_before_float);

    let shares_after_undo = PLAYER_SHARES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID, buyer.clone()))
        .unwrap();
    assert_eq!(shares_after_undo, shares_before_float);

    let ipo_pool_after_undo = IPO_POOL_SHARES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert_eq!(ipo_pool_after_undo, ipo_pool_before_float);

    // second_player, who never transacted, must be untouched throughout.
    let second_player_balance = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, second_player.clone()))
        .unwrap();
    assert_eq!(second_player_balance, Uint128::new(1_200));
}

/// Exercises the base Turn Priority Queue primitive: `PassTurn` is gated to
/// only the currently active player, advances the pointer to the next
/// player in join order (wrapping around), and is itself logged to
/// `GAME_LOG` like any other tracked action.
#[test]
fn pass_turn_is_gated_to_the_active_player_and_wraps_around() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let player_two = Addr::unchecked("player_two");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_two.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_two should be able to join");

    // The room creator (player_one, joined first) is the active player at
    // index 0; player_two must not be able to pass out of turn.
    let out_of_turn_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_two.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(
            out_of_turn_err,
            ContractError::GameLog(crate::gamelog::GameLogError::NotActivePlayer { .. })
        ),
        "expected NotActivePlayer, got: {out_of_turn_err:?}"
    );

    // player_one passes; the pointer must advance to player_two (index 1).
    let pass_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .expect("the active player should be able to pass");
    assert_eq!(attr(&pass_res, "new_active_player_index"), "1");
    assert_eq!(attr(&pass_res, "new_active_player"), player_two.as_str());

    let session_after_first_pass = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session_after_first_pass.active_player_index, 1);

    // player_two passes; the pointer must wrap back around to player_one
    // (index 0).
    let wrap_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_two.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .expect("player_two should be able to pass once it's their turn");
    assert_eq!(attr(&wrap_res, "new_active_player_index"), "0");
    assert_eq!(attr(&wrap_res, "new_active_player"), player_one.as_str());

    let log = GAME_LOG.load(&deps.storage, game_id).unwrap();
    assert_eq!(
        log.len(),
        2,
        "both successful PassTurn calls should have been recorded to the log"
    );
}

/// Exercises the Stock Round turn-enforcement guardrail on `BuyStock`,
/// `SellStock`, and `BidOnPrivate`: an out-of-turn attempt at any of the
/// three is cleanly rejected (each module's own `NotYourTurn` variant,
/// wrapped into `ContractError`) without touching any state, and a
/// successful in-turn call from any of the three advances
/// `active_player_index` to the next player and resets
/// `consecutive_passes` back to `0` -- exactly the pointer-advance half of
/// what `PassTurn` does, with the counter itself moving the opposite way.
#[test]
fn out_of_turn_trades_are_rejected_and_successful_trades_advance_the_turn_pointer() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    // Audit G-6: this scenario's subject is share-selling mechanics, not
    // first-round legality -- fast-forward past the Stock Round 1 sale ban.
    advance_past_first_stock_round(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_COMPANY_ID: u32 = 1;

    // player_a (the creator) is the active player at index 0. player_b
    // attempting any of the three turn-gated actions right now must be
    // cleanly rejected, before any state is touched.
    let buy_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            buy_err,
            ContractError::Trading(TradingError::NotYourTurn { .. })
        ),
        "expected Trading(NotYourTurn), got: {buy_err:?}"
    );

    let sell_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            sell_err,
            ContractError::Trading(TradingError::NotYourTurn { .. })
        ),
        "expected Trading(NotYourTurn), got: {sell_err:?}"
    );

    let bid_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 1, // Schuylkill Valley
            bid_amount: Uint128::new(20),
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            bid_err,
            ContractError::Auction(AuctionError::NotYourTurn { .. })
        ),
        "expected Auction(NotYourTurn), got: {bid_err:?}"
    );

    // None of the three rejected attempts should have touched player_b's
    // balance, thanks to CosmWasm's atomic-revert-on-Err semantics.
    let player_b_balance_after_rejections = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_b.clone()))
        .unwrap();
    assert_eq!(player_b_balance_after_rejections, Uint128::new(1_200));

    // Cycle a full round of passes to prove `consecutive_passes` increments
    // on each one (the opposite of what a trade does to it): player_a
    // passes (index -> 1, streak -> 1), then player_b passes (index -> 0,
    // streak -> 2).
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .expect("player_a should be able to pass their turn");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .expect("player_b should be able to pass their turn");

    let session_after_passes = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session_after_passes.active_player_index, 0);
    assert_eq!(session_after_passes.consecutive_passes, 2);

    // player_a (now correctly the active player again) wins the Schuylkill
    // Valley private. This must succeed, advance the pointer to player_b,
    // and reset consecutive_passes back to 0 -- breaking the streak just
    // built up.
    let balance_before_bid = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 1, // Schuylkill Valley
            bid_amount: Uint128::new(20),
        },
    )
    .expect("player_a's in-turn bid should succeed");

    let balance_after_bid = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    assert_eq!(
        balance_before_bid.checked_sub(balance_after_bid).unwrap(),
        Uint128::new(20)
    );

    let session_after_bid = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(
        session_after_bid.active_player_index, 1,
        "a successful bid should advance the turn pointer to player_b"
    );
    assert_eq!(
        session_after_bid.consecutive_passes, 0,
        "a successful trade should reset the all-pass streak back to 0"
    );

    // Now it's player_b's turn -- player_a attempting any of the three
    // turn-gated actions must be rejected again, and must not touch
    // player_a's balance.
    let buy_err_2 = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .unwrap_err();
    assert!(matches!(
        buy_err_2,
        ContractError::Trading(TradingError::NotYourTurn { .. })
    ));

    let sell_err_2 = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .unwrap_err();
    assert!(matches!(
        sell_err_2,
        ContractError::Trading(TradingError::NotYourTurn { .. })
    ));

    let bid_err_2 = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 2, // Champlain & St. Lawrence
            bid_amount: Uint128::new(40),
        },
    )
    .unwrap_err();
    assert!(matches!(
        bid_err_2,
        ContractError::Auction(AuctionError::NotYourTurn { .. })
    ));

    let player_a_balance_final = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    assert_eq!(
        player_a_balance_final, balance_after_bid,
        "player_a's balance must be untouched by the three rejected out-of-turn attempts"
    );
}

/// Global Certificate Limit (module doc comment #12 in `trading.rs`): a
/// 6-player room caps every player at 11 total certificates (private
/// companies + 10%-share blocks combined). Rather than play out 11
/// turn-gated purchases to reach the cap, this test seeds `PLAYER_SHARES`
/// directly via storage -- a deliberate shortcut that isolates the
/// certificate-counting/rejection logic from purchase mechanics already
/// covered by other tests.
#[test]
fn buy_stock_rejects_purchase_exceeding_global_certificate_limit() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 6,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    for name in ["player_2", "player_3", "player_4", "player_5", "player_6"] {
        execute(
            deps.as_mut(),
            env.clone(),
            // Uniform Ante Rule: must match player_one's 1,000,000 ujuno ante.
            mock_info(name, &coins(1_000_000, NATIVE_DENOM)),
            ExecuteMsg::JoinGameRoom { game_id },
        )
        .expect("joiner should be able to join");
    }

    // Seed player_one at 60% of company 1 (6 certificates) + 50% of
    // company 2 (5 certificates) = 11 certificates -- exactly the 6-player
    // cap -- without needing to play out 11 real purchases first.
    PLAYER_SHARES
        .save(
            deps.as_mut().storage,
            (game_id, 1, player_one.clone()),
            &60u8,
        )
        .unwrap();
    PLAYER_SHARES
        .save(
            deps.as_mut().storage,
            (game_id, 2, player_one.clone()),
            &50u8,
        )
        .unwrap();

    let balance_before = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();

    // player_one (the creator) is still the active player at index 0, so
    // this purchase is not blocked by turn order -- only by the
    // certificate limit, which is checked before any state is touched.
    let buy_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: 3, // CPR -- a company player_one holds none of yet
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(67)),
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            buy_err,
            ContractError::Trading(TradingError::ExceededCertificateLimit { .. })
        ),
        "expected Trading(ExceededCertificateLimit), got: {buy_err:?}"
    );

    // This check fires before any writes in `execute_buy_stock`, so
    // player_one's balance and CPR's par value must be completely
    // untouched by the rejected attempt.
    let balance_after = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();
    assert_eq!(balance_after, balance_before);
    assert!(PROTOCOL_PAR_VALUE
        .may_load(&deps.storage, (game_id, 3))
        .unwrap()
        .is_none());
}

/// Global Certificate Limit, hard-block edition (`trading.rs` module doc
/// comments #2/#12): two things this pass fixed, both exercised here in one
/// end-to-end scenario against a 6-player room (cap 11, per
/// `CERTIFICATE_LIMIT_BY_PLAYER_COUNT`).
///
/// 1. **President's certificate counts as exactly 1, not 2.** player_one is
///    seeded as President of two companies at 60% each -- 130% of raw share
///    percentage combined. A naive `held_pct / PERCENT_PER_SHARE` count
///    would read this as `6 + 6 = 12` certificates from those two companies
///    alone, already over an 11-player-count cap before counting anything
///    else -- which would be wrong: two 60%-President holdings are legally
///    just `(1 + 4) + (1 + 4) = 10` certificates (each company's President
///    card counts once, not twice). Plus one ordinary 10% stake elsewhere
///    brings player_one to exactly 11 -- AT the cap, not over it -- which is
///    only correct under the fixed counting.
/// 2. **The limit is a strict, hard block** -- at exactly the cap, the next
///    certificate in an ordinary (`Normal`-zone) company is rejected
///    outright, with zero state touched, confirming this is enforcement,
///    not a warning.
/// 3. **Yellow/Orange/Brown zone exemption.** That same at-the-cap player
///    can still buy a certificate of a DIFFERENT company whose live market
///    position sits on a `YellowZone` cell (seeded directly via
///    `market::set_protocol_position` to `(0, 10)` -- a real `YellowZone`
///    cell per `market::REAL_MARKET_ROWS`'s row `y=10`) -- the purchase
///    succeeds despite the player already sitting at the cap, since a
///    certificate whose company is currently in an exempt zone doesn't
///    count toward the Global Certificate Limit check at all.
#[test]
fn buy_stock_hard_blocks_at_certificate_limit_but_exempts_zone_purchases() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 6,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    for name in ["player_2", "player_3", "player_4", "player_5", "player_6"] {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(name, &coins(1_000_000, NATIVE_DENOM)),
            ExecuteMsg::JoinGameRoom { game_id },
        )
        .expect("joiner should be able to join");
    }

    const PRR_ID: u32 = 1;
    const NYC_ID: u32 = 2;
    const CPR_ID: u32 = 3;
    const ERIE_ID: u32 = 6; // used for the blocked (Normal-zone) attempt
    const CO_ID: u32 = 5; // used for the zone-exempt attempt

    // Seed player_one as President of PRR and NYC at 60% each (direct
    // storage seeding -- the same isolation shortcut the sibling test above
    // uses -- so this scenario doesn't need to play out 12 real turn-gated
    // purchases first).
    for company_id in [PRR_ID, NYC_ID] {
        PLAYER_SHARES
            .save(deps.as_mut().storage, (game_id, company_id, player_one.clone()), &60u8)
            .unwrap();
        PROTOCOL_PRESIDENT
            .save(deps.as_mut().storage, (game_id, company_id), &player_one)
            .unwrap();
    }
    // One ordinary 10% stake in CPR, no presidency -- +1 certificate.
    PLAYER_SHARES
        .save(deps.as_mut().storage, (game_id, CPR_ID, player_one.clone()), &10u8)
        .unwrap();

    // Fixed count: (1 + 4) + (1 + 4) + 1 = 11 -- exactly the 6-player cap.
    // (The old, buggy `held_pct / 10` count would have read this as
    // 6 + 6 + 1 = 13, already 2 over the cap.)

    let balance_before = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();

    // -- Part 1: blocked. ERIE's par cell is a `Normal`-zone cell (none of
    // the six real par cells carry a non-Normal zone -- see
    // `StockMarketRenderer.tsx` design note #4), so this 12th certificate is
    // NOT zone-exempt: it must be hard-rejected.
    let blocked_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: ERIE_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(67)),
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            blocked_err,
            ContractError::Trading(TradingError::ExceededCertificateLimit { .. })
        ),
        "expected Trading(ExceededCertificateLimit), got: {blocked_err:?}"
    );

    // This is a genuine hard block -- zero state touched by the rejected
    // attempt.
    let balance_after_block = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();
    assert_eq!(balance_after_block, balance_before);
    assert!(PROTOCOL_PAR_VALUE
        .may_load(&deps.storage, (game_id, ERIE_ID))
        .unwrap()
        .is_none());
    assert_eq!(
        PLAYER_SHARES
            .may_load(&deps.storage, (game_id, ERIE_ID, player_one.clone()))
            .unwrap()
            .unwrap_or(0),
        0
    );

    // -- Part 2: zone-exempt. Pin C&O's live market position directly to
    // (0, 10) -- a real YellowZone cell -- and seed a full Bank pool for it,
    // then buy from the Bank. Still the SAME at-the-cap player_one, but this
    // purchase must succeed: a certificate in a Yellow/Orange/Brown zone
    // doesn't count toward the Global Certificate Limit at all.
    market::set_protocol_position(deps.as_mut().storage, game_id, CO_ID, 0, 10)
        .expect("seeding C&O's market position should succeed");
    BANK_POOL_SHARES
        .save(deps.as_mut().storage, (game_id, CO_ID), &100u8)
        .unwrap();

    let exempt_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: CO_ID,
            source: SharePurchaseSource::Bank,
            par_value: None,
        },
    )
    .expect("a Yellow-zone certificate should bypass the Global Certificate Limit entirely");
    assert_eq!(attr(&exempt_res, "buyer_percentage"), "10");
    assert_eq!(attr(&exempt_res, "price_paid"), "60"); // (0, 10)'s real price

    assert_eq!(
        PLAYER_SHARES
            .load(&deps.storage, (game_id, CO_ID, player_one.clone()))
            .unwrap(),
        10
    );
    assert_eq!(
        BANK_POOL_SHARES.load(&deps.storage, (game_id, CO_ID)).unwrap(),
        90
    );
}

/// Corporate Ownership Cap (module doc comment #10 in `trading.rs`, the
/// pre-existing 60% rule): a single player may hold at most 60% of any one
/// company. This test also documents the "no atomic revert in direct-call
/// unit tests" nuance -- the rejected 7th purchase's `IPO_POOL_SHARES`
/// write does persist here (this check runs after that write, inside
/// `execute_buy_stock`), even though the real deployed contract would
/// revert it along with everything else in the failed transaction. Only
/// state genuinely untouched by that ordering is asserted below.
#[test]
fn buy_stock_rejects_purchase_exceeding_corporate_ownership_cap() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let buyer = Addr::unchecked("buyer");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const PRR_COMPANY_ID: u32 = 1;

    // A single-player room: active_player_index always wraps back to 0, so
    // buyer can legally take six consecutive turns to reach 60% ownership.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(67)),
        },
    )
    .expect("first buy should set the par value and succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(buyer.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_COMPANY_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("subsequent buys at the already-set par value should succeed");
    }

    let buyer_pct_at_cap = PLAYER_SHARES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID, buyer.clone()))
        .unwrap();
    assert_eq!(buyer_pct_at_cap, 60);

    let balance_at_cap = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, buyer.clone()))
        .unwrap();

    let buy_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            buy_err,
            ContractError::Trading(TradingError::CertificateLimitExceeded { .. })
        ),
        "expected Trading(CertificateLimitExceeded), got: {buy_err:?}"
    );

    // The 60% check runs before the balance debit and the buyer's own
    // PLAYER_SHARES write, so both remain exactly as they were at the cap
    // -- only IPO_POOL_SHARES (written earlier in the same call) is left
    // partially mutated by this rejected attempt, per this test's doc
    // comment above.
    let balance_after_rejection = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, buyer.clone()))
        .unwrap();
    assert_eq!(balance_after_rejection, balance_at_cap);
    let buyer_pct_after_rejection = PLAYER_SHARES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID, buyer.clone()))
        .unwrap();
    assert_eq!(buyer_pct_after_rejection, 60);
}

/// Turn Pacing (module doc comment #9 in `trading.rs`): `SellStock`
/// validates turn order but never advances `active_player_index`, so a
/// player may sell multiple blocks in a row on their own turn; only
/// `BuyStock` (or `PassTurn`) ends it. `PLAYER_SHARES` is seeded directly
/// so the sequence below can isolate the turn-pointer mechanic from
/// purchase-turn-advancement, choosing percentages (player_a 40%,
/// player_b 20%) that keep player_b a legal President successor
/// throughout, so `NoEligiblePresidentSuccessor` never interferes.
#[test]
fn sell_stock_does_not_advance_turn_but_buy_stock_does() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    // Audit G-6: this scenario's subject is share-selling mechanics, not
    // first-round legality -- fast-forward past the Stock Round 1 sale ban.
    advance_past_first_stock_round(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_COMPANY_ID: u32 = 1;

    PLAYER_SHARES
        .save(
            deps.as_mut().storage,
            (game_id, PRR_COMPANY_ID, player_a.clone()),
            &40u8,
        )
        .unwrap();
    PLAYER_SHARES
        .save(
            deps.as_mut().storage,
            (game_id, PRR_COMPANY_ID, player_b.clone()),
            &20u8,
        )
        .unwrap();

    // First sell: no President is on record yet for PRR, so the
    // successor check doesn't even trigger. player_a is still the active
    // player (index 0) afterward -- selling must not move the pointer.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .expect("player_a's first sell should succeed");
    let session_after_first_sell = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(
        session_after_first_sell.active_player_index, 0,
        "selling must not advance the turn pointer"
    );

    // Second sell, same turn, no PassTurn in between: player_a now holds
    // the President seat (30% > player_b's 20%) from the first sell's
    // recalculation, but player_b's 20% still legally qualifies as a
    // successor, so this is allowed. Still must not move the pointer.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .expect("player_a's second sell, same turn, should also succeed");
    let session_after_second_sell = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(
        session_after_second_sell.active_player_index, 0,
        "a second sell on the same turn must still not advance the turn pointer"
    );

    // The two sells left BANK_POOL_SHARES at 20% for PRR, enough for a
    // Bank-source buy. Only BuyStock (not SellStock) should finally
    // advance the turn pointer to player_b.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Bank,
            par_value: None,
        },
    )
    .expect("player_a's buy should succeed and end their turn");
    let session_after_buy = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(
        session_after_buy.active_player_index, 1,
        "a successful buy must advance the turn pointer to player_b"
    );
}

/// Tech Era Color-Locking (`hexmap.rs` module doc comments #8/#10): a Green
/// tile is rejected until the room's very first 3-train is bought, and a
/// Topology Retention Upgrade must preserve every one of the existing
/// tile's actual edges at some rotation of the new tile -- verified here
/// both for a genuine same-shape upgrade that succeeds (B&O's straight
/// track) and a differently-shaped one that can never succeed
/// (PRR's curve, upgraded against a tile whose only possible rotations are
/// an opposite-edge pair that a 2-edge curve can never match). A single
/// solo room hosts both companies so every action here -- turn-gated or
/// not -- always finds the lone player already at the active turn index.
#[test]
fn lay_tile_enforces_era_color_locking_and_upgrade_topology_retention() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const PRR_ID: u32 = 1;

    // Float B&O by winning its private (see `full_game_simulation` for the
    // same recipe) -- player_one becomes B&O's President, treasury $670.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // B&O's home tile / Token Station: a free straight-track tile (tile_id
    // 1, edges 0 & 3), unconditionally accepted at whichever orientation is
    // submitted (orientation 0 here, matching this tile's prior
    // auto-picked default).
    let home_orientation = lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 0, 0, 9);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 9,
            orientation: home_orientation,
        },
    )
    .expect("B&O's home tile should be free to lay");

    // Attempting to upgrade it to the Green straight-track tile (11) before
    // any 3-train has ever been bought must be rejected -- Green isn't
    // unlocked yet.
    let era_locked_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 23,
            // Any in-range orientation rejects identically here -- Tech Era
            // color-locking (module doc comment #8) is checked before any
            // orientation-specific legality rule.
            orientation: 0,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            era_locked_err,
            ContractError::HexMap(HexMapError::EraLocked { .. })
        ),
        "expected HexMap(EraLocked), got: {era_locked_err:?}"
    );

    // Float PRR by buying it up to 60% in six consecutive IPO purchases
    // (see `buy_stock_rejects_purchase_exceeding_corporate_ownership_cap`
    // for the same recipe) -- player_one becomes PRR's President too,
    // treasury also $670.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(67)),
        },
    )
    .expect("PRR's first IPO purchase should set its par value and succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }

    // PRR's own home tile / Token Station: a free gentle-curve tile
    // (tile_id 2, edges 0 & 2), far away from B&O's network.
    let prr_home_orientation =
        lowest_legal_orientation(&deps.storage, game_id, PRR_ID, 50, 50, 8);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: PRR_ID,
            q: 50,
            r: 50,
            tile_id: 8,
            orientation: prr_home_orientation,
        },
    )
    .expect("PRR's home tile should be free to lay");

    // Directly seed the Hardware pool/purchase-count state to simulate
    // every 2-train already sold -- an established pattern elsewhere in
    // this file for isolating one mechanism from another (see
    // `calculate_operating_order_sorts_by_price_and_breaks_ties_by_arrival_recency`'s
    // own direct market-state seeding). This also sidesteps the Train Limit
    // cap (`hardware.rs` module doc comment #10a -- 4 trains max in Phase
    // 2/3): PRR buying all six 2-trains itself would now be rejected on the
    // 5th purchase, so this test isolates the one purchase it actually
    // cares about -- the room's first-ever 3-train -- from the mechanics of
    // exhausting the 2-train tier, which is exercised elsewhere
    // (`hardware_buy_rusts_lower_tier_and_enforces_train_limit`).
    let mut seeded_pool = HARDWARE_POOL.load(&deps.storage, game_id).unwrap();
    let remaining_pool = seeded_pool.split_off(6);
    HARDWARE_POOL
        .save(deps.as_mut().storage, game_id, &remaining_pool)
        .unwrap();
    TRAINS_PURCHASED_COUNT
        .save(deps.as_mut().storage, (game_id, "2".to_string()), &6)
        .unwrap();

    // PRR buys the room's first-ever 3-train ($180, well within its $670
    // treasury). This single purchase must durably unlock the Green era,
    // room-wide.
    let three_train_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .expect("PRR should be able to afford the room's first 3-train");
    assert_eq!(attr(&three_train_res, "model_type"), "3");
    assert_eq!(attr(&three_train_res, "era_advanced"), "true");
    assert_eq!(attr(&three_train_res, "new_global_era"), "Green");

    let session_after_unlock = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session_after_unlock.current_global_era, TileColor::Green);

    // Retrying B&O's upgrade now succeeds: real 1830 tray #23 (Green
    // plain, base edges {0, 3, 4}) is a strict superset of the existing
    // #9 straight track's {0, 3} at orientation 0, so topology is
    // trivially preserved.
    let bo_upgrade_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 0, 0, 23);
    let upgrade_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 23,
            orientation: bo_upgrade_orientation,
        },
    )
    .expect("B&O's straight-track upgrade should now succeed under the Green era");
    assert_eq!(attr(&upgrade_res, "tile_color"), "Green");
    assert_eq!(attr(&upgrade_res, "is_upgrade"), "true");

    let bo_upgraded_tile = MAP_GRID.load(&deps.storage, (game_id, 0, 0)).unwrap();
    assert_eq!(bo_upgraded_tile.tile_id, 23);
    assert_eq!(bo_upgraded_tile.orientation, 0);

    // PRR's gentle curve (#8, edges {0, 2}) is NOT preserved by #23 at
    // orientation 0: #23's base edges are {0, 3, 4}, which is missing edge
    // 2, so this specific submitted rotation is rejected.
    //
    // CATALOG MIGRATION NOTE (Audit G-5): the old comment here claimed no
    // rotation of the upgrade tile could EVER preserve {0, 2}, which was
    // true of the old 2-edge internal tile 11 but is NOT true of real #23 --
    // its rotation 2 ({0, 2, 5}) would preserve them. The rejection this
    // test asserts is therefore orientation-specific, which is exactly what
    // Enforce Chosen Angle (`hexmap.rs` module doc comment #4) means: the
    // contract validates the rotation actually submitted and never searches
    // for a different one on the caller's behalf.
    let topology_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: PRR_ID,
            q: 50,
            r: 50,
            tile_id: 23,
            // Orientation 0 specifically drops PRR's edge 2 -- see the
            // comment above for why this is a per-rotation rejection
            // rather than a blanket one.
            orientation: 0,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            topology_err,
            ContractError::HexMap(HexMapError::TopologyNotPreserved { .. })
        ),
        "expected HexMap(TopologyNotPreserved), got: {topology_err:?}"
    );

    // PRR's tile must be completely untouched by the rejected upgrade.
    let prr_tile_after_rejection = MAP_GRID.load(&deps.storage, (game_id, 50, 50)).unwrap();
    assert_eq!(prr_tile_after_rejection.tile_id, 8);
}

/// Path Connectivity to an existing Token Station (Node) (`hexmap.rs`
/// module doc comment #9): a tile that isn't adjacent to anything in
/// protocol_id's reachable network is rejected outright, while a tile that
/// *is* adjacent has its legal rotation chosen automatically and extends
/// the network.
#[test]
fn lay_tile_enforces_path_connectivity_to_token_station() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // Home tile / Token Station at (0, 0): straight track, edges 0 & 3.
    let home_orientation = lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 0, 0, 9);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 9,
            orientation: home_orientation,
        },
    )
    .expect("B&O's home tile should be free to lay");

    // (1, 1) is not one of (0, 0)'s six neighbors under
    // `hexmap::HEX_NEIGHBOR_OFFSETS`, so no rotation of any tile placed
    // there could ever legally connect back to the Token Station.
    let disconnected_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 1,
            r: 1,
            tile_id: 8,
            // (1, 1) isn't adjacent to anything laid, so no rotation of
            // any tile could legally connect -- any in-range orientation
            // rejects identically.
            orientation: 0,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            disconnected_err,
            ContractError::HexMap(HexMapError::NoLegalConnection { .. })
        ),
        "expected HexMap(NoLegalConnection), got: {disconnected_err:?}"
    );

    // (1, 0) *is* a true neighbor of (0, 0) (edge 0's offset). Laying a
    // gentle curve (tile 2, base edges 0 & 2) there must automatically pick
    // the one rotation (orientation 1, edges 1 & 3) whose edge 3 legally
    // meets the station's live edge 0.
    let connect_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 1, 0, 8);
    let connect_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 1,
            r: 0,
            tile_id: 8,
            orientation: connect_orientation,
        },
    )
    .expect("a tile truly adjacent to the Token Station should find a legal rotation");
    assert_eq!(attr(&connect_res, "orientation"), "1");

    let extended_tile = MAP_GRID.load(&deps.storage, (game_id, 1, 0)).unwrap();
    assert_eq!(extended_tile.orientation, 1);

    let network_hexes = PROTOCOL_NETWORK_HEXES
        .load(&deps.storage, (game_id, BO_PUBLIC_ID))
        .unwrap();
    assert_eq!(network_hexes, vec![(0, 0), (1, 0)]);
}

/// Station Tokens (`hexmap.rs` module doc comment #23): a corporation's
/// free home Station Token is granted the instant it floats -- via either
/// float path (B&O's free `BidOnPrivate` float, or the ordinary 60%-
/// ownership `BuyStock` float) -- with no `LayTile` call needed at all.
/// NNH ("NYNH"), which as of module doc comment #25's house rule is now
/// assigned New York (G19, axial (6, 6)) as its home, must float normally
/// and receive that free home token like every other corporation.
#[test]
fn station_tokens_granted_free_at_float_for_defined_home_and_for_nnh() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_ID: u32 = 4;
    const PRR_ID: u32 = 1;
    const NNH_ID: u32 = 7;

    // B&O floats for free by winning its private -- its free home Station
    // Token (Baltimore, I15, axial (3, 8)) should already be recorded.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");
    let bo_tokens = PROTOCOL_STATION_HEXES
        .load(&deps.storage, (game_id, BO_ID))
        .unwrap();
    assert_eq!(
        bo_tokens,
        vec![(3, 8)],
        "B&O's free home token should be at Baltimore (I15)"
    );

    // PRR floats at 60% real-player ownership -- its home token (Altoona,
    // H12, axial (2, 7)) should be granted on that exact purchase.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }
    let prr_tokens = PROTOCOL_STATION_HEXES
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(
        prr_tokens,
        vec![(2, 7)],
        "PRR's free home token should be at Altoona (H12)"
    );

    // NNH's home hex is now New York (G19, axial (6, 6)) -- module doc
    // comment #25's house rule -- so it should float normally and receive
    // that free home token like every other corporation.
    //
    // Funding this float needs a second player: winning the B&O private
    // (220) plus fully floating PRR (600) already commits $820 of
    // player_one's own $1200 starting capital, leaving only $380 -- not
    // enough to solo-fund NNH's own $600 float the way PRR's was. player_two
    // joins and the six IPO certificates alternate turn-for-turn between
    // the two players (`BuyStock` advances the turn pointer to the next
    // REGISTERED player on every successful call, so once a second player
    // is registered, consecutive purchases must alternate) -- which
    // conveniently also splits the $600 cost three certificates ($300) to
    // a side, well within both budgets.
    let player_two = Addr::unchecked("player_two");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_two.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_two should be able to join");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: NNH_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("NNH's first IPO purchase should succeed");
    // The turn pointer is now on player_two (this room's 2nd registered
    // player) -- alternate the remaining 5 purchases to match, ending on
    // player_two's 3rd certificate, which crosses the 60% float threshold.
    let nnh_buyers = [&player_two, &player_one, &player_two, &player_one, &player_two];
    for buyer in nnh_buyers {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(buyer.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: NNH_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("NNH's subsequent IPO purchases should succeed and float it at 60%");
    }
    let nnh_company = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, NNH_ID))
        .unwrap();
    assert!(nnh_company.is_floated, "NNH should still float normally");
    let nnh_tokens = PROTOCOL_STATION_HEXES
        .may_load(&deps.storage, (game_id, NNH_ID))
        .unwrap()
        .unwrap_or_default();
    assert_eq!(
        nnh_tokens,
        vec![(6, 6)],
        "NNH's free home token should be at New York (G19), per module doc comment #25's house rule, got: {nnh_tokens:?}"
    );
}

/// Station Tokens (`hexmap.rs` module doc comment #23): `station_token_cost`/
/// `station_token_limit`'s fixed tables, checked directly -- no game setup
/// needed, since both are pure functions of an ordinal/company id.
#[test]
fn station_token_cost_and_limit_are_priced_correctly() {
    assert_eq!(hexmap::station_token_cost(1), Uint128::zero(), "1st (home) token is free");
    assert_eq!(hexmap::station_token_cost(2), Uint128::new(40), "2nd token costs 40 VGP");
    assert_eq!(hexmap::station_token_cost(3), Uint128::new(100), "3rd token costs 100 VGP");
    assert_eq!(hexmap::station_token_cost(4), Uint128::new(100), "every token after the 2nd costs 100 VGP");

    // PRR / NYC / CPR: 4 tokens each.
    assert_eq!(hexmap::station_token_limit(1), 4);
    assert_eq!(hexmap::station_token_limit(2), 4);
    assert_eq!(hexmap::station_token_limit(3), 4);
    // B&O / C&O / ERIE: 3 tokens each.
    assert_eq!(hexmap::station_token_limit(4), 3);
    assert_eq!(hexmap::station_token_limit(5), 3);
    assert_eq!(hexmap::station_token_limit(6), 3);
    // NNH / B&M: 2 tokens each.
    assert_eq!(hexmap::station_token_limit(7), 2);
    assert_eq!(hexmap::station_token_limit(8), 2);
}

/// Station Tokens (`hexmap.rs` module doc comment #23):
/// `execute_place_station_token`'s full rule set for every token AFTER the
/// free home one -- must target an already-laid `MajorCityHub`/
/// `DoubleCityHub` tile, must be reachable from the protocol's own track
/// network, must not already carry that protocol's own token, must not
/// already have hit its token limit, must not repeat within the same
/// Operating Round sub-round, and is correctly priced at 40 VGP for the 2nd
/// token overall (the home token, granted separately at float, is the 1st).
#[test]
fn execute_place_station_token_enforces_city_reachability_duplicate_and_subround_rules() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_ID: u32 = 4;
    const PRR_ID: u32 = 1;
    const HUB_TILE: u32 = 57; // real 1830 tray #57 -- THE yellow city tile (edges 0 & 3)
    const ALTOONA: (i32, i32) = (2, 7); // PRR's home (H12) -- real GRAY preprinted track,
                                         // so no tile can ever be laid here (Gray Hex
                                         // Immutability); it's still a valid Station Token
                                         // target via `station_token_reachable_hexes`'s
                                         // GRAY-city fallback (module doc comment #23).
    const PITTSBURGH: (i32, i32) = (1, 7); // Altoona's real neighbor, city-designated but
                                            // WHITE (bare placeholder) -- a real tile CAN be
                                            // laid here, unlike Altoona itself.
    const NEW_YORK: (i32, i32) = (6, 6); // a landmark, but nowhere near PRR's network

    // Float B&O and lay its own first tile at New York -- a real city tile
    // that exists on the shared MAP_GRID, but is nowhere near PRR's own
    // track network, to exercise `StationTokenHexNotReachable` below.
    // Module doc comment #28: New York is now "NY"-label-restricted at
    // every tier (not just Green/Brown), so the generic Yellow `HUB_TILE`
    // (#57) is no longer legal there -- bump the room's era to Green and lay
    // New York's own designated Green hub tile (#54) instead, exactly as
    // `lay_tile_enforces_landmark_reservation` does for this identical hex.
    // (Yellow-tier tiles elsewhere, like PRR's own `HUB_TILE` lay at
    // Pittsburgh below, remain legal once the era is Green -- the era gate
    // only rejects a tile whose OWN color exceeds the current era, module
    // doc comment #8.)
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6,
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");
    const NY_HUB_TILE: u32 = 54; // real 1830 tray #54 -- Green "NY" double-city hub
    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();
    let ny_orientation = lowest_legal_orientation(
        &deps.storage,
        game_id,
        BO_ID,
        NEW_YORK.0,
        NEW_YORK.1,
        NY_HUB_TILE,
    );
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_ID,
            q: NEW_YORK.0,
            r: NEW_YORK.1,
            tile_id: NY_HUB_TILE,
            orientation: ny_orientation,
        },
    )
    .expect("B&O's home hub tile at New York should succeed");

    // Float PRR (granting its free home token at Altoona), then lay its own
    // very first REAL tile at Pittsburgh -- Altoona itself can never receive
    // a laid tile (it's real GRAY preprinted track), so PRR's actual
    // `PROTOCOL_NETWORK_HEXES` station has to be established somewhere else;
    // Pittsburgh, Altoona's true neighbor, is the natural choice.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }
    let prr_tokens_at_float = PROTOCOL_STATION_HEXES
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(
        prr_tokens_at_float,
        vec![ALTOONA],
        "PRR's free home token should already be at Altoona, before any LayTile call"
    );

    let pittsburgh_orientation = lowest_legal_orientation(
        &deps.storage,
        game_id,
        PRR_ID,
        PITTSBURGH.0,
        PITTSBURGH.1,
        HUB_TILE,
    );
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: PRR_ID,
            q: PITTSBURGH.0,
            r: PITTSBURGH.1,
            tile_id: HUB_TILE,
            orientation: pittsburgh_orientation,
        },
    )
    .expect("PRR's first real tile, laid at Pittsburgh (Altoona's neighbor), should succeed");

    // A hex with no laid tile at all, and not a GRAY city either, is
    // rejected as "not a city."
    let not_a_city_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::PlaceStationToken {
            game_id,
            protocol_id: PRR_ID,
            q: 50,
            r: 50,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            not_a_city_err,
            ContractError::HexMap(HexMapError::StationTokenHexNotACity { .. })
        ),
        "expected HexMap(StationTokenHexNotACity), got: {not_a_city_err:?}"
    );

    // New York is a real city tile, but nowhere near PRR's own network.
    let not_reachable_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::PlaceStationToken {
            game_id,
            protocol_id: PRR_ID,
            q: NEW_YORK.0,
            r: NEW_YORK.1,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            not_reachable_err,
            ContractError::HexMap(HexMapError::StationTokenHexNotReachable { .. })
        ),
        "expected HexMap(StationTokenHexNotReachable), got: {not_reachable_err:?}"
    );

    // PRR's own home hex (Altoona) already carries its free home token
    // (granted at float) -- placing again there is rejected as a
    // duplicate. This also confirms Altoona itself correctly resolves as
    // both "a real city" and "reachable" despite carrying no laid tile --
    // if either check had failed instead, a different error would surface
    // here, not this one.
    let duplicate_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::PlaceStationToken {
            game_id,
            protocol_id: PRR_ID,
            q: ALTOONA.0,
            r: ALTOONA.1,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            duplicate_err,
            ContractError::HexMap(HexMapError::StationTokenAlreadyOnHex { .. })
        ),
        "expected HexMap(StationTokenAlreadyOnHex), got: {duplicate_err:?}"
    );

    // Directly seed PROTOCOL_LAST_TOKEN_SUBROUND to the room's current
    // (still-genesis, since BeginOperatingRound was never called)
    // (macro_round_number, sub_round_index) pair -- simulating "PRR already
    // placed a token this sub-round" without needing to actually play
    // through an Operating Round, the same direct-storage-seeding technique
    // `begin_operating_round_paces_multiple_operating_rounds_for_higher_train_tiers`
    // already uses elsewhere in this file. Pittsburgh is otherwise a fully
    // valid target (real tile, reachable, no PRR token yet, under limit),
    // so this isolates the sub-round gate specifically.
    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    PROTOCOL_LAST_TOKEN_SUBROUND
        .save(
            deps.as_mut().storage,
            (game_id, PRR_ID),
            &(session.macro_round_number, session.sub_round_index),
        )
        .unwrap();
    let subround_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::PlaceStationToken {
            game_id,
            protocol_id: PRR_ID,
            q: PITTSBURGH.0,
            r: PITTSBURGH.1,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            subround_err,
            ContractError::HexMap(HexMapError::StationTokenAlreadyPlacedThisSubRound { .. })
        ),
        "expected HexMap(StationTokenAlreadyPlacedThisSubRound), got: {subround_err:?}"
    );

    // Clearing the seeded marker (as a real `EndOperatingRoundTurn`/
    // `BeginOperatingRound` call advancing to a new sub-round would) lifts
    // the gate -- the identical call now succeeds, at the 2nd token's 40
    // VGP price (Altoona's free home token was the 1st).
    PROTOCOL_LAST_TOKEN_SUBROUND.remove(deps.as_mut().storage, (game_id, PRR_ID));

    let prr_treasury_before_token = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap()
        .treasury;

    let place_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::PlaceStationToken {
            game_id,
            protocol_id: PRR_ID,
            q: PITTSBURGH.0,
            r: PITTSBURGH.1,
        },
    )
    .expect("PRR's 2nd Station Token, at a real reachable city with no token yet, should succeed");
    assert_eq!(attr(&place_res, "token_ordinal"), "2");
    assert_eq!(attr(&place_res, "cost"), "40");
    assert_eq!(attr(&place_res, "tokens_placed"), "2");
    assert_eq!(attr(&place_res, "tokens_remaining"), "2"); // PRR's limit is 4

    let prr_tokens = PROTOCOL_STATION_HEXES
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(prr_tokens, vec![ALTOONA, PITTSBURGH]);

    let prr_after = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(
        prr_after.treasury,
        prr_treasury_before_token - Uint128::new(40),
        "only the 2nd token's own 40 VGP cost should be charged here"
    );

    // Pittsburgh now already carries PRR's own token -- placing again there
    // is rejected the same way Altoona was above.
    let duplicate_again_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::PlaceStationToken {
            game_id,
            protocol_id: PRR_ID,
            q: PITTSBURGH.0,
            r: PITTSBURGH.1,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            duplicate_again_err,
            ContractError::HexMap(HexMapError::StationTokenAlreadyOnHex { .. })
        ),
        "expected HexMap(StationTokenAlreadyOnHex), got: {duplicate_again_err:?}"
    );
}

/// Landmark Reservation (`hexmap.rs` module doc comment #11): New York,
/// Boston, and Baltimore are reserved exclusively for their designated
/// major-city hub tile artwork -- a landmark hex rejects a generic tile,
/// an ordinary hex rejects a hub tile, and the correct pairing succeeds.
#[test]
fn lay_tile_enforces_landmark_reservation() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const NEW_YORK_Q: i32 = 6;
    const NEW_YORK_R: i32 = 6;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // A generic (non-hub) tile can never be laid at the New York landmark.
    // Module doc comment #28: New York's own city_ok branch (`landmark ==
    // Some("New York")`) now fires unconditionally, ahead of the generic
    // landmark/city fallback that used to produce `LandmarkRequiresHubTile`
    // here -- so a non-`NewYorkHub` tile at G19 now rejects with the
    // NY-specific error instead. (`LandmarkRequiresHubTile`/
    // `HubTileMustBeOnLandmark` now only ever fire for non-landmark
    // `CITY_DESIGNATED_HEXES` entries, since all three real landmarks --
    // Boston, Baltimore, New York -- are fully intercepted by their own
    // dedicated "B"/"NY" branches above the generic fallback.)
    let landmark_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 9, // plain straight track
            // Landmark Reservation is checked before any orientation-
            // specific rule -- any in-range orientation rejects identically.
            orientation: 0,
        },
    )
    .unwrap_err();
    match &landmark_err {
        ContractError::HexMap(HexMapError::NewYorkHexRequiresNewYorkHubTile { hex_label, .. }) => {
            // Coordinate Symmetries (`hexmap.rs` module doc comment #15):
            // the error carries New York's real board label, not just the
            // bare axial pair.
            assert_eq!(hex_label, "G19");
        }
        other => panic!("expected HexMap(NewYorkHexRequiresNewYorkHubTile), got: {other:?}"),
    }

    // Symmetrically, a major city hub tile can never be laid off a landmark.
    let hub_off_landmark_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 57, // yellow major city hub
            // Landmark Reservation is checked before any orientation-
            // specific rule -- any in-range orientation rejects identically.
            orientation: 0,
        },
    )
    .unwrap_err();
    match &hub_off_landmark_err {
        ContractError::HexMap(HexMapError::HubTileMustBeOnLandmark { hex_label, .. }) => {
            // (0, 0) isn't one of the real board's 93 hexes at all --
            // `describe_hex` still returns a ready-to-display string rather
            // than `None`, per `hexmap.rs`'s module doc comment #15.
            assert_eq!(hex_label, "(0, 0) [off the authentic 1830 board]");
        }
        other => panic!("expected HexMap(HubTileMustBeOnLandmark), got: {other:?}"),
    }

    // The correct pairing succeeds: B&O's very first tile ever, laid
    // directly at the New York landmark. Module doc comment #28: New York
    // is now "NY"-label-restricted at every tier (not just Green/Brown), so
    // there's no legal Yellow hub tile at this hex any more -- the generic
    // `tile_id: 57` case this test used to exercise here moved to the
    // designated Green `NewYorkHub` tile (17) instead, with era unlocked to
    // Green first. The two "B"/"NY"-specific tests
    // (`lay_tile_enforces_boston_b_label_restriction` and
    // `lay_tile_enforces_new_york_ny_label_restriction`) cover the Yellow
    // rejection itself in detail; this test's own job is just the generic
    // landmark-vs-hub-tile pairing shape, which the Green tile now
    // demonstrates identically.
    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();
    let hub_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, NEW_YORK_Q, NEW_YORK_R, 54);
    let hub_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 54,
            orientation: hub_orientation,
        },
    )
    .expect("the designated hub tile at the New York landmark should succeed");
    assert_eq!(attr(&hub_res, "tile_color"), "Green");
    assert_eq!(attr(&hub_res, "is_upgrade"), "false");

    let ny_tile = MAP_GRID
        .load(&deps.storage, (game_id, NEW_YORK_Q, NEW_YORK_R))
        .unwrap();
    assert_eq!(ny_tile.tile_id, 54);

    // All three reserved landmark coordinates resolve to their real 1830
    // city names; every other hex resolves to none.
    assert_eq!(hexmap::landmark_name_at(6, 6), Some("New York"));
    assert_eq!(hexmap::landmark_name_at(9, 4), Some("Boston"));
    assert_eq!(hexmap::landmark_name_at(3, 8), Some("Baltimore"));
    assert_eq!(hexmap::landmark_name_at(0, 0), None);

    // Coordinate Symmetries: the same three coordinates resolve to their
    // real board labels via `label_for_axial`/`describe_hex`, and the
    // labels resolve back to the identical axial pair via `axial_for_label`
    // -- a full round trip through `BOARD_HEX_LABELS`.
    assert_eq!(hexmap::label_for_axial(6, 6), Some("G19"));
    assert_eq!(hexmap::label_for_axial(9, 4), Some("E23"));
    assert_eq!(hexmap::label_for_axial(3, 8), Some("I15"));
    assert_eq!(hexmap::describe_hex(6, 6), "G19");
    assert_eq!(hexmap::axial_for_label("G19"), Some((6, 6)));
    assert_eq!(hexmap::axial_for_label("E23"), Some((9, 4)));
    assert_eq!(hexmap::axial_for_label("I15"), Some((3, 8)));
}

/// OO Double-City Tile Catalog Enforcement (`hexmap.rs` module doc comment
/// #18): an OO hex rejects an ordinary single-city hub tile, a double-city
/// hub tile rejects everywhere except an OO hex, and the correct pairing
/// succeeds -- the same three-part shape as `lay_tile_enforces_
/// landmark_reservation` just above, for the OO/`DoubleCityHub` split that
/// pass added on top of it.
#[test]
fn lay_tile_enforces_oo_double_city_reservation() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    // Hamilton & Toronto -- one of `OO_DESIGNATED_HEXES`' four entries.
    const D10_Q: i32 = 3;
    const D10_R: i32 = 3;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // Tile 15 (the new Green DoubleCityHub) is era-locked at genesis --
    // directly unlock Green for this room, same shortcut
    // `legal_tile_placements_reflects_topology_retention_upgrade_rules`
    // already uses, since this test is about the City Reservation split,
    // not the era-unlock mechanism.
    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    // An ordinary single-city hub tile can never be laid at an OO hex.
    let single_city_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: D10_Q,
            r: D10_R,
            tile_id: 57, // yellow major city hub -- a single-city tile
            orientation: 0,
        },
    )
    .unwrap_err();
    match &single_city_err {
        ContractError::HexMap(HexMapError::OOHexRequiresDoubleCityHubTile { hex_label, .. }) => {
            assert_eq!(hex_label, "D10");
        }
        other => panic!("expected HexMap(OOHexRequiresDoubleCityHubTile), got: {other:?}"),
    }

    // Symmetrically, a double-city hub tile can never be laid off an OO hex.
    let double_city_off_oo_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 59, // green double-city hub
            orientation: 0,
        },
    )
    .unwrap_err();
    match &double_city_off_oo_err {
        ContractError::HexMap(HexMapError::DoubleCityHubTileMustBeOnOOHex { hex_label, .. }) => {
            assert_eq!(hex_label, "(0, 0) [off the authentic 1830 board]");
        }
        other => panic!("expected HexMap(DoubleCityHubTileMustBeOnOOHex), got: {other:?}"),
    }

    // The correct pairing succeeds: B&O's very first tile ever, laid
    // directly at the Hamilton & Toronto OO hex with its designated
    // double-city hub.
    let hub_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: D10_Q,
            r: D10_R,
            tile_id: 59,
            orientation: 0,
        },
    )
    .expect("the designated double-city hub tile at the Hamilton & Toronto OO hex should succeed");
    assert_eq!(attr(&hub_res, "tile_color"), "Green");
    assert_eq!(attr(&hub_res, "is_upgrade"), "false");

    let d10_tile = MAP_GRID.load(&deps.storage, (game_id, D10_Q, D10_R)).unwrap();
    assert_eq!(d10_tile.tile_id, 59);

    // Every one of `OO_DESIGNATED_HEXES`' four entries resolves; an
    // ordinary hex (including a real single-city GRAY city) resolves to
    // none -- confirming the City Reservation split actually happened, not
    // just that this one hex behaves correctly.
    assert_eq!(hexmap::oo_designation_name_at(0, 4), Some("Detroit & Windsor"));
    assert_eq!(hexmap::oo_designation_name_at(3, 3), Some("Hamilton & Toronto"));
    assert_eq!(hexmap::oo_designation_name_at(3, 4), Some("Dunkirk & Buffalo"));
    assert_eq!(hexmap::oo_designation_name_at(5, 7), Some("Philadelphia & Trenton"));
    assert_eq!(hexmap::oo_designation_name_at(0, 5), None); // Cleveland -- a real single-city GRAY city, not OO
    assert_eq!(hexmap::city_designation_name_at(0, 4), None); // Detroit & Windsor no longer double-counted here
}

/// Canonical Tile Upgrade Restrictions (`hexmap.rs` module doc comment
/// #26): real 1830 labels Boston's hex "B" and restricts its Green-tier
/// upgrade specifically to a dedicated `BostonHub` tile -- narrower than the
/// ordinary landmark match `lay_tile_enforces_landmark_reservation` already
/// covers. Four parts: (1) Boston's YELLOW start is UNAFFECTED by the new
/// restriction -- the ordinary shared `MajorCityHub` tile #57 still succeeds
/// there, same as any other landmark (mirrors `lay_tile_enforces_
/// landmark_reservation`'s own New York case, just at Boston); (2) an
/// ordinary GREEN `MajorCityHub` tile is rejected at Boston once the era
/// reaches Green; (3) the designated `BostonHub` tile is rejected anywhere
/// but Boston; (4) the correct pairing -- `BostonHub` at Boston -- succeeds.
#[test]
fn lay_tile_enforces_boston_b_label_restriction() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const PRR_ID: u32 = 1;
    const BOSTON_Q: i32 = 9;
    const BOSTON_R: i32 = 4;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // (1) Boston's YELLOW start is now ALSO "B"-label-restricted (module doc
    // comment #28): real 1830 never lays a plain Yellow tile at Boston at
    // all -- it's B&M's home station, and its first real lay is straight to
    // the Green BostonHub tile below. This replaces the old (incorrect)
    // "Boston's Yellow start is unaffected" case this test used to assert.
    let boston_yellow_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 57, // yellow major city hub -- ordinary, shared by every landmark
            orientation: 0,
        },
    )
    .unwrap_err();
    match &boston_yellow_err {
        ContractError::HexMap(HexMapError::BHexRequiresBHubTile {
            hex_label,
            b_hex_name,
            ..
        }) => {
            assert_eq!(hex_label, "E23");
            assert_eq!(b_hex_name, "Boston");
        }
        other => panic!("expected HexMap(BHexRequiresBHubTile), got: {other:?}"),
    }

    // Unlock Green room-wide BEFORE B&O's actual first tile ever -- Boston's
    // first real lay is now straight to Green (no legal Yellow step exists
    // at this hex any more) -- same shortcut
    // `lay_tile_enforces_oo_double_city_reservation` already uses.
    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    // (2) An ordinary GREEN major city hub can never upgrade Boston once the
    // B-label restriction applies.
    let ordinary_green_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 14, // ordinary green major city hub -- NOT the B-labeled tile
            orientation: 0,
        },
    )
    .unwrap_err();
    match &ordinary_green_err {
        ContractError::HexMap(HexMapError::BHexRequiresBHubTile {
            hex_label,
            b_hex_name,
            ..
        }) => {
            assert_eq!(hex_label, "E23");
            assert_eq!(b_hex_name, "Boston");
        }
        other => panic!("expected HexMap(BHexRequiresBHubTile), got: {other:?}"),
    }

    // (3) Symmetrically, the designated BostonHub tile can never be laid off
    // Boston -- exercised on a second, freshly-floated company's own very
    // first tile ever, so the rejection is purely the label mismatch, not a
    // connectivity failure.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }
    let boston_hub_off_boston_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: PRR_ID,
            q: 0,
            r: 0,
            tile_id: 53, // the designated B-labeled BostonHub tile
            orientation: 0,
        },
    )
    .unwrap_err();
    match &boston_hub_off_boston_err {
        ContractError::HexMap(HexMapError::BHubTileMustBeOnBHex { hex_label, .. }) => {
            assert_eq!(hex_label, "(0, 0) [off the authentic 1830 board]");
        }
        other => panic!("expected HexMap(BHubTileMustBeOnBHex), got: {other:?}"),
    }

    // (4) The correct pairing succeeds: since Boston never took a Yellow
    // tile (module doc comment #28), this is B&O's actual FIRST tile ever
    // at Boston, laid directly as the designated Green BostonHub tile --
    // NOT an upgrade of a prior Yellow tile, unlike this test's old
    // (pre-#28) narrative.
    let boston_hub_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 53,
            orientation: 0,
        },
    )
    .expect("the designated BostonHub tile at Boston should succeed");
    assert_eq!(attr(&boston_hub_res, "tile_color"), "Green");
    assert_eq!(attr(&boston_hub_res, "is_upgrade"), "false");

    let boston_tile = MAP_GRID
        .load(&deps.storage, (game_id, BOSTON_Q, BOSTON_R))
        .unwrap();
    assert_eq!(boston_tile.tile_id, 53);
}

/// "B"/"NY"/"OO" Restrictions: Baltimore and the Brown Tier (`hexmap.rs`
/// module doc comment #27): real 1830 prints the "B" label on TWO hexes,
/// Boston AND Baltimore -- this mirrors `lay_tile_enforces_
/// boston_b_label_restriction` exactly, but at Baltimore's own hex, to
/// confirm the restriction (and the SAME designated `BostonHub` tile) is
/// enforced there too, not just at Boston. Per the request's own explicit
/// ask: "Add backend unit tests verifying 'B' restrictions on BOTH Boston
/// and Baltimore."
#[test]
fn lay_tile_enforces_baltimore_b_label_restriction() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const PRR_ID: u32 = 1;
    const BALTIMORE_Q: i32 = 3;
    const BALTIMORE_R: i32 = 8;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // (1) Baltimore's YELLOW start is now ALSO "B"-label-restricted (module
    // doc comment #28): real 1830 never lays a plain Yellow tile at
    // Baltimore at all -- it's B&O's home station, and its first real lay is
    // straight to the Green BostonHub tile below. This replaces the old
    // (incorrect) "Baltimore's Yellow start is unaffected" case this test
    // used to assert.
    let baltimore_yellow_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BALTIMORE_Q,
            r: BALTIMORE_R,
            tile_id: 57, // yellow major city hub -- ordinary, shared by every landmark
            orientation: 0,
        },
    )
    .unwrap_err();
    match &baltimore_yellow_err {
        ContractError::HexMap(HexMapError::BHexRequiresBHubTile {
            hex_label,
            b_hex_name,
            ..
        }) => {
            assert_eq!(hex_label, "I15");
            assert_eq!(b_hex_name, "Baltimore");
        }
        other => panic!("expected HexMap(BHexRequiresBHubTile), got: {other:?}"),
    }

    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    // (2) An ordinary GREEN major city hub can never upgrade Baltimore once
    // the B-label restriction applies -- and the error correctly names
    // Baltimore, not Boston, confirming `BHexRequiresBHubTile`'s
    // `b_hex_name` field actually varies per hex rather than being
    // hardcoded.
    let ordinary_green_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BALTIMORE_Q,
            r: BALTIMORE_R,
            tile_id: 14, // ordinary green major city hub -- NOT the B-labeled tile
            orientation: 0,
        },
    )
    .unwrap_err();
    match &ordinary_green_err {
        ContractError::HexMap(HexMapError::BHexRequiresBHubTile {
            hex_label,
            b_hex_name,
            ..
        }) => {
            assert_eq!(hex_label, "I15");
            assert_eq!(b_hex_name, "Baltimore");
        }
        other => panic!("expected HexMap(BHexRequiresBHubTile), got: {other:?}"),
    }

    // (3) Symmetrically, the designated BostonHub ("B"-label) tile can never
    // be laid off a "B"-labeled hex -- exercised on a second, freshly-
    // floated company's own very first tile ever.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }
    let boston_hub_off_b_hex_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: PRR_ID,
            q: 0,
            r: 0,
            tile_id: 53, // the designated B-labeled BostonHub tile
            orientation: 0,
        },
    )
    .unwrap_err();
    match &boston_hub_off_b_hex_err {
        ContractError::HexMap(HexMapError::BHubTileMustBeOnBHex { hex_label, .. }) => {
            assert_eq!(hex_label, "(0, 0) [off the authentic 1830 board]");
        }
        other => panic!("expected HexMap(BHubTileMustBeOnBHex), got: {other:?}"),
    }

    // (4) The correct pairing succeeds: since Baltimore never took a Yellow
    // tile (module doc comment #28), this is B&O's actual FIRST tile ever
    // at Baltimore, laid directly as the SAME designated Green BostonHub
    // tile used at Boston -- confirming the "B" label, not the hex
    // identity, is what the tile artwork is keyed to. NOT an upgrade of a
    // prior Yellow tile, unlike this test's old (pre-#28) narrative.
    let baltimore_hub_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BALTIMORE_Q,
            r: BALTIMORE_R,
            tile_id: 53,
            orientation: 0,
        },
    )
    .expect("the designated BostonHub tile at Baltimore should succeed");
    assert_eq!(attr(&baltimore_hub_res, "tile_color"), "Green");
    assert_eq!(attr(&baltimore_hub_res, "is_upgrade"), "false");

    let baltimore_tile = MAP_GRID
        .load(&deps.storage, (game_id, BALTIMORE_Q, BALTIMORE_R))
        .unwrap();
    assert_eq!(baltimore_tile.tile_id, 53);
}

/// "B"/"NY"/"OO" Restrictions: Baltimore and the Brown Tier (`hexmap.rs`
/// module doc comment #27): the "B" restriction's Brown-tier extension --
/// real 1830 gates the Brown upgrade of a "B"-labeled hex to its own
/// dedicated tile too, distinct from the Green one, not just the Green
/// upgrade #26 already covered. Exercised at Boston (Baltimore's own
/// Green-tier case is already covered by `lay_tile_enforces_
/// baltimore_b_label_restriction`, and the underlying mechanism --
/// `is_b_label_hex` -- is shared code, not a per-hex branch, so a second
/// full Baltimore run here would be redundant). Era is unlocked straight to
/// Brown up front (same shortcut every era-unlock test in this file uses)
/// so a single company's tile chain can walk Yellow -> Green -> Brown
/// without needing a second company just to prove connectivity.
#[test]
fn lay_tile_enforces_b_label_restriction_brown_tier() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const BOSTON_Q: i32 = 9;
    const BOSTON_R: i32 = 4;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Brown;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    // (1) Yellow start is now ALSO "B"-label-restricted (module doc comment
    // #28) -- the ordinary yellow hub is rejected here too, replacing this
    // test's old (pre-#28) "Yellow start, still unaffected" case.
    let boston_yellow_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 57,
            orientation: 0,
        },
    )
    .unwrap_err();
    match &boston_yellow_err {
        ContractError::HexMap(HexMapError::BHexRequiresBHubTile { .. }) => {}
        other => panic!("expected HexMap(BHexRequiresBHubTile), got: {other:?}"),
    }

    // (2) Green tile, laid directly as B&O's actual first tile ever at
    // Boston (no Yellow step exists at this hex any more), same designated
    // BostonHub tile as #26.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 53,
            orientation: 0,
        },
    )
    .expect("the designated Green BostonHub tile at Boston should succeed");

    // (3) An ordinary BROWN major city hub can never upgrade a "B"-labeled
    // hex -- the new Brown-tier extension this pass adds.
    let ordinary_brown_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 63, // ordinary brown major city hub -- NOT the B-labeled Brown tile
            orientation: 0,
        },
    )
    .unwrap_err();
    match &ordinary_brown_err {
        ContractError::HexMap(HexMapError::BHexRequiresBHubTile {
            hex_label,
            b_hex_name,
            ..
        }) => {
            assert_eq!(hex_label, "E23");
            assert_eq!(b_hex_name, "Boston");
        }
        other => panic!("expected HexMap(BHexRequiresBHubTile), got: {other:?}"),
    }

    // (4) The designated Brown BostonHub tile (real 1830 tray #61
    // per the request -- module doc comment #27) succeeds.
    let brown_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 61,
            orientation: 0,
        },
    )
    .expect("the designated Brown BostonHub tile at Boston should succeed");
    assert_eq!(attr(&brown_res, "tile_color"), "Brown");
    assert_eq!(attr(&brown_res, "is_upgrade"), "true");

    let boston_tile = MAP_GRID
        .load(&deps.storage, (game_id, BOSTON_Q, BOSTON_R))
        .unwrap();
    assert_eq!(boston_tile.tile_id, 61);
}

/// Canonical Tile Upgrade Restrictions (`hexmap.rs` module doc comment
/// #26): the symmetric "NY" case, mirroring `lay_tile_enforces_
/// boston_b_label_restriction` exactly, for New York's own dedicated
/// `NewYorkHub` tile instead of Boston's `BostonHub`.
#[test]
fn lay_tile_enforces_new_york_ny_label_restriction() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const PRR_ID: u32 = 1;
    const NEW_YORK_Q: i32 = 6;
    const NEW_YORK_R: i32 = 6;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // (1) New York's YELLOW start is now ALSO "NY"-label-restricted (module
    // doc comment #28): real 1830 never lays a plain Yellow tile at New
    // York at all -- it's NYNH's home station, and its first real lay is
    // straight to the Green NewYorkHub tile below. This replaces the old
    // (incorrect) "New York's Yellow start is unaffected" case this test
    // used to assert.
    let ny_yellow_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 57, // yellow major city hub -- ordinary, shared by every landmark
            orientation: 0,
        },
    )
    .unwrap_err();
    match &ny_yellow_err {
        ContractError::HexMap(HexMapError::NewYorkHexRequiresNewYorkHubTile { hex_label, .. }) => {
            assert_eq!(hex_label, "G19");
        }
        other => panic!("expected HexMap(NewYorkHexRequiresNewYorkHubTile), got: {other:?}"),
    }

    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    // (2) An ordinary GREEN major city hub can never upgrade New York.
    let ordinary_green_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 14, // ordinary green major city hub -- NOT the NY-labeled tile
            orientation: 0,
        },
    )
    .unwrap_err();
    match &ordinary_green_err {
        ContractError::HexMap(HexMapError::NewYorkHexRequiresNewYorkHubTile { hex_label, .. }) => {
            assert_eq!(hex_label, "G19");
        }
        other => panic!("expected HexMap(NewYorkHexRequiresNewYorkHubTile), got: {other:?}"),
    }

    // (3) Symmetrically, the designated NewYorkHub tile can never be laid
    // off New York -- a second company's own first tile ever.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }
    let ny_hub_off_ny_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: PRR_ID,
            q: 0,
            r: 0,
            tile_id: 54, // the designated NY-labeled NewYorkHub tile
            orientation: 0,
        },
    )
    .unwrap_err();
    match &ny_hub_off_ny_err {
        ContractError::HexMap(HexMapError::NewYorkHubTileMustBeOnNewYorkHex { hex_label, .. }) => {
            assert_eq!(hex_label, "(0, 0) [off the authentic 1830 board]");
        }
        other => panic!("expected HexMap(NewYorkHubTileMustBeOnNewYorkHex), got: {other:?}"),
    }

    // (4) The correct pairing succeeds: since New York never took a Yellow
    // tile (module doc comment #28), this is B&O's actual FIRST tile ever
    // at New York, laid directly as the designated Green NewYorkHub tile --
    // NOT an upgrade of a prior Yellow tile, unlike this test's old
    // (pre-#28) narrative.
    let ny_hub_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 54,
            orientation: 0,
        },
    )
    .expect("the designated NewYorkHub tile at New York should succeed");
    assert_eq!(attr(&ny_hub_res, "tile_color"), "Green");
    assert_eq!(attr(&ny_hub_res, "is_upgrade"), "false");

    let ny_tile = MAP_GRID
        .load(&deps.storage, (game_id, NEW_YORK_Q, NEW_YORK_R))
        .unwrap();
    assert_eq!(ny_tile.tile_id, 54);
}

/// "B"/"NY"/"OO" Restrictions: Baltimore and the Brown Tier (`hexmap.rs`
/// module doc comment #27): the "NY" restriction's Brown-tier extension,
/// mirroring `lay_tile_enforces_b_label_restriction_brown_tier` exactly for
/// New York's own dedicated `NewYorkHub` tile instead of Boston's
/// `BostonHub`.
#[test]
fn lay_tile_enforces_new_york_ny_label_restriction_brown_tier() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const NEW_YORK_Q: i32 = 6;
    const NEW_YORK_R: i32 = 6;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Brown;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    // Yellow start is now ALSO "NY"-label-restricted (module doc comment
    // #28) -- replaces this test's old (pre-#28) "Yellow start, still
    // unaffected" case.
    let ny_yellow_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 57,
            orientation: 0,
        },
    )
    .unwrap_err();
    match &ny_yellow_err {
        ContractError::HexMap(HexMapError::NewYorkHexRequiresNewYorkHubTile { .. }) => {}
        other => panic!("expected HexMap(NewYorkHexRequiresNewYorkHubTile), got: {other:?}"),
    }

    // Green tile, laid directly as B&O's actual first tile ever at New York
    // (no Yellow step exists at this hex any more).
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 54,
            orientation: 0,
        },
    )
    .expect("the designated Green NewYorkHub tile at New York should succeed");

    // An ordinary BROWN major city hub can never upgrade New York.
    let ordinary_brown_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 63, // ordinary brown major city hub -- NOT the NY-labeled Brown tile
            orientation: 0,
        },
    )
    .unwrap_err();
    match &ordinary_brown_err {
        ContractError::HexMap(HexMapError::NewYorkHexRequiresNewYorkHubTile { hex_label, .. }) => {
            assert_eq!(hex_label, "G19");
        }
        other => panic!("expected HexMap(NewYorkHexRequiresNewYorkHubTile), got: {other:?}"),
    }

    // The designated Brown NewYorkHub tile (tile 19, real 1830 tray #62 per
    // the request -- module doc comment #27) succeeds.
    let brown_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 62,
            orientation: 0,
        },
    )
    .expect("the designated Brown NewYorkHub tile at New York should succeed");
    assert_eq!(attr(&brown_res, "tile_color"), "Brown");
    assert_eq!(attr(&brown_res, "is_upgrade"), "true");

    let ny_tile = MAP_GRID
        .load(&deps.storage, (game_id, NEW_YORK_Q, NEW_YORK_R))
        .unwrap();
    assert_eq!(ny_tile.tile_id, 62);
}

/// "B"/"NY"/"OO" Restrictions: Baltimore and the Brown Tier (`hexmap.rs`
/// module doc comment #27): the "OO" restriction's Brown-tier extension --
/// unlike "B"/"NY", which each get exactly ONE designated Brown tile, real
/// 1830 (per the request) offers FIVE distinct Brown double-city artworks
/// (tray #64-#68) at the four OO hexes, any one of which is legal. Confirms
/// both `ExecuteMsg::LayTile` (one variant actually laid) and
/// `QueryMsg::GetLegalTilePlacements` (all five appear as options, and the
/// ordinary Brown `MajorCityHub` does not) agree -- this file's own
/// established convention for every reservation rule.
#[test]
fn lay_tile_enforces_oo_label_restriction_brown_tier() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    // Hamilton & Toronto -- one of `OO_DESIGNATED_HEXES`' four entries.
    const D10_Q: i32 = 3;
    const D10_R: i32 = 3;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Brown;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    // B&O's very first tile ever, laid directly at the OO hex with the
    // Green DoubleCityHub (no Yellow DoubleCityHub artwork exists in
    // `TILE_CATALOG` at all, same as `lay_tile_enforces_
    // oo_double_city_reservation`).
    let green_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: D10_Q,
            r: D10_R,
            tile_id: 59,
            orientation: 0,
        },
    )
    .expect("the designated Green double-city hub tile at the OO hex should succeed");
    assert_eq!(attr(&green_res, "is_upgrade"), "false");

    // The query agrees ahead of time: all five Brown double-city variants
    // (tiles 20-24, real 1830 tray #64-#68 per the request) are legal
    // Brown-tier upgrades here, and the ordinary Brown MajorCityHub (tile
    // 14) is not among them.
    let query_res = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: D10_Q,
            r: D10_R,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let resp: LegalTilePlacementsResponse = from_json(&query_res).unwrap();
    let legal_tile_ids: std::collections::HashSet<u32> =
        resp.placements.iter().map(|p| p.tile_id).collect();
    for brown_oo_tile_id in [64u32, 65, 66, 67, 68] {
        assert!(
            legal_tile_ids.contains(&brown_oo_tile_id),
            "expected tile {brown_oo_tile_id} (one of the five Brown OO variants) to be a legal upgrade, got: {legal_tile_ids:?}"
        );
    }
    assert!(
        !legal_tile_ids.contains(&63),
        "the ordinary Brown MajorCityHub should not be a legal OO upgrade, got: {legal_tile_ids:?}"
    );

    // An ordinary BROWN major city hub is rejected by the real handler too,
    // not just absent from the query.
    let ordinary_brown_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: D10_Q,
            r: D10_R,
            tile_id: 63,
            orientation: 0,
        },
    )
    .unwrap_err();
    match &ordinary_brown_err {
        ContractError::HexMap(HexMapError::OOHexRequiresDoubleCityHubTile { hex_label, .. }) => {
            assert_eq!(hex_label, "D10");
        }
        other => panic!("expected HexMap(OOHexRequiresDoubleCityHubTile), got: {other:?}"),
    }

    // Laying the middle variant (tile 22, real tray #66 per the request)
    // succeeds -- confirming it's not merely tile 20 (the first Brown
    // catalog entry) that's accepted, but any of the five.
    let brown_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: D10_Q,
            r: D10_R,
            tile_id: 66,
            orientation: 0,
        },
    )
    .expect("a Brown OO double-city variant other than the first catalog entry should still succeed");
    assert_eq!(attr(&brown_res, "tile_color"), "Brown");
    assert_eq!(attr(&brown_res, "is_upgrade"), "true");

    let d10_tile = MAP_GRID.load(&deps.storage, (game_id, D10_Q, D10_R)).unwrap();
    assert_eq!(d10_tile.tile_id, 66);
}

/// Rail Map Overhaul (frontend `HexGridRenderer.tsx` design note #42 /
/// `hexmap.rs`'s matching `CITY_DESIGNATED_HEXES` doc comment), UPDATED by
/// module doc comment #25's house rule: Albany (E19, axial `(7, 4)`) is a
/// ninth blank white city -- same reservation category as
/// Toledo/Providence/etc., real source entry a bare `'city'` with no
/// printed revenue. Confirms it resolves through the on-chain City
/// Reservation lookup (so a real tile can legally be laid there), is NOT
/// double-counted as an OO hex or a real-track GRAY city, and -- as of the
/// #25 house rule -- now IS NYC's preprinted home station hex, with NNH
/// ("NYNH") having taken over the New York (G19) hex NYC vacated. Needs no
/// game/deps setup at all; every function under test here is a pure,
/// stateless lookup.
#[test]
fn albany_is_nycs_home_station_hex_under_the_house_rule_reassignment() {
    assert_eq!(hexmap::city_designation_name_at(7, 4), Some("Albany"));
    assert_eq!(hexmap::oo_designation_name_at(7, 4), None);
    assert_eq!(hexmap::gray_preprinted_name_at(7, 4), None);
    assert_eq!(hexmap::corporation_home_hex(2), Some((7, 4, "E19"))); // NYC's home, house rule per module doc comment #25
    assert_eq!(hexmap::corporation_home_hex(7), Some((6, 6, "G19"))); // NNH's home, the G19 hex NYC vacated
}

/// Gray Hex Immutability (`hexmap.rs` module doc comment #19): a real
/// pre-printed GRAY hex's fixed starting track can never be laid over --
/// not with an ordinary tile, not with the "designated" artwork that would
/// otherwise be legal there, regardless of tile color era or existing
/// network state. Exercises both `ExecuteMsg::LayTile` and
/// `QueryMsg::GetLegalTilePlacements` for the same hex, so the query and
/// the real handler are confirmed to agree (this file's own established
/// convention for every reservation rule).
#[test]
fn lay_tile_enforces_gray_hex_immutability() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    // Cleveland -- one of `GRAY_PREPRINTED_HEXES`' twelve entries (a real
    // GRAY city, `CITY_DESIGNATED_HEXES`).
    const CLEVELAND_Q: i32 = 0;
    const CLEVELAND_R: i32 = 5;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // Even the tile type that would otherwise be exactly right for a real
    // GRAY city (a plain MajorCityHub hub, same as any other City
    // Reservation hex) is rejected -- Gray Hex Immutability is checked
    // BEFORE City Reservation even runs.
    let gray_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: CLEVELAND_Q,
            r: CLEVELAND_R,
            tile_id: 57, // yellow major city hub
            orientation: 0,
        },
    )
    .unwrap_err();
    match &gray_err {
        ContractError::HexMap(HexMapError::GrayHexNotUpgradeable { hex_label, gray_hex_name, .. }) => {
            assert_eq!(hex_label, "F6");
            assert_eq!(gray_hex_name, "Cleveland");
        }
        other => panic!("expected HexMap(GrayHexNotUpgradeable), got: {other:?}"),
    }

    // The query agrees: zero legal placements at Cleveland, for any tile.
    let query_res = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: CLEVELAND_Q,
            r: CLEVELAND_R,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let resp: LegalTilePlacementsResponse = from_json(&query_res).unwrap();
    assert!(resp.placements.is_empty());

    // All twelve `GRAY_PREPRINTED_HEXES` entries resolve, including the
    // three bare GRAY connectors (E9/A17/D24) added by the Rigid Global
    // Gray-Hex Lockout pass (module doc comment #20); an ordinary blank
    // city/town marker (Toledo, a `CITY_DESIGNATED_HEXES` entry with no
    // real printed track) does not -- confirming this is scoped to the
    // real GRAY subset, not every City/Town-designated hex.
    assert_eq!(hexmap::gray_preprinted_name_at(-1, 3), Some("Lansing"));
    assert_eq!(hexmap::gray_preprinted_name_at(0, 5), Some("Cleveland"));
    assert_eq!(hexmap::gray_preprinted_name_at(2, 7), Some("Altoona"));
    assert_eq!(hexmap::gray_preprinted_name_at(5, 3), Some("Rochester"));
    assert_eq!(hexmap::gray_preprinted_name_at(2, 10), Some("Richmond"));
    assert_eq!(hexmap::gray_preprinted_name_at(9, 0), Some("Montreal"));
    assert_eq!(hexmap::gray_preprinted_name_at(6, 2), Some("Kingston"));
    assert_eq!(hexmap::gray_preprinted_name_at(5, 8), Some("Atlantic City"));
    assert_eq!(hexmap::gray_preprinted_name_at(9, 5), Some("Fall River"));
    assert_eq!(hexmap::gray_preprinted_name_at(2, 4), Some("E9"));
    assert_eq!(hexmap::gray_preprinted_name_at(8, 0), Some("A17"));
    assert_eq!(hexmap::gray_preprinted_name_at(10, 3), Some("D24"));
    assert_eq!(hexmap::gray_preprinted_name_at(-1, 5), None); // Toledo -- blank city marker, no real track
}

/// Rigid Global Gray-Hex Lockout (module doc comment #20): a bare GRAY
/// connector hex with real fixed track but no city or town at all (E9) is
/// just as permanently un-upgradable as a real GRAY city -- the original
/// Gray Hex Immutability pass (#19) deliberately left these out of scope;
/// this confirms the follow-up extension actually closed that gap on-chain,
/// not just in the lookup table checked by the test just above.
#[test]
fn lay_tile_enforces_gray_hex_immutability_on_bare_connector_hexes() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const E9_Q: i32 = 2;
    const E9_R: i32 = 4;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // An ordinary plain straight-track tile -- otherwise legal artwork for
    // an undeveloped connector hex -- is still unconditionally rejected.
    let gray_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: E9_Q,
            r: E9_R,
            tile_id: 9, // plain straight track
            orientation: 0,
        },
    )
    .unwrap_err();
    match &gray_err {
        ContractError::HexMap(HexMapError::GrayHexNotUpgradeable { hex_label, gray_hex_name, .. }) => {
            assert_eq!(hex_label, "E9");
            assert_eq!(gray_hex_name, "E9");
        }
        other => panic!("expected HexMap(GrayHexNotUpgradeable), got: {other:?}"),
    }

    let query_res = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: E9_Q,
            r: E9_R,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let resp: LegalTilePlacementsResponse = from_json(&query_res).unwrap();
    assert!(resp.placements.is_empty());
}

/// Impassable Border Edges (module doc comment #22): the E7/F8 border is
/// one of four fixed board-edge crossings track may never be built across,
/// even though both hexes stay ordinarily buildable otherwise -- unlike
/// Gray Hex Immutability above, this rejects only the specific orientations
/// that would route track across the blocked edge, not the hex as a whole.
/// Exercises both `ExecuteMsg::LayTile` and `QueryMsg::GetLegalTilePlacements`
/// at E7 (this file's own established convention for every reservation
/// rule), and confirms E7 still accepts a tile oriented so no track touches
/// its one blocked edge.
#[test]
fn lay_tile_enforces_impassable_border_edges() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    // E7 (London) -- one side of the E7/F8 impassable border
    // (`IMPASSABLE_HEX_EDGES`).
    const E7_Q: i32 = 1;
    const E7_R: i32 = 4;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // Tile #58 (small-town gentle curve, base edges {0, 2} -- the correct
    // terrain-matching tile for E7/London, a `TOWN_DESIGNATED_HEXES` hex;
    // a Plain tile would never be legal at E7 regardless of the
    // impassable-edge rule below, since it doesn't carry Town artwork)
    // rotated to orientation 3 lands live track on edges 3 and 5 -- edge 5
    // is E7's own blocked edge (toward F8) -- so this is rejected even
    // though it would otherwise be legal unconditionally as protocol_id's
    // very first tile (no connectivity check applies at all to a brand-new
    // Token Station, module doc comment #9).
    let border_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: E7_Q,
            r: E7_R,
            tile_id: 58,
            orientation: 3,
        },
    )
    .unwrap_err();
    match &border_err {
        ContractError::HexMap(HexMapError::TrackCrossesImpassableEdge {
            hex_label,
            edge,
            tile_id,
            orientation,
            ..
        }) => {
            assert_eq!(hex_label, "E7");
            assert_eq!(*edge, 5);
            assert_eq!(*tile_id, 58);
            assert_eq!(*orientation, 3);
        }
        other => panic!("expected HexMap(TrackCrossesImpassableEdge), got: {other:?}"),
    }

    // The query agrees: orientation 4 is absent from tile 3's legal
    // placements at E7, even though tile #58 itself is otherwise legal there.
    let query_res = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: E7_Q,
            r: E7_R,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let resp: LegalTilePlacementsResponse = from_json(&query_res).unwrap();
    assert!(
        !resp
            .placements
            .iter()
            .any(|p| p.tile_id == 58 && p.orientation == 3),
        "tile #58 at orientation 3 crosses E7's blocked edge 5 and must not be listed as legal: {:?}",
        resp.placements
    );
    assert!(
        resp
            .placements
            .iter()
            .any(|p| p.tile_id == 58 && p.orientation == 0),
        "tile #58 at orientation 0 doesn't touch E7's blocked edge and should still be legal: {:?}",
        resp.placements
    );

    // E7 is still an ordinarily buildable hex, just not with track crossing
    // its one blocked edge: orientation 0 (live edges 1 & 3, nowhere near
    // edge 5) succeeds as protocol_id's first tile / Token Station.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: E7_Q,
            r: E7_R,
            tile_id: 58,
            orientation: 0,
        },
    )
    .expect("tile #58 at orientation 0 doesn't touch E7's blocked edge and should succeed");
}

/// Rigid Global Gray-Hex Lockout (module doc comment #20): the routing
/// fallback fix in `pathfinding::effective_tile_and_value`. Every real GRAY
/// hex -- not just the six in `LANDMARK_START_VALUE_OVERRIDE` -- must
/// resolve to a passable synthetic tile with the correct real value, since
/// Gray Hex Immutability means none of them can ever receive an actual laid
/// `Tile`. Exercises the three previously-uncovered branches directly: a
/// real GRAY city with no individually-sourced override (Lansing, flat
/// `MajorCityHub` $20), a real GRAY town (Kingston, flat `SmallTown` $10),
/// and a bare GRAY connector with no city/town at all (E9, $0 but still
/// passable/routable). Also confirms Altoona -- newly added to
/// `LANDMARK_START_VALUE_OVERRIDE` this same pass -- resolves at its real
/// sourced $10, not the generic $20 a plain `MajorCityHub` would score.
#[test]
fn effective_tile_and_value_covers_every_real_gray_hex_not_just_the_override_six() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("creator", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("player_one", &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    // Lansing (-1, 3): real GRAY city, no override -- flat $20.
    let (_, lansing_value) = pathfinding::effective_tile_and_value(&deps.storage, game_id, -1, 3)
        .unwrap()
        .expect("Lansing must resolve to a passable synthetic tile, not None");
    assert_eq!(lansing_value, Uint128::new(20));

    // Altoona (2, 7): real GRAY city, now in `LANDMARK_START_VALUE_OVERRIDE`
    // -- real sourced $10, NOT the generic $20.
    let (_, altoona_value) = pathfinding::effective_tile_and_value(&deps.storage, game_id, 2, 7)
        .unwrap()
        .expect("Altoona must resolve to a passable synthetic tile, not None");
    assert_eq!(altoona_value, Uint128::new(10));

    // Kingston (6, 2): real GRAY town -- flat $10.
    let (_, kingston_value) = pathfinding::effective_tile_and_value(&deps.storage, game_id, 6, 2)
        .unwrap()
        .expect("Kingston must resolve to a passable synthetic tile, not None");
    assert_eq!(kingston_value, Uint128::new(10));

    // E9 (2, 4): bare GRAY connector, no city/town -- $0, but still
    // resolves to `Some` (passable), not `None` (which would sever the
    // board's connectivity through this hex).
    let (_, e9_value) = pathfinding::effective_tile_and_value(&deps.storage, game_id, 2, 4)
        .unwrap()
        .expect("E9 must resolve to a passable synthetic tile, not None -- a bare connector still routes");
    assert_eq!(e9_value, Uint128::zero());
}

/// Off-Board Reservation (`hexmap.rs` module doc comment #14): none of the
/// seven real off-board revenue hexes ever accept any tile artwork -- not a
/// generic plain track tile, and not even a major city hub tile, which is
/// otherwise landmark-eligible elsewhere on the board.
#[test]
fn lay_tile_rejects_any_placement_at_an_offboard_hex() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const CHICAGO_Q: i32 = -2;
    const CHICAGO_R: i32 = 5;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // A generic plain tile is rejected at the Chicago off-board hex.
    let plain_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: CHICAGO_Q,
            r: CHICAGO_R,
            tile_id: 9, // plain straight track
            // Off-Board Reservation is checked before any orientation-
            // specific rule -- any in-range orientation rejects identically.
            orientation: 0,
        },
    )
    .unwrap_err();
    match &plain_err {
        ContractError::HexMap(HexMapError::OffboardHexNotBuildable { hex_label, .. }) => {
            // Coordinate Symmetries: the error carries Chicago's real board
            // label ("F2"), not just the bare axial pair.
            assert_eq!(hex_label, "F2");
        }
        other => panic!("expected HexMap(OffboardHexNotBuildable), got: {other:?}"),
    }

    // Even a major city hub tile -- otherwise landmark-eligible -- is
    // rejected at an off-board hex.
    let hub_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: CHICAGO_Q,
            r: CHICAGO_R,
            tile_id: 57, // yellow major city hub
            // Off-Board Reservation is checked before any orientation-
            // specific rule -- any in-range orientation rejects identically.
            orientation: 0,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            hub_err,
            ContractError::HexMap(HexMapError::OffboardHexNotBuildable { .. })
        ),
        "expected HexMap(OffboardHexNotBuildable), got: {hub_err:?}"
    );

    // `GetLegalTilePlacements` mirrors the same rejection: no catalog entry
    // is ever legal at an off-board hex.
    let legal: LegalTilePlacementsResponse = from_json(
        &query_entry_point(
            deps.as_ref(),
            env.clone(),
            QueryMsg::GetLegalTilePlacements {
                game_id,
                protocol_id: BO_PUBLIC_ID,
                q: CHICAGO_Q,
                r: CHICAGO_R,
            },
        )
        .expect("GetLegalTilePlacements should succeed"),
    )
    .expect("GetLegalTilePlacements's response should deserialize");
    assert!(
        legal.placements.is_empty(),
        "expected no legal placements at an off-board hex, got: {:?}",
        legal.placements
    );
    // Coordinate Symmetries: the query response itself also carries
    // Chicago's real board label.
    assert_eq!(legal.hex_label, "F2");

    // All seven real off-board hexes resolve to their destination names;
    // an ordinary hex resolves to none.
    assert_eq!(hexmap::offboard_name_at(-2, 5), Some("Chicago"));
    assert_eq!(hexmap::offboard_name_at(4, 0), Some("Canadian West"));
    assert_eq!(hexmap::offboard_name_at(5, 0), Some("Canadian West"));
    assert_eq!(hexmap::offboard_name_at(-4, 8), Some("Gulf"));
    assert_eq!(hexmap::offboard_name_at(-4, 9), Some("Gulf"));
    assert_eq!(hexmap::offboard_name_at(1, 10), Some("Deep South"));
    assert_eq!(hexmap::offboard_name_at(11, 1), Some("Maritime Provinces"));
    assert_eq!(hexmap::offboard_name_at(0, 0), None);

    // Coordinate Symmetries: every one of the seven off-board hexes and all
    // three landmarks resolve to their real board label, and every label
    // round-trips back through `axial_for_label` to the identical axial
    // pair -- proving `BOARD_HEX_LABELS` and `LANDMARK_HEXES`/
    // `OFFBOARD_HEXES` agree with each other, not just individually correct.
    for &(name, q, r) in hexmap::OFFBOARD_HEXES
        .iter()
        .chain(hexmap::LANDMARK_HEXES.iter())
    {
        let label = hexmap::label_for_axial(q, r)
            .unwrap_or_else(|| panic!("{name} at ({q}, {r}) should resolve to a real board label"));
        assert_eq!(
            hexmap::axial_for_label(label),
            Some((q, r)),
            "{name}'s label {label} should round-trip back to ({q}, {r})"
        );
    }
}

/// Coordinate Symmetries (`hexmap.rs` module doc comment #15): the
/// authoritative `BOARD_HEX_LABELS` table itself is internally consistent --
/// exactly 93 real board hexes, no duplicate labels, no two labels sharing
/// one axial coordinate, and every `label_for_axial`/`axial_for_label` pair
/// round-trips both ways. This is a property of the static table, not any
/// particular game room, so it doesn't need `mock_dependencies`/`execute`.
#[test]
fn board_hex_labels_table_is_internally_consistent() {
    assert_eq!(
        hexmap::BOARD_HEX_LABELS.len(),
        93,
        "the real 1830 board has exactly 93 hexes"
    );

    let mut seen_labels = std::collections::HashSet::new();
    let mut seen_coords = std::collections::HashSet::new();
    for &(label, q, r) in hexmap::BOARD_HEX_LABELS {
        assert!(seen_labels.insert(label), "duplicate board label: {label}");
        assert!(
            seen_coords.insert((q, r)),
            "duplicate board coordinate: ({q}, {r}), second claimed by {label}"
        );

        // Round trip both directions.
        assert_eq!(hexmap::label_for_axial(q, r), Some(label));
        assert_eq!(hexmap::axial_for_label(label), Some((q, r)));
        assert_eq!(hexmap::describe_hex(q, r), label);
    }

    // A coordinate genuinely off the real board resolves to `None`/the
    // fallback description, never to a spurious label.
    assert_eq!(hexmap::label_for_axial(1000, 1000), None);
    assert_eq!(hexmap::axial_for_label("Z99"), None);
    assert_eq!(
        hexmap::describe_hex(1000, 1000),
        "(1000, 1000) [off the authentic 1830 board]"
    );
}

/// Terrain Build Fees live on the HEX (Audit G-10) + Tile Upgrade Cost
/// Correction (`hexmap.rs` module doc comment #12).
///
/// Two rules proved in one place:
///  1. `terrain_build_fee(q, r)` charges the hex's own printed 1830 terrain
///     cost on the first build there -- $120 at a mountain hex like G15,
///     regardless of which tile artwork is laid.
///  2. Every later colour upgrade of that same hex is free.
///
/// Rewritten for G-10. The previous version laid the INVENTED "mountain
/// pass" tile 5 at an ordinary blank hex to trigger an $80 charge, and
/// upgraded it to the equally invented tile 12. Both tiles are now deleted:
/// real 1830 has no mountain tile, because terrain is printed on the board,
/// not on cardboard. So this test now lays an ordinary plain tile onto a
/// genuine mountain hex -- which under the old per-tile model would have
/// been completely FREE, the exact exploit G-10 closes.
#[test]
fn lay_tile_terrain_fee_comes_from_the_hex_and_upgrades_are_free() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const PRR_ID: u32 = 1;
    // G15 -- a real 1830 mountain hex ($120), with no city, town, landmark,
    // gray, offboard or private reservation on it, and no impassable edges.
    const G15_Q: i32 = 4;
    const G15_R: i32 = 6;

    // Unit-level check of the fee table itself, independent of any lay.
    assert_eq!(
        hexmap::terrain_build_fee(G15_Q, G15_R),
        Uint128::new(120),
        "G15 is a real 1830 mountain hex"
    );
    assert_eq!(
        hexmap::terrain_build_fee(0, 4),
        Uint128::new(80),
        "E5 (Detroit & Windsor) is a real 1830 water hex"
    );
    assert_eq!(
        hexmap::terrain_build_fee(0, 0),
        Uint128::zero(),
        "ordinary clear land is free to build on"
    );

    // Float B&O (treasury $670) by winning its private.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // B&O's home tile: an ORDINARY yellow plain tile (#9, straight track),
    // laid onto a genuine mountain hex. The $120 comes from the hex, not
    // from the tile -- under the old per-tile cost model this exact
    // placement cost $0.
    let home_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, G15_Q, G15_R, 9);
    let home_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: G15_Q,
            r: G15_R,
            tile_id: 9,
            orientation: home_orientation,
        },
    )
    .expect("B&O's plain home tile on a mountain hex should be affordable and legal");
    assert_eq!(attr(&home_res, "is_upgrade"), "false");
    assert_eq!(
        attr(&home_res, "terrain_cost"),
        "120",
        "the mountain fee is a property of G15, not of the plain tile laid on it"
    );

    let bo_after_home_tile = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, BO_PUBLIC_ID))
        .unwrap();
    assert_eq!(bo_after_home_tile.treasury, Uint128::new(550)); // 670 - 120

    // Float PRR and buy seven Hardware units (six 2-trains + the room's
    // first-ever 3-train) to unlock the Green era -- the same recipe as
    // `lay_tile_enforces_era_color_locking_and_upgrade_topology_retention`.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(67)),
        },
    )
    .expect("PRR's first IPO purchase should set its par value and succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }
    let mut seeded_pool = HARDWARE_POOL.load(&deps.storage, game_id).unwrap();
    let remaining_pool = seeded_pool.split_off(6);
    HARDWARE_POOL
        .save(deps.as_mut().storage, game_id, &remaining_pool)
        .unwrap();
    TRAINS_PURCHASED_COUNT
        .save(deps.as_mut().storage, (game_id, "2".to_string()), &6)
        .unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .expect("PRR should be able to afford the room's first 3-train");
    let session_after_unlock = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session_after_unlock.current_global_era, TileColor::Green);

    let bank_vgp_before_upgrade = session_after_unlock.virtual_bank_vgp;

    // Upgrade the mountain hex to a Green plain tile (#23) -- the hex's
    // terrain fee was already paid once, so this is entirely free even
    // though the hex is still a mountain.
    let upgrade_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, G15_Q, G15_R, 23);
    let upgrade_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: G15_Q,
            r: G15_R,
            tile_id: 23,
            orientation: upgrade_orientation,
        },
    )
    .expect("the Green upgrade of B&O's mountain hex should succeed under the Green era");
    assert_eq!(attr(&upgrade_res, "is_upgrade"), "true");
    assert_eq!(attr(&upgrade_res, "tile_color"), "Green");
    assert_eq!(
        attr(&upgrade_res, "terrain_cost"),
        "0",
        "a hex's terrain fee is paid once, on the first build -- upgrades are free"
    );

    let bo_after_upgrade = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, BO_PUBLIC_ID))
        .unwrap();
    assert_eq!(
        bo_after_upgrade.treasury, bo_after_home_tile.treasury,
        "the upgrade must not touch B&O's treasury at all"
    );

    let session_after_upgrade = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(
        session_after_upgrade.virtual_bank_vgp, bank_vgp_before_upgrade,
        "a free upgrade must not credit anything into the bank pool either"
    );

    let bo_upgraded_tile = MAP_GRID.load(&deps.storage, (game_id, G15_Q, G15_R)).unwrap();
    assert_eq!(bo_upgraded_tile.tile_id, 23);
}

/// Operating Sorting + Tie-Breaker Rule (`operations.rs` design notes
/// #7/#8): `calculate_operating_order` sorts floated companies by price,
/// highest first, and breaks an exact price tie by whichever protocol's
/// market marker most recently arrived (`ProtocolMarketState::arrival_sequence`,
/// higher first). A genuine tie between two *different* grid cells is
/// constructed directly against the authentic real 1830 price chart
/// (`market::seed_default_price_grid`/`REAL_MARKET_ROWS` -- see that
/// module's doc comment): NYC at (11, 10) and CPR at (12, 9) both land on
/// $180. Storage is seeded directly (an established pattern elsewhere in
/// this file, e.g.
/// `buy_stock_rejects_purchase_exceeding_global_certificate_limit`) rather
/// than played out through real trades, so the ordering and tie-break can
/// be asserted in isolation from any particular par-value/purchase path.
#[test]
fn calculate_operating_order_sorts_by_price_and_breaks_ties_by_arrival_recency() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const PRR_ID: u32 = 1;
    const NYC_ID: u32 = 2;
    const CPR_ID: u32 = 3;

    // Mark all three as floated -- calculate_operating_order only considers
    // floated companies, and none of these three have actually played
    // through a real flotation path in this test.
    for company_id in [PRR_ID, NYC_ID, CPR_ID] {
        let mut company = PUBLIC_COMPANIES
            .load(&deps.storage, (game_id, company_id))
            .unwrap();
        company.is_floated = true;
        PUBLIC_COMPANIES
            .save(deps.as_mut().storage, (game_id, company_id), &company)
            .unwrap();
    }

    // PRR: unambiguously the highest price, at (14, 10) -> $250 (real 1830
    // board cell -- see `market::REAL_MARKET_ROWS`).
    PROTOCOL_MARKET
        .save(
            deps.as_mut().storage,
            (game_id, PRR_ID),
            &ProtocolMarketState {
                protocol_id: PRR_ID,
                current_x: 14,
                current_y: 10,
                arrival_sequence: 1,
            },
        )
        .unwrap();

    // NYC: (11, 10) -> $180, arrived less recently.
    PROTOCOL_MARKET
        .save(
            deps.as_mut().storage,
            (game_id, NYC_ID),
            &ProtocolMarketState {
                protocol_id: NYC_ID,
                current_x: 11,
                current_y: 10,
                arrival_sequence: 50,
            },
        )
        .unwrap();

    // CPR: (12, 9) -> $180 -- an exact tie with NYC on a genuinely different
    // grid cell -- but arrived more recently, so it must win the tie-break
    // and rank ahead of NYC.
    PROTOCOL_MARKET
        .save(
            deps.as_mut().storage,
            (game_id, CPR_ID),
            &ProtocolMarketState {
                protocol_id: CPR_ID,
                current_x: 12,
                current_y: 9,
                arrival_sequence: 90,
            },
        )
        .unwrap();

    // Confirm the constructed tie is genuine before relying on it.
    let nyc_cell = MARKET_GRID.load(&deps.storage, (11, 10)).unwrap();
    let cpr_cell = MARKET_GRID.load(&deps.storage, (12, 9)).unwrap();
    assert_eq!(nyc_cell.price, Uint128::new(180));
    assert_eq!(cpr_cell.price, Uint128::new(180));
    let prr_cell = MARKET_GRID.load(&deps.storage, (14, 10)).unwrap();
    assert_eq!(prr_cell.price, Uint128::new(250));

    let order = operations::calculate_operating_order(&deps.storage, game_id)
        .expect("calculate_operating_order should succeed with three floated companies");
    assert_eq!(
        order,
        vec![PRR_ID, CPR_ID, NYC_ID],
        "expected PRR (highest price) first, then CPR ahead of NYC on the tie-break"
    );
}

/// Turn Enforcements (item 5): once `BeginOperatingRound` has populated
/// `GameSession::active_operating_order`, `LayTile`, `BuyHardwareFromPool`,
/// and `DeclareDividends` all reject a call whose `protocol_id` isn't the
/// corporation currently at the front of the queue -- and still succeed for
/// the corporation that *is*. Also covers `BeginOperatingRound`'s own
/// authorization (creator-only) and its `NoFloatedCompanies` guard.
#[test]
fn begin_operating_round_computes_price_order_and_gates_out_of_turn_corporate_actions() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const PRR_ID: u32 = 1;

    // Only the room's creator may begin an Operating Round -- same
    // authorization as `ExecuteOperatingRound`.
    let unauthorized_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("outsider", &[]),
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(
            unauthorized_err,
            ContractError::Operations(OperationsError::Unauthorized {})
        ),
        "expected Operations(Unauthorized), got: {unauthorized_err:?}"
    );

    // No company has floated yet -- the computed order is empty, which is
    // rejected outright rather than silently doing nothing.
    let no_floats_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(
            no_floats_err,
            ContractError::Operations(OperationsError::NoFloatedCompanies { .. })
        ),
        "expected Operations(NoFloatedCompanies), got: {no_floats_err:?}"
    );

    // Float B&O ($67 par) by winning its private.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // Float PRR at the higher $100 par value via six IPO purchases.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should set its $100 par value and succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }

    // PRR ($100) must sort ahead of B&O ($67).
    let begin_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .expect("begin_operating_round should succeed with two floated companies");
    assert_eq!(attr(&begin_res, "active_operating_order"), "1,4");
    assert_eq!(attr(&begin_res, "active_corporation_id"), "1");
    // Macro Round Tracker / Pacing Automation: no Hardware has been
    // purchased anywhere in this room yet, so the default 1-OR pacing
    // (the same baseline a 2-train would set) applies.
    assert_eq!(attr(&begin_res, "current_round_type"), "OperatingRound");
    assert_eq!(attr(&begin_res, "sub_round_index"), "1");
    assert_eq!(attr(&begin_res, "operating_round_sequence_length"), "1");

    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session.active_operating_order, vec![PRR_ID, BO_PUBLIC_ID]);
    assert_eq!(session.active_corporation_index, 0);
    assert_eq!(session.current_round_type, RoundType::OperatingRound);
    assert_eq!(session.sub_round_index, 1);
    assert_eq!(session.operating_round_sequence_length, 1);

    // PRR is at the front of the queue -- its President's calls succeed.
    let prr_orientation = lowest_legal_orientation(&deps.storage, game_id, PRR_ID, 50, 50, 8);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: PRR_ID,
            q: 50,
            r: 50,
            tile_id: 8,
            orientation: prr_orientation,
        },
    )
    .expect("PRR, at the front of the Operating Round queue, should be able to lay track");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .expect("PRR, at the front of the queue, should be able to buy Hardware");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::DeclareDividends {
            game_id,
            protocol_id: PRR_ID,
            revenue_amount: Uint128::new(50),
            distribute: false,
        },
    )
    .expect("PRR, at the front of the queue, should be able to declare dividends");

    // B&O is *not* at the front of the queue -- the same President's calls
    // for B&O must all be rejected, one per wrapped message type.
    let lay_tile_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 9,
            // Operating Round Turn Queue gating is checked before any
            // orientation-specific rule -- any in-range orientation
            // rejects identically.
            orientation: 0,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            lay_tile_err,
            ContractError::HexMap(HexMapError::NotYourOperatingTurn { .. })
        ),
        "expected HexMap(NotYourOperatingTurn), got: {lay_tile_err:?}"
    );

    let buy_hardware_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: BO_PUBLIC_ID,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            buy_hardware_err,
            ContractError::Hardware(HardwareError::NotYourOperatingTurn { .. })
        ),
        "expected Hardware(NotYourOperatingTurn), got: {buy_hardware_err:?}"
    );

    let dividends_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::DeclareDividends {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            revenue_amount: Uint128::new(50),
            distribute: false,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            dividends_err,
            ContractError::Trading(TradingError::NotYourOperatingTurn { .. })
        ),
        "expected Trading(NotYourOperatingTurn), got: {dividends_err:?}"
    );

    // Untouched by every rejected out-of-turn attempt: B&O has no home tile
    // and its treasury is still the flotation baseline.
    assert!(MAP_GRID
        .may_load(&deps.storage, (game_id, 0, 0))
        .unwrap()
        .is_none());
    let bo_company = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, BO_PUBLIC_ID))
        .unwrap();
    assert_eq!(bo_company.treasury, Uint128::new(670));
}

/// Macro Round Loop Advancement (`operations.rs` module doc comment #12):
/// `EndOperatingRoundTurn` advances `active_corporation_index` from PRR (the
/// front of the 2-company queue) to B&O, rejects both an out-of-turn call
/// from the wrong protocol and a call from a non-President, and -- once
/// both companies have ended their turn and this room's Pacing Automation
/// schedules only a single sub-round -- flips the room back to a
/// `StockRound` in the very same call B&O ends its turn with.
#[test]
fn end_operating_round_turn_advances_queue_and_closes_the_macro_round() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const PRR_ID: u32 = 1;

    // `execute_end_operating_round_turn` checks President registration
    // before it ever looks at `active_operating_order`, so the
    // "no active queue" probe below needs a President already on file for
    // PRR -- otherwise it would trip `NoPresidentAssigned` instead of the
    // `NoActiveOperatingOrder` this step means to exercise. Real play
    // always has this ordering satisfied automatically (PRR only ever
    // floats, and thus only ever gets an active queue entry, once someone
    // already holds >= the President threshold -- see
    // `trading::recalculate_president`); this is purely a mock-setup
    // sequencing fix, not a change to that real flotation path, which the
    // subsequent `BuyStock` calls below still exercise for real.
    PROTOCOL_PRESIDENT
        .save(deps.as_mut().storage, (game_id, PRR_ID), &player_one)
        .unwrap();

    // Calling before any Operating Round has ever begun must be rejected --
    // there's no active queue to end a turn in.
    let no_queue_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            no_queue_err,
            ContractError::Operations(OperationsError::NoActiveOperatingOrder { .. })
        ),
        "expected Operations(NoActiveOperatingOrder), got: {no_queue_err:?}"
    );

    // Float B&O and PRR, exactly like the sibling gating test above.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should set its $100 par value and succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }

    // Mandatory Train Purchase (Audit G-8): a corporation owning no
    // Hardware may not end its Operating Round turn while the pool still
    // has trains to sell it. Both queued corporations therefore need a
    // train before they can legally pass.
    //
    // Seeded straight into `COMPANY_HARDWARE` rather than played out
    // through `BuyHardwareFromPool`, because this test's subject is QUEUE
    // ADVANCEMENT, not train buying: a real purchase would also drain both
    // treasuries, bump `TRAINS_PURCHASED_COUNT` (changing the Pacing
    // Automation sequence length this test asserts on two lines below), and
    // -- for B&O specifically -- fire the B&O Special Closure on its
    // private company. Direct seeding is the same established pattern this
    // file already uses for `PROTOCOL_MARKET`/`PLAYER_SHARES` setup that
    // isn't itself under test.
    let starter_train = HardwareAsset {
        model_type: "2".to_string(),
        cost: Uint128::new(80),
        max_route_distance: 2,
    };
    for company_id in [PRR_ID, BO_PUBLIC_ID] {
        COMPANY_HARDWARE
            .save(
                deps.as_mut().storage,
                (game_id, company_id),
                &vec![starter_train.clone()],
            )
            .unwrap();
    }

    // PRR ($100) sorts ahead of B&O ($67) -- same order as the sibling test.
    let begin_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .expect("begin_operating_round should succeed with two floated companies");
    assert_eq!(attr(&begin_res, "active_operating_order"), "1,4");
    assert_eq!(attr(&begin_res, "operating_round_sequence_length"), "1");

    // A non-President may not end PRR's turn.
    let unauthorized_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info("outsider", &[]),
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            unauthorized_err,
            ContractError::Operations(OperationsError::NotPresident { .. })
        ),
        "expected Operations(NotPresident), got: {unauthorized_err:?}"
    );

    // B&O is not at the front of the queue -- ending its turn now is
    // rejected, exactly like `LayTile`/`BuyHardwareFromPool`/`DeclareDividends`
    // are in the sibling gating test.
    let out_of_turn_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id: BO_PUBLIC_ID,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            out_of_turn_err,
            ContractError::Operations(OperationsError::NotYourOperatingTurn { .. })
        ),
        "expected Operations(NotYourOperatingTurn), got: {out_of_turn_err:?}"
    );

    // PRR, at the front of the queue, ends its turn -- the pointer advances
    // to B&O; the macro round is untouched (still round 1, still an
    // Operating Round).
    let prr_end_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .expect("PRR, at the front of the queue, should be able to end its own turn");
    assert_eq!(
        attr(&prr_end_res, "outcome"),
        "advanced_to_next_corporation"
    );
    assert_eq!(attr(&prr_end_res, "active_corporation_index"), "1");
    assert_eq!(attr(&prr_end_res, "active_corporation_id"), "4");

    let mid_session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(mid_session.active_corporation_index, 1);
    assert_eq!(mid_session.macro_round_number, 1);
    assert_eq!(mid_session.current_round_type, RoundType::OperatingRound);

    // PRR can no longer end its own turn again -- it's B&O's turn now.
    let now_out_of_turn_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            now_out_of_turn_err,
            ContractError::Operations(OperationsError::NotYourOperatingTurn { .. })
        ),
        "expected Operations(NotYourOperatingTurn), got: {now_out_of_turn_err:?}"
    );

    // B&O, now at the front of the queue and the last corporation in the
    // order, ends its turn. `operating_round_sequence_length` is 1 (no
    // Hardware has been bought room-wide), so `sub_round_index` (1) has
    // already reached it -- this is the paced Operating Round phase's very
    // last sub-round's very last corporation, so Macro Round Loop
    // Advancement fires: `macro_round_number` bumps to 2, `sub_round_index`
    // resets to 0, and `current_round_type` flips back to `StockRound`.
    let bo_end_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id: BO_PUBLIC_ID,
        },
    )
    .expect("B&O, at the front of the queue, should be able to end its own turn");
    assert_eq!(attr(&bo_end_res, "outcome"), "macro_round_advanced");
    assert_eq!(attr(&bo_end_res, "macro_round_number"), "2");
    assert_eq!(attr(&bo_end_res, "sub_round_index"), "0");
    assert_eq!(attr(&bo_end_res, "current_round_type"), "StockRound");

    let final_session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(final_session.macro_round_number, 2);
    assert_eq!(final_session.sub_round_index, 0);
    assert_eq!(final_session.current_round_type, RoundType::StockRound);
    assert!(final_session.active_operating_order.is_empty());
    assert_eq!(final_session.active_corporation_index, 0);

    // The queue is now empty -- ending anyone's turn again is rejected as
    // "no active queue," exactly like before the room's first
    // `BeginOperatingRound` call.
    let queue_closed_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id: BO_PUBLIC_ID,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            queue_closed_err,
            ContractError::Operations(OperationsError::NoActiveOperatingOrder { .. })
        ),
        "expected Operations(NoActiveOperatingOrder), got: {queue_closed_err:?}"
    );
}

/// Pacing Automation (`hardware.rs` module doc comment #10): once every
/// 2-train is sold out of the pool and PRR buys the first-ever 3-train, the
/// *next* `BeginOperatingRound` call schedules 2 Operating Round sub-rounds
/// -- not the 1-OR default a room with no Hardware purchases gets (see
/// `begin_operating_round_computes_price_order_and_gates_out_of_turn_corporate_actions`
/// above).
#[test]
fn begin_operating_round_paces_multiple_operating_rounds_for_higher_train_tiers() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const PRR_ID: u32 = 1;

    // Float PRR at $100 par via six IPO purchases -- same recipe as
    // `begin_operating_round_computes_price_order_and_gates_out_of_turn_corporate_actions`,
    // capitalizing its treasury at $1,000 (10x par).
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should set its $100 par value and succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }

    // Directly seed the pool/purchase-count state to simulate every 2-train
    // already sold, rather than buying all six through PRR itself -- PRR is
    // deliberately the room's ONLY floated company for this test (so
    // `active_operating_order` below is unambiguous), and the Train Limit
    // cap (`hardware.rs` module doc comment #10a) now caps any one
    // corporation at 4 trains while Phase 2/3 is current, so a lone company
    // can never single-handedly buy all six 2-trains any more. Same
    // established direct-seeding pattern as
    // `lay_tile_enforces_era_color_locking_and_upgrade_topology_retention`.
    let mut seeded_pool = HARDWARE_POOL.load(&deps.storage, game_id).unwrap();
    let remaining_pool = seeded_pool.split_off(6);
    HARDWARE_POOL
        .save(deps.as_mut().storage, game_id, &remaining_pool)
        .unwrap();
    TRAINS_PURCHASED_COUNT
        .save(deps.as_mut().storage, (game_id, "2".to_string()), &6)
        .unwrap();

    // PRR buys the room's first-ever 3-train ($180, comfortably inside its
    // $1,000 treasury).
    let three_train_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .expect("PRR should be able to buy the first 3-train once every 2-train is gone");
    assert_eq!(attr(&three_train_res, "model_type"), "3");

    // Begin the Operating Round: pacing should now reflect the 3-train
    // tier's 2-OR schedule, not the 1-OR default.
    let begin_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .expect("begin_operating_round should succeed with PRR floated");
    assert_eq!(attr(&begin_res, "operating_round_sequence_length"), "2");

    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session.operating_round_sequence_length, 2);

    // Macro Round Loop Advancement, exercised through the full 2-sub-round
    // pace this 3-train tier schedules. PRR is the only floated company, so
    // it's always the sole entry in `active_operating_order`.
    //
    // Sub-round 1 -> 2: PRR is the only (and thus last) corporation in the
    // queue, but `sub_round_index` (1) hasn't yet reached
    // `operating_round_sequence_length` (2), so ending PRR's turn starts
    // the next sub-round instead of closing the macro round.
    let first_end_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .expect("PRR should be able to end its own turn to advance the sub-round pointer");
    assert_eq!(
        attr(&first_end_res, "outcome"),
        "advanced_to_next_sub_round"
    );
    assert_eq!(attr(&first_end_res, "sub_round_index"), "2");
    assert_eq!(attr(&first_end_res, "active_corporation_index"), "0");
    assert_eq!(attr(&first_end_res, "active_corporation_id"), "1");

    let mid_session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(mid_session.sub_round_index, 2);
    assert_eq!(mid_session.active_corporation_index, 0);
    assert_eq!(mid_session.active_operating_order, vec![PRR_ID]);
    assert_eq!(mid_session.macro_round_number, 1);
    assert_eq!(mid_session.current_round_type, RoundType::OperatingRound);

    // Sub-round 2 (the paced schedule's last): `sub_round_index` (2) has
    // now reached `operating_round_sequence_length` (2), so ending PRR's
    // turn this time closes out the whole macro round instead.
    let second_end_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .expect("PRR should be able to end its own turn to close the macro round");
    assert_eq!(attr(&second_end_res, "outcome"), "macro_round_advanced");
    assert_eq!(attr(&second_end_res, "macro_round_number"), "2");
    assert_eq!(attr(&second_end_res, "sub_round_index"), "0");
    assert_eq!(attr(&second_end_res, "current_round_type"), "StockRound");

    let final_session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(final_session.macro_round_number, 2);
    assert_eq!(final_session.sub_round_index, 0);
    assert_eq!(final_session.current_round_type, RoundType::StockRound);
    assert!(final_session.active_operating_order.is_empty());
    assert_eq!(final_session.active_corporation_index, 0);
    // Pacing Automation itself isn't recomputed by `EndOperatingRoundTurn`
    // (only `BeginOperatingRound` reads Hardware tiers) -- it's left at
    // whatever the just-finished Operating Round phase set it to, exactly
    // like the queue-populating fields are, until the room's next
    // `BeginOperatingRound` call recomputes it.
    assert_eq!(final_session.operating_round_sequence_length, 2);
}

/// Game State Query (items 1/2): `QueryMsg::GetGameState` returns an
/// accurate, up-to-date snapshot of player cash, company treasuries,
/// ownership registries, and round settings. Every asserted value below is
/// cross-checked directly against the underlying storage maps
/// (`PLAYER_CASH_VGP`, `PROTOCOL_PRESIDENT`) rather than only against
/// numbers this test computed by hand, so the query genuinely has to match
/// live state, not just this test's own arithmetic.
#[test]
fn query_game_state_reflects_live_player_cash_treasuries_and_ownership() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let player_two = Addr::unchecked("player_two");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_two.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_two should be able to join");

    const BO_PUBLIC_ID: u32 = 4;
    const PRR_ID: u32 = 1;

    // player_one is active first (index 0): wins B&O's private (floats
    // B&O, $670 treasury, $67 par), which advances the turn to player_two.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // Six alternating IPO purchases of PRR at $100 par float it at exactly
    // 60%, split three certificates (30%) each between player_two (who
    // buys first, since the turn just passed to them) and player_one.
    let buyers = [
        &player_two,
        &player_one,
        &player_two,
        &player_one,
        &player_two,
        &player_one,
    ];
    for (i, buyer) in buyers.iter().enumerate() {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(buyer.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: if i == 0 {
                    Some(Uint128::new(100))
                } else {
                    None
                },
            },
        )
        .unwrap_or_else(|err| panic!("PRR purchase #{i} by {buyer} should succeed: {err}"));
    }

    // Begin the Operating Round Corporation Turn Queue now that both
    // companies are floated -- PRR ($100) must sort ahead of B&O ($67), so
    // this also exercises GameStateResponse's round-settings fields.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .expect("begin_operating_round should succeed with two floated companies");

    // ---- Query and cross-check against the raw storage maps ----
    let state: GameStateResponse = from_json(
        &query_entry_point(
            deps.as_ref(),
            env.clone(),
            QueryMsg::GetGameState { game_id },
        )
        .expect("GetGameState should succeed"),
    )
    .expect("GetGameState's response should deserialize as GameStateResponse");

    assert_eq!(state.game_id, game_id);
    assert_eq!(state.creator, player_one);
    assert!(state.is_active);
    assert_eq!(
        state.player_addresses,
        vec![player_one.clone(), player_two.clone()]
    );
    assert_eq!(state.active_operating_order, vec![PRR_ID, BO_PUBLIC_ID]);
    assert_eq!(state.active_corporation_index, 0);
    // Macro Round Tracker / Pacing Automation round-settings fields (see
    // module doc comment above): no Hardware has been purchased in this
    // room, so the default 1-OR pacing applies, same as
    // `begin_operating_round_computes_price_order_and_gates_out_of_turn_corporate_actions`.
    assert_eq!(state.current_round_type, RoundType::OperatingRound);
    assert_eq!(state.macro_round_number, 1);
    assert_eq!(state.sub_round_index, 1);
    assert_eq!(state.operating_round_sequence_length, 1);

    assert_eq!(state.player_cash.len(), 2);
    for entry in &state.player_cash {
        let expected = PLAYER_CASH_VGP
            .load(&deps.storage, (game_id, entry.player.clone()))
            .unwrap();
        assert_eq!(
            entry.cash_vgp, expected,
            "queried cash for {} should match PLAYER_CASH_VGP exactly",
            entry.player
        );
    }

    let bo_state = state
        .public_companies
        .iter()
        .find(|c| c.company_id == BO_PUBLIC_ID)
        .expect("B&O should appear in public_companies");
    assert!(bo_state.is_floated);
    assert_eq!(bo_state.treasury, Uint128::new(670));
    assert_eq!(bo_state.par_value, Some(Uint128::new(67)));
    assert_eq!(
        bo_state.president,
        PROTOCOL_PRESIDENT
            .may_load(&deps.storage, (game_id, BO_PUBLIC_ID))
            .unwrap()
    );

    let prr_state = state
        .public_companies
        .iter()
        .find(|c| c.company_id == PRR_ID)
        .expect("PRR should appear in public_companies");
    assert!(prr_state.is_floated);
    assert_eq!(prr_state.treasury, Uint128::new(1_000)); // 10 x $100 par
    assert_eq!(prr_state.par_value, Some(Uint128::new(100)));
    assert_eq!(
        prr_state.president,
        PROTOCOL_PRESIDENT
            .may_load(&deps.storage, (game_id, PRR_ID))
            .unwrap()
    );
    let mut prr_holdings = prr_state.player_holdings.clone();
    prr_holdings.sort_by(|a, b| a.player.as_str().cmp(b.player.as_str()));
    assert_eq!(
        prr_holdings
            .iter()
            .map(|h| (h.player.clone(), h.percentage))
            .collect::<Vec<_>>(),
        vec![(player_one.clone(), 30), (player_two.clone(), 30)]
    );

    let bo_private = state
        .private_companies
        .iter()
        .find(|p| p.private_id == 6)
        .expect("Baltimore & Ohio should appear in private_companies");
    assert_eq!(bo_private.owner, Some(player_one.clone()));
    let untouched_private = state
        .private_companies
        .iter()
        .find(|p| p.private_id == 1)
        .expect("Schuylkill Valley should appear in private_companies");
    assert_eq!(untouched_private.owner, None);
}

/// Game State Query (item 1): `QueryMsg::GetMarketGrid` reports every core
/// public company's live position -- floated or not (module doc comment
/// #3 in `query.rs`) -- and updates the instant a company's marker
/// actually moves (here, PRR pinning to its $100 par cell).
#[test]
fn query_market_grid_reflects_live_positions_and_prices() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const PRR_ID: u32 = 1;

    // Before anyone has floated anything, every one of the eight core
    // public companies already has a seeded default position --
    // `market::DEFAULT_MARKET_POSITION` (6, 5), the real board's $67 par
    // cell -- from `market::initialize_game_market`.
    let market_before: MarketGridResponse = from_json(
        &query_entry_point(
            deps.as_ref(),
            env.clone(),
            QueryMsg::GetMarketGrid { game_id },
        )
        .expect("GetMarketGrid should succeed"),
    )
    .expect("GetMarketGrid's response should deserialize as MarketGridResponse");
    assert_eq!(market_before.game_id, game_id);
    assert_eq!(market_before.positions.len(), 8);
    for position in &market_before.positions {
        assert_eq!(position.x, 6);
        assert_eq!(position.y, 5);
        assert_eq!(position.price, Some(Uint128::new(67)));
    }

    // Float PRR at $100 par via six IPO purchases (single-player room, so
    // the turn pointer trivially wraps back to player_one every time).
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should set its $100 par value and succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }

    let market_after: MarketGridResponse = from_json(
        &query_entry_point(
            deps.as_ref(),
            env.clone(),
            QueryMsg::GetMarketGrid { game_id },
        )
        .expect("GetMarketGrid should succeed"),
    )
    .expect("GetMarketGrid's response should deserialize as MarketGridResponse");

    let prr_position = market_after
        .positions
        .iter()
        .find(|p| p.company_id == PRR_ID)
        .expect("PRR should appear in the market grid");
    assert_eq!(prr_position.x, 6); // PAR_VALUE_LADDER's $100 cell
    assert_eq!(prr_position.y, 10);
    assert_eq!(prr_position.price, Some(Uint128::new(100)));

    // Every other company's position is untouched by PRR's flotation.
    for position in market_after
        .positions
        .iter()
        .filter(|p| p.company_id != PRR_ID)
    {
        assert_eq!(position.x, 6);
        assert_eq!(position.y, 5);
        assert_eq!(position.price, Some(Uint128::new(67)));
    }
}

/// Terminal-based Markdown State Printer (item 3): `QueryMsg::GetMapGrid`
/// and `QueryMsg::GetMapGridMarkdown` both reflect exactly the tiles laid
/// via `LayTile` -- including the New York landmark hub -- and
/// `query::print_markdown_map` renders identically whether reached through
/// the query dispatcher or called directly with an already-fetched tile
/// list. The `println!` call below is the actual demonstration of this
/// module's documented off-chain usage (`query.rs` module doc comment #4):
/// run with `cargo test query_map_grid_and_markdown -- --nocapture` to see
/// it print to the terminal.
#[test]
fn query_map_grid_and_markdown_reflect_laid_tiles_and_landmarks() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const NEW_YORK_Q: i32 = 6;
    const NEW_YORK_R: i32 = 6;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // B&O's very first tile ever is laid directly at the New York landmark.
    // Module doc comment #28: New York is now "NY"-label-restricted at
    // every tier, so there's no legal Yellow hub tile at this hex any more
    // -- era is unlocked to Green and the designated Green NewYorkHub tile
    // (17) is used instead, same recipe as
    // `lay_tile_enforces_landmark_reservation`'s own #28 update.
    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();
    let chosen_home_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, NEW_YORK_Q, NEW_YORK_R, 54);
    let home_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q,
            r: NEW_YORK_R,
            tile_id: 54,
            orientation: chosen_home_orientation,
        },
    )
    .expect("B&O's home hub tile at New York should succeed");
    let home_orientation: u8 = attr(&home_res, "orientation").parse().unwrap();

    // A second, ordinary tile extending the network one hex east -- its
    // exact orientation is read back from the response rather than
    // hand-derived, so this test doesn't duplicate the connectivity/
    // rotation math already covered by
    // `lay_tile_enforces_path_connectivity_to_token_station`.
    let chosen_extend_orientation = lowest_legal_orientation(
        &deps.storage,
        game_id,
        BO_PUBLIC_ID,
        NEW_YORK_Q + 1,
        NEW_YORK_R,
        8,
    );
    let extend_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: NEW_YORK_Q + 1,
            r: NEW_YORK_R,
            tile_id: 8,
            orientation: chosen_extend_orientation,
        },
    )
    .expect("a tile truly adjacent to the New York hub should find a legal rotation");
    let extend_orientation: u8 = attr(&extend_res, "orientation").parse().unwrap();

    // ---- QueryMsg::GetMapGrid ----
    let map: MapGridResponse = from_json(
        &query_entry_point(deps.as_ref(), env.clone(), QueryMsg::GetMapGrid { game_id })
            .expect("GetMapGrid should succeed"),
    )
    .expect("GetMapGrid's response should deserialize as MapGridResponse");
    assert_eq!(map.game_id, game_id);
    assert_eq!(map.tiles.len(), 2);

    // Both tiles share r=0, so the (r, q) sort orders them by q ascending.
    assert_eq!(map.tiles[0].q, NEW_YORK_Q);
    assert_eq!(map.tiles[0].r, NEW_YORK_R);
    // Coordinate Symmetries (`hexmap.rs` module doc comment #15): New
    // York's laid tile carries its real board label alongside (q, r).
    assert_eq!(map.tiles[0].hex_label, "G19");
    assert_eq!(map.tiles[0].tile_id, 54);
    assert_eq!(map.tiles[0].orientation, home_orientation);
    assert_eq!(map.tiles[0].landmark, Some("New York".to_string()));

    assert_eq!(map.tiles[1].q, NEW_YORK_Q + 1);
    assert_eq!(map.tiles[1].r, NEW_YORK_R);
    // (7, 6) isn't one of the real board's 93 hexes -- `describe_hex`
    // still returns a ready-to-display fallback string, not `None`.
    assert_eq!(
        map.tiles[1].hex_label,
        hexmap::describe_hex(NEW_YORK_Q + 1, NEW_YORK_R)
    );
    assert_eq!(map.tiles[1].tile_id, 8);
    assert_eq!(map.tiles[1].orientation, extend_orientation);
    assert_eq!(map.tiles[1].landmark, None);

    // ---- QueryMsg::GetMapGridMarkdown ----
    let markdown_response: MapGridMarkdownResponse = from_json(
        &query_entry_point(
            deps.as_ref(),
            env.clone(),
            QueryMsg::GetMapGridMarkdown { game_id },
        )
        .expect("GetMapGridMarkdown should succeed"),
    )
    .expect("GetMapGridMarkdown's response should deserialize as MapGridMarkdownResponse");
    assert_eq!(markdown_response.game_id, game_id);
    assert!(markdown_response.markdown.contains("Map Grid"));
    assert!(markdown_response.markdown.contains("New York"));
    assert!(markdown_response
        .markdown
        .contains(&format!("{NEW_YORK_Q}")));
    // Coordinate Symmetries: the rendered Markdown table leads with the
    // real board label column, not just the bare axial pair.
    assert!(markdown_response.markdown.contains("G19"));
    assert!(markdown_response.markdown.contains("| Label |"));

    // The off-chain "print to the terminal" step this module's design
    // notes describe -- a deployed contract can only ever return this
    // string; actually writing it to a terminal happens here, in ordinary
    // native test code. Run with `--nocapture` to see it.
    println!("{}", markdown_response.markdown);

    // `print_markdown_map` called directly on an already-fetched tile
    // list (as `query_map_grid_markdown` itself does internally) must
    // render byte-for-byte identically to the query response.
    let direct_markdown = query::print_markdown_map(game_id, &map.tiles);
    assert_eq!(direct_markdown, markdown_response.markdown);
}

/// Payout Security Fix: `EndGameAndDistribute` no longer accepts a
/// caller-submitted `final_player_points` list -- it computes each
/// player's final VGP net worth automatically, on-chain, from
/// `PLAYER_CASH_VGP` plus the live market value of their `PLAYER_SHARES`
/// holdings (see `contract::appraise_player_net_worth`). This test buys
/// CPR's par value up to exactly $100 (the top of the standard 1830 par
/// ladder) so the on-chain share-value math divides evenly, making the
/// expected payout figures exact rather than requiring the test to
/// re-derive the contract's own rounding.
///
/// **Audit G-1 regression guard.** This test's expectations were rewritten
/// when the 10x share-valuation bug was fixed -- it previously ENCODED that
/// bug, asserting that 10% of a $100 company was worth $10. `MARKET_GRID`'s
/// price is the price of one 10% certificate, so 10% is worth the full
/// $100. The assertion below is deliberately shaped so it can only pass
/// under the correct valuation: player_a converts exactly $100 of cash into
/// exactly one $100 certificate, which must leave their net worth
/// *unchanged* at $1,200 and therefore exactly equal to player_b's
/// untouched $1,200 -- so each player must be refunded precisely their own
/// $231,000 ante, with zero dust. Under the old `price * pct / 100` math
/// player_a's stock would have appraised at $10, making the two net worths
/// unequal ($1,110 vs $1,200) and the payouts $222,000/$240,000 instead.
#[test]
fn end_game_and_distribute_computes_payout_from_on_chain_cash_and_share_value() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            // Zero subsidy keeps the real-JUNO lobby pool exactly equal to
            // the deposit, so the expected payout figures below don't also
            // need to account for a subsidy cut.
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    // Deposit chosen so the combined real-JUNO pool divides evenly by the
    // players' combined net worth ($2,310) computed below. Under the
    // Uniform Ante Rule, player_b's join must match player_a's $231,000
    // ante exactly, so the pool is $231,000 + $231,000 = $462,000 total,
    // not just player_a's own deposit.
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(231_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(231_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const CPR_COMPANY_ID: u32 = 3;

    // player_a buys CPR's very first-ever IPO certificate (10%) at the
    // top standard par value, $100 -- both a legal par choice and one
    // that makes the on-chain share-value division ($100 * 10% = $10
    // exactly) land on a whole number.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: CPR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("player_a's IPO purchase should succeed");

    // player_a: starting $1,200 cash - $100 IPO purchase = $1,100 cash,
    // plus one 10% CPR certificate priced at CPR's live $100 market cell =
    // $100 share value -> $1,200 net worth (unchanged: they swapped $100 of
    // cash for $100 of stock).
    let player_a_cash = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    assert_eq!(player_a_cash, Uint128::new(1_100));
    // player_b: untouched -- $1,200 cash, no shares, $1,200 net worth.
    let player_b_cash = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_b.clone()))
        .unwrap();
    assert_eq!(player_b_cash, Uint128::new(1_200));

    // Cross-check the appraiser directly, so a future regression points at
    // the valuation rather than only at the payout arithmetic downstream.
    // Neither player owns a private company here (`skip_waterfall_auction`
    // leaves all six unowned), so the private-company term is $0 for both.
    let player_a_net_worth: PlayerNetWorthResponse =
        query::query_player_net_worth(deps.as_ref(), game_id, player_a.to_string())
            .expect("querying player_a's net worth should succeed");
    assert_eq!(player_a_net_worth.cash_vgp, Uint128::new(1_100));
    assert_eq!(
        player_a_net_worth.stock_portfolio_value,
        Uint128::new(100),
        "10% of a $100-par company is ONE certificate at the full $100 \
         market price -- not $10 (Audit G-1)"
    );
    assert_eq!(player_a_net_worth.net_worth, Uint128::new(1_200));

    // Total net worth = $1,200 + $1,200 = $2,400. Pool (player_a's $231,000
    // + player_b's matching $231,000 ante = $462,000) / total ($2,400) =
    // $192.5 per point, applied as exact integer math per player:
    //   player_a payout = 462,000 * 1,200 / 2,400 = $231,000
    //   player_b payout = 462,000 * 1,200 / 2,400 = $231,000
    //   distributed      = $462,000 = the entire pool -- zero dust.
    let payout_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::EndGameAndDistribute { game_id },
    )
    .expect("the room creator should be able to close out the game");

    assert_eq!(attr(&payout_res, "total_juno_pool_distributed"), "462000");
    assert_eq!(attr(&payout_res, "dust_swept_to_treasury"), "0");
    assert_eq!(
        payout_res.messages.len(),
        2,
        "expected exactly one BankMsg::Send per player and no dust sweep"
    );

    match &payout_res.messages[0].msg {
        CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
            assert_eq!(to_address, player_a.as_str());
            assert_eq!(amount.len(), 1);
            assert_eq!(amount[0].denom, NATIVE_DENOM);
            assert_eq!(amount[0].amount, Uint128::new(231_000));
        }
        other => panic!("expected a BankMsg::Send to player_a, got: {other:?}"),
    }
    match &payout_res.messages[1].msg {
        CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
            assert_eq!(to_address, player_b.as_str());
            assert_eq!(amount.len(), 1);
            assert_eq!(amount[0].denom, NATIVE_DENOM);
            assert_eq!(amount[0].amount, Uint128::new(231_000));
        }
        other => panic!("expected a BankMsg::Send to player_b, got: {other:?}"),
    }

    let session_after = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert!(!session_after.is_active);
    assert_eq!(session_after.total_juno_pool, Uint128::zero());

    // Calling it again must fail cleanly -- the room is no longer active.
    let repeat_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::EndGameAndDistribute { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(repeat_err, ContractError::GameNotActive { .. }),
        "expected GameNotActive, got: {repeat_err:?}"
    );
}

/// $350 Game-End Trigger (`trading.rs` module doc comment #16,
/// `market::GAME_END_PRICE_TRIGGER`): artificially drives a corporation's
/// stock marker to the real 1830 chart's single highest cell, $350 (grid
/// position `(18, 10)` -- see `market::REAL_MARKET_ROWS`), one Distribute
/// Yield dividend short, then declares that dividend and confirms the room
/// automatically deactivates and runs a clean final payout in the very
/// same call -- no separate `EndGameAndDistribute` message needed. Seeds
/// `PROTOCOL_MARKET` directly at the $325 cell one column short of $350
/// (the same direct-storage-seeding pattern as
/// `calculate_operating_order_sorts_by_price_and_breaks_ties_by_arrival_recency`),
/// so the trigger fires on the very next `move_right` without first playing
/// out every intermediate dividend.
#[test]
fn declare_dividends_auto_triggers_game_end_at_350_price() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_ID: u32 = 1;

    // player_a is PRR's President -- no shares need to actually be bought
    // for `DeclareDividends`'s own checks (only `PROTOCOL_PRESIDENT` and
    // the caller's identity are validated); every player's share of PRR
    // stays at the unseeded default (0%), so this dividend's entire
    // `revenue_amount` becomes the bank's own share and every player's
    // final net worth below is just their plain VGP cash balance.
    PROTOCOL_PRESIDENT
        .save(deps.as_mut().storage, (game_id, PRR_ID), &player_a)
        .unwrap();

    // Seed PRR's marker one column short of the chart's top cell: (17, 10)
    // -> $325 (see `market::REAL_MARKET_ROWS`'s highest row). The next
    // Distribute Yield's `move_right` lands it on (18, 10) -> $350.
    PROTOCOL_MARKET
        .save(
            deps.as_mut().storage,
            (game_id, PRR_ID),
            &ProtocolMarketState {
                protocol_id: PRR_ID,
                current_x: 17,
                current_y: 10,
                arrival_sequence: 1,
            },
        )
        .unwrap();
    let pre_trigger_cell = MARKET_GRID.load(&deps.storage, (17, 10)).unwrap();
    assert_eq!(
        pre_trigger_cell.price,
        Uint128::new(325),
        "test setup assumption: (17, 10) must be the real board's $325 cell"
    );

    let session_before = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert!(session_before.is_active, "room must start active");

    let player_a_cash_before = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    let player_b_cash_before = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_b.clone()))
        .unwrap();
    let total_juno_pool_before = session_before.total_juno_pool;

    let dividend_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::DeclareDividends {
            game_id,
            protocol_id: PRR_ID,
            revenue_amount: Uint128::new(50),
            distribute: true,
        },
    )
    .expect("the triggering dividend itself must still succeed cleanly");

    // The triggering movement landed on the $350 cell.
    assert_eq!(attr(&dividend_res, "new_price"), "350");
    assert_eq!(attr(&dividend_res, "new_x"), "18");
    assert_eq!(attr(&dividend_res, "new_y"), "10");
    let triggered_cell = MARKET_GRID.load(&deps.storage, (18, 10)).unwrap();
    assert_eq!(triggered_cell.price, Uint128::new(350));

    // The auto-trigger fired and folded a full payout response into this
    // same call -- no separate `EndGameAndDistribute` message was sent.
    assert_eq!(attr(&dividend_res, "game_end_triggered"), "true");
    assert_eq!(
        attr(&dividend_res, "total_juno_pool_distributed"),
        total_juno_pool_before.to_string(),
        "the whole pool (no shares held, so no share-value complexity) should be distributed"
    );
    assert_eq!(
        dividend_res.messages.len(),
        2,
        "expected exactly one BankMsg::Send per player and no dust sweep"
    );
    for msg in &dividend_res.messages {
        match &msg.msg {
            CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
                assert!(
                    to_address == player_a.as_str() || to_address == player_b.as_str(),
                    "unexpected payout recipient: {to_address}"
                );
                assert_eq!(amount.len(), 1);
                assert_eq!(amount[0].denom, NATIVE_DENOM);
            }
            other => panic!("expected a BankMsg::Send, got: {other:?}"),
        }
    }

    // The room is durably closed -- exactly what "halt all further player
    // turns" means in practice (see `contract::finalize_and_distribute_payouts`).
    let session_after = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert!(!session_after.is_active);
    assert_eq!(session_after.total_juno_pool, Uint128::zero());

    // Every subsequent action -- even one that would otherwise be
    // perfectly legal -- is now rejected. `PassTurn` routes through
    // `gamelog::execute_pass_turn` (`GameLogError`, not `TradingError`).
    let post_trigger_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(
            post_trigger_err,
            ContractError::GameLog(crate::gamelog::GameLogError::GameNotActive { .. })
        ),
        "expected GameNotActive, got: {post_trigger_err:?}"
    );

    // Sanity: player_a's dividend-recipient cash never moved (0% held), so
    // net worth was decided purely by pre-existing cash balances -- confirm
    // via the untouched-cash assumption used in the assertions above.
    let player_a_cash_after = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a))
        .unwrap();
    let player_b_cash_after = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_b))
        .unwrap();
    assert_eq!(player_a_cash_after, player_a_cash_before);
    assert_eq!(player_b_cash_after, player_b_cash_before);
}

/// Legal Tile Query (`QueryMsg::GetLegalTilePlacements`): exercises the
/// fresh-placement branch of `hexmap::legal_tile_placements` -- a
/// protocol's very first tile (unconditionally legal at orientation 0 for
/// any era-unlocked, landmark-compatible catalog entry), a tile genuinely
/// adjacent to an already-laid network (only the rotations that actually
/// connect), a tile nowhere near the network (no legal placements at all),
/// and the Landmark Reservation rule (only the designated hub tile is ever
/// legal at a reserved city hex). Cross-validates the query's claims
/// against the real `LayTile` handler wherever practical, so this test
/// fails if the two ever disagree.
#[test]
fn legal_tile_placements_reflects_connectivity_and_landmark_rules() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const PRR_ID: u32 = 1;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // ---- Very first tile ever for B&O, at (0, 0): every Yellow,
    // non-hub, non-town catalog tile is legal, unconditionally, at EVERY
    // orientation -- Green/Brown tiles are still era-locked, the hub tile
    // (10) is City-reserved, and the town tiles (3 SmallTown, 6 DoubleTown)
    // are now Town-Designation-reserved (module doc comment #16), so none
    // of those three belong here. (0, 0) isn't a real board hex at all, so
    // it carries no Town designation and no Impassable Border Edges entry
    // -- leaving only the Plain/MountainRugged tiles {1, 2, 4, 5}, each
    // legal at all six rotations.
    //
    // CORRECTION (Rigid On-Chain Tile Matching pass): before the Town/
    // Double-Town Reservation gate existed, tile 3 (SmallTown) was also
    // unconditionally legal here, and tile 6 (DoubleTown) didn't exist yet
    // -- this assertion's expected array is updated to drop tile 3 and
    // reflect that tile 6 is excluded too, both independently verified
    // against `execute_lay_tile`'s City/Town match blocks above rather than
    // taken on faith.
    //
    // CORRECTION 2 (orientation-parity bugfix): this used to assert only
    // orientation 0 for each tile, matching a bug in this very-first-tile
    // branch of `legal_tile_placements` that unconditionally hardcoded
    // orientation 0 -- but `execute_lay_tile`'s own very-first-tile branch
    // (its `None => { ... }` arm, `station.is_some()` false) has never
    // restricted a brand-new Token Station to orientation 0; it accepts
    // whichever orientation the caller actually submits, 0..=5, since
    // there's no existing network yet to validate connectivity against.
    // Fixed to enumerate all six rotations per catalog entry, matching
    // `execute_lay_tile` exactly; this assertion is updated accordingly
    // rather than continuing to assert the pre-bugfix (wrong) behavior.
    let query_before = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let before_resp: LegalTilePlacementsResponse = from_json(&query_before).unwrap();
    // Coordinate Symmetries: (0, 0) isn't one of the real board's 93 hexes,
    // so the response's `hex_label` is the ready-to-display fallback.
    assert_eq!(
        before_resp.hex_label,
        "(0, 0) [off the authentic 1830 board]"
    );
    let mut before_pairs: Vec<(u32, u8)> = before_resp
        .placements
        .iter()
        .map(|p| (p.tile_id, p.orientation))
        .collect();
    before_pairs.sort();
    // The full 46-tile catalog (Audit G-5) has exactly three Yellow PLAIN
    // tiles -- real 1830 tray #7 (sharp curve), #8 (gentle curve) and #9
    // (straight). Those are the only entries legal at an ordinary blank
    // hex: the Yellow town tiles (#3/#4/#58 single, #1/#2/#55/#56/#69
    // double) are town-reserved, #57 is city-reserved, and every Green and
    // Brown tile is era-locked in a room that has never bought a 3-train.
    //
    // This list used to read `[1, 2, 4, 5]` -- the old internal numbering,
    // in which 4 and 5 were the INVENTED river/mountain tiles that G-10
    // deleted (terrain is a hex property in real 1830, never a tile).
    let mut expected_before_pairs: Vec<(u32, u8)> = [7u32, 8, 9]
        .iter()
        .flat_map(|&tile_id| (0..6u8).map(move |orientation| (tile_id, orientation)))
        .collect();
    expected_before_pairs.sort();
    assert_eq!(
        before_pairs, expected_before_pairs,
        "every Yellow plain tile should be legal at every orientation for a brand-new Token Station"
    );

    // Cross-validate: actually laying tile #9 there (as the query claims is
    // legal) must succeed, at orientation 0.
    let home_orientation = lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 0, 0, 9);
    let home_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 9,
            orientation: home_orientation,
        },
    )
    .expect("tile #9 should be a legal home tile, matching the query");
    assert_eq!(attr(&home_res, "orientation"), "0");

    // ---- (1, 0) is a true neighbor of (0, 0) via edge 0's offset. The
    // query must at least include the same (tile #8, orientation 1) pairing
    // the pre-existing connectivity test already proves `execute_lay_tile`
    // itself picks, and must exclude the era-locked and landmark-only
    // tiles.
    let query_neighbor = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 1,
            r: 0,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let neighbor_resp: LegalTilePlacementsResponse = from_json(&query_neighbor).unwrap();
    assert!(
        neighbor_resp
            .placements
            .iter()
            .any(|p| p.tile_id == 8 && p.orientation == 1),
        "expected (tile_id=8, orientation=1) among the legal placements at (1, 0), got: {:?}",
        neighbor_resp.placements
    );
    // #57 (yellow city) and #14/#63 (green/brown city) are city-reserved,
    // so they are never legal at an ordinary blank hex in ANY era; #23
    // (green plain) and #43 (brown plain) are ordinary track but still
    // era-locked, since this room has never bought a 3-train and is
    // therefore still in the Yellow era.
    for locked_id in [57u32, 14, 63, 23, 43] {
        assert!(
            !neighbor_resp
                .placements
                .iter()
                .any(|p| p.tile_id == locked_id),
            "tile {locked_id} should never be legal at an ordinary, era-locked-or-hub-only hex"
        );
    }

    // Cross-validate: actually laying tile #8 there succeeds at exactly the
    // orientation the query reported.
    let connect_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 1, 0, 8);
    let connect_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 1,
            r: 0,
            tile_id: 8,
            orientation: connect_orientation,
        },
    )
    .expect("tile 2 should legally connect at (1, 0), matching the query");
    assert_eq!(attr(&connect_res, "orientation"), "1");

    // ---- (100, 100) is nowhere near B&O's two-hex network -- no rotation
    // of any catalog tile can legally connect there, so the query must
    // return an empty list.
    let query_far = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 100,
            r: 100,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let far_resp: LegalTilePlacementsResponse = from_json(&query_far).unwrap();
    assert!(
        far_resp.placements.is_empty(),
        "expected no legal placements far from the network, got: {:?}",
        far_resp.placements
    );

    // Cross-validate: actually attempting it fails with NoLegalConnection.
    let disconnected_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 100,
            r: 100,
            tile_id: 9,
            // (100, 100) is nowhere near B&O's network -- any in-range
            // orientation rejects identically.
            orientation: 0,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            disconnected_err,
            ContractError::HexMap(HexMapError::NoLegalConnection { .. })
        ),
        "expected HexMap(NoLegalConnection), got: {disconnected_err:?}"
    );

    // ---- Landmark Reservation, Yellow Phase: module doc comment #28 widened
    // New York's "NY"-label restriction to every tier, not just Green/Brown
    // -- New York never takes a plain Yellow tile lay in real 1830 at all
    // (it's a corporation's home station and goes straight to its own
    // dedicated Green tile as its first lay), and there is no Yellow-tier
    // `NewYorkHub` catalog entry to offer instead. So PRR (a completely
    // fresh protocol with no network yet), queried at the New York landmark
    // while the room is still in the Yellow era, must get back an empty
    // placements list -- not the old `(10, 0..=5)` six-orientation set from
    // before that design note.
    let query_landmark_yellow = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: PRR_ID,
            q: 6,
            r: 6,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let landmark_yellow_resp: LegalTilePlacementsResponse = from_json(&query_landmark_yellow).unwrap();
    // Coordinate Symmetries: this query's coordinate is New York's real
    // board label.
    assert_eq!(landmark_yellow_resp.hex_label, "G19");
    assert!(
        landmark_yellow_resp.placements.is_empty(),
        "expected no legal Yellow-tier placements at New York (module doc comment #28), got: {:?}",
        landmark_yellow_resp.placements
    );

    // ---- Landmark Reservation, Green Phase: once the era is unlocked to
    // Green, New York's designated `NewYorkHub` tile (internal catalog id
    // 17, the real tobymao/18xx tray tile #54) becomes legal there --
    // still, per the same orientation-parity bugfix as the Yellow-era case
    // used to demonstrate, at all six rotations, since PRR has no network
    // yet and no tile has been laid at this hex yet (no Topology Retention
    // check applies).
    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();
    let query_landmark_green = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: PRR_ID,
            q: 6,
            r: 6,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let landmark_green_resp: LegalTilePlacementsResponse = from_json(&query_landmark_green).unwrap();
    assert_eq!(landmark_green_resp.hex_label, "G19");
    let mut landmark_green_pairs: Vec<(u32, u8)> = landmark_green_resp
        .placements
        .iter()
        .map(|p| (p.tile_id, p.orientation))
        .collect();
    landmark_green_pairs.sort();
    // G19 is New York, an "NY"-labeled hex: its Green tier admits exactly
    // one tile, real 1830 tray #54, and nothing else -- at all six
    // rotations, since PRR has no network here and the hex is empty. Was
    // hardcoded to the old internal id 17 before the catalog moved to real
    // tray numbers (Audit G-5).
    assert_eq!(
        landmark_green_pairs,
        vec![(54, 0), (54, 1), (54, 2), (54, 3), (54, 4), (54, 5)]
    );
}

/// Legal Tile Query, Topology Retention branch: after B&O's Yellow home
/// tile (tile 1, edges 0 & 3) is laid at (0, 0) and the room's Tech Era is
/// advanced to Green, only a genuine one-tier-up Green tile whose some
/// rotation preserves both of tile 1's existing edges is ever legal there
/// -- Yellow tiles (no longer a fresh hex), Brown tiles (two tiers up),
/// the landmark-only Green hub, and any Green tile whose shape can never
/// cover {0, 3} at any rotation are all excluded.
#[test]
fn legal_tile_placements_reflects_topology_retention_upgrade_rules() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    let home_orientation = lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 0, 0, 9);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 9,
            orientation: home_orientation,
        },
    )
    .expect("B&O's home tile should be free to lay");

    // Directly unlock the Green era for this room -- a shortcut around the
    // multi-step Hardware-purchase recipe already exercised end-to-end by
    // `lay_tile_enforces_era_color_locking_and_upgrade_topology_retention`;
    // this test is only about the query's upgrade-path filtering, not the
    // era-unlock mechanism itself. Mirrors the same direct-storage-write
    // setup shortcut used elsewhere in this file (see
    // `calculate_operating_order_sorts_by_price_and_breaks_ties_by_arrival_recency`).
    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    let query_res = query_entry_point(
        deps.as_ref(),
        env.clone(),
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
        },
    )
    .expect("GetLegalTilePlacements should succeed");
    let resp: LegalTilePlacementsResponse = from_json(&query_res).unwrap();

    // Now that the catalog holds all 46 real 1830 tiles, this block asserts
    // the RULE rather than a hand-enumerated answer per tile -- a fixed
    // per-tile orientation list would have to be recomputed by hand every
    // time the catalog changes, which is exactly the brittleness that made
    // the pre-46-tile version of this test need rewriting.
    //
    // The rule: every placement offered over an existing tile must be
    // exactly one colour tier up (Green here) and must preserve every one
    // of the existing tile's live edges at the offered rotation.
    let existing = MAP_GRID.load(&deps.storage, (game_id, 0, 0)).unwrap();
    let existing_edges =
        hexmap::rotate_connections(existing.connections, existing.orientation);
    assert_ne!(existing_edges, 0, "the hex under test must already carry track");

    assert!(
        !resp.placements.is_empty(),
        "an occupied hex under an unlocked Green era must offer some upgrade"
    );
    for placement in &resp.placements {
        let entry = hexmap::TILE_CATALOG
            .iter()
            .copied()
            .find(|(id, ..)| *id == placement.tile_id)
            .expect("every offered tile must exist in the catalog");
        let (_, base_connections, _cost, _terrain, colour, _qty, _paths) = entry;
        assert_eq!(
            colour,
            TileColor::Green,
            "tile {} is {:?}, but only the next colour tier up may be offered here",
            placement.tile_id,
            colour
        );
        let candidate = hexmap::rotate_connections(base_connections, placement.orientation);
        assert_eq!(
            existing_edges & !candidate,
            0,
            "tile {} at orientation {} drops one of the existing tile's edges",
            placement.tile_id,
            placement.orientation
        );
    }

    // Spot-check one specific real tile: #23 (Green plain, base edges
    // {0, 3, 4}) covers the existing straight {0, 3} at exactly two
    // rotations -- 0 (edges {0,3,4}) and 3 (edges {0,1,3}).
    let tile_23_orientations: Vec<u8> = resp
        .placements
        .iter()
        .filter(|p| p.tile_id == 23)
        .map(|p| p.orientation)
        .collect();
    assert_eq!(tile_23_orientations, vec![0, 3]);

    // Green city tiles (#14, #15) are city-reserved -- (0, 0) isn't a
    // landmark or a preprinted city hex -- so they're excluded regardless
    // of topology.
    assert!(!resp.placements.iter().any(|p| p.tile_id == 14));
    assert!(!resp.placements.iter().any(|p| p.tile_id == 15));
    // The label-restricted Green tiles are excluded for the same reason.
    for reserved_id in [53u32, 54, 59] {
        assert!(!resp.placements.iter().any(|p| p.tile_id == reserved_id));
    }
    // Every Yellow tile is excluded outright: an occupied hex only ever
    // offers upgrade candidates, never a fresh same-or-lower-tier
    // placement.
    for yellow_id in [1u32, 2, 3, 4, 7, 8, 9, 55, 56, 57, 58, 69] {
        assert!(!resp.placements.iter().any(|p| p.tile_id == yellow_id));
    }
    // And every Brown tile is still era-locked -- the room only reaches
    // Green.
    for brown_id in [39u32, 43, 61, 62, 63, 66, 70] {
        assert!(!resp.placements.iter().any(|p| p.tile_id == brown_id));
    }

    // Cross-validate against the real handler: tile 11 actually succeeds
    // as an upgrade, matching the query's claim, when the caller submits
    // the lowest orientation the query reported (execute_lay_tile no
    // longer searches rotations itself -- see `hexmap.rs` module doc
    // comment #4 -- so this test submits the query's own answer as the
    // explicit chosen orientation).
    let upgrade_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 0, 0, 23);
    let upgrade_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 0,
            r: 0,
            tile_id: 23,
            orientation: upgrade_orientation,
        },
    )
    .expect("tile #23 should be a legal Green upgrade, matching the query");
    assert_eq!(attr(&upgrade_res, "orientation"), "0");
    assert_eq!(attr(&upgrade_res, "is_upgrade"), "true");
}

/// Exercises the Inactivity Timeout Safety Valve
/// (`ExecuteMsg::ClaimTimeoutRefund`): rejected outright before 48 hours
/// have elapsed since `GameSession::last_action_timestamp`; a qualifying
/// action (`PassTurn`) refreshes that timestamp, delaying eligibility;
/// and, once the mock block time is advanced past the threshold, any
/// registered player (not just the room's creator) can close the room and
/// refund each player's *exact* original real-JUNO ante -- not a
/// recomputed or proportional VGP-based split, unlike
/// `EndGameAndDistribute`.
#[test]
fn claim_timeout_refund_after_48_hours_of_inactivity_refunds_exact_antes() {
    let mut deps = mock_dependencies();
    let mut env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    // player_a deposits 5,000 ujuno to create the room; the Uniform Ante
    // Rule (`execute_join_game_room`) requires player_b to join with that
    // exact same amount.
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(5_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(5_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join with a matching ante");

    // Immediately after creation, no time has elapsed at all --
    // ClaimTimeoutRefund must be rejected.
    let too_early_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::ClaimTimeoutRefund { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(too_early_err, ContractError::TimeoutNotYetElapsed { .. }),
        "expected TimeoutNotYetElapsed, got: {too_early_err:?}"
    );

    // player_a passes their turn -- one of the six qualifying
    // state-advancing actions -- which refreshes last_action_timestamp to
    // the current mock block time.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .expect("player_a should be able to pass their turn");

    let session_after_pass = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(
        session_after_pass.last_action_timestamp,
        env.block.time.seconds(),
        "PassTurn should refresh last_action_timestamp to the current block time"
    );

    // Advance the mock block time by exactly 48 hours plus one second --
    // just past the inactivity threshold, timed from the PassTurn above,
    // not room creation.
    env.block.time = env.block.time.plus_seconds(172_800 + 1);

    // player_b -- who never acted -- triggers the claim, proving the
    // safety valve isn't restricted to the room's creator or whoever
    // caused the last recorded action.
    let refund_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::ClaimTimeoutRefund { game_id },
    )
    .expect("ClaimTimeoutRefund should succeed once 48 hours have elapsed with no action");

    assert_eq!(attr(&refund_res, "total_refunded"), "10000");
    assert_eq!(
        refund_res.messages.len(),
        2,
        "expected exactly one BankMsg::Send per player"
    );

    match &refund_res.messages[0].msg {
        CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
            assert_eq!(to_address, player_a.as_str());
            assert_eq!(amount.len(), 1);
            assert_eq!(amount[0].denom, NATIVE_DENOM);
            assert_eq!(amount[0].amount, Uint128::new(5_000));
        }
        other => panic!("expected a BankMsg::Send to player_a, got: {other:?}"),
    }
    match &refund_res.messages[1].msg {
        CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
            assert_eq!(to_address, player_b.as_str());
            assert_eq!(amount.len(), 1);
            assert_eq!(amount[0].denom, NATIVE_DENOM);
            assert_eq!(amount[0].amount, Uint128::new(5_000));
        }
        other => panic!("expected a BankMsg::Send to player_b, got: {other:?}"),
    }

    let session_after_refund = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert!(!session_after_refund.is_active);
    assert_eq!(session_after_refund.total_juno_pool, Uint128::zero());

    // Calling it again must fail cleanly -- the room is no longer active.
    let repeat_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::ClaimTimeoutRefund { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(repeat_err, ContractError::GameNotActive { .. }),
        "expected GameNotActive, got: {repeat_err:?}"
    );
}

/// Exercises the Uniform Ante Rule (`execute_join_game_room`): a joining
/// player must attach exactly the same real-JUNO amount the room's creator
/// deposited at `CreateGameRoom` time, down to the last `ujuno` -- neither
/// a smaller nor a larger amount is accepted, and omitting funds entirely
/// is rejected the same way. Confirms the rejected attempts never touch
/// `total_juno_pool`, `player_addresses`, or `PLAYER_CASH_VGP`, and that
/// the exact matching amount succeeds.
#[test]
fn join_game_room_rejects_any_ante_that_does_not_match_the_creators_deposit() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let creator = Addr::unchecked("creator");
    let low_bidder = Addr::unchecked("low_bidder");
    let high_bidder = Addr::unchecked("high_bidder");
    let no_funds_joiner = Addr::unchecked("no_funds_joiner");
    let exact_joiner = Addr::unchecked("exact_joiner");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(creator.as_str(), &coins(10_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 6,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    let pool_before = SESSIONS
        .load(&deps.storage, game_id)
        .unwrap()
        .total_juno_pool;
    assert_eq!(pool_before, Uint128::new(10_000));

    // One ujuno short of the creator's 10,000 ujuno ante -- must be
    // rejected, down to the exact micro-token.
    let low_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(low_bidder.as_str(), &coins(9_999, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(low_err, ContractError::InvalidAnteAmount { .. }),
        "expected InvalidAnteAmount, got: {low_err:?}"
    );

    // One ujuno over -- must be rejected too; the rule is an exact match,
    // not a minimum.
    let high_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(high_bidder.as_str(), &coins(10_001, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(high_err, ContractError::InvalidAnteAmount { .. }),
        "expected InvalidAnteAmount, got: {high_err:?}"
    );

    // No funds attached at all -- also rejected; a join deposit is no
    // longer optional under the Uniform Ante Rule.
    let no_funds_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(no_funds_joiner.as_str(), &[]),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(no_funds_err, ContractError::InvalidDeposit { .. }),
        "expected InvalidDeposit, got: {no_funds_err:?}"
    );

    // None of the three rejected attempts should have touched the room's
    // pool or player roster.
    let session_after_rejections = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session_after_rejections.total_juno_pool, pool_before);
    assert_eq!(session_after_rejections.player_addresses.len(), 1);
    assert!(PLAYER_CASH_VGP
        .may_load(&deps.storage, (game_id, low_bidder.clone()))
        .unwrap()
        .is_none());

    // Exactly 10,000 ujuno -- matching the creator's ante -- succeeds.
    let exact_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(exact_joiner.as_str(), &coins(10_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("a deposit matching the creator's exact ante should be accepted");
    assert_eq!(attr(&exact_res, "deposit_amount"), "10000");

    let session_after_join = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session_after_join.total_juno_pool, Uint128::new(20_000));
    assert_eq!(session_after_join.player_addresses.len(), 2);
}

/// Train Limits (`hardware.rs` module doc comment #10a) and the D-train
/// Rusting trigger (module doc comment #3), exercised together end-to-end:
/// 1. PRR buys real 2-trains up to its Phase-2/3 cap of 4 -- a 5th purchase
///    at that point is rejected with `TrainLimitExceeded`, even though the
///    pool still has 2-trains left in stock (the cap is per-corporation,
///    not a pool-exhaustion rule).
/// 2. The Hardware pool/purchase-count state is then seeded directly (the
///    same "seed storage to isolate one mechanism" pattern already used by
///    `lay_tile_enforces_era_color_locking_and_upgrade_topology_retention`
///    and `begin_operating_round_paces_multiple_operating_rounds_for_higher_train_tiers`)
///    to fast-forward past the remaining 2-trains and every 3-train,
///    without touching PRR's own `COMPANY_HARDWARE` -- so PRR still
///    genuinely, actually owns exactly its 4 real 2-trains. PRR is then
///    still rejected buying the room's first-ever 4-train, demonstrating
///    the explicit "reject the purchase completely, even if the new train
///    would immediately trigger a rust event" rule: this exact purchase
///    would have rusted away PRR's own 2-trains (bringing it back under a
///    lower cap), but it's blocked outright before that can happen.
/// 3. A second company, NYC (`company_id: 2`, floated fresh with zero
///    trains owned), then buys that same first-ever 4-train successfully
///    (0 owned trains is nowhere near any cap), and the Rusting sweep it
///    triggers is asserted both via the response attributes
///    (`record_purchase_and_apply_rusting`'s own additions) and directly
///    against storage: PRR's `COMPANY_HARDWARE` inventory is confirmed
///    completely emptied of its four 2-trains.
#[test]
fn hardware_buy_rusts_lower_tier_and_enforces_train_limit() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const PRR_ID: u32 = 1;
    const NYC_ID: u32 = 2;

    // Float PRR at par $100 via six consecutive IPO purchases (same recipe
    // as `lay_tile_enforces_era_color_locking_and_upgrade_topology_retention`)
    // -- player_one becomes President, PRR's treasury is credited $1,000
    // (10x par) on floating, and player_one has spent $600 of their $1,200
    // starting cash (2-player room: `STARTING_CAPITAL_POOL` $2,400 / 2).
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("PRR's first IPO purchase should set its par value and succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("PRR's subsequent IPO purchases should succeed and float it at 60%");
    }

    // Buying/selling Hardware has no home-tile or Operating Round
    // prerequisite in this contract (`execute_buy_hardware_from_pool` only
    // requires a registered President and, once one exists, an Operating
    // Round Corporation Turn Queue that hasn't been begun yet is simply not
    // enforced at all) -- so PRR can buy Hardware immediately after
    // floating, with no `LayTile`/`BeginOperatingRound` setup needed.

    // PRR buys four real 2-trains -- exactly its Phase-2/3 Train Limit
    // (`TRAIN_LIMIT_BY_PHASE`'s `("2", 4)` row). $80 each, $320 total,
    // treasury $1,000 -> $680.
    for _ in 0..4 {
        let res = execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyHardwareFromPool {
                game_id,
                protocol_id: PRR_ID,
            },
        )
        .expect("PRR should be able to buy 2-trains up to its 4-train Phase-2/3 cap");
        assert_eq!(attr(&res, "model_type"), "2");
    }

    let prr_hardware_at_cap = COMPANY_HARDWARE
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(prr_hardware_at_cap.len(), 4);

    // A 5th purchase is rejected outright -- PRR already owns 4, at its
    // cap -- even though the pool still has 2 more 2-trains in stock (the
    // cap is per-corporation, not a pool-exhaustion rule).
    let over_cap_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .unwrap_err();
    match over_cap_err {
        ContractError::Hardware(HardwareError::TrainLimitExceeded {
            protocol_id,
            owned,
            limit,
            ..
        }) => {
            assert_eq!(protocol_id, PRR_ID);
            assert_eq!(owned, 4);
            assert_eq!(limit, 4);
        }
        other => panic!("expected Hardware(TrainLimitExceeded), got: {other:?}"),
    }

    // Directly seed the Hardware pool/purchase-count state to skip past the
    // remaining 2 unsold 2-trains and every 3-train, landing the pool's
    // front on the room's first-ever 4-train -- the same direct-storage-
    // seeding pattern already established elsewhere in this file (see this
    // test's own doc comment). PRR's `COMPANY_HARDWARE` is deliberately
    // left completely untouched here: PRR still genuinely owns exactly the
    // 4 real 2-trains bought above.
    let mut seeded_pool = HARDWARE_POOL.load(&deps.storage, game_id).unwrap();
    let remaining_pool = seeded_pool.split_off(2 + 5); // 2 leftover "2"s + all 5 "3"s
    HARDWARE_POOL
        .save(deps.as_mut().storage, game_id, &remaining_pool)
        .unwrap();
    TRAINS_PURCHASED_COUNT
        .save(deps.as_mut().storage, (game_id, "2".to_string()), &6)
        .unwrap();
    TRAINS_PURCHASED_COUNT
        .save(deps.as_mut().storage, (game_id, "3".to_string()), &5)
        .unwrap();

    // PRR is still blocked from buying this first-ever 4-train: it's still
    // sitting at 4 owned trains, at or above the (still 4, per
    // `TRAIN_LIMIT_BY_PHASE`'s `("3", 4)` row) cap for the current highest-
    // purchased phase ("3"). This is the explicit "reject even if the
    // purchase would immediately trigger a rust event" case: this exact
    // purchase would be the first-ever 4-train, which would rust away every
    // one of PRR's own 2-trains -- but the cap check runs first and blocks
    // it outright, before any rusting can happen.
    let blocked_would_rust_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .unwrap_err();
    match blocked_would_rust_err {
        ContractError::Hardware(HardwareError::TrainLimitExceeded {
            protocol_id,
            owned,
            limit,
            phase,
        }) => {
            assert_eq!(protocol_id, PRR_ID);
            assert_eq!(owned, 4);
            assert_eq!(limit, 4);
            assert_eq!(phase, "3");
        }
        other => panic!("expected Hardware(TrainLimitExceeded), got: {other:?}"),
    }

    // PRR's inventory must be completely untouched by the rejected
    // purchase -- still exactly its 4 real 2-trains, no rusting applied.
    let prr_hardware_after_block = COMPANY_HARDWARE
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(prr_hardware_after_block.len(), 4);
    assert!(prr_hardware_after_block
        .iter()
        .all(|asset| asset.model_type == "2"));
    assert_eq!(
        TRAINS_PURCHASED_COUNT
            .may_load(&deps.storage, (game_id, "4".to_string()))
            .unwrap()
            .unwrap_or(0),
        0,
        "the blocked purchase must not have recorded a 4-train as ever purchased"
    );

    // Float a second company, NYC, at par $71 -- zero trains owned, nowhere
    // near any cap. player_one becomes NYC's President too (this contract
    // doesn't restrict one player to a single presidency -- see
    // `lay_tile_enforces_era_color_locking_and_upgrade_topology_retention`'s
    // own B&O + PRR precedent). Total player_one spend: $600 (PRR) + $426
    // (NYC, 6 x $71) = $1,026 of their $1,200 starting cash.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: NYC_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(71)),
        },
    )
    .expect("NYC's first IPO purchase should set its par value and succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(player_one.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: NYC_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("NYC's subsequent IPO purchases should succeed and float it at 60%");
    }

    // NYC buys the room's first-ever 4-train -- allowed (0 owned trains is
    // nowhere near the 4-train cap) -- and this single purchase must fire
    // the 4-train Rusting trigger (`RUST_TRIGGERS`'s `("4", "2")` pair),
    // globally purging every 2-train from every company's inventory --
    // here, exactly PRR's four.
    let four_train_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: NYC_ID,
        },
    )
    .expect("NYC should be able to buy the room's first 4-train -- it owns zero trains");
    assert_eq!(attr(&four_train_res, "model_type"), "4");
    assert_eq!(attr(&four_train_res, "rusting_triggered"), "true");
    assert_eq!(attr(&four_train_res, "rusted_model"), "2");
    assert_eq!(attr(&four_train_res, "rusted_units_removed"), "4");
    assert_eq!(attr(&four_train_res, "rusted_companies_affected"), "1");

    // PRR's Hardware inventory must now be completely empty -- every one of
    // its four 2-trains was rusted away by NYC's 4-train purchase.
    let prr_hardware_after_rust = COMPANY_HARDWARE
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert!(
        prr_hardware_after_rust.is_empty(),
        "expected PRR's 2-trains to be fully rusted away, got: {prr_hardware_after_rust:?}"
    );

    // NYC itself owns exactly the one 4-train it just bought -- Rusting
    // only ever removes the *rusted* tier (2-trains here), never the
    // triggering purchase itself.
    let nyc_hardware = COMPANY_HARDWARE
        .load(&deps.storage, (game_id, NYC_ID))
        .unwrap();
    assert_eq!(nyc_hardware.len(), 1);
    assert_eq!(nyc_hardware[0].model_type, "4");
}

/// Exercises `ExecuteMsg::RunManualRoute` (Manual Route Validation) end to
/// end: a valid, hand-picked hex-label chain must be validated, priced, and
/// distributed exactly like an automatic route, and every documented
/// rejection reason -- a path that never touches the operating company's
/// own station, and a path whose hexes aren't actually track-connected --
/// must be rejected before any state changes.
///
/// Board geometry used here (see `hexmap::BOARD_HEX_LABELS`): "D8" = axial
/// `(2, 3)`, "E7" = axial `(1, 4)` (`HEX_NEIGHBOR_OFFSETS[4]` = `(-1, 1)`
/// from D8), "E9" = axial `(2, 4)` (`HEX_NEIGHBOR_OFFSETS[0]` = `(1, 0)`
/// from E7, and also `HEX_NEIGHBOR_OFFSETS[5]` = `(0, 1)` from D8 -- E9 is
/// geometrically adjacent to both, but D8 never lays live track on that
/// edge, so a `["D8", "E9"]` path is still a genuine connectivity failure,
/// not just a missing-tile one). E9 is one of `hexmap::GRAY_PREPRINTED_HEXES`'
/// three bare-connector hexes (module doc comment #20) -- it always
/// resolves a real, routable (synthetic) tile via
/// `pathfinding::effective_tile_and_value`, without B&O ever laying track
/// there itself, which is exactly what the rejection sub-tests below need:
/// a hex that legitimately "has a tile" for `RunManualRoute`'s own
/// `NoTileAtHex` check but that B&O's own network never legally reaches.
///
/// CORRECTION (Rigid On-Chain Tile Matching pass): this originally used
/// "D10" (axial `(3, 3)`) as the Small Town hex and "C11" (axial `(4, 2)`)
/// as the further Plain extension. D10 is real-board Hamilton & Toronto, a
/// preprinted OO CITY hex (`hexmap::CITY_DESIGNATED_HEXES`) -- laying a
/// SmallTown tile there is now correctly rejected by the City Reservation
/// gate (module doc comment #16) this pass added. "E7" (the preprinted
/// Single-Town hex London, `hexmap::TOWN_DESIGNATED_HEXES`) was used
/// instead, extended (at the time) toward "F8", an ordinary undesignated
/// hex.
///
/// CORRECTION 2 (Impassable Border Edges pass): a later pass added E7<->F8
/// (E7's edge 5) to `hexmap::IMPASSABLE_HEX_EDGES` (module doc comment #22
/// in `hexmap.rs`) as a permanently-blocked border, and E7's only other
/// non-home edge (edge 3) faces Detroit & Windsor, an OO hex requiring a
/// Green-tier `DoubleCityHub` tile this Yellow-era test can never lay --
/// leaving NO hex B&O could legally extend real track to past E7 at all.
/// This pass retargets both rejection sub-tests below from "F8" to "E9"
/// for that reason (see the E7 tile placement's own comment for the
/// accompanying orientation change, `4` -> `0`), and no third tile is laid
/// at all anymore.
#[test]
fn run_manual_route_validates_and_scores_custom_player_path() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;

    // Float B&O for free by winning its private -- player_one becomes its
    // President with a 20% share (`auction::BO_PRESIDENT_SHARE_PERCENTAGE`).
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    // A 2-train (max_route_distance: 2) -- exactly enough for the two-hex
    // routes this test submits, and small enough that neither invalid path
    // below could be rejected merely for exceeding it (both are length 2 as
    // well), isolating each rejection to the specific rule it's testing.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: BO_PUBLIC_ID,
        },
    )
    .expect("B&O's President should be able to buy the next Hardware unit");

    // Home tile: D8 (2, 3), plain straight track (tile_id 1, edges 0 & 3,
    // $0 value) -- the company's only modeled "station" (module doc comment
    // #1 in `pathfinding.rs`), always accepted unconditionally as the first
    // tile laid.
    //
    // ORIENTATION FIX (Rigid On-Chain Tile Matching pass): hardcoded to `1`
    // (edges {1, 4}) instead of `lowest_legal_orientation`'s unconstrained
    // `0` (edges {0, 3}) -- edge 4 is the one that faces E7 `(1, 4)`, this
    // pass's replacement second hex (see below).
    let home_orientation: u32 = 1;
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 2,
            r: 3,
            tile_id: 9,
            orientation: home_orientation,
        },
    )
    .expect("B&O's home tile should be free to lay");

    // Extend to E7 (1, 4): Small Town curve (tile_id 3, base edges 1 & 3,
    // $10 value) -- a genuine revenue center, connecting straight back to
    // the home tile.
    //
    // CORRECTION (Rigid On-Chain Tile Matching pass): this used to target
    // D10 `(3, 3)` -- real-board Hamilton & Toronto, a preprinted OO city
    // hex (`hexmap::CITY_DESIGNATED_HEXES`), which now correctly rejects a
    // SmallTown tile under the City Reservation gate (module doc comment
    // #16). E7 (real label "E7", the preprinted Single-Town hex London,
    // `hexmap::TOWN_DESIGNATED_HEXES`) is used instead.
    //
    // ORIENTATION FIX 2 (Impassable Border Edges pass): a LATER pass added
    // E7<->F8 (E7's edge 5) to `hexmap::IMPASSABLE_HEX_EDGES` (module doc
    // comment #22 in `hexmap.rs`), so any rotation putting live track on
    // edge 5 is permanently rejected here.
    //
    // CATALOG MIGRATION (Audit G-5): the old internal tile 3 had base edges
    // {1, 3}, and the rotation this test wanted -- edge 1 live, pointing
    // back at the D8 home tile, and edge 5 clear -- was orientation `0`.
    // The real 1830 replacement, tray #58, is the same GENTLE-CURVE shape
    // but based at {0, 2}, so that identical edge pair {1, 3} is now
    // orientation `1`. Edge 5 stays clear, and the edge 3 stub still just
    // points live track at Detroit & Windsor without any tile ever needing
    // to be laid there -- a dangling live edge toward an unbuilt hex is
    // completely ordinary. The further-extension hex the two rejection
    // sub-tests below need is "E9" -- see this test's own doc comment for
    // why E9 needs no B&O tile lay of its own at all.
    let e7_orientation: u32 = 1;
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 1,
            r: 4,
            tile_id: 58,
            orientation: e7_orientation,
        },
    )
    .expect("E7 should legally connect back to the D8 home tile");

    // No third tile is laid at all anymore -- see this test's own doc
    // comment ("CORRECTION 2") for why B&O's network can no longer legally
    // reach any further hex past E7 once Impassable Border Edges landed.
    // The two rejection sub-tests below use "E9" (2, 4) purely as a hex
    // that resolves a real tile via `pathfinding::effective_tile_and_value`
    // -- one of `hexmap::GRAY_PREPRINTED_HEXES`' bare-connector hexes --
    // without B&O ever laying track there itself.

    // Before `BeginOperatingRound` has ever populated the queue,
    // `RunManualRoute` REQUIRES an active queue (unlike `DeclareDividends`'s
    // softer check -- see `execute_run_manual_route`'s own doc comment for
    // why) and must reject outright rather than silently advancing a
    // macro round that was never really running.
    let no_queue_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::RunManualRoute {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            hex_path: vec!["D8".to_string(), "E7".to_string()],
            payout_strategy: PayoutStrategy::DeclareDividends,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            no_queue_err,
            ContractError::Operations(OperationsError::NoActiveOperatingOrder { .. })
        ),
        "expected Operations(NoActiveOperatingOrder), got: {no_queue_err:?}"
    );

    // No Hardware has been bought by anyone else in the room, so the
    // default 1-OR pacing applies (matches every other Begin/End Operating
    // Round test in this file).
    let begin_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .expect("begin_operating_round should succeed with B&O floated");
    assert_eq!(attr(&begin_res, "active_operating_order"), "4");
    assert_eq!(attr(&begin_res, "active_corporation_id"), "4");

    // ---- Rejection #1: a path that never touches B&O's own station. ----
    // Neither E7 nor E9 is B&O's home (D8) -- this must be rejected
    // regardless of whether the two hexes are themselves track-connected,
    // since `RouteMustTouchOwnStation` fires at step 2 of
    // `execute_run_manual_route`, before any tile-presence or connectivity
    // check (steps 5+) ever runs.
    let no_station_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::RunManualRoute {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            hex_path: vec!["E7".to_string(), "E9".to_string()],
            payout_strategy: PayoutStrategy::DeclareDividends,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            no_station_err,
            ContractError::Operations(OperationsError::RouteMustTouchOwnStation { .. })
        ),
        "expected Operations(RouteMustTouchOwnStation), got: {no_station_err:?}"
    );

    // ---- Rejection #2: a disconnected path. ----
    // D8 and E9 both resolve a real tile (D8's own laid home tile; E9 via
    // the Gray-connector synthetic-tile fallback in
    // `pathfinding::effective_tile_and_value` -- see this test's own doc
    // comment), but D8 carries no live track on the edge facing E9 (its
    // home tile's only live edges are 1 and 4), so this must still be
    // rejected as disconnected, not silently accepted just because both
    // ends resolve to *some* tile.
    let disconnected_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::RunManualRoute {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            hex_path: vec!["D8".to_string(), "E9".to_string()],
            payout_strategy: PayoutStrategy::DeclareDividends,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            disconnected_err,
            ContractError::Operations(OperationsError::DisconnectedRouteSegment { .. })
        ),
        "expected Operations(DisconnectedRouteSegment), got: {disconnected_err:?}"
    );

    // Neither rejected attempt should have moved any VGP or advanced the
    // turn queue -- confirm the room is still exactly where
    // `BeginOperatingRound` left it before running the valid path below.
    let session_before = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session_before.active_operating_order, vec![BO_PUBLIC_ID]);
    assert_eq!(session_before.active_corporation_index, 0);
    assert_eq!(session_before.current_round_type, RoundType::OperatingRound);
    let bank_before = session_before.virtual_bank_vgp;
    let player_one_cash_before = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();

    // ---- The valid path: D8 -> E7 (home hex, then the $10 Small Town). ----
    let valid_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::RunManualRoute {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            hex_path: vec!["D8".to_string(), "E7".to_string()],
            payout_strategy: PayoutStrategy::DeclareDividends,
        },
    )
    .expect("a connected path starting at B&O's own home hex should validate and score");

    assert_eq!(attr(&valid_res, "hex_path"), "D8->E7");
    assert_eq!(attr(&valid_res, "revenue_amount"), "10");
    // player_one holds B&O's 20% President's share: 10 * 20% = 2 VGP to
    // them; the remaining 8 VGP (B&O's other 80%, still unissued/IPO-held,
    // has no player owner) falls to the game bank, same Distribute Yield
    // pattern `execute_operating_round`'s `payout: true` branch uses.
    assert_eq!(attr(&valid_res, "route_distributed_to_players"), "2");
    assert_eq!(attr(&valid_res, "route_bank_share"), "8");
    assert_eq!(attr(&valid_res, "route_revenue_recipient"), player_one.as_str());
    assert_eq!(attr(&valid_res, "route_revenue_payout"), "2");

    // B&O was the queue's only entry, and its pacing (1 OR) was already
    // exhausted -- Macro Round Loop Advancement should have fired exactly
    // like `EndOperatingRoundTurn`'s own equivalent test expects.
    assert_eq!(attr(&valid_res, "outcome"), "macro_round_advanced");

    let player_one_cash_after = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();
    assert_eq!(
        player_one_cash_after,
        player_one_cash_before + Uint128::new(2)
    );

    let session_after = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session_after.virtual_bank_vgp, bank_before + Uint128::new(8));
    assert_eq!(session_after.current_round_type, RoundType::StockRound);
    assert!(session_after.active_operating_order.is_empty());
    assert_eq!(session_after.active_corporation_index, 0);
}

/// Exercises `ExecuteMsg::RunManualRoute` with
/// `payout_strategy: PayoutStrategy::Withhold` (Item 3/4's Manual Route
/// Payout Strategy): the declared route revenue must go 100% into the
/// operating company's own `PublicCompany::treasury` -- NOT to any
/// shareholder, and NOT to the game bank either -- and its market marker
/// must move left (`market::move_left`), exactly mirroring
/// `execute_operating_round`'s own `payout: false` branch. Same board setup
/// as `run_manual_route_validates_and_scores_custom_player_path` immediately
/// above (see that test's own doc comment for the D8/E7 board geometry --
/// this test only uses the two-hex D8/E7 segment, not the sibling test's
/// "E9" rejection-only hex).
#[test]
fn run_manual_route_withhold_credits_company_treasury() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;

    // Float B&O for free by winning its private -- same mechanism as the
    // DeclareDividends-strategy test above.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: BO_PUBLIC_ID,
        },
    )
    .expect("B&O's President should be able to buy the next Hardware unit");

    // Home tile: D8 (2, 3) -- see the sibling test above for the exact
    // board geometry this reuses.
    //
    // ORIENTATION FIX (Rigid On-Chain Tile Matching pass): hardcoded to `1`
    // -- see the sibling test above's identical fix for the full
    // explanation (edge 4 must be live to face E7 below).
    let home_orientation: u32 = 1;
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 2,
            r: 3,
            tile_id: 9,
            orientation: home_orientation,
        },
    )
    .expect("B&O's home tile should be free to lay");

    // E7 (1, 4): the $10 Small Town revenue center.
    //
    // CORRECTION (Rigid On-Chain Tile Matching pass): this used to target
    // D10 `(3, 3)` -- real-board Hamilton & Toronto, a preprinted OO city
    // hex (`hexmap::CITY_DESIGNATED_HEXES`), now correctly rejected for a
    // SmallTown tile by the City Reservation gate (module doc comment #16).
    // E7 (the preprinted Single-Town hex London,
    // `hexmap::TOWN_DESIGNATED_HEXES`) is used instead; unlike the sibling
    // test above, this one lays no third tile, so `lowest_legal_orientation`
    // still resolves this correctly on its own (orientation 0, edges {1, 3},
    // connects back to D8 via edge 1).
    let e7_orientation =
        lowest_legal_orientation(&deps.storage, game_id, BO_PUBLIC_ID, 1, 4, 58);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: 1,
            r: 4,
            tile_id: 58,
            orientation: e7_orientation,
        },
    )
    .expect("E7 should legally connect back to the D8 home tile");

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .expect("begin_operating_round should succeed with B&O floated");

    // Snapshot every ledger this call must (and must not) touch, before
    // running the withheld route.
    let bo_before: crate::state::PublicCompany = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, BO_PUBLIC_ID))
        .unwrap();
    let player_one_cash_before = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();
    let bank_before = SESSIONS.load(&deps.storage, game_id).unwrap().virtual_bank_vgp;

    let withhold_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::RunManualRoute {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            hex_path: vec!["D8".to_string(), "E7".to_string()],
            payout_strategy: PayoutStrategy::Withhold,
        },
    )
    .expect("a connected path starting at B&O's own home hex should validate and score");

    assert_eq!(attr(&withhold_res, "revenue_amount"), "10");
    assert_eq!(attr(&withhold_res, "payout_strategy"), "withhold");
    assert_eq!(attr(&withhold_res, "route_withheld_to_treasury"), "10");
    assert_eq!(
        attr(&withhold_res, "route_treasury_total"),
        (bo_before.treasury + Uint128::new(10)).to_string()
    );
    // Withhold never advances the queue's own DeclareDividends-only
    // attributes -- confirm none of those leaked onto this response.
    assert!(!withhold_res
        .attributes
        .iter()
        .any(|a| a.key == "route_revenue_recipient" || a.key == "route_distributed_to_players"));

    // Corporate cash ledger balance (`PublicCompany::treasury`) increased
    // by exactly the declared revenue -- this feature's own core ask.
    let bo_after: crate::state::PublicCompany = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, BO_PUBLIC_ID))
        .unwrap();
    assert_eq!(bo_after.treasury, bo_before.treasury + Uint128::new(10));

    // Its stock token's matrix position actually moved (left), matching
    // `market::move_left` -- not just the treasury number changing in
    // isolation.
    assert_ne!(
        (bo_after.current_x, bo_after.current_y),
        (bo_before.current_x, bo_before.current_y)
    );

    // No player was paid, and the game bank was not credited either --
    // 100% of the revenue went to the company treasury alone.
    let player_one_cash_after = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_one.clone()))
        .unwrap();
    assert_eq!(player_one_cash_after, player_one_cash_before);
    let session_after = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session_after.virtual_bank_vgp, bank_before);

    // The turn queue still advances exactly like the DeclareDividends
    // strategy does -- payout strategy only changes where the revenue
    // goes, never the turn-advancement behavior.
    assert_eq!(attr(&withhold_res, "outcome"), "macro_round_advanced");
    assert_eq!(session_after.current_round_type, RoundType::StockRound);
    assert!(session_after.active_operating_order.is_empty());
}

/// Exercises `QueryMsg::PlayerNetWorth` (`query::query_player_net_worth`)
/// end to end: cash-only before any shares are held, cash-plus-stock once a
/// company is floated, and -- the crux of this test -- a re-query that
/// picks up a *new* live market price after the marker moves, without any
/// other action re-pricing the player's existing certificates. This is the
/// authentic 1830 net-worth formula the query variant's own doc comment
/// promises: cash treasury plus every held certificate priced at its
/// corporation's *current* `MARKET_GRID` cell, never a stale or par value.
#[test]
fn query_player_net_worth_accurately_sums_cash_and_live_stock_portfolio() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    // A 2-player room gives its creator $1200 VGP starting capital, exactly
    // like `public_company_floats_at_sixty_percent_player_ownership` --
    // reused here so the cash-side numbers below are easy to verify by hand.
    let buyer = Addr::unchecked("buyer");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    // Audit G-6: this scenario's subject is share-selling mechanics, not
    // first-round legality -- fast-forward past the Stock Round 1 sale ban.
    advance_past_first_stock_round(&mut deps.storage, game_id);

    const PRR_COMPANY_ID: u32 = 1;

    // Baseline: before the buyer holds a single share, net worth must equal
    // their liquid cash treasury exactly -- the portfolio loop should
    // contribute nothing for a player who owns no certificates anywhere.
    let baseline: PlayerNetWorthResponse =
        query::query_player_net_worth(deps.as_ref(), game_id, buyer.to_string())
            .expect("querying net worth before any purchase should succeed");
    assert_eq!(baseline.game_id, game_id);
    assert_eq!(baseline.player, buyer);
    assert_eq!(baseline.cash_vgp, Uint128::new(1_200));
    assert_eq!(baseline.stock_portfolio_value, Uint128::zero());
    assert_eq!(baseline.net_worth, Uint128::new(1_200));

    // Float PRR at the $100 par cell with six IPO certificates (60%),
    // exactly like `public_company_floats_at_sixty_percent_player_ownership`
    // -- leaves the buyer with $600 cash and 6 certificates still priced at
    // the $100 par cell (the IPO pool never emptied, so no sold-out bonus
    // has moved the marker yet).
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("buyer's first IPO purchase, with a valid par_value, should succeed");
    for _ in 0..5 {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(buyer.as_str(), &[]),
            ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR_COMPANY_ID,
                source: SharePurchaseSource::Ipo,
                par_value: None,
            },
        )
        .expect("buyer should be able to buy PRR certificates up through the float threshold");
    }

    let prr_after_float = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert!(prr_after_float.is_floated, "PRR should have floated at 60%");

    // Cross-check the query's own live-price lookup against the exact same
    // `market::current_cell` read the handler itself uses, rather than
    // hardcoding "$100" -- keeps this assertion honest to the formula, not
    // just to today's par-value numbers.
    let par_cell = market::current_cell(&deps.storage, game_id, PRR_COMPANY_ID)
        .expect("PRR must have a seeded market position after floating");
    assert_eq!(par_cell.price, Uint128::new(100));

    // A second player joins only now -- AFTER PRR has already floated --
    // rather than at room creation: `BuyStock` advances the turn pointer to
    // the next REGISTERED player on every successful call, so if player_b
    // had joined before the float loop above, the loop's 2nd purchase would
    // have needed to come from player_b, not the buyer again, and the
    // single-buyer 60%-in-a-row float this test relies on (mirroring
    // `public_company_floats_at_sixty_percent_player_ownership`) would have
    // failed with `NotYourTurn`. Joining here, once the room is back down
    // to a real, uncontested one-player turn cadence for the remainder of
    // this test, avoids that -- and joining itself never touches
    // `active_player_index`, so the buyer stays the active player
    // afterward regardless. Same $1,000,000 ujuno ante the Uniform Ante
    // Rule requires (see `execute_join_game_room`'s doc comment).
    let player_b = Addr::unchecked("player_b");
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    // Directly seed player_b with a 20% PRR stake -- exactly the same
    // storage-seeding shortcut `sell_stock_does_not_advance_turn_but_buy_stock_does`
    // uses -- so `execute_sell_stock`'s President Successor Transfer check
    // (module doc comment #11) has someone legally eligible to hold the
    // seat once the buyer, PRR's current President, sells a certificate
    // below. This is a bookkeeping shortcut for the successor check alone;
    // it deliberately does not touch `IPO_POOL_SHARES`/`BANK_POOL_SHARES`
    // or `total_shares_issued`, none of which this test asserts on.
    PLAYER_SHARES
        .save(
            deps.as_mut().storage,
            (game_id, PRR_COMPANY_ID, player_b.clone()),
            &20u8,
        )
        .unwrap();

    let after_float: PlayerNetWorthResponse =
        query::query_player_net_worth(deps.as_ref(), game_id, buyer.to_string())
            .expect("querying net worth after floating PRR should succeed");
    assert_eq!(after_float.cash_vgp, Uint128::new(600));
    assert_eq!(
        after_float.stock_portfolio_value,
        Uint128::new(6) * par_cell.price
    );
    assert_eq!(after_float.net_worth, Uint128::new(1_200));

    // Now move PRR's market marker: sell one certificate (10%) back onto
    // the open market. `execute_sell_stock` pays the seller the *current*
    // cell's price before dropping the marker one row per certificate sold
    // (`market::move_down`), so this both credits cash and leaves a strictly
    // lower live price behind for every certificate the buyer still holds.
    let sell_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(buyer.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .expect("selling one certificate back onto the open market should succeed");
    let sale_proceeds = Uint128::new(attr(&sell_res, "total_proceeds").parse().unwrap());
    assert_eq!(sale_proceeds, par_cell.price);

    let moved_cell = market::current_cell(&deps.storage, game_id, PRR_COMPANY_ID)
        .expect("PRR must still have a live market position after the sale");
    assert!(
        moved_cell.price < par_cell.price,
        "dumping a certificate onto the open market must move the price down, not leave it \
         at the old par cell"
    );

    // The crux of this test: re-querying net worth with the SAME 5
    // remaining certificates must now price them at the NEW, lower
    // `moved_cell` price -- not the stale `par_cell` price this player
    // originally paid, and not a value frozen at the moment the shares
    // were first bought. That's what makes this a *live* portfolio
    // valuation rather than a cost-basis snapshot.
    let after_sale: PlayerNetWorthResponse =
        query::query_player_net_worth(deps.as_ref(), game_id, buyer.to_string())
            .expect("querying net worth after the price moves should succeed");
    assert_eq!(after_sale.cash_vgp, Uint128::new(600) + sale_proceeds);
    assert_eq!(
        after_sale.stock_portfolio_value,
        Uint128::new(5) * moved_cell.price,
        "remaining certificates must be re-priced at the marker's new position"
    );
    assert_ne!(
        after_sale.stock_portfolio_value, after_float.stock_portfolio_value,
        "the portfolio figure must actually change when the live price changes"
    );
    assert_eq!(
        after_sale.net_worth,
        after_sale.cash_vgp + after_sale.stock_portfolio_value
    );
}

/// Phase-Gated Corporate Purchase Protocol (`trading.rs` module doc comment
/// #17, `hexmap.rs` module doc comment #24's sibling feature): a
/// corporation's purchase of a player-owned private company is hard-blocked
/// before Phase 3 (the 3-train era, `TileColor::Green`), and once legal, the
/// price the railroad's treasury pays must land within 50%-200% of the
/// private's printed face value -- verified here against Schuylkill
/// Valley's $20 face value, so $10 is the exact floor and $40 is the exact
/// ceiling, with $9 and $41 each one dollar past a boundary. A final valid
/// in-bounds purchase at the exact floor confirms the treasury debit, the
/// selling player's cash credit, and the ownership transfer from `owner` to
/// `owner_protocol_id` all happen atomically. The private is seeded as
/// directly owned by `seller` via direct storage writes -- an established
/// pattern elsewhere in this file (e.g.
/// `calculate_operating_order_sorts_by_price_and_breaks_ties_by_arrival_recency`)
/// -- rather than played out through a real `BidOnPrivate` auction, so this
/// test can isolate the purchase protocol itself from the auction flow.
#[test]
fn corporate_private_purchase_enforces_phase_and_value_limits() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let seller = Addr::unchecked("seller");
    let president = Addr::unchecked("president");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(seller.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(president.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("president should be able to join");

    const PRIVATE_ID: u32 = 1; // Schuylkill Valley -- $20 face value.
    const PROTOCOL_ID: u32 = 1; // PRR.

    let mut private = PRIVATE_COMPANIES
        .load(&deps.storage, (game_id, PRIVATE_ID))
        .unwrap();
    assert_eq!(
        private.cost,
        Uint128::new(20),
        "test setup assumption: Schuylkill Valley's printed face value is $20"
    );
    private.owner = Some(seller.clone());
    PRIVATE_COMPANIES
        .save(deps.as_mut().storage, (game_id, PRIVATE_ID), &private)
        .unwrap();

    // `president` presides over PRR, and PRR's treasury is funded well
    // above any price this test attempts.
    PROTOCOL_PRESIDENT
        .save(deps.as_mut().storage, (game_id, PROTOCOL_ID), &president)
        .unwrap();
    let mut company = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PROTOCOL_ID))
        .unwrap();
    company.treasury = Uint128::new(1_000);
    company.is_floated = true;
    PUBLIC_COMPANIES
        .save(deps.as_mut().storage, (game_id, PROTOCOL_ID), &company)
        .unwrap();

    // Phase 2 (genesis era): hard-blocked even at an otherwise in-bounds
    // price.
    let phase2_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(president.as_str(), &[]),
        ExecuteMsg::BuyPrivateCompany {
            game_id,
            protocol_id: PROTOCOL_ID,
            private_id: PRIVATE_ID,
            price: Uint128::new(20),
        },
    )
    .unwrap_err();
    match &phase2_err {
        ContractError::Trading(TradingError::PrivatePurchaseLockedBeforePhase3 { .. }) => {}
        other => panic!(
            "expected Trading(PrivatePurchaseLockedBeforePhase3), got: {other:?}"
        ),
    }

    // Unlock Phase 3 (Green) directly -- the same established shortcut used
    // elsewhere (e.g. `lay_tile_enforces_oo_double_city_reservation`) to
    // isolate this test from the era-unlock mechanism itself.
    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    // Below the 50% floor ($20 face value -> floor is $10): $9 must fail.
    let too_low_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(president.as_str(), &[]),
        ExecuteMsg::BuyPrivateCompany {
            game_id,
            protocol_id: PROTOCOL_ID,
            private_id: PRIVATE_ID,
            price: Uint128::new(9),
        },
    )
    .unwrap_err();
    match &too_low_err {
        ContractError::Trading(TradingError::PrivatePurchasePriceOutOfBounds { .. }) => {}
        other => panic!(
            "expected Trading(PrivatePurchasePriceOutOfBounds), got: {other:?}"
        ),
    }

    // Above the 200% ceiling ($20 face value -> ceiling is $40): $41 must
    // fail.
    let too_high_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(president.as_str(), &[]),
        ExecuteMsg::BuyPrivateCompany {
            game_id,
            protocol_id: PROTOCOL_ID,
            private_id: PRIVATE_ID,
            price: Uint128::new(41),
        },
    )
    .unwrap_err();
    match &too_high_err {
        ContractError::Trading(TradingError::PrivatePurchasePriceOutOfBounds { .. }) => {}
        other => panic!(
            "expected Trading(PrivatePurchasePriceOutOfBounds), got: {other:?}"
        ),
    }

    let seller_cash_before = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, seller.clone()))
        .unwrap();

    // A valid Phase-3 purchase at the exact floor ($10) succeeds.
    let ok_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(president.as_str(), &[]),
        ExecuteMsg::BuyPrivateCompany {
            game_id,
            protocol_id: PROTOCOL_ID,
            private_id: PRIVATE_ID,
            price: Uint128::new(10),
        },
    )
    .expect("a Phase-3 purchase at exactly 50% of face value should succeed");
    assert_eq!(attr(&ok_res, "price"), "10");

    let seller_cash_after = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, seller.clone()))
        .unwrap();
    assert_eq!(
        seller_cash_after,
        seller_cash_before.checked_add(Uint128::new(10)).unwrap(),
        "the selling player's cash should be credited the exact purchase price"
    );

    let company_after = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PROTOCOL_ID))
        .unwrap();
    assert_eq!(
        company_after.treasury,
        Uint128::new(1_000).checked_sub(Uint128::new(10)).unwrap(),
        "the buying corporation's treasury should be debited the exact purchase price"
    );

    let private_after = PRIVATE_COMPANIES
        .load(&deps.storage, (game_id, PRIVATE_ID))
        .unwrap();
    assert_eq!(
        private_after.owner, None,
        "player ownership must be cleared once a corporation buys the private"
    );
    assert_eq!(
        private_after.owner_protocol_id,
        Some(PROTOCOL_ID),
        "ownership must transfer to the buying corporation via owner_protocol_id"
    );
}

// ============================================================================
// Pre-Game Waterfall Auction Engine (`waterfall.rs`) -- unlike every test
// above, these deliberately do NOT call `skip_waterfall_auction`: they exist
// specifically to exercise the Waterfall Auction itself, exactly as genesis
// now produces it (`RoundType::WaterfallAuction`,
// `GameSession::waterfall_auction_active = true`).
// ============================================================================

#[test]
fn waterfall_genesis_phase_and_query_state_ordering() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let p1 = Addr::unchecked("wf_p1");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();

    // Every room now starts in the Waterfall Auction, not directly in Stock
    // Round 1.
    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session.current_round_type, RoundType::WaterfallAuction);
    assert!(session.waterfall_auction_active);
    assert_eq!(session.consecutive_waterfall_passes, 0);
    assert_eq!(session.last_private_winner, None);

    let state = query::query_waterfall_state(deps.as_ref(), game_id).unwrap();
    assert!(state.waterfall_auction_active);
    assert_eq!(state.current_turn, p1);
    assert_eq!(state.mini_auction, None);
    assert_eq!(state.consecutive_waterfall_passes, 0);

    // All six core privates, in ascending face-value order, only the first
    // ($20 Schuylkill Valley) marked as the current lowest offer.
    let expected_face_values = [20u128, 40, 70, 110, 160, 220];
    assert_eq!(state.privates.len(), 6);
    for (i, private) in state.privates.iter().enumerate() {
        assert_eq!(private.private_id, (i as u32) + 1);
        assert_eq!(private.face_value, Uint128::new(expected_face_values[i]));
        assert_eq!(private.is_lowest_offered, i == 0);
        assert!(private.bids.is_empty());
    }
}

#[test]
fn waterfall_buy_lowest_success() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let p1 = Addr::unchecked("wf_p1");
    let p2 = Addr::unchecked("wf_p2");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .unwrap();
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p2.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .unwrap();

    // 2 players -> $1200 starting cash each.
    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallBuyLowest { game_id },
    )
    .expect("buying the lowest-offered private (Schuylkill Valley, $20) should succeed");
    assert_eq!(attr(&res, "private_id"), "1");
    assert_eq!(attr(&res, "price"), "20");

    let p1_cash = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, p1.clone()))
        .unwrap();
    assert_eq!(p1_cash, Uint128::new(1_180));

    let private_one = PRIVATE_COMPANIES.load(&deps.storage, (game_id, 1)).unwrap();
    assert_eq!(private_one.owner, Some(p1.clone()));

    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    // Private #2 has zero bids, so the cascade stops there and control
    // returns to players -- the waterfall stays active, and the turn
    // advances exactly once to player 2.
    assert!(session.waterfall_auction_active);
    assert_eq!(session.active_player_index, 1);
    assert_eq!(session.last_private_winner, Some(p1));
    assert_eq!(session.consecutive_waterfall_passes, 0);
}

#[test]
fn waterfall_cannot_bid_on_lowest_and_bid_too_low_rejected() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let p1 = Addr::unchecked("wf_p1");
    let p2 = Addr::unchecked("wf_p2");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .unwrap();
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p2.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .unwrap();

    // Private #1 is the current lowest -- it can never be bid on, only
    // bought outright.
    let lowest_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallBidHigher {
            game_id,
            private_id: 1,
            bid_amount: Uint128::new(25),
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            lowest_err,
            ContractError::Waterfall(WaterfallError::CannotBidOnLowest { private_id: 1 })
        ),
        "expected Waterfall(CannotBidOnLowest), got: {lowest_err:?}"
    );

    // Private #2's face value is $40 -- a $39 opening bid is too low.
    let too_low_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallBidHigher {
            game_id,
            private_id: 2,
            bid_amount: Uint128::new(39),
        },
    )
    .unwrap_err();
    match &too_low_err {
        ContractError::Waterfall(WaterfallError::BidTooLow { minimum, increment }) => {
            assert_eq!(*minimum, Uint128::new(40));
            assert_eq!(*increment, Uint128::new(5));
        }
        other => panic!("expected Waterfall(BidTooLow), got: {other:?}"),
    }

    // A valid $40 opening bid succeeds and advances the turn to player 2.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallBidHigher {
            game_id,
            private_id: 2,
            bid_amount: Uint128::new(40),
        },
    )
    .expect("a $40 opening bid on private #2 should succeed");

    // Now player 2 must beat $40 + the $5 minimum increment -- $43 is too
    // low.
    let raise_too_low_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p2.as_str(), &[]),
        ExecuteMsg::WaterfallBidHigher {
            game_id,
            private_id: 2,
            bid_amount: Uint128::new(43),
        },
    )
    .unwrap_err();
    match &raise_too_low_err {
        ContractError::Waterfall(WaterfallError::BidTooLow { minimum, increment }) => {
            assert_eq!(*minimum, Uint128::new(45));
            assert_eq!(*increment, Uint128::new(5));
        }
        other => panic!("expected Waterfall(BidTooLow), got: {other:?}"),
    }
}

#[test]
fn waterfall_pass_illegal_without_any_standing_bid() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let p1 = Addr::unchecked("wf_p1");
    let p2 = Addr::unchecked("wf_p2");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .unwrap();
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p2.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .unwrap();

    let pass_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallPass { game_id },
    )
    .unwrap_err();
    assert!(
        matches!(
            pass_err,
            ContractError::Waterfall(WaterfallError::PassNotAllowed { .. })
        ),
        "expected Waterfall(PassNotAllowed), got: {pass_err:?}"
    );
}

#[test]
fn waterfall_single_bid_cascade_auto_wins() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let p1 = Addr::unchecked("wf_p1");
    let p2 = Addr::unchecked("wf_p2");
    let p3 = Addr::unchecked("wf_p3");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 3,
        },
    )
    .unwrap();
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    for p in [&p2, &p3] {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(p.as_str(), &coins(1_000_000, NATIVE_DENOM)),
            ExecuteMsg::JoinGameRoom { game_id },
        )
        .unwrap();
    }
    // 3 players -> $800 starting cash each.

    // Turn 1 (player 1): bid $40 (face value) on private #2 -- NOT the
    // current lowest (#1), so this is a legal opening bid.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallBidHigher {
            game_id,
            private_id: 2,
            bid_amount: Uint128::new(40),
        },
    )
    .expect("player 1's $40 bid on private #2 should succeed");

    // Turn 2 (player 2): buy private #1 outright at face value ($20). This
    // triggers the Waterfall Cascade: private #2 is now the cheapest
    // unowned private, and it has exactly one standing bid (player 1's
    // $40), so it auto-resolves to player 1 without any further action.
    // Private #3 is then inspected (0 bids) and the cascade stops there.
    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p2.as_str(), &[]),
        ExecuteMsg::WaterfallBuyLowest { game_id },
    )
    .expect("player 2 buying private #1 should succeed and cascade into private #2");
    assert_eq!(attr(&res, "private_2_winner"), p1.to_string());
    assert_eq!(attr(&res, "private_2_price"), "40");

    let private_one = PRIVATE_COMPANIES.load(&deps.storage, (game_id, 1)).unwrap();
    assert_eq!(private_one.owner, Some(p2.clone()));
    let private_two = PRIVATE_COMPANIES.load(&deps.storage, (game_id, 2)).unwrap();
    assert_eq!(private_two.owner, Some(p1.clone()));

    // Player 1 already escrowed the full $40 at bid time -- the auto-win
    // deducts nothing further.
    let p1_cash = PLAYER_CASH_VGP.load(&deps.storage, (game_id, p1.clone())).unwrap();
    assert_eq!(p1_cash, Uint128::new(760)); // 800 - 40
    let p2_cash = PLAYER_CASH_VGP.load(&deps.storage, (game_id, p2.clone())).unwrap();
    assert_eq!(p2_cash, Uint128::new(780)); // 800 - 20

    // Player 1's now-resolved bid entry is cleared.
    assert!(
        PRIVATE_BIDS
            .may_load(&deps.storage, (game_id, 2, p1.clone()))
            .unwrap()
            .is_none()
    );

    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert!(session.waterfall_auction_active);
    // The cascade's auto-win is the most recent private "purchased or won",
    // so `last_private_winner` is player 1 (who won #2 via the cascade),
    // even though the turn action itself was player 2 buying #1.
    assert_eq!(session.last_private_winner, Some(p1));
    // Exactly one turn advance for the whole cascade, regardless of how
    // many privates it resolved: player 2 (index 1) -> player 3 (index 2).
    assert_eq!(session.active_player_index, 2);
}

#[test]
fn waterfall_multi_bid_mini_auction_resolves_and_refunds_losers() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let p1 = Addr::unchecked("wf_p1");
    let p2 = Addr::unchecked("wf_p2");
    let p3 = Addr::unchecked("wf_p3");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 3,
        },
    )
    .unwrap();
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    for p in [&p2, &p3] {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(p.as_str(), &coins(1_000_000, NATIVE_DENOM)),
            ExecuteMsg::JoinGameRoom { game_id },
        )
        .unwrap();
    }
    // 3 players -> $800 starting cash each.

    // Turn 1 (player 1): buy private #1 ($20). Cascade checks #2 (0 bids)
    // and stops.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallBuyLowest { game_id },
    )
    .unwrap();

    // Turn 2 (player 2): bid $70 (face value) on private #3.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p2.as_str(), &[]),
        ExecuteMsg::WaterfallBidHigher {
            game_id,
            private_id: 3,
            bid_amount: Uint128::new(70),
        },
    )
    .unwrap();

    // Turn 3 (player 3): bid $75 on private #3 too.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p3.as_str(), &[]),
        ExecuteMsg::WaterfallBidHigher {
            game_id,
            private_id: 3,
            bid_amount: Uint128::new(75),
        },
    )
    .unwrap();

    // Turn 4 (player 1): buy private #2 ($40). Cascade inspects private #3
    // -- now the cheapest unowned private -- and finds 2 standing bids, so
    // it starts a mini-auction between player 2 and player 3 instead of
    // resolving it directly.
    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallBuyLowest { game_id },
    )
    .expect("player 1 buying private #2 should succeed and start a mini-auction on #3");
    assert_eq!(attr(&res, "waterfall_mini_auction_started"), "3");

    let mini = WATERFALL_MINI_AUCTION.load(&deps.storage, game_id).unwrap();
    assert_eq!(mini.private_id, 3);
    assert_eq!(mini.bidders, vec![p2.clone(), p3.clone()]);
    assert_eq!(mini.high_bid, Uint128::new(75));
    assert_eq!(mini.high_bidder, p3.clone());
    // The leader (player 3) is auto-skipped -- it's player 2's turn.
    let state = query::query_waterfall_state(deps.as_ref(), game_id).unwrap();
    let mini_status = state.mini_auction.expect("a mini-auction should be in progress");
    assert_eq!(mini_status.current_turn, p2);

    // Player 2 raises to $80 -- $10 more than their existing $70 escrow.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p2.as_str(), &[]),
        ExecuteMsg::WaterfallMiniAuctionRaise {
            game_id,
            bid_amount: Uint128::new(80),
        },
    )
    .expect("player 2's raise to $80 should succeed");
    let p2_cash_after_raise = PLAYER_CASH_VGP.load(&deps.storage, (game_id, p2.clone())).unwrap();
    assert_eq!(p2_cash_after_raise, Uint128::new(720)); // 800 - 70 - 10

    // Player 3 passes -- their $75 escrow is fully refunded, and since
    // player 2 is now the sole remaining bidder, they win private #3 at
    // their $80 high bid; the cascade then checks private #4 (0 bids) and
    // stops.
    let pass_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p3.as_str(), &[]),
        ExecuteMsg::WaterfallMiniAuctionPass { game_id },
    )
    .expect("player 3 passing should resolve the mini-auction to player 2");
    assert_eq!(attr(&pass_res, "private_3_winner"), p2.to_string());
    assert_eq!(attr(&pass_res, "private_3_price"), "80");

    let p3_cash_final = PLAYER_CASH_VGP.load(&deps.storage, (game_id, p3.clone())).unwrap();
    assert_eq!(p3_cash_final, Uint128::new(800), "player 3's $75 bid should be fully refunded");
    let p2_cash_final = PLAYER_CASH_VGP.load(&deps.storage, (game_id, p2.clone())).unwrap();
    assert_eq!(p2_cash_final, Uint128::new(720), "player 2's final $80 escrow becomes their purchase price");

    let private_three = PRIVATE_COMPANIES.load(&deps.storage, (game_id, 3)).unwrap();
    assert_eq!(private_three.owner, Some(p2.clone()));

    assert!(
        WATERFALL_MINI_AUCTION.may_load(&deps.storage, game_id).unwrap().is_none(),
        "the mini-auction state should be cleared once it resolves"
    );
    assert!(
        PRIVATE_BIDS.may_load(&deps.storage, (game_id, 3, p2.clone())).unwrap().is_none()
    );
    assert!(
        PRIVATE_BIDS.may_load(&deps.storage, (game_id, 3, p3.clone())).unwrap().is_none()
    );

    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session.last_private_winner, Some(p2));
    assert!(session.waterfall_auction_active);
}

#[test]
fn waterfall_full_pass_round_ends_early_and_refunds_standing_bids() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let p1 = Addr::unchecked("wf_p1");
    let p2 = Addr::unchecked("wf_p2");
    let p3 = Addr::unchecked("wf_p3");
    let p4 = Addr::unchecked("wf_p4");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 4,
        },
    )
    .unwrap();
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    for p in [&p2, &p3, &p4] {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(p.as_str(), &coins(1_000_000, NATIVE_DENOM)),
            ExecuteMsg::JoinGameRoom { game_id },
        )
        .unwrap();
    }
    // 4 players -> $600 starting cash each.

    // Player 1 bids $40 on private #2 (not the lowest), the only committing
    // action this whole test takes.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallBidHigher {
            game_id,
            private_id: 2,
            bid_amount: Uint128::new(40),
        },
    )
    .unwrap();

    // Players 2, 3, 4, then player 1 again all pass in turn -- a full round
    // of 4 consecutive passes (this room's player count) ends the whole
    // Waterfall Auction early, even though no private was ever bought or
    // won outright.
    for p in [&p2, &p3, &p4, &p1] {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(p.as_str(), &[]),
            ExecuteMsg::WaterfallPass { game_id },
        )
        .unwrap_or_else(|err| panic!("{p}'s pass should be legal: {err}"));
    }

    // Player 1's escrowed $40 bid on private #2 must be refunded -- it was
    // never resolved by the cascade, since the cascade never reached
    // private #2 (private #1, the actual lowest, was never bought).
    let p1_cash = PLAYER_CASH_VGP.load(&deps.storage, (game_id, p1.clone())).unwrap();
    assert_eq!(p1_cash, Uint128::new(600), "player 1's unresolved bid should be fully refunded");
    assert!(
        PRIVATE_BIDS.may_load(&deps.storage, (game_id, 2, p1.clone())).unwrap().is_none()
    );

    // No private was ever won, so every one of the six core privates
    // remains unowned.
    for private_id in 1u32..=6 {
        let private = PRIVATE_COMPANIES.load(&deps.storage, (game_id, private_id)).unwrap();
        assert_eq!(private.owner, None, "private #{private_id} should remain unowned");
    }

    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert!(!session.waterfall_auction_active);
    assert_eq!(session.current_round_type, RoundType::StockRound);
    assert_eq!(session.consecutive_waterfall_passes, 0);
    // `last_private_winner` was never set, so Priority Deal is left at its
    // untouched genesis default (the room creator, index 0) rather than
    // being derived relative to a nonexistent "last winner".
    assert_eq!(session.priority_deal_index, 0);
    assert_eq!(session.active_player_index, 0);

    // The Waterfall Auction is over; its own messages now correctly reject.
    let post_conclude_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallBuyLowest { game_id },
    )
    .unwrap_err();
    assert!(matches!(
        post_conclude_err,
        ContractError::Waterfall(WaterfallError::WaterfallNotActive { .. })
    ));

    // The legacy continuous-bid auction (`BidOnPrivate`) is now the correct
    // fallback path for the still-unowned private #1: it's player 1's turn
    // (`active_player_index == 0`), and it succeeds now that the Waterfall
    // Auction is no longer active.
    let legacy_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 1,
            bid_amount: Uint128::new(20),
        },
    )
    .expect("BidOnPrivate should work again as a fallback once the Waterfall Auction concludes");
    assert_eq!(attr(&legacy_res, "private_id"), "1");
}

#[test]
fn waterfall_full_playthrough_floats_bo_and_assigns_priority_deal() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let p1 = Addr::unchecked("wf_p1");
    let p2 = Addr::unchecked("wf_p2");
    let p3 = Addr::unchecked("wf_p3");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 3,
        },
    )
    .unwrap();
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    for p in [&p2, &p3] {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(p.as_str(), &coins(1_000_000, NATIVE_DENOM)),
            ExecuteMsg::JoinGameRoom { game_id },
        )
        .unwrap();
    }
    // 3 players, seating order [p1, p2, p3], $800 starting cash each. Every
    // player just buys the current lowest private in turn -- 6 privates, 3
    // players, so each player buys exactly twice, and the 6th (last) buy is
    // player 3's, on the Baltimore & Ohio.
    let buyers = [&p1, &p2, &p3, &p1, &p2, &p3];
    for buyer in buyers {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(buyer.as_str(), &[]),
            ExecuteMsg::WaterfallBuyLowest { game_id },
        )
        .unwrap_or_else(|err| panic!("{buyer}'s buy-lowest should succeed: {err}"));
    }

    // Every private is now owned, in order, by its buyer.
    for (i, buyer) in buyers.iter().enumerate() {
        let private_id = (i as u32) + 1;
        let private = PRIVATE_COMPANIES.load(&deps.storage, (game_id, private_id)).unwrap();
        assert_eq!(private.owner, Some((*buyer).clone()));
    }

    // Private #6 is the Baltimore & Ohio -- winning it must float the
    // public B&O (company id 4) and grant its 20% President's Certificate
    // to player 3, its buyer.
    let bo_public = PUBLIC_COMPANIES.load(&deps.storage, (game_id, 4)).unwrap();
    assert!(bo_public.is_floated);
    assert_eq!(bo_public.treasury, Uint128::new(670)); // 10 certificates x $67 par
    let bo_president = PROTOCOL_PRESIDENT.load(&deps.storage, (game_id, 4)).unwrap();
    assert_eq!(bo_president, p3.clone());
    let p3_bo_shares = PLAYER_SHARES
        .load(&deps.storage, (game_id, 4, p3.clone()))
        .unwrap();
    assert_eq!(p3_bo_shares, 20);

    // Every private now owned -> the Waterfall Cascade concludes the whole
    // auction and transitions into Stock Round 1. Priority Deal goes to
    // whoever sits immediately to player 3's (the last winner's) left --
    // wrapping back around to player 1.
    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert!(!session.waterfall_auction_active);
    assert_eq!(session.current_round_type, RoundType::StockRound);
    assert_eq!(session.last_private_winner, Some(p3.clone()));
    assert_eq!(session.priority_deal_index, 0); // player 1
    assert_eq!(session.active_player_index, 0);

    // Waterfall messages are now correctly rejected...
    let post_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::WaterfallPass { game_id },
    )
    .unwrap_err();
    assert!(matches!(
        post_err,
        ContractError::Waterfall(WaterfallError::WaterfallNotActive { .. })
    ));

    // ...while ordinary Stock Round trading is now open: player 1 (holding
    // Priority Deal / the active turn) can buy a 10% IPO share of the
    // already-par'd, already-floated B&O.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: 4,
            source: SharePurchaseSource::Ipo,
            par_value: None,
        },
    )
    .expect("Stock Round trading should work now that the Waterfall Auction has concluded");
}

#[test]
fn waterfall_gates_stock_round_and_operating_round_and_legacy_auction_actions() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .unwrap();

    let p1 = Addr::unchecked("wf_p1");
    let p2 = Addr::unchecked("wf_p2");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .unwrap();
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p2.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .unwrap();

    let buy_stock_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: 1,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .unwrap_err();
    assert!(matches!(
        buy_stock_err,
        ContractError::Trading(TradingError::WaterfallAuctionInProgress { .. })
    ));

    let sell_stock_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: 1,
            percentage: 10,
        },
    )
    .unwrap_err();
    assert!(matches!(
        sell_stock_err,
        ContractError::Trading(TradingError::WaterfallAuctionInProgress { .. })
    ));

    let begin_or_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]), // p1 is the room creator
        ExecuteMsg::BeginOperatingRound { game_id },
    )
    .unwrap_err();
    assert!(matches!(
        begin_or_err,
        ContractError::Operations(OperationsError::WaterfallAuctionInProgress { .. })
    ));

    let legacy_auction_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(p1.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 1,
            bid_amount: Uint128::new(20),
        },
    )
    .unwrap_err();
    assert!(matches!(
        legacy_auction_err,
        ContractError::Auction(AuctionError::WaterfallAuctionInProgress { .. })
    ));
}

/* ------------------------------------------------------------------ */
/* Audit G-1 / G-2 regression guards                                  */
/* ------------------------------------------------------------------ */

/// Audit G-1, asset class 3: a player's net worth must include the printed
/// FACE VALUE of every private company they still personally own, and must
/// stop counting it the moment that private `closed` (the B&O Special
/// Closure or the Phase 5 sweep). Both appraisers used to omit private
/// companies entirely, booking $0 for a player holding e.g. the $220 B&O at
/// game end.
///
/// Ownership is seeded by writing `PRIVATE_COMPANIES` directly rather than
/// playing out a Waterfall Auction -- the same direct-storage-seeding
/// pattern `query_player_net_worth_accurately_sums_cash_and_live_stock_portfolio`
/// already uses for `PLAYER_SHARES`, since this test is about the appraisal
/// formula, not about how ownership was acquired.
#[test]
fn net_worth_includes_unclosed_private_company_face_value() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    // Delaware & Hudson: private_id 3, face value $70 (see
    // `auction::CORE_PRIVATE_COMPANIES`).
    const DH_PRIVATE_ID: u32 = 3;

    let baseline = query::query_player_net_worth(deps.as_ref(), game_id, player_a.to_string())
        .expect("querying net worth before owning any private should succeed");
    assert_eq!(baseline.cash_vgp, Uint128::new(1_200));
    assert_eq!(baseline.stock_portfolio_value, Uint128::zero());
    assert_eq!(
        baseline.net_worth,
        Uint128::new(1_200),
        "no shares and no privates -- net worth is just cash"
    );

    // Hand player_a the Delaware & Hudson.
    let mut dh = PRIVATE_COMPANIES
        .load(&deps.storage, (game_id, DH_PRIVATE_ID))
        .unwrap();
    assert_eq!(
        dh.cost,
        Uint128::new(70),
        "test setup assumption: Delaware & Hudson's face value is $70"
    );
    dh.owner = Some(player_a.clone());
    PRIVATE_COMPANIES
        .save(deps.as_mut().storage, (game_id, DH_PRIVATE_ID), &dh)
        .unwrap();

    let with_private =
        query::query_player_net_worth(deps.as_ref(), game_id, player_a.to_string())
            .expect("querying net worth while owning a private should succeed");
    assert_eq!(with_private.cash_vgp, Uint128::new(1_200));
    assert_eq!(with_private.stock_portfolio_value, Uint128::zero());
    assert_eq!(
        with_private.net_worth,
        Uint128::new(1_270),
        "net worth must now include the D&H's $70 face value (Audit G-1)"
    );

    // player_b owns nothing -- one player's private must never leak into
    // another's appraisal.
    let other_player =
        query::query_player_net_worth(deps.as_ref(), game_id, player_b.to_string())
            .expect("querying player_b's net worth should succeed");
    assert_eq!(other_player.net_worth, Uint128::new(1_200));

    // Closing the private (Phase 5 sweep / B&O Special Closure) removes it
    // from play -- and from its owner's net worth.
    dh.closed = true;
    PRIVATE_COMPANIES
        .save(deps.as_mut().storage, (game_id, DH_PRIVATE_ID), &dh)
        .unwrap();

    let after_closure =
        query::query_player_net_worth(deps.as_ref(), game_id, player_a.to_string())
            .expect("querying net worth after the private closed should succeed");
    assert_eq!(
        after_closure.net_worth,
        Uint128::new(1_200),
        "a closed private is permanently out of play and worth nothing"
    );
}

/// Audit G-2 (Split Treasury Divergence): withheld ("Slash/Retain Yield")
/// dividends must land in `PublicCompany::treasury` -- the single corporate
/// cash ledger every SPEND path already draws from -- not in a separate map
/// nothing ever debits.
///
/// The decisive assertion is the second half: after withholding, the
/// corporation actually BUYS A TRAIN with that money. Before this fix,
/// `DeclareDividends { distribute: false }` credited `PROTOCOL_TREASURY_VGP`
/// while `hardware::execute_buy_hardware_from_pool` debited
/// `PublicCompany::treasury`, so a company that had just retained $200
/// still had a $0 spendable treasury and this purchase failed with
/// `InsufficientTreasury`. That is the exact bug -- retained earnings were
/// credited and then permanently stranded.
#[test]
fn withheld_dividends_credit_the_spendable_public_company_treasury() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_ID: u32 = 1;

    // player_a is PRR's President -- the only authorization
    // `DeclareDividends` and `BuyHardwareFromPool` actually check here (no
    // Operating Round queue is established in this room, so both messages'
    // turn-queue gates are skipped entirely).
    PROTOCOL_PRESIDENT
        .save(deps.as_mut().storage, (game_id, PRR_ID), &player_a)
        .unwrap();

    let prr_before = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(
        prr_before.treasury,
        Uint128::zero(),
        "PRR starts unfloated with an empty treasury"
    );

    // Slash/Retain Yield: 100% of $200 into PRR's own treasury.
    let withhold_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::DeclareDividends {
            game_id,
            protocol_id: PRR_ID,
            revenue_amount: Uint128::new(200),
            distribute: false,
        },
    )
    .expect("PRR's President should be able to withhold a dividend");

    assert_eq!(attr(&withhold_res, "withheld_to_treasury"), "200");
    assert_eq!(attr(&withhold_res, "protocol_treasury_total"), "200");

    let prr_after_withhold = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(
        prr_after_withhold.treasury,
        Uint128::new(200),
        "withheld revenue must land in PublicCompany::treasury (Audit G-2)"
    );

    // The decisive half: that retained $200 must be SPENDABLE. The front of
    // the Hardware pool is a 2-train at $80 (`hardware::TRAIN_CATALOG`).
    let buy_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: PRR_ID,
        },
    )
    .expect(
        "retained earnings must be spendable on a train -- this failed with \
         InsufficientTreasury before Audit G-2 was fixed",
    );
    assert_eq!(attr(&buy_res, "model_type"), "2");
    assert_eq!(attr(&buy_res, "cost"), "80");

    let prr_after_purchase = PUBLIC_COMPANIES
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(
        prr_after_purchase.treasury,
        Uint128::new(120),
        "$200 retained - $80 train = $120 left in the one, unified treasury"
    );

    let owned = COMPANY_HARDWARE
        .load(&deps.storage, (game_id, PRR_ID))
        .unwrap();
    assert_eq!(owned.len(), 1);
    assert_eq!(owned[0].model_type, "2");
}

/* ------------------------------------------------------------------ */
/* Audit G-4 / G-6 regression guards                                  */
/* ------------------------------------------------------------------ */

/// Audit G-4: every certificate in a single `SellStock` call must transact
/// at the price the marker sat on when the sale BEGAN. The marker then
/// walks down one row per certificate, afterward.
///
/// The old implementation read `current_cell()` fresh inside its loop and
/// called `move_down` between certificates, so a 30% sale paid the seller
/// three progressively worse prices. This test is pinned to a column of the
/// real board where four consecutive rows carry four DIFFERENT prices
/// (column 1: $67 / $60 / $55 / $48 descending from row 10), so the correct
/// total (3 x $67 = $201) and the old buggy total ($67 + $60 + $55 = $182)
/// are distinguishable -- picking a flat stretch of the board would have
/// made this test pass under both implementations.
#[test]
fn multi_certificate_sales_settle_entirely_at_the_pre_sale_price() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    advance_past_first_stock_round(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_COMPANY_ID: u32 = 1;

    // Seed the holding and the marker position directly -- this test is
    // about sale PRICING, not about how the shares or the position were
    // acquired (the same direct-storage-seeding pattern
    // `query_player_net_worth_accurately_sums_cash_and_live_stock_portfolio`
    // and `calculate_operating_order_sorts_by_price_and_breaks_ties_by_arrival_recency`
    // already use).
    PLAYER_SHARES
        .save(
            deps.as_mut().storage,
            (game_id, PRR_COMPANY_ID, player_a.clone()),
            &30u8,
        )
        .unwrap();
    PROTOCOL_MARKET
        .save(
            deps.as_mut().storage,
            (game_id, PRR_COMPANY_ID),
            &ProtocolMarketState {
                protocol_id: PRR_COMPANY_ID,
                current_x: 1,
                current_y: 10,
                arrival_sequence: 1,
            },
        )
        .unwrap();

    // Setup assumptions about the real board (`market::REAL_MARKET_ROWS`):
    // column 1 descends $67 -> $60 -> $55 -> $48 from row 10.
    let start_price = MARKET_GRID.load(&deps.storage, (1, 10)).unwrap().price;
    let one_row_down = MARKET_GRID.load(&deps.storage, (1, 9)).unwrap().price;
    let two_rows_down = MARKET_GRID.load(&deps.storage, (1, 8)).unwrap().price;
    let three_rows_down = MARKET_GRID.load(&deps.storage, (1, 7)).unwrap().price;
    assert_eq!(start_price, Uint128::new(67));
    assert_eq!(one_row_down, Uint128::new(60));
    assert_eq!(two_rows_down, Uint128::new(55));
    assert_eq!(three_rows_down, Uint128::new(48));

    let cash_before = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    let bank_before = SESSIONS
        .load(&deps.storage, game_id)
        .unwrap()
        .virtual_bank_vgp;

    // Sell three certificates (30%) in one call.
    let sell_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 30,
        },
    )
    .expect("selling three certificates in one call should succeed");

    let correct_total = start_price * Uint128::new(3);
    let old_buggy_total = start_price + one_row_down + two_rows_down;
    assert_eq!(correct_total, Uint128::new(201));
    assert_eq!(old_buggy_total, Uint128::new(182));
    assert_ne!(
        correct_total, old_buggy_total,
        "test setup assumption: the correct and step-down totals must differ, \
         or this test cannot detect the regression"
    );

    assert_eq!(
        attr(&sell_res, "total_proceeds"),
        correct_total.to_string(),
        "all three certificates must settle at the $67 pre-sale price (Audit G-4)"
    );

    let cash_after = PLAYER_CASH_VGP
        .load(&deps.storage, (game_id, player_a.clone()))
        .unwrap();
    assert_eq!(cash_after, cash_before + correct_total);

    let bank_after = SESSIONS
        .load(&deps.storage, game_id)
        .unwrap()
        .virtual_bank_vgp;
    assert_eq!(
        bank_after,
        bank_before - correct_total,
        "the bank funds the sale at the same single pre-sale price"
    );

    // The marker still walks down exactly one row per certificate sold --
    // the fix changes WHEN the money is priced, never how far the price
    // moves.
    assert_eq!(attr(&sell_res, "final_x"), "1");
    assert_eq!(attr(&sell_res, "final_y"), "7");
    assert_eq!(attr(&sell_res, "final_price"), three_rows_down.to_string());

    let marker = PROTOCOL_MARKET
        .load(&deps.storage, (game_id, PRR_COMPANY_ID))
        .unwrap();
    assert_eq!((marker.current_x, marker.current_y), (1, 7));

    // The whole 30% landed in the Bank pool, and the seller is flat.
    assert_eq!(
        BANK_POOL_SHARES
            .load(&deps.storage, (game_id, PRR_COMPANY_ID))
            .unwrap(),
        30
    );
    assert_eq!(
        PLAYER_SHARES
            .load(&deps.storage, (game_id, PRR_COMPANY_ID, player_a.clone()))
            .unwrap(),
        0
    );
}

/// Audit G-6, first half: no share may be sold during Stock Round 1. Buying
/// stays perfectly legal -- SR1 is buy-or-pass, not a freeze -- and the ban
/// lifts the moment the room reaches SR2.
#[test]
fn stock_round_one_forbids_all_share_sales() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    // Deliberately NOT calling `advance_past_first_stock_round` -- this
    // room stays in SR1, which is the whole point.
    skip_waterfall_auction(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_COMPANY_ID: u32 = 1;

    let session = SESSIONS.load(&deps.storage, game_id).unwrap();
    assert_eq!(session.macro_round_number, 1, "the room must start in SR1");
    assert_eq!(session.current_round_type, RoundType::StockRound);

    // BUYING in SR1 is legal -- the rule is "buy or pass," not a freeze.
    // This also advances the turn to player_b.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .expect("buying stock in Stock Round 1 must remain legal");
    assert_eq!(
        PLAYER_SHARES
            .load(&deps.storage, (game_id, PRR_COMPANY_ID, player_a.clone()))
            .unwrap(),
        10
    );

    // Hand the turn back to player_a.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &[]),
        ExecuteMsg::PassTurn { game_id },
    )
    .expect("player_b should be able to pass");

    // SELLING that same certificate in SR1 is not.
    let sell_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            sell_err,
            ContractError::Trading(TradingError::SalesProhibitedInFirstStockRound { .. })
        ),
        "expected Trading(SalesProhibitedInFirstStockRound), got: {sell_err:?}"
    );

    // The rejected sale touched nothing.
    assert_eq!(
        PLAYER_SHARES
            .load(&deps.storage, (game_id, PRR_COMPANY_ID, player_a.clone()))
            .unwrap(),
        10,
        "a rejected sale must not move any shares"
    );
    assert_eq!(
        BANK_POOL_SHARES
            .may_load(&deps.storage, (game_id, PRR_COMPANY_ID))
            .unwrap()
            .unwrap_or(0),
        0
    );

    // Reaching SR2 lifts the ban -- the identical call now succeeds.
    advance_past_first_stock_round(&mut deps.storage, game_id);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .expect("the same sale must succeed once the room reaches SR2");
    assert_eq!(
        PLAYER_SHARES
            .load(&deps.storage, (game_id, PRR_COMPANY_ID, player_a.clone()))
            .unwrap(),
        0
    );
    assert_eq!(
        BANK_POOL_SHARES
            .load(&deps.storage, (game_id, PRR_COMPANY_ID))
            .unwrap(),
        10
    );
}

/// Audit G-6, second half: `BuyStock` and `SellStock` are Stock Round
/// actions and are rejected outright during an Operating Round. This closes
/// the limitation `operations.rs`'s module doc comment #12 flagged --
/// `current_round_type` used to be display-only, so trading during an
/// Operating Round was silently legal.
#[test]
fn stock_actions_are_rejected_outside_a_stock_round() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    advance_past_first_stock_round(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_COMPANY_ID: u32 = 1;

    // Give player_a something sellable, so the rejection below can only be
    // the round-phase gate and never an InsufficientShares fallback.
    PLAYER_SHARES
        .save(
            deps.as_mut().storage,
            (game_id, PRR_COMPANY_ID, player_a.clone()),
            &10u8,
        )
        .unwrap();

    // Move the room into an Operating Round.
    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_round_type = RoundType::OperatingRound;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    let buy_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(100)),
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            buy_err,
            ContractError::Trading(TradingError::StockActionOutsideStockRound { .. })
        ),
        "expected Trading(StockActionOutsideStockRound), got: {buy_err:?}"
    );

    let sell_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            sell_err,
            ContractError::Trading(TradingError::StockActionOutsideStockRound { .. })
        ),
        "expected Trading(StockActionOutsideStockRound), got: {sell_err:?}"
    );

    // Returning to a Stock Round makes both legal again.
    session.current_round_type = RoundType::StockRound;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_COMPANY_ID,
            percentage: 10,
        },
    )
    .expect("selling must work again once the room is back in a Stock Round");
}

/* ------------------------------------------------------------------ */
/* Audit G-5 / G-7 regression guards                                  */
/* ------------------------------------------------------------------ */

/// Audit G-5: a room is seeded with a finite tile tray at creation, and a
/// tile whose every copy is already on the board can neither be laid nor
/// offered as a legal placement. The tray previously did not exist at all
/// -- every tile was infinite.
#[test]
fn tile_inventory_is_seeded_and_blocks_placement_once_depleted() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const BOSTON_Q: i32 = 9;
    const BOSTON_R: i32 = 4;

    // (1) Every catalog tile is seeded at its real 1830 printed quantity
    // the moment the room is created.
    assert_eq!(
        REMAINING_TILES.load(&deps.storage, (game_id, 53)).unwrap(),
        2,
        "tray #53 (green B) prints 2 copies"
    );
    assert_eq!(
        REMAINING_TILES.load(&deps.storage, (game_id, 54)).unwrap(),
        1,
        "tray #54 (green NY) prints 1 copy"
    );
    assert_eq!(
        REMAINING_TILES.load(&deps.storage, (game_id, 9)).unwrap(),
        7,
        "tray #9 (plain straight track) prints 7 copies"
    );
    assert_eq!(
        REMAINING_TILES.load(&deps.storage, (game_id, 8)).unwrap(),
        8,
        "tray #8 (plain gentle curve) prints 8 copies -- the largest stack in the game"
    );

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6, // Baltimore & Ohio
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Green;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    // (2) While copies remain, tile #53 is a legal placement at Boston.
    let before = hexmap::legal_tile_placements(&deps.storage, game_id, BO_PUBLIC_ID, BOSTON_Q, BOSTON_R)
        .expect("legal placements query should succeed");
    assert!(
        before.iter().any(|(tile_id, _)| *tile_id == 53),
        "tile #53 must be offered while the tray still holds copies"
    );

    // (3) Drain the tray for tile #53 specifically -- this test is about the
    // depletion GATE, not about playing out two full placements (which the
    // recycling test below does exercise end to end).
    REMAINING_TILES
        .save(deps.as_mut().storage, (game_id, 53), &0u32)
        .unwrap();

    // (4) A depleted tile is no longer offered as a legal placement.
    let after = hexmap::legal_tile_placements(&deps.storage, game_id, BO_PUBLIC_ID, BOSTON_Q, BOSTON_R)
        .expect("legal placements query should succeed");
    assert!(
        !after.iter().any(|(tile_id, _)| *tile_id == 53),
        "a depleted tile must never be offered as a legal placement"
    );

    // (5) And laying it is rejected outright.
    let exhausted_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 53,
            orientation: 0,
        },
    )
    .unwrap_err();
    match &exhausted_err {
        ContractError::HexMap(HexMapError::TileSupplyExhausted {
            tile_id,
            starting_quantity,
            ..
        }) => {
            assert_eq!(*tile_id, 53);
            assert_eq!(*starting_quantity, 2);
        }
        other => panic!("expected HexMap(TileSupplyExhausted), got: {other:?}"),
    }

    // Nothing was laid.
    assert!(MAP_GRID
        .may_load(&deps.storage, (game_id, BOSTON_Q, BOSTON_R))
        .unwrap()
        .is_none());
}

/// Audit G-5, recycling half: upgrading a hex lifts the old tile off the
/// board and returns it to the tray, exactly as the physical game does --
/// so the copy a company "spent" on a Green tile becomes available again
/// the moment that hex is upgraded to Brown.
#[test]
fn upgrading_a_tile_returns_the_replaced_tile_to_the_tray() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 50,
        },
    )
    .expect("instantiate should succeed");

    let player_one = Addr::unchecked("player_one");
    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &coins(1_000_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);

    const BO_PUBLIC_ID: u32 = 4;
    const BOSTON_Q: i32 = 9;
    const BOSTON_R: i32 = 4;

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id: 6,
            bid_amount: Uint128::new(220),
        },
    )
    .expect("player_one's bid should win Baltimore & Ohio and float the public B&O");

    let mut session = SESSIONS.load(&deps.storage, game_id).unwrap();
    session.current_global_era = TileColor::Brown;
    SESSIONS
        .save(deps.as_mut().storage, game_id, &session)
        .unwrap();

    assert_eq!(REMAINING_TILES.load(&deps.storage, (game_id, 53)).unwrap(), 2);
    assert_eq!(REMAINING_TILES.load(&deps.storage, (game_id, 61)).unwrap(), 2);

    // Lay the Green "B" tile -- one copy leaves the tray.
    let green_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 53,
            orientation: 0,
        },
    )
    .expect("the designated Green BostonHub tile at Boston should succeed");
    assert_eq!(attr(&green_res, "is_upgrade"), "false");
    assert_eq!(attr(&green_res, "tiles_remaining"), "1");
    assert_eq!(
        REMAINING_TILES.load(&deps.storage, (game_id, 53)).unwrap(),
        1,
        "laying a tile removes exactly one copy from the tray"
    );

    // Upgrade to the Brown "B" tile -- one copy of #61 leaves the tray AND
    // the replaced tile #53 comes back into it.
    let brown_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_one.as_str(), &[]),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO_PUBLIC_ID,
            q: BOSTON_Q,
            r: BOSTON_R,
            tile_id: 61,
            orientation: 0,
        },
    )
    .expect("the designated Brown BostonHub tile at Boston should succeed");
    assert_eq!(attr(&brown_res, "is_upgrade"), "true");
    assert_eq!(attr(&brown_res, "tiles_remaining"), "1");
    assert_eq!(attr(&brown_res, "recycled_tile_id"), "53");
    assert_eq!(attr(&brown_res, "recycled_tile_remaining"), "2");

    assert_eq!(
        REMAINING_TILES.load(&deps.storage, (game_id, 61)).unwrap(),
        1,
        "the Brown tile was consumed"
    );
    assert_eq!(
        REMAINING_TILES.load(&deps.storage, (game_id, 53)).unwrap(),
        2,
        "the replaced Green tile returned to the tray (real 1830 recycling)"
    );

    let boston_tile = MAP_GRID
        .load(&deps.storage, (game_id, BOSTON_Q, BOSTON_R))
        .unwrap();
    assert_eq!(boston_tile.tile_id, 61);
}

/// Audit G-7: a sitting President may sell while remaining the largest
/// holder, even when no other player has reached 20%.
///
/// This exact call was REJECTED before the fix. The old blanket pre-check
/// refused any sale by a President unless some other player already held
/// 20%, so a President on 60% could not sell one certificate despite still
/// holding 50% and still being President afterward -- an engine rejecting a
/// legal move.
#[test]
fn president_may_sell_while_remaining_the_largest_holder() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    advance_past_first_stock_round(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_ID: u32 = 1;

    // player_a holds 60% and the seat; player_b holds nothing at all, so
    // there is deliberately NO pre-existing 20% successor.
    PLAYER_SHARES
        .save(deps.as_mut().storage, (game_id, PRR_ID, player_a.clone()), &60u8)
        .unwrap();
    PROTOCOL_PRESIDENT
        .save(deps.as_mut().storage, (game_id, PRR_ID), &player_a)
        .unwrap();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_ID,
            percentage: 10,
        },
    )
    .expect(
        "a President who stays the largest holder may sell -- this was wrongly \
         rejected before Audit G-7",
    );

    assert_eq!(
        PLAYER_SHARES
            .load(&deps.storage, (game_id, PRR_ID, player_a.clone()))
            .unwrap(),
        50
    );
    assert_eq!(
        PROTOCOL_PRESIDENT.load(&deps.storage, (game_id, PRR_ID)).unwrap(),
        player_a,
        "the seller is still the largest holder, so the seat does not move"
    );
}

/// Audit G-7, the dump proper: a President who sells below a rival hands
/// the presidency over, and the seat actually transfers. Previously this
/// path only ever refused the sale -- the transfer was never executed.
#[test]
fn president_dump_transfers_the_presidency_to_the_new_largest_holder() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    advance_past_first_stock_round(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_ID: u32 = 1;

    // player_a presides on 30%; player_b sits on exactly the 20% needed to
    // absorb the presidency.
    PLAYER_SHARES
        .save(deps.as_mut().storage, (game_id, PRR_ID, player_a.clone()), &30u8)
        .unwrap();
    PLAYER_SHARES
        .save(deps.as_mut().storage, (game_id, PRR_ID, player_b.clone()), &20u8)
        .unwrap();
    PROTOCOL_PRESIDENT
        .save(deps.as_mut().storage, (game_id, PRR_ID), &player_a)
        .unwrap();

    // player_a dumps their entire 30% stake.
    let dump_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_ID,
            percentage: 30,
        },
    )
    .expect("dumping onto an eligible 20% successor is legal");

    assert_eq!(
        PLAYER_SHARES
            .load(&deps.storage, (game_id, PRR_ID, player_a.clone()))
            .unwrap(),
        0
    );
    assert_eq!(
        PROTOCOL_PRESIDENT.load(&deps.storage, (game_id, PRR_ID)).unwrap(),
        player_b,
        "the presidency transfers to the new largest holder"
    );
    assert_eq!(attr(&dump_res, "protocol_president"), player_b.as_str());

    // player_b's holding is untouched by the transfer -- under this
    // engine's percentage model, taking the President's certificate moves
    // no percentage, only the seat (trading.rs module doc comment #11).
    assert_eq!(
        PLAYER_SHARES
            .load(&deps.storage, (game_id, PRR_ID, player_b.clone()))
            .unwrap(),
        20
    );
}

/// Audit G-7, the one genuinely illegal dump: a President may not sell out
/// when doing so would leave the corporation with nobody able to hold its
/// President's certificate.
#[test]
fn president_cannot_dump_when_no_successor_would_reach_twenty_percent() {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info("admin", &[]),
        InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
    )
    .expect("instantiate should succeed");

    let player_a = Addr::unchecked("player_a");
    let player_b = Addr::unchecked("player_b");

    let create_res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: 2,
        },
    )
    .expect("create_game_room should succeed");
    let game_id: u64 = attr(&create_res, "game_id").parse().unwrap();
    skip_waterfall_auction(&mut deps.storage, game_id);
    advance_past_first_stock_round(&mut deps.storage, game_id);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_b.as_str(), &coins(1_000, NATIVE_DENOM)),
        ExecuteMsg::JoinGameRoom { game_id },
    )
    .expect("player_b should be able to join");

    const PRR_ID: u32 = 1;

    // player_a presides on exactly 20%; player_b holds only 10%.
    PLAYER_SHARES
        .save(deps.as_mut().storage, (game_id, PRR_ID, player_a.clone()), &20u8)
        .unwrap();
    PLAYER_SHARES
        .save(deps.as_mut().storage, (game_id, PRR_ID, player_b.clone()), &10u8)
        .unwrap();
    PROTOCOL_PRESIDENT
        .save(deps.as_mut().storage, (game_id, PRR_ID), &player_a)
        .unwrap();

    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_ID,
            percentage: 20,
        },
    )
    .unwrap_err();
    assert!(
        matches!(
            err,
            ContractError::Trading(TradingError::NoEligiblePresidentSuccessor { .. })
        ),
        "expected Trading(NoEligiblePresidentSuccessor), got: {err:?}"
    );

    // Nothing moved.
    assert_eq!(
        PLAYER_SHARES
            .load(&deps.storage, (game_id, PRR_ID, player_a.clone()))
            .unwrap(),
        20
    );
    assert_eq!(
        PROTOCOL_PRESIDENT.load(&deps.storage, (game_id, PRR_ID)).unwrap(),
        player_a
    );

    // But selling only HALF that stake is fine -- player_a keeps 10%,
    // which is below 20%, so this must ALSO be refused for the same
    // reason: nobody would be left holding 20%.
    let partial_err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(player_a.as_str(), &[]),
        ExecuteMsg::SellStock {
            game_id,
            protocol_id: PRR_ID,
            percentage: 10,
        },
    )
    .unwrap_err();
    assert!(matches!(
        partial_err,
        ContractError::Trading(TradingError::NoEligiblePresidentSuccessor { .. })
    ));
}

/* ------------------------------------------------------------------ */
/* Audit G-9: Edge-to-Edge Routing, Multi-Train Isolation, Blockades   */
/* ------------------------------------------------------------------ */

/// Writes a real `TILE_CATALOG` tile straight into `MAP_GRID`, bypassing
/// `execute_lay_tile`'s legality gates.
///
/// The G-9 tests below are about the ROUTE TRACER, and need boards with an
/// exact, hand-chosen geometry -- a specific tile at a specific rotation
/// next to another specific tile -- which is not something a sequence of
/// legal `LayTile` calls can be steered into producing without also
/// satisfying era locks, city/town reservations, connectivity, tile-tray
/// supply and treasury costs, none of which this feature touches. Every
/// tile written here is nevertheless a genuine catalog entry carrying its
/// own real `connections` and `paths`, exactly as `execute_lay_tile` would
/// have stored them, so the tracer sees nothing it could not see in a real
/// game. Placement legality itself stays covered by the many `LayTile`
/// tests above.
fn g9_seed_tile(
    storage: &mut dyn cosmwasm_std::Storage,
    game_id: u64,
    q: i32,
    r: i32,
    tile_id: u32,
    orientation: u8,
) {
    let (_, connections, _cost, _terrain, _color, _qty, paths) = hexmap::TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .expect("a G-9 test may only seed a real catalog tile");
    MAP_GRID
        .save(
            storage,
            (game_id, q, r),
            &Tile {
                q,
                r,
                tile_id,
                orientation,
                connections,
                paths: paths.to_vec(),
            },
        )
        .unwrap();
}

/// Gives `protocol_id` a home hex and a set of `(model_type, distance)`
/// trains, the two things `trace_best_route`/`trace_best_route_set` read
/// besides the board itself.
fn g9_seed_company(
    storage: &mut dyn cosmwasm_std::Storage,
    game_id: u64,
    protocol_id: u32,
    home: (i32, i32),
    trains: &[(&str, u32)],
) {
    PROTOCOL_NETWORK_HEXES
        .save(storage, (game_id, protocol_id), &vec![home])
        .unwrap();
    let hardware: Vec<HardwareAsset> = trains
        .iter()
        .map(|(model_type, distance)| HardwareAsset {
            model_type: (*model_type).to_string(),
            cost: Uint128::zero(),
            max_route_distance: *distance,
        })
        .collect();
    COMPANY_HARDWARE
        .save(storage, (game_id, protocol_id), &hardware)
        .unwrap();
}

/// Audit G-9, requirement 1 -- the catalog-level invariant the whole feature
/// rests on: every one of the 46 real 1830 tiles carries an edge-pair list,
/// and that list is consistent with the flat `connections` mask the rest of
/// the contract (and the frontend renderer) still reads.
///
/// This is what stops the two fields silently desynchronizing under a future
/// hand-edit of either one -- exactly the failure mode that would reopen the
/// route-jumping gap without any test noticing.
#[test]
fn tile_catalog_paths_agree_with_connection_masks_for_all_forty_six_tiles() {
    assert_eq!(
        hexmap::TILE_CATALOG.len(),
        46,
        "the catalog must hold the complete real 1830 tile manifest"
    );

    let mut spur_tiles: Vec<u32> = Vec::new();
    for &(tile_id, connections, _cost, _terrain, _color, _qty, paths) in hexmap::TILE_CATALOG {
        assert!(
            !paths.is_empty(),
            "tile {tile_id} has no edge-pair data, so no route could ever cross it"
        );

        let mut seen: Vec<(u8, u8)> = Vec::new();
        for &(a, b) in paths {
            assert!(a < 6 && b < 6, "tile {tile_id} names a non-existent edge");
            assert!(
                a <= b,
                "tile {tile_id}'s pair ({a}, {b}) is not in canonical (min, max) order -- the \
                 claimed-segment ledger would treat it as a different segment travelled the \
                 other way"
            );
            assert!(
                !seen.contains(&(a, b)),
                "tile {tile_id} lists the segment ({a}, {b}) twice"
            );
            seen.push((a, b));
            if a == b {
                spur_tiles.push(tile_id);
            }
        }

        assert_eq!(
            hexmap::tile_base_connections(tile_id),
            Some(connections),
            "tile {tile_id}'s connection mask is not the union of its edge pairs"
        );
    }

    // Real 1830's yellow "OO" tile is the only tray tile whose two cities are
    // genuinely separate dead-end stubs
    // (`city=revenue:40;city=revenue:40;path=a:0,b:_0;path=a:2,b:_1` -- no
    // path joins them). Pinning that down here keeps a future catalog edit
    // from inventing spurs by accident, since a spur is the one shape a train
    // can enter but never pass through.
    assert_eq!(spur_tiles, vec![59, 59]);
}

/// Audit G-9: `rotate_paths` and `rotate_connections` must stay in lockstep
/// at every rotation, not just at the base orientation the catalog is
/// written in. A tile is stored pre-rotation and rotated at read time, so a
/// drift here would let `execute_lay_tile` accept a placement on edges the
/// route tracer then refuses to use (or the reverse).
#[test]
fn rotating_a_tiles_paths_matches_rotating_its_connection_mask() {
    for &(tile_id, connections, _cost, _terrain, _color, _qty, paths) in hexmap::TILE_CATALOG {
        for orientation in 0..6u8 {
            let rotated_paths = hexmap::rotate_paths(paths, orientation);
            let from_paths = hexmap::path_list_connections(&rotated_paths);
            let from_mask = hexmap::rotate_connections(connections, orientation);
            assert_eq!(
                from_paths, from_mask,
                "tile {tile_id} at orientation {orientation}: paths give {from_paths:#08b} but \
                 the mask gives {from_mask:#08b}"
            );
            assert_eq!(rotated_paths.len(), paths.len());
        }
    }
}

/// Audit G-9, requirement 1, end to end -- THE bug this batch was opened
/// for.
///
/// Real tile #1 is two INDEPENDENT towns: one joins edges 1 and 3, the other
/// joins edges 0 and 4. Nothing on the tile connects those two segments. The
/// pre-G-9 tracer read only the flat mask (`0b01_1011`: "edges 0, 1, 3 and 4
/// all carry track") and so would happily enter on edge 0 and leave on edge
/// 3, running a train across track that does not exist.
///
/// The board below makes that jump observable: a train entering the tile-#1
/// hex on edge 0 has exactly one legal exit -- edge 4, its own segment's far
/// end, leading to `(-1, 1)`. A town also sits at `(-1, 0)`, the hex the
/// illegal edge-3 jump would have reached, and must never appear in the
/// route.
#[test]
fn edge_pairs_stop_a_train_jumping_between_unconnected_track_on_one_tile() {
    let mut deps = mock_dependencies();
    let game_id: u64 = 1;
    const PROTOCOL: u32 = 4;

    // Home: a Small Town (#4, a straight through segment 0-3) at (1, 0).
    g9_seed_tile(&mut deps.storage, game_id, 1, 0, 4, 0);
    // The tile under test: #1's two disjoint town segments at (0, 0),
    // unrotated, so its pairs are exactly (0, 4) and (1, 3).
    g9_seed_tile(&mut deps.storage, game_id, 0, 0, 1, 0);
    // Reachable: the far end of the segment the route actually enters on.
    g9_seed_tile(&mut deps.storage, game_id, -1, 1, 4, 1);
    // The decoy: only reachable by jumping segments inside (0, 0).
    g9_seed_tile(&mut deps.storage, game_id, -1, 0, 4, 0);

    g9_seed_company(
        &mut deps.storage,
        game_id,
        PROTOCOL,
        (1, 0),
        &[("4", 4)],
    );

    let (value, path) = pathfinding::trace_best_route(&deps.storage, game_id, PROTOCOL).unwrap();

    assert_eq!(
        path,
        vec![(-1, 1), (0, 0), (1, 0)],
        "the route must follow tile #1's real 0-4 segment, not jump onto its unconnected 1-3 one"
    );
    assert!(
        !path.contains(&(-1, 0)),
        "reaching (-1, 0) means the tracer jumped from edge 0 to edge 3 across a gap in the track"
    );
    // Three towns at $10 each: home, tile #1's own DoubleTown, and (-1, 1).
    assert_eq!(value, Uint128::new(30));
}

/// Audit G-9, requirement 1 -- the terminal-spur half of the edge-pair
/// model.
///
/// Real 1830's yellow "OO" tile #59 prints two cities that each have exactly
/// one track stub and no connection to each other, which `TILE_CATALOG`
/// encodes as the self-pairs `(0, 0)` and `(2, 2)`. A train may run in and
/// STOP at one of those cities; it may never run in one stub and out the
/// other. The flat mask cannot express that at all -- both edges look alike
/// to it -- so before G-9 a train could cross straight through.
#[test]
fn a_terminal_spur_can_be_entered_to_stop_at_but_never_passed_through() {
    let mut deps = mock_dependencies();
    let game_id: u64 = 1;
    const PROTOCOL: u32 = 4;

    // Home town at (0, 0), running out on edge 0.
    g9_seed_tile(&mut deps.storage, game_id, 0, 0, 4, 0);
    // #59 at (1, 0), rotated 3, so its two spurs sit on edges 3 and 5. The
    // route arrives on edge 3.
    g9_seed_tile(&mut deps.storage, game_id, 1, 0, 59, 3);
    // A town on the far side of #59's OTHER spur, at (1, 1). Reachable only
    // by treating the two spurs as one through path.
    g9_seed_tile(&mut deps.storage, game_id, 1, 1, 4, 2);

    g9_seed_company(
        &mut deps.storage,
        game_id,
        PROTOCOL,
        (0, 0),
        &[("4", 4)],
    );

    let (value, path) = pathfinding::trace_best_route(&deps.storage, game_id, PROTOCOL).unwrap();

    assert_eq!(
        path,
        vec![(0, 0), (1, 0)],
        "the route must terminate in tile #59's city, not continue out of its other stub"
    );
    assert!(!path.contains(&(1, 1)));
    // $10 home town + $40 for the one DoubleCityHub station actually reached.
    assert_eq!(value, Uint128::new(50));
}

/// Audit G-9, requirement 3 -- the minimum-route rule, positive case.
///
/// A route that joins two revenue centres scores both. Flint (D4, a
/// preprinted Single-Town hex) laid with Small Town tile #3 rotated so its
/// segment points at Lansing (D2), one of the permanently un-layable GRAY
/// preprinted cities the tracer resolves through its synthetic overlay. Two
/// centres, so the route is legal, and it is worth $10 + $20.
///
/// This is the counterpart to the `$0` assertions in
/// `pathfinding_revenue_only_counts_town_and_city_terrain_not_plain_or_mountain_track`
/// and in the main simulation above: town and city revenue still flows
/// normally, it just now requires a real route to flow along.
#[test]
fn route_scores_once_it_joins_two_revenue_centres() {
    let mut deps = mock_dependencies();
    let game_id: u64 = 1;
    const PROTOCOL: u32 = 4;

    // Tile #3's base segment is (0, 1); rotated 3 it becomes (3, 4), and
    // edge 3 faces (-1, 3) -- Lansing.
    g9_seed_tile(&mut deps.storage, game_id, 0, 3, 3, 3);
    g9_seed_company(
        &mut deps.storage,
        game_id,
        PROTOCOL,
        (0, 3),
        &[("2", 2)],
    );

    // Lansing carries no laid tile and never can (Gray Hex Immutability),
    // so it must be resolving through the synthetic overlay.
    assert!(MAP_GRID.may_load(&deps.storage, (game_id, -1, 3)).unwrap().is_none());
    assert_eq!(hexmap::gray_preprinted_name_at(-1, 3), Some("Lansing"));

    let (value, path) = pathfinding::trace_best_route(&deps.storage, game_id, PROTOCOL).unwrap();
    assert_eq!(path, vec![(-1, 3), (0, 3)]);
    assert_eq!(
        value,
        Uint128::new(30),
        "$10 Flint (SmallTown) + $20 Lansing (MajorCityHub)"
    );

    // And the same board through the multi-train entry point: one 2-train,
    // one route, same money.
    let (total, routes) =
        pathfinding::trace_best_route_set(&deps.storage, game_id, PROTOCOL).unwrap();
    assert_eq!(total, Uint128::new(30));
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].model_type, "2");
    assert_eq!(routes[0].revenue_centres, 2);
    assert_eq!(routes[0].value, Uint128::new(30));
}

/// Audit G-9, requirement 2 -- multi-train route isolation.
///
/// Tile #1 at the home hex gives the company two INDEPENDENT branches out of
/// one hex (segments 0-4 and 1-3, which is the same disjointness the
/// route-jumping test above exploits, used here for the opposite purpose).
/// With a town on each of the four branch ends, there are exactly two
/// segment-disjoint routes on this board:
///
///   * `(1, 0) - home - (-1, 1)` along tile #1's 0-4 segment, and
///   * `(1, -1) - home - (-1, 0)` along its 1-3 segment.
///
/// Two trains must take one each and earn $30 apiece. A THIRD train must
/// earn nothing at all: every segment on the board is already claimed, and
/// no train may reuse another's track in the same Operating Round.
#[test]
fn trace_best_route_set_never_lets_two_trains_reuse_the_same_track_segment() {
    let mut deps = mock_dependencies();
    let game_id: u64 = 1;
    const PROTOCOL: u32 = 4;

    g9_seed_tile(&mut deps.storage, game_id, 0, 0, 1, 0);
    // One Small Town per branch end. Each is rotated so its own straight
    // segment presents the edge facing home: `(edge + 3) % 6`, and tile #4's
    // base segment (0, 3) covers edge `e` at orientation `e % 3`.
    g9_seed_tile(&mut deps.storage, game_id, 1, 0, 4, 0); // home edge 0
    g9_seed_tile(&mut deps.storage, game_id, -1, 1, 4, 1); // home edge 4
    g9_seed_tile(&mut deps.storage, game_id, 1, -1, 4, 1); // home edge 1
    g9_seed_tile(&mut deps.storage, game_id, -1, 0, 4, 0); // home edge 3

    g9_seed_company(
        &mut deps.storage,
        game_id,
        PROTOCOL,
        (0, 0),
        &[("3", 3), ("3", 3), ("2", 2)],
    );

    let (total, routes) =
        pathfinding::trace_best_route_set(&deps.storage, game_id, PROTOCOL).unwrap();

    assert_eq!(
        routes.len(),
        2,
        "only two segment-disjoint routes exist here, so the third train must find none"
    );
    assert_eq!(total, Uint128::new(60), "$30 per route, two routes");
    for route in &routes {
        assert_eq!(route.value, Uint128::new(30));
        assert_eq!(route.revenue_centres, 3);
        assert!(route.hexes.contains(&(0, 0)), "every route runs from home");
    }

    // The ledger invariant itself: no track segment appears in more than one
    // train's route.
    let mut all_segments: Vec<(i32, i32, (u8, u8))> = Vec::new();
    for route in &routes {
        for segment in &route.segments {
            assert!(
                !all_segments.contains(segment),
                "segment {segment:?} was run by two different trains in one Operating Round"
            );
            all_segments.push(*segment);
        }
    }
    assert!(!all_segments.is_empty());

    // The two routes take opposite branches -- they cannot both have taken
    // the richer one, because the richer one only exists once.
    let first: Vec<(i32, i32)> = routes[0].hexes.clone();
    let second: Vec<(i32, i32)> = routes[1].hexes.clone();
    for hex in second.iter() {
        if *hex == (0, 0) {
            continue;
        }
        assert!(
            !first.contains(hex),
            "the two trains' routes overlap at {hex:?} beyond the shared home station"
        );
    }

    // A single-train company on this same board earns only one route's worth
    // -- confirming the $60 above really is the multi-train total and not
    // one route being counted twice.
    g9_seed_company(
        &mut deps.storage,
        game_id,
        PROTOCOL,
        (0, 0),
        &[("3", 3)],
    );
    let (solo_total, solo_routes) =
        pathfinding::trace_best_route_set(&deps.storage, game_id, PROTOCOL).unwrap();
    assert_eq!(solo_total, Uint128::new(30));
    assert_eq!(solo_routes.len(), 1);
}

/// Audit G-9, requirement 3 -- station token blockades, read from
/// `PROTOCOL_STATION_HEXES` and applied only when the city is genuinely
/// full.
///
/// Board: home town -> city -> town, a straight run worth $40. A single
/// rival token is then placed in the middle city, and the outcome depends
/// entirely on how many slots that city's artwork has:
///
///   * Yellow city #57 (1 slot) -- full. The route may still STOP in the
///     city and score it, but may not pass through to the far town: $30.
///   * Green city #14 (2 slots) -- one slot still open, so no blockade at
///     all and the route runs straight through: $40. This is the specific
///     carve-out requirement 3 calls for.
///   * Yellow city #57 with a token of OUR OWN in it -- never blocked out of
///     our own station, however full: $40.
#[test]
fn rival_tokens_block_a_route_only_when_the_city_has_no_open_slot() {
    const OURS: u32 = 4; // B&O
    const RIVAL: u32 = 1; // PRR
    let game_id: u64 = 1;

    // `city_tile` is laid at (1, 0); `rival_token`/`own_token` seed
    // `PROTOCOL_STATION_HEXES` there. Returns the traced route.
    let trace = |city_tile: u32, rival_token: bool, own_token: bool| {
        let mut deps = mock_dependencies();
        g9_seed_tile(&mut deps.storage, game_id, 0, 0, 4, 0);
        g9_seed_tile(&mut deps.storage, game_id, 1, 0, city_tile, 0);
        g9_seed_tile(&mut deps.storage, game_id, 2, 0, 4, 0);
        g9_seed_company(&mut deps.storage, game_id, OURS, (0, 0), &[("3", 3)]);
        if rival_token {
            PROTOCOL_STATION_HEXES
                .save(&mut deps.storage, (game_id, RIVAL), &vec![(1, 0)])
                .unwrap();
        }
        if own_token {
            PROTOCOL_STATION_HEXES
                .save(&mut deps.storage, (game_id, OURS), &vec![(1, 0)])
                .unwrap();
        }
        pathfinding::trace_best_route(&deps.storage, game_id, OURS).unwrap()
    };

    // Sanity: the slot counts this rule turns on are what the catalog says.
    assert_eq!(hexmap::tile_city_slots(57), 1);
    assert_eq!(hexmap::tile_city_slots(14), 2);

    let (open_value, open_path) = trace(57, false, false);
    assert_eq!(open_value, Uint128::new(40), "$10 + $20 city + $10");
    assert_eq!(open_path, vec![(0, 0), (1, 0), (2, 0)]);

    let (blocked_value, blocked_path) = trace(57, true, false);
    assert_eq!(
        blocked_path,
        vec![(0, 0), (1, 0)],
        "a rival token filling a 1-slot city stops the route there"
    );
    assert_eq!(
        blocked_value,
        Uint128::new(30),
        "the route still SCORES the city it stopped in -- it just cannot run past it"
    );

    let (open_slot_value, open_slot_path) = trace(14, true, false);
    assert_eq!(
        open_slot_path,
        vec![(0, 0), (1, 0), (2, 0)],
        "a 2-slot city with one rival token still has an open slot, so it blocks nobody"
    );
    assert_eq!(open_slot_value, Uint128::new(40));

    let (own_value, own_path) = trace(57, true, true);
    assert_eq!(
        own_path,
        vec![(0, 0), (1, 0), (2, 0)],
        "a company is never blockaded out of a city it holds a token in"
    );
    assert_eq!(own_value, Uint128::new(40));
}

/// Audit G-9: the blockade helper `operations::execute_run_manual_route`
/// consumes now reads the token registry, not the tile registry.
///
/// Before this pass, `opponent_station_hexes` returned each rival's FIRST
/// LAID TILE from `PROTOCOL_NETWORK_HEXES` -- so a rival that had laid track
/// but placed no token blocked a hex it had no claim to, while a rival's
/// second, third and fourth real tokens blocked nothing at all.
#[test]
fn blockades_come_from_the_station_token_registry_not_from_laid_tiles() {
    let mut deps = mock_dependencies();
    let game_id: u64 = 1;
    const OURS: u32 = 4;
    const RIVAL: u32 = 1;

    // A 1-slot yellow city at each of two hexes.
    g9_seed_tile(&mut deps.storage, game_id, 1, 0, 57, 0);
    g9_seed_tile(&mut deps.storage, game_id, 5, 5, 57, 0);

    // The rival has LAID a tile at (1, 0) -- its first network hex -- but has
    // placed its tokens somewhere else entirely.
    PROTOCOL_NETWORK_HEXES
        .save(&mut deps.storage, (game_id, RIVAL), &vec![(1, 0)])
        .unwrap();
    PROTOCOL_STATION_HEXES
        .save(&mut deps.storage, (game_id, RIVAL), &vec![(5, 5)])
        .unwrap();

    let blocked = pathfinding::opponent_station_hexes(&deps.storage, game_id, OURS).unwrap();

    assert!(
        !blocked.contains(&(1, 0)),
        "laying track is not placing a token -- (1, 0) must not be blockaded"
    );
    assert!(
        blocked.contains(&(5, 5)),
        "the rival's actual token hex must be blockaded"
    );

    // A rival token beyond its first is a real blockade too, which the old
    // "first laid tile" model could never represent.
    PROTOCOL_STATION_HEXES
        .save(&mut deps.storage, (game_id, RIVAL), &vec![(5, 5), (1, 0)])
        .unwrap();
    let blocked_after = pathfinding::opponent_station_hexes(&deps.storage, game_id, OURS).unwrap();
    assert!(blocked_after.contains(&(1, 0)));
    assert!(blocked_after.contains(&(5, 5)));
}

/// Audit G-9, design note #4: a train's `max_route_distance` caps REVENUE
/// CENTRES, not hexes. Plain track is a free connector.
///
/// Pre-G-9 the cap counted visited hexes, under which a 2-train could not
/// run the most ordinary route in 1830 -- two towns joined by one plain
/// connector, which is three hexes. It can now, and a 2-train still cannot
/// reach a THIRD town.
#[test]
fn a_trains_distance_budget_counts_revenue_centres_not_connector_hexes() {
    let mut deps = mock_dependencies();
    let game_id: u64 = 1;
    const PROTOCOL: u32 = 4;

    // town -- plain -- town -- plain -- town, all straight #4/#9 segments.
    g9_seed_tile(&mut deps.storage, game_id, 0, 0, 4, 0);
    g9_seed_tile(&mut deps.storage, game_id, 1, 0, 9, 0);
    g9_seed_tile(&mut deps.storage, game_id, 2, 0, 4, 0);
    g9_seed_tile(&mut deps.storage, game_id, 3, 0, 9, 0);
    g9_seed_tile(&mut deps.storage, game_id, 4, 0, 4, 0);

    g9_seed_company(&mut deps.storage, game_id, PROTOCOL, (0, 0), &[("2", 2)]);
    let (two_train, two_path) =
        pathfinding::trace_best_route(&deps.storage, game_id, PROTOCOL).unwrap();
    assert_eq!(
        two_path,
        vec![(0, 0), (1, 0), (2, 0)],
        "a 2-train crosses the plain connector freely and stops at its second town"
    );
    assert_eq!(two_train, Uint128::new(20));

    g9_seed_company(&mut deps.storage, game_id, PROTOCOL, (0, 0), &[("3", 3)]);
    let (three_train, three_path) =
        pathfinding::trace_best_route(&deps.storage, game_id, PROTOCOL).unwrap();
    assert_eq!(
        three_path,
        vec![(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)],
        "a 3-train has the stop budget to reach the third town"
    );
    assert_eq!(three_train, Uint128::new(30));
}

/// Audit G-9: the route tracer must be deterministic, because a CosmWasm
/// contract's output has to be identical on every validating node. The
/// search leans on `HashSet`/`HashMap`, whose iteration order is not stable,
/// so this pins down that no such iteration reaches a result.
#[test]
fn tracing_the_same_board_twice_gives_byte_identical_routes() {
    let mut deps = mock_dependencies();
    let game_id: u64 = 1;
    const PROTOCOL: u32 = 4;

    g9_seed_tile(&mut deps.storage, game_id, 0, 0, 1, 0);
    g9_seed_tile(&mut deps.storage, game_id, 1, 0, 4, 0);
    g9_seed_tile(&mut deps.storage, game_id, -1, 1, 4, 1);
    g9_seed_tile(&mut deps.storage, game_id, 1, -1, 4, 1);
    g9_seed_tile(&mut deps.storage, game_id, -1, 0, 4, 0);
    g9_seed_company(
        &mut deps.storage,
        game_id,
        PROTOCOL,
        (0, 0),
        &[("3", 3), ("3", 3)],
    );

    let first = pathfinding::trace_best_route_set(&deps.storage, game_id, PROTOCOL).unwrap();
    for _ in 0..8 {
        let again = pathfinding::trace_best_route_set(&deps.storage, game_id, PROTOCOL).unwrap();
        assert_eq!(first, again, "route tracing must be deterministic");
    }
}

/// Audit G-9: a company with no Hardware, no home hex, or no board at all
/// must fall out of both entry points cleanly rather than panicking or
/// scoring something. These were the pre-G-9 short-circuits and they still
/// hold after the rewrite.
#[test]
fn tracing_degenerate_companies_returns_nothing_rather_than_failing() {
    let mut deps = mock_dependencies();
    let game_id: u64 = 1;
    const PROTOCOL: u32 = 4;

    // Nothing seeded at all.
    assert_eq!(
        pathfinding::trace_best_route(&deps.storage, game_id, PROTOCOL).unwrap(),
        (Uint128::zero(), Vec::new())
    );
    assert_eq!(
        pathfinding::trace_best_route_set(&deps.storage, game_id, PROTOCOL).unwrap(),
        (Uint128::zero(), Vec::new())
    );

    // Trains but no track.
    g9_seed_company(&mut deps.storage, game_id, PROTOCOL, (0, 0), &[("4", 4)]);
    assert_eq!(
        pathfinding::trace_best_route(&deps.storage, game_id, PROTOCOL).unwrap(),
        (Uint128::zero(), Vec::new())
    );

    // Track but a train that cannot satisfy the two-centre minimum.
    g9_seed_tile(&mut deps.storage, game_id, 0, 0, 4, 0);
    g9_seed_tile(&mut deps.storage, game_id, 1, 0, 4, 0);
    g9_seed_company(&mut deps.storage, game_id, PROTOCOL, (0, 0), &[("1", 1)]);
    let (value, path) = pathfinding::trace_best_route(&deps.storage, game_id, PROTOCOL).unwrap();
    assert_eq!(value, Uint128::zero());
    assert!(path.is_empty());
}
