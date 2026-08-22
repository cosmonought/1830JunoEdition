/** @jest-environment node */
//
// The President's Certificate cannot be sold. Through the rule module, the reducer and the chart. No React.
//
// ==================================================================
//  DESIGN NOTE 748 (harness): A RULE WITH ONE READER, AND IT WAS A BUTTON
// ==================================================================
//
// REPORTED: "P1 had a 10% share and P2 had a 50% share including the 1 President's certificate. P1 sold their
// 10% share and P2 was then able to sell 40%: this respected the 50% bank pool limit, but it did not respect
// the rule that a President's certificate can never be sold (only exchanged to another player holding at
// least 20%)."
//
// THE FIRST THING THIS FILE ASSERTS IS THAT THE RULE WAS ALREADY RIGHT. `shareSaleBlock` has refused exactly
// this sale since #713, with the correct message. What no test caught -- because every test of it called the
// function directly -- is that its ONLY caller was `App.saleBlockFor`, feeding a disabled state on one card.
// So the discriminating test is not "does the rule say no" but "does the BOARD say no", and it has to go
// through `applySandboxAction` to ask.
//
// WHICH MAKES THE UNIT-TEST-THE-PREDICATE HABIT THE THING THAT HID THIS. A predicate with a passing suite and
// no writer looks exactly like an enforced rule from inside the test file. #736 was the same discovery about
// private closure ("ten readers, no writer"); this is the mirror image, one reader and no writer.

import { applySandboxAction, applySandboxMarketAction } from "./sandboxSession";
import { shareSaleBlock, certificatesIn } from "./shareSale";
import { settlePresidencies, presidentFor } from "./presidencyTransfer";
import { certificateCount } from "./gameState";
import { projectShareSaleMove, PRICE_GRID } from "../components/StockMarketRenderer";
import type { GameStateResponse } from "./gameState";

const PRR = 1;

/** The reported board: P1 on 10%, P2 presiding on 50% (the 20% certificate plus three ordinary shares). */
function board(over: Record<string, unknown> = {}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2", "p3"],
    player_cash: ["p1", "p2", "p3"].map((player) => ({ player, cash_vgp: "500" })),
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 3,
    active_player_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: true,
        president: "p2",
        par_value: "100",
        ipo_pool_percentage: 40,
        bank_pool_percentage: 0,
        total_shares_issued: 6,
        treasury: "1000",
        player_holdings: [
          { player: "p1", percentage: 10 },
          { player: "p2", percentage: 50 },
        ],
        station_token_hexes: [],
        ...over,
      },
    ],
  } as unknown as GameStateResponse;
}

const sell = (state: GameStateResponse, actor: string, percentage: number) =>
  applySandboxAction(
    state,
    { SellStock: { game_id: 1, protocol_id: PRR, percentage } } as never,
    { actor, sharePrice: 100 },
  );

const corp = (state: GameStateResponse) => state.public_companies[0];
const heldBy = (state: GameStateResponse, player: string) =>
  corp(state).player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;

describe("the reported sequence", () => {
  it("was refused by the rule module all along", () => {
    /* THE CONTROL THAT NAMES THE BUG. If this failed, #748 would be about the rule; it passes, so #748 is
       about who asks. The message is quoted because #619's reason-not-a-boolean is what makes the refusal
       teachable -- "wait for a rival to reach 20%" rather than "you may not sell". */
    const afterP1 = sell(board(), "p1", 10);
    expect(shareSaleBlock({ state: afterP1, seller: "p2", companyId: PRR, percentage: 40 })).toMatch(
      /would leave you under the 20% President's Certificate, and no other player holds 20% to take it/,
    );
  });

  it("is now refused by the reducer too", () => {
    /* THE REPORT. Before #748 this left p2 on 10% with the Bank Pool at 50% -- the exact board described. */
    const afterP1 = sell(board(), "p1", 10);
    const attempted = sell(afterP1, "p2", 40);
    expect(heldBy(attempted, "p2")).toBe(50);
    expect(corp(attempted).bank_pool_percentage).toBe(10);
  });

  it("leaves the state untouched rather than throwing", () => {
    /* #712's rule for a refused buy, applied here: a replay must not halt on an entry the log already
       contains, so an illegal sale is a move that did nothing. Identity is the assertion. */
    const afterP1 = sell(board(), "p1", 10);
    expect(sell(afterP1, "p2", 40)).toBe(afterP1);
  });

  it("still lets P1 sell, so the refusal is about the certificate and not about selling", () => {
    const afterP1 = sell(board(), "p1", 10);
    expect(heldBy(afterP1, "p1")).toBe(0);
    expect(corp(afterP1).bank_pool_percentage).toBe(10);
  });
});

