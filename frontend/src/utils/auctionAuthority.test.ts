/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1580 (harness): THE PRIVATE AUCTION, JUDGED BY THE AUTHORITY (Batch 7.3)
// ==================================================================
//
// Every case builds a board with a live auction, sends a REAL message through `applySandboxAction`, and asks
// `turnRefusal` the same question -- so the two locks are pinned as agreeing rather than assumed to.
// Refusals are proven by DIGEST, never by object identity (S7-17 / S10-1).
//
// EVERY REFUSAL HAS AN ACCEPTANCE BESIDE IT, one dollar or one action apart, so no case can be satisfied by
// an engine that refuses everything.
//
// THE CONTESTS HERE HAVE THREE BIDDERS ON PURPOSE. Every mini-auction in the stored corpus is a two-bidder
// contest, where `bidders.length - 1` is 1 and one pass resolves the contest under the OLD elimination rule
// and the NEW consecutive-pass rule alike -- so the corpus cannot expose the bug and cannot defend the fix.
// Three bidders is the smallest contest in which passing and being eliminated are different games.
//
// Rulebook §1.2 (pass / buy the cheapest / bid on one that is NOT the cheapest), §1.2.1 (the $5 minimum, the
// escrow: "place the bid money in front of him ... and not use it for any other purpose"), §1.2.2 (the
// contest: raise by $5, "may pass and still bid later if the auction does not end", ends when "all of the
// bidders pass consecutively"), §1.2.3 (the all-pass: the SV marks down while unsold; private income once it
// has sold). Owner rulings D-16 (Q3), D-21 (Q8), D-23 (Q11).

export {};

const { applySandboxAction } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { stateDigest, fieldDigests } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { moneyConservationBreach, moneyTotal } =
  require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { SV_PRIVATE_ID } = require("../gameEngine/gameConstants") as typeof import("../gameEngine/gameConstants");
const { JK_PRIVATE_ID } = require("../gameEngine/levelPlayingField") as typeof import("../gameEngine/levelPlayingField");
const {
  auctionActor,
  auctionRefusal,
  legacyBidRefusal,
  lowestOffered,
  miniRaiseRefusal,
  standingBidOn,
  waterfallBidRefusal,
  waterfallBuyRefusal,
} = require("../gameEngine/auctionAuthority") as typeof import("../gameEngine/auctionAuthority");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type WaterfallStateResponse = import("../gameEngine/gameState").WaterfallStateResponse;
type WaterfallPrivateStatus = import("../gameEngine/gameState").WaterfallPrivateStatus;

const A = "p-a";
const B = "p-b";
const C = "p-c";
const SEATS = [A, B, C];

/* The printed roster's first four, in ascending face value -- the order `waterfallForRoster` builds and the
   order `is_lowest_offered` is derived from. */
const ROSTER: Array<[number, string, number, number]> = [
  [SV_PRIVATE_ID, "Schuylkill Valley", 20, 5],
  [2, "Champlain & St.Lawrence", 40, 10],
  [3, "Delaware & Hudson", 70, 15],
  [4, "Mohawk & Hudson", 110, 20],
];

function priv(
  id: number,
  faceValue: number,
  bids: Array<[string, number]> = [],
  isLowest = false,
): WaterfallPrivateStatus {
  return {
    private_id: id,
    name: ROSTER.find(([entry]) => entry === id)?.[1] ?? `Private ${id}`,
    face_value: String(faceValue),
    is_lowest_offered: isLowest,
    bids: bids.map(([bidder, amount]) => ({ bidder, bid_amount: String(amount) })),
  };
}

interface BoardOptions {
  cash?: Record<string, number>;
  privates?: WaterfallPrivateStatus[];
  currentTurn?: string;
  passes?: number;
  mini?: WaterfallStateResponse["mini_auction"];
  owned?: Array<[number, string]>;
  pinned?: boolean;
}

