import type { GameStateResponse } from "./gameState";

/* ==================================================================
 *  DESIGN NOTE 745: A TURN IN WHICH YOU SOLD IS NOT A PASS
 * ==================================================================
 *
 * REPORTED: "it seems that the only way to avoid the 'Passed' designation (and thus the end of the Stock
 * Round) is to buy a share. That is incorrect: players may EITHER sell a number of shares up to the relevant
 * limits, OR buy 1 share (in a corporation they haven't sold this round), or both. Both selling and buying
 * count as actions, so a player who only sells but does not buy should not be labeled as 'Passed' -- they
 * took an action and therefore guaranteed themselves at least one more action opportunity in the SR."
 *
 * THE BUG IS AT A SEAM, WHICH IS WHY BOTH HALVES LOOKED RIGHT. `SellStock` zeroes `consecutive_passes` --
 * correctly, and #610 leans on exactly that when it says the PASSED stamps "cannot outlive the round of
 * passing that produced them". `recordPass` then increments it -- also correctly, since a pass is a pass.
 * What neither knows is that in 1830 a sale does not END a turn: the player may still buy, so the seat stays
 * put, and the only way to finish is to press the same Pass button somebody who did nothing would press. The
 * sale zeroed the streak and the Pass immediately put it back to one. Every trace of the action was gone.
 *
 * SO THE FIX IS NOT A NEW RULE, IT IS A DISTINCTION THE APP DID NOT HAVE: ending a turn and passing a turn
 * are two different things that had one button and one message. `PassTurn` still carries both -- adding a
 * second message would fork the log for a difference the reducer can derive -- but the reducer now asks which
 * one it is before counting it.
 *
 * WHY IT MATTERS BEYOND A COSMETIC STAMP: `consecutive_passes` is the Stock Round's ONLY termination
 * condition. A seller whose turn counted as a pass could be the fourth pass at a four-player table, ending
 * the round on the turn of somebody who had just acted -- the precise thing the rulebook's "guaranteed at
 * least one more opportunity" exists to prevent. The stamp is the symptom; the round ending early is the bug.
 */

/** Did the seat now acting already do something this turn? */
export function hasActedThisTurn(state: Pick<GameStateResponse, "turn_action_taken">): boolean {
  return state.turn_action_taken === true;
}

/* THE BUTTON HAS TO SAY WHICH ONE IT IS. A player who has just sold and is looking at a button marked "Pass
 * Turn" has every reason to believe pressing it will forfeit something -- which is what the report describes
 * discovering. The two labels are the cheapest possible statement of the rule, and they appear at the exact
 * moment the player needs it rather than in a rulebook they would have to go and read.
 *
 * AND THE SECOND LABEL NAMES THE THING BEING DECLINED, not the turn being finished. Proposed alongside the
 * report: "Since there's a strict ordering -- players in this game sell and then buy, not the other way round
 * -- we could have the Action bar show 'Pass' if they have taken neither action, and if they sell replace the
 * 'Pass' button with a 'Skip Buy Share' button."
 *
 * WHICH IS BETTER THAN "End Turn", the first draft of this. Both are honest about the pass count, but "End
 * Turn" says only what the button does to the clock. 1830's sell-then-buy ordering means a player who has
 * sold is standing at exactly one remaining decision, and the label can therefore name it: the button is not
 * a generic terminator, it is the "no thank you" to the buy. That also teaches the ordering to a player who
 * did not know it -- the label changing from "Pass" to "Skip Buy Share" is the app saying, at the only moment
 * it matters, that the sell half is behind them and the buy half is what is left. */
export const PASS_LABEL = "Pass Turn";
export const SKIP_BUY_LABEL = "Skip Buy Share";

export function passButtonLabel(acted: boolean): string {
  return acted ? SKIP_BUY_LABEL : PASS_LABEL;
}

export function passButtonTitle(acted: boolean): string {
  return acted
    ? "Decline the share purchase and end your turn. You have already sold, so this does not count as a pass."
    : "Pass / skip your turn.";
}
