/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 963-967 (harness): THE MULTI-TRAIN MATH, DRIVEN RATHER THAN READ
// ==================================================================
//
// THE HEADLINE CASE IS THE FIRST BLOCK, and it exists because I was asked to verify the variant math locally
// rather than reason about it. It drives the real reducer over the reported turn and hands the result to the
// real `dividendDeclaration` -- the same two functions the app composes -- so "the dividend reads the final
// modified total" is demonstrated rather than asserted.
//
// WHAT IT ESTABLISHES, AND WHAT IT CANNOT. It proves the reducer accumulates and the Dividends step spends
// what the reducer banked. It CANNOT prove the shell dispatched every route, which is the other half of the
// reported symptom and the half I have not been able to reproduce -- see the report accompanying this batch.
// #963 closes the gap that made the two indistinguishable on screen: the log line and the dividend now read
// one field, so they can no longer name two different numbers.

import { applySandboxAction } from "./sandboxSession";
import { summarisePrivateRevenueForPlayer } from "./sandboxSession";
import { dividendDeclaration } from "./dividendStep";
import {
  applyRevenuePercent,
  REVENUE_MODIFIER_BY_FACE,
  revenueDieFace,
  roundToTen,
  STANDARD_VARIANTS,
} from "./gameVariants";
import type { GameStateResponse } from "./gameState";
import { readStripped, sliceBetween } from "./sourceScan";

/* A corporation whose turn actually rolls something -- corporation 4's seed is a 100% face, which would make
   every assertion below compare the identity function with itself. The guard case says so out loud. */
const BO = 6;
const TURN = { macroRound: 3, subRound: 1, companyId: BO };

const board = (): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_sub_phase: "Routes",
    active_operating_order: [BO, 7],
    active_corporation_index: 0,
    player_addresses: ["p1"],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    private_companies: [],
    variants: { ...STANDARD_VARIANTS, unpredictableRevenue: true },
    public_companies: [
      { company_id: BO, ticker: "B&O", last_route_revenue: "0", owned_trains: ["4", "4", "4"] },
      { company_id: 7, ticker: "XX", last_route_revenue: "0", owned_trains: ["2"] },
    ],
  }) as unknown as GameStateResponse;

const runRoute = (state: GameStateResponse) =>
  applySandboxAction(state, {
    RunManualRoute: { protocol_id: BO, path: [{ hex: "F2" }, { hex: "A9" }] },
  } as never);

describe("the dividend spends the whole turn (design note #963)", () => {
  it("uses a turn whose die actually moves the figure", () => {
    /* THE FIXTURE GUARD, learned the hard way in Batch 15: a corporation seeded to a 100% face makes every
       case below vacuous while looking green. */
    expect(REVENUE_MODIFIER_BY_FACE[revenueDieFace(TURN) - 1]).not.toBe(100);
  });

  it("banks the aggregate, not the last route", () => {
    /* REPORTED: "the Dividends phase calculated the payout at $6/share (using only the $60 from a single
       route)." Driven over three routes, and the expected figure is composed from the same two steps the
       reducer composes rather than typed in. */
    let state = board();
    const printedEach = Number(runRoute(board()).public_companies[0].printed_route_revenue);
    for (let route = 0; route < 3; route += 1) state = runRoute(state);

    const percent = REVENUE_MODIFIER_BY_FACE[revenueDieFace(TURN) - 1];
    const expected = roundToTen(applyRevenuePercent(printedEach * 3, percent));
    expect(Number(state.public_companies[0].last_route_revenue)).toBe(expected);
    expect(Number(state.public_companies[0].printed_route_revenue)).toBe(printedEach * 3);
  });

  it("hands the Dividends step that same figure", () => {
    /* THE JOIN, END TO END. The reducer banks and `dividendDeclaration` spends, and this drives the real
       composition -- an implementation that read one route would show up here as a third of the total. */
    let state = board();
    for (let route = 0; route < 3; route += 1) state = runRoute(state);
    const banked = Number(state.public_companies[0].last_route_revenue);

    const declaration = dividendDeclaration({
      lastRouteRevenue: state.public_companies[0].last_route_revenue,
      committedRevenue: null,
      skippedRoutes: false,
    });
    expect(declaration.revenue).toBe(banked);
    expect(declaration.perShare).toBe(Math.floor(banked / 10));
  });

  it("pays more per share for three routes than for one", () => {
    /* THE REPORT'S SHAPE, as a comparison rather than a figure. "$6/share from a single route" against a
       three-route turn is exactly this inequality failing. */
    const one = runRoute(board());
    let three = board();
    for (let route = 0; route < 3; route += 1) three = runRoute(three);

    const perShare = (state: GameStateResponse) =>
      dividendDeclaration({
        lastRouteRevenue: state.public_companies[0].last_route_revenue,
        committedRevenue: null,
        skippedRoutes: false,
      }).perShare;
    expect(perShare(three)).toBeGreaterThan(perShare(one));
  });

  it("moves the cursor to Dividends on the FIRST route", () => {
    /* ==================================================================
        THE FACT BEHIND THE MIS-STAMPED LOG LINE
       ==================================================================
       Not a bug -- the cursor is meant to advance once a route has run. What it means for #958's stamp is
       that every later route AND the turn's summary line are dispatched against a state that already says
       Dividends, which is why the summary states its step instead of reading one. Pinned because the log fix
       is only correct while this remains true. */
    expect(runRoute(board()).operating_sub_phase).toBe("Dividends");
  });
});

