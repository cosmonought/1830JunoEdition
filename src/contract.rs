//! Execution logic for the 18Cosmos hybrid-economy game contract.
//!
//! Design notes / assumptions made explicit here because they aren't fully
//! pinned down by `msg.rs` / `state.rs` alone:
//!
//! 1. `InstantiateMsg` carries no admin/treasury address, only
//!    `subsidy_fee_percentage`. The instantiator (`info.sender`) is stored as
//!    `GameConfig::developer_treasury`. If a dedicated treasury multisig is
//!    desired, extend `InstantiateMsg` with an explicit address field and
//!    validate it with `deps.api.addr_validate`.
//! 2. `subsidy_fee_percentage` is expressed in basis points (1/100 of a
//!    percent), matching the doc comment in `msg.rs` ("50 for 0.5%"), i.e. the
//!    fee fraction is `subsidy_fee_percentage / 10_000`.
//! 3. The real-money asset is Juno's native token, `ujuno` (see
//!    `juno_developer_spec.md`). It is hardcoded as `NATIVE_DENOM` since
//!    `state.rs` does not store a configurable denom.
//! 4. Per the project rules ("Dedicate a small, configurable percentage fee
//!    from game lobby creation deposits..."), the subsidy is deducted from
//!    EVERY real-JUNO deposit into a room -- `CreateGameRoom` and
//!    `JoinGameRoom` alike, at the identical rate and rounding, via the
//!    shared `subsidy_cut` helper (Audit G-11; entry deposits used to flow
//!    in untaxed). Only the net reaches the lobby pool that gets redeemed
//!    proportionally at game end, and `AnnulGame` correspondingly refunds
//!    each player NET of their own cut -- see design note #13. Since Step
//!    4.5 Batch 3 the deposit-splitting itself lives in `escrow.rs`
//!    (`split_deposit`/`subsidy_cut`); this module only decides WHEN a
//!    deposit is taken, never how it divides.
//!    **Uniform Ante Rule:** every joining
//!    player must attach exactly the same amount the room's creator
//!    deposited at creation -- not merely a nonzero amount, and no longer
//!    optional -- or the join is rejected with
//!    `ContractError::InvalidAnteAmount` (see `execute_join_game_room`'s
//!    doc comment). This also means every entry in `PLAYER_JUNO_ANTE` for a
//!    given `game_id` is now identical.
//! 5. `EndGameAndDistribute` may only be called by the room's creator (the
//!    "Validator" of the lobby). Each player's final VGP net worth used for
//!    the proportional split is computed automatically on-chain, from this
//!    room's own ledger -- `PLAYER_CASH_VGP`, plus the live market value of
//!    every `PLAYER_SHARES` holding priced off that protocol's current
//!    `PROTOCOL_MARKET` cell, plus the face value of every unclosed private
//!    company the player still owns (see `appraise_player_net_worth`, the
//!    single shared appraiser) -- never
//!    accepted as caller-submitted input. This closes a payout-integrity
//!    gap: an earlier version of this handler trusted a client-submitted
//!    `final_player_points` list directly, with no on-chain check that
//!    those numbers matched the room's actual state, meaning a buggy or
//!    malicious client -- not this contract's own ledger -- decided how
//!    the real JUNO pool split.
//! 6. All pool-redemption math uses checked `Uint128` arithmetic exclusively
//!    (no floats, per project rules). Integer division during the
//!    proportional split can leave a small remainder ("dust") in the pool;
//!    that dust is swept to the developer treasury so no funds are ever
//!    silently stranded in contract state.
//! 7. `CreateGameRoom` also seeds the room's Private Auctions phase (see
//!    `auction.rs`) via `auction::spawn_core_private_companies`, the
//!    unfloated public-corporation roster (see `public_company.rs`) via
//!    `public_company::spawn_core_public_companies`, and the global
//!    Hardware (train) supply (see `hardware.rs`) via
//!    `hardware::spawn_hardware_pool`, since a room activates -- and so
//!    should have all three available -- as soon as it's created.
//! 8. `ExecuteOperatingRound` (see `operations.rs`) is authorized like
//!    `EndGameAndDistribute`: only the room's `creator` may call it, since
//!    it's a single batched action covering every private and listed
//!    public company at once, rather than a per-company action a single
//!    president could authorize. Public company revenue is computed
//!    automatically by the Pathfinding Revenue Engine (see
//!    `pathfinding.rs`) rather than supplied by the caller -- only which
//!    floated companies run this round, and each one's distribute/retain
//!    choice, still comes from the message. `BeginOperatingRound` is
//!    authorized identically (creator-only) and, like
//!    `ExecuteOperatingRound`, is deliberately not recorded to `GAME_LOG`
//!    (see `gamelog.rs`'s module doc comment #2) -- it populates the
//!    separate, sequential Operating Round Corporation Turn Queue that
//!    `LayTile`/`BuyHardwareFromPool`/`DeclareDividends` now additionally
//!    check (see `operations.rs`'s module doc comment for the full design).
//! 9. `LayTile` (see `hexmap.rs`) is authorized per-company, like
//!    `DeclareDividends`: only the target protocol's registered
//!    `PROTOCOL_PRESIDENT` may lay tiles for it, and terrain cost is paid
//!    from that company's own treasury, not the room creator or any
//!    player's personal cash.
//! 10. `BuyHardwareFromPool` (see `hardware.rs`) is authorized the same
//!     way as `LayTile`: only the target protocol's registered
//!     `PROTOCOL_PRESIDENT`, paid from that company's treasury. It also
//!     may trigger a global, cross-company Rusting sweep as a side effect
//!     -- see `hardware::RUST_TRIGGERS`.
//! 11. `EmergencyBuyHardware` (see `hardware.rs`) implements rules.md's
//!     Validator Liability rule: only usable when the company owns zero
//!     Hardware and its treasury alone can't afford the next pool unit,
//!     topping up the shortfall from the President's own personal VGP. If
//!     even that combined total can't cover it, the call *succeeds* (not
//!     an error) but durably halts the session: `GameSession::is_active`
//!     is flipped to `false` and saved, and the response carries a
//!     dedicated `bankruptcy` event -- see `hardware.rs` module doc
//!     comment #7 for why an `Err` return couldn't achieve a durable halt
//!     under CosmWasm's atomic-revert rules.
//! 12. `query` (see `query.rs`) is this contract's separate, read-only
//!     entry point -- the Game State Query messages. It has no
//!     authorization checks at all (every `QueryMsg` variant just reads
//!     `game_id`'s already-public on-chain state) and returns plain
//!     `StdResult<Binary>` rather than `Result<Response, ContractError>`,
//!     matching the standard CosmWasm convention that queries can't emit
//!     events, messages, or state writes -- only data.
//! 13. `AnnulGame` (Step 4.5 Batch 3, items 2/3 -- replaces the narrower
//!     `ClaimTimeoutRefund`) is the abort vector, and is callable by the
//!     room's creator at ANY time or by any currently registered player once
//!     48 hours have elapsed. Unlike `EndGameAndDistribute` it scores
//!     nothing: an abandoned or called-off game produced no result, so the
//!     proportional split is bypassed entirely and each player simply gets
//!     their money back. It refunds each player their own original
//!     real-JUNO ante
//!     (`state::PLAYER_JUNO_ANTE`, populated at `CreateGameRoom`/
//!     `JoinGameRoom` deposit time) NET of the developer subsidy that was
//!     taken from it -- never a proportional split of the pool. The net is
//!     what actually reached the pool, so the refunds sum to exactly
//!     `total_juno_pool` and a room can never overdraw the contract
//!     (Audit G-11). Payable only once `env.block.time.seconds()` has passed
//!     `GameSession::last_action_timestamp + INACTIVITY_TIMEOUT_SECONDS`
//!     (48 hours since the room's last qualifying state-advancing action --
//!     see `state.rs`'s `GameSession::last_action_timestamp` doc comment).
//!     Like `CreateGameRoom`/`JoinGameRoom`/`EndGameAndDistribute`, it moves
//!     real JUNO via `BankMsg` and so is deliberately not recorded to
//!     `GAME_LOG` (`gamelog.rs`'s module doc comment #2).

