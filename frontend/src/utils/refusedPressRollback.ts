// frontend/src/utils/refusedPressRollback.ts
//
/* ==================================================================
    PHASE 3 W3-J (AUD-25.05, AUD-25.13 #8): WHAT A REFUSED PRESS TAKES BACK, AS FUNCTIONS OF THE SHELL STATE
   ==================================================================
   W3-C (P3-N020) made a refused lay take back the power key and the JK's arm. The same press set more shell state for
   the move it sent, and a refusal left it standing:
     - the held ghost (#1145): the lay's tile drawn solid on the hex until the board brought it or a 4 s clock ran out
       -- and while it stood, the lay controls read the press as still in flight;
     - the errand (#444 / #845): an errand lay closes the errand and sends the player back to the tab it was armed
       from, so a refused D&H / C&SL lay left the player away from the map with nothing armed (the player re-armed it
       by hand -- W3-C's recorded LOW, ruled FIX IN W3-J).
   Each answer below is applied only when the room said the move was NOT applied (`rollBackIfRefused`); an accepted
   move is never rolled back. Nothing here judges legality. */

import { errandSurvivesStep, type ArmedErrand } from "./privateErrand";

/** The held ghost after a refused lay: dropped when it is the one this lay committed, kept otherwise (a later press's
 *  ghost, or an uncommitted preview the player has opened since, is theirs). */
export function ghostAfterRefusedLay<
  T extends { q: number; r: number; tileId: number; committed?: boolean },
>(current: T | null, sent: { q: number; r: number; tileId: number }): T | null {
  if (current === null || current.committed !== true) return current;
  return current.q === sent.q && current.r === sent.r && current.tileId === sent.tileId ? null : current;
}

/** The errand that stands after a refused errand lay: the one the lay closed, reopened as it was armed -- unless the
 *  player has armed another since, or the step it belongs to has passed. The current errand when the lay closed none. */
export function errandAfterRefusedLay<T extends ArmedErrand>(
  closed: T | null,
  current: T | null,
  step: string | null,
): T | null {
  if (closed === null) return current;
  if (current !== null) return current;
  return errandSurvivesStep(closed, step) ? closed : null;
}

/** The tab after a refused errand lay reopened its errand: back to the map, if the player is still on the tab the lay
 *  sent them to; anywhere else they have gone since is their choice. */
export function tabAfterRefusedErrandLay<Tab extends string>(
  tab: Tab,
  reopened: { returnTab: string } | null,
  map: Tab,
): Tab {
  return reopened !== null && tab === reopened.returnTab ? map : tab;
}
