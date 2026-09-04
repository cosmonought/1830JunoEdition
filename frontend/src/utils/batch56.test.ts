/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1081-1082 (harness): SILENCE, AND A BEAT TO READ IN
// ==================================================================
//
// TWO CHANGES, AND BOTH TURNED OUT TO BE ABOUT A SOUND FILE'S SHAPE rather than about the code around it.
//
//  #1081  The unchanged roll's DEFAULT cue is silence. Its keyword-matched cues still play.
//  #1082  The dividend overlay gains a one-second pause before the merge, and the register's bell is aligned
//         to the frame the sum lands.
//
// THE DIAGNOSIS CAME FROM DECODING THE CLIPS, and this file does the same rather than trusting the numbers it
// produced. `coins-clinking.mp3` was reported as "delayed or laggy" against `cha-ching.mp3`; both are the same
// nominal length to within 0.5s, and the difference is entirely in the envelope -- cha-ching's energy midpoint
// is 0.17s and the coins' is 0.75s. `money-machine.mp3`'s bell is an attack at 0.85s with a long decay, not
// the "end" of a 2.23s file.
//
// SO THE ALIGNMENT IS ASSERTED AGAINST THE FILE. A constant checked against a constant is a tautology; the
// case below decodes the mp3 and locates the bell the same way the diagnosis did. If somebody replaces the
// clip with one whose bell sits elsewhere, this fails -- which is the only moment anyone would want to know.

export {};

const {
  MONEY_MACHINE_SFX,
  MONEY_MACHINE_SLIDE_MS,
  MONEY_MACHINE_HOLD_MS,
  MONEY_MACHINE_FALL_MS,
  MONEY_MACHINE_LINGER_MS,
  MONEY_MACHINE_CUE_AT_MS,
  MONEY_MACHINE_FALL_AT_MS,
  MONEY_MACHINE_MERGE_AT_MS,
  MONEY_MACHINE_LEAVE_AT_MS,
  MONEY_MACHINE_TOTAL_MS,
  MONEY_MACHINE_DING_AT_MS,
} = require("../components/DividendMoneyMachine") as typeof import("../components/DividendMoneyMachine");
const { BUCKET_FALLBACK, variantCueFor, everySfxFile } =
  require("./variantSfx") as typeof import("./variantSfx");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const MACHINE = readStripped("components/DividendMoneyMachine.tsx");
const SFX = readStripped("utils/variantSfx.ts");

/* ------------------------------------------------------------------ */
/* #1081 -- nothing happened, so nothing sounds                       */
/* ------------------------------------------------------------------ */

