// frontend/src/components/RejoinByPinCard.tsx
//
// One PIN, then a "Rejoin" button per game it opens. Design note #1355 (`gameServer.ts`) is the argument.
//
// The lobby's device-switch path: the player types the four digits they set on their seat, the server answers
// with every seat that carries them (usually one), and a click on it claims the seat, points the next load at
// the room and reloads into the game as that seat. The room-code path (#1352) stays underneath for a player
// who never set a PIN -- their seat can still be claimed by code and adopts the PIN they type.

import React, { useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { claimSeat, findSeatsByPin, type FoundSeat } from "../utils/roomDocLink";
import { writeSandboxResume } from "../utils/activeGame";
import { adoptSeat, isValidSeatPin, localPlayerId } from "../utils/seatPin";

export interface RejoinByPinCardProps {
  onClose: () => void;
  /** The room-code path, for a player without a PIN. */
  onRejoinByCode: () => void;
}

export function RejoinByPinCard({ onClose, onRejoinByCode }: RejoinByPinCardProps) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [seats, setSeats] = useState<FoundSeat[] | null>(null);

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
    <div style={styles.backdrop} role="presentation" onClick={onClose}>
      <div style={styles.card} role="dialog" aria-modal="true" aria-label="Rejoin a game" onClick={(event) => event.stopPropagation()}>
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
            style={styles.input}
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            placeholder="PIN"
            aria-label="Seat PIN"
            value={pin}
            autoFocus
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
    </div>
  );
}

export default RejoinByPinCard;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 4200,
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
  disabled: { borderColor: "#3a3a3a", backgroundColor: "#1c1c1c", color: "#6e6c68", cursor: "not-allowed" },
};
