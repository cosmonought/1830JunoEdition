/** @jest-environment node */
//
// The fourth market movement, through the rule module, the chart and the reducer. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 746 (harness): THE ARROW THAT HAD NOTHING BEHIND IT
// ==================================================================
//
// ASKED FOR: a compass rose with "an arrow up with 'All shares owned by players'". Three of the four arrows
// described movements the sandbox performed; that one did not exist anywhere in the frontend.
//
// SO THE FIRST ASSERTION IS THAT A TOKEN ACTUALLY MOVES, and the rest are about not moving it too often. The
// dangerous failure here is not a rise that fails to happen -- a playtester notices a price that never
// climbs -- it is a rise that happens twice when it should happen once, or on a corporation that has half
// its IPO on the shelf, because a chart that drifts upward is very hard to attribute after the fact.
//
// THE PREMISES ARE READ BACK FROM THE CONTRACT rather than remembered. `apply_sold_out_price_rises` requires
// BOTH pools empty and a floated company; `execute_buy_stock` raises separately on the purchase that empties
// them; and market.rs says in as many words that a corporation sold out mid-round "is legitimately raised
// twice". That last one is the test a well-meaning reader would delete.

import {
  applySandboxAction,
  applySandboxMarketAction,
  buildOperatingOrder,
} from "./sandboxSession";
import { isSoldOut, roundEndSoldOutRises, soldOutRises, describeSoldOutRise } from "./soldOutRise";
import { projectRiseMove, COMPASS_ARMS, PRICE_GRID } from "../components/StockMarketRenderer";
import type { GameStateResponse } from "./gameState";

const SEATS = ["p0", "p1"];
const PRR = 1;
const BO = 2;

function company(over: Record<string, unknown> = {}) {
  return {
    company_id: PRR,
    ticker: "PRR",
    is_floated: true,
    president: "p0",
    par_value: "100",
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    player_holdings: [{ player: "p0", percentage: 100 }],
    station_token_hexes: [],
    ...over,
  };
}

function board(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: SEATS,
    player_cash: SEATS.map((player) => ({ player, cash_vgp: "2000" })),
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 2,
    active_player_index: 0,
    consecutive_passes: 0,
    priority_deal_index: 0,
    last_trader_index: null,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    public_companies: [company()],
    ...over,
  } as unknown as GameStateResponse;
}

/** A mark on a REAL cell, so `projectRiseMove` is exercised against the shipped chart rather than stubbed.
 *  The price is the chart's own, looked up rather than supplied. */
const markAt = (x: number, y: number) => () => ({
  x,
  y,
  price: PRICE_GRID.find((cell) => cell.x === x && cell.y === y)?.price ?? 0,
});

describe("what counts as sold out", () => {
  it("needs both pools empty", () => {
    /* THE HALF A READER WOULD GET WRONG. "Sold out" in 18xx conversation usually means an empty BANK POOL
       alone; `apply_sold_out_price_rises` requires the IPO too, and a corporation with half its IPO on the
       shelf rising every round would be a slow, hard-to-attribute drift. */
    expect(isSoldOut(company() as never)).toBe(true);
    expect(isSoldOut(company({ ipo_pool_percentage: 10 }) as never)).toBe(false);
    expect(isSoldOut(company({ bank_pool_percentage: 10 }) as never)).toBe(false);
  });

  it("needs the corporation to be floated", () => {
    /* The contract's reason, worth keeping in view: "an unfloated corporation has never sold a share, so its
       IPO pool is untouched -- and an unwritten entry defaults to FULL (100), not 0". Our state is always
       populated so we cannot reproduce that trap, but the rule is the rule. */
    expect(isSoldOut(company({ is_floated: false }) as never)).toBe(false);
  });
});

