// frontend/src/gameEngine/trainSaleAuthority.ts
//
// The one predicate for a corporation buying a train from another corporation.
//
// ==================================================================
//  DESIGN NOTE 1592: THE INTERCORPORATE TRAIN SALE HAS ONE AUTHORITY (Batch 7.4, S7-5 / S7-11 / S7-12, audit M14)
// ==================================================================
//
// RULEBOOK (1830-RE, Lookout 2018): 6.6 "A train may be purchased from another railroad for any price that is
// mutually agreed to by the president(s)"; "The minimum price ... is $1"; "The entire transaction must be
// completed during the purchasing railroad's turn" at the Purchase Trains step; "A railroad may buy another
// railroad's last train"; "If the railroad already meets or exceeds the current phase's limit ... it may not
// purchase a train". 6.1 note: "Purchases must be made with available money. Credit is not allowed." 6.4 note:
// "a train may not run on the turn it is purchased".
//
// WHAT WAS HERE BEFORE. The direct `BuyTrainFromCorporation` needed no offer: a president could take any other
// corporation's train for $0 (the design's probe). The proposal trusted `seller_president` from the payload,
// so the proposer could answer his own offer. Only the limit (Stage 4) and D-6 (Batch 5) were asked.
//
// ONE PREDICATE, THREE MOMENTS: proposal, answer, settlement (derived or direct), always against the current
// board. THE PROPOSAL IS HARDWARE-ONLY TOO (ruled Q5 / D-18): the settlement is derived the instant the seller
// accepts, so a proposal made at Track would settle before Run Trains and let the train run this turn (6.4).
//
// THE MONEY IS THE TREASURY'S ALONE (ruled Q7 / D-20). The president's cash enters only through Batch 5's
// forced path: while `emergencyFundingFor` names the buyer, D-6's `fundedTradeRefusal` is the affordability
// rule -- asked FIRST, exactly as the core has asked it since #1541 -- and the ordinary treasury rule is not.
// Otherwise `treasury >= price`, credit is not allowed. Nothing here changes D-6; the forced path merely gains
// the consent and the timing rules every voluntary sale has.
//
// CONSENT. Legal as a direct message only when the actor presides over BOTH corporations (the shell's
// same-president dispatch); otherwise only as the derived settlement of a `train_purchase_offer` with
// `accepted: true` matching seller, buyer, model AND price. The offer's `seller_president` is narration; the
// selling corporation's CURRENT president is re-derived at every moment. A `null` actor skipped the consent
// rule (#549b) until Stage 10.2; it now meets the board's consent (#1686, below).

import type { GameStateResponse, TrainPurchaseOffer } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { depotCostFor, depotInventory, derivePhase, type TrainTier } from "./gamePhase";
import { countableTrainCount, isTrainLocked } from "./trainLimit";
import { TRAIN_PURCHASE_SUB_PHASE } from "./trainPurchaseGate";
import { emergencyFundingFor, fundedTradeRefusal } from "./emergencyFunding";
import { treasuryOf } from "./cashLedger";
import { anyOfferStands, trainSettlementMatches } from "./pendingOfferHold";
import { ownsOnlyReprievedCopiesOf } from "./gentleRustGrace";

const copiesOwned = (fleet: readonly string[], model: string) => fleet.filter((entry) => entry === model).length;

/** The operating corporation, read without throwing on a fixture that carries no queue (#232: absent is "not
 *  said"; a board with no queue has nobody operating, and the refusal says so rather than the engine falling
 *  over -- "never a throw in production", 7.1 §7.1). */
function operatingNow(state: GameStateResponse): number | null {
  if (state.current_round_type !== "OperatingRound") return null;
  return (state.active_operating_order ?? [])[state.active_corporation_index] ?? null;
}

export interface TrainSaleIntent {
  buyerId: number;
  sellerId: number;
  model: string;
  /** As the message or the offer carries it (a string on the wire, #701). Judged as a whole number >= 1. */
  price: number | string;
  /** UR-4 (OD-UR-5(c) = 5c-2): the copy named -- `true` the gold-trimmed one, `false` an ordinary one, absent unnamed.
   *  See `resolveSaleCopy`. */
  gilded?: boolean;
}

