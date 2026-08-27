// frontend/src/utils/autoSkipExit.ts
//
// What "skip this step" means when there is no next step.
//
// ==================================================================
//  DESIGN NOTE 876: THE SKIP FIRED AND THE CURSOR HAD NOWHERE TO GO
// ==================================================================
//
// ASKED: "When a corporation is at the train limit, I think the game should auto-skip to end their turn
// instead of making them click it."
//
// THE RULE WAS ALREADY WRITTEN AND DID NOTHING. `autoSkipReason` has named this exact case since #249 --
// `orSubPhase === "Hardware" && atTrainLimitNow` returns "it is already at its train limit" -- and the effect
// that reads it dispatches `AdvanceOperatingSubPhase`. But Buy Trains is the LAST step, and `nextSubPhase`
// ends with `if (at < 0 || at >= steps.length - 1) return current;`. So the cursor stays where it is.
//
// THE FAILURE IS SILENT AND SELF-CONCEALING. The effect's guard is keyed on (turn, corporation, step), so it
// fires once, writes "Skipped Buy Trains — it is already at its train limit" to the Activity Log, and never
// runs again. A reader of the log sees the feature working. The player sees a turn that will not end.
//
// AND NEITHER SIDE IS WRONG ON ITS OWN. `nextSubPhase` refusing to walk off the end is correct -- #656's
// "the default is to stay put, and it is the important arm: a phase change is not a turn event". The
// auto-skip asking for an advance is correct for the four steps in the middle. What nobody wrote down is
// that SKIPPING THE LAST STEP IS A DIFFERENT ACT: there is no step to advance to, so the only thing "skip"
// can mean is "this corporation is done".
//
// STATED AS A POSITION IN THE LIST rather than as `=== "Hardware"`. The visible steps are not fixed --
// `stepsFor` drops `BuyPrivate` once the last private is bought, and #613 varies them by phase -- so "the
// last one" is the honest predicate and survives a reordering that a hardcoded name would not.

import type { OperatingSubPhase } from "../components/OperatingSubPhaseStepper";

/** What an automatic skip should dispatch. */
export type AutoSkipExit = "advance" | "end-turn";

/** Whether skipping `step` advances the cursor or ends the corporation's turn.
 *
 *  `"advance"` FOR ANYTHING UNRECOGNISED, deliberately. A step that is not in this game's list is a
 *  disagreement between two parts of the app, and ending somebody's turn on the strength of one is the more
 *  destructive of the two available mistakes -- `AdvanceOperatingSubPhase` on a bad cursor is absorbed by
 *  `settleSubPhase`, which exists for exactly that. */
export function autoSkipExit(
  step: OperatingSubPhase | null,
  steps: readonly OperatingSubPhase[],
): AutoSkipExit {
  if (step === null || steps.length === 0) return "advance";
  return steps.indexOf(step) === steps.length - 1 ? "end-turn" : "advance";
}
