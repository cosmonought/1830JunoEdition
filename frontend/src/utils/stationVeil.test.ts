/** @jest-environment node */
//
// The Place Station veil: when it shows, and what it lights. Source-level; no React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 754 (harness): A VEIL GATED ON A CURSOR
// ==================================================================
//
// REPORTED: "the 'Place Station' action subphase lifts the network veil, but the network veil is still very
// useful for the active corporation at this point, otherwise it appears it can place a station anywhere on
// the map."
//
// THE TWO VEILS WERE WRITTEN TO THE SAME SHAPE AND GATED ON DIFFERENT KINDS OF THING. The tile lay reads a
// STEP -- `tileLayStepActive`, #224 -- and the token veil read `tokenTargetMode`, which is an armed cursor.
// So the board unveiled the moment the Tokens step opened and stayed unveiled until the president pressed
// Place Station: the answer to "where may I put a token" was withheld until after they had committed to
// using the control that asks the question.
//
// THIS FILE IS A SOURCE SCAN, and says so rather than pretending otherwise. The veil is a canvas effect
// assembled from a `useMemo` and a prop spread; there is no DOM to query and no exported predicate to call.
// `privatePowerBadge.test.ts` and `homeSlotChoice.test.ts` use the same instrument for the same reason. What
// CAN be asserted structurally is the thing that was actually wrong -- which condition the veil hangs on --
// and that is the assertion worth having, because a future edit that re-gates it on a mode would restore the
// report exactly.

import fs from "fs";
import path from "path";

const APP = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");

/** #490a: the notes quote the old condition by name and must keep doing so. */
const CODE = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The `tokenTargetFocus` memo, isolated so a match elsewhere in a 7000-line file cannot pass for one here. */
const FOCUS_BLOCK = (() => {
  const start = CODE.indexOf("const tokenTargetFocus = useMemo(");
  expect(start).toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf("}, [", start) + 200);
})();

describe("the veil hangs on the step", () => {
  it("shows for the whole Tokens sub-phase", () => {
    /* THE FIX. The step is the condition; a president deciding where a token can go has not necessarily
       pressed anything yet. */
    expect(FOCUS_BLOCK).toContain('if (orSubPhase !== "Tokens") return undefined;');
  });

  it("no longer waits for an armed cursor", () => {
    /* THE REPORT, as the negative. `tokenTargetMode` was the first line of this memo; while it was, the
       Tokens step showed an unveiled board on which every hex looked available. */
    expect(FOCUS_BLOCK).not.toContain("if (!tokenTargetMode) return undefined;");
  });

  it("repaints when the step changes", () => {
    // A memo keyed on the old mode would go stale the moment the gate moved off it.
    expect(FOCUS_BLOCK).toContain("[orSubPhase, spectator, activeStationCompany");
  });

  it("stays away from spectators", () => {
    // #23's rule: a watcher has no controls, so a veil implying they might act is noise.
    expect(FOCUS_BLOCK).toContain("if (spectator) return undefined;");
  });
});

describe("lighting a hex is not the same as arming one", () => {
  it("still routes the click through the mode", () => {
    /* THE SAFETY ARGUMENT, asserted rather than trusted: showing the network must not make a hex clickable.
       If this ever collapses into the veil's condition, opening the Tokens step would place tokens on
       contact -- a far worse bug than the one being fixed. */
    expect(CODE).toContain("tokenTargetMode\n                            ? handleTokenHexClick");
  });

  it("keeps the cursor badge on the mode too", () => {
    // The ticker-coloured cursor means "you are placing"; it must not appear merely because the step opened.
    expect(CODE).toContain("        : tokenTargetMode\n          ? actingProtocolId");
  });
});

describe("the lit set is the legal set", () => {
  it("asks the same predicate the placement asks", () => {
    /* #5081 already says the blocking check "reuses placeableStationHexes so it cannot disagree with the
       veil". That guarantee is what makes lighting the board during the whole step safe: the highlight is
       not a second opinion about legality, it is the same one drawn early. */
    expect(FOCUS_BLOCK).toContain("placeableStationHexes({");
  });

  it("walks the blocked network, not a bare one", () => {
    // #729: a city tokened out by rivals is not reachable, so it must not glow as a placement target.
    expect(FOCUS_BLOCK).toContain("blocksThroughCity");
  });
});
