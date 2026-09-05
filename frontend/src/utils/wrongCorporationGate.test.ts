/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1182 (harness): ONE ARM CHECKED, AND THREE DID NOT
// ==================================================================
//
// REPORTED, with the log, twice:
//
//   [OR 7.1-Lay Track]  B&O laid Tile #23 on G5.
//   [OR 7.1-Run Routes] B&O ran 2 routes for $260 ...
//   [OR 7.1-Dividends]  Failed: REFUSED - ... Only the operating corporation declares dividends.
//   [OR 7.1]            C&O ended its turn.
//
// THE LAST LINE NAMES A DIFFERENT CORPORATION FROM THE REST, and the refusal says why: the board had C&O
// operating while the messages carried B&O. Two clients were operating two corporations into one log.
//
// EVERY ACTION APPLIED EXCEPT THE LAST. `dividendRefusal` has compared the message's corporation against the
// cursor since #748; nothing else did. So a divergent client laid a tile on shared terrain and banked two
// routes' revenue, and was stopped only at the arm that happened to ask.
//
// THIS DOES NOT FIX THE DIVERGENCE. `buildOperatingOrder` sorts on three keys read from the client-local
// market chart and filters on floated-with-a-president, so a chart or float disagreement (#1177) reorders the
// turn. What this makes certain is that the consequence is a refusal on every client rather than a tile
// nobody agreed to.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { wrongCorporationRefusal, dividendRefusal } =
  require("./dividendGate") as typeof import("./dividendGate");

const REDUCER = readStripped("utils/sandboxSession.ts");

type State = import("./gameState").GameStateResponse;

const operating = (order: number[], index: number, round = "OperatingRound"): State =>
  ({
    current_round_type: round,
    active_operating_order: order,
    active_corporation_index: index,
  }) as unknown as State;

describe("an action names the corporation it is for, and the board checks", () => {
  it("refuses one aimed at a corporation that is not operating", () => {
    /* THE REPORTED CASE: the queue is on C&O (id 2) and the message carries B&O (id 1). */
    expect(wrongCorporationRefusal(operating([2, 1], 0), 1, "lay track")).toBe(
      "Only the operating corporation may lay track.",
    );
  });

  it("allows the corporation that is operating", () => {
    expect(wrongCorporationRefusal(operating([2, 1], 0), 2, "lay track")).toBeNull();
  });

  it("says nothing where the queue cannot answer", () => {
    /* Outside an Operating Round, and with an empty order. These messages also travel in the auction and the
       Stock Round, and a refusal there would block legal play -- silence is the honest answer to a question
       the state cannot be asked. */
    expect(wrongCorporationRefusal(operating([2, 1], 0, "StockRound"), 1, "run routes")).toBeNull();
    expect(wrongCorporationRefusal(operating([], 0), 1, "run routes")).toBeNull();
  });

  it("agrees with the arm that has been asking all along", () => {
    /* `dividendRefusal` is the precedent, not a rival: same comparison, same state, same verdict. If these
       two ever disagree the board would refuse a declaration it had allowed the routes for. */
    const state = operating([2, 1], 0);
    expect(dividendRefusal(state, 1)).toBe("Only the operating corporation declares dividends.");
    expect(wrongCorporationRefusal(state, 1, "run routes")).not.toBeNull();
    expect(dividendRefusal(state, 2)).toBeNull();
    expect(wrongCorporationRefusal(state, 2, "run routes")).toBeNull();
  });
});

describe("the three arms that were applying without asking", () => {
  it("guards the tile lay, which changes shared terrain", () => {
    /* A tile alters every other corporation's reach, so a wrong-corporation lay damages players who were not
       even involved in the mistake. */
    expect(REDUCER).toContain('wrongCorporationRefusal(state, protocol_id, "lay track")');
  });

  it("guards the route run, which is where the revenue came from", () => {
    expect(REDUCER).toContain('wrongCorporationRefusal(state, protocol_id, "run routes")');
  });

  it("guards the station token, the least reversible of the three", () => {
    expect(REDUCER).toContain('wrongCorporationRefusal(state, protocol_id, "place a station token")');
  });

  it("leaves the state untouched rather than throwing, like every other refusal here", () => {
    /* #712's rule: a replay must not halt on an entry the log already contains, and an action that should not
       have been sent is best treated as one that did nothing. */
    for (const arm of ["lay track", "run routes", "place a station token"]) {
      const at = REDUCER.indexOf(`wrongCorporationRefusal(state, protocol_id, "${arm}")`);
      expect([arm, at]).not.toEqual([arm, -1]);
      /* 140, NOT 90. The first draft used a window sized to the shortest arm and the longest reason string --
         "place a station token" -- pushed `return state;` past the end, so the case failed on the arm that
         was guarded exactly like its two neighbours. A window measured against one example is a window that
         reports on its own width. */
      expect([arm, REDUCER.slice(at, at + 140).includes("return state;")]).toEqual([arm, true]);
    }
  });
});

describe("it is not the check that was reverted", () => {
  it("compares the MESSAGE against the state, never the log entry's actor", () => {
    /* #1174 read `active_player_index` to decide whether an action applied, which is the cursor #549 forbids
       the reducer to consult -- two clients whose replays sat at different points would disagree about
       whether a move happened at all. Both sides of THIS comparison come out of the log: the corporation is
       carried in the message, and the queue is rebuilt from the same prefix on every client. */
    const gate = sliceBetween(
      readStripped("utils/dividendGate.ts"),
      "export function wrongCorporationRefusal(",
      "export function dividendRefusal(",
    );
    expect(gate).not.toContain("active_player_index");
    expect(gate).not.toContain("actor");
    expect(gate).toContain("operatingCorporationId(state)");
    expect(REDUCER).not.toContain("offTurnRefusal");
  });
});
