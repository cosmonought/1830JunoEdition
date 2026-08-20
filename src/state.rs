use cosmwasm_std::{Addr, StdResult, Storage, Uint128};
use cw_storage_plus::{Item, Map};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::msg::SharePurchaseSource;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct GameConfig {
    pub developer_treasury: Addr,
    pub subsidy_fee_percentage: u64, // e.g., 50 for 0.5%
}

/// A tile's 1830 colour tier. Declared Yellow-first so the derived `Ord`
/// compares eras the way the real progression does (`Green > Yellow`,
/// `Brown > Green`) -- `current_global_era` can therefore never regress.
/// Unlock triggers: the first 3-train (Green) and first 5-train (Brown).
#[derive(
    Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, JsonSchema,
)]
pub enum TileColor {
    Yellow,
    Green,
    Brown,
}

/// The Macro Round Tracker's coarse round type.
///
/// `WaterfallAuction` is the room's true genesis phase, and
/// `waterfall::conclude_waterfall` is the ONE AND ONLY exit from it -- nothing
/// ever sets it back. `StockRound`/`OperatingRound` are the repeating cycle,
/// driven by `execute_begin_operating_round` and Macro Round Loop Advancement.
///
/// Declared chronologically for readability only: NOTHING derives `Ord` for this
/// enum, in deliberate contrast to `TileColor` above, which does.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
pub enum RoundType {
    WaterfallAuction,
    StockRound,
    OperatingRound,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct GameSession {
    pub game_id: u64,
    pub creator: Addr,
    pub total_juno_pool: Uint128,  // Real JUNO deposited by players
    /// The exact GROSS real-JUNO amount the creator deposited, which every joiner
    /// must match to the last `ujuno` (the Uniform Ante Rule). Written once, never
    /// mutated. Validated at creation against `escrow::MINIMUM_ANTE`, so this field
    /// is also the room's proof that its floor was cleared.
    ///
    /// `#[serde(default)]`: rooms predating it read zero, and the join path falls
    /// back to re-reading the creator's own `PLAYER_JUNO_ANTE` row for that case.
    #[serde(default)]
    pub room_ante: Uint128,
    pub virtual_bank_vgp: Uint128, // In-game play money (Starts at 12,000)
    /// The room's *immutable* genesis bank value -- exactly what
    /// `virtual_bank_vgp` was set to at `CreateGameRoom` time, never
    /// touched again afterward. `virtual_bank_vgp` itself is live and gets
    /// mutated by ordinary trading (buys/sells/dividends flow VGP into and
    /// out of it), so `gamelog::reapply_game_log` needs this separate,
    /// untouched baseline to reset back to before fast-forwarding the
    /// event log -- see that function's doc comment.
    pub virtual_bank_start: Uint128,
    pub is_active: bool,
    pub player_addresses: Vec<Addr>,
    /// The room's declared player count (2-6, validated at creation), fixed
    /// for the life of the room. Used as the denominator for every player's
    /// starting VGP capital (`contract::STARTING_CAPITAL_POOL / max_players`)
    /// so everyone gets the *same* amount regardless of join order, and as
    /// the cap `JoinGameRoom` enforces (`ContractError::RoomFull` once
    /// `player_addresses.len() == max_players`).
    pub max_players: u8,
    /// Index into `player_addresses` of whose turn it is -- the base Turn Priority
    /// Queue primitive. Only this player may `PassTurn`, and `reapply_game_log`
    /// recomputes it by replaying every `PassTurn` in the log from `0`.
    pub active_player_index: u32,
    /// Index into `player_addresses` of whoever holds the Priority Deal --
    /// the classic 18xx marker for who acts first once a new Stock Round
    /// begins. Tracked as state from room creation (`0`, the creator)
    /// onward, and recomputed identically by `gamelog::reapply_game_log`,
    /// but nothing in this contract yet reassigns it during play (e.g. on
    /// a sold-out round) or gates a Stock-Round-boundary action on it --
    /// that round-structure logic doesn't exist yet, so this field is
    /// currently a static `0` for every room, present as the storage slot
    /// the eventual round-boundary feature will read and write.
    pub priority_deal_index: u32,
    /// Who took the last COMMITTING action this Stock Round, or `None`.
    ///
    /// Exists for one purpose: 1830's Priority Deal passes to the player seated
    /// immediately LEFT of whoever acted last. That is not derivable when the round
    /// ends -- by then everyone has passed, `active_player_index` has wrapped an
    /// unknown number of times, and `consecutive_passes` says how many passes
    /// happened but not who broke the previous streak. So it is recorded when known.
    ///
    /// PASSING DELIBERATELY DOES NOT UPDATE THIS. A pass is the absence of an
    /// action; if it counted, the rule would degenerate into "the deal passes to the
    /// left of whoever passed last", which is every round the same seat regardless
    /// of what anyone did.
    ///
    /// `u32` to match every other seat index here. Reset to `None` by
    /// `conclude_stock_round` so a round in which nobody acts cannot silently reuse
    /// the previous round's actor.
    #[serde(default)]
    pub last_active_player_index: Option<u32>,
    /// How many `ExecuteMsg::PassTurn` calls have landed *in a row*, with
    /// no intervening turn-gated trade (`BuyStock`/`SellStock`/
    /// `BidOnPrivate`) resetting the streak. `gamelog::execute_pass_turn`
    /// increments this by one on every successful pass; every successful
    /// turn-gated trade resets it back to `0`, since it breaks the
    /// all-pass streak. This is the storage slot a future Stock-Round-ends
    /// feature would read (the classic 18xx rule: the round ends once
    /// every player has passed in a row, i.e. this count reaches
    /// `player_addresses.len()`) -- nothing in this contract yet acts on
    /// that condition, matching `priority_deal_index`'s "tracked but not
    /// yet consumed" status above. `gamelog::reapply_game_log` resets this
    /// to `0` at genesis and recomputes it identically to live play by
    /// replaying every `PassTurn`/trade in the event log in order.
    pub consecutive_passes: u32,
    /// The highest `TileColor` currently unlocked room-wide. Starts `Yellow`, only
    /// ever advances (Green on the first 3-train, Brown on the first 5-train), never
    /// regresses. `reapply_game_log` resets to `Yellow` and recomputes it identically
    /// to live play by replaying every `BuyHardwareFromPool` in order.
    pub current_global_era: TileColor,
    /// The Operating Round Corporation Turn Queue: the ordered list of
    /// floated `PublicCompany::company_id`s that get to act, in turn, during
    /// the room's current Operating Round -- computed by
    /// `operations::calculate_operating_order` (highest stock price first,
    /// ties broken by whichever protocol's market marker arrived at its
    /// price most recently -- see that function's doc comment) and written
    /// by `operations::execute_begin_operating_round`. Empty before a
    /// room's first Operating Round has ever been begun, and reset back to
    /// empty by `gamelog::reapply_game_log` (see that module's doc comment
    /// for why a `BeginOperatingRound` call itself isn't replayable). An
    /// **empty** queue means the room's per-company Operating Round turn
    /// structure isn't currently in effect for this game -- see
    /// `active_corporation_index`'s doc comment for exactly how that
    /// affects `LayTile`/`BuyHardwareFromPool`/`DeclareDividends`.
    pub active_operating_order: Vec<u32>,
    /// Index into `active_operating_order` of whichever corporation holds the
    /// Operating Round turn. `LayTile`, `BuyHardwareFromPool` and `DeclareDividends`
    /// check it IN ADDITION TO their President-only authorization.
    ///
    /// When `active_operating_order` is EMPTY the check is skipped entirely and those
    /// three stay gated only by President authorization -- this opt-in behaviour is
    /// what keeps the whole turn-queue feature a purely additive change.
    pub active_corporation_index: u32,
    /// Unix seconds of the most recent state-advancing action -- the Inactivity
    /// Timeout Safety Valve's clock. After 48 hours with no qualifying action any
    /// player may `AnnulGame` and every ante is refunded.
    ///
    /// Refreshed by exactly SIX handlers (`BuyStock`, `SellStock`,
    /// `DeclareDividends`, `PassTurn`, `LayTile`, `BuyHardwareFromPool`) and
    /// deliberately NOT by every mutating message -- matching the requested scope.
    pub last_action_timestamp: u64,
    /// The Macro Round Tracker's coarse phase for this room -- see
    /// `RoundType`'s own doc comment for the exact transition rule. Starts
    /// at `RoundType::WaterfallAuction` at genesis
    /// (`contract::execute_create_game_room`) -- the six core private
    /// companies must be fully allocated (`waterfall.rs`) before Stock
    /// Round 1 can ever open; `waterfall::conclude_waterfall` is this
    /// contract's one and only transition into `RoundType::StockRound`.
    /// `gamelog::reapply_game_log` resets this back to
    /// `WaterfallAuction` (not `StockRound`) alongside
    /// `active_operating_order`/`active_corporation_index`, for the same
    /// "not replayable" reasoning -- see that function's own doc comment
    /// for the resulting Waterfall Auction/Undo interaction gap.
    pub current_round_type: RoundType,
    /// The Macro Round Tracker's overall counter -- the leading digit of "SR2",
    /// "OR3". Starts at 1; Macro Round Loop Advancement increments it when a full
    /// Stock-Round-then-every-paced-Operating-Round cycle completes.
    ///
    /// `reapply_game_log` deliberately does NOT reset this, unlike the four fields
    /// around it: a macro-round boundary is not "replayable" state the way an
    /// in-progress turn queue is.
    pub macro_round_number: u32,
    /// Which sub-round is active within the current phase -- the `.1` in "OR2.1".
    /// Set to `1` when an Operating Round begins; `0` at genesis and after a replay
    /// reset. Advances once every queued corporation has acted, until it reaches
    /// `operating_round_sequence_length`, at which point the next such moment resets
    /// it to `0` instead (Macro Round Loop Advancement).
    pub sub_round_index: u32,
    /// Pacing Automation: how many consecutive Operating Round sub-rounds
    /// the *current* Operating Round phase is scheduled to run for, per the
    /// classic 1830 rule keyed off the highest Hardware tier any company has
    /// purchased so far in this room -- 1 OR for a 2-train, 2 ORs for a
    /// 3-train or 4-train, 3 ORs for a 5-train or higher (`6`/`D`). Computed
    /// by `hardware::operating_round_sequence_length_for_tier` and written by
    /// `operations::execute_begin_operating_round` every time an Operating
    /// Round begins (so it's always current for whatever triggered the most
    /// recent Stock-Round-concludes transition -- see that function's doc
    /// comment for exactly which "stock round concludes" moment this hooks).
    /// `0` at genesis and after `gamelog::reapply_game_log` resets it, since
    /// no Operating Round has been begun to compute a real value for yet.
    pub operating_round_sequence_length: u32,
    /// The Deferred Bank-Break Halt flag. Once `virtual_bank_vgp` is exhausted the
    /// game does NOT hard-stop mid-Operating-Round: every corporation finishes out
    /// the CURRENT paced block of ORs, and the game ends when that block concludes.
    ///
    /// Set the moment a debit drives the bank to exactly zero. Consulted by
    /// `execute_end_operating_round_turn` at the precise moment it would otherwise
    /// return to a Stock Round, where it calls `finalize_and_distribute_payouts`
    /// instead.
    ///
    /// NOT reset by `reapply_game_log`: once the bank has genuinely run dry earlier
    /// in the log, replaying that log should reach the same broken-bank state again,
    /// not silently forget it -- the same reasoning `macro_round_number` records.
    pub bank_is_broken: bool,
    /// Waterfall Auction: `true` from room genesis until the pre-game private
    /// auction concludes -- either all six privates are owned or the price walks to
    /// zero. While `true`, ordinary Stock Round trading and the legacy
    /// continuous-bid auction are all rejected; every private-company action must go
    /// through `waterfall.rs`'s five dedicated messages. Flips to `false` exactly
    /// once, permanently, in the same step `current_round_type` moves to StockRound.
    pub waterfall_auction_active: bool,
    /// Waterfall Auction: how many `ExecuteMsg::WaterfallPass` calls have
    /// landed *in a row*, with no intervening `WaterfallBuyLowest`/
    /// `WaterfallBidHigher` resetting the streak -- the outer-loop sibling
    /// of `consecutive_passes` (Stock/Operating Round scope) and
    /// `AuctionError`'s own turn-order bookkeeping, kept as its own field
    /// rather than reusing `consecutive_passes` since the two phases'
    /// termination conditions are unrelated (see `waterfall.rs`'s module
    /// doc comment for the Waterfall Cascade's exact early-termination
    /// rule: a full round of passes, `== player_addresses.len()`, ends the
    /// whole auction on the spot rather than merely ending a sub-round like
    /// `consecutive_passes` tracks elsewhere). Reset to `0` on room genesis
    /// and every time the waterfall concludes.
    pub consecutive_waterfall_passes: u32,
    /// Waterfall Auction: whichever player most recently won ownership of a
    /// private company via `waterfall::resolve_private_win` -- `None` until
    /// the very first private is won (possible right up until the waterfall
    /// concludes, in the edge case where every player passes before anyone
    /// has ever actually bought/won anything -- see `waterfall.rs`'s module
    /// doc comment). Consulted exactly once, by `waterfall::
    /// conclude_waterfall`, to assign Stock Round 1's Priority Deal to the
    /// player seated immediately to this address's left -- the classic
    /// 18xx rule. Stale (and unread) after the waterfall concludes.
    pub last_private_winner: Option<Addr>,
}

/// Waterfall Auction: persisted exactly while a tie-breaking mini-auction is
/// resolving 2+ simultaneous bids on one private. Only one can ever be in
/// progress per room (the cascade pauses at a single tie point), hence the plain
/// `u64` key. Absence gates the outer-loop actions; presence gates the
/// mini-auction pair.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct WaterfallMiniAuction {
    /// The private company this mini-auction is resolving ownership of --
    /// always whatever `waterfall::lowest_unowned_private_id` returned at
    /// the moment the Waterfall Cascade discovered 2+ simultaneous bids on
    /// it.
    pub private_id: u32,
    /// The still-active participants, in the room's fixed seating order
    /// (`GameSession::player_addresses`) rather than raw storage iteration
    /// order -- see `waterfall::start_mini_auction`'s doc comment for why.
    /// Shrinks by one every time a non-leading participant passes; the
    /// mini-auction resolves the instant this reaches length `1`.
    pub bidders: Vec<Addr>,
    /// Index into `bidders` of whoever must act next -- always the next
    /// participant who is NOT the current `high_bidder` (see
    /// `waterfall::skip_leader_turns`'s doc comment for why the current
    /// leader's own slots are auto-skipped rather than ever explicitly
    /// prompted).
    pub turn_index: u32,
    /// The current standing high bid -- starts at whichever pre-existing
    /// bid was highest among the tied bidders when the mini-auction began,
    /// and only ever increases (each `WaterfallMiniAuctionRaise` must beat
    /// it by at least `auction::MIN_BID_INCREMENT`).
    pub high_bid: Uint128,
    /// Whoever currently holds `high_bid` -- the mini-auction's eventual
    /// winner if everyone else passes before overtaking them.
    pub high_bidder: Addr,
}

