/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1044-1045 (harness): THE CARCOSA STATE MACHINE
// ==================================================================
//
// A TWO-STAGE EASTER EGG IN A GAME WITH NO SERVER, which is the whole difficulty. The feature was specified
// with three mechanisms -- a hidden flag on a corporation, a line spliced out of the pool, and a 10% roll --
// and each of them, taken literally, would have made two browsers show different sentences for the same turn.
//
// SO THE CASES BELOW COME IN TWO KINDS. The ones about the FEATURE check that the sign fires once, marks its
// corporation, escalates only for that corporation and only a tenth of the time. The ones about
// DETERMINISM check the part a playtest would never catch: that two clients replaying the same log agree.
// The second kind is the reason this file exists rather than a few more cases in `batch46`.

export {};

const {
  YELLOW_SIGN_MALUS_LINE,
  YELLOW_SIGN_BONUS_LINE,
  NO_YELLOW_SIGN,
  yellowSignStateFrom,
  carcosaRollHits,
  CARCOSA_CHANCE_IN_100,
  resolveFlavourLine,
} = require("./yellowSign") as typeof import("./yellowSign");
const { UNPREDICTABLE_REVENUE_FLAVOR } =
  require("../constants/flavorText") as typeof import("../constants/flavorText");
const {
  turnRevenueSentence,
  rollTurnRevenue,
  revenueFlavourClause,
  flavorBucketFor,
  legacyTurnSeed,
  revenueDieFace,
} =
  require("./gameVariants") as typeof import("./gameVariants");
const { variantCueFor } = require("./variantSfx") as typeof import("./variantSfx");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const OVERLAY = readStripped("components/YellowSignOverlay.tsx");
const SIGN = readStripped("utils/yellowSign.ts");

/* Design note #1051: the pre-#1051 die, asked for by name. Every case in this file was written against the
   FNV hash and measures its behaviour; `legacyTurnSeed` is that hash, and it is still the path a game logged
   before the roll was recorded replays through. `batch50.test.ts` owns the claim about a real draw. */
const parts = (companyId: number, macroRound = 3, subRound = 1) => ({
  macroRound,
  subRound,
  companyId,
  turnSeed: legacyTurnSeed(macroRound, subRound, companyId),
});
const resolve = (over: Partial<Parameters<typeof resolveFlavourLine>[0]>) =>
  resolveFlavourLine({
    naturalLine: "The trains ran on schedule, more or less.",
    bucket: "unchanged",
    ticker: "PRR",
    parts: parts(1),
    state: NO_YELLOW_SIGN,
    /* Design note #1046: the windows. The default is Phase 4, which is inside the MARK window and outside the
       ESCALATION one -- so a case about Stage 2 must say so, and cannot pass by accident. */
    phaseTier: "4",
    owned: ["2", "4"],
    ...over,
  });

/* ------------------------------------------------------------------ */
/* The lines exist, exactly as written                                */
/* ------------------------------------------------------------------ */

