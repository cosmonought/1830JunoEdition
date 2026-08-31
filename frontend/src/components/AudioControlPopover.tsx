// frontend/src/components/AudioControlPopover.tsx
//
// A volume, an off switch, and — for the effects — what counts as an effect.
//
// ==================================================================
//  DESIGN NOTE 1075: THE BUTTON STOPS BEING A TOGGLE AND BECOMES A DOOR
// ==================================================================
//
// ASKED FOR, with the conflict spotted in the asking: "volume controls on both Radio and SFX ... when players
// click the button they get a volume slider. But this conflicts with the play/mute behavior and the dimming I
// just argued for ... so maybe we should have it that players get a volume slider and an Off toggle when they
// click them, and if they click the Off/X/whatever the button dims."
//
// AND THAT RESOLUTION IS THE RIGHT ONE, because the dim is a STATE READOUT and a click is an ACTION. Trying
// to keep the click as a mute and add a slider means the same control both toggles and discloses; putting Off
// inside the popover leaves the button with one job (open this) and the dim with one meaning (this is off).
//
// TWO BUTTONS, NOT ONE, and I was asked for an opinion. The dim is exactly why: a single audio button can only
// show one state for two independent things, so with the radio off and the effects on it is either
// meaningless or misleading -- and the dim is the thing this batch opened by asking for. The radio is also a
// background stream a player flips casually, so burying it a click deeper costs more than the reclaimed
// space is worth.
//
// THE CATEGORIES ARE PLAIN ON/OFF, and that was a judgement rather than a shortcut. Four sliders is a mixing
// desk for a board game, and the categories differ in KIND: a player wants the turn whistle on, not at 60%.
// Per-category sliders are a small change from here if the toggles turn out too blunt.
//
// See docs/ai_architecture/ui_shell_layout.md, AudioControlPopover.tsx #1075.

import React, { useEffect, useRef } from "react";

import { FONT_SIZE } from "../styles/typography";

