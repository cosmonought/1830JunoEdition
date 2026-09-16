/** @jest-environment node */
//
// ==================================================================
//  BATCH 7.4 EXHAUSTIVE MATRIX (1/6): THE ORDINARY CORPORATE PURCHASE OF A PLAYER'S PRIVATE COMPANY
// ==================================================================
//
// `privatePurchaseRefusal` (#1591) and its three consent predicates, attacked one fact at a time: a legal board,
// exactly one fact changed, the precise refusal asserted at BOTH locks (ingress's sentence; the reducer by digest),
// no forbidden mutation, and the fact restored before the next row (every row builds its own board). Covers the
// review brief's §2 (predicate, consent, payment), the private half of §10 (re-derived answerer) and §17's
// conservation for the treasury -> player transfer.

export {};

const { privatePurchaseRefusal, proposePrivatePurchaseRefusal, answerPrivatePurchaseRefusal, rescindPrivatePurchaseRefusal } =
  require("../gameEngine/privatePurchaseAuthority") as typeof import("../gameEngine/privatePurchaseAuthority");
const { nextDerivedAction } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { moneyTotal, moneyConservationBreach } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { pendingOfferBlock, standingOrdinaryOffer } = require("../gameEngine/pendingOfferHold") as typeof import("../gameEngine/pendingOfferHold");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const { P1, P2, P3, PRR, NYC, DH, CA, MH, BO, operatingBoard } = F;
const { apply, ingress, same, differing, withCorp, withPriv, withState, atPhase, priv, cash, treasury, guarded, M, GRID } = S;

const DH_BAND = "The price must be a whole number between $35 and $140 (half to twice Delaware & Hudson's $70 face value).";

/* ================================================================== */
/* The legal control                                                   */
/* ================================================================== */

describe("§2 control: proposal -> answer -> derived settlement -> exactly one payment and one ownership transfer", () => {
  it("through a room: one derived BuyPrivateCompany, treasury -> the current player owner once, conserved, hold released", () => {
    const seed = operatingBoard();
    const { room, submit, kinds, logged } = S.roomFor(seed);
    expect(kinds(submit(P1, M.proposePrivate(DH, PRR, 100, "a-forged-owner")))).toEqual(["ProposePrivatePurchase"]);
    expect(room.state.private_purchase_offer).toEqual({
      private_id: DH, private_name: "Delaware & Hudson", owner: P2, buyer_protocol_id: PRR, buyer_ticker: "PRR", price: 100,
      instance: 1, // #1597: the offer's lifecycle identity, assigned by the proposal arm
    });
    expect(room.state.offer_serial).toBe(1);
    // The answer burst: the answer and exactly one derived settlement, nothing else.
    expect(kinds(submit(P2, M.answerPrivate(DH, true)))).toEqual(["AnswerPrivatePurchase", "BuyPrivateCompany*"]);
    expect(room.state.private_purchase_offer).toBeNull();
    expect(priv(room.state, DH)).toMatchObject({ owner: null, owner_protocol_id: PRR });
    expect(treasury(room.state, PRR)).toBe(400);
    expect(cash(room.state, P2)).toBe(400);
    expect(cash(room.state, P1)).toBe(300);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
    expect(logged("BuyPrivateCompany")).toHaveLength(1);
    // Released: nothing owed, and the turn can move.
    expect(nextDerivedAction({ state: room.state, mapGrid: GRID, emitted: new Set() })).toBeNull();
    expect(submit(P1, M.pass).kind).toBe("applied");
    expect(logged("BuyPrivateCompany")).toHaveLength(1);
  });

  it("through the reducer: the settled board differs from the proposal's board only in the transfer and the retired offer", () => {
    const seed = operatingBoard();
    const { accepted } = S.privateOfferStages(seed, DH, 100, P2);
    const owed = nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() })!;
    expect(owed.msg).toEqual({ BuyPrivateCompany: { game_id: 0, protocol_id: PRR, private_id: DH, price: "100" } });
    const settled = apply(accepted, owed.msg, P2);
    // #1597: `offer_serial` (written at the proposal) is the one field beside the transfer and the retired offer.
    expect(differing(seed, settled)).toEqual(["offer_serial", "player_cash", "private_companies", "private_purchase_offer", "public_companies"]);
    expect(settled.private_purchase_offer).toBeNull();
    // public_companies differs in PRR's treasury alone.
    expect(settled.public_companies.map((entry) => ({ ...entry, treasury: "x" }))).toEqual(seed.public_companies.map((entry) => ({ ...entry, treasury: "x" })));
    expect(treasury(settled, PRR) - treasury(seed, PRR)).toBe(-100);
    expect(cash(settled, P2) - cash(seed, P2)).toBe(100);
    expect(moneyConservationBreach(seed, settled)).toBeNull();
  });
});

/* ================================================================== */
/* The predicate, one fact at a time, at the proposal                   */
/* ================================================================== */

