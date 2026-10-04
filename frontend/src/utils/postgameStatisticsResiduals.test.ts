/** @jest-environment node */
//
// ==================================================================
//  W2-L (PHASE 3): POST-GAME STATISTICS RESIDUALS -- OWNER OD-13 (U-41, U-43 (1)-(4)) AND OD-14(d)
// ==================================================================
//
// OWNER RULINGS (OD-13, approved; OD-14(d)):
//   1. TRAIN-LIMIT DISCARD (U-41). A train actually discarded to satisfy the train limit is fate `discarded` -- not
//      rusted, not traded. The player who loses it takes the Rust Belt loss; the purchase that caused the limit
//      reduction takes the Gravedigger's credit. Gentle Rust's destruction-time accounting is preserved.
//   2. THE SALVAGER (U-43 (1)). A Bank Pool / Diesel purchase that ACTUALLY returns a train as a trade-in counts.
//   3. A REFUSED `RunMultipleRoutes` (U-43 (2)) is not booked as a run merely because it was attempted.
//   4. AN ACCEPTED `RunManualRoute` (U-43 (3)) is in the same derived run history as the equivalent accepted route
//      execution -- and the per-train messages of one turn are one run, never double-counted.
//   5. THE COWBOY (U-43 (4)) counts the line the player actually saw, after every authoritative resolution and
//      replacement -- not a hypothetical line.
//   OD-14(d): the train deliberately returned in the first Diesel's trade-in stays `traded`, never "rusted".
//   And the accolades' tie order -- each tally Map's insertion order -- is preserved.
//
// Derived statistics only (`gameHistory.ts`): every board below is the real reducer's own output unless a case says it
// is a constructed jump. THREE GROUPS, named for the suites they extend: gameHistory (fates, samples, bookings),
// accolades (the awards and their tie order), roundReplay (the scrubbed board agrees with the derived history).
//
// TWO HARNESSES (UR-5's, `unpredictableRevenueStats.test.ts`), both leaving `gameHistory.ts` itself unstubbed:
//   * THE SCRIPT: the history's replay engine is replaced by a script of boards -- `boards[i + 1]` is the board after
//     `steps[i]`, each the reducer's output for its step (or a constructed jump taken by a NEUTRAL step).
//   * THE REPLAY: the engine is the REAL one, seeded with a constructed board, so the history (and the round scrubber)
//     replay a hosted room's actual log through the reducer.

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";

export {};

let mockScript: GameStateResponse[] | null = null;
let mockSeeded: { providers: unknown; seed: { state: GameStateResponse; waterfall: null } } | null = null;

jest.mock("../gameEngine/replayLog", () => {
  const actual = jest.requireActual("../gameEngine/replayLog");
  function RoomEngine(this: unknown, ...args: unknown[]) {
    if (mockScript !== null) return { snapshot: { state: mockScript[0], grid: { game_id: 1, tiles: [] } } };
    if (mockSeeded !== null) return new actual.RoomEngine(mockSeeded.providers, mockSeeded.seed);
    return new actual.RoomEngine(...args);
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

const Y = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const G = require("./gentleRustPresentationSupport") as typeof import("./gentleRustPresentationSupport");
const SS = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const GP = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const GV = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const YS = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const TD = require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { variantCueFor } = require("./variantSfx") as typeof import("./variantSfx");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { sandboxActionContext } = require("../gameEngine/actionContext") as typeof import("../gameEngine/actionContext");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { gameHistoryFrom } = require("./gameHistory") as typeof import("./gameHistory");
const { replaySnapshotAtRound } = require("./roundReplay") as typeof import("./roundReplay");

const { CO, BO, NYC, P1, P2, P3, GULF, TWO_ROUTE, THREE_ROUTE, LONG_ROUTE, urBoard, runMsg, partsFor, companyOf } = Y;

type History = ReturnType<typeof gameHistoryFrom>;
type Msg = Record<string, unknown>;
type Step = { msg: unknown; actor: string | null; derived?: boolean };

/* ------------------------------------------------------------------ */
/* The reducer, messages, and the two harnesses                        */
/* ------------------------------------------------------------------ */

const providers = sandboxReplayProviders();
/** The reducer as a server's engine runs it (the composed context, on the network grid). */
const reduce = (state: GameStateResponse, msg: unknown, actor: string | null = P1) =>
  SS.applySandboxAction(state, msg as never, sandboxActionContext(providers, { state, msg: msg as never, actor, grid: GULF, gridBefore: GULF }));

const NEUTRAL: Msg = { W2LNeutral: {} };
const exchange = (id: number, model: string): Msg => ({ ExchangeTrainForDiesel: { game_id: 1, protocol_id: id, model_type: model } });
const buyPool = (id: number, model: string): Msg => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, returned_model_type: model } });
const manual = (id: number, path: Array<{ hex: string }>): Msg => ({
  RunManualRoute: { game_id: 1, protocol_id: id, path, payout_strategy: "Withhold" },
});

