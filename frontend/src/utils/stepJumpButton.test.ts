/** @jest-environment node */

// No runtime imports: this file reads source text. `export {}` makes it a module for `--isolatedModules`.
export {};
import { readSource, stripComments } from "./sourceScan";

//
// The sticky bar offers the step before it offers the exit.
//
// ==================================================================
//  DESIGN NOTE 792 (harness): A BAR WHOSE ONLY OFFER WAS "END TURN"
// ==================================================================
//
// REPORTED: "During the Buy Trains action, there is no 'Buy Trains' button on the sticky to scroll them to
// the subpanel. The only button on the sticky Action Bar is 'End Turn,' which signals the wrong thing to a
// player who has to buy a train this subphase."
//
// THE SHARPER HALF IS THE SECOND SENTENCE. #293 disables End Turn while a corporation is trainless -- so a
// player who MUST buy saw one greyed button and no route to the thing they had to do. A bar whose only offer
// is an exit reads as "you are finished here" at the one moment that is least true.
//
// THIS BUTTON HAS BEEN ADDED AND REMOVED BEFORE, AND BOTH DECISIONS WERE RIGHT. #491 added a jump because the
// purchase panel sat below a sticky bar and scrolled away. #508 removed the CAUSE instead, moving the panel
// inside the bar -- "sticky by inheritance, with nothing to jump to" -- and deleted the button as redundant.
// Then #720 taught the bar to unpin itself past half the viewport, which the depot reliably triggers, and
// #785 moved the panel back out. The premise "already on screen" stopped being true, so the jump is earned
// again rather than merely restored.
//
// #263'S OBJECTION SURVIVES AND DOES NOT APPLY. "Two controls for one outcome" is about two ways to BUY; this
// dispatches nothing and its label names a destination. A test below pins that distinction, because it is the
// thing a future reader would most reasonably challenge.
//
// ==================================================================
//  DESIGN NOTE 793: NO ARROW, BECAUSE THE BUTTON CANNOT KNOW
// ==================================================================
//
// REPORTED: "Since the auto scroll is going to be taking players up, should it be an up arrow rather than a
// down arrow? I'm not sure why you added an arrow at all tbh, just clicking the button to auto scroll to the
// panel seems adequate?"
//
// THE QUESTION ANSWERS ITSELF AND THE ANSWER IS NEITHER. The panel sits below the bar in DOCUMENT order and
// anywhere at all relative to the VIEWPORT -- which is the only direction a player experiences. A player who
// has scrolled down to the board is scrolled PAST it; one at the top of the page is above it. The glyph was a
// surface asserting something it did not have the information to assert, which is the shape of most of the
// bugs found today.
//
// I ADDED IT TO ANSWER #263, and it was the wrong instrument for that too: the worry was that "Buy Trains"
// might read as a second buy control, and what actually distinguishes them is that the panel's button carries
// a tier and a price while this one carries neither, plus a `title` that says it scrolls. Prose can hedge a
// direction; an arrowhead cannot.

const BAR = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(
    path.join(__dirname, "..", "panels", "ContextualActionBar.tsx"),
    "utf8",
  );
})();

/** #490a: three notes quote the removed button while explaining its removal and its return. */
const CODE = BAR.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const hardwareCase = CODE.slice(CODE.indexOf('case "Hardware":'), CODE.indexOf('case "Hardware":') + 1400);
const privateCase = CODE.slice(CODE.indexOf('case "BuyPrivate":'), CODE.indexOf('case "Tokens":'));