/// (game_id) -> `WaterfallMiniAuction`, present only while a Waterfall
/// Auction tie-breaker is actively resolving -- see that struct's own doc
/// comment.
pub const WATERFALL_MINI_AUCTION: Map<u64, WaterfallMiniAuction> = Map::new("waterfall_mini_auction");

/// A single priced cell on the 2D stock-market grid (see `rules.md`,
/// section 3, Step 4). `x` is the column (price generally increases moving
/// right), `y` is the row (price generally increases moving up) -- see
/// `src/market.rs` for the movement mechanics that walk a protocol across
/// this grid.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MarketCell {
    pub x: u32,
    pub y: u32,
    pub price: Uint128,
    pub zone_type: ZoneType,
}

/// The real 1830 chart's three tactical zones, sourced from `tobymao/18xx`'s
/// `share_price.rb`/`g_1830/game.rb`. Each is strictly more permissive than the
/// last, matching the board's nested colour bands:
///
///   YellowZone (`y`, `:no_cert_limit`)  certificates here do not count toward
///                                       the holder's hand limit.
///   OrangeZone (`o`, `:unlimited`)      also: one player may exceed the 60%
///                                       ownership cap.
///   BrownZone  (`b`, `:multiple_buy`)   also: multiple certificates from the
///                                       Bank pool in one turn.
///
/// The CUMULATIVE reading is this implementation's explicit choice, matching the
/// standard rulebook -- it is NOT a literal transcription, since the verbatim
/// `MARKET` array tags each cell with only a single letter (a `b` cell is never
/// also tagged `o`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
pub enum ZoneType {
    /// No special exemptions -- the standard 60%-cap, one-purchase-per-turn
    /// rules apply in full.
    Normal,
    YellowZone,
    OrangeZone,
    BrownZone,
}

