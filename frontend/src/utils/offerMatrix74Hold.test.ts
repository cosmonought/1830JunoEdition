/** @jest-environment node */
//
// ==================================================================
//  BATCH 7.4 EXHAUSTIVE MATRIX (5/6): THE GLOBAL PENDING-OFFER HOLD, AND WHY THE OTHER HOLDS NEVER MEET IT
// ==================================================================
//
// §8: for each ordinary offer kind, unanswered and (where the representation exists) accepted-awaiting-settlement,
// the pass list is pinned EXACTLY -- the matching answer (unanswered only), the matching rescission, the exact
// matching settlement (accepted only), `RevertTo`, `CloseRoom` -- and a broad set of unrelated messages is refused
// at both locks with nothing moved; a rejection and a rescission release the hold at once.
//
// §9 (R74-C): no exemption is added for boards on which the discard / home-token / funding / game-end holds sit
// beside an ordinary offer, because a legal game cannot build one. Proved from both directions: (A) while each
// earlier hold stands no ordinary offer can be created (both locks, and through legal room sequences that raise
// and then clear the hold); (B) the only messages that pass an ordinary offer's hold cannot raise another hold while
// the offer still stands, and every message that could raise one is itself held.

export {};

const { pendingOfferBlock, standingOrdinaryOffer } = require("../gameEngine/pendingOfferHold") as typeof import("../gameEngine/pendingOfferHold");
const { pendingDiscardBlock, pendingTrainDiscards } = require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { emergencyFundingBlock, emergencyFundingFor } = require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { homeTokenBlock } = require("../gameEngine/homeTokenGate") as typeof import("../gameEngine/homeTokenGate");
const { pendingHomeTokens } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const { P1, P2, P3, PRR, NYC, CO, DH, CA, MH, board, operatingBoard, stockRoundBoard } = F;
const { apply, applyAsRoom, ingress, same, differing, withCorp, withState, guarded, trains, M, GRID, corridor, fundingBoard } = S;

const homeHexToAxial = (state: GameStateResponse) => sandboxReplayProviders().chartInjections(state).homeHexToAxial!;

/* ================================================================== */
/* §8 the pass list, exactly                                            */
/* ================================================================== */

const orBoard = () =>
  operatingBoard({
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: CA, owner: P3, cost: "160" },
      { id: MH, owner: P1, cost: "110" },
    ],
  });
const srBoard = () =>
  stockRoundBoard({
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]], ipo: 50 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, holdings: [[P2, 30], [P3, 10], [P1, 10]], ipo: 50 },
    ],
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: MH, owner: P1, cost: "110" },
      { id: CA, owner: P3, cost: "160" },
    ],
  });

interface HoldBoard {
  label: string;
  board: () => GameStateResponse;
  /** The messages that must pass the hold, by label. */
  passes: string[];
  /** The actor who holds the seat (for the unrelated messages). */
  seat: string;
}

const HOLD_BOARDS: HoldBoard[] = [
  { label: "private purchase, unanswered", board: () => apply(orBoard(), M.proposePrivate(DH, PRR, 100), P1), passes: ["answer the private offer", "rescind the private offer"], seat: P1 },
  { label: "private purchase, accepted", board: () => S.privateOfferStages(orBoard(), DH, 100, P2).accepted, passes: ["rescind the private offer", "settle the private offer"], seat: P1 },
  { label: "train purchase, unanswered", board: () => apply(orBoard(), M.proposeTrain(NYC, PRR, "3", "150"), P1), passes: ["answer the train offer", "rescind the train offer"], seat: P1 },
  { label: "train purchase, accepted", board: () => S.trainOfferStages(orBoard(), NYC, "3", "150", P2).accepted, passes: ["rescind the train offer", "settle the train offer"], seat: P1 },
  { label: "player trade, unanswered (it has no accepted state: the answer settles it)", board: () => apply(srBoard(), M.proposeTrade(DH, P2, P1, 50), P1), passes: ["answer the trade", "rescind the trade"], seat: P1 },
];