interface ProposalRow {
  label: string;
  board: () => GameStateResponse;
  privateId?: number;
  buyer?: number;
  price?: number;
  actor?: string;
  /** The exact sentence, or `null` for a legal row. */
  refusal: string | null;
}

const base = () => operatingBoard();

const PROPOSAL_ROWS: ProposalRow[] = [
  { label: "control", board: base, refusal: null },
  { label: "not an Operating Round (a Stock Round)", board: () => withState(base(), { current_round_type: "StockRound" }), refusal: "A corporation buys a private company only during its own turn of an Operating Round." },
  { label: "not an Operating Round (the auction)", board: () => withState(base(), { current_round_type: "WaterfallAuction" }), refusal: "A corporation buys a private company only during its own turn of an Operating Round." },
  { label: "the buyer is not the operating corporation", board: () => operatingBoard({ operating: NYC }), refusal: "Only the operating corporation may buy a private company — NYC is operating, not PRR." },
  { label: "phase 2", board: () => atPhase(base(), "2"), refusal: "Corporations may buy private companies only during phases 3 and 4." },
  { label: "phase 4 (legal)", board: () => atPhase(base(), "4"), refusal: null },
  { label: "phase 5", board: () => atPhase(base(), "5"), refusal: "Corporations may buy private companies only during phases 3 and 4." },
  { label: "phase 6", board: () => atPhase(base(), "6"), refusal: "Corporations may buy private companies only during phases 3 and 4." },
  { label: "the private is missing", board: base, privateId: 99, refusal: "That private company is not in this game." },
  { label: "the private is closed", board: () => withPriv(base(), DH, { closed: true }), refusal: "Delaware & Hudson has closed and cannot be bought." },
  { label: "the B&O private is offered to a corporation", board: () => operatingBoard({ privates: [{ id: BO, owner: P2, cost: "220" }] }), privateId: BO, price: 220, refusal: "Baltimore & Ohio may never be sold to a corporation." },
  { label: "the owner is another corporation", board: () => withPriv(base(), DH, { owner: null, owner_protocol_id: NYC }), refusal: "Delaware & Hudson belongs to a corporation, and private companies may be bought by corporations but not sold by them." },
  { label: "the owner is missing", board: () => withPriv(base(), DH, { owner: null }), refusal: "Delaware & Hudson has no owner to buy it from." },
  { label: "a fractional price", board: base, price: 70.5, refusal: DH_BAND },
  { label: "a negative price", board: base, price: -35, refusal: DH_BAND },
  { label: "one dollar below half face ($34)", board: base, price: 34, refusal: DH_BAND },
  { label: "exactly half face ($35, legal)", board: base, price: 35, refusal: null },
  { label: "exactly twice face ($140, legal)", board: base, price: 140, refusal: null },
  { label: "one dollar above twice face ($141)", board: base, price: 141, refusal: DH_BAND },
  { label: "the buyer has not floated", board: () => withCorp(base(), PRR, { is_floated: false }), refusal: "PRR has not floated and cannot buy a private company." },
  { label: "treasury one dollar short ($99)", board: () => withCorp(base(), PRR, { treasury: "99" }), refusal: "PRR's treasury holds $99 — it cannot pay $100." },
  { label: "treasury exactly the price ($100, legal)", board: () => withCorp(base(), PRR, { treasury: "100" }), refusal: null },
  { label: "the proposer is the owner, not the buyer's president", board: base, actor: P2, refusal: "Only PRR's president can make an offer on its behalf." },
  { label: "the proposer is an unrelated player", board: base, actor: P3, refusal: "Only PRR's president can make an offer on its behalf." },
  { label: "the buying corporation is not in the game", board: base, buyer: 77, refusal: "That corporation is not in this game." },
  { label: "any step of its turn (Track, legal)", board: () => operatingBoard({ step: "Track" }), refusal: null },
  { label: "any step of its turn (Tokens, legal)", board: () => operatingBoard({ step: "Tokens" }), refusal: null },
  { label: "any step of its turn (Routes, legal)", board: () => operatingBoard({ step: "Routes" }), refusal: null },
  { label: "any step of its turn (Dividends, legal)", board: () => operatingBoard({ step: "Dividends" }), refusal: null },
];

