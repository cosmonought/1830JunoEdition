/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 995-997 (harness): AN ASYMMETRY, A STALE BLURB, AND A SENTENCE NOBODY RENDERED
// ==================================================================
//
// THE THREE ITEMS HERE FAIL IN THREE DIFFERENT WAYS, and the cases are shaped for that.
//
//   #995's ASYMMETRY is arithmetic and is driven directly -- but the property worth pinning is not either
//   threshold on its own, it is the GAP. A case asserting "withhold at 2x" and a case asserting "pay at 3x"
//   both pass against a build that has quietly unified them at 2x, because each only sees its own arm. So the
//   comparisons below are made at the one figure where the arms disagree.
//
//   #996's LOBBY BLURB is copy describing a rule that lives in a reducer, which #982 already established this
//   file cannot fully check. What it CAN do is read the numbers out of the sentence and compare them with the
//   constants -- which is the strongest join available short of generating the copy.
//
//   #997 IS A WIRING FIX AND NOTHING ELSE. `dividendStepsExplanation` has been correct and unrendered since
//   #908, with a passing suite the whole time: the arithmetic was tested, the copy was tested, and nobody
//   asserted that anything displayed it. Source scans, because "this element is on screen" is not observable
//   from the value.

import {
  PAY_DOUBLE_JUMP_MULTIPLE,
  WITHHOLD_DOUBLE_DROP_MULTIPLE,
  VARIANT_COPY,
  dividendStepsFor,
  STANDARD_VARIANTS,
} from "./gameVariants";
import { COMPASS_ARMS, compassArmsFor } from "../components/StockMarketRenderer";
import { readStripped } from "./sourceScan";

const DYNAMIC = { ...STANDARD_VARIANTS, dynamicStockMarket: true };
const APP = readStripped("App.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");
const STYLES = readStripped("styles/appStyles.ts");
const VARIANTS = readStripped("utils/gameVariants.ts");

describe("the two thresholds are different on purpose (design note #995)", () => {
  it("keeps the pay at three and drops the withhold to two", () => {
    expect(PAY_DOUBLE_JUMP_MULTIPLE).toBe(3);
    expect(WITHHOLD_DOUBLE_DROP_MULTIPLE).toBe(2);
  });

  it("separates the arms at the figure where they disagree", () => {
    /* ==================================================================
        THE GAP IS THE PROPERTY, NOT EITHER NUMBER
       ==================================================================
       A case asserting "withhold at 2x" and a case asserting "pay at 3x" both pass against a build that has
       unified them at 2x -- each only ever looks at its own arm, and the pay case's own boundary ($300) is
       above both thresholds either way.
       SO THE ASSERTION IS MADE AT $200 ON A $100 SHARE, which is the whole span between the two bars: one
       cell if you pay it out, two if you bank it. That figure is a single point where a symmetric
       implementation cannot agree with an asymmetric one, in either direction. */
    expect(dividendStepsFor(200, 100, DYNAMIC, "pay")).toBe(1);
    expect(dividendStepsFor(200, 100, DYNAMIC, "withhold")).toBe(2);
    /* AND THE ORDERING, so a future rebalance that raises the withhold above the pay has to disagree with
       #995's argument on purpose rather than by editing one constant. */
    expect(WITHHOLD_DOUBLE_DROP_MULTIPLE).toBeLessThan(PAY_DOUBLE_JUMP_MULTIPLE);
  });

  it("caps both arms at two cells", () => {
    /* RULED: "There are no 3-cell drops; cap the maximum penalty at a 2-cell drop." Swept far past both
       thresholds, because a ladder written as a loop rather than as two comparisons is exactly how a third
       rung appears. */
    for (const payout of [500, 1000, 100000]) {
      expect([payout, dividendStepsFor(payout, 100, DYNAMIC, "withhold")]).toEqual([payout, 2]);
      expect([payout, dividendStepsFor(payout, 100, DYNAMIC, "pay")]).toEqual([payout, 2]);
    }
  });

  it("keeps the withhold's floor while lowering its ceiling", () => {
    /* THE TWO HALVES MOVE INDEPENDENTLY AND ARE ASSERTED INDEPENDENTLY. #995 lowered the bar for the second
       cell; it did not touch the rule that a withhold always costs at least one, which is what #988 fixed and
       is the thing that stops hoarding a small run being free. */
    for (const payout of [0, 1, 99, 199]) {
      expect([payout, dividendStepsFor(payout, 100, DYNAMIC, "withhold")]).toEqual([payout, 1]);
    }
  });

  it("still leaves the base game at exactly one cell (design note #994a)", () => {
    /* THE SCOPE LIMIT, RE-ASKED because #995 changed the arithmetic the guard protects. "Ensure this
       maintains the strict separation from base-game rules (which remain exactly 1 cell)", ruled in this
       batch as well as the last -- so it is swept across BOTH thresholds now rather than only the old one. */
    for (const payout of [0, 100, 199, 200, 299, 300, 5000]) {
      for (const choice of ["pay", "withhold"] as const) {
        expect([choice, payout, dividendStepsFor(payout, 100, STANDARD_VARIANTS, choice)]).toEqual([
          choice,
          payout,
          1,
        ]);
      }
    }
  });

  it("gives the two constants names that cannot be confused", () => {
    /* THE RENAME IS PART OF THE FIX. One `DOUBLE_JUMP_MULTIPLE` serving both arms was honest while the
       numbers agreed and is a trap once they differ: a name that says "the threshold" invites the next reader
       to unify two figures that are different on purpose.
       ASSERTED AS AN ABSENCE OF THE OLD NAME, because a re-export under the old spelling would let a caller
       keep asking the ambiguous question. */
    expect(VARIANTS).toContain("export const PAY_DOUBLE_JUMP_MULTIPLE = 3;");
    expect(VARIANTS).toContain("export const WITHHOLD_DOUBLE_DROP_MULTIPLE = 2;");
    expect(VARIANTS).not.toContain("DOUBLE_JUMP_MULTIPLE = 3;\nexport const DOUBLE_JUMP");
    expect(VARIANTS).not.toContain("export const DOUBLE_JUMP_MULTIPLE");
  });

  it("declares them before the copy that interpolates them", () => {
    /* ==================================================================
        A REAL ORDERING CONSTRAINT, NOT TIDINESS
       ==================================================================
       `VARIANT_COPY` puts both figures into the Dynamic Stock Market blurb and is evaluated at module load,
       so with the constants below it they sit in their temporal dead zone and the import throws a
       `ReferenceError` before the app renders anything. Found by moving the copy, not by a test -- every
       suite that imports this module fails at once, which is the loud kind of failure, but the constraint is
       real and silent to a reader who does not know why the constants are where they are. */
    expect(VARIANTS.indexOf("export const PAY_DOUBLE_JUMP_MULTIPLE")).toBeLessThan(
      VARIANTS.indexOf("export const VARIANT_COPY"),
    );
  });
});

