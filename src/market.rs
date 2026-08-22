//! Stock-market grid mechanics. `MARKET_GRID` is a single shared board TEMPLATE,
//! identical for every room, exactly like a physical 18xx board's printed chart;
//! `PROTOCOL_MARKET` tracks each GAME's own marker on it, so two rooms both
//! running a PRR never clobber each other's price.
//!
//!   move_up     sold out, end of SR   move_right  Distribute Yield
//!   move_down   dumped shares         move_left   Slash/Retain Yield
//!
//! Design note #746c: `move_up` reads "sold-out bonus" no longer. It has ONE caller and ONE moment --
//! `apply_sold_out_price_rises`, from `conclude_stock_round`. The word "bonus" is what a per-purchase bump
//! would be, and there was one; in 1830 there is not.
//!
//! `x` is the column, `y` the row, and `y = MARKET_MAX_Y` is the TOP.
//!
//! THE CHART IS GENUINELY RAGGED (cliffside) -- 19 columns at its widest row,
//! narrowing to as few as 4 populated cells at the bottom -- not a uniform
//! rectangle. A blank coordinate simply has no `MARKET_GRID` entry and is treated
//! exactly like the rectangle's own edge.
//!
//! Verbatim real 1830 data, sourced from `tobymao/18xx`'s `g_1830/game.rb`
//! `MARKET` constant plus its zone legend, replacing an earlier invented linear
//! formula end to end.
//!
//! `GAME_END_PRICE_TRIGGER` ($350, the chart's highest cell) is THIS PROJECT'S
//! OWN EXPLICIT HOUSE RULE, not a transcription of engine behaviour -- the
//! verbatim array does not tag that cell, and the real rulebook's primary end
//! condition is the bank breaking. Enforced as requested, flagged here so it is
//! never mistaken for sourced behaviour.
//!
//! Every write to a marker stamps a fresh `arrival_sequence` -- a strictly
//! increasing per-room "who moved most recently" clock, used only to break
//! Operating Round order ties when two protocols land on the same price.
//!
//! See docs/ai_architecture/rust_contract_architecture.md, market.rs.

use cosmwasm_std::{StdResult, Storage, Uint128};
use thiserror::Error;

use crate::state::{
    MarketCell, ProtocolMarketState, ZoneType, BANK_POOL_SHARES, IPO_POOL_SHARES,
    MARKET_ARRIVAL_SEQUENCE, MARKET_GRID, PROTOCOL_MARKET, PUBLIC_COMPANIES,
};

/// Grid boundaries for the price chart, matching the real 1830 board's
/// widest row (19 columns) and full row count (11 rows). `(0, 0)` is the
/// bottom-left corner of that bounding rectangle -- most rows don't
/// actually extend the full width at every height (see this module's doc
/// comment on the ragged/cliffside shape); these constants only bound
/// where a marker is allowed to sit within the rectangle, not which cells
/// within it have actually been seeded with a price (see `MARKET_GRID` in
/// `state.rs`).
pub const MARKET_MIN_X: u32 = 0;
pub const MARKET_MAX_X: u32 = 18; // 19 columns, the real board's widest row
pub const MARKET_MIN_Y: u32 = 0;
pub const MARKET_MAX_Y: u32 = 10; // 11 rows, matching the real board

/// A protocol's market position before its first-ever par value is chosen
/// (`market::initialize_game_market`'s seed default, and
/// `gamelog::execute_undo_last_action`'s reset-to-default) -- pinned to the
/// real board's lowest par cell, $67 (`PAR_VALUE_LADDER`'s first entry),
/// the same cell `market::par_value_coords` resolves for a $67 par choice.
/// Purely a placeholder position: nothing prices a company off this cell
/// before its first IPO purchase pins a real par value (see
/// `trading::execute_buy_stock`'s `first_purchase_pin` handling, which
/// reads the chosen par cell directly rather than this default), and
/// `query::query_market_grid` gracefully reports `price: None` for any
/// company whose position somehow doesn't resolve to a seeded cell.
pub const DEFAULT_MARKET_POSITION: (u32, u32) = (6, 5);

