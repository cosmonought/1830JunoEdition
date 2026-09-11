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
/* #1230: the message reaches the general path un-narrowed now that `SetupGame` falls through, and is passed
   as `gameplay` -- the one cast the engine also takes (#1189). The anchor is on the CALL and the receiver, which
   is what these cases are about; the argument's name is not. */
const REDUCER_CTX = sliceBetween(APP, "after = applySandboxAction(after, gameplay, {", "homeHexToAxial,");

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
    const receipt = sliceBetween(APP, "refusalReasonFor(before, gameplay, {", "})");
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
    // #1380: `sandboxStateRef.current` is a ref read, which is the point; the bare state name is the fault.
    const withoutRefs = REDUCER_CTX.replace(/sandboxStateRef\.current/g, "").replace(/mapGridRef\.current/g, "");
    for (const stateBacked of ["sandboxMarket", "marketGrid", "settledPrivatePrices", "sandboxState", "mapGrid,", "currentPhase", "tableVariants"]) {
      expect([stateBacked, withoutRefs.includes(stateBacked)]).toEqual([stateBacked, false]);
    }
  });

  it("the grid and the era come from the refs too (design note #1380)", () => {
    /* THE ARGUMENT THIS CASE USED TO MAKE WAS WRONG, and JUNO-Z6C paid for it: it said `mapGrid` "reads the
       mirrored value" (it read the React state) and that the era "only a log action can change" (true, and
       a burst of log actions changes it several times before React commits once). A tab rebuilding from the
       log priced every route on the pre-burst grid in the pre-burst era, and refused a token on a tile laid
       earlier in the same burst. Both now come from the refs -- the grid the lay narration just wrote, the
       era of the state about to be reduced -- which is what the server engine reads. */
    expect(REDUCER_CTX).toContain("mapGrid: mapGridRef.current,");
    expect(REDUCER_CTX).toContain("era: tileEraFor(sandboxStateRef.current),");
    expect(APP).toContain("mapGridRef");
  });
});