describe("the unchanged roll's default is silence", () => {
  it("gives the bucket no fallback clip", () => {
    /* RULED: "Completely remove the audio trigger from the Unpredictable Revenue variant's Unchanged (0%)
       state ... It must be completely silent." */
    expect(BUCKET_FALLBACK.unchanged).toBeNull();
  });

  it("still sounds for an unchanged line a keyword claims", () => {
    /* THE NARROWING, AND THE WHOLE SUBSTANCE OF THIS CHANGE: "ONLY remove coins-clinking from the Unchanged
       revenue events. Some of the Unchanged events have more 'unique' flavor text with sound effects that can
       still play." `variantCueFor` tries the keyword table BEFORE the fallback, so this is a property of the
       ORDER rather than of the bucket -- and asserting it here is what stops a later "simplification" that
       checks the bucket first. */
    expect(variantCueFor({ line: "A child counted the wheels as the locomotive passed.", bucket: "unchanged" }).audio)
      .toBe("metal_clunk.mp3");
    expect(variantCueFor({ line: "A photographer took a portrait of the locomotive and its crew.", bucket: "unchanged" }).audio)
      .toBe("camera-shutter.mp3");
  });

  it("silences an unchanged line no keyword claims", () => {
    expect(variantCueFor({ line: "The day passed without financial incident.", bucket: "unchanged" }).audio)
      .toBeNull();
  });

  it("leaves every other bucket sounding", () => {
    /* THE CONTROL. A change that silenced the variant outright would satisfy both cases above if they were
       read carelessly; this is the one that fails if the removal was too wide. */
    for (const bucket of ["criticalMalus", "minorMalus", "minorBonus", "criticalBonus"] as const) {
      expect(BUCKET_FALLBACK[bucket]).not.toBeNull();
      expect(variantCueFor({ line: "Nothing in this sentence matches any keyword whatsoever.", bucket }).audio)
        .toBe(BUCKET_FALLBACK[bucket]);
    }
  });

  it("keeps silence out of the list of files that must exist on disk", () => {
    /* `everySfxFile()` MEANS "every file this module can ask for", and a `null` in it would reach the case
       that checks each name against `public/audio`. */
    expect(everySfxFile().every((file) => typeof file === "string" && file.length > 0)).toBe(true);
    expect(everySfxFile()).not.toContain("coins-clinking.mp3");
  });

  it("guards the null at the call site rather than inside the player", () => {
    /* `playVariantCue`'s `enabled` ARGUMENT MEANS "THE PLAYER MUTED THIS", and silence-by-design is a
       different fact. Folding them together would make a muted cue and an intentionally silent one
       indistinguishable at the one place either could be debugged from. */
    /* Design note #1094: `ephemeral &&` joined the condition, because a replayed log must not replay its
       sounds. THE NULL CHECK IS STILL AT THE CALL SITE, which is what this case is about, and still for the
       same reason. Asserted as a substring so a third clause does not break it. */
    expect(APP).toContain("cue.audio !== null) {");
    expect(SFX).toContain("audio: string | null;");
  });
});

/* ------------------------------------------------------------------ */
/* #1082 -- the schedule                                              */
/* ------------------------------------------------------------------ */

