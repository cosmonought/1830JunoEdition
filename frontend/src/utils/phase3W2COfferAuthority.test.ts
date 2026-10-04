/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W2-C (AUD-09.02 / U-21, AUD-09.03 / U-20): THE OFFER PANELS' AUTHORITY, BOUND
// ==================================================================
//
// `utils/offerAuthorityView.ts` binds the engine's own offer predicates to a board, a seat and the operating
// corporation, for the two Operating Round offer panels. This suite pins, on the Batch 7.4 legal boards:
//
//   - the binding IS the predicate (same answer, same sentence) -- nothing restated;
//   - the private band's 1/2x and 2x edges, the treasury, a corporation-owned private, the B&O, an unsold card,
//     the phase and the operating corporation -- each in the authority's words;
//   - the same-president shortcuts: the private's proposal answer is the purchase's (consent is the only extra
//     settlement rule, and one principal supplies it); the train's is asked of the sale itself at "settlement";
//   - the train roster's floor, treasury, step, train limit and seller-president refusals, and D-6's face-value
//     cap under the v12 funding hold (which W2-A leaves the trade live under);
//   - W2-A's hold outranks the predicate: on a held board the hold view answers, with its own sentence.
//
// The rendered panels are `components/phase3W2COfferPanels.test.tsx`.

import type { GameStateResponse } from "../gameEngine/gameState";
import { privatePurchaseRefusal, proposePrivatePurchaseRefusal } from "../gameEngine/privatePurchaseAuthority";
import { proposeTrainPurchaseRefusal, trainSaleRefusal } from "../gameEngine/trainSaleAuthority";
import { purchasablePrivatesInPlay } from "../components/PrivateTradePanel";
import { dockHoldView } from "./dockHoldView";
import { BO, CA, CO, DH, MH, NYC, operatingBoard, P1, P2, P3, PRR } from "./offerFixtures74";
import { apply, atPhase, corridor, fundingBoard, M, same, withCorp, withPriv, withState } from "./offerMatrix74Support";
import {
  OFFER_BOARD_NOT_LOADED,
  offerPriceForAuthority,
  privateProposalRefusal,
  sellsDirect,
  trainOfferRefusal,
  type OfferAuthorityInput,
} from "./offerAuthorityView";

const LABELS: Record<string, string> = { [P1]: "Ann", [P2]: "Ben", [P3]: "Cy" };
const labelFor = (address: string) => LABELS[address] ?? address;

/** PRR (Ann) operating at Purchase Trains with $500, phase 3. The D&H ($70) is Ben's, the C&A ($160) Cy's, the M&H
 *  ($110) Ann's own, and the B&O private ($100) Ben's. */
const board = (): GameStateResponse =>
  operatingBoard({
    privates: [
      { id: DH, owner: P2, cost: "70" },
      { id: CA, owner: P3, cost: "160" },
      { id: MH, owner: P1, cost: "110" },
      { id: BO, owner: P2, cost: "100" },
    ],
  });

const as = (state: GameStateResponse | null, actor: string = P1, buyerId: number = PRR): OfferAuthorityInput => ({
  state,
  actor,
  buyerId,
  labelFor,
});

const BAND_DH = "The price must be a whole number between $35 and $140 (half to twice Delaware & Hudson's $70 face value).";
const TRAIN_FLOOR = "The price must be a whole number of at least $1 (rulebook 6.6).";

/* ================================================================================================== */
describe("the typed price, as the authority reads it", () => {
  it("hands over the canonical whole-VGP spelling, trimmed of the input's whitespace", () => {
    expect(offerPriceForAuthority("70")).toBe("70");
    expect(offerPriceForAuthority(" 70 ")).toBe("70");
    expect(offerPriceForAuthority("0")).toBe("0");
  });

  it("hands over NaN for anything that is not a whole number -- never a coerced value", () => {
    for (const text of ["", "   ", "70.5", "1e2", "070", "-5", "abc", "0x46"]) {
      expect(offerPriceForAuthority(text)).toBeNaN();
    }
  });
});

