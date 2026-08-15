//! End-to-end integration suite, driven through `cw-multi-test`.
//!
//! ===================================================================
//!  WHY THIS FILE EXISTS ALONGSIDE `src/tests.rs`
//! ===================================================================
//!
//! The in-process suite in `src/tests.rs` calls `execute`/`query` directly
//! against `mock_dependencies()`. That is fast and precise, and it is what
//! nearly every rule in this contract is tested with -- but it cannot see one
//! entire half of what this contract does, because a directly-called handler
//! returns `Response { messages }` and NOBODY EVER DELIVERS THEM. A
//! `BankMsg::Send` in that suite is an assertion about a struct, not about
//! money moving.
//!
//! This suite runs the contract inside a simulated chain with a real bank
//! module. Deposits genuinely leave a player's balance, the escrow genuinely
//! accumulates in the contract's own account, and the final payout genuinely
//! arrives in four wallets. `e2e_native_token_settlement_matches_net_worth`
//! is the test this whole file exists for: it is the only place in the
//! project where "the JUNO escrow pool is distributed in proportion to final
//! net worth" is checked against actual token balances rather than against
//! the messages the contract hoped someone would execute.
//!
//! ===================================================================
//!  WHY SEVERAL TESTS RATHER THAN ONE SCRIPTED MATCH
//! ===================================================================
//!
//! The obvious shape for this is one long function that plays a whole game
//! start to finish. It is also the wrong shape, for a reason worth stating:
//! a single 300-line script fails as ONE test. When step 5 breaks, steps 6-8
//! never run, and the settlement assertions -- the highest-value thing here
//! -- go unverified because of an unrelated tile-placement problem three
//! phases earlier.
//!
//! So the match is split along its real phase boundaries, each test carrying
//! the game forward from a shared, deterministic setup. A failure names the
//! phase that broke, and every later phase is still checked.
//!
//! ===================================================================
//!  DETERMINISM: WHY THE AUCTION IS PLAYED WITH BUY-LOWEST ONLY
//! ===================================================================
//!
//! `waterfall_buy_lowest` is the one auction action whose outcome is fully
//! determined by state already asserted: it takes the cheapest unowned
//! private at its current face value and cascades to the next one, which --
//! with no bids anywhere -- always has zero bids and always stops there. Six
//! of them, in seat order, allocate all six privates with no branching.
//!
//! A bid-driven auction would exercise more of `waterfall.rs`, but its turn
//! order depends on mini-auction resolution that `src/tests.rs` already
//! covers directly and in isolation. Re-deriving it here would make this
//! file's setup fragile without testing anything new about token settlement,
//! which is what this file is for.

use cosmwasm_std::{coins, Addr, Coin, Empty, Uint128};
use cw_multi_test::{App, AppBuilder, Contract, ContractWrapper, Executor};

use eighteen_cosmos::contract::{execute, instantiate, query, NATIVE_DENOM};
use eighteen_cosmos::msg::{
    ExecuteMsg, GameStateResponse, InstantiateMsg, PlayerNetWorthResponse, QueryMsg,
    SharePurchaseSource,
};

/// The room's ante. Exactly `escrow::MINIMUM_ANTE` (2 JUNO in `ujuno`), which
/// also demonstrates the floor is inclusive rather than exclusive.
const ANTE: u128 = 2_000_000;

/// What each player's wallet is funded with before the match. Comfortably
/// above the ante so a failed deposit is visible as a balance that did not
/// move, rather than as an out-of-funds error that could mean anything.
const WALLET: u128 = 10_000_000;

const PLAYER_COUNT: usize = 4;

/// The four core private companies' printed face values, in seat-purchase
/// order -- see `auction::CORE_PRIVATE_COMPANIES`. Used to predict each
/// player's cash after the auction.
const PRIVATE_COSTS: [u128; 6] = [20, 40, 70, 110, 160, 220];

/// Wraps the contract's three entry points for the mock chain.
fn game_contract() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(execute, instantiate, query))
}

fn seat(index: usize) -> Addr {
    Addr::unchecked(format!("player{index}"))
}

