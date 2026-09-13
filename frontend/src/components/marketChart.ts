// frontend/src/components/marketChart.ts
//
// The stock market chart as DATA: the board rows, the par ladder, the cell grid, and which chart is in
// effect. No React here -- `StockMarketRenderer.tsx` draws it and re-exports what it always exported;
// `boardSelection.ts` switches it per table, the way it switches the hex board (#1300).
//
/* ==================================================================
    DESIGN NOTE 1435: DYNAMIC MARKET GETS A ROW ABOVE THE TOP
   ==================================================================
   RULED: "for the Dynamic Markets variant, let's add another row to the top of the Stock Market matrix.
   Do not change the par values, this row simply sits there to absorb Dynamic Markets' extra effects. The
   row would run: $67 → $71 → $76 → $82 → $90 → $100 → $112 → $124 → $138 → $155 → $175 → $200 → $225 →
   $250 → $275 → $300 → $350 → $400 → $450" (or, alternatively, stop at $400).
   NINETEEN CELLS, ONE PER COLUMN, so the row is as wide as the top row under it and every ledge on that
   row now has a cell to turn UP into -- which is the point: under Dynamic Market a token that would sit
   pinned at $350 has somewhere to go. Stopping at $400 would leave column 18 empty, so a $350 token
   (column 18) would stay pinned while its $325 neighbour rose -- the wrong token stuck -- so the row runs
   to $450. All Normal zone; the par ladder is untouched (its six cells are x=6, y=5..10, and the new row
   is y=11). NOT ON THE STANDARD CHART: `chartFor(variants)` in `boardSelection.ts` picks it only when
   `dynamicStockMarket` is on, so a standard table's chart is byte-for-byte the 18xx.games board still.
   APPENDED AFTER THE STANDARD ROWS IN `PRICE_GRID`, not before: `marketCellForPrice` returns the FIRST
   cell with a price (#415 records why that is dangerous), and every one of these values already appears
   on the standard rows. Putting the new row first would have re-homed every fixture token onto it. */

import type { GameVariants } from "../utils/gameVariants";

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Mirrors `state::ZoneType` exactly -- see design note #3 for the
 *  cumulative-semantics caveat. */
export type ZoneType = "Normal" | "Yellow" | "Orange" | "Brown";

/** One real price cell: `[price, zoneType]`. Index `i` within a row's
 *  `cells` array corresponds to board column `startX + i`. */
type RealCell = readonly [number, ZoneType];

interface RealMarketRow {
  y: number;
  startX: number;
  cells: readonly RealCell[];
}

/** The authentic 1830 board, sourced verbatim from the 18xx.games engine's `g_1830/game.rb`
 *  `MARKET` constant and mirrored byte-for-byte by `market::REAL_MARKET_ROWS`. `y` counts UP from
 *  the bottom (`y = 10` is the top row / Ruby index 0). The six par cells are tagged `Normal`;
 *  `PAR_VALUE_LADDER` is authoritative for their coordinates. See design note #1. */