/* ================================================================================================== */
describe("Buy Private Company: `proposePrivatePurchaseRefusal`, bound (AUD-09.03 / U-20)", () => {
  it("is the predicate itself -- same answer, same sentence, at every price asked", () => {
    const state = board();
    for (const [privateId, price] of [
      [DH, "35"],
      [DH, "34"],
      [DH, "140"],
      [DH, "141"],
      [CA, "160"],
      [MH, "110"],
      [BO, "100"],
      [DH, Number.NaN],
    ] as Array<[number, string | number]>) {
      expect(privateProposalRefusal(as(state), privateId, price)).toBe(
        proposePrivatePurchaseRefusal(state, { private_id: privateId, buyer_protocol_id: PRR, price }, P1),
      );
    }
  });

  it("the 1/2x band edge: the floor is legal, a dollar under it is refused in the band's own sentence", () => {
    expect(privateProposalRefusal(as(board()), DH, "35")).toBeNull();
    expect(privateProposalRefusal(as(board()), DH, "34")).toBe(BAND_DH);
  });

  it("the 2x band edge: the ceiling is legal, a dollar over it is refused in the same sentence", () => {
    expect(privateProposalRefusal(as(board()), DH, "140")).toBeNull();
    expect(privateProposalRefusal(as(board()), DH, "141")).toBe(BAND_DH);
  });

  it("text that is not a whole number gets the band's sentence too -- the authority's word for a malformed price", () => {
    expect(privateProposalRefusal(as(board()), DH, offerPriceForAuthority("70.5"))).toBe(BAND_DH);
    expect(privateProposalRefusal(as(board()), DH, offerPriceForAuthority(""))).toBe(BAND_DH);
  });

  it("the treasury: what PRR holds is payable, a dollar more is refused; short of the floor, no price is", () => {
    const poor = withCorp(board(), PRR, { treasury: "100" });
    expect(privateProposalRefusal(as(poor), DH, "100")).toBeNull();
    expect(privateProposalRefusal(as(poor), DH, "101")).toBe("PRR's treasury holds $100 — it cannot pay $101.");
    const broke = withCorp(board(), PRR, { treasury: "30" });
    expect(privateProposalRefusal(as(broke), DH, "35")).toBe("PRR's treasury holds $30 — it cannot pay $35.");
  });

  it("a corporation-owned private is not offered, and the authority refuses it even if a stale player owner lingers", () => {
    const owned = withPriv(board(), CA, { owner: null, owner_protocol_id: NYC });
    expect(purchasablePrivatesInPlay(owned.private_companies).map((entry) => entry.private_id)).not.toContain(CA);
    const SENTENCE = "Camden & Amboy belongs to a corporation, and private companies may be bought by corporations but not sold by them.";
    expect(privateProposalRefusal(as(owned), CA, "160")).toBe(SENTENCE);
    const stale = withPriv(board(), CA, { owner: P3, owner_protocol_id: NYC });
    expect(purchasablePrivatesInPlay(stale.private_companies).map((entry) => entry.private_id)).not.toContain(CA);
    expect(privateProposalRefusal(as(stale), CA, "160")).toBe(SENTENCE);
    // And the door agrees: the reducer moves nothing for the proposal a crafted client could still send.
    expect(same(apply(owned, M.proposePrivate(CA, PRR, 160), P1), owned)).toBe(true);
  });

  it("the B&O private and an unsold card are refused at any price, in the authority's words", () => {
    expect(privateProposalRefusal(as(board()), BO, "100")).toBe("Baltimore & Ohio may never be sold to a corporation.");
    const unsold = withPriv(board(), DH, { owner: null });
    expect(privateProposalRefusal(as(unsold), DH, "70")).toBe("Delaware & Hudson has no owner to buy it from.");
  });

  it("asks what the panel never did: the phase, the operating corporation, its current president", () => {
    expect(privateProposalRefusal(as(atPhase(board(), "2")), DH, "70")).toBe(
      "Corporations may buy private companies only during phases 3 and 4.",
    );
    expect(privateProposalRefusal(as(board(), P2, NYC), DH, "70")).toBe(
      "Only the operating corporation may buy a private company — PRR is operating, not NYC.",
    );
    expect(privateProposalRefusal(as(board(), P2), DH, "70")).toBe("Only PRR's president can make an offer on its behalf.");
  });

  it("the same-president shortcut: the proposal's answer is the purchase's (consent is the one extra rule, and Ann gives it)", () => {
    const state = board();
    for (const price of ["55", "110", "220", "54", "221"]) {
      const proposal = privateProposalRefusal(as(state), MH, price);
      const purchase = privatePurchaseRefusal(state, { buyerId: PRR, privateId: MH, price }, P1, "settlement");
      expect([price, proposal]).toEqual([price, purchase]);
    }
    expect(privateProposalRefusal(as(state), MH, "110")).toBeNull();
    // ...which is ONLY true with one principal on both sides: Ben's D&H needs Ben's consent at settlement.
    expect(privateProposalRefusal(as(state), DH, "70")).toBeNull();
    expect(privatePurchaseRefusal(state, { buyerId: PRR, privateId: DH, price: "70" }, P1, "settlement")).not.toBeNull();
  });

  it("no board: the shell's own sentence", () => {
    expect(privateProposalRefusal(as(null), DH, "70")).toBe(OFFER_BOARD_NOT_LOADED);
  });
});

