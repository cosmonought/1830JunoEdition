// frontend/src/gameEngine/privatePurchaseAuthority.ts
//
// The one predicate for a corporation buying a player's private company.
//
// ==================================================================
//  DESIGN NOTE 1591: THE ORDINARY PRIVATE PURCHASE HAS ONE AUTHORITY (Batch 7.4, S7-6 / S7-7 / S7-11 / S7-12)
// ==================================================================
//
// RULEBOOK (1830-RE, Lookout 2018): 3.0 "During phases 3 and 4, a railroad may buy a private company at any
// time during its turn in an operating round"; 3.1 "The price paid may not be less than half or more than
// twice the face value ... and must be publicly declared"; "Private companies may be bought by railroad
// corporations but not sold by them"; "The BO private company may not be sold to any corporation".
//
// WHAT WAS HERE BEFORE. `BuyPrivateCompany` had two checks -- the B&O ban and an owner idempotency guard --
// and the offer messages trusted `owner` from the payload, so a president could take any player's private for
// any price by sending the settlement directly, or name himself as the owner and answer his own offer (the
// design's probe, §6). Batch 7.1 made the money honest (a player seller, a whole non-negative price, a treasury
// that can pay); this note makes the PURCHASE legal.
//
// ONE PREDICATE, THREE MOMENTS. `privatePurchaseRefusal` is asked when the offer is proposed, when the owner
// accepts, and when the derived settlement lands -- and by the direct `BuyPrivateCompany` too. The board it
// judges is the board of that moment, never the proposal's: "it was legal when proposed" is not an authority
// (S7-8). The offer's `owner` field is narration; the private's CURRENT owner is read off the state at every
// one of these moments, which is what closes the forged-counterparty hole.
//
// CONSENT (rule 12). A purchase between two principals needs both. Legal without an offer only in the one
// same-principal case -- the actor is the private's owner AND the buying corporation's president -- which is
// the shell's existing same-president dispatch (#701). Otherwise the settlement must be the derived
// consequence of an ordinary `private_purchase_offer` with `accepted: true` that matches the private, the
// buyer and the price, and whose owner is still the private's owner. A `null` actor (solo play, an
// attribution-less fixture) skips the consent rule, exactly as the stock predicates skip the rules that are
// about a player (#549b); every server and replay entry carries its author.
//
// D-5 IS NOT HERE. The emergency sale (`funding: true`, #1541) keeps `fundingPrivateSaleRefusal` -- its own
// buyer-turn relaxation, its own answerer -- and this predicate never reads a funding offer as consent.

import type { GameStateResponse, PrivatePurchaseOffer } from "./gameState";
import { derivePhase } from "./gamePhase";
import { isSellableToCorporation } from "./baltimorePrivate";
import { privatePriceBounds, privatePurchasePhaseOpen } from "./privatePriceBand";
import { treasuryOf } from "./cashLedger";
import { anyOfferStands, privateSettlementMatches } from "./pendingOfferHold";
import { wholeVgpNumber, type VgpWire } from "./vgpAmount";

/** The operating corporation, read without throwing on a fixture that carries no queue (#232: absent is "not
 *  said"; a board with no queue has nobody operating, and the refusal says so rather than the engine falling
 *  over -- "never a throw in production", 7.1 §7.1). */
function operatingNow(state: GameStateResponse): number | null {
  if (state.current_round_type !== "OperatingRound") return null;
  return (state.active_operating_order ?? [])[state.active_corporation_index] ?? null;
}

export interface PrivatePurchaseIntent {
  buyerId: number;
  privateId: number;
  /** The declared price, as the message or the offer carries it (`VgpWire`). Judged as a whole number. */
  price: VgpWire;
}

/** The moment the predicate is asked at, which decides how consent is read. */
export type PrivatePurchaseMoment =
  /** `ProposePrivatePurchase`: consent is what the proposal is asking for, so none is required yet. */
  | "proposal"
  /** `AnswerPrivatePurchase { accept: true }`: the arm checks the answerer; the board's rules are re-asked. */
  | "answer"
  /** `BuyPrivateCompany`, derived or direct: a matching accepted offer, or one principal on both sides. */
  | "settlement";

/** The ordinary (non-funding) private-purchase offer, or `null`. */
export function ordinaryPrivateOffer(state: GameStateResponse): PrivatePurchaseOffer | null {
  const offer = state.private_purchase_offer ?? null;
  return offer !== null && offer.funding !== true ? offer : null;
}

