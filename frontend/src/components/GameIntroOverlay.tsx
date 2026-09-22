// frontend/src/components/GameIntroOverlay.tsx
//
// The title sequence, between the waiting room and the first deal.
//
// ==================================================================
//  DESIGN NOTE 1111: TEN SECONDS THE PLAYER CAN LEAVE
// ==================================================================
//
// REQUESTED: "I want to use this cinematic intro video between the Waiting Room and the actual game. It
// should play once all players Ready and the Host clicks Start Game."
//
// IT IS AN OVERLAY, NOT A SCREEN, and that is the one structural decision here. A third top-level branch --
// waiting room, then intro, then shell -- would hold the game back for ten seconds and then start mounting
// it. Laid over the shell instead, the deal, the board and the first render all happen behind the clip, so
// dismissing it lands on a game that is already there rather than on a loading state wearing a different
// picture. It also means a skip is INSTANT, which is what makes the skip worth offering.
//
// EVERY CLIENT, NOT THE HOST. Start writes `SetupGame` to the room document and every browser replays it, so
// the room's status is what moves -- the caller watches for the `waiting` -> `playing` edge rather than for
// a local click. A player who joins a room already in progress never sees the edge, and correctly gets no
// intro.
//
// A SKIP BUTTON RATHER THAN CLICK-ANYWHERE, on instruction. Click-to-dismiss on a full-screen element is
// invisible until it is explained, and it fires on the click a player did not mean -- reaching for a control
// on the board they can see through the clip. A button is a target, is reachable by keyboard, and can say
// what it does. Escape works too, because Escape always should.
//
// See docs/ai_architecture/ui_shell_layout.md, GameIntroOverlay.tsx #1111.

import React from "react";

import { gameTypeOf, type GameType } from "../gameEngine/gameVariants";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { duckRadio, DUCK_FOR_VIDEO } from "../utils/audio";
// Design note #1144: the chrome's scale, so this layer can divide back out of it.
/* Design note #1294: the chrome scale, live, for the counter-zoom. */
import { useUiScale } from "../utils/useUiScale";

/** Served from `public/`, like the haunting clips. `video/` rather than `audio/`: those three live beside
 *  the variant SFX they belong to, and this is not a sound effect. */
export const GAME_INTRO_SRC = `${process.env.PUBLIC_URL ?? ""}/video/game-intro.mp4`;

/* ==================================================================
    DESIGN NOTE (INTRO EDITORIAL PASS): THREE TITLES, ONE FILM, THREE DIFFERENT HANDOFFS
   ==================================================================
   THE RULESET NOW NAMES THE TITLE. A room playing 18XX+ opened on a wordmark reading 18XX, which is the
   same class of fault #961a names: one variant wearing another's name on a screen the table reads before
   agreeing to it.

   AND THE THREE TITLE CLIPS ARE NOT INTERCHANGEABLE, which is the whole of this pass. They are the same
   nominal length (~4s) and have completely different internal editing, measured frame by frame at 24fps:

     BASE (inside `game-intro.mp4`) -- the wordmark is COMPLETE AT FRAME ZERO. It never constructs; the
       whole clip is specular shimmer over a finished title. Its decorative phase is therefore ~3.0s long.
     PLUS (`18XXPlus.mp4`) -- the lettering is present but unlit at t=0 and a travelling burst illuminates
       it left to right. Readable by ~1.96s; the burst clears the wordmark's right edge at 2.917s and after
       that only a sparkle trail drifts. Decorative phase ~1.08s.
     LPF (`18xxLPF.mp4`) -- "Project 18XX" is lit from t=0, the "+" is struck at ~1.5s, and then
       "A LEVEL PLAYING FIELD" materialises letter by letter and does not finish kerning until 3.167s.
       Settled at 3.208s. Decorative phase ~0.79s -- a quarter of the base's.

   SO THE RULE IS EDITORIAL, NOT NUMERICAL: every variant hands off when its title has finished being
   BUILT and only decoration remains, and the crossfade eats that decoration. The base's handoff is late
   (3.011s) because its decorative phase is long, not because 3.011 is a good number -- and forcing LPF to
   the same figure would cross-fade the body over a subtitle that was still drawing itself.

   THE BODY IS ONE AUTHORITY. All three films are composed from the same 10.006s master
   (`docs/ai_architecture/source_assets/intro/intro-body.mp4`) by the same script, and the base is the file
   that was already shipping -- itself composed from that master, verified here frame-for-frame. */

