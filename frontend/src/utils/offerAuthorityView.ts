// frontend/src/utils/offerAuthorityView.ts
//
// What the two Operating Round offer panels ask before an offer is sent.
//
// ==================================================================
//  PHASE 3 W2-C (AUD-09.02 / U-21, AUD-09.03 / U-20): THE OFFER PANELS READ THEIR AUTHORITY
// ==================================================================
//
// THE AUTHORITIES ARE THE ENGINE'S, AND THIS FILE RESTATES NONE OF THEM:
//   - the Buy Private Company panel (`ProposePrivatePurchase`) asks `proposePrivatePurchaseRefusal` -- the predicate the
//     reducer and ingress ask of a `ProposePrivatePurchase` (#1591 / #1595);
//   - the Buy Trains from a Corporation roster asks `proposeTrainPurchaseRefusal` for an offer, and `trainSaleRefusal` at
//     "settlement" for the same-president shortcut, which the shell sends as the `BuyTrainFromCorporation` itself (#1592).
// Each is bound here to the live board, the seat the offer is sent as (the author every room message carries, #549) and
// the operating corporation, and handed to its panel as one function. The sentences reach the player unedited except that
// a seat id is shown as the seat's name, exactly as W2-A's hold view shows them (`labelSentence`).
//
// WHAT THE PANELS STOPPED DOING. `PrivateTradePanel` mirrored the price band and the treasury (`offerPriceProblem`) and the
// B&O / unsold block (`privatePurchaseBlockReason`); `TrainPurchasePanel` mirrored the $1 floor (`trainPriceError`) and the
// train limit, and never asked the sale's predicate at all (AUD-09.02). Each was a second statement of a rule the engine
// already answers, in other words, and blind to every rule it had not copied -- the phase, the operating step, a floated
// buyer, a seller with a president, D-6's caps, the copy UR-4 makes a sale name.
//
// THE HOLDS ARE NOT ASKED HERE. W2-A's `dockHoldView` is the shell's one hold answer; the panels keep reading it FIRST
// (`blockedReason`), exactly as the reducer and ingress ask the holds ahead of these predicates. This view is consulted only
// while no hold stands, so a held board still reports the hold's own sentence on every seat.
//
// THE SAME-PRESIDENT SHORTCUT (#701). When one president sits over both sides the shell sends the purchase itself rather
// than a proposal. For a train that message is judged by `trainSaleRefusal` at "settlement", and is asked as such here.
// For a private it is `BuyPrivateCompany`, judged by `privatePurchaseRefusal` at "settlement", whose only rule beyond the
// proposal's is consent -- which one principal on both sides supplies -- so `proposePrivatePurchaseRefusal` gives the
// purchase's answer on every board the panel is shown on (`phase3W2COfferAuthority` pins that equivalence). The fork is
// the shell's own (`handleProposeTrainTrade` / `handleProposePrivatePurchase`: one president over both sides); its
// chain-era `!sandbox` arm, which sent every train sale directly, is unreachable -- the lobby enters every table as a room.
//
// THE TYPED PRICE. A panel holds its price as text. `offerPriceForAuthority` hands the authority the canonical whole-VGP
// spelling (`vgpAmount.ts`: digits, no sign, no leading zero, no exponent), or `NaN` for anything else -- which each
// authority refuses in its own words (the private's band sentence, the train's "whole number of at least $1"). Surrounding
// whitespace and the leading zeros of an all-digit entry are the input's, not a spelling ("070" typed is $70, as a number
// field means it) -- that is parsing, not a rule, and the canonical result is what is judged. Anything else ("1e2",
// "70.5", "-5") is not a whole number and is refused. The panels send exactly the spelling that was judged.

import type { MapGridResponse } from "../components/hexContractTypes";
import type { GameStateResponse } from "../gameEngine/gameState";
import { proposePrivatePurchaseRefusal } from "../gameEngine/privatePurchaseAuthority";
import { proposeTrainPurchaseRefusal, sellerPresident, trainSaleRefusal } from "../gameEngine/trainSaleAuthority";
import { canonicalWholeVgp } from "../gameEngine/vgpAmount";
import { labelSentence } from "./stockRoundPrivateTrade";