describe("the legends carry the split (design notes #995/#996)", () => {
  it("puts each threshold on its own compass arm", () => {
    /* THE ROSE IS THE ONE SURFACE SHOWING BOTH ARMS AT ONCE, which is why each reads its OWN constant: a
       shared figure would make the asymmetry invisible on the legend that exists to display it. */
    const arms = compassArmsFor(DYNAMIC);
    expect(arms.right.rule).toContain(`${PAY_DOUBLE_JUMP_MULTIPLE} times the price or more`);
    expect(arms.left.rule).toContain(
      `${WITHHOLD_DOUBLE_DROP_MULTIPLE} times the share price or more drops it two columns`,
    );
    expect(arms.left.rule).toContain("at least one column left");
    /* AND THE TWO SENTENCES MUST NOT NAME THE SAME NUMBER, which is the failure a shared constant produced
       and which reads as perfectly correct on either arm alone. */
    expect(arms.right.rule).not.toContain(`${WITHHOLD_DOUBLE_DROP_MULTIPLE} times the price or more`);
  });

  it("leaves the standard rose unqualified", () => {
    expect(compassArmsFor(STANDARD_VARIANTS).left).toBe(COMPASS_ARMS.left);
    expect(compassArmsFor(STANDARD_VARIANTS).right).toBe(COMPASS_ARMS.right);
  });

  it("rewrites the lobby blurb around both figures (design note #996)", () => {
    /* ==================================================================
        THE SENTENCE HAD GONE STALE TWICE OVER
       ==================================================================
       IT READ "twice the price moves it two cells" -- true until #988 raised the pay's bar to three -- said
       nothing at all about the withhold, which #994 gave a threshold and #995 lowered, and finished on
       "punishes token payouts", which is the old rule's flavour rather than the current one's.
       WHICH IS #982 IN THE SAME FILE, THREE BATCHES LATER. That note's guard was narrow on purpose ("a blurb
       describing a rule that lives in a reducer is not checkable from the string"), so this extends it the
       only way that is honest: the NUMBERS in the sentence are read against the constants. */
    const blurb = VARIANT_COPY.dynamicStockMarket.blurb;
    expect(blurb).toContain(`${PAY_DOUBLE_JUMP_MULTIPLE}x the share price`);
    expect(blurb).toContain(`${WITHHOLD_DOUBLE_DROP_MULTIPLE}x the share price`);
    expect(blurb).toContain("Markets are volatile.");
    /* THE CLAUSES IT REPLACES, as absences on the stripped source so #996's own note quoting them cannot
       satisfy the search. */
    expect(VARIANTS).not.toContain("twice the price moves it two cells");
    expect(VARIANTS).not.toContain("punishes token payouts");
  });

  it("names the decisions in the right order", () => {
    /* THE ONE WAY THIS SENTENCE CAN BE WRONG WHILE CONTAINING BOTH NUMBERS: the figures swapped, which reads
       perfectly and describes a game nobody is playing. Anchored on which word comes first. */
    const blurb = VARIANT_COPY.dynamicStockMarket.blurb;
    expect(blurb.indexOf(`Paying out ${PAY_DOUBLE_JUMP_MULTIPLE}x`)).toBeGreaterThan(-1);
    expect(blurb.indexOf(`withholding ${WITHHOLD_DOUBLE_DROP_MULTIPLE}x`)).toBeGreaterThan(
      blurb.indexOf(`Paying out ${PAY_DOUBLE_JUMP_MULTIPLE}x`),
    );
  });
});

