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

/// A tile's classic 1830 color tier -- Yellow, Green, or Brown, in that
/// fixed progression. Declared in that exact order (Yellow first) so the
/// derived `Ord`/`PartialOrd` impls compare eras the same way real 1830's
/// tile-color progression does: `TileColor::Green > TileColor::Yellow`,
/// `TileColor::Brown > TileColor::Green`. `GameSession::current_global_era`
/// tracks which tiers are currently legal to lay or upgrade into; see
/// `hexmap.rs`'s module doc comment on Tech Era Color-Locking for the exact
/// unlock triggers (the first 3-train and first 5-train purchased from the
/// Hardware pool).
#[derive(
    Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, JsonSchema,
)]
pub enum TileColor {
    Yellow,
    Green,
    Brown,
}

/// The Macro Round Tracker's coarse round type -- which broad phase
/// `game_id` is currently in.
///
/// `WaterfallAuction` is the room's true genesis phase (`contract::
/// execute_create_game_room`, changed from this contract's earlier
/// "genesis starts in StockRound" behavior): the canonical 1830 pre-game
/// private-company auction, allocating all six `CORE_PRIVATE_COMPANIES`
/// before any stock is ever bought -- see `waterfall.rs`'s module doc
/// comment for the full engine. `waterfall::conclude_waterfall` (called
/// either once every private is owned, or once a full round of passes ends
/// the auction early -- see that module) is this contract's one and only
/// `WaterfallAuction -> StockRound` transition; nothing else ever sets
/// `current_round_type` back to `WaterfallAuction` after that (this is a
/// strictly one-time, one-directional phase, unlike the ordinary
/// `StockRound`/`OperatingRound` cycle below).
///
/// `StockRound` (players buy/sell/pass on share ownership) and
/// `OperatingRound` (floated corporations lay track, buy Hardware, and
/// declare dividends in turn order via `GameSession::active_operating_order`
/// -- see `operations.rs`) are this contract's original two-phase repeating
/// cycle, unchanged: `operations::execute_begin_operating_round` flips
/// `StockRound -> OperatingRound` (the codebase's one existing, explicit
/// "stock round concludes, an operating round begins" transition point --
/// see that function's doc comment, and its own module doc comment #10, for
/// why nothing yet automatically detects a Stock Round's *natural* end via
/// `consecutive_passes`). Macro Round Loop Advancement (`operations.rs`
/// module doc comment #12) transitions it back to `StockRound`:
/// `operations::execute_end_operating_round_turn` flips it the moment the
/// paced Operating Round phase's very last sub-round's very last
/// corporation ends its turn, bumping `macro_round_number` and resetting
/// `sub_round_index` to `0` in the same step.
///
/// Declared in this exact order (`WaterfallAuction` first) purely for
/// readability as the room's real chronological sequence -- nothing in this
/// contract derives `Ord`/`PartialOrd` for this enum or compares variants
/// by declaration position (contrast `TileColor`, just above, which
/// deliberately does).
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
    /// Index into `player_addresses` of whose turn it currently is. The
    /// base Turn Priority Queue primitive: only this player may call
    /// `ExecuteMsg::PassTurn` (which advances this index, wrapping), and
    /// `gamelog::reapply_game_log` recomputes it by replaying every
    /// `ActionRecord::PassTurn` in the event log from `0`. See
    /// `gamelog.rs`'s module doc comment for how far turn-order
    /// *enforcement* currently reaches beyond `PassTurn` itself.
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
    /// The highest `TileColor` tier currently unlocked for laying or
    /// upgrading tiles into, room-wide (classic 1830's "Tech Era" /
    /// train-phase color-lock -- see `hexmap.rs`'s module doc comment).
    /// Starts at `TileColor::Yellow` (every room genesis) and only ever
    /// advances -- to `Green` the moment the first 3-train is bought from
    /// the Hardware pool, then to `Brown` the moment the first 5-train is
    /// bought (`hardware::record_purchase_and_apply_rusting`). Never
    /// regresses. `gamelog::reapply_game_log` resets this to `Yellow` at
    /// genesis and recomputes it identically to live play by replaying
    /// every `BuyHardwareFromPool` in the event log in order.
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
    /// Index into `active_operating_order` of whichever corporation
    /// currently holds the Operating Round turn. `hexmap::execute_lay_tile`,
    /// `hardware::execute_buy_hardware_from_pool`, and
    /// `trading::execute_declare_dividends` each check this *in addition to*
    /// their existing President-only authorization: whenever
    /// `active_operating_order` is non-empty, the calling message's
    /// `protocol_id` must equal `active_operating_order[active_corporation_index]`,
    /// or the call is rejected with that module's own `NotYourOperatingTurn`
    /// error, before any state is touched. When `active_operating_order` is
    /// empty (no Operating Round turn queue has been established for this
    /// game yet -- e.g. every room before its first `BeginOperatingRound`
    /// call, and every pre-existing test in this codebase), this check is
    /// skipped entirely and those three messages remain gated only by
    /// President authorization, exactly as before this feature existed --
    /// this opt-in behavior is what keeps this a purely additive change.
    /// `operations::execute_end_operating_round_turn` (`operations.rs`
    /// module doc comment #10) advances this index from one corporation to
    /// the next -- wrapping back to `0` (with a freshly recomputed order)
    /// when Pacing Automation schedules another sub-round, or clearing the
    /// whole queue back to empty when Macro Round Loop Advancement (module
    /// doc comment #12) closes out the macro round entirely.
    pub active_corporation_index: u32,
    /// Unix seconds (`env.block.time.seconds()`) of the most recent
    /// state-advancing action taken in this room -- set at room creation
    /// (`contract::execute_create_game_room`) and refreshed by every
    /// handler that moves the game forward: `trading::execute_buy_stock`,
    /// `trading::execute_sell_stock`, `trading::execute_declare_dividends`,
    /// `gamelog::execute_pass_turn`, `hexmap::execute_lay_tile`, and
    /// `hardware::execute_buy_hardware_from_pool`. This is the Inactivity
    /// Timeout Safety Valve's clock: once
    /// `env.block.time.seconds() > last_action_timestamp + 172800` (48
    /// hours with no qualifying action), any player may call
    /// `ExecuteMsg::ClaimTimeoutRefund` to close the room and refund every
    /// player's original real-JUNO ante from `PLAYER_JUNO_ANTE` -- see
    /// `contract::execute_claim_timeout_refund`. Deliberately NOT refreshed
    /// by every mutating message (e.g. `BidOnPrivate`,
    /// `ExecuteOperatingRound`, `BeginOperatingRound`,
    /// `EmergencyBuyHardware`, `UndoLastAction`) -- only the six handlers
    /// explicitly listed above, matching this feature's requested scope.
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
    /// The Macro Round Tracker's overall round counter -- the classic 18xx
    /// "SR1", "SR2", "OR3" style numbering's leading digit. Starts at `1` at
    /// genesis. Macro Round Loop Advancement
    /// (`operations::execute_end_operating_round_turn`, `operations.rs`
    /// module doc comment #12) increments this by exactly `1` the moment a
    /// full Stock-Round-then-every-paced-Operating-Round cycle completes --
    /// i.e. the paced Operating Round phase's very last sub-round's very
    /// last corporation ends its turn. `gamelog::reapply_game_log` does
    /// *not* reset this field back to `1` on Undo (unlike
    /// `active_operating_order`/`active_corporation_index`/
    /// `current_round_type`/`sub_round_index`) -- see that function's own
    /// doc comment for why a macro-round boundary isn't treated as
    /// "replayable" state the same way an in-progress OR turn queue is.
    pub macro_round_number: u32,
    /// Within the current `current_round_type` phase, which sub-round is
    /// active -- e.g. the `1` in "OR2.1". Set to `1` by
    /// `operations::execute_begin_operating_round` the moment an Operating
    /// Round begins; `0` at genesis (no round has begun operating yet) and
    /// after `gamelog::reapply_game_log` resets it, matching
    /// `active_operating_order`'s own empty-until-first-`BeginOperatingRound`
    /// convention. `operations::execute_end_operating_round_turn` advances
    /// this from one Operating Round sub-round to the next within a single
    /// macro round, once every corporation in `active_operating_order` has
    /// acted and Pacing Automation (see `operating_round_sequence_length`'s
    /// doc comment) says more sub-rounds are still due; once it reaches
    /// `operating_round_sequence_length`, the *next* all-corporations-acted
    /// moment resets this back to `0` instead (Macro Round Loop
    /// Advancement, `operations.rs` module doc comment #12) rather than
    /// incrementing past it.
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
    /// The Deferred Bank-Break Halt flag -- the classic 1830 "Bank Break"
    /// rule: once the shared bank treasury (`virtual_bank_vgp`) is
    /// completely exhausted, the game does NOT hard-stop immediately mid-OR
    /// -- every corporation still gets to finish out the CURRENT scheduled
    /// block of Operating Rounds (Pacing Automation's own
    /// `operating_round_sequence_length` schedule, unchanged), and only once
    /// that whole paced block concludes does the game actually end. Set to
    /// `true` the moment `virtual_bank_vgp` is driven to exactly zero by a
    /// debit (currently only `trading::execute_sell_stock`'s per-certificate
    /// Bank-pool payout -- see that function's own comment). Consulted by
    /// `operations::execute_end_operating_round_turn`'s Macro Round Loop
    /// Advancement branch (`operations.rs` module doc comment #12): if this
    /// is `true` at the exact moment that branch would otherwise flip
    /// `current_round_type` back to `RoundType::StockRound`, it instead
    /// calls `contract::finalize_and_distribute_payouts` there and then --
    /// the same final asset-liquidation routine every other game-end trigger
    /// in this contract already uses (`market::price_triggers_game_end`).
    /// Starts `false` at genesis (`contract::execute_create_game_room`); NOT
    /// reset by `gamelog::reapply_game_log` alongside `sub_round_index`/etc.
    /// -- once the bank has genuinely run dry earlier in the event log,
    /// replaying that same log should reach the same broken-bank state
    /// again, not silently forget it (the same "not every field is
    /// replayable/resettable" reasoning `macro_round_number`'s own doc
    /// comment already documents).
    pub bank_is_broken: bool,
    /// Waterfall Auction (see `waterfall.rs`'s module doc comment): `true`
    /// from room genesis (`contract::execute_create_game_room`) until the
    /// canonical 1830 pre-game private-company auction concludes -- either
    /// every one of the six `CORE_PRIVATE_COMPANIES` is owned, or a full
    /// round of passes ends it early (`waterfall::conclude_waterfall`),
    /// whichever comes first. While `true`, ordinary Stock Round trading
    /// (`trading::execute_buy_stock`/`execute_sell_stock`) and the legacy
    /// continuous-bid `auction::execute_bid_on_private` are all rejected
    /// (`WaterfallAuctionInProgress` in each module's own error enum) --
    /// every private-company turn action must go through one of
    /// `waterfall.rs`'s five dedicated `ExecuteMsg` variants instead. Flips
    /// to `false` exactly once, permanently, the moment the waterfall
    /// concludes; `current_round_type` moves from `RoundType::
    /// WaterfallAuction` to `RoundType::StockRound` in that same step.
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

