/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W1-H -- REFUSALS CARRY THEIR REASON (AUD-14.03 / U-30, AUD-14.04 / U-29, AUD-14.05 / ING-2 + I-6)
// ==================================================================
//
// The acceptance: for every covered arm, the REFUSED line (`refusalReasonFor`, which the shell's receipt and the
// server's refusal transport both ask) equals the authority's own sentence -- the predicate the reducer asked, on the
// same board -- and, wherever ingress (`turnRefusal`) asks the same predicate, ingress's sentence too. Every case is
// driven through the real reducer first (the refusal is real: the board comes back unchanged), then the sentence is
// compared with a direct call into the module that owns the rule. Nothing here restates a rule.

export {};

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type SandboxLogMsg = import("../gameEngine/gameSetup").SandboxLogMsg;

const { refusalReasonFor, refusedActionLineWithReason } = require("./refusedAction") as typeof import("./refusedAction");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { atomsUnchanged } = require("../gameEngine/actionOutcome") as typeof import("../gameEngine/actionOutcome");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { stockPurchaseRefusal, stockSaleRefusal, chartContextFromState, purchaseIntentOf } =
  require("../gameEngine/stockTransactionAuthority") as typeof import("../gameEngine/stockTransactionAuthority");
const { sharePurchaseBlock } = require("../gameEngine/sharePurchase") as typeof import("../gameEngine/sharePurchase");
const { pendingOfferBlock } = require("../gameEngine/pendingOfferHold") as typeof import("../gameEngine/pendingOfferHold");
const { homeStationHold, boardHomeHexToAxial } =
  require("../gameEngine/homeStationAuthority") as typeof import("../gameEngine/homeStationAuthority");
const { trainObligationRefusal } = require("../gameEngine/trainAvailability") as typeof import("../gameEngine/trainAvailability");
const { HARMLESS_DUPLICATE_ANSWER_SENTENCE } =
  require("../gameEngine/harmlessDuplicate") as typeof import("../gameEngine/harmlessDuplicate");
const { proposePrivateTradeRefusal, rescindPrivateTradeRefusal, answerPrivateTradeRefusal } =
  require("../gameEngine/privateTradeAuthority") as typeof import("../gameEngine/privateTradeAuthority");
const { rescindPrivatePurchaseRefusal, proposePrivatePurchaseRefusal } =
  require("../gameEngine/privatePurchaseAuthority") as typeof import("../gameEngine/privatePurchaseAuthority");
const { rescindTrainPurchaseRefusal } = require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const { marketZoneForPrice } = require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

const { P1, P2, P3, PRR, NYC, CO, DH, MH, operatingBoard, stockRoundBoard } = F;
const { apply, applyAsRoom, ingress, same, withCorp, withState, M, GRID } = S;

const msg = (value: unknown) => value as SandboxLogMsg;

const { RoomSession } = require("./roomSession") as typeof import("./roomSession");

/** A room seeded with THIS board's chart, so the engine's first pass moves nothing of its own (stage102 §A1: a
 *  seed chart that differs from the board's is reconciled on the first submit, which is a real change and would
 *  mask the refusal). */
function chartedRoom(board: GameStateResponse, mapGrid = GRID) {
  const room = new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: mapGrid, initialMarket: board.market_positions as never },
    seed: { state: board, waterfall: null },
    build: "b",
    mintId: () => "w1h",
  });
  const submit = (actor: string, message: unknown) =>
    room.submit({ actor, build: "b", host: P1, msg: message as SandboxLogMsg, baseIndex: room.nextIndex - 1 });
  return { room, submit };
}

/** The reducer refused: the board's atoms did not move. */
function expectRefused(state: GameStateResponse, message: unknown, actor: string | null, ctxGrid = GRID) {
  const after = applyAsRoom(state, message, actor as string, ctxGrid);
  expect(atomsUnchanged({ state }, { state: after })).toBe(true);
}

/** The zone injections a room's engine judges with -- the same the shell passes from its chart ref. */
const zones = (state: GameStateResponse) => {
  const chart = sandboxReplayProviders().chartInjections(state);
  return { marketZoneFor: chart.marketZoneFor, marketPricesByCompany: chart.marketPricesByCompany, zoneForPrice: chart.zoneForPrice };
};

