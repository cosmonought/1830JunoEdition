/** @jest-environment node */
//
// The Operating Round table's order. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 753 (harness): THE TABLE MOVED, THE ROUND DID NOT
// ==================================================================
//
// REPORTED: "it appears the Operating Round--Corporations panel re-orders itself after every corporation
// acts, but this is somewhat confusing because you can end up with a corporation appearing to take its turn
// after another corporation has acted. Let's set this panel's table to refresh/re-order at the start of each
// OR rather than continuously with each corporation's actions."
//
// THE DISCRIMINATING TEST HAS TO MOVE A PRICE MID-ROUND, and that is why this was never caught: on a static
// board the frozen queue and the live comparison agree exactly. They part company the moment a dividend
// lands, which is once per corporation per round -- so the bug was in the one situation nobody builds a
// fixture for and every real game produces immediately.
//
// AND THE FIX IS A DELETION IN DISGUISE. #449 reproduced `buildOperatingOrder`'s comparison rather than
// importing it, for a stated and sound reason -- that function returns only the floated queue while the
// table shows everybody. The conclusion was wrong because a REPRODUCED comparison re-runs against today's
// inputs, and the queue is a decision, not a formula. Same lesson as #734 and #741 from a third direction.

import { operatingOrderRanks, sortForOperatingOrder } from "./operatingOrderView";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const PRR = 1;
const BO = 2;
const NYC = 3;
const ERIE = 4;

function corp(companyId: number, ticker: string, over: Record<string, unknown> = {}) {
  return {
    company_id: companyId,
    ticker,
    is_floated: true,
    par_value: "100",
    ...over,
  } as unknown as PublicCompanyState;
}

const queue = (order: number[]) =>
  ({ active_operating_order: order }) as unknown as GameStateResponse;

const tickers = (rows: PublicCompanyState[]) => rows.map((row) => row.ticker);

describe("the frozen queue decides", () => {
  const companies = [corp(PRR, "PRR"), corp(BO, "B&O"), corp(NYC, "NYC")];

  it("renders in queue order, not price order", () => {
    /* The queue was built when the round opened; the prices below deliberately disagree with it. If the
       table read prices, NYC would lead. */
    const rows = sortForOperatingOrder(companies, {
      ranks: operatingOrderRanks(queue([PRR, BO, NYC])),
      priceFor: (id) => ({ [PRR]: 82, [BO]: 90, [NYC]: 150 })[id] ?? 0,
    });
    expect(tickers(rows)).toEqual(["PRR", "B&O", "NYC"]);
  });

  it("does not move when a price moves mid-round", () => {
    /* THE REPORT. B&O pays a dividend and climbs past PRR; the round order is unchanged, so the table must
       be too. This is the assertion the old comparison failed. */
    const before = sortForOperatingOrder(companies, {
      ranks: operatingOrderRanks(queue([PRR, BO, NYC])),
      priceFor: (id) => ({ [PRR]: 100, [BO]: 90, [NYC]: 82 })[id] ?? 0,
    });
    const afterDividend = sortForOperatingOrder(companies, {
      ranks: operatingOrderRanks(queue([PRR, BO, NYC])),
      priceFor: (id) => ({ [PRR]: 100, [BO]: 200, [NYC]: 82 })[id] ?? 0,
    });
    expect(tickers(afterDividend)).toEqual(tickers(before));
  });

  it("would have moved under the old comparison, so the fixture tests what it claims", () => {
    // The control: the prices above really are enough to reorder a price-sorted list.
    const priced = [...companies].sort(
      (a, b) =>
        (({ [PRR]: 100, [BO]: 200, [NYC]: 82 })[b.company_id] ?? 0) -
        (({ [PRR]: 100, [BO]: 200, [NYC]: 82 })[a.company_id] ?? 0),
    );
    expect(tickers(priced)).toEqual(["B&O", "PRR", "NYC"]);
  });
});

