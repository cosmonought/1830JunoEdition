// frontend/src/components/AutoModePicker.tsx
//
/* ==================================================================
    DESIGN NOTE 1444: ONE "AUTO" BUTTON, ONE MODAL, TWO MODES
   ==================================================================
   RULED: "combine Auto-Pass and Auto-Buy into a single modal where players choose which they want to automate
   (cannot do both)." The action bar now carries one Auto button; it opens the Auto-Pass or the Auto-Buy
   settings, and THIS strip at the top of either lets the player switch to the other. Arming one disarms the
   other (`App.tsx`), so the bar's armed label -- "Auto-Pass: On" / "Auto-Buy: On" -- is always singular.
   The two settings bodies stay as they were: they ask different questions and a merged form would have
   been two forms with a divider. */

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";

export type AutoMode = "pass" | "buy";

export function AutoModePicker({ mode, onSwitch }: { mode: AutoMode; onSwitch: (mode: AutoMode) => void }) {
  const option = (value: AutoMode, label: string, hint: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      style={{ ...styles.option, ...(mode === value ? styles.optionOn : {}) }}
      onClick={() => onSwitch(value)}
      title={hint}
      data-testid={`auto-mode-${value}`}
    >
      {label}
    </button>
  );
  return (
    <div style={styles.strip} role="tablist" aria-label="What to automate">
      {option("pass", "Auto-Pass", "Pass your Stock Round turns until something you care about happens.")}
      {option("buy", "Auto-Buy", "Buy one share of a corporation on your list on each of your turns.")}
      <span style={styles.note}>One or the other — not both.</span>
    </div>
  );
}

export default AutoModePicker;

const styles: Record<string, React.CSSProperties> = {
  strip: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
  option: {
    padding: "5px 14px",
    borderRadius: RADIUS.pill,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#8a8a86",
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    cursor: "pointer",
  },
  optionOn: { borderColor: "#c9a227", color: "#f0dfa8", backgroundColor: "#2a2410" },
  note: { marginLeft: "auto", fontSize: FONT_SIZE.micro, color: "#8a8a86", fontStyle: "italic" },
};
