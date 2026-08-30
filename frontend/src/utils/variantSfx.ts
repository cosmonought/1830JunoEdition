// frontend/src/utils/variantSfx.ts
//
// Which sound a flavour line earns.
//
// ==================================================================
//  DESIGN NOTE 1040: THE TABLE IS ANCHORED, BECAUSE SUBSTRINGS ARE NOT WORDS
// ==================================================================
//
// SUPPLIED as a list of `/keyword/i -> file.mp3` pairs, and the pairs are kept exactly as specified. What
// changed is the SHAPE of several patterns, because measured against the 595 lines they are meant to scan,
// the unanchored forms fire on the wrong ones:
//
//   /ice/     matched 25 lines and TWO of them are about ice. The rest are "service" (7), "office" (4),
//             "price" (3), "twice" (3), "choice" (2), "nice", "rice", and "pract-ice-d his violin" -- which
//             also stole the one line the violin sound exists for, since /ice/ is tested first.
//   /cat/     matched 13 lines and TWO are about a cat. The rest are "category", "catastrophic",
//             "scattered" -- and all four CATTLE lines, which the table separately routes to a cow. The
//             context-aware cow rule could never have fired.
//   /factory/ matched "satisfactory".
//   /fire/    matched "firebox", "firewood" and "fireman" -- an engine fault, a fuel shortage and a man,
//             none of them a fire.
//
// SO THOSE PATTERNS GAINED `\b`, and only those. The rest are left unanchored deliberately: "robbers",
// "wheels", "chickens", "ducks", "exploded", "hailstorm", "flooded", "photographer" and "time traveler" are
// all legitimately the word the pattern names, and anchoring them would lose real matches to win nothing.
// The rule applied is "anchor where the letters spell a DIFFERENT word", not "anchor everything".
//
// AND THE ORDER IS THE SPECIFICATION'S, with one deliberate exception: the two context-aware animals and the
// Yellow Sign are tested FIRST. They are the three rules that depend on more than the line -- a bucket, or a
// count of the log -- and a general keyword that swallowed one of them would be invisible, because the sound
// that plays instead is still a plausible sound. Everything after them is first-match-wins down the list.
//
// MEASURED, NOT ASSUMED: 139 of the 595 lines match a keyword, the rest take their bucket's fallback, and
// every sound in the table is reachable by at least one line. `batch46.test.ts` re-runs that census, so a
// future line that quietly steals another's sound shows up as a count moving.
// IT READ 141 UNTIL #1044. The two Yellow Sign lines were matched here by a `/yellow sign/` test; the stages
// are a state machine now and this module is told which one fired, so those two match nothing on an ordinary
// turn -- and `resolveFlavourLine` never lets them BE an ordinary turn.
//
// PURE. This module picks a filename; it never touches an `Audio` element. That is what lets the whole table
// be tested without a media stack, which jsdom does not have (#1009).

import type { FlavorBucket } from "./gameVariants";

/** Where the clips live. The videos sit beside them rather than in a folder of their own. */
export const SFX_DIR = "/audio";

/* ==================================================================
 *  DESIGN NOTE 1040: TWO FILES ON DISK ARE NOT NAMED WHAT THE SPEC CALLS THEM
 * ==================================================================
 *
 * `iec-crack.mp3` is a transposition of `ice-crack.mp3`, and `carcosa_awaits.mp3` uses an underscore where
 * the spec uses a hyphen. THE NAMES HERE ARE THE ONES ON DISK, because a missing audio file is the quietest
 * failure in this codebase -- `playQuietly` swallows the error by design (#1009), so a 404 is indistinguish-
 * able from a sound that simply is not very loud.
 * FLAGGED RATHER THAN SILENTLY BRIDGED. A loader that tried both spellings would work and would leave the
 * typo in place for the next person. `variantSfx.test.ts` asserts every filename here exists in
 * `public/audio`, so renaming the files and updating these two constants stays a two-line change that the
 * suite checks. */
export const ICE_CRACK_FILE = "iec-crack.mp3";
export const CARCOSA_AUDIO_FILE = "carcosa_awaits.mp3";

/** The Yellow Sign's two states -- audio and video together, because they fire as one event. */
export const YELLOW_SIGN_FIRST = {
  audio: "yellow_sign.mp3",
  video: "yellow-sign.mp4",
} as const;
export const YELLOW_SIGN_AGAIN = {
  audio: CARCOSA_AUDIO_FILE,
  video: "carcosa-awaits.mp4",
} as const;

/** Ruled: "a slow, lingering 10-second haunting over the UI". */
export const YELLOW_SIGN_DURATION_MS = 10000;

/** Bucket defaults, for the 454 lines no keyword claims. */
export const BUCKET_FALLBACK: Readonly<Record<FlavorBucket, string>> = {
  criticalMalus: "sad-trombone.mp3",
  minorMalus: "sad-trombone.mp3",
  unchanged: "coins-clinking.mp3",
  minorBonus: "cha-ching.mp3",
  criticalBonus: "cha-ching.mp3",
};

