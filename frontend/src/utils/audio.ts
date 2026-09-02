// frontend/src/utils/audio.ts
//
// The game's two audio channels: a one-shot turn whistle and a continuous radio stream.
//
// ==================================================================
//  DESIGN NOTE 1009: TWO CHANNELS, TWO LIFETIMES, ONE MUTE EACH
// ==================================================================
//
// REQUESTED: "a turn-notification sound effect and an atmospheric background radio stream ... toggle icons
// (e.g., a music note for the stream, a speaker for SFX) ... These must allow the player to independently
// mute/unmute the music and the sound effects."
//
// HOOKS RATHER THAN A MANAGER OBJECT, and the report offered either. A singleton manager would have to be
// told when the app unmounts, when a stream should reconnect and when a mute changed -- which is a lifecycle,
// and React already owns one. Two hooks with two `useRef`s hold the same two elements with no second system
// deciding when they die.
//
// AND THEY DO NOT SHARE AN ELEMENT. A one-shot effect wants `preload="auto"` and instant replay; a live
// stream wants `preload="none"` and a fresh connection each time. One element serving both would be muted,
// re-sourced and rewound by two callers with different ideas about what `currentTime` means.
//
// EVERY `play()` IS CAUGHT. It rejects for reasons that are not errors -- autoplay policy before the first
// gesture, a stream that 404s, a device with no output -- and an uncaught rejection in a notification sound
// is a console error a player cannot act on. It also returns `undefined` rather than a promise on older
// engines and in jsdom, which is why the call is guarded rather than chained directly.

import { useCallback, useEffect, useRef, useState } from "react";

/** The whistle, served from `public/` -- referenced by absolute public path, not imported, so the bundler
 *  neither inlines it nor renames it. */
export const WHISTLE_SRC = "/audio/whistle.mp3";

/** The station. A LIVE stream, which is what shapes `useRadioStream` below. */
export const RADIO_STREAM_URL = "https://s3.radio.co/s39c195d74/listen";

/* ==================================================================
    DESIGN NOTE 1013: THE MIX, NOT THE VOLUME
   ==================================================================
   REPORTED: "The train whistle sound effect is too quiet compared to the radio stream. Increase the default
   volume of the SFX Audio object (or slightly lower the radio's default volume to balance the mix)."

   BOTH HALVES, because raising the whistle alone would not have fixed it. `volume` defaults to `1` on every
   `Audio` element, so the whistle was ALREADY at the maximum the API allows -- "increase the SFX volume" has
   no room to move on its own, and the only reason the report reads as if it should is that the two sources
   are mastered differently. A file recorded quiet cannot be amplified past 1.0 by this element.

   SO THE MUSIC COMES DOWN, which is the report's own parenthetical and the half that actually has headroom.
   0.45 rather than a token trim: the stream is a bed the whistle has to cut through, and a notification that
   merely matches the music is a notification a player stops hearing.

   THE WHISTLE IS PINNED AT 1 EXPLICITLY rather than left to the default. It is the same value the browser
   would supply, and writing it down is what stops the next person balancing the mix from moving the music
   and wondering why the two numbers are not in the same place. */
export const SFX_VOLUME = 1;
export const RADIO_VOLUME = 0.45;

/* ==================================================================
    DESIGN NOTE 1074: THE TWO FIGURES ARE DEFAULTS NOW, NOT THE MIX
   ==================================================================

   ASKED FOR: "volume controls on both Radio and SFX ... players get a volume slider and an Off toggle when
   they click them, and if they click the Off/X/whatever the button dims."

   THE CONSTANTS ABOVE STAY, AND THEIR NOTE STAYS TRUE. #1013 balanced the mix and its reasoning is the
   STARTING point a player begins from; what changes is that they can now move off it. Renaming them to
   `DEFAULT_*` was the tempting edit and would have broken every test that reads the balance, for no gain --
   the values are the defaults, and the mutable pair below says so by taking them as its initial state.

   MODULE STATE RATHER THAN A CONTEXT, matching `playerLabels.ts` #535b's reasoning one file over: the audio
   engine is reached from `playVariantCue`, from the whistle hook and from the radio element, none of which
   are React components, and threading a provider to them would put a value three non-components need behind
   a hook. `App.tsx` owns the SLIDER and mirrors it here; this owns what the elements actually play at. */
