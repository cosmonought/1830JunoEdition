use cosmwasm_std::{Addr, Uint128};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::state::{RoundType, TileColor};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct InstantiateMsg {
    pub subsidy_fee_percentage: u64, // e.g., 50 for 0.5%
}

/// Where a `BuyStock` purchase draws its certificate from -- determines
/// which price it's bought at. See `ExecuteMsg::BuyStock`'s doc comment.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
pub enum SharePurchaseSource {
    /// The Initial Public Offering pool: shares never yet sold to any
    /// player. Priced at the protocol's fixed Par Value.
    Ipo,
    /// The Open Market/Bank pool: shares a player previously bought and
    /// then sold back onto the market. Priced at the protocol's current
    /// floating Market Value.
    Bank,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub enum ExecuteMsg {
    /// Creates a new game lobby for exactly `max_players` (2-6) players.
    /// `max_players` fixes the denominator for every player's starting VGP
    /// capital, so everyone -- the creator (immediately provisioned) and
    /// everyone who later calls `JoinGameRoom` -- receives the same
    /// `contract::STARTING_CAPITAL_POOL / max_players`, regardless of join
    /// order. The room stops accepting joins once `max_players` is reached.
    CreateGameRoom {
        virtual_bank_start: Uint128, // e.g., 12000
        max_players: u8,             // 2-6, e.g. 4 for $600 VGP starting capital each
    },
    /// Registers `info.sender` as a new player in an active game room.
    /// **Uniform Ante Rule:** the attached funds must be exactly one coin
    /// of `NATIVE_DENOM`, matching the room creator's own
    /// `CreateGameRoom` deposit amount down to the last `ujuno` -- neither
    /// more nor less, and never omitted. A mismatched amount is rejected
    /// with `ContractError::InvalidAnteAmount`. See
    /// `contract::execute_join_game_room` for the full design.
    JoinGameRoom { game_id: u64 },
    /// Closes out an active game room and redeems the real-JUNO lobby pool
    /// proportionally against each player's final VGP net worth. That net
    /// worth is computed entirely on-chain -- `PLAYER_CASH_VGP` plus the
    /// live market value of every share held, priced off each protocol's
    /// current `PROTOCOL_MARKET` cell -- never accepted as caller-supplied
    /// input; see `contract::calculate_player_net_worth`. Only the room's
    /// creator may call this.
    EndGameAndDistribute { game_id: u64 },
    /// Buys exactly one certificate (a fixed 10% share block, per rules.md's
    /// SR transaction rule) of `protocol_id`, from either its IPO pool or
    /// its Open Market/Bank pool, per `source`:
    /// - `SharePurchaseSource::Ipo`: pays the protocol's fixed Par Value.
    ///   On the very first-ever IPO purchase of this protocol, `par_value`
    ///   is *required* and must be one of the six standard 1830 par prices
    ///   ($67/$71/$76/$82/$90/$100) -- this choice also pins the
    ///   protocol's starting `MARKET_GRID` position. On every later IPO
    ///   purchase, `par_value` must be omitted or must match the
    ///   already-chosen par value.
    /// - `SharePurchaseSource::Bank`: pays the protocol's current floating
    ///   Market Value, read off `MARKET_GRID` at its live position.
    ///   `par_value` must always be omitted here.
    ///
    /// See `trading::execute_buy_stock` for the full logic, including how
    /// this interacts with the 60%-real-player-ownership flotation trigger
    /// (still capitalizes the treasury at 10x the protocol's Par Value).
    ///
    /// Turn-gated: only `GameSession::player_addresses[active_player_index]`
    /// may call this (`TradingError::NotYourTurn` otherwise). A successful
    /// purchase advances the turn pointer to the next player and resets
    /// `consecutive_passes` to `0` -- see `trading::ensure_active_player`/
    /// `trading::advance_turn` and `gamelog.rs`'s module doc comment #4.
    BuyStock {
        game_id: u64,
        protocol_id: u32,
        source: SharePurchaseSource,
        par_value: Option<Uint128>,
    },
    /// Sells `percentage` of `protocol_id` (any multiple of 10%, per
    /// rules.md's SR transaction rule) back onto the open market. Each
    /// certificate sold is settled at the price at the time of sale and
    /// drops the price one row (the "dumped shares" market movement).
    ///
    /// Turn-gated exactly like `BuyStock` -- see that variant's doc comment.
    SellStock {
        game_id: u64,
        protocol_id: u32,
        percentage: u8,
    },
    /// Declares an Operating Round dividend for `protocol_id`. When
    /// `distribute` is true, `revenue_amount` is split proportionally
    /// across all shareholders (Distribute Yield; price moves right).
    /// When false, the full amount is withheld into the protocol's
    /// treasury (Slash/Retain Yield; price moves left).
    DeclareDividends {
        game_id: u64,
        protocol_id: u32,
        revenue_amount: Uint128,
        distribute: bool,
    },
    /// Places a bid on private company `private_id`'s ongoing auction.
    /// Must be at least $5 VGP higher than the current standing bid (or at
    /// least the private's face value if no one has bid yet). A winning
    /// bid immediately and automatically transfers provisional ownership
    /// to the bidder and refunds whoever it was outbid.
    ///
    /// Turn-gated exactly like `BuyStock` -- only the active player may
    /// bid (`AuctionError::NotYourTurn` otherwise), and a winning bid
    /// advances the turn pointer and resets `consecutive_passes` to `0`.
    /// See `auction::ensure_active_player`/`auction::advance_turn`.
    BidOnPrivate {
        game_id: u64,
        private_id: u32,
        bid_amount: Uint128,
    },
    /// Phase-Gated Corporate Purchase Protocol: buys private company
    /// `private_id` out from under its current player-owner, on behalf of
    /// `protocol_id`'s own treasury -- the real 1830 rule that once Phase 3
    /// (the 3-train era, `TileColor::Green` in this engine's model) begins,
    /// an operating corporation may absorb a private company directly.
    /// `price` is the corporation's own offer, which must land between 50%
    /// and 200% of the private's printed face value (`PrivateCompany::cost`),
    /// inclusive -- there's no separate player-side accept/reject step, so
    /// this is a unilateral, bounded-price corporate purchase rather than a
    /// true two-party negotiation.
    ///
    /// Hard-blocked entirely before Phase 3 (`TradingError::PrivatePurchaseLockedBeforePhase3`),
    /// and rejected if `private_id` is already `closed`, already
    /// corporation-owned, or currently unowned. Authorized exactly like
    /// `DeclareDividends`: only `protocol_id`'s registered President may
    /// call this, and -- if the room has a non-empty Operating Round
    /// Corporation Turn Queue -- `protocol_id` must be whichever
    /// corporation `active_corporation_index` currently points to. See
    /// `trading::execute_buy_private_company` for the full design,
    /// including the B&O Special Closure and Private-Company-Reserved-Hex
    /// consequences of a private changing hands this way
    /// (`hardware.rs`/`hexmap.rs`).
    BuyPrivateCompany {
        game_id: u64,
        protocol_id: u32,
        private_id: u32,
        price: Uint128,
    },
    // REMOVED (Audit G-13): `ExecuteOperatingRound` -- see `operations.rs`
    // for why the legacy batched Operating Round mechanic was deleted
    // rather than reconciled with the sequential queue.
    /// Begins `game_id`'s Operating Round Corporation Turn Queue: computes
    /// the classic 1830 operating order -- every currently floated public
    /// company, highest stock price first, ties broken by whichever
    /// protocol's market marker most recently arrived at its price
    /// (`operations::calculate_operating_order`) -- and writes it into
    /// `GameSession::active_operating_order`, resetting
    /// `active_corporation_index` to `0`. Once populated, `LayTile`,
    /// `BuyHardwareFromPool`, and `DeclareDividends` all additionally
    /// require their `protocol_id` to be whichever corporation
    /// `active_corporation_index` currently points to, rejecting
    /// out-of-turn calls with that module's own `NotYourOperatingTurn`
    /// error. Authorized like `ExecuteOperatingRound`: only the room's
    /// creator (its Validator/organizer) may call this, since starting an
    /// Operating Round is a room-level action, not any one company's. See
    /// `operations::execute_begin_operating_round` for the full design.
    /// Pair this with `EndOperatingRoundTurn` below to actually advance
    /// `active_corporation_index` from one corporation to the next once the
    /// queue is populated.
    BeginOperatingRound { game_id: u64 },
    /// Ends `protocol_id`'s turn in `game_id`'s Operating Round Corporation
    /// Turn Queue (populated by `BeginOperatingRound` above) and advances
    /// it: to the next corporation in `active_operating_order` if any
    /// remain this sub-round; otherwise to the next Pacing-Automation-paced
    /// sub-round (`GameSession::sub_round_index` increments, a fresh
    /// operating order is computed) if `operating_round_sequence_length`
    /// hasn't been reached yet; otherwise -- Macro Round Loop Advancement --
    /// `macro_round_number` increments, `sub_round_index` resets to `0`, and
    /// `current_round_type` flips back to `RoundType::StockRound`. Only
    /// `protocol_id`'s registered President may call this, and it must be
    /// exactly whichever corporation `active_corporation_index` currently
    /// points to (`NotYourOperatingTurn` otherwise). See
    /// `operations::execute_end_operating_round_turn` for the full design.
    EndOperatingRoundTurn { game_id: u64, protocol_id: u32 },
    /// Manual Route Validation: lets `protocol_id`'s President submit a
    /// hand-picked path of real board hex labels (e.g. `["G19", "F20",
    /// "E21"]`) instead of relying on the automatic
    /// `pathfinding::trace_best_route` search `ExecuteOperatingRound` uses.
    /// The path is validated step-by-step: it must form a connected chain
    /// of legal track connections, must touch the company's own station
    /// (its home hex -- `pathfinding.rs`'s existing stand-in for a
    /// not-yet-built Token Station Placement step), must never cross
    /// another floated protocol's blocking home station, and must not
    /// exceed the distance budget of the company's best-owned Hardware. On
    /// success, the path's summed tile value is declared according to
    /// `payout_strategy` -- see that field's own doc comment -- and the
    /// Operating Round Corporation Turn Queue advances exactly like
    /// `EndOperatingRoundTurn` -- so this message REQUIRES
    /// `BeginOperatingRound` to have already populated that queue, and
    /// `protocol_id` must be exactly whichever corporation
    /// `active_corporation_index` currently points to
    /// (`NoActiveOperatingOrder`/`NotYourOperatingTurn` otherwise). Only
    /// `protocol_id`'s registered President may call this. See
    /// `operations::execute_run_manual_route` for the full validation
    /// design.
    RunManualRoute {
        game_id: u64,
        /// NOTE: every other message in this contract types `protocol_id`
        /// as `u32` (see `BuyStock`/`DeclareDividends`/
        /// `EndOperatingRoundTurn` above, and `msg.rs`'s own
        /// `LegalTilePlacementsResponse`) -- a `u64` here would be the only
        /// exception in this whole enum, and would need an extra
        /// narrowing/overflow-checked conversion at every lookup into
        /// `PUBLIC_COMPANIES`/`PROTOCOL_PRESIDENT`/`COMPANY_HARDWARE`/etc.,
        /// all of which are keyed by `u32`. Kept as `u32` for consistency
        /// with the rest of this enum rather than introduced as a one-off
        /// `u64` for this single variant.
        protocol_id: u32,
        /// Real board hex labels (e.g. `"G19"`), resolved to axial `(q, r)`
        /// coordinates via `hexmap::axial_for_label`. Order matters -- each
        /// consecutive pair must be direct, track-connected neighbors.
        hex_path: Vec<String>,
        /// Distribute Yield (`PayoutStrategy::DeclareDividends`) or
        /// Slash/Retain Yield (`PayoutStrategy::Withhold`) for this route's
        /// declared revenue -- see `PayoutStrategy`'s own doc comment. This
        /// closes the gap an earlier pass of this message left open (it
        /// always defaulted to Distribute Yield, with no retain/withhold
        /// choice field the way `DeclareDividends`/`ExecuteOperatingRound`
        /// already had one).
        payout_strategy: PayoutStrategy,
    },
    /// Lays hex tile `tile_id` at axial coordinate `(q, r)`, at the
    /// caller-chosen `orientation` (0-5), on the shared map network, on
    /// behalf of `protocol_id`. Only that protocol's registered President
    /// may call this, and its treasury is charged the tile's terrain cost
    /// (if any). PLAYER-CHOSEN ORIENTATION: `orientation` is validated,
    /// never auto-picked -- `execute_lay_tile` rejects it outright with
    /// `InvalidOrientation` if it isn't `0..=5`, and otherwise evaluates
    /// exactly that rotation (and no other) against the placement's
    /// connectivity/topology-retention rules, erroring with
    /// `NoLegalConnection`/`TopologyNotPreserved` if the specific submitted
    /// angle doesn't satisfy them -- a real 1830 strategic choice (which
    /// direction a route extends) that a prior pass had mistakenly removed
    /// by auto-picking the lowest legal rotation on the caller's behalf.
    /// `QueryMsg::GetLegalTilePlacements` remains the recommended way for a
    /// frontend to discover which `(tile_id, orientation)` pairs are
    /// currently legal before submitting one. See
    /// `hexmap::execute_lay_tile`.
    LayTile {
        game_id: u64,
        protocol_id: u32,
        q: i32,
        r: i32,
        tile_id: u32,
        orientation: u32,
    },
    /// Places `protocol_id`'s next Station Token at axial coordinate
    /// `(q, r)`, at the flat VGP cost `hexmap::station_token_cost` prices
    /// for that token's ordinal position (2nd token: 40 VGP; 3rd and every
    /// one after: 100 VGP) -- the FREE home token is granted automatically
    /// the moment a corporation floats, never through this message; see
    /// `hexmap::grant_home_station_token`. Only that protocol's registered
    /// President may call this, only during that protocol's own Operating
    /// Round turn, and only once per Operating Round sub-round. `(q, r)`
    /// must already hold a laid `MajorCityHub`/`DoubleCityHub` tile,
    /// reachable from this protocol's own existing track network, with no
    /// token this protocol already owns sitting there, and this protocol's
    /// total token count (`hexmap::station_token_limit`) not yet reached.
    /// See `hexmap::execute_place_station_token` and that module's design
    /// note #23 for the full rule set and rationale.
    PlaceStationToken {
        game_id: u64,
        protocol_id: u32,
        q: i32,
        r: i32,
        /// Audit G-12: WHICH city on `(q, r)` to token. Hexes carrying two
        /// separate cities -- New York (#54/#62) and every OO tile
        /// (#59/#64-#68) -- need this to be answerable at all; on a
        /// single-city hex the only valid value is `0`.
        ///
        /// `Option` + `#[serde(default)]` so this is genuinely additive: a
        /// client built before G-12 omits the key and the contract resolves
        /// it to the lowest-indexed city with a free slot, which on a
        /// single-city hex is the only city and on a two-city hex is at
        /// least always a LEGAL placement rather than a rejection.
        #[serde(default)]
        city_index: Option<u8>,
    },
    /// Buys the next available unit from the front of the shared, global
    /// `HARDWARE_POOL` supply queue on behalf of `protocol_id` (only that
    /// protocol's registered President may call this), charging its
    /// baseline cost against the company's treasury. May automatically
    /// trigger the cascading "Rusting" obsolescence sweep -- see
    /// `hardware::execute_buy_hardware_from_pool`.
    BuyHardwareFromPool { game_id: u64, protocol_id: u32 },
    /// Validator Liability / Emergency Buy: usable only when `protocol_id`
    /// currently owns zero Hardware and its own treasury alone cannot
    /// afford the next `HARDWARE_POOL` unit (otherwise this fails and
    /// `BuyHardwareFromPool` should be used instead). The President's
    /// personal `PLAYER_CASH_VGP` covers the shortfall if it can; if even
    /// the combined treasury and personal wallet can't afford it, this call
    /// still *succeeds*, but permanently halts the game session (flips
    /// `GameSession::is_active` to `false`) and emits a dedicated
    /// `bankruptcy` event. See `hardware::execute_emergency_buy_hardware`
    /// for the full design, including why a durable on-chain halt has to be
    /// a successful transaction rather than an error under CosmWasm's
    /// atomic-revert rules.
    EmergencyBuyHardware { game_id: u64, protocol_id: u32 },
    /// Advances `game_id`'s turn pointer (`GameSession::active_player_index`)
    /// to the next player in `player_addresses` order, wrapping around, and
    /// increments `GameSession::consecutive_passes` by one (the opposite of
    /// what a successful `BuyStock`/`SellStock`/`BidOnPrivate` does to that
    /// counter -- a pass extends an all-pass streak, a trade breaks one).
    /// Only the currently active player may call this. See
    /// `gamelog::execute_pass_turn`, and that module's doc comment #4 for
    /// exactly which actions are turn-gated today.
    PassTurn { game_id: u64 },
    /// Pops the single most recent entry off `game_id`'s event-sourced
    /// `GAME_LOG` and recomputes the room's entire replayable state --
    /// cash, shares, IPO/Bank pools, par values, presidencies, treasuries,
    /// market positions, laid track, Hardware ownership, and the turn/
    /// priority pointers -- from scratch, by resetting to genesis and
    /// fast-forwarding through whatever's left, in order. This mirrors how
    /// 18xx.games itself implements Undo (recompute from history) rather
    /// than trying to write a bespoke inverse for every action type. Any
    /// player registered in `game_id` may call this, not just the room
    /// creator. See `gamelog::execute_undo_last_action` /
    /// `gamelog::reapply_game_log` for exactly which action types are
    /// currently recorded in (and thus undoable from) the log -- a
    /// deliberately scoped subset that excludes anything moving real JUNO
    /// and a couple of complex batch/bankruptcy paths.
    UndoLastAction { game_id: u64 },
    /// Inactivity Timeout Safety Valve: closes out game room `game_id` and
    /// refunds every registered player's real-JUNO ante -- exactly what
    /// they personally deposited, tracked in `state::PLAYER_JUNO_ANTE`, not
    /// a proportional or recomputed split (contrast `EndGameAndDistribute`,
    /// which redeems the pool against final VGP net worth) -- if and only
    /// if more than 48 hours (172,800 seconds) have elapsed since
    /// `GameSession::last_action_timestamp`, the timestamp of the room's
    /// most recent qualifying state-advancing action (`BuyStock`,
    /// `SellStock`, `PassTurn`, `LayTile`, `DeclareDividends`, or
    /// `BuyHardwareFromPool` -- see that field's doc comment in `state.rs`).
    /// Any player currently registered in `game_id` may call this -- it's a
    /// safety valve for an abandoned room, not a privileged action, so it
    /// isn't restricted to the room's creator the way `EndGameAndDistribute`
    /// is. Sets `GameSession::is_active` to `false` on success, matching
    /// every other room-closing action. See
    /// `contract::execute_claim_timeout_refund`.
    ClaimTimeoutRefund { game_id: u64 },
    /// Pre-Game Waterfall Auction: buys whichever private company is
    /// currently the cheapest still-unowned one, at its exact face value,
    /// right now. Only legal while `GameSession::waterfall_auction_active`
    /// is `true`, it's the caller's turn, and no mini-auction is currently
    /// in progress. See `waterfall::execute_waterfall_buy_lowest`.
    WaterfallBuyLowest { game_id: u64 },
    /// Pre-Game Waterfall Auction: places an escrowed bid of `bid_amount` on
    /// `private_id`, which must be a still-unowned private OTHER than the
    /// current cheapest one (that one can only ever be bought outright, via
    /// `WaterfallBuyLowest`). `bid_amount` must be at least `private_id`'s
    /// face value (if unbid) or the current standing high bid plus the $5
    /// minimum increment. See `waterfall::execute_waterfall_bid_higher`.
    WaterfallBidHigher {
        game_id: u64,
        private_id: u32,
        bid_amount: Uint128,
    },
    /// Pre-Game Waterfall Auction: passes on the current turn. Only legal
    /// while at least one private company anywhere has an active bid --
    /// otherwise every player is forced to Buy Lowest or Bid Higher. A full
    /// round of consecutive passes ends the whole auction early. See
    /// `waterfall::execute_waterfall_pass`.
    WaterfallPass { game_id: u64 },
    /// Pre-Game Waterfall Auction: raises the standing bid in an active
    /// mini-auction (a 2+-bidder tie on some private, resolved separately
    /// from the main turn order). Only the participant whose turn it
    /// currently is in the mini-auction may call this. See
    /// `waterfall::execute_waterfall_mini_auction_raise`.
    WaterfallMiniAuctionRaise { game_id: u64, bid_amount: Uint128 },
    /// Pre-Game Waterfall Auction: passes in an active mini-auction,
    /// dropping the caller out and fully refunding their escrowed bid on
    /// that private. If exactly one bidder remains afterward, they win the
    /// private at the current high bid and the Waterfall Cascade resumes.
    /// See `waterfall::execute_waterfall_mini_auction_pass`.
    WaterfallMiniAuctionPass { game_id: u64 },
}

/// The classic 1830 Operating Round payout choice, as a named enum --
/// `ExecuteMsg::RunManualRoute`'s own way of expressing the same
/// Distribute Yield / Slash-Retain Yield decision
/// `ExecuteMsg::DeclareDividends`'s `distribute: bool` field and
/// `PublicCompanyPayoutChoice::payout: bool` (below) already expose
/// elsewhere in this enum. This message alone gets a named enum rather than
/// a bare `bool`; `DeclareDividends`/`ExecuteOperatingRound` are
/// deliberately left as-is rather than retrofitted, since changing an
/// already-live message's field type would be a breaking wire-format
/// change for no behavioral gain.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
pub enum PayoutStrategy {
    /// Distribute Yield: the route's declared revenue splits across every
    /// shareholder proportionally to their holding percentage (with any
    /// un-owned/IPO-held remainder falling to the game bank -- see
    /// `operations::execute_run_manual_route`), and the market price moves
    /// right (up) via `market::move_right`.
    DeclareDividends,
    /// Slash/Retain Yield: 100% of the route's declared revenue is
    /// withheld directly into the operating company's own treasury (no
    /// shareholder payout), and the market price moves left (down) via
    /// `market::move_left`. Matches this file's `execute_operating_round`
    /// sibling function's own `payout: false` branch exactly -- see that
    /// function's doc comment and module doc comment #4 for the
    /// project's already-documented, not-yet-reconciled divergence between
    /// `PublicCompany::treasury` (used here) and the separate
    /// `PROTOCOL_TREASURY_VGP` map `trading::execute_declare_dividends`'s
    /// own `distribute: false` branch credits instead.
    Withhold,
}

// REMOVED (Audit G-13): `PublicCompanyPayoutChoice` -- the payload type of
// the deleted `ExecuteOperatingRound`. `PayoutStrategy` is deliberately KEPT:
// `RunManualRoute` still uses it.


/// Read-only queries against a single game room's live state -- the
/// Game State Query messages. See `contract::query` for the CosmWasm
/// `query` entry point that dispatches these, and `query.rs` for how each
/// response is actually assembled from the underlying storage maps.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub enum QueryMsg {
    /// Returns `game_id`'s full game-scoped state snapshot: every
    /// registered player's VGP cash balance, every public and private
    /// company's treasury/ownership/par-value/presidency registry, and the
    /// room's general round settings (the turn/priority/pass pointers, the
    /// current Tech Era, the Operating Round Corporation Turn Queue, and the
    /// Macro Round Tracker -- `current_round_type`/`macro_round_number`/
    /// `sub_round_index`/`operating_round_sequence_length`, e.g. to display
    /// "SR1" or "OR2.1"). See `query::GameStateResponse` / `query::query_game_state`.
    GetGameState { game_id: u64 },
    /// Returns the live `(x, y)` stock-market grid coordinates -- and,
    /// where resolvable, the price at that cell -- of every core public
    /// company's price marker in `game_id`. Every company gets a seeded
    /// position from `CreateGameRoom` onward (see
    /// `market::initialize_game_market`), whether or not it has floated
    /// yet, so all eight always appear here. See
    /// `query::MarketGridResponse` / `query::query_market_grid`.
    GetMarketGrid { game_id: u64 },
    /// Returns every hex tile currently laid on `game_id`'s shared
    /// `MAP_GRID`: its `(q, r)` coordinate, `tile_id`, orientation, and --
    /// if it sits on one of the three reserved landmark hexes -- which
    /// city. See `query::MapGridResponse` / `query::query_map_grid`.
    GetMapGrid { game_id: u64 },
    /// Renders `game_id`'s current `MAP_GRID` as a human-readable Markdown/
    /// ASCII text block -- a data table of every laid tile plus an
    /// approximate square-grid sketch of the board, with the three
    /// landmark cities labeled. This is the added query string format for
    /// `query::print_markdown_map`; see that function's doc comment for
    /// exactly what it can and can't do -- a deployed CosmWasm contract has
    /// no terminal/stdout access of its own, so this query *returns* the
    /// rendered text for an off-chain caller (a CLI script, a test, a
    /// frontend) to actually print. See `query::MapGridMarkdownResponse` /
    /// `query::query_map_grid_markdown`.
    GetMapGridMarkdown { game_id: u64 },
    /// Returns every `(tile_id, orientation)` pairing that would currently
    /// be legal to lay for `protocol_id` at `(q, r)` -- meant to back a
    /// frontend's "legal tile" selection popup, so a player is only ever
    /// offered choices `ExecuteMsg::LayTile` would actually accept. Tests
    /// every `hexmap::TILE_CATALOG` entry across all six rotations against
    /// the same three placement rules `execute_lay_tile` itself enforces:
    /// Tech Era color-locking, Landmark Reservation, and either fresh-
    /// placement Path Connectivity to `protocol_id`'s Token Station network
    /// (if `(q, r)` is empty) or Topology-Retention upgrade edge
    /// preservation (if `(q, r)` is already occupied) -- see `hexmap.rs`'s
    /// module doc comments #8/#9/#10/#11 for each rule's full definition.
    /// Deliberately does NOT check `protocol_id`'s President authorization,
    /// treasury affordability, or Operating Round Corporation Turn Queue
    /// position -- those are execution-time authorization/funding
    /// concerns, not placement legality, and `LayTile` still enforces all
    /// three independently; a placement returned here is not a guarantee
    /// that a live `LayTile` transaction will succeed. See
    /// `query::query_legal_tile_placements` / `hexmap::legal_tile_placements`.
    GetLegalTilePlacements {
        game_id: u64,
        protocol_id: u32,
        q: i32,
        r: i32,
    },
    /// Returns `wallet_address`'s authentic 1830 net worth in `game_id`:
    /// their liquid `PLAYER_CASH_VGP` balance plus the live market value of
    /// every share certificate they hold across every public company --
    /// each company's `PLAYER_SHARES` percentage converted to a certificate
    /// count (`percentage / trading::PERCENT_PER_SHARE`) and priced at that
    /// company's current `MARKET_GRID` cell (via `market::current_cell`),
    /// not its fixed Par Value. This is the standard 1830 winning-condition
    /// metric ("cash plus the value of your shares at the current market
    /// price") and is meant to back both an eventual endgame ranking and a
    /// live "liquid asset log" display. `wallet_address` is validated with
    /// `deps.api.addr_validate` the same way every `execute_*` handler
    /// validates a caller-supplied address -- a malformed address string
    /// still errors, same as everywhere else in this contract. A
    /// well-formed but unregistered player (never joined `game_id`, or
    /// joined but holds nothing) is NOT an error, though: every underlying
    /// lookup (`PLAYER_CASH_VGP`, `PLAYER_SHARES`) already treats a missing
    /// entry as zero, so an unregistered address simply prices out at `0`
    /// cash and `0` shares -- a real, honest `0` net worth, not a failure.
    /// See `query::PlayerNetWorthResponse` / `query::query_player_net_worth`.
    PlayerNetWorth { game_id: u64, wallet_address: String },
    /// Returns `game_id`'s live Pre-Game Waterfall Auction state: every
    /// still-unowned core private company in ascending face-value order
    /// (with its full list of standing bids), which one is currently the
    /// lowest-offered (face-value-buyable) private, whose turn it is, and --
    /// if a 2+-bidder mini-auction is currently in progress -- that
    /// mini-auction's own tied-bidder turn order and standing high bid.
    /// Meaningful only while `GameSession::waterfall_auction_active` is
    /// `true`; still returns a well-formed (if less interesting) snapshot
    /// afterward, since every field derives from ordinary queryable state.
    /// See `query::WaterfallStateResponse` / `query::query_waterfall_state`.
    GetWaterfallState { game_id: u64 },
}

