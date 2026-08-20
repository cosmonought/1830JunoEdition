// Design note #656: the turn cursor is GAME STATE, not React state.
//
// `orSubPhase` was `useState` in `App.tsx`, re-seeded by an effect depending on
// `currentPhase.tier` -- which `derivePhase` reads off the highest train anybody
// owns. So buying the first 3-train moved the tier DURING the buyer's own Buy
// Trains step, the effect re-ran with `active_corporation_index` unmoved, and
// the cursor jumped to `visibleSubPhases[0]`: `Track` or `BuyPrivate` depending
// on whether Buy Private was showing, which is why the same bug landed on step 2
// one playthrough and step 3 the next.
//
// The effect was not wrong about anything it was written to do. What it could
// not express is that opening a turn is an EVENT and not a condition -- and a
// `useEffect` can only watch conditions. This is design note #642 one layer
// down: state split across the reducer and the shell means a replay rebuilds
// every treasury and every train and then shows whichever step an effect seeded.
//
// Nothing here is a new rule; the rules already existed in
// `OperatingSubPhaseStepper.tsx` and inside `skipSubPhase`'s callback. What is
// new is that all of them are reachable from the reducer.
//
// See docs/ai_architecture/state_machine.md, operatingCursor.ts #656.

import {
  initialOrSubPhase,
  visibleSubPhases,
  type OperatingSubPhase,
} from "../components/OperatingSubPhaseStepper";
import { derivePhase } from "./gamePhase";
import type { GameStateResponse } from "./gameState";

export type { OperatingSubPhase };

/** The steps this game currently HAS, in order.
 *
 *  `visibleSubPhases` drops `Buy Private` outside Phases 3 and 4 (design note
 *  #613) and once nothing is left to buy (#385). Asked rather than re-derived, so
 *  the cursor and the strip the player is reading cannot disagree about which
 *  steps exist. */
export function stepsFor(state: GameStateResponse): readonly OperatingSubPhase[] {
  const phase = derivePhase(state);
  return visibleSubPhases(
    state.current_global_era,
    state.private_companies,
    // Design note #613: the phase NUMBER is the rule; the era is the fallback
    // for a game where no corporation has reported a train yet.
    phase?.known ? phase.tier : null,
  );
}

/* Design note #656a: the era field does not move, so do not ask it. Found while
   mutation-testing this chunk -- `current_global_era` NEVER CHANGES in a sandbox
   game (`sandboxSession.ts` contains no `current_global_era:` write; it is
   stamped at seed time), so the mutation that should have failed these tests did
   not. The era test answers "Yellow" in a Phase 4 game, so a turn could never
   open on `BuyPrivate` -- precisely the rule-not-applied #574 removed the
   sandbox shortcut to prevent, arrived at by a second route nobody noticed.

   `derivePhase` is the maintained answer and is already what `stepsFor` asks.
   Two questions about the same phase should not be put to two different fields.

   THE ERA FIELD ITSELF IS STILL WRONG and is a bigger problem than this module:
   `App.tsx` passes it to the map as `currentGlobalEra`, where it governs which
   tile colours may be laid. Flagged rather than fixed here. */
function phaseAwareOpening(state: GameStateResponse): OperatingSubPhase {
  const phase = derivePhase(state);
  /* The same two tiers `visibleSubPhases` gates Buy Private on (design note
     #613): Phase 3 and Phase 4. Phase 5 closes the private companies, so
     there is nothing to open on. */
  if (phase?.known) return phase.tier === "3" || phase.tier === "4" ? "BuyPrivate" : "Track";
  /* No corporation has reported a train yet, so the phase is unknown and the
     era field is the only evidence there is. It is right at this point in a
     game -- a fresh room really is Yellow -- which is why the staleness
     above went unnoticed for so long. */
  return initialOrSubPhase(state.current_global_era);
}

/** Where a corporation's turn opens.
 *
 *  `initialOrSubPhase` answers in the abstract -- `Track` before Phase 3,
 *  `BuyPrivate` from Phase 3 on, mirroring `or_phase::initial_sub_phase`. It can
 *  name a step this game does not have, so the answer is filtered through
 *  `stepsFor`: design note #385, a cursor on a hidden step reads as an empty
 *  action panel with no way forward but Skip. */
export function openingSubPhase(state: GameStateResponse): OperatingSubPhase {
  const steps = stepsFor(state);
  // Design note #656a: the derived phase, not the frozen era field.
  const opening = phaseAwareOpening(state);
  return steps.includes(opening) ? opening : steps[0];
}

/** One step forward, or stay put at the end.
 *
 *  HOLDS RATHER THAN WRAPS. Past the last step the turn is over, and wrapping
 *  would let a corporation lay a second tile. A `current` not in `steps` also
 *  holds -- that happens when the step list shrinks under a cursor sitting on the
 *  step that vanished. `settleSubPhase` resolves it by moving forward rather than
 *  by guessing an index. */
export function nextSubPhase(
  state: GameStateResponse,
  current: OperatingSubPhase,
): OperatingSubPhase {
  const steps = stepsFor(state);
  const at = steps.indexOf(current);
  if (at < 0 || at >= steps.length - 1) return current;
  return steps[at + 1];
}

/** Keeps the cursor on a step that exists.
 *
 *  The one case the old effect handled that a pure event model does not get for
 *  free: `visibleSubPhases` is not fixed for the whole game, and the moment the
 *  last private is bought `BuyPrivate` stops being a step.
 *
 *  Called after every action rather than watched for, which is the whole point of
 *  the move -- it runs when the game changes rather than when React notices.
 *  MOVES FORWARD, never back: the step disappeared because it was completed or
 *  became impossible, and sending the cursor to `steps[0]` is the reported bug. */
export function settleSubPhase(
  state: GameStateResponse,
  current: OperatingSubPhase | null | undefined,
): OperatingSubPhase {
  const steps = stepsFor(state);
  if (current == null) return openingSubPhase(state);
  if (steps.includes(current)) return current;
  /* The cursor named a step this game no longer has. Take the first
     REMAINING step at or after where it stood in the canonical order, so a
     corporation that was on `BuyPrivate` lands on `Track` and one that was
     somehow past the end lands on the last step rather than the first. */
  const canonical = CANONICAL_ORDER.indexOf(current);
  for (const step of steps) {
    if (CANONICAL_ORDER.indexOf(step) >= canonical) return step;
  }
  return steps[steps.length - 1];
}

/** The full sequence, independent of which steps a given game shows. Used
 *  only to compare positions in `settleSubPhase`; `stepsFor` is the list
 *  anything user-facing should ask. */
const CANONICAL_ORDER: readonly OperatingSubPhase[] = [
  "BuyPrivate",
  "Track",
  "Tokens",
  "Routes",
  "Dividends",
  "Hardware",
];
