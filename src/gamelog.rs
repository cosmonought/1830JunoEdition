//! Event-Sourced Ledger: records every "replayable" game transaction to a
//! per-room, append-only `GAME_LOG`, and can recompute a room's entire
//! replayable state from scratch by resetting to genesis and re-running
//! that log -- the same technique 18xx.games itself uses for Undo, rather
//! than trying to write a bespoke "inverse" for every action.
//!
//! Design notes / scope, since this is a large feature built incrementally
//! on top of an already-substantial contract:
//!
//! 1. **What's in the log.** `ActionRecord` covers the actions that (a)
//!    move only Virtual Game Points, never real JUNO, and (b) mutate state
//!    through a single, already-pure handler function with no side channel
//!    this module can't also reset: `BidOnPrivate`, `BuyStock`,
//!    `SellStock`, `DeclareDividends`, `LayTile`, `BuyHardwareFromPool`,
//!    and the new `PassTurn`. `contract::execute` calls `record_action`
//!    right after each of these six pre-existing handlers returns `Ok`;
//!    `execute_pass_turn` records its own.
//! 2. **What's deliberately excluded**, and why:
//!    - `CreateGameRoom`/`JoinGameRoom`/`EndGameAndDistribute` move real
//!      JUNO via `BankMsg`, which can't be safely "replayed" (there's no
//!      way to re-attach historical `info.funds`, and re-issuing a
//!      `BankMsg` during a replay would double-spend real tokens). These
//!      also define the room's genesis, rather than being something to
//!      undo past.
//!    - `EmergencyBuyHardware` can durably halt the whole session
//!      (`GameSession::is_active = false`, see `hardware.rs`); undoing
//!      *past* a bankruptcy halt raises questions (does the room
//!      reactivate? what if players have already left?) deliberately left
//!      for a follow-up rather than answered by assumption here.
//!    - `ExecuteOperatingRound` batches revenue for every private company
//!      plus every listed public company in one message; replaying it
//!      correctly needs the exact same pathfinding inputs (laid track,
//!      owned Hardware) to still be true at replay time, which is a bigger
//!      reconciliation problem than this pass takes on.
//!    - `BeginOperatingRound` populates the Operating Round Corporation
//!      Turn Queue (`GameSession::active_operating_order`/
//!      `active_corporation_index` -- see `operations.rs`'s module doc
//!      comment) from whichever companies happen to be floated, at
//!      whatever price, *at the moment it's called* -- replaying it later
//!      could legitimately compute a different order if flotation or
//!      pricing history diverges by then, the same class of problem as
//!      `ExecuteOperatingRound` above. `reapply_game_log` instead just
//!      resets both fields to empty/`0` at genesis (see reset scope below)
//!      and leaves them there; re-establishing the queue after an undo is
//!      a fresh `BeginOperatingRound` call.
//! 3. **Reset scope.** `reapply_game_log`'s reset step returns every
//!    replayable piece of state to its game-genesis value: player cash
//!    (`PLAYER_CASH_VGP`, back to `contract::STARTING_CAPITAL_POOL /
//!    max_players`), the bank pool (`GameSession::virtual_bank_vgp`, reset
//!    to the immutable `GameSession::virtual_bank_start`), every core
//!    public company's shares (`PLAYER_SHARES`), IPO/Bank pools, par
//!    value, presidency, treasury, and market position, every core
//!    private company's ownership, every laid `Tile` (collected from the
//!    *pre-undo* log's `LayTile` entries, since `MAP_GRID`'s `(q, r)` key
//!    space has no static catalog to iterate the way public/private
//!    companies do), every protocol's network-hex set, the Hardware pool
//!    and every company's owned Hardware, and the turn/priority state
//!    (`active_player_index`/`priority_deal_index`/`consecutive_passes`,
//!    all reset to `0`, plus `active_operating_order`/
//!    `active_corporation_index`, reset to empty/`0` -- see the exclusion
//!    bullet above). `PRIVATE_BIDS` entries for addresses that are no
//!    longer any private's current owner after reset are deliberately left
//!    in place rather than explicitly swept -- they're inert (never read
//!    except through a private's live `owner` field, which reset always
//!    clears first, and any address that bids again during replay gets its
//!    entry freshly overwritten before it's ever read back) and clearing
//!    them would need another key-enumeration pass for no behavioral
//!    difference, just fewer stray entries sitting in storage.
//!    - The Pre-Game Waterfall Auction's five `Waterfall*` messages
//!      (`waterfall.rs`) join `BeginOperatingRound`/`ExecuteOperatingRound`
//!      as not recorded to `GAME_LOG`, for the same "automatic,
//!      multi-step cascading side effects" reason -- meaning this function
//!      has no log entries to recompute whether, or how far, the waterfall
//!      progressed. `reapply_game_log` instead reads the room's CURRENT
//!      `waterfall_auction_active` flag, before its own reset step
//!      overwrites it, as the one signal actually available: every
//!      loggable action type gated on that flag (`BuyStock`/`SellStock` in
//!      `trading.rs`, `BidOnPrivate` in `auction.rs`) can only ever have
//!      been recorded while it already read `false`, so a `false` reading
//!      here means the waterfall (won through real play, or bypassed
//!      entirely by a test harness) had already concluded by the time
//!      whatever this undo call is unwinding took place. In that case
//!      replay resumes directly in `RoundType::StockRound` with
//!      `waterfall_auction_active` still `false`, `priority_deal_index`/
//!      `last_private_winner` preserved exactly as they already are (both
//!      are permanently fixed the moment `waterfall::conclude_waterfall`
//!      runs, and nothing in `replay_log` can recompute them), and --
//!      since the six core privates' ownership was likewise settled by the
//!      unlogged waterfall, not by anything replayable -- `PRIVATE_COMPANIES`/
//!      `PRIVATE_BIDS`/`WATERFALL_MINI_AUCTION` are left untouched instead
//!      of reset. An earlier version of this function reset unconditionally
//!      back to `RoundType::WaterfallAuction` here regardless of the room's
//!      actual state, which meant ANY `UndoLastAction` call on a log
//!      containing so much as one Stock Round action hard-failed with
//!      `WaterfallAuctionInProgress` the instant replay reached it --
//!      caught by `undo_last_action_reverts_the_float_triggering_purchase`,
//!      a pre-existing test this waterfall feature had silently regressed.
//!      Only an undo that unwinds back through the waterfall itself (the
//!      flag still reads `true` right now) still re-opens the ENTIRE
//!      Waterfall Auction from scratch, exactly as originally documented --
//!      see `reapply_game_log`'s own reset step for the full branch, plus
//!      the one narrower gap this leaves open: a `BidOnPrivate` entry (the
//!      legacy fallback auction, still usable post-waterfall -- see
//!      `auction.rs`'s module doc comment #2) in a post-conclusion
//!      `replay_log` replays against a private already sitting in its
//!      currently-owned state rather than a freshly-reset unowned one, so
//!      it is not guaranteed to reproduce bit-for-bit. No test in this
//!      suite exercises that combination today.
//! 4. **Turn-order enforcement.** `BuyStock`, `SellStock`, and
//!    `BidOnPrivate` are now all turn-gated: each verifies `info.sender`
//!    matches `GameSession::player_addresses[active_player_index]` before
//!    touching any state (`trading::ensure_active_player` /
//!    `auction::ensure_active_player` -- small per-module copies rather
//!    than one shared helper, since each module has its own error enum),
//!    rejecting out-of-turn attempts with that module's own `NotYourTurn`
//!    variant. A successful call from any of these three then advances
//!    `active_player_index` to the next player and resets
//!    `consecutive_passes` to `0` (`trading::advance_turn` /
//!    `auction::advance_turn`), exactly mirroring the pointer half of what
//!    `PassTurn` does -- `PassTurn` instead *increments*
//!    `consecutive_passes`, since a pass extends an all-pass streak while a
//!    trade breaks one. `DeclareDividends`, `LayTile`,
//!    `BuyHardwareFromPool`, and `ExecuteOperatingRound` remain un-gated --
//!    left for a follow-up, since each has its own existing authorization
//!    story (President-only, Validator-only) that turn order would need to
//!    be layered onto rather than simply substituted for. Because these
//!    turn checks and pointer advances live inside the same handler
//!    functions replay calls (see #5), `reapply_game_log` reconstructs
//!    `active_player_index`/`consecutive_passes` correctly for free: replay
//!    re-validates the exact same turn order the actions already satisfied
//!    live, in the same order, so it can never diverge.
//! 5. **Why replay reuses the live handler functions.** `reapply_game_log`
//!    doesn't reimplement buy/sell/lay-tile/etc. logic -- it calls
//!    `auction::execute_bid_on_private`, `trading::execute_buy_stock`, and
//!    so on, exactly like `contract::execute` does live, just via
//!    `deps.branch()` in a loop with a synthetic zero-funds `MessageInfo`
//!    instead of the chain's real one. This guarantees replayed behavior
//!    can never drift from what actually happened live, since there's only
//!    one implementation of each rule, not two to keep in sync.

