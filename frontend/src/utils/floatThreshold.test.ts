/** @jest-environment node */
//
// What floats a corporation. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 749 (harness): OUT OF THE IPO, NOT IN PLAYERS' HANDS
// ==================================================================
//
// REPORTED: "when fewer than 60% of a corporation's shares are in player hands, there's a text string that
// appears on the corporation card: 'Floated flag set at 40% sold, 60% expected.' ... floating is only
// contingent on 60% of shares being out of the IPO; if there are 20% in IPO, 20% in player, and 60% in
// market, that corporation is floated and operational the same as a corporation with 40% in IPO and 60% in
// player."
//
// THE LABEL WAS THE VISIBLE END OF IT. Three places computed the float condition and all three asked how much
// sat in players' hands -- the reducer, `trading.rs`, and the card. Only the third printed anything, so the
// report is about a caption and the fix is about whether corporations float.
//
// THE DISCRIMINATING CASE HAS TO INCLUDE A SALE, and that is the whole reason this went unnoticed: shares
// leave the IPO by being bought, so until somebody sells, "out of the IPO" and "in players' hands" are the
// same number. Every fixture anybody had written bought and never sold.
//
// AND THE MEASURE IS THE RIGHT SHAPE FOR A LATCH, which is the structural version of the same point.
// `is_floated` never goes back off and nothing returns a share to the IPO, so `100 - ipo` only rises. The
// players-hands figure falls on every sale -- the old rule was a latch computed from a quantity that moves
// both ways, and a rule like that is wrong before you check any particular board.

import {
  FLOAT_THRESHOLD_PERCENT,
  heldByPlayersPercent,
  metFloatThreshold,
  soldFromIpoPercent,
} from "./floatThreshold";
import { applyFloatThreshold } from "./sandboxSession";
import type { GameStateResponse } from "./gameState";

const PRR = 1;

/** A board described by its three piles, which is how the report describes one. */
function board(ipo: number, held: number, bank: number, over: Record<string, unknown> = {}) {
  return {
    player_addresses: ["p1"],
    player_cash: [{ player: "p1", cash_vgp: "2000" }],
    bank_cash: "12000",
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 2,
    active_player_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: false,
        president: "p1",
        par_value: "100",
        ipo_pool_percentage: ipo,
        bank_pool_percentage: bank,
        total_shares_issued: 10,
        treasury: "0",
        player_holdings: held > 0 ? [{ player: "p1", percentage: held }] : [],
        station_token_hexes: [],
        ...over,
      },
    ],
  } as unknown as GameStateResponse;
}

const noHome = () => null;
const floats = (state: GameStateResponse) =>
  applyFloatThreshold(state, noHome).public_companies[0].is_floated;

describe("the two quantities are different questions", () => {
  it("differ by exactly the Bank Pool", () => {
    /* Said as arithmetic so the distinction cannot be argued away later: every share in the pool was bought
       out of the IPO and is no longer in anybody's hand. */
    const state = board(20, 20, 60).public_companies[0];
    expect(soldFromIpoPercent(state)).toBe(80);
    expect(heldByPlayersPercent(state)).toBe(20);
    expect(soldFromIpoPercent(state) - heldByPlayersPercent(state)).toBe(
      state.bank_pool_percentage,
    );
  });

  it("agree while nobody has sold, which is why this went unnoticed", () => {
    const virgin = board(40, 60, 0).public_companies[0];
    expect(soldFromIpoPercent(virgin)).toBe(heldByPlayersPercent(virgin));
  });
});

describe("the board in the report", () => {
  /* "if there are 20% in IPO, 20% in player, and 60% in market, that corporation is floated and operational
     the same as a corporation with 40% in IPO and 60% in player." */
  it("has met the threshold", () => {
    expect(metFloatThreshold(board(20, 20, 60).public_companies[0])).toBe(true);
  });

  it("is the same answer as the corporation it was compared to", () => {
    expect(metFloatThreshold(board(20, 20, 60).public_companies[0])).toBe(
      metFloatThreshold(board(40, 60, 0).public_companies[0]),
    );
  });

  it("would have been called a contradiction by the old measure", () => {
    /* The banner's condition is `is_floated && !metFloatThreshold`. On 20/20/60 the old arithmetic gave 20%,
       so every corporation with 40%-plus in the pool accused itself of a data fault. */
    expect(heldByPlayersPercent(board(20, 20, 60).public_companies[0])).toBeLessThan(
      FLOAT_THRESHOLD_PERCENT,
    );
  });
});

