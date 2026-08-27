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

// ==================================================================
//  DESIGN NOTE 885: THE HALF THAT DECIDES, BESIDE THE HALF THAT READS
// ==================================================================
//
// THIS MODULE HELD ONLY THE READING END. `isBonusLay` answers "was this message flagged?", but the sentence
// that decides whether to flag it -- "the errand the player came through is the C&StL's" -- lived inline in
// `handleConfirmRadialLay`, forty lines from any of the reasoning above. #776's whole finding was that the
// two privates are opposites and easy to conflate; keeping the decision away from the paragraph that spells
// that out is how they get conflated again.
//
// THE KEY IS COMPARED, NOT THE HEX. Same reason as `isBonusLay`: a connected B-20 lay can legitimately be
// the ordinary placement, so the hex cannot say which lay this is. The errand can.
//
// NARROWED TO `private-tile` FIRST. A `private-station` errand (#866, the D&H's free token) lays no tile at
// all, so it can never be a bonus lay -- and it carries `abilityKey: "dh-token"`, which is neither key here.
// Checking the kind first means a future ability key cannot accidentally match through a station errand.

/** The C&StL's tile-lay ability key, as the private-power flow spells it. */
export const CSL_ABILITY_KEY = "csl-tile";

/** The shape this rule needs from an errand -- deliberately narrower than `homeStationPlacement`, so the
 *  rule can be tested without building a whole placement. */
export interface BonusLayErrand {
  kind: string;
  abilityKey?: string | null;
}

/** Whether a lay made through this errand is EXTRA rather than the corporation's ordinary placement.
 *
 *  The D&H (`dh-tile`) is excluded on purpose -- #548: its lay consumes the placement and only its token is
 *  free. No errand at all is an ordinary lay, which is what every lay outside a private power is. */
export function errandLaysBonus(errand: BonusLayErrand | null | undefined): boolean {
  if (!errand || errand.kind !== "private-tile") return false;
  return errand.abilityKey === CSL_ABILITY_KEY;
}
