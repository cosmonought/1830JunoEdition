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
//
// REPAIRED IN STAGE 8.1 (design note #1600, below). The queue is no longer frozen at the round-open transition: one
// settle, after the rise is committed, re-sorts the whole opening queue on the risen chart, and during the round
// re-sorts only the not-yet-operated tail. The three corpus indices above no longer exist on the version-5 corpus
// (STAGE8_AUTHORITY_DESIGN_2026-09-16.md §2.3); the #746a overlay is retired. The discard queue is still unaffected.

import type { GameStateResponse } from "./gameState";

/* ==================================================================
    DESIGN NOTE 1600: ONE QUEUE, SETTLED IN ONE PLACE -- FROZEN PREFIX, DYNAMIC TAIL (Stage 8.1: S8-1, S8-3)
   ==================================================================
   Rulebook 6.0 orders floated railroads by share value (same cell: top token first; same value: rightmost
   column, then uppermost row). The 6.1 note: "For the purposes of turn order, if a railroad's share value
   changes for a railroad that has not yet operated, the new share value is used." 5.3: a corporation that
   floats "begins operating in the next operating round". Owner ruling R4 (Stage-8 review, 2026-09-16) fixes the
   representation: frozen round membership + a frozen operated / current prefix + a dynamically sorted
   not-yet-operated tail, keeping `active_operating_order` and `active_corporation_index`.

   WHAT WAS WRONG (S8-1). The queue was built once, inside the round-opening transition, and never touched again.
   #746a tried to order the opening on post-rise prices by overlaying the sold-out rises through the
   `priceFor` / `markFor` resolvers -- but #1196 made `buildOperatingOrder` read `state.market_positions` first,
   every server, replay and shell board carries positions, so the overlay was ignored and the queue locked on the
   PRE-rise chart; the rise was committed to `market_positions` afterwards, by `applySandboxActionInner`. Two
   sources for one order, and the one that won was stale. (S8-3: nothing ever re-sorted the waiting corporations
   when a forced sale moved one of their tokens mid-round.)

   THE MODEL. `settleOperatingQueue(before, after)` below is the ONLY writer of the order after it is built, and the
   reducer calls it exactly once per entry -- in `applySandboxActionAfterAuction`, after the chart step, the core
   (arms, round transitions, cursor), the sold-out rise commit and the par reconcile have all run -- so it always
   reads the COMMITTED chart:
     - MEMBERSHIP is whatever `buildOperatingOrder` admitted when the round's queue was built. The settle only
       permutes; it never inserts (a corporation floated between turns joins the NEXT round, 5.3) and never removes.
     - IN A RUNNING ROUND the prefix `order[0 .. index]` -- every corporation that has operated plus the one
       operating now -- is immutable, and only `order[index + 1 ..]` is re-sorted by the 6.0 comparator on the
       current positions. The operating corporation is never displaced mid-turn, even by its own dividend, so its
       index, seat and `turnGuardKey` hold for the whole turn; an operated corporation can never re-enter the tail.
     - ON THE ENTRY THAT OPENS A ROUND nobody has operated yet, so the whole queue is the tail: the settle re-sorts
       all of it on the post-rise chart, keeps the cursor at 0, and re-seats the table if a different corporation
       now belongs at the head (`syncSeatToActingCorporation`). That is S8-1, falling out of S8-3.
     - A NO-OP IS AN IDENTITY. No round opened and no token moved: the board is returned untouched (a refused
       message stays a no-op). A re-sort that changes nothing also returns the board untouched.

   WHY THE CHART-MOVED TRIGGER IS COMPLETE. The comparator reads only `market_positions` (plus the par fallback for
   a corporation with no mark, which a charted board does not have for a floated corporation). Between openings
   the tail can change only by losing its head to `advanceCorporation` -- which leaves a sorted tail sorted -- or
   by a token moving, which is exactly when this re-sorts. So every Operating Round board a log produces has a
   sorted waiting tail after every entry. Positionless boards (unit fixtures only; every room, replay and the shell
   carry the chart) are left to #1196's resolver fallback at the opening, as before, and are not settled.

   REPLAY. The order is a function of the log, so a rebuild reproduces it entry by entry (`stateDigest` covers
   `active_operating_order`). Replay-semantic in principle -- part of the Stage-8 5 -> 6 bump at 8.5 -- and
   digest-identical on the whole present corpus (the one surviving opening rise, JUNO-FCJ 885, leaves PRR first).

   UI: the turn-order surfaces read the queue (U-34), so they follow the settle with no second rule. */

