/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1590-1596 (harness): PENDING OFFERS, CONSENT AND AUTHORITATIVE SETTLEMENT (Batch 7.4)
// ==================================================================
//
// The state machine, proved case by case on hand-built legal boards (`offerFixtures74.ts`): the corporation's
// private purchase (#1591), the intercorporate train sale (#1592), the player <-> player trade (#1593), the
// two rescissions and the trade's three messages (#1594), the re-derived counterparties (#1595), the one
// global hold (#1590) and the one deliberate mutation -- a refused accepted settlement retiring its offer
// (#1596). Refusals are proved by DIGEST (S7-17: every board here carries a chart) and, where the claim is
// atomicity, by the list of differing top-level fields. Money is checked with the 7.1 conservation harness.
//
// This is the FOCUSED pass. The exhaustive +/- one-fact matrix over every rule of every predicate is the
// follow-on batch's; what is pinned here is that the wiring holds -- each moment asks the authority, each
// answerer is the board's, each settlement is exactly once, and nothing spins.

export {};

const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { stateDigest, fieldDigests } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { moneyConservationBreach, moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { nextDerivedAction } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { pendingOfferBlock, standingOrdinaryOffer, legacyOfferMessageRefusal } =
  require("../gameEngine/pendingOfferHold") as typeof import("../gameEngine/pendingOfferHold");
const { privatePurchaseRefusal, proposePrivatePurchaseRefusal, answerPrivatePurchaseRefusal } =
  require("../gameEngine/privatePurchaseAuthority") as typeof import("../gameEngine/privatePurchaseAuthority");
const { trainSaleRefusal, proposeTrainPurchaseRefusal, answerTrainPurchaseRefusal } =
  require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const { privateTradeRefusal, proposePrivateTradeRefusal } =
  require("../gameEngine/privateTradeAuthority") as typeof import("../gameEngine/privateTradeAuthority");
const { replayLog, RoomEngine } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { validateGameplayMessage, GAMEPLAY_MESSAGE_KINDS } =
  require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
const { boPresidencyRefusal } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { certificateBreakdown } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type ServerLogEntry = import("./roomSession").ServerLogEntry;

const { P1, P2, P3, PRR, NYC, CO, DH, CA, MH, BO, operatingBoard, stockRoundBoard, company, priv, cash, treasury } = F;

const GRID = { game_id: 1, tiles: [] } as unknown as import("../components/hexContractTypes").MapGridResponse;
const apply = (state: GameStateResponse, msg: unknown, actor: string | null = null) =>
  applySandboxAction(state, msg as never, { actor, mapGrid: GRID });
const same = (a: GameStateResponse, b: GameStateResponse) => stateDigest(a) === stateDigest(b);
const differing = (a: GameStateResponse, b: GameStateResponse) => {
  const was = fieldDigests(a);
  const now = fieldDigests(b);
  return Object.keys({ ...was, ...now }).filter((key) => was[key] !== now[key]).sort();
};
/** "Back to the board before the offer": the only fields that may differ are the offer's own, which is null, and
 *  `offer_serial` (#1597), which records that an offer was made and is never cleared -- a released offer's number
 *  is spent, so a later offer is a later instance. */
const backToBefore = (before: GameStateResponse, after: GameStateResponse, field: keyof GameStateResponse) => {
  expect(differing(before, after).filter((key) => key !== field && key !== "offer_serial")).toEqual([]);
  expect(after[field] ?? null).toBeNull();
  expect(after.offer_serial).toBe((before.offer_serial ?? 0) + 1);
};
const ingress = (state: GameStateResponse, actor: string, msg: unknown) =>
  turnRefusal({ state, waterfall: null, actor, msg: msg as never, host: P1, log: [], mapGrid: GRID });

/* ---- messages ---- */
const PROPOSE_PRIVATE = (privateId: number, buyer: number, price: number, owner = "narration") =>
  ({ ProposePrivatePurchase: { game_id: 1, private_id: privateId, private_name: "x", owner, buyer_protocol_id: buyer, buyer_ticker: "x", price } });
const ANSWER_PRIVATE = (privateId: number, accept: boolean) => ({ AnswerPrivatePurchase: { game_id: 1, private_id: privateId, accept } });
const RESCIND_PRIVATE = (privateId: number) => ({ RescindPrivatePurchase: { game_id: 1, private_id: privateId } });
const BUY_PRIVATE = (buyer: number, privateId: number, price: string) =>
  ({ BuyPrivateCompany: { game_id: 1, protocol_id: buyer, private_id: privateId, price } });
const PROPOSE_TRAIN = (seller: number, buyer: number, model: string, price: string, sellerPresident: string | null = "narration") =>
  ({ ProposeTrainPurchase: { game_id: 1, seller_protocol_id: seller, seller_ticker: "x", seller_president: sellerPresident, buyer_protocol_id: buyer, buyer_ticker: "x", model_type: model, price } });
const ANSWER_TRAIN = (seller: number, accept: boolean) => ({ AnswerTrainPurchase: { game_id: 1, seller_protocol_id: seller, accept } });
const RESCIND_TRAIN = (seller: number) => ({ RescindTrainPurchase: { game_id: 1, seller_protocol_id: seller } });
const BUY_TRAIN = (buyer: number, seller: number, model: string, price: string) =>
  ({ BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: buyer, seller_protocol_id: seller, model_type: model, price } });
const PROPOSE_TRADE = (privateId: number, seller: string, buyer: string, price: number) =>
  ({ ProposePrivateTrade: { game_id: 1, private_id: privateId, seller, buyer, price } });
const ANSWER_TRADE = (privateId: number, accept: boolean) => ({ AnswerPrivateTrade: { game_id: 1, private_id: privateId, accept } });
const RESCIND_TRADE = (privateId: number) => ({ RescindPrivateTrade: { game_id: 1, private_id: privateId } });
const PASS = { PassTurn: { game_id: 1 } };
const ADVANCE = (id: number) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } });
const BUY_STOCK = (id: number) => ({ BuyStock: { game_id: 1, protocol_id: id, source: "Ipo", par_value: null } });
const SELL_STOCK = (id: number, pct: number) => ({ SellStock: { game_id: 1, protocol_id: id, percentage: pct } });
const REVERT = (index: number, player: string) => ({ RevertTo: { index, player, summary: "undo" } });

/* ================================================================== */
/* B. The corporation's private purchase                               */
/* ================================================================== */