describe("what a president may still do", () => {
  it("may sell down TO the certificate", () => {
    /* The boundary, and the one a blunt "presidents cannot sell" would break: three ordinary shares are
       ordinary shares. `after === 20` is not below the block. */
    const sold = sell(sell(board(), "p1", 10), "p2", 30);
    expect(heldBy(sold, "p2")).toBe(20);
    expect(corp(sold).president).toBe("p2");
  });

  it("may sell through it when somebody can take it", () => {
    /* #6's successor rule: the certificate is one card and goes to one holder, so a rival on 20% makes the
       sale legal. Without this case the fix would read as "the president is frozen", which is a different and
       equally wrong game. */
    const withRival = board({
      player_holdings: [
        { player: "p1", percentage: 20 },
        { player: "p2", percentage: 50 },
      ],
    });
    const sold = sell(withRival, "p2", 40);
    expect(heldBy(sold, "p2")).toBe(10);
    expect(corp(sold).president).toBe("p1");
  });

  it("counts successors per player, never as a sum", () => {
    // Two rivals at 10% each cannot jointly succeed -- #6, and the reason `find` is per entry.
    const twoSmall = board({
      player_holdings: [
        { player: "p1", percentage: 10 },
        { player: "p3", percentage: 10 },
        { player: "p2", percentage: 50 },
      ],
    });
    expect(sell(twoSmall, "p2", 40)).toBe(twoSmall);
  });
});

describe("the chart refuses what the board refuses", () => {
  /* Design note #748a. The market atom advances BEFORE the game state (#272/#273), so a reducer-only fix
     would have left the token walking down for a sale that never happened -- a price drop with no matching
     change in anybody's holdings, which reads as a market bug rather than a refused action. */
  const cell = PRICE_GRID.find((entry) => entry.x === 6 && entry.y === 6)!;
  const chart = { [PRR]: { x: cell.x, y: cell.y, price: cell.price } };

  const move = (percentage: number, refused: boolean) =>
    applySandboxMarketAction(
      chart,
      { SellStock: { game_id: 1, protocol_id: PRR, percentage } } as never,
      {
        projectSale: (from, blocks) => projectShareSaleMove(from, blocks) as never,
        saleRefused: () => refused,
      },
    );

  it("moves no token on a refused sale", () => {
    const result = move(40, true);
    expect(result.prices).toBe(chart);
    expect(result.moved).toBeNull();
  });

  it("still moves on a legal one, which is the control", () => {
    expect(move(40, false).moved).not.toBeNull();
  });
});

