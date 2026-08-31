/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1089-1091 (harness): THE DOOM CLOCK, THE BLOOD PRICE, AND THE CURSE
// ==================================================================
//
// THREE MECHANISMS, AND THE ONE THAT NEEDED THINKING ABOUT WAS THE STATE. The ruling asks for a train that
// rusts an OR set after its trigger, a transfer that costs the seller a market move, and a corporation that
// stays marked after the train is gone -- and those are three different lifetimes:
//
//   `ghost_trains`                    limit exemption, gone at the end of the OPERATING ROUND (#1046)
//   `carcosan_trains`                 the gold trim, gone when the DOOM CLOCK fires, an OR SET later
//   `is_carcosan`                     the curse, gone only on a TRANSFER, and never on a rust
//
// REUSING ONE FIELD FOR TWO OF THOSE IS THE BUG THIS FILE EXISTS TO PREVENT, and it was the first draft: the
// chip's Yellow Sign (#1088) was drawn from `ghost_trains`, so the train would have lost its icon one round
// after the gift while still being the cursed train. Invisible in the OR it arrives; wrong in the next one.
//
// MOST OF THIS FILE IS THE REDUCER, exercised against real states rather than read as source. The timing rules
// are arithmetic on `macro_round_number` and the only way to know they are right is to run them.

export {};

const {
  applyPhaseChange,
  settleTrainSale,
  isCarcosanTransfer,
  applySandboxMarketAction,
  applySandboxAction,
} = require("./sandboxSession") as typeof import("./sandboxSession");
const { fogIsDue, resolveFlavourLine, CARCOSA_FOG_LINE: FOG_LINE } =
  require("./yellowSign") as typeof import("./yellowSign");
const {
  CARCOSA_FOG_AUDIO,
  CARCOSA_FOG_VIDEO,
  CARCOSA_FOG_DURATION_MS,
  YELLOW_SIGN_DURATION_MS,
  variantCueFor,
  everySfxFile,
} = require("./variantSfx") as typeof import("./variantSfx");
const {
  carcosaStanding,
  showsCurseBesideName,
  cursedCompanies,
  carcosaEpitaph,
  CARCOSA_FOG_LINE,
  CARCOSA_STAMP_STEP,
} = require("./carcosaCurse") as typeof import("./carcosaCurse");
const { readStripped, sliceBetween, anchorIndex } =
  require("./sourceScan") as typeof import("./sourceScan");
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const APP = readStripped("App.tsx");
const SESSION = readStripped("utils/sandboxSession.ts");
const YELLOW = readStripped("utils/yellowSign.ts");
const MARKET = readStripped("components/StockMarketRenderer.tsx");
const PANEL = readStripped("components/TrainPurchasePanel.tsx");
const MODAL = readStripped("components/GameOverModal.tsx");
const OVERLAY = readStripped("components/YellowSignOverlay.tsx");

/* Design note #1093: the media helpers, reading the files rather than trusting a constant about them. */
const mediaPath = (name: string): string => {
  const path = require("path") as typeof import("path");
  return path.join(__dirname, "..", "..", "public", "audio", name);
};
const mediaExists = (name: string): boolean =>
  (require("fs") as typeof import("fs")).existsSync(mediaPath(name));
/** The MP4 movie header's declared length, in ms. Version-0 `mvhd`: timescale at +16, duration at +20. */
const mp4DurationMs = (name: string): number => {
  const buf = (require("fs") as typeof import("fs")).readFileSync(mediaPath(name));
  const at = buf.indexOf("mvhd");
  if (at < 0 || buf[at + 4] !== 0) return 0;
  const timescale = buf.readUInt32BE(at + 16);
  return timescale === 0 ? 0 : Math.round((buf.readUInt32BE(at + 20) / timescale) * 1000);
};
/** Whether the container declares an audio handler. */
const hasAudioTrack = (name: string): boolean =>
  (require("fs") as typeof import("fs")).readFileSync(mediaPath(name)).indexOf("soun") !== -1;

const CO = 3;
const RIVAL = 4;

const company = (over: Partial<PublicCompanyState> = {}): PublicCompanyState =>
  ({
    company_id: CO,
    ticker: "B&O",
    president: "p1",
    treasury: "500",
    owned_trains: ["5"],
    player_holdings: [],
    ...over,
  }) as PublicCompanyState;

const board = (
  companies: PublicCompanyState[],
  macroRound = 4,
): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: macroRound,
    sub_round_index: 1,
    player_addresses: ["p1", "p2"],
    active_player_index: 0,
    public_companies: companies,
    private_companies: [],
  }) as unknown as GameStateResponse;

/* ------------------------------------------------------------------ */
/* #1089 -- the doom clock                                            */
/* ------------------------------------------------------------------ */