/* ================================================================================================= */

describe("W1-H · the stock transaction carries the reducer's sentence (U-30, I-6)", () => {
  it("a purchase over the 60% cap: the cap's own sentence, equal to ingress's", () => {
    const board = withCorp(stockRoundBoard(), PRR, { player_holdings: [{ player: P1, percentage: 60 }], ipo_pool_percentage: 40 });
    const buy = M.buyStock(PRR);
    expectRefused(board, buy, P1);
    const reason = refusalReasonFor(board, msg(buy), { actor: P1, ...zones(board) });
    expect(reason).toMatch(/60%/);
    expect(reason).toBe(ingress(board, P1, buy));
    expect(reason).toBe(
      stockPurchaseRefusal({ state: board, buy: purchaseIntentOf((buy as { BuyStock: never }).BuyStock), actor: P1, ctx: chartContextFromState(board) }),
    );
  });

  it("a purchase outside a Stock Round names the round -- the arm used to ask only the inner block, which has no round rule", () => {
    const board = operatingBoard();
    const buy = M.buyStock(NYC);
    expectRefused(board, buy, P1);
    const reason = refusalReasonFor(board, msg(buy), { actor: P1, ...zones(board) });
    expect(reason).toBe("Shares can only be bought during a Stock Round.");
    // The old arm's answer was the inner block's, which knows nothing about the round.
    expect(
      sharePurchaseBlock({ state: board, buyer: P1, companyId: NYC, source: "Ipo", quantity: 1, zone: zones(board).marketZoneFor!(NYC) }),
    ).not.toBe(reason);
  });

  it("a purchase the buyer cannot pay for names the price, even with no zone injection (the server path before W1-H)", () => {
    const board = withState(withCorp(stockRoundBoard(), NYC, { ipo_pool_percentage: 40 }), {
      player_cash: [{ player: P1, cash_vgp: "10" }, { player: P2, cash_vgp: "300" }, { player: P3, cash_vgp: "300" }],
    });
    const buy = M.buyStock(NYC);
    expectRefused(board, buy, P1);
    const reason = refusalReasonFor(board, msg(buy), { actor: P1 });
    expect(reason).toMatch(/costs \$90 and you hold \$10/);
    expect(reason).toBe(ingress(board, P1, buy));
  });

  it("a sale in the first Stock Round: the §5.1 sentence, equal to ingress's", () => {
    const board = stockRoundBoard({ macro: 1 });
    const sell = M.sellStock(PRR, 10);
    expectRefused(board, sell, P1);
    const reason = refusalReasonFor(board, msg(sell), { actor: P1, ...zones(board) });
    expect(reason).toBe("Certificates may not be sold in the first Stock Round.");
    expect(reason).toBe(ingress(board, P1, sell));
    expect(reason).toBe(stockSaleRefusal({ state: board, sell: { companyId: PRR, percentage: 10 }, actor: P1, ctx: chartContextFromState(board) }));
  });
});

describe("W1-H · the holds the arm did not ask (U-29)", () => {
  it("a standing ordinary offer holds every other move, with the hold's sentence", () => {
    const offered = apply(operatingBoard(), M.proposePrivate(DH, PRR, 70), P1);
    expect(offered.private_purchase_offer).toBeTruthy();
    const depot = M.depot(PRR);
    expectRefused(offered, depot, P1);
    const reason = refusalReasonFor(offered, msg(depot), { actor: P1, mapGrid: GRID });
    expect(reason).not.toBeNull();
    expect(reason).toBe(pendingOfferBlock(offered, msg(depot)));
    expect(reason).toBe(ingress(offered, P1, depot));
  });

  it("the operating corporation's home station holds the turn, with the hold's sentence", () => {
    const owing = withCorp(operatingBoard({ operating: CO }), CO, { home_hex_label: "F6", station_token_hexes: [], station_tokens: [] });
    const held = homeStationHold(owing, msg(M.depot(CO)), boardHomeHexToAxial);
    expect(held).not.toBeNull(); // the fixture owes the home station
    expectRefused(owing, M.depot(CO), P3);
    const reason = refusalReasonFor(owing, msg(M.depot(CO)), { actor: P3, mapGrid: GRID });
    expect(reason).toBe(held);
    expect(reason).toBe(ingress(owing, P3, M.depot(CO)));
  });
});

