/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 988-993 (harness): A BALANCE RULE THAT HAD NO HOME, AND FOUR PIECES OF POLISH
// ==================================================================
//
// #988 IS THE ONLY ONE OF THESE THAT CHANGES WHAT HAPPENS IN A GAME, and it is two rules with very different
// shapes. The double-jump threshold is a NUMBER and moves in one place. The withhold is a MISSING ARGUMENT:
// `dividendStepsFor` did not know which decision it was being asked about, so the shell handed its answer to
// both projections and a withhold moved by the multiple a PAYOUT would have earned.
//
// AND THE TWO SURFACES ALREADY DISAGREED, which is the part that makes this a bug rather than a balance
// preference. `App.tsx`'s readout hard-coded one cell for a withhold and said so in a comment; the reducer's
// `projectDividend` passed the pay-derived count. The bar promised a one-cell drop and the board moved zero or
// two -- #891's exact failure, in the function #891 created to prevent it. A rule stated in a comment at one
// call site is not a rule, and that is what this file is mostly about.
//
// #989-#992 are style and copy literals, so they are source scans. #993's payload is a value with an answer
// and is driven directly.

import {
  PAY_DOUBLE_JUMP_MULTIPLE,
  WITHHOLD_DOUBLE_DROP_MULTIPLE,
  dividendStepsFor,
  STANDARD_VARIANTS,
} from "./gameVariants";
import {
  COMPASS_ARMS,
  PRICE_GRID,
  compassArmsFor,
  projectDividendCellMove,
} from "../components/StockMarketRenderer";
import { UNPREDICTABLE_REVENUE_FLAVOR } from "../constants/flavorText";
import { readStripped, sliceBetween } from "./sourceScan";

const DYNAMIC = { ...STANDARD_VARIANTS, dynamicStockMarket: true };
const APP = readStripped("App.tsx");
const MODAL = readStripped("components/FleetLossModal.tsx");
const NOTICE = readStripped("utils/fleetLossNotice.ts");
const STYLES = readStripped("styles/appStyles.ts");

