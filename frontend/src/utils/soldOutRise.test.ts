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
} from "../gameEngine/sandboxSession";
import { isSoldOut, roundEndSoldOutRises, soldOutRises, describeSoldOutRise } from "../gameEngine/soldOutRise";
import { projectRiseMove, COMPASS_ARMS, PRICE_GRID } from "../components/StockMarketRenderer";
import type { GameStateResponse } from "../gameEngine/gameState";

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

  /* ==================================================================
   *  DESIGN NOTE 1600 (harness): THE SAME PROPERTY, ON THE CHART THE REDUCER COMMITS
   * ==================================================================
   *
   * These cases used to hand the reducer a POSITIONLESS board plus `marketPriceFor` / `marketMarkFor` resolvers,
   * and passed on #746a's overlay: the queue sorted on a rise nothing committed. That overlay is retired (Stage 8.1,
   * S8-1) because on every board that carries `market_positions` -- every room, replay and the shell -- the queue
   * ignored it and locked on the pre-rise chart. The property is unchanged; the board now carries the chart, so the
   * rise is COMMITTED to `market_positions` and the queue is settled from what was committed. */
  /** Two corporations one cell apart, the lower one sold out -- on a charted board. */
  function twoCorps(): GameStateResponse {
    return board({
      consecutive_passes: 1,
      public_companies: [
        company({ company_id: BO, ticker: "B&O", ipo_pool_percentage: 40 }),
        company(),
      ],
      market_positions: {
        [BO]: { ...cellFor(BO), enteredAt: 1 },
        [PRR]: { ...cellFor(PRR), enteredAt: 2 },
      },
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

  function cellFor(companyId: number) {
    return companyId === BO
      ? { x: OVERTAKE!.rival.x, y: OVERTAKE!.rival.y, price: OVERTAKE!.rival.price }
      : { x: OVERTAKE!.start.x, y: OVERTAKE!.start.y, price: OVERTAKE!.start.price };
  }

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
      projectRise: projectRiseMove,
    });
    expect(after.current_round_type).toBe("OperatingRound");
    // #1600: the rise is on the committed chart, and the queue was read off that chart.
    expect(after.market_positions?.[PRR]?.price).toBe(OVERTAKE!.up.price);
    expect(after.active_operating_order[0]).toBe(PRR);
  });

  it("leaves the rival first when nothing rises, which is the control", () => {
    /* Without this, an ordering that happened to favour PRR for an unrelated reason -- table order, company
       id -- would pass the test above and prove nothing. */
    const after = applySandboxAction(twoCorps(), { PassTurn: { game_id: 1 } } as never, {
      actor: "p1",
      // No traversal injected, so no rise is computed and the queue sees the prices as they stand.
    });
    expect(after.market_positions?.[PRR]?.price).toBe(OVERTAKE!.start.price);
    expect(after.active_operating_order[0]).toBe(BO);
  });

  it("agrees with a queue built directly from the risen prices", () => {
    /* Same ordering function, same inputs: the settle must not be a second sorting rule. #1600: the "risen prices"
       are a chart carrying PRR's risen cell, which is exactly what the reducer committed before it settled. */
    const risenBoard = {
      ...twoCorps(),
      market_positions: { ...twoCorps().market_positions, [PRR]: { ...OVERTAKE!.up, enteredAt: 3 } },
    } as GameStateResponse;
    const risen = buildOperatingOrder(risenBoard);
    expect(risen[0]).toBe(PRR);
    const opened = applySandboxAction(twoCorps(), { PassTurn: { game_id: 1 } } as never, {
      actor: "p1",
      projectRise: projectRiseMove,
    });
    expect(opened.market_positions).toEqual(risenBoard.market_positions);
    expect(opened.active_operating_order).toEqual(risen);
  });
});

