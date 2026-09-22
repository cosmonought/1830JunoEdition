// frontend/src/utils/bankBreakEndgame.ts
//
// How much game is left once the Bank has broken -- VF-6 (VISUAL_FLOURISH_BACKLOG.md).
//
/* ==================================================================
    DESIGN NOTE (VF-6): THE COUNT IS READ OFF THE CALENDAR, NEVER COUNTED DOWN
   ==================================================================
   THE RULE IS NOT RESTATED HERE, and that is the whole design of this file. #898 owns when the game ends
   ("the game ends when the first OR SET COMPLETES at or after the break") and #1561 owns what "broken"
   means (the latch, not the balance). This asks those two authorities a PRESENTATION question -- how many
   Operating Rounds the table has left to play -- and it answers it by reading the same three fields the
   reducer's own round machine reads.

   NO SECOND ENDGAME CLOCK. There is no stored "ORs remaining", no decrement on a round boundary, no
   `bank_broke_at`, and no inference from the phase number. #898's note is explicit that nothing needs to
   record WHEN the bank broke, and the same collapse works here: the number of rounds left is a property of
   where the calendar is standing right now, so a rebuilt, undone or remotely-driven state produces the
   right number without anything having watched it happen.

   TWO CASES, TWO DIFFERENT LENGTHS, AND THAT DISTINCTION IS THE ONE THING WORTH GETTING RIGHT HERE.

   CASE A -- the break happens during an Operating Round. The set in progress finishes, so what is left is
   the round being played plus every later round of THIS set: `L - i + 1`, where `i` is `sub_round_index`
   and `L` is the set's LOCKED length. Locked, via `operatingRoundSequenceLength`, because #511 stamps the
   length once when a set opens precisely so "a 3-train bought mid-cycle must not turn a one-round Yellow
   cycle into a two-round Green one" -- and a badge that re-derived the length from the live phase would
   announce exactly that phantom extra round.

   CASE B -- the break happens during a Stock Round (or the delayed auction that can occupy that slot,
   #905). The whole UPCOMING set is still to play, and its length is NOT the locked value on the state:
   that value belongs to the set that has already finished. `beginOperatingRound` stamps the new set's
   length as `operatingRoundsForPhase(derivePhase(state))` with `continuingSequence` false, so that same
   expression is what the coming set will be -- asked here one transition early rather than guessed at. The
   phase cannot move in between, because only a train purchase moves it and no train is bought in a Stock
   Round.

   NEVER ZERO, AND THAT IS A `null` RATHER THAN A `0`. At the boundary where the count would reach zero the
   reducer has already produced `GameEnd` (#898), and the outro owns the screen from there. A badge reading
   "0 ORs remaining" would be a countdown outliving the thing it was counting. */

import { bankIsBroken } from "../gameEngine/endgame";
import { derivePhase } from "../gameEngine/gamePhase";
import type { GameStateResponse } from "../gameEngine/gameState";
import {
  operatingRoundSequenceLength,
  operatingRoundsForPhase,
} from "../gameEngine/sandboxSession";

export interface BankBrokenStatus {
  /** Operating Rounds still to be played, counting the one in progress. Always at least 1. */
  orsRemaining: number;
}

/** How much game is left, or `null` when the Bank has not broken, the game has already ended, or there is
 *  no state to ask. PRESENTATION ONLY: nothing here decides whether the game ends, only how to describe a
 *  decision the reducer has already taken. */
export function bankBrokenStatus(state: GameStateResponse | null | undefined): BankBrokenStatus | null {
  if (!state) return null;
  /* THE LATCH, THROUGH ITS OWN FUNCTION. #1561: "adding a second notion of 'broken' for the badge is how
     the two would come to disagree." A balance that later climbs back above zero does not reach this line,
     because `bankIsBroken` answers the latch first. */
  if (!bankIsBroken(state)) return null;
  // The ending has landed; the outro owns the screen. #898 produces this at the set boundary.
  if (state.current_round_type === "GameEnd") return null;

  const orsRemaining =
    state.current_round_type === "OperatingRound"
      ? remainingInThisSet(state)
      : // CASE B: the whole set that has not started yet.
        Math.max(1, operatingRoundsForPhase(derivePhase(state)));

  return orsRemaining >= 1 ? { orsRemaining } : null;
}

/** CASE A: the round in progress plus the rest of its locked set. */
function remainingInThisSet(state: GameStateResponse): number {
  const length = Math.max(1, operatingRoundSequenceLength(state));
  const raw = Number(state.sub_round_index);
  /* CLAMPED AT BOTH ENDS rather than trusted. #621 zeroes `sub_round_index` when a set closes, and while
     that state is never an OPERATING round it costs nothing to refuse to read a 0 as "one before the
     first" and report a round that does not exist. The upper clamp is the same refusal from the other
     side: an index past the locked length would otherwise produce a negative count. */
  const index = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), length) : 1;
  return length - index + 1;
}
