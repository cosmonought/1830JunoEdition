// frontend/src/components/AudioControls.tsx
//
// The radio and sound-effect buttons, and the panels they open.
//
// ==================================================================
//  DESIGN NOTE 1102: ONE AUDIO CONTROL, NOT ONE PER SCREEN
// ==================================================================
//
// REPORTED: "I'm not sure the audio button should behave one way in the Waiting Room and another in the
// Game. Shouldn't the volume popover continue on both?"
//
// AND THAT IS A FAIR CORRECTION OF #1101, which gave the waiting room a plain on/off toggle on the reasoning
// that volume and per-category switches do not belong on a screen whose job is to be left. The reasoning was
// fine and the premise was wrong: a player does not learn one audio control for the anteroom and a different
// one for the table. Consistency is the requirement; what the panel contains is a separate question.
//
// SO THE PAIR MOVES OUT OF `TopBar` RATHER THAN BEING COPIED. This block owns its own disclosure state and
// its own outside-click owner ref, which is exactly the shape that survives a move -- and a second
// hand-rolled copy in the waiting room would be a second chance to get `aria-expanded`, the #1094 owner ref,
// or #1078's label-carried state wrong. `TopBar` renders this; so does `SandboxWaitingRoom`.
//
// THE STYLES STAY IN `appStyles`, deliberately. Both call sites use the same `topBarIconButton` -- which is
// now a slightly inaccurate name for a control that appears in two places, and is left alone rather than
// renamed because a rename touches every consumer to no functional end. Recorded so the name is read as
// history rather than as a claim about where it may be used.
//
// See docs/ai_architecture/ui_shell_layout.md, AudioControls.tsx #1102.

import React from "react";

import { styles } from "../styles/appStyles";
import AudioControlPopover, { type AudioCategoryToggle } from "./AudioControlPopover";

export interface AudioControlsProps {
  audio: {
    musicPlaying: boolean;
    onToggleMusic: () => void;
    sfxEnabled: boolean;
    onToggleSfx: () => void;
    /** Design note #1075: the popover's contents. Optional so a shell that wires only the two toggles still
     *  renders -- the buttons then behave exactly as they did before that batch. */
    radioVolume?: number;
    onRadioVolume?: (volume: number) => void;
    sfxVolume?: number;
    onSfxVolume?: (volume: number) => void;
    sfxCategories?: readonly AudioCategoryToggle[];
    /** Design note #1115: the radio's station list and current pick. Optional like the volume wiring above,
     *  so a shell that supplies neither still renders the two buttons. */
    stations?: readonly { id: string; name: string }[];
    stationId?: string;
    onStationChange?: (id: string) => void;
  };
}

/** Design note #1106: the level a channel wakes at when it is turned on from silence. Half scale rather
 *  than the channel's own default, because this is not "restore the mix" -- it is the floor that stops an
 *  "on" that plays nothing. A player who had deliberately set a level keeps it; only zero is overridden. */
const WAKE_VOLUME = 0.5;