/// Waterfall Auction (see `waterfall.rs`'s module doc comment): persisted
/// exactly while a tie-breaking mini-auction is resolving 2+ simultaneous
/// bids on the same private company, uncovered by the Waterfall Cascade.
/// Only one can ever be in progress per `game_id` at a time (the cascade
/// only ever pauses at a single tie point), hence the plain `u64` key.
/// Absence (`WATERFALL_MINI_AUCTION.may_load` returning `None`) means no
/// mini-auction is currently active for this room -- the normal outer-loop
/// `WaterfallBuyLowest`/`WaterfallBidHigher`/`WaterfallPass` actions are
/// gated on this absence, and `WaterfallMiniAuctionRaise`/
/// `WaterfallMiniAuctionPass` are gated on its presence.
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

/// The real 1830 stock-market board's three tactical rule-boundary zones,
/// per `MARKET_GRID`'s cell (see `market.rs`'s authentic price data,
/// sourced from `SharePrice::TYPE_MAP` and `MARKET` in the open-source
/// `tobymao/18xx` engine -- `lib/engine/share_price.rb` /
/// `lib/engine/game/g_1830/game.rb`). Every variant below is strictly more
/// permissive than the last, matching the real physical board's nested
/// color bands (a Brown-zone cell is also past the Yellow/Orange lines):
///
/// - `YellowZone` (source letter `y`, engine type `:no_cert_limit`): shares
///   held here don't count toward a player's certificate/hand limit.
/// - `OrangeZone` (source letter `o`, engine type `:unlimited`): also, a
///   single player may hold more than the standard 60% ownership cap in
///   this corporation.
/// - `BrownZone` (source letter `b`, engine type `:multiple_buy`): also, a
///   player may buy more than one certificate of this corporation from the
///   Bank pool in a single turn (see `trading::execute_buy_stock`'s
///   Brown-Zone Multiple-Buy handling).
///
/// Cumulative/nested semantics (Orange implies Yellow's exemption, Brown
/// implies both) are this implementation's explicit choice, matching the
/// standard 1830 rulebook's understanding of the three color bands --
/// note this is NOT a literal transcription of the engine's own per-cell
/// letter, since the verbatim `MARKET` array tags each cell with only a
/// single letter (a `b` cell is never *also* tagged `o`); see
/// `market.rs`'s module doc comment for the full sourcing note.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
pub enum ZoneType {
    /// No special exemptions -- the standard 60%-cap, one-purchase-per-turn
    /// rules apply in full.
    Normal,
    YellowZone,
    OrangeZone,
    BrownZone,
}

