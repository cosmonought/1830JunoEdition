/** @jest-environment node */
//
// Pure arithmetic and one source scan; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 719 (harness): WHAT THE ROW'S LENGTH MEANS
// ==================================================================
//
// REPORTED: "when a corporation owns a train in, e.g., Phase 2, the [selector] only shows 1 / 2 / 3 options,
// but I think it would be better to show 1 / 2 / 3 / 4 with the 4 option grayed out. The selector should only
// drop options when the train limit forces it, not just because a corporation can't hold that many."
//
// THE ASSERTIONS ARE ABOUT WHAT DOES *NOT* MOVE THE ROW, which is the inverse of how the old code was written.
// #696 set the length to `buyableNow` -- a figure that answers to the depot, the holdings AND the limit -- so
// every one of those three could silently resize the control. Testing that the length is right for one board
// would not have caught it; what catches it is holding the limit fixed and varying everything else.
//
// AND THE PAIRING IS THE POINT. A row that never shrinks would be as wrong as one that always does: the
// option has to be DRAWN and DEAD. So each case below asserts the length and the reachable count together,
// because either alone is satisfiable by a broken implementation.

import { buyableNow, quantityOptionCount } from "./trainLimit";

/** The panel's own pairing: how long the row is, and how much of it can be clicked. */
function row(input: {
  owned: number;
  currentLimit: number | null;
  depotSupply: number;
  advancesPhase?: boolean;
  limitAfterPurchase?: number | null;
}) {
  const buyable = buyableNow({
    owned: input.owned,
    currentLimit: input.currentLimit,
    depotSupply: input.depotSupply,
    advancesPhase: input.advancesPhase ?? false,
    limitAfterPurchase: input.limitAfterPurchase ?? null,
  });
  return { length: quantityOptionCount(input.currentLimit, buyable), enabled: buyable };
}

describe("the length is the phase's limit and nothing else", () => {
  it("shows four options in Phase 2 to a corporation holding one", () => {
    /* THE REPORT, VERBATIM. Limit 4, owns 1, plenty in the depot: the old row was three long, and the fourth
       option existing-but-dead is what tells the player where they stand. */
    expect(row({ owned: 1, currentLimit: 4, depotSupply: 6 })).toEqual({ length: 4, enabled: 3 });
  });

  it("does not shorten as a corporation fills up", () => {
    /* THE PROPERTY, swept across a whole phase. The row is a fact about Phase 2; a player buying through it
       should never watch the control resize under them, which is the specific thing that made its length
       unreadable. */
    for (const owned of [0, 1, 2, 3, 4]) {
      expect(row({ owned, currentLimit: 4, depotSupply: 6 }).length).toBe(4);
    }
  });

  it("does not shorten when the depot runs low", () => {
    /* THE OTHER RULE THE LENGTH USED TO CARRY. Two 4-trains left in the depot used to produce a two-option
       row that looked exactly like a phase-5 limit of two. */
    expect(row({ owned: 0, currentLimit: 4, depotSupply: 2 })).toEqual({ length: 4, enabled: 2 });
  });

  it("shortens when the limit itself drops", () => {
    /* THE ONE THING THAT MAY MOVE IT, and the property #696 wanted from a row rather than a dropdown: it is
       at most four and narrows as the phases turn. */
    expect(row({ owned: 0, currentLimit: 3, depotSupply: 9 }).length).toBe(3);
    expect(row({ owned: 0, currentLimit: 2, depotSupply: 9 }).length).toBe(2);
  });

  it("stays full-length with nothing reachable at all", () => {
    /* AT THE LIMIT: four options, none of them clickable, and the panel's own "Train Limit Reached" wording on
       the button. An empty or one-long row here would suggest the limit had changed. */
    expect(row({ owned: 4, currentLimit: 4, depotSupply: 6 })).toEqual({ length: 4, enabled: 0 });
  });

  it("stays full-length when the depot is empty", () => {
    expect(row({ owned: 0, currentLimit: 4, depotSupply: 0 })).toEqual({ length: 4, enabled: 0 });
  });
});

