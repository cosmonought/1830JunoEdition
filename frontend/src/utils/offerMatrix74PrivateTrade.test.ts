/** @jest-environment node */
//
// ==================================================================
//  BATCH 7.4 EXHAUSTIVE MATRIX (3/6): THE PLAYER <-> PLAYER PRIVATE-COMPANY TRADE, D-26 AND D-27
// ==================================================================
//
// `privateTradeRefusal` (#1593) and its three consent predicates, one fact at a time on a legal Stock Round board,
// both locks, no mutation on refusal (review brief §5). Then what travels with the card, asked of the surfaces the
// game actually consults later -- the exchange resolver and its ingress owner, the Stock Round exchange chip, the
// private revenue payout, the corporate power readers after a later corporate purchase, the JK licence grant, the
// B&O par refusal (§6, D-26); and the Stock Round's bookkeeping through End Turn to the Priority Deal (§7, D-27).
// The trade half of §10: the two parties ARE the transaction, so the board re-derives whether it is still legal,
// not who else might answer.

export {};

const { privateTradeRefusal, proposePrivateTradeRefusal, answerPrivateTradeRefusal, rescindPrivateTradeRefusal } =
  require("../gameEngine/privateTradeAuthority") as typeof import("../gameEngine/privateTradeAuthority");
const { privatePriceBounds } = require("../gameEngine/privatePriceBand") as typeof import("../gameEngine/privatePriceBand");
const { certificateBreakdown } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const { moneyTotal, moneyConservationBreach } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { resolvePrivateExchange } = require("../gameEngine/privateExchange") as typeof import("../gameEngine/privateExchange");
const { applyPrivateRevenue, boPresidencyRefusal } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { currentPrivateOwner } = require("../gameEngine/privatePurchaseAuthority") as typeof import("../gameEngine/privatePurchaseAuthority");
const { dhFreeStationAvailableFor, DH_PRIVATE_ID } = require("../gameEngine/dhPower") as typeof import("../gameEngine/dhPower");
const { privateHexFor } = require("../gameEngine/privateReservations") as typeof import("../gameEngine/privateReservations");
const { jkTileRefusal, JK_TILE_REFUSALS } = require("../gameEngine/kanawhaLicense") as typeof import("../gameEngine/kanawhaLicense");
const { JK_PRIVATE_ID } = require("../gameEngine/levelPlayingField") as typeof import("../gameEngine/levelPlayingField");
const { stockRoundExchangeOffers, ownsPrivateByCorporation } = require("./activePrivatePower") as typeof import("./activePrivatePower");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const { P1, P2, P3, PRR, NYC, CSL, DH, MH, CA, BO, board, operatingBoard, stockRoundBoard } = F;
const { apply, ingress, same, differing, withPriv, withState, withCash, corp, priv, cash, guarded, M } = S;

const PRICE = "The price must be a whole number of dollars ($0 or more).";
const OWN_TURN = "A private-company trade is proposed on your own Stock Round turn.";
const PARTY = "Only the buyer or the seller can propose a private-company trade.";

const base = () => stockRoundBoard(); // SR 2, P1 seated; D&H ($70) is P2's, M&H ($110) is P1's; $300 each

/** The certificate-limit board: three players (limit 20); P1 holds all of PRR and NYC (9 cards each) and the M&H: 19. */
const nearLimit = () =>
  stockRoundBoard({
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 100]] },
      { id: NYC, ticker: "NYC", president: P1, trains: ["2"], treasury: "400", price: 90, holdings: [[P1, 100]] },
    ],
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: MH, owner: P1, cost: "110" },
    ],
  });
const atLimit = () =>
  withState(nearLimit(), {
    private_companies: [...nearLimit().private_companies, { private_id: CSL, name: "Champlain & St. Lawrence", cost: "40", revenue_per_or: "10", owner: P1, owner_protocol_id: null, closed: false }],
  });

/* ================================================================== */
/* §5 controls                                                          */
/* ================================================================== */