export type IntroCut = {
  src: string;
  /** Where the SHARED BODY's own t=0 lands in this film -- which is also where the crossfade starts. */
  handoffAtSeconds: number;
  /** How long the title and the body overlap. */
  crossfadeSeconds: number;
};

/* ==================================================================
    DESIGN NOTE (INTRO EDITORIAL PASS): THE MEASUREMENTS, AND WHY THEY ARE CONSTANTS AND NOT SETTINGS
   ==================================================================
   These are the cut points of three specific pieces of footage. They are not tunable, they are not game
   rules, and a settings surface offering them would be offering to break the film. They live here because
   the credit cue below has to be derived from them -- that is the only reason a running program needs to
   know where a crossfade was.

   MEASURED (24fps, frame-aligned; see the composition script beside the body master):

     film   semanticResolve  visualSettle  crossfadeStart  duration  titleGone  total
     base   0.000            ~0.0          3.011           1.000     4.011      13.042
     plus   1.958            2.917         2.917           1.000     3.917      12.959
     lpf    3.167            3.208         3.250           0.750     4.000      13.292

   LPF'S OVERLAP IS THE SHORTEST BECAUSE ITS FOOTAGE LEAVES NOTHING ELSE. Its subtitle finishes at 3.167s
   of a 4.000s clip, so 0.75s is every frame there is after settle. Padding the clip with a frozen last
   frame would have bought another quarter-second of reading time and was rejected on measurement: both
   supplied titles carry continuous audio to 3.9s, so a video freeze would have needed a silent audio pad
   under it, and a gain dip at the handoff is the one thing section 9 of the brief rules out by name. */
export const INTRO_CUTS: Readonly<Record<GameType, IntroCut>> = {
  standard: {
    src: GAME_INTRO_SRC,
    handoffAtSeconds: 3.011,
    crossfadeSeconds: 1.0,
  },
  plus: {
    src: `${process.env.PUBLIC_URL ?? ""}/video/game-intro-plus.mp4`,
    // Frame 70 of 24fps. The burst has just cleared the wordmark; everything after is sparkle.
    handoffAtSeconds: 2.916667,
    crossfadeSeconds: 1.0,
  },
  levelPlayingField: {
    src: `${process.env.PUBLIC_URL ?? ""}/video/game-intro-lpf.mp4`,
    // Frame 78. One frame after the subtitle stops moving, and 0.75s is all the clip has left.
    handoffAtSeconds: 3.25,
    crossfadeSeconds: 0.75,
  },
};

/* Design note #1186: `TITLE_FADE_IN_MS`, `TITLE_HOLD_UNTIL_MS` and `TITLE_FADE_MS` are GONE with the card
   they timed. #1166's long note measured the footage frame by frame to choose them -- which half second was
   darkest, how soon the card had to clear the locomotive -- and none of that applies to a film that opens on
   its own title. Recorded rather than silently deleted, so a reader meeting those names in an older note
   learns where they went. */

/** Design note #1166: the extra beat on the finished mark, asked for as "1-2 seconds". The video element
 *  holds its last frame when it ends, so this is a delay before `finish`, not a second render.
 *  Design note #1259: REPORTED "about 20% too long" after a few games. 1600 -> 1280, which is the report's
 *  number applied rather than rounded to something tidier -- still inside #1166's "1-2 seconds" and still
 *  clear of the credit's last word (four words at 140ms stagger land by ~0.6s into the hold). */
const LOGO_HOLD_MS = 1280;

/** The clip's own length. The overlay does not depend on it -- `onEnded` is the real signal -- but a timer
 *  this long is the backstop for an engine that never fires it (a decode failure, a tab suspended mid-clip).
 *  Generous rather than exact, so a slow start is not cut short.
 *  Design note #1166: it must now also clear the clip PLUS the hold -- 10.0s + 1.6s -- or the backstop would
 *  cut the credit off mid-fade on a machine where `onEnded` is late rather than absent. */
