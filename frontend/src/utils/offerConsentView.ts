// frontend/src/utils/offerConsentView.ts
//
// ==================================================================
//  PHASE 3 W1-D (U-21, K-05, P3-N006): WHO MAY ANSWER, AND WHO MAY WITHDRAW, AN OPERATING-ROUND OFFER
// ==================================================================
//
// The two Operating Round offers -- a corporation buying a player's private (`private_purchase_offer`, ordinary
// kind only) and a corporation buying another corporation's train (`train_purchase_offer`) -- each have exactly two
// parties the authority recognises:
//
//   ANSWERER  the party whose consent is sought. The private's CURRENT owner (`currentPrivateOwner`, falling back
//             to the offer's `owner` exactly as `answerPrivatePurchaseRefusal` does), or the selling corporation's
//             CURRENT president (`sellerPresident`). The offer's own `owner` / `seller_president` fields are what
//             the proposal recorded -- narration -- and are not who the authority lets answer.
//   PROPOSER  the buying corporation's CURRENT president, the only seat `rescindPrivatePurchaseRefusal` /
//             `rescindTrainPurchaseRefusal` let withdraw.
//
// The shell asks these once per board and hands the prompts two booleans. Pure and display-only: it decides
// nothing about legality, and a seat these call the answerer is still refused if the board says otherwise.

import type { GameStateResponse } from "../gameEngine/gameState";
import { buyerPresident, currentPrivateOwner, ordinaryPrivateOffer } from "../gameEngine/privatePurchaseAuthority";
import { sellerPresident } from "../gameEngine/trainSaleAuthority";

/** The title every latched control in the consent prompts carries while the viewer's last action is unconfirmed --
 *  the sentence the shell already hands `PlayerPrivateTradePrompt` for the same state. */
export const CONSENT_IN_FLIGHT_TITLE = "Sending your last action — one moment.";

export interface OfferConsentRoles {
  /** The address the authority lets answer, or `null` when nobody can (a seller with no president). */
  answerer: string | null;
  /** The address the authority lets withdraw (the buying corporation's current president), or `null`. */
  proposer: string | null;
  viewerIsAnswerer: boolean;
  viewerIsProposer: boolean;
}

const NO_ROLES: OfferConsentRoles = { answerer: null, proposer: null, viewerIsAnswerer: false, viewerIsProposer: false };

function rolesFor(answerer: string | null, proposer: string | null, viewer: string | null | undefined): OfferConsentRoles {
  // A watcher has no address and is neither party; an empty address matches nobody (#232).
  const seated = typeof viewer === "string" && viewer.length > 0;
  return {
    answerer,
    proposer,
    viewerIsAnswerer: seated && answerer !== null && answerer === viewer,
    viewerIsProposer: seated && proposer !== null && proposer === viewer,
  };
}

/** The ordinary private offer's parties as `viewer` stands to them. No offer, an accepted one (#1247) or a funding
 *  offer (K-10: `FundingPrivateOfferPrompt`'s) has no roles here. */
export function privateOfferConsentRoles(
  state: GameStateResponse | null | undefined,
  viewer: string | null | undefined,
): OfferConsentRoles {
  if (!state) return NO_ROLES;
  const offer = ordinaryPrivateOffer(state);
  if (offer === null || offer.accepted === true) return NO_ROLES;
  return rolesFor(
    currentPrivateOwner(state, offer.private_id) ?? offer.owner,
    buyerPresident(state, offer.buyer_protocol_id),
    viewer,
  );
}

/** The train offer's parties as `viewer` stands to them. No offer, or an accepted one, has no roles. */
export function trainOfferConsentRoles(
  state: GameStateResponse | null | undefined,
  viewer: string | null | undefined,
): OfferConsentRoles {
  const offer = state?.train_purchase_offer ?? null;
  if (!state || offer === null || offer.accepted === true) return NO_ROLES;
  return rolesFor(
    sellerPresident(state, offer.seller_protocol_id),
    buyerPresident(state, offer.buyer_protocol_id),
    viewer,
  );
}
