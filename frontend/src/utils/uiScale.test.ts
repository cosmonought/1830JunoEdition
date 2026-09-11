/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1144 (harness): ONE SCALE, AND THE FOUR PLACES A PIXEL CHANGES SPACE
// ==================================================================
//
// REPORTED: "not only did the Waiting Room panel grow, so did every other element in the game room ... I have
// to scale my browser to 70% for these things to look right ... if you don't see anything changed that would
// affect their scaling, then this is likely the culprit and we should fix it so that it displays this way at
// 100%."
//
// AND NOTHING HAD CHANGED. `typography.ts` is untouched since "round 26"; the re-theme's diff on the two
// panels named is two lines, both hex values. What the measurement found instead was the shape of the
// original problem: 601 `fontSize` call sites read the scale, and only 21 of 413 paddings read a constant.
// #3's downward pass brought the TYPE down and could not bring the BOXES with it, because the boxes were
// never centralised. That is not fixable by a third pass over a type module -- which is why this batch
// applies the player's own remedy, `zoom`, instead of attempting one.
//
// THE RISK IS NOT "IS THE ZOOM APPLIED". It plainly is; a wrong answer there is visible in the first second.
// The risk is that `zoom` silently splits the app into TWO COORDINATE SPACES and nothing announces the seam:
//
//   LAYOUT pixels   what a stylesheet writes, and what `getComputedStyle().top` reads back.
//   VISUAL pixels   what `getBoundingClientRect()`, `window.innerHeight` and every scroll offset report.
//
// Both are numbers, both look like pixels, and a value from one used in the other is off by 43% -- large
// enough to be a real bug, small enough to read as "the padding looks a bit tight". Every case below guards
// one crossing between the two, or the exemption of a surface that must not be scaled at all.
//
// THE FACTS ABOUT `zoom` ASSERTED HERE WERE MEASURED IN CHROME 148, not reasoned from the spec: a `100vh` box
// inside `zoom: 0.7` comes back 560px on an 800px window (so viewport units DO scale), while a `position:
// fixed; inset: 0` layer inside the same zoom still measures the full window (so fixed geometry does NOT).
// The first of those is why `CHROME_ZOOM` carries a `minHeight`; the second is why the modals needed nothing.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { UI_SCALE, CHROME_ZOOM, styles } =
  require("../styles/appStyles") as typeof import("../styles/appStyles");
/* Design note #1273: the preference behind the constant. */
const { UI_SCALE_DESIGN, UI_SCALE_STEPS, defaultUiScaleFor, snapUiScale } =
  require("./uiScale") as typeof import("./uiScale");

const APP = readStripped("App.tsx");
const APPSTYLES = readStripped("styles/appStyles.ts");
const LOBBY = readStripped("components/Lobby.tsx");
const WAITING = readStripped("components/SandboxWaitingRoom.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");
const RADIAL = readStripped("components/RadialTileSelector.tsx");
const INTRO = readStripped("components/GameIntroOverlay.tsx");
const SIGN = readStripped("components/YellowSignOverlay.tsx");