describe("the Hardware step offers the panel, not only the exit", () => {
  it("has a jump button", () => {
    expect(hardwareCase).toContain('key: "go-to-trains"');
  });

  it("puts it before End Turn", () => {
    /* AN OBLIGATION BEFORE AN EXIT. Order is the whole point of the report -- the bar was not missing a
       control so much as leading with the wrong one. */
    expect(hardwareCase.indexOf('key: "go-to-trains"')).toBeLessThan(
      hardwareCase.indexOf('key: "end-turn"'),
    );
  });

  it("says Buy Trains whether or not one is compulsory", () => {
    /* #793 collapsed the two labels into one. The first draft varied it -- "Buy Trains" when compulsory,
       "Trains" otherwise -- which made the button change wording for a reason the player could not see, and
       #293's greying of End Turn beside it already carries the obligation. The `title` says the rest.
       DESIGN NOTE 915 GAVE IT A SECOND LABEL, and the rule above survives that: it varies by whether the
       panel is OPEN -- a state the player can see and just caused -- and still not by `mustBuyTrain`, which
       they cannot. That distinction is the whole of what this case was protecting. */
    expect(hardwareCase).toContain('trainPanelOpen ? "Hide Trains" : "Buy Trains"');
    expect(hardwareCase).not.toContain('mustBuyTrain ? "Buy Trains');
    expect(hardwareCase).toContain("This corporation must own a train.");
  });

  it("does not offer a jump with no panel to jump to", () => {
    // `trainPurchase` is what renders the panel. A button pointing at nothing is worse than no button.
    expect(hardwareCase).toContain("...(trainPurchase");
  });

  it("keeps End Turn and its refusal intact", () => {
    /* THE CONTROL. #293: 1830 has no branch where a trainless corporation simply ends its turn, and this pass
       must not have quietly made one. */
    expect(hardwareCase).toContain("disabled: mustBuyTrain");
  });
});

describe("Buy Private gets the same treatment", () => {
  it("has a jump button of its own", () => {
    /* Reported one round earlier and in the same terms: "the issue with the Action Bar during the Buy Trains
       subphase is also a problem during Buy Private Company." */
    expect(privateCase).toContain('key: "go-to-privates"');
  });

  it("offers nothing when that panel is absent", () => {
    expect(privateCase).toContain("privatePurchase");
    expect(privateCase).toContain(": [];");
  });
});

