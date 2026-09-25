/** @jest-environment node */
//
// ==================================================================
//  UR-3 (harness): THE STATISTICS FIND THE SIGN WHERE IT NOW HAPPENS -- AND COUNT IT AS THEY ALWAYS DID
// ==================================================================
//
// UR-3 moves the Yellow Sign's stages off a client `YellowSignEvent` entry: on a pinned table the Mark and the gift
// ride the run's own entry (OD-UR-1), and the fog falls on the entry that ends an Operating-Round set (OD-UR-2). The
// end-of-game statistics read the log, so they must find the stages there -- and OD-UR-6 (what the statistics SHOULD
// count) is OPEN, so what they count must not move:
//   * a Mark's train is `taken` (#1431), never rusted or discarded, and never confused with the Gentle Rust Final Run
//     train the same entry retires (the record names it, not a fleet diff);
//   * the stage lands on its bearer for the Carcosan Railways accolade (#1421), as the request's entry did;
//   * the run's figures (lifetime revenue, the ledger's earnings) keep their basis -- the run as priced at its own
//     entry, in full -- exactly what they booked when the Mark was a later entry of its own;
//   * the boundary fog's gilded train is `taken` and the fog is a stage on its bearer;
//   * a gift above the phase is not the phase, so nobody is credited with rushing it (OD-UR-3).
//
// THE BOARDS ARE THE REDUCER'S OWN (`applySandboxAction` on UR-3's constructed boards); as in GR-3 / GR-4's stats
// harnesses the history's replay engine is replaced by a script of those boards, and nothing else in `gameHistory.ts`
// is stubbed. Each script opens one board earlier with the subject's trains not yet on its roster and a neutral entry
// that delivers them, so the fleet ledger has the rows (GR-3's device).

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

let mockScript: GameStateResponse[] | null = null;

jest.mock("../gameEngine/replayLog", () => {
  const actual = jest.requireActual("../gameEngine/replayLog");
  function RoomEngine(this: unknown, ...args: unknown[]) {
    if (mockScript === null) return new actual.RoomEngine(...args);
    return { snapshot: { state: mockScript[0], grid: { game_id: 1, tiles: [] } } };
  }
  function LegacyLogAdapters(this: unknown, ...args: unknown[]) {
    if (mockScript === null) return new actual.LegacyLogAdapters(...args);
    return {
      apply(engine: { snapshot: { state: GameStateResponse; grid: unknown } }, entry: { index: number }) {
        engine.snapshot = { ...engine.snapshot, state: mockScript![entry.index + 1] };
      },
    };
  }
  return { ...actual, RoomEngine, LegacyLogAdapters };
});

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { derivePhase } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const YS = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const { gameHistoryFrom } = require("./gameHistory") as typeof import("./gameHistory");

const { CO, BO, NYC, CPR, P1, P2, P3, GULF, TWO_ROUTE, THREE_ROUTE, LONG_ROUTE, urBoard, runMsg, partsFor, companyOf } = S;

type Entry = { index: number; id: string; actor: string | null; payload: string; derived?: boolean };
type History = ReturnType<typeof gameHistoryFrom>;

const CTX = { mapGrid: GULF, era: "Yellow" } as const;
const apply = (state: GameStateResponse, msg: unknown) => applySandboxAction(state, msg as never, CTX);

/** The history of `[seed -> board -> after]`: a neutral entry that puts `subject`'s fleet on its roster, then `msg`.
 *  `seedActor` is the neutral entry's (default: `actor`); `null` when delivering the fleet would itself turn the phase,
 *  so that the deal's phase is nobody's purchase (as the Phase Rusher reads the real deal). */
function historyOf(
  board: GameStateResponse,
  subject: number,
  msg: unknown,
  actor: string,
  after: GameStateResponse,
  seedActor: string | null = actor,
): History {
  const seed = {
    ...board,
    public_companies: board.public_companies.map((c) => (c.company_id === subject ? { ...c, owned_trains: [] } : c)),
  } as GameStateResponse;
  const entries: Entry[] = [
    { index: 0, id: "ur3-seed", actor: seedActor, payload: JSON.stringify({ UR3LedgerSeed: {} }) },
    { index: 1, id: "ur3-entry", actor, payload: JSON.stringify(msg) },
  ];
  mockScript = [seed, board, after];
  try {
    return gameHistoryFrom(entries.map((e) => ({ ...e, derived: false })) as never);
  } finally {
    mockScript = null;
  }
}

