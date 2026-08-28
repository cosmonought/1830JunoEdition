// frontend/src/components/marketTraversal.test.ts
//
// ==================================================================
//  DESIGN NOTE 434 (harness): ONE CELL, FROM THE RIGHT CELL
// ==================================================================
//
// The reported bug: withholding on a $67 corporation moved its token to
// $60, a price it could not have reached in one step, and the token then
// disappeared from the matrix.
//
// $60 is not arithmetic ($67 - $7 is a coincidence worth noting, because it
// makes the bug look like blind subtraction when it was not). It is the
// real neighbour of the WRONG cell: $67 appears twice on this chart, at
// (1, 10) in the top row and at (6, 5) in the par ladder, and one step left
// of (1, 10) is (0, 10) = $60. One step left of where the token actually
// stood is (5, 5) = $65.
//
// So the tests below assert the DESTINATION COORDINATE, not just the price.
// A price-only assertion would pass on a projection that guessed the right
// number from the wrong row, which is how this survived in the first place.

import {
  parBoxCellFor,
  projectDividendCellMove,
  projectDividendFrom,
  projectShareSaleMove,
} from "./StockMarketRenderer";

/** The par box for $67 -- where a freshly-parred corporation stands. */
const PAR_67 = { x: 6, y: 5 };
/** The OTHER $67 on the board: top row. The bug projected from here. */
const TOP_ROW_67 = { x: 1, y: 10 };

describe("projectDividendFrom", () => {
  it("steps one cell LEFT on a withhold, from the par box", () => {
    // The reported case. $65, not $60.
    expect(projectDividendFrom(PAR_67, "withhold")).toEqual({ price: 65, moves: true });
  });

  it("steps one cell RIGHT on a payout", () => {
    expect(projectDividendFrom(PAR_67, "pay")).toEqual({ price: 71, moves: true });
  });

  it("reproduces the old wrong answer only from the cell that produced it", () => {
    // Pinned deliberately: (0, 10) really is $60 and really is one step left
    // of the top-row $67. The bug was never the arithmetic -- it was
    // starting from here when the token was in the par box.
    expect(projectDividendFrom(TOP_ROW_67, "withhold")).toEqual({ price: 60, moves: true });
  });

  it("gives two different answers for the two cells sharing $67", () => {
    // The property that makes a price-keyed API unfixable.
    expect(projectDividendFrom(PAR_67, "withhold")).not.toEqual(
      projectDividendFrom(TOP_ROW_67, "withhold"),
    );
  });

  it("drops a row at the left edge, and clamps only at the chart's floor", () => {
    /* ==================================================================
        DESIGN NOTE 891: THE CLAMP WAS THE BUG, ON THE OTHER SIDE
       ==================================================================
       THIS ASSERTED `{ price: 60, moves: false }` from (0, 10) -- "stepping left off the board must leave the
       marker where it is". That was #187's stated scope showing through: "it models only the two ORDINARY
       moves. Ledges, the right cliff and the sold-out rise are `market.rs`'s." Honest when the contract was
       the authority; false once `App.tsx` wired `ctx.projectDividend` to this family and made the sandbox's
       arithmetic the move itself.
       REPORTED ON THE PAY SIDE -- "at the right edge of its row ... It should read 100 > 110" -- and the
       withhold is the same rule mirrored: left along the row, and DOWN a row when the row runs out. (0, 10)
       is the leftmost cell of the TOP row, so withholding there now falls to (0, 9) at $53.
       THE CLAMP STILL EXISTS, and this test still guards it: it belongs at the chart's actual floor, where
       there is no cell either left or below. `dividendLedge.test.ts` walks every left edge on the real grid
       and asserts exactly that split. */
    expect(projectDividendFrom({ x: 0, y: 10 }, "withhold")).toEqual({
      price: 53,
      moves: true,
    });
  });

  it("returns null for a missing entry rather than a default cell", () => {
    expect(projectDividendFrom(null, "withhold")).toBeNull();
    expect(projectDividendFrom(undefined, "pay")).toBeNull();
    // Off the board entirely.
    expect(projectDividendFrom({ x: 99, y: 99 }, "pay")).toBeNull();
  });

  it("accepts a MarketPositionEntry shape unchanged", () => {
    // The call sites hand it a `positions.find(...)` result directly; that
    // carries a `price` string the projection must ignore.
    expect(projectDividendFrom({ x: 6, y: 5, price: "67" }, "withhold")).toEqual({
      price: 65,
      moves: true,
    });
  });
});

describe("the token move and its preview agree", () => {
  it("lands the marker where the projection said it would", () => {
    // These were the two halves that disagreed: the token used the
    // cell-based mover and was right, the readout used the price-based
    // projection and was wrong.
    for (const choice of ["pay", "withhold"] as const) {
      const projected = projectDividendFrom(PAR_67, choice);
      const landed = projectDividendCellMove(PAR_67, choice);
      expect(landed?.price).toBe(projected?.price);
    }
  });

  it("agrees for every par box on the ladder", () => {
    for (const par of [67, 71, 76, 82, 90, 100]) {
      const box = parBoxCellFor(par);
      expect(box).not.toBeNull();
      const projected = projectDividendFrom(box, "withhold");
      const landed = projectDividendCellMove(box!, "withhold");
      expect(landed?.price).toBe(projected?.price);
    }
  });
});

describe("a withheld $0 dividend", () => {
  it("still moves the marker exactly one cell", () => {
    // 1830 has no $0 dividend -- the revenue is withheld and the price
    // steps left regardless of the amount. The projection does not consult
    // the revenue at all, which is what makes that true.
    expect(projectDividendCellMove(PAR_67, "withhold")).toEqual({ price: 65, x: 5, y: 5 });
  });
});

describe("projectShareSaleMove", () => {
  it("walks DOWN one row per 10% block, by cell", () => {
    // Sanity-check the sibling traversal with the same discipline: from the
    // $67 par box, one block down is (6, 4).
    expect(projectShareSaleMove(PAR_67, 1)).toEqual({ price: 67, x: 6, y: 4 });
  });

  it("stops at the floor rather than walking off the board", () => {
    const landed = projectShareSaleMove({ x: 6, y: 3 }, 99);
    expect(landed).not.toBeNull();
    expect(landed!.y).toBeGreaterThanOrEqual(0);
  });
});