// `BankMsg`/`Coin` are deliberately absent: after the Step 4.5 Batch 3
// escrow extraction, this module no longer constructs a single token
// transfer itself. Every `BankMsg` in the contract is now built inside
// `escrow.rs`, which is the point of the split.
use cosmwasm_std::{
    to_json_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdError, StdResult,
    Uint128,
};
use thiserror::Error;

#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;

use crate::auction::{self, AuctionError};
use crate::escrow;
use crate::gamelog::{self, GameLogError};
use crate::hardware::{self, HardwareError};
use crate::hexmap::{self, HexMapError};
use crate::market::{self, MarketError};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::operations::{self, OperationsError};
use crate::public_company;
use crate::train_trade::{self, TrainTradeError};
use crate::query;
use crate::state::{
    ActionRecord, GameConfig, GameSession, PrivateCompany, RoundType, TileColor, CONFIG,
    NEXT_GAME_ID, PLAYER_CASH_VGP, PLAYER_JUNO_ANTE, PLAYER_SHARES, PRIVATE_COMPANIES, SESSIONS,
};
use crate::trading::{self, TradingError};
use crate::waterfall::{self, WaterfallError};

// ===================================================================
// Step 4.5 Batch 3: real-JUNO handling now lives in `escrow.rs`.
//
// These four constants are RE-EXPORTED rather than moved-and-forgotten so
// that `contract::NATIVE_DENOM` and friends keep resolving for every
// existing caller -- the test suite, and the frontend's generated schema,
// both name them through this module. `escrow.rs` is their definition site;
// this is an alias, and there is only ever one value.
// ===================================================================
pub use crate::escrow::{
    BPS_DENOMINATOR, INACTIVITY_TIMEOUT_SECONDS, MINIMUM_ANTE, NATIVE_DENOM,
};

// Same reasoning: `trading.rs`, `operations.rs` and `hardware.rs` all reach
// the $350 Game-End Trigger through `crate::contract::finalize_and_distribute_payouts`.
// Re-exporting keeps those four call sites working unchanged while the
// definition sits with the rest of the payout machinery.
pub(crate) use crate::escrow::finalize_and_distribute_payouts;