describe("the overlay holds still long enough to be read", () => {
  it("runs the six marks the ruling names", () => {
    /* RULED, exactly: 0.0-0.5 slide in, 0.5-1.5 hold, 1.5-2.0 merge, 2.0-3.0 linger, 3.0-3.5 slide out.
       ASSERTED AS THE MARKS, not as the durations, because the marks are what a person with a stopwatch
       would check and because the durations are already asserted by being the things they are summed from. */
    expect(MONEY_MACHINE_SLIDE_MS).toBe(500);
    expect(MONEY_MACHINE_FALL_AT_MS).toBe(1500);
    expect(MONEY_MACHINE_MERGE_AT_MS).toBe(2000);
    expect(MONEY_MACHINE_LEAVE_AT_MS).toBe(3000);
    expect(MONEY_MACHINE_TOTAL_MS).toBe(3500);
  });

  it("derives every mark rather than restating it", () => {
    /* THE SPEC GIVES BOTH FIVE SPANS AND SIX TIMESTAMPS, and writing down both is the pair #1042's two
       alphas were: two statements of one fact, agreeing until somebody edits one. The durations are the
       source. Checked as arithmetic, so a hand-typed mark that happened to match today still fails the day
       a duration moves. */
    expect(MONEY_MACHINE_FALL_AT_MS).toBe(MONEY_MACHINE_SLIDE_MS + MONEY_MACHINE_HOLD_MS);
    expect(MONEY_MACHINE_MERGE_AT_MS).toBe(MONEY_MACHINE_FALL_AT_MS + MONEY_MACHINE_FALL_MS);
    expect(MONEY_MACHINE_LEAVE_AT_MS).toBe(MONEY_MACHINE_MERGE_AT_MS + MONEY_MACHINE_LINGER_MS);
    expect(MONEY_MACHINE_TOTAL_MS).toBe(MONEY_MACHINE_LEAVE_AT_MS + MONEY_MACHINE_SLIDE_MS);
    // And it is the source file doing the summing, not this test agreeing with a coincidence.
    expect(MACHINE).toContain("MONEY_MACHINE_SLIDE_MS + MONEY_MACHINE_HOLD_MS");
    expect(MACHINE).toContain("MONEY_MACHINE_FALL_AT_MS + MONEY_MACHINE_FALL_MS");
  });

  it("gives the pause a full second in which nothing moves", () => {
    /* THE COMPLAINT: "merges the numbers too quickly after sliding in, making it impossible for players to
       read the payout amount before it disappears."
       THE FIX IS THE GAP, not a slower fall. Asserted as a relationship rather than as `1000`, so the claim
       reads as "there is real stillness between the arrival and the drop". */
    expect(MONEY_MACHINE_HOLD_MS).toBe(1000);
    expect(MONEY_MACHINE_FALL_AT_MS - MONEY_MACHINE_SLIDE_MS).toBe(MONEY_MACHINE_HOLD_MS);
  });

  it("shows the old total for the whole of it", () => {
    /* THE PAUSE IS MEANT TO HOLD BOTH NUMBERS. A `holding` phase that showed the SUM would be a pause in
       which there is nothing to add up, which is the pause failing while looking like it works. */
    expect(MACHINE).toContain(
      'const shown = phase === "holding" || phase === "falling" ? event.cashBefore : event.cashAfter;',
    );
  });

  it("keeps the payout figure visible while it waits", () => {
    /* `app-money-machine-landed` IS `opacity: 0`, so reusing it for the pause would have hidden the very
       figure the pause exists to let a player read. Three states, not two. */
    expect(MACHINE).toContain('phase === "holding"\n              ? "app-money-machine-waiting"');
    const waiting = sliceBetween(MACHINE, ".app-money-machine-waiting {", "}");
    expect(waiting).toContain("opacity: 1");
    expect(waiting.length).toBeLessThan(200);
  });

  it("schedules each phase at an absolute mark", () => {
    /* NOT A CHAIN OF RELATIVE WAITS. #1061 nested two (`settled + LINGER`), readable at two and four running
       sums here -- and a running sum is where one phase silently absorbs its neighbour's slip. */
    const schedule = sliceBetween(MACHINE, "} else {", "return () => timers");
    expect(schedule).toContain("MONEY_MACHINE_CUE_AT_MS");
    expect(schedule).toContain("MONEY_MACHINE_FALL_AT_MS");
    expect(schedule).toContain("MONEY_MACHINE_MERGE_AT_MS");
    expect(schedule).toContain("MONEY_MACHINE_LEAVE_AT_MS");
    expect(schedule).not.toContain("settled");
  });

  it("uses timers rather than animation events", () => {
    /* A BACKGROUND TAB THROTTLES `animationend` AND CAN DROP IT ENTIRELY. A payout that never merged would
       leave the old total on screen and never ring; a late timer is recoverable, a missing event is not. */
    expect(MACHINE.split("window.setTimeout(").length - 1).toBeGreaterThanOrEqual(5);
    expect(MACHINE).not.toContain("animationend");
  });
});

/* ------------------------------------------------------------------ */
/* The bell, located in the file rather than trusted                  */
/* ------------------------------------------------------------------ */

