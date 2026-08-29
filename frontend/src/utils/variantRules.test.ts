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
import { dividendSplit } from "./dividendSplit";
import { readStripped } from "./sourceScan";
import {
  boIsLocked,
  dividendStepsExplanation,
  dividendStepsFor,
  turnRevenueSentence,
  rollTurnRevenue,
  STANDARD_VARIANTS,
} from "./gameVariants";
import {
  PRICE_GRID,
  projectDividendCellMove,
  projectDividendFrom,
} from "../components/StockMarketRenderer";
import { fleetLossNotices, noticeBody, noticeGentleRustLine } from "./fleetLossNotice";
import { isTrainLocked } from "./trainLimit";
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

  it("marks them instead of taking them when the variant is on", () => {
    /* ==================================================================
        CORRECTED BY #979: THE OLD MECHANISM ENFORCED A RULE BY HIDING A VALUE
       ==================================================================
       THIS ASSERTED `expect(pr.owned_trains).not.toContain("2")`, and its note said why: "OUT of
       `owned_trains` IS THE MECHANISM. Every surface that counts trains counts that array, so this is what
       implements 'a pending-rust train occupies no train-limit slot' without any of them being told."
       RULED SINCE: "Gently rusted trains do count toward the limit until they are permanently retired at the
       end of their grace run."
       AND THE OLD ASSERTION WAS PINNING TWO BUGS AT ONCE. Every surface reads `owned_trains` -- including
       `ownedTrainRoster`, which is where the route planner gets its trains. A train removed from that array
       has no roster entry, so no route draft, so it cannot be run: #906's headline promise of "one final
       Operating Round run" was unreachable from the moment it was written, and nothing in the suite could
       see it because `pending_rust_trains` was written here, cleared at the turn's end, and read by nothing
       else in the app.
       SO THE TRAIN STAYS AND THE LIST IS A MARK OVER IT. Both halves asserted, because either alone is a
       state the fix can half-reach: the fleet unchanged with no mark is rust that did not happen, and a mark
       with the train gone is #906 again wearing a new field. */
    const gentle = { ...STANDARD_VARIANTS, gentleRust: true };
    const after = applyPhaseChange(phaseFour(gentle), "4");
    const pr = after.public_companies[0];
    expect(pr.owned_trains).toEqual(["2", "2", "3"]);
    expect(pr.pending_rust_trains).toEqual(["2", "2"]);
  });

  it("counts the reprieved trains against the train limit", () => {
    /* THE RULING, AS ARITHMETIC. Phase 4's limit is 3 and this corporation holds three trains, two of them
       reprieved -- so nothing is discarded, and the fleet that survives is the WHOLE fleet. Under #906 this
       corporation counted as holding one train and had room to buy two more.
       DRIVEN THROUGH THE SHARED RULE the buy gate asks, not through a second `>=` written here: if the two
       ever disagree, the corporation is offered a purchase the reducer will take back. */
    const gentle = { ...STANDARD_VARIANTS, gentleRust: true };
    const after = applyPhaseChange(phaseFour(gentle), "4");
    const pr = after.public_companies[0];
    expect(pr.owned_trains).toHaveLength(3);
    expect(isTrainLocked(pr.owned_trains?.length ?? 0, 3)).toBe(true);
  });

  it("forces a discard when the new limit is below the whole fleet", () => {
    /* RULED: "If a phase change drops the corporate train limit lower than a corporation's current total
       train count (including gently rusted trains), force the immediate discard of a train (which will
       typically be the gently rusted train)."
       PHASE 6 CUTS THE LIMIT TO 2 and this corporation holds four, so two must go. The first 6-train rusts
       the 3s (`RUSTS_ON`), which under this variant marks them rather than taking them -- and the fleet is
       then over by exactly the pair the trim should reach for first.
       THE FIXTURE HAD TO ARRIVE AT 6, NOT 5. My first version bought a 5 and asserted a reprieve: nothing
       rusts on 5 in 1830 (2s go on the first 4, 3s on the first 6, 4s on the first Diesel), so the case was
       testing a plain cheapest-first trim and calling it a reprieve test. It passed on `owned_trains` and
       only the `pending_rust_trains` assertion noticed.
       ASSERTED ON WHICH TRAINS SURVIVE, not just on the count. A cheapest-first trim that ignored the marks
       would leave the same NUMBER of trains and the wrong ones -- a corporation holding two reprieved trains
       that die at the end of the turn, having just scrapped the two that would have run all game. */
    const gentle = { ...STANDARD_VARIANTS, gentleRust: true };
    const before = phaseFour(gentle);
    const fleet = {
      ...before,
      public_companies: [
        { company_id: 1, ticker: "PRR", owned_trains: ["3", "3", "5", "6"], is_floated: true },
      ],
    } as unknown as GameStateResponse;
    const after = applyPhaseChange(fleet, "6");
    const pr = after.public_companies[0];
    expect(pr.owned_trains).toEqual(["5", "6"]);
    expect(pr.pending_rust_trains).toEqual([]);
  });

  it("takes a live train too when the reprieved ones are not enough", () => {
    /* THE OTHER SIDE OF "REPRIEVED FIRST": it is an ORDERING, not a rule that only reprieved trains may go.
       One reprieved 3 and three live trains against a limit of 2 means two departures, and the second has to
       come out of the live fleet cheapest-first -- #284's rule, still in force under the reprieved ones. */
    const gentle = { ...STANDARD_VARIANTS, gentleRust: true };
    const before = phaseFour(gentle);
    const fleet = {
      ...before,
      public_companies: [
        { company_id: 1, ticker: "PRR", owned_trains: ["3", "4", "5", "6"], is_floated: true },
      ],
    } as unknown as GameStateResponse;
    const after = applyPhaseChange(fleet, "6");
    const pr = after.public_companies[0];
    /* The reprieved 3 goes first, then the cheapest live train -- the 4. */
    expect(pr.owned_trains).toEqual(["5", "6"]);
    expect(pr.pending_rust_trains).toEqual([]);
  });

  it("does not leave a mark behind on a train the limit took", () => {
    /* THE SILENT FAILURE THIS PREVENTS, and it is worse than a stale field. The reprieve expires by MULTISET
       REMOVAL from `owned_trains`, so a "3" left in `pending_rust_trains` after its own train was discarded
       would, at the end of the turn, remove a DIFFERENT 3 -- a live train, scrapped for a mark belonging to
       one that left two phases ago. Asserted through the trim rather than by inspecting the helper, because
       the two lists are only wrong together. */
    const gentle = { ...STANDARD_VARIANTS, gentleRust: true };
    const before = phaseFour(gentle);
    const fleet = {
      ...before,
      public_companies: [
        { company_id: 1, ticker: "PRR", owned_trains: ["3", "3", "5"], is_floated: true },
      ],
    } as unknown as GameStateResponse;
    const after = applyPhaseChange(fleet, "6");
    const pr = after.public_companies[0];
    expect(pr.owned_trains).toEqual(["3", "5"]);
    expect(pr.pending_rust_trains).toEqual(["3"]);
  });

  it("scraps them at the end of that corporation's turn", () => {
    /* THE RULING, EXACTLY: "dies at the exact end of that specific corporation's next Operating Round turn".
       #979: AND NOW THERE IS A TRAIN TO SCRAP. Under #906 this line cleared a list and nothing else, because
       the trains had left `owned_trains` at the phase change -- so the expiry asserted here was a bookkeeping
       tidy, not a retirement. The fleet is asserted alongside the mark now, which is the half that was
       missing and the half a player can see. */
    const withReprieve = operating({
      variants: { ...STANDARD_VARIANTS, gentleRust: true },
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          owned_trains: ["2", "4"],
          pending_rust_trains: ["2"],
          is_floated: true,
        },
      ] as never,
    });
    const after = endOfSet(withReprieve);
    expect(after.public_companies[0].pending_rust_trains).toEqual([]);
    expect(after.public_companies[0].owned_trains).toEqual(["4"]);
  });

  it("scraps one train per mark, not every train of that model", () => {
    /* THE MULTISET RULE, and the reason the expiry is a splice rather than a filter. A corporation holding a
       reprieved 3 and a live 3 must lose exactly one; `filter(m => !reprieved.includes(m))` takes both, and
       the player watches a train they still owned disappear with no event anywhere to explain it. */
    const withReprieve = operating({
      variants: { ...STANDARD_VARIANTS, gentleRust: true },
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          owned_trains: ["3", "3", "5"],
          pending_rust_trains: ["3"],
          is_floated: true,
        },
      ] as never,
    });
    const after = endOfSet(withReprieve);
    expect(after.public_companies[0].owned_trains).toEqual(["3", "5"]);
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
    /* ==================================================================
        REWRITTEN BY #980, AND ONE OF THE OLD ASSERTIONS WAS PINNING A FALSEHOOD
       ==================================================================
       IT ASSERTED FOUR PHRASES from #906's paragraph, one of which was
       `/no longer counts against the train limit/`. That clause is exactly the rule #979 has just corrected,
       so this case had become a test enforcing the bug -- and it would have failed the fix rather than
       catching anything.
       THE COPY IS STILL PART OF THE RULE, which is why the case survives at all: "one more time" read alone
       is good news, and the sentence has to land on the retirement. The ruled string does, in eleven words
       where #906 took sixty.
       AND THE VARIANT'S LINE IS NOT IN THE BODY ANY MORE. It is its own string so the modal can colour it,
       which the ruling asked for -- so the body is asserted to be the STANDARD sentence even here, and the
       variant's contribution asserted beside it. */
    const [rust] = fleetLossNotices(
      { companyId: 1, ticker: "PRR", rusted: ["2"], discarded: [] },
      "4",
      3,
      true,
    );
    expect(noticeBody(rust)).toBe("1 of your 2-trains has rusted.");
    expect(noticeGentleRustLine(rust)).toBe(
      "Gentle rust: You can run these trains one more time before they retire.",
    );
    expect(noticeGentleRustLine(rust)).toMatch(/before they retire/);
    /* THE CLAUSE #979 KILLED, as an absence, in both strings. A build that restored the old paragraph would
       be telling the player a train-limit rule the engine no longer follows. */
    expect(`${noticeBody(rust)} ${noticeGentleRustLine(rust)}`).not.toMatch(/train limit/);
  });

  it("keeps the ordinary wording when the variant is off", () => {
    const [rust] = fleetLossNotices(
      { companyId: 1, ticker: "PRR", rusted: ["2"], discarded: [] },
      "4",
      3,
      false,
    );
    expect(noticeBody(rust)).toBe("1 of your 2-trains has rusted.");
    /* THE ONLY DIFFERENCE BETWEEN THE TWO TABLES IS THE EXTRA LINE now, which is what "keep the colored text"
       produces: one sentence everybody gets, one the variant adds. */
    expect(noticeGentleRustLine(rust)).toBeNull();
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

describe("the die gets a sentence (design notes #907 -> #944)", () => {
  /* ==================================================================
      SUPERSEDED BY #944, AND THE OLD CASES ARE RECORDED RATHER THAN DELETED
     ==================================================================
     #907 BUILT A FOUR-LINE TABLE PER PERCENTAGE and a `revenueFlavour` that returned a whole sentence with
     the figures baked in -- `"255 → 204 (80%) — a washout on the mainline forced a long detour."` These cases
     pinned it:
         expect(revenueFlavour({ face: 3, percent: 100, ... }, seed)).toBeNull();
         expect(line).toContain("255");  expect(line).toContain("204");  expect(line).toContain("80%");
         ... and a determinism case, and one asserting more than one line could be drawn.
     THREE THINGS REPLACED IT.
       #941 moved the sentence to `turnRevenueSentence`, because the die became one roll per TURN and
       `revenueFlavour` was building a per-route line.
       #944 replaced the four-line table with the supplied 120-line payload, keyed by OUTCOME rather than by
       percentage -- "we cannot map the flavor text strictly to the raw die face. We must map it to the
       effective outcome."
       AND THE `null` CASE IS GONE ON PURPOSE. #907 said nothing on a 100 face, reasoning that a line on a
       third of all runs "would train players to stop reading the log". Twenty distinct `unchanged` lines are
       not that, and a variant that says nothing at all is what produced the original "the variant completely
       failed to trigger" report.
     WHAT SURVIVES: every rule these cases protected is asserted in `flavorText.test.ts` -- determinism, the
     spread of lines drawn, and the figures, which now travel in `turnRevenueSentence`'s own opening rather
     than inside the flavour. This block is a signpost so the next reader finds the move rather than the gap. */

  it("still explains the discrepancy the player can see", () => {
    /* #907'S ACTUAL JOB, re-asked at its new address: "a corporation that ran a $255 route and banked $230
       has a discrepancy on its chips, and without a sentence the player's first thought is that the route
       tracer is broken". The figure and the reason must both be in the line. */
    const parts = { macroRound: 3, subRound: 1, companyId: 6 };
    const line = turnRevenueSentence("PRR", rollTurnRevenue(255, parts), parts);
    expect(line).toContain("PRR ran for $");
    expect(line.length).toBeGreaterThan("PRR ran for $260.".length);
  });
});

describe("a share of the revenue, rounded (design note #922)", () => {
  /* REQUESTED: "calculate the fractional share and round the total payout per player/treasury to the nearest
     whole dollar ... use pure integer arithmetic: Math.floor((revenue * percent_owned + 50) / 100)." */
  const paying = (revenue: number, holdings: Array<[string, number]>, pool = 0) =>
    dividendSplit(
      {
        public_companies: [
          {
            company_id: 1,
            ticker: "PRR",
            bank_pool_percentage: pool,
            player_holdings: holdings.map(([player, percentage]) => ({ player, percentage })),
          },
        ],
      } as unknown as GameStateResponse,
      1,
      String(revenue),
      true,
    );

  it("pays the reported case correctly", () => {
    /* THE REPORT'S OWN NUMBERS: a $27 route paid a 10% holder $2 under the old floor-the-tenth arithmetic.
       `floor((27 * 10 + 50) / 100)` is 3. */
    expect(paying(27, [["a", 10]])?.players[0].amount).toBe(3);
    expect(paying(27, [["a", 20]])?.players[0].amount).toBe(5);
  });

  it("rounds at the halfway point rather than truncating", () => {
    /* $25 at 10% is exactly $2.50 and must land on $3 -- the boundary the `+ 50` exists for, and the one a
       plain `floor(revenue * pct / 100)` gets wrong. */
    expect(paying(25, [["a", 10]])?.players[0].amount).toBe(3);
    expect(paying(24, [["a", 10]])?.players[0].amount).toBe(2);
  });

  it("is unchanged for every revenue 1830 actually prints", () => {
    /* THE CONTROL THAT PROTECTS THE STANDARD GAME. Printed revenues are multiples of ten, where the old
       arithmetic and the new one agree exactly -- so this change must be invisible to a table not playing the
       variant. Checked across a spread rather than at one figure. */
    for (const revenue of [10, 60, 130, 250, 420, 800]) {
      for (const percentage of [10, 20, 30, 50, 60]) {
        const expected = (revenue / 10) * (percentage / 10);
        expect([revenue, percentage, paying(revenue, [["a", percentage]])?.players[0].amount]).toEqual([
          revenue,
          percentage,
          expected,
        ]);
      }
    }
  });

  it("pays the bank pool on the same rule", () => {
    /* The pool is a holder like any other (#706 settled WHICH pool); it must not keep the old arithmetic
       while the players get the new one, or the two halves of one payout round differently. */
    expect(paying(27, [["a", 10]], 20)?.poolSlice).toBe(5);
  });

  it("can exceed the revenue, which is the accepted cost", () => {
    /* ==================================================================
        RECORDED AS A PROPERTY, NOT DISCOVERED AS A BUG
       ==================================================================
       Ten 10% holders of a $27 route take $3 each: $30 paid against $27 earned, the extra coming from the
       bank. The old comment refused rounding for exactly this reason; the trade is being taken deliberately
       now. Pinned so the size of it is visible -- at most half a dollar per certificate -- and so a future
       reader meets it as a decision rather than as an anomaly in a ledger. */
    const split = paying(27, Array.from({ length: 10 }, (_, at) => [`p${at}`, 10] as [string, number]));
    expect(split?.totalPaid).toBe(30);
    expect(split!.totalPaid).toBeGreaterThan(27);
    expect(split!.totalPaid - 27).toBeLessThanOrEqual(5);
  });

  it("uses no floating point on the way there", () => {
    /* The project rule. Asserted on the SOURCE because a correct answer can still be reached through a float
       -- `revenue * pct / 100` rounds correctly for these cases and would violate the constraint silently. */
    const source = readStripped("utils/dividendSplit.ts");
    expect(source).toContain("Math.floor((revenue * percentage + 50) / 100)");
    expect(source).not.toContain("Math.round(");
  });
});