describe("the clock starts on the trigger and not before", () => {
  it("leaves a gifted 5 alone until the Diesel arrives", () => {
    /* THE WHOLE REASON THE GIFT IS A CURSE. In this codebase a 5, a 6 and a Diesel are PERMANENT --
       `gamePhase.ts` says so in as many words, and `RUSTS_WHEN_NEXT_TIER_ARRIVES` has only three entries. An
       ordinary 5 outlives every phase; this one does not, but not yet. */
    const state = board([company({ carcosan_trains: ["5"], is_carcosan: true })]);
    const after = applyPhaseChange(state, "6");
    expect(after.public_companies[0].carcosan_doom_after_macro_round).toBeUndefined();
    expect(after.public_companies[0].carcosan_trains).toEqual(["5"]);
  });

  it("starts it when the first Diesel is bought", () => {
    const state = board([company({ carcosan_trains: ["5"], is_carcosan: true })], 4);
    const after = applyPhaseChange(state, "D");
    // Triggered during set 4, gone at the conclusion of set 5. `+ 1` is the whole rule.
    expect(after.public_companies[0].carcosan_doom_after_macro_round).toBe(5);
  });

  it("does not restart a clock that is already running", () => {
    /* IDEMPOTENCE IS LOAD-BEARING. A second Diesel purchase re-enters `applyPhaseChange`, and a deadline
       pushed back each time would make the gift immortal by being popular -- the opposite of a curse. */
    const started = applyPhaseChange(
      board([company({ carcosan_trains: ["5"], is_carcosan: true })], 4),
      "D",
    );
    const again = applyPhaseChange({ ...started, macro_round_number: 9 }, "D");
    expect(again.public_companies[0].carcosan_doom_after_macro_round).toBe(5);
  });

  it("starts a gifted Diesel's clock at the gift instead", () => {
    /* RULED: "A Carcosan D-train begins this countdown the moment it is gifted ... completes the OR set in
       which it is gifted, and then the next OR set before disappearing into the fog." Same `+ 1`, different
       trigger -- there is no later Diesel purchase to wait for when the gift IS the Diesel. */
    const gift = sliceBetween(SESSION, 'if (stage === "mark") {', "if (\"RunMultipleRoutes\" in msg)");
    expect(gift).toContain('trainTier(model) === "D"');
    expect(gift).toContain("carcosan_doom_after_macro_round: (state.macro_round_number ?? 0) + 1");
  });
});

describe("the fog falls due at the conclusion of that OR set", () => {
  const doomed = (macroRound: number) =>
    board(
      [company({ owned_trains: ["4", "5"], carcosan_trains: ["5"], is_carcosan: true, carcosan_doom_after_macro_round: 5 })],
      macroRound,
    );

  it("is not owed while the set it names is still running", () => {
    /* RULED: the train "will survive until the exact conclusion of the next full set of Operating Rounds".
       `>` RATHER THAN `>=` IS THE WHOLE OF THAT: `macro_round_number` increments as the Stock Round opens, so
       only once it has PASSED the deadline is the named set genuinely over. */
    expect(fogIsDue(doomed(4).public_companies[0], 4)).toBe(false);
    expect(fogIsDue(doomed(5).public_companies[0], 5)).toBe(false);
  });

  it("is owed once that set has finished", () => {
    expect(fogIsDue(doomed(6).public_companies[0], 6)).toBe(true);
  });

  it("is owed by nobody who is not holding the train", () => {
    /* A CORPORATION THAT SOLD IT PAID THE BLOOD PRICE AND OWES NOTHING -- and one that never had a clock is
       not owed either, which is every corporation in an ordinary game. */
    expect(fogIsDue(company({ carcosan_trains: [], carcosan_doom_after_macro_round: 5 }), 9)).toBe(false);
    expect(fogIsDue(company({ carcosan_trains: ["5"] }), 9)).toBe(false);
    expect(fogIsDue(company(), 9)).toBe(false);
    expect(fogIsDue(null, 9)).toBe(false);
  });
});

