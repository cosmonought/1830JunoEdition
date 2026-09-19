// The Connect Keplr button and the burner-wallet recommendation in front of it.
//
// Button and modal ship as ONE component because there is more than one Connect
// Keplr entry point; `wallet.connect` is not exported from here, so bypassing
// the recommendation means deleting this component. Escape and backdrop both
// route to Cancel, never Proceed.
//
// See docs/ai_architecture/session_keys_wallet.md, ConnectWalletButton.tsx
// #0 / #1 / #2.

import React, { useCallback, useState } from "react";

import { useWallet } from "../context/WalletContext";
import { NativeModal } from "./NativeModal";
import { CONTROL_PADDING, FONT_FAMILY, FONT_SIZE, LINE_HEIGHT, RADIUS } from "../styles/typography";

export interface ConnectWalletButtonProps {
  /** Style for the button itself, so the top bar and the lobby can each
   *  keep their own look without this component knowing about either. */
  buttonStyle?: React.CSSProperties;
  /** Overrides the resting label. The "Connecting..." state is handled
   *  here regardless -- it reflects wallet status, not caller preference. */
  label?: string;
  className?: string;
}

/* ==================================================================
    DESIGN NOTE 1646: BATCH 6A -- THE LAST STRAIGHTFORWARD PRIVATE ESCAPE LISTENER
   ==================================================================
   This component hand-rolled `window.addEventListener("keydown")` + `if (event.key === "Escape") cancel()`.
   Measured before the change, on the real component behind a real `WalletProvider`:

     Escape               closed it, through `cancel` -- the same callback Cancel and the backdrop use
     defaultPrevented     IGNORED (closed anyway): an inner surface could not keep the key
     focus after Escape   `<body>`; nothing captured the control that opened the dialog
     focus on open        "Proceed to Connect" (native `autoFocus`)

   THE FIRST LINE IS KEPT EXACTLY, and the hook adds only the other two: first refusal, and the guarded opener
   restoration. `proceed` is untouched -- it is the ACTION on this surface, it is what calls `wallet.connect()`,
   and #2's rule that "Escape cancels, it never connects" is precisely what passing `cancel` preserves.

   `dismissible` IS NOT PASSED: measured, Cancel and the backdrop dismiss unconditionally, and the only
   wallet-dependent control in the file is the OPENER button (`disabled={connecting}`), which is not a close
   route. Nothing about the dialog's lifecycle or its dismissal reads provider availability, connection state
   or wallet selection -- the effect that stood here depended on `confirmOpen` and `cancel`, both local.

   THE HOOK LIVES IN A CHILD, as #1643 established, for a reason particular to this file: the COMPONENT is
   always mounted -- it is the button -- while the dialog is `{confirmOpen && ...}`. A hook in the body would
   hold a listener and a captured opener for the whole session. The child is rendered inside that conditional
   block and ABOVE the card, which is what keeps its capture ahead of the `autoFocus` below (#1645: React 18
   applies `autoFocus` in the commit's layout phase, in fiber order). The `autoFocus` is therefore left exactly
   as it was; cases assert both its target and that order. */
/* #1651: `DismissalLifecycle` stood here. It existed because a hook in the component body would have captured
   an opener when the game shell mounted and never run its restore on a close -- the render switch keeps the
   component mounted all session. `NativeModal` is only RENDERED past that switch, so it mounts and unmounts
   with the dialog, which is the lifecycle the contract was written against. */

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
        <NativeModal
          /* #1651: the only surface named by REFERENCE rather than by label, and it stays that way -- the
             heading is already on screen and saying it twice is how the two drift apart. */
          labelledBy="wallet-security-title"
          /* #1646, carried forward by #1651: Design note #2 stands -- Escape CANCELS, it never connects,
             because `cancel` is what it is given. */
          dismissible
          onDismiss={cancel}
          onScrimClick={(event) => {
            // Design note #2: a backdrop click is a dismissal, so it
            // cancels. The target check keeps a drag that started inside
            // the card from closing it on release.
            if (event.target === event.currentTarget) cancel();
          }}
          restoreOpener
          scrimStyle={styles.backdrop}
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
        </NativeModal>
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
    /* #1651: the `zIndex: 2100` that stood here is gone -- this scrim is a `<dialog>` in the top layer, which
       is above the whole document by definition, so the number decided nothing. */
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
    borderRadius: RADIUS.layer,
    backgroundColor: "#1b2130",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#6b5a24",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
    color: "#f2f0eb",
    boxSizing: "border-box",
  },
  heading: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#e0b64a" },
  body: {
    margin: 0,
    fontSize: FONT_SIZE.body,
    lineHeight: LINE_HEIGHT.normal,
    color: "#c8c6c0",
  },
  footer: { display: "flex", justifyContent: "flex-end", gap: "8px" },
  primaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
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
    borderRadius: RADIUS.card,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3a3a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    cursor: "pointer",
  },
};