describe("the scale is one number", () => {
  it("is the figure the player arrived at, not a round one", () => {
    /* A REPORT, NOT A PREFERENCE. A test that only checked "some number is exported" would pass on 0.75 chosen
       because it looked nicer.
       ==================================================================
        DESIGN NOTE 1149: THE SECOND READING, WHICH IS A PRODUCT
       ==================================================================
       IT WAS 0.7, read off the browser's zoom control. REPORTED AFTERWARDS: "I still need to zoom out my
       browser to 90% to get the right aspect" -- and because the two zooms compose as a PRODUCT (the chrome
       lands at `F * s * b` and the board at `W - F * s * b`, so any pair with the same `s * b` is the same
       layout), 0.7 x 0.9 is exactly what the player is looking at rather than an approximation of it.
       ASSERTED AS THE PRODUCT, not as the literal, so the arithmetic is stated where it can be checked. */
    /* Design note #1273: THE THIRD READING MADE IT A PREFERENCE. `UI_SCALE` now resolves through
       `utils/uiScale.ts` -- this browser's stored choice, else a guess from the window's width. Outside a
       browser (this file runs in node) that resolves to the design figure, which is still #1149's product,
       and the guess still lands on it at the widths #1149 measured. */
    expect(UI_SCALE).toBeCloseTo(0.7 * 0.9, 10);
    expect(UI_SCALE).toBe(0.63);
    expect(UI_SCALE_DESIGN).toBe(0.63);
    expect(defaultUiScaleFor(1920)).toBe(0.63);
    expect(defaultUiScaleFor(1200)).toBe(1);
    expect(defaultUiScaleFor(1500)).toBeGreaterThan(0.63);
    expect(defaultUiScaleFor(NaN)).toBe(0.63);
    expect(UI_SCALE_STEPS).toContain(0.63);
    expect(UI_SCALE_STEPS).toContain(1);
    expect(snapUiScale(0.97)).toBe(1);
    expect(APPSTYLES).toContain("export const UI_SCALE = resolveUiScale();");
  });

  it("offers a picker in the bar, which changes the scale live (design note #1294)", () => {
    /* #1149: "TWICE IS THE SIGNAL FOR THE PICKER." #1273 reloaded on change; REPORTED as a black flash that
       cut the radio, and rejected. The scale is a store now: the picker writes it, every surface that draws
       with it reads it through `useUiScale()`, nothing reloads. */
    const TOPBAR = readStripped("components/TopBar.tsx");
    const PICKER = readStripped("components/UiScalePicker.tsx");
    expect(TOPBAR).toContain("<UiScalePicker />");
    // #1336: one component, and the lobby mounts it too, so the first screen has the control.
    expect(readStripped("components/Lobby.tsx")).toContain("<UiScalePicker />");
    expect(PICKER).toContain("setUiScale(UI_SCALE_STEPS[");
    expect(PICKER).not.toContain("window.location.reload()");
    expect(TOPBAR).not.toContain("window.location.reload()");
    expect(readStripped("utils/uiScale.ts")).toContain('"1830juno.ui_scale.v1"');
    expect(readStripped("utils/useUiScale.ts")).toContain("useSyncExternalStore(subscribeUiScale, getUiScale, getUiScale)");
  });

  it("is never spelled out again as a literal", () => {
    /* THE FAILURE THIS PREVENTS IS A HALF-CHANGE. Every counter-zoom in the app is `1 / UI_SCALE` rather than
       1.4285714, so a future scale change moves both ends of every pair together; a literal would leave the
       exemption behind at the old ratio and put the map at 70% of the chrome it sits in.
       CHECKED AS THE ABSENCE OF THE RECIPROCAL, which is the value a hand-written counter-zoom would need and
       nothing else in this codebase has any use for. */
    for (const [name, source] of [
      ["appStyles", APPSTYLES],
      ["board pane's file", APP],
      ["radial selector", RADIAL],
      ["intro overlay", INTRO],
      ["yellow sign", SIGN],
    ] as const) {
      expect([name, source.includes("1.42")]).toEqual([name, false]);
      expect([name, source.includes("1.43")]).toEqual([name, false]);
    }
  });

  it("counter-zooms to exactly one, so an exempt surface is unscaled rather than nearly unscaled", () => {
    /* The two multiply back to 1 in floating point at 0.7; asserted rather than assumed, because a scale that
       did NOT round-trip would leave the board a fraction off its own pixels and read as a soft canvas. */
    expect(Number(CHROME_ZOOM.zoom) * Number(styles.boardPane.zoom)).toBeCloseTo(1, 12);
  });
});

