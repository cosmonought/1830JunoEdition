//! Stock trading mechanics for the 1830-style Stock Round: buying and
//! selling protocol shares against the open-market/IPO pool, and declaring
//! Operating Round dividends. See `rules.md` sections 2-3 for the source
//! rules and `src/market.rs` for the grid-movement primitives this module
//! drives.
//!
//! Design notes / assumptions, since several pieces aren't fully pinned
//! down by the existing message/state definitions:
//!
//! 1. **Certificate size.** rules.md's Stock Round rule ("a player may sell
//!    any amount... then purchase exactly 1 token/share") is modeled as a
//!    fixed `PERCENT_PER_SHARE` = 10% certificate: `BuyStock` always buys
//!    exactly one certificate; `SellStock` accepts any multiple of it.
//! 2. **60% ownership cap.** Per-player holdings in a single protocol are
//!    capped at `CERTIFICATE_LIMIT_PERCENTAGE` (60%, the standard 18xx
//!    cap), *unless* the protocol's current market cell is an `OrangeZone`
//!    or `BrownZone` (per `state::ZoneType`'s doc comment) -- real 1830's
//!    "a single player may hold more than 60%" rule, which only the Orange
//!    and Brown bands grant (Yellow alone does not). This check is
//!    genuinely the *ownership cap*, not the separate *certificate/hand
//!    limit* (the total-certificates-across-every-corporation cap,
//!    `CERT_LIMIT_BY_PLAYERS` in the frontend's `RulesReference.tsx`) --
//!    see module doc comment #12 for that check, including its OWN,
//!    broader Yellow/Orange/Brown zone exemption (Yellow alone exempts a
//!    certificate from the hand limit, even though it does not exempt a
//!    holding from this narrower 60% ownership cap -- the two exemption
//!    rules are related but not identical in scope). A prior pass of this
//!    note said the certificate/hand limit had "no backend enforcement... at
//!    all" -- that's no longer accurate; #12 below now covers it. See
//!    `state::ZoneType`'s own doc comment for the Brown zone's additional
//!    Multiple-Buy exception, handled separately below (#15).
//! 3. **Where the money lives.** Trading against the pool is modeled as
//!    trading against the game's existing `GameSession::virtual_bank_vgp`
//!    field (buying pays VGP into it, selling draws VGP out of it) rather
//!    than inventing a separate per-protocol IPO cash account. Each
//!    player's own spendable cash is tracked in `state::PLAYER_CASH_VGP`,
//!    provisioned by `contract::execute_join_game_room` when a player
//!    joins.
//! 4. **Dividends.** `DeclareDividends` splits `revenue_amount` across
//!    *all* of a protocol's shares, not just player-held ones: each
//!    player's cut is credited to `PLAYER_CASH_VGP`, and the pool's
//!    (bank's) share -- plus any integer-division dust -- is credited to
//!    `GameSession::virtual_bank_vgp` so nothing is ever left stranded.
//!    Only the protocol's registered `PROTOCOL_PRESIDENT` may call it.
//! 5. **Presidency.** After every `BuyStock`/`SellStock`, whoever holds the
//!    largest share of a protocol among its registered players -- at or
//!    above `PRESIDENT_MIN_PERCENTAGE` -- is (re)assigned as
//!    `PROTOCOL_PRESIDENT`, per rules.md ("The player holding the highest
//!    percentage of shares (minimum 20%) is designated the 'Validator'").
//!    Ties keep the incumbent if they're part of the tied group, otherwise
//!    fall back to address ordering for a deterministic pick -- real 1830
//!    breaks ties by stock-round turn order, which isn't modeled here.
//! 6. **Market movements**, per the mapping given for this feature:
//!    - `BuyStock` that empties both pools (0% remaining in IPO *and* Bank)
//!      triggers `move_up` (sold-out bonus).
//!    - `SellStock` triggers one `move_down` per certificate sold. **All
//!      certificates in a single sale transact at the price the marker sat
//!      on when the sale began** (Audit G-4); the marker only walks down
//!      afterward, one row per certificate. A previous version of this note
//!      claimed the opposite -- that later certificates in the same sale
//!      settle at the new, lower price, "matching the physical 18xx board"
//!      -- and the code did exactly that. Both were wrong: 1830 fixes the
//!      sale price at the start of the transaction, and every reference
//!      implementation does the same. See `execute_sell_stock`.
//!    - `DeclareDividends { distribute: true }` triggers `move_right`.
//!    - `DeclareDividends { distribute: false }` (withheld) triggers
//!      `move_left`.
//! 7. **General flotation.** Every `BuyStock` now checks, right after the
//!    purchase is recorded, whether `protocol_id`'s total real-player-owned
//!    stake (summed across every registered player, excluding whatever
//!    still sits in `IPO_POOL_SHARES`/`BANK_POOL_SHARES`) has reached
//!    `FLOAT_THRESHOLD_PERCENTAGE` (60%). The first purchase that crosses
//!    that line flips `PublicCompany::is_floated` to `true` and capitalizes
//!    its treasury at `FLOAT_CAPITALIZATION_MULTIPLIER` (10x) times its Par
//!    Value -- the classic 1830 "treasury = 10x par" rule (see #8: this is
//!    always Par Value specifically, never a Bank/Market price, even on the
//!    rare purchase that crosses the float line via a Bank buy). This
//!    closes the gap flagged in `public_company.rs`: previously only
//!    Baltimore & Ohio could ever float (for free, the moment its private
//!    company was won -- see `auction::award_bo_president_share`), so
//!    ordinary corporations like PRR had no path to `is_floated: true` at
//!    all. Shares can still be bought out of a company's IPO pool before it
//!    floats (matching the real game's pre-flotation Stock Round), and a
//!    company that already floated by some other path (B&O) is simply
//!    skipped here since `is_floated` is already `true`.
//! 8. **Par Value Selection.** `BuyStock` now takes a `source`
//!    (`SharePurchaseSource::Ipo` or `::Bank`) and an optional `par_value`.
//!    Buying from the IPO pool pays the protocol's fixed Par Value, chosen
//!    from `market::PAR_VALUE_LADDER` on the very first-ever IPO purchase
//!    of that protocol (which also pins its starting `MARKET_GRID`
//!    position to that par price's cell) and stored durably in
//!    `PROTOCOL_PAR_VALUE`; every later IPO purchase pays that same fixed
//!    amount regardless of where the market marker has since moved. Buying
//!    from the Bank pool always pays the protocol's live, floating
//!    `MARKET_GRID` price instead -- the two pools and the two prices are
//!    intentionally decoupled, matching the real 18xx distinction between
//!    "buying at the IPO price" and "buying off the open market".
//! 9. **Turn Pacing.** `SellStock` is turn-gated (`ensure_active_player`)
//!    exactly like `BuyStock`, but deliberately does NOT advance
//!    `GameSession::active_player_index` -- only `reset_pass_streak`'s
//!    `consecutive_passes = 0` half runs, matching the real 1830 Stock
//!    Round rule that a player may sell any number of blocks on their turn
//!    before the one `BuyStock`-or-`PassTurn` action that actually ends it.
//!    `execute_buy_stock`/`auction::execute_bid_on_private` still call the
//!    full `advance_turn` (pointer + streak reset).
//! 10. **50% Bank Pool Cap.** `SellStock` rejects a sale
//!     (`BankPoolCapExceeded`) if it would push `BANK_POOL_SHARES` for that
//!     protocol above `BANK_POOL_CAP_PERCENTAGE` (50%) -- the classic 18xx
//!     constraint that the market can only absorb so many dumped shares of
//!     a single company before it's illiquid. Checked before any state is
//!     touched.
//! 11. **President/Validator Transfer -- true stock dumping (Audit G-7).**
//!     `SellStock` simulates the holdings its sale would leave behind and
//!     rejects it only when NOBODY -- seller included -- would still hold
//!     `PRESIDENT_MIN_PERCENTAGE` (20%) afterward
//!     (`NoEligiblePresidentSuccessor`). A floated corporation must always
//!     have someone able to hold its President's certificate; that single
//!     condition is the whole rule, and everything else is legal.
//!
//!     This replaced a blanket pre-check that rejected ANY sale by a
//!     sitting President unless some *other* player already held 20%. That
//!     version was stricter than real 1830 and **blocked legal moves**: a
//!     President on 60% could not sell one 10% certificate even though they
//!     would still hold 50% and still be President afterward. It also meant
//!     the actual dump -- selling out from under the presidency and handing
//!     it off -- was never executed, only refused.
//!
//!     **On "transferring the 20% President's certificate."** This engine
//!     stores ownership as a raw PERCENTAGE per player (`PLAYER_SHARES`),
//!     not as discrete certificate objects, so there is no 20% card to
//!     physically move and no pair of 10% cards to hand back to the
//!     outgoing President -- the percentages are already correct the
//!     instant the sale settles. The certificate SEMANTICS are preserved
//!     entirely through `PROTOCOL_PRESIDENT` plus
//!     `state::count_player_certificates`, which counts the first 20% of
//!     whoever currently holds the seat as exactly ONE physical card and
//!     everything else in ordinary 10% blocks. So when
//!     `recalculate_president` moves the seat, the incoming President's
//!     first 20% automatically starts counting as one certificate and the
//!     outgoing President's remaining 20% automatically reverts to counting
//!     as two -- which is precisely the "hand back 2x10%" rule, achieved by
//!     re-derivation rather than by shuffling stored cards. Writing an
//!     explicit swap here would either be a no-op or corrupt the
//!     percentages.
//! 12. **Global Certificate Limit -- a STRICT hard block, not a warning.**
//!     `execute_buy_stock` and `auction::execute_bid_on_private` both reject
//!     a purchase outright (`TradingError::ExceededCertificateLimit` here;
//!     `auction::AuctionError::GlobalCertificateLimitExceeded` there -- two
//!     separate error enums that happened to share one name before this
//!     pass renamed only this module's variant, to read unambiguously
//!     distinct from the *other*, ownership-cap `CertificateLimitExceeded`
//!     just above) if it would push the buyer/bidder's total certificate
//!     count past the standard 1830 limit for `GameSession::max_players`
//!     (`CERTIFICATE_LIMIT_BY_PLAYER_COUNT`) -- there is no partial/soft
//!     path here: the transaction fails and no state is touched. The count
//!     itself (`state::count_player_certificates`) is every private company
//!     owned, plus every physical stock card held across public companies --
//!     with the President's 20% card counting as exactly ONE certificate,
//!     not two (a naive `held_pct / PERCENT_PER_SHARE` would double-count
//!     it; see that function's own doc comment for the three-source
//!     re-verification this matches). **Zone exemption**, added this pass:
//!     `execute_buy_stock` skips this check entirely when the company being
//!     purchased currently sits on a Yellow, Orange, or Brown market cell
//!     (`certificate_limit_exempt`, resolved from the same `zone_type` the
//!     60% ownership check above already reads) -- broader than that
//!     ownership check's own Orange/Brown-only exemption, matching the real
//!     1830 rule that Yellow alone already exempts a certificate from the
//!     hand limit (see module doc comment #2). `auction::execute_bid_on_private`
//!     has no market-cell concept for a *private* company, so its own check
//!     stays unconditional. Not enforced on `SellStock` (selling only ever
//!     lowers a player's count) or `DeclareDividends`/`LayTile`/
//!     `BuyHardwareFromPool` (neither changes certificate ownership).
//! 13. **Checks-Effects-Interactions.** `execute_buy_stock` resolves *every*
//!     validation check -- turn order, the 60% `CertificateLimitExceeded`
//!     ownership cap, the Global Certificate Limit (module doc comment #12,
//!     checked right after it since both need `zone_type` resolved first),
//!     and pool liquidity/Par Value legality -- purely by reading state,
//!     before writing anything. The price/
//!     pool-percentage/zone-type resolution that used to live inside the
//!     `source` match (and used to write `IPO_POOL_SHARES`/
//!     `BANK_POOL_SHARES`/`PROTOCOL_PAR_VALUE` mid-computation) instead
//!     returns a `PoolEffect` describing what *would* be written; only the
//!     very end of the function -- once every `Err` path has already
//!     returned -- actually applies it, alongside every other storage write
//!     (`PLAYER_CASH_VGP`, `PLAYER_SHARES`, `SESSIONS`, and the market
//!     marker pin on a protocol's first-ever IPO purchase). Two small,
//!     behavior-preserving consequences of resolving the first-IPO-purchase
//!     par cell and the Bank-purchase market cell without writing:
//!     - The first-ever-IPO-purchase case reads its target cell straight out
//!       of the shared `MARKET_GRID` template at the chosen par value's
//!       coordinates (`market::par_value_coords`), rather than calling
//!       `market::set_protocol_position` and then reading it back -- the
//!       same cell, just without the write.
//!     - The Bank-purchase case now calls `market::current_cell` directly
//!       instead of `market::ensure_protocol_position` first. Every
//!       `CORE_PUBLIC_COMPANIES` protocol already has a market position
//!       seeded at room-creation time (`market::initialize_game_market`), so
//!       `ensure_protocol_position` was already documented as "a defensive
//!       fallback, not the primary path" here -- this now surfaces that
//!       (unreachable in practice) missing-position case as a clean
//!       `TradingError::Market` error instead of silently seeding a
//!       `(0, 0)` position mid-check.
//!     `execute_sell_stock` and `auction::execute_bid_on_private` already
//!     followed this pattern (module doc comments #10/#11 and `auction.rs`'s
//!     own doc comment #5); this brings `execute_buy_stock` in line with the
//!     other two.
//! 14. **Operating Round Corporation Turn Queue gating.** Layered on top of
//!     `execute_declare_dividends`'s existing President-only authorization:
//!     whenever `GameSession::active_operating_order` is non-empty,
//!     `protocol_id` must be whichever corporation `active_corporation_index`
//!     currently points to, or the call is rejected with
//!     `NotYourOperatingTurn` (see `hexmap.rs`'s module doc comment #13 for
//!     the shared design and `operations.rs` for how the queue itself is
//!     computed). `BuyStock`/`SellStock`/`BidOnPrivate` are unaffected --
//!     they're Stock Round actions gated by `active_player_index` (module
//!     doc comment #9), a different turn structure entirely.
//! 15. **Brown Zone Multiple-Buy.** A `SharePurchaseSource::Bank` purchase
//!     made while the protocol's marker sits on a `ZoneType::BrownZone`
//!     cell does NOT advance the turn pointer (contrast the unconditional
//!     `advance_turn` every other `BuyStock` call makes) -- the real 1830
//!     rule that a player may buy more than one certificate of a
//!     Brown-zone corporation from the open market in the same turn. Every
//!     other purchase (any IPO purchase regardless of zone, or a Bank
//!     purchase outside a Brown cell) still advances the turn exactly as
//!     before.
//! 16. **$350 Game-End Trigger.** Immediately after any *ascending* market
//!     movement this module triggers (the sold-out bonus in `BuyStock`, or
//!     Distribute Yield's `move_right` in `DeclareDividends`), if the
//!     landed-on cell's price has reached `market::GAME_END_PRICE_TRIGGER`
//!     ($350), the room closes out automatically via
//!     `contract::finalize_and_distribute_payouts` -- see that function's
//!     doc comment, and `market.rs`'s module doc comment for why this is an
//!     explicit, user-requested house rule rather than verbatim-sourced
//!     engine behavior. The triggering action's own bookkeeping (the
//!     purchase itself, the dividend payout) completes normally first --
//!     only what would have been the *next* turn is what "halt all further
//!     player turns" actually prevents, enforced by `GameSession::is_active`
//!     being checked at the top of every gameplay handler.
//! 17. **Phase-Gated Corporate Purchase Protocol.** `execute_buy_private_company`
//!     implements the real 1830 rule that once Phase 3 (the 3-train era)
//!     begins, an operating corporation may buy a private company directly
//!     off its player-owner, at a price the corporation's President
//!     chooses -- bounded to 50%-200% of the private's printed face value,
//!     inclusive, checked by cross-multiplication (`price * 2 >= face_value`
//!     and `price <= face_value * 2`) rather than dividing `face_value` by
//!     2, so an odd-valued face value's exact half is never silently
//!     rounded away. This engine has no separate `Phase` type (see
//!     `hexmap.rs`'s module doc comment #24 for the full mapping); Phase 3
//!     is modeled as `TileColor::Green`, matching `hardware.rs`'s own
//!     `ERA_UNLOCK_TRIGGERS` ("3" unlocks Green). Authorization mirrors
//!     `execute_declare_dividends` exactly: only `protocol_id`'s registered
//!     President may call this, gated by the same soft Operating Round
//!     Corporation Turn Queue check (enforced only once the room actually
//!     has a non-empty `active_operating_order`). On success, `price`
//!     moves from the buying corporation's own `PublicCompany::treasury`
//!     straight into the selling player's `PLAYER_CASH_VGP`, and
//!     `PrivateCompany::owner`/`owner_protocol_id` flip from
//!     player-ownership to corporate-ownership (see that struct's own doc
//!     comment in `state.rs` for the full invariant) -- from that point on,
//!     `operations.rs`'s Automatic Pre-OR Revenue Payout (module doc
//!     comment #14 there) pays this private's revenue into the
//!     corporation's treasury instead of a player's wallet, and
//!     `hexmap.rs`'s Private-Company-Reserved-Hex gate (module doc comment
//!     #24) recognizes the corporation, not the former player-owner, as
//!     entitled to build on that private's reserved hex (if it has one).
//!     There's no separate player-side accept/reject message -- this is a
//!     unilateral, price-bounded corporate purchase, not a true two-party
//!     negotiation, matching this message's own scoped request.
//! 18. **Round-phase gating (Audit G-6).** Two related restrictions this
//!     module previously had NO enforcement for at all -- there were zero
//!     references to `GameSession::macro_round_number` or
//!     `current_round_type` anywhere in this file:
//!
//!     - **Stock Round 1 is buy-or-pass only.** `execute_sell_stock`
//!       rejects every sale while `macro_round_number == 1` and the room is
//!       in a Stock Round (`SalesProhibitedInFirstStockRound`) -- the
//!       classic 1830 rule that no share may be sold in the opening Stock
//!       Round. The ban lifts automatically once Macro Round Loop
//!       Advancement (`operations::execute_end_operating_round_turn`,
//!       `operations.rs` module doc comment #12) bumps `macro_round_number`
//!       to `2`, i.e. at the start of SR2. Players could previously
//!       pump-and-dump on turn one.
//!     - **`BuyStock`/`SellStock` are Stock Round actions.** Both now call
//!       `ensure_stock_round`, rejecting the message with
//!       `StockActionOutsideStockRound` whenever `current_round_type` isn't
//!       `RoundType::StockRound` -- most importantly during an Operating
//!       Round, where trading used to be silently legal. This closes the
//!       LIMITATION `operations.rs`'s own module doc comment #12 flagged
//!       ("`current_round_type` is currently informational/display-oriented
//!       rather than itself an enforcement gate on trading messages;
//!       wiring that up is future work"). That future work is this note.
//!
//!     Both checks run AFTER each handler's existing
//!     `waterfall_auction_active` check, so a player acting during the
//!     Waterfall Auction still gets that phase's own, more specific
//!     `WaterfallAuctionInProgress` error pointing them at `waterfall.rs`'s
//!     five dedicated messages.

