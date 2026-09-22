/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE (INTRO EDITORIAL harness): THREE TITLES, ONE BODY, THREE HANDOFFS
// ==================================================================
//
// The ways this can be wrong are not the ways a normal variant switch can be wrong:
//
//   1. THE WRONG NAME ON THE SCREEN. A room playing the Level Playing Field opening on a wordmark that
//      reads 18XX is #961a's fault -- one variant wearing another's name -- and it is what this pass is
//      for. Resolved through `gameTypeOf` and never through a label or a filename.
//   2. A CROSSFADE THAT EATS THE TITLE. LPF's subtitle does not finish kerning until 3.167s of a 4.000s
//      clip; a handoff chosen for symmetry with the base's 3.011s would dissolve the body over a
//      subtitle still drawing itself. The guard is stated against the MEASUREMENT, not against a number.
//   3. THREE BODIES. Every ruleset must enter the same cinematic, from its own frame zero.
//   4. A CUE ANCHORED TO THE WRONG THING. #1186 expressed the Neta credit in whole-film time, which was
//      right for one film and is wrong for three. It is the body's frame that matters.
//
// The measurements below are the audit's, taken frame by frame at 24fps off the supplied footage. They are
// restated here as the contract the constants have to keep, so a future retime has to disagree with a
// number somebody wrote down.

export {};

const { INTRO_CUTS, creditCueSecondsFor, GAME_INTRO_SRC } =
  require("./GameIntroOverlay") as typeof import("./GameIntroOverlay");
const { gameTypeOf, GAME_TYPE_ORDER } =
  require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { readStripped, sliceBetween } =
  require("../utils/sourceScan") as typeof import("../utils/sourceScan");

type GameType = import("../gameEngine/gameVariants").GameType;

/** The audit, as data. 24fps; every figure a frame boundary except the base's, which is the existing
 *  film's and predates this pass. */
const MEASURED: Readonly<Record<GameType, {
  semanticResolveAt: number;
  visualSettleAt: number;
  clipEndsAt: number;
}>> = {
  // The base wordmark is COMPLETE AT FRAME ZERO -- it never constructs, it only shimmers.
  standard: { semanticResolveAt: 0.0, visualSettleAt: 0.0, clipEndsAt: 4.011 },
  // Lit left to right by a travelling burst; the burst clears the wordmark at frame 70.
  plus: { semanticResolveAt: 1.958, visualSettleAt: 2.916667, clipEndsAt: 4.0 },
  // "A LEVEL PLAYING FIELD" finishes kerning at frame 76 and is static from frame 77.
  levelPlayingField: { semanticResolveAt: 3.166667, visualSettleAt: 3.208333, clipEndsAt: 4.0 },
};

const FRAME = 1 / 24;

describe("the ruleset names the title", () => {
  it("has a cut for each of the three types, and only those", () => {
    expect(Object.keys(INTRO_CUTS).sort()).toEqual([...GAME_TYPE_ORDER].sort());
  });

  it("maps each resolved type to its own film", () => {
    /* THROUGH `gameTypeOf`, which is the authority every other surface asks -- it reads the flags back
       into the choice, so a room dealt by an older build still resolves (gameVariants.ts #1445). */
    const at = (variants: { expandedMap: boolean; levelPlayingField: boolean }) =>
      INTRO_CUTS[gameTypeOf(variants)].src;
    expect(at({ expandedMap: false, levelPlayingField: false })).toContain("game-intro.mp4");
    expect(at({ expandedMap: true, levelPlayingField: false })).toContain("game-intro-plus.mp4");
    expect(at({ expandedMap: true, levelPlayingField: true })).toContain("game-intro-lpf.mp4");
    /* THE LEVEL PLAYING FIELD OUTRANKS THE MAP FLAG, which is `gameTypeOf`'s own rule and the case a
       hand-written document can produce: the field without the map it forces. */
    expect(at({ expandedMap: false, levelPlayingField: true })).toContain("game-intro-lpf.mp4");
  });

  it("keeps the base on the film that was already shipping", () => {
    // Untouched, byte for byte: the base intro was not recomposed by this pass and did not need to be.
    expect(INTRO_CUTS.standard.src).toBe(GAME_INTRO_SRC);
    expect(INTRO_CUTS.standard.handoffAtSeconds).toBe(3.011);
    expect(INTRO_CUTS.standard.crossfadeSeconds).toBe(1.0);
  });

  it("is chosen by the shell from the resolved type, never from a label", () => {
    const APP = readStripped("App.tsx");
    expect(APP).toContain("gameType={gameTypeOf(resolveVariants(gameState?.variants))}");
    const INTRO = readStripped("components/GameIntroOverlay.tsx");
    // No label text, no filename sniffing, no variant booleans read here.
    expect(INTRO).not.toContain("GAME_TYPE_COPY");
    expect(INTRO).not.toContain("expandedMap");
    expect(INTRO).not.toContain("levelPlayingField ?");
  });

  it("does not bring back the HTML title card", () => {
    /* #1186 deleted it: the film opens on its own title, and a React overlay would be a second Project
       18XX over the first. The travelling illumination belongs to the footage. */
    const INTRO = readStripped("components/GameIntroOverlay.tsx");
    expect(INTRO).not.toContain("TITLE_HOLD_UNTIL_MS");
    expect(INTRO).not.toContain("TITLE_FADE_MS");
    expect(INTRO).not.toContain("18XX+");
  });
});