describe("the chart's up step", () => {
  it("moves a token to a higher price", () => {
    const from = { x: 5, y: 4 };
    const up = projectRiseMove(from);
    expect(up).not.toBeNull();
    expect(up!.y).toBe(5);
  });

  it("clamps at the top of a column instead of inventing a cell", () => {
    /* #434's rule for the other three directions, applied to this one: an unchanged cell is how every caller
       tells "rose" from "already at the ceiling", so the clamp is load-bearing rather than defensive. */
    let y = 4;
    while (projectRiseMove({ x: 5, y })?.y === y + 1) y += 1;
    const ceiling = projectRiseMove({ x: 5, y });
    expect(ceiling).toEqual(expect.objectContaining({ x: 5, y }));
  });

  it("says nothing about a cell that is not on the chart", () => {
    expect(projectRiseMove({ x: 99, y: 99 })).toBeNull();
  });

  it("goes UP, not down", () => {
    /* THE AXIS, ASSERTED. This chart's y is inverted relative to the screen and `projectShareSaleMove` walks
       `y - 1` for a fall -- so a rise written from screen intuition would have LOWERED the price, which is
       the identical mistake that note records having been made once already. */
    const start = projectRiseMove({ x: 5, y: 3 })!;
    const next = projectRiseMove({ x: 5, y: 4 })!;
    expect(next.price).toBeGreaterThan(start.price);
  });
});

describe("buying never moves the marker", () => {
  /* ==================================================================
   *  DESIGN NOTE 746c (harness): THE TEST THAT WOULD HAVE BLOCKED THE FIX
   * ==================================================================
   *
   * THIS BLOCK IS THE INVERSE OF THE ONE IT REPLACES. The first version asserted that a purchase emptying both
   * pools raised the marker, and a companion test pinned a SECOND rise at the end of the round as deliberate.
   *
   * REPORTED: "this is completely wrong. A corporation's share price only rises, and only rises once, at the
   * end of a stock round when all of its shares are in the hands of players, period."
   *
   * WHERE THE WRONG RULE CAME FROM, recorded because the method looked like good practice: I read it out of
   * `trading.rs` and `market.rs` instead of the rulebook, on the principle that a premise checked against
   * shipped code beats one written from memory. The contract is not the authority on the rules -- it is
   * another implementation of them, and it had the same bug. Worse, `market.rs` had written the two triggers
   * up as intentional, and I quoted that comment into a design note as though it were a citation.
   *
   * AND THE OLD TEST NAMED ITS OWN PROBLEM. Its comment read "it looks exactly like a bug somebody would
   * helpfully deduplicate", which is the argument backwards: when the only defence of a behaviour is that it
   * resembles a defect, that is a reason to check it against the rules, not to pin it with a regression test.
   * The test existed specifically to stop the correction that was needed.
   */

  it("does not raise a corporation whose last share just left a pool", () => {
    const before = board({ public_companies: [company({ bank_pool_percentage: 10 })] } as never);
    expect(
      soldOutRises({
        before,
        after: board(),
        markFor: markAt(5, 4),
        projectRise: projectRiseMove,
      }),
    ).toEqual([]);
  });

  it("does not raise it on any later action either", () => {
    expect(
      soldOutRises({
        before: board(),
        after: board(),
        markFor: markAt(5, 4),
        projectRise: projectRiseMove,
      }),
    ).toEqual([]);
  });

  it("leaves the marker where it is through an actual purchase", () => {
    /* End to end through the reducer and the market atom together, because the two halves of "a buy moves no
       marker" live in different modules and only one of them was ever wrong. */
    const partial = board({
      public_companies: [company({ ipo_pool_percentage: 10, bank_pool_percentage: 0 })],
    } as never);
    const chart = { [PRR]: { x: 5, y: 4, price: 82 } };
    const result = applySandboxMarketAction(
      chart,
      { BuyStock: { game_id: 1, protocol_id: PRR, source: "IPO", par_value: "100" } } as never,
      { projectSale: undefined, projectDividend: undefined },
    );
    expect(result.prices).toBe(chart);
    expect(result.moved).toBeNull();
    expect(
      soldOutRises({
        before: partial,
        after: board(),
        markFor: markAt(5, 4),
        projectRise: projectRiseMove,
      }),
    ).toEqual([]);
  });
});

