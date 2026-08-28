/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 904-907 (harness): THE B&O LOCK, THE DELAYED AUCTION, THE REPRIEVE AND THE DIE'S SENTENCE
// ==================================================================
//
// FOUR RULES THAT ALL TURN ON ONE IDEA: a variant changes WHEN something happens, and every gate around it
// must therefore ask about the thing itself rather than about the calendar it used to coincide with. The
// delayed auction's trigger was corrected mid-build -- from "immediately before Stock Round 3" to "at the end
// of the Operating Round set in which the first 3-train is bought" -- and the B&O lock needed no edit at all,
// because it asks whether the auction has concluded. That is the property this file is really pinning.

import {
  applyPhaseChange,
  applySandboxAction,
  boPresidencyRefusal,
  grantBOPresidency,
  openingStockRoundReset,
  operatingRoundSequenceLength,
} from "./sandboxSession";
import { sharePurchaseBlock } from "./sharePurchase";
import {
  boIsLocked,
  dividendStepsExplanation,
  dividendStepsFor,
  revenueFlavour,
  rollRouteRevenue,
  STANDARD_VARIANTS,
} from "./gameVariants";
import {
  PRICE_GRID,
  projectDividendCellMove,
  projectDividendFrom,
} from "../components/StockMarketRenderer";
import { fleetLossNotices, noticeBody, noticeConsequence } from "./fleetLossNotice";
import type { GameStateResponse } from "./gameState";

const DELAYED = { ...STANDARD_VARIANTS, delayedAuction: true };

const LAST_OR = operatingRoundSequenceLength({
  public_companies: [{ company_id: 1, owned_trains: ["3"] }],
} as unknown as GameStateResponse);

/** An Operating Round set on its last round, with whatever trains the case wants in play. */
const operating = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    active_operating_order: [1],
    active_corporation_index: 0,
    sub_round_index: LAST_OR,
    macro_round_number: 2,
    virtual_bank_vgp: "9000",
    public_companies: [{ company_id: 1, ticker: "PRR", owned_trains: ["2"], is_floated: true }],
    private_companies: [],
    player_addresses: ["p1"],
    priority_deal_index: 0,
    active_player_index: 0,
    consecutive_passes: 0,
    ...over,
  }) as unknown as GameStateResponse;

const endOfSet = (state: GameStateResponse) =>
  applySandboxAction(state, { PassTurn: { game_id: 0 } } as never);

