/** @jest-environment node */
//
// ==================================================================
//  UR-7 (Variant Certification 1B -- Unpredictable Revenue): THE CONSTRUCTED CERTIFICATION GAME, G1 (TWO TAILS) + G0
// ==================================================================
//
// AUTHORITY: `VARIANT_CERT_UNPREDICTABLE_REVENUE_AUDIT_2026-09-24.md` (the owner rulings OD-UR-1 ... OD-UR-13 and OD-GR-3;
// §3's clauses UR-N1 ... UR-N62; §5.3's invariants R1 - R13; §13.2's interactions X1 - X15; the game's design, §14).
// EVIDENCE: `VARIANT_CERT_UNPREDICTABLE_REVENUE_CERTIFICATION_2026-09-25.md`.
//
// ONE GAME, TWO TAILS, AND ITS STANDARD CONTROL. The starting board, the board-driven script and the driver live in
// `unpredictableRevenueCertificationGame.ts` (provenance in its header). Everything below reads the boards a real
// `RoomSession` produced from those messages -- the room's own derived entries included -- and never writes a board:
//   G1 main path  OR 3.1 the exact $5 tie (10-C) after a refused run, an undo and a re-run that reuse the draw; C&O buys
//                 the first 4 (a Gentle Rust self-trigger) -> OR 3.2 C&O's grace turn: its 2-train's Final Run, the Mark
//                 on the post-settlement fleet, the award minted, the train removed from the game, the trainless
//                 obligation -> set 4 the first 5 and the Carcosa gift ABOVE the phase -> set 5 (N) the first real 6
//                 and the first real D (the doom trigger); C&O's ordinary 6 beside its gold-trimmed one.
//   tail A        the gold-trimmed 6 lives through the whole of set 6 (N+1) and is gone at its end, at the boundary.
//   tail B        the Blood Price, named and paid by the buyer; the cured train's ordinary life -- limit, run, Diesel
//                 trade-in, a Bank Pool purchase, an ordinary sale -- and no fog at the old deadline.
//   G0            the same board and messages with Unpredictable Revenue OFF (Gentle Rust on), through set 3.
// The derived statistics of both tails are read through `gameHistoryFrom` replaying the room's actual log.

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";

export {};

/* The statistics harness (UR-5's device): `gameHistoryFrom` replays a log from the default deal, so while it reads this
   game's log its engine is seeded with this game's starting board instead. Pass-through otherwise -- the rooms below
   run the real engine untouched. */
let mockSeeded: { providers: unknown; seed: { state: GameStateResponse; waterfall: null } } | null = null;
jest.mock("../gameEngine/replayLog", () => {
  const actual = jest.requireActual("../gameEngine/replayLog");
  function RoomEngine(this: unknown, ...args: unknown[]) {
    if (mockSeeded !== null) return new actual.RoomEngine(mockSeeded.providers, mockSeeded.seed);
    return new actual.RoomEngine(...args);
  }
  return { ...actual, RoomEngine };
});

