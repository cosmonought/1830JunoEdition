/** @jest-environment node */
//
// ==================================================================
//  UR-3 (harness): THE YELLOW SIGN IS A CONSEQUENCE OF THE AUTHORITATIVE RUN
// ==================================================================
//
// OWNER RULINGS (VARIANT_CERT_UNPREDICTABLE_REVENUE_AUDIT_2026-09-24.md, "Owner rulings (rev 2)"):
//   OD-UR-1 (1-A): a Yellow Sign stage is an automatic, derived consequence of the authoritative run -- not a second
//     player action. No player or client may omit, delay, redirect or manufacture it; on a pinned table the authority
//     resolves it from the run and its committed seed. The client-sent request is removed as a source of authority.
//   OD-GR-3 (A2, "never"): the Mark judges the fleet AFTER the Run -> Dividends settlement, where a Gentle Rust Final
//     Run train is already destroyed; route attribution and narration follow the same post-settlement fleet.
//   #902 / UR-N3: with the variant off, no Unpredictable Revenue mechanism can change the game.
//
// EVERY CASE GOES THROUGH PRODUCTION AUTHORITY: the reducer (`applySandboxAction`, with the map grid a server holds)
// and, where it says "hosted", `RoomSession.submit` -- the ingress gate, the server's draw (`mintSeed`) and the
// append a Node server runs. The findings each case reproduced before UR-3 are named in its title; the audit's
// probes (Appendix A) are the source of each board.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const YS = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const { rollTurnRevenue } = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { SERVER_REPLAY_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { anchorIndex, readStripped } = require("./sourceScan") as typeof import("./sourceScan");
const { describeTreasuryMoves } = require("./treasuryProvenance") as typeof import("./treasuryProvenance");

const { CO, BO, NYC, P1, P2, GULF, TWO_ROUTE, THREE_ROUTE, LONG_ROUTE, urBoard, runMsg, signRequest, companyOf, partsFor } = S;

const CTX = { mapGrid: GULF, era: "Yellow" } as const;
const apply = (state: GameStateResponse, msg: unknown) => applySandboxAction(state, msg as never, CTX);
const co = (state: GameStateResponse) => companyOf(state, CO);

/** C&O [2, 3] on the Gulf line, phase 3 (nobody holds a 4), Unpredictable Revenue on, pinned. */
const markBoard = (over: Partial<Parameters<typeof urBoard>[0]> = {}) =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["2", "3"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"], treasury: 300 },
    ],
    ...over,
  });

/** The run the normal UI sends for [2, 3]: $50 + $60 = $110 printed. */
const RUN = (seed?: number) => runMsg(CO, [TWO_ROUTE, THREE_ROUTE], [0, 1], ["2", "3"], seed);
const MARK_110 = S.seedWhere((seed) => S.isMarkDraw(110, partsFor(seed)));
const QUIET_110 = S.seedWhere((seed) => S.isQuietDraw(110, partsFor(seed)));