/// Tracks where a single game's single protocol's price marker currently
/// sits on the shared `MARKET_GRID` board template. Deliberately does not
/// duplicate `game_id` as a field (matching this project's convention for
/// every other composite-keyed state struct -- `Tile`, `PrivateCompany`,
/// `PublicCompany`, etc. -- none of which repeat their own map key inside
/// themselves): the owning `(game_id, protocol_id)` lives entirely in
/// `PROTOCOL_MARKET`'s key.
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

/// (game_id, protocol_id) -> percentage of that protocol's shares (0-100)
/// sitting in the Open Market/Bank pool -- shares a player previously
/// bought and later sold back onto the market (`trading::execute_sell_stock`).
/// Unlike `IPO_POOL_SHARES`, an unseeded entry here defaults to *empty*
/// (0): nothing has ever been dumped back until a sale actually happens.
/// Bought at the protocol's current floating `MARKET_GRID` price, not its
/// fixed `PROTOCOL_PAR_VALUE` -- see `trading::execute_buy_stock`.
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

// REMOVED (Audit G-2, Split Treasury Divergence): `PROTOCOL_TREASURY_VGP`,
// formerly `(game_id, protocol_id) -> Uint128`, map key
// `"protocol_treasury_vgp"`.
//
// A corporation's treasury used to be written to TWO independent places
// that no code ever reconciled: `trading::execute_declare_dividends`
// credited withheld ("Slash/Retain Yield") revenue -- and the IPO pool's
// dividend share -- into this map, while EVERY debit site
// (`hardware::execute_buy_hardware_from_pool`'s train purchases,
// `hexmap::execute_lay_tile`'s terrain fees,
// `hexmap::execute_place_station_token`'s token fees) and every OTHER
// credit site (`trading::execute_buy_stock`'s 10x-par flotation
// capitalization, `operations::execute_operating_round`'s and
// `operations::execute_run_manual_route`'s own withhold branches) read and
// wrote `PublicCompany::treasury` inside `PUBLIC_COMPANIES` instead.
//
// Nothing anywhere ever DEBITED this map, so every VGP a corporation
// retained through `DeclareDividends` was permanently unspendable: a
// company could withhold for five Operating Rounds to save for a 5-train
// and, on-chain, have saved nothing it could actually spend. That broke
// the game's entire capital-accumulation loop.
//
// `PublicCompany::treasury` is now the single source of truth for
// corporate VGP. See `trading::execute_declare_dividends` for the migrated
// credit paths and `operations.rs`'s module doc comment #4, which flagged
// this divergence before it was fixed.

