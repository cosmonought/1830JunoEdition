/** @jest-environment node */

// No runtime imports beyond the rule the probe consults.
//
// The bank stands aside, the button names its counterparty, and the bar's height stops being a guess.
//
// ==================================================================
//  DESIGN NOTE 813 (harness): TWO MOVES, ONE UNMEASURED NUMBER
// ==================================================================
//
// ASKED: "we have slimmed the Buy Trains subpanel so much that I am wondering if it makes sense to condense
// it into the sticky Action Bar ... My only fear is that Buy Trains from Corporation, when there are 8
// operating corporations, may expand and create a scrolling problem like we had before."
//
// THAT FEAR IS THE WHOLE HISTORY OF THIS PANEL. #508 moved it INTO the bar ("sticky by inheritance"); #720
// then found that a sticky element past half the viewport traps the page and taught the bar to unpin itself;
// #785 moved the panel back OUT because the depot reliably tripped that; #792 gave the bar a jump button to
// replace what the move cost. Two relocations, both decided by reasoning about a number neither of them
// measured -- and the failure mode is SILENT. A bar that quietly stops being sticky looks exactly like a bar
// that never was, which is how it was reported: "buy trains is not sticky and does not travel".
//
// SO THE THIRD DECISION GETS AN INSTRUMENT. This session has now had four reports where a hypothesis was
// wrong and an instrument was right (#750, #768, #778, #784), and this is the same bet: measure the bar as
// it WOULD BE with the panel inside it, on the device it is played on, and decide from the figure.
//
// THE PROBE ASKS THE RULE RATHER THAN RESTATING IT, which is the property this file mostly exists to pin.
// `canPinWithoutTrapping` is #720's own predicate; a probe with its own arithmetic could report "would pin"
// about a bar the rule unpins, and a lying instrument is worse than none -- it would settle the question in
// the wrong direction and look authoritative doing it.

import { canPinWithoutTrapping, STICKY_MAX_VIEWPORT_SHARE } from "./stickyCollapse";

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

const BAR = strip(read("panels/ContextualActionBar.tsx"));
const DEPOT = strip(read("components/TrainPurchasePanel.tsx"));
const PRIVATE_RAW = read("components/PrivateTradePanel.tsx");
const PRIVATE = strip(PRIVATE_RAW);
const TUTORIAL = strip(read("components/TutorialModal.tsx"));