const G = require("./unpredictableRevenueCertificationGame") as typeof import("./unpredictableRevenueCertificationGame");
const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const GV = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const YS = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const GP = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { replayLog, RoomEngine } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { effectiveActions } = require("../gameEngine/logRevert") as typeof import("../gameEngine/logRevert");
const { SERVER_REPLAY_POLICY, RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { countableTrainCount } = require("../gameEngine/trainLimit") as typeof import("../gameEngine/trainLimit");
const { pendingTrainDiscards } = require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { trainObligationFor } = require("../gameEngine/trainAvailability") as typeof import("../gameEngine/trainAvailability");
const { projectBloodPriceMove } = require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const { gameHistoryFrom } = require("./gameHistory") as typeof import("./gameHistory");
const DX = require("../gameEngine/dieselExchange") as typeof import("../gameEngine/dieselExchange");

const { CO, BO, PRR, NYC, CPR, ERIE, P1, P2, P3, BANK_SIZE, NETWORK } = G;
type Run = ReturnType<typeof G.playCertificationGame>;
type History = ReturnType<typeof gameHistoryFrom>;

/* ------------------------------------------------------------------ */
/* The games                                                           */
/* ------------------------------------------------------------------ */

let A: Run;
let B: Run;
let Z: Run;
let historyA: History;
let historyB: History;

const historyOf = (run: Run, start: GameStateResponse): History => {
  mockSeeded = { providers: S.roomProviders(start, NETWORK), seed: { state: start, waterfall: null } };
  try {
    return gameHistoryFrom(run.room.entries.map((entry) => ({ ...entry })) as never);
  } finally {
    mockSeeded = null;
  }
};

beforeAll(() => {
  A = G.playCertificationGame({ tail: "A", stop: G.atStockRound(7) });
  B = G.playCertificationGame({ tail: "B", stop: G.atStockRound(7) });
  Z = G.playCertificationGame({ tail: "A", start: { unpredictableRevenue: false }, stop: G.atStockRound(4) });
  historyA = historyOf(A, G.certificationStart());
  historyB = historyOf(B, G.certificationStart());
});

/* ------------------------------------------------------------------ */
/* Reading boards                                                      */
/* ------------------------------------------------------------------ */

const co = (state: GameStateResponse, id: number): PublicCompanyState => state.public_companies.find((entry) => entry.company_id === id)!;
const fleetOf = (state: GameStateResponse, id: number) => [...(co(state, id).owned_trains ?? [])];
const gildedOf = (state: GameStateResponse, id: number) => [...(co(state, id).carcosan_trains ?? [])];
const provenanceOf = (state: GameStateResponse, id: number) => [...(co(state, id).ghost_trains ?? [])];
const treasury = (state: GameStateResponse, id: number) => Number(co(state, id).treasury);
const cash = (state: GameStateResponse, player: string) => Number(state.player_cash.find((row) => row.player === player)!.cash_vgp);
const bank = (state: GameStateResponse) => Number(state.virtual_bank_vgp);
const phase = (state: GameStateResponse) => GP.derivePhase(state)?.tier ?? null;
const limit = (state: GameStateResponse) => GP.derivePhase(state)!.trainLimit;
const countable = (state: GameStateResponse, id: number) => {
  const c = co(state, id);
  return countableTrainCount(c.owned_trains, c.pending_rust_trains, c.carcosan_trains);
};
const row = (state: GameStateResponse, tier: string) => GP.depotInventory(state).find((entry) => entry.tier === tier)!;
const removed = (state: GameStateResponse) => [...((state as GameStateResponse & { removed_trains?: readonly string[] }).removed_trains ?? [])];
const poolProvenance = (state: GameStateResponse) =>
  [...((state as GameStateResponse & { returned_ghost_trains?: readonly string[] }).returned_ghost_trains ?? [])];
const marker = (state: GameStateResponse, id: number) => state.market_positions?.[id] ?? null;
const orTag = (state: GameStateResponse) => `${state.current_round_type} ${state.macro_round_number}.${state.sub_round_index}`;
const TIER_ORDER = ["2", "3", "4", "5", "6", "D"];

/** Every board the room held, one per log entry: `boards[i]` is the board right after entry `i` -- the room's own two
 *  paths, the engine's `apply` for an ordinary entry and a rebuild of the effective log for a `RevertTo` (#1233).
 *  Computed once per run; the restart evidence (a `RoomSession.restore`) is its own test below. */
const boardsCache = new Map<Run, GameStateResponse[]>();
function boardsOf(run: Run): GameStateResponse[] {
  const cached = boardsCache.get(run);
  if (cached) return cached;
  const start = G.certificationStart(run === Z ? { unpredictableRevenue: false } : {});
  const providers = S.roomProviders(start, NETWORK);
  const seed = { state: start, waterfall: null };
  let engine = new RoomEngine(providers, seed);
  const boards: GameStateResponse[] = [];
  const log = run.room.entries.map((entry) => ({ index: entry.index, id: entry.id, actor: entry.actor, payload: entry.payload }));
  log.forEach((entry, at) => {
    if ("RevertTo" in JSON.parse(entry.payload)) {
      engine = new RoomEngine(providers, seed);
      for (const kept of effectiveActions(log.slice(0, at + 1))) engine.apply(kept);
    } else {
      engine.apply(entry);
    }
    boards.push(engine.snapshot.state);
  });
  boardsCache.set(run, boards);
  return boards;
}
const payloadOf = (run: Run, index: number) => JSON.parse(run.room.entries[index].payload) as Record<string, Record<string, unknown>>;
const kindOf = (run: Run, index: number) => Object.keys(payloadOf(run, index))[0];
/** The log index of a played step's OWN entry (its first appended entry). */
const ownIndex = (run: Run, label: string) => run.find(label).indices[0];

/** The played steps of `run` that ran a corporation's routes and were accepted, in order. */
const runSteps = (run: Run, id: number) =>
  run.played.filter((p) => p.kind === "applied" && "RunMultipleRoutes" in (p.step.msg as object) && Number((p.step.msg as { RunMultipleRoutes: { protocol_id: number } }).RunMultipleRoutes.protocol_id) === id);

/* ------------------------------------------------------------------ */
/* The game is legal, deterministic and replays                        */
/* ------------------------------------------------------------------ */

describe("the game: every scripted step sent, money conserved (the Mark's award minted), the phase never falls back", () => {
  it("every scripted step of the main path and of each tail was sent, with the answer the script expected", () => {
    const labels = (run: Run) => new Set(run.played.map((p) => p.step.label));
    for (const event of G.MAIN_EVENTS) for (const s of event.steps) {
      expect([s.label, labels(A).has(s.label), labels(B).has(s.label)]).toEqual([s.label, true, true]);
    }
    for (const event of G.TAIL_B_EVENTS) for (const s of event.steps) expect([s.label, labels(B).has(s.label)]).toEqual([s.label, true]);
    for (const event of G.TAIL_B_EVENTS) for (const s of event.steps) expect([s.label, labels(A).has(s.label)]).toEqual([s.label, false]);
    expect(A.room.state.current_round_type).toBe("StockRound");
    expect(A.room.state.macro_round_number).toBe(7);
    expect(B.room.state.macro_round_number).toBe(7);
  });

  it("bank + player cash + treasuries is $12,000 at every board until the Mark, and $12,150 after it -- the award is found money (OD-UR-4)", () => {
    for (const run of [A, B]) {
      const markAt = ownIndex(run, "3.2 C&O runs");
      boardsOf(run).forEach((board, index) => {
        expect([index, moneyTotal(board)]).toEqual([index, index < markAt ? BANK_SIZE : BANK_SIZE + YS.markPayout("4")]);
      });
    }
    // The standard control mints nothing.
    boardsOf(Z).forEach((board, index) => expect([index, moneyTotal(board)]).toEqual([index, BANK_SIZE]));
  });

  it("the phase never decreases at any entry of either tail (OD-UR-13's invariant): 3 -> 4 -> 5 -> 6 -> D, each once", () => {
    for (const run of [A, B]) {
      let high = TIER_ORDER.indexOf(phase(G.certificationStart())!);
      const reached: string[] = [];
      for (const board of boardsOf(run)) {
        const at = TIER_ORDER.indexOf(phase(board)!);
        expect(at).toBeGreaterThanOrEqual(high);
        if (at > high) reached.push(phase(board)!);
        high = Math.max(high, at);
      }
      expect(reached).toEqual(["4", "5", "6", "D"]);
    }
  });

  it("the variants are the deal's for the whole game: no entry of either tail (or of G0) changes them (UR-N2)", () => {
    for (const [run, start] of [[A, G.certificationStart()], [B, G.certificationStart()], [Z, G.certificationStart({ unpredictableRevenue: false })]] as const) {
      const want = JSON.stringify(start.variants);
      for (const board of boardsOf(run)) expect(JSON.stringify(board.variants)).toBe(want);
    }
  });

  it("a turn's draw is board state for its own turn only: every earning turn opens with no recorded draw (UR-N21, R6)", () => {
    for (const run of [A, B]) {
      for (const p of run.played.filter((q) => q.before.current_round_type === "OperatingRound" && q.before.operating_sub_phase === "Track")) {
        const id = G.operatingCorp(p.before)!;
        if (id !== CO && id !== BO) continue;
        expect([orTag(p.before), id, co(p.before, id).last_run_revenue_seed]).toEqual([orTag(p.before), id, undefined]);
      }
    }
  });

  it("the two tails are ONE game until the Blood Price: identical entries and boards, step for step", () => {
    const branch = B.played.findIndex((p) => p.step.label === "B&O offers for C&O's 6 without naming the copy -- refused");
    expect(branch).toBeGreaterThan(0);
    expect(G.runFingerprint(A).slice(0, branch)).toEqual(G.runFingerprint(B).slice(0, branch));
    const shared = B.played[branch].before;
    expect(stateDigest(A.played[branch].before)).toBe(stateDigest(shared));
  });
});

describe("the draws: the server drew once per turn, only where the script armed it, and each seed is the stage it names (R1, R4, R5)", () => {
  it("each draw re-derives its stage from its own seed, and the room committed exactly that seed on the run", () => {
    for (const run of [A, B]) {
      const committed = run.room.entries
        .filter((entry) => "RunMultipleRoutes" in JSON.parse(entry.payload))
        .map((entry) => JSON.parse(entry.payload).RunMultipleRoutes as { revenue_seed: number; revenue_turn: string });
      for (const draw of run.draws) {
        expect([draw.turn, draw.stage, G.drawReaches(draw, draw.seed)]).toEqual([draw.turn, draw.stage, true]);
        // Every committed run of that turn carries the drawn seed.
        const ofTurn = committed.filter((body) => body.revenue_turn === draw.turn);
        expect(ofTurn.length).toBeGreaterThan(0);
        for (const body of ofTurn) expect(body.revenue_seed).toBe(draw.seed);
      }
      // One draw per turn that ran -- the undo's re-run drew nothing (#1051 / OD-UR-11).
      expect(new Set(run.draws.map((d) => d.turn)).size).toBe(run.draws.length);
      expect(new Set(committed.map((body) => body.revenue_turn)).size).toBe(run.draws.length);
      expect(committed.length).toBe(run.draws.length + 1); // the one re-run after the undo
    }
    expect(A.draws.map((d) => `${d.turn}:${d.stage}`).filter((s) => !s.endsWith(":quiet"))).toEqual(["3.1.5:tie+10", "3.2.5:mark", "4.2.5:carcosa"]);
    // The quiet runs meet every face the Sign cannot read (2, 3, 4, 5, and 6 on an unmarked corporation) and the die
    // moves some of them: the paid figure is not the printed one on every run.
    const faces = new Set(A.draws.filter((d) => d.stage === "quiet").map((d) => GV.revenueDieFace({ macroRound: d.macro, subRound: d.sub, companyId: d.corp, turnSeed: d.seed })));
    for (const face of [2, 3, 4, 5]) expect([face, faces.has(face)]).toEqual([face, true]);
  });

  it("the printed total each draw was armed for is the printed total the run scored on the board", () => {
    for (const run of [A, B]) {
      const steps = run.played.filter((p) => p.kind === "applied" && "RunMultipleRoutes" in (p.step.msg as object));
      const firstOfTurn = new Map<string, number>();
      for (const p of steps) {
        const body = (p.step.msg as { RunMultipleRoutes: { protocol_id: number } }).RunMultipleRoutes;
        const turn = G.drawKey(p.before.macro_round_number ?? 0, p.before.sub_round_index ?? 0, Number(body.protocol_id));
        if (!firstOfTurn.has(turn)) firstOfTurn.set(turn, Number((co(boardsOf(run)[p.indices[0]], Number(body.protocol_id)).last_run_breakdown ?? []).reduce((n, r) => n + Number(r.printed_revenue), 0)));
      }
      for (const draw of run.draws) {
        if (draw.stage === "mark") continue; // the Mark's own entry leaves only the kept route in the breakdown (below)
        expect([draw.turn, firstOfTurn.get(draw.turn)]).toEqual([draw.turn, draw.printed]);
      }
    }
  });

  it("a replay under the server's policy and a restart from the stored log reach every tail's final board, drawing nothing", () => {
    for (const run of [A, B]) {
      const start = G.certificationStart();
      const replayed = replayLog(
        run.room.entries.map((entry) => ({ index: entry.index, id: entry.id, actor: entry.actor, payload: entry.payload })),
        S.roomProviders(start, NETWORK),
        { state: start, waterfall: null },
        undefined,
        SERVER_REPLAY_POLICY,
      );
      expect(stateDigest(replayed.state)).toBe(stateDigest(run.room.state));
      const restarted = new RoomSession({
        providers: S.roomProviders(start, NETWORK),
        seed: { state: start, waterfall: null },
        build: G.BUILD,
        mintId: () => "x",
        mintSeed: () => {
          throw new Error("a restore must never draw");
        },
      });
      restarted.restore(run.room.entries as never);
      expect(stateDigest(restarted.state)).toBe(stateDigest(run.room.state));
      expect(stateDigest(boardsOf(run)[run.room.entries.length - 1])).toBe(stateDigest(run.room.state));
    }
  });

  it("a restart part-way -- after the tie, after the Mark, after the gift, after the D -- is the board the room held there", () => {
    const start = G.certificationStart();
    for (const label of ["3.1 C&O pays out $50", "3.2 C&O runs", "4.2 C&O runs", "PRR buys the FIRST real D"]) {
      const played = A.find(label);
      const last = played.indices[played.indices.length - 1];
      const restarted = new RoomSession({
        providers: S.roomProviders(start, NETWORK),
        seed: { state: start, waterfall: null },
        build: G.BUILD,
        mintId: () => "x",
        mintSeed: () => {
          throw new Error("a restore must never draw");
        },
      });
      restarted.restore(A.room.entries.slice(0, last + 1) as never);
      expect([label, stateDigest(restarted.state)]).toEqual([label, stateDigest(played.after)]);
      expect([label, stateDigest(boardsOf(A)[last])]).toEqual([label, stateDigest(played.after)]);
    }
  });

  it("the deal is pinned to the engine's version -- 10 or later, the version Unpredictable Revenue is certified at (UR-8)", () => {
    /* UR-8: was `toBe(9)` for both ("still 9 -- the v10 boundary is UR-8's"). The game is dealt at the current engine, so
       it now plays -- and replays under SERVER_REPLAY_POLICY -- at 10; the current number belongs to
       `unpredictableRevenueClosure.test.ts`. Version-literal only: no stage, board or digest of this game moved. */
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(10);
    for (const run of [A, B, Z]) expect(run.room.state.rules_engine_version).toBe(RULES_ENGINE_VERSION);
  });
});

/* ------------------------------------------------------------------ */
/* 1. The Unpredictable Revenue turn: the exact $5 tie                  */
/* ------------------------------------------------------------------ */

describe("1. OR 3.1 -- C&O's lone 2-train, +10% on $50: the exact $5 tie pays $50 (OD-UR-10 = 10-C, UR-F20)", () => {
  it("a shortfall run is refused first: nothing appended, nothing drawn, nothing revealed (R3)", () => {
    const refused = A.find("C&O's shortfall run is refused");
    expect(refused.kind).toBe("refused");
    expect(refused.indices).toEqual([]);
    expect(stateDigest(refused.after)).toBe(stateDigest(refused.before));
    expect(A.draws.filter((d) => d.turn === "3.1.5")).toHaveLength(1);
  });

  it("the run: printed $50, the draw is face 5 (+10%), and the board pays $50 -- half up would have paid $60", () => {
    const board = boardsOf(A)[ownIndex(A, "3.1 C&O runs")];
    const c = co(board, CO);
    const draw = A.draws.find((d) => d.turn === "3.1.5")!;
    const parts = { macroRound: 3, subRound: 1, companyId: CO, turnSeed: draw.seed };
    expect(GV.revenueDieFace(parts)).toBe(5);
    expect(c.printed_route_revenue).toBe("50");
    expect(c.last_run_breakdown).toEqual([{ train_index: 0, model: "2", printed_revenue: "50" }]);
    expect(c.last_route_revenue).toBe("50");
    expect(GV.rollTurnRevenue(50, parts)).toEqual({ face: 5, percent: 110, printed: 50, adjusted: 50 });
    expect(GV.roundToTen(GV.applyRevenuePercent(50, 110))).toBe(60);
    // The Activity Log's sentence for the turn names the paid figure and no bonus (UR-N14: judged on the figures).
    const sentence = GV.turnRevenueSentence("C&O", GV.rollTurnRevenue(50, parts), parts);
    expect(sentence.startsWith("C&O ran for $50. ")).toBe(true);
    expect(sentence).not.toMatch(/bonus|malus/);
  });

  it("the undo: the board returns to before the run; the re-run commits the SAME draw and reaches the same board (OD-UR-11)", () => {
    const beforeRun = A.find("3.1 C&O runs").before;
    expect(stateDigest(A.at("C&O undoes its run"))).toBe(stateDigest(beforeRun));
    const first = JSON.parse(A.room.entries[ownIndex(A, "3.1 C&O runs")].payload).RunMultipleRoutes.revenue_seed;
    const again = JSON.parse(A.room.entries[ownIndex(A, "C&O runs the same turn again")].payload).RunMultipleRoutes.revenue_seed;
    expect(again).toBe(first);
    // Reused, not redrawn: the server drew for this turn exactly once (the script's arm throws on an unplanned draw).
    expect(A.draws.filter((d) => d.turn === "3.1.5")).toHaveLength(1);
    expect(stateDigest(A.at("C&O runs the same turn again"))).toBe(stateDigest(A.at("3.1 C&O runs")));
  });

  it("the payout: $5 a share -- P1 (60%) +$30, P2 and P3 (20%) +$10 each, the bank -$50, the treasury untouched, the marker right", () => {
    const before = A.before("3.1 C&O pays out $50");
    const after = A.at("3.1 C&O pays out $50");
    expect([cash(after, P1) - cash(before, P1), cash(after, P2) - cash(before, P2), cash(after, P3) - cash(before, P3)]).toEqual([30, 10, 10]);
    expect(bank(after) - bank(before)).toBe(-50);
    expect(treasury(after, CO)).toBe(treasury(before, CO));
    expect(marker(after, CO)!.price).toBeGreaterThan(marker(before, CO)!.price);
  });

  it("Private Company income is outside the die: at OR 3.2's opening the Schuylkill Valley pays C&O's treasury $5, and the run's paid figure is the routes' alone (UR-N12)", () => {
    const endOf31 = A.at("C&O buys the FIRST 4");
    const opening = A.played.find((p) => p.before.sub_round_index === 1 && p.after.sub_round_index === 2)!;
    expect(treasury(opening.after, CO) - treasury(endOf31, CO)).toBe(5);
    const mark = co(boardsOf(A)[ownIndex(A, "3.2 C&O runs")], CO);
    expect(mark.last_route_revenue).toBe(String(GV.rollTurnRevenue(Number(mark.printed_route_revenue), { macroRound: 3, subRound: 2, companyId: CO, turnSeed: mark.last_run_revenue_seed! }).adjusted));
  });
});

/* ------------------------------------------------------------------ */
/* 2 + 3. The Mark on a Gentle Rust grace turn                          */
/* ------------------------------------------------------------------ */

describe("2 + 3. OR 3.2 -- the Mark on C&O's Gentle Rust grace turn (OD-UR-1, OD-GR-3, OD-UR-4, OD-UR-13)", () => {
  const markBoard = () => boardsOf(A)[ownIndex(A, "3.2 C&O runs")];

  it("going in: C&O holds [2, 4], its 2-train marked by its own first 4 -- this turn is the 2's Final Run", () => {
    const before = A.before("3.2 C&O runs");
    expect(fleetOf(before, CO)).toEqual(["2", "4"]);
    expect(co(before, CO).pending_rust_trains).toEqual(["2"]);
    expect(phase(before)).toBe("4");
  });

  it("the run's OWN entry applies the Mark on the post-settlement fleet: the 2 was destroyed by its Final Run, so the Mark took the 4 -- never the 2", () => {
    const c = co(markBoard(), CO);
    expect(c.owned_trains).toEqual([]);
    expect(c.pending_rust_trains).toEqual([]);
    expect(c.has_yellow_sign).toBe(true);
    expect(c.last_run_yellow_sign).toEqual({
      stage: "mark",
      model: "4",
      award: String(YS.markPayout("4")),
      nullified: { train_index: 1, model: "4", printed_revenue: "60" },
    });
    // On the fleet AS IT RAN the cheapest train was the 2 ($80): the ruling is that it is never a candidate.
    expect(YS.lowestValueTrain(["2", "4"])).toBe("2");
    expect(YS.lowestValueTrain(["4"])).toBe("4");
  });

  it("the taken 4's route earns nothing; the Final Run 2's $50 stands and is paid at the turn's own face: $40", () => {
    const c = co(markBoard(), CO);
    const draw = A.draws.find((d) => d.turn === "3.2.5")!;
    expect(draw.printed).toBe(110);
    expect(c.printed_route_revenue).toBe("50");
    expect(c.last_run_breakdown).toEqual([{ train_index: 0, model: "2", printed_revenue: "50" }]);
    const parts = { macroRound: 3, subRound: 2, companyId: CO, turnSeed: draw.seed };
    expect(GV.revenueDieFace(parts)).toBe(1);
    expect(c.last_route_revenue).toBe(String(GV.rollTurnRevenue(50, parts).adjusted));
    expect(c.last_route_revenue).toBe("40");
  });

  it("the Activity Log's narration reads the board the run left: the Mark, the 4 taken, $150, the kept route's $40 (R8, UR-N23)", () => {
    const run = A.find("3.2 C&O runs");
    const draw = A.draws.find((d) => d.turn === "3.2.5")!;
    const report = YS.narrateRunYellowSign(run.before, markBoard(), CO, { macroRound: 3, subRound: 2, companyId: CO, turnSeed: draw.seed });
    expect(report.resolution).toEqual({ line: YS.YELLOW_SIGN_MALUS_LINE, stage: "mark" });
    expect([report.taken, report.award, report.kept?.adjusted]).toEqual(["4", 150, 40]);
    // And the tie turn narrates no stage at all.
    const tie = A.find("C&O runs the same turn again");
    const tieDraw = A.draws.find((d) => d.turn === "3.1.5")!;
    expect(YS.narrateRunYellowSign(tie.before, tie.after, CO, { macroRound: 3, subRound: 1, companyId: CO, turnSeed: tieDraw.seed }).resolution.stage).toBeNull();
  });

  it("the award is half the taken train's face value, minted: the treasury +$150 in the run's entry, the Bank untouched", () => {
    const before = A.before("3.2 C&O runs");
    expect(treasury(markBoard(), CO) - treasury(before, CO)).toBe(150);
    expect(bank(markBoard())).toBe(bank(before));
  });

  it("the taken 4 is removed from the game: recorded, off the Depot, never the Bank Pool, never sold again, the phase stays", () => {
    expect(removed(markBoard())).toEqual(["4"]);
    expect(markBoard().returned_trains ?? []).toEqual([]);
    expect(phase(markBoard())).toBe("4");
    // Four 4-trains were printed: C&O's first (removed), PRR's, CPR's and C&O's second -- the last one sold made the
    // Depot's head the 5, and the removed copy never came back as stock.
    const afterLast4 = A.at("C&O, trainless after the Mark, buys a 4");
    expect(row(afterLast4, "4").remaining).toBe(0);
    for (const board of boardsOf(A).slice(ownIndex(A, "3.2 C&O runs"))) expect(removed(board)).toEqual(["4"]);
  });

  it("nothing a client sends can add, repeat, redirect or force a stage: all three requests refused, nothing appended (OD-UR-1)", () => {
    for (const label of [
      "a client's Yellow Sign request for C&O is refused",
      "a client's Yellow Sign request aimed at B&O is refused",
      "a forced Yellow Sign request is refused",
    ]) {
      const p = A.find(label);
      expect([label, p.kind, p.indices, p.reason]).toEqual([label, "refused", [], YS.yellowSignRequestRefusal(p.before)]);
    }
    expect(A.room.entries.some((entry) => "YellowSignEvent" in JSON.parse(entry.payload))).toBe(false);
  });

  it("S10-27, reproduced live and not fixed here: the room derives a $0 withhold for the trainless C&O, the reducer declines it, and the president declares the $40", () => {
    const run = A.find("3.2 C&O runs");
    expect(run.entries).toEqual(["RunMultipleRoutes", "DeclareDividends*"]);
    const derived = payloadOf(A, run.indices[1]).DeclareDividends;
    expect(derived.revenue_amount).toBe("0");
    expect(stateDigest(boardsOf(A)[run.indices[1]])).toBe(stateDigest(boardsOf(A)[run.indices[0]]));
    const declared = A.find("3.2 C&O withholds $40");
    expect(treasury(declared.after, CO) - treasury(declared.before, CO)).toBe(40);
  });

  it("trainless with a route: the ordinary obligation holds -- the turn may not end until C&O buys a train (UR-N34, X8)", () => {
    const refused = A.find("C&O, trainless after the Mark, may not end its turn");
    expect(refused.kind).toBe("refused");
    expect(refused.indices).toEqual([]);
    expect(trainObligationFor(refused.before, CO, NETWORK)).toEqual({
      owed: true,
      reason: "C&O owns no train and has a route to run, so it must acquire one before its turn ends — the cheapest for sale is a 4-train at $300.",
    });
    expect(fleetOf(A.at("C&O, trainless after the Mark, buys a 4"), CO)).toEqual(["4"]);
  });

  it("the paired standard control (G0): the same messages with the variant off pay $110 printed, take nothing, mint nothing", () => {
    const c = co(boardsOf(Z)[ownIndex(Z, "3.2 C&O runs")], CO);
    expect(c.owned_trains).toEqual(["4"]); // the 2 still retired by its Final Run -- Gentle Rust is on in both
    expect(c.last_route_revenue).toBe("110");
    expect(c.printed_route_revenue).toBe("110");
    expect(c.has_yellow_sign).toBeUndefined();
    expect(c.last_run_yellow_sign).toBeUndefined();
    expect(removed(boardsOf(Z)[ownIndex(Z, "3.2 C&O runs")])).toEqual([]);
    // No trainless turn, so the script's obligation steps are never sent; the refused requests are refused there too.
    expect(Z.played.some((p) => p.step.label.startsWith("C&O, trainless"))).toBe(false);
    expect(Z.find("a client's Yellow Sign request for C&O is refused").reason).toBe(YS.yellowSignRequestRefusal(Z.find("a client's Yellow Sign request for C&O is refused").before));
  });

  it("G0's tie turn pays its printed $50 -- at an exact tie 10-C pays printed too, so the grace-turn control above is the one that shows no die; nowhere in G0 does any Sign field appear (UR-N3, X10, R9)", () => {
    const c = co(boardsOf(Z)[ownIndex(Z, "3.1 C&O runs")], CO);
    expect(c.last_route_revenue).toBe("50");
    expect(c.printed_route_revenue).toBe("50");
    for (const board of boardsOf(Z)) {
      for (const entry of board.public_companies) {
        expect([entry.ticker, entry.has_yellow_sign ?? null, entry.is_carcosan ?? null, (entry.carcosan_trains ?? []).length]).toEqual([entry.ticker, null, null, 0]);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. The Carcosa gift                                                 */
/* ------------------------------------------------------------------ */

describe("4. OR 4.2 -- the Carcosa gift, ABOVE the phase (OD-UR-3, #1672)", () => {
  const giftBoard = () => boardsOf(A)[ownIndex(A, "4.2 C&O runs")];
  const before = () => A.before("4.2 C&O runs");

  it("going in: phase 5, every 5 sold -- the Depot's lowest train is a 6; C&O is the Marked corporation", () => {
    expect(phase(before())).toBe("5");
    expect(row(before(), "5").remaining).toBe(0);
    expect(GP.openDepotTiers(before())[0].tier).toBe("6");
    expect(co(before(), CO).has_yellow_sign).toBe(true);
  });

  it("the run's own entry applies Carcosa: the gift is the Depot's lowest-value train (a 6), gold-trimmed, synthetic, and the Sign's flag passes", () => {
    const c = co(giftBoard(), CO);
    expect(YS.carcosaGiftModel(before(), "5")).toBe("6");
    expect(c.owned_trains).toEqual(["4", "5", "6"]);
    expect(c.carcosan_trains).toEqual(["6"]);
    expect(c.ghost_trains).toEqual(["6"]);
    expect(c.is_carcosan).toBe(true);
    expect(c.has_yellow_sign).toBe(false);
    expect(c.last_run_yellow_sign).toEqual({ stage: "carcosa", model: "6", award: "0", nullified: null });
    const draw = A.draws.find((d) => d.turn === "4.2.5")!;
    expect(draw.printed).toBe(140);
    expect(c.last_route_revenue).toBe(String(GV.rollTurnRevenue(140, { macroRound: 4, subRound: 2, companyId: CO, turnSeed: draw.seed }).adjusted));
  });

  it("the Activity Log's narration names the gift the board holds (R8)", () => {
    const draw = A.draws.find((d) => d.turn === "4.2.5")!;
    const report = YS.narrateRunYellowSign(before(), giftBoard(), CO, { macroRound: 4, subRound: 2, companyId: CO, turnSeed: draw.seed });
    expect(report.resolution).toEqual({ line: YS.YELLOW_SIGN_BONUS_LINE, stage: "carcosa" });
    expect(report.gifted).toBe("6");
  });

  it("the gift advances nothing: phase 5 stays, the 6 row is untouched, no 3-train is marked, no doom clock (no real Diesel)", () => {
    expect(phase(giftBoard())).toBe("5");
    expect(row(giftBoard(), "6").remaining).toBe(row(before(), "6").remaining);
    for (const entry of giftBoard().public_companies) expect([entry.ticker, entry.pending_rust_trains ?? []]).toEqual([entry.ticker, co(before(), entry.company_id).pending_rust_trains ?? []]);
    expect(co(giftBoard(), CO).carcosan_doom_after_macro_round).toBeUndefined();
    expect(GP.realDieselPurchased(giftBoard())).toBe(false);
  });

  it("the gold-trimmed 6 occupies no slot: three trains at limit 2, no discard owed", () => {
    expect(limit(giftBoard())).toBe(2);
    expect(countable(giftBoard(), CO)).toBe(2);
    expect(pendingTrainDiscards(giftBoard())).toBeNull();
  });

  it("the first REAL 6 then does what the gift did not: phase 6, every 3-train marked (Gentle Rust), by its buyer", () => {
    const bought = A.find("ERIE buys the FIRST real 6");
    expect(phase(bought.before)).toBe("5");
    expect(phase(bought.after)).toBe("6");
    for (const id of [NYC, PRR, CPR, ERIE, BO]) {
      expect([id, co(bought.after, id).pending_rust_trains ?? []]).toEqual([id, (co(bought.before, id).owned_trains ?? []).filter((m) => m === "3")]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. The fog at the end of set N + 1 (tail A)                          */
/* ------------------------------------------------------------------ */

describe("5. tail A -- the first real D in set 5 is the doom trigger; the gold-trimmed 6 lives through set 6 and is gone at its END (OD-UR-2)", () => {
  it("the first real D (set N = 5) sets the deadline: after set 6", () => {
    const d = A.find("PRR buys the FIRST real D");
    expect(d.before.macro_round_number).toBe(5);
    expect(phase(d.after)).toBe("D");
    expect(co(d.after, CO).carcosan_doom_after_macro_round).toBe(6);
  });

  it("C&O's ordinary 6 beside the gold-trimmed one: three trains at limit 2, no discard; the room ends its Buy Trains at the limit", () => {
    const bought = A.find("C&O buys the last real 6");
    expect(bought.entries).toEqual(["BuyHardwareFromPool", "PassTurn*"]);
    const board = boardsOf(A)[bought.indices[0]];
    expect(fleetOf(board, CO)).toEqual(["5", "6", "6"]);
    expect(gildedOf(board, CO)).toEqual(["6"]);
    expect([countable(board, CO), limit(board)]).toEqual([2, 2]);
    expect(pendingTrainDiscards(board)).toBeNull();
  });

  it("no gold-trimmed Diesel trade-in (OD-UR-7): of C&O's two 6s only the ordinary copy may be traded", () => {
    const board = boardsOf(A)[A.find("C&O buys the last real 6").indices[0]];
    expect(DX.exchangeableTrains(co(board, CO)).filter((m) => m === "6")).toHaveLength(1);
    // The gold-trimmed copy stays out of every exchange for its whole life (every board of set 6).
    for (const b of boardsOf(A).filter((x) => x.macro_round_number === 6 && x.current_round_type === "OperatingRound")) {
      expect(DX.exchangeableTrains(co(b, CO)).filter((m) => m === "6").length).toBeLessThanOrEqual(1);
    }
  });

  it("through every board of set 6 -- every entry of OR 6.1, 6.2 and 6.3 -- C&O still holds the gold-trimmed 6, and runs a 6 each round", () => {
    const boards = boardsOf(A);
    const set6 = boards.filter((board) => board.current_round_type === "OperatingRound" && board.macro_round_number === 6);
    expect(set6.length).toBeGreaterThan(0);
    for (const board of set6) expect([orTag(board), gildedOf(board, CO)]).toEqual([orTag(board), ["6"]]);
    const runs6 = runSteps(A, CO).filter((p) => p.before.macro_round_number === 6);
    expect(runs6.map((p) => `${p.before.sub_round_index}`)).toEqual(["1", "2", "3"]);
    for (const p of runs6) expect((co(p.after, CO).last_run_breakdown ?? []).map((r) => r.model)).toContain("6");
  });

  it("the transition into Stock Round 7 removes it -- automatically, at the boundary, on no run and no request; the ordinary 6 stays", () => {
    const boards = boardsOf(A);
    const at = boards.findIndex((board) => board.current_round_type === "StockRound" && board.macro_round_number === 7);
    expect(gildedOf(boards[at - 1], CO)).toEqual(["6"]);
    expect(gildedOf(boards[at], CO)).toEqual([]);
    expect(fleetOf(boards[at - 1], CO)).toEqual(["5", "6", "6"]);
    expect(fleetOf(boards[at], CO)).toEqual(["5", "6"]);
    expect(provenanceOf(boards[at], CO)).toEqual([]);
    expect(co(boards[at], CO).is_carcosan).toBe(true); // UR-N47: after the fog the corporation stays Carcosan
    expect(kindOf(A, at)).not.toBe("RunMultipleRoutes");
    // No board before the boundary lost it; none after it has it.
    const lost = boards.findIndex((board, index) => index > ownIndex(A, "4.2 C&O runs") && gildedOf(board, CO).length === 0);
    expect(lost).toBe(at);
  });
});

/* ------------------------------------------------------------------ */
/* 6 + 7. The Blood Price and the cured train's ordinary life (tail B)  */
/* ------------------------------------------------------------------ */

describe("6. tail B -- the Blood Price: the copy named, the buyer pays and moves, the seller is released (OD-UR-5 a/b/c)", () => {
  it("going in: C&O holds a gold-trimmed AND an ordinary 6; an offer that names neither copy is refused, nothing appended", () => {
    const refused = B.find("B&O offers for C&O's 6 without naming the copy -- refused");
    expect(fleetOf(refused.before, CO)).toEqual(["5", "6", "6"]);
    expect(gildedOf(refused.before, CO)).toEqual(["6"]);
    expect(refused.kind).toBe("refused");
    expect(refused.reason).toMatch(/C&O holds both a gold-trimmed and an ordinary 6-train/);
    expect(refused.indices).toEqual([]);
  });

  it("the named offer, accepted: the derived settlement is the gold-trimmed copy's sale", () => {
    const accepted = B.find("C&O accepts: the Blood Price");
    expect(accepted.entries[0]).toBe("AnswerTrainPurchase");
    expect(accepted.entries[1]).toBe("BuyTrainFromCorporation*");
    expect(payloadOf(B, accepted.indices[1]).BuyTrainFromCorporation).toMatchObject({ buyer_protocol_id: BO, seller_protocol_id: CO, model_type: "6", gilded: true });
  });

  it("the buyer pays $300 and its marker moves one cell Left and one cell Down; the seller receives $300 and its marker does not move", () => {
    const offer = B.find("B&O offers for C&O's GOLD-TRIMMED 6");
    const settled = boardsOf(B)[B.find("C&O accepts: the Blood Price").indices[1]];
    const before = offer.before;
    expect(treasury(settled, BO) - treasury(before, BO)).toBe(-300);
    expect(treasury(settled, CO) - treasury(before, CO)).toBe(300);
    // Read as cells, not through the engine's own projection: B&O (paying out every turn) is mid-chart, off every
    // edge, so the move has its ordinary form -- one column left (x - 1) and one row down, which on this chart is
    // y - 1 (its y axis counts up the chart, `marketGeometry.ts`) -- and lands on the chart's price for that cell.
    const was = marker(before, BO)!;
    const now = marker(settled, BO)!;
    expect(was.x).toBeGreaterThan(0);
    expect(was.y).toBeGreaterThan(0);
    expect([now.x, now.y]).toEqual([was.x - 1, was.y - 1]);
    expect(now.price).toBeLessThan(was.price);
    expect(now.price).toBe(projectBloodPriceMove(was)!.price);
    expect(marker(settled, CO)).toEqual(marker(before, CO));
  });

  it("the curse clears at the seller; the train is ordinary at the buyer; the provenance -- supply accounting only -- moves with it", () => {
    const settled = boardsOf(B)[B.find("C&O accepts: the Blood Price").indices[1]];
    expect(fleetOf(settled, CO)).toEqual(["5", "6"]);
    expect(gildedOf(settled, CO)).toEqual([]);
    expect(co(settled, CO).is_carcosan).toBe(false);
    expect(co(settled, CO).carcosan_doom_after_macro_round).toBeUndefined();
    expect(provenanceOf(settled, CO)).toEqual([]);
    expect(fleetOf(settled, BO)).toEqual(["5", "6"]);
    expect(gildedOf(settled, BO)).toEqual([]);
    expect(provenanceOf(settled, BO)).toEqual(["6"]);
    // +1 in circulation: three 6-trains in play against two printed, and the Depot still reads sold out, never negative.
    const sixes = settled.public_companies.reduce((n, entry) => n + (entry.owned_trains ?? []).filter((m) => m === "6").length, 0);
    expect(sixes).toBe(3);
    expect(row(settled, "6").remaining).toBe(0);
  });

  it("the Blood Price changes no phase, rusts nothing, marks nothing (an intercorporate purchase)", () => {
    const offer = B.find("B&O offers for C&O's GOLD-TRIMMED 6");
    const settled = boardsOf(B)[B.find("C&O accepts: the Blood Price").indices[1]];
    expect(phase(settled)).toBe(phase(offer.before));
    for (const entry of settled.public_companies) {
      expect([entry.ticker, entry.pending_rust_trains ?? []]).toEqual([entry.ticker, co(offer.before, entry.company_id).pending_rust_trains ?? []]);
    }
  });
});

describe("7. tail B -- the cured train's ordinary life: the limit, a run, a Diesel trade-in, a Bank Pool purchase, an ordinary sale, no fog", () => {
  it("it counts against the buyer's limit: B&O holds [5, 6] at limit 2, and the Depot sells it nothing more", () => {
    const accepted = B.find("C&O accepts: the Blood Price");
    const settled = boardsOf(B)[accepted.indices[1]];
    expect(fleetOf(settled, BO)).toEqual(["5", "6"]);
    expect([countable(settled, BO), limit(settled)]).toEqual([2, 2]);
    const refused = B.find("B&O, at its limit with the cured 6, may buy no Diesel from the Depot");
    expect([refused.kind, refused.indices]).toEqual(["refused", []]);
    expect(stateDigest(refused.after)).toBe(stateDigest(refused.before));
  });

  it("it runs normally: B&O's next turn runs the 6 for its printed $60, paid at the die's figure", () => {
    const after = B.played.filter((p) => p.step.label.endsWith("B&O runs") && B.played.indexOf(p) > B.played.indexOf(B.find("C&O accepts: the Blood Price")))[0];
    const c = co(boardsOf(B)[after.indices[0]], BO);
    expect(c.last_run_breakdown).toEqual([{ train_index: 1, model: "6", printed_revenue: "60" }]);
    const draw = B.draws.find((d) => d.turn === G.drawKey(after.before.macro_round_number!, after.before.sub_round_index!, BO))!;
    expect(c.last_route_revenue).toBe(String(GV.rollTurnRevenue(60, { macroRound: draw.macro, subRound: draw.sub, companyId: BO, turnSeed: draw.seed }).adjusted));
  });

  it("it is a legal Diesel trade-in: B&O [5, D]; the 6 goes to the Bank Pool as the ADDITIONAL copy, provenance with it; no phase change", () => {
    const traded = B.find("B&O trades the cured 6 in for a Diesel");
    expect(fleetOf(traded.after, BO)).toEqual(["5", "D"]);
    expect(provenanceOf(traded.after, BO)).toEqual([]);
    const board = boardsOf(B)[traded.indices[0]];
    expect(board.returned_trains).toEqual(["6"]);
    expect(poolProvenance(board)).toEqual(["6"]);
    expect(phase(traded.after)).toBe("D");
  });

  it("the Bank Pool purchase of the cured copy is an ordinary purchase: CPR [6], the provenance moves to it, the pool empties", () => {
    const bought = B.find("CPR buys the cured 6 from the Bank Pool");
    expect(fleetOf(bought.after, CPR)).toEqual(["6"]);
    expect(provenanceOf(bought.after, CPR)).toEqual(["6"]);
    expect(bought.after.returned_trains ?? []).toEqual([]);
    expect(poolProvenance(bought.after)).toEqual([]);
    expect(treasury(bought.after, CPR) - treasury(bought.before, CPR)).toBe(-GP.DEPOT_COST["6"]);
  });

  it("it sells normally: CPR to ERIE by an ordinary offer -- no Blood Price, no marker moves, the provenance follows", () => {
    const offer = B.find("ERIE offers for CPR's 6 -- an ordinary sale");
    const accepted = B.find("CPR accepts");
    const settled = boardsOf(B)[accepted.indices[1]];
    expect(payloadOf(B, accepted.indices[1]).BuyTrainFromCorporation).toMatchObject({ buyer_protocol_id: ERIE, seller_protocol_id: CPR, model_type: "6" });
    expect(fleetOf(settled, CPR)).toEqual([]);
    expect(fleetOf(settled, ERIE)).toEqual(["6", "6"]);
    expect(provenanceOf(settled, ERIE)).toEqual(["6"]);
    expect(marker(settled, ERIE)).toEqual(marker(offer.before, ERIE));
    expect(marker(settled, CPR)).toEqual(marker(offer.before, CPR));
  });

  it("no fog chases it: the old deadline (the end of set 6) passes, and no train anywhere is removed at the boundary", () => {
    const boards = boardsOf(B);
    const at = boards.findIndex((board) => board.current_round_type === "StockRound" && board.macro_round_number === 7);
    const trains = (board: GameStateResponse) => board.public_companies.map((entry) => `${entry.ticker}:${(entry.owned_trains ?? []).join(",")}`);
    expect(trains(boards[at])).toEqual(trains(boards[at - 1]));
    for (const board of boards.slice(B.find("C&O accepts: the Blood Price").indices[1])) {
      for (const entry of board.public_companies) expect([entry.ticker, (entry.carcosan_trains ?? []).length]).toEqual([entry.ticker, 0]);
    }
    expect(removed(boards[at])).toEqual(["4"]); // only the Mark's train has ever left the game
  });
});

/* ------------------------------------------------------------------ */
/* 8 + 9. Statistics and awards (OD-UR-6)                               */
/* ------------------------------------------------------------------ */

const accolade = (history: History, key: string) => history.accolades.find((entry) => entry.key === key)!;
const autopsy = (history: History, id: number) => history.autopsy.find((entry) => entry.companyId === id)!;
const ledger = (history: History, id: number, model: string) => autopsy(history, id).fleetLedger.find((entry) => entry.model === model);

describe("8 + 9. the statistics of both tails, read through the history's own replay of the room's log (OD-UR-6)", () => {
  it("corporation / turn revenue is the PAID figure: C&O's lifetime revenue is the sum of what its turns paid", () => {
    for (const [run, history] of [[A, historyA], [B, historyB]] as const) {
      const paid = run.played
        .filter((p) => p.kind === "applied" && "DeclareDividends" in (p.step.msg as object) && Number((p.step.msg as { DeclareDividends: { protocol_id: number } }).DeclareDividends.protocol_id) === CO)
        .reduce((n, p) => n + Number((p.step.msg as { DeclareDividends: { revenue_amount: string } }).DeclareDividends.revenue_amount), 0);
      expect(autopsy(history, CO).lifetimeRevenue).toBe(paid);
      expect(paid).toBe(1150);
    }
    // The Revenue-per-OR chart: the tie turn $50 and the Mark turn $40 -- paid, not printed ($50, $110).
    const or = (label: string) => historyA.rounds.find((r) => r.label === label)!.corporations.find((c) => c.companyId === CO)!.revenue;
    expect([or("OR 3.1"), or("OR 3.2"), or("OR 4.2")]).toEqual([50, 40, 170]);
  });

  it("train / route statistics are PRINTED completed routes; the Mark-nullified route earns nothing", () => {
    // C&O's two 4-trains: the first earned nothing (its only route was nullified), the second $120 + $80 printed.
    expect(ledger(historyA, CO, "4")).toMatchObject({ count: 2, paid: 600, earned: 200, trainRounds: 2 });
    expect(ledger(historyA, CO, "4")!.fates).toMatchObject({ taken: 1, rusted: 1 });
    // The 5: $60 in OR 4.2, then $80 in each of the six rounds of sets 5 and 6.
    expect(ledger(historyA, CO, "5")).toMatchObject({ count: 1, earned: 540, trainRounds: 7 });
    // Master of the Line is a printed route: $120 on the 4-train in OR 4.1 (paid that turn: $110).
    expect(accolade(historyA, "master-of-the-line").detail).toBe("$120 on C&O's 4-train (OR 4.1)");
  });

  it("the Carcosa gift is NOT a purchase: C&O bought four trains (4, 4, 5, 6) and the gift is in no count; its ledger row paid $630 for two 6s", () => {
    expect(accolade(historyA, "fleet-admiral").detail).toBe("C&O bought 4 trains");
    expect(ledger(historyA, CO, "6")).toMatchObject({ count: 2, paid: GP.DEPOT_COST["6"] });
    // Tail A: the gold-trimmed 6 went into the fog -- a Sign's taking, not obsolescence.
    expect(ledger(historyA, CO, "6")!.fates).toMatchObject({ taken: 1, kept: 1 });
  });

  it("the Blood Price IS the buyer's purchase: B&O's ledger books the 6 at $300 and its trade-in; The Redeemer is B&O's president", () => {
    expect(ledger(historyB, BO, "6")).toMatchObject({ count: 1, paid: 300, earned: 60, trainRounds: 1 });
    expect(ledger(historyB, BO, "6")!.fates).toMatchObject({ traded: 1 });
    expect([accolade(historyB, "redeemer").holder, accolade(historyB, "redeemer").detail]).toEqual([P3, "one Blood Price paid"]);
    expect(accolade(historyA, "redeemer").holder).toBeNull();
  });

  it("the Bank Pool purchase of the cured copy and the later ordinary sale are ordinary purchases", () => {
    expect(ledger(historyB, CPR, "6")).toMatchObject({ count: 1, paid: GP.DEPOT_COST["6"] });
    expect(ledger(historyB, CPR, "6")!.fates).toMatchObject({ sold: 1 });
    expect(ledger(historyB, ERIE, "6")).toMatchObject({ count: 2, paid: GP.DEPOT_COST["6"] + 200 });
  });

  it("Carcosan Railways is C&O's president in both tails (a released seller never paid a Blood Price); the Early Adopter is the real Diesel's buyer", () => {
    expect(accolade(historyA, "carcosan-railways").holder).toBe(P1);
    expect(accolade(historyB, "carcosan-railways").holder).toBe(P1);
    expect(accolade(historyA, "early-adopter").detail).toMatch(/^PRR bought the first Diesel/);
    expect(accolade(historyB, "early-adopter").detail).toMatch(/^PRR bought the first Diesel/);
  });

  it("obsolescence in dollars (the Gravedigger / the Rust Belt) counts Gentle Rust's destructions, not the Sign's takings", () => {
    /* Derived from the game, train by train. P1 is president of C&O and PRR.
       SENT (Gravedigger, by the purchase that brought the tier): C&O's first 4 retired every 2-train -- six at $80 =
       $480; PRR's first D retired PRR's, CPR's and C&O's 4-trains -- three at $300 = $900. P1: $1,380. (ERIE's first 6,
       P2's, retired the five 3-trains: $900.)
       LOST (the Rust Belt, by the president of the corporation that lost it): PRR's 2 ($80), 3 ($180) and 4 ($300);
       C&O's 2 ($80) and its second 4 ($300). P1: $940.
       Counting the Mark's 4 ($300) or the fog's 6 ($630) would have made them $1,680 / $1,240 or more. */
    expect([accolade(historyA, "gravedigger").holder, accolade(historyA, "gravedigger").value]).toEqual([P1, 1380]);
    expect([accolade(historyA, "rust-belt").holder, accolade(historyA, "rust-belt").value]).toEqual([P1, 940]);
    expect(ledger(historyA, CO, "4")!.fates).toMatchObject({ taken: 1, rusted: 1 });
    expect(ledger(historyA, CO, "6")!.fates).toMatchObject({ taken: 1, rusted: 0 });
  });
});
