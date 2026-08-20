//! Pre-Game Waterfall Auction Engine: the canonical 1830 mechanism for allocating
//! all six privates before Stock Round 1 opens. Every room genesis starts here,
//! and `conclude_waterfall` is the one and only exit.
//!
//!   BUY LOWEST   pays face value in cash for whichever private is currently the
//!                cheapest unowned one. This is the ONLY way to acquire that
//!                specific private -- it can never be bid on, because if it
//!                could, turn one could immediately produce a 2+-bid tie on the
//!                very first private with zero information exchanged.
//!   BID HIGHER   escrows a bid on any OTHER unowned private, at face value or
//!                the standing high bid plus the minimum increment.
//!   PASS         ALWAYS legal on your turn. It used to require that some
//!                private already carried a bid, which made the opening position
//!                of the game a FORCED MOVE -- you could buy or bid, but not
//!                decline.
//!
//! THE CASCADE resolves automatically after every win: 0 bids on the new cheapest
//! private returns control to players, 1 bid auto-wins and loops, 2+ starts a
//! mini-auction and pauses. The mini-auction runs in SEATING order among the tied
//! bidders only, and auto-skips the current high bidder's own turns -- they have
//! nothing to decide while already winning.
//!
//! A FULL ROUND OF PASSES RUNS THE WATERFALL; IT DOES NOT END IT. The cheapest
//! private's price drops $5, every already-owned private pays its revenue, and at
//! $0 the company is forced free on whoever's turn it is. This replaced a blunter
//! rule that refunded every bid and concluded the phase outright -- which
//! terminated the auction in exactly the situation where the real game is only
//! getting started, and meant a table that collectively did not want the cheapest
//! private simply skipped the rest of the auction rather than discovering a price
//! at which somebody did.
//!
//! THE PHASE STILL ALWAYS TERMINATES, and now for a better reason: the price is
//! monotonically non-increasing, $0 is reachable in a finite number of rounds,
//! and a $0 company is forced on a player rather than offered.
//!
//! `conclude_waterfall` assigns Stock Round 1's Priority Deal to whoever sits
//! immediately left of the last private's winner.
//!
//! NOT REPLAYABLE: none of the five messages are recorded to `GAME_LOG`, matching
//! the precedent for automatic, multi-step cascading side effects.
//!
//! See docs/ai_architecture/rust_contract_architecture.md, waterfall.rs.

use cosmwasm_std::{Addr, Attribute, DepsMut, Env, MessageInfo, Order, Response, StdError, StdResult, Storage, Uint128};
use thiserror::Error;

use crate::auction::{self, AuctionError};
use crate::operations;
use crate::state::{
    GameSession, PrivateCompany, RoundType, WaterfallMiniAuction, PLAYER_CASH_VGP,
    PRIVATE_BIDS, PRIVATE_COMPANIES, SESSIONS, WATERFALL_MINI_AUCTION,
};

/// **Step 4.5 Batch 4.** How much the cheapest unowned private company's face
/// value falls each time every player passes consecutively -- the canonical
/// 1830 figure.
///
/// This is what guarantees the auction terminates: the price is monotonically
/// non-increasing and the floor is reachable in a finite number of rounds, at
/// which point `execute_waterfall_pass` forces the company on someone. Without
/// it, a table where nobody wants Schuylkill Valley could pass forever.
pub const WATERFALL_PASS_PRICE_DROP: Uint128 = Uint128::new(5);

#[derive(Error, Debug)]
pub enum WaterfallError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Auction(#[from] AuctionError),

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error("Game room {game_id}'s Waterfall Auction has already concluded")]
    WaterfallNotActive { game_id: u64 },

    #[error(
        "Game room {game_id} has a Waterfall Auction mini-auction in progress -- only WaterfallMiniAuctionRaise/WaterfallMiniAuctionPass are valid until it resolves"
    )]
    MiniAuctionInProgress { game_id: u64 },

    #[error("Game room {game_id} has no Waterfall Auction mini-auction currently in progress")]
    NoMiniAuctionInProgress { game_id: u64 },

    #[error("{player} is not a registered player in game room {game_id}")]
    NotAPlayer { game_id: u64, player: String },

    #[error(
        "It is not {got}'s turn in game room {game_id}'s Waterfall Auction; {expected} must act first"
    )]
    NotYourTurn {
        game_id: u64,
        expected: String,
        got: String,
    },

    #[error(
        "It is not {got}'s turn in game room {game_id}'s Waterfall Auction mini-auction; {expected} must act first"
    )]
    NotYourMiniAuctionTurn {
        game_id: u64,
        expected: String,
        got: String,
    },

    #[error("Game room {game_id} has no private companies left unowned")]
    NoPrivatesRemaining { game_id: u64 },

    #[error("Private company {private_id} was not found in game room {game_id}")]
    PrivateNotFound { game_id: u64, private_id: u32 },

    #[error(
        "Private company {private_id} is the current lowest-offered private -- it can only be bought outright via WaterfallBuyLowest, never bid on"
    )]
    CannotBidOnLowest { private_id: u32 },

    #[error("Private company {private_id} is already owned and no longer available")]
    PrivateAlreadyOwned { private_id: u32 },

    #[error("{player} already has a standing bid on private company {private_id}")]
    AlreadyBidding { private_id: u32, player: String },

    #[error(
        "Bid must be at least {minimum} VGP (the current standing bid plus the minimum {increment} VGP increment, or the private's face value if it has no bidder yet)"
    )]
    BidTooLow {
        minimum: Uint128,
        increment: Uint128,
    },

    #[error("Player {player} does not have enough VGP to place this bid")]
    InsufficientFunds { player: String },

    #[error(
        "Passing is not permitted in game room {game_id}'s Waterfall Auction while no private company has an active bid -- every player must Buy Lowest or Bid Higher until at least one bid exists"
    )]
    PassNotAllowed { game_id: u64 },

    #[error(
        "Game room {game_id}'s mini-auction leader cannot pass -- this should be unreachable (their own turns are auto-skipped)"
    )]
    LeaderCannotPass { game_id: u64 },

    #[error("Arithmetic overflow/underflow while processing a Waterfall Auction action")]
    Overflow {},
}

