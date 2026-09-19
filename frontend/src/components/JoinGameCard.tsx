// frontend/src/components/JoinGameCard.tsx
//
/* ==================================================================
    DESIGN NOTE 1440 SUPERSEDES #1415: THIS CARD IS THE DOOR WITH NO SIGN ON IT
   ==================================================================
   RULED: "public games are browsed on the Lobby; Join Game is for entering a room code for an unlisted/private
   game ... Simplify the Join Game modal accordingly: room-code entry and any directly related
   private-room/rejoin behavior only."
   #1415 PUT BOTH DOORS IN ONE CARD and its own note explains why that could not last: the list it mounted is
   "the server's `rooms` frame, pushed on every room write", which is a page's worth of changing content, and
   it was being read through a 640px dialog with its own scrollbar. The list is now flow content on the Lobby
   (`LobbyRoomList`, #1440).
   WHAT IS LEFT IS THE PART A LIST CANNOT DO. A private room is in no list by construction -- the server drops
   it before the frame is built -- so the code is its only door; and the rejoin-by-code path (#1352) rides with
   it, because a returning player also arrives holding a code rather than a room to browse for.
   THE TABS, THE CARDS, THE ROSTERS AND THE SPECTATE BUTTON ARE GONE, not hidden. Every one of them is on the
   Lobby now, and a second rendering of a room would be a second thing to keep in step. */

import React, { useLayoutEffect, useRef, useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { NativeModal } from "./NativeModal";

export interface JoinGameCardProps {
  /** The join's verdict, owned by the parent (#1137). */
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onJoin: (code: string) => void;
  /** Design note #1352: the by-code rejoin. Absent hides the button. */
  onRejoin?: (code: string) => void;
  onClearError: () => void;
}

/** ==================================================================
 *   DESIGN NOTE 1642: BATCH 1 -- THIS CARD JOINS THE DISMISSAL BOUNDARY
 *  ==================================================================
 *
 * The modal audit (`claude/modal-audit-2026-09-18.md`) found this surface carrying `aria-modal="true"` with
 * **no Escape at all** (H3) and dropping focus on `<body>` from every close route (H4). Measured on the real
 * card before the change, with focus on the control being pressed:
 *
 *     Escape (either state)      -> the dialog stayed open
 *     x / Cancel / backdrop      -> closed, and `document.activeElement` was BODY every time
 *
 * Both are now the native dialog's own policy (#1651; they were `useDialogDismissal` from #1641 until the
 * element became a `<dialog>`), which is the whole of the change apart from the one
 * normalisation below. Escape calls `onClose` -- the identical prop the x, Cancel and the backdrop call --
 * and closing UNMOUNTS this card, so `codeText` is reset by the unmount rather than by any reset code.
 *
 * THE BUSY RULE HAD TO BE NORMALISED, and it is the one behaviour change beyond Escape and focus. Measured:
 * while `busy`, the x was `disabled` and the backdrop was `busy ? undefined : onClose` -- both dead -- but
 * **Cancel was live**, and pressing it closed the card while the join round trip carried on. On success the
 * parent then calls `onEnterSandbox(code)` and takes the player into the room they had just backed out of.
 * The two blocked routes are what the card MEANT; Cancel was the one that had not been given the rule. It is
 * `disabled={busy}` now, exactly as the "Rejoin seat" secondary button beside it already was -- so all three
 * visible routes agree, and `dismissible={!busy}` makes Escape the fourth rather than a way around them.
 * (`styles.disabled` is deliberately NOT applied: within this file the disabled treatment for a secondary
 * button is the attribute alone -- see "Rejoin seat" -- and only the primary submit is greyed.)
 *
 * INITIAL FOCUS IS THE SAME CONTROL AS BEFORE, the room-code field, moved off native `autoFocus` and onto a
 * local layout effect. Native autofocus fires during React's mutation phase, BEFORE any effect, so it would
 * beat the hook's opener capture and the card would record its own input as the thing to restore focus to --
 * a node that leaves with the card. The hook is called first, its capture is a layout effect, and this is the
 * layout effect after it. */
export function JoinGameCard({ error, busy, onClose, onJoin, onRejoin, onClearError }: JoinGameCardProps) {
  const [codeText, setCodeText] = useState("");
  const codeRef = useRef<HTMLInputElement | null>(null);

  /* #1651/#1652: THE ESCAPE PATH AND THE OPENER RESTORE MOVED INTO THE ELEMENT ITSELF. `useDialogDismissal`
     is gone from this file: the scrim below is a native `<dialog>`, its `dismissible` prop becomes the
     `closedby` attribute the engine enforces, and `restoreOpener` is the same guarded return the hook did.
     Nothing this file decided changed -- only who carries it out. */

  useLayoutEffect(() => {
    codeRef.current?.focus();
  }, []);

  return (
    <NativeModal
      name="Join by room code"
      dismissible={!busy}
      onDismiss={onClose}
      onScrimClick={busy ? undefined : onClose}
      restoreOpener
      scrimStyle={styles.backdrop}
    >
      <div style={styles.card} onClick={(event) => event.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.heading}>Join by room code</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close" disabled={busy}>
            ×
          </button>
        </div>

        {/* The card says what it is FOR, because the other door is now visible behind it: a player who came
            here looking for a game to join can see the list on the page they came from. */}
        <p style={styles.note}>
          Private games are unlisted — the code is their only door, and they cannot be watched. Public games
          are listed on the Lobby.
        </p>

        <form
          style={styles.codeRow}
          onSubmit={(event) => {
            event.preventDefault();
            onJoin(codeText);
          }}
        >
          <input
            ref={codeRef}
            style={styles.input}
            value={codeText}
            onChange={(event) => {
              // Design note #1137: the verdict was about the old string.
              if (codeText !== event.target.value) onClearError();
              setCodeText(event.target.value);
            }}
            placeholder="JUNO-4T2"
            aria-label="Room code"
          />
          <button type="submit" style={{ ...styles.primaryButton, ...(busy ? styles.disabled : {}) }} disabled={busy} data-testid="join-by-code">
            Join by code
          </button>
          {onRejoin && (
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => onRejoin(codeText)}
              disabled={busy}
              title="Already in this game on another device? Rejoin your seat with its four-digit PIN."
              data-testid="rejoin-by-code"
            >
              Rejoin seat
            </button>
          )}
        </form>

        {error && <p style={styles.warning}>{error}</p>}

        <div style={styles.footer}>
          {/* #1642: `disabled={busy}` is the normalisation -- the x and the backdrop already refused while a
              join was in flight and this one did not, which let a player close the card and still be taken
              into the room when the round trip landed. */}
          <button type="button" style={styles.secondaryButton} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </NativeModal>
  );
}