/** The private's current PLAYER owner, re-derived from the board, or `null` when it is a corporation's, nobody's,
 *  closed, or not on the board. The offer's own `owner` is never consulted for authority. */
export function currentPrivateOwner(state: GameStateResponse, privateId: number): string | null {
  const priv = state.private_companies.find((entry) => entry.private_id === privateId);
  if (!priv || priv.closed) return null;
  if (priv.owner_protocol_id !== null && priv.owner_protocol_id !== undefined) return null;
  return priv.owner ?? null;
}

/** The president of the buying corporation, re-derived, or `null`. */
export function buyerPresident(state: GameStateResponse, buyerId: number): string | null {
  return state.public_companies.find((entry) => entry.company_id === buyerId)?.president ?? null;
}

/** Why this corporation may not buy this private company at this price now, or `null`.
 *
 *  THE ORDER IS THE DESIGN'S (§7.4) AND IT IS LOAD-BEARING: the round and the turn first, because a purchase
 *  outside the buyer's Operating turn is not a purchase whose price is worth discussing; the phase; the card
 *  itself; the price; the buyer's standing and its money; and consent last, because consent is the one rule
 *  the offer machinery supplies rather than the board. The holds (discard, funding, home token, the one-offer
 *  hold) are asked by the callers ahead of this, in the core and at ingress, so a held board reports the hold. */
export function privatePurchaseRefusal(
  state: GameStateResponse,
  intent: PrivatePurchaseIntent,
  actor: string | null | undefined,
  moment: PrivatePurchaseMoment,
): string | null {
  /* ---- 1-3. An Operating Round, the operating corporation, any step of its turn (3.0) ---------- */
  if (state.current_round_type !== "OperatingRound") {
    return "A corporation buys a private company only during its own turn of an Operating Round.";
  }
  const operating = operatingNow(state);
  const buyer = state.public_companies.find((entry) => entry.company_id === intent.buyerId);
  if (!buyer) return "That corporation is not in this game.";
  if (operating !== intent.buyerId) {
    const acting = state.public_companies.find((entry) => entry.company_id === operating);
    return `Only the operating corporation may buy a private company — ${acting?.ticker ?? "nobody"} is operating, not ${buyer.ticker}.`;
  }

  /* ---- 4. Phases 3 and 4 only (3.0) ----------------------------------------------------------- */
  if (!privatePurchasePhaseOpen(derivePhase(state)?.tier ?? null)) {
    return "Corporations may buy private companies only during phases 3 and 4.";
  }

  /* ---- 5-8. The card: exists, open, sellable to a corporation, owned by a player ---------------- */
  const priv = state.private_companies.find((entry) => entry.private_id === intent.privateId);
  if (!priv) return "That private company is not in this game.";
  if (priv.closed) return `${priv.name} has closed and cannot be bought.`;
  if (!isSellableToCorporation(priv.private_id)) return `${priv.name} may never be sold to a corporation.`;
  const owner = currentPrivateOwner(state, priv.private_id);
  if (owner === null) {
    return priv.owner_protocol_id !== null && priv.owner_protocol_id !== undefined
      ? `${priv.name} belongs to a corporation, and private companies may be bought by corporations but not sold by them.`
      : `${priv.name} has no owner to buy it from.`;
  }

  /* ---- 9. A whole price inside the printed band (3.1) ----------------------------------------- */
  /* Stage 10.5 (S10-9): read through `wholeVgpNumber` -- the canonical string or a stored log's legacy number,
     nothing coerced ("1e2", "100.0", " 100" are malformed, not $100). A malformed price is refused with the
     same sentence as an out-of-band one. */
  const price = wholeVgpNumber(intent.price);
  const face = Number(priv.cost) || 0;
  const { min, max } = privatePriceBounds(face);
  if (price === null || price < min || price > max) {
    return `The price must be a whole number between $${min} and $${max} (half to twice ${priv.name}'s $${face} face value).`;
  }

  /* ---- 10-11. A floated, presided buyer whose treasury can pay ---------------------------------- */
  if (!buyer.is_floated) return `${buyer.ticker} has not floated and cannot buy a private company.`;
  if (!buyer.president) return `${buyer.ticker} has no president to buy on its behalf.`;
  const treasury = treasuryOf(state, buyer.company_id);
  if (treasury === null || treasury < price) {
    return `${buyer.ticker}'s treasury holds $${treasury ?? 0} — it cannot pay $${price}.`;
  }

  /* ---- 12. Consent, at settlement only ----------------------------------------------------------
     At a proposal the consent is what is being asked for; at an answer the arm establishes that the answerer
     IS the current owner (re-derived) and that the offer names this transaction. At settlement the consent
     has to be on the board: a matching accepted ordinary offer whose owner is still the owner, or one
     principal on both sides. */
  if (moment !== "settlement") return null;
  if (actor === null || actor === undefined) return null; // #549b: no author, no rule about one
  const offer = ordinaryPrivateOffer(state);
  const consented =
    offer !== null &&
    offer.accepted === true &&
    privateSettlementMatches(offer, { protocol_id: intent.buyerId, private_id: intent.privateId, price }) &&
    owner === offer.owner;
  if (consented) return null;
  if (actor === owner && actor === buyer.president) return null; // one principal on both sides (#701)
  return actor === buyer.president
    ? `${owner} has not agreed to sell ${priv.name} to ${buyer.ticker} — make an offer and wait for the answer.`
    : `Only ${buyer.ticker}'s president buys for ${buyer.ticker}, and only with ${owner}'s consent.`;
}

