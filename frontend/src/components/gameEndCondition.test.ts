// frontend/src/components/gameEndCondition.test.ts
//
// ==================================================================
//  DESIGN NOTE 652 (harness): $350 IS A CEILING, NOT AN ENDING
// ==================================================================
//
// INSTRUCTED: "make sure the 350 price is not a game end condition anymore.
// We were supposed to have removed that, both from rules reference and the
// grid, as well as the actual game end mechanics."
//
// "We were supposed to have removed that" is the part this file exists for.
// It HAD been removed, twice, and came back to the screen anyway -- because
// the first removal only switched the flag off (`isGameEndCell: false && ...`)
// and left the green fill, the `END` badge and the tooltip sentence standing
// behind it. Everything still looked live, so the next pass through the file
// (the #651 legend) read the constants, believed them, and put "Game end"
// back in front of the player as a documented rule.
//
// A comment saying "ALWAYS false" did not stop that. An assertion will.
// These tests fail if any cell on the board starts claiming a game-end
// condition again, whichever direction it comes from -- a restored flag, a
// tooltip sentence, or a legend row.

import {
  PRICE_GRID,
  cellTitleFor,
  marketCellForPrice,
  marketZoneForPrice,
} from "./StockMarketRenderer";

/** The top of the 1830 chart. */
const CEILING_PRICE = 350;

describe("the $350 cell", () => {
  it("exists, and is the highest price on the board", () => {
    /* The ceiling is real and stays real -- this is not a test that $350 was
       deleted, it is a test that $350 is ORDINARY. `TutorialModal`'s "prices
       cannot move above the $350 ceiling" line is correct and depends on it. */
    expect(marketCellForPrice(CEILING_PRICE)).not.toBeNull();
    const highest = Math.max(...PRICE_GRID.map((cell) => cell.price));
    expect(highest).toBe(CEILING_PRICE);
  });

  it("is an ordinary Normal cell, with no zone rule of its own", () => {
    expect(marketZoneForPrice(CEILING_PRICE)).toBe("Normal");
  });

  it("says nothing about ending the game", () => {
    /* The exact regression: the tooltip read "GAME END -- reaching this cell
       ends the game" for a cell that could not trigger anything, because the
       flag driving it was `false &&`-ed rather than removed. */
    const cells = PRICE_GRID.filter((cell) => cell.price === CEILING_PRICE);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cellTitleFor(cell).toLowerCase()).not.toContain("game end");
      expect(cellTitleFor(cell).toLowerCase()).not.toContain("ends the game");
    }
  });
});

describe("the board as a whole", () => {
  it("has no cell that claims to end the game", () => {
    /* Stated over EVERY cell rather than just $350. The house rule was
       attached to one coordinate, but the thing worth pinning is the general
       property -- no price on this chart is an ending -- so moving the rule
       to a different cell would not slip past. */
    const claiming = PRICE_GRID.filter((cell) => {
      const title = cellTitleFor(cell).toLowerCase();
      return title.includes("game end") || title.includes("ends the game");
    });
    expect(claiming).toEqual([]);
  });

  it("has no cell carrying an isGameEndCell flag", () => {
    /* Belt and braces against the specific way this came back: the flag
       returning to `PriceCell` and being read by a fill or a badge before
       anyone updates the tooltip. `PriceCell` no longer declares the field,
       so this reads it off the runtime object. */
    const flagged = PRICE_GRID.filter(
      (cell) => (cell as unknown as { isGameEndCell?: boolean }).isGameEndCell === true,
    );
    expect(flagged).toEqual([]);
  });

  it("keeps every price under the ceiling", () => {
    for (const cell of PRICE_GRID) {
      expect(cell.price).toBeLessThanOrEqual(CEILING_PRICE);
      expect(cell.price).toBeGreaterThanOrEqual(10);
    }
  });
});