use cosmwasm_std::{Addr, DepsMut, Env, MessageInfo, Response, StdError, Storage, Uint128};
use thiserror::Error;

use crate::auction::CORE_PRIVATE_COMPANIES;
use crate::hexmap;
use crate::market::{self, MarketError};
use crate::msg::SharePurchaseSource;
use crate::public_company::CORE_PUBLIC_COMPANIES;
use crate::or_phase;
use crate::state::{
    count_player_certificates, GameSession, OperatingSubPhase, PrivateCompany, PublicCompany,
    RoundType, TileColor,
    ZoneType, BANK_POOL_SHARES, IPO_POOL_SHARES, MARKET_GRID, PLAYER_CASH_VGP, PLAYER_SHARES,
    PRIVATE_COMPANIES, PROTOCOL_PAR_VALUE, PROTOCOL_PRESIDENT, PUBLIC_COMPANIES, SESSIONS,
};

/// One certificate = this percentage of a protocol, per rules.md's SR
/// transaction rule (buy exactly 1 share at a time).
pub const PERCENT_PER_SHARE: u8 = 10;

/// A protocol's shares total 100%; an unseeded `IPO_POOL_SHARES` entry is
/// treated as fully unsold (100% still in the IPO pool). `BANK_POOL_SHARES`
/// uses a different, empty (0) default -- see its doc comment in `state.rs`.
pub const FULL_POOL_PERCENTAGE: u8 = 100;

/// Standard 18xx per-player ownership cap for a single protocol, in
/// percent. Waived while the protocol's market cell is a `ZoneType::OrangeZone`
/// or `ZoneType::BrownZone` -- see module doc comment #2.
pub const CERTIFICATE_LIMIT_PERCENTAGE: u8 = 60;