describe("a withhold always costs at least one cell (design notes #988 -> #994)", () => {
  it("never moves nothing, whatever the run was worth", () => {
    /* ==================================================================
        THE FLOOR IS THE RULE, AND IT IS WHAT #988 ACTUALLY FIXED
       ==================================================================
       #988 RULED "one space to the left ... mirroring the standard one-space right/up movement of a Pay Out",
       and this case asserted exactly one cell for every payout. #994 THEN GAVE IT A CEILING: "If a
       corporation Withholds revenue that is >= 3x the current share price, the stock must drop by 2 cells."
       SO THE CONSTANT IS GONE AND THE FLOOR REMAINS, which is the half that distinguishes this from the bug
       #988 found. Before #988 a withhold took the PAY's whole ladder including its bottom rung, so a run
       under the share price moved the token nothing and withholding a small revenue was free. That can never
       happen again, and it is worth asserting separately from the threshold: a future change to the multiple
       must not be able to reintroduce a zero.
       SWEPT BELOW THE THRESHOLD IN BOTH RULESETS, since the standard game has no threshold at all. #995 moved
       the variant's own bar down to twice the price, so the sweep stops at 199 rather than 299. */
    for (const payout of [0, 50, 99, 100, 150, 199]) {
      expect([payout, dividendStepsFor(payout, 100, DYNAMIC, "withhold")]).toEqual([payout, 1]);
    }
    for (const payout of [0, 50, 300, 5000]) {
      expect([payout, dividendStepsFor(payout, 100, STANDARD_VARIANTS, "withhold")]).toEqual([
        payout,
        1,
      ]);
    }
  });

  it("drops two cells at TWICE the share price (design note #995)", () => {
    /* ==================================================================
        #994 MADE IT A MIRROR; #995 MADE IT DELIBERATELY ASYMMETRIC
       ==================================================================
       THIS ASSERTED THREE TIMES, matching the pay arm from one shared constant. RULED SINCE: "The current
       symmetric 3x threshold is too forgiving for withholding ... Withhold: change the 2-cell negative drop
       threshold to >= 2x the share price."
       SO THE TWO ARMS NOW READ DIFFERENT CONSTANTS, and the case asserts the GAP as well as the value: $200
       on a $100 share is one cell if you pay it out and two if you bank it, which is the entire point of the
       asymmetry and the one comparison a single-arm assertion cannot make.
       BOTH EDGES, because "at least 2x" is inclusive upward and a table arguing about a $200 withhold on a
       $100 share is the same bad afternoon the pay arm's boundary case exists to prevent.
       AND THE CAP IS ASSERTED TOO: "There are no 3-cell drops", ruled in as many words, so ten times the
       price is still two. */
    expect(dividendStepsFor(199, 100, DYNAMIC, "withhold")).toBe(1);
    expect(dividendStepsFor(200, 100, DYNAMIC, "withhold")).toBe(2);
    expect(dividendStepsFor(1000, 100, DYNAMIC, "withhold")).toBe(2);
    /* THE ASYMMETRY ITSELF, at the one figure that separates the arms. */
    expect(dividendStepsFor(200, 100, DYNAMIC, "pay")).toBe(1);
    const price = 90;
    expect(dividendStepsFor(price * WITHHOLD_DOUBLE_DROP_MULTIPLE, price, DYNAMIC, "withhold")).toBe(2);
    expect(
      dividendStepsFor(price * WITHHOLD_DOUBLE_DROP_MULTIPLE - 1, price, DYNAMIC, "withhold"),
    ).toBe(1);
    expect(WITHHOLD_DOUBLE_DROP_MULTIPLE).toBeLessThan(PAY_DOUBLE_JUMP_MULTIPLE);
  });

  it("leaves the base game at one cell, at every multiple (design note #994a)", () => {
    /* ==================================================================
        THE VARIANT BOUNDARY, ASSERTED AS ITS OWN CASE
       ==================================================================
       RULED, as a scope limit on #994: "Please ensure the dynamic Withholding penalty ... strictly applies
       ONLY when the Dynamic Stock Market variant is active. Do not alter the base game's withholding rules.
       Base game withholding must always remain exactly a 1-cell drop, regardless of the revenue withheld."
       THE GUARD WAS ALREADY THERE -- `if (!variants.dynamicStockMarket) return 1;` sits ahead of every arm,
       so the threshold is unreachable without the flag. What was NOT there was a case that could only pass
       because of it: the standard figures were folded into the floor case above, where a build that had
       dropped the guard would still pass every payout under 3x and fail only at 300, one assertion deep in a
       loop about something else.
       SO THIS SWEEPS THE STANDARD GAME ACROSS THE THRESHOLD, on both decisions, and reads as what it is: a
       fence around the variant rather than a fact about withholding. A regression that let the multiple leak
       into the base game fails HERE, by name.
       THE PAY ARM IS SWEPT TOO, because the same guard protects it and #908's own control case ("moves one
       cell for any payout under standard rules") is the precedent this follows. */
    for (const payout of [0, 1, 99, 100, 299, 300, 301, 5000]) {
      for (const choice of ["pay", "withhold"] as const) {
        expect([choice, payout, dividendStepsFor(payout, 100, STANDARD_VARIANTS, choice)]).toEqual([
          choice,
          payout,
          1,
        ]);
      }
    }
    /* AND AT PRICES WHERE THE MULTIPLE WOULD BITE DIFFERENTLY, so the case cannot be satisfied by a build
       that happens to compare against the wrong number. */
    for (const price of [10, 67, 350, null]) {
      expect([price, dividendStepsFor(2000, price, STANDARD_VARIANTS, "withhold")]).toEqual([
        price,
        1,
      ]);
    }
  });

  it("says nothing about the variant on a standard table", () => {
    /* THE COPY HALF OF THE SAME FENCE: a base-game player is never told about a threshold their table does
       not use. The compass rose's arms are the shared ones, unqualified.
       Design note #998: `dividendStepsExplanation` used to be the other half of this and is deleted -- see
       `variantRules` for why a sentence nobody rendered was worse than no sentence. */
    expect(compassArmsFor(STANDARD_VARIANTS).left).toBe(COMPASS_ARMS.left);
    expect(compassArmsFor(STANDARD_VARIANTS).left.label).toBe("Withheld");
  });

  it("falls to one cell rather than two on an unreadable price", () => {
    /* THE SAME DIRECTION THE PAY ARM FALLS. Every payout is infinitely many times nothing, so a naive
       multiple would hand the variant's HARSHEST penalty to the corporation with the weakest claim on it --
       the mirror of the reasoning #908 gives for the pay's own zero-price fallback. */
    expect(dividendStepsFor(5000, 0, DYNAMIC, "withhold")).toBe(1);
    expect(dividendStepsFor(5000, null, DYNAMIC, "withhold")).toBe(1);
  });

  it("moves the token on the real chart, in the losing direction", () => {
    /* THE INTEGRATION HALF. `dividendStepsFor` being right proves nothing about the projection taking the
       count -- the same gap a control has walked through twice in this project. Driven against the REAL
       `PRICE_GRID` and compared BY CELL, because prices repeat across rows (#434).
       AND THE DIRECTION IS ASSERTED TOO. "One space to the left" is half the ruling; a step of one in the
       wrong direction satisfies every count assertion above and rewards a withhold. */
    const start = PRICE_GRID.find((cell) => cell.x === 4 && cell.y === 3);
    expect(start).toBeTruthy();
    const landed = projectDividendCellMove(
      start as { x: number; y: number },
      "withhold",
      dividendStepsFor(150, 100, DYNAMIC, "withhold"),
    );
    expect(landed?.x).toBe(3);
    expect(landed?.y).toBe(3);
    /* #994: AND TWO CELLS WHEN THE RUN EARNS IT. Asserted through the same projection rather than by trusting
       the count, because "the step function is right" and "the board takes the steps" are the two halves this
       project keeps finding separated. */
    const far = projectDividendCellMove(
      start as { x: number; y: number },
      "withhold",
      dividendStepsFor(400, 100, DYNAMIC, "withhold"),
    );
    expect(far?.x).toBe(2);
    expect(far?.y).toBe(3);
  });

  it("is asked with a choice at every call site", () => {
    /* ==================================================================
        THE ARGUMENT IS REQUIRED, AND THAT IS THE FIX
       ==================================================================
       A DEFAULT WOULD HAVE LET THE BUG SURVIVE THE PATCH. The whole fault is a caller that never said which
       decision it meant, so `choice = "pay"` would have kept the reducer's `projectDividend` -- the one site
       that actually receives a withhold -- silently answering for a pay.
       ASSERTED AS THE SHELL PASSING ITS OWN `choice` THROUGH, not as a literal: that call site is generic
       over both, and pinning `"pay"` there would be pinning the bug. */
    const project = sliceBetween(APP, "projectDividend: (from, choice) => {", "},");
    expect(project).toContain("resolveVariants(before?.variants),\n              choice,");
    expect(project).toContain("projectDividendCellMove(from, choice, steps)");
  });

  it("no longer keeps the withhold rule in a comment at the readout", () => {
    /* THE OTHER HALF OF #891's FAILURE. `withholdProjection` hard-coded one cell and explained itself in
       prose while the board did something else -- so the readout was right and unenforceable. It asks the
       shared function now, which is what turns a comment into a rule. */
    expect(APP).toContain('"withhold",');
    /* ==================================================================
        AND THE FIGURE IT ASKS WITH IS NOW LOAD-BEARING (design note #994)
       ==================================================================
       #988 ROUTED THIS THROUGH THE SHARED FUNCTION AND PASSED `0` AS THE PAYOUT, on the reasoning that a
       withhold pays nothing out so the amount could not matter. True of #988's rule; false of #994's, where
       the drop scales with the revenue withheld -- so the placeholder would have reported one cell for every
       turn the board moves two.
       THE SAME REVENUE FEEDS BOTH ARMS, read once, which is what makes that impossible rather than merely
       fixed. Asserted as the absence of the placeholder AND the presence of the shared figure, because either
       alone is a state a half-done edit reaches. */
    expect(APP).not.toContain("dividendStepsFor(0, dividendPrice");
    expect(APP).toContain("const dividendRevenueForSteps = useMemo(");
    const withhold = sliceBetween(APP, "const withholdSteps = useMemo(", "[dividendRevenueForSteps,");
    expect(withhold).toContain("dividendRevenueForSteps,");
    expect(withhold).toContain('"withhold",');
  });
});

