/** @jest-environment node */
//
// ==================================================================
//  BATCH 7.4 EXHAUSTIVE MATRIX (2/6): THE VOLUNTARY INTERCORPORATE TRAIN SALE, AND D-6 BESIDE IT
// ==================================================================
//
// `trainSaleRefusal` (#1592) and its three consent predicates, one fact at a time on a legal board, both locks, no
// mutation on refusal (review brief §3); the treasury-only voluntary rule (D-20/Q7); the same-president direct
// message; the train half of §10 (the seller's CURRENT president answers) and of §13 (R74-A: the buyer's current
// president may withdraw an accepted-but-unsettled offer). Then §4: Batch 5's D-6 forced intercorporate purchase
// kept separate from the voluntary rule -- its presidential contribution, its face cap, the freeze a standing D-6
// offer puts on every other emergency exit (R74-D), the rescission that reopens them, and exactly-once money.

export {};

const { trainSaleRefusal, proposeTrainPurchaseRefusal, answerTrainPurchaseRefusal, rescindTrainPurchaseRefusal } =
  require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const { nextDerivedAction } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { moneyTotal, moneyConservationBreach } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { pendingOfferBlock } = require("../gameEngine/pendingOfferHold") as typeof import("../gameEngine/pendingOfferHold");
const { emergencyFundingFor, emergencyFundingBlock, fundedTradeRefusal } = require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const { P1, P2, P3, PRR, NYC, CO, operatingBoard } = F;
const { apply, ingress, same, differing, withCorp, withState, withCash, atPhase, cash, treasury, trains, guarded, M, GRID, corridor, fundingBoard } = S;

const STEP = "PRR may buy a train only at its Purchase Trains step, and an offer is made there too — a train may not run on the turn it is bought (rulebook 6.4).";
const PRICE = "The price must be a whole number of at least $1 (rulebook 6.6).";
const LIMIT = "PRR is already at its train limit and may not buy another train.";

const base = () => operatingBoard(); // PRR (P1) operating at Hardware: ["2"], $500; NYC (P2): ["3","2"], $400; C&O (P3): ["3"], $300

/* ================================================================== */
/* §3 control                                                          */
/* ================================================================== */

describe("§3 control: proposal at Hardware -> the seller's president accepts -> derived settlement -> one train, one payment", () => {
  it("through a room: one derived BuyTrainFromCorporation; treasury -> treasury once; the president's cash never moves", () => {
    const seed = base();
    const { room, submit, kinds, logged } = S.roomFor(seed);
    expect(kinds(submit(P1, M.proposeTrain(NYC, PRR, "3", "150", P1)))).toEqual(["ProposeTrainPurchase"]);
    expect(room.state.train_purchase_offer).toEqual({
      seller_protocol_id: NYC, seller_ticker: "NYC", seller_president: P2, buyer_protocol_id: PRR, buyer_ticker: "PRR", model_type: "3", price: "150",
      instance: 1, // #1597
    });
    expect(room.state.offer_serial).toBe(1);
    expect(submit(P1, M.pass).kind).toBe("refused");
    expect(kinds(submit(P2, M.answerTrain(NYC, true)))).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*"]);
    expect(room.state.train_purchase_offer).toBeNull();
    expect(trains(room.state, PRR)).toEqual(["2", "3"]);
    expect(trains(room.state, NYC)).toEqual(["2"]);
    expect(treasury(room.state, PRR)).toBe(350);
    expect(treasury(room.state, NYC)).toBe(550);
    expect([cash(room.state, P1), cash(room.state, P2), cash(room.state, P3)]).toEqual([300, 300, 300]);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
    expect(logged("BuyTrainFromCorporation")).toHaveLength(1);
  });

  it("through the reducer: the settled board differs from the seed only in the two fleets, the two treasuries and the retired offer", () => {
    const seed = base();
    const { accepted } = S.trainOfferStages(seed, NYC, "3", "150", P2);
    const settled = apply(accepted, nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() })!.msg, P2);
    expect(differing(seed, settled)).toEqual(["offer_serial", "public_companies", "train_purchase_offer"]); // #1597
    const stripped = (state: GameStateResponse) => state.public_companies.map((entry) => ({ ...entry, treasury: "x", owned_trains: [] }));
    expect(stripped(settled)).toEqual(stripped(seed));
    expect(moneyConservationBreach(seed, settled)).toBeNull();
  });
});

/* ================================================================== */
/* §3 the proposal matrix                                              */
/* ================================================================== */

interface TrainRow {
  label: string;
  board: () => GameStateResponse;
  seller?: number;
  buyer?: number;
  model?: string;
  price?: string;
  actor?: string;
  refusal: string | null;
}