/// (game_id, protocol_id) -> the player address currently serving as that
/// protocol's President/Validator (the highest shareholder, at or above
/// `trading::PRESIDENT_MIN_PERCENTAGE`). Absent if no one currently
/// qualifies (e.g. the protocol hasn't floated yet).
pub const PROTOCOL_PRESIDENT: Map<(u64, u32), Addr> = Map::new("protocol_president");

/// A private company available from the start of a game, during the
/// Private Auctions phase that opens the session (see `auction.rs`).
/// `owner` always reflects whoever currently holds the top bid recorded in
/// `PRIVATE_BIDS`: ownership transfers automatically and immediately to
/// each new qualifying bidder, so there's no separate "close the auction"
/// step. `revenue_per_or` is paid automatically at the start of every
/// Operating Round -- see `operations.rs`'s Automatic Pre-OR Revenue
/// Payout (module doc comment #14) and `execute_operating_round`'s own
/// Phase 1, the two places that actually credit it.
///
/// `owner` and `owner_protocol_id` are mutually exclusive: at most one is
/// ever `Some` at a time. A private starts with both `None` (unowned, mid-
/// auction); a player's winning bid sets `owner`; a corporation buying it
/// out from that player (`trading::execute_buy_private_company`, the
/// Phase-Gated Corporate Purchase Protocol) clears `owner` back to `None`
/// and sets `owner_protocol_id` instead -- a private can never be owned by
/// both a player and a corporation, or by two corporations, at once.
///
/// `closed` starts `false` and is set permanently `true` either by the B&O
/// Special Closure (the instant the public B&O corporation buys its first
/// train -- `hardware.rs`'s module doc comment #11) or the Phase 5 Private
/// Closure (every still-open private closes the instant the room's first
/// 5-train is bought -- `hardware.rs`'s module doc comment #12). A closed
/// private pays no further Operating Round revenue, can never be bought or
/// sold again (`auction::execute_bid_on_private` /
/// `trading::execute_buy_private_company` both reject it), and -- for
/// Delaware & Hudson/Mohawk & Hudson specifically -- releases whichever
/// board hex its ownership used to reserve (`hexmap.rs`'s module doc
/// comment #24).
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
}

