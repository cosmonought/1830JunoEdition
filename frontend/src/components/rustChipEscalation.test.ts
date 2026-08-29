/** @jest-environment node */
//
// What a train chip does as its tier approaches rusting. Source-level; no React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 755 (harness): REVERSING #702, AND WHY THAT IS SAFE
// ==================================================================
//
// REQUESTED: "When trains are 2/1 purchase away from rusting, we currently have the number in the chip
// turning amber/red. I think maybe it should be the number AND the train icon that change colors, and they
// could pulsate like the 'Phase Shift' badge."
//
// THIS UNDOES A DELIBERATE DECISION, which is the interesting part. #702 held the locomotive neutral on
// purpose: "The glyph is the chip's constant: it never tints, so the reader always has a fixed thing to
// find." That was the answer to an earlier report about a 2-train chip vanishing into NNH's livery -- "I
// actually thought the 3-train purchase had been swapped out with it."
//
// SO THE TESTS HAVE TO PIN THE THING #702 WAS PROTECTING, not the mechanism it used. The requirement was
// never "the glyph must be neutral"; it was "the reader must always be able to tell the chip is still
// there". Motion serves that better than colour-constancy -- a pulsing chip is unmistakably present, where a
// chip merely holding one colour steady is only present if you were already looking at it. The constant is
// now the SHAPE, and the harness says so: the glyph is still drawn in every state.
//
// A SOURCE SCAN, and it says so. A chip is an inline-styled span with an SVG in it and a className that
// drives a keyframe; there is no exported predicate to call. Same instrument as `stationVeil.test.ts` and
// `privatePowerBadge.test.ts`, for the same reason.

import fs from "fs";
import path from "path";

const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const BADGES = read("components/TrainBadges.tsx");
/** #490a: the notes quote #702's old arrangement and must keep doing so. */
const CODE = BADGES.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ANIMATIONS = read("styles/animations.ts");

describe("both the number and the glyph escalate", () => {
  it("tints the glyph with the danger ink", () => {
    /* THE REQUEST. `ink[inDangerWindow].color` is the same value the numeral takes, so the two cannot
       disagree about which step the chip is on. */
    expect(CODE).toContain("(inDangerWindow ? ink[inDangerWindow].color : undefined) ?? ink.chip.color");
  });

  it("no longer pins the glyph to the neutral", () => {
    // #702's line was `color={String(ink.chip.color)}` with no conditional.
    expect(CODE).not.toContain("color={String(ink.chip.color)}");
  });

  it("still falls back to the neutral outside the danger window", () => {
    /* The `??` matters: a chip with no rust countdown is the ordinary case and must look ordinary. A tint
       applied unconditionally would make every train on the board look doomed. */
    expect(CODE).toContain("?? ink.chip.color");
  });
});

describe("what #702 was protecting survives", () => {
  it("still draws the locomotive in every state", () => {
    /* THE ACTUAL REQUIREMENT, which was never "the glyph must be neutral" but "the reader must be able to
       tell the chip is still there". The glyph is unconditional -- no `inDangerWindow` guard around it -- so
       the SHAPE is the constant now and the colour is free to move. */
    const glyphCall = CODE.slice(CODE.indexOf("<TrainGlyph"), CODE.indexOf("</span>", CODE.indexOf("<TrainGlyph")));
    expect(glyphCall).toContain("tier={tier ?? model}");
    expect(CODE).not.toMatch(/inDangerWindow[^\n]*&&[^\n]*<TrainGlyph/);
  });

  it("keeps the chip body opaque, which is what the original bug was about", () => {
    /* #702's finding: the old translucent fills scored 1.00 to 1.14:1 against all eight liveries -- "the bug
       was never 'amber on orange'. It was a translucent fill on an arbitrary hue." Neither danger state may
       reintroduce a `backgroundColor`, or the chip goes back to disappearing into NNH. */
    const darkInk = CODE.slice(CODE.indexOf("const darkInk"), CODE.indexOf("const lightInk"));
    const atRisk = darkInk.slice(darkInk.indexOf("atRisk:"), darkInk.indexOf("doomed:"));
    const doomed = darkInk.slice(darkInk.indexOf("doomed:"), darkInk.indexOf("atCapacity:"));
    expect(atRisk).not.toContain("backgroundColor");
    expect(doomed).not.toContain("backgroundColor");
  });
});

