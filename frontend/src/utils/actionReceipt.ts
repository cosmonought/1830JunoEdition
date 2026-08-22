// frontend/src/utils/actionReceipt.ts
//
// Which actions get a toast, and why almost none of them do.
//
// ==================================================================
//  DESIGN NOTE 718: A RECEIPT IS NOT A NOTIFICATION
// ==================================================================
//
// REPORTED: "There seem to be toast notifications for literally every action now: when players buy stocks,
// place home stations, pass, lay tracks ... These actions are clearly visible on the screen so they don't need
// a toast. Please remove all the toast notifications I did not explicitly ask you to implement."
//
// ACCURATE, AND THE FAULT IS #697'S. That note answered one report -- "of the Buy Trains step: it is slightly
// hard to tell whether the purchase went through" -- and then hung the fix on `runGameplayAction`, which is
// the funnel EVERY dispatch passes through. A remedy for one panel became a remedy for all of them the moment
// it was attached there, and nothing in the code recorded that this was not intended. The note even argues the
// scope correctly ("did it go through" is a question about a button you pressed) without ever noticing that
// it had answered a question nobody asked about forty other buttons.
//
// THE MISTAKE IS THE ONE THIS CODEBASE KEEPS MAKING, from the other end. Usually a rule is stated in a note or
// a predicate and never enforced in code (#712's 60% cap, #713's successor rule, #714's private powers). This
// is the inverse: a rule stated in a note and OVER-enforced by the code, because the attachment point was
// chosen for convenience rather than for scope. Both come from the same gap -- the note and the code were
// never made to answer to each other -- and both are worth catching the same way, which is why this rule is a
// function with a harness instead of an `if` at the call site.
//
// SO: WHAT ACTUALLY EARNS ONE. #697's own test is the right one and it simply was not applied: a receipt is for
// an action whose confirmations are all somewhere other than where the player clicked. Run the list in the
// report against it and every item fails --
//
//   buy stock         the share count, the treasury and the market price all move in the panel being read
//   place home station a token appears on the hex just clicked
//   pass              the turn indicator moves, which is the entire visible state of a pass
//   lay track         the tile is drawn under the cursor
//
// -- and the depot purchase passes, for the reason #697 gave: the treasury is on a card, the supply is in a
// table, the fleet is a row of chips, and the player is looking at a button. Nothing changes at the click.
//
// SILENT BY DEFAULT, which is the part that keeps this fixed. The rule NAMES the actions that get a receipt
// rather than naming the ones that do not, so a message type added next year is quiet until somebody decides
// otherwise. The previous shape defaulted the other way and that is precisely how it grew to cover the board.
//
// CORP-TO-CORP TRAIN TRADES ARE EXCLUDED, and this is a judgement rather than a deduction. They ARE train
// purchases and they are equally invisible at the click -- but since #701 they settle through a two-player
// consent handshake, and the modal resolving on an accepted answer is already a confirmation delivered exactly
// where the player is looking. A toast behind it would be the second receipt for one decision.
//
// See docs/ai_architecture/ui_shell_layout.md, actionReceipt.ts #718.

/** The gameplay messages that buy a train from the depot.
 *
 *  Both are the reported surface: `BuyHardwareFromPool` is the Buy Trains button, and `EmergencyBuyHardware`
 *  is the same purchase forced on a president who cannot afford it -- the same panel, the same invisibility,
 *  and a moment where a player is markedly LESS sure what just happened to them. */
const RECEIPT_MESSAGE_KEYS: readonly string[] = ["BuyHardwareFromPool", "EmergencyBuyHardware"];

/** Whether this dispatch should raise a toast.
 *
 *  Takes the MESSAGE rather than the derived label, deliberately. The label is prose assembled for the
 *  Activity Log and it changes whenever somebody improves a sentence; matching on it would make the toast
 *  quietly dependent on wording. The message key is the action's identity. */
export function deservesActionReceipt(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  return RECEIPT_MESSAGE_KEYS.some((key) => key in msg);
}

/** Exposed for the harness, which asserts this set against the whole gameplay allow-list -- so adding a
 *  message somewhere else in the app cannot silently opt it into a receipt. */
export const ACTION_RECEIPT_MESSAGE_KEYS = RECEIPT_MESSAGE_KEYS;