/** One corporation's 6.0 sort key. Normalised so the comparator is TOTAL (#468: never NaN). */
export interface OperatingOrderKey {
  companyId: number;
  /** Share value: the chart's price, else par (#468), else 0. Always finite. */
  price: number;
  /** Chart column; `-Infinity` without a mark, so it sorts last under "rightmost first" (#647). */
  column: number;
  /** Chart row; `-Infinity` without a mark (#1531: "furthest up" is the larger `y`). */
  row: number;
  /** Arrival ordinal; `Infinity` when unrecorded, so it sorts after every recorded one (#646). */
  arrival: number;
}

/** Normalise one corporation's price, mark and par into its 6.0 key -- the single place the fallbacks live, shared
 *  by the queue build, the queue settle (#1600) and the sold-out rise order (#1601). */
export function operatingOrderKey(
  companyId: number,
  marketPrice: number | null | undefined,
  parValue: string | number | null | undefined,
  mark: { x?: number; y?: number; enteredAt?: number } | null | undefined,
): OperatingOrderKey {
  /* Fall back to PAR, never zero, and coerce NaN: a comparator that returns NaN yields an order that is not total, which puts the cursor back on a corporation that already operated.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #468 */
  const fromPar = Number(parValue ?? 0);
  const price = Number.isFinite(marketPrice as number)
    ? (marketPrice as number)
    : Number.isFinite(fromPar)
      ? fromPar
      : 0;
  /* Infinity for an unrecorded arrival sorts it after every recorded one rather than inventing a turn order.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #646 */
  const arrival = mark?.enteredAt;
  return {
    companyId,
    price,
    /* -Infinity sorts a positionless corporation last under the rightmost-first rule, matching #646's direction.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #647 */
    column: Number.isFinite(mark?.x as number) ? (mark?.x as number) : -Infinity,
    // #1531: "furthest up" -- a positionless corporation sorts lowest, as it does for the column.
    row: Number.isFinite(mark?.y as number) ? (mark?.y as number) : -Infinity,
    arrival: Number.isFinite(arrival as number) ? (arrival as number) : Infinity,
  };
}

/** The rulebook 6.0 comparator -- the ONE statement of it. Four disjoint levels (#1531): price desc, then column
 *  desc (rightmost first, #647), then row desc (furthest up first), then arrival asc (earliest first -- the token on
 *  top, 4.5). `companyId` is the last resort and keeps the sort TOTAL.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #646 */
export function compareOperatingOrder(a: OperatingOrderKey, b: OperatingOrderKey): number {
  return (
    (b.price - a.price) ||
    (b.column - a.column) ||
    (b.row - a.row) ||
    (a.arrival - b.arrival) ||
    (a.companyId - b.companyId)
  );
}

/** Reads the key of any corporation on `state`, from the chart the state carries (#1196) or, on a positionless board
 *  only, from the caller's resolvers. */
function operatingOrderKeyReader(
  state: GameStateResponse,
  priceFor?: (companyId: number) => number | null,
  markFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined,
): (companyId: number) => OperatingOrderKey {
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
  return (companyId: number) => {
    const company = state.public_companies.find((entry) => entry.company_id === companyId);
    const marketPrice = positions ? positions[companyId]?.price ?? null : priceFor?.(companyId) ?? null;
    const mark = positions ? positions[companyId] ?? null : markFor?.(companyId) ?? null;
    return operatingOrderKey(companyId, marketPrice, company?.par_value, mark);
  };
}

/* The OR queue is BUILT where the round begins, ordered by market price descending, floated-with-a-president only. Nothing used to fill it, which is the infinite round.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #411 */
/* Design note #1600: this function decides the round's MEMBERSHIP and its opening order. After the build, the only
   writer of the order is `settleOperatingQueue` below. */
export function buildOperatingOrder(
  state: GameStateResponse,
  priceFor?: (companyId: number) => number | null,
  /* The whole mark, not a growing list of scalars -- rule (iii) needs the column too. priceFor stays separate because #468's fallback reaches past the chart.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #647 */
  markFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined,
): number[] {
  const keyFor = operatingOrderKeyReader(state, priceFor, markFor);
  return state.public_companies
    .filter((company) => company.is_floated && !!company.president)
    .map((company) => keyFor(company.company_id))
    .sort(compareOperatingOrder)
    .map((entry) => entry.companyId);
}

