/** @jest-environment node */
//
// The round-long lockout, through the rule module and through the reducer. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 744 (harness): DUMP AND REBUY
// ==================================================================
//
// REPORTED: "After selling a share in the Stock Round, a player was able to buy a share in the same
// corporation on the same Stock Round. This is forbidden ... Otherwise they can dump a corporation's stock
// value and then buy their shares back at the lower price."
//
// THE EXPLOIT IS THE TEST. Every other rule in `sharePurchase` caps what a player may HOLD, so its harness
// asks about holdings; this one caps what they may do to the PRICE, and the only honest way to pin it is to
// run the sequence -- sell, then try to buy -- through the reducer that would have allowed it. A unit test of
// the predicate alone would pass against a version that never recorded the sale.
//
// AND THE CLEARING MATTERS AS MUCH AS THE BLOCK. A lockout that never lifted would quietly forbid a legal
// purchase every round after the first, which is a worse bug than the one being fixed and would take far
// longer to notice -- players would assume they were hitting the certificate limit.

import { applySandboxAction } from "./sandboxSession";
import { sharePurchaseBlock, soldThisRound } from "./sharePurchase";
import type { GameStateResponse } from "./gameState";

const ME = "me";
const RIVAL = "rival";
const PRR = 1;
const BO = 2;

function board(): GameStateResponse {
  return {
    player_addresses: [ME, RIVAL],
    player_cash: [
      { player: ME, cash_vgp: "2000" },
      { player: RIVAL, cash_vgp: "2000" },
    ],
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 3,
    /* ==================================================================
        DESIGN NOTE 909: A BANK, BECAUSE A SALE PAYS OUT OF ONE
       ==================================================================
       ADDED, NOT ADJUSTED-TO-PASS. This fixture carried no bank at all, so the sale below paid the seller out
       of nothing and left `virtual_bank_vgp` negative -- and #898 then correctly read that as a broken bank
       and ended the game at the next Operating Round set boundary. Two cases here failed for that reason and
       not because the lockout was broken.
       A BOARD WITH NO BANK IS NOT A BOARD 1830 CAN REACH: the bank is $12,000 at deal time and every sale
       draws on it. Giving the fixture one is correcting a state that never existed, which is why the case
       below ALSO asserts that the game did not end -- so a future edit cannot quietly put it back into the
       terminal state and read the resulting failure as a lockout bug again. */
    virtual_bank_vgp: "10000",
    active_player_index: 0,
    consecutive_passes: 0,
    operating_round_just_ended: false,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        president: ME,
        par_value: "100",
        ipo_pool_percentage: 30,
        bank_pool_percentage: 10,
        player_holdings: [
          { player: ME, percentage: 40 },
          { player: RIVAL, percentage: 20 },
        ],
        station_token_hexes: [],
      },
      {
        company_id: BO,
        ticker: "B&O",
        president: null,
        par_value: "100",
        ipo_pool_percentage: 60,
        bank_pool_percentage: 0,
        player_holdings: [{ player: ME, percentage: 20 }],
        station_token_hexes: [],
      },
    ],
  } as unknown as GameStateResponse;
}

function sell(state: GameStateResponse, companyId: number, percentage = 10): GameStateResponse {
  return applySandboxAction(
    state,
    { SellStock: { game_id: 1, protocol_id: companyId, percentage } } as never,
    { actor: ME },
  );
}

function buyBlock(state: GameStateResponse, companyId: number): string | null {
  return sharePurchaseBlock({
    state,
    buyer: ME,
    companyId,
    source: "Bank",
    quantity: 1,
    zone: "Normal",
  });
}

