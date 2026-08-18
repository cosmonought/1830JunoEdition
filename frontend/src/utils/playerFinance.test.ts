// frontend/src/utils/playerFinance.test.ts
//
// ==================================================================
//  DESIGN NOTE 562 (harness): THE GAP IS THE POINT
// ==================================================================
//
// Net Worth and Liquidity look like the same number and answer opposite
// questions, so most of these tests are about the DIFFERENCE between them
// rather than about either in isolation. A bug here would not look like a
// wrong figure -- it would look like two plausible figures that happened to
// agree, on a card whose whole reason for showing both is that they usually
// should not.

import { playerFinances } from "./playerFinance";
import type { GameStateResponse } from "./gameState";

const ADA = "p-ada";
const BEN = "p-ben";
const CAI = "p-cai";

const PRICES = { 1: 100, 2: 50 } as const;

function board(options: {
  adaPrr?: number;
  benPrr?: number;
  caiPrr?: number;
  adaNyc?: number;
  prrPresident?: string | null;
  /** Design note #566: `null` is a corporation with NO price of any kind. */
  prrPar?: string | null;
  privates?: Array<{ id: number; owner: string | null }>;
  cash?: string;
}): GameStateResponse {
  const {
    adaPrr = 0,
    benPrr = 0,
    caiPrr = 0,
    adaNyc = 0,
    prrPresident = null,
    prrPar = "100",
    privates = [],
    cash = "500",
  } = options;
  const holders = (prr: number, nyc: number) => [
    ...(prr > 0 ? [{ player: ADA, percentage: prr }] : []),
    ...(nyc > 0 ? [{ player: ADA, percentage: nyc }] : []),
  ];
  void holders;
  return {
    player_addresses: [ADA, BEN, CAI],
    player_cash: [
      { player: ADA, cash_vgp: cash },
      { player: BEN, cash_vgp: "500" },
      { player: CAI, cash_vgp: "500" },
    ],
    public_companies: [
      {
        company_id: 1,
        ticker: "PRR",
        president: prrPresident,
        par_value: prrPar,
        is_floated: true,
        bank_pool_percentage: 0,
        player_holdings: [
          ...(adaPrr > 0 ? [{ player: ADA, percentage: adaPrr }] : []),
          ...(benPrr > 0 ? [{ player: BEN, percentage: benPrr }] : []),
          ...(caiPrr > 0 ? [{ player: CAI, percentage: caiPrr }] : []),
        ],
      },
      {
        company_id: 2,
        ticker: "NYC",
        president: null,
        par_value: "50",
        is_floated: true,
        bank_pool_percentage: 0,
        player_holdings: adaNyc > 0 ? [{ player: ADA, percentage: adaNyc }] : [],
      },
    ],
    private_companies: privates.map(({ id, owner }) => ({
      private_id: id,
      name: `Private ${id}`,
      cost: "40",
      revenue_per_or: "10",
      owner,
      owner_protocol_id: null,
      closed: false,
    })),
  } as unknown as GameStateResponse;
}

const finances = (state: GameStateResponse, who = ADA, settled?: Record<number, number>) =>
  playerFinances(who, state, PRICES, settled);

describe("playerFinances figures", () => {
  it("counts cash, portfolio and net worth", () => {
    const f = finances(board({ adaPrr: 30 }))!;
    expect(f.cash).toBe(500);
    expect(f.stockValue).toBe(300);
    expect(f.netWorth).toBe(800);
  });

  it("counts shares in 10% blocks, not certificates", () => {
    /* A presidency is TWO shares and ONE certificate. The card shows both
       rows and they must not agree by accident. */
    const f = finances(board({ adaPrr: 20, prrPresident: ADA }))!;
    expect(f.shares).toBe(2);
    expect(f.certificates).toBe(1);
  });

  it("reports the certificate limit for the seat count", () => {
    // Three players: 20 in the printed 1830 table.
    expect(finances(board({}))!.certificateLimit).toBe(20);
  });
});