impl ZoneType {
    /// True when a certificate of a company on this cell does NOT count toward its
    /// holder's Global Certificate Limit. Granted by ALL THREE bands (Yellow is where
    /// the exemption starts), which is broader than the 60% ownership cap's own
    /// Orange/Brown-only exemption.
    ///
    /// The single predicate `check_cert_limit` uses BOTH to decide whether the
    /// incoming purchase counts AND to filter already-held certificates out of the
    /// running total. Before Batch 1 it only skipped the incoming certificate, which
    /// over-counted every previously-bought zone-exempt certificate still held.
    pub fn waives_certificate_limit(&self) -> bool {
        matches!(
            self,
            ZoneType::YellowZone | ZoneType::OrangeZone | ZoneType::BrownZone
        )
    }

    /// **Step 4.5 Batch 1, item 2 (Orange Zone invariant).** True when a
    /// single player may hold more than the standard
    /// `trading::CERTIFICATE_LIMIT_PERCENTAGE` (60%) of a corporation
    /// sitting on this cell -- up to and including 100%. Granted by Orange
    /// and Brown only: Yellow waives the *hand* limit above but NOT this,
    /// narrower, per-corporation ownership cap.
    pub fn waives_ownership_cap(&self) -> bool {
        matches!(self, ZoneType::OrangeZone | ZoneType::BrownZone)
    }

    /// **Step 4.5 Batch 1, item 1/2 (Brown Zone invariant).** True when a
    /// player may buy more than one certificate of a corporation sitting on
    /// this cell in a single action. Brown only -- and, per
    /// `trading::execute_buy_stock`, only from the open-market Bank pool;
    /// the IPO never permits a multi-buy regardless of zone.
    pub fn permits_multiple_buy(&self) -> bool {
        matches!(self, ZoneType::BrownZone)
    }
}

/// Where one game's one protocol's price marker sits on the shared `MARKET_GRID`
/// template. Deliberately does not repeat `game_id` as a field -- the owning
/// `(game_id, protocol_id)` lives in the map key, matching every other
/// composite-keyed struct here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ProtocolMarketState {
    pub protocol_id: u32,
    pub current_x: u32,
    pub current_y: u32,
    /// A per-game monotonically increasing counter, stamped with a fresh
    /// value (via `market::next_arrival_sequence`) every time this
    /// protocol's marker is written -- its initial default placement
    /// (`market::ensure_protocol_position`), an unconditional overwrite
    /// (`market::set_protocol_position`, e.g. pinning to a chosen Par Value
    /// cell), or an ordinary grid movement (`market::apply_market_movement`).
    /// Used purely to break ties in `operations::calculate_operating_order`
    /// when two protocols share the exact same market price: the classic
    /// 1830 rule of "whichever token is stacked on top" is modeled here as
    /// "whichever protocol's marker most recently arrived anywhere on the
    /// grid" -- the higher `arrival_sequence` wins the tie. Not meant to be
    /// read for anything else.
    pub arrival_sequence: u64,
}

pub const CONFIG: Item<GameConfig> = Item::new("config");
pub const SESSIONS: Map<u64, GameSession> = Map::new("sessions");
pub const NEXT_GAME_ID: Item<u64> = Item::new("next_game_id");

/// (x, y) -> MarketCell. A single shared, global price-chart *template* --
/// intentionally NOT keyed by `game_id`, since it's just the static board
/// layout (which price sits at which grid cell), identical for every game
/// room, exactly like a physical 18xx board's printed price chart is the
/// same for every table. Sparse: only cells that have been seeded with a
/// price need to exist; `market::apply_market_movement` errors clearly if a
/// movement lands on an unseeded cell rather than guessing a price.
pub const MARKET_GRID: Map<(u32, u32), MarketCell> = Map::new("market_grid");

