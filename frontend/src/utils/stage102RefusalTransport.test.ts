/** @jest-environment node */
//
// ==================================================================
//  STAGE 10.2 -- REFUSAL TRANSPORT (S10-1), DUPLICATE TRAIN SETTLEMENT (S10-20), S10-24 REACHABILITY
// ==================================================================
//
// Design notes #1685 (the refusal boundary, `gameEngine/actionOutcome.ts`, `RoomSession.submit`), #1685a (the
// messages for which an unchanged board is not a refusal) and #1686 (`trainSaleAuthority.ts`: an author-less
// settlement meets the board's consent). Behavioural throughout: every case drives the real `RoomSession`, the
// real reducer and the real authorities, except §A9 and §C, which replace ONE function with a spy to observe a
// transport property no board in the fixtures can reach through ingress (named where it happens).

export {};

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type MapGridResponse = import("../components/hexContractTypes").MapGridResponse;
type ServerLogEntry = import("./roomSession").ServerLogEntry;
type ServerMessage = import("./serverProtocol").ServerMessage;

const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { atomsUnchanged, authorityDeclined, UNCHANGED_IS_NOT_A_REFUSAL } =
  require("../gameEngine/actionOutcome") as typeof import("../gameEngine/actionOutcome");
const { actionWasRefused, silentWhenUnchanged, refusalReasonFor } = require("./refusedAction") as typeof import("./refusedAction");
const { seedAlreadyRolled, turnSeedKey } = require("./turnSeed") as typeof import("./turnSeed");
const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { effectiveActions } = require("../gameEngine/logRevert") as typeof import("../gameEngine/logRevert");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { trainSaleRefusal } = require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const { pendingTrainDiscards, pendingDiscardBlock } = require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { harmlessDuplicateAnswer } = require("../gameEngine/harmlessDuplicate") as typeof import("../gameEngine/harmlessDuplicate");
const { unchangedMeansRefused } = require("../gameEngine/actionOutcome") as typeof import("../gameEngine/actionOutcome");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

const { P1, P2, P3, PRR, NYC, DH, operatingBoard, stockRoundBoard } = F;
const { apply, ingress, same, withCorp, withState, trains, treasury, M, GRID } = S;

const BUILD = "b-102";
const ALICE = "p-alice";
const BOB = "p-bob";

const SETUP = {
  SetupGame: { players: [{ id: ALICE, nickname: "Alice" }, { id: BOB, nickname: "Bob" }], variants: {} },
} as never;
const BUY_LOWEST = { WaterfallBuyLowest: { game_id: 0 } } as never;
/** A depot purchase in the auction round: the seat is right (ingress passes), the reducer's own purchase gate
 *  declines it -- one of the refusals ingress does not mirror (S10-1's residual list). */
const DEPOT = { BuyHardwareFromPool: { game_id: 0, protocol_id: 1 } } as never;

function dealtSession(options: { charted: boolean; mintSeed?: () => number }) {
  let n = 0;
  const providers = sandboxReplayProviders();
  const room = new RoomSession({
    providers: options.charted ? providers : { ...providers, initialMarket: undefined as never },
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build: BUILD,
    mintId: () => `id${(n += 1)}`,
    mintSeed: options.mintSeed,
  });
  const dealt = room.submit({ actor: ALICE, build: BUILD, msg: SETUP, baseIndex: -1 });
  expect(dealt.kind).toBe("applied");
  return room;
}

const submitAs = (
  room: InstanceType<typeof RoomSession>,
  actor: string,
  msg: unknown,
  extra: { submissionId?: string; host?: string | null; baseIndex?: number } = {},
): ServerMessage =>
  room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: extra.baseIndex ?? room.nextIndex - 1, submissionId: extra.submissionId, host: extra.host });

const kindOf = (entry: ServerLogEntry) => Object.keys(JSON.parse(entry.payload))[0];

/* ================================================================================================= */
/* A. THE REFUSAL TRANSPORT (S10-1)                                                                   */
/* ================================================================================================= */