/* Design note #1186: 13.042s of film plus #1166's 1.6s hold is 14.7s, so the old 14000 would cut the credit
   off mid-fade on a machine where `onEnded` is late rather than absent. Generous rather than exact, as
   before -- the backstop is for a decode failure, not for timing. */
const INTRO_BACKSTOP_MS = 18000;

/* ==================================================================
    DESIGN NOTE 1166a: "POWERED BY", BECAUSE THREE SURFACES ALREADY SAY IT
   ==================================================================
   ASKED: "do you think 'brought to you' is right here when we've used 'powered by' everywhere else?"
   IT IS NOT, AND THE COUNT IS THE ARGUMENT. `AppFooter` carries "Powered by Neta DAO" on the Lobby, the
   Waiting Room and the Game Room -- and the intro plays BETWEEN two of them, so a player would read one
   phrasing in the cinematic and a different one in the footer of the screen it hands them to, seconds apart.
   THE PROJECT HAS ALREADY RULED ON THIS EXACT CLASS. #961a found one variant carrying two names across two
   screens and called it what it is: "one variant with two names, on the two screens a table reads before
   agreeing to it". A brand line is the same kind of fact.
   GENRE CONVENTION IS THE ONLY THING ON THE OTHER SIDE -- a title card conventionally reads "brought to you
   by" -- and consistency of a name beats the convention of a form, particularly when the two appear within a
   few seconds of each other on adjacent screens.

   WORDS, NOT LETTERS. The report offered "each letter/word appearing in sequence", and twenty-odd letters
   inside the cue would be a stutter rather than a reveal -- four words reads as writing appearing. */
export const CREDIT_WORDS = ["Powered", "by", "Neta", "DAO"] as const;
const CREDIT_WORD_STAGGER_MS = 140;

/* ==================================================================
    DESIGN NOTE 1166a: THE CREDIT WRITES ITSELF WHILE THE MARK DOES
   ==================================================================
   ASKED: "do you have it synced to the part of the video where the Neta DAO logo is being drawn, or did you
   put it after that?"
   AFTER, and the question is a better idea than the spec. #1166 mounted it on `ended`, so the words arrived
   once the picture had stopped -- correct to the letter of "during this final frame hold", and a beat late:
   the mark draws itself from about 7.5s to 9.0s, which is the one moment in the clip with movement to travel
   alongside.
   CUED OFF `timeupdate`, NOT A TIMER. A `setTimeout` measured from play START drifts the moment the clip
   stutters or begins late, and would then place the words against a frame that is not the one they were
   written for. `currentTime` is the picture's own clock, so this cannot drift from it by construction --
   which is the same reason #1166 used `ended` rather than counting to ten thousand.
   8.6s PUTS THE LAST WORD ON THE COMPLETED MARK. Four words at 140ms plus a 320ms fade is about 740ms, so the
   line finishes around 9.35s -- just as the mark resolves at ~9.5s -- and the hold then belongs entirely to
   reading it rather than to waiting for it.
   `ended` REMAINS A FALLBACK. An engine that never fires `timeupdate` still gets the credit, one beat late,
   which is exactly the behaviour #1166 shipped. A cue that can only fail closed. */