const BONUS_BUCKETS: ReadonlySet<string> = new Set(["minorBonus", "criticalBonus"]);

/** Whether this bucket is good news, for the two animals that sound different depending. */
export function isBonusBucket(bucket: FlavorBucket): boolean {
  return BONUS_BUCKETS.has(bucket);
}

/** The keyword table, in priority order. First match wins. */
export const SFX_KEYWORDS: ReadonlyArray<{ pattern: RegExp; file: string }> = [
  /* THE ANCHORED ONES CARRY A NOTE EACH, so a later edit that "simplifies" a `\b` away has to argue with the
     line it was measured against. */
  // "cattle" and "cows" only -- never "coward", and never eaten by /cat/ below.
  { pattern: /\bcattle\b|\bcows?\b/i, file: "COW_CONTEXT" },
  // Compounds are still horses: "racehorse" and "horseshoe" are deliberately included.
  { pattern: /\bhorses?\b|\bmules?\b|racehorse|horseshoe/i, file: "HORSE_CONTEXT" },
  { pattern: /\bsheep\b/i, file: "sheep.mp3" },
  { pattern: /\bchickens?\b|\broosters?\b/i, file: "chicken.mp3" },
  { pattern: /\bdogs?\b/i, file: "dog.mp3" },
  { pattern: /\belephants?\b|\bcircus\b/i, file: "elephant.mp3" },
  { pattern: /\bgeese\b|\bgoose\b|\bducks?\b/i, file: "quacks.mp3" },
  { pattern: /\bbees\b/i, file: "bees.mp3" },
  // #1040: "category", "catastrophic", "scattered", "cattle" -- all of them not a cat.
  { pattern: /\bcats?\b/i, file: "cat-meow.mp3" },
  { pattern: /\bparrots?\b/i, file: "parrot.mp3" },
  { pattern: /storm|flood|downpour|hail/i, file: "thunder.mp3" },
  { pattern: /landslide|tunnel|rockslide/i, file: "rockslide.mp3" },
  { pattern: /explod|explosion/i, file: "explosion.mp3" },
  { pattern: /boiler|steam/i, file: "steam_hiss.mp3" },
  { pattern: /coupling|\baxles?\b|\bwheels?\b/i, file: "metal_clunk.mp3" },
  { pattern: /broke down|defective/i, file: "engine_trouble.mp3" },
  { pattern: /fallen tree/i, file: "tree-branch.mp3" },
  { pattern: /derailed|collapsed|rolling down|burst open/i, file: "crash.mp3" },
  // #1040: the worst of them -- 23 of 25 matches were "service", "office", "price", "twice", "choice".
  { pattern: /\bice\b|\bicy\b/i, file: ICE_CRACK_FILE },
  // #1040: "firebox", "firewood" and "fireman" are not fires.
  { pattern: /\bfires?\b/i, file: "fire-alarm.mp3" },
  { pattern: /dynamite/i, file: "dynamite-fuse.mp3" },
  { pattern: /robber|bandit/i, file: "gunshots.mp3" },
  { pattern: /striking|\bmobs?\b/i, file: "angry-crowd.mp3" },
  {
    pattern: /dignitary|exhibition|\bfairs?\b|\bcrowds?\b|presidential|boxing match|gold vein/i,
    file: "applause.mp3",
  },
  { pattern: /orchestra|theatrical/i, file: "orchestra.mp3" },
  { pattern: /photograph/i, file: "camera-shutter.mp3" },
  { pattern: /newspaper vendor/i, file: "newsboy.mp3" },
  { pattern: /church/i, file: "church-bells.mp3" },
  { pattern: /military band|\bparades?\b/i, file: "marching-band.mp3" },
  { pattern: /violin/i, file: "violin.mp3" },
  { pattern: /auctioneer/i, file: "auctioneer.mp3" },
  { pattern: /telegraph/i, file: "telegraph.mp3" },
  {
    pattern: /demanded compensation|demanded that the railway|issued for yesterday/i,
    file: "male-sigh.mp3",
  },
  { pattern: /\bgusts?\b/i, file: "wind-gust.mp3" },
  { pattern: /pocket watch/i, file: "watch-wind.mp3" },
  { pattern: /\bchina\b/i, file: "glass-clink.mp3" },
  { pattern: /electrical|invention/i, file: "electricity.mp3" },
  { pattern: /\bbarrels?\b/i, file: "barrels.mp3" },
  // #1040: "satisfactory" is not a factory.
  { pattern: /\bfactor(?:y|ies)\b|\biron\b/i, file: "machinery.mp3" },
  { pattern: /time travel|future/i, file: "time-travel.mp3" },
  { pattern: /\bmoon\b/i, file: "ufo.mp3" },
  { pattern: /cthulhu|ancient power|beneath the earth/i, file: "spooky_gong.mp3" },
];

/** The Yellow Sign is tested before the table, because it needs the log rather than the line. */
export const YELLOW_SIGN_PATTERN = /yellow sign/i;