/// One registered player's VGP cash balance, part of `GameStateResponse`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PlayerCashEntry {
    pub player: Addr,
    pub cash_vgp: Uint128,
}

/// One player's nonzero share holding in a single public company, part of
/// `PublicCompanyState::player_holdings`. Players holding exactly `0%` are
/// omitted -- see `GameStateResponse`'s doc comment on `QueryMsg::GetGameState`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PlayerShareEntry {
    pub player: Addr,
    pub percentage: u8,
}

/// One public corporation's full ownership/treasury/registry snapshot,
/// part of `GameStateResponse`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PublicCompanyState {
    pub company_id: u32,
    pub ticker: String,
    pub is_floated: bool,
    pub treasury: Uint128,
    pub total_shares_issued: u8,
    /// `None` until this company's very first-ever IPO purchase chooses a
    /// par value (or, for B&O, always `Some` from the moment its private
    /// company is won).
    pub par_value: Option<Uint128>,
    /// `None` if nobody currently holds a qualifying President stake.
    pub president: Option<Addr>,
    pub ipo_pool_percentage: u8,
    pub bank_pool_percentage: u8,
    pub player_holdings: Vec<PlayerShareEntry>,
    /// This corporation's preprinted home hex label (e.g. `"I15"`), or
    /// `None` for a corporation with no assigned home on this board (today,
    /// only NNH). See `hexmap::CORPORATION_HOME_HEX`.
    pub home_hex_label: Option<String>,
    /// Every hex `(q, r)` currently holding one of this corporation's own
    /// Station Tokens, home token (if any) first -- empty before it floats.
    /// See `hexmap::PROTOCOL_STATION_HEXES`.
    pub station_token_hexes: Vec<(i32, i32)>,
    /// The SAME tokens as `station_token_hexes`, one entry each and in the
    /// same order, but as `(q, r, city_index)` -- Audit G-12.
    ///
    /// A hex is not a city. New York (#54/#62) and every OO tile
    /// (#59/#64-#68) carry two separate cities on one hex, so `(q, r)` alone
    /// cannot say which station a token stands in, and a renderer reading
    /// only the hex has to guess -- which is what produced tokens floating
    /// on the wrong half of a two-city tile.
    ///
    /// `station_token_hexes` is KEPT rather than replaced: it is what the
    /// token-limit and duplicate-hex rules are actually about, and dropping
    /// it would break every existing client for no gain. Read this field
    /// when you need to know WHICH city; read that one when you need to know
    /// how many hexes a company has tokened.
    ///
    /// `#[serde(default)]` for the usual reason in both directions -- a
    /// client predating this field ignores it, and a Rust client
    /// deserializing an older response gets an empty vector rather than a
    /// hard error. An empty vector here alongside a NON-empty
    /// `station_token_hexes` means "this contract predates G-12", not "this
    /// company has no tokens".
    #[serde(default)]
    pub station_tokens: Vec<(i32, i32, u8)>,
    /// This corporation's total Station Token limit, home token included.
    /// See `hexmap::station_token_limit`.
    pub station_token_limit: u8,
}

