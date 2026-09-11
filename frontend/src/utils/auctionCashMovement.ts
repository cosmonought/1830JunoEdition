// frontend/src/utils/auctionCashMovement.ts
//
// What the viewer's own cash did during one auction action, for the cash machine.
//
// ==================================================================
//  DESIGN NOTE 1339: THE AUCTION'S MONEY MOVES ON THE SAME MACHINE
// ==================================================================
//
// ASKED (3a, 3b, 3c): the player-cash slide-out with the SPEND sequence and `spend.mp3` when a player buys or
// wins a private; the slide-out with `money-machine.mp3` when the auction's all-pass pays private income; and
// NOT during an Operating Round's private-payout step, where the modal (#1049) handles a player who may be
// paid on several fronts at once rather than stacking slide-outs.
//
// A DIFF, LIKE #1272's TREASURY: the shell holds the two states either side of every dispatch, so it reads
// the viewer's cash off both and asks what moved. Scoped to the WATERFALL AUCTION round, because that round
// has exactly two things that move a player's cash -- a purchase (#334a's `charges`, on a buy or a mini-
// auction win; a bid itself charges nothing) and the all-pass income (#1281) -- and every other round has a
// machine or a modal of its own for what it does to a player's money. The scope IS 3c.
//
// THE LABEL IS THE THING BOUGHT. The private that changed hands into the viewer's this action names the
// spend; income is named as what it is. `null` means the machine has nothing to show.

import type { GameStateResponse } from "./gameState";
import { cashByPlayer } from "./cashDelta";

export interface AuctionCashMovement {
  /** Signed: negative for a purchase. Never zero. */
  amount: number;
  /** What to print beside the figure: the private's name, or "Private income". */
  label: string;
  cashBefore: number;
  cashAfter: number;
}

export function auctionCashMovement(
  before: GameStateResponse | null,
  after: GameStateResponse | null,
  viewer: string | null,
): AuctionCashMovement | null {
  if (!before || !after || !viewer) return null;
  if (before.current_round_type !== "WaterfallAuction") return null;
  const cashBefore = cashByPlayer(before)[viewer];
  const cashAfter = cashByPlayer(after)[viewer];
  if (cashBefore === undefined || cashAfter === undefined) return null;
  const amount = cashAfter - cashBefore;
  if (amount === 0) return null;
  if (amount > 0) return { amount, label: "Private income", cashBefore, cashAfter };
  const gained = after.private_companies.filter(
    (entry) =>
      entry.owner === viewer &&
      before.private_companies.find((was) => was.private_id === entry.private_id)?.owner !== viewer,
  );
  const label =
    gained.length === 0
      ? "Private company"
      : gained.length === 1
        ? gained[0].name
        : `${gained[0].name} +${gained.length - 1}`;
  return { amount, label, cashBefore, cashAfter };
}
