// frontend/src/components/RejoinByPinCard.tsx
//
// One PIN, then a "Rejoin" button per game it opens. Design note #1355 (`gameServer.ts`) is the argument.
//
// The lobby's device-switch path: the player types the four digits they set on their seat, the server answers
// with every seat that carries them (usually one), and a click on it claims the seat, points the next load at
// the room and reloads into the game as that seat. The room-code path (#1352) stays underneath for a player
// who never set a PIN -- their seat can still be claimed by code and adopts the PIN they type.

import React, { useLayoutEffect, useRef, useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { claimSeat, findSeatsByPin, type FoundSeat } from "../utils/roomDocLink";
import { writeSandboxResume } from "../utils/activeGame";
import { adoptSeat, isValidSeatPin, localPlayerId } from "../utils/seatPin";
import { NativeModal } from "./NativeModal";

export interface RejoinByPinCardProps {
  onClose: () => void;
  /** The room-code path, for a player without a PIN. */
  onRejoinByCode: () => void;
}

/** ==================================================================
 *   DESIGN NOTE 1642: BATCH 1 -- AND WHY `busy` IS NOT THE DISMISSAL RULE HERE
 *  ==================================================================
 *
 * The modal audit found this card, like its neighbour, carrying `aria-modal="true"` with no Escape (H3) and
 * dropping focus on `<body>` from every close route (H4). Measured on the real card beforehand, with focus on
 * the control being pressed: Escape did nothing; the x, Cancel and the backdrop all closed and all left
 * `document.activeElement` on BODY. Both are now the native dialog's own policy (#1651; `useDialogDismissal` from #1641 until then).
 *
 * `dismissible` IS DELIBERATELY NOT PASSED, and that is a measurement rather than an oversight. This card has
 * a `busy` flag, but it is a SUBMISSION gate, not a dismissal gate: measured with a lookup held in flight,
 * "Find my games" and every "Rejoin" button were disabled while the x, Cancel and the backdrop were all still
 * live and still closed the card. Mapping `busy` to `dismissible` because of its name would have made Escape
 * STRICTER than all three visible routes -- a rule no control on this card enforces. So the hook's default
 * stands: this dialog is always dismissible, exactly as it always was, and Escape now agrees with the three
 * routes instead of being absent from them.
 *
 * (The contrast with `JoinGameCard` is the point: there, two of three routes already refused while busy and
 * the third was the outlier. Here, three of three allow it. The rule is taken from the controls each time.)
 *
 * `onRejoinByCode` IS NOT A CLOSE, it is a navigation to the room-code door -- but it unmounts this card, so
 * the restore covers it too, because the restore lives in the unmount rather than in any one route.
 *
 * INITIAL FOCUS IS THE SAME CONTROL AS BEFORE, the PIN field, moved off native `autoFocus` and onto a local
 * layout effect: native autofocus fires during React's mutation phase, before any effect, so it would beat
 * the hook's opener capture and this card would record its own input as the thing to restore focus to. */
export function RejoinByPinCard({ onClose, onRejoinByCode }: RejoinByPinCardProps) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [seats, setSeats] = useState<FoundSeat[] | null>(null);
  const pinRef = useRef<HTMLInputElement | null>(null);

  /* #1651/#1652: THE ESCAPE PATH AND THE OPENER RESTORE MOVED INTO THE ELEMENT ITSELF. `useDialogDismissal`
     is gone from this file: the scrim below is a native `<dialog>`, its `dismissible` prop becomes the
     `closedby` attribute the engine enforces, and `restoreOpener` is the same guarded return the hook did.
     Nothing this file decided changed -- only who carries it out. */

  useLayoutEffect(() => {
    pinRef.current?.focus();
  }, []);

  const lookUp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isValidSeatPin(pin)) {
      setNote("A PIN is exactly four digits.");
      return;
    }
    setBusy(true);
    setNote(null);
    const answer = await findSeatsByPin(localPlayerId(), pin);
    setBusy(false);
    if (answer.reason) {
      setNote(answer.reason);
      return;
    }
    setSeats(answer.seats);
    if (answer.seats.length === 0) setNote("No seat on this server has that PIN. Set one from the game, or rejoin by room code below.");
  };

  const rejoin = async (seat: FoundSeat) => {
    setBusy(true);
    setNote(null);
    try {
      // eslint-disable-next-line no-console
      console.info(`[seat] claiming ${seat.playerId} in ${seat.room}`);
      const answer = await claimSeat(seat.room, localPlayerId(), seat.playerId, pin);
      if (!answer.ok) {
        setBusy(false);
        setNote(answer.reason ?? "The server refused that seat.");
        return;
      }
      setNote(`Seat claimed — loading ${seat.room}…`);
      writeSandboxResume(seat.room);
      adoptSeat(seat.room, seat.playerId, pin, answer.token ?? ""); // reloads into the game
    } catch (error) {
      setBusy(false);
      setNote(error instanceof Error ? error.message : "Could not rejoin that seat.");
    }
  };

  return (
    <NativeModal
      name="Rejoin a game"
      dismissible
      onDismiss={onClose}
      onScrimClick={onClose}
      restoreOpener
      scrimStyle={styles.backdrop}
    >
      <div style={styles.card} onClick={(event) => event.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.heading}>Rejoin a game</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p style={styles.body}>
          Type the four-digit PIN you set on your seat. Your games appear below; pick one and this device becomes
          that seat.
        </p>

        <form style={styles.row} onSubmit={lookUp}>
          <input
            ref={pinRef}
            style={styles.input}
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            placeholder="PIN"
            aria-label="Seat PIN"
            value={pin}
            onChange={(event) => {
              setPin(event.target.value.replace(/\D/g, "").slice(0, 4));
              setSeats(null);
              setNote(null);
            }}
          />
          <button type="submit" style={{ ...styles.primaryButton, ...(busy ? styles.disabled : {}) }} disabled={busy}>
            Find my games
          </button>
        </form>

        {seats && seats.length > 0 && (
          <div style={styles.list}>
            {seats.map((seat) => (
              <div key={`${seat.room}:${seat.playerId}`} style={styles.seatRow}>
                <span style={styles.seatText}>
                  <span style={styles.seatRoom}>{seat.room}</span>
                  <span style={styles.seatCaption}>
                    {seat.nickname || "unnamed"} · {seat.status === "playing" ? "in play" : seat.status}
                  </span>
                </span>
                <button type="button" style={{ ...styles.primaryButton, ...(busy ? styles.disabled : {}) }} disabled={busy} onClick={() => void rejoin(seat)}>
                  Rejoin
                </button>
              </div>
            ))}
          </div>
        )}

        {note && <p style={styles.warning}>{note}</p>}

        <div style={styles.footer}>
          <button type="button" style={styles.linkButton} onClick={onRejoinByCode}>
            No PIN yet? Rejoin by room code
          </button>
          <button type="button" style={styles.secondaryButton} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </NativeModal>
  );
}

