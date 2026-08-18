// frontend/src/utils/miniAuctionTurn.test.ts
//
// WHO MAY ACT WHILE A CONTEST IS RUNNING.
//
// ==================================================================
//  DESIGN NOTE 544 (harness): TWO POINTERS, ONE QUESTION
// ==================================================================
//
// REPORTED from a live playthrough: a player bought a private, which opened
// a mini-auction they were the lowest bidder in. The mini-auction card named
// them. The Turn Order named them. The Auction Round ACTION PANEL named
// somebody else -- and only that somebody else could do anything.
//
// Neither surface had a bug in it. They read different pointers, on
// different atoms, and each pointer was correct about a different question:
// `active_player_index` is right about the WATERFALL, and stays right about
// it precisely because the reducer freezes it for the duration of a contest
// (design note #338). Frozen is exactly what makes it the wrong answer to
// "who may act right now".
//
// So these tests are about AGREEMENT rather than about either function. The
// gate that decides whether a dispatch is allowed and the label that tells
// the player whose turn it is have to resolve from the same place, and the
// only way to keep that true is to pin it here -- the failure mode is two
// plausible screens, not an exception.

import {
  actingAddress,
  isSidelinedByMiniAuction,
  type GameStateResponse,
  type WaterfallPrivateStatus,
  type WaterfallStateResponse,
} from "./gameState";
import { applySandboxWaterfallAction } from "./sandboxSession";

const ADA = "player-ada";
const BEN = "player-ben";
const CAI = "player-cai";
const DOT = "player-dot";
const SEATS = [ADA, BEN, CAI, DOT];

function gameState(overrides: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: [...SEATS],
    active_player_index: 0,
    current_round_type: "WaterfallAuction",
    active_operating_order: [],
    active_corporation_index: 0,
    public_companies: [],
    ...overrides,
  } as unknown as GameStateResponse;
}

function priv(
  id: number,
  bids: Array<[string, number]>,
  isLowest = true,
): WaterfallPrivateStatus {
  return {
    private_id: id,
    name: `P${id}`,
    face_value: "100",
    is_lowest_offered: isLowest,
    bids: bids.map(([bidder, amount]) => ({ bidder, bid_amount: String(amount) })),
  };
}

function waterfall(
  overrides: Partial<WaterfallStateResponse> = {},
): WaterfallStateResponse {
  return {
    game_id: 1,
    waterfall_auction_active: true,
    current_turn: ADA,
    consecutive_waterfall_passes: 0,
    mini_auction: null,
    privates: [],
    ...overrides,
  } as unknown as WaterfallStateResponse;
}

/* ------------------------------------------------------------------ */
/* actingAddress -- the pointer every gate and label now shares        */
/* ------------------------------------------------------------------ */

describe("actingAddress", () => {
  it("follows the seat pointer when no contest is running", () => {
    expect(actingAddress(gameState({ active_player_index: 2 }), waterfall())).toBe(CAI);
  });

  it("prefers the contest cursor over the frozen seat pointer", () => {
    /* THE REPORTED BUG, in one assertion. Both fields are populated and they
       disagree; the seat pointer is stale by construction. */
    const state = gameState({ active_player_index: 0 });
    const wf = waterfall({
      mini_auction: {
        private_id: 3,
        bidders: [DOT, BEN],
        current_turn: DOT,
        high_bid: "150",
        high_bidder: BEN,
      },
    });
    expect(actingAddress(state, wf)).toBe(DOT);
    expect(actingAddress(state, wf)).not.toBe(state.player_addresses[0]);
  });

  it("ignores a contest left on a document outside the auction round", () => {
    /* A stale `mini_auction` on a Stock Round document must not capture the
       turn. The round type is the authority for WHICH pointer applies, and
       reading the contest unconditionally would let a leftover field hold
       the whole game hostage. */
    const wf = waterfall({
      mini_auction: {
        private_id: 3,
        bidders: [DOT],
        current_turn: DOT,
        high_bid: "150",
        high_bidder: DOT,
      },
    });
    expect(actingAddress(gameState({ current_round_type: "StockRound" }), wf)).toBe(ADA);
  });

  it("survives a missing waterfall document", () => {
    // Online, before `GetWaterfallState` first resolves.
    expect(actingAddress(gameState({ active_player_index: 1 }), null)).toBe(BEN);
  });

  it("returns null rather than a seat when the roster is empty", () => {
    /* Design note #538: a room before `SetupGame` lands. `null` must not
       degrade to `""`, because `"" === viewerAddress` would be false for a
       real player and true for a spectator with no address. */
    expect(actingAddress(gameState({ player_addresses: [] }), waterfall())).toBeNull();
  });
});

