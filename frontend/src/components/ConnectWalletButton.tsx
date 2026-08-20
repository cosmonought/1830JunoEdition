// The Connect Keplr button and the burner-wallet recommendation in front of it.
//
// Button and modal ship as ONE component because there is more than one Connect
// Keplr entry point; `wallet.connect` is not exported from here, so bypassing
// the recommendation means deleting this component. Escape and backdrop both
// route to Cancel, never Proceed.
//
// See docs/ai_architecture/session_keys_wallet.md, ConnectWalletButton.tsx
// #0 / #1 / #2.

import React, { useCallback, useEffect, useState } from "react";

import { useWallet } from "../context/WalletContext";
import { CONTROL_PADDING, FONT_FAMILY, FONT_SIZE, LINE_HEIGHT } from "../styles/typography";

export interface ConnectWalletButtonProps {
  /** Style for the button itself, so the top bar and the lobby can each
   *  keep their own look without this component knowing about either. */
  buttonStyle?: React.CSSProperties;
  /** Overrides the resting label. The "Connecting..." state is handled
   *  here regardless -- it reflects wallet status, not caller preference. */
  label?: string;
  className?: string;
}

export function ConnectWalletButton({ buttonStyle, label, className }: ConnectWalletButtonProps) {
  const wallet = useWallet();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const cancel = useCallback(() => setConfirmOpen(false), []);

  const proceed = useCallback(() => {
    setConfirmOpen(false);
    // `void` because `connect` reports failure through `wallet.error`,
    // which the bar already renders -- there is nothing useful to do with
    // the rejected promise here, and an unhandled rejection warning in the
    // console would be noise rather than signal.
    void wallet.connect();
  }, [wallet]);

  useEffect(() => {
    if (!confirmOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      // Design note #2: Escape cancels. It never connects.
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen, cancel]);

  const connecting = wallet.status === "connecting";

  return (
    <>
      <button
        type="button"
        className={className}
        style={buttonStyle}
        onClick={() => setConfirmOpen(true)}
        disabled={connecting}
        title="Connect a Keplr wallet to play on chain."
      >
        {connecting ? "Connecting..." : (label ?? "Connect Keplr")}
      </button>

      {confirmOpen && (
        <div
          style={styles.backdrop}
          role="dialog"
          aria-modal="true"
          aria-labelledby="wallet-security-title"
          onClick={(event) => {
            // Design note #2: a backdrop click is a dismissal, so it
            // cancels. The target check keeps a drag that started inside
            // the card from closing it on release.
            if (event.target === event.currentTarget) cancel();
          }}
        >
          <div style={styles.card}>
            <span id="wallet-security-title" style={styles.heading}>
              Security Recommendation
            </span>
            <p style={styles.body}>
              For the best gameplay experience and asset safety, we strongly recommend connecting a
              dedicated burner wallet for Project 18XX. Do not connect your primary vault
              wallet.
            </p>
            <div style={styles.footer}>
              <button type="button" style={styles.secondaryButton} onClick={cancel}>
                Cancel
              </button>
              <button type="button" style={styles.primaryButton} onClick={proceed} autoFocus>
                Proceed to Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default ConnectWalletButton;

/* ------------------------------------------------------------------ */
/* Inline styles -- matches TutorialModal.tsx's own modal treatment,   */
/* so the app has one modal look rather than two.                      */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 2100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 8, 12, 0.72)",
    fontFamily: FONT_FAMILY,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    width: "min(520px, 100%)",
    padding: "22px 24px",
    borderRadius: "14px",
    backgroundColor: "#1b2130",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#6b5a24",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
    color: "#e6e8ef",
    boxSizing: "border-box",
  },
  heading: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#e0b64a" },
  body: {
    margin: 0,
    fontSize: FONT_SIZE.body,
    lineHeight: LINE_HEIGHT.normal,
    color: "#c7cbd4",
  },
  footer: { display: "flex", justifyContent: "flex-end", gap: "8px" },
  primaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#6b5a24",
    backgroundColor: "#3a2f14",
    color: "#f0d99a",
    cursor: "pointer",
  },
  secondaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a4055",
    backgroundColor: "transparent",
    color: "#c7cbd4",
    cursor: "pointer",
  },
};
