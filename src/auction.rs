//! Private Auctions: the phase that opens an 18Cosmos game session, before
//! any Stock or Operating Round play. `spawn_core_private_companies` seeds
//! a game with the classic fixed set of 1830 private companies when its
//! room is created; `execute_bid_on_private` processes competitive bids
//! against them.
//!
//! Design notes / assumptions, since neither `rules.md` nor the existing
//! message/state definitions cover an auction in detail:
//!
//! 1. **The core privates.** Seeded with all six private companies from
//!    the physical 1830 game (matching this project's "Based on 1830
//!    Baseline" rules.md), each with its real face-value cost and OR
//!    revenue: Schuylkill Valley ($20/$5), Champlain & St. Lawrence
//!    ($40/$10), Delaware & Hudson ($70/$15), Mohawk & Hudson ($110/$20),
//!    Camden & Amboy ($160/$25), and Baltimore & Ohio ($220/$30). B&O is
//!    auctioned and escrowed exactly like the other five, but winning it
//!    also triggers its real 1830 power -- see #4 below.
//! 2. **Auction model.** Rather than a multi-round bid-or-pass protocol
//!    (which would need its own "pass" message and round-closing logic
//!    that nothing here asks for), this models a continuous English
//!    auction: `PrivateCompany::owner` always reflects the current top
//!    bidder, and every qualifying bid immediately and automatically (a)
//!    escrows the new bidder's VGP by deducting it from `PLAYER_CASH_VGP`,
//!    (b) refunds the previous top bidder's escrowed VGP, and (c)
//!    transfers `owner`. There's no separate "close the auction" step --
//!    whoever holds a private when the game moves on to the Stock Round is
//!    its owner. The first bid on an unowned private must meet its face
//!    value (`PrivateCompany::cost`); every bid after that must beat the
//!    current standing bid by at least `MIN_BID_INCREMENT` ($5 VGP).
//!
//!    **Superseded as the room's genesis allocation mechanism** by the
//!    canonical 1830 Pre-Game Waterfall Auction Engine (`waterfall.rs`):
//!    every room now starts in `RoundType::WaterfallAuction`
//!    (`GameSession::waterfall_auction_active = true`), and
//!    `execute_bid_on_private` rejects every call
//!    (`AuctionError::WaterfallAuctionInProgress`) until that phase
//!    concludes. This continuous-bid auction remains fully functional
//!    afterward, though, as the fallback path for any private the
//!    waterfall's own early-termination edge case left unsold -- see
//!    `waterfall.rs`'s module doc comment for exactly when that can happen.
//!    `spawn_core_private_companies` below is unchanged and still the one
//!    place all six privates are seeded unowned; the waterfall reads and
//!    writes the very same `PRIVATE_COMPANIES`/`PRIVATE_BIDS` storage this
//!    module always has.
//! 3. **Revenue.** `PrivateCompany::revenue_per_or` is paid automatically
//!    at the start of every Operating Round -- see `operations.rs`'s
//!    Automatic Pre-OR Revenue Payout (module doc comment #14) and
//!    `execute_operating_round`'s own pre-existing Phase 1.
//! 4. **B&O's true power.** Winning the Baltimore & Ohio private
//!    (`PRIVATE_BO_ID`) now floats its public counterpart
//!    (`BO_PUBLIC_COMPANY_ID`, seeded unfloated by
//!    `public_company::spawn_core_public_companies`) automatically and for
//!    free: the winner is granted B&O's 20% President's Certificate
//!    (`BO_PRESIDENT_SHARE_PERCENTAGE`), the remaining 80% opens in B&O's
//!    IPO pool for ordinary Stock Round trading, and the treasury is
//!    capitalized at a fixed par value (`BO_DEFAULT_PAR_VALUE`, the lowest
//!    standard 1830 par) times its 10 certificates, since B&O's president
//!    doesn't get to freely choose a par value the way
//!    `trading::execute_buy_stock`'s general Par Value Selection now lets
//!    other companies' first IPO buyer do. Matching the real
//!    1830 rule that this power fires exactly once, the B&O private closes
//!    to further bidding the moment it floats B&O --
//!    `execute_bid_on_private` rejects any bid on it once
//!    `PublicCompany::is_floated` is true.
//! 5. **Global Certificate Limit.** A winning bid also counts toward the
//!    bidder's total certificate count across the whole game (private
//!    companies owned plus public stock blocks held) -- see
//!    `trading.rs`'s module doc comment #12 for the full rule, shared with
//!    `trading::execute_buy_stock` via `state::count_player_certificates`.

