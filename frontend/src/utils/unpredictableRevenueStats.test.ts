/** @jest-environment node */
//
// ==================================================================
//  UR-5 (Variant Certification 1B): THE STATISTICS OF AN UNPREDICTABLE REVENUE GAME -- OD-UR-6, UR-F8, UR-F9
// ==================================================================
//
// OWNER RULINGS (OD-UR-6, backlog D-49 / D-51, 2026-09-24):
//   6.1  CORPORATION / TURN-level revenue statistics use the ACTUAL PAID revenue, after the die. INDIVIDUAL TRAIN /
//        ROUTE statistics use the PRINTED value of that train's successfully completed route -- not an allocation of
//        the paid total (no proportional, equal or die-adjusted per-train figure); the per-train figures need not add
//        up to the paid turn total.
//   6.2  A route the Yellow Sign's Mark nullified is not earned: "the train disappeared instead of completing the run;
//        it never made it to the station" -- nothing to the per-train statistics.
//   6.3  The synthetic Carcosa GIFT is NOT a purchase (no purchase count, no "bought a Diesel", no Early Adopter); a
//        later Blood Price acquisition IS a genuine purchase by the buyer, Diesel treatment included.
// And the Cowboy (UR-F9) counts the flavour line the table READ, not the natural one the die drew.
//
// TWO HARNESSES, both leaving `gameHistory.ts` itself unstubbed:
//   * THE SCRIPT (UR-3 / UR-4's device): the history's replay engine is replaced by a script of the reducer's own
//     boards, so a case can put any constructed board in front of it -- each script entry is one real reducer step.
//   * THE REPLAY: the engine is the REAL one, seeded with a constructed board instead of the default deal, so the
//     history replays a hosted room's actual log -- runs, offers, derived settlements, undos -- through the reducer.
//
// Values are chosen to make a wrong basis obvious: printed $90 paid $70; printed $50 + $60 = $110 paid $130.

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

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const SS = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const GP = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const YS = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const GV = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { variantCueFor } = require("./variantSfx") as typeof import("./variantSfx");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { sandboxActionContext } = require("../gameEngine/actionContext") as typeof import("../gameEngine/actionContext");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { RULES_ENGINE_VERSION, DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { gameHistoryFrom } = require("./gameHistory") as typeof import("./gameHistory");

const { CO, BO, NYC, P1, P2, P3, GULF, TWO_ROUTE, THREE_ROUTE, LONG_ROUTE, urBoard, runMsg, partsFor, companyOf } = S;

type History = ReturnType<typeof gameHistoryFrom>;
type Msg = Record<string, unknown>;
type Step = { msg: unknown; actor: string | null; derived?: boolean };

/* ------------------------------------------------------------------ */
/* The reducer, messages, and the two harnesses                        */
/* ------------------------------------------------------------------ */

const providers = sandboxReplayProviders();
/** The reducer as a server's engine runs it (the composed context: the grid, the chart's Blood Price step). */
const reduce = (state: GameStateResponse, msg: unknown, actor: string | null = P1) =>
  SS.applySandboxAction(state, msg as never, sandboxActionContext(providers, { state, msg: msg as never, actor, grid: GULF, gridBefore: GULF }));

const sale = (buyer: number, seller: number, model: string, price: string, gilded?: boolean): Msg => ({
  BuyTrainFromCorporation: {
    game_id: 1,
    buyer_protocol_id: buyer,
    seller_protocol_id: seller,
    model_type: model,
    price,
    ...(gilded === undefined ? {} : { gilded }),
  },
});
const propose = (seller: number, buyer: number, model: string, price: string, gilded?: boolean): Msg => ({
  ProposeTrainPurchase: {
    game_id: 1,
    seller_protocol_id: seller,
    seller_ticker: "narration",
    seller_president: "narration",
    buyer_protocol_id: buyer,
    buyer_ticker: "narration",
    model_type: model,
    price,
    ...(gilded === undefined ? {} : { gilded }),
  },
});
const answer = (seller: number, accept: boolean): Msg => ({ AnswerTrainPurchase: { game_id: 1, seller_protocol_id: seller, accept } });
const exchange = (id: number, model: string): Msg => ({ ExchangeTrainForDiesel: { game_id: 1, protocol_id: id, model_type: model } });
const buyDepot = (id: number, tier?: string): Msg => ({
  BuyHardwareFromPool: { game_id: 1, protocol_id: id, ...(tier === undefined ? {} : { model_type: tier }) },
});
const buyPool = (id: number, model: string): Msg => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, returned_model_type: model } });
const NEUTRAL: Msg = { UR5Neutral: {} };

/** THE SCRIPT HARNESS. `boards[0]` is the engine's opening board and `boards[i + 1]` the board after `steps[i]`; each
 *  board after the first is the reducer's own output for its step, or a constructed jump taken by a NEUTRAL step. */
function scripted(boards: GameStateResponse[], steps: Step[]): History {
  expect(boards).toHaveLength(steps.length + 1);
  const entries = steps.map((step, index) => ({
    index,
    id: `ur5-${index}`,
    actor: step.actor,
    payload: JSON.stringify(step.msg),
    derived: step.derived === true,
  }));
  mockScript = boards;
  try {
    return gameHistoryFrom(entries as never);
  } finally {
    mockScript = null;
  }
}

/** A board with one corporation's fleet not yet on its roster, so a neutral first step delivers it (GR-3's device: the
 *  fleet ledger then has the rows whose earnings and fates the case books). */
const withoutFleet = (board: GameStateResponse, subject: number) =>
  ({ ...board, public_companies: board.public_companies.map((c) => (c.company_id === subject ? { ...c, owned_trains: [] } : c)) }) as GameStateResponse;

/** The script of one reducer step on `board`, with `subject`'s fleet delivered by a neutral step first. */
function oneStep(board: GameStateResponse, subject: number, msg: unknown, actor: string | null = P1) {
  const after = reduce(board, msg, actor);
  const history = scripted([withoutFleet(board, subject), board, after], [{ msg: NEUTRAL, actor: null }, { msg, actor }]);
  return { after, history };
}