describe("a jump is not an action", () => {
  it("scrolls rather than dispatching", () => {
    /* #263'S OBJECTION, ANSWERED. Every jump calls a scroller and none is wired to a handler that buys or
       lays anything -- so there is one control per outcome and one signpost to it.
       #831 ADDED A THIRD, to the map. It is the same kind of control and the same greying rule, which is what
       answers the doubt raised with the request: "sometimes a grayed out button means an action can't be
       taken, but here it means 'Resolve this action elsewhere'." It does not -- it means pressing it would
       do nothing, because the destination is already on screen. */
    /* Design note #915: ONE, not two. The Buy Trains control is a disclosure now -- it toggles the panel and
       scrolls only on the way OPEN -- so its scroll is inside a callback rather than being the whole handler.
       The private-purchase jump is unchanged and is the one this still counts.
       THE PROPERTY IN THIS CASE'S NAME IS UNTOUCHED: no jump dispatches. That is asserted below, across all
       three controls, rather than by the shape of one handler. */
    /* Design note #919: ZERO now, not one. Both step jumps are disclosures -- #915 for trains, #919 for
       privates -- so neither is a bare scroll handler any more; each scrolls only on the way OPEN, from
       inside its toggle. Counted at zero rather than deleted, because a bare `onClick: scrollToStepPanel`
       reappearing would mean one of the two had been reverted to a submission-shaped button. */
    expect(CODE.match(/onClick: scrollToStepPanel/g)?.length ?? 0).toBe(0);
    expect(CODE.match(/if \(!open\) scrollToStepPanel\(\);/g)?.length).toBe(2);
    /* THE ORIGINAL #263 CLAIM, RE-ASSERTED DIRECTLY. None of these controls is wired to a buy or a lay --
       which is what "a jump is not an action" means, and it stayed true when one of them became a toggle. */
    expect(CODE).not.toContain("onClick: onBuyFromBank");
    expect(CODE).not.toContain("onClick: onProposeTrade");
    /* Design note #888: was `expect(CODE).toContain("onClick: goToMap,");`. The press now does two things --
       travel, then frame -- so the assertion moved to `layTrackJump.test.ts`, which pins BOTH and their
       order. What this file still guards is the property in its own name: the click is navigation and
       framing, and nothing on this bar dispatches (#263). */
    expect(CODE).toContain("goToMap();");
    expect(CODE).toContain("onFrameNetwork?.();");
  });

  it("gives the Lay Track step the jump it lacked", () => {
    /* REPORTED: "it's the one panel that doesn't have a clear action button when it's one of the more
       consequential actions of the whole game." The map IS that step's panel; it was simply owned elsewhere. */
    expect(CODE).toContain('key: "go-to-map"');
    /* Design note #888: was `disabled: mapInView,`. The button still exists and still belongs to this step;
       what it points AT changed, and the greying rule it obeys is asserted in "keeps the greying on one
       channel" below rather than twice here. */
    expect(CODE).toContain("disabled: !canFrameNetwork,");
  });

  it("says Lay 1 Track and could never say two (design note #834)", () => {
    /* #832 BUILT THE COUNT AND #834 WITHDREW IT, on the instruction of the person who asked for it: "There
       should actually never be a 'Lay 2 Track' button because a 'second' track lay is ONLY provided by the
       special power of a private company, for which we've already built a modal. The Action Bar should be
       used for the standard actions, let's leave the Special Powers where they are without trying to display
       them again."
       A LITERAL RATHER THAN A PROP PINNED AT 1. A `trackLays` whose only reachable value is one is #788's
       unreachable arm wearing a variable -- and the next reader would take it for a quantity that varies.
       "LAY 0 TRACK" REMAINS UNREACHABLE. `layEndsTrackStep` is `!isBonusLay`, so an ordinary lay ends the
       step and takes the button with it; and an Undo back into Track has reversed the lay it undid. */
    expect(CODE).toContain('label: "Lay 1 Track"');
    expect(CODE).not.toContain("trackLays");
    expect(CODE).not.toContain("Lay 0 Track");
  });

  it("keeps the greying on one channel", () => {
    /* THE ANSWER TO THE DOUBT RAISED THREE REPORTS AGO about greyed buttons meaning two things. `disabled` is
       `mapInView` and nothing else, so greyed means "pressing this would not move you" and never "you may
       not lay track" -- that refusal lives on the hex (#716). */
    /* ==================================================================
        DESIGN NOTE 888: THE CHANNEL IS THE RULE; `mapInView` WAS ONE IMPLEMENTATION OF IT
       ==================================================================
       THIS ASSERTED `disabled: mapInView,` and the paragraph above explains what it was protecting: that
       greyed means ONE thing on this button. `mapInView` is gone -- it answered "is a quarter of the pane on
       screen", which is what made the button useless at the top of the page -- and the rule it served is
       unchanged, so the assertion follows the rule rather than the variable.
       THIS TEST EARNED ITS KEEP ON THE WAY THROUGH. The first draft of the replacement greyed the button
       with "No hex is open to this corporation right now", which is a LEGALITY sentence on a navigation
       control -- the exact second meaning this block exists to keep off the channel. It failed here and the
       copy was corrected. */
    const mapCase = CODE.slice(CODE.indexOf('key: "go-to-map"'), CODE.indexOf('case "BuyPrivate":'));
    expect(mapCase.length).toBeGreaterThan(0);
    expect(mapCase).toContain("disabled: !canFrameNetwork,");
    expect(mapCase.match(/disabled:/g)?.length).toBe(1);
    /* THE SENTENCE IS ABOUT MOVEMENT, NOT ABOUT LEGALITY. A greyed jump may say "there is nowhere to go";
       it may never say "you may not build here", which is the hex's answer to give. */
    expect(mapCase).toContain("Nothing to show on the map yet.");
    expect(mapCase).not.toContain("No hex is open");
  });

  it("takes a player on another tab to the map rather than nowhere (design note #833)", () => {
    /* THE HOLE #833 CLOSED, and the reason the button is not simply greyed when the map is absent: with no
       element there is nothing to intersect, so `mapInView` is false and the control looks live. A live
       control that does nothing is the exact outcome #797's greying rule exists to prevent. */
    expect(CODE).toContain("onShowMap?.()");
    expect(CODE).toContain("setMapJumpPending(true)");
  });

  it("moves the rotation rule off the bar (design note #835)", () => {
    /* #279 kept "Select a hex on the map to lay or upgrade track" because "it says where the action IS, which
       the player cannot otherwise know", and #831 trimmed it to the rotation half.
       REPORTED: "there's a character string: 'Click a laid preview to rotate it.' This should be in the
       tutorial, not printed on the Action Bar." A rule of the interface, true every Operating Round forever,
       which is #800's test for tutorial prose. The tutorial assertion below is what stops this from being a
       deletion. */
    expect(CODE).not.toContain("Select a hex on the map to lay or upgrade track");
    expect(CODE).not.toContain("rotate it.");
    expect(CODE).toContain("Click a hex on the Rail Map to lay track.");
  });

  it("puts that line under the buttons rather than beside them", () => {
    /* ASKED FOR AS A POSITION: "maybe BELOW the 'Lay 1 Track' and 'Skip Track' buttons". The row wraps, so a
       hint rendered first sat to the LEFT of the controls it describes -- which is where #279 left it.
       BOTH HALVES, because either alone passes while the other is wrong: the style key claims the full row,
       and the source order puts it after Skip. */
    expect(CODE).toContain("styles.orPanelStepHint");
    expect(CODE.indexOf("Skip {OPERATING_SUB_PHASE_LABELS")).toBeLessThan(
      CODE.indexOf("Click a hex on the Rail Map to lay track."),
    );
  });

  it("shows the hint only where it costs no map (design note #870)", () => {
    /* ==================================================================
        REPORTED: "this eats up some vertical space that is needed for viewing the map"
       ==================================================================
       #835 GATED THIS ON THE STEP AND THE TURN AND NOTHING ELSE, so a bar stuck to the top of the viewport
       carried a full-width orientation row over the board. `orPanelStepHint` claims `flexBasis: 100%`, so it
       is a whole line of map spent naming a destination the player has already arrived at.
       `!mayPin` IS THE PROPERTY, not `!condensed`: a bar that may pin travels and covers the viewport's top;
       one that may not is `position: static` (#720), parked above the map, where an extra line is free.
       `condensed` would have worked and then flickered -- it means "has stuck and travelled", so the row
       would vanish mid-scroll rather than being a property of the bar's shape. */
    const at = CODE.indexOf("Click a hex on the Rail Map to lay track.");
    expect(at).toBeGreaterThan(-1);
    /* THE GUARD IS ON THE SAME CONDITION, read backwards from the sentence to the `{` that opens it -- an
       assertion that merely found `!mayPin` anywhere in the file would pass on the two style lines that
       already use it. */
    const opens = CODE.lastIndexOf("{mayActThisTurn", at);
    expect(opens).toBeGreaterThan(-1);
    const condition = CODE.slice(opens, at);
    expect(condition).toContain('orSubPhase === "Track"');
    expect(condition).toContain("!mayPin");
  });

  it("leaves the button's label alone (design note #870)", () => {
    /* THE PROPOSAL THAT WAS WITHDRAWN. The report opened with "What if we updated the button to 'Select a Hex
       to Lay 1 Track' or something?" and then withdrew it -- "no change needed" -- once the hint's missing
       gate turned out to be the whole fault. Recorded because a label change that never happened is exactly
       the kind of thing that gets half-applied later. #834's constant stands. */
    expect(CODE).toContain('label: "Lay 1 Track"');
    expect(CODE).not.toContain("Select a Hex to Lay");
  });

  it("keeps the rotation rule somewhere", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const tutorial = fs.readFileSync(
      path.join(__dirname, "..", "components", "TutorialModal.tsx"),
      "utf8",
    );
    // #490a in reverse: the bar's note QUOTES the sentence while explaining its removal, so `CODE` above is
    // comment-stripped and this reads the file that is supposed to have it for real.
    expect(tutorial).toContain("click the laid preview again to ROTATE it");
    expect(tutorial.indexOf("click the laid preview again to ROTATE it")).toBeGreaterThan(
      tutorial.indexOf("OPERATING_ROUND_TUTORIAL"),
    );
  });

  it("names the destination rather than the purchase", () => {
    /* The label says where it goes, and the `title` says what it does. What keeps this from reading as a
       second buy control is that the panel's own button carries a tier and a price and this one carries
       neither -- not, as the first draft had it, a glyph. */
    expect(CODE).toContain('"Hide Trains" : "Buy Trains"');
    // Design note #919: the private jump became a toggle too, and its label names the same destination.
    expect(CODE).toContain('"Hide Privates" : "Buy Private Company"');
    expect(CODE).not.toContain('"Buy a Train"');
  });

  it("claims no direction", () => {
    /* Design note #793. The panel is below the bar in DOCUMENT order and anywhere relative to the VIEWPORT,
       so an arrow states something the button cannot know -- and the viewport is the only direction a player
       experiences. Asserted as an absence because a glyph is exactly the kind of thing that gets added back
       as a decoration. */
    expect(CODE).not.toContain("\\u2193");
    expect(CODE).not.toContain("\\u2191");
    expect(CODE).not.toMatch(/[↑↓]/);
  });

  it("leaves the direction to prose that can hedge it", () => {
    // "below" in a sentence is a document-order statement a reader can interpret; an arrowhead is not.
    /* Design note #915: the trains control expands rather than scrolls, so its prose changed verb and kept
       the hedge. The private jump still scrolls and still says so -- which is why both are asserted: the
       property is about the WORDS carrying the direction, not about which verb is in them. */
    /* Design note #919: both controls expand rather than scroll now, and both kept the hedge. The property
       is that the WORDS carry the direction -- "below" is a document-order statement a reader can interpret,
       an arrowhead is not -- and it survives the verb changing under it. */
    expect(CODE).toContain("Expands the Buy Trains panel below.");
    expect(CODE).toContain("Collapse the Buy Trains panel below.");
    expect(CODE).toContain("Expands the Buy Private Company panel below.");
    expect(CODE).toContain("Collapse the Buy Private Company panel below.");
  });

  it("scrolls to the top of the panel, below the bar", () => {
    /* ==================================================================
        DESIGN NOTE 810: BOTH ALIGNMENTS WERE WRONG, FOR ONE REASON
       ==================================================================

       REPORTED: "the auto-scroll 'works,' but the Action Bar covers the actual Buy Trains subpanel, so
       players who click it may still be confused what they need to do. Can you have it scroll all the way to
       the top of the subpanel, below the Action Bar?"

       THIS ASSERTION USED TO SAY THE OPPOSITE AND ITS REASONING IS WORTH KEEPING: "`block: "nearest"` rather
       than `"start"`: under a sticky bar, `start` tucks the panel's heading behind it, and on a short page
       `nearest` correctly does nothing at all." The first clause is true of a bare `scrollIntoView`. The
       second is the part that did not survive contact: `nearest` stops as soon as ANY of the panel is on
       screen, which is usually with the heading behind the bar -- so it dodged the problem into a different
       corner rather than out of the room.
       NEITHER KNEW THE BAR'S HEIGHT, which is the actual missing input, and `scroll-margin-top` is the
       feature that supplies it. With the margin on the element, `start` means "start, below the bar". */
    expect(CODE).toContain('block: "start"');
    expect(CODE).not.toContain('block: "nearest"');
  });

  it("carries the clearance on the destination rather than the call", () => {
    /* Stated once, where the element is. `scroll-margin-top` is honoured by every scroll into this element,
       including ones no call site here knows about -- a browser restoring a scroll position, a future
       `:target` link -- so a caller cannot forget the bar exists.
       DESIGN NOTE 831 MOVED IT OFF THE JSX. With a second destination owned by a different component, an
       inline style would have made the map's owner responsible for this bar's height. The hook writes it to
       whatever target it is handed, which is #810's own argument applied to two targets instead of one. */
    const dollar = String.fromCharCode(36);
    expect(CODE).toContain("node.style.scrollMarginTop = `" + dollar + "{clearance}px`;");
    /* THE PROPERTY IS "THE REF IS ON THE WRAPPER", not the wrapper's exact opening tag. This assertion used
       to read `"<div ref={stepPanelRef}>"` and #859 broke it by adding `style={styles.stepPanelRow}` to that
       very element -- a green harness turning red over a change it had no opinion about. Kept as a record of
       why the looser form is the right one: an assertion that fails when an UNRELATED attribute is added is
       testing the spelling, not the rule.
       #859's own property -- that the wrapper takes a full row so the panel has a width to divide -- is a
       different claim and is asserted where it belongs, in `stickyBarSplit.test.ts`. */
    expect(CODE).toMatch(/<div ref=\{stepPanelRef\}[^>]*>/);
  });

  it("measures the clearance rather than assuming one", () => {
    /* THE NUMBER WAS ALREADY BEING READ. `useCondensedWhenPinned` takes the bar's rect every frame for
       #720's pin test and threw both figures away; two other places then had to guess about a quantity this
       hook already knew. `stickyTop + height`, because the bar sits AT its sticky offset. */
    expect(CODE).toContain("const clearance = pinnable ? Math.round(stickyTop + rect.height) : 0;");
    expect(CODE).toContain("return [ref, condensed, mayPin, barClearance];");
  });

  it("reserves nothing when the bar cannot pin", () => {
    /* #720's own state: a bar too tall to pin is `position: static` and scrolls away with the page, so it
       covers nothing. The ternary above is the whole of it, asserted separately because a constant clearance
       would leave a gap under a bar that is not there. */
    expect(CODE).toContain("pinnable ? Math.round(stickyTop + rect.height) : 0");
  });

  it("does not count a panel hidden behind the bar as seen", () => {
    /* #797 greys this button when the panel is in view. Without the same clearance the observer counts the
       strip behind the bar, so the button disables itself at exactly the moment the panel is invisible --
       the reported confusion, with the one control that would fix it turned off. */
    const dollar = String.fromCharCode(36);
    /* #831 lifted this into `useJumpTarget`, so the margin is spelled from the hook's parameter rather than
       from the bar's state -- one observer definition serving the step panel and the map. */
    expect(CODE).toContain("rootMargin: `-" + dollar + "{clearance}px 0px 0px 0px`");
    expect(CODE).toContain("}, [target, clearance]);");
  });
});

