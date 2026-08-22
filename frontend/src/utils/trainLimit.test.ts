// frontend/src/utils/trainLimit.test.ts
//
// ==================================================================
//  DESIGN NOTE 703 (harness): TWO RULES THAT LOOK LIKE ONE
// ==================================================================
//
// REPORTED: "NNH owns three trains, the next available train to purchase is a 4-train, and there is a red text
// that says: 'Buying a 4-train would start the next phase and cut the limit to 3, and NNH already holds 3.'
// This misunderstands the rule: corporations are not prohibited from buying a train if doing so triggers a
// phase change that lowers the train limit, provided the corporation was legally under the old limit before
// the purchase. (a) you may have confused this with a related rule: a player cannot purchase a train that
// exceeds the train limit even if doing so would rust their current trains to bring them under the limit."
//
// The diagnosis in (a) is exactly right, and it is why this file tests BOTH rules rather than only the one
// that was wrong. They are the same principle -- the limit is read at the instant of purchase, against what
// the corporation holds and what the phase allows RIGHT NOW -- and they differ only in which direction the
// mistake runs:
//
//   rusting does not create headroom in ADVANCE   -> blocked, and was correctly blocked
//   a phase shift does not remove headroom in ARREARS -> allowed, and was wrongly blocked
//
// Test one alone and the fix looks like "stop blocking", which invites the opposite regression next time.
// Together they pin the instant, which is the actual rule.
//
// The reported case is `it("lets a corporation buy the train that starts the next phase")` below -- NNH at 3
// with a current limit of 4 and a 4-train in the depot.

import { buyableNow, isTrainLocked, type TrainLimitInput } from "./trainLimit";

function situation(over: Partial<TrainLimitInput> = {}): TrainLimitInput {
  // Phase 3: limit 4, and the depot's cheapest tier is another 3-train, so nothing advances.
  return {
    owned: 2,
    currentLimit: 4,
    depotSupply: 4,
    advancesPhase: false,
    limitAfterPurchase: 4,
    ...over,
  };
}

describe("a phase shift does not remove headroom in arrears", () => {
  it("lets a corporation buy the train that starts the next phase", () => {
    /* THE REPORT. NNH holds 3, the phase in force allows 4, and the depot's cheapest tier is the 4-train that
       will cut the limit to 3. The purchase is legal: NNH was under the old limit when it made it. */
    expect(
      buyableNow(
        situation({ owned: 3, currentLimit: 4, advancesPhase: true, limitAfterPurchase: 3 }),
      ),
    ).toBe(1);
  });

  it("would have refused it under the old rule", () => {
    /* The counterfactual, so the assertion above is not merely a restatement of the code. #296 enforced
       against `nextTier.trainLimit` -- the limit the purchase BRINGS -- which for this case is 3, and NNH
       already held 3. Zero headroom, and a red sentence explaining a rule 1830 does not have. */
    const underTheOldRule = Math.max(0, 3 /* limitAfterPurchase */ - 3 /* owned */);
    expect(underTheOldRule).toBe(0);
  });

  it("caps the SECOND buy, which is where the old worry was actually true", () => {
    /* Buying two 4-trains at once is two purchases. The first is legal and starts the phase; the second is
       judged by the new limit of 3 against holdings of 4, and is not. So the answer is a cap of one, never a
       block of zero -- which is the distinction #296 collapsed. */
    expect(
      buyableNow(
        situation({ owned: 3, currentLimit: 4, advancesPhase: true, limitAfterPurchase: 3 }),
      ),
    ).toBe(1);
  });

  it("still allows two when the new limit leaves room for both", () => {
    // A corporation holding one, buying into a phase that allows three: both purchases are legal.
    expect(
      buyableNow(
        situation({ owned: 1, currentLimit: 4, advancesPhase: true, limitAfterPurchase: 3 }),
      ),
    ).toBe(2);
  });

  it("does not move the ceiling for tiers that do not advance the phase", () => {
    /* The phase turns on the FIRST purchase of a tier. Once some 4-trains have sold, the current limit already
       IS the 4-train's, `advancesPhase` is false, and the walk is a plain subtraction again. */
    expect(buyableNow(situation({ owned: 1, currentLimit: 3, advancesPhase: false }))).toBe(2);
  });
});

describe("rusting does not create headroom in advance", () => {
  it("refuses a purchase by a corporation already at the limit", () => {
    /* THE RULE THE REPORT NAMES IN (a), and the one that was always right. A corporation at 4 of 4 may not buy
       the 4-train that would rust its 2-train -- the limit is tested before the purchase resolves, so the
       rusting has not happened yet. */
    expect(
      buyableNow(
        situation({ owned: 4, currentLimit: 4, advancesPhase: true, limitAfterPurchase: 3 }),
      ),
    ).toBe(0);
  });

  it("refuses it whether or not the purchase would advance the phase", () => {
    // The lock is about holdings, not about consequences.
    expect(buyableNow(situation({ owned: 4, currentLimit: 4, advancesPhase: false }))).toBe(0);
  });

  it("names the lock at exactly the limit, not past it", () => {
    expect(isTrainLocked(3, 4)).toBe(false);
    expect(isTrainLocked(4, 4)).toBe(true);
    /* OVER the limit is locked too. A corporation left there by a phase change has no room either -- 1830
       requires it to discard down, which nothing in this codebase does yet, but it certainly may not buy. */
    expect(isTrainLocked(5, 4)).toBe(true);
  });

  it("says nothing when the phase is unknown", () => {
    // A limit we cannot read is not a limit of zero. Guessing would take a legal purchase away.
    expect(isTrainLocked(9, null)).toBe(false);
    expect(buyableNow(situation({ owned: 9, currentLimit: null, depotSupply: 2 }))).toBe(2);
  });
});

describe("the depot is still the other ceiling", () => {
  it("never offers more than the depot holds", () => {
    expect(buyableNow(situation({ owned: 0, currentLimit: 4, depotSupply: 2 }))).toBe(2);
  });

  it("returns zero for an empty depot", () => {
    expect(buyableNow(situation({ owned: 0, depotSupply: 0 }))).toBe(0);
  });

  it("takes whichever ceiling binds first", () => {
    expect(buyableNow(situation({ owned: 3, currentLimit: 4, depotSupply: 4 }))).toBe(1);
    expect(buyableNow(situation({ owned: 0, currentLimit: 4, depotSupply: 3 }))).toBe(3);
  });
});
