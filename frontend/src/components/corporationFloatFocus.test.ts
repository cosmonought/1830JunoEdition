/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE (VF-3 harness): THE SCHEDULE IS THE PART WITH LOGIC
// ==================================================================
//
// Mirrors `stockTransferFocus.test.ts`'s own framing: this module is pure (no DOM, no timers, no rules
// re-derivation), so what a test can state about it is entirely the RUNNING ORDER -- which stage is active
// when, and when the one staged field (`floated`) actually flips. The DOM behaviour this schedule drives is
// `corporationCardFloatFocus.test.tsx`'s job.

export {};

const {
  buildFloatFocusSequence,
  floatStageAt,
  FLOAT_AUDIO_IMPACT_OFFSET_MS,
  FLOAT_CUE_AT_MS,
  FLOAT_FLIP_AT_MS,
  FLOAT_FLIP_MIDPOINT_AT_MS,
  FLOAT_FLIP_MS,
  FLOAT_LIFT_MS,
  FLOAT_RETURN_AT_MS,
  FLOAT_RETURN_MS,
  FLOAT_STAMP_AT_MS,
  FLOAT_TOTAL_MS,
  FLOAT_VISIBLE_MS,
  FLOAT_REDUCED_CUE_AT_MS,
  FLOAT_REDUCED_RETURN_AT_MS,
  FLOAT_REDUCED_STAMP_AT_MS,
  FLOAT_REDUCED_SWAP_AT_MS,
  FLOAT_REDUCED_SWAP_MIDPOINT_AT_MS,
  FLOAT_REDUCED_TOTAL_MS,
} = require("./corporationFloatFocus") as typeof import("./corporationFloatFocus");

