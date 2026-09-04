/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1146-1148 (harness): THREE READOUTS THAT SAID MORE THAN THEY KNEW
// ==================================================================
//
// The batch is three unrelated surfaces with one habit between them: each stated something it had not
// actually established, and each was believed BECAUSE it was specific.
//
//   THE LOG    printed "Treasury now $1000" after an action that moved no money. A figure at the end of a
//              sentence about an action reads as a consequence of it -- and most tile lays are free.
//   THE TOAST  fired on every depot purchase, so the five that meant "the clock is still running" buried the
//              one that meant "the clock is about to turn over".
//   THE LADDER said nothing at all, which is the same fault inverted: the cost of the choice a player is
//              making was computable, on screen, and never computed.
//
// SO THE PROPERTY UNDER TEST IS THE SAME EACH TIME: the surface says exactly what it knows. The arithmetic
// cases below run the real function rather than scanning for it, because a float cost is a NUMBER and a
// source scan cannot tell a correct one from a plausible one.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { floatCostIn, FLOAT_THRESHOLD_PERCENT } =
  require("./floatThreshold") as typeof import("./floatThreshold");
const { DEPOT_TOAST_MS } = require("../components/ActionToast") as typeof import("../components/ActionToast");

const LOG = readStripped("utils/actionLog.ts");
const PANEL = readStripped("components/StockRoundPanel.tsx");

describe("the log states a movement or says nothing", () => {
  it("has no branch left that prints a bare balance", () => {
    /* THE WHOLE FIX IS A DELETED BRANCH. `Treasury now $` was the no-change form -- the one that printed most
       often and the only one that could mislead -- so its absence from the file IS the claim. */
    expect(LOG).not.toContain("Treasury now $");
    expect(LOG).toContain("Treasury $${before} → $${after}.");
  });

  it("stays silent when there is no before to compare against", () => {
    /* `describeTreasuryMoves` already refuses this case in those words: "a corporation that did not exist
       before has no MOVE to report; its opening balance is not a change". Two authorities on one figure that
       answer differently is #891, and this is the line that keeps them agreeing. */
    const suffix = sliceBetween(LOG, "function treasurySuffix(", "\n}\n");
    expect(suffix).toContain("after === undefined || before === undefined || before === after");
    expect(suffix).toContain('return "";');
  });
});

describe("the depot toast fires on the last of a tier, not on every one", () => {
  it("is capped at exactly two seconds", () => {
    /* ASKED FOR AS A CAP: "hard cap their duration at exactly 2 seconds." Asserted on the VALUE rather than
       on the expression, and deliberately not against `STANDARD_TOAST_MS` -- #1147's point is that tying it to
       the standard window would move it silently the next time that window is retuned. */
    expect(DEPOT_TOAST_MS).toBe(2000);
  });

  it("goes quiet while the tier still has depth", () => {
    /* #1063 BROADCAST THIS TOAST TO EVERY SEAT because "a depot train leaving is the phase clock". Six
       4-trains meant six toasts and only the last one or two change anybody's plan. */
    expect(LOG).toContain("if (left === null || left > 2) return null;");
  });

  it("says nothing for a tier that has no count to run down", () => {
    /* The diesels are unlimited and have no phase beyond them, so there is no clock for this toast to report.
       Guarded because `null > 2` is FALSE in JavaScript -- the naive test would have made the D-train the one
       train that toasts on every single purchase, which is the opposite of the report. */
    const line = sliceBetween(LOG, "export function trainPurchaseToastLine(", "\n}\n");
    expect(line).toContain("left === null");
    expect(line).not.toContain('remaining = left === null ? "unlimited"');
  });

  it("names the buyer again, and records that this reverses #1072", () => {
    /* #1072 REMOVED THE NAME at the player's request -- "players will already know whose turn it is" -- and
       that was right for a toast firing a dozen times a game. The rule above changes what the sentence is, so
       the premise expired rather than the reasoning being wrong. Asserted WITH the note reference, because a
       silent reversal is the thing this codebase's commentary exists to prevent. */
    const line = sliceBetween(LOG, "export function trainPurchaseToastLine(", "\n}\n");
    expect(line).toContain("${buyer} bought a ${tier.tier}-train. Depot: ${remaining} remaining.");
    expect(line).toContain("company_id === protocolId");
    /* Read from the UNSTRIPPED source: the reversal is recorded in prose, which `readStripped` removes. */
    const raw = require("fs").readFileSync(
      require("path").join(__dirname, "actionLog.ts"),
      "utf8",
    ) as string;
    expect(raw).toContain("DESIGN NOTE 1147 REVERSES #1072");
  });
});