/// Verifies `sender` is the player currently sitting at
/// `session.active_player_index` -- the Waterfall Auction's own copy of the
/// same Turn Priority Queue guardrail `auction.rs`/`trading.rs` each keep
/// (see `auction::ensure_active_player`'s doc comment for why these stay
/// separate, small, per-module copies rather than a shared helper).
fn ensure_active_player(
    session: &GameSession,
    game_id: u64,
    sender: &Addr,
) -> Result<(), WaterfallError> {
    let active_player = session
        .player_addresses
        .get(session.active_player_index as usize)
        .cloned()
        .ok_or(WaterfallError::GameNotFound { game_id })?;
    if sender != &active_player {
        return Err(WaterfallError::NotYourTurn {
            game_id,
            expected: active_player.to_string(),
            got: sender.to_string(),
        });
    }
    Ok(())
}

/// Advances `session.active_player_index` to the next seated player
/// (wrapping) -- the purely mechanical half of turn advancement. Callers
/// are responsible for `GameSession::consecutive_waterfall_passes`
/// themselves (reset on a commit, increment on a pass) since the two
/// actions disagree on which to do -- mirrors `gamelog::execute_pass_turn`
/// not delegating that decision to a shared helper either.
fn advance_waterfall_turn(session: &mut GameSession) {
    let player_count = session.player_addresses.len() as u32;
    if player_count > 0 {
        session.active_player_index = (session.active_player_index + 1) % player_count;
    }
}

/// Returns whichever `auction::CORE_PRIVATE_COMPANIES` entry is cheapest
/// among those still unowned (`owner`/`owner_protocol_id` both `None`) and
/// not `closed` -- `CORE_PRIVATE_COMPANIES` is already declared in
/// ascending face-value order, so this is a simple first-match scan, not a
/// sort. `None` once every private is owned (or, in principle, closed --
/// though nothing closes a private this early in a real game).
fn lowest_unowned_private_id(storage: &dyn Storage, game_id: u64) -> Result<Option<u32>, WaterfallError> {
    for (private_id, ..) in auction::CORE_PRIVATE_COMPANIES.iter().copied() {
        let Some(private) = PRIVATE_COMPANIES.may_load(storage, (game_id, private_id))? else {
            continue;
        };
        if private.owner.is_none() && private.owner_protocol_id.is_none() && !private.closed {
            return Ok(Some(private_id));
        }
    }
    Ok(None)
}

/// Every standing bid currently escrowed on `private_id`, as
/// `(bidder, amount)` pairs -- reads `PRIVATE_BIDS`' `(game_id, private_id)`
/// prefix directly, so it naturally returns zero, one, or several entries
/// depending on how many players have independently bid on this specific
/// private so far.
fn collect_bids(
    storage: &dyn Storage,
    game_id: u64,
    private_id: u32,
) -> Result<Vec<(Addr, Uint128)>, WaterfallError> {
    PRIVATE_BIDS
        .prefix((game_id, private_id))
        .range(storage, None, None, Order::Ascending)
        .collect::<StdResult<Vec<(Addr, Uint128)>>>()
        .map_err(WaterfallError::from)
}

// REMOVED (Step 4.5 Batch 4): `any_private_has_bid`, which existed solely to
// gate `execute_waterfall_pass` on "some private somewhere already has a bid".
// Cold-start passing is now legal, so the gate is gone and nothing else ever
// asked the question. Deleted rather than left behind `#[allow(dead_code)]`:
// a helper kept alive only by an allow attribute is one someone eventually
// wires back up without reading why it was retired.