/** THE REPLAY HARNESS: the history of a log, replayed by the real engine from `seed` on the network grid. */
function replayed(seed: GameStateResponse, entries: ReadonlyArray<{ index: number; id: string; actor: string | null; payload: string; derived?: boolean }>): History {
  mockSeeded = { providers: S.roomProviders(seed, GULF), seed: { state: seed, waterfall: null } };
  try {
    return gameHistoryFrom(entries.map((entry) => ({ ...entry })) as never);
  } finally {
    mockSeeded = null;
  }
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

const accolade = (history: History, key: string) => history.accolades.find((entry) => entry.key === key)!;
const top = (history: History, key: string) => [accolade(history, key).holder, accolade(history, key).value];
const autopsyOf = (history: History, companyId: number) => history.autopsy.find((row) => row.companyId === companyId)!;
const ledger = (history: History, companyId: number, model: string) =>
  autopsyOf(history, companyId).fleetLedger.find((row) => row.model === model);
/** The Revenue-per-OR chart's figure for one corporation in one round (the chart draws the "OR" samples). */
const orRevenue = (history: History, label: string, companyId: number) =>
  history.rounds.find((round) => round.label === label)?.corporations.find((c) => c.companyId === companyId)?.revenue;
const c = (state: GameStateResponse, id: number): PublicCompanyState => companyOf(state, id);

/** #1429's animal lines -- the sounds `variantSfx` routes them to (the Cowboy's own set in `gameHistory.ts`). */
const ANIMALS = new Set([
  "cow-happy.mp3", "cow-sad.mp3", "horse-happy.mp3", "horse-sad.mp3", "sheep.mp3", "chicken.mp3", "dog.mp3",
  "elephant.mp3", "quacks.mp3", "bees.mp3", "cat-meow.mp3", "parrot.mp3",
]);
const isAnimalLine = (line: string, bucket: ReturnType<typeof GV.flavorBucketFor>) => {
  const cue = variantCueFor({ line, bucket });
  return cue.audio !== null && ANIMALS.has(cue.audio);
};

/* ------------------------------------------------------------------ */
/* Seeds -- found against the pure selectors, never asserted           */
/* ------------------------------------------------------------------ */

/** A draw on which no Yellow Sign stage fires and the die moves `printed` to exactly `paid`. */
const quietDraw = (printed: number, paid: number, parts: ReturnType<typeof partsFor>) => {
  const roll = GV.rollTurnRevenue(printed, parts);
  return roll.adjusted === paid && GV.revenueFlavourClause(roll, parts) !== YS.YELLOW_SIGN_MALUS_LINE;
};
const DOWN_90_TO_70 = S.seedWhere((seed) => quietDraw(90, 70, partsFor(seed)));
const UP_110_TO_130 = S.seedWhere((seed) => quietDraw(110, 130, partsFor(seed)));
const UP_50_TO_60 = S.seedWhere((seed) => quietDraw(50, 60, partsFor(seed)));
const MARK_110 = S.seedWhere((seed) => S.isMarkDraw(110, partsFor(seed)));
const MARK_90_OR_3_2 = S.seedWhere((seed) => S.isMarkDraw(90, partsFor(seed, 3, 2)));
const GIFT_90 = S.seedWhere((seed) => S.isCarcosaDraw(90, partsFor(seed)));
const GIFT_90_OR_6_1 = S.seedWhere((seed) => S.isCarcosaDraw(90, partsFor(seed, 6, 1)));

/* ------------------------------------------------------------------ */
/* Boards                                                              */
/* ------------------------------------------------------------------ */

/** Phase 4: C&O's single 4-train runs the whole line, J2-I3-I5-I7-I9, printed $90. */
const oneFourTrain = () =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["4"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"] },
    ],
  });
/** Phase 3: C&O's [2, 3] -- the 2-train to the Gulf ($50), the 3-train along the line ($60): $110 printed. */
const twoTrains = (options: { ur?: boolean; pinned?: boolean } = {}) =>
  urBoard({
    ...options,
    corps: [
      { id: CO, president: P1, trains: ["2", "3"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"], treasury: 300 },
    ],
  });
const TWO_RUN = (seed: number) => runMsg(CO, [TWO_ROUTE, THREE_ROUTE], [0, 1], ["2", "3"], seed);

/** Phase 5 with the 5s sold out: the Marked C&O's Carcosa is a 6 -- above the phase, the Depot's lowest (UR-3's board). */
const giftSixBoard = () =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 300, extra: { has_yellow_sign: true } },
      { id: BO, president: P2, trains: ["5"], treasury: 1000 },
      { id: NYC, president: P3, trains: ["5"] },
    ],
  });

/** Phase 6 with both printed 6s owned: the Depot's lowest is a Diesel, so the Marked C&O's Carcosa is a D (P-F). */
const giftDieselBoard = () =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["6"], treasury: 300, extra: { has_yellow_sign: true } },
      { id: BO, president: P2, trains: ["6"] },
      { id: NYC, president: P3, trains: ["5"], treasury: 1500 },
    ],
    macro: 6,
  });

/** The gilded Carcosa copy: gilding, provenance, the curse. A CURED copy (an earlier Blood Price): provenance only. */
const GILDED = (model: string): Partial<PublicCompanyState> =>
  ({ is_carcosan: true, carcosan_trains: [model], ghost_trains: [model] }) as Partial<PublicCompanyState>;
const CURED = (model: string): Partial<PublicCompanyState> => ({ ghost_trains: [model] }) as Partial<PublicCompanyState>;

/** Phase 6: B&O (P2) holds a real 6 and the gilded Carcosa D; C&O (P1) is at Purchase Trains and buys through an offer. */
const bloodPriceDieselBoard = () =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 1000 },
      { id: BO, president: P2, trains: ["6", "D"], extra: GILDED("D") },
      { id: NYC, president: P3, trains: ["6", "4"] },
    ],
    step: "Hardware",
    macro: 6,
  });
/** Phase 5 (the 5s sold out): B&O (P2) holds the gilded Carcosa 6; C&O (P1) is at Purchase Trains. */
const bloodPriceSixBoard = () =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 1000 },
      { id: BO, president: P2, trains: ["5", "6"], extra: GILDED("6") },
      { id: NYC, president: P3, trains: ["5"] },
    ],
    step: "Hardware",
    macro: 5,
  });

/** The offer flow of a hosted room: the buyer's president proposes, the seller's accepts, the room derives the sale. */
function offeredSale(seed: GameStateResponse, seller: number, buyer: number, model: string, price: string, gilded: boolean) {
  const room = S.hostedRoom(seed, GULF, [1]);
  const buyerPresident = c(seed, buyer).president!;
  const sellerPresident = c(seed, seller).president!;
  expect(S.submitTo(room, buyerPresident, propose(seller, buyer, model, price, gilded) as never).kind).toBe("applied");
  expect(S.submitTo(room, sellerPresident, answer(seller, true) as never).kind).toBe("applied");
  const settlement = room.entries.find((entry) => entry.derived === true && entry.payload.includes("BuyTrainFromCorporation"));
  expect(settlement).toBeDefined(); // the premise: the derived settlement is in the log
  return room;
}

const restoredFrom = (room: InstanceType<typeof RoomSession>, seed: GameStateResponse) => {
  const restored = new RoomSession({
    providers: S.roomProviders(seed, GULF),
    seed: { state: seed, waterfall: null },
    build: "ur5",
    mintId: () => "x",
    mintSeed: () => {
      throw new Error("a restore must never draw");
    },
  });
  restored.restore(room.entries as never);
  return restored;
};

