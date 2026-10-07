// frontend/src/gameEngine/clockResponsibility.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS: WHO OWES THE NEXT REQUIRED HUMAN DECISION -- ONE DERIVATION, READ OFF THE BOARD
// ==================================================================
//
// The Live action clock (20 minutes per required action), the Timed Async pace and the remedy evidence all time ONE
// human: the person who actually owes the next REQUIRED decision. That is NOT always the turn holder
// (`actingAddress`): an off-turn mandatory answer -- a train or private offer awaiting its counterparty, an emergency
// funding offer awaiting the buying corporation's president, an excess-train discard owed by another corporation's
// president, the B&O par owed by the private's owner -- holds the whole game until that person answers, and the hold
// composition (`authoritativeHolds.ts`, `turnAuthority.ts`) refuses everybody else meanwhile.
//
// THIS IS THE ONE DERIVATION. The server's clock (`server/src/rooms/clock/`), the room's clock projection and therefore
// the browser (which only PRESENTS the server's answer) and the remedy evidence all read it from here. It asks, in the
// holds' own priority, the same engine predicates ingress asks -- nothing geometric, nothing guessed -- and falls back
// to `actingAddress` (the auction contest's bidder, the auction cursor, the Stock Round seat, the operating
// corporation's president) when no off-turn decision stands.
//
// PURE: a board in, an answer out; no time, no log, no I/O. A board that cannot be read answers `null` (nobody timed),
// never a guess.

import { actingAddress, type GameStateResponse, type WaterfallStateResponse } from "./gameState";
import { pendingTrainDiscards } from "./trainDiscard";
import { sellerPresident } from "./trainSaleAuthority";
import { buyerPresident, currentPrivateOwner } from "./privatePurchaseAuthority";
import { tradeCounterparty } from "./privateTradeAuthority";
import { boParOwedTo } from "./auctionAuthority";
import { operatingTurnKey } from "./turnGuardKey";

/** What kind of decision is owed. */
export type RequiredDecisionKind =
  /** The ordinary turn: the Stock Round seat, the operating corporation's president, the auction cursor. */
  | "turn"
  /** A live auction contest's bidder. */
  | "auction-bid"
  /** The B&O President's Certificate and par, owed by the B&O private's owner before the auction goes on. */
  | "bo-par"
  /** An excess-train discard (rulebook 6.6.1), owed by the over-limit corporation's president. */
  | "discard"
  /** A standing offer's answer (train, private purchase, funding private, player-to-player private trade). */
  | "offer-answer";

/** Which standing offer. */
export type OfferSlot = "train" | "private" | "funding" | "trade";

/** A standing (not yet accepted) offer: who made it and who must answer. */
export interface StandingOffer {
  readonly slot: OfferSlot;
  /** Stable identity while it stands: slot + the offer's instance (`offer_serial`), or its subject when a hand-written
   *  fixture carries no instance. */
  readonly key: string;
  /** The player who made it (re-derived from the board: the buying corporation's president, the funding seller, the
   *  trade's proposer), or `null` when the board names nobody. */
  readonly proposer: string | null;
  /** The player who must answer (re-derived from the board, as the authorities do), or `null`. */
  readonly answerer: string | null;
}

