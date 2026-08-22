/** @jest-environment node */
//
// One counting question, asked by two surfaces. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 734 (harness): THE CARD AND THE LEDGER MUST AGREE
// ==================================================================
//
// REPORTED: "When a stock is in the yellow zone (and so shares do not count toward cert limit), the Game
// Ledger > Player Assets has this listed correctly, but it does not agree with Player Card that players are
// most likely to consult in the Stock Round. The Player Card seems to just be counting everything."
//
// THE ASSERTION IS AGREEMENT, NOT CORRECTNESS, and that is deliberate. A test that checked the card's number
// against a hand-computed expectation would pin one surface and leave the other free to drift -- which is the
// state the app was in, since the Ledger was already right. What matters is that both read ONE rule, so the
// discriminating case compares them to each other on a board where the exemption actually bites.
//
// AND THE BOARD HAS TO HAVE AN EXEMPT ZONE, or the two agree trivially. Every earlier test of either surface
// used ordinary prices, where the zone-blind count and the zone-aware count are equal by construction -- which
// is exactly why a bug this visible survived a harness on both sides.

import { certificateBreakdown, certificateCount, type GameStateResponse } from "./gameState";
import { playerFinances } from "./playerFinance";

const ME = "me";
const YELLOW_CO = 1;
const NORMAL_CO = 2;

/** Two corporations: one priced into the yellow zone, one ordinary. */
function board(): GameStateResponse {
  return {
    player_addresses: [ME, "rival"],
    player_cash: [
      { player: ME, cash_vgp: "500" },
      { player: "rival", cash_vgp: "500" },
    ],
    private_companies: [],
    public_companies: [
      {
        company_id: YELLOW_CO,
        ticker: "C&O",
        president: null,
        par_value: "60",
        ipo_pool_percentage: 60,
        bank_pool_percentage: 0,
        player_holdings: [{ player: ME, percentage: 40 }],
        station_token_hexes: [],
      },
      {
        company_id: NORMAL_CO,
        ticker: "PRR",
        president: null,
        par_value: "100",
        ipo_pool_percentage: 70,
        bank_pool_percentage: 0,
        player_holdings: [{ player: ME, percentage: 30 }],
        station_token_hexes: [],
      },
    ],
  } as unknown as GameStateResponse;
}

const PRICES = { [YELLOW_CO]: 60, [NORMAL_CO]: 100 };

/** The chart, as the app injects it: only the cheap corporation is in an exempt band. */
const zoneForPrice = (price: number | null | undefined): string | null =>
  price != null && price <= 60 ? "Yellow" : "Normal";

type ZoneLookup = (price: number | null | undefined) => string | null;

function cardCerts(zone?: ZoneLookup): number | null {
  return playerFinances(ME, board(), PRICES, undefined, zone)?.certificates ?? null;
}

describe("the card counts what the limit is measured against", () => {
  it("agrees with the Ledger's breakdown on an exempt board", () => {
    /* THE REPORT. Four C&O certificates sit in the yellow zone and are exempt; three PRR certificates count.
       The Ledger read `counted`; the card read the total. */
    const ledger = certificateBreakdown(ME, board(), PRICES, zoneForPrice);
    expect(cardCerts(zoneForPrice)).toBe(ledger.counted);
  });

  it("actually exempts something, so the comparison is not trivial", () => {
    /* THE GUARD ON THE TEST ITSELF. Without an exempt holding the zone-blind and zone-aware counts are equal,
       and every assertion in this file would pass against the bug. */
    const ledger = certificateBreakdown(ME, board(), PRICES, zoneForPrice);
    expect(ledger.exempt).toBeGreaterThan(0);
    expect(ledger.counted).toBeLessThan(ledger.total);
  });

  it("used to over-count, which is the number the player was reading", () => {
    // The old behaviour, kept as a measurement: the card showed the total, not the counted figure.
    expect(certificateCount(ME, board())).toBe(
      certificateBreakdown(ME, board(), PRICES, zoneForPrice).total,
    );
    expect(certificateCount(ME, board())).toBeGreaterThan(cardCerts(zoneForPrice) ?? 0);
  });

  it("falls back to counting everything when no chart is supplied", () => {
    /* OMITTED MEANS NO EXEMPTION -- the pre-#734 behaviour, and the safe direction: over-counting warns a
       player off a legal purchase, while under-counting invites one the reducer refuses. */
    expect(cardCerts(undefined)).toBe(certificateCount(ME, board()));
  });

  it("agrees with the Ledger on an ordinary board too", () => {
    // The compatibility case: with nothing exempt, the fix must change nothing.
    const flat: ZoneLookup = () => "Normal";
    const ledger = certificateBreakdown(ME, board(), PRICES, flat);
    expect(cardCerts(flat)).toBe(ledger.counted);
    expect(cardCerts(flat)).toBe(certificateCount(ME, board()));
  });
});
