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

import { applyCardOrder, openingCardOrder, operatingRoundCardOrder } from "./corporationCardOrder";
import { readStripped } from "./sourceScan";
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

  /* Design note #1350: three groups, and the spectrum under them. */
  it("groups floated, then parred (by par), then unbought (by spectrum)", () => {
    const roster = [
      { company_id: 2, is_floated: false, par_value: null, ticker: "NYC" }, // black: last of the spectrum
      { company_id: 1, is_floated: false, par_value: null, ticker: "PRR" }, // red: first
      { company_id: 6, is_floated: false, par_value: "67", ticker: "ERIE" }, // parred, low
      { company_id: 4, is_floated: false, par_value: "100", ticker: "B&O" }, // parred, high
      { company_id: 5, is_floated: true, par_value: "82", ticker: "C&O" },
      { company_id: 3, is_floated: true, par_value: "71", ticker: "CPR" },
    ];
    expect(operatingRoundCardOrder(roster, { 5: 82, 3: 90 })).toEqual([3, 5, 4, 6, 1, 2]);
  });

  it("opens in the spectrum order, red to violet, neutrals last", () => {
    const roster = ["NYC", "PMQ", "PRR", "N&W", "ERIE", "NNH", "B&M", "C&O", "B&O", "CPR"].map((ticker, i) => ({
      company_id: i + 1,
      is_floated: false,
      ticker,
    }));
    const ordered = openingCardOrder(roster).map((id) => roster[id - 1].ticker);
    expect(ordered).toEqual(["PRR", "NNH", "CPR", "ERIE", "B&M", "C&O", "B&O", "PMQ", "N&W", "NYC"]);
    // And the panel uses it until the first Operating Round establishes an order.
    expect(readStripped("components/StockRoundPanel.tsx")).toContain(
      "applyCardOrder(publicCompanies, cardOrder ?? openingCardOrder(publicCompanies))",
    );
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

  /* Design note #1343: ONE LINE PER FLOAT. A corporation that owes a home token is announced at the
     placement (`actionLog.ts`), so this is silent for it; a herald home (PRR on 18XX+/LPF) and a corporation
     with no home hex are announced here, in the ruled shape, with no "must now be placed". */
  it("is silent for a corporation that owes a home token -- the placement line says it all", () => {
    expect(
      describeFloat(unfloated, {
        ticker: "PRR",
        treasury: "1000",
        is_floated: true,
        home_hex_label: "H12",
      }),
    ).toBeNull();
    expect(
      describeFloat(
        { is_floated: false, station_token_hexes: [] },
        { ticker: "ERIE", treasury: "710", is_floated: true, home_hex_label: "E11", station_token_hexes: [] },
      ),
    ).toBeNull();
  });

  it("says so, in the ruled shape, for a corporation that genuinely has no home hex", () => {
    const line = describeFloat(unfloated, {
      ticker: "NNH",
      treasury: "670",
      is_floated: true,
      home_hex_label: null,
    });
    expect(line).toContain("NNH has floated. It received $670.");
    expect(line).toMatch(/no home hex on this board/i);
    expect(line).not.toContain("must now be placed");
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