const EVERY_MESSAGE: Array<[string, unknown]> = [
  // the offers' own family, matching
  ["answer the private offer", M.answerPrivate(DH, true)],
  ["rescind the private offer", M.rescindPrivate(DH)],
  ["settle the private offer", M.buyPrivate(PRR, DH, "100")],
  ["answer the train offer", M.answerTrain(NYC, true)],
  ["rescind the train offer", M.rescindTrain(NYC)],
  ["settle the train offer", M.buyTrain(PRR, NYC, "3", "150")],
  ["answer the trade", M.answerTrade(DH, true)],
  ["rescind the trade", M.rescindTrade(DH)],
  // the family, NOT matching
  ["answer a different private", M.answerPrivate(CA, true)],
  ["rescind a different private", M.rescindPrivate(CA)],
  ["settle a different private", M.buyPrivate(PRR, CA, "160")],
  ["settle the private at another price", M.buyPrivate(PRR, DH, "101")],
  ["answer a different seller", M.answerTrain(CO, true)],
  ["rescind a different seller", M.rescindTrain(CO)],
  ["settle a different model", M.buyTrain(PRR, NYC, "2", "150")],
  ["settle the train at another price", M.buyTrain(PRR, NYC, "3", "151")],
  ["answer a different trade", M.answerTrade(MH, true)],
  ["rescind a different trade", M.rescindTrade(MH)],
  // a second offer of every kind
  ["a second private offer", M.proposePrivate(CA, PRR, 160)],
  ["a second train offer", M.proposeTrain(CO, PRR, "3", "100")],
  ["a player trade", M.proposeTrade(CA, P3, P1, 50)],
  ["a funding offer", M.fundingOffer(MH, NYC, 60)],
  ["the chain-era AcceptTrainOffer", { AcceptTrainOffer: { game_id: 1, offer_id: 1 } }],
  // progression and every ordinary mutation
  ["PassTurn / End Turn", M.pass],
  ["AdvanceOperatingSubPhase", M.advance(PRR)],
  ["BuyStock", M.buyStock(NYC)],
  ["SellStock", M.sellStock(NYC, 10)],
  ["LayTile", M.layTile(PRR)],
  ["PlaceStationToken", M.token(PRR)],
  ["RunMultipleRoutes", M.run(PRR)],
  ["DeclareDividends", M.dividend(PRR)],
  ["BuyHardwareFromPool", M.depot(PRR)],
  ["EmergencyBuyHardware", M.emergency(PRR)],
  ["DeclareBankruptcy", M.declare],
  ["BuyPrivateCompany of the buyer's own private", M.buyPrivate(PRR, MH, "110")],
  ["BuyTrainFromCorporation from another seller", M.buyTrain(PRR, CO, "3", "100")],
  ["ExchangePrivate", { ExchangePrivate: { game_id: 1, private_id: MH, company_id: NYC, player: P1, source: "Ipo" } }],
  ["DiscardTrain", M.discard(PRR, "2")],
  ["PlaceHomeStation", { PlaceHomeStation: { game_id: 1, company_id: PRR, q: 0, r: 0, kind: "home" } }],
  ["BuyKanawhaLicense", { BuyKanawhaLicense: { game_id: 1, protocol_id: PRR } }],
  ["ExchangeTrainForDiesel", { ExchangeTrainForDiesel: { game_id: 1, protocol_id: PRR, model_type: "2" } }],
  ["YellowSignEvent", { YellowSignEvent: { game_id: 1, protocol_id: PRR, stage: "mark", model: "2" } }],
  ["OpenStockRound", { OpenStockRound: {} }],
  ["SetBoPar", { SetBoPar: { player: P1, par_value: "100" } }],
  ["UndoLastAction", { UndoLastAction: { game_id: 1 } }],
  ["WaterfallPass", { WaterfallPass: { game_id: 1 } }],
  // the room's own
  ["RevertTo", M.revert(0)],
  ["CloseRoom", M.closeRoom],
];