describe("the B&O is locked until the auction concludes (design note #904a)", () => {
  it("is not locked at all in a standard game", () => {
    /* THE CONTROL, and the reason this rule is safe to ship before the variant is ever switched on: a
       standard game's auction concludes before Stock Round 1 exists, so this never bites. */
    expect(boIsLocked(STANDARD_VARIANTS, false)).toBe(false);
    expect(boIsLocked(STANDARD_VARIANTS, undefined)).toBe(false);
  });

  it("is locked while a delayed auction is still owed, and released when it concludes", () => {
    expect(boIsLocked(DELAYED, false)).toBe(true);
    expect(boIsLocked(DELAYED, true)).toBe(false);
  });

  it("reads an absent flag as concluded, not as owed", () => {
    /* THE HISTORICAL-LOG CASE, and the direction matters. Every game logged before this field existed is a
       standard game whose auction did happen; reading `undefined` as "still owed" would lock the B&O across
       the whole of every one of them on replay. */
    expect(boIsLocked(DELAYED, undefined)).toBe(false);
  });

  it("refuses the purchase before it refuses anything else about it", () => {
    /* THE LOCK IS FIRST OF THE REFUSALS. Telling a player they are over the 60% cap on a corporation that
       does not exist yet answers a question they did not ask. */
    const state = {
      variants: DELAYED,
      private_auction_complete: false,
      public_companies: [
        {
          company_id: 4,
          ticker: "B&O",
          player_holdings: [{ player: "p1", percentage: 60 }],
          ipo_pool_percentage: 40,
          bank_pool_percentage: 0,
          par_value: "100",
        },
      ],
      player_cash: [{ player: "p1", cash_vgp: "10000" }],
      /* The certificate-limit check walks the privates AND counts the seats; both throw on an absent list.
         Two lines rather than a whole game fixture -- what this case is about is one refusal, not a table. */
      private_companies: [],
      player_addresses: ["p1", "p2"],
    } as unknown as GameStateResponse;
    const blocked = sharePurchaseBlock({
      state,
      buyer: "p1",
      companyId: 4,
      source: "Ipo",
      quantity: 1,
      zone: "white",
      marketPrices: {},
      zoneForPrice: () => "white",
    } as never);
    expect(blocked).toMatch(/not available yet/i);
    // The 60% cap would ALSO have refused this buyer; the lock has to win, or the sentence is about the wrong rule.
    expect(blocked).not.toMatch(/60%/);
  });

  it("lets the same purchase through once the auction has concluded", () => {
    /* THE CONTROL ON THE LOCK. A gate that refused the B&O forever would satisfy every assertion above and
       break the corporation permanently. */
    const state = {
      variants: DELAYED,
      private_auction_complete: true,
      public_companies: [
        {
          company_id: 4,
          ticker: "B&O",
          player_holdings: [],
          ipo_pool_percentage: 100,
          bank_pool_percentage: 0,
          par_value: "100",
        },
      ],
      player_cash: [{ player: "p1", cash_vgp: "10000" }],
      /* The certificate-limit check walks the privates AND counts the seats; both throw on an absent list.
         Two lines rather than a whole game fixture -- what this case is about is one refusal, not a table. */
      private_companies: [],
      player_addresses: ["p1", "p2"],
    } as unknown as GameStateResponse;
    const blocked = sharePurchaseBlock({
      state,
      buyer: "p1",
      companyId: 4,
      source: "Ipo",
      quantity: 1,
      zone: "white",
      marketPrices: {},
      zoneForPrice: () => "white",
    } as never);
    /* `?? ""` because the right answer here is `null` -- no block at all -- and `.not.toMatch` refuses a null
       receiver. Asserted as "not blocked FOR THIS REASON" rather than as `toBeNull()`, so a future rule that
       legitimately refuses this purchase for some other cause does not fail a case about the B&O lock. */
    expect(blocked ?? "").not.toMatch(/not available yet/i);
  });
});

describe("the presidency refusal says why (design note #904b)", () => {
  const bo = (over: Record<string, unknown> = {}) =>
    ({
      public_companies: [
        {
          company_id: 4,
          ticker: "B&O",
          president: null,
          par_value: null,
          ipo_pool_percentage: 100,
          player_holdings: [],
          total_shares_issued: 0,
          ...over,
        },
      ],
    }) as unknown as GameStateResponse;

  it("allows the grant when nothing is in the way", () => {
    expect(boPresidencyRefusal(bo())).toBeNull();
    expect(grantBOPresidency(bo(), "p1", "100").public_companies[0].president).toBe("p1");
  });

  it("names the collision instead of swallowing it", () => {
    /* THE WHOLE POINT OF THE PRE-PATCH. This was a bare `return state`, and the caller bailed before logging
       -- so a player who had just PAID for the B&O private received no certificate and no explanation. */
    const taken = bo({ president: "someone-else" });
    expect(boPresidencyRefusal(taken)).toMatch(/already has a President/i);
    expect(grantBOPresidency(taken, "p1", "100")).toBe(taken);
  });

  it("refuses rather than inventing shares from a drawn-down IPO", () => {
    /* THE QUIET THIRD COLLISION. The grant subtracts the President's 20% from the IPO under a
       `Math.max(0, ...)`; with the pool below 20% that clamp under-removes while still crediting the winner,
       which creates shares. Refused before the subtraction rather than clamped after it. */
    const drained = bo({ ipo_pool_percentage: 10 });
    expect(boPresidencyRefusal(drained)).toMatch(/create shares that do not exist/i);
    expect(grantBOPresidency(drained, "p1", "100")).toBe(drained);
  });
});

