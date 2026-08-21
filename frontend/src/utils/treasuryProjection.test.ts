// frontend/src/utils/treasuryProjection.test.ts
//
// ==================================================================
//  DESIGN NOTE 682 (harness): ONE ARITHMETIC, TWO DIRECTIONS
// ==================================================================
//
// REPORTED: the "$500 → $433" beside the Buy button was "a little unclear what
// it actually is showing for people who don't know why we put it there".
//
// The presentation fix is in the component. What is under test here is the part
// that was quietly duplicated: a buy and a sale are the same question with the
// sign flipped, and they were two expressions in two places -- one of which had
// a shortfall branch and the other did not. A sale cannot go short, so nothing
// was visibly wrong; the duplication was simply waiting for a third caller.
//
// THE COLOUR RULE IS ASSERTED HERE and not in the component, because it is a
// claim about what the figure MEANS rather than about how it looks. Down is
// amber, not red -- `cashDelta.ts` #670 settled that, and red stays reserved for
// "you cannot do this", which this card already used it for.

import { describeTreasuryProjection, projectTreasury } from "./treasuryProjection";

describe("projectTreasury", () => {
  it("subtracts a purchase", () => {
    const p = projectTreasury(500, -67);
    expect(p.before).toBe(500);
    expect(p.after).toBe(433);
    expect(p.delta).toBe(-67);
    expect(p.short).toBeNull();
    expect(p.direction).toBe("down");
  });

  it("adds a sale", () => {
    const p = projectTreasury(500, 67);
    expect(p.after).toBe(567);
    expect(p.direction).toBe("up");
    expect(p.short).toBeNull();
  });

  it("reports how far short a purchase falls", () => {
    /* The figure a player needs is not "you cannot afford this" but "by how
       much" -- it decides whether selling one share fixes it. */
    const p = projectTreasury(40, -120);
    expect(p.short).toBe(80);
    expect(p.direction).toBe("short");
    expect(p.after).toBe(-80);
  });

  it("does not clamp the negative away", () => {
    // `short` is derived from it, and clamping would leave the block unable to
    // say by how much.
    expect(projectTreasury(0, -10).after).toBe(-10);
  });

  it("treats spending the last dollar as affordable", () => {
    const p = projectTreasury(67, -67);
    expect(p.after).toBe(0);
    expect(p.short).toBeNull();
    expect(p.direction).toBe("down");
  });

  it("calls a zero movement up rather than short", () => {
    /* No caller renders one -- a free action has nothing to project -- but a
       direction of "short" for a player who lost nothing would be the worst
       available answer, so the tie is broken deliberately. */
    expect(projectTreasury(500, 0).direction).toBe("up");
  });

  it("is the same function for both directions", () => {
    /* THE POINT OF THE MODULE. A buy and a sale of the same size are mirror
       images, and nothing in the arithmetic should distinguish them. */
    const bought = projectTreasury(500, -67);
    const sold = projectTreasury(433, 67);
    expect(bought.after).toBe(sold.before);
    expect(sold.after).toBe(bought.before);
  });
});

describe("describeTreasuryProjection", () => {
  it("names the action for a tooltip and a screen reader", () => {
    /* An arrow glyph says nothing to assistive technology, and the block's
       colour says nothing to anyone who cannot see it. */
    expect(describeTreasuryProjection(projectTreasury(500, -67), "purchase")).toBe(
      "$500 now, $433 after this purchase.",
    );
    expect(describeTreasuryProjection(projectTreasury(500, 67), "sale")).toBe(
      "$500 now, $567 after this sale.",
    );
  });

  it("says the shortfall instead, when there is one", () => {
    expect(describeTreasuryProjection(projectTreasury(40, -120), "purchase")).toBe(
      "You hold $40 and this costs $120 — $80 short.",
    );
  });
});
