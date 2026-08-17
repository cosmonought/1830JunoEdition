// frontend/src/utils/dividendStep.test.ts
//
// ==================================================================
//  DESIGN NOTE 486 (harness): NOTHING TO DECLARE IS STILL A DECLARATION
// ==================================================================
//
// Two faults are pinned here and they pull in opposite directions, which is
// why the "skipped Routes" case gets so many tests:
//
//   THE STALE FIGURE. `last_route_revenue` is the corporation's LAST run.
//   For one that skipped Routes this turn that is a previous turn's number,
//   and the forced $0 withhold was dispatching it -- moving real money into
//   a treasury for a run that did not happen.
//
//   THE MISSING CONTROL. The same "skipped Routes" observation was being
//   used to keep the Skip button ALIVE, so the one corporation guaranteed
//   to have nothing to declare was the one offered a way to step past the
//   declaration -- and stepping past it omits the mandatory move of the
//   share price one cell left.
//
// So the same input has to produce $0 AND a forced withhold. A fix for
// either fault alone still leaves a wrong screen, and a test for either
// alone would pass against it.

import { dividendDeclaration, marketMoveDirection } from "./dividendStep";

describe("a corporation that ran this turn", () => {
  it("declares what it earned", () => {
    const d = dividendDeclaration({ lastRouteRevenue: "180", skippedRoutes: false });
    expect(d.revenue).toBe(180);
    expect(d.mayPay).toBe(true);
    expect(d.mustWithhold).toBe(false);
  });

  it("splits ten ways, floored", () => {
    // 1830 pays whole units, and rounding up would have the corporation pay
    // out more than it earned.
    expect(dividendDeclaration({ lastRouteRevenue: 180, skippedRoutes: false }).perShare).toBe(18);
    expect(dividendDeclaration({ lastRouteRevenue: 185, skippedRoutes: false }).perShare).toBe(18);
    expect(dividendDeclaration({ lastRouteRevenue: 9, skippedRoutes: false }).perShare).toBe(0);
  });

  it("reads a Uint128 string as readily as a number", () => {
    // The chain serialises `Uint128` as a string; a hand-built fixture uses
    // a number. Both reach this function.
    expect(dividendDeclaration({ lastRouteRevenue: "90", skippedRoutes: false }).revenue).toBe(90);
    expect(dividendDeclaration({ lastRouteRevenue: 90, skippedRoutes: false }).revenue).toBe(90);
  });
});

describe("a corporation that skipped Routes", () => {
  const skipped = dividendDeclaration({ lastRouteRevenue: "180", skippedRoutes: true });

  it("declares ZERO, not last turn's figure", () => {
    // The money bug. $180 is a real number sitting on the corporation and
    // it belongs to a turn that is over.
    expect(skipped.revenue).toBe(0);
    expect(skipped.perShare).toBe(0);
  });

  it("cannot pay", () => {
    expect(skipped.mayPay).toBe(false);
  });

  it("must withhold", () => {
    // The half that removes the Skip button. Both faults, one input.
    expect(skipped.mustWithhold).toBe(true);
  });
});

describe("a corporation that earned nothing", () => {
  it("must withhold rather than choose", () => {
    // 1830 has no $0 dividend. Paying nothing and withholding nothing move
    // the same zero, but only one of them steps the share price left.
    for (const revenue of [0, "0", null, undefined]) {
      const d = dividendDeclaration({ lastRouteRevenue: revenue, skippedRoutes: false });
      expect(d.revenue).toBe(0);
      expect(d.mayPay).toBe(false);
      expect(d.mustWithhold).toBe(true);
    }
  });
});

describe("the exits are exhaustive", () => {
  it("always offers exactly one of pay-or-withhold and forced-withhold", () => {
    /* The property that matters more than any single value: whatever the
       inputs, the step has a legal control on it. A combination that made
       both false would strand a corporation on Dividends with Skip removed
       and nothing to click -- which is the failure mode the Skip button was
       masking. */
    for (const revenue of [0, 1, 9, 180, "0", "180", "", null, undefined, "not a number"]) {
      for (const skippedRoutes of [true, false]) {
        const d = dividendDeclaration({ lastRouteRevenue: revenue, skippedRoutes });
        expect(d.mayPay || d.mustWithhold).toBe(true);
        expect(d.mayPay && d.mustWithhold).toBe(false);
      }
    }
  });

  it("never produces a NaN to print on a button", () => {
    // `Number("not a number")` is NaN, and a NaN revenue would make both
    // flags false -- the stranded step above, arrived at through a label
    // reading "Withhold $NaN".
    const d = dividendDeclaration({ lastRouteRevenue: "not a number", skippedRoutes: false });
    expect(Number.isNaN(d.revenue)).toBe(false);
    expect(d.revenue).toBe(0);
    expect(d.mustWithhold).toBe(true);
  });

  it("never produces a negative payout", () => {
    // A negative `last_route_revenue` is not a thing the chain should send,
    // and "pay out minus $50 a share" is not a thing to render if it does.
    const d = dividendDeclaration({ lastRouteRevenue: -500, skippedRoutes: false });
    expect(d.revenue).toBe(0);
    expect(d.perShare).toBe(0);
    expect(d.mustWithhold).toBe(true);
  });
});

/* ==================================================================
 *  DESIGN NOTE 492 (harness): THREE TRAINS, ONE FIELD
 * ==================================================================
 *
 * `RunManualRoute` declares ONE train, so a three-train corporation sends
 * three messages and each writes `last_route_revenue`. The field ends the
 * turn holding the third train's figure, and Dividends spent that -- which
 * presents to a player as "auto-route only did one train", because the
 * planner panel showed the correct multi-train plan right before it.
 *
 * The committed total is therefore carried alongside. The tests that matter
 * are the PRECEDENCE ones: a committed figure must beat the field even when
 * the field is larger, smaller, stale, or zero.
 */
