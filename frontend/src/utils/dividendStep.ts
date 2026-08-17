// frontend/src/utils/dividendStep.ts
//
// What the Dividends step is actually worth, and what it may offer.
//
// ===================================================================
//  DESIGN NOTE 486: ONE ANSWER, NOT THREE APPROXIMATIONS
// ===================================================================
//
// REPORTED: a corporation that cannot run is walked through Run Routes and
// Dividends by hand, and Dividends offers Skip at $0 revenue.
//
// Three separate pieces of code were answering "what does this corporation
// declare this turn", and they disagreed:
//
//   THE DISPATCH (`declareDividendsChoice`) read `last_route_revenue`
//   straight off the corporation and sent it. For a corporation that had
//   skipped Routes that is a PREVIOUS turn's figure, so the forced $0
//   withhold could move real money into a treasury for a run that did not
//   happen this turn.
//
//   THE BUTTONS gated Pay on `dividendRevenue > 0 && dividendRevenueIsThisTurn`
//   -- correct -- and then wrote the Withhold label, the Withhold tooltip
//   and the payout table's heading from the raw figure, which is the same
//   stale number the dispatch was using.
//
//   THE SKIP BUTTON was gated on `dividendRevenueIsThisTurn`, which is
//   FALSE exactly when the corporation skipped Routes. So the one
//   corporation guaranteed to have nothing to declare was the one Skip
//   stayed alive for -- the reported bug, arrived at by a clause that was
//   right about staleness and wrong about what to do with it.
//
// The three now read this. It is deliberately a pure function of two facts
// rather than a hook: the dispatch path and the render path both have those
// two facts, and a shared derivation is the only way they cannot drift.
//
// ===================================================================
//  DESIGN NOTE 486a: SKIP IS NEVER A DECLARATION
// ===================================================================
//
// `maySkip` is not a field. There is no state of an Operating Round in
// which stepping past Dividends is legal, so there is nothing to compute:
// 1830 requires a declaration every turn, and $0 withheld is what steps the
// share price one cell LEFT. `AdvanceOperatingSubPhase` moves a cursor and
// settles nothing, so offering it here offers a way to omit a mandatory
// market move -- which is how a corporation's price survives a round it
// should have fallen in.
//
// Recorded as a note rather than a `maySkip: false` constant, because a
// field that is always false is an invitation to make it sometimes true.

export interface DividendStepInput {
  /** The corporation's `last_route_revenue`, as the chain reports it. May
   *  be a string (`Uint128` serialises as one), a number, or absent. */
  lastRouteRevenue: string | number | null | undefined;
  /** Whether this corporation is KNOWN to have skipped the Routes step this
   *  turn. `false` covers both "it ran" and "we did not observe" -- see
   *  App.tsx's `routesRunThisTurn`, whose own note explains why unknown
   *  falls back to trusting the field. */
  skippedRoutes: boolean;
  /* ==================================================================
   *  DESIGN NOTE 492: ONE FIELD CANNOT HOLD THREE TRAINS
   * ==================================================================
   *
   * REPORTED: a corporation running several trains arrives at Dividends
   * showing a single train's revenue, even when the player drafted and ran
   * routes for all of them.
   *
   * The auto-router was NOT the cause, and that is worth recording because
   * it is where the search naturally starts. `assignRouteSet` drafts every
   * train -- three strategies plus a fill pass, verified on a connected
   * board patch: two trains, two routes, the combined total. The multi-train
   * draft was correct all along and the planner panel displayed it correctly.
   *
   * THE LOSS IS AT THE DISPATCH SEAM. `RunManualRoute` declares ONE train's
   * run (design note #275), so a three-train corporation sends three
   * messages -- and each one WRITES `last_route_revenue`. The field is
   * singular; the run is not. Three writes leave the third train's figure
   * standing, so Dividends read one train's revenue and the other two
   * evaporated between the panel that priced them and the step that spends
   * them.
   *
   * That is also why the report reads as an auto-router bug. The player sees
   * a correct multi-train plan, runs it, and is then shown one train's
   * money; "it only routed one train" is the reasonable conclusion from the
   * outside.
   *
   * SO THE COMMITTED TOTAL IS CARRIED SEPARATELY. `App.handleRunTrains`
   * knows exactly what it dispatched -- it filters the runnable drafts and
   * sends them -- so it records their sum, and that sum is what this step
   * spends. It is the figure the player watched being assembled, which is
   * the one they are entitled to have declared.
   *
   * `undefined` MEANS "NOT OBSERVED", not zero, and falls back to the field.
   * A page reloaded mid-turn, or a chain whose routes were run in an earlier
   * session, has no local record of the commitment -- and one train's
   * revenue is a far better answer there than none. */
  committedRevenue?: number | null;
}