function board(options: BoardOptions = {}): GameStateResponse {
  const privates =
    options.privates ??
    ROSTER.map(([id, , face], index) => priv(id, face, [], index === 0));
  const owned = new Map(options.owned ?? []);
  return {
    current_round_type: "WaterfallAuction",
    macro_round_number: 1,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [],
    active_corporation_index: 0,
    ...(options.pinned === false ? {} : { rules_engine_version: 4 }),
    variants: { rules: 1 },
    player_addresses: [...SEATS],
    player_cash: SEATS.map((player) => ({ player, cash_vgp: String(options.cash?.[player] ?? 600) })),
    virtual_bank_vgp: "9000",
    public_companies: [],
    private_companies: ROSTER.map(([id, name, cost, revenue]) => ({
      private_id: id,
      name,
      cost: String(cost),
      revenue_per_or: String(revenue),
      owner: owned.get(id) ?? null,
      owner_protocol_id: null,
      closed: false,
    })),
    waterfall: {
      game_id: 1,
      waterfall_auction_active: true,
      privates,
      current_turn: options.currentTurn ?? A,
      mini_auction: options.mini ?? null,
      consecutive_waterfall_passes: options.passes ?? 0,
    },
  } as unknown as GameStateResponse;
}

const apply = (state: GameStateResponse, msg: unknown, actor?: string | null) =>
  applySandboxAction(state, msg as never, { actor: actor ?? auctionActor(state.waterfall ?? null) } as never);

const refused = (before: GameStateResponse, after: GameStateResponse) =>
  stateDigest(before) === stateDigest(after);

const ingress = (state: GameStateResponse, actor: string, msg: unknown) =>
  turnRefusal({ state, waterfall: state.waterfall ?? null, actor, msg: msg as never });

const cashOf = (state: GameStateResponse, player: string) =>
  Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);
const bankOf = (state: GameStateResponse) => Number(state.virtual_bank_vgp);
const ownerOf = (state: GameStateResponse, id: number) =>
  state.private_companies.find((entry) => entry.private_id === id)?.owner ?? null;
const offered = (state: GameStateResponse, id: number) =>
  state.waterfall?.privates.find((entry) => entry.private_id === id) ?? null;
const contest = (state: GameStateResponse) => state.waterfall?.mini_auction ?? null;
const wf = (state: GameStateResponse) => state.waterfall ?? null;
/** The same board with the auction's cursor back on `player` -- a bid advances it (`nextSeat`), and several
 *  cases below are about ONE player's escrow across two actions. */
const withTurn = (state: GameStateResponse, player: string): GameStateResponse =>
  ({ ...state, waterfall: { ...state.waterfall!, current_turn: player } }) as GameStateResponse;

const BUY = { WaterfallBuyLowest: { game_id: 0 } };
const PASS = { WaterfallPass: { game_id: 0 } };
const BID = (privateId: number, amount: number | string) => ({
  WaterfallBidHigher: { game_id: 0, private_id: privateId, bid_amount: String(amount) },
});
const RAISE = (amount: number | string) => ({
  WaterfallMiniAuctionRaise: { game_id: 0, bid_amount: String(amount) },
});
const MINI_PASS = { WaterfallMiniAuctionPass: { game_id: 0 } };
const LEGACY = (privateId: number, amount: number) => ({
  BidOnPrivate: { game_id: 0, private_id: privateId, bid_amount: String(amount) },
});

/* ==================================================================================================== */

describe("1. the cheapest private is bought, never bid on (A1 / M2, rulebook §1.2)", () => {
  it("refuses a bid on the lowest-offered private, at both locks", () => {
    const before = board();
    expect(lowestOffered(wf(before))!.private_id).toBe(SV_PRIVATE_ID);
    const after = apply(before, BID(SV_PRIVATE_ID, 25));
    expect(refused(before, after)).toBe(true);
    expect(ingress(before, A, BID(SV_PRIVATE_ID, 25))).toContain("cheapest private company");
    // ...and it opened no contest on the one card every player can always reach (the M2 symptom).
    expect(contest(after)).toBeNull();
    expect(offered(after, SV_PRIVATE_ID)!.bids).toEqual([]);
  });

  it("allows a bid on any private that is NOT the cheapest (the control)", () => {
    const before = board();
    const after = apply(before, BID(3, 75));
    expect(refused(before, after)).toBe(false);
    expect(offered(after, 3)!.bids).toEqual([{ bidder: A, bid_amount: "75" }]);
    expect(ingress(before, A, BID(3, 75))).toBeNull();
    // A bid moves no money: it is escrow, derived from the bid list (auctionEscrow #1).
    expect(cashOf(after, A)).toBe(600);
    expect(bankOf(after)).toBe(9000);
    expect(moneyConservationBreach(before, after)).toBeNull();
  });
});