describe("the delayed auction fires on the 3-train (design note #905)", () => {
  it("opens an ordinary Stock Round while the phase is still 2", () => {
    /* THE CONTROL. Under the delayed variant with no 3-train bought, the OR set must hand off to a Stock
       Round exactly as it always did -- the auction is owed but not yet due. */
    const after = endOfSet(operating({ variants: DELAYED, private_auction_complete: false }));
    expect(after.current_round_type).toBe("StockRound");
  });

  it("hands off to the auction at the end of the set the 3-train arrived in", () => {
    const after = endOfSet(
      operating({
        variants: DELAYED,
        private_auction_complete: false,
        public_companies: [
          { company_id: 1, ticker: "PRR", owned_trains: ["2", "3"], is_floated: true },
        ] as never,
      }),
    );
    expect(after.current_round_type).toBe("WaterfallAuction");
    /* THE CALENDAR STILL ADVANCES, or `OpenStockRound` would re-open the round just played. */
    expect(after.macro_round_number).toBe(3);
  });

  it("does not fire twice", () => {
    /* `private_auction_complete` is the guard, not the round number -- which is what makes a `RevertTo` into
       a later Operating Round set safe. */
    const after = endOfSet(
      operating({
        variants: DELAYED,
        private_auction_complete: true,
        public_companies: [
          { company_id: 1, ticker: "PRR", owned_trains: ["3"], is_floated: true },
        ] as never,
      }),
    );
    expect(after.current_round_type).toBe("StockRound");
  });

  it("never fires in a standard game", () => {
    const after = endOfSet(
      operating({
        variants: STANDARD_VARIANTS,
        private_auction_complete: false,
        public_companies: [
          { company_id: 1, ticker: "PRR", owned_trains: ["3"], is_floated: true },
        ] as never,
      }),
    );
    expect(after.current_round_type).toBe("StockRound");
  });

  it("still fires when the phase ran past 3 within one set", () => {
    /* A set in which both the first 3-train AND the first 4-train are bought is still a set in which the
       first 3-train was bought. A test for `tier === "3"` would miss it and the auction would never run. */
    const after = endOfSet(
      operating({
        variants: DELAYED,
        private_auction_complete: false,
        public_companies: [
          { company_id: 1, ticker: "PRR", owned_trains: ["3", "4"], is_floated: true },
        ] as never,
      }),
    );
    expect(after.current_round_type).toBe("WaterfallAuction");
  });
});

describe("a Stock Round opening wipes what the last one left (design note #909)", () => {
  /* ==================================================================
      TWO OPENINGS, AND THE NEWER ONE WIPED NOTHING
     ==================================================================
     REPORTED: "If the sell-then-buy lock does not clear when a new Stock Round opens, players are permanently
     locked out of legal purchases for the remainder of the game."
     THE SELL-THEN-BUY LOCK IS THE ONE THAT BITES, but it is not the only turn-scoped fact a new round
     invalidates, and the bug was structural rather than specific: `settleRoundTransitions` had cleared these
     since #744, and #905's delayed auction added a SECOND way into a Stock Round -- `OpenStockRound`, opening
     Stock Round 3 mid-game -- which set the round type and cleared none of them.
     SO THE ASSERTION IS ABOUT THE SHARED RULE, not about one field. `openingStockRoundReset` is what both
     openings spread; a field added to one opening and not the other is the shape this replaces. */

  const closingRound = {
    priority_deal_index: 1,
    player_addresses: ["a", "b", "c"],
    active_player_index: 0,
    consecutive_passes: 2,
    last_trader_index: 2,
    turn_action_taken: true,
    sold_this_round: { a: [1, 4], c: [2] },
  } as unknown as GameStateResponse;

  it("clears every fact the finished round owned", () => {
    const reset = openingStockRoundReset(closingRound);
    expect(reset.sold_this_round).toEqual({});
    expect(reset.consecutive_passes).toBe(0);
    expect(reset.last_trader_index).toBeNull();
    expect(reset.turn_action_taken).toBe(false);
  });

  it("seats the Priority Deal holder, not whoever was acting", () => {
    /* #353: the Priority Deal holder opens the Stock Round, and that is the whole point of holding it. The
       closing round left the cursor on seat 0; the deal is with seat 1. */
    expect(openingStockRoundReset(closingRound).active_player_index).toBe(1);
  });

  it("is spread by the Operating Round set boundary", () => {
    /* THE OPENING THAT ALREADY WORKED, asserted so the shared helper cannot regress it while fixing the
       other one. */
    const after = endOfSet(
      operating({ sold_this_round: { p1: [1] }, priority_deal_index: 0 } as never),
    );
    expect(after.current_round_type).toBe("StockRound");
    expect(after.sold_this_round).toEqual({});
  });
});