/* ==================================================================
    THE OFFER'S THREE MESSAGES: WHO PROPOSES, WHO ANSWERS, WHO WITHDRAWS -- RE-DERIVED FROM THE BOARD
   ==================================================================
   Asked in the core (identity) and at ingress (the sentence), so the two locks cannot disagree. A `null`
   actor skips the "who" half and keeps the "what" half, #549b. */

/** Why this proposal may not be made, or `null`. The proposer is the buying corporation's CURRENT president
 *  (#1450); the payload's `owner` is narration. One offer at a time (ruled Q6), never beside a funding offer. */
export function proposePrivatePurchaseRefusal(
  state: GameStateResponse,
  proposal: { private_id: number; buyer_protocol_id: number; price: VgpWire },
  actor: string | null | undefined,
): string | null {
  if (anyOfferStands(state)) return "An offer is already standing; it must be answered or withdrawn before another is made.";
  const buyer = state.public_companies.find((entry) => entry.company_id === proposal.buyer_protocol_id);
  if (!buyer) return "That corporation is not in this game.";
  if (actor != null && buyer.president !== actor) return `Only ${buyer.ticker}'s president can make an offer on its behalf.`;
  return privatePurchaseRefusal(
    state,
    { buyerId: proposal.buyer_protocol_id, privateId: proposal.private_id, price: proposal.price },
    actor,
    "proposal",
  );
}

/** Why this answer may not be given, or `null`. `null` also when there is nothing to answer -- #662: a
 *  duplicate answer is harmless, and the arm changes nothing. The answerer is the private's CURRENT owner. */
export function answerPrivatePurchaseRefusal(
  state: GameStateResponse,
  answer: { private_id: number; accept: boolean },
  actor: string | null | undefined,
): string | null {
  const offer = ordinaryPrivateOffer(state);
  if (offer === null || offer.accepted === true) return null; // settled, withdrawn or already accepted: nothing to answer
  if (offer.private_id !== answer.private_id) return "That is not the private company on offer.";
  const answerer = currentPrivateOwner(state, offer.private_id) ?? offer.owner;
  if (actor != null && actor !== answerer) return "Only the private company's owner can answer that offer.";
  if (!answer.accept) return null;
  return privatePurchaseRefusal(
    state,
    { buyerId: offer.buyer_protocol_id, privateId: offer.private_id, price: offer.price },
    actor,
    "answer",
  );
}

/** Why this withdrawal may not be made, or `null`. Only the buying corporation's CURRENT president, while the
 *  offer stands -- unanswered, or accepted with its settlement not yet landed (the design's hold names the
 *  rescission as passing in both states; in play the settlement is derived in the same burst as the
 *  acceptance, so the second case is reachable only if a settlement was never derived). */
export function rescindPrivatePurchaseRefusal(
  state: GameStateResponse,
  rescind: { private_id: number },
  actor: string | null | undefined,
): string | null {
  const offer = ordinaryPrivateOffer(state);
  if (offer === null) return "There is no offer to withdraw.";
  if (offer.private_id !== rescind.private_id) return "That is not the private company on offer.";
  const president = buyerPresident(state, offer.buyer_protocol_id);
  if (actor != null && actor !== president) return `Only ${offer.buyer_ticker}'s president can withdraw its offer.`;
  return null;
}
