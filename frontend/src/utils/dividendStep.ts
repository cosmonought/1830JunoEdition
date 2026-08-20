// What the Dividends step is actually worth, and what it may offer.
//
// Design note #486: three pieces of code answered "what does this corporation
// declare this turn" and disagreed. The dispatch read `last_route_revenue`
// straight off the corporation -- a PREVIOUS turn's figure for a corporation
// that skipped Routes, so a forced $0 withhold could move real money for a run
// that did not happen. The buttons gated Pay correctly and then wrote the
// Withhold label, tooltip and table heading from the same stale number. And Skip
// was gated on `dividendRevenueIsThisTurn`, which is FALSE exactly when the
// corporation skipped Routes -- so the one corporation with nothing to declare
// was the one Skip stayed alive for.
//
// A pure function of two facts rather than a hook: the dispatch path and the
// render path both have those facts, and a shared derivation is the only way
// they cannot drift.
//
// Design note #486a: `maySkip` is not a field. There is no state of an Operating
// Round in which stepping past Dividends is legal -- $0 withheld is what steps
// the share price one cell LEFT, and `AdvanceOperatingSubPhase` settles nothing,
// so offering Skip offers a way to omit a mandatory market move. Recorded as a
// note rather than a `maySkip: false` constant, because a field that is always
// false is an invitation to make it sometimes true.
//
// See docs/ai_architecture/stock_market.md, dividendStep.ts #486 / #486a.

export interface DividendStepInput {
  /** The corporation's `last_route_revenue`, as the chain reports it. May
   *  be a string (`Uint128` serialises as one), a number, or absent. */
  lastRouteRevenue: string | number | null | undefined;
  /** Whether this corporation is KNOWN to have skipped the Routes step this
   *  turn. `false` covers both "it ran" and "we did not observe" -- see
   *  App.tsx's `routesRunThisTurn`, whose own note explains why unknown
   *  falls back to trusting the field. */
  skippedRoutes: boolean;
  /* Design note #492: `RunManualRoute` declares ONE train's run (#275), and each
     message WRITES `last_route_revenue`. The field is singular; the run is not, so
     a three-train corporation left only the third train's figure standing and
     Dividends spent one train's money.

     The auto-router was NOT the cause and that is worth recording, because it is
     where the search starts: `assignRouteSet` drafts every train correctly and the
     planner displayed it correctly, which is exactly why the report reads as an
     auto-router bug from the outside.

     So `App.handleRunTrains` records the sum of what it actually dispatched, and
     that is what this step spends. `undefined` means NOT OBSERVED, not zero, and
     falls back to the field -- a page reloaded mid-turn has no local record, and
     one train's revenue is a far better answer there than none. */
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

/* Design note #489a: the Market Move line's colour, as a value rather than a
   branch inside a component, because the case it exists to get right is
   invisible from the render code.

   `ContextualActionBar` computed this as `direction === "pay"`, which is true
   everywhere except the end of a row, where the token cannot advance and the
   projected price EQUALS the current one -- so it printed a green up-arrow
   between two identical numbers, on the one line the payout decision is read
   from. The answer comes from the two prices, and `"flat"` is a first-class
   result: a ceiling is not a small gain. */
export type MarketMoveDirection = "rise" | "fall" | "flat";

export function marketMoveDirection(
  currentPrice: number | null | undefined,
  projectedPrice: number | null | undefined,
): MarketMoveDirection {
  /* Unknown on either side is FLAT, not a guess. A missing price means the
     corporation is not on the chart, and the caller renders "not on the market
     chart" instead of a comparison -- but a neutral glyph is the honest fallback
     and a coloured one would be an assertion about a number nobody has. */
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
     player commit it. Checked against `null`/`undefined` rather than truthiness --
     a committed $0 is a real observation (every drafted route was invalid) and
     must not fall through to a stale field remembering a previous turn. */
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
