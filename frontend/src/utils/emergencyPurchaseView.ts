// frontend/src/utils/emergencyPurchaseView.ts
//
// What the Emergency Train Purchase surface shows, and to whom -- read off the authority, never restated.
//
// ==================================================================
//  PHASE 3 W2-G: THE GUIDED, NON-DISMISSIBLE EMERGENCY PURCHASE (owner ruling, OD-4 / OD-1 viewer scope)
// ==================================================================
//
// THE RULING, in the order the president meets it:
//   1. The corporation owes a train and its treasury cannot pay for the required one (`emergencyFundingFor`).
//   2. The president is first shown the legal opportunity to buy a train from another corporation (6.6.2 "another
//      railroad using the normal rules", under the owner's funded-trade simplification -- `fundedTradeRefusal`).
//   3. The president may Skip that opportunity. Before Skip, a consequence warning; a PROMINENT one whenever the
//      current authority can already establish that skipping leaves no assured funding path.
//   4. The Bank / Bank Pool purchase: the whole treasury and the president's cash are applied automatically, and
//      shown as figures -- the player never types them.
//   5. Still short: the president chooses which LEGAL shares to sell, one actual sale at a time; the shortfall and
//      the legal bundles are re-read from the authority after every sale.
//   6. The optional private-company sale (#1541) stays where the authority allows it.
//   7. Bankruptcy is the authority's result, never a player's button.
//   8. The president cannot close the surface; the authoritative hold stands until purchase or bankruptcy.
//
// VIEWER SCOPE (OD-1): only the obligated president, on a non-spectating screen, gets the interactive surface. Every
// other seat and every watcher gets one read-only sentence naming who the table is waiting on.
//
// NOTHING HERE IS A RULE. Every legality below is a call into the authority (`proposeTrainPurchaseRefusal`,
// `rescindTrainPurchaseRefusal`, `fundingPrivateOfferRefusal`, `fundingPrivateAnswerRefusal`); this file only chooses
// the questions and phrases the answers. The one inference it makes -- "a trade legal at $1 is legal at some price,
// and refused at $1 is refused at every price" -- is a reading of the authority's own price arms: every price rule
// it applies to a forced buyer (a whole number of at least $1; treasury plus the president's cash; the face-value cap
// when the president contributes) is monotone, so the lowest price is the most permissive one. The refusal shown for
// an actual offer is always the authority's verdict on THAT price.

import type { GameStateResponse, TrainPurchaseOffer } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { EmergencyFunding } from "../gameEngine/emergencyFunding";
import { fundingPrivateAnswerRefusal, fundingPrivateOfferRefusal } from "../gameEngine/emergencyFunding";
import { proposeTrainPurchaseRefusal, rescindTrainPurchaseRefusal, saleCopies, sellerPresident } from "../gameEngine/trainSaleAuthority";
import { depotCostFor, type TrainTier } from "../gameEngine/gamePhase";
import { homeStationViewerIsPresident } from "./homeStationAskView";

/* ------------------------------------------------------------------ */
/* Viewer scope                                                          */
/* ------------------------------------------------------------------ */

/** True only for the obligated president's own, non-spectating screen. THE SAME RULE as the home-station ask
 *  (W1-J, `homeStationAskView.ts`): not spectating, the board names a president, and that president is this viewer.
 *  A seatless watcher's id is `""` and never matches. Delegated rather than restated, so the two forced surfaces
 *  cannot disagree about who "the president's screen" is. */
export function emergencyViewerIsPresident(input: {
  spectator: boolean;
  president: string | null | undefined;
  viewerAddress: string | null | undefined;
}): boolean {
  return homeStationViewerIsPresident(input);
}

/** The read-only sentence every other seat and every watcher sees. Names whoever the table is actually waiting on:
 *  the obligated president, or -- while an offer the obligation made stands -- the president who must answer it. */
export function emergencyWaitingSentence(input: {
  ticker: string;
  presidentLabel: string;
  /** The emergency private offer standing, if any: the BUYING corporation's president answers it. */
  privateOffer: { privateName: string; buyerTicker: string; buyerPresidentLabel: string } | null;
  /** The obligated corporation's offer for another corporation's train, if one stands: its SELLER answers it. */
  trainOffer: { sellerTicker: string; model: string; price: string; sellerPresidentLabel: string; accepted: boolean } | null;
}): string {
  const head = `${input.ticker} is resolving an emergency train purchase`;
  if (input.privateOffer) {
    return `${head} — ${input.privateOffer.privateName} is on offer to ${input.privateOffer.buyerTicker}; waiting on ${input.privateOffer.buyerPresidentLabel}.`;
  }
  if (input.trainOffer && !input.trainOffer.accepted) {
    return `${head} — it has offered $${input.trainOffer.price} for ${input.trainOffer.sellerTicker}'s ${input.trainOffer.model}-train; waiting on ${input.trainOffer.sellerPresidentLabel}.`;
  }
  return `${head} — waiting on ${input.presidentLabel}.`;
}