describe("§5 controls: both turn shapes through a room, and the prices no corporation could pay", () => {
  it("buyer's turn: the buyer proposes, the seller accepts off-turn, and the answer settles it -- buyer -> seller once", () => {
    const seed = base();
    const { room, submit, kinds, logged } = S.roomFor(seed);
    expect(kinds(submit(P1, M.proposeTrade(DH, P2, P1, 50)))).toEqual(["ProposePrivateTrade"]);
    expect(room.state.private_trade_offer).toEqual({ private_id: DH, private_name: "Delaware & Hudson", seller: P2, buyer: P1, price: 50, proposer: P1, instance: 1 }); // #1597
    expect(submit(P1, M.pass).kind).toBe("refused");
    expect(kinds(submit(P2, M.answerTrade(DH, true)))).toEqual(["AnswerPrivateTrade"]); // no derived entry: the answer IS the settlement
    expect(room.state.private_trade_offer).toBeNull();
    expect(priv(room.state, DH)).toMatchObject({ owner: P1, owner_protocol_id: null });
    expect([cash(room.state, P1), cash(room.state, P2), cash(room.state, P3)]).toEqual([250, 350, 300]);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
    expect(logged("AnswerPrivateTrade")).toHaveLength(1);
    // A duplicate answer finds nothing: at ingress it is harmless (#662), in the reducer a no-op.
    expect(ingress(room.state, P2, M.answerTrade(DH, true))).toBeNull();
    expect(same(apply(room.state, M.answerTrade(DH, true), P2), room.state)).toBe(true);
  });

  it("seller's turn: the seller proposes, the buyer accepts off-turn", () => {
    const seed = stockRoundBoard({ seat: 1 });
    const { room, submit, kinds } = S.roomFor(seed);
    expect(kinds(submit(P2, M.proposeTrade(DH, P2, P1, 80)))).toEqual(["ProposePrivateTrade"]);
    expect(room.state.private_trade_offer?.proposer).toBe(P2);
    expect(submit(P2, M.answerTrade(DH, true)).kind).toBe("refused");
    expect(kinds(submit(P1, M.answerTrade(DH, true)))).toEqual(["AnswerPrivateTrade"]);
    expect(priv(room.state, DH).owner).toBe(P1);
    expect([cash(room.state, P1), cash(room.state, P2)]).toEqual([220, 380]);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
  });

  const PRICES: Array<[string, number, number]> = [
    ["a $0 gift", 0, 300],
    ["$1, far below half the $70 face", 1, 300],
    ["$34, one dollar below the corporation band's floor", 34, 300],
    ["$141, one dollar above the corporation band's ceiling", 141, 300],
    ["$1000, far above twice face (with the cash)", 1000, 1000],
  ];
  for (const [label, price, buyerCash] of PRICES) {
    it(`legal at any mutually agreed price -- no half-to-twice band: ${label}`, () => {
      const seed = withCash(base(), P1, buyerCash);
      const { min, max } = privatePriceBounds(70);
      expect([min, max]).toEqual([35, 140]); // the band a corporation would face for this card
      expect(privateTradeRefusal(seed, { privateId: DH, seller: P2, buyer: P1, price })).toBeNull();
      expect(ingress(seed, P1, M.proposeTrade(DH, P2, P1, price))).toBeNull();
      const settled = apply(apply(seed, M.proposeTrade(DH, P2, P1, price), P1), M.answerTrade(DH, true), P2);
      expect(priv(settled, DH).owner).toBe(P1);
      expect(cash(settled, P1)).toBe(buyerCash - price);
      expect(cash(settled, P2)).toBe(300 + price);
      expect(moneyConservationBreach(seed, settled)).toBeNull();
    });
  }
});

/* ================================================================== */
/* §5 the proposal matrix                                              */
/* ================================================================== */

interface TradeRow {
  label: string;
  board: () => GameStateResponse;
  privateId?: number;
  seller?: string;
  buyer?: string;
  price?: number;
  actor?: string;
  refusal: string | null;
  /** The predicate's own sentence, where the proposal's actor rules fire first. */
  predicate?: string | null;
}

const TRADE_ROWS: TradeRow[] = [
  { label: "control (buyer's turn)", board: base, refusal: null },
  { label: "control (seller's turn)", board: () => stockRoundBoard({ seat: 1 }), actor: P2, refusal: null },
  { label: "the auction", board: () => withState(base(), { current_round_type: "WaterfallAuction" }), refusal: "Private companies are traded between players only during a Stock Round." },
  { label: "an Operating Round", board: () => operatingBoard(), refusal: "Private companies are traded between players only during a Stock Round." },
  { label: "the first Stock Round", board: () => stockRoundBoard({ macro: 1 }), refusal: "Private companies may not be traded between players in the first Stock Round (rulebook 3.1)." },
  { label: "the turn is neither party's (the buyer proposes)", board: () => stockRoundBoard({ seat: 2 }), refusal: OWN_TURN, predicate: "A private company is traded only during the buyer's or the seller's own Stock Round turn." },
  { label: "the turn is neither party's (the seat holder proposes)", board: () => stockRoundBoard({ seat: 2 }), actor: P3, refusal: PARTY, predicate: "A private company is traded only during the buyer's or the seller's own Stock Round turn." },
  { label: "the proposer is a party but not the current-turn party", board: base, actor: P2, refusal: OWN_TURN, predicate: null },
  { label: "buyer === seller", board: base, privateId: MH, seller: P1, buyer: P1, refusal: "A player cannot trade a private company with themselves." },
  { label: "the buyer is not a seated player", board: () => stockRoundBoard({ seat: 1 }), actor: P2, buyer: "p9", refusal: "The buyer is not seated at this table." },
  { label: "the seller is not a seated player", board: base, seller: "p9", refusal: "The seller is not seated at this table." },
  { label: "the seller no longer owns the private", board: () => withPriv(base(), DH, { owner: P3 }), refusal: "Delaware & Hudson is not p2's to sell." },
  { label: "the private is a corporation's", board: () => withPriv(base(), DH, { owner: null, owner_protocol_id: NYC }), refusal: "Delaware & Hudson is not p2's to sell." },
  { label: "the private is closed", board: () => withPriv(base(), DH, { closed: true }), refusal: "Delaware & Hudson has closed and cannot be traded." },
  { label: "the private is missing", board: base, privateId: 99, refusal: "That private company is not in this game." },
  { label: "a negative price", board: base, price: -1, refusal: PRICE },
  { label: "a fractional price", board: base, price: 10.5, refusal: PRICE },
  { label: "the buyer's cash is one dollar short", board: () => withCash(base(), P1, 299), price: 300, refusal: "p1 holds $299 and cannot pay $300." },
  { label: "the buyer's cash is exactly the price (legal)", board: () => withCash(base(), P1, 300), price: 300, refusal: null },
  { label: "the buyer is at the certificate limit before receiving it", board: atLimit, refusal: "p1 holds 20 of 20 certificates and may not take another — a private company counts as one." },
  { label: "the buyer is one certificate below the limit (legal)", board: nearLimit, refusal: null },
  { label: "the proposer is an unrelated player", board: base, actor: P3, refusal: PARTY, predicate: null },
];