describe("§2 the proposal matrix: each fact alone, both locks, no mutation on refusal", () => {
  for (const row of PROPOSAL_ROWS) {
    it(`${row.refusal === null ? "legal" : "refused"}: ${row.label}`, () => {
      const board = row.board();
      const privateId = row.privateId ?? DH;
      const buyer = row.buyer ?? PRR;
      const price = row.price ?? 100;
      const actor = row.actor ?? P1;
      const msg = M.proposePrivate(privateId, buyer, price, "narration-that-must-not-be-read");
      expect(proposePrivatePurchaseRefusal(board, { private_id: privateId, buyer_protocol_id: buyer, price }, actor)).toBe(row.refusal);
      expect(ingress(board, actor, msg)).toBe(row.refusal);
      const after = apply(board, msg, actor);
      if (row.refusal !== null) {
        expect(same(after, board)).toBe(true);
        expect(differing(board, after)).toEqual([]);
        expect(after.private_purchase_offer ?? null).toBeNull();
      } else {
        expect(differing(board, after)).toEqual(["offer_serial", "private_purchase_offer"]); // #1597: the proposal numbers itself
        expect(after.private_purchase_offer).toMatchObject({ private_id: privateId, buyer_protocol_id: buyer, price, owner: priv(board, privateId).owner });
        expect(guarded(after)).toEqual(guarded(board));
      }
    });
  }

  it("the predicate's own rule for a buyer with no president (the proposal's actor rule fires first)", () => {
    const board = withCorp(base(), PRR, { president: null });
    expect(privatePurchaseRefusal(board, { buyerId: PRR, privateId: DH, price: 100 }, P1, "proposal")).toBe("PRR has no president to buy on its behalf.");
    expect(privatePurchaseRefusal(board, { buyerId: PRR, privateId: DH, price: 100 }, null, "proposal")).toBe("PRR has no president to buy on its behalf.");
    expect(proposePrivatePurchaseRefusal(board, { private_id: DH, buyer_protocol_id: PRR, price: 100 }, P1)).toBe("Only PRR's president can make an offer on its behalf.");
    expect(same(apply(board, M.proposePrivate(DH, PRR, 100), P1), board)).toBe(true);
  });

  it("the band is fixed-point integer arithmetic: an odd face rounds the floor up and the ceiling down", () => {
    const odd = withPriv(base(), DH, { cost: "75" }); // half 37.5 -> $38; twice 150
    const ask = (price: number) => privatePurchaseRefusal(odd, { buyerId: PRR, privateId: DH, price }, P1, "proposal");
    expect(ask(37)).toBe("The price must be a whole number between $38 and $150 (half to twice Delaware & Hudson's $75 face value).");
    expect(ask(38)).toBeNull();
    expect(ask(150)).toBeNull();
    expect(ask(151)).not.toBeNull();
  });

  it("the design's order is load-bearing: with two facts wrong, the earlier rule is the one reported", () => {
    const ask = (board: GameStateResponse, price = 100, privateId = DH) =>
      privatePurchaseRefusal(board, { buyerId: PRR, privateId, price }, P1, "proposal");
    // round before operating, phase, card, price, standing, treasury
    expect(ask(withCorp(withState(base(), { current_round_type: "StockRound" }), PRR, { treasury: "0" }), 999)).toBe("A corporation buys a private company only during its own turn of an Operating Round.");
    // operating before phase
    expect(ask(atPhase(operatingBoard({ operating: NYC }), "2"))).toBe("Only the operating corporation may buy a private company — NYC is operating, not PRR.");
    // phase before the card
    expect(ask(withPriv(atPhase(base(), "5"), DH, { closed: true }))).toBe("Corporations may buy private companies only during phases 3 and 4.");
    // closed before the B&O ban and the owner
    expect(ask(withPriv(base(), DH, { closed: true, owner: null, owner_protocol_id: NYC }))).toBe("Delaware & Hudson has closed and cannot be bought.");
    // the card before the price
    expect(ask(withPriv(base(), DH, { owner: null, owner_protocol_id: NYC }), 1)).toBe("Delaware & Hudson belongs to a corporation, and private companies may be bought by corporations but not sold by them.");
    // the price before the buyer's standing and treasury
    expect(ask(withCorp(base(), PRR, { is_floated: false, treasury: "0" }), 141)).toBe(DH_BAND);
    // floated before president before treasury
    expect(ask(withCorp(base(), PRR, { is_floated: false, president: null, treasury: "0" }))).toBe("PRR has not floated and cannot buy a private company.");
    expect(ask(withCorp(base(), PRR, { president: null, treasury: "0" }))).toBe("PRR has no president to buy on its behalf.");
    // the one-offer rule and the proposer before the transaction
    const standing = apply(base(), M.proposePrivate(CA, PRR, 160), P1);
    expect(proposePrivatePurchaseRefusal(withState(standing, { current_round_type: "StockRound" }), { private_id: DH, buyer_protocol_id: PRR, price: 100 }, P2)).toBe("An offer is already standing; it must be answered or withdrawn before another is made.");
    expect(proposePrivatePurchaseRefusal(withState(base(), { current_round_type: "StockRound" }), { private_id: DH, buyer_protocol_id: PRR, price: 100 }, P2)).toBe("Only PRR's president can make an offer on its behalf.");
  });
});

/* ================================================================== */
/* Answer time                                                         */
/* ================================================================== */