/* ==================================================================
    DESIGN NOTE 1186: THE CUE MOVES BY THE PREPEND, NOT BY A NEW MEASUREMENT
   ==================================================================
   The film is the wordmark (4.011s) cross-faded over 1.000s into the original (10.006s), so the original's
   own timeline begins at output t=3.011 and the whole runs 13.042s. Every frame #1166a measured is still
   there, in the same order, three seconds later.
   SO THE OFFSET IS ADDED RATHER THAN RE-DERIVED. 8.6 + 3.011 = 11.611, rounded to 11.6 because the cue is a
   `timeupdate` threshold and the event does not fire on millisecond boundaries. #1166a's reasoning carries
   verbatim: four words at 140ms plus a 320ms fade finish about 740ms after the cue, landing on the mark as
   it resolves. Re-measuring would risk choosing a different frame of a picture that has not changed.

   ==================================================================
    DESIGN NOTE (INTRO EDITORIAL PASS): THE CUE BELONGS TO THE BODY, NOT TO THE FILM
   ==================================================================
   #1186 WAS RIGHT AND ITS AUTHORITY WAS WRONG, and the difference only shows up now. It added the prepend
   to the body-relative cue and wrote down the SUM -- which was correct while there was exactly one prepend
   and would have been silently wrong the moment a second title with a different handoff arrived. A cue
   expressed as "11.6s into the film" is a fact about one edit; the thing it is actually about is a frame of
   the Neta mark, which lives in the body.
   SO THE CONSTANT IS THE BODY'S OWN 8.6s, and each film's cue is that plus its own handoff. The base comes
   back out at 8.6 + 3.011 = 11.611 -> 11.6, the number #1186 hand-wrote, which is the check that this
   refactor changed nothing for the film it was measured on. */
const BODY_CREDIT_CUE_SECONDS = 8.6;

/** When the credit is cued in a given ruleset's film: the body's own moment, moved by that film's handoff.
 *
 *  ROUNDED TO A TENTH, keeping #1186's reason: this is a `timeupdate` threshold and the event does not
 *  fire on millisecond boundaries, so a figure finer than the event is a figure pretending to a precision
 *  the browser does not offer. */
export function creditCueSecondsFor(type: GameType): number {
  return Math.round((INTRO_CUTS[type].handoffAtSeconds + BODY_CREDIT_CUE_SECONDS) * 10) / 10;
}

/** How long before the skip offers itself. Long enough that the opening is not competing with a control,
 *  short enough that nobody feels held. */
const SKIP_APPEARS_AFTER_MS = 1800;

/* Inline styles cannot express `@keyframes` -- design note #46's escape hatch. One rule, one consumer, so it
   lives here rather than in `animations.ts`, which is for keyframes several surfaces share.
   REDUCED MOTION LOSES THE FADE AND KEEPS THE BUTTON, matching #606's rule everywhere else in the app: the
   information is the control, never the movement. */
const SKIP_FADE_CSS = `
@keyframes app-intro-skip-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
/* ==================================================================
    DESIGN NOTE 1166b: THE ANIMATION ATE THE CENTRING
   ==================================================================
   REPORTED: "I only see like the top left quarter-ish of the Project 18XX title."
   AND THAT IS EXACTLY WHAT A CLOBBERED TRANSFORM LOOKS LIKE. The card was centred with the usual
   translate(-50%, -50%) and then handed to a keyframe that animated transform for the scale-in -- with fill
   mode both, so the animated value REPLACED the centring for the whole of the card's life. The element's
   top-left corner sat at the middle of the screen and the picture ran off to the right and down, which shows
   the top-left quarter of it. One property, two owners.
   SO THE KEYFRAMES OWN OPACITY AND NOTHING ELSE, and the centring moved to inset-plus-auto-margins, which
   needs no transform at all. The scale-in is gone rather than reimplemented: it was decoration, and buying it
   back would mean writing the translate into every frame of two keyframes and keeping them in step.
   IT ALSO PROTECTS THE BLEND. #1131 records that a transform makes a stacking context and mix-blend-mode
   stops compositing against what is behind it -- that note is about an ANCESTOR, and an animated transform on
   the blended element itself isolates it just as well. The title is keyed off its own black; a transform here
   was quietly risking the thing that makes the asset usable over footage at all. */
@keyframes app-intro-word-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
/* Design note #1166: each word arrives on its own delay, which is the "fading in from left to right" the
   report describes. The delay is supplied per span by the call site -- CSS cannot count siblings and produce
   a number from the count, and nth-child rules would have to be written out one per word.
   NO BACKTICKS IN THIS BLOCK, which DividendMoneyMachine #1061 warned about and which I have now walked into
   twice in one batch, in two different files: this comment sits inside a template literal, the string ends at
   the first backtick, and tsc reports the failure somewhere else entirely. The warning belongs beside every
   such block rather than in the one file that first paid for it. */
.app-intro-word { animation: app-intro-word-in 320ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .app-intro-skip { animation: none !important; }
  /* Design note #1186: the title arm is gone with the card. It was the one animation this file refused to
     disable, because #606's rule is that the INFORMATION survives and the information was that the card is
     temporary. A title inside the footage cannot outstay its welcome, so there is nothing left to guarantee. */
  .app-intro-word { animation: none !important; opacity: 1 !important; transform: none !important; }
}
`;

