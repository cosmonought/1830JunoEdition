/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE (AUDIO WIRING harness): MULTIPLICITY, ALIGNMENT, AND SILENCE
// ==================================================================
//
// Three cues, and the ways each can be wrong are not the same ways:
//
//   1. THE BANK can only break once, so its risk is firing AGAIN -- on a refill and a second dip, on a
//      refresh into an already-broken state, on a rebuild that crosses the break on its way forward.
//   2. RUST is one event with a LIST inside it. Six fleets rusting in one dispatch is one crack. The way
//      to get this wrong is to put the cue where the chips are, because that renders once per corporation.
//   3. THE DISCARD is one player action, so successive discards are successive cuts and suppressing the
//      second would silence a real decision. Its risk is the opposite of the Bank's.
//
// And two things are true of all three:
//
//   4. THE CLIP'S OWN IMPACT LANDS ON THE MILESTONE, not its first sample -- VF-3's rule for
//      `floated.mp3`, and the offsets here were measured the same way (ffmpeg decode, peak sample plus a
//      10ms RMS envelope). The numbers are asserted against the ACTIVE schedule, both of them.
//   5. NOTHING IS PLAYED BY THIS LAYER. `playVariantCue` owns the mute, the volume, the cap and the
//      duck; these files own only WHEN (#1041/#1457's split).

export {};

const {
  BANK_BREAK_SFX,
  BANK_BREAK_AUDIO_IMPACT_OFFSET_MS,
  BANK_BREAK_STAMP_AT_MS,
  BANK_BREAK_REDUCED_STAMP_AT_MS,
  bankBreakCueAtMs,
  bankBreakMilestoneMs,
} = require("./bankBreakFlourish") as typeof import("./bankBreakFlourish");
const {
  RUST_SFX,
  RUST_AUDIO_IMPACT_OFFSET_MS,
  RUST_FRACTURE_AT_MS,
  RUST_REDUCED_FRACTURE_AT_MS,
  rustCueAtMs,
  rustMilestoneMs,
  crackFragments,
  crackSeedFor,
  RUST_FRAGMENT_MIN_AREA_PERCENT,
  RUST_FRAGMENT_DRIFT_PX,
  TRAIN_RUST_CSS,
} = require("./trainRustFlourish") as typeof import("./trainRustFlourish");
const {
  DISCARD_SFX,
  DISCARD_AUDIO_IMPACT_OFFSET_MS,
  DISCARD_CUT_AT_MS,
  DISCARD_REDUCED_CUT_AT_MS,
  discardCueAtMs,
  discardMilestoneMs,
} = require("./trainDiscardFlourish") as typeof import("./trainDiscardFlourish");
const { readStripped, sliceBetween } =
  require("../utils/sourceScan") as typeof import("../utils/sourceScan");

const APP = readStripped("App.tsx");

/** The measured principal impact of each clip, as this pass found it. Restated here so a future retiming
 *  has to disagree with a number somebody wrote down rather than with a number nobody can see. */
const MEASURED = {
  [BANK_BREAK_SFX]: 12,
  [RUST_SFX]: 100,
  [DISCARD_SFX]: 69,
} as const;

describe("the assets are where the library keeps them, under the library's names", () => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const audio = (file: string) =>
    path.join(__dirname, "..", "..", "public", "audio", file);

  it("names each cue for its event, not for its provider", () => {
    /* The supplied filenames were generator strings. The library's own vocabulary is semantic and mostly
       kebab-case (`camera-shutter.mp3`, `money-machine.mp3`, `carcosan-train.mp3`), and the two existing
       one-off flourish stingers are bare words (`floated.mp3`, `presidency.mp3`). These follow both. */
    expect(BANK_BREAK_SFX).toBe("bank-broken.mp3");
    expect(RUST_SFX).toBe("rust.mp3");
    // Named for the ACTION, not for the rule that forced it -- a limit dropping has no sound of its own.
    expect(DISCARD_SFX).toBe("train-discard.mp3");
    for (const file of [BANK_BREAK_SFX, RUST_SFX, DISCARD_SFX]) {
      expect(/^[a-z0-9-]+\.mp3$/.test(file)).toBe(true);
    }
  });

  it("puts them in `public/audio`, beside every other cue", () => {
    for (const file of [BANK_BREAK_SFX, RUST_SFX, DISCARD_SFX]) {
      expect(fs.existsSync(audio(file))).toBe(true);
    }
    // And the provider-named originals are not left in the tree as a second copy.
    for (const stale of ["bankBreak.mp3", "trainLimit.mp3"]) {
      expect(fs.existsSync(audio(stale))).toBe(false);
    }
  });
});