describe("the fog is the third step of the revenue sequence", () => {
  const seed = { macroRound: 1, subRound: 1, companyId: CO, turnSeed: 7 };
  const resolveWith = (fogDue: boolean, bucket: "criticalBonus" | "minorMalus" = "minorMalus") =>
    resolveFlavourLine({
      naturalLine: "The mail arrived on time.",
      bucket,
      ticker: "B&O",
      parts: seed,
      state: { markedTicker: "B&O", carcosaSeen: true },
      phaseTier: "6",
      owned: ["5"],
      fogDue,
    });

  it("replaces the drawn clause when the debt is due", () => {
    expect(resolveWith(true).stage).toBe("fog");
    expect(resolveWith(true).line).toBe(FOG_LINE);
    expect(FOG_LINE).toBe("The gold-trimmed train disappeared back into the fog.");
  });

  it("changes nothing when it is not", () => {
    /* THE CONTROL, and the one that matters: every ordinary turn in every game reaches this call. */
    expect(resolveWith(false).stage).toBeNull();
    expect(resolveWith(false).line).toBe("The mail arrived on time.");
  });

  it("outranks the escalation rather than queueing behind it", () => {
    /* THE OTHER TWO STAGES ARE LOTTERY TICKETS -- the Mark needs its own line drawn, Carcosa needs a critical
       bonus and a 1-in-5 roll -- and either could be asked on the turn the fog is due. A debt that has come
       due does not wait for a better draw. Asserted on a `criticalBonus`, which is the bucket the escalation
       wants. */
    expect(resolveWith(true, "criticalBonus").stage).toBe("fog");
  });

  it("leaves the roll entirely alone", () => {
    /* RULED, REVISING THE FIRST DRAFT: the first spec forced a 0% on this run; the revision was "you can
       actually give them whatever bonus/malus they roll -- it doesn't have to be 0%." So the stage
       substitutes the CLAUSE and nothing else.
       ASSERTED STRUCTURALLY, because there is no number to compare: the resolution has no channel through
       which it COULD move the swing. `FlavourResolution` carries a line and a stage, the bucket is settled
       before this is called, and the composer that turns a roll into a sentence has never heard of the fog.
       The third assertion is the one with teeth -- `gameVariants.ts` is where a forced zero would have to be
       written, and it is not written there. */
    const shape = sliceBetween(YELLOW, "export interface FlavourResolution", "}");
    expect(shape).toContain("line: string;");
    expect(shape).toContain('"fog"');
    expect(shape).not.toContain("bucket");
    /* NAMES THE FIELDS IT NEEDS RATHER THAN PINNING THE WHOLE SHAPE, and bounds the region instead -- a
       complete-shape assertion breaks the next time anything is added, which is the mistake this suite has
       made more than any other. */
    expect(shape.length).toBeLessThan(200);
    expect(readStripped("utils/gameVariants.ts")).not.toContain("fog");
  });
});

describe("the sound rings for the fog and for nothing else", () => {
  it("is keyed on the stage, never on the sentence", () => {
    /* RULED: "This audio should play IF AND ONLY IF the Carcosan train disappears into the fog."
       KEYED ON THE EVENT because the clause is a string like any other -- a keyword rule could be made to
       match it, and then a flavour line that happened to mention fog would ring it too, and the sound would
       stop meaning "the train is gone". */
    const cue = variantCueFor({ line: "anything at all", bucket: "minorMalus", stage: "fog" });
    expect(cue.audio).toBe(CARCOSA_FOG_AUDIO);
    expect(CARCOSA_FOG_AUDIO).toBe("carcosan-train.mp3");
    // And the clause itself, dispatched with no stage, rings nothing of the sort.
    expect(variantCueFor({ line: FOG_LINE, bucket: "minorMalus" }).audio).not.toBe(CARCOSA_FOG_AUDIO);
  });

  it("brings a video, and the flash gives way to it", () => {
    /* #1092 GAVE THIS STAGE NO VIDEO and argued the flash should still run, because "the roll is a real roll"
       and the flash is how a player reads it. RULED SINCE: "a separate video instead of the usual bonus/malus
       animation" -- #1040's rule, extended to the third stage.
       AND THE ARGUMENT WAS WRONG ON ITS OWN TERMS, which is why this case is worth the words: the figure is
       not carried by the flash. `turnRevenueSentence` #949 prints "It suffered a 10% malus" into the Activity
       Log, and #1040's ruling exempts the log styling from the suppression by name. Nothing is lost but the
       animation the ruling replaces. */
    const cue = variantCueFor({ line: FOG_LINE, bucket: "criticalBonus", stage: "fog" });
    expect(cue.video).toBe(CARCOSA_FOG_VIDEO);
    expect(cue.videoMs).toBe(CARCOSA_FOG_DURATION_MS);
    expect(cue.suppressStandardVisuals).toBe(true);
  });

  it("names clips that are on disk", () => {
    expect(mediaExists(CARCOSA_FOG_AUDIO)).toBe(true);
    expect(mediaExists(CARCOSA_FOG_VIDEO)).toBe(true);
    /* AND BOTH ARE IN THE SET the on-disk case walks, so a rename breaks a named test rather than going
       quiet -- neither is reachable from the keyword table, so nothing else would ever ask for them. */
    expect(everySfxFile()).toContain(CARCOSA_FOG_AUDIO);
    expect(everySfxFile()).toContain(CARCOSA_FOG_VIDEO);
  });
});

/* ------------------------------------------------------------------ */
/* #1093: THE THIRD CLIP, AND THE COMPOSITE IT CANNOT SHARE            */
/* ------------------------------------------------------------------ */