/* ------------------------------------------------------------------ */
/* Where the required train comes from (K-25)                            */
/* ------------------------------------------------------------------ */

/** "Bank Pool" or "Bank Depot", from the required train's ACTUAL source (`PurchasableTrain.source`). K-25: the modal
 *  said "Bank Depot" for a pooled train. */
export function trainSourceName(source: "depot" | "pool"): "Bank Pool" | "Bank Depot" {
  return source === "pool" ? "Bank Pool" : "Bank Depot";
}

/* ------------------------------------------------------------------ */
/* Step 2: buying from another corporation                              */
/* ------------------------------------------------------------------ */

export interface IntercorporateOption {
  /** Stable key for a select: seller, model and copy. */
  key: string;
  sellerId: number;
  sellerTicker: string;
  sellerPresident: string | null;
  model: string;
  /** UR-4: `true`/`false` only where the seller holds both kinds of copy and the sale must name one. */
  gilded?: boolean;
  /** The gold-trimmed copy: selling it is the Blood Price. Display only. */
  bloodPrice: boolean;
  /** The train's face value -- the cap when the president contributes (6.6.2). `null` when the board prices none. */
  faceValue: number | null;
  /** The authority's refusal at the minimum price ($1), or `null`: legal at some price. */
  refusal: string | null;
}

export interface IntercorporateStep {
  /** Every candidate train, legal or not, each with the authority's sentence. */
  options: IntercorporateOption[];
  /** The candidates the authority admits at some price. */
  legal: IntercorporateOption[];
  /** The obligated corporation's own standing offer for another corporation's train, if any. */
  standingOffer: TrainPurchaseOffer | null;
  /** Who answers that offer: the selling corporation's CURRENT president (the offer's own field is narration). */
  standingOfferAnswerer: string | null;
  /** The authority's refusal of withdrawing that offer (by this viewer), or `null` when Withdraw is legal. */
  rescindRefusal: string | null;
  /** What the corporation and its president can put toward a traded train without selling anything. */
  treasury: number;
  presidentCash: number;
}

/** The trains the obligated corporation could buy from another corporation, each judged by the authority. */
export function intercorporateStepFor(
  state: GameStateResponse,
  funding: EmergencyFunding,
  mapGrid: MapGridResponse | undefined,
  actor: string | null | undefined,
): IntercorporateStep {
  const options: IntercorporateOption[] = [];
  for (const seller of state.public_companies) {
    if (seller.company_id === funding.companyId) continue;
    const fleet = seller.owned_trains ?? [];
    const models = Array.from(new Set(fleet));
    for (const model of models) {
      const copies = saleCopies(seller, model);
      /* UR-4: name the copy only where the seller holds both kinds -- an unnamed sale is the ordinary one where the
         authority would resolve it unambiguously (`resolveSaleCopy`). */
      const variants: Array<{ gilded?: boolean; bloodPrice: boolean }> =
        copies.gilded > 0 && copies.ordinary > 0
          ? [{ gilded: false, bloodPrice: false }, { gilded: true, bloodPrice: true }]
          : [{ bloodPrice: copies.gilded > 0 && copies.ordinary === 0 }];
      for (const variant of variants) {
        const face = depotCostFor(state, model as TrainTier);
        const refusal = proposeTrainPurchaseRefusal(
          state,
          {
            seller_protocol_id: seller.company_id,
            buyer_protocol_id: funding.companyId,
            model_type: model,
            price: 1,
            ...(variant.gilded === undefined ? {} : { gilded: variant.gilded }),
          },
          actor,
          mapGrid,
        );
        options.push({
          key: `${seller.company_id}:${model}:${variant.gilded === undefined ? "-" : variant.gilded ? "g" : "o"}`,
          sellerId: seller.company_id,
          sellerTicker: seller.ticker,
          sellerPresident: sellerPresident(state, seller.company_id),
          model,
          ...(variant.gilded === undefined ? {} : { gilded: variant.gilded }),
          bloodPrice: variant.bloodPrice,
          faceValue: Number.isFinite(face) && face > 0 ? face : null,
          refusal,
        });
      }
    }
  }
  const offer = state.train_purchase_offer ?? null;
  const standingOffer = offer !== null && offer.buyer_protocol_id === funding.companyId ? offer : null;
  return {
    options,
    legal: options.filter((option) => option.refusal === null),
    standingOffer,
    standingOfferAnswerer: standingOffer === null ? null : sellerPresident(state, standingOffer.seller_protocol_id),
    rescindRefusal:
      standingOffer === null
        ? null
        : rescindTrainPurchaseRefusal(state, { seller_protocol_id: standingOffer.seller_protocol_id }, actor),
    treasury: funding.treasury,
    presidentCash: funding.presidentCash,
  };
}

/** The authority's verdict on one concrete offer the president has composed, or `null` when it may be made. The
 *  price is judged as typed (a non-whole or empty entry is refused by the authority's own price arm). */
