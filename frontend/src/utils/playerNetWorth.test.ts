// frontend/src/utils/playerNetWorth.test.ts
//
// ==================================================================
//  DESIGN NOTE 497 (harness): "NOT CONNECTED" WAS NOT AN ANSWER
// ==================================================================
//
// The Game Ledger's Stock Value and Net Worth columns read "not connected"
// for the whole of sandbox, because both were gated on a query client the
// offline mode deliberately does not have. The figures were derivable the
// whole time -- `marketGrid` is already a prop of that panel and already
// unpacked into the very `marketPrices` map the placeholder was printed
// beside.
//
// WHAT IS ASSERTED IS THE ARITHMETIC AND THE UNKNOWNS, in that order of
// importance. The multiplication is easy to get right and easy to check; the
// interesting half is what happens when something is missing, because the
// tempting shortcut in every one of those cases is to substitute a zero --
// and a confident "$0 net worth" for a player holding five certificates is a
// worse bug than the blank this replaces.

import type { GameStateResponse } from "./gameState";
import { estimatePlayerNetWorth, estimateStockPortfolioValue } from "./gameState";

const ALICE = "juno1alice";
const BOB = "juno1bob";

/** Two corporations; Alice holds 30% of one and 20% of the other. */
/** Design note #711: `pars` names the corporations that HAVE been parred. Everything else is unparred, which
 *  is the one state in which a share has no price -- and by the rules cannot be sold at all. */
function stateWith(
  holdings: Array<{ companyId: number; player: string; percentage: number }>,
  cash: Array<{ player: string; cash_vgp: string }>,
  pars: Readonly<Record<number, number>> = {},
): GameStateResponse {
  const companyIds = Array.from(new Set(holdings.map((h) => h.companyId)));
  return {
    player_addresses: [ALICE, BOB],
    player_cash: cash,
    public_companies: companyIds.map((id) => ({
      company_id: id,
      ticker: `C${id}`,
      par_value: pars[id] === undefined ? null : String(pars[id]),
      player_holdings: holdings
        .filter((h) => h.companyId === id)
        .map((h) => ({ player: h.player, percentage: h.percentage })),
    })),
  } as unknown as GameStateResponse;
}

describe("estimateStockPortfolioValue", () => {
  it("prices each holding at ten percent per certificate", () => {
    /* 30% of a $100 corporation is three certificates at $100 = $300.
       The divisor is the 1830 rule, not a rounding convenience. */
    const state = stateWith([{ companyId: 1, player: ALICE, percentage: 30 }], []);
    expect(estimateStockPortfolioValue(ALICE, state, { 1: 100 })).toBe(300);
  });

  it("sums across corporations", () => {
    const state = stateWith(
      [
        { companyId: 1, player: ALICE, percentage: 30 },
        { companyId: 2, player: ALICE, percentage: 20 },
      ],
      [],
    );
    // 3 x $100 + 2 x $67 = $434.
    expect(estimateStockPortfolioValue(ALICE, state, { 1: 100, 2: 67 })).toBe(434);
  });

  it("counts only the player asked about", () => {
    const state = stateWith(
      [
        { companyId: 1, player: ALICE, percentage: 30 },
        { companyId: 1, player: BOB, percentage: 60 },
      ],
      [],
    );
    expect(estimateStockPortfolioValue(ALICE, state, { 1: 100 })).toBe(300);
    expect(estimateStockPortfolioValue(BOB, state, { 1: 100 })).toBe(600);
  });

  it("is zero for a player holding nothing", () => {
    /* A real zero, distinct from the `null`s below: we know the holdings and
       there are none. */
    const state = stateWith([{ companyId: 1, player: BOB, percentage: 60 }], []);
    expect(estimateStockPortfolioValue(ALICE, state, { 1: 100 })).toBe(0);
  });

  it("falls back to par when the chart has no position yet", () => {
    /* Design note #711: PAR IS THE PRICE, not a fallback -- a corporation whose President's Share has sold at
       $67 sells its remaining shares at $67 whether or not a token has been placed on the chart. #566 argued
       this for the player card; #711 made it the only reading. */
    const state = stateWith([{ companyId: 1, player: ALICE, percentage: 30 }], [], { 1: 67 });
    expect(estimateStockPortfolioValue(ALICE, state, {})).toBe(201);
  });

  it("prefers the market price over the par once the token has moved", () => {
    const state = stateWith([{ companyId: 1, player: ALICE, percentage: 30 }], [], { 1: 67 });
    expect(estimateStockPortfolioValue(ALICE, state, { 1: 100 })).toBe(300);
  });

  it("values an UNPARRED corporation's shares at nothing", () => {
    /* THE CASE THIS WHOLE NOTE TURNS ON, and the assertion is the exact inverse of what stood here.
       It read: "Skipping the unpriced corporation would report $300 for a portfolio that also contains an
       unvalued 20% -- an under-report indistinguishable from a correct smaller number."
       REPORTED: "if a share has no market price it is unsellable, so it should either be excluded or count as
       $0 ... the only case in which this can ever happen is the 10% PRR share granted by the private company
       before PRR pars/sells its President's Share."
       So there is no unvalued 20%. There is a 20% that nobody may buy at any figure, and $300 is the whole
       portfolio rather than part of it. */
    const state = stateWith(
      [
        { companyId: 1, player: ALICE, percentage: 30 },
        { companyId: 2, player: ALICE, percentage: 20 },
      ],
      [],
      { 1: 100 },
    );
    expect(estimateStockPortfolioValue(ALICE, state, { 1: 100 })).toBe(300);
    expect(estimateStockPortfolioValue(ALICE, state, { 1: 100, 2: null })).toBe(300);
  });

  it("is the private company's PRR certificate, and nothing else", () => {
    /* Worth stating as the scope rather than as a number: the report is explicit that this arises once per
       game. A test that treated unparred holdings as an ordinary case would invite someone to build for it. */
    const state = stateWith([{ companyId: 9, player: ALICE, percentage: 10 }], []);
    expect(estimateStockPortfolioValue(ALICE, state, {})).toBe(0);
  });

  it("treats a nonsense price as no price rather than as NaN", () => {
    /* The guard survives #711; only its answer changed. A `NaN` on the wire is not a valuation, so the ladder
       steps past it -- to par where there is one, and to nothing where there is not. */
    const unparred = stateWith([{ companyId: 1, player: ALICE, percentage: 30 }], []);
    expect(estimateStockPortfolioValue(ALICE, unparred, { 1: Number.NaN })).toBe(0);

    const parred = stateWith([{ companyId: 1, player: ALICE, percentage: 30 }], [], { 1: 67 });
    expect(estimateStockPortfolioValue(ALICE, parred, { 1: Number.NaN })).toBe(201);
  });
});