describe("the clip's own impact lands on the milestone, on the ACTIVE schedule", () => {
  it("starts the Bank's thunk so it lands on `stamped`", () => {
    expect(BANK_BREAK_AUDIO_IMPACT_OFFSET_MS).toBe(MEASURED[BANK_BREAK_SFX]);
    expect(bankBreakCueAtMs(false)).toBe(BANK_BREAK_STAMP_AT_MS - BANK_BREAK_AUDIO_IMPACT_OFFSET_MS);
    expect(bankBreakCueAtMs(true)).toBe(
      BANK_BREAK_REDUCED_STAMP_AT_MS - BANK_BREAK_AUDIO_IMPACT_OFFSET_MS,
    );
    // Which is to say: the impact lands ON the milestone, both ways.
    expect(bankBreakCueAtMs(false) + BANK_BREAK_AUDIO_IMPACT_OFFSET_MS).toBe(
      bankBreakMilestoneMs("stamped", false),
    );
    expect(bankBreakCueAtMs(true) + BANK_BREAK_AUDIO_IMPACT_OFFSET_MS).toBe(
      bankBreakMilestoneMs("stamped", true),
    );
  });

  it("starts rust's first crack so it lands on `fractured`", () => {
    expect(RUST_AUDIO_IMPACT_OFFSET_MS).toBe(MEASURED[RUST_SFX]);
    expect(rustCueAtMs(false)).toBe(RUST_FRACTURE_AT_MS - RUST_AUDIO_IMPACT_OFFSET_MS);
    expect(rustCueAtMs(false) + RUST_AUDIO_IMPACT_OFFSET_MS).toBe(rustMilestoneMs("fractured", false));
    /* REDUCED MOTION CANNOT REACH IT, and the miss is written down rather than hidden: that timeline
       fractures at 90ms and the clip's crack is at 100ms, so the earliest legal start is the sequence's
       own beginning and the crack arrives 10ms late. VF-3's equivalent miss on `floated.mp3` is 298ms. */
    expect(rustCueAtMs(true)).toBe(0);
    const late = RUST_AUDIO_IMPACT_OFFSET_MS - rustMilestoneMs("fractured", true);
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThanOrEqual(20);
  });

  it("starts the blade so it lands on `cut`", () => {
    expect(DISCARD_AUDIO_IMPACT_OFFSET_MS).toBe(MEASURED[DISCARD_SFX]);
    expect(discardCueAtMs(false)).toBe(DISCARD_CUT_AT_MS - DISCARD_AUDIO_IMPACT_OFFSET_MS);
    expect(discardCueAtMs(false) + DISCARD_AUDIO_IMPACT_OFFSET_MS).toBe(
      discardMilestoneMs("cut", false),
    );
    // The reduced timeline cuts at 40ms, earlier than the blade's own 69ms attack: clamped, 29ms late.
    expect(discardCueAtMs(true)).toBe(0);
    expect(DISCARD_AUDIO_IMPACT_OFFSET_MS - discardMilestoneMs("cut", true)).toBeLessThanOrEqual(40);
  });

  it("never asks for a negative start, and never uses a full-motion number under reduced motion", () => {
    for (const cue of [bankBreakCueAtMs, rustCueAtMs, discardCueAtMs]) {
      expect(cue(false)).toBeGreaterThanOrEqual(0);
      expect(cue(true)).toBeGreaterThanOrEqual(0);
      // Reduced schedules are shorter, so a reduced cue can never be LATER than its full-motion twin.
      expect(cue(true)).toBeLessThanOrEqual(cue(false));
    }
  });
});