/// (game_id, protocol_id) -> ProtocolMarketState, the live position of that
/// *specific game's* protocol price marker on the shared `MARKET_GRID`
/// board template. Keyed by `game_id` (unlike `MARKET_GRID` itself) so
/// concurrently running game rooms never share or clobber each other's
/// marker positions for the same `protocol_id` -- see
/// `market::initialize_game_market`, called once per room at
/// `contract::execute_create_game_room`, and every `market.rs` function
/// that reads or moves a marker, all of which take `game_id` explicitly.
pub const PROTOCOL_MARKET: Map<(u64, u32), ProtocolMarketState> = Map::new("protocol_market");

/// game_id -> the next value `market::next_arrival_sequence` will hand out
/// for that game room, backing `ProtocolMarketState::arrival_sequence`'s
/// Operating Order tie-break. Starts unseeded (treated as `0`) and is
/// incremented by one every time any protocol's market marker is written in
/// that game room, so it's a single, strictly increasing "who moved most
/// recently, across every protocol" clock per room.
pub const MARKET_ARRIVAL_SEQUENCE: Map<u64, u64> = Map::new("market_arrival_sequence");

/// (game_id, protocol_id, player) -> percentage of that protocol's shares
/// (0-100) currently held by that player. See `trading::PERCENT_PER_SHARE`
/// for the fixed certificate size and `trading::CERTIFICATE_LIMIT_PERCENTAGE`
/// for the per-player holding cap.
pub const PLAYER_SHARES: Map<(u64, u32, Addr), u8> = Map::new("player_shares");

/// (game_id, protocol_id) -> percentage of that protocol's shares (0-100)
/// still sitting in its Initial Public Offering (IPO) pool -- shares that
/// have never yet been sold to any player. Treated as fully unsold (100)
/// when no entry has been written yet -- see `trading::FULL_POOL_PERCENTAGE`.
/// Bought at the protocol's fixed `PROTOCOL_PAR_VALUE`, not its floating
/// `MARKET_GRID` price -- see `trading::execute_buy_stock`.
pub const IPO_POOL_SHARES: Map<(u64, u32), u8> = Map::new("ipo_pool_shares");

/// (game_id, protocol_id) -> percentage of that protocol's shares sitting in the
/// Open Market/Bank pool. Unlike `IPO_POOL_SHARES`, an unseeded entry defaults to
/// EMPTY (0): nothing has been dumped back until a sale happens. Bought at the
/// live `MARKET_GRID` price, not the fixed par.
pub const BANK_POOL_SHARES: Map<(u64, u32), u8> = Map::new("bank_pool_shares");

/// (game_id, protocol_id) -> the fixed Par Value (VGP) chosen for that
/// protocol's stock the moment its very first-ever IPO share is bought
/// (`trading::execute_buy_stock`) -- one of the six standard 1830 par
/// prices in `market::PAR_VALUE_LADDER`. Every later IPO purchase (as
/// opposed to an Open Market/Bank purchase, which always pays the live
/// `MARKET_GRID` price instead) is charged this fixed amount, regardless of
/// where the protocol's market marker later moves via dividends, sold-out
/// bonuses, or dumped shares.
pub const PROTOCOL_PAR_VALUE: Map<(u64, u32), Uint128> = Map::new("protocol_par_value");

/// (game_id, player) -> that player's spendable Virtual Game Point (VGP)
/// cash balance for this game, used to buy/sell stock and receive
/// dividends. Provisioned by `JoinGameRoom` (see `contract::STARTING_CAPITAL_POOL`)
/// and treated as zero if somehow read before that.
pub const PLAYER_CASH_VGP: Map<(u64, Addr), Uint128> = Map::new("player_cash_vgp");

/// The Stock Round Buyback Lockout: which corporations a player has sold during
/// the CURRENT Stock Round. A player may not buy back into a corporation they
/// have already sold in the same round -- without it, a player could sell 30% to
/// crater a rival's price and immediately re-buy cheaper, a pure-profit wash
/// trade the physical game forbids.
///
/// A sorted, deduplicated `Vec<u32>`, not a `HashSet<String>`, and both halves
/// are deliberate. `HashSet`'s JSON serialization has NO GUARANTEED ELEMENT
/// ORDER, which is a determinism hazard in a CosmWasm contract -- two validators
/// could serialize the same logical set into two different byte strings and
/// disagree on the state root. Lists are at most 8 long, so a linear scan is
/// cheaper than hashing anyway. And `protocol_id` rather than a ticker, because
/// a ticker would be a second, drift-prone identity for a corporation.
///
/// Cleared at the Stock-Round-to-Operating-Round boundary from BOTH
/// `conclude_stock_round` and `execute_begin_operating_round`, so it can never
/// leak across a round.
pub const PLAYER_SR_SALES: Map<(u64, Addr), Vec<u32>> = Map::new("player_sr_sales");

/// (game_id, player) -> the exact real-JUNO amount that specific player
/// deposited into the room's `total_juno_pool`, recorded once at the
/// moment they deposit: the creator's `deposit_amount` in
/// `contract::execute_create_game_room`, or a joiner's `joined_amount` in
/// `contract::execute_join_game_room`. Under the Uniform Ante Rule (see
/// `execute_join_game_room`'s doc comment), every joiner's deposit is
/// verified to exactly match the room creator's own entry here before
/// their join is accepted -- so, for any given `game_id`, every player's
/// entry in this map is now identical and always nonzero. This is also the
/// Inactivity Timeout Safety Valve's refund ledger:
/// `contract::execute_claim_timeout_refund` reads it to send each player
/// back exactly what they personally put in, rather than splitting
/// `total_juno_pool` some other way. Distinct from `PLAYER_CASH_VGP`
/// (in-game play money) and from `total_juno_pool` (the room-wide
/// aggregate) -- this is per-player, real-JUNO, and set once at deposit
/// time rather than fluctuating with gameplay.
pub const PLAYER_JUNO_ANTE: Map<(u64, Addr), Uint128> = Map::new("player_juno_ante");

// REMOVED (Audit G-2, Split Treasury Divergence): `PROTOCOL_TREASURY_VGP`.
//
// A corporation's treasury was written to TWO independent places nothing ever
// reconciled -- `execute_declare_dividends` credited withheld revenue here,
// while every DEBIT site and every other credit site used
// `PublicCompany::treasury`.
//
// NOTHING ANYWHERE EVER DEBITED THIS MAP, so every VGP retained through
// `DeclareDividends` was permanently unspendable: a company could withhold for
// five Operating Rounds to save for a 5-train and, on-chain, have saved nothing
// it could spend. That broke the entire capital-accumulation loop.
//
// `PublicCompany::treasury` is now the single source of truth for corporate VGP.

