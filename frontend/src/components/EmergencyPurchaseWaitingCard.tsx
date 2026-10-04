// What every seat but the obligated president -- and every watcher -- sees while an emergency train purchase is
// being resolved.
//
// ==================================================================
//  PHASE 3 W2-G (OD-1 VIEWER SCOPE): ONE READ-ONLY SENTENCE, NO CONTROLS
// ==================================================================
// The old modal mounted the whole funding surface on every screen, "Declare bankruptcy" included (P3-N017). The
// ruling: the obligated president gets the interactive workflow (`EmergencyTrainPurchaseModal`); everybody else gets
// a status naming who the table is waiting on -- e.g. "PRR is resolving an emergency train purchase — waiting on
// Alice." -- and never an actionable funding or bankruptcy control. Not a modal: the board stays readable behind it,
// and the authoritative hold (`emergencyFundingBlock`) is what keeps everything else from happening, not this card.
//
// It sits in the prompt slot's layer (66, the consent prompts' value) but at the top of the viewport, so it never
// covers the answer prompt (`TrainTradePrompt`, `FundingPrivateOfferPrompt`, bottom right) a non-president may be
// the one to answer.

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";

export interface EmergencyPurchaseWaitingCardProps {
  /** `emergencyWaitingSentence(...)`, or `null` when no emergency purchase stands (or this viewer is its president). */
  sentence: string | null;
}

export function EmergencyPurchaseWaitingCard({ sentence }: EmergencyPurchaseWaitingCardProps) {
  if (!sentence) return null;
  return (
    <div style={styles.root} role="status" aria-live="polite" aria-label="Emergency train purchase">
      <span style={styles.dot} aria-hidden="true" />
      <span style={styles.text}>{sentence}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: "fixed",
    top: "64px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 66,
    width: "max-content",
    maxWidth: "min(560px, calc(100vw - 32px))",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 14px",
    backgroundColor: "#0f0f0f",
    border: "1px solid #6b5a1f",
    borderRadius: RADIUS.layer,
    boxShadow: "0 10px 34px rgba(0,0,0,0.6)",
    boxSizing: "border-box",
    pointerEvents: "none",
  },
  dot: { width: "9px", height: "9px", borderRadius: RADIUS.pill, backgroundColor: "#c9a227", flexShrink: 0 },
  text: { fontSize: FONT_SIZE.small, lineHeight: 1.4, color: "#e6e4de" },
};

export default EmergencyPurchaseWaitingCard;