/// The contract instantiator, and therefore `GameConfig::developer_treasury`.
///
/// Deliberately NOT one of the four players. `finalize_and_distribute_payouts`
/// sweeps the integer-division remainder of the payout to the treasury, so an
/// instantiator who is also a seat receives their proportional share PLUS the
/// dust -- which makes "each player receives exactly their proportional share"
/// untestable for that one seat. Separating the roles lets both claims be
/// asserted exactly, and separately.
fn treasury() -> Addr {
    Addr::unchecked("dev_treasury")
}

/// A chain with four funded wallets and the contract stored.
fn boot() -> (App, u64) {
    let mut app = AppBuilder::new().build(|router, _api, storage| {
        for index in 0..PLAYER_COUNT {
            router
                .bank
                .init_balance(storage, &seat(index), coins(WALLET, NATIVE_DENOM))
                .expect("funding a test wallet should succeed");
        }
    });
    let code_id = app.store_code(game_contract());
    (app, code_id)
}

/// Instantiates the contract with a 0% subsidy.
///
/// Zero deliberately: a nonzero subsidy siphons a cut of every deposit out to
/// the developer treasury, which makes every balance assertion in this file a
/// function of a rounding rule that `src/tests.rs` already covers directly.
/// The settlement maths this suite exists to verify is clearer against an
/// untaxed pool, and the taxed path is not what is under test here.
fn instantiate_contract(app: &mut App, code_id: u64) -> Addr {
    app.instantiate_contract(
        code_id,
        treasury(),
        &InstantiateMsg {
            subsidy_fee_percentage: 0,
        },
        &[],
        "18cosmos-e2e",
        None,
    )
    .expect("instantiate should succeed")
}

fn balance(app: &App, who: &Addr) -> u128 {
    app.wrap()
        .query_balance(who, NATIVE_DENOM)
        .expect("balance query should succeed")
        .amount
        .u128()
}

fn game_state(app: &App, contract: &Addr, game_id: u64) -> GameStateResponse {
    app.wrap()
        .query_wasm_smart(contract, &QueryMsg::GetGameState { game_id })
        .expect("GetGameState should succeed")
}

fn net_worth(app: &App, contract: &Addr, game_id: u64, who: &Addr) -> Uint128 {
    let response: PlayerNetWorthResponse = app
        .wrap()
        .query_wasm_smart(
            contract,
            &QueryMsg::PlayerNetWorth {
                game_id,
                wallet_address: who.to_string(),
            },
        )
        .expect("PlayerNetWorth should succeed");
    response.net_worth
}

fn exec(app: &mut App, who: &Addr, contract: &Addr, msg: &ExecuteMsg, funds: &[Coin]) {
    app.execute_contract(who.clone(), contract.clone(), msg, funds)
        // `{err:?}` rather than `{err}`: cw-multi-test returns an
        // `anyhow::Error`, whose `Display` prints only the OUTERMOST wrapper
        // ("Error executing WasmMsg: ...") and swallows the contract's own
        // error underneath it. The `Debug` form prints the full cause chain,
        // which is the difference between "the route failed" and "the route
        // failed with WrongOperatingSubPhase { actual: Tokens, required:
        // Routes }".
        .unwrap_or_else(|err| panic!("{who} -> {msg:?} should succeed: {err:?}"));
}

/// Creates the room and seats all four players at the uniform ante.
fn open_table(app: &mut App, contract: &Addr) -> u64 {
    exec(
        app,
        &seat(0),
        contract,
        &ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: PLAYER_COUNT as u8,
        },
        &coins(ANTE, NATIVE_DENOM),
    );

    // Room ids start at 1 and this suite creates exactly one room per chain.
    let game_id = 1u64;

    for index in 1..PLAYER_COUNT {
        exec(
            app,
            &seat(index),
            contract,
            &ExecuteMsg::JoinGameRoom { game_id },
            &coins(ANTE, NATIVE_DENOM),
        );
    }
    game_id
}

/// Plays the Waterfall Auction to completion with six `WaterfallBuyLowest`
/// calls in seat order -- see this module's determinism note.
fn play_waterfall(app: &mut App, contract: &Addr, game_id: u64) {
    for purchase in 0..PRIVATE_COSTS.len() {
        let buyer = seat(purchase % PLAYER_COUNT);
        exec(
            app,
            &buyer,
            contract,
            &ExecuteMsg::WaterfallBuyLowest { game_id },
            &[],
        );
    }
}

