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
    elementRef.current = element;
    return () => {
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
