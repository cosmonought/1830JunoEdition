/** @jest-environment node */
//
// ==================================================================
//  UR-3 (OD-UR-13 -- DECIDED 2026-09-24): THE MARK'S TRAIN LEAVES THE GAME, AND THE PHASE NEVER FALLS BACK
// ==================================================================
//
// OWNER RULING (VARIANT_CERT_UNPREDICTABLE_REVENUE_AUDIT_2026-09-24.md, OD-UR-13; backlog D-46):
//   "A train taken by the Yellow Sign Mark is PERMANENTLY REMOVED FROM THE GAME. It does NOT: return to the depot;
//    enter the Bank Pool; become purchasable again; increase available depot stock. The corporation still receives
//    the already-decided Mark award under OD-UR-4."
//   "PHASE PROGRESSION IS MONOTONIC. Once a phase has been reached by the qualifying REAL train purchase, later
//    removal of trains cannot lower the phase, reopen an earlier train tier, undo rust, undo Gentle Rust effects,
//    close a depot shelf, or reverse an 18XX+ era transition."
//
// UR-F19, the defect: the depot is derived (`TOTAL - owned - pooled` for the current tier) and the phase is "the
// highest tier owned or pooled", so the run-bound Mark -- which takes the train out of `owned_trains` and put it
// nowhere -- handed the taken copy back to the depot as stock and, when it was the only train of the phase's tier in
// play, took the phase down a tier with it (phase 3 -> 2, the depot selling 2-trains again). The fix is a durable
// record on the board, `removed_trains`, written by the run's own entry; `derivePhase` / `depotInventory` read it as
// they read the Bank Pool for the phase (#1530) and the supply (#1512), and it is never a place a train can be bought.
//
// THE STATISTICS HALF (case 8, `taken`) is in `yellowSignRunBoundStats.test.ts`, which carries the history harness.
// Every case goes through production authority: the reducer with the map grid a server holds, and `RoomSession`.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const YS = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const GP = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { purchasableTrains, bankPoolTrains } = require("../gameEngine/trainAvailability") as typeof import("../gameEngine/trainAvailability");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { SERVER_REPLAY_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");

const { CO, BO, P1, P2, GULF, LONG_ROUTE, R, urBoard, runMsg, companyOf, partsFor } = S;

const CTX = { mapGrid: GULF, era: "Yellow" } as const;
const apply = (state: GameStateResponse, msg: unknown) => applySandboxAction(state, msg as never, CTX);
const co = (state: GameStateResponse) => companyOf(state, CO);
const row = (state: GameStateResponse, tier: string) => GP.depotInventory(state).find((entry) => entry.tier === tier)!;
const openTiers = (state: GameStateResponse) => GP.openDepotTiers(state).map((entry) => entry.tier);
const currentLimit = (state: GameStateResponse) => GP.depotInventory(state).find((entry) => entry.isCurrent)!.trainLimit;
/** The same board with the removal record dropped: what the depot and the phase read before OD-UR-13 (UR-F19). */
const withoutRecord = (state: GameStateResponse) => ({ ...state, removed_trains: undefined }) as GameStateResponse;

/* ---- phase 3: C&O holds the ONLY 3-train in play (B&O runs 2s; the 2s are sold out by the queue rule) ---- */

/** A 3-train's best from C&O's home I5 on the Gulf line: J2 ($30) - I3 - I5 ($20) - I7 ($20) = $70. */
const THREE_GULF = R("J2", "I3", "I5", "I7");
const phase3 = (over: Partial<Parameters<typeof urBoard>[0]> = {}) =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["3"], treasury: 300 },
      { id: BO, president: P2, trains: ["2", "2"], treasury: 300 },
    ],
    ...over,
  });
const RUN3 = (seed?: number) => runMsg(CO, [THREE_GULF], [0], ["3"], seed);
const MARK_70 = S.seedWhere((seed) => S.isMarkDraw(70, partsFor(seed)));

/* ---- phase 4: C&O holds the ONLY 4-train (the first 4 rusted the 2s; B&O runs 3s, which the 4s sold out) ---- */