describe("the pulse is the critical step alone", () => {
  it("animates one purchase away and not two", () => {
    /* MATCHING THE BADGE IT WAS ASKED TO MATCH: `phaseShiftBadgeCritical` animates, `phaseShiftBadgeWarn`
       does not. That preserves #702's rule that the two countdown steps "differ in COLOUR and not merely in
       whether they pulse", and adds an axis on top of it -- two away is amber and still, one away is red and
       moving. If every at-risk chip pulsed there would be nothing left to escalate to. */
    /* ==================================================================
        #1004 SPLIT THE DOOMED STATE IN TWO, AND THIS ANCHOR FOLLOWED IT
       ==================================================================
       THIS ASSERTED the whole ternary verbatim. The class it names is unchanged and so is the rule it
       protects -- one purchase away pulses, two away does not -- but there is a THIRD state now: a train
       already rusted and running once more under Gentle Rust, which takes a deeper fade of its own.
       ANCHORED ON THE ARM RATHER THAN ON THE EXPRESSION, so the countdown's class stays pinned to the
       countdown's condition and a future fourth state does not have to rewrite this case again. */
    expect(CODE).toContain('inDangerWindow === "doomed"');
    expect(CODE).toContain('"app-train-rust-critical"');
    /* AND THE FINAL-RUN STATE TAKES A DIFFERENT CLASS, which is what keeps the two distinguishable -- see
       `animations.ts` #1004 for why a deeper version of one keyframe would have read as the same warning
       turned up rather than as a different one. */
    expect(CODE).toContain('"app-train-final-run"');
  });

  it("borrows the badge's keyframe rather than defining a lookalike", () => {
    /* Two hand-tuned pulses at 1.4s and 1.5s read as a rendering fault, not as two warnings. gamePhase.ts #7
       already shares the alert COLOURS between chip and badge "so chip and badge escalate together by
       construction"; this is the same argument for the second channel. */
    expect(ANIMATIONS).toContain("animation: app-phase-shift-pulse 1.4s ease-in-out infinite");
  });

  it("switches the motion off for reduced motion", () => {
    // The colour survives, so the warning is not lost -- which is why the two steps differ in colour at all.
    expect(ANIMATIONS).toMatch(
      /prefers-reduced-motion[\s\S]{0,120}\.app-train-rust-critical \{ animation: none/,
    );
  });

  it("keeps the badge's own reduced-motion rule separate", () => {
    // One class per surface, so the chip can be accommodated differently later without touching the badge.
    expect(ANIMATIONS).toContain(".app-phase-shift-critical { animation: none !important; }");
  });
});

describe("the severity still comes from the shared countdown", () => {
  it("reads the same helper the action bar reads", () => {
    /* #7 in `gamePhase.ts`: one countdown, two surfaces. A chip computing its own "how many purchases left"
       is how the chip and the badge would come to disagree about which phase the game is in. */
    expect(CODE).toContain('const severity = alert === "critical" ? "doomed" : alert === "warn" ? "atRisk" : null;');
  });

  it("only tints the tier actually next in line to rust", () => {
    // A 4-train is not at risk because 3-trains are about to go; the countdown is per tier.
    /* Design note #1004: the depot-driven arm is unchanged and is now the FALLBACK -- a reprieved train is
       doomed whatever the outlook says, because the tier that killed it has already arrived and the outlook
       has moved on to the next one. Asserted as the surviving expression rather than as the whole ternary. */
    expect(CODE).toContain("doomed !== null && tier === doomed && severity !== null");
    expect(CODE).toContain("const isFinalRun = reprievedAt >= 0;");
  });
});