describe("all three screens draw at the same scale", () => {
  /* THE LOBBY AND THE WAITING ROOM ARE EARLY RETURNS ABOVE THE SHELL'S ROOT -- three sibling trees, not one.
     A zoom on the shell alone would have left the game room at 70% between two screens at 100%, and the batch
     immediately before this one spent its length making the footer read the same on all three. */
  it("spreads the same object on each root rather than repeating a declaration", () => {
    /* Design note #1294: the same FUNCTION of the live scale on each root -- `chromeZoomFor(uiScale)`, the
       two declarations `CHROME_ZOOM` carries, computed per render. */
    expect(APPSTYLES).toContain("export function chromeZoomFor(scale: number): React.CSSProperties {");
    expect(APP).toContain("...chromeZoomFor(uiScale),");
    expect(LOBBY).toContain("...styles.root, ...chromeZoomFor(uiScale)");
    expect(WAITING).toContain("...styles.root, ...chromeZoomFor(uiScale)");
    expect(WAITING.split("...chromeZoomFor(uiScale)").length - 1).toBe(2);
  });

  it("carries the viewport-unit correction with the zoom that causes it", () => {
    /* `vh` RESOLVES AGAINST THE REAL VIEWPORT AND IS THEN SCALED (measured), so every one of these three roots
       would have had its floor at 70vh and shown the body colour beneath it -- #1140's footer band again, by
       another route. The correction lives in the same object as the zoom so that deleting one deletes both. */
    expect(CHROME_ZOOM.minHeight).toBe(`${100 / UI_SCALE}vh`);
    expect(String(CHROME_ZOOM.minHeight)).not.toBe("100vh");
  });

  it("puts the lobby's cover arithmetic in the same space on both sides of its max()", () => {
    /* THE ONE PLACE THE ZOOM COULD HAVE BROKEN SILENTLY. `max(100%, 100vh * ratio)` weighs a percentage of a
       zoomed box against an unscaled viewport unit; the comparison stops meaning anything, and #1131's claim
       that "children positioned at 40% or 70% land on the same part of the photograph" rests on this box being
       exactly `cover`. A leftover bare `100vh` here is the bug, so that is what is asserted. */
    /* Design note #1294: the arithmetic moved into `sceneSizeFor(scale)`, applied per render with the live
       scale; the claim is the same and is asked of that function. */
    const scene = sliceBetween(LOBBY, "function sceneSizeFor(scale: number)", "\n}");
    expect(scene).toContain("${100 / scale}vh");
    expect(scene).toContain("${100 / scale}vw");
    expect(scene).not.toContain("(100vh");
    expect(scene).not.toContain("(100vw");
    expect(scene).not.toContain("max(100vh");
    expect(LOBBY).toContain("...styles.scene, ...sceneSizeFor(uiScale)");
  });
});

describe("a measured pixel is converted before it is written back as a length", () => {
  it("divides the status dock's height on its way into the zoomed root", () => {
    /* `getBoundingClientRect().height` is VISUAL; this padding is LAYOUT, and it is written inside the zoom.
       Unconverted it reserves seven-tenths of the dock's real height and the dock covers the last of the log
       -- which is #599's original report, returning through a door nobody was watching. */
    expect(APP).toContain("paddingBottom: `${statusDockHeight / uiScale + 12}px`");
    expect(APP).not.toContain("paddingBottom: `${statusDockHeight + 12}px`");
  });

  it("divides the action bar's clearance on its way onto the scroll target", () => {
    /* Same crossing, same direction: #810 hands `scrollMarginTop` a height measured off a rect so an
       auto-scrolled panel clears the bar. At 70% of itself the bar covers the top of the panel again, which is
       the exact complaint #810 exists to answer. */
    // Design note #1294: the scale at the moment of measurement, from the store.
    expect(BAR).toContain("node.style.scrollMarginTop = `${clearance / getUiScale()}px`");
  });

  it("leaves the observer's root margin alone, which is the same number in the other space", () => {
    /* THE ASYMMETRY IS THE POINT, and it is the one a future reader is most likely to "correct": two lines
       apart, the same `clearance` is divided once and passed through once.
       A CSS LENGTH LANDS INSIDE THE ZOOM. An IntersectionObserver's `rootMargin` adjusts the bounds of the
       ROOT -- the viewport -- which is not inside anything and is already in the visual pixels the clearance
       was measured in. Dividing it would widen the observed region by 43% and the jump button would fall
       silent while the bar still covered the panel it announces. */
    expect(BAR).toContain("rootMargin: `-${clearance}px 0px 0px 0px`");
    expect(BAR).not.toContain("rootMargin: `-${clearance / UI_SCALE}px");
  });

  it("multiplies the sticky offset on its way OUT of the stylesheet", () => {
    /* THE CROSSING THAT GOES THE OTHER WAY, and the one that is invisible today: `getComputedStyle().top`
       returns LAYOUT pixels (measured: "20px" for a `top: 20px` sticky inside `zoom: 0.7`), and it is compared
       against rect tops, which are visual. The bar is `top: 0` today and zero is zero in both spaces -- so
       this guards a rule rather than a symptom, which is the only moment it can be guarded at all.
       ASSERTED AS A SINGLE READ PATH: two call sites, one helper, so the pair cannot drift. */
    expect(BAR).toContain("stickyTopOffset(window.getComputedStyle(node).top) * getUiScale()");
    const reads = BAR.split("stickyTopOffset(window.getComputedStyle").length - 1;
    expect(reads).toBe(1);
    expect(BAR.split("measuredStickyTop(").length - 1).toBeGreaterThanOrEqual(3);
  });
});