const accolade = (history: History, key: string) => history.accolades.find((entry) => entry.key === key)!;
const top = (history: History, key: string) => [accolade(history, key).holder, accolade(history, key).value, accolade(history, key).runnerUp];
const autopsyOf = (history: History, companyId: number) => history.autopsy.find((row) => row.companyId === companyId)!;
const ledger = (history: History, companyId: number, model: string) =>
  autopsyOf(history, companyId).fleetLedger.find((row) => row.model === model);

const MARK_110 = S.seedWhere((seed) => S.isMarkDraw(110, partsFor(seed)));

describe("the Mark, applied by the run's own entry", () => {
  const board = urBoard({
    corps: [
      { id: CO, president: P1, trains: ["2", "3"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"], treasury: 300 },
    ],
  });
  const msg = runMsg(CO, [TWO_ROUTE, THREE_ROUTE], [0, 1], ["2", "3"], MARK_110);
  const after = apply(board, msg);
  const history = historyOf(board, CO, msg, P1, after);

  it("the board is the run-bound Mark (the premise)", () => {
    expect(companyOf(after, CO).last_run_yellow_sign?.stage).toBe("mark");
    expect(companyOf(after, CO).owned_trains).toEqual(["3"]);
  });

  it("the 2 is 'taken' -- not rusted, not discarded -- and the 3 is kept", () => {
    expect(ledger(history, CO, "2")?.fates).toEqual({ rusted: 0, discarded: 0, sold: 0, traded: 0, taken: 1, kept: 0 });
    expect(ledger(history, CO, "3")?.fates).toMatchObject({ taken: 0, kept: 1 });
    expect(top(history, "rust-belt")).toEqual([null, 0, null]);
    expect(top(history, "gravedigger")).toEqual([null, 0, null]);
  });

  it("the stage lands on C&O's president for Carcosan Railways, as the request's entry did", () => {
    const carcosan = accolade(history, "carcosan-railways");
    expect([carcosan.holder, carcosan.value]).toEqual([P1, 1]);
    expect(carcosan.detail).toBe("Marked by an Outer God");
  });

  it("the run's figures keep their basis: $110 printed in full, $50 to the 2 and $60 to the 3 (OD-UR-6 is open)", () => {
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(110);
    expect(ledger(history, CO, "2")?.earned).toBe(50);
    expect(ledger(history, CO, "3")?.earned).toBe(60);
  });
});

describe("the Mark and a Gentle Rust Final Run in ONE entry", () => {
  /* P-C: C&O [2, 3] with the 2 reprieved. The entry retires the 2 (its Final Run is over) and the Mark takes the 3. */
  const board = urBoard({
    gentle: true,
    corps: [
      { id: CO, president: P1, trains: ["2", "3"], treasury: 300, extra: { pending_rust_trains: ["2"] } },
      { id: BO, president: P2, trains: ["4"] },
    ],
  });
  const msg = runMsg(CO, [TWO_ROUTE, THREE_ROUTE], [0, 1], ["2", "3"], MARK_110);
  const after = apply(board, msg);
  const history = historyOf(board, CO, msg, P1, after);

  it("the 2 is rusted at its destruction (U-9) and the 3 is the Sign's: each departure keeps its own fate", () => {
    expect(companyOf(after, CO).owned_trains).toEqual([]);
    expect(ledger(history, CO, "2")?.fates).toMatchObject({ rusted: 1, taken: 0, kept: 0 });
    expect(ledger(history, CO, "3")?.fates).toMatchObject({ rusted: 0, discarded: 0, taken: 1, kept: 0 });
    // The Rust Belt books only the retired 2 ($80) against C&O's president -- never the Sign's 3.
    expect(top(history, "rust-belt")).toEqual([P1, 80, null]);
  });

  it("the run keeps its full basis -- both routes, as they were priced at the run", () => {
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(110);
    expect(ledger(history, CO, "3")?.earned).toBe(60);
  });
});

describe("Carcosa's gift above the phase, at the run", () => {
  const board = urBoard({
    corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 300, extra: { has_yellow_sign: true } },
      { id: BO, president: P2, trains: ["5", "5"] },
      { id: NYC, president: P3, trains: ["3"] },
    ],
  });
  const seed = S.seedWhere((s) => S.isCarcosaDraw(90, partsFor(s)));
  const msg = runMsg(CO, [LONG_ROUTE], [0], ["5"], seed);
  const after = apply(board, msg);
  const history = historyOf(board, CO, msg, P1, after);

  it("the gift is a 6 while the phase stays 5 (the premise)", () => {
    expect(companyOf(after, CO).last_run_yellow_sign).toEqual({ stage: "carcosa", model: "6", award: "0", nullified: null });
    expect(derivePhase(after)!.tier).toBe("5");
  });

  it("nobody rushed a phase (OD-UR-3), and the stage lands on the bearer", () => {
    expect(top(history, "phase-rusher")).toEqual([null, 0, null]);
    const carcosan = accolade(history, "carcosan-railways");
    expect([carcosan.holder, carcosan.value, carcosan.detail]).toEqual([P1, 1, "Rode off into the Fog"]);
  });
});