describe("W1-H · the offers' proposals, answers and withdrawals (U-29)", () => {
  it("a player-to-player trade proposed outside a Stock Round", () => {
    const board = operatingBoard();
    const propose = M.proposeTrade(DH, P2, P1, 50);
    expectRefused(board, propose, P1);
    const reason = refusalReasonFor(board, msg(propose), { actor: P1 });
    expect(reason).not.toBeNull();
    expect(reason).toBe(proposePrivateTradeRefusal(board, (propose as { ProposePrivateTrade: never }).ProposePrivateTrade, P1));
    expect(reason).toBe(ingress(board, P1, propose));
  });

  it("each withdrawal with nothing to withdraw", () => {
    const sr = stockRoundBoard();
    const or = operatingBoard();
    for (const [board, message, actor, expected] of [
      [sr, M.rescindTrade(MH), P1, rescindPrivateTradeRefusal(sr, { private_id: MH }, P1)],
      [or, M.rescindPrivate(DH), P1, rescindPrivatePurchaseRefusal(or, { private_id: DH }, P1)],
      [or, M.rescindTrain(NYC), P1, rescindTrainPurchaseRefusal(or, { seller_protocol_id: NYC }, P1)],
    ] as const) {
      expectRefused(board, message, actor);
      expect(expected).not.toBeNull();
      expect(refusalReasonFor(board, msg(message), { actor })).toBe(expected);
      expect(refusalReasonFor(board, msg(message), { actor })).toBe(ingress(board, actor, message));
    }
  });

  it("a second proposal while one stands (the hold lets proposals of the same offer through only by its own rule)", () => {
    const offered = apply(operatingBoard(), M.proposePrivate(DH, PRR, 70), P1);
    const second = M.proposePrivate(F.CA, PRR, 160);
    expectRefused(offered, second, P1);
    const reason = refusalReasonFor(offered, msg(second), { actor: P1 });
    expect(reason).toBe(pendingOfferBlock(offered, msg(second)) ?? proposePrivatePurchaseRefusal(offered, (second as { ProposePrivatePurchase: never }).ProposePrivatePurchase, P1));
    expect(reason).toBe(ingress(offered, P1, second));
  });

  it("an answer by the wrong party is the trade authority's sentence; an answer with nothing to answer is the server's no-blame sentence (I-6)", () => {
    const proposed = apply(stockRoundBoard(), M.proposeTrade(DH, P2, P1, 50), P1);
    expect(proposed.private_trade_offer).toBeTruthy();
    const wrong = M.answerTrade(DH, true);
    expectRefused(proposed, wrong, P3);
    expect(refusalReasonFor(proposed, msg(wrong), { actor: P3 })).toBe(answerPrivateTradeRefusal(proposed, { private_id: DH, accept: true }, P3));
    expect(refusalReasonFor(proposed, msg(wrong), { actor: P3 })).not.toBeNull();
    // Nothing standing: the sentence the server's transport answers with (C2-02), never the old client-only one.
    expect(refusalReasonFor(operatingBoard(), msg(M.answerPrivate(DH, true)), { actor: P2 })).toBe(HARMLESS_DUPLICATE_ANSWER_SENTENCE);
    expect(refusalReasonFor(operatingBoard(), msg(M.answerTrain(NYC, true)), { actor: P2 })).toBe(HARMLESS_DUPLICATE_ANSWER_SENTENCE);
  });
});