/// Refunds and clears every still-standing bid across all six privates -- used
/// only by the early-termination path, and necessary specifically there.
///
/// Every OTHER path that ends a private's bidding already resolves or refunds
/// each bid as part of winning it, so by the time all six are owned no stray
/// entries can remain. A full round of passes, though, can end the auction while
/// a private OTHER than the current lowest still holds never-cascaded-to bids --
/// and without this sweep that escrowed cash would simply vanish from its
/// bidder's balance forever, permanently unowned by anyone.
fn refund_all_standing_bids(
    storage: &mut dyn Storage,
    game_id: u64,
    attrs: &mut Vec<Attribute>,
) -> Result<(), WaterfallError> {
    for (private_id, ..) in auction::CORE_PRIVATE_COMPANIES.iter().copied() {
        let bids = collect_bids(storage, game_id, private_id)?;
        for (bidder, amount) in bids {
            let balance = PLAYER_CASH_VGP
                .may_load(storage, (game_id, bidder.clone()))?
                .unwrap_or_default();
            let refunded = balance
                .checked_add(amount)
                .map_err(|_| WaterfallError::Overflow {})?;
            PLAYER_CASH_VGP.save(storage, (game_id, bidder.clone()), &refunded)?;
            PRIVATE_BIDS.remove(storage, (game_id, private_id, bidder.clone()));
            attrs.push(Attribute::new(
                format!("waterfall_refunded_{private_id}_{bidder}"),
                amount.to_string(),
            ));
        }
    }
    Ok(())
}

/// **Step 4.5 Batch 4.** Refunds and clears every standing bid on ONE
/// private, optionally sparing `except` (the winner, whose escrow is being
/// consumed rather than returned).
///
/// The all-pass waterfall can hand a private to a player who never bid on it
/// -- see `execute_waterfall_pass`'s $0 force-assignment -- and any OTHER
/// player's escrow sitting on that private would then be stranded: the
/// company is owned, so no cascade will ever reach it again, and
/// `refund_all_standing_bids` only runs when the auction CONCLUDES. Without
/// this the cash would be permanently gone from a live game.
fn refund_bids_on_private(
    storage: &mut dyn Storage,
    game_id: u64,
    private_id: u32,
    except: Option<&Addr>,
    attrs: &mut Vec<Attribute>,
) -> Result<(), WaterfallError> {
    for (bidder, amount) in collect_bids(storage, game_id, private_id)? {
        if Some(&bidder) == except {
            continue;
        }
        let balance = PLAYER_CASH_VGP
            .may_load(storage, (game_id, bidder.clone()))?
            .unwrap_or_default();
        let refunded = balance
            .checked_add(amount)
            .map_err(|_| WaterfallError::Overflow {})?;
        PLAYER_CASH_VGP.save(storage, (game_id, bidder.clone()), &refunded)?;
        PRIVATE_BIDS.remove(storage, (game_id, private_id, bidder.clone()));
        attrs.push(Attribute::new(
            format!("waterfall_refunded_{private_id}_{bidder}"),
            amount.to_string(),
        ));
    }
    Ok(())
}

/// Finalizes `private_id`'s ownership. Does NOT touch player cash: the only
/// caller that owes fresh money deducts it before calling, and every other caller
/// already escrowed at bid time. Always clears the winner's own bid entry
/// (idempotent), records them for Priority Deal purposes, and -- if this is the
/// B&O private -- floats the public B&O.
fn resolve_private_win(
    storage: &mut dyn Storage,
    game_id: u64,
    session: &mut GameSession,
    private_id: u32,
    winner: Addr,
    price: Uint128,
    attrs: &mut Vec<Attribute>,
) -> Result<(), WaterfallError> {
    let mut private: PrivateCompany = PRIVATE_COMPANIES.load(storage, (game_id, private_id))?;
    private.owner = Some(winner.clone());
    PRIVATE_COMPANIES.save(storage, (game_id, private_id), &private)?;
    PRIVATE_BIDS.remove(storage, (game_id, private_id, winner.clone()));
    session.last_private_winner = Some(winner.clone());

    attrs.push(Attribute::new(
        format!("private_{private_id}_winner"),
        winner.as_str(),
    ));
    attrs.push(Attribute::new(
        format!("private_{private_id}_price"),
        price.to_string(),
    ));

    if private_id == auction::PRIVATE_BO_ID {
        auction::award_bo_president_share(storage, game_id, &winner)?;
        attrs.push(Attribute::new("bo_public_company_floated", "true"));
        attrs.push(Attribute::new("bo_president", winner.as_str()));
    }

    Ok(())
}

