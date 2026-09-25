// frontend/src/gameEngine/marketGeometry.ts
//
// ==================================================================
//  DESIGN NOTE 1501: THE CHART'S RULES, OUT OF THE COMPONENT THAT DRAWS IT
// ==================================================================
//
// LIFTED OUT OF `StockMarketRenderer.tsx` UNCHANGED. Every function below is the same text it was, in
// the same order; nothing about where a token lands was touched. Only the file it lives in changed.
//
// #1199 ASKED FOR THIS BY NAME and declined to do it. Written in `replayProviders.ts`, of itself:
// "`StockMarketRenderer.tsx` is a `.tsx` that imports React, and this file imports the ladder's geometry
// out of it. That is harmless in a bundler and merely untidy in Node, but it means the server drags React
// in for a set of pure lookup functions. Splitting the geometry into its own `.ts` is the obvious cleanup and is deliberately NOT
// done here -- it touches the renderer, which is shell code, and Phase 2 has no business editing the
// shell while it is standing up its replacement." The replacement is now standing, and `replayProviders`
// is inside the engine, so the untidiness became the engine's only remaining path to `react`.
//
// SO THE SEAM IS #1435's, ONE LAYER UP. That note moved the chart's DATA to `marketChart.ts` for the
// same reason -- a leaf module with no React in it, so `boardSelection` could switch the chart per
// table. This moves the chart's RULES to the same kind of module: where a price sits, where a par box
// is, which zone a price is in, and where a token walks on a dividend, a sale, a sold-out rise or a
// Blood Price. `StockMarketRenderer.tsx` imports the handful it draws with and re-exports all of them,
// so no other importer in the app or the tests moved.
//
// THE CHART DATA STILL COMES FROM `components/marketChart.ts`, which is an upward import the engine
// should not have. It is deliberate and deferred: the board/tile/chart data cluster moves in the
// batch that moves tile and station legality, and moving half of it now would split that work in two.

import {
  PRICE_GRID,
  PAR_VALUE_LADDER,
  cellAt,
  type PriceCell,
  type ZoneType,
} from "../components/marketChart";
/** Mirrors `msg.rs`'s `MarketPositionEntry` exactly. `price` is a
 *  wire-format `Uint128` (a decimal string) or `null` -- only ever `null`
 *  in the defensive case documented on that Rust field. */
export interface MarketPositionEntry {
  company_id: number;
  ticker: string;
  x: number;
  y: number;
  price: string | null;
  /** Design note #1159: the arrival ordinal, when the source keeps one. The sandbox reducer stamps it (#646)
   *  and the operating order already sorts on it (#647); a real chain sends nothing, and the stack falls back
   *  to a deterministic order rather than throwing -- `station_tokens`' rule for an older contract. */
  enteredAt?: number;
}

/** Mirrors `msg.rs`'s `MarketGridResponse` exactly -- `QueryMsg::GetMarketGrid`'s
 *  response shape. */
export interface MarketGridResponse {
  game_id: number;
  positions: MarketPositionEntry[];
}

/** Mirrors `market::MARKET_MIN_X`/`MAX_X`/`MIN_Y` exactly; the top row is the chart in effect's (#1435).
 *  Clamps occupant placement only -- the chart's rows decide the visible shape. */
export const MARKET_MIN_X = 0;
export const MARKET_MAX_X = 18;
export const MARKET_MIN_Y = 0;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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

/** Where the token lands when a corporation pays the Blood Price -- one LEFT, then one DOWN.
 *
 *  ==================================================================
 *   DESIGN NOTE 1090: THE FIFTH MOVEMENT, AND THE ONLY DIAGONAL ONE
 *  ==================================================================
 *
 *  RULED: "Upon successful transfer, execute the Left 1, Down 1 market movement for the selling corporation."
 *  [UR-4 -- SUPERSEDED BY OD-UR-5(b) (backlog D-50): the corporation that moves is the BUYER, and only the buyer; the
 *  seller gets no movement (its benefit is release from the curse). The geometry below is unchanged -- which token it
 *  is asked of is the chart arm's (`applySandboxMarketAction`, `buyer_protocol_id`). Do not restore the seller move.]
 *
 *  BUILT FROM THE TWO MOVES THAT ALREADY EXIST rather than as a new walk. The left step IS a withhold step,
 *  ledge rule and all, and the down step IS a share-sale step -- so this composes `projectDividendCellMove`
 *  with `projectShareSaleMove` and inherits every edge case both of them already got right. A hand-rolled
 *  `cellAt(x - 1, y - 1)` would be a third opinion about a grid that has had two bugs in it already.
 *
 *  THE LEDGE IS HONOURED, WHICH MAKES THE LEFT EDGE HURT MORE. From the leftmost cell of a row a withhold
 *  step already falls DOWN (#908's rule, stated in `dividendStepFrom`), so at the left edge the Blood Price
 *  lands two rows down instead of one across and one down. FLAGGED RATHER THAN SPECIAL-CASED: a corporation
 *  pinned at the left edge is already in trouble, and the market having nowhere left to put it reads as the
 *  price the fog exacts rather than as an off-by-one. Softening it would make the toll cheapest for the
 *  corporations least able to afford it.
 *
 *  `y - 1` IS DOWN on this inverted axis -- the mistake `projectShareSaleMove` records in its own comment
 *  ("`y + 1` walked up and a sale RAISED the price"), avoided here by not writing the arithmetic twice. */
export function projectBloodPriceMove(from: {
  x: number;
  y: number;
}): { price: number; x: number; y: number } | null {
  const left = projectDividendCellMove(from, "withhold");
  if (!left) return null;
  return projectShareSaleMove({ x: left.x, y: left.y }, 1);
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