/* ================================================================== */
/* A / B. OD-UR-6.1 -- THE CORPORATION IS PAID ONE FIGURE, ITS TRAINS PRINTED ANOTHER                          */
/* ================================================================== */

describe("A. one train, the die moves the turn: the corporation's statistics read $70 paid, the train's read $90 printed", () => {
  const board = oneFourTrain();
  const { after, history } = oneStep(board, CO, runMsg(CO, [LONG_ROUTE], [0], ["4"], DOWN_90_TO_70));

  it("the premise: the route is printed $90 and the corporation is paid $70, with no Yellow Sign stage", () => {
    expect(c(after, CO).printed_route_revenue).toBe("90");
    expect(c(after, CO).last_route_revenue).toBe("70");
    expect(c(after, CO).last_run_yellow_sign).toBeUndefined();
  });

  it("corporation / turn: lifetime revenue, the Workhorse, the Juggernaut and the Revenue-per-OR chart read $70", () => {
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(70);
    expect(top(history, "workhorse")).toEqual([P1, 70]);
    expect(top(history, "juggernaut")).toEqual([P1, 70]);
    expect(orRevenue(history, "OR 3.1", CO)).toBe(70);
    expect(autopsyOf(history, CO).payback).toBe(70); // the White Elephant's figure: paid revenue less train spend ($0)
  });

  it("train / route: Master of the Line and the fleet ledger read the 4-train's printed $90", () => {
    expect(top(history, "master-of-the-line")).toEqual([P1, 90]);
    expect(accolade(history, "master-of-the-line").detail).toBe("$90 on C&O's 4-train (OR 3.1)");
    expect(ledger(history, CO, "4")).toMatchObject({ earned: 90, trainRounds: 1 });
  });
});

describe("B. two trains, a total the die raised: $130 paid, and $50 and $60 printed -- no allocation is invented", () => {
  const board = twoTrains();
  const { after, history } = oneStep(board, CO, TWO_RUN(UP_110_TO_130));

  it("the premise: printed $50 + $60 = $110, paid $130", () => {
    expect(c(after, CO).last_run_breakdown).toEqual([
      { train_index: 0, model: "2", printed_revenue: "50" },
      { train_index: 1, model: "3", printed_revenue: "60" },
    ]);
    expect(c(after, CO).printed_route_revenue).toBe("110");
    expect(c(after, CO).last_route_revenue).toBe("130");
  });

  it("the corporation's figures are the $130 it was paid", () => {
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(130);
    expect(top(history, "juggernaut")).toEqual([P1, 130]);
    expect(orRevenue(history, "OR 3.1", CO)).toBe(130);
  });

  it("each train keeps its own printed route -- $50 and $60, not a proportional ($59 / $71) or equal ($65) share", () => {
    expect(ledger(history, CO, "2")?.earned).toBe(50);
    expect(ledger(history, CO, "3")?.earned).toBe(60);
    expect(top(history, "master-of-the-line")).toEqual([P1, 60]);
  });

  it("and the two levels are not expected to agree: the trains' $110 is not the corporation's $130", () => {
    const trains = autopsyOf(history, CO).fleetLedger.reduce((sum, row) => sum + row.earned, 0);
    expect(trains).toBe(110);
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(130);
    expect(trains).not.toBe(autopsyOf(history, CO).lifetimeRevenue);
  });
});

/* ================================================================== */
/* C. OD-UR-6.2 -- THE MARK'S ROUTE WAS NEVER COMPLETED                                                        */
/* ================================================================== */

describe("C. the run-bound Mark (pinned): the taken train's route earns nothing, the kept run is what was paid", () => {
  const board = twoTrains();
  const { after, history } = oneStep(board, CO, TWO_RUN(MARK_110));
  const kept = GV.rollTurnRevenue(60, partsFor(MARK_110)).adjusted;

  it("the premise: the Mark took the 2 and its $50 route in the run's own entry; the 3's $60 was re-rolled and paid", () => {
    expect(c(after, CO).last_run_yellow_sign).toMatchObject({ stage: "mark", model: "2", nullified: { model: "2", printed_revenue: "50" } });
    expect(c(after, CO).owned_trains).toEqual(["3"]);
    expect(Number(c(after, CO).last_route_revenue)).toBe(kept);
  });

  it("corporation / turn: the kept run as paid -- never the $110 the run was priced at", () => {
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(kept);
    expect(top(history, "juggernaut")).toEqual([P1, kept]);
    expect(orRevenue(history, "OR 3.1", CO)).toBe(kept);
  });

  it("train / route: the taken 2 earned nothing and ran no completed route; the 3 earned its printed $60", () => {
    expect(ledger(history, CO, "2")).toMatchObject({ earned: 0, trainRounds: 0 });
    expect(ledger(history, CO, "2")?.fates).toEqual({ rusted: 0, discarded: 0, sold: 0, traded: 0, taken: 1, kept: 0 });
    expect(ledger(history, CO, "3")).toMatchObject({ earned: 60, trainRounds: 1 });
    expect(top(history, "master-of-the-line")).toEqual([P1, 60]);
  });
});