describe("gentle rust reprieves a train for one turn (design note #906)", () => {
  const phaseFour = (variants: typeof STANDARD_VARIANTS) =>
    ({
      current_round_type: "OperatingRound",
      active_operating_order: [1],
      active_corporation_index: 0,
      sub_round_index: LAST_OR,
      macro_round_number: 2,
      virtual_bank_vgp: "9000",
      variants,
      private_companies: [],
      player_addresses: ["p1"],
      priority_deal_index: 0,
      active_player_index: 0,
      consecutive_passes: 0,
      /* OWNS A 3, BUYS A 4. The first draft owned a 4 already, so buying another advanced nothing and the
         rust never ran -- the fixture, not the rule, was wrong. The phase must CROSS into 4 here. */
      public_companies: [
        { company_id: 1, ticker: "PRR", owned_trains: ["2", "2", "3"], is_floated: true },
      ],
    }) as unknown as GameStateResponse;

  /* THROUGH `applyPhaseChange`, NOT THROUGH A PURCHASE. The first draft dispatched `BuyHardwareFromPool` and
     asserted the 2-trains had gone -- but that message carries no model and buys whatever tier the depot is
     offering, so it bought another 3 and advanced nothing. Driving the arriving tier directly tests the RULE
     rather than the depot's inventory arithmetic, which has its own file. */
  it("destroys the 2-trains outright under standard rules", () => {
    const after = applyPhaseChange(phaseFour(STANDARD_VARIANTS), "4");
    const pr = after.public_companies[0];
    expect(pr.owned_trains).not.toContain("2");
    expect(pr.pending_rust_trains ?? []).toEqual([]);
  });

  it("moves them to a reprieve instead when the variant is on", () => {
    const gentle = { ...STANDARD_VARIANTS, gentleRust: true };
    const after = applyPhaseChange(phaseFour(gentle), "4");
    const pr = after.public_companies[0];
    /* OUT OF `owned_trains` IS THE MECHANISM. Every surface that counts trains counts that array, so this is
       what implements "a pending-rust train occupies no train-limit slot" without any of them being told. */
    expect(pr.owned_trains).not.toContain("2");
    expect(pr.pending_rust_trains).toEqual(["2", "2"]);
  });

  it("scraps them at the end of that corporation's turn", () => {
    /* THE RULING, EXACTLY: "dies at the exact end of that specific corporation's next Operating Round turn". */
    const withReprieve = operating({
      variants: { ...STANDARD_VARIANTS, gentleRust: true },
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          owned_trains: ["4"],
          pending_rust_trains: ["2"],
          is_floated: true,
        },
      ] as never,
    });
    const after = endOfSet(withReprieve);
    expect(after.public_companies[0].pending_rust_trains).toEqual([]);
  });

  it("does not scrap another corporation's reprieve on the way past", () => {
    /* THE ASYMMETRY WITH THE REVENUE CLEAR BESIDE IT. That one clears every corporation because over-clearing
       is free; this is not free -- clearing a corporation that has not had its turn destroys a train still
       owed a run. */
    const twoQueued = operating({
      variants: { ...STANDARD_VARIANTS, gentleRust: true },
      active_operating_order: [1, 2] as never,
      active_corporation_index: 0,
      public_companies: [
        { company_id: 1, ticker: "PRR", owned_trains: ["4"], pending_rust_trains: ["2"], is_floated: true },
        { company_id: 2, ticker: "NYC", owned_trains: ["4"], pending_rust_trains: ["2"], is_floated: true },
      ] as never,
    });
    const after = applySandboxAction(twoQueued, { PassTurn: { game_id: 0 } } as never);
    expect(after.public_companies[0].pending_rust_trains).toEqual([]);
    expect(after.public_companies[1].pending_rust_trains).toEqual(["2"]);
  });

  it("tells the player it is a deadline, not a gift", () => {
    /* THE COPY IS PART OF THE RULE. "One final run" read alone is good news, and a player who stops there
       plans a turn around a train that will not be here. */
    const [rust] = fleetLossNotices(
      { companyId: 1, ticker: "PRR", rusted: ["2"], discarded: [] },
      "4",
      3,
      true,
    );
    expect(noticeBody(rust)).toMatch(/NOT gone yet/);
    expect(noticeBody(rust)).toMatch(/scrapped the moment that turn ends/);
    expect(noticeBody(rust)).toMatch(/no longer counts against the train limit/);
    expect(noticeConsequence(rust)).toMatch(/Run it while you still have it/);
  });

  it("keeps the ordinary wording when the variant is off", () => {
    const [rust] = fleetLossNotices(
      { companyId: 1, ticker: "PRR", rusted: ["2"], discarded: [] },
      "4",
      3,
      false,
    );
    expect(noticeBody(rust)).toMatch(/destroyed with it/);
    expect(noticeBody(rust)).not.toMatch(/NOT gone yet/);
  });
});