describe("§8 the hold's pass list is exact, for every offer kind and state", () => {
  for (const hold of HOLD_BOARDS) {
    it(`${hold.label}: exactly its own answer/rescission/settlement, RevertTo and CloseRoom pass`, () => {
      const board = hold.board();
      expect(standingOrdinaryOffer(board)).not.toBeNull();
      const passing = EVERY_MESSAGE.filter(([, msg]) => pendingOfferBlock(board, msg as never) === null).map(([label]) => label);
      expect(passing.sort()).toEqual([...hold.passes, "RevertTo", "CloseRoom"].sort());
    });

    it(`${hold.label}: every held message is refused at ingress with the hold's sentence and moves nothing in the reducer`, () => {
      const board = hold.board();
      const accepted = standingOrdinaryOffer(board)!.accepted;
      const sentence = accepted ? "nothing else can happen until it settles." : "nothing else can happen until it is answered or withdrawn.";
      for (const [label, msg] of EVERY_MESSAGE) {
        if (pendingOfferBlock(board, msg as never) === null) continue;
        const refusal = ingress(board, hold.seat, msg);
        expect([label, refusal === null]).toEqual([label, false]);
        // The hold is asked after the discard and funding holds and after Q11: those three families answer with
        // their own sentence first; every other held message answers with the hold's.
        const earlierFamily = ["a funding offer", "EmergencyBuyHardware", "DeclareBankruptcy", "the chain-era AcceptTrainOffer"].includes(label);
        if (!earlierFamily) expect([label, refusal]).toEqual([label, pendingOfferBlock(board, msg as never)]);
        expect([label, refusal!.length > 0]).toEqual([label, true]);
        if (!earlierFamily) expect([label, refusal!.endsWith(sentence)]).toEqual([label, true]);
        const after = apply(board, msg, hold.seat);
        expect([label, same(after, board)]).toEqual([label, true]);
      }
    });
  }

  it("the answer passes only while unanswered; the settlement passes only once accepted", () => {
    const offered = apply(orBoard(), M.proposePrivate(DH, PRR, 100), P1);
    const accepted = apply(offered, M.answerPrivate(DH, true), P2);
    expect(pendingOfferBlock(offered, M.answerPrivate(DH, false) as never)).toBeNull();
    expect(pendingOfferBlock(accepted, M.answerPrivate(DH, false) as never)).toContain("accepted and awaiting settlement");
    expect(ingress(accepted, P2, M.answerPrivate(DH, false))).toContain("accepted and awaiting settlement");
    expect(same(apply(accepted, M.answerPrivate(DH, false), P2), accepted)).toBe(true);
    expect(pendingOfferBlock(offered, M.buyPrivate(PRR, DH, "100") as never)).toContain("waiting for its owner's answer");
    const offeredTrain = apply(orBoard(), M.proposeTrain(NYC, PRR, "3", "150"), P1);
    const acceptedTrain = apply(offeredTrain, M.answerTrain(NYC, true), P2);
    expect(pendingOfferBlock(acceptedTrain, M.answerTrain(NYC, false) as never)).toContain("accepted and awaiting settlement");
    expect(same(apply(acceptedTrain, M.answerTrain(NYC, false), P2), acceptedTrain)).toBe(true);
    expect(pendingOfferBlock(offeredTrain, M.buyTrain(PRR, NYC, "3", "150") as never)).toContain("waiting for the selling president's answer");
  });

  it("a rejection and a rescission release the hold at once, for each kind, at both locks and through a room", () => {
    const cases: Array<{ label: string; field: string; seed: () => GameStateResponse; propose: unknown; proposer: string; releases: Array<[string, unknown, string]>; after: unknown; afterActor: string }> = [
      { label: "private", field: "private_purchase_offer", seed: orBoard, propose: M.proposePrivate(DH, PRR, 100), proposer: P1, releases: [["rejection", M.answerPrivate(DH, false), P2], ["rescission", M.rescindPrivate(DH), P1]], after: M.pass, afterActor: P1 },
      { label: "train", field: "train_purchase_offer", seed: orBoard, propose: M.proposeTrain(NYC, PRR, "3", "150"), proposer: P1, releases: [["rejection", M.answerTrain(NYC, false), P2], ["rescission", M.rescindTrain(NYC), P1]], after: M.depot(PRR), afterActor: P1 },
      { label: "trade", field: "private_trade_offer", seed: srBoard, propose: M.proposeTrade(DH, P2, P1, 50), proposer: P1, releases: [["rejection", M.answerTrade(DH, false), P2], ["rescission", M.rescindTrade(DH), P1]], after: M.buyStock(NYC), afterActor: P1 },
    ];
    for (const { label, field, seed, propose, proposer, releases, after, afterActor } of cases) {
      for (const [how, release, releaser] of releases) {
        const offered = apply(seed(), propose, proposer);
        expect([label, how, ingress(offered, afterActor, after) === null]).toEqual([label, how, false]);
        const released = apply(offered, release, releaser);
        // #1597: `offer_serial` records that an offer was made and survives its release; only the offer field itself is cleared.
        expect([label, how, differing(seed(), released)]).toEqual([label, how, ["offer_serial", field]]);
        expect([label, how, differing(offered, released)]).toEqual([label, how, [field]]);
        expect([label, how, (released as unknown as Record<string, unknown>)[field]]).toEqual([label, how, null]);
        expect([label, how, pendingOfferBlock(released, after as never)]).toEqual([label, how, null]);
        expect([label, how, ingress(released, afterActor, after)]).toEqual([label, how, null]);
        expect([label, how, same(apply(released, after, afterActor), released)]).toEqual([label, how, false]);
        // and through a room
        const { submit } = S.roomFor(seed());
        expect([label, how, submit(proposer, propose).kind]).toEqual([label, how, "applied"]);
        expect([label, how, submit(afterActor, after).kind]).toEqual([label, how, "refused"]);
        expect([label, how, submit(releaser, release).kind]).toEqual([label, how, "applied"]);
        expect([label, how, submit(afterActor, after).kind]).toEqual([label, how, "applied"]);
      }
    }
  });
});

