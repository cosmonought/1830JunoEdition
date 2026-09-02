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
  };
}

export function AudioControls({ audio }: AudioControlsProps) {
  /* Design note #1075: which panel is open, and #1094's owner ref -- both moved here with the markup they
     serve. Held per instance, so the waiting room's control and the bar's never share a disclosure. */
  const [openPanel, setOpenPanel] = React.useState<"radio" | "sfx" | null>(null);
  const audioGroup = React.useRef<HTMLSpanElement | null>(null);

  return (
      /* Design note #1075: `position: relative` so the popover hangs from the group rather than from the
         viewport -- the bar scrolls with the header on a narrow window, and a fixed panel would part
         company with the button that opened it. */
      <span ref={audioGroup} style={{ ...styles.topBarAudioGroup, position: "relative" }}>
        <button
          type="button"
          style={{
            ...styles.topBarIconButton,
            ...(audio.musicPlaying ? styles.topBarIconButtonOn : {}),
          }}
          /* Design note #1075: THE CLICK OPENS THE PANEL, it no longer toggles. Off lives inside, which is
             what lets the dim mean one thing -- see the component's own note for why the two jobs could not
             share a control. With no volume wiring the button falls back to being a plain toggle. */
          onClick={() =>
            audio.onRadioVolume
              ? setOpenPanel((current) => (current === "radio" ? null : "radio"))
              : audio.onToggleMusic()
          }
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
        <button
          type="button"
          style={{
            ...styles.topBarIconButton,
            ...(audio.sfxEnabled ? styles.topBarIconButtonOn : {}),
          }}
          onClick={() =>
            audio.onSfxVolume
              ? setOpenPanel((current) => (current === "sfx" ? null : "sfx"))
              : audio.onToggleSfx()
          }
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
