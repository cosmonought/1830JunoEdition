/** @jest-environment node */
//
// The one exception to #718, and the spectator row. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 738/739 (harness): ADDING BACK, ON PURPOSE
// ==================================================================
//
// REQUESTED, two exceptions to earlier removals:
//   (a) "it is normal in a game of 18xx to see/watch rivals set their routes ... every player's Action bar
//       should show the color-coded train chips as well as the routes on the map and the revenue for each and
//       total?"
//   (b) "when a player Pays Dividends ... it might be worth reintroducing a player-specific toast."
//
// THESE ARE EXCEPTIONS, NOT REVERSALS, and the tests are written to keep them that way. #718 removed toasts
// because they had been attached to a funnel that saw every dispatch; #691 removed the route chips because
// they were CONTROLS on a screen that could not use them. Both removals were right. What is added back is
// narrower than what was taken away, and the assertions below are mostly about the narrowness -- how often
// the toast stays silent, and that the spectator row carries no controls.
//
// THE SILENCES DISCRIMINATE. A dividend notification that fired for every declaration in a four-player game
// would be #718's toast flood wearing a different hat, and it would pass any test that only checked the
// paid case.

import { dividendReceipt } from "./dividendReceipt";

/* Design note #795: `amount` is now an INPUT rather than something this module works out. It used to compute
   `perShare * (viewerPercentage / 10)` and its own comment called that "deliberately duplicated in shape
   rather than in source" -- a third implementation of a figure the reducer already spends, and the one that
   ended up on screen quoting a wrong number. The fixture keeps the pair consistent (20% of $27 is $54) so
   every case below still reads as one coherent payout. */
const BASE = {
  ticker: "C&O",
  distribute: true,
  perShare: 27,
  viewerPercentage: 20,
  amount: 54,
  cashBefore: 412,
};

describe("a shareholder is told what arrived", () => {
  it("names the corporation, the per-share figure and the amount", () => {
    const receipt = dividendReceipt(BASE);
    expect(receipt?.headline).toContain("C&O");
    expect(receipt?.headline).toContain("$27 per share");
    // 20% is two shares at $27.
    expect(receipt?.amount).toBe(54);
    expect(receipt?.headline).toContain("$54");
  });

  it("shows the treasury transition beneath it", () => {
    expect(dividendReceipt(BASE)?.transition).toBe("$412 → $466");
  });

  it("reports the amount it was given, whatever the holding", () => {
    /* THIS TEST USED TO PROVE THE ARITHMETIC and now proves the opposite property, which is the point of
       #795: the module no longer works the figure out, so "scales with the holding" is not its job any more
       -- it is `dividendSplit`'s, and `holdingCapBadge`/`watcherVisibility` check it there against the cash
       the reducer actually moved.
       WHAT IS LEFT TO GUARD HERE is that the amount is passed through untouched. A module that quietly
       adjusted it would be the third implementation coming back. */
    expect(dividendReceipt({ ...BASE, viewerPercentage: 10, amount: 27 })?.amount).toBe(27);
    expect(dividendReceipt({ ...BASE, viewerPercentage: 60, amount: 162 })?.amount).toBe(162);
    expect(dividendReceipt({ ...BASE, viewerPercentage: 60, amount: 162 })?.headline).toContain("$162");
  });
});

describe("it stays silent far more often than it fires", () => {
  it("says nothing on a withhold", () => {
    /* The money goes to the corporate treasury and no player's hand moves -- so there is nothing for a
       player-specific notification to be about. */
    expect(dividendReceipt({ ...BASE, distribute: false })).toBeNull();
  });

  it("says nothing to a player holding no shares", () => {
    /* THE ONE THAT KEEPS THIS FROM BEING A FLOOD. In a four-player game most declarations pay most players
       nothing, and a toast reading "$0" on each of them is the noise #718 removed. */
    expect(dividendReceipt({ ...BASE, viewerPercentage: 0, amount: 0 })).toBeNull();
  });

  it("says nothing when the corporation earned nothing", () => {
    expect(dividendReceipt({ ...BASE, perShare: 0, amount: 0 })).toBeNull();
  });

  it("says nothing when a rounded share comes to zero", () => {
    /* 1830 floors the per-share figure, so a corporation earning under $10 pays $0 a share. A receipt for
       nothing is worse than silence -- it interrupts to report an absence. */
    expect(dividendReceipt({ ...BASE, perShare: 0, viewerPercentage: 20 })).toBeNull();
  });
});

describe("an unknown balance loses the second line, not the first", () => {
  it("keeps the headline and drops the transition", () => {
    /* #670's rule: a figure with a guess on one end is worse than no figure. The amount is still in the
       headline, so the toast is never empty. */
    const receipt = dividendReceipt({ ...BASE, cashBefore: null });
    expect(receipt?.transition).toBeNull();
    expect(receipt?.headline).toContain("$54");
  });
});

describe("the toast is raised where every client runs, and the row carries no controls", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  };

  it("fires on the dispatch path rather than at the declare button", () => {
    /* Design note #738. The button exists only on the president's client; a dividend's whole point is that it
       reaches players who are not acting. Raising it in `runGameplayAction` means a remote action replayed
       with `isRemoteReplay: true` announces itself exactly as a local one does. */
    const app = read("App.tsx");
    expect(app).toContain('if (after && "DeclareDividends" in msg && options?.derived !== true)');
  });

  it("excludes a derived declaration", () => {
    // #668: an auto-declared $0 withhold is the game acting, and it pays nobody in any case.
    expect(read("App.tsx")).toContain('options?.derived !== true');
  });

  it("gives spectators information, not disabled buttons", () => {
    /* ==================================================================
        DESIGN NOTE 815 REPLACED THE ROW THIS USED TO ASSERT
       ==================================================================

       #739's rule is intact and its implementation is not. It split the Run Routes chips into two rows -- the
       president's live one and a static twin for everybody else -- "because a disabled control invites the
       reader to wonder what they did wrong; a plain span says 'this is information'."

       #815 MERGED THEM, on a report that the chips carrying revenue neither opened a route nor survived the
       bar docking. There is one row now, and #739's rule is kept a better way than by a second component:
       nothing on it is disabled for ANYONE, because opening a readout dispatches nothing. A watcher gets a
       live control that does the one thing a watcher wants.

       THIS ASSERTION SURVIVED #815 BY NOT BEING RUN. Same miss as `dhPower.test.ts` after #809: the suites I
       ran were the ones I had just edited, and a harness for a rule can outlive the code it was checking
       while still passing on the day it was written. */
    const bar = read("panels/ContextualActionBar.tsx");
    expect(bar).not.toContain('!mayActThisTurn && orSubPhase === "Routes"');
    expect(bar).toContain('{orSubPhase === "Routes" && trainDrafts.length > 0 && (');
    expect(bar).toContain('aria-label="Drafted routes"');
    // The rule itself: no greyed chip for a viewer whose only use of the row is to read it.
    const row = bar.slice(
      bar.indexOf('{orSubPhase === "Routes" && trainDrafts.length > 0 && ('),
      bar.indexOf("styles.spectatorTotal"),
    );
    expect(row).not.toContain("disabled={!sessionReady}");
  });

  it("shows the total the report asked for, and only when it means something", () => {
    /* On a one-train corporation a total beside the single value would be the same number printed twice. */
    const bar = read("panels/ContextualActionBar.tsx");
    expect(bar).toContain("trainDrafts.filter((draft) => draft.value !== null).length > 1");
  });
});