describe("no crossfade eats a title that is still being built", () => {
  it("starts every handoff at or after that title's visual settle", () => {
    /* THE RULE OF THE PASS, and it is editorial rather than numerical: a transition may consume
       decoration and may not consume construction. */
    for (const type of GAME_TYPE_ORDER) {
      expect(INTRO_CUTS[type].handoffAtSeconds).toBeGreaterThanOrEqual(MEASURED[type].visualSettleAt);
    }
  });

  it("never begins before LPF's subtitle has finished resolving", () => {
    /* THE CASE THE BRIEF NAMES. "A LEVEL PLAYING FIELD" is complete at 3.167s; the handoff is at 3.25s,
       a clear two frames later, so the body never dissolves over letters still finding their places. */
    const lpf = INTRO_CUTS.levelPlayingField;
    expect(lpf.handoffAtSeconds).toBeGreaterThan(MEASURED.levelPlayingField.semanticResolveAt);
    expect(lpf.handoffAtSeconds - MEASURED.levelPlayingField.semanticResolveAt).toBeGreaterThanOrEqual(FRAME);
    // And a base-symmetric 3.011 would have failed exactly this, which is why symmetry was refused.
    expect(3.011).toBeLessThan(MEASURED.levelPlayingField.semanticResolveAt);
  });

  it("does not hold Plus through its own dead shimmer for parity", () => {
    /* The other half of section 6. Plus settles a full second before the base hands off, and its tail is
       sparkle drifting off frame; sitting through it to match a runtime would be holding the player on a
       finished picture. The handoff is AT settle, to the frame. */
    expect(INTRO_CUTS.plus.handoffAtSeconds).toBe(MEASURED.plus.visualSettleAt);
    expect(INTRO_CUTS.plus.handoffAtSeconds).toBeLessThan(INTRO_CUTS.standard.handoffAtSeconds);
  });

  it("never asks a title for frames it does not have", () => {
    // The overlap has to fit inside the clip: offset + duration <= the title's own length.
    for (const type of GAME_TYPE_ORDER) {
      const cut = INTRO_CUTS[type];
      expect(cut.handoffAtSeconds + cut.crossfadeSeconds).toBeLessThanOrEqual(
        MEASURED[type].clipEndsAt + 1e-6,
      );
    }
  });

  it("gives LPF the shortest overlap, because its footage leaves the least", () => {
    /* Stated as a consequence rather than as a preference: LPF settles at 3.208 of a 4.000s clip, so
       0.75s is every frame there is. Perceptual equivalence, not numerical. */
    const lpf = INTRO_CUTS.levelPlayingField;
    const tail = MEASURED.levelPlayingField.clipEndsAt - MEASURED.levelPlayingField.visualSettleAt;
    expect(lpf.crossfadeSeconds).toBeLessThan(INTRO_CUTS.standard.crossfadeSeconds);
    expect(lpf.crossfadeSeconds).toBeLessThanOrEqual(tail);
    // It uses essentially all of it -- the handoff ends on the clip's last frame.
    expect(lpf.handoffAtSeconds + lpf.crossfadeSeconds).toBeCloseTo(MEASURED.levelPlayingField.clipEndsAt, 3);
  });

  it("keeps the three runtimes close without making them equal", () => {
    /* Section 6: editorial clarity outranks identical runtime, and the differences stay restrained --
       this is title timing, not three differently paced films. */
    const BODY_SECONDS = 10.006;
    const totals = GAME_TYPE_ORDER.map((type) => INTRO_CUTS[type].handoffAtSeconds + BODY_SECONDS);
    const spread = Math.max(...totals) - Math.min(...totals);
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThan(0.5);
  });
});