/// Minimum ownership percentage required to hold the President/Validator
/// seat for a protocol (rules.md: "the highest percentage of shares
/// (minimum 20%)").
pub const PRESIDENT_MIN_PERCENTAGE: u8 = 20;

/// Percentage of a protocol's shares that must be owned by real players
/// (i.e. no longer sitting in `IPO_POOL_SHARES`/`BANK_POOL_SHARES`) before
/// it automatically floats. Numerically the same as
/// `CERTIFICATE_LIMIT_PERCENTAGE`, but a distinct constant on purpose: one
/// caps a single player's holding, the other is a threshold on the *sum* of
/// every player's holding.
pub const FLOAT_THRESHOLD_PERCENTAGE: u8 = 60;

/// Standard 1830 total certificate count for a floated public company: 10
/// certificates at `PERCENT_PER_SHARE` (10%) each = 100%. Matches
/// `auction::award_bo_president_share`'s hardcoded B&O float.
pub const STANDARD_SHARE_COUNT: u8 = 10;

/// Multiplier applied to a newly-floated company's Par Value to capitalize
/// its starting treasury, per the classic 1830 rule ("treasury = 10x par
/// value").
pub const FLOAT_CAPITALIZATION_MULTIPLIER: u128 = 10;

/// Maximum percentage of a single protocol's shares `BANK_POOL_SHARES` may
/// ever hold; `SellStock` rejects a sale that would push it higher (see
/// module doc comment #10).
pub const BANK_POOL_CAP_PERCENTAGE: u8 = 50;

/// Standard 1830 Global Certificate Limit, by declared `GameSession::max_players`:
/// the total number of certificates (every private company owned, plus
/// every `PERCENT_PER_SHARE` block of public stock held) a single player
/// may hold across the whole game. `max_players` is always validated to
/// 2-6 at `CreateGameRoom` time (`ContractError::InvalidMaxPlayers`); the
/// 2- and 3-player entries (28/20) are the standard 1830 values, filled in
/// here since this feature's request only specified the 4/5/6-player caps.
/// See `certificate_limit_for_player_count` and module doc comment #12.
pub const CERTIFICATE_LIMIT_BY_PLAYER_COUNT: &[(u8, u32)] =
    &[(2, 28), (3, 20), (4, 16), (5, 13), (6, 11)];

/// Looks up `max_players`'s entry in `CERTIFICATE_LIMIT_BY_PLAYER_COUNT`.
/// Returns `None` only for a `max_players` outside the validated 2-6 range,
/// which should be unreachable for any `GameSession` created through
/// `contract::execute_create_game_room`.
pub fn certificate_limit_for_player_count(max_players: u8) -> Option<u32> {
    CERTIFICATE_LIMIT_BY_PLAYER_COUNT
        .iter()
        .find(|(players, _)| *players == max_players)
        .map(|(_, limit)| *limit)
}

#[derive(Error, Debug)]
pub enum TradingError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Market(#[from] MarketError),

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error(
        "Game room {game_id}'s Pre-Game Waterfall Auction is still in progress -- Stock Round trading cannot begin until every private company is allocated and Stock Round 1 opens"
    )]
    WaterfallAuctionInProgress { game_id: u64 },

    /// Audit G-6, first half. The classic 1830 rule that NO share may be
    /// sold during the game's opening Stock Round -- see module doc
    /// comment #18.
    #[error(
        "No shares may be sold during Stock Round 1 in game room {game_id}; the first Stock Round is buy-or-pass only"
    )]
    SalesProhibitedInFirstStockRound { game_id: u64 },

    /// Audit G-6, second half. `BuyStock`/`SellStock` are Stock Round
    /// actions and are rejected outright in any other phase -- see module
    /// doc comment #18.
    #[error(
        "Game room {game_id} is currently in {current_round_type}, not a Stock Round; BuyStock and SellStock are Stock Round actions only"
    )]
    StockActionOutsideStockRound {
        game_id: u64,
        current_round_type: String,
    },

    #[error(
        "Protocol {protocol_id} has no registered President; someone must hold at least {min_percentage} percent before dividends can be declared"
    )]
    NoPresidentAssigned {
        protocol_id: u32,
        min_percentage: u8,
    },

    #[error("Unauthorized: only protocol {protocol_id}'s registered President may declare its dividends")]
    NotPresident { protocol_id: u32 },

    /// Audit G-14: this action was attempted outside its Operating Round
    /// sub-phase. The turn runs BuyPrivate -> Track -> Tokens -> Routes ->
    /// Dividends -> Hardware, and the check is strict equality -- being PAST
    /// a phase fails as loudly as being before it, because reordering after
    /// the fact is exactly what this prevents.
    #[error(
        "protocol {protocol_id} is in Operating Round phase {actual} (step {actual_index} of 6); this action requires phase {required} (step {required_index} of 6)"
    )]
    WrongOperatingSubPhase {
        protocol_id: u32,
        actual: String,
        actual_index: u8,
        required: String,
        required_index: u8,
    },
    #[error(
        "It is not protocol {protocol_id}'s turn in game room {game_id}'s Operating Round Corporation Turn Queue; protocol {expected_protocol_id} must act first"
    )]
    NotYourOperatingTurn {
        game_id: u64,
        protocol_id: u32,
        expected_protocol_id: u32,
    },

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

    #[error("percentage must be a positive multiple of {percent_per_share}")]
    InvalidSharePercentage { percent_per_share: u8 },

    #[error(
        "Only {available} percent of protocol {protocol_id}'s {pool} pool shares remain; cannot buy {requested}"
    )]
    InsufficientPoolShares {
        protocol_id: u32,
        pool: &'static str,
        available: u8,
        requested: u8,
    },

    #[error(
        "Buying protocol {protocol_id}'s very first IPO share requires par_value to be set to one of the standard 1830 par prices"
    )]
    ParValueRequired { protocol_id: u32 },

    #[error(
        "{par_value} is not a valid par value; must be one of the standard 1830 par prices ($67/$71/$76/$82/$90/$100)"
    )]
    InvalidParValue { par_value: Uint128 },

    #[error(
        "Protocol {protocol_id} already set its par value at {par_value}; par_value must be omitted or must match on later IPO purchases"
    )]
    ParValueAlreadySet {
        protocol_id: u32,
        par_value: Uint128,
    },

    #[error(
        "par_value ({par_value}) must not be supplied when buying from the Open Market Bank pool"
    )]
    ParValueNotApplicableForBankPurchase { par_value: Uint128 },

    #[error(
        "Protocol {protocol_id} is floating without a recorded par value -- this should be unreachable, since any player-owned share must have originated from an IPO purchase that sets one"
    )]
    MissingParValueAtFloat { protocol_id: u32 },

    #[error(
        "Player only holds {available} percent of protocol {protocol_id}; cannot sell {requested}"
    )]
    InsufficientShares {
        protocol_id: u32,
        available: u8,
        requested: u8,
    },

    #[error(
        "Buying would give the player {new_total} percent of protocol {protocol_id}, exceeding the {limit} percent certificate limit"
    )]
    CertificateLimitExceeded {
        protocol_id: u32,
        new_total: u8,
        limit: u8,
    },

    #[error(
        "Selling would push protocol {protocol_id}'s Bank pool to {new_bank_pct} percent, exceeding the {cap} percent Bank Pool Cap"
    )]
    BankPoolCapExceeded {
        protocol_id: u32,
        new_bank_pct: u8,
        cap: u8,
    },

    #[error(
        "{player} holds protocol {protocol_id}'s President seat and cannot sell until another player holds at least {min_percentage} percent to legally absorb the presidency"
    )]
    NoEligiblePresidentSuccessor {
        protocol_id: u32,
        player: String,
        min_percentage: u8,
    },

    #[error(
        "This purchase would give {player} {would_hold} certificates, exceeding the {limit}-certificate Global Certificate Limit for a {max_players}-player game"
    )]
    ExceededCertificateLimit {
        player: String,
        max_players: u8,
        limit: u32,
        would_hold: u32,
    },

    #[error("Player {player} does not have enough VGP to complete this trade")]
    InsufficientFunds { player: String },

    #[error("The game bank does not have enough VGP to buy back these shares")]
    InsufficientBankFunds {},

    #[error("revenue_amount must be greater than zero")]
    ZeroRevenue {},

    #[error("Arithmetic overflow/underflow while processing a trade")]
    Overflow {},

    #[error(
        "Buying a private company from a player is not permitted until Phase 3 (the 3-train era) begins -- game room {game_id} is still in the {current_era:?} era"
    )]
    PrivatePurchaseLockedBeforePhase3 {
        game_id: u64,
        current_era: TileColor,
    },

    #[error("Private company {private_id} was not found in game room {game_id}")]
    PrivateCompanyNotFound { game_id: u64, private_id: u32 },

    #[error(
        "Private company {private_id} has no current player owner to buy it from -- it is either unowned, or already owned by another corporation's treasury"
    )]
    PrivateNotOwnedByAPlayer { private_id: u32 },

    #[error("Private company {private_id} has already closed and can no longer be bought or sold")]
    PrivateCompanyClosed { private_id: u32 },

    #[error(
        "Price {price} is outside the legal 50%-200% price band for private company {private_id}'s {face_value} VGP face value (must satisfy price*2 >= face_value and price <= face_value*2)"
    )]
    PrivatePurchasePriceOutOfBounds {
        private_id: u32,
        price: Uint128,
        face_value: Uint128,
    },

    #[error("Public company {company_id} was not found in game room {game_id}")]
    PublicCompanyNotFound { game_id: u64, company_id: u32 },

    #[error("Protocol {protocol_id}'s treasury does not hold enough VGP to buy this private company")]
    InsufficientTreasuryFunds { protocol_id: u32 },
}