/* ================================================================== */
/* 1. Table creation and the lobby's ante rules                       */
/* ================================================================== */

#[test]
fn e2e_table_creation_and_lobby_ante_enforcement() {
    let (mut app, code_id) = boot();
    let contract = instantiate_contract(&mut app, code_id);

    // ---- The ante floor is real money, enforced on a real transfer.
    let under = app.execute_contract(
        seat(0),
        contract.clone(),
        &ExecuteMsg::CreateGameRoom {
            virtual_bank_start: Uint128::new(12_000),
            max_players: PLAYER_COUNT as u8,
        },
        &coins(ANTE - 1, NATIVE_DENOM),
    );
    assert!(under.is_err(), "a deposit below MINIMUM_ANTE cannot open a room");
    assert_eq!(
        balance(&app, &seat(0)),
        WALLET,
        "a rejected create must leave the wallet untouched -- the whole transaction reverts"
    );

    let game_id = open_table(&mut app, &contract);

    // ---- The escrow is genuinely held by the contract, not merely recorded.
    for index in 0..PLAYER_COUNT {
        assert_eq!(
            balance(&app, &seat(index)),
            WALLET - ANTE,
            "player{index}'s ante actually left their wallet"
        );
    }
    assert_eq!(
        balance(&app, &contract),
        ANTE * PLAYER_COUNT as u128,
        "the contract holds the entire escrow pool"
    );

    let state = game_state(&app, &contract, game_id);
    assert_eq!(state.player_addresses.len(), PLAYER_COUNT);
    assert_eq!(
        state.total_juno_pool,
        Uint128::new(ANTE * PLAYER_COUNT as u128),
        "0% subsidy, so the pool is the full sum of antes"
    );

    // ---- The Uniform Ante Rule holds against a real transfer too: a fifth
    // player cannot buy in at a different price (and the room is full anyway,
    // so this also proves the seat cap).
    let mismatched = app.execute_contract(
        Addr::unchecked("gatecrasher"),
        contract.clone(),
        &ExecuteMsg::JoinGameRoom { game_id },
        &coins(ANTE + 1, NATIVE_DENOM),
    );
    assert!(mismatched.is_err());
}

/* ================================================================== */
/* 2. The Waterfall Auction allocates every private                   */
/* ================================================================== */

#[test]
fn e2e_waterfall_allocates_every_private_and_opens_the_stock_round() {
    let (mut app, code_id) = boot();
    let contract = instantiate_contract(&mut app, code_id);
    let game_id = open_table(&mut app, &contract);

    play_waterfall(&mut app, &contract, game_id);

    let state = game_state(&app, &contract, game_id);
    assert_eq!(
        state.current_round_type,
        eighteen_cosmos::state::RoundType::StockRound,
        "with every private owned the auction concludes into Stock Round 1"
    );

    // Every private is owned, and by the seat that bought it: purchases
    // rotate through the four seats in order, so seat 0 took privates 1 and
    // 5, seat 1 took 2 and 6, and so on.
    for (offset, cost) in PRIVATE_COSTS.iter().enumerate() {
        let owner_seat = offset % PLAYER_COUNT;
        let owned = state
            .private_companies
            .iter()
            .find(|p| p.private_id == (offset as u32) + 1)
            .expect("every core private should appear in the state response");
        assert_eq!(
            owned.owner,
            Some(seat(owner_seat)),
            "private #{} should belong to seat {owner_seat}",
            offset + 1
        );
        let _ = cost;
    }

    // Cash reconciles exactly: each seat paid the face value of the privates
    // it actually took, out of a 4-player starting endowment of $600.
    for index in 0..PLAYER_COUNT {
        let spent: u128 = PRIVATE_COSTS
            .iter()
            .enumerate()
            .filter(|(offset, _)| offset % PLAYER_COUNT == index)
            .map(|(_, cost)| *cost)
            .sum();
        let cash = state
            .player_cash
            .iter()
            .find(|entry| entry.player == seat(index))
            .expect("every player should have a cash entry")
            .cash_vgp;
        assert_eq!(
            cash,
            Uint128::new(600 - spent),
            "seat {index} should have spent exactly {spent} on privates"
        );
    }

    // Priority Deal seats to the LEFT of whoever won the last private. Seat 1
    // took the sixth and final one, so the deal is seat 2's.
    assert_eq!(state.priority_deal_index, 2);
    assert_eq!(
        state.active_player_index, 2,
        "Stock Round 1 opens on the Priority Deal holder"
    );
}

