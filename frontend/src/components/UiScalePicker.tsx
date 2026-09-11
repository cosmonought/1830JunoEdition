// frontend/src/components/UiScalePicker.tsx
//
// `Aa  −  100%  +` -- the one control a player reaches for before anything else on a screen that loads small.
//
// ==================================================================
//  DESIGN NOTE 1336: THE TEXT-SIZE CONTROL HAS TO BE FINDABLE AT THE SIZE IT FIXES
// ==================================================================
//
// REPORTED (item 0): "The zoom buttons are grayed out and hard to see on a screen that loads everything small.
// There is also no zoom feature on the home page/lobby screen, which should persist across a player's other
// screens."
//
// THE CONTROL WAS DRAWN IN THE PROBLEM IT SOLVES. #1273's stepper was two 18px buttons in the bar's own muted
// ink, the lower one disabled at the default -- and the bar is under the chrome zoom, so on the very screen
// where 0.63 draws everything at eight pixels, the way out was an eleven-pixel grey minus sign. A control that
// exists for readers who cannot read the chrome cannot be dressed like the chrome.
//
// SO: its own component, mounted in BOTH bars and the lobby's utility row, with a label ("Aa") that says what
// it is without words, full ink on a distinct plate, 24px targets, and the disabled end dimmed by half rather
// than to a third. The scale itself was already a per-browser preference (`localStorage`, #1273) read live by
// every surface (#1294) -- the lobby included -- so "persist across screens" was true and invisible; mounting
// the control where a player first arrives is what makes it a feature rather than a fact.

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { UI_SCALE_STEPS, setUiScale, snapUiScale } from "../utils/uiScale";
import { useUiScale } from "../utils/useUiScale";

export function UiScalePicker() {
  /* Design note #1294: live. The store re-renders every surface that draws with the scale; no reload, and
     the radio keeps playing. */
  const scale = useUiScale();
  const at = UI_SCALE_STEPS.indexOf(snapUiScale(scale));
  const choose = (index: number) => {
    setUiScale(UI_SCALE_STEPS[Math.min(UI_SCALE_STEPS.length - 1, Math.max(0, index))]);
  };
  const percent = `${Math.round(scale * 100)}%`;
  const atMin = at <= 0;
  const atMax = at >= UI_SCALE_STEPS.length - 1;
  return (
    <span style={styles.group} role="group" aria-label="Text size" title={`Text size ${percent}. Remembered by this browser on every screen.`}>
      <span style={styles.glyph} aria-hidden="true">
        Aa
      </span>
      <button
        type="button"
        style={{ ...styles.step, ...(atMin ? styles.stepDisabled : {}) }}
        onClick={() => choose(at - 1)}
        disabled={atMin}
        title="Draw everything smaller."
        aria-label="Smaller text"
      >
        −
      </button>
      <span style={styles.readout}>{percent}</span>
      <button
        type="button"
        style={{ ...styles.step, ...(atMax ? styles.stepDisabled : {}) }}
        onClick={() => choose(at + 1)}
        disabled={atMax}
        title="Draw everything larger."
        aria-label="Larger text"
      >
        +
      </button>
    </span>
  );
}

export default UiScalePicker;

const styles: Record<string, React.CSSProperties> = {
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    flexShrink: 0,
    padding: "2px 6px 2px 8px",
    borderRadius: RADIUS.control,
    border: "1px solid #4a4a4a",
    backgroundColor: "#1a1a1a",
    color: "#f2f0eb",
  },
  glyph: {
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    letterSpacing: "-0.02em",
    color: "#e0b062",
    marginRight: "2px",
  },
  step: {
    width: "24px",
    height: "24px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    borderRadius: RADIUS.control,
    border: "1px solid #5a5a5a",
    backgroundColor: "#303030",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.body,
    fontWeight: 800,
    lineHeight: 1,
    cursor: "pointer",
    flexShrink: 0,
  },
  stepDisabled: { opacity: 0.5, cursor: "not-allowed" },
  readout: {
    minWidth: "38px",
    textAlign: "center",
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    color: "#f2f0eb",
  },
};
