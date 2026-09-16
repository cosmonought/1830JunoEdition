// frontend/src/gameEngine/privateTradeAuthority.ts
//
// The player <-> player sale of a private company: the third ordinary offer kind.
//
// ==================================================================
//  DESIGN NOTE 1593: A PRIVATE COMPANY CHANGES HANDS BETWEEN PLAYERS (Batch 7.4, S7-9, ruled Q12 / D-24)
// ==================================================================
//
// RULEBOOK (1830-RE, Lookout 2018) 3.1: private companies "may be sold between players for any mutually agreed
// price at any time during the buyer's or the seller's turn of a stock round (other than the first)". A §3.1
// private-company rule, not a §5 certificate rule: the half-to-twice band belongs to §3.1's CORPORATION
// sentence and does not apply here; "any mutually agreed price" includes $0 (a gift). §4.3 counts every
// private company as one certificate, so the buyer must stay within the overall certificate limit (owner
// ruling, 2026-09-15: design §7.6a rule 8).
//
// THE SHAPE. `ProposePrivateTrade { private_id, seller, buyer, price }` by EITHER party, on that party's own
// Stock Round turn; `AnswerPrivateTrade { private_id, accept }` by the OTHER party, off-turn, through the
// consent-answer exemption; `RescindPrivateTrade { private_id }` by the proposer. The offer is its own state
// field (`private_trade_offer`) rather than a discriminator on the corporation-buyer shape, and it joins the
// one-offer hold (#1590). SETTLEMENT HAPPENS IN THE ANSWER ARM on `accept: true` -- the D-5 shape: there is no
// single-party settlement message to derive, and inventing one would add a derived key for no reason. The
// predicate below is re-run on the current board in that arm; a failure refuses the answer by identity and
// leaves the offer standing for a rescind or a later legal answer.
//
// WHO IS "THE SEAT". Rule 3 -- "during the buyer's or the seller's turn" -- is a fact about the round, read
// from `player_addresses[active_player_index]`; the actor's right to SEND is still ingress's (Q10 / D-9), where
// the proposer must be the seat holder and one of the two parties.
//
// WHAT TRAVELS WITH THE CARD (owner ruling N1, D-26) is the reducer's arm's business and is stated there: the
// card and every still-unexercised ownership-dependent power; no already-vested one-time benefit. WHAT THE
// TRADE DOES TO THE STOCK ROUND (owner ruling N2, D-27) likewise.

import type { GameStateResponse, PrivateTradeOffer } from "./gameState";
import { certificateBreakdown } from "./gameState";
import { isFirstStockRound, chartContextFromState } from "./stockTransactionAuthority";
import { playerCashOf } from "./cashLedger";
import { anyOfferStands } from "./pendingOfferHold";

export interface PrivateTradeIntent {
  privateId: number;
  seller: string;
  buyer: string;
  /** Judged as a whole number >= 0. */
  price: number | string;
}

/** The seat whose Stock Round turn it is, or `null`. */
export function stockRoundSeat(state: GameStateResponse): string | null {
  return state.player_addresses[state.active_player_index] ?? null;
}

/** The party who must answer the standing trade offer: whichever of the two did not propose it. */
export function tradeCounterparty(offer: PrivateTradeOffer): string {
  return offer.proposer === offer.seller ? offer.buyer : offer.seller;
}

/** Why this trade may not be made now, or `null`. Re-derived at proposal, at answer and at settlement (the
 *  answer arm), always against the current board. Consent -- who may propose, answer and rescind -- is the
 *  arms' and ingress's; this is the transaction. */
