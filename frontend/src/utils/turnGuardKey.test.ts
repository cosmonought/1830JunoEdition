// frontend/src/utils/turnGuardKey.test.ts
//
// ==================================================================
//  DESIGN NOTE 653 (harness): THE GUARD HAS TO FORGET
// ==================================================================
//
// The reported symptom was a bricked turn: C&O reached Run Routes with no
// legal route, the auto-skip that exists for that case declined to fire, and
// there is no Skip button on Routes because a corporation that CAN run is
// forbidden to decline. The turn had no exit.
//
// The failing property is small and stateable: a guard that remembers "this
// already happened" must scope the memory to the turn it happened in. These
// tests state it from both directions -- the key must repeat within a turn
// (or the loop guard stops guarding) and must differ across turns (or the
// guard outlives its turn and blocks the next one).

import { operatingTurnKey, turnGuardKey } from "./turnGuardKey";

/** OR 1.1, the second corporation in the operating order. */
const OR_1_1_SECOND = {
  macro_round_number: 1,
  sub_round_index: 1,
  active_corporation_index: 1,
};

describe("operatingTurnKey", () => {
  it("is stable within one turn", () => {
    /* The re-entrancy guard depends on this. `autoSkipReason` stays truthy
       for the render between the skip dispatching and the cursor moving, and
       a key that changed on that render would let the effect fire twice. */
    expect(operatingTurnKey(OR_1_1_SECOND)).toBe(operatingTurnKey({ ...OR_1_1_SECOND }));
  });

  it("changes when the corporation changes", () => {
    expect(operatingTurnKey(OR_1_1_SECOND)).not.toBe(
      operatingTurnKey({ ...OR_1_1_SECOND, active_corporation_index: 2 }),
    );
  });

  it("changes between the two Operating Rounds of one cycle", () => {
    /* OR 2.1 and OR 2.2 are different turns for the same corporation --
       design note #511's `sub_round_index`. Without this component the second
       round of a Green-phase cycle inherits the first round's guards. */
    const or21 = { macro_round_number: 2, sub_round_index: 1, active_corporation_index: 0 };
    const or22 = { macro_round_number: 2, sub_round_index: 2, active_corporation_index: 0 };
    expect(operatingTurnKey(or21)).not.toBe(operatingTurnKey(or22));
  });

  it("changes between macro rounds", () => {
    const first = { macro_round_number: 1, sub_round_index: 1, active_corporation_index: 0 };
    const later = { macro_round_number: 3, sub_round_index: 1, active_corporation_index: 0 };
    expect(operatingTurnKey(first)).not.toBe(operatingTurnKey(later));
  });

  it("tolerates a missing or unloaded state without collapsing turns", () => {
    /* `gameState` is null before the first response resolves. The key must
       still be a string, and must not equal a real turn's -- an unloaded
       game sharing a key with OR 0.0 corporation 0 would pre-arm a guard. */
    expect(typeof operatingTurnKey(null)).toBe("string");
    expect(operatingTurnKey(null)).not.toBe(
      operatingTurnKey({ macro_round_number: 0, sub_round_index: 0, active_corporation_index: 0 }),
    );
  });
});

describe("turnGuardKey", () => {
  it("separates two steps of the same turn", () => {
    /* Skipping Tokens must not consume the guard that Routes needs one step
       later -- both auto-skip, for different reasons (#438 and #414). */
    expect(turnGuardKey(OR_1_1_SECOND, 3, "Tokens")).not.toBe(
      turnGuardKey(OR_1_1_SECOND, 3, "Routes"),
    );
  });

  it("separates two corporations on the same step", () => {
    expect(turnGuardKey(OR_1_1_SECOND, 3, "Routes")).not.toBe(
      turnGuardKey(OR_1_1_SECOND, 5, "Routes"),
    );
  });

  it("re-arms a corporation's Routes skip on its next turn", () => {
    /* THE REPORTED BUG, stated as an assertion. C&O auto-skips Routes in one
       turn; the same skip in a later turn must be a different key or the
       second turn hangs on a step with no exit.

       The old key was `${protocolId}:${step}` and these two expressions were
       equal -- which is the whole defect in one line. */
    const firstTurn = { macro_round_number: 1, sub_round_index: 1, active_corporation_index: 2 };
    const laterTurn = { macro_round_number: 3, sub_round_index: 1, active_corporation_index: 2 };
    expect(turnGuardKey(firstTurn, 3, "Routes")).not.toBe(turnGuardKey(laterTurn, 3, "Routes"));
  });

  it("re-arms the forced withhold on the same schedule", () => {
    /* `forcedWithholdRef` had the identical defect with the key
       `${protocolId}:withhold`, and it matters more: the auto-skip moves a
       cursor, but the withhold is what steps the share price left (#292). A
       corporation that withheld once would silently stop moving. */
    const firstTurn = { macro_round_number: 1, sub_round_index: 1, active_corporation_index: 0 };
    const laterTurn = { macro_round_number: 2, sub_round_index: 1, active_corporation_index: 0 };
    expect(turnGuardKey(firstTurn, 1, "withhold")).not.toBe(
      turnGuardKey(laterTurn, 1, "withhold"),
    );
  });
});