export interface GameIntroOverlayProps {
  /** Dismissed by the clip ending, the skip button, Escape, or the backstop. */
  onDone: () => void;
  /** Design note #1111: the clip carries a soundtrack, and a player who muted effects meant it. */
  sfxEnabled: boolean;
  /** ==================================================================
   *   THE RESOLVED TYPE, NOT A LABEL AND NOT A FILENAME
   *  ==================================================================
   *  `gameTypeOf` is the one authority on which of the three a room is playing -- it reads the flags back
   *  into the choice, so a room dealt by an older build or a document written by hand still resolves
   *  (gameVariants.ts #1445's note). Passed in rather than read here, because this component has no
   *  business knowing where game state lives.
   *  DEFAULTS TO `standard`, so a caller that cannot say gets the film that was already shipping. */
  gameType?: GameType;
}

export function GameIntroOverlay({ onDone, sfxEnabled, gameType = "standard" }: GameIntroOverlayProps) {
  const cut = INTRO_CUTS[gameType];
  const creditCueSeconds = creditCueSecondsFor(gameType);
  /* Design note #1294: the chrome scale, live. */
  const uiScale = useUiScale();
  const [skipVisible, setSkipVisible] = React.useState(false);

  /* ONE `onDone`, HOWEVER IT ENDS. Four things can finish this -- the clip, the button, Escape, the backstop
     -- and every one of them must release the duck exactly once. The ref is what makes the second caller a
     no-op rather than a second release. */
  const finished = React.useRef(false);
  const finish = React.useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onDone();
  }, [onDone]);

  /* ==================================================================
      DESIGN NOTE 1166: THE CLIP ENDS; THE SEQUENCE DOES NOT
     ==================================================================
     ASKED: "at the end of the video, please hold the final completed logo frame for an extra 1-2 seconds.
     During this final frame hold, fade in the text 'brought to you by Neta DAO' underneath the completed
     logo."
     `onEnded` USED TO BE `finish` DIRECTLY, so the mark was on screen for a frame and then gone. A video
     element holds its last frame when it stops, which is what makes this a DELAY rather than a still image
     rendered over the top: the picture the player keeps looking at is the clip's own final frame.
     THE CREDIT MOUNTS ON THE SAME EDGE, so it cannot appear over the map or the drawing -- it exists only in
     the window the hold creates.
     SKIP AND ESCAPE STILL CUT IT, because `finish` is unchanged and every path still runs through it. A hold
     that could not be skipped would have made the last two seconds the one part of a skippable sequence that
     was not. */
  const [holding, setHolding] = React.useState(false);
  /* Design note #1166a: the credit has its own flag now. It is raised by the clip reaching the mark's draw,
     and the hold no longer owns it -- `holding` still governs the title card's removal and the delay before
     `finish`, which are the two things that really do belong to the end. */
  const [creditVisible, setCreditVisible] = React.useState(false);
  const onTimeUpdate = React.useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (event.currentTarget.currentTime >= creditCueSeconds) setCreditVisible(true);
    },
    [creditCueSeconds],
  );
  const holdEnded = React.useCallback(() => {
    setHolding(true);
    // Design note #1166a: the fallback for an engine that never fired `timeupdate`.
    setCreditVisible(true);
    window.setTimeout(finish, LOGO_HOLD_MS);
  }, [finish]);

  React.useEffect(() => {
    /* Design note #1041's registry, used as intended: the radio drops to 20% under the clip and comes back
       on the release. Nothing here knows whether a radio exists, and the radio does not know about this. */
    const release = duckRadio(DUCK_FOR_VIDEO);
    const skipTimer = window.setTimeout(() => setSkipVisible(true), SKIP_APPEARS_AFTER_MS);
    const backstop = window.setTimeout(finish, INTRO_BACKSTOP_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      release();
      window.clearTimeout(skipTimer);
      window.clearTimeout(backstop);
      window.removeEventListener("keydown", onKey);
    };
  }, [finish]);

  return (
    <div style={{ ...styles.backdrop, zoom: 1 / uiScale }} role="dialog" aria-modal="true" aria-label="Opening titles">
      <style>{SKIP_FADE_CSS}</style>
      {/* Design note #1166b: the stage is the rectangle the video paints into, so the two overlays below are
          positioned in the PICTURE's coordinates rather than the window's. The skip stays outside it -- that
          one belongs to the screen corner, not to the artwork. */}
      <div style={styles.stage}>
      <video
        style={styles.video}
        /* KEYED ON THE SOURCE so a ruleset change between mounts reloads the element rather than leaving
           a decoded film from the previous room in it. */
        key={cut.src}
        src={cut.src}
        autoPlay
        playsInline
        muted={!sfxEnabled}
        loop={false}
        onEnded={holdEnded}
        onTimeUpdate={onTimeUpdate}
        /* A clip that will not decode must not become a ten-second black screen with a button on it. */
        onError={finish}
      />
      {/* ==================================================================
            DESIGN NOTE 1186: THE TITLE CARD IS IN THE FILM NOW
          ==================================================================
          REPORTED: the cinematic was too short. A supplied clip of the wordmark under a travelling light is
          prepended and cross-faded in, replacing the card #1166 built.
          #1166's CARD EXISTED BECAUSE THE CLIP HAD NO TITLE. Its note is explicit -- "the opening is the
          darkest bed in the clip, which is what decides where the title goes". The film opens ON the title
          now, so a card would be a second Project 18XX over the first, which #1166's own note warns against
          from the other direction: "a second rendering of the title would be a second thing to keep in step".
          EVERYTHING THAT SERVED IT GOES TOO: three timing constants, two keyframe pairs, the `screen` blend
          with #1131's stacking-context warning, and the reduced-motion arm that existed only to guarantee the
          card still LEFT. A title that is part of the footage cannot overstay.
          THE HOLD SURVIVES. `holding` still governs the delay before `finish` (#1166's "1-2 seconds" on the
          finished mark); it simply no longer has a card to remove as well. */}

      {/* Design note #1166: the credit, one word at a time, in the window the hold opens. */}
      {creditVisible && (
        <p style={styles.credit}>
          {CREDIT_WORDS.map((word, index) => (
            <span
              key={word}
              className="app-intro-word"
              style={{ animationDelay: `${index * CREDIT_WORD_STAGGER_MS}ms` }}
            >
              {word}
              {/* Design note #1338: no trailing space after the LAST word -- a centred line that ends in a space
                  sits half a space left of centre, which is the "ever so slightly off" that was reported. */}
              {index < CREDIT_WORDS.length - 1 ? " " : ""}
            </span>
          ))}
        </p>
      )}

      </div>

      {skipVisible && (
        <button type="button" className="app-intro-skip" style={styles.skip} onClick={finish} autoFocus>
          Skip intro
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /* Above everything. The shell's own layers top out in the low thousands (`ActionToast` sits at 4000), so
     this clears them by an order of magnitude rather than by one. */
  backdrop: {
    /* ==================================================================
        DESIGN NOTE 1144: ART AT VIEWPORT SIZE OPTS OUT OF THE CHROME'S ZOOM
       ==================================================================
       The shell's root carries `zoom: UI_SCALE` so the game room's CHROME draws at the size the player was
       reaching for the browser's zoom control to get.
       AN EARLIER DRAFT OF THIS NOTE SAID `inset: 0` WOULD STOP MEANING "THE VIEWPORT". IT WAS WRONG, and it
       was wrong in the confident direction: measured in Chrome 148, a fixed layer inside `zoom: 0.7` still
       comes back the full width and height of the window, because the containing block a fixed element gets
       is itself zoom-adjusted. The clip would have played full-bleed with or without this line.
       WHAT ACTUALLY SHRINKS IS EVERYTHING AUTHORED IN PIXELS INSIDE THE LAYER -- here, "Skip intro". The
       video is a raster stretched to a box that covers the window either way, so it is unaffected; the button
       is a control sized to a cinematic, and at 70% it becomes a small grey word on a full-screen picture.
       COUNTER-ZOOMED RATHER THAN MOVED OUT OF THE TREE, which was the alternative: a portal would work and
       would put this layer somewhere a reader does not expect to find it. `1 / UI_SCALE` is the same idiom
       `boardPane` uses, and for the same reason -- this is ART sized to the window, not chrome sized to the
       reader.
       THE MODALS ARE DELIBERATELY NOT DOING THIS. A confirm dialog is chrome and should shrink with the rest
       of it; only the surfaces that are pictures at viewport size are exempt. */
    /* Design note #1294: `zoom` is written per render as `1 / useUiScale()`. */
    position: "fixed",
    inset: 0,
    zIndex: 40000,
    backgroundColor: "#080808",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  /* ==================================================================
      DESIGN NOTE 1166b: A STAGE THAT IS THE PICTURE, NOT THE SCREEN
     ==================================================================
     REPORTED: "the Powered by Neta DAO renders on top of the Neta DAO logo -- it needs to be bumped
     downward."
     IT WAS AT 68% OF THE OVERLAY, and the overlay is the whole window while the video is `object-fit:
     contain` -- letterboxed inside it on any viewport that is not 16:9. So a percentage of the overlay is not
     a percentage of the PICTURE, and the gap between the two is however much black is above and below.
     MEASURED, so the number is not a guess twice over: sampling the final frame, the completed mark occupies
     28% to 72% of the frame's height. 68% was inside it before any letterboxing was taken into account.
     THE FIX IS A BOX THAT REPRODUCES `contain`. `aspect-ratio: 16 / 9` with both maxima at 100%, centred in
     the flex backdrop, is exactly the rectangle the video paints into -- so the overlays are positioned
     against the same coordinates the artwork is, on every window shape. No viewport units, which also keeps
     it clear of #1144's finding that `vw`/`vh` are scaled by an enclosing `zoom`. */
  stage: {
    position: "relative",
    width: "100%",
    aspectRatio: "16 / 9",
    maxWidth: "100%",
    maxHeight: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  /* Design note #1186: `titleCard` and `titleArt` are gone with the element they dressed. Their note carried
     #1131's warning that an ancestor transform or opacity kills a `screen` blend; that lesson is not lost, it
     is stated where it still applies -- on the Lobby's own wordmark and in `blendIsolation.test.ts`. */
  /* Design note #1166: under the finished mark. The mark sits centred and occupies roughly the middle third,
     so this clears it rather than guessing at a gap -- and it is `position: absolute` for the same reason the
     title is, so neither can shift the video's own centring. */
  credit: {
    position: "absolute",
    /* Design note #1166b: the mark ends at 72% of the frame, measured. 80% clears it inside the stage, which
       is the picture's own box rather than the window's. */
    top: "80%",
    left: 0,
    right: 0,
    margin: 0,
    textAlign: "center",
    fontSize: FONT_SIZE.heading,
    fontWeight: 600,
    letterSpacing: "0.08em",
    /* Design note #1338: `letter-spacing` is added AFTER every glyph, the last one included, so a centred
       line of tracked text sits half a track left of the glyphs' true centre. The same amount of left padding
       puts the ink back under the mark. */
    paddingLeft: "0.08em",
    color: "#f2f0eb",
    textShadow: "0 2px 12px rgba(0,0,0,0.8)",
    pointerEvents: "none",
  },
  /* `contain` rather than `cover`: the clip is a drawing with content at its edges, and cropping it to fill
     a wide window would cut the map it is drawing. The letterbox is the theme's own ground, so it reads as
     framing rather than as a gap. */
  video: { width: "100%", height: "100%", objectFit: "contain", display: "block" },
  skip: {
    position: "absolute",
    right: "22px",
    bottom: "22px",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    padding: "7px 16px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "rgba(20, 20, 20, 0.82)",
    color: "#c8c6c0",
    cursor: "pointer",
    /* Fades in rather than appearing, so it does not read as something arriving to be dealt with. */
    animation: "app-intro-skip-in 320ms ease both",
  },
};

export default GameIntroOverlay;