describe("2. a bid is escrowed money that has to exist (A3 / S7-4, rulebook §1.2.1)", () => {
  it("refuses a bid the player's cash cannot cover", () => {
    const before = board({ cash: { [A]: 1160 } });
    expect(refused(before, apply(before, BID(3, 9999)))).toBe(true);
    expect(ingress(before, A, BID(3, 9999))).toContain("Only $1160 available");
    expect(refused(before, apply(before, BID(3, 1161)))).toBe(true);
    // ...and exactly what he holds is legal (the boundary).
    expect(refused(before, apply(before, BID(3, 1160)))).toBe(false);
  });

  it("refuses spending the same dollar on two private companies", () => {
    /* The probe's finding: $600 standing on one private and $600 standing on another, from $600 of cash. */
    const before = board({
      cash: { [A]: 600 },
      privates: [
        priv(SV_PRIVATE_ID, 20, [], true),
        priv(2, 40),
        priv(3, 70, [[A, 600]]),
        priv(4, 110),
      ],
    });
    expect(standingBidOn(wf(before), 3, A)).toBe(600);
    expect(refused(before, apply(before, BID(4, 115)))).toBe(true);
    expect(ingress(before, A, BID(4, 115))).toContain("escrowed");
  });

  it("keeps several standing bids legal while the TOTAL is affordable (the control)", () => {
    const before = board({
      cash: { [A]: 600 },
      privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[A, 300]]), priv(4, 110)],
    });
    const after = apply(before, BID(4, 300));
    expect(refused(before, after)).toBe(false);
    expect(standingBidOn(wf(after), 3, A)).toBe(300);
    expect(standingBidOn(wf(after), 4, A)).toBe(300);
    /* One more dollar of commitment is one too many -- asked of A, whose turn the bid moved on (`nextSeat`),
       because this case is about ONE player's escrow rather than about the rotation. */
    const aAgain = withTurn(after, A);
    expect(refused(aAgain, apply(aAgain, BID(2, 45)))).toBe(true);
    expect(ingress(aAgain, A, BID(2, 45))).toContain("escrowed");
  });

  it("charges a raise of one's OWN standing bid only the difference (D-16 / Q3)", () => {
    /* The owner's ruling: raising one's own bid is legal. It must also be AFFORDABLE the right way -- the
       money already on the card is this player's, so a leader defending a $300 bid with $400 of cash is
       raising by $100, not spending $700. */
    const before = board({
      cash: { [A]: 400 },
      privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[A, 300]]), priv(4, 110)],
    });
    const raised = apply(before, BID(3, 400));
    expect(refused(before, raised)).toBe(false);
    expect(offered(raised, 3)!.bids).toEqual([{ bidder: A, bid_amount: "400" }]); // replaced, not stacked
    // ...and $401 is a dollar more than he has.
    expect(refused(before, apply(before, BID(3, 401)))).toBe(true);
    expect(ingress(before, A, BID(3, 401))).toContain("Only $100 available");
  });

  it("refuses a sub-minimum and a non-whole bid", () => {
    const before = board({ privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[B, 80]]), priv(4, 110)] });
    expect(refused(before, apply(before, BID(3, 84)))).toBe(true); // 80 + 5 is the floor
    expect(ingress(before, A, BID(3, 84))).toContain("minimum bid here is $85");
    expect(refused(before, apply(before, BID(3, 85)))).toBe(false); // the control
    expect(ingress(before, A, BID(3, "85.5"))).toContain("whole number of dollars");
  });

  it("refuses a sub-minimum bid ATOMICALLY -- the seat does not advance either (JUNO-3XD 6)", () => {
    /* ==================================================================
        THE PARTIAL APPLICATION THIS BATCH CLOSES, AND THE CORPUS ENTRY THAT SHOWS IT
       ==================================================================
       `export/JUNO-3XD` entry 6 is `WaterfallBidHigher {private_id: 5, bid_amount: "165"}` sent by a player
       who ALREADY had $165 standing on private 5 -- so it is below `minimumBidFor` ($170), and #1184 has
       refused it since Batch 4. But #1184's refusal lives inside `applySandboxWaterfallAction`, and the SEAT
       is advanced by `applyOneAction` one layer above it: the bid was declined and the turn passed anyway.

       BATCH 7.3 REFUSES THE WHOLE MESSAGE, above `applyAuctionStep` (#1580), so neither atom moves. This
       case is that fact, on the same shape of board: a re-bid at one's own standing amount.

       IT IS ALSO WHY 3XD SHOWS A TRANSIENT CORPUS DIFFERENCE. The 7.2 board advanced `active_player_index`
       here and the 7.3 board does not; the log's later entries re-converge, and the two replays end
       identically. That difference is the REMOVAL of the old partial application -- nothing about the bid
       itself changed, and nothing was re-baselined for it. */
    const before = board({
      currentTurn: A,
      privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[A, 165]]), priv(4, 110)],
    });
    const seatBefore = before.active_player_index;
    const cursorBefore = before.waterfall!.current_turn;

    const after = apply(before, BID(3, 165)); // the standing bid's own amount: below 165 + 5
    expect(refused(before, after)).toBe(true);
    expect(after).toEqual(before); // literal whole-state equality
    // The two pointers, named one at a time, because they are two atoms and the old fault moved one of them.
    expect(after.active_player_index).toBe(seatBefore);
    expect(after.waterfall!.current_turn).toBe(cursorBefore);
    expect(offered(after, 3)!.bids).toEqual([{ bidder: A, bid_amount: "165" }]);
    expect(ingress(before, A, BID(3, 165))).toContain("minimum bid here is $170");

    /* THE CONTROL, and it is the one that makes the assertion mean something: a bid that IS legal advances
       both pointers, so "neither moved" above is a fact about the refusal and not about the fixture. */
    const legal = apply(before, BID(3, 170));
    expect(refused(before, legal)).toBe(false);
    expect(legal.active_player_index).not.toBe(seatBefore);
    expect(legal.waterfall!.current_turn).not.toBe(cursorBefore);
  });
});