/// Re-derives who should hold the President/Validator seat for
/// `protocol_id` from the current `PLAYER_SHARES` holdings of every
/// registered player in the game, persisting any change to
/// `PROTOCOL_PRESIDENT` and returning the (possibly unchanged) result.
///
/// Ties are broken by keeping the incumbent if they're part of the tied
/// group (so a trade that doesn't change the leader never causes
/// unnecessary churn), otherwise by the lexicographically-lowest address --
/// a simplification, since real 1830 breaks ties by stock-round turn
/// order, which isn't modeled here. If no one meets
/// `PRESIDENT_MIN_PERCENTAGE`, the seat is cleared.
///
/// **This IS the President's-certificate transfer** (Audit G-7). Called at
/// the end of every `execute_buy_stock`/`execute_sell_stock`, it is the
/// single point where the seat moves -- including on a stock dump, where
/// the outgoing President has just sold below the new leader. Because
/// ownership is stored as a percentage rather than as discrete cards, no
/// certificate objects need to change hands: writing the new holder here is
/// sufficient, and `state::count_player_certificates` immediately
/// re-derives both players' physical card counts from the new seat (the
/// incoming President's first 20% collapses to one card; the outgoing
/// President's 20% expands back to two ordinary 10% cards). See module doc
/// comment #11 for the full reasoning.
fn recalculate_president(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
    players: &[Addr],
) -> Result<Option<Addr>, TradingError> {
    let incumbent = PROTOCOL_PRESIDENT.may_load(storage, (game_id, protocol_id))?;

    let mut leader: Option<(Addr, u8)> = None;
    for player in players {
        let pct = PLAYER_SHARES
            .may_load(storage, (game_id, protocol_id, player.clone()))?
            .unwrap_or(0);
        if pct == 0 {
            continue;
        }

        leader = Some(match leader {
            None => (player.clone(), pct),
            Some((current_leader, current_pct)) => {
                if pct > current_pct {
                    (player.clone(), pct)
                } else if pct == current_pct {
                    if incumbent.as_ref() == Some(player) {
                        (player.clone(), pct)
                    } else if incumbent.as_ref() == Some(&current_leader) {
                        (current_leader, current_pct)
                    } else if player.as_str() < current_leader.as_str() {
                        (player.clone(), pct)
                    } else {
                        (current_leader, current_pct)
                    }
                } else {
                    (current_leader, current_pct)
                }
            }
        });
    }

    let new_president = leader.and_then(|(addr, pct)| {
        if pct >= PRESIDENT_MIN_PERCENTAGE {
            Some(addr)
        } else {
            None
        }
    });

    if new_president != incumbent {
        match &new_president {
            Some(addr) => PROTOCOL_PRESIDENT.save(storage, (game_id, protocol_id), addr)?,
            None => PROTOCOL_PRESIDENT.remove(storage, (game_id, protocol_id)),
        }
    }

    Ok(new_president)
}

/// Verifies `sender` is the player currently sitting at
/// `session.active_player_index` -- the Turn Priority Queue guardrail
/// `execute_buy_stock`/`execute_sell_stock` enforce before touching any
/// state (per-module, like `auction::ensure_active_player` mirrors for
/// `execute_bid_on_private` -- kept as separate small copies rather than a
/// shared cross-module helper since each module has its own error enum).
/// See `gamelog.rs`'s module doc comment #4 for how far turn-order
/// enforcement reaches beyond these three actions.
fn ensure_active_player(
    session: &GameSession,
    game_id: u64,
    sender: &Addr,
) -> Result<(), TradingError> {
    let active_player = session
        .player_addresses
        .get(session.active_player_index as usize)
        .cloned()
        .ok_or(TradingError::GameNotFound { game_id })?;
    if sender != &active_player {
        return Err(TradingError::NotYourTurn {
            game_id,
            expected: active_player.to_string(),
            got: sender.to_string(),
        });
    }
    Ok(())
}

/// Audit G-6, second half (module doc comment #18): rejects
/// `BuyStock`/`SellStock` unless the room is actually in a Stock Round.
/// Shared by both handlers so the two can never disagree about what "a
/// Stock Round is in progress" means.
///
/// Deliberately called AFTER each handler's own `waterfall_auction_active`
/// check, so the Waterfall Auction keeps reporting its own, more specific
/// `WaterfallAuctionInProgress` error (which names the five dedicated
/// `waterfall.rs` actions a player should be using instead) rather than
/// being folded into this generic one -- even though
/// `RoundType::WaterfallAuction` would also fail this check.
fn ensure_stock_round(session: &GameSession, game_id: u64) -> Result<(), TradingError> {
    if session.current_round_type != RoundType::StockRound {
        return Err(TradingError::StockActionOutsideStockRound {
            game_id,
            current_round_type: format!("{:?}", session.current_round_type),
        });
    }
    Ok(())
}

/// Resets `session.consecutive_passes` back to `0`, since a completed
/// action breaks any in-progress all-pass streak -- independent of whether
/// that action also advances the turn pointer. `advance_turn` calls this as
/// its counter-reset half; `execute_sell_stock` calls it directly, since a
/// sale resets the streak but must NOT move the seat (module doc comment
/// #9).
fn reset_pass_streak(session: &mut GameSession) {
    session.consecutive_passes = 0;
}

/// Advances `session.active_player_index` to the next player in
/// `player_addresses` order (wrapping around) and resets
/// `session.consecutive_passes` (see `reset_pass_streak`). Called after
/// every successful `BuyStock`/`auction::execute_bid_on_private` -- the two
/// actions that actually end a player's turn -- mirroring the
/// pointer-advance half of `gamelog::execute_pass_turn` (which instead
/// *increments* `consecutive_passes` -- see that function's doc comment for
/// why a pass and a trade affect the counter oppositely). Deliberately NOT
/// called by `execute_sell_stock` (module doc comment #9).
fn advance_turn(session: &mut GameSession) {
    let player_count = session.player_addresses.len() as u32;
    if player_count > 0 {
        session.active_player_index = (session.active_player_index + 1) % player_count;
    }
    reset_pass_streak(session);
}

/// Sums `protocol_id`'s `PLAYER_SHARES` across every address in `players`,
/// i.e. the total percentage of the protocol currently owned by real
/// players rather than sitting in `IPO_POOL_SHARES`/`BANK_POOL_SHARES`.
/// Under this module's shares invariant (every percentage point of a
/// protocol is either in one of the two pools or held by exactly one
/// registered player) this always equals `100 - IPO_POOL_SHARES -
/// BANK_POOL_SHARES`, but it's computed here by direct summation to match
/// this feature's "total percentage of shares owned by real players"
/// requirement literally, and to stay correct even if that invariant is
/// ever violated by a future change.
fn total_player_owned_percentage(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
    players: &[Addr],
) -> Result<u8, TradingError> {
    let mut total: u8 = 0;
    for player in players {
        let held = PLAYER_SHARES
            .may_load(storage, (game_id, protocol_id, player.clone()))?
            .unwrap_or(0);
        total = total.checked_add(held).ok_or(TradingError::Overflow {})?;
    }
    Ok(total)
}

/// The pool-side storage write `execute_buy_stock` has resolved but not yet
/// applied -- computed during that function's Checks phase (purely by
/// reading state) and only written to storage in its Effects phase, once
/// every validation check has passed. See module doc comment #13
/// (Checks-Effects-Interactions).
enum PoolEffect {
    Ipo {
        new_ipo_pct: u8,
        /// Set only on this protocol's very first-ever IPO purchase: the
        /// chosen par value and the `MARKET_GRID` coordinates it must be
        /// durably pinned to.
        first_purchase_pin: Option<(Uint128, u32, u32)>,
    },
    Bank {
        new_bank_pct: u8,
    },
}

