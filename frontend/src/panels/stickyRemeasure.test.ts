/** @jest-environment node */
//
// What makes the action bar re-ask whether it may pin. Source-level; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 758 (harness): A CORRECT RULE ON THE WRONG EVENTS
// ==================================================================
//
// REPORTED: "A similar bug as occurred with the Buy Private Company sticky, the sticky for Buy Trains from
// Other Corporations is so large when all corporations are operating that it takes up the whole screen and
// cannot be scrolled to the bottom until the screen behind it is scrolled all the way down."
//
// #720 ALREADY BUILT AND TESTED THE RULE, and `stickyTrap.test.ts` still owns it -- `canPinWithoutTrapping`
// is not re-tested here. This file is about the half #720 did not have: WHEN the question gets asked.
//
// THE MEASUREMENT WATCHED THE VIEWPORT AND THE PANEL IS WHAT CHANGES. Scroll and resize describe the window.
// "Buy Trains from a Corporation" is an accordion whose seller roster grows with every corporation that owns
// a train, so the bar can double in height with the viewport untouched -- and `mayPin` keeps whatever answer
// it got when the accordion was shut.
//
// THE REPORT'S PHRASING IS THE DIAGNOSIS. "Cannot be scrolled to the bottom UNTIL the screen behind it is
// scrolled" is not a permanently broken panel; it is a correct fix arriving one gesture after it was needed,
// because the scroll that finally re-measures is the same scroll the player was trying to make.
//
// WHICH IS WHY THIS IS A SOURCE SCAN AND SAYS SO. The bug is a missing subscription, not a wrong number.
// There is no value to assert -- only whether the component is listening to the right thing. Same instrument
// as `stationVeil.test.ts`, for the same reason.

import fs from "fs";
import path from "path";

const BAR = fs.readFileSync(path.join(__dirname, "ContextualActionBar.tsx"), "utf8");
/** #490a: the note explains the old wiring and must keep doing so. */
const CODE = BAR.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The pin-measurement hook, isolated so a match elsewhere in the file cannot pass for one here. */
const HOOK = (() => {
  const start = CODE.indexOf("function useCondensedWhenPinned");
  expect(start).toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf("return [ref, condensed, mayPin];", start));
})();

describe("the bar re-measures when the bar changes", () => {
  it("observes its own size", () => {
    /* THE FIX. Anything that changes the bar's height now re-asks whether it may pin -- the accordion, a
       longer refusal message wrapping to three lines, a tray added next year, a font-size preference. */
    expect(HOOK).toContain("new ResizeObserver(() => schedule())");
    expect(HOOK).toContain("observer.observe(ref.current)");
  });

  it("routes it through the same scheduler as scroll", () => {
    /* One rAF-coalesced path, not two. `measure` forces layout; letting an observer call it directly would
       reintroduce the per-frame double read #720 went out of its way to avoid ("two reads would be two
       forced layouts per frame for numbers that must agree with each other"). */
    expect(HOOK).toContain("const observer =");
    expect(HOOK).not.toMatch(/new ResizeObserver\(\(\) => measure\(\)\)/);
  });

  it("disconnects on unmount", () => {
    // An observer outliving its node keeps the node alive; the two window listeners are already cleaned up.
    expect(HOOK).toContain("observer?.disconnect()");
  });

  it("degrades rather than throwing where the API is absent", () => {
    /* This hook renders under jsdom in the component tests, where `ResizeObserver` is not always defined. An
       unguarded constructor would fail on mount -- turning a layout refinement into a crash on every suite
       that renders the bar. */
    expect(HOOK).toContain('typeof ResizeObserver === "undefined" ? null');
  });
});

describe("what #720 built is untouched", () => {
  it("still asks the shared predicate", () => {
    /* The rule is not restated here. `stickyTrap.test.ts` owns `canPinWithoutTrapping`; this file only
       asserts that the bar is still the thing asking it, so a future edit cannot quietly answer the question
       locally.
       DESIGN NOTE 837 CHANGED WHAT IS MEASURED, not who asks. It read `rect.height` -- a rect that has
       included the step panel since #828 -- so the pin test measured a subtree whose height the pin test's
       own answer controlled. Reported as "in OR 1.1 it's not [sticky], but in OR 2.1 it is", which is a
       deadlock settling on whichever side of the threshold the first frame landed. `restingHeight` is the
       bar with every collapsible body taken out, which does not move when the fold moves.
       DESIGN NOTE 863 CHANGED WHO IS ASKED, not what is measured. `restingHeight` is still the input on the
       edge back into stickiness; the predicate reading it is now `shouldReleasePin`, because the comfort
       threshold turned out to be the thing preventing a released bar from ever returning. The needle was
       `canPinWithoutTrapping(restingHeight(node), window.innerHeight, stickyTop)`; what this file is really
       guarding is that the bar consults a SHARED predicate from `stickyCollapse` rather than answering
       locally, and that is unchanged. */
    expect(HOOK).toContain("restingHeight(node)");
    expect(HOOK).toContain("shouldReleasePin(");
    // AND THE CLEARANCE STILL READS THE RECT: "can I pin" and "what am I covering" are different questions.
    expect(HOOK).toContain("Math.round(stickyTop + rect.height)");
  });

  it("still measures pin distance and height on one rect", () => {
    expect(HOOK).toContain("const rect = node.getBoundingClientRect();");
    expect(HOOK).toContain("const distanceToPin = rect.top - stickyTop;");
  });

  it("still refuses to condense a bar that cannot pin", () => {
    /* #720's second rule, which the new trigger makes fire more often and must not disturb: "a bar that
       cannot pin must not CONDENSE either", because a static element's rect top goes negative simply by
       scrolling past it. */
    expect(HOOK).toContain("pinnable ? shouldCondenseSticky(distanceToPin, was) : false");
  });

  it("still keeps the window listeners", () => {
    // The observer ADDS a trigger; the viewport ones remain correct for what they describe.
    expect(HOOK).toContain('window.addEventListener("scroll", schedule, { passive: true })');
    expect(HOOK).toContain('window.addEventListener("resize", onResize)');
  });
});

describe("the panel this was reported about is inside the measured node", () => {
  it("renders the train panel within the ref'd element", () => {
    /* THE PREMISE, checked rather than assumed -- and the thing that would make the whole fix pointless if it
       were false. #31 describes the trays as "not part of the bar ... they render under the slim strip as
       their own blocks", which is true of their LOOK and not of their DOM position: they sit inside the
       sticky container, so the bar's own height includes them. If they were siblings, `rect.height` would
       never see the accordion open and no trigger would help. */
    const refAt = CODE.lastIndexOf("ref={actionBarRef}");
    const panelAt = CODE.indexOf("<TrainPurchasePanel", refAt);
    expect(refAt).toBeGreaterThan(-1);
    expect(panelAt).toBeGreaterThan(refAt);
  });

  it("has a collapsible corporate roster, which is what grows", () => {
    const panel = fs.readFileSync(
      path.join(__dirname, "..", "components", "TrainPurchasePanel.tsx"),
      "utf8",
    );
    expect(panel).toContain("Buy Trains from a Corporation");
    expect(panel).toContain("setCorporateOpen((open) => !open)");
  });
});
