/** @jest-environment node */
//
// ==================================================================
//  BATCH 7.4 FINAL OPUS VERIFICATION OF THE FABLE R74-B / O1 REPAIR (#1597 / #1598) -- TEST-ONLY
// ==================================================================
//
// Adds the attacks the matrix did not already pin: the RevertTo ALTERNATE HISTORY (a discarded future's
// `offer:<kind>:N` must not survive the rebuild, and the divergent offer that reuses N must settle), the full serial
// lifecycle across refusal / rejection / rescission / settlement / turn / round / trade-in-answer, legacy-fallback
// containment, O1's non-filling control and repeated-loop idempotency, and the live-key == replay-key property that
// makes "a settlement matching no standing offer records nothing" safe. No engine file is touched by this suite.

export {};

const { nextDerivedAction, derivedEntryKey, trainOfferKey, privateOfferKey } =
  require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { pendingOfferBlock } = require("../gameEngine/pendingOfferHold") as typeof import("../gameEngine/pendingOfferHold");
const { RoomEngine } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { operatingCorporationId } = require("../gameEngine/dividendGate") as typeof import("../gameEngine/dividendGate");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type ServerLogEntry = import("./roomSession").ServerLogEntry;
type RoomSession = import("./roomSession").RoomSession;

const { P1, P2, P3, PRR, NYC, CO, DH, CA, board, operatingBoard } = F;
const { apply, withState, priv, treasury, trains, M, GRID } = S;

const providers = () => ({ ...sandboxReplayProviders(), initialGrid: GRID });
const emittedOf = (room: RoomSession) => (room as unknown as { engine: { emitted: Set<string> } }).engine.emitted;
const engineOf = (room: RoomSession) => (room as unknown as { engine: InstanceType<typeof RoomEngine> }).engine;
const offerKeys = (room: RoomSession) => Array.from(emittedOf(room)).filter((key) => key.startsWith("offer:")).sort();
const settlementOwed = (state: GameStateResponse, emitted: ReadonlySet<string> = new Set()) =>
  nextDerivedAction({ state, mapGrid: GRID, emitted })?.kind === "accepted-offer";

const rustBoard = () =>
  board({
    round: "OperatingRound",
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2", "2"], treasury: "1000" },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3", "3"], treasury: "400", price: 90 },
      { id: CO, ticker: "C&O", president: P3, trains: ["3", "3", "3"], treasury: "300", price: 80 },
    ],
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: CA, owner: P3, cost: "160" },
    ],
  });

function table(seed: GameStateResponse) {
  const harness = S.roomFor(seed);
  const applied = (actor: string, msg: unknown) => {
    const response = harness.submit(actor, msg);
    expect([Object.keys(msg as object)[0], response.kind]).toEqual([Object.keys(msg as object)[0], "applied"]);
    return harness.kinds(response);
  };
  return { ...harness, applied };
}

/* ================================================================== */
/* §4 RevertTo alternate history                                        */
/* ================================================================== */

