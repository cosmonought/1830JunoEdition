// frontend/src/utils/parMarkReconcile.test.ts
//
// ==================================================================
//  DESIGN NOTE 688 (harness): AN INVARIANT, NOT AN EDGE
// ==================================================================
//
// REPORTED: "B&O, PRR, C&O and NNH are floated ... but only B&O has a Market
// price ... those other corporations have their markers on the IPO/Par tray,
// but they are not on the stock market matrix."
//
// TWO SURFACES, TWO SOURCES. The par tray reads `par_value` off
// `GameStateResponse` and is right the instant a company pars. The matrix reads
// the `sandboxMarket` atom, which is shell state outside the log, and a mark
// only landed in it when `runGameplayAction` noticed a `null -> value`
// transition go past.
//
// THAT IS THE #685 FAILURE ONE ATOM OVER, and it is worth stating in the same
// words: `rebuildSandbox` resets the market, the replay has to re-notice every
// edge to rebuild it, and a missed edge is silent and permanent because nothing
// ever looks again. B&O survived only because its par arrives through its own
// `SetBoPar` branch, which writes the ref synchronously -- so the one
// corporation with a bespoke code path was the one corporation that worked.
//
// SO THE TESTS ARE ABOUT A STATE, NOT A SEQUENCE. "A corporation with a par has
// a mark" can be re-established from any state at any time, which is precisely
// what a transition detector cannot do -- and the rebuild case below is the one
// the old code could not pass however many edges it watched.

import { placeParMark, reconcileParMarks, sandboxMarketPriceTable } from "./sandboxState";
import type { SandboxMarketPrices } from "./sandboxState";

/** A stand-in for `StockMarketRenderer.parBoxCellFor`: every par resolves to
 *  its own cell, so the tests are about WHICH companies get marked rather than
 *  about chart geometry (`parPrice.test.ts` owns that). */
const parCellFor = (par: number) => ({ x: par, y: 0 });

const corp = (company_id: number, par_value: string | null) => ({ company_id, par_value });

/** The reported roster: four floated corporations, all parred. */
const FLOATED = [corp(4, "100"), corp(1, "100"), corp(5, "90"), corp(7, "82")];

const EMPTY: SandboxMarketPrices = {};

describe("reconcileParMarks", () => {
  it("marks EVERY parred corporation, not just the one that changed", () => {
    /* THE REPORT. Four floated companies, one mark. Nothing here is a
       transition -- the whole roster is handed over at once and every one of
       them has to come back with a position. */
    const marked = reconcileParMarks(EMPTY, FLOATED, parCellFor);
    expect(Object.keys(marked).sort()).toEqual(["1", "4", "5", "7"]);
    expect(sandboxMarketPriceTable(marked)).toEqual({ 1: 100, 4: 100, 5: 90, 7: 82 });
  });

  it("REBUILDS THE WHOLE CHART FROM A WIPED MARKET", () => {
    /* The case a transition detector cannot pass at all. `rebuildSandbox`
       resets the market atom to the fixture's own seed; a replay then has to
       reconstruct it. Given the state, this needs no memory of how the game
       reached it. */
    const afterRebuild = reconcileParMarks({}, FLOATED, parCellFor);
    expect(Object.keys(afterRebuild)).toHaveLength(4);
  });

  it("leaves an unparred corporation alone", () => {
    // Not yet started. A mark would claim a position it has never held.
    const marked = reconcileParMarks(EMPTY, [corp(2, null), corp(1, "100")], parCellFor);
    expect(marked[2]).toBeUndefined();
    expect(marked[1]).toBeDefined();
  });

  it("ignores a par that is not a usable number", () => {
    /* A malformed figure must not place a mark somewhere arbitrary -- the chart
       would then be asserting a price no corporation has. */
    expect(reconcileParMarks(EMPTY, [corp(1, "")], parCellFor)).toEqual({});
    expect(reconcileParMarks(EMPTY, [corp(1, "nonsense")], parCellFor)).toEqual({});
    expect(reconcileParMarks(EMPTY, [corp(1, "0")], parCellFor)).toEqual({});
    expect(reconcileParMarks(EMPTY, [corp(1, "-90")], parCellFor)).toEqual({});
  });

  it("is idempotent", () => {
    // Run on every action, so this is the property that makes it safe rather
    // than merely cheap.
    const once = reconcileParMarks(EMPTY, FLOATED, parCellFor);
    const twice = reconcileParMarks(once, FLOATED, parCellFor);
    expect(twice).toBe(once);
  });

  it("returns the SAME OBJECT when nothing changed", () => {
    /* An identity check is how the caller decides whether to re-render, and a
       fresh object every action would repaint the chart on every click. */
    const marked = reconcileParMarks(EMPTY, FLOATED, parCellFor);
    expect(reconcileParMarks(marked, FLOATED, parCellFor)).toBe(marked);
    expect(reconcileParMarks(EMPTY, [corp(2, null)], parCellFor)).toBe(EMPTY);
  });

  it("DOES NOT DRAG A MOVED TOKEN BACK TO ITS PAR BOX", () => {
    /* THE PROPERTY THAT MAKES AN INVARIANT SAFE HERE. A corporation that parred
       at $100 and has since paid dividends up to $112 must keep the cell it
       walked to -- reconciliation only fills a gap, it never corrects a mark it
       disagrees with. Without this, running on every action would reset the
       whole chart to par on every click. */
    const moved: SandboxMarketPrices = {
      1: { price: 112, x: 3, y: 1 },
    };
    const marked = reconcileParMarks(moved, [corp(1, "100")], parCellFor);
    expect(marked).toBe(moved);
    expect(marked[1]?.price).toBe(112);
  });

  it("fills a gap without disturbing its neighbours", () => {
    // The mixed state a rebuild half-way through a replay produces.
    const partial: SandboxMarketPrices = { 4: { price: 112, x: 3, y: 1 } };
    const marked = reconcileParMarks(partial, FLOATED, parCellFor);
    expect(marked[4]?.price).toBe(112);
    expect(marked[1]?.price).toBe(100);
    expect(Object.keys(marked)).toHaveLength(4);
  });

  it("agrees with placeParMark, one company at a time", () => {
    /* Reconciliation is `placeParMark` in a loop and must stay that way -- if
       it ever grows its own opinion about where a par sits, the chart and the
       B&O's own `SetBoPar` branch would place the same par on two cells. */
    const looped = FLOATED.reduce(
      (prices, company) =>
        placeParMark(prices, company.company_id, Number(company.par_value), parCellFor),
      EMPTY,
    );
    expect(reconcileParMarks(EMPTY, FLOATED, parCellFor)).toEqual(looped);
  });

  it("survives a company whose par field is absent entirely", () => {
    // An older chain, or a partial mirror. Absent is not zero.
    expect(reconcileParMarks(EMPTY, [{ company_id: 1 }], parCellFor)).toBe(EMPTY);
  });

  it("skips a par the chart has no cell for", () => {
    /* `parCellFor` returns `null` for a price off the ladder. A mark with no
       cell cannot be drawn, and inventing one would put a corporation on a
       square the chart does not have. */
    const marked = reconcileParMarks(EMPTY, [corp(1, "999")], () => null);
    expect(marked).toBe(EMPTY);
  });
});