describe("C2. a Mark that takes the only train: the game's would-be best run was never completed, so it wins nothing", () => {
  /* OR 3.1: C&O's 2-train completes $50 (paid $60). OR 3.2 (a constructed jump): C&O holds one 4-train, runs the whole
     line for $90 printed, and the Mark takes the 4 -- the one route, nullified; nothing is kept and nothing is paid. */
  const board1 = urBoard({
    corps: [
      { id: CO, president: P1, trains: ["2"], treasury: 300 },
      { id: BO, president: P2, trains: ["2"] },
    ],
  });
  const run1 = runMsg(CO, [TWO_ROUTE], [0], ["2"], UP_50_TO_60);
  const after1 = reduce(board1, run1);
  const board2 = urBoard({
    corps: [
      { id: CO, president: P1, trains: ["4"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"] },
    ],
    sub: 2,
  });
  const run2 = runMsg(CO, [LONG_ROUTE], [0], ["4"], MARK_90_OR_3_2);
  const after2 = reduce(board2, run2);
  const history = scripted(
    [withoutFleet(board1, CO), board1, after1, board2, after2],
    [
      { msg: NEUTRAL, actor: null },
      { msg: run1, actor: P1 },
      { msg: NEUTRAL, actor: null },
      { msg: run2, actor: P1 },
    ],
  );

  it("the premise: the first run paid $60; the second is the Mark on the only train -- $0 kept, the 4 out of the game", () => {
    expect(c(after1, CO).last_route_revenue).toBe("60");
    expect(c(after2, CO).last_run_yellow_sign).toMatchObject({ stage: "mark", model: "4", nullified: { printed_revenue: "90" } });
    expect(c(after2, CO).owned_trains).toEqual([]);
    expect(c(after2, CO).last_route_revenue).toBe("0");
    expect(after2.removed_trains).toEqual(["4"]);
  });

  it("Master of the Line is the completed $50 route, not the nullified $90 one", () => {
    expect(top(history, "master-of-the-line")).toEqual([P1, 50]);
    expect(accolade(history, "master-of-the-line").detail).toBe("$50 on C&O's 2-train (OR 3.1)");
  });

  it("the taken 4 has no earnings and no completed run; its fate is `taken`", () => {
    expect(ledger(history, CO, "4")).toMatchObject({ earned: 0, trainRounds: 0 });
    expect(ledger(history, CO, "4")?.fates).toMatchObject({ taken: 1, kept: 0 });
    expect(ledger(history, CO, "2")).toMatchObject({ earned: 50, trainRounds: 1 });
  });

  it("D / E. lifetime revenue is the sum of what was paid ($60 + $0), and each Operating Round shows its own", () => {
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(60);
    expect(orRevenue(history, "OR 3.1", CO)).toBe(60);
    expect(orRevenue(history, "OR 3.2", CO)).toBe(0);
    expect(top(history, "juggernaut")).toEqual([P1, 60]);
  });
});

describe("C3. the legacy request (an UNPINNED board): the later Mark settles the run it follows, with the same figures", () => {
  /* The development corpus and a Firestore room keep the client's `YellowSignEvent` (UR-3's legacy path): the run's entry
     is priced whole, and the request -- a later entry of the same turn -- takes the train and its route. The history
     must end where the pinned path does. */
  const board = twoTrains({ pinned: false });
  const run = TWO_RUN(MARK_110);
  const ran = reduce(board, run);
  const request = S.signRequest(CO);
  const marked = reduce(ran, request);
  const history = scripted(
    [withoutFleet(board, CO), board, ran, marked],
    [
      { msg: NEUTRAL, actor: null },
      { msg: run, actor: P1 },
      { msg: request, actor: P1 },
    ],
  );
  const kept = GV.rollTurnRevenue(60, partsFor(MARK_110)).adjusted;

  it("the premise: the run's own entry is whole ($110 printed, no stage); the request's entry is the Mark", () => {
    expect(c(ran, CO).printed_route_revenue).toBe("110");
    expect(c(ran, CO).last_run_yellow_sign).toBeUndefined();
    expect(c(marked, CO).owned_trains).toEqual(["3"]);
    expect(Number(c(marked, CO).last_route_revenue)).toBe(kept);
  });

  it("the same statistics as the pinned Mark: paid the kept run; the 2 nothing; the 3 its printed $60", () => {
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(kept);
    expect(orRevenue(history, "OR 3.1", CO)).toBe(kept);
    expect(top(history, "juggernaut")).toEqual([P1, kept]);
    expect(ledger(history, CO, "2")).toMatchObject({ earned: 0, trainRounds: 0 });
    expect(ledger(history, CO, "2")?.fates).toMatchObject({ taken: 1 });
    expect(ledger(history, CO, "3")).toMatchObject({ earned: 60, trainRounds: 1 });
  });

  it("a STORED legacy Mark with no seed (#1046's ruling, the shape of JUNO-Z6C 203): the corporation was paid nothing", () => {
    /* "It receives no standard route revenue for this submission": both totals zeroed, the breakdown left standing.
       That ruling took the corporation's REVENUE -- paid $0 -- and the Mark's train with its route; the 3-train still
       completed its route, so the per-train statistics keep its printed $60 (6.1 / 6.2). */
    const stored = { YellowSignEvent: { game_id: 1, protocol_id: CO, stage: "mark", model: "2", cash: "40" } };
    const voided = reduce(ran, stored);
    expect(c(voided, CO).last_route_revenue).toBe("0");
    expect(c(voided, CO).printed_route_revenue).toBe("0");
    expect(c(voided, CO).last_run_breakdown).toHaveLength(2); // left standing by the old arm
    const zeroed = scripted(
      [withoutFleet(board, CO), board, ran, voided],
      [
        { msg: NEUTRAL, actor: null },
        { msg: run, actor: P1 },
        { msg: stored, actor: P1 },
      ],
    );
    expect(autopsyOf(zeroed, CO).lifetimeRevenue).toBe(0);
    expect(orRevenue(zeroed, "OR 3.1", CO)).toBe(0);
    expect(ledger(zeroed, CO, "2")).toMatchObject({ earned: 0, trainRounds: 0 });
    expect(ledger(zeroed, CO, "3")).toMatchObject({ earned: 60, trainRounds: 1 });
    expect(top(zeroed, "master-of-the-line")).toEqual([P1, 60]);
  });

  it("a request delayed past the Dividends step (UR-F2's shape) cannot rewrite what was paid; it still takes the route", () => {
    /* The run left $90 and the Dividends step paid on it (withheld); only then did the request land and the kept run
       re-roll to a lower `last_route_revenue`. The corporation was paid $90. The taken 2's route is still not a
       completed route of the train the Mark removed. */
    const paidRun = Number(c(ran, CO).last_route_revenue);
    const declared = reduce(ran, S.declare(CO, paidRun, false));
    expect(Number(c(declared, CO).treasury)).toBe(Number(c(ran, CO).treasury) + paidRun); // the premise: paid out
    const late = reduce(declared, request);
    expect(c(late, CO).owned_trains).toEqual(["3"]); // ... and the late request still applied the Mark
    expect(Number(c(late, CO).last_route_revenue)).toBe(kept);
    expect(kept).not.toBe(paidRun);
    const history = scripted(
      [withoutFleet(board, CO), board, ran, declared, late],
      [
        { msg: NEUTRAL, actor: null },
        { msg: run, actor: P1 },
        { msg: S.declare(CO, paidRun, false), actor: P1 },
        { msg: request, actor: P1 },
      ],
    );
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(paidRun);
    expect(orRevenue(history, "OR 3.1", CO)).toBe(paidRun);
    expect(autopsyOf(history, CO).withheld).toBe(paidRun);
    expect(ledger(history, CO, "2")).toMatchObject({ earned: 0, trainRounds: 0 });
    expect(ledger(history, CO, "3")).toMatchObject({ earned: 60, trainRounds: 1 });
  });
});

/* ================================================================== */
/* G / J. OD-UR-6.3 -- THE CARCOSA GIFT IS ACQUIRED, NOT BOUGHT                                                 */
/* ================================================================== */

describe("G. the Carcosa gift of a 6 is not a purchase", () => {
  const board = giftSixBoard();
  const { after, history } = oneStep(board, CO, runMsg(CO, [LONG_ROUTE], [0], ["5"], GIFT_90));

  it("the premise: the run's own entry gifted a gilded 6 (the phase stays 5)", () => {
    expect(c(after, CO).last_run_yellow_sign).toMatchObject({ stage: "carcosa", model: "6" });
    expect(c(after, CO).owned_trains).toEqual(["5", "6"]);
    expect(c(after, CO).carcosan_trains).toEqual(["6"]);
    expect(GP.derivePhase(after)!.tier).toBe("5");
  });

  it("Fleet Admiral counts the one train C&O bought (its 5), not the gift", () => {
    expect(top(history, "fleet-admiral")).toEqual([P1, 1]);
  });

  it("the fleet ledger still HOLDS the gift (#1431: n = trains held) -- at $0, kept -- and no purchase award moves", () => {
    expect(ledger(history, CO, "6")).toMatchObject({ count: 1, paid: 0 });
    expect(ledger(history, CO, "6")?.fates).toMatchObject({ kept: 1 });
    expect(top(history, "early-adopter")).toEqual([null, 0]);
    expect(top(history, "phase-rusher")).toEqual([null, 0]);
    expect(autopsyOf(history, CO).payback).toBe(autopsyOf(history, CO).lifetimeRevenue); // no train spend
  });
});

describe("J / K. a gifted Diesel is not the first Diesel bought; the first REAL Diesel purchase is", () => {
  const board = giftDieselBoard();
  const run = runMsg(CO, [LONG_ROUTE], [0], ["6"], GIFT_90_OR_6_1);
  const gifted = reduce(board, run);
  const nycTurn = { ...gifted, active_corporation_index: gifted.active_operating_order!.indexOf(NYC), operating_sub_phase: "Hardware" } as GameStateResponse;
  const bought = reduce(nycTurn, buyDepot(NYC, "D"), P3);

  it("the premise: C&O's gift is a gilded D; it is no real Diesel and turns no phase; NYC then buys the first real one", () => {
    expect(c(gifted, CO).last_run_yellow_sign).toMatchObject({ stage: "carcosa", model: "D" });
    expect(c(gifted, CO).carcosan_trains).toEqual(["D"]);
    expect(GP.derivePhase(gifted)!.tier).toBe("6");
    expect(GP.realDieselPurchased(gifted)).toBe(false);
    expect(c(bought, NYC).owned_trains).toEqual(["5", "D"]);
    expect(GP.realDieselPurchased(bought)).toBe(true);
  });

  it("J. the gift alone: no Early Adopter, and Fleet Admiral counts C&O's bought 6 only", () => {
    const history = scripted([withoutFleet(board, CO), board, gifted], [{ msg: NEUTRAL, actor: null }, { msg: run, actor: P1 }]);
    expect(top(history, "early-adopter")).toEqual([null, 0]);
    expect(top(history, "fleet-admiral")).toEqual([P1, 1]);
    expect(ledger(history, CO, "D")).toMatchObject({ count: 1, paid: 0 });
  });

  it("K. then NYC's Depot Diesel: NYC is the Early Adopter -- the corporation that BOUGHT the first Diesel", () => {
    const history = scripted(
      [withoutFleet(board, CO), board, gifted, nycTurn, bought],
      [
        { msg: NEUTRAL, actor: null },
        { msg: run, actor: P1 },
        { msg: NEUTRAL, actor: null },
        { msg: buyDepot(NYC, "D"), actor: P3 },
      ],
    );
    const adopter = accolade(history, "early-adopter");
    expect([adopter.holder, adopter.companyId, adopter.ticker]).toEqual([P3, NYC, "NYC"]);
    expect(adopter.detail).toBe("NYC bought the first Diesel (OR 6.1)");
    expect(ledger(history, NYC, "D")).toMatchObject({ count: 1, paid: GP.depotCostFor(nycTurn, "D") });
  });
});

/* ================================================================== */
/* H / K. OD-UR-6.3 -- THE BLOOD PRICE IS A GENUINE PURCHASE BY THE BUYER                                       */
/* ================================================================== */

describe("H / K. the Blood Price (the hosted offer flow, replayed): the BUYER bought a train", () => {
  it("K. a cured Diesel bought through the Blood Price before any real one: the buyer is the Early Adopter", () => {
    const seed = bloodPriceDieselBoard();
    const room = offeredSale(seed, BO, CO, "D", "300", true);
    expect(c(room.state, CO).owned_trains).toEqual(["5", "D"]); // the premise: C&O holds the cured D
    expect(c(room.state, BO).carcosan_trains).toEqual([]); // ... the Blood Price was paid
    expect(GP.realDieselPurchased(room.state)).toBe(false); // ... and it is no Depot purchase (OD-UR-5(a))
    const history = replayed(seed, room.entries);
    const adopter = accolade(history, "early-adopter");
    expect([adopter.holder, adopter.companyId, adopter.detail]).toEqual([P1, CO, "C&O bought the first Diesel (OR 6.1)"]);
    // Buyer attribution: C&O bought one train (at $300, its train spend); B&O, the seller, bought none -- its D is `sold`.
    expect(accolade(history, "fleet-admiral")).toMatchObject({ holder: P1, companyId: CO, value: 1, runnerUp: null });
    expect(ledger(history, CO, "D")).toMatchObject({ count: 1, paid: 300 });
    expect(top(history, "redeemer")).toEqual([P1, 1]);
    expect(accolade(history, "salt-daddy")).toMatchObject({ holder: P1, value: 1 }); // an intercorporate purchase below the Depot's price
  });

  it("H. a cured 6: purchase count, purchase history and train spend all go to the buyer", () => {
    const seed = bloodPriceSixBoard();
    const room = offeredSale(seed, BO, CO, "6", "300", true);
    expect(c(room.state, CO).owned_trains).toEqual(["5", "6"]);
    expect(c(room.state, CO).ghost_trains).toEqual(["6"]); // the cured copy keeps its synthetic origin -- still bought
    const history = replayed(seed, room.entries);
    expect(accolade(history, "fleet-admiral")).toMatchObject({ holder: P1, companyId: CO, value: 1, runnerUp: null });
    expect(ledger(history, CO, "6")).toMatchObject({ count: 1, paid: 300 });
    expect(autopsyOf(history, CO).payback).toBe(-300); // White Elephant: $300 of train spend, nothing earned yet
    expect(top(history, "early-adopter")).toEqual([null, 0]);
  });
});

/* ================================================================== */
/* I. A CURED COPY BOUGHT LATER FROM THE BANK POOL IS AN ORDINARY PURCHASE                                     */
/* ================================================================== */

describe("I. the cured copy's second life: traded in, then bought from the Bank Pool -- an ordinary purchase", () => {
  /* UR-4's D3: C&O holds a CURED 6 (an earlier Blood Price), trades it in for a Diesel -- the pool keeps its provenance --
     and NYC buys it from the pool, provenance and all. Nothing about it is gilded: it is bought. */
  const board = urBoard({
    corps: [
      { id: CO, president: P1, trains: ["5", "6"], treasury: 1500, extra: CURED("6") },
      { id: BO, president: P2, trains: ["6"] },
      { id: NYC, president: P3, trains: ["5"], treasury: 1500 },
    ],
    step: "Hardware",
    macro: 6,
  });
  const traded = reduce(board, exchange(CO, "6"));
  const nycTurn = { ...traded, active_corporation_index: traded.active_operating_order!.indexOf(NYC) } as GameStateResponse;
  const pooled = reduce(nycTurn, buyPool(NYC, "6"), P3);
  const history = scripted(
    [board, traded, nycTurn, pooled],
    [
      { msg: exchange(CO, "6"), actor: P1 },
      { msg: NEUTRAL, actor: null },
      { msg: buyPool(NYC, "6"), actor: P3 },
    ],
  );

  it("the premise: the pool held the additional copy with its provenance; NYC now holds it, provenance and all", () => {
    expect((traded as GameStateResponse & { returned_ghost_trains?: string[] }).returned_ghost_trains).toEqual(["6"]);
    expect(c(pooled, NYC).owned_trains).toEqual(["5", "6"]);
    expect(c(pooled, NYC).ghost_trains).toEqual(["6"]);
    expect(c(pooled, NYC).carcosan_trains ?? []).toEqual([]);
  });

  it("NYC bought a train: its purchase count and its ledger's price paid", () => {
    expect(ledger(history, NYC, "6")).toMatchObject({ count: 1, paid: GP.depotCostFor(nycTurn, "6") });
    const admiral = accolade(history, "fleet-admiral");
    // C&O's Diesel (the trade-in) and NYC's pool 6: one purchase each; the tie breaks on the final fleet's value.
    expect([admiral.value, admiral.runnerUp]).toEqual([1, 1]);
  });

  it("the trade-in bought the first REAL Diesel: C&O is the Early Adopter (a Diesel exchange is a purchase)", () => {
    expect(accolade(history, "early-adopter")).toMatchObject({ holder: P1, companyId: CO });
  });
});

/* ================================================================== */
/* UR-F9. THE COWBOY COUNTS THE LINE THE TABLE READ                                                            */
/* ================================================================== */

describe("UR-F9. The Cowboy counts the printed flavour line, not the natural one", () => {
  it("a Carcosa gift REPLACES the natural line: an animal line the die drew was never printed", () => {
    const seed = S.seedWhere((s) => {
      const parts = partsFor(s);
      const roll = GV.rollTurnRevenue(90, parts);
      return S.isCarcosaDraw(90, parts) && isAnimalLine(GV.revenueFlavourClause(roll, parts), GV.flavorBucketFor(roll));
    });
    const { after, history } = oneStep(giftSixBoard(), CO, runMsg(CO, [LONG_ROUTE], [0], ["5"], seed));
    expect(c(after, CO).last_run_yellow_sign?.stage).toBe("carcosa"); // the premise
    expect(top(history, "farmhand")).toEqual([null, 0]);
  });

  it("the same on the legacy (unpinned) path, whose run resolves the stage by the shell's own call", () => {
    const seed = S.seedWhere((s) => {
      const parts = partsFor(s);
      const roll = GV.rollTurnRevenue(90, parts);
      return S.isCarcosaDraw(90, parts) && isAnimalLine(GV.revenueFlavourClause(roll, parts), GV.flavorBucketFor(roll));
    });
    const board = urBoard({
      pinned: false,
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 300, extra: { has_yellow_sign: true } },
        { id: BO, president: P2, trains: ["5"] },
        { id: NYC, president: P3, trains: ["5"] },
      ],
    });
    const { history } = oneStep(board, CO, runMsg(CO, [LONG_ROUTE], [0], ["5"], seed));
    expect(top(history, "farmhand")).toEqual([null, 0]);
  });

  it("a run that earned nothing printed no line at all -- and so met no animal", () => {
    /* A run the authority refuses (C&O is not the operating corporation) leaves the board as it was, earning $0; the
       old reading still rolled the die on $0 and counted the line it drew. */
    const seed = S.seedWhere((s) => {
      const parts = partsFor(s);
      const roll = GV.rollTurnRevenue(0, parts);
      return isAnimalLine(GV.revenueFlavourClause(roll, parts), GV.flavorBucketFor(roll));
    });
    const board = urBoard({
      corps: [
        { id: BO, president: P2, trains: ["3"] },
        { id: CO, president: P1, trains: ["2", "3"], treasury: 300 },
      ],
      operating: BO,
    });
    const run = TWO_RUN(seed);
    const after = reduce(board, run);
    expect(c(after, CO).routes_run_this_turn ?? 0).toBe(0); // the premise: refused
    const history = scripted([board, after], [{ msg: run, actor: P1 }]);
    expect(top(history, "farmhand")).toEqual([null, 0]);
  });

  it("control: an ordinary run whose printed line IS an animal line still counts", () => {
    const seed = S.seedWhere((s) => {
      const parts = partsFor(s);
      const roll = GV.rollTurnRevenue(110, parts);
      const line = GV.revenueFlavourClause(roll, parts);
      return line !== YS.YELLOW_SIGN_MALUS_LINE && GV.flavorBucketFor(roll) !== "criticalBonus" && isAnimalLine(line, GV.flavorBucketFor(roll));
    });
    const { after, history } = oneStep(twoTrains(), CO, TWO_RUN(seed));
    expect(c(after, CO).last_run_yellow_sign).toBeUndefined();
    expect(top(history, "farmhand")).toEqual([P1, 1]);
  });
});

