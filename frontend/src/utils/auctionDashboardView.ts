// frontend/src/utils/auctionDashboardView.ts
//
// ==================================================================
//  PHASE 3 W1-B: THE AUCTION DASHBOARD ASKS THE AUCTION'S AUTHORITY
// ==================================================================
//
// AUD-02.01 (K-02 / U-26), AUD-02.02 (K-15), AUD-02.03, P3-N005.
//
// The dashboard used to judge its own controls: `repeatBidReason` refused raising one's own standing bid ("One bid
// per private company") although the engine accepts it (owner ruling D-16, `auctionAuthority.ts`), and
// `bidRejectionReason` was asked without the Delayed Auction's acquisition-solvency rule (DA-5), so a Bid or Buy
// could be drawn enabled and then refused after the click.
//
// NOW EVERY CARD-FACE VERDICT IS `auctionRefusal`'S -- the one entry point the reducer's board gate and ingress
// both ask (`auctionLifecycleRefusal` / `turnRefusal`). It composes the round gate, the owed B&O par,
// `waterfallBuyRefusal` / `waterfallBidRefusal` (each ending in `acquisitionSolvencyRefusal`), and the contest's
// raise and pass predicates. Nothing here restates a rule: this module only builds the message the control would
// send and reads the contest's own counters for display.
//
// WHOSE VERDICT. The auction predicates judge the atom's cursor (`auctionActor`). The dashboard asks only when the
// viewer IS that cursor (its own turn); on anybody else's turn the control is greyed with the turn sentence, never
// with a verdict computed for another player.

import { auctionRefusal } from "../gameEngine/auctionAuthority";
import type {
  GameStateResponse,
  WaterfallMiniAuctionStatus,
  WaterfallStateResponse,
} from "../gameEngine/gameState";

/** The auction predicates never read `game_id`; the room stamps the real one when the message is sent. */
const ANY_GAME = 0;

/** The sentence a control shows when the table itself has not loaded, so nothing can be judged. */
export const AUCTION_TABLE_NOT_LOADED = "The table has not finished loading.";

function ask(
  state: GameStateResponse | null,
  waterfall: WaterfallStateResponse | null,
  msg: Parameters<typeof auctionRefusal>[2],
): string | null {
  if (!state) return AUCTION_TABLE_NOT_LOADED;
  return auctionRefusal(state, waterfall, msg);
}

/** Why the acting player may not buy the lowest-offered private at face value now, or `null`. */
export function dashboardBuyRefusal(
  state: GameStateResponse | null,
  waterfall: WaterfallStateResponse | null,
): string | null {
  return ask(state, waterfall, { WaterfallBuyLowest: { game_id: ANY_GAME } });
}

/** Why the acting player may not bid `amount` on this private now, or `null`. Covers the opening bid AND the
 *  raise of one's own standing bid (D-16): the authority credits the player's own bid on this private against
 *  the escrow, so only the increase must be free. */
export function dashboardBidRefusal(
  state: GameStateResponse | null,
  waterfall: WaterfallStateResponse | null,
  privateId: number,
  amount: number,
): string | null {
  return ask(state, waterfall, {
    WaterfallBidHigher: { game_id: ANY_GAME, private_id: privateId, bid_amount: String(amount) },
  });
}

/** Why the contest's acting bidder may not raise to `amount` now, or `null`. */
export function dashboardContestRaiseRefusal(
  state: GameStateResponse | null,
  waterfall: WaterfallStateResponse | null,
  amount: number,
): string | null {
  return ask(state, waterfall, {
    WaterfallMiniAuctionRaise: { game_id: ANY_GAME, bid_amount: String(amount) },
  });
}

/** Why the contest's acting bidder may not pass now, or `null`. */
export function dashboardContestPassRefusal(
  state: GameStateResponse | null,
  waterfall: WaterfallStateResponse | null,
): string | null {
  return ask(state, waterfall, { WaterfallMiniAuctionPass: { game_id: ANY_GAME } });
}

/* ---- the contest, read for display ---------------------------------------------------------------------------- */