/// (game_id, protocol_id) -> the player address currently serving as that
/// protocol's President/Validator (the highest shareholder, at or above
/// `trading::PRESIDENT_MIN_PERCENTAGE`). Absent if no one currently
/// qualifies (e.g. the protocol hasn't floated yet).
pub const PROTOCOL_PRESIDENT: Map<(u64, u32), Addr> = Map::new("protocol_president");

/// A private company, seeded unowned at room creation.
///
/// `owner` and `owner_protocol_id` are MUTUALLY EXCLUSIVE: at most one is ever
/// `Some`. Both `None` is unowned; a winning bid sets `owner`; a corporate
/// purchase clears `owner` and sets `owner_protocol_id`. A private can never be
/// owned by both a player and a corporation, or by two corporations.
///
/// `closed` is set permanently by either the B&O Special Closure (the instant the
/// public B&O buys its first train) or the Phase 5 Private Closure (every open
/// private, the instant the room's first 5-train is bought). A closed private
/// pays no further revenue, can never be traded again, and releases whichever
/// board hex its ownership reserved.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PrivateCompany {
    pub private_id: u32,
    pub name: String,
    pub cost: Uint128,           // face value / minimum opening bid, in VGP
    pub revenue_per_or: Uint128, // VGP revenue paid to the owner each Operating Round
    pub owner: Option<Addr>,
    /// Set once a public company (rather than a player) buys this private
    /// via `ExecuteMsg::BuyPrivateCompany`. See this struct's own doc
    /// comment for the full `owner`/`owner_protocol_id` invariant.
    pub owner_protocol_id: Option<u32>,
    /// True once this private is permanently removed from play. See this
    /// struct's own doc comment for both closure triggers.
    pub closed: bool,
}

/// (game_id, private_id) -> PrivateCompany. Seeded by
/// `auction::spawn_core_private_companies` when a game room is created.
pub const PRIVATE_COMPANIES: Map<(u64, u32), PrivateCompany> = Map::new("private_companies");

/// (game_id, private_id, bidder) -> that bidder's current standing
/// (escrowed) bid. Shared by two features:
/// - `auction::execute_bid_on_private` (the legacy continuous-bid English
///   auction, still available once the Waterfall Auction has concluded):
///   only the current top bidder -- i.e. whoever `PrivateCompany::owner`
///   currently points at -- ever has an entry here at a time; outbid
///   players are refunded and their entry removed.
/// - `waterfall.rs`'s Waterfall Auction (the room's actual genesis
///   mechanism -- see that module's doc comment): MULTIPLE simultaneous
///   entries can exist per `private_id` here at once, one per player who's
///   placed a `WaterfallBidHigher` on it, since the waterfall's open-bidding
///   phase lets any number of players independently bid on the same
///   still-open private before the cascade ever inspects it. Every entry
///   here always has real VGP actually escrowed (deducted from
///   `PLAYER_CASH_VGP`) backing it, in both features.
pub const PRIVATE_BIDS: Map<(u64, u32, Addr), Uint128> = Map::new("private_bids");

/// A public railroad corporation. Once floated, its shares, market
/// position, and presidency are tracked by the existing `protocol_id`-keyed
/// maps already used by `market.rs`/`trading.rs` (`PLAYER_SHARES`,
/// `IPO_POOL_SHARES`, `BANK_POOL_SHARES`, `PROTOCOL_PAR_VALUE`,
/// `PROTOCOL_PRESIDENT`, `PROTOCOL_MARKET`), using
/// this struct's `company_id` as that same `protocol_id` -- a
/// `PublicCompany` *is* a "protocol" in those maps' terms. `current_x`/
/// `current_y` are a convenience snapshot of the company's market position
/// as of the last time this struct was written (e.g. when it floats); the
/// live, authoritative position that `trading.rs`'s price movements
/// actually update is `PROTOCOL_MARKET` (read via `market::current_cell`),
/// so treat these two fields as a point-in-time snapshot rather than a
/// value that stays live once ordinary Stock/Operating Round trading moves
/// the price marker.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PublicCompany {
    pub company_id: u32,
    pub ticker: String,
    pub current_x: u32,
    pub current_y: u32,
    pub treasury: Uint128,
    pub is_floated: bool,
    pub total_shares_issued: u8,
    /// The total revenue this corporation's trains earned the LAST time it ran
    /// routes -- written on every run, whether paid out or withheld, zero or not.
    ///
    /// Deliberately `Uint128`, not the requested `u32`: every other monetary quantity
    /// here is `Uint128` per the no-floats rule, and a `u32` would need a lossy,
    /// panic-prone narrowing at its one write site and would silently truncate a
    /// late-game route above ~4.29 billion base units.
    ///
    /// `#[serde(default)]` is REQUIRED, not stylistic: every `PublicCompany` already
    /// written predates this field, and without it those records stop deserializing
    /// the moment the contract is upgraded, bricking every game in flight.
    #[serde(default)]
    pub last_route_revenue: Uint128,
}

/// (game_id, company_id) -> PublicCompany. Seeded unfloated by
/// `public_company::spawn_core_public_companies` when a game room is
/// created; floated for Baltimore & Ohio specifically by
/// `auction::award_bo_president_share` (see that function's doc comment).
pub const PUBLIC_COMPANIES: Map<(u64, u32), PublicCompany> = Map::new("public_companies");

/// A hex's terrain classification, tagged onto each `TILE_CATALOG` entry and used
/// as the key into `hexmap::terrain_base_value`.
///
/// `DoubleTown` is a single hex printing TWO independent town stops -- the real
/// board's Akron & Canton (G7), Reading & Allentown (G17) and New Haven &
/// Hartford (F20) -- distinct from `SmallTown`'s single stop.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
pub enum TerrainType {
    Plain,
    MountainRugged,
    SmallTown,
    DoubleTown,
    MajorCityHub,
    /// A preprinted OO double-city hex's upgrade artwork: two distinct station
    /// circles sharing one hex. Added because previously EVERY city-type hex, OO
    /// included, required plain `MajorCityHub` -- which let a player upgrade a real
    /// two-station hex (Detroit & Windsor) with an ordinary single-city tile.
    /// Exclusive to `hexmap::OO_DESIGNATED_HEXES`' four hexes.
    DoubleCityHub,
    /// Real 1830's "B"-labeled hex upgrade artwork (`hexmap.rs` module doc
    /// comment #26, Canonical Tile Upgrade Restrictions; extended by #27) --
    /// mirrors `DoubleCityHub`'s own "a real 1830 hex label restricts which
    /// tile artwork may be laid there, and vice versa" pattern. The Rust
    /// identifier is a holdover from #26, which only covered Boston; #27
    /// established that real 1830 prints the "B" label on TWO hexes --
    /// Boston AND Baltimore, both governed by this same terrain and this
    /// same reservation rule, sharing the identical designated tile artwork
    /// (this is standard, widely-documented 1830 tile-label convention: "B"
    /// names a *label*, not a single hex) -- renaming the identifier itself
    /// was judged not worth the diff churn, so `BostonHub` now reads as "the
    /// B-label hub terrain," Boston-named only for history. Only ever legal
    /// at `hexmap::LANDMARK_HEXES`' Boston OR Baltimore entry. As of #26,
    /// covered only the Green tier; #27 added a Brown-tier catalog entry
    /// too (real 1830 also restricts the Brown upgrade of "B" hexes to its
    /// own dedicated tile, distinct from the Green one) -- Yellow start
    /// remains the ordinary, shared `MajorCityHub` artwork for both hexes.
    BostonHub,
    /// New York's own "NY"-labelled artwork -- a real two-station double city, the
    /// same shape as `DoubleCityHub` but a DISTINCT terrain from it.
    ///
    /// The underlying restriction ("this exact tile, not a same-shaped substitute,
    /// and only at this hex") is functionally identical to OO's but a legally
    /// SEPARATE reservation: New York's tile is not a legal substitute for the OO
    /// tile or the "B" tile, or vice versa, even where more than one happens to be
    /// double-city artwork. Green and Brown tiers; the Yellow start remains the
    /// ordinary shared `MajorCityHub`.
    NewYorkHub,
}