describe("the two lines are the ones in the payload", () => {
  it("finds the mark in criticalMalus and the escalation in criticalBonus", () => {
    /* QUOTED VERBATIM IN THE MODULE, which is a copy -- so this is the case that catches a stray edit to
       either the payload or the constant. A one-character drift would silently disable the whole feature:
       `resolveFlavourLine` compares by equality, so a line that no longer matches simply never fires and
       nothing anywhere goes red. */
    expect(UNPREDICTABLE_REVENUE_FLAVOR.criticalMalus).toContain(YELLOW_SIGN_MALUS_LINE);
    expect(UNPREDICTABLE_REVENUE_FLAVOR.criticalBonus).toContain(YELLOW_SIGN_BONUS_LINE);
  });

  it("keeps them out of every other bucket", () => {
    for (const bucket of ["minorMalus", "unchanged", "minorBonus"] as const) {
      expect(UNPREDICTABLE_REVENUE_FLAVOR[bucket]).not.toContain(YELLOW_SIGN_MALUS_LINE);
      expect(UNPREDICTABLE_REVENUE_FLAVOR[bucket]).not.toContain(YELLOW_SIGN_BONUS_LINE);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Stage 1                                                            */
/* ------------------------------------------------------------------ */

describe("the mark fires once and marks its corporation", () => {
  it("fires on its natural draw when nobody is marked", () => {
    const out = resolve({ naturalLine: YELLOW_SIGN_MALUS_LINE, bucket: "criticalMalus" });
    expect(out.line).toBe(YELLOW_SIGN_MALUS_LINE);
    expect(out.stage).toBe("mark");
  });

  it("is skipped forever once somebody holds it", () => {
    /* "PERMANENTLY REMOVE THE STAGE 1 STRING FROM THE GLOBAL MALUS POOL SO NO OTHER CORPORATION CAN EVER DRAW
       IT." Implemented as a skip rather than a splice -- see the determinism describe for why that matters. */
    const out = resolve({
      naturalLine: YELLOW_SIGN_MALUS_LINE,
      bucket: "criticalMalus",
      ticker: "NYC",
      state: { markedTicker: "PRR", carcosaSeen: false },
    });
    expect(out.line).not.toBe(YELLOW_SIGN_MALUS_LINE);
    expect(out.stage).toBeNull();
  });

  it("substitutes a real line from the same bucket", () => {
    /* THE SKIP MUST LAND SOMEWHERE VALID. An out-of-range index would put `undefined` into the Activity Log,
       which is the failure `flavorText.test.ts`'s length cases were written for. */
    const out = resolve({
      naturalLine: YELLOW_SIGN_MALUS_LINE,
      bucket: "criticalMalus",
      state: { markedTicker: "PRR", carcosaSeen: false },
    });
    expect(UNPREDICTABLE_REVENUE_FLAVOR.criticalMalus).toContain(out.line);
  });

  it("reads the mark back out of the log", () => {
    /* THE STATE IS THE LOG. Built with the REAL `turnRevenueSentence`, so the parser and the composer cannot
       drift apart without this going red -- which is the coupling `yellowSign.ts` acknowledges rather than
       hides. */
    const roll = rollTurnRevenue(170, parts(4));
    const label = turnRevenueSentence("B&M", roll, parts(4)).replace(
      revenueFlavourClause(roll, parts(4)),
      YELLOW_SIGN_MALUS_LINE,
    );
    expect(yellowSignStateFrom([label]).markedTicker).toBe("B&M");
  });

  it("reports nobody marked on an ordinary log", () => {
    expect(yellowSignStateFrom(["PRR ran for $170. The trains ran on schedule, more or less."]))
      .toEqual({ markedTicker: null, carcosaSeen: false });
    expect(yellowSignStateFrom([])).toEqual({ markedTicker: null, carcosaSeen: false });
  });
});

/* ------------------------------------------------------------------ */
/* Stage 2                                                            */
/* ------------------------------------------------------------------ */

describe("the escalation belongs to the marked corporation alone", () => {
  const marked = { markedTicker: "PRR", carcosaSeen: false };
  /** Every Stage 2 case runs in the escalation window; the window itself is tested separately. */
  const inWindow = { phaseTier: "5" as const };
  /** A company id whose seeded tenth lands, so the case is about the RULE and not about the dice. */
  const hitId = (() => {
    for (let id = 1; id < 500; id += 1) if (carcosaRollHits(parts(id))) return id;
    throw new Error("no seed in range hits the tenth -- the roll is broken, not the fixture");
  })();

  it("draws for the marked corporation on a critical bonus", () => {
    const out = resolve({
      bucket: "criticalBonus",
      ticker: "PRR",
      parts: parts(hitId),
      state: marked,
      ...inWindow,
    });
    expect(out.line).toBe(YELLOW_SIGN_BONUS_LINE);
    expect(out.stage).toBe("carcosa");
  });

  it("never draws for anybody else", () => {
    /* "THE STAGE 2 BONUS TEXT CAN ONLY BE DRAWN BY THE CORPORATION HOLDING THE FLAG." Same turn, same roll,
       different ticker -- so this case isolates the ownership rule from the chance. */
    const out = resolve({
      bucket: "criticalBonus",
      ticker: "NYC",
      parts: parts(hitId),
      state: marked,
      ...inWindow,
    });
    expect(out.stage).toBeNull();
  });

  it("never draws before the mark", () => {
    const out = resolve({
      bucket: "criticalBonus",
      ticker: "PRR",
      parts: parts(hitId),
      state: NO_YELLOW_SIGN,
      ...inWindow,
    });
    expect(out.stage).toBeNull();
  });

  it("never draws twice", () => {
    const out = resolve({
      bucket: "criticalBonus",
      ticker: "PRR",
      parts: parts(hitId),
      state: { markedTicker: "PRR", carcosaSeen: true },
      ...inWindow,
    });
    expect(out.stage).toBeNull();
  });

  it("never draws outside a critical bonus", () => {
    /* A MINOR BONUS IS NOT A CRITICAL ONE. The ruling names `criticalBonus` specifically, and the marked
       corporation will roll plenty of the lesser kind. */
    for (const bucket of ["minorBonus", "unchanged", "minorMalus", "criticalMalus"] as const) {
      expect(resolve({ bucket, ticker: "PRR", parts: parts(hitId), state: marked, ...inWindow }).stage)
        .toBeNull();
    }
  });

  it("is a chance, not a certainty, at whatever rate the constant names", () => {
    /* THE CHANCE IS REAL and this is the case that says so -- a rule that always fired would pass every
       assertion above. Measured across 4000 turns rather than asserted at a point.
       ==================================================================
        DESIGN NOTE 1051: THE BAND WAS 6%-15% AND THE RATE IS 20% NOW
       ==================================================================
       THE FIGURE WAS RULED UP -- offered 10%, 20% and 30% as real numbers once the die became a real draw,
       and 20% was chosen. This case failed on that, correctly: it was the only thing in the tree still
       asserting one-in-ten.
       DERIVED FROM THE CONSTANT NOW, NOT WRITTEN OUT. `0.06` and `0.15` were a band drawn around a number
       that lived somewhere else, which is the same shape #891 keeps naming and the same shape
       `CARCOSA_CHANCE_IN_100`'s own note describes: the constant and the behaviour were two claims that
       happened to agree. Re-tuning the rate should move this band by itself or the case is a second place to
       remember.
       +/- 20% OF THE EXPECTED COUNT. At 4000 draws and p = 0.2 the standard deviation is about 25 counts, so
       a 160-count band is over six sigma -- wide enough never to flake, narrow enough that a roll stuck at
       certainty or silence still fails it. */
    let hits = 0;
    for (let id = 1; id <= 4000; id += 1) if (carcosaRollHits(parts(id))) hits += 1;
    const expected = 4000 * (CARCOSA_CHANCE_IN_100 / 100);
    expect(hits).toBeGreaterThan(expected * 0.8);
    expect(hits).toBeLessThan(expected * 1.2);
  });

  it("keeps the escalation out of the pool by any other route", () => {
    /* THE BONUS LINE IS UNREACHABLE EXCEPT THROUGH STAGE 2. Drawn naturally by an unmarked corporation it is
       skipped, so the sentence can never appear without its video. */
    const out = resolve({
      naturalLine: YELLOW_SIGN_BONUS_LINE,
      bucket: "criticalBonus",
      ticker: "NYC",
      state: NO_YELLOW_SIGN,
      ...inWindow,
    });
    expect(out.line).not.toBe(YELLOW_SIGN_BONUS_LINE);
    expect(UNPREDICTABLE_REVENUE_FLAVOR.criticalBonus).toContain(out.line);
  });
});

/* ------------------------------------------------------------------ */
/* Determinism -- the half a playtest cannot see                      */
/* ------------------------------------------------------------------ */

describe("two clients replaying one log agree", () => {
  it("never mutates the flavour arrays", () => {
    /* ==================================================================
        THE DANGEROUS READING OF "REMOVE FROM THE POOL"
       ==================================================================
       `revenueFlavourClause` indexes with `hash % lines.length` (#907). Splice one line out and the length
       drops, which RE-POINTS EVERY INDEX in that bucket -- so a client that had seen the sign would print a
       different sentence for every subsequent turn than a client that had not. The bug would look like the
       log disagreeing with itself and would be almost impossible to attribute.
       ASSERTED AS LENGTHS BEFORE AND AFTER, across every path that could have spliced. */
    const before = {
      criticalMalus: UNPREDICTABLE_REVENUE_FLAVOR.criticalMalus.length,
      criticalBonus: UNPREDICTABLE_REVENUE_FLAVOR.criticalBonus.length,
    };
    resolve({ naturalLine: YELLOW_SIGN_MALUS_LINE, bucket: "criticalMalus" });
    resolve({
      naturalLine: YELLOW_SIGN_MALUS_LINE,
      bucket: "criticalMalus",
      state: { markedTicker: "PRR", carcosaSeen: false },
    });
    resolve({
      bucket: "criticalBonus",
      ticker: "PRR",
      state: { markedTicker: "PRR", carcosaSeen: false },
    });
    expect(UNPREDICTABLE_REVENUE_FLAVOR.criticalMalus.length).toBe(before.criticalMalus);
    expect(UNPREDICTABLE_REVENUE_FLAVOR.criticalBonus.length).toBe(before.criticalBonus);
  });

  it("leaves every ordinary line exactly where it was", () => {
    /* THE PROPERTY THE LENGTH CHECK IS A PROXY FOR. A future "optimisation" that rebuilt the array without
       the sign lines would keep a stable length only by accident; this asks the real question. */
    for (let id = 1; id <= 40; id += 1) {
      const roll = rollTurnRevenue(170, parts(id));
      const natural = revenueFlavourClause(roll, parts(id));
      if (natural === YELLOW_SIGN_MALUS_LINE || natural === YELLOW_SIGN_BONUS_LINE) continue;
      const seen = resolve({
        naturalLine: natural,
        bucket: flavorBucketFor(roll),
        ticker: "NYC",
        parts: parts(id),
        state: { markedTicker: "PRR", carcosaSeen: true },
      });
      expect(seen.line).toBe(natural);
    }
  });

  it("rolls the tenth from the turn, not from Math.random", () => {
    /* THE THIRD MECHANISM THAT WOULD HAVE DESYNCED THE TABLE. An unseeded roll gives every browser its own
       answer to the same question about the same turn -- and the sentence is in a SHARED log, so the
       disagreement is visible to everybody. Asserted twice over: the function is stable, and the source does
       not reach for `Math.random`. */
    for (let id = 1; id <= 50; id += 1) {
      expect(carcosaRollHits(parts(id))).toBe(carcosaRollHits(parts(id)));
    }
    expect(SIGN).not.toContain("Math.random");
  });

  it("decorrelates the roll from the die that produced the bonus", () => {
    /* ==================================================================
        DESIGN NOTE 1051: THIS CASE ENFORCED THE BUG IT WAS WRITTEN TO PREVENT
       ==================================================================
       IT ASSERTED `SIGN).toContain("macroRound: parts.macroRound + 7919")` -- the presence of a salt -- and
       its own note states the requirement correctly: "an undecorrelated tenth could be near-certain or
       near-impossible rather than one in ten." It then checked that a decorrelation had been WRITTEN, never
       that one had been ACHIEVED.
       IT HAD NOT. Measured across every turn key a real game can reach, the roll fired 29% of the time at
       face 6 -- the only face that can reach it -- and about 2% at the odd faces. The salt changed the FRONT
       of the hashed key and FNV-1a's low bits are dominated by what it reads LAST, which was identical; both
       `% 6` and `% 10` turn on that low bit. The mechanism was present, named, and inert. Salting the end
       instead measured worse: 0% at faces 2, 4 and 6.
       THE FOURTH RECURRING BUG SHAPE IN THIS CODEBASE, from the inside: a test that pins the mechanism its
       note describes instead of the property its note claims. A source scan cannot tell a decorrelation from
       a comment about one, and this one could not tell it from a decorrelation that did nothing.
       SO IT MEASURES NOW. `turnSeed` is a real draw (#1051), so the question is whether the extraction keeps
       the roll independent of the face -- which is a distribution, and distributions have to be counted. */
    const faces = [0, 0, 0, 0, 0, 0];
    const hits = [0, 0, 0, 0, 0, 0];
    /* A DETERMINISTIC SWEEP, NOT `Math.random`. A flaky probability case is worse than none -- it teaches the
       reader to re-run rather than to read. The LCG below is the standard Numerical Recipes one; all that is
       being asked of it is that it walks the whole 32-bit range instead of one residue class, which is the
       hazard #969 measured when a fixture and the thing under test shared a factor. */
    let x = 12345;
    for (let at = 0; at < 60000; at += 1) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      const seeded = { macroRound: 3, subRound: 1, companyId: 1, turnSeed: x };
      const face = revenueDieFace(seeded);
      faces[face - 1] += 1;
      if (carcosaRollHits(seeded)) hits[face - 1] += 1;
    }
    /* EVERY FACE, not just the one the feature uses. Face 6 is what gates the escalation, so a rate correct
       only there would pass a narrower case while still proving the two draws move together -- the old
       failure had 29% at face 6 and 2% at face 1, and it is the SPREAD between them that names it. */
    for (let face = 0; face < 6; face += 1) {
      const rate = (100 * hits[face]) / faces[face];
      expect(rate).toBeGreaterThan(CARCOSA_CHANCE_IN_100 - 3);
      expect(rate).toBeLessThan(CARCOSA_CHANCE_IN_100 + 3);
    }
  });

  it("derives the state rather than storing a flag", () => {
    expect(APP).toContain("yellowSignStateFrom(actionLogRef.current.map((entry) => entry.label))");
    expect(APP).not.toContain("hasYellowSign");
  });
});

/* ------------------------------------------------------------------ */
/* The media and the override                                         */
/* ------------------------------------------------------------------ */

describe("the haunting owns the moment", () => {
  it("picks the right clip for each stage", () => {
    expect(variantCueFor({ line: YELLOW_SIGN_MALUS_LINE, bucket: "criticalMalus", stage: "mark" }).video)
      .toBe("yellow-sign.mp4");
    expect(variantCueFor({ line: YELLOW_SIGN_BONUS_LINE, bucket: "criticalBonus", stage: "carcosa" }).video)
      .toBe("carcosa-awaits.mp4");
  });

  it("suppresses the standard flash for both", () => {
    for (const stage of ["mark", "carcosa"] as const) {
      const cue = variantCueFor({ line: YELLOW_SIGN_MALUS_LINE, bucket: "criticalMalus", stage });
      expect(cue.suppressStandardVisuals).toBe(true);
      expect(cue.videoMs).toBe(10000);
    }
  });

  it("suppresses nothing on an ordinary turn", () => {
    expect(variantCueFor({ line: "A station cat fell asleep on the timetable and refused to move.", bucket: "minorMalus" }).suppressStandardVisuals)
      .toBe(false);
  });

  it("is the field the shell gates the flash on", () => {
    /* ==================================================================
        DESIGN NOTE 1065: THE GUARD LOST ITS FIRST CLAUSE AND KEPT ITS SUBJECT
       ==================================================================
       THIS PINNED `revenueOutcome(roll) !== "normal" && !cue.suppressStandardVisuals`. The first clause is
       gone: a neutral roll now flashes `+0%` instead of nothing, because silence on a third of the die's
       faces looked exactly like a variant that had failed to fire. The OUTCOME still decides the figure --
       `App.tsx` #1065 passes a hard zero for `"normal"` so the swallowed 90% never flashes `-10%` -- it just
       decides a figure rather than deciding whether to appear at all.
       WHAT THIS CASE IS FOR IS THE SECOND CLAUSE, which is untouched: the haunting suppresses the standard
       visuals, and it is asserted alone rather than as part of an expression it does not own. Pinning a
       neighbour's clause is how this file broke the last time the condition grew. */
    expect(APP).toContain("!cue.suppressStandardVisuals");
    expect(APP).toContain("setRevenueFlash({");
  });

  it("plays the video aloud so its audio layers with the clip", () => {
    /* RULED, REVERSING #1043: "unmuted so its built-in audio layers with the MP3 string". */
    expect(OVERLAY).toContain("muted={!sfxEnabled}");
  });

  it("still lets the SFX mute silence it", () => {
    /* THE CONSEQUENCE HANDLED RATHER THAN ACCEPTED. A clip that shouted through the mute would be the
       feature ignoring the one audio control the table has. */
    expect(APP).toContain("sfxEnabled={sfxEnabled}");
  });

  it("ducks the radio for the clip's whole run", () => {
    /* THE OTHER CONSEQUENCE. The video element is outside `playVariantCue` entirely, so without this the bed
       plays at full volume under ten seconds of haunting -- which is what #1043 was avoiding by muting it. */
    /* Design note #1073: the call names its DEPTH now -- short cues barely touch the bed and this ten-second
       clip still needs the deep duck. What this case is for is that the video ducks at all. */
    expect(APP).toContain("duckRadio(DUCK_FOR_VIDEO)");
    expect(APP).toContain("releaseHaunting();");
  });
});