export interface RequiredDecision {
  /** The player id that owes it. */
  readonly seat: string;
  readonly kind: RequiredDecisionKind;
  /** The decision's identity while it stands (stable across commits that do not change it). */
  readonly key: string;
  /** For `offer-answer`: the offer being answered. */
  readonly offer: StandingOffer | null;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The standing (unaccepted) offer, in the holds' priority (the funding offer freezes the board first), or `null`. An
 *  ACCEPTED offer owes no answer: its settlement is derived in the same burst. */
export function standingOfferOf(state: GameStateResponse): StandingOffer | null {
  const purchase = state.private_purchase_offer ?? null;
  if (purchase !== null && purchase.funding === true) {
    return {
      slot: "funding",
      key: `funding:${purchase.instance ?? `p${purchase.private_id}`}`,
      proposer: nonEmpty(purchase.owner) ? purchase.owner : null,
      answerer: buyerPresident(state, purchase.buyer_protocol_id),
    };
  }
  const train = state.train_purchase_offer ?? null;
  if (train !== null && train.accepted !== true) {
    return {
      slot: "train",
      key: `train:${train.instance ?? `${train.buyer_protocol_id}>${train.seller_protocol_id}:${train.model_type}`}`,
      proposer: buyerPresident(state, train.buyer_protocol_id),
      answerer: sellerPresident(state, train.seller_protocol_id),
    };
  }
  if (purchase !== null && purchase.funding !== true && purchase.accepted !== true) {
    return {
      slot: "private",
      key: `private:${purchase.instance ?? `p${purchase.private_id}`}`,
      proposer: buyerPresident(state, purchase.buyer_protocol_id),
      answerer: currentPrivateOwner(state, purchase.private_id) ?? (nonEmpty(purchase.owner) ? purchase.owner : null),
    };
  }
  const trade = state.private_trade_offer ?? null;
  if (trade !== null) {
    return {
      slot: "trade",
      key: `trade:${trade.instance ?? `p${trade.private_id}`}`,
      proposer: nonEmpty(trade.proposer) ? trade.proposer : null,
      answerer: tradeCounterparty(trade),
    };
  }
  return null;
}

/** Whether the board is over (GameEnd, or the room closed): nobody owes anything. */
export function boardIsOver(state: GameStateResponse): boolean {
  return state.current_round_type === "GameEnd" || state.room_closed === true;
}

/** WHO OWES THE NEXT REQUIRED HUMAN DECISION, or `null` (no deal, the game over, or a board that names nobody). */
export function requiredDecisionOf(state: GameStateResponse, waterfall: WaterfallStateResponse | null): RequiredDecision | null {
  try {
    if (!Array.isArray(state.player_addresses) || state.player_addresses.length === 0) return null;
    if (boardIsOver(state)) return null;
    const seated = (seat: string | null): seat is string => nonEmpty(seat) && state.player_addresses.includes(seat);
    /* 1. The excess-train discard (#1530): everything but the discard is refused until it is made. */
    const discard = pendingTrainDiscards(state);
    if (discard !== null && seated(discard.required.president)) {
      return { seat: discard.required.president, kind: "discard", key: `discard:${discard.required.companyId}:${operatingTurnKey(state)}`, offer: null };
    }
    /* 2. A standing offer's answer (the funding offer first, then the ordinary ones -- the holds' order). */
    const offer = standingOfferOf(state);
    if (offer !== null && seated(offer.answerer)) {
      return { seat: offer.answerer, kind: "offer-answer", key: `offer:${offer.key}`, offer };
    }
    /* 3. The B&O par, owed before any auction message is taken (DA-F7). */
    if (state.current_round_type === "WaterfallAuction") {
      const owner = boParOwedTo(state);
      if (seated(owner)) return { seat: owner, kind: "bo-par", key: "bo-par", offer: null };
    }
    /* 4. The ordinary turn holder (the contest's bidder first: #544). */
    const seat = actingAddress(state, waterfall);
    if (!seated(seat)) return null;
    const contest = state.current_round_type === "WaterfallAuction" && waterfall?.mini_auction ? true : false;
    return {
      seat,
      kind: contest ? "auction-bid" : "turn",
      key: `${contest ? "bid" : "turn"}:${String(state.current_round_type)}|${operatingTurnKey(state)}|${seat}`,
      offer: null,
    };
  } catch {
    return null;
  }
}

/** The ROUND INSTANCE a board is in -- one Stock Round, one operating sub-round (OR 2.1 and OR 2.2 are two instances),
 *  one auction -- from the board's own authoritative round identity (`current_round_type`, `macro_round_number`,
 *  `sub_round_index`), never from time. The Live two-decline limit is scoped to it: it resets when the instance ends. */
export function roundInstanceKeyOf(state: GameStateResponse): string {
  return `${String(state.current_round_type ?? "none")}/${state.macro_round_number ?? 0}/${state.sub_round_index ?? 0}`;
}
