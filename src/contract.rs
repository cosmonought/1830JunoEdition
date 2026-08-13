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
//!    proportionally at game end, and `ClaimTimeoutRefund` correspondingly
//!    refunds each player NET of their own cut -- see design note #13.
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
//! 13. `ClaimTimeoutRefund` (Inactivity Timeout Safety Valve) is callable by
//!     any currently registered player, not just the room's creator --
//!     unlike `EndGameAndDistribute`, it's a safety valve for a room no one
//!     is actively running anymore, not a privileged organizer action. It
//!     refunds each player their own original real-JUNO ante
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

use cosmwasm_std::{
    to_json_binary, Addr, BankMsg, Binary, Coin, Deps, DepsMut, Env, MessageInfo, Response,
    StdError, StdResult, Uint128,
};
use thiserror::Error;

#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;

use crate::auction::{self, AuctionError};
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

/// Native denom used for all real-money (lobby pool) operations on Juno.
pub const NATIVE_DENOM: &str = "ujuno";

/// Basis-point denominator: `subsidy_fee_percentage / BPS_DENOMINATOR` is the
/// fraction of each creation deposit routed to the developer treasury.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Inactivity Timeout Safety Valve threshold, in seconds (48 hours). See
/// `state.rs`'s `GameSession::last_action_timestamp` doc comment and
/// `execute_claim_timeout_refund`.
pub const INACTIVITY_TIMEOUT_SECONDS: u64 = 172_800;

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
        "Game room {game_id} has had a qualifying action within the last {timeout_seconds} seconds; ClaimTimeoutRefund is not yet available"
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
            execute_end_game_and_distribute(deps, env, info, game_id)
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
        } => {
            let response = trading::execute_buy_stock(
                deps.branch(),
                env,
                info.clone(),
                game_id,
                protocol_id,
                source,
                par_value,
            )?;
            gamelog::record_action(
                deps.storage,
                game_id,
                ActionRecord::BuyStock {
                    player: info.sender,
                    protocol_id,
                    source,
                    par_value,
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
            hex_path,
            payout_strategy,
        } => operations::execute_run_manual_route(
            deps,
            env,
            info,
            game_id,
            protocol_id,
            hex_path,
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
        // Not recorded to `GAME_LOG` -- like `CreateGameRoom`/`JoinGameRoom`/
        // `EndGameAndDistribute`, this moves real JUNO via `BankMsg`, which
        // the Event-Sourced Ledger deliberately excludes (see `gamelog.rs`'s
        // module doc comment #2).
        ExecuteMsg::ClaimTimeoutRefund { game_id } => {
            execute_claim_timeout_refund(deps, env, info, game_id)
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

    // Exactly one non-zero coin of the native denom is required to fund the
    // lobby pool at creation time.
    let deposit_amount = require_native_deposit(&info)?;

    // subsidy = deposit * subsidy_fee_percentage / BPS_DENOMINATOR, using
    // only checked, deterministic Uint128 math (no floats). Shared with
    // room ENTRY and the inactivity refund since Audit G-11 -- see
    // `subsidy_cut`.
    let subsidy_amount = subsidy_cut(deposit_amount, config.subsidy_fee_percentage)?;

    let net_pool_amount = deposit_amount
        .checked_sub(subsidy_amount)
        .map_err(|_| ContractError::Overflow {})?;

    let game_id = NEXT_GAME_ID.load(deps.storage)?;
    let next_game_id = game_id.checked_add(1).ok_or(ContractError::Overflow {})?;

    let session = GameSession {
        game_id,
        creator: info.sender.clone(),
        total_juno_pool: net_pool_amount,
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
    // creator personally deposited, so `execute_claim_timeout_refund` can
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
    if !subsidy_amount.is_zero() {
        response = response.add_message(BankMsg::Send {
            to_address: config.developer_treasury.to_string(),
            amount: vec![Coin {
                denom: NATIVE_DENOM.to_string(),
                amount: subsidy_amount,
            }],
        });
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
    let required_ante = PLAYER_JUNO_ANTE.load(deps.storage, (game_id, session.creator.clone()))?;
    let joined_amount = require_native_deposit(&info)?;
    if joined_amount != required_ante {
        return Err(ContractError::InvalidAnteAmount {
            game_id,
            expected: required_ante,
            got: joined_amount,
        });
    }

    // Audit G-11: the developer gas subsidy now applies to room ENTRY, not
    // just room creation. Identical formula and identical rounding to
    // `execute_create_game_room`'s own cut -- `subsidy_fee_percentage /
    // BPS_DENOMINATOR`, floor-divided -- so a joiner and the creator who
    // sent the same gross amount are taxed exactly the same.
    let config = CONFIG.load(deps.storage)?;
    let subsidy_amount = subsidy_cut(joined_amount, config.subsidy_fee_percentage)?;
    let net_pool_amount = joined_amount
        .checked_sub(subsidy_amount)
        .map_err(|_| ContractError::Overflow {})?;

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

    // Route this joiner's subsidy cut to the developer treasury, exactly as
    // room creation already does. State is fully written above before any
    // message is dispatched, per `juno_developer_spec.md`'s reentrancy
    // guidance.
    if !subsidy_amount.is_zero() {
        response = response.add_message(BankMsg::Send {
            to_address: config.developer_treasury.to_string(),
            amount: vec![Coin {
                denom: NATIVE_DENOM.to_string(),
                amount: subsidy_amount,
            }],
        });
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

/// Closes out an active game room and redeems the real-JUNO lobby pool
/// proportionally against each player's final VGP net worth -- computed
/// entirely on-chain by `appraise_player_net_worth`, never accepted as
/// caller input. See this module's doc comment (design note #5) for why:
/// an earlier version of this handler took a `final_player_points` list
/// directly from the caller, which meant a buggy or malicious client's
/// numbers -- not this contract's own ledger -- decided how the real JUNO
/// pool split.
///
/// This is a thin authorization wrapper around the shared
/// `finalize_and_distribute_payouts` core: load the room, confirm it's
/// still active, confirm the caller is the room's creator, then hand off.
/// See that function's own doc comment for why the shared core lives here
/// and returns a plain `StdResult` rather than `ContractError`.
fn execute_end_game_and_distribute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
) -> Result<Response, ContractError> {
    let session = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(ContractError::GameNotFound { game_id })?;

    if !session.is_active {
        return Err(ContractError::GameNotActive { game_id });
    }

    // Only the room creator (the lobby's Validator/organizer) may finalize
    // and trigger payout via this message -- contrast the automatic $350
    // Game-End Trigger (`finalize_and_distribute_payouts`'s other caller),
    // which is a rules-mandated event with no single authorizing player.
    if info.sender != session.creator {
        return Err(ContractError::Unauthorized {});
    }

    Ok(finalize_and_distribute_payouts(deps, game_id, session)?)
}

/// Shared close-out core for both the room-creator-invoked
/// `EndGameAndDistribute` message (`execute_end_game_and_distribute` above)
/// and the automatic $350 Game-End Trigger (`market::GAME_END_PRICE_TRIGGER`,
/// checked in `trading::execute_buy_stock`/`execute_declare_dividends` and
/// `operations::execute_operating_round` immediately after any ascending
/// market movement -- see `market.rs`'s module doc comment for the full
/// design/sourcing note on why $350 is this project's own explicit house
/// rule). Sums every registered player's final VGP net worth fresh from
/// this room's own on-chain ledger (`appraise_player_net_worth`), splits
/// the real-JUNO lobby pool proportionally, marks the room inactive, and
/// returns the payout `Response` for the caller to use directly or fold
/// into a larger one.
///
/// Takes an already-loaded `session` by value and performs NO
/// authorization check itself -- both callers already did their own
/// (the creator-only check above, or the automatic trigger's "this is a
/// rules-mandated event, not a player-invoked action" reasoning) before
/// reaching here.
///
/// Returns a plain `StdResult<Response>` rather than `ContractError`
/// specifically so `trading::TradingError`/`operations::OperationsError`
/// callers -- which have no `From<ContractError>` conversion, matching
/// this crate's error-enum convention of only ever depending "downward"
/// from `contract.rs` into the feature modules, never the reverse -- can
/// propagate it via their own existing `Std(#[from] StdError)` variant
/// with a plain `.map_err(...)?` rather than a new cross-module `From` impl.
pub(crate) fn finalize_and_distribute_payouts(
    deps: DepsMut,
    game_id: u64,
    mut session: GameSession,
) -> StdResult<Response> {
    // Every registered player's final VGP net worth, computed fresh from
    // this room's own ledger -- see `appraise_player_net_worth`. Takes
    // `deps.as_ref()` because the appraiser is read-only and shared with
    // the `Deps`-only query layer (`query::query_player_net_worth`); the
    // immutable borrow ends with each call, leaving `deps.storage` free
    // for the mutable `SESSIONS.save` further down.
    let mut player_points: Vec<(Addr, Uint128)> =
        Vec::with_capacity(session.player_addresses.len());
    let mut total_vgp = Uint128::zero();
    for player in session.player_addresses.iter() {
        let net_worth = appraise_player_net_worth(deps.as_ref(), game_id, player)
            .map_err(|e| StdError::generic_err(e.to_string()))?;
        total_vgp = total_vgp
            .checked_add(net_worth)
            .map_err(|_| StdError::generic_err("overflow summing player net worth"))?;
        player_points.push((player.clone(), net_worth));
    }

    if total_vgp.is_zero() {
        return Err(StdError::generic_err(
            "total VGP points across all players is zero; cannot compute a proportional payout",
        ));
    }

    let pool = session.total_juno_pool;
    let mut messages = Vec::with_capacity(player_points.len());
    let mut distributed = Uint128::zero();

    for (addr, points) in player_points.iter() {
        // payout = pool * player_points / total_vgp -- each player's
        // proportional percentage of total wealth applied to the real
        // JUNO pool, using checked fixed-point Uint128 math throughout.
        let payout = pool
            .checked_mul(*points)
            .map_err(|_| StdError::generic_err("overflow computing payout"))?
            .checked_div(total_vgp)
            .map_err(|_| StdError::generic_err("overflow computing payout"))?;

        distributed = distributed
            .checked_add(payout)
            .map_err(|_| StdError::generic_err("overflow computing payout"))?;

        if !payout.is_zero() {
            messages.push(BankMsg::Send {
                to_address: addr.to_string(),
                amount: vec![Coin {
                    denom: NATIVE_DENOM.to_string(),
                    amount: payout,
                }],
            });
        }
    }

    // Integer division can leave a small remainder undistributed; sweep it
    // to the developer treasury so it never sits stranded in contract state.
    let dust = pool
        .checked_sub(distributed)
        .map_err(|_| StdError::generic_err("overflow computing dust"))?;
    if !dust.is_zero() {
        let config = CONFIG.load(deps.storage)?;
        messages.push(BankMsg::Send {
            to_address: config.developer_treasury.to_string(),
            amount: vec![Coin {
                denom: NATIVE_DENOM.to_string(),
                amount: dust,
            }],
        });
    }

    // State is finalized before any BankMsg is dispatched, consistent with
    // the reentrancy guidance in juno_developer_spec.md. This is also
    // exactly what "halt all further player turns" means in practice: every
    // gameplay handler in this crate checks `session.is_active` first thing
    // (see `trading.rs`/`operations.rs`/this module), so flipping it here
    // rejects every subsequent action regardless of whatever the turn
    // pointer nominally says.
    session.is_active = false;
    session.total_juno_pool = Uint128::zero();
    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "end_game_and_distribute")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("total_juno_pool_distributed", distributed)
        .add_attribute("dust_swept_to_treasury", dust))
}

/// Inactivity Timeout Safety Valve: closes an abandoned game room and
/// refunds every registered player their own real-JUNO ante NET of the
/// developer subsidy that was taken from it -- i.e. exactly the amount
/// their deposit actually contributed to `total_juno_pool` -- rather than a
/// proportional split, unlike `execute_end_game_and_distribute`.
///
/// **Solvency (Audit G-11).** `PLAYER_JUNO_ANTE` records each player's
/// GROSS deposit, but the subsidy cut is forwarded to the developer
/// treasury the moment it is taken, so only the net ever reaches the pool.
/// Refunding the gross therefore tried to pay out more than the room
/// holds. That shortfall already existed for the room creator (whose
/// deposit has always been taxed) and taxing joiners too would have
/// multiplied it by the player count. Each refund is now
/// `ante - subsidy_cut(ante)`, so the refunds sum to exactly
/// `total_juno_pool` and the room can never overdraw the contract's
/// balance. Requires
/// `env.block.time.seconds() > session.last_action_timestamp +
/// INACTIVITY_TIMEOUT_SECONDS` (48 hours since the room's last qualifying
/// state-advancing action -- see `state.rs`'s `GameSession::last_action_timestamp`
/// doc comment for exactly which actions refresh it). Callable by any
/// currently registered player, not just the room's creator, since this is
/// a safety valve for a room nobody is actively running anymore, not a
/// privileged administrative action.
fn execute_claim_timeout_refund(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
) -> Result<Response, ContractError> {
    let mut session = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(ContractError::GameNotFound { game_id })?;

    if !session.is_active {
        return Err(ContractError::GameNotActive { game_id });
    }

    if !session.player_addresses.contains(&info.sender) {
        return Err(ContractError::NotAPlayer {
            game_id,
            player: info.sender.to_string(),
        });
    }

    let timeout_at = session
        .last_action_timestamp
        .checked_add(INACTIVITY_TIMEOUT_SECONDS)
        .ok_or(ContractError::Overflow {})?;
    if env.block.time.seconds() <= timeout_at {
        return Err(ContractError::TimeoutNotYetElapsed {
            game_id,
            timeout_seconds: INACTIVITY_TIMEOUT_SECONDS,
        });
    }

    // State is finalized before any BankMsg is dispatched, consistent with
    // the reentrancy guidance in juno_developer_spec.md (same pattern as
    // `execute_end_game_and_distribute`).
    session.is_active = false;
    session.total_juno_pool = Uint128::zero();
    SESSIONS.save(deps.storage, game_id, &session)?;

    // Refund each player exactly their own original ante -- never a
    // recomputed or proportional split -- read straight from
    // `PLAYER_JUNO_ANTE`, defaulting to zero for a (registered but never
    // funded) player who joined without attaching any coin.
    let config = CONFIG.load(deps.storage)?;
    let mut messages = Vec::with_capacity(session.player_addresses.len());
    let mut total_refunded = Uint128::zero();
    let mut total_subsidy_withheld = Uint128::zero();
    for player in session.player_addresses.iter() {
        let ante = PLAYER_JUNO_ANTE
            .may_load(deps.storage, (game_id, player.clone()))?
            .unwrap_or_default();
        if ante.is_zero() {
            continue;
        }

        // Audit G-11: refund the NET contribution, not the gross ante --
        // the subsidy cut left the contract for the developer treasury at
        // deposit time and was never part of this room's pool. Recomputed
        // from the same immutable `subsidy_fee_percentage` that took it;
        // see `subsidy_cut`'s own doc comment for why that is safe.
        let withheld = subsidy_cut(ante, config.subsidy_fee_percentage)?;
        let refund = ante
            .checked_sub(withheld)
            .map_err(|_| ContractError::Overflow {})?;
        total_subsidy_withheld = total_subsidy_withheld
            .checked_add(withheld)
            .map_err(|_| ContractError::Overflow {})?;
        if refund.is_zero() {
            continue;
        }

        total_refunded = total_refunded
            .checked_add(refund)
            .map_err(|_| ContractError::Overflow {})?;
        messages.push(BankMsg::Send {
            to_address: player.to_string(),
            amount: vec![Coin {
                denom: NATIVE_DENOM.to_string(),
                amount: refund,
            }],
        });
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "claim_timeout_refund")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("claimed_by", info.sender)
        .add_attribute("total_refunded", total_refunded)
        .add_attribute("total_subsidy_withheld", total_subsidy_withheld))
}

/// Requires `info.funds` to contain exactly one non-zero coin of
/// `NATIVE_DENOM`, returning its amount. Used for room-creation deposits,
/// which must always be funded.
/// The developer gas-subsidy cut taken from a real-JUNO deposit:
/// `deposit * subsidy_fee_percentage / BPS_DENOMINATOR`, floor-divided,
/// using only checked deterministic `Uint128` math (no floats).
///
/// Extracted (Audit G-11) so room creation, room entry, and the inactivity
/// refund all compute the identical figure from the identical formula --
/// previously creation had this inline and nothing else could reuse it.
///
/// `GameConfig::subsidy_fee_percentage` is written once, at `instantiate`,
/// and never updated anywhere in this contract, so re-deriving a past
/// deposit's cut at refund time always reproduces the exact value that was
/// taken at deposit time. If a config-update handler is ever added, this
/// assumption breaks and the refund path below must store the net figure
/// instead of recomputing it.
fn subsidy_cut(
    deposit: Uint128,
    subsidy_fee_percentage: u64,
) -> Result<Uint128, ContractError> {
    deposit
        .checked_mul(Uint128::from(subsidy_fee_percentage))
        .map_err(|_| ContractError::Overflow {})?
        .checked_div(Uint128::from(BPS_DENOMINATOR as u64))
        .map_err(|_| ContractError::Overflow {})
}

fn require_native_deposit(info: &MessageInfo) -> Result<Uint128, ContractError> {
    if info.funds.len() != 1 {
        return Err(ContractError::InvalidDeposit {
            expected_denom: NATIVE_DENOM.to_string(),
        });
    }
    let coin = &info.funds[0];
    if coin.denom != NATIVE_DENOM {
        return Err(ContractError::InvalidDeposit {
            expected_denom: NATIVE_DENOM.to_string(),
        });
    }
    if coin.amount.is_zero() {
        return Err(ContractError::ZeroDeposit {});
    }
    Ok(coin.amount)
}