/* ================================================================== */
/* CARCOSAN RAILWAYS UNDER OD-UR-5(b)                                                                           */
/* ================================================================== */

describe("Carcosan Railways and The Redeemer when the BUYER pays the Blood Price (OD-UR-5(b))", () => {
  /* #1421: Carcosan Railways is "a president who lived through any of the sequence without paying the Blood Price";
     The Redeemer "paid the Blood Price and took the Carcosan train off another corporation" -- the buyer, always. So a
     seller released by a buyer's Blood Price saw the Sign and never paid it: the logic stands under the buyer-pays ruling
     (only the blurb's "to be rid of it" is stale -- copy, UR-6). */
  const board = giftSixBoard();
  const run = runMsg(CO, [LONG_ROUTE], [0], ["5"], GIFT_90);
  const gifted = reduce(board, run);
  const boTurn = {
    ...gifted,
    active_corporation_index: gifted.active_operating_order!.indexOf(BO),
    operating_sub_phase: "Hardware",
    train_purchase_offer: {
      seller_protocol_id: CO,
      seller_ticker: "C&O",
      seller_president: P1,
      buyer_protocol_id: BO,
      buyer_ticker: "B&O",
      model_type: "6",
      gilded: true,
      price: "300",
      accepted: true,
    },
  } as GameStateResponse;
  const settlement = sale(BO, CO, "6", "300", true);
  const sold = reduce(boTurn, settlement, null);
  const history = scripted(
    [withoutFleet(board, CO), board, gifted, boTurn, sold],
    [
      { msg: NEUTRAL, actor: null },
      { msg: run, actor: P1 },
      { msg: NEUTRAL, actor: null },
      { msg: settlement, actor: null, derived: true },
    ],
  );

  it("the premise: B&O bought the gilded 6 -- the Blood Price paid, C&O absolved", () => {
    expect(c(sold, BO).owned_trains).toEqual(["5", "6"]);
    expect(c(sold, CO).carcosan_trains).toEqual([]);
    expect(c(sold, CO).is_carcosan).toBe(false);
  });

  it("the seller's president keeps Carcosan Railways; the buyer's is The Redeemer", () => {
    expect(top(history, "carcosan-railways")).toEqual([P1, 1]);
    expect(top(history, "redeemer")).toEqual([P2, 1]);
  });

  it("and it is the BUYER's purchase: B&O's ledger holds the 6 at $300; C&O's gift is `sold`, and C&O bought only its 5", () => {
    expect(ledger(history, BO, "6")).toMatchObject({ count: 1, paid: 300 });
    expect(ledger(history, CO, "6")?.fates).toMatchObject({ sold: 1 });
    expect(ledger(history, CO, "6")).toMatchObject({ count: 1, paid: 0 });
    const admiral = accolade(history, "fleet-admiral");
    expect([admiral.value, admiral.runnerUp]).toEqual([1, 1]); // C&O's 5 and B&O's 6: one purchase each
  });
});