describe("§2 the answer: who may answer, and an acceptance re-runs the whole predicate on the board of that moment", () => {
  const offered = () => apply(base(), M.proposePrivate(DH, PRR, 100), P1);

  it("the wrong player answers: the proposer and an unrelated player are refused at both locks; the owner may", () => {
    const board = offered();
    for (const actor of [P1, P3]) {
      for (const accept of [true, false]) {
        expect(answerPrivatePurchaseRefusal(board, { private_id: DH, accept }, actor)).toBe("Only the private company's owner can answer that offer.");
        expect(ingress(board, actor, M.answerPrivate(DH, accept))).toBe("Only the private company's owner can answer that offer.");
        expect(same(apply(board, M.answerPrivate(DH, accept), actor), board)).toBe(true);
      }
    }
    expect(ingress(board, P2, M.answerPrivate(DH, true))).toBeNull();
    expect(apply(board, M.answerPrivate(DH, true), P2).private_purchase_offer).toMatchObject({ accepted: true, owner: P2 });
  });

  it("an answer naming another private is refused by the hold at both locks", () => {
    const board = offered();
    expect(answerPrivatePurchaseRefusal(board, { private_id: CA, accept: true }, P2)).toBe("That is not the private company on offer.");
    expect(ingress(board, P3, M.answerPrivate(CA, true))).toContain("nothing else can happen until it is answered or withdrawn");
    expect(same(apply(board, M.answerPrivate(CA, true), P3), board)).toBe(true);
  });

  const STALE_AT_ANSWER: Array<[string, (state: GameStateResponse) => GameStateResponse, string]> = [
    ["the round changed", (s) => withState(s, { current_round_type: "StockRound" }), "A corporation buys a private company only during its own turn of an Operating Round."],
    ["another corporation is operating", (s) => withState(s, { active_corporation_index: 1 }), "Only the operating corporation may buy a private company — NYC is operating, not PRR."],
    ["the phase left 3/4", (s) => atPhase(s, "5"), "Corporations may buy private companies only during phases 3 and 4."],
    ["the private closed", (s) => withPriv(s, DH, { closed: true }), "Delaware & Hudson has closed and cannot be bought."],
    ["the private became a corporation's", (s) => withPriv(s, DH, { owner: null, owner_protocol_id: NYC }), "Delaware & Hudson belongs to a corporation, and private companies may be bought by corporations but not sold by them."],
    ["the face moved the band", (s) => withPriv(s, DH, { cost: "250" }), "The price must be a whole number between $125 and $500 (half to twice Delaware & Hudson's $250 face value)."],
    ["the buyer unfloated", (s) => withCorp(s, PRR, { is_floated: false }), "PRR has not floated and cannot buy a private company."],
    ["the buyer lost its president", (s) => withCorp(s, PRR, { president: null }), "PRR has no president to buy on its behalf."],
    ["the treasury fell below the price", (s) => withCorp(s, PRR, { treasury: "99" }), "PRR's treasury holds $99 — it cannot pay $100."],
  ];
  for (const [label, stale, refusal] of STALE_AT_ANSWER) {
    it(`an acceptance on a stale board is refused, the offer stands unanswered, and a rejection still passes: ${label}`, () => {
      const board = stale(offered());
      // The recorded owner answers when the card is no longer a player's (the fallback exists to let a dead offer be REJECTED).
      expect(answerPrivatePurchaseRefusal(board, { private_id: DH, accept: true }, P2)).toBe(refusal);
      expect(ingress(board, P2, M.answerPrivate(DH, true))).toBe(refusal);
      const after = apply(board, M.answerPrivate(DH, true), P2);
      expect(same(after, board)).toBe(true);
      expect(after.private_purchase_offer?.accepted).toBeUndefined();
      expect(answerPrivatePurchaseRefusal(board, { private_id: DH, accept: false }, P2)).toBeNull();
      expect(apply(board, M.answerPrivate(DH, false), P2).private_purchase_offer).toBeNull();
    });
  }
});

/* ================================================================== */
/* §10: the answerer is re-derived; payload names are narration        */
/* ================================================================== */