describe("B. the ordinary corporate private purchase has one authority (#1591)", () => {
  it("the legal transaction: proposal by the buyer's president, acceptance by the current owner, one derived settlement", () => {
    const state = operatingBoard();
    expect(proposePrivatePurchaseRefusal(state, { private_id: DH, buyer_protocol_id: PRR, price: 100 }, P1)).toBeNull();
    const offered = apply(state, PROPOSE_PRIVATE(DH, PRR, 100, "forged-owner"), P1);
    // The offer records the BOARD's owner, never the payload's.
    expect(offered.private_purchase_offer).toMatchObject({ private_id: DH, owner: P2, buyer_protocol_id: PRR, buyer_ticker: "PRR", price: 100, private_name: "Delaware & Hudson" });
    expect(offered.private_purchase_offer?.accepted).toBeUndefined();
    // The board owes nothing yet: an unanswered offer is not a purchase.
    expect(nextDerivedAction({ state: offered, mapGrid: GRID, emitted: new Set() })).toBeNull();
    const accepted = apply(offered, ANSWER_PRIVATE(DH, true), P2);
    expect(accepted.private_purchase_offer?.accepted).toBe(true);
    expect(priv(accepted, DH).owner).toBe(P2); // the answer records; it does not buy (#1247)
    const owed = nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() });
    expect(owed?.kind).toBe("accepted-offer");
    expect(owed?.msg).toEqual({ BuyPrivateCompany: { game_id: 0, protocol_id: PRR, private_id: DH, price: "100" } });
    const settled = apply(accepted, owed!.msg, P2); // the derived entry carries the provoking actor (#549)
    expect(settled.private_purchase_offer).toBeNull();
    expect(priv(settled, DH)).toMatchObject({ owner: null, owner_protocol_id: PRR });
    expect(treasury(settled, PRR)).toBe(400);
    expect(cash(settled, P2)).toBe(400);
    expect(moneyConservationBreach(state, settled)).toBeNull();
    // Settled, so nothing is owed and the hold is released.
    expect(nextDerivedAction({ state: settled, mapGrid: GRID, emitted: new Set() })).toBeNull();
    expect(pendingOfferBlock(settled, PASS as never)).toBeNull();
  });

  it("the predicate's rules, one fact at a time, at proposal", () => {
    const base = operatingBoard();
    const ask = (state: GameStateResponse, price = 100, buyer = PRR, privateId = DH) =>
      privatePurchaseRefusal(state, { buyerId: buyer, privateId, price }, P1, "proposal");
    expect(ask(base)).toBeNull();
    expect(ask(stockRoundBoard())).toContain("Operating Round");
    expect(ask(operatingBoard({ operating: NYC }))).toContain("NYC is operating, not PRR");
    expect(ask(operatingBoard({ step: "Track" }))).toBeNull(); // any step of its turn (3.0)
    const phaseTwo = operatingBoard({ corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "500" },
      { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90 },
    ] });
    expect(ask(phaseTwo)).toContain("phases 3 and 4");
    expect(ask(base, 100, PRR, 99)).toContain("not in this game");
    expect(ask(operatingBoard({ privates: [{ id: DH, owner: P2, cost: "70", closed: true }] }))).toContain("has closed");
    expect(ask(operatingBoard({ privates: [{ id: BO, owner: P2, cost: "220" }] }), 220, PRR, BO)).toContain("may never be sold to a corporation");
    expect(ask(operatingBoard({ privates: [{ id: DH, owner: null, ownerCorp: NYC, cost: "70" }] }))).toContain("not sold by them");
    expect(ask(base, 34)).toContain("between $35 and $140");
    expect(ask(base, 141)).toContain("between $35 and $140");
    expect(ask(base, 35)).toBeNull();
    expect(ask(base, 140)).toBeNull();
    expect(ask(base, 70.5)).toContain("whole number");
    expect(ask(operatingBoard({ corps: [{ id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", floated: false }] }))).toContain("has not floated");
    expect(ask(operatingBoard({ corps: [{ id: PRR, ticker: "PRR", president: null, trains: ["3"], treasury: "500" }] }))).toContain("no president");
    expect(ask(operatingBoard({ corps: [{ id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "99" }] }))).toContain("cannot pay $100");
  });

  it("a direct BuyPrivateCompany without consent refuses; the same-principal case still works", () => {
    const state = operatingBoard();
    // P1 presides over PRR but does not own the D&H: no offer, no consent.
    expect(ingress(state, P1, BUY_PRIVATE(PRR, DH, "100"))).toContain("has not agreed to sell");
    const refused = apply(state, BUY_PRIVATE(PRR, DH, "100"), P1);
    expect(differing(state, refused)).toEqual([]);
    // P1 owns the M&H and presides over PRR: one principal on both sides (#701), legal without an offer.
    const own = operatingBoard({ privates: [{ id: MH, owner: P1, cost: "110" }, { id: DH, owner: P2, cost: "70" }] });
    expect(ingress(own, P1, BUY_PRIVATE(PRR, MH, "110"))).toBeNull();
    const bought = apply(own, BUY_PRIVATE(PRR, MH, "110"), P1);
    expect(priv(bought, MH)).toMatchObject({ owner: null, owner_protocol_id: PRR });
    expect(treasury(bought, PRR)).toBe(390);
    expect(cash(bought, P1)).toBe(410);
    expect(moneyConservationBreach(own, bought)).toBeNull();
    // A stale payload cannot make a corporation-owned or somebody else's private the buyer's own.
    expect(ingress(own, P1, BUY_PRIVATE(PRR, DH, "100"))).toContain("has not agreed");
  });

  it("D. the answerer is the private's CURRENT owner, not the name the proposer wrote", () => {
    const state = operatingBoard();
    const offered = apply(state, PROPOSE_PRIVATE(DH, PRR, 100, P1), P1); // P1 names himself as owner
    expect(offered.private_purchase_offer?.owner).toBe(P2);
    // The proposer cannot answer his own offer.
    expect(ingress(offered, P1, ANSWER_PRIVATE(DH, true))).toContain("Only the private company's owner");
    expect(same(apply(offered, ANSWER_PRIVATE(DH, true), P1), offered)).toBe(true);
    // Nor a third party.
    expect(ingress(offered, P3, ANSWER_PRIVATE(DH, true))).toContain("Only the private company's owner");
    expect(same(apply(offered, ANSWER_PRIVATE(DH, true), P3), offered)).toBe(true);
    // If the card changed hands under the offer, the NEW owner answers and the recorded name cannot.
    const moved = { ...offered, private_companies: offered.private_companies.map((entry) => (entry.private_id === DH ? { ...entry, owner: P3 } : entry)) };
    expect(ingress(moved, P2, ANSWER_PRIVATE(DH, true))).toContain("Only the private company's owner");
    expect(same(apply(moved, ANSWER_PRIVATE(DH, true), P2), moved)).toBe(true);
    // ... but the new owner's acceptance is then refused at settlement because the offer's owner is stale
    // (the offer named P2; the board says P3) -- see G.
    expect(answerPrivatePurchaseRefusal(moved, { private_id: DH, accept: false }, P3)).toBeNull();
  });
});

/* ================================================================== */
/* C. The intercorporate train sale                                    */
/* ================================================================== */

describe("C. the voluntary intercorporate train sale has one authority (#1592)", () => {
  it("the legal transaction: proposal at Hardware by the buyer's president, acceptance by the seller's current president, one derived settlement from the treasury alone", () => {
    const state = operatingBoard();
    expect(proposeTrainPurchaseRefusal(state, { seller_protocol_id: NYC, buyer_protocol_id: PRR, model_type: "3", price: "150" }, P1, GRID)).toBeNull();
    const offered = apply(state, PROPOSE_TRAIN(NYC, PRR, "3", "150", P1), P1); // forged seller_president
    expect(offered.train_purchase_offer).toMatchObject({ seller_protocol_id: NYC, seller_president: P2, buyer_protocol_id: PRR, model_type: "3", price: "150" });
    expect(nextDerivedAction({ state: offered, mapGrid: GRID, emitted: new Set() })).toBeNull();
    expect(ingress(offered, P1, ANSWER_TRAIN(NYC, true))).toContain("selling corporation's president");
    expect(same(apply(offered, ANSWER_TRAIN(NYC, true), P1), offered)).toBe(true);
    const accepted = apply(offered, ANSWER_TRAIN(NYC, true), P2);
    expect(accepted.train_purchase_offer?.accepted).toBe(true);
    const owed = nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() });
    expect(owed?.msg).toEqual({ BuyTrainFromCorporation: { game_id: 0, buyer_protocol_id: PRR, seller_protocol_id: NYC, model_type: "3", price: "150" } });
    const settled = apply(accepted, owed!.msg, P2);
    expect(settled.train_purchase_offer).toBeNull();
    expect(company(settled, PRR).owned_trains).toEqual(["2", "3"]);
    expect(company(settled, NYC).owned_trains).toEqual(["2"]);
    expect(treasury(settled, PRR)).toBe(350);
    expect(treasury(settled, NYC)).toBe(550);
    expect(cash(settled, P1)).toBe(300); // the president's money never moves on the voluntary path
    expect(moneyConservationBreach(state, settled)).toBeNull();
    expect(nextDerivedAction({ state: settled, mapGrid: GRID, emitted: new Set() })).toBeNull();
  });

  it("the predicate's rules, one fact at a time, at proposal -- and the proposal itself is Hardware-only", () => {
    const ask = (state: GameStateResponse, price = "150", buyer = PRR, seller = NYC, model = "3") =>
      trainSaleRefusal(state, { buyerId: buyer, sellerId: seller, model, price }, P1, GRID, "proposal");
    const base = operatingBoard();
    expect(ask(base)).toBeNull();
    expect(ask(stockRoundBoard())).toContain("Operating Round");
    expect(ask(operatingBoard({ operating: NYC }))).toContain("NYC is operating, not PRR");
    expect(ask(operatingBoard({ step: "Track" }))).toContain("Purchase Trains step");
    expect(ask(operatingBoard({ step: "Routes" }))).toContain("Purchase Trains step");
    expect(ask(base, "150", PRR, PRR)).toContain("from itself");
    expect(ask(base, "150", PRR, NYC, "4")).toContain("does not own a 4-train");
    expect(ask(base, "0")).toContain("at least $1");
    expect(ask(base, "-5")).toContain("at least $1");
    expect(ask(base, "150.5")).toContain("whole number");
    expect(ask(base, "1")).toBeNull();
    expect(ask(base, "501")).toContain("cannot pay $501");
    expect(ask(base, "500")).toBeNull();
    // The limit in force (phase 3: four trains): a buyer already holding four may not buy a fifth.
    const full = operatingBoard({ corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2", "2", "2", "2"], treasury: "500" },
      { id: NYC, ticker: "NYC", president: P2, trains: ["3", "2"], treasury: "400", price: 90 },
    ] });
    expect(ask(full)).toContain("train limit");
    // The proposal at Track is refused at both locks, with the reason.
    const track = operatingBoard({ step: "Track" });
    expect(ingress(track, P1, PROPOSE_TRAIN(NYC, PRR, "3", "150"))).toContain("Purchase Trains step");
    expect(same(apply(track, PROPOSE_TRAIN(NYC, PRR, "3", "150"), P1), track)).toBe(true);
  });

  it("a direct BuyTrainFromCorporation without consent refuses -- and never for $0; the same-president case still works", () => {
    const state = operatingBoard();
    expect(ingress(state, P1, BUY_TRAIN(PRR, NYC, "3", "0"))).toContain("at least $1");
    expect(ingress(state, P1, BUY_TRAIN(PRR, NYC, "3", "150"))).toContain("has not agreed to sell");
    const refused = apply(state, BUY_TRAIN(PRR, NYC, "3", "150"), P1);
    expect(differing(state, refused)).toEqual([]);
    // P1 presides over both PRR and NYC: legal without an offer.
    const both = operatingBoard({ corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "500" },
      { id: NYC, ticker: "NYC", president: P1, trains: ["3", "2"], treasury: "400", price: 90 },
    ] });
    expect(ingress(both, P1, BUY_TRAIN(PRR, NYC, "3", "150"))).toBeNull();
    const done = apply(both, BUY_TRAIN(PRR, NYC, "3", "150"), P1);
    expect(company(done, PRR).owned_trains).toEqual(["2", "3"]);
    expect(treasury(done, PRR)).toBe(350);
    expect(treasury(done, NYC)).toBe(550);
    expect(moneyConservationBreach(both, done)).toBeNull();
  });
});

