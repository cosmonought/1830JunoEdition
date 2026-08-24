// frontend/src/utils/bonusLay.ts
//
// Which tile lays are IN ADDITION to a corporation's ordinary one.
//
// ==================================================================
//  DESIGN NOTE 776: THE STEP ENDED ON A LAY THAT WAS NOT THE LAY
// ==================================================================
//
// REPORTED: "CSL's special power is supposed to allow for a SECOND track lay, but in my playthrough using its
// power advanced the Lay Track subphase completely."
//
// ONE LINE WAS DOING TWO JOBS. `stepAfterMessage` read:
//
//     if ("LayTile" in msg) return settleSubPhase(state, "Tokens");
//
// which is the "one tile per turn" rule -- correct, and the rule #766 had to restore after a regression made
// lays unlimited -- and is ALSO what ends the Track step on the Champlain & St. Lawrence's bonus lay, which
// is wrong. The cursor is what withdraws the Lay Track controls, so ending the step IS the second lay being
// taken away.
//
// THE RULE WAS WRITTEN DOWN AND NEVER ENFORCED, for the seventh time in this project. `privateCatalog.ts`
// says it outright -- "The lay is a bonus rather than a substitute: the corporation still gets its ordinary
// tile placement that turn, so it may lay two" -- and #548 lists it as one of the four corrections the
// verbatim rulebook text was carried to protect, with the D&H named as its exact opposite. Both descriptions
// were right the whole time. Nothing asked them.
//
// THE MESSAGE NOW SAYS WHICH LAY IT IS, rather than the reducer guessing. #757's note had already named this
// gap while declining to close it: "this message carries no indication of which power is in play -- so a
// reducer that enforced connectivity would refuse two real abilities."
//
// WHY NOT INFER IT FROM THE BOARD, which was the tempting alternative: a lay on B-20 by the corporation
// owning an open C&StL LOOKS like the bonus, but a connected B-20 lay can legitimately be the ordinary one,
// and a reducer that assumed otherwise would hand out a free second tile in exactly that case. The shell
// knows which control the player used; inference would be it discarding what it knows and then guessing.
//
// OPTIONAL, AND ABSENT MEANS ORDINARY -- #712's rule for `quantity` applied again. Every log entry already
// written and every contract dispatch omits this field, and a replay of an older room has to keep meaning
// what it meant when it was recorded.
//
// THE D&H IS DELIBERATELY NOT HERE. Its lay CONSUMES the corporation's placement (only the token is free),
// so it is an ordinary lay with an unusual legality rule and must keep ending the step. The two privates are
// opposites and the pair is easy to conflate; that is why #548 spells both out.

import type { GameplayExecuteMsg } from "./sessionKey";

/** The private whose lay is extra. Champlain & St. Lawrence, `private_id` 2. */
export const BONUS_LAY_PRIVATE_ID = 2;

/** Whether this message is a tile lay that does NOT consume the corporation's ordinary placement.
 *
 *  Reads the flag rather than the board: see the note above on why inference is the wrong tool here. A
 *  message without the flag is an ordinary lay, which is what every message written before #776 is. */
export function isBonusLay(msg: GameplayExecuteMsg | Record<string, unknown>): boolean {
  if (typeof msg !== "object" || msg === null || !("LayTile" in msg)) return false;
  const lay = (msg as { LayTile?: { bonus_lay?: boolean } }).LayTile;
  return lay?.bonus_lay === true;
}

/** Whether a lay should end the Track step.
 *
 *  Stated positively and separately from `isBonusLay` because this is the sentence the cursor cares about,
 *  and a caller reading `!isBonusLay(msg)` at the call site is one negation away from the bug this module
 *  exists to fix. */
export function layEndsTrackStep(msg: GameplayExecuteMsg | Record<string, unknown>): boolean {
  return !isBonusLay(msg);
}