describe("there is exactly one destination", () => {
  it("wraps both panels in the referenced container", () => {
    /* One wrapper rather than a ref per panel: the two steps are mutually exclusive, so a single target is
       always correct and cannot point at a panel that is not rendered. */
    expect(CODE).toContain("<div ref={stepPanelRef}");
    /* Design note #885: THE CLOSING BOUND WAS `<PrivatePowerPanel`, the next element after the wrapper.
       That panel is deleted, and an `indexOf` returning -1 for it would have produced a BACKWARDS slice --
       `""` -- which satisfies both `toContain`s below by containing nothing to contradict them. The bound is
       now the probe that genuinely follows the wrapper, and it is pinned before the slice is taken so the
       vacuity cannot come back the next time something between them moves. */
    const wrapperStart = CODE.indexOf("<div ref={stepPanelRef}");
    const wrapperEnd = CODE.indexOf("{stickyFitProbe && (");
    expect(wrapperStart).toBeGreaterThan(-1);
    expect(wrapperEnd).toBeGreaterThan(wrapperStart);
    const wrapper = CODE.slice(wrapperStart, wrapperEnd);
    expect(wrapper).toContain("<TrainPurchasePanel");
    expect(wrapper).toContain("<ProposePrivatePurchase");
  });

  it("keeps that container outside the sticky element", () => {
    /* #785's property, restated because this pass touched the same region: if the wrapper drifted back inside
       the bar, the bar would start unpinning itself again AND the jump would point at itself. */
    const stickyStart = CODE.lastIndexOf("ref={actionBarRef}");
    expect(CODE.indexOf("<div ref={stepPanelRef}")).toBeGreaterThan(stickyStart);
    const sticky = CODE.slice(stickyStart, CODE.indexOf("<div ref={stepPanelRef}"));
    expect(sticky).not.toContain("<TrainPurchasePanel");
  });
});