/* ================================================================== */
/* L. THE STANDARD GAME IS UNCHANGED                                                                           */
/* ================================================================== */

describe("L. variant off: the statistics are exactly what they were", () => {
  it("a run: the corporation and its trains book the same printed figures -- the Mark's seed is inert", () => {
    const board = twoTrains({ ur: false });
    const { after, history } = oneStep(board, CO, TWO_RUN(MARK_110));
    expect(c(after, CO).last_route_revenue).toBe("110"); // the premise: no die, no Mark
    expect(c(after, CO).owned_trains).toEqual(["2", "3"]);
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(110);
    expect(orRevenue(history, "OR 3.1", CO)).toBe(110);
    expect(top(history, "juggernaut")).toEqual([P1, 110]);
    expect(ledger(history, CO, "2")?.earned).toBe(50);
    expect(ledger(history, CO, "3")?.earned).toBe(60);
    expect(top(history, "master-of-the-line")).toEqual([P1, 60]);
    // Without a die the two levels coincide, as they always have.
    expect(autopsyOf(history, CO).fleetLedger.reduce((sum, row) => sum + row.earned, 0)).toBe(110);
  });

  it("purchases: the Depot's first Diesel is the Early Adopter's and a purchase; an intercorporate sale is the buyer's", () => {
    const board = urBoard({
      ur: false,
      corps: [
        { id: CO, president: P1, trains: ["6"], treasury: 1500 },
        { id: BO, president: P1, trains: ["6", "5"] },
      ],
      step: "Hardware",
      macro: 6,
    });
    const dieselBought = reduce(board, buyDepot(CO, "D"));
    expect(c(dieselBought, CO).owned_trains).toEqual(["6", "D"]);
    const history = scripted([board, dieselBought], [{ msg: buyDepot(CO, "D"), actor: P1 }]);
    expect(accolade(history, "early-adopter")).toMatchObject({ holder: P1, companyId: CO, detail: "C&O bought the first Diesel (OR 6.1)" });
    expect(ledger(history, CO, "D")).toMatchObject({ count: 1, paid: 1100 });

    const exchanged = reduce(board, exchange(CO, "6"));
    const viaExchange = scripted([board, exchanged], [{ msg: exchange(CO, "6"), actor: P1 }]);
    expect(accolade(viaExchange, "early-adopter")).toMatchObject({ holder: P1, companyId: CO });
    expect(accolade(viaExchange, "salvager")).toMatchObject({ holder: P1, companyId: CO, value: 1 });

    const soldOn = reduce(board, sale(CO, BO, "5", "200"));
    expect(c(soldOn, CO).owned_trains).toEqual(["6", "5"]);
    const viaSale = scripted([board, soldOn], [{ msg: sale(CO, BO, "5", "200"), actor: P1 }]);
    expect(accolade(viaSale, "fleet-admiral")).toMatchObject({ holder: P1, companyId: CO, value: 1 });
    expect(ledger(viaSale, CO, "5")).toMatchObject({ count: 1, paid: 200 });
    expect(accolade(viaSale, "early-adopter").holder).toBeNull();
  });
});

