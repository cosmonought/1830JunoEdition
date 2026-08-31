/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1040-1043 (harness): THE VARIANT GETS A VOICE
// ==================================================================
//
// FOUR FEATURES, ONE EVENT. A flavour line now chooses a sound, tints its own log entry, and -- twice a game
// at most -- brings a ten-second video with it that suppresses the ordinary flash. They are tested together
// because they are decided together, in one place, from one line of text.
//
// THE CENSUS IS THE HEART OF THIS FILE. The supplied keyword table was measured against the 595 lines it
// scans before a word of it was written, and several patterns were firing on the wrong lines: `/ice/` matched
// 25 lines of which 2 are about ice, `/cat/` matched every CATTLE line before the cow rule could see it. The
// counts below are that measurement, pinned -- so a future line that quietly steals another's sound shows up
// as a number moving rather than as a cow that moos like a cat.

export {};

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");

const {
  variantCueFor,
  everySfxFile,
  BUCKET_FALLBACK,
  SFX_KEYWORDS,
  YELLOW_SIGN_DURATION_MS,
  YELLOW_SIGN_FIRST,
  YELLOW_SIGN_AGAIN,
  isBonusBucket,
} = require("./variantSfx") as typeof import("./variantSfx");
const { UNPREDICTABLE_REVENUE_FLAVOR } =
  require("../constants/flavorText") as typeof import("../constants/flavorText");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const AUDIO = readStripped("utils/audio.ts");
const OVERLAY = readStripped("components/YellowSignOverlay.tsx");
const TICKER = readStripped("components/TopTicker.tsx");

type Bucket = keyof typeof UNPREDICTABLE_REVENUE_FLAVOR;
const BUCKETS = Object.keys(UNPREDICTABLE_REVENUE_FLAVOR) as Bucket[];
/* Design note #1044: `priorYellowSigns` became `stage`. This file is about the KEYWORD TABLE, so its cue
   helper passes no stage at all -- every case here is an ordinary turn, which is what makes them a fair test
   of the mapping. The Easter egg's own cases moved to `batch47.test.ts` with the state machine. */
const cue = (line: string, bucket: Bucket) => variantCueFor({ line, bucket });

/* ------------------------------------------------------------------ */
/* The anchoring, which is the whole of #1040                         */
/* ------------------------------------------------------------------ */

describe("a substring is not a word", () => {
  it("does not hear ice in service, office, price, twice or choice", () => {
    /* THE WORST OF THE UNANCHORED PATTERNS: 25 matches, 2 of them about ice. Every line here is a real one
       from the payload, and every one of them would have cracked ice. */
    for (const line of [
      "An argument over fares delayed the afternoon service.",
      "The ticket office had a surprisingly successful day selling fares at the wrong price.",
      "A wildly successful excursion filled every carriage twice over.",
      "A rival company’s locomotive shortage left its customers with no choice but to ride with us.",
      "A pair of newlyweds departed beneath a shower of rice.",
    ]) {
      expect(cue(line, "minorMalus").audio).not.toBe("iec-crack.mp3");
    }
  });

  it("still hears real ice", () => {
    // The two that are: one river, one winter. Anchoring must not have cost them.
    expect(cue("A great wave of river ice smashed into the company’s riverside facilities.", "criticalMalus").audio)
      .toBe("iec-crack.mp3");
    expect(cue("A mild winter kept the tracks perfectly clear of ice and snow.", "minorBonus").audio)
      .toBe("iec-crack.mp3");
  });

  it("gives the violin line its violin", () => {
    /* THE COLLISION THAT MADE THE POINT. `/ice/` sits above `/violin/` in the supplied order, so
       "pract-ICE-d his violin" took the ice sound and the violin file had exactly one line in 595 to earn
       it. Anchoring fixed two bugs with one `\\b`. */
    expect(cue("A gentleman practiced his violin in an empty waiting room.", "unchanged").audio)
      .toBe("violin.mp3");
  });

  it("lets the cattle reach the cow", () => {
    /* THE OTHER GUARANTEED ONE. `/cat/` precedes the context-aware `/cattle|cow/`, so every cattle line
       meowed and the cow-happy/cow-sad pair could never fire at all. */
    expect(cue("A herd of cattle occupied the tracks for most of the afternoon.", "criticalMalus").audio)
      .toBe("cow-sad.mp3");
    expect(cue("A regional cattle drive routed extra stock through the yard.", "minorBonus").audio)
      .toBe("cow-happy.mp3");
  });

  it("still hears a real cat", () => {
    expect(cue("A station cat fell asleep on the timetable and refused to move.", "minorMalus").audio)
      .toBe("cat-meow.mp3");
  });

  it("does not hear a factory in satisfactory, or a fire in firewood", () => {
    expect(cue("The directors declared the day “satisfactory” and adjourned for lunch.", "unchanged").audio)
      .toBe(BUCKET_FALLBACK.unchanged);
    expect(cue("A minor shortage of firewood slowed one locomotive.", "minorMalus").audio)
      .toBe(BUCKET_FALLBACK.minorMalus);
  });

  it("keeps the plurals and compounds that ARE the word", () => {
    /* THE CONTROL ON THE ANCHORING, and the reason it was applied selectively rather than everywhere.
       "robbers", "wheels", "exploded", "hailstorm", "photographer" and "racehorse" are all legitimately the
       word their pattern names -- a blanket `\\b` sweep would have lost every one of them. */
    expect(cue("Train robbers relieved the company of 20% of its revenue.", "criticalMalus").audio).toBe("gunshots.mp3");
    expect(cue("A child counted the wheels as the locomotive passed.", "unchanged").audio).toBe("metal_clunk.mp3");
    expect(cue("A boiler exploded and sent the passengers scrambling.", "criticalMalus").audio).toBe("explosion.mp3");
    expect(cue("A violent hailstorm shattered carriage windows and sent passengers home.", "criticalMalus").audio).toBe("thunder.mp3");
    expect(cue("A photographer took a portrait of the locomotive and its crew.", "unchanged").audio).toBe("camera-shutter.mp3");
    expect(cue("A famous racehorse was transported to town for an important event.", "minorBonus").audio).toBe("horse-happy.mp3");
  });
});