use cosmwasm_std::{
    Addr, DepsMut, Env, MessageInfo, Response, StdError, StdResult, Storage, Uint128,
};
use thiserror::Error;

use crate::hexmap;
use crate::market::{self, MarketError};
use crate::public_company::CORE_PUBLIC_COMPANIES;
use crate::state::{
    count_player_certificates, GameSession, PrivateCompany, PublicCompany, IPO_POOL_SHARES,
    PLAYER_CASH_VGP, PLAYER_SHARES, PRIVATE_BIDS, PRIVATE_COMPANIES, PROTOCOL_PAR_VALUE,
    PROTOCOL_PRESIDENT, PUBLIC_COMPANIES, SESSIONS,
};
use crate::trading::{
    certificate_limit_for_player_count, FULL_POOL_PERCENTAGE, PERCENT_PER_SHARE,
    PRESIDENT_MIN_PERCENTAGE,
};

/// Minimum amount a new bid must exceed the current standing bid by.
pub const MIN_BID_INCREMENT: Uint128 = Uint128::new(5);

/// Private company id for the Baltimore & Ohio (see
/// `CORE_PRIVATE_COMPANIES`). Keep in sync with `BO_PUBLIC_COMPANY_ID`.
pub const PRIVATE_BO_ID: u32 = 6;

/// Public company id for the Baltimore & Ohio -- must match its entry in
/// `public_company::CORE_PUBLIC_COMPANIES`.
pub const BO_PUBLIC_COMPANY_ID: u32 = 4;

/// Percentage of B&O awarded as its President's Certificate when its
/// private company is won, per the real 1830 rule.
pub const BO_PRESIDENT_SHARE_PERCENTAGE: u8 = 20;

/// Placeholder par value B&O floats at (the lowest of the standard 1830
/// par ladder: $67/$71/$76/$82/$90/$100) until a "choose your par value"
/// message exists for the president to pick one instead.
pub const BO_DEFAULT_PAR_VALUE: Uint128 = Uint128::new(67);

/// The percentage that opens in the market pool when B&O floats: the 80%
/// not immediately granted as the President's Certificate.
const BO_INITIAL_POOL_PERCENTAGE: u8 = FULL_POOL_PERCENTAGE - BO_PRESIDENT_SHARE_PERCENTAGE;

/// The fixed set of private companies spawned into every new game room:
/// `(private_id, name, face value cost, revenue paid per Operating Round)`,
/// taken directly from the physical 1830 game. `pub(crate)` so
/// `operations::execute_operating_round` can iterate the same canonical
/// list (Phase 1: private revenue payout) rather than hardcoding a
/// `1..=6` range that could drift out of sync with this one.
pub(crate) const CORE_PRIVATE_COMPANIES: &[(u32, &str, u128, u128)] = &[
    (1, "Schuylkill Valley", 20, 5),
    (2, "Champlain & St. Lawrence", 40, 10),
    (3, "Delaware & Hudson", 70, 15),
    (4, "Mohawk & Hudson", 110, 20),
    (5, "Camden & Amboy", 160, 25),
    (PRIVATE_BO_ID, "Baltimore & Ohio", 220, 30),
];

