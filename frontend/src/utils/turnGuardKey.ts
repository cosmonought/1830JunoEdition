// Design note #653: a once-per-game guard on a once-per-turn event.
//
// REPORTED: "C&O has no legal routes despite owning trains, but this Run Routes
// action has no Skip button, so the game is now bricked." The auto-skip for
// exactly that case exists (#414 built it, #433 states the rule); it did not
// fire, and the reason was the loop guard.
//
// `autoSkippedRef` keyed on `${protocolId}:${orSubPhase}` and `forcedWithholdRef`
// on `${protocolId}:withhold`. Neither key says WHEN, and both Sets are cleared
// only by a full sandbox rebuild -- so the first time C&O auto-skips Routes,
// `3:Routes` is remembered for the rest of the game.
//
// WHAT THE GUARD IS FOR is a re-entrancy window a few milliseconds wide:
// `autoSkipReason` is derived, so it stays truthy for the render between
// dispatching the skip and the cursor moving off the step. That is a WITHIN-TURN
// problem, and the key was scoped to the whole game.
//
// In a module rather than inline: a template literal inside a `useEffect` is not
// reviewable and not testable, and "two different turns must not share a key" is
// exactly the kind of property that reads as obviously true and stops being true
// when a field is added or renamed.
//
// See docs/ai_architecture/state_machine.md, turnGuardKey.ts #653.

/** The subset of game state that identifies one corporation's one turn.
 *  Structural rather than importing `GameStateResponse`, so this module has
 *  no dependency on the response vocabulary and the tests can name a turn
 *  with three numbers. */
export interface OperatingTurnIdentity {
  macro_round_number?: number | null;
  sub_round_index?: number | null;
  active_corporation_index?: number | null;
}

/** Names one corporation's one turn.
 *
 *  `macro_round_number` and `sub_round_index` give the Operating Round its "OR
 *  2.1" identity (design note #511), and `active_corporation_index` picks the
 *  corporation within it. All three are read off game state rather than counted
 *  locally: a replay rebuilds state and therefore the same key, where a parallel
 *  local tally could disagree with the log it is supposed to describe -- design
 *  note #642's lesson applied to a guard. */
export function operatingTurnKey(state: OperatingTurnIdentity | null | undefined): string {
  return [
    state?.macro_round_number ?? 0,
    state?.sub_round_index ?? 0,
    state?.active_corporation_index ?? -1,
  ].join(".");
}

/** The full guard key: this turn, this corporation, this step.
 *
 *  The corporation is already implied by `active_corporation_index` and is kept
 *  anyway. The index is a position in `active_operating_order` and the protocol
 *  id is the corporation itself; if a rebuilt queue ever reorders mid-cycle, the
 *  pair disagreeing is preferable to the key silently matching a different
 *  corporation's earlier skip. */
export function turnGuardKey(
  state: OperatingTurnIdentity | null | undefined,
  protocolId: number | string,
  step: string,
): string {
  return `${operatingTurnKey(state)}:${protocolId}:${step}`;
}