describe("the risers move in share-value order, not catalog order (#1601, S8-4)", () => {
  /* ==================================================================
   *  DESIGN NOTE 1601 (harness): 4.5'S ORDER, ON THE CHART THE REDUCER COMMITS
   * ==================================================================
   *
   * "Tokens are moved in share value order, with the highest priced corporation's token being moved first." The rise
   * list used to come back in `public_companies` order and was committed in that order, each riser stamped as the
   * next arrival -- so two risers from one cell swapped places in the stack whenever the catalog listed the lower one
   * first. Every case below closes a Stock Round through the reducer on a charted board and reads the committed
   * chart, and every case is run in BOTH catalog orders. Cells are real cells of the standard chart, checked. */

  const cell = (x: number, y: number) => {
    const found = PRICE_GRID.find((entry) => entry.x === x && entry.y === y);
    if (!found) throw new Error(`no chart cell at (${x}, ${y})`);
    return { x, y, price: found.price };
  };
  const NYC = 3; // any corporation id distinct from PRR and B&O will do; the ticker is what the log prints
  const BM = 8;

  /** Close a Stock Round in which every listed corporation is sold out; `catalog` fixes `public_companies` order. */
  function closeRound(
    tokens: Array<{ id: number; ticker: string; x: number; y: number; enteredAt: number }>,
    catalog: number[],
  ) {
    const byId = new Map(tokens.map((token) => [token.id, token]));
    const before = board({
      consecutive_passes: 1,
      public_companies: catalog.map((id) => company({ company_id: id, ticker: byId.get(id)!.ticker })),
      market_positions: Object.fromEntries(
        tokens.map((token) => [token.id, { ...cell(token.x, token.y), enteredAt: token.enteredAt }]),
      ),
    } as never);
    const rises = roundEndSoldOutRises(before, (id) => before.market_positions?.[id] ?? null, projectRiseMove);
    const after = applySandboxAction(before, { PassTurn: { game_id: 1 } } as never, {
      actor: "p1",
      projectRise: projectRiseMove,
    });
    return { before, rises, after };
  }

  const PRICED = [
    { id: PRR, ticker: "PRR", x: 7, y: 8, enteredAt: 1 }, // $90
    { id: NYC, ticker: "NYC", x: 9, y: 8, enteredAt: 2 }, // $111
  ];

  it("raises two sold-out corporations in one Stock Round close", () => {
    const { before, after } = closeRound(PRICED, [PRR, NYC]);
    expect([before.market_positions?.[PRR]?.price, before.market_positions?.[NYC]?.price]).toEqual([90, 111]);
    expect(after.current_round_type).toBe("OperatingRound");
    expect(after.market_positions?.[PRR]).toMatchObject({ x: 7, y: 9, price: 100 });
    expect(after.market_positions?.[NYC]).toMatchObject({ x: 9, y: 9, price: 126 });
  });

  it("moves the higher-priced riser first -- in the rise list and in the arrivals it is stamped with", () => {
    const { rises, after } = closeRound(PRICED, [PRR, NYC]); // the catalog lists the cheaper one first
    expect(rises.map((rise) => rise.ticker)).toEqual(["NYC", "PRR"]);
    expect(after.market_positions?.[NYC]?.enteredAt).toBe(3);
    expect(after.market_positions?.[PRR]?.enteredAt).toBe(4);
    // Equal share values: 6.0's positional order decides which moves first -- the rightmost column.
    const tied = closeRound(
      [
        { id: PRR, ticker: "PRR", x: 8, y: 8, enteredAt: 1 }, // $100, column 8
        { id: NYC, ticker: "NYC", x: 9, y: 7, enteredAt: 2 }, // $100, column 9
      ],
      [PRR, NYC],
    );
    expect([tied.before.market_positions?.[PRR]?.price, tied.before.market_positions?.[NYC]?.price]).toEqual([100, 100]);
    expect(tied.rises.map((rise) => rise.ticker)).toEqual(["NYC", "PRR"]);
  });

  it("gives the same chart, the same rise list and the same operating queue whichever order the catalog lists them in", () => {
    const one = closeRound(PRICED, [PRR, NYC]);
    const other = closeRound(PRICED, [NYC, PRR]);
    expect(other.rises).toEqual(one.rises);
    expect(other.after.market_positions).toEqual(one.after.market_positions);
    expect(other.after.active_operating_order).toEqual(one.after.active_operating_order);
    expect(one.after.active_operating_order).toEqual([NYC, PRR]);
  });

  /** B&M sits on top of PRR on the $100 cell; both are sold out. */
  const STACKED = [
    { id: PRR, ticker: "PRR", x: 8, y: 8, enteredAt: 5 },
    { id: BM, ticker: "B&M", x: 8, y: 8, enteredAt: 2 },
  ];

  it("lands two risers from one cell in one cell", () => {
    const { before, after } = closeRound(STACKED, [PRR, BM]);
    expect(before.market_positions?.[PRR]?.price).toBe(100);
    expect(projectRiseMove(before.market_positions![PRR]!)).toEqual({ x: 8, y: 9, price: 112 });
    expect(after.market_positions?.[PRR]).toMatchObject({ x: 8, y: 9, price: 112 });
    expect(after.market_positions?.[BM]).toMatchObject({ x: 8, y: 9, price: 112 });
  });

  it("keeps the stack's order through the rise -- the token on top moves first and stays on top, in either catalog order", () => {
    for (const catalog of [[PRR, BM], [BM, PRR]]) {
      const { rises, after } = closeRound(STACKED, catalog);
      expect(rises.map((rise) => rise.ticker)).toEqual(["B&M", "PRR"]);
      // Arrivals 6 and 7 on the new cell: B&M arrived first, so it is on top (4.5: the newcomer goes to the bottom).
      expect(after.market_positions?.[BM]?.enteredAt).toBe(6);
      expect(after.market_positions?.[PRR]?.enteredAt).toBe(7);
      // And the Operating Round the close opened reads that stack: B&M first -- not company id, not catalog.
      expect(after.active_operating_order).toEqual([BM, PRR]);
      expect(after.active_operating_order).toEqual(buildOperatingOrder(after));
    }
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
    const raw = fs.readFileSync(path.join(__dirname, "..", "gameEngine", "sandboxSession.ts"), "utf8");
    // #490a: the notes discuss the missing rule by name and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("has a rise the reducer performs", () => {
    /* #1600: the reducer's one call is the COMMIT (`soldOutRises(` in `applySandboxActionInner`); the second call,
       #746a's overlay in the round transition, is retired -- the queue is settled from the committed chart. */
    expect(marketSource).toContain("soldOutRises(");
    expect(marketSource).not.toContain("roundEndSoldOutRises(");
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
