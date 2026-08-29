// frontend/src/components/FleetLossModal.tsx
//
// The trains that left while this corporation was not acting.
//
// Design note #896: THE INTERRUPTION IS THE FEATURE, so this modal has exactly ONE way out and it is an
// explicit button. There is no X, no backdrop click and no Escape -- the three ways a modal gets dismissed by
// a player who has not read it. A rust or a limit drop changes what a corporation can do with its whole turn.
//
// IT IS DISMISSIBLE, AND THE DISTINCTION IS NOT PEDANTRY. Reported against the first version of this file:
// "making the FleetLossModal completely unskippable is a soft-lock ... the player must be able to dismiss it
// to actually take their turn." Agreed, and it always could -- `onAcknowledge` has been the footer button
// since the first draft. What was wrong was THIS COMMENT, which described the modal by the three exits it
// removes and never mentioned the one it keeps, so it read as a modal with no way out at all.
// The lesson is the one this codebase keeps relearning from the other side: a note that states an intention
// ("unskippable") instead of the mechanism ("one exit, explicitly clicked") misleads even when the code is
// right. `EmergencyTrainPurchaseModal` #3 IS the genuinely blocking case -- it waits on a required game
// action, and this does not. Borrowing its vocabulary was the mistake.
//
// THE TOGGLE IS THE PRESSURE VALVE, and it is what makes an unskippable modal fair rather than hostile. A
// player who knows the rule can switch that notice off for that corporation and never see it again this
// session. What they cannot do is miss it by accident.
//
// AND THE ACTIVITY LOG IS NEVER SILENCED, which is the half that keeps this honest. #704's line is still
// written for every loss whatever the toggles say, so switching a notice off changes when the player finds
// out, not whether the game told them. The caption under the toggle says so, because a player deciding whether
// to silence something needs to know what they are giving up.
//
// See docs/ai_architecture/state_machine.md, FleetLossModal.tsx #896.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import {
  noticeBody,
  noticeConsequence,
  noticeGentleRustLine,
  noticeHeadline,
  silenceLabel,
  type FleetLossNotice,
} from "../utils/fleetLossNotice";

export interface FleetLossModalProps {
  /** The one notice being shown. `null` renders nothing -- notices queue and are shown one at a time. */
  notice: FleetLossNotice | null;
  /** Whether this cause is already silenced for this corporation, as the store has it on open. */
  silenced: boolean;
  onToggleSilence: (silenced: boolean) => void;
  /** Acknowledge and move on. The ONLY way out of this modal. */
  onAcknowledge: () => void;
}

export function FleetLossModal({
  notice,
  silenced,
  onToggleSilence,
  onAcknowledge,
}: FleetLossModalProps) {
  /* ==================================================================
      THE CHECKBOX IS LOCAL, AND IT HAS TO BE
     ==================================================================
     Ticking "don't notify me about this" makes the notice silenced, and a modal whose visibility is computed
     from the silence store would therefore CLOSE ITSELF the instant the player ticked the box -- before they
     had read the thing it was interrupting them for, and without their acknowledgement being recorded.
     So the box owns its own state and the write goes out to the store immediately; the caller mounts a fresh
     instance per notice (`key`), which is what re-seeds it. The player still leaves by the one button. */
  const [checked, setChecked] = React.useState(silenced);

  if (!notice) return null;

  return (
    /* NO `onClick` ON THE BACKDROP. Every other modal in this app closes on a backdrop click; this one must
       not, and the absence is deliberate enough to be worth a comment so a later tidy-up does not "restore"
       it for consistency. */
    <div style={styles.backdrop} role="alertdialog" aria-modal="true" aria-label={noticeHeadline(notice)}>
      <div style={styles.card}>
        <div style={styles.header}>
          {/* The cause, as a chip, so a player who has seen this before can classify it without reading. */}
          <span style={notice.cause === "rust" ? styles.chipRust : styles.chipLimit}>
            {notice.cause === "rust" ? "RUST" : "TRAIN LIMIT"}
          </span>
          <span style={styles.heading}>{noticeHeadline(notice)}</span>
        </div>

        <p style={styles.body}>{noticeBody(notice)}</p>
        {/* Design note #980: the gentle-rust line keeps the amber the consequence line used, which is what
            "keep the colored text" asks for -- the ruling is about the TREATMENT, not about which function
            produced the sentence. It renders in the consequence's slot because that is where a coloured
            second line already sat, so the card's rhythm is unchanged. */}
        {noticeGentleRustLine(notice) && (
          <p style={styles.consequence}>{noticeGentleRustLine(notice)}</p>
        )}
        {/* `null` for a rust notice (#980), and rendered conditionally rather than as an empty paragraph: an
            empty `<p>` still occupies its margins and reads as a sentence that failed to load. */}
        {noticeConsequence(notice) && (
          <p style={styles.consequence}>{noticeConsequence(notice)}</p>
        )}

        <div style={styles.fleetRow}>
          <span style={styles.fleetLabel}>Taken</span>
          <span style={styles.fleetTrains}>
            {notice.trains.map((model, at) => (
              // The index is in the key because a fleet may legitimately lose two trains of the same tier.
              <span key={`${model}-${at}`} style={styles.trainChip}>
                {model}
              </span>
            ))}
          </span>
        </div>

        <label style={styles.silenceRow}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => {
              setChecked(event.target.checked);
              onToggleSilence(event.target.checked);
            }}
            style={styles.checkbox}
          />
          <span style={styles.rowText}>
            <span style={styles.rowLabel}>{silenceLabel(notice)}</span>
            <span style={styles.rowCaption}>
              Stops this modal for this corporation and this kind of event, for the rest of this session. The
              Activity Log still records every loss, so nothing is hidden — you just find out there instead.
            </span>
          </span>
        </label>

        <div style={styles.footer}>
          <button type="button" style={styles.primaryButton} onClick={onAcknowledge} autoFocus>
            Continue to {notice.ticker}'s turn
          </button>
        </div>
      </div>
    </div>
  );
}

