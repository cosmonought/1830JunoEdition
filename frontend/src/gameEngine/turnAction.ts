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

/* THE BUTTON HAD TO SAY WHICH ONE IT WAS (#745). A player who had just sold and was looking at a button marked "Pass
 * Turn" had every reason to believe pressing it would forfeit something, so the label changed with the turn: "Pass
 * Turn" before any action, "Skip Buy Share" after a sale -- the "no thank you" to the one decision 1830's old
 * sell-then-buy ordering left, at a time when a purchase itself ended the turn.
 *
 * ==================================================================
 *  PHASE 3 W2-B (OD-2, RULES v13): ONE LABEL, AND THE DIFFERENCE MOVES TO THE TITLE
 * ==================================================================
 * OWNER RULE (OD-2, 2026-10-03): "Sell whenever legal; take at most one Buy action; after buying, Buy is unavailable
 * but Sell remains available; the player-facing button is named 'Pass Turn'; Pass Turn ends the player's turn in ONE
 * click." The reducer has played that since rules revision 2 (W3-K: `passEndsStockTurn`), so the second label is
 * retired rather than kept: after a sale the player may still buy, and after a purchase "Skip Buy Share" would
 * name a decision already made -- either way the label would describe a stage, and the stage walk is gone. The
 * control is "Pass Turn" in every state and sends ONE `PassTurn`.
 * #745'S DISTINCTION IS NOT RETIRED WITH THE LABEL. Whether this press ends an acted turn (no pass is counted) or is
 * a true pass (it counts toward the Stock Round's all-pass close) is still the reducer's `turn_action_taken`, and the
 * title says which -- read off the replayed state, so an Undo past the action takes the sentence back with it. */
export const PASS_LABEL = "Pass Turn";

/** The one Pass control's title. In a Stock Round it names which of #745's two meanings this press has; elsewhere (the
 *  Waterfall Auction's Pass) a pass is only a pass. */
export function passButtonTitle(acted: boolean, stockRound = false): string {
  if (acted) return "End your turn. You have already acted this turn, so this does not count as a pass.";
  return stockRound
    ? "End your turn without buying or selling. A turn with no action is a pass; the Stock Round ends when every player passes in succession."
    : "Pass / skip your turn.";
}