/* ==================================================================
    UR-4 (OD-UR-5(c) = 5c-2, backlog D-48): THE SALE NAMES THE COPY -- A MULTISET CHOICE, NEVER A TRAIN IDENTITY
   ==================================================================
   OWNER RULING: "If the selling corporation owns a gilded copy and an ordinary copy of model X, the sale must
   distinguish which copy is sold: selling the ordinary copy does NOT trigger the Blood Price and does not purify or
   remove the gilded copy; selling the gilded copy DOES trigger the Blood Price."
   WHAT WAS HERE BEFORE (UR-F21): nothing. The sale named a MODEL, and the Blood Price was "the seller's gilding names
   the model" (`isCarcosanTransfer`) -- so a corporation holding a real 6 beside its gilded 6 could not sell the real
   one without paying the Blood Price, being absolved and burning the gilding off the copy it kept.
   THE SMALLEST REPRESENTATION THAT SAYS IT. Copies of one model are interchangeable except for two multiset marks
   the seller already carries (`gameState.ts` #1089): the gilding (`carcosan_trains`) and a Gentle Rust reprieve
   (`pending_rust_trains`, which GR-2 already keeps off the market, #1700). So the only question a sale can leave open
   is "the gilded copy or an ordinary one", and one optional boolean on the message answers it -- the same multiset
   reading `exchangeableTrains` gives the Diesel trade-in (OD-UR-7) and #1700 gives the reprieve. No train identity is
   introduced anywhere; the stored log gains one optional field on a message only a Carcosan seller ever needs it on.
   ABSENT IS STILL LEGAL WHERE IT CANNOT BE AMBIGUOUS -- a seller holding only gilded copies of the model (then it is the
   Blood Price, as it always was) or only ordinary ones (then it is the ordinary sale every message before UR-4 was).
   Where it could be either, an unnamed sale is REFUSED, atomically, at every moment (proposal, answer, settlement):
   the authority does not guess which copy a president meant, and the client that sends it is told why. */

/** The copies of `model` a seller could part with, by kind: gold-trimmed, and ordinary (neither gilded nor on a
 *  Gentle Rust Final Run). Multisets throughout -- `min` guards a board whose marks outnumber its trains. */
export function saleCopies(
  seller: { owned_trains?: readonly string[] | null; carcosan_trains?: readonly string[] | null; pending_rust_trains?: readonly string[] | null },
  model: string,
): { gilded: number; ordinary: number } {
  const owned = copiesOwned(seller.owned_trains ?? [], model);
  const gilded = Math.min(owned, copiesOwned(seller.carcosan_trains ?? [], model));
  const reprieved = copiesOwned(seller.pending_rust_trains ?? [], model);
  return { gilded, ordinary: Math.max(0, owned - gilded - reprieved) };
}

/** Which copy this sale takes -- `"gilded"` (the Blood Price) or `"ordinary"` -- or `null` when the request names a copy
 *  the seller does not hold, or names none where both kinds are held (ambiguous). An unnamed sale of a model with no
 *  gilded copy is `"ordinary"` whatever else is true of it; whether the seller can sell at all is asked elsewhere. */
export function resolveSaleCopy(
  seller: Parameters<typeof saleCopies>[0] | null | undefined,
  model: string,
  gilded: boolean | undefined,
): "gilded" | "ordinary" | null {
  const copies = saleCopies(seller ?? {}, model);
  if (gilded === true) return copies.gilded > 0 ? "gilded" : null;
  if (gilded === false) return copies.ordinary > 0 ? "ordinary" : null;
  if (copies.gilded > 0 && copies.ordinary > 0) return null;
  return copies.gilded > 0 ? "gilded" : "ordinary";
}

