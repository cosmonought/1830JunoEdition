// Design note #659: which round a log entry belongs to.
//
// REPORTED: the last action of OR 1.1 was labelled "[SR2] PRR passed Buy
// Trains." Moved out of `App.tsx` to be tested -- the function was never wrong,
// what was wrong is which STATE it was asked about, and that is a distinction a
// 10,000-line component cannot hold a test for.
//
// THE RULE: an ACTION is tagged with the round it was taken in (`before`); an
// ANNOUNCEMENT is tagged with the round it announces (`after`). Every
// round-closing action makes those two different, and it is the only time they
// differ.
//
// Design note #643 had already been here once, correctly replacing a ref read
// with `roundLabelFor(after)` -- and then taking the wrong end of the action.
// `after` is the state the action RESOLVED TO, which for every action but one is
// the same round it happened in, so the fix looked complete and was 99% right.
//
// See docs/ai_architecture/state_machine.md, roundLabel.ts #659.

import type { GameStateResponse } from "./gameState";
import { OPERATING_SUB_PHASE_LABELS } from "../components/OperatingSubPhaseStepper";

/** The short round tag the activity log and the ticker stamp on an entry:
 *  `Auction`, `SR2`, `OR 3.1`. The Operating Round's suffix is dropped when
 *  `sub_round_index` is 0, which is the state between rounds -- design note #621
 *  zeroes it on close and `beginOperatingRound` stamps it back to 1. */
export function roundLabelFor(state: GameStateResponse | null | undefined): string | null {
  if (!state) return null;
  if (state.current_round_type === "WaterfallAuction") return "Auction";
  if (state.current_round_type === "StockRound") return `SR${state.macro_round_number}`;
  const suffix = state.sub_round_index > 0 ? `.${state.sub_round_index}` : "";
  return `OR ${state.macro_round_number}${suffix}`;
}

/** The Activity Log's stamp: the round tag, plus the Operating Round's step.
 *
 *  ==================================================================
 *   DESIGN NOTE 958: THE TAG CARRIES THE STEP, SO THE SENTENCE NEED NOT
 *  ==================================================================
 *
 *  REPORTED: "During operating rounds, I think it might be better to have [time] [round--subphase], so that
 *  it's more easily scannable for particular events. So instead of, e.g., `[3:06 PM] [OR 2.1] NNH passed Buy
 *  Trains.` it would read `[3:06 PM] [OR 2.1--Buy Trains] NNH passed.`"
 *
 *  AND IT MOVES THE FACT INTO THE COLUMN, which is what makes it scannable. The step was already in the log --
 *  buried mid-sentence, in a different place on every line, so finding "when did anyone buy trains" meant
 *  reading rather than scanning. In the tag it lands in one column down the whole feed.
 *
 *  SEPARATE FROM `roundLabelFor` RATHER THAN REPLACING IT. That function also writes the ROUND-TRANSITION
 *  announcements -- "The next Stock Round begins" -- and a step name in those would be meaningless: the
 *  announcement is about a round starting, at which point no corporation is on any step. Two callers, two
 *  questions, and only one of them wants the suffix.
 *
 *  `--` AS SPECIFIED. An en dash would typeset better and is not what was asked for; more to the point, the
 *  tag is a scanning target rather than prose, and a double hyphen is unambiguous at a glance in a monospaced
 *  column where an en dash and a hyphen are one pixel apart.
 *
 *  SILENT OUTSIDE AN OPERATING ROUND, and silent within one when the cursor is between steps -- a Stock Round
 *  has no sub-phase and inventing one would be the log claiming structure the round does not have. */
export function roundStampFor(state: GameStateResponse | null | undefined): string | null {
  const round = roundLabelFor(state);
  if (round === null) return null;
  if (state?.current_round_type !== "OperatingRound") return round;
  const step = state.operating_sub_phase;
  if (!step) return round;
  const label = OPERATING_SUB_PHASE_LABELS[step];
  /* ==================================================================
      DESIGN NOTE 1071: AN EM DASH, REPLACING THE DOUBLE HYPHEN
     ==================================================================
     REPORTED: "we currently have, e.g., OR 1.1--Dividends. Please replace '--' with an em dash, or maybe a
     colon?"
     #958 CHOSE `--` AND GAVE TWO REASONS, and only one of them has survived. The first was "as specified",
     which this supersedes. The second was typographic: "the tag is a scanning target rather than prose, and a
     double hyphen is unambiguous at a glance in a monospaced column where an en dash and a hyphen are one
     pixel apart." That argument was about an EN dash. An em dash is twice the width of a hyphen and half
     again the width of an en, so it is not the character that argument was about -- it reads as a separator
     at a glance, which is what the tag needs. */
  return label ? `${round}\u2014${label.stepLabel}` : round;
}