let sfxVolume = SFX_VOLUME;
let radioVolume = RADIO_VOLUME;

export function currentSfxVolume(): number {
  return sfxVolume;
}
export function currentRadioVolume(): number {
  return radioVolume;
}
export function setSfxVolume(value: number): void {
  sfxVolume = clampVolume(value);
}
/** The radio's level, applied to the live element as well as to the next one.
 *
 *  Design note #1074: THE STREAM IS ALREADY PLAYING when the slider moves, so setting a variable would leave
 *  the player dragging a control that does nothing until the next track. `duckTarget` is the same handle the
 *  ducking uses, which is why this reaches through it rather than holding an element of its own. */
export function setRadioVolume(value: number): void {
  radioVolume = clampVolume(value);
  if (duckDepth === 0) duckTarget?.setVolume(radioVolume);
}
function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Start playback and swallow every reason it might not.
 *
 *  Design note #1009: `play()` RETURNS A PROMISE ON MODERN ENGINES AND `undefined` ELSEWHERE -- including
 *  jsdom, where the whole media stack is unimplemented. `void element.play().catch(...)` would throw on the
 *  `.catch` of `undefined` and take the render with it, so the result is checked before it is chained.
 *  THE CATCH IS SILENT BY DESIGN. Autoplay refusal is the expected case before the player's first click, not
 *  a fault, and there is nothing a player could do with the message. */
export function playQuietly(element: HTMLAudioElement): void {
  try {
    const started = element.play() as Promise<void> | undefined;
    if (started && typeof started.catch === "function") {
      started.catch(() => {
        /* Blocked, interrupted, or unsupported. Silence is the whole point. */
      });
    }
  } catch {
    /* Some engines throw synchronously rather than rejecting. Same answer. */
  }
}

/* ==================================================================
 *  DESIGN NOTE 1041: THE BED GETS OUT OF THE WAY
 * ==================================================================
 *
 * RULED: "The audio engine must 'duck' the volume of the in-game radio (dropping it to ~20%) whenever ANY
 * variant sound effect or turn-based train whistle plays, fading it back up smoothly when the clip ends."
 *
 * A MODULE-LEVEL REGISTRY RATHER THAN A PROP CHAIN, and that is the one design decision here worth arguing.
 * The radio lives in one hook and the effects fire from three unrelated places -- the whistle's edge, the
 * variant cue on a dispatch, and whatever comes next. Threading a ducking callback from the radio down to
 * each of them would make every caller know about the radio, which is exactly the coupling that ends with
 * two of them forgetting. The radio REGISTERS itself as duckable; anything that makes a noise asks for a
 * duck and is handed a release. Neither side knows the other exists.
 *
 * REFERENCE-COUNTED, because the concurrency limit below permits overlap. Two effects playing together must
 * duck once and restore once, and the second one ending must not raise the bed while the first is still
 * sounding -- a plain boolean would do exactly that. The count is what makes "fading it back up when the
 * clip ends" mean "when the LAST clip ends".
 *
 * THE FADE IS A TIMER, NOT A TRANSITION. `HTMLMediaElement.volume` is a plain property with no CSS behind
 * it, so a smooth return has to be stepped. Down is immediate and up is gradual, which is the shape every
 * broadcast ducking uses and the right one here: the point is to hear the effect NOW, and to not notice the
 * music returning. */

/** How far the bed drops while anything else is playing -- the ruled "~20%". */
/* ==================================================================
    DESIGN NOTE 1073: TWO DEPTHS, BECAUSE THE CLIPS ARE TWO KINDS OF THING
   ==================================================================
   REPORTED, after the effects were normalised: "The volume normalization of the sound effects has made the
   audio ducking perhaps unnecessary: they are considerably louder than the radio now." And, when asked:
   "I'd only duck 80% since the sound effects really are much louder than the radio stream without it. EXCEPT
   ... on the yellow sign and carcosa videos, where indeed the 20% duck for the extended play makes sense."
   AND THAT IS THE DISTINCTION THE ONE CONSTANT WAS PAPERING OVER. A coin clink is half a second: at the new
   levels it carries over the bed on its own, and dropping the radio to a fifth for it is a hole a listener
   hears open and close. The Yellow Sign's video runs ten seconds with its own dialogue -- there the bed is a
   competitor, not a backdrop, and the deep duck is what #1045 added it for.
   NAMED FOR THE CLIP, NOT FOR THE NUMBER. `DUCK_FOR_CUE` and `DUCK_FOR_VIDEO` say which situation each is
   for; `DUCKED_RADIO_VOLUME` said only that something was ducked, which is why one value ended up serving
   two cases that wanted different ones. */
