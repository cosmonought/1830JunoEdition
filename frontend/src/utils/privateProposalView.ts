// frontend/src/utils/privateProposalView.ts
//
// The ORDINARY private-company offer (a corporation buying from a player) as `PrivateTradePrompt` shows it.
//
// ==================================================================
//  6.5-B (K-10): ONE OFFER, ONE PROMPT
// ==================================================================
//
// `state.private_purchase_offer` holds two different offers: the ordinary one (a corporation proposes, the private's
// OWNER answers with `AnswerPrivatePurchase`) and the emergency-funding one (#1541: the president offers his own
// private, the BUYING corporation's president answers with `AnswerFundingPrivateOffer`). The shell's derivation read
// the field without asking which, so a funding offer rendered `FundingPrivateOfferPrompt` AND this prompt in the same
// slot -- the second with the direction reversed and a live Accept whose `AnswerPrivatePurchase` the funding hold
// refuses. The funding offer is `FundingPrivateOfferPrompt`'s alone; this view is `null` for it.
//
// Pure and display-only: it reads the offer the reducer wrote and decides nothing about legality.

import type { PrivatePurchaseOffer } from "../gameEngine/gameState";
import { wholeVgpNumber } from "../gameEngine/vgpAmount";
import type { PrivateTradeProposal } from "../components/PrivateTradePanel";

/** The ordinary offer as the prompt shows it, or `null`: no offer, an accepted one (#1247: settled from the seller's
 *  side, nothing left to ask), or a funding offer (K-10: not this prompt's). */
export function ordinaryPrivateProposalView(
  offer: PrivatePurchaseOffer | null | undefined,
  labelFor: (address: string) => string,
): PrivateTradeProposal | null {
  if (!offer || offer.accepted) return null;
  if (offer.funding === true) return null;
  return {
    privateId: offer.private_id,
    privateName: offer.private_name,
    ownerAddress: offer.owner,
    ownerLabel: labelFor(offer.owner),
    buyerProtocolId: offer.buyer_protocol_id,
    buyerTicker: offer.buyer_ticker,
    // Stage 10.5 (S10-9): the prompt shows dollars; the offer may carry either wire spelling.
    price: wholeVgpNumber(offer.price) ?? Number(offer.price),
  };
}