/// The six standard 1830 par-value price points a company's president may
/// choose from the moment its very first IPO share is bought (see
/// `trading::execute_buy_stock`), each pinned to a fixed `MARKET_GRID` cell:
/// `(par_value, x, y)`. `seed_default_price_grid` overwrites these six
/// cells with these exact prices (redundantly with the general row data --
/// see that function's doc comment -- but explicit and authoritative
/// regardless), taking priority over the surrounding grid. Ordered lowest
/// to highest, at ascending `y` along column `x = 6` -- the real board's
/// par track is a *vertical* column (column index 6 in the verbatim
/// `MARKET` source array), not a horizontal row; see this module's doc
/// comment for the real-vs-invented-formula history.
pub const PAR_VALUE_LADDER: &[(u128, u32, u32)] = &[
    (67, 6, 5),
    (71, 6, 6),
    (76, 6, 7),
    (82, 6, 8),
    (90, 6, 9),
    (100, 6, 10),
];

/// The real 1830 board's single highest printed price -- the top-right
/// corner of the chart (column 18, row 0 in the verbatim `MARKET` source
/// array; `(x=18, y=10)` in this module's coordinate system). See this
/// module's doc comment for why the game-end behavior below is this
/// project's own explicit house rule, not verbatim engine behavior.
pub const GAME_END_PRICE_TRIGGER: u128 = 350;

/// True once `cell`'s price has reached (defensively, `>=` rather than
/// `==`) `GAME_END_PRICE_TRIGGER` -- the $350 Game-End Trigger. Checked by
/// every caller that applies an ascending market movement
/// (`apply_sold_out_price_rises` at the end of a Stock Round -- design note
/// #746c removed `execute_buy_stock`'s, which listed here and should not have,
/// `trading::execute_declare_dividends`'s Distribute Yield,
/// `operations::execute_operating_round`'s Distribute Yield) immediately
/// after the movement resolves, so the instant a marker lands on the $350
/// cell the room closes out -- see `contract::finalize_and_distribute_payouts`.
/// Descending movements (Slash/Retain Yield, dumped shares) never need this
/// check: they can only move a marker away from $350, never onto it.
pub fn price_triggers_game_end(cell: &MarketCell) -> bool {
    cell.price >= Uint128::new(GAME_END_PRICE_TRIGGER)
}

/// Returns the fixed `MARKET_GRID` coordinates for `par_value`, if it's one
/// of the six standard `PAR_VALUE_LADDER` par prices.
pub fn par_value_coords(par_value: Uint128) -> Option<(u32, u32)> {
    PAR_VALUE_LADDER
        .iter()
        .find(|(value, _, _)| Uint128::new(*value) == par_value)
        .map(|(_, x, y)| (*x, *y))
}

#[derive(Error, Debug)]
pub enum MarketError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),

    #[error("Protocol {protocol_id} has no market position recorded in game room {game_id}")]
    ProtocolNotFound { game_id: u64, protocol_id: u32 },

    #[error("No market cell is defined at grid position ({x}, {y})")]
    MarketCellNotFound { x: u32, y: u32 },
}

/// Direction of a single market-price movement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketMovement {
    /// Sold-out round bonus: marker moves up one row.
    Up,
    /// Dumped shares: marker moves down one row.
    Down,
    /// Distribute Yield (paid dividend): marker moves right one column.
    Right,
    /// Slash/Retain Yield (withheld dividend): marker moves left one column.
    Left,
}

/// The exact result of one movement, so callers can distinguish the three
/// genuinely different things that can happen at a boundary, which a plain cell
/// return collapses into one: a clean move; a DEFLECTION (a Cliff), where the
/// requested direction was blocked and the marker travelled the 1830-mandated
/// substitute instead; or no movement at all (a Ledge, the Ceiling, or a Cliff
/// whose own deflection target is off the printed chart too).
#[derive(Clone, Debug, PartialEq)]
pub struct MarketMoveOutcome {
    /// The cell the marker is standing on once this movement resolves --
    /// unchanged from where it started if nothing moved.
    pub cell: MarketCell,
    /// Where the marker stood before this movement was attempted.
    pub from_x: u32,
    pub from_y: u32,
    /// The movement the caller asked for.
    pub requested: MarketMovement,
    /// The movement actually travelled, or `None` if the marker held station.
    pub applied: Option<MarketMovement>,
    /// True only when a Cliff redirected the marker: `applied` is `Some` and
    /// differs from `requested`.
    pub deflected: bool,
}

