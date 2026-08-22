/** @jest-environment node */
//
// Pure rules over plain objects; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 712 (harness): THREE RULES AND THREE WAIVERS
// ==================================================================
//
// REPORTED: "Players are able to purchase more than 60% in a corporation even if its stock price isn't in the
// orange zone", and then: "make sure the other rules are encoded as well."
//
// Every one of them WAS encoded -- as a predicate, or as prose on the chart's own tooltips -- and none of them
// as a gate. That is the failure this file is built around: a rule the UI describes and the code does not
// apply is worse than a missing rule, because the chart teaches a player a ceiling exists and the game then
// lets them walk through it.
//
// SO EACH RULE IS TESTED TWICE: once where it BITES, and once in the zone that WAIVES it. A harness that only
// checked the waivers would pass against the reported bug, since the bug was that nothing bit anywhere.

import {
  allowsExtraPoolBuys,
  exceeds60Allowed,
  isExemptZone,
  maxPurchaseQuantity,
  sharePurchaseBlock,
  type SharePurchaseInput,
} from "./sharePurchase";
import type { GameStateResponse } from "./gameState";

const ME = "me";

function board(
  over: {
    held?: number;
    pool?: number;
    players?: number;
    others?: { player: string; percentage: number }[];
  } = {},
): GameStateResponse {
  const players = over.players ?? 4;
  return {
    player_addresses: Array.from({ length: players }, (_, at) => (at === 0 ? ME : `p${at}`)),
    private_companies: [],
    public_companies: [
      {
        company_id: 1,
        ticker: "B&O",
        president: null,
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

function buying(over: Partial<SharePurchaseInput> = {}): SharePurchaseInput {
  return {
    state: board(),
    buyer: ME,
    companyId: 1,
    source: "Ipo",
    quantity: 1,
    zone: "Normal",
    ...over,
  };
}

describe("no player may hold more than 60% of one corporation", () => {
  it("refuses the buy that would cross 60%", () => {
    // THE REPORT. 60% held, buying a seventh certificate.
    const block = sharePurchaseBlock(buying({ state: board({ held: 60 }) }));
    expect(block).toContain("more than 60%");
  });

  it("allows the buy that lands exactly on 60%", () => {
    /* The boundary, in the direction that must stay open: 60% is the cap, not the first illegal figure. */
    expect(sharePurchaseBlock(buying({ state: board({ held: 50 }) }))).toBeNull();
  });

  it("lifts the cap in Orange and Brown", () => {
    for (const zone of ["Orange", "Brown"] as const) {
      expect(sharePurchaseBlock(buying({ state: board({ held: 60 }), zone }))).toBeNull();
    }
  });

  it("keeps the cap in Yellow, which waives a different rule", () => {
    /* THE DISTINCTION THE THREE ZONES EXIST TO MAKE, and the one a "zone means privileges" reading would
       lose. Yellow exempts certificates from the LIMIT and says nothing about the ownership cap. */
    expect(sharePurchaseBlock(buying({ state: board({ held: 60 }), zone: "Yellow" }))).toContain(
      "more than 60%",
    );
  });

  it("names the zone that would lift it", () => {
    // #619, sharpened: a player denied at 60% can play toward the Orange zone if they are told it exists.
    expect(sharePurchaseBlock(buying({ state: board({ held: 60 }) }))).toContain("Orange");
  });

  it("counts the whole multi-buy against the cap, not one share of it", () => {
    const state = board({ held: 40, pool: 50 });
    const block = sharePurchaseBlock(
      buying({ state, zone: "Normal", source: "Bank", quantity: 3 }),
    );
    expect(block).not.toBeNull();
  });
});

describe("the certificate limit, and the zones that exempt from it", () => {
  /** A four-player room has a limit; fill the player up with holdings in OTHER corporations. */
  function crowded(zone: "Normal" | "Yellow", certs: number): GameStateResponse {
    const base = board();
    const extra = Array.from({ length: certs }, (_, at) => ({
      company_id: 100 + at,
      ticker: `X${at}`,
      president: null,
      par_value: "100",
      bank_pool_percentage: 0,
      ipo_pool_percentage: 0,
      player_holdings: [{ player: ME, percentage: 10 }],
    }));
    void zone;
    return {
      ...base,
      public_companies: [...base.public_companies, ...extra],
    } as unknown as GameStateResponse;
  }

  it("refuses a purchase that would exceed the limit", () => {
    /* A four-player room's limit is 16. Sixteen certificates held, all in Normal-zone corporations, so all
       sixteen count -- the seventeenth is refused. */
    const state = crowded("Normal", 16);
    const block = sharePurchaseBlock(buying({ state }));
    expect(block).toContain("certificates against a limit");
  });

  it("allows it when the purchase is into an exempt zone", () => {
    /* THE EXEMPTION, and note WHERE it applies: on the zone of the corporation being BOUGHT. A share that is
       exempt the moment it is held cannot push anybody over the limit. */
    const state = crowded("Normal", 16);
    for (const zone of ["Yellow", "Orange", "Brown"] as const) {
      expect(sharePurchaseBlock(buying({ state, zone }))).toBeNull();
    }
  });

  it("does not count certificates already held in exempt zones", () => {
    /* The other half: sixteen held, but priced into the Yellow zone, so none of them count and an ordinary
       seventeenth purchase is fine. This is what `certificateBreakdown`'s split is FOR. */
    const state = crowded("Normal", 16);
    const prices: Record<number, number> = {};
    for (const company of state.public_companies) prices[company.company_id] = 40;
    expect(
      sharePurchaseBlock(buying({ state, marketPrices: prices, zoneForPrice: () => "Yellow" })),
    ).toBeNull();
  });

  it("counts everything when there is no market data, which is the safe answer", () => {
    // #7: omitting the callback is a valid call, not a degraded one.
    const state = crowded("Normal", 16);
    expect(sharePurchaseBlock(buying({ state }))).not.toBeNull();
  });
});

describe("one purchase per turn, and Brown's pool allowance", () => {
  it("refuses a second purchase in the same turn", () => {
    expect(sharePurchaseBlock(buying({ boughtThisTurn: 1 }))).toContain("One certificate purchase");
  });

  it("allows several Brown pool shares", () => {
    const state = board({ pool: 40 });
    expect(
      sharePurchaseBlock(buying({ state, zone: "Brown", source: "Bank", quantity: 3 })),
    ).toBeNull();
  });

  it("does not extend the allowance to the IPO", () => {
    /* BOTH HALVES OF THE RULE. Brown is about the BANK POOL specifically -- an IPO share is still one a turn,
       however the corporation is priced. */
    const state = board({ pool: 40 });
    expect(
      sharePurchaseBlock(buying({ state, zone: "Brown", source: "Ipo", quantity: 3 })),
    ).toContain("Bank Pool");
  });

  it("does not extend it to Orange", () => {
    const state = board({ pool: 40 });
    expect(
      sharePurchaseBlock(buying({ state, zone: "Orange", source: "Bank", quantity: 3 })),
    ).not.toBeNull();
  });
});

describe("the selector cannot offer what the gate would refuse", () => {
  it("is one outside Brown", () => {
    expect(maxPurchaseQuantity(buying({ state: board({ pool: 50 }), source: "Bank" }))).toBe(1);
  });

  it("stops at the pool", () => {
    const state = board({ pool: 30 });
    expect(maxPurchaseQuantity(buying({ state, zone: "Brown", source: "Bank" }))).toBe(3);
  });

  it("stops at the certificate limit before the pool runs out", () => {
    /* #247's rule applied to shares: a control that offers a quantity the gate refuses reads as the UI being
       broken. Brown exempts from the limit, so the binding rule here is the pool -- stated as the case that
       PROVES the walk consults the gate rather than just dividing the pool by ten. */
    const state = board({ pool: 50 });
    expect(maxPurchaseQuantity(buying({ state, zone: "Brown", source: "Bank" }))).toBe(5);
  });

  it("never offers less than one", () => {
    expect(maxPurchaseQuantity(buying({ state: board({ pool: 0 }), zone: "Brown", source: "Bank" }))).toBe(1);
  });
});

describe("the zone predicates say what each zone is for", () => {
  it("separates the three privileges", () => {
    /* Stated as a table because the rules ACCUMULATE -- Brown has all three, Orange two, Yellow one -- and
       that shape is the thing a reader most often gets wrong. */
    expect([isExemptZone("Yellow"), exceeds60Allowed("Yellow"), allowsExtraPoolBuys("Yellow", "Bank")])
      .toEqual([true, false, false]);
    expect([isExemptZone("Orange"), exceeds60Allowed("Orange"), allowsExtraPoolBuys("Orange", "Bank")])
      .toEqual([true, true, false]);
    expect([isExemptZone("Brown"), exceeds60Allowed("Brown"), allowsExtraPoolBuys("Brown", "Bank")])
      .toEqual([true, true, true]);
    expect([isExemptZone("Normal"), exceeds60Allowed("Normal"), allowsExtraPoolBuys("Normal", "Bank")])
      .toEqual([false, false, false]);
  });

  it("treats an unpriced corporation as ordinary", () => {
    // `null` is "no zone", which is every rule in force -- never a privilege by accident.
    expect([isExemptZone(null), exceeds60Allowed(null), allowsExtraPoolBuys(null, "Bank")])
      .toEqual([false, false, false]);
  });
});