/** The sentence for a panel asked before any board has loaded (the shell's existing wording, `App.tsx`). */
export const OFFER_BOARD_NOT_LOADED = "The board is not loaded yet.";

export interface OfferAuthorityInput {
  /** The live board. */
  state: GameStateResponse | null | undefined;
  /** The seat the offer is sent as -- this viewer's author id. Empty or absent is no author (#549b). */
  actor: string | null | undefined;
  /** The operating corporation: the buyer in both panels. */
  buyerId: number;
  /** The live tile grid -- D-6's funding test walks it (#1540). */
  mapGrid?: MapGridResponse;
  /** How a seat id reads on screen. */
  labelFor: (address: string) => string;
}

/** A train offer as the roster composes it. `gilded` is the copy, only when the seller holds a gold-trimmed one (UR-4). */
export interface TrainOfferIntent {
  sellerProtocolId: number;
  modelType: string;
  price: string | number;
  gilded?: boolean;
}

const author = (actor: string | null | undefined): string | null =>
  typeof actor === "string" && actor.length > 0 ? actor : null;

const named = (state: GameStateResponse, refusal: string | null, labelFor: (address: string) => string): string | null =>
  refusal === null ? null : labelSentence(refusal, state.player_addresses ?? [], labelFor);

/** The typed price as the authority judges it -- see the header's last paragraph. */
export function offerPriceForAuthority(text: string): string | number {
  const trimmed = text.trim();
  const digits = /^[0-9]+$/.test(trimmed) ? trimmed.replace(/^0+(?=[0-9])/, "") : trimmed;
  return canonicalWholeVgp(digits) ?? Number.NaN;
}

/** Why the operating corporation may not offer `price` for this private now, in the authority's words, or `null`. */
export function privateProposalRefusal(input: OfferAuthorityInput, privateId: number, price: string | number): string | null {
  const { state } = input;
  if (!state) return OFFER_BOARD_NOT_LOADED;
  const refusal = proposePrivatePurchaseRefusal(
    state,
    { private_id: privateId, buyer_protocol_id: input.buyerId, price },
    author(input.actor),
  );
  return named(state, refusal, input.labelFor);
}

/** Whether the shell sends this sale as the purchase itself: one president over both corporations (#701), read off the
 *  board -- the same fork `handleProposeTrainTrade` takes. */
export function sellsDirect(state: GameStateResponse, buyerId: number, sellerId: number): boolean {
  const buyer = state.public_companies.find((entry) => entry.company_id === buyerId)?.president ?? null;
  // Truthiness, exactly as the shell's fork and the panel's `samePresident` read it.
  return !!buyer && buyer === sellerPresident(state, sellerId);
}

/** Why this train offer may not be sent now, in the authority's words, or `null`: the proposal's predicate, or the sale's
 *  own at "settlement" when the shell will send the sale directly. */
export function trainOfferRefusal(input: OfferAuthorityInput, offer: TrainOfferIntent): string | null {
  const { state } = input;
  if (!state) return OFFER_BOARD_NOT_LOADED;
  const actor = author(input.actor);
  const refusal = sellsDirect(state, input.buyerId, offer.sellerProtocolId)
    ? trainSaleRefusal(
        state,
        {
          buyerId: input.buyerId,
          sellerId: offer.sellerProtocolId,
          model: offer.modelType,
          price: offer.price,
          gilded: offer.gilded,
        },
        actor,
        input.mapGrid,
        "settlement",
      )
    : proposeTrainPurchaseRefusal(
        state,
        {
          seller_protocol_id: offer.sellerProtocolId,
          buyer_protocol_id: input.buyerId,
          model_type: offer.modelType,
          price: offer.price,
          gilded: offer.gilded,
        },
        actor,
        input.mapGrid,
      );
  return named(state, refusal, input.labelFor);
}