const TRAIN_ROWS: TrainRow[] = [
  { label: "control (Hardware)", board: base, refusal: null },
  { label: "not an Operating Round", board: () => withState(base(), { current_round_type: "StockRound" }), refusal: "Trains are bought from other corporations only during the buyer's turn of an Operating Round." },
  { label: "the buyer is not the operating corporation", board: () => operatingBoard({ operating: CO }), refusal: "Only the operating corporation may buy a train — C&O is operating, not PRR." },
  { label: "the Track step", board: () => operatingBoard({ step: "Track" }), refusal: STEP },
  { label: "the Tokens step", board: () => operatingBoard({ step: "Tokens" }), refusal: STEP },
  { label: "the Routes step", board: () => operatingBoard({ step: "Routes" }), refusal: STEP },
  { label: "the Dividends step", board: () => operatingBoard({ step: "Dividends" }), refusal: STEP },
  { label: "buyer === seller", board: base, seller: PRR, model: "2", refusal: "PRR cannot buy a train from itself." },
  { label: "the seller no longer owns the model", board: () => withCorp(base(), NYC, { owned_trains: ["2"] }), refusal: "NYC does not own a 3-train to sell." },
  { label: "the wrong model (a 4 NYC never had)", board: base, model: "4", refusal: "NYC does not own a 4-train to sell." },
  { label: "the seller has not floated", board: () => withCorp(base(), NYC, { is_floated: false }), refusal: "NYC has not floated and has no train to sell." },
  { label: "the seller has no president to consent", board: () => withCorp(base(), NYC, { president: null }), refusal: "NYC has no president to answer for it." },
  { label: "price $0", board: base, price: "0", refusal: PRICE },
  { label: "a negative price", board: base, price: "-5", refusal: PRICE },
  { label: "a fractional price", board: base, price: "150.5", refusal: PRICE },
  { label: "a non-numeric price", board: base, price: "abc", refusal: PRICE },
  { label: "price $1 (legal)", board: base, price: "1", refusal: null },
  { label: "treasury one dollar short", board: () => withCorp(base(), PRR, { treasury: "149" }), refusal: "PRR's treasury holds $149 — it cannot pay $150; the president's money is never used for a voluntary purchase." },
  { label: "treasury exactly the price (legal)", board: () => withCorp(base(), PRR, { treasury: "150" }), refusal: null },
  { label: "the buyer is at the phase-3 limit (4 trains)", board: () => withCorp(base(), PRR, { owned_trains: ["2", "2", "2", "2"] }), refusal: LIMIT },
  { label: "the buyer is one below the phase-3 limit (3 trains, legal)", board: () => withCorp(base(), PRR, { owned_trains: ["2", "2", "2"] }), refusal: null },
  { label: "the buyer is at the phase-4 limit (3 trains)", board: () => withCorp(atPhase(base(), "4"), PRR, { owned_trains: ["3", "3", "3"] }), refusal: LIMIT },
  { label: "the buyer is one below the phase-4 limit (2 trains, legal)", board: () => withCorp(atPhase(base(), "4"), PRR, { owned_trains: ["3", "3"] }), refusal: null },
  { label: "the proposer is the seller's president", board: base, actor: P2, refusal: "Only PRR's president can make an offer on its behalf." },
  { label: "the proposer is an unrelated player", board: base, actor: P3, refusal: "Only PRR's president can make an offer on its behalf." },
  { label: "the buyer is not in the game", board: base, buyer: 77, refusal: "That corporation is not in this game." },
  { label: "the seller is not in the game", board: base, seller: 77, refusal: "That corporation has no president to answer for it." },
];