/// Starts a mini-auction among `private_id`'s current bidders (module doc
/// comment #3): builds `bidders` in the room's seating order (not raw
/// `PRIVATE_BIDS` iteration order, which is meaningless Addr-lexicographic
/// order unrelated to turn sequencing), seeds `high_bid`/`high_bidder` from
/// whichever pre-existing bid was highest, and points `turn_index` at the
/// seat immediately after the leader -- the leader themselves never needs
/// an explicit turn while already ahead (see `skip_leader_turns`).
fn start_mini_auction(
    storage: &mut dyn Storage,
    game_id: u64,
    session: &GameSession,
    private_id: u32,
    bids: Vec<(Addr, Uint128)>,
) -> Result<(), WaterfallError> {
    let bidders: Vec<Addr> = session
        .player_addresses
        .iter()
        .filter(|addr| bids.iter().any(|(bidder, _)| bidder == *addr))
        .cloned()
        .collect();

    let (high_bidder, high_bid) = bids
        .iter()
        .max_by_key(|(_, amount)| *amount)
        .map(|(addr, amount)| (addr.clone(), *amount))
        .ok_or(WaterfallError::Overflow {})?;

    if bidders.is_empty() {
        return Err(WaterfallError::Overflow {});
    }
    let leader_pos = bidders.iter().position(|a| a == &high_bidder).unwrap_or(0);
    let turn_index = ((leader_pos + 1) % bidders.len()) as u32;

    WATERFALL_MINI_AUCTION.save(
        storage,
        game_id,
        &WaterfallMiniAuction {
            private_id,
            bidders,
            turn_index,
            high_bid,
            high_bidder,
        },
    )?;
    Ok(())
}

/// Moves the mini-auction cursor past every consecutive slot held by the current
/// high bidder: the leader never needs an explicit prompt while already winning.
/// `guard` bounds the loop at `bidders.len()` so a degenerate single-bidder state
/// can never spin forever.
fn skip_leader_turns(mini: &mut WaterfallMiniAuction) {
    let len = mini.bidders.len() as u32;
    if len == 0 {
        return;
    }
    let mut guard = 0;
    while mini.bidders[mini.turn_index as usize] == mini.high_bidder && guard < len {
        mini.turn_index = (mini.turn_index + 1) % len;
        guard += 1;
    }
}

/// Called right after a successful `WaterfallMiniAuctionRaise`: advances to
/// the very next seat, then applies `skip_leader_turns` (the raiser is now
/// the leader, so this naturally skips them right back if the next seat
/// happens to already be theirs -- it can't be, immediately after their own
/// action, but this keeps the same invariant enforced uniformly rather than
/// relying on that reasoning holding at every call site).
fn advance_mini_auction_turn_after_raise(mini: &mut WaterfallMiniAuction) {
    let len = mini.bidders.len() as u32;
    if len == 0 {
        return;
    }
    mini.turn_index = (mini.turn_index + 1) % len;
    skip_leader_turns(mini);
}

/// The Waterfall Cascade: repeatedly inspects whichever private is now cheapest
/// among the unowned, resolving automatically for as long as it can -- 0 bids
/// stops and returns control, 1 bid auto-wins and loops, 2+ starts a mini-auction
/// and stops. Once every private is owned it calls `conclude_waterfall`.
fn run_cascade(
    storage: &mut dyn Storage,
    game_id: u64,
    session: &mut GameSession,
    attrs: &mut Vec<Attribute>,
) -> Result<(), WaterfallError> {
    loop {
        let Some(next_id) = lowest_unowned_private_id(storage, game_id)? else {
            conclude_waterfall(session, attrs);
            return Ok(());
        };
        let bids = collect_bids(storage, game_id, next_id)?;
        match bids.len() {
            0 => return Ok(()),
            1 => {
                let (bidder, amount) = bids.into_iter().next().expect("len checked == 1 above");
                resolve_private_win(storage, game_id, session, next_id, bidder, amount, attrs)?;
                // Loop again: this resolution may have unblocked another
                // still-lower... no -- ANOTHER newly-cheapest private right
                // behind it (the cascade only ever moves forward).
            }
            _ => {
                start_mini_auction(storage, game_id, session, next_id, bids)?;
                attrs.push(Attribute::new(
                    "waterfall_mini_auction_started",
                    next_id.to_string(),
                ));
                return Ok(());
            }
        }
    }
}

/// Ends the Waterfall Auction: flips the phase flags for good, resets the pass
/// streak, and assigns Stock Round 1's Priority Deal (and, following from what
/// Priority Deal actually means, the active seat too) to whoever sits immediately
/// left of the last private's winner -- or leaves it untouched if no private was
/// ever won.
fn conclude_waterfall(session: &mut GameSession, attrs: &mut Vec<Attribute>) {
    session.waterfall_auction_active = false;
    session.current_round_type = RoundType::StockRound;
    session.consecutive_waterfall_passes = 0;

    if let Some(winner) = session.last_private_winner.clone() {
        if let Some(idx) = session.player_addresses.iter().position(|a| a == &winner) {
            let player_count = session.player_addresses.len() as u32;
            if player_count > 0 {
                session.priority_deal_index = ((idx as u32) + 1) % player_count;
            }
        }
    }
    session.active_player_index = session.priority_deal_index;

    attrs.push(Attribute::new("waterfall_auction_concluded", "true"));
    attrs.push(Attribute::new(
        "priority_deal_index",
        session.priority_deal_index.to_string(),
    ));
    attrs.push(Attribute::new("current_round_type", "StockRound"));
}

