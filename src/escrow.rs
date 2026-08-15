//! **Escrow: every path real JUNO takes into, around, and out of this
//! contract.**
//!
//! Step 4.5 Batch 3 extracted this module out of `contract.rs`. The split is
//! along a single line, and it is worth stating precisely because it is the
//! rule for what belongs here: this module deals in the NATIVE TOKEN
//! (`ujuno`) -- real money, held by the contract, moved with `BankMsg`.
//! Everything on the other side of that line -- Virtual Game Points, share
//! percentages, market positions, train rosters -- stays in the game modules
//! and never appears here. `finalize_and_distribute_payouts` is the one
//! place the two meet, and it does so through a single read-only call into
//! the appraiser (`contract::appraise_player_net_worth`) rather than by
//! reaching into game state itself.
//!
//! ## What lives here
//!
//! 1. **The token constants.** `NATIVE_DENOM`, `BPS_DENOMINATOR`,
//!    `MINIMUM_ANTE`, `INACTIVITY_TIMEOUT_SECONDS`. `contract.rs` re-exports
//!    all four, so `contract::NATIVE_DENOM` and friends keep resolving for
//!    every existing caller and for the frontend's generated schema.
//! 2. **Deposit intake.** `require_native_deposit` (exactly one non-zero coin
//!    of the native denom) and `split_deposit` (that amount, cleanly divided
//!    into the developer subsidy and the net that actually reaches the
//!    room's pool). Room creation and room entry both route through
//!    `split_deposit`, so there is exactly one definition of what a deposit
//!    is worth.
//! 3. **The Ante Floor (Batch 3, item 4).** `MINIMUM_ANTE` is a hard on-chain
//!    safety net, nothing more. A CosmWasm contract cannot query live gas
//!    prices, so it cannot compute a sensible stake itself; the frontend
//!    does that (roughly "current gas price x 400 transactions") and puts the
//!    result in the `CreateGameRoom` deposit. This module's only job is to
//!    refuse a table funded so thinly that its own players could not afford
//!    to play it out. See `require_minimum_ante`.
//! 4. **Payout.** `finalize_and_distribute_payouts` (proportional to final
//!    net worth) and its creator-invoked wrapper
//!    `execute_end_game_and_distribute`.
//! 5. **Annulment.** `execute_annul_game` -- the abort path, which refunds
//!    antes directly and never touches the payout math.
//!
//! ## Payout and annulment are different machines (Batch 3, item 2)
//!
//! These two exits must not be confused, and before this pass the contract
//! had drifted toward doing so:
//!
//! - **`EndGameAndDistribute` is a RESULT.** The game reached a natural
//!   conclusion -- the $350 trigger, a broken bank, or the creator calling
//!   it -- and the pool is divided by how well each player actually played,
//!   proportional to final VGP net worth. Someone can win. Someone can walk
//!   away with less than they anted, which is the entire point of playing.
//! - **`AnnulGame` is a NON-RESULT.** The table is being torn down without a
//!   game having happened: abandoned, stuck, or called off. Nobody won, so
//!   nothing is scored. Every player gets their own money back, and the
//!   payout math is bypassed entirely rather than run over a half-finished
//!   position. Running the proportional split here would hand a real-JUNO
//!   prize to whoever happened to be ahead when the room stalled, which is
//!   indistinguishable from a rage-quit exploit.
//!
//! `ExecuteMsg::ClaimTimeoutRefund` used to be a third, narrower exit that
//! only fired on the 48-hour timeout. It is GONE, folded into `AnnulGame`
//! along with its solvency handling -- one refund path, so the two can never
//! disagree about what a player is owed.
//!
//! ## Solvency (Audit G-11, preserved verbatim through the move)
//!
//! `PLAYER_JUNO_ANTE` records each player's GROSS deposit, but the subsidy
//! cut leaves for the developer treasury the moment it is taken, so only the
//! net ever reaches the pool. Refunding the gross would try to pay out more
//! than the room holds. Every refund is therefore
//! `ante - subsidy_cut(ante)`, which sums to exactly `total_juno_pool` and
//! can never overdraw the contract's balance.