export const REAL_MARKET_ROWS: readonly RealMarketRow[] = [
  {
    y: 10,
    startX: 0,
    cells: [
      [60, "Yellow"], [67, "Normal"], [71, "Normal"], [76, "Normal"], [82, "Normal"],
      [90, "Normal"], [100, "Normal"], [112, "Normal"], [126, "Normal"], [142, "Normal"],
      [160, "Normal"], [180, "Normal"], [200, "Normal"], [225, "Normal"], [250, "Normal"],
      [275, "Normal"], [300, "Normal"], [325, "Normal"], [350, "Normal"],
    ],
  },
  {
    y: 9,
    startX: 0,
    cells: [
      [53, "Yellow"], [60, "Yellow"], [66, "Normal"], [70, "Normal"], [76, "Normal"],
      [82, "Normal"], [90, "Normal"], [100, "Normal"], [112, "Normal"], [126, "Normal"],
      [142, "Normal"], [160, "Normal"], [180, "Normal"], [200, "Normal"], [220, "Normal"],
      [240, "Normal"], [260, "Normal"], [280, "Normal"], [300, "Normal"],
    ],
  },
  {
    y: 8,
    startX: 0,
    cells: [
      [46, "Yellow"], [55, "Yellow"], [60, "Yellow"], [65, "Normal"], [70, "Normal"],
      [76, "Normal"], [82, "Normal"], [90, "Normal"], [100, "Normal"], [111, "Normal"],
      [125, "Normal"], [140, "Normal"], [155, "Normal"], [170, "Normal"], [185, "Normal"],
      [200, "Normal"],
    ],
  },
  {
    y: 7,
    startX: 0,
    cells: [
      [39, "Orange"], [48, "Yellow"], [54, "Yellow"], [60, "Yellow"], [66, "Normal"],
      [71, "Normal"], [76, "Normal"], [82, "Normal"], [90, "Normal"], [100, "Normal"],
      [110, "Normal"], [120, "Normal"], [130, "Normal"],
    ],
  },
  {
    y: 6,
    startX: 0,
    cells: [
      [32, "Orange"], [41, "Orange"], [48, "Yellow"], [55, "Yellow"], [62, "Normal"],
      [67, "Normal"], [71, "Normal"], [76, "Normal"], [82, "Normal"], [90, "Normal"],
      [100, "Normal"],
    ],
  },
  {
    y: 5,
    startX: 0,
    cells: [
      [25, "Brown"], [34, "Orange"], [42, "Orange"], [50, "Yellow"], [58, "Yellow"],
      [65, "Normal"], [67, "Normal"], [71, "Normal"], [75, "Normal"], [80, "Normal"],
    ],
  },
  {
    y: 4,
    startX: 0,
    cells: [
      [18, "Brown"], [27, "Brown"], [36, "Orange"], [45, "Orange"], [54, "Yellow"],
      [63, "Normal"], [67, "Normal"], [69, "Normal"], [70, "Normal"],
    ],
  },
  {
    y: 3,
    startX: 0,
    cells: [
      [10, "Brown"], [20, "Brown"], [30, "Brown"], [40, "Orange"], [50, "Yellow"],
      [60, "Yellow"], [67, "Normal"], [68, "Normal"],
    ],
  },
  {
    y: 2,
    startX: 1,
    cells: [
      [10, "Brown"], [20, "Brown"], [30, "Brown"], [40, "Orange"], [50, "Yellow"], [60, "Yellow"],
    ],
  },
  {
    y: 1,
    startX: 2,
    cells: [
      [10, "Brown"], [20, "Brown"], [30, "Brown"], [40, "Orange"], [50, "Yellow"],
    ],
  },
  {
    y: 0,
    startX: 3,
    cells: [
      [10, "Brown"], [20, "Brown"], [30, "Brown"], [40, "Orange"],
    ],
  },
];

/** The widest real row spans columns 0-18 -- sizes the CSS grid's track count only. An occupant
 *  past this still renders via an implicit track (design note #1). */
export const REAL_BOARD_COLUMNS = 19;

/* Design note #652: $350 is a CEILING, not a game end. The always-false `isGameEndCell` flag and
   its whole apparatus are removed; `GameOverModal`'s `GameEndReason` is what ends the game here.
   Still owed: `market.rs`'s `GAME_END_PRICE_TRIGGER` / `price_triggers_game_end` (backend audit). */

/* `isRealMarketCell` deleted -- design note #43a moved the question inside `buildPriceGrid`.
   `cellAt` is the live way to ask, and it returns the cell rather than just a boolean. */

/** Mirrors `market::PAR_VALUE_LADDER` exactly: `(price, x, y)`, the six
 *  standard 1830 par prices, now at their true real-board coordinates
 *  (a vertical column at `x=6`, spanning `y=5..10`) -- see design note #4.
 */
export const PAR_VALUE_LADDER: ReadonlyArray<{ price: number; x: number; y: number }> = [
  { price: 67, x: 6, y: 5 },
  { price: 71, x: 6, y: 6 },
  { price: 76, x: 6, y: 7 },
  { price: 82, x: 6, y: 8 },
  { price: 90, x: 6, y: 9 },
  { price: 100, x: 6, y: 10 },
];

/* Design note #651: the par ladder's three coordinate constants went with the overlay they
   positioned (#650). The six cells are found by `cell.isParValueLadder` instead. */

// Design note #20: the column-6 hard-block is gone. `NORMAL_CELL_BACKGROUND`/`styles.priceText`
// serve the same role by `zoneType` alone, so the real Yellow/Orange `x = 6` cells colour again.

const PAR_VALUE_LADDER_BY_CELL: ReadonlyMap<string, number> = new Map(
  PAR_VALUE_LADDER.map((entry) => [cellKey(entry.x, entry.y), entry.price]),
);

export interface PriceCell {
  x: number;
  y: number;
  price: number;
  zoneType: ZoneType;
  isParValueLadder: boolean;
  /** Design note #43: the leftmost cell of its row -- a LEFT CLIFF. A price
   *  here that would move left moves DOWN instead. */
  isLeftCliff: boolean;
  /** The rightmost cell of its row -- a RIGHT CLIFF. A price here that
   *  would move right moves UP instead. */
  isRightCliff: boolean;
}

/** Walks `REAL_MARKET_ROWS` cell by cell -- no rectangular loop, no formula -- overlaying the six
 *  `PAR_VALUE_LADDER` prices. Ordered `y = 10` first so the array reads top-to-bottom as it renders. */