/// (game_id, company_id) -> PublicCompany. Seeded unfloated by
/// `public_company::spawn_core_public_companies` when a game room is
/// created; floated for Baltimore & Ohio specifically by
/// `auction::award_bo_president_share` (see that function's doc comment).
pub const PUBLIC_COMPANIES: Map<(u64, u32), PublicCompany> = Map::new("public_companies");

/// A hex's terrain classification, loosely modeled on classic 1830 terrain
/// categories. Tagged onto each `hexmap::TILE_CATALOG` entry and used by
/// `hexmap::terrain_base_value` as the key into that static VGP-value
/// lookup (see that function for the exact figures) -- the Pathfinding
/// Revenue Engine (`pathfinding.rs`) reads a laid `Tile`'s value through
/// this classification rather than a raw per-tile number.
///
/// `DoubleTown` (added for the Rigid On-Chain Tile Matching pass, see
/// `hexmap.rs` module doc comment #16): a single hex printing TWO
/// independent town stops sharing one hex -- the real 1830 board's Akron &
/// Canton (G7), Reading & Allentown (G17), and New Haven & Hartford (F20)
/// hexes, each verbatim-sourced from `tobymao/18xx`'s `g_1830/map.rb` as a
/// `town=revenue:0;town=revenue:0` (two town slots, no printed track)
/// white-section entry -- distinct from `SmallTown`'s single stop.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
pub enum TerrainType {
    Plain,
    MountainRugged,
    SmallTown,
    DoubleTown,
    MajorCityHub,
    /// A preprinted OO double-city hex's upgrade artwork -- two distinct
    /// station circles sharing one hex, mirroring `DoubleTown`'s own
    /// "two stops, one hex" pattern but for cities instead of towns. Added
    /// by the Tile Selection Catalog verification pass (`hexmap.rs` module
    /// doc comment #18): previously every city-type hex, OO hexes included,
    /// required plain `MajorCityHub` artwork, which let a player illegally
    /// upgrade a real two-station hex (e.g. Detroit & Windsor) with an
    /// ordinary single-city tile. See `hexmap::OO_DESIGNATED_HEXES` for the
    /// four reserved hexes this terrain is exclusive to.
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
    /// New York's own real, "NY"-labeled upgrade artwork (`hexmap.rs`
    /// module doc comment #26, extended by #27) -- a real two-station
    /// double city (`tobymao/18xx`'s `g_1830/map.rb`: `city=revenue:40;
    /// city=revenue:40`), same "two stops, one hex" shape as `DoubleCityHub`
    /// but a DISTINCT terrain from it: `DoubleCityHub` is exclusive to the
    /// four `hexmap::OO_DESIGNATED_HEXES`, while `BostonHub`/`NewYorkHub`'s
    /// underlying real-life restriction ("this exact tile, not a
    /// same-shaped substitute, and only at this one hex/label") is
    /// functionally identical but a legally SEPARATE reservation -- New
    /// York's own tile isn't a legal substitute for the OO tile or the "B"
    /// tile or vice versa, even where more than one happens to be
    /// double-city artwork. Only ever legal at `hexmap::LANDMARK_HEXES`'
    /// New York entry. As of #26, Green-tier only; #27 added a Brown-tier
    /// catalog entry too, mirroring `BostonHub`'s own Brown extension --
    /// Yellow start remains the ordinary, shared `MajorCityHub` artwork.
    NewYorkHub,
}