/* ================================================================== */
/* E / F. Rescission and the one global hold                            */
/* ================================================================== */

describe("E/F. rescission, rejection and the one global hold (#1590, #1594)", () => {
  const HELD: Array<[string, unknown, string]> = [
    ["PassTurn", PASS, P1],
    ["AdvanceOperatingSubPhase", ADVANCE(PRR), P1],
    ["another private offer", PROPOSE_PRIVATE(CA, PRR, 200), P1],
    ["a train offer", PROPOSE_TRAIN(NYC, PRR, "3", "150"), P1],
    ["a depot purchase", { BuyHardwareFromPool: { game_id: 1, protocol_id: PRR } }, P1],
    ["a direct private purchase of another card", BUY_PRIVATE(PRR, CA, "200"), P1],
    ["a stock sale", SELL_STOCK(NYC, 10), P1],
  ];

  it("a standing private offer freezes progression and every unrelated purchase, at both locks", () => {
    const offered = apply(operatingBoard(), PROPOSE_PRIVATE(DH, PRR, 100), P1);
    for (const [label, msg, actor] of HELD) {
      expect([label, ingress(offered, actor, msg)]).toEqual([label, expect.stringContaining("nothing else can happen")]);
      expect([label, same(apply(offered, msg, actor), offered)]).toEqual([label, true]);
    }
    // And a player <-> player trade cannot be proposed beside it either (one offer, of any kind).
    expect(proposePrivateTradeRefusal(offered, { private_id: CA, seller: P3, buyer: P1, price: 10 }, P1)).toContain("already standing");
    // The accepted-but-unsettled state holds too.
    const accepted = apply(offered, ANSWER_PRIVATE(DH, true), P2);
    expect(ingress(accepted, P1, PASS)).toContain("until it settles");
    expect(same(apply(accepted, PASS, P1), accepted)).toBe(true);
    expect(standingOrdinaryOffer(accepted)?.accepted).toBe(true);
  });

  it("a standing train offer blocks a second offer of another kind, and a trade offer blocks a stock purchase", () => {
    const train = apply(operatingBoard(), PROPOSE_TRAIN(NYC, PRR, "3", "150"), P1);
    expect(ingress(train, P1, PROPOSE_PRIVATE(DH, PRR, 100))).toContain("nothing else can happen");
    expect(same(apply(train, PROPOSE_PRIVATE(DH, PRR, 100), P1), train)).toBe(true);
    expect(ingress(train, P1, PASS)).toContain("nothing else can happen");
    const trade = apply(stockRoundBoard(), PROPOSE_TRADE(DH, P2, P1, 50), P1);
    expect(trade.private_trade_offer).not.toBeNull();
    expect(ingress(trade, P1, BUY_STOCK(PRR))).toContain("nothing else can happen");
    expect(same(apply(trade, BUY_STOCK(PRR), P1), trade)).toBe(true);
    expect(ingress(trade, P1, PASS)).toContain("nothing else can happen");
    expect(same(apply(trade, PASS, P1), trade)).toBe(true);
    // RevertTo and CloseRoom pass the hold (their own owners still apply).
    expect(pendingOfferBlock(trade, REVERT(0, P1) as never)).toBeNull();
    expect(pendingOfferBlock(trade, { CloseRoom: {} } as never)).toBeNull();
  });

  it("rescission clears the offer, moves nothing, advances nothing and releases the hold; only the buyer's current president may", () => {
    const state = operatingBoard();
    const offered = apply(state, PROPOSE_PRIVATE(DH, PRR, 100), P1);
    expect(ingress(offered, P2, RESCIND_PRIVATE(DH))).toContain("Only PRR's president");
    expect(same(apply(offered, RESCIND_PRIVATE(DH), P2), offered)).toBe(true);
    expect(ingress(offered, P1, RESCIND_PRIVATE(DH))).toBeNull();
    const withdrawn = apply(offered, RESCIND_PRIVATE(DH), P1);
    backToBefore(state, withdrawn, "private_purchase_offer"); // nothing else moved
    expect(pendingOfferBlock(withdrawn, PASS as never)).toBeNull();
    // A stale presidency: the buyer's NEW president withdraws; the old one cannot.
    const moved = { ...offered, public_companies: offered.public_companies.map((entry) => (entry.company_id === PRR ? { ...entry, president: P3 } : entry)) };
    expect(ingress(moved, P1, RESCIND_PRIVATE(DH))).toContain("Only PRR's president");
    expect(ingress(moved, P3, RESCIND_PRIVATE(DH))).toBeNull();
    // The train offer: the same.
    const train = apply(state, PROPOSE_TRAIN(NYC, PRR, "3", "150"), P1);
    expect(ingress(train, P2, RESCIND_TRAIN(NYC))).toContain("Only PRR's president");
    const trainWithdrawn = apply(train, RESCIND_TRAIN(NYC), P1);
    backToBefore(state, trainWithdrawn, "train_purchase_offer");
    // The chain-era rescission is NOT the withdrawal: refused on this pinned board (Q11).
    expect(ingress(train, P1, { RescindTrainOffer: { game_id: 1, offer_id: 0 } })).toContain("chain-era");
    expect(same(apply(train, { RescindTrainOffer: { game_id: 1, offer_id: 0 } }, P1), train)).toBe(true);
  });

  it("rejection clears the offer and releases the hold, moving nothing", () => {
    const state = operatingBoard();
    const offered = apply(state, PROPOSE_PRIVATE(DH, PRR, 100), P1);
    const rejected = apply(offered, ANSWER_PRIVATE(DH, false), P2);
    backToBefore(state, rejected, "private_purchase_offer");
    const train = apply(state, PROPOSE_TRAIN(NYC, PRR, "3", "150"), P1);
    const trainRejected = apply(train, ANSWER_TRAIN(NYC, false), P2);
    backToBefore(state, trainRejected, "train_purchase_offer");
    expect(ingress(trainRejected, P1, PASS)).toBeNull();
  });

  it("Q11: the chain-era offer messages are refused on a pinned board and left alone on a legacy one", () => {
    const pinned = operatingBoard();
    for (const msg of [{ AcceptTrainOffer: { game_id: 1, offer_id: 1 } }, { RejectTrainOffer: { game_id: 1, offer_id: 1 } }, { RescindTrainOffer: { game_id: 1, offer_id: 1 } }]) {
      expect(legacyOfferMessageRefusal(pinned, msg as never)).toContain("chain-era");
      expect(ingress(pinned, P1, msg)).toContain("chain-era");
      expect(same(apply(pinned, msg, P1), pinned)).toBe(true);
    }
    const legacy = { ...pinned, rules_engine_version: undefined };
    expect(legacyOfferMessageRefusal(legacy, { AcceptTrainOffer: { game_id: 1, offer_id: 1 } } as never)).toBeNull();
  });
});