/// One private company's ownership snapshot, part of `GameStateResponse`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PrivateCompanyState {
    pub private_id: u32,
    pub name: String,
    pub cost: Uint128,
    pub revenue_per_or: Uint128,
    pub owner: Option<Addr>,
    /// Phase-Gated Corporate Purchase Protocol (`trading.rs` module doc
    /// comment #17): the corporation this private is owned by, if any --
    /// mutually exclusive with `owner` (see `state::PrivateCompany`'s own
    /// doc comment). `None` while the private is player-owned (or unowned).
    pub owner_protocol_id: Option<u32>,
    /// Whether this private has been permanently removed from play, via
    /// either the B&O Special Closure or the Phase 5 Private Closure
    /// (`hardware.rs` module doc comments #11/#12). A closed private is
    /// never biddable/buyable again and, per `hexmap.rs` module doc comment
    /// #24, no longer exerts any hex-reservation power either.
    pub closed: bool,
}

/// `QueryMsg::GetGameState`'s response. See that variant's doc comment.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct GameStateResponse {
    pub game_id: u64,
    pub creator: Addr,
    pub is_active: bool,
    pub total_juno_pool: Uint128,
    pub virtual_bank_vgp: Uint128,
    pub virtual_bank_start: Uint128,
    pub max_players: u8,
    pub player_addresses: Vec<Addr>,
    pub active_player_index: u32,
    pub priority_deal_index: u32,
    pub consecutive_passes: u32,
    pub current_global_era: TileColor,
    pub active_operating_order: Vec<u32>,
    pub active_corporation_index: u32,
    /// Macro Round Tracker (see `state::GameSession`'s matching fields and
    /// `operations.rs`'s module doc comment #11): whether the room is
    /// currently in a Stock Round or an Operating Round.
    pub current_round_type: RoundType,
    /// Macro Round Tracker: the overall round counter -- the leading digit
    /// in "SR1"/"OR2.1" style display labels.
    pub macro_round_number: u32,
    /// Macro Round Tracker: which sub-round is active within
    /// `current_round_type` -- the trailing digit in "OR2.1".
    pub sub_round_index: u32,
    /// Pacing Automation: how many consecutive Operating Round sub-rounds
    /// the current Operating Round phase is scheduled to run for, per the
    /// highest Hardware tier purchased so far in the room -- see
    /// `hardware.rs`'s module doc comment #10.
    pub operating_round_sequence_length: u32,
    pub player_cash: Vec<PlayerCashEntry>,
    pub public_companies: Vec<PublicCompanyState>,
    pub private_companies: Vec<PrivateCompanyState>,
}