/* ------------------------------------------------------------------ */
/* The census                                                         */
/* ------------------------------------------------------------------ */

describe("the table measured against the payload it scans", () => {
  const audioFor = (bucket: Bucket) =>
    UNPREDICTABLE_REVENUE_FLAVOR[bucket].map((line) => cue(line, bucket).audio);

  it("matches a keyword on 139 of the 595 lines", () => {
    /* THE NUMBER THAT MOVES WHEN A PATTERN STARTS STEALING. It is not a target -- the remaining lines taking
       their bucket's fallback is the intended shape -- it is a tripwire: a widened pattern shows up here
       before it shows up as the wrong animal in a playtest.
       ==================================================================
        DESIGN NOTE 1044: 141 BECAME 139, AND THE TWO ARE THE SIGN LINES
       ==================================================================
       #1040 TESTED `/yellow sign/` INSIDE THIS FUNCTION, so both sign lines counted as keyword matches. The
       stages are a state machine now (#1044) and the cue is told which one fired, so with no stage those two
       lines match nothing and fall to their bucket's fallback like any other.
       WHICH IS THE HONEST COUNT, because they can no longer BE ordinary turns: `resolveFlavourLine` skips
       both unless a stage fires, so this census is now exactly "keyword matches among the lines a normal turn
       can draw". The two of them are covered in `batch47.test.ts`, where the rule that selects them lives.
       VERIFIED AS EXACTLY THOSE TWO rather than assumed from the arithmetic -- a drop of two could as easily
       have been a pattern quietly losing a pair of lines, which is the failure this case exists to catch. */
    let matched = 0;
    for (const bucket of BUCKETS) {
      const fallback = BUCKET_FALLBACK[bucket];
      matched += audioFor(bucket).filter((file) => file !== fallback).length;
    }
    /* Design note #1087: 139 -> 195. Four new scenes (ledger, shovel, trestle, pickaxe) and four widened
       patterns claimed 56 lines that had nothing but their bucket's fallback, plus five that moved off a
       clip matching a metaphor rather than an event. The tripwire is re-based rather than loosened: it is
       still an exact count, so a widened pattern still shows up here before it shows up in a playtest.
       `batch58` holds the reasoning and pins every one of the five that moved. */
    // Design note #1103: 195 -> 197, the two weather lines `blizzard.mp3` claims. `batch58` holds the
    // reasoning and the dry run; this stays an exact count for the same reason it always was.
    // Design note #1105: 197 -> 199, the two rain lines that were on a fallback. `batch58` holds the dry run.
    expect(matched).toBe(199);
  });

  it("leaves no sound unreachable", () => {
    /* A FILE NO LINE CAN TRIGGER is a file nobody will ever hear, and the likeliest cause is another pattern
       above it swallowing its lines -- which is exactly what `/ice/` was doing to the violin. */
    const heard = new Set<string>();
    /* Design note #1081: a bucket's cue can be `null` now -- the unchanged default is silence -- and a
       `null` in this set would compare against no filename and quietly widen "unreachable". */
    for (const bucket of BUCKETS) {
      for (const file of audioFor(bucket)) if (file !== null) heard.add(file);
    }
    const unreachable = everySfxFile().filter(
      (file) => !file.endsWith(".mp4") && !heard.has(file) && !/yellow_sign|carcosa/.test(file),
    );
    expect(unreachable).toEqual([]);
  });

  it("falls back per bucket when nothing matches", () => {
    /* ==================================================================
        DESIGN NOTE 1087: THIS EXAMPLE STOPPED BEING AN EXAMPLE
       ==================================================================
       IT USED "The books balanced beautifully, provided nobody actually looked at them." as a line NOTHING
       matches -- and #1087 gave the bookkeeping scene its own clip, so `the books` now claims it. The case
       is about the FALLBACK, not about that sentence, so the sentence is swapped rather than the claim.
       REPLACED WITH A LINE THAT MATCHES NO PATTERN AT ALL, chosen by asking the live table which
       `criticalMalus` lines still fall through rather than by reading the sentence and guessing. */
    expect(cue("Management blamed the weather, and the weather declined to comment.", "criticalMalus").audio)
      .toBe("sad-trombone.mp3");
    // And the retired example is now claimed, which is the change that broke this case.
    expect(cue("The books balanced beautifully, provided nobody actually looked at them.", "criticalMalus").audio)
      .toBe("ledger.mp3");
    /* ==================================================================
        DESIGN NOTE 1081: THE UNCHANGED BUCKET'S DEFAULT IS SILENCE
       ==================================================================
       RULED: "Completely remove the audio trigger from the ... Unchanged (0%) state ... It must be completely
       silent" -- narrowed to "ONLY remove coins-clinking from the Unchanged revenue events. Some of the
       Unchanged events have more 'unique' flavor text with sound effects that can still play."
       BOTH HALVES ARE ASSERTED, because the narrowing is the whole substance: a line no keyword claims is
       silent, and a line a keyword claims still sounds. Pinning only the first would be satisfied by
       silencing the bucket outright, which is the change that was explicitly NOT wanted. */
    expect(cue("The day passed without financial incident.", "unchanged").audio).toBeNull();
    expect(cue("A child counted the wheels as the locomotive passed.", "unchanged").audio)
      .toBe("metal_clunk.mp3");
    expect(cue("Business was brisk, and nobody has yet asked why.", "criticalBonus").audio).toBe("cha-ching.mp3");
  });
});