describe("V§4 RevertTo alternate history: a discarded future's offer key does not survive the rebuild", () => {
  it("TRAIN: A (instance 1) settles, more play, RevertTo before A, a DIFFERENT offer reuses instance 1 and settles once; two restores agree", () => {
    const seed = rustBoard();
    const { room, applied, logged } = table(seed);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150")); // idx 0
    expect(room.state.train_purchase_offer?.instance).toBe(1);
    expect(applied(P2, M.answerTrain(NYC, true)).slice(0, 2)).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*"]);
    expect(emittedOf(room).has("offer:train:1")).toBe(true);
    applied(P1, M.depot(PRR)); // additional action in the future that will be discarded: the first 4, rust
    expect(trains(room.state, PRR)).toEqual(["3", "4"]);
    const futureLength = room.entries.length;

    // Host rewinds to BEFORE proposal A.
    const reverted = S.roomFor(seed); // (kept for the twin comparison below)
    const response = room.submit({ actor: P1, build: "b", host: P1, msg: M.revert(0) as never, baseIndex: room.nextIndex - 1 });
    expect(response.kind).toBe("applied");
    expect(room.entries.length).toBe(futureLength + 1);
    // THE BLOCKER CHECK: the rebuilt engine holds no key from the discarded future.
    expect(offerKeys(room)).toEqual([]);
    expect(emittedOf(room).has("offer:train:1")).toBe(false);
    expect("offer_serial" in room.state).toBe(false);
    expect(room.state.train_purchase_offer ?? null).toBeNull();
    expect(trains(room.state, PRR)).toEqual(["2", "2"]);
    expect(stateDigest(room.state)).toBe(stateDigest(reverted.room.state));

    // Divergent history: C&O (not NYC) offers PRR a 3 at a different price. Same numerical instance, 1.
    applied(P1, M.proposeTrain(CO, PRR, "3", "200"));
    expect(room.state.train_purchase_offer).toMatchObject({ seller_protocol_id: CO, instance: 1 });
    expect(room.state.offer_serial).toBe(1);
    const burst = applied(P3, M.answerTrain(CO, true));
    expect(burst.slice(0, 2)).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*"]);
    expect(burst.filter((kind) => kind === "BuyTrainFromCorporation*")).toHaveLength(1);
    expect(room.state.train_purchase_offer).toBeNull();
    expect(pendingOfferBlock(room.state, M.pass as never)).toBeNull();
    expect(trains(room.state, PRR)).toEqual(["2", "2", "3"]);
    expect(trains(room.state, CO)).toEqual(["3", "3"]);
    expect(trains(room.state, NYC)).toEqual(["3", "3"]);
    expect(treasury(room.state, PRR)).toBe(800);
    expect(treasury(room.state, CO)).toBe(500);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
    expect(offerKeys(room)).toEqual(["offer:train:1"]);
    expect(logged("BuyTrainFromCorporation")).toHaveLength(2); // one dead (reverted), one in effect
    expect(settlementOwed(room.state)).toBe(false);
    expect(settlementOwed(room.state, emittedOf(room))).toBe(false);
    // No deadlock: the table moves on.
    expect(room.submit({ actor: P1, build: "b", host: P1, msg: M.pass as never, baseIndex: room.nextIndex - 1 }).kind).toBe("applied");

    // Second restore / replay: deterministic, same keys, nothing owed, nothing re-derived.
    const digests: string[] = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const restored = S.roomFor(seed);
      restored.room.restore(room.entries as ServerLogEntry[]);
      digests.push(stateDigest(restored.room.state));
      expect(offerKeys(restored.room)).toEqual(["offer:train:1"]);
      expect(restored.room.state.offer_serial).toBe(1);
      expect(engineOf(restored.room).settleOwed(() => { throw new Error("nothing is owed"); })).toEqual([]);
    }
    expect(digests).toEqual([stateDigest(room.state), stateDigest(room.state)]);
  });

  it("TRAIN, strongest form: after the rewind the IDENTICAL offer (same seller, model, buyer, fleet, price) is re-proposed as instance 1 and settles once", () => {
    const seed = rustBoard();
    const { room, applied, logged } = table(seed);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    applied(P2, M.answerTrain(NYC, true));
    applied(P1, M.depot(PRR));
    applied(P1, M.revert(0));
    expect(offerKeys(room)).toEqual([]);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    expect(room.state.train_purchase_offer?.instance).toBe(1);
    const burst = applied(P2, M.answerTrain(NYC, true));
    expect(burst.filter((kind) => kind === "BuyTrainFromCorporation*")).toHaveLength(1);
    expect(trains(room.state, PRR)).toEqual(["2", "2", "3"]);
    expect(treasury(room.state, PRR)).toBe(850);
    expect(logged("BuyTrainFromCorporation")).toHaveLength(2);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
  });

  it("PRIVATE: the same alternate-history attack on `offer:private:N`", () => {
    const seed = rustBoard();
    const { room, applied } = table(seed);
    applied(P1, M.proposePrivate(DH, PRR, 100));
    applied(P2, M.answerPrivate(DH, true));
    expect(emittedOf(room).has("offer:private:1")).toBe(true);
    applied(P1, M.depot(PRR));
    applied(P1, M.revert(0));
    expect(offerKeys(room)).toEqual([]);
    expect(priv(room.state, DH).owner).toBe(P2);
    applied(P1, M.proposePrivate(CA, PRR, 120));
    expect(room.state.private_purchase_offer?.instance).toBe(1);
    const burst = applied(P3, M.answerPrivate(CA, true));
    expect(burst.slice(0, 2)).toEqual(["AnswerPrivatePurchase", "BuyPrivateCompany*"]);
    expect(priv(room.state, CA).owner_protocol_id).toBe(PRR);
    expect(priv(room.state, DH).owner).toBe(P2);
    expect(offerKeys(room)).toEqual(["offer:private:1"]);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
  });
});