describe("one body, entered the same way by everyone", () => {
  it("gives every ruleset the same cinematic from its own frame zero", () => {
    /* `handoffAtSeconds` IS the body's t=0 in each film, which is what makes the three comparable at all.
       Composed from one master by one script -- see the note in `GameIntroOverlay.tsx` and the script
       beside `docs/ai_architecture/source_assets/intro/intro-body.mp4`. */
    const INTRO = readStripped("components/GameIntroOverlay.tsx");
    const cuts = sliceBetween(INTRO, "export const INTRO_CUTS", "const LOGO_HOLD_MS");
    // Three sources, three handoffs -- and no per-variant body, ending or credit anywhere.
    expect((cuts.match(/src:/g) ?? []).length).toBe(3);
    expect(cuts).not.toContain("body");
    expect(cuts).not.toContain("CREDIT");
  });

  it("plays exactly one video element, whichever ruleset it is", () => {
    /* PRE-COMPOSITED, NOT TWO-STAGE. The tradeoff is recorded in the module note; what matters here is
       that no second `<video>` was introduced, so skip, Escape, the duck and the backstop all keep
       governing one element as they always did. */
    const INTRO = readStripped("components/GameIntroOverlay.tsx");
    expect((INTRO.match(/<video/g) ?? []).length).toBe(1);
    expect(INTRO).toContain("key={cut.src}");
    expect(INTRO).toContain("src={cut.src}");
  });
});

describe("the Neta credit belongs to the body", () => {
  it("cues the same body frame in all three films", () => {
    /* THE POINT OF THE REFACTOR. Each film's threshold is its own handoff plus the body's one cue, so the
       words arrive on the mark's draw whatever the title did beforehand. */
    for (const type of GAME_TYPE_ORDER) {
      const bodyRelative = creditCueSecondsFor(type) - INTRO_CUTS[type].handoffAtSeconds;
      /* HALF A TENTH IS THE WHOLE TOLERANCE. The cue is rounded to a tenth of a second because that is
         the resolution a `timeupdate` threshold can act on (#1186's reason, kept), so the body-relative
         error is at most half a step -- LPF is the worst case at 11.9 - 3.25 = 8.65. The 0.001 on top is
         float dust from adding tenths, not slack. */
      expect(Math.abs(bodyRelative - 8.6)).toBeLessThanOrEqual(0.051);
    }
  });

  it("reproduces #1186's hand-written number for the film it was measured on", () => {
    expect(creditCueSecondsFor("standard")).toBe(11.6);
  });

  it("moves the cue when a handoff moves, which is the whole reason it is derived", () => {
    expect(creditCueSecondsFor("plus")).toBeLessThan(creditCueSecondsFor("standard"));
    expect(creditCueSecondsFor("levelPlayingField")).toBeGreaterThan(creditCueSecondsFor("standard"));
  });

  it("keeps one semantic cue, not three magic numbers", () => {
    const RAW = readStripped("components/GameIntroOverlay.tsx");
    expect(RAW).toContain("const BODY_CREDIT_CUE_SECONDS = 8.6;");
    expect(RAW).not.toContain("const CREDIT_CUE_SECONDS");
    expect(RAW).toContain("INTRO_CUTS[type].handoffAtSeconds + BODY_CREDIT_CUE_SECONDS");
  });
});

describe("everything the overlay already guaranteed, still guaranteed", () => {
  const INTRO = readStripped("components/GameIntroOverlay.tsx");

  it("skips and escapes from anywhere in the film", () => {
    /* One element and one `finish`, so there is no stage a skip can fall between -- which is the thing a
       two-stage player would have had to prove and this does not. */
    expect(INTRO).toContain('if (event.key === "Escape") finish();');
    expect(INTRO).toContain("onError={finish}");
    expect((INTRO.match(/finished\.current = true;/g) ?? []).length).toBe(1);
  });

  it("holds the last frame and releases the duck exactly once", () => {
    expect(INTRO).toContain("window.setTimeout(finish, LOGO_HOLD_MS);");
    expect(INTRO).toContain("const release = duckRadio(DUCK_FOR_VIDEO);");
    expect(INTRO).toContain("muted={!sfxEnabled}");
  });

  it("has a backstop that still clears the longest of the three films", () => {
    /* LPF is the longest at ~13.3s, plus the 1.28s hold. The backstop is for a decode failure, not for
       timing, so it stays generous -- but it must not be able to cut the credit off on a slow machine. */
    const backstop = Number((INTRO.match(/const INTRO_BACKSTOP_MS = (\d+);/) ?? [])[1]);
    const longest = Math.max(...Object.values(INTRO_CUTS).map((cut) => cut.handoffAtSeconds)) + 10.006;
    const hold = Number((INTRO.match(/const LOGO_HOLD_MS = (\d+);/) ?? [])[1]);
    expect(backstop).toBeGreaterThan(longest * 1000 + hold);
  });

  it("still gives no intro to a player who joined a room already playing", () => {
    // #1111: the overlay is mounted on the waiting -> playing EDGE, which a late joiner never sees.
    const APP = readStripped("App.tsx");
    expect(APP).toContain("{introPlaying && (");
  });
});