describe("§3 the proposal matrix: each fact alone, both locks, no mutation on refusal", () => {
  for (const row of TRAIN_ROWS) {
    it(`${row.refusal === null ? "legal" : "refused"}: ${row.label}`, () => {
      const board = row.board();
      const seller = row.seller ?? NYC;
      const buyer = row.buyer ?? PRR;
      const model = row.model ?? "3";
      const price = row.price ?? "150";
      const actor = row.actor ?? P1;
      const msg = M.proposeTrain(seller, buyer, model, price, "a-forged-president");
      expect(proposeTrainPurchaseRefusal(board, { seller_protocol_id: seller, buyer_protocol_id: buyer, model_type: model, price }, actor, GRID)).toBe(row.refusal);
      expect(ingress(board, actor, msg)).toBe(row.refusal);
      const after = apply(board, msg, actor);
      if (row.refusal !== null) {
        expect(same(after, board)).toBe(true);
        expect(after.train_purchase_offer ?? null).toBeNull();
      } else {
        expect(differing(board, after)).toEqual(["offer_serial", "train_purchase_offer"]); // #1597: the proposal numbers itself
        expect(after.train_purchase_offer).toMatchObject({ seller_protocol_id: seller, buyer_protocol_id: buyer, model_type: model, price, seller_president: S.corp(board, seller).president });
        expect(guarded(after)).toEqual(guarded(board));
      }
    });
  }

  it("the predicate's own sentences where the proposal's rules fire first (a missing corporation; a seller with no president)", () => {
    const ask = (board: GameStateResponse, buyer: number, seller: number) =>
      trainSaleRefusal(board, { buyerId: buyer, sellerId: seller, model: "3", price: "150" }, P1, GRID, "proposal");
    expect(ask(base(), 77, NYC)).toBe("The buying corporation is not in this game.");
    expect(ask(base(), PRR, 77)).toBe("The selling corporation is not in this game.");
    // A seller without a president can still be SETTLED against (the consent is the accepted offer); only the proposal needs somebody to ask.
    expect(ask(withCorp(base(), NYC, { president: null }), PRR, NYC)).toBeNull();
  });

  it("the design's order is load-bearing: with two facts wrong, the earlier rule is the one reported", () => {
    const ask = (board: GameStateResponse, over: { seller?: number; model?: string; price?: string } = {}) =>
      trainSaleRefusal(board, { buyerId: PRR, sellerId: over.seller ?? NYC, model: over.model ?? "3", price: over.price ?? "150" }, P1, GRID, "proposal");
    expect(ask(withState(operatingBoard({ step: "Track" }), { current_round_type: "StockRound" }))).toBe("Trains are bought from other corporations only during the buyer's turn of an Operating Round.");
    expect(ask(operatingBoard({ operating: CO, step: "Track" }))).toBe("Only the operating corporation may buy a train — C&O is operating, not PRR.");
    expect(ask(operatingBoard({ step: "Track" }), { price: "0" })).toBe(STEP);
    expect(ask(base(), { seller: PRR, model: "9", price: "0" })).toBe("PRR cannot buy a train from itself.");
    expect(ask(withCorp(base(), NYC, { is_floated: false, owned_trains: [] }))).toBe("NYC has not floated and has no train to sell.");
    expect(ask(withCorp(base(), NYC, { owned_trains: [] }), { price: "0" })).toBe("NYC does not own a 3-train to sell.");
    expect(ask(withCorp(base(), PRR, { treasury: "0" }), { price: "0" })).toBe(PRICE);
    expect(ask(withCorp(base(), PRR, { treasury: "0", owned_trains: ["2", "2", "2", "2"] }))).toBe("PRR's treasury holds $0 — it cannot pay $150; the president's money is never used for a voluntary purchase.");
  });

  it("the voluntary purchase is the treasury's alone: a rich president changes nothing at proposal, answer or settlement", () => {
    const poor = withCash(withCorp(base(), PRR, { treasury: "100" }), P1, 5000);
    const refusal = "PRR's treasury holds $100 — it cannot pay $150; the president's money is never used for a voluntary purchase.";
    expect(ingress(poor, P1, M.proposeTrain(NYC, PRR, "3", "150"))).toBe(refusal);
    // An offer accepted while the treasury could pay, drained before settlement, is refused and retired: P1's $5000 is never touched.
    const { accepted } = S.trainOfferStages(base(), NYC, "3", "150", P2);
    const drained = withCash(withCorp(accepted, PRR, { treasury: "100" }), P1, 5000);
    const after = apply(drained, M.buyTrain(PRR, NYC, "3", "150"), P2);
    expect(differing(drained, after)).toEqual(["train_purchase_offer"]);
    expect(cash(after, P1)).toBe(5000);
    expect(trains(after, PRR)).toEqual(["2"]);
  });
});

/* ================================================================== */
/* §3 / §10 the answer                                                 */
/* ================================================================== */