describe("the corporation that could not float", () => {
  /* THE REACHABLE BUG, and the reason this is not only a caption fix. Buy 50% from the IPO, sell 20% into the
     pool, buy 10% more. 60% has left the IPO and the corporation must float; the player total reads 40%. */
  const stuck = board(40, 40, 20);

  it("floats", () => {
    expect(floats(stuck)).toBe(true);
  });

  it("was refused by the old measure, so the fixture tests what it claims", () => {
    expect(heldByPlayersPercent(stuck.public_companies[0])).toBe(40);
    expect(soldFromIpoPercent(stuck.public_companies[0])).toBe(60);
  });

  it("is capitalised when it floats", () => {
    // #376: ten times par, so the fix reaches the consequence and not only the flag.
    const after = applyFloatThreshold(stuck, noHome).public_companies[0];
    expect(Number(after.treasury)).toBe(1000);
  });
});

describe("the ordinary cases still behave", () => {
  it("floats at exactly 60% out of the IPO", () => {
    expect(floats(board(40, 60, 0))).toBe(true);
  });

  it("does not float at 50%", () => {
    expect(floats(board(50, 50, 0))).toBe(false);
  });

  it("does not float on a pool that never came from this IPO", () => {
    // 50% out of the IPO however it is split between hands and pool.
    expect(floats(board(50, 30, 20))).toBe(false);
  });

  it("leaves an already-floated corporation alone", () => {
    const already = board(40, 40, 20, { is_floated: true, treasury: "500" });
    expect(applyFloatThreshold(already, noHome)).toBe(already);
  });

  it("returns the same state when nothing floats, so callers can skip on identity", () => {
    const short = board(50, 50, 0);
    expect(applyFloatThreshold(short, noHome)).toBe(short);
  });
});

describe("the measure only ever rises", () => {
  it("is unchanged by a sale", () => {
    /* THE LATCH PROPERTY. A sale moves shares from a hand to the pool and touches the IPO not at all, so the
       float measure holds still where the old one dropped. A flag that never goes off must be computed from a
       number that never goes down. */
    const before = board(40, 60, 0).public_companies[0];
    const after = board(40, 40, 20).public_companies[0];
    expect(soldFromIpoPercent(after)).toBe(soldFromIpoPercent(before));
    expect(heldByPlayersPercent(after)).toBeLessThan(heldByPlayersPercent(before));
  });

  it("cannot be pushed outside 0 to 100 by a nonsense pool", () => {
    expect(soldFromIpoPercent({ ipo_pool_percentage: 140 } as never)).toBe(0);
    expect(soldFromIpoPercent({ ipo_pool_percentage: -40 } as never)).toBe(100);
    expect(soldFromIpoPercent({ ipo_pool_percentage: NaN } as never)).toBe(0);
  });
});

describe("one definition, and both surfaces read it", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the notes name the old function and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("has no local copy of the arithmetic left", () => {
    /* THE STRUCTURAL HALF. Two files each had a function called `soldToPlayersPercent`, computing the same
       wrong quantity by two different routes -- `100 - ipo - bank` in one, a sum of holdings in the other --
       and each read as obviously correct where it stood. That is what a rule with two spellings buys. */
    for (const file of ["utils/sandboxSession.ts", "components/StockRoundPanel.tsx"]) {
      expect(read(file)).not.toMatch(/function soldToPlayersPercent/);
    }
  });

  it("has one 60 in the codebase", () => {
    expect(read("components/StockRoundPanel.tsx")).not.toMatch(
      /const FLOAT_THRESHOLD_PERCENT\s*=\s*60/,
    );
  });

  it("is asked by the reducer", () => {
    expect(read("utils/sandboxSession.ts")).toContain("if (!metFloatThreshold(company)) return company;");
  });

  it("is asked by the card", () => {
    expect(read("components/StockRoundPanel.tsx")).toContain("metFloatThreshold(company)");
    expect(read("components/StockRoundPanel.tsx")).toContain("soldFromIpoPercent(company)");
  });

  it("says which pile it is talking about", () => {
    /* The report opened with "I don't know what this means". The old string was "Floated flag set at 40%
       sold" -- sold out of what, to whom, is the whole question, and it named neither. */
    expect(read("components/StockRoundPanel.tsx")).toContain("out of the IPO");
  });
});