describe("3. a face-value purchase is escrow-aware too (A3)", () => {
  it("refuses a buy the player cannot afford after standing bids", () => {
    const before = board({
      cash: { [A]: 100 },
      privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[A, 90]]), priv(4, 110)],
    });
    expect(refused(before, apply(before, BUY))).toBe(true);
    expect(ingress(before, A, BUY)).toContain("committed to standing bids");
    expect(ownerOf(apply(before, BUY), SV_PRIVATE_ID)).toBeNull();
  });

  it("allows the buy when the free cash covers it, and pays the bank exactly once", () => {
    const before = board({
      cash: { [A]: 100 },
      privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[A, 80]]), priv(4, 110)],
    });
    const after = apply(before, BUY);
    expect(refused(before, after)).toBe(false);
    expect(ownerOf(after, SV_PRIVATE_ID)).toBe(A);
    expect(cashOf(after, A)).toBe(80);
    expect(bankOf(after)).toBe(9020);
    expect(moneyConservationBreach(before, after)).toBeNull();
    expect(ingress(before, A, BUY)).toBeNull();
  });
});

/* ==================================================================================================== */

describe("4. the contest: three bidders, and a pass is not a drop-out (M1 / S7-3, §1.2.2)", () => {
  /* A $70 private contested by all three: A $80, B $90, C $100. `byAscendingBid` queues [A, B, C]; the high
     bidder is C, and the cursor opens on A -- the lowest, skipping the leader (#544). */
  const contested = (over: Partial<BoardOptions> = {}) =>
    board({
      cash: { [A]: 600, [B]: 600, [C]: 600 },
      privates: [
        priv(SV_PRIVATE_ID, 20, [], true),
        priv(2, 40),
        priv(3, 70, [[A, 80], [B, 90], [C, 100]]),
        priv(4, 110),
      ],
      mini: {
        private_id: 3,
        bidders: [A, B, C],
        current_turn: A,
        high_bid: "100",
        high_bidder: C,
      },
      ...over,
    });

  it("SEQUENCE A: a passed bidder is still in, and raises later", () => {
    /* The frozen design's first example. The cursor is the authority on WHOSE action a message is (#1232),
       so the sequence below is A raises / B passes / C raises / A passes / B raises -- B's pass in step two
       is the whole point, and under the old elimination rule B would not exist by step five. */
    let state = contested();

    state = apply(state, RAISE(120)); // A raises
    expect(contest(state)!.high_bidder).toBe(A);
    expect(contest(state)!.passes_since_raise).toBe(0);
    expect(contest(state)!.current_turn).toBe(B);

    state = apply(state, MINI_PASS); // B passes -- and stays
    expect(contest(state)!.bidders).toEqual([A, B, C]);
    expect(standingBidOn(wf(state), 3, B)).toBe(90);
    expect(contest(state)!.passes_since_raise).toBe(1);
    expect(contest(state)!.current_turn).toBe(C);

    state = apply(state, RAISE(140)); // C raises -- the count restarts
    expect(contest(state)!.high_bidder).toBe(C);
    expect(contest(state)!.passes_since_raise).toBe(0);
    expect(contest(state)!.current_turn).toBe(A);

    state = apply(state, MINI_PASS); // A passes
    expect(contest(state)!.current_turn).toBe(B);
    expect(contest(state)!.passes_since_raise).toBe(1);

    /* B RAISES. The assertion this whole case exists for: B passed at step two and is still able to bid. */
    const before = state;
    state = apply(state, RAISE(160));
    expect(refused(before, state)).toBe(false);
    expect(contest(state)!.high_bidder).toBe(B);
    expect(contest(state)!.high_bid).toBe("160");
    expect(contest(state)!.passes_since_raise).toBe(0);
    expect(standingBidOn(wf(state), 3, B)).toBe(160);
    // Nobody has paid anything yet: a bid is escrow, not a purchase.
    expect(cashOf(state, B)).toBe(600);
    expect(bankOf(state)).toBe(9000);
  });

  it("SEQUENCE B: a raise then two consecutive passes hands it to the raiser", () => {
    let state = contested();
    state = apply(state, RAISE(120)); // A raises; cursor B
    state = apply(state, MINI_PASS); // B passes; 1 of 2; cursor C
    expect(contest(state)!.passes_since_raise).toBe(1);
    expect(state.waterfall?.mini_auction).not.toBeNull();

    const before = state;
    state = apply(state, MINI_PASS); // C passes; 2 of 2 -- resolved
    expect(contest(state)).toBeNull();
    expect(ownerOf(state, 3)).toBe(A);
    expect(cashOf(state, A)).toBe(600 - 120);
    expect(cashOf(state, B)).toBe(600); // losers are not charged
    expect(cashOf(state, C)).toBe(600);
    expect(bankOf(state)).toBe(9000 + 120); // paid to the bank exactly once
    expect(moneyConservationBreach(before, state)).toBeNull();
    // The losers' escrow is released by the private leaving the auction, not by a refund.
    expect(offered(state, 3)).toBeNull();
  });

  it("does not resolve on the first pass of a three-bidder contest (the old bug, stated)", () => {
    /* Under elimination, one pass left two bidders and the second pass ended it -- so a three-way contest
       was decided by two players and the third never answered the standing bid. */
    const state = apply(contested(), MINI_PASS);
    expect(contest(state)).not.toBeNull();
    expect(contest(state)!.bidders).toEqual([A, B, C]);
    expect(ownerOf(state, 3)).toBeNull();
  });

  it("resolves a TWO-bidder contest on one pass, exactly as it always did", () => {
    /* Every contest in the stored corpus is this shape: `bidders.length - 1` is 1, so one pass ends it under
       both the old rule and the new one. This is why the corpus digests do not move. */
    const two = board({
      privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[A, 80], [B, 90]]), priv(4, 110)],
      mini: { private_id: 3, bidders: [A, B], current_turn: A, high_bid: "90", high_bidder: B },
    });
    const after = apply(two, MINI_PASS);
    expect(contest(after)).toBeNull();
    expect(ownerOf(after, 3)).toBe(B);
    expect(cashOf(after, B)).toBe(600 - 90);
    expect(bankOf(after)).toBe(9000 + 90);
  });

  it("never asks the high bidder to outbid himself", () => {
    let state = contested();
    for (const amount of [120, 140, 160]) {
      state = apply(state, RAISE(amount));
      expect(contest(state)!.current_turn).not.toBe(contest(state)!.high_bidder);
    }
  });
});