describe("the fog clip is composited differently because it was shot differently", () => {
  const fog = variantCueFor({ line: FOG_LINE, bucket: "minorMalus", stage: "fog" });
  const mark = variantCueFor({ line: "anything", bucket: "criticalMalus", stage: "mark" });
  const carcosa = variantCueFor({ line: "anything", bucket: "criticalBonus", stage: "carcosa" });

  it("feathers the fog and screens the other two", () => {
    /* THE REASON IS OPTICAL AND IT IS MEASURABLE. `mix-blend-mode: screen` is a keying technique, not a
       style: it keeps bright pixels and drops black ones, so it works on the two hauntings, which are bright
       figures on black. The fog clip is bright EVERYWHERE -- mean luma 134 to 160 across its six seconds --
       so screen would keep the fog, cover the board with it, and drop the train, which is the darkest thing
       in frame and the entire subject. The clip would erase the picture it was added to show. */
    expect(fog.videoComposite).toBe("feather");
    expect(mark.videoComposite).toBe("screen");
    expect(carcosa.videoComposite).toBe("screen");
  });

  it("leaves an ordinary line with no video and no composite", () => {
    /* THE CONTROL, and the one every turn in every game takes. */
    const plain = variantCueFor({ line: "The mail arrived on time.", bucket: "minorBonus" });
    expect(plain.video).toBeNull();
    expect(plain.videoComposite).toBeNull();
    expect(plain.videoHasOwnAudio).toBe(false);
  });

  it("keeps its own window rather than borrowing the hauntings'", () => {
    /* TEN SECONDS WAS REASONED ABOUT for the hauntings -- "a slow, lingering 10-second haunting" -- and this
       clip is six. Holding it for ten would leave four seconds of a frozen final frame, which reads as a
       stall rather than an ending. */
    expect(fog.videoMs).toBe(CARCOSA_FOG_DURATION_MS);
    expect(mark.videoMs).toBe(YELLOW_SIGN_DURATION_MS);
    expect(CARCOSA_FOG_DURATION_MS).toBeLessThan(YELLOW_SIGN_DURATION_MS);
  });

  it("keeps the constant honest against the file itself", () => {
    /* ==================================================================
        THE PROXY THAT COULD STOP STANDING FOR ITS SUBJECT
       ==================================================================
       `CARCOSA_FOG_DURATION_MS` IS A CLAIM ABOUT A FILE, and the failure mode is silent: swap the clip for a
       longer cut and the overlay unmounts partway through it, or a shorter one and the board holds a frozen
       frame. Neither throws, and neither shows up in a source scan.
       SO THE CLAIM IS CHECKED AGAINST THE FILE. `mvhd` is the movie header box every MP4 carries; its
       version-0 layout puts a 4-byte timescale at +16 from the fourcc and a 4-byte duration at +20, so the
       clip's real length is arithmetic on eight bytes and needs no media stack -- which matters, because this
       suite runs under `@jest-environment node`.
       AT LEAST THE CLIP AND AT MOST A FRAME PAST IT: short would cut the ending, and generous would hold a
       still. One 24fps frame is 42ms. */
    const real = mp4DurationMs(CARCOSA_FOG_VIDEO);
    expect(real).toBeGreaterThan(0);
    expect(CARCOSA_FOG_DURATION_MS).toBeGreaterThanOrEqual(real);
    expect(CARCOSA_FOG_DURATION_MS - real).toBeLessThan(42);
  });

  it("says the clip is silent because the clip is silent", () => {
    /* `videoHasOwnAudio` DECIDES WHETHER THE RADIO IS HELD DOWN for the clip's whole run (#1045), so a wrong
       answer here silences the music for six seconds to protect a film that makes no sound.
       CHECKED AGAINST THE CONTAINER, not against my memory of `ffprobe`: an MP4 with an audio track carries a
       handler box declaring the type "soun", and one without does not. The two hauntings are the positive
       control -- if this check could not tell the difference, it would pass on all three. */
    expect(fog.videoHasOwnAudio).toBe(false);
    expect(hasAudioTrack(CARCOSA_FOG_VIDEO)).toBe(false);
    expect(mark.videoHasOwnAudio).toBe(true);
    expect(hasAudioTrack("yellow-sign.mp4")).toBe(true);
    expect(hasAudioTrack("carcosa-awaits.mp4")).toBe(true);
  });
});