const phase4 = (over: Partial<Parameters<typeof urBoard>[0]> = {}) =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["4"], treasury: 300 },
      { id: BO, president: P2, trains: ["3", "3"], treasury: 300 },
    ],
    ...over,
  });
const RUN4 = (seed?: number) => runMsg(CO, [LONG_ROUTE], [0], ["4"], seed);
const MARK_90 = S.seedWhere((seed) => S.isMarkDraw(90, partsFor(seed)));

const buyFromPool = (companyId: number, model: string) =>
  ({ BuyHardwareFromPool: { game_id: 1, protocol_id: companyId, returned_model_type: model } }) as never;

/** The Mark's run, then C&O's turn carried to its Buy Trains step: the forced withhold a trainless corporation owes at
 *  Dividends (#1275) is declared as the room would derive it. */
function toHardware(board: GameStateResponse, run: unknown): GameStateResponse {
  const ran = apply(board, run);
  const declared = apply(ran, S.declare(CO, Number(co(ran).last_route_revenue ?? 0)));
  expect(declared.operating_sub_phase).toBe("Hardware");
  return declared;
}

describe("OD-UR-13: the Mark takes the only train of the phase's tier in play (case 1)", () => {
  it("the run's entry takes C&O's 3, pays half of it, and writes the removal on the board -- not in the Bank Pool", () => {
    const before = phase3();
    // The premise: C&O's 3 is the only 3 anybody holds, and the phase is 3 because of it.
    expect(before.public_companies.flatMap((c) => c.owned_trains ?? []).filter((m) => m === "3")).toEqual(["3"]);
    expect(GP.derivePhase(before)!.tier).toBe("3");
    const after = apply(before, RUN3(MARK_70));
    const c = co(after);
    expect(c.owned_trains).toEqual([]);
    expect(c.has_yellow_sign).toBe(true);
    expect(Number(c.treasury)).toBe(300 + YS.markPayout("3")); // OD-UR-4's award stands: $90, minted
    expect(after.virtual_bank_vgp).toBe(before.virtual_bank_vgp);
    expect(c.last_run_yellow_sign).toEqual({
      stage: "mark",
      model: "3",
      award: String(YS.markPayout("3")),
      nullified: { train_index: 0, model: "3", printed_revenue: "70" },
    });
    // Removed from the game: one entry, the taken model -- and NOT the Bank Pool.
    expect(after.removed_trains).toEqual(["3"]);
    expect(after.returned_trains).toEqual([]);
    expect(after.public_companies.flatMap((co2) => co2.owned_trains ?? []).filter((m) => m === "3")).toEqual([]);
  });
});

describe("OD-UR-13: PHASE PROGRESSION IS MONOTONIC across the Mark (case 2)", () => {
  it("phase 3 stays phase 3 -- label, era and limit -- although no 3-train is left in play", () => {
    const before = phase3();
    const after = apply(before, RUN3(MARK_70));
    expect(GP.derivePhase(after)!.tier).toBe("3");
    expect(GP.derivePhase(after)!.label).toBe(GP.derivePhase(before)!.label);
    expect(currentLimit(after)).toBe(currentLimit(before));
    /* The era is settled from the phase after every entry (#657) -- in the reducer's chain BEFORE the run's Sign -- so
       the entry after the Mark is where a fallen phase would show: it stays Green. */
    const declare = (state: GameStateResponse) => apply(state, S.declare(CO, Number(co(state).last_route_revenue ?? 0)));
    expect(after.current_global_era).toBe("Green");
    expect(declare(after).current_global_era).toBe("Green");
    // The record is what holds it: the same board without it reads the regression UR-F19 reported.
    expect(GP.derivePhase(withoutRecord(after))!.tier).toBe("2");
    expect(declare(withoutRecord(after)).current_global_era).toBe("Yellow");
  });

  it("phase 4 stays phase 4: the 2s stay rusted and the limit stays 3 (the rust and the limit do not come undone)", () => {
    const before = phase4();
    expect(GP.derivePhase(before)!.tier).toBe("4");
    const after = apply(before, RUN4(MARK_90));
    expect(co(after).owned_trains).toEqual([]);
    expect(after.removed_trains).toEqual(["4"]);
    expect(Number(co(after).treasury)).toBe(300 + YS.markPayout("4"));
    expect(GP.derivePhase(after)!.tier).toBe("4");
    expect(row(after, "2").rusted).toBe(true);
    expect(currentLimit(after)).toBe(3);
    // Without the record: phase 3, the 2s un-rusted in the depot's reading, the limit back to 4.
    expect(GP.derivePhase(withoutRecord(after))!.tier).toBe("3");
    expect(row(withoutRecord(after), "2").rusted).toBe(false);
    expect(currentLimit(withoutRecord(after))).toBe(4);
  });

  it("the next REAL train of the tier is an ordinary purchase, not a second arrival of the phase", () => {
    /* A phase change is a purchase that moves `derivePhase` (#1861: rust, marks, limit, era). Had the Mark dropped the
       phase, C&O's own replacement 4 would have re-entered phase 4 and re-fired every consequence of it. */
    const hardware = toHardware(phase4(), RUN4(MARK_90));
    const bought = apply(hardware, S.buy(CO));
    expect(co(bought).owned_trains).toEqual(["4"]);
    expect(GP.derivePhase(bought)!.tier).toBe("4");
    expect(GP.derivePhase(hardware)!.tier).toBe(GP.derivePhase(bought)!.tier);
    expect(bought.removed_trains).toEqual(["4"]);
    expect(companyOf(bought, BO).owned_trains).toEqual(["3", "3"]); // phase 4 does not rust 3s, and nothing re-fired
  });
});