/// Buys whichever private is currently the cheapest still-unowned one, at
/// its exact printed face value, right now -- module doc comment #1/#2.
pub fn execute_waterfall_buy_lowest(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
) -> Result<Response, WaterfallError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(WaterfallError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(WaterfallError::GameNotActive { game_id });
    }
    if !session.waterfall_auction_active {
        return Err(WaterfallError::WaterfallNotActive { game_id });
    }
    if WATERFALL_MINI_AUCTION.has(deps.storage, game_id) {
        return Err(WaterfallError::MiniAuctionInProgress { game_id });
    }
    if !session.player_addresses.contains(&info.sender) {
        return Err(WaterfallError::NotAPlayer {
            game_id,
            player: info.sender.to_string(),
        });
    }
    ensure_active_player(&session, game_id, &info.sender)?;

    let Some(lowest_id) = lowest_unowned_private_id(deps.storage, game_id)? else {
        return Err(WaterfallError::NoPrivatesRemaining { game_id });
    };
    let private: PrivateCompany = PRIVATE_COMPANIES.load(deps.storage, (game_id, lowest_id))?;
    let price = private.cost;

    let balance = PLAYER_CASH_VGP
        .may_load(deps.storage, (game_id, info.sender.clone()))?
        .unwrap_or_default();
    let new_balance = balance
        .checked_sub(price)
        .map_err(|_| WaterfallError::InsufficientFunds {
            player: info.sender.to_string(),
        })?;
    PLAYER_CASH_VGP.save(deps.storage, (game_id, info.sender.clone()), &new_balance)?;

    let mut attrs = vec![
        Attribute::new("action", "waterfall_buy_lowest"),
        Attribute::new("game_id", game_id.to_string()),
        Attribute::new("buyer", info.sender.as_str()),
        Attribute::new("private_id", lowest_id.to_string()),
        Attribute::new("price", price.to_string()),
    ];

    resolve_private_win(
        deps.storage,
        game_id,
        &mut session,
        lowest_id,
        info.sender.clone(),
        price,
        &mut attrs,
    )?;
    run_cascade(deps.storage, game_id, &mut session, &mut attrs)?;

    if session.waterfall_auction_active {
        session.consecutive_waterfall_passes = 0;
        advance_waterfall_turn(&mut session);
    }
    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(Response::new().add_attributes(attrs))
}

/// Places a bid on any still-unowned private OTHER than the current lowest
/// -- module doc comment #1/#2. Escrows `bid_amount` from the bidder's own
/// `PLAYER_CASH_VGP`; does not resolve the target private immediately
/// (that only ever happens once the Waterfall Cascade reaches it as the new
/// lowest -- module doc comment #3).
pub fn execute_waterfall_bid_higher(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
    private_id: u32,
    bid_amount: Uint128,
) -> Result<Response, WaterfallError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(WaterfallError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(WaterfallError::GameNotActive { game_id });
    }
    if !session.waterfall_auction_active {
        return Err(WaterfallError::WaterfallNotActive { game_id });
    }
    if WATERFALL_MINI_AUCTION.has(deps.storage, game_id) {
        return Err(WaterfallError::MiniAuctionInProgress { game_id });
    }
    if !session.player_addresses.contains(&info.sender) {
        return Err(WaterfallError::NotAPlayer {
            game_id,
            player: info.sender.to_string(),
        });
    }
    ensure_active_player(&session, game_id, &info.sender)?;

    let Some(lowest_id) = lowest_unowned_private_id(deps.storage, game_id)? else {
        return Err(WaterfallError::NoPrivatesRemaining { game_id });
    };
    if private_id == lowest_id {
        return Err(WaterfallError::CannotBidOnLowest { private_id });
    }
    let private: PrivateCompany = PRIVATE_COMPANIES
        .may_load(deps.storage, (game_id, private_id))?
        .ok_or(WaterfallError::PrivateNotFound { game_id, private_id })?;
    if private.owner.is_some() || private.owner_protocol_id.is_some() || private.closed {
        return Err(WaterfallError::PrivateAlreadyOwned { private_id });
    }
    if PRIVATE_BIDS.has(deps.storage, (game_id, private_id, info.sender.clone())) {
        return Err(WaterfallError::AlreadyBidding {
            private_id,
            player: info.sender.to_string(),
        });
    }

    let existing_bids = collect_bids(deps.storage, game_id, private_id)?;
    let minimum_bid = match existing_bids.iter().map(|(_, amount)| *amount).max() {
        None => private.cost,
        Some(current_high) => current_high
            .checked_add(auction::MIN_BID_INCREMENT)
            .map_err(|_| WaterfallError::Overflow {})?,
    };
    if bid_amount < minimum_bid {
        return Err(WaterfallError::BidTooLow {
            minimum: minimum_bid,
            increment: auction::MIN_BID_INCREMENT,
        });
    }

    let balance = PLAYER_CASH_VGP
        .may_load(deps.storage, (game_id, info.sender.clone()))?
        .unwrap_or_default();
    let new_balance =
        balance
            .checked_sub(bid_amount)
            .map_err(|_| WaterfallError::InsufficientFunds {
                player: info.sender.to_string(),
            })?;
    PLAYER_CASH_VGP.save(deps.storage, (game_id, info.sender.clone()), &new_balance)?;
    PRIVATE_BIDS.save(
        deps.storage,
        (game_id, private_id, info.sender.clone()),
        &bid_amount,
    )?;

    session.consecutive_waterfall_passes = 0;
    advance_waterfall_turn(&mut session);
    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(Response::new()
        .add_attribute("action", "waterfall_bid_higher")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("bidder", info.sender.clone())
        .add_attribute("private_id", private_id.to_string())
        .add_attribute("bid_amount", bid_amount))
}