describe("§3 / §10 (train): the seller's CURRENT president answers; an acceptance re-runs the predicate", () => {
  const offered = () => apply(base(), M.proposeTrain(NYC, PRR, "3", "150", P1), P1);

  it("a proposer who writes himself in as the seller's president is recorded as the board's president and cannot answer", () => {
    const board = offered();
    expect(board.train_purchase_offer?.seller_president).toBe(P2);
    for (const actor of [P1, P3]) {
      for (const accept of [true, false]) {
        expect(answerTrainPurchaseRefusal(board, { seller_protocol_id: NYC, accept }, actor, GRID)).toBe("Only the selling corporation's president can answer that offer.");
        expect(ingress(board, actor, M.answerTrain(NYC, accept))).toBe("Only the selling corporation's president can answer that offer.");
        expect(same(apply(board, M.answerTrain(NYC, accept), actor), board)).toBe(true);
      }
    }
    expect(answerTrainPurchaseRefusal(board, { seller_protocol_id: CO, accept: true }, P2, GRID)).toBe("That is not the corporation whose train is on offer.");
  });

  it("the seller's presidency changes before the answer: the old president loses the answer; the new one's acceptance settles", () => {
    const moved = withCorp(offered(), NYC, { president: P3 });
    expect(ingress(moved, P2, M.answerTrain(NYC, true))).toBe("Only the selling corporation's president can answer that offer.");
    expect(same(apply(moved, M.answerTrain(NYC, true), P2), moved)).toBe(true);
    expect(ingress(moved, P3, M.answerTrain(NYC, true))).toBeNull();
    const accepted = apply(moved, M.answerTrain(NYC, true), P3);
    expect(accepted.train_purchase_offer).toMatchObject({ accepted: true, seller_president: P2 });
    const settled = apply(accepted, M.buyTrain(PRR, NYC, "3", "150"), P3);
    expect(trains(settled, PRR)).toEqual(["2", "3"]);
    expect(settled.train_purchase_offer).toBeNull();
  });

  it("a seller with no president at answer time: nobody may answer, and the buyer may still withdraw", () => {
    const orphan = withCorp(offered(), NYC, { president: null });
    expect(answerTrainPurchaseRefusal(orphan, { seller_protocol_id: NYC, accept: false }, P2, GRID)).toBe("NYC has no president to answer for it.");
    expect(ingress(orphan, P2, M.answerTrain(NYC, false))).toBe("NYC has no president to answer for it.");
    expect(ingress(orphan, P1, M.rescindTrain(NYC))).toBeNull();
  });

  const STALE_AT_ANSWER: Array<[string, (state: GameStateResponse) => GameStateResponse, string]> = [
    ["the round changed", (s) => withState(s, { current_round_type: "StockRound" }), "Trains are bought from other corporations only during the buyer's turn of an Operating Round."],
    ["another corporation is operating", (s) => withState(s, { active_corporation_index: 2 }), "Only the operating corporation may buy a train — C&O is operating, not PRR."],
    ["the step moved off Hardware", (s) => withState(s, { operating_sub_phase: "Routes" }), STEP],
    ["the seller lost the train", (s) => withCorp(s, NYC, { owned_trains: ["2"] }), "NYC does not own a 3-train to sell."],
    ["the seller unfloated", (s) => withCorp(s, NYC, { is_floated: false }), "NYC has not floated and has no train to sell."],
    ["the treasury fell below the price", (s) => withCorp(s, PRR, { treasury: "149" }), "PRR's treasury holds $149 — it cannot pay $150; the president's money is never used for a voluntary purchase."],
    ["the buyer reached its limit", (s) => withCorp(s, PRR, { owned_trains: ["2", "2", "2", "2"] }), LIMIT],
  ];
  for (const [label, stale, refusal] of STALE_AT_ANSWER) {
    it(`an acceptance on a stale board is refused and the offer stands; a rejection still passes: ${label}`, () => {
      const board = stale(offered());
      expect(answerTrainPurchaseRefusal(board, { seller_protocol_id: NYC, accept: true }, P2, GRID)).toBe(refusal);
      expect(ingress(board, P2, M.answerTrain(NYC, true))).toBe(refusal);
      const after = apply(board, M.answerTrain(NYC, true), P2);
      expect(same(after, board)).toBe(true);
      expect(after.train_purchase_offer?.accepted).toBeUndefined();
      expect(ingress(board, P2, M.answerTrain(NYC, false))).toBeNull();
      expect(apply(board, M.answerTrain(NYC, false), P2).train_purchase_offer).toBeNull();
    });
  }
});

/* ================================================================== */
/* §3 settlement: consent, mismatch, the direct same-president sale     */
/* ================================================================== */

