/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 869 (harness): THE HEAD IS THE CHIP THAT OPENED IT
// ==================================================================
//
// ASKED: "when I click the train chip on Run Routes to see what hexes it's going through, the printed string
// text is: '2 F6 $30 -> F2 $40' and I'm wondering if rather than or in addition to '2' we put the full train
// chip (the one showing the revenue center marks) and color it the color matching the route color?"
//
// THREE CLAIMS TO KEEP, and they are separable, so they get separate tests: the glyph draws the reach, the
// ink comes from the one function that owns route colour, and the head matches the chip it belongs to.

import { routeTrainColor, ROUTE_TRAIN_COLORS } from "../styles/routeLivery";

const read = (rel: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
};
/* #490a: the note below quotes the markup it replaced, so code assertions read a comment-stripped copy. */
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const RAW = read("components/RouteChipDetail.tsx");
const DETAIL = strip(RAW);
const GLYPH = strip(read("components/TrainGlyph.tsx"));
const APP_STYLES = strip(read("styles/appStyles.ts"));

describe("the glyph is the revenue-centre marks", () => {
  it("draws one carriage per revenue centre the train reaches", () => {
    /* THE THING THE REPORT CALLED "the revenue center marks". `cars` is the train's reach, so a 3-Train's
       chip has three carriages and a 5-Train five -- the glyph answers "how far" without a number, which is
       why it is worth having beside one rather than instead of it. */
    expect(GLYPH).toContain('const cars = !carriages ? 0 : tier === "D" ? 3 : Math.min(6, Number(tier) || 0);');
  });

  it("keeps the Diesel's three dots meaning onward, not three", () => {
    // #617: "and onward", not a count -- a Diesel has no limit and must not appear to have one of 3.
    expect(GLYPH).toContain('isDiesel');
    expect(RAW).not.toContain("carriages={false}");
  });

  it("is asked for carriages in the detail head", () => {
    /* THE DEFAULT IS `true` AND THAT IS EASY TO LOSE. `TrainChips` passes `carriages={false}` for its fleet
       badges, so the wrong copy-paste here would silently drop the marks the report asked for. Asserted as
       the absence above and as the presence of the glyph here. */
    expect(DETAIL).toContain("<TrainGlyph");
    expect(DETAIL).toContain("color={routeInk}");
  });
});

describe("the head, the chip and the line are one colour", () => {
  it("takes its ink from the one function that owns route colour", () => {
    /* #494 built this palette because a corporation's three routes were drawn in one colour. A second
       opinion here -- a local hue, or the corporation livery -- would put the head out of step with the line
       it describes, which is the whole point of tinting it. */
    expect(DETAIL).toContain("const routeInk = routeTrainColor(draft.trainIndex);");
    expect(DETAIL).not.toContain("ROUTE_TRAIN_COLORS[");
  });

  it("tints the glyph and the name together", () => {
    /* BOTH OR NEITHER. A tinted locomotive beside a default-ink name would read as two objects, which is the
       thing being fixed. */
    expect(DETAIL).toContain("<span style={{ color: routeInk }}>{model}-Train</span>");
  });

  it("carries the ink on the same rule the chip above uses", () => {
    /* `condensedTrainChip` puts the route ink on a 2px bottom border. The head wears it the same way, so a
       player can see that this disclosure belongs to that chip. */
    expect(DETAIL).toContain("borderBottomColor: routeInk");
    const at = APP_STYLES.indexOf("  condensedTrainChip: {");
    expect(at).toBeGreaterThan(-1);
    const chip = APP_STYLES.slice(at, APP_STYLES.indexOf("\n  },", at));
    expect(chip).toContain('borderBottomWidth: "2px"');
  });

  it("agrees with that chip's shell rather than inventing a second one", () => {
    /* THE SHAPE HAS TO MATCH TOO, or the colour alone will not make them read as one object. Checked
       property by property against `condensedTrainChip` so a change to either side shows up here. */
    const at = APP_STYLES.indexOf("  condensedTrainChip: {");
    const chip = APP_STYLES.slice(at, APP_STYLES.indexOf("\n  },", at));
    const head = DETAIL.slice(DETAIL.indexOf("  model: {"), DETAIL.indexOf("\n  },", DETAIL.indexOf("  model: {")));
    expect(head.length).toBeGreaterThan(0);
    ['padding: "2px 8px"', 'borderRadius: "6px"', 'backgroundColor: "#232936"', 'gap: "6px"'].forEach(
      (property) => {
        expect(chip).toContain(property);
        expect(head).toContain(property);
      },
    );
  });

  it("declares its borders as longhands (design note #840)", () => {
    /* THE REACT DIFFING TRAP, and this style walks straight into its preconditions: `borderBottomColor` is
       overridden per route beside a base that declares the rest. With a `border` shorthand in the base, the
       render that drops the override writes `borderBottomColor = ""` and does not re-apply the unchanged
       shorthand -- a `currentColor` rule, which is #840's near-white frame in a new place. */
    const head = DETAIL.slice(DETAIL.indexOf("  model: {"), DETAIL.indexOf("\n  },", DETAIL.indexOf("  model: {")));
    expect(head).toContain('borderWidth: "1px"');
    expect(head).toContain('borderStyle: "solid"');
    expect(head).toContain('borderColor: "#3a4150"');
    expect(head).not.toMatch(/\bborder: /);
  });
});

describe("the palette still tells six trains apart", () => {
  it("gives consecutive trains different inks", () => {
    /* THE PRECONDITION FOR ANY OF THIS MEANING ANYTHING. If two of a corporation's trains shared a colour the
       head would point at the wrong line. Asserted here rather than trusted because this is the first surface
       to put the route ink next to a train's NAME, where a collision would be obvious and confusing. */
    const inks = [0, 1, 2, 3].map((index) => routeTrainColor(index));
    expect(new Set(inks).size).toBe(4);
  });

  it("still answers for an index past the palette", () => {
    // WRAPS rather than falling back, so two trains never collapse to one colour. `routeLivery.ts`'s own rule.
    expect(routeTrainColor(ROUTE_TRAIN_COLORS.length)).toBe(ROUTE_TRAIN_COLORS[0]);
    expect(routeTrainColor(-1)).toBe(ROUTE_TRAIN_COLORS[0]);
  });
});
