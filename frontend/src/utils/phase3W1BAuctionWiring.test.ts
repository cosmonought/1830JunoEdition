/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W1-B: THE SHELL'S WIRING FOR THE AUCTION DASHBOARD, AND THE CONTEST VIEW
// ==================================================================
//
// `AppShell` cannot be rendered (App audit F5), so what only its source can show is pinned here through the
// `sourceScan` readers (CRLF-safe, comment-stripped). The dashboard's behaviour is proved rendered in
// `components/phase3W1BAuctionDashboard.test.tsx`.

import { readShell, readStripped, sliceBetween } from "./sourceScan";
import { contestBarPassSentence, contestPassTooltip, contestProgressSentence, contestStanding } from "./auctionDashboardView";
import { PRIORITY_DEAL_TOOLTIP } from "../gameEngine/gameState";
import type { WaterfallMiniAuctionStatus, WaterfallStateResponse } from "../gameEngine/gameState";

const APP = readShell();

describe("AUD-02.04 (H-04): the dashboard mount carries the in-flight latch", () => {
  it("sessionReady is the bar's latch, not the bare connection flag", () => {
    const mount = sliceBetween(APP, "<WaterfallAuctionDashboard", "/>");
    expect(mount).toContain("sessionReady={controlsEnabled && !actionInFlight}");
    expect(mount).not.toMatch(/sessionReady=\{controlsEnabled\}/);
  });
});

describe("AUD-02.02 (K-15): the shell's own words for a contest pass", () => {
  it("the Undo label names a contest pass, not a drop-out", () => {
    expect(APP).toContain('WaterfallMiniAuctionPass: "the last contest pass"');
    expect(APP).not.toContain("the last drop-out");
  });

  it("the S1 const's contest arm is the contest sentence, still after the home token and the trade hold", () => {
    const pass = sliceBetween(APP, "const passDisabledReason =", "return (");
    expect(pass).toContain("contestBarPassSentence(waterfallState, viewerAddress)");
    expect(pass).not.toMatch(/drop out/i);
  });

  it("no drop-out or refund copy is left on the dashboard", () => {
    const DASH = readStripped("components/WaterfallAuctionDashboard.tsx");
    expect(DASH).not.toMatch(/refunded in full|>\s*Drop out|One bid per private company/);
    // No local copy of the auction's money rule: the dashboard asks the authority through the view module.
    expect(DASH).not.toContain("bidRejectionReason(");
    expect(DASH).not.toContain("repeatBidReason");
    expect(DASH).toContain("dashboardBidRefusal(");
    expect(DASH).toContain("dashboardBuyRefusal(");
    expect(DASH).toContain("dashboardContestRaiseRefusal(");
    expect(DASH).toContain("dashboardContestPassRefusal(");
    const VIEW = readStripped("utils/auctionDashboardView.ts");
    expect(VIEW).toContain("auctionRefusal(state, waterfall, msg)");
  });
});

const mini = (over: Partial<WaterfallMiniAuctionStatus> = {}): WaterfallMiniAuctionStatus => ({
  private_id: 3,
  bidders: ["b", "c", "a"],
  current_turn: "c",
  high_bid: "85",
  high_bidder: "a",
  passes_since_raise: 1,
  ...over,
});

describe("the contest, read from the atom's counters (§1.2.2, design note #1581)", () => {
  it("two bidders: one pass ends it", () => {
    const two = mini({ bidders: ["b", "a"], current_turn: "b", passes_since_raise: undefined });
    expect(contestStanding(two)).toEqual({ passes: 0, passesToEnd: 1, remaining: 1, passedSinceRaise: [] });
    expect(contestProgressSentence(two, "A")).toBe("0 of 1 pass since the last raise — one more pass and A wins at $85.");
    expect(contestPassTooltip(two, 75, "A")).toBe(
      "Pass — Your $75 bid stands. This pass ends the contest: A wins at $85, and your bid is released.",
    );
  });

  it("three bidders, one pass in: the passer is the non-leader just behind the cursor", () => {
    expect(contestStanding(mini())).toEqual({ passes: 1, passesToEnd: 2, remaining: 1, passedSinceRaise: ["b"] });
  });

  it("four bidders, two passes in: both passers, skipping the leader", () => {
    // c raised, so the cursor went to a (the bidder after the raiser); a passed, then d; the cursor is back on b.
    const four = mini({ bidders: ["b", "c", "a", "d"], current_turn: "b", high_bidder: "c", passes_since_raise: 2 });
    expect(contestStanding(four).passedSinceRaise).toEqual(["d", "a"]);
    expect(contestStanding(four).remaining).toBe(1);
  });

  it("the bar's contest sentence: a bidder is told where to act and that a pass keeps the bid; others that the auction waits", () => {
    const waterfall = {
      privates: [{ private_id: 3, name: "Delaware & Hudson", face_value: "70", is_lowest_offered: false, bids: [] }],
      mini_auction: mini(),
    } as unknown as WaterfallStateResponse;
    expect(contestBarPassSentence(waterfall, "b")).toContain("A contest pass keeps your bid standing");
    expect(contestBarPassSentence(waterfall, "z")).toBe(
      "Delaware & Hudson is being contested — the auction goes on once its bidders have settled it.",
    );
    expect(contestBarPassSentence({ ...waterfall, mini_auction: null } as WaterfallStateResponse, "b")).toBeNull();
  });
});

describe("AUD-11.01 (K-16): the Priority Deal tooltip is true in every round", () => {
  it("it states the rule rather than claiming the marked seat opens the next Stock Round", () => {
    expect(PRIORITY_DEAL_TOOLTIP).not.toContain("Starts the next Stock Round");
    expect(PRIORITY_DEAL_TOOLTIP).toContain("who held the card when this round began");
    expect(PRIORITY_DEAL_TOOLTIP).toContain("the last one to buy or sell");
    expect(PRIORITY_DEAL_TOOLTIP).toContain("the last one to buy a private outright");
  });

  it("the player cards and the ledger both show that one sentence", () => {
    expect(readStripped("components/PlayerCards.tsx")).toContain("title={PRIORITY_DEAL_TOOLTIP}");
    expect(readStripped("components/PlayerCards.tsx")).not.toContain("Starts the next Stock Round");
    expect(readStripped("components/FinancialLedger.tsx")).toContain("title={PRIORITY_DEAL_TOOLTIP}");
  });
});
