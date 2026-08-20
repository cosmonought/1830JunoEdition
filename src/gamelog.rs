//! Event-Sourced Ledger: records every replayable transaction to a per-room
//! append-only `GAME_LOG`, and recomputes a room's entire replayable state by
//! resetting to genesis and re-running that log -- the same technique 18xx.games
//! uses for Undo, rather than writing a bespoke inverse for every action.
//!
//! WHAT IS IN THE LOG: actions that (a) move only VGP, never real JUNO, and (b)
//! mutate state through a single already-pure handler with no side channel this
//! module cannot also reset.
//!
//! WHAT IS EXCLUDED, AND WHY:
//!   Real-JUNO messages cannot be replayed -- there is no way to re-attach
//!   historical `info.funds`, and re-issuing a `BankMsg` during a replay would
//!   double-spend real tokens. They also define the room's genesis rather than
//!   being something to undo past.
//!   `EmergencyBuyHardware` can durably halt the session, and undoing PAST a
//!   bankruptcy raises questions (does the room reactivate? what if players have
//!   left?) deliberately left for a follow-up rather than answered by assumption.
//!   The queue-populating and cascading messages depend on state a later replay
//!   cannot safely re-derive; `reapply_game_log` resets their fields to genesis
//!   and leaves them there, so re-establishing the queue after an undo is a fresh
//!   `BeginOperatingRound` call.
//!
//! WHY REPLAY REUSES THE LIVE HANDLERS: `reapply_game_log` calls the same
//! functions `contract::execute` does, just via `deps.branch()` with a synthetic
//! zero-funds `MessageInfo`. This guarantees replayed behaviour can never drift
//! from what actually happened, since there is only one implementation of each
//! rule rather than two to keep in sync -- which is also why the turn pointers
//! reconstruct for free.
//!
//! See docs/ai_architecture/rust_contract_architecture.md, gamelog.rs, for the
//! full reset scope and the waterfall-reset regression.

use cosmwasm_std::{Addr, DepsMut, Env, MessageInfo, Response, StdError, Uint128};
use thiserror::Error;

use crate::auction::{self, AuctionError};
use crate::contract::STARTING_CAPITAL_POOL;
use crate::hardware::{self, HardwareError};
use crate::hexmap::{self, HexMapError};
use crate::market::{self, MarketError};
use crate::operations::{self, OperationsError};
use crate::train_trade::{self, TrainTradeError};
use crate::public_company::{self, CORE_PUBLIC_COMPANIES};
use crate::state::{
    ActionRecord, GameSession, RoundType, TileColor, BANK_POOL_SHARES, COMPANY_HARDWARE, GAME_LOG,
    IPO_POOL_SHARES, MAP_GRID, PLAYER_CASH_VGP, PLAYER_SHARES, PRIVATE_BIDS,
    PROTOCOL_LAST_TOKEN_SUBROUND, PROTOCOL_NETWORK_HEXES, PROTOCOL_PAR_VALUE, PROTOCOL_PRESIDENT,
    PROTOCOL_STATION_HEXES, SESSIONS, TRAINS_PURCHASED_COUNT, WATERFALL_MINI_AUCTION,
};
use crate::trading::{self, TradingError};

