// frontend/src/utils/auctionTransition.ts
//
// What one auction action did, read off the two boards -- for the shell's sentences, never for its arithmetic.
//
// ==================================================================
//  DESIGN NOTE 1340a: THE SHELL NARRATES FROM THE DIFF
// ==================================================================
//
// #1340 made the reducer atomic: the auction's charges, wins, all-pass income, close and re-seat all settle
// inside `applySandboxAction`, and the waterfall sub-reducer's report (`charges`, `won`, `allPassed`,
// `markdown`) is no longer read outside `sandboxSession.ts`. The shell still owes the table its sentences --
// "Bubba won Schuylkill Valley for $20", "Everyone passed — the C&SL drops from $40 to $35", the payout lines
// -- and the B&O par prompt, and the settled price beside each private.
//
// EVERY ONE OF THOSE IS A FACT ABOUT THE TWO STATES, so this reads them the way #1272 reads a treasury and
// #1339 reads the viewer's cash: a private whose `owner` went from nobody to somebody was WON, at the
// `settled_price` the reducer recorded; an offered private whose `face_value` fell was MARKED DOWN; and the
// all-pass is the pass that reset the streak, whose payouts are `applyPrivateRevenue`'s own list over the
// board's ownership (the amounts depend on who owns what, which the after-state knows). No flag crosses the
// reducer's boundary, and nothing here can move money.

import type { GameStateResponse } from "./gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import { applyPrivateRevenue, type PrivatePayout } from "./sandboxSession";

export interface AuctionTransition {
  /** Privates that gained a player owner in this action, in roster order of the list. */
  won: Array<{ privateId: number; name: string; player: string; price: number }>;
  /** The offered private whose price fell, when everyone passed. */
  markdown: { privateId: number; name: string; from: number; to: number } | null;
  /** Whether this action was the all-pass that paid private income. */
  allPassed: boolean;
  /** The income paid on the all-pass, per private -- empty otherwise. */
  payouts: PrivatePayout[];
}

const EMPTY: AuctionTransition = { won: [], markdown: null, allPassed: false, payouts: [] };

function isWaterfallPass(msg: GameplayExecuteMsg): boolean {
  return "WaterfallPass" in msg;
}

export function describeAuctionTransition(
  before: GameStateResponse | null,
  after: GameStateResponse | null,
  msg: GameplayExecuteMsg,
): AuctionTransition {
  if (!before || !after) return EMPTY;
  const auctionBefore = before.waterfall;
  const auctionAfter = after.waterfall;
  if (!auctionBefore || !auctionAfter) return EMPTY;

  const won: AuctionTransition["won"] = [];
  for (const entry of after.private_companies) {
    const was = before.private_companies.find((p) => p.private_id === entry.private_id);
    if (!was || was.owner || !entry.owner) continue;
    won.push({
      privateId: entry.private_id,
      name: entry.name,
      player: entry.owner,
      price: entry.settled_price ?? Number(entry.cost) ?? 0,
    });
  }

  let markdown: AuctionTransition["markdown"] = null;
  for (const offered of auctionBefore.privates) {
    const still = auctionAfter.privates.find((p) => p.private_id === offered.private_id);
    const from = Number(offered.face_value) || 0;
    const to = still ? Number(still.face_value) || 0 : null;
    if (to !== null && to < from) {
      markdown = { privateId: offered.private_id, name: offered.name, from, to };
      break;
    }
    /* The $0 branch: marked down to nothing and handed on in the same pass -- gone from the offer list, and
       won for $0 by the next seat. */
    if (to === null && won.some((w) => w.privateId === offered.private_id && w.price === 0)) {
      markdown = { privateId: offered.private_id, name: offered.name, from, to: 0 };
      break;
    }
  }

  /* An all-pass is the pass that RESET the streak (a buy resets it too, but a buy is not a pass). */
  const allPassed =
    isWaterfallPass(msg) &&
    auctionBefore.consecutive_waterfall_passes > 0 &&
    auctionAfter.consecutive_waterfall_passes === 0;
  const payouts = allPassed ? applyPrivateRevenue(after)?.payouts ?? [] : [];

  return { won, markdown, allPassed, payouts };
}