describe("OD-UR-13: an earlier depot tier does not reopen (case 3)", () => {
  it("phase 3: the depot still sells 3-trains and never 2-trains", () => {
    const before = phase3();
    const after = apply(before, RUN3(MARK_70));
    expect(openTiers(before)).toEqual(["3"]);
    expect(openTiers(after)).toEqual(["3"]);
    expect(row(after, "2").remaining).toBe(0);
    expect(row(after, "2").soldOut).toBe(true);
    // Without the record the depot offered 2-trains again (UR-F19).
    expect(openTiers(withoutRecord(after))).toEqual(["2"]);
  });

  it("phase 4: the 3s the first 4 sold out stay sold out", () => {
    const after = apply(phase4(), RUN4(MARK_90));
    expect(openTiers(after)).toEqual(["4"]);
    expect(row(after, "3").remaining).toBe(0);
    expect(openTiers(withoutRecord(after))).toEqual(["3"]);
  });

  it("after the Mark a 2-train asked for by name is not on the shelf (#1326) and buys nothing; the purchase is a 3", () => {
    const hardware = toHardware(phase3(), RUN3(MARK_70));
    expect(stateDigest(apply(hardware, S.buy(CO, "2")))).toBe(stateDigest(hardware));
    const bought = apply(hardware, S.buy(CO));
    expect(co(bought).owned_trains).toEqual(["3"]);
    expect(Number(co(bought).treasury)).toBe(Number(co(hardware).treasury) - GP.DEPOT_COST["3"]);
    // Without the record the same request bought a 2 for $80 (UR-F19).
    expect(co(apply(withoutRecord(hardware), S.buy(CO, "2"))).owned_trains).toEqual(["2"]);
  });
});

