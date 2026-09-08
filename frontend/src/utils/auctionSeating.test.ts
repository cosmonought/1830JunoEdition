/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1227 (harness): THE AUCTION NOBODY WAS SITTING IN
// ==================================================================
//
// The engine was constructed with `waterfallForRoster(base, [])` -- an empty roster, which is correct before
// a deal -- and never re-seated it. `SetupGame` deals the players onto the BOARD, and the shell's own handler
// has always re-seated the AUCTION ATOM from the dealt roster in the same breath. The engine had no such
// line; `waterfallForRoster` did not appear in the file at all.
//
// SO `current_turn` STAYED `""`, which #542 chose deliberately because it "matches nobody, so no client
// believes it is their turn". Right before a game exists. Wrong immediately afterwards, and every auction
// action the server judged was judged against an auction with no players in it.
//
// WHAT IT LOOKED LIKE, from the two halves of one divergence report:
//
//   CLIENT  Host pays $20 and owns Schuylkill Valley        -- what "buy the lowest" plainly means
//   SERVER  nothing; then the OTHER player's move awarded
//           Champlain & St. Lawrence to Host for $40        -- incoherent
//
// AND THE PLAYTESTS PASSED THROUGH IT ANYWAY, because the board a player saw was the shell's, computed
// locally and correctly. The server's copy was nonsense from index 1 and nothing compared them until #1223.
//
// THESE CASES ASSERT THE SEATING, NOT THE SYMPTOM. A test that only checked "Host owns SV" would pass again
// the day somebody re-seated the auction from `msg.SetupGame.players` instead of from the dealt board -- an
// order that is usually the same and is not guaranteed to be, which is the failure this project keeps having.

export {};

const RL = require("./replayLog") as typeof import("./replayLog");
const { sandboxReplayProviders } = require("./replayProviders") as typeof import("./replayProviders");
const { withEmptyRoster, waterfallForRoster } =
  require("./gameSetup") as typeof import("./gameSetup");
const S = require("./sandboxState") as typeof import("./sandboxState");

const HOST = "p-host0001";
const GUEST = "p-guest002";

function dealt(variants: Record<string, unknown> = {}) {
  const scenario = S.DEFAULT_SANDBOX_SCENARIO;
  const engine = new RL.RoomEngine(sandboxReplayProviders(), {
    state: withEmptyRoster(S.sandboxScenarioState(scenario, 0, "default")),
    waterfall: waterfallForRoster(
      S.sandboxWaterfallState(S.sandboxScenario(scenario).phase, 0, true),
      [],
    ),
  });
  return { engine, scenario, variants };
}

const entriesFor = (msgs: unknown[]) =>
  RL.entriesFromExport(
    msgs.map((msg, index) => ({ index, id: `s${index}`, actor: HOST, at: index + 1, msg })),
  );

const SETUP = (variants: Record<string, unknown> = {}) => ({
  SetupGame: {
    players: [
      { id: HOST, nickname: "Host" },
      { id: GUEST, nickname: "Guest" },
    ],
    variants: {
      delayedAuction: false,
      dynamicStockMarket: false,
      gentleRust: false,
      length: "standard",
      unpredictableRevenue: false,
      ...variants,
    },
  },
});