describe("§3 settlement: the accepted offer is the consent; the direct message needs one president over both", () => {
  const acceptedBoard = () => S.trainOfferStages(base(), NYC, "3", "150", P2).accepted;

  it("the seller's presidency changes AFTER acceptance: the settlement still lands -- the selling corporation consented (pinned, design §7.5 rule 6)", () => {
    /* Design §7.5's train consent is a matching accepted offer (seller, buyer, model, price) and nothing about who
       presides; §7.4's private consent adds "whose owner is still the owner". The asymmetry is the design's: a
       private's owner is the payee, a train's payee is the corporation. Fixture-only (the hold freezes every
       presidency change between acceptance and settlement). */
    const moved = withCorp(acceptedBoard(), NYC, { president: P3 });
    const settled = apply(moved, M.buyTrain(PRR, NYC, "3", "150"), P2);
    expect(trains(settled, PRR)).toEqual(["2", "3"]);
    expect(treasury(settled, NYC)).toBe(550);
    expect(settled.train_purchase_offer).toBeNull();
  });

  const MISMATCHES: Array<[string, unknown]> = [
    ["the seller differs", M.buyTrain(PRR, CO, "3", "150")],
    ["the buyer differs", M.buyTrain(CO, NYC, "3", "150")],
    ["the model differs", M.buyTrain(PRR, NYC, "2", "150")],
    ["the price differs", M.buyTrain(PRR, NYC, "3", "149")],
  ];
  for (const [label, msg] of MISMATCHES) {
    it(`a settlement that does not match the accepted offer is held, does NOT retire it, and moves nothing: ${label}`, () => {
      const accepted = acceptedBoard();
      expect(pendingOfferBlock(accepted, msg as never)).toContain("accepted and awaiting settlement");
      expect(ingress(accepted, P1, msg)).toContain("accepted and awaiting settlement");
      const after = apply(accepted, msg, P1);
      expect(same(after, accepted)).toBe(true);
      expect(after.train_purchase_offer).toMatchObject({ accepted: true, seller_protocol_id: NYC, buyer_protocol_id: PRR, model_type: "3", price: "150" });
      expect(nextDerivedAction({ state: after, mapGrid: GRID, emitted: new Set() })?.msg).toEqual({
        BuyTrainFromCorporation: { game_id: 0, buyer_protocol_id: PRR, seller_protocol_id: NYC, model_type: "3", price: "150" },
      });
    });
  }

  it("the settlement consent at every sender: the accepted offer consents whoever carries it; ingress asks the seat", () => {
    const accepted = acceptedBoard();
    for (const actor of [P1, P2, P3]) {
      expect(trainSaleRefusal(accepted, { buyerId: PRR, sellerId: NYC, model: "3", price: "150" }, actor, GRID, "settlement")).toBeNull();
    }
    expect(ingress(accepted, P1, M.buyTrain(PRR, NYC, "3", "150"))).toBeNull();
    expect(ingress(accepted, P2, M.buyTrain(PRR, NYC, "3", "150"))).toBe("It is not your turn.");
  });

  const bothBoard = () => withCorp(base(), NYC, { president: P1 });

  it("the same player genuinely presides over buyer and seller: the direct sale is legal at both locks, one train, one payment", () => {
    const board = bothBoard();
    expect(trainSaleRefusal(board, { buyerId: PRR, sellerId: NYC, model: "3", price: "150" }, P1, GRID, "settlement")).toBeNull();
    expect(ingress(board, P1, M.buyTrain(PRR, NYC, "3", "150"))).toBeNull();
    const done = apply(board, M.buyTrain(PRR, NYC, "3", "150"), P1);
    expect(differing(board, done)).toEqual(["public_companies"]);
    expect(trains(done, PRR)).toEqual(["2", "3"]);
    expect(trains(done, NYC)).toEqual(["2"]);
    expect([treasury(done, PRR), treasury(done, NYC)]).toEqual([350, 550]);
    expect(cash(done, P1)).toBe(300);
    expect(moneyConservationBreach(board, done)).toBeNull();
    // The same message again moves NYC's last 3? NYC has none left: refused, nothing moves.
    expect(same(apply(done, M.buyTrain(PRR, NYC, "3", "150"), P1), done)).toBe(true);
  });

  it("the actor presides over the buyer only: refused at both locks", () => {
    const board = base();
    const refusal = "NYC's president has not agreed to sell its 3-train to PRR — make an offer and wait for the answer.";
    expect(trainSaleRefusal(board, { buyerId: PRR, sellerId: NYC, model: "3", price: "150" }, P1, GRID, "settlement")).toBe(refusal);
    expect(ingress(board, P1, M.buyTrain(PRR, NYC, "3", "150"))).toBe(refusal);
    expect(same(apply(board, M.buyTrain(PRR, NYC, "3", "150"), P1), board)).toBe(true);
  });

  it("the actor presides over the seller only: ingress refuses the seat; the reducer refuses the consent", () => {
    const board = base();
    expect(ingress(board, P2, M.buyTrain(PRR, NYC, "3", "150"))).toBe("It is not your turn.");
    expect(trainSaleRefusal(board, { buyerId: PRR, sellerId: NYC, model: "3", price: "150" }, P2, GRID, "settlement")).toBe("Only PRR's president buys for PRR, and only with NYC's president's consent.");
    expect(same(apply(board, M.buyTrain(PRR, NYC, "3", "150"), P2), board)).toBe(true);
    // Presiding over the seller while ANOTHER player presides over the operating buyer: still not both.
    const sellerOnly = withCorp(withCorp(base(), NYC, { president: P1 }), PRR, { president: P3 });
    expect(trainSaleRefusal(sellerOnly, { buyerId: PRR, sellerId: NYC, model: "3", price: "150" }, P1, GRID, "settlement")).toBe("Only PRR's president buys for PRR, and only with NYC's president's consent.");
    expect(same(apply(sellerOnly, M.buyTrain(PRR, NYC, "3", "150"), P1), sellerOnly)).toBe(true);
  });

  it("the direct message runs the whole predicate: every one-fact row refuses the same-president sale too, $0 included", () => {
    const rows: Array<[string, GameStateResponse, string, string]> = [
      ["$0", bothBoard(), "0", PRICE],
      ["Track", withState(bothBoard(), { operating_sub_phase: "Track" }), "150", STEP],
      ["treasury short", withCash(withCorp(bothBoard(), PRR, { treasury: "149" }), P1, 5000), "150", "PRR's treasury holds $149 — it cannot pay $150; the president's money is never used for a voluntary purchase."],
      ["at the limit", withCorp(bothBoard(), PRR, { owned_trains: ["2", "2", "2", "2"] }), "150", LIMIT],
    ];
    for (const [label, board, price, refusal] of rows) {
      expect([label, ingress(board, P1, M.buyTrain(PRR, NYC, "3", price))]).toEqual([label, refusal]);
      expect([label, same(apply(board, M.buyTrain(PRR, NYC, "3", price), P1), board)]).toEqual([label, true]);
    }
  });
});

