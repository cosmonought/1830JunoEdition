/** @jest-environment node */

//
// The pinned half of the action bar stays short enough to pin.
//
// ==================================================================
//  DESIGN NOTE 785 (harness): THE BAR UNPINNED ITSELF, AND IT WAS RIGHT TO
// ==================================================================
//
// REPORTED twice: "buy trains is not sticky and does not travel: it is fixed at the top of the screen", and
// the same of Buy Private.
//
// NOT A CSS FAILURE, and I spent a while assuming it was. `styles.actionBar` declares `position: sticky`
// correctly; no ancestor sets an `overflow` -- `html`, `body`, `appRoot` and `canvasPane` all checked. #600
// had already been here, blamed `flex: 1` for giving the pane a zero basis, fixed that, and wrote "NOT
// VERIFIED IN A BROWSER ... if the bar still fails to travel, this is the next thing to disbelieve."
//
// IT WAS #720 DOING ITS JOB. `canPinWithoutTrapping` unpins the bar once it exceeds half the usable viewport,
// because a sticky element taller than that traps the page behind it -- and `actionBarUnpinned` sets
// `position: static`, which sits where it is written and scrolls away. Exactly the reported symptom, from a
// guard working as designed.
//
// THE EVIDENCE WAS IN WHICH PANELS GOT REPORTED. `PrivatePowerPanel` and `RoutePlannerPanel` have always
// rendered past the bar's closing tag and neither was ever reported. The two that were are precisely the two
// that lived inside the sticky element.
//
// WHAT THIS FILE CAN AND CANNOT DO: it cannot measure anything -- there is no layout here. It pins the
// STRUCTURAL claim, which is the one that was wrong: the tall panels are siblings of the sticky element
// rather than children of it. Whether the bar now travels is a playtest question and nothing else.

import { canPinWithoutTrapping, STICKY_MAX_VIEWPORT_SHARE } from "./stickyCollapse";
// (This file DOES import, so it is a module without an `export {}` -- unlike #779's and #783's harnesses,
// where the empty export was the only thing making them one. Putting one here anyway is what tripped
// `import/first`.)

const BAR = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(
    path.join(__dirname, "..", "panels", "ContextualActionBar.tsx"),
    "utf8",
  );
})();

/** #490a: the note above the lifted panels quotes the old arrangement while explaining it. */
const CODE = BAR.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** Where the sticky element ends.
 *
 *  `lastIndexOf` on the ref, deliberately: `actionBarRef` is attached TWICE -- the misplaced-tab redirect
 *  branch returns its own one-button bar. The first draft sliced from `indexOf`, spanned both branches and
 *  swallowed the whole component, so the "nothing tall inside" assertion was searching the file it was
 *  supposed to be excluding a part of. It failed loudly, which is the only reason this note exists.
 *
 *  The lifted panels' own condition is the far boundary -- the first thing rendered after the bar closes. */
const STICKY_START = CODE.lastIndexOf("ref={actionBarRef}");
/* #803 renamed the step test to `orStep`, which is the point of that note: outside an Operating Round the
   derived value is `null`, so a lifted panel cannot accidentally ask an unqualified question. The anchor
   follows the code. */
const LIFTED_START = CODE.indexOf('{mayActThisTurn && orStep === "BuyPrivate"');
const sticky = CODE.slice(STICKY_START, LIFTED_START);
const outside = CODE.slice(LIFTED_START);

describe("the tall panels are outside the measured element", () => {
  it("puts Buy Trains after the bar closes", () => {
    /* THE REPORT, as structure. `PrivatePowerPanel` is the marker for "past the closing tag" -- it has always
       rendered there and was never reported as failing to travel. */
    expect(CODE.lastIndexOf("<TrainPurchasePanel")).toBeGreaterThan(
      CODE.lastIndexOf("</div>\n      ) : ("),
    );
    expect(outside).toContain("<TrainPurchasePanel");
  });

  it("puts Buy Private there too", () => {
    expect(CODE.lastIndexOf("<ProposePrivatePurchase")).toBeLessThan(
      CODE.lastIndexOf("<PrivatePowerPanel"),
    );
  });

  it("has a sticky region to talk about at all", () => {
    /* The guard on the slice above. If either boundary moves or disappears, `slice` quietly returns something
       and every assertion below passes over the wrong text -- which is exactly what the first draft did. */
    expect(STICKY_START).toBeGreaterThan(-1);
    expect(LIFTED_START).toBeGreaterThan(STICKY_START);
  });

  it("leaves neither inside the sticky element", () => {
    /* THE ASSERTION THAT MATTERS. If either creeps back in, the bar starts unpinning itself again and the
       symptom returns looking like a fresh CSS bug -- which is how it read the first two times. */
    expect(sticky).not.toContain("<TrainPurchasePanel");
    expect(sticky).not.toContain("<ProposePrivatePurchase");
  });

  it("keeps the panels rendering at all", () => {
    /* THE CONTROL. Deleting them would satisfy every assertion above and remove two steps of a turn. */
    expect(CODE).toContain('orStep === "Hardware" && trainPurchase && (');
    expect(CODE).toContain('orStep === "BuyPrivate" && privatePurchase && (');
  });

  it("still condenses the depot with the bar", () => {
    // Read together, so a condensed bar beside an uncondensed panel would look like a fault.
    expect(outside).toContain("condensed={condensed}");
  });
});

