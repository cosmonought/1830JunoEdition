/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 891 (harness): THE LEDGE, ASKED OF THE GRID ITSELF
// ==================================================================
//
// REPORTED: "It is NOT at the top of its row, it's at the right edge of its row. It should read 100 > 110 (at
// the right edge of its row, moving up). Game-breaking bug: upon paying dividends, the corporation's share
// price did not actually move up."
//
// THIS IS A MONEY RULE, so it is asked of the real `PRICE_GRID` rather than of a fixture. A fixture would
// prove the arithmetic and not the BOARD -- and the board is the thing the report is about: the ledge exists
// at particular cells of the actual 1830 chart, and a made-up grid would happily have one anywhere.
//
// THE TWO CALLERS ARE BOTH EXERCISED. `projectDividendFrom` is what the action bar prints;
// `projectDividendCellMove` is what `App.tsx` wires to `ctx.projectDividend`, so it IS the move the sandbox
// performs. They shared the clamp and now share the step; testing one would leave the other free to drift,
// which is precisely how the readout came to promise a rise the board did not make.

import {
  PRICE_GRID,
  projectDividendCellMove,
  projectDividendFrom,
} from "../components/StockMarketRenderer";

/** Every cell that has no neighbour to its right -- the ledges a payout turns at. */
const rightEdges = PRICE_GRID.filter(
  (cell) => !PRICE_GRID.some((other) => other.x === cell.x + 1 && other.y === cell.y),
);

describe("a payout at the right edge of a row moves up (design note #891)", () => {
  it("finds ledges on the real chart at all", () => {
    /* THE PREMISE, PINNED FIRST. Every test below iterates `rightEdges`, and an empty list would make all of
       them vacuously pass -- the `forEach`-over-nothing shape of this project's vacuity list. */
    expect(rightEdges.length).toBeGreaterThan(0);
  });

  it("moves the token up rather than clamping, wherever a cell exists above", () => {
    /* ==================================================================
        THE EXPECTATION IS BUILT, NOT BRANCHED ON
       ==================================================================
       The first draft put `expect` inside an `if (above) ... else ...`, which `jest/no-conditional-expect`
       refuses -- and the rule is right about this shape: a conditional assertion is one that can silently
       stop running. Choosing the EXPECTED CELL first and asserting once means every ledge is checked on the
       same line, and the count below proves the interesting branch was actually exercised.
       THE REPORTED CASE is `above`; the fallback is the genuine ceiling of the chart, where there is no cell
       right and none above and the token stays. Asserted by CELL identity rather than by price: prices repeat
       across rows (#434 records a projection that landed in the wrong row while showing a plausible number),
       so a price match alone cannot tell "moved up" from "did not move". */
    let rose = 0;
    for (const cell of rightEdges) {
      const above = PRICE_GRID.find((other) => other.x === cell.x && other.y === cell.y + 1);
      if (above) rose += 1;
      const expected = above ?? cell;
      const moved = projectDividendCellMove({ x: cell.x, y: cell.y }, "pay");
      expect(moved).not.toBeNull();
      expect({ x: moved!.x, y: moved!.y, price: moved!.price }).toEqual({
        x: expected.x,
        y: expected.y,
        price: expected.price,
      });
    }
    /* WITHOUT THIS the loop would pass on a chart where every right edge is also the ceiling -- every
       assertion satisfied by the clamp, and the rule under test never reached. */
    expect(rose).toBeGreaterThan(0);
  });

  it("reports the move as a move, so the readout stops saying it is stuck", () => {
    /* THE OTHER HALF OF THE REPORT: `$100 -> $100 (already at the top of its row)`. `moves` is what the bar
       reads to decide whether to append that note at all. */
    const ledgeWithRoomAbove = rightEdges.find((cell) =>
      PRICE_GRID.some((other) => other.x === cell.x && other.y === cell.y + 1),
    );
    expect(ledgeWithRoomAbove).toBeDefined();
    const projection = projectDividendFrom(
      { x: ledgeWithRoomAbove!.x, y: ledgeWithRoomAbove!.y },
      "pay",
    );
    expect(projection).not.toBeNull();
    expect(projection!.moves).toBe(true);
    expect(projection!.price).toBeGreaterThan(ledgeWithRoomAbove!.price);
  });

  it("keeps the ordinary rightward step, which is most of the chart", () => {
    /* THE CONTROL. A `dividendStepFrom` that always turned upward would satisfy every assertion above and
       break every ordinary payout -- so the common case is asserted too, and asserted by cell so a
       same-priced neighbour in another row cannot stand in for it. */
    const inner = PRICE_GRID.find((cell) =>
      PRICE_GRID.some((other) => other.x === cell.x + 1 && other.y === cell.y),
    );
    expect(inner).toBeDefined();
    const right = PRICE_GRID.find((other) => other.x === inner!.x + 1 && other.y === inner!.y)!;
    const moved = projectDividendCellMove({ x: inner!.x, y: inner!.y }, "pay");
    expect({ x: moved!.x, y: moved!.y }).toEqual({ x: right.x, y: right.y });
  });

  it("mirrors the rule on a withhold: left, then down", () => {
    /* THE SYMMETRICAL BUG, ASSERTED SO IT CANNOT BE HALF-FIXED. `y - 1` is down on this inverted axis --
       `projectShareSaleMove` carries the scar of getting that backwards ("`y + 1` walked up and a sale
       RAISED the price"), which is why both directions are spelled out in the source rather than derived
       from a sign. */
    const leftEdges = PRICE_GRID.filter(
      (cell) => !PRICE_GRID.some((other) => other.x === cell.x - 1 && other.y === cell.y),
    );
    expect(leftEdges.length).toBeGreaterThan(0);
    for (const cell of leftEdges) {
      const below = PRICE_GRID.find((other) => other.x === cell.x && other.y === cell.y - 1);
      const moved = projectDividendCellMove({ x: cell.x, y: cell.y }, "withhold");
      expect(moved).not.toBeNull();
      const expected = below ?? cell;
      expect({ x: moved!.x, y: moved!.y }).toEqual({ x: expected.x, y: expected.y });
    }
  });
});