/// Buys exactly one `PERCENT_PER_SHARE` certificate of `protocol_id`, from
/// either its IPO pool or its Open Market/Bank pool per `source` -- see
/// module doc comment #8 for the full Par Value Selection design, and
/// `msg::SharePurchaseSource`/`ExecuteMsg::BuyStock` for the field-level
/// contract. Payment always flows from the buyer's own `PLAYER_CASH_VGP`
/// into the game bank (`GameSession::virtual_bank_vgp`). If this purchase
/// empties *both* pools (100% of the protocol now in player hands), the
/// price marker advances up one row (sold-out bonus).
pub fn execute_buy_stock(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
    source: SharePurchaseSource,
    par_value: Option<Uint128>,
) -> Result<Response, TradingError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(TradingError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(TradingError::GameNotActive { game_id });
    }
    if session.waterfall_auction_active {
        return Err(TradingError::WaterfallAuctionInProgress { game_id });
    }
    // Audit G-6 (module doc comment #18): buying stock is a Stock Round
    // action. Rejected during an Operating Round (and during the Waterfall
    // Auction, though that's already caught by the more specific check
    // immediately above).
    ensure_stock_round(&session, game_id)?;
    if !session.player_addresses.contains(&info.sender) {
        return Err(TradingError::NotAPlayer {
            game_id,
            player: info.sender.to_string(),
        });
    }
    ensure_active_player(&session, game_id, &info.sender)?;

    let buyer_pct = PLAYER_SHARES
        .may_load(deps.storage, (game_id, protocol_id, info.sender.clone()))?
        .unwrap_or(0);
    let new_buyer_pct = buyer_pct
        .checked_add(PERCENT_PER_SHARE)
        .ok_or(TradingError::Overflow {})?;

    // ---- Checks (continued): resolve this purchase's price, its pool's
    // remaining percentage after the buy, and the current market cell's
    // zone type (needed below for BOTH the 60% ownership-cap check and the
    // Global Certificate Limit check -- module doc comment #12) -- branching
    // on `source`. Every branch here only *reads* storage; nothing is
    // written until the dedicated Effects section below, once every `Err`
    // path in this function has already returned (Checks-Effects-Interactions
    // -- module doc comment #13). `PoolEffect` carries forward whatever this
    // resolution decided should eventually be written.
    let (price, new_pool_pct, zone_type, pool_effect) = match source {
        SharePurchaseSource::Ipo => {
            let ipo_pct = IPO_POOL_SHARES
                .may_load(deps.storage, (game_id, protocol_id))?
                .unwrap_or(FULL_POOL_PERCENTAGE);
            if ipo_pct < PERCENT_PER_SHARE {
                return Err(TradingError::InsufficientPoolShares {
                    protocol_id,
                    pool: "IPO",
                    available: ipo_pct,
                    requested: PERCENT_PER_SHARE,
                });
            }

            // Resolves the par value this purchase pays, and -- only on
            // this protocol's very first-ever IPO purchase -- the (par
            // value, market cell coordinates) that must be durably pinned
            // once every check clears. Nothing is written here yet.
            let (par, first_purchase_pin) = match PROTOCOL_PAR_VALUE
                .may_load(deps.storage, (game_id, protocol_id))?
            {
                Some(existing) => {
                    if let Some(supplied) = par_value {
                        if supplied != existing {
                            return Err(TradingError::ParValueAlreadySet {
                                protocol_id,
                                par_value: existing,
                            });
                        }
                    }
                    (existing, None)
                }
                None => {
                    // The very first-ever IPO purchase of this
                    // protocol: par_value is required and must be a
                    // standard price.
                    let chosen = par_value.ok_or(TradingError::ParValueRequired { protocol_id })?;
                    let (x, y) = market::par_value_coords(chosen)
                        .ok_or(TradingError::InvalidParValue { par_value: chosen })?;
                    (chosen, Some((chosen, x, y)))
                }
            };

            let new_ipo_pct = ipo_pct
                .checked_sub(PERCENT_PER_SHARE)
                .ok_or(TradingError::Overflow {})?;

            // The cell this purchase's zone-type check resolves against --
            // read-only either way. On a first-ever IPO purchase, this
            // protocol has no market position recorded yet, so read the
            // about-to-be-pinned par cell straight out of the shared
            // `MARKET_GRID` template instead of writing the pin first and
            // reading it back.
            let cell = match first_purchase_pin {
                Some((_, x, y)) => MARKET_GRID
                    .may_load(deps.storage, (x, y))?
                    .ok_or(MarketError::MarketCellNotFound { x, y })?,
                None => market::current_cell(deps.storage, game_id, protocol_id)?,
            };

            (
                par,
                new_ipo_pct,
                cell.zone_type,
                PoolEffect::Ipo {
                    new_ipo_pct,
                    first_purchase_pin,
                },
            )
        }
        SharePurchaseSource::Bank => {
            if let Some(supplied) = par_value {
                return Err(TradingError::ParValueNotApplicableForBankPurchase {
                    par_value: supplied,
                });
            }

            let bank_pct = BANK_POOL_SHARES
                .may_load(deps.storage, (game_id, protocol_id))?
                .unwrap_or(0);
            if bank_pct < PERCENT_PER_SHARE {
                return Err(TradingError::InsufficientPoolShares {
                    protocol_id,
                    pool: "Bank",
                    available: bank_pct,
                    requested: PERCENT_PER_SHARE,
                });
            }

            // Every `CORE_PUBLIC_COMPANIES` protocol already has a market
            // position seeded at room-creation time
            // (`market::initialize_game_market`), so this is a genuine
            // read -- see module doc comment #13 for why this no longer
            // calls `market::ensure_protocol_position` as a write-capable
            // fallback first.
            let cell = market::current_cell(deps.storage, game_id, protocol_id)?;

            let new_bank_pct = bank_pct
                .checked_sub(PERCENT_PER_SHARE)
                .ok_or(TradingError::Overflow {})?;

            (
                cell.price,
                new_bank_pct,
                cell.zone_type,
                PoolEffect::Bank { new_bank_pct },
            )
        }
    };

    // See module doc comment #2: real 1830's "a single player may hold more
    // than 60%" exception is granted by the Orange and Brown bands, not
    // Yellow alone.
    let ownership_cap_exempt = matches!(zone_type, ZoneType::OrangeZone | ZoneType::BrownZone);
    if new_buyer_pct > CERTIFICATE_LIMIT_PERCENTAGE && !ownership_cap_exempt {
        return Err(TradingError::CertificateLimitExceeded {
            protocol_id,
            new_total: new_buyer_pct,
            limit: CERTIFICATE_LIMIT_PERCENTAGE,
        });
    }

    // Global Certificate Limit (module doc comment #12): a STRICT, hard
    // block -- not a warning -- on the buyer's total physical certificate
    // count (every private company owned, plus every public-company stock
    // card held, across the whole game -- see `state::count_player_certificates`
    // for exactly how a certificate is counted, including the President's
    // card counting as exactly one). Checked here, now that `zone_type` is
    // resolved, rather than at the top of this function's checks, so the
    // zone exemption immediately below can apply -- moving this check
    // changes nothing about the Checks-Effects-Interactions ordering (module
    // doc comment #13): this is still purely a read, still resolved before
    // the Effects section below writes anything.
    //
    // Zone exemption: per the real 1830 rule this project documents for
    // players (`RulesReference.tsx`'s zone legend / `StockMarketRenderer.tsx`
    // design note #3), a certificate whose company currently sits on a
    // Yellow, Orange, or Brown market cell does not count toward the Global
    // Certificate Limit at all -- broader than the ownership-cap exemption
    // just above (Orange/Brown only), since Yellow alone still exempts a
    // certificate from the *hand limit* even though it does not exempt a
    // holding from the 60% ownership cap. This was previously TRACKED as
    // real, sourced zone data but never actually wired into an enforcement
    // check (see this function's own module doc comment #2, now updated) --
    // this pass is what gives it a genuine code hook.
    let certificate_limit_exempt = matches!(
        zone_type,
        ZoneType::YellowZone | ZoneType::OrangeZone | ZoneType::BrownZone
    );
    if !certificate_limit_exempt {
        let private_ids: Vec<u32> = CORE_PRIVATE_COMPANIES
            .iter()
            .map(|(private_id, ..)| *private_id)
            .collect();
        let public_company_ids: Vec<u32> = CORE_PUBLIC_COMPANIES
            .iter()
            .map(|(company_id, _ticker)| *company_id)
            .collect();
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
            .ok_or(TradingError::Overflow {})?;
        let certificate_limit =
            certificate_limit_for_player_count(session.max_players).unwrap_or(u32::MAX);
        if would_hold_certificates > certificate_limit {
            return Err(TradingError::ExceededCertificateLimit {
                player: info.sender.to_string(),
                max_players: session.max_players,
                limit: certificate_limit,
                would_hold: would_hold_certificates,
            });
        }
    }

    let buyer_balance = PLAYER_CASH_VGP
        .may_load(deps.storage, (game_id, info.sender.clone()))?
        .unwrap_or_default();
    let new_buyer_balance =
        buyer_balance
            .checked_sub(price)
            .map_err(|_| TradingError::InsufficientFunds {
                player: info.sender.to_string(),
            })?;

    let new_virtual_bank_vgp = session
        .virtual_bank_vgp
        .checked_add(price)
        .map_err(|_| TradingError::Overflow {})?;

    // ---- Effects: every check above has passed -- info.sender is the
    // active player, within every pool/par/limit/funds constraint -- so
    // from here on every remaining fallible call is an internal
    // bookkeeping step, not a user-facing validation. Now, and only now,
    // does this function write anything.
    match pool_effect {
        PoolEffect::Ipo {
            new_ipo_pct,
            first_purchase_pin,
        } => {
            if let Some((chosen, x, y)) = first_purchase_pin {
                PROTOCOL_PAR_VALUE.save(deps.storage, (game_id, protocol_id), &chosen)?;
                // Pin the protocol's starting market marker to the chosen
                // par cell.
                market::set_protocol_position(deps.storage, game_id, protocol_id, x, y)?;
            }
            IPO_POOL_SHARES.save(deps.storage, (game_id, protocol_id), &new_ipo_pct)?;
        }
        PoolEffect::Bank { new_bank_pct } => {
            BANK_POOL_SHARES.save(deps.storage, (game_id, protocol_id), &new_bank_pct)?;
        }
    }

    session.virtual_bank_vgp = new_virtual_bank_vgp;

    // Brown Zone Multiple-Buy (module doc comment #15): a Bank-pool
    // purchase made while sitting on a Brown-zone cell does NOT end the
    // buyer's turn, so they may immediately buy again. Every other
    // purchase -- any IPO purchase, or a Bank purchase outside a Brown
    // cell -- advances the pointer as normal.
    let is_brown_zone_bank_multi_buy =
        matches!(source, SharePurchaseSource::Bank) && zone_type == ZoneType::BrownZone;

    // A completed purchase is (ordinarily) a turn-gated action: advance the
    // pointer to the next player and clear any in-progress all-pass streak,
    // exactly like a successful `PassTurn` advances the pointer (see
    // `advance_turn`'s doc comment for why the counter itself moves the
    // opposite direction) -- unless the Brown Zone Multiple-Buy exception
    // above applies.
    if !is_brown_zone_bank_multi_buy {
        advance_turn(&mut session);
    }

    // Inactivity Timeout Safety Valve (see `state.rs`'s
    // `GameSession::last_action_timestamp` doc comment): a successful
    // BuyStock call resets the room's 48-hour inactivity clock.
    session.last_action_timestamp = env.block.time.seconds();

    PLAYER_CASH_VGP.save(
        deps.storage,
        (game_id, info.sender.clone()),
        &new_buyer_balance,
    )?;
    PLAYER_SHARES.save(
        deps.storage,
        (game_id, protocol_id, info.sender.clone()),
        &new_buyer_pct,
    )?;
    SESSIONS.save(deps.storage, game_id, &session)?;

    let mut response = Response::new()
        .add_attribute("action", "buy_stock")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("buyer", info.sender.clone())
        .add_attribute(
            "source",
            match source {
                SharePurchaseSource::Ipo => "ipo",
                SharePurchaseSource::Bank => "bank",
            },
        )
        .add_attribute("price_paid", price)
        .add_attribute("buyer_percentage", new_buyer_pct.to_string())
        .add_attribute("pool_percentage_remaining", new_pool_pct.to_string());

    if is_brown_zone_bank_multi_buy {
        response = response.add_attribute("brown_zone_multiple_buy", "true");
    }

    // $350 Game-End Trigger (module doc comment #16): set once an ascending
    // movement below lands on the chart's top cell; checked at the very end
    // of this function, after every other piece of this purchase's own
    // bookkeeping has already completed normally.
    let mut game_end_triggered = false;

    // "Sold out" (the classic 18xx price bump) means the protocol's entire
    // 100% is now in player hands -- both pools empty, not just the one
    // this particular purchase drew from.
    let other_pool_pct = match source {
        SharePurchaseSource::Ipo => BANK_POOL_SHARES
            .may_load(deps.storage, (game_id, protocol_id))?
            .unwrap_or(0),
        SharePurchaseSource::Bank => IPO_POOL_SHARES
            .may_load(deps.storage, (game_id, protocol_id))?
            .unwrap_or(FULL_POOL_PERCENTAGE),
    };
    if new_pool_pct == 0 && other_pool_pct == 0 {
        let sold_out_cell = market::move_up(deps.storage, game_id, protocol_id)?;
        response = response
            .add_attribute("sold_out", "true")
            .add_attribute("new_price", sold_out_cell.price)
            .add_attribute("new_x", sold_out_cell.x.to_string())
            .add_attribute("new_y", sold_out_cell.y.to_string());
        if market::price_triggers_game_end(&sold_out_cell) {
            game_end_triggered = true;
        }
    }

    // General flotation check (see module doc comment #7): if this purchase
    // brought protocol_id's total real-player-owned stake to (or past)
    // FLOAT_THRESHOLD_PERCENTAGE and it hasn't already floated by some
    // other path (B&O floats for free the instant its private is won --
    // see `auction::award_bo_president_share` -- so is already
    // `is_floated: true` long before ordinary trading could reach this
    // check), flip it to floated and capitalize its treasury at 10x its Par
    // Value (never a Bank/Market price -- see module doc comment #7/#8).
    let maybe_company: Option<PublicCompany> =
        PUBLIC_COMPANIES.may_load(deps.storage, (game_id, protocol_id))?;
    if let Some(mut company) = maybe_company {
        if !company.is_floated {
            let total_player_owned = total_player_owned_percentage(
                deps.storage,
                game_id,
                protocol_id,
                &session.player_addresses,
            )?;
            if total_player_owned >= FLOAT_THRESHOLD_PERCENTAGE {
                let par_for_treasury = PROTOCOL_PAR_VALUE
                    .may_load(deps.storage, (game_id, protocol_id))?
                    .ok_or(TradingError::MissingParValueAtFloat { protocol_id })?;
                let snapshot_cell = market::current_cell(deps.storage, game_id, protocol_id)?;

                company.is_floated = true;
                company.total_shares_issued = STANDARD_SHARE_COUNT;
                company.treasury = par_for_treasury
                    .checked_mul(Uint128::new(FLOAT_CAPITALIZATION_MULTIPLIER))
                    .map_err(|_| TradingError::Overflow {})?;
                company.current_x = snapshot_cell.x;
                company.current_y = snapshot_cell.y;
                PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

                // Station Tokens (`hexmap.rs` module doc comment #23): grant
                // this protocol's free home token the moment it floats via
                // the ordinary 60%-ownership path -- a no-op for NNH, which
                // has no assigned home hex on this board.
                hexmap::grant_home_station_token(deps.storage, game_id, protocol_id)?;

                response = response
                    .add_attribute("newly_floated", "true")
                    .add_attribute(
                        "float_total_player_owned_percentage",
                        total_player_owned.to_string(),
                    )
                    .add_attribute("float_par_value", par_for_treasury)
                    .add_attribute("float_treasury", company.treasury);
            }
        }
    }

    // The buyer's new stake may have made them (or kept them as) the
    // protocol's largest shareholder -- re-derive the President seat.
    let president = recalculate_president(
        deps.storage,
        game_id,
        protocol_id,
        &session.player_addresses,
    )?;
    response = response.add_attribute(
        "protocol_president",
        president.as_ref().map(Addr::as_str).unwrap_or("none"),
    );

    // $350 Game-End Trigger (module doc comment #16): everything above --
    // the purchase itself, the float check, the President recalculation --
    // is this action's own bookkeeping and has already completed normally.
    // Only now, once all of that is done, does hitting the chart's top
    // cell close the room out and halt every subsequent turn.
    if game_end_triggered {
        let end_game_response =
            crate::contract::finalize_and_distribute_payouts(deps, game_id, session)
                .map_err(|e| TradingError::Std(StdError::generic_err(e.to_string())))?;
        response = response
            .add_attribute("game_end_triggered", "true")
            .add_attributes(end_game_response.attributes)
            // See `operations.rs`'s identical fix for the full rationale:
            // `Response::messages` is `Vec<SubMsg>`, and `add_messages` needs
            // `Into<CosmosMsg>` items, so this unwraps each SubMsg back to
            // its inner `msg` -- lossless, since every one of these
            // originated from `finalize_and_distribute_payouts` wrapping
            // plain `BankMsg::Send` values with the default `reply_on:
            // ReplyOn::Never`.
            .add_messages(end_game_response.messages.into_iter().map(|m| m.msg));
    }

    Ok(response)
}