/* ================================================================== */
/* §5 serial lifecycle                                                  */
/* ================================================================== */

describe("V§5 offer_serial lifecycle", () => {
  it("absent -> 1 -> reject 1 -> refused spends none -> 2 -> rescind 2 -> 3 -> settle 3 -> turn / round transitions keep 3 -> trade in its Answer consumes 4 -> next is 5", () => {
    const seed = withState(rustBoard(), { macro_round_number: 3 });
    const { room, applied, submit, kinds } = table(seed);
    expect("offer_serial" in room.state).toBe(false);

    // A refused proposal on the virgin board spends nothing (ingress and reducer).
    const refusedFirst = submit(P1, M.proposePrivate(DH, PRR, 5000));
    expect(refusedFirst.kind).not.toBe("applied");
    expect("offer_serial" in room.state).toBe(false);
    const reducerRefused = apply(room.state, M.proposePrivate(DH, PRR, 5000), P1);
    expect("offer_serial" in reducerRefused).toBe(false);
    expect(stateDigest(reducerRefused)).toBe(stateDigest(room.state));

    applied(P1, M.proposePrivate(DH, PRR, 100));
    expect(room.state.offer_serial).toBe(1);
    applied(P2, M.answerPrivate(DH, false));
    expect(room.state.offer_serial).toBe(1);
    expect(room.state.private_purchase_offer).toBeNull();

    expect(submit(P1, M.proposeTrain(NYC, PRR, "3", "99999")).kind).not.toBe("applied");
    expect(submit(P3, M.proposeTrain(NYC, PRR, "3", "150")).kind).not.toBe("applied"); // wrong proposer
    expect(room.state.offer_serial).toBe(1);

    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    expect(room.state.train_purchase_offer?.instance).toBe(2);
    applied(P1, M.rescindTrain(NYC));
    expect(room.state.offer_serial).toBe(2);
    expect(room.state.train_purchase_offer).toBeNull();

    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    expect(room.state.train_purchase_offer?.instance).toBe(3);
    applied(P2, M.answerTrain(NYC, true));
    expect(room.state.train_purchase_offer).toBeNull();
    expect(room.state.offer_serial).toBe(3);

    // Turn transition.
    applied(P1, M.pass);
    expect(operatingCorporationId(room.state)).not.toBe(PRR);
    expect(room.state.offer_serial).toBe(3);

    // Round transition: walk the rest of the Operating Round.
    const president = (id: number) => S.corp(room.state, id).president as string;
    for (let guard = 0; guard < 40 && room.state.current_round_type === "OperatingRound"; guard += 1) {
      const id = operatingCorporationId(room.state)!;
      const msg = room.state.operating_sub_phase === "Hardware" ? M.pass : M.advance(id);
      const response = submit(president(id), msg);
      if (response.kind !== "applied") applied(president(id), M.pass);
      expect(room.state.offer_serial).toBe(3);
    }
    expect(room.state.current_round_type).toBe("StockRound");
    expect(room.state.offer_serial).toBe(3);

    // Player <-> player trade settles in its Answer arm and still consumes an instance.
    const seat = room.state.player_addresses[room.state.active_player_index ?? 0];
    expect([P1, P2]).toContain(seat);
    expect(kinds(submit(seat, M.proposeTrade(DH, P2, P1, 50)))).toEqual(["ProposePrivateTrade"]);
    expect(room.state.private_trade_offer?.instance).toBe(4);
    expect(room.state.offer_serial).toBe(4);
    const counterparty = seat === P1 ? P2 : P1;
    expect(kinds(submit(counterparty, M.answerTrade(DH, true)))[0]).toBe("AnswerPrivateTrade");
    expect(room.state.private_trade_offer ?? null).toBeNull();
    expect(priv(room.state, DH).owner).toBe(P1);
    expect(room.state.offer_serial).toBe(4);
    expect(offerKeys(room)).toEqual(["offer:train:3"]); // a trade is numbered, never derived
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));

    // A restore reproduces every number.
    const restored = S.roomFor(seed);
    restored.room.restore(room.entries as ServerLogEntry[]);
    expect(stateDigest(restored.room.state)).toBe(stateDigest(room.state));
    expect(restored.room.state.offer_serial).toBe(4);
  });

  it("the payload cannot choose the number: a proposal carrying `instance` / `offer_serial` fields is numbered by the arm", () => {
    const seed = operatingBoard();
    const smuggled = { ProposeTrainPurchase: { ...M.proposeTrain(NYC, PRR, "3", "150").ProposeTrainPurchase, instance: 99, offer_serial: 99 } };
    const after = apply(withState(seed, { offer_serial: 6 }), smuggled, P1);
    expect(after.train_purchase_offer?.instance).toBe(7);
    expect(after.offer_serial).toBe(7);
  });
});

