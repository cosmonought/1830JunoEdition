// frontend/src/components/StockMarketRenderer.tsx
//
// Renders `QueryMsg::GetMarketGrid` as the 1830 stock price matrix: a DOM/CSS grid keyed by
// `market::MARKET_MIN_X..=MAX_X` x `MIN_Y..=MAX_Y` (19 x 11), shaped by the verbatim board data in
// `REAL_MARKET_ROWS`, with every trading corporation's token plotted at its live `(x, y)`.
// Sibling to `HexGridRenderer.tsx`; the two are composed in `App.tsx`'s tabbed board view.
//
// Design notes #1-#26 and #43/#187/#196/#387/#402/#415/#428/#430/#434/#452/#648-#652:
// see `docs/ai_architecture/stock_market.md`.

// Design note #22: par frame recoloured to `#EAB308`; every tooltip says "certificate limit",
// the official 1830 term, and Normal cells now state their status explicitly too.

// Design note #23: par-frame stacking fix (positioned elements paint after non-positioned ones),
// par tooltip trimmed to two clauses, and tokens became circles with the tray moved below the grid.

// Design note #24: par prices centred to clear the frame's border, and same-cell tokens spread
// around a ring instead of a diagonal cascade, shrinking by `1.15 / sqrt(count)`.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { FONT_SIZE } from "../styles/typography";
import { corporationLabel } from "../utils/corporationNames";
import { bestContrastTextColor, corporationLiveryColor } from "../styles/corporationLivery";
import { CorporateLogo } from "./CorporateLogo";
import { resolveVariants, type GameVariants } from "../utils/gameVariants";

/* ------------------------------------------------------------------ */
/* Contract data mirrors -- see design note #1                        */
/* ------------------------------------------------------------------ */

/** Mirrors `msg.rs`'s `MarketPositionEntry` exactly. `price` is a
 *  wire-format `Uint128` (a decimal string) or `null` -- only ever `null`
 *  in the defensive case documented on that Rust field. */
export interface MarketPositionEntry {
  company_id: number;
  ticker: string;
  x: number;
  y: number;
  price: string | null;
}

/** Mirrors `msg.rs`'s `MarketGridResponse` exactly -- `QueryMsg::GetMarketGrid`'s
 *  response shape. */
export interface MarketGridResponse {
  game_id: number;
  positions: MarketPositionEntry[];
}

/* ------------------------------------------------------------------ */
/* Price + zone grid mirror -- see design notes #1/#3/#4               */
/* ------------------------------------------------------------------ */

/** Mirrors `market::MARKET_MIN_X`/`MAX_X`/`MIN_Y`/`MAX_Y` exactly: 19 columns (x 0-18), 11 rows
 *  (y 0-10). Clamps occupant placement only -- `REAL_MARKET_ROWS` decides the visible shape. */