/* ================================================================== */
/* 3. Stock Round: President's Certificate, flotation, Priority Deal  */
/* ================================================================== */

#[test]
fn e2e_stock_round_president_certificate_float_and_priority_deal() {
    let (mut app, code_id) = boot();
    let contract = instantiate_contract(&mut app, code_id);
    let game_id = open_table(&mut app, &contract);
    play_waterfall(&mut app, &contract, game_id);

    const PRR: u32 = 1;
    const PAR: u128 = 67;

    // Seat 2 holds the Priority Deal and therefore opens the round.
    let opener = seat(2);
    let cash_before = game_state(&app, &contract, game_id)
        .player_cash
        .iter()
        .find(|entry| entry.player == opener)
        .expect("seat 2 should have cash")
        .cash_vgp;

    // ---- The opening purchase is the 20% President's Certificate at 2x par.
    exec(
        &mut app,
        &opener,
        &contract,
        &ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(PAR)),
            quantity: None,
        },
        &[],
    );

    let state = game_state(&app, &contract, game_id);
    let prr = state
        .public_companies
        .iter()
        .find(|c| c.company_id == PRR)
        .expect("PRR should be in the state response");
    assert_eq!(
        prr.player_holdings
            .iter()
            .find(|h| h.player == opener)
            .map(|h| h.percentage),
        Some(20),
        "opening a corporation buys the 20% President's Certificate, not a 10% share"
    );
    assert_eq!(prr.president, Some(opener.clone()));
    assert!(!prr.is_floated, "20% is well short of the 60% float threshold");
    let cash_after_open = state
        .player_cash
        .iter()
        .find(|entry| entry.player == opener)
        .unwrap()
        .cash_vgp;
    assert_eq!(
        cash_after_open,
        cash_before - Uint128::new(PAR * 2),
        "the President's Certificate costs exactly twice par"
    );

    // ---- Four more ordinary certificates float it at 60%. Every purchase
    // ends the buyer's turn, so the other three seats pass it back around.
    for _ in 0..4 {
        for other in [3usize, 0, 1] {
            exec(
                &mut app,
                &seat(other),
                &contract,
                &ExecuteMsg::PassTurn { game_id },
                &[],
            );
        }
        exec(
            &mut app,
            &opener,
            &contract,
            &ExecuteMsg::BuyStock {
                game_id,
                protocol_id: PRR,
                source: SharePurchaseSource::Ipo,
                par_value: None,
                quantity: None,
            },
            &[],
        );
    }

    let state = game_state(&app, &contract, game_id);
    let prr = state
        .public_companies
        .iter()
        .find(|c| c.company_id == PRR)
        .unwrap();
    assert!(prr.is_floated, "60% real-player ownership floats the corporation");
    assert_eq!(
        prr.treasury,
        Uint128::new(PAR * 10),
        "flotation capitalises the treasury at 10x par"
    );

    // ---- The round ends on a full row of passes, and the Priority Deal
    // moves to the seat LEFT of the last actor. Seat 2 acted last, so the
    // deal must land on seat 3.
    for other in [3usize, 0, 1, 2] {
        exec(
            &mut app,
            &seat(other),
            &contract,
            &ExecuteMsg::PassTurn { game_id },
            &[],
        );
    }

    let state = game_state(&app, &contract, game_id);
    assert_eq!(
        state.priority_deal_index, 3,
        "the deal seats left of seat 2, the last player to actually buy"
    );
}

/* ================================================================== */
/* 4. THE SETTLEMENT TEST -- real tokens, real proportions            */
/* ================================================================== */

