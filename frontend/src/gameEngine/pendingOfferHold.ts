// frontend/src/gameEngine/pendingOfferHold.ts
//
// The one ordinary bilateral offer a board may carry, and the hold it puts on everything else.
//
// ==================================================================
//  DESIGN NOTE 1590: ONE OFFER AT A TIME, AND NOTHING MOVES WHILE IT STANDS (Batch 7.4, S7-8 / S7-14, D-19)
// ==================================================================
//
// THREE ORDINARY OFFER KINDS share this hold: a corporation's offer for a player's private company
// (`private_purchase_offer`, #662), a corporation's offer for another corporation's train
// (`train_purchase_offer`, #701), and the player <-> player private-company trade (`private_trade_offer`,
// design §7.6a, ruled Q12). The Batch-5 EMERGENCY offer (`private_purchase_offer` marked `funding`, #1541) is
// NOT one of them: it keeps its own freeze in `emergencyFundingBlock`, its own answerer and its own settlement
// arm, and this module never reads it as an ordinary offer -- the two families are exclusive of each other by
// the proposal predicates (a proposal of either kind is refused while an offer of the other stands), never
// merged.
//
// WHAT THE HOLD IS FOR, and what it is not. The transaction's legality is re-derived from the board at the
// moment it settles (`privatePurchaseRefusal`, `trainSaleRefusal`, `privateTradeRefusal`); that revalidation
// is the AUTHORITY. The hold is the convenience that makes "the board changed between the offer and the
// answer" unreachable in play, so the counterparty answers the question that was asked -- D-5's own wording
// for the funding offer, applied to the ordinary ones (ruled Q6). It is asked in `applySandboxActionCore`
// (identity) and at ingress (`turnRefusal`, with the sentence), the #1530/#1540 shape.
//
// WHILE AN ORDINARY OFFER STANDS -- awaiting its answer, or accepted and awaiting its derived settlement --
// only these pass: the counterparty's answer to THAT offer; the proposer's rescission of THAT offer; the exact
// derived settlement an accepted offer owes; `RevertTo` and `CloseRoom`, which are the room's. Pass / End
// Turn, round advancement, another offer of any kind, every purchase or sale, every Operating step, every
// other gameplay mutation: refused. The list is closed on purpose (see §14 of the batch report for the two
// holds this makes unreachable rather than deadlocked).
//
// LIFETIME. Because nothing else can happen, an offer cannot outlive the turn it was made in -- the turn
// cannot end. No turn-end or round-end clearing code exists, and none is added: it would be dead.

import type { GameStateResponse, PrivatePurchaseOffer, PrivateTradeOffer, TrainPurchaseOffer } from "./gameState";
import type { SandboxLogMsg } from "./gameSetup";
import { sameWholeVgp, type VgpWire } from "./vgpAmount";

/** The three ordinary kinds. */
export type OrdinaryOfferKind = "private-purchase" | "train-purchase" | "private-trade";

export type StandingOrdinaryOffer =
  | { kind: "private-purchase"; offer: PrivatePurchaseOffer; accepted: boolean }
  | { kind: "train-purchase"; offer: TrainPurchaseOffer; accepted: boolean }
  | { kind: "private-trade"; offer: PrivateTradeOffer; accepted: false };

/** The ordinary offer standing on this board, or `null`. The funding offer is never reported here. */
export function standingOrdinaryOffer(state: GameStateResponse): StandingOrdinaryOffer | null {
  const privateOffer = state.private_purchase_offer ?? null;
  if (privateOffer !== null && privateOffer.funding !== true) {
    return { kind: "private-purchase", offer: privateOffer, accepted: privateOffer.accepted === true };
  }
  const trainOffer = state.train_purchase_offer ?? null;
  if (trainOffer !== null) {
    return { kind: "train-purchase", offer: trainOffer, accepted: trainOffer.accepted === true };
  }
  const tradeOffer = state.private_trade_offer ?? null;
  if (tradeOffer !== null) return { kind: "private-trade", offer: tradeOffer, accepted: false };
  return null;
}