export default JoinGameCard;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* #1651: the `zIndex: 4200` that stood here is gone -- this scrim is a `<dialog>` in the top layer, which
       is above the whole document by definition, so the number decided nothing. */
    pointerEvents: "auto", // #1360
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
    overflowY: "auto",
  },
  card: {
    /* Design note #1440: a bounded dialog for one field, not a window onto a list. */
    width: "min(430px, 100%)",
    maxHeight: "calc(100vh - 48px)",
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
  closeButton: { background: "none", border: "none", color: "#8a8a86", cursor: "pointer", fontSize: FONT_SIZE.heading, lineHeight: 1 },
  codeRow: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  input: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.body,
    padding: "7px 10px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    width: "130px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  note: { fontSize: FONT_SIZE.micro, color: "#8a8a86", lineHeight: 1.4, margin: 0 },
  warning: { fontSize: FONT_SIZE.small, color: "#e0b062", lineHeight: 1.4, margin: 0 },
  footer: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px", marginTop: "4px" },
  secondaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    fontSize: FONT_SIZE.small,
    cursor: "pointer",
    whiteSpace: "nowrap",
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
    whiteSpace: "nowrap",
  },
  // #1449: the shorthand, not `borderColor` -- the base is `1px solid #3f7a55`.
  disabled: { border: "1px solid #3a3a3a", backgroundColor: "#1c1c1c", color: "#6e6c68", cursor: "not-allowed" },
};
