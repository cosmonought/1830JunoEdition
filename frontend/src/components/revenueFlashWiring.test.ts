/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 940 (harness): THE FLOATING MODIFIER, AND WHAT IT IS NOT
// ==================================================================
//
// RULED: "Large font, floating text ONLY. Do not put this in a box, pill, or standard toast notification
// window ... Green for bonuses, Red for maluses ... Display for exactly 2 seconds ... ONLY trigger this
// overlay if `final_rounded !== printed`."
//
// FOUR OF THOSE FIVE ARE ABSENCES OR CONSTANTS, which is why this is a source scan rather than a render test.
// "Not in a box" is not something a rendered DOM assertion states well -- you would be asserting the absence
// of properties nobody wrote -- whereas the styles are literals in one file and can be read directly.
//
// THE TRIGGER IS THE PART THAT MATTERS MOST, and it is a wiring question: the shell must ask #938's
// `revenueOutcome` rather than testing the percentage, or a 90% roll that rounded back to the printed figure
// flashes "-10%" over a run that lost nothing.

import { readStripped, sliceBetween } from "../utils/sourceScan";

describe("the overlay is floating text, not a window (design note #940)", () => {
  const FLASH = readStripped("components/RevenueModifierFlash.tsx");

  it("times out on its own constant", () => {
    /* ==================================================================
        SUPERSEDED BY #954, AND THE OLD FIGURE IS RECORDED RATHER THAN DELETED
       ==================================================================
       THIS ASSERTED `REVENUE_FLASH_MS = 2000`, on #940's ruling of "exactly 2 seconds". REPORTED since: "too
       large and hangs on screen too long", refined to a rule of thumb -- "a juice notification should be
       readable ~1.5x before it goes away, and it doesn't take long to read a two-digit number." It is 700 now,
       and `polishWave6.test.ts` owns the arithmetic behind that figure.
       WHAT IS LEFT HERE IS THE MECHANISM, which never changed and is the half that can silently break: the
       timer must read the exported constant rather than a literal, or the two can disagree and the exported
       value becomes documentation of something the component does not do. */
    expect(FLASH).toContain("setTimeout(() => setVisible(false), REVENUE_FLASH_MS)");
    expect(FLASH).toMatch(/export const REVENUE_FLASH_MS = \d+;/);
  });

  it("sits in the dead centre of the viewport", () => {
    expect(FLASH).toContain('position: "fixed"');
    expect(FLASH).toContain("inset: 0");
    expect(FLASH).toContain('alignItems: "center"');
    expect(FLASH).toContain('justifyContent: "center"');
  });

  it("wears no box, pill, or plate", () => {
    /* ==================================================================
        THE RULING, AS AN ABSENCE -- AND #973 CHANGED WHAT IT IS AN ABSENCE OVER
       ==================================================================
       Every property that would give this a window is named, because "floating text ONLY" is a constraint on
       what must NOT appear and a positive assertion cannot express it.
       `textShadow` WAS ALWAYS EXEMPT -- a halo is not a box, and it is the same trick #364 uses on the hex
       badge for the same reason: legibility over a board of four different colours.
       #960's GLOW WAS CALLED OUT HERE because it would have passed untouched: a radial gradient sets
       `background`, not `backgroundColor`, so a coloured field could appear behind the figure with every
       assertion below still holding. That glow is GONE (#973) and the note that let it through with it.
       WHAT REPLACED IT IS A REAL `box-shadow`, AND THAT NEEDS SAYING OUT LOUD rather than being routed around.
       #973's screen-edge flash is an inset shadow -- exactly the property this case forbids -- and it lives
       in `animations.ts`, so a whole-file scan of the COMPONENT would have kept passing while a shadow
       appeared on screen. Letting an absence test go on passing because the forbidden thing moved file is
       precisely the "technicality" failure #960 was called out for.
       WHAT #940 FORBIDS IS A SURFACE THE NUMERAL SITS ON, and the viewport's rim is not that surface -- it
       is nowhere near the figure. So the component's own absences stand unchanged (they still guard the
       thing the rule is about), the rim's shadow is asserted POSITIVELY in the next case rather than being
       quietly allowed to live one file over, and #960's radial field is asserted gone rather than assumed. */
    expect(FLASH).not.toContain("backgroundColor");
    expect(FLASH).not.toContain("borderRadius");
    expect(FLASH).not.toContain("boxShadow");
    expect(FLASH).not.toContain("border:");
    expect(FLASH).not.toContain("padding");
  });

  it("keeps the backdrop edgeless, which is what makes it not a plate (design note #986)", () => {
    /* ==================================================================
        I ASSERTED THIS GRADIENT WAS GONE ONE BATCH AGO, AND IT IS BACK ON INSTRUCTION
       ==================================================================
       #973 REMOVED #960's GLOW and I added `not.toContain("radial-gradient")` and `not.toContain("background:")`
       here to hold it removed. RULED SINCE: "render a white/cream radial gradient glow strictly behind the
       number and arrows ... 70% opacity at its center and fade out completely to 0% at its edges."
       SO THOSE TWO ABSENCES ARE WITHDRAWN, and I would rather say that than quietly weaken them. What they
       were guarding is real and #960's note states it exactly: "Slipping past an absence test on a
       technicality makes the test worthless for everything it still guards." The technicality then was that
       a radial gradient sets `background`, not `backgroundColor`, so #940's list could not see it.
       WHAT #940 ACTUALLY FORBIDS IS AN EDGE. A box has a rim the figure sits inside; this reaches full
       transparency at its own boundary, so no rectangle is visible at any opacity and there is nothing to
       read as a window. That distinction is now asserted DIRECTLY -- the last stop's alpha -- rather than
       being left to the property name, which is the form it should have had the first time.
       THE FIGURE'S OWN STYLE IS STILL A BARE `background`-FREE BLOCK, and the case above still says so: the
       backdrop is a separate element with its own class, not a fill on the numeral. */
    expect(FLASH).toContain("radial-gradient(ellipse closest-side");
    expect(FLASH).toContain('const BACKDROP_FADE = "rgba(255, 250, 240, 0)"');
    expect(FLASH).toContain("${BACKDROP_FADE} 100%)");
    /* AND IT IS THE ONLY GRADIENT IN THE COMPONENT. A second one would be #960's outcome-tinted field back
       beside this one, which is the duplication #973 was right to object to. */
    expect(FLASH.match(/radial-gradient/g)?.length ?? 0).toBe(1);
  });

  it("flashes the screen's rim, not a plate behind the figure (design note #973)", () => {
    /* RULED: "Remove the text glow and replace it with a brief screen-border glow/flash (green for bonus,
       red for malus) that matches this 850ms duration."
       ASSERTED IN BOTH FILES, because the two halves fail independently: the element can be rendered with no
       rule to style it, and the rule can exist with nothing rendering it -- and either way nothing appears
       and nothing else objects. This project's recurring fault, in a stylesheet. */
    const ANIM = readStripped("styles/animations.ts");
    expect(FLASH).toContain('className="app-revenue-edge"');
    expect(FLASH).toContain("color: bonus ? BONUS_EDGE : MALUS_EDGE,");
    const edge = sliceBetween(ANIM, ".app-revenue-edge {", "}");
    /* INSET, or it draws a halo OUTSIDE a viewport-sized box, where nothing can see it. */
    expect(edge).toContain("box-shadow: inset");
    expect(edge).toContain("position: fixed");
    expect(edge).toContain("pointer-events: none");
    /* `currentColor` IS WHAT KEEPS THE HUE OUT OF THE STYLESHEET. A literal green here would be a second
       place deciding what a bonus looks like, and the two would drift the first time either moved. */
    expect(edge).toContain("currentColor");
    expect(ANIM).not.toContain("app-revenue-glow");
  });

  it("names its duration once (design note #970)", () => {
    /* RULED: "Hardcode the display duration to exactly 850ms so it is uniform in all contexts."
       THE FAILURE THIS CATCHES IS THE ONE THAT MADE IT NON-UNIFORM: three literals -- the constant, the
       arrows' `animation-duration` and the glow's shorthand -- that agreed by coincidence. The stylesheet
       must name NO duration for these elements, so the constant is the only copy. */
    const ANIM = readStripped("styles/animations.ts");
    expect(FLASH).toContain("export const REVENUE_FLASH_MS = 900;");
    expect(FLASH.match(/animationDuration: `\$\{REVENUE_FLASH_MS\}ms`/g)?.length ?? 0).toBe(2);
    const arrow = sliceBetween(ANIM, ".app-revenue-arrow {", ".app-revenue-figure");
    expect(arrow).not.toContain("animation-duration:");
    const edge = sliceBetween(ANIM, ".app-revenue-edge {", "}");
    expect(edge).not.toContain("animation-duration:");
    /* AND THE THIRD COPY IS GONE WITH THE RULE THAT HID IT. It lived inside a SHORTHAND --
       `animation: app-revenue-glow-in 700ms ease-out 1 forwards` -- where neither of the longhand scans
       above would have seen it, which is why this asks for the block by name rather than for a property. */
    expect(ANIM).not.toContain("app-revenue-glow-in");
    expect(ANIM).not.toContain("REVENUE_FLASH_GLOW_CSS = ");
  });

  it("cannot swallow a click", () => {
    /* "NON-BLOCKING", MECHANICALLY. The overlay covers the whole viewport, which is where the board and its
       controls are; without this it would eat every click for two seconds after each run -- a worse bug than
       the one it exists to prevent. Asserted twice because the container and the text are separate elements
       and only disabling one leaves the other live. */
    expect(FLASH.match(/pointerEvents: "none"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("is green up and red down", () => {
    expect(FLASH).toContain("const BONUS_COLOR");
    expect(FLASH).toContain("const MALUS_COLOR");
    expect(FLASH).toContain("bonus ? BONUS_COLOR : MALUS_COLOR");
  });

  it("signs the figure it prints", () => {
    /* "+20%" or "-10%" -- the sign is the whole message at a glance, and an unsigned "20%" beside a red
       colour asks the player to decode two channels to learn one fact. */
    expect(FLASH).toContain('{bonus ? "+" : "-"}');
    expect(FLASH).toContain("{Math.abs(shown.delta)}%");
  });

  it("restarts on a token rather than on the value", () => {
    /* THE MULTI-TRAIN CASE. Two trains in one turn can roll the same delta; keyed on the value React would
       see no change and the second flash would never play. */
    expect(FLASH).toContain("signal?.token");
  });
});

describe("the shell raises it once per TURN (design notes #940 -> #941)", () => {
  /* ==================================================================
      THE TRIGGER MOVED, AND THAT IS THE FIX
     ==================================================================
     #940 RAISED THE FLASH INSIDE `runGameplayAction`, which fires once per dispatched route. REPORTED: "a
     4-train corporation forces the player to sit through 8 seconds of consecutive UI flashes (+10%, -20%,
     etc.), with no clear idea of which modifier applies to which train."
     SO IT MOVED TO `handleRunTrains`, after the dispatch loop -- the only place that can see the end of a
     turn's running. These cases assert it is there and, just as importantly, that it is no longer in the
     per-dispatch path. */
  const APP = readStripped("App.tsx");
  const runBlock = sliceBetween(APP, "const runnable = runnableDrafts(", "setLiveOrSubPhase(");

  it("fires from the run-trains callback, not from each dispatch", () => {
    expect(runBlock).toContain("setRevenueFlash(");
    /* AND NOWHERE ELSE. One occurrence in the whole shell -- a second would be a second flash per turn, which
       is the reported bug however few trains it took to produce it. */
    expect(APP.match(/setRevenueFlash\(/g)?.length ?? 0).toBe(1);
  });

  it("logs one consolidated sentence for the turn", () => {
    /* RULED: "The Activity Log should likewise produce a single consolidated line for the total payout." */
    expect(runBlock).toContain("turnRevenueSentence(");
    expect(APP.match(/turnRevenueSentence\(/g)?.length ?? 0).toBe(1);
  });

  it("rolls once, on the aggregated printed total", () => {
    /* ==================================================================
        THE SOURCE OF THE TOTAL CHANGED; THE "ONCE" DID NOT
       ==================================================================
       THIS ASSERTED the sum came from `runnable` -- the drafts the shell was about to dispatch -- and #941's
       reason was #934's race: reading state right after a dispatch loop can catch a room mid-snapshot.
       REPORTED SINCE: "B&O ran multiple routes totaling a modified $170. However, the Dividends phase
       calculated the payout at $6/share." Two figures on one screen, because the sentence summed the drafts
       while the dividend read the reducer's field. #963 makes both read the reducer, so they can no longer
       name different numbers -- and the drafts sum stays as the fallback for a state that reports nothing.
       WHAT IS STILL ASSERTED IS THE RULING: one roll, on a turn total rather than a per-train figure. */
    expect(runBlock).toContain("rollTurnRevenue(");
    expect(runBlock).toContain("banked?.printed_route_revenue");
    expect(runBlock).toContain("printedFromDrafts");
    expect(runBlock.match(/rollTurnRevenue\(/g)?.length ?? 0).toBe(1);
  });

  it("seeds the roll on the turn, with no train ordinal", () => {
    /* THE SEED IS THE TURN NOW. A `trainOrdinal` reappearing here would silently re-split the roll while
       every other surface still believed there was one. */
    expect(runBlock).not.toContain("trainOrdinal");
    expect(runBlock).toContain("companyId: actingProtocolId");
  });

  it("asks the shared predicate, not the percentage", () => {
    /* `percent !== 100` is true for a 90% roll that rounded back to the printed figure, and would flash a
       malus over a turn that lost nothing. #938's `revenueOutcome` is the one both surfaces ask. */
    expect(runBlock).toContain('if (revenueOutcome(roll) !== "normal")');
    expect(runBlock).not.toContain("percent !== 100");
    expect(runBlock).not.toContain("percent === 100");
  });

  it("flashes the die's nominal swing", () => {
    expect(runBlock).toContain("delta: revenueDeltaPercent(roll)");
  });

  it("stamps a fresh token per turn", () => {
    expect(APP).toContain("token: nextRevenueFlashToken()");
    expect(APP).toContain("let revenueFlashToken = 0;");
  });

  it("is rendered, not merely computed", () => {
    /* THE INTEGRATION GAP THIS PROJECT KEEPS FINDING -- a correct value that nothing displays. */
    expect(APP).toContain("<RevenueModifierFlash signal={revenueFlash} />");
  });

  it("keeps the variant gate on the whole block", () => {
    /* A standard game must raise no flash and log no modifier sentence. */
    expect(runBlock).toContain("resolveVariants(gameState?.variants).unpredictableRevenue");
  });
});

describe("the run button names a projection, not a promise (design note #942)", () => {
  /* ==================================================================
      ADDED BECAUSE A NEGATIVE CONTROL FOUND NOTHING TO FAIL
     ==================================================================
     RULED: "update the submission button in the Action Bar to read: `Run Trains for Projected Revenue: $X`,
     where $X is the standard 100% printed total of all valid routes currently plotted."
     I CHANGED THE COPY AND WROTE NO TEST. A control that reverted it to the old "Run Routes for $X" ran
     against no suite at all -- `No tests found` -- which is the same integration gap this project keeps
     finding, arriving as an absence of coverage rather than an absence of wiring. */
  const PANEL = readStripped("components/RoutePlannerPanel.tsx");

  it("reads as the ruled sentence", () => {
    expect(PANEL).toContain("Run Trains for Projected Revenue: $");
  });

  it("says it the same way in both controls", () => {
    /* #623'S RULE: both buttons call `onRunRoute` and run every runnable draft, so two copies of one action
       must not read as two actions. "Run Selected Route(s)" described a selection this button does not have. */
    expect(PANEL.match(/Run Trains for Projected Revenue: \$/g)?.length ?? 0).toBe(2);
    expect(PANEL).not.toContain("Run Selected Route(s)");
    expect(PANEL).not.toContain("Run Routes for $");
  });

  it("quotes the printed total, not a modified one", () => {
    /* "the standard 100% printed total". `runnableRouteSummary` sums the drafts' `value`, which is
       `sandboxRouteBreakdown`'s printed figure -- the die has not been rolled at the moment this renders, and
       a button that guessed at it would be promising a number the reducer had not settled. */
    expect(PANEL).toContain("runnableRouteSummary(drafts)");
    expect(PANEL).not.toContain("rollTurnRevenue");
    expect(PANEL).not.toContain("applyRevenuePercent");
  });

  it("still falls back to a bare label with nothing runnable", () => {
    /* #623: "$0" reads as a route that pays nothing rather than as no route at all. */
    expect(PANEL).toContain(': "Run Trains"');
  });
});
