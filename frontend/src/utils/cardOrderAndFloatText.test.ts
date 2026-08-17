// frontend/src/utils/cardOrderAndFloatText.test.ts
//
// ==================================================================
//  DESIGN NOTES 464 / 467 (harness)
// ==================================================================
//
// Two changes that are easy to regress by "improving" them back:
//
//   THE CARD ORDER is deliberately NOT recomputed continuously. A future
//   pass reading `applyCardOrder` and thinking "this should just sort" would
//   reintroduce the reported bug exactly. The tests below assert the held
//   order survives a float, which is the property that costs something to
//   maintain and is therefore the one worth pinning.
//
//   THE FLOAT LINE broke because a branch went stale under it -- the token
//   stopped being placed at float, so the "gained a token" test never fired
//   and every corporation got the sentence written for the one with no home
//   hex. The tests name PRR and NNH specifically, because the bug was
//   reported as "PRR says it has no home hex" and the fix must not simply
//   swap which company is wrong.

import { applyCardOrder, operatingRoundCardOrder } from "./corporationCardOrder";
import { describeFloat } from "./sandboxSession";

const corp = (company_id: number, is_floated = true) => ({ company_id, is_floated });

describe("operatingRoundCardOrder", () => {
  it("sorts by market price, highest first", () => {
    const order = operatingRoundCardOrder([corp(1), corp(2), corp(8)], {
      1: 67,
      2: 112,
      8: 90,
    });
    expect(order).toEqual([2, 8, 1]);
  });

  it("puts floated corporations ahead of unfloated ones", () => {
    const order = operatingRoundCardOrder([corp(1, false), corp(2), corp(8, false)], {
      2: 67,
    });
    expect(order[0]).toBe(2);
  });

  it("sorts a company with no market position last, not as $0", () => {
    // A corporation with no token on the chart is absent from the operating
    // order, not the cheapest member of it.
    const order = operatingRoundCardOrder([corp(1), corp(2), corp(3)], {
      1: 67,
      2: null,
      3: 90,
    });
    expect(order).toEqual([3, 1, 2]);
  });

  it("breaks ties stably on company_id", () => {
    // Two corporations at one price must not swap on an unrelated render.
    const prices = { 1: 90, 2: 90, 8: 90 };
    const first = operatingRoundCardOrder([corp(8), corp(2), corp(1)], prices);
    const second = operatingRoundCardOrder([corp(1), corp(8), corp(2)], prices);
    expect(first).toEqual([1, 2, 8]);
    expect(second).toEqual(first);
  });
});

describe("applyCardOrder -- the held arrangement", () => {
  const roster = [corp(1), corp(2), corp(8)];

  it("leaves the roster alone when no order has been established", () => {
    // Before the first Operating Round there is nothing to apply, and the
    // contract's own table order is the neutral answer.
    expect(applyCardOrder(roster, null).map((c) => c.company_id)).toEqual([1, 2, 8]);
    expect(applyCardOrder(roster, []).map((c) => c.company_id)).toEqual([1, 2, 8]);
  });

  it("files the roster into the held order", () => {
    expect(applyCardOrder(roster, [8, 1, 2]).map((c) => c.company_id)).toEqual([8, 1, 2]);
  });

  it("HOLDS that order when a company floats mid-Stock-Round", () => {
    // The reported bug in one assertion. The roster changes -- company 1
    // floats -- and the arrangement must not move under the player.
    const held = [8, 1, 2];
    const before = applyCardOrder(
      [corp(1, false), corp(2), corp(8)],
      held,
    ).map((c) => c.company_id);
    const after = applyCardOrder([corp(1, true), corp(2), corp(8)], held).map(
      (c) => c.company_id,
    );
    expect(after).toEqual(before);
    expect(after).toEqual(held);
  });

  it("holds the order when prices move too", () => {
    // Dividends move the chart every Operating Round; the cards must not
    // chase it.
    const held = [1, 2, 8];
    expect(applyCardOrder(roster, held).map((c) => c.company_id)).toEqual(held);
  });

  it("appends a company the held order has never seen", () => {
    // Rather than dropping it or forcing a re-sort.
    const grown = [...roster, corp(4)];
    expect(applyCardOrder(grown, [8, 1, 2]).map((c) => c.company_id)).toEqual([8, 1, 2, 4]);
  });
});

describe("describeFloat", () => {
  const unfloated = { is_floated: false };

  it("names the home hex that must now be placed", () => {
    // The requirement's exact sentence.
    expect(
      describeFloat(unfloated, {
        ticker: "PRR",
        treasury: "1000",
        is_floated: true,
        home_hex_label: "H12",
      }),
    ).toBe("PRR floated with $1000. Its home station on H12 must now be placed.");
  });

  it("no longer tells the PRR it has no home hex", () => {
    // The reported bug, asserted as an absence so any reworded version of
    // the same mistake still fails.
    const line = describeFloat(unfloated, {
      ticker: "PRR",
      treasury: "1000",
      is_floated: true,
      home_hex_label: "H12",
    });
    expect(line).not.toMatch(/no home hex/i);
  });

  it("still says so for a corporation that genuinely has none", () => {
    // NNH. The old sentence was always right about this one.
    const line = describeFloat(unfloated, {
      ticker: "NNH",
      treasury: "670",
      is_floated: true,
      home_hex_label: null,
    });
    expect(line).toMatch(/no home hex on this board/i);
    expect(line).toContain("NNH floated with $670.");
  });

  it("does not depend on a token having been placed", () => {
    // Design note #416 stopped placing the token at float, which is what
    // made the old `gained` test permanently false. An empty token list must still
    // produce the placement sentence.
    expect(
      describeFloat(
        { is_floated: false, station_token_hexes: [] },
        {
          ticker: "ERIE",
          treasury: "710",
          is_floated: true,
          home_hex_label: "E11",
          station_token_hexes: [],
        },
      ),
    ).toContain("Its home station on E11 must now be placed.");
  });

  it("says nothing when there is no float to report", () => {
    expect(
      describeFloat({ is_floated: true }, {
        ticker: "PRR",
        treasury: "1000",
        is_floated: true,
        home_hex_label: "H12",
      }),
    ).toBeNull();
    expect(
      describeFloat(unfloated, {
        ticker: "PRR",
        treasury: "0",
        is_floated: false,
        home_hex_label: "H12",
      }),
    ).toBeNull();
  });
});