describe("the shell no longer deals, #1230", () => {
  /* THE FIRST OF THE TEN TO COME OFF THE SHELL. `App.tsx`'s `SetupGame` branch computed the whole dealt board
     and returned, so the reducer's arm never ran on a client -- and the server has no shell, so it ran only
     the arm. #1221, #1227 and #1228 are the three times those two copies were caught disagreeing. The branch
     now keeps narration and registries only and FALLS THROUGH; the reducer deals; the auction is re-seated from
     the dealt board afterwards, where the engine does it. */
  const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
  const APP = readStripped("App.tsx");
  /* CODE ANCHORS, NOT COMMENT TEXT. `readStripped` removes every block comment before the scan, so an anchor
     that names a design note is an anchor on nothing. The first `isSetupGameMsg(msg)` in the file is the
     narration branch; the post-reducer re-seat is the second and is found separately below. */
  const branch = sliceBetween(
    APP,
    "if (isSetupGameMsg(msg)) {",
    "const gridBeforeAction = mapGridRef.current;",
  );

  it("writes no state from the shell branch", () => {
    /* The three writes the old branch made. Any one of them coming back is a second dealer. */
    expect(branch).not.toContain("sandboxStateRef.current =");
    expect(branch).not.toContain("setSandboxState(");
    expect(branch).not.toContain("setSandboxWaterfall(");
  });

  it("does not return, so the reducer's arm is reached", () => {
    /* THE LINE THAT MADE IT A SECOND IMPLEMENTATION. A `return` here is how the reducer's arm went unrun on
       every client for as long as it existed. */
    expect(branch).not.toMatch(/\n\s*return;\s*\n/);
  });

  it("still narrates and still names the players", () => {
    expect(branch).toContain("setRoomNicknames(");
    expect(branch).toContain("setRoomColors(");
    expect(branch).toContain("Game dealt for");
  });

  it("re-seats the auction after the reducer, from the dealt board", () => {
    /* `after.player_addresses`, never `msg.SetupGame.players` -- the reducer shuffles, and the listed order
       is usually the dealt order and is not the same rule. */
    const reseat = sliceBetween(APP, "const reseated = waterfallForRoster(", "setSandboxWaterfall(armed);");
    expect(reseat).toContain("after.player_addresses");
    expect(reseat).not.toContain("msg.SetupGame.players");
  });

  it("does not print a second line for the deal", () => {
    // #1057: one consequence, one line. The narration branch is the line; the generic sentence stays quiet.
    expect(APP).toContain("(!options?.silentInLog && !isSetupGameMsg(msg)) || refusalWasRefused");
  });
});

describe("the deal seats the auction, #1227", () => {
  it("puts a dealt player on turn instead of nobody", () => {
    /* THE DIRECT PROPERTY, and the one the symptom test below cannot see on its own. An empty `current_turn`
       is the seed's answer and it must not survive the deal. */
    const { engine } = dealt();
    for (const entry of entriesFor([SETUP()])) engine.apply(entry);
    const waterfall = engine.snapshot.waterfall;
    expect(waterfall).not.toBeNull();
    expect(waterfall?.current_turn).not.toBe("");
    expect([HOST, GUEST]).toContain(waterfall?.current_turn);
  });

  it("seats from the DEALT board, not from the message's player list", () => {
    /* `applyOneAction` owns `SetupGame` and decides the dealt order -- it shuffles. Re-seating from
       `msg.SetupGame.players` would use the order the players were LISTED, which is usually the same and is
       not the same rule. Asserted against the board so the two cannot drift. */
    const { engine } = dealt();
    for (const entry of entriesFor([SETUP()])) engine.apply(entry);
    const seated = engine.snapshot.state.player_addresses ?? [];
    expect(engine.snapshot.waterfall?.current_turn).toBe(seated[0]);
  });

  it("buys the lowest private for its owner, at its price", () => {
    /* THE SYMPTOM, from the divergence report that found this: Host pays $20 and owns Schuylkill Valley.
       Before the fix the server did nothing here at all. */
    const { engine } = dealt();
    for (const entry of entriesFor([SETUP(), { WaterfallBuyLowest: { game_id: 0 } }])) {
      engine.apply(entry);
    }
    const state = engine.snapshot.state;
    const sv = state.private_companies.find((entry) => entry.private_id === 1);
    expect(sv?.name).toContain("Schuylkill");
    expect(sv?.owner).toBe(HOST);
    const host = state.player_cash.find((entry) => entry.player === HOST);
    expect(Number(host?.cash_vgp)).toBe(1200 - Number(sv?.cost));
  });

  it("deals a delayed auction without starting it, #905", () => {
    /* "DEALT NOW, RUN LATER." The re-seat and the arming are one decision: a variant that opens on Stock
       Round 1 must have its auction built from the dealt roster and NOT active. Splitting them would give
       the server a live auction in a game the client had already moved past.

       THIS CASE FOUND #1228 ON ITS FIRST DRAFT. It asserted `current_round_type === "StockRound"` after the
       deal, because that is what a client shows -- and it failed, because the client showed it for a reason
       that had nothing to do with the reducer: the shell computed it alone. The reducer now owns #905's
       switch, so the assertion is back, and it is asserting the specification rather than one side's habit. */
    const { engine } = dealt();
    for (const entry of entriesFor([SETUP({ delayedAuction: true })])) engine.apply(entry);
    const waterfall = engine.snapshot.waterfall;
    const state = engine.snapshot.state;
    expect(state.current_round_type).toBe("StockRound");
    /* MOVED, NOT SKIPPED. Marking the auction complete here would open on SR1 and never run it (#905). */
    expect(state.private_auction_complete).toBe(false);
    expect(state.macro_round_number).toBe(1);
    expect(waterfall?.current_turn).not.toBe("");
    expect(waterfall?.waterfall_auction_active).toBe(false);
  });

  it("leaves a standard game in the auction it opens with", () => {
    /* The pair for #1228: a switch that fired regardless of the variant would pass the case above and put
       every ordinary game straight into a Stock Round with six privates unsold. */
    const { engine } = dealt();
    for (const entry of entriesFor([SETUP()])) engine.apply(entry);
    expect(engine.snapshot.state.current_round_type).toBe("WaterfallAuction");
    expect(engine.snapshot.state.private_auction_complete).not.toBe(true);
  });

  it("leaves a standard game's auction live", () => {
    /* The pair. Without it, an arming rule that switched everything off would pass the case above and break
       every ordinary game -- which is the same shape as #1221's "asserted both ways round". */
    const { engine } = dealt();
    for (const entry of entriesFor([SETUP()])) engine.apply(entry);
    expect(engine.snapshot.waterfall?.waterfall_auction_active).not.toBe(false);
  });
});

