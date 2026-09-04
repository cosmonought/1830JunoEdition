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
// THE PRESIDENCY GUARD IS SHOWN AND NOT OFFERED. Reported: "Auto-Pass should never allow a player to lose the
// presidency of a corporation -- that should be something they manually choose to do." It was a third checkbox
// in the first draft, which was a mistake of category: a checkbox asks a player to consent to an outcome the
// rules of the feature say cannot happen. It is now stated in the same list, in the same voice, with no box --
// so a player still LEARNS it here, which was the only thing the checkbox was doing well.
//
// See docs/ai_architecture/state_machine.md, AutoPassModal.tsx #717.

import React, { useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import {
  DEFAULT_AUTO_PASS_CONDITIONS,
  type AutoPassConditions,
} from "../utils/autoPass";

export interface AutoPassModalProps {
  open: boolean;
  /** Tickers whose presidency is already takeable. Non-empty means there is nothing to arm: see below. */
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

/* The wording is the feature. Each caption answers "what happens if I turn this OFF", because that is the
   question a player is actually asking and the one a positive label cannot answer. */
const ROWS: readonly Row[] = [
  {
    key: "saleInHeld",
    label: "Somebody sells a corporation I hold",
    caption:
      "A sale drops the price one row per share, so it costs you money whether or not you are President. Off, you will pass through other players dumping stock you own.",
  },
  {
    key: "saleInPresided",
    label: "Somebody sells a corporation I preside over",
    caption:
      "The narrower half of the same idea, for a player who wants to defend their own companies without hearing about every price move. Off with the first, you will pass through a run on your own corporation.",
  },
];

/* Not a row, because there is no choice attached to it. Rendered in the same rhythm as the toggles so it reads
   as part of the same list rather than as small print underneath one. */
const GUARANTEE = {
  label: "A presidency of mine could be taken",
  caption:
    "Always on. Auto-Pass stops while any rival is within one purchase of overtaking you, so losing a corporation stays a thing you choose rather than something a convenience does to you.",
};

export function AutoPassModal({
  open,
  initial,
  exposedPresidencies = [],
  onArm,
  onClose,
}: AutoPassModalProps) {
  const [conditions, setConditions] = useState<AutoPassConditions>(
    initial ?? DEFAULT_AUTO_PASS_CONDITIONS,
  );

  if (!open) return null;

  /* Design note #717: ARMING WITH BOTH TOGGLES OFF IS ALLOWED, and it is not a mistake to guard against. A
     player who wants to pass the rest of the round and hear only about a presidency is asking for something
     coherent -- they just get told, plainly, what they have asked for. */
  const anyOn = ROWS.some((row) => conditions[row.key]);

  /* REFUSED RATHER THAN ARMED-AND-INSTANTLY-STOPPED. The decision would decline on the player's very next turn
     anyway; showing that here, before the click, turns a confusing flicker into an explanation. */
  const exposed = exposedPresidencies.length > 0;

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
          Your turns will pass automatically until one of these happens, or until the Stock Round ends.
          Anything that wakes it also switches it off, so you keep the turn it woke you for.
        </p>

        <div style={styles.list}>
          <div style={styles.row}>
            <span style={styles.always} aria-hidden="true">
              &#10003;
            </span>
            <span style={styles.rowText}>
              <span style={styles.rowLabel}>{GUARANTEE.label}</span>
              <span style={styles.rowCaption}>{GUARANTEE.caption}</span>
            </span>
          </div>
          {ROWS.map((row) => (
            <label key={row.key} style={styles.row}>
              <input
                type="checkbox"
                checked={conditions[row.key]}
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

        {!anyOn && !exposed && (
          <p style={styles.warning}>
            With both toggles off, you will pass every remaining turn this Stock Round unless one of your
            presidencies comes under threat.
          </p>
        )}

        {exposed && (
          <p style={styles.warning}>
            {exposedPresidencies.join(", ")} could be taken on the next purchase, so there is nothing here to
            stand in for: play the turn yourself.
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
                ? "A presidency of yours is one purchase from changing hands — Auto-Pass will not stand in for that turn."
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
  /* Where a checkbox would be, at a checkbox's width, so the three lines share one text margin. Green and
     inert: it is a statement of what the feature does, not a control. */
  always: {
    marginTop: "1px",
    flex: "none",
    width: "13px",
    textAlign: "center",
    color: "#6fbf8b",
    fontSize: FONT_SIZE.micro,
  },
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