describe("the end-of-Stock-Round trigger", () => {
  it("raises every sold-out corporation when the round turns over", () => {
    const after = board({
      current_round_type: "OperatingRound",
      public_companies: [company(), company({ company_id: BO, ticker: "B&O" })],
    } as never);
    const rises = soldOutRises({
      before: board(),
      after,
      markFor: markAt(5, 4),
      projectRise: projectRiseMove,
    });
    expect(rises.map((rise) => rise.ticker).sort()).toEqual(["B&O", "PRR"]);
  });

  it("raises a corporation that has been sold out for a while, exactly once", () => {
    /* Design note #746c: the condition is asked at the round boundary and nowhere else, so how LONG a
       corporation has been sold out makes no difference -- it rises once per Stock Round it ends sold out in.
       This replaces a test asserting a second, per-purchase raise on top. */
    const rises = roundEndSoldOutRises(board(), markAt(5, 4), projectRiseMove);
    expect(rises).toHaveLength(1);
  });

  it("does not fire while the Stock Round is still running", () => {
    expect(
      soldOutRises({
        before: board(),
        after: board(),
        markFor: markAt(5, 4),
        projectRise: projectRiseMove,
      }),
    ).toEqual([]);
  });

  it("reports nothing for a token already at the top of its column", () => {
    // A ceiling is not a rise, and a log line saying "$350 rose to $350" would read as a bug.
    expect(roundEndSoldOutRises(board(), markAt(11, 10), projectRiseMove)).toEqual([]);
  });

  it("reports nothing when no chart is injected", () => {
    /* #7's pattern: the traversal comes from `components/`, so `utils/` must cope with not having it. Silence
       is the honest answer -- a rise computed without a chart would be a guess. */
    expect(roundEndSoldOutRises(board(), undefined, undefined)).toEqual([]);
  });
});

describe("there is one trigger and one moment", () => {
  it("says nothing on a message that does not close the round", () => {
    /* Design note #746c: `soldOutRises` now has a single branch, and this is what that buys -- every other
       message in the game gets an empty list, so there is no second path for a trigger to be added to. */
    const passed = applySandboxAction(board(), { PassTurn: { game_id: 1 } } as never, {
      actor: "p0",
    });
    expect(passed.current_round_type).toBe("StockRound");
    expect(
      soldOutRises({
        before: board(),
        after: passed,
        markFor: markAt(5, 4),
        projectRise: projectRiseMove,
      }),
    ).toEqual([]);
  });
});

describe("the reducer raises before it orders the Operating Round", () => {
  /* ==================================================================
   *  DESIGN NOTE 746a (harness): THE QUEUE SORTS ON POST-RISE PRICES
   * ==================================================================
   *
   * The operating order is floated corporations by market price descending, and the sold-out rise lands at the
   * end of the Stock Round -- so a corporation that rises past a rival must operate ahead of it in the very
   * next Operating Round. Had the rise been applied in the shell after the transition, the queue would have
   * been built on pre-rise prices and got that ordering wrong for one round, every time, which is the sort of
   * thing nobody attributes correctly from a playthrough.
   */

  /** Two corporations one cell apart, the lower one sold out. */
  function twoCorps(): GameStateResponse {
    return board({
      consecutive_passes: 1,
      public_companies: [
        company({ company_id: BO, ticker: "B&O", ipo_pool_percentage: 40 }),
        company(),
      ],
    } as never);
  }

  /* THE FIXTURE IS SEARCHED OUT OF THE SHIPPED CHART, not invented -- twice over, because the first two
     attempts were both about TIES rather than overtakes. Putting B&O on the cell PRR rises into is a tie;
     putting it one row up in the same column is the same tie after the rise. A genuine overtake needs a rival
     priced strictly BETWEEN the two, which on this jagged board means a different column. Rather than hunt
     for one by eye and hardcode it, the case is derived, and the derivation is asserted below. */
  const OVERTAKE = (() => {
    for (const start of PRICE_GRID) {
      const up = projectRiseMove(start);
      if (!up || (up.x === start.x && up.y === start.y)) continue;
      const rival = PRICE_GRID.find(
        (cell) => cell.price > start.price && cell.price < up.price,
      );
      if (rival) return { start, up, rival };
    }
    return null;
  })();

  const cellFor = (companyId: number) =>
    companyId === BO
      ? { x: OVERTAKE!.rival.x, y: OVERTAKE!.rival.y, price: OVERTAKE!.rival.price }
      : { x: OVERTAKE!.start.x, y: OVERTAKE!.start.y, price: OVERTAKE!.start.price };

  it("has a rise that genuinely overtakes, so the fixture tests what it claims", () => {
    /* The premise, read back. If this chart had no such triple the ordering tests below would silently be
       about something else, which is exactly how a fixture written from memory passes while proving nothing. */
    expect(OVERTAKE).not.toBeNull();
    expect(OVERTAKE!.rival.price).toBeGreaterThan(OVERTAKE!.start.price);
    expect(OVERTAKE!.up.price).toBeGreaterThan(OVERTAKE!.rival.price);
  });

  it("puts the risen corporation ahead of the rival it passed", () => {
    const after = applySandboxAction(twoCorps(), { PassTurn: { game_id: 1 } } as never, {
      actor: "p1",
      marketPriceFor: (id) => cellFor(id).price,
      marketMarkFor: (id) => cellFor(id) as never,
      projectRise: projectRiseMove,
    });
    expect(after.current_round_type).toBe("OperatingRound");
    expect(after.active_operating_order[0]).toBe(PRR);
  });

  it("leaves the rival first when nothing rises, which is the control", () => {
    /* Without this, an ordering that happened to favour PRR for an unrelated reason -- table order, company
       id -- would pass the test above and prove nothing. */
    const after = applySandboxAction(twoCorps(), { PassTurn: { game_id: 1 } } as never, {
      actor: "p1",
      marketPriceFor: (id) => cellFor(id).price,
      marketMarkFor: (id) => cellFor(id) as never,
      // No traversal injected, so no rise is computed and the queue sees the prices as they stand.
      });
    expect(after.active_operating_order[0]).toBe(BO);
  });

  it("agrees with a queue built directly from the risen prices", () => {
    // Same ordering function, same inputs: the overlay must not be a second sorting rule.
    const risen = buildOperatingOrder(twoCorps(), (id) => (id === PRR ? 100 : 90));
    expect(risen[0]).toBe(PRR);
  });
});