describe("the overlay implements both treatments and the shell picks one", () => {
  it("keeps the blend mode on the screened clips only", () => {
    /* #1043 CALLED `mix-blend-mode: screen` THE RULED PROPERTY and it still is -- for the clips it was ruled
       about. Anchored inside each style block so a blend mode leaking onto the feathered one fails here
       rather than in play, where it would look like a bug in the clip. */
    const screened = sliceBetween(OVERLAY, "videoScreened:", "videoFeathered:");
    expect(screened).toContain('mixBlendMode: "screen"');
    const feathered = sliceBetween(OVERLAY, "videoFeathered:", "};");
    expect(feathered).not.toContain("mixBlendMode");
  });

  it("dissolves the feathered clip's edges instead", () => {
    /* THE MASK SOLVES `screen`'s PROBLEM THE OTHER WAY. What screen does for the hauntings is stop the clip
       reading as a rectangle; a radial alpha mask does the same by removing the EDGES, which is where a
       rectangle announces itself, and leaves the centre at full contrast where the train is.
       THE PREFIXED PROPERTY IS CARRIED TOO -- Safari still wants `-webkit-mask-image` on a video element, and
       a mask that silently does nothing there would show a hard-edged box to exactly the players least likely
       to report it. */
    const feathered = sliceBetween(OVERLAY, "videoFeathered:", "};");
    expect(feathered).toContain("maskImage: FOG_MASK,");
    expect(feathered).toContain("WebkitMaskImage: FOG_MASK,");
    // Bigger than the hauntings, and still contained -- see the note on the full-viewport wash.
    expect(feathered).toContain('maxWidth: "88vw"');
  });

  it("sizes the mask to the closest side, which is the whole of why it works", () => {
    /* THE FIRST DRAFT OMITTED THIS KEYWORD AND LEFT A SEAM. A radial gradient with no sizing keyword is
       `farthest-corner`, which puts the edge MIDPOINTS at only 71% of the ray -- so a fade ending at 92% was
       still around 0.6 alpha down the left and right edges, and the clip ended on a visible vertical line.
       Found by compositing a real frame over the board colour and looking at the result, not by reading the
       declaration back to myself.
       ASSERTED ON THE KEYWORD because it is the difference between a vignette and a rectangle, and because
       nothing else in the declaration would look wrong without it. */
    expect(OVERLAY).toContain("ellipse closest-side at 56% 50%");
    expect(OVERLAY).toContain("rgba(0,0,0,0) 100%");
  });

  it("fades across the whole window rather than on mount and unmount", () => {
    /* AN EXIT TRANSITION ON AN UNMOUNTING ELEMENT DOES NOT RUN. Doing it properly would need a delayed second
       unmount, which is two timers that must agree about one clip -- #891's shape. One keyframe set spanning
       the clip, driven by `animationDuration`, has no second timer to disagree with.
       THE PERCENTAGES ARE PROPORTIONS, so the same block serves a six-second clip and a ten-second one. */
    expect(OVERLAY).toContain("@keyframes app-haunting-fog");
    expect(OVERLAY).toContain("animationDuration: `${ms}ms`");
    expect(OVERLAY).toContain("prefers-reduced-motion: reduce");
  });

  it("is told which treatment to use rather than inspecting the filename", () => {
    /* #732's RULE. Deriving the composite from the clip's name would put the same decision in two places and
       make the day a fourth clip arrives a debugging exercise. The cue decides; the overlay renders.
       AND IT IS NOT DEFAULTED, for `CarcosaMark` #1091's reason: a default would be silently wrong on
       whichever clip did not think about it, and wrong here means the clip erases the board. */
    expect(OVERLAY).toContain("composite: HauntingComposite;");
    expect(OVERLAY).not.toContain("carcosan-train");
    expect(APP).toContain("composite: cue.videoComposite ?? \"screen\",");
  });

  it("holds one object rather than three states that must agree", () => {
    /* #891 IS THIS CODEBASE'S MOST EXPENSIVE RECURRING BUG and three `useState` calls set from one place and
       read from another is its shape. A clip, its treatment and its window are one fact about one event. */
    expect(APP).toContain("const [haunting, setHaunting] = useState<{");
    expect(APP).not.toContain("setHauntingSrc");
  });

  it("ducks the radio only for a clip that makes noise", () => {
    /* THE DUCK EXISTS FOR AUDIO INSIDE THE `<video>` ELEMENT, which never passes through `playVariantCue` and
       so is never ducked or concurrency-limited by it (#1045). The fog clip has no audio stream; its sound is
       the MP3, which ducks itself. A deep duck here would hold the bed at 20% for six seconds to protect a
       silent film.
       ASKED OF THE CUE'S FIELD, not of the clip's name or its length. */
    expect(APP).toContain("cue.videoHasOwnAudio");
    expect(APP).toContain("? duckRadio(DUCK_FOR_VIDEO)");
    expect(APP).toContain("releaseHaunting?.();");
  });
});