export function intercorporateOfferRefusal(
  state: GameStateResponse,
  funding: EmergencyFunding,
  mapGrid: MapGridResponse | undefined,
  actor: string | null | undefined,
  draft: { sellerId: number; model: string; gilded?: boolean; price: string },
): string | null {
  const trimmed = draft.price.trim();
  if (trimmed.length === 0) return "Enter a price.";
  /* Kept as the wire's string; `trainSaleRefusal` reads it with `Number()` and refuses anything that is not a whole
     number of at least $1. A string of digits only, so "1e3" or "0x10" cannot slip through `Number()`. */
  if (!/^\d+$/.test(trimmed)) return "The price must be a whole number of at least $1 (rulebook 6.6).";
  return proposeTrainPurchaseRefusal(
    state,
    {
      seller_protocol_id: draft.sellerId,
      buyer_protocol_id: funding.companyId,
      model_type: draft.model,
      price: trimmed,
      ...(draft.gilded === undefined ? {} : { gilded: draft.gilded }),
    },
    actor,
    mapGrid,
  );
}

/* ------------------------------------------------------------------ */
/* Step 3: the Skip consequence                                          */
/* ------------------------------------------------------------------ */

export interface SkipConsequence {
  /** `"prominent"`: the authority already establishes that, after skipping, no share sale can fund the purchase --
   *  only an optional private sale another president must accept stands between the president and bankruptcy.
   *  `"notice"`: the ordinary statement of what Skip commits to. */
  severity: "prominent" | "notice";
  text: string;
}

/** What skipping the intercorporate opportunity commits the president to, from the authority's own figures. Never a
 *  projection of whether a series of sales will suffice -- that earlier impossibility calculation is the v13 rules
 *  batch's, not this surface's. */
export function skipConsequenceFor(funding: EmergencyFunding, presidentLabel: string): SkipConsequence {
  const where = trainSourceName(funding.train.source);
  const fromCash = Math.min(funding.presidentCash, Math.max(0, funding.train.cost - funding.treasury));
  const pays =
    `${funding.ticker} pays its whole treasury ($${funding.treasury}) and ${presidentLabel} pays $${fromCash} ` +
    `of personal cash toward the ${funding.train.tier}-train ($${funding.train.cost}) from the ${where}.`;
  if (funding.shortfall <= 0) {
    return { severity: "notice", text: `If you skip, ${pays}` };
  }
  if (funding.legalSales.length === 0) {
    const privates = funding.legalPrivateSales.length;
    return {
      severity: "prominent",
      text:
        `If you skip, ${pays} That leaves $${funding.shortfall} still to raise, and no share you hold can legally be ` +
        `sold. ` +
        (privates > 0
          ? `The only remaining way to fund the train is an optional private-company sale that another corporation's ` +
            `president must accept. If none is accepted, ${funding.ticker} cannot fund the train and ${presidentLabel} ` +
            `faces bankruptcy.`
          : `${presidentLabel} faces bankruptcy.`),
    };
  }
  return {
    severity: "notice",
    text:
      `If you skip, ${pays} That leaves $${funding.shortfall} to raise by selling shares you are allowed to sell. ` +
      `If that cannot be raised, ${presidentLabel} faces bankruptcy.`,
  };
}

/* ------------------------------------------------------------------ */
/* Step 6: the optional private sale -- legality from the authority     */
/* ------------------------------------------------------------------ */

/** `fundingPrivateOfferRefusal` for one composed offer, with the typed price checked as the wire will carry it. */
export function fundingOfferDraftRefusal(
  state: GameStateResponse,
  funding: EmergencyFunding,
  actor: string | null | undefined,
  draft: { privateId: number; buyerId: number | null; price: string },
): string | null {
  if (draft.buyerId === null) return "Choose a corporation to offer it to.";
  const trimmed = draft.price.trim();
  if (!/^\d+$/.test(trimmed)) return "Enter the price as a whole number of dollars.";
  return fundingPrivateOfferRefusal(
    state,
    funding,
    { private_id: draft.privateId, buyer_protocol_id: draft.buyerId, price: Number(trimmed) },
    actor,
  );
}

/** Whether THIS viewer must answer the standing funding offer -- the obligated president may preside over the buying
 *  corporation too, and the forced surface covers the ordinary prompt, so the answer has to be offered inside it.
 *  `null` when this viewer may answer, else the authority's refusal. */
export function fundingAnswerRefusalForViewer(
  state: GameStateResponse,
  mapGrid: MapGridResponse | undefined,
  actor: string | null | undefined,
): string | null {
  const offer = state.private_purchase_offer ?? null;
  if (!offer || !offer.funding) return "There is no funding offer to answer.";
  /* A rejection needs no board; the acceptance is re-validated in full against it. A viewer the authority refuses
     even a rejection from is not the answerer. */
  return fundingPrivateAnswerRefusal(state, { private_id: offer.private_id, accept: false }, actor, mapGrid);
}