/** The refusal `resolveSaleCopy`'s `null` stands for, in the words a president reads, or `null`. */
export function saleCopyRefusal(
  seller: Parameters<typeof saleCopies>[0] & { ticker?: string | null },
  model: string,
  gilded: boolean | undefined,
): string | null {
  if (resolveSaleCopy(seller, model, gilded) !== null) return null;
  const ticker = seller.ticker ?? "This corporation";
  if (gilded === true) return `${ticker} holds no gold-trimmed ${model}-train to sell.`;
  if (gilded === false) {
    return `Every ${model}-train ${ticker} holds is gold-trimmed by Carcosa — selling it is the Blood Price, so the sale must name the gold-trimmed copy.`;
  }
  return `${ticker} holds both a gold-trimmed and an ordinary ${model}-train; the sale must name which copy is sold (selling the gold-trimmed one is the Blood Price).`;
}

export type TrainSaleMoment = "proposal" | "answer" | "settlement";

/** The seller's current president, re-derived from the board, or `null`. */
export function sellerPresident(state: GameStateResponse, sellerId: number): string | null {
  return state.public_companies.find((entry) => entry.company_id === sellerId)?.president ?? null;
}

/** The train limit in force -- the phase's, as `buyDepotTrain` and the #1513 gate read it. */
function trainLimitInForce(state: GameStateResponse): number | null {
  const phase = derivePhase(state);
  if (phase && phase.known) return phase.trainLimit;
  return depotInventory(state).find((row) => row.isCurrent)?.trainLimit ?? null;
}