describe("the probe measures the question that was asked", () => {
  it("measures the bar as it would be with the panel in it", () => {
    /* THE POINT, and #828a corrected how it is reached. While the two were siblings the answer was
       `bar + panel`; nested, the bar's own rect already contains the panel and adding them again is the
       double count that would have reported 65% for a 38% arrangement. Both arms asserted below. */
    expect(BAR).toContain("const combined = nested ? barHeight : barHeight + panelHeight;");
    expect(BAR).toContain("panelRef.current?.getBoundingClientRect().height ?? 0");
  });

  it("takes its verdict from the rule that enforces it", () => {
    /* A SECOND ARITHMETIC WOULD BE THE FAILURE THIS SESSION KEEPS FINDING (#748a, #775, #791): two surfaces
       answering one question two ways. Here it would be worse than usual, because the whole purpose of the
       readout is to be believed. */
    expect(BAR).toContain("canPinWithoutTrapping(resting, viewport, stickyTop)");
    expect(BAR).not.toContain("> 0.5");
  });

  it("does not confirm whatever it finds (design note #837)", () => {
    /* THE INSTRUMENT AGREED WITH THE BUG. The verdict was taken on `combined` -- the pixels on screen -- and
       once the bar was unpinned it reported WOULD UNPIN, which was true and useless: it said the bar would
       unpin BECAUSE it had unpinned. A reading that confirms whatever state it is taken in is #828a's own
       warning ("an instrument that lies is worse than none") arriving one pass later.
       IT NOW TAKES THE VERDICT ON THE SAME NUMBER THE PIN TEST USES, and still PRINTS `combined`, because
       what a player sees on screen is the other half of the question. Two numbers, both reported. */
    expect(BAR).toContain("const resting = Math.round(restingHeight(bar));");
    /* `String.fromCharCode(36)` for the interpolations: a literal `${` inside a plain string trips
       `no-template-curly-in-string`, and the rule reads the literal rather than the intent. The source lines
       are template literals, so ONE dollar each here -- these are the interpolation's, not a printed one.
       (The third time this session; `tokenSpendNote.test.ts` has the case where both are wanted.) */
    const d = String.fromCharCode(36);
    expect(BAR).toContain("resting " + d + "{resting}px");
    expect(BAR).toContain("= " + d + "{combined}px");
  });

  it("says nothing on a step with no panel", () => {
    // A verdict about a panel that is not rendered would be a measurement of nothing, stated confidently.
    expect(BAR).toContain("if (panelHeight === 0) {");
  });

  it("renders outside the element it measures", () => {
    /* A readout INSIDE the bar adds its own height to the reading.
       DESIGN NOTE 828a REVERSED HALF OF THIS ASSERTION. It used to require the probe to sit between the bar's
       closing tag and the step panel, which was the arrangement #813 measured -- panel as a sibling. #828 put
       the panel inside the bar, so "before the panel" would now mean "inside the bar", which is the one place
       the probe must not be. What survives is the property: it comes after the sticky element closes. */
    const stickyStart = BAR.lastIndexOf("ref={actionBarRef}");
    const probe = BAR.indexOf("{stickyFitProbe && (");
    const panel = BAR.indexOf("<div ref={stepPanelRef}");
    expect(probe).toBeGreaterThan(stickyStart);
    expect(probe).toBeGreaterThan(panel);
  });

  it("stops adding the panel once the bar contains it", () => {
    /* THE FAILURE THIS FILE'S OWN HEADER WARNS ABOUT: "a lying instrument is worse than none -- it would
       settle the question in the wrong direction and look authoritative doing it." #813's arithmetic was
       `bar + panel` because the two were siblings; nested, that double-counts, reports about 65% where the
       truth is 38%, and says WOULD UNPIN with total confidence.
       ASKED OF THE DOM, so the probe cannot fall out of step with a later move. */
    expect(BAR).toContain("const nested = panelRef.current !== null && bar.contains(panelRef.current);");
    expect(BAR).toContain("const combined = nested ? barHeight : barHeight + panelHeight;");
  });

  it("says which arrangement it measured", () => {
    /* A number with no shape attached is how the last one got believed in the wrong context.
       `${...}` in a plain string trips `no-template-curly-in-string`, and rightly -- sixth time this session
       that searched-for source text has needed assembling rather than quoting. */
    const dollar = String.fromCharCode(36);
    expect(BAR).toContain("(panel " + dollar + "{panelHeight} inside)");
    expect(BAR).toContain("+ panel " + dollar + "{panelHeight}");
  });

  it("re-measures when the panel grows, not only when the window does", () => {
    /* #758's lesson, applied before the report this time: the corporate roster grows with every corporation
       that owns a train, and that is neither a scroll nor a resize. */
    expect(BAR).toContain("new ResizeObserver(() => schedule())");
    expect(BAR).toContain("observer.observe(panelRef.current)");
  });

  it("agrees with the rule at the boundary it is judging", () => {
    /* The one real assertion in this file: a combined height either side of half the viewport, through the
       same predicate the probe calls. If #720's threshold ever moves, the probe's verdict moves with it. */
    expect(STICKY_MAX_VIEWPORT_SHARE).toBe(0.5);
    expect(canPinWithoutTrapping(300, 800, 0)).toBe(true);
    expect(canPinWithoutTrapping(500, 800, 0)).toBe(false);
  });
});