use cosmwasm_std::{
    Addr, BankMsg, Coin, DepsMut, Env, MessageInfo, Response, StdError, StdResult, Uint128,
};

use crate::contract::{appraise_player_net_worth, ContractError};
use crate::state::{GameSession, CONFIG, PLAYER_JUNO_ANTE, SESSIONS};

/// Native denom used for all real-money (lobby pool) operations on Juno.
pub const NATIVE_DENOM: &str = "ujuno";

/// Basis-point denominator: `subsidy_fee_percentage / BPS_DENOMINATOR` is the
/// fraction of each deposit routed to the developer treasury.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Inactivity Timeout Safety Valve threshold, in seconds (48 hours). See
/// `state.rs`'s `GameSession::last_action_timestamp` doc comment and
/// `execute_annul_game`.
pub const INACTIVITY_TIMEOUT_SECONDS: u64 = 172_800;

/// **Step 4.5 Batch 3, item 4: the Ante Floor.** The smallest real-JUNO
/// deposit that may open a game room, in `ujuno` (2 JUNO).
///
/// This is a SAFETY NET, not a pricing mechanism, and the distinction
/// matters. A CosmWasm contract has no way to read live network gas prices,
/// so it cannot possibly compute what a table ought to cost; the frontend
/// does that off-chain when it builds the `CreateGameRoom` payload (roughly
/// "current gas price x 400 transactions" -- a full 1830 match's worth of
/// signatures) and attaches the result. All this constant does is refuse a
/// room funded so thinly that the game could not be played to its end --
/// which would strand every joiner's ante in a table nobody can finish.
///
/// Deliberately a compile-time constant rather than an `InstantiateMsg`
/// parameter: a deployer-supplied floor could be set to zero, which would
/// defeat the entire check, and the value protects players rather than the
/// deployer.
pub const MINIMUM_ANTE: Uint128 = Uint128::new(2_000_000);

/// How a single real-JUNO deposit divides.
pub struct DepositSplit {
    /// The full attached amount, exactly as recorded in `PLAYER_JUNO_ANTE`.
    pub gross: Uint128,
    /// The developer gas-subsidy cut, forwarded out of the contract
    /// immediately.
    pub subsidy: Uint128,
    /// What actually reaches `GameSession::total_juno_pool`.
    pub net_pool: Uint128,
}