describe("the double jump wants three times the price (design note #988)", () => {
  it("moves one cell at twice, two at three times", () => {
    /* RULED: "Shift the requirement for a 2-cell positive movement (double jump) from 2x the share price to
       3x the share price."
       THE OLD BOUNDARY IS ASSERTED AS THE MIDDLE BAND, not merely deleted. A case that only checked $300 is
       two cells would pass against an implementation that kept 2x as well. */
    expect(dividendStepsFor(200, 100, DYNAMIC, "pay")).toBe(1);
    expect(dividendStepsFor(299, 100, DYNAMIC, "pay")).toBe(1);
    expect(dividendStepsFor(300, 100, DYNAMIC, "pay")).toBe(2);
  });

  it("takes the threshold from one exported constant", () => {
    expect(PAY_DOUBLE_JUMP_MULTIPLE).toBe(3);
    const price = 90;
    expect(dividendStepsFor(price * PAY_DOUBLE_JUMP_MULTIPLE, price, DYNAMIC, "pay")).toBe(2);
    expect(dividendStepsFor(price * PAY_DOUBLE_JUMP_MULTIPLE - 1, price, DYNAMIC, "pay")).toBe(1);
  });

  it("says three in every sentence that names the number", () => {
    /* ==================================================================
        THE LEGEND AND THE RULE, WHICH #746c IS ENTIRELY ABOUT
       ==================================================================
       "The caption was accurate about the code as it then stood, which is precisely why a wrong rule reaches
       a player: the legend agreed with the bug." A rebalance is exactly when a legend goes stale -- the
       number moves in the reducer and "twice" stays on the compass rose and in the action bar's sentence.
       BOTH SURFACES, and both against the CONSTANT rather than against the word three, so the next change
       carries them along instead of leaving them behind. */
    /* Design note #998: THE ACTION BAR'S SENTENCE IS GONE (see `variantRules`), so the compass rose is the
       one legend left that names this figure -- which makes it the only place a stale "twice" can now hide. */
    const rule = compassArmsFor(DYNAMIC).right.rule;
    expect(rule).toContain(`${PAY_DOUBLE_JUMP_MULTIPLE} times the price or more`);
    expect(rule).not.toContain("twice");
  });

  it("tells a player the withhold can cost two cells as well (design note #994)", () => {
    /* ==================================================================
        #988 WROTE THIS ARM TO DENY THE VARIATION; #994 MADE IT THE RULE
       ==================================================================
       ONE BATCH AGO THIS ASSERTED `"whatever the run was worth"` -- a sentence added specifically so that a
       player reading "Paid (varies)" beside "Withheld" would not infer that the withhold varied too.
       IT DOES NOW. A legend written to DENY a rule turns out to be exactly as fragile as one written to state
       it, which is #746c from the other side and worth having found.
       THE LABEL CARRIES IT TOO, not only the tooltip: "Withheld" beside "Paid (varies)" still says fixed, and
       the label is the half read without hovering. */
    const left = compassArmsFor(DYNAMIC).left;
    expect(left.label).toBe("Withheld (varies)");
    expect(left.rule).toContain(`${WITHHOLD_DOUBLE_DROP_MULTIPLE} times the share price or more drops it two columns`);
    expect(left.rule).toContain("at least one column left");
    expect(left.rule).not.toContain("whatever the run was worth");
    /* THE STANDARD ROSE IS UNTOUCHED, or every table reads a variant rule. */
    expect(compassArmsFor(STANDARD_VARIANTS).left).toBe(COMPASS_ARMS.left);
  });

  it("leaves the standard game untouched by any of it", () => {
    /* THE CONTROL THAT PROTECTS EVERY EXISTING TABLE. With the variant off the count is 1 whatever the
       figures say, on both decisions -- which is 1830. */
    for (const choice of ["pay", "withhold"] as const) {
      for (const payout of [0, 10, 1000]) {
        expect([choice, payout, dividendStepsFor(payout, 100, STANDARD_VARIANTS, choice)]).toEqual([
          choice,
          payout,
          1,
        ]);
      }
    }
    /* Design note #998: the sentence this line asserted is deleted -- the compass rose carries the fence
       now, and `variantRules` owns the absence. */
    expect(compassArmsFor(STANDARD_VARIANTS).right).toBe(COMPASS_ARMS.right);
  });
});