describe("5. the contest's raises (§1.2.2's $5 step, escrow-aware)", () => {
  const contested = (cash: Record<string, number> = {}) =>
    board({
      cash: { [A]: 600, [B]: 600, [C]: 600, ...cash },
      privates: [
        priv(SV_PRIVATE_ID, 20, [], true),
        priv(2, 40),
        priv(3, 70, [[A, 80], [B, 90], [C, 100]]),
        priv(4, 110),
      ],
      mini: { private_id: 3, bidders: [A, B, C], current_turn: A, high_bid: "100", high_bidder: C },
    });

  it("refuses +$1 and accepts exactly +$5", () => {
    const before = contested();
    expect(refused(before, apply(before, RAISE(101)))).toBe(true);
    expect(ingress(before, A, RAISE(101))).toContain("$105 is the least");
    const ok = apply(before, RAISE(105));
    expect(refused(before, ok)).toBe(false);
    expect(contest(ok)!.high_bid).toBe("105");
    expect(contest(ok)!.high_bidder).toBe(A);
  });

  it("refuses a raise beyond what the player's cash can support", () => {
    /* A holds $200 and already has $80 on this card; his ceiling in this contest is $200, not $280. */
    const before = contested({ [A]: 200 });
    expect(refused(before, apply(before, RAISE(205)))).toBe(true);
    expect(ingress(before, A, RAISE(205))).toContain("not enough");
    expect(refused(before, apply(before, RAISE(200)))).toBe(false); // the boundary
  });

  it("counts the raiser's own standing bid as already committed, and other cards as not available", () => {
    /* A holds $200, with $80 on this contest and $60 standing on a different private. $140 is the most this
       contest can see: $200 less the $60 that is somewhere else. */
    const before = board({
      cash: { [A]: 200, [B]: 600, [C]: 600 },
      privates: [
        priv(SV_PRIVATE_ID, 20, [], true),
        priv(2, 40),
        priv(3, 70, [[A, 80], [B, 90], [C, 100]]),
        priv(4, 110, [[A, 60]]),
      ],
      mini: { private_id: 3, bidders: [A, B, C], current_turn: A, high_bid: "100", high_bidder: C },
    });
    expect(refused(before, apply(before, RAISE(145)))).toBe(true);
    expect(ingress(before, A, RAISE(145))).toContain("committed to standing bids on other private companies");
    expect(refused(before, apply(before, RAISE(140)))).toBe(false);
  });

  it("refuses a non-whole raise", () => {
    const before = contested();
    expect(refused(before, apply(before, RAISE("105.5")))).toBe(true);
    expect(ingress(before, A, RAISE("105.5"))).toContain("whole number of dollars");
  });
});