describe("the register's bell lands on the merge", () => {
  /** Decode the clip and return a 50ms peak envelope, the way the diagnosis did. */
  function envelope(file: string): { levels: number[]; stepMs: number } {
    const { execFileSync } = require("child_process") as typeof import("child_process");
    const path = require("path") as typeof import("path");
    const full = path.join(__dirname, "..", "..", "public", "audio", file);
    const raw: Buffer = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", full, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
      { maxBuffer: 1 << 26 },
    );
    const sampleRate = 8000;
    const step = Math.round(sampleRate * 0.05);
    const levels: number[] = [];
    for (let start = 0; start + step <= raw.length / 2; start += step) {
      let peak = 0;
      for (let i = start; i < start + step; i += 1) {
        const value = Math.abs(raw.readInt16LE(i * 2));
        if (value > peak) peak = value;
      }
      levels.push(peak);
    }
    return { levels, stepMs: 50 };
  }

  /** Whether `ffmpeg` is on this machine at all -- see the note in the case below. */
  function haveFfmpeg(): boolean {
    try {
      const { execFileSync } = require("child_process") as typeof import("child_process");
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  it("finds the bell where the constant says it is", () => {
    /* ==================================================================
        DESIGN NOTE 1082: THE ASSERTION THAT IS NOT A TAUTOLOGY
       ==================================================================
       `MONEY_MACHINE_DING_AT_MS` IS A MEASUREMENT OF A FILE, and checking it against another constant would
       assert nothing. So this decodes the mp3 and locates the bell the same way the diagnosis did: the last
       window whose level jumps sharply over its predecessor while still being loud. In `money-machine.mp3`
       that is the strike at 0.85s -- a crank/rattle runs before it and a long metallic decay after, which is
       what a cash register sounds like and what makes the "ding" the END of the sound to a listener even
       though it is a third of the way into the file.
       SKIPPED WHERE `ffmpeg` IS ABSENT rather than failed. A missing decoder is a fact about the machine, and
       a suite that goes red on a laptop without ffmpeg teaches its owner to ignore it. The constant is still
       covered by the alignment case below, which needs no decoder. */
    if (!haveFfmpeg()) return;
    const { levels, stepMs } = envelope(MONEY_MACHINE_SFX);
    const peak = Math.max(...levels);
    let bellAt = -1;
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] > peak * 0.25 && levels[i] > 1.6 * Math.max(levels[i - 1], 1)) {
        bellAt = i * stepMs;
      }
    }
    expect(bellAt).toBeGreaterThan(0);
    // Within one envelope window of the constant, which is the resolution the measurement has.
    expect(Math.abs(bellAt - MONEY_MACHINE_DING_AT_MS)).toBeLessThanOrEqual(stepMs);
  });

  it("starts the clip so the bell arrives with the sum", () => {
    /* RULED: "money-machine ends with a cash register 'ding' sound, so the ideal animation is for the
       merge/sum to conclude in the neighborhood of that."
       WHICH SUPERSEDED THE EARLIER "have it fire once the slide-in is complete" -- that was a means, this is
       the goal, and at 0.5s the bell would have rung at 1.35s with nothing on screen moving. */
    expect(MONEY_MACHINE_CUE_AT_MS + MONEY_MACHINE_DING_AT_MS).toBe(MONEY_MACHINE_MERGE_AT_MS);
    // Derived in the source, so re-timing the schedule carries the alignment with it.
    expect(MACHINE).toContain("MONEY_MACHINE_MERGE_AT_MS - MONEY_MACHINE_DING_AT_MS");
  });

  it("finishes the clip before the panel leaves", () => {
    /* ==================================================================
        THE FAULT THIS BATCH WAS CHECKED FOR, AND THE ONE THIS CASE ITSELF NEARLY HAD
       ==================================================================
       The ruled 2.0s trigger would have left the register ringing 0.36s after the panel had slid off -- the
       same complaint that had just been raised about `coins-clinking.mp3` outlasting the revenue flash.
       THIS READ `const clipMs = 2300`, A HAND-TYPED LENGTH, and #1086's audio pass then trimmed the file to
       1.91s. The assertion did not fail -- a shorter clip fits more easily -- but it had stopped measuring
       the file and started measuring a memory of it, which is one edit away from being wrong in the
       direction that matters.
       SO THE DURATION IS DECODED, like the bell above it. `ffprobe` rather than a full decode: the length is
       in the container and there is no need to read the samples for it.
       SKIPPED WHERE `ffprobe` IS ABSENT, for the reason the bell case gives -- a missing decoder is a fact
       about the machine, not about the code. */
    let clipMs = 0;
    try {
      const { execFileSync } = require("child_process") as typeof import("child_process");
      const path = require("path") as typeof import("path");
      const out = execFileSync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
        path.join(__dirname, "..", "..", "public", "audio", MONEY_MACHINE_SFX),
      ]);
      clipMs = Math.round(parseFloat(String(out)) * 1000);
    } catch {
      return;
    }
    expect(clipMs).toBeGreaterThan(500);
    expect(MONEY_MACHINE_CUE_AT_MS + clipMs).toBeLessThanOrEqual(MONEY_MACHINE_TOTAL_MS);
    // And it does not start before the panel has arrived, which would ring it at nothing.
    expect(MONEY_MACHINE_CUE_AT_MS).toBeGreaterThanOrEqual(MONEY_MACHINE_SLIDE_MS);
  });
});