/* ================================================================== */
/* §6 legacy fallback containment                                       */
/* ================================================================== */

describe("V§6 legacy (instance-less) fallback is contained", () => {
  it("modern instance-bearing offers never use the tuple, whatever the board", () => {
    const accepted = S.trainOfferStages(operatingBoard(), NYC, "3", "150", P2).accepted;
    const offer = accepted.train_purchase_offer!;
    expect(offer.instance).toBe(1);
    expect(trainOfferKey(offer, accepted)).toBe("offer:train:1");
    expect(trainOfferKey(offer, withState(accepted, { public_companies: [] }))).toBe("offer:train:1");
    expect(trainOfferKey({ ...offer, instance: 0 }, accepted)).toBe("offer:train:0");
    const privateOffer = S.privateOfferStages(operatingBoard(), DH, 100, P2).accepted.private_purchase_offer!;
    expect(privateOfferKey(privateOffer)).toBe("offer:private:1");
    // The namespaces cannot meet: a fallback key always carries `unnumbered`.
    const { instance: _i, ...bare } = offer;
    expect(trainOfferKey(bare, accepted)).toMatch(/^offer:train:unnumbered:/);
    const { instance: _p, ...barePrivate } = privateOffer;
    expect(privateOfferKey(barePrivate)).toMatch(/^offer:private:unnumbered:/);
  });

  it("a hand-built accepted offer with no instance settles once under the fallback, writes no serial, and does NOT suppress a later modern offer with the identical tuple", () => {
    const seed = rustBoard();
    const legacy = withState(seed, {
      train_purchase_offer: {
        seller_protocol_id: NYC, seller_ticker: "NYC", seller_president: P2,
        buyer_protocol_id: PRR, buyer_ticker: "PRR", model_type: "3", price: "150", accepted: true,
      },
    });
    const legacyKey = nextDerivedAction({ state: legacy, mapGrid: GRID, emitted: new Set() })!.key;
    expect(legacyKey).toBe(`offer:train:unnumbered:${NYC}:3:${PRR}:150:2`);
    const { room, applied, submit, kinds } = table(legacy);
    // First submit repairs the owed legacy settlement, then applies the depot purchase.
    expect(kinds(submit(P1, M.depot(PRR))).slice(0, 2)).toEqual(["BuyTrainFromCorporation*", "BuyHardwareFromPool"]);
    expect(emittedOf(room).has(legacyKey)).toBe(true);
    expect(room.state.train_purchase_offer ?? null).toBeNull();
    expect("offer_serial" in room.state).toBe(false); // the fallback never writes the serial
    expect(trains(room.state, PRR)).toEqual(["3", "4"]); // settled [2,2,3], then the 4 rusted the 2s: fleet 2 again
    // A modern offer with the identical seller / model / buyer / price / fleet -- the legacy tuple recurs exactly.
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    expect(room.state.train_purchase_offer?.instance).toBe(1);
    const modernAccepted = apply(room.state, M.answerTrain(NYC, true), P2);
    const { instance: _x, ...asLegacy } = modernAccepted.train_purchase_offer!;
    expect(trainOfferKey(asLegacy, modernAccepted)).toBe(legacyKey); // would have collided
    const burst = applied(P2, M.answerTrain(NYC, true));
    expect(burst.filter((kind) => kind === "BuyTrainFromCorporation*")).toHaveLength(1);
    expect(trains(room.state, PRR)).toEqual(["3", "4", "3"]);
    expect(offerKeys(room)).toEqual(["offer:train:1", legacyKey].sort());
    expect(room.state.offer_serial).toBe(1);
    expect(moneyTotal(room.state)).toBe(moneyTotal(legacy));
  });
});