describe("corporations outside the queue", () => {
  it("come after every corporation in it", () => {
    /* An unfloated corporation is not in the round at all -- #449's "not somewhere in the middle of the
       operating order, it is absent from it". The queue says so directly now. */
    const rows = sortForOperatingOrder(
      [corp(PRR, "PRR"), corp(ERIE, "ERIE", { is_floated: false, par_value: null })],
      { ranks: operatingOrderRanks(queue([PRR])), priceFor: () => 0 },
    );
    expect(tickers(rows)).toEqual(["PRR", "ERIE"]);
  });

  it("keeps any corporation the queue omits out of this round's order", () => {
    /* THIS TEST WAS WRITTEN AS A BUG FIX AND IS NOT ONE. It claimed to cover a corporation that floated
       mid-Operating-Round. REPORTED BACK: "corporations will never and cannot float during an Operating
       Round, only a Stock Round" -- floating is caused by a share purchase, so the scenario cannot arise.
       KEPT AS AN INVARIANT, which is what it always actually asserted: absence from the queue outranks any
       price. That is what holds an unfloated corporation out of the operating order, and NYC carrying the
       highest price on the board and still sorting last is the sharpest way to say it. */
    const rows = sortForOperatingOrder(
      [corp(PRR, "PRR"), corp(BO, "B&O"), corp(NYC, "NYC")],
      {
        ranks: operatingOrderRanks(queue([PRR, BO])),
        priceFor: (id) => ({ [PRR]: 82, [BO]: 76, [NYC]: 350 })[id] ?? 0,
      },
    );
    expect(tickers(rows)).toEqual(["PRR", "B&O", "NYC"]);
  });

  it("sorts the tail by price, so it is readable rather than arbitrary", () => {
    /* #449's comparison survives where it is harmless: nothing outside the queue is taking a turn, so its
       position cannot misrepresent one. */
    const rows = sortForOperatingOrder(
      [corp(NYC, "NYC"), corp(ERIE, "ERIE"), corp(BO, "B&O")],
      { ranks: operatingOrderRanks(queue([])), priceFor: (id) => ({ [NYC]: 71, [ERIE]: 100, [BO]: 82 })[id] ?? 0 },
    );
    expect(tickers(rows)).toEqual(["ERIE", "B&O", "NYC"]);
  });

  it("puts unfloated last even against a high par", () => {
    const rows = sortForOperatingOrder(
      [corp(ERIE, "ERIE", { is_floated: false, par_value: "100" }), corp(NYC, "NYC", { par_value: "67" })],
      { ranks: operatingOrderRanks(queue([])), priceFor: () => null },
    );
    expect(tickers(rows)).toEqual(["NYC", "ERIE"]);
  });
});

describe("the awkward shapes", () => {
  it("copes with no queue at all", () => {
    /* The table is visible outside an Operating Round. Falling back to the comparison keeps #449's fix
       there; falling back to nothing would restore `company_id` order, which is what #449 removed. */
    const rows = sortForOperatingOrder([corp(NYC, "NYC"), corp(PRR, "PRR")], {
      ranks: operatingOrderRanks({} as GameStateResponse),
      priceFor: (id) => ({ [NYC]: 90, [PRR]: 71 })[id] ?? 0,
    });
    expect(tickers(rows)).toEqual(["NYC", "PRR"]);
  });

  it("ignores a duplicate in the queue rather than ranking it twice", () => {
    const ranks = operatingOrderRanks(queue([PRR, BO, PRR]));
    expect(ranks.get(PRR)).toBe(0);
    expect(ranks.get(BO)).toBe(1);
  });

  it("does not mutate the array it is given", () => {
    // The panel passes `gameState.public_companies` straight in.
    const companies = [corp(NYC, "NYC"), corp(PRR, "PRR")];
    sortForOperatingOrder(companies, {
      ranks: operatingOrderRanks(queue([PRR])),
      priceFor: () => 0,
    });
    expect(tickers(companies)).toEqual(["NYC", "PRR"]);
  });

  it("ranks a queue entry for a corporation that is not on the board", () => {
    // A stale id in the queue must not throw or reorder anything real.
    const rows = sortForOperatingOrder([corp(PRR, "PRR")], {
      ranks: operatingOrderRanks(queue([99, PRR])),
      priceFor: () => 0,
    });
    expect(tickers(rows)).toEqual(["PRR"]);
  });
});

describe("the panel reads the queue", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the note quotes the old comparison and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("has no local re-sort left", () => {
    /* THE STRUCTURAL HALF. Every behavioural test above passes against a table that still sorts by price,
       because they test the helper. This one is about the caller. */
    const panel = read("components/ContextualSubPanel.tsx");
    expect(panel).not.toMatch(/priceOf\(b\) - priceOf\(a\) \|\| a\.company_id - b\.company_id/);
    expect(panel).toContain("sortForOperatingOrder(gameState.public_companies");
  });
});