/* ==================================================================
    DESIGN NOTE 1597: EVERY ORDINARY OFFER IS NUMBERED WHEN IT IS PROPOSED (Batch 7.4, R74-B)
   ==================================================================
   The three proposal arms call this and write both halves: the offer carries `instance`, the board carries
   `offer_serial` (see `GameStateResponse.offer_serial` for why a serial and not a tuple). One counter for all
   three kinds, because "which offer is this" is one question however the offer is shaped; the funding offer
   is not an ordinary offer and is not numbered. Strictly increasing over the log; a rescinded or rejected
   offer's number is spent, never reissued. */

/** The next instance id and the board field that records it, for a proposal arm to spread in. */
export function allocateOfferInstance(state: GameStateResponse): { instance: number; offer_serial: number } {
  const serial = typeof state.offer_serial === "number" && Number.isFinite(state.offer_serial) ? state.offer_serial : 0;
  const instance = Math.floor(serial) + 1;
  return { instance, offer_serial: instance };
}

/** Whether ANY offer -- ordinary or the Batch-5 funding offer -- stands, for the proposal predicates' one-offer
 *  rule (ruled Q6: never beside a funding offer, and the funding offer never beside one of these). */
export function anyOfferStands(state: GameStateResponse): boolean {
  return (
    (state.private_purchase_offer ?? null) !== null ||
    (state.train_purchase_offer ?? null) !== null ||
    (state.private_trade_offer ?? null) !== null
  );
}

/** One sentence naming the standing offer, for the hold's refusal. */
export function describeStandingOffer(standing: StandingOrdinaryOffer): string {
  switch (standing.kind) {
    case "private-purchase":
      return `${standing.offer.buyer_ticker}'s offer of $${standing.offer.price} for ${standing.offer.private_name} is ${
        standing.accepted ? "accepted and awaiting settlement" : "waiting for its owner's answer"
      }`;
    case "train-purchase":
      return `${standing.offer.buyer_ticker}'s offer of $${standing.offer.price} for ${standing.offer.seller_ticker}'s ${standing.offer.model_type}-train is ${
        standing.accepted ? "accepted and awaiting settlement" : "waiting for the selling president's answer"
      }`;
    case "private-trade":
      return `${standing.offer.private_name} is on offer between ${standing.offer.seller} and ${standing.offer.buyer} for $${standing.offer.price} and is waiting for an answer`;
  }
}

function key(msg: SandboxLogMsg): string {
  return typeof msg === "object" && msg !== null ? (Object.keys(msg)[0] ?? "") : "";
}

/** The messages that pass the hold whatever offer stands: the room's own. */
const ALWAYS_PASSES: readonly string[] = ["RevertTo", "CloseRoom"];

/** Whether `msg` is exactly what the standing offer is waiting for: its answer (only while unanswered), its
 *  rescission by the proposer (while it stands at all -- the frozen design lets the proposer withdraw an
 *  accepted offer whose settlement has not landed, which is also the one exit short of `RevertTo` should a
 *  settlement ever fail to be derived), or the one derived settlement an accepted offer owes. Nothing else. */
export function passesOfferHold(standing: StandingOrdinaryOffer, msg: SandboxLogMsg): boolean {
  const body = (msg as Record<string, Record<string, unknown>>)[key(msg)] ?? {};
  switch (standing.kind) {
    case "private-purchase": {
      const { offer, accepted } = standing;
      if (!accepted && "AnswerPrivatePurchase" in msg) return body.private_id === offer.private_id;
      if ("RescindPrivatePurchase" in msg) return body.private_id === offer.private_id;
      if (accepted && "BuyPrivateCompany" in msg) return privateSettlementMatches(offer, msg.BuyPrivateCompany);
      return false;
    }
    case "train-purchase": {
      const { offer, accepted } = standing;
      if (!accepted && "AnswerTrainPurchase" in msg) return body.seller_protocol_id === offer.seller_protocol_id;
      if ("RescindTrainPurchase" in msg) return body.seller_protocol_id === offer.seller_protocol_id;
      if (accepted && "BuyTrainFromCorporation" in msg) return trainSettlementMatches(offer, msg.BuyTrainFromCorporation);
      return false;
    }
    case "private-trade": {
      const { offer } = standing;
      if ("AnswerPrivateTrade" in msg) return body.private_id === offer.private_id;
      if ("RescindPrivateTrade" in msg) return body.private_id === offer.private_id;
      return false;
    }
  }
}

