/** @jest-environment node */
//
// No React, no DOM: this file exercises one pure function over plain objects. The docblock opts it out of
// jsdom, which halves the runner's start-up cost for it. Per-file rather than global -- a component test that
// arrived later under a global `node` default would fail with a confusing error instead of an obvious one.
// frontend/src/utils/playerLiquidity.test.ts
//
// ==================================================================
//  DESIGN NOTE 710 (harness): WHAT A PLAYER COULD ACTUALLY RAISE
// ==================================================================
//
// REPORTED: "On Game Ledger > Player Assets, there is a column labeled 'Liquid Cash.' Cash is by definition
// liquid. I think what is missing in this table is a LIQUIDITY column that shows cash + sellable stocks."
//
// Both halves were right, and the second one was already half-built: design note #562a defined liquidity in
// exactly those terms and `PlayerCards` has shown it since. The Ledger simply never got the column, so the
// adjective on "Liquid Cash" was standing in for a figure that existed one component away.
//
// SO THE WORK WAS NOT THE ARITHMETIC, IT WAS AVOIDING A SECOND COPY OF IT. The Ledger and the card values
// shares by different policies (#566: the card falls back to par, the Ledger does not), and the tempting shape
// -- reduce over `sellableHoldings` at each call site -- would have put the same sum in two files against two
// price resolvers. That is how two columns both labelled "Liquidity" come to disagree about a player.
// `playerLiquidity` takes the resolver as a parameter so the POLICY differs and the SUM cannot.
//
// WHAT THIS FILE PINS is the boundary between "may be sold" and "is worth". The selling rules already have
// their own harness on `sellableHoldings`; what is new here is the total.
//
// A FIRST DRAFT GOT THE UNPRICED CASE BACKWARDS, and it is worth keeping the correction. It returned `null`
// the moment a sellable holding had no price, reasoning from #566 that an under-report is indistinguishable
// from a correct smaller number. REPORTED: "if a share has no market price it is unsellable, so it should
// either be excluded or count as $0 -- and the only case in which this can ever happen is the 10% PRR share
// granted by the private company before PRR pars/sells its President's Share."
// Nothing is being under-reported. An unparred share cannot be sold to anybody at any figure, which is
// exactly what this column measures, so $0 is the measurement.

import { playerLiquidity } from "./endgame";
import type { GameStateResponse } from "./gameState";

const ME = "me";
const RIVAL = "rival";

function board(
  companies: {
    id: number;
    ticker: string;
    president?: string;
    pool?: number;
    holdings: { player: string; percentage: number }[];
  }[],
): GameStateResponse {
  return {
    public_companies: companies.map((entry) => ({
      company_id: entry.id,
      ticker: entry.ticker,
      president: entry.president ?? null,
      bank_pool_percentage: entry.pool ?? 0,
      ipo_pool_percentage: 0,
      player_holdings: entry.holdings,
    })),
  } as unknown as GameStateResponse;
}

/** $100 a certificate for every corporation, unless a company is listed as unpriced. */
function pricedAt(price: number, unpriced: number[] = []) {
  return (companyId: number) => (unpriced.includes(companyId) ? null : price);
}

describe("liquidity is cash plus what may be sold, not cash plus what is held", () => {
  it("adds ordinary shares at their market price", () => {
    // 30% held, nothing in the pool: three certificates at $100.
    const state = board([{ id: 1, ticker: "B&O", holdings: [{ player: ME, percentage: 30 }] }]);
    expect(playerLiquidity(state, ME, 200, pricedAt(100))).toBe(500);
  });

  it("is just cash for a player holding nothing", () => {
    expect(playerLiquidity(board([]), ME, 200, pricedAt(100))).toBe(200);
  });

  it("stops at the pool's 50% cap", () => {
    /* THE RESTRICTION A PLAYER CAN SEE COMING, at least: the market shows the pool. 40% already there leaves
       room for one certificate, so 30% held raises $100 rather than $300. */
    const state = board([
      { id: 1, ticker: "B&O", pool: 40, holdings: [{ player: ME, percentage: 30 }] },
    ]);
    expect(playerLiquidity(state, ME, 0, pricedAt(100))).toBe(100);
  });

  it("counts nothing when the pool is already full", () => {
    const state = board([
      { id: 1, ticker: "B&O", pool: 50, holdings: [{ player: ME, percentage: 30 }] },
    ]);
    expect(playerLiquidity(state, ME, 250, pricedAt(100))).toBe(250);
  });
});