/* ================================================================== */
/* M. REPLAY, RESTORE AND UNDO -- THE HISTORY IS A FUNCTION OF THE COMMITTED LOG                                */
/* ================================================================== */

describe("M. replay, restore and undo: the statistics come from the committed log and never draw", () => {
  const seedBoard = () => twoTrains();
  const figures = (history: History) => ({
    accolades: history.accolades,
    autopsy: history.autopsy,
    revenue: history.rounds.map((round) => [round.label, round.corporations.map((corp) => corp.revenue)]),
  });

  it("a hosted Mark and a die: the replayed history books the paid kept run and the printed completed route", () => {
    const room = S.hostedRoom(seedBoard(), GULF, [MARK_110]);
    expect(S.submitTo(room, P1, TWO_RUN(123)).kind).toBe("applied"); // the server's draw replaces the client's
    const kept = GV.rollTurnRevenue(60, partsFor(MARK_110)).adjusted;
    const history = replayed(seedBoard(), room.entries);
    expect(autopsyOf(history, CO).lifetimeRevenue).toBe(kept);
    expect(orRevenue(history, "OR 3.1", CO)).toBe(kept);
    expect(top(history, "master-of-the-line")).toEqual([P1, 60]);
    expect(autopsyOf(history, CO).fleetLedger.find((row) => row.model === "3")?.earned).toBe(60);
  });

  it("replayed twice, the history is identical -- and deriving it never touches a random source", () => {
    const room = S.hostedRoom(seedBoard(), GULF, [UP_110_TO_130]);
    S.submitTo(room, P1, TWO_RUN(1));
    const random = jest.spyOn(Math, "random");
    try {
      const first = replayed(seedBoard(), room.entries);
      const second = replayed(seedBoard(), room.entries);
      expect(random).not.toHaveBeenCalled();
      expect(figures(second)).toEqual(figures(first));
      expect(autopsyOf(first, CO).lifetimeRevenue).toBe(130);
    } finally {
      random.mockRestore();
    }
  });

  it("a restored room's log gives the same history", () => {
    const room = S.hostedRoom(seedBoard(), GULF, [MARK_110]);
    S.submitTo(room, P1, TWO_RUN(1));
    const restored = restoredFrom(room, seedBoard());
    expect(figures(replayed(seedBoard(), restored.entries))).toEqual(figures(replayed(seedBoard(), room.entries)));
  });

  it("an undo past the run and the run again reuse the committed draw: the same statistics as the run alone", () => {
    const once = S.hostedRoom(seedBoard(), GULF, [MARK_110]);
    S.submitTo(once, P1, TWO_RUN(1));
    const undone = S.hostedRoom(seedBoard(), GULF, [MARK_110, 42]);
    S.submitTo(undone, P1, TWO_RUN(1));
    expect(S.submitTo(undone, P1, { RevertTo: { index: 0, player: P1, summary: "undo" } } as never).kind).toBe("applied");
    expect(S.submitTo(undone, P1, TWO_RUN(1)).kind).toBe("applied");
    expect(undone.entries.map((entry) => Object.keys(JSON.parse(entry.payload))[0])).toEqual(["RunMultipleRoutes", "RevertTo", "RunMultipleRoutes"]);
    const a = replayed(seedBoard(), once.entries);
    const b = replayed(seedBoard(), undone.entries);
    expect(b.accolades).toEqual(a.accolades);
    expect(b.autopsy).toEqual(a.autopsy);
    expect(autopsyOf(b, CO).fleetLedger.find((row) => row.model === "3")?.earned).toBe(60);
  });

  it("a Carcosa acquisition through the room: the gift is bought by nobody, in the history of the log and of its restore", () => {
    const room = S.hostedRoom(giftSixBoard(), GULF, [GIFT_90]);
    expect(S.submitTo(room, P1, runMsg(CO, [LONG_ROUTE], [0], ["5"], 1) as never).kind).toBe("applied");
    expect(c(room.state, CO).carcosan_trains).toEqual(["6"]); // the premise: the gift, in the run's own entry
    const history = replayed(giftSixBoard(), room.entries);
    expect(top(history, "fleet-admiral")).toEqual([null, 0]);
    expect(ledger(history, CO, "6")).toMatchObject({ count: 1, paid: 0 });
    expect(figures(replayed(giftSixBoard(), restoredFrom(room, giftSixBoard()).entries))).toEqual(figures(history));
  });

  it("the Blood Price through the room: the replayed and the restored logs agree on the buyer's purchase", () => {
    const seed = bloodPriceDieselBoard();
    const room = offeredSale(seed, BO, CO, "D", "300", true);
    const history = replayed(seed, room.entries);
    expect(figures(replayed(seed, restoredFrom(room, seed).entries))).toEqual(figures(history));
    expect(accolade(history, "early-adopter")).toMatchObject({ holder: P1, companyId: CO });
  });
});