describe("the turn's summary line reads the reducer (design note #963)", () => {
  /* ==================================================================
      #1017 MOVED THE BLOCK; EVERY RULING IN IT STILL HOLDS
     ==================================================================
     This sliced the run-trains click handler, which is where #941 raised the sentence. It is raised from the
     shared dispatch path now -- REPORTED: "the variant texts may only be printing in the Activity Log for the
     local player who's the president", and a click handler runs on exactly one browser.
     WHAT #963 RULED IS UNCHANGED AND IS STILL WHAT THESE CASES CHECK: the sentence and the dividend read ONE
     figure, the reducer's, so they can never name different numbers; and the line is stamped with the step it
     DESCRIBES rather than the step the cursor has moved on to.
     THE DRAFTS FALLBACK IS GONE, and that is the one ruling that genuinely changed. #963 kept `printedFromDrafts`
     for "a state that does not report the fields at all" -- but a replaying client has no drafts to fall back
     ON, so the fallback could only ever have been populated on the acting browser. A fallback that works on one
     seat and silently yields zero on the others is worse than not having one: it would give the president a
     sentence and everybody else nothing, which is the bug this batch is fixing wearing a smaller hat. */
  const APP = readStripped("App.tsx");
  const block = sliceBetween(
    APP,
    'if (before && "DeclareDividends" in msg',
    'if (after && "DeclareDividends" in msg',
  );

  it("takes its figures from the banked state, not from the drafts", () => {
    /* THE DIVERGENCE #941 INTRODUCED AND #963 REMOVED. The sentence summed `runnable`; the dividend read
       `last_route_revenue`. Two sources, one screen, and the player was shown a figure nobody would pay. */
    expect(block).toContain("printed_route_revenue");
    expect(block).not.toContain("runnable");
  });

  it("has no drafts sum left to diverge from", () => {
    /* #232 SAID A STATE THAT CANNOT REPORT SHOULD NOT BE GUESSED AT, and this is that rule pointing the other
       way: the guess was only available to one seat, so declining to make it is what keeps every seat equal. */
    expect(block).not.toContain("printedFromDrafts");
    expect(block).toContain("if (printedTurnTotal > 0) {");
  });

  it("stamps itself with Run Routes rather than reading the cursor", () => {
    /* The cursor has already moved by the time this fires -- proved by the reducer case above, and more so
       now: it fires on the dividend declaration, a step later still. */
    expect(block).toContain('operating_sub_phase: "Routes"');
    expect(block).toContain("runRoutesStamp");
  });

  it("drops the old label prefix", () => {
    /* `feedItemText` renders `label — detail`, which is where "Run Routes — " came from. The sentence is the
       label now, with no detail, so nothing is prefixed. */
    expect(block).toContain("turnRevenueSentence(");
    expect(block).not.toContain('"Run Routes"');
  });
});

describe("the sandbox receipt is gone (design note #965)", () => {
  const APP = readStripped("App.tsx");

  it("no longer stamps every successful action", () => {
    /* REPORTED as "unnecessary debug spam". Scanned on a comment-stripped copy (#490a) so #965's own note
       quoting the string cannot satisfy the search. */
    expect(APP).not.toContain("applied to local mock state");
  });

  it("keeps the refusal sentence, which is not boilerplate", () => {
    /* It fires only when the reducer DECLINED a message -- a fact about that entry, and the only thing
       distinguishing it from an action that worked. */
    expect(APP).toContain("the reducer declined this message and the board is unchanged");
  });
});

describe("the round header holds one row in every round (design note #964)", () => {
  const BAR = readStripped("panels/ContextualActionBar.tsx");

  it("puts the seat trail inside the progress row", () => {
    /* REPORTED: "The player turn order in the Auction and Stock rounds has incorrectly dropped to a second
       line." #946 moved the label INTO the row and left this sibling outside it. */
    const row = sliceBetween(BAR, "<div style={styles.orProgressRow}>", "</div>");
    expect(row).toContain("seatOrderTrail");
    expect(row).toContain("styles.actionBarRoundLabel");
  });

  it("numbers the Stock Round", () => {
    /* #517 made this argument for the Operating Round and the Stock Round was left out -- while
       `roundLabelFor` had been stamping "SR2" on log entries the whole time, so the feed and the bar
       disagreed about whether this round had an identity. */
    expect(BAR).toContain("`Stock Round ${orSequence.cycle}`");
  });

  it("still falls back to the bare title before the first poll", () => {
    /* `orSequence` is null until a state arrives, and "Stock Round undefined" is what a missing guard
       produces. */
    expect(BAR).toContain(': "Stock Round"');
  });
});