export interface DividendDeclaration {
  /** What `DeclareDividends` should carry, and what every label should
   *  quote. Never negative, never `NaN`. */
  revenue: number;
  /** Ten shares to a corporation, so a 10% certificate takes a tenth.
   *  FLOORED: 1830 pays whole units, and rounding up would have the
   *  corporation pay out more than it earned. */
  perShare: number;
  /** Whether "Pay Dividends" may be offered at all. */
  mayPay: boolean;
  /** Whether the step has no choice left in it -- the case the auto-withhold
   *  settles without asking. */
  mustWithhold: boolean;
}

/* ===================================================================
 *  DESIGN NOTE 489a: WHICH WAY THE MONEY WENT
 * ===================================================================
 *
 * The Market Move line's colour, as a value rather than as a branch inside
 * a component. It lives here because it is the same kind of fact the rest of
 * this file holds -- a derivation the Dividends step's UI reads and must not
 * re-derive per surface -- and because the case it exists to get right is
 * invisible from the render code.
 *
 * THE CASE: `ContextualActionBar` computed this as `direction === "pay"`,
 * i.e. "paying out means the price rises". That is true everywhere except
 * the end of a row, where the token cannot advance and the projected price
 * EQUALS the current one. There the old code printed a green up-arrow
 * between two identical numbers -- a gain reported for a move that did not
 * happen, on the one line the payout decision is read from.
 *
 * So the answer comes from the two prices. `"flat"` is a first-class result
 * rather than folded into either side: a ceiling is not a small gain.
 */
export type MarketMoveDirection = "rise" | "fall" | "flat";

export function marketMoveDirection(
  currentPrice: number | null | undefined,
  projectedPrice: number | null | undefined,
): MarketMoveDirection {
  /* Unknown on either side is FLAT, not a guess. A missing price means the
     corporation is not on the chart (unfloated, or a price with no cell), and
     the caller renders "not on the market chart" instead of a comparison --
     but if one ever reaches here, a neutral glyph is the honest fallback and
     a coloured one would be an assertion about a number nobody has. */
  if (currentPrice == null || projectedPrice == null) return "flat";
  if (!Number.isFinite(currentPrice) || !Number.isFinite(projectedPrice)) return "flat";
  if (projectedPrice > currentPrice) return "rise";
  if (projectedPrice < currentPrice) return "fall";
  return "flat";
}

export function dividendDeclaration(input: DividendStepInput): DividendDeclaration {
  /* `Number("")` is 0 and `Number(null)` is 0, but `Number("abc")` is NaN --
     and a NaN revenue would make `mayPay` false, `mustWithhold` false, and
     strand the step with no legal control on it. Coerced to 0 explicitly so
     an unparseable figure lands in the case that has an exit. */
  const parsed = Number(input.lastRouteRevenue ?? 0);
  const reported = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  /* Design note #492: the committed total wins when this session watched the
     player commit it. It is checked against `null`/`undefined` rather than
     against truthiness -- a committed $0 is a real observation (every drafted
     route was invalid and none ran) and must not fall through to a stale
     field that still remembers a previous turn's earnings. */
  const committed =
    input.committedRevenue == null || !Number.isFinite(input.committedRevenue)
      ? null
      : Math.max(0, input.committedRevenue);

  // Design note #486: a skipped Routes step means this corporation ran
  // nothing, whatever the field remembers about the last turn it did run.
  // A commitment is direct evidence it did NOT skip, so it outranks that
  // inference rather than being overridden by it.
  const revenue = committed ?? (input.skippedRoutes ? 0 : reported);

  return {
    revenue,
    perShare: Math.floor(revenue / 10),
    mayPay: revenue > 0,
    mustWithhold: revenue === 0,
  };
}