/* ================================================================== */
/* A real Unpredictable Revenue log, and the version                                                            */
/* ================================================================== */

describe("a real Unpredictable Revenue log (JUNO-Z6C through 494, unpinned) and the replay boundary", () => {
  it("each corporation's lifetime revenue is what its runs left for the Dividends step; each train's, its printed routes", () => {
    /* Measured independently of the history: the corpus log replayed by the corpus loader, and at every run the
       figures on the board the run settled -- `last_route_revenue` for the corporation, the breakdown for its trains. */
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const RL = jest.requireActual("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
    const { withEmptyRoster, waterfallForRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
    const SST = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
    const raw = JSON.parse(readFileSync(join(__dirname, "__fixtures__z6cLog.json"), "utf8")) as { entries?: unknown[]; actions?: unknown[] };
    const rows = raw.entries ?? raw.actions ?? [];
    const entries = RL.entriesFromExport(rows as never);
    const seed = {
      state: withEmptyRoster(SST.sandboxScenarioState(SST.DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(SST.sandboxWaterfallState(SST.sandboxScenario(SST.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    };
    const befores: Array<{ msg: Record<string, { protocol_id?: number }>; state: GameStateResponse }> = [];
    const result = RL.replayLog(entries, sandboxReplayProviders(), seed, ({ msg, stateBefore }) => {
      befores.push({ msg: msg as never, state: stateBefore });
    }, DEVELOPMENT_CORPUS_POLICY);
    /* The runs the authority ACCEPTED (its `routes_run_this_turn` rose), read on the board that settled them. No
       accepted run in this log is followed by a Sign request of its own turn (the stored Mark at 203 follows a run the
       current authority refuses), so the board after the run is the settled one. */
    const paid = new Map<number, number>();
    const printed = new Map<string, number>();
    let accepted = 0;
    befores.forEach((step, at) => {
      if (!("RunMultipleRoutes" in step.msg)) return;
      const id = Number(step.msg.RunMultipleRoutes.protocol_id);
      const was = step.state.public_companies.find((company) => company.company_id === id);
      const next = befores[at + 1];
      const after = (next?.state ?? result.state).public_companies.find((company) => company.company_id === id);
      if (!after || (after.routes_run_this_turn ?? 0) <= (was?.routes_run_this_turn ?? 0)) return;
      accepted += 1;
      expect(next && "YellowSignEvent" in next.msg).toBe(false);
      paid.set(id, (paid.get(id) ?? 0) + Math.max(0, Number(after.last_route_revenue ?? 0) || 0));
      for (const run of after.last_run_breakdown ?? []) printed.set(`${id}:${run.model}`, (printed.get(`${id}:${run.model}`) ?? 0) + Number(run.printed_revenue));
    });
    expect(accepted).toBeGreaterThan(10); // the premise: a played game, not a stub
    const history = gameHistoryFrom(rows as never, DEVELOPMENT_CORPUS_POLICY);
    expect(history.autopsy.length).toBeGreaterThan(0);
    for (const corp of history.autopsy) {
      expect([corp.ticker, corp.lifetimeRevenue]).toEqual([corp.ticker, paid.get(corp.companyId) ?? 0]);
      for (const row of corp.fleetLedger) {
        expect([corp.ticker, row.model, row.earned]).toEqual([corp.ticker, row.model, printed.get(`${corp.companyId}:${row.model}`) ?? 0]);
      }
    }
    // Under the die the two levels diverge on a real game -- as the owner expects.
    const trains = history.autopsy.reduce((sum, corp) => sum + corp.fleetLedger.reduce((s, row) => s + row.earned, 0), 0);
    const corporations = history.autopsy.reduce((sum, corp) => sum + corp.lifetimeRevenue, 0);
    expect(trains).not.toBe(corporations);
  });

  it("RULES_ENGINE_VERSION is still 9: UR-5 is derived history, not a rule", () => {
    expect(RULES_ENGINE_VERSION).toBe(9);
  });
});