/// Requires `info.funds` to contain exactly one non-zero coin of
/// `NATIVE_DENOM`, returning its amount.
pub fn require_native_deposit(info: &MessageInfo) -> Result<Uint128, ContractError> {
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

/// The developer gas-subsidy cut taken from a real-JUNO deposit:
/// `deposit * subsidy_fee_percentage / BPS_DENOMINATOR`, floor-divided,
/// using only checked deterministic `Uint128` math (no floats).
///
/// Extracted (Audit G-11) so room creation, room entry, and annulment all
/// compute the identical figure from the identical formula.
///
/// `GameConfig::subsidy_fee_percentage` is written once, at `instantiate`,
/// and never updated anywhere in this contract, so re-deriving a past
/// deposit's cut at refund time always reproduces the exact value that was
/// taken at deposit time. If a config-update handler is ever added, this
/// assumption breaks and the refund path below must store the net figure
/// instead of recomputing it.
pub fn subsidy_cut(
    deposit: Uint128,
    subsidy_fee_percentage: u64,
) -> Result<Uint128, ContractError> {
    deposit
        .checked_mul(Uint128::from(subsidy_fee_percentage))
        .map_err(|_| ContractError::Overflow {})?
        .checked_div(Uint128::from(BPS_DENOMINATOR as u64))
        .map_err(|_| ContractError::Overflow {})
}

/// Validates the attached deposit and splits it. The single intake point for
/// real JUNO -- both `CreateGameRoom` and `JoinGameRoom` go through here, so
/// a deposit can never be valued one way at creation and another at entry.
pub fn split_deposit(
    info: &MessageInfo,
    subsidy_fee_percentage: u64,
) -> Result<DepositSplit, ContractError> {
    let gross = require_native_deposit(info)?;
    let subsidy = subsidy_cut(gross, subsidy_fee_percentage)?;
    let net_pool = gross
        .checked_sub(subsidy)
        .map_err(|_| ContractError::Overflow {})?;
    Ok(DepositSplit {
        gross,
        subsidy,
        net_pool,
    })
}

/// **Step 4.5 Batch 3, item 4.** Rejects a room-creation deposit below
/// `MINIMUM_ANTE`. Applied ONLY to the deposit that opens a room: the
/// creator's stake becomes that room's `room_ante`, and every joiner is then
/// held to that exact figure (see `contract::execute_join_game_room`), so
/// checking the floor once at creation transitively guarantees it for the
/// whole table.
pub fn require_minimum_ante(deposit: Uint128) -> Result<(), ContractError> {
    if deposit < MINIMUM_ANTE {
        return Err(ContractError::InsufficientAnte {
            minimum: MINIMUM_ANTE,
            got: deposit,
        });
    }
    Ok(())
}

/// Builds the `BankMsg` forwarding a subsidy cut to the developer treasury,
/// or `None` when the cut rounded to zero (a dust deposit, or a room
/// instantiated with a `0` fee). Returning `None` rather than a zero-amount
/// message matters: chains reject a `BankMsg::Send` carrying no coins.
pub fn subsidy_transfer(treasury: &Addr, subsidy: Uint128) -> Option<BankMsg> {
    if subsidy.is_zero() {
        return None;
    }
    Some(BankMsg::Send {
        to_address: treasury.to_string(),
        amount: vec![Coin {
            denom: NATIVE_DENOM.to_string(),
            amount: subsidy,
        }],
    })
}

/// Creator-invoked close-out. Only the room creator may finalize a game this
/// way -- contrast the automatic $350 Game-End Trigger
/// (`finalize_and_distribute_payouts`'s other callers), which is a
/// rules-mandated event with no single authorizing player.
pub fn execute_end_game_and_distribute(
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

    if info.sender != session.creator {
        return Err(ContractError::Unauthorized {});
    }

    Ok(finalize_and_distribute_payouts(deps, game_id, session)?)
}

/// Shared close-out core for the creator-invoked `EndGameAndDistribute`
/// message and the automatic $350 Game-End Trigger
/// (`market::GAME_END_PRICE_TRIGGER`, checked in `trading.rs`,
/// `operations.rs` and `hardware.rs` immediately after any ascending market
/// movement). Sums every registered player's final VGP net worth fresh from
/// this room's own on-chain ledger, splits the real-JUNO lobby pool
/// proportionally, marks the room inactive, and returns the payout
/// `Response` for the caller to use directly or fold into a larger one.
///
/// Takes an already-loaded `session` by value and performs NO authorization
/// check itself -- every caller already did its own before reaching here.
///
/// Returns a plain `StdResult<Response>` rather than `ContractError`
/// specifically so `TradingError`/`OperationsError`/`HardwareError` callers
/// -- which have no `From<ContractError>` conversion, matching this crate's
/// convention of error enums only ever depending "downward" -- can propagate
/// it through their own `Std(#[from] StdError)` variant with a plain
/// `.map_err(...)?` rather than a new cross-module `From` impl.
pub(crate) fn finalize_and_distribute_payouts(
    deps: DepsMut,
    game_id: u64,
    mut session: GameSession,
) -> StdResult<Response> {
    // Every registered player's final VGP net worth, computed fresh from
    // this room's own ledger. Takes `deps.as_ref()` because the appraiser is
    // read-only and shared with the `Deps`-only query layer; the immutable
    // borrow ends with each call, leaving `deps.storage` free for the
    // mutable `SESSIONS.save` further down.
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
        // proportional percentage of total wealth applied to the real JUNO
        // pool, using checked fixed-point Uint128 math throughout.
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

    // Integer division can leave a small remainder undistributed; sweep it to
    // the developer treasury so it never sits stranded in contract state.
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
    // the reentrancy guidance in juno_developer_spec.md. This is also exactly
    // what "halt all further player turns" means in practice: every gameplay
    // handler in this crate checks `session.is_active` first thing, so
    // flipping it here rejects every subsequent action regardless of whatever
    // the turn pointer nominally says.
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

/// **Step 4.5 Batch 3, items 2 and 3: game annulment.**
///
/// Tears a room down WITHOUT scoring it and refunds every player their own
/// ante, net of the subsidy already forwarded to the developer treasury.
/// Deliberately bypasses `finalize_and_distribute_payouts` entirely: see this
/// module's doc comment for why running the proportional split on an aborted
/// game would be a rage-quit exploit rather than a payout.
///
/// **Who may call it -- the permissionless escape hatch (item 3).** Two
/// tiers, and the second is the one that matters:
///
/// - **The room creator, at any time.** The host called the table off. No
///   waiting period, because there is nobody to protect from them: every
///   player gets exactly their own money back, so the creator gains nothing
///   by annulling early. The worst they can do is end a game other players
///   were enjoying, which is a social problem, not a financial one.
/// - **ANY registered player, once the room has been silent for
///   `INACTIVITY_TIMEOUT_SECONDS` (48 hours).** This is the real safety
///   valve. Without it, a creator who walks away -- or loses their keys --
///   locks every other player's real JUNO in the contract permanently.
///   `GameSession::last_action_timestamp` is refreshed by every
///   state-advancing handler, so the clock only runs while the room is
///   genuinely idle.
///
/// The comparison is `>=`, not `>`: at exactly the timeout boundary the room
/// has been idle for the full 48 hours and the valve is open. A player whose
/// funds are already stuck should not be made to wait an extra block for a
/// strictly-greater-than.
///
/// A non-player cannot annul under either tier, timeout or not.
pub fn execute_annul_game(
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

    let is_creator = info.sender == session.creator;
    if !is_creator && !session.player_addresses.contains(&info.sender) {
        return Err(ContractError::NotAPlayer {
            game_id,
            player: info.sender.to_string(),
        });
    }

    let timeout_at = session
        .last_action_timestamp
        .checked_add(INACTIVITY_TIMEOUT_SECONDS)
        .ok_or(ContractError::Overflow {})?;
    let timed_out = env.block.time.seconds() >= timeout_at;

    // The permission gate. A non-creator needs the timeout; the creator
    // never does.
    if !is_creator && !timed_out {
        return Err(ContractError::TimeoutNotYetElapsed {
            game_id,
            timeout_seconds: INACTIVITY_TIMEOUT_SECONDS,
        });
    }

    // State is finalized before any BankMsg is dispatched, consistent with
    // the reentrancy guidance in juno_developer_spec.md (same pattern as
    // `finalize_and_distribute_payouts`).
    session.is_active = false;
    session.total_juno_pool = Uint128::zero();
    SESSIONS.save(deps.storage, game_id, &session)?;

    // Refund each player exactly their own original ante -- never a
    // recomputed or proportional split -- read straight from
    // `PLAYER_JUNO_ANTE`, defaulting to zero for a (registered but never
    // funded) player who somehow joined without attaching any coin.
    //
    // Under the Uniform Ante Rule every entry here is identical, so "each
    // player's own ante" and "an equal share of the pool" are the same
    // number. Refunding from the per-player record rather than dividing the
    // pool is still the right construction: it stays correct by definition
    // if the ante rule is ever relaxed, and it cannot silently redistribute
    // between players the way a division would.
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

        // Audit G-11: refund the NET contribution, not the gross ante -- the
        // subsidy cut left the contract for the developer treasury at deposit
        // time and was never part of this room's pool.
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
        .add_attribute("action", "annul_game")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("annulled_by", info.sender)
        .add_attribute(
            "authority",
            if is_creator {
                "room_creator"
            } else {
                "inactivity_timeout"
            },
        )
        .add_attribute("timed_out", timed_out.to_string())
        .add_attribute("total_refunded", total_refunded)
        .add_attribute("total_subsidy_withheld", total_subsidy_withheld))
}