/// A single hex tile laid onto the shared map. `q`/`r` are axial; `connections`
/// is the BASE (pre-rotation) edge bitmask and `orientation` the 60-degree steps
/// applied at read time.
///
/// Audit G-9: `connections` alone records only WHICH edges carry track, never HOW
/// they pair up, which let the old bitmask walk route-jump -- on real tile #1 a
/// train could enter on edge 0 and leave on edge 3, across track that physically
/// does not exist. `paths` is the tile's base edge-to-edge segments, sourced
/// per-tile from the real 1830 manifest; `(a, b)` is a through segment and
/// `(a, a)` a terminal spur into a revenue centre with no second exit.
///
/// Retained ALONGSIDE `connections` rather than replacing it: the flat mask is
/// what placement matches edges with, what `impassable_edge_mask` is ANDed
/// against, and what the frontend reads back to draw track. `#[serde(default)]`,
/// so a pre-G-9 tile deserializes as "no edge-pair data" and
/// `hexmap::effective_tile_paths` backfills it from the catalog by `tile_id`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Tile {
    pub q: i32,
    pub r: i32,
    pub tile_id: u32,
    pub orientation: u8, // 0-5: number of 60-degree rotation steps applied
    pub connections: u8, // base (pre-rotation) track-connection bitmask, bits 0-5
    /// Base (pre-rotation) edge-to-edge track segments -- see this struct's
    /// own doc comment for the `(a, a)` terminal-spur encoding. Audit G-9.
    #[serde(default)]
    pub paths: Vec<(u8, u8)>,
}

/// (game_id, tile_id) -> how many copies of that artwork are still in this
/// room's tray, unlaid (Audit G-5, the Tile Inventory Supply Engine).
///
/// Seeded per room from each catalog entry's printed quantity. `execute_lay_tile`
/// decrements the laid tile and -- on an upgrade -- RETURNS the replaced tile to
/// the tray, because real 1830 recycles the tile you lift off the board.
/// `legal_tile_placements` skips a depleted tile so it never appears as an option.
///
/// `hexmap::UNLIMITED_TILE_SUPPLY` marks an entry exempt from depletion.
/// HISTORICAL: it was carried by the five invented non-1830 tiles, all of which
/// Audit G-5/G-10 deleted -- nothing carries it today.
///
/// Reset and replayed by `reapply_game_log`, so `UndoLastAction` restores the
/// tray as well as the board.
pub const REMAINING_TILES: Map<(u64, u32), u32> = Map::new("remaining_tiles");

/// (game_id, q, r) -> Tile. One shared map per game session -- tiles aren't
/// owned per-protocol, matching the physical 18xx board where the track
/// network itself is shared infrastructure any protocol may eventually run
/// through. See `PROTOCOL_NETWORK_HEXES` for which hexes currently count as
/// a given protocol's own connected network. Populated by
/// `hexmap::execute_lay_tile`.
pub const MAP_GRID: Map<(u64, i32, i32), Tile> = Map::new("map_grid");

/// (game_id, protocol_id) -> the list of `(q, r)` hexes currently part of
/// that protocol's connected track network (used to check that a newly
/// laid tile legally connects to it -- see `hexmap::execute_lay_tile`). A
/// `Vec` rather than a per-hex membership map: simpler to keep within the
/// same composite-key shapes already used elsewhere in this contract, and
/// fine for the tile counts a single game session will ever reach.
pub const PROTOCOL_NETWORK_HEXES: Map<(u64, u32), Vec<(i32, i32)>> =
    Map::new("protocol_network_hexes");

/// (game_id, protocol_id) -> the ordered `(q, r)` hexes holding that protocol's
/// Station Tokens, home token first. Deliberately SEPARATE from
/// `PROTOCOL_NETWORK_HEXES`: that tracks LAID TILES for track-connectivity
/// legality, this tracks TOKEN PLACEMENTS for limit/cost bookkeeping. `.len()` is
/// the token count so far; a hex can never appear twice for one protocol.
pub const PROTOCOL_STATION_HEXES: Map<(u64, u32), Vec<(i32, i32)>> =
    Map::new("protocol_station_hexes");

/// (game_id, protocol_id) -> the `(macro_round_number, sub_round_index)`
/// pair (see `GameSession`'s own doc comments on those two fields) at which
/// this protocol last successfully called `PlaceStationToken` -- enforces
/// "only one additional station token placement per Operating Round
/// sub-round" (`StationTokenAlreadyPlacedThisSubRound`). Not touched by the
/// free home-token grant at float, which isn't a player action taken during
/// an OR sub-round turn.
pub const PROTOCOL_LAST_TOKEN_SUBROUND: Map<(u64, u32), (u32, u32)> =
    Map::new("protocol_last_token_subround");

/// (game_id, q, r) -> every Station Token on that hex, as
/// `(protocol_id, city_index)` -- Audit G-12, per-CITY token accounting.
///
/// `PROTOCOL_STATION_HEXES` records which HEXES a company has tokened, which is
/// all the limit and duplicate checks ever needed. It cannot answer what the
/// blockade rule asks, though: A HEX IS NOT A CITY. #62 is one hex carrying TWO
/// separate 2-slot cities, and #54/#59/#64-#68 each carry two 1-slot cities.
/// Pooling their slots reports an OPEN slot on a hex whose relevant city is
/// genuinely full, and the distinction cannot be recovered afterwards from a
/// `Vec<(i32, i32)>`.
///
/// A SEPARATE map rather than a widened element type, deliberately: that map's
/// entries are stored as JSON `[q, r]` pairs, and any struct or 3-tuple
/// replacement fails to deserialize them, bricking every game in flight. A new
/// map starts empty, so a pre-G-12 game reads "no per-city detail recorded" and
/// `hex_token_occupants` reconstructs those tokens against city 0.
///
/// INVARIANT, enforced by the only two writers: for any hex, the entries naming a
/// given `city_index` never exceed that city's slot count.
pub const HEX_STATION_TOKENS: Map<(u64, i32, i32), Vec<(u32, u8)>> =
    Map::new("hex_station_tokens");

