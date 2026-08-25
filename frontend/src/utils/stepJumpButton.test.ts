/** @jest-environment node */

// No runtime imports: this file reads source text. `export {}` makes it a module for `--isolatedModules`.
export {};
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
       #293's greying of End Turn beside it already carries the obligation. The `title` says the rest. */
    expect(hardwareCase).toContain('label: "Buy Trains"');
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
    /* #263'S OBJECTION, ANSWERED. Both buttons call the same scroller and neither is wired to a handler that
       buys anything -- so there is one control for the outcome and one signpost to it. */
    expect(CODE.match(/onClick: scrollToStepPanel/g)?.length).toBe(2);
  });

  it("names the destination rather than the purchase", () => {
    /* The label says where it goes, and the `title` says what it does. What keeps this from reading as a
       second buy control is that the panel's own button carries a tier and a price and this one carries
       neither -- not, as the first draft had it, a glyph. */
    expect(CODE).toContain('label: "Buy Trains"');
    expect(CODE).toContain('label: "Buy Private Company"');
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
    expect(CODE).toContain("Scrolls to the Buy Trains panel below.");
  });

  it("scrolls the least that works", () => {
    /* `block: "nearest"` rather than `"start"`: under a sticky bar, `start` tucks the panel's heading behind
       it, and on a short page `nearest` correctly does nothing at all. */
    expect(CODE).toContain('block: "nearest"');
    expect(CODE).not.toContain('block: "start"');
  });
});

describe("there is exactly one destination", () => {
  it("wraps both panels in the referenced container", () => {
    /* One wrapper rather than a ref per panel: the two steps are mutually exclusive, so a single target is
       always correct and cannot point at a panel that is not rendered. */
    expect(CODE).toContain("<div ref={stepPanelRef}>");
    const wrapper = CODE.slice(
      CODE.indexOf("<div ref={stepPanelRef}>"),
      CODE.indexOf("<PrivatePowerPanel"),
    );
    expect(wrapper).toContain("<TrainPurchasePanel");
    expect(wrapper).toContain("<ProposePrivatePurchase");
  });

  it("keeps that container outside the sticky element", () => {
    /* #785's property, restated because this pass touched the same region: if the wrapper drifted back inside
       the bar, the bar would start unpinning itself again AND the jump would point at itself. */
    const stickyStart = CODE.lastIndexOf("ref={actionBarRef}");
    expect(CODE.indexOf("<div ref={stepPanelRef}>")).toBeGreaterThan(stickyStart);
    const sticky = CODE.slice(stickyStart, CODE.indexOf("<div ref={stepPanelRef}>"));
    expect(sticky).not.toContain("<TrainPurchasePanel");
  });
});

describe("the jump greys out with nothing to reach (design note #797)", () => {
  it("disables both buttons when the panel is in view", () => {
    /* REPORTED: "'Buy Trains' should be grayed out when there's no need to scroll them to the subpanel."
       `block: "nearest"` already made the click harmless -- it scrolls by zero -- and a control that responds
       to a press by doing nothing is indistinguishable from a broken one. */
    expect(CODE).toContain("disabled: stepPanelInView");
    expect(CODE.match(/disabled: stepPanelInView/g)?.length).toBe(2);
  });

  it("says why it is grey", () => {
    // A disabled control with no reason is the complaint #784 was raised about, one panel over.
    expect(CODE).toContain("The Buy Trains panel is already on screen.");
    expect(CODE).toContain("The Buy Private Company panel is already on screen.");
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