/// One public company's live position on the shared `MARKET_GRID` board,
/// part of `MarketGridResponse`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MarketPositionEntry {
    pub company_id: u32,
    pub ticker: String,
    pub x: u32,
    pub y: u32,
    /// `None` only in the defensive case where a position is recorded but
    /// its `MARKET_GRID` cell somehow isn't seeded -- see
    /// `QueryMsg::GetMarketGrid`'s doc comment.
    pub price: Option<Uint128>,
}

/// `QueryMsg::GetMarketGrid`'s response. See that variant's doc comment.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MarketGridResponse {
    pub game_id: u64,
    pub positions: Vec<MarketPositionEntry>,
}

/// One laid hex tile, part of `MapGridResponse`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MapTileEntry {
    pub q: i32,
    pub r: i32,
    /// This hex's real 1830 board label (e.g. `"G19"`), resolved via
    /// `hexmap::describe_hex` -- Coordinate Symmetries (see `hexmap.rs`'s
    /// module doc comment #15): every coordinate this contract surfaces
    /// carries its authentic board label alongside the axial `(q, r)`, so a
    /// caller never has to hand-compute the transform to check it against
    /// the physical board.
    pub hex_label: String,
    pub tile_id: u32,
    pub orientation: u8,
    /// This tile's DISCRETE track segments, as BASE (pre-rotation) edge
    /// pairs -- `state::Tile::paths` verbatim, which in turn is
    /// `hexmap::TILE_CATALOG`'s seventh field for `tile_id`.
    ///
    /// Added so a client can render a tile's real, separate routes instead
    /// of inferring them from `connections` alone. That inference is lossy
    /// in exactly the case this field exists for: the five DoubleTown tiles
    /// (#1, #2, #55, #56, #69) each carry FOUR live edges paired into TWO
    /// independent two-edge routes, one per town, and a flat bitmask cannot
    /// say which edge pairs with which. A renderer reading only
    /// `connections` has to fall back to fanning every live edge into hex
    /// centre, which draws a four-way junction where the real tile has two
    /// disjoint curves. The same lossiness applies to any multi-route tile;
    /// this just makes the truth available to every caller rather than
    /// asking each one to hand-maintain its own copy of the catalog.
    ///
    /// Encoding matches `state::Tile::paths` exactly (see that field): each
    /// `(a, b)` is one continuous run of track between edges `a` and `b`,
    /// with `a == b` meaning a terminal spur that enters at `a` and dead-ends
    /// on the tile. Edge numbers are pre-rotation, so a consumer applies
    /// `orientation` itself -- the same convention `connections` already
    /// uses, and the reason the two can be decoded side by side without one
    /// needing to know how the other was transformed.
    ///
    /// BACKWARDS COMPATIBILITY, both directions. On the CONTRACT side, a
    /// `Tile` written before `state::Tile::paths` existed deserializes with
    /// `#[serde(default)]` to an empty `Vec`; `query_map_grid` resolves that
    /// through `hexmap::effective_base_tile_paths`, which falls back to the
    /// catalog entry for `tile_id`, so a legacy tile still reports its real
    /// segments rather than an empty list. That fallback is sound precisely
    /// because a tile's paths are a pure function of its `tile_id` -- it is
    /// a lookup, not a guess, and it is the same resolution `pathfinding.rs`
    /// already routes on. On the CLIENT side, a consumer that predates this
    /// field ignores it: JSON object members are unordered and unknown keys
    /// are skipped, so nothing that reads only `connections` changes
    /// behaviour.
    ///
    /// This is therefore empty only for a `tile_id` absent from the catalog
    /// entirely -- unreachable via `execute_lay_tile`, which rejects those
    /// with `TileNotFound`. A consumer should still handle the empty case,
    /// and must read it as "no discrete data available, fall back to
    /// decoding `connections`", NEVER as "this tile has no track".
    ///
    /// `#[serde(default)]` mirrors `state::Tile::paths`' own attribute, for
    /// the analogous reason one step further out: a Rust client (or a test
    /// replaying a recorded response) deserializing a `MapGridResponse`
    /// produced by a contract built before this field existed gets an empty
    /// `Vec` rather than a hard `missing field` error.
    #[serde(default)]
    pub paths: Vec<(u8, u8)>,
    /// What a route actually earns for stopping on this hex, in VGP -- Audit
    /// G-11. `hexmap::tile_base_value(tile_id)` verbatim.
    ///
    /// This is THE payout figure, not a display hint: it is the same call
    /// `pathfinding::HexInfo.value` and
    /// `operations::execute_run_manual_route` price a route through, so a
    /// client rendering it is showing exactly what the contract will pay.
    ///
    /// Added because the alternative was a client re-deriving revenue from
    /// `terrain` and disagreeing. Before Audit G-11 revenue lived only in
    /// the flat `terrain_base_value` bucket, which cannot express real 1830
    /// -- #62 and #64 share a terrain but print $90 and $50 -- so any UI
    /// that inferred a value from terrain was necessarily wrong for most
    /// city tiles, and a UI that hardcoded the real figures would have
    /// advertised payouts the contract would not honour. Shipping the
    /// authoritative number removes both failure modes.
    ///
    /// `0` for plain connector track, which is a real answer (that hex earns
    /// nothing), not a missing one.
    #[serde(default)]
    pub revenue: Uint128,
    /// `Some(city name)` if this tile sits on one of the three reserved
    /// landmark hexes (New York, Boston, Baltimore).
    pub landmark: Option<String>,
}