/// One step of a corporation's Operating Round turn (Audit G-14).
///
/// The ORDER is the rule, and it is defined once, in `or_phase::OR_PHASE_ORDER`.
/// This enum deliberately carries no ordering of its own -- no `PartialOrd`, no
/// discriminant arithmetic -- so there is exactly one place a phase sequence can
/// be read from and no second, drifting copy.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
pub enum OperatingSubPhase {
    /// Buy a private company from a player. Phase 3+ only, and FIRST in the
    /// turn -- before track.
    BuyPrivate,
    /// Lay or upgrade exactly one tile.
    Track,
    /// Place one Station token.
    Tokens,
    /// Run trains. Not skippable by a corporation that owns one.
    Routes,
    /// Pay out or withhold. Never skippable.
    Dividends,
    /// Buy trains -- as many as affordable up to the phase train limit, so
    /// this phase does NOT auto-advance.
    Hardware,
}

/// (game_id, protocol_id) -> which Operating Round phase that corporation is in.
///
/// ABSENT means "at the start of its turn", resolved through
/// `or_phase::initial_sub_phase`, which is era dependent. That is why
/// `reset_for_turn` REMOVES the entry rather than writing one: writing a concrete
/// phase would silently skip `BuyPrivate` in a later era. No migration needed --
/// a game in flight simply starts its next turn at the top of the sequence.
pub const PROTOCOL_OR_SUB_PHASE: Map<(u64, u32), OperatingSubPhase> =
    Map::new("protocol_or_sub_phase");

/// A standing offer from one corporation to buy a train from another (G-15).
///
/// Only ever exists for a CROSS-PLAYER sale; a single president controlling both
/// corporations settles immediately with no offer written.
///
/// Records the MODEL, not a specific unit: trains of a model are interchangeable
/// -- same cost, range and rust fate -- so pinning an index would only create a
/// way for the offer to go stale when an unrelated train left the roster.
/// Nothing is escrowed; the price is re-checked at acceptance.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct TrainOffer {
    pub offer_id: u64,
    pub buyer_protocol_id: u32,
    pub seller_protocol_id: u32,
    pub model_type: String,
    pub price: Uint128,
}

/// (game_id, offer_id) -> a pending cross-player train offer.
pub const TRAIN_OFFERS: Map<(u64, u64), TrainOffer> = Map::new("train_offers");

/// game_id -> the next offer id to hand out. Starts at 1, so `0` is never a
/// valid offer id and a defaulted field cannot accidentally name a real one.
pub const NEXT_TRAIN_OFFER_ID: Map<u64, u64> = Map::new("next_train_offer_id");

/// A single piece of Hardware (train) inventory -- either still sitting in
/// the global `HARDWARE_POOL` supply queue or already owned by a company
/// via `COMPANY_HARDWARE`. `model_type` is the train's tier ("2", "3",
/// "4", "5", "6", "D", per `hardware::TRAIN_CATALOG`); `cost` is what it
/// was purchased for (its baseline market cost); `max_route_distance` is
/// how many cities/stops its route can span. Fields are duplicated onto
/// every unit (rather than looked up from a shared catalog reference at
/// read time) so a company's or the pool's inventory is fully
/// self-describing in state.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct HardwareAsset {
    pub model_type: String,
    pub cost: Uint128,
    pub max_route_distance: u32,
}

/// game_id -> the remaining, not-yet-purchased Hardware supply, in strict
/// purchase order (index 0 is next to be bought). Seeded once, in full, by
/// `hardware::spawn_hardware_pool` when a game room is created; every
/// `BuyHardwareFromPool` call removes exactly the front element -- see
/// `hardware.rs` for why this is one shared, sequential (per-session) FIFO
/// queue rather than letting a buyer pick a model directly.
pub const HARDWARE_POOL: Map<u64, Vec<HardwareAsset>> = Map::new("hardware_pool");

/// (game_id, company_id) -> the list of Hardware units that company
/// currently owns. Entries are removed wholesale by the "Rusting"
/// obsolescence sweep in `hardware::execute_buy_hardware_from_pool` the
/// instant a newer tier's first unit is purchased and renders an older
/// tier obsolete.
pub const COMPANY_HARDWARE: Map<(u64, u32), Vec<HardwareAsset>> = Map::new("company_hardware");

/// (game_id, model_type) -> how many units of that model have ever been
/// purchased from `HARDWARE_POOL` in this game session. Used purely to
/// detect the exact moment a tier's *first* unit is bought -- the instant
/// rules.md's Rusting trigger fires -- so re-buying an already-released
/// tier never repeats the obsolescence sweep.
pub const TRAINS_PURCHASED_COUNT: Map<(u64, String), u32> = Map::new("trains_purchased_count");