describe("A. a reducer refusal that passes ingress is answered `refused` and never appended (S10-1, #1685)", () => {
  it("A1. uncharted board: the reducer refuses BY IDENTITY; the room answers `refused` with the reducer's sentence and appends nothing", () => {
    /* No chart and no auction atom on the board -- the only arrangement in which the reducer still hands back the
       very object it was given (the auction step copies the board whenever `state.waterfall` is set, #1340). */
    const broke = withCorp(operatingBoard(), PRR, { treasury: "0" });
    const room = new RoomSession({
      providers: { ...sandboxReplayProviders(), initialGrid: GRID, initialMarket: undefined as never },
      seed: { state: broke, waterfall: null },
      build: BUILD,
      mintId: () => "u",
    });
    expect(room.state.market_positions).toBeUndefined();
    expect(room.state.waterfall ?? null).toBeNull();
    // The control: ingress lets it through, and the reducer itself returns the very object it was handed.
    expect(ingress(room.state, P1, M.depot(PRR))).toBeNull();
    expect(applySandboxAction(room.state, M.depot(PRR) as never, { actor: P1, mapGrid: GRID })).toBe(room.state);
    const before = { log: room.entries.length, digest: stateDigest(room.state) };
    const answer = submitAs(room, P1, M.depot(PRR));
    expect(answer.kind).toBe("refused");
    const reason = (answer as { reason: string }).reason;
    expect(reason).toBe(refusalReasonFor(room.state, M.depot(PRR), { actor: P1, mapGrid: GRID }));
    expect(reason.length).toBeGreaterThan(10);
    expect(room.entries).toHaveLength(before.log);
    expect(stateDigest(room.state)).toBe(before.digest);
    /* The SAME board through a charted room: the reducer's answer is a fresh object, the room's answer is
       identical. (The fixture carries parred corporations with no chart marks; the engine's first pass would
       place them -- `reconcileParMarks`, a real atom moving -- so the chart it is seeded with is the reconciled
       one, which is what every dealt room already holds.) */
    const providers = sandboxReplayProviders();
    const reconciled = applySandboxAction({ ...broke, market_positions: providers.initialMarket, waterfall: null }, M.depot(PRR) as never, {
      ...providers.chartInjections(broke), actor: P1, mapGrid: GRID, parCellFor: providers.parCellFor,
    });
    let minted = 0;
    const charted = new RoomSession({
      providers: { ...providers, initialGrid: GRID, initialMarket: reconciled.market_positions as never },
      seed: { state: broke, waterfall: null },
      build: BUILD,
      mintId: () => `c${(minted += 1)}`,
    });
    expect(charted.state.market_positions).toBeDefined();
    const chartedAfter = applySandboxAction(charted.state, M.depot(PRR) as never, {
      ...providers.chartInjections(charted.state), actor: P1, mapGrid: GRID, parCellFor: providers.parCellFor,
    });
    expect(chartedAfter).not.toBe(charted.state);
    expect(atomsUnchanged({ state: charted.state }, { state: chartedAfter })).toBe(true);
    expect(submitAs(charted, P1, M.depot(PRR))).toEqual({ kind: "refused", reason, build: BUILD });
    expect(charted.entries).toHaveLength(0);
  });

  it("A2. charted board: the reducer hands back a FRESH object for the same refusal -- identity would say applied -- and the room still answers `refused`", () => {
    const room = dealtSession({ charted: true });
    expect(room.state.market_positions).toBeDefined();
    const seat = room.state.player_addresses[0];
    const after = applySandboxAction(room.state, DEPOT, { actor: seat });
    expect(after).not.toBe(room.state); // #1197: the chart step's copy -- the defect's mechanism
    expect(atomsUnchanged({ state: room.state }, { state: after })).toBe(true);
    const before = { log: room.entries.length, digest: stateDigest(room.state) };
    const answer = submitAs(room, seat, DEPOT);
    expect(answer.kind).toBe("refused");
    expect((answer as { reason: string }).reason).toBe(refusalReasonFor(room.state, DEPOT, { actor: seat }));
    expect(room.entries).toHaveLength(before.log);
    expect(room.entries.map(kindOf)).not.toContain("BuyHardwareFromPool");
    expect(stateDigest(room.state)).toBe(before.digest);
  });

  it("A3. retry: a refused attempt does not poison the next legal move -- same seat, next index, board moves", () => {
    const room = dealtSession({ charted: true });
    const seat = room.state.player_addresses[0];
    expect(submitAs(room, seat, DEPOT).kind).toBe("refused");
    const next = room.nextIndex;
    const legal = submitAs(room, seat, BUY_LOWEST);
    expect(legal.kind).toBe("applied");
    if (legal.kind !== "applied") return;
    expect(legal.entries[0].index).toBe(next); // no gap where the refused move would have been
    expect(room.state.private_companies.find((entry) => entry.private_id === 1)?.owner).toBe(seat);
  });

  it("A4. nonce: a refused submission consumes no nonce -- the same id is JUDGED again (never answered as already made), then applies once, then is a catch-up", () => {
    const room = dealtSession({ charted: true });
    const seat = room.state.player_addresses[0];
    const first = submitAs(room, seat, DEPOT, { submissionId: "n-1" });
    expect(first.kind).toBe("refused");
    // The same nonce again (a client retry of the refused frame): re-judged, refused again -- not a catch-up that
    // would tell the client its refused move had landed (#1209).
    const again = submitAs(room, seat, DEPOT, { submissionId: "n-1" });
    expect(again.kind).toBe("refused");
    expect(room.entries.some((entry) => entry.submission_id === "n-1")).toBe(false);
    // A restart knows nothing of it either: the registry is rebuilt from the log, and the log never held it.
    const restarted = new RoomSession({ providers: sandboxReplayProviders(), seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    }, build: BUILD, mintId: () => "r" });
    restarted.restore(room.entries);
    expect(submitAs(restarted, seat, DEPOT, { submissionId: "n-1" }).kind).toBe("refused");
    // Now a legal move under that id: applied, recorded on the entry, and a retry of THAT is the catch-up.
    const legal = submitAs(room, seat, BUY_LOWEST, { submissionId: "n-1" });
    expect(legal.kind).toBe("applied");
    expect(room.entries.filter((entry) => entry.submission_id === "n-1")).toHaveLength(1);
    const retry = submitAs(room, seat, BUY_LOWEST, { submissionId: "n-1", baseIndex: 0 });
    expect(retry.kind).toBe("catch-up");
    expect(room.entries.filter((entry) => entry.submission_id === "n-1")).toHaveLength(1);
  });

  it("A5/A6. CloseRoom is the one gameplay message whose unchanged board is the design: the race's loser stays `applied`, appended, silent", () => {
    const ended = withState(operatingBoard(), { current_round_type: "GameEnd" });
    const { room, submit } = S.roomFor(ended);
    const won = submit(P1, M.closeRoom);
    expect(won.kind).toBe("applied");
    expect(room.state.room_closed).toBe(true);
    const handed = room.state;
    const lost = submit(P2, M.closeRoom);
    expect(lost.kind).toBe("applied"); // not a banner on the loser's screen (#899)
    expect(room.entries.map(kindOf)).toEqual(["CloseRoom", "CloseRoom"]); // appended, exactly as before 10.2
    expect(atomsUnchanged({ state: handed }, { state: room.state })).toBe(true);
    // The shell prints nothing for it, and does not call it refused -- by content, on a charted board.
    const again = applySandboxAction({ ...handed }, M.closeRoom as never, { actor: P2 });
    expect(again).not.toBe(handed);
    expect(silentWhenUnchanged(M.closeRoom, { ...handed }, again)).toBe(true);
    expect(actionWasRefused({ ...handed }, again, M.closeRoom)).toBe(false);
    // Before GameEnd it is ingress's refusal, with its sentence, as #1249 made it.
    const early = S.roomFor(operatingBoard());
    const refused = early.submit(P1, M.closeRoom);
    expect(refused.kind).toBe("refused");
    expect(early.room.entries).toHaveLength(0);
    // The inventory, pinned: the only three messages an unchanged board does not convict.
    expect([...UNCHANGED_IS_NOT_A_REFUSAL].sort()).toEqual(["Chat", "CloseRoom", "RevertTo"]);
  });

  it("A7. catch-up before refusal: a submit that first repairs a crashed burst, then is refused, carries the repair and the sentence -- no phantom entry", () => {
    // A crash between the accepted offer and its derived settlement: the stored log ends at the answer.
    const seed = withCorp(operatingBoard(), PRR, { treasury: "150" });
    const live = S.roomFor(seed);
    expect(live.submit(P1, M.proposeTrain(NYC, PRR, "3", "150")).kind).toBe("applied");
    const crashed = live.room.entries.slice(); // [propose]
    const answerEntry = S.entry(crashed.length, P2, M.answerTrain(NYC, true));
    const restored = S.roomFor(seed);
    restored.room.restore([...crashed, answerEntry] as ServerLogEntry[]);
    const stored = restored.room.entries.length;
    expect(restored.room.state.train_purchase_offer?.accepted).toBe(true); // the settlement is owed
    const baseIndex = restored.room.nextIndex - 1;

    // PRR (treasury $150) will have paid $150 by the time the depot purchase is judged: the reducer declines it.
    const answer = restored.room.submit({ actor: P1, build: "b", host: P1, msg: M.depot(PRR) as never, baseIndex });
    expect(answer.kind).toBe("refused");
    const frame = answer as { reason: string; catchUp?: { entries: ServerLogEntry[]; digest: string } };
    expect(frame.reason.length).toBeGreaterThan(10);
    expect(frame.catchUp).toBeDefined();
    const repaired = frame.catchUp!.entries;
    expect(repaired.length).toBeGreaterThan(0);
    expect(repaired.every((entry) => entry.derived === true)).toBe(true);
    expect(repaired.map(kindOf)).toContain("BuyTrainFromCorporation");
    expect(repaired.map(kindOf)).not.toContain("BuyHardwareFromPool");
    expect(frame.catchUp!.digest).toBe(stateDigest(restored.room.state));
    // The log holds the repair and nothing else; the refused move left no entry.
    expect(restored.room.entries.length).toBe(stored + repaired.length);
    expect(restored.room.entries.slice(stored)).toEqual(repaired);
    expect(trains(restored.room.state, PRR)).toContain("3");
    expect(treasury(restored.room.state, PRR)).toBe(0);

    // Ingress refusals after a repair get the same frame (they used to get a bare catch-up and lose the sentence).
    const again = S.roomFor(seed);
    again.room.restore([...crashed, answerEntry] as ServerLogEntry[]);
    const notYours = again.room.submit({ actor: P2, build: "b", host: P1, msg: M.depot(PRR) as never, baseIndex });
    expect(notYours.kind).toBe("refused");
    expect((notYours as { catchUp?: { entries: ServerLogEntry[] } }).catchUp?.entries.map(kindOf)).toEqual(repaired.map(kindOf));
    // And with nothing to repair, a refusal is the bare frame every client already understands.
    const plain = S.roomFor(seed);
    const bare = plain.submit(P2, M.depot(PRR));
    expect(bare.kind).toBe("refused");
    expect("catchUp" in bare).toBe(false);
  });

  it("A8. a previously-silent residual refusal (the depot purchase's own gate) is no longer answered `applied`: before 10.2 the same submit appended it", () => {
    const room = dealtSession({ charted: true });
    const seat = room.state.player_addresses[0];
    // Ingress has no opinion on this message beyond the seat -- the reducer is the only lock that declines it.
    const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
    expect(turnRefusal({ state: room.state, waterfall: room.state.waterfall ?? null, actor: seat, msg: DEPOT, log: room.entries })).toBeNull();
    const answer = submitAs(room, seat, DEPOT);
    expect(answer.kind).toBe("refused");
    expect(room.entries.map(kindOf)).toEqual(["SetupGame"]);
    // And the other seat is refused by ingress, as before, with its own sentence.
    const other = submitAs(room, room.state.player_addresses[1], DEPOT);
    expect(other).toMatchObject({ kind: "refused", reason: "It is not your turn." });
  });

  it("A9. a declined RunMultipleRoutes commits no seed: nothing is appended, `seedAlreadyRolled` finds nothing, and the next accepted run carries a FRESH draw", () => {
    /* NO FIXTURE BOARD REACHES A REDUCER-ONLY RUN REFUSAL THROUGH INGRESS (`routeSetRefusal` is asked at both
       locks; the Coal River gate is LPF-only). So ONE function is replaced here -- the reducer -- by a wrapper
       that declines runs with a fresh, content-equal board (the charted refusal's exact shape) until told
       otherwise, and ingress is told to pass runs. Everything else is the real `RoomSession`. */
    const reducer = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
    const authority = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
    const realApply = reducer.applySandboxAction;
    const realTurn = authority.turnRefusal;
    let declineRuns = true;
    const reducerSpy = jest.spyOn(reducer, "applySandboxAction").mockImplementation((state, msg, ctx) => {
      if (!("RunMultipleRoutes" in msg)) return realApply(state, msg, ctx);
      return declineRuns ? { ...state } : ({ ...state, last_route_revenue_marker: "ran" } as GameStateResponse);
    });
    const ingressSpy = jest.spyOn(authority, "turnRefusal").mockImplementation((input) =>
      "RunMultipleRoutes" in input.msg ? null : realTurn(input),
    );
    try {
      const draws = [111, 222, 333];
      let drawn = 0;
      const room = new RoomSession({
        providers: { ...sandboxReplayProviders(), initialGrid: GRID },
        seed: { state: operatingBoard(), waterfall: null },
        build: "b",
        mintId: () => `m${drawn}`,
        mintSeed: () => draws[drawn++],
      });
      const run = M.run(PRR);
      const key = turnSeedKey(room.state.macro_round_number ?? 0, room.state.sub_round_index ?? 0, PRR);
      const declined = room.submit({ actor: P1, build: "b", msg: run as never, baseIndex: -1 });
      expect(declined.kind).toBe("refused");
      expect(reducerSpy).toHaveBeenCalled(); // it reached the reducer: ingress was passed
      expect(room.entries).toHaveLength(0);
      expect(seedAlreadyRolled(room.entries, key)).toBeNull(); // the $111 draw was never committed
      declineRuns = false;
      const accepted = room.submit({ actor: P1, build: "b", msg: run as never, baseIndex: -1 });
      expect(accepted.kind).toBe("applied");
      const body = JSON.parse(room.entries[0].payload).RunMultipleRoutes;
      expect(body.revenue_seed).toBe(222);
      expect(seedAlreadyRolled(room.entries, key)).toBe(222);
    } finally {
      reducerSpy.mockRestore();
      ingressSpy.mockRestore();
    }
  });

  it("A10. one definition: the engine's boundary and the shell's receipt give the same verdict over the same atoms, grid included", () => {
    const room = dealtSession({ charted: true });
    const seat = room.state.player_addresses[0];
    const handed = { ...room.state };
    const after = applySandboxAction(handed, DEPOT, { actor: seat });
    const grid: MapGridResponse = sandboxReplayProviders().initialGrid;
    expect(actionWasRefused(handed, after, DEPOT, { before: grid, after: grid })).toBe(true);
    expect(authorityDeclined(DEPOT, { state: handed, grid }, { state: after, grid })).toBe(true);
    // A grid that moved is a change, whatever the board says (a lay's other atom, #1683).
    const moved = { ...grid, tiles: [{ q: 0, r: 0, tile_id: 7, orientation: 0 }] } as unknown as MapGridResponse;
    expect(actionWasRefused(handed, after, DEPOT, { before: grid, after: moved })).toBe(false);
    // The legal move is not refused.
    const bought = applySandboxAction(handed, BUY_LOWEST, { actor: seat });
    expect(actionWasRefused(handed, bought, BUY_LOWEST)).toBe(false);
  });
});

