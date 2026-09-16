/** @jest-environment node */
//
// ==================================================================
//  BATCH 7.4 EXHAUSTIVE MATRIX (6/6): REVERT AND REPLAY, THE SCHEMA, CONSERVATION AND ATOMICITY
// ==================================================================
//
// §15: every offer family rebuilt from its log -- reverted before the proposal (nothing), between proposal and
// answer (the exact pending offer and its hold), replayed through a rejection or a rescission (nothing), through
// acceptance and settlement (one transfer), rebuilt again (no double) -- through `replayLog` and through a live
// room's `RevertTo`; the trade settles from its answer and never carries an accepted flag. §16: the schema's 49
// kinds, the five new shapes, structural refusals where the schema owns the shape and semantic refusals where the
// authority owns the rule, old stored shapes still parsing, the chain-era trio refused on pinned boards and kept in
// the types. §17: money conserved and exactly the right accounts moved for all three transfer families; refusals
// digest-equal and partial alteration of no guarded field.

export {};

const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { pendingOfferBlock, legacyOfferMessageRefusal, isLegacyOfferMessage } =
  require("../gameEngine/pendingOfferHold") as typeof import("../gameEngine/pendingOfferHold");
const { validateGameplayMessage, GAMEPLAY_MESSAGE_KINDS, GAMEPLAY_MESSAGE_SCHEMA } =
  require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
const { isSandboxOnlyMsg } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type GameplayExecuteMsg = import("./sessionKey").GameplayExecuteMsg;

const { P1, P2, P3, PRR, NYC, CO, DH, operatingBoard, stockRoundBoard } = F;
const { apply, ingress, same, differing, withCorp, withPriv, withState, withCash, priv, cash, treasury, trains, guarded, M, GRID, CORRIDOR, fundingBoard } = S;