/// `QueryMsg::GetMapGrid`'s response. See that variant's doc comment.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MapGridResponse {
    pub game_id: u64,
    pub tiles: Vec<MapTileEntry>,
}

/// `QueryMsg::GetMapGridMarkdown`'s response. See that variant's doc
/// comment, and `query::print_markdown_map`'s, for what `markdown`
/// contains and why rendering it to an actual terminal is necessarily an
/// off-chain step.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MapGridMarkdownResponse {
    pub game_id: u64,
    pub markdown: String,
}

/// One legal `(tile_id, orientation)` pairing, part of
/// `LegalTilePlacementsResponse`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct LegalTilePlacement {
    pub tile_id: u32,
    pub orientation: u8,
}

/// `QueryMsg::GetLegalTilePlacements`'s response. See that variant's doc
/// comment for exactly which of `execute_lay_tile`'s rules are (and
/// aren't) checked here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct LegalTilePlacementsResponse {
    pub game_id: u64,
    pub protocol_id: u32,
    pub q: i32,
    pub r: i32,
    /// This hex's real 1830 board label -- see `MapTileEntry::hex_label`'s
    /// doc comment (Coordinate Symmetries).
    pub hex_label: String,
    pub placements: Vec<LegalTilePlacement>,
}

/// `QueryMsg::PlayerNetWorth`'s response -- see that variant's doc comment
/// for the exact cash-plus-live-stock-value formula. Deliberately just the
/// four aggregate figures ("a clean, aggregated payload," per the original
/// ask) rather than a per-company breakdown -- `QueryMsg::GetGameState`'s
/// existing `PublicCompanyState::player_holdings` already exposes each
/// company's raw percentage for any caller that wants the underlying
/// detail; this response is purpose-built for a single net-worth figure
/// (an endgame ranking, a live "liquid asset log" row) instead of
/// duplicating that registry.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PlayerNetWorthResponse {
    pub game_id: u64,
    pub player: Addr,
    /// Liquid, spendable VGP cash -- `state::PLAYER_CASH_VGP`.
    pub cash_vgp: Uint128,
    /// The live market value of every share certificate this player holds,
    /// summed across every public company: each company's held percentage
    /// converted to a certificate count, priced at that company's current
    /// `MARKET_GRID` cell.
    pub stock_portfolio_value: Uint128,
    /// Combined printed face value of every private company this player
    /// still personally owns and that has not `closed` (Audit G-3).
    ///
    /// A private owned by a CORPORATION (`PrivateCompanyState::owner_protocol_id`)
    /// rather than a player is not counted here -- that asset sits on the
    /// corporation's balance sheet, exactly as this response excludes
    /// company treasuries generally.
    pub private_company_value: Uint128,
    /// `cash_vgp + stock_portfolio_value + private_company_value` -- the
    /// authentic 1830 net worth figure, and the exact quantity
    /// `EndGameAndDistribute` divides the real-JUNO lobby pool against.
    pub net_worth: Uint128,
}