describe("isSidelinedByMiniAuction", () => {
  const wf = waterfall({
    mini_auction: {
      private_id: 3,
      bidders: [DOT, BEN],
      current_turn: DOT,
      high_bid: "150",
      high_bidder: BEN,
    },
  });

  it("sidelines a seat who is not bidding", () => {
    expect(isSidelinedByMiniAuction(gameState(), wf, ADA)).toBe(true);
    expect(isSidelinedByMiniAuction(gameState(), wf, CAI)).toBe(true);
  });

  it("does not sideline a contestant, on turn or not", () => {
    expect(isSidelinedByMiniAuction(gameState(), wf, DOT)).toBe(false);
    expect(isSidelinedByMiniAuction(gameState(), wf, BEN)).toBe(false);
  });

  it("sidelines nobody when no contest is running", () => {
    for (const seat of SEATS) {
      expect(isSidelinedByMiniAuction(gameState(), waterfall(), seat)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The contest queue -- eligible players only, lowest bid first        */
/* ------------------------------------------------------------------ */

/** Opens a contest the way a real game does: a bid on the cheapest private
 *  promotes it, and the promoted private already carries two bids. */
function openContest(bids: Array<[string, number]>): WaterfallStateResponse {
  const result = applySandboxWaterfallAction(
    waterfall({
      current_turn: ADA,
      privates: [priv(1, [], true), priv(2, bids, false)],
    }),
    { WaterfallBuyLowest: {} } as never,
    SEATS,
  );
  return result.waterfall;
}

describe("mini-auction queue", () => {
  it("orders the queue by ascending bid, not by seat", () => {
    /* DOT sits last and bid least; ADA sits first and bid most. Seat order
       and bid order are deliberately opposed here so a queue that happened
       to be built from `players` cannot pass. */
    const wf = openContest([
      [ADA, 200],
      [BEN, 150],
      [DOT, 120],
    ]);
    expect(wf.mini_auction?.bidders).toEqual([DOT, BEN, ADA]);
  });

  it("admits only players who actually bid", () => {
    const wf = openContest([
      [BEN, 150],
      [DOT, 120],
    ]);
    expect(wf.mini_auction?.bidders).not.toContain(ADA);
    expect(wf.mini_auction?.bidders).not.toContain(CAI);
  });

  it("opens on the lowest bidder", () => {
    const wf = openContest([
      [ADA, 200],
      [BEN, 150],
      [DOT, 120],
    ]);
    expect(wf.mini_auction?.current_turn).toBe(DOT);
  });

  it("never opens on the leader, even when the leader bid least", () => {
    /* Cannot happen from `openMiniAuction`'s own inputs -- the leader is the
       highest bid by definition -- but the skip is the rule
       (`skip_leader_turns`) and a two-player contest is where it bites: with
       the leader removed there is exactly one other name in the queue. */
    const wf = openContest([
      [BEN, 150],
      [DOT, 120],
    ]);
    expect(wf.mini_auction?.high_bidder).toBe(BEN);
    expect(wf.mini_auction?.current_turn).toBe(DOT);
  });

  it("leaves the main rotation frozen while the contest runs", () => {
    /* Design note #338, re-pinned from the turn-gate side: the waterfall
       cursor is not a live pointer during a contest, and design note #544's
       whole argument rests on that staying true. */
    const wf = openContest([
      [BEN, 150],
      [DOT, 120],
    ]);
    const after = applySandboxWaterfallAction(
      wf,
      { WaterfallMiniAuctionRaise: { bid_amount: "300" } } as never,
      SEATS,
    );
    expect(after.waterfall.current_turn).toBe(wf.current_turn);
  });
});

describe("mini-auction rotation", () => {
  const threeWay = () =>
    openContest([
      [ADA, 200],
      [BEN, 150],
      [DOT, 120],
    ]); // queue [DOT, BEN, ADA], cursor DOT, leader ADA

  it("moves down the queue on a raise, skipping the new leader", () => {
    const wf = threeWay();
    const after = applySandboxWaterfallAction(
      wf,
      { WaterfallMiniAuctionRaise: { bid_amount: "260" } } as never,
      SEATS,
    ).waterfall;
    // DOT raised, so DOT leads; the next in queue is BEN.
    expect(after.mini_auction?.high_bidder).toBe(DOT);
    expect(after.mini_auction?.current_turn).toBe(BEN);
  });

  it("does not hand the turn back to the player who just raised", () => {
    let wf = threeWay();
    for (const amount of ["260", "320", "400"]) {
      wf = applySandboxWaterfallAction(
        wf,
        { WaterfallMiniAuctionRaise: { bid_amount: amount } } as never,
        SEATS,
      ).waterfall;
      expect(wf.mini_auction?.current_turn).not.toBe(wf.mini_auction?.high_bidder);
    }
  });

  it("passes to the lowest bidder still in after a drop-out", () => {
    /* The `nextSeat` accident this replaced: it was handed the SHRUNKEN list
       plus the departing player, so `indexOf` returned -1 and the cursor
       jumped to index 0 every time. That agreed with the rule often enough
       to look correct. Asserted as the intent now. */
    const wf = threeWay(); // queue [DOT, BEN, ADA], cursor DOT
    const after = applySandboxWaterfallAction(
      wf,
      { WaterfallMiniAuctionPass: {} } as never,
      SEATS,
    ).waterfall;
    expect(after.mini_auction?.bidders).toEqual([BEN, ADA]);
    expect(after.mini_auction?.current_turn).toBe(BEN);
  });

  it("only ever points at somebody still in the contest", () => {
    /* The property that matters more than any single hop: a cursor on a
       departed or never-present player is a contest nobody can advance. */
    let wf = threeWay();
    wf = applySandboxWaterfallAction(
      wf,
      { WaterfallMiniAuctionRaise: { bid_amount: "260" } } as never,
      SEATS,
    ).waterfall;
    wf = applySandboxWaterfallAction(
      wf,
      { WaterfallMiniAuctionPass: {} } as never,
      SEATS,
    ).waterfall;
    const mini = wf.mini_auction;
    if (mini) expect(mini.bidders).toContain(mini.current_turn);
  });

  it("agrees with the action bar at every step", () => {
    /* THE REGRESSION, end to end. Whatever the contest does, the pointer the
       dispatch gate reads must name a player who is in it -- which is the
       one thing that was false in the reported game. */
    let wf = threeWay();
    const state = gameState({ active_player_index: 0 });
    const steps = [
      { WaterfallMiniAuctionRaise: { bid_amount: "260" } },
      { WaterfallMiniAuctionPass: {} },
    ];
    for (const step of steps) {
      wf = applySandboxWaterfallAction(wf, step as never, SEATS).waterfall;
      if (!wf.mini_auction) break;
      const acting = actingAddress(state, wf);
      expect(acting).toBe(wf.mini_auction.current_turn);
      expect(isSidelinedByMiniAuction(state, wf, acting as string)).toBe(false);
    }
  });
});