/* ================================================================== */
/* G / K / L. Accepted offers, stale settlement, the settleOwed loop      */
/* ================================================================== */

describe("G. the accepted offer's derived settlement, and its retirement on a stale board (#1596)", () => {
  const accepted = () => apply(apply(operatingBoard(), PROPOSE_PRIVATE(DH, PRR, 100), P1), ANSWER_PRIVATE(DH, true), P2);
  const settlement = BUY_PRIVATE(PRR, DH, "100");

  it("a stale accepted private offer: settlement refuses, retires the offer, moves no asset and no money -- and only the offer field differs", () => {
    const cases: Array<[string, (state: GameStateResponse) => GameStateResponse]> = [
      ["the card changed hands", (s) => ({ ...s, private_companies: s.private_companies.map((e) => (e.private_id === DH ? { ...e, owner: P3 } : e)) })],
      ["the card is a corporation's", (s) => ({ ...s, private_companies: s.private_companies.map((e) => (e.private_id === DH ? { ...e, owner: null, owner_protocol_id: NYC } : e)) })],
      ["the card closed", (s) => ({ ...s, private_companies: s.private_companies.map((e) => (e.private_id === DH ? { ...e, closed: true } : e)) })],
      ["the treasury drained", (s) => ({ ...s, public_companies: s.public_companies.map((e) => (e.company_id === PRR ? { ...e, treasury: "50" } : e)) })],
      ["the turn moved on", (s) => ({ ...s, active_corporation_index: 1 })],
      ["the round moved on", (s) => ({ ...s, current_round_type: "StockRound" as const })],
      ["the phase moved on to 5", (s) => ({ ...s, public_companies: s.public_companies.map((e) => (e.company_id === CO ? { ...e, owned_trains: ["5"] } : e)) })],
    ];
    for (const [label, stale] of cases) {
      const before = stale(accepted());
      const after = apply(before, settlement, P2);
      expect([label, differing(before, after)]).toEqual([label, ["private_purchase_offer"]]);
      expect([label, after.private_purchase_offer]).toEqual([label, null]);
      expect([label, priv(after, DH).owner_protocol_id]).toEqual([label, priv(before, DH).owner_protocol_id]);
      expect([label, moneyTotal(after), treasury(after, PRR)]).toEqual([label, moneyTotal(before), treasury(before, PRR)]);
      // Retired means not owed: nothing is derived from the retired board.
      expect([label, nextDerivedAction({ state: after, mapGrid: GRID, emitted: new Set() })]).toEqual([label, null]);
    }
    // The control: the unchanged accepted board settles.
    const settled = apply(accepted(), settlement, P2);
    expect(priv(settled, DH).owner_protocol_id).toBe(PRR);
  });

  it("a stale accepted train offer: the same, including the D-6 path that Batch 5 already pinned", () => {
    const acceptedTrain = apply(apply(operatingBoard(), PROPOSE_TRAIN(NYC, PRR, "3", "150"), P1), ANSWER_TRAIN(NYC, true), P2);
    const gone = { ...acceptedTrain, public_companies: acceptedTrain.public_companies.map((e) => (e.company_id === NYC ? { ...e, owned_trains: ["2"] } : e)) };
    const after = apply(gone, BUY_TRAIN(PRR, NYC, "3", "150"), P2);
    expect(differing(gone, after)).toEqual(["train_purchase_offer"]);
    expect(after.train_purchase_offer).toBeNull();
    expect(company(after, PRR).owned_trains).toEqual(["2"]);
    expect(moneyConservationBreach(gone, after)).toBeNull();
    expect(nextDerivedAction({ state: after, mapGrid: GRID, emitted: new Set() })).toBeNull();
  });

  it("an acceptance on a board that went stale is refused at the answer, leaving the offer standing for a rescind", () => {
    const offered = apply(operatingBoard(), PROPOSE_PRIVATE(DH, PRR, 100), P1);
    const drained = { ...offered, public_companies: offered.public_companies.map((e) => (e.company_id === PRR ? { ...e, treasury: "50" } : e)) };
    expect(ingress(drained, P2, ANSWER_PRIVATE(DH, true))).toContain("cannot pay $100");
    expect(same(apply(drained, ANSWER_PRIVATE(DH, true), P2), drained)).toBe(true);
    expect(drained.private_purchase_offer?.accepted).toBeUndefined();
    expect(ingress(drained, P2, ANSWER_PRIVATE(DH, false))).toBeNull(); // a rejection needs no board
    expect(ingress(drained, P1, RESCIND_PRIVATE(DH))).toBeNull();
    const trainOffered = apply(operatingBoard(), PROPOSE_TRAIN(NYC, PRR, "3", "150"), P1);
    const noTrain = { ...trainOffered, public_companies: trainOffered.public_companies.map((e) => (e.company_id === NYC ? { ...e, owned_trains: ["2"] } : e)) };
    expect(answerTrainPurchaseRefusal(noTrain, { seller_protocol_id: NYC, accept: true }, P2, GRID)).toContain("does not own a 3-train");
    expect(same(apply(noTrain, ANSWER_TRAIN(NYC, true), P2), noTrain)).toBe(true);
  });

  it("settleOwed: one settlement per acceptance through a room, never two, and a stale accepted offer is repaired once and never re-owed", () => {
    const providers = () => ({ ...sandboxReplayProviders(), initialGrid: GRID });
    const room = new RoomSession({ providers: providers(), seed: { state: operatingBoard(), waterfall: null }, build: "b", mintId: () => `m${Math.random()}` });
    const submit = (actor: string, msg: unknown) => room.submit({ actor, build: "b", msg: msg as never, baseIndex: room.nextIndex - 1 });
    expect(submit(P1, PROPOSE_PRIVATE(DH, PRR, 100)).kind).toBe("applied");
    expect(submit(P1, PASS).kind).toBe("refused"); // the hold, at ingress
    const answered = submit(P2, ANSWER_PRIVATE(DH, true));
    expect(answered.kind).toBe("applied");
    const derived = (answered as { entries: ServerLogEntry[] }).entries.filter((entry) => entry.derived);
    expect(derived.map((entry) => Object.keys(JSON.parse(entry.payload))[0])).toEqual(["BuyPrivateCompany"]);
    expect(room.state.private_purchase_offer).toBeNull();
    expect(priv(room.state, DH).owner_protocol_id).toBe(PRR);
    expect(treasury(room.state, PRR)).toBe(400);
    expect(cash(room.state, P2)).toBe(400);
    // Nothing more is owed on the next look, and the turn can end.
    expect(submit(P1, PASS).kind).toBe("applied");
    expect(room.entries.filter((entry) => (entry as ServerLogEntry).derived && JSON.parse((entry as ServerLogEntry).payload).BuyPrivateCompany).length).toBe(1);
    // A restore replays exactly one settlement.
    const restored = new RoomSession({ providers: providers(), seed: { state: operatingBoard(), waterfall: null }, build: "b", mintId: () => "x" });
    restored.restore(room.entries as ServerLogEntry[]);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));

    // A room whose seed already carries an ACCEPTED offer on a stale board: the first submit repairs it --
    // one derived settlement, refused and retired -- and neither the second submit nor a rebuild owes it again.
    const stale = { ...accepted(), private_companies: accepted().private_companies.map((e) => (e.private_id === DH ? { ...e, owner: P3 } : e)) };
    const staleRoom = new RoomSession({ providers: providers(), seed: { state: stale, waterfall: null }, build: "b", mintId: () => `s${Math.random()}` });
    const first = staleRoom.submit({ actor: P1, build: "b", msg: PASS as never, baseIndex: staleRoom.nextIndex - 1 });
    expect(first.kind).toBe("applied");
    const repairs = (first as { entries: ServerLogEntry[] }).entries.filter((entry) => entry.derived);
    expect(repairs.length).toBe(1);
    expect(staleRoom.state.private_purchase_offer).toBeNull();
    expect(priv(staleRoom.state, DH).owner).toBe(P3);
    expect(moneyTotal(staleRoom.state)).toBe(moneyTotal(stale));
    expect(treasury(staleRoom.state, PRR)).toBe(500);
    const second = staleRoom.submit({ actor: P1, build: "b", msg: ADVANCE(PRR) as never, baseIndex: staleRoom.nextIndex - 1 });
    expect((second as { entries?: ServerLogEntry[] }).entries?.filter((entry) => entry.derived && JSON.parse(entry.payload).BuyPrivateCompany) ?? []).toEqual([]);
    const rebuilt = new RoomSession({ providers: providers(), seed: { state: stale, waterfall: null }, build: "b", mintId: () => "y" });
    rebuilt.restore(staleRoom.entries as ServerLogEntry[]);
    expect(stateDigest(rebuilt.state)).toBe(stateDigest(staleRoom.state));
    expect(rebuilt.state.private_purchase_offer).toBeNull();
  });

  it("the engine's own loop cannot spin: an accepted offer whose settlement is refused by any gate is derived once and retired", () => {
    const engine = new RoomEngine({ ...sandboxReplayProviders(), initialGrid: GRID }, { state: accepted(), waterfall: null });
    // Make the board stale by hand: PRR is no longer operating.
    (engine as unknown as { state: GameStateResponse }).state = { ...engine.snapshot.state, active_corporation_index: 1 };
    let minted = 0;
    const derived = engine.settleOwed((msg, reason) => {
      minted += 1;
      return { index: minted, id: `d${minted}`, actor: P2, payload: JSON.stringify(msg), derived: true, reason } as never;
    });
    expect(derived.length).toBe(1);
    expect(engine.snapshot.state.private_purchase_offer).toBeNull();
    expect(engine.settleOwed(() => { throw new Error("nothing should be minted"); })).toEqual([]);
  });
});