describe("the market rewards the size of the dividend (design note #908)", () => {
  const DYNAMIC = { ...STANDARD_VARIANTS, dynamicStockMarket: true };

  it("moves one cell for any payout under standard rules", () => {
    /* THE CONTROL, and the one that protects every existing game: with the variant off the step count is 1
       whatever the figures say, which is 1830. A `dividendStepsFor` that reasoned about multiples before
       checking the flag would silently change the base game. */
    expect(dividendStepsFor(10, 100, STANDARD_VARIANTS)).toBe(1);
    expect(dividendStepsFor(1000, 100, STANDARD_VARIANTS)).toBe(1);
    expect(dividendStepsFor(0, 100, STANDARD_VARIANTS)).toBe(1);
  });

  it("does not move at all below the share price", () => {
    expect(dividendStepsFor(99, 100, DYNAMIC)).toBe(0);
    expect(dividendStepsFor(1, 100, DYNAMIC)).toBe(0);
  });

  it("moves one cell from 1x, and two from 2x", () => {
    /* THE BOUNDARIES ARE INCLUSIVE UPWARD, which is the one phrase in the rule that could be read either way:
       a payout EQUAL to the share price is not "less than" it. Pinned at both edges because a table arguing
       about a $100 payout on a $100 share is a bad afternoon. */
    expect(dividendStepsFor(100, 100, DYNAMIC)).toBe(1);
    expect(dividendStepsFor(199, 100, DYNAMIC)).toBe(1);
    expect(dividendStepsFor(200, 100, DYNAMIC)).toBe(2);
  });

  it("caps at two however large the payout", () => {
    // "2x to 3x (or higher)" is two cells; there is no third step to earn.
    expect(dividendStepsFor(300, 100, DYNAMIC)).toBe(2);
    expect(dividendStepsFor(5000, 100, DYNAMIC)).toBe(2);
  });

  it("falls back to one cell rather than two on a priceless company", () => {
    /* Every payout is infinitely many times nothing, so a naive multiple would hand the variant's biggest
       reward to the company with the weakest claim on it. And no division anywhere, so a zero price is a
       fallback rather than an exception. */
    expect(dividendStepsFor(500, 0, DYNAMIC)).toBe(1);
    expect(dividendStepsFor(500, null, DYNAMIC)).toBe(1);
  });

  it("pays nothing for a payout of nothing", () => {
    expect(dividendStepsFor(0, 100, DYNAMIC)).toBe(0);
  });

  it("actually moves the token that many cells on the real chart", () => {
    /* THE INTEGRATION HALF. `dividendStepsFor` being right proves nothing about the projection taking the
       count -- the same gap a control walked through twice in Batch 7. Asserted against the REAL `PRICE_GRID`
       and by CELL, because prices repeat across rows (#434). */
    const start = PRICE_GRID.find((cell) => cell.x === 2 && cell.y === 3);
    expect(start).toBeDefined();
    const one = projectDividendCellMove({ x: start!.x, y: start!.y }, "pay", 1);
    const two = projectDividendCellMove({ x: start!.x, y: start!.y }, "pay", 2);
    const none = projectDividendCellMove({ x: start!.x, y: start!.y }, "pay", 0);
    expect({ x: one!.x, y: one!.y }).toEqual({ x: start!.x + 1, y: start!.y });
    expect({ x: two!.x, y: two!.y }).toEqual({ x: start!.x + 2, y: start!.y });
    /* ZERO STEPS IS A NON-MOVE, not a no-op that loses the token: it must return where it started. */
    expect({ x: none!.x, y: none!.y }).toEqual({ x: start!.x, y: start!.y });
  });

  it("tells the readout exactly what it tells the board", () => {
    /* #891'S BUG, WHICH THIS VARIANT COULD HAVE RECREATED WHOLESALE. The two projections share
       `dividendStepFrom`, so the count reaches both -- and a two-cell move that the bar reported as one would
       be the same report all over again: "upon paying dividends, the corporation's share price did not
       actually move up", inverted. */
    const start = PRICE_GRID.find((cell) => cell.x === 2 && cell.y === 3)!;
    const moved = projectDividendCellMove({ x: start.x, y: start.y }, "pay", 2)!;
    const projected = projectDividendFrom({ x: start.x, y: start.y }, "pay", 2)!;
    expect(projected.price).toBe(moved.price);
    expect(projected.moves).toBe(true);
  });

  it("reports a refused move as a non-move in the readout", () => {
    /* A zero-step payout must read as "does not move" rather than as a move to the same price, or the bar
       says nothing at all happened when in fact a rule fired. */
    const start = PRICE_GRID.find((cell) => cell.x === 2 && cell.y === 3)!;
    const projected = projectDividendFrom({ x: start.x, y: start.y }, "pay", 0)!;
    expect(projected.moves).toBe(false);
    expect(projected.price).toBe(start.price);
  });

  it("explains itself only when the variant is on", () => {
    expect(dividendStepsExplanation(50, 100, STANDARD_VARIANTS)).toBeNull();
    expect(dividendStepsExplanation(50, 100, DYNAMIC)).toMatch(/does not move/i);
    expect(dividendStepsExplanation(250, 100, DYNAMIC)).toMatch(/two cells/i);
  });
});