describe("net worth against liquidity", () => {
  it("locks a presidency nobody can take over", () => {
    /* THE CASE THE CARD EXISTS FOR. Ada is president with 20%; nobody else
       holds enough to succeed her, so 1830 will not let her sell -- her net
       worth counts the block and her liquidity cannot. */
    const f = finances(board({ adaPrr: 20, prrPresident: ADA, benPrr: 10 }))!;
    expect(f.netWorth).toBe(700);
    expect(f.liquidity).toBe(500);
    expect(f.liquidity).toBeLessThan(f.netWorth as number);
  });

  it("frees the presidency once a successor exists", () => {
    // Ben holds 20% and can take over, so the block becomes sellable.
    const f = finances(board({ adaPrr: 20, prrPresident: ADA, benPrr: 20 }))!;
    expect(f.liquidity).toBe(f.netWorth);
  });

  it("counts ordinary shares as fully liquid", () => {
    const f = finances(board({ adaPrr: 30 }))!;
    expect(f.liquidity).toBe(800);
  });

  it("values shares at par when the chart has no position", () => {
    /* CORRECTED TWICE, and both corrections are the same lesson from
       opposite sides.

       FIRST it asserted that an UNFLOATED company's shares cannot be sold.
       That failed: `sellableHoldings` keys on whether there is a PRICE, not
       on float, and it is right to -- a started-but-unfloated corporation
       sits at its par position and its shares sell perfectly well.

       THEN, rewritten to pass `{1: null}`, it failed again once design note
       #566 landed -- because a corporation holding a par is no longer
       unpriced. Which is exactly the intended change: par is the figure the
       IPO is charging right now, and reading it is not estimating.

       Both times the code was right about 1830 and the test was asserting a
       tidier rule than the game has. */
    const f = playerFinances(ADA, board({ adaPrr: 30 }), { 1: null, 2: 50 })!;
    expect(f.stockValue).toBe(300);
    expect(f.liquidity).toBe(800);
  });

  it("gives a company with no price of any kind no sale value", () => {
    /* The case the dash IS for: no chart position AND no par. Nobody can
       value these shares, so the figure is withheld rather than guessed. */
    const state = board({ adaPrr: 30, prrPar: null });
    const f = playerFinances(ADA, state, { 1: null, 2: 50 })!;
    expect(f.netWorth).toBeNull();
    expect(f.liquidity).toBe(500);
  });

  it("agrees with net worth for a player holding only cash", () => {
    const f = finances(board({}))!;
    expect(f.netWorth).toBe(500);
    expect(f.liquidity).toBe(500);
  });
});

describe("holdings and privates", () => {
  it("lists one row per corporation held, and none for the rest", () => {
    const f = finances(board({ adaPrr: 30, adaNyc: 10 }))!;
    expect(f.holdings.map((h) => h.ticker)).toEqual(["PRR", "NYC"]);
  });

  it("marks the presidency on the row it belongs to", () => {
    const f = finances(board({ adaPrr: 20, adaNyc: 10, prrPresident: ADA }))!;
    expect(f.holdings.find((h) => h.ticker === "PRR")?.isPresident).toBe(true);
    expect(f.holdings.find((h) => h.ticker === "NYC")?.isPresident).toBe(false);
  });

  it("lists only the privates this player owns", () => {
    const state = board({
      privates: [
        { id: 1, owner: ADA },
        { id: 2, owner: BEN },
        { id: 3, owner: null },
      ],
    });
    expect(finances(state)!.privates.map((p) => p.privateId)).toEqual([1]);
    expect(finances(state, BEN)!.privates.map((p) => p.privateId)).toEqual([2]);
  });

  it("returns an empty list rather than null when they own no privates", () => {
    /* Design note #563a: the card decides whether to render the table from
       this, so "none" has to be a list and not an absence. */
    expect(finances(board({}))!.privates).toEqual([]);
  });

  it("values a private at what it actually sold for", () => {
    /* Design note #303: a mini-auction settles ABOVE the printed cost, and
       quoting the printed figure would understate the holding by exactly
       what the contest cost. */
    const state = board({ privates: [{ id: 1, owner: ADA }] });
    expect(finances(state)!.privates[0].value).toBe(40);
    expect(finances(state, ADA, { 1: 185 })!.privates[0].value).toBe(185);
  });
});

describe("missing data", () => {
  it("returns null without a board", () => {
    expect(playerFinances(ADA, null, PRICES)).toBeNull();
  });

  it("propagates null rather than reporting a player as broke", () => {
    /* No cash RECORD is not zero cash. A card printing $0 here would state
       something false about a player's position, and $0 is the one figure a
       reader would act on immediately. */
    const state = board({});
    const f = playerFinances("p-nobody", state, PRICES)!;
    expect(f.cash).toBeNull();
    expect(f.netWorth).toBeNull();
    expect(f.liquidity).toBeNull();
  });
});