/* ================================================================== */
/* §13 (train) R74-A: withdrawing an accepted-but-unsettled offer       */
/* ================================================================== */

describe("§13 (train) R74-A: the buyer's current president may withdraw an accepted offer before it settles", () => {
  it("the proposer rescinds; the counterparty and an unrelated player cannot; nothing but the offer clears; nothing is owed", () => {
    const seed = base();
    const { accepted } = S.trainOfferStages(seed, NYC, "3", "150", P2);
    for (const actor of [P2, P3]) {
      expect(rescindTrainPurchaseRefusal(accepted, { seller_protocol_id: NYC }, actor)).toBe("Only PRR's president can withdraw its offer.");
      expect(ingress(accepted, actor, M.rescindTrain(NYC))).toBe("Only PRR's president can withdraw its offer.");
      expect(same(apply(accepted, M.rescindTrain(NYC), actor), accepted)).toBe(true);
    }
    expect(pendingOfferBlock(accepted, M.rescindTrain(NYC) as never)).toBeNull();
    expect(ingress(accepted, P1, M.rescindTrain(NYC))).toBeNull();
    const withdrawn = apply(accepted, M.rescindTrain(NYC), P1);
    // #1597: `offer_serial` records that an offer was made and survives its release; only the offer field itself is cleared.
    expect(differing(seed, withdrawn)).toEqual(["offer_serial", "train_purchase_offer"]);
    expect(differing(accepted, withdrawn)).toEqual(["train_purchase_offer"]);
    expect(withdrawn.train_purchase_offer).toBeNull();
    expect(guarded(withdrawn)).toEqual(guarded(seed));
    expect(nextDerivedAction({ state: withdrawn, mapGrid: GRID, emitted: new Set() })).toBeNull();
    // The settlement is no longer owed: sent anyway it has no offer and no consent, and moves nothing.
    expect(same(apply(withdrawn, M.buyTrain(PRR, NYC, "3", "150"), P2), withdrawn)).toBe(true);
    expect(ingress(withdrawn, P1, M.buyTrain(PRR, NYC, "3", "150"))).toBe("NYC's president has not agreed to sell its 3-train to PRR — make an offer and wait for the answer.");
  });

  it("a buyer presidency that moved under the accepted offer moves the right to withdraw with it", () => {
    const moved = withCorp(S.trainOfferStages(base(), NYC, "3", "150", P2).accepted, PRR, { president: P3 });
    expect(ingress(moved, P1, M.rescindTrain(NYC))).toBe("Only PRR's president can withdraw its offer.");
    expect(ingress(moved, P3, M.rescindTrain(NYC))).toBeNull();
    expect(rescindTrainPurchaseRefusal(moved, { seller_protocol_id: CO }, P3)).toBe("That is not the corporation whose train is on offer.");
    expect(rescindTrainPurchaseRefusal(base(), { seller_protocol_id: NYC }, P1)).toBe("There is no train offer to withdraw.");
  });
});

/* ================================================================== */
/* §4 D-6: the forced intercorporate purchase, kept separate            */
/* ================================================================== */