describe("a mini-auction suspends the rotation on BOTH atoms, #1232", () => {
  /* REPORTED: "a mini-auction occurred, and then the game locked after the mini-auction concluded. It says
     it's one person's turn but nothing they click does anything."
     THE TRACE: after the contest's closing pass, the STATE's seat had advanced (Host) and the AUCTION's cursor
     had not (sandbox). `actingAddress` read the seat. Host passed the gate and died in an auction that was
     waiting for sandbox; sandbox died at the gate. Two cursors, one step apart, nobody able to move.
     THE SEQUENCE IS THE ONE THE PLAYER PLAYED, so this is the lock itself and not a model of it. */
  const { actingAddress } = require("./gameState") as typeof import("./gameState");
  const { turnRefusal } = require("./turnAuthority") as typeof import("./turnAuthority");
  const { describeGameplayAction } = require("./actionLog") as typeof import("./actionLog");

  const SANDBOX = "p-lnmvtnp9";
  const HOST_ = "p-trzsxeox";
  const played = (upTo: number) => {
    const scenario = S.DEFAULT_SANDBOX_SCENARIO;
    const engine = new RL.RoomEngine(sandboxReplayProviders(), {
      state: withEmptyRoster(S.sandboxScenarioState(scenario, 0, "default")),
      waterfall: waterfallForRoster(
        S.sandboxWaterfallState(S.sandboxScenario(scenario).phase, 0, true),
        [],
      ),
    });
    const script: Array<[string, unknown]> = [
      [HOST_, { SetupGame: { players: [{ id: SANDBOX, nickname: "sandbox" }, { id: HOST_, nickname: "Host" }], variants: { delayedAuction: false } } }],
      [SANDBOX, { WaterfallBuyLowest: { game_id: 0 } }],
      [HOST_, { WaterfallBidHigher: { bid_amount: "75", game_id: 0, private_id: 3 } }],
      [SANDBOX, { WaterfallBidHigher: { bid_amount: "80", game_id: 0, private_id: 3 } }],
      [HOST_, { WaterfallBuyLowest: { game_id: 0 } }],
      [HOST_, { WaterfallMiniAuctionPass: { game_id: 0 } }],
    ];
    const entries = RL.entriesFromExport(
      script.slice(0, upTo + 1).map(([actor, msg], index) => ({ index, id: `j${index}`, actor, at: index + 1, msg })),
    );
    for (const entry of entries) engine.apply(entry);
    return engine;
  };

  it("resumes the rotation where it was suspended, on both atoms", () => {
    const engine = played(5);
    const { state, waterfall } = engine.snapshot;
    /* THE SEAT MIRRORS THE AUCTION AGAIN. Before the fix: seat -> Host, cursor -> sandbox. */
    expect(state.player_addresses[state.active_player_index]).toBe(waterfall?.current_turn);
    expect(actingAddress(state, waterfall)).toBe(SANDBOX);
  });

  it("lets the resumed player act and refuses the other, so nobody is locked out", () => {
    const { state, waterfall } = played(5).snapshot;
    const buy = { WaterfallBuyLowest: { game_id: 0 } } as never;
    expect(turnRefusal({ state, waterfall, actor: SANDBOX, msg: buy })).toBeNull();
    expect(turnRefusal({ state, waterfall, actor: HOST_, msg: buy })).toBe("It is not your turn.");
  });

  it("and the game goes on: the next buy lands and hands the turn over", () => {
    const engine = played(5);
    engine.apply(
      RL.entriesFromExport([{ index: 6, id: "j6", actor: SANDBOX, at: 7, msg: { WaterfallBuyLowest: { game_id: 0 } } }])[0],
    );
    const { state, waterfall } = engine.snapshot;
    expect(state.private_companies.filter((entry) => entry.owner).length).toBe(4);
    expect(actingAddress(state, waterfall)).toBe(HOST_);
  });

  it("reads the auction's cursor even if the seat were to drift again", () => {
    /* THE READING-SIDE HALF. The reducer fix keeps the seat in step; this asserts that `actingAddress` would
       name the right player even if it did not -- the auction applies actions under its own cursor, so the
       gate must judge by that cursor and not by a mirror of it. */
    const { state, waterfall } = played(5).snapshot;
    const drifted = { ...state, active_player_index: 1 }; // Host's seat, deliberately wrong
    expect(actingAddress(drifted, waterfall)).toBe(SANDBOX);
  });

  it("names the bidder who actually passed", () => {
    /* The Activity Log said "sandbox passed in the mini-auction" about a pass Host made -- the narration was a
       third reader of the seat. It now asks `actingAddress`, with the auction atom in hand. */
    const before = played(4).snapshot; // the contest is live; Host is on the contest's cursor
    const line = describeGameplayAction({ WaterfallMiniAuctionPass: { game_id: 0 } } as never, {
      gameState: before.state,
      waterfall: before.waterfall,
      mapGrid: { hexes: [] } as never,
      era: "Yellow" as never,
      labelForAddress: (address: string) => (address === HOST_ ? "Host" : "sandbox"),
    });
    expect(line).toBe("Host passed in the mini-auction.");
  });
});