impl MarketMoveOutcome {
    /// True when the marker actually changed cells.
    pub fn moved(&self) -> bool {
        self.applied.is_some()
    }
}

/// One step in `movement`'s direction from `(x, y)`, or `None` if that step
/// would leave the bounding rectangle entirely. Pure coordinate arithmetic:
/// says nothing about whether the resulting cell is actually *printed* on the
/// ragged chart -- that is `MARKET_GRID`'s business, checked separately by
/// `resolve_movement` below.
fn step_coordinates(x: u32, y: u32, movement: MarketMovement) -> Option<(u32, u32)> {
    match movement {
        // Top Ceiling: nothing above the chart's highest row.
        MarketMovement::Up => {
            if y < MARKET_MAX_Y {
                Some((x, y + 1))
            } else {
                None
            }
        }
        // Bottom Ledge: nothing below the chart's lowest row.
        MarketMovement::Down => {
            if y > MARKET_MIN_Y {
                Some((x, y - 1))
            } else {
                None
            }
        }
        MarketMovement::Right => {
            if x < MARKET_MAX_X {
                Some((x + 1, y))
            } else {
                None
            }
        }
        MarketMovement::Left => {
            if x > MARKET_MIN_X {
                Some((x - 1, y))
            } else {
                None
            }
        }
    }
}

/// The Cliffs and Ledges rule table, in one place. Given a movement that cannot
/// be travelled -- off the rectangle, or onto one of the chart's blank
/// coordinates -- returns the substitute direction 1830 says the marker takes, or
/// `None` if it simply holds station.
///
///   RIGHT CLIFF -> UP    a Distribute Yield off the right end of its row lifts
///                        the marker one row. This is the chart's ONLY way to
///                        climb past a short row into the wider rows above, and
///                        without it a company parked on a row's last cell could
///                        never reach $350 at all.
///   LEFT CLIFF -> DOWN   a Slash/Retain off the left end drops it one row. The
///                        rows get shorter toward the bottom and their blanks are
///                        all at the low-`x` end, so this is the staircase a
///                        repeatedly-withholding company walks down.
///   BOTTOM LEDGE         refused, no deflection. The board's bottom edge is a
///                        ledge, not a cliff.
///   TOP CEILING          refused. Nothing goes above $350.
///
/// Deflection is deliberately NOT RECURSIVE: if the substitute is itself blocked
/// the marker holds station rather than chaining into a third direction. Real
/// 1830 never chains deflections, and a recursive rule on a ragged chart could
/// walk a marker an unbounded distance from one dividend.
fn deflection_for(movement: MarketMovement) -> Option<MarketMovement> {
    match movement {
        MarketMovement::Right => Some(MarketMovement::Up),
        MarketMovement::Left => Some(MarketMovement::Down),
        MarketMovement::Up | MarketMovement::Down => None,
    }
}

/// Resolves where a marker at `(x, y)` ends up when asked to travel
/// `movement`, applying `deflection_for`'s Cliff/Ledge table. Returns the
/// destination plus the direction actually travelled (`None` = held station).
/// Read-only -- every write happens in `apply_market_movement_detailed`.
fn resolve_movement(
    storage: &dyn Storage,
    x: u32,
    y: u32,
    movement: MarketMovement,
) -> StdResult<((u32, u32), Option<MarketMovement>)> {
    // A candidate is travelable only if it is inside the bounding rectangle
    // AND actually printed on the ragged chart.
    let travelable = |candidate: Option<(u32, u32)>| -> StdResult<Option<(u32, u32)>> {
        match candidate {
            Some((cx, cy)) => Ok(MARKET_GRID.may_load(storage, (cx, cy))?.map(|_| (cx, cy))),
            None => Ok(None),
        }
    };

    if let Some(destination) = travelable(step_coordinates(x, y, movement))? {
        return Ok((destination, Some(movement)));
    }

    if let Some(deflected) = deflection_for(movement) {
        if let Some(destination) = travelable(step_coordinates(x, y, deflected))? {
            return Ok((destination, Some(deflected)));
        }
    }

    Ok(((x, y), None))
}