describe("the greying is retired, and deliberately (design notes #797 / #915 / #919)", () => {
  it("greys neither jump, because neither is a jump any more", () => {
    /* ==================================================================
        A RULE WHOSE SUBJECT STOPPED EXISTING
       ==================================================================
       #797 was right: "pressing it would do nothing, because the destination is already on screen", so a
       scroll button with its panel in view should be grey. Both controls have since become DISCLOSURES
       (#915, #919), and for a disclosure the rule inverts -- a panel already on screen is precisely the one
       a player wants to collapse, so greying it would remove the feature in the only state it is for.
       ASSERTED AS AN ABSENCE, AND COUNTED, because this is the shape that gets "restored" by a later reader
       who finds #797's note and not this one: a guard that looks like a missing safety check. It is not
       missing; it was retired with the button type it protected. */
    expect(CODE.match(/disabled: stepPanelInView/g)?.length ?? 0).toBe(0);
  });

  it("drops the sentences that explained a greying that no longer happens", () => {
    /* A reason for a disabled state the code cannot enter is a note describing a mechanism it does not have
       -- this project's third recurring bug shape, and cheap to avoid by deleting the copy with the rule. */
    expect(CODE).not.toContain("The Buy Trains panel is already on screen.");
    expect(CODE).not.toContain("The Buy Private Company panel is already on screen.");
  });

  it("still measures the panel, because the scroll still needs it", () => {
    /* THE CONTROL ON THE RETIREMENT. `stepPanelInView` fed the greying AND nothing else would justify the
       measurement -- but opening a collapsed panel still scrolls to it, so the machinery below stays earned.
       If this ever goes, the scroll-on-open goes with it. */
    expect(CODE).toContain("scrollToStepPanel");
  });

  it("measures rather than computing offsets", () => {
    /* The alternative is comparing scroll positions against element heights, which is the arithmetic
       `IntersectionObserver` exists to replace and which gets it wrong at every zoom level. */
    expect(CODE).toContain("new IntersectionObserver(");
    expect(CODE).toContain("observer.observe(node)");
    expect(CODE).toContain("observer.disconnect()");
  });

  it("requires height as well as intersection", () => {
    /* The wrapper renders on every step and holds a panel on two of them. On the others it is a zero-height
       div that an observer will happily call intersecting -- which would grey a button that has a real panel
       to reach. */
    expect(CODE).toContain("entry.isIntersecting && entry.boundingClientRect.height > 0");
  });

  it("stays enabled when it cannot measure", () => {
    /* #720'S RULE POINTED THE SAME WAY. Before the first callback, in jsdom, or in a browser without the API,
       the button is live: offering a scroll that proves unnecessary costs nothing, and withholding one that
       was needed strands the player at exactly the step #792 was raised about. */
    expect(CODE).toContain("React.useState(false)");
    expect(CODE).toContain('typeof IntersectionObserver === "undefined"');
  });
});

