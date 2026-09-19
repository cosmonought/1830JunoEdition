/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1450 (harness): A FIRST RUN IS 100%, AND THE WINDOW IS NOT CONSULTED
// ==================================================================
//
// THE BEHAVIOUR, not the spelling. `uiScale.test.ts` pins the architecture -- which roots carry the zoom,
// which surfaces counter-zoom, that no reciprocal is ever written as a literal. This file pins what a reader
// actually gets, by resolving the scale under real window conditions.
//
// WHY EVERY CASE RE-IMPORTS THE MODULE. `uiScale.ts` resolves ONCE, in its module body, so that the value
// exists before React mounts and the first painted frame is already the right size (#1294, and an audit
// measured 112 frames with no second value). A test that wants to know what a different window resolves to
// therefore has to evaluate the module again -- `jest.resetModules()` -- which is also the only honest way to
// assert "the width is not consulted": we hand it eleven different widths and expect one answer.
//
// WHAT WAS REMOVED AND WHY IT CANNOT COME BACK QUIETLY. #1273's `defaultUiScaleFor(width)` interpolated
// #1149's 0.63 across the window, which drew 13px body text at 8.19px on a 1920 viewport. The measurements
// are in `claude/app-scaling-audit-2026-09-17.md`. The absence cases below are what stop a width, a
// `devicePixelRatio` or a resize listener from becoming an input again.

export {};

const KEY = "1830juno.ui_scale.v1";
const WIDTHS = [320, 390, 430, 768, 1024, 1200, 1366, 1440, 1536, 1920, 2560];
const LADDER = [0.63, 0.75, 0.9, 1, 1.1, 1.25];

/** Evaluate `uiScale.ts` afresh with the window in a given state -- the only way to see what a first run
 *  resolves to, because the module resolves once at load. */
function loadAt(width: number, { dpr = 1, stored = null }: { dpr?: number; stored?: string | null } = {}) {
  jest.resetModules();
  window.localStorage.clear();
  if (stored !== null) window.localStorage.setItem(KEY, stored);
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true, writable: true });
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  return require("./uiScale") as typeof import("./uiScale");
}

afterEach(() => {
  window.localStorage.clear();
});

describe("a clean first run is 100%, at every width (design note #1450)", () => {
  it.each(WIDTHS)("resolves to 1 at %ipx with nothing stored", (width) => {
    const m = loadAt(width);
    expect(m.resolveUiScale()).toBe(1);
    expect(m.getUiScale()).toBe(1);
    expect(m.UI_SCALE_DEFAULT).toBe(1);
  });

  it("gives the same answer at every width -- the window is not an input", () => {
    /* THE COUNT IS THE ASSERTION. One distinct value across eleven widths is the claim "width does not
       influence the default" stated in the only terms that can fail. */
    const answers = WIDTHS.map((w) => loadAt(w).resolveUiScale());
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(1);
  });

  it("gives the same answer at every device-pixel ratio", () => {
    /* The audit measured DPR 1, 1.25, 1.5 and 2 in a real browser and the app ignored all of them. Asserted
       here so that a future attempt to read the DPR has to delete a test that says not to. */
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const width of [390, 1440, 2560]) {
        expect([dpr, width, loadAt(width, { dpr }).resolveUiScale()]).toEqual([dpr, width, 1]);
      }
    }
  });

  it("does not read the window, the screen or the pixel ratio at all", () => {
    const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
    const source = readStripped("utils/uiScale.ts");
    for (const signal of ["innerWidth", "outerWidth", "screen.", "devicePixelRatio", "visualViewport", "matchMedia"]) {
      expect([signal, source.includes(signal)]).toEqual([signal, false]);
    }
    // and the width-derived default is deleted, not parked behind a branch
    expect(source).not.toContain("defaultUiScaleFor");
  });

  it("adds no resize-driven rescaling", () => {
    /* #1450 removes an automatic default; it must not reintroduce one that fires on resize. The store has no
       listener of its own, and nothing in the module subscribes to the window. */
    const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
    const source = readStripped("utils/uiScale.ts");
    expect(source).not.toContain("addEventListener");
    expect(source).not.toContain("ResizeObserver");
    const m = loadAt(1440);
    const before = m.getUiScale();
    Object.defineProperty(window, "innerWidth", { value: 2560, configurable: true, writable: true });
    window.dispatchEvent(new Event("resize"));
    expect(m.getUiScale()).toBe(before);
  });
});

