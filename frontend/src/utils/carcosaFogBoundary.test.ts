/** @jest-environment node */
//
// ==================================================================
//  UR-3 (harness): THE FOG IS AN OR-SET-BOUNDARY TRANSITION AT THE END OF SET N+1 (OD-UR-2, UR-F18)
// ==================================================================
//
// OWNER RULING OD-UR-2 ("N+1 + boundary", backlog D-38): a doom trigger in Operating-Round set N lets the gilded train
// survive through the WHOLE next set, N+1, and it disappears automatically at the END of N+1 -- an authoritative
// OR-set-boundary transition, not a run stage and not a client request. No extra post-deadline run, no indefinite
// survival because its corporation stops running, no post-deadline window to sell it. #1092's run-triggered
// collection is superseded: "do not restore the current `N+1 + on-run` behaviour". The fog is not ordinary rust.
//
// THE TIMELINE CASE IS A HOSTED GAME, not a patched board: a constructed phase-6 board (every fact below is reachable)
// driven only by messages through `RoomSession.submit`, the room deriving its own skips and forced withholds.
//   * Rules: Unpredictable Revenue on, pinned to the engine's version.
//   * Map: the printed board with Albany (E19) laid -- a loaded map on which nobody has an earnable route, so every
//     Routes step is the room's skip and every Dividends step its $0 withhold (GR-4's device).
//   * NYC [6] with $1,500 (it will buy the first REAL D); CPR [6] holding the GILDED 6 of an earlier Carcosa (no doom
//     clock yet: no real Diesel exists); B&O [5]. Each token on its printed home. Phase 6 (one real 6 owned): brown,
//     three Operating Rounds a set, the 6 / D shelf open.
// Set N is macro 5; NYC's first real Diesel in OR 5.1 is the trigger (doom = 6); set N+1 is macro 6; the train must be
// on the board through the last entry of OR 6.3 and gone on the transition into Stock Round 7.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

export {};

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { applySandboxAction, settleTrainSale } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { STATION_HOME_HEXES } = require("../components/hexContractTypes") as typeof import("../components/hexContractTypes");
const { fogIsDue } = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const { describeFleetLosses } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { realDieselPurchased, depotInventory } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");

const { NYC, CPR, BO, P1, P2, P3, urBoard, companyOf } = S;

const home = (id: number) => STATION_HOME_HEXES.find((entry) => entry.companyId === id)!;
/** Albany laid: a loaded map with no earnable route anywhere. */
const ALBANY: MapGridResponse = {
  game_id: 1,
  tiles: [{ q: home(NYC).q, r: home(NYC).r, tile_id: 57, orientation: 0 }],
} as unknown as MapGridResponse;

const GILDED_6 = { is_carcosan: true, carcosan_trains: ["6"], ghost_trains: ["6"] };

const start = (over: Partial<Parameters<typeof urBoard>[0]> = {}): GameStateResponse =>
  urBoard({
    corps: [
      { id: NYC, president: P2, trains: ["6"], treasury: 1500, price: 112 },
      { id: CPR, president: P3, trains: ["6"], treasury: 400, price: 100, extra: GILDED_6 },
      { id: BO, president: P1, trains: ["5"], treasury: 400, price: 90 },
    ],
    macro: 5,
    sub: 1,
    sequence: 3,
    step: "Track",
    ...over,
  });

const cpr = (state: GameStateResponse) => companyOf(state, CPR);
const gilded = (state: GameStateResponse) => (cpr(state).carcosan_trains ?? []).length > 0;

interface Played {
  label: string;
  kind: string;
  msg: unknown;
  before: GameStateResponse;
  after: GameStateResponse;
}

/** Plays the room forward: each operating president leaves Lay Track and ends the turn (the room skips the rest),
 *  each Stock Round seat passes -- until `stop` says so. `extra` may inject one message at a labelled moment. */
