// frontend/src/components/parBoxCoordinates.test.ts
//
// ==================================================================
//  DESIGN NOTE 415 (harness): THE PAR BOX IS A COORDINATE
// ==================================================================
//
// The reported bug was parred tokens landing on the wrong market cell, and
// what made it survive is that it is CORRECT for $100. A developer checking
// "does parring work" reaches for the top of the ladder, sees the token in
// the right box, and moves on. The other five values are wrong.
//
// So the central test here is not "does $67 resolve" -- it is that all six
// resolve, to six DISTINCT cells, in the ladder column. A regression that
// reintroduces the first-match lookup passes any single-value test that
// happens to pick $100 and fails this one on the other five.
//
// It also pins the old behaviour explicitly. Asserting that
// `marketCellForPrice` still returns the top row for a par is not testing
// the bug back in: that function is still correct for its own job (resolving
// a price a marker has WALKED to), and the two must stay different. If they
// ever agree, one of them has been quietly repointed at the other.

import {
  marketCellForPrice,
  parBoxCellFor,
  PAR_BOX_PRICES,
} from "./StockMarketRenderer";
import { PAR_VALUE_LADDER } from "./StockRoundPanel";
import { placeParMark } from "../utils/sandboxState";

/** The real board's par boxes: a vertical column at x=6, y=5..10. */
const EXPECTED_PAR_BOXES: ReadonlyArray<[number, number, number]> = [
  // [par, x, y]
  [67, 6, 5],
  [71, 6, 6],
  [76, 6, 7],
  [82, 6, 8],
  [90, 6, 9],
  [100, 6, 10],
];

describe("parBoxCellFor", () => {
  it.each(EXPECTED_PAR_BOXES)(
    "routes par $%i to the par box at (%i, %i)",
    (par, x, y) => {
      expect(parBoxCellFor(par)).toEqual({ x, y });
    },
  );

  it("puts every par box in one column", () => {
    const columns = new Set(EXPECTED_PAR_BOXES.map(([par]) => parBoxCellFor(par)?.x));
    expect(columns).toEqual(new Set([6]));
  });

  it("gives each par value its own distinct cell", () => {
    // The bug's real signature: several pars resolving into the same row.
    const cells = PAR_BOX_PRICES.map((par) => JSON.stringify(parBoxCellFor(par)));
    expect(new Set(cells).size).toBe(PAR_BOX_PRICES.length);
  });

  it("returns null for a price that is not a par value", () => {
    // 112 and 350 are real cells on the chart; neither is a par box, and
    // resolving them to a plausible coordinate is the behaviour this
    // function exists to end.
    expect(parBoxCellFor(112)).toBeNull();
    expect(parBoxCellFor(350)).toBeNull();
    expect(parBoxCellFor(0)).toBeNull();
  });
});

describe("the regression itself", () => {
  it("no longer resolves a par through the first-match price lookup", () => {
    // FIVE OF SIX were wrong. $100 is excluded because its par box and its
    // first-match cell are genuinely the same coordinate, (6, 10) -- which
    // is exactly why the bug read as intermittent.
    const wrongBefore = PAR_BOX_PRICES.filter((par) => par !== 100);
    for (const par of wrongBefore) {
      expect(parBoxCellFor(par)).not.toEqual(marketCellForPrice(par));
    }
  });

  it("still sends a par's first-match lookup to the chart's top row", () => {
    // `marketCellForPrice` keeps its own (correct, different) job. If this
    // ever starts matching the par box, the two have been conflated again.
    for (const par of PAR_BOX_PRICES) {
      expect(marketCellForPrice(par)?.y).toBe(10);
    }
  });
});

describe("placeParMark", () => {
  /* Design note #646: `toMatchObject`, not `toEqual`. A mark now also carries
     `enteredAt` -- the arrival ordinal the operating-order tie-break reads --
     and these tests are about WHERE the token lands, not about its history.
     Asserting the whole object made them fail for a field they have no
     opinion on; `operatingOrderTieBreak.test.ts` is where the stamp is
     checked. */
  it("places a newly parred token in its par box", () => {
    const placed = placeParMark({}, 6 /* ERIE */, 67, parBoxCellFor);
    expect(placed[6]).toMatchObject({ price: 67, x: 6, y: 5 });
  });

  it("places every par value where the board draws its box", () => {
    for (const [par, x, y] of EXPECTED_PAR_BOXES) {
      expect(placeParMark({}, 1, par, parBoxCellFor)[1]).toMatchObject({ price: par, x, y });
    }
  });

  it("leaves a token that has already walked the chart alone", () => {
    // A mark that exists is a marker somewhere on the board; re-reading the
    // par value must not drag it home.
    const walked = { 1: { price: 112, x: 7, y: 10 } };
    expect(placeParMark(walked, 1, 100, parBoxCellFor)).toBe(walked);
  });

  it("places nothing for a par with no box, rather than guessing a cell", () => {
    // The "not on the market chart" half of the report. A token placed at a
    // fabricated coordinate would be worse than an absent one.
    expect(placeParMark({}, 1, 113, parBoxCellFor)).toEqual({});
  });
});

describe("the offered par ladder and the board's par boxes", () => {
  it("offers exactly the six values the board has boxes for", () => {
    // Drift here is invisible and permanent: a rung with no box pars a
    // corporation that then never appears on the matrix.
    expect(PAR_VALUE_LADDER).toEqual(PAR_BOX_PRICES.map(String));
  });

  it("gives every offered rung a resolvable box", () => {
    for (const rung of PAR_VALUE_LADDER) {
      expect(parBoxCellFor(Number(rung))).not.toBeNull();
    }
  });
});