describe("§10 (private): the board decides who answers, never the payload", () => {
  it("a proposer who writes himself in as the owner is recorded as the board's owner and still cannot answer", () => {
    const board = apply(base(), M.proposePrivate(DH, PRR, 100, P1), P1);
    expect(board.private_purchase_offer?.owner).toBe(P2);
    expect(ingress(board, P1, M.answerPrivate(DH, true))).toBe("Only the private company's owner can answer that offer.");
    expect(same(apply(board, M.answerPrivate(DH, true), P1), board)).toBe(true);
    // Even the derived settlement the forger would need is refused without an acceptance: the hold passes it only
    // for an accepted offer, and consent is the owner's.
    expect(ingress(board, P1, M.buyPrivate(PRR, DH, "100"))).toContain("nothing else can happen until it is answered or withdrawn");
    expect(privatePurchaseRefusal(board, { buyerId: PRR, privateId: DH, price: 100 }, P1, "settlement")).toBe("p2 has not agreed to sell Delaware & Hudson to PRR — make an offer and wait for the answer.");
  });

  it("the owner changes between proposal and answer: the old owner loses the answer, the new owner holds it", () => {
    const offered = apply(base(), M.proposePrivate(DH, PRR, 100), P1);
    const moved = withPriv(offered, DH, { owner: P3 });
    for (const accept of [true, false]) {
      expect(ingress(moved, P2, M.answerPrivate(DH, accept))).toBe("Only the private company's owner can answer that offer.");
      expect(same(apply(moved, M.answerPrivate(DH, accept), P2), moved)).toBe(true);
    }
    expect(ingress(moved, P3, M.answerPrivate(DH, false))).toBeNull();
    expect(apply(moved, M.answerPrivate(DH, false), P3).private_purchase_offer).toBeNull();
    expect(ingress(moved, P3, M.answerPrivate(DH, true))).toBeNull();
  });

  it("…and the new owner's acceptance of an offer made to the old owner never pays anyone: design §7.4 rule 7 (the recorded owner must still be the owner)", () => {
    /* PINNED AS IMPLEMENTED, FLAGGED FOR THE OWNER. The answer arm does not re-record the owner, so the settlement
       predicate sees an offer recorded for p2 on a card p3 now holds: consent fails and the offer is retired with
       nothing moved. Unreachable in play (the hold freezes every ownership change between proposal and answer). */
    const offered = apply(base(), M.proposePrivate(DH, PRR, 100), P1);
    const moved = withPriv(offered, DH, { owner: P3 });
    const accepted = apply(moved, M.answerPrivate(DH, true), P3);
    expect(accepted.private_purchase_offer).toMatchObject({ owner: P2, accepted: true });
    const owed = nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() })!;
    expect(privatePurchaseRefusal(accepted, { buyerId: PRR, privateId: DH, price: 100 }, P3, "settlement")).toBe("Only PRR's president buys for PRR, and only with p3's consent.");
    const after = apply(accepted, owed.msg, P3);
    expect(differing(accepted, after)).toEqual(["private_purchase_offer"]);
    expect(after.private_purchase_offer).toBeNull();
    expect(priv(after, DH).owner).toBe(P3);
    expect(moneyTotal(after)).toBe(moneyTotal(accepted));
  });

  it("the card becomes a corporation's: the recorded owner may still reject (the fallback), never accept", () => {
    const offered = apply(base(), M.proposePrivate(DH, PRR, 100), P1);
    const corporate = withPriv(offered, DH, { owner: null, owner_protocol_id: NYC });
    expect(ingress(corporate, P2, M.answerPrivate(DH, false))).toBeNull();
    expect(ingress(corporate, P3, M.answerPrivate(DH, false))).toBe("Only the private company's owner can answer that offer.");
    expect(ingress(corporate, P2, M.answerPrivate(DH, true))).toBe("Delaware & Hudson belongs to a corporation, and private companies may be bought by corporations but not sold by them.");
  });
});

/* ================================================================== */
/* Settlement: direct message consent and exactly-once payment          */
/* ================================================================== */