describe("§4 D-6 preserved: the forced purchase's money, beside and apart from the voluntary rule", () => {
  const applyC = (state: GameStateResponse, msg: unknown, actor: string) => apply(state, msg, actor, corridor());
  const ingressC = (state: GameStateResponse, actor: string, msg: unknown) => ingress(state, actor, msg, corridor());
  const funding = (state: GameStateResponse) => emergencyFundingFor(state, corridor());
  const proposeD6 = (price: string, model = "3") => M.proposeTrain(PRR, CO, model, price, null);

  it("shortfall 0 (the president can fund the bank's train): the D-6 trade through a room pays treasury first, the president the rest, exactly once", () => {
    const seed = fundingBoard(200);
    expect(funding(seed)).toMatchObject({ shortfall: 0, canPurchase: true, treasury: 30, presidentCash: 200 });
    const { room, submit, kinds, logged } = S.roomFor(seed, corridor());
    expect(kinds(submit(P1, proposeD6("150")))).toEqual(["ProposeTrainPurchase"]);
    expect(submit(P1, M.emergency(CO)).kind).toBe("refused"); // the offer freezes the other exit
    expect(kinds(submit(P3, M.answerTrain(PRR, true)))).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*"]);
    expect(trains(room.state, CO)).toEqual(["3"]);
    expect(trains(room.state, PRR)).toEqual(["3"]);
    expect(treasury(room.state, CO)).toBe(0);
    expect(cash(room.state, P1)).toBe(80); // $120 = 150 - 30, once
    expect(treasury(room.state, PRR)).toBe(650);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
    expect(funding(room.state)).toBeNull();
    expect(logged("BuyTrainFromCorporation")).toHaveLength(1);
    // No double contribution / transfer / train: a replay with a duplicated derived settlement lands one.
    const payloadOf = (kind: string) => JSON.parse(logged(kind)[0].payload);
    const once = replayLog(
      [S.entry(0, P1, proposeD6("150")), S.entry(1, P3, M.answerTrain(PRR, true)), S.entry(2, P3, payloadOf("BuyTrainFromCorporation"), true)],
      { ...sandboxReplayProviders(), initialGrid: corridor() }, { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY,
    );
    const twice = replayLog(
      [S.entry(0, P1, proposeD6("150")), S.entry(1, P3, M.answerTrain(PRR, true)), S.entry(2, P3, payloadOf("BuyTrainFromCorporation"), true), S.entry(3, P3, payloadOf("BuyTrainFromCorporation"), true)],
      { ...sandboxReplayProviders(), initialGrid: corridor() }, { state: seed, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY,
    );
    expect(stateDigest(twice.state)).toBe(stateDigest(once.state));
    expect(cash(twice.state, P1)).toBe(80);
    expect(trains(twice.state, CO)).toEqual(["3"]);
  });

  it("shortfall > 0: a trade the treasury and the president's cash cover exactly is the D-6 path; one dollar more is refused at both locks", () => {
    const seed = fundingBoard(100); // $30 + $100 = $130; the bank's 3 costs $180 (shortfall $50)
    expect(funding(seed)).toMatchObject({ shortfall: 50, canPurchase: false });
    const refusal = "C&O and its president hold $130 together and cannot pay $131 without selling shares or private companies; a forced purchase is completed through the Bank instead (owner rule).";
    expect(ingressC(seed, P1, proposeD6("131"))).toBe(refusal);
    expect(same(applyC(seed, proposeD6("131"), P1), seed)).toBe(true);
    expect(ingressC(seed, P1, proposeD6("130"))).toBeNull();
    const offered = applyC(seed, proposeD6("130"), P1);
    const accepted = applyC(offered, M.answerTrain(PRR, true), P3);
    const settled = applyC(accepted, M.buyTrain(CO, PRR, "3", "130"), P3);
    expect([treasury(settled, CO), cash(settled, P1), treasury(settled, PRR)]).toEqual([0, 0, 630]);
    expect(trains(settled, CO)).toEqual(["3"]);
    expect(moneyTotal(settled)).toBe(moneyTotal(seed));
    expect(funding(settled)).toBeNull();
    expect(same(applyC(settled, M.buyTrain(CO, PRR, "3", "130"), P3), settled)).toBe(true);
  });

  it("the ordinary treasury rule does not leak into D-6: price above the treasury is legal when the president's cash covers it", () => {
    const seed = fundingBoard(200);
    expect(trainSaleRefusal(seed, { buyerId: CO, sellerId: PRR, model: "3", price: "150" }, P1, corridor(), "proposal")).toBeNull();
    // Without the obligation's grid the same board is judged as voluntary and refused -- the reducer fails closed.
    expect(trainSaleRefusal(seed, { buyerId: CO, sellerId: PRR, model: "3", price: "150" }, P1, undefined, "proposal")).toBe(
      "C&O's treasury holds $30 — it cannot pay $150; the president's money is never used for a voluntary purchase.",
    );
  });

  it("D-6 does not leak into a voluntary purchase: with no obligation standing the president's cash never counts", () => {
    const treasuryRefusal = (held: number, price: number) => `C&O's treasury holds $${held} — it cannot pay $${price}; the president's money is never used for a voluntary purchase.`;
    // (a) the corporation already owns a train: no obligation
    const hasTrain = fundingBoard(200, { coTrains: ["2"] });
    expect(funding(hasTrain)).toBeNull();
    expect(ingressC(hasTrain, P1, proposeD6("150"))).toBe(treasuryRefusal(30, 150));
    expect(ingressC(hasTrain, P1, proposeD6("30"))).toBeNull();
    // (b) the treasury can buy the bank's train alone: no obligation
    const rich = fundingBoard(200, { coTreasury: "200" });
    expect(funding(rich)).toBeNull();
    expect(ingressC(rich, P1, proposeD6("250"))).toBe(treasuryRefusal(200, 250));
    // (c) the forced buyer's own rule never reaches another corporation's purchase
    const obligated = fundingBoard(200);
    expect(fundedTradeRefusal(obligated, funding(obligated)!, NYC, 999, 180)).toBeNull();
  });

  it("the face cap applies only when the president contributes", () => {
    const board = fundingBoard(300, { coTreasury: "100", prrTrains: ["3", "2"] }); // phase 3: the bank's 3 at $180 > $100
    expect(funding(board)).toMatchObject({ shortfall: 0 });
    expect(ingressC(board, P1, proposeD6("90", "2"))).toBeNull(); // above the 2's $80 face, inside the treasury: no contribution, no cap
    expect(ingressC(board, P1, proposeD6("100", "2"))).toBeNull();
    expect(ingressC(board, P1, proposeD6("101", "2"))).toBe("When the president contributes, a train bought from another corporation may not cost more than its $80 face value (rulebook 6.6.2).");
    expect(ingressC(board, P1, proposeD6("180", "3"))).toBeNull();
    expect(ingressC(board, P1, proposeD6("181", "3"))).toBe("When the president contributes, a train bought from another corporation may not cost more than its $180 face value (rulebook 6.6.2).");
    // and no contribution is taken when the treasury covers the price
    const settled = applyC(applyC(applyC(board, proposeD6("90", "2"), P1), M.answerTrain(PRR, true), P3), M.buyTrain(CO, PRR, "2", "90"), P3);
    expect([treasury(settled, CO), cash(settled, P1)]).toEqual([10, 300]);
  });

  describe("R74-D: while a D-6 train offer stands every other emergency exit is frozen; the proposer's rescission reopens them", () => {
    const EXITS: Array<{ label: string; board: () => GameStateResponse; msg: unknown; price: string }> = [
      { label: "the forced share sale", board: () => fundingBoard(100), msg: M.sellStock(NYC, 10), price: "130" },
      { label: "the emergency depot purchase (funded)", board: () => fundingBoard(200), msg: M.emergency(CO), price: "150" },
      {
        label: "the funding private offer",
        board: () => fundingBoard(20, { coHoldings: [[P1, 20], [P2, 20]], nycHoldings: [[P2, 30]], privates: [{ id: 1, owner: P1, cost: "40" }] }),
        msg: M.fundingOffer(1, NYC, 40),
        price: "50",
      },
      {
        label: "the bankruptcy declaration",
        board: () => fundingBoard(20, { coHoldings: [[P1, 20], [P2, 20]], nycHoldings: [[P2, 30]], privates: [{ id: 1, owner: P1, cost: "40" }] }),
        msg: M.declare,
        price: "50",
      },
    ];
    for (const exit of EXITS) {
      it(`${exit.label}: legal before the offer, frozen while it stands (both locks), legal again after the rescission`, () => {
        const board = exit.board();
        expect(ingressC(board, P1, exit.msg)).toBeNull();
        expect(same(applyC(board, exit.msg, P1), board)).toBe(false);
        const offered = applyC(board, proposeD6(exit.price), P1);
        expect(offered.train_purchase_offer).toMatchObject({ buyer_protocol_id: CO, seller_protocol_id: PRR, price: exit.price });
        expect(funding(offered)).not.toBeNull(); // the obligation still stands; the train offer is not a funding offer
        expect(funding(offered)?.privateOffer).toBeNull();
        expect(ingressC(offered, P1, exit.msg)).not.toBeNull();
        expect(same(applyC(offered, exit.msg, P1), offered)).toBe(true);
        // The seller's president and a third player cannot withdraw it; the proposer can.
        expect(ingressC(offered, P3, M.rescindTrain(PRR))).toBe("Only C&O's president can withdraw its offer.");
        expect(ingressC(offered, P2, M.rescindTrain(PRR))).toBe("Only C&O's president can withdraw its offer.");
        const rescinded = applyC(offered, M.rescindTrain(PRR), P1);
        expect(differing(offered, rescinded)).toEqual(["train_purchase_offer"]);
        expect(ingressC(rescinded, P1, exit.msg)).toBeNull();
        expect(same(applyC(rescinded, exit.msg, P1), rescinded)).toBe(false);
      });
    }

    it("PassTurn, a depot purchase and a second offer are refused too; the answer and the settlement pass both holds", () => {
      const offered = applyC(fundingBoard(200), proposeD6("150"), P1);
      for (const msg of [M.pass, M.depot(CO), M.advance(CO), M.proposeTrain(PRR, CO, "3", "140", null)]) {
        expect(ingressC(offered, P1, msg)).not.toBeNull();
        expect(same(applyC(offered, msg, P1), offered)).toBe(true);
      }
      expect(emergencyFundingBlock(offered, M.answerTrain(PRR, true) as never, corridor())).toBeNull();
      expect(pendingOfferBlock(offered, M.answerTrain(PRR, true) as never)).toBeNull();
      expect(ingressC(offered, P3, M.answerTrain(PRR, true))).toBeNull();
      const accepted = applyC(offered, M.answerTrain(PRR, true), P3);
      const settlement = M.buyTrain(CO, PRR, "3", "150");
      expect(emergencyFundingBlock(accepted, settlement as never, corridor())).toBeNull();
      expect(pendingOfferBlock(accepted, settlement as never)).toBeNull();
      // R74-A under D-6: the accepted-but-unsettled D-6 offer can still be withdrawn by the obligated president.
      expect(ingressC(accepted, P1, M.rescindTrain(PRR))).toBeNull();
      expect(differing(accepted, applyC(accepted, M.rescindTrain(PRR), P1))).toEqual(["train_purchase_offer"]);
    });
  });
});
