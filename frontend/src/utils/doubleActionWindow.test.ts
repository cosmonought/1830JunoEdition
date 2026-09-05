/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1172-1173 (harness): ONE WINDOW, REPORTED FROM TWO SEATS
// ==================================================================
//
// REPORTED: "other players are clicking buttons and triggering actions on my turn", and "they bought a share
// of B&O and it didn't register, so they clicked again and suddenly they had two B&O shares."
//
// THEY ARE THE SAME BUG. In a room an action is APPENDED and the board moves when the snapshot replays it, so
// for one round trip the acting client still reads its own turn as live. Click, see nothing, click again --
// and from the next player, who already has the snapshot, that is somebody else acting on their turn.
//
// TWO THINGS SHIPPED, AND EACH ONE ALONE WOULD HAVE STOPPED THE REPORTED PURCHASE:
//   #1172  `sharePurchaseBlock`'s "one purchase per turn" rule has been unreachable since #712, because
//          `boughtThisTurn` defaults to 0 and NO caller ever passed it.
//   #1173  nothing marked an action as in flight, so the controls stayed lit through the whole window.
//
// A THIRD -- a turn check inside the reducer -- was written, broke four suites, and was reverted; #1174 in
// `sandboxSession.ts` records why, and the first block below is the tripwire that keeps it out.

export {};

const { readStripped, readSource, sliceBetween } =
  require("./sourceScan") as typeof import("./sourceScan");
const { sharePurchaseBlock } = require("./sharePurchase") as typeof import("./sharePurchase");

const REDUCER = readStripped("utils/sandboxSession.ts");
/* Design notes are COMMENTS, so a note can only be asserted against the raw file -- `readStripped` removes
   the very text being looked for, and my first draft of the tripwire below searched the stripped copy and
   failed for that reason rather than for a real one. */
const REDUCER_RAW = readSource("utils/sandboxSession.ts");
const APP = readStripped("App.tsx");
const PANEL = readStripped("components/StockRoundPanel.tsx");

type State = import("./gameState").GameStateResponse;

/* ==================================================================
    DESIGN NOTE 1174: THE THIRD FIX WAS REVERTED, AND THE SUITE IS WHY
   ==================================================================
   A reducer-side turn check sat here, refusing a Stock Round action whose actor was not the seat on turn. It
   broke ten tests across four suites, and `replayAttribution` -- #549's harness -- is the one that settles
   it: that file exists because the reducer once read `active_player_index` and so "is not a function of the
   log", and it hands one message to two states with disagreeing cursors to prove they still agree. My check
   read the same field to decide whether the action applied AT ALL, which is that divergence made worse.
   THE ANALYSIS SURVIVES AS A NOTE IN `sandboxSession.ts`, at the point where the check would go, because the
   audit needs the inventory -- four rotations, four legitimate off-turn flows, and the log-format change
   (a seat stamped on the entry) that would actually let this be checked without consulting the cursor.
   WHAT REMAINS BELOW is what shipped: #1172's purchase count and #1173's in-flight latch. Neither reads the
   cursor, and each one alone would have stopped the reported double purchase. */