/// One completed, replayable game transaction, appended to `GAME_LOG` the instant
/// its handler succeeds. Every variant carries the acting `player`; `game_id` is
/// the map key and is not repeated inside the value.
///
/// A deliberately scoped SUBSET of `ExecuteMsg`, not a 1:1 mirror -- real-JUNO
/// messages and the batch/bankruptcy paths are excluded. See `gamelog.rs`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub enum ActionRecord {
    BidOnPrivate {
        player: Addr,
        private_id: u32,
        bid_amount: Uint128,
    },
    BuyStock {
        player: Addr,
        protocol_id: u32,
        source: SharePurchaseSource,
        par_value: Option<Uint128>,
        /// How many certificates the original call bought in one atomic action --
        /// `None`/`Some(1)` for an ordinary purchase, `Some(n > 1)` only for a Brown-Zone
        /// Bank multi-buy. `#[serde(default)]` so a pre-Batch-1 record still
        /// deserializes: it reads `None`, which resolves to exactly the single
        /// certificate that log entry originally bought, so historical logs replay to the
        /// identical state they always did.
        #[serde(default)]
        quantity: Option<u32>,
    },
    SellStock {
        player: Addr,
        protocol_id: u32,
        percentage: u8,
    },
    DeclareDividends {
        player: Addr,
        protocol_id: u32,
        revenue_amount: Uint128,
        distribute: bool,
    },
    LayTile {
        player: Addr,
        protocol_id: u32,
        q: i32,
        r: i32,
        tile_id: u32,
        /// The player-chosen rotation actually submitted (see `msg.rs`'s
        /// `ExecuteMsg::LayTile` doc comment) -- recorded so
        /// `gamelog::reapply_game_log`'s replay-based Undo re-lays the
        /// exact same rotation the player originally chose, rather than
        /// re-deriving some (possibly different, now that orientation
        /// isn't auto-picked) rotation on replay.
        orientation: u32,
    },
    /// Records a successful `PlaceStationToken`. Does NOT record the free home token
    /// granted at float -- that is re-derived on replay by re-running whichever
    /// action originally floated the company, like every other float-time side effect.
    /// Audit G-14: a recorded sub-phase skip, so `reapply_game_log` rebuilds the same
    /// phase cursor the live game had. Without it a replayed board would stall the
    /// first time a corporation skipped a phase.
    AdvanceOperatingSubPhase {
        player: Addr,
        protocol_id: u32,
    },
    /// Audit G-15. Replays deterministically: the same-president/offer branch
    /// is decided from `PROTOCOL_PRESIDENT` at replay time, exactly as it was
    /// live, so no branch flag needs recording.
    BuyTrainFromCorporation {
        player: Addr,
        buyer_protocol_id: u32,
        seller_protocol_id: u32,
        model_type: String,
        price: Uint128,
    },
    AcceptTrainOffer {
        player: Addr,
        offer_id: u64,
    },
    RejectTrainOffer {
        player: Addr,
        offer_id: u64,
    },
    RescindTrainOffer {
        player: Addr,
        offer_id: u64,
    },
    PlaceStationToken {
        player: Addr,
        protocol_id: u32,
        q: i32,
        r: i32,
        /// Audit G-12. `#[serde(default)]` so an ActionRecord written before
        /// G-12 still deserializes -- and replays to the same board it
        /// originally produced, since `None` resolves to the first open
        /// city, which is what the pre-G-12 code effectively always chose.
        #[serde(default)]
        city_index: Option<u8>,
    },
    BuyHardwareFromPool {
        player: Addr,
        protocol_id: u32,
    },
    /// Records a successful `trading::execute_buy_private_company` call --
    /// the Phase-Gated Corporate Purchase Protocol (`trading.rs` module doc
    /// comment #17). `player` is the acting President whose `info.sender`
    /// authorized the purchase on `protocol_id`'s behalf (mirrors every
    /// other President-authorized `ActionRecord` variant here, e.g.
    /// `DeclareDividends`) -- `synthetic_info(player)` replays it the same
    /// way on Undo/redo.
    BuyPrivateCompany {
        player: Addr,
        protocol_id: u32,
        private_id: u32,
        price: Uint128,
    },
    PassTurn {
        player: Addr,
    },
}

/// game_id -> the sequential, append-only history of every `ActionRecord`
/// taken in that game room, oldest first. This is the Event-Sourced Ledger:
/// `ExecuteMsg::UndoLastAction` pops the newest entry and calls
/// `gamelog::reapply_game_log` to recompute the room's entire replayable
/// state from the remainder, rather than trying to write a bespoke
/// "inverse" for each action type -- the same technique 18xx.games itself
/// uses for Undo. See `gamelog.rs` for the full design and its current
/// scope.
pub const GAME_LOG: Map<u64, Vec<ActionRecord>> = Map::new("game_log");

/// Counts every certificate `player` holds: one per private company owned, plus
/// one per physical stock card across the public companies. Shared by
/// `execute_buy_stock` and `execute_bid_on_private`, which need the same count.
///
/// Takes the id catalogs as PARAMETERS rather than importing them, so this
/// data-layer module stays a leaf with no dependency on either business-logic
/// module; callers already have both in scope.
///
/// THE PRESIDENT'S CERTIFICATE COUNTS AS EXACTLY ONE PHYSICAL CARD, NOT TWO. A
/// naive `held_pct / percent_per_share` (20 / 10 = 2) double-counts it as two
/// ordinary certificates. Re-verified against the official rulebook, 18xx.net and
/// `tobymao/18xx`'s own `num_certs`/`cert_size`, where a president's `Share` never
/// gets `cert_size: 2`. So the first `president_share_percentage` of a president's
/// holding is one card, and only the remainder counts in ordinary blocks.
pub fn count_player_certificates(
    storage: &dyn Storage,
    game_id: u64,
    player: &Addr,
    private_ids: &[u32],
    public_company_ids: &[u32],
    percent_per_share: u8,
    president_share_percentage: u8,
) -> StdResult<u32> {
    count_player_certificates_with_exemptions(
        storage,
        game_id,
        player,
        private_ids,
        public_company_ids,
        percent_per_share,
        president_share_percentage,
        &[],
    )
}

/// `count_player_certificates` with the zone exemption applied to the RUNNING
/// TOTAL, not merely to the certificate being bought.
///
/// A LIVE, POSITION-DERIVED exemption rather than a sticky flag stamped at
/// purchase time: a company whose price later climbs out of the Yellow band has
/// its certificates start counting again, which is how the physical board behaves
/// -- the colour band is printed on the CHART, not on the certificate.
///
/// A consequence worth stating plainly: a player can be legally over the hand
/// limit without having done anything wrong, simply because a company they hold
/// moved up out of an exempt band. `check_cert_limit` only ever blocks NEW
/// purchases; it never retroactively invalidates a holding, and there is no
/// forced-sale path in this contract.
///
/// Private companies are never zone-exempt -- a private has no market position at
/// all -- so they are always counted in full.
#[allow(clippy::too_many_arguments)]
pub fn count_player_certificates_with_exemptions(
    storage: &dyn Storage,
    game_id: u64,
    player: &Addr,
    private_ids: &[u32],
    public_company_ids: &[u32],
    percent_per_share: u8,
    president_share_percentage: u8,
    exempt_company_ids: &[u32],
) -> StdResult<u32> {
    let mut count: u32 = 0;

    for &private_id in private_ids {
        if let Some(company) = PRIVATE_COMPANIES.may_load(storage, (game_id, private_id))? {
            if company.owner.as_ref() == Some(player) {
                count += 1;
            }
        }
    }

    if percent_per_share > 0 {
        for &company_id in public_company_ids {
            // Zone exemption (item 2): this company's certificates don't
            // count toward the hand limit at all right now.
            if exempt_company_ids.contains(&company_id) {
                continue;
            }

            let held_pct = PLAYER_SHARES
                .may_load(storage, (game_id, company_id, player.clone()))?
                .unwrap_or(0);
            if held_pct == 0 {
                continue;
            }

            let is_president =
                PROTOCOL_PRESIDENT.may_load(storage, (game_id, company_id))?.as_ref() == Some(player);
            count += if is_president && held_pct >= president_share_percentage {
                // The President's own card (1) plus ordinary
                // percent_per_share blocks for anything held beyond it.
                1 + u32::from((held_pct - president_share_percentage) / percent_per_share)
            } else {
                u32::from(held_pct / percent_per_share)
            };
        }
    }

    Ok(count)
}
