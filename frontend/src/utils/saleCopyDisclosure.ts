// frontend/src/utils/saleCopyDisclosure.ts
//
// Which copy an intercorporate train sale takes, as the players are told it -- read, never decided, here.
//
// ==================================================================
//  UR-6 (Variant Certification 1B -- Unpredictable Revenue): THE PLAYERS ARE TOLD WHAT THE AUTHORITY WILL SETTLE
// ==================================================================
//
// OD-UR-5(c) = 5c-2 (backlog D-48): a sale names the COPY, and only the gold-trimmed copy's sale is the Blood Price.
// UR-4 made the authority answer that per copy (`resolveSaleCopy`, `isCarcosanTransfer`), and made the normal UI NAME
// the copy wherever the seller holds a gold-trimmed one. But the presentation still read only the optional message
// field: the consent prompt and the pending-offer view showed the Blood Price when `offer.gilded === true`, and the
// Activity Log named the MODEL on every offer, answer and trade line.
//
// THE GAP (independent UR-4 review, D1): an UNNAMED offer is legal where it cannot be ambiguous, so a seller holding
// ONLY the gold-trimmed copy of a model settles an unnamed offer as the Blood Price -- and the recipient was shown
// "a 6-train" with no Blood Price line. Not an authority defect; a disclosure one. And U-42 still owed the Activity
// Log's offer and trade lines the copy.
//
// SO THE PRESENTATION ASKS THE AUTHORITY'S OWN PREDICATES and renders the answer. Nothing below re-derives which copy
// is legal or what the Blood Price is: `isCarcosanTransfer` is the reducer's own question (the chart step asks it on
// the board before the sale), and `resolveSaleCopy` / `saleCopies` are the sale authority's multiset reading. Asked of
// the board the answer or settlement will be judged on, so what a player reads is what the authority will do.
// An ambiguous unnamed sale is refused by the authority at every moment, so it has no special wording here: it reads
// as the plain sale it can never become.

import type { GameStateResponse, TrainPurchaseOffer } from "../gameEngine/gameState";
import { isCarcosanTransfer } from "../gameEngine/sandboxSession";
import { resolveSaleCopy, saleCopies } from "../gameEngine/trainSaleAuthority";

/** How a sale's copy reads to a player:
 *   `bloodPrice`            -- the seller's gold-trimmed copy: the Blood Price (the buyer pays it; the train is cured).
 *   `ordinaryBesideGilded`  -- an ordinary copy of a model the seller ALSO holds gold-trimmed: an ordinary sale, and
 *                              the gold-trimmed copy stays where it is.
 *   `plain`                 -- every other sale, worded exactly as before UR-6 (every standard game; every seller
 *                              without a gold-trimmed copy of the model; an ambiguous request the authority refuses). */
export type SaleCopyKind = "bloodPrice" | "ordinaryBesideGilded" | "plain";

/** The kind of copy this sale takes on `state` -- the board it will be judged on. */
export function saleCopyKind(
  state: GameStateResponse | null | undefined,
  sellerId: number,
  model: string,
  gilded?: boolean,
): SaleCopyKind {
  if (!state) return "plain";
  if (isCarcosanTransfer(state, sellerId, model, gilded)) return "bloodPrice";
  const seller = (state.public_companies ?? []).find((entry) => entry.company_id === sellerId);
  if (!seller || saleCopies(seller, model).gilded === 0) return "plain";
  return resolveSaleCopy(seller, model, gilded) === "ordinary" ? "ordinaryBesideGilded" : "plain";
}

/** Whether the standing train offer settles as the Blood Price if its seller accepts -- the named gold-trimmed copy,
 *  or an UNNAMED offer the authority resolves to it (the seller holds only gold-trimmed copies of the model). */
export function offerSettlesAsBloodPrice(
  state: GameStateResponse | null | undefined,
  offer: Pick<TrainPurchaseOffer, "seller_protocol_id" | "model_type" | "gilded"> | null | undefined,
): boolean {
  if (!offer) return false;
  return saleCopyKind(state, offer.seller_protocol_id, offer.model_type, offer.gilded) === "bloodPrice";
}