const entriesOf = (steps: Step[]) =>
  steps.map((step, index) => ({
    index,
    id: `w2l-${index}`,
    actor: step.actor,
    payload: JSON.stringify(step.msg),
    derived: step.derived === true,
  }));

function scripted(boards: GameStateResponse[], steps: Step[]): History {
  expect(boards).toHaveLength(steps.length + 1);
  const entries = entriesOf(steps);
  mockScript = boards;
  try {
    return gameHistoryFrom(entries as never);
  } finally {
    mockScript = null;
  }
}

/** A recorder over the real reducer: every step's board is the reducer's answer to the board before it. */
function recorder(start: GameStateResponse, apply: (state: GameStateResponse, msg: unknown, actor: string | null) => GameStateResponse) {
  const boards: GameStateResponse[] = [start];
  const steps: Step[] = [];
  const now = () => boards[boards.length - 1];
  return {
    boards,
    steps,
    now,
    /** Sends `msg` as `actor`; `expect` names whether the reducer must take it or refuse it (by identity, #778). */
    send(msg: unknown, actor: string | null, expect: "applied" | "refused" = "applied") {
      const before = now();
      const after = apply(before, msg, actor);
      if ((stateDigest(after) === stateDigest(before)) !== (expect === "refused")) {
        throw new Error(`expected ${expect}: ${JSON.stringify(msg)} at OR ${before.macro_round_number}.${before.sub_round_index}`);
      }
      steps.push({ msg, actor });
      boards.push(after);
      return after;
    },
    /** A constructed jump: the board `edit` makes of the current one, taken by a NEUTRAL step. */
    jump(edit: (state: GameStateResponse) => GameStateResponse) {
      steps.push({ msg: NEUTRAL, actor: null });
      boards.push(edit(now()));
      return now();
    },
    history: () => scripted(boards, steps),
    /** The round scrubber's board at the end of the round labelled `label` (#1425), over the same script. */
    snapshotAt(label: string) {
      const entries = entriesOf(steps);
      mockScript = boards;
      try {
        const rounds = gameHistoryFrom(entries as never).rounds;
        const at = rounds.findIndex((round) => round.label === label);
        expect(at).toBeGreaterThanOrEqual(0);
        return { rounds, at, snapshot: replaySnapshotAtRound(entries as never, rounds, at)! };
      } finally {
        mockScript = null;
      }
    },
  };
}

/** The script of one corporation's fleet delivered by a neutral first step, so the fleet ledger has its rows. */
const withoutFleet = (board: GameStateResponse, subject: number) =>
  ({ ...board, public_companies: board.public_companies.map((c) => (c.company_id === subject ? { ...c, owned_trains: [] } : c)) }) as GameStateResponse;