/* ================================================================================================= */
/* B. S10-20 -- THE AUTHOR-LESS DUPLICATE TRAIN SETTLEMENT (#1686)                                     */
/* ================================================================================================= */

describe("B. an author-less BuyTrainFromCorporation gets no consent exemption (S10-20, #1686)", () => {
  const seedWithSpare = () => withCorp(operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] });

  it("B10. the legitimate accepted offer settles exactly once, through the room's derived burst", () => {
    const { room, submit, logged } = S.roomFor(seedWithSpare());
    expect(submit(P1, M.proposeTrain(NYC, PRR, "3", "150")).kind).toBe("applied");
    expect(submit(P2, M.answerTrain(NYC, true)).kind).toBe("applied");
    expect(logged("BuyTrainFromCorporation")).toHaveLength(1);
    expect(logged("BuyTrainFromCorporation")[0].derived).toBe(true);
    expect(trains(room.state, PRR).sort()).toEqual(["2", "3"]);
    expect(trains(room.state, NYC)).toEqual(["3", "2"]);
    expect(room.state.train_purchase_offer ?? null).toBeNull();
  });

  it("B11. a duplicate author-less settlement after it is refused: no second train leaves the seller, none arrives, no money moves", () => {
    const seed = seedWithSpare();
    const { accepted } = S.trainOfferStages(seed, NYC, "3", "150", P2);
    const once = apply(accepted, M.buyTrain(PRR, NYC, "3", "150"), P2);
    expect(trains(once, NYC)).toEqual(["3", "2"]);
    const dup = apply(once, M.buyTrain(PRR, NYC, "3", "150"), null);
    expect(same(dup, once)).toBe(true);
    expect(trains(dup, NYC)).toEqual(["3", "2"]);
    expect(trains(dup, PRR)).toEqual(trains(once, PRR));
    expect(treasury(dup, PRR)).toBe(treasury(once, PRR));
    expect(treasury(dup, NYC)).toBe(treasury(once, NYC));
    expect(moneyTotal(dup)).toBe(moneyTotal(seed));
    expect(trainSaleRefusal(once, { buyerId: PRR, sellerId: NYC, model: "3", price: "150" }, null, GRID, "settlement")).toBe(
      "NYC's president has not agreed to sell its 3-train to PRR, and no accepted offer covers this sale.",
    );
    // A replayed log carrying the duplicate with no author (a fixture's shape) lands one settlement.
    const base = [
      S.entry(0, P1, M.proposeTrain(NYC, PRR, "3", "150")),
      S.entry(1, P2, M.answerTrain(NYC, true)),
      S.entry(2, P2, M.buyTrain(PRR, NYC, "3", "150"), true),
    ];
    const providers = () => ({ ...sandboxReplayProviders(), initialGrid: GRID });
    const one = replayLog(base, providers(), { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
    const authorless = { ...S.entry(3, P2, M.buyTrain(PRR, NYC, "3", "150"), true), actor: undefined as unknown as string };
    const two = replayLog([...base, authorless], providers(), { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(stateDigest(two.state)).toBe(stateDigest(one.state));
    expect(trains(two.state, NYC)).toEqual(["3", "2"]);
  });

  it("B12. an authored stale duplicate stays refused, by both locks, with the consent sentence", () => {
    const { accepted } = S.trainOfferStages(seedWithSpare(), NYC, "3", "150", P2);
    const once = apply(accepted, M.buyTrain(PRR, NYC, "3", "150"), P2);
    for (const author of [P1, P2]) {
      expect(same(apply(once, M.buyTrain(PRR, NYC, "3", "150"), author), once)).toBe(true);
    }
    expect(ingress(once, P1, M.buyTrain(PRR, NYC, "3", "150"))).toBe(
      "NYC's president has not agreed to sell its 3-train to PRR — make an offer and wait for the answer.",
    );
  });

  it("B13. solo / same president: the author-less direct buy, the authored one, and the author-less derived settlement of an accepted offer all still settle", () => {
    const solo = withCorp(seedWithSpare(), NYC, { president: P1 });
    for (const author of [null, P1]) {
      const bought = apply(solo, M.buyTrain(PRR, NYC, "3", "100"), author);
      expect([author, trains(bought, NYC)]).toEqual([author, ["3", "2"]]);
      expect([author, trains(bought, PRR).sort()]).toEqual([author, ["2", "3"]]);
      expect(treasury(bought, PRR)).toBe(treasury(solo, PRR) - 100);
    }
    // Different presidents, accepted offer standing, no author (solo's derived settlement): consent is the offer.
    const { accepted } = S.trainOfferStages(seedWithSpare(), NYC, "3", "150", P2);
    const settled = apply(accepted, M.buyTrain(PRR, NYC, "3", "150"), null);
    expect(trains(settled, NYC)).toEqual(["3", "2"]);
    expect(settled.train_purchase_offer ?? null).toBeNull();
    // Different presidents, no offer, no author: no consent anywhere on the board.
    const cold = seedWithSpare();
    expect(same(apply(cold, M.buyTrain(PRR, NYC, "3", "150"), null), cold)).toBe(true);
  });
});

/* ================================================================================================= */
/* C. S10-24 -- CAN `RevertTo` REACH THE DISCARD HOLD AFTER 10.2?                                      */
/* ================================================================================================= */

describe("C. S10-24 reachability after 10.2: `RevertTo` never reaches the reducer, so the discard hold never judges it", () => {
  it("C14. on a board carrying an owed discard, a live revert rebuilds (no reducer call with RevertTo), and replay strips it before the loop", () => {
    const hex = { q: 0, r: 0 };
    const board = (): GameStateResponse =>
      ({
        player_addresses: ["p1", "p2", "p3"],
        player_cash: ["p1", "p2", "p3"].map((player) => ({ player, cash_vgp: "500" })),
        virtual_bank_vgp: "10000",
        private_companies: [],
        current_round_type: "OperatingRound",
        macro_round_number: 3,
        active_player_index: 0,
        active_operating_order: [2, 5, 1, 4],
        active_corporation_index: 0,
        sub_round_index: 1,
        operating_round_sequence_length: 1,
        consecutive_passes: 0,
        operating_sub_phase: "Hardware",
        public_companies: [
          [2, "NYC", "p2", []],
          [5, "C&O", "p1", ["3", "3", "4"]],
          [1, "PRR", "p3", ["3", "4"]],
          [4, "B&O", "p3", ["4", "4"]],
        ].map(([id, ticker, president, owned]) => ({
          company_id: id, ticker, is_floated: true, president, par_value: "100", ipo_pool_percentage: 0, bank_pool_percentage: 0,
          treasury: "1000", owned_trains: owned, player_holdings: [{ player: president, percentage: 100 }],
          station_token_hexes: [[hex.q, hex.r]], station_tokens: [[hex.q, hex.r, 0]], station_token_limit: 3, home_hex_label: "F6",
        })),
      }) as unknown as GameStateResponse;
    const seen: string[] = [];
    const reducer = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
    const realApply = reducer.applySandboxAction;
    const spy = jest.spyOn(reducer, "applySandboxAction").mockImplementation((state, msg, ctx) => {
      seen.push(Object.keys(msg)[0]);
      return realApply(state, msg, ctx);
    });
    try {
      const room = new RoomSession({ providers: { ...sandboxReplayProviders(), initialGrid: GRID }, seed: { state: board(), waterfall: null }, build: "b", mintId: () => `s${seen.length}` });
      const bought = room.submit({ actor: "p2", build: "b", host: "p1", msg: { BuyHardwareFromPool: { game_id: 1, protocol_id: 2 } } as never, baseIndex: -1 });
      expect(bought.kind).toBe("applied");
      expect(seen).toContain("BuyHardwareFromPool"); // the spy is on the path the room uses
      expect(pendingTrainDiscards(room.state)?.required.companyId).toBe(5); // C&O over the new limit: the hold stands
      // The asymmetry S10-24 filed is still in the predicate's source...
      expect(pendingDiscardBlock(room.state, M.revert(0) as never)).toContain("must discard before anything else happens");
      // ...and cannot be reached: the host's revert is applied by REBUILD, and the reducer never sees a RevertTo.
      seen.length = 0;
      const reverted = room.submit({ actor: "p1", build: "b", host: "p1", msg: M.revert(0, "p1") as never, baseIndex: room.nextIndex - 1 });
      expect(reverted.kind).toBe("applied");
      expect(seen).not.toContain("RevertTo");
      expect(pendingTrainDiscards(room.state)).toBeNull();
      // Replay: `effectiveActions` removes every RevertTo before the loop.
      seen.length = 0;
      const replayed = replayLog(room.entries, { ...sandboxReplayProviders(), initialGrid: GRID }, { state: board(), waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
      expect(seen).not.toContain("RevertTo");
      expect([replayed.applied, replayed.dropped]).toEqual([0, 2]); // the revert and what it struck, resolved on the log
      expect(stateDigest(replayed.state)).toBe(stateDigest(room.state));
    } finally {
      spy.mockRestore();
    }
    expect(effectiveActions([S.entry(0, "p2", { PassTurn: { game_id: 1 } }), S.entry(1, "p1", M.revert(0, "p1"))] as never).map((e) => Object.keys(JSON.parse(e.payload))[0])).not.toContain("RevertTo");
  });
});

/* ================================================================================================= */
/* D. #1687 -- THE HARMLESS DUPLICATE ANSWER STAYS A SUCCESS; A REAL ANSWER REFUSAL DOES NOT          */
/* ================================================================================================= */

describe("D. a consent answer that finds nothing to answer is #662's harmless duplicate, not a refusal (#1687)", () => {
  /** The duplicate's full transport outcome: applied, appended (as before 10.2), board unchanged, no REFUSED receipt. */
  function expectHarmless(room: InstanceType<typeof RoomSession>, answer: ServerMessage, handed: GameStateResponse, msg: unknown, logBefore: number) {
    expect(answer.kind).toBe("applied");
    expect(room.entries).toHaveLength(logBefore + 1);
    expect(atomsUnchanged({ state: handed }, { state: room.state })).toBe(true);
    expect(harmlessDuplicateAnswer(handed, msg)).toBe(true);
    // The shell's receipt, over the same atoms: no REFUSED line, and not the CloseRoom silence either.
    expect(actionWasRefused(handed, { ...room.state }, msg as never)).toBe(false);
  }

  it("D1. AnswerPrivatePurchase after the offer has settled: applied, nothing moves, no REFUSED line", () => {
    const { room, submit, logged } = S.roomFor(operatingBoard());
    expect(submit(P1, M.proposePrivate(DH, PRR, 100)).kind).toBe("applied");
    expect(submit(P2, M.answerPrivate(DH, true)).kind).toBe("applied");
    expect(logged("BuyPrivateCompany")).toHaveLength(1);
    expect(room.state.private_purchase_offer ?? null).toBeNull();
    const handed = room.state;
    const money = moneyTotal(handed);
    const log = room.entries.length;
    const dup = submit(P2, M.answerPrivate(DH, true));
    expectHarmless(room, dup, handed, M.answerPrivate(DH, true), log);
    expect(moneyTotal(room.state)).toBe(money);
    expect(logged("BuyPrivateCompany")).toHaveLength(1);
  });

  it("D2. AnswerTrainPurchase after the settlement: applied, no second train, no money, not a refusal", () => {
    const { room, submit, logged } = S.roomFor(withCorp(operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] }));
    submit(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    submit(P2, M.answerTrain(NYC, true));
    expect(logged("BuyTrainFromCorporation")).toHaveLength(1);
    const handed = room.state;
    const log = room.entries.length;
    const dup = submit(P2, M.answerTrain(NYC, true));
    expectHarmless(room, dup, handed, M.answerTrain(NYC, true), log);
    expect(trains(room.state, NYC)).toEqual(["3", "2"]);
    expect(trains(room.state, PRR).sort()).toEqual(["2", "3"]);
    expect([treasury(room.state, PRR), treasury(room.state, NYC)]).toEqual([treasury(handed, PRR), treasury(handed, NYC)]);
    expect(logged("BuyTrainFromCorporation")).toHaveLength(1);
  });

  it("D3. AnswerPrivateTrade with no remaining offer (after a decline): applied, not a refusal", () => {
    const { room, submit } = S.roomFor(stockRoundBoard());
    expect(submit(P1, M.proposeTrade(DH, P2, P1, 50)).kind).toBe("applied");
    expect(submit(P2, M.answerTrade(DH, false)).kind).toBe("applied"); // declined: the offer is gone
    expect(room.state.private_trade_offer ?? null).toBeNull();
    const handed = room.state;
    const log = room.entries.length;
    expectHarmless(room, submit(P2, M.answerTrade(DH, true)), handed, M.answerTrade(DH, true), log);
  });

  it("D4. AnswerFundingPrivateOffer after the offer is settled, and after it is withdrawn: applied, not a refusal", () => {
    const held = S.fundingBoard(100, { privates: [{ id: DH, owner: P1, cost: "70" }] });
    const answer = { AnswerFundingPrivateOffer: { game_id: 1, private_id: DH, accept: true } };
    // Settled: the buyer's president accepts, the sale lands in the answer; a second yes finds nothing.
    const settled = S.roomFor(held, S.corridor());
    expect(settled.submit(P1, M.fundingOffer(DH, NYC, 70)).kind).toBe("applied");
    expect(settled.submit(P2, answer).kind).toBe("applied");
    expect(settled.room.state.private_purchase_offer ?? null).toBeNull();
    let handed = settled.room.state;
    let log = settled.room.entries.length;
    expectHarmless(settled.room, settled.submit(P2, answer), handed, answer, log);
    // Withdrawn: the seller rescinds; the late answer finds nothing.
    const withdrawn = S.roomFor(held, S.corridor());
    withdrawn.submit(P1, M.fundingOffer(DH, NYC, 70));
    expect(withdrawn.submit(P1, { RescindFundingPrivateOffer: { game_id: 1, private_id: DH } }).kind).toBe("applied");
    handed = withdrawn.room.state;
    log = withdrawn.room.entries.length;
    expectHarmless(withdrawn.room, withdrawn.submit(P2, answer), handed, answer, log);
  });

  it("D5. an ILLEGAL answer while its offer STANDS is still refused -- by ingress with its sentence, and by the transport when only the reducer declines it", () => {
    const { room, submit } = S.roomFor(withCorp(operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] }));
    submit(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const standing = room.state;
    expect(standing.train_purchase_offer?.accepted).toBeUndefined();
    const log = room.entries.length;
    // Not the seller's president: ingress, with its sentence; nothing appended.
    expect(submit(P3, M.answerTrain(NYC, true))).toMatchObject({ kind: "refused", reason: "Only the selling corporation's president can answer that offer." });
    // Answering for a corporation whose train is not on offer: the standing offer's hold (#1590) refuses it first.
    const wrong = submit(P2, M.answerTrain(PRR, true));
    expect(wrong.kind).toBe("refused");
    expect((wrong as { reason: string }).reason).toContain("waiting for the selling president's answer");
    expect(room.entries).toHaveLength(log);
    // The predicate is the BOARD's, not the message type's: with the offer standing it grants nothing.
    expect(harmlessDuplicateAnswer(standing, M.answerTrain(PRR, true))).toBe(false);
    expect(unchangedMeansRefused(M.answerTrain(PRR, true), standing)).toBe(true);
    expect(actionWasRefused(standing, { ...standing }, M.answerTrain(PRR, true))).toBe(true);
    // And if ingress had let it through (spy), the reducer's no-op is answered `refused`, never exempted as an answer.
    const authority = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
    const realTurn = authority.turnRefusal;
    const spy = jest.spyOn(authority, "turnRefusal").mockImplementation((input) => ("AnswerTrainPurchase" in input.msg ? null : realTurn(input)));
    try {
      const through = submit(P2, M.answerTrain(PRR, true));
      expect(through.kind).toBe("refused");
      expect(room.entries).toHaveLength(log);
      expect(stateDigest(room.state)).toBe(stateDigest(standing));
    } finally {
      spy.mockRestore();
    }
    // The legitimate answer still lands.
    expect(submit(P2, M.answerTrain(NYC, true)).kind).toBe("applied");
    expect(trains(room.state, NYC)).toEqual(["3", "2"]);
  });

  it("D6/D7. the 10.2 boundary is otherwise unchanged: a silent reducer refusal is still `refused` and not appended; CloseRoom's loser is still applied", () => {
    const room = dealtSession({ charted: true });
    const seat = room.state.player_addresses[0];
    expect(submitAs(room, seat, DEPOT).kind).toBe("refused");
    expect(room.entries.map(kindOf)).toEqual(["SetupGame"]);
    const ended = S.roomFor(withState(operatingBoard(), { current_round_type: "GameEnd" }));
    expect(ended.submit(P1, M.closeRoom).kind).toBe("applied");
    expect(ended.submit(P2, M.closeRoom).kind).toBe("applied");
    expect(ended.room.entries).toHaveLength(2);
    // Not a message-wide loophole: the other answer-shaped and chain-era messages are not exempted by type.
    for (const msg of [M.answerTrain(NYC, true), M.answerPrivate(DH, true), { UndoLastAction: { game_id: 1 } }, { SetupGame: {} }]) {
      expect(unchangedMeansRefused(msg)).toBe(true);
    }
  });
});
