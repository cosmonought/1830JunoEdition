/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1177 (harness): THE REDUCER WAS HANDED THE CHART TWICE
// ==================================================================
//
// REPORTED: "Every player is showing different amounts of Cash for every other player, including themselves."
//
// THAT IS DIVERGENCE, and #549 is the note that owns it: the reducer must be a function of the log and only
// of the log. The context passed to `applySandboxAction` carried the market chart from TWO sources:
//
//   marketPriceFor          sandboxMarketRef    written synchronously, fresh inside a drain
//   marketPricesByCompany   marketGrid          a memo over `sandboxMarket`, the committed STATE
//
// The stale one is not decoration. It feeds `certificateBreakdown` inside `sharePurchaseBlock`, and #7's rule
// is that an absent price table means every certificate COUNTS -- so a client whose chart had not committed
// counted what a fresher client exempted, refused the purchase, and returned the state unchanged (#712). One
// client charges the buyer and moves the share; another does neither, and nothing reconciles them after.
//
// AND THE STALENESS VARIES BY CLIENT, which is what makes it a divergence rather than a bug everyone shares:
// a client replaying forty actions in one drain never commits between them, while a client taking one action
// per snapshot is nearly fresh. Same log, same code, different cash -- and a refresh puts one client squarely
// in the first case, which is why the report followed one.
//
// THE STATE COPY IS NOT DELETED. `marketGrid` is what the CHART renders from, where committed state is
// correct and reactivity is the whole point. What changed is which of the two the REDUCER is given.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");

/** The context object handed to the reducer, which is the surface this file is about. */
const REDUCER_CTX = sliceBetween(APP, "after = applySandboxAction(after, msg, {", "homeHexToAxial,");

describe("the reducer is given one chart, from the synchronous source", () => {
  it("builds the price table from the ref rather than the memo", () => {
    expect(REDUCER_CTX).toContain("marketPricesByCompany: marketPricesFromRef()");
    expect(REDUCER_CTX).not.toContain("marketGrid");
  });

  it("reads the same ref the trade price already came from", () => {
    /* `marketPriceFor` and `marketZoneFor` were always on the ref. The bug was the third field disagreeing
       with its two neighbours inside one object literal -- #891 at its smallest possible scale. */
    expect(REDUCER_CTX).toContain("marketPriceFor: marketPriceForCompany");
    expect(APP).toContain("sandboxMarketPositions(sandboxMarketRef.current)");
  });

  it("keeps the refusal receipt on the same chart the refusal was judged against", () => {
    /* Nothing here writes state, so this half was narration rather than divergence -- but a receipt that
       explains a refusal from a chart the reducer never saw can name the wrong rule. */
    const receipt = sliceBetween(APP, "refusalReasonFor(before, msg, {", "})");
    expect(receipt).toContain("marketPricesByCompany: marketPricesFromRef()");
    expect(receipt).not.toContain("marketGrid");
  });

  it("leaves the chart's own render path on the committed state", () => {
    /* THE HALF THAT MUST NOT MOVE. A ref does not re-render, so a chart drawn from one would freeze; and the
       Buy button's own gate is evaluated at render, where the state is the correct and reactive answer. */
    const grid = sliceBetween(APP, "const marketGrid = useMemo<MarketGridResponse>(", "  );");
    expect(grid).toContain("sandboxMarketPositions(sandboxMarket)");
    expect(grid).not.toContain("sandboxMarketRef");
    expect(sliceBetween(APP, "const purchaseBlockFor = useCallback(", "  );")).toContain("marketGrid");
  });
});

describe("no other reducer input is read from committed state", () => {
  it("passes nothing else off a memo into the reducer's context", () => {
    /* THE SWEEP, not the one line. Any value in this object that comes from React state rather than a ref or
       from the message itself can be stale for a whole drain, and staleness that varies by client is exactly
       the shape that produced the report. `mapGrid` and `currentPhase` are named exemptions below. */
    for (const stateBacked of ["sandboxMarket", "marketGrid", "settledPrivatePrices", "sandboxState"]) {
      expect([stateBacked, REDUCER_CTX.includes(stateBacked)]).toEqual([stateBacked, false]);
    }
  });

  it("names the two that ARE read from state, so they are a decision rather than an oversight", () => {
    /* `mapGrid` is mirrored into a ref by #767 precisely because a drain lays several tiles, and the context
       reads the mirrored value; `era` comes from the phase, which only a log action can change and which is
       therefore identical on every client replaying the same prefix. Asserted so that if either ever becomes
       a divergence source, this file is where the argument already lives. */
    expect(REDUCER_CTX).toContain("mapGrid,");
    expect(REDUCER_CTX).toContain("era: ERA_FOR_PHASE_TINT");
    expect(APP).toContain("mapGridRef");
  });
});
