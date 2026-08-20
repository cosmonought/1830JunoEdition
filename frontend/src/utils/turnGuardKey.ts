// frontend/src/utils/turnGuardKey.ts
//
/* ==================================================================
 *  DESIGN NOTE 653: A ONCE-PER-GAME GUARD ON A ONCE-PER-TURN EVENT
 * ==================================================================
 *
 * REPORTED: "C&O has no legal routes despite owning trains, but this Run
 * Routes action has no Skip button, so the game is now bricked."
 *
 * There IS an auto-skip for exactly that case -- design note #414 built it
 * and #433 states the rule it implements: no route, no obligation. It did
 * not fire, and the reason was the loop guard rather than the skip.
 *
 * `autoSkippedRef` keyed on `${actingProtocolId}:${orSubPhase}` and
 * `forcedWithholdRef` on `${actingProtocolId}:withhold`. Neither key says
 * WHEN. Both Sets are cleared only by a full sandbox rebuild, so the first
 * time C&O auto-skips Routes the pair `3:Routes` is remembered for the rest
 * of the game -- and every later turn where C&O again has no route reaches a
 * step that will not skip itself and offers no button that would.
 *
 * WHAT THE GUARD IS FOR is a re-entrancy window a few milliseconds wide:
 * `autoSkipReason` is derived, so it stays truthy for the render between
 * dispatching the skip and the cursor moving off the step, and without a
 * guard the effect fires again on that render. That is a WITHIN-TURN
 * problem, and the key was scoped to the whole game.
 *
 * SO THE KEY GAINS THE TURN, and it lives here rather than inline in an
 * effect. A template literal inside a `useEffect` is not reviewable and not
 * testable, and the property that matters -- two different turns must not
 * share a key -- is exactly the kind of thing that reads as obviously true
 * and stops being true when a field is added or renamed.
 */

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
 *  `macro_round_number` and `sub_round_index` together give the Operating
 *  Round its "OR 2.1" identity (design note #511), and
 *  `active_corporation_index` picks the corporation within it. All three are
 *  read off game state rather than counted locally: a replay rebuilds state
 *  and therefore rebuilds the same key, where a parallel local tally could
 *  disagree with the log it is supposed to describe. That is design note
 *  #642's lesson applied to a guard rather than to the round machine. */
export function operatingTurnKey(state: OperatingTurnIdentity | null | undefined): string {
  return [
    state?.macro_round_number ?? 0,
    state?.sub_round_index ?? 0,
    state?.active_corporation_index ?? -1,
  ].join(".");
}

/** The full guard key: this turn, this corporation, this step.
 *
 *  The corporation is already implied by `active_corporation_index`, and is
 *  kept anyway. The index is a position in `active_operating_order` and the
 *  protocol id is the corporation itself; if a rebuilt queue ever reorders
 *  mid-cycle, the pair disagreeing is preferable to the key silently
 *  matching a different corporation's earlier skip. */
export function turnGuardKey(
  state: OperatingTurnIdentity | null | undefined,
  protocolId: number | string,
  step: string,
): string {
  return `${operatingTurnKey(state)}:${protocolId}:${step}`;
}