/* ================================================================================================== */
describe("Buy Trains from a Corporation: `proposeTrainPurchaseRefusal` / `trainSaleRefusal`, bound (AUD-09.02 / U-21)", () => {
  const offer = (sellerProtocolId: number, price: string | number, modelType = "3") => ({ sellerProtocolId, modelType, price });

  it("an offer is the proposal predicate itself", () => {
    const state = board();
    for (const price of ["1", "150", "500", "501", "0", Number.NaN] as Array<string | number>) {
      expect(trainOfferRefusal(as(state), offer(NYC, price))).toBe(
        proposeTrainPurchaseRefusal(state, { seller_protocol_id: NYC, buyer_protocol_id: PRR, model_type: "3", price }, P1, undefined),
      );
    }
    expect(sellsDirect(state, PRR, NYC)).toBe(false);
  });

  it("the $1 floor and the treasury, in the authority's words (the panel's `trainPriceError` is gone)", () => {
    expect(trainOfferRefusal(as(board()), offer(NYC, "1"))).toBeNull();
    expect(trainOfferRefusal(as(board()), offer(NYC, "0"))).toBe(TRAIN_FLOOR);
    expect(trainOfferRefusal(as(board()), offer(NYC, offerPriceForAuthority("")))).toBe(TRAIN_FLOOR);
    expect(trainOfferRefusal(as(board()), offer(NYC, offerPriceForAuthority("1.5")))).toBe(TRAIN_FLOOR);
    expect(trainOfferRefusal(as(board()), offer(NYC, "500"))).toBeNull();
    expect(trainOfferRefusal(as(board()), offer(NYC, "501"))).toBe(
      "PRR's treasury holds $500 — it cannot pay $501; the president's money is never used for a voluntary purchase.",
    );
  });

  it("the train limit, the Purchase Trains step and the seller's president -- rules the roster never asked", () => {
    const atLimit = withCorp(board(), PRR, { owned_trains: ["3", "3", "3", "3"] });
    expect(trainOfferRefusal(as(atLimit), offer(NYC, "1"))).toBe("PRR is already at its train limit and may not buy another train.");
    const atTrack = withState(board(), { operating_sub_phase: "Track" });
    expect(trainOfferRefusal(as(atTrack), offer(NYC, "1"))).toBe(
      "PRR may buy a train only at its Purchase Trains step, and an offer is made there too — a train may not run on the turn it is bought (rulebook 6.4).",
    );
    const headless = withCorp(board(), NYC, { president: null });
    expect(trainOfferRefusal(as(headless), offer(NYC, "1"))).toBe("NYC has no president to answer for it.");
    expect(trainOfferRefusal(as(headless), offer(CO, "1"))).toBeNull();
  });

  it("the same-president shortcut is asked of the sale itself, at settlement (the message the shell sends)", () => {
    const shared = withCorp(board(), NYC, { president: P1 });
    expect(sellsDirect(shared, PRR, NYC)).toBe(true);
    for (const price of ["1", "150", "0", "501"]) {
      expect(trainOfferRefusal(as(shared), offer(NYC, price))).toBe(
        trainSaleRefusal(shared, { buyerId: PRR, sellerId: NYC, model: "3", price }, P1, undefined, "settlement"),
      );
    }
    expect(trainOfferRefusal(as(shared), offer(NYC, "150"))).toBeNull();
    // The settlement's own sentence, not the proposal's, proves which predicate was asked.
    expect(trainOfferRefusal(as(shared, P2), offer(NYC, "150"))).toBe(
      "Only PRR's president buys for PRR, and only with NYC's president's consent.",
    );
  });

  it("D-6 under the v12 funding hold: W2-A leaves the trade live, and the authority caps it at face value", () => {
    const grid = corridor();
    const forced = fundingBoard(500);
    expect(dockHoldView({ state: forced, mapGrid: grid, labelFor }).proposeTrainPurchase).toBeNull();
    const input: OfferAuthorityInput = { state: forced, actor: P1, buyerId: CO, mapGrid: grid, labelFor };
    expect(trainOfferRefusal(input, offer(PRR, "180"))).toBeNull();
    expect(trainOfferRefusal(input, offer(PRR, "30"))).toBeNull();
    expect(trainOfferRefusal(input, offer(PRR, "200"))).toBe(
      "When the president contributes, a train bought from another corporation may not cost more than its $180 face value (rulebook 6.6.2).",
    );
  });

  it("no board: the shell's own sentence", () => {
    expect(trainOfferRefusal(as(null), offer(NYC, "1"))).toBe(OFFER_BOARD_NOT_LOADED);
  });
});

/* ================================================================================================== */
describe("W2-A's hold outranks the predicate (the panels ask the hold first)", () => {
  const TRAIN_OFFERED = () => apply(board(), M.proposeTrain(NYC, PRR, "3", "150"), P1);

  it("on a held board the hold view answers both proposals, in the hold's own sentence", () => {
    const hold = dockHoldView({ state: TRAIN_OFFERED(), labelFor });
    expect(hold.proposePrivatePurchase).toBe(
      "PRR's offer of $150 for NYC's 3-train is waiting for the selling president's answer; nothing else can happen until it is answered or withdrawn.",
    );
    expect(hold.proposeTrainPurchase).toBe(hold.proposePrivatePurchase);
  });

  it("the predicate's own one-offer sentence is a different one -- which is why the panels never show it under a hold", () => {
    expect(privateProposalRefusal(as(TRAIN_OFFERED()), DH, "70")).toBe(
      "An offer is already standing; it must be answered or withdrawn before another is made.",
    );
  });

  it("no hold: the hold view is silent and the predicate decides", () => {
    const hold = dockHoldView({ state: board(), labelFor });
    expect([hold.proposePrivatePurchase, hold.proposeTrainPurchase]).toEqual([null, null]);
    expect(privateProposalRefusal(as(board()), DH, "70")).toBeNull();
  });
});