/** THE REPLAY HARNESS: a log replayed by the real engine from `seed` on the network grid. */
function replayed<T>(seed: GameStateResponse, read: () => T): T {
  mockSeeded = { providers: Y.roomProviders(seed, GULF), seed: { state: seed, waterfall: null } };
  try {
    return read();
  } finally {
    mockSeeded = null;
  }
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

const accolade = (history: History, key: string) => history.accolades.find((entry) => entry.key === key)!;
const top = (history: History, key: string) => [accolade(history, key).holder, accolade(history, key).value, accolade(history, key).runnerUp];
const autopsyOf = (history: History, companyId: number) => history.autopsy.find((row) => row.companyId === companyId)!;
const ledger = (history: History, companyId: number, model: string) =>
  autopsyOf(history, companyId).fleetLedger.find((row) => row.model === model);
const orRevenue = (history: History, label: string, companyId: number) =>
  history.rounds.find((round) => round.label === label)?.corporations.find((c) => c.companyId === companyId)?.revenue;
const c = (state: GameStateResponse, id: number): PublicCompanyState => companyOf(state, id);
const fleet = (state: GameStateResponse, id: number) => [...(c(state, id).owned_trains ?? [])];
/** The president of the corporation whose turn it is -- the seat that dispatches an Operating Round move. */
const operator = (state: GameStateResponse) => {
  const id = G.acting(state);
  return id === null ? null : (c(state, id).president ?? null);
};

/* ================================================================== */
/* 1. TRAIN-LIMIT DISCARD (U-41)                                       */
/* ================================================================== */

/** The limit drop of `G.discardBoard`, recorded entry by entry (the same moves, the same boards). Phase 3, NYC (P2)
 *  first: NYC buys the first 4 -- every 2 rusts (standard) or is marked (Gentle Rust) -- and two more 4s; B&O (P3) buys
 *  the last 4 and the FIRST 5, which drops the limit to 2 with NYC [4, 4, 4] and B&O [3, 4, 5] over it. */
function limitDrop(gentle: boolean) {
  const r = recorder(
    G.board({
      corps: [
        { id: NYC, trains: ["2", "2"] },
        { id: BO, trains: ["2", "2", "3"] },
        { id: CO, trains: ["3", "3"] },
        { id: G.PRR, trains: ["2", "2", "3", "3"] },
      ],
      operating: NYC,
      gentle,
    }),
    (state, msg, actor) => G.dispatchAs(state, msg as never, actor ?? ""),
  );
  // The ledger rows: NYC's and B&O's fleets are delivered by a neutral first step (GR-3's device).
  const start = r.boards[0];
  r.boards[0] = withoutFleet(withoutFleet(start, NYC), BO);
  r.steps.push({ msg: NEUTRAL, actor: null });
  r.boards.push(start);
  const play = (msg: unknown) => r.send(msg, operator(r.now()));
  play(G.BUY(NYC));
  play(G.BUY(NYC));
  play(G.BUY(NYC));
  play(G.PASS);
  while (r.now().operating_sub_phase !== "Hardware") play(G.ADVANCE(r.now()));
  expect(G.acting(r.now())).toBe(BO);
  play(G.BUY(BO));
  expect(G.headTier(r.now())).toBe("5");
  play(G.BUY(BO)); // P3's FIRST 5: the limit falls to 2
  expect(GP.derivePhase(r.now())?.trainLimit).toBe(2);
  return r;
}

describe("gameHistory -- 1. a train discarded to the limit is `discarded`, booked once (U-41)", () => {
  it("STANDARD: NYC's 4 and B&O's 5 are `discarded` -- not rusted, not traded -- and each was really discarded", () => {
    const r = limitDrop(false);
    expect(TD.pendingTrainDiscards(r.now())?.queue.map((due) => due.companyId)).toEqual([NYC, BO]); // the premise
    r.send(G.DISCARD(BO, "5"), P3, "refused"); // not B&O's turn to decide yet: NYC first (6.6.1)
    r.send(G.DISCARD(NYC, "4"), P2);
    r.send(G.DISCARD(BO, "5"), P3);
    expect(TD.pendingTrainDiscards(r.now())).toBeNull();
    expect(r.now().returned_trains).toEqual(["4", "5"]);
    const h = r.history();
    expect(ledger(h, NYC, "4")).toMatchObject({ count: 3, fates: { rusted: 0, discarded: 1, sold: 0, traded: 0, taken: 0, kept: 2 } });
    expect(ledger(h, BO, "5")).toMatchObject({ count: 1, fates: { rusted: 0, discarded: 1, sold: 0, traded: 0, taken: 0, kept: 0 } });
    // The refused attempt booked nothing: B&O's 5 is discarded once, not twice.
    expect(ledger(h, BO, "5")!.fates.discarded).toBe(1);
  });

  it("STANDARD: the Rust Belt charges each discarding president; the Gravedigger credits the FIRST 5's buyer, not the discarders", () => {
    const r = limitDrop(false);
    r.send(G.DISCARD(NYC, "4"), P2);
    r.send(G.DISCARD(BO, "5"), P3);
    const h = r.history();
    const [two, four, five] = (["2", "4", "5"] as const).map((tier) => GP.depotCostFor(r.boards[1], tier));
    // The first 4 (P2's purchase) rusted six 2s: NYC's two (P2), B&O's two (P3), PRR's two (P1).
    // The limit (P3's FIRST 5): NYC's 4 (lost by P2), B&O's 5 (lost by P3) -- both credited to P3.
    expect(top(h, "gravedigger")).toEqual([P3, four + five, 6 * two]);
    expect(top(h, "rust-belt")).toEqual([P3, 2 * two + five, 2 * two + four]);
    expect([two, four, five]).toEqual([80, 300, 450]);
  });

  it("CONTROL: before the discards, the same log books only the rust -- the obligation itself is no loss", () => {
    const r = limitDrop(false);
    const h = r.history();
    expect(top(h, "gravedigger")).toEqual([P2, 6 * 80, null]);
    // Three presidents lost two 2s each: a three-way tie, held by the first booked (NYC's P2, the board's first corporation).
    expect(top(h, "rust-belt")).toEqual([P2, 160, 160]);
    expect(accolade(h, "rust-belt").tied).toBe(true);
    expect(ledger(h, BO, "5")!.fates).toMatchObject({ discarded: 0, kept: 1 });
  });

  it("GENTLE RUST: a discard is booked when the unmarked train leaves; the marked 2s stay KEPT until destroyed (#1704 preserved)", () => {
    const r = limitDrop(true);
    expect(c(r.now(), NYC).pending_rust_trains).toEqual(["2", "2"]); // the premise: NYC's 2s are marked, still owned
    r.send(G.DISCARD(NYC, "2"), P2, "refused"); // a reprieved train may not be discarded
    r.send(G.DISCARD(NYC, "4"), P2);
    r.send(G.DISCARD(BO, "5"), P3);
    const h = r.history();
    const two = 80;
    expect(ledger(h, NYC, "4")!.fates).toMatchObject({ rusted: 0, discarded: 1, traded: 0, kept: 2 });
    expect(ledger(h, NYC, "2")!.fates).toMatchObject({ rusted: 0, discarded: 0, kept: 2 }); // marked, not yet destroyed
    expect(ledger(h, BO, "5")!.fates).toMatchObject({ rusted: 0, discarded: 1, kept: 0 });
    // B&O's 2s were destroyed at its own Run Routes (destruction-time: P3 loses them, P2 -- the first 4's buyer -- sent
    // them). The limit: P3 is credited NYC's 4 and B&O's 5; P2 loses its 4, P3 its 5.
    expect(ledger(h, BO, "2")!.fates).toMatchObject({ rusted: 2, kept: 0 });
    expect(top(h, "gravedigger")).toEqual([P3, 300 + 450, 2 * two]);
    expect(top(h, "rust-belt")).toEqual([P3, 2 * two + 450, 300]);
  });
});

/* ================================================================== */
/* 2. THE SALVAGER (U-43 (1)) AND OD-14(d)                             */
/* ================================================================== */

/** Phase 6, both printed 6s owned (NYC): Diesels are on sale. C&O (P1) and B&O (P2) are at Buy Trains in turn; the Bank
 *  Pool holds a 5. */
const dieselBoard = (co: string[], bo: string[], operating = CO) =>
  urBoard({
    ur: false,
    corps: [
      { id: CO, president: P1, trains: co, treasury: 3000 },
      { id: BO, president: P2, trains: bo, treasury: 3000 },
      { id: NYC, president: P3, trains: ["6", "6"] },
    ],
    operating,
    step: "Hardware",
    macro: 6,
    returned: ["5"],
  });
/** The same board with `id` at Buy Trains -- a constructed jump to that corporation's turn. */
const turnOf = (state: GameStateResponse, id: number) =>
  ({ ...state, active_corporation_index: state.active_operating_order!.indexOf(id), operating_sub_phase: "Hardware" }) as GameStateResponse;

describe("gameHistory -- 2. the trade-in's fate is read off what actually left (U-43 (1), OD-14(d))", () => {
  it("OD-14(d): the 4 traded in for the FIRST Diesel is `traded`, never 'rusted'; the 4 the Diesel rusts beside it is `rusted`", () => {
    const r = recorder(dieselBoard(["4", "4"], ["6"]), (state, msg, actor) => reduce(state, msg, actor));
    r.boards[0] = withoutFleet(r.boards[0], CO);
    r.steps.push({ msg: NEUTRAL, actor: null });
    r.boards.push(dieselBoard(["4", "4"], ["6"]));
    r.send(exchange(CO, "4"), P1);
    expect(fleet(r.now(), CO)).toEqual(["D"]); // the premise: one 4 traded, the other rusted by the first D
    const h = r.history();
    expect(ledger(h, CO, "4")!.fates).toMatchObject({ traded: 1, rusted: 1, discarded: 0, kept: 0 });
    // Only the rusted 4 is scrap: P1 lost one 4 and (buying the first D) sent one 4 -- not two.
    expect(top(h, "rust-belt")).toEqual([P1, 300, null]);
    expect(top(h, "gravedigger")).toEqual([P1, 300, null]);
    expect(accolade(h, "salvager")).toMatchObject({ holder: P1, companyId: CO, value: 1 });
  });
});

describe("accolades -- 2. the Salvager counts a train actually traded in (U-43 (1))", () => {
  it("a Bank Pool purchase returns nothing: no trade-in, and the pool train is simply bought", () => {
    const board = dieselBoard(["6"], ["6"]);
    const after = reduce(board, buyPool(CO, "5"));
    expect(fleet(after, CO)).toEqual(["6", "5"]); // the premise: bought from the pool, nothing given up
    const h = scripted([board, after], [{ msg: buyPool(CO, "5"), actor: P1 }]);
    expect(top(h, "salvager")).toEqual([null, 0, null]);
    expect(accolade(h, "fleet-admiral")).toMatchObject({ holder: P1, companyId: CO, value: 1 });
  });

  it("a refused exchange moved nothing: no trade-in", () => {
    const board = dieselBoard(["6"], ["6"]);
    const msg = exchange(CO, "4"); // C&O holds no 4
    const after = reduce(board, msg);
    expect(stateDigest(after)).toBe(stateDigest(board)); // the premise: refused
    expect(top(scripted([board, after], [{ msg, actor: P1 }]), "salvager")).toEqual([null, 0, null]);
  });

  it("TIE ORDER: a purchase the old count booked still holds its corporation's place -- the tie stays C&O's", () => {
    /* C&O buys the pool 5 (the old count's "trade-in"), then B&O and C&O each trade one train in for a Diesel: one each,
       tied. The old count had C&O 2 - 1; C&O's key entered the tally first, so the tie is broken for C&O as before --
       without the reserved place, B&O's would have entered first and taken it. */
    const r = recorder(dieselBoard(["4"], ["4"]), (state, msg, actor) => reduce(state, msg, actor));
    r.send(buyPool(CO, "5"), P1);
    r.jump((state) => turnOf(state, BO));
    r.send(exchange(BO, "4"), P2); // the first Diesel: C&O's 4 rusts
    r.jump((state) => turnOf(state, CO));
    r.send(exchange(CO, "5"), P1);
    expect([fleet(r.now(), CO), fleet(r.now(), BO)]).toEqual([["D"], ["D"]]); // the premise
    const h = r.history();
    expect(accolade(h, "salvager")).toMatchObject({ holder: P1, companyId: CO, value: 1, runnerUp: 1, tied: true });
  });
});

/* ================================================================== */
/* 3. A REFUSED RUN IS NOT A RUN (U-43 (2))                            */
/* ================================================================== */

/** Phase 3: C&O's [2, 3] -- the 2-train to the Gulf ($50), the 3-train along the line ($60): $110. Standard table. */
const twoTrains = (options: { pinned?: boolean; ur?: boolean; macro?: number; sub?: number } = {}) =>
  urBoard({
    ur: options.ur ?? false,
    pinned: options.pinned,
    macro: options.macro,
    sub: options.sub,
    corps: [
      { id: CO, president: P1, trains: ["2", "3"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"], treasury: 300 },
    ],
  });
const TWO_RUN = (seed?: number) => runMsg(CO, [TWO_ROUTE, THREE_ROUTE], [0, 1], ["2", "3"], seed);

describe("gameHistory -- 3. a refused run books nothing (U-43 (2))", () => {
  it("a refused duplicate after the turn's run: lifetime revenue, the OR chart and the ledger's runs count the run once", () => {
    const r = recorder(twoTrains(), (state, msg, actor) => reduce(state, msg, actor));
    r.boards[0] = withoutFleet(r.boards[0], CO);
    r.steps.push({ msg: NEUTRAL, actor: null });
    r.boards.push(twoTrains());
    r.send(TWO_RUN(), P1);
    r.send(TWO_RUN(), P1, "refused"); // a second run in one turn (S6 / #1183)
    expect(c(r.now(), CO).last_route_revenue).toBe("110"); // the premise: the board still holds the run's figure
    const h = r.history();
    expect(autopsyOf(h, CO).lifetimeRevenue).toBe(110); // was 220
    expect(orRevenue(h, "OR 3.1", CO)).toBe(110);
    expect(ledger(h, CO, "2")).toMatchObject({ earned: 50, trainRounds: 1 }); // was 100 / 2
    expect(ledger(h, CO, "3")).toMatchObject({ earned: 60, trainRounds: 1 });
    expect(autopsyOf(h, CO).payback).toBe(110);
  });

  it("a refused run of a corporation that is not operating books nothing at all", () => {
    const board = twoTrains();
    const msg = runMsg(BO, [THREE_ROUTE], [0], ["3"]);
    const after = reduce(board, msg, P2);
    expect(stateDigest(after)).toBe(stateDigest(board)); // the premise: refused
    const h = scripted([board, after], [{ msg, actor: P2 }]);
    expect(autopsyOf(h, BO).lifetimeRevenue).toBe(0);
    expect(top(h, "workhorse")).toEqual([null, 0, null]);
    expect(top(h, "juggernaut")).toEqual([null, 0, null]);
  });
});

describe("accolades -- 3. refused runs (U-43 (2))", () => {
  it("the Workhorse and the Juggernaut count the accepted run once", () => {
    const board = twoTrains();
    const ran = reduce(board, TWO_RUN());
    const again = reduce(ran, TWO_RUN());
    expect(stateDigest(again)).toBe(stateDigest(ran)); // the premise: refused
    const h = scripted([board, ran, again], [{ msg: TWO_RUN(), actor: P1 }, { msg: TWO_RUN(), actor: P1 }]);
    expect(top(h, "workhorse")).toEqual([P1, 110, null]);
    expect(top(h, "juggernaut")).toEqual([P1, 110, null]);
    expect(top(h, "master-of-the-line")).toEqual([P1, 60, null]);
  });

  it("TIE ORDER: a refused run still holds its corporation's place in lifetime revenue -- the Workhorse tie stays B&O's", () => {
    /* B&O's refused attempt comes first (the old booking entered B&O's key at $0), then C&O's accepted $110 run, then --
       after a constructed jump to a board on which B&O holds the network -- B&O's accepted $110 run. Tied at $110: the
       old order gives it to B&O, and so does this one; without the reserved place it would have gone to C&O. */
    const r = recorder(twoTrains(), (state, msg, actor) => reduce(state, msg, actor));
    r.send(runMsg(BO, [THREE_ROUTE], [0], ["3"]), P2, "refused");
    r.send(TWO_RUN(), P1);
    r.jump(() =>
      urBoard({
        ur: false,
        corps: [
          { id: BO, president: P2, trains: ["2", "3"], treasury: 300, tokens: ["I5"] },
          { id: CO, president: P1, trains: ["2", "3"], treasury: 190, tokens: ["J2"] },
        ],
        operating: BO,
      }),
    );
    r.send(runMsg(BO, [TWO_ROUTE, THREE_ROUTE], [0, 1], ["2", "3"]), P2);
    expect([c(r.now(), BO).last_route_revenue, c(r.boards[2], CO).last_route_revenue]).toEqual(["110", "110"]); // premise
    const h = r.history();
    expect(accolade(h, "workhorse")).toMatchObject({ holder: P2, companyId: BO, value: 110, runnerUp: 110, tied: true });
  });
});

/* ================================================================== */
/* 4. AN ACCEPTED RunManualRoute IS A RUN -- ONE PER TURN (U-43 (3))   */
/* ================================================================== */

/** The legacy turn: one `RunManualRoute` per train (pre-#968), on an unpinned board -- the 2 to the Gulf, then the 3. */
function manualTurn(options: { ur?: boolean; macro?: number; sub?: number } = {}) {
  const start = twoTrains({ pinned: false, ...options });
  const r = recorder(start, (state, msg, actor) => reduce(state, msg, actor));
  r.boards[0] = withoutFleet(start, CO);
  r.steps.push({ msg: NEUTRAL, actor: null });
  r.boards.push(start);
  r.send(manual(CO, TWO_ROUTE), P1);
  r.send(manual(CO, THREE_ROUTE), P1);
  // The premise: the arm accumulates the turn (#903 / #941) and names no train (#1031: no breakdown).
  expect([c(r.boards[2], CO).printed_route_revenue, c(r.now(), CO).printed_route_revenue]).toEqual(["50", "110"]);
  if (!options.ur) expect(c(r.now(), CO).last_route_revenue).toBe("110");
  expect(c(r.now(), CO).routes_run_this_turn).toBe(2);
  expect(c(r.now(), CO).last_run_breakdown ?? []).toEqual([]);
  return r;
}
/** The equivalent accepted route execution: the same two routes as one `RunMultipleRoutes` whose trains the log does
 *  not name -- the shape `RunManualRoute` has (no train), so the same breakdown rule (#1031) applies. */
function multiTurn() {
  const start = twoTrains({ pinned: false });
  const r = recorder(start, (state, msg, actor) => reduce(state, msg, actor));
  r.boards[0] = withoutFleet(start, CO);
  r.steps.push({ msg: NEUTRAL, actor: null });
  r.boards.push(start);
  r.send(runMsg(CO, [TWO_ROUTE, THREE_ROUTE], null, null), P1);
  expect(c(r.now(), CO).last_route_revenue).toBe("110");
  return r;
}
const runFigures = (h: History) => ({
  lifetime: autopsyOf(h, CO).lifetimeRevenue,
  chart: orRevenue(h, "OR 3.1", CO),
  ledger: autopsyOf(h, CO).fleetLedger.map((row) => [row.model, row.earned, row.trainRounds]),
  workhorse: top(h, "workhorse"),
  juggernaut: accolade(h, "juggernaut"),
  master: top(h, "master-of-the-line"),
  payback: autopsyOf(h, CO).payback,
});

describe("gameHistory -- 4. the legacy per-train run is booked, once per turn (U-43 (3))", () => {
  it("two `RunManualRoute`s of one turn are ONE run at the turn's figure: $110, never $50 + $110", () => {
    const h = manualTurn().history();
    expect(autopsyOf(h, CO).lifetimeRevenue).toBe(110); // was 0 (unbooked); a per-message booking would say 160
    expect(orRevenue(h, "OR 3.1", CO)).toBe(110);
    expect(autopsyOf(h, CO).payback).toBe(110);
    // No train is named, so no per-train figure is invented (#1031) -- as for any run whose trains the log cannot name.
    expect(ledger(h, CO, "2")).toMatchObject({ earned: 0, trainRounds: 0 });
    expect(ledger(h, CO, "3")).toMatchObject({ earned: 0, trainRounds: 0 });
  });

  it("the SAME derived run history as the equivalent accepted `RunMultipleRoutes`", () => {
    expect(runFigures(manualTurn().history())).toEqual(runFigures(multiTurn().history()));
  });

  it("a manual route accepted after the turn's dividends (the legacy arm takes it) books only what it added", () => {
    const r = manualTurn();
    r.send(Y.declare(CO, 110), P1);
    r.send(manual(CO, TWO_ROUTE), P1);
    expect(c(r.now(), CO).last_route_revenue).toBe("160"); // the premise: the arm adds to the declared turn
    const h = r.history();
    expect(autopsyOf(h, CO).lifetimeRevenue).toBe(160); // 110 + 50, not 110 + 160
    expect(accolade(h, "juggernaut")).toMatchObject({ holder: P1, value: 110 });
  });

  it("REVIEW: two manual routes after the declaration -- the later one amends the second booking by its share, not the turn's whole figure", () => {
    const r = manualTurn();
    r.send(Y.declare(CO, 110), P1);
    r.send(manual(CO, TWO_ROUTE), P1);
    r.send(manual(CO, THREE_ROUTE), P1);
    expect(c(r.now(), CO).last_route_revenue).toBe("220"); // the premise: the arm took both, on top of the declared 110
    const h = r.history();
    expect(autopsyOf(h, CO).lifetimeRevenue).toBe(220); // 110 + 110 -- not 330
    expect(accolade(h, "juggernaut")).toMatchObject({ value: 110, runnerUp: null });
    expect(orRevenue(h, "OR 3.1", CO)).toBe(220); // the chart shows the turn's figure on the board
  });

  it("a pinned board refuses `RunManualRoute` (#1551): nothing is booked", () => {
    const board = twoTrains();
    const msg = manual(CO, TWO_ROUTE);
    const after = reduce(board, msg);
    expect(stateDigest(after)).toBe(stateDigest(board)); // the premise
    const h = scripted([board, after], [{ msg, actor: P1 }]);
    expect(autopsyOf(h, CO).lifetimeRevenue).toBe(0);
    expect(orRevenue(h, "OR 3.1", CO)).toBe(0);
  });
});

describe("accolades -- 4. the manual run's awards (U-43 (3))", () => {
  it("the Workhorse and the Juggernaut see the manual turn at $110; Master of the Line has no named train to give", () => {
    const h = manualTurn().history();
    expect(top(h, "workhorse")).toEqual([P1, 110, null]);
    expect(accolade(h, "juggernaut")).toMatchObject({ holder: P1, value: 110, detail: "C&O ran $110 in one round (OR 3.1)" });
    expect(top(h, "master-of-the-line")).toEqual([null, 0, null]);
  });
});

/* ================================================================== */
/* 5. THE COWBOY COUNTS THE LINE THE PLAYER SAW (U-43 (4))             */
/* ================================================================== */

const ANIMALS = new Set([
  "cow-happy.mp3", "cow-sad.mp3", "horse-happy.mp3", "horse-sad.mp3", "sheep.mp3", "chicken.mp3", "dog.mp3",
  "elephant.mp3", "quacks.mp3", "bees.mp3", "cat-meow.mp3", "parrot.mp3",
]);
const isAnimalLine = (line: string, bucket: ReturnType<typeof GV.flavorBucketFor>) => {
  const cue = variantCueFor({ line, bucket });
  return cue.audio !== null && ANIMALS.has(cue.audio);
};
/** The parts a pre-#1051 (seedless) run is rolled with: the reducer's and the shell's `legacyTurnSeed` fallback. */
const legacyParts = (macro: number, sub: number, companyId = CO) => partsFor(GV.legacyTurnSeed(macro, sub, companyId), macro, sub, companyId);
/** A quiet draw (no Sign) whose line for `printed` is -- or is not -- an animal's. */
const quietAnimal = (printed: number, parts: ReturnType<typeof partsFor>, animal: boolean) => {
  const roll = GV.rollTurnRevenue(printed, parts);
  const line = GV.revenueFlavourClause(roll, parts);
  return line !== YS.YELLOW_SIGN_MALUS_LINE && GV.flavorBucketFor(roll) !== "criticalBonus" && isAnimalLine(line, GV.flavorBucketFor(roll)) === animal;
};
/** The first round (macro 1.., sub 1..2) whose legacy draw satisfies `predicate` -- found, never asserted. */
function legacyRoundWhere(predicate: (parts: ReturnType<typeof partsFor>) => boolean): { macro: number; sub: number } {
  for (let macro = 1; macro <= 400; macro += 1) {
    for (let sub = 1; sub <= 2; sub += 1) if (predicate(legacyParts(macro, sub))) return { macro, sub };
  }
  throw new Error("no legacy round satisfies the predicate");
}
const LEGACY_ANIMAL = legacyRoundWhere((parts) => quietAnimal(110, parts, true));
const LEGACY_TAME = legacyRoundWhere((parts) => quietAnimal(110, parts, false));
/** A legacy draw on which the Carcosa gift REPLACES a natural animal line for a $90 run. */
const LEGACY_GIFT_OVER_ANIMAL = legacyRoundWhere((parts) => {
  const roll = GV.rollTurnRevenue(90, parts);
  return Y.isCarcosaDraw(90, parts) && isAnimalLine(GV.revenueFlavourClause(roll, parts), GV.flavorBucketFor(roll));
});

describe("accolades -- 5. the Cowboy counts the line the player actually saw (U-43 (4))", () => {
  const seedlessRun = (round: { macro: number; sub: number }) => {
    const board = twoTrains({ ur: true, pinned: false, ...round });
    const msg = TWO_RUN(); // logged before #1051: no `revenue_seed`
    const after = reduce(board, msg);
    expect(c(after, CO).last_route_revenue).toBe(String(GV.rollTurnRevenue(110, legacyParts(round.macro, round.sub)).adjusted)); // premise
    return scripted([board, after], [{ msg, actor: P1 }]);
  };

  it("a seedless legacy run whose printed line (the legacy die the reducer and the shell both rolled) is an animal's counts", () => {
    expect(top(seedlessRun(LEGACY_ANIMAL), "farmhand")).toEqual([P1, 1, null]); // was skipped: no recorded seed
  });

  it("control: a seedless run whose printed line is not an animal's does not", () => {
    expect(top(seedlessRun(LEGACY_TAME), "farmhand")).toEqual([null, 0, null]);
  });

  it("after the Sign's replacement: the gift's clause was printed, not the natural animal line the legacy die drew", () => {
    const board = urBoard({
      pinned: false,
      ...LEGACY_GIFT_OVER_ANIMAL,
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 300, extra: { has_yellow_sign: true } },
        { id: BO, president: P2, trains: ["5"], treasury: 1000 },
        { id: NYC, president: P3, trains: ["5"] },
      ],
    });
    const msg = runMsg(CO, [LONG_ROUTE], [0], ["5"]);
    const after = reduce(board, msg);
    expect(c(after, CO).routes_run_this_turn).toBe(1); // the premise: accepted
    expect(top(scripted([board, after], [{ msg, actor: P1 }]), "farmhand")).toEqual([null, 0, null]);
  });

  it("a legacy `RunManualRoute` turn prints no flavour line of its own, so it meets no animal -- even on an animal draw", () => {
    const h = manualTurn({ ur: true, ...LEGACY_ANIMAL }).history();
    expect(autopsyOf(h, CO).lifetimeRevenue).toBe(GV.rollTurnRevenue(110, legacyParts(LEGACY_ANIMAL.macro, LEGACY_ANIMAL.sub)).adjusted);
    expect(top(h, "farmhand")).toEqual([null, 0, null]);
  });

  it("a refused duplicate of an animal run is not a second run-in", () => {
    const seed = Y.seedWhere((s) => quietAnimal(110, partsFor(s), true));
    const board = twoTrains({ ur: true });
    const ran = reduce(board, TWO_RUN(seed));
    const again = reduce(ran, TWO_RUN(seed));
    expect(stateDigest(again)).toBe(stateDigest(ran)); // the premise: refused
    const h = scripted([board, ran, again], [{ msg: TWO_RUN(seed), actor: P1 }, { msg: TWO_RUN(seed), actor: P1 }]);
    expect(top(h, "farmhand")).toEqual([P1, 1, null]); // was 2
  });
});

/* ================================================================== */
/* roundReplay -- the scrubbed board agrees with the derived history   */
/* ================================================================== */

/** A constructed jump to the next Operating Round of the set -- a round boundary for the scrubber. */
const nextRound = (state: GameStateResponse) => ({ ...state, sub_round_index: (state.sub_round_index ?? 1) + 1 }) as GameStateResponse;

describe("roundReplay -- the board at a round's end shows what the history booked (#1425 with W2-L)", () => {
  it("U-41: every train the history calls `discarded` is in the Bank Pool on the scrubbed board, and the obligation is met", () => {
    const r = limitDrop(false);
    r.send(G.DISCARD(NYC, "4"), P2);
    r.send(G.DISCARD(BO, "5"), P3);
    r.jump(nextRound);
    const { snapshot } = r.snapshotAt("OR 3.1");
    expect(snapshot.label).toBe("OR 3.1");
    const h = r.history();
    const discarded = h.autopsy.flatMap((row) => row.fleetLedger.flatMap((line) => Array(line.fates.discarded).fill(line.model)));
    expect([...(snapshot.state.returned_trains ?? [])].sort()).toEqual(discarded.sort());
    expect(TD.pendingTrainDiscards(snapshot.state)).toBeNull();
    for (const row of h.autopsy) {
      for (const line of row.fleetLedger) expect(fleet(snapshot.state, row.companyId).filter((m) => m === line.model)).toHaveLength(line.fates.kept);
    }
  });

  it("U-43 (2)/(3): the OR's chart figure is the run the scrubbed board holds -- a manual turn's total, a refused duplicate ignored", () => {
    const manualRun = manualTurn();
    manualRun.jump(nextRound);
    const refused = recorder(twoTrains(), (state, msg, actor) => reduce(state, msg, actor));
    refused.send(TWO_RUN(), P1);
    refused.send(TWO_RUN(), P1, "refused");
    refused.jump(nextRound);
    for (const r of [manualRun, refused]) {
      const { rounds, at, snapshot } = r.snapshotAt("OR 3.1");
      const chart = rounds[at].corporations.find((corp) => corp.companyId === CO)!.revenue;
      expect(chart).toBe(110);
      expect(Number(c(snapshot.state, CO).last_route_revenue)).toBe(chart);
    }
  });
});