describe("estimatePlayerNetWorth", () => {
  it("adds liquid cash to the portfolio", () => {
    const state = stateWith(
      [{ companyId: 1, player: ALICE, percentage: 30 }],
      [{ player: ALICE, cash_vgp: "450" }],
    );
    expect(estimatePlayerNetWorth(ALICE, state, { 1: 100 })).toEqual({
      stockValue: 300,
      netWorth: 750,
    });
  });

  it("handles cash as the string the chain sends", () => {
    // `Uint128` serialises as a string; a numeric coercion that silently
    // produced NaN here would blank the column it was added to fill.
    const state = stateWith([], [{ player: ALICE, cash_vgp: "1200" }]);
    expect(estimatePlayerNetWorth(ALICE, state, {})).toEqual({ stockValue: 0, netWorth: 1200 });
  });

  it("still answers when a holding is unparred, counting it as nothing", () => {
    /* Design note #711: the portfolio can always be valued now, so this is no longer a `null` case. An
       unparred share is worth $0 to its holder, which makes this player worth exactly their cash. */
    const state = stateWith(
      [{ companyId: 1, player: ALICE, percentage: 30 }],
      [{ player: ALICE, cash_vgp: "450" }],
    );
    expect(estimatePlayerNetWorth(ALICE, state, {})).toEqual({ stockValue: 0, netWorth: 450 });
  });

  it("returns null when the player has no cash RECORD", () => {
    /* Absent is not zero. Reporting a $300 net worth for a player whose cash
       the response did not carry states a total that was never known. */
    const state = stateWith([{ companyId: 1, player: ALICE, percentage: 30 }], []);
    expect(estimatePlayerNetWorth(ALICE, state, { 1: 100 })).toBeNull();
  });

  it("distinguishes zero cash from missing cash", () => {
    // A player who genuinely holds $0 has a knowable net worth.
    const state = stateWith(
      [{ companyId: 1, player: ALICE, percentage: 30 }],
      [{ player: ALICE, cash_vgp: "0" }],
    );
    expect(estimatePlayerNetWorth(ALICE, state, { 1: 100 })).toEqual({
      stockValue: 300,
      netWorth: 300,
    });
  });

  it("values a cash-only player with no holdings", () => {
    // The opening state of every game: cash, no shares yet. This must not be
    // the `null` case, or the ledger blanks on turn one.
    const state = stateWith([], [{ player: ALICE, cash_vgp: "600" }]);
    expect(estimatePlayerNetWorth(ALICE, state, {})).toEqual({ stockValue: 0, netWorth: 600 });
  });
});