/* ==================================================================================================== */

describe("6. the main rotation is suspended while a contest runs (A14 / S7-15)", () => {
  const live = () =>
    board({
      privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[A, 80], [B, 90]]), priv(4, 110)],
      mini: { private_id: 3, bidders: [A, B], current_turn: A, high_bid: "90", high_bidder: B },
    });

  it("refuses WaterfallBuyLowest, WaterfallBidHigher and WaterfallPass, at both locks", () => {
    const before = live();
    for (const [label, msg] of [["buy", BUY], ["bid", BID(4, 115)], ["pass", PASS]] as const) {
      expect([label, refused(before, apply(before, msg))]).toEqual([label, true]);
      expect([label, ingress(before, A, msg)]).toEqual([label, expect.stringContaining("still being contested")]);
    }
    // The contest's own player is who the seat rule names -- which is exactly why the seat rule cannot catch this.
    expect(auctionActor(wf(before))).toBe(A);
    expect(ingress(before, A, MINI_PASS)).toBeNull();
  });

  it("allows all three again the moment the contest resolves (the control)", () => {
    const settled = apply(live(), MINI_PASS);
    expect(contest(settled)).toBeNull();
    expect(refused(settled, apply(settled, BUY))).toBe(false);
    expect(ingress(settled, auctionActor(wf(settled))!, PASS)).toBeNull();
  });
});

describe("7. the legacy BidOnPrivate message (S7-19 / D-23)", () => {
  it("is refused on a board this engine dealt, and moves no seat", () => {
    const before = board();
    const after = apply(before, LEGACY(3, 80));
    expect(refused(before, after)).toBe(true);
    expect(after.active_player_index).toBe(before.active_player_index);
    expect(ingress(before, A, LEGACY(3, 80))).toContain("legacy message");
    expect(legacyBidRefusal(before)).not.toBeNull();
  });

  it("is left alone on a legacy board (D-9)", () => {
    const { rules_engine_version: _pin, ...legacy } = board();
    expect(legacyBidRefusal(legacy as GameStateResponse)).toBeNull();
    expect(refused(legacy as GameStateResponse, apply(legacy as GameStateResponse, LEGACY(3, 80)))).toBe(false);
  });
});

/* ==================================================================================================== */