function play(
  room: ReturnType<typeof S.hostedRoom>,
  stop: (state: GameStateResponse) => boolean,
  inject: (state: GameStateResponse) => { actor: string; msg: unknown } | null = () => null,
  limit = 400,
): Played[] {
  const played: Played[] = [];
  for (let guard = 0; !stop(room.state); guard += 1) {
    if (guard > limit) throw new Error("the game did not reach the stop condition");
    const state = room.state;
    const injected = inject(state);
    let actor: string;
    let msg: unknown;
    if (injected) {
      ({ actor, msg } = injected);
    } else if (state.current_round_type === "StockRound") {
      actor = state.player_addresses[state.active_player_index];
      msg = S.PASS;
    } else {
      const id = state.active_operating_order[state.active_corporation_index];
      actor = companyOf(state, id).president!;
      msg = state.operating_sub_phase === "Track" ? S.advance(id) : S.PASS;
    }
    const answer = S.submitTo(room, actor, msg as never);
    if (answer.kind !== "applied") throw new Error(`refused at macro ${state.macro_round_number}.${state.sub_round_index}: ${answer.reason}`);
    played.push({ label: `${state.current_round_type} ${state.macro_round_number}.${state.sub_round_index}`, kind: Object.keys(msg as object)[0], msg, before: state, after: room.state });
  }
  return played;
}

describe("OD-UR-2: trigger in set N, survive all of N+1, gone at the end of N+1 (hosted)", () => {
  const room = S.hostedRoom(start(), ALBANY, [1]);
  let bought = false;
  const played = play(
    room,
    (state) => state.current_round_type === "StockRound" && state.macro_round_number === 7,
    (state) => {
      // OR 5.1, NYC's Buy Trains: the first REAL Diesel -- the doom trigger (the gilded 6 already exists).
      if (!bought && state.current_round_type === "OperatingRound" && state.operating_sub_phase === "Hardware" &&
          state.active_operating_order[state.active_corporation_index] === NYC) {
        bought = true;
        return { actor: P2, msg: S.buy(NYC, "D") };
      }
      return null;
    },
  );
  const trigger = played.find((step) => step.kind === "BuyHardwareFromPool")!;

  it("the first real Diesel in set 5 starts the clock with deadline 6 -- and the train is untouched by it", () => {
    expect(trigger.label).toBe("OperatingRound 5.1");
    expect(realDieselPurchased(trigger.after)).toBe(true);
    expect(cpr(trigger.before).carcosan_doom_after_macro_round).toBeUndefined();
    expect(cpr(trigger.after).carcosan_doom_after_macro_round).toBe(6);
    expect(cpr(trigger.after).owned_trains).toEqual(["6"]);
  });

  const lastOfSet = () => played.filter((step) => step.before.current_round_type === "OperatingRound" && step.before.macro_round_number === 6).pop()!;

  it("survives the rest of set N, the Stock Round and EVERY entry of set N+1 -- including the last one's before-board", () => {
    const boundary = played.indexOf(lastOfSet());
    expect(boundary).toBeGreaterThan(20);
    for (const step of played.slice(0, boundary)) {
      expect(gilded(step.after)).toBe(true);
      expect(cpr(step.after).owned_trains).toEqual(["6"]);
    }
    // The walk really crossed the trigger set's end, a Stock Round and set N+1.
    expect(played.slice(0, boundary).some((step) => step.after.current_round_type === "StockRound" && step.after.macro_round_number === 6)).toBe(true);
    // Set N+1 really was a full set of three Operating Rounds, and CPR took a turn in each of them.
    const cprTurns = played.filter((step) => step.before.current_round_type === "OperatingRound" && step.before.macro_round_number === 6 &&
      step.before.active_operating_order[step.before.active_corporation_index] === CPR && step.kind === "AdvanceOperatingSubPhase");
    expect(cprTurns.map((step) => step.before.sub_round_index)).toEqual([1, 2, 3]);
    // Immediately before the boundary the train is there.
    expect(gilded(lastOfSet().before)).toBe(true);
  });

  it("is gone on the transition that ends set N+1 -- not on a run, and without CPR operating again", () => {
    expect(lastOfSet().after.current_round_type).toBe("StockRound");
    expect(lastOfSet().after.macro_round_number).toBe(7);
    const c = cpr(lastOfSet().after);
    expect(c.owned_trains).toEqual([]);
    expect(c.carcosan_trains).toEqual([]);
    expect(c.ghost_trains).toEqual([]); // the provenance leaves with the train (#1675)
    expect(c.carcosan_doom_after_macro_round).toBeUndefined();
    expect(c.is_carcosan).toBe(true); // the curse outlives the train (#1089)
    // Nobody ran in this whole game (a routeless map), so no run collected it.
    expect(played.some((step) => step.kind === "RunMultipleRoutes")).toBe(false);
    expect(room.entries.some((entry) => "YellowSignEvent" in JSON.parse(entry.payload))).toBe(false);
  });

  it("no removal happens anywhere else, and none twice", () => {
    const removals = played.filter((step) => gilded(step.before) && !gilded(step.after));
    expect(removals).toHaveLength(1);
    // And a later boundary finds nothing to take.
    expect(fogIsDue(cpr(room.state), 99)).toBe(false);
  });

  it("the fog is not a rust and not a limit discard: no fleet-loss sentence names it", () => {
    const losses = describeFleetLosses(lastOfSet().before, lastOfSet().after, lastOfSet().msg);
    expect(losses.filter((loss) => loss.companyId === CPR)).toEqual([]);
  });

  it("the synthetic train leaves the depot tally exactly as it entered it -- nothing returns to the shelf", () => {
    const rows = (state: GameStateResponse) => depotInventory(state).map((row) => `${row.tier}:${row.remaining}`).join(" ");
    expect(rows(lastOfSet().after)).toBe(rows(lastOfSet().before));
  });

  it("a restore from the room's log reaches the same board", () => {
    const restored = S.hostedRoom(start(), ALBANY, [1]);
    restored.restore(room.entries as never);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
  });
});