describe("W1-H · the Pass a train purchase still owes (ING-2)", () => {
  const CORRIDOR = S.corridor();
  /* C&O operating at Buy Trains with no train, a legal route and $500 -- the obligation the treasury can pay, so
     it is the ordinary purchase rule (#1513), not the forced-purchase hold. */
  const owed = () => S.fundingBoard(300, { coTreasury: "500" });

  it("the REFUSED line carries the obligation's sentence", () => {
    const board = owed();
    expectRefused(board, M.pass, P1, CORRIDOR);
    const expected = trainObligationRefusal(board, msg(M.pass), CORRIDOR);
    expect(expected).toMatch(/must acquire one before its turn ends/);
    expect(refusalReasonFor(board, msg(M.pass), { actor: P1, mapGrid: CORRIDOR })).toBe(expected);
    expect(refusalReasonFor(board, msg(M.advance(CO)), { actor: P1, mapGrid: CORRIDOR })).toBe(
      trainObligationRefusal(board, msg(M.advance(CO)), CORRIDOR),
    );
  });

  it("the server's `refused` frame carries it too: ingress lets the Pass through, the reducer declines it", () => {
    const board = owed();
    expect(ingress(board, P1, M.pass, CORRIDOR)).toBeNull(); // the precondition ING-2 describes
    const room = chartedRoom(board, CORRIDOR);
    const log = room.room.entries.length;
    const seeded = room.room.state;
    const answer = room.submit(P1, M.pass);
    expect(answer.kind).toBe("refused");
    expect((answer as { reason: string }).reason).toBe(trainObligationRefusal(board, msg(M.pass), CORRIDOR));
    expect((answer as { reason: string }).reason).not.toMatch(/declined by the rules/);
    expect(room.room.entries).toHaveLength(log);
    expect(same(room.room.state, seeded)).toBe(true);
  });
});

describe("W1-H · the server path passes the reducer's zone injections (AUD-14.03)", () => {
  it("a BuyStock the reducer refuses for a zone rule is answered with that rule, not the generic sentence", () => {
    const board = withCorp(stockRoundBoard(), PRR, { player_holdings: [{ player: P1, percentage: 60 }], ipo_pool_percentage: 40 });
    const buy = M.buyStock(PRR);
    const capSentence = ingress(board, P1, buy);
    expect(capSentence).toMatch(/60%/);
    /* Ingress answers this one itself. To reach the transport's own describer -- the path a reducer refusal that
       ingress does not mirror takes -- ingress is told to let BuyStock through (one spy, as stage102 §A9/§D5 do). */
    const authority = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
    const realTurn = authority.turnRefusal;
    const spy = jest.spyOn(authority, "turnRefusal").mockImplementation((input) => ("BuyStock" in input.msg ? null : realTurn(input)));
    try {
      const room = chartedRoom(board);
      const log = room.room.entries.length;
      const answer = room.submit(P1, buy);
      expect(answer.kind).toBe("refused");
      expect((answer as { reason: string }).reason).toBe(capSentence);
      expect(room.room.entries).toHaveLength(log);
      // Without the injections the describer cannot see the zone rules: the cap is exactly what it would miss.
      expect(refusalReasonFor(board, msg(buy), { actor: P1, mapGrid: GRID })).not.toBe(capSentence);
    } finally {
      spy.mockRestore();
    }
  });

  it("the zone injection is the board's own chart", () => {
    const board = stockRoundBoard();
    const injected = zones(board);
    expect(injected.marketZoneFor!(NYC)).toBe(marketZoneForPrice(90));
  });
});

describe("W1-H · the Activity Log never prints a bare REFUSED for a covered arm", () => {
  it("every covered refusal yields a sentence, so the line carries it", () => {
    const sr = stockRoundBoard();
    const or = operatingBoard();
    const offered = apply(or, M.proposePrivate(DH, PRR, 70), P1);
    const cases: Array<[GameStateResponse, unknown, string]> = [
      [or, M.buyStock(NYC), P1],
      [stockRoundBoard({ macro: 1 }), M.sellStock(PRR, 10), P1],
      [offered, M.depot(PRR), P1],
      [or, M.proposeTrade(DH, P2, P1, 50), P1],
      [sr, M.rescindTrade(MH), P1],
      [or, M.rescindPrivate(DH), P1],
      [or, M.rescindTrain(NYC), P1],
    ];
    for (const [board, message, actor] of cases) {
      const reason = refusalReasonFor(board, msg(message), { actor, mapGrid: GRID, ...zones(board) });
      expect(reason).not.toBeNull();
      expect(refusedActionLineWithReason("label.", reason)).not.toMatch(/a rule declined this action/);
    }
  });
});

void applySandboxAction;