describe("selling locks the buy-back for the rest of the round", () => {
  it("records the sale against the seller and the corporation", () => {
    /* THE MEMORY THE BUY NEEDS. A reducer arm sees only its own message, so the buy cannot look backwards --
       the sale has to leave something behind. */
    expect(soldThisRound(sell(board(), PRR), ME, PRR)).toBe(true);
  });

  it("refuses the buy-back", () => {
    /* THE REPORT, end to end: sell, then ask whether the purchase is legal. */
    const after = sell(board(), PRR);
    expect(buyBlock(after, PRR)).toMatch(/sold PRR this Stock Round/);
  });

  it("allowed it before the sale, so the block is the sale's doing", () => {
    // The control. Without this, a rule that refused every PRR purchase would pass the test above.
    expect(buyBlock(board(), PRR)).toBeNull();
  });

  it("is per corporation, not per player", () => {
    /* The loophole needs the SAME corporation on both sides of the trade. Selling PRR must not stop a B&O
       purchase -- a lockout that broad would rewrite the Stock Round. */
    const after = sell(board(), PRR);
    expect(buyBlock(after, BO)).toBeNull();
    expect(soldThisRound(after, ME, BO)).toBe(false);
  });

  it("is per player, not per corporation", () => {
    // A rival who did not sell is unaffected by this player's sale.
    const after = sell(board(), PRR);
    expect(soldThisRound(after, RIVAL, PRR)).toBe(false);
  });

  it("survives several sales without duplicating the record", () => {
    /* Replay safety, as data: Undo replays the whole log, so an arm that appended unconditionally would grow
       this array on every rebuild. */
    const twice = sell(sell(board(), PRR), PRR);
    expect(twice.sold_this_round?.[ME]).toEqual([PRR]);
  });
});

describe("no zone lifts it", () => {
  /* THE DISTINCTION FROM THE THREE RULES AROUND IT. Yellow, Orange and Brown all say "this corporation is
     cheap enough that the usual caution does not apply". This is not caution -- it is anti-manipulation, and
     a cheap corporation is exactly where dumping and rebuying pays best. */
  it.each(["Yellow", "Orange", "Brown", "Normal"])("still refuses in %s", (zone) => {
    const after = sell(board(), PRR);
    const blocked = sharePurchaseBlock({
      state: after,
      buyer: ME,
      companyId: PRR,
      source: "Bank",
      quantity: 1,
      zone: zone as never,
    });
    expect(blocked).toMatch(/sold PRR this Stock Round/);
  });
});

describe("the lockout ends when the next Stock Round opens", () => {
  /** The transition the reducer makes when an Operating Round finishes. */
  function openNextStockRound(state: GameStateResponse): GameStateResponse {
    return applySandboxAction(
      { ...state, operating_round_just_ended: true } as GameStateResponse,
      { PassTurn: { game_id: 1 } } as never,
      { actor: ME },
    );
  }

  it("clears the record", () => {
    /* THE HALF THAT WOULD HURT MORE IF MISSED. A lockout that never lifted would forbid a legal purchase every
       round after the first, and players would misread it as the certificate limit. */
    const locked = sell(board(), PRR);
    expect(soldThisRound(locked, ME, PRR)).toBe(true);
    const next = openNextStockRound(locked);
    /* THE PREMISE, PINNED FIRST. If the bank has run dry the game ends instead of opening a Stock Round, and
       "the lockout did not clear" would be the right answer to the wrong question -- which is exactly how
       this case was misread once already. */
    expect(next.current_round_type).toBe("StockRound");
    expect(soldThisRound(next, ME, PRR)).toBe(false);
  });

  it("lets the buy-back through afterwards", () => {
    const next = openNextStockRound(sell(board(), PRR));
    expect(buyBlock(next, PRR)).toBeNull();
  });
});

describe("both surfaces ask the same function", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  };

  it("is enforced by the reducer", () => {
    /* #712's lesson: a rule the panel knows and the reducer does not is a rule with a door beside it. The
       reducer already routed buys through `sharePurchaseBlock`, so adding the rule there closed both at once
       -- which is the payoff for #712 having put the rules in a module rather than in the panel. */
    expect(read("utils/sandboxSession.ts")).toContain("sharePurchaseBlock({");
  });

  it("is what disables the button", () => {
    expect(read("App.tsx")).toContain("return sharePurchaseBlock({");
  });
});