describe("the price drop is one row per 10%", () => {
  /* ==================================================================
   *  DESIGN NOTE 748c (harness): THE SIXTH CELL WAS NOT REPRODUCIBLE
   * ==================================================================
   *
   * ALSO REPORTED: "something weird also may have happened with the corporation's stock marker: it seems to
   * have dropped 6 cells rather than 5."
   *
   * RUNNING THE DESCRIBED SEQUENCE GIVES 5. P1's 10% walks one row and P2's 40% walks four, from the chart's
   * own cells through the shipped traversal. So this file does NOT contain a fix for the sixth cell, because
   * I could not make the sixth cell happen and did not want to invent a mechanism that fit the symptom.
   *
   * WHAT IT DOES INSTEAD is pin the two places that count rows against each other. `certificatesIn` drives the
   * figure the panel PREVIEWS and the market atom's own `blocks` drives the token that MOVES -- two
   * computations of one question, which is the shape (#734, #741) that has produced a visible discrepancy
   * three times in this project. They agree today; if they ever stop, this is where it shows.
   *
   * AND THE LIKELIEST EXPLANATION IS THAT THE SIXTH CELL WAS DOWNSTREAM OF THE ILLEGAL SALE -- a board that
   * should not have existed, with a president holding 10% of a corporation. If it recurs on a legal sequence
   * the Activity Log's Market Move lines will name each mover, which is what #435 put them there for.
   */

  const start = PRICE_GRID.find((entry) => entry.x === 6 && entry.y === 6)!;

  function rowsWalked(percentage: number): number {
    const landed = projectShareSaleMove({ x: start.x, y: start.y }, percentage / 10);
    return landed ? start.y - landed.y : 0;
  }

  it("walks five rows for the reported 50%, not six", () => {
    expect(rowsWalked(10) + rowsWalked(40)).toBe(5);
  });

  it.each([10, 20, 30, 40, 50])("agrees with the panel's preview for %i%%", (percentage) => {
    /* The two counters, side by side. `certificatesIn` is what the Sell card quotes; the reducer's market arm
       computes its own. A player who reads one and watches the other has to see the same number. */
    const marketBlocks = Math.max(1, Math.round(percentage / 10));
    expect(certificatesIn(percentage)).toBe(marketBlocks);
    expect(rowsWalked(percentage)).toBe(marketBlocks);
  });
});