/* ================================================================== */
/* §7 O1                                                                */
/* ================================================================== */

describe("V§7 O1: settlement never consumes, and never forces, turn progression", () => {
  const corps = (prr: string[], nyc: string[]) => [
    { id: PRR, ticker: "PRR", president: P1, trains: prr, treasury: "1000" },
    { id: NYC, ticker: "NYC", president: P2, trains: nyc, treasury: "400", price: 90 },
    { id: CO, ticker: "C&O", president: P3, trains: ["3"], treasury: "300", price: 80 },
  ];

  it("a limit-filling settlement derives End Turn once; repeated settle loops and a restore after End Turn derive nothing more", () => {
    const seed = board({ round: "OperatingRound", corps: corps(["2", "2", "2"], ["3", "3"]) });
    const { room, applied, logged } = table(seed);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    expect(applied(P2, M.answerTrain(NYC, true))).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*", "PassTurn*"]);
    const digest = stateDigest(room.state);
    for (let loop = 0; loop < 3; loop += 1) {
      expect(engineOf(room).settleOwed(() => { throw new Error("owed nothing"); })).toEqual([]);
    }
    expect(logged("PassTurn")).toHaveLength(1);
    expect(stateDigest(room.state)).toBe(digest);
    const restored = S.roomFor(seed);
    restored.room.restore(room.entries as ServerLogEntry[]);
    expect(engineOf(restored.room).settleOwed(() => { throw new Error("owed nothing"); })).toEqual([]);
    // Restore immediately before End Turn: derived exactly once, then nothing.
    const cut = S.roomFor(seed);
    cut.room.restore((room.entries as ServerLogEntry[]).slice(0, 3));
    let minted = 0;
    const owed = engineOf(cut.room).settleOwed((msg, reason) => ({ index: 3 + minted, id: `x${(minted += 1)}`, actor: P2, payload: JSON.stringify(msg), derived: true, reason }) as never);
    expect(owed.map((entry) => Object.keys(JSON.parse((entry as { payload: string }).payload))[0])).toEqual(["PassTurn"]);
    expect(engineOf(cut.room).settleOwed(() => { throw new Error("owed nothing"); })).toEqual([]);
    expect(stateDigest(cut.room.state)).toBe(digest);
  });

  it("a settlement that does NOT fill the fleet forces no End Turn: the turn stays at Hardware exactly as after the same depot purchase", () => {
    const offered = table(board({ round: "OperatingRound", corps: corps(["2", "2"], ["3", "3"]) }));
    offered.applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    expect(offered.applied(P2, M.answerTrain(NYC, true))).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*"]);
    expect([operatingCorporationId(offered.room.state), offered.room.state.operating_sub_phase]).toEqual([PRR, "Hardware"]);
    expect(offered.logged("PassTurn")).toHaveLength(0);
    const depot = table(board({ round: "OperatingRound", corps: corps(["2", "2"], ["3"]) }));
    expect(depot.applied(P1, M.depot(PRR))).toEqual(["BuyHardwareFromPool"]);
    expect([operatingCorporationId(depot.room.state), depot.room.state.operating_sub_phase]).toEqual([PRR, "Hardware"]);
    expect(trains(offered.room.state, PRR)).toEqual(trains(depot.room.state, PRR));
  });
});