describe("the president badge sits on white (design note #989)", () => {
  it("is a solid ground rather than a translucent darkening", () => {
    /* REPORTED: "a dark, semi-opaque background that looks messy against the app's blue theme."
       AND THE REPORT NAMES THE MECHANISM. #974 chose `rgba(0, 0, 0, 0.5)` so one rule could darken eight
       liveries equally -- but a translucent plate produces eight muddied grounds, not one, so the badge
       changed colour as the turn passed round the table. */
    const style = sliceBetween(STYLES, "orContextPresident: {", "},");
    expect(style).toContain('backgroundColor: "#ffffff"');
    expect(style).not.toContain("rgba(");
  });

  it("keeps the badge shape that makes it a badge", () => {
    /* THE HALF THAT MUST SURVIVE A COLOUR CHANGE. Without the radius and the padding this is a white
       rectangle behind text, and #974's alignment constraint (#805's two-row column) still bounds the
       vertical padding. */
    const style = sliceBetween(STYLES, "orContextPresident: {", "},");
    expect(style).toContain("borderRadius:");
    const padding = style.match(/padding: "([^"]+)"/)?.[1] ?? "";
    expect(Number(padding.split(" ")[0].replace(/\D/g, ""))).toBeLessThanOrEqual(2);
  });

  it("still paints the name in the seat colour", () => {
    /* THE REASON THE PLATE EXISTS AT ALL (#974). A white badge with the bar's own ink in it would be a
       cleaner version of the thing that could not tell you who the president was. */
    const BAR = readStripped("panels/ContextualActionBar.tsx");
    expect(BAR).toContain("color: activeCorporation.presidentColor ?? corporationBarInk.inkMuted,");
  });
});