/* Design note #1074: FRACTIONS, NOT LEVELS. These were `RADIO_VOLUME * 0.8` and `* 0.2`, computed once at
   module load -- which was right while the bed had one fixed level and silently wrong the moment a slider
   could move it: a player who turned the radio down to 0.1 would have had it DUCKED UP to 0.36. A duck is a
   proportion of whatever the bed is currently at. */
export const DUCK_FOR_CUE = 0.8;
export const DUCK_FOR_VIDEO = 0.2;
/** Total time the bed takes to come back, and the step between adjustments. */
export const DUCK_FADE_MS = 900;
const DUCK_FADE_STEP_MS = 60;

type DuckTarget = { setVolume: (value: number) => void };

let duckTarget: DuckTarget | null = null;
let duckDepth = 0;
/** Design note #1073: the level currently being held, so overlapping clips of different depths compose. */
let activeDuck = 1;
let fadeTimer: ReturnType<typeof setInterval> | null = null;

/** The radio calls this once; anything that plays a sound never has to know it happened. */
export function registerDuckTarget(target: DuckTarget | null): void {
  duckTarget = target;
  if (target === null) {
    duckDepth = 0;
    if (fadeTimer !== null) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }
}

function stopFade(): void {
  if (fadeTimer === null) return;
  clearInterval(fadeTimer);
  fadeTimer = null;
}

/** Duck now; the returned function releases this hold. Safe to call when nothing is registered. */
export function duckRadio(depth: number = DUCK_FOR_CUE): () => void {
  duckDepth += 1;
  stopFade();
  /* Design note #1073: THE DEEPEST DUCK IN FLIGHT WINS. Two overlapping clips -- a coin clink during the
     Carcosa video -- must not have the shallow one raise the bed back over the video's dialogue, so the
     level is the minimum of what has been asked for rather than the most recent request. */
  activeDuck = Math.min(activeDuck, depth);
  duckTarget?.setVolume(radioVolume * activeDuck);

  let released = false;
  return () => {
    /* IDEMPOTENT, because a release can arrive twice: once from the clip ending and once from a cleanup on
       unmount. A second decrement would take the count negative and leave the bed ducked forever. */
    if (released) return;
    released = true;
    duckDepth = Math.max(0, duckDepth - 1);
    if (duckDepth > 0) return;

    const from = radioVolume * activeDuck;
    const distance = radioVolume - from;
    // Design note #1073: the floor resets once nothing is ducking, so the next clip starts from its own depth.
    activeDuck = 1;
    const steps = Math.max(1, Math.round(DUCK_FADE_MS / DUCK_FADE_STEP_MS));
    let step = 0;
    stopFade();
    fadeTimer = setInterval(() => {
      step += 1;
      /* A NEW DUCK DURING THE FADE cancels it -- `duckRadio` calls `stopFade` and slams the volume back
         down, so this interval is already cleared before the next tick. The guard is for the frame in
         between. */
      if (duckDepth > 0) {
        stopFade();
        return;
      }
      const next = step >= steps ? radioVolume : from + (distance * step) / steps;
      duckTarget?.setVolume(next);
      if (step >= steps) stopFade();
    }, DUCK_FADE_STEP_MS);
  };
}

/** How many effect clips may sound at once.
 *
 *  Design note #1041: RULED as "graceful handling of overlapping triggers using a debounce or concurrency
 *  limit", and a limit is the right one of the two. A debounce DROPS the second event, and these clips are
 *  the game telling a player what just happened -- silence would be the feature failing quietly. A limit
 *  keeps the first three and drops only the fourth, which is a wall of noise nobody could parse anyway. */
export const MAX_CONCURRENT_SFX = 3;

let liveSfx = 0;