describe("the phase-turning purchase greys rather than truncates", () => {
  it("keeps four options when the first buy cuts the limit to three", () => {
    /* #296/#703'S CASE. Holding three of four, buying the next train starts the phase and drops the ceiling to
       three -- so exactly one purchase is legal. The row still shows the Phase 2 limit it is standing in, with
       three dead options and the amber "Train Limit After Purchase" readout beside it saying why. */
    expect(
      row({
        owned: 3,
        currentLimit: 4,
        depotSupply: 5,
        advancesPhase: true,
        limitAfterPurchase: 3,
      }),
    ).toEqual({ length: 4, enabled: 1 });
  });
});

describe("an unreported limit falls back to the old behaviour", () => {
  it("uses what is buyable when the chain does not say", () => {
    /* `null` is "the chain did not report", not "unlimited trains" -- and an unbounded row cannot be drawn at
       all. Falling back to `buyableNow` reproduces the pre-#719 row exactly, so an unsupported chain renders
       as it always did rather than rendering nothing. */
    expect(quantityOptionCount(null, 3)).toBe(3);
  });

  it("never returns a row shorter than one option", () => {
    // A zero-length row would delete the control on precisely the boards where its tooltip explains the block.
    expect(quantityOptionCount(null, 0)).toBe(1);
    expect(quantityOptionCount(0, 0)).toBe(1);
  });

  it("never returns a row too short to select a legal quantity", () => {
    /* Unreachable today, since a finite limit bounds `buyableNow`. It is the guard that keeps a later rule --
       a private power, a variant limit -- from producing a row that cannot express a legal purchase. */
    expect(quantityOptionCount(2, 5)).toBe(5);
  });
});

describe("the panel reads the rule rather than re-deriving it", () => {
  it("sizes the row from quantityOptionCount and greys from the cap", () => {
    /* THE STRUCTURAL HALF, and the failure it guards is how this bug existed: the length was correct-looking
       local arithmetic (`Math.max(1, supplyCap)`) with no name on it, so nothing anywhere said what the row's
       length was supposed to MEAN. A regression would restore that expression, not break this rule. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const panel = fs.readFileSync(
      path.join(__dirname, "..", "components", "TrainPurchasePanel.tsx"),
      "utf8",
    );
    expect(panel).toContain("Array.from({ length: optionCount }");
    expect(panel).toContain("const beyondCap = option > supplyCap;");
    expect(panel).not.toContain("Array.from({ length: Math.max(1, supplyCap) }");
  });

  it("gives the price-only buy button a spoken name", () => {
    /* Design note #722: the visible label is `$600`, which reads correctly ONLY beside the sentence above it.
       A screen reader announces a button on its own, so the accessible name has to carry the verb, the
       quantity and the tier that the eye picks up from the surrounding line. This is the assertion that keeps
       the two in step -- shortening a label is exactly the kind of change that silently drops one. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const panel = fs.readFileSync(
      path.join(__dirname, "..", "components", "TrainPurchasePanel.tsx"),
      "utf8",
    );
    /* The needles drop the leading `${`, for `appNaming.test.ts`'s reason: written in full they are literal
       `${...}` inside a plain string and `no-template-curly-in-string` reads every one as a template the
       author forgot to write. The interpolation is the POINT here, so the rule is sidestepped rather than
       silenced. */
    /* THE NEEDLE USED TO READ ``: `$`` AND THE SOURCE NOW SAYS ``: `Pay $``, which is a rewording this
       assertion was never told about -- the panel's own note above the button records it: "'PAY $600' IS
       BETTER THAN 'BUY FOR $600'... Reported: 'instead of'". The property is unchanged and is the reason this
       line exists at all: THE VISIBLE LABEL CARRIES A PRICE AND NOT THE OBJECT, which is precisely why the
       accessible name below has to spell out the quantity and the tier. */
    expect(panel).toContain('atTrainLimit ? "Train Limit Reached" : `Pay $');
    expect(panel).toMatch(/aria-label=\{\s*atTrainLimit/);
    expect(panel).toContain("from the Bank for $");

    /* THE VERBOSE LABEL, ASSERTED GONE -- and read off a COMMENT-STRIPPED copy, which the first draft of this
       line did not do and failed on. #722's note quotes the string it replaced ("Buy 2 x 4-Train for $600")
       because the quotation is the argument, and a scan over raw source cannot tell an implementation from an
       account of one. #490a's rule, rediscovered by walking into it. */
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("-Train for $");
    // And the note that explains the change survives its own test.
    expect(panel).toContain("-Train for $");
  });
});
