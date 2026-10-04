// frontend/src/utils/emergencyPurchaseView.ts
//
// What the Emergency Train Purchase surface shows, and to whom -- read off the authority, never restated.
//
// ==================================================================
//  PHASE 3 W2-G (v13 RECONCILIATION): THE SURFACE PRESENTS W3-K's AUTOMATIC STATE MACHINE
// ==================================================================
//
// The authority is `gameEngine/emergencyFunding.ts` under rules revision 2 (`emergencyFundingFor(...).automatic`).
// It already owns every step; this file only chooses which of its answers the surface shows next:
//   1. the intercorporate train opportunity (`automatic.tradeWindow === "open"`), budgeted at the treasury plus the
//      president's cash BEFORE any liquidation -- left with `ForgoTrainTrade`, and never reopened;
//   2. the treasury and the president's cash, committed automatically -- when they cover the train the game derives
//      the `EmergencyBuyHardware` itself (`automatic.autoPurchase`); nobody presses Buy;
//   3. ONE atomic `EmergencySellPortfolio`, judged whole by `emergencyPortfolioRefusal` (any minimal legal rescue
//      portfolio, the smallest legal overshoot allowed, one leg per corporation) -- never a sequential `SellStock`;
//   4. optional private funding while the exact authority says a legal private path could still rescue
//      (`automatic.privateFunding === "relevant"`), or `ForgoPrivateFunding`;
//   5. the automatic bankruptcy, which the reducer settles in the transition that makes it certain -- never a
//      player's `DeclareBankruptcy`.
//
// WHAT WAS DISCARDED FROM THE v12-BASED W2-G (695afe9): the presentation-only Skip (it is now the real
// `ForgoTrainTrade`, and its consequence is the authority's own projection, not prose of ours); one-sale-per-press
// `SellStock`; the president's Buy button (`EmergencyBuyHardware` is the game's); the "faces bankruptcy" guess (the
// projection below says exactly whether bankruptcy follows); and the private-offer section shown whenever a private
// could legally be offered (it is shown only while the exact authority says it could still matter).
//
// THE ONE PROJECTION THIS FILE MAKES is not a rule either: `decisionConsequenceFor` records the decision mark on a
// copy of the board (`withEmergencyMark`, the reducer's own writer) and asks `emergencyFundingFor` again -- so "what
// happens if I forgo" is the authority's answer about the board the reducer would produce, not an inference.

import type { GameStateResponse, TrainPurchaseOffer } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { EmergencyFunding, EmergencySaleLeg } from "../gameEngine/emergencyFunding";
import {
  emergencyFundingFor,
  emergencyPortfolioRefusal,
  fundingPrivateAnswerRefusal,
  fundingPrivateOfferRefusal,
  projectedPortfolioProceeds,
  withEmergencyMark,
} from "../gameEngine/emergencyFunding";
import { proposeTrainPurchaseRefusal, rescindTrainPurchaseRefusal, saleCopies, sellerPresident } from "../gameEngine/trainSaleAuthority";
import { depotCostFor, type TrainTier } from "../gameEngine/gamePhase";
import { homeStationViewerIsPresident } from "./homeStationAskView";

/* ------------------------------------------------------------------ */
/* Viewer scope (OD-1)                                                  */
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
 *  the obligated president, the president who must answer an offer the obligation made -- or nobody, while the game
 *  itself is making the funded purchase. */
