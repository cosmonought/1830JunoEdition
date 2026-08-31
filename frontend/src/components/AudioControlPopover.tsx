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
}

export function AudioControlPopover({
  title,
  volume,
  onVolumeChange,
  enabled,
  onEnabledChange,
  categories = [],
  onClose,
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
    const onDown = (event: MouseEvent) => {
      if (!panel.current) return;
      if (!panel.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

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
          /* Design note #1075: DISABLED WHEN OFF rather than hidden. A slider that vanishes makes the panel
             change height under the cursor, and the level a player set is worth showing them even while the
             channel is silent -- turning it back on should return to where they left it, not to a default. */
          disabled={!enabled}
          onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
          style={styles.slider}
          aria-label={`${title} volume`}
        />
        <span style={styles.percent}>{Math.round(volume * 100)}%</span>
      </label>

      {/* ---- Off ---- */}
      <button
        type="button"
        style={{ ...styles.offRow, ...(enabled ? {} : styles.offRowActive) }}
        onClick={() => onEnabledChange(!enabled)}
        aria-pressed={!enabled}
        title={enabled ? `Turn ${title.toLowerCase()} off` : `Turn ${title.toLowerCase()} back on`}
      >
        <span style={styles.offGlyph} aria-hidden="true">
          ✕
        </span>
        <span>{enabled ? "Off" : "Off — click to restore"}</span>
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
