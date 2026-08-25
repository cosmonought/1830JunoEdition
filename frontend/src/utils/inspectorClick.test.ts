/** @jest-environment node */
//
// Who may still click the board while somebody else lays track. No DOM.
//
// ==================================================================
//  DESIGN NOTE 809 (harness): A RULE WRITTEN IN THE NOTE AND NOT IN THE CONDITION
// ==================================================================
//
// REPORTED as a regression: "non-active players used to be able to click the rail map and view possible track
// lays on any tile at any time. This ability seems to be blocked now during the active player's Lay Track
// subphase."
//
// #716 STATED THIS EXACT RULE AND SHIPPED A CONDITION THAT DID NOT ASK IT: "a spectator or a player browsing
// between turns keeps the inspector on every hex". The condition was `layTrackFocus && ...`, and
// `layTrackFocus` is derived from the STEP (#437: "the STEP, not the inspector") -- so during any president's
// Track step it is defined for every seated viewer, and the gate swallowed everybody's clicks.
//
// IT WAS ALSO MEASURING WATCHERS AGAINST THE ACTING CORPORATION'S NETWORK, because that is what the glow set
// is built from. There is no reading of the rules under which a watcher's click is "out of network".
//
// THE SESSION'S RECURRING SHAPE, one more time: a rule the prose asserts and the authority is never asked
// about. It is the third instance this week (#774, #807, and this) and the second where the note that got it
// right sat directly above the code that got it wrong.
//
// WHY THIS IS A UNIT TEST AND NOT A SOURCE SCAN. The gate used to live inside a `useCallback` in a
// 10,000-line component, which is reachable by no test at all -- that is a large part of why prose was doing
// the work. Four booleans extracted is four booleans that can be asserted; the scan at the bottom only checks
// that `App` still asks them.

import { inspectorClickRefused } from "./inspectorClick";

const HEX = "2,7";
const GLOW: ReadonlySet<string> = new Set(["1,7", "1,8"]);

const refused = (over: Partial<Parameters<typeof inspectorClickRefused>[0]> = {}) =>
  inspectorClickRefused({
    actingViewer: true,
    layFocusHighlighted: GLOW,
    hexKey: HEX,
    privateTileHexKey: null,
    ...over,
  });

describe("a watcher keeps the inspector", () => {
  it("REGRESSION: does not swallow a non-acting viewer's click", () => {
    /* THE REPORT. Everything else about this call is the refusing case -- the glow exists and the hex is
       outside it -- so `actingViewer` is doing all the work, which is the point. */
    expect(refused({ actingViewer: false })).toBe(false);
  });

  it("does not swallow it on a hex inside the glow either", () => {
    // The trivial half, asserted so "watchers may click" cannot later be narrowed to "only where it fits".
    expect(refused({ actingViewer: false, hexKey: "1,7" })).toBe(false);
  });

  it("keeps refusing the player who is actually laying", () => {
    /* THE CONTROL, and the reason this is not simply "delete the gate". #716's report was real: "when I click
       a hex not in my network, it highlights just that hex (no tileselector menu pops up for it) and dims
       every other hex: it would be better if clicking those out-of-network hexes did nothing." */
    expect(refused()).toBe(true);
  });
});

describe("the gate still asks everything #716 and #725 gave it", () => {
  it("lets the acting player click inside their own reach", () => {
    expect(refused({ hexKey: "1,8" })).toBe(false);
  });

  it("does nothing when there is no glow to be outside of", () => {
    /* #437: outside the Lay Track step there is no veil to deepen and no network to be out of, so every hex
       is inspectable for everybody. `undefined` is the step saying so. */
    expect(refused({ layFocusHighlighted: undefined })).toBe(false);
  });

  it("does nothing when the reach is unknowable", () => {
    /* An empty glow is not the same as an absent one, and both must fall through: `layTrackFocus` is
       `undefined` when the reach cannot be computed, and dimming the whole board then "reads as broken"
       (#224). An empty SET, though, is a real answer -- nothing fits anywhere -- and refusing every hex would
       be correct for the actor. */
    expect(refused({ layFocusHighlighted: new Set() })).toBe(true);
    expect(refused({ actingViewer: false, layFocusHighlighted: new Set() })).toBe(false);
  });

  it("never refuses a private power's own hex", () => {
    /* Design note #725: the D&H's lay ignores connectivity, which is the whole value of the power -- so the
       gate that enforces connectivity must not refuse it. This was reported once already ("it illuminates the
       correct hex, but it does not allow me to actually lay track") and must not regress behind the fix. */
    expect(refused({ privateTileHexKey: HEX })).toBe(false);
  });

  it("does not extend that exemption to other hexes", () => {
    // The errand is armed for ONE hex. A blanket exemption while it is armed would reopen #716 entirely.
    expect(refused({ privateTileHexKey: "9,9" })).toBe(true);
  });
});

describe("the shell asks the predicate rather than keeping a copy", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs
      .readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  })();

  it("calls it from the hex-click handler", () => {
    expect(APP).toContain("inspectorClickRefused({");
    expect(APP).toContain("actingViewer: isMyTurnRef.current,");
    expect(APP).toContain("layFocusHighlighted: layTrackFocus?.highlighted,");
  });

  it("no longer tests the glow set inline", () => {
    /* THE ASSERTION THAT WOULD HAVE CAUGHT THIS. A second copy of the condition anywhere in the shell is a
       second chance to forget whose turn it is -- which is exactly how the rule and the code came apart. */
    expect(APP).not.toContain("!layTrackFocus.highlighted.has(");
  });

  it("leaves the veil's own turn test alone", () => {
    /* The veil already restricted itself to the actor (`dim: isMyTurn`), which is why the regression looked
       like a broken board rather than a restriction: a watcher saw an UNDIMMED board whose clicks did
       nothing. Half-visible is the worst of the three states -- #786/#787's lesson, in a third surface. */
    expect(APP).toContain("dim: isMyTurn");
  });
});