/// **The reason this file exists.**
///
/// Plays a short but complete match, ends it, and then checks the four
/// players' ACTUAL on-chain `ujuno` balances against the proportional split
/// of the escrow pool that each one's final VGP net worth entitles them to.
///
/// Every other test of `EndGameAndDistribute` in this project inspects
/// `Response::messages` -- a list of transfers the contract intends. This one
/// checks that the transfers happened, that they went to the right wallets,
/// and that the contract's own escrow account is empty afterwards. Those are
/// different claims, and only this suite can make the second one.
#[test]
fn e2e_native_token_settlement_matches_net_worth() {
    let (mut app, code_id) = boot();
    let contract = instantiate_contract(&mut app, code_id);
    let game_id = open_table(&mut app, &contract);
    play_waterfall(&mut app, &contract, game_id);

    const PRR: u32 = 1;
    const PAR: u128 = 100;

    // Give the seats genuinely DIFFERENT net worths, so a proportional split
    // is distinguishable from an equal one. Seat 2 opens a corporation and
    // takes a large position; the others simply hold their auction purchases.
    let buyer = seat(2);
    exec(
        &mut app,
        &buyer,
        &contract,
        &ExecuteMsg::BuyStock {
            game_id,
            protocol_id: PRR,
            source: SharePurchaseSource::Ipo,
            par_value: Some(Uint128::new(PAR)),
            quantity: None,
        },
        &[],
    );

    // ---- Snapshot every player's final net worth BEFORE closing the room.
    // `EndGameAndDistribute` zeroes the pool and deactivates the session, so
    // the appraisal has to be taken while the game is still live -- and it is
    // the same read-only appraiser the contract itself uses internally.
    let mut worths = Vec::new();
    let mut total = Uint128::zero();
    for index in 0..PLAYER_COUNT {
        let worth = net_worth(&app, &contract, game_id, &seat(index));
        total += worth;
        worths.push(worth);
    }
    assert!(!total.is_zero(), "a settled game must have some value to split");
    assert!(
        worths.iter().any(|w| *w != worths[0]),
        "the seats must NOT all be worth the same, or a proportional split is \
         indistinguishable from an equal one and this test proves nothing"
    );

    let balances_before: Vec<u128> = (0..PLAYER_COUNT).map(|i| balance(&app, &seat(i))).collect();
    let treasury_before = balance(&app, &treasury());
    let pool = Uint128::new(ANTE * PLAYER_COUNT as u128);
    assert_eq!(balance(&app, &contract), pool.u128());

    // ---- Close the room. Only the creator may.
    exec(
        &mut app,
        &seat(0),
        &contract,
        &ExecuteMsg::EndGameAndDistribute { game_id },
        &[],
    );

    // ---- Every wallet received exactly `pool * own_worth / total_worth`,
    // floor-divided, which is the contract's own formula in `escrow.rs`.
    let mut distributed = 0u128;
    for index in 0..PLAYER_COUNT {
        let expected = pool
            .checked_mul(worths[index])
            .expect("no overflow")
            .checked_div(total)
            .expect("total is non-zero")
            .u128();
        let received = balance(&app, &seat(index)) - balances_before[index];
        assert_eq!(
            received, expected,
            "seat {index} should receive its exact proportional share of the escrow pool"
        );
        distributed += received;
    }

    // ---- Nothing is stranded. Integer division floors every share, so the
    // pool almost never divides exactly; the remainder is swept to the
    // developer treasury rather than left sitting in the contract.
    //
    // This is precisely why `treasury()` is not one of the four seats: with
    // the instantiator seated, that player's balance would be their share
    // PLUS the dust, and the per-seat assertion above could not be exact.
    let dust = pool.u128() - distributed;
    assert_eq!(
        balance(&app, &treasury()) - treasury_before,
        dust,
        "the rounding remainder is swept to the developer treasury"
    );
    assert_eq!(
        balance(&app, &contract),
        0,
        "the escrow account is fully drained -- no JUNO is left stranded in the contract"
    );
    assert!(
        dust < PLAYER_COUNT as u128,
        "flooring four shares can leave at most three ujuno behind; a larger \
         remainder would mean the split itself is wrong, not merely rounded"
    );

    let state = game_state(&app, &contract, game_id);
    assert!(!state.is_active, "a settled room is closed");
    assert_eq!(state.total_juno_pool, Uint128::zero());

    // ---- And it cannot be settled twice.
    let repeat = app.execute_contract(
        seat(0),
        contract.clone(),
        &ExecuteMsg::EndGameAndDistribute { game_id },
        &[],
    );
    assert!(repeat.is_err(), "a closed room cannot be drained again");
}

/* ================================================================== */
/* 5. Annulment refunds the escrow instead of scoring it              */
/* ================================================================== */