/// Hands out the next `MARKET_ARRIVAL_SEQUENCE` value for `game_id`,
/// treating an unseeded counter as `0` (so the first-ever stamp in a room is
/// `1`), and persists the incremented counter. Called every time a
/// protocol's `PROTOCOL_MARKET` position is actually written, so
/// `ProtocolMarketState::arrival_sequence` always reflects "how recently,
/// relative to every other marker movement in this room, did this protocol
/// last arrive somewhere" -- see that field's doc comment and
/// `operations::calculate_operating_order`'s tie-break rule.
fn next_arrival_sequence(storage: &mut dyn Storage, game_id: u64) -> StdResult<u64> {
    let next = MARKET_ARRIVAL_SEQUENCE
        .may_load(storage, game_id)?
        .unwrap_or(0)
        .wrapping_add(1);
    MARKET_ARRIVAL_SEQUENCE.save(storage, game_id, &next)?;
    Ok(next)
}

/// Applies one movement to `game_id`'s `protocol_id` marker, honouring the real
/// board's Cliff/Ledge geometry, then persists and returns the landed cell.
///
/// This previously treated all four edges identically -- any blocked movement
/// saturated in place. That is right for the two vertical directions and wrong
/// for the two horizontal ones, and the consequence was not cosmetic: A COMPANY
/// PARKED ON THE LAST PRINTED CELL OF A SHORT ROW COULD PAY DIVIDENDS FOREVER
/// AND ITS PRICE WOULD NEVER MOVE, so it could never climb into the wider rows
/// above and could never reach the $350 trigger at all.
///
/// `MarketCellNotFound` remains unreachable from an ordinary movement -- every
/// resolved destination is either a real seeded cell or the marker's own already
/// valid position. Errors only if this protocol has no recorded position at all.
pub fn apply_market_movement(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
    movement: MarketMovement,
) -> Result<MarketCell, MarketError> {
    apply_market_movement_detailed(storage, game_id, protocol_id, movement)
        .map(|outcome| outcome.cell)
}

/// `apply_market_movement`, but reporting the full `MarketMoveOutcome` --
/// which direction was actually travelled, and whether a Cliff deflected it.
/// This is the real implementation; `apply_market_movement` is the thin
/// "I only care where it landed" wrapper over it, which is what every
/// pre-existing call site in `trading.rs`/`operations.rs` wants.
///
/// **Step 4.5 Batch 1, item 5.** Movement resolution is entirely delegated to
/// `resolve_movement`/`deflection_for` -- see that pair for the Right Cliff,
/// Left Cliff, Bottom Ledge and Top Ceiling rules and why deflection never
/// chains. This function's own job is only the storage side: read the
/// marker, ask where it goes, write it back.
///
/// `arrival_sequence` is re-stamped on EVERY call, including a call that
/// resolves to no movement at all. That is intentional and pre-dates this
/// change: the counter answers "which marker was touched most recently" for
/// `operations::calculate_operating_order`'s tie-break, and a company that
/// paid a dividend into a Ledge has still acted this round.
pub fn apply_market_movement_detailed(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
    movement: MarketMovement,
) -> Result<MarketMoveOutcome, MarketError> {
    let mut position: ProtocolMarketState = PROTOCOL_MARKET
        .may_load(storage, (game_id, protocol_id))?
        .ok_or(MarketError::ProtocolNotFound {
            game_id,
            protocol_id,
        })?;

    let from_x = position.current_x;
    let from_y = position.current_y;

    let ((new_x, new_y), applied) = resolve_movement(storage, from_x, from_y, movement)?;

    let cell = MARKET_GRID
        .may_load(storage, (new_x, new_y))?
        .ok_or(MarketError::MarketCellNotFound { x: new_x, y: new_y })?;

    position.current_x = new_x;
    position.current_y = new_y;
    position.arrival_sequence = next_arrival_sequence(storage, game_id)?;
    PROTOCOL_MARKET.save(storage, (game_id, protocol_id), &position)?;

    Ok(MarketMoveOutcome {
        cell,
        from_x,
        from_y,
        requested: movement,
        applied,
        deflected: matches!(applied, Some(actual) if actual != movement),
    })
}