/// One standing bid on a private company, part of `WaterfallPrivateStatus`
/// and `WaterfallMiniAuctionStatus`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct WaterfallBidEntry {
    pub bidder: Addr,
    pub bid_amount: Uint128,
}

/// One still-unowned core private company's live Waterfall Auction status,
/// part of `WaterfallStateResponse`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct WaterfallPrivateStatus {
    pub private_id: u32,
    pub name: String,
    pub face_value: Uint128,
    /// `true` only for whichever private is currently the cheapest
    /// still-unowned one -- the only one `WaterfallBuyLowest` can target,
    /// and the only one that can never itself be bid on.
    pub is_lowest_offered: bool,
    /// Every standing bid currently escrowed on this private, in no
    /// particular order.
    pub bids: Vec<WaterfallBidEntry>,
}

/// The currently-in-progress mini-auction's live status (2+ tied bidders on
/// a single private, resolved separately from the main Waterfall turn
/// order), part of `WaterfallStateResponse`. `None` there whenever no
/// mini-auction is active.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct WaterfallMiniAuctionStatus {
    pub private_id: u32,
    /// The tied bidders, in the room's seating (turn) order.
    pub bidders: Vec<Addr>,
    /// Whose turn it currently is within `bidders` -- always someone other
    /// than `high_bidder`, whose own turns are auto-skipped.
    pub current_turn: Addr,
    pub high_bid: Uint128,
    pub high_bidder: Addr,
}

/// `QueryMsg::GetWaterfallState`'s response. See that variant's doc comment.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct WaterfallStateResponse {
    pub game_id: u64,
    /// `true` while the Pre-Game Waterfall Auction is still ongoing; once
    /// `false`, `game_id` has already transitioned into Stock Round 1 and
    /// the rest of this response's fields describe a settled, no-longer-
    /// changing snapshot.
    pub waterfall_auction_active: bool,
    /// Every still-unowned core private company, in ascending face-value
    /// order -- empty once all six have been won.
    pub privates: Vec<WaterfallPrivateStatus>,
    /// Whose turn it is in the main Waterfall Auction turn order. Note this
    /// stays fixed (not meaningfully actionable) while a mini-auction is in
    /// progress -- see `mini_auction` instead in that case.
    pub current_turn: Addr,
    /// `Some` only while a 2+-bidder mini-auction is currently resolving.
    pub mini_auction: Option<WaterfallMiniAuctionStatus>,
    /// How many consecutive `WaterfallPass` calls have occurred so far --
    /// reaching `player_addresses.len()` ends the auction early.
    pub consecutive_waterfall_passes: u32,
}