describe("OD-UR-1: the run itself applies the Mark (UR-F1, UR-F2 omission)", () => {
  it("reducer: one RunMultipleRoutes entry takes the cheapest train, nullifies ITS route, re-rolls the rest and mints the award", () => {
    const before = markBoard();
    const after = apply(before, RUN(MARK_110));
    const c = co(after);
    // The 2-train is the cheapest ($80): it leaves, and so does its $50 route; the 3's $60 stands under the same face.
    expect(c.owned_trains).toEqual(["3"]);
    expect(c.has_yellow_sign).toBe(true);
    expect(Number(c.treasury)).toBe(300 + YS.markPayout("2"));
    expect(c.printed_route_revenue).toBe("60");
    expect(Number(c.last_route_revenue)).toBe(rollTurnRevenue(60, partsFor(MARK_110)).adjusted);
    expect(c.last_run_breakdown).toEqual([{ train_index: 1, model: "3", printed_revenue: "60" }]);
    expect(c.routes_run_this_turn).toBe(1);
    // What the authority applied is on the board, for every reader (narration, fleet-loss notices, statistics).
    expect(c.last_run_yellow_sign).toEqual({
      stage: "mark",
      model: "2",
      award: String(YS.markPayout("2")),
      nullified: { train_index: 0, model: "2", printed_revenue: "50" },
    });
    // The award is minted (OD-UR-4, D-40): the Bank does not pay it.
    expect(after.virtual_bank_vgp).toBe(before.virtual_bank_vgp);
    // And the cursor moved on to Dividends exactly as for any run.
    expect(after.operating_sub_phase).toBe("Dividends");
  });

  it("hosted: the server's own draw and the run's single entry put the Mark on the board -- nothing else is sent or appended", () => {
    /* UR-F1, the server half. Before UR-3 the room applied the run and nothing else: the stage was owed to a
       client request the shell dispatches from inside its log drain, where #1407's catch-up guard refuses it (§6.2).
       Now the room's accepted run IS the stage. */
    const room = S.hostedRoom(markBoard(), GULF, [MARK_110]);
    const answer = S.submitTo(room, P1, RUN(123456789)); // the client's seed is replaced by the server's (#1662)
    expect(answer.kind).toBe("applied");
    const kinds = room.entries.map((entry) => Object.keys(JSON.parse(entry.payload))[0]);
    expect(kinds).toEqual(["RunMultipleRoutes"]);
    expect(JSON.parse(room.entries[0].payload).RunMultipleRoutes.revenue_seed).toBe(MARK_110);
    expect(co(room.state).owned_trains).toEqual(["3"]);
    expect(co(room.state).has_yellow_sign).toBe(true);
    expect(Number(co(room.state).treasury)).toBe(340);
    // Replay consumes the committed seed and reaches the same board: no draw, no second request.
    const restored = new RoomSession({
      providers: S.roomProviders(markBoard(), GULF),
      seed: { state: markBoard(), waterfall: null },
      build: "ur3",
      mintId: () => "x",
      mintSeed: () => {
        throw new Error("a restore must never draw");
      },
    });
    restored.restore(room.entries as never);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
  });

  it("the award the run's Mark mints is explained by the run -- no UNEXPLAINED treasury line (#750)", () => {
    /* #750 flags a treasury a message has no business moving. Before UR-3 no run moved a treasury; the run-bound Mark
       mints its award in the run's own entry, so the diagnostic must explain exactly that corporation's award -- and
       still flag anything else a run moves. */
    const before = markBoard();
    const msg = RUN(MARK_110);
    const after = apply(before, msg);
    expect(describeTreasuryMoves(msg, before, after)).toEqual([
      { companyId: CO, ticker: "C&O", from: 300, to: 300 + YS.markPayout("2"), unexplained: false },
    ]);
    const forged = {
      ...after,
      public_companies: after.public_companies.map((c) => (c.company_id === BO ? { ...c, treasury: "999" } : c)),
    } as GameStateResponse;
    expect(describeTreasuryMoves(msg, before, forged).find((move) => move.companyId === BO)?.unexplained).toBe(true);
    // And the shell reads the Mark's run as a sentence that states the treasury, so it prints no echo line either.
    expect(readStripped("App.tsx")).toContain("const statedInLine = sentenceStatesTreasury(gameplay) || markInRun;");
  });

  it("a quiet draw changes nothing but the revenue -- no stage, no record", () => {
    const after = apply(markBoard(), RUN(QUIET_110));
    expect(co(after).owned_trains).toEqual(["2", "3"]);
    expect(co(after).has_yellow_sign).toBeUndefined();
    expect(co(after).last_run_yellow_sign).toBeUndefined();
    expect(co(after).printed_route_revenue).toBe("110");
  });

  it("client: on a pinned board the shell dispatches no YellowSignEvent at all (the legacy request is the unpinned branch's only)", () => {
    /* UR-F1, the client half, pinned at the source: `App.tsx` cannot be mounted headless. The only producer of the
       message was the narration block the drain reaches; it may no longer send one when the board is pinned. */
    const APP = readStripped("App.tsx");
    // Anchored with `anchorIndex`, which throws on a miss -- never `slice(indexOf(..))`, whose -1 passes vacuously (#886).
    anchorIndex(APP, "const signPinned = typeof before.rules_engine_version === \"number\";", "the pin test");
    const dispatches: number[] = [];
    for (let at = APP.indexOf("\"YellowSignEvent\","); at >= 0; at = APP.indexOf("\"YellowSignEvent\",", at + 1)) {
      dispatches.push(at);
    }
    expect(dispatches).toHaveLength(3); // the three legacy (unpinned) dispatches, unchanged in number
    for (const at of dispatches) {
      // Each is reachable only behind the pin test: `if (!signPinned)` / `&& !signPinned` opens the block it sits in.
      expect(APP.slice(Math.max(0, at - 240), at)).toMatch(/!signPinned\)\s*\{\s*(?:\/\/[^\n]*\s*)*void runGameplayAction\(\s*$/);
    }
  });
});

describe("OD-UR-1: the client request is not a source of authority on a pinned table (UR-F2)", () => {
  it("a bare request after the run changes nothing, whether or not the run drew a stage", () => {
    for (const seed of [MARK_110, QUIET_110]) {
      const ran = apply(markBoard(), RUN(seed));
      const asked = apply(ran, signRequest(CO));
      expect(stateDigest(asked)).toBe(stateDigest(ran));
    }
  });

  it("a request aimed at another corporation is refused at ingress and appends nothing (P-D)", () => {
    /* P-D: C&O is Carcosan with a gilded D whose deadline has passed; B&O is operating; B&O's president asks for
       C&O's fog. Before UR-3 the room answered `applied` and C&O lost its D before it ever ran. */
    const carcosan = urBoard({
      corps: [
        { id: BO, president: P2, trains: ["5"] },
        { id: CO, president: P1, trains: ["5", "D"], extra: { is_carcosan: true, carcosan_trains: ["D"], ghost_trains: ["D"], carcosan_doom_after_macro_round: 4 } },
        { id: NYC, president: S.P3, trains: ["D"] },
      ],
      operating: BO,
      step: "Track",
      macro: 5,
      sequence: 3,
    });
    const room = S.hostedRoom(carcosan, GULF, [1]);
    const answer = S.submitTo(room, P2, signRequest(CO));
    expect(answer.kind).toBe("refused");
    expect(room.entries).toHaveLength(0);
    expect(co(room.state).owned_trains).toEqual(["5", "D"]);
    expect(co(room.state).carcosan_trains).toEqual(["D"]);
    // The reducer, the second lock, refuses the same message on its own.
    expect(stateDigest(apply(carcosan, signRequest(CO)))).toBe(stateDigest(carcosan));
  });

  it("a request delayed past a phase change can neither dodge the Mark nor re-time it (P-G1')", () => {
    /* P-G1': C&O's only train is a 4 in phase 4 (4s sold out); its run draws a Mark. Before UR-3 the Mark waited for
       a request, and the same request sent after buying the first 5 found phase 5 and did nothing -- the Mark dodged.
       Now the run took the 4 (the award is $150) and a later request is inert. */
    const phase4 = urBoard({
      corps: [
        { id: CO, president: P1, trains: ["4"], treasury: 900 },
        { id: BO, president: P2, trains: ["4", "4"] },
        { id: NYC, president: S.P3, trains: ["4"] },
      ],
    });
    const seed = S.seedWhere((s) => S.isMarkDraw(90, partsFor(s)));
    const ran = apply(phase4, runMsg(CO, [LONG_ROUTE], [0], ["4"], seed));
    expect(co(ran).owned_trains).toEqual([]);
    expect(co(ran).has_yellow_sign).toBe(true);
    expect(Number(co(ran).treasury)).toBe(900 + YS.markPayout("4"));
    // The only train was the one that ran and the one the Mark took: its route is nullified and nothing is left.
    expect(co(ran).printed_route_revenue).toBe("0");
    expect(co(ran).last_route_revenue).toBe("0");
    const late = apply(ran, signRequest(CO));
    expect(stateDigest(late)).toBe(stateDigest(ran));
  });

  it("a request after a self-triggered Gentle Rust cannot take a doomed train (P-H)", () => {
    /* P-H: Gentle Rust + Unpredictable Revenue, phase 3 with the 3s sold out; C&O [2, 3] runs with a Mark seed, then
       buys the first 4 (its own 2 would be reprieved). Before UR-3 the request came AFTER the purchase and took the
       doomed 2, leaving an orphan mark and a monetized Final Run. Now the Mark took the 2 at the run, before the
       purchase existed; the later request is inert and no mark is orphaned. */
    const phase3 = markBoard({ gentle: true });
    const ran = apply(phase3, RUN(MARK_110));
    expect(co(ran).owned_trains).toEqual(["3"]);
    const late = apply(ran, signRequest(CO));
    expect(stateDigest(late)).toBe(stateDigest(ran));
    expect(co(late).pending_rust_trains ?? []).toEqual([]);
  });

  it("a duplicate, an off-step and a Stock Round request are all refused, hosted and in the reducer", () => {
    const room = S.hostedRoom(markBoard(), GULF, [MARK_110]);
    expect(S.submitTo(room, P1, RUN()).kind).toBe("applied");
    const settled = stateDigest(room.state);
    for (const extra of [{}, { stage: "mark", model: "3", cash: "90" }, { debug_force: true }]) {
      const answer = S.submitTo(room, P1, signRequest(CO, extra));
      expect(answer.kind).toBe("refused");
    }
    expect(stateDigest(room.state)).toBe(settled);
    expect(room.entries).toHaveLength(1);
    // In a Stock Round there is no run at all to bind a stage to.
    const stock = markBoard({ round: "StockRound" });
    expect(stateDigest(apply(stock, signRequest(CO)))).toBe(stateDigest(stock));
  });
});

describe("#902 / UR-N3: a table without the variant has no Yellow Sign (UR-F3)", () => {
  it("the run pays its printed total and draws no stage, however the seed would have read", () => {
    const standard = markBoard({ ur: false });
    const after = apply(standard, RUN(MARK_110));
    expect(co(after).owned_trains).toEqual(["2", "3"]);
    expect(co(after).last_route_revenue).toBe("110");
    expect(co(after).has_yellow_sign).toBeUndefined();
    expect(co(after).last_run_yellow_sign).toBeUndefined();
  });

  it("a YellowSignEvent is refused by ingress and by the reducer (P-A)", () => {
    /* P-A: before UR-3 this request, on a standard table, took the 2, minted $40 and re-rolled the kept route with
       the Unpredictable Revenue die, through hosted ingress. */
    const standard = markBoard({ ur: false });
    const ran = apply(standard, RUN(MARK_110));
    expect(stateDigest(apply(ran, signRequest(CO)))).toBe(stateDigest(ran));
    const room = S.hostedRoom(standard, GULF, [MARK_110]);
    expect(S.submitTo(room, P1, RUN()).kind).toBe("applied");
    const answer = S.submitTo(room, P1, signRequest(CO));
    expect(answer.kind).toBe("refused");
    expect(answer.reason).toMatch(/Unpredictable Revenue/);
    expect(co(room.state).owned_trains).toEqual(["2", "3"]);
  });
});

describe("OD-GR-3 = A2: the Mark reads the post-settlement fleet (UR-F5, UR-F6)", () => {
  /* P-C: Gentle Rust + Unpredictable Revenue, phase 4 (B&O holds a 4); C&O [2, 3] with the 2 reprieved -- this is its
     grace turn. The run is ONE entry: Run -> Dividends settlement destroys the 2 (its Final Run is over), and only then
     does the Mark choose, from [3]. */
  const graceBoard = () =>
    urBoard({
      gentle: true,
      corps: [
        { id: CO, president: P1, trains: ["2", "3"], treasury: 300, extra: { pending_rust_trains: ["2"] } },
        { id: BO, president: P2, trains: ["4"] },
      ],
    });

  it("reducer: the Final Run 2 is destroyed, the Mark takes the 3, nullifies the 3's route and pays half of the 3", () => {
    const after = apply(graceBoard(), RUN(MARK_110));
    const c = co(after);
    expect(c.owned_trains).toEqual([]);
    expect(c.pending_rust_trains).toEqual([]); // no orphan mark
    expect(Number(c.treasury)).toBe(300 + YS.markPayout("3")); // $90, never the destroyed 2's $40
    /* THE ROUTE NULLIFIED IS THE TAKEN TRAIN'S. Before UR-3 the breakdown still indexed the pre-destruction fleet
       and the Mark (slot 0 of the SETTLED fleet) nullified the destroyed 2's $50 and kept the taken 3's $60. */
    expect(c.printed_route_revenue).toBe("50");
    expect(c.last_run_breakdown).toEqual([{ train_index: 0, model: "2", printed_revenue: "50" }]);
    expect(Number(c.last_route_revenue)).toBe(rollTurnRevenue(50, partsFor(MARK_110)).adjusted);
    expect(c.last_run_yellow_sign).toEqual({
      stage: "mark",
      model: "3",
      award: String(YS.markPayout("3")),
      nullified: { train_index: 1, model: "3", printed_revenue: "60" },
    });
  });

  it("the narration reports the same train, award and kept run the board applied", () => {
    const before = graceBoard();
    const after = apply(before, RUN(MARK_110));
    const report = YS.narrateRunYellowSign(before, after, CO, partsFor(MARK_110));
    expect(report.resolution.stage).toBe("mark");
    expect(report.resolution.line).toBe(YS.YELLOW_SIGN_MALUS_LINE);
    expect(report.taken).toBe("3");
    expect(report.award).toBe(YS.markPayout("3"));
    expect(report.kept).toEqual({
      routes: 1,
      adjusted: Number(co(after).last_route_revenue),
      roll: rollTurnRevenue(50, partsFor(MARK_110)),
    });
    expect(report.gifted).toBeNull();
  });

  it("a Final Run train is never a candidate: holding only it, the Mark does not fire and its line stays in the pool", () => {
    const onlyReprieved = urBoard({
      gentle: true,
      corps: [
        { id: CO, president: P1, trains: ["2"], treasury: 300, extra: { pending_rust_trains: ["2"] } },
        { id: BO, president: P2, trains: ["4"] },
      ],
    });
    const seed = S.seedWhere((s) => S.isMarkDraw(50, partsFor(s)));
    const before = onlyReprieved;
    const after = apply(before, runMsg(CO, [TWO_ROUTE], [0], ["2"], seed));
    expect(co(after).owned_trains).toEqual([]); // destroyed by Gentle Rust, not by the Sign
    expect(co(after).has_yellow_sign).toBeUndefined();
    expect(co(after).last_run_yellow_sign).toBeUndefined();
    expect(Number(co(after).treasury)).toBe(300);
    // #1046: "a stage with no train does not fire" -- the narration draws the skip line, not the Sign's.
    const report = YS.narrateRunYellowSign(before, after, CO, partsFor(seed));
    expect(report.resolution.stage).toBeNull();
    expect(report.resolution.line).not.toBe(YS.YELLOW_SIGN_MALUS_LINE);
    expect(report.taken).toBeNull();
  });

  it("hosted: the run's own entry applies the same Mark, and no request is involved", () => {
    const room = S.hostedRoom(graceBoard(), GULF, [MARK_110]);
    expect(S.submitTo(room, P1, RUN()).kind).toBe("applied");
    const payloads = room.entries.map((entry) => JSON.parse(entry.payload) as Record<string, unknown>);
    expect(Object.keys(payloads[0])).toEqual(["RunMultipleRoutes"]);
    expect(payloads.some((payload) => "YellowSignEvent" in payload)).toBe(false);
    /* Anything after the run is the room's OWN derived step, never a client's. Here that is the pre-existing forced
       withhold (#1275) the room derives for a corporation left trainless at Dividends -- a reducer no-op, because
       C&O's kept run still earned money (it is reproducible with Gentle Rust alone: a Final Run train that ran and was
       retired leaves the same board). Recorded in the backlog; it moves nothing. */
    expect(room.entries.slice(1).every((entry) => entry.derived === true)).toBe(true);
    const direct = co(apply(graceBoard(), RUN(MARK_110)));
    const hosted = co(room.state);
    // The Mark landed on the hosted board: the 3 taken (the 2 was already retired), the record written.
    expect(hosted.owned_trains).toEqual([]);
    expect(hosted.last_run_yellow_sign?.stage).toBe("mark");
    expect(hosted.owned_trains).toEqual(direct.owned_trains);
    expect(hosted.treasury).toBe(direct.treasury);
    expect(hosted.last_run_yellow_sign).toEqual(direct.last_run_yellow_sign);
    expect(hosted.last_route_revenue).toBe(direct.last_route_revenue);
    expect(hosted.printed_route_revenue).toBe(direct.printed_route_revenue);
    expect(hosted.last_run_breakdown).toEqual(direct.last_run_breakdown);
    expect(room.state.operating_sub_phase).toBe("Dividends");
  });
});

describe("UR-F7: the authority's own pairing names the route the Mark nullifies", () => {
  it("a run that omits train_indices is paired by the authority and nullified exactly as a named one", () => {
    /* P-J: before UR-3 a run without `train_indices` wrote no breakdown, so a Mark could not find the taken train's
       route and the corporation kept it. The normal UI always names the slots; a crafted client could omit them. */
    const named = apply(markBoard(), RUN(MARK_110));
    const unnamed = apply(markBoard(), runMsg(CO, [TWO_ROUTE, THREE_ROUTE], null, null, MARK_110));
    for (const field of ["owned_trains", "printed_route_revenue", "last_route_revenue", "last_run_breakdown", "treasury", "last_run_yellow_sign"] as const) {
      expect(co(unnamed)[field]).toEqual(co(named)[field]);
    }
  });
});

describe("determinism, replay and undo", () => {
  it("a replay of the committed log reaches the same board and never draws", () => {
    const room = S.hostedRoom(markBoard(), GULF, [MARK_110]);
    S.submitTo(room, P1, RUN());
    const replayed = replayLog(
      room.entries.map((entry) => ({ index: entry.index, id: entry.id, actor: entry.actor, payload: entry.payload })),
      S.roomProviders(markBoard(), GULF),
      { state: markBoard(), waterfall: null },
      undefined,
      SERVER_REPLAY_POLICY,
    );
    expect(stateDigest(replayed.state)).toBe(stateDigest(room.state));
    expect(co(replayed.state).last_run_yellow_sign?.stage).toBe("mark"); // the replay re-applies the run's own stage
    // The reducer and the Sign's module never draw: every outcome is a function of the committed seed.
    for (const file of ["gameEngine/sandboxSession.ts", "gameEngine/yellowSign.ts"]) {
      expect(readStripped(file)).not.toContain("Math.random");
    }
  });

  it("an undo past the run and the same run again reuse the draw and apply the Mark once", () => {
    const room = S.hostedRoom(markBoard(), GULF, [MARK_110, 42]);
    expect(S.submitTo(room, P1, RUN()).kind).toBe("applied");
    expect(co(room.state).has_yellow_sign).toBe(true); // the run's own entry applied the Mark
    const marked = stateDigest(room.state);
    expect(S.submitTo(room, P1, { RevertTo: { index: 0, player: P1, summary: "undo" } } as never).kind).toBe("applied");
    expect(co(room.state).owned_trains).toEqual(["2", "3"]);
    expect(co(room.state).has_yellow_sign).toBeUndefined();
    expect(S.submitTo(room, P1, RUN()).kind).toBe("applied");
    // #1051: the raw log's draw is reused (not the 42 a fresh draw would give), so the same Mark applies again.
    expect(stateDigest(room.state)).toBe(marked);
    const kinds = room.entries.map((entry) => Object.keys(JSON.parse(entry.payload))[0]);
    expect(kinds).toEqual(["RunMultipleRoutes", "RevertTo", "RunMultipleRoutes"]);
  });

  it("a second run in the same turn is refused, so no second stage can be drawn", () => {
    const room = S.hostedRoom(markBoard(), GULF, [MARK_110]);
    S.submitTo(room, P1, RUN());
    const once = stateDigest(room.state);
    expect(S.submitTo(room, P1, RUN()).kind).toBe("refused");
    expect(stateDigest(room.state)).toBe(once);
  });
});

describe("Carcosa, from the same run", () => {
  it("the Marked corporation's critical bonus gifts the depot's lowest train at the run, and no request is involved", () => {
    /* Phase 5 with a 5 still on the shelf: the gift is a 5, within the phase. */
    const marked = urBoard({
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 300, extra: { has_yellow_sign: true } },
        { id: BO, president: P2, trains: ["5"] },
      ],
    });
    const seed = S.seedWhere((s) => S.isCarcosaDraw(90, partsFor(s)));
    const after = apply(marked, runMsg(CO, [LONG_ROUTE], [0], ["5"], seed));
    const c = co(after);
    expect(c.owned_trains).toEqual(["5", "5"]);
    expect(c.carcosan_trains).toEqual(["5"]);
    expect(c.ghost_trains).toEqual(["5"]);
    expect(c.is_carcosan).toBe(true);
    expect(c.has_yellow_sign).toBe(false);
    expect(c.last_run_yellow_sign).toEqual({ stage: "carcosa", model: "5", award: "0", nullified: null });
    // The run is untouched by the gift: the whole route stands, rolled once.
    expect(c.printed_route_revenue).toBe("90");
    const report = YS.narrateRunYellowSign(marked, after, CO, partsFor(seed));
    expect(report.resolution.stage).toBe("carcosa");
    expect(report.gifted).toBe("5");
  });
});