/// A single hex tile physically laid onto the shared map network during an
/// Operating Round (`rules.md`, section 3, Step 1: "Network Infrastructure
/// & Tile Placement"). `q`/`r` are axial hex coordinates -- see
/// `hexmap::HEX_NEIGHBOR_OFFSETS` for the neighbor-direction table they're
/// used with. `connections` is the tile's *base* (pre-rotation)
/// track-connection bitmask over its six edges (bit `i` set means edge `i`
/// of the tile artwork carries a track stub), taken from `hexmap::TILE_CATALOG`
/// for `tile_id`; `orientation` (0-5) is the number of 60-degree rotation
/// steps applied on top of that base pattern to get the tile's actual
/// on-map edges -- see `hexmap::rotate_connections`. `tile_id`'s terrain
/// classification (and thus its revenue value) is looked up from
/// `hexmap::TILE_CATALOG` / `hexmap::terrain_base_value` rather than stored
/// redundantly here.
///
/// **Audit G-9 (Edge-to-Edge Routing).** `connections` alone records only
/// WHICH edges carry track, never HOW those edges pair up internally, which
/// let `pathfinding.rs`'s old bitmask walk "route-jump": on a real tile #1
/// (two independent towns, one joining edges 1 and 3, the other joining
/// edges 0 and 4) a train could enter on edge 0 and leave on edge 3, track
/// that physically does not exist. `paths` closes that: it is the tile's
/// *base* (pre-rotation) list of edge-to-edge track segments, sourced
/// per-tile from the real 1830 manifest (`tobymao/18xx`'s
/// `lib/engine/config/tile.rb`) and carried on every `TILE_CATALOG` entry --
/// see that constant for the full 46-tile table and for the invariant that
/// `connections` is exactly the union of `paths`' edges, which
/// `hexmap::tile_base_connections` re-derives and the test suite asserts.
///
/// Encoding, in `hexmap::TILE_CATALOG`'s own convention:
/// - `(a, b)` with `a != b` -- a THROUGH segment joining edges `a` and `b`.
///   Traversable in either direction; if the tile is a revenue centre, the
///   city/town sits on this segment and is stopped at in passing.
/// - `(a, a)` -- a TERMINAL SPUR running from edge `a` to an interior
///   revenue centre with no second exit (real 1830's yellow "OO" tile #59
///   and preprinted New York, whose two cities are each a dead-end stub).
///   A train may enter and END its route there; it may never pass through.
///
/// Retained ALONGSIDE `connections` rather than replacing it: the flat mask
/// is what `hexmap::execute_lay_tile`/`legal_tile_placements` match edges
/// with, what `impassable_edge_mask` is ANDed against, and what the frontend
/// (`HexGridRenderer.tsx`, out of scope for this batch) reads back off this
/// struct to draw track. `paths` is additive and `#[serde(default)]`, so a
/// `Tile` written to `MAP_GRID` before this field existed still deserializes
/// -- it simply reads as "no edge-pair data", which
/// `hexmap::effective_tile_paths` backfills from the catalog by `tile_id`.
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