describe("§5 the proposal matrix: each fact alone, both locks, no mutation on refusal", () => {
  for (const row of TRADE_ROWS) {
    it(`${row.refusal === null ? "legal" : "refused"}: ${row.label}`, () => {
      const board = row.board();
      const privateId = row.privateId ?? DH;
      const seller = row.seller ?? P2;
      const buyer = row.buyer ?? P1;
      const price = row.price ?? 50;
      const actor = row.actor ?? P1;
      const proposal = { private_id: privateId, seller, buyer, price };
      expect(proposePrivateTradeRefusal(board, proposal, actor)).toBe(row.refusal);
      expect(privateTradeRefusal(board, { privateId, seller, buyer, price })).toBe(row.predicate === undefined ? row.refusal : row.predicate);
      expect(ingress(board, actor, M.proposeTrade(privateId, seller, buyer, price))).toBe(row.refusal);
      const after = apply(board, M.proposeTrade(privateId, seller, buyer, price), actor);
      if (row.refusal !== null) {
        expect(same(after, board)).toBe(true);
        expect(after.private_trade_offer ?? null).toBeNull();
      } else {
        expect(differing(board, after)).toEqual(["offer_serial", "private_trade_offer"]); // #1597: the proposal numbers itself
        expect(after.private_trade_offer).toEqual({ private_id: privateId, private_name: priv(board, privateId).name, seller, buyer, price, proposer: actor, instance: 1 });
        expect(guarded(after)).toEqual(guarded(board));
      }
    });
  }

  it("the rule's own order: round, first round, seat, parties, card, price, cash, certificates", () => {
    const ask = (state: GameStateResponse, over: Partial<{ privateId: number; seller: string; buyer: string; price: number }> = {}) =>
      privateTradeRefusal(state, { privateId: DH, seller: P2, buyer: P1, price: 50, ...over });
    expect(ask(withState(stockRoundBoard({ macro: 1, seat: 2 }), { current_round_type: "OperatingRound" }), { price: -1 })).toBe("Private companies are traded between players only during a Stock Round.");
    expect(ask(stockRoundBoard({ macro: 1, seat: 2 }), { price: -1 })).toBe("Private companies may not be traded between players in the first Stock Round (rulebook 3.1).");
    expect(ask(stockRoundBoard({ seat: 2 }), { buyer: P2 })).toBe("A private company is traded only during the buyer's or the seller's own Stock Round turn.");
    expect(ask(stockRoundBoard({ seat: 1 }), { buyer: P2, price: -1 })).toBe("A player cannot trade a private company with themselves.");
    expect(ask(withPriv(base(), DH, { closed: true }), { seller: "p9" })).toBe("The seller is not seated at this table.");
    expect(ask(withPriv(base(), DH, { closed: true }), { price: -1 })).toBe("Delaware & Hudson has closed and cannot be traded.");
    expect(ask(withCash(withPriv(base(), DH, { owner: P3 }), P1, 0), { price: -1 })).toBe("Delaware & Hudson is not p2's to sell.");
    expect(ask(withCash(atLimit(), P1, 0), { price: 10.5 })).toBe(PRICE);
    expect(ask(withCash(atLimit(), P1, 49))).toBe("p1 holds $49 and cannot pay $50.");
    // and the one-offer rule and the actor before the transaction
    const standing = apply(base(), M.proposeTrade(DH, P2, P1, 50), P1);
    expect(proposePrivateTradeRefusal(standing, { private_id: MH, seller: P1, buyer: P3, price: -1 }, P3)).toBe("An offer is already standing; it must be answered or withdrawn before another is made.");
  });

  it("the schema owns the shape and the authority owns the rule: 10.5 is refused structurally, -1 semantically", () => {
    const { validateGameplayMessage } = require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
    expect(validateGameplayMessage(M.proposeTrade(DH, P2, P1, 10.5))).toMatchObject({ ok: false, reason: "ProposePrivateTrade.price must be a whole number." });
    expect(validateGameplayMessage(M.proposeTrade(DH, P2, P1, -1))).toMatchObject({ ok: true });
    expect(ingress(base(), P1, M.proposeTrade(DH, P2, P1, -1))).toBe(PRICE);
  });

  it("the certificate count behind the limit rows is real, and the seller's count falls by one on settlement", () => {
    expect(certificateBreakdown(P1, nearLimit())).toMatchObject({ counted: 19, limit: 20 });
    expect(certificateBreakdown(P1, atLimit())).toMatchObject({ counted: 20, limit: 20 });
    const settled = apply(apply(nearLimit(), M.proposeTrade(DH, P2, P1, 50), P1), M.answerTrade(DH, true), P2);
    expect(certificateBreakdown(P1, settled).counted).toBe(20);
    expect(certificateBreakdown(P2, settled).counted).toBe(certificateBreakdown(P2, nearLimit()).counted - 1);
  });
});

/* ================================================================== */
/* §5 answer and rescission                                            */
/* ================================================================== */