/* ================================================================== */
/* §9 R74-C (A): no ordinary offer can be created under an earlier hold  */
/* ================================================================== */

const PROPOSALS = (state: GameStateResponse): Array<[string, unknown, string]> => {
  const inStockRound = state.current_round_type === "StockRound";
  const seat = inStockRound ? state.player_addresses[state.active_player_index] : P1;
  return [
    ["a private purchase offer", M.proposePrivate(DH, PRR, 100), P1],
    ["a train purchase offer", M.proposeTrain(NYC, PRR, "3", "150"), P1],
    ["a player trade", seat === P2 ? M.proposeTrade(DH, P2, P1, 50) : M.proposeTrade(DH, P2, P1, 50), seat],
  ];
};

describe("§9 R74-C (A): while an earlier mandatory hold stands, no ordinary offer is created", () => {
  it("the excess-train discard hold: every proposal refused at both locks with the discard's sentence", () => {
    for (const held of [
      withCorp(withCorp(operatingBoard(), CO, { owned_trains: ["4"] }), PRR, { owned_trains: ["3", "3", "3", "3"] }),
      withCorp(withCorp(stockRoundBoard(), NYC, { owned_trains: ["4"] }), PRR, { owned_trains: ["3", "3", "3", "3"] }),
    ]) {
      expect(pendingTrainDiscards(held)?.required.ticker).toBe("PRR");
      for (const [label, msg, actor] of PROPOSALS(held)) {
        const sentence = pendingDiscardBlock(held, msg as never);
        expect([label, sentence]).toEqual([label, "PRR holds 1 train more than the limit of 3; PRR's president must discard before anything else happens."]);
        expect([label, ingress(held, actor, msg)]).toEqual([label, sentence]);
        const after = applyAsRoom(held, msg, actor);
        expect([label, same(after, held)]).toEqual([label, true]);
        expect([label, standingOrdinaryOffer(after)]).toEqual([label, null]);
      }
    }
  });

  /* Slice 8.2 (#1610 / #1612, S8-5 / S8-12) re-pinned this case. The home-token hold used to stand from the float, in any
     round, for any floated corporation without a token, and only in the reducer ("ingress has no home-token hold for
     ANY message -- pre-existing"). It now stands only for the OPERATING corporation at the start of its first
     operating turn, and ingress asks the same predicate as its fourth hold -- so the Operating board puts PRR (the
     operating corporation) in that position and both locks refuse with the one sentence, while the Stock Round board
     with a token-less floated NYC holds nothing at all. */
  it("the home-station hold: every proposal refused at both locks with the hold's sentence; a token-less corporation in a Stock Round holds nothing", () => {
    const held = withCorp(operatingBoard(), PRR, { home_hex_label: "H12", station_token_hexes: [], station_tokens: [] });
    expect(pendingHomeTokens(held, homeHexToAxial(held)).map((owed) => owed.ticker)).toEqual(["PRR"]);
    for (const [label, msg, actor] of PROPOSALS(held)) {
      const sentence = homeTokenBlock({ state: held, homeHexToAxial: homeHexToAxial(held), msg });
      expect([label, sentence]).toEqual([label, expect.stringContaining("PRR is starting its first operating turn and its home station is not on the board yet.")]);
      expect([label, ingress(held, actor, msg)]).toEqual([label, sentence]);
      const after = applyAsRoom(held, msg, actor);
      expect([label, same(after, held)]).toEqual([label, true]);
      expect([label, standingOrdinaryOffer(after)]).toEqual([label, null]);
    }
    const stockRound = withCorp(stockRoundBoard(), NYC, { home_hex_label: "E19", station_token_hexes: [], station_tokens: [] });
    expect(pendingHomeTokens(stockRound, homeHexToAxial(stockRound))).toEqual([]);
    for (const [label, msg] of PROPOSALS(stockRound)) {
      expect([label, homeTokenBlock({ state: stockRound, homeHexToAxial: homeHexToAxial(stockRound), msg })]).toEqual([label, null]);
    }
  });

  it("the funding hold: the private offer and the trade are refused at both locks; the train offer is the designed D-6 intersection", () => {
    const held = fundingBoard(100, { privates: [{ id: DH, owner: P2, cost: "70" }] });
    expect(emergencyFundingFor(held, corridor())).not.toBeNull();
    const fundingSentence = "C&O must buy a 3-train ($180) and cannot pay for it; its president must fund the purchase before anything else happens.";
    for (const [label, msg, actor] of [
      ["a private purchase offer by the rescued corporation", M.proposePrivate(DH, CO, 70), P1],
      ["a private purchase offer by another corporation", M.proposePrivate(DH, NYC, 70), P2],
      ["a player trade", M.proposeTrade(DH, P2, P1, 10), P1],
    ] as Array<[string, unknown, string]>) {
      expect([label, emergencyFundingBlock(held, msg as never, corridor())]).toEqual([label, fundingSentence]);
      expect([label, ingress(held, actor, msg, corridor())]).toEqual([label, fundingSentence]);
      expect([label, same(apply(held, msg, actor, corridor()), held)]).toEqual([label, true]);
    }
    expect(emergencyFundingBlock(held, M.proposeTrain(PRR, CO, "3", "130", null) as never, corridor())).toBeNull();
  });

  it("a finished game and the auction round: every proposal refused at both locks", () => {
    const ended = withState(operatingBoard(), { current_round_type: "GameEnd" });
    for (const [label, msg, actor] of PROPOSALS(ended)) {
      expect([label, ingress(ended, actor, msg)]).toEqual([label, "The game has ended. Nothing further can be played."]);
      expect([label, same(apply(ended, msg, actor), ended)]).toEqual([label, true]);
    }
    const auction = withState(stockRoundBoard(), { current_round_type: "WaterfallAuction" });
    for (const [label, msg, actor] of PROPOSALS(auction)) {
      expect([label, ingress(auction, actor, msg) === null]).toEqual([label, false]);
      expect([label, same(apply(auction, msg, actor), auction)]).toEqual([label, true]);
    }
  });

  /* Slice 8.2 (#1610) re-pinned this sequence: a Stock Round float raises no hold, so the trade proposed right after it
     is created at once, and the float-time placement the old sequence needed is refused at ingress as untimely. */
  it("a legal room sequence: a Stock Round float raises no hold -- the trade proposed after it is created, and a placement there is refused at ingress", () => {
    const E19 = STATIC_BOARD_HEXES.find((hex) => hex.label === "E19")!;
    const seed = withCorp(
      board({
        round: "StockRound",
        seat: 1,
        corps: [
          { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 60]] },
          { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "0", holdings: [[P2, 50]], ipo: 50, floated: false, price: 90, parValue: "90" },
        ],
        privates: [{ id: DH, owner: P2, cost: "70" }],
        over: { variants: { rules: 1 } as never },
      }),
      NYC,
      { home_hex_label: "E19" },
    );
    const { room, submit } = S.roomFor(seed);
    expect(submit(P2, M.buyStock(NYC)).kind).toBe("applied");
    expect(room.state.public_companies.find((entry) => entry.company_id === NYC)?.is_floated).toBe(true);
    expect(pendingHomeTokens(room.state, homeHexToAxial(room.state))).toEqual([]);
    const before = room.state;
    const placement = submit(P2, { PlaceHomeStation: { game_id: 1, company_id: NYC, q: E19.q, r: E19.r, kind: "home" } });
    expect(placement.kind).toBe("refused");
    expect((placement as { reason?: string }).reason).toBe("NYC places its home station at the start of its first operating turn, and it is not operating now.");
    expect(guarded(room.state)).toEqual(guarded(before));
    expect(submit(P2, M.proposeTrade(DH, P2, P1, 50)).kind).toBe("applied");
    expect(room.state.private_trade_offer).toMatchObject({ private_id: DH, proposer: P2 });
  });

  it("a legal room sequence: a phase change raises the discard hold, proposals under it are refused, and the proposal works once the discard is made", () => {
    const seed = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "1000" },
        { id: NYC, ticker: "NYC", president: P2, trains: ["2", "2"], treasury: "400", price: 90 },
        { id: CO, ticker: "C&O", president: P3, trains: ["3", "3", "3", "3"], treasury: "300", price: 80 },
      ],
      privates: [{ id: DH, owner: P2, cost: "70" }],
    });
    const { room, submit } = S.roomFor(seed);
    expect(submit(P1, M.depot(PRR)).kind).toBe("applied"); // the first 4: phase 4, limit 3
    expect(pendingTrainDiscards(room.state)?.required.ticker).toBe("C&O");
    for (const msg of [M.proposeTrain(CO, PRR, "3", "100"), M.proposePrivate(DH, PRR, 70)]) {
      expect(submit(P1, msg).kind).toBe("refused");
    }
    expect(standingOrdinaryOffer(room.state)).toBeNull();
    expect(submit(P3, M.discard(CO, "3")).kind).toBe("applied");
    expect(pendingTrainDiscards(room.state)).toBeNull();
    expect(submit(P1, M.proposeTrain(CO, PRR, "3", "100")).kind).toBe("applied");
    expect(room.state.train_purchase_offer).toMatchObject({ seller_protocol_id: CO, buyer_protocol_id: PRR });
  });
});

