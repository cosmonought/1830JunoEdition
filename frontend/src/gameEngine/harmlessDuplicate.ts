// frontend/src/gameEngine/harmlessDuplicate.ts
//
// The consent answers that find nothing to answer -- the one class of message the authority deliberately
// treats as a HARMLESS DUPLICATE rather than a refusal.
//
// ==================================================================
//  DESIGN NOTE 1687 (Stage 10.2 follow-up, S10-1): A DUPLICATE ANSWER IS NOT A REFUSAL -- WHEN THERE IS NOTHING TO ANSWER
// ==================================================================
//
// #662 / #701 (and #1541 for the funding offer) made it a rule: "answering an offer that is no longer there is
// not an error -- the first answer settles it and the second finds nothing ... refusing here would turn a
// harmless duplicate into an error message on somebody's screen." Ingress (`consentAnswerRefusal`) and the
// answer authorities (`answerPrivatePurchaseRefusal`, `answerTrainPurchaseRefusal`, `answerPrivateTradeRefusal`)
// all return `null` for it, and the reducer's arms change nothing. So after 10.2's boundary (#1685) such an
// answer reaches the reducer, changes nothing -- and must NOT be read as a refusal.
//
// STATE-AWARE, NOT MESSAGE-WIDE. The exemption is the board's answer to "is there anything to answer", asked of
// the board the message was judged on. An answer sent WHILE the offer it answers stands is judged in full
// (identity, the offer it names, the transaction re-validated) and, if it changes nothing, is a refusal like
// any other -- the message type buys nothing. The four conditions below are exactly ingress's early `null`s;
// `consentAnswerRefusal` asks this function for them, so the two cannot drift.
//
//   AnswerPrivatePurchase     no private offer at all, or an ORDINARY one already accepted (its settlement is
//                             derived; a second yes finds it answered). A standing FUNDING offer is not this
//                             message's to answer and is refused at ingress.
//   AnswerTrainPurchase       no train offer, or one already accepted.
//   AnswerPrivateTrade        no trade offer (the trade settles in its answer, so there is no accepted state).
//   AnswerFundingPrivateOffer no private offer, or one that is not a funding offer (settled or withdrawn).

//
// C2-02 (DA-7, 2026-09-27): WHAT A ROOM DOES WITH ONE. Still no refusal of the rules, and the board still does not move --
// but a hosted room no longer RECORDS it (`RoomSession.submit`): the entry is taken back and the sender is told, in the
// sentence below, that there was nothing to answer. The exemption at ingress is unchanged, and so is the shell's
// receipt, which prints no REFUSED line for it.

import type { GameStateResponse } from "./gameState";

/** C2-02: the room's answer to a harmless duplicate -- what happened, blaming nobody. Nothing is appended. */
export const HARMLESS_DUPLICATE_ANSWER_SENTENCE =
  "There is no open offer to answer \u2014 it has already been answered or withdrawn, so nothing was recorded.";

/** #1687: whether `msg` is a consent answer that finds nothing to answer on `state` -- a harmless duplicate. */
export function harmlessDuplicateAnswer(state: GameStateResponse, msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  if ("AnswerPrivatePurchase" in msg) {
    const offer = state.private_purchase_offer ?? null;
    return offer === null || (offer.funding !== true && offer.accepted === true);
  }
  if ("AnswerTrainPurchase" in msg) {
    const offer = state.train_purchase_offer ?? null;
    return offer === null || offer.accepted === true;
  }
  if ("AnswerPrivateTrade" in msg) {
    return (state.private_trade_offer ?? null) === null;
  }
  if ("AnswerFundingPrivateOffer" in msg) {
    const offer = state.private_purchase_offer ?? null;
    return offer === null || offer.funding !== true;
  }
  return false;
}