use cosmwasm_std::{Addr, DepsMut, Env, MessageInfo, Response, StdError, Uint128};
use thiserror::Error;

use crate::auction::{self, AuctionError};
use crate::contract::STARTING_CAPITAL_POOL;
use crate::hardware::{self, HardwareError};
use crate::hexmap::{self, HexMapError};
use crate::market::{self, MarketError};
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

/// Advances `game_id`'s turn pointer (`GameSession::active_player_index`)
/// to the next player in `player_addresses` order, wrapping around, and
/// increments `GameSession::consecutive_passes` by one -- the opposite of
/// what a successful turn-gated trade does to that counter (see
/// `trading::advance_turn`'s doc comment): a pass *extends* an all-pass
/// streak, a trade *breaks* one. Only the current active player may call
/// this. See module doc comment #4 for how far turn-order enforcement
/// reaches beyond this one action.
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
    SESSIONS.save(deps.storage, game_id, &session)?;

    record_action(
        deps.storage,
        game_id,
        ActionRecord::PassTurn {
            player: info.sender.clone(),
        },
    )?;

    let new_active_player = &session.player_addresses[session.active_player_index as usize];

    Ok(Response::new()
        .add_attribute("action", "pass_turn")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("passed_player", info.sender)
        .add_attribute(
            "new_active_player_index",
            session.active_player_index.to_string(),
        )
        .add_attribute("new_active_player", new_active_player.as_str())
        .add_attribute("consecutive_passes", session.consecutive_passes.to_string()))
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

