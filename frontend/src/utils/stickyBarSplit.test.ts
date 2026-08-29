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
import { readSource, sliceBetween, stripComments } from "./sourceScan";

// (This file DOES import, so it is a module without an `export {}` -- unlike #779's and #783's harnesses,
// where the empty export was the only thing making them one. Putting one here anyway is what tripped
// `import/first`.)

const read = (relative: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
};
const strip = (raw: string) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

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
/* ==================================================================
    DESIGN NOTE 828: THE FAR BOUNDARY MOVED INSIDE THE REGION IT BOUNDED
   ==================================================================

   This used to end at the Buy Private condition, on the reasoning that it was "the first thing rendered after
   the bar closes". #828 moved the panels INTO the bar, so that condition is now in the middle of the region
   -- and `slice` happily returned the shorter span, over which "neither panel is inside the sticky element"
   was true because neither panel was in the TEXT.

   A GREEN TEST OVER THE WRONG TEXT is the failure this file already records once, in the note above: the
   first draft sliced from `indexOf` and swallowed the whole component. That one failed loudly. This one did
   not, which is worse, and is why the anchor is now something that CANNOT move inside: the fit probe renders
   after the bar closes and its own harness asserts so. */
const STICKY_END = CODE.indexOf("{stickyFitProbe && (");
const sticky = CODE.slice(STICKY_START, STICKY_END);
/* `outside` is GONE with the arrangement it described. Every assertion that used it was about a panel lifted
   past the bar's closing tag, and #828 put both of them back inside -- so the region it named is now the
   probe and the private-powers panel, neither of which this file is about. Deleted rather than left unused:
   ESLint found it, which is the only reason it is not still here as a slice nobody reads. */

describe("the route detail is inside the bar too (design note #855)", () => {
  it("mounts under the chip row that opens it", () => {
    /* REPORTED: "the route information ... opens *below the action panel* in a fixed spot above the rail map.
       This needs to be rendering inside the Action Panel, below the train chips."
       #802 PUT IT IN THE TRAILING FRAGMENT, beside the private-powers panel -- a sibling of the sticky
       element rather than a child of it. So a chip in a travelling bar opened a disclosure that stayed behind.
       #828's own sentence, from the other side: "anything inside it follows".
       NOTHING ASSERTED ITS POSITION. `routeChipDetail.test.ts` checked which props reach it and that the old
       planner panel is gone -- both true wherever it renders. The bug lived in the one property no test had,
       which is why this assertion is here rather than there: this file is the one about what is inside the
       sticky element. */
    expect(sticky).toContain("<RouteChipDetail");
    const chips = sticky.indexOf('aria-label="Drafted routes"');
    const detail = sticky.indexOf("<RouteChipDetail");
    expect(chips).toBeGreaterThan(-1);
    expect(detail).toBeGreaterThan(chips);
  });

  it("leaves nothing of it outside", () => {
    /* THE OTHER HALF, because "inside" and "not also outside" are different claims and a copy left behind
       would satisfy the first. `CODE` is the whole component. */
    expect((CODE.match(/<RouteChipDetail/g) ?? []).length).toBe(1);
  });
});

