/** @jest-environment node */

// No runtime imports: this file reads source text.
export {};
//
// The rule predicates reach the buttons that ask them.
//
// ==================================================================
//  DESIGN NOTE 799 (harness): DECLARED THREE TIMES, PASSED NEVER
// ==================================================================
//
// REPORTED: "P1 is at max certificate limit for B&O, but when they open the B&O corp card on a Stock Round,
// the Buy 1 Share button is not grayed out. When they click it, the activity log correctly REFUSED the
// action."
//
// THE PANEL AND THE REDUCER NEVER DISAGREED. `purchaseBlockFor` was declared on `StockRoundPanelProps`, on
// `CorporationRosterProps` and on `CompanyActionsProps`; the roster forwarded it to the actions; `App` handed
// it to the panel. The panel never destructured it and never passed it on. `CompanyActions` called
// `purchaseBlockFor?.(...) ?? null` and got `null` -- which an optional callback returns whether the rule
// permits the purchase or the rule was never wired.
//
// I WROTE THE WRONG DIAGNOSIS TWICE. #778's phantom purchase in the log and #784's "no notification that the
// player was at certificate limit" both came from this, and I recorded both as a panel/reducer disagreement,
// hypothesising a stale `gameState`. They agreed all along; one of them was never asked.
//
// WHICH IS WHY THIS FILE IS ABOUT THREADING RATHER THAN ABOUT THE RULE. `sharePurchase.test.ts` already
// proves the predicate is right. What nothing checked was whether the answer arrives -- and a missing
// optional prop is invisible to `tsc`, silent at runtime, and indistinguishable from a rule that does not
// fire. The only instrument that can see it is a scan for the wiring itself.

const PANEL = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(
    path.join(__dirname, "..", "components", "StockRoundPanel.tsx"),
    "utf8",
  );
})();

const CODE = PANEL.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** The three callbacks `App` resolves because they need the roster, the private list or the chart. */
const INJECTED = ["purchaseBlockFor", "saleBlockFor", "salePriceAfter"] as const;

describe("every injected rule reaches the control that asks it", () => {
  it.each(INJECTED)("destructures %s from props", (name) => {
    /* THE HOP THAT WAS MISSING. Declaring it on the interface satisfies `tsc`; taking it out of `props` is
       what makes it exist at runtime. */
    const signature = CODE.slice(
      CODE.indexOf("export function StockRoundPanel({"),
      CODE.indexOf("}: StockRoundPanelProps)"),
    );
    expect(signature).toContain(`${name},`);
  });

  it.each(INJECTED)("hands %s to the roster", (name) => {
    const rosterCall = CODE.slice(
      CODE.indexOf("<CorporationRoster"),
      CODE.indexOf("<CorporationRoster") + 1800,
    );
    expect(rosterCall).toContain(`${name}={${name}}`);
  });

  it.each(INJECTED)("forwards %s to the actions", (name) => {
    const actionsCall = CODE.slice(
      CODE.indexOf("<CompanyActions"),
      CODE.indexOf("<CompanyActions") + 1400,
    );
    expect(actionsCall).toContain(`${name}={${name}}`);
  });
});

describe("the Buy button consults the answer", () => {
  it("asks the predicate", () => {
    expect(CODE).toContain("purchaseBlockFor?.(company.company_id, source,");
  });

  it("disables on a block", () => {
    /* THE REPORT, as the property. With the prop wired, `purchaseBlock` is a sentence and the button greys;
       without it, `?? null` reads as permission. */
    expect(CODE).toContain("disabled={controlsDisabled || cannotAfford || purchaseBlock !== null}");
  });

  it("greys as well as disabling", () => {
    // #466: `disabled` alone leaves a button at full contrast that silently refuses the click.
    expect(CODE).toContain("styles.actionButtonDisabled");
  });
});

describe("the sell side had the identical hole", () => {
  it("wires both sale callbacks too", () => {
    /* Nobody has reported the sell side, which is not evidence that it worked -- it had the same two missing
       hops, found only because the buy side was traced. Fixed together rather than waiting for the report. */
    expect(CODE).toContain("saleBlockFor={saleBlockFor}");
    expect(CODE).toContain("salePriceAfter={salePriceAfter}");
  });

  it("leaves the reducer's own gates alone", () => {
    /* THE HALF THAT ALWAYS WORKED. #712's reducer enforcement is what refused the purchase and wrote the
       REFUSED line; this pass adds nothing to it and must not have quietly weakened it. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const reducer = fs.readFileSync(path.join(__dirname, "sandboxSession.ts"), "utf8");
    expect(reducer).toContain("const blocked = sharePurchaseBlock({");
    expect(reducer).toContain("shareSaleBlock");
  });
});
