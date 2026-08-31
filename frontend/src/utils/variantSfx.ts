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

/** The third stage's cue. Design note #1092: reached only through `stage === "fog"`, never through the
 *  keyword table -- see `variantCueFor` for why the event and not the sentence is what rings it. */
export const CARCOSA_FOG_AUDIO = "carcosan-train.mp3";

/** ==================================================================
 *   DESIGN NOTE 1093: THE THIRD CLIP, AND WHY IT CANNOT USE `screen`
 *  ==================================================================
 *
 * RULED: the fog gets "a separate video instead of the usual bonus/malus animation", like the other two.
 *
 * IT IS THE OPPOSITE POLARITY OF THE OTHER TWO AND THAT IS THE WHOLE ENGINEERING PROBLEM. `yellow-sign.mp4`
 * and `carcosa-awaits.mp4` are bright figures drawn on BLACK, which is what makes `mix-blend-mode: screen`
 * work: screen maps black to transparent and the sign floats over the board (#1043 called this the ruled
 * property). This clip is a gold train receding into bright fog -- mean luma runs 134 to 160 across its six
 * seconds, measured rather than guessed. Under `screen` the fog is the part that SURVIVES, so the board
 * disappears behind a near-white slab and the train, the one dark thing in frame, is the part that is lost.
 * SO THE COMPOSITE IS A PROPERTY OF THE CLIP, not of the overlay -- see `videoComposite`. */
export const CARCOSA_FOG_VIDEO = "carcosan-train.mp4";

/** The clip's own length, to the millisecond the container declares.
 *
 *  ==================================================================
 *   DESIGN NOTE 1093: THE WINDOW IS THE CLIP, EXACTLY
 *  ==================================================================
 *
 * NOT `YELLOW_SIGN_DURATION_MS`. Ten seconds was reasoned about for the hauntings -- "a slow, lingering
 * 10-second haunting" -- and holding a six-second clip for ten would leave four seconds of a frozen final
 * frame, which reads as a stall rather than as an ending.
 * 6042 IS READ OFF THE FILE, not chosen. It was 6100 for one draft, on the reasoning that a little slack
 * would avoid clipping the tail -- and 58ms of slack is 58ms of still frame, which is the stall in miniature.
 * `batch60` #1093 parses the MP4's `mvhd` box and fails if this drifts from the clip by so much as a frame,
 * so the constant cannot quietly stop describing the file it is about.
 * THE FADE-OUT LANDS ON THE SAME MILLISECOND, because the overlay drives its animation from this number. */
export const CARCOSA_FOG_DURATION_MS = 6042;

/** Bucket defaults, for the 454 lines no keyword claims.
 *
 *  ==================================================================
 *   DESIGN NOTE 1081: NOTHING HAPPENED, SO NOTHING SOUNDS
 *  ==================================================================
 *
 *  RULED: "Completely remove the audio trigger from the Unpredictable Revenue variant's Unchanged (0%) state
 *  ... Rolling a 0% modifier should only trigger the visual white flash and the `+0%` text indicator."
 *  And, narrowing it: "ONLY remove coins-clinking from the Unchanged revenue events. Some of the Unchanged
 *  events have more 'unique' flavor text with sound effects that can still play."
 *
 *  SO IT IS THE FALLBACK THAT GOES, NOT THE BUCKET. `variantCueFor` tries the keyword table BEFORE reaching
 *  here, so an unchanged line about a cow still gets its cow -- what is silenced is the 454-line default, the
 *  case where the only thing the game has to say is "nothing happened". #1042 already ruled that bucket earns
 *  no tint for the same reason; this is the same argument about the same third of the die.
 *
 *  `null` RATHER THAN A SILENT FILE. A `silence.mp3` would satisfy every existing signature and would leave
 *  a caller ducking the radio, holding a concurrency slot and waiting fifteen seconds for an `ended` that a
 *  zero-length clip may never fire. Absence has to be representable, so it is. */