/* ------------------------------------------------------------------ */
/* Files actually on disk                                             */
/* ------------------------------------------------------------------ */

describe("every clip the table names exists", () => {
  it("finds all of them in public/audio", () => {
    /* ==================================================================
        THE QUIETEST FAILURE IN THIS CODEBASE
       ==================================================================
       `playQuietly` swallows every reason a clip might not play (#1009) -- deliberately, because autoplay
       refusal is the expected case. The cost is that a 404 is indistinguishable from a sound that simply is
       not very loud, so a mistyped filename would ship and be found in a playtest, if ever.
       TWO ARE ALREADY MISTYPED ON DISK: `iec-crack.mp3` transposes `ice-crack`, and `carcosa_awaits.mp3`
       uses an underscore where the spec uses a hyphen. The constants match the DISK, and this case is what
       keeps the two in step -- rename the files and it goes red until the constants follow. */
    const dir = path.join(__dirname, "..", "..", "public", "audio");
    const present = new Set(fs.readdirSync(dir));
    const missing = everySfxFile().filter((file) => !present.has(file));
    expect(missing).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The Yellow Sign                                                    */
/* ------------------------------------------------------------------ */

describe("an ordinary line never brings a video", () => {
  /* ==================================================================
      THE ESCALATION CASES MOVED TO `batch47.test.ts` (design note #1044)
     ==================================================================
     THEY ASSERTED "first sighting plays the sign, every one after plays Carcosa", which was the rule when
     #1040 shipped. It is not the rule now: the stages are a state machine over a marked corporation and a
     seeded tenth, and testing them from a line alone is no longer possible -- which is the point of moving
     them rather than rewriting them here.
     WHAT STAYS IS THE PROPERTY THIS FILE OWNS: the keyword table never produces a video by itself. A pattern
     that started returning one would mean an ordinary turn suppressing the revenue flash, which is the
     failure this case exists to catch. */
  it("returns no video and suppresses nothing without a stage", () => {
    for (const bucket of BUCKETS) {
      for (const line of UNPREDICTABLE_REVENUE_FLAVOR[bucket]) {
        const result = cue(line, bucket);
        if (result.video !== null || result.suppressStandardVisuals) {
          throw new Error(`${bucket}: "${line.slice(0, 60)}" produced a video without a stage`);
        }
      }
    }
  });

  it("still names the two clips it will be asked for", () => {
    // The media constants stay here with the rest of the file inventory; the RULE for choosing them does not.
    expect(YELLOW_SIGN_FIRST.video).toBe("yellow-sign.mp4");
    expect(YELLOW_SIGN_AGAIN.video).toBe("carcosa-awaits.mp4");
    expect(YELLOW_SIGN_DURATION_MS).toBe(10000);
  });
});

/* ------------------------------------------------------------------ */
/* The audio engine                                                   */
/* ------------------------------------------------------------------ */

describe("the bed gets out of the way", () => {
  it("ducks two different depths and fades back", () => {
    /* ==================================================================
        DESIGN NOTE 1073: ONE DEPTH WAS SERVING TWO SITUATIONS
       ==================================================================
       THIS PINNED A SINGLE `DUCKED_RADIO_VOLUME` AT A FIFTH, which was right when every cue was a short clip
       at the old levels. REPORTED after the effects were normalised: "they are considerably louder than the
       radio now ... I'd only duck 80% ... EXCEPT ... on the yellow sign and carcosa videos, where indeed the
       20% duck for the extended play makes sense."
       SO THE FIFTH SURVIVES WHERE IT WAS EARNED. A ten-second clip with its own dialogue competes with the
       bed; a half-second coin clink sits over it, and dropping the radio to a fifth for that is a hole the
       listener hears open and close. Both are asserted, because the pair is the point -- a single constant at
       either value would be wrong for the other case. */
    /* Design note #1074 SUPERSEDED THE FORM, NOT THE RULE. These read `RADIO_VOLUME * 0.8` and `* 0.2` --
       a level computed once at module load, which stopped being the bed's level the moment a slider could
       move it. The depths are now FRACTIONS applied at duck time. The two figures the report argued for are
       unchanged, so the case still asserts the pair; only the multiplicand is gone. */
    expect(AUDIO).toContain("export const DUCK_FOR_CUE = 0.8;");
    expect(AUDIO).toContain("export const DUCK_FOR_VIDEO = 0.2;");
    // The fraction has to REACH the element, or two named depths would be two unused constants.
    expect(AUDIO).toContain("duckTarget?.setVolume(radioVolume * activeDuck);");
    expect(AUDIO).toContain("export const DUCK_FADE_MS = 900;");
  });

  it("holds the deepest duck while clips overlap", () => {
    /* THE CASE THE SECOND DEPTH CREATES. A coin clink during the Carcosa video must not raise the bed back
       over the video's dialogue for its half second -- so the level held is the MINIMUM asked for, not the
       most recent request, and it resets only once nothing is ducking at all. */
    expect(AUDIO).toContain("activeDuck = Math.min(activeDuck, depth);");
    /* Design note #1074: the resting floor is 1 -- "no duck" -- rather than the bed's level, for the same
       reason the depths became fractions: `activeDuck` is now a MULTIPLIER, and a multiplier at rest is 1. */
    expect(AUDIO).toContain("activeDuck = 1;");
  });

  it("reference-counts the hold", () => {
    /* THE REASON A BOOLEAN WOULD NOT DO. Two overlapping clips must duck once and restore once, and the
       first to finish must not raise the bed while the second is still sounding. */
    expect(AUDIO).toContain("duckDepth += 1;");
    expect(AUDIO).toContain("duckDepth = Math.max(0, duckDepth - 1);");
    expect(AUDIO).toContain("if (duckDepth > 0) return;");
  });

  it("makes the release idempotent", () => {
    /* A RELEASE CAN ARRIVE TWICE -- once from `ended` and once from the safety timer -- and a second
       decrement would take the count negative and leave the radio quiet for the rest of the session. */
    expect(AUDIO).toContain("if (released) return;");
  });

  it("ducks for the whistle as well as the variant clips", () => {
    // Ruled: "ANY variant sound effect or turn-based train whistle".
    expect(AUDIO.split("duckRadio()").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("bounds overlapping triggers rather than debouncing them", () => {
    /* RULED as "a debounce or concurrency limit", and the choice matters: a debounce DROPS the second event,
       and these clips are the game telling a player what happened. A limit keeps the first three. */
    expect(AUDIO).toContain("export const MAX_CONCURRENT_SFX = 3;");
    expect(AUDIO).toContain("if (liveSfx >= MAX_CONCURRENT_SFX) return;");
  });

  it("honours the SFX mute at the one place every caller goes through", () => {
    expect(AUDIO).toContain("export function playVariantCue(file: string, enabled: boolean): void {\n  if (!enabled) return;");
    /* Design note #1075: the second argument gained the per-category switch (`&& sfxRevenueRef.current`).
       The claim here is that the MASTER mute is still asked at the call site -- the engine takes one boolean
       and every caller composes it -- so the fragment stops before whatever else has been ANDed on. */
    expect(APP).toContain("playVariantCue(cue.audio, sfxEnabledRef.current");
  });

  it("survives an engine with no media stack", () => {
    /* jsdom HAS NO `Audio` CONSTRUCTOR worth the name (#1009), and this module is imported by the shell --
       so a throw here would take the render with it, not merely lose a sound.
       ==================================================================
        #490a AGAIN: A COMMENT CANNOT BE AN ANCHOR
       ==================================================================
       MY FIRST VERSION MATCHED THE COMMENT INSIDE THE CATCH, and `readStripped` removes comments -- that is
       the whole reason it exists. The assertion could never have passed, and it is the third time this
       project has made exactly this mistake.
       RE-ANCHORED ON THE CODE THE COMMENT DESCRIBES: the element is declared before the `try` so the guarded
       construction can assign to it, which is the shape that would have to be undone to reintroduce the
       throw. Counted, because `playQuietly` above has a `catch` of its own and an unbounded match would be
       satisfied by that one. */
    expect(AUDIO).toContain("let element: HTMLAudioElement;");
    expect(AUDIO).toContain("element = new Audio(");
    expect(AUDIO.split("} catch {").length - 1).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* The overlay and the log tint                                       */
/* ------------------------------------------------------------------ */

describe("the haunting plays over a board you can still use", () => {
  it("is inert to the pointer", () => {
    /* THE RULED PROPERTY, and the one that turns a ten-second flourish into a lost turn if it is missing.
       Asserted on the container AND the video: a nested element can re-enable pointer events. */
    expect(OVERLAY.split('pointerEvents: "none"').length - 1).toBe(2);
  });

  it("blends its black away", () => {
    expect(OVERLAY).toContain('mixBlendMode: "screen"');
  });

  it("carries no audio of its own", () => {
    /* THE SOUND GOES THROUGH THE DUCKING PATH. A video element with its own track would play at full volume
       over the radio and bypass both the mute and the duck. */
    expect(OVERLAY).toContain("muted");
  });

  it("unmounts when nothing is haunting", () => {
    expect(OVERLAY).toContain("if (!src) return null;");
  });

  it("is cleared by its own timer", () => {
    expect(APP).toContain("}, cue.videoMs);");
  });
});

describe("the log says which way the die went", () => {
  it("tints bonuses one way and maluses the other", () => {
    /* ==================================================================
        DESIGN NOTE 1079 SUPERSEDED THE COLOURS AND THE SCOPE OF THE ITALIC
       ==================================================================
       IT READ "tints bonuses gold ... in italic" and counted TWO `fontStyle: "italic"` -- one per tone
       style. RULED since: green and red rather than gold and red, and "italics strictly to the flavor text
       string at the end of the line, leaving the mechanical revenue math in the standard font."
       SO THERE IS ONE ITALIC NOW, and it is not on either tone: it lives in `logFlavourText` and is applied
       to the flavour SENTENCE. Counting italics per tone style asserted the old shape rather than the claim,
       which is that the two directions are distinguishable and neither is the other.
       THE CLAIM IS ASSERTED WHERE IT CANNOT BE SATISFIED BY A COINCIDENCE: two styles exist, they carry
       different fills, and the italic exists somewhere other than inside them. */
    expect(TICKER).toContain("logToneBonus");
    expect(TICKER).toContain("logToneMalus");
    /* Design note #1095: the flavour style gained `fontWeight: 700` -- ruled, for legibility at small sizes.
       WHAT THIS CASE IS ABOUT IS UNCHANGED: the emphasis lives OUTSIDE the two tone styles, so a tint and an
       italic remain two separable things. Asserted as the property rather than the whole declaration. */
    expect(TICKER).toContain('logFlavourText: { fontStyle: "italic"');
    expect(TICKER.split('fontStyle: "italic"').length - 1).toBe(1);
  });

  it("leaves an ordinary day untinted", () => {
    /* `unchanged` IS THE BUCKET THAT SAYS NOTHING HAPPENED, and highlighting it would be the log emphasising
       the absence of news. */
    expect(APP).toContain('bucket === "unchanged" ? undefined : isBonusBucket(bucket) ? "bonus" : "malus"');
  });

  it("stamps the tone on the entry rather than deriving it at render", () => {
    /* #343's RULE. A renderer that re-read the CURRENT variant state would repaint every historic line the
       moment a later turn rolled differently. */
    expect(readStripped("utils/feed.ts")).toContain('tone?: "bonus" | "malus";');
    expect(readStripped("utils/feed.ts")).toContain("logTone: entry.tone,");
  });

  it("agrees with the sound about which direction a bucket is", () => {
    /* ==================================================================
        DESIGN NOTE 1081: THE TABLE WAS PINNED WHOLE, WHICH IS THE WRONG SHAPE
       ==================================================================
       IT ASSERTED ALL FIVE ENTRIES BY NAME, so silencing one broke a case about a different claim entirely.
       That is my own recurring failure written into a test: pinning a COMPLETE mapping means any change to
       any part of it fails, whether or not the change touches what the case is about.
       THE CLAIM IS AN AGREEMENT, not a table. `isBonusBucket` and `BUCKET_FALLBACK` are two consumers of one
       idea -- which direction a bucket points -- and what must not drift is that a bonus bucket sounds like
       good news and a malus bucket like bad. Asserted as "the two bonus buckets share a clip, the two malus
       buckets share a different one, and the two sets do not overlap", which is that claim exactly and says
       nothing about which files they are.
       `unchanged` IS NEITHER, AND NOW HAS NO SOUND (#1081). It is excluded here rather than given a third
       arm, because a bucket with no direction has no direction to agree about; its silence is asserted in
       `batch56`, where the change lives. */
    const bonusClips = new Set<string>();
    const malusClips = new Set<string>();
    for (const bucket of BUCKETS) {
      if (bucket === "unchanged") continue;
      const clip = BUCKET_FALLBACK[bucket];
      expect(clip).not.toBeNull();
      (isBonusBucket(bucket) ? bonusClips : malusClips).add(clip as string);
    }
    // One clip per direction, and the directions do not share it.
    expect(bonusClips.size).toBe(1);
    expect(malusClips.size).toBe(1);
    expect(Array.from(bonusClips)[0]).not.toBe(Array.from(malusClips)[0]);
    /* THE VACUITY GUARD. A `BUCKETS` list that had lost its malus entries would give two empty sets and
       every assertion above would be about nothing. */
    expect(BUCKETS.filter((bucket) => bucket !== "unchanged").length).toBe(4);
  });
});

describe("the table itself", () => {
  it("keeps every pattern case-insensitive", () => {
    /* THE SPEC WROTE EVERY PATTERN `/i`, and a dropped flag would silently stop matching any line that
       happens to capitalise the word -- which the sentence-initial ones all do. */
    for (const entry of SFX_KEYWORDS) expect(entry.pattern.flags).toContain("i");
  });

  it("tests the context-aware animals before the general keywords", () => {
    /* THE ORDERING THAT THE `/cat/` BUG WAS. A general keyword above a context-aware rule swallows it, and
       the sound that plays instead is plausible enough that nobody notices. */
    const files = SFX_KEYWORDS.map((entry) => entry.file);
    expect(files.indexOf("COW_CONTEXT")).toBeLessThan(files.indexOf("cat-meow.mp3"));
    expect(files.indexOf("HORSE_CONTEXT")).toBeLessThan(files.indexOf("cat-meow.mp3"));
  });
});