describe("the reducer still refuses to read the cursor", () => {
  it("keeps the turn check out of the replay", () => {
    /* A TRIPWIRE, not a preference. Anything that reintroduces a turn REFUSAL inside `applyOneAction` puts
       two clients back on two games, and the failure surfaces somewhere unrelated a round later. */
    expect(REDUCER).not.toContain("offTurnRefusal");
  });

  it("leaves #549's own cursor read exactly where it is", () => {
    /* MY FIRST DRAFT OF THE TRIPWIRE ABOVE BANNED `state.active_player_index]` OUTRIGHT, and that was wrong
       in the same direction as the change it was guarding: `applyOneAction` reads the cursor deliberately, as
       the ATTRIBUTION FALLBACK for a log entry with no author (#549 -- "undefined means solo, the cursor is
       the actor"). Banning the read would have deleted the fallback the whole note depends on.
       THE LINE IS BETWEEN READING IT AND OBEYING IT. Resolving an absent author from the cursor is local
       colour that every client computes identically from the same log; refusing an action because of the
       cursor makes the outcome depend on where each client's replay happens to be. */
    const apply = sliceBetween(REDUCER, "function applyOneAction(", '\n  if ("SellStock" in msg)');
    expect(apply).toContain("state.player_addresses[state.active_player_index] ?? null");
    /* A THIRD ASSERTION STOOD HERE AND WAS VACUOUS: it looked for `// Passing means two things` in
       `REDUCER`, which is `readStripped` -- comments removed -- so it could only ever pass. That is
       `sourceScan` #886's exact subject, "an assertion with nothing under it", and this file's own
       `actionReceipt` neighbour was written after the same fault. Deleted rather than re-pointed: the two
       assertions above carry the claim, and a third that cannot fail adds only the appearance of rigour. */
  });

  it("says where the answer has to come from instead", () => {
    /* So the next reader finds the reasoning rather than rediscovering it by breaking the same four suites. */
    expect(REDUCER_RAW).toContain("DESIGN NOTE 1174: THE TURN CHECK THAT CANNOT LIVE HERE");
  });
});

describe("the one-purchase-per-turn rule can finally fire", () => {
  const buyState = (bought: number): State =>
    ({
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          player_holdings: [],
          bank_pool_percentage: 50,
          ipo_pool_percentage: 50,
        },
      ],
      player_addresses: ["alice"],
      sold_this_round: {},
      /* `certificateBreakdown` walks this, so the fixture carries it. An empty roster is the honest shape for
         a purchase test: privates change the certificate LIMIT, which rule 2 owns and rule 4 does not. */
      private_companies: [],
      bought_this_turn: bought,
    }) as unknown as State;

  it("refuses a second purchase outside the Brown pool allowance", () => {
    const refusal = sharePurchaseBlock({
      state: buyState(1),
      buyer: "alice",
      companyId: 1,
      source: "Ipo",
      quantity: 1,
      zone: "Normal",
      boughtThisTurn: 1,
    });
    expect(refusal).toContain("One certificate purchase per turn");
  });

  it("still allows the Brown-zone Bank Pool multi-buy the rules grant", () => {
    /* THE REPORTER'S OWN CORRECTION, and it is the reason this is not a blanket block: "players ARE allowed
       to buy multiple shares when a corporation is in the appropriate zone." */
    expect(
      sharePurchaseBlock({
        state: buyState(1),
        buyer: "alice",
        companyId: 1,
        source: "Bank",
        quantity: 1,
        zone: "Brown",
        boughtThisTurn: 1,
      }),
    ).toBeNull();
  });

  it("does not refuse the FIRST purchase of a turn", () => {
    expect(
      sharePurchaseBlock({
        state: buyState(0),
        buyer: "alice",
        companyId: 1,
        source: "Ipo",
        quantity: 1,
        zone: "Normal",
        boughtThisTurn: 0,
      }),
    ).toBeNull();
  });

  it("is fed by BOTH callers now, which is the whole of #1172", () => {
    /* The parameter existed, was defaulted, was read -- and no caller passed it. The rule was documentation. */
    expect(REDUCER).toContain("boughtThisTurn: state.bought_this_turn ?? 0");
    expect(APP).toContain("boughtThisTurn: gameState.bought_this_turn ?? 0");
  });

  it("counts certificates on the purchase, and accumulates rather than sets", () => {
    /* A Brown pool buy of three is one purchase taking three certificates, and the allowance permits another
       message after it -- so the rule needs the running total, not the last message's quantity. */
    expect(REDUCER).toContain("bought_this_turn: (state.bought_this_turn ?? 0) + certificates");
  });

  it("dies with the turn, at every site that moves the seat", () => {
    /* #745's warning, in its own words: the flag is cleared "in both seat-moving functions rather than in the
       arms that call them", plus the reset where "the seat is being MOVED without going through either". A
       count that outlived its turn would refuse a player's legal purchase on their NEXT turn. */
    expect(sliceBetween(REDUCER, "function advanceSeat(", "\n}")).toContain("bought_this_turn: 0");
    expect(sliceBetween(REDUCER, "function recordPass(", "\n  if (streak < count)")).toContain(
      "bought_this_turn: 0",
    );
    expect(sliceBetween(REDUCER, "export function openingStockRoundReset(", "\n}")).toContain(
      "bought_this_turn: 0",
    );
  });
});

