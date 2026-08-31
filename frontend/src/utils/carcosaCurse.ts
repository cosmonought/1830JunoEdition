// frontend/src/utils/carcosaCurse.ts
//
// Who is cursed, whether the train is still there, and what the epitaph says.
//
// ==================================================================
//  DESIGN NOTE 1091: ONE ANSWER, BECAUSE FIVE SURFACES ASK
// ==================================================================
//
// The Action Bar, the Stocks tab, the Game Ledger, the train chips and the final scoreboard all need some
// part of "is this corporation cursed, and does it still hold the train". That is five readers of one rule,
// and #891 is this codebase's most expensive recurring bug: two surfaces answering one question two ways.
// `dividendStepFrom` records the same lesson from the other side -- "the bar promising a rise the board does
// not perform".
//
// SO THE RULE IS A FUNCTION AND THE SURFACES RENDER ITS ANSWER. None of them re-reads `is_carcosan` beside
// `carcosan_trains` and draws its own conclusion.
//
// THE DISTINCTION THAT MATTERS is between the two states a cursed corporation can be in, because they get
// DIFFERENT treatment and the ruling is explicit about it:
//
//   HOLDING   `is_carcosan` and the train is still in `carcosan_trains`. The chip already wears the sign
//             (#1088), so the corporation's name gets nothing -- "if they still own the train, the icon on
//             the train chip provides sufficient visual feedback."
//   HAUNTED   `is_carcosan` and the train is gone -- rusted into the fog, taking the chip's icon with it.
//             NOW the name is marked, because otherwise nothing on screen remembers.
//
// A TRANSFERRED CORPORATION IS NEITHER, which is the whole of what the Blood Price buys.

import type { GameStateResponse, PublicCompanyState } from "./gameState";

export type CarcosaStanding = "none" | "holding" | "haunted";

/** Which of the three states this corporation is in. */
export function carcosaStanding(company: Pick<
  PublicCompanyState,
  "is_carcosan" | "carcosan_trains"
> | null | undefined): CarcosaStanding {
  if (!company?.is_carcosan) return "none";
  return (company.carcosan_trains?.length ?? 0) > 0 ? "holding" : "haunted";
}

/** Whether the corporation's NAME should carry the sign.
 *
 *  Design note #1091: `haunted` ONLY. Two marks on one corporation -- a sign on the chip and a sign on the
 *  name -- would read as two different facts rather than one emphasised, and the ruling says so directly. */
export function showsCurseBesideName(company: Pick<
  PublicCompanyState,
  "is_carcosan" | "carcosan_trains"
> | null | undefined): boolean {
  return carcosaStanding(company) === "haunted";
}

/** Every corporation still carrying the curse at the end of the game, holding or haunted.
 *
 *  Design note #1091: BOTH STATES COUNT HERE, unlike the name badge. The scoreboard asks "did the fog take
 *  an interest in this president", and it did whether or not the train survived to the final bell. */
export function cursedCompanies(
  state: GameStateResponse | null | undefined,
): readonly PublicCompanyState[] {
  return (state?.public_companies ?? []).filter((company) => company.is_carcosan === true);
}

/** The line beneath the final standings.
 *
 *  ==================================================================
 *   DESIGN NOTE 1091: THE EPITAPH, VERBATIM
 *  ==================================================================
 *
 * RULED, exactly: "[Corporation]'s ledgers were perfectly balanced, but the ink was yellow, and President
 * [Player Name] was never seen again."
 *
 * BUILT HERE RATHER THAN IN THE MODAL for the reason `turnRevenueSentence` is built in `gameVariants` rather
 * than in `actionLog`: a sentence assembled inside a renderer cannot be tested without one, and this one has
 * two substitutions that a screenshot would not catch getting swapped.
 *
 * `null` WHEN THERE IS NO PRESIDENT TO NAME. A corporation can be cursed and unfloated-into-limbo in a
 * sandbox, and "President undefined was never seen again" is a worse ending than silence. */
export function carcosaEpitaph(ticker: string, presidentName: string | null): string | null {
  if (!presidentName) return null;
  return `${ticker}'s ledgers were perfectly balanced, but the ink was yellow, and President ${presidentName} was never seen again.`;
}

/* Design note #1092: `CARCOSA_FOG_LINE` MOVED TO `yellowSign.ts`. It was a log line here; it is now the
   third stage's flavour CLAUSE, and it belongs beside `YELLOW_SIGN_MALUS_LINE` and `YELLOW_SIGN_BONUS_LINE`
   -- the two sentences the other stages substitute -- rather than in the module about the corporation's
   curse. Re-exported below so a reader who looks for it here is not sent hunting. */
export { CARCOSA_FOG_LINE } from "./yellowSign";

/** The stamp those lines carry, matching the two the Yellow Sign already writes (#1046). */
export const CARCOSA_STAMP_STEP = "Yellow Sign";