/** Keep the seat pointer in step during an OR so actingSeatIndex and the raw pointer agree. Left untouched when the presidency cannot be resolved.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #411 */
/* Design note #1600: moved here from `sandboxSession.ts` (which imports it), unchanged, so the queue settle can re-seat
   the table after an opening re-sort without importing the reducer. */
export function syncSeatToActingCorporation(state: GameStateResponse): GameStateResponse {
  const companyId = state.active_operating_order[state.active_corporation_index];
  if (companyId === undefined) return state;
  const president = state.public_companies.find(
    (company) => company.company_id === companyId,
  )?.president;
  if (!president) return state;
  const seat = state.player_addresses.indexOf(president);
  if (seat === -1 || seat === state.active_player_index) return state;
  return { ...state, active_player_index: seat };
}

/** Whether `after`'s Operating Round queue was built by the entry that led from `before` -- nobody in it has operated.
 *
 *  Design note #1600. True for: a Stock Round (or any non-OR round) closing into an Operating Round; the next
 *  Operating Round of a set (`sub_round_index` / `macro_round_number` moved: `advanceCorporation` rebuilt the queue);
 *  and a queue rebuilt inside the same round -- the cursor walked backwards, the operated / current prefix changed, or
 *  an empty queue was repaired (#411, `BeginOperatingRound`). A cursor that only advanced is not an opening. */
export function operatingRoundOpenedBetween(before: GameStateResponse, after: GameStateResponse): boolean {
  if (after.current_round_type !== "OperatingRound") return false;
  if (before.current_round_type !== "OperatingRound") return true;
  if (
    before.macro_round_number !== after.macro_round_number ||
    before.sub_round_index !== after.sub_round_index
  ) {
    return true;
  }
  const was = before.active_operating_order ?? [];
  const now = after.active_operating_order ?? [];
  if (after.active_corporation_index < before.active_corporation_index) return true;
  for (let at = 0; at <= before.active_corporation_index && at < was.length; at += 1) {
    if (was[at] !== now[at]) return true;
  }
  return was.length === 0 && now.length > 0;
}

/** The operating queue after one entry -- the single settle point's whole rule (design note #1600).
 *
 *  `before` is the board the entry was applied to (before its chart step); `after` is the board the entry produced,
 *  with its sold-out rises committed and its par marks reconciled. Returns `after` itself unless a round opened this
 *  entry or the chart moved AND the 6.0 order of the not-yet-operated corporations changed. */
export function settleOperatingQueue(before: GameStateResponse, after: GameStateResponse): GameStateResponse {
  if (after.current_round_type !== "OperatingRound") return after;
  // No committed chart, nothing authoritative to order on (unit fixtures; #1196's fallback built their queue).
  if (!after.market_positions) return after;
  const cursor = after.active_corporation_index;
  if (!Number.isInteger(cursor) || cursor < 0) return after;
  const opened = operatingRoundOpenedBetween(before, after);
  // A share value can only have changed if a token moved: nothing moved, nothing to re-sort (and a refusal stays a no-op).
  if (!opened && after.market_positions === before.market_positions) return after;
  const order = after.active_operating_order ?? [];
  /* Frozen: every corporation that has operated, and the one operating now. On the opening entry the cursor is on the
     first corporation of a queue nobody has acted in, so nothing is frozen. (A "rebuild" that did not reset the cursor
     would be a malformed board; it keeps the prefix rule rather than risk moving a corporation that has operated.) */
  const frozen = opened && cursor === 0 ? 0 : Math.min(order.length, cursor + 1);
  const waiting = order.slice(frozen);
  if (waiting.length < 2) return after;
  const keyFor = operatingOrderKeyReader(after);
  const settled = waiting
    .map(keyFor)
    .sort(compareOperatingOrder)
    .map((key) => key.companyId);
  if (settled.every((companyId, at) => companyId === waiting[at])) return after;
  const reordered: GameStateResponse = {
    ...after,
    active_operating_order: [...order.slice(0, frozen), ...settled],
  };
  // Only an opening can put a different corporation under the cursor; the seat follows it (#411).
  return reordered.active_operating_order[cursor] === order[cursor]
    ? reordered
    : syncSeatToActingCorporation(reordered);
}
