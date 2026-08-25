/** @jest-environment node */

// No runtime imports: this file reads source text.
export {};
//
// The Run Routes step lives in the bar: chips open, one route at a time.
//
// ==================================================================
//  DESIGN NOTES 800 / 801 / 802 (harness): THE PANEL BECOMES A LINE
// ==================================================================
//
// REQUESTED twice, and skipped by me once: "the Run Routes fixed subpanel can be completely done away with in
// exchange for the ability to click the train chips and have the sticky Action bar expand slightly to list
// its route."
//
// REPORTED BESIDE IT: "the train chips with their respective revenue values are still not displaying on other
// players' Action bars, even though the routes themselves are highlighted on the map."
//
// THOSE ARE ONE PROBLEM AND #787 ANSWERED THE WRONG HALF. That pass widened the audience for
// `RoutePlannerPanel` -- every route for every train, always -- when what a watcher needs is ONE train's
// figures on demand. It was the second UI change this week that a source scan blessed and a playthrough
// disproved, which is why the assertions below are about STRUCTURE (what is mounted, what is gone, which
// props reach which control) and why the visual result is still a playtest question.
//
// THE CONTROLS SPLIT BY WHAT THEY ACT ON, which is the arrangement asked for: "Auto Route and Run in the
// sticky bar beside the chips. Clear in the expanded chip panel?" Auto Route and Run were ALREADY in the
// button row (#623) -- half the request was built and neither of us had noticed.

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
const CHIPS = strip(read("components/TrainBadges.tsx"));
const DETAIL = strip(read("components/RouteChipDetail.tsx"));

describe("the subpanel is gone from the step", () => {
  it("no longer mounts the planner", () => {
    expect(BAR).not.toContain("<RoutePlannerPanel");
  });

  it("mounts the chip detail in its place", () => {
    expect(BAR).toContain("{showRouteReadout && (");
    expect(BAR).toContain("<RouteChipDetail");
  });

  it("keeps the component file for its other exports", () => {
    /* `AutoRouteButton`, `RunRoutesButton` and the `TrainRouteDraft` type all still live there and are all
       still used. Deleting the file to finish the request would have taken three live exports with it. */
    expect(BAR).toContain('import { AutoRouteButton, RunRoutesButton } from "../components/RoutePlannerPanel"');
    expect(BAR).toContain("<AutoRouteButton");
    expect(BAR).toContain("<RunRoutesButton");
  });
});

describe("the controls split by what they act on", () => {
  it("leaves Auto Route and Run in the button row", () => {
    /* THE HALF THAT WAS ALREADY BUILT. #623 put both on the bar when it became sticky; the request asked for
       exactly where they already were. */
    expect(BAR).toContain("{showRouteToggle && (");
    expect(BAR.indexOf("<AutoRouteButton")).toBeLessThan(BAR.indexOf("<RouteChipDetail"));
  });

  it("puts Clear with the train it clears", () => {
    expect(DETAIL).toContain("onClearRoute(draft.trainIndex)");
    expect(DETAIL).toContain(">\n          Clear\n        </button>");
  });

  it("offers Clear only to the player who can use it", () => {
    /* A watcher reads the route; they do not edit somebody else's. `canClear` carries both the turn and the
       session, so a disabled-looking Clear never appears for a spectator. */
    expect(DETAIL).toContain("{canClear && stops.length > 0 && (");
    expect(BAR).toContain("canClear={mayActThisTurn && sessionReady}");
  });
});

