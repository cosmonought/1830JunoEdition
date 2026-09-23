/** @jest-environment node */
//
// ==================================================================
//  BATCH 7.4 EXHAUSTIVE MATRIX (4/6): STALE SETTLEMENT, EXACTLY ONCE, R74-A, AND THE R74-B CORE BLOCKER
// ==================================================================
//
// §11: an accepted ordinary offer whose board goes stale -- one fact at a time -- is refused at settlement, moves
// no asset, no money and no unrelated field, is retired, and is not re-emitted; the engine's own loop derives it
// once and then nothing, however often it is asked. §12: a legal accepted offer settles exactly once through the
// room, through a replay, through a rebuild, and against a duplicated settlement entry. §13 (private half; the
// train half is in the train suite): R74-A, the buyer's current president withdraws an accepted-but-unsettled
// offer. §14: R74-B -- the `emitted` guard.
//
// ==================================================================
//  R74-B: CORE BLOCKER (owner adjudication, 2026-09-15) -- REPAIRED in the Fable follow-up (#1597 / #1598)
// ==================================================================
// AS FOUND: the derived train-settlement key was `offer:train:<seller>:<model>:<buyer>:<buyer's fleet size>`. The
// fleet size is not an offer identity: rust, the buyer's own intercorporate sale, and rust followed by a depot
// purchase all bring it back, and the price was not in the key at all. A later, legally distinct offer with the same
// seller, model and buyer then found its settlement key already in the server's `emitted` set: the accepted offer was
// never settled, and 7.4's pending-offer hold froze the whole table around it. A hand-sent settlement, a host revert,
// a restart or the not-yet-exposed rescission control is not a resolution -- the authoritative state machine must
// not deadlock -- and a superficial key change (adding the price) would not have fixed it: B.2 collides at the same
// price.
// AS REPAIRED (#1597): every ordinary offer is numbered by its proposal arm -- `offer_serial` on the board, `instance`
// on the offer, one strictly increasing counter for all three ordinary kinds, log-derived like every other field --
// and the derived settlement key is `offer:<kind>:<instance>` and nothing else. §14 below keeps Opus's legal room
// reproductions B.1-B.7 and flips them from "accepted, no settlement, table frozen" to "the second distinct offer
// settles exactly once"; B.8 is the strongest minimal regression (an identical tuple at an identical price); §15 pins
// that the instance is a function of the log (replay, `RevertTo`, rebuild). The §14 companion (O1, #1598) flips too:
// a derived settlement is recorded under its own key, so the End Turn a filled fleet owes is derived from the offer
// path exactly as from the depot.

export {};

const { nextDerivedAction } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { pendingOfferBlock, privateSettlementMatches, trainSettlementMatches, standingOrdinaryOffer } =
  require("../gameEngine/pendingOfferHold") as typeof import("../gameEngine/pendingOfferHold");
const { privatePurchaseRefusal, answerPrivatePurchaseRefusal, rescindPrivatePurchaseRefusal } =
  require("../gameEngine/privatePurchaseAuthority") as typeof import("../gameEngine/privatePurchaseAuthority");