export default FleetLossModal;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* Above `AutoPassModal`'s 3600: a fleet loss is a blocking precondition of the turn and nothing may sit
       over it. */
    zIndex: 3800,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.82)",
  },
  card: {
    width: "min(520px, 100%)",
    maxHeight: "84vh",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "18px 20px",
    borderRadius: "12px",
    border: "1px solid #6a4a3a",
    backgroundColor: "#171219",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
    color: "#e2e6ee",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  heading: { fontSize: FONT_SIZE.strong, fontWeight: 800 },
  /* Two chips rather than one tinted by prop: #840/#732's rule about shorthand beside longhand -- each variant
     carries a COMPLETE `border`, so React never has to reconcile one against a sibling's `borderColor`. */
  chipRust: {
    padding: "2px 8px",
    borderRadius: "999px",
    border: "1px solid #8a4a3a",
    backgroundColor: "#3a1e18",
    color: "#e8a58c",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
  },
  chipLimit: {
    padding: "2px 8px",
    borderRadius: "999px",
    border: "1px solid #7a6a3a",
    backgroundColor: "#332c18",
    color: "#e0c98c",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
  },
  body: { fontSize: FONT_SIZE.small, color: "#d8dce6", lineHeight: 1.45, margin: 0 },
  /* Amber: this is the "what it means for you" line, not an error. */
  consequence: { fontSize: FONT_SIZE.small, color: "#e0b062", lineHeight: 1.45, margin: 0 },
  fleetRow: { display: "flex", alignItems: "center", gap: "10px", marginTop: "2px" },
  fleetLabel: { fontSize: FONT_SIZE.micro, color: "#8a90a0", letterSpacing: "0.06em", fontWeight: 700 },
  fleetTrains: { display: "flex", gap: "6px", flexWrap: "wrap" },
  trainChip: {
    padding: "2px 9px",
    borderRadius: "6px",
    border: "1px solid #4a4150",
    backgroundColor: "#241d28",
    color: "#c8cdd8",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    textDecoration: "line-through",
  },
  silenceRow: {
    display: "flex",
    flexDirection: "row",
    gap: "10px",
    cursor: "pointer",
    marginTop: "4px",
    paddingTop: "10px",
    borderTop: "1px solid #33303a",
  },
  checkbox: { marginTop: "3px", flex: "none" },
  rowText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  rowLabel: { fontSize: FONT_SIZE.small, fontWeight: 700 },
  rowCaption: { fontSize: FONT_SIZE.micro, color: "#8a90a0", lineHeight: 1.4 },
  footer: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "6px" },
  primaryButton: {
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid #3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
};