const providers = (grid = GRID) => ({ ...sandboxReplayProviders(), initialGrid: grid });
const replay = (seed: GameStateResponse, entries: unknown[], grid = GRID) =>
  replayLog(entries as never, providers(grid), { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY);

/* ================================================================== */
/* §15 revert and replay                                                */
/* ================================================================== */

const FAMILIES = [
  {
    label: "the private purchase",
    field: "private_purchase_offer" as const,
    seed: () => operatingBoard(),
    propose: [P1, M.proposePrivate(DH, PRR, 100)] as [string, unknown],
    accept: [P2, M.answerPrivate(DH, true)] as [string, unknown],
    reject: [P2, M.answerPrivate(DH, false)] as [string, unknown],
    rescind: [P1, M.rescindPrivate(DH)] as [string, unknown],
    settlement: [P2, { BuyPrivateCompany: { game_id: 0, protocol_id: PRR, private_id: DH, price: "100" } }] as [string, unknown] | null,
    transferred: (state: GameStateResponse) => priv(state, DH).owner_protocol_id === PRR && treasury(state, PRR) === 400 && cash(state, P2) === 400,
    untouched: (state: GameStateResponse) => priv(state, DH).owner === P2 && treasury(state, PRR) === 500 && cash(state, P2) === 300,
  },
  {
    label: "the train sale",
    field: "train_purchase_offer" as const,
    seed: () => operatingBoard(),
    propose: [P1, M.proposeTrain(NYC, PRR, "3", "150")] as [string, unknown],
    accept: [P2, M.answerTrain(NYC, true)] as [string, unknown],
    reject: [P2, M.answerTrain(NYC, false)] as [string, unknown],
    rescind: [P1, M.rescindTrain(NYC)] as [string, unknown],
    settlement: [P2, { BuyTrainFromCorporation: { game_id: 0, buyer_protocol_id: PRR, seller_protocol_id: NYC, model_type: "3", price: "150" } }] as [string, unknown] | null,
    transferred: (state: GameStateResponse) => trains(state, PRR).join() === "2,3" && treasury(state, PRR) === 350 && treasury(state, NYC) === 550,
    untouched: (state: GameStateResponse) => trains(state, PRR).join() === "2" && treasury(state, PRR) === 500 && treasury(state, NYC) === 400,
  },
  {
    label: "the player trade",
    field: "private_trade_offer" as const,
    seed: () => stockRoundBoard(),
    propose: [P1, M.proposeTrade(DH, P2, P1, 50)] as [string, unknown],
    accept: [P2, M.answerTrade(DH, true)] as [string, unknown],
    reject: [P2, M.answerTrade(DH, false)] as [string, unknown],
    rescind: [P1, M.rescindTrade(DH)] as [string, unknown],
    settlement: null as [string, unknown] | null, // the answer IS the settlement
    transferred: (state: GameStateResponse) => priv(state, DH).owner === P1 && cash(state, P1) === 250 && cash(state, P2) === 350,
    untouched: (state: GameStateResponse) => priv(state, DH).owner === P2 && cash(state, P1) === 300 && cash(state, P2) === 300,
  },
];

describe("§15 revert and replay reconstruct every offer state from the log", () => {
  for (const family of FAMILIES) {
    const e = (index: number, [actor, msg]: [string, unknown], derived = false) => S.entry(index, actor, msg, derived);
    const settled = (): unknown[] =>
      family.settlement === null
        ? [e(0, family.propose), e(1, family.accept)]
        : [e(0, family.propose), e(1, family.accept), e(2, family.settlement, true)];

    it(`${family.label}: reverted before the proposal -- no offer and no hold`, () => {
      const { state } = replay(family.seed(), [e(0, family.propose), S.entry(1, P1, M.revert(0))]);
      expect(state[family.field] ?? null).toBeNull();
      expect(pendingOfferBlock(state, M.pass as never)).toBeNull();
      expect(stateDigest(state)).toBe(stateDigest(replay(family.seed(), []).state));
    });

    it(`${family.label}: reverted to after the proposal -- the exact pending offer and its hold, the asset and money untouched`, () => {
      const proposedOnly = replay(family.seed(), [e(0, family.propose)]).state;
      const reverted = replay(family.seed(), [...settled(), S.entry(9, P1, M.revert(1))]).state;
      expect(reverted[family.field]).toEqual(proposedOnly[family.field]);
      expect(stateDigest(reverted)).toBe(stateDigest(proposedOnly));
      expect(pendingOfferBlock(reverted, M.pass as never)).toContain("nothing else can happen until it is answered or withdrawn");
      expect(family.untouched(reverted)).toBe(true);
    });

    it(`${family.label}: replayed through a rejection or a rescission -- no offer, nothing moved`, () => {
      for (const ending of [family.reject, family.rescind]) {
        const { state } = replay(family.seed(), [e(0, family.propose), e(1, ending)]);
        expect(state[family.field]).toBeNull();
        expect(family.untouched(state)).toBe(true);
        expect(guarded(state)).toEqual(guarded(family.seed()));
      }
    });

    it(`${family.label}: replayed through acceptance and settlement -- one transfer; rebuilt again -- the same board, no double`, () => {
      const once = replay(family.seed(), settled());
      expect(once.applied).toBe(settled().length);
      expect(family.transferred(once.state)).toBe(true);
      expect(once.state[family.field]).toBeNull();
      expect(moneyTotal(once.state)).toBe(moneyTotal(family.seed()));
      const again = replay(family.seed(), settled());
      expect(stateDigest(again.state)).toBe(stateDigest(once.state));
      // A rebuild through a room's restore agrees too.
      const live = S.roomFor(family.seed());
      live.submit(family.propose[0], family.propose[1]);
      live.submit(family.accept[0], family.accept[1]);
      const restored = S.roomFor(family.seed());
      restored.room.restore(live.room.entries as never);
      expect(stateDigest(restored.room.state)).toBe(stateDigest(live.room.state));
      expect(stateDigest(live.room.state)).toBe(stateDigest(once.state));
    });

    it(`${family.label}: a live room's host RevertTo between proposal and answer restores the pending offer, and the re-accepted offer settles once`, () => {
      const table = S.roomFor(family.seed());
      table.submit(family.propose[0], family.propose[1]);
      const pending = table.room.state[family.field];
      table.submit(family.accept[0], family.accept[1]);
      expect(family.transferred(table.room.state)).toBe(true);
      expect(table.submit(P1, M.revert(1)).kind).toBe("applied");
      expect(table.room.state[family.field]).toEqual(pending);
      expect(family.untouched(table.room.state)).toBe(true);
      expect(pendingOfferBlock(table.room.state, M.pass as never)).not.toBeNull();
      expect(table.submit(family.accept[0], family.accept[1]).kind).toBe("applied");
      expect(family.transferred(table.room.state)).toBe(true);
      expect(moneyTotal(table.room.state)).toBe(moneyTotal(family.seed()));
      // And a revert before the proposal leaves no offer at all.
      const early = S.roomFor(family.seed());
      early.submit(family.propose[0], family.propose[1]);
      expect(early.submit(P1, M.revert(0)).kind).toBe("applied");
      expect(early.room.state[family.field] ?? null).toBeNull();
      expect(pendingOfferBlock(early.room.state, M.pass as never)).toBeNull();
    });
  }

  it("the player trade reconstructs its settlement from the answer: no derived entry, and no replayed board ever carries an accepted flag", () => {
    const seen: Array<unknown> = [];
    const observed = replayLog(
      [S.entry(0, P1, M.proposeTrade(DH, P2, P1, 50)), S.entry(1, P2, M.answerTrade(DH, true))] as never,
      providers(),
      { state: stockRoundBoard(), waterfall: null },
      ({ stateBefore }) => seen.push(stateBefore.private_trade_offer ?? null),
      DEVELOPMENT_CORPUS_POLICY,
    );
    seen.push(observed.state.private_trade_offer ?? null);
    expect(seen).toEqual([null, { private_id: DH, private_name: "Delaware & Hudson", seller: P2, buyer: P1, price: 50, proposer: P1, instance: 1 }, null]); // #1597
    expect(seen.some((offer) => offer !== null && "accepted" in (offer as object))).toBe(false);
    expect(priv(observed.state, DH).owner).toBe(P1);
    const { room, kinds, submit } = S.roomFor(stockRoundBoard());
    submit(P1, M.proposeTrade(DH, P2, P1, 50));
    expect(kinds(submit(P2, M.answerTrade(DH, true)))).toEqual(["AnswerPrivateTrade"]);
    expect(room.entries.some((entry) => (entry as { derived?: boolean }).derived)).toBe(false);
  });
});

/* ================================================================== */
/* §16 the schema                                                      */
/* ================================================================== */

describe("§16 message schema and compatibility", () => {
  const NEW_KINDS = ["RescindPrivatePurchase", "RescindTrainPurchase", "ProposePrivateTrade", "AnswerPrivateTrade", "RescindPrivateTrade"];

  it("the live count is 49 and the five new kinds are in it, each seat-exempt with its own owner", () => {
    expect(GAMEPLAY_MESSAGE_KINDS.length).toBe(49);
    for (const kind of NEW_KINDS) {
      expect(GAMEPLAY_MESSAGE_KINDS).toContain(kind);
      expect(isSandboxOnlyMsg({ [kind]: {} } as never)).toBe(true);
    }
    expect(Object.keys(GAMEPLAY_MESSAGE_SCHEMA).length).toBe(49);
  });

  it("the five shapes are accepted structurally, with and without game_id", () => {
    const shapes: unknown[] = [
      M.rescindPrivate(DH),
      { RescindPrivatePurchase: { private_id: DH } },
      M.rescindTrain(NYC),
      { RescindTrainPurchase: { seller_protocol_id: NYC } },
      M.proposeTrade(DH, P2, P1, 0),
      { ProposePrivateTrade: { private_id: DH, seller: P2, buyer: P1, price: 1000 } },
      M.answerTrade(DH, true),
      { AnswerPrivateTrade: { private_id: DH, accept: false } },
      M.rescindTrade(DH),
      { RescindPrivateTrade: { private_id: DH } },
    ];
    for (const shape of shapes) expect(validateGameplayMessage(shape)).toEqual({ ok: true, kind: Object.keys(shape as object)[0] });
  });

  const MALFORMED: Array<[unknown, string]> = [
    [{ RescindPrivatePurchase: {} }, "RescindPrivatePurchase.private_id is missing."],
    [{ RescindPrivatePurchase: { private_id: "3" } }, "RescindPrivatePurchase.private_id must be a whole number."],
    [{ RescindPrivatePurchase: { private_id: 3.5 } }, "RescindPrivatePurchase.private_id must be a whole number."],
    [{ RescindTrainPurchase: { seller_protocol_id: "2" } }, "RescindTrainPurchase.seller_protocol_id must be a whole number."],
    [{ RescindTrainPurchase: { game_id: "1", seller_protocol_id: 2 } }, "RescindTrainPurchase.game_id must be a whole number."],
    [{ ProposePrivateTrade: { seller: P2, buyer: P1, price: 1 } }, "ProposePrivateTrade.private_id is missing."],
    [{ ProposePrivateTrade: { private_id: DH, buyer: P1, price: 1 } }, "ProposePrivateTrade.seller is missing."],
    [{ ProposePrivateTrade: { private_id: DH, seller: P2, buyer: 1, price: 1 } }, "ProposePrivateTrade.buyer must be a string."],
    [{ ProposePrivateTrade: { private_id: DH, seller: P2, buyer: P1 } }, "ProposePrivateTrade.price is missing."],
    [{ ProposePrivateTrade: { private_id: DH, seller: P2, buyer: P1, price: 1.5 } }, "ProposePrivateTrade.price must be a whole number."],
    [{ ProposePrivateTrade: { private_id: DH, seller: P2, buyer: P1, price: "50" } }, "ProposePrivateTrade.price must be a whole number."],
    [{ AnswerPrivateTrade: { private_id: DH } }, "AnswerPrivateTrade.accept is missing."],
    [{ AnswerPrivateTrade: { private_id: DH, accept: "yes" } }, "AnswerPrivateTrade.accept must be true or false."],
    [{ RescindPrivateTrade: { private_id: null } }, "RescindPrivateTrade.private_id must be a whole number."],
    [{ RescindPrivateTrade: "x" }, "RescindPrivateTrade must carry an object."],
    [{ RescindPrivateTrade: { private_id: DH }, RescindTrainPurchase: { seller_protocol_id: NYC } }, "A message names one action; that one names 2 (RescindPrivateTrade, RescindTrainPurchase)."],
  ];
  for (const [msg, reason] of MALFORMED) {
    it(`structurally refused: ${reason}`, () => {
      expect(validateGameplayMessage(msg)).toEqual({ ok: false, reason });
    });
  }

  it("shape-valid but rule-illegal prices are the authority's refusal, at both locks", () => {
    const or = operatingBoard();
    const sr = stockRoundBoard();
    const cases: Array<[string, GameStateResponse, string, unknown, string]> = [
      ["a negative trade price", sr, P1, M.proposeTrade(DH, P2, P1, -1), "The price must be a whole number of dollars ($0 or more)."],
      ["a fractional private offer price (the schema's `finite`)", or, P1, M.proposePrivate(DH, PRR, 70.5), "The price must be a whole number between $35 and $140 (half to twice Delaware & Hudson's $70 face value)."],
      ["a negative private offer price", or, P1, M.proposePrivate(DH, PRR, -1), "The price must be a whole number between $35 and $140 (half to twice Delaware & Hudson's $70 face value)."],
      ["a $0 train offer (a string on the wire)", or, P1, M.proposeTrain(NYC, PRR, "3", "0"), "The price must be a whole number of at least $1 (rulebook 6.6)."],
      ["a non-numeric train offer price", or, P1, M.proposeTrain(NYC, PRR, "3", "1e999"), "The price must be a whole number of at least $1 (rulebook 6.6)."],
      ["a negative direct private settlement", withPriv(or, DH, { owner: P1 }), P1, M.buyPrivate(PRR, DH, "-100"), "The price must be a whole number between $35 and $140 (half to twice Delaware & Hudson's $70 face value)."],
      ["a $0 direct train settlement", withCorp(or, NYC, { president: P1 }), P1, M.buyTrain(PRR, NYC, "3", "0"), "The price must be a whole number of at least $1 (rulebook 6.6)."],
    ];
    for (const [label, board, actor, msg, refusal] of cases) {
      expect([label, validateGameplayMessage(msg).ok]).toEqual([label, true]);
      expect([label, ingress(board, actor, msg)]).toEqual([label, refusal]);
      expect([label, same(apply(board, msg, actor), board)]).toEqual([label, true]);
    }
  });

  it("old stored message shapes still parse", () => {
    const stored: unknown[] = [
      { ProposePrivatePurchase: { game_id: 1, private_id: 3, private_name: "Delaware & Hudson", owner: "p-alice", buyer_protocol_id: 7, buyer_ticker: "NNH", price: 70 } },
      { ProposePrivatePurchase: { private_id: 3, owner: "p-alice", buyer_protocol_id: 7, price: 70 } },
      { AnswerPrivatePurchase: { game_id: 1, private_id: 3, accept: true } },
      { ProposeTrainPurchase: { game_id: 1, seller_protocol_id: 4, seller_ticker: "B&O", seller_president: "p-bob", buyer_protocol_id: 1, buyer_ticker: "PRR", model_type: "3", price: "150" } },
      { ProposeTrainPurchase: { seller_protocol_id: 4, seller_president: null, buyer_protocol_id: 1, model_type: "3", price: "150" } },
      { AnswerTrainPurchase: { game_id: 1, seller_protocol_id: 4, accept: false } },
      { BuyPrivateCompany: { game_id: 0, protocol_id: 7, private_id: 3, price: "70" } },
      { BuyTrainFromCorporation: { game_id: 0, buyer_protocol_id: 1, seller_protocol_id: 4, model_type: "3", price: "150" } },
      { OfferPrivateForFunding: { game_id: 1, private_id: 3, buyer_protocol_id: 7, price: 70 } },
      { AnswerFundingPrivateOffer: { game_id: 1, private_id: 3, accept: true } },
      { RescindFundingPrivateOffer: { game_id: 1, private_id: 3 } },
      { AcceptTrainOffer: { game_id: 1, offer_id: 0 } },
      { RejectTrainOffer: { game_id: 1, offer_id: 0 } },
      { RescindTrainOffer: { offer_id: 0 } },
    ];
    for (const msg of stored) expect(validateGameplayMessage(msg)).toMatchObject({ ok: true });
  });

  const LEGACY: Array<[unknown, string]> = [
    [{ AcceptTrainOffer: { game_id: 1, offer_id: 1 } }, "AcceptTrainOffer is a chain-era message this game does not play: a selling president answers with AnswerTrainPurchase."],
    [{ RejectTrainOffer: { game_id: 1, offer_id: 1 } }, "RejectTrainOffer is a chain-era message this game does not play: a selling president answers with AnswerTrainPurchase."],
    [{ RescindTrainOffer: { game_id: 1, offer_id: 1 } }, "RescindTrainOffer is a chain-era message this game does not play: a proposer withdraws with RescindTrainPurchase."],
  ];
  for (const [msg, refusal] of LEGACY) {
    const kind = Object.keys(msg as object)[0];
    it(`${kind}: refused on a pinned board at both locks with its replacement named -- with or without a standing offer -- and a no-op on a legacy board`, () => {
      const pinned = operatingBoard();
      expect(isLegacyOfferMessage(msg as never)).toBe(true);
      expect(legacyOfferMessageRefusal(pinned, msg as never)).toBe(refusal);
      for (const actor of [P1, P2]) expect(ingress(pinned, actor, msg)).toBe(refusal);
      expect(same(apply(pinned, msg, P1), pinned)).toBe(true);
      const offered = apply(pinned, M.proposeTrain(NYC, PRR, "3", "150"), P1);
      expect(ingress(offered, P1, msg)).toBe(refusal); // Q11 is asked before the hold
      expect(same(apply(offered, msg, P1), offered)).toBe(true);
      const legacy = withState(pinned, { rules_engine_version: undefined });
      expect(legacyOfferMessageRefusal(legacy, msg as never)).toBeNull();
      expect(same(apply(legacy, msg, P1), legacy)).toBe(true);
    });
  }

  it("the chain-era types are kept (compile-time: they are still members of the gameplay union)", () => {
    const kept: GameplayExecuteMsg[] = [
      { AcceptTrainOffer: { game_id: 1, offer_id: 1 } },
      { RejectTrainOffer: { game_id: 1, offer_id: 1 } },
      { RescindTrainOffer: { game_id: 1, offer_id: 1 } },
    ];
    expect(kept.every((msg) => isLegacyOfferMessage(msg))).toBe(true);
    for (const kind of ["AcceptTrainOffer", "RejectTrainOffer", "RescindTrainOffer"]) expect(GAMEPLAY_MESSAGE_KINDS).toContain(kind);
  });
});

/* ================================================================== */
/* §17 conservation and atomicity                                       */
/* ================================================================== */

/** Every money account on the board, by name. */
const accounts = (state: GameStateResponse): Record<string, number> => ({
  bank: Number(state.virtual_bank_vgp),
  ...Object.fromEntries(state.player_cash.map((entry) => [`cash:${entry.player}`, Number(entry.cash_vgp)])),
  ...Object.fromEntries(state.public_companies.map((entry) => [`treasury:${entry.ticker}`, Number(entry.treasury)])),
});
const movements = (before: GameStateResponse, after: GameStateResponse) => {
  const was = accounts(before);
  const now = accounts(after);
  return Object.fromEntries(Object.keys(now).filter((key) => now[key] !== was[key]).map((key) => [key, now[key] - was[key]]));
};

describe("§17 conservation: each transfer family moves exactly its accounts, by exactly the price, and the total is invariant", () => {
  it("corporation treasury -> player (the private purchase)", () => {
    const seed = operatingBoard();
    const { accepted } = S.privateOfferStages(seed, DH, 100, P2);
    const settled = apply(accepted, M.buyPrivate(PRR, DH, "100"), P2);
    expect(movements(seed, settled)).toEqual({ "cash:p2": 100, "treasury:PRR": -100 });
    expect(moneyTotal(settled)).toBe(moneyTotal(seed));
  });

  it("corporation treasury -> corporation treasury (the train sale)", () => {
    const seed = operatingBoard();
    const { accepted } = S.trainOfferStages(seed, NYC, "3", "150", P2);
    const settled = apply(accepted, M.buyTrain(PRR, NYC, "3", "150"), P2);
    expect(movements(seed, settled)).toEqual({ "treasury:NYC": 150, "treasury:PRR": -150 });
    expect(moneyTotal(settled)).toBe(moneyTotal(seed));
  });

  it("president -> treasury -> treasury (the D-6 funded train sale): the contribution once, the price once", () => {
    const seed = fundingBoard(200);
    const offered = apply(seed, M.proposeTrain(PRR, CO, "3", "150", null), P1, CORRIDOR);
    const accepted = apply(offered, M.answerTrain(PRR, true), P3, CORRIDOR);
    const settled = apply(accepted, M.buyTrain(CO, PRR, "3", "150"), P3, CORRIDOR);
    expect(movements(seed, settled)).toEqual({ "cash:p1": -120, "treasury:C&O": -30, "treasury:PRR": 150 });
    expect(moneyTotal(settled)).toBe(moneyTotal(seed));
  });

  it("player -> player (the trade), $0 included", () => {
    for (const price of [0, 1, 50, 300]) {
      const seed = withCash(stockRoundBoard(), P1, 300);
      const settled = apply(apply(seed, M.proposeTrade(DH, P2, P1, price), P1), M.answerTrade(DH, true), P2);
      expect(movements(seed, settled)).toEqual(price === 0 ? {} : { "cash:p1": -price, "cash:p2": price });
      expect(moneyTotal(settled)).toBe(moneyTotal(seed));
      expect(priv(settled, DH).owner).toBe(P1);
    }
  });
});

describe("§17 atomicity: no refusal partially alters money, ownership, fleets, Stock Round markers, the step, the seat or the round", () => {
  const or = () => operatingBoard();
  const sr = () => withState(stockRoundBoard(), { consecutive_passes: 2, last_trader_index: 2 });
  const offeredPrivate = () => apply(or(), M.proposePrivate(DH, PRR, 100), P1);
  const offeredTrain = () => apply(or(), M.proposeTrain(NYC, PRR, "3", "150"), P1);
  const offeredTrade = () => apply(sr(), M.proposeTrade(DH, P2, P1, 50), P1);

  const REFUSALS: Array<[string, () => GameStateResponse, string, unknown]> = [
    // proposals
    ["private proposal outside the band", or, P1, M.proposePrivate(DH, PRR, 141)],
    ["private proposal by a non-president", or, P2, M.proposePrivate(DH, PRR, 100)],
    ["train proposal at Track", () => operatingBoard({ step: "Track" }), P1, M.proposeTrain(NYC, PRR, "3", "150")],
    ["train proposal beyond the treasury", () => withCorp(or(), PRR, { treasury: "149" }), P1, M.proposeTrain(NYC, PRR, "3", "150")],
    ["trade proposal off-turn", sr, P2, M.proposeTrade(DH, P2, P1, 50)],
    ["trade proposal beyond the buyer's cash", () => withCash(sr(), P1, 49), P1, M.proposeTrade(DH, P2, P1, 50)],
    ["trade proposal in the first Stock Round", () => stockRoundBoard({ macro: 1 }), P1, M.proposeTrade(DH, P2, P1, 50)],
    // answers
    ["private answered by the proposer", offeredPrivate, P1, M.answerPrivate(DH, true)],
    ["private accepted on a drained treasury", () => withCorp(offeredPrivate(), PRR, { treasury: "10" }), P2, M.answerPrivate(DH, true)],
    ["train answered by a third player", offeredTrain, P3, M.answerTrain(NYC, true)],
    ["train accepted after the seller lost it", () => withCorp(offeredTrain(), NYC, { owned_trains: ["2"] }), P2, M.answerTrain(NYC, true)],
    ["trade answered by a third player", offeredTrade, P3, M.answerTrade(DH, true)],
    ["trade accepted after the card closed", () => withPriv(offeredTrade(), DH, { closed: true }), P2, M.answerTrade(DH, true)],
    ["trade accepted after the buyer's cash went", () => withCash(offeredTrade(), P1, 10), P2, M.answerTrade(DH, true)],
    // rescissions
    ["private rescinded by the owner", offeredPrivate, P2, M.rescindPrivate(DH)],
    ["train rescinded by the seller", offeredTrain, P2, M.rescindTrain(NYC)],
    ["trade rescinded by the counterparty", offeredTrade, P2, M.rescindTrade(DH)],
    ["a rescission with nothing standing", or, P1, M.rescindTrain(NYC)],
    // direct settlements
    ["direct private purchase without consent", or, P1, M.buyPrivate(PRR, DH, "100")],
    ["direct train purchase without consent", or, P1, M.buyTrain(PRR, NYC, "3", "150")],
    ["direct train purchase for $0 by one president", () => withCorp(or(), NYC, { president: P1 }), P1, M.buyTrain(PRR, NYC, "3", "0")],
    // held progression
    ["End Turn under a private offer", offeredPrivate, P1, M.pass],
    ["a step advance under a train offer", offeredTrain, P1, M.advance(PRR)],
    ["a stock purchase under a trade", offeredTrade, P1, M.buyStock(NYC)],
    ["End Turn under a trade", offeredTrade, P1, M.pass],
  ];
  for (const [label, make, actor, msg] of REFUSALS) {
    it(label, () => {
      const board = make();
      // A genuine refusal at the server's lock (its exact sentence is pinned in the family's own matrix), not a
      // silent no-op that merely happens to leave the digest alone.
      const refusal = ingress(board, actor, msg);
      expect([label, typeof refusal === "string" && refusal.length > 0]).toEqual([label, true]);
      const after = apply(board, msg, actor);
      expect(stateDigest(after)).toBe(stateDigest(board));
      expect(differing(board, after)).toEqual([]);
      expect(guarded(after)).toEqual(guarded(board));
    });
  }

  it("the stale accepted settlement is the one documented mutation: the offer field alone, no other field normalized", () => {
    const privateStale = withPriv(S.privateOfferStages(or(), DH, 100, P2).accepted, DH, { closed: true });
    expect(differing(privateStale, apply(privateStale, M.buyPrivate(PRR, DH, "100"), P2))).toEqual(["private_purchase_offer"]);
    const trainStale = withCorp(S.trainOfferStages(or(), NYC, "3", "150", P2).accepted, PRR, { treasury: "1" });
    expect(differing(trainStale, apply(trainStale, M.buyTrain(PRR, NYC, "3", "150"), P2))).toEqual(["train_purchase_offer"]);
  });
});