#[derive(Error, Debug)]
pub enum AuctionError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Market(#[from] MarketError),

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error(
        "Game room {game_id}'s Waterfall Auction is still in progress -- private companies must be won through waterfall.rs's dedicated actions until it concludes"
    )]
    WaterfallAuctionInProgress { game_id: u64 },

    #[error("{player} is not a registered player in game room {game_id}")]
    NotAPlayer { game_id: u64, player: String },

    #[error(
        "It is not {got}'s turn in game room {game_id}; {expected} must act (or PassTurn) first"
    )]
    NotYourTurn {
        game_id: u64,
        expected: String,
        got: String,
    },

    #[error("Private company {private_id} was not found in game room {game_id}")]
    PrivateNotFound { game_id: u64, private_id: u32 },

    #[error(
        "Private company {private_id} has already exercised its one-time power and is closed to further bidding"
    )]
    PrivateClosed { private_id: u32 },

    #[error(
        "Private company {private_id} is already owned by corporation {protocol_id}'s own treasury and is no longer available for player bidding"
    )]
    PrivateOwnedByCorporation { private_id: u32, protocol_id: u32 },

    #[error("Public company {company_id} was not found in game room {game_id}")]
    PublicCompanyNotFound { game_id: u64, company_id: u32 },

    #[error(
        "Bid must be at least {minimum} VGP (the current standing bid plus the minimum {increment} VGP increment, or the private's face value if it has no bidder yet)"
    )]
    BidTooLow {
        minimum: Uint128,
        increment: Uint128,
    },

    #[error("{player} already holds the current standing bid on private company {private_id}")]
    AlreadyTopBidder { private_id: u32, player: String },

    #[error("Player {player} does not have enough VGP to place this bid")]
    InsufficientFunds { player: String },

    #[error(
        "This bid would give {player} {would_hold} certificates, exceeding the {limit}-certificate Global Certificate Limit for a {max_players}-player game"
    )]
    GlobalCertificateLimitExceeded {
        player: String,
        max_players: u8,
        limit: u32,
        would_hold: u32,
    },

    #[error("Arithmetic overflow/underflow while processing a bid")]
    Overflow {},
}

/// Verifies `sender` is the player currently sitting at
/// `session.active_player_index` -- the same Turn Priority Queue guardrail
/// `trading::execute_buy_stock`/`execute_sell_stock` enforce (see that
/// module's identically-named private helper; kept as separate small
/// copies rather than a shared cross-module helper since each module has
/// its own error enum). See `gamelog.rs`'s module doc comment #4 for how
/// far turn-order enforcement reaches beyond these three actions.
fn ensure_active_player(
    session: &GameSession,
    game_id: u64,
    sender: &Addr,
) -> Result<(), AuctionError> {
    let active_player = session
        .player_addresses
        .get(session.active_player_index as usize)
        .cloned()
        .ok_or(AuctionError::GameNotFound { game_id })?;
    if sender != &active_player {
        return Err(AuctionError::NotYourTurn {
            game_id,
            expected: active_player.to_string(),
            got: sender.to_string(),
        });
    }
    Ok(())
}

/// Advances `session.active_player_index` to the next player (wrapping)
/// and resets `session.consecutive_passes` back to `0`. Called after a
/// successful bid -- see `trading::advance_turn`'s doc comment for why a
/// trade and a `PassTurn` move the counter in opposite directions.
fn advance_turn(session: &mut GameSession) {
    let player_count = session.player_addresses.len() as u32;
    if player_count > 0 {
        session.active_player_index = (session.active_player_index + 1) % player_count;
    }
    session.consecutive_passes = 0;
}

/// Seeds `game_id` with the fixed set of `CORE_PRIVATE_COMPANIES`, each
/// unowned. Called once, when a game room is created (see
/// `contract::execute_create_game_room`).
pub fn spawn_core_private_companies(storage: &mut dyn Storage, game_id: u64) -> StdResult<()> {
    for (private_id, name, cost, revenue_per_or) in CORE_PRIVATE_COMPANIES.iter().copied() {
        let company = PrivateCompany {
            private_id,
            name: name.to_string(),
            cost: Uint128::new(cost),
            revenue_per_or: Uint128::new(revenue_per_or),
            owner: None,
            owner_protocol_id: None,
            closed: false,
        };
        PRIVATE_COMPANIES.save(storage, (game_id, private_id), &company)?;
    }
    Ok(())
}