describe("the consolidated private revenue toast (design note #967)", () => {
  const payout = (privateName: string, amount: number, toPlayer: string | null) => ({
    privateId: 1,
    privateName,
    amount,
    toPlayer,
    toCompanyId: toPlayer ? null : 4,
  });

  it("sums only the viewer's own privates", () => {
    /* A toast saying "$95 was paid out" to somebody who received $5 of it is worse than silence. */
    const summary = summarisePrivateRevenueForPlayer(
      [payout("SV", 5, "me"), payout("C&SL", 10, "you"), payout("D&H", 30, "me")],
      "me",
    );
    expect(summary?.total).toBe(35);
    expect(summary?.count).toBe(2);
    expect(summary?.text).toBe("Your private companies paid you $35.");
  });

  it("excludes payouts to corporations", () => {
    /* #743: a corporation's treasury is not the player's money, and folding the two into one figure is the
       confusion that note exists to prevent. */
    const summary = summarisePrivateRevenueForPlayer(
      [payout("SV", 5, "me"), payout("D&H", 30, null)],
      "me",
    );
    expect(summary?.total).toBe(5);
  });

  it("lists the sources in the detail", () => {
    const summary = summarisePrivateRevenueForPlayer(
      [payout("SV", 5, "me"), payout("D&H", 30, "me")],
      "me",
    );
    expect(summary?.detail).toBe("SV $5 · D&H $30");
  });

  it("says nothing when the viewer received nothing", () => {
    /* A player holding no privates is the common case for most of a game, and an empty toast is a toast to
       dismiss for no reason. */
    expect(summarisePrivateRevenueForPlayer([payout("SV", 5, "you")], "me")).toBeNull();
    expect(summarisePrivateRevenueForPlayer([], "me")).toBeNull();
    expect(summarisePrivateRevenueForPlayer([payout("SV", 5, "me")], null)).toBeNull();
  });

  it("says nothing for a zero total", () => {
    /* Guarded on the TOTAL rather than the list, because several $0 privates are still $0. */
    expect(summarisePrivateRevenueForPlayer([payout("SV", 0, "me")], "me")).toBeNull();
  });

  it("fires once at the OR opening, beside the per-private log lines", () => {
    /* THE LOG KEEPS ITS RECORD. One line per private is what makes a payment findable later; the toast is
       the surface that consolidates. Both, not one. */
    const APP = readStripped("App.tsx");
    const opening = sliceBetween(APP, "const openingPayouts =", "sandboxStateRef.current = after;");
    expect(opening).toContain('logInfo("Private Revenue"');
    expect(opening).toContain("summarisePrivateRevenueForPlayer(openingPayouts");
    expect(opening).toContain("PRIVATE_REVENUE_TOAST_MS");
  });

  it("runs on a window of its own", () => {
    /* ==================================================================
        SUPERSEDED BY #983, IN THE OPPOSITE DIRECTION
       ==================================================================
       THIS ASSERTED `Math.round(STANDARD_TOAST_MS * 1.5)`. #967's ruling was "Increase the display duration
       of this specific toast to 1.5x the standard duration so it is easily readable", and deriving it from
       the standard was right for that instruction: the two could not drift apart.
       RULED SINCE: "The 'Your Private Companies' toast stays up far too long. Reduce its display duration to
       strictly `400ms`." A fixed figure, not a multiple -- so the derivation is what has to go, and keeping
       it would mean a change to the standard window silently dragging this back up.
       WHAT THE CASE IS STILL FOR is the property that survived both rulings and is the reason #967 built a
       constant at all: this toast has a window of its OWN, named once, and every other toast takes the
       default. `polishWave9` owns the figure; this owns the separation. */
    const TOAST = readStripped("components/ActionToast.tsx");
    expect(TOAST).toContain("export const STANDARD_TOAST_MS = 3700;");
    /* Design note #1016: the FIGURE moved again (2000 -> 3200) and this case is not about the figure. Pinned
       as a separation rather than a number, which is what the note above already says this case is for --
       `polishWave9` owns the figure, this owns the fact that there IS one of its own. Asserting the literal
       here was the half that kept failing for somebody else's reasons. */
    expect(TOAST).toContain("export const PRIVATE_REVENUE_TOAST_MS = ");
    expect(TOAST).not.toContain("STANDARD_TOAST_MS * 1.5");
    expect(TOAST).toContain("durationMs = STANDARD_TOAST_MS");
  });
});

describe("the era toast says one thing (design note #966)", () => {
  const APP = readStripped("App.tsx");

  it("uses the ruled sentence", () => {
    expect(APP).toContain(
      "`Corporations can now upgrade ${previous.toLowerCase()} tiles to ${eraNow.toLowerCase()}.`",
    );
  });

  it("drops the second line", () => {
    /* REPORTED: "too much text". The detail explained what an era is, to a table that has been laying tiles
       all game. */
    expect(APP).not.toContain("Every corporation may now lay");
  });

  it("keeps the era graphic #929 built", () => {
    /* The two hexes are the part that survives the trim -- they say the same thing faster than the sentence
       that was removed. */
    expect(APP).toContain("{ from: previous, to: eraNow }");
  });
});