describe("8. the all-pass: both halves belong to the Schuylkill Valley (C5 / D-21, §1.2.3)", () => {
  const allPass = (state: GameStateResponse) => {
    let next = state;
    for (let i = 0; i < SEATS.length; i += 1) next = apply(next, PASS);
    return next;
  };

  it("marks the SV down $5 and pays NOBODY while the SV is unsold", () => {
    const before = board({ owned: [[2, B]] }); // B owns the C&SL, so there IS income to withhold
    const after = allPass(before);
    expect(Number(offered(after, SV_PRIVATE_ID)!.face_value)).toBe(15);
    expect(cashOf(after, B)).toBe(600);
    expect(bankOf(after)).toBe(9000);
    expect(moneyConservationBreach(before, after)).toBeNull();
    // ...and nothing else on the table moved price.
    expect(Number(offered(after, 3)!.face_value)).toBe(70);
  });

  it("pays private income and marks NOTHING down once the SV is sold", () => {
    const before = board({
      owned: [[SV_PRIVATE_ID, A], [2, B]],
      privates: [priv(3, 70, [], true), priv(4, 110)],
    });
    const after = allPass(before);
    expect(cashOf(after, A)).toBe(600 + 5); // the SV's own revenue
    expect(cashOf(after, B)).toBe(600 + 10); // the C&SL's
    expect(bankOf(after)).toBe(9000 - 15);
    expect(Number(offered(after, 3)!.face_value)).toBe(70); // NOT marked down
    expect(moneyConservationBreach(before, after)).toBeNull();
  });

  it("does not mark the LPF's James River & Kanawha down when it is the lowest unsold (D-21 / Q8)", () => {
    /* The Level Playing Field adds a seventh private. With the SV sold, the JK can end up the cheapest card
       on offer -- and §1.2.3's markdown is the SV's by name, so the JK keeps its price. This is the
       JUNO-G6J shape, where the old rule marked the JK 120 -> 115. */
    const before = board({
      owned: [[SV_PRIVATE_ID, A]],
      privates: [priv(JK_PRIVATE_ID, 120, [], true), priv(4, 110)],
    });
    const after = allPass(before);
    expect(Number(offered(after, JK_PRIVATE_ID)!.face_value)).toBe(120);
    expect(cashOf(after, A)).toBe(600 + 5); // the SV is sold, so this all-pass pays
  });

  it("hands the SV to the next seat for $0 once it is marked down that far, and pays nobody", () => {
    const before = board({
      owned: [[2, B]],
      privates: [priv(SV_PRIVATE_ID, 5, [], true), priv(3, 70), priv(4, 110)],
      currentTurn: A,
    });
    const after = allPass(before);
    // The markdown takes it to $0, and the seat after the last passer takes it.
    expect(ownerOf(after, SV_PRIVATE_ID)).not.toBeNull();
    expect(offered(after, SV_PRIVATE_ID)).toBeNull();
    expect(cashOf(after, ownerOf(after, SV_PRIVATE_ID)!)).toBe(600); // $0 costs nothing
    expect(bankOf(after)).toBe(9000); // and pays nothing: the SV was unsold when the table passed
    expect(cashOf(after, B)).toBe(600); // no income either
    expect(moneyConservationBreach(before, after)).toBeNull();
    expect(moneyTotal(before)).toBe(moneyTotal(after));
  });
});

/* ==================================================================================================== */