describe("the modals say true things in plain words (design notes #990-#992)", () => {
  it("has stopped saying the discarded train comes back", () => {
    /* RULED: "Discarded trains are permanently removed from the game."
       AND #980 KEPT THAT SENTENCE ON EXACTLY THE WRONG GROUNDS -- "a fact with a rival's decision attached".
       The decision does not exist, so the line was not surplus, it was false. */
    expect(NOTICE).not.toContain("back in the depot");
    expect(NOTICE).not.toContain("may be bought again by anyone");
    expect(MODAL).not.toContain("noticeConsequence");
  });

  it("has deleted the function rather than leaving it answering null", () => {
    /* A PREDICATE WITH ONE REACHABLE ANSWER is #788's unreachable arm wearing a return type, and the next
       reader takes it for a slot waiting to be filled. */
    expect(NOTICE).not.toContain("export function noticeConsequence");
  });

  it("uses the ruled toggle caption, with no implementation vocabulary in it", () => {
    /* RULED: "Normal people don't use the word 'modals.'" -- and the old sentence was written from the inside
       in more than that one word: "this kind of event" is the code's name for `FleetLossCause`, and "for the
       rest of this session" is a fact about `sessionStorage`.
       ASSERTED AS BOTH HALVES: the new sentence present, and the three insider words absent. */
    expect(MODAL).toContain(
      "This disables Rust/Train Limit notifications for this company. They will still print in the",
    );
    expect(MODAL).toContain("Activity Log.");
    expect(MODAL).not.toContain("Stops this modal");
    expect(MODAL).not.toContain("this kind of event");
    expect(MODAL).not.toContain("rest of this session");
  });

  it("keeps the promise the toggle depends on", () => {
    /* THE HALF WORTH SAVING FROM THE OLD CAPTION, and #896's reason for offering the toggle at all: nothing
       is hidden, the Activity Log still records every loss. A silence switch without that sentence is asking
       a player to turn off a warning with no idea what they lose. */
    expect(MODAL).toContain("still print in the");
    expect(MODAL).toContain("Activity Log");
  });

  it("puts the herald in the title beside the acronym", () => {
    /* RULED: "inject the corporate herald (logo) into the title alongside the corporation acronym."
       ALONGSIDE, NOT INSTEAD. `CorporateLogo` falls back to the ticker when a file is missing, so a logo on
       its own would silently become a second copy of the word -- and the headline is a sentence with a
       subject in it ("PRR lost 2 trains to rust"), not a label. */
    expect(MODAL).toContain("<CorporateLogo");
    expect(MODAL).toContain("ticker={notice.ticker}");
    expect(MODAL).toContain("<span style={styles.heading}>{noticeHeadline(notice)}</span>");
  });

  it("gives the herald something to fall back to", () => {
    /* THE MISSING-FILE CASE, which is not hypothetical: `CorporateLogo` carries a `failed` state precisely
       because a logo can be absent. Without a `fallbackStyle` the fallback renders as unstyled text in the
       middle of a title. */
    expect(MODAL).toContain("fallbackStyle={styles.heraldFallback}");
    expect(MODAL).toContain("heraldFallback:");
  });

  it("shows it on both causes, not just on rust", () => {
    /* RULED: "On BOTH the Rust and Train Limit warning modals." One component draws both, so this is true by
       construction -- and it is asserted anyway, because the cause chip beside it IS branched and a future
       edit that branches the herald the same way would look consistent and be wrong. */
    /* ==================================================================
        ASSERTED AS "NOTHING IN THIS TITLE IS CONDITIONAL"
       ==================================================================
       MY FIRST VERSION checked that the header contained `<CorporateLogo` and not a `cause === "rust" ?`
       branch around it. A control that wrapped the element in `{false && ...}` PASSED both: the substring is
       still there, and the guard it added was not the one shape I had thought to forbid.
       THE RULE IS NOT "no rust branch", IT IS "the herald is not gated at all" -- so the check is that this
       header holds no `&&` whatever. The two things in it beside the herald are the cause chip's ternaries,
       which are a choice BETWEEN two renderings rather than a guard on one, so they are untouched by this and
       a new `&&` here is exactly the edit worth failing on. */
    const header = sliceBetween(MODAL, "<div style={styles.header}>", "</div>");
    expect(header).toContain("<CorporateLogo");
    expect(header).not.toContain("&&");
  });
});