const MARKET_MIN_X = 0;
const MARKET_MAX_X = 18;
const MARKET_MIN_Y = 0;
const MARKET_MAX_Y = 10;

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
const REAL_MARKET_ROWS: readonly RealMarketRow[] = [
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
const REAL_BOARD_COLUMNS = 19;

/* Design note #652: $350 is a CEILING, not a game end. The always-false `isGameEndCell` flag and
   its whole apparatus are removed; `GameOverModal`'s `GameEndReason` is what ends the game here.
   Still owed: `market.rs`'s `GAME_END_PRICE_TRIGGER` / `price_triggers_game_end` (backend audit). */

/* `isRealMarketCell` deleted -- design note #43a moved the question inside `buildPriceGrid`.
   `cellAt` is the live way to ask, and it returns the cell rather than just a boolean. */

/** Mirrors `market::PAR_VALUE_LADDER` exactly: `(price, x, y)`, the six
 *  standard 1830 par prices, now at their true real-board coordinates
 *  (a vertical column at `x=6`, spanning `y=5..10`) -- see design note #4.
 */
const PAR_VALUE_LADDER: ReadonlyArray<{ price: number; x: number; y: number }> = [
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
function buildPriceGrid(): PriceCell[] {
  const cells: PriceCell[] = [];
  // Design note #43a: which coordinates exist at all, so a cliff can ask
  // whether the cell it would be pushed INTO is on the board.
  const occupied = new Set<string>();
  for (const row of REAL_MARKET_ROWS) {
    row.cells.forEach((_, index) => occupied.add(cellKey(row.startX + index, row.y)));
  }
  for (const row of REAL_MARKET_ROWS) {
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

/* Design note #652: exported for `gameEndCondition.test.ts`. The grid is the
   only place a cell can claim a rule, so a test that the board makes no
   game-end claim has to be able to read it. Frozen-by-type (`readonly`) and
   built once at module load, so a reader cannot perturb it. */
export const PRICE_GRID: readonly PriceCell[] = buildPriceGrid();

/** Finds the chart cell a share price sits in. EXPORTED for the sandbox, which must produce a
 *  `MarketGridResponse` keyed by `(x, y)` rather than by price.
 *  Design note #415: DO NOT use this to place a parred token -- prices repeat across rows and this
 *  returns the first match, which is the top row for five of the six par values. Use `parBoxCellFor`.
 *  Correct only for resolving a price the marker has WALKED to. `null` off the chart, which callers
 *  must not coerce to `(0, 0)` -- that is a real cell and a marker parked there is a visible lie. */
export function marketCellForPrice(price: number): { x: number; y: number } | null {
  const cell = PRICE_GRID.find((candidate) => candidate.price === price);
  return cell ? { x: cell.x, y: cell.y } : null;
}

/** The designated PAR BOX for one of the six standard par values -- design note #415.
 *  Parring means "put the marker in the par box", not "on some cell showing this number"; the
 *  distinction is invisible for $100 and wrong for the other five. Reads `PAR_VALUE_LADDER`, the same
 *  table the renderer draws the frame from, so the frame and the marker cannot disagree.
 *  `null` for a non-par price, deliberately NOT a fallback to `marketCellForPrice`. */
export function parBoxCellFor(parPrice: number): { x: number; y: number } | null {
  const entry = PAR_VALUE_LADDER.find((candidate) => candidate.price === parPrice);
  return entry ? { x: entry.x, y: entry.y } : null;
}

/** The six legal par values, in ladder order. Exported so a caller can
 *  offer exactly the prices the board has boxes for, rather than keeping a
 *  second list that can drift from the coordinates above. */
export const PAR_BOX_PRICES: readonly number[] = PAR_VALUE_LADDER.map((entry) => entry.price);

/** The rule zone a price sits in, or `null` if it is not on the board.
 *  Exported because the zones are RULES, not decoration: the certificate count, the Stock Round buy
 *  control and the ledger all read this same table rather than keeping a second copy.
 *  Design note #187: the dividend projection is a lookup on `PRICE_GRID`, not an estimate -- but it
 *  models only the two ORDINARY moves. Ledges, the right cliff and the sold-out rise are `market.rs`'s;
 *  a step that would leave the chart clamps. The contract remains the authority. */
export interface MarketProjection {
  /** Where the token ends up, or the current price when the move is
   *  blocked by the edge of the chart. */
  price: number;
  /** `true` when the token actually moves -- lets a caller distinguish
   *  "rises to $90" from "already at the ceiling". */
  moves: boolean;
}

/* Design note #434: projected from a CELL, not a price. `$67` appears at `(1, 10)` and `(6, 5)`,
   so a price-keyed search projected a par-boxed company from the top row ($67 -> $60 instead of $65).
   Takes a nullable entry so callers can pass a `MarketPositionEntry` straight through. Clamps at the
   edge -- `moves` is false and the marker stays, never an invented cell. */
/* ==================================================================
    DESIGN NOTE 891: THE ROW ENDS AND THE TOKEN DOES NOT STOP
   ==================================================================

   REPORTED: "When a corporation's share price is at a ledge where its movement is supposed to move up if it
   pays dividends, the market move reads: 'Market move: $100 -> $100 (already at the top of its row).' This is
   wrong. It is NOT at the top of its row, it's at the right edge of its row. It should read 100 > 110 (at the
   right edge of its row, moving up). Game-breaking bug: upon paying dividends, the corporation's share price
   did not actually move up."

   THE HEADER ABOVE ADMITTED THIS IN WRITING. #187: "it models only the two ORDINARY moves. Ledges, the right
   cliff and the sold-out rise are `market.rs`'s; a step that would leave the chart clamps. The contract
   remains the authority." That was an honest scope statement and it stopped being true of the SANDBOX the
   moment the sandbox became the thing people play: `App.tsx` wires `ctx.projectDividend` to
   `projectDividendCellMove`, so this arithmetic is not merely the readout -- it IS the move. A clamp here is
   a share price that does not rise.

   THE RULE IS ONE STEP, NOT A CLAMP. In 1830 a payout moves the token RIGHT; from the rightmost cell of a row
   it moves UP instead. A withhold moves LEFT; from the leftmost cell it moves DOWN. Only when THAT cell is
   missing too is the token genuinely at an edge of the chart.
   `y + 1` IS UP on this grid, and `y - 1` is down -- the axis is inverted relative to the screen, which
   `projectShareSaleMove` records as the bug it once caused ("`y + 1` walked up and a sale RAISED the price").
   Both directions are spelled here rather than derived from a sign, because the two mistakes are symmetrical
   and a shared expression would make them one edit apart. */
function dividendStepFrom(
  from: { x: number; y: number },
  choice: "pay" | "withhold",
  /* Design note #908: HOW MANY CELLS, defaulting to 1830's one. Dynamic Stock Market changes only this
     number -- a payout under the share price moves none, one at twice the price moves two -- so the ledge
     rule, the direction and the zones below are reached identically however far the token travels.
     ONE PLACE, WHICH IS THE POINT. Both projections call this, and #891 exists because they once did not
     share a rule: "the bar promising a rise the board does not perform". A variant implemented in the two
     callers instead of here would recreate that split exactly. */
  steps = 1,
): PriceCell | undefined {
  let at: PriceCell | undefined = cellAt(from.x, from.y);
  let moved: PriceCell | undefined;
  for (let taken = 0; taken < steps; taken += 1) {
    if (!at) break;
    const along = cellAt(at.x + (choice === "pay" ? 1 : -1), at.y);
    /* THE LEDGE. Nothing further along the row, so the token turns -- up on a payout, down on a withhold. */
    const next = along ?? cellAt(at.x, at.y + (choice === "pay" ? 1 : -1));
    /* A SECOND STEP THAT CANNOT BE TAKEN IS NOT AN ERROR. The token is at the chart's corner; it stops
       there, keeping whatever the first step won, rather than the whole move being refused. */
    if (!next) break;
    at = next;
    moved = next;
  }
  return moved;
}

export function projectDividendFrom(
  from: { x: number; y: number; price?: string | null } | null | undefined,
  choice: "pay" | "withhold",
  /** Design note #908: the readout takes the same step count the board will take. */
  steps = 1,
): MarketProjection | null {
  if (!from) return null;
  const start = cellAt(from.x, from.y);
  if (!start) return null;
  const next = dividendStepFrom(start, choice, steps);
  return next ? { price: next.price, moves: true } : { price: start.price, moves: false };
}

/** Where the token lands when a player SELLS -- one row DOWN per 10% block, because the drop is per
 *  block rather than per transaction. Takes and returns a CELL (prices repeat across rows).
 *  Reproduces the FLOOR correctly and the ledges not at all; `market.rs` remains the authority.
 *  See `SandboxMarketMark` for why the caller tracks the cell. */
function cellAt(x: number, y: number): PriceCell | undefined {
  return PRICE_GRID.find((candidate) => candidate.x === x && candidate.y === y);
}

export function projectShareSaleMove(
  from: { x: number; y: number },
  blocks: number,
): { price: number; x: number; y: number } | null {
  const start = cellAt(from.x, from.y);
  if (!start) return null;

  /* Plain indices rather than a `find` closure per step (`no-loop-func`), and DOWN is `y - 1`: this
     chart's y axis is inverted relative to the screen, so `y + 1` walked up and a sale RAISED the price. */
  let { x, y } = start;
  let price = start.price;
  for (let step = 0; step < Math.max(0, Math.floor(blocks)); step += 1) {
    const below = cellAt(x, y - 1);
    if (!below) break;
    x = below.x;
    y = below.y;
    price = below.price;
  }
  return { price, x, y };
}

/** Where the token lands on the SOLD-OUT rise -- one row UP. Design note #746: the fourth movement, which
 *  the frontend did not have until the compass rose asked for it by name.
 *
 *  `y + 1` is up, on the same inverted axis the sale projection walks down. Clamps at the top of the column
 *  rather than inventing a cell, so a caller can tell "rose" from "already at the ceiling" by comparing the
 *  returned cell with the one it passed in -- exactly how the other three are read. */
export function projectRiseMove(from: {
  x: number;
  y: number;
}): { price: number; x: number; y: number } | null {
  const start = cellAt(from.x, from.y);
  if (!start) return null;
  const above = cellAt(from.x, from.y + 1);
  return above ? { price: above.price, x: above.x, y: above.y } : start;
}

/** Where the token lands on a dividend decision -- one column RIGHT on a pay, LEFT on a withhold.
 *  Takes a cell for the same reason the sale projection does. Ordinary move only; clamps at the edge. */
export function projectDividendCellMove(
  from: { x: number; y: number },
  choice: "pay" | "withhold",
  /** Design note #908: and so does the move the reducer performs. */
  steps = 1,
): { price: number; x: number; y: number } | null {
  const start = cellAt(from.x, from.y);
  if (!start) return null;
  /* Design note #891: THE SAME STEP THE READOUT USES. This is the arm the sandbox reducer calls
     (`App.tsx`: `projectDividend: (from, choice) => projectDividendCellMove(from, choice)`), so the two
     sharing one rule is what stops the bar promising a rise the board does not perform -- which is the
     failure the report describes from both ends in one sentence. */
  const next = dividendStepFrom(start, choice, steps);
  return next ? { price: next.price, x: next.x, y: next.y } : start;
}

export function marketZoneForPrice(price: number | null | undefined): ZoneType | null {
  if (price == null || !Number.isFinite(price)) return null;
  return PRICE_GRID.find((candidate) => candidate.price === price)?.zoneType ?? null;
}

/** Whether shares priced here are exempt from a player's certificate limit -- true in Yellow, Orange
 *  and Brown. Named because the same test is made in two files and is easy to write as `=== "Yellow"`. */
export function isCertificateExemptZone(zone: ZoneType | null): boolean {
  return zone === "Yellow" || zone === "Orange" || zone === "Brown";
}

/** Whether a player may buy MULTIPLE bank-pool shares of a corporation in
 *  one turn -- the Brown zone's own additional allowance. */
export function allowsMultipleBankPoolBuys(zone: ZoneType | null): boolean {
  return zone === "Brown";
}

/** One colour per real par value, keyed by price. Serves ONLY the `ParIpoTray`'s price-text accent
 *  since design note #20 folded the grid's par cells into the uniform Normal fill. */
const PAR_VALUE_COLORS: Readonly<Record<number, string>> = {
  100: "#e0c060",
  90: "#d4a94c",
  82: "#c89339",
  76: "#bb7d26",
  71: "#af6713",
  67: "#a35100",
};
const FALLBACK_PAR_VALUE_COLOR = "#8a6d1f";

/* ------------------------------------------------------------------ */
/* Rule zone color fills -- see design note #3                        */
/* ------------------------------------------------------------------ */

// Design note #25: `ZONE_COLORS` removed -- it painted the deleted legend's swatches; the cells use
// `ZONE_GRADIENTS`, and every non-Normal cell carries its label and rule as a `title`.

/** Gradient counterpart to the zone palette -- hand-paired lighter/darker shading, one entry per real
 *  zone colour. `Normal` has none, since an untinted cell has nothing to gradient. */
const ZONE_GRADIENTS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "linear-gradient(155deg, #7a6a1c 0%, #5c5015 55%, #453b0f 100%)",
  Orange: "linear-gradient(155deg, #7a4d1c 0%, #5c3a15 55%, #45290f 100%)",
  Brown: "linear-gradient(155deg, #54371a 0%, #3d2811 55%, #2c1c0a 100%)",
};

/** Bright, bold price-text color for zone-tinted cells only (design note
 *  #14) -- reads clearly against every `ZONE_GRADIENTS` fade, unlike the
 *  dim `styles.priceText.color` used for plain Normal-zone cells. */
const ZONE_PRICE_TEXT_COLOR = "#f5f6fa";

/** Design notes #18/#20: the uniform charcoal for EVERY `"Normal"`-tagged cell, including the six par
 *  cells. Value promoted from the former par-column neutral fill for contrast. */
const NORMAL_CELL_BACKGROUND = "#343a45";

/** Design note #650: the six par cells. A flat, quiet tint -- dark enough
 *  that `styles.priceText`'s existing light ink stays legible without a
 *  per-cell contrast rule. */
const PAR_CELL_BACKGROUND = "#1e4430";

// Cumulative zone rules (each tier states what it adds), matching this project's documented
// interpretation -- design note #3. Design note #22: "certificate limit", the official 1830 term.
const ZONE_DESCRIPTIONS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "Certificates here do not count toward the certificate limit.",
  Orange:
    "Exempt from the certificate limit AND a single player may exceed the 60% corporate ownership cap.",
  Brown:
    "Exempt from the certificate limit, exceeds 60% cap, and players can buy multiple bank pool shares per turn.",
};

const ZONE_LEGEND_LABELS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "Yellow Zone",
  Orange: "Orange Zone",
  Brown: "Brown Zone",
};

/* Design note #196: the flat text ink for a zone, hand-paired with each gradient and lifted for
   contrast on a dark panel. A cell needs a multi-stop `background`; text needs one legible `color`,
   and assigning a gradient string to `color` fails silently. The PRICES still come from
   `marketZoneForPrice` -- this only says what a zone looks like as a word rather than a cell. */
export const ZONE_TEXT_COLORS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "#e3c951",
  Orange: "#e39a51",
  Brown: "#c08a5e",
};