describe("the bank no longer stands aside, because it no longer folds (#812 -> #859/#860)", () => {
  /* #812 COLLAPSED THE DEPOT WHEN THE ROSTER OPENED, and its reasoning was about height: the roster with
     eight corporations UNDER a full depot table was the bar's worst case, and folding one removed it.
     BOTH HALVES OF THAT PREMISE ARE GONE. #859 gave the panel the bar's full width, so the two sections sit
     SIDE BY SIDE rather than stacked -- neither is under the other. #860 then deleted the depot table
     outright, its three facts having found other homes (the price on the buy row, the roster behind the
     caret, the rust on #839's badge). What is left of the bank is a heading, a buy row and two figures.
     #812's REAL POINT SURVIVES AND IS ASSERTED BELOW: the treasury stays on the bank's line, because it is
     the figure that decides whether EITHER purchase is possible. */
  it("keeps the treasury on the bank's line", () => {
    expect(DEPOT).toContain("treasury " + String.fromCharCode(36) + "{treasury}");
  });

  it("has no fold left to trigger", () => {
    expect(DEPOT).not.toContain("setBankOpen");
    expect(DEPOT).not.toContain("bankOpen");
  });

  it("keeps the roster's own caret, which is the one that grows", () => {
    // #758's case: eight operating corporations. That table is still a table a player opens on purpose.
    expect(DEPOT).toContain("setCorporateOpen((open) => !open)");
  });
});

describe("the offer names who it goes to (design note #811)", () => {
  it("puts the holder on the button", () => {
    expect(PRIVATE).toContain("Propose Purchase to");
    expect(PRIVATE).toContain("{entry.owner ? labelForAddress(entry.owner) : \"the owner\"}");
  });

  it("keeps a sentence when the room has not resolved the holder", () => {
    /* The same fallback rule #779 set for the holder's COLOUR: a missing answer degrades to a neutral one
       rather than to a gap, because the sentence's shape is what a player reads first. */
    expect(PRIVATE).toContain('"the owner"');
  });
});

describe("the private panel's intro moved to the tutorial (design note #814)", () => {
  it("no longer states the band in the panel", () => {
    expect(PRIVATE).not.toContain("A corporation may buy a private company from its owner");
    expect(PRIVATE).not.toContain("body: { margin: 0, fontSize: FONT_SIZE.body");
  });

  it("still states the band where the price is chosen", () => {
    /* THE HALF THAT WAS ALREADY DUPLICATED. #721 said it first -- "two statements of one rule, and the
       redundant one was shouting" -- and #804 put the surviving one inline beside the offer field.
       #842 MOVED IT INTO THE FIELD'S LABEL and changed the separator to an en dash, so the literal moved
       with it. The PROPERTY is unchanged and is what this pins: the band is stated where the number is
       typed, rather than only in a paragraph the panel no longer has. */
    const dollar = String.fromCharCode(36);
    expect(PRIVATE).toContain(
      "Offer price (" + dollar + "{bounds.min}&#8211;" + dollar + "{bounds.max})",
    );
  });

  it("gives the consent rule a home, since it had none", () => {
    /* THE HALF THAT COULD NOT SIMPLY BE DELETED, and the reason I left this paragraph alone two reports ago
       after flagging it. "The owner has to agree" was stated nowhere else in the app. */
    expect(TUTORIAL).toContain("The OWNER has to agree");
    const slide = TUTORIAL.slice(
      TUTORIAL.indexOf('title: "Steps 1 and 2"'),
      TUTORIAL.indexOf('title: "Terrain Costs"'),
    );
    expect(slide).toContain("negotiation, not a purchase you can force");
  });

  it("keeps the note that records what was removed", () => {
    /* #490a: the scan runs comment-stripped, so the reasoning is asserted against the raw file.
       THIS FAILED FIRST, and the reason is now a pattern rather than an accident. The note quoted the deleted
       sentence across a wrapped comment line, so "The owner has to agree" existed as words and not as a
       STRING. That is the third time in two passes that source text read as contiguous and was not -- a JSX
       `$` beside an expression (#804), a `+`-joined tutorial line (#810), and a wrapped comment here. The
       remedy in the source is to quote a removed string on one unwrapped line; the remedy here is to say why,
       because the next person to add a #490a guard will hit it again. */
    expect(PRIVATE_RAW).toContain(
      "A corporation may buy a private company from its owner between 50% and 200% of face value.",
    );
    expect(PRIVATE_RAW).toContain("The owner has to agree.");
  });
});