describe("the log says what moved the price", () => {
  it("names the moment", () => {
    /* #435's rule -- "three movers, three words" -- now four. A price that climbed while nobody was acting is
       the one move a player cannot attribute from what they just watched, so the line has to say when. */
    expect(
      describeSoldOutRise({ companyId: PRR, ticker: "PRR", from: 82, to: 90, x: 5, y: 5 }),
    ).toMatch(/PRR rose from \$82 to \$90 .* end of the Stock Round\./);
  });
});

describe("every arm of the compass names a movement the code performs", () => {
  /* #652'S PRECEDENT, which is why this block exists at all: a legend row here once survived a whole
     verification cycle describing a condition no cell on this board carried. A rose is four such rows in a
     nicer shape, and the up arrow was ALREADY one of them when it was asked for. */
  const marketSource = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "sandboxSession.ts"), "utf8");
    // #490a: the notes discuss the missing rule by name and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("has a rise the reducer performs", () => {
    expect(marketSource).toContain("roundEndSoldOutRises(");
  });

  it("has a right and a left the market atom performs", () => {
    expect(marketSource).toContain("ctx.projectDividend(mark, distribute ?");
  });

  it("has a down the market atom performs", () => {
    expect(marketSource).toContain("ctx.projectSale(mark, blocks)");
  });

  it("colours the two gains green and the two losses red", () => {
    // The arrows are the only thing carrying direction at a glance, so the pairing has to be right.
    expect(COMPASS_ARMS.up.rising).toBe(true);
    expect(COMPASS_ARMS.right.rising).toBe(true);
    expect(COMPASS_ARMS.left.rising).toBe(false);
    expect(COMPASS_ARMS.down.rising).toBe(false);
  });

  it("spells out what sold out MEANS, rather than leaving it to a tooltip", () => {
    /* #651: rules belong on screen. Three arms name something the player just did and will recognise; this
       one names a condition of the board that resolves when nobody is clicking. */
    expect(COMPASS_ARMS.up.rule).toMatch(/IPO and Bank Pool both empty/);
  });

  it("promises one rise, not two", () => {
    /* Design note #746c. The caption agreed with the code and both were wrong, which is exactly how a bad rule
       reaches a player with nothing on screen to contradict it -- so the wording is pinned to the rule. */
    expect(COMPASS_ARMS.up.rule).toMatch(/once, at the end of the Stock Round/);
    expect(COMPASS_ARMS.up.rule).not.toMatch(/and again/);
  });

  it("gives every arm a full rule, not just a label", () => {
    for (const arm of Object.values(COMPASS_ARMS)) {
      expect(arm.rule.length).toBeGreaterThan(arm.label.length);
      expect(arm.glyph).toHaveLength(1);
    }
  });
});