describe("what is exempt, and why each one is", () => {
  it("exempts the canvases, which were never what grew", () => {
    /* The report says so directly: "the one thing that doesn't seem to have grown is the Rail Map". Both
       renderers already scale themselves to the viewport. */
    expect(styles.boardPane.zoom).toBeCloseTo(1 / UI_SCALE, 12);
  });

  it("exempts the two full-screen art layers, and nothing else that is fixed", () => {
    /* ART AT VIEWPORT SIZE IS NOT CHROME. The cinematic and the sign are pictures sized to the window, with
       controls and type authored to the picture; the modals are chrome and shrink with the rest, which is why
       they are deliberately absent from this list. */
    // Design note #1294: written per render from the live scale.
    expect(INTRO).toContain("zoom: 1 / uiScale");
    expect(SIGN).toContain("zoom: 1 / uiScale");
    expect(readStripped("components/MarketPeekModal.tsx")).not.toContain("UI_SCALE");
    expect(readStripped("components/AutoPassModal.tsx")).not.toContain("UI_SCALE");
  });

  it("exempts the radial selector, because it is positioned in the board's pixels", () => {
    /* THE SUBTLEST OF THE FOUR. This ring is mounted in the shell's tree but every coordinate it uses comes
       from `canvasEl.getBoundingClientRect()` and from `hexRadiusPx` measured off the same canvas -- visual
       pixels, written as `left`/`top` inside the zoom. It would have opened at seven-tenths of the distance to
       the hex it belongs to: a plausible-looking offset on a small board, plainly wrong on a large one.
       THE RULE, STATED ONCE: a layer positioned in MEASURED pixels must be drawn at the scale those pixels
       were measured at. */
    // Design note #1294: the counter-zoom is written per render on the backdrop from the live scale.
    expect(RADIAL).toContain("{ ...styles.backdrop, zoom: 1 / uiScale }");
    expect(RADIAL).toContain("left: screen?.x ?? 0");
  });

  it("does not exempt the shell's own modals by accident", () => {
    /* The inverse of the case above, and the reason it is worth a test of its own: `zoom` is INHERITED, so an
       exemption placed on a shared ancestor would quietly un-scale everything beneath it. Only roots the tests
       above name may carry a counter-zoom. */
    const counterZooms = APPSTYLES.split("zoom: 1 / UI_SCALE").length - 1;
    expect(counterZooms).toBe(1);
    // Design note #1294: and the shell overrides that one per render with the live scale, nowhere else.
    expect(APP.split("zoom: 1 / uiScale").length - 1).toBe(1);
  });
});