/** "Yellow Zone -- Certificates here do not count toward the certificate
 *  limit." One string, so a tooltip cannot show the label without the rule
 *  or the rule without the label. */
export function marketZoneTooltip(zone: ZoneType | null): string | null {
  if (zone === null || zone === "Normal") return null;
  return `${ZONE_LEGEND_LABELS[zone]} — ${ZONE_DESCRIPTIONS[zone]}`;
}

/** The flat ink for a zone, or `null` off the chart / in an ordinary cell. `null` rather than a
 *  default grey so a Normal price keeps the panel's own colour instead of looking like a fourth zone. */
export function marketZoneTextColor(zone: ZoneType | null): string | null {
  if (zone === null || zone === "Normal") return null;
  return ZONE_TEXT_COLORS[zone];
}

/** One price, tinted with its own zone's ink and carrying that zone's rule as a tooltip.
 *
 *  Design note #197 wrote this for the dividend move line: "a player reading this panel is looking at a
 *  NUMBER, not the chart, so stepping into the Yellow zone was invisible exactly when it mattered."
 *
 *  Design note #712 MOVED IT HERE, because the Stock Round's corporation cards needed exactly the same thing.
 *  REPORTED: "when a corporation is in yellow/orange/brown zones, its Market Price on the corp cards reflects
 *  that." It did not -- and the gap mattered more than a missing tint, because #712 also made those zones
 *  change what a player may BUY. A rule the board enforces and the card does not mention is the shape of
 *  problem that whole note is about.
 *  LIVING BESIDE THE ZONE TABLE is the point of the move: `marketZoneForPrice`, the ink and the tooltip are
 *  all in this file, so the tint cannot drift from the cell it is describing. */
