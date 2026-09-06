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

/* ==================================================================
    DESIGN NOTE 1184: THE INCREMENT WAS A DISPLAY CONSTANT
   ==================================================================
   REPORTED: "clicking Bid on a private company is registering everyone with the same bid, but players have to
   bid $5 more than the highest current bid."
   AND THE BOARD NEVER ASKED. `MIN_BID_INCREMENT` lived in `WaterfallAuctionDashboard`, under a comment
   calling itself a "hand-kept mirror of `auction::MIN_BID_INCREMENT`" -- so the button computed the legal
   minimum, greyed itself correctly, and the reducer's `WaterfallBidHigher` arm took whatever amount arrived,
   replaced the bidder's standing bid and sorted. Nothing compared the two.
   IT ONLY SHOWS UNDER LATENCY, which is why it has survived. Two players who can both see the standing high
   compute different minimums and bid different amounts. Two players whose clients have not yet received each
   other's bid both compute `face + 5`, both submit it, and both are accepted -- everyone registering the same
   bid, exactly as reported.
   THIS IS #712's SHAPE AND #1172's: a rule written where the control lives and never where the state moves.
   The third instance found in this codebase, and the second this week.
   SAFE IN A REPLAY, unlike #1182. Both sides come out of the log -- the amount travels in the message, the
   standing bids are rebuilt from the same prefix on every client -- so every client reaches the same verdict
   at the same index. Nothing here reads a cursor or a chart.
   THE OPENING BID IS FACE PLUS THE INCREMENT, not face, for design note #22's reason: a bid at face value is
   worth what the lowest offer can be bought outright for, so it offers the seller nothing. */

/** Every bid must beat the standing one by at least this much. */
export const MIN_BID_INCREMENT = 5;

/** The lowest legal bid on this private, from its own face value and the bids standing against it.
 *
 *  THE ACTOR'S OWN BID COUNTS TOWARD THE HIGH. A player raising is still raising ABOVE the table's highest
 *  figure, and excluding their own would let the leader re-bid at their current amount -- which is what the
 *  dashboard has always computed, and this is that arithmetic in a place the reducer can reach. */
export function minimumBidFor(input: {
  faceValue: number | string;
  bids: ReadonlyArray<{ bid_amount: number | string }>;
}): number {
  const standingHigh = input.bids.reduce(
    (max, bid) => Math.max(max, Number(bid.bid_amount) || 0),
    0,
  );
  const floor = standingHigh > 0 ? standingHigh : Number(input.faceValue) || 0;
  return floor + MIN_BID_INCREMENT;
}
