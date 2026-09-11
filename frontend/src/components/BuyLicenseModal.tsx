// frontend/src/components/BuyLicenseModal.tsx
//
// The Coalfields, explained, with the purchase where the explanation is.
//
// ==================================================================
//  DESIGN NOTE 1299: THE HEX IS THE DOOR
// ==================================================================
//
// RULED (4a): "let's have the hex be clickable to open a Buy License modal that explains that only corporations
// with a License are allowed to run trains to or through the Coalfields and prompt players to buy a license
// (include an escape if they don't want to do that)."
//
// ONE MODAL, TWO STATES. When the click comes from the acting corporation's president at its Lay Track step,
// the Buy button is live and dispatches the same `BuyKanawhaLicense` the action-bar chip does (#1298) -- two
// controls, one message, one refusal table (`kanawhaLicenseRefusal`). At any other moment the modal is the
// explanation alone, with the reason a purchase is not on offer right now spelled out in the refusal's own
// words, and Close. A player who clicks the hex during a Stock Round learns the rule; nothing is sold.
//
// THE ESCAPE IS THE BACKDROP, ESCAPE AND THE CLOSE BUTTON -- the ordinary three (#1052 argued the payout modal
// down to one exit because a mis-click there loses ceremony; a mis-click here loses nothing).

import React from "react";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { PickaxeIcon } from "./KanawhaBadge";
import { KANAWHA_LICENSE_COST, KANAWHA_LICENSES_FOR_SALE } from "../utils/kanawhaLicense";

export interface BuyLicenseModalProps {
  open: boolean;
  onClose: () => void;
  /** The acting corporation's ticker, for the sentence. `null` when nobody is operating. */
  actingTicker: string | null;
  /** Licences the Bank still holds. */
  remaining: number;
  /** Whether the acting corporation already holds one. */
  alreadyHeld: boolean;
  /** `null` when the purchase is available right now; otherwise the refusal, in its own words. */
  refusal: string | null;
  /** #1388: the acting corporation's treasury now, for the confirm line; `null` when no corporation is acting. */
  treasuryBefore?: number | null;
  onBuy: () => void;
}

export function BuyLicenseModal({
  open,
  onClose,
  actingTicker,
  remaining,
  alreadyHeld,
  refusal,
  treasuryBefore = null,
  onBuy,
}: BuyLicenseModalProps) {
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const canBuy = refusal === null;
  return (
    <div style={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        style={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label="The Coalfields and the Kanawha Licence"
        onClick={(event) => event.stopPropagation()}
      >
        <div style={styles.header}>
          <span style={styles.heading}>
            <PickaxeIcon height={22} title="Coalfields" />
            The Coalfields
          </span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p style={styles.body}>
          Only a corporation holding a <strong>Kanawha Licence</strong> may run a train to or through the
          Coalfields (L8). Without one, its routes stop at the neighbouring hexes and its track may not be laid
          into it.
        </p>
        <p style={styles.body}>
          A licence costs <strong>${KANAWHA_LICENSE_COST}</strong> from the corporation&rsquo;s treasury, is
          bought during that corporation&rsquo;s own Lay Track step, and does not use up the tile lay. The Bank
          sells {KANAWHA_LICENSES_FOR_SALE}; <strong>{remaining}</strong> {remaining === 1 ? "is" : "are"} left.
          The James River &amp; Kanawha Company (JK) grants one free to the corporation that buys it.
        </p>
        {alreadyHeld && actingTicker && (
          <p style={styles.note}>{actingTicker} already holds a licence.</p>
        )}
        {!canBuy && !alreadyHeld && refusal && <p style={styles.note}>{refusal}</p>}
        {/* #1388: the effect, stated before the click -- the same line every other purchase confirm carries. */}
        {canBuy && actingTicker && treasuryBefore !== null && (
          <p style={styles.note}>
            {actingTicker} pays ${KANAWHA_LICENSE_COST} to the Bank. Treasury ${treasuryBefore} →{" "}
            ${treasuryBefore - KANAWHA_LICENSE_COST}.
          </p>
        )}
        <div style={styles.footer}>
          <button type="button" style={styles.secondaryButton} onClick={onClose}>
            {canBuy ? "Not now" : "Close"}
          </button>
          {canBuy && actingTicker && (
            <button
              type="button"
              style={styles.primaryButton}
              onClick={() => {
                onBuy();
                onClose();
              }}
              title={`${actingTicker} pays $${KANAWHA_LICENSE_COST} to the Bank.`}
            >
              Buy License for {actingTicker} (${KANAWHA_LICENSE_COST})
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default BuyLicenseModal;

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
    width: "min(480px, 100%)",
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
  heading: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
  },
  closeButton: {
    background: "none",
    border: "none",
    color: "#8a8a86",
    cursor: "pointer",
    fontSize: FONT_SIZE.heading,
    lineHeight: 1,
  },
  body: { fontSize: FONT_SIZE.small, color: "#c8c6c0", lineHeight: 1.5, margin: 0 },
  note: { fontSize: FONT_SIZE.small, color: "#e0b062", lineHeight: 1.4, margin: 0 },
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
};