/** Why this intercorporate sale may not be made now, or `null`. */
export function trainSaleRefusal(
  state: GameStateResponse,
  intent: TrainSaleIntent,
  actor: string | null | undefined,
  mapGrid: MapGridResponse | undefined,
  moment: TrainSaleMoment,
): string | null {
  const buyer = state.public_companies.find((entry) => entry.company_id === intent.buyerId);
  const seller = state.public_companies.find((entry) => entry.company_id === intent.sellerId);
  if (!buyer) return "The buying corporation is not in this game.";
  if (!seller) return "The selling corporation is not in this game.";
  const price = Number(intent.price);

  /* ---- 1. D-6 FIRST, exactly where the core has asked it since #1541 --------------------------- */
  const funding = emergencyFundingFor(state, mapGrid);
  if (funding !== null && Number.isFinite(price)) {
    const face = depotCostFor(state, intent.model as TrainTier);
    const forced = fundedTradeRefusal(state, funding, intent.buyerId, price, Number.isFinite(face) ? face : null);
    if (forced !== null) return forced;
  }

  /* ---- 2-3. The buyer's own Operating turn, at the Purchase Trains step (6.6 / 6.4) ------------ */
  if (state.current_round_type !== "OperatingRound") {
    return "Trains are bought from other corporations only during the buyer's turn of an Operating Round.";
  }
  const operating = operatingNow(state);
  if (operating !== intent.buyerId) {
    const acting = state.public_companies.find((entry) => entry.company_id === operating);
    return `Only the operating corporation may buy a train — ${acting?.ticker ?? "nobody"} is operating, not ${buyer.ticker}.`;
  }
  if (state.operating_sub_phase !== TRAIN_PURCHASE_SUB_PHASE) {
    return `${buyer.ticker} may buy a train only at its Purchase Trains step, and an offer is made there too — a train may not run on the turn it is bought (rulebook 6.4).`;
  }

  /* ---- 4-6. Two corporations; the seller owns the train and is able to sell it ------------------ */
  if (intent.buyerId === intent.sellerId) return `${buyer.ticker} cannot buy a train from itself.`;
  if (!seller.is_floated) return `${seller.ticker} has not floated and has no train to sell.`;
  if (seller.owned_trains == null || !seller.owned_trains.includes(intent.model)) {
    return `${seller.ticker} does not own a ${intent.model}-train to sell.`;
  }
  /* DESIGN NOTE 1700 (GR-2, OD-GR-1): A REPRIEVED TRAIN IS NOT FOR SALE. The seller must hold a copy of the model
     that no Gentle Rust mark covers -- owned copies minus marked copies, by multiplicity (`gentleRustGrace.ts`),
     so an ordinary 4 beside a reprieved 4 is still saleable and the sale takes the ordinary one, leaving the mark
     and its train at home. Asked here, beside "owns the train", so all three moments (proposal, answer,
     settlement) and the Blood Price's `isCarcosanSale` see it, and a refused sale moves nothing. Before the
     settlement arm touches money, fleets or the chart, and without looking ahead: only a rust that has already
     happened has written a mark. */
  if (ownsOnlyReprievedCopiesOf(seller, intent.model)) {
    // #1702 (GR-3): the sentence lives in `reprievedSaleReason` below, so the offer roster greys with these words.
    return reprievedSaleReason(seller, intent.model) as string;
  }
  /* UR-4 (OD-UR-5(c) = 5c-2): AND THE COPY. A named copy the seller does not hold, or an unnamed sale where the seller
     holds both a gold-trimmed and an ordinary copy, is refused here -- beside "owns the train", so the proposal, the
     answer, the settlement and the Blood Price's chart step all refuse it together and nothing moves. */
  const copyRefusal = saleCopyRefusal(seller, intent.model, intent.gilded);
  if (copyRefusal !== null) return copyRefusal;

  /* ---- 7. A whole price of at least $1 (6.6) -------------------------------------------------- */
  if (!Number.isInteger(price) || price < 1) {
    return "The price must be a whole number of at least $1 (rulebook 6.6).";
  }

  /* ---- 8. The treasury alone pays (6.1 note; ruled Q7), unless D-6 already answered ------------ */
  const forcedBuyer = funding !== null && funding.companyId === intent.buyerId;
  if (!forcedBuyer) {
    const treasury = treasuryOf(state, buyer.company_id);
    if (treasury === null || treasury < price) {
      return `${buyer.ticker}'s treasury holds $${treasury ?? 0} — it cannot pay $${price}; the president's money is never used for a voluntary purchase.`;
    }
  }

  /* ---- 9. The train limit in force (6.6; Stage 4's gate, unchanged) ---------------------------- */
  if (buyer.owned_trains != null) {
    const countable = countableTrainCount(buyer.owned_trains, buyer.pending_rust_trains, buyer.carcosan_trains);
    if (isTrainLocked(countable, trainLimitInForce(state))) {
      return `${buyer.ticker} is already at its train limit and may not buy another train.`;
    }
  }

  /* ---- 10. Consent, at settlement only ---------------------------------------------------------- */
  if (moment !== "settlement") return null;
  /* ==================================================================
      DESIGN NOTE 1686 (Stage 10.2, S10-20): AN AUTHOR-LESS SETTLEMENT GETS NO CONSENT EXEMPTION
     ==================================================================
     This line was `if (actor == null) return null` (#549b: rules about a player are not asked of nobody), and it
     stood BEFORE the consent question -- so an unattributed `BuyTrainFromCorporation` needed no consent at all.
     After one legitimate settlement retires the accepted offer, a second author-less copy found no offer, skipped
     consent, and -- the seller still holding another train of that model -- sold it (Batch 7.4's "residual
     #549b"). Unreachable through a room (every transport and derived entry carries its author) but reachable
     wherever an actor is absent: solo play and fixtures.
     CONSENT IS A FACT ABOUT THE BOARD, NOT ABOUT THE SENDER, so it can be asked without an author: a matching
     accepted offer stands, or ONE president sits over both corporations (the shell's same-president direct buy,
     which is the only direct sale #1592 admits). With an author, the author must additionally BE that president
     (below, unchanged). Without one, the board's own answer stands in for him -- and a board with neither an
     offer nor a common president has no consent to give, whoever sent the message. */
  const offer: TrainPurchaseOffer | null = state.train_purchase_offer ?? null;
  const consented =
    offer !== null &&
    offer.accepted === true &&
    trainSettlementMatches(offer, {
      buyer_protocol_id: intent.buyerId,
      seller_protocol_id: intent.sellerId,
      model_type: intent.model,
      price,
      gilded: intent.gilded, // UR-4: the seller agreed to THIS copy, not to the model
    });
  if (consented) return null;
  if (actor === null || actor === undefined) {
    // #1686: no author -- the board's consent only: one president over both sides.
    if (buyer.president !== null && buyer.president !== undefined && buyer.president === seller.president) return null;
    return `${seller.ticker}'s president has not agreed to sell its ${intent.model}-train to ${buyer.ticker}, and no accepted offer covers this sale.`;
  }
  const presidesBoth = actor === buyer.president && actor === seller.president && buyer.president !== null;
  if (presidesBoth) return null;
  return actor === buyer.president
    ? `${seller.ticker}'s president has not agreed to sell its ${intent.model}-train to ${buyer.ticker} — make an offer and wait for the answer.`
    : `Only ${buyer.ticker}'s president buys for ${buyer.ticker}, and only with ${seller.ticker}'s president's consent.`;
}