/// **Step 4.5 Batch 4: the canonical 1830 all-pass waterfall.**
///
/// Passes on the current Waterfall Auction turn. Two rules changed here, and
/// the second is the substantive one.
///
/// **Cold-start passing.** This used to be rejected unless SOME private
/// anywhere already carried a bid (`PassNotAllowed`). That made the opening
/// position of the game a forced move: the first player could buy the
/// cheapest private or bid on a dearer one, but could not decline. Real 1830
/// lets everyone pass from a standing start -- that is precisely how the
/// price gets walked down to something worth having -- so the gate is gone.
/// The now-unreachable-from-here `PassNotAllowed` variant is retained on the
/// error enum rather than deleted, so any client matching on it still
/// compiles.
///
/// **A full round of passes no longer ends the auction.** It used to:
/// `consecutive_waterfall_passes` reaching the player count refunded every
/// bid and concluded. That is not the 1830 rule, and it made the phase
/// terminate in the one situation where the real game is only just getting
/// interesting. What happens instead, in this exact order:
///
/// 1. **The cheapest unowned private drops $5**, floored at $0. Only the
///    lowest one moves, which is what keeps `lowest_unowned_private_id`'s
///    ascending-order scan valid -- the cheapest getting cheaper cannot
///    reorder the list.
/// 2. **Every already-owned private immediately pays its printed revenue to
///    its owner**, from the bank. This is the counterweight that stops
///    passing from being free: waiting makes the next company cheaper for
///    you, but it pays income to everyone who already committed. Delegated
///    to `operations::pay_private_company_revenues` rather than reimplemented
///    -- same payout, different trigger.
/// 3. **At $0 the company is forced on whoever's turn it now is**, free, and
///    the turn advances past them. Nobody can hold out forever; the auction
///    always terminates.
/// 4. **The pass streak resets and the auction continues** -- unless every
///    private is now owned, in which case it concludes normally.
///
/// The turn advances BEFORE the $0 check, so "the player whose turn it
/// currently is" means the player who now faces the reduced price -- the one
/// who opened the round of passes and has come back around to it -- not the
/// player who happened to pass last.
pub fn execute_waterfall_pass(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
) -> Result<Response, WaterfallError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(WaterfallError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(WaterfallError::GameNotActive { game_id });
    }
    if !session.waterfall_auction_active {
        return Err(WaterfallError::WaterfallNotActive { game_id });
    }
    if WATERFALL_MINI_AUCTION.has(deps.storage, game_id) {
        return Err(WaterfallError::MiniAuctionInProgress { game_id });
    }
    if !session.player_addresses.contains(&info.sender) {
        return Err(WaterfallError::NotAPlayer {
            game_id,
            player: info.sender.to_string(),
        });
    }
    ensure_active_player(&session, game_id, &info.sender)?;

    // Step 4.5 Batch 4: cold-start passing. The `any_private_has_bid` gate
    // that stood here is gone -- see this function's doc comment.

    session.consecutive_waterfall_passes = session
        .consecutive_waterfall_passes
        .checked_add(1)
        .ok_or(WaterfallError::Overflow {})?;
    let player_count = session.player_addresses.len() as u32;

    let mut attrs = vec![
        Attribute::new("action", "waterfall_pass"),
        Attribute::new("game_id", game_id.to_string()),
        Attribute::new("player", info.sender.as_str()),
    ];

    // Not a full round yet: an ordinary pass, turn moves on.
    if player_count == 0 || session.consecutive_waterfall_passes < player_count {
        advance_waterfall_turn(&mut session);
        SESSIONS.save(deps.storage, game_id, &session)?;
        return Ok(Response::new().add_attributes(attrs));
    }

    // ---- A full consecutive round of passes: run the waterfall. ----
    attrs.push(Attribute::new("waterfall_all_pass_round", "true"));

    // The turn moves on first, so the player who now faces the reduced price
    // is the one who opened this round of passes -- see the doc comment.
    advance_waterfall_turn(&mut session);

    match lowest_unowned_private_id(deps.storage, game_id)? {
        None => {
            // Nothing left to discount: every private is owned, so the
            // auction is simply over. Refund anything still escrowed before
            // concluding -- see `refund_all_standing_bids`.
            refund_all_standing_bids(deps.storage, game_id, &mut attrs)?;
            conclude_waterfall(&mut session, &mut attrs);
        }
        Some(private_id) => {
            // ---- 1. Drop the cheapest unowned private by $5, floored at $0.
            let mut private: PrivateCompany =
                PRIVATE_COMPANIES.load(deps.storage, (game_id, private_id))?;
            // `Uint128` is unsigned: `checked_sub` ERRORS below zero rather
            // than wrapping, so the floor is expressed as a saturating
            // comparison rather than a subtraction that must not underflow.
            let reduced = if private.cost <= WATERFALL_PASS_PRICE_DROP {
                Uint128::zero()
            } else {
                private.cost - WATERFALL_PASS_PRICE_DROP
            };
            private.cost = reduced;
            PRIVATE_COMPANIES.save(deps.storage, (game_id, private_id), &private)?;

            attrs.push(Attribute::new(
                "waterfall_price_drop_private_id",
                private_id.to_string(),
            ));
            attrs.push(Attribute::new(
                "waterfall_price_drop_new_cost",
                reduced.to_string(),
            ));

            // ---- 2. Every owned private pays its printed revenue.
            let revenue_attrs = operations::pay_private_company_revenues(deps.storage, game_id)
                .map_err(|e| WaterfallError::Std(StdError::generic_err(e.to_string())))?;
            attrs.extend(revenue_attrs);

            // ---- 3. At $0 it is forced, free, on whoever's turn it now is.
            if reduced.is_zero() {
                let taker = session
                    .player_addresses
                    .get(session.active_player_index as usize)
                    .cloned()
                    .ok_or(WaterfallError::GameNotFound { game_id })?;

                // Any OTHER player's escrow on this private has to come back:
                // once it is owned, no cascade will ever reach it again.
                refund_bids_on_private(
                    deps.storage,
                    game_id,
                    private_id,
                    Some(&taker),
                    &mut attrs,
                )?;

                resolve_private_win(
                    deps.storage,
                    game_id,
                    &mut session,
                    private_id,
                    taker,
                    Uint128::zero(),
                    &mut attrs,
                )?;
                attrs.push(Attribute::new("waterfall_forced_free_assignment", "true"));

                advance_waterfall_turn(&mut session);
            }

            // ---- 4. Resume the auction -- or conclude, if that free
            // assignment was the last unowned private.
            session.consecutive_waterfall_passes = 0;
            if lowest_unowned_private_id(deps.storage, game_id)?.is_none() {
                refund_all_standing_bids(deps.storage, game_id, &mut attrs)?;
                conclude_waterfall(&mut session, &mut attrs);
            }
        }
    }

    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(Response::new().add_attributes(attrs))
}