describe("a presidency is not liquid unless somebody can take it", () => {
  it("leaves the block behind with no successor", () => {
    /* THE RESTRICTION WORTH NAMING IN THE TOOLTIP. 60% held as president: the 20% block is stuck because no
       other player holds 20%, so only the four ordinary certificates are sellable. */
    const state = board([
      {
        id: 1,
        ticker: "B&O",
        president: ME,
        holdings: [
          { player: ME, percentage: 60 },
          { player: RIVAL, percentage: 10 },
        ],
      },
    ]);
    // 60 - 20 = 40% ordinary, but the pool caps the sale at 50%: four certificates, $400.
    expect(playerLiquidity(state, ME, 0, pricedAt(100))).toBe(400);
  });

  it("releases the block once a rival holds 20%", () => {
    const state = board([
      {
        id: 1,
        ticker: "B&O",
        president: ME,
        holdings: [
          { player: ME, percentage: 40 },
          { player: RIVAL, percentage: 20 },
        ],
      },
    ]);
    // 20% ordinary + the 20% block, both fitting under the empty pool's 50%: $400.
    expect(playerLiquidity(state, ME, 0, pricedAt(100))).toBe(400);
  });

  it("differs from net worth by exactly the shares that are stuck", () => {
    /* THE GAP THE COLUMN EXISTS FOR, stated as the relationship rather than as two numbers. #562a: "$2,000 of
       net worth against $200 of liquidity is one bad train purchase from bankruptcy." */
    const state = board([
      {
        id: 1,
        ticker: "B&O",
        president: ME,
        holdings: [{ player: ME, percentage: 20 }],
      },
    ]);
    const liquid = playerLiquidity(state, ME, 50, pricedAt(100));
    const heldAtMarket = 50 + 2 * 100; // what the same shares are WORTH
    expect(liquid).toBe(50);
    expect(liquid).toBeLessThan(heldAtMarket);
  });
});

describe("an unparred share raises nothing, and says so with a number", () => {
  it("counts it as zero rather than refusing the total", () => {
    /* Design note #711. The 30% priced at $100 raises $300; the 20% in a corporation nobody has parred raises
       nothing, because there is no price at which anyone may buy it. */
    const state = board([
      { id: 1, ticker: "B&O", holdings: [{ player: ME, percentage: 30 }] },
      { id: 2, ticker: "PRR", holdings: [{ player: ME, percentage: 20 }] },
    ]);
    expect(playerLiquidity(state, ME, 100, pricedAt(100, [2]))).toBe(400);
  });

  it("is the same answer whether the shares are unsellable or unpriced", () => {
    /* The two roads to zero, arriving together -- a full pool blocks a sale, and an unparred corporation has
       nothing to sell INTO. A player reading the column does not need to distinguish them, which is the
       argument for a figure rather than a dash. */
    const blockedByPool = board([
      { id: 1, ticker: "B&O", holdings: [{ player: ME, percentage: 30 }] },
      { id: 2, ticker: "PRR", pool: 50, holdings: [{ player: ME, percentage: 20 }] },
    ]);
    const blockedByPrice = board([
      { id: 1, ticker: "B&O", holdings: [{ player: ME, percentage: 30 }] },
      { id: 2, ticker: "PRR", holdings: [{ player: ME, percentage: 20 }] },
    ]);
    expect(playerLiquidity(blockedByPool, ME, 100, pricedAt(100, [2]))).toBe(400);
    expect(playerLiquidity(blockedByPrice, ME, 100, pricedAt(100, [2]))).toBe(400);
  });

  it("returns null only when the player's own cash is unknown", () => {
    // The one thing left that can make this unanswerable: a total starting from an unknown is unknown.
    const state = board([{ id: 1, ticker: "B&O", holdings: [{ player: ME, percentage: 30 }] }]);
    expect(playerLiquidity(state, ME, null, pricedAt(100))).toBeNull();
  });
});

describe("the resolver is the caller's and the sum is not", () => {
  it("prices through whatever ladder it is handed", () => {
    /* #711 retired #566's strict-versus-loose split -- `sharePriceFor` is the one ladder both surfaces read.
       The parameter stays because the RULES and the PRICES are separate questions, and this is the assertion
       that keeps them separable: the same board, two valuations, one arithmetic. */
    const state = board([{ id: 1, ticker: "B&O", holdings: [{ player: ME, percentage: 20 }] }]);
    expect(playerLiquidity(state, ME, 0, () => 0)).toBe(0);
    expect(playerLiquidity(state, ME, 0, () => 67)).toBe(134);
  });
});