describe("OD-UR-13: the taken train is never purchasable again (case 4)", () => {
  it("it is not in the Bank Pool and not on sale anywhere", () => {
    const after = apply(phase3(), RUN3(MARK_70));
    expect(bankPoolTrains(after)).toEqual([]);
    expect(purchasableTrains(after)).toEqual([{ source: "depot", tier: "3", cost: GP.DEPOT_COST["3"], remaining: 4 }]);
  });

  it("a Bank Pool purchase of the taken model changes nothing -- in the reducer and at a hosted room's ingress", () => {
    const hardware = toHardware(phase3(), RUN3(MARK_70));
    expect(stateDigest(apply(hardware, buyFromPool(CO, "3")))).toBe(stateDigest(hardware));
    const room = S.hostedRoom(phase3(), GULF, [MARK_70]);
    expect(S.submitTo(room, P1, RUN3()).kind).toBe("applied");
    if (room.state.operating_sub_phase === "Dividends") {
      expect(S.submitTo(room, P1, S.declare(CO, Number(co(room.state).last_route_revenue ?? 0))).kind).toBe("applied");
    }
    expect(room.state.operating_sub_phase).toBe("Hardware");
    const settled = stateDigest(room.state);
    const entries = room.entries.length;
    expect(S.submitTo(room, P1, buyFromPool(CO, "3") as never).kind).toBe("refused");
    expect(stateDigest(room.state)).toBe(settled);
    expect(room.entries).toHaveLength(entries);
  });

  it("the ordinary purchase comes off the depot's printed stock, and the taken copy stays removed", () => {
    const hardware = toHardware(phase3(), RUN3(MARK_70));
    const bought = apply(hardware, S.buy(CO));
    expect(co(bought).owned_trains).toEqual(["3"]);
    expect(bought.removed_trains).toEqual(["3"]);
    expect(bought.returned_trains).toEqual([]);
    // 5 printed: the first (taken) and this one are both gone from the shelf.
    expect(row(bought, "3").remaining).toBe(3);
  });
});

describe("OD-UR-13: depot stock does not grow by the taken copy (case 5)", () => {
  it("phase 3: the 3-row reads 4 before and after -- not 5", () => {
    const before = phase3();
    const after = apply(before, RUN3(MARK_70));
    expect(row(before, "3").remaining).toBe(4);
    expect(row(after, "3").remaining).toBe(4);
    expect(GP.derivePhase(after)!.depotRemaining).toBe(4);
    expect(GP.derivePhase(after)!.purchasesUntilPhaseChange).toBe(GP.derivePhase(before)!.purchasesUntilPhaseChange);
    expect(row(withoutRecord(after), "3").remaining).toBe(5);
  });

  it("phase 4: the 4-row reads 3 before and after", () => {
    const before = phase4();
    const after = apply(before, RUN4(MARK_90));
    expect(row(before, "4").remaining).toBe(3);
    expect(row(after, "4").remaining).toBe(3);
  });

  it("the Gentle Rust table reads the same supply and phase (the Mark's window is the same)", () => {
    const after = apply(phase3({ gentle: true }), RUN3(MARK_70));
    expect(after.removed_trains).toEqual(["3"]);
    expect(GP.derivePhase(after)!.tier).toBe("3");
    expect(row(after, "3").remaining).toBe(4);
  });
});

describe("OD-UR-13: replay reproduces the removal (case 6)", () => {
  const restoredFrom = (room: InstanceType<typeof RoomSession>, seed: GameStateResponse) => {
    const restored = new RoomSession({
      providers: S.roomProviders(seed, GULF),
      seed: { state: seed, waterfall: null },
      build: "ur3",
      mintId: () => "x",
      mintSeed: () => {
        throw new Error("a restore must never draw");
      },
    });
    restored.restore(room.entries as never);
    return restored;
  };

  it("hosted: the run's entry carries the removal; a replay and a restore of the log reach the same board and never draw", () => {
    const room = S.hostedRoom(phase3(), GULF, [MARK_70]);
    expect(S.submitTo(room, P1, RUN3(987654321)).kind).toBe("applied"); // the server's draw replaces the client's
    expect(room.state.removed_trains).toEqual(["3"]);
    expect(GP.derivePhase(room.state)!.tier).toBe("3");
    // Carry the turn on: the purchase after the Mark is in the log too.
    if (room.state.operating_sub_phase === "Dividends") {
      expect(S.submitTo(room, P1, S.declare(CO, Number(co(room.state).last_route_revenue ?? 0))).kind).toBe("applied");
    }
    expect(S.submitTo(room, P1, S.buy(CO)).kind).toBe("applied");
    expect(co(room.state).owned_trains).toEqual(["3"]);
    expect(row(room.state, "3").remaining).toBe(3);
    const replayed = replayLog(
      room.entries.map((entry) => ({ index: entry.index, id: entry.id, actor: entry.actor, payload: entry.payload })),
      S.roomProviders(phase3(), GULF),
      { state: phase3(), waterfall: null },
      undefined,
      SERVER_REPLAY_POLICY,
    );
    expect(stateDigest(replayed.state)).toBe(stateDigest(room.state));
    expect(replayed.state.removed_trains).toEqual(["3"]);
    expect(GP.derivePhase(replayed.state)!.tier).toBe("3");
    const restored = restoredFrom(room, phase3());
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
    expect(restored.state.removed_trains).toEqual(["3"]);
  });

  it("an undo past the run takes the removal back with it, and the same run again removes the same train once", () => {
    const room = S.hostedRoom(phase3(), GULF, [MARK_70, 42]);
    expect(S.submitTo(room, P1, RUN3()).kind).toBe("applied");
    const marked = stateDigest(room.state);
    expect(S.submitTo(room, P1, { RevertTo: { index: 0, player: P1, summary: "undo" } } as never).kind).toBe("applied");
    expect(room.state.removed_trains).toBeUndefined();
    expect(co(room.state).owned_trains).toEqual(["3"]);
    expect(S.submitTo(room, P1, RUN3()).kind).toBe("applied");
    expect(stateDigest(room.state)).toBe(marked); // #1051: the draw is reused, so the same Mark, once
    expect(room.state.removed_trains).toEqual(["3"]);
  });
});

