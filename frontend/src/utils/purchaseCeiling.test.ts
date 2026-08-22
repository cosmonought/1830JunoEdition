// frontend/src/utils/purchaseCeiling.test.ts
//
// Design note #700 (harness): WHAT THE PANEL VOLUNTEERS vs WHAT IT ANSWERS.
//
// The reported line was "Buy from bank · Current Train Limit 2 / 4 · Only 2 left in the depot", and the
// complaint was the third clause. What makes this worth a harness rather than a deletion is that the sentence
// is not wrong -- it is REDUNDANT AGAINST OTHER PARTS OF THE SAME PANEL, which is a property no assertion
// about this function alone can see.
//
// So the tests below pin the DISTINCTION instead: the depot's ceiling leaves the caption and stays in the
// tooltip, and the limit's ceiling is in both. If someone later restores the depot sentence to the caption
// because "the tooltip already says it", this fails and points them at #700's actual reason -- #687 and #696
// drew that number twice already.

import { purchaseCeiling, type PurchaseCeilingInput } from "./purchaseCeiling";

function input(over: Partial<PurchaseCeilingInput> = {}): PurchaseCeilingInput {
  return {
    hasTierForSale: true,
    atTrainLimit: false,
    limitHeadroom: 4,
    depotSupply: 4,
    trainLimit: 4,
    limitDropsOnPurchase: false,
    limitAfterPurchase: null,
    ...over,
  };
}

describe("the depot's ceiling is not volunteered", () => {
  it("says nothing in the caption when the depot is what binds", () => {
    /* THE REPORT, as a case. Two left in the depot, room for four under the limit -- the depot binds, and its
       count is already bolded in the row above (#687) and countable as buttons below (#696). */
    expect(purchaseCeiling(input({ depotSupply: 2, limitHeadroom: 4 })).caption).toBeNull();
  });

  it("still answers when asked", () => {
    expect(purchaseCeiling(input({ depotSupply: 2, limitHeadroom: 4 })).reason).toBe(
      "Only 2 left in the depot.",
    );
  });

  it("defers on a tie, where the depot's figure is the one already drawn", () => {
    expect(purchaseCeiling(input({ depotSupply: 2, limitHeadroom: 2 })).caption).toBeNull();
    expect(purchaseCeiling(input({ depotSupply: 2, limitHeadroom: 2 })).reason).toBe(
      "Only 2 left in the depot.",
    );
  });

  it("stays quiet about an untracked supply in both moods", () => {
    // The sentinel, not a depot with ninety-nine trains in it.
    const ceiling = purchaseCeiling(input({ depotSupply: 99, limitHeadroom: 99 }));
    expect(ceiling).toEqual({ caption: null, reason: null });
  });
});

describe("the limit's ceiling is volunteered, because nothing else draws it", () => {
  it("names the room left, which the panel shows only as a subtraction", () => {
    /* The rail reads "2 / 4". "Room for 2" is that minus, performed. #247's original bug lives here: the
       panel showed the depot's number and enforced the limit's. */
    const ceiling = purchaseCeiling(input({ depotSupply: 4, limitHeadroom: 2, trainLimit: 4 }));
    expect(ceiling.caption).toBe("Room for 2 more before the 4-train limit.");
    expect(ceiling.reason).toBe(ceiling.caption);
  });

  it("announces a phase change, which appears nowhere else on the panel", () => {
    const ceiling = purchaseCeiling(
      input({
        depotSupply: 4,
        limitHeadroom: 1,
        limitDropsOnPurchase: true,
        limitAfterPurchase: 3,
      }),
    );
    expect(ceiling.caption).toBe("Room for 1 more — this purchase drops the limit to 3.");
  });

  it("falls back to naming the limit when it cannot say what it becomes", () => {
    // `limitAfterPurchase` null with the flag set would otherwise render "drops the limit to null".
    const ceiling = purchaseCeiling(
      input({ depotSupply: 4, limitHeadroom: 1, limitDropsOnPurchase: true, limitAfterPurchase: null }),
    );
    expect(ceiling.caption).toBe("Room for 1 more before the 4-train limit.");
  });
});

describe("silence where a ceiling would be answering the wrong question", () => {
  it("says nothing when the depot has no purchasable tier", () => {
    expect(purchaseCeiling(input({ hasTierForSale: false }))).toEqual({
      caption: null,
      reason: null,
    });
  });

  it("says nothing when the corporation is already train-locked", () => {
    /* The panel's own blocking message answers this more completely -- and #485 established that it must not
       end by telling the president to do something 1830 does not permit. A ceiling note here would be a
       second, shorter answer competing with it. */
    expect(purchaseCeiling(input({ atTrainLimit: true, limitHeadroom: 0, depotSupply: 3 }))).toEqual({
      caption: null,
      reason: null,
    });
  });

  it("volunteers nothing when neither ceiling is close, though a reason still exists", () => {
    /* The caption is the part that matters here. `reason` is non-null and unreachable: with room for four and
       four in stock no option is disabled, so nothing can be hovered to ask. Left as it is rather than
       special-cased to null -- a tooltip nobody can open costs nothing, and a guard for it would be a branch
       nobody can reach either. */
    expect(purchaseCeiling(input({ depotSupply: 4, limitHeadroom: 4 }))).toEqual({
      caption: null,
      reason: "Only 4 left in the depot.",
    });
  });
});