describe("the panels are back inside the bar, on a measurement (design note #828)", () => {
  /* ==================================================================
      THIS BLOCK ASSERTED THE OPPOSITE, AND WENT ON PASSING WHEN IT STOPPED BEING TRUE
     ==================================================================

     #785 lifted the panels OUT of the sticky element and this file pinned that: "leaves neither inside the
     sticky element ... if either creeps back in, the bar starts unpinning itself again."

     #828 PUT THEM BACK, on the number #813's probe finally produced -- 427px against a 326px budget, with
     101px to find -- and found the 101px in the panel rather than the bar: the depot table folds behind its
     caret when the bar is pinned (#828), leaving a header and the buy row.

     AND THE OLD ASSERTIONS DID NOT NOTICE. `LIFTED_START` anchored on the Buy Private condition, so once that
     condition moved inside the bar the `sticky` slice ended before it and "not inside the sticky element"
     passed over text that no longer contained it. A slice whose boundary moves INTO the region it was
     bounding measures nothing and says so in green. The guard below is the same one this file already had
     for a different boundary -- and it did not cover this case, because it only checked the two anchors were
     ordered, not that the region between them still meant anything.

     WHAT THE FILE IS FOR IS UNCHANGED: the bar must not exceed the budget. What changed is that the budget is
     now met by folding rather than by relocating -- so the assertions move from WHERE the panels are to
     WHETHER the pinned form is small. */

  it("has a sticky region to talk about at all", () => {
    /* The guard on the slice, kept and strengthened. Ordering alone was not enough -- both anchors stayed in
       order while one of them wandered inside -- so the region is also required to contain the thing every
       assertion below is about. */
    expect(STICKY_START).toBeGreaterThan(-1);
    expect(STICKY_END).toBeGreaterThan(STICKY_START);
    expect(sticky).toContain("<div ref={stepPanelRef}");
  });

  it("puts both panels inside it", () => {
    expect(sticky).toContain("<TrainPurchasePanel");
    expect(sticky).toContain("<ProposePrivatePurchase");
  });

  it("no longer folds the depot table, because there is no table (design note #860)", () => {
    /* #828 FOLDED IT TO MAKE THE PANEL FIT and the fit came from somewhere else in the end: #859 gave the
       panel the bar's full width in two columns, and #860 deleted the purchasable-tier table whose three
       facts had all found other homes. A fold is not needed for a section that is half a column tall.
       THE PROPERTY #828 CARED ABOUT SURVIVES and is asserted in `buyTrainsPanel.test.ts`: the only bodies
       still marked `STICKY_OPTIONAL` are the two a player can actually collapse. */
    const panel = read("components/TrainPurchasePanel.tsx");
    expect(panel).not.toContain("setBankOpen");
  });

  it("never folds the buy row", () => {
    /* A caret that can hide the only control on a step can leave a player looking at a step with nothing on
       it. The row sits outside the disclosure. */
    const depot = strip(read("components/TrainPurchasePanel.tsx"));
    const body = depot.slice(depot.indexOf("{bankOpen && ("), depot.indexOf("{nextTier ? ("));
    expect(body).not.toContain("styles.buyRow");
  });

  it("keeps the panels rendering at all", () => {
    /* THE CONTROL. Deleting them would satisfy every assertion above and remove two steps of a turn. */
    /* Design note #915: `&& trainPanelOpen` joined this condition when the bar's Buy Trains button became a
       disclosure. The property here is that the panel RENDERS FROM THIS BAR at all -- #828's subject -- so it
       is asserted as the clause that decides the STEP rather than as the whole expression, which now also
       carries a piece of local view state #828 has no opinion about. */
    expect(CODE).toContain('orStep === "Hardware" && trainPurchase');
    /* Design note #919: `&& privatePanelOpen` joined this when the private jump became a disclosure, exactly
       as #915 did for trains. The property is that the panel renders FROM THIS BAR -- #828's subject -- so it
       is asserted as the clause that decides the step. */
    expect(CODE).toContain('orStep === "BuyPrivate" && privatePurchase');
  });

  it("still condenses the depot with the bar", () => {
    /* Read together, so a condensed bar beside an uncondensed panel would look like a fault -- and #828 makes
       this load-bearing rather than cosmetic: `condensed` is what folds the depot table, which is what keeps
       the bar under #720's budget. */
    expect(sticky).toContain("condensed={condensed}");
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
    expect(CODE).toContain('{mayActThisTurn && orStep === "BuyPrivate" && privatePurchase');
    expect(CODE).toContain('privatePurchase && privatePanelOpen && (');
  });

  it("gates Buy Trains on it", () => {
    /* Design note #915: the gate is unchanged and a fourth clause now follows it. Asserted up to
       `trainPurchase` -- the three conditions #803 is actually about -- and then separately that the toggle
       was ADDED to that gate rather than replacing any of it, which is how this could really regress. */
    expect(CODE).toContain('{mayActThisTurn && orStep === "Hardware" && trainPurchase');
    expect(CODE).toContain('trainPurchase && trainPanelOpen && (');
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

describe("the two progress tracks share a row (design note #920)", () => {
  /* REPORTED: "The corporation turn order in the OR is rendering on the same row as the Action Bar buttons
     and warning badges, creating clutter. Move it to the same row as the subphase order, flush right." */
  const bar = stripComments(readSource("panels/ContextualActionBar.tsx"));

  it("puts the turn order in the progress row", () => {
    expect(bar).toContain("orProgressRow");
    /* #490a: the copy being sliced has had its COMMENTS STRIPPED, so a comment cannot be an anchor -- the
       first draft of this case anchored on "Design note #630" and sliced an empty string, which then
       "contained" nothing and failed for the wrong reason. Anchored on code either side instead.
       ==================================================================
        AND THE END ANCHOR ROTTED ANYWAY, WHICH IS THE SAME MISTAKE ONE STEP OVER
       ==================================================================
       IT WAS `seatOrderTrail`, chosen because that trail rendered AFTER this row. It has since moved INSIDE
       the row -- `{roundType !== "OperatingRound" && seatOrderTrail}` now sits between the round label and
       the sub-phase trail -- so the slice stopped a few lines in and no longer reached the two things this
       case is about. The claim never stopped being true; the window shrank until it could not see it.
       FOUND BY A BLAST-RADIUS SWEEP, not by a run of its own, and it was already red before this batch.
       RE-ANCHORED ON THE NEXT SIBLING BLOCK. `orContextCard` is the corporation card that follows the
       progress row, so the window is the row and nothing but the row -- and it is a LAYOUT landmark rather
       than a piece of conditional content, which is what the old anchor turned out to be. */
    const row = sliceBetween(bar, "styles.orProgressRow", "styles.orContextCard");
    expect(row).toContain("styles.orTurnOrder");
    expect(row).toContain("styles.subPhaseTrail");
  });

  it("takes it out of the button rail it was cluttering", () => {
    /* THE HALF THAT MATTERS. Rendering it in the new row while leaving the old one would show it twice --
       the failure mode a "moved it" change actually has. */
    const leftRail = sliceBetween(bar, "styles.orPanelRailLeft", "styles.orPanelRailRight");
    expect(leftRail).not.toContain("styles.orTurnOrder");
  });

  it("pushes it right with its own margin rather than spacing the row", () => {
    /* `space-between` would centre a lone trail on rounds with no queue; a margin on the order leaves the
       trail left-anchored whether or not the order is there. */
    /* The styles live in `appStyles.ts`, not in the panel -- which the first draft of this case did not
       know, and which is why the `marginLeft` it was asserting had silently landed nowhere. */
    const sheet = stripComments(readSource("styles/appStyles.ts"));
    expect(sliceBetween(sheet, "orTurnOrder: {", "},")).toContain('marginLeft: "auto"');
    /* AND THE ROW ITSELF EXISTS. `styles.orProgressRow` was referenced by the render while being defined in
       no stylesheet at all -- an undefined style object is not a type error and not a runtime error; it is a
       div with no layout, which is exactly what this whole item was trying to fix. */
    expect(sheet).toContain("orProgressRow: {");
  });
});

describe("the turn order is one strip, not eight chips (design note #930)", () => {
  /* REPORTED: "the corporation turn order badges are rendering staggered (uneven vertical alignment) instead
     of in a straight line. Consolidate them: model this component after the subphase sequence UI." */
  const sheet = stripComments(readSource("styles/appStyles.ts"));
  const bar = stripComments(readSource("panels/ContextualActionBar.tsx"));

  it("butts the chips together the way the sub-phase trail does", () => {
    /* THE CONSTRUCTION IS THE FIX. Rounded independent chips have no shared baseline; a strip of butted
       rectangles with collapsed borders does. Asserted against the sub-phase trail's own mechanism so the two
       cannot drift into different answers for one idea. */
    const chip = sliceBetween(sheet, "orTurnOrderChip: {", "},");
    expect(chip).toContain('marginLeft: "-1px"');
    expect(chip).not.toContain("borderRadius");
  });

  it("stops wrapping, which is where the stagger came from", () => {
    const strip = sliceBetween(sheet, "orTurnOrder: {", "},");
    expect(strip).not.toContain("flexWrap");
    /* #590's rule is honoured rather than dropped: nothing decides which corporations a player may see, so
       the strip scrolls instead. */
    expect(strip).toContain('overflow: "auto"');
  });

  it("gives the livery to the active corporation alone", () => {
    /* Eight simultaneous brand colours is what made this a row of unrelated objects rather than a sequence
       with a position in it. Asserted as the ABSENCE of the per-chip colouring as well as the presence of the
       active one, because the two lines sat adjacent and only one was removed. */
    const chips = sliceBetween(bar, "styles.orTurnOrderChip,", "title={");
    expect(chips).not.toContain("borderColor: entry.color,\n                    color: entry.color,");
    expect(chips).toContain("orTurnOrderChipUpcoming");
    expect(chips).toContain("backgroundColor: entry.color");
  });
});