describe("§2 the direct BuyPrivateCompany: legal only when one principal genuinely controls both sides", () => {
  const ownBoard = () => operatingBoard({ privates: [{ id: MH, owner: P1, cost: "110" }, { id: DH, owner: P2, cost: "70" }] });

  it("the actor owns the private AND presides over the buyer: legal at both locks; one payment treasury -> that player, once", () => {
    const board = ownBoard();
    expect(privatePurchaseRefusal(board, { buyerId: PRR, privateId: MH, price: 110 }, P1, "settlement")).toBeNull();
    expect(ingress(board, P1, M.buyPrivate(PRR, MH, "110"))).toBeNull();
    const bought = apply(board, M.buyPrivate(PRR, MH, "110"), P1);
    expect(differing(board, bought)).toEqual(["player_cash", "private_companies", "public_companies"]);
    expect(priv(bought, MH)).toMatchObject({ owner: null, owner_protocol_id: PRR });
    expect(treasury(bought, PRR)).toBe(390);
    expect(cash(bought, P1)).toBe(410);
    expect(moneyConservationBreach(board, bought)).toBeNull();
    // Once and only once: a straggler's second copy finds a corporation's card and moves nothing.
    const twice = apply(bought, M.buyPrivate(PRR, MH, "110"), P1);
    expect(same(twice, bought)).toBe(true);
    expect(ingress(bought, P1, M.buyPrivate(PRR, MH, "110"))).toBe("Mohawk & Hudson belongs to a corporation, and private companies may be bought by corporations but not sold by them.");
  });

  it("the actor controls the buyer only: refused at both locks, nothing moves", () => {
    const board = ownBoard();
    const refusal = "p2 has not agreed to sell Delaware & Hudson to PRR — make an offer and wait for the answer.";
    expect(privatePurchaseRefusal(board, { buyerId: PRR, privateId: DH, price: 100 }, P1, "settlement")).toBe(refusal);
    expect(ingress(board, P1, M.buyPrivate(PRR, DH, "100"))).toBe(refusal);
    expect(same(apply(board, M.buyPrivate(PRR, DH, "100"), P1), board)).toBe(true);
  });

  it("the actor owns the private only: ingress refuses the seat, the reducer refuses the consent", () => {
    const board = ownBoard();
    expect(ingress(board, P2, M.buyPrivate(PRR, DH, "100"))).toBe("It is not your turn.");
    expect(privatePurchaseRefusal(board, { buyerId: PRR, privateId: DH, price: 100 }, P2, "settlement")).toBe("Only PRR's president buys for PRR, and only with p2's consent.");
    expect(same(apply(board, M.buyPrivate(PRR, DH, "100"), P2), board)).toBe(true);
  });

  it("an unrelated actor: refused at both locks", () => {
    const board = ownBoard();
    expect(ingress(board, P3, M.buyPrivate(PRR, DH, "100"))).toBe("It is not your turn.");
    expect(privatePurchaseRefusal(board, { buyerId: PRR, privateId: DH, price: 100 }, P3, "settlement")).toBe("Only PRR's president buys for PRR, and only with p2's consent.");
    expect(same(apply(board, M.buyPrivate(PRR, DH, "100"), P3), board)).toBe(true);
  });

  it("the payee is the CURRENT player owner: a card that moved to the buyer's president is his to sell directly, and he is the one paid", () => {
    const board = withPriv(ownBoard(), DH, { owner: P1 });
    const bought = apply(board, M.buyPrivate(PRR, DH, "70"), P1);
    expect(cash(bought, P1)).toBe(370);
    expect(cash(bought, P2)).toBe(300);
    expect(treasury(bought, PRR)).toBe(430);
  });

  it("every direct-settlement rule is the same predicate: the one-fact rows refuse the direct message too", () => {
    const direct = (board: GameStateResponse, price = "110") => ({ board, msg: M.buyPrivate(PRR, MH, price) });
    const rows: Array<[string, { board: GameStateResponse; msg: unknown }, string]> = [
      ["a Stock Round", direct(withState(ownBoard(), { current_round_type: "StockRound" })), "A corporation buys a private company only during its own turn of an Operating Round."],
      ["phase 2", direct(atPhase(ownBoard(), "2")), "Corporations may buy private companies only during phases 3 and 4."],
      ["closed", direct(withPriv(ownBoard(), MH, { closed: true })), "Mohawk & Hudson has closed and cannot be bought."],
      ["below the band", direct(ownBoard(), "54"), "The price must be a whole number between $55 and $220 (half to twice Mohawk & Hudson's $110 face value)."],
      ["above the band", direct(ownBoard(), "221"), "The price must be a whole number between $55 and $220 (half to twice Mohawk & Hudson's $110 face value)."],
      ["a negative price", direct(ownBoard(), "-110"), "The price must be a whole number between $55 and $220 (half to twice Mohawk & Hudson's $110 face value)."],
      ["treasury short", direct(withCorp(ownBoard(), PRR, { treasury: "109" })), "PRR's treasury holds $109 — it cannot pay $110."],
    ];
    for (const [label, { board, msg }, refusal] of rows) {
      const body = (msg as { BuyPrivateCompany: { price: string } }).BuyPrivateCompany;
      expect([label, privatePurchaseRefusal(board, { buyerId: PRR, privateId: MH, price: body.price }, P1, "settlement")]).toEqual([label, refusal]);
      expect([label, ingress(board, P1, msg)]).toEqual([label, refusal]);
      expect([label, same(apply(board, msg, P1), board)]).toEqual([label, true]);
    }
  });
});