const { trainSaleRefusal, answerTrainPurchaseRefusal } = require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const { RoomEngine, replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { pendingTrainDiscards } = require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { operatingCorporationId } = require("../gameEngine/dividendGate") as typeof import("../gameEngine/dividendGate");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type ServerLogEntry = import("./roomSession").ServerLogEntry;

const { P1, P2, P3, PRR, NYC, CO, DH, CA, board, operatingBoard, stockRoundBoard } = F;
const { apply, ingress, same, differing, withCorp, withPriv, withState, atPhase, priv, treasury, trains, guarded, M, GRID } = S;

const providers = () => ({ ...sandboxReplayProviders(), initialGrid: GRID });

/** An engine seeded with `state`, asked to settle what it owes `rounds` times; returns what each call minted. */
function settleLoop(state: GameStateResponse, rounds = 3) {
  const engine = new RoomEngine(providers(), { state, waterfall: null });
  let minted = 0;
  const mint = (msg: unknown, reason: string) => {
    minted += 1;
    return { index: minted, id: `d${minted}`, actor: P2, payload: JSON.stringify(msg), derived: true, reason } as never;
  };
  const calls: string[][] = [];
  for (let round = 0; round < rounds; round += 1) {
    calls.push(engine.settleOwed(mint).map((entry) => Object.keys(JSON.parse((entry as { payload: string }).payload))[0]));
  }
  return { calls, state: engine.snapshot.state };
}

/* ================================================================== */
/* §11 stale accepted settlement                                        */
/* ================================================================== */

const acceptedPrivate = () => S.privateOfferStages(operatingBoard(), DH, 100, P2).accepted;
const acceptedTrain = () => S.trainOfferStages(operatingBoard(), NYC, "3", "150", P2).accepted;

const STALE_PRIVATE: Array<[string, (state: GameStateResponse) => GameStateResponse]> = [
  ["the round changed", (s) => withState(s, { current_round_type: "StockRound" })],
  ["the operating corporation changed", (s) => withState(s, { active_corporation_index: 1 })],
  ["the phase fell to 2", (s) => atPhase(s, "2")],
  ["the phase rose to 5", (s) => atPhase(s, "5")],
  ["the private's owner changed", (s) => withPriv(s, DH, { owner: P3 })],
  ["the private became a corporation's", (s) => withPriv(s, DH, { owner: null, owner_protocol_id: NYC })],
  ["the private closed", (s) => withPriv(s, DH, { closed: true })],
  ["the buyer's treasury fell below the price", (s) => withCorp(s, PRR, { treasury: "99" })],
  ["the buyer unfloated", (s) => withCorp(s, PRR, { is_floated: false })],
  ["the buyer lost its president", (s) => withCorp(s, PRR, { president: null })],
  ["the face moved the price out of the band", (s) => withPriv(s, DH, { cost: "250" })],
  ["the recorded owner is not the owner (consent)", (s) => withState(s, { private_purchase_offer: { ...s.private_purchase_offer!, owner: P1 } })],
];

const STALE_TRAIN: Array<[string, (state: GameStateResponse) => GameStateResponse]> = [
  ["the round changed", (s) => withState(s, { current_round_type: "StockRound" })],
  ["the operating corporation changed", (s) => withState(s, { active_corporation_index: 1 })],
  ["the step moved to Track", (s) => withState(s, { operating_sub_phase: "Track" })],
  ["the step moved to Routes", (s) => withState(s, { operating_sub_phase: "Routes" })],
  ["the step moved to Dividends", (s) => withState(s, { operating_sub_phase: "Dividends" })],
  ["the seller lost the train", (s) => withCorp(s, NYC, { owned_trains: ["2"] })],
  ["the seller unfloated", (s) => withCorp(s, NYC, { is_floated: false })],
  ["the buyer's treasury fell below the price", (s) => withCorp(s, PRR, { treasury: "149" })],
  ["the buyer reached the phase-3 limit", (s) => withCorp(s, PRR, { owned_trains: ["2", "2", "2", "2"] })],
  ["the phase fell to 4 with the buyer at its limit", (s) => withCorp(atPhase(s, "4"), PRR, { owned_trains: ["3", "3", "3"] })],
];

describe("§11 a stale accepted PRIVATE offer: refused at settlement, retired, nothing else moves, never re-emitted", () => {
  for (const [label, stale] of STALE_PRIVATE) {
    it(label, () => {
      const before = stale(acceptedPrivate());
      const offer = before.private_purchase_offer!;
      const owed = nextDerivedAction({ state: before, mapGrid: GRID, emitted: new Set() })!;
      expect(owed.kind).toBe("accepted-offer");
      expect(privateSettlementMatches(offer, (owed.msg as { BuyPrivateCompany: { protocol_id: number; private_id: number; price: string } }).BuyPrivateCompany)).toBe(true);
      const after = apply(before, owed.msg, P2);
      // Only the offer field differs: the one documented mutation of a refusal (#1596).
      expect(differing(before, after)).toEqual(["private_purchase_offer"]);
      expect(after.private_purchase_offer).toBeNull();
      expect(guarded(after)).toEqual(guarded(before));
      expect(moneyTotal(after)).toBe(moneyTotal(before));
      expect(nextDerivedAction({ state: after, mapGrid: GRID, emitted: new Set() })).toBeNull();
      // The engine's loop: one derived settlement, then nothing, however often it is asked.
      const loop = settleLoop(before, 4);
      expect(loop.calls).toEqual([["BuyPrivateCompany"], [], [], []]);
      expect(loop.state.private_purchase_offer).toBeNull();
      expect(guarded(loop.state)).toEqual(guarded(before));
    });
  }
});

describe("§11 a stale accepted TRAIN offer: refused at settlement, retired, nothing else moves, never re-emitted", () => {
  for (const [label, stale] of STALE_TRAIN) {
    it(label, () => {
      const before = stale(acceptedTrain());
      const offer = before.train_purchase_offer!;
      const owed = nextDerivedAction({ state: before, mapGrid: GRID, emitted: new Set() })!;
      expect(owed.kind).toBe("accepted-offer");
      expect(trainSettlementMatches(offer, (owed.msg as { BuyTrainFromCorporation: { buyer_protocol_id: number; seller_protocol_id: number; model_type: string; price: string } }).BuyTrainFromCorporation)).toBe(true);
      const after = apply(before, owed.msg, P2);
      expect(differing(before, after)).toEqual(["train_purchase_offer"]);
      expect(after.train_purchase_offer).toBeNull();
      expect(guarded(after)).toEqual(guarded(before));
      expect(moneyTotal(after)).toBe(moneyTotal(before));
      const next = nextDerivedAction({ state: after, mapGrid: GRID, emitted: new Set() });
      expect(next === null || next.kind !== "accepted-offer").toBe(true); // an unrelated owed skip may follow a mutated step; never the offer
      const loop = settleLoop(before, 4);
      expect(loop.calls[0][0]).toBe("BuyTrainFromCorporation");
      expect(loop.calls.flat().filter((kind) => kind === "BuyTrainFromCorporation")).toHaveLength(1);
      expect(loop.state.train_purchase_offer).toBeNull();
      expect(trains(loop.state, PRR)).toEqual(trains(before, PRR));
      expect(trains(loop.state, NYC)).toEqual(trains(before, NYC));
    });
  }

  it("a presidency change is NOT a stale fact for a train (the corporation consented): pinned beside the matrix", () => {
    const before = withCorp(acceptedTrain(), NYC, { president: P3 });
    const loop = settleLoop(before, 2);
    expect(loop.calls).toEqual([["BuyTrainFromCorporation"], []]);
    expect(trains(loop.state, PRR)).toEqual(["2", "3"]);
  });

  it("a settlement that does not match the accepted offer (price/asset identity) is held without retiring it; the owed settlement is always the offer's own", () => {
    const accepted = acceptedTrain();
    for (const msg of [M.buyTrain(PRR, NYC, "3", "151"), M.buyTrain(PRR, NYC, "2", "150"), M.buyTrain(PRR, CO, "3", "150")]) {
      const after = apply(accepted, msg, P1);
      expect(same(after, accepted)).toBe(true);
      expect(after.train_purchase_offer?.accepted).toBe(true);
    }
    const acceptedP = acceptedPrivate();
    for (const msg of [M.buyPrivate(PRR, DH, "101"), M.buyPrivate(PRR, CA, "100"), M.buyPrivate(NYC, DH, "100")]) {
      const after = apply(acceptedP, msg, P1);
      expect(same(after, acceptedP)).toBe(true);
      expect(after.private_purchase_offer?.accepted).toBe(true);
    }
  });
});

/* ================================================================== */
/* §12 exactly once                                                    */
/* ================================================================== */

describe("§12 each derived settlement lands exactly once: room, repeated loop, reapplication, replay, rebuild, duplicate entry", () => {
  const FAMILIES = [
    {
      label: "the private purchase",
      seed: () => operatingBoard(),
      propose: () => M.proposePrivate(DH, PRR, 100),
      answer: () => M.answerPrivate(DH, true),
      answerer: P2,
      kind: "BuyPrivateCompany",
      settled: (state: GameStateResponse) => priv(state, DH).owner_protocol_id === PRR,
    },
    {
      label: "the train sale",
      seed: () => withCorp(operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] }), // a second 3 to double-take, if anything tried
      propose: () => M.proposeTrain(NYC, PRR, "3", "150"),
      answer: () => M.answerTrain(NYC, true),
      answerer: P2,
      kind: "BuyTrainFromCorporation",
      settled: (state: GameStateResponse) => trains(state, PRR).join() === "2,3",
    },
  ];

  for (const family of FAMILIES) {
    it(`${family.label}: through a room the burst mints one settlement; settling again mints none; resending it moves nothing`, () => {
      const seed = family.seed();
      const { room, submit, kinds, logged } = S.roomFor(seed);
      submit(P1, family.propose());
      expect(kinds(submit(family.answerer, family.answer()))).toEqual([Object.keys(family.answer())[0], `${family.kind}*`]);
      expect(family.settled(room.state)).toBe(true);
      expect(standingOrdinaryOffer(room.state)).toBeNull();
      const digest = stateDigest(room.state);
      // The loop asked again: nothing owed.
      expect(nextDerivedAction({ state: room.state, mapGrid: GRID, emitted: new Set() })).toBeNull();
      // The settlement resent (a straggler, with its author): refused, nothing moves.
      const again = JSON.parse(logged(family.kind)[0].payload);
      expect(same(apply(room.state, again, family.answerer), room.state)).toBe(true);
      expect(same(apply(room.state, again, P1), room.state)).toBe(true);
      expect(stateDigest(room.state)).toBe(digest);
      expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
      // Restore (a restart) and a second restore agree with the live room, one settlement each.
      for (let rebuild = 0; rebuild < 2; rebuild += 1) {
        const restored = S.roomFor(seed);
        restored.room.restore(room.entries as ServerLogEntry[]);
        expect(stateDigest(restored.room.state)).toBe(digest);
        expect(restored.logged(family.kind)).toHaveLength(1);
        expect(nextDerivedAction({ state: restored.room.state, mapGrid: GRID, emitted: new Set() })).toBeNull();
      }
    });

    it(`${family.label}: a replayed log with the settlement entry duplicated lands one settlement`, () => {
      const seed = family.seed();
      const { room, submit, logged } = S.roomFor(seed);
      submit(P1, family.propose());
      submit(family.answerer, family.answer());
      const settlement = JSON.parse(logged(family.kind)[0].payload);
      const base = [S.entry(0, P1, family.propose()), S.entry(1, family.answerer, family.answer()), S.entry(2, family.answerer, settlement, true)];
      const once = replayLog(base, providers(), { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
      const twice = replayLog([...base, S.entry(3, family.answerer, settlement, true)], providers(), { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
      const thrice = replayLog([...base, S.entry(3, P1, settlement, true), S.entry(4, P3, settlement, true)], providers(), { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
      expect(stateDigest(once.state)).toBe(stateDigest(room.state));
      expect(stateDigest(twice.state)).toBe(stateDigest(once.state));
      expect(stateDigest(thrice.state)).toBe(stateDigest(once.state));
      expect(moneyTotal(thrice.state)).toBe(moneyTotal(seed));
    });
  }

  it("residual #549b -- REPAIRED by Stage 10.2 (S10-20, #1686): a duplicate TRAIN settlement with NO author meets the board's consent and is refused", () => {
    /* Pinned here as a decision in Batch 7.4 ("reported, not changed"): an author-less copy skipped consent and
       took the seller's second 3-train. #1686 asks consent of the board when there is no author -- a matching
       accepted offer, or one president over both -- so the duplicate finds neither and is declined. */
    const seed = withCorp(operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] });
    const { accepted } = S.trainOfferStages(seed, NYC, "3", "150", P2);
    const once = apply(accepted, M.buyTrain(PRR, NYC, "3", "150"), P2);
    expect(same(apply(once, M.buyTrain(PRR, NYC, "3", "150"), P2), once)).toBe(true);
    const unattributed = apply(once, M.buyTrain(PRR, NYC, "3", "150"), null);
    expect(same(unattributed, once)).toBe(true);
    expect(trains(unattributed, PRR)).toEqual(trains(once, PRR));
    expect(trains(unattributed, NYC)).toEqual(["3", "2"]);
    // The private purchase's second unattributed copy finds a corporation's card (unchanged, as before).
    const privateOnce = apply(acceptedPrivate(), M.buyPrivate(PRR, DH, "100"), P2);
    expect(same(apply(privateOnce, M.buyPrivate(PRR, DH, "100"), null), privateOnce)).toBe(true);
  });
});

/* ================================================================== */
/* §13 (private) R74-A                                                  */
/* ================================================================== */

describe("§13 (private) R74-A: the buyer's current president may withdraw an accepted, unsettled private offer", () => {
  it("the proposer rescinds; the owner and an unrelated player cannot; only the offer clears; no settlement is owed", () => {
    const seed = operatingBoard();
    const { accepted } = S.privateOfferStages(seed, DH, 100, P2);
    for (const actor of [P2, P3]) {
      expect(rescindPrivatePurchaseRefusal(accepted, { private_id: DH }, actor)).toBe("Only PRR's president can withdraw its offer.");
      expect(ingress(accepted, actor, M.rescindPrivate(DH))).toBe("Only PRR's president can withdraw its offer.");
      expect(same(apply(accepted, M.rescindPrivate(DH), actor), accepted)).toBe(true);
    }
    expect(pendingOfferBlock(accepted, M.rescindPrivate(DH) as never)).toBeNull();
    expect(ingress(accepted, P1, M.rescindPrivate(DH))).toBeNull();
    const withdrawn = apply(accepted, M.rescindPrivate(DH), P1);
    // #1597: the board remembers that an offer was made (`offer_serial`); the rescission itself clears only the offer.
    expect(differing(seed, withdrawn)).toEqual(["offer_serial", "private_purchase_offer"]);
    expect(differing(accepted, withdrawn)).toEqual(["private_purchase_offer"]);
    expect(guarded(withdrawn)).toEqual(guarded(seed));
    expect(nextDerivedAction({ state: withdrawn, mapGrid: GRID, emitted: new Set() })).toBeNull();
    expect(settleLoop(withdrawn, 2).calls).toEqual([[], []]);
    // The settlement sent anyway has no offer and no consent.
    expect(ingress(withdrawn, P1, M.buyPrivate(PRR, DH, "100"))).toBe("p2 has not agreed to sell Delaware & Hudson to PRR — make an offer and wait for the answer.");
    expect(same(apply(withdrawn, M.buyPrivate(PRR, DH, "100"), P2), withdrawn)).toBe(true);
    // The buyer's presidency moved under the accepted offer: the right to withdraw moved with it.
    const moved = withCorp(accepted, PRR, { president: P3 });
    expect(ingress(moved, P1, M.rescindPrivate(DH))).toBe("Only PRR's president can withdraw its offer.");
    expect(ingress(moved, P3, M.rescindPrivate(DH))).toBeNull();
  });
});

/* ================================================================== */
/* §14 R74-B -- REPAIRED (#1597): the settlement key is the offer's instance */
/* ================================================================== */

/** The live engine's `emitted` set (white-box, read-only): the exact thing R74-B is about. */
const emittedOf = (room: import("./roomSession").RoomSession) => (room as unknown as { engine: { emitted: Set<string> } }).engine.emitted;

/** A room harness that plays legal messages only and can walk the Operating Round to a corporation's Hardware step. */
function legalTable(seed: GameStateResponse) {
  const harness = S.roomFor(seed);
  const { room, submit } = harness;
  const presidentOf = (id: number) => S.corp(room.state, id).president as string;
  const operating = () => operatingCorporationId(room.state);
  const applied = (actor: string, msg: unknown) => {
    const response = submit(actor, msg);
    expect([Object.keys(msg as object)[0], response.kind]).toEqual([Object.keys(msg as object)[0], "applied"]);
    return response;
  };
  const toHardware = () => {
    for (let guard = 0; guard < 8 && room.state.current_round_type === "OperatingRound" && room.state.operating_sub_phase !== "Hardware"; guard += 1) {
      const id = operating()!;
      applied(presidentOf(id), M.advance(id));
    }
  };
  const until = (target: number) => {
    for (let guard = 0; guard < 12; guard += 1) {
      expect(room.state.current_round_type).toBe("OperatingRound");
      toHardware();
      if (operating() === target && room.state.operating_sub_phase === "Hardware") return;
      applied(presidentOf(operating()!), M.pass);
    }
    throw new Error(`never reached corporation ${target}'s Hardware step`);
  };
  /** The key the board WOULD derive if the seller accepted now (a reducer-only look, nothing submitted). */
  const keyIfAccepted = (seller: number) =>
    nextDerivedAction({ state: apply(room.state, M.answerTrain(seller, true), presidentOf(seller)), mapGrid: GRID, emitted: new Set() })?.key;
  /** The PRE-#1597 key -- the transaction tuple with the buyer's fleet size -- computed beside the real one so each
   *  case shows the collision the old key would have had and the instance key does not. */
  const legacyKeyIfAccepted = (seller: number, buyer: number, model: string) =>
    `offer:train:${seller}:${model}:${buyer}:${trains(room.state, buyer).length}`;
  const discardIfOwed = () => {
    const owed = pendingTrainDiscards(room.state);
    if (owed) applied(owed.required.president as string, M.discard(owed.required.companyId, owed.required.choices[0]));
  };
  return { ...harness, presidentOf, operating, applied, toHardware, until, keyIfAccepted, legacyKeyIfAccepted, discardIfOwed };
}

/** The repair, pinned: the acceptance's burst carries exactly one derived settlement, the offer is retired, the key
 *  the room recorded is the offer's own instance key, the hold is released, and the loop owes no settlement again. */
function expectSettledOnce(table: ReturnType<typeof legalTable>, burst: string[], key: string, settlementsSoFar: number) {
  const { room, logged } = table;
  expect(burst.slice(0, 2)).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*"]);
  expect(burst.filter((kind) => kind === "BuyTrainFromCorporation*")).toHaveLength(1);
  expect(room.state.train_purchase_offer).toBeNull();
  expect(emittedOf(room).has(key)).toBe(true);
  expect(logged("BuyTrainFromCorporation")).toHaveLength(settlementsSoFar);
  expect(pendingOfferBlock(room.state, M.pass as never)).toBeNull();
  // Asked again with a fresh set and with the room's: no settlement is owed (a turn action may be, never the offer).
  for (const emitted of [new Set<string>(), emittedOf(room)]) {
    const next = nextDerivedAction({ state: room.state, mapGrid: GRID, emitted });
    expect(next === null || next.kind !== "accepted-offer").toBe(true);
  }
}

describe("§14 R74-B (repaired, #1597): a later legal train offer settles exactly once, whatever an earlier offer's transaction looked like", () => {
  it("R74-B.1 same turn, rust by the buyer's own depot purchase: PRR [2,2] buys NYC's 3 at $150, buys the first 4, then NYC's other 3 at $120", () => {
    const seed = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2", "2"], treasury: "1000" },
        { id: NYC, ticker: "NYC", president: P2, trains: ["3", "3"], treasury: "400", price: 90 },
        { id: CO, ticker: "C&O", president: P3, trains: ["3", "3", "3"], treasury: "300", price: 80 },
      ],
    });
    const table = legalTable(seed);
    const { room, applied, kinds } = table;
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    expect(room.state.train_purchase_offer?.instance).toBe(1);
    expect(room.state.offer_serial).toBe(1);
    const firstKey = table.keyIfAccepted(NYC)!;
    expect(firstKey).toBe("offer:train:1");
    const firstLegacy = table.legacyKeyIfAccepted(NYC, PRR, "3");
    expect(firstLegacy).toBe(`offer:train:${NYC}:3:${PRR}:2`);
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), firstKey, 1);
    expect(trains(room.state, PRR)).toEqual(["2", "2", "3"]);
    // Intervening legal fleet change: the first 4-train rusts both 2s.
    applied(P1, M.depot(PRR));
    expect(trains(room.state, PRR)).toEqual(["3", "4"]);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "120"));
    expect(room.state.train_purchase_offer?.instance).toBe(2);
    const secondKey = table.keyIfAccepted(NYC)!;
    expect(secondKey).toBe("offer:train:2");
    expect(table.legacyKeyIfAccepted(NYC, PRR, "3")).toBe(firstLegacy); // the tuple recurs; the instance does not
    expect(secondKey).not.toBe(firstKey);
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), secondKey, 2);
    expect(trains(room.state, PRR)).toEqual(["3", "4", "3"]);
    expect(treasury(room.state, PRR)).toBe(430);
    expect(trains(room.state, NYC)).toEqual([]);
    expect(treasury(room.state, NYC)).toBe(670);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
  });

  it("R74-B.2 identical price, across turns, the buyer's own intercorporate sale restores the fleet: PRR buys NYC's 3 at $150, sells its 2 to C&O, buys NYC's other 3 at $150", () => {
    const seed = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "1000", price: 100 },
        { id: CO, ticker: "C&O", president: P3, trains: [], treasury: "600", price: 80 },
        { id: NYC, ticker: "NYC", president: P2, trains: ["3", "3"], treasury: "400", price: 60 },
      ],
      over: { operating_round_sequence_length: 2 },
    });
    const table = legalTable(seed);
    const { room, applied, kinds } = table;
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const firstKey = table.keyIfAccepted(NYC)!;
    expect(firstKey).toBe("offer:train:1");
    const firstLegacy = table.legacyKeyIfAccepted(NYC, PRR, "3");
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), firstKey, 1);
    expect(trains(room.state, PRR)).toEqual(["2", "3"]);
    applied(P1, M.pass);
    table.until(CO);
    applied(P3, M.proposeTrain(PRR, CO, "2", "50"));
    expect(room.state.train_purchase_offer?.instance).toBe(2); // the counter is shared by every ordinary offer
    expectSettledOnce(table, kinds(applied(P1, M.answerTrain(PRR, true))), "offer:train:2", 2);
    expect(trains(room.state, PRR)).toEqual(["3"]);
    applied(P3, M.pass);
    table.until(PRR);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const secondKey = table.keyIfAccepted(NYC)!;
    expect(secondKey).toBe("offer:train:3");
    expect(table.legacyKeyIfAccepted(NYC, PRR, "3")).toBe(firstLegacy); // seller, model, buyer, fleet AND price identical
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), secondKey, 3);
    expect(trains(room.state, PRR)).toEqual(["3", "3"]);
    expect(room.state.offer_serial).toBe(3);
  });

  it("R74-B.3 across turns, rust by ANOTHER corporation's first 4: PRR [2] buys NYC's 3; C&O buys the first 4; PRR buys NYC's other 3", () => {
    const seed = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "1000", price: 100 },
        { id: CO, ticker: "C&O", president: P3, trains: ["3", "3", "3"], treasury: "600", price: 80 },
        { id: NYC, ticker: "NYC", president: P2, trains: ["3", "3"], treasury: "400", price: 60 },
      ],
      over: { operating_round_sequence_length: 2 },
    });
    const table = legalTable(seed);
    const { room, applied, kinds } = table;
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const firstKey = table.keyIfAccepted(NYC)!;
    const firstLegacy = table.legacyKeyIfAccepted(NYC, PRR, "3");
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), firstKey, 1);
    applied(P1, M.pass);
    table.until(CO);
    applied(P3, M.depot(CO));
    table.discardIfOwed();
    expect(trains(room.state, PRR)).toEqual(["3"]); // the 2 rusted
    if (room.state.current_round_type === "OperatingRound" && table.operating() === CO) applied(P3, M.pass);
    table.until(PRR);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "120"));
    const secondKey = table.keyIfAccepted(NYC)!;
    expect([firstKey, secondKey]).toEqual(["offer:train:1", "offer:train:2"]);
    expect(table.legacyKeyIfAccepted(NYC, PRR, "3")).toBe(firstLegacy);
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), secondKey, 2);
    expect(trains(room.state, PRR)).toEqual(["3", "3"]);
  });

  it("R74-B.4 rust and then a depot purchase bring the count back: PRR [2,2] buys NYC's 3; C&O's first 4 rusts PRR to [3]; PRR buys a 4; then NYC's other 3", () => {
    const seed = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2", "2"], treasury: "1500", price: 100 },
        { id: CO, ticker: "C&O", president: P3, trains: ["3", "3", "3"], treasury: "600", price: 80 },
        { id: NYC, ticker: "NYC", president: P2, trains: ["3", "3"], treasury: "400", price: 60 },
      ],
      over: { operating_round_sequence_length: 2 },
    });
    const table = legalTable(seed);
    const { room, applied, kinds } = table;
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const firstKey = table.keyIfAccepted(NYC)!;
    const firstLegacy = table.legacyKeyIfAccepted(NYC, PRR, "3");
    expect(firstLegacy).toBe(`offer:train:${NYC}:3:${PRR}:2`);
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), firstKey, 1);
    applied(P1, M.pass);
    table.until(CO);
    applied(P3, M.depot(CO));
    table.discardIfOwed();
    if (room.state.current_round_type === "OperatingRound" && table.operating() === CO) applied(P3, M.pass);
    table.until(PRR);
    expect(trains(room.state, PRR)).toEqual(["3"]);
    applied(P1, M.depot(PRR));
    expect(trains(room.state, PRR)).toEqual(["3", "4"]);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "90"));
    const secondKey = table.keyIfAccepted(NYC)!;
    expect([firstKey, secondKey]).toEqual(["offer:train:1", "offer:train:2"]);
    expect(table.legacyKeyIfAccepted(NYC, PRR, "3")).toBe(firstLegacy);
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), secondKey, 2);
    expect(trains(room.state, PRR)).toEqual(["3", "4", "3"]);
  });

  it("R74-B.5 a discard ALONE cannot restore a buyable tuple: it leaves the buyer at its limit, where no train offer is legal (unchanged by the repair)", () => {
    // PRR [3,3,3] buys NYC's 3 at fleet 3 (phase 3, limit 4); C&O's first 4 makes the limit 3; PRR discards to 3 --
    // the first tuple's fleet -- but at its limit: the Hardware step ends itself and a proposal is refused.
    const seed = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["3", "3", "3"], treasury: "1000", price: 100 },
        { id: CO, ticker: "C&O", president: P3, trains: ["2"], treasury: "600", price: 80 },
        { id: NYC, ticker: "NYC", president: P2, trains: ["3", "3"], treasury: "400", price: 60 },
      ],
    });
    const table = legalTable(seed);
    const { room, applied, kinds } = table;
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    expect(table.keyIfAccepted(NYC)).toBe("offer:train:1");
    expect(table.legacyKeyIfAccepted(NYC, PRR, "3")).toBe(`offer:train:${NYC}:3:${PRR}:3`);
    // The fourth train fills the phase-3 limit: the turn ends itself from the offer path now (#1598, O1).
    expect(kinds(applied(P2, M.answerTrain(NYC, true)))).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*", "PassTurn*"]);
    table.until(CO);
    applied(P3, M.depot(CO));
    const owed = pendingTrainDiscards(room.state);
    expect(owed?.required.ticker).toBe("PRR");
    applied(P1, M.discard(PRR, "3"));
    expect(trains(room.state, PRR)).toHaveLength(3); // the first tuple's fleet count...
    const atLimit = withState(room.state, { active_corporation_index: room.state.active_operating_order.indexOf(PRR), operating_sub_phase: "Hardware" });
    expect(trainSaleRefusal(atLimit, { buyerId: PRR, sellerId: NYC, model: "3", price: "150" }, P1, GRID, "proposal")).toBe("PRR is already at its train limit and may not buy another train.");
  });

  it("R74-B.5b a discard in the chain does not matter either: PRR [3,3] buys NYC's 3, buys the first 4 and discards, sells a 3 to C&O, then buys NYC's other 3", () => {
    // The discard is one of the decrements; the SALE is what brings the fleet back below the limit to the first
    // tuple's count. Phase 3 -> 4 on PRR's own purchase: limit 4 -> 3, the discard is owed at once.
    const seed = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["3", "3"], treasury: "1500", price: 100 },
        { id: CO, ticker: "C&O", president: P3, trains: ["3"], treasury: "600", price: 80 },
        { id: NYC, ticker: "NYC", president: P2, trains: ["3", "3"], treasury: "400", price: 60 },
      ],
      over: { operating_round_sequence_length: 2 },
    });
    const table = legalTable(seed);
    const { room, applied, kinds } = table;
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const firstKey = table.keyIfAccepted(NYC)!;
    const firstLegacy = table.legacyKeyIfAccepted(NYC, PRR, "3");
    expect(firstLegacy).toBe(`offer:train:${NYC}:3:${PRR}:2`);
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), firstKey, 1);
    expect(trains(room.state, PRR)).toEqual(["3", "3", "3"]);
    // Intervening legal fleet changes: the first 4 (phase 4, limit 3), the owed discard, and a sale.
    applied(P1, M.depot(PRR));
    expect(trains(room.state, PRR)).toEqual(["3", "3", "3", "4"]);
    expect(pendingTrainDiscards(room.state)?.required.ticker).toBe("PRR");
    table.discardIfOwed();
    expect(trains(room.state, PRR)).toHaveLength(3);
    if (room.state.current_round_type === "OperatingRound" && table.operating() === PRR) applied(P1, M.pass);
    table.until(CO);
    applied(P3, M.proposeTrain(PRR, CO, "3", "100"));
    expectSettledOnce(table, kinds(applied(P1, M.answerTrain(PRR, true))), "offer:train:2", 2);
    expect(trains(room.state, PRR)).toHaveLength(2);
    applied(P3, M.pass);
    table.until(PRR);
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const secondKey = table.keyIfAccepted(NYC)!;
    expect(secondKey).toBe("offer:train:3");
    expect(table.legacyKeyIfAccepted(NYC, PRR, "3")).toBe(firstLegacy); // identical tuple, identical price
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), secondKey, 3);
    expect(trains(room.state, PRR)).toHaveLength(3);
  });

  it("R74-B.6 the PRIVATE key is its instance too: the settlement always lands on the acceptance's board, and a settled private is a corporation's for good", () => {
    // (a) whatever the acceptance's board passed, the settlement predicate passes on the board the acceptance produced.
    const legalBoards: Array<[string, GameStateResponse, number]> = [
      ["control", operatingBoard(), 100],
      ["phase 4", atPhase(operatingBoard(), "4"), 100],
      ["half face", operatingBoard(), 35],
      ["twice face", operatingBoard(), 140],
      ["treasury exact", withCorp(operatingBoard(), PRR, { treasury: "100" }), 100],
      ["at Track", operatingBoard({ step: "Track" }), 100],
      ["at Dividends", operatingBoard({ step: "Dividends" }), 100],
    ];
    for (const [label, legal, price] of legalBoards) {
      const offered = apply(legal, M.proposePrivate(DH, PRR, price), P1);
      expect([label, offered.private_purchase_offer?.instance, offered.offer_serial]).toEqual([label, 1, 1]);
      expect([label, answerPrivatePurchaseRefusal(offered, { private_id: DH, accept: true }, P2)]).toEqual([label, null]);
      const accepted = apply(offered, M.answerPrivate(DH, true), P2);
      expect([label, differing(offered, accepted)]).toEqual([label, ["private_purchase_offer"]]);
      expect([label, privatePurchaseRefusal(accepted, { buyerId: PRR, privateId: DH, price }, P2, "settlement")]).toEqual([label, null]);
      expect([label, nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() })?.key]).toEqual([label, "offer:private:1"]);
      const { room, submit, kinds } = S.roomFor(legal);
      submit(P1, M.proposePrivate(DH, PRR, price));
      expect([label, kinds(submit(P2, M.answerPrivate(DH, true))).slice(0, 2)]).toEqual([label, ["AnswerPrivatePurchase", "BuyPrivateCompany*"]]);
      expect([label, priv(room.state, DH).owner_protocol_id]).toEqual([label, PRR]);
      expect([label, room.state.offer_serial]).toEqual([label, 1]);
    }
    // (b) after the one settlement, no legal message makes the private a player's again, so no later offer can
    // name the same (private, owner) -- every door is refused at both locks.
    const { room, submit } = S.roomFor(operatingBoard());
    submit(P1, M.proposePrivate(DH, PRR, 100));
    submit(P2, M.answerPrivate(DH, true));
    const key = "offer:private:1";
    expect(emittedOf(room).has(key)).toBe(true);
    expect(emittedOf(room).has(`offer:private:${DH}:${P2}:${PRR}:100`)).toBe(false); // the pre-#1597 transaction key is gone
    const settled = room.state;
    const doors: Array<[string, GameStateResponse, string, unknown]> = [
      ["another corporation's offer", withState(settled, { active_corporation_index: 1 }), P2, M.proposePrivate(DH, NYC, 100)],
      ["the same corporation's offer again", settled, P1, M.proposePrivate(DH, PRR, 100)],
      ["a direct purchase", settled, P1, M.buyPrivate(PRR, DH, "100")],
      ["a player trade by the old owner", withState(stockRoundBoard({ privates: [] }), { private_companies: settled.private_companies, macro_round_number: 4, active_player_index: 1 }), P2, M.proposeTrade(DH, P2, P1, 10)],
      ["a player trade by the buyer's president", withState(stockRoundBoard({ privates: [] }), { private_companies: settled.private_companies, macro_round_number: 4 }), P1, M.proposeTrade(DH, P2, P1, 10)],
      ["a funding offer", settled, P2, M.fundingOffer(DH, NYC, 100)],
    ];
    for (const [label, door, actor, msg] of doors) {
      expect([label, ingress(door, actor, msg)]).not.toEqual([label, null]);
      const after = apply(door, msg, actor);
      expect([label, same(after, door)]).toEqual([label, true]);
      expect([label, priv(after, DH).owner_protocol_id]).toEqual([label, PRR]);
    }
    // (c) and a revert past the settlement is a rebuild with a fresh guard: the SAME instance, re-accepted, settles again.
    const reverting = S.roomFor(operatingBoard());
    reverting.submit(P1, M.proposePrivate(DH, PRR, 100));
    reverting.submit(P2, M.answerPrivate(DH, true));
    expect(reverting.submit(P1, M.revert(1)).kind).toBe("applied");
    expect(reverting.room.state.private_purchase_offer).toMatchObject({ private_id: DH, owner: P2, instance: 1 });
    expect(reverting.room.state.offer_serial).toBe(1);
    expect(emittedOf(reverting.room).has(key)).toBe(false);
    expect(reverting.kinds(reverting.submit(P2, M.answerPrivate(DH, true))).slice(0, 2)).toEqual(["AnswerPrivatePurchase", "BuyPrivateCompany*"]);
    expect(priv(reverting.room.state, DH).owner_protocol_id).toBe(PRR);
    expect(emittedOf(reverting.room).has(key)).toBe(true);
  });

  it("R74-B.7 the TRAIN settlement likewise always lands on the acceptance's board (and a fill to the limit now ends the turn, O1)", () => {
    const legalBoards: Array<[string, GameStateResponse, string, boolean]> = [
      ["control", operatingBoard(), "150", false],
      ["price $1", operatingBoard(), "1", false],
      ["treasury exact", withCorp(operatingBoard(), PRR, { treasury: "150" }), "150", false],
      ["one below the limit", withCorp(operatingBoard(), PRR, { owned_trains: ["2", "2", "2"] }), "150", true],
    ];
    for (const [label, legal, price, fills] of legalBoards) {
      const offered = apply(legal, M.proposeTrain(NYC, PRR, "3", price), P1);
      expect([label, answerTrainPurchaseRefusal(offered, { seller_protocol_id: NYC, accept: true }, P2, GRID)]).toEqual([label, null]);
      const accepted = apply(offered, M.answerTrain(NYC, true), P2);
      expect([label, trainSaleRefusal(accepted, { buyerId: PRR, sellerId: NYC, model: "3", price }, P2, GRID, "settlement")]).toEqual([label, null]);
      expect([label, nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() })?.key]).toEqual([label, "offer:train:1"]);
      const { room, submit, kinds } = S.roomFor(legal);
      submit(P1, M.proposeTrain(NYC, PRR, "3", price));
      const burst = kinds(submit(P2, M.answerTrain(NYC, true)));
      expect([label, burst.slice(0, 2)]).toEqual([label, ["AnswerTrainPurchase", "BuyTrainFromCorporation*"]]);
      // #1598 (O1): the fleet that fills the limit ends the turn from the offer path as it does from the depot.
      expect([label, burst.includes("PassTurn*")]).toEqual([label, fills]);
      expect([label, room.state.train_purchase_offer]).toEqual([label, null]);
    }
  });

  it("R74-B.8 the strongest minimal regression: the SAME seller, model, buyer, fleet size AND price recur, and the second acceptance settles exactly once", () => {
    /* Instance identity, not a larger fingerprint: after the first settlement PRR's own depot purchase rusts its
       two 2-trains, so the second offer -- NYC's other 3-train, to PRR, at fleet 2, at the same $150 -- is identical
       to the first in every game property the old key or a price-widened key could have named. */
    const seed = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2", "2"], treasury: "1000" },
        { id: NYC, ticker: "NYC", president: P2, trains: ["3", "3"], treasury: "400", price: 90 },
        { id: CO, ticker: "C&O", president: P3, trains: ["3", "3", "3"], treasury: "300", price: 80 },
      ],
    });
    const table = legalTable(seed);
    const { room, applied, kinds, logged } = table;
    const tuple = (state: GameStateResponse) => ({
      seller: NYC, model: "3", buyer: PRR, fleet: trains(state, PRR).length, price: room.state.train_purchase_offer?.price,
    });
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const firstTuple = tuple(room.state);
    const firstKey = table.keyIfAccepted(NYC)!;
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), firstKey, 1);
    applied(P1, M.depot(PRR)); // the first 4: both 2s rust, PRR is [3, 4] -- fleet 2 again
    applied(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const secondTuple = tuple(room.state);
    expect(secondTuple).toEqual(firstTuple);
    expect(secondTuple).toEqual({ seller: NYC, model: "3", buyer: PRR, fleet: 2, price: "150" });
    const secondKey = table.keyIfAccepted(NYC)!;
    expect([firstKey, secondKey]).toEqual(["offer:train:1", "offer:train:2"]);
    const before = { prr: treasury(room.state, PRR), nyc: treasury(room.state, NYC) };
    expectSettledOnce(table, kinds(applied(P2, M.answerTrain(NYC, true))), secondKey, 2);
    expect(trains(room.state, PRR)).toEqual(["3", "4", "3"]);
    expect(trains(room.state, NYC)).toEqual([]);
    expect(treasury(room.state, PRR)).toBe(before.prr - 150); // paid once
    expect(treasury(room.state, NYC)).toBe(before.nyc + 150); // received once
    expect(logged("BuyTrainFromCorporation").map((entry) => JSON.parse(entry.payload).BuyTrainFromCorporation.price)).toEqual(["150", "150"]);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
    // The two settlements are two instances in the room's guard; the old tuple would have been one key.
    expect(Array.from(emittedOf(room)).filter((key) => key.startsWith("offer:"))).toEqual(["offer:train:1", "offer:train:2"]);
    expect(room.state.offer_serial).toBe(2);
  });
});