/** Play a one-shot with ducking and a concurrency cap. `enabled` is the SFX mute, checked here so every
 *  caller gets it for free rather than each remembering.
 *
 *  Design note #1041: THE ELEMENT IS BUILT PER CALL, unlike `useSoundEffect`'s single reused one. These
 *  clips are chosen per event out of fifty-odd files, so there is no stable `src` to hold -- and two
 *  different sounds overlapping is the case the concurrency limit exists to allow. */
export function playVariantCue(file: string, enabled: boolean): void {
  if (!enabled) return;
  if (liveSfx >= MAX_CONCURRENT_SFX) return;

  let element: HTMLAudioElement;
  try {
    element = new Audio(`/audio/${file}`);
  } catch {
    /* jsdom and any engine without a media stack. Nothing to play and nothing to duck. */
    return;
  }
  element.volume = sfxVolume;

  liveSfx += 1;
  const release = duckRadio();
  const done = () => {
    liveSfx = Math.max(0, liveSfx - 1);
    release();
  };
  element.addEventListener("ended", done, { once: true });
  element.addEventListener("error", done, { once: true });
  /* A CLIP THAT NEVER FIRES `ended` -- a 404, a codec the engine will not decode -- would hold the bed down
     for the rest of the session. The timer is the backstop, generous enough not to cut a real clip short. */
  window.setTimeout(done, 15000);
  playQuietly(element);
}

/** A short sound effect, ready to fire repeatedly.
 *
 *  Returns a stable `play` callback. `enabled` is read through a ref rather than closed over, so muting does
 *  not rebuild the callback -- an effect keyed on a changing function identity is how a one-shot ends up
 *  firing twice. */
export function useSoundEffect(src: string, enabled: boolean): () => void {
  const elementRef = useRef<HTMLAudioElement | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const element = new Audio(src);
    element.preload = "auto";
    /* Design note #1013: written down rather than left to the default, so both sides of the mix live
       together. Design note #1105: this is the SEED only -- the live level is applied at play time, because
       this element outlives every move of the slider. */
    element.volume = sfxVolume;
    elementRef.current = element;
    return () => {
      element.pause();
      elementRef.current = null;
    };
  }, [src]);

  return useCallback(() => {
    if (!enabledRef.current) return;
    const element = elementRef.current;
    if (!element) return;
    /* Design note #1041: the whistle ducks too -- ruled as "ANY variant sound effect OR turn-based train
       whistle". Released on `ended` rather than after a fixed delay so the bed comes back when the sound
       actually finishes, and on `error` so a missing file cannot hold it down. */
    const release = duckRadio();
    element.addEventListener("ended", release, { once: true });
    element.addEventListener("error", release, { once: true });
    window.setTimeout(release, 15000);
    /* ==================================================================
        DESIGN NOTE 1105: THE SLIDER DID NOT REACH THIS SOUND
       ==================================================================
       REPORTED: "the SFX are absolutely crazy loud. I don't think the volume slider is actually adjusting
       their volume: at 5% it sounds just as loud as 100%."
       AND IT WAS EXACTLY THIS ELEMENT. `playVariantCue` builds a fresh `Audio` per call and sets the level on
       it, so every cue has always taken the live figure -- verified rather than assumed. This hook builds its
       element ONCE, in an effect keyed on `[src]`, and set the volume there. So the whistle kept whatever
       `sfxVolume` happened to be at mount -- the `SFX_VOLUME` default of 1, full scale -- for the life of the
       page, and the slider moved a number that never reached it again.
       THE WHISTLE IS THE SOUND A PLAYER HEARS MOST, once per turn for the whole game, which is why "the SFX"
       read as uniformly loud even though the cues were obeying the control.
       SO THE LEVEL IS SET AT PLAY TIME, matching `playVariantCue`. The element is still built once -- #1009's
       reason for that stands, and rebuilding it per play is what this hook exists to avoid. Only the read
       moved, from mount to use. */
    element.volume = sfxVolume;
    /* REWOUND BEFORE EVERY PLAY. A second turn arriving while the first whistle is still sounding would
       otherwise be silent -- `play()` on an already-playing element is a no-op, so the notification for the
       event the player actually needs to hear is the one that gets swallowed. */
    element.currentTime = 0;
    playQuietly(element);
  }, []);
}