export interface AudioCategoryToggle {
  key: string;
  label: string;
  /** What this category actually covers, for the title attribute -- the names are ours, not the player's. */
  hint: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export interface AudioControlPopoverProps {
  /** "Radio" or "Sound effects" -- the popover names what it governs, because the icon alone does not. */
  title: string;
  /** 0..1. The slider is shown as a percentage; the model stays a fraction, like every volume in this app. */
  volume: number;
  onVolumeChange: (volume: number) => void;
  /** Whether this channel is on at all. Off dims the button that opened this. */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Empty for the radio; the three effect categories for SFX. */
  categories?: readonly AudioCategoryToggle[];
  onClose: () => void;
  /** ==================================================================
   *   DESIGN NOTE 1094: WHAT "OUTSIDE" MEANS
   *  ==================================================================
   *
   * The element wrapping BOTH the trigger button and this panel. The outside-click listener asks this rather
   * than the panel, so a press on the trigger is inside the disclosure and does not close it out from under
   * its own toggle -- see the listener for the two-event race that made the second click do nothing.
   *
   * OPTIONAL, FALLING BACK TO THE PANEL. A caller that renders this without a trigger of its own keeps the
   * old behaviour rather than losing outside-close entirely, which is the harmless direction. */
  owner?: React.RefObject<HTMLElement | null>;
}

export function AudioControlPopover({
  title,
  volume,
  onVolumeChange,
  enabled,
  onEnabledChange,
  categories = [],
  onClose,
  owner,
}: AudioControlPopoverProps) {
  const panel = useRef<HTMLDivElement | null>(null);

  /* ==================================================================
      DESIGN NOTE 1075: IT CLOSES ON ESCAPE AND ON A CLICK OUTSIDE, UNLIKE THE MODALS
     ==================================================================
     #1052 REMOVED BOTH FROM THE PAYOUT MODAL and the reasoning does not transfer. There the accidental
     dismissal cost the player the whole event -- the panel opens under the cursor at the start of a round and
     a stray click ate it. This opens because the player deliberately pressed a button, sits over nothing they
     are mid-way through, and every setting inside it is applied the instant it changes. There is nothing to
     lose by closing, so closing should be easy.
     `mousedown` RATHER THAN `click`, so a drag that starts on the slider and ends outside it does not close
     the panel mid-gesture -- which is exactly how a volume slider gets used. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    /* ==================================================================
        DESIGN NOTE 1094: THE TRIGGER WAS OUTSIDE, SO ITS CLICK CLOSED AND REOPENED
       ==================================================================
       REPORTED: "one click opens the menu, and a second click on the same icon closes it."
       THE TOGGLE WAS ALREADY WRITTEN CORRECTLY. `TopBar` does
       `setOpenPanel((current) => (current === "sfx" ? null : "sfx"))`, which is exactly the ruled behaviour.
       WHAT BEAT IT WAS THE ORDER OF TWO EVENTS. This listener is on `mousedown`; the toggle is on `click`,
       which fires after. So a second press on the icon ran: mousedown -> the icon is not inside the PANEL ->
       `onClose()` -> `openPanel` is now null; then click -> `current === "sfx"` is false -> reopen. The panel
       shut and reopened between two frames, which on screen is a control that does nothing.
       THE FIX IS TO ASK ABOUT THE RIGHT ELEMENT. "Outside" means outside the whole disclosure -- the trigger
       and its panel together -- not outside the panel alone. `owner` is the element wrapping both, so the
       trigger's press is now correctly inside, this listener ignores it, and the toggle that was always right
       gets to run.
       `mousedown` RATHER THAN `click` IS UNCHANGED and still deliberate: a drag that starts on the slider and
       ends outside must not close the panel mid-gesture, which is exactly how a volume slider gets used. */
    const onDown = (event: MouseEvent) => {
      const bounds = owner?.current ?? panel.current;
      if (!bounds) return;
      if (!bounds.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose, owner]);

  return (
    <div ref={panel} style={styles.panel} role="dialog" aria-label={`${title} settings`}>
      <div style={styles.title}>{title}</div>

      <label style={styles.volumeRow}>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(volume * 100)}
          /* ==================================================================
              DESIGN NOTE 1094: NOT DISABLED ANY MORE, WHICH REVERSES HALF OF #1075
             ==================================================================
             RULED: "if a player interacts with the volume slider while the master toggle is 'Off',
             automatically switch the state to 'On'."
             WHICH REQUIRES THE SLIDER TO BE REACHABLE. A `disabled` input fires no events at all -- no
             change, no click, no keyboard -- so there is no interaction to notice, and the rule could not be
             implemented without taking the attribute off. Named here rather than quietly dropped: #1075
             disabled it deliberately.
             #1075'S ACTUAL REASON IS UNHARMED. It argued against HIDING the slider -- "a slider that vanishes
             makes the panel change height under the cursor, and the level a player set is worth showing them
             even while the channel is silent". The slider still shows, still holds the level, and still looks
             inert while the channel is off; it is styled down rather than switched off.
             AND THE NEW BEHAVIOUR IS BETTER THAN THE OLD ONE ON #1075'S OWN TERMS. Reaching for the volume of
             a silent channel is an unambiguous request to hear it. Refusing the drag taught the player only
             that the control was dead; obeying it does what they asked in one gesture instead of two. */
          onChange={(event) => {
            onVolumeChange(Number(event.target.value) / 100);
            if (!enabled) onEnabledChange(true);
          }}
          style={{ ...styles.slider, ...(enabled ? {} : styles.sliderQuiet) }}
          aria-label={
            enabled ? `${title} volume` : `${title} volume — adjusting this turns ${title.toLowerCase()} on`
          }
        />
        <span style={styles.percent}>{Math.round(volume * 100)}%</span>
      </label>

      {/* ==================================================================
           DESIGN NOTE 1094: THE TOGGLE NAMES BOTH STATES NOW
          ==================================================================
          RULED: "clicking the red 'Off - click to restore' button must change it to a green 'On - click to
          turn off' state."
          IT ONLY EVER NAMED ONE. The off state said "Off — click to restore", which is a state and its
          action; the on state said "Off", which is neither -- it was a LABEL FOR THE BUTTON'S PURPOSE
          ("this is the off switch") sitting where the other state puts a description of the world. A control
          that reads "Off" while the sound is on is ambiguous in the worst available way, and the colour was
          carrying the whole distinction.
          SO BOTH HALVES SAY THE SAME TWO THINGS: what is true, then what a click does. Symmetric text, and
          the red/green pair is now confirming the sentence rather than substituting for it.
          `aria-pressed` STILL MEANS "off", unchanged from #1075 -- it is the same toggle with the same
          meaning, and a screen reader now gets the state from the label as well. */}
      <button
        type="button"
        style={{ ...styles.offRow, ...(enabled ? styles.offRowOn : styles.offRowActive) }}
        onClick={() => onEnabledChange(!enabled)}
        aria-pressed={!enabled}
        title={enabled ? `Turn ${title.toLowerCase()} off` : `Turn ${title.toLowerCase()} back on`}
      >
        <span style={styles.offGlyph} aria-hidden="true">
          {enabled ? "♪" : "✕"}
        </span>
        <span>{enabled ? "On — click to turn off" : "Off — click to restore"}</span>
      </button>

      {categories.length > 0 && (
        <div style={styles.categories}>
          {/* Design note #1075: the categories are a subdivision of the channel above them, so they grey out
              with it rather than offering choices that cannot take effect. */}
          {categories.map((category) => (
            <label
              key={category.key}
              style={{ ...styles.categoryRow, ...(enabled ? {} : styles.categoryRowMuted) }}
              title={category.hint}
            >
              <input
                type="checkbox"
                checked={category.enabled}
                disabled={!enabled}
                onChange={(event) => category.onChange(event.target.checked)}
                style={styles.checkbox}
              />
              <span>{category.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default AudioControlPopover;

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    top: "calc(100% + 8px)",
    right: 0,
    zIndex: 4200,
    minWidth: "196px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "10px 12px",
    borderRadius: "10px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1b1f28",
    boxShadow: "0 12px 30px rgba(0,0,0,0.6)",
    color: "#d8dce6",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    fontSize: FONT_SIZE.small,
    // The bar it hangs from is not a click-through surface; this panel is a real control and takes its clicks.
    textAlign: "left",
  },
  title: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#8a90a0",
  },
  volumeRow: { display: "flex", alignItems: "center", gap: "8px" },
  slider: { flex: "1 1 auto", minWidth: 0, cursor: "pointer" },
  percent: {
    minWidth: "38px",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    color: "#aab3c4",
    flex: "none",
  },
  offRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 8px",
    borderRadius: "7px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#c8cdd8",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  /* Design note #1075: the Off row LIT means the channel is off -- the same inversion the button in the bar
     shows by dimming, so the two never disagree about which state is which. */
  offRowActive: { borderColor: "#8a4a4a", backgroundColor: "#3a1e1e", color: "#f0b8b8" },
  /** Design note #1094: the green half of the pair, built as the red one's mirror -- same three properties,
   *  same relationship to the panel ink, so neither state reads as the styled one. */
  offRowOn: { borderColor: "#3f7a4f", backgroundColor: "#1b3324", color: "#a8ddb8" },
  /** Design note #1094: what `disabled` used to say, said with opacity instead. The control is live -- that
   *  is the point -- but a silent channel should not look like a loud one. */
  sliderQuiet: { opacity: 0.55 },
  offGlyph: { fontWeight: 800, flex: "none" },
  categories: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    paddingTop: "7px",
    borderTop: "1px solid #33303a",
  },
  categoryRow: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" },
  categoryRowMuted: { opacity: 0.45, cursor: "default" },
  checkbox: { flex: "none" },
};