/* ================================================================== */
/* §15 the offer instance is log-derived: replay, revert, rebuild       */
/* ================================================================== */

describe("§15 (#1597) the offer instance is a function of the log: replay, RevertTo and rebuild reproduce it; a new offer is a new instance", () => {
  const replay = (entries: ReturnType<typeof S.entry>[], seed: GameStateResponse) =>
    replayLog(entries, providers(), { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);
  const settlement = (seed: GameStateResponse) => {
    const { submit, logged } = S.roomFor(seed);
    submit(P1, M.proposePrivate(DH, PRR, 100));
    submit(P2, M.answerPrivate(DH, true));
    return JSON.parse(logged("BuyPrivateCompany")[0].payload);
  };

  it("replay from the seed assigns the same instance every time, and the settled board keeps the serial", () => {
    const seed = operatingBoard();
    const settle = settlement(seed);
    const history = [S.entry(0, P1, M.proposePrivate(DH, PRR, 100)), S.entry(1, P2, M.answerPrivate(DH, true)), S.entry(2, P2, settle, true)];
    const once = replay(history, seed);
    const again = replay(history, seed);
    expect(once.applied).toBe(3);
    expect(stateDigest(once.state)).toBe(stateDigest(again.state));
    expect(once.state.private_purchase_offer).toBeNull();
    expect(once.state.offer_serial).toBe(1);
    expect(priv(once.state, DH).owner_protocol_id).toBe(PRR);
    // The proposal alone: instance 1, serial 1, pending.
    const pending = replay(history.slice(0, 1), seed);
    expect(pending.state.private_purchase_offer).toMatchObject({ private_id: DH, instance: 1 });
    expect(pending.state.offer_serial).toBe(1);
    expect(nextDerivedAction({ state: replay(history.slice(0, 2), seed).state, mapGrid: GRID, emitted: new Set() })?.key).toBe("offer:private:1");
  });

  it("RevertTo before the proposal rebuilds a board with no offer and no serial; after the proposal, the same pending instance", () => {
    const seed = operatingBoard();
    const settle = settlement(seed);
    const history = [S.entry(0, P1, M.proposePrivate(DH, PRR, 100)), S.entry(1, P2, M.answerPrivate(DH, true)), S.entry(2, P2, settle, true)];
    const empty = replay([...history, S.entry(3, P1, M.revert(0))], seed);
    expect(empty.state.private_purchase_offer ?? null).toBeNull();
    expect("offer_serial" in empty.state).toBe(false);
    expect(stateDigest(empty.state)).toBe(stateDigest(replay([], seed).state));
    const pending = replay([...history, S.entry(3, P1, M.revert(1))], seed);
    expect(pending.state.private_purchase_offer).toMatchObject({ private_id: DH, owner: P2, instance: 1 });
    expect(pending.state.offer_serial).toBe(1);
    expect(stateDigest(pending.state)).toBe(stateDigest(replay(history.slice(0, 1), seed).state));
    expect(priv(pending.state, DH).owner).toBe(P2);
  });

  it("through a room: a revert to after the acceptance re-derives the settlement under the same instance key, once", () => {
    const { room, submit, kinds, logged } = S.roomFor(operatingBoard());
    submit(P1, M.proposePrivate(DH, PRR, 100));
    expect(kinds(submit(P2, M.answerPrivate(DH, true))).slice(0, 2)).toEqual(["AnswerPrivatePurchase", "BuyPrivateCompany*"]);
    // Entries: 0 propose, 1 answer, 2 settlement*. Revert to 2 keeps the acceptance and drops the settlement.
    const reverted = submit(P1, M.revert(2));
    expect(reverted.kind).toBe("applied");
    expect(kinds(reverted)).toEqual(["RevertTo", "BuyPrivateCompany*"]);
    expect(priv(room.state, DH).owner_protocol_id).toBe(PRR);
    expect(room.state.private_purchase_offer).toBeNull();
    expect(room.state.offer_serial).toBe(1);
    expect(emittedOf(room).has("offer:private:1")).toBe(true);
    // Two settlement entries in the raw log (one dead), one in effect, one purchase paid.
    expect(logged("BuyPrivateCompany")).toHaveLength(2);
    expect(S.cash(room.state, P2)).toBe(S.cash(operatingBoard(), P2) + 100);
    expect(nextDerivedAction({ state: room.state, mapGrid: GRID, emitted: new Set() })).toBeNull();
  });

  it("a later offer is a later instance -- after a settlement, a rejection and a rescission alike -- and a rebuild of the same history agrees", () => {
    const seed = withPriv(operatingBoard(), CA, { owner: P2 });
    const { room, submit, kinds } = S.roomFor(seed);
    submit(P1, M.proposePrivate(DH, PRR, 100));
    submit(P2, M.answerPrivate(DH, false)); // rejected: instance 1 spent
    expect(room.state.private_purchase_offer).toBeNull();
    expect(room.state.offer_serial).toBe(1);
    submit(P1, M.proposePrivate(CA, PRR, 100));
    expect(room.state.private_purchase_offer).toMatchObject({ private_id: CA, instance: 2 });
    submit(P1, M.rescindPrivate(CA)); // rescinded: instance 2 spent
    expect(room.state.offer_serial).toBe(2);
    submit(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    expect(room.state.train_purchase_offer).toMatchObject({ instance: 3 });
    expect(kinds(submit(P2, M.answerTrain(NYC, true))).slice(0, 2)).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*"]);
    expect(emittedOf(room).has("offer:train:3")).toBe(true);
    submit(P1, M.proposePrivate(CA, PRR, 100));
    expect(room.state.private_purchase_offer).toMatchObject({ private_id: CA, instance: 4 });
    expect(kinds(submit(P2, M.answerPrivate(CA, true))).slice(0, 2)).toEqual(["AnswerPrivatePurchase", "BuyPrivateCompany*"]);
    expect(emittedOf(room).has("offer:private:4")).toBe(true);
    expect(room.state.offer_serial).toBe(4);
    expect(Array.from(emittedOf(room)).filter((key) => key.startsWith("offer:")).sort()).toEqual(["offer:private:4", "offer:train:3"]);
    // Rebuilt from the log: the same serial, the same digest, the same two offer keys recorded, nothing owed.
    for (let rebuild = 0; rebuild < 2; rebuild += 1) {
      const restored = S.roomFor(seed);
      restored.room.restore(room.entries as ServerLogEntry[]);
      expect(stateDigest(restored.room.state)).toBe(stateDigest(room.state));
      expect(restored.room.state.offer_serial).toBe(4);
      expect(Array.from(emittedOf(restored.room)).filter((key) => key.startsWith("offer:")).sort()).toEqual(["offer:private:4", "offer:train:3"]);
      expect(nextDerivedAction({ state: restored.room.state, mapGrid: GRID, emitted: new Set() })).toBeNull();
    }
    // And a fresh identical history in a second room lands on the same numbers.
    const twin = S.roomFor(seed);
    for (const entry of room.entries as ServerLogEntry[]) {
      if (!entry.derived) twin.submit(entry.actor, JSON.parse(entry.payload));
    }
    expect(stateDigest(twin.room.state)).toBe(stateDigest(room.state));
  });

  it("the funding offer takes no number and does not move the serial (Batch-5 semantics untouched)", () => {
    // C&O (P1) owes a train it cannot pay for; its president offers his own private to NYC (rulebook 6.6.3).
    const held = S.fundingBoard(100, { privates: [{ id: DH, owner: P1, cost: "70" }] });
    const offered = apply(held, M.fundingOffer(DH, NYC, 70), P1, S.corridor());
    expect(offered.private_purchase_offer).toMatchObject({ funding: true, private_id: DH });
    expect(offered.private_purchase_offer?.instance).toBeUndefined();
    expect("offer_serial" in offered).toBe(false);
    expect(nextDerivedAction({ state: { ...offered, private_purchase_offer: { ...offered.private_purchase_offer!, accepted: true } }, mapGrid: S.corridor(), emitted: new Set() })?.kind).not.toBe("accepted-offer");
  });
});

/* ================================================================== */
/* §14 companion -- O1, REPAIRED (#1598): equivalent boards, equivalent progression */
/* ================================================================== */

describe("§14 companion (#1598, O1 repaired): a derived settlement is recorded under its own key, so the step's own derived End Turn is not swallowed", () => {
  const corps = (nycTrains: string[]) => [
    { id: PRR, ticker: "PRR", president: P1, trains: ["2", "2", "2"], treasury: "1000" },
    { id: NYC, ticker: "NYC", president: P2, trains: nycTrains, treasury: "400", price: 90 },
    { id: CO, ticker: "C&O", president: P3, trains: ["3"], treasury: "300", price: 80 },
  ];
  const turnKey = `3.1.0:${PRR}:Hardware`;

  it("a derived train settlement that fills the buyer to its limit at Hardware ends the turn, exactly as the same fill from the depot does", () => {
    const offered = S.roomFor(board({ round: "OperatingRound", corps: corps(["3", "3"]) }));
    offered.submit(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const burst = offered.kinds(offered.submit(P2, M.answerTrain(NYC, true)));
    expect(burst).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*", "PassTurn*"]);
    expect(trains(offered.room.state, PRR)).toEqual(["2", "2", "2", "3"]);
    expect([offered.room.state.active_corporation_index, offered.room.state.operating_sub_phase]).toEqual([1, "Track"]);
    // The room's guard holds the settlement's OWN key and the turn key the End Turn consumed -- each once.
    expect(emittedOf(offered.room).has("offer:train:1")).toBe(true);
    expect(emittedOf(offered.room).has(turnKey)).toBe(true);
    expect(offered.logged("PassTurn")).toHaveLength(1);
    expect(nextDerivedAction({ state: offered.room.state, mapGrid: GRID, emitted: emittedOf(offered.room) })).toBeNull();

    const depot = S.roomFor(board({ round: "OperatingRound", corps: corps(["3"]) }));
    expect(depot.kinds(depot.submit(P1, M.depot(PRR)))).toEqual(["BuyHardwareFromPool", "PassTurn*"]);
    expect(trains(depot.room.state, PRR)).toEqual(["2", "2", "2", "3"]);
    expect([depot.room.state.active_corporation_index, depot.room.state.operating_sub_phase]).toEqual([1, "Track"]);
    expect(emittedOf(depot.room).has(turnKey)).toBe(true);

    // CONVERGENCE: the two paths land on the same turn-complete board in every guarded respect but the money
    // (the depot pays the bank, the offer pays NYC) and NYC's own fleet.
    const cursor = (state: GameStateResponse) => ({ ...guarded(state), money: undefined, trainOwnership: trains(state, PRR) });
    expect(cursor(offered.room.state)).toEqual(cursor(depot.room.state));
    const offeredPass = JSON.parse(offered.logged("PassTurn")[0].payload);
    const depotPass = JSON.parse(depot.logged("PassTurn")[0].payload);
    expect(offeredPass).toEqual(depotPass);
    expect(offered.logged("PassTurn")[0].derived).toBe(true);
    expect(depot.logged("PassTurn")[0].derived).toBe(true);
  });

  it("a rebuild of the offer path's log records the same keys and owes nothing more; a restore that ends before the End Turn derives it once", () => {
    const seed = board({ round: "OperatingRound", corps: corps(["3", "3"]) });
    const live = S.roomFor(seed);
    live.submit(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    live.submit(P2, M.answerTrain(NYC, true));
    const digest = stateDigest(live.room.state);
    const restored = S.roomFor(seed);
    restored.room.restore(live.room.entries as ServerLogEntry[]);
    expect(stateDigest(restored.room.state)).toBe(digest);
    expect(emittedOf(restored.room).has("offer:train:1")).toBe(true);
    expect(emittedOf(restored.room).has(turnKey)).toBe(true);
    expect(nextDerivedAction({ state: restored.room.state, mapGrid: GRID, emitted: emittedOf(restored.room) })).toBeNull();
    // A crash between the settlement and the End Turn: the repair loop finishes the burst -- once.
    const cut = (live.room.entries as ServerLogEntry[]).slice(0, 3); // propose, answer, settlement*
    expect(JSON.parse(cut[2].payload)).toHaveProperty("BuyTrainFromCorporation");
    const crashed = S.roomFor(seed);
    crashed.room.restore(cut);
    expect([crashed.room.state.active_corporation_index, crashed.room.state.operating_sub_phase]).toEqual([0, "Hardware"]);
    expect(emittedOf(crashed.room).has("offer:train:1")).toBe(true);
    expect(emittedOf(crashed.room).has(turnKey)).toBe(false); // the settlement did NOT spend the turn key
    const repair = crashed.submit(P1, M.pass); // any submit runs the repair loop first
    /* #1685 (Stage 10.2): the hand-sent End Turn is refused by ingress after the repair, and the refusal now
       CARRIES the repair (it used to be a bare catch-up that dropped the sentence). */
    expect(repair.kind).toBe("refused");
    const carried = (repair as { catchUp?: { entries: ServerLogEntry[] } }).catchUp;
    expect(crashed.kinds({ kind: "applied", entries: carried?.entries ?? [] } as never)).toEqual(["PassTurn*"]); // the owed End Turn; the hand-sent one is then not PRR's to send
    expect(stateDigest(crashed.room.state)).toBe(digest);
  });

  it("the private purchase at Hardware records its own key and leaves the step's turn key for the board to decide", () => {
    // A private purchase never fills a fleet; the point is the KEY: the settlement no longer consumes the turn key.
    const { room, submit, kinds } = S.roomFor(operatingBoard());
    submit(P1, M.proposePrivate(DH, PRR, 100));
    expect(kinds(submit(P2, M.answerPrivate(DH, true)))).toEqual(["AnswerPrivatePurchase", "BuyPrivateCompany*"]);
    expect(emittedOf(room).has("offer:private:1")).toBe(true);
    expect(emittedOf(room).has(turnKey)).toBe(false);
    expect([room.state.active_corporation_index, room.state.operating_sub_phase]).toEqual([0, "Hardware"]);
    expect(kinds(submit(P1, M.pass))).toEqual(["PassTurn"]);
  });
});