/// Resets `game_id`'s entire replayable state to genesis, then
/// fast-forwards through `replay_log` in order (each entry re-applied by
/// calling the exact same handler function live play uses -- see module
/// doc comment #5). `previously_laid_tiles` is the manifest of every
/// `(q, r)` `MAP_GRID` needs cleared before replay begins; see
/// `execute_undo_last_action` for how it's derived. See the module doc
/// comment for exactly what "genesis" means here and what's deliberately
/// out of scope.
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

    // Pre-Game Waterfall Auction (see `waterfall.rs`'s module doc comment
    // #6, and this file's own module doc comment #2): none of its five
    // `Waterfall*` messages are recorded to `GAME_LOG`, so this function has
    // no log entries to recompute whether, or how far, the waterfall
    // progressed. The one signal actually available is the room's CURRENT
    // `waterfall_auction_active` flag, captured here BEFORE the reset step
    // below overwrites it: every loggable action type that's actually gated
    // on it (`trading::execute_buy_stock`/`execute_sell_stock`,
    // `auction::execute_bid_on_private`) can only ever have been recorded
    // while that flag already read `false`. So if it reads `false` right
    // now, the room's waterfall phase (won through real play, or bypassed
    // entirely by a test harness -- see `tests::skip_waterfall_auction`) had
    // already concluded by the time whatever action this undo call is
    // unwinding took place, and replay MUST resume from that same
    // post-waterfall phase: resetting all the way back to
    // `RoundType::WaterfallAuction` unconditionally (as an earlier version
    // of this function did) makes the very first `BuyStock`/`SellStock`/
    // `BidOnPrivate` entry in `replay_log` fail with
    // `WaterfallAuctionInProgress`, hard-failing the whole undo -- exactly
    // the regression `undo_last_action_reverts_the_float_triggering_purchase`
    // caught. If it reads `true`, this undo is unwinding something from
    // during (or before) the waterfall itself, and the scope gap documented
    // below still applies.
    let waterfall_already_concluded = !session.waterfall_auction_active;

    session.virtual_bank_vgp = session.virtual_bank_start;
    // Turn Priority Queue: reset all the way back to the room's absolute
    // genesis (`0`) only if the waterfall itself is what's being unwound.
    // Once the waterfall has concluded, `priority_deal_index` is fixed for
    // the rest of the game (`waterfall::conclude_waterfall` is its only
    // writer -- see module doc comment #2) and `active_player_index` must
    // resume from that exact same seat, not `0`, or the first replayed
    // Stock Round action could spuriously fail turn-order validation in any
    // room where the waterfall assigned Priority Deal to someone other than
    // the room creator.
    if waterfall_already_concluded {
        session.active_player_index = session.priority_deal_index;
    } else {
        session.active_player_index = 0;
        session.priority_deal_index = 0;
    }
    session.consecutive_passes = 0;
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
    // Macro Round Tracker: tied to the same non-replayable
    // `BeginOperatingRound`/`EndOperatingRoundTurn` pair (`operations.rs`'s
    // module doc comments #11/#12 mutate these three fields, plus
    // `active_operating_order`/`active_corporation_index` above), so
    // they're reset to their genesis values here rather than recomputed,
    // exactly like the two fields above. A room that wants the Operating
    // Round phase and its paced sub-round count back after an undo needs a
    // fresh `BeginOperatingRound` call, same as the turn queue itself.
    // `macro_round_number` is deliberately NOT reset here -- see that
    // field's own doc comment in `state.rs` for why a macro-round boundary
    // isn't treated as "replayable" state the same way an in-progress OR
    // turn queue is.
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

    for &company_id in &core_public_company_ids {
        IPO_POOL_SHARES.remove(deps.storage, (game_id, company_id));
        BANK_POOL_SHARES.remove(deps.storage, (game_id, company_id));
        PROTOCOL_PAR_VALUE.remove(deps.storage, (game_id, company_id));
        PROTOCOL_PRESIDENT.remove(deps.storage, (game_id, company_id));
        // Audit G-2: `PROTOCOL_TREASURY_VGP.remove(...)` used to sit here.
        // That map is gone -- corporate cash now lives solely in
        // `PublicCompany::treasury`, which the
        // `spawn_core_public_companies` call further down already resets to
        // its genesis value by fully overwriting each company record (see
        // the comment there). No replacement removal is needed.
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

    // Tile Inventory Supply Engine (Audit G-5): reset the tray to a full
    // genesis supply, in lockstep with clearing the board above. Every
    // `ActionRecord::LayTile` still in `replay_log` re-consumes (and, for
    // an upgrade, re-recycles) its own tile as it is replayed below, so the
    // tray always lands exactly where the surviving prefix of the event log
    // says it should -- the same reset-then-replay contract every other
    // registry here follows. Without this, an undone tile lay would leave
    // its copy permanently missing from the tray even though the tile is no
    // longer on the board.
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
            } => {
                trading::execute_buy_stock(
                    deps.branch(),
                    env.clone(),
                    synthetic_info(player),
                    game_id,
                    protocol_id,
                    source,
                    par_value,
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
                SESSIONS.save(deps.storage, game_id, &session)?;
            }
        }
    }

    Ok(())
}
