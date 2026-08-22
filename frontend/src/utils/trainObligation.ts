/* ==================================================================
 *  DESIGN NOTE 751: THE MANDATORY PURCHASE NEEDED A DOOR, NOT A WALL
 * ==================================================================
 *
 * REPORTED, as part of a longer walk-through: "when a corporation gets to the Buy Trains action and can't
 * afford it, let's have the normal Buy button grayed out with the explanation as usual, and a new 'Emergency
 * Train Purchase' button that opens a modal instead -- it is important that this be a button because the
 * corporation could fulfill its obligation by buying from another corporation instead."
 *
 * THE OLD ARRANGEMENT WAS A WALL. #3 mounted the emergency modal the instant a plan existed and gave it no
 * dismissal -- "the plan IS the mount condition; there is no dismissal" -- which is right about the
 * OBLIGATION and wrong about the METHOD. 1830 obliges a trainless corporation with a route to acquire a
 * train; it does not oblige it to buy from the Depot. Buying from a rival is a legal and sometimes far
 * cheaper way to discharge the same duty, and an unskippable Depot modal made that unreachable.
 *
 * SO THE OBLIGATION MOVES TO THE PASS BUTTON and the emergency becomes one way to satisfy it. The refusal
 * names both escapes, because a blocked control that does not say what would unblock it is the failure #619
 * is about.
 *
 * IT IS THE SAME SHAPE AS #707, one step further along: that note made a corporation which CAN run, run. This
 * makes a corporation which MUST buy, buy -- and both are enforced by refusing the pass rather than by
 * removing the player's choice of how.
 */

export interface TrainObligationInput {
  /** Is this corporation's Hardware step the one being played? */
  atHardwareStep: boolean;
  /** Does it own no trains at all? */
  trainless: boolean;
  /** Would it have a route to run if it had one? #707's probe -- a corporation with no reachable run is
   *  under no obligation, which is why this is threaded in rather than assumed. */
  couldRunARoute: boolean;
  ticker: string;
}

/** Why this corporation may not pass its Buy Trains step, or `null`.
 *
 *  A REASON, NEVER A BOOLEAN (#619). The two escapes are named because a president looking at a disabled
 *  Buy button and a disabled Pass button has to be told that a rival's train is also an answer -- it is the
 *  one route out that no control on this panel offers. */
export function trainPurchaseRefusal(input: TrainObligationInput): string | null {
  if (!input.atHardwareStep) return null;
  if (!input.trainless) return null;
  if (!input.couldRunARoute) return null;
  return (
    `${input.ticker} owns no train and has a route to run, so it must acquire one. ` +
    `Buy from the Bank Depot, buy from another corporation, or use an emergency purchase.`
  );
}

/** Whether the Emergency Train Purchase button should be offered at all.
 *
 *  OFFERED ONLY WHEN THE TREASURY IS SHORT, and deliberately not when it merely might be: a corporation that
 *  can pay has an ordinary purchase to make, and a second button beside it saying "emergency" would invite a
 *  president to reach for the president's own cash when the company's money was sufficient. In 1830 those
 *  two piles may not be mixed except in this one case, so the button appearing IS the statement that the
 *  case has arisen. */
export function emergencyPurchaseAvailable(input: {
  obliged: boolean;
  treasury: number;
  cheapestTrainCost: number | null;
}): boolean {
  if (!input.obliged) return false;
  if (input.cheapestTrainCost === null) return false;
  return input.treasury < input.cheapestTrainCost;
}

/* ==================================================================
 *  DESIGN NOTE 751a: WHEN THERE IS NOTHING LEFT TO DECIDE
 * ==================================================================
 *
 * REPORTED: "so as to keep a losing player from blocking the end of the game, 28d should be autocomputed at
 * the start of a Buy Emergency Train action and automate itself to the Game End if there are no meaningful
 * player decisions to be made."
 *
 * "NO MEANINGFUL DECISION" HAS A PRECISE MEANING HERE and it is worth pinning rather than paraphrasing: the
 * president's maximum raisable -- treasury plus cash plus every share the rules let them sell -- falls short
 * of the train. `resolveEmergencyFunding` already computes that as `bankrupt`, and it compares the SELLABLE
 * ceiling rather than the portfolio, "because a president can hold a fortune in unsellable paper and still be
 * bankrupt" (endgame.ts #1).
 *
 * WHAT MAKES IT SAFE TO AUTOMATE is that the outcome does not depend on WHICH shares are sold. Every legal
 * sale still leaves the corporation short, so the ordering a player might agonise over changes nothing about
 * where the game finishes -- only about the final standings, and those are computed from what is left after
 * a liquidation that is itself forced. There is no choice to take away.
 *
 * THE PLAYER STILL SEES IT HAPPEN. The modal opens read-only with the liquidation listed and one
 * acknowledgement, chosen over ending the game outright: a player whose game just ended is owed the
 * arithmetic, and a screen that appears and resolves itself is how somebody concludes the app cheated them.
 */
export function noDecisionRemains(funding: {
  bankrupt: boolean;
  mustRaiseBySelling: number;
}): boolean {
  return funding.bankrupt;
}

/** Whether the president has an actual choice of which shares to sell -- more than one sellable position, or
 *  one position they need only part of. Used to keep the share table honest about what it is asking. */
export function saleChoiceExists(funding: {
  bankrupt: boolean;
  mustRaiseBySelling: number;
  holdings: readonly { proceeds: number; sellableCertificates: number }[];
}): boolean {
  if (funding.bankrupt) return false;
  if (funding.mustRaiseBySelling <= 0) return false;
  const live = funding.holdings.filter((entry) => entry.sellableCertificates > 0);
  if (live.length === 0) return false;
  if (live.length > 1) return true;
  /* One position, and it raises more than is needed: the president still chooses HOW MUCH, which is a real
     decision -- selling a share costs a market row whether or not the money was wanted. */
  return live[0].proceeds > funding.mustRaiseBySelling;
}