describe("the purchase button says what it does (design note #796)", () => {
  const PANEL = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(
      path.join(__dirname, "..", "components", "TrainPurchasePanel.tsx"),
      "utf8",
    );
  })();
  const PANEL_CODE = PANEL.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("carries a verb, not only a figure", () => {
    /* REPORTED: "the clickable button only lists the price that will be paid. It needs to clearly say 'Buy
       for $X'." Then, better: "instead of 'Buy for $X' it could say 'Pay $X' since ... the line the button is
       on already says 'Buy 1/2/3/4 x-train(s)'." */
    const dollar = String.fromCharCode(36);
    // Same dodge as #779's and #783's harnesses: the string IS source text, so the `$` is assembled.
    expect(PANEL_CODE).toContain("Pay " + dollar + dollar + "{bankTotal || nextTier.cost}");
  });

  it("does not repeat the verb from the line above", () => {
    /* #722'S REAL POINT, KEPT. The row already says "Buy 2 4-trains from the Bank"; "Buy for $600" would put
       the verb and the object on screen twice, which is the duplication that note removed. "Pay" is the half
       of the transaction the button uniquely performs. */
    expect(PANEL_CODE).not.toContain("Buy for $");
  });

  it("keeps the train-limit wording, which is not a price", () => {
    // The one state where a figure is the wrong thing to show: the button is dead and the reason beats a number.
    expect(PANEL_CODE).toContain('atTrainLimit ? "Train Limit Reached"');
  });

  it("keeps the spelled-out accessible name", () => {
    /* #722 wrote a full sentence for screen readers because the visible label leaned on its surroundings.
       That is still true of "Pay $600" and the sentence still earns its place. */
    const dollar = String.fromCharCode(36);
    expect(PANEL_CODE).toContain("aria-label={");
    expect(PANEL).toContain("-train" + dollar + "{quantity === 1 ? \"\" : \"s\"} from the Bank for " + dollar);
  });
});