export interface VariantCue {
  /** The clip to play, relative to `SFX_DIR`. */
  audio: string;
  /** The clip to overlay, or `null` for every ordinary line. */
  video: string | null;
  /** How long the overlay stays up. `0` when there is none. */
  videoMs: number;
  /** ==================================================================
   *   DESIGN NOTE 1040: THE HAUNTING PLAYS ALONE
   *  ==================================================================
   *
   * RULED: "When either of the Yellow Sign videos trigger, the engine must completely suppress the standard
   * default visual UI animations (e.g. standard bonus/malus popups or flashes) for that specific submission.
   * The player should only see the 10000ms video overlay and the updated Activity Log styling."
   *
   * A FIELD RATHER THAN `video !== null`, which is the same answer today and is the wrong thing to ask. The
   * caller's question is "may I run my usual flash", and answering it by inspecting an unrelated field means
   * that the day a second video-less cue wants the same suppression -- or a video arrives that should NOT
   * suppress -- the rule has to be discovered rather than read. #732: one field, one question.
   *
   * THE LOG STYLING IS EXPLICITLY EXEMPT, per the ruling: the flavour line still gets its tint. What is
   * suppressed is the transient visual, not the record. */
  suppressStandardVisuals: boolean;
}

/** What a flavour line should sound like.
 *
 *  ==================================================================
 *   DESIGN NOTE 1040: THE COUNT COMES IN, IT IS NOT COUNTED HERE
 *  ==================================================================
 *
 * RULED for the Yellow Sign: "check total occurrences of this string in the action log. 1st occurrence ...
 * 2nd+ occurrence ...". The count is a fact about the REPLAYED LOG, which this module has no business
 * reading -- and taking it as an argument is what lets both branches be tested without one.
 *
 * `priorYellowSigns` IS THE COUNT BEFORE THIS LINE, so zero means this is the first. Expressed that way
 * rather than as a 1-based ordinal because the caller derives it by filtering a list, and "how many are
 * already there" is what a filter answers.
 *
 * THE ORDER OF THE THREE SPECIAL CASES is Yellow Sign, then the two context animals, then the table. Each
 * earlier one needs something the later ones do not, and a general keyword that swallowed a special case
 * would be invisible in play: the sound that plays instead is still a plausible sound for that line. */
export function variantCueFor(input: {
  line: string;
  bucket: FlavorBucket;
  /** ==================================================================
   *   DESIGN NOTE 1044: THE STAGE IS DECIDED ELSEWHERE AND HANDED IN
   *  ==================================================================
   *
   * WAS `priorYellowSigns: number`, and #1040 counted sightings to pick between the two clips. That was the
   * right shape for the rule as it stood then -- first sighting, then every one after.
   * THE RULE IS NOW A STATE MACHINE with a marked corporation, a pool the lines leave, and a seeded tenth,
   * and none of that is answerable from the line in front of you. `yellowSign.ts` owns it; this module is
   * told which stage fired and picks the media. Deriving it here from a count would be a second
   * implementation of a rule that has already grown subtle once.
   * `null` IS THE ORDINARY TURN, which is almost all of them. */
  stage?: "mark" | "carcosa" | null;
}): VariantCue {
  const { line, bucket, stage = null } = input;

  if (stage !== null) {
    const clip = stage === "carcosa" ? YELLOW_SIGN_AGAIN : YELLOW_SIGN_FIRST;
    return {
      audio: clip.audio,
      video: clip.video,
      videoMs: YELLOW_SIGN_DURATION_MS,
      suppressStandardVisuals: true,
    };
  }

  for (const entry of SFX_KEYWORDS) {
    if (!entry.pattern.test(line)) continue;
    if (entry.file === "COW_CONTEXT") {
      return plain(isBonusBucket(bucket) ? "cow-happy.mp3" : "cow-sad.mp3");
    }
    if (entry.file === "HORSE_CONTEXT") {
      return plain(isBonusBucket(bucket) ? "horse-happy.mp3" : "horse-sad.mp3");
    }
    return plain(entry.file);
  }

  return plain(BUCKET_FALLBACK[bucket]);
}

function plain(audio: string): VariantCue {
  return { audio, video: null, videoMs: 0, suppressStandardVisuals: false };
}

/** Every file this module can ask for, for the case that checks they exist. */
export function everySfxFile(): readonly string[] {
  const files = new Set<string>();
  for (const entry of SFX_KEYWORDS) {
    if (entry.file === "COW_CONTEXT" || entry.file === "HORSE_CONTEXT") continue;
    files.add(entry.file);
  }
  for (const animal of ["cow-happy.mp3", "cow-sad.mp3", "horse-happy.mp3", "horse-sad.mp3"]) {
    files.add(animal);
  }
  for (const fallback of Object.values(BUCKET_FALLBACK)) files.add(fallback);
  files.add(YELLOW_SIGN_FIRST.audio);
  files.add(YELLOW_SIGN_FIRST.video);
  files.add(YELLOW_SIGN_AGAIN.audio);
  files.add(YELLOW_SIGN_AGAIN.video);
  // ES5 target with no `downlevelIteration`: spreading a Set does not compile here.
  return Array.from(files).sort();
}