describe("§5 answer and rescission: only the other party answers, only the proposer withdraws", () => {
  const offered = () => apply(base(), M.proposeTrade(DH, P2, P1, 50), P1);

  it("the proposer answering his own offer, and a third party, are refused at both locks; a mismatched private is held", () => {
    const board = offered();
    for (const accept of [true, false]) {
      expect(answerPrivateTradeRefusal(board, { private_id: DH, accept }, P1)).toBe("You made this offer; only the other party can answer it.");
      expect(ingress(board, P1, M.answerTrade(DH, accept))).toBe("You made this offer; only the other party can answer it.");
      expect(same(apply(board, M.answerTrade(DH, accept), P1), board)).toBe(true);
      expect(answerPrivateTradeRefusal(board, { private_id: DH, accept }, P3)).toBe("Only the other party to this trade can answer it.");
      expect(ingress(board, P3, M.answerTrade(DH, accept))).toBe("Only the other party to this trade can answer it.");
      expect(same(apply(board, M.answerTrade(DH, accept), P3), board)).toBe(true);
    }
    expect(answerPrivateTradeRefusal(board, { private_id: MH, accept: true }, P2)).toBe("That is not the private company on offer.");
    expect(ingress(board, P2, M.answerTrade(MH, true))).toBe("Delaware & Hudson is on offer between p2 and p1 for $50 and is waiting for an answer; nothing else can happen until it is answered or withdrawn.");
    expect(same(apply(board, M.answerTrade(MH, true), P2), board)).toBe(true);
  });

  it("the counterparty and an unrelated player cannot withdraw; the exact proposer's rescission clears the offer and nothing else", () => {
    const seed = base();
    const board = apply(seed, M.proposeTrade(DH, P2, P1, 50), P1);
    for (const actor of [P2, P3]) {
      expect(rescindPrivateTradeRefusal(board, { private_id: DH }, actor)).toBe("Only the player who made this offer can withdraw it.");
      expect(ingress(board, actor, M.rescindTrade(DH))).toBe("Only the player who made this offer can withdraw it.");
      expect(same(apply(board, M.rescindTrade(DH), actor), board)).toBe(true);
    }
    expect(rescindPrivateTradeRefusal(board, { private_id: MH }, P1)).toBe("That is not the private company on offer.");
    expect(ingress(board, P1, M.rescindTrade(DH))).toBeNull();
    const withdrawn = apply(board, M.rescindTrade(DH), P1);
    // #1597: `offer_serial` records that an offer was made and survives its release; only the offer field itself is cleared.
    expect(differing(seed, withdrawn)).toEqual(["offer_serial", "private_trade_offer"]);
    expect(differing(board, withdrawn)).toEqual(["private_trade_offer"]);
    expect(guarded(withdrawn)).toEqual(guarded(seed));
    expect(ingress(withdrawn, P1, M.pass)).toBeNull();
    expect(rescindPrivateTradeRefusal(seed, { private_id: DH }, P1)).toBe("There is no trade offer to withdraw.");
    expect(ingress(seed, P1, M.rescindTrade(DH))).toBe("There is no trade offer to withdraw.");
    // A seller-proposed offer is the seller's to withdraw.
    const sellerOffer = apply(stockRoundBoard({ seat: 1 }), M.proposeTrade(DH, P2, P1, 50), P2);
    expect(ingress(sellerOffer, P1, M.rescindTrade(DH))).toBe("Only the player who made this offer can withdraw it.");
    expect(ingress(sellerOffer, P2, M.rescindTrade(DH))).toBeNull();
  });

  it("a rejection clears the offer and writes no Stock Round marker", () => {
    const seed = withState(base(), { consecutive_passes: 2, last_trader_index: 2 });
    const rejected = apply(apply(seed, M.proposeTrade(DH, P2, P1, 50), P1), M.answerTrade(DH, false), P2);
    expect(differing(seed, rejected)).toEqual(["offer_serial", "private_trade_offer"]); // #1597
    expect(guarded(rejected)).toEqual(guarded(seed));
  });

  const STALE_AT_ANSWER: Array<[string, (state: GameStateResponse) => GameStateResponse, string]> = [
    ["the round changed", (s) => withState(s, { current_round_type: "OperatingRound" }), "Private companies are traded between players only during a Stock Round."],
    ["it became the first Stock Round", (s) => withState(s, { macro_round_number: 1 }), "Private companies may not be traded between players in the first Stock Round (rulebook 3.1)."],
    ["the seat moved to a third player", (s) => withState(s, { active_player_index: 2 }), "A private company is traded only during the buyer's or the seller's own Stock Round turn."],
    ["the seller no longer owns the card", (s) => withPriv(s, DH, { owner: P3 }), "Delaware & Hudson is not p2's to sell."],
    ["the card closed", (s) => withPriv(s, DH, { closed: true }), "Delaware & Hudson has closed and cannot be traded."],
    ["the card became a corporation's", (s) => withPriv(s, DH, { owner: null, owner_protocol_id: NYC }), "Delaware & Hudson is not p2's to sell."],
    ["the buyer's cash fell below the price", (s) => withCash(s, P1, 49), "p1 holds $49 and cannot pay $50."],
  ];
  for (const [label, stale, refusal] of STALE_AT_ANSWER) {
    it(`an acceptance on a stale board is refused, nothing moves, the offer stands; a rejection still passes: ${label}`, () => {
      const board = stale(offered());
      expect(answerPrivateTradeRefusal(board, { private_id: DH, accept: true }, P2)).toBe(refusal);
      expect(ingress(board, P2, M.answerTrade(DH, true))).toBe(refusal);
      const after = apply(board, M.answerTrade(DH, true), P2);
      expect(same(after, board)).toBe(true);
      expect(after.private_trade_offer).toMatchObject({ private_id: DH, seller: P2, buyer: P1, price: 50 });
      expect(ingress(board, P2, M.answerTrade(DH, false))).toBeNull();
      expect(apply(board, M.answerTrade(DH, false), P2).private_trade_offer).toBeNull();
      expect(ingress(board, P1, M.rescindTrade(DH))).toBeNull();
    });
  }

  it("an acceptance at the certificate limit is refused at answer time (the holdings went stale under the offer)", () => {
    const offeredNear = apply(nearLimit(), M.proposeTrade(DH, P2, P1, 50), P1);
    const filled = withState(offeredNear, {
      private_companies: [...offeredNear.private_companies, { private_id: CSL, name: "Champlain & St. Lawrence", cost: "40", revenue_per_or: "10", owner: P1, owner_protocol_id: null, closed: false }],
    });
    const refusal = "p1 holds 20 of 20 certificates and may not take another — a private company counts as one.";
    expect(ingress(filled, P2, M.answerTrade(DH, true))).toBe(refusal);
    expect(same(apply(filled, M.answerTrade(DH, true), P2), filled)).toBe(true);
    expect(apply(filled, M.answerTrade(DH, true), P2).private_trade_offer).not.toBeNull();
  });
});