describe("a crown is never vacated", () => {
  /* ==================================================================
   *  DESIGN NOTE 748b (harness): THE FIX THAT WAS AN ACCOMMODATION
   * ==================================================================
   *
   * REPORTED: "P2 now shows to have 0 certificates and a 10% share."
   *
   * MY FIRST ANSWER WAS TO VACATE THE CROWN -- set `president: null` whenever nobody held the 20% block -- and
   * this block asserted that it did.
   *
   * REPORTED BACK: "this is still very wrong: a President's share can NEVER be sold to the Bank, so what's
   * wrong is that a crown/presidency can never be vacated. The player should never have been able to sell
   * below their 20% President's certificate."
   *
   * SO THE SYMPTOM HAD NO FIX OF ITS OWN, and looking for one is what produced a wrong one. The "0
   * certificates" half was never a bug at all -- #7's zone exemption, five rows down into the Yellow zone
   * where shares stop counting toward the limit. The stale crown was the shadow of the illegal sale. #748,
   * the reducer refusing that sale, is the entire correction; everything downstream of it was a board that
   * should not have existed.
   *
   * WHAT THE OLD TESTS WERE ACTUALLY DOING is worth naming, because they passed: they described an impossible
   * board in detail and pinned the code's ability to represent it. Same error class as #746c one report
   * earlier -- making the code agree with a broken board instead of asking whether the board should exist.
   * The tests below assert the opposite property, that no sequence produces a presidentless corporation.
   */

  it("keeps the incumbent even on a board that should not exist", () => {
    /* Unreachable once #748 holds, and the answer still has to be safe: a stale president is at least a
       president, and the corporation stays able to lay track, run trains and spend its treasury. `null` would
       freeze it, so the accommodating answer was also the more damaging one. */
    const impossible = board({ player_holdings: [{ player: "p2", percentage: 10 }] });
    const settled = settlePresidencies(impossible);
    expect(settled.state.public_companies[0].president).toBe("p2");
    expect(settled.changes).toEqual([]);
  });

  it("never reaches that board by selling", () => {
    /* THE PROPERTY THAT MATTERS, swept rather than argued: no legal bundle a president can sell leaves the
       corporation without one. This is the assertion the vacate branch existed to make unnecessary. */
    for (const bundle of [10, 20, 30, 40, 50]) {
      const after = sell(sell(board(), "p1", 10), "p2", bundle);
      const president = corp(after).president;
      expect(president).not.toBeNull();
      expect(heldBy(after, president as string)).toBeGreaterThanOrEqual(20);
    }
  });

  it("hands the certificate to a successor rather than to the Bank", () => {
    /* The only way it moves, and the rule as stated: "A player is only allowed to sell their President's
       share if another player holds at least 20%. In effect this means that a player selling all or part of
       their 20% President's share must first exchange this certificate with another player for their two
       certificates, then sell those to the correct %." */
    const withRival = board({
      player_holdings: [
        { player: "p1", percentage: 20 },
        { player: "p2", percentage: 50 },
      ],
    });
    const after = sell(withRival, "p2", 40);
    expect(corp(after).president).toBe("p1");
    expect(heldBy(after, "p1")).toBeGreaterThanOrEqual(20);
  });

  it("conserves the cards across the exchange", () => {
    /* THE EXCHANGE, ASSERTED AS ARITHMETIC. #596a settles the crown by writing one field and letting
       `certificateCount` derive both players' card counts from it -- "nobody's PERCENTAGE moves; what changes
       is how many CARDS each holds". That is the swap: two 10% cards out, one 20% card in.
       COUNTING CARDS IS THE ONLY WAY TO SEE IT HAPPEN, because the percentages alone are identical whether
       the certificate was exchanged or (illegally) sold to the Bank. Ten cards exist per corporation and ten
       must still exist afterwards, wherever they sit. */
    const withRival = board({
      player_holdings: [
        { player: "p1", percentage: 20 },
        { player: "p2", percentage: 50 },
      ],
    });
    const cards = (state: GameStateResponse) =>
      certificateCount("p1", state) +
      certificateCount("p2", state) +
      corp(state).bank_pool_percentage / 10 +
      corp(state).ipo_pool_percentage / 10;

    expect(cards(withRival)).toBe(10);
    const after = sell(withRival, "p2", 40);
    expect(cards(after)).toBe(10);

    /* And the two hands specifically: p1 now holds the single 20% card, p2 the one 10% share they kept.
       Before the sale p1 held TWO cards for the same 20%, which is the exchange in one line. */
    expect(certificateCount("p1", withRival)).toBe(2);
    expect(certificateCount("p1", after)).toBe(1);
    expect(certificateCount("p2", after)).toBe(1);
  });

  it("still reports null for a company nobody has started", () => {
    /* The one case `presidentFor`'s `null` is really for. Kept so the return type does not get narrowed on
       the strength of #748b -- an unparred corporation genuinely has no president. */
    const unstarted = board({ president: null, par_value: null, player_holdings: [] });
    expect(presidentFor(unstarted.public_companies[0])).toBeNull();
    expect(settlePresidencies(unstarted).state).toBe(unstarted);
  });

  it("leaves a qualified president alone", () => {
    // Identity is the contract: "a caller can use identity to decide whether anything happened".
    const settled = board();
    expect(settlePresidencies(settled).state).toBe(settled);
    expect(settlePresidencies(settled).changes).toEqual([]);
  });
});

describe("the rule reaches the authority, not only the button", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the notes quote the old arrangement and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("is asked by the reducer", () => {
    /* THE STRUCTURAL HALF, and the only one that would have caught this. Every behavioural test above can be
       satisfied by a rule module nobody consults -- which is exactly the state the app shipped in. */
    expect(read("utils/sandboxSession.ts")).toContain("shareSaleBlock({");
  });

  it("is asked by the market atom", () => {
    expect(read("utils/sandboxSession.ts")).toContain("ctx?.saleRefused?.(protocol_id, percentage)");
  });

  it("is still asked by the panel", () => {
    // #712's point: the reducer is the authority, and the button still has to explain itself before the click.
    expect(read("App.tsx")).toContain("return shareSaleBlock({");
  });
});