/// Sells `percentage` (a multiple of `PERCENT_PER_SHARE`) of `protocol_id`
/// back onto the Open Market/Bank pool (`BANK_POOL_SHARES` -- never back
/// into `IPO_POOL_SHARES`; a dumped share has been sold before and is never
/// "new" stock again). Each certificate is settled one at a time at the
/// price in effect *at that moment*, then drops the price one row
/// (dumped-shares movement), so later certificates in a multi-certificate
/// sale settle at a lower price -- matching the physical 18xx board.
pub fn execute_sell_stock(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
    percentage: u8,
) -> Result<Response, TradingError> {
    if percentage == 0 || percentage % PERCENT_PER_SHARE != 0 {
        return Err(TradingError::InvalidSharePercentage {
            percent_per_share: PERCENT_PER_SHARE,
        });
    }

    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(TradingError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(TradingError::GameNotActive { game_id });
    }
    if session.waterfall_auction_active {
        return Err(TradingError::WaterfallAuctionInProgress { game_id });
    }
    // Audit G-6 (module doc comment #18): selling stock is a Stock Round
    // action, same gate `execute_buy_stock` applies.
    ensure_stock_round(&session, game_id)?;
    // Audit G-6, first half: the classic 1830 rule that NO share may be
    // sold during the game's opening Stock Round. Checked here, before any
    // per-player or per-protocol state is read, since it depends only on
    // the room's own round counters. `macro_round_number` starts at `1` at
    // genesis and is bumped to `2` by Macro Round Loop Advancement
    // (`operations::execute_end_operating_round_turn`), so this ban lifts
    // exactly when the first full Stock-Round-then-Operating-Rounds cycle
    // completes -- i.e. at the start of SR2, which is precisely the real
    // rule. The `current_round_type` half of the condition is redundant
    // after `ensure_stock_round` above, and kept only because it makes the
    // rule this encodes readable on its own.
    if session.macro_round_number == 1 && session.current_round_type == RoundType::StockRound {
        return Err(TradingError::SalesProhibitedInFirstStockRound { game_id });
    }
    if !session.player_addresses.contains(&info.sender) {
        return Err(TradingError::NotAPlayer {
            game_id,
            player: info.sender.to_string(),
        });
    }
    ensure_active_player(&session, game_id, &info.sender)?;

    let seller_pct = PLAYER_SHARES
        .may_load(deps.storage, (game_id, protocol_id, info.sender.clone()))?
        .unwrap_or(0);
    if seller_pct < percentage {
        return Err(TradingError::InsufficientShares {
            protocol_id,
            available: seller_pct,
            requested: percentage,
        });
    }

    // 50% Bank Pool Cap (module doc comment #10): computed and validated
    // up front, before any state is touched, since it depends only on the
    // pool's current percentage and this sale's size -- not on anything
    // the price-movement loop below does.
    let bank_pct = BANK_POOL_SHARES
        .may_load(deps.storage, (game_id, protocol_id))?
        .unwrap_or(0);
    let new_bank_pct = bank_pct
        .checked_add(percentage)
        .filter(|p| *p <= FULL_POOL_PERCENTAGE)
        .ok_or(TradingError::Overflow {})?;
    if new_bank_pct > BANK_POOL_CAP_PERCENTAGE {
        return Err(TradingError::BankPoolCapExceeded {
            protocol_id,
            new_bank_pct,
            cap: BANK_POOL_CAP_PERCENTAGE,
        });
    }

    // President/Validator Transfer -- true 1830 stock dumping (Audit G-7,
    // module doc comment #11). Simulates the holdings this sale would
    // actually leave behind and rejects it ONLY if no one at all could hold
    // the President's certificate afterward.
    //
    // This replaced a blanket pre-check that rejected ANY sale by a sitting
    // President unless some OTHER player already held at least 20%. That
    // was stricter than the real rule and blocked legal play: a President
    // holding 60% could not sell a single 10% certificate -- even though
    // they would still hold 50%, still be the largest holder, and still be
    // President afterward -- purely because nobody else had reached 20%.
    // An engine that rejects a legal move is as wrong as one that permits
    // an illegal one.
    //
    // The real constraint is only this: a floated corporation must always
    // have SOMEONE holding its President's certificate. So the sale is
    // legal whenever, after it settles, at least one player (the seller
    // included) still holds `PRESIDENT_MIN_PERCENTAGE`. Three cases fall
    // out of that single rule:
    //   - Seller keeps >= 20% and stays largest -> legal, seat unchanged.
    //   - Seller keeps >= 20% but another holder is now larger -> legal,
    //     and `recalculate_president` below moves the seat to them.
    //   - Seller drops below 20% -> legal only if another player is at or
    //     above 20% to take the seat; otherwise `NoEligiblePresidentSuccessor`.
    // The classic "dump" -- selling out from under the presidency and
    // handing it to whoever is left -- is the third case, and it now
    // executes instead of being refused.
    if let Some(current_president) =
        PROTOCOL_PRESIDENT.may_load(deps.storage, (game_id, protocol_id))?
    {
        if current_president == info.sender {
            // `seller_pct >= percentage` was already validated above, so
            // this cannot underflow.
            let seller_pct_after_sale = seller_pct
                .checked_sub(percentage)
                .ok_or(TradingError::Overflow {})?;

            let mut best_other_holding: u8 = 0;
            for player in &session.player_addresses {
                if player == &info.sender {
                    continue;
                }
                let held = PLAYER_SHARES
                    .may_load(deps.storage, (game_id, protocol_id, player.clone()))?
                    .unwrap_or(0);
                if held > best_other_holding {
                    best_other_holding = held;
                }
            }

            // Nobody -- not the seller, not any rival -- would be left
            // holding enough to be President. That is the one genuinely
            // illegal dump.
            if seller_pct_after_sale < PRESIDENT_MIN_PERCENTAGE
                && best_other_holding < PRESIDENT_MIN_PERCENTAGE
            {
                return Err(TradingError::NoEligiblePresidentSuccessor {
                    protocol_id,
                    player: info.sender.to_string(),
                    min_percentage: PRESIDENT_MIN_PERCENTAGE,
                });
            }
        }
    }

    market::ensure_protocol_position(deps.storage, game_id, protocol_id, 0, 0)?;

    let num_certificates = percentage / PERCENT_PER_SHARE;

    // Audit G-4 (module doc comment #6): EVERY certificate in a single sale
    // transacts at the price the marker sits on when the sale BEGINS. The
    // marker then walks down one row per certificate sold, AFTER the money
    // has already changed hands.
    //
    // This previously read `current_cell()` fresh inside the loop and
    // called `move_down` between certificates, so selling 30% settled
    // certificate #2 one row lower than #1 and #3 two rows lower -- the
    // seller was paid a progressively worse price the deeper into their own
    // sale they got. That is not the 1830 rule (nor what any reference
    // implementation does): the price is read once, all certificates
    // transact at it, and only then does the marker move.
    let sale_price = market::current_cell(deps.storage, game_id, protocol_id)?.price;

    let total_proceeds = sale_price
        .checked_mul(Uint128::from(num_certificates))
        .map_err(|_| TradingError::Overflow {})?;

    let seller_balance = PLAYER_CASH_VGP
        .may_load(deps.storage, (game_id, info.sender.clone()))?
        .unwrap_or_default()
        .checked_add(total_proceeds)
        .map_err(|_| TradingError::Overflow {})?;

    session.virtual_bank_vgp = session
        .virtual_bank_vgp
        .checked_sub(total_proceeds)
        .map_err(|_| TradingError::InsufficientBankFunds {})?;
    // Deferred Bank-Break Halt (see `state.rs`'s `GameSession::bank_is_broken`
    // doc comment): this is currently the ONLY debit against
    // `virtual_bank_vgp` anywhere in this contract (every other write
    // site is a credit), so it's the one place that can ever drive the
    // bank to exactly zero. Setting the flag here does NOT itself end
    // the game -- `operations::execute_end_operating_round_turn` is what
    // actually acts on it, once the current scheduled block of
    // Operating Rounds finishes. Now checked once against the sale's single
    // combined debit rather than per certificate: with one atomic
    // subtraction there are no intermediate balances for it to observe, and
    // "the bank is exactly empty once this sale settles" is the condition
    // the rule actually cares about. (A sale the bank cannot fully cover
    // still fails outright with `InsufficientBankFunds` above, exactly as
    // before -- CosmWasm reverts every write on an `Err` return, so the
    // old per-certificate loop could never have partially paid either.)
    if session.virtual_bank_vgp.is_zero() {
        session.bank_is_broken = true;
    }

    // Every certificate sold onto the open market drops the price one row,
    // per rules.md's dumped-shares trigger -- applied here, after the sale
    // has fully settled at `sale_price`.
    for _ in 0..num_certificates {
        market::move_down(deps.storage, game_id, protocol_id)?;
    }

    let final_cell = market::current_cell(deps.storage, game_id, protocol_id)?;

    let new_seller_pct = seller_pct
        .checked_sub(percentage)
        .ok_or(TradingError::Overflow {})?;

    // Turn Pacing (module doc comment #9): a sale resets the all-pass
    // streak (it's a real action) but deliberately does NOT advance
    // active_player_index -- a player may sell any number of blocks on
    // their turn before the one BuyStock-or-PassTurn action that actually
    // ends it.
    reset_pass_streak(&mut session);

    // Inactivity Timeout Safety Valve (see `state.rs`'s
    // `GameSession::last_action_timestamp` doc comment): a successful
    // SellStock call resets the room's 48-hour inactivity clock.
    session.last_action_timestamp = env.block.time.seconds();

    PLAYER_CASH_VGP.save(
        deps.storage,
        (game_id, info.sender.clone()),
        &seller_balance,
    )?;
    PLAYER_SHARES.save(
        deps.storage,
        (game_id, protocol_id, info.sender.clone()),
        &new_seller_pct,
    )?;
    BANK_POOL_SHARES.save(deps.storage, (game_id, protocol_id), &new_bank_pct)?;
    SESSIONS.save(deps.storage, game_id, &session)?;

    let mut response = Response::new()
        .add_attribute("action", "sell_stock")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("seller", info.sender)
        .add_attribute("percentage_sold", percentage.to_string())
        .add_attribute("total_proceeds", total_proceeds)
        .add_attribute("seller_percentage_remaining", new_seller_pct.to_string())
        .add_attribute("bank_pool_percentage", new_bank_pct.to_string())
        .add_attribute("final_price", final_cell.price)
        .add_attribute("final_x", final_cell.x.to_string())
        .add_attribute("final_y", final_cell.y.to_string());

    // The seller may have given up the largest-shareholder spot (or, if
    // someone else already held it, this trade doesn't change that) --
    // re-derive the President seat either way.
    let president = recalculate_president(
        deps.storage,
        game_id,
        protocol_id,
        &session.player_addresses,
    )?;
    response = response.add_attribute(
        "protocol_president",
        president.as_ref().map(Addr::as_str).unwrap_or("none"),
    );

    Ok(response)
}