describe("the controls go quiet while a press is in flight", () => {
  it("latches before the await, which is where the second click lands", () => {
    /* A latch set from the resolved index would be set after the damage: the double-click happens DURING the
       Firestore write. */
    const dispatch = sliceBetween(APP, "const appendAt = appliedIndexRef.current;", "const allocated = await");
    expect(dispatch).toContain("if (options?.automatic !== true) setPendingAppendIndex(appendAt);");
  });

  it("releases on the arrival of THIS action, not of any snapshot", () => {
    /* At a four-player table somebody else's action lands in the same window, and clearing on that would open
       the controls again before the player's own move had come back. */
    expect(APP).toContain("if (sandboxAppliedCount > pendingAppendIndex) setPendingAppendIndex(null);");
  });

  it("releases on a failed write, so a dropped action cannot strand the player", () => {
    expect(APP).toContain("setPendingAppendIndex((current) => (current === appendAt ? null : current));");
  });

  it("cannot outlast a plausible round trip", () => {
    expect(APP).toContain("setTimeout(() => setPendingAppendIndex(null), ACTION_LATCH_BACKSTOP_MS)");
    expect(APP).toContain("const ACTION_LATCH_BACKSTOP_MS = 6000;");
  });

  it("greys the controls without closing the dispatch gate", () => {
    /* #916's route loop and #1077's multi-train buy send several messages from ONE press, in code. Closing
       the gate would break them; greying a button cannot, because nobody is clicking it. */
    const gate = sliceBetween(APP, "if (\n          options?.isRemoteReplay !== true &&", "return;\n        }");
    expect(gate).not.toContain("pendingAppendIndex");
    expect(gate).not.toContain("actionInFlight");
  });

  it("narrows the ACTING gate on the bar and leaves the presentation flag alone", () => {
    /* #1242 on that bar: "A SECOND FLAG, NOT A NARROWER `isMyTurn`. This bar reads `isMyTurn` for six things,
       and five of them are" presentation -- the turn band, the pulse, whose drafts to show. */
    expect(APP).toContain("sessionReady={controlsEnabled && isMyTurn && !actionInFlight}");
    expect(APP).toContain("isMyTurn={isMyTurn}");
  });

  it("adds the condition to the panel's one flag rather than to its five controls", () => {
    /* #32's argument, which #681 already followed when it added the third condition. */
    expect(PANEL).toContain(
      "!sessionReady || actionsLockedReason != null || !isMyTurn || actionInFlight",
    );
  });

  it("says why, last in the precedence, because it is about to resolve itself", () => {
    expect(PANEL).toContain('"Sending your last action — one moment."');
    const reason = sliceBetween(PANEL, "const controlsBlockedReason", "const [activeCompanyId");
    expect(reason.indexOf("It is ${activePlayerLabel")).toBeLessThan(reason.indexOf("actionInFlight"));
    /* And the session key stays first of all four: a player with no key cannot act for a reason that has
       nothing to do with turns, and telling them to wait for a snapshot would send them looking in the wrong
       place entirely. */
    expect(reason.indexOf("Initialize the session key")).toBeLessThan(reason.indexOf("actionInFlight"));
  });
});