describe("the third stage moves the board like the other two", () => {
  const owed = board(
    [company({ owned_trains: ["4", "5"], carcosan_trains: ["5"], is_carcosan: true, carcosan_doom_after_macro_round: 5 })],
    6,
  );
  const fog = (model: string) =>
    applySandboxAction(owed, {
      YellowSignEvent: { game_id: 1, protocol_id: CO, stage: "fog", model },
    } as never);

  it("takes the named train and clears the clock", () => {
    const after = fog("5");
    expect(after.public_companies[0].owned_trains).toEqual(["4"]);
    expect(after.public_companies[0].carcosan_trains).toEqual([]);
    expect(after.public_companies[0].carcosan_doom_after_macro_round).toBeUndefined();
  });

  it("leaves the corporation cursed", () => {
    /* RULED: "If the Carcosa train rusts while owned, the corporation remains permanently cursed." THE
       ASYMMETRY IS THE FEATURE, and it is the edge case the corporation-level flag exists for -- a scoreboard
       keyed on holding the train would find nobody here. */
    expect(fog("5").public_companies[0].is_carcosan).toBe(true);
    expect(carcosaStanding(fog("5").public_companies[0])).toBe("haunted");
  });

  it("refuses a train it is not owed", () => {
    /* THE 4-TRAIN IS ORDINARY STOCK and the fog has no claim on it, so a message naming it must move nothing.
       ASSERTED ON THE COMPANY, NOT ON OBJECT IDENTITY. The first draft was `expect(fog("4")).toBe(owed)`,
       borrowing #778's refusal shape -- and it failed, correctly: `applySandboxAction` wraps `applyOneAction`
       in four settlers, so the top-level object is rebuilt on every call including a refused one. The arm DOES
       return the state it was handed; the wrapper is what makes identity the wrong instrument here. */
    const after = fog("4").public_companies[0];
    expect(after.owned_trains).toEqual(["4", "5"]);
    expect(after.carcosan_trains).toEqual(["5"]);
    expect(after.carcosan_doom_after_macro_round).toBe(5);
  });

  it("refuses the same train twice", () => {
    /* THE REPLAY CASE, and the reason the refusal is worth a test at all: this log is replayed from the top
       by every client on every rebuild (#825), and a duplicated dispatch must not take a second train off the
       roster. `indexOf` on a mark that is already gone answers -1, and -1 is the refusal. */
    const once = fog("5");
    const twice = applySandboxAction(once, {
      YellowSignEvent: { game_id: 1, protocol_id: CO, stage: "fog", model: "5" },
    } as never);
    expect(twice.public_companies[0].owned_trains).toEqual(["4"]);
  });

  it("is dispatched rather than mutated locally", () => {
    /* #1046's RULE VERBATIM: "board state in this app is what the reducer writes while replaying", so a
       train removed in the shell would come back on the next rebuild. */
    expect(APP).toContain('stage: "fog"');
    expect(APP).toContain('resolved.stage === "fog"');
  });

  it("no longer takes the train at the round boundary", () => {
    /* #1089 DID, AND IT WAS RIGHT WHILE THE FOG WAS A RUST. There is no run at a Stock Round transition, so
       nothing there could carry the clause or ring the cue -- and two sentences for one event is the flood
       #718 removed. The helper is deleted rather than left uncalled: an exported way to take the train with
       no caller is a second way to take the train, waiting to be found. */
    expect(SESSION).not.toContain("expireCarcosanTrains");
    // What stays at that boundary is the limit exemption, which is a different clock entirely.
    expect(SESSION).toContain("const settled = expireGhostTrains(expired);");
  });
});

/* ------------------------------------------------------------------ */
/* #1090 -- the Blood Price                                           */
/* ------------------------------------------------------------------ */