function buildPriceGrid(rows: readonly RealMarketRow[]): PriceCell[] {
  const cells: PriceCell[] = [];
  // Design note #43a: which coordinates exist at all, so a cliff can ask
  // whether the cell it would be pushed INTO is on the board.
  const occupied = new Set<string>();
  for (const row of rows) {
    row.cells.forEach((_, index) => occupied.add(cellKey(row.startX + index, row.y)));
  }
  for (const row of rows) {
    row.cells.forEach(([price, zoneType], index) => {
      const x = row.startX + index;
      const parOverride = PAR_VALUE_LADDER_BY_CELL.get(cellKey(x, row.y));
      cells.push({
        x,
        y: row.y,
        price: parOverride ?? price,
        zoneType,
        isParValueLadder: parOverride !== undefined,
        // Design note #43/#43a: a cliff is a property of the ROW (the board is jagged), and only counts
        // if a cell exists to be redirected into -- the $10 floor and $350 ceiling get no arrow. Derived
        // from the grid rather than hardcoding the two terminal prices.
        isLeftCliff: index === 0 && occupied.has(cellKey(x, row.y - 1)),
        isRightCliff:
          index === row.cells.length - 1 && occupied.has(cellKey(x, row.y + 1)),
      });
    });
  }
  return cells;
}


/** #1435: the row Dynamic Market adds above the top -- one cell per column, all Normal. */
export const DYNAMIC_MARKET_ROW: RealMarketRow = {
  y: 11,
  startX: 0,
  cells: [
    [67, "Normal"], [71, "Normal"], [76, "Normal"], [82, "Normal"], [90, "Normal"],
    [100, "Normal"], [112, "Normal"], [124, "Normal"], [138, "Normal"], [155, "Normal"],
    [175, "Normal"], [200, "Normal"], [225, "Normal"], [250, "Normal"], [275, "Normal"],
    [300, "Normal"], [350, "Normal"], [400, "Normal"], [450, "Normal"],
  ],
};

export interface MarketChart {
  key: "standard" | "dynamic";
  rows: readonly RealMarketRow[];
}

export const STANDARD_MARKET_CHART: MarketChart = { key: "standard", rows: REAL_MARKET_ROWS };
/** The standard rows first, the extra row after -- see the note above on `marketCellForPrice`. */
export const DYNAMIC_MARKET_CHART: MarketChart = { key: "dynamic", rows: [...REAL_MARKET_ROWS, DYNAMIC_MARKET_ROW] };

/** The chart `variants` selects. */
export function chartFor(variants: Pick<GameVariants, "dynamicStockMarket">): MarketChart {
  return variants.dynamicStockMarket ? DYNAMIC_MARKET_CHART : STANDARD_MARKET_CHART;
}

const gridByChart = new Map<MarketChart, { grid: readonly PriceCell[]; byKey: ReadonlyMap<string, PriceCell>; maxY: number }>();
function built(chart: MarketChart) {
  let entry = gridByChart.get(chart);
  if (!entry) {
    const grid = buildPriceGrid(chart.rows);
    entry = {
      grid,
      byKey: new Map(grid.map((cell) => [cellKey(cell.x, cell.y), cell])),
      maxY: Math.max(...grid.map((cell) => cell.y)),
    };
    gridByChart.set(chart, entry);
  }
  return entry;
}

let chartNow: MarketChart = STANDARD_MARKET_CHART;

/* Design note #652: exported for `gameEndCondition.test.ts`. The grid is the only place a cell can claim a
   rule, so a test that the board makes no game-end claim has to be able to read it. Frozen-by-type
   (`readonly`). #1435: a LIVE binding -- `activateMarketChart` moves it -- so read it at call time. */
export let PRICE_GRID: readonly PriceCell[] = built(chartNow).grid;

/** The chart every export above currently describes. */
export function marketChartInEffect(): MarketChart {
  return chartNow;
}

/** Make `chart` the one in effect. The shell calls this once per game; the reducer prefers `withMarketChart`. */
export function activateMarketChart(chart: MarketChart): void {
  if (chart === chartNow) return;
  chartNow = chart;
  PRICE_GRID = built(chart).grid;
}

/** Run `fn` with `chart` in effect, then put the previous chart back -- whatever `fn` does. */
export function withMarketChart<T>(chart: MarketChart, fn: () => T): T {
  const previous = chartNow;
  activateMarketChart(chart);
  try {
    return fn();
  } finally {
    activateMarketChart(previous);
  }
}

/** The top row of the chart in effect: 10 on the standard chart, 11 under Dynamic Market. */
export function marketMaxY(): number {
  return built(chartNow).maxY;
}

/** Design note #648: the grid by coordinate, so a token cluster can find the cell it is standing on. */
export function priceCellByKey(): ReadonlyMap<string, PriceCell> {
  return built(chartNow).byKey;
}

export function cellAt(x: number, y: number): PriceCell | undefined {
  return built(chartNow).byKey.get(cellKey(x, y));
}