export const BUCKET_FALLBACK: Readonly<Record<FlavorBucket, string | null>> = {
  criticalMalus: "sad-trombone.mp3",
  minorMalus: "sad-trombone.mp3",
  unchanged: null,
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
  /* ==================================================================
      DESIGN NOTE 1087: FOUR NEW SCENES, PLACED BY HOW SPECIFIC THEY ARE
     ==================================================================
     456 of the 595 lines took their bucket's fallback, which is the intended shape (#1040) -- but four
     coherent SCENES were hiding in that remainder, each with one unmistakable noise and no neighbour in the
     pack: a ledger closing (20 lines), a shovel into a firebox (9), a trestle giving way (10), and a pickaxe
     on rock (7).

     PLACEMENT IS THE WHOLE DESIGN HERE, because "first match wins" makes this table an ordering rather than a
     set. The four split into two groups and they go at opposite ends:

       THE HEAD, here: `pickaxe` and `trestle` match COMPOUND phrases -- "gold strike", "trestle" -- that are
       more specific than the generic clips they would otherwise lose to. A dry run proved the point: without
       this placement, "a distant gold discovery sent a FLOOD of prospectors" took `thunder` and "prospectors
       RUSHING toward the terminus" took `applause`. Both were matching a metaphor rather than the event.

       THE TAIL, at the bottom: `shovel` and `ledger` match SINGLE COMMON WORDS -- "coal", "accountants" --
       and must lose to everything above them. The same dry run showed why: at the head they stole "a
       mysterious FIRE destroyed the company's records before the ACCOUNTANTS could finish" from `fire-alarm`,
       and "a circus troupe paid handsomely to transport an elephant, three lions, and one very nervous
       ACCOUNTANT" from `elephant`. Both times the incidental noun beat the actual event.

     THE DRY RUN IS THE METHOD WORTH KEEPING. Adding an entry to this table can silently RE-ASSIGN a line that
     already had a good sound, and nothing in the diff shows it -- so the change was made by computing every
     line's cue before and after and reading the 11 that moved, one at a time. Five were improvements and six
     were regressions; the placement above is what turned 6 into 0. `batch58` pins the five that moved. */
  { pattern: /\b(gold|silver)\s+(strike|rush|vein|discovery)\b|\bprospectors?\b|\bgold shipment\b/i, file: "pickaxe.mp3" },
  { pattern: /\b(bridges?|trestles?|viaducts?)\b/i, file: "trestle.mp3" },
  /* ==================================================================
      DESIGN NOTE 1103: THE BLIZZARD, AND THE FOUR WORDS THAT ARE NOT ONE
     ==================================================================
     ADDED: "blizzard.mp3 ... it is perhaps not so specific to blizzards, it mostly sounds like heavy winds,
     so it could potentially work for storms."

     IT COVERS TWO LINES, WHICH IS THE HONEST ANSWER. The pool has 15 lines that mention weather; five already
     have a cue, and of the remaining ten only "a blizzard buried the mountain pass" and "a winter freeze
     burst several miles of track" are a wind you would actually hear.

     AT THE HEAD, WITH THE OTHER ANCHORED PATTERNS, because the alternative is losing "blizzard" to `thunder`
     -- computed, not assumed: a dry run over all 602 lines is what placed it, the method #1087 established.

     WHAT THIS PATTERN DELIBERATELY DOES NOT MATCH is the reason it is written out rather than as `/wind/i`:

       "a favorable WIND blew directly into the corporate coffers"     a metaphor for good fortune
       "a favorable WIND blew directly into the shareholders' pockets"  the same one again
       "the directors negotiated a WINDfall land grant"                 a metaphor inside a word
       "a cracked WINDow required a last-minute repair"                 a substring, not a word
       "a MILD WINTER kept the tracks perfectly clear of ice and snow"  the ABSENCE of weather

     THE LAST TWO ARE THE INSTRUCTIVE ONES. `window` is why `\b` is not enough on its own, and the mild
     winter would have played a howling gale over a line whose whole content is that the weather was fine --
     which is #1087's "matching a metaphor rather than the event", in its most embarrassing form.

     THE STORM LINES STAY ON `thunder.mp3`. Four of them are already claimed and playing something defensible;
     moving them to a wind bed is churn against no report, and thunder is the more specific noise for "a
     severe storm damaged signals". Offered back rather than decided alone: the two RAIN lines -- "rain-
     softened embankments" and "a rain leak spoiled a few sacks of grain" -- are the pair a rain clip would
     serve, and neither is served well by wind. */
  { pattern: /\bblizzards?\b|\bwinter freeze\b/i, file: "blizzard.mp3" },
  /* ==================================================================
      DESIGN NOTE 1105: `\b` IS DOING ALL THE WORK HERE
     ==================================================================
     ADDED to serve the lines a wind bed could not: #1103 found the pool's two rain lines while placing the
     blizzard and left them for a clip that now exists.

     `/rain/i` WOULD MATCH 72 OF THE 602 LINES AND MEAN ALMOST NONE OF THEM, because "t-r-a-i-n" contains
     "rain". Every "Train robbers relieved the company of 20% of its revenue" would have played a rainstorm.
     `\brain` requires a word boundary before the r, which "train" and "drain" do not have and
     "rain-softened" and "rainstorm" do -- so the same three characters mean weather here and rolling stock
     three words later. Measured, not assumed: 72 lines contain the letters, three contain the word.

     NO TRAILING `\b`, deliberately, or "rainstorm" would be missed -- the boundary this pattern needs is on
     the left only.

     AT THE HEAD, ABOVE `thunder`, WHICH MOVES ONE LINE ON PURPOSE. "A rainstorm discouraged some less
     determined travelers" has been playing thunder; rain is the more specific noise for a line whose subject
     is rain, and #1087's placement rule is that a compound match beats a generic one. The other three storm
     lines stay on thunder -- "a severe storm damaged signals" is not a rain line. */
  { pattern: /\brain/i, file: "rain.mp3" },
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
  /* Design note #1087: WAS `/newspaper vendor/i` -- the literal phrase -- while eight lines about newspapers
     went unclaimed. A newsboy crying headlines is how news travelled in 1830, so it serves "a newspaper
     printed an unfavorable rumor" as well as the vendor himself. */
  { pattern: /newspaper vendor|\bnewspapers?\b|\bnewsboy\b/i, file: "newsboy.mp3" },
  { pattern: /church/i, file: "church-bells.mp3" },
  // Design note #1087: a political convention and a grand opening are the same brass and crowd as a parade.
  { pattern: /military band|\bparades?\b|\bconventions?\b|\bgrand-opening\b/i, file: "marching-band.mp3" },
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
  // Design note #1087: an "industrial plant" and a "mill" are the factory this already means.
  { pattern: /\bfactor(?:y|ies)\b|\biron\b|\bindustrial (plant|concern)\b|\bmills?\b/i, file: "machinery.mp3" },
  { pattern: /time travel|future/i, file: "time-travel.mp3" },
  { pattern: /\bmoon\b/i, file: "ufo.mp3" },
  { pattern: /cthulhu|ancient power|beneath the earth/i, file: "spooky_gong.mp3" },
  /* ==================================================================
      DESIGN NOTE 1087: THE BROAD WORDS GO LAST, DELIBERATELY
     ==================================================================
     EVERYTHING BELOW THIS LINE MATCHES A COMMON NOUN rather than an event, so it must lose to every entry
     above it. "coal" appears in a line about dynamite loaded beside it, and "accountant" in a line about an
     elephant; in both the other clip is describing what HAPPENED and these are describing the furniture.
     KEEPING THEM AT ALL is still worth it -- they claim 29 lines between them that had nothing but their
     bucket's fallback, and the ledger is the single most repeated scene in the whole payload. */
  { pattern: /\bcoal\b|\bfirebox\b|\bstokers?\b/i, file: "shovel.mp3" },
  { pattern: /\bledgers?\b|\baccountants?\b|\bbookkeep|\bthe books\b|\bpaperwork\b|\baudit/i, file: "ledger.mp3" },
  /* Design note #1087: `livestock` is NOT added to the `cattle|cows` entry at the head of this table, and the
     difference is load-bearing: up there it would beat `crash` on "a rail spur collapsed under an overloaded
     livestock car", where the event is the collapse and the cargo is incidental. Down here it claims only the
     livestock lines nothing more specific wants. */
  { pattern: /\blivestock\b/i, file: "COW_CONTEXT" },
];

