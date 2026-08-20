//! Private Auctions: seeds the six 1830 privates at room creation and processes
//! competitive bids against them.
//!
//! THE CORE PRIVATES, at real face value and OR revenue: Schuylkill Valley
//! ($20/$5), Champlain & St. Lawrence ($40/$10), Delaware & Hudson ($70/$15),
//! Mohawk & Hudson ($110/$20), Camden & Amboy ($160/$25), Baltimore & Ohio
//! ($220/$30).
//!
//! AUCTION MODEL: a continuous English auction rather than a bid-or-pass
//! protocol. `owner` always reflects the current top bidder, and every qualifying
//! bid immediately escrows the new bidder's cash, refunds the previous top
//! bidder, and transfers ownership. There is no separate close step.
//!
//! SUPERSEDED as the room's genesis mechanism by the Waterfall Auction Engine:
//! every room now starts there and this message is rejected until that phase
//! concludes. It remains fully functional afterwards as the fallback for any
//! private the waterfall never allocated. `spawn_core_private_companies` is
//! unchanged and still the one place all six are seeded, and the waterfall reads
//! and writes the very same storage this module always has.
//!
//! B&O'S POWER: winning the B&O private FLOATS its public counterpart
//! automatically and for free -- the winner is granted the 20% President's
//! Certificate, the remaining 80% opens in the IPO pool, and the treasury is
//! capitalized at the lowest standard par times ten, since B&O's president does
//! not get to choose a par value the way every other corporation's first IPO
//! buyer does. The private closes to further bidding the moment it fires.
//!
//! DIVERGENCE, recorded rather than fixed: real 1830 hands the winner the
//! President's certificate but does NOT float the corporation -- it still floats
//! on the ordinary 60% threshold like every other. See
//! docs/ai_architecture/rust_contract_architecture.md.

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

/// Verifies `sender` is the player at `active_player_index` -- the same Turn
/// Priority Queue guardrail `trading.rs` enforces, kept as a separate small copy
/// rather than a shared helper since each module has its own error enum.
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
    // Waterfall Auction: the room's real genesis allocation mechanism runs BEFORE
    // this legacy continuous-bid auction is reachable at all, and every
    // private-company action during that phase must go through one of the five
    // dedicated messages. Once it concludes this remains available exactly as
    // before, as the fallback for any private the waterfall never allocated.
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

    // B&O's President's Certificate is GRANTED rather than bought, so it never goes
    // through the normal first-ever-IPO-purchase flow -- meaning nothing else would
    // ever set its par value. Set explicitly here so the remaining 80% is correctly
    // priced the first time anyone buys one. The lowest ladder rung sits at grid
    // `(0, 0)`, exactly where the default position already places the marker, so
    // this changes no on-grid position -- only makes the par explicit and durable.
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

    // Station Tokens: B&O's free home token (Baltimore, I15) is granted the moment
    // it floats, exactly like every other corporation's. This is the EARLIER of the
    // two places `is_floated` ever flips to `true`.
    hexmap::grant_home_station_token(storage, game_id, BO_PUBLIC_COMPANY_ID)?;

    Ok(())
}