/// Declares an Operating Round dividend of `revenue_amount` for
/// `protocol_id`. If `distribute` is true (Distribute Yield), the revenue
/// is split proportionally across every share -- player-held cuts go to
/// `PLAYER_CASH_VGP`, the pool's cut (plus rounding dust) goes to the
/// game bank -- and the price marker moves right. If false (Slash/Retain
/// Yield), the full amount is credited to the protocol's treasury and the
/// price marker moves left. Only `protocol_id`'s registered
/// `PROTOCOL_PRESIDENT` may call this (see module doc comment #4).
pub fn execute_declare_dividends(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
    revenue_amount: Uint128,
    distribute: bool,
) -> Result<Response, TradingError> {
    if revenue_amount.is_zero() {
        return Err(TradingError::ZeroRevenue {});
    }

    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(TradingError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(TradingError::GameNotActive { game_id });
    }

    // Strictly the protocol's registered President/Validator, never the
    // room creator, per this feature's requirement -- a protocol with no
    // qualifying majority holder yet has no one who can declare for it.
    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(TradingError::NoPresidentAssigned {
            protocol_id,
            min_percentage: PRESIDENT_MIN_PERCENTAGE,
        })?;
    if info.sender != president {
        return Err(TradingError::NotPresident { protocol_id });
    }


    // ==== Audit G-14: Operating Round sub-phase gate. ====
    // Declared against revenue the Routes phase already computed. This phase
    // is NEVER skippable -- pay or withhold are both legal, so "neither" is not.
    if let Err(mismatch) = or_phase::require_sub_phase(
        deps.storage,
        &session,
        protocol_id,
        OperatingSubPhase::Dividends,
    ) {
        return Err(match mismatch {
            or_phase::PhaseMismatch::Wrong { actual, required } => TradingError::WrongOperatingSubPhase {
                protocol_id,
                actual: or_phase::phase_name(actual).to_string(),
                actual_index: or_phase::phase_index(actual),
                required: or_phase::phase_name(required).to_string(),
                required_index: or_phase::phase_index(required),
            },
            or_phase::PhaseMismatch::Storage(message) => TradingError::Std(StdError::generic_err(message)),
        });
    }

    // Operating Round Corporation Turn Queue (see `hexmap.rs`'s module doc
    // comment #13 for the shared design): layered on top of the President
    // check above, only enforced once the room actually has a non-empty
    // `active_operating_order`.
    if let Some(&expected_protocol_id) = session
        .active_operating_order
        .get(session.active_corporation_index as usize)
    {
        if protocol_id != expected_protocol_id {
            return Err(TradingError::NotYourOperatingTurn {
                game_id,
                protocol_id,
                expected_protocol_id,
            });
        }
    }

    {
        let (default_x, default_y) = market::DEFAULT_MARKET_POSITION;
        market::ensure_protocol_position(deps.storage, game_id, protocol_id, default_x, default_y)?;
    }

    // Audit G-14: the payout decision is made; move on to buying trains.
    or_phase::advance(deps.storage, game_id, protocol_id, OperatingSubPhase::Dividends)?;

    let mut response = Response::new()
        .add_attribute("action", "declare_dividends")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("revenue_amount", revenue_amount)
        .add_attribute("distribute", distribute.to_string());

    // $350 Game-End Trigger (module doc comment #16): only Distribute
    // Yield's `move_right` is an ascending movement; Slash/Retain Yield's
    // `move_left` (the `else` branch below) can only move the marker away
    // from $350, never onto it, so it needs no check.
    let mut game_end_triggered = false;

    if distribute {
        let mut distributed = Uint128::zero();
        for player in session.player_addresses.clone() {
            let holder_pct = PLAYER_SHARES
                .may_load(deps.storage, (game_id, protocol_id, player.clone()))?
                .unwrap_or(0);
            if holder_pct == 0 {
                continue;
            }

            let payout = revenue_amount
                .checked_mul(Uint128::from(holder_pct))
                .map_err(|_| TradingError::Overflow {})?
                .checked_div(Uint128::from(FULL_POOL_PERCENTAGE))
                .map_err(|_| TradingError::Overflow {})?;
            if payout.is_zero() {
                continue;
            }

            let balance = PLAYER_CASH_VGP
                .may_load(deps.storage, (game_id, player.clone()))?
                .unwrap_or_default();
            let new_balance = balance
                .checked_add(payout)
                .map_err(|_| TradingError::Overflow {})?;
            PLAYER_CASH_VGP.save(deps.storage, (game_id, player.clone()), &new_balance)?;

            distributed = distributed
                .checked_add(payout)
                .map_err(|_| TradingError::Overflow {})?;
            response = response
                .add_attribute("dividend_recipient", player)
                .add_attribute("dividend_payout", payout);
        }

        // Real 1830 rule: revenue attributable to shares still sitting in
        // the corporation's OWN IPO warehouse (never yet sold to a player
        // or the open-market Bank pool) is paid directly into that
        // corporation's own treasury -- it is the corporation's own unsold
        // stock, not the bank's money, and Rule.md's dividend procedure
        // does not treat it as forfeited. Revenue attributable to shares
        // sitting in the open-market Bank pool has no owner to pay and
        // continues to be absorbed by the game bank, exactly as before this
        // change. `non_player_share` is the combined leftover after every
        // player's own (rounded-down) payout -- i.e. the IPO pool's share,
        // the Bank pool's share, and any per-player integer-division dust,
        // all together -- and is split between the two pools proportional
        // to their live percentages so the split stays exact (`ipo_share +
        // bank_share == non_player_share` by construction, no VGP created
        // or destroyed) without needing to track dust separately.
        let non_player_share = revenue_amount
            .checked_sub(distributed)
            .map_err(|_| TradingError::Overflow {})?;

        let ipo_pct = IPO_POOL_SHARES
            .may_load(deps.storage, (game_id, protocol_id))?
            .unwrap_or(FULL_POOL_PERCENTAGE);
        let bank_pct = BANK_POOL_SHARES
            .may_load(deps.storage, (game_id, protocol_id))?
            .unwrap_or(0);
        let non_player_pct = u32::from(ipo_pct) + u32::from(bank_pct);

        let ipo_share = if non_player_pct == 0 || non_player_share.is_zero() {
            // Every share is player-held (or there's no residual at all) --
            // nothing is owed to the IPO warehouse.
            Uint128::zero()
        } else {
            non_player_share
                .checked_mul(Uint128::from(ipo_pct))
                .map_err(|_| TradingError::Overflow {})?
                .checked_div(Uint128::from(non_player_pct))
                .map_err(|_| TradingError::Overflow {})?
        };
        let bank_share = non_player_share
            .checked_sub(ipo_share)
            .map_err(|_| TradingError::Overflow {})?;

        // Audit G-2 (Split Treasury Divergence): the IPO warehouse's own
        // dividend share is credited to `PublicCompany::treasury` inside
        // `PUBLIC_COMPANIES` -- the SINGLE corporate cash ledger every
        // debit site already draws from (`hardware.rs`'s train purchases,
        // `hexmap.rs`'s terrain and Station Token fees). It used to be
        // written to a separate `PROTOCOL_TREASURY_VGP` map that nothing
        // in this contract ever debited, so this VGP was credited and then
        // permanently stranded. See `state.rs`'s removal note.
        let mut new_protocol_treasury: Option<Uint128> = None;
        if !ipo_share.is_zero() {
            let mut company: PublicCompany = PUBLIC_COMPANIES
                .may_load(deps.storage, (game_id, protocol_id))?
                .ok_or(TradingError::PublicCompanyNotFound {
                    game_id,
                    company_id: protocol_id,
                })?;
            company.treasury = company
                .treasury
                .checked_add(ipo_share)
                .map_err(|_| TradingError::Overflow {})?;
            let updated_treasury = company.treasury;
            PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;
            new_protocol_treasury = Some(updated_treasury);
        }

        session.virtual_bank_vgp = session
            .virtual_bank_vgp
            .checked_add(bank_share)
            .map_err(|_| TradingError::Overflow {})?;

        let new_cell = market::move_right(deps.storage, game_id, protocol_id)?;
        response = response
            .add_attribute("distributed_to_players", distributed)
            .add_attribute("ipo_share_to_treasury", ipo_share)
            .add_attribute("bank_share", bank_share)
            .add_attribute("new_price", new_cell.price)
            .add_attribute("new_x", new_cell.x.to_string())
            .add_attribute("new_y", new_cell.y.to_string());
        if let Some(new_treasury) = new_protocol_treasury {
            response = response.add_attribute("protocol_treasury_total", new_treasury);
        }
        if market::price_triggers_game_end(&new_cell) {
            game_end_triggered = true;
        }
    } else {
        // Audit G-2 (Split Treasury Divergence): Slash/Retain Yield now
        // credits `PublicCompany::treasury` inside `PUBLIC_COMPANIES`, the
        // same single corporate cash ledger `operations.rs`'s own two
        // withhold branches (`execute_operating_round`,
        // `execute_run_manual_route`) already wrote to, and the same one
        // `hardware.rs`/`hexmap.rs` debit when the corporation actually
        // spends. Withheld revenue used to land in a separate
        // `PROTOCOL_TREASURY_VGP` map with no debit path at all, so a
        // corporation retaining earnings across several Operating Rounds
        // to afford a train had, on-chain, saved nothing spendable.
        let mut company: PublicCompany = PUBLIC_COMPANIES
            .may_load(deps.storage, (game_id, protocol_id))?
            .ok_or(TradingError::PublicCompanyNotFound {
                game_id,
                company_id: protocol_id,
            })?;
        company.treasury = company
            .treasury
            .checked_add(revenue_amount)
            .map_err(|_| TradingError::Overflow {})?;
        let new_treasury = company.treasury;
        PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

        let new_cell = market::move_left(deps.storage, game_id, protocol_id)?;
        response = response
            .add_attribute("withheld_to_treasury", revenue_amount)
            .add_attribute("protocol_treasury_total", new_treasury)
            .add_attribute("new_price", new_cell.price)
            .add_attribute("new_x", new_cell.x.to_string())
            .add_attribute("new_y", new_cell.y.to_string());
    }

    // Inactivity Timeout Safety Valve (see `state.rs`'s
    // `GameSession::last_action_timestamp` doc comment): a successful
    // DeclareDividends call resets the room's 48-hour inactivity clock.
    session.last_action_timestamp = env.block.time.seconds();

    if game_end_triggered {
        // $350 Game-End Trigger (module doc comment #16): this dividend's
        // own bookkeeping is complete; `finalize_and_distribute_payouts`
        // persists this same `session` (already carrying the bank-share
        // credit and refreshed timestamp above) with `is_active = false`,
        // superseding the plain `SESSIONS.save` the non-triggered path
        // below would otherwise do.
        let end_game_response =
            crate::contract::finalize_and_distribute_payouts(deps, game_id, session)
                .map_err(|e| TradingError::Std(StdError::generic_err(e.to_string())))?;
        response = response
            .add_attribute("game_end_triggered", "true")
            .add_attributes(end_game_response.attributes)
            // See `operations.rs`'s identical fix for the full rationale:
            // unwrap each `SubMsg` back to its inner `msg` -- lossless here
            // too, same default `reply_on: ReplyOn::Never` origin.
            .add_messages(end_game_response.messages.into_iter().map(|m| m.msg));
        return Ok(response);
    }

    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(response)
}