/* ================================================================== */
/* RevertTo                                                            */
/* ================================================================== */

describe("RevertTo reconstructs the offer state from the log (#1590 / #1247)", () => {
  const entry = (index: number, actor: string, msg: unknown, derived = false) =>
    ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg), ...(derived ? { derived: true } : {}) });
  const seed = () => ({ state: operatingBoard(), waterfall: null });
  const providers = () => ({ ...sandboxReplayProviders(), initialGrid: GRID });

  it("revert to before the proposal: no offer; revert between proposal and answer: the pending offer and its hold; through acceptance: exactly one settlement", () => {
    const none = replayLog([entry(0, P1, PROPOSE_PRIVATE(DH, PRR, 100)), entry(1, P1, REVERT(0, P1))], providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(none.state.private_purchase_offer ?? null).toBeNull();
    expect(pendingOfferBlock(none.state, PASS as never)).toBeNull();

    const pending = replayLog(
      [entry(0, P1, PROPOSE_PRIVATE(DH, PRR, 100)), entry(1, P2, ANSWER_PRIVATE(DH, true)), entry(2, P2, BUY_PRIVATE(PRR, DH, "100"), true), entry(3, P1, REVERT(1, P1))],
      providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY,
    );
    expect(pending.state.private_purchase_offer).toMatchObject({ private_id: DH, owner: P2, buyer_protocol_id: PRR, price: 100 });
    expect(pending.state.private_purchase_offer?.accepted).toBeUndefined();
    expect(priv(pending.state, DH).owner).toBe(P2);
    expect(treasury(pending.state, PRR)).toBe(500);
    expect(pendingOfferBlock(pending.state, PASS as never)).toContain("nothing else can happen");

    const through = replayLog(
      [entry(0, P1, PROPOSE_PRIVATE(DH, PRR, 100)), entry(1, P2, ANSWER_PRIVATE(DH, true)), entry(2, P2, BUY_PRIVATE(PRR, DH, "100"), true)],
      providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY,
    );
    expect(through.applied).toBe(3);
    expect(priv(through.state, DH).owner_protocol_id).toBe(PRR);
    expect(treasury(through.state, PRR)).toBe(400);
    expect(cash(through.state, P2)).toBe(400);
    expect(through.state.private_purchase_offer).toBeNull();
    expect(moneyConservationBreach(seed().state, through.state)).toBeNull();
  });

  it("the trade: revert past the acceptance restores the seller's card and cash, and the pending offer", () => {
    const sr = () => ({ state: stockRoundBoard(), waterfall: null });
    const settled = replayLog([entry(0, P1, PROPOSE_TRADE(DH, P2, P1, 50)), entry(1, P2, ANSWER_TRADE(DH, true))], providers(), sr(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(priv(settled.state, DH).owner).toBe(P1);
    expect(cash(settled.state, P2)).toBe(350);
    const undone = replayLog([entry(0, P1, PROPOSE_TRADE(DH, P2, P1, 50)), entry(1, P2, ANSWER_TRADE(DH, true)), entry(2, P1, REVERT(1, P1))], providers(), sr(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(priv(undone.state, DH).owner).toBe(P2);
    expect(cash(undone.state, P2)).toBe(300);
    expect(undone.state.private_trade_offer).toMatchObject({ private_id: DH, seller: P2, buyer: P1, price: 50, proposer: P1 });
    expect(undone.state.turn_action_taken ?? false).toBe(false);
  });
});

/* ================================================================== */
/* H / I / J. The player <-> player trade                               */
/* ================================================================== */

describe("H. the player <-> player private-company trade (#1593, ruled Q12)", () => {
  it("buyer-turn proposal, seller accepts: buyer -> seller payment and ownership, exactly once", () => {
    const state = stockRoundBoard(); // P1 seated; the D&H is P2's
    expect(ingress(state, P1, PROPOSE_TRADE(DH, P2, P1, 50))).toBeNull();
    const offered = apply(state, PROPOSE_TRADE(DH, P2, P1, 50), P1);
    expect(offered.private_trade_offer).toEqual({ private_id: DH, private_name: "Delaware & Hudson", seller: P2, buyer: P1, price: 50, proposer: P1, instance: 1 }); // #1597
    expect(ingress(offered, P1, ANSWER_TRADE(DH, true))).toContain("only the other party");
    expect(ingress(offered, P3, ANSWER_TRADE(DH, true))).toContain("Only the other party");
    expect(same(apply(offered, ANSWER_TRADE(DH, true), P3), offered)).toBe(true);
    expect(ingress(offered, P2, ANSWER_TRADE(DH, true))).toBeNull();
    const settled = apply(offered, ANSWER_TRADE(DH, true), P2);
    expect(settled.private_trade_offer).toBeNull();
    expect(priv(settled, DH)).toMatchObject({ owner: P1, owner_protocol_id: null });
    expect(cash(settled, P1)).toBe(250);
    expect(cash(settled, P2)).toBe(350);
    expect(moneyConservationBreach(state, settled)).toBeNull();
    // Exactly once: a second answer finds nothing.
    expect(same(apply(settled, ANSWER_TRADE(DH, true), P2), settled)).toBe(true);
  });

  it("seller-turn proposal, buyer accepts: the same", () => {
    const state = stockRoundBoard({ seat: 1 }); // P2 seated, sells the D&H to P1
    const offered = apply(state, PROPOSE_TRADE(DH, P2, P1, 80), P2);
    expect(offered.private_trade_offer?.proposer).toBe(P2);
    expect(ingress(offered, P2, ANSWER_TRADE(DH, true))).toContain("only the other party");
    const settled = apply(offered, ANSWER_TRADE(DH, true), P1);
    expect(priv(settled, DH).owner).toBe(P1);
    expect(cash(settled, P1)).toBe(220);
    expect(cash(settled, P2)).toBe(380);
    expect(moneyConservationBreach(state, settled)).toBeNull();
  });

  it("the predicate's rules: SR1, the wrong round, the wrong seat, the parties, the card, the price, the cash", () => {
    const ask = (state: GameStateResponse, over: Partial<{ privateId: number; seller: string; buyer: string; price: number }> = {}) =>
      privateTradeRefusal(state, { privateId: DH, seller: P2, buyer: P1, price: 50, ...over });
    expect(ask(stockRoundBoard())).toBeNull();
    expect(ask(stockRoundBoard({ macro: 1 }))).toContain("first Stock Round");
    expect(ask(operatingBoard())).toContain("only during a Stock Round");
    expect(ask(stockRoundBoard({ seat: 2 }))).toContain("buyer's or the seller's own Stock Round turn");
    expect(ask(stockRoundBoard({ seat: 1 }), { buyer: P2 })).toContain("with themselves");
    expect(ask(stockRoundBoard(), { buyer: "p9", seller: P1 })).toContain("buyer is not seated");
    expect(ask(stockRoundBoard(), { seller: P3 })).toContain("not p3's to sell");
    expect(ask(stockRoundBoard({ privates: [{ id: DH, owner: P2, cost: "70", closed: true }] }))).toContain("has closed");
    expect(ask(stockRoundBoard({ privates: [{ id: DH, owner: null, ownerCorp: NYC, cost: "70" }] }))).toContain("not p2's to sell");
    expect(ask(stockRoundBoard(), { price: -1 })).toContain("$0 or more");
    expect(ask(stockRoundBoard(), { price: 10.5 })).toContain("whole number");
    expect(ask(stockRoundBoard(), { price: 0 })).toBeNull(); // a gift is legal
    expect(ask(stockRoundBoard(), { price: 300 })).toBeNull();
    expect(ask(stockRoundBoard(), { price: 301 })).toContain("cannot pay $301");
    // No corporation band: $1 for a $70 card and $1000 (with the cash) are both legal.
    expect(ask(stockRoundBoard(), { price: 1 })).toBeNull();
    expect(ask(stockRoundBoard({ cash: { [P1]: 1000, [P2]: 300, [P3]: 300 } }), { price: 1000 })).toBeNull();
  });

  it("a $0 trade settles as a transfer of nothing; a non-turn party cannot initiate; a third party cannot answer; the proposer alone rescinds", () => {
    const state = stockRoundBoard();
    const gift = apply(apply(state, PROPOSE_TRADE(DH, P2, P1, 0), P1), ANSWER_TRADE(DH, true), P2);
    expect(priv(gift, DH).owner).toBe(P1);
    expect(cash(gift, P1)).toBe(300);
    expect(cash(gift, P2)).toBe(300);
    // P2 is a party but not the seat holder (P1 is): P2 cannot initiate now.
    expect(ingress(state, P2, PROPOSE_TRADE(DH, P2, P1, 50))).toContain("own Stock Round turn");
    expect(same(apply(state, PROPOSE_TRADE(DH, P2, P1, 50), P2), state)).toBe(true);
    // P3 holds the seat on a P3 board but is neither party.
    const p3 = stockRoundBoard({ seat: 2 });
    expect(ingress(p3, P3, PROPOSE_TRADE(DH, P2, P1, 50))).toContain("Only the buyer or the seller");
    expect(same(apply(p3, PROPOSE_TRADE(DH, P2, P1, 50), P3), p3)).toBe(true);
    // Rescission: the proposer only; it clears the offer and nothing else.
    const offered = apply(state, PROPOSE_TRADE(DH, P2, P1, 50), P1);
    expect(ingress(offered, P2, RESCIND_TRADE(DH))).toContain("Only the player who made this offer");
    expect(same(apply(offered, RESCIND_TRADE(DH), P2), offered)).toBe(true);
    const withdrawn = apply(offered, RESCIND_TRADE(DH), P1);
    backToBefore(state, withdrawn, "private_trade_offer");
    // Rejection: the counterparty; nothing moves, no Stock Round marker is written.
    const rejected = apply(offered, ANSWER_TRADE(DH, false), P2);
    backToBefore(state, rejected, "private_trade_offer");
  });

  it("the certificate limit blocks a buyer at the limit and not one below it, at proposal, at answer and at settlement", () => {
    /* Three players: the limit is 20. P1 holds 100% of PRR and 100% of NYC (9 cards each: the president's
       20% is one card) plus the M&H: 19 counted. One more private is the 20th and legal; with the C&SL too
       (20 counted) the D&H would be the 21st. */
    const near = stockRoundBoard({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 100]] },
        { id: NYC, ticker: "NYC", president: P1, trains: ["2"], treasury: "400", price: 90, holdings: [[P1, 100]] },
      ],
      privates: [{ id: DH, owner: P2, cost: "70" }, { id: MH, owner: P1, cost: "110" }],
    });
    expect(certificateBreakdown(P1, near).counted).toBe(19);
    expect(privateTradeRefusal(near, { privateId: DH, seller: P2, buyer: P1, price: 50 })).toBeNull();
    const atLimit = { ...near, private_companies: [...near.private_companies, { private_id: F.CSL, name: "C&SL", cost: "40", revenue_per_or: "10", owner: P1, owner_protocol_id: null, closed: false }] };
    expect(certificateBreakdown(P1, atLimit).counted).toBe(20);
    expect(privateTradeRefusal(atLimit, { privateId: DH, seller: P2, buyer: P1, price: 50 })).toContain("20 of 20 certificates");
    expect(ingress(atLimit, P1, PROPOSE_TRADE(DH, P2, P1, 50))).toContain("20 of 20 certificates");
    expect(same(apply(atLimit, PROPOSE_TRADE(DH, P2, P1, 50), P1), atLimit)).toBe(true);
    // Legal when proposed, at the limit by the answer (the fixture mutates holdings, as Batch 5's did): the
    // answer is refused, nothing moves, the offer stands.
    const offered = apply(near, PROPOSE_TRADE(DH, P2, P1, 50), P1);
    const filled = { ...offered, private_companies: [...offered.private_companies, { private_id: F.CSL, name: "C&SL", cost: "40", revenue_per_or: "10", owner: P1, owner_protocol_id: null, closed: false }] };
    expect(ingress(filled, P2, ANSWER_TRADE(DH, true))).toContain("20 of 20 certificates");
    const refused = apply(filled, ANSWER_TRADE(DH, true), P2);
    expect(same(refused, filled)).toBe(true);
    expect(refused.private_trade_offer).not.toBeNull();
    // The seller's count falls by one on settlement.
    const settled = apply(offered, ANSWER_TRADE(DH, true), P2);
    expect(certificateBreakdown(P2, settled).counted).toBe(certificateBreakdown(P2, near).counted - 1);
    expect(certificateBreakdown(P1, settled).counted).toBe(20);
  });

  it("I. N1: the card and its unexercised powers travel; vested benefits stay; the BO private is saleable player -> player", () => {
    const state = stockRoundBoard({
      privates: [{ id: MH, owner: P2, cost: "110" }, { id: DH, owner: P2, cost: "70" }, { id: BO, owner: P2, cost: "220" }, { id: CA, owner: P2, cost: "160" }],
      over: { used_private_abilities: ["dh-token"] },
    });
    // The M&H exchange follows the M&H: only its new owner may exchange it afterwards.
    const mh = apply(apply(state, PROPOSE_TRADE(MH, P2, P1, 100), P1), ANSWER_TRADE(MH, true), P2);
    const exchange = (player: string) => ({ ExchangePrivate: { game_id: 1, private_id: MH, company_id: NYC, player, source: "Ipo" } });
    expect(ingress(mh, P1, exchange(P1))).toBeNull();
    expect(ingress(mh, P2, exchange(P2))).toContain("owner can exchange it");
    // The D&H's used station stays used after the D&H changes hands.
    const dh = apply(apply(state, PROPOSE_TRADE(DH, P2, P1, 50), P1), ANSWER_TRADE(DH, true), P2);
    expect(dh.used_private_abilities).toEqual(["dh-token"]);
    expect(priv(dh, DH).owner).toBe(P1);
    // The C&A's PRR share was granted at the auction and lives in the holdings: selling the C&A issues nothing.
    const ca = apply(apply(state, PROPOSE_TRADE(CA, P2, P1, 100), P1), ANSWER_TRADE(CA, true), P2);
    expect(company(ca, PRR).player_holdings).toEqual(company(state, PRR).player_holdings);
    expect(company(ca, PRR).ipo_pool_percentage).toBe(company(state, PRR).ipo_pool_percentage);
    // The BO private may be traded player -> player; no certificate moves and no par is re-owed.
    const bo = apply(apply(state, PROPOSE_TRADE(BO, P2, P1, 200), P1), ANSWER_TRADE(BO, true), P2);
    expect(priv(bo, BO).owner).toBe(P1);
    expect(bo.public_companies).toEqual(state.public_companies);
    // (the B&O corporation is not on this board, so nothing can be parred; the refusal is the same before and after)
    expect(boPresidencyRefusal(bo, "B&O")).toEqual(boPresidencyRefusal(state, "B&O"));
    // ... but it is still not saleable to a corporation (its ban is the corporation's).
    const or = operatingBoard({ privates: [{ id: BO, owner: P2, cost: "220" }] });
    expect(privatePurchaseRefusal(or, { buyerId: PRR, privateId: BO, price: 220 }, P1, "proposal")).toContain("may never be sold to a corporation");
  });

  it("J. N2: a settled trade is the seat's transaction -- not a pass, the seat is the latest trader, no purchase is consumed, no cursor moves", () => {
    const state = stockRoundBoard({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]], ipo: 50 },
        { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, holdings: [[P2, 30], [P3, 10]] },
      ],
      over: { consecutive_passes: 2, last_trader_index: 2, bought_this_turn: 0 },
    });
    const before = { ...state };
    const settled = apply(apply(state, PROPOSE_TRADE(DH, P2, P1, 50), P1), ANSWER_TRADE(DH, true), P2);
    expect(settled.turn_action_taken).toBe(true);
    expect(settled.consecutive_passes).toBe(0);
    expect(settled.last_trader_index).toBe(0); // P1's seat, not the answerer's
    expect(settled.bought_this_turn ?? 0).toBe(0);
    expect(settled.bought_this_turn_company).toBeUndefined();
    expect(settled.active_player_index).toBe(0); // the acceptance is not a turn
    expect(settled.stock_turn_stage).toBe(before.stock_turn_stage);
    // End Turn afterwards advances the seat as an action taken, not as a pass.
    const ended = apply(settled, PASS, P1);
    expect(ended.active_player_index).toBe(1);
    expect(ended.consecutive_passes).toBe(0);
    expect(ended.stock_round_just_ended ?? false).toBe(false);
    // And the seller-turn shape marks the SELLER's seat as the trader.
    const sellerTurn = stockRoundBoard({ seat: 1, over: { last_trader_index: 0 } });
    const sold = apply(apply(sellerTurn, PROPOSE_TRADE(DH, P2, P1, 50), P2), ANSWER_TRADE(DH, true), P1);
    expect(sold.last_trader_index).toBe(1);
    expect(sold.active_player_index).toBe(1);
    // A rejected offer writes none of the markers.
    const rejected = apply(apply(state, PROPOSE_TRADE(DH, P2, P1, 50), P1), ANSWER_TRADE(DH, false), P2);
    expect(rejected.turn_action_taken ?? false).toBe(false);
    expect(rejected.consecutive_passes).toBe(2);
    expect(rejected.last_trader_index).toBe(2);
    // The trade does not consume the one stock purchase: P1 may still buy after it (the hold is released).
    expect(ingress(settled, P1, BUY_STOCK(PRR))).toBeNull();
  });
});