describe("the committed multi-train total", () => {
  it("beats the single-train field", () => {
    // Three trains earning 180 + 120 + 90; the field kept only the last.
    const d = dividendDeclaration({
      lastRouteRevenue: 90,
      skippedRoutes: false,
      committedRevenue: 390,
    });
    expect(d.revenue).toBe(390);
    expect(d.perShare).toBe(39);
    expect(d.mayPay).toBe(true);
  });

  it("beats the field even when the field is LARGER", () => {
    /* A stale field from a richer previous turn must not win merely by being
       bigger. The commitment is an observation of THIS turn; the field is a
       memory of whenever it was last written. */
    const d = dividendDeclaration({
      lastRouteRevenue: 500,
      skippedRoutes: false,
      committedRevenue: 120,
    });
    expect(d.revenue).toBe(120);
  });

  it("treats a committed ZERO as a real answer, not as absent", () => {
    /* Every drafted route was invalid, so nothing ran. Falling through to a
       stale positive field here would declare money for a run that did not
       happen -- the exact fault design note #484c fixed for skipped turns,
       arriving by a different door. */
    const d = dividendDeclaration({
      lastRouteRevenue: 250,
      skippedRoutes: false,
      committedRevenue: 0,
    });
    expect(d.revenue).toBe(0);
    expect(d.mustWithhold).toBe(true);
  });

  it("outranks a skipped-Routes inference", () => {
    /* `skippedRoutes` is an inference; a commitment is direct evidence the
       corporation ran. If the two disagree the evidence wins, or a player
       who ran three trains could be force-withheld to $0. */
    const d = dividendDeclaration({
      lastRouteRevenue: 0,
      skippedRoutes: true,
      committedRevenue: 300,
    });
    expect(d.revenue).toBe(300);
    expect(d.mayPay).toBe(true);
  });

  it("falls back to the field when nothing was observed", () => {
    // A page reloaded mid-turn has no local record. One train's revenue is a
    // better answer there than none.
    for (const absent of [undefined, null]) {
      const d = dividendDeclaration({
        lastRouteRevenue: 180,
        skippedRoutes: false,
        committedRevenue: absent,
      });
      expect(d.revenue).toBe(180);
    }
  });

  it("ignores a NaN commitment rather than declaring one", () => {
    const d = dividendDeclaration({
      lastRouteRevenue: 180,
      skippedRoutes: false,
      committedRevenue: Number.NaN,
    });
    expect(d.revenue).toBe(180);
  });

  it("never declares a negative commitment", () => {
    const d = dividendDeclaration({
      lastRouteRevenue: 180,
      skippedRoutes: false,
      committedRevenue: -40,
    });
    expect(d.revenue).toBe(0);
    expect(d.perShare).toBe(0);
  });
});

/* ==================================================================
 *  DESIGN NOTE 489a (harness): THE CEILING IS NOT A GAIN
 * ==================================================================
 *
 * The Market Move line coloured itself from `direction === "pay"` -- the
 * TRAVEL of the token on the chart -- rather than from the two prices it was
 * printing. Those agree everywhere except the end of a row, which is exactly
 * where the line is most likely to be misread: the token cannot advance, the
 * projected price equals the current one, and a green rising arrow appeared
 * between two identical numbers.
 *
 * The flat cases below are the whole point of this block. Rise and fall
 * passed against the old code too.
 */
describe("which way the market move went", () => {
  it("reads a higher projected price as a rise", () => {
    expect(marketMoveDirection(76, 82)).toBe("rise");
  });

  it("reads a lower projected price as a fall", () => {
    expect(marketMoveDirection(82, 76)).toBe("fall");
  });

  it("reads an unchanged price as FLAT, not as a rise", () => {
    /* THE BUG. A corporation paying out at the right-hand end of its row
       projects to its own price. The old rule said "paying out, therefore
       rising" and painted it green. */
    expect(marketMoveDirection(100, 100)).toBe("flat");
  });

  it("reads a blocked withhold as flat too", () => {
    // The same case mirrored: withholding at the left edge of a row.
    expect(marketMoveDirection(10, 10)).toBe("flat");
  });

  it("does not colour a price it does not have", () => {
    /* An unfloated corporation has no chart position. The caller renders
       "not on the market chart" instead of a comparison -- but the neutral
       answer here means a stray render cannot assert a gain from nothing. */
    expect(marketMoveDirection(null, 82)).toBe("flat");
    expect(marketMoveDirection(76, null)).toBe("flat");
    expect(marketMoveDirection(null, null)).toBe("flat");
    expect(marketMoveDirection(undefined, undefined)).toBe("flat");
  });

  it("does not colour a NaN", () => {
    // `NaN > x` and `NaN < x` are both false, so a naive comparison would
    // already land on flat -- asserted so it stays that way by decision
    // rather than by accident.
    expect(marketMoveDirection(Number.NaN, 82)).toBe("flat");
    expect(marketMoveDirection(76, Number.NaN)).toBe("flat");
  });

  it("ignores the grid direction entirely", () => {
    /* The requirement, stated as a property: the function has no parameter
       for whether this was a pay or a withhold, so it CANNOT reproduce the
       old fault. If a `direction` argument is ever added back, this test is
       the thing that should have to be edited first. */
    expect(marketMoveDirection.length).toBe(2);
  });
});