/* ==================================================================
    THE OFFER'S THREE MESSAGES, RE-DERIVED FROM THE BOARD (the private-purchase shape, #1591)
   ================================================================== */

/** Why this proposal may not be made, or `null`. The proposer is the buying corporation's CURRENT president;
 *  the payload's `seller_president` is narration. One offer at a time (ruled Q6). */
export function proposeTrainPurchaseRefusal(
  state: GameStateResponse,
  proposal: { seller_protocol_id: number; buyer_protocol_id: number; model_type: string; price: number | string; gilded?: boolean },
  actor: string | null | undefined,
  mapGrid: MapGridResponse | undefined,
): string | null {
  if (anyOfferStands(state)) return "An offer is already standing; it must be answered or withdrawn before another is made.";
  const buyer = state.public_companies.find((entry) => entry.company_id === proposal.buyer_protocol_id);
  if (!buyer) return "That corporation is not in this game.";
  if (actor != null && buyer.president !== actor) return `Only ${buyer.ticker}'s president can make an offer on its behalf.`;
  if (sellerPresident(state, proposal.seller_protocol_id) === null) {
    const seller = state.public_companies.find((entry) => entry.company_id === proposal.seller_protocol_id);
    return `${seller?.ticker ?? "That corporation"} has no president to answer for it.`;
  }
  return trainSaleRefusal(
    state,
    {
      buyerId: proposal.buyer_protocol_id,
      sellerId: proposal.seller_protocol_id,
      model: proposal.model_type,
      price: proposal.price,
      gilded: proposal.gilded, // UR-4: the copy on offer
    },
    actor,
    mapGrid,
    "proposal",
  );
}

/** Why this answer may not be given, or `null` (also `null` when nothing is there to answer, #701/#662). The
 *  answerer is the selling corporation's CURRENT president. */
export function answerTrainPurchaseRefusal(
  state: GameStateResponse,
  answer: { seller_protocol_id: number; accept: boolean },
  actor: string | null | undefined,
  mapGrid: MapGridResponse | undefined,
): string | null {
  const offer = state.train_purchase_offer ?? null;
  if (offer === null || offer.accepted === true) return null;
  if (offer.seller_protocol_id !== answer.seller_protocol_id) return "That is not the corporation whose train is on offer.";
  const answerer = sellerPresident(state, offer.seller_protocol_id);
  if (answerer === null) return `${offer.seller_ticker} has no president to answer for it.`;
  if (actor != null && actor !== answerer) return "Only the selling corporation's president can answer that offer.";
  if (!answer.accept) return null;
  return trainSaleRefusal(
    state,
    { buyerId: offer.buyer_protocol_id, sellerId: offer.seller_protocol_id, model: offer.model_type, price: offer.price, gilded: offer.gilded },
    actor,
    mapGrid,
    "answer",
  );
}

/** Why this withdrawal may not be made, or `null`: the buyer's CURRENT president, while the offer stands
 *  (unanswered, or accepted and not yet settled -- see `rescindPrivatePurchaseRefusal`). */
