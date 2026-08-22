/** @jest-environment node */
//
// Pure rules and arithmetic over plain objects; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 713 (harness): WHAT A SALE COSTS THE PRICE
// ==================================================================
//
// REPORTED: "When Selling shares, we have the effect on the player's treasury listed, but we don't list the
// effect on the stock price. Remember that: i) sales happen before the stock price impact, and ii) sales drop
// (vertically) the stock price for each share sold. As you implement this, make sure that players cannot sell
// a President's share ... or sell so that more than 50% of a corporation's stock is in the bank."
//
// THE ORDER IS THE PART A TEST CAN HOLD. "Sales happen before the stock price impact" is one sentence and two
// arithmetics: every certificate in a bundle fetches TODAY's price, and the token then falls one row per
// certificate. Summing the ladder downward as it falls is the plausible wrong answer -- it looks more
// careful, and it under-pays every multi-share sale.
//
// AND ONE OF THE TWO GUARDS WAS ALREADY THERE. `sellOptionState` has enforced the pool's 50% cap for a long
// time; the president's successor rule was computed by `sellableHoldings` (#6) and consulted by nobody. So
// this file tests both, because a harness that only covered the new one would not notice if the old one were
// dropped while moving the rules into one place.

import { certificatesIn, saleProceeds, shareSaleBlock, type ShareSaleInput } from "./shareSale";
import type { GameStateResponse } from "./gameState";

const ME = "me";
const RIVAL = "rival";

function board(
  over: {
    held?: number;
    pool?: number;
    president?: string | null;
    others?: { player: string; percentage: number }[];
  } = {},
): GameStateResponse {
  return {
    public_companies: [
      {
        company_id: 1,
        ticker: "B&O",
        president: over.president === undefined ? null : over.president,
        par_value: "100",
        bank_pool_percentage: over.pool ?? 0,
        ipo_pool_percentage: 0,
        player_holdings: [
          ...(over.held ? [{ player: ME, percentage: over.held }] : []),
          ...(over.others ?? []),
        ],
      },
    ],
  } as unknown as GameStateResponse;
}

function selling(over: Partial<ShareSaleInput> = {}): ShareSaleInput {
  return { state: board({ held: 30 }), seller: ME, companyId: 1, percentage: 10, ...over };
}

describe("a sale settles before the price moves", () => {
  it("pays every certificate at today's price", () => {
    /* RULE (i). Three certificates of a $100 corporation raise $300 -- not $100 + $90 + $82 walking the
       token down as it goes, which is the careful-looking answer that under-pays. */
    expect(saleProceeds(100, 30)).toBe(300);
  });

  it("counts one certificate per 10%", () => {
    /* RULE (ii)'s COUNT. The drop is walked by `projectShareSaleMove`, which owns the direction ("DOWN is
       y - 1: this chart's y axis is inverted relative to the screen"); this module owns how many rows. */
    expect(certificatesIn(10)).toBe(1);
    expect(certificatesIn(30)).toBe(3);
    expect(certificatesIn(0)).toBe(0);
  });

  it("treats a president's 20% block as two rows, not one card", () => {
    /* The block is ONE certificate to the limit and TWO shares to the market. The price falls by what was
       SOLD, so dumping a presidency drops the token twice. */
    expect(certificatesIn(20)).toBe(2);
    expect(saleProceeds(100, 20)).toBe(200);
  });
});

describe("the bank pool caps at 50%", () => {
  it("refuses a sale that would overfill it", () => {
    expect(shareSaleBlock(selling({ state: board({ held: 30, pool: 40 }), percentage: 20 })))
      .toContain("caps at 50%");
  });

  it("allows the sale that fills it exactly", () => {
    expect(shareSaleBlock(selling({ state: board({ held: 30, pool: 40 }), percentage: 10 })))
      .toBeNull();
  });

  it("names how much room is left", () => {
    // #619: the number a player needs in order to pick a smaller bundle.
    expect(shareSaleBlock(selling({ state: board({ held: 30, pool: 45 }), percentage: 20 })))
      .toContain("only 5% more");
  });
});

describe("a president may not sell the block into nobody's hands", () => {
  it("refuses when no rival holds 20%", () => {
    /* THE RULE THAT WAS ENCODED AND UNUSED. 30% held as president, selling 20% would leave 10% -- under the
       block -- and the only rival holds 10%. */
    const state = board({
      held: 30,
      president: ME,
      others: [{ player: RIVAL, percentage: 10 }],
    });
    expect(shareSaleBlock(selling({ state, percentage: 20 }))).toContain("no other player holds 20%");
  });

  it("allows it once a rival reaches 20%", () => {
    const state = board({
      held: 30,
      president: ME,
      others: [{ player: RIVAL, percentage: 20 }],
    });
    expect(shareSaleBlock(selling({ state, percentage: 20 }))).toBeNull();
  });

  it("lets a president sell down TO the block", () => {
    /* THE BOUNDARY IN THE DIRECTION THAT MUST STAY OPEN. Selling 40% of a 60% holding leaves exactly 20% --
       the president keeps the certificate, so no successor is needed. Only selling INTO the block hands it
       over. (The pool caps this at 40%, which is why the holding is 60% rather than more.) */
    const state = board({ held: 60, president: ME });
    expect(shareSaleBlock(selling({ state, percentage: 40 }))).toBeNull();
  });

  it("never counts two rivals' holdings together", () => {
    /* #6's rule, stated as the thing that must NOT work: the certificate is one card and goes to one holder,
       so two players at 10% each cannot jointly succeed. A sum here would be a plausible and wrong fix. */
    const state = board({
      held: 30,
      president: ME,
      others: [
        { player: RIVAL, percentage: 10 },
        { player: "third", percentage: 10 },
      ],
    });
    expect(shareSaleBlock(selling({ state, percentage: 20 }))).not.toBeNull();
  });

  it("does not apply the rule to a player who is not president", () => {
    const state = board({
      held: 30,
      president: RIVAL,
      others: [{ player: RIVAL, percentage: 20 }],
    });
    expect(shareSaleBlock(selling({ state, percentage: 30 }))).toBeNull();
  });
});

describe("you cannot sell what you do not hold", () => {
  it("refuses a bundle larger than the holding", () => {
    expect(shareSaleBlock(selling({ state: board({ held: 10 }), percentage: 20 })))
      .toContain("not enough");
  });

  it("says nothing about a corporation this build cannot see", () => {
    // Not a refusal: a company absent from the response is not a company to reason about.
    expect(shareSaleBlock(selling({ companyId: 99 }))).toBeNull();
  });
});