/* ------------------------------------------------------------------ */
/* Reduced motion                                                     */
/* ------------------------------------------------------------------ */

describe("reduced motion keeps every figure and the whole lifetime", () => {
  it("arrives merged and rings at once", () => {
    /* "BYPASSING THE SLIDE/MERGE AND DISPLAYING THE FINAL STATIC SUM INSTANTLY." There is no merge to wait
       for, so the cue marks the arrival. */
    expect(MACHINE).toContain('setPhase(quiet ? "merged" : "holding");');
    const branch = sliceBetween(MACHINE, "if (quiet) {", "} else {");
    expect(branch).toContain("onCue();");
    expect(branch.length).toBeLessThan(200);
  });

  it("lasts exactly as long as the animated path", () => {
    /* ==================================================================
        DESIGN NOTE 1082: #1064 CLAIMED THIS AND IT WAS NOT TRUE
       ==================================================================
       ITS NOTE SAID "same lifetime, same sound at the same moment"; its arithmetic gave the animated path
       900 + 2000 + 420 = 3320ms and the quiet path 2000ms. A note describing an intention as an
       accomplishment -- one of this project's recurring shapes, and the reason every note here is supposed to
       have a case under it.
       MADE TRUE RATHER THAN WITHDRAWN: a reader who asked for less movement did not ask for less time.
       ASSERTED AS THE ABSENCE OF A BRANCH, which is the only form that cannot drift -- one `setTimeout`,
       outside the `if`, with no `quiet` anywhere in it. */
    expect(MACHINE).toContain("timers.push(window.setTimeout(onDone, MONEY_MACHINE_TOTAL_MS));");
    const lifetime = sliceBetween(MACHINE, "timers.push(window.setTimeout(onDone,", ");");
    expect(lifetime).not.toContain("quiet");
    expect(lifetime.length).toBeLessThan(120);
  });

  it("asks the query in JavaScript, because a stylesheet cannot reschedule", () => {
    /* THE HALF `@media` CANNOT DO. The cue fires from a timer and the total changes on a state flip; a
       CSS-only version would show a reduced-motion player the OLD total in silence and then jump. */
    expect(MACHINE).toContain('window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true');
    expect(MACHINE).toContain("const quiet = prefersReducedMotion();");
  });

  it("keeps the payout figure on screen with no merge to absorb it", () => {
    /* ==================================================================
        DESIGN NOTE 1163 EXTENDS THE DECLARATION THIS PINNED
       ==================================================================
       THE THIRD COPY OF THIS ASSERTION -- `batch52` and `batch63` hold the others, all three pinning the whole
       of `.app-money-machine-landed { opacity: 1; }` as a string. #1163 added a second property to it: the
       merged row now collapses its grid track as well as fading, so the panel stops leaving a payer-row-shaped
       hole above the total.
       WHICH MAKES THE CLAIM BIGGER RATHER THAN SMALLER, and all three copies say so now: a reduced-motion
       reader keeps the payout on screen as a static statement, and a figure that kept its opacity while losing
       its track would be visible with nowhere to be. Both properties are asserted.
       THAT THIS LIVED IN THREE FILES IS ITS OWN FINDING. One rule, three harnesses, none of which knew about
       the others -- so a change to it fails three times and has to be answered three times. */
    const reduced = sliceBetween(MACHINE, "@media (prefers-reduced-motion: reduce) {", "}\n`");
    expect(reduced).toContain(".app-money-machine-landed { opacity: 1;");
    expect(reduced).toContain("grid-template-rows: 1fr;");
    expect(reduced).toContain(".app-money-machine { animation: none; }");
  });
});