/// (game_id, tile_id) -> how many physical copies of that tile artwork are
/// still sitting in this room's tile tray, unlaid (Audit G-5, the On-Chain
/// Tile Inventory Supply Engine).
///
/// Seeded once per room by `hexmap::seed_tile_inventory` at
/// `contract::execute_create_game_room`, from each `hexmap::TILE_CATALOG`
/// entry's own starting `quantity` field. `hexmap::execute_lay_tile`
/// decrements the laid tile's count and -- on a colour upgrade -- returns
/// the REPLACED tile to the tray (real 1830 recycles the tile you lift off
/// the board back into the supply, where anyone may lay it again);
/// `hexmap::legal_tile_placements` skips any tile whose count has reached
/// zero, so a depleted tile never appears as a legal option in the first
/// place.
///
/// A count of `hexmap::UNLIMITED_TILE_SUPPLY` (`u32::MAX`) means "exempt
/// from depletion entirely" -- it is never decremented and never
/// incremented. That sentinel is currently carried by this catalog's five
/// invented, non-1830 tile entries (see `hexmap::TILE_CATALOG`'s own
/// per-entry comments), which have no physical tray count to be faithful
/// to. Every entry that DOES correspond to a real 1830 tray tile carries
/// that tile's real printed quantity.
///
/// Reset to its genesis values and replayed by `gamelog::reapply_game_log`
/// alongside every other replayable registry, so `UndoLastAction` restores
/// the tray as well as the board.
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

/// (game_id, protocol_id) -> the ordered list of `(q, r)` hexes currently
/// holding one of that protocol's own Station Tokens, home token (if any)
/// first (design note #40 in `hexmap.rs`). Deliberately a SEPARATE registry
/// from `PROTOCOL_NETWORK_HEXES` -- that one tracks LAID TILES for track-
/// connectivity legality, this one tracks TOKEN PLACEMENTS for
/// `hexmap::station_token_limit`/`hexmap::station_token_cost` bookkeeping;
/// see `hexmap::execute_place_station_token`'s own module doc comment for
/// why the two aren't unified. `.len()` is this protocol's token count so
/// far (its free home token, once granted at float, is entry `0`); a hex
/// appearing in this list can never appear twice for the same protocol
/// (`StationTokenAlreadyOnHex`).
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

/// (game_id, q, r) -> every Station Token standing on that hex, as
/// `(protocol_id, city_index)`.
///
/// **Audit G-12: per-CITY token accounting.** `PROTOCOL_STATION_HEXES` above
/// records which HEXES a company has tokened, which is all the token-limit
/// and duplicate checks ever needed. It cannot answer the question the
/// blockade rule actually asks, though: a hex is not a city. #62 (brown New
/// York) is one hex carrying TWO separate 2-slot cities, and #54/#59/#64-#68
/// each carry two separate 1-slot cities. Pooling their slots -- which is
/// what a hex-keyed count necessarily does -- reports an OPEN slot on a hex
/// whose relevant city is genuinely full, and there is no way to recover the
/// distinction after the fact from a `Vec<(i32, i32)>`.
///
/// Deliberately a SEPARATE map rather than a widened `PROTOCOL_STATION_HEXES`
/// element type. That map's entries are stored as JSON `[q, r]` pairs; any
/// struct or 3-tuple replacement fails to deserialize them, which would brick
/// every game in flight. A new map starts empty and absent, so a pre-G-12
/// game reads it as "no per-city detail recorded" and
/// `hexmap::hex_token_occupants` reconstructs those tokens against city 0 --
/// the pre-G-12 assumption, and correct for the single-city hexes that are
/// the overwhelming majority of the board.
///
/// INVARIANT, enforced by `hexmap::execute_place_station_token` and
/// `hexmap::grant_home_station_token`, the only two writers: for any hex, the
/// number of entries naming a given `city_index` never exceeds that city's
/// slot count from `hexmap::city_slot_counts_at`.
pub const HEX_STATION_TOKENS: Map<(u64, i32, i32), Vec<(u32, u8)>> =
    Map::new("hex_station_tokens");

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