#[derive(Error, Debug)]
pub enum GameLogError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Auction(#[from] AuctionError),

    #[error("{0}")]
    Trading(#[from] TradingError),

    #[error("{0}")]
    HexMap(#[from] HexMapError),

    #[error("{0}")]
    Hardware(#[from] HardwareError),

    #[error("{0}")]
    Market(#[from] MarketError),

    /// Audit G-14. `AdvanceOperatingSubPhase` is the FIRST `operations`-owned
    /// message the game log replays -- every OR action recorded before it
    /// lived in `hexmap`/`trading`/`hardware`, which is why this variant and
    /// `use crate::operations` were both absent until now.
    #[error("{0}")]
    Operations(#[from] OperationsError),

    /// Audit G-15.
    #[error("{0}")]
    TrainTrade(#[from] TrainTradeError),

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error("{player} is not a registered player in game room {game_id}")]
    NotAPlayer { game_id: u64, player: String },

    #[error("Game room {game_id}'s action log is empty; there is nothing left to undo")]
    EmptyLog { game_id: u64 },

    #[error(
        "It is not {got}'s turn in game room {game_id}; {expected} must act (or PassTurn) first"
    )]
    NotActivePlayer {
        game_id: u64,
        expected: String,
        got: String,
    },

    #[error("Arithmetic overflow/underflow while resetting game room {game_id} for replay")]
    Overflow { game_id: u64 },
}

/// Appends `record` to `game_id`'s `GAME_LOG`. Called by `contract::execute`
/// right after each loggable handler succeeds, and by `execute_pass_turn`
/// for its own action.
pub fn record_action(
    storage: &mut dyn cosmwasm_std::Storage,
    game_id: u64,
    record: ActionRecord,
) -> cosmwasm_std::StdResult<()> {
    let mut log = GAME_LOG.may_load(storage, game_id)?.unwrap_or_default();
    log.push(record);
    GAME_LOG.save(storage, game_id, &log)?;
    Ok(())
}

/// Constructs a synthetic, zero-funds `MessageInfo` standing in for a
/// historical action's original caller during replay. Safe specifically
/// because every replayed handler in this module is VGP-only and never
/// inspects `info.funds` -- see module doc comment #1/#5.
fn synthetic_info(player: Addr) -> MessageInfo {
    MessageInfo {
        sender: player,
        funds: vec![],
    }
}

/// Advances the turn pointer and INCREMENTS `consecutive_passes` -- the opposite
/// of what a successful trade does to that counter: a pass extends an all-pass
/// streak, a trade breaks one. Only the current active player may call it.
pub fn execute_pass_turn(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
) -> Result<Response, GameLogError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(GameLogError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(GameLogError::GameNotActive { game_id });
    }

    let active_player = session
        .player_addresses
        .get(session.active_player_index as usize)
        .cloned()
        .ok_or(GameLogError::GameNotFound { game_id })?;
    if info.sender != active_player {
        return Err(GameLogError::NotActivePlayer {
            game_id,
            expected: active_player.to_string(),
            got: info.sender.to_string(),
        });
    }

    let player_count = session.player_addresses.len() as u32;
    session.active_player_index = (session.active_player_index + 1) % player_count;
    session.consecutive_passes = session
        .consecutive_passes
        .checked_add(1)
        .ok_or(GameLogError::Overflow { game_id })?;
    // Inactivity Timeout Safety Valve (see `state.rs`'s
    // `GameSession::last_action_timestamp` doc comment): a pass is one of
    // the six state-advancing actions that resets the room's 48-hour
    // inactivity clock.
    session.last_action_timestamp = env.block.time.seconds();

    // ---- Step 4.5 Batch 1, item 4: the Stock Round's natural end.
    //
    // The classic 18xx termination rule -- the round ends the moment every
    // player has passed in a row -- has been tracked in `consecutive_passes`
    // since this contract was written but never ACTED on; `state.rs`'s own
    // doc comment for that field described it as "the storage slot a future
    // Stock-Round-ends feature would read". This is that feature.
    //
    // `conclude_stock_round` applies the 100%-sold-out price rise to every
    // fully-held floated corporation and clears the Buyback Lockout, then
    // resets `consecutive_passes` to `0`. That reset is what makes this fire
    // exactly once per round: a further pass starts a fresh streak from one
    // rather than immediately re-satisfying the condition.
    //
    // The round-type guard matters. `consecutive_passes` is also incremented
    // by passes taken outside a Stock Round, and a sold-out price rise must
    // not fire in the middle of an Operating Round.
    let stock_round_concluded =
        session.current_round_type == RoundType::StockRound && session.consecutive_passes >= player_count;
    let sold_out_risers = if stock_round_concluded {
        trading::conclude_stock_round(deps.storage, game_id, &mut session)?
    } else {
        Vec::new()
    };

    SESSIONS.save(deps.storage, game_id, &session)?;

    record_action(
        deps.storage,
        game_id,
        ActionRecord::PassTurn {
            player: info.sender.clone(),
        },
    )?;

    let new_active_player = &session.player_addresses[session.active_player_index as usize];

    let mut response = Response::new()
        .add_attribute("action", "pass_turn")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("passed_player", info.sender)
        .add_attribute(
            "new_active_player_index",
            session.active_player_index.to_string(),
        )
        .add_attribute("new_active_player", new_active_player.as_str())
        .add_attribute("consecutive_passes", session.consecutive_passes.to_string());

    if stock_round_concluded {
        response = response
            .add_attribute("stock_round_concluded", "true")
            .add_attribute("sold_out_risers", sold_out_risers.len().to_string())
            // Step 4.5 Batch 4: the Priority Deal has just moved to the seat
            // left of whoever acted last -- reported so a client can update
            // its `#1` marker from this response instead of re-querying.
            .add_attribute(
                "priority_deal_index",
                session.priority_deal_index.to_string(),
            );
        for (company_id, cell) in &sold_out_risers {
            response = response
                .add_attribute("sold_out_protocol_id", company_id.to_string())
                .add_attribute("sold_out_new_price", cell.price)
                .add_attribute("sold_out_new_x", cell.x.to_string())
                .add_attribute("sold_out_new_y", cell.y.to_string());
        }
    }

    Ok(response)
}

/// Pops the most recent entry off `game_id`'s `GAME_LOG` and recomputes the
/// room's replayable state via `reapply_game_log`. Any player registered in
/// `game_id` may call this. See module doc comment for the full design.
pub fn execute_undo_last_action(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
) -> Result<Response, GameLogError> {
    let session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(GameLogError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(GameLogError::GameNotActive { game_id });
    }
    if !session.player_addresses.contains(&info.sender) {
        return Err(GameLogError::NotAPlayer {
            game_id,
            player: info.sender.to_string(),
        });
    }

    let mut log = GAME_LOG
        .may_load(deps.storage, game_id)?
        .unwrap_or_default();
    if log.is_empty() {
        return Err(GameLogError::EmptyLog { game_id });
    }

    // Every tile currently on MAP_GRID for this game came from a LayTile
    // entry somewhere in this (pre-undo) log -- collecting it here, before
    // popping, gives `reapply_game_log` a complete, accurate manifest of
    // what to clear before it replays. See module doc comment #3.
    let previously_laid_tiles: Vec<(i32, i32)> = log
        .iter()
        .filter_map(|record| match record {
            ActionRecord::LayTile { q, r, .. } => Some((*q, *r)),
            _ => None,
        })
        .collect();

    let undone = log.pop().expect("checked non-empty above");
    GAME_LOG.save(deps.storage, game_id, &log)?;

    reapply_game_log(deps, env, game_id, &previously_laid_tiles, &log)?;

    Ok(Response::new()
        .add_attribute("action", "undo_last_action")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("undone_by", info.sender)
        .add_attribute("remaining_log_length", log.len().to_string())
        .add_attribute("undone_action", format!("{undone:?}")))
}

/// Resets `game_id`'s entire replayable state to genesis, then fast-forwards
/// through `replay_log` in order, each entry re-applied by calling the exact same
/// handler live play uses. `previously_laid_tiles` is the manifest of every
/// `(q, r)` that must be cleared before replay begins.
pub fn reapply_game_log(
    mut deps: DepsMut,
    env: Env,
    game_id: u64,
    previously_laid_tiles: &[(i32, i32)],
    replay_log: &[ActionRecord],
) -> Result<(), GameLogError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(GameLogError::GameNotFound { game_id })?;

    // ---- 1. Reset every replayable piece of state to genesis ----

    // Pre-Game Waterfall Auction: none of its five messages are logged, so this
    // function has no entries to recompute whether or how far the waterfall
    // progressed. The one signal available is the room's CURRENT
    // `waterfall_auction_active` flag, captured here BEFORE the reset overwrites it.
    //
    // Every loggable action gated on that flag can only have been recorded while it
    // already read `false`. So a `false` reading means the waterfall had already
    // concluded by the time whatever this undo is unwinding took place, and replay
    // MUST resume from that same post-waterfall phase.
    //
    // Resetting unconditionally back to `WaterfallAuction` -- as an earlier version
    // did -- makes the very first replayed Stock Round action fail with
    // `WaterfallAuctionInProgress`, hard-failing the whole undo. That was caught by
    // a pre-existing test this waterfall feature had silently regressed.
    let waterfall_already_concluded = !session.waterfall_auction_active;

    session.virtual_bank_vgp = session.virtual_bank_start;
    // Turn Priority Queue: reset all the way to genesis only if the waterfall itself
    // is what is being unwound. Once it has concluded, `priority_deal_index` is
    // fixed for the rest of the game and `active_player_index` must resume from that
    // same seat, not `0`, or the first replayed Stock Round action could spuriously
    // fail turn-order validation in any room where the waterfall assigned Priority
    // Deal to someone other than the creator.
    if waterfall_already_concluded {
        session.active_player_index = session.priority_deal_index;
    } else {
        session.active_player_index = 0;
        session.priority_deal_index = 0;
    }
    session.consecutive_passes = 0;
    // Step 4.5 Batch 4: the Stock Round's last-actor record is replayable
    // state, exactly like `consecutive_passes` above -- it is written by the
    // same `BuyStock`/`SellStock` entries the log replays below, so it resets
    // to genesis here and rebuilds itself. Leaving a stale value would let an
    // undone purchase still decide who gets the next Priority Deal.
    session.last_active_player_index = None;
    // Tech Era Color-Locking (`hexmap.rs`'s module doc comment #8):
    // recomputed identically to live play as `ActionRecord::BuyHardwareFromPool`
    // entries replay below, via the same first-3-train/first-5-train
    // triggers `hardware::record_purchase_and_apply_rusting` checks live.
    session.current_global_era = TileColor::Yellow;
    // Operating Round Corporation Turn Queue: not replayable (see module
    // doc comment #2's `BeginOperatingRound` bullet) -- reset to empty
    // rather than recomputed. A room that wants the queue back after an
    // undo needs a fresh `BeginOperatingRound` call.
    session.active_operating_order = Vec::new();
    session.active_corporation_index = 0;
    // Macro Round Tracker: tied to the same non-replayable pair as the queue fields
    // above, so these are reset to genesis rather than recomputed. A room wanting the
    // Operating Round phase and its paced count back after an undo needs a fresh
    // `BeginOperatingRound`. `macro_round_number` is deliberately NOT reset -- a
    // macro-round boundary is not "replayable" state the way an in-progress turn
    // queue is.
    session.sub_round_index = 0;
    session.operating_round_sequence_length = 0;

    // Pre-Game Waterfall Auction phase itself (module doc comment #2):
    // resume from wherever the room genuinely was, per
    // `waterfall_already_concluded` above, rather than unconditionally
    // forcing it back to the very start.
    if waterfall_already_concluded {
        // Stock Round trading is already legitimately open for this room --
        // keep it that way for replay. `last_private_winner` is left
        // untouched (not reset to `None`): it's permanently fixed the
        // moment `waterfall::conclude_waterfall` runs, same as
        // `priority_deal_index` above, and nothing in `replay_log` can
        // recompute it.
        session.current_round_type = RoundType::StockRound;
        session.waterfall_auction_active = false;
    } else {
        session.current_round_type = RoundType::WaterfallAuction;
        session.waterfall_auction_active = true;
        session.last_private_winner = None;
    }
    session.consecutive_waterfall_passes = 0;

    // The six core privates' ownership: only reset (and later re-spawned
    // unowned, alongside the sweep below) if the waterfall itself is being
    // unwound. If it had already concluded, that ownership was settled by
    // the unlogged waterfall, not by anything in `replay_log` -- resetting
    // it here would silently strip real players' privates on an unrelated
    // Stock Round undo, trading today's loud `WaterfallAuctionInProgress`
    // failure for a quiet, worse one. This is a real, accepted, narrower
    // scope gap of its own: a `BidOnPrivate` entry (the legacy fallback
    // auction, still usable post-waterfall -- see `auction.rs`'s module doc
    // comment #2) in a post-conclusion `replay_log` would replay against a
    // private already sitting in its currently-owned state rather than a
    // freshly-reset one, so it isn't guaranteed to reproduce bit-for-bit.
    // No test in this suite exercises that combination today.
    if !waterfall_already_concluded {
        WATERFALL_MINI_AUCTION.remove(deps.storage, game_id);
        for (private_id, ..) in auction::CORE_PRIVATE_COMPANIES.iter().copied() {
            for player in &session.player_addresses {
                PRIVATE_BIDS.remove(deps.storage, (game_id, private_id, player.clone()));
            }
        }
        auction::spawn_core_private_companies(deps.storage, game_id)?;
    }

    let starting_cash = STARTING_CAPITAL_POOL
        .checked_div(Uint128::new(u128::from(session.max_players)))
        .map_err(|_| GameLogError::Overflow { game_id })?;

    let core_public_company_ids: Vec<u32> = CORE_PUBLIC_COMPANIES
        .iter()
        .map(|(company_id, _ticker)| *company_id)
        .collect();

    for player in &session.player_addresses {
        PLAYER_CASH_VGP.save(deps.storage, (game_id, player.clone()), &starting_cash)?;
        for &company_id in &core_public_company_ids {
            PLAYER_SHARES.save(deps.storage, (game_id, company_id, player.clone()), &0u8)?;
        }
    }

    // Step 4.5 Batch 1, item 3: the Stock Round Buyback Lockout is
    // replayable state, so it resets to genesis (nobody has sold anything)
    // here and is rebuilt by the `SellStock` entries replayed below --
    // exactly like `PLAYER_SHARES` and the two pools just above. Without
    // this reset an undone sale would leave its lockout behind, barring a
    // player from a corporation they no longer have any record of selling.
    trading::clear_stock_round_sales(deps.storage, game_id, &session.player_addresses);

    for &company_id in &core_public_company_ids {
        IPO_POOL_SHARES.remove(deps.storage, (game_id, company_id));
        BANK_POOL_SHARES.remove(deps.storage, (game_id, company_id));
        PROTOCOL_PAR_VALUE.remove(deps.storage, (game_id, company_id));
        PROTOCOL_PRESIDENT.remove(deps.storage, (game_id, company_id));
        // Audit G-2: a `PROTOCOL_TREASURY_VGP.remove(...)` used to sit here. That map is
        // gone -- corporate cash lives solely in `PublicCompany::treasury`, which the
        // company respawn further down already resets by fully overwriting each record.
        // No replacement removal is needed.
        COMPANY_HARDWARE.remove(deps.storage, (game_id, company_id));
        PROTOCOL_NETWORK_HEXES.remove(deps.storage, (game_id, company_id));
        // Station Tokens (`hexmap.rs` module doc comment #23): reset to
        // genesis alongside every other per-company registry above.
        PROTOCOL_STATION_HEXES.remove(deps.storage, (game_id, company_id));
        PROTOCOL_LAST_TOKEN_SUBROUND.remove(deps.storage, (game_id, company_id));
        let (default_x, default_y) = market::DEFAULT_MARKET_POSITION;
        market::set_protocol_position(deps.storage, game_id, company_id, default_x, default_y)?;
    }

    for &(q, r) in previously_laid_tiles {
        MAP_GRID.remove(deps.storage, (game_id, q, r));
    }

    // Tile Inventory Supply Engine (Audit G-5): reset the tray to a full genesis
    // supply, in lockstep with clearing the board above. Every surviving `LayTile`
    // re-consumes (and, for an upgrade, re-recycles) its own tile as it replays, so
    // the tray lands exactly where the surviving prefix of the log says it should.
    // Without this, an undone tile lay would leave its copy permanently missing from
    // the tray even though the tile is no longer on the board.
    hexmap::seed_tile_inventory(deps.storage, game_id)?;

    for (model_type, _cost, _max_route_distance, _quantity) in
        hardware::TRAIN_CATALOG.iter().copied()
    {
        TRAINS_PURCHASED_COUNT.remove(deps.storage, (game_id, model_type.to_string()));
    }

    // Re-spawning the public-company catalog and Hardware pool fully
    // overwrites (not merges) every core public company's
    // treasury/floated/shares/market-snapshot fields, plus the Hardware
    // pool's full starting inventory -- unconditionally, since ordinary
    // Stock/Operating Round replay always needs a clean baseline for both
    // regardless of the waterfall's own conclusion state. The matching
    // private-company catalog re-spawn is conditional instead -- see above.
    public_company::spawn_core_public_companies(deps.storage, game_id)?;
    hardware::spawn_hardware_pool(deps.storage, game_id)?;

    SESSIONS.save(deps.storage, game_id, &session)?;

    // ---- 2. Fast-forward: replay every remaining action, in order ----
    for record in replay_log {
        match record.clone() {
            ActionRecord::BidOnPrivate {
                player,
                private_id,
                bid_amount,
            } => {
                auction::execute_bid_on_private(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    private_id,
                    bid_amount,
                )?;
            }
            ActionRecord::BuyStock {
                player,
                protocol_id,
                source,
                par_value,
                quantity,
            } => {
                trading::execute_buy_stock(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    protocol_id,
                    source,
                    par_value,
                    quantity,
                )?;
            }
            ActionRecord::SellStock {
                player,
                protocol_id,
                percentage,
            } => {
                trading::execute_sell_stock(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    protocol_id,
                    percentage,
                )?;
            }
            ActionRecord::DeclareDividends {
                player,
                protocol_id,
                revenue_amount,
                distribute,
            } => {
                trading::execute_declare_dividends(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    protocol_id,
                    revenue_amount,
                    distribute,
                )?;
            }
            ActionRecord::LayTile {
                player,
                protocol_id,
                q,
                r,
                tile_id,
                orientation,
            } => {
                hexmap::execute_lay_tile(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    protocol_id,
                    q,
                    r,
                    tile_id,
                    orientation,
                )?;
            }
            ActionRecord::BuyTrainFromCorporation {
                player,
                buyer_protocol_id,
                seller_protocol_id,
                model_type,
                price,
            } => {
                train_trade::execute_buy_train_from_corporation(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    buyer_protocol_id,
                    seller_protocol_id,
                    model_type,
                    price,
                )?;
            }
            ActionRecord::AcceptTrainOffer { player, offer_id } => {
                train_trade::execute_accept_train_offer(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    offer_id,
                )?;
            }
            ActionRecord::RejectTrainOffer { player, offer_id } => {
                train_trade::execute_reject_train_offer(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    offer_id,
                )?;
            }
            ActionRecord::RescindTrainOffer { player, offer_id } => {
                train_trade::execute_rescind_train_offer(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    offer_id,
                )?;
            }
            ActionRecord::AdvanceOperatingSubPhase { player, protocol_id } => {
                operations::execute_advance_operating_sub_phase(
                    deps.branch(),
                    synthetic_info(player),
                    game_id,
                    protocol_id,
                )?;
            }
            ActionRecord::PlaceStationToken {
                player,
                protocol_id,
                q,
                r,
                city_index,
            } => {
                hexmap::execute_place_station_token(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    protocol_id,
                    q,
                    r,
                    city_index,
                )?;
            }
            ActionRecord::BuyHardwareFromPool {
                player,
                protocol_id,
            } => {
                hardware::execute_buy_hardware_from_pool(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    protocol_id,
                )?;
            }
            ActionRecord::BuyPrivateCompany {
                player,
                protocol_id,
                private_id,
                price,
            } => {
                trading::execute_buy_private_company(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    protocol_id,
                    private_id,
                    price,
                )?;
            }
            ActionRecord::PassTurn { player: _ } => {
                // The acting player was already validated when this action
                // was first recorded live (`execute_pass_turn`'s own check);
                // replay only needs to reproduce the resulting pointer
                // advance and consecutive-passes increment, not
                // re-authorize it.
                let mut session: GameSession = SESSIONS
                    .may_load(deps.storage, game_id)?
                    .ok_or(GameLogError::GameNotFound { game_id })?;
                let player_count = session.player_addresses.len() as u32;
                if player_count > 0 {
                    session.active_player_index = (session.active_player_index + 1) % player_count;
                }
                session.consecutive_passes = session
                    .consecutive_passes
                    .checked_add(1)
                    .ok_or(GameLogError::Overflow { game_id })?;
                // Mirrors the timestamp update `execute_pass_turn` itself
                // applies live -- this inline branch duplicates that
                // function's pointer/counter logic rather than calling it
                // (see the comment above), so it must duplicate this too to
                // stay behaviorally consistent with live play.
                session.last_action_timestamp = env.block.time.seconds();

                // Step 4.5 Batch 1, item 4: and it must duplicate the
                // end-of-Stock-Round conclusion for the same reason. A log
                // whose replay skipped this would silently lose every
                // sold-out price rise the live game had already applied, so
                // an `UndoLastAction` of some LATER action would quietly
                // roll back price movements that had nothing to do with it.
                // Same guard and same single-fire property as the live path.
                if player_count > 0
                    && session.current_round_type == RoundType::StockRound
                    && session.consecutive_passes >= player_count
                {
                    trading::conclude_stock_round(deps.storage, game_id, &mut session)?;
                }

                SESSIONS.save(deps.storage, game_id, &session)?;
            }
        }
    }

    Ok(())
}