export function AudioControls({ audio }: AudioControlsProps) {
  /* Design note #1075: which panel is open, and #1094's owner ref -- both moved here with the markup they
     serve. Held per instance, so the waiting room's control and the bar's never share a disclosure. */
  const [openPanel, setOpenPanel] = React.useState<"radio" | "sfx" | null>(null);
  const audioGroup = React.useRef<HTMLSpanElement | null>(null);

  /* Design note #1120: resolved from the list rather than held as its own string, so the name beside the
     button and the row ticked inside the popover cannot disagree -- they are the same lookup on the same id.
     `null` where the shell has wired no stations, which is what keeps the single-stream case looking exactly
     as it did: one glyph, no label. */
  const currentStationName =
    audio.stations?.find((station) => station.id === audio.stationId)?.name ?? null;

  /* ==================================================================
      DESIGN NOTE 1127: CYCLING IS AN INDEX ON THE LIST, NOT A SECOND LIST
     ==================================================================
     Prev and Next are the same lookup #1120 already does, walked by one and WRAPPED -- so four stations are a
     ring rather than a line with two dead ends. A player who wants the first station back after the fourth
     presses Next once, which is what the `|<` `>|` pair promises on every device that has ever carried it.
     `-1` GUARDS THE UNWIRED SHELL. With no stations, or an id the list does not contain, `indexOf` is -1 and
     both handlers become no-ops rather than jumping to station 0 -- the buttons are not rendered in that case
     anyway, and a handler that quietly did something else would be worse than one that does nothing. */
  const stationList = audio.stations ?? [];
  const stationIndex = stationList.findIndex((station) => station.id === audio.stationId);
  const stepStation = React.useCallback(
    (delta: number) => {
      if (stationIndex < 0 || stationList.length === 0) return;
      const next = stationList[(stationIndex + delta + stationList.length) % stationList.length];
      audio.onStationChange?.(next.id);
    },
    [audio, stationIndex, stationList],
  );
  /* The transport row appears only where there is something to transport between. One station is the
     single-stream case #1120 protected, and prev/next on a list of one is two buttons that do nothing. */
  const showTransport = stationList.length > 1 && Boolean(audio.onStationChange);

  return (
      /* Design note #1075: `position: relative` so the popover hangs from the group rather than from the
         viewport -- the bar scrolls with the header on a narrow window, and a fixed panel would part
         company with the button that opened it. */
      <span ref={audioGroup} style={{ ...styles.topBarAudioGroup, position: "relative" }}>
        {/* ==================================================================
             DESIGN NOTE 1127: THE RADIO STOPS HIDING WHEN IT IS OFF
            ==================================================================
             #1120 SHOWED THE NAME ONLY WHILE PLAYING, on the reasoning that "a station name beside a dimmed
             button would be naming something that is not playing." THAT WAS TRUE AND IT WAS THE WRONG TRADE:
             ruled here as "it should remain permanently visible, even when playback is stopped, to serve as
             an ambient feature flag." A radio nobody can see is a radio nobody turns on, and the first thing
             a control has to do is exist. Naming a stopped station is a smaller cost than being invisible.
             THE STATE IS STILL CARRIED, by the button's dim and by #1078's label -- which is where it always
             actually lived. The name says WHICH; the button says WHETHER. Two facts, two elements, rather
             than one element trying to say both by disappearing.
             LEFT OF THE TRANSPORT, as asked, and that is also the reading order a media player has taught
             everyone: what is playing, then the controls for it. */}
        {currentStationName && (
          <span
            style={{
              ...styles.topBarStationName,
              ...(audio.musicPlaying ? {} : styles.topBarStationNameOff),
            }}
            title={audio.musicPlaying ? `Playing ${currentStationName}` : `${currentStationName} — radio is off`}
            aria-hidden="true"
          >
            {currentStationName}
          </span>
        )}
        {showTransport && (
          <button
            type="button"
            style={styles.topBarStationStep}
            onClick={() => stepStation(-1)}
            aria-label="Previous station"
            title="Previous station"
          >
            {/* `|<` and `>|` as paths rather than characters: the glyphs that look right here are in fonts
               that are not everywhere, and #1074's lesson is that a character you did not draw is a character
               you cannot style. `currentColor` so they grey with the row. */}
            <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
              <path d="M2 1v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M9 1L4 5l5 4z" fill="currentColor" />
            </svg>
          </button>
        )}
        <button
          type="button"
          style={{
            ...styles.topBarIconButton,
            ...(audio.musicPlaying ? styles.topBarIconButtonOn : {}),
          }}
          /* Design note #1075: THE CLICK OPENS THE PANEL, it no longer toggles. Off lives inside, which is
             what lets the dim mean one thing -- see the component's own note for why the two jobs could not
             share a control. With no volume wiring the button falls back to being a plain toggle. */
          /* ==================================================================
              DESIGN NOTE 1106: THE PRESS WAS ASYMMETRIC IN THE NOTE AND SYMMETRIC IN THE CODE
             ==================================================================
             ASKED FOR after a playtest: "the radio starts dimmed; the first press should turn it on AND open
             the slider." #1106 WROTE THAT DOWN AND NEVER WIRED IT -- `WAKE_VOLUME` sat in this file unused,
             which is how a constant declared for a behaviour proves the behaviour is missing. It surfaced
             while adding the station name (#1120), because a name shown only while playing is invisible when
             the first press does not start playback.
             ASYMMETRIC ON PURPOSE. Pressing a stopped radio starts it and opens the panel; pressing a playing
             one only opens the panel. Turning it OFF is the popover's transport button, which is the whole of
             #1075's argument -- one control, one meaning, and the dim then says exactly one thing.
             THE WAKE IS A FLOOR, NOT A RESTORE. Only a level of zero is overridden, so a player who chose a
             quiet radio gets their level back and a player who never touched it does not get silence. */
          onClick={() => {
            if (!audio.onRadioVolume) return audio.onToggleMusic();
            if (!audio.musicPlaying) {
              audio.onToggleMusic();
              if ((audio.radioVolume ?? 0) <= 0) audio.onRadioVolume(WAKE_VOLUME);
            }
            setOpenPanel((current) => (current === "radio" ? null : "radio"));
          }}
          aria-expanded={audio.onRadioVolume ? openPanel === "radio" : undefined}
          aria-pressed={audio.onRadioVolume ? undefined : audio.musicPlaying}
          /* ==================================================================
              DESIGN NOTE 1078: THE DIM HAS TO BE READABLE BY SOMETHING OTHER THAN AN EYE
             ==================================================================
             #1074 FIXED THE DIM FOR EYES AND BROKE IT FOR EVERYONE ELSE, which is a fault of mine that a
             test caught rather than a player: while these buttons were toggles, `aria-pressed` carried the
             on/off state to assistive tech exactly as the colour carried it to the eye. #1075 turned them
             into disclosure controls, so `aria-pressed` correctly became `aria-expanded` -- and the state
             it used to announce went nowhere. The `title` is not a substitute; it is announced
             inconsistently and not at all on touch.
             SO THE LABEL CARRIES IT. `aria-label` is announced on every platform, it is the one string
             these buttons already own, and naming the state in it restores the parity #1074 was about.
             THE OFF ROW INSIDE THE POPOVER KEEPS ITS `aria-pressed` -- that one IS a toggle -- so a reader
             who opens the panel gets the state twice rather than not at all. */
          aria-label={audio.musicPlaying ? "Radio settings" : "Radio settings — radio is off"}
          title={
            audio.musicPlaying
              ? "Radio — volume and off"
              : "Radio is off — click for volume and to turn it back on"
          }
        >
          {/* A note, not a speaker: this one is about MUSIC, and the speaker beside it is about the game. */}
          &#9835;
        </button>
        {showTransport && (
          <button
            type="button"
            style={styles.topBarStationStep}
            onClick={() => stepStation(1)}
            aria-label="Next station"
            title="Next station"
          >
            <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
              <path d="M1 1l5 4-5 4z" fill="currentColor" />
              <path d="M8 1v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <button
          type="button"
          style={{
            ...styles.topBarIconButton,
            ...(audio.sfxEnabled ? styles.topBarIconButtonOn : {}),
          }}
          /* Design note #1106: the same asymmetry, because the report named both buttons -- "this probably
             also applies to the SFX button". The one difference is that effects have no transport to start,
             so waking is only ever a volume floor. */
          onClick={() => {
            if (!audio.onSfxVolume) return audio.onToggleSfx();
            if (!audio.sfxEnabled) {
              audio.onToggleSfx();
              if ((audio.sfxVolume ?? 0) <= 0) audio.onSfxVolume(WAKE_VOLUME);
            }
            setOpenPanel((current) => (current === "sfx" ? null : "sfx"));
          }}
          aria-expanded={audio.onSfxVolume ? openPanel === "sfx" : undefined}
          aria-pressed={audio.onSfxVolume ? undefined : audio.sfxEnabled}
          /* Design note #1078: the same state in the same place, for the same reason. */
          aria-label={
            audio.sfxEnabled
              ? "Sound effect settings"
              : "Sound effect settings — sound effects are off"
          }
          title={
            audio.sfxEnabled
              ? "Sound effects — volume, off, and which effects play"
              : "Sound effects are off — click for volume and to turn them back on"
          }
        >
          {/* ==================================================================
               DESIGN NOTE 1074: AN EMOJI CANNOT BE DIMMED
              ==================================================================
              REPORTED: "when Radio is muted the button dims/grays out, when SFX is muted a barely
              perceptible slash mark goes through the icon. The dimming behavior is preferable."
              AND THE TWO BUTTONS ALREADY SHARED THEIR STYLES, which is what made this puzzling to read: the
              same `topBarIconButtonOn` lights both and the same base greys both. The difference was the
              GLYPH. `&#9835;` is a text character and takes the button's `color`, so it greys with it;
              `&#128266;` is an emoji, painted by the emoji font in its own colours, and CSS `color` does
              nothing to it. What the player read as a faint slash is the speaker's own artwork against a
              dimmed border.
              SO IT IS DRAWN RATHER THAN TYPED. An inline SVG on `currentColor` obeys the same rule the
              music note already did, and the two buttons now dim identically because they are finally the
              same kind of thing. */}
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M7.2 2.4 4 5.2H1.8v5.6H4l3.2 2.8z" />
            <path d="M10.1 5.1a3.6 3.6 0 0 1 0 5.8l-.9-1.1a2.2 2.2 0 0 0 0-3.6z" />
            <path d="M12.3 2.6a7 7 0 0 1 0 10.8l-.9-1.1a5.6 5.6 0 0 0 0-8.6z" />
          </svg>
        </button>
        {audio.onRadioVolume && openPanel === "radio" && (
          <AudioControlPopover
            title="Radio"
            volume={audio.radioVolume ?? 0}
            onVolumeChange={audio.onRadioVolume}
            enabled={audio.musicPlaying}
            onEnabledChange={audio.onToggleMusic}
            /* Design note #1115: THESE THREE WERE TYPED AND NEVER PASSED, which is why the picker was
               reported missing rather than broken -- the popover renders it only when it receives a list,
               so an unforwarded prop is an invisible feature. `tsc` cannot catch it: every one of them is
               optional, so omitting all three is a valid call. */
            stations={audio.stations}
            stationId={audio.stationId}
            onStationChange={audio.onStationChange}
            onClose={() => setOpenPanel(null)}
            owner={audioGroup}
          />
        )}
        {audio.onSfxVolume && openPanel === "sfx" && (
          <AudioControlPopover
            title="Sound effects"
            volume={audio.sfxVolume ?? 0}
            onVolumeChange={audio.onSfxVolume}
            enabled={audio.sfxEnabled}
            onEnabledChange={audio.onToggleSfx}
            categories={audio.sfxCategories}
            onClose={() => setOpenPanel(null)}
            owner={audioGroup}
          />
        )}
      </span>
  );
}

export default AudioControls;
