// frontend/src/utils/delayedAuctionStatus.ts
//
/* ==================================================================
    PHASE 3 W2-I (AUD-02.08): A STANDING "DELAYED AUCTION OWED / CANCELLED" STATUS, READ OFF THE BOARD
   ==================================================================
   Under the Delayed Auction variant the private company auction is OWED from the first Stock Round until the end
   of the Operating Round set in which the first 3-train is bought (#905). If the first 5-train is bought before it
   runs, D-55 (DA-5) cancels it for good: the unsold privates close and the B&O opens. Until now the only trace of
   either fact was the Rules Reference's glance strip and one Activity Log line at the moment of cancellation.

   THIS DECIDES NOTHING. It reads the board's own fields, exactly as the engine leaves them:
     - `resolveVariants(variants).delayedAuction` -- whether the table plays the variant at all;
     - `private_auction_complete` -- the engine's one "no auction is owed" flag (#904a). `false` is OWED. Absent
       reads as complete, the same direction `boIsLocked` takes for pre-field logs;
     - the private companies -- `cancelPendingDelayedAuction` reaches `complete: true` WITHOUT selling anything, so
       EVERY private is closed with no owner, player or corporation. An auction that RAN sells every private
       before it closes (`delayedAuctionUnderway`: the Stock Round opens "once every private company is sold");
       Phase 5 keeps the owners it found, and the only closures that release an owner (the B&O's, the M&H's) reach
       one private each. So "complete, and every private closed with no owner" is the cancellation and nothing else.
   No log text is read, no rule is restated, and no flag is kept beside the board's.

   SILENT WHERE ANOTHER SURFACE ALREADY SAYS IT, OR WHERE IT IS NO LONGER A LIVE FACT:
     - during the auction round itself the auction dashboard carries DA-6's title and status line;
     - at `GameEnd` nothing is owed any more and the game-over strip is the status. */

import type { GameStateResponse } from "../gameEngine/gameState";
import { resolveVariants } from "../gameEngine/gameVariants";

export type DelayedAuctionStatus = "owed" | "cancelled" | null;

type StatusBoard = Pick<GameStateResponse, "variants" | "private_auction_complete" | "private_companies" | "current_round_type">;

/** The board's Delayed Auction status: `"owed"`, `"cancelled"` (by the first 5-train, D-55), or `null` (not this
 *  variant, auction already held, auction live right now, or the game is over). */
export function delayedAuctionStatus(board: StatusBoard | null | undefined): DelayedAuctionStatus {
  if (!board) return null;
  if (!resolveVariants(board.variants).delayedAuction) return null;
  if (board.current_round_type === "WaterfallAuction" || board.current_round_type === "GameEnd") return null;
  if (board.private_auction_complete === false) return "owed";
  /* EVERY private closed with no owner, not ANY: two closures in a game whose auction ran also release their owner
     (`settleBaoPrivate`, the B&O's first train; `applyPrivateExchange`, the M&H's NYC exchange), but they reach one
     private each and the others keep the owner the auction gave them. D-55 fires before anything is sold, so its
     board -- and only its board -- has the whole set closed and ownerless. */
  const privates = board.private_companies ?? [];
  const neverSold =
    privates.length > 0 && privates.every((priv) => priv.closed && priv.owner === null && priv.owner_protocol_id === null);
  return neverSold ? "cancelled" : null;
}

/** The chip's words and its hover sentence. One place, so the strip and the tests read the same copy. */
export const DELAYED_AUCTION_STATUS_COPY: Record<Exclude<DelayedAuctionStatus, null>, { label: string; title: string }> = {
  owed: {
    label: "Delayed auction owed",
    title:
      "The private company auction has not been held yet. It runs at the end of the Operating Round set in which the first 3-train is bought; until it concludes the B&O cannot be parred, bought or sold. If the first 5-train is bought first, the auction is cancelled.",
  },
  cancelled: {
    label: "Delayed auction cancelled",
    title:
      "The first 5-train was bought before the delayed auction ran, so it was cancelled: the unsold private companies closed and the B&O is open for trading.",
  },
};
