// frontend/src/components/AutoPassModal.tsx
//
// The three conditions that cancel a standing pass.
//
// Design note #717: A MODAL, BECAUSE ARMING IS A DECISION AND NOT A MODE.
//
// REQUESTED: "players should be able to toggle these conditions on/off, when they click Auto-Pass a modal
// could pop up asking them to do so."
//
// Right, and for a reason worth stating: this is the one control in the app that acts on the player's behalf
// while they are not looking. Every other panel is answered by somebody watching the board. A setting that
// silently decided several turns would be the worst possible thing to bury behind a gear icon, so the
// conditions are put in front of the player at the moment they arm it, every time.
//
// AND EVERY LINE SAYS WHAT IT COSTS. A toggle labelled "sales" tells a player nothing about what they will
// sleep through; the captions name the situation each switch is protecting against.
//
// THE PRESIDENCY GUARD WAS SHOWN AND NOT OFFERED (#717): "Auto-Pass should never allow a player to lose the
// presidency of a corporation". Design note #1335 (T05 20, ruled 8 September) makes it the FIRST TOGGLE, on by
// default: a player may let a tied presidency ride if they choose to. While it is on and a presidency is
// exposed, Start is refused and the switch is named as the way past.
//
// ONE SENTENCE PER LINE (8 September): "really simplify the Auto-Pass toggle descriptions to one sentence max."
// Each caption says what wakes you, and nothing else.
//
// See docs/ai_architecture/state_machine.md, AutoPassModal.tsx #717.

import React, { useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import {
  DEFAULT_AUTO_PASS_CONDITIONS,
  guardsPresidency,
  type AutoPassConditions,
} from "../utils/autoPass";

export interface AutoPassModalProps {
  open: boolean;
  /** Tickers whose presidency is already takeable. Non-empty refuses Start while the presidency switch is on. */
  exposedPresidencies?: readonly string[];
  /** What the player chose last time, so re-arming does not re-ask from scratch. */
  initial?: AutoPassConditions;
  onArm: (conditions: AutoPassConditions) => void;
  onClose: () => void;
}

interface Row {
  key: keyof AutoPassConditions;
  label: string;
  caption: string;
}

/* One sentence each: what wakes you. */
const ROWS: readonly Row[] = [
  {
    key: "presidencyThreatened",
    label: "A presidency of mine could be taken",
    caption: "A rival is one purchase from taking a corporation you preside over.",
  },
  {
    key: "saleInHeld",
    label: "Somebody sells a corporation I hold",
    caption: "Shares are sold into the pool of a corporation you own shares in.",
  },
  {
    key: "saleInPresided",
    label: "Somebody sells a corporation I preside over",
    caption: "Shares are sold into the pool of a corporation you are President of.",
  },
];

export function AutoPassModal({
  open,
  initial,
  exposedPresidencies = [],
  onArm,
  onClose,
}: AutoPassModalProps) {
  const [conditions, setConditions] = useState<AutoPassConditions>({
    ...DEFAULT_AUTO_PASS_CONDITIONS,
    ...(initial ?? {}),
  });

  if (!open) return null;

  const checked = (key: keyof AutoPassConditions) =>
    key === "presidencyThreatened" ? guardsPresidency(conditions) : conditions[key] === true;
  const anyOn = ROWS.some((row) => checked(row.key));

  /* #1335: refused only while the presidency switch is ON -- off, the player has said they will let it ride. */
  const exposed = exposedPresidencies.length > 0 && guardsPresidency(conditions);

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Auto-Pass conditions"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={styles.card}>
        <div style={styles.header}>
          <span style={styles.heading}>Auto-Pass this Stock Round</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close">
            &#10006;
          </button>
        </div>

        <p style={styles.body}>
          Your turns pass automatically until one of these wakes you, or the Stock Round ends.
        </p>

        <div style={styles.list}>
          {ROWS.map((row) => (
            <label key={row.key} style={styles.row}>
              <input
                type="checkbox"
                checked={checked(row.key)}
                onChange={(event) =>
                  setConditions((current) => ({ ...current, [row.key]: event.target.checked }))
                }
                style={styles.checkbox}
              />
              <span style={styles.rowText}>
                <span style={styles.rowLabel}>{row.label}</span>
                <span style={styles.rowCaption}>{row.caption}</span>
              </span>
            </label>
          ))}
        </div>

        {!anyOn && (
          <p style={styles.warning}>With everything off, you will pass every remaining turn this Stock Round.</p>
        )}

        {exposed && (
          <p style={styles.warning}>
            {exposedPresidencies.join(", ")} could be taken on the next purchase; play the turn yourself, or
            switch off the first toggle to pass anyway.
          </p>
        )}

        <div style={styles.footer}>
          <button type="button" style={styles.secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={{ ...styles.primaryButton, ...(exposed ? styles.primaryButtonDisabled : {}) }}
            onClick={() => onArm(conditions)}
            disabled={exposed}
            title={
              exposed
                ? "A presidency of yours is one purchase from changing hands."
                : "Pass automatically until one of the conditions above, or the end of this Stock Round."
            }
          >
            Start Auto-Pass
          </button>
        </div>
      </div>
    </div>
  );
}

export default AutoPassModal;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 3600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
  },
  card: {
    width: "min(520px, 100%)",
    maxHeight: "84vh",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "18px 20px",
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#0f0f0f",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
    color: "#f2f0eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
  heading: { fontSize: FONT_SIZE.strong, fontWeight: 800 },
  closeButton: {
    background: "none",
    border: "none",
    color: "#8a8a86",
    cursor: "pointer",
    fontSize: FONT_SIZE.body,
    lineHeight: 1,
  },
  body: { fontSize: FONT_SIZE.small, color: "#c8c6c0", lineHeight: 1.45, margin: 0 },
  list: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" },
  row: { display: "flex", flexDirection: "row", gap: "10px", cursor: "pointer" },
  checkbox: { marginTop: "3px", flex: "none" },
  rowText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  rowLabel: { fontSize: FONT_SIZE.small, fontWeight: 700 },
  /* The consequence, in the muted note ink the rest of the app uses for a reason attached to a control. */
  rowCaption: { fontSize: FONT_SIZE.micro, color: "#8a8a86", lineHeight: 1.4 },
  /* Amber, not red: an unconditional pass is a legal thing to ask for, and colouring it as an error would
     argue with a player who meant it. */
  warning: {
    fontSize: FONT_SIZE.micro,
    color: "#e0b062",
    lineHeight: 1.4,
    margin: "2px 0 0",
  },
  footer: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "6px" },
  secondaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    fontSize: FONT_SIZE.small,
    cursor: "pointer",
  },
  primaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
  primaryButtonDisabled: {
    borderColor: "#3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#6e6c68",
    cursor: "not-allowed",
  },
};