describe("§2 the accepted offer's settlement: what matches, what does not, and the collision with a funding offer", () => {
  const acceptedBoard = () => S.privateOfferStages(base(), DH, 100, P2).accepted;

  it("the exact derived settlement settles at the offer's own terms; the consent is the accepted offer, not the sender", () => {
    const accepted = acceptedBoard();
    // A settlement sent by the buyer's president is the same consented purchase.
    expect(privatePurchaseRefusal(accepted, { buyerId: PRR, privateId: DH, price: 100 }, P1, "settlement")).toBeNull();
    // By an unrelated sender it is still consented (the offer is the consent); ingress asks the seat first.
    expect(privatePurchaseRefusal(accepted, { buyerId: PRR, privateId: DH, price: 100 }, P3, "settlement")).toBeNull();
    expect(ingress(accepted, P3, M.buyPrivate(PRR, DH, "100"))).toBe("It is not your turn.");
  });

  it("the owner changes after acceptance, before the settlement: refused and retired, nothing paid", () => {
    const stale = withPriv(acceptedBoard(), DH, { owner: P3 });
    const after = apply(stale, M.buyPrivate(PRR, DH, "100"), P2);
    expect(differing(stale, after)).toEqual(["private_purchase_offer"]);
    expect(after.private_purchase_offer).toBeNull();
    expect(priv(after, DH).owner).toBe(P3);
    expect(moneyTotal(after)).toBe(moneyTotal(stale));
    expect(nextDerivedAction({ state: after, mapGrid: GRID, emitted: new Set() })).toBeNull();
  });

  const MISMATCHES: Array<[string, unknown]> = [
    ["the price differs", M.buyPrivate(PRR, DH, "120")],
    ["the buyer differs", M.buyPrivate(NYC, DH, "100")],
    ["the private differs", M.buyPrivate(PRR, CA, "100")],
  ];
  for (const [label, msg] of MISMATCHES) {
    it(`a settlement that does not match the accepted offer is held, does NOT retire it, and moves nothing: ${label}`, () => {
      const accepted = acceptedBoard();
      expect(pendingOfferBlock(accepted, msg as never)).toContain("accepted and awaiting settlement");
      expect(ingress(accepted, P1, msg)).toContain("accepted and awaiting settlement");
      const after = apply(accepted, msg, P1);
      expect(same(after, accepted)).toBe(true);
      expect(after.private_purchase_offer).toMatchObject({ accepted: true, price: 100, buyer_protocol_id: PRR, private_id: DH });
      // The board still owes its own settlement, at its own terms.
      expect(nextDerivedAction({ state: after, mapGrid: GRID, emitted: new Set() })?.msg).toEqual({ BuyPrivateCompany: { game_id: 0, protocol_id: PRR, private_id: DH, price: "100" } });
    });
  }

  it("the accepted flag is absent: the settlement is held (only an answer or a withdrawal passes) and nothing is owed", () => {
    const offered = apply(base(), M.proposePrivate(DH, PRR, 100), P1);
    expect(ingress(offered, P1, M.buyPrivate(PRR, DH, "100"))).toBe("PRR's offer of $100 for Delaware & Hudson is waiting for its owner's answer; nothing else can happen until it is answered or withdrawn.");
    expect(same(apply(offered, M.buyPrivate(PRR, DH, "100"), P1), offered)).toBe(true);
    expect(nextDerivedAction({ state: offered, mapGrid: GRID, emitted: new Set() })).toBeNull();
  });

  it("a standing FUNDING offer and an ordinary offer collide at neither lock: neither is proposed beside the other, and neither settles as the other", () => {
    const fundingOffer = { private_id: DH, private_name: "Delaware & Hudson", owner: P2, buyer_protocol_id: PRR, buyer_ticker: "PRR", price: 100, funding: true as const };
    const withFunding = withState(base(), { private_purchase_offer: fundingOffer });
    expect(standingOrdinaryOffer(withFunding)).toBeNull();
    expect(proposePrivatePurchaseRefusal(withFunding, { private_id: CA, buyer_protocol_id: PRR, price: 160 }, P1)).toBe("An offer is already standing; it must be answered or withdrawn before another is made.");
    expect(ingress(withFunding, P1, M.proposePrivate(CA, PRR, 160))).toContain("nothing else can happen until its president answers or the seller withdraws");
    expect(same(apply(withFunding, M.proposePrivate(CA, PRR, 160), P1), withFunding)).toBe(true);
    // The ordinary answer, rescission and settlement never touch a funding offer.
    expect(same(apply(withFunding, M.answerPrivate(DH, true), P2), withFunding)).toBe(true);
    expect(rescindPrivatePurchaseRefusal(withFunding, { private_id: DH }, P1)).toBe("There is no offer to withdraw.");
    expect(same(apply(withFunding, M.rescindPrivate(DH), P1), withFunding)).toBe(true);
    expect(same(apply(withFunding, M.buyPrivate(PRR, DH, "100"), P1), withFunding)).toBe(true);
    expect(nextDerivedAction({ state: withState(withFunding, { private_purchase_offer: { ...fundingOffer, accepted: true } }), mapGrid: GRID, emitted: new Set() })).toBeNull();
    // And the other way: an ordinary offer refuses a funding offer through the hold.
    const ordinary = apply(base(), M.proposePrivate(DH, PRR, 100), P1);
    expect(pendingOfferBlock(ordinary, M.fundingOffer(CA, NYC, 160) as never)).toContain("nothing else can happen");
    expect(same(apply(ordinary, M.fundingOffer(CA, NYC, 160), P3), ordinary)).toBe(true);
  });
});

/* ================================================================== */
/* Rescission of the unanswered offer                                   */
/* ================================================================== */