export function privateTradeRefusal(state: GameStateResponse, intent: PrivateTradeIntent): string | null {
  /* ---- 1. A Stock Round other than the first (3.1; the same first-round test as the sale ban) --- */
  if (state.current_round_type !== "StockRound") {
    return "Private companies are traded between players only during a Stock Round.";
  }
  if (isFirstStockRound(state)) {
    return "Private companies may not be traded between players in the first Stock Round (rulebook 3.1).";
  }

  /* ---- 2. On the buyer's or the seller's turn --------------------------------------------------- */
  const seat = stockRoundSeat(state);
  if (seat === null) return "No seat holds the Stock Round turn.";
  if (seat !== intent.buyer && seat !== intent.seller) {
    return "A private company is traded only during the buyer's or the seller's own Stock Round turn.";
  }

  /* ---- 3. Two distinct seated players ----------------------------------------------------------- */
  if (intent.buyer === intent.seller) return "A player cannot trade a private company with themselves.";
  if (!state.player_addresses.includes(intent.buyer)) return "The buyer is not seated at this table.";
  if (!state.player_addresses.includes(intent.seller)) return "The seller is not seated at this table.";

  /* ---- 4. The card: exists, open, and the seller's --------------------------------------------- */
  const priv = state.private_companies.find((entry) => entry.private_id === intent.privateId);
  if (!priv) return "That private company is not in this game.";
  if (priv.closed) return `${priv.name} has closed and cannot be traded.`;
  const corporate = priv.owner_protocol_id !== null && priv.owner_protocol_id !== undefined;
  if (corporate || priv.owner !== intent.seller) {
    return `${priv.name} is not ${intent.seller}'s to sell.`;
  }

  /* ---- 5. Any mutually agreed whole price, $0 included; no corporation band (3.1) ---------------- */
  const price = Number(intent.price);
  if (!Number.isInteger(price) || price < 0) {
    return "The price must be a whole number of dollars ($0 or more).";
  }

  /* ---- 6. The buyer can pay (cash is physical) --------------------------------------------------- */
  const cash = playerCashOf(state, intent.buyer);
  if (cash === null || cash < price) {
    return `${intent.buyer} holds $${cash ?? 0} and cannot pay $${price}.`;
  }

  /* ---- 7. The overall certificate limit (4.3; owner ruling) ------------------------------------ */
  const chart = chartContextFromState(state);
  const breakdown = certificateBreakdown(intent.buyer, state, chart.marketPricesByCompany ?? undefined, chart.zoneForPrice);
  if (breakdown.limit !== null && breakdown.counted + 1 > breakdown.limit) {
    return `${intent.buyer} holds ${breakdown.counted} of ${breakdown.limit} certificates and may not take another — a private company counts as one.`;
  }

  return null;
}

/* ==================================================================
    THE TRADE'S THREE MESSAGES: EITHER PARTY PROPOSES ON THEIR TURN, THE OTHER ANSWERS, THE PROPOSER WITHDRAWS
   ================================================================== */

/** Why this proposal may not be made, or `null`. One offer at a time (ruled Q6); the proposer is the seat holder
 *  AND one of the two parties. */
export function proposePrivateTradeRefusal(
  state: GameStateResponse,
  proposal: { private_id: number; seller: string; buyer: string; price: number | string },
  actor: string | null | undefined,
): string | null {
  if (anyOfferStands(state)) return "An offer is already standing; it must be answered or withdrawn before another is made.";
  if (actor != null) {
    if (actor !== proposal.buyer && actor !== proposal.seller) {
      return "Only the buyer or the seller can propose a private-company trade.";
    }
    const seat = stockRoundSeat(state);
    if (seat !== null && actor !== seat) return "A private-company trade is proposed on your own Stock Round turn.";
  }
  return privateTradeRefusal(state, {
    privateId: proposal.private_id,
    seller: proposal.seller,
    buyer: proposal.buyer,
    price: proposal.price,
  });
}

/** Why this answer may not be given, or `null` (also `null` when nothing is there to answer, #662). Only the
 *  counterparty answers; an acceptance is the settlement and is re-validated in full. */
export function answerPrivateTradeRefusal(
  state: GameStateResponse,
  answer: { private_id: number; accept: boolean },
  actor: string | null | undefined,
): string | null {
  const offer = state.private_trade_offer ?? null;
  if (offer === null) return null;
  if (offer.private_id !== answer.private_id) return "That is not the private company on offer.";
  const counterparty = tradeCounterparty(offer);
  if (actor != null && actor !== counterparty) {
    return actor === offer.proposer
      ? "You made this offer; only the other party can answer it."
      : "Only the other party to this trade can answer it.";
  }
  if (!answer.accept) return null;
  return privateTradeRefusal(state, {
    privateId: offer.private_id,
    seller: offer.seller,
    buyer: offer.buyer,
    price: offer.price,
  });
}

/** Why this withdrawal may not be made, or `null`: the proposer's alone. */
export function rescindPrivateTradeRefusal(
  state: GameStateResponse,
  rescind: { private_id: number },
  actor: string | null | undefined,
): string | null {
  const offer = state.private_trade_offer ?? null;
  if (offer === null) return "There is no trade offer to withdraw.";
  if (offer.private_id !== rescind.private_id) return "That is not the private company on offer.";
  if (actor != null && actor !== offer.proposer) return "Only the player who made this offer can withdraw it.";
  return null;
}