/// Total starting VGP capital pool, split evenly across a room's declared
/// `GameSession::max_players` (the classic 1830 endowment: $1200 for 2
/// players, $600 for 4, etc. -- all of which divide this same $2400 total
/// evenly). This is minted fresh into `PLAYER_CASH_VGP` -- for the creator
/// immediately in `execute_create_game_room`, for everyone else in
/// `execute_join_game_room` -- separate from and in addition to
/// `GameSession::virtual_bank_vgp` (the bank pool set at room creation).
pub const STARTING_CAPITAL_POOL: Uint128 = Uint128::new(2_400);

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Market(#[from] MarketError),

    #[error("{0}")]
    Trading(#[from] TradingError),

    #[error("{0}")]
    Auction(#[from] AuctionError),

    #[error("{0}")]
    Operations(#[from] OperationsError),

    /// Audit G-15: corporation-to-corporation train sales.
    #[error("{0}")]
    TrainTrade(#[from] TrainTradeError),

    #[error("{0}")]
    HexMap(#[from] HexMapError),

    #[error("{0}")]
    Hardware(#[from] HardwareError),

    #[error("{0}")]
    GameLog(#[from] GameLogError),

    #[error("{0}")]
    Waterfall(#[from] WaterfallError),

    #[error("Unauthorized: only the game room creator may perform this action")]
    Unauthorized {},

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error("Player {player} has already joined game room {game_id}")]
    AlreadyJoined { game_id: u64, player: String },

    #[error("subsidy_fee_percentage must not exceed {BPS_DENOMINATOR} basis points (100%)")]
    InvalidSubsidyFee {},

    #[error("virtual_bank_start must be greater than zero")]
    InvalidVirtualBankStart {},

    #[error("max_players must be between 2 and 6 inclusive")]
    InvalidMaxPlayers {},

    #[error(
        "Game room {game_id} already has its declared max_players and cannot accept more joins"
    )]
    RoomFull { game_id: u64 },

    #[error("Deposit must include exactly one coin of denom '{expected_denom}'")]
    InvalidDeposit { expected_denom: String },

    #[error("Deposit amount must be greater than zero")]
    ZeroDeposit {},

    /// **Step 4.5 Batch 3, item 4: the Ante Floor.** The deposit opening a
    /// room was below `escrow::MINIMUM_ANTE`. Deliberately DISTINCT from
    /// `InvalidAnteAmount` just below, which is the Uniform Ante Rule's
    /// exact-match check on a JOINER. The two fail for genuinely different
    /// reasons -- "you did not stake enough to open a table anyone could
    /// finish" versus "you did not match this table's stake" -- and a client
    /// needs to tell them apart to say anything useful to the player.
    #[error(
        "A deposit of at least {minimum} ujuno is required to open a game room; {got} ujuno was attached"
    )]
    InsufficientAnte { minimum: Uint128, got: Uint128 },

    #[error(
        "Game room {game_id} requires an ante of exactly {expected} ujuno to join, matching the room creator's own deposit; {got} ujuno was attached instead"
    )]
    InvalidAnteAmount {
        game_id: u64,
        expected: Uint128,
        got: Uint128,
    },

    #[error("{player} is not a registered player in game room {game_id}")]
    NotAPlayer { game_id: u64, player: String },

    #[error(
        "Game room {game_id} has had a qualifying action within the last {timeout_seconds} seconds; only the room creator may annul it before that window elapses"
    )]
    TimeoutNotYetElapsed { game_id: u64, timeout_seconds: u64 },

    #[error("Arithmetic overflow/underflow while computing subsidy or payout amounts")]
    Overflow {},
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if (msg.subsidy_fee_percentage as u128) > BPS_DENOMINATOR {
        return Err(ContractError::InvalidSubsidyFee {});
    }

    // No dedicated treasury address is supplied on InstantiateMsg, so the
    // instantiating address is designated as the developer treasury. See
    // module-level doc comment (assumption #1).
    let config = GameConfig {
        developer_treasury: info.sender.clone(),
        subsidy_fee_percentage: msg.subsidy_fee_percentage,
    };
    CONFIG.save(deps.storage, &config)?;
    NEXT_GAME_ID.save(deps.storage, &1u64)?;

    // MARKET_GRID is shared globally across every game room (it isn't
    // keyed by game_id), so it only ever needs seeding once, here, rather
    // than per-room -- see `market::seed_default_price_grid`'s doc comment.
    market::seed_default_price_grid(deps.storage)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("developer_treasury", config.developer_treasury)
        .add_attribute(
            "subsidy_fee_percentage",
            config.subsidy_fee_percentage.to_string(),
        ))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::CreateGameRoom {
            virtual_bank_start,
            max_players,
        } => execute_create_game_room(deps, env, info, virtual_bank_start, max_players),
        ExecuteMsg::JoinGameRoom { game_id } => execute_join_game_room(deps, env, info, game_id),
        ExecuteMsg::EndGameAndDistribute { game_id } => {
            escrow::execute_end_game_and_distribute(deps, env, info, game_id)
        }
        // The six arms below are the Event-Sourced Ledger's "loggable" set
        // (see `gamelog.rs` module doc comment #1): each dispatches to its
        // pre-existing handler exactly as before via `deps.branch()`, and --
        // only once that handler has actually succeeded -- appends the
        // equivalent `ActionRecord` to `GAME_LOG` before returning the
        // handler's own `Response` untouched. Logging strictly after success
        // means a reverted (`Err`) call never pollutes the log, since
        // CosmWasm's atomic-revert semantics mean neither the handler's
        // writes nor this arm's `record_action` write are ever committed on
        // an `Err` return.
        ExecuteMsg::BuyStock {
            game_id,
            protocol_id,
            source,
            par_value,
            quantity,
        } => {
            let response = trading::execute_buy_stock(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                protocol_id,
                source,
                par_value,
                quantity,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::BuyStock {
                    player: info.sender,
                    protocol_id,
                    source,
                    par_value,
                    // Step 4.5 Batch 1, item 1: the quantity is recorded
                    // verbatim so `reapply_game_log` re-buys the same block
                    // in one action rather than replaying it as N separate
                    // single purchases -- which would matter, since a
                    // multi-buy's certificates all settle at one price.
                    quantity,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::SellStock {
            game_id,
            protocol_id,
            percentage,
        } => {
            let response = trading::execute_sell_stock(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                protocol_id,
                percentage,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::SellStock {
                    player: info.sender,
                    protocol_id,
                    percentage,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::DeclareDividends {
            game_id,
            protocol_id,
            revenue_amount,
            distribute,
        } => {
            let response = trading::execute_declare_dividends(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                protocol_id,
                revenue_amount,
                distribute,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::DeclareDividends {
                    player: info.sender,
                    protocol_id,
                    revenue_amount,
                    distribute,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::BidOnPrivate {
            game_id,
            private_id,
            bid_amount,
        } => {
            let response = auction::execute_bid_on_private(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                private_id,
                bid_amount,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::BidOnPrivate {
                    player: info.sender,
                    private_id,
                    bid_amount,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::BuyPrivateCompany {
            game_id,
            protocol_id,
            private_id,
            price,
        } => {
            let response = trading::execute_buy_private_company(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                protocol_id,
                private_id,
                price,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::BuyPrivateCompany {
                    player: info.sender,
                    protocol_id,
                    private_id,
                    price,
                },
            )?;
            Ok(response)
        }
        // Not recorded to `GAME_LOG` -- see `operations.rs`'s module doc
        // comment (design note #10) and `gamelog.rs`'s module doc comment
        // #2, for the same reasons `ExecuteOperatingRound` isn't either.
        ExecuteMsg::BeginOperatingRound { game_id } => {
            operations::execute_begin_operating_round(deps, env, info, game_id).map_err(Into::into)
        }
        // Not recorded to `GAME_LOG`, for the same reasons `BeginOperatingRound`
        // immediately above isn't -- see `operations.rs`'s module doc comment
        // (design note #10).
        ExecuteMsg::EndOperatingRoundTurn {
            game_id,
            protocol_id,
        } => operations::execute_end_operating_round_turn(deps, env, info, game_id, protocol_id)
            .map_err(Into::into),
        // Manual Route Validation -- not recorded to `GAME_LOG`, for the
        // same reasons `ExecuteOperatingRound` isn't (see
        // `operations.rs`'s module doc comment #13 / `gamelog.rs`'s module
        // doc comment #2): this message's revenue depends on live
        // `MAP_GRID`/`COMPANY_HARDWARE` state that a later replay can't
        // safely re-derive.
        ExecuteMsg::RunManualRoute {
            game_id,
            protocol_id,
            path,
            payout_strategy,
        } => operations::execute_run_manual_route(
            deps,
            env,
            info,
            game_id,
            protocol_id,
            path,
            payout_strategy,
        )
        .map_err(Into::into),
        ExecuteMsg::LayTile {
            game_id,
            protocol_id,
            q,
            r,
            tile_id,
            orientation,
        } => {
            let response = hexmap::execute_lay_tile(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                protocol_id,
                q,
                r,
                tile_id,
                orientation,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::LayTile {
                    player: info.sender,
                    protocol_id,
                    q,
                    r,
                    tile_id,
                    orientation,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::BuyTrainFromCorporation {
            game_id,
            buyer_protocol_id,
            seller_protocol_id,
            model_type,
            price,
        } => {
            let response = train_trade::execute_buy_train_from_corporation(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                buyer_protocol_id,
                seller_protocol_id,
                model_type.clone(),
                price,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::BuyTrainFromCorporation {
                    player: info.sender,
                    buyer_protocol_id,
                    seller_protocol_id,
                    model_type,
                    price,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::AcceptTrainOffer { game_id, offer_id } => {
            let response = train_trade::execute_accept_train_offer(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                offer_id,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::AcceptTrainOffer {
                    player: info.sender,
                    offer_id,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::RejectTrainOffer { game_id, offer_id } => {
            let response = train_trade::execute_reject_train_offer(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                offer_id,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::RejectTrainOffer {
                    player: info.sender,
                    offer_id,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::RescindTrainOffer { game_id, offer_id } => {
            let response = train_trade::execute_rescind_train_offer(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                offer_id,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::RescindTrainOffer {
                    player: info.sender,
                    offer_id,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::AdvanceOperatingSubPhase {
            game_id,
            protocol_id,
        } => {
            let response = operations::execute_advance_operating_sub_phase(
                deps.branch(),
                info.clone(),
                game_id,
                protocol_id,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::AdvanceOperatingSubPhase {
                    player: info.sender,
                    protocol_id,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::PlaceStationToken {
            game_id,
            protocol_id,
            q,
            r,
            city_index,
        } => {
            let response = hexmap::execute_place_station_token(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                protocol_id,
                q,
                r,
                city_index,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::PlaceStationToken {
                    player: info.sender,
                    protocol_id,
                    q,
                    r,
                    city_index,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::BuyHardwareFromPool {
            game_id,
            protocol_id,
        } => {
            let response = hardware::execute_buy_hardware_from_pool(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                protocol_id,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::BuyHardwareFromPool {
                    player: info.sender,
                    protocol_id,
                },
            )?;
            Ok(response)
        }
        ExecuteMsg::EmergencyBuyHardware {
            game_id,
            protocol_id,
        } => hardware::execute_emergency_buy_hardware(deps, env, info, game_id, protocol_id)
            .map_err(Into::into),
        // `PassTurn` records its own `ActionRecord` internally (it's a
        // turn-pointer mutation, not a call to a pre-existing handler), and
        // `UndoLastAction` pops the log and replays it -- see `gamelog.rs`.
        ExecuteMsg::PassTurn { game_id } => {
            gamelog::execute_pass_turn(deps, env, info, game_id).map_err(Into::into)
        }
        ExecuteMsg::UndoLastAction { game_id } => {
            gamelog::execute_undo_last_action(deps, env, info, game_id).map_err(Into::into)
        }
        // Step 4.5 Batch 3, items 2/3. Not recorded to `GAME_LOG` -- like
        // `CreateGameRoom`/`JoinGameRoom`/`EndGameAndDistribute`, this moves
        // real JUNO via `BankMsg`, which the Event-Sourced Ledger
        // deliberately excludes (see `gamelog.rs`'s module doc comment #2).
        //
        // This arm replaced `ClaimTimeoutRefund`, which was a narrower
        // version of the same thing (timeout only, no creator path). One
        // abort vector, so the refund rules cannot drift between two
        // handlers -- see `escrow.rs`'s module doc comment.
        ExecuteMsg::AnnulGame { game_id } => {
            escrow::execute_annul_game(deps, env, info, game_id)
        }
        // Pre-Game Waterfall Auction actions -- none of these five are
        // recorded to `GAME_LOG`/given an `ActionRecord` variant, for the
        // same reasons `BeginOperatingRound`/`ExecuteOperatingRound` aren't
        // (see `gamelog.rs`'s module doc comment #2 and `waterfall.rs`'s
        // own module doc comment #6): the Waterfall Cascade's automatic,
        // multi-step resolution side effects can't be safely reconstructed
        // by a later replay.
        ExecuteMsg::WaterfallBuyLowest { game_id } => {
            waterfall::execute_waterfall_buy_lowest(deps, env, info, game_id).map_err(Into::into)
        }
        ExecuteMsg::WaterfallBidHigher {
            game_id,
            private_id,
            bid_amount,
        } => waterfall::execute_waterfall_bid_higher(
            deps, env, info, game_id, private_id, bid_amount,
        )
        .map_err(Into::into),
        ExecuteMsg::WaterfallPass { game_id } => {
            waterfall::execute_waterfall_pass(deps, env, info, game_id).map_err(Into::into)
        }
        ExecuteMsg::WaterfallMiniAuctionRaise {
            game_id,
            bid_amount,
        } => waterfall::execute_waterfall_mini_auction_raise(deps, env, info, game_id, bid_amount)
            .map_err(Into::into),
        ExecuteMsg::WaterfallMiniAuctionPass { game_id } => {
            waterfall::execute_waterfall_mini_auction_pass(deps, env, info, game_id)
                .map_err(Into::into)
        }
    }
}

/// Game State Query entry point: dispatches each `QueryMsg` variant to its
/// assembly function in `query.rs` and serializes the result. Every
/// handler here is read-only and returns `StdResult<Binary>`, per the
/// standard CosmWasm `query` convention -- see `query.rs`'s module doc
/// comment for why these don't use a dedicated `thiserror` error enum the
/// way every `execute_*` module does.
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetGameState { game_id } => {
            to_json_binary(&query::query_game_state(deps, game_id)?)
        }
        QueryMsg::GetMarketGrid { game_id } => {
            to_json_binary(&query::query_market_grid(deps, game_id)?)
        }
        QueryMsg::GetMapGrid { game_id } => to_json_binary(&query::query_map_grid(deps, game_id)?),
        QueryMsg::GetTrainOffers { game_id } => {
            to_json_binary(&query::query_train_offers(deps, game_id)?)
        }
        QueryMsg::GetMapGridMarkdown { game_id } => {
            to_json_binary(&query::query_map_grid_markdown(deps, game_id)?)
        }
        QueryMsg::GetLegalTilePlacements {
            game_id,
            protocol_id,
            q,
            r,
        } => to_json_binary(&query::query_legal_tile_placements(
            deps,
            game_id,
            protocol_id,
            q,
            r,
        )?),
        QueryMsg::PlayerNetWorth {
            game_id,
            wallet_address,
        } => to_json_binary(&query::query_player_net_worth(deps, game_id, wallet_address)?),
        QueryMsg::GetWaterfallState { game_id } => {
            to_json_binary(&query::query_waterfall_state(deps, game_id)?)
        }
    }
}

/// Creates a new game lobby, taxes the incoming real-JUNO deposit with the
/// configured developer subsidy, and seeds the lobby's virtual game points.
///
/// Also immediately provisions the creator (who is always the room's first
/// player -- see `session.player_addresses` below) with their starting VGP
/// capital: `STARTING_CAPITAL_POOL / max_players`, fixed for the room's
/// entire life. See `execute_join_game_room`'s doc comment for why this
/// replaced an earlier scheme that divided by the headcount *at join time*
/// (which could never give every player the same starting amount).
fn execute_create_game_room(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    virtual_bank_start: Uint128,
    max_players: u8,
) -> Result<Response, ContractError> {
    if virtual_bank_start.is_zero() {
        return Err(ContractError::InvalidVirtualBankStart {});
    }
    if !(2..=6).contains(&max_players) {
        return Err(ContractError::InvalidMaxPlayers {});
    }

    let config = CONFIG.load(deps.storage)?;

    // Exactly one non-zero coin of the native denom, split into the
    // developer subsidy and the net that reaches the pool -- one shared
    // intake path with room ENTRY below, so a deposit can never be valued
    // one way here and another there (Audit G-11, now `escrow::split_deposit`).
    let deposit = escrow::split_deposit(&info, config.subsidy_fee_percentage)?;
    let deposit_amount = deposit.gross;
    let subsidy_amount = deposit.subsidy;
    let net_pool_amount = deposit.net_pool;

    // Step 4.5 Batch 3, item 4: the Ante Floor. Checked on the GROSS
    // deposit, before the subsidy is taken -- the floor is about what a
    // player must actually stake to open a table, not what survives the fee.
    //
    // Checked HERE and nowhere else, because this deposit becomes the room's
    // `room_ante` and every joiner is then held to it exactly; clearing the
    // floor once at creation transitively guarantees it for the whole table.
    // See `escrow::MINIMUM_ANTE` for why the real, gas-aware figure is the
    // frontend's job and this is only a safety net.
    escrow::require_minimum_ante(deposit_amount)?;

    let game_id = NEXT_GAME_ID.load(deps.storage)?;
    let next_game_id = game_id.checked_add(1).ok_or(ContractError::Overflow {})?;

    let session = GameSession {
        game_id,
        creator: info.sender.clone(),
        total_juno_pool: net_pool_amount,
        // Step 4.5 Batch 3, item 4: the GROSS deposit, not the net. The
        // Uniform Ante Rule compares what a player actually sends, not what
        // survives the subsidy -- see `execute_join_game_room`.
        room_ante: deposit_amount,
        virtual_bank_vgp: virtual_bank_start,
        // Immutable genesis baseline `reapply_game_log` resets
        // `virtual_bank_vgp` back to on every `UndoLastAction` replay --
        // see `gamelog.rs`.
        virtual_bank_start,
        is_active: true,
        player_addresses: vec![info.sender.clone()],
        max_players,
        // Turn Priority Queue pointers: both start at the room's first
        // player / index 0. See `gamelog::execute_pass_turn` and
        // `msg.rs`'s `PassTurn` doc comment for how far turn-order
        // enforcement currently reaches.
        active_player_index: 0,
        priority_deal_index: 0,
        // Step 4.5 Batch 4: no Stock Round has begun, so nobody has acted.
        last_active_player_index: None,
        consecutive_passes: 0,
        // Tech Era Color-Locking (see `hexmap.rs`'s module doc comment
        // #8): every room starts with only Yellow tiles unlocked.
        current_global_era: TileColor::Yellow,
        // Operating Round Corporation Turn Queue (see `operations.rs`'s
        // module doc comment): empty until `BeginOperatingRound` first
        // populates it -- see `active_operating_order`'s doc comment in
        // `state.rs` for what an empty queue means for turn enforcement.
        active_operating_order: Vec::new(),
        active_corporation_index: 0,
        // Inactivity Timeout Safety Valve (see `state.rs`'s
        // `GameSession::last_action_timestamp` doc comment): the room's
        // 48-hour inactivity clock starts ticking from the moment it's
        // created.
        last_action_timestamp: env.block.time.seconds(),
        // Macro Round Tracker (see `state.rs`'s `RoundType`/`GameSession`
        // doc comments, and `operations.rs`'s module doc comment #11):
        // every room genesis now starts in the Pre-Game Waterfall Auction
        // (see `waterfall.rs`), not directly in Stock Round 1 -- the six
        // core private companies must be fully allocated first.
        // `macro_round_number`/`sub_round_index`/
        // `operating_round_sequence_length` stay seeded for SR1's eventual
        // start, exactly as before.
        current_round_type: RoundType::WaterfallAuction,
        macro_round_number: 1,
        sub_round_index: 0,
        operating_round_sequence_length: 0,
        // Deferred Bank-Break Halt (see `state.rs`'s own doc comment): every
        // room genesis starts with a full, unbroken bank.
        bank_is_broken: false,
        // Pre-Game Waterfall Auction (see `waterfall.rs`'s module doc
        // comment and `state.rs`'s own field doc comments): every room
        // genesis starts with the waterfall active, a clean pass streak,
        // and no private yet won.
        waterfall_auction_active: true,
        consecutive_waterfall_passes: 0,
        last_private_winner: None,
    };
    SESSIONS.save(deps.storage, game_id, &session)?;
    NEXT_GAME_ID.save(deps.storage, &next_game_id)?;

    // The creator is registered as the room's first player above, so they
    // get the same fixed starting capital every other joiner will.
    let starting_cash = STARTING_CAPITAL_POOL
        .checked_div(Uint128::new(u128::from(max_players)))
        .map_err(|_| ContractError::Overflow {})?;
    PLAYER_CASH_VGP.save(deps.storage, (game_id, info.sender.clone()), &starting_cash)?;

    // Inactivity Timeout Safety Valve refund ledger (see
    // `state::PLAYER_JUNO_ANTE`'s doc comment): records exactly what the
    // creator personally deposited, so `escrow::execute_annul_game` can
    // send it back to them specifically if the room is ever abandoned.
    PLAYER_JUNO_ANTE.save(
        deps.storage,
        (game_id, info.sender.clone()),
        &deposit_amount,
    )?;

    // The Private Auctions phase is the true start of the session: seed the
    // room with the fixed core private companies as soon as it activates,
    // alongside the (unfloated) public corporation roster they eventually
    // convert into.
    auction::spawn_core_private_companies(deps.storage, game_id)?;
    public_company::spawn_core_public_companies(deps.storage, game_id)?;
    hardware::spawn_hardware_pool(deps.storage, game_id)?;

    // Tile Inventory Supply Engine (Audit G-5): give this room its own
    // full, finite tile tray -- one entry per `hexmap::TILE_CATALOG` tile,
    // seeded at that tile's real printed 1830 quantity. Keyed by `game_id`
    // like every other per-room registry, so concurrently running rooms
    // never draw from each other's supply.
    hexmap::seed_tile_inventory(deps.storage, game_id)?;

    // Give this room its own, independent market-marker positions for
    // every core public company -- keyed by (game_id, protocol_id), so a
    // second room trading the same protocol_id (e.g. two concurrent games
    // both running a PRR) never shares or clobbers this room's price
    // markers. See `market::initialize_game_market`'s doc comment.
    let core_public_company_ids: Vec<u32> = public_company::CORE_PUBLIC_COMPANIES
        .iter()
        .map(|(company_id, _ticker)| *company_id)
        .collect();
    market::initialize_game_market(deps.storage, game_id, &core_public_company_ids)?;

    let mut response = Response::new()
        .add_attribute("action", "create_game_room")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("creator", info.sender)
        .add_attribute("deposit_amount", deposit_amount)
        .add_attribute("subsidy_amount", subsidy_amount)
        .add_attribute("net_juno_pool", net_pool_amount)
        .add_attribute("virtual_bank_start", virtual_bank_start)
        .add_attribute("max_players", max_players.to_string())
        .add_attribute("starting_cash_vgp", starting_cash);

    // Route the subsidy cut to the developer treasury for gas-fee grants.
    // Built by `escrow::subsidy_transfer`, which returns `None` for a
    // zero cut -- a chain rejects a `BankMsg::Send` carrying no coins.
    if let Some(transfer) = escrow::subsidy_transfer(&config.developer_treasury, subsidy_amount) {
        response = response.add_message(transfer);
    }

    Ok(response)
}

/// Registers a new player against an active game room. Any real JUNO
/// attached to the join transaction flows untaxed into the lobby pool
/// (the developer subsidy applies only to room-creation deposits).
///
/// Also provisions the joining player with starting VGP capital:
/// `STARTING_CAPITAL_POOL / session.max_players` -- a *fixed* figure set
/// once at `CreateGameRoom` time, not recomputed from the current
/// headcount. **This replaced an earlier scheme** that divided by
/// `player_addresses.len()` *at the moment each player joined*, which
/// meant the 1st, 2nd, 3rd, and 4th players to join a 4-player game each
/// got a *different* starting amount ($1200, $800, $600, $480) instead of
/// everyone getting the same $600 -- caught while writing this contract's
/// first test (`tests.rs`), which asserts every player receives an equal
/// share. Rejects the join once the room already holds `max_players`
/// players (`ContractError::RoomFull`).
///
/// **Uniform Ante Rule.** Every player at a given table must ante the exact
/// same real-JUNO amount the room's creator deposited at `CreateGameRoom`
/// time -- attaching any other amount (including no funds at all, or a
/// merely close amount) is rejected outright with
/// `ContractError::InvalidAnteAmount`, down to the last `ujuno`. This
/// replaced an earlier design where a join deposit was optional and could
/// be any amount (or zero); that design is what `optional_native_deposit`
/// implemented and is now unused. The creator's own original deposit is
/// read back from `PLAYER_JUNO_ANTE` (populated for them in
/// `execute_create_game_room`) rather than from `session.total_juno_pool` /
/// player count, since the pool is net of the subsidy fee and would give
/// the wrong figure.
fn execute_join_game_room(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
) -> Result<Response, ContractError> {
    let mut session = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(ContractError::GameNotFound { game_id })?;

    if !session.is_active {
        return Err(ContractError::GameNotActive { game_id });
    }

    if session.player_addresses.contains(&info.sender) {
        return Err(ContractError::AlreadyJoined {
            game_id,
            player: info.sender.to_string(),
        });
    }

    if session.player_addresses.len() >= session.max_players as usize {
        return Err(ContractError::RoomFull { game_id });
    }

    // Uniform Ante Rule: the joining player's attached funds must match the
    // room creator's original ante exactly, down to the micro-token
    // (ujuno) -- see this function's doc comment.
    // Uniform Ante Rule: compared on the GROSS attached amount, against the
    // creator's own gross deposit as recorded in `PLAYER_JUNO_ANTE`. This
    // check deliberately runs BEFORE the subsidy is taken (G-11 below), so
    // "every player antes the same amount" keeps meaning what a player
    // actually sends, not what survives the fee.
    //
    // Step 4.5 Batch 3, item 4: the figure compared against is now
    // `GameSession::room_ante` -- written once, at room creation, from the
    // creator's own deposit. It used to be re-read out of the creator's
    // `PLAYER_JUNO_ANTE` entry on every join, which produced the same number
    // but made the room's stake an incidental consequence of one player's
    // ledger row rather than a property of the room. `room_ante` says what it
    // is. (The old lookup is kept as a fallback for rooms created before this
    // field existed, where `#[serde(default)]` reads it as zero.)
    let required_ante = if session.room_ante.is_zero() {
        PLAYER_JUNO_ANTE.load(deps.storage, (game_id, session.creator.clone()))?
    } else {
        session.room_ante
    };

    // Audit G-11: the developer gas subsidy applies to room ENTRY, not just
    // room creation -- same `escrow::split_deposit` intake, so a joiner and
    // the creator who sent the same gross amount are taxed identically.
    let config = CONFIG.load(deps.storage)?;
    let deposit = escrow::split_deposit(&info, config.subsidy_fee_percentage)?;
    let joined_amount = deposit.gross;
    if joined_amount != required_ante {
        return Err(ContractError::InvalidAnteAmount {
            game_id,
            expected: required_ante,
            got: joined_amount,
        });
    }
    let subsidy_amount = deposit.subsidy;
    let net_pool_amount = deposit.net_pool;

    session.total_juno_pool = session
        .total_juno_pool
        .checked_add(net_pool_amount)
        .map_err(|_| ContractError::Overflow {})?;

    session.player_addresses.push(info.sender.clone());

    let starting_cash = STARTING_CAPITAL_POOL
        .checked_div(Uint128::new(u128::from(session.max_players)))
        .map_err(|_| ContractError::Overflow {})?;
    PLAYER_CASH_VGP.save(deps.storage, (game_id, info.sender.clone()), &starting_cash)?;

    // Inactivity Timeout Safety Valve refund ledger (see
    // `state::PLAYER_JUNO_ANTE`'s doc comment): every registered player now
    // always deposits the same nonzero `required_ante`, so this entry is
    // never zero either.
    PLAYER_JUNO_ANTE.save(deps.storage, (game_id, info.sender.clone()), &joined_amount)?;

    SESSIONS.save(deps.storage, game_id, &session)?;

    let mut response = Response::new()
        .add_attribute("action", "join_game_room")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("player", info.sender)
        .add_attribute("deposit_amount", joined_amount)
        .add_attribute("subsidy_amount", subsidy_amount)
        .add_attribute("net_juno_pool_contribution", net_pool_amount)
        .add_attribute("total_juno_pool", session.total_juno_pool)
        .add_attribute("starting_cash_vgp", starting_cash);

    // Route this joiner's subsidy cut to the developer treasury, through the
    // exact same `escrow::subsidy_transfer` room creation uses. State is
    // fully written above before any message is dispatched, per
    // `juno_developer_spec.md`'s reentrancy guidance.
    if let Some(transfer) = escrow::subsidy_transfer(&config.developer_treasury, subsidy_amount) {
        response = response.add_message(transfer);
    }

    Ok(response)
}

/// The itemized result of `appraise_player_net_worth_breakdown` -- the
/// three independent asset classes a 1830 player's net worth is made of,
/// kept separate so `query::query_player_net_worth` can report each line
/// individually while `finalize_and_distribute_payouts` consumes only
/// `net_worth`.
pub(crate) struct NetWorthBreakdown {
    /// Liquid, spendable VGP -- `state::PLAYER_CASH_VGP`.
    pub cash_vgp: Uint128,
    /// Live market value of every certificate held across
    /// `CORE_PUBLIC_COMPANIES`.
    pub stock_portfolio_value: Uint128,
    /// Combined printed face value of every unclosed private company this
    /// player still personally owns.
    ///
    /// Surfaced on `msg::PlayerNetWorthResponse::private_company_value` by
    /// `query::query_player_net_worth` (Audit G-3), so a caller sees the
    /// three asset classes as separate lines and `cash_vgp +
    /// stock_portfolio_value + private_company_value == net_worth` holds
    /// exactly. The `#[allow(dead_code)]` this field used to carry -- from
    /// the pass where the appraiser computed it but no response exposed it
    /// -- is gone with it.
    pub private_company_value: Uint128,
    /// `cash_vgp + stock_portfolio_value + private_company_value`.
    pub net_worth: Uint128,
}

/// **The single shared net-worth appraiser** (Audit G-1). Sums one
/// player's VGP net worth entirely from `game_id`'s own on-chain state,
/// never from caller input -- see `execute_end_game_and_distribute`'s doc
/// comment for why that matters. Both the real-JUNO endgame payout
/// (`finalize_and_distribute_payouts`, via `appraise_player_net_worth`
/// below) and the read-only `QueryMsg::PlayerNetWorth` handler
/// (`query::query_player_net_worth`) route through this one function, so
/// the two can never again disagree about what a player is worth.
///
/// Three asset classes, per the standard 1830 endgame appraisal:
///
/// 1. **Cash** -- `PLAYER_CASH_VGP`, at face.
/// 2. **Stock** -- for each company, `(held_percentage /
///    trading::PERCENT_PER_SHARE) * current_market_price`. `MARKET_GRID`'s
///    price is the price of ONE 10% certificate (see
///    `market::PAR_VALUE_LADDER`, whose $67-$100 rungs are per-share par
///    prices, and `trading::FLOAT_CAPITALIZATION_MULTIPLIER`, which
///    multiplies par by 10 to capitalize a whole company) -- so a
///    percentage must be converted to a CERTIFICATE COUNT and multiplied,
///    never multiplied by the raw percentage and divided by 100.
///
///    **This is the G-1 fix.** The previous implementation here computed
///    `price * percentage / 100`, i.e. it treated `cell.price` as a
///    whole-company valuation and undervalued every holding by exactly
///    10x. Because cash was (correctly) counted at face while stock was
///    counted at a tenth of face, the error did NOT cancel out of the
///    proportional split in `finalize_and_distribute_payouts`: it
///    systematically transferred real JUNO from stock-heavy players to
///    cash-heavy ones. `query::query_player_net_worth` already used the
///    correct certificate-count formula, so the contract's own payout math
///    and its own net-worth query disagreed by 10x on the same holding.
/// 3. **Private companies** -- the printed `PrivateCompany::cost` (face
///    value) of every private this player still personally owns and that
///    has not `closed`. Newly counted as of G-1; both appraisers used to
///    omit privates entirely, booking $0 for a player holding e.g. the
///    $220 B&O at game end. A private owned by a CORPORATION
///    (`owner_protocol_id`) rather than a player is deliberately NOT
///    counted here -- see the treasury note below.
///
/// Deliberately excludes a company's own `PublicCompany::treasury`: that
/// VGP belongs to the protocol, not to any individual player, exactly like
/// `query::GameStateResponse` reports company treasuries and player share
/// percentages as separate fields rather than folding one into the other.
pub(crate) fn appraise_player_net_worth_breakdown(
    deps: Deps,
    game_id: u64,
    player_addr: &Addr,
) -> Result<NetWorthBreakdown, ContractError> {
    let cash_vgp = PLAYER_CASH_VGP
        .may_load(deps.storage, (game_id, player_addr.clone()))?
        .unwrap_or_default();

    let mut stock_portfolio_value = Uint128::zero();
    for (company_id, _ticker) in public_company::CORE_PUBLIC_COMPANIES.iter().copied() {
        let percentage = PLAYER_SHARES
            .may_load(deps.storage, (game_id, company_id, player_addr.clone()))?
            .unwrap_or(0);
        if percentage == 0 {
            continue;
        }

        // Every CORE_PUBLIC_COMPANIES id is seeded a market position at
        // room-creation time (`market::initialize_game_market`), so a
        // player holding a nonzero percentage here should always resolve
        // to a real cell -- propagate the error (via ContractError's
        // `#[from] MarketError`) rather than silently valuing the holding
        // at zero, since this number feeds directly into a real-JUNO
        // payout and undercounting it would shortchange the player.
        let cell = market::current_cell(deps.storage, game_id, company_id)?;

        // Certificate count, NOT a percentage-of-price. Every holding is
        // always an exact multiple of `PERCENT_PER_SHARE` (every purchase
        // path buys in fixed 10% blocks), so this division never truncates
        // a real fraction away.
        let certificate_count =
            u32::from(percentage) / u32::from(trading::PERCENT_PER_SHARE);
        let company_share_value = cell
            .price
            .checked_mul(Uint128::from(certificate_count))
            .map_err(|_| ContractError::Overflow {})?;

        stock_portfolio_value = stock_portfolio_value
            .checked_add(company_share_value)
            .map_err(|_| ContractError::Overflow {})?;
    }

    // Iterates the same canonical `CORE_PRIVATE_COMPANIES` catalog that
    // seeded the room, so the set of ids appraised can never drift out of
    // sync with what was actually spawned (the identical reasoning
    // `operations.rs`'s own Phase 1 private-revenue loop gives).
    let mut private_company_value = Uint128::zero();
    for (private_id, ..) in auction::CORE_PRIVATE_COMPANIES.iter().copied() {
        let Some(private): Option<PrivateCompany> =
            PRIVATE_COMPANIES.may_load(deps.storage, (game_id, private_id))?
        else {
            continue;
        };
        // A closed private (B&O Special Closure, or the Phase 5 sweep) is
        // permanently out of play and worth nothing; a corporation-owned
        // private belongs to that corporation's balance sheet, not this
        // player's.
        if private.closed || private.owner.as_ref() != Some(player_addr) {
            continue;
        }
        private_company_value = private_company_value
            .checked_add(private.cost)
            .map_err(|_| ContractError::Overflow {})?;
    }

    let net_worth = cash_vgp
        .checked_add(stock_portfolio_value)
        .map_err(|_| ContractError::Overflow {})?
        .checked_add(private_company_value)
        .map_err(|_| ContractError::Overflow {})?;

    Ok(NetWorthBreakdown {
        cash_vgp,
        stock_portfolio_value,
        private_company_value,
        net_worth,
    })
}

/// Total-only convenience wrapper over `appraise_player_net_worth_breakdown`
/// -- see that function's doc comment for the full formula and the G-1
/// history. Used by `finalize_and_distribute_payouts`, which needs only the
/// single figure it divides the real-JUNO lobby pool against.
pub(crate) fn appraise_player_net_worth(
    deps: Deps,
    game_id: u64,
    player_addr: &Addr,
) -> Result<Uint128, ContractError> {
    Ok(appraise_player_net_worth_breakdown(deps, game_id, player_addr)?.net_worth)
}

// ===================================================================
// MOVED to `escrow.rs` (Step 4.5 Batch 3): `execute_end_game_and_distribute`,
// `finalize_and_distribute_payouts`, `execute_claim_timeout_refund` (now
// `execute_annul_game`), `subsidy_cut` and `require_native_deposit`.
//
// Everything that moves real JUNO now lives in one module. See `escrow.rs`'s
// own doc comment for the boundary rule and for why annulment is a
// separate machine from payout.
// ===================================================================