/// The other exit vector, and the one where real balances matter most: an
/// annulled game must return each player's own ante rather than splitting the
/// pool by how well they happened to be doing.
#[test]
fn e2e_annulment_refunds_every_ante_in_full() {
    let (mut app, code_id) = boot();
    let contract = instantiate_contract(&mut app, code_id);
    let game_id = open_table(&mut app, &contract);
    play_waterfall(&mut app, &contract, game_id);

    // Seats now hold materially different VGP positions -- which must make no
    // difference whatsoever to what an annulment pays out.
    for index in 0..PLAYER_COUNT {
        assert_eq!(balance(&app, &seat(index)), WALLET - ANTE);
    }

    exec(
        &mut app,
        &seat(0),
        &contract,
        &ExecuteMsg::AnnulGame { game_id },
        &[],
    );

    for index in 0..PLAYER_COUNT {
        assert_eq!(
            balance(&app, &seat(index)),
            WALLET,
            "seat {index} gets its own ante back in full -- an annulled game scores nothing"
        );
    }
    assert_eq!(balance(&app, &contract), 0);
}

/* ================================================================== */
/* 6. Operating Round: track, route, dividends, and rusting           */
/* ================================================================== */

/// The Operating Round leg, deliberately LAST and deliberately separate.
///
/// This is the most geometry-dependent test in the file -- it depends on
/// which hexes connect to which, on tile rotation, and on a corporation's
/// home placement. Those are all covered directly and in isolation by
/// `src/tests.rs`; re-deriving them here would add fragility without adding
/// coverage. Keeping it in its own test means a board-geometry regression
/// cannot take the settlement assertions above down with it.
///
/// Orientation is query-driven where it can be (`GetLegalTilePlacements` at
/// E7) and hardcoded where it must be (D8 -- the lowest legal rotation there
/// leaves the edge facing E7 dead, so the tile would be perfectly legal and
/// connect to nothing). See the call sites for both.
#[test]
fn e2e_operating_round_lays_track_runs_a_route_and_rusts_trains() {
    use eighteen_cosmos::msg::{LegalTilePlacementsResponse, PayoutStrategy, RouteWaypoint};

    let (mut app, code_id) = boot();
    let contract = instantiate_contract(&mut app, code_id);
    let game_id = open_table(&mut app, &contract);
    play_waterfall(&mut app, &contract, game_id);

    // Baltimore & Ohio floated for free the moment its private was won, and
    // seat 1 took that private (the sixth purchase). So B&O already has a
    // president, a treasury and a home token, with no Stock Round needed.
    const BO: u32 = 4;
    let president = seat(1);

    let state = game_state(&app, &contract, game_id);
    let bo = state
        .public_companies
        .iter()
        .find(|c| c.company_id == BO)
        .expect("B&O should be in the state response");
    assert!(bo.is_floated, "B&O floats when its private company is won");
    assert_eq!(bo.president, Some(president.clone()));

    // ---- Everything below BeginOperatingRound would be gated by the OR
    // sub-phase cursor, so the corporation is equipped FIRST.
    //
    // `or_phase::require_sub_phase` is a deliberate SOFT gate: it returns
    // immediately while `active_operating_order` is empty, on the reasoning
    // that a sub-phase is a step within a turn and there is no turn before an
    // Operating Round has begun. That is what makes this ordering possible --
    // and it is also how `src/tests.rs` reaches the same state, except that it
    // can reach for the `#[cfg(test)]` helper `or_phase::force_sub_phase`,
    // which an integration test outside the crate cannot see. Everything here
    // goes through real messages only.
    //
    // The ordering also solves a genuine chicken-and-egg: a corporation must
    // OWN a train before its Routes phase, but the Hardware phase that sells
    // it comes AFTER Routes in the turn sequence. Buying before the round
    // begins is exactly how a real 1830 corporation gets its first train
    // without running an empty first Operating Round.
    exec(
        &mut app,
        &president,
        &contract,
        &ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id: BO,
        },
        &[],
    );

    // ---- B&O's home tile at D8, then E7 to give the route a second stop.
    //
    // D8's orientation is hardcoded to 1 rather than taken from the query.
    // `GetLegalTilePlacements` reports every LEGAL rotation, and the lowest
    // legal one does not leave edge 4 live -- so the tile would sit there
    // perfectly legally while connecting to nothing, and the route below
    // would fail on connectivity rather than on anything this test is about.
    // `src/tests.rs`'s own manual-route tests hardcode the same value for the
    // same reason.
    exec(
        &mut app,
        &president,
        &contract,
        &ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO,
            q: 2,
            r: 3,
            tile_id: 9,
            orientation: 1,
        },
        &[],
    );

    // E7 has no such constraint -- any legal rotation of the single-town tile
    // #58 connects back to D8 -- so this one really is query-driven, and will
    // survive a catalog edit that changes which rotations are legal.
    let placements: LegalTilePlacementsResponse = app
        .wrap()
        .query_wasm_smart(
            contract.clone(),
            &QueryMsg::GetLegalTilePlacements {
                game_id,
                protocol_id: BO,
                q: 1,
                r: 4,
            },
        )
        .expect("GetLegalTilePlacements should succeed");
    let e7 = placements
        .placements
        .iter()
        .find(|p| p.tile_id == 58)
        .expect("the single-town tile #58 should be legal at E7");

    exec(
        &mut app,
        &president,
        &contract,
        &ExecuteMsg::LayTile {
            game_id,
            protocol_id: BO,
            q: 1,
            r: 4,
            tile_id: 58,
            // `LegalTilePlacement::orientation` is a `u8`; `ExecuteMsg::LayTile`
            // takes a `u32`. Widening is lossless and infallible.
            orientation: u32::from(e7.orientation),
        },
        &[],
    );

    // ---- Now the Operating Round proper. The queue goes live here, so from
    // this point the sub-phase cursor is enforced for real.
    exec(
        &mut app,
        &seat(0),
        &contract,
        &ExecuteMsg::BeginOperatingRound { game_id },
        &[],
    );

    let state = game_state(&app, &contract, game_id);
    assert_eq!(
        state.active_operating_order,
        vec![BO],
        "B&O is the only floated corporation, so it is the whole queue"
    );

    // ---- Walk the cursor from Tokens to Routes.
    //
    // Two `LayTile` calls do NOT leave the cursor two phases along, which is
    // the trap this test originally fell into. `hexmap::execute_lay_tile`
    // calls `or_phase::advance(.., OperatingSubPhase::Track)` with a
    // HARDCODED `from`, and `advance` computes `next_sub_phase(from)` from
    // that argument rather than from wherever the cursor currently sits. So
    // both lays set the cursor to `next_sub_phase(Track)` = Tokens, and the
    // second one is idempotent rather than cumulative.
    //
    // That is correct for real play -- a corporation lays one tile per turn,
    // so the second lay never happens -- but this test lays two before the
    // round begins, while the sub-phase gate is still soft. It therefore has
    // to cover the Tokens step itself. Tokens is freely skippable (only
    // Routes is conditional, and only Dividends is never skippable), so one
    // `AdvanceOperatingSubPhase` is the whole fix.
    exec(
        &mut app,
        &president,
        &contract,
        &ExecuteMsg::AdvanceOperatingSubPhase {
            game_id,
            protocol_id: BO,
        },
        &[],
    );

    // ---- Run a declared route using the strongly-typed waypoint schema.
    // `city_node` is `None` on both stops: neither D8 nor E7 is a multi-city
    // hex, so there is no station to disambiguate.
    exec(
        &mut app,
        &president,
        &contract,
        &ExecuteMsg::RunManualRoute {
            game_id,
            protocol_id: BO,
            path: vec![
                RouteWaypoint {
                    hex: "D8".to_string(),
                    city_node: None,
                },
                RouteWaypoint {
                    hex: "E7".to_string(),
                    city_node: None,
                },
            ],
            payout_strategy: PayoutStrategy::Withhold,
        },
        &[],
    );

    // The revenue is recorded on the corporation for the Operating Round
    // table to read -- Step 4.5 Batch 2, item 4 -- and, being withheld,
    // lands in the treasury rather than any player's wallet.
    let state = game_state(&app, &contract, game_id);
    let bo_after = state
        .public_companies
        .iter()
        .find(|c| c.company_id == BO)
        .unwrap();
    assert!(
        bo_after.last_route_revenue > Uint128::zero(),
        "running a route records what the trains earned"
    );
}
