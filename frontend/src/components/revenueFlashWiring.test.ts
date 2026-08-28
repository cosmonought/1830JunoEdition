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
        THE RULING, AS AN ABSENCE -- AND #960 HAD TO BE LET THROUGH DELIBERATELY
       ==================================================================
       Every property that would give this a window is named, because "floating text ONLY" is a constraint on
       what must NOT appear and a positive assertion cannot express it.
       `textShadow` WAS ALWAYS EXEMPT -- a halo is not a box, and it is the same trick #364 uses on the hex
       badge for the same reason: legibility over a board of four different colours.
       #960'S GLOW IS THE SAME FAMILY AND WOULD HAVE PASSED THIS CASE UNTOUCHED, which is why it is called out
       here instead. It sets `background` with a radial gradient, not `backgroundColor`, so every assertion
       below would still have held while a coloured field appeared behind the figure. Slipping past an absence
       test on a technicality makes the test worthless for everything it still guards.
       THE LINE THAT ACTUALLY MATTERS IS THE EDGE. A box has a rim; this reaches full transparency inside its
       own bounds, so no rectangle is visible at any opacity. The case below asserts that directly rather than
       trusting the distinction to prose. */
    expect(FLASH).not.toContain("backgroundColor");
    expect(FLASH).not.toContain("borderRadius");
    expect(FLASH).not.toContain("boxShadow");
    expect(FLASH).not.toContain("border:");
    expect(FLASH).not.toContain("padding");
  });

  it("keeps the glow edgeless (design note #960)", () => {
    /* THE PROPERTY THAT SEPARATES A GLOW FROM A PLATE. `radial-gradient` with a fully transparent stop before
       the boundary has no rim to read as a shape; a solid `background`, or a gradient whose last stop still
       carries alpha, is a coloured rectangle with soft corners. */
    const ANIM = readStripped("styles/animations.ts");
    expect(FLASH).toContain("radial-gradient(closest-side");
    expect(FLASH).toContain("rgba(0, 0, 0, 0) 70%");
    /* AND IT SITS BEHIND THE GLYPHS. Without the negative stacking it would wash out the figure it exists to
       lift off the board -- the exact opposite of the job. */
    const glow = sliceBetween(ANIM, ".app-revenue-glow {", "}");
    expect(glow).toContain("z-index: -1");
    expect(glow).toContain("pointer-events: none");
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
    /* THE RULING'S ARITHMETIC AT THE CALL SITE: the sum of the drafts it just dispatched, not a per-train
       figure and not a state read (#934's race). */
    expect(runBlock).toContain("rollTurnRevenue(printedTurnTotal");
    expect(runBlock).toContain("runnable.reduce((sum, draft) => sum + (draft.value ?? 0), 0)");
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