/* ================================================================== */
/* §10 (trade): the parties are the transaction                         */
/* ================================================================== */

describe("§10 (trade): nobody can forge consent, and a changed board is judged afresh", () => {
  it("a proposer cannot write himself onto both sides, onto a card he does not own, or into a trade he is not party to", () => {
    const board = base();
    expect(ingress(board, P1, M.proposeTrade(DH, P1, P1, 50))).toBe("A player cannot trade a private company with themselves.");
    expect(ingress(board, P1, M.proposeTrade(DH, P1, P3, 50))).toBe("Delaware & Hudson is not p1's to sell.");
    expect(ingress(board, P1, M.proposeTrade(DH, P2, P3, 50))).toBe(PARTY);
    // Having proposed legitimately, he cannot answer as the other party.
    const offered = apply(board, M.proposeTrade(DH, P2, P1, 50), P1);
    expect(ingress(offered, P1, M.answerTrade(DH, true))).toBe("You made this offer; only the other party can answer it.");
    // A null-actor proposal (solo / attribution-less) records the seat as the proposer, never a payload name.
    expect(apply(board, M.proposeTrade(DH, P2, P1, 50), null).private_trade_offer?.proposer).toBe(P1);
  });

  it("the card changes hands under the offer: the named seller can no longer accept, the new owner is not a party, the proposer can still withdraw", () => {
    const offered = apply(base(), M.proposeTrade(DH, P2, P1, 50), P1);
    const moved = withPriv(offered, DH, { owner: P3 });
    expect(ingress(moved, P2, M.answerTrade(DH, true))).toBe("Delaware & Hudson is not p2's to sell.");
    expect(ingress(moved, P3, M.answerTrade(DH, true))).toBe("Only the other party to this trade can answer it.");
    expect(ingress(moved, P3, M.answerTrade(DH, false))).toBe("Only the other party to this trade can answer it.");
    expect(ingress(moved, P2, M.answerTrade(DH, false))).toBeNull();
    expect(ingress(moved, P1, M.rescindTrade(DH))).toBeNull();
    // The seat moving to the new owner makes him no more a party.
    expect(ingress(withState(moved, { active_player_index: 2 }), P3, M.answerTrade(DH, true))).toBe("Only the other party to this trade can answer it.");
  });
});

/* ================================================================== */
/* §6 D-26: what travels with the card                                  */
/* ================================================================== */