describe("an explicit choice still wins, and still means what it meant (design note #1450)", () => {
  it.each(LADDER)("restores a stored %f at a narrow width and a wide one", (step) => {
    for (const width of [390, 2560]) {
      const m = loadAt(width, { stored: String(step) });
      expect([width, m.resolveUiScale()]).toEqual([width, step]);
      expect([width, m.getUiScale()]).toEqual([width, step]);
    }
  });

  it("keeps the key and the serialised meaning", () => {
    const m = loadAt(1440);
    expect(m.UI_SCALE_STORAGE_KEY).toBe(KEY);
    m.setUiScale(0.63);
    expect(window.localStorage.getItem(KEY)).toBe("0.63");
    expect(loadAt(1920, { stored: "0.63" }).resolveUiScale()).toBe(0.63);
  });

  it("reads values written before this change exactly as it did before", () => {
    /* NO MIGRATION. Every value the old picker could have written is a step, and snapping is unchanged, so a
       preference saved yesterday resolves today to the same number. The two off-ladder cases are the ones
       `snapUiScale` has always folded in, asserted so that "we did not reinterpret anything" is checkable. */
    for (const [stored, expected] of [["0.63", 0.63], ["0.75", 0.75], ["0.9", 0.9], ["1", 1], ["1.1", 1.1], ["1.25", 1.25],
                                      ["0.7", 0.75], ["2.5", 1.25]] as const) {
      expect([stored, loadAt(1920, { stored }).resolveUiScale()]).toEqual([stored, expected]);
    }
    // and a value that was never a scale still falls through to the default rather than to a guess
    for (const junk of ["abc", "0", "-1", ""]) {
      expect([junk, loadAt(1920, { stored: junk }).resolveUiScale()]).toEqual([junk, 1]);
    }
  });

  it("keeps the ladder exactly, and walks it from the default in both directions", () => {
    const m = loadAt(1920);
    expect(Array.from(m.UI_SCALE_STEPS)).toEqual(LADDER);
    /* The picker moves by index from wherever it is; a first run starts on the fourth rung, so there are
       three steps down to 0.63 and two up to 1.25 -- and 63% is still reachable. */
    const at = m.UI_SCALE_STEPS.indexOf(m.getUiScale());
    expect(at).toBe(3);
    const walked: number[] = [];
    for (let i = at - 1; i >= 0; i -= 1) { m.setUiScale(m.UI_SCALE_STEPS[i]); walked.push(m.getUiScale()); }
    expect(walked).toEqual([0.9, 0.75, 0.63]);
    const up: number[] = [];
    for (let i = 1; i < m.UI_SCALE_STEPS.length; i += 1) { m.setUiScale(m.UI_SCALE_STEPS[i]); up.push(m.getUiScale()); }
    expect(up).toEqual([0.75, 0.9, 1, 1.1, 1.25]);
    expect(window.localStorage.getItem(KEY)).toBe("1.25");
  });
});

describe("the scale is settled before anything renders (design note #1294, kept by #1450)", () => {
  it("resolves in the module body, so the first read already has the final value", () => {
    /* THE FLASH THIS PREVENTS. If the value were resolved in an effect, the first painted frame would carry
       one scale and the second another -- which an audit checked for in a real browser (112 frames, one
       value). Here the claim is the mechanism: importing the module is enough, with no render and no tick. */
    const m = loadAt(2560, { stored: "1.25" });
    expect(m.getUiScale()).toBe(1.25);   // no mount, no effect, no timer has run
    const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
    const source = readStripped("utils/uiScale.ts");
    expect(source).toContain("let current = resolveUiScale();");
    expect(source).not.toContain("useEffect");
  });
});