describe("the guard that produced the symptom is untouched", () => {
  it("still unpins a bar that would trap the page", () => {
    /* #785 does not weaken #720 -- it removes the reason the bar kept tripping it. A 400px bar in an 800px
       viewport is still exactly the case that guard exists for. */
    expect(canPinWithoutTrapping(500, 800, 0)).toBe(false);
  });

  it("pins an ordinary control strip", () => {
    // ~50px of controls against 800: the case #720 says is untouched, and now the only case the bar is in.
    expect(canPinWithoutTrapping(52, 800, 0)).toBe(true);
  });

  it("keeps the half-viewport rule as the threshold", () => {
    /* Pinned as a figure because the note argues for it specifically: "past half the screen the content is
       the passenger". A later tweak should have to disagree with that sentence on purpose. */
    expect(STICKY_MAX_VIEWPORT_SHARE).toBe(0.5);
  });

  it("still sticks when it cannot measure", () => {
    // #720: an unmeasured panel behaves exactly as it did pre-#720, which is the change that cannot regress.
    expect(canPinWithoutTrapping(0, 0, 0)).toBe(true);
  });
});

describe("no inner scrollbar was reached for", () => {
  it("adds no overflow to the bar", () => {
    /* TWICE REJECTED ALREADY and worth pinning: #13/item 1 removed `overflow: auto` from the panes as
       "exactly the inner scrollbar this item asks to eliminate", and #655 found a `maxHeight` on this very
       bar was "the bug it warned about". A third attempt would be the obvious way to make a tall panel fit. */
    expect(sticky).not.toContain("overflowY");
    expect(sticky).not.toContain("maxHeight");
  });
});

describe("the lifted panels kept the gate their nesting used to give them (design note #803)", () => {
  /* REPORTED as a regression from #785: "now in the Stock Round following the transition to Phase 3, the
     'Purchase a Private Company' subpanel shows up under the player Action bar ... it shows that the last
     corporation that operated is now proposing a purchase."

     THE PANELS USED TO BE NESTED INSIDE THE OPERATING ROUND BRANCH, so `roundType === "OperatingRound"` was
     true by construction and their own conditions never said it. Lifting them out to stop the bar unpinning
     itself took that away, and nothing failed -- an unqualified `orSubPhase === "BuyPrivate"` compiles, reads
     correctly, and is wrong only in a round nobody was testing.

     AND THE SECOND SENTENCE OF THE REPORT IS THE MECHANISM. `settleOperatingCursor` clears
     `operating_sub_phase` outside an Operating Round, so the shell falls back to `liveOrSubPhase` -- local
     state still pointing at the last corporation's step. The panel was not confused about the round; it was
     reading a cursor that had been left behind. */

  it("derives a step that is null outside an Operating Round", () => {
    expect(CODE).toContain(
      'const orStep = roundType === "OperatingRound" ? orSubPhase : null;',
    );
  });

  it("gates Buy Private on it", () => {
    expect(CODE).toContain('{mayActThisTurn && orStep === "BuyPrivate" && privatePurchase && (');
  });

  it("gates Buy Trains on it", () => {
    expect(CODE).toContain('{mayActThisTurn && orStep === "Hardware" && trainPurchase && (');
  });

  it("leaves no lifted panel testing the raw cursor", () => {
    /* THE ASSERTION THAT WOULD HAVE CAUGHT THIS. Every step test past the bar's closing tag must ask the
       qualified question -- not because the author will remember, but because `orStep` is the only value
       available to ask with. */
    const lifted = CODE.slice(CODE.indexOf("<div ref={stepPanelRef}"));
    expect(lifted).not.toContain("orSubPhase ===");
  });

  it("keeps the route strip's own round gate", () => {
    // #802's strip was written with `showRouteReadout`, which had the round in it from the start.
    expect(CODE).toContain(
      'const showRouteReadout = roundType === "OperatingRound" && orSubPhase === "Routes";',
    );
  });
});