describe("the Stock Round opens to the left of the last player who acted, #1235", () => {
  /* REPORTED: "Host received BO private company -- the last action of the Auction Round -- then also started
     the Stock Round. That is wrong. In the physical board game, play passes to the last active player's left."
     `openingStockRoundReset` seated `priority_deal_index`, and the auction never touched it -- seat 0 opened
     Stock Round 1 whoever had just bought the last private. The seat cursor at the moment the auction closes
     already IS the player to the left of the last actor (every ordinary waterfall action advances past its
     actor; #1232 keeps that honest through a contest), so the priority deal is set from it, once. */
  const { actingAddress } = require("./gameState") as typeof import("./gameState");
  const HOST_ = "p-gdw59s92";
  const SANDBOX = "p-q3um9cne";
  const auctionEndingWith = (finalBuyer: string, otherPlayer: string) => {
    const scenario = S.DEFAULT_SANDBOX_SCENARIO;
    const engine = new RL.RoomEngine(sandboxReplayProviders(), {
      state: withEmptyRoster(S.sandboxScenarioState(scenario, 0, "default")),
      waterfall: waterfallForRoster(S.sandboxWaterfallState(S.sandboxScenario(scenario).phase, 0, true), []),
    });
    /* The player's own sequence (JUNO-G2A): Host buys the last private (the B&O) at index 9, sets its par at
       10, and the round opens at 11. Host is seat 0, so under the old rule Host also opened SR1. */
    const script: Array<[string, unknown]> = [
      [finalBuyer, { SetupGame: { players: [{ id: finalBuyer, nickname: "Host" }, { id: otherPlayer, nickname: "sandbox" }], variants: { delayedAuction: false } } }],
      [finalBuyer, { WaterfallBuyLowest: { game_id: 0 } }], [otherPlayer, { WaterfallBuyLowest: { game_id: 0 } }],
      [finalBuyer, { WaterfallBidHigher: { bid_amount: "115", game_id: 0, private_id: 4 } }],
      [otherPlayer, { WaterfallBidHigher: { bid_amount: "120", game_id: 0, private_id: 4 } }],
      [finalBuyer, { WaterfallBuyLowest: { game_id: 0 } }],
      [finalBuyer, { WaterfallMiniAuctionRaise: { bid_amount: "125", game_id: 0 } }],
      [otherPlayer, { WaterfallMiniAuctionPass: { game_id: 0 } }],
      [otherPlayer, { WaterfallBuyLowest: { game_id: 0 } }], [finalBuyer, { WaterfallBuyLowest: { game_id: 0 } }],
      [finalBuyer, { SetBoPar: { par_value: "100", player: finalBuyer } }],
      [finalBuyer, { OpenStockRound: {} }],
    ];
    for (const entry of RL.entriesFromExport(script.map(([actor, msg], index) => ({ index, id: `g${index}`, actor, at: index + 1, msg })))) {
      engine.apply(entry);
    }
    return engine.snapshot;
  };

  it("hands the first Stock Round turn to the player after the last buyer", () => {
    const { state, waterfall } = auctionEndingWith(HOST_, SANDBOX);
    expect(state.current_round_type).toBe("StockRound");
    expect(state.player_addresses[state.active_player_index]).toBe(SANDBOX);
    expect(actingAddress(state, waterfall)).toBe(SANDBOX);
  });

  it("records that seat as the priority deal, so the round's own bookkeeping agrees", () => {
    const { state } = auctionEndingWith(HOST_, SANDBOX);
    expect(state.player_addresses[state.priority_deal_index]).toBe(SANDBOX);
  });

  it("does not let the B&O par count as a turn taken", () => {
    /* `SetBoPar` is set BY the buyer and does not advance the seat, so a game whose final auction act is
       the B&O purchase still opens to the buyer's left -- not two seats along. Two players make this
       observable: two-along would be the buyer again. */
    const { state } = auctionEndingWith(HOST_, SANDBOX);
    expect(state.player_addresses[state.active_player_index]).not.toBe(HOST_);
  });
});

describe("OpenStockRound and SetBoPar are off the shell, #1234 / #1236", () => {
  const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
  const APP = readStripped("App.tsx");

  it("OpenStockRound has no shell branch left at all", () => {
    /* #1236 left a branch that narrated and fell through; #1246 moved the narration to
       `describeGameplayAction` and the empty branch came out. The only `isOpenStockRoundMsg` read left in the
       drain is the atom-closing one below the reducer. */
    expect(APP).not.toContain("if (isOpenStockRoundMsg(msg)) {");
    expect(readStripped("utils/actionLog.ts")).toContain("The Waterfall Auction is complete");
  });

  it("closes the auction atom after the reducer, where the engine closes it", () => {
    const after = sliceBetween(APP, "if (isOpenStockRoundMsg(msg) && sandboxWaterfallRef.current?.waterfall_auction_active) {", "if (isSetupGameMsg(msg)) {");
    expect(after).toContain("waterfall_auction_active: false");
    expect(after).toContain("setSandboxWaterfall(closed)");
  });
});