describe("§6 D-26: every unexercised ownership-dependent power follows the card; vested benefits neither move nor retrigger", () => {
  const fullBoard = (over: Partial<GameStateResponse> = {}) =>
    stockRoundBoard({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]], ipo: 50 },
        { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, holdings: [[P2, 30], [P3, 10]], ipo: 50 },
      ],
      privates: [
        { id: MH, owner: P2, cost: "110" },
        { id: DH, owner: P2, cost: "70" },
        { id: CSL, owner: P2, cost: "40" },
        { id: CA, owner: P2, cost: "160" },
        { id: BO, owner: P2, cost: "220" },
      ],
      over,
    });
  const trade = (state: GameStateResponse, privateId: number, price = 10) =>
    apply(apply(state, M.proposeTrade(privateId, P2, P1, price), P1), M.answerTrade(privateId, true), P2);
  /** The Operating Round after the trade, PRR (P1) at Track, NYC (P2) next. */
  const toOperating = (state: GameStateResponse) =>
    withState(state, { current_round_type: "OperatingRound", macro_round_number: 3, operating_sub_phase: "Track", active_operating_order: [PRR, NYC], active_corporation_index: 0 });

  it("the M&H exchange follows the M&H: resolver, ingress owner, Stock Round chip and the reducer all read the new owner", () => {
    const before = fullBoard();
    expect(resolvePrivateExchange(before, MH, P2).ok).toBe(true);
    const traded = trade(before, MH);
    expect(resolvePrivateExchange(traded, MH, P1).ok).toBe(true);
    expect(resolvePrivateExchange(traded, MH, P2)).toEqual({ ok: false, reason: "The Mohawk & Hudson is not yours to exchange." });
    const exchange = (player: string) => ({ ExchangePrivate: { game_id: 1, private_id: MH, company_id: NYC, player, source: "Ipo" } });
    expect(ingress(traded, P1, exchange(P1))).toBeNull();
    expect(ingress(traded, P2, exchange(P2))).toBe("Only the Mohawk & Hudson's owner can exchange it.");
    expect(stockRoundExchangeOffers({ state: traded, viewerAddress: P1, sandbox: true, mhPrivateId: MH })).toHaveLength(1);
    expect(stockRoundExchangeOffers({ state: traded, viewerAddress: P2, sandbox: true, mhPrivateId: MH })).toEqual([]);
    const exchanged = apply(traded, exchange(P1), P1);
    expect(corp(exchanged, NYC).player_holdings).toContainEqual({ player: P1, percentage: 10 });
    expect(priv(exchanged, MH)).toMatchObject({ closed: true, owner: null });
  });

  it("the private's revenue follows the card", () => {
    const traded = trade(fullBoard(), DH);
    const payouts = applyPrivateRevenue(traded)!.payouts.filter((payout) => payout.privateId === DH);
    expect(payouts).toEqual([expect.objectContaining({ privateId: DH, toPlayer: P1, toCompanyId: null })]);
  });

  it("the D&H: the still-unexercised free station's ownership follows the card to the new owner; the corporate power itself only exists after a later corporate purchase (S9-12, #1660)", () => {
    // S9-12 (#1660) retired this sub-test's old premise. The ingress owner check it originally exercised
    // compared the acting PLAYER against the private's player-owner field -- a question that could only ever
    // resolve for a player-held D&H, and never for the corporation-owned board the power is actually meant to
    // run on (`dhStationAuthority.ts`'s own design note #1660 has the finding). The real gate is corporate
    // ownership (`owner_protocol_id`), and the D&H here is still merely player-held -- traded player to
    // player, not yet bought by any corporation -- so its free station is not a live power either corporation
    // can answer to yet. That is not a gap this test papers over: a bare player cannot lay the D&H's own
    // tile, so there is no "player-held free station" to answer to anyone. What DOES travel with the card at
    // this stage is provable, and is what this test now proves: ownership of the dormant power follows P1
    // (`currentPrivateOwner` below), and the power itself, once it exists, follows the later corporate
    // purchase (`dhFreeStationAvailableFor` below) -- exactly D-26's own title, "every unexercised
    // ownership-dependent power follows the card."
    const traded = trade(fullBoard({ used_private_abilities: ["dh-tile"] }), DH);
    const dhHex = privateHexFor(DH_PRIVATE_ID)!;
    const place = (company: number) => ({ PlaceHomeStation: { game_id: 1, company_id: company, q: dhHex.q, r: dhHex.r, kind: "dh" } });
    const notCorpOwned = (ticker: string) =>
      `Only the corporation that owns the Delaware & Hudson may use its free station, and ${ticker} does not.`;
    // Neither corporation may answer to it yet -- the D&H is still player-held, so there is no owning
    // corporation for either PRR (the new owner's own corporation) or NYC (the old owner's) to be.
    expect(ingress(traded, P1, place(PRR))).toBe(notCorpOwned("PRR"));
    expect(ingress(traded, P2, place(NYC))).toBe(notCorpOwned("NYC"));
    // The card is P1's to sell to a corporation now, not P2's.
    expect(currentPrivateOwner(toOperating(traded), DH)).toBe(P1);
    const bought = apply(toOperating(traded), M.buyPrivate(PRR, DH, "70"), P1);
    expect(ownsPrivateByCorporation(bought, DH, PRR)).toBe(true);
    expect(dhFreeStationAvailableFor({ companyId: PRR, privates: bought.private_companies, usedAbilities: bought.used_private_abilities ?? [], dhHexBuilt: false })).toBe(true);
    expect(dhFreeStationAvailableFor({ companyId: NYC, privates: bought.private_companies, usedAbilities: bought.used_private_abilities ?? [], dhHexBuilt: false })).toBe(false);
  });

  it("an already-used ability stays used through the trade and through the later corporate purchase", () => {
    const before = fullBoard({ used_private_abilities: ["dh-tile", "dh-token"] });
    const traded = trade(before, DH);
    expect(traded.used_private_abilities).toEqual(["dh-tile", "dh-token"]);
    expect(differing(before, traded)).not.toContain("used_private_abilities");
    const bought = apply(toOperating(traded), M.buyPrivate(PRR, DH, "70"), P1);
    expect(dhFreeStationAvailableFor({ companyId: PRR, privates: bought.private_companies, usedAbilities: bought.used_private_abilities ?? [], dhHexBuilt: false })).toBe(false);
  });

  it("the C&SL: the corporate power goes to whichever corporation buys it from its NEW owner; the old owner can no longer sell it", () => {
    const traded = trade(fullBoard(), CSL);
    const operating = toOperating(traded);
    expect(currentPrivateOwner(operating, CSL)).toBe(P1);
    // NYC's president (the old owner) cannot answer a corporate offer for it.
    const offered = apply(operating, M.proposePrivate(CSL, PRR, 40), P1);
    expect(ingress(offered, P2, M.answerPrivate(CSL, true))).toBe("Only the private company's owner can answer that offer.");
    const bought = apply(operating, M.buyPrivate(PRR, CSL, "40"), P1);
    expect(ownsPrivateByCorporation(bought, CSL, PRR)).toBe(true);
    expect(ownsPrivateByCorporation(bought, CSL, NYC)).toBe(false);
  });

  it("the JK (Level Playing Field): the trade grants no licence; the first corporation to buy it from its NEW owner does, once", () => {
    const lpf = board({
      round: "StockRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 60]] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", holdings: [[P2, 60]] },
      ],
      privates: [{ id: JK_PRIVATE_ID, owner: P2, cost: "120" }],
      over: { variants: { levelPlayingField: true } as never },
    });
    const traded = trade(lpf, JK_PRIVATE_ID);
    expect(priv(traded, JK_PRIVATE_ID).owner).toBe(P1);
    expect(traded.jk_license_granted ?? false).toBe(false);
    expect(corp(traded, PRR).kanawha_licenses ?? 0).toBe(0);
    const bought = apply(toOperating(traded), M.buyPrivate(PRR, JK_PRIVATE_ID, "120"), P1);
    expect(bought.jk_license_granted).toBe(true);
    expect(corp(bought, PRR).kanawha_licenses).toBe(1);
    expect(jkTileRefusal(bought, PRR, 0, 0)).not.toBe(JK_TILE_REFUSALS.notOwner);
    expect(jkTileRefusal(bought, NYC, 0, 0)).toBe(JK_TILE_REFUSALS.notOwner);
  });

  it("the C&A: its already-issued PRR certificate stays with its holder, and no share is issued by the trade or by a later corporate sale", () => {
    const before = fullBoard();
    const traded = trade(before, CA);
    expect(corp(traded, PRR)).toEqual(corp(before, PRR));
    expect(corp(traded, NYC)).toEqual(corp(before, NYC));
    expect(differing(before, traded)).toEqual(["last_trader_index", "offer_serial", "player_cash", "private_companies", "private_trade_offer", "turn_action_taken"]); // #1597
    const operating = withState(toOperating(traded), { active_operating_order: [NYC, PRR] });
    const offered = apply(operating, M.proposePrivate(CA, NYC, 160), P2);
    const sold = apply(apply(offered, M.answerPrivate(CA, true), P1), M.buyPrivate(NYC, CA, "160"), P1);
    expect(priv(sold, CA).owner_protocol_id).toBe(NYC);
    expect(corp(sold, PRR).player_holdings).toEqual(corp(before, PRR).player_holdings);
    expect(corp(sold, PRR).ipo_pool_percentage).toBe(corp(before, PRR).ipo_pool_percentage);
  });

  it("the B&O: the private is player-tradeable; its vested president's certificate and par neither move nor are re-owed", () => {
    const bo = board({
      round: "StockRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30]] },
        { id: 3, ticker: "B&O", president: P2, trains: [], treasury: "0", holdings: [[P2, 20]], ipo: 80, parValue: "100", floated: false },
      ],
      privates: [{ id: BO, owner: P2, cost: "220" }],
    });
    expect(privateTradeRefusal(bo, { privateId: BO, seller: P2, buyer: P1, price: 200 })).toBeNull();
    const traded = trade(bo, BO, 200);
    expect(priv(traded, BO).owner).toBe(P1);
    expect(traded.public_companies).toEqual(bo.public_companies);
    expect(boPresidencyRefusal(traded, "B&O")).toBe(boPresidencyRefusal(bo, "B&O"));
    const setPar = (player: string) => ({ SetBoPar: { player, par_value: "100" } });
    // The new owner clears the socket's owner check -- and the reducer still re-owes nothing.
    expect(ingress(traded, P1, setPar(P1))).toBeNull();
    const reParred = apply(traded, setPar(P1), P1);
    expect(same(reParred, traded)).toBe(true);
    expect(corp(reParred, 3)).toMatchObject({ president: P2, par_value: "100" });
    expect(ingress(traded, P2, setPar(P2))).toBe("Only the B&O private's owner pars the B&O.");
    // ... and it is still never saleable to a corporation.
    expect(ingress(toOperating(traded), P1, M.proposePrivate(BO, PRR, 220))).toBe("Baltimore & Ohio may never be sold to a corporation.");
  });

  it("the trade writes `owner` and nothing else about the card: the other private fields are untouched", () => {
    const before = fullBoard();
    const traded = trade(before, DH);
    const strip = (state: GameStateResponse) => state.private_companies.map((entry) => ({ ...entry, owner: "x" }));
    expect(strip(traded)).toEqual(strip(before));
    expect(priv(traded, DH)).toEqual({ ...priv(before, DH), owner: P1, owner_protocol_id: null });
  });
});