/* ================================================================== */
/* §8 derivedEntryKey: live key == replay key; unmatched records nothing */
/* ================================================================== */

describe("V§8 derivedEntryKey agrees with the live loop for every derivable settlement", () => {
  it("for private, train (numbered) and legacy (unnumbered) accepted offers, the replay key is exactly the live key", () => {
    const boards: GameStateResponse[] = [
      S.privateOfferStages(operatingBoard(), DH, 100, P2).accepted,
      S.trainOfferStages(operatingBoard(), NYC, "3", "150", P2).accepted,
      (() => {
        const accepted = S.trainOfferStages(operatingBoard(), NYC, "3", "150", P2).accepted;
        const { instance: _i, ...bare } = accepted.train_purchase_offer!;
        return withState(accepted, { train_purchase_offer: bare });
      })(),
    ];
    for (const state of boards) {
      const next = nextDerivedAction({ state, mapGrid: GRID, emitted: new Set() })!;
      expect(next.kind).toBe("accepted-offer");
      expect(derivedEntryKey(state, next.msg)).toBe(next.key);
    }
  });

  it("a settlement matching no standing offer records no key, and a hand-sent duplicate through a room still moves nothing (O2 stays unreachable)", () => {
    const seed = withState(operatingBoard(), { operating_sub_phase: "Hardware" });
    expect(derivedEntryKey(seed, M.buyTrain(PRR, NYC, "3", "150") as never)).toBeNull();
    expect(derivedEntryKey(seed, M.buyPrivate(PRR, DH, "100") as never)).toBeNull();
    const rich = S.withCorp(seed, NYC, { owned_trains: ["3", "3", "2"] });
    const { room, applied, submit } = table(rich);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    applied(P2, M.answerTrain(NYC, true));
    const settled = stateDigest(room.state);
    for (const actor of [P1, P2, P3]) {
      const response = submit(actor, M.buyTrain(PRR, NYC, "3", "150"));
      expect(response.kind === "applied" ? stateDigest(room.state) : settled).toBe(settled);
    }
    expect(trains(room.state, NYC)).toEqual(["3", "2"]);
  });
});

/* ================================================================== */
/* §4 (shell twin): the Firestore-path guard is per-history as well      */
/* ================================================================== */

describe("V§4 shell twin: an undo rebuild on the no-server path forgets the discarded history's settlement keys", () => {
  it("`rebuildSandbox` resets `acceptedOfferSentRef` beside the auto-skip and forced-withhold guards", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const APP = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    const start = APP.indexOf("const rebuildSandbox = useCallback(");
    const end = APP.indexOf("rebuildRef.current = rebuildSandbox;");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = APP.slice(start, end);
    expect(body).toContain("autoSkippedRef.current = new Set();");
    expect(body).toContain("forcedWithholdRef.current = new Set();");
    expect(body).toContain("acceptedOfferSentRef.current = new Set();");
    // And the effect that consumes it still keys on the derived action's own (instance) key.
    expect(APP).toContain("emitted: acceptedOfferSentRef.current");
  });
});