/// Places a bid on `private_id`'s auction. See the module doc comment for
/// the full auction model; in short, a qualifying bid immediately escrows
/// the bidder's VGP, refunds whoever was previously winning, and
/// transfers provisional ownership to the new bidder.
pub fn execute_bid_on_private(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
    private_id: u32,
    bid_amount: Uint128,
) -> Result<Response, AuctionError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(AuctionError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(AuctionError::GameNotActive { game_id });
    }
    // Waterfall Auction (`waterfall.rs`'s module doc comment): the room's
    // real genesis private-company allocation mechanism now runs BEFORE
    // this legacy continuous-bid auction is reachable at all -- every
    // private-company turn action during that phase must go through one of
    // `waterfall.rs`'s five dedicated `ExecuteMsg` variants instead. Once
    // the waterfall concludes, this message remains available exactly as
    // before, as a fallback path for any private the waterfall itself never
    // allocated (its own early-termination edge case -- see that module).
    if session.waterfall_auction_active {
        return Err(AuctionError::WaterfallAuctionInProgress { game_id });
    }
    if !session.player_addresses.contains(&info.sender) {
        return Err(AuctionError::NotAPlayer {
            game_id,
            player: info.sender.to_string(),
        });
    }
    ensure_active_player(&session, game_id, &info.sender)?;

    let mut company: PrivateCompany = PRIVATE_COMPANIES
        .may_load(deps.storage, (game_id, private_id))?
        .ok_or(AuctionError::PrivateNotFound {
            game_id,
            private_id,
        })?;

    // B&O's president-share power fires exactly once, per the real 1830
    // rule: once it has floated the public B&O, the private closes.
    if private_id == PRIVATE_BO_ID {
        let already_floated = PUBLIC_COMPANIES
            .may_load(deps.storage, (game_id, BO_PUBLIC_COMPANY_ID))?
            .map(|public| public.is_floated)
            .unwrap_or(false);
        if already_floated {
            return Err(AuctionError::PrivateClosed { private_id });
        }
    }

    // General Private Closure (see `PrivateCompany`'s own doc comment in
    // `state.rs`): a private permanently closed by the B&O Special Closure
    // or Phase 5 Private Closure (`hardware.rs` module doc comments #11/
    // #12) can never be bid on again, for any private_id -- not just B&O's
    // own already-floated-specific check above.
    if company.closed {
        return Err(AuctionError::PrivateClosed { private_id });
    }

    // A private a CORPORATION has already bought (Phase-Gated Corporate
    // Purchase Protocol, `trading::execute_buy_private_company`) is
    // likewise off the player market for good -- `company.owner` reads
    // `None` in this state exactly like a never-yet-bid-on private would,
    // so without this guard a player could otherwise "win" it back off a
    // corporation for a fresh face-value bid.
    if let Some(owner_protocol_id) = company.owner_protocol_id {
        return Err(AuctionError::PrivateOwnedByCorporation {
            private_id,
            protocol_id: owner_protocol_id,
        });
    }

    // The minimum acceptable bid is the company's face value if no one has
    // bid yet, otherwise the current standing bid plus the fixed increment.
    let minimum_bid = match &company.owner {
        None => company.cost,
        Some(current_owner) => {
            if current_owner == &info.sender {
                return Err(AuctionError::AlreadyTopBidder {
                    private_id,
                    player: info.sender.to_string(),
                });
            }
            let current_bid = PRIVATE_BIDS
                .may_load(deps.storage, (game_id, private_id, current_owner.clone()))?
                .unwrap_or(company.cost);
            current_bid
                .checked_add(MIN_BID_INCREMENT)
                .map_err(|_| AuctionError::Overflow {})?
        }
    };

    if bid_amount < minimum_bid {
        return Err(AuctionError::BidTooLow {
            minimum: minimum_bid,
            increment: MIN_BID_INCREMENT,
        });
    }

    // Global Certificate Limit (trading.rs module doc comment #12): by this
    // point the bidder is confirmed not to already own `private_id` (the
    // `AlreadyTopBidder` check above already rejected that case), so a
    // winning bid always adds exactly one new certificate to their total.
    let private_ids: Vec<u32> = CORE_PRIVATE_COMPANIES.iter().map(|(id, ..)| *id).collect();
    let public_company_ids: Vec<u32> = CORE_PUBLIC_COMPANIES
        .iter()
        .map(|(company_id, _ticker)| *company_id)
        .collect();
    // `PRESIDENT_MIN_PERCENTAGE` threaded through so a President's 20% card
    // counts as exactly 1 certificate here too, not 2 -- see
    // `state::count_player_certificates`'s own doc comment (this contract's
    // one shared certificate-counting implementation) for the full
    // rationale; this bidding path benefits from the same fix
    // `trading::execute_buy_stock` picked up, automatically, since both call
    // through the same function.
    let current_certificates = count_player_certificates(
        deps.storage,
        game_id,
        &info.sender,
        &private_ids,
        &public_company_ids,
        PERCENT_PER_SHARE,
        PRESIDENT_MIN_PERCENTAGE,
    )?;
    let would_hold_certificates = current_certificates
        .checked_add(1)
        .ok_or(AuctionError::Overflow {})?;
    let certificate_limit =
        certificate_limit_for_player_count(session.max_players).unwrap_or(u32::MAX);
    if would_hold_certificates > certificate_limit {
        return Err(AuctionError::GlobalCertificateLimitExceeded {
            player: info.sender.to_string(),
            max_players: session.max_players,
            limit: certificate_limit,
            would_hold: would_hold_certificates,
        });
    }

    // Escrow the new bid from the bidder's own VGP cash.
    let bidder_balance = PLAYER_CASH_VGP
        .may_load(deps.storage, (game_id, info.sender.clone()))?
        .unwrap_or_default();
    let new_bidder_balance =
        bidder_balance
            .checked_sub(bid_amount)
            .map_err(|_| AuctionError::InsufficientFunds {
                player: info.sender.to_string(),
            })?;
    PLAYER_CASH_VGP.save(
        deps.storage,
        (game_id, info.sender.clone()),
        &new_bidder_balance,
    )?;

    let mut response = Response::new()
        .add_attribute("action", "bid_on_private")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("private_id", private_id.to_string())
        .add_attribute("bidder", info.sender.clone())
        .add_attribute("bid_amount", bid_amount);

    // Refund whoever was previously winning, since this bid immediately
    // and automatically replaces them as the top bidder.
    if let Some(previous_owner) = company.owner.clone() {
        let previous_bid = PRIVATE_BIDS
            .may_load(deps.storage, (game_id, private_id, previous_owner.clone()))?
            .unwrap_or_default();
        if !previous_bid.is_zero() {
            let previous_balance = PLAYER_CASH_VGP
                .may_load(deps.storage, (game_id, previous_owner.clone()))?
                .unwrap_or_default();
            let refunded_balance = previous_balance
                .checked_add(previous_bid)
                .map_err(|_| AuctionError::Overflow {})?;
            PLAYER_CASH_VGP.save(
                deps.storage,
                (game_id, previous_owner.clone()),
                &refunded_balance,
            )?;
        }
        PRIVATE_BIDS.remove(deps.storage, (game_id, private_id, previous_owner.clone()));
        response = response
            .add_attribute("outbid_player", previous_owner.as_str())
            .add_attribute("refunded_amount", previous_bid);
    }

    PRIVATE_BIDS.save(
        deps.storage,
        (game_id, private_id, info.sender.clone()),
        &bid_amount,
    )?;
    company.owner = Some(info.sender.clone());
    PRIVATE_COMPANIES.save(deps.storage, (game_id, private_id), &company)?;

    // Winning the B&O private floats its public counterpart and grants the
    // President's Certificate for free -- see module doc comment #4.
    if private_id == PRIVATE_BO_ID {
        award_bo_president_share(deps.storage, game_id, &info.sender)?;
        response = response
            .add_attribute("bo_public_company_floated", "true")
            .add_attribute("bo_president", info.sender.as_str());
    }

    // A completed bid is a turn-gated action too: advance the pointer and
    // clear any in-progress all-pass streak -- see
    // `trading::execute_buy_stock`'s matching comment.
    advance_turn(&mut session);
    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(response)
}