/** The Yellow Sign is tested before the table, because it needs the log rather than the line. */
export const YELLOW_SIGN_PATTERN = /yellow sign/i;

export interface VariantCue {
  /** The clip to play, relative to `SFX_DIR` -- or `null` when this line is meant to be silent (#1081). */
  audio: string | null;
  /** The clip to overlay, or `null` for every ordinary line. */
  video: string | null;
  /** How long the overlay stays up. `0` when there is none. */
  videoMs: number;
  /** ==================================================================
   *   DESIGN NOTE 1093: HOW THE CLIP SITS OVER THE BOARD
   *  ==================================================================
   *
   * `null` WHEN THERE IS NO VIDEO. Otherwise one of two treatments, and which one is a fact about how the
   * clip was SHOT rather than a preference:
   *
   *   "screen"   Bright figure on black. `mix-blend-mode: screen` drops the black and the figure floats.
   *              The two hauntings, unchanged from #1043.
   *   "feather"  Bright everywhere, so there is no black to drop. The rectangle's edges are dissolved with a
   *              radial mask and it fades in and out instead. The fog clip.
   *
   * A NAMED TREATMENT RATHER THAN A CSS STRING, so the overlay owns the implementation of each and the cue
   * owns only the choice. Passing `mixBlendMode: "screen"` through here would put a stylesheet in a module
   * whose whole point (#1040) is that it is pure and testable without a media stack. */
  videoComposite: "screen" | "feather" | null;
  /** ==================================================================
   *   DESIGN NOTE 1093: WHETHER THE BED HAS TO BE HELD DOWN FOR IT
   *  ==================================================================
   *
   * #1045 DUCKS THE RADIO DEEPLY FOR THE WHOLE CLIP, because the two hauntings carry their own audio track
   * outside `playVariantCue`'s ducking and would otherwise play over the bed at full volume.
   * THE FOG CLIP HAS NO AUDIO STREAM AT ALL -- checked with `ffprobe`, not assumed -- and its sound is
   * `CARCOSA_FOG_AUDIO`, which goes through `playVariantCue` and ducks itself for its own 2.6 seconds. A deep
   * six-second duck for a silent film would cut the music for nothing.
   * NAMED FOR THE FACT, NOT THE CONSEQUENCE. `videoDucksDeeply` would encode today's answer to a question
   * ("how deep") that the caller should keep asking for itself; "does this clip make noise" is the thing that
   * is true about the file. #732: one field, one question. */
  videoHasOwnAudio: boolean;
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
  stage?: "mark" | "carcosa" | "fog" | null;
}): VariantCue {
  const { line, bucket, stage = null } = input;

  /* ==================================================================
      DESIGN NOTE 1092: THE THIRD STAGE HAS A SOUND AND NO VIDEO
     ==================================================================
     RULED: "This audio should play if and only if the Carcosan train disappears into the fog."
     IF AND ONLY IF IS THE WHOLE SPECIFICATION, and it is why this branch is keyed on the STAGE rather than on
     the line. The fog clause is a string like any other and a keyword rule could be made to match it -- but
     then a flavour line that happened to mention fog would ring it too, and the sound would stop meaning
     "the train is gone". The stage is the event; the line is only how the event reads.
     ==================================================================
      DESIGN NOTE 1093: IT GETS A VIDEO AFTER ALL, AND THE FLASH GOES
     ==================================================================
     #1092 GAVE THIS STAGE A SOUND AND NO VIDEO, and argued the flash should still run because "the roll is a
     real roll" and the flash is how the player reads it. RULED SINCE: "a separate video instead of the usual
     bonus/malus animation", which is #1040's rule extended to the third stage.
     AND THE ARGUMENT I MADE WAS WRONG ON ITS OWN TERMS. The figure is not carried by the flash: the Activity
     Log prints "B&O ran for $180. It suffered a 10% malus." -- `turnRevenueSentence` #949 -- and the log
     styling is explicitly exempt from the suppression. Nothing is lost by taking the flash away except the
     flash, which is the animation the ruling replaces.
     SO THE ROLL IS STILL A REAL ROLL; only its transient visual changes. `suppressStandardVisuals: true` and
     the clause, the tint and the figures all stay exactly as they were. */
  if (stage === "fog") {
    return {
      audio: CARCOSA_FOG_AUDIO,
      video: CARCOSA_FOG_VIDEO,
      videoMs: CARCOSA_FOG_DURATION_MS,
      videoComposite: "feather",
      /* The file has no audio stream; `CARCOSA_FOG_AUDIO` is its whole soundtrack and ducks itself. */
      videoHasOwnAudio: false,
      suppressStandardVisuals: true,
    };
  }

  if (stage !== null) {
    const clip = stage === "carcosa" ? YELLOW_SIGN_AGAIN : YELLOW_SIGN_FIRST;
    return {
      audio: clip.audio,
      video: clip.video,
      videoMs: YELLOW_SIGN_DURATION_MS,
      /* Design note #1093: BOTH ARE BRIGHT-ON-BLACK, which is what #1043's blend mode needs, and both carry
         their own audio, which is what #1045's deep duck exists for. Stated rather than defaulted. */
      videoComposite: "screen",
      videoHasOwnAudio: true,
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

function plain(audio: string | null): VariantCue {
  return {
    audio,
    video: null,
    videoMs: 0,
    videoComposite: null,
    videoHasOwnAudio: false,
    suppressStandardVisuals: false,
  };
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
  /* Design note #1081: the unchanged bucket's default is `null` now, and a `null` in this set would be
     handed to the case that checks every name exists on disk. Skipped rather than filtered downstream, so
     the set stays "files this module can ask for" and silence is not one. */
  for (const fallback of Object.values(BUCKET_FALLBACK)) {
    if (fallback !== null) files.add(fallback);
  }
  files.add(YELLOW_SIGN_FIRST.audio);
  files.add(YELLOW_SIGN_FIRST.video);
  files.add(YELLOW_SIGN_AGAIN.audio);
  files.add(YELLOW_SIGN_AGAIN.video);
  /* Design note #1092: listed so the on-disk check covers it. It is UNREACHABLE from the keyword table by
     design, which is why `batch46`'s unreachability case excludes the sign's clips by name -- the same
     exemption, for the same reason, now covering three files instead of two. */
  files.add(CARCOSA_FOG_AUDIO);
  // Design note #1093: and its video, which is the fourth file the sign can ask for and the third clip.
  files.add(CARCOSA_FOG_VIDEO);
  // ES5 target with no `downlevelIteration`: spreading a Set does not compile here.
  return Array.from(files).sort();
}