describe("a chip is a handle", () => {
  it("opens a route on click", () => {
    expect(CHIPS).toContain("onClick={interactive && onSelectTrain");
    expect(BAR).toContain("onSelectTrain={(index) => {");
  });

  it("toggles the same chip shut", () => {
    // Clicking the open chip closes it, which is the only way back to a bar with no strip in it.
    expect(BAR).toContain("setOpenTrainIndex((open) => (open === index ? null : index))");
  });

  it("is reachable from a keyboard", () => {
    /* A control that only answers a mouse is not a control on a tablet or for a keyboard player -- and the
       chip is a styled `span` shared by four surfaces, so it gets the role rather than being rewrapped. */
    expect(CHIPS).toContain('role={interactive && onSelectTrain ? "button" : undefined}');
    expect(CHIPS).toContain("tabIndex={interactive && onSelectTrain ? 0 : undefined}");
    expect(CHIPS).toContain("onKeyDown={");
    expect(CHIPS).toContain("event.preventDefault();");
  });

  it("keeps hover and selection apart", () => {
    /* #375's hover still previews on the map and is transient; the click is durable. Collapsing the two would
       make the strip flicker as the pointer crossed the row. */
    expect(CHIPS).toContain("onMouseEnter={interactive ? () => onHighlightTrain?.(index) : undefined}");
    expect(CHIPS).toContain("selectedTrainIndex === index ? styles.chipSelected");
  });

  it("marks the open chip without using its fill", () => {
    // The fill already carries the rust state (#755); a second meaning on one channel is #732's failure.
    expect(CHIPS).toContain("chipSelected: {");
    expect(CHIPS).toContain('outline: "2px solid');
  });
});

describe("the readout belongs to everyone", () => {
  it("renders on the step rather than on the turn", () => {
    /* THE REPORTED BUG. `showRouteReadout` has no `mayActThisTurn` in it -- that is the whole difference
       between a watcher seeing the figures and not. */
    expect(BAR).toContain(
      'const showRouteReadout = roundType === "OperatingRound" && orSubPhase === "Routes";',
    );
  });

  it("shows the per-stop values that were missing", () => {
    // "the train chips with their respective revenue values" -- the values are the point of the strip.
    expect(DETAIL).toContain("styles.stopValue");
    /* ONE dollar, not two: this is JSX, so `${stop.value}` in the markup is a literal `$` beside an
       expression -- not a template literal. The first draft doubled it out of habit from the harnesses that
       search real template strings, and failed correctly. */
    const dollar = String.fromCharCode(36);
    expect(DETAIL).toContain(dollar + "{stop.value}");
  });

  it("takes the route total from the draft rather than re-summing", () => {
    /* #775's rule. An off-board terminus can be worth more than its printed face, so a sum of the stops is
       not the route's value -- and a second arithmetic is how the two come apart. */
    expect(DETAIL).toContain("draft.value ?? 0");
  });

  it("says something when a train has no route yet", () => {
    // The commonest thing a president clicks on their own turn; a blank strip would read as a failure.
    expect(DETAIL).toContain("No route drafted for this train yet.");
  });

  it("keeps the planner's refusals visible", () => {
    /* The panel carried `clickFeedback`. Deleting the panel without rehoming it would have left a refused
       draft explaining itself nowhere -- #778's lesson in a different surface. */
    expect(DETAIL).toContain("{feedback && <span style={styles.problem}>{feedback}</span>}");
    expect(BAR).toContain("feedback={mayActThisTurn ? routeFeedback : null}");
  });

  it("closes itself when the step ends", () => {
    // A chip left open into a round with no routes in it would be a strip about nothing.
    expect(BAR).toContain("if (!showRouteReadout) setOpenTrainIndex(null);");
  });
});

describe("the obligation sentence is gone and its rule is not", () => {
  it("no longer prints the caption", () => {
    /* #800. "B&O has a route it can run, so it must. Which route is up to you." -- reported as unnecessary
       prose about what the UI already enforces. */
    expect(BAR).not.toContain("orPanelObligation");
    expect(read("utils/routeStep.ts")).toContain("has a route it can run, so it must");
  });

  it("still withdraws Skip when a run is owed", () => {
    /* #41's enforcement, which IS the thing the report calls "what the UI already enforces". Deleting the
       predicate with its sentence would have removed the rule while appearing to satisfy the request. */
    expect(BAR).toContain("!routeObligation && (");
  });

  it("deleted the orphaned style key", () => {
    // #772: a `Record<string, CSSProperties>` hides an unused key from both `tsc` and ESLint.
    expect(strip(read("styles/appStyles.ts"))).not.toContain("orPanelObligation");
  });
});