/// Sold-out round bonus: moves `game_id`'s protocol price marker up one
/// row, saturating at `MARKET_MAX_Y`.
pub fn move_up(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<MarketCell, MarketError> {
    apply_market_movement(storage, game_id, protocol_id, MarketMovement::Up)
}

/// Dumped shares: moves `game_id`'s protocol price marker down one row,
/// saturating at `MARKET_MIN_Y`.
pub fn move_down(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<MarketCell, MarketError> {
    apply_market_movement(storage, game_id, protocol_id, MarketMovement::Down)
}

/// Paid dividend (Distribute Yield): moves `game_id`'s protocol price
/// marker right one column, saturating at `MARKET_MAX_X`.
pub fn move_right(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<MarketCell, MarketError> {
    apply_market_movement(storage, game_id, protocol_id, MarketMovement::Right)
}

/// Withheld revenue (Slash/Retain Yield): moves `game_id`'s protocol price
/// marker left one column, saturating at `MARKET_MIN_X`.
pub fn move_left(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<MarketCell, MarketError> {
    apply_market_movement(storage, game_id, protocol_id, MarketMovement::Left)
}

/// Loads `game_id`'s `protocol_id` current market position, initializing it
/// to `(default_x, default_y)` -- clamped to the grid bounds -- the first
/// time this game's protocol is referenced. Idempotent: once a position is
/// recorded, later calls just return it unchanged. Callers (e.g.
/// `trading.rs`) should invoke this before the first trade against a
/// protocol so `current_cell` and the `move_*` functions always have a
/// position to work from.
pub fn ensure_protocol_position(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
    default_x: u32,
    default_y: u32,
) -> Result<ProtocolMarketState, MarketError> {
    if let Some(position) = PROTOCOL_MARKET.may_load(storage, (game_id, protocol_id))? {
        return Ok(position);
    }

    let position = ProtocolMarketState {
        protocol_id,
        current_x: default_x.clamp(MARKET_MIN_X, MARKET_MAX_X),
        current_y: default_y.clamp(MARKET_MIN_Y, MARKET_MAX_Y),
        arrival_sequence: next_arrival_sequence(storage, game_id)?,
    };
    PROTOCOL_MARKET.save(storage, (game_id, protocol_id), &position)?;
    Ok(position)
}

/// Unconditionally overwrites `game_id`'s `protocol_id` market position to
/// `(x, y)`, regardless of whether one is already recorded -- unlike
/// `ensure_protocol_position`, which only ever sets a *default* the first
/// time a game's protocol is referenced and otherwise leaves an existing
/// position untouched. Used by `trading::execute_buy_stock` to pin a
/// protocol's price marker to its chosen Par Value cell the instant that
/// par value is first selected.
pub fn set_protocol_position(
    storage: &mut dyn Storage,
    game_id: u64,
    protocol_id: u32,
    x: u32,
    y: u32,
) -> Result<ProtocolMarketState, MarketError> {
    let position = ProtocolMarketState {
        protocol_id,
        current_x: x.clamp(MARKET_MIN_X, MARKET_MAX_X),
        current_y: y.clamp(MARKET_MIN_Y, MARKET_MAX_Y),
        arrival_sequence: next_arrival_sequence(storage, game_id)?,
    };
    PROTOCOL_MARKET.save(storage, (game_id, protocol_id), &position)?;
    Ok(position)
}

/// Returns the `MarketCell` at `game_id`'s `protocol_id` current market
/// position. Errors if this game's protocol has no recorded position yet
/// (call `ensure_protocol_position` first) or if that cell hasn't been
/// seeded with a price in `MARKET_GRID`.
pub fn current_cell(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<MarketCell, MarketError> {
    let position = PROTOCOL_MARKET
        .may_load(storage, (game_id, protocol_id))?
        .ok_or(MarketError::ProtocolNotFound {
            game_id,
            protocol_id,
        })?;

    MARKET_GRID
        .may_load(storage, (position.current_x, position.current_y))?
        .ok_or(MarketError::MarketCellNotFound {
            x: position.current_x,
            y: position.current_y,
        })
}

/// Initializes a fresh game room's own, independent set of protocol market
/// positions -- one `ProtocolMarketState` per id in `company_ids`, each
/// defaulting to `DEFAULT_MARKET_POSITION` (the lowest `PAR_VALUE_LADDER`
/// cell, $67) -- so `game_id`'s companies start on their own game-scoped
/// price track from the moment the room exists, never sharing or being
/// clobbered by any other room's markers for the same `protocol_id`. Called
/// once, when a game room is created (see `contract::execute_create_game_room`).
/// Uses `ensure_protocol_position`, so it's idempotent and safe even if a
/// protocol somehow already has a position recorded for this game.
pub fn initialize_game_market(
    storage: &mut dyn Storage,
    game_id: u64,
    company_ids: &[u32],
) -> Result<(), MarketError> {
    let (default_x, default_y) = DEFAULT_MARKET_POSITION;
    for &company_id in company_ids {
        ensure_protocol_position(storage, game_id, company_id, default_x, default_y)?;
    }
    Ok(())
}

/// The 100%-Sold-Out end-of-Stock-Round rise: every FLOATED company whose IPO and
/// Bank pools are both empty advances one cell up. Returns each evaluated
/// company and its landed cell so the caller can attribute the movement and check
/// the price against the game-end trigger.
///
/// CALLED EXACTLY ONCE PER STOCK ROUND, from `conclude_stock_round`. That single
/// call site is what makes this an end-of-round bonus rather than a per-purchase
/// one, and is why it must never be invoked speculatively: two calls in one round
/// would double-raise every sold-out company.
///
/// DESIGN NOTE 746c: THIS IS THE ONLY TRIGGER. The paragraph that stood here said it "coexists with the
/// per-purchase sold-out bonus in `execute_buy_stock` -- a different trigger with different timing, and both
/// exist in the real game, so a corporation that goes sold out mid-round and stays that way is legitimately
/// raised twice." That was wrong, and confidently enough written to be quoted downstream as a citation.
///
/// REPORTED: "A corporation's share price only rises, and only rises once, at the end of a stock round when
/// all of its shares are in the hands of players, period."
///
/// The per-purchase block in `execute_buy_stock` is deleted. The sentence below about the single call site was
/// always the correct account of the rule; the other trigger simply sat in another file and contradicted it.
///
/// `is_floated` is required because an unfloated corporation has never sold a
/// share, so its IPO pool is untouched -- and an unwritten entry defaults to FULL
/// (100), not 0, which is exactly why `full_pool_percentage` is threaded in as a
/// parameter rather than letting an absent entry read as zero.
///
/// COORDINATE NOTE: the request was phrased as "move up 1 cell (`y - 1`)", the
/// convention of a chart indexed from its top row downward. This module has
/// always used the opposite -- `y = MARKET_MAX_Y` is the TOP -- so "up one" is
/// `y + 1` here. Both describe the identical physical movement, and this goes
/// through `move_up` so there is exactly one definition of which way is up.
pub fn apply_sold_out_price_rises(
    storage: &mut dyn Storage,
    game_id: u64,
    company_ids: &[u32],
    full_pool_percentage: u8,
) -> Result<Vec<(u32, MarketCell)>, MarketError> {
    let mut risen = Vec::new();

    for &company_id in company_ids {
        // Never floated (or not a company in this room at all): it has no
        // shares in player hands to be sold out of.
        let is_floated = PUBLIC_COMPANIES
            .may_load(storage, (game_id, company_id))?
            .map(|company| company.is_floated)
            .unwrap_or(false);
        if !is_floated {
            continue;
        }

        let ipo_pct = IPO_POOL_SHARES
            .may_load(storage, (game_id, company_id))?
            .unwrap_or(full_pool_percentage);
        let bank_pct = BANK_POOL_SHARES
            .may_load(storage, (game_id, company_id))?
            .unwrap_or(0);

        if ipo_pct != 0 || bank_pct != 0 {
            continue;
        }

        let cell = move_up(storage, game_id, company_id)?;
        risen.push((company_id, cell));
    }

    Ok(risen)
}

/// One real 1830 price cell's data, as printed on the physical board:
/// `(price, zone)`. Used only to author `REAL_MARKET_ROWS` below in a
/// compact, per-row form.
type RealCell = (u128, ZoneType);

/// The authentic 1830 stock-market chart, row by row, sourced verbatim from
/// the open-source `tobymao/18xx` engine's `MARKET` constant
/// (`lib/engine/game/g_1830/game.rb`) -- see this module's doc comment for
/// the full sourcing note and cross-check method. Each tuple is `(y,
/// start_x, cells)`: `y` is this module's row coordinate (the verbatim
/// source's row 0 -- its highest-priced row, printed at the *top* of the
/// physical board -- maps to `y = MARKET_MAX_Y`, its lowest-priced row
/// maps to `y = MARKET_MIN_Y`, keeping this module's existing "price
/// generally increases moving up" convention true of the real chart too);
/// `start_x` is the column the row's first populated cell sits at (every
/// row's *blank* cells, where any, are at its low-`x` end -- the real
/// board's cliffside is bottom-left, not interior gaps); `cells` is that
/// row's populated prices left to right, each tagged with its real
/// `ZoneType` per the verbatim source's letter suffix (`y`=Yellow,
/// `o`=Orange, `b`=Brown, `p`=par/no letter=Normal -- `p`-tagged cells are
/// encoded here as plain `Normal` since `PAR_VALUE_LADDER`'s own overwrite
/// pass below is the authoritative par marker; the plain price already
/// matches, so this is redundant, not conflicting).
const REAL_MARKET_ROWS: &[(u32, u32, &[RealCell])] = &[
    (
        10,
        0,
        &[
            (60, ZoneType::YellowZone),
            (67, ZoneType::Normal),
            (71, ZoneType::Normal),
            (76, ZoneType::Normal),
            (82, ZoneType::Normal),
            (90, ZoneType::Normal),
            (100, ZoneType::Normal), // par
            (112, ZoneType::Normal),
            (126, ZoneType::Normal),
            (142, ZoneType::Normal),
            (160, ZoneType::Normal),
            (180, ZoneType::Normal),
            (200, ZoneType::Normal),
            (225, ZoneType::Normal),
            (250, ZoneType::Normal),
            (275, ZoneType::Normal),
            (300, ZoneType::Normal),
            (325, ZoneType::Normal),
            (350, ZoneType::Normal), // GAME_END_PRICE_TRIGGER
        ],
    ),
    (
        9,
        0,
        &[
            (53, ZoneType::YellowZone),
            (60, ZoneType::YellowZone),
            (66, ZoneType::Normal),
            (70, ZoneType::Normal),
            (76, ZoneType::Normal),
            (82, ZoneType::Normal),
            (90, ZoneType::Normal), // par
            (100, ZoneType::Normal),
            (112, ZoneType::Normal),
            (126, ZoneType::Normal),
            (142, ZoneType::Normal),
            (160, ZoneType::Normal),
            (180, ZoneType::Normal),
            (200, ZoneType::Normal),
            (220, ZoneType::Normal),
            (240, ZoneType::Normal),
            (260, ZoneType::Normal),
            (280, ZoneType::Normal),
            (300, ZoneType::Normal),
        ],
    ),
    (
        8,
        0,
        &[
            (46, ZoneType::YellowZone),
            (55, ZoneType::YellowZone),
            (60, ZoneType::YellowZone),
            (65, ZoneType::Normal),
            (70, ZoneType::Normal),
            (76, ZoneType::Normal),
            (82, ZoneType::Normal), // par
            (90, ZoneType::Normal),
            (100, ZoneType::Normal),
            (111, ZoneType::Normal),
            (125, ZoneType::Normal),
            (140, ZoneType::Normal),
            (155, ZoneType::Normal),
            (170, ZoneType::Normal),
            (185, ZoneType::Normal),
            (200, ZoneType::Normal),
        ],
    ),
    (
        7,
        0,
        &[
            (39, ZoneType::OrangeZone),
            (48, ZoneType::YellowZone),
            (54, ZoneType::YellowZone),
            (60, ZoneType::YellowZone),
            (66, ZoneType::Normal),
            (71, ZoneType::Normal),
            (76, ZoneType::Normal), // par
            (82, ZoneType::Normal),
            (90, ZoneType::Normal),
            (100, ZoneType::Normal),
            (110, ZoneType::Normal),
            (120, ZoneType::Normal),
            (130, ZoneType::Normal),
        ],
    ),
    (
        6,
        0,
        &[
            (32, ZoneType::OrangeZone),
            (41, ZoneType::OrangeZone),
            (48, ZoneType::YellowZone),
            (55, ZoneType::YellowZone),
            (62, ZoneType::Normal),
            (67, ZoneType::Normal),
            (71, ZoneType::Normal), // par
            (76, ZoneType::Normal),
            (82, ZoneType::Normal),
            (90, ZoneType::Normal),
            (100, ZoneType::Normal),
        ],
    ),
    (
        5,
        0,
        &[
            (25, ZoneType::BrownZone),
            (34, ZoneType::OrangeZone),
            (42, ZoneType::OrangeZone),
            (50, ZoneType::YellowZone),
            (58, ZoneType::YellowZone),
            (65, ZoneType::Normal),
            (67, ZoneType::Normal), // par
            (71, ZoneType::Normal),
            (75, ZoneType::Normal),
            (80, ZoneType::Normal),
        ],
    ),
    (
        4,
        0,
        &[
            (18, ZoneType::BrownZone),
            (27, ZoneType::BrownZone),
            (36, ZoneType::OrangeZone),
            (45, ZoneType::OrangeZone),
            (54, ZoneType::YellowZone),
            (63, ZoneType::Normal),
            (67, ZoneType::Normal),
            (69, ZoneType::Normal),
            (70, ZoneType::Normal),
        ],
    ),
    (
        3,
        0,
        &[
            (10, ZoneType::BrownZone),
            (20, ZoneType::BrownZone),
            (30, ZoneType::BrownZone),
            (40, ZoneType::OrangeZone),
            (50, ZoneType::YellowZone),
            (60, ZoneType::YellowZone),
            (67, ZoneType::Normal),
            (68, ZoneType::Normal),
        ],
    ),
    (
        2,
        1,
        &[
            (10, ZoneType::BrownZone),
            (20, ZoneType::BrownZone),
            (30, ZoneType::BrownZone),
            (40, ZoneType::OrangeZone),
            (50, ZoneType::YellowZone),
            (60, ZoneType::YellowZone),
        ],
    ),
    (
        1,
        2,
        &[
            (10, ZoneType::BrownZone),
            (20, ZoneType::BrownZone),
            (30, ZoneType::BrownZone),
            (40, ZoneType::OrangeZone),
            (50, ZoneType::YellowZone),
        ],
    ),
    (
        0,
        3,
        &[
            (10, ZoneType::BrownZone),
            (20, ZoneType::BrownZone),
            (30, ZoneType::BrownZone),
            (40, ZoneType::OrangeZone),
        ],
    ),
];

/// Seeds `MARKET_GRID` with the authentic 1830 chart, so a movement always has a
/// real cell to land on -- or, at the ragged edges, a well-defined "stay put".
/// Nothing previously populated this map, so every price movement would have
/// failed the first time it ran.
///
/// The grid is the shared board TEMPLATE, intentionally global rather than
/// game-scoped, so this runs once at `instantiate` rather than per room.
///
/// Only cells the real chart prints are written -- the surrounding rectangle is
/// NOT filled with placeholders, so the board's blank cells stay genuinely
/// unseeded.
pub fn seed_default_price_grid(storage: &mut dyn Storage) -> StdResult<()> {
    for &(y, start_x, cells) in REAL_MARKET_ROWS {
        for (offset, &(price, zone_type)) in cells.iter().enumerate() {
            let x = start_x + offset as u32;
            let cell = MarketCell {
                x,
                y,
                price: Uint128::new(price),
                zone_type,
            };
            MARKET_GRID.save(storage, (x, y), &cell)?;
        }
    }

    // Overwrite the six `PAR_VALUE_LADDER` cells with their exact standard
    // 1830 par prices, explicit and authoritative regardless of the row
    // data above (which already carries the same plain price at each of
    // these six coordinates -- see `PAR_VALUE_LADDER`'s own doc comment).
    for (value, x, y) in PAR_VALUE_LADDER.iter().copied() {
        let cell = MarketCell {
            x,
            y,
            price: Uint128::new(value),
            zone_type: ZoneType::Normal,
        };
        MARKET_GRID.save(storage, (x, y), &cell)?;
    }

    Ok(())
}
