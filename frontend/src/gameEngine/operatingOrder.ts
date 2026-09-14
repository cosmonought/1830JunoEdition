// frontend/src/gameEngine/operatingOrder.ts
//
// The order corporations act in -- rulebook 6.0 -- as a function of the log.
//
// Design note #1530: LIFTED OUT OF `sandboxSession.ts`. The excess-train discard (`trainDiscard.ts`) orders
// the corporations that must discard by the same rule 6.6.1 names -- "in order of the companies' share
// values, with the highest valued railroad deciding first" -- and its tie-break can only be 6.0's, which this
// function implements. A module the reducer imports cannot import the reducer, so the function moved;
// `sandboxSession.ts` re-exports it and every existing caller is unchanged.
//
// ==================================================================
//  DESIGN NOTE 1531: THE FOURTH KEY -- "FURTHEST UP" -- WAS MISSING
// ==================================================================
// Rulebook 6.0 (1830-RE), in full: "Sometimes the share value tokens of 2 or more floated railroads are in
// the same grid block of the stock market. In this case, the railroad whose token is on top takes a turn
// first, then the railroad with the next token down, and so on. If 2 or more floated railroads have the
// same share value but their share value tokens are in different columns, the railroad whose token is
// furthest to the right takes a turn first. If 2 or more floated railroads have the same share value and
// their share value tokens are in the same column, the railroad whose token is furthest up takes a turn
// first." And 4.5: "the newly arriving token is placed at the bottom of the stack" -- so "on top" is the
// EARLIEST arrival, which is #646's ascending arrival key.
// #647 implemented "furthest right" and its harness recorded same-column/different-row as "not the stated
// rule ... the rules do not legislate this case". They do (the sentence above), and the standard chart
// reaches it: column 6 holds $67 three times (rows 3, 4, 5). So the third key is the ROW, higher first, and
// arrival is the fourth -- reached only by tokens in ONE cell, which is exactly the case 4.5 stacks.
// The chart's `y` grows upward (`StockMarketRenderer` draws `gridRow: maxY + 1 - y`), so "furthest up" is
// the larger `y`. Batch 4.6 found this while proving the discard order; the repair is to the shared
// primitive, so the Operating Round and the discard queue cannot disagree. Its replay effect is confined to
// two corporations at one price in one column on different rows (the $67 column), which no stored log
// reaches -- verified by the Batch 4.6 corpus sweep.
//
// RECORDED FOR STAGE 8, NOT REPAIRED HERE (Batch 4.6 pre-commit check): the live anomaly of a $112 B&M
// operating ahead of a $126 B&O is NOT this function's sort -- price outranks every other key -- but WHAT THE
// QUEUE IS BUILT FROM. #746a overlays the end-of-Stock-Round sold-out rises through the `priceFor`/`markFor`
// resolvers so the queue orders on post-rise prices; #1196 then made this function read `state.market_positions`
// FIRST and fall back to the resolvers only when positions are absent. On every server board positions are
// present, so the overlay is ignored, the queue is locked on PRE-rise positions, and the rise is committed to
// `market_positions` afterwards (`applySandboxActionInner`, after the core settles). Confirmed on the stored
// corpus: JUNO-3XD idx 303 locks B&M@90 ahead of NYC@100; JUNO-FCJ idx 699 locks NYC@112 behind ERIE/CPR@100;
// JUNO-FCJ idx 398 locks B&M@90 ahead of NYC@90 (a column tie decided on the pre-rise cell) -- each queue
// disagreeing with `buildOperatingOrder` asked of the same state one settle later. The fix belongs to the
// round-open transition (build the queue on the risen positions, or commit the rise before opening), which
// is Stage-8 OR-ordering work and changes replay semantics; it is not made in Batch 4.6. The discard queue
// (#1530) is unaffected: it asks this function of the state as it stands, mid-Operating-Round, positions risen.

import type { GameStateResponse } from "./gameState";

/* The OR queue is BUILT where the round begins, ordered by market price descending, floated-with-a-president only. Nothing used to fill it, which is the infinite round.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #411 */
export function buildOperatingOrder(
  state: GameStateResponse,
  priceFor?: (companyId: number) => number | null,
  /* The whole mark, not a growing list of scalars -- rule (iii) needs the column too. priceFor stays separate because #468's fallback reaches past the chart.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #647 */
  markFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined,
): number[] {
  /* Fall back to PAR, never zero, and coerce NaN: a comparator that returns NaN yields an order that is not total, which puts the cursor back on a corporation that already operated.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #468 */
  /* ==================================================================
      DESIGN NOTE 1196: THE QUEUE READS THE STATE FIRST, AND THE RESOLVERS SECOND
     ==================================================================
     THIS IS THE LINE §5a WAS ABOUT. The three sort keys below -- price, column, arrival -- have always come
     from resolvers backed by a React ref that each client maintained privately, so two clients whose charts
     had drifted produced two different turn orders from one log. Indices 310/311 of `JUNO-3XD` are that
     happening to real players.
     `state.market_positions` IS THE SAME FIGURES, WRITTEN BY THE REDUCER AND DETERMINED BY THE LOG. Prefer
     it wherever it exists and the queue becomes a function of the log by construction -- which is the
     property #1174 and #1182 both tried to enforce from the wrong end, by refusing actions on a cursor
     rather than by making the cursor agree.
     THE RESOLVERS REMAIN THE FALLBACK, and #232's rule says why: `undefined` means "this caller carries no
     positions", which is every log written before this note and the shell until increment 2. It does not
     mean an empty chart -- that is `{}`, and it correctly yields par-priced companies with no column. */
    const positions = state.market_positions;
    const positionFor = (companyId: number) =>
      positions ? positions[companyId] ?? null : markFor?.(companyId) ?? null;
    const resolvedPriceFor = (companyId: number): number | null =>
      positions ? positions[companyId]?.price ?? null : priceFor?.(companyId) ?? null;

  const priced = state.public_companies
    .filter((company) => company.is_floated && !!company.president)
    .map((company) => {
      const fromMarket = resolvedPriceFor(company.company_id);
      const fromPar = Number(company.par_value ?? 0);
      const price = Number.isFinite(fromMarket as number)
        ? (fromMarket as number)
        : Number.isFinite(fromPar)
          ? fromPar
          : 0;
      /* Infinity for an unrecorded arrival sorts it after every recorded one rather than inventing a turn order.
         See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #646 */
      const mark = positionFor(company.company_id);
      const arrival = mark?.enteredAt;
      return {
        companyId: company.company_id,
        price,
        /* -Infinity sorts a positionless corporation last under the rightmost-first rule, matching #646's direction.
           See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #647 */
        column: Number.isFinite(mark?.x as number) ? (mark?.x as number) : -Infinity,
        // #1531: "furthest up" -- a positionless corporation sorts lowest, as it does for the column.
        row: Number.isFinite(mark?.y as number) ? (mark?.y as number) : -Infinity,
        arrival: Number.isFinite(arrival as number) ? (arrival as number) : Infinity,
      };
    });

  /* Four disjoint levels (#1531): price desc, then column desc (rightmost first, #647), then row desc
     (furthest up first), then arrival asc (earliest first -- the token on top, 4.5). company_id is the last
     resort and keeps the sort TOTAL.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #646 */
  priced.sort(
    (a, b) =>
      (b.price - a.price) ||
      (b.column - a.column) ||
      (b.row - a.row) ||
      (a.arrival - b.arrival) ||
      (a.companyId - b.companyId),
  );
  return priced.map((entry) => entry.companyId);
}