describe("the flavour payload grew (design note #993)", () => {
  const BUCKETS = ["criticalMalus", "minorMalus", "unchanged", "minorBonus", "criticalBonus"] as const;

  it("holds every supplied line that was not already there", () => {
    /* ==================================================================
        "APPEND, DO NOT REPLACE" -- AND 63 OF THE SUPPLIED LINES WERE ALREADY IN THE FILE
       ==================================================================
       The five lists overlap the existing payload heavily: 19 of the 30 Major Malus lines, 20 of 30 Minor
       Malus, 16 of 50 Unchanged and 8 of 35 Major Bonus were already present, word for word. Minor Bonus was
       the only list with no overlap at all.
       APPENDING VERBATIM WOULD HAVE DOUBLED THEM, which is not a cosmetic problem: the selector indexes
       uniformly, so a duplicated line is a line that comes up twice as often as its neighbours. The
       no-repeats case in `flavorText.test.ts` is what caught it.
       SO "APPEND" IS HONOURED AND "DUPLICATE" IS NOT. Nothing existing was removed and every genuinely new
       line was added; the count is the union rather than the sum.
       ==================================================================
        AND THE SECOND LIST OVERLAPPED NOTHING AT ALL (design note #993a)
       ==================================================================
       A further 63 lines followed -- 19 Major Malus, 20 Minor Malus, 16 Unchanged, 8 Major Bonus -- and the
       same check found ZERO duplicates against a payload that by then held 357. Worth recording, because it
       is the evidence that the first batch's 63 collisions were a property of THAT list rather than of the
       check being too eager: the comparison is the same one, normalised for curly quotes and case. */
    const counts = BUCKETS.map((key) => UNPREDICTABLE_REVENUE_FLAVOR[key].length);
    expect(counts).toEqual([105, 105, 120, 105, 110]);
  });

  it("repeats no line anywhere in the payload", () => {
    /* THE PROPERTY THE DE-DUPLICATION EXISTS FOR, asserted across ALL FIVE buckets rather than within each:
       a line in two buckets is worse than a line twice in one, because it would then describe both a
       disaster and a windfall. */
    const all = BUCKETS.flatMap((key) => [...UNPREDICTABLE_REVENUE_FLAVOR[key]]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("kept the lines that were already there", () => {
    /* "DO NOT REPLACE", as a spot check on each bucket's original opening line. A rewrite that dropped the
       existing payload and used the supplied lists alone would satisfy every count above. */
    expect(UNPREDICTABLE_REVENUE_FLAVOR.criticalMalus[0]).toBe(
      "The day's revenue took an unexpected excursion through the countryside.",
    );
    expect(UNPREDICTABLE_REVENUE_FLAVOR.minorBonus[0]).toBe(
      "The railway finally discovered that people are willing to pay for this service.",
    );
  });

  it("added the new lines at the end of their own buckets", () => {
    /* THE ORDER IS NOT COSMETIC. The selector is `hash % length`, so inserting into the middle would
       re-point every index after the insertion -- and #903's replay stability is about a build producing the
       same line for the same turn. Appending changes which lines are reachable, never which existing entry
       an index names. */
    expect(UNPREDICTABLE_REVENUE_FLAVOR.criticalMalus.at(-1)).toBe(
      "A competing line poached the entire station agent staff overnight.",
    );
    expect(UNPREDICTABLE_REVENUE_FLAVOR.unchanged.at(-1)).toBe(
      "It was a quiet week, the calm before or after something else.",
    );
    /* #993b: EVERY BUCKET RECEIVED TWENTY-FIVE THIS TIME, so the tails move together -- unlike the second
       list, where Minor Bonus got nothing and its unchanged tail was the cheapest proof that an append
       touched only the buckets it was given. */
    expect(UNPREDICTABLE_REVENUE_FLAVOR.minorBonus.at(-1)).toBe(
      "A visiting dignitary\u2019s tour brought favorable press and new riders.",
    );
  });
});