/* ================================================================== */
/* §7 D-27: Stock Round bookkeeping                                     */
/* ================================================================== */

describe("§7 D-27: a settled trade is the current-turn player's transaction", () => {
  const markers = (state: GameStateResponse) => ({
    turn_action_taken: state.turn_action_taken ?? false,
    consecutive_passes: state.consecutive_passes,
    last_trader_index: state.last_trader_index ?? null,
    bought_this_turn: state.bought_this_turn ?? 0,
    bought_this_turn_company: state.bought_this_turn_company ?? null,
    stock_turn_stage: state.stock_turn_stage ?? null,
    active_player_index: state.active_player_index,
  });

  for (const rules of [0, 1]) {
    const revision = rules === 0 ? "the legacy Stock Round" : "Sell-Buy-Sell";
    const seeded = (seat: number, over: Record<string, unknown> = {}) =>
      stockRoundBoard({ seat, over: { consecutive_passes: 2, last_trader_index: 2, variants: { rules }, ...over } as never });

    it(`${revision}: buyer's turn -- the settlement writes exactly the three markers, for the SEAT, not the acceptor`, () => {
      const seed = seeded(0);
      const settled = apply(apply(seed, M.proposeTrade(DH, P2, P1, 50), P1), M.answerTrade(DH, true), P2);
      expect(markers(settled)).toEqual({ ...markers(seed), turn_action_taken: true, consecutive_passes: 0, last_trader_index: 0 });
      expect(differing(seed, settled)).toEqual(["consecutive_passes", "last_trader_index", "offer_serial", "player_cash", "private_companies", "private_trade_offer", "turn_action_taken"]); // #1597
    });

    it(`${revision}: seller's turn -- the seller's seat is the trader; the buyer's off-turn acceptance moves no cursor`, () => {
      const seed = seeded(1, { last_trader_index: 0 });
      const settled = apply(apply(seed, M.proposeTrade(DH, P2, P1, 50), P2), M.answerTrade(DH, true), P1);
      expect(markers(settled)).toEqual({ ...markers(seed), turn_action_taken: true, consecutive_passes: 0, last_trader_index: 1 });
    });

    it(`${revision}: after a purchase this turn, the trade leaves the purchase count, its corporation and the stage alone`, () => {
      const seed = seeded(1, { bought_this_turn: 1, bought_this_turn_company: NYC, turn_action_taken: true, consecutive_passes: 0, last_trader_index: 1 });
      const settled = apply(apply(seed, M.proposeTrade(DH, P2, P1, 40), P2), M.answerTrade(DH, true), P1);
      expect(markers(settled)).toEqual(markers(seed));
      expect(settled.bought_this_turn_company).toBe(NYC);
    });

    it(`${revision}: End Turn afterwards advances the seat as an action taken, and the Priority Deal lands left of the trader`, () => {
      for (const [seat, proposer, acceptor, trader] of [[0, P1, P2, 0], [1, P2, P1, 1]] as Array<[number, string, string, number]>) {
        let state = apply(apply(seeded(seat), M.proposeTrade(DH, P2, P1, 50), proposer), M.answerTrade(DH, true), acceptor);
        const endTurn = (actor: string) => {
          // Sell-Buy-Sell ends a turn in two presses (sell -> buy -> end); the legacy round in one.
          const start = state.active_player_index;
          state = apply(state, M.pass, actor);
          if (state.current_round_type === "StockRound" && state.active_player_index === start) state = apply(state, M.pass, actor);
        };
        const players = [P1, P2, P3];
        endTurn(players[seat]);
        expect(state.active_player_index).toBe((seat + 1) % 3);
        expect(state.consecutive_passes).toBe(0); // not counted as a pass
        expect(state.last_trader_index).toBe(trader);
        // Everybody else passes, then the trader passes: the round ends and the Priority Deal goes left of the trader.
        endTurn(players[(seat + 1) % 3]);
        endTurn(players[(seat + 2) % 3]);
        expect(state.current_round_type).toBe("StockRound");
        endTurn(players[seat]);
        expect(state.current_round_type).toBe("OperatingRound");
        expect(state.priority_deal_index).toBe((trader + 1) % 3);
      }
    });
  }

  it("a rejected, a rescinded and a refused acceptance write none of the markers", () => {
    const seed = stockRoundBoard({ over: { consecutive_passes: 2, last_trader_index: 2 } });
    const offered = apply(seed, M.proposeTrade(DH, P2, P1, 50), P1);
    const rejected = apply(offered, M.answerTrade(DH, false), P2);
    const rescinded = apply(offered, M.rescindTrade(DH), P1);
    const drained = withCash(offered, P1, 10);
    const refused = apply(drained, M.answerTrade(DH, true), P2);
    for (const state of [rejected, rescinded]) {
      expect(markers(state)).toEqual(markers(seed));
      expect(differing(seed, state)).toEqual(["offer_serial", "private_trade_offer"]); // #1597
    }
    expect(stateDigest(refused)).toBe(stateDigest(drained));
    // And the unanswered offer itself wrote none.
    expect(markers(offered)).toEqual(markers(seed));
  });

  it("through a room: the off-turn acceptance passes ingress; the trade consumes no purchase; End Turn is the seat's and is not a pass", () => {
    const seed = stockRoundBoard({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]], ipo: 50 },
        { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, holdings: [[P2, 30], [P3, 10]], ipo: 60 },
      ],
      over: { consecutive_passes: 2, last_trader_index: 2 },
    });
    const { room, submit } = S.roomFor(seed);
    expect(submit(P1, M.proposeTrade(DH, P2, P1, 50)).kind).toBe("applied");
    expect(submit(P2, M.pass).kind).toBe("refused");
    expect(submit(P2, M.answerTrade(DH, true)).kind).toBe("applied");
    expect(submit(P2, M.pass).kind).toBe("refused"); // not P2's turn
    expect(room.state.bought_this_turn ?? 0).toBe(0);
    // Same turn, after the trade: the seat's one certificate purchase is still available (the legacy round ends the turn on it).
    expect(ingress(room.state, P1, M.buyStock(PRR))).toBeNull();
    expect(submit(P1, M.buyStock(PRR)).kind).toBe("applied");
    expect(S.corp(room.state, PRR).player_holdings).toContainEqual({ player: P1, percentage: 40 });
    expect(room.state.active_player_index).toBe(1);
    expect(room.state.consecutive_passes).toBe(0);
    expect(room.state.last_trader_index).toBe(0);
  });

  it("through a room: End Turn straight after the trade is the seat's, advances the seat and is not a pass", () => {
    const seed = stockRoundBoard({ over: { consecutive_passes: 2, last_trader_index: 2 } });
    const { room, submit } = S.roomFor(seed);
    expect(submit(P1, M.proposeTrade(DH, P2, P1, 50)).kind).toBe("applied");
    expect(submit(P2, M.answerTrade(DH, true)).kind).toBe("applied");
    expect(submit(P1, M.pass).kind).toBe("applied");
    expect(room.state.active_player_index).toBe(1);
    expect(room.state.consecutive_passes).toBe(0);
    expect(room.state.last_trader_index).toBe(0);
  });
});
