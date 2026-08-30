// frontend/src/utils/trainPurchaseGate.ts
//
// When a depot train purchase is legal. One corporation, at its own step, for money it actually has.
//
// ==================================================================
//  DESIGN NOTE 1019: THE PURCHASE HAD NO GATE AT ALL
// ==================================================================
//
// REPORTED, with the log that proves it:
//
//   [OR 9.1--Dividends] Failed: REFUSED -- NNH withheld $370 ... Only the operating corporation declares
//                       dividends.
//   [OR 9.1--Dividends] NNH bought a D-train for $1100 ... Treasury now $0.
//   [OR 9.2--Buy Trains] Treasury -- NNH spent $340 -- treasury $340 -> $0.
//
// THREE FACTS IN THOSE THREE LINES, and each names a missing rule.
//
// 1. A TRAIN WAS BOUGHT DURING THE DIVIDENDS STEP. `buyDepotTrain` never read `operating_sub_phase`. The
//    dividend step had `dividendGate` guarding it since #774; the Buy Trains step had nothing guarding it,
//    so a `BuyHardwareFromPool` arriving mid-Dividends was executed as ordinary business. #712's shape once
//    more -- a rule enforced on one of two paths -- and this time the unguarded path is the one that moves
//    the most money.
//
// 2. $1100 WAS CHARGED AGAINST $340 AND THE BOARD ACCEPTED IT. There was no affordability check anywhere in
//    the reducer. `adjustTreasury` floors at zero (its own `Math.max(0, ...)`), so the charge did not go
//    negative -- it took everything there was and stopped. `App.tsx` #333 KNEW: "the ordinary message charges
//    the treasury and floors at zero", which is why `EmergencyBuyHardware` exists to top the treasury up
//    first. The knowledge was written down beside the workaround and never turned into a gate, so the
//    ordinary path kept its silent partial execution.
//
//    THAT IS WHY THE TWO LINES DISAGREE ABOUT THE FIGURE. "bought a D-train for $1100" is composed from the
//    depot's price; "$340 -> $0" is derived from the state diff. One says what was asked for and the other
//    says what happened, which is #750's rule stated as a bug.
//
// 3. AND IT LOGGED SUCCESS, because #778's refusal detector works by IDENTITY -- a gate refuses by returning
//    the state it was handed, and this one mutated instead. So the machinery that would have caught it was
//    working perfectly and had nothing to catch. Returning `state` unchanged is therefore the whole of the
//    "throw an error to the UI" half of the report: the drain already renders a refusal, and #784 already
//    names the rule, as soon as the reducer actually refuses.
//
// WHY THE DIVIDEND REFUSAL CAME FIRST IS THE SAME BUG READ BACKWARDS. `operatingCorporationId` is
// `active_operating_order[active_corporation_index]`, and a D-train purchase turns the phase -- which rusts
// trains, trims fleets and, at the end of the turn it should never have been part of, rolls the set from OR
// 9.1 to 9.2 and REBUILDS that order. A cursor moved by an action that had no business running is a cursor
// pointing at the wrong corporation, and the player's perfectly legal withhold then arrived at a board that
// no longer agreed NNH was operating. The dividend gate was not wrong; it was answering about a state the
// train purchase had already corrupted.
//
// SO THE FIX IS ONE GATE IN THE AUTHORITY, not three patches at three call sites -- #1006's lesson from two
// batches ago, where a correct predicate went unasked by the one caller that decided anything.

import type { GameStateResponse } from "./gameState";
import { operatingCorporationId } from "./dividendGate";
import { countableTrainCount, isTrainLocked } from "./trainLimit";

/** The step at which a depot purchase belongs. `"Hardware"` is the Buy Trains step's internal name. */
export const TRAIN_PURCHASE_SUB_PHASE = "Hardware";

export interface TrainPurchaseGateOptions {
  /** The tier that would be bought, or `null` when the depot is empty. */
  cost: number | null;
  /** Trains this corporation may hold in the current phase, or `null` when the state cannot say. */
  trainLimit: number | null;
  /** ==================================================================
   *   DESIGN NOTE 1019: THE EMERGENCY PATH IS EXEMPT FROM THE MONEY CHECK ONLY
   *  ==================================================================
   *
   * `EmergencyBuyHardware` tops the treasury up to exactly the price before calling the same reducer, so by
   * the time the purchase runs the funds are there and this check passes on its own. It is offered as an
   * option anyway because the ORDER matters: the emergency flow reads the shortfall from the treasury BEFORE
   * funding it, and a gate that refused at that moment would make the feature impossible to reach.
   *
   * EVERY OTHER RULE STILL APPLIES TO IT. A president may cover a shortfall; they may not buy out of turn,
   * out of phase, or past the train limit. */
  requireFunds?: boolean;
}