describe("9. a refused auction action changes nothing at all", () => {
  const differingFields = (before: GameStateResponse, after: GameStateResponse): string[] => {
    const was = fieldDigests(before);
    const now = fieldDigests(after);
    return Object.keys({ ...was, ...now })
      .filter((key) => was[key] !== now[key])
      .sort();
  };

  const live = () =>
    board({
      cash: { [A]: 100, [B]: 600, [C]: 600 },
      privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[A, 80], [B, 90]]), priv(4, 110)],
      mini: { private_id: 3, bidders: [A, B], current_turn: A, high_bid: "90", high_bidder: B },
    });

  const cases: Array<[string, GameStateResponse, unknown]> = [
    ["a bid on the lowest-offered private", board(), BID(SV_PRIVATE_ID, 25)],
    ["an unaffordable bid", board({ cash: { [A]: 50 } }), BID(3, 75)],
    ["a sub-minimum bid", board(), BID(3, 71)],
    ["an unaffordable face-value buy", board({ cash: { [A]: 10 } }), BUY],
    ["a buy during a contest", live(), BUY],
    ["a bid during a contest", live(), BID(4, 115)],
    ["a main-rotation pass during a contest", live(), PASS],
    ["a +$1 raise", live(), RAISE(91)],
    ["a raise beyond the raiser's cash", live(), RAISE(200)],
    ["the legacy BidOnPrivate", board(), LEGACY(3, 80)],
  ];

  for (const [label, before, msg] of cases) {
    it(`${label}: no field moves at all`, () => {
      const after = apply(before, msg);
      expect([label, differingFields(before, after)]).toEqual([label, []]);
      expect([label, after]).toEqual([label, before]); // literal whole-state equality
      expect([label, moneyConservationBreach(before, after)]).toEqual([label, null]);
    });
  }

  it("spelled out on one refusal, field by field", () => {
    const before = live();
    const after = apply(before, RAISE(91));
    expect(cashOf(after, A)).toBe(100);
    expect(bankOf(after)).toBe(9000);
    expect(after.private_companies).toEqual(before.private_companies);
    expect(offered(after, 3)!.face_value).toBe("70");
    expect(offered(after, 3)!.bids).toEqual(offered(before, 3)!.bids);
    expect(contest(after)!.bidders).toEqual([A, B]);
    expect(contest(after)!.high_bid).toBe("90");
    expect(contest(after)!.high_bidder).toBe(B);
    expect(contest(after)!.passes_since_raise).toBeUndefined();
    expect(after.waterfall!.current_turn).toBe(before.waterfall!.current_turn);
    expect(after.waterfall!.consecutive_waterfall_passes).toBe(0);
    expect(after.active_player_index).toBe(before.active_player_index);
    expect(after.priority_deal_index).toBe(before.priority_deal_index);
    expect(after.current_round_type).toBe("WaterfallAuction");
  });

  it("the control: the same board accepts the legal version of each (so the cases above are not vacuous)", () => {
    expect(refused(board(), apply(board(), BID(3, 75)))).toBe(false);
    expect(refused(board(), apply(board(), BUY))).toBe(false);
    expect(refused(board(), apply(board(), PASS))).toBe(false);
    const contestBoard = live();
    expect(refused(contestBoard, apply(contestBoard, RAISE(95)))).toBe(false);
    expect(refused(contestBoard, apply(contestBoard, MINI_PASS))).toBe(false);
  });
});

/* ==================================================================================================== */

describe("10. the predicates themselves, and the two locks' agreement", () => {
  it("derives the actor from the atom's cursor, contest first (#1232 / #544)", () => {
    const plain = board({ currentTurn: B });
    expect(auctionActor(wf(plain))).toBe(B);
    const contested = board({
      currentTurn: B,
      mini: { private_id: 3, bidders: [A, C], current_turn: C, high_bid: "90", high_bidder: A },
    });
    expect(auctionActor(wf(contested))).toBe(C);
  });

  it("answers the same question at ingress and in the reducer, for every auction message", () => {
    const boards: Array<[string, GameStateResponse, unknown]> = [
      ["bid on lowest", board(), BID(SV_PRIVATE_ID, 25)],
      ["unaffordable bid", board({ cash: { [A]: 10 } }), BID(3, 75)],
      ["unaffordable buy", board({ cash: { [A]: 10 } }), BUY],
      ["legacy", board(), LEGACY(3, 80)],
    ];
    for (const [label, state, msg] of boards) {
      const reason = auctionRefusal(state, state.waterfall ?? null, msg as never);
      expect([label, reason]).not.toEqual([label, null]);
      // The reducer refuses it, and ingress says the SAME sentence -- one predicate, two askers.
      expect([label, refused(state, apply(state, msg))]).toEqual([label, true]);
      expect([label, ingress(state, auctionActor(wf(state))!, msg)]).toEqual([label, reason]);
    }
  });

  it("states each refusal from the module the rule lives in", () => {
    const b = board({ cash: { [A]: 10 } });
    expect(waterfallBuyRefusal(b, b.waterfall ?? null)).toContain("Schuylkill Valley costs $20");
    expect(waterfallBidRefusal(b, b.waterfall ?? null, { private_id: SV_PRIVATE_ID, bid_amount: "25" })).toContain(
      "cheapest private company",
    );
    const c = board({
      mini: { private_id: 3, bidders: [A, B], current_turn: A, high_bid: "90", high_bidder: B },
      privates: [priv(SV_PRIVATE_ID, 20, [], true), priv(2, 40), priv(3, 70, [[A, 80], [B, 90]]), priv(4, 110)],
    });
    expect(miniRaiseRefusal(c, c.waterfall ?? null, { bid_amount: "91" })).toContain("at least $5");
  });
});