describe("the double move is marked on the line itself (design note #998)", () => {
  /* ==================================================================
      #997 RENDERED A FOOTER; IT LASTED ONE BATCH
     ==================================================================
     #997 WIRED `dividendStepsExplanation` -- correct, and the item I had flagged as the project's signature
     fault (a correct pure function beside no wiring at all). ASKED IMMEDIATELY AFTER: "can we actually just
     indicate this on the Market Move line? e.g. ... Maybe we replace both with (double move)?"
     AND THE MARKER IS BETTER FOR A REASON THIS PANEL ALREADY RECORDS. #509a: "SHOW THE MONEY MOVING, DO NOT
     DESCRIBE IT." The Market Move line states the outcome in figures; a sentence beneath it explaining the
     arithmetic is prose about numbers the player can already read. The one fact the sentence carried that
     the figures do not is "this move is twice the usual", and that is two words.
     SO THE FUNCTION IS DELETED RATHER THAN LEFT EXPORTED AND UNCALLED, which is the state it spent eight
     batches in with a passing suite -- the thing that made it invisible. `variantRules` owns that absence. */

  it("marks a two-cell move and says nothing on a one-cell move", () => {
    expect(BAR).toContain("{steps >= 2 && projection.moves && (");
    expect(BAR).toContain("(double move)");
  });

  it("uses one direction-neutral word for both columns", () => {
    /* RULED, with the reasoning supplied: "The only issue with 'drop' is that it sounds like a vertical
       movement. Maybe we replace both with (double move)?"
       AND IT IS THE ONLY OPTION THAT IS ACTUALLY TRUE OF THIS CHART. A step is horizontal until it reaches a
       ledge and then it is vertical -- `dividendStepFrom` moves right, or UP from the end of a row; left, or
       DOWN from the start of one. "Jump" and "drop" are both wrong about the geometry near an edge, and
       #891's note records the last time this panel printed a wrong claim about the chart's shape.
       ASSERTED AS AN ABSENCE OF THE ALTERNATIVES, because the failure is a later edit "improving" the copy
       back into a direction word that the ledge rule makes false. */
    expect(BAR).not.toContain("(double jump)");
    expect(BAR).not.toContain("(double drop)");
    expect(BAR.match(/\(double move\)/g)?.length ?? 0).toBe(1);
  });

  it("suppresses the marker at the edge of the chart", () => {
    /* A TOKEN WITH NOWHERE TO GO HAS NOT MOVED TWICE AS FAR -- it has not moved at all, and the note beside
       it already says so. Two contradictory parentheticals on one line would be worse than either alone.
       ASSERTED AS THE CONJUNCTION, since `steps >= 2` alone is the plausible half-written guard. */
    expect(BAR).toContain("steps >= 2 && projection.moves");
  });

  it("takes the counts from the shell, not from a second derivation", () => {
    /* THE COUNTS RATHER THAN A BOOLEAN, so the panel is told what the board is told. `steps >= 2` is a
       rendering decision and belongs at the render site; how far a decision moves the token is the rule, and
       it has exactly one author.
       AND THEY ARE THE SAME NUMBERS THE PROJECTIONS TOOK. The marker sitting beside a price computed from a
       different count is #891 in miniature -- "(double move)" printed next to a one-cell figure. */
    expect(APP).toContain("const dividendMoveSteps = useMemo(");
    expect(APP).toContain("{ pay: dividendSteps, withhold: withholdSteps }");
    expect(APP).toContain("dividendMoveSteps={dividendMoveSteps}");
    expect(BAR).toContain("steps={dividendMoveSteps?.pay ?? 1}");
    expect(BAR).toContain("steps={dividendMoveSteps?.withhold ?? 1}");
  });

  it("has retired the footer and its styles", () => {
    /* AS AN ABSENCE, in both files: an orphaned style for a rendering we have just been asked to stop doing
       is how the rendering comes back -- the rule this sheet keeps for itself (#976, #682). */
    expect(BAR).not.toContain("dividendExplanations");
    expect(BAR).not.toContain("dividendRuleFooter");
    expect(STYLES).not.toContain("dividendRuleFooter:");
    expect(STYLES).not.toContain("dividendRuleLine:");
    expect(readStripped("utils/gameVariants.ts")).not.toContain("dividendStepsExplanation");
  });

  it("defaults to one cell for the callers that do not care", () => {
    /* THE PROP IS OPTIONAL AND DEFAULTS TO A SINGLE STEP, so the marker cannot appear on a surface that has
       not been told how far the token moves -- which is the failure mode of a `steps` that defaulted to 2 or
       to `undefined` and got compared with `>=`. */
    expect(BAR).toContain("steps = 1,");
  });
});