describe("the die gets a sentence (design note #907)", () => {
  const seed = { macroRound: 3, subRound: 1, companyId: 6, trainOrdinal: 0 };

  it("says nothing when the die changed nothing", () => {
    /* Two faces in six are 100%, and a line reading "the trains ran normally" on a third of all runs teaches
       players to stop reading the log. */
    expect(revenueFlavour({ face: 3, percent: 100, printed: 200, adjusted: 200 }, seed)).toBeNull();
  });

  it("names the figures and the direction before it is funny", () => {
    /* THE JOKE HAS A JOB. A corporation that banked $230 on a $255 route has a discrepancy on its chips, and
       this project has twice had that reported as a broken route tracer. */
    const line = revenueFlavour({ face: 1, percent: 80, printed: 255, adjusted: 204 }, seed);
    expect(line).toContain("255");
    expect(line).toContain("204");
    expect(line).toContain("80%");
    expect(line).toContain("down");
  });

  it("picks the same line every time, for the same roll", () => {
    /* DETERMINISTIC, for the same reason the face is: the Activity Log is a shared record, and two players
       replaying one log must not read two different explanations of one event. */
    const roll = rollRouteRevenue(255, seed);
    const first = revenueFlavour(roll, seed);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(revenueFlavour(roll, seed)).toBe(first);
    }
  });

  it("draws on more than one line", () => {
    /* Otherwise the battery is one joke told forever. Asserted as a spread over turns rather than as
       "different from each other", which two independent draws are not obliged to be. */
    const lines = new Set(
      Array.from({ length: 30 }, (_, at) => {
        const parts = { ...seed, macroRound: at + 1 };
        const roll = rollRouteRevenue(200, parts);
        return revenueFlavour(roll, parts);
      }).filter((line): line is string => line !== null),
    );
    expect(lines.size).toBeGreaterThan(2);
  });
});
