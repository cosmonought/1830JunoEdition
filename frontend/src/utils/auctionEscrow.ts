// What a player can still spend during the Waterfall Auction.
//
// Design note #0: a bid is CASH ON THE CARD. Nothing deducted the money, so a
// player with $600 could stand $400 on two privates and every panel still read
// $600 -- not a rule violation the contract has to catch, but a move you cannot
// physically make.
//
// Design note #1: DERIVED, NOT DEDUCTED. `player_cash` keeps the contract's own
// TOTAL and available cash is computed on demand, so a refund is not an
// operation at all -- when a bid leaves the list the money is free on the next
// render. Deducting would need keeping a balance in step through every raise,
// drop-out, settle, markdown and UNDO.
//
// Design note #2: committed means every standing bid on every STILL-UNOWNED
// private, exactly what `GetWaterfallState.privates` reports. One bid per player
// per private is the reducer's rule (a raise REPLACES rather than stacks), so
// this sums the list as it stands.
//
// See docs/ai_architecture/contract_economy.md, auctionEscrow.ts #0 - #2.

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

/** Total cash minus everything already bid -- what this player can actually
 *  commit to a new bid.
 *
 *  Floored at zero: a negative would mean the state carries bids the player could
 *  never have made, which is a contract-side inconsistency rather than something
 *  a UI should render as a balance. `null` propagates from `totalCash`. */
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

/** Why `amount` cannot be bid, or `null` when it can.
 *
 *  Returns the REASON rather than a boolean so the caller can put it in the
 *  disabled button's tooltip: a gate that only says "no" makes the player guess
 *  which of the two limits they hit, and the two have opposite remedies.
 *
 *  `raisingFrom` is this player's bid already standing in the contest they are
 *  raising within. That money is ALREADY escrowed, so a raise only needs to cover
 *  the difference -- charging the full raise would make a player who is winning
 *  unable to defend their own bid. */
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