/* ================================================================== */
/* §9 R74-C (B): an ordinary offer's pass list cannot raise another hold  */
/* ================================================================== */

describe("§9 R74-C (B): while an ordinary offer stands, nothing that passes its hold can raise an earlier hold", () => {
  /** No earlier hold stands on this board (the grid is the obligation's, so a funding obligation would show). */
  const noEarlierHold = (state: GameStateResponse, mapGrid = GRID) => ({
    discard: pendingTrainDiscards(state),
    home: pendingHomeTokens(state, homeHexToAxial(state)).map((owed) => owed.ticker),
    funding: emergencyFundingFor(state, mapGrid) === null ? null : "owed",
    ended: state.current_round_type === "GameEnd",
  });
  const CLEAR = { discard: null, home: [], funding: null, ended: false };

  it("every passing message, applied as a room applies it, leaves either no offer or no earlier hold -- for all three kinds", () => {
    const scenarios: Array<{ label: string; board: () => GameStateResponse; passing: Array<[unknown, string]> }> = [
      { label: "private, unanswered", board: () => apply(orBoard(), M.proposePrivate(DH, PRR, 100), P1), passing: [[M.answerPrivate(DH, true), P2], [M.answerPrivate(DH, false), P2], [M.rescindPrivate(DH), P1]] },
      { label: "private, accepted", board: () => S.privateOfferStages(orBoard(), DH, 100, P2).accepted, passing: [[M.buyPrivate(PRR, DH, "100"), P2], [M.rescindPrivate(DH), P1]] },
      { label: "train, unanswered", board: () => apply(orBoard(), M.proposeTrain(NYC, PRR, "3", "150"), P1), passing: [[M.answerTrain(NYC, true), P2], [M.answerTrain(NYC, false), P2], [M.rescindTrain(NYC), P1]] },
      { label: "train, accepted", board: () => S.trainOfferStages(orBoard(), NYC, "3", "150", P2).accepted, passing: [[M.buyTrain(PRR, NYC, "3", "150"), P2], [M.rescindTrain(NYC), P1]] },
      { label: "trade, unanswered", board: () => apply(srBoard(), M.proposeTrade(DH, P2, P1, 50), P1), passing: [[M.answerTrade(DH, true), P2], [M.answerTrade(DH, false), P2], [M.rescindTrade(DH), P1]] },
    ];
    for (const { label, board: make, passing } of scenarios) {
      const standing = make();
      expect([label, noEarlierHold(standing)]).toEqual([label, CLEAR]);
      for (const [msg, actor] of passing) {
        const after = applyAsRoom(standing, msg, actor);
        const kind = Object.keys(msg as object)[0];
        if (standingOrdinaryOffer(after) !== null) {
          expect([label, kind, noEarlierHold(after)]).toEqual([label, kind, CLEAR]);
        }
      }
    }
  });

  it("the train settlement that fills the buyer to its limit raises no discard, and no phase changes hands with the train", () => {
    const board = withCorp(orBoard(), PRR, { owned_trains: ["2", "2", "2"] });
    const { accepted } = S.trainOfferStages(board, NYC, "3", "150", P2);
    const settled = applyAsRoom(accepted, M.buyTrain(PRR, NYC, "3", "150"), P2);
    expect(trains(settled, PRR)).toEqual(["2", "2", "2", "3"]);
    expect(pendingTrainDiscards(settled)).toBeNull();
    const { derivePhase } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
    expect(derivePhase(settled)?.tier).toBe(derivePhase(accepted)?.tier);
  });

  it("every message family that could raise an earlier hold is itself held while an offer stands (float, phase change, rust, obligation, game end)", () => {
    const raisers: Array<[string, unknown]> = [
      ["a stock purchase (float -> home token)", M.buyStock(NYC)],
      ["a depot purchase (phase change -> discard / rust)", M.depot(PRR)],
      ["the emergency purchase", M.emergency(PRR)],
      ["an exchange (a share out of the IPO)", { ExchangePrivate: { game_id: 1, private_id: MH, company_id: NYC, player: P1, source: "Ipo" } }],
      ["the B&O par", { SetBoPar: { player: P1, par_value: "100" } }],
      ["a Yellow Sign event (a fleet change)", { YellowSignEvent: { game_id: 1, protocol_id: PRR, stage: "mark", model: "2" } }],
      ["End Turn (the next corporation's obligation, a round or set end)", M.pass],
      ["a step advance (to Hardware's obligation)", M.advance(PRR)],
      ["a dividend (the bank)", M.dividend(PRR)],
      ["a route run", M.run(PRR)],
      ["a diesel exchange", { ExchangeTrainForDiesel: { game_id: 1, protocol_id: PRR, model_type: "2" } }],
    ];
    for (const hold of HOLD_BOARDS) {
      const standing = hold.board();
      for (const [label, msg] of raisers) {
        expect([hold.label, label, pendingOfferBlock(standing, msg as never) === null]).toEqual([hold.label, label, false]);
        expect([hold.label, label, same(applyAsRoom(standing, msg, hold.seat), standing)]).toEqual([hold.label, label, true]);
      }
    }
  });

  it("the one designed coexistence -- a D-6 train offer beside the funding obligation -- has the intersection of the two pass lists and nothing more", () => {
    const offered = apply(fundingBoard(100), M.proposeTrain(PRR, CO, "3", "130", null), P1, corridor());
    expect(emergencyFundingFor(offered, corridor())).not.toBeNull();
    const both = (msg: unknown) => emergencyFundingBlock(offered, msg as never, corridor()) === null && pendingOfferBlock(offered, msg as never) === null;
    const candidates: Array<[string, unknown]> = [
      ["answer", M.answerTrain(PRR, true)],
      ["rescind", M.rescindTrain(PRR)],
      ["settle (only once accepted)", M.buyTrain(CO, PRR, "3", "130")],
      ["RevertTo", M.revert(0)],
      ["CloseRoom", M.closeRoom],
      ["the forced sale", M.sellStock(NYC, 10)],
      ["the emergency purchase", M.emergency(CO)],
      ["the funding offer", M.fundingOffer(1, NYC, 20)],
      ["the declaration", M.declare],
      ["a discard", M.discard(CO, "3")],
      ["PassTurn", M.pass],
    ];
    expect(candidates.filter(([, msg]) => both(msg)).map(([label]) => label)).toEqual(["answer", "rescind", "RevertTo", "CloseRoom"]);
    const accepted = apply(offered, M.answerTrain(PRR, true), P3, corridor());
    const bothAccepted = (msg: unknown) => emergencyFundingBlock(accepted, msg as never, corridor()) === null && pendingOfferBlock(accepted, msg as never) === null;
    expect(candidates.filter(([, msg]) => bothAccepted(msg)).map(([label]) => label)).toEqual(["rescind", "settle (only once accepted)", "RevertTo", "CloseRoom"]);
  });
});