export interface RadioStream {
  /** Whether the stream is currently meant to be playing. */
  playing: boolean;
  /** Start it if stopped, stop it if playing. */
  toggle: () => void;
}

/** The background station.
 *
 *  ==================================================================
 *   DESIGN NOTE 1009: PAUSED IS NOT STOPPED, AND FOR A LIVE STREAM THAT MATTERS
 *  ==================================================================
 *
 *  REQUESTED: "Browsers block autoplay. The music stream should default to paused until the user clicks the
 *  music toggle to start it." -- so `playing` starts `false` and nothing touches the network until a click.
 *
 *  THE STOP CLEARS THE SOURCE, WHICH A PAUSE ALONE WOULD NOT. `pause()` on a live stream leaves the
 *  connection open and the buffer filling, so a player who stops for ten minutes and starts again resumes ten
 *  minutes behind the broadcast -- and has been downloading the whole time. Dropping `src` and calling
 *  `load()` closes the socket; the next start re-attaches it and arrives live.
 *
 *  THE ELEMENT IS BUILT ONCE AND NOT ON EVERY TOGGLE, so the mount effect owns its teardown. Constructing a
 *  fresh `Audio` per start would leak one element per click into whatever the browser keeps them in. */
export function useRadioStream(url: string): RadioStream {
  const elementRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const element = new Audio();
    // Nothing is fetched until a `src` is attached, which is the autoplay-safe default stated as a property.
    element.preload = "none";
    /* Design note #1013: the bed sits UNDER the whistle. Set on the element rather than at each `play()`, so a
       stop-and-start does not quietly come back at full volume. */
    // Design note #1074: the current level, not the default -- a reconnect must not undo the slider.
    element.volume = radioVolume;
    elementRef.current = element;
    /* Design note #1041: the bed announces itself as duckable. Nothing that plays a sound has to know the
       radio exists, and the radio does not have to know what is playing. */
    registerDuckTarget({
      setVolume: (value) => {
        element.volume = value;
      },
    });
    return () => {
      registerDuckTarget(null);
      element.pause();
      element.removeAttribute("src");
      element.load();
      elementRef.current = null;
    };
  }, []);

  const toggle = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    setPlaying((wasPlaying) => {
      if (wasPlaying) {
        element.pause();
        element.removeAttribute("src");
        element.load();
        return false;
      }
      element.src = url;
      playQuietly(element);
      return true;
    });
  }, [url]);

  return { playing, toggle };
}

/** Sound the whistle on the EDGE into the player's turn.
 *
 *  ==================================================================
 *   DESIGN NOTE 1009: "CHANGES TO YOUR TURN" IS AN EDGE, NOT A LEVEL
 *  ==================================================================
 *
 *  REQUESTED: "fire exactly once when the game state changes to 'Your Turn' (the exact same state that
 *  triggers the visual tab alerts)."
 *
 *  `isMyTurn` IS A LEVEL and it is recomputed on every poll -- roughly once a second, from a `gameState`
 *  object replaced wholesale each time. An effect that fired whenever it was `true` would whistle on every
 *  tick of the player's turn; one keyed on `[isMyTurn]` would be close but would re-fire on a remount. So the
 *  previous value is held in a ref and the sound is bound to the TRANSITION.
 *
 *  THE SEED IS `false`, DELIBERATELY, which means a page loaded during your own turn DOES whistle: the first
 *  resolved poll takes `isMyTurn` from `false` to `true`, which is a real edge for a player who has just
 *  arrived and has not been told. Seeding from the first observed value would silence exactly that case.
 *
 *  THE MUTE IS CHECKED INSIDE `play`, NOT HERE, so muting mid-turn does not count as an edge and unmuting
 *  does not replay one. The ref that carries it is `useSoundEffect`'s, for that reason. */
export function useTurnWhistle(isMyTurn: boolean, enabled: boolean): void {
  const play = useSoundEffect(WHISTLE_SRC, enabled);
  const wasMyTurn = useRef(false);

  useEffect(() => {
    if (isMyTurn && !wasMyTurn.current) play();
    wasMyTurn.current = isMyTurn;
  }, [isMyTurn, play]);
}