/// Phase-Gated Corporate Purchase Protocol (module doc comment #17): buys
/// private company `private_id` out from under its current player-owner,
/// on behalf of `protocol_id`'s own treasury. See the module doc comment
/// for the full design; in short, hard-blocked before Phase 3
/// (`TileColor::Green`), President-authorized and softly Operating-Round-
/// Turn-Queue-gated exactly like `execute_declare_dividends`, and priced
/// within 50%-200% of the private's face value inclusive.
pub fn execute_buy_private_company(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
    private_id: u32,
    price: Uint128,
) -> Result<Response, TradingError> {
    let session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(TradingError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(TradingError::GameNotActive { game_id });
    }

    // Phase-Gated Corporate Purchase Protocol: hard-blocked until Phase 3
    // (the 3-train era, `TileColor::Green` in this engine's model) begins
    // -- checked before authorization/pricing so an out-of-phase attempt
    // always fails the same way regardless of who calls it or what price
    // they offer.
    if session.current_global_era < TileColor::Green {
        return Err(TradingError::PrivatePurchaseLockedBeforePhase3 {
            game_id,
            current_era: session.current_global_era,
        });
    }

    // Strictly the protocol's registered President/Validator, mirroring
    // `execute_declare_dividends` exactly.
    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(TradingError::NoPresidentAssigned {
            protocol_id,
            min_percentage: PRESIDENT_MIN_PERCENTAGE,
        })?;
    if info.sender != president {
        return Err(TradingError::NotPresident { protocol_id });
    }


    // ==== Audit G-14: Operating Round sub-phase gate. ====
    // FIRST phase of the turn, before track. Only reachable from Phase 3 on --
    // `or_phase::initial_sub_phase` starts the cursor at `Track` while the era
    // is Yellow, so this phase does not exist yet rather than being skipped.
    if let Err(mismatch) = or_phase::require_sub_phase(
        deps.storage,
        &session,
        protocol_id,
        OperatingSubPhase::BuyPrivate,
    ) {
        return Err(match mismatch {
            or_phase::PhaseMismatch::Wrong { actual, required } => TradingError::WrongOperatingSubPhase {
                protocol_id,
                actual: or_phase::phase_name(actual).to_string(),
                actual_index: or_phase::phase_index(actual),
                required: or_phase::phase_name(required).to_string(),
                required_index: or_phase::phase_index(required),
            },
            or_phase::PhaseMismatch::Storage(message) => TradingError::Std(StdError::generic_err(message)),
        });
    }

    // Operating Round Corporation Turn Queue (soft gate, mirrors
    // `execute_declare_dividends`): only enforced once the room actually
    // has a non-empty `active_operating_order`.
    if let Some(&expected_protocol_id) = session
        .active_operating_order
        .get(session.active_corporation_index as usize)
    {
        if protocol_id != expected_protocol_id {
            return Err(TradingError::NotYourOperatingTurn {
                game_id,
                protocol_id,
                expected_protocol_id,
            });
        }
    }

    let mut private: PrivateCompany = PRIVATE_COMPANIES
        .may_load(deps.storage, (game_id, private_id))?
        .ok_or(TradingError::PrivateCompanyNotFound {
            game_id,
            private_id,
        })?;
    if private.closed {
        return Err(TradingError::PrivateCompanyClosed { private_id });
    }
    let Some(seller) = private.owner.clone() else {
        return Err(TradingError::PrivateNotOwnedByAPlayer { private_id });
    };

    // Pricing guardrails: `price` must land in [50%, 200%] of face value,
    // inclusive -- see module doc comment #17 for why this is checked by
    // cross-multiplication rather than dividing `cost` by 2.
    let price_at_least_half = price
        .checked_mul(Uint128::new(2))
        .map_err(|_| TradingError::Overflow {})?
        >= private.cost;
    let max_price = private
        .cost
        .checked_mul(Uint128::new(2))
        .map_err(|_| TradingError::Overflow {})?;
    if !price_at_least_half || price > max_price {
        return Err(TradingError::PrivatePurchasePriceOutOfBounds {
            private_id,
            price,
            face_value: private.cost,
        });
    }

    let mut company: PublicCompany = PUBLIC_COMPANIES
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(TradingError::PublicCompanyNotFound {
            game_id,
            company_id: protocol_id,
        })?;
    if company.treasury < price {
        return Err(TradingError::InsufficientTreasuryFunds { protocol_id });
    }
    company.treasury = company
        .treasury
        .checked_sub(price)
        .map_err(|_| TradingError::Overflow {})?;
    PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

    let seller_balance = PLAYER_CASH_VGP
        .may_load(deps.storage, (game_id, seller.clone()))?
        .unwrap_or_default();
    let new_seller_balance = seller_balance
        .checked_add(price)
        .map_err(|_| TradingError::Overflow {})?;
    PLAYER_CASH_VGP.save(deps.storage, (game_id, seller.clone()), &new_seller_balance)?;

    private.owner = None;
    private.owner_protocol_id = Some(protocol_id);
    PRIVATE_COMPANIES.save(deps.storage, (game_id, private_id), &private)?;

    // Audit G-14: one private purchase per turn; move on to track.
    or_phase::advance(deps.storage, game_id, protocol_id, OperatingSubPhase::BuyPrivate)?;

    Ok(Response::new()
        .add_attribute("action", "buy_private_company")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("private_id", private_id.to_string())
        .add_attribute("price", price)
        .add_attribute("seller", seller.as_str())
        .add_attribute("new_treasury", company.treasury))
}
