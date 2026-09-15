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

import type { GameStateResponse } from "../gameEngine/gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import { applyPrivateRevenue, type PrivatePayout } from "../gameEngine/sandboxSession";

export interface AuctionTransition {
  /** Privates that gained a player owner in this action, in roster order of the list. */
  won: Array<{ privateId: number; name: string; player: string; price: number }>;
  /** The offered private whose price fell, when everyone passed. */
  markdown: { privateId: number; name: string; from: number; to: number } | null;
  /** Whether this action was the all-pass -- the pass that ended a full round of them.
   *
   *  #1580: this is no longer the same question as "was income paid". Rulebook §1.2.3 pays private income on
   *  an all-pass only once the Schuylkill Valley has been SOLD; before that an all-pass marks the SV down and
   *  pays nobody. Both are all-passes and both say "everyone passed" on screen; `payouts` is what carries the
   *  money, and it is read off the boards rather than assumed from this flag. */
  allPassed: boolean;
  /** The income actually paid on this action, per private -- empty when none was. */
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
  /* ==================================================================
      DESIGN NOTE 1580 (narration): PRESENTATION SYNCHRONISED WITH THE AUTHORITATIVE BOARD
     ==================================================================
     THIS IS NOT A RULE, AND THE DISTINCTION IS THE WHOLE OF THE NOTE. §1.2.3 decides when private income is
     paid, and that decision belongs to the reducer alone (`applySandboxWaterfallAction`, #1580): an all-pass
     with the Schuylkill Valley still unsold marks the SV down and pays nobody; only an all-pass after the SV
     has sold pays income. Nothing here re-decides any of that, and nothing here may.

     WHAT CHANGED IS THAT THIS MODULE STOPPED ASSUMING. `applyPrivateRevenue(after)` was computed on EVERY
     all-pass, which was a faithful reading of the board only while the reducer paid on every all-pass. Once
     it gained a branch that pays nothing, the same line became a claim rather than an observation -- it would
     have printed a payout for money that never moved, which is #778's failure shape ("a log that cannot
     distinguish 'did it' from 'declined it'") in the narration layer.

     SO IT IS SYNCHRONISED WITH THE BOARD, the way #1340a says everything here is: private income is funded by
     the bank in one write (#329/#1560), so a bank that did not fall did not pay. The before/after pair is the
     evidence, and no rule is restated to read it -- a markdown all-pass and the $0 taker move no money at all
     and therefore report no payout, whatever the rule behind them happens to be. */
  const bankPaid =
    (Number(before.virtual_bank_vgp) || 0) - (Number(after.virtual_bank_vgp) || 0) > 0;
  const payouts = allPassed && bankPaid ? applyPrivateRevenue(after)?.payouts ?? [] : [];

  return { won, markdown, allPassed, payouts };
}