describe("the fog at the end of set N+1", () => {
  const GILDED_6 = { is_carcosan: true, carcosan_trains: ["6"], ghost_trains: ["6"], carcosan_doom_after_macro_round: 6 };
  const board = urBoard({
    corps: [
      { id: NYC, president: P2, trains: ["D"], treasury: 1000 },
      { id: CPR, president: P3, trains: ["5", "6"], treasury: 400, extra: GILDED_6 },
      { id: BO, president: P1, trains: ["5"], treasury: 400 },
    ],
    operating: BO,
    step: "Hardware",
    macro: 6,
    sub: 3,
    sequence: 3,
  });
  const after = applySandboxAction(board, S.PASS as never);
  const history = historyOf(board, CPR, S.PASS, P1, after);

  it("the set ended and the gilded 6 went (the premise)", () => {
    expect(after.current_round_type).toBe("StockRound");
    expect(companyOf(after, CPR).owned_trains).toEqual(["5"]);
    expect(YS.describeFogAtSetEnd(board, after)).toEqual([{ companyId: CPR, ticker: "CPR", models: ["6"] }]);
  });

  it("the gilded 6 is 'taken', not rusted; the ordinary 5 is kept; the fog is a stage on CPR's president", () => {
    expect(ledger(history, CPR, "6")?.fates).toMatchObject({ rusted: 0, discarded: 0, taken: 1, kept: 0 });
    expect(ledger(history, CPR, "5")?.fates).toMatchObject({ kept: 1 });
    expect(top(history, "rust-belt")).toEqual([null, 0, null]);
    const carcosan = accolade(history, "carcosan-railways");
    expect([carcosan.holder, carcosan.value, carcosan.detail]).toEqual([P3, 1, "Rode off into the Fog"]);
  });
});

describe("OD-UR-13: the Mark takes the only 3 in play -- still `taken`, and the phase it leaves behind is nobody's move", () => {
  /* The board OD-UR-13's cases use (`yellowSignMarkRemoval.test.ts`): phase 3 because C&O holds the only 3-train; B&O
     runs 2s. Before OD-UR-13 the Mark dropped the phase to 2, and the history credited the run's actor with a phase move
     ("brought in the 2s") and booked the run as the cause of a rust tier. The 3 must stay `taken` (#1431) either way. */
  const board = urBoard({
    corps: [
      { id: CO, president: P1, trains: ["3"], treasury: 300 },
      { id: BO, president: P2, trains: ["2", "2"], treasury: 300 },
    ],
  });
  const seed = S.seedWhere((s) => S.isMarkDraw(70, partsFor(s)));
  const msg = runMsg(CO, [S.R("J2", "I3", "I5", "I7")], [0], ["3"], seed);
  const after = apply(board, msg);
  const history = historyOf(board, CO, msg, P1, after, null);

  it("the board took the 3 out of the game and kept phase 3 (the premise)", () => {
    expect(companyOf(after, CO).last_run_yellow_sign?.stage).toBe("mark");
    expect(companyOf(after, CO).owned_trains).toEqual([]);
    expect(after.removed_trains).toEqual(["3"]);
    expect(derivePhase(board)!.tier).toBe("3");
    expect(derivePhase(after)!.tier).toBe("3");
  });

  it("the 3 is `taken` -- not rusted, discarded, sold or traded -- and nobody is credited with a phase move", () => {
    expect(ledger(history, CO, "3")?.fates).toEqual({ rusted: 0, discarded: 0, sold: 0, traded: 0, taken: 1, kept: 0 });
    expect(top(history, "phase-rusher")).toEqual([null, 0, null]);
    expect(top(history, "rust-belt")).toEqual([null, 0, null]);
    expect(top(history, "gravedigger")).toEqual([null, 0, null]);
    const carcosan = accolade(history, "carcosan-railways");
    expect([carcosan.holder, carcosan.value, carcosan.detail]).toEqual([P1, 1, "Marked by an Outer God"]);
  });
});