/** Whether this `BuyPrivateCompany` is the settlement of THIS offer: same private, same buyer, same price. The
 *  owner is not part of the message; the settlement predicate re-derives it from the board.
 *  Stage 10.5 (S10-9): THE PRICE IS COMPARED BY VALUE (`sameWholeVgp`): a legacy numeric offer (`100`) and its
 *  string settlement (`"100"`) are one price; a malformed spelling on either side matches nothing -- never
 *  `Number(...)` coercion, which read `"1e2"` as `100`. */
export function privateSettlementMatches(
  offer: PrivatePurchaseOffer,
  settlement: { protocol_id: number; private_id: number; price: VgpWire },
): boolean {
  return (
    offer.private_id === settlement.private_id &&
    offer.buyer_protocol_id === settlement.protocol_id &&
    sameWholeVgp(offer.price, settlement.price)
  );
}

/** Whether this `BuyTrainFromCorporation` is the settlement of THIS offer: seller, buyer, model AND price -- and, since
 *  UR-4 (OD-UR-5(c) = 5c-2), THE COPY: the seller consented to the gold-trimmed copy or to an ordinary one, and a
 *  settlement naming the other is not that consent. Absent on both sides is the unnamed sale every offer before UR-4
 *  was, and still matches itself. */
export function trainSettlementMatches(
  offer: TrainPurchaseOffer,
  settlement: {
    buyer_protocol_id: number;
    seller_protocol_id: number;
    model_type: string;
    price: string | number;
    gilded?: boolean;
  },
): boolean {
  return (
    offer.seller_protocol_id === settlement.seller_protocol_id &&
    offer.buyer_protocol_id === settlement.buyer_protocol_id &&
    offer.model_type === settlement.model_type &&
    Number(offer.price) === Number(settlement.price) &&
    (offer.gilded ?? null) === (settlement.gilded ?? null)
  );
}

/** Why this message is held while an ordinary offer stands, or `null`. The one global hold across the three
 *  ordinary kinds (#1590). */
export function pendingOfferBlock(state: GameStateResponse, msg: SandboxLogMsg): string | null {
  if (ALWAYS_PASSES.includes(key(msg))) return null;
  const standing = standingOrdinaryOffer(state);
  if (standing === null) return null;
  if (passesOfferHold(standing, msg)) return null;
  const waiting =
    standing.kind === "private-trade"
      ? "until it is answered or withdrawn"
      : standing.accepted
        ? "until it settles"
        : "until it is answered or withdrawn";
  return `${describeStandingOffer(standing)}; nothing else can happen ${waiting}.`;
}

/* ==================================================================
    Q11 / D-23: THE CHAIN-ERA OFFER MESSAGES ARE REFUSED ON A PINNED BOARD
   ================================================================== */

/** The chain-era offer-register messages (`offer_id`), which the sandbox never modelled (`applyOneAction`
 *  no-ops them, #0). On a board this engine dealt they are refused outright rather than silently accepted
 *  (S7-19, ruled Q11); a legacy board keeps the no-op arm it was played on (D-9). Their schema and types stay
 *  until Stage 10 (S10-8). */
export function isLegacyOfferMessage(msg: SandboxLogMsg): boolean {
  return "AcceptTrainOffer" in msg || "RejectTrainOffer" in msg || "RescindTrainOffer" in msg;
}

export function legacyOfferMessageRefusal(state: GameStateResponse, msg: SandboxLogMsg): string | null {
  if (!isLegacyOfferMessage(msg)) return null;
  if (typeof state.rules_engine_version !== "number") return null;
  const name = key(msg);
  const replacement =
    name === "RescindTrainOffer"
      ? "a proposer withdraws with RescindTrainPurchase"
      : "a selling president answers with AnswerTrainPurchase";
  return `${name} is a chain-era message this game does not play: ${replacement}.`;
}