/* ------------------------------------------------------------------ */
/* Focused boards at the boundary itself                              */
/* ------------------------------------------------------------------ */

/** The last turn of set `macro`: B&O is the last corporation of the last Operating Round, in Buy Trains. */
const lastTurn = (macro: number, doom: number | undefined, over: Partial<Parameters<typeof urBoard>[0]> = {}) =>
  urBoard({
    corps: [
      { id: NYC, president: P2, trains: ["D"], treasury: 1000 },
      { id: CPR, president: P3, trains: ["5", "6"], treasury: 400, extra: { ...GILDED_6, ...(doom === undefined ? {} : { carcosan_doom_after_macro_round: doom }) } },
      { id: BO, president: P1, trains: ["5"], treasury: 400 },
    ],
    operating: BO,
    step: "Hardware",
    macro,
    sub: 3,
    sequence: 3,
    ...over,
  });
const endTurn = (state: GameStateResponse) => applySandboxAction(state, S.PASS as never, { mapGrid: ALBANY });

describe("OD-UR-2 at the boundary: exactly the end of N+1", () => {
  it("the end of the trigger set N is not the deadline", () => {
    const after = endTurn(lastTurn(5, 6));
    expect(after.current_round_type).toBe("StockRound");
    expect(cpr(after).owned_trains).toEqual(["5", "6"]);
    expect(cpr(after).carcosan_trains).toEqual(["6"]);
  });

  it("the end of N+1 is: one gilded copy, its gilding and its provenance go; the ordinary 5 stays", () => {
    const after = endTurn(lastTurn(6, 6));
    expect(after.current_round_type).toBe("StockRound");
    expect(after.macro_round_number).toBe(7);
    expect(cpr(after).owned_trains).toEqual(["5"]);
    expect(cpr(after).carcosan_trains).toEqual([]);
    expect(cpr(after).ghost_trains).toEqual([]);
    expect(cpr(after).carcosan_doom_after_macro_round).toBeUndefined();
    expect(cpr(after).is_carcosan).toBe(true);
  });

  it("multiset: beside an ordinary 6 of the same model, exactly one 6 goes", () => {
    const board = lastTurn(6, 6);
    const twoSixes = { ...board, public_companies: board.public_companies.map((c) => (c.company_id === CPR ? { ...c, owned_trains: ["6", "6"] } : c)) } as GameStateResponse;
    const after = endTurn(twoSixes);
    expect(cpr(after).owned_trains).toEqual(["6"]);
    expect(cpr(after).carcosan_trains).toEqual([]);
    expect(cpr(after).ghost_trains).toEqual([]);
  });

  it("a corporation that is not operating at all in N+1 still loses the train at its end", () => {
    // CPR has no president (nobody holds its shares), so it is not in the operating order -- it never runs.
    const board = lastTurn(6, 6, {
      corps: [
        { id: NYC, president: P2, trains: ["D"], treasury: 1000 },
        { id: CPR, president: null, trains: ["6"], treasury: 400, extra: { ...GILDED_6, carcosan_doom_after_macro_round: 6 } },
        { id: BO, president: P1, trains: ["5"], treasury: 400 },
      ],
    });
    expect(board.active_operating_order).not.toContain(CPR);
    const after = endTurn(board);
    expect(cpr(after).owned_trains).toEqual([]);
    expect(cpr(after).carcosan_trains).toEqual([]);
  });

  it("a clock that has not started (no real Diesel yet) takes nothing, however many sets pass", () => {
    for (const macro of [5, 6, 9]) {
      const after = endTurn(lastTurn(macro, undefined));
      expect(cpr(after).owned_trains).toEqual(["5", "6"]);
    }
  });

  it("when the bank has broken, the game ends at that same boundary and the train is still gone", () => {
    const broken = lastTurn(6, 6, { bank: 0 });
    const after = endTurn(broken);
    expect(after.current_round_type).toBe("GameEnd");
    expect(cpr(after).carcosan_trains).toEqual([]);
    expect(cpr(after).owned_trains).toEqual(["5"]);
  });

  it("a train that already left by a Blood Price is not chased: the boundary acts only on the gilding that exists", () => {
    /* The sale is settled by the production helper the reducer's arm uses (`settleTrainSale`, #1090 as implemented
       today -- OD-UR-5 is OPEN and not decided here). Whatever the sale leaves gilded is what the boundary removes;
       under the current implementation that is nothing, and no orphan marker is created. */
    const board = lastTurn(6, 6);
    const sold = settleTrainSale(board, BO, CPR, "6", "300");
    const after = endTurn(sold);
    expect(cpr(after).carcosan_trains ?? []).toEqual([]);
    expect(cpr(after).owned_trains).toEqual(["5"]);
    expect(companyOf(after, BO).owned_trains).toEqual(companyOf(sold, BO).owned_trains);
    expect(companyOf(after, BO).carcosan_trains ?? []).toEqual(companyOf(sold, BO).carcosan_trains ?? []);
  });

  it("the fog is not a run stage any more: a run after the deadline collects nothing and a request is refused", () => {
    // A board that (by construction) still holds an overdue gilded train: neither the run nor a request may take it.
    const overdue = urBoard({
      corps: [
        { id: S.CO, president: P1, trains: ["5", "6"], treasury: 300, extra: { ...GILDED_6, carcosan_doom_after_macro_round: 4 } },
        { id: NYC, president: P2, trains: ["D"] },
      ],
      macro: 6,
    });
    const seed = S.seedWhere((s) => S.isQuietDraw(90, S.partsFor(s, 6)));
    const ran = applySandboxAction(overdue, S.runMsg(S.CO, [S.LONG_ROUTE], [1], ["6"], seed) as never, { mapGrid: S.GULF, era: "Yellow" });
    expect(companyOf(ran, S.CO).carcosan_trains).toEqual(["6"]);
    const asked = applySandboxAction(ran, S.signRequest(S.CO) as never, { mapGrid: S.GULF, era: "Yellow" });
    expect(stateDigest(asked)).toBe(stateDigest(ran));
  });
});