/** Why this depot purchase must not be applied, or `null` if it may be.
 *
 *  A REASON RATHER THAN A BOOLEAN, for #748's reason and `dividendGate`'s: the drain renders this string, so
 *  a refusal the player cannot read is indistinguishable from a bug. */
export function trainPurchaseRefusal(
  state: GameStateResponse,
  companyId: number,
  options: TrainPurchaseGateOptions,
): string | null {
  const { cost, trainLimit, requireFunds = true } = options;

  if (state.current_round_type !== "OperatingRound") {
    return "Trains are bought during an Operating Round.";
  }

  /* THE SAME LOOKUP THE DIVIDEND GATE USES, imported rather than restated. Two readings of one cursor is how
     the two gates would come to disagree about who is operating -- which is the exact confusion this batch's
     log records, and it would be a poor answer to reproduce it in the fix. */
  const acting = operatingCorporationId(state);
  if (acting !== null && acting !== companyId) {
    return "Only the operating corporation buys trains.";
  }

  const step = state.operating_sub_phase;
  /* AN UNKNOWN CURSOR IS ALLOWED THROUGH, matching `dividendGate` exactly. `operating_sub_phase` is optional
     on the response and a seeded or legacy state can arrive without one; refusing there would brick a board
     on a missing field rather than a broken rule. */
  if (step !== undefined && step !== TRAIN_PURCHASE_SUB_PHASE) {
    /* THE REPORTED BUG. A purchase arriving during Dividends ran as ordinary business, turned the phase, and
       moved the cursor out from under the declaration the player was about to make. */
    return "Trains are bought at the Buy Trains step, not during this one.";
  }

  if (cost === null) {
    return "The Bank Depot is empty — every printed train has been bought.";
  }

  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) {
    // #232: a corporation the state does not describe is not a corporation with no money.
    return "That corporation is not on this board.";
  }

  /* THE LIMIT THROUGH THE SHARED RULE, not a second `>=` -- #703's fix, which found the auto-skip and the
     panel enforcing the same rule against two different tiers. */
  /* Design note #1034: THE COUNT, NOT THE ROSTER LENGTH. A gently-rusted train stays in `owned_trains` -- it
     still runs, and it still draws a chip -- but occupies no limit slot, so a corporation holding two live
     trains and one condemned one is at two against the limit rather than three. Locking it out on the roster
     length would refuse a purchase the rules allow, and the sentence would name a figure the player cannot
     see anywhere else on screen.
     THE SENTENCE REPORTS THE SAME FIGURE THE GATE JUDGED. #979's report was that the panel and the auto-skip
     enforced one rule against two different numbers; a refusal that measures one thing and explains another
     is the same fault one layer up. */
  const owned = company.owned_trains;
  const countable = countableTrainCount(owned, company.pending_rust_trains, company.ghost_trains);
  if (owned !== undefined && owned !== null && isTrainLocked(countable, trainLimit)) {
    return `Train limit reached — ${company.ticker ?? "this corporation"} already holds ${countable} of a maximum ${trainLimit}.`;
  }

  if (requireFunds) {
    /* ==================================================================
       THE ATOMIC GATE THE REPORT ASKED FOR
       ==================================================================
       RULED: "The reducer handling train purchases must have a strict, atomic validation gate:
       `if (treasury < trainCost) { return state }`. Transactions must be all-or-nothing."

       READ AS A NUMBER WITH A FALLBACK OF ZERO, deliberately, and this is the one place in this file where
       #232's "unknown is not zero" does NOT apply. A treasury the state cannot express is not a treasury
       that can pay $1100 -- and the failure directions are not symmetric: refusing a purchase a corporation
       could afford costs a click, while allowing one it cannot costs the board its integrity, which is what
       this hotfix is about. */
    const treasury = Number(company.treasury);
    const funds = Number.isFinite(treasury) ? treasury : 0;
    if (funds < cost) {
      return `${company.ticker ?? "This corporation"}'s treasury holds $${funds} — it cannot pay $${cost}.`;
    }
  }

  return null;
}
