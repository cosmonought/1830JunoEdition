// frontend/src/styles/routeLivery.test.ts
//
// ==================================================================
//  DESIGN NOTES 494 / 495 (harness)
// ==================================================================
//
// Two faults behind one report ("overlapping routes are indistinguishable"),
// and neither could be caught by looking at the code that drew them.
//
//   THE COLOUR WAS THE CORPORATION'S. `App.manualRouteOverlay` computed one
//   ink above its loop and gave it to every train, so three routes were the
//   same line drawn three times. `RouteOverlay.color`'s own doc has always
//   promised "one distinct colour per train"; nothing asserted it.
//
//   THE EMPHASIS WAS NEVER SET. `drawRouteOverlays` has honoured
//   primary/muted since design note #373 and `highlightedTrainIndex` has
//   been raised by the chips for as long -- with nothing in between.
//
// WHAT IS ASSERTED HERE IS SEPARATION, NOT THE HEX VALUES. Pinning the six
// literals would pass against a palette of six near-identical blues, which
// is the failure mode that matters: the bug was never a wrong colour, it was
// two colours that were the same. So the tests measure the property --
// pairwise distance, hue spread, luminance against a dark board -- the same
// way `corporationLivery.test.ts` pins a contrast guarantee rather than a
// list of strings.

import {
  ROUTE_TRAIN_COLORS,
  routeEmphasisFor,
  routeTrainColor,
} from "./routeLivery";

function rgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

/** Straight RGB distance. Crude next to a real perceptual metric, and
 *  sufficient for the question asked: are any two of these the same colour. */
function distance(a: string, b: string): number {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

/** Hue in degrees, for the spread check. */
function hue(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** Relative luminance, the same formula `corporationLivery` uses. */
function luminance(hex: string): number {
  const linear = rgb(hex)
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

describe("the palette", () => {
  it("is well-formed hex", () => {
    for (const color of ROUTE_TRAIN_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("has headroom past 1830's real train limit", () => {
    // Four trains is the ceiling (Phases 2-3); the palette carries more so
    // the wrap is never reached in a legal game.
    expect(ROUTE_TRAIN_COLORS.length).toBeGreaterThanOrEqual(4);
  });

  it("contains no duplicates", () => {
    // THE BUG, in its smallest form: two trains, one colour.
    expect(new Set(ROUTE_TRAIN_COLORS).size).toBe(ROUTE_TRAIN_COLORS.length);
  });

  it("keeps every pair far apart, not merely unequal", () => {
    /* Distinct strings are not distinct colours. `#38bdf8` and `#38bdf9`
       would pass the duplicate test above and be indistinguishable on a
       board, which is the whole complaint. */
    for (let i = 0; i < ROUTE_TRAIN_COLORS.length; i += 1) {
      for (let j = i + 1; j < ROUTE_TRAIN_COLORS.length; j += 1) {
        expect(distance(ROUTE_TRAIN_COLORS[i], ROUTE_TRAIN_COLORS[j])).toBeGreaterThan(60);
      }
    }
  });

  it("separates the first four by HUE, not just by brightness", () => {
    /* The four a real corporation can actually hold. Two colours can sit far
       apart in RGB and still read as "the light one and the dark one" of the
       same hue, which is exactly what a player cannot tell apart on a thin
       line at low zoom. */
    const hues = ROUTE_TRAIN_COLORS.slice(0, 4).map(hue);
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        const raw = Math.abs(hues[i] - hues[j]);
        const separation = Math.min(raw, 360 - raw);
        expect(separation).toBeGreaterThan(30);
      }
    }
  });

  it("stays light enough to read on a dark board", () => {
    /* Design note #494b: the route line is a third of the rail's width and
       is drawn inside the track's own dark ink. A dark route ink disappears
       into it. This is the threshold `glowColorFor` lifts toward; these are
       chosen above it instead. */
    for (const color of ROUTE_TRAIN_COLORS) {
      expect(luminance(color)).toBeGreaterThan(0.32);
    }
  });
});

describe("routeTrainColor", () => {
  it("gives consecutive trains different inks", () => {
    // The assertion the reported bug fails: train 0 and train 1 must differ.
    expect(routeTrainColor(0)).not.toBe(routeTrainColor(1));
    expect(routeTrainColor(1)).not.toBe(routeTrainColor(2));
    expect(routeTrainColor(2)).not.toBe(routeTrainColor(3));
  });

  it("is stable for one index", () => {
    // The map and the planner chip both call this; a colour that varied per
    // call would break the join design note #373 depends on.
    expect(routeTrainColor(2)).toBe(routeTrainColor(2));
  });

  it("wraps rather than falling back to one shared colour", () => {
    /* A single fallback past the end would make two trains identical again,
       which is the bug. Wrapping keeps them different for as long as
       possible. */
    expect(routeTrainColor(ROUTE_TRAIN_COLORS.length)).toBe(ROUTE_TRAIN_COLORS[0]);
    expect(routeTrainColor(ROUTE_TRAIN_COLORS.length + 1)).toBe(ROUTE_TRAIN_COLORS[1]);
  });

  it("returns a real colour for nonsense rather than undefined", () => {
    // A rendering decision: no colour at all is worse than the first one.
    for (const bad of [-1, -99, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(routeTrainColor(bad)).toBe(ROUTE_TRAIN_COLORS[0]);
    }
    expect(routeTrainColor(1.7)).toBe(ROUTE_TRAIN_COLORS[1]);
  });
});

describe("routeEmphasisFor", () => {
  it("draws everything normally when nothing is highlighted", () => {
    /* THE CASE THAT MATTERS. `null` means "no cursor on any row", which is
       most of the time -- reading it as "highlight nothing" would mute every
       route on the board whenever the pointer left the panel. */
    expect(routeEmphasisFor(0, null)).toBe("normal");
    expect(routeEmphasisFor(3, null)).toBe("normal");
  });

  it("promotes the highlighted train and mutes the rest", () => {
    expect(routeEmphasisFor(1, 1)).toBe("primary");
    expect(routeEmphasisFor(0, 1)).toBe("muted");
    expect(routeEmphasisFor(2, 1)).toBe("muted");
  });

  it("promotes exactly one train", () => {
    // Two primaries would be no highlight at all.
    const emphases = [0, 1, 2, 3].map((i) => routeEmphasisFor(i, 2));
    expect(emphases.filter((e) => e === "primary")).toHaveLength(1);
    expect(emphases.filter((e) => e === "muted")).toHaveLength(3);
  });

  it("treats train 0 as highlightable", () => {
    /* The falsy-zero trap: a `highlightedTrainIndex && ...` guard would make
       the first train the one train that cannot be highlighted, and it is
       the one selected by default. */
    expect(routeEmphasisFor(0, 0)).toBe("primary");
    expect(routeEmphasisFor(1, 0)).toBe("muted");
  });
});