/// One completed, replayable game transaction, recorded into `GAME_LOG` the
/// instant its handler succeeds (see `contract::execute`'s dispatch, which
/// calls `gamelog::record_action` right after each of these variants'
/// underlying handler returns `Ok`). Every variant carries the acting
/// `player` explicitly -- `game_id` itself is not repeated here since it's
/// already `GAME_LOG`'s map key, matching this project's established
/// convention of not duplicating a composite key's leading component inside
/// the stored value (see `ProtocolMarketState`, `Tile`, `PrivateCompany`,
/// etc.).
///
/// This is a deliberately scoped subset of `ExecuteMsg`, NOT a 1:1 mirror
/// of every mutating message -- see `gamelog.rs`'s module doc comment for
/// exactly which messages are excluded (real-JUNO-moving messages like
/// `CreateGameRoom`/`JoinGameRoom`/`EndGameAndDistribute`, plus
/// `EmergencyBuyHardware`'s bankruptcy path and `ExecuteOperatingRound`'s
/// multi-company batch) and why.
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
    /// Records a successful `hexmap::execute_place_station_token` call --
    /// see design note #40 in `hexmap.rs`. Does NOT record the free home
    /// token granted automatically at float (that's re-derived on replay by
    /// re-running whichever `BidOnPrivate`/`BuyStock` action originally
    /// floated the company, exactly like every other float-time side
    /// effect already is).
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

/// Counts every certificate `player` currently holds in `game_id`, per the
/// classic 1830 Global Certificate Limit rule: one certificate for each
/// private company they own (checked against `private_ids`), plus one
/// certificate for every physical stock card they hold across
/// `public_company_ids`. Shared by `trading::execute_buy_stock` and
/// `auction::execute_bid_on_private`'s certificate-limit checks (see
/// `trading::CERTIFICATE_LIMIT_BY_PLAYER_COUNT`) since both need the exact
/// same count. Takes the id catalogs as parameters -- rather than importing
/// `auction::CORE_PRIVATE_COMPANIES` / `public_company::CORE_PUBLIC_COMPANIES`
/// directly -- so this data-layer module stays a leaf with no dependency on
/// either business-logic module; callers already have both catalogs in
/// scope.
///
/// **President's certificate counts as exactly ONE physical card, not two.**
/// A player's raw `PLAYER_SHARES` percentage in a company they preside over
/// includes their President's certificate -- one physical card worth
/// `president_share_percentage` (20%) -- plus, potentially, additional
/// ordinary `percent_per_share` (10%) cards on top of that. A naive
/// `held_pct / percent_per_share` (e.g. `20 / 10 = 2`) double-counts the
/// President's card as if it were two ordinary certificates -- wrong, per
/// the real 1830 rule (re-verified against the official Lookout Games
/// rulebook, 18xx.net, and the open-source `tobymao/18xx` engine's own
/// `num_certs`/`cert_size` implementation, where a president's `Share`
/// never gets `cert_size: 2` -- see `RulesReference.tsx`'s own design note
/// #4 in the frontend for the full citations). This function checks
/// `PROTOCOL_PRESIDENT` for each company `player` holds any stake in: if
/// they're the registered President there, exactly 1 certificate covers
/// their first `president_share_percentage` of ownership, and only the
/// REMAINDER beyond that is counted in ordinary `percent_per_share` blocks.
/// `president_share_percentage` is threaded in as a parameter (like
/// `percent_per_share` already is) rather than imported from `trading.rs`
/// directly, for the identical leaf-module reason given above -- callers
/// pass `trading::PRESIDENT_MIN_PERCENTAGE`.
pub fn count_player_certificates(
    storage: &dyn Storage,
    game_id: u64,
    player: &Addr,
    private_ids: &[u32],
    public_company_ids: &[u32],
    percent_per_share: u8,
    president_share_percentage: u8,
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