describe("§2 rescission of an unanswered private offer", () => {
  it("only the buyer's CURRENT president may withdraw; it clears the offer and nothing else", () => {
    const seed = base();
    const offered = apply(seed, M.proposePrivate(DH, PRR, 100), P1);
    for (const actor of [P2, P3]) {
      expect(rescindPrivatePurchaseRefusal(offered, { private_id: DH }, actor)).toBe("Only PRR's president can withdraw its offer.");
      expect(ingress(offered, actor, M.rescindPrivate(DH))).toBe("Only PRR's president can withdraw its offer.");
      expect(same(apply(offered, M.rescindPrivate(DH), actor), offered)).toBe(true);
    }
    expect(ingress(offered, P1, M.rescindPrivate(DH))).toBeNull();
    const withdrawn = apply(offered, M.rescindPrivate(DH), P1);
    // #1597: `offer_serial` records that an offer was made and survives its release; only the offer field itself is cleared.
    expect(differing(seed, withdrawn)).toEqual(["offer_serial", "private_purchase_offer"]);
    expect(differing(offered, withdrawn)).toEqual(["private_purchase_offer"]);
    expect(withdrawn.private_purchase_offer).toBeNull();
    expect(guarded(withdrawn)).toEqual(guarded(seed));
    expect(pendingOfferBlock(withdrawn, M.pass as never)).toBeNull();
    // A presidency that moved under the offer moves the right to withdraw with it.
    const moved = withCorp(offered, PRR, { president: P3 });
    expect(ingress(moved, P1, M.rescindPrivate(DH))).toBe("Only PRR's president can withdraw its offer.");
    expect(ingress(moved, P3, M.rescindPrivate(DH))).toBeNull();
    // A rescission naming another private, or with no offer standing, is refused.
    expect(rescindPrivatePurchaseRefusal(offered, { private_id: CA }, P1)).toBe("That is not the private company on offer.");
    expect(ingress(seed, P1, M.rescindPrivate(DH))).toBe("There is no offer to withdraw.");
    expect(same(apply(seed, M.rescindPrivate(DH), P1), seed)).toBe(true);
  });
});

/* ================================================================== */
/* Residual: an owner that is not a seated player                       */
/* ================================================================== */

describe("§2 residual (reported, not changed): an owner string that is not a seated player", () => {
  it("the predicate reads 'a player' as 'not a corporation' (design §7.4 rule 4); the ledger's unknown-payee refusal is what keeps the money", () => {
    const board = withPriv(base(), DH, { owner: "p9" });
    // Unreachable in play: every owner is written by a seated auction winner or a seated trade buyer.
    expect(privatePurchaseRefusal(board, { buyerId: PRR, privateId: DH, price: 100 }, P1, "proposal")).toBeNull();
    const offered = apply(board, M.proposePrivate(DH, PRR, 100), P1);
    expect(offered.private_purchase_offer?.owner).toBe("p9");
    const accepted = apply(offered, M.answerPrivate(DH, true), "p9");
    const settled = apply(accepted, M.buyPrivate(PRR, DH, "100"), "p9");
    // Nothing moved: the treasury is not debited for a payee the board has no cash row for.
    expect(guarded(settled).money).toEqual(guarded(board).money);
    expect(priv(settled, DH)).toMatchObject({ owner: "p9", owner_protocol_id: null });
    expect(settled.private_purchase_offer).toBeNull();
    expect(stateDigest(withState(settled, { private_purchase_offer: undefined, offer_serial: undefined }))).toBe(stateDigest(board)); // #1597
  });
});

/* ================================================================== */
/* §17: conservation for the treasury -> player family                  */
/* ================================================================== */

describe("§17 (private): conservation on success, whole-state equality on refusal", () => {
  it("moneyTotal is invariant through proposal, acceptance and settlement; every refused step is digest-equal", () => {
    const seed = base();
    const offered = apply(seed, M.proposePrivate(DH, PRR, 100), P1);
    const accepted = apply(offered, M.answerPrivate(DH, true), P2);
    const settled = apply(accepted, M.buyPrivate(PRR, DH, "100"), P2);
    for (const board of [offered, accepted, settled]) expect(moneyTotal(board)).toBe(moneyTotal(seed));
    const refusals: Array<[GameStateResponse, unknown, string]> = [
      [seed, M.proposePrivate(DH, PRR, 141), P1],
      [seed, M.buyPrivate(PRR, DH, "100"), P1],
      [offered, M.answerPrivate(DH, true), P1],
      [offered, M.rescindPrivate(DH), P2],
      [offered, M.pass, P1],
      [accepted, M.answerPrivate(DH, false), P2],
      [accepted, M.buyPrivate(PRR, DH, "99"), P1],
      [settled, M.buyPrivate(PRR, DH, "100"), P2],
    ];
    for (const [board, msg, actor] of refusals) {
      const after = apply(board, msg, actor);
      expect(stateDigest(after)).toBe(stateDigest(board));
      expect(guarded(after)).toEqual(guarded(board));
    }
  });
});