describe("a Carcosan transfer costs the seller more than the train", () => {
  const held = () =>
    board([
      company({ owned_trains: ["5"], carcosan_trains: ["5"], is_carcosan: true, carcosan_doom_after_macro_round: 6 }),
      company({ company_id: RIVAL, ticker: "PRR", president: "p2", owned_trains: [], carcosan_trains: [] }),
    ]);

  it("recognises the sale before the settle clears the mark", () => {
    expect(isCarcosanTransfer(held(), CO, "5")).toBe(true);
    expect(isCarcosanTransfer(held(), CO, "4")).toBe(false);
    expect(isCarcosanTransfer(held(), RIVAL, "5")).toBe(false);
  });

  it("burns the gold trim off in transit", () => {
    /* RULED: "The train immediately loses its Carcosa/Yellow Sign flag and becomes a standard train for the
       buying corporation." THE BUYER IS NOT CURSED, which is what makes the trade a decision rather than a
       hot potato -- somebody has to want it. */
    const after = settleTrainSale(held(), RIVAL, CO, "5", "100");
    const buyer = after.public_companies.find((entry) => entry.company_id === RIVAL);
    expect(buyer?.owned_trains).toEqual(["5"]);
    expect(buyer?.carcosan_trains ?? []).toEqual([]);
    expect(buyer?.is_carcosan).not.toBe(true);
  });

  it("is the one thing that lifts the curse", () => {
    const seller = settleTrainSale(held(), RIVAL, CO, "5", "100").public_companies.find(
      (entry) => entry.company_id === CO,
    );
    expect(seller?.is_carcosan).toBe(false);
    expect(seller?.carcosan_trains).toEqual([]);
    // And the fog has nothing left to come for.
    expect(seller?.carcosan_doom_after_macro_round).toBeUndefined();
    expect(carcosaStanding(seller)).toBe("none");
  });

  it("leaves an ordinary train sale entirely alone", () => {
    /* THE CONTROL, and the one that matters most: a Blood Price charged on a normal trade would move a
       market token for a trade nobody was warned about -- #748a's symptom, "a price drop with no matching
       change in anybody's holdings". */
    const plain = board([
      company({ owned_trains: ["4"], carcosan_trains: [], is_carcosan: false }),
      company({ company_id: RIVAL, ticker: "PRR", owned_trains: [] }),
    ]);
    const after = settleTrainSale(plain, RIVAL, CO, "4", "60");
    const seller = after.public_companies.find((entry) => entry.company_id === CO);
    expect(seller?.is_carcosan).toBe(false);
    expect(isCarcosanTransfer(plain, CO, "4")).toBe(false);
  });

  it("moves the token left then down, through the two moves that already exist", () => {
    /* COMPOSED, NOT HAND-ROLLED. The left step IS a withhold step (ledge rule and all) and the down step IS a
       share-sale step, so this inherits every edge case both already handle -- including the inverted axis
       that `projectShareSaleMove` records as a bug it once caused. */
    const move = sliceBetween(MARKET, "export function projectBloodPriceMove", "}\n");
    expect(move).toContain('projectDividendCellMove(from, "withhold")');
    expect(move).toContain("projectShareSaleMove({ x: left.x, y: left.y }, 1)");
    expect(move).not.toContain("cellAt(");
    expect(move.length).toBeLessThan(500);
  });

  it("charges it only on a sale the mark covers", () => {
    const chart = sliceBetween(SESSION, 'if ("BuyTrainFromCorporation" in msg) {', 'if ("SellStock" in msg) {');
    expect(chart).toContain("ctx?.isCarcosanSale?.(seller_protocol_id, model_type) !== true");
    expect(chart).toContain('reason: "bloodPrice"');
    /* A MOVE THAT LANDS WHERE IT STARTED IS NOT A MOVE -- at the chart's corner both steps clamp, and
       reporting it would print "fell from $X to $X". */
    expect(chart).toContain("landed.x === mark.x && landed.y === mark.y");
  });

  it("gives the market atom a fourth reason rather than reusing the sale's", () => {
    // #435's "three movers, three words" becomes four: the log branches on it and so does the sentence.
    expect(SESSION).toContain('reason: "sale" | "withhold" | "payout" | "bloodPrice";');
    expect(APP).toContain('reason === "bloodPrice"');
    expect(APP).toContain("A Blood Price was paid:");
  });

  it("warns both sides in the one form they share", () => {
    /* RULED: "conditionally render this warning for both the proposer and the recipient." ONE BLOCK, because
       this panel is what a proposer composes in and what a recipient reads -- and a second copy is the #891
       shape this codebase produces more than any other. ABOVE THE PRICE, because a cost disclosed after the
       number is typed is a cost disclosed after the decision. */
    expect(PANEL).toContain("Transferring the Carcosa Train incurs a Blood Price");
    expect(PANEL).toContain("(1 cell Left, 1 cell Down)");
    expect(PANEL).toContain("(selectedSeller.carcosan_trains ?? []).includes(selection.model)");
    /* ==================================================================
        DESIGN NOTE 1090: THIS ORDERING WAS VACUOUS IN ITS FIRST DRAFT
       ==================================================================
       IT SLICED UP TO `styles.offerRow` AND LOOKED FOR "Offer price" INSIDE, and the label lives within that
       row rather than before it -- so `indexOf` returned -1, and "warning < -1" failed with a number nobody
       could read instead of "the anchor is not in the window". `sourceScan.ts` #886 is entirely about this:
       "-1 is less than every real index", which makes an ordering assertion mean nothing.
       BOTH SIDES THROUGH `anchorIndex` NOW, which is the tool that note added for exactly this and which I
       used correctly in `batch57` three batches ago. The window is the whole offer box, so the label it is
       ordered against is genuinely in it. */
    const box = sliceBetween(PANEL, "styles.offerBox", "styles.primaryButton");
    expect(anchorIndex(box, "bloodPriceWarning", "the warning")).toBeLessThan(
      anchorIndex(box, "Offer price", "the price label"),
    );
  });
});

/* ------------------------------------------------------------------ */
/* #1091 -- the curse, and who can see it                             */
/* ------------------------------------------------------------------ */

describe("the three states a corporation can be in", () => {
  it("names them from the two fields", () => {
    expect(carcosaStanding(company())).toBe("none");
    expect(carcosaStanding(company({ is_carcosan: true, carcosan_trains: ["5"] }))).toBe("holding");
    expect(carcosaStanding(company({ is_carcosan: true, carcosan_trains: [] }))).toBe("haunted");
  });

  it("marks the NAME only once the train is gone", () => {
    /* RULED: "If a corporation possesses the flag but no longer owns the physical Carcosa train ... append
       the icon next to the Corporation's logo or name ... (If they still own the train, the icon on the
       train chip provides sufficient visual feedback)." Two marks on one corporation would read as two facts
       rather than one emphasised. */
    expect(showsCurseBesideName(company({ is_carcosan: true, carcosan_trains: ["5"] }))).toBe(false);
    expect(showsCurseBesideName(company({ is_carcosan: true, carcosan_trains: [] }))).toBe(true);
    expect(showsCurseBesideName(company())).toBe(false);
  });

  it("appears beside the name on all three surfaces the ruling names", () => {
    /* "ACTION BAR, STOCKS TAB, AND GAME LEDGER" -- three files, wired by hand, and a feature passed at two
       of them works everywhere the author happened to look. #1088's batch needed a task of its own for
       exactly this. */
    for (const file of [
      "components/ContextualSubPanel.tsx",
      "components/StockRoundPanel.tsx",
      "components/FinancialLedger.tsx",
    ]) {
      const source = readStripped(file);
      expect(source).toContain("showsCurseBesideName(company)");
      expect(source).toContain('<CarcosaMark meaning="corporation"');
    }
    // The bar holds a projected corporation rather than the raw one, so it asks the same question in its terms.
    const bar = readStripped("panels/ContextualActionBar.tsx");
    expect(bar).toContain("activeCorporation.isCarcosan && activeCorporation.carcosanTrains.length === 0");
  });

  it("keeps the chip pointed at the identity and the pill at the exemption", () => {
    /* THE SPLIT THIS BATCH IS BUILT ON, asserted where it is easiest to undo. `TrainChips` draws the sign
       and wants `carcosan_trains`; `CapacityPill` counts slots and wants `ghost_trains`. Swapping them is a
       one-word edit that nothing else would catch. */
    for (const file of ["components/ContextualSubPanel.tsx", "components/FinancialLedger.tsx"]) {
      const source = readStripped(file);
      expect(source).toContain("ghosts={company.carcosan_trains}");
      expect(source).toContain("ghosts={company.ghost_trains}");
    }
    expect(readStripped("panels/ContextualActionBar.tsx"))
      .toContain("ghosts={activeCorporation.carcosanTrains}");
  });
});

