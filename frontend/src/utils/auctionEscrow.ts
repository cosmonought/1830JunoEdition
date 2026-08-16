// frontend/src/utils/auctionEscrow.ts
//
// What a player can still spend during the Waterfall Auction.
//
// ===================================================================
//  DESIGN NOTE 0: THE MONEY WAS COMMITTED AND NOTHING SAID SO
// ===================================================================
//
// REPORTED: placing a bid does not deduct or escrow the cash, so a player
// can bid money they have already committed elsewhere.
//
// True, and visibly so: a player with $600 could stand $400 on the D&H and
// $400 on the M&H, and every panel on screen would still read $600. In
// 1830 a bid is CASH ON THE CARD -- the note physically leaves your hand
// and sits under the certificate until the private is either won by
// somebody else (refund) or won by you (payment). Two bids totalling more
// than you hold is not a rule violation the contract has to catch; it is a
// move you cannot physically make.
//
// ===================================================================
//  DESIGN NOTE 1: DERIVED, NOT DEDUCTED
// ===================================================================
//
// The tempting implementation is to subtract the bid from `player_cash` on
// dispatch and add it back on a loss. `sandboxSession.ts` explicitly
// declined to do that, and its reasoning holds:
//
//     "A waterfall bid is ESCROWED rather than spent... Charging on the bid
//     and refunding on a loss would be this file modelling a rule it has no
//     business owning."
//
// It is also the fragile version. A deducted balance has to be kept in step
// with the bid list through every raise, drop-out, settle, all-pass markdown
// and UNDO -- six places that can each drift, and design note #310 in
// `App.tsx` is a fresh reminder of what drift costs. The bid list already
// records every commitment; subtracting from it is arithmetic over state
// that exists rather than a second copy of the same fact.
//
// So `player_cash` continues to hold the player's TOTAL, exactly as the
// contract reports it, and available cash is computed from it on demand.
// A refund is then not an operation at all: when a bid leaves the list --
// because its bidder dropped out, or because the private was won and left
// the offer list with every bid on it -- the money is free again on the
// very next render, with nothing to remember to do.
//
// ===================================================================
//  DESIGN NOTE 2: WHAT COUNTS AS COMMITTED
// ===================================================================
//
// Every standing bid on every STILL-UNOWNED private, which is exactly what
// `GetWaterfallState.privates` reports. Bids on a private that has been won
// are gone from the response along with the private, which is correct: that
// contest is over and the losers' money came back.
//
// One bid per player per private is the rule the reducer enforces (a raise
// REPLACES rather than stacks), so this sums the list as it stands rather
// than trying to deduplicate it.

import type { GameStateResponse, WaterfallStateResponse } from "./gameState";

/** What one player currently has locked up in standing auction bids. */
export function escrowedBids(
  waterfall: WaterfallStateResponse | null,
  player: string,
): number {
  if (!waterfall) return 0;
  return waterfall.privates.reduce((total, priv) => {
    const own = priv.bids
      .filter((bid) => bid.bidder === player)
      .reduce((sum, bid) => sum + (Number(bid.bid_amount) || 0), 0);
    return total + own;
  }, 0);
}

/** A player's total cash, as the contract reports it. `null` when the room
 *  does not list them -- which must not be read as $0, because "no data" and
 *  "broke" lead to opposite decisions at a bid input. */
export function totalCash(
  gameState: GameStateResponse | null,
  player: string,
): number | null {
  const entry = gameState?.player_cash.find((row) => row.player === player);
  if (!entry) return null;
  const value = Number(entry.cash_vgp);
  return Number.isFinite(value) ? value : null;
}

/**
 * Total cash minus everything already bid -- what this player can actually
 * commit to a new bid.
 *
 * Floored at zero. A negative would mean the state carries bids the player
 * could never have made, which is a contract-side inconsistency rather than
 * something a UI should render as a negative balance; the floor keeps the
 * gates behaving (nothing is affordable) without inventing a figure.
 *
 * `null` propagates from `totalCash`: unknown stays unknown.
 */
export function availableCash(
  gameState: GameStateResponse | null,
  waterfall: WaterfallStateResponse | null,
  player: string,
): number | null {
  const total = totalCash(gameState, player);
  if (total === null) return null;
  return Math.max(0, total - escrowedBids(waterfall, player));
}

/** Both halves at once, for callers that render the split ("$340 of $600").
 *  Computed together so the two figures can never come from different
 *  renders of the state. */
export interface PlayerAuctionFunds {
  total: number;
  escrowed: number;
  available: number;
}

export function auctionFunds(
  gameState: GameStateResponse | null,
  waterfall: WaterfallStateResponse | null,
  player: string,
): PlayerAuctionFunds | null {
  const total = totalCash(gameState, player);
  if (total === null) return null;
  const escrowed = escrowedBids(waterfall, player);
  return { total, escrowed, available: Math.max(0, total - escrowed) };
}

/**
 * Why `amount` cannot be bid, or `null` when it can.
 *
 * Returns the REASON rather than a boolean so the caller can put it in the
 * disabled button's tooltip. A gate that only says "no" makes the player
 * guess which of the two limits they hit, and the two have opposite
 * remedies: bid more, or drop a bid elsewhere.
 *
 * `raisingFrom` is this player's bid already standing in the contest they
 * are raising within. That money is ALREADY escrowed, so a raise only needs
 * to cover the difference -- charging the full raise against available cash
 * would make a player who is winning unable to defend their own bid, which
 * is the exact opposite of the position they are in.
 */
export function bidRejectionReason(
  funds: PlayerAuctionFunds | null,
  amount: number,
  minimum: number,
  raisingFrom = 0,
): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "Enter a bid amount.";
  if (amount < minimum) return `The minimum bid here is $${minimum}.`;
  if (!funds) return null; // Unknown funds: defer to the contract.
  const needed = Math.max(0, amount - raisingFrom);
  if (needed > funds.available) {
    return funds.escrowed > 0
      ? `Only $${funds.available} available — $${funds.escrowed} of your $${funds.total} is escrowed in standing bids.`
      : `Only $${funds.available} available.`;
  }
  return null;
}
