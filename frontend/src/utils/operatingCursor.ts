// frontend/src/utils/operatingCursor.ts
//
/* ==================================================================
 *  DESIGN NOTE 656: THE TURN CURSOR IS GAME STATE
 * ==================================================================
 *
 * REPORTED: "the game stayed in OR 1.1 and returned to C&O's turn, starting
 * at step 3 (Station Tokens). Last time I ended OR 1.1 with a corporation
 * purchasing a 3-train, it looped back to step 2 (Lay Track). It should not
 * be looping at all."
 *
 * WHERE THE CURSOR LIVED. `orSubPhase` was `useState` in `App.tsx`, seeded
 * and re-seeded by an effect whose dependency array named
 * `current_global_era`, `currentPhase.known`, `currentPhase.tier` and
 * `private_companies`. `derivePhase` reads the tier off the highest train
 * anybody owns, so buying the first 3-train moves it from "2" to "3" DURING
 * the Buy Trains step of the corporation that bought it -- and the effect
 * re-ran with `active_corporation_index` unmoved and set the cursor to
 * `visibleSubPhases[0]` -- `Track` when Buy Private is hidden, `BuyPrivate`
 * when it is not, which is why the same bug landed on step 2 in one
 * playthrough and step 3 in the next.
 *
 * `currentPhase.tier`, note, and NOT `current_global_era` -- the obvious
 * suspect, and this note's first answer. Design note #656a below records how
 * that was disproved and the larger bug it turned up instead.
 *
 * The effect was not wrong about anything it was written to do. Its job was
 * "open a new turn on the right step", and every dependency it names is a
 * genuine input to THAT question. What it could not express is that opening a
 * turn is an EVENT and not a condition -- and a `useEffect` can only watch
 * conditions.
 *
 * THIS IS DESIGN NOTE #642 ONE LAYER DOWN. That note found round transitions
 * split between the reducer and the shell, and the diagnosis applies verbatim
 * here: "applying a message was split across two places, so replays run the
 * reducer but not the shell, and corporate state rebuilt exactly while round
 * state did not." Same split, same consequence -- a client that joins or
 * undoes mid-turn rebuilt every treasury and every train and then showed
 * whichever step its own effect happened to seed.
 *
 * SO THE CURSOR MOVES INTO THE LOG, and this module holds the rules it moves
 * by. They were already written down -- `initialOrSubPhase` and
 * `visibleSubPhases` in `OperatingSubPhaseStepper.tsx`, plus the "hold at the
 * last step rather than wrapping, or a corporation lays a second tile" rule
 * that lived inside `skipSubPhase`'s callback. Nothing here is a new rule.
 * What is new is that all of them are reachable from the reducer and none of
 * them is reachable only from a React callback.
 *
 * WHY A SEPARATE MODULE rather than inlining into `sandboxSession.ts`: the
 * reducer is already the largest file in `utils/`, and these rules have
 * exactly one input each and no dependence on the reducer's vocabulary. They
 * are also the rules most likely to be read by someone asking "why did the
 * turn open there", and a question that specific deserves a file it can be
 * answered in.
 */

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
 *  #613) and once nothing is left to buy (#385). Asked rather than
 *  re-derived, so the cursor and the strip the player is reading cannot
 *  disagree about which steps exist -- the same reason design note #385 gave
 *  when the App asked it. */
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

/* ==================================================================
 *  DESIGN NOTE 656a: THE ERA FIELD DOES NOT MOVE, SO DO NOT ASK IT
 * ==================================================================
 *
 * Found while mutation-testing this chunk. `openingSubPhase` first read
 * `initialOrSubPhase(state.current_global_era)` -- the same expression the
 * App's effect used -- and the mutation that should have failed these tests
 * did not, because `current_global_era` NEVER CHANGES in a sandbox game.
 * `sandboxSession.ts` does not contain a single `current_global_era:` write;
 * the field is stamped at seed time and holds that value for the whole game.
 *
 * So the era test answers "Yellow" in a Phase 4 game, `initialOrSubPhase`
 * answers `Track`, and a turn could never open on `BuyPrivate` -- which is
 * precisely the rule-not-applied that design note #574 removed the sandbox
 * shortcut to prevent. The shortcut went; the outcome stayed, because a
 * second route to it was never noticed. "A step the game silently walks past
 * is a trade nobody gets to make", in that note's own words.
 *
 * `derivePhase` is the maintained answer. It reads the highest train tier
 * anybody owns, which is what actually advances a phase, and it is already
 * what `stepsFor` above asks. Two questions about the same phase should not
 * be put to two different fields.
 *
 * THE ERA FIELD ITSELF IS STILL WRONG and is a bigger problem than this
 * module: `App.tsx` passes it to the map as `currentGlobalEra`, where it
 * governs which tile colours may be laid. That is not a cursor question, so
 * it is flagged rather than fixed here. */
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
 *  `BuyPrivate` from Phase 3 on, mirroring `or_phase::initial_sub_phase`. It
 *  can name a step this particular game does not have, so the answer is
 *  filtered through `stepsFor` before it is used. Design note #385 made that
 *  point about seeding: a cursor on a hidden step reads as an empty action
 *  panel with no way forward but Skip. */
export function openingSubPhase(state: GameStateResponse): OperatingSubPhase {
  const steps = stepsFor(state);
  // Design note #656a: the derived phase, not the frozen era field.
  const opening = phaseAwareOpening(state);
  return steps.includes(opening) ? opening : steps[0];
}

/** One step forward, or stay put at the end.
 *
 *  HOLDS RATHER THAN WRAPS. Past the last step the turn is over, and wrapping
 *  to the front would let a corporation lay a second tile. That rule was
 *  written inside `skipSubPhase` in `App.tsx`; it belongs with the cursor.
 *
 *  A `current` that is not in `steps` also holds. That happens when the step
 *  list shrinks under a cursor sitting on the step that vanished -- the last
 *  private is bought while a corporation is on `BuyPrivate`. Holding is the
 *  conservative answer: `settleSubPhase` below is what resolves it, and it
 *  resolves it by moving forward rather than by guessing an index. */
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
 *  The one case the old effect handled that a pure event model does not get
 *  for free. `visibleSubPhases` is not fixed for the whole game: the moment
 *  the last private company is bought, `BuyPrivate` stops being a step -- and
 *  if a corporation is standing on it, its cursor now names nothing.
 *
 *  Called after every action rather than watched for, which is the whole
 *  point of the move: it runs when the game changes rather than when React
 *  notices the game changed, so a replay produces it too.
 *
 *  MOVES FORWARD, never back. The step disappeared because it was completed
 *  or became impossible; either way the turn has advanced past it, and
 *  sending the cursor to `steps[0]` is precisely the reported bug. */
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