/* ================================================================== */
/* A. Batch-5 D-5 / D-6 through the offer machinery                     */
/* ================================================================== */

describe("A. the Batch-5 paths keep their semantics beside the ordinary ones", () => {
  it("the funding offer and an ordinary offer are exclusive: neither can be proposed beside the other", () => {
    const fundingOffer = { private_id: DH, private_name: "Delaware & Hudson", owner: P2, buyer_protocol_id: PRR, buyer_ticker: "PRR", price: 100, funding: true as const };
    const withFunding = { ...operatingBoard(), private_purchase_offer: fundingOffer } as GameStateResponse;
    expect(standingOrdinaryOffer(withFunding)).toBeNull(); // the hold never reads it as ordinary
    expect(proposePrivatePurchaseRefusal(withFunding, { private_id: CA, buyer_protocol_id: PRR, price: 200 }, P1)).toContain("already standing");
    expect(proposeTrainPurchaseRefusal(withFunding, { seller_protocol_id: NYC, buyer_protocol_id: PRR, model_type: "3", price: "150" }, P1, GRID)).toContain("already standing");
    // The ordinary answer arm does not settle a funding offer (#1541), and the derived loop never derives it.
    expect(same(apply(withFunding, ANSWER_PRIVATE(DH, true), P2), withFunding)).toBe(true);
    expect(nextDerivedAction({ state: { ...withFunding, private_purchase_offer: { ...fundingOffer, accepted: true } } as GameStateResponse, mapGrid: GRID, emitted: new Set() })).toBeNull();
  });
});

/* ================================================================== */
/* M. Schema                                                           */
/* ================================================================== */

describe("M. the five new messages are in the schema (44 -> 49) and nothing else changed", () => {
  it("validates the new shapes and refuses the malformed", () => {
    expect(GAMEPLAY_MESSAGE_KINDS.length).toBe(49);
    for (const msg of [RESCIND_PRIVATE(3), RESCIND_TRAIN(2), PROPOSE_TRADE(3, P2, P1, 0), ANSWER_TRADE(3, true), RESCIND_TRADE(3)]) {
      expect(validateGameplayMessage(msg)).toMatchObject({ ok: true });
    }
    expect(validateGameplayMessage({ ProposePrivateTrade: { private_id: 3, seller: P2, buyer: P1, price: 1.5 } })).toMatchObject({ ok: false });
    expect(validateGameplayMessage({ ProposePrivateTrade: { private_id: 3, seller: P2, price: 1 } })).toMatchObject({ ok: false });
    expect(validateGameplayMessage({ AnswerPrivateTrade: { private_id: 3 } })).toMatchObject({ ok: false });
    expect(validateGameplayMessage({ RescindTrainPurchase: { seller_protocol_id: "2" } })).toMatchObject({ ok: false });
  });
});