export function ZonedPrice({ price }: { price: number | null }) {
  if (price === null) return <>--</>;
  const zone = marketZoneForPrice(price);
  const color = marketZoneTextColor(zone);
  const tooltip = marketZoneTooltip(zone);
  return (
    <span
      style={color ? { color, fontWeight: 700, cursor: "help" } : undefined}
      title={tooltip ?? undefined}
    >
      ${price}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Ticker color palette -- see design note #6                         */
/* ------------------------------------------------------------------ */

/* Design note #428: the local `TICKER_COLORS` is gone. The table lives in
   `styles/corporationLivery.ts`, so a recolour cannot reach one surface and miss another. */
const tickerColor = corporationLiveryColor;

/* ------------------------------------------------------------------ */
/* Disconnected Par/IPO Tray -- see design note #10                   */
/* ------------------------------------------------------------------ */

interface ParMarker {
  companyId: number;
  ticker: string;
  price: number;
}

/** Buckets parred companies by par price for the tray's rows -- design note #24: derived from contract
 *  state every render, not an observed cache, which could not represent a parred-but-unfloated company. */
function buildParMarkers(
  companies: ReadonlyArray<{ company_id: number; ticker: string; par_value: string | null }>,
): ReadonlyMap<number, ParMarker[]> {
  const byPrice = new Map<number, ParMarker[]>();
  for (const company of companies) {
    if (company.par_value === null) continue;
    const price = Number(company.par_value);
    if (!Number.isFinite(price)) continue;
    const marker: ParMarker = { companyId: company.company_id, ticker: company.ticker, price };
    const bucket = byPrice.get(price);
    if (bucket) bucket.push(marker);
    else byPrice.set(price, [marker]);
  }
  return byPrice;
}

/** The tray always lists all six standard prices highest-to-lowest,
 *  matching the physical game's own par track reading order. */
const PAR_TRAY_ROWS: readonly number[] = [100, 90, 82, 76, 71, 67];

/** Neutral steel-gray tray row background/border -- deliberately its own
 *  independent palette, NOT drawn from `PAR_VALUE_COLORS`/`PAR_VALUE_GRADIENTS`
 *  (the main grid's gold par-cell fills) or `ZONE_COLORS`/`ZONE_GRADIENTS`
 *  (the main grid's exception-zone fills) -- see design note #14. */
const PAR_TRAY_ROW_BG = "#1d2028";
const PAR_TRAY_ROW_BORDER = "#333947";

/* ------------------------------------------------------------------ */
/* Market Compass Rose -- see design note #746                         */
/* ------------------------------------------------------------------ */

/* ==================================================================
 *  DESIGN NOTE 747: FOUR ARROWS, FOUR RULES, ONE POCKET
 * ==================================================================
 *
 * ASKED FOR: "a 'compass rose' showing token movements? So an arrow right with 'Paid Dividends,' an arrow
 * left with 'Withheld Dividends,' an arrow up with 'All shares owned by players,' and an arrow down with
 * 'Per share sold'." And on placement: "The trouble is I like the current Stock Market panel and adding this
 * will create a lot of extra vertical space ... is there some way you could put this compass rose in the
 * lower horizontal space between the IPO/Par tray and the Stock Market Matrix?"
 *
 * THERE IS, AND IT COSTS NOTHING. The Par tray is a 168px column beside an eleven-row matrix and is only ever
 * about six rows tall, so the bottom of its column is already empty -- the rose drops into a pocket that
 * exists whether or not anything is in it. On a narrow window the tray wraps to its own row (#26's chosen
 * failure mode) and the rose wraps with it, still costing nothing beside it.
 *
 * WHICH IS WHY IT IS SIZED THE WAY IT IS. The pocket is roughly 120px tall at the smallest cell size and
 * several hundred at the largest, so the rose is built to fit the SMALL case: a compass, four tip labels, and
 * one clarifying line. Anything richer would have been honest on a wide monitor and a scrollbar on a laptop.
 *
 * THE COLOURS ARE THE ONES ALREADY IN USE for a market move -- #489's green rise and red fall, the same pair
 * the Dividends step draws its arrow in. Reused rather than re-picked so a player who has learned what green
 * means on one surface has not learned something else here.
 *
 * AND EVERY ARM NAMES A MOVEMENT THE CODE PERFORMS. That was not true when this was requested -- the up arrow
 * had no implementation anywhere in the frontend, which is what #746 is about. The harness asserts the
 * correspondence rather than trusting it, on #652's precedent: a legend row survived one verification cycle
 * describing a condition no cell on this board carried. */

interface CompassArm {
  /** The glyph, and the direction it means. */
  glyph: string;
  /** What the player did. Terse because the column is 168px wide. */
  label: string;
  rising: boolean;
  /** The full rule, for the tooltip and for a screen reader. */
  rule: string;
}

export const COMPASS_ARMS: Readonly<Record<"up" | "right" | "left" | "down", CompassArm>> = {
  /* SOLD OUT IS THE ONE THAT NEEDS ITS PARENTHETICAL. The other three are things a player just DID and will
     recognise; this one is a condition of the board that resolves at a moment nobody clicks, so "sold out"
     alone would leave them hunting for what they did wrong -- or right. */
  /* Design note #746c: "and again at the end of the Stock Round" REMOVED from this sentence, along with the
     second trigger it described. There is one rise and one moment. The caption was accurate about the code as
     it then stood, which is precisely why a wrong rule reaches a player: the legend agreed with the bug. */
  up: {
    glyph: "↑",
    label: "Sold out",
    rising: true,
    rule: "Every share in players' hands — IPO and Bank Pool both empty. Rises once, at the end of the Stock Round.",
  },
  right: {
    glyph: "→",
    label: "Paid",
    rising: true,
    rule: "The corporation paid dividends: one column right.",
  },
  left: {
    glyph: "←",
    label: "Withheld",
    rising: false,
    rule: "The corporation withheld dividends, including a forced $0: one column left.",
  },
  down: {
    glyph: "↓",
    label: "Each 10% sold",
    rising: false,
    rule: "One row down per 10% share sold — per block, not per sale.",
  },
};

/* ==================================================================
 *  DESIGN NOTE 962: THE ROSE HAS TO KNOW WHICH GAME IS BEING PLAYED
 * ==================================================================
 *
 * ASKED: "For Dynamic stock market: we need to update the compass rose on the Stock Market tab to reflect the
 * new movement mechanics."
 *
 * AND THE ROSE WAS A CONSTANT, which is exactly why it went stale. #908 changed what a paid dividend does to
 * the token -- nothing, one cell, or two, depending on the payout against the share price -- and this legend
 * kept saying "one column right" for every table, including the ones playing the variant. #746c already
 * recorded the shape of that failure in this very file: "The caption was accurate about the code as it then
 * stood, which is precisely why a wrong rule reaches a player: the legend agreed with the bug."
 *
 * ONE ARM CHANGES, AND ONLY UNDER THE VARIANT. Sold out, withheld and each-10%-sold are untouched by #908, so
 * they are shared between both roses rather than duplicated -- a second copy of "one row down per 10% share
 * sold" is a second thing to keep in step for no gain.
 *
 * THE SENTENCE IS THE VARIANT'S OWN, in the sense that matters: `dividendStepsFor` is the authority on how
 * many cells a payout moves, and this rule text states the same three bands in the same order. It cannot be
 * DERIVED from that function -- a legend describes the rule, not one evaluation of it -- so what keeps them
 * together is that both are named in this note and in `gameVariants`. Recording that plainly, because it is
 * the one join here that a test cannot close.
 *
 * THE LABEL GROWS A QUALIFIER rather than staying "Paid". At 168px "Paid" beside an arrow that might not move
 * the token is the same wrong-legend problem in fewer words. */
export function compassArmsFor(
  variants: GameVariants,
): Readonly<Record<"up" | "right" | "left" | "down", CompassArm>> {
  if (!variants.dynamicStockMarket) return COMPASS_ARMS;
  return {
    ...COMPASS_ARMS,
    right: {
      glyph: "→",
      label: "Paid (varies)",
      rising: true,
      rule: "Dynamic Stock Market: the corporation paid dividends. Under its own share price the token does not move; once the price, one column right; twice the price or more, two columns.",
    },
  };
}

function CompassTip({ arm, stacked }: { arm: CompassArm; stacked?: boolean }) {
  return (
    <span
      style={{
        ...styles.compassTip,
        ...(arm.rising ? styles.compassRising : styles.compassFalling),
        ...(stacked ? styles.compassTipStacked : {}),
      }}
      title={arm.rule}
    >
      {arm.label}
    </span>
  );
}

function CompassGlyph({ arm }: { arm: CompassArm }) {
  return (
    <span
      style={{
        ...styles.compassGlyph,
        ...(arm.rising ? styles.compassRising : styles.compassFalling),
      }}
      role="img"
      aria-label={arm.rule}
      title={arm.rule}
    >
      {arm.glyph}
    </span>
  );
}

export function MarketCompassRose({ variants }: { variants?: Partial<GameVariants> } = {}) {
  /* Design note #962: `undefined` reads as the standard game, which is `resolveVariants`' own rule for a
     missing config (#902) and is what every caller that has not been threaded yet will pass. */
  const arms = compassArmsFor(resolveVariants(variants));
  return (
    <aside style={styles.compass}>
      <span style={styles.compassTitle}>Which way a token moves</span>

      <CompassTip arm={arms.up} stacked />
      <CompassGlyph arm={arms.up} />

      {/* The horizontal arms share one line, labels outboard of their arrows, which is what lets the whole
          rose read as a compass inside a column this narrow. */}
      <div style={styles.compassRow}>
        <CompassTip arm={arms.left} />
        <CompassGlyph arm={arms.left} />
        <span style={styles.compassHub} aria-hidden="true">
          &#9679;
        </span>
        <CompassGlyph arm={arms.right} />
        <CompassTip arm={arms.right} />
      </div>

      <CompassGlyph arm={arms.down} />
      <CompassTip arm={arms.down} stacked />

      {/* #651's rule: rules belong on screen, not only in tooltips. The one arm whose trigger is not an
          action a player takes gets its condition spelled out here rather than left to a hover. */}
      <span style={styles.compassFootnote}>
        Sold out = no shares left in the IPO or the Bank Pool.
      </span>
    </aside>
  );
}

function ParIpoTray({ markersByPrice }: { markersByPrice: ReadonlyMap<number, ParMarker[]> }) {
  return (
    <aside style={styles.parTray}>
      <div style={styles.parTrayHeader}>
        <span style={styles.parTrayTitle}>Par / IPO Tray</span>
        <span style={styles.parTrayHint} title="Par prices set here; a company moves onto the grid once it floats.">
          Reference only — markers are session-observed, not a live chain query
        </span>
      </div>
      {PAR_TRAY_ROWS.map((price) => {
        const markers = markersByPrice.get(price) ?? [];
        return (
          <div
            key={price}
            style={styles.parTrayRow}
            title={`Par $${price}`}
          >
            <span
              style={{
                ...styles.parTrayPrice,
                color: PAR_VALUE_COLORS[price] ?? FALLBACK_PAR_VALUE_COLOR,
              }}
            >
              ${price}
            </span>
            <div style={styles.parTrayMarkers}>
              {markers.length === 0 ? (
                <span style={styles.parTrayEmpty}>--</span>
              ) : (
                markers.map((marker) => (
                  <span
                    key={marker.companyId}
                    style={{
                      ...styles.parTrayMarkerBadge,
                      backgroundColor: tickerColor(marker.companyId),
                      /* Design note #430: the ink is COMPUTED, not `#ffffff` -- unreadable on C&O cyan, ERIE yellow and
                         NNH orange, and this colour is what the token's TEXT FALLBACK is drawn in. */
                      color: bestContrastTextColor(tickerColor(marker.companyId)),
                    }}
                    title={`${corporationLabel(marker.ticker)} — parred at $${price}`}
                  >
                    {/* Design note #430: the tray's pills are the largest corporate badges on this screen, so a herald
                       reads cleanly at this size -- the whole test for whether a raster mark belongs somewhere.
                       `CorporateLogo` brings its own `onError` fallback to the acronym, so no preloading or cache is
                       involved: this is the DOM, and an `<img>` that fails simply swaps itself for text. */}
                    <CorporateLogo
                      ticker={marker.ticker}
                      size={PAR_TRAY_LOGO_PX}
                      color={bestContrastTextColor(tickerColor(marker.companyId))}
                      title={`${corporationLabel(marker.ticker)} — parred at $${price}`}
                      fallbackStyle={styles.parTrayMarkerFallback}
                    />
                  </span>
                ))
              )}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

/* Market Rules Legend -- design note #19/item 2. Same zone content as the old horizontal row, now a
   vertical card. */


/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export interface StockMarketRendererProps {
  /** `QueryMsg::GetMarketGrid`'s response, verbatim. */
  marketGrid: MarketGridResponse;
  /** Design note #24: every corporation with a PAR PRICE SET, floated or not. Par is fixed when the
   *  President's Certificate is bought; floating is a later, separate 60% event, so the old
   *  watch-the-grid cache could never show a parred-but-unfloated company.
   *  Reads `PublicCompanyState.par_value`. Optional so the placeholder path renders an empty track. */
  parredCompanies?: ReadonlyArray<{ company_id: number; ticker: string; par_value: string | null }>;
  className?: string;
  /** Design note #962: which game is being played, so the compass rose can state the movement rule this
   *  table is actually using. Optional, and `undefined` reads as the standard game -- `resolveVariants`'
   *  own rule for a missing config (#902), which is also what a live chain that predates the field returns.
   *  PARTIAL, because that is what `GameStateResponse` actually carries -- #232's rule is that a chain
   *  reports what it reports, and a type demanding all four fields would have forced a cast at the one call
   *  site rather than admitting the shape. `resolveVariants` exists precisely to fill the gaps. */
  variants?: Partial<GameVariants>;
}

/** Fallback/default cell size, used only until the `ResizeObserver` below
 *  reports a real measurement (see design note #19 -- the same viewport-
 *  maximization item this mirrors in `HexGridRenderer.tsx`). */
const CELL_SIZE_PX = 40;
const MIN_CELL_SIZE_PX = 22;
// Raised 72 -> 120 (design note #19/item 3): with the header-row legend
// relocated out of `boardArea`'s way, a genuinely widescreen pane can now
// measure enough available space to actually reach a much larger ceiling
// than the old ResizeObserver clamp allowed.
const MAX_CELL_SIZE_PX = 120;
const GRID_GAP_PX = 2;
// `REAL_BOARD_ROWS` is unused since design note #21/item 3 -- `cellSize` derives from available WIDTH
// alone, and a CSS grid's height is already intrinsic to its content.

/** Shrinks each token as more corporations share a cell -- design note #24(2)(b). A formula
 *  (`1.15 / sqrt(count)`, floored at 0.45x) so it degrades gracefully for any real occupant count. */
function tokenCountScale(count: number): number {
  if (count <= 1) return 1;
  return Math.max(0.45, 1.15 / Math.sqrt(count));
}

/** Station-token circle diameter -- design note #23(3)(a), recalibrated to a 0.62 cell ratio by
 *  #24(2)(b), clamped, then scaled by `tokenCountScale` for a shared cell. */
const MIN_TOKEN_DIAMETER_PX = 16;
const MAX_TOKEN_DIAMETER_PX = 46;

/* Design note #430: the diameter at or above which a token carries its herald instead of its acronym.
   26px is measured against the marks -- the PRR keystone survives a ~15px inner box, the NYC oval does
   not. The map's 18px station tokens stay on text for the same reason.
   Design note #452: hover both shrinks and scatters a cluster so the price underneath can be read;
   either effect alone is insufficient at four occupants. CSS `:hover`, not React state.
   Design note #648: the cell and the token cluster share a coordinate and only one can own the
   pointer, so the tooltip text is assembled here rather than inline. Exported alongside `PRICE_GRID`
   (design note #652) because it is where the removed "GAME END" sentence lived. */
export function cellTitleFor(cell: PriceCell): string {
  const zoneLabel = cell.zoneType !== "Normal" ? ZONE_LEGEND_LABELS[cell.zoneType] : undefined;
  const zoneDescription =
    cell.zoneType !== "Normal" ? ZONE_DESCRIPTIONS[cell.zoneType] : undefined;
  return [
    cell.isParValueLadder ? `Par Value $${cell.price}` : `$${cell.price}`,
    zoneLabel && zoneDescription ? `${zoneLabel}: ${zoneDescription}` : undefined,
    // Design note #22/item 2: standard cells state their certificate status.
    cell.zoneType === "Normal" ? "Stocks count toward certificate limit." : undefined,
    // Design note #43: what the arrow in the corner means.
    cell.isRightCliff ? "Right cliff: a price that would move right moves UP instead." : undefined,
    cell.isLeftCliff ? "Left cliff: a price that would move left moves DOWN instead." : undefined,
  ]
    .filter(Boolean)
    .join(" — ");
}

/** Design note #648: the grid by coordinate, so a token cluster can find the
 *  cell it is standing on. Built once from the module constant rather than
 *  per render -- `PRICE_GRID` never changes. */
const PRICE_CELL_BY_KEY: ReadonlyMap<string, PriceCell> = new Map(
  PRICE_GRID.map((cell) => [cellKey(cell.x, cell.y), cell]),
);

const MARKET_TOKEN_SCATTER_CSS = `
.market-token-cluster .market-token {
  transition: transform 140ms ease, opacity 140ms ease;
}
.market-token-cluster:hover .market-token {
  /* Design note #689: the scale is a variable now. A cluster and a lone token need different amounts of it,
     and CSS cannot count occupants -- so the call site, which can, supplies it. */
  transform: translate(var(--scatter-x, 0px), var(--scatter-y, 0px)) scale(var(--scatter-scale, 0.72));
  opacity: 0.88;
}
@media (prefers-reduced-motion: reduce) {
  .market-token-cluster .market-token { transition: none; }
}
`;

const MIN_LOGO_TOKEN_DIAMETER_PX = 26;

/** The herald's height inside a par-tray pill. Sized to the pill's own
 *  `FONT_SIZE.strong` line rather than to a fixed box, so the badge does
 *  not change height when a logo loads or falls back to text. */
const PAR_TRAY_LOGO_PX = 17;
function deriveTokenDiameterPx(cellSize: number, occupantCount: number): number {
  const single = Math.max(MIN_TOKEN_DIAMETER_PX, Math.min(MAX_TOKEN_DIAMETER_PX, Math.round(cellSize * 0.62)));
  return Math.max(Math.round(MIN_TOKEN_DIAMETER_PX * 0.85), Math.round(single * tokenCountScale(occupantCount)));
}

/** Station-token ticker-label font size, scaled off the token's own live
 *  diameter (not cell size directly) so the label always fits the circle
 *  it's centered inside -- design note #23(3)(a). */
function deriveTokenFontSizePx(diameterPx: number): number {
  return Math.max(8, Math.round(diameterPx * 0.32));
}

/** Arranges N same-cell tokens in an evenly-spaced ring around the cell centre -- design note
 *  #24(2)(c). One occupant sits dead-centre; the old diagonal cascade buried all but the front-most. */
function deriveTokenClusterOffset(
  index: number,
  count: number,
  cellSize: number,
  diameterPx: number,
): { x: number; y: number } {
  if (count <= 1) return { x: 0, y: 0 };
  const radius = Math.min(cellSize * 0.42, Math.max(8, diameterPx * 0.6));
  const angle = (index / count) * 2 * Math.PI - Math.PI / 2;
  return { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
}

/** How far a token travels on hover, and how far it shrinks -- design note #689.
 *
 *  REPORTED: "the scatter effect on the stock market matrix when there's only one token simply shrinks the
 *  token in place, but the token (even shrunk) still covers the cell's value."
 *
 *  #452 SAID SO ITSELF and read it as a feature: "a lone occupant has a zero offset and does not move --
 *  correct, since it only needs the scale-down". The premise is the part that does not hold. A lone token
 *  renders at FULL size by #24(2) -- up to 46px -- and 0.72 of that is still ~33px sitting dead centre, while
 *  #649 puts every price in the TOP-LEFT corner. The shrink was never going to uncover it, because the token
 *  does not shrink toward a corner; it shrinks toward the middle, which is where it already was.
 *
 *  SO A LONE TOKEN GETS A DIRECTION, and the direction is not arbitrary: away from the price. Down and right is
 *  the one diagonal with nothing important on it -- the price is top-left (#649), the cliff arrows are top-right
 *  (#43), and the par badge at bottom-right is 6px of text a 23px disc can sit beside rather than on.
 *  AND A DEEPER SHRINK WITH IT. Moving alone leaves a big disc overlapping two quadrants; shrinking alone
 *  uncovers nothing. #452's own finding about clusters -- "either effect alone is insufficient" -- turns out to
 *  be true of a single token too, which is the part it did not test.
 *
 *  THE RESTING POSITION IS UNCHANGED. A lone token still sits centred at full size when nobody is pointing at
 *  it, which is what #24(2) wanted and what makes the chart readable at a glance. This is the hover vector
 *  only. */
export function deriveTokenScatterOffset(
  restingOffset: { x: number; y: number },
  count: number,
  cellSize: number,
): { x: number; y: number; scale: number } {
  if (count > 1) {
    /* A cluster travels along the spoke that already positioned it, so each token moves outward from the
       middle rather than across its neighbours. */
    return { x: restingOffset.x * 0.55, y: restingOffset.y * 0.55, scale: 0.72 };
  }
  /* Toward the free diagonal. Clamped so the token stays mostly inside its own cell -- the wrapper is
     `overflow: visible` and a cluster's members already spill a little, but a lone token sliding fully into a
     neighbouring cell would read as belonging to that price instead. */
  const travel = Math.min(cellSize * 0.28, 14);
  return { x: travel, y: travel, scale: 0.5 };
}

/** Design note #402: the gold frame's border thickness at the original cell size, kept as the ratio
 *  baseline. 4 -> 2.4px (a ~40% cut, deliberately fractional so scaling preserves it) with the floor
 *  dropped 3 -> 2, and the glow halved and made translucent rather than deleted.
 *  Design note #651: the baselines and their derive helpers went with the frame (#650). The reasoning
 *  is kept as the record of four passes spent making a gold rectangle behave. */

/** Floor a price cell's text can shrink to, even at `MIN_CELL_SIZE_PX` --
 *  see design note #13. */
const MIN_PRICE_FONT_SIZE_PX = 9;

/** Scales price-cell text proportionally to the live, dynamically-measured
 *  cell size (design note #13) -- the DOM/CSS-grid equivalent of the
 *  canvas-style `ctx.font = ...px` scaling this was requested as, translated
 *  to this component's actual rendering approach (design note #2). */
function derivePriceFontSizePx(cellSize: number): number {
  // Ratio raised 0.35 -> 0.4 (design note #19/item 3) so price text keeps
  // pace with the raised `MAX_CELL_SIZE_PX` ceiling instead of looking
  // relatively smaller inside the now-larger cells.
  return Math.max(MIN_PRICE_FONT_SIZE_PX, Math.floor(cellSize * 0.4));
}

interface CellOccupantGroup {
  key: string;
  x: number;
  y: number;
  occupants: MarketPositionEntry[];
}

export function StockMarketRenderer({
  marketGrid,
  parredCompanies,
  className,
  variants,
}: StockMarketRendererProps) {
  // Viewport maximization (design note #19), un-clamped from HEIGHT by #21/item 3: a `ResizeObserver`
  // measures available WIDTH and derives the largest cell size that fits every column. A CSS grid needs
  // no explicit pixel height -- its content-driven height cascades up `App.tsx`'s unclamped flex chain.
  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  const [cellSize, setCellSize] = useState(CELL_SIZE_PX);

  useEffect(() => {
    const wrapper = gridWrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width } = entry.contentRect;
      if (width < 1) return;
      const cellFromWidth = (width - GRID_GAP_PX * (REAL_BOARD_COLUMNS - 1)) / REAL_BOARD_COLUMNS;
      const next = Math.floor(Math.max(MIN_CELL_SIZE_PX, Math.min(MAX_CELL_SIZE_PX, cellFromWidth)));
      setCellSize((prev) => (prev === next ? prev : next));
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Station-token sizing (design notes #23(3)(a)/#24(2)) is computed per
  // cell in the token render loop below, since diameter now also depends on
  // that cell's own live occupant count (`tokenCountScale`), which varies
  // cell by cell.
  const priceFontSizePx = derivePriceFontSizePx(cellSize);

  /* Design note #387: no par, no token. A market position is a claim that a corporation HAS a price,
     and only parring gives it one. Filtered at the renderer, not just in the fixture that produced the
     bad data, because the invariant is what a market position MEANS.
     `parredCompanies` is the same `par_value` field the par-track markers trust -- one source.
     An absent roster passes everything through: absent evidence is not evidence of absence (#385). */
  const tradingPositions = useMemo(() => {
    if (parredCompanies === undefined) return marketGrid.positions;
    const parred = new Set(
      parredCompanies
        .filter((company) => company.par_value !== null)
        .map((company) => company.company_id),
    );
    return marketGrid.positions.filter((position) => parred.has(position.company_id));
  }, [marketGrid.positions, parredCompanies]);

  // Groups live positions by cell so multi-occupant cells can be staggered (design note #5). A plain
  // typed array, not `Array.from(map.entries())`, so the render below does not depend on `Map` iterator
  // generics resolving under a bare `tsc` run.
  const cellOccupantGroups = useMemo<CellOccupantGroup[]>(() => {
    const groupsByKey = new Map<string, CellOccupantGroup>();
    for (const position of tradingPositions) {
      const x = clamp(position.x, MARKET_MIN_X, MARKET_MAX_X);
      const y = clamp(position.y, MARKET_MIN_Y, MARKET_MAX_Y);
      const key = cellKey(x, y);
      const existing = groupsByKey.get(key);
      if (existing) {
        existing.occupants.push(position);
      } else {
        groupsByKey.set(key, { key, x, y, occupants: [position] });
      }
    }
    const groups: CellOccupantGroup[] = [];
    groupsByKey.forEach((group) => groups.push(group));
    return groups;
  }, [tradingPositions]);

  /* Design note #24: derived, not observed. The old module-scoped cache only knew about companies
     already ON the chart, which excluded the parred-but-unfloated case the track exists to show. */
  const parMarkersByPrice = useMemo(
    () => buildParMarkers(parredCompanies ?? []),
    [parredCompanies],
  );

  return (
    <div style={styles.root} className={className}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Stock Market</span>
        {/* Design note #387: counts the tokens actually drawn. Reading
            `marketGrid.positions` here would announce "4 companies trading"
            over an empty chart the moment any of them is unparred. */}
        <span style={styles.headerHint}>
          Game #{marketGrid.game_id} -- {tradingPositions.length}{" "}
          compan{tradingPositions.length === 1 ? "y" : "ies"} trading
        </span>
      </div>

      {/* Rule zone legend -- relocated out of this horizontal header-row
          spot into the vertical `MarketRulesLegend` side-column card next
          to `ParIpoTray` below (see design note #19/item 2). Removing it
          from here also hands `boardArea` its full available height. */}

      {/* Design note #25: matrix and par track SIDE BY SIDE. The matrix is far taller than it is wide at
         most window sizes, so a row beneath left a tall column of dead space. The legend is deleted -- every
         zone cell already carries its rule as a `title`. */}
      <div style={styles.boardRow}>
      <div style={styles.boardArea}>
        <div ref={gridWrapperRef} style={styles.gridWrapper}>
          <div
            style={{
              ...styles.grid,
              gridTemplateColumns: `repeat(${REAL_BOARD_COLUMNS}, ${cellSize}px)`,
              gridAutoColumns: `${cellSize}px`,
              gridAutoRows: `${cellSize}px`,
            }}
          >
          {/* Background price cells -- only the real, authentic-shape
              coordinates (see design note #1). Everything else in the
              backend's addressable space is simply never rendered here,
              which is what masks out the cliffside gaps. */}
          {PRICE_GRID.map((cell) => {
            // Tag-driven fill priority -- design note #20: `isGameEndCell` -> a real `zoneType` -> par tint ->
            // `NORMAL_CELL_BACKGROUND`. No column index, no price lookup.
            // Design note #650: the par cells are TINTED, not framed. An overlay drawn on top of six cells was a
            // different KIND of object from everything else here (every other meaning is a fill), which is why
            // four passes of layering fixes never made it belong. Green, muted and distinct from the game-end
            // gradient. Ordered AFTER the zone test: a zone carries a rule, the tint carries an option.
            const gradient = cell.zoneType !== "Normal"
              ? ZONE_GRADIENTS[cell.zoneType]
              : cell.isParValueLadder
                ? PAR_CELL_BACKGROUND
                : NORMAL_CELL_BACKGROUND;
            // Tooltip text -- design notes #16/#18: price, plus the zone's own name alongside its rule, never a
            // raw coordinate. Sourced from `zoneType`/`isParValueLadder` directly.

            // Design note #22: every `"Normal"` cell states its certificate-limit status explicitly, the
            // counterpart to the zones' exemption wording.

            // Design note #23(2): par tooltips trimmed to "Par Value $X" plus the certificate-limit rule.
            // Design note #648: assembled by `cellTitleFor`, which the token cluster also reads -- the cluster
            // covers the cell as a hover target and would otherwise swallow the tooltip on every occupied cell.
            const titleParts = [cellTitleFor(cell)];
            return (
              <div
                key={cellKey(cell.x, cell.y)}
                style={{
                  ...styles.cell,
                  gridColumn: cell.x + 1,
                  gridRow: 11 - cell.y,
                  // `background` always fully replaces `backgroundColor` -- design note #18/item 1 makes even the
                  // no-special-treatment case an explicit value rather than a fall-through.
                  background: gradient,
                  /* Design note #649: every price sits in the same corner. #24(1) centred the par prices to dodge the
                     gold frame; the frame is gone (#650), and a column of prices in one corner is scannable. */
                  justifyContent: "flex-start",
                  alignItems: "flex-start",
                }}
                title={titleParts.join(" — ")}
              >
                {/* Design note #43: cliff arrows. The board's edges are RULES, and a tooltip nobody hovers was the
                   only place they were stated. Colour follows CONSEQUENCE, not direction of travel: green up on the
                   right, red down on the left. Both sit top-right -- a row's two cliffs are never the same cell. */}
                {cell.isRightCliff && (
                  <span style={{ ...styles.cliffArrow, ...styles.cliffArrowUp }} aria-hidden="true">
                    &#9650;
                  </span>
                )}
                {cell.isLeftCliff && (
                  <span
                    style={{ ...styles.cliffArrow, ...styles.cliffArrowDown }}
                    aria-hidden="true"
                  >
                    &#9660;
                  </span>
                )}
                <span
                  style={{
                    ...styles.priceText,
                    // Dynamic font scaling (design note #13): sized off the
                    // live measured `cellSize`, not a fixed pixel value.
                    fontSize: `${priceFontSizePx}px`,
                    // Tag-driven text colour, mirroring the background chain exactly -- design note #20 -- so brightness
                    // can never disagree with whether a tint actually rendered.
                    color:
                      cell.zoneType !== "Normal"
                        ? ZONE_PRICE_TEXT_COLOR
                        : styles.priceText.color,
                    // Par-ladder cells keep bold weight alongside the "PAR"
                    // badge and their #650 green tint -- one more small signal
                    // (not a colour) that these six are starting options, not
                    // just ordinary Normal cells.
                    fontWeight:
                      cell.isParValueLadder || cell.zoneType !== "Normal" ? 700 : 600,
                  }}
                >
                  {cell.price}
                </span>
                {cell.isParValueLadder && <span style={styles.parBadge}>PAR</span>}
              </div>
            );
          })}

          {/* Design note #650: the gold `parGroupFrame` is gone, and with it four passes of layering fixes
             (#20's seam, #23(1)'s stacking order, #402's thinning, #24(1)'s clipped numbers). The par cells
             carry a green tint instead, so the grouping is a property of the cells rather than a box over them. */}

          {/* Live company tokens -- placed as independent grid items (see
              design note #5/#8) so a token is never silently dropped even
              if its coordinate falls outside `REAL_MARKET_ROWS`'s mask or
              has no rendered background price cell for any other reason. */}
          {cellOccupantGroups.map((group) => {
            // Design note #24(2): diameter (and therefore font size) is
            // computed per cell, off that cell's own live occupant count --
            // a lone token renders at full size; a cluster shrinks so every
            // member stays legible.
            const occupantCount = group.occupants.length;
            const tokenDiameterPx = deriveTokenDiameterPx(cellSize, occupantCount);
            const tokenFontSizePx = deriveTokenFontSizePx(tokenDiameterPx);
            return (
              <div
                key={group.key}
                className="market-token-cluster"
                style={{ ...styles.tokenWrapper, gridColumn: group.x + 1, gridRow: 11 - group.y }}
                /* Design note #648: the cell's own facts, because this box is
                   now what the pointer meets there. `undefined` for a token
                   at a coordinate with no cell -- design note #5/#8's orphan
                   case, which has no price to report. */
                title={
                  PRICE_CELL_BY_KEY.get(cellKey(group.x, group.y))
                    ? cellTitleFor(PRICE_CELL_BY_KEY.get(cellKey(group.x, group.y)) as PriceCell)
                    : undefined
                }
              >
                {group.occupants.map((occupant, index) => {
                  const offset = deriveTokenClusterOffset(index, occupantCount, cellSize, tokenDiameterPx);
                  // Design note #689: the hover vector, which is NOT the resting one for a lone token.
                  const scatter = deriveTokenScatterOffset(offset, occupantCount, cellSize);
                  return (
                    <span
                      key={occupant.company_id}
                      className="market-token"
                      style={{
                        ...styles.tokenBadge,
                        /* Design note #452: how far and in which direction a token travels on hover. A cluster moves along
                           the spoke that already positioned it; #689 gives a LONE token a direction of its own, because it
                           has no spoke and shrinking in place never uncovers a price it is centred on. */
                        ["--scatter-x" as string]: `${scatter.x}px`,
                        ["--scatter-y" as string]: `${scatter.y}px`,
                        ["--scatter-scale" as string]: `${scatter.scale}`,
                        backgroundColor: tickerColor(occupant.company_id),
                        // Design note #430: computed ink, for the same
                        // reason the par pill above takes it.
                        color: bestContrastTextColor(tickerColor(occupant.company_id)),
                        width: `${tokenDiameterPx}px`,
                        height: `${tokenDiameterPx}px`,
                        fontSize: `${tokenFontSizePx}px`,
                        top: `calc(50% + ${offset.y}px - ${tokenDiameterPx / 2}px)`,
                        left: `calc(50% + ${offset.x}px - ${tokenDiameterPx / 2}px)`,
                        zIndex: 10 + index,
                      }}
                      title={`${corporationLabel(occupant.ticker)} — $${occupant.price ?? "?"}`}
                    >
                      {/* Design note #430: a size THRESHOLD, not a blanket. These tokens run from 46px down to about 14px,
                         and a herald legible at the top of that range is a coloured smudge at the bottom -- the same
                         judgement that keeps the map's 18px station tokens on text. The threshold decides per token, from
                         the same number the circle is drawn at, so it stays correct as the chart resizes. */}
                      {tokenDiameterPx >= MIN_LOGO_TOKEN_DIAMETER_PX ? (
                        <CorporateLogo
                          ticker={occupant.ticker}
                          size={Math.round(tokenDiameterPx * 0.56)}
                          /* Design note #429: bounded to the circle. Without
                             this the default 2.4x cap would run a wide
                             herald out of both sides and the badge's
                             `overflow: hidden` would crop it. */
                          maxWidth={Math.round(tokenDiameterPx * 0.78)}
                          color={bestContrastTextColor(tickerColor(occupant.company_id))}
                          title={`${corporationLabel(occupant.ticker)} — $${occupant.price ?? "?"}`}
                        />
                      ) : (
                        occupant.ticker
                      )}
                    </span>
                  );
                })}
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {/* Design note #25: the par track, in the whitespace beside the
          matrix. `flex: 0 0 auto` so it keeps its natural width and the
          grid's own `ResizeObserver` measures only what is left. */}
      {/* Design note #452: the same `<style>`-tag escape hatch the tab bar
          and the turn pulse use -- inline styles cannot express `:hover`. */}
      <style>{MARKET_TOKEN_SCATTER_CSS}</style>
      {/* Design note #747: the tray and the rose share one column, and the rose lands in the pocket the
          tray's six rows leave under it beside an eleven-row matrix -- so it costs no height at all. */}
      <div style={styles.traySlot}>
        <ParIpoTray markersByPrice={parMarkersByPrice} />
        <MarketCompassRose variants={variants} />
      </div>
      </div>
      <MarketCellLegend />
    </div>
  );
}

/* Design note #651: the cell-colour legend, under the matrix rather than beside it (a side column
   competes for the width the grid is maximising). Rules belong on screen, not in tooltips.
   Swatches read the same constants the cells paint with -- but that guarantee is one-directional:
   #652 proves sourcing the colour does not check that any cell uses it. Every row must name a live fill. */
function MarketCellLegend() {
  const entries: Array<{ label: string; rule: string; fill: string }> = [
    {
      label: "Par values",
      // Design note #650: the tint the six starting prices now carry.
      rule: "The six prices a corporation may be started at.",
      fill: PAR_CELL_BACKGROUND,
    },
    ...(Object.keys(ZONE_LEGEND_LABELS) as Array<Exclude<ZoneType, "Normal">>).map((zone) => ({
      label: ZONE_LEGEND_LABELS[zone],
      rule: ZONE_DESCRIPTIONS[zone],
      fill: ZONE_GRADIENTS[zone],
    })),
    {
      label: "Standard",
      rule: "Stocks count toward the certificate limit.",
      fill: NORMAL_CELL_BACKGROUND,
    },
    /* Design note #652: NO "Game end" ROW. There was one here for exactly one
       verification cycle, describing a condition no cell on this board
       carries -- which is how the dormant `isGameEndCell` flag finally got
       caught. $350 is the top of the chart and nothing more. */
  ];
  return (
    <div style={styles.cellLegend}>
      {entries.map((entry) => (
        <span key={entry.label} style={styles.cellLegendEntry}>
          <span style={{ ...styles.cellLegendSwatch, background: entry.fill }} aria-hidden="true" />
          <span style={styles.cellLegendLabel}>{entry.label}</span>
          <span style={styles.cellLegendRule}>{entry.rule}</span>
        </span>
      ))}
    </div>
  );
}

export default StockMarketRenderer;

// Inline styles -- plain style objects, matching `App.tsx`'s convention (no CSS framework here yet).

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "16px",
    backgroundColor: "#0b0d12",
    borderRadius: "8px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    // Design note #21/item 3: `overflow: "auto"` and `height: "100%"` both removed -- the inner scrollbar
    // and a percentage height that only resolved against a `boardPane` which no longer imposes one
    // (`App.tsx #13`). The panel sizes to its content and the page's own scrollbar takes over.
    width: "100%",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "12px",
    flexWrap: "wrap",
  },
  headerTitle: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    letterSpacing: "0.02em",
  },
  headerHint: {
    fontSize: FONT_SIZE.small,
    color: "#8a90a0",
  },
  // The old horizontal legend row went with design note #19/item 2; these styles are shared with the
  // vertical `MarketRulesLegend` card and were upscaled again by #21/item 4.
  // Design note #651: the cell-colour legend under the matrix is a wrapping row, not a fixed grid, so it
  // folds to two lines on a narrow window with no breakpoint to maintain.
  cellLegend: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px 18px",
    padding: "10px 4px 2px",
  },
  cellLegendEntry: { display: "inline-flex", alignItems: "baseline", gap: "7px", minWidth: 0 },
  /* Sized to read as a CELL rather than a dot: the thing it stands for is a
     rectangle on the grid above, and a circle would be a second shape for one
     idea. */
  cellLegendSwatch: {
    width: "18px",
    height: "13px",
    borderRadius: "3px",
    border: "1px solid rgba(0, 0, 0, 0.45)",
    flex: "none",
    alignSelf: "center",
  },
  cellLegendLabel: { fontSize: FONT_SIZE.small, fontWeight: 800, color: "#e6e8ef" },
  cellLegendRule: { fontSize: FONT_SIZE.micro, color: "#9aa0ac" },
  legendText: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 600,
    color: "#c4c9d4",
    lineHeight: 1.45,
  },
  // Column layout (design note #23(3)(b)): the grid renders first, at the
  // panel's full available width, then `belowGridRow` renders beneath it --
  // replaces the old row layout that sat the grid and a fixed-width side
  // column beside each other.
  boardArea: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    // Design note #26: takes the pane, minus the slim tray.
    flex: "1 1 auto",
    minWidth: 0,
  },
  // Wraps just the grid so the `ResizeObserver` measures only the matrix's own space (design note
  // #19/item 3), now the panel's full width (#23(3)(b) removed the sibling column). `overflow`/
  // `minHeight` removed by #21/item 3.
  gridWrapper: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  // Design note #23(3)(b): the tray and legend sit in a row BENEATH the matrix (a WIDTH flex basis)
  // rather than stacked beside it.
  // Design note #25: matrix + par track on one row, wrapping on a narrow window.
  // Design note #26: the MATRIX dominates -- the tray's old fixed third is now a slim column, and
  // `minWidth: 0` is what actually lets the grid shrink-and-grow instead of squeezing the tray.
  boardRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: "12px",
    width: "100%",
  },
  /* Design note #747: THE COLUMN, which now holds two things. The width flex-basis moved up here from
     `parTray` -- inside a column the basis would size the tray's HEIGHT, which is not what #26 meant by it.
     The tray keeps its own look and simply fills the width it is given. */
  traySlot: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    // Design note #26's basis, unchanged in value: slim, fixed, wrapping to its own row when it must.
    flex: "0 0 168px",
    minWidth: "168px",
  },
  // ---- Disconnected Par/IPO Tray -- see design notes #10/#17. ----
  parTray: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "12px 14px",
    // Design note #747: sizing moved to `traySlot`; this fills it.
    flex: "0 0 auto",
    width: "100%",
    boxSizing: "border-box",
    backgroundColor: "#161922",
    border: "1.5px solid #2a2e3a",
    borderRadius: "10px",
  },
  // ---- Market Compass Rose -- see design note #747. ----
  compass: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
    padding: "12px 10px",
    flex: "0 0 auto",
    width: "100%",
    boxSizing: "border-box",
    backgroundColor: "#161922",
    border: "1.5px solid #2a2e3a",
    borderRadius: "10px",
    textAlign: "center",
  },
  compassTitle: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "#9aa1b4",
    marginBottom: "6px",
  },
  compassRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    width: "100%",
  },
  compassGlyph: {
    fontSize: "17px",
    lineHeight: 1,
    fontWeight: 700,
  },
  compassHub: {
    fontSize: "7px",
    color: "#5a6072",
    margin: "0 2px",
  },
  compassTip: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  /* The vertical arms' labels sit on their own line, so they get a little breathing room the horizontal
     pair -- which is already hemmed in by the arrows either side -- must not have. */
  compassTipStacked: {
    padding: "1px 0",
  },
  // Design note #489's pair, reused: green is a rise, red is a fall, everywhere on this app.
  compassRising: { color: "#4ade80" },
  compassFalling: { color: "#f87171" },
  compassFootnote: {
    marginTop: "8px",
    fontSize: "10px",
    lineHeight: 1.35,
    color: "#6f7688",
  },
  // ---- Market Rules Legend -- see design note #19/item 2. ----
  legendColumn: {
    display: "flex",
    flexDirection: "column",
    // Gap widened slightly (14px -> 18px) to give design note #21/item 4's
    // larger zone title/description text room to breathe between entries.
    gap: "18px",
    padding: "20px 22px",
    // Width flex basis now (design note #23(3)(b)) -- see `parTray` above.
    flex: "1 1 340px",
    minWidth: "300px",
    backgroundColor: "#161922",
    border: "1.5px solid #2a2e3a",
    borderRadius: "10px",
  },
  parTrayHeader: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "8px",
  },
  parTrayTitle: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "#c8cbd6",
  },
  parTrayHint: {
    fontSize: FONT_SIZE.micro,
    color: "#6f7480",
    lineHeight: 1.35,
  },
  parTrayRow: {
    // Design note #26: compact rows for the narrow column.
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "11px 16px",
    borderRadius: "8px",
    // Neutral steel-gray, decoupled from both the main chart's gold par
    // fills and its exception-zone tints -- see design note #14.
    backgroundColor: PAR_TRAY_ROW_BG,
    border: `1px solid ${PAR_TRAY_ROW_BORDER}`,
  },
  parTrayPrice: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    // Upsized well past the main chart's own necessarily-small per-cell
    // numbers -- see design note #17: this panel's only job is being an
    // easy-to-read reference sheet.
    fontSize: FONT_SIZE.display,
    fontWeight: 700,
    // Per-row color is overridden inline from `PAR_VALUE_COLORS` so the six
    // standard prices stay visually distinguishable against the now-neutral
    // row background; this is just the fallback.
    color: "#c8cbd6",
  },
  parTrayMarkers: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "flex-end",
  },
  parTrayEmpty: {
    fontSize: FONT_SIZE.strong,
    // Muted steel-gray to match the tray's now-neutral background (was
    // tuned for the old gold row fill -- see design note #14).
    color: "#5a6072",
  },
  parTrayMarkerBadge: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    // Upsized alongside `parTrayPrice` -- see design note #17.
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    /* Design note #430: `color: "#ffffff"` REMOVED. The ink is computed per
       livery at the call site now -- five of the eight need white and three
       need black, so a hardcoded value was wrong for three corporations. */
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "5px 11px",
    borderRadius: "999px",
    border: "1px solid rgba(0, 0, 0, 0.35)",
    whiteSpace: "nowrap",
  },
  /* Design note #430: the par pill's TEXT fallback keeps the pill's own
     typography exactly, so a corporation whose logo is missing is
     indistinguishable from how every pill looked before this change. */
  parTrayMarkerFallback: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
  },
  // Sized to `REAL_BOARD_COLUMNS`, now the backend's full 19-column range (design note #1). A token
  // past this renders via an implicit grid track rather than being clipped.
  grid: {
    display: "grid",
    gridTemplateColumns: `repeat(${REAL_BOARD_COLUMNS}, ${CELL_SIZE_PX}px)`,
    gridAutoColumns: `${CELL_SIZE_PX}px`,
    gridAutoRows: `${CELL_SIZE_PX}px`,
    gap: "2px",
    overflow: "visible",
  },
  cell: {
    position: "relative",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-start",
    backgroundColor: "#161922",
    // See design note #7 -- bright enough that adjacent cells' shared edges
    // read as a clear boundary/movement-path grid.
    border: "1px solid #3a4152",
    borderRadius: "3px",
    // `hidden`, not `visible` (design note #17): a gradient must never bleed past its cell into the grid
    // gap. Safe because live tokens are independent sibling grid items (#5), so a deep stack still spills.
    overflow: "hidden",
    // Explicit stacking layer -- design note #23(1): below `parGroupFrame`
    // (zIndex 6) so that overlay's border always paints over every cell's
    // own border rather than the reverse.
    zIndex: 1,
  },
  // Design note #651: `parGroupFrame` removed with the overlay it painted (#650); the six par cells are
  // told apart by their tint, which the legend under the matrix names in words.
  // Price ink promoted from the former par-column colour (#20) -- one colour for every `"Normal"` cell.
  // Design note #43: the cliff arrow is absolutely positioned in the cell's top-right corner so it never
  // displaces the dynamically-sized price text.
  cliffArrow: {
    position: "absolute",
    top: "1px",
    right: "2px",
    lineHeight: 1,
    fontSize: "9px",
    pointerEvents: "none",
    textShadow: "0 0 2px rgba(0,0,0,0.8)",
  },
  cliffArrowUp: { color: "#4ade80" },
  cliffArrowDown: { color: "#f87171" },
  priceText: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "9px",
    color: "#c8ccd6",
    padding: "2px 3px",
  },
  parBadge: {
    position: "absolute",
    right: "2px",
    bottom: "1px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "6px",
    fontWeight: 700,
    letterSpacing: "0.03em",
    color: "#1a1408",
    opacity: 0.75,
  },
  /* Design note #652: `gameEndBadge` removed with the flag that rendered it. */
  tokenWrapper: {
    position: "relative",
    overflow: "visible",
    /* Design note #648: the CELL is the hover target, not the token. `pointer-events: none` made the
       scatter its own off switch -- the pointer entered a token, the token moved out from under it, and it
       oscillated. `auto` makes the wrapper (a grid item filling the cell) the target, so the region no
       longer moves. The cost is the cell's tooltip, paid back by the wrapper carrying `cellTitleFor`. */
    pointerEvents: "auto",
    // Explicit stacking layer -- design note #23(1): above `parGroupFrame`
    // (zIndex 6), so live company tokens keep rendering in front of the par
    // frame exactly as before that fix.
    zIndex: 10,
  },
  // Station-token circle -- design note #23(3)(a). Fixed diameter (set
  // inline per-token from `deriveTokenDiameterPx`) with the ticker label
  // flex-centered inside, replacing the old auto-width text pill --
  // matching the physical 1830 game's own circular station-token pieces.
  tokenBadge: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontWeight: 700,
    // Design note #430: computed per livery at the call site.
    borderRadius: "50%",
    border: "2px solid rgba(0, 0, 0, 0.4)",
    boxShadow: "0 2px 4px rgba(0, 0, 0, 0.55)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    lineHeight: 1,
    textAlign: "center",
    pointerEvents: "auto",
  },
};
