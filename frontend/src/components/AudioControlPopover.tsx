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

import { FONT_SIZE, RADIUS } from "../styles/typography";

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
  /** ==================================================================
   *   DESIGN NOTE 1115: THE STATION PICKER, RADIO ONLY
   *  ==================================================================
   *
   * Optional and absent for the effects panel, which is what keeps this component one thing: the SFX side
   * has no station and would render an empty row for a concept it does not have.
   *
   * A `<select>` RATHER THAN A ROW OF PILLS, which was the other option offered. Four stations is already at
   * the edge of what a pill row can hold inside a 260px popover, and the list is the kind of thing that
   * grows -- a fifth station would wrap the row and a sixth would break it. A select also brings the
   * platform's own keyboard handling, its own scrolling on a phone, and a name every screen reader already
   * announces correctly, none of which a row of buttons gets for free. */
  stations?: readonly { id: string; name: string }[];
  stationId?: string;
  onStationChange?: (id: string) => void;
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
  stations,
  stationId,
  onStationChange,
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

      <div style={styles.volumeRow}>
        {/* ==================================================================
             DESIGN NOTE 1103: A SWITCH, NOT A ROW -- WHICH DROPS #1094'S VISIBLE TEXT
            ==================================================================
            ASKED FOR: "the on/off button [should] look like the usual on/off buttons ... my objection is
            the extra line, not the extra click." The boxed, worded button #1094 ruled on took a full row of
            its own; a switch on the volume row's own line removes that row rather than just restyling it.
            #1094'S REASON FOR VISIBLE TEXT WAS THAT COLOUR ALONE WAS AMBIGUOUS -- "On" and "Off" both needed
            to say what a click does, because the row's colour was the only other signal. A switch does not
            have that problem: position is a second, colour-independent signal (`aria-checked` gives a third,
            for assistive tech), so the sentence-per-state text this control's shape justified is no longer
            required to disambiguate it. The full sentence survives in `aria-label`/`title` per #1078 --
            dropped only from the visible face of the control, not from what a reader is told.
            GREEN AND RED, NOT GOLD. #1102's retheme repurposed gold/amber for "waiting on the player" --
            reusing it here for on/off would collide with that. `ACTION_GREEN` and `ALERT_CRITICAL_INK` are
            the app's one existing pair for exactly this affirmative/critical distinction, already solid
            fills elsewhere (`palette.ts`), so this switch introduces no new colour for the retheme to
            reconcile. */}
        {/* ==================================================================
             DESIGN NOTE 1104: THE SHAPE CARRIES IT, NOT THE COLOUR
            ==================================================================
            REPORTED: "I find the green/red toggle unintuitive for the On/Off audio. Can we use the standard
            'play' triangle and 'stop' square instead?"
            AND THE COMPLAINT IS ABOUT #1103'S ONE WEAK POINT. That note argued a switch needs no worded
            label because POSITION is a second signal beside colour -- true of a switch whose thumb visibly
            travels, and this one is 34px wide, so the travel is a few pixels and the fill was doing almost
            all the work. Green/red then has to be LEARNED: nothing about red says "press me to start".
            A TRANSPORT CONTROL IS NOT LEARNED. Play and stop are the most over-taught pair of glyphs there
            is, and they say what the CLICK DOES rather than what the state is -- which is the question a
            player actually has in front of a button.
            THE SEMANTICS ARE UNCHANGED, deliberately: `role="switch"` and `aria-checked` stay, because for
            assistive tech this is still a two-state control and #1078's rule is that state must reach it.
            The glyph is the affordance, `aria-checked` is the state, and the tooltip is the sentence. What
            was dropped is the COLOUR as a state channel, which is what the report was about.
            AND IT REMOVES A COLLISION #1103 WALKED INTO. Filling green for on put `ACTION_GREEN` -- the
            confirm/pay colour -- on a control that neither confirms nor pays. The transport button is
            neutral and borrows nothing. */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onEnabledChange(!enabled)}
          style={styles.audioTransport}
          aria-label={title}
          title={enabled ? `Turn ${title.toLowerCase()} off` : `Turn ${title.toLowerCase()} back on`}
        >
          {/* Design note #1074's rule, reused: drawn rather than typed. `&#9654;` and `&#9632;` are rendered
              by the emoji font on several platforms, which ignores `color` -- the exact defect that note
              fixed by replacing the speaker emoji with an SVG. */}
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            {enabled ? (
              <rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" />
            ) : (
              <path d="M3.5 2.2 10 6 3.5 9.8 Z" fill="currentColor" />
            )}
          </svg>
        </button>
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
      </div>

      {stations && stations.length > 0 && onStationChange && (
        /* Design note #1115: UNDER the transport row, as asked. It is not disabled while the radio is off --
           #1094 removed `disabled` from the slider for the same reason and the reasoning carries: choosing a
           station on a silent radio is an unambiguous statement about what should play, and the control
           should take it rather than teach the player it is dead. */
        <label style={styles.stationRow}>
          <span style={styles.stationLabel}>Station</span>
          <select
            style={styles.stationSelect}
            value={stationId}
            onChange={(event) => onStationChange(event.target.value)}
            aria-label="Radio station"
          >
            {stations.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </select>
        </label>
      )}

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
    minWidth: "210px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "10px 12px",
    /* Design note #1151: PROMOTED BY HAND. The sweep mapped each site from the value it already had, which
       preserves the original author's sense of scale -- but this surface was authored at the card step and is
       a floating layer by the rule, so the old value and the role disagreed. The role wins; that disagreement
       is exactly what the hand pass after the sweep is for. */
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    boxShadow: "0 12px 30px rgba(0,0,0,0.6)",
    color: "#f2f0eb",
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
    color: "#8a8a86",
  },
  /* Design note #1104: a transport button, sized to sit on the volume row beside the slider. Neutral by
     design -- the glyph is the signal, so this borrows no semantic colour. The lit treatment is the same
     `topBarIconButtonOn` pairing the trigger buttons use, so "on" reads the same on both surfaces. */
  stationRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginTop: "10px",
  },
  stationLabel: { fontSize: FONT_SIZE.micro, color: "#a8a6a0", flex: "none" },
  stationSelect: {
    flex: 1,
    minWidth: 0,
    fontSize: FONT_SIZE.small,
    fontFamily: "inherit",
    padding: "4px 6px",
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    cursor: "pointer",
  },
  audioTransport: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    width: "24px",
    height: "24px",
    padding: 0,
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
    cursor: "pointer",
  },
  volumeRow: { display: "flex", alignItems: "center", gap: "8px" },
  slider: { flex: "1 1 auto", minWidth: 0, cursor: "pointer" },
  percent: {
    minWidth: "38px",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    color: "#a8a6a0",
    flex: "none",
  },
  /** Design note #1103: track is the button itself -- fill carries the state, position (via the thumb's
   *  transform below) carries it a second way, and neither depends on the other. */
  /** Design note #1094: what `disabled` used to say, said with opacity instead. The control is live -- that
   *  is the point -- but a silent channel should not look like a loud one. */
  sliderQuiet: { opacity: 0.55 },
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