export function rescindTrainPurchaseRefusal(
  state: GameStateResponse,
  rescind: { seller_protocol_id: number },
  actor: string | null | undefined,
): string | null {
  const offer = state.train_purchase_offer ?? null;
  if (offer === null) return "There is no train offer to withdraw.";
  if (offer.seller_protocol_id !== rescind.seller_protocol_id) return "That is not the corporation whose train is on offer.";
  const president = state.public_companies.find((entry) => entry.company_id === offer.buyer_protocol_id)?.president ?? null;
  if (actor != null && actor !== president) return `Only ${offer.buyer_ticker}'s president can withdraw its offer.`;
  return null;
}

/** ==================================================================
 *   DESIGN NOTE 1702 (GR-3, U-11): THE ROSTER GREYS WHAT THIS AUTHORITY REFUSES, IN ITS WORDS
 *  ==================================================================
 *  GR-2 (#1700) made `trainSaleRefusal` refuse a Final Run train at proposal, answer and settlement, and the
 *  offer roster went on offering it -- the refusal arrived as a surprise after the click. The roster now greys the
 *  copies a mark covers (`finalRunPositions`, the chips' order) and shows this sentence. Extracted rather than
 *  restated: when every copy of the model is reprieved it IS the refusal's sentence, byte for byte, and
 *  `trainSaleRefusal` returns it from here.
 *  MULTISET, NEVER A MODEL-LEVEL FREEZE (#1700): beside an ordinary copy of the same model the reprieved one is
 *  explained, and the ordinary one stays saleable -- the refusal answers `null` for that model, and so does the
 *  roster's button for that copy. `null` here when no copy of `model` is reprieved. */
export function reprievedSaleReason(
  seller: { ticker?: string | null; owned_trains?: readonly string[] | null; pending_rust_trains?: readonly string[] | null },
  model: string,
): string | null {
  const owned = copiesOwned(seller.owned_trains ?? [], model);
  const marked = copiesOwned(seller.pending_rust_trains ?? [], model);
  if (owned === 0 || marked === 0) return null;
  const ticker = seller.ticker ?? "This corporation";
  if (ownsOnlyReprievedCopiesOf(seller, model)) {
    return owned > 1
      ? `Every ${model}-train ${ticker} holds is on its Gentle Rust final run — none can be sold to another corporation.`
      : `${ticker}'s ${model}-train is on its Gentle Rust final run — it cannot be sold to another corporation.`;
  }
  const free = owned - marked;
  return marked === 1
    ? `One of ${ticker}'s ${model}-trains is on its Gentle Rust final run and cannot be sold to another corporation; ${free === 1 ? "the other" : "the others"} can.`
    : `${marked} of ${ticker}'s ${model}-trains are on their Gentle Rust final run and cannot be sold to another corporation; ${free === 1 ? "one" : free} can.`;
}

/** ==================================================================
 *   UR-4 (OD-UR-5(c) = 5c-2): WHICH ROSTER BADGES ARE THE GOLD-TRIMMED COPY
 *  ==================================================================
 *  The offer roster draws one badge per train (#282) and must let a buyer choose between the seller's gilded copy (the
 *  Blood Price) and an ordinary copy of the same model. The gilding is a multiset beside `owned_trains`, so which
 *  badge is "the" gilded one is a convention -- the one `TrainBadges` (#1088) and `finalRunPositions` (#1702) already
 *  use: the marks are consumed in roster order, first match first. The choice the badge sends is the COPY KIND
 *  (`gilded: true / false`), never the position, so the convention decides only which badge wears the gold. */
export function gildedSalePositions(company: {
  owned_trains?: readonly string[] | null;
  carcosan_trains?: readonly string[] | null;
}): boolean[] {
  const marks = [...(company.carcosan_trains ?? [])];
  return (company.owned_trains ?? []).map((model) => {
    const at = marks.indexOf(model);
    if (at < 0) return false;
    marks.splice(at, 1);
    return true;
  });
}