describe("multiplicity: one cue per event, and the event is different each time", () => {
  /* Each raiser bounded by its OWN next declaration rather than one slice over all three -- #886's rule
     about a region an assertion is not actually about. */
  const BANK = sliceBetween(APP, "const showBankBreakStamp = useCallback(", "bankBreakStampTimerRef.current = window.setTimeout");
  const RUST = sliceBetween(APP, "const showRustFlourish = useCallback(", "rustEventTimerRef.current = window.setTimeout");
  const DISCARD = sliceBetween(APP, "const showTrainDiscard = useCallback(", "discardEventTimerRef.current = window.setTimeout");

  it("fires each cue from the RAISER, never from the row that renders it", () => {
    /* THE WHOLE RUST RULE IS THIS LINE'S ADDRESS. `TrainBadges` renders once per corporation, so a cue
       fired from the chips would play once per fleet -- six fleets rusting together would be six cracks
       for one reducer call. The raisers run once per event by construction. */
    expect(APP).toContain("scheduleFlourishCue(bankBreakCueAtMs(reducedMotionNow()), BANK_BREAK_SFX);");
    expect(APP).toContain("scheduleFlourishCue(rustCueAtMs(reducedMotionNow()), RUST_SFX);");
    expect(APP).toContain("scheduleFlourishCue(discardCueAtMs(reducedMotionNow()), DISCARD_SFX);");
    for (const call of ["BANK_BREAK_SFX", "RUST_SFX", "DISCARD_SFX"]) {
      expect((APP.match(new RegExp(`scheduleFlourishCue\\(.*?, ${call}\\);`, "g")) ?? []).length).toBe(1);
    }
    /* Three cues in the whole shell and no fourth. Three rather than four because the declaration reads
       `const scheduleFlourishCue = useCallback(` and carries no parenthesis of its own -- the same
       off-by-one VF-7's `showRustFlourish(` count records. */
    expect((APP.match(/scheduleFlourishCue\(/g) ?? []).length).toBe(3);
    // And no component plays any of them itself.
    for (const file of ["components/TrainBadges.tsx", "components/BankTicket.tsx"]) {
      const CODE = readStripped(file);
      expect(CODE).not.toContain("playVariantCue");
      expect(CODE).not.toContain("new Audio(");
    }
  });

  it("gives the rust cue the whole event, however many fleets are in it", () => {
    /* One call, above a `corporations` list rather than inside a loop over it. The list is every fleet
       the reducer emptied in one dispatch (I-4: they all run off one clock). */
    expect(RUST).toContain("if (corporations.length === 0) return;");
    expect(RUST).toContain("scheduleFlourishCue(rustCueAtMs(reducedMotionNow()), RUST_SFX);");
    expect(RUST).not.toContain("corporations.forEach");
    expect(RUST).not.toContain("corporations.map");
    expect(RUST).not.toContain("for (const");
    /* ==================================================================
        AND THIS ORDER IS WHY A GENTLE RUST MARKING IS SILENT
       ==================================================================
       `destroyedRustedModels` keeps only the models that actually LEFT `owned_trains` between the two
       settled states, so a marking -- where `describeFleetLosses` reports `rusted` but the trains are
       still in the fleet (#979) -- produces an empty list. The empty-list guard is above the cue, so the
       marking never reaches it; the expiry that finally destroys them does, and gets one crack. VF-7's
       own suite proves the selection, and this proves the cue is behind it. */
    expect(RUST.indexOf("if (corporations.length === 0) return;")).toBeLessThan(
      RUST.indexOf("scheduleFlourishCue("),
    );
  });

  it("refuses every cue on a rebuild, in the raiser itself", () => {
    /* #1094's edge discipline, and it is what makes refresh and Undo silent: a rebuild walks the whole
       log forward and crosses every break, rust and discard on the way. */
    for (const body of [BANK, RUST, DISCARD]) {
      const guard = body.indexOf("if (replayingHistory) return;");
      const cue = body.indexOf("scheduleFlourishCue(");
      expect(guard).toBeGreaterThan(-1);
      expect(cue).toBeGreaterThan(-1);
      // The guard is passed BEFORE the cue is scheduled, not after it.
      expect(guard).toBeLessThan(cue);
    }
  });

  it("does not suppress a second discard because the first still has a tail", () => {
    /* THE OPPOSITE RULE TO THE BANK'S, and it is the rules speaking: a corporation two over the limit
       answers twice, and two presidents in the queue answer once each. Each is a decision somebody made.
       The only limiter is `playVariantCue`'s shared concurrency cap, which drops a fourth simultaneous
       clip rather than a second sequential one (#1041). */
    expect(DISCARD).toContain("scheduleFlourishCue(discardCueAtMs(reducedMotionNow()), DISCARD_SFX);");
    expect(DISCARD).not.toContain("cuedRef");
    expect(DISCARD).not.toContain("alreadyCued");
  });

  it("cannot sound twice for one Bank break, because the trigger is a crossing", () => {
    // `false -> true` only: a Bank already broken that dips again is `true -> true` and never gets here.
    expect(APP).toContain("!bankIsBroken(before) && bankIsBroken(after)");
    expect((BANK.match(/scheduleFlourishCue\(/g) ?? []).length).toBe(1);
  });
});

describe("the infrastructure is the one that already exists", () => {
  it("routes every cue through `playVariantCue`, and builds no second player", () => {
    const CUE = sliceBetween(APP, "const scheduleFlourishCue = useCallback(", "const bankBreakStampTokenRef = useRef(0);");
    expect(CUE).toContain("playVariantCue(file, sfxEnabledRef.current)");
    // The master SFX mute and no category of its own -- #1457's rule for the presidency cue.
    expect(CUE).not.toContain("sfxTurnRef");
    expect(CUE).not.toContain("sfxRevenueRef");
    expect(CUE).not.toContain("sfxPayoutRef");
  });

  it("is not routed through the flavour-text matcher", () => {
    /* These are flourish cues, not lines the ticker printed. `variantSfx.ts` owns the mechanical clips
       for a different reason and must not learn about these -- that matcher is #1040's known
       false-positive source, which is why all three assets were supplied rather than borrowed. */
    const VARIANT = readStripped("utils/variantSfx.ts");
    for (const file of [BANK_BREAK_SFX, RUST_SFX, DISCARD_SFX]) {
      expect(VARIANT).not.toContain(file);
    }
  });

  it("shares the flourish timer list, so an unmount cancels a pending cue", () => {
    expect(APP).toContain("scheduleFlourishHold(cueAtMs, () => playVariantCue(file, sfxEnabledRef.current));");
    expect(APP).toContain("flourishHoldTimersRef.current.forEach((timer) => window.clearTimeout(timer));");
  });

  it("leaves reduced motion to decide MOTION, and audio to the audio setting", () => {
    /* Brief section 9, and it is also what this codebase already does: VF-3's float sounds its stamp
       under reduced motion and VF-5's tile sounds its commit. `reducedMotionNow()` is read here only to
       pick WHICH schedule the offset is measured against. */
    const CUE = sliceBetween(APP, "const scheduleFlourishCue = useCallback(", "const bankBreakStampTokenRef = useRef(0);");
    expect(CUE).not.toContain("reducedMotion");
    expect(CUE).not.toContain("prefers-reduced-motion");
  });
});

describe("the chip actually comes apart, which is what the clatter is for", () => {
  it("breaks along the crack that was just drawn, from the same seed", () => {
    const CODE = readStripped("components/TrainBadges.tsx");
    expect(CODE).toContain("crackFragments(crackSeedFor(companyId ?? 0, index))");
    expect(CODE).toContain('rustState.stage === "fail" && !rustState.reducedMotion');
  });

  it("makes a few chunky pieces and never a splinter", () => {
    /* Measured over the seeds a real board produces: the three-way split tiles the chip exactly, but
       roughly a third of seeds put one piece under 8% of the area -- a hairline at 34x24, which reads as
       a rendering fault rather than as a piece of chip. Those break in two instead. */
    let three = 0;
    let two = 0;
    for (let company = 1; company <= 10; company += 1) {
      for (let index = 0; index < 4; index += 1) {
        const pieces = crackFragments(crackSeedFor(company, index));
        expect(pieces.length === 2 || pieces.length === 3).toBe(true);
        if (pieces.length === 3) three += 1;
        else two += 1;
        for (const piece of pieces) {
          expect(piece.clipPath.startsWith("polygon(")).toBe(true);
          expect(Math.hypot(piece.dx, piece.dy)).toBeLessThanOrEqual(RUST_FRAGMENT_DRIFT_PX + 0.2);
        }
      }
    }
    // Both arms are reachable on a real board, which is why both are written.
    expect(three).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(0);
    expect(RUST_FRAGMENT_MIN_AREA_PERCENT).toBeGreaterThan(0);
  });

  it("is the same break every render, because the seed is", () => {
    const seed = crackSeedFor(4, 1);
    expect(crackFragments(seed)).toEqual(crackFragments(seed));
  });

  it("stays inside the chip, and travels a few pixels", () => {
    /* A-1 at the smallest scale: the pieces are clipped to the chip's own box and move single digits.
       Nothing here is debris flying across a row of 24px chips. */
    for (let company = 1; company <= 6; company += 1) {
      for (const piece of crackFragments(crackSeedFor(company, 0))) {
        for (const value of (piece.clipPath.match(/-?[\d.]+(?=%)/g) ?? []).map(Number)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(100);
        }
        expect(Math.abs(piece.rotateDeg)).toBeLessThanOrEqual(2);
      }
    }
  });

  it("replaces the whole chip's shudder rather than running beside it", () => {
    // Two animations on one element is the chip moving twice. VF-8's two-class override idiom.
    expect(TRAIN_RUST_CSS).toContain(".app-train-rust-failing.app-train-rust-shard {");
    expect(TRAIN_RUST_CSS).toContain("animation-name: app-train-rust-shard;");
    // And nothing at all under reduced motion, where the chip still leaves by opacity alone.
    const reduced = TRAIN_RUST_CSS.slice(TRAIN_RUST_CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".app-train-rust-failing.app-train-rust-shard {");
    expect(reduced).toContain("animation: none !important;");
  });

  it("changed no milestone", () => {
    /* The constraint on the adjustment: presentation inside the failure phase, and not one beat moved. */
    /* NAMED APART FROM THE `RUST` RAISER SLICE ABOVE. The first draft called this one `RUST` too, and
       `sourceScanSweep` reported three missing anchors in `App.tsx` for assertions that were about
       `trainRustFlourish.ts` -- it binds a loose assertion to the nearest declaration it recognised, and
       a shadowed name is exactly the ambiguity it cannot see through. The suite passed throughout, which
       is the point: the sweep caught a naming fault that no assertion could. */
    const RUST_MODULE = readStripped("components/trainRustFlourish.ts");
    expect(RUST_MODULE).toContain("export const RUST_OXIDISE_MS = 190;");
    expect(RUST_MODULE).toContain("export const RUST_FRACTURE_MS = 140;");
    expect(RUST_MODULE).toContain("export const RUST_FAIL_MS = 120;");
    expect(RUST_MODULE).toContain("export const RUST_VACATE_MS = 80;");
  });
});