describe("the end of the game names the president and says the line", () => {
  it("counts holding and haunted alike", () => {
    /* THE SCOREBOARD'S QUESTION IS DIFFERENT FROM THE NAME BADGE'S: "did the fog take an interest in this
       president", and it did whether or not the train survived to the final bell. */
    const state = board([
      company({ is_carcosan: true, carcosan_trains: ["5"] }),
      company({ company_id: RIVAL, ticker: "PRR", is_carcosan: true, carcosan_trains: [] }),
      company({ company_id: 9, ticker: "NYC" }),
    ]);
    expect(cursedCompanies(state).map((entry) => entry.ticker)).toEqual(["B&O", "PRR"]);
  });

  it("says the ruled sentence exactly", () => {
    expect(carcosaEpitaph("B&O", "Alice")).toBe(
      "B&O's ledgers were perfectly balanced, but the ink was yellow, and President Alice was never seen again.",
    );
  });

  it("says nothing rather than naming a president it does not have", () => {
    // "President undefined was never seen again" is a worse ending than silence.
    expect(carcosaEpitaph("B&O", null)).toBeNull();
  });

  it("keeps the curse out of the structure that decides who won", () => {
    /* RULED: "do not alter any final scores." A field on `PlayerStanding` would put flavour inside the object
       every number on that modal comes from, one careless sort away from mattering. */
    expect(MODAL).toContain("carcosa?: readonly { presidentAddress: string; epitaph: string }[];");
    expect(readStripped("utils/endgame.ts")).not.toContain("carcosa");
    /* THE MARK RIDES THE NAME CELL, NEVER A FIGURE COLUMN.
       ANCHORED ON `{row.label}` RATHER THAN ON `styles.cellName`, which appears twice -- once in the header
       row printing the word "Player" and once in the row that renders one. The first draft of this case took
       the header and failed for the right reason with the wrong message, which is `sourceScan.ts` #886's
       whole subject: an anchor that also appears earlier. */
    const nameCell = sliceBetween(MODAL, "{row.label}", "styles.cellNum");
    expect(nameCell).toContain('<CarcosaMark meaning="president"');
    expect(nameCell).toContain("styles.tagWinner");
    expect(nameCell.length).toBeLessThan(700);
  });

  it("puts the epitaph beneath the standings, after the winner", () => {
    expect(MODAL.indexOf("wins with $")).toBeLessThan(MODAL.indexOf("styles.carcosaEpitaph"));
  });
});

describe("the fog has no log line of its own", () => {
  it("says the ruled sentence as a flavour CLAUSE, not as a receipt", () => {
    /* #1089 PRINTED THIS AS ITS OWN LINE at the round boundary and it was right at the time. #1092 made it
       the third step of the revenue sequence, so the sentence now arrives the way the other two stages'
       sentences do -- inside the run that caused it. TWO SENTENCES FOR ONE EVENT is the flood #718 removed,
       and the boundary copy would have printed a round before the clause saying the same thing. */
    expect(CARCOSA_FOG_LINE).toBe("The gold-trimmed train disappeared back into the fog.");
    expect(CARCOSA_FOG_LINE).toBe(FOG_LINE);
    expect(APP).not.toContain("CARCOSA_FOG_LINE");
    /* The diff-derived receipt is gone with it -- both halves, so a survivor cannot resurrect the line. */
    expect(APP).not.toContain("if ((stale.carcosan_trains?.length ?? 0) === 0) continue;");
    expect(APP).not.toContain("if ((now?.carcosan_trains?.length ?? 0) !== 0) continue;");
  });

  it("still stamps the two stages that DO announce themselves", () => {
    /* THE STAMP SURVIVED THE MOVE. The Mark and the gift each print a receipt after their clause, because
       each moves something the clause does not describe -- cash found, a train received. The fog moves only
       the train the clause just said went. */
    expect(CARCOSA_STAMP_STEP).toBe("Yellow Sign");
    expect(APP).toContain("operating_sub_phase: CARCOSA_STAMP_STEP as never");
    expect(APP).toContain("The ${taken}-train disappeared. $${award} found.");
  });
});