export default RejoinByPinCard;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* #1651: the `zIndex: 4200` that stood here is gone -- this scrim is a `<dialog>` in the top layer, which
       is above the whole document by definition, so the number decided nothing. */
    pointerEvents: "auto", // #1360: never inherit a `none` from whatever this is mounted under
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
  },
  card: {
    width: "min(420px, 100%)",
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
  body: { fontSize: FONT_SIZE.small, color: "#c8c6c0", lineHeight: 1.5, margin: 0 },
  row: { display: "flex", gap: "8px", alignItems: "center" },
  input: {
    flex: 1,
    padding: "7px 10px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.body,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "0.2em",
  },
  list: { display: "flex", flexDirection: "column", gap: "6px" },
  seatRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
    padding: "8px 10px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
  },
  seatText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  seatRoom: { fontSize: FONT_SIZE.small, fontWeight: 800, letterSpacing: "0.04em" },
  seatCaption: { fontSize: FONT_SIZE.micro, color: "#8a8a86" },
  warning: { fontSize: FONT_SIZE.small, color: "#e0b062", lineHeight: 1.4, margin: 0 },
  footer: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginTop: "6px" },
  linkButton: { background: "none", border: "none", color: "#9ec5ff", cursor: "pointer", fontSize: FONT_SIZE.micro, padding: 0 },
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
    whiteSpace: "nowrap",
  },
  // #1449: the shorthand, not `borderColor` -- the base is `1px solid #3f7a55`.
  disabled: { border: "1px solid #3a3a3a", backgroundColor: "#1c1c1c", color: "#6e6c68", cursor: "not-allowed" },
};