export function emergencyWaitingSentence(input: {
  ticker: string;
  presidentLabel: string;
  /** The emergency private offer standing, if any: the BUYING corporation's president answers it. */
  privateOffer: { privateName: string; buyerTicker: string; buyerPresidentLabel: string } | null;
  /** The obligated corporation's offer for another corporation's train, if one stands: its SELLER answers it. */
  trainOffer: { sellerTicker: string; model: string; price: string; sellerPresidentLabel: string; accepted: boolean } | null;
  /** `automatic.autoPurchase`: funded, and the game buys the train itself -- nobody is being waited on. */
  automaticPurchase?: boolean;
}): string {
  const head = `${input.ticker} is resolving an emergency train purchase`;
  if (input.privateOffer) {
    return `${head} — ${input.privateOffer.privateName} is on offer to ${input.privateOffer.buyerTicker}; waiting on ${input.privateOffer.buyerPresidentLabel}.`;
  }
  if (input.trainOffer && !input.trainOffer.accepted) {
    return `${head} — it has offered $${input.trainOffer.price} for ${input.trainOffer.sellerTicker}'s ${input.trainOffer.model}-train; waiting on ${input.trainOffer.sellerPresidentLabel}.`;
  }
  if (input.trainOffer && input.trainOffer.accepted) {
    return `${head} — ${input.trainOffer.sellerTicker} accepted its offer for the ${input.trainOffer.model}-train, and the sale is being settled.`;
  }
  if (input.automaticPurchase) {
    return `${head} — the purchase is funded and the game is buying the train automatically.`;
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
/* Which step of the authority's sequence stands now                    */
/* ------------------------------------------------------------------ */

/** The one thing the obligated president's surface presents next, read off the authority in its own priority order
 *  (an outstanding offer freezes everything; an open trade window comes before the Bank; a funded purchase is the
 *  game's; a derived bankruptcy is the game's).
 *  - `legacy`: a board below rules revision 2 (`automatic` absent). The live list is `[13]`, so no hosted table reaches
 *    this; the v12 manual controls (single forced sale, president's Buy, Declare) are retired from the UI, not kept.
 *  - `private-offer` / `train-offer`: an offer stands and must be answered or withdrawn.
 *  - `trade-window`: another corporation can still sell the train within the pre-liquidation budget.
 *  - `automatic-purchase`: funded; the game derives the purchase (`emergency-purchase:<turn key>`).
 *  - `bankruptcy`: the authority's derived bankruptcy (the reducer ends the game in the same transition).
 *  - `funding`: still short -- one share portfolio, and optional private funding where it is still relevant. */
export type EmergencyStage =
  | "legacy"
  | "private-offer"
  | "train-offer"
  | "trade-window"
  | "automatic-purchase"
  | "bankruptcy"
  | "funding";

export function emergencyStageFor(state: Pick<GameStateResponse, "train_purchase_offer">, funding: EmergencyFunding): EmergencyStage {
  const automatic = funding.automatic;
  if (automatic === undefined) return "legacy";
  if (funding.privateOffer !== null) return "private-offer";
  if (state.train_purchase_offer != null) return "train-offer";
  if (automatic.tradeWindow === "open") return "trade-window";
  if (automatic.autoPurchase) return "automatic-purchase";
  if (funding.bankrupt) return "bankruptcy";
  return "funding";
}

/* ------------------------------------------------------------------ */
/* Step 1: buying from another corporation                              */
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
  /** The pre-liquidation budget: what the corporation and its president can put toward a traded train. */
  treasury: number;
  presidentCash: number;
}

/** The trains the obligated corporation could buy from another corporation, each judged by the authority. A
 *  candidate legal at $1 is legal at some price: every price rule the authority applies to a forced buyer (a whole
 *  number of at least $1, the pre-liquidation budget, the face-value cap when the president contributes) only gets
 *  stricter as the price rises -- the same reading `emergencyTradeWindow` makes. Once the window is closed the
 *  authority refuses every candidate (`fundedTradeRefusal`), so this list is empty by the authority's own answer. */
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
/* The two "forgo" decisions and their consequence                      */
/* ------------------------------------------------------------------ */

export interface DecisionConsequence {
  /** What the authority says the board owes once the decision is recorded:
   *  `automatic-purchase` -- funded, the game buys the train; `bankruptcy` -- no legal rescue would remain;
   *  `funding` -- the president goes on to the share portfolio (or a private sale). */
  outcome: "automatic-purchase" | "bankruptcy" | "funding";
  /** `prominent` exactly when the outcome is bankruptcy. */
  severity: "prominent" | "notice";
  text: string;
}

/** What `ForgoTrainTrade` / `ForgoPrivateFunding` would lead to, by asking the authority about the board with that
 *  mark recorded (`withEmergencyMark` is the reducer's own writer). `null` when no obligation would stand. */
export function decisionConsequenceFor(
  state: GameStateResponse,
  funding: EmergencyFunding,
  mapGrid: MapGridResponse | undefined,
  mark: "trade_window_closed" | "private_funding_forgone",
  presidentLabel: string,
): DecisionConsequence | null {
  const after = emergencyFundingFor(withEmergencyMark(state, funding, mark), mapGrid);
  if (after === null || after.automatic === undefined) return null;
  const where = trainSourceName(after.train.source);
  if (after.automatic.autoPurchase) {
    const fromCash = Math.max(0, after.train.cost - after.treasury);
    return {
      outcome: "automatic-purchase",
      severity: "notice",
      text:
        `The game then buys the ${after.train.tier}-train from the ${where} automatically: ${after.ticker} pays its ` +
        `whole treasury ($${after.treasury}) and ${presidentLabel} pays $${fromCash} of personal cash.`,
    };
  }
  if (after.bankrupt) {
    return {
      outcome: "bankruptcy",
      severity: "prominent",
      text:
        `No legal way to fund the ${after.train.tier}-train would remain, so bankruptcy follows at once: ` +
        `${presidentLabel}'s shares are sold as far as the rules allow, all of ${presidentLabel}'s money goes to ` +
        `${after.ticker}, and the game ends.`,
    };
  }
  return {
    outcome: "funding",
    severity: "notice",
    text:
      `${after.ticker} pays its whole treasury ($${after.treasury}) and ${presidentLabel} pays all of their cash ` +
      `($${after.presidentCash}) toward the ${after.train.tier}-train ($${after.train.cost}) from the ${where}. ` +
      `The remaining $${after.shortfall} must then be raised by selling shares in one transaction` +
      (after.automatic.privateFunding === "relevant" ? " (or by selling a private company)." : "."),
  };
}

/* ------------------------------------------------------------------ */
/* The share portfolio: one EmergencySellPortfolio                       */
/* ------------------------------------------------------------------ */

/** The president's draft: which bundle of each corporation (0 = none), and the ORDER the president chose them in
 *  (the transaction walks the legs in the submitted order -- the chart records which token arrived first). One leg
 *  per corporation BY CONSTRUCTION: a draft is a map keyed by corporation, so a duplicate leg cannot be composed. */
export interface PortfolioDraft {
  order: number[];
  percent: Record<number, number>;
}

export const EMPTY_PORTFOLIO_DRAFT: PortfolioDraft = { order: [], percent: {} };

/** The draft after the president sets `companyId` to `percentage` (0 removes the leg). A corporation keeps its place
 *  in the order when its bundle changes; a new one joins at the end. */
export function withPortfolioChoice(draft: PortfolioDraft, companyId: number, percentage: number): PortfolioDraft {
  const percent = { ...draft.percent };
  if (percentage > 0) percent[companyId] = percentage;
  else delete percent[companyId];
  const kept = draft.order.filter((id) => percent[id] !== undefined);
  const order = percentage > 0 && !kept.includes(companyId) ? [...kept, companyId] : kept;
  return { order, percent };
}

/** The wire's legs for this draft, in the president's order. */
export function portfolioLegs(draft: PortfolioDraft): EmergencySaleLeg[] {
  return draft.order
    .filter((id) => (draft.percent[id] ?? 0) > 0)
    .map((id) => ({ protocol_id: id, percentage: draft.percent[id] }));
}

export interface PortfolioVerdict {
  legs: EmergencySaleLeg[];
  /** What the legs raise at today's prices, as the authority projects them (`projectedPortfolioProceeds`). */
  total: number;
  /** `emergencyPortfolioRefusal` for this viewer, or `null`: the one `EmergencySellPortfolio` may be sent. */
  refusal: string | null;
}

/** The authority's verdict on the president's composed portfolio. Nothing about "only enough", overshoot, the
 *  rescued presidency or the pool ceiling is decided here -- all of it is `emergencyPortfolioRefusal`'s. */
export function portfolioVerdictFor(
  state: GameStateResponse,
  funding: EmergencyFunding,
  actor: string | null | undefined,
  draft: PortfolioDraft,
): PortfolioVerdict {
  const legs = portfolioLegs(draft);
  const total = projectedPortfolioProceeds(state, legs).reduce((sum, value) => sum + value, 0);
  return { legs, total, refusal: emergencyPortfolioRefusal(state, funding, legs, actor) };
}

/* ------------------------------------------------------------------ */
/* The optional private sale -- legality from the authority             */
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