describe("buildFloatFocusSequence", () => {
  it("is null with no event, in either motion mode", () => {
    expect(buildFloatFocusSequence(null, false)).toBeNull();
    expect(buildFloatFocusSequence(null, true)).toBeNull();
  });

  it("carries the descriptor through untouched", () => {
    const sequence = buildFloatFocusSequence({ companyId: 4, ticker: "B&O" }, false);
    expect(sequence?.companyId).toBe(4);
    expect(sequence?.ticker).toBe("B&O");
  });

  describe("full motion", () => {
    const sequence = buildFloatFocusSequence({ companyId: 1, ticker: "PRR" }, false)!;

    it("orders the four stages lift -> stamp -> flip -> return, each starting where the last leaves off", () => {
      expect(sequence.stages.map((stage) => stage.kind)).toEqual(["lift", "stamp", "flip", "return"]);
      expect(sequence.stages[0].at).toBe(0);
      expect(sequence.stages[1].at).toBe(FLOAT_STAMP_AT_MS);
      expect(sequence.stages[2].at).toBe(FLOAT_FLIP_AT_MS);
      expect(sequence.stages[3].at).toBe(FLOAT_RETURN_AT_MS);
      // The lift finishes exactly as the stamp lands -- the card is at rest when the ink hits.
      expect(sequence.stages[0].durationMs).toBe(FLOAT_LIFT_MS);
      expect(FLOAT_STAMP_AT_MS).toBe(FLOAT_LIFT_MS);
    });

    it("the stamp itself still lands on FLOAT_STAMP_AT_MS -- the audio cue offset never moves it", () => {
      expect(sequence.stages[1]).toEqual({
        kind: "stamp",
        at: FLOAT_STAMP_AT_MS,
        durationMs: sequence.stages[1].durationMs,
      });
      expect(FLOAT_STAMP_AT_MS).toBe(480);
    });

    it("starts floated.mp3 early enough that the CLIP's own measured impact, not its first sample, lands on the stamp beat", () => {
      // Waveform-measured directly against the file in this repo: the clip's own principal impact sits at
      // 458ms in (see the design note beside the constant), not at sample zero -- so playback has to start
      // that far ahead of the stamp beat for the impact itself to land on it.
      expect(FLOAT_AUDIO_IMPACT_OFFSET_MS).toBe(458);
      expect(sequence.stampImpactAt).toBe(FLOAT_CUE_AT_MS);
      expect(FLOAT_CUE_AT_MS).toBe(FLOAT_STAMP_AT_MS - FLOAT_AUDIO_IMPACT_OFFSET_MS);
      expect(FLOAT_CUE_AT_MS).toBe(22);
      // Never negative, whatever the two constants happen to be -- playback cannot start before the
      // sequence exists.
      expect(FLOAT_CUE_AT_MS).toBeGreaterThanOrEqual(0);
      // The resulting absolute impact time (cue start + the clip's own offset) lands exactly on the stamp.
      expect(FLOAT_CUE_AT_MS + FLOAT_AUDIO_IMPACT_OFFSET_MS).toBe(FLOAT_STAMP_AT_MS);
    });

    it("swaps the staged field exactly once, at the flip's hidden midpoint -- not at its start or its end", () => {
      expect(sequence.applications).toHaveLength(1);
      expect(sequence.applications[0].applies).toEqual(["floated"]);
      expect(sequence.applications[0].at).toBe(FLOAT_FLIP_MIDPOINT_AT_MS);
      expect(sequence.midpointAt).toBe(FLOAT_FLIP_MIDPOINT_AT_MS);
      expect(FLOAT_FLIP_MIDPOINT_AT_MS).toBeGreaterThan(FLOAT_FLIP_AT_MS);
      expect(FLOAT_FLIP_MIDPOINT_AT_MS).toBeLessThan(FLOAT_FLIP_AT_MS + FLOAT_FLIP_MS);
    });

    it("returns after the flip completes, and totals inside the brief's 1.6-2.0s visible-motion band", () => {
      expect(sequence.stages[3].at).toBe(FLOAT_FLIP_AT_MS + FLOAT_FLIP_MS);
      expect(FLOAT_VISIBLE_MS).toBe(FLOAT_RETURN_AT_MS + FLOAT_RETURN_MS);
      expect(FLOAT_VISIBLE_MS).toBeGreaterThanOrEqual(1600);
      expect(FLOAT_VISIBLE_MS).toBeLessThanOrEqual(2000);
      // The release hold is on top of the visible motion, not inside the 1.6-2.0s band.
      expect(FLOAT_TOTAL_MS).toBeGreaterThan(FLOAT_VISIBLE_MS);
    });

    it("is not the reduced-motion sequence", () => {
      expect(sequence.reducedMotion).toBe(false);
      expect(sequence.totalMs).toBe(FLOAT_TOTAL_MS);
    });
  });

  describe("reduced motion", () => {
    const sequence = buildFloatFocusSequence({ companyId: 4, ticker: "B&O" }, true)!;

    it("keeps the same four-kind order but drops no semantic step", () => {
      expect(sequence.stages.map((stage) => stage.kind)).toEqual(["lift", "stamp", "flip", "return"]);
    });

    it("is markedly shorter than full motion, and its own constants agree with the sequence", () => {
      expect(sequence.reducedMotion).toBe(true);
      expect(sequence.midpointAt).toBe(FLOAT_REDUCED_SWAP_MIDPOINT_AT_MS);
      expect(sequence.stages[2].at).toBe(FLOAT_REDUCED_SWAP_AT_MS);
      expect(sequence.stages[3].at).toBe(FLOAT_REDUCED_RETURN_AT_MS);
      expect(sequence.totalMs).toBe(FLOAT_REDUCED_TOTAL_MS);
      expect(sequence.totalMs).toBeLessThan(buildFloatFocusSequence({ companyId: 4, ticker: "B&O" }, false)!.totalMs);
    });

    it("cannot reuse the full-motion cue offset -- it would start playback before the sequence exists", () => {
      // 160 (the reduced stamp beat) - 458 (the clip's own measured impact offset) = -298: negative, so the
      // full-motion formula is not used here at all. The stamp itself still lands, unmoved, at its own beat.
      expect(FLOAT_REDUCED_STAMP_AT_MS - FLOAT_AUDIO_IMPACT_OFFSET_MS).toBeLessThan(0);
      expect(sequence.stages[1]).toEqual({
        kind: "stamp",
        at: FLOAT_REDUCED_STAMP_AT_MS,
        durationMs: sequence.stages[1].durationMs,
      });
      // The earliest legal start -- the sequence's own beginning -- is what it uses instead, so the clip's
      // impact lands as close to the stamp beat as this fixed-length clip can get without seeking or
      // trimming it, rather than not playing at all or starting negative.
      expect(sequence.stampImpactAt).toBe(FLOAT_REDUCED_CUE_AT_MS);
      expect(FLOAT_REDUCED_CUE_AT_MS).toBe(0);
      expect(FLOAT_REDUCED_CUE_AT_MS).toBeGreaterThanOrEqual(0);
    });

    it("still swaps the staged field once, at its own midpoint", () => {
      expect(sequence.applications).toEqual([{ applies: ["floated"], at: FLOAT_REDUCED_SWAP_MIDPOINT_AT_MS }]);
    });
  });
});

describe("floatStageAt", () => {
  const sequence = buildFloatFocusSequence({ companyId: 1, ticker: "PRR" }, false)!;

  it("is null before the sequence starts", () => {
    expect(floatStageAt(sequence, -1)?.kind).toBeUndefined();
  });

  it("names the stage active at each stage's own start, and holds through its duration", () => {
    expect(floatStageAt(sequence, 0)?.kind).toBe("lift");
    expect(floatStageAt(sequence, FLOAT_STAMP_AT_MS)?.kind).toBe("stamp");
    expect(floatStageAt(sequence, FLOAT_FLIP_AT_MS)?.kind).toBe("flip");
    expect(floatStageAt(sequence, FLOAT_FLIP_MIDPOINT_AT_MS)?.kind).toBe("flip");
    expect(floatStageAt(sequence, FLOAT_RETURN_AT_MS)?.kind).toBe("return");
  });

  it("holds at the last stage rather than decaying to null once the sequence has finished", () => {
    expect(floatStageAt(sequence, FLOAT_RETURN_AT_MS + FLOAT_RETURN_MS + 10_000)?.kind).toBe("return");
  });
});