/// Floats the B&O public company (capitalizing its treasury at
/// `BO_DEFAULT_PAR_VALUE` and issuing all 10 certificates) and grants
/// `new_owner` -- the winner of the B&O private -- its 20%
/// `BO_PRESIDENT_SHARE_PERCENTAGE` President's Certificate, with the
/// remaining 80% opening in B&O's IPO pool for ordinary Stock Round
/// trading (via `trading::execute_buy_stock`'s `SharePurchaseSource::Ipo`
/// path -- see below for why `PROTOCOL_PAR_VALUE` is set here too, up
/// front, rather than left for that path's first-ever-purchase logic to
/// set). `execute_bid_on_private` only reaches this once per game (it
/// rejects further bids on the B&O private once `PublicCompany::is_floated`
/// is true), so this always represents B&O's one-time initial float.
pub(crate) fn award_bo_president_share(
    storage: &mut dyn Storage,
    game_id: u64,
    new_owner: &Addr,
) -> Result<(), AuctionError> {
    let mut company: PublicCompany = PUBLIC_COMPANIES
        .may_load(storage, (game_id, BO_PUBLIC_COMPANY_ID))?
        .ok_or(AuctionError::PublicCompanyNotFound {
            game_id,
            company_id: BO_PUBLIC_COMPANY_ID,
        })?;

    company.is_floated = true;
    company.total_shares_issued = 10;
    company.treasury = BO_DEFAULT_PAR_VALUE
        .checked_mul(Uint128::new(u128::from(company.total_shares_issued)))
        .map_err(|_| AuctionError::Overflow {})?;

    // B&O's President's Certificate is granted for free rather than bought,
    // so it never goes through `trading::execute_buy_stock`'s normal
    // first-ever-IPO-purchase flow -- meaning nothing else would ever set
    // `PROTOCOL_PAR_VALUE` for it. Set it explicitly here so B&O's
    // remaining 80% IPO shares are still correctly priced at
    // `BO_DEFAULT_PAR_VALUE` (not the default `MARKET_GRID` formula) the
    // first time anyone buys one. `BO_DEFAULT_PAR_VALUE` ($67) is
    // deliberately the lowest entry of `market::PAR_VALUE_LADDER`, at grid
    // coordinates (0, 0) -- exactly what `ensure_protocol_position`'s
    // `(0, 0)` default below already places the marker at, so this doesn't
    // change B&O's on-grid starting position, only makes its par value
    // explicit and durable.
    PROTOCOL_PAR_VALUE.save(
        storage,
        (game_id, BO_PUBLIC_COMPANY_ID),
        &BO_DEFAULT_PAR_VALUE,
    )?;

    let position = market::ensure_protocol_position(storage, game_id, BO_PUBLIC_COMPANY_ID, 0, 0)?;
    company.current_x = position.current_x;
    company.current_y = position.current_y;
    PUBLIC_COMPANIES.save(storage, (game_id, BO_PUBLIC_COMPANY_ID), &company)?;

    PLAYER_SHARES.save(
        storage,
        (game_id, BO_PUBLIC_COMPANY_ID, new_owner.clone()),
        &BO_PRESIDENT_SHARE_PERCENTAGE,
    )?;
    IPO_POOL_SHARES.save(
        storage,
        (game_id, BO_PUBLIC_COMPANY_ID),
        &BO_INITIAL_POOL_PERCENTAGE,
    )?;
    PROTOCOL_PRESIDENT.save(storage, (game_id, BO_PUBLIC_COMPANY_ID), new_owner)?;

    // Station Tokens (`hexmap.rs` module doc comment #23): B&O's free home
    // token (Baltimore, I15) is granted the moment it floats, exactly like
    // every other corporation's -- this is the earlier of the two places
    // `PublicCompany::is_floated` ever flips to `true` (see that function's
    // own doc comment for the other, `trading::execute_buy_stock`'s
    // ordinary 60%-ownership float branch).
    hexmap::grant_home_station_token(storage, game_id, BO_PUBLIC_COMPANY_ID)?;

    Ok(())
}
