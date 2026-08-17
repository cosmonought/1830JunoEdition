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
function stateWith(
  holdings: Array<{ companyId: number; player: string; percentage: number }>,
  cash: Array<{ player: string; cash_vgp: string }>,
): GameStateResponse {
  const companyIds = Array.from(new Set(holdings.map((h) => h.companyId)));
  return {
    player_addresses: [ALICE, BOB],
    player_cash: cash,
    public_companies: companyIds.map((id) => ({
      company_id: id,
      ticker: `C${id}`,
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

  it("returns null when a held corporation has NO price", () => {
    /* THE CASE THAT MATTERS. Skipping the unpriced corporation would report
       $300 for a portfolio that also contains an unvalued 20% -- an
       under-report indistinguishable from a correct smaller number, which is
       the kind of figure a player would act on. */
    const state = stateWith(
      [
        { companyId: 1, player: ALICE, percentage: 30 },
        { companyId: 2, player: ALICE, percentage: 20 },
      ],
      [],
    );
    expect(estimateStockPortfolioValue(ALICE, state, { 1: 100 })).toBeNull();
    expect(estimateStockPortfolioValue(ALICE, state, { 1: 100, 2: null })).toBeNull();
  });

  it("does not treat an unpriced holding as free", () => {
    // The same point stated as the thing that must not happen.
    const state = stateWith([{ companyId: 9, player: ALICE, percentage: 50 }], []);
    expect(estimateStockPortfolioValue(ALICE, state, {})).not.toBe(0);
  });

  it("returns null rather than NaN for a nonsense price", () => {
    const state = stateWith([{ companyId: 1, player: ALICE, percentage: 30 }], []);
    expect(estimateStockPortfolioValue(ALICE, state, { 1: Number.NaN })).toBeNull();
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

  it("returns null when the portfolio cannot be valued", () => {
    const state = stateWith(
      [{ companyId: 1, player: ALICE, percentage: 30 }],
      [{ player: ALICE, cash_vgp: "450" }],
    );
    expect(estimatePlayerNetWorth(ALICE, state, {})).toBeNull();
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