describe("OD-UR-13: standard mode, and every board without the run-bound Mark, is unaffected (case 7)", () => {
  it("variant off: the same run on the same seed takes nothing and writes no removal (no field at all, #232)", () => {
    const before = phase3({ ur: false });
    const after = apply(before, RUN3(MARK_70));
    expect(co(after).owned_trains).toEqual(["3"]);
    expect(co(after).last_route_revenue).toBe("70");
    expect("removed_trains" in after).toBe(false);
    expect(GP.derivePhase(after)!.tier).toBe("3");
    expect(row(after, "3").remaining).toBe(4);
  });

  it("variant off: a whole turn to a purchase writes no removal, and the depot and phase read as before", () => {
    const before = phase3({ ur: false });
    const ran = apply(before, RUN3(MARK_70));
    const declared = apply(ran, S.declare(CO, 70));
    const bought = apply(declared, S.buy(CO));
    for (const state of [ran, declared, bought]) expect("removed_trains" in state).toBe(false);
    expect(co(bought).owned_trains).toEqual(["3", "3"]);
    expect(row(bought, "3").remaining).toBe(3);
  });

  it("a board that never carries the field reads exactly what it read before OD-UR-13", () => {
    /* `removedTrainsByTier` is empty on every such board, so `derivePhase` / `depotInventory` answer as they always
       did -- the standard game, a quiet Unpredictable Revenue run, and an unpinned board alike. */
    for (const board of [phase3({ ur: false }), phase4({ ur: false }), phase3(), phase4(), phase3({ pinned: false })]) {
      expect(GP.removedTrainsByTier(board).size).toBe(0);
      expect(GP.derivePhase(board)).toEqual(GP.derivePhase(withoutRecord(board)));
      expect(GP.depotInventory(board)).toEqual(GP.depotInventory(withoutRecord(board)));
    }
    const quiet = S.seedWhere((seed) => S.isQuietDraw(70, partsFor(seed)));
    expect("removed_trains" in apply(phase3(), RUN3(quiet))).toBe(false);
  });

  it("an unpinned board's stored Mark (#1661's legacy branch) replays as it was played -- no removal record is invented", () => {
    /* The development corpus's stored `YellowSignEvent` entries must rebuild the boards they were played on, so the
       legacy branch is untouched: it takes the train and writes nothing new. Only the run-bound Mark of a pinned table
       writes `removed_trains` (the unpinned residual is recorded in the audit, "UR-3 implementation (rev 3)"). */
    const unpinned = phase3({ pinned: false });
    const ran = apply(unpinned, RUN3(MARK_70));
    expect(co(ran).owned_trains).toEqual(["3"]); // an unpinned run draws no stage (OD-UR-1 binds pinned tables)
    const stored = apply(ran, S.signRequest(CO, { stage: "mark", model: "3", cash: String(YS.markPayout("3")) }));
    expect(co(stored).owned_trains).toEqual([]);
    expect("removed_trains" in stored).toBe(false);
  });
});