/// Raises the current mini-auction's standing bid -- only the participant
/// `WaterfallMiniAuction::turn_index` currently points at may call this
/// (module doc comment #3). Escrows just the delta above the caller's own
/// prior bid on this private, if any.
pub fn execute_waterfall_mini_auction_raise(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
    bid_amount: Uint128,
) -> Result<Response, WaterfallError> {
    let session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(WaterfallError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(WaterfallError::GameNotActive { game_id });
    }
    if !session.waterfall_auction_active {
        return Err(WaterfallError::WaterfallNotActive { game_id });
    }

    let mut mini: WaterfallMiniAuction = WATERFALL_MINI_AUCTION
        .may_load(deps.storage, game_id)?
        .ok_or(WaterfallError::NoMiniAuctionInProgress { game_id })?;
    let current_turn_holder = mini
        .bidders
        .get(mini.turn_index as usize)
        .cloned()
        .ok_or(WaterfallError::Overflow {})?;
    if info.sender != current_turn_holder {
        return Err(WaterfallError::NotYourMiniAuctionTurn {
            game_id,
            expected: current_turn_holder.to_string(),
            got: info.sender.to_string(),
        });
    }

    let minimum = mini
        .high_bid
        .checked_add(auction::MIN_BID_INCREMENT)
        .map_err(|_| WaterfallError::Overflow {})?;
    if bid_amount < minimum {
        return Err(WaterfallError::BidTooLow {
            minimum,
            increment: auction::MIN_BID_INCREMENT,
        });
    }

    let my_prior_bid = PRIVATE_BIDS
        .may_load(deps.storage, (game_id, mini.private_id, info.sender.clone()))?
        .unwrap_or_default();
    let delta = bid_amount
        .checked_sub(my_prior_bid)
        .map_err(|_| WaterfallError::Overflow {})?;
    let balance = PLAYER_CASH_VGP
        .may_load(deps.storage, (game_id, info.sender.clone()))?
        .unwrap_or_default();
    let new_balance =
        balance
            .checked_sub(delta)
            .map_err(|_| WaterfallError::InsufficientFunds {
                player: info.sender.to_string(),
            })?;
    PLAYER_CASH_VGP.save(deps.storage, (game_id, info.sender.clone()), &new_balance)?;
    PRIVATE_BIDS.save(
        deps.storage,
        (game_id, mini.private_id, info.sender.clone()),
        &bid_amount,
    )?;

    mini.high_bid = bid_amount;
    mini.high_bidder = info.sender.clone();
    advance_mini_auction_turn_after_raise(&mut mini);
    let private_id = mini.private_id;
    WATERFALL_MINI_AUCTION.save(deps.storage, game_id, &mini)?;

    Ok(Response::new()
        .add_attribute("action", "waterfall_mini_auction_raise")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("private_id", private_id.to_string())
        .add_attribute("bidder", info.sender.clone())
        .add_attribute("bid_amount", bid_amount))
}