describe("the disclosures default by obligation (design notes #918 / #919)", () => {
  /* ==================================================================
      REQUESTED: "make it contextually aware ... default to CLOSED, unless the acting corporation currently
      has exactly 0 trains ... derive it purely from the corporation's current train count."
     ==================================================================
     ADDED BECAUSE A CONTROL WALKED PAST. Replacing the seed with `useState(true)` -- the unconditional
     default this replaced -- left every case in this file green, which is the same integration gap #911 and
     #917 both fell into. The default is a real rule and needs a real assertion. */
  const bar = stripComments(readSource("panels/ContextualActionBar.tsx"));

  it("seeds the trains panel from the obligation, not from a constant", () => {
    expect(bar).toContain("useState(mustBuyTrain)");
    /* Scoped to the trains state rather than to the whole file: `mayPin` is an unrelated `useState(true)`,
       and the first draft of this case failed on it -- an assertion about one declaration written as a
       claim about the module. */
    expect(bar).not.toContain("[trainPanelOpen, setTrainPanelOpen] = useState(true)");
  });

  it("re-seeds when the acting corporation changes, not when its fleet does", () => {
    /* THE DISTINCTION THAT KEEPS IT FROM FIGHTING THE PLAYER. Watching the train COUNT would reopen the
       panel under their hand the moment they bought the train and were done with it; watching WHOSE TURN it
       is re-seeds only when nobody has expressed a preference yet. */
    expect(bar).toContain("[activeCorporation?.companyId]");
    expect(bar).not.toContain("[mustBuyTrain]");
  });

  it("leaves the privates panel closed, because that step is never compulsory", () => {
    /* #919: there is no state in 1830 where a corporation MUST buy a private, so there is no obligation for
       a default to answer to. Asserted so the two defaults cannot be "tidied" into one rule. */
    expect(bar).toContain("[privatePanelOpen, setPrivatePanelOpen] = useState(false)");
  });
});