describe("the float cost is arithmetic, and it is right", () => {
  /* RUN, NOT SCANNED. Every other case in this file asks what the source says; these ask what the function
     RETURNS, because a wrong float cost looks exactly like a right one in source and a player would act on
     it. Sixty percent is six 10% blocks at par -- the president's 20% certificate is two blocks at twice par,
     so certificate SIZES never enter the arithmetic and that is what makes it this short. */
  it("prices a whole float at six blocks of par", () => {
    expect(floatCostIn(67, 0)).toEqual({ total: 402, remaining: 402 });
    expect(floatCostIn(100, 0)).toEqual({ total: 600, remaining: 600 });
  });

  it("subtracts what has already left the IPO", () => {
    // The president's 20% certificate is gone: four blocks left at $67.
    expect(floatCostIn(67, 20).remaining).toBe(268);
    expect(floatCostIn(100, 50).remaining).toBe(100);
  });

  it("never asks for money past the threshold, and never asks for less than nothing", () => {
    /* A corporation can pass sixty percent -- the pool keeps selling -- and a negative requirement rendered as
       "-$134 must leave the IPO to float" is the kind of figure that makes a player distrust every other
       number on the card. */
    expect(floatCostIn(67, FLOAT_THRESHOLD_PERCENT).remaining).toBe(0);
    expect(floatCostIn(67, 100).remaining).toBe(0);
  });

  it("invents nothing without a price", () => {
    /* An unparred corporation has no par, and "$0 to float" is a figure that is not true. */
    expect(floatCostIn(0, 0)).toEqual({ total: 0, remaining: 0 });
    expect(floatCostIn(Number.NaN, 20)).toEqual({ total: 0, remaining: 0 });
  });

  it("reads the threshold rather than repeating it", () => {
    /* #749's rule: the card and the reducer must not hold two copies of the float condition. */
    const source = readStripped("utils/floatThreshold.ts");
    const fn = sliceBetween(source, "export function floatCostIn(", "\n}\n");
    expect(fn).toContain("FLOAT_THRESHOLD_PERCENT / 10");
    expect(fn).not.toContain("60");
  });
});

describe("the two readouts on the card", () => {
  it("puts the live cost under the ladder that sets it", () => {
    /* THE FIGURE MOVES WITH THE RUNG, which is the whole argument for this placement over a toggle elsewhere:
       $67 asks $402 of the table and $100 asks $600, so the ladder becomes the choice it actually is. */
    expect(PANEL).toContain("floatCostIn(Number(parValue), soldFromIpoPercent(company)).remaining");
    expect(PANEL).toContain("needed to float");
  });

  it("says nothing before a rung is chosen", () => {
    expect(PANEL).toContain('parValue !== "" && Number(parValue) > 0 &&');
  });

  it("words the cost as the corporation's, not the reader's", () => {
    /* THE MONEY IS NOT THE PARRING PLAYER'S. They buy the 20% president's certificate; the other 40% must be
       bought by anybody. "You need $402" would be false, and falsely discouraging at the exact moment a player
       is deciding how ambitious to be. */
    expect(PANEL).not.toContain("you need");
    expect(PANEL).not.toContain("You need");
  });

  it("offers the second reading only where there is a price to read", () => {
    /* An unparred corporation has no dollar figure to alternate to, so the badge stays a plain span -- a
       control that turns over to show a blank is worse than no control. */
    const badge = sliceBetween(PANEL, "function FloatProgressBadge({", "\nfunction CorporationRoster({");
    expect(badge).toContain("if (!(par > 0)) {");
    expect(badge).toContain("<button");
  });

  it("distinguishes the two readings rather than reversing direction in silence", () => {
    /* ==================================================================
        DESIGN NOTE 1148a NARROWS HOW THIS IS SAID, NOT WHAT IS SAID
       ==================================================================
       THE CLAIM IS UNCHANGED and it is worth restating because it is the reason the wording matters at all:
       the percentage reads `sold / needed` and counts UP, the money reads what is still owed and counts DOWN,
       and two readings that swap in one slot while silently reversing direction will be misread.
       IT WAS RESOLVED BY NAMING BOTH ENDS -- "$268 left of $402" -- and reported straight back: "ambiguous /
       unclear to me, but I recognize your impulse as correct." Naming the total answered the direction and
       raised a new question in its place, which is a worse trade than the one it fixed.
       "NEEDED" CARRIES THE DIRECTION ON ITS OWN, against a single figure, so the second number is gone and
       the property survives. Asserted as the word rather than as the sentence, because the sentence is shared
       with the par ladder and either surface may reword around it. */
    expect(PANEL).toContain("needed to float");
    expect(PANEL).not.toContain("left of $");
    expect(PANEL).toContain("${sold}% / ${FLOAT_THRESHOLD_PERCENT}%");
  });

  it("says the remaining cost the same way in both places", () => {
    /* ONE QUANTITY, ONE WORDING. Both readouts are `floatCostIn(...).remaining` on the same card, and at
       par-selection time they are numerically identical -- nothing has left the IPO yet, so remaining IS the
       total. Two phrasings for one figure is the fault this codebase keeps finding, at the smallest scale it
       comes in. */
    expect(PANEL.split("needed to float").length - 1).toBe(2);
  });

  it("asks the browser whether it can hover instead of guessing from the event", () => {
    /* A `mouseenter` handler fires on a TAP and then sticks until something else is touched, so the press
       would behave differently on the two device classes for no reason a player could learn. The media query
       asks the question directly, and `<style>` is the documented escape hatch (#46). */
    expect(PANEL).toContain("@media (hover: hover) and (pointer: fine)");
    expect(PANEL).toContain("<style>{FLOAT_BADGE_CSS}</style>");
    const badge = sliceBetween(PANEL, "function FloatProgressBadge({", "\nfunction CorporationRoster({");
    expect(badge).not.toContain("onMouseEnter");
  });

  it("is reachable by keyboard and answers for itself", () => {
    /* It was a `<span>` with a `title`. A `title` is not an accessible name for a control, and a div that
       swaps its own text on click is invisible to anyone not using a mouse. */
    const badge = sliceBetween(PANEL, "function FloatProgressBadge({", "\nfunction CorporationRoster({");
    expect(badge).toContain('type="button"');
    expect(badge).toContain("aria-label=");
  });
});
