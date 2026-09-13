// frontend/src/components/PhaseThreeNoticeModal.tsx
//
/* ==================================================================
    DESIGN NOTE 1441: THE PHASE 3 NOTICE -- PRIVATES ARE FOR SALE, UNTIL THE FIRST 5-TRAIN
   ==================================================================
   ASKED: "Since there isn't a specific subphase for these purchases, players may not be aware they can buy
   them. We need to add a modal notification as soon as Phase 3 is triggered, alerting all players that
   corporations can now buy private companies at any time during their turn. Remind them also the Private
   companies close at the start of Phase 5 when the first 5-train is purchased."
   ONE NOTICE, ON THE EDGE. The shell raises this when the derived phase goes from 2 to 3 while the log is
   live (the same seeded-edge pattern as the outro, #1418): a tab that loads a Phase 3 game sees no edge and
   gets no notice. Every player sees it, not just the one whose purchase turned the phase -- the rule is
   about what everybody's corporations may now do. Dismissed by its one button; nothing is pending behind it,
   so it is not blocking the way the fleet-loss modal is, and the backdrop click closes it too. */

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";

export interface PhaseThreeNoticeModalProps {
  open: boolean;
  onAcknowledge: () => void;
}

export function PhaseThreeNoticeModal({ open, onAcknowledge }: PhaseThreeNoticeModalProps) {
  if (!open) return null;
  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Phase 3: private companies are for sale"
      onClick={(event) => {
        if (event.target === event.currentTarget) onAcknowledge();
      }}
      data-testid="phase-three-notice"
    >
      <div style={styles.card}>
        <div style={styles.header}>
          <span style={styles.chip}>PHASE 3</span>
          <span style={styles.heading}>Private companies are for sale</span>
        </div>
        <p style={styles.body}>
          The first 3-train has been bought. From now on a corporation may buy a private company from any player{" "}
          <strong>at any time during its turn</strong> — use the <strong>Buy Private Company</strong> button on
          the action bar. The price must be between half and twice the private's face value, and the holder has
          to agree.
        </p>
        <p style={styles.body}>
          Private companies <strong>close at the start of Phase 5</strong>, when the first 5-train is bought. Keep
          that in mind if you want to use a private company's special power — it goes with the company.
        </p>
        <div style={styles.footer}>
          <button type="button" style={styles.primaryButton} onClick={onAcknowledge} autoFocus data-testid="phase-three-notice-ok">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export default PhaseThreeNoticeModal;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* Under the fleet-loss modal (3800) -- a rusting is a precondition of a turn; this is a notice. */
    zIndex: 3700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
  },
  card: {
    width: "min(540px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "18px 20px",
    borderRadius: RADIUS.layer,
    border: "1px solid #4a5a3a",
    backgroundColor: "#141914",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
    color: "#f2f0eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  chip: {
    padding: "2px 8px",
    borderRadius: RADIUS.pill,
    border: "1px solid #5a8a3a",
    backgroundColor: "#22331a",
    color: "#cfeabc",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.08em",
  },
  heading: { fontSize: FONT_SIZE.strong, fontWeight: 800 },
  body: { fontSize: FONT_SIZE.small, color: "#f2f0eb", lineHeight: 1.5, margin: 0 },
  footer: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "6px" },
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
};