/** How a live contest stands, read from the atom's own counters (`passes_since_raise`, `bidders`, the cursor).
 *
 *  §1.2.2 / design note #1581: a contest pass is a COUNT, not an elimination. The contest ends when
 *  `passes_since_raise` reaches `bidders.length - 1` -- every bidder but the high bidder, who is never asked
 *  (`nextMiniTurn` skips him). The cursor walks `bidders` in order skipping the leader, so the players who have
 *  passed since the last raise are exactly the `passes_since_raise` non-leading bidders immediately before it. */
export interface ContestStanding {
  /** Passes counted since the last raise (absent reads as zero, #232). */
  passes: number;
  /** Passes in a row that end the contest. */
  passesToEnd: number;
  /** Further passes that end it; 1 means the next pass does. */
  remaining: number;
  /** The bidders who have passed since the last raise -- each still in the contest, bid standing. */
  passedSinceRaise: string[];
}

export function contestStanding(mini: WaterfallMiniAuctionStatus): ContestStanding {
  const bidders = mini.bidders ?? [];
  const passesToEnd = Math.max(1, bidders.length - 1);
  const passes = Math.max(0, Math.min(Number(mini.passes_since_raise ?? 0) || 0, passesToEnd));
  const passedSinceRaise: string[] = [];
  const at = bidders.indexOf(mini.current_turn);
  if (at !== -1) {
    for (let step = 1; step <= bidders.length && passedSinceRaise.length < passes; step += 1) {
      const candidate = bidders[(at - step + bidders.length * 2) % bidders.length];
      if (candidate === mini.high_bidder || candidate === mini.current_turn) continue;
      passedSinceRaise.push(candidate);
    }
  }
  return { passes, passesToEnd, remaining: Math.max(1, passesToEnd - passes), passedSinceRaise };
}

/** One line saying how close the contest is to ending (AUD-02.03). */
export function contestProgressSentence(
  mini: WaterfallMiniAuctionStatus,
  leaderName: string,
): string {
  const { passes, passesToEnd, remaining } = contestStanding(mini);
  const tally = `${passes} of ${passesToEnd} pass${passesToEnd === 1 ? "" : "es"} since the last raise`;
  const ending =
    remaining === 1
      ? `one more pass and ${leaderName} wins at $${Number(mini.high_bid) || 0}`
      : `${remaining} more passes in a row and ${leaderName} wins at $${Number(mini.high_bid) || 0}`;
  return `${tally} — ${ending}.`;
}

/** What a contest Pass does, said truthfully (K-15): the passer's bid stands and they stay in the contest. */
export function contestPassTooltip(
  mini: WaterfallMiniAuctionStatus,
  ownBid: number,
  leaderName: string,
): string {
  const { remaining } = contestStanding(mini);
  const stands = ownBid > 0 ? `Your $${ownBid} bid stands` : "Your bid stands";
  const after =
    remaining === 1
      ? `This pass ends the contest: ${leaderName} wins at $${Number(mini.high_bid) || 0}, and your bid is released.`
      : "You stay in the contest and may raise again when the turn comes back to you, unless the other bidders pass first.";
  return `Pass — ${stands}. ${after}`;
}

/** The sentence the action bar's main-sequence Pass shows while a contest is live (K-15, in the S1 const). The
 *  main sequence is suspended until the contest ends (`waterfallPassRefusal`), so the bar names where the
 *  contest is played and what a contest Pass means. */
export function contestBarPassSentence(
  waterfall: WaterfallStateResponse | null,
  viewer: string | null | undefined,
): string | null {
  const mini = waterfall?.mini_auction ?? null;
  if (!mini) return null;
  const name =
    waterfall?.privates.find((entry) => entry.private_id === mini.private_id)?.name ?? "a private company";
  const inIt = !!viewer && (mini.bidders ?? []).includes(viewer);
  return inIt
    ? `${name} is being contested — raise or pass on its highlighted card. A contest pass keeps your bid standing and you stay in the contest.`
    : `${name} is being contested — the auction goes on once its bidders have settled it.`;
}