/// Drops the current mini-auction turn-holder out, fully refunding their
/// escrowed bid on this private. If exactly one participant remains
/// afterward, they win at the current high bid, the mini-auction state is
/// cleared, and the Waterfall Cascade resumes (module doc comment #3).
pub fn execute_waterfall_mini_auction_pass(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
) -> Result<Response, WaterfallError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(WaterfallError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(WaterfallError::GameNotActive { game_id });
    }
    if !session.waterfall_auction_active {
        return Err(WaterfallError::WaterfallNotActive { game_id });
    }

    let mut mini: WaterfallMiniAuction = WATERFALL_MINI_AUCTION
        .may_load(deps.storage, game_id)?
        .ok_or(WaterfallError::NoMiniAuctionInProgress { game_id })?;
    let current_turn_holder = mini
        .bidders
        .get(mini.turn_index as usize)
        .cloned()
        .ok_or(WaterfallError::Overflow {})?;
    if info.sender != current_turn_holder {
        return Err(WaterfallError::NotYourMiniAuctionTurn {
            game_id,
            expected: current_turn_holder.to_string(),
            got: info.sender.to_string(),
        });
    }
    if info.sender == mini.high_bidder {
        // Unreachable in normal flow -- `skip_leader_turns` never points
        // `turn_index` at the leader -- kept as a defensive rejection
        // rather than silently letting the leader fold themselves out.
        return Err(WaterfallError::LeaderCannotPass { game_id });
    }

    let my_bid = PRIVATE_BIDS
        .may_load(deps.storage, (game_id, mini.private_id, info.sender.clone()))?
        .unwrap_or_default();
    if !my_bid.is_zero() {
        let balance = PLAYER_CASH_VGP
            .may_load(deps.storage, (game_id, info.sender.clone()))?
            .unwrap_or_default();
        let refunded = balance
            .checked_add(my_bid)
            .map_err(|_| WaterfallError::Overflow {})?;
        PLAYER_CASH_VGP.save(deps.storage, (game_id, info.sender.clone()), &refunded)?;
    }
    PRIVATE_BIDS.remove(deps.storage, (game_id, mini.private_id, info.sender.clone()));

    let passer = info.sender.clone();
    let passer_index = mini.turn_index as usize;
    mini.bidders.remove(passer_index);
    let remaining_len = mini.bidders.len() as u32;
    if remaining_len > 0 {
        mini.turn_index %= remaining_len;
    }

    let mut attrs = vec![
        Attribute::new("action", "waterfall_mini_auction_pass"),
        Attribute::new("game_id", game_id.to_string()),
        Attribute::new("private_id", mini.private_id.to_string()),
        Attribute::new("player", passer.as_str()),
    ];

    if mini.bidders.len() == 1 {
        let winner = mini.bidders[0].clone();
        let price = mini.high_bid;
        let private_id = mini.private_id;
        WATERFALL_MINI_AUCTION.remove(deps.storage, game_id);
        resolve_private_win(deps.storage, game_id, &mut session, private_id, winner, price, &mut attrs)?;
        run_cascade(deps.storage, game_id, &mut session, &mut attrs)?;
    } else {
        skip_leader_turns(&mut mini);
        WATERFALL_MINI_AUCTION.save(deps.storage, game_id, &mini)?;
    }

    SESSIONS.save(deps.storage, game_id, &session)?;
    Ok(Response::new().add_attributes(attrs))
}
