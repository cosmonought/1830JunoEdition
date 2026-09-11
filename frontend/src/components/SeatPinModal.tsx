// frontend/src/components/SeatPinModal.tsx
//
// Four digits, one room. Design note #1341 (`sandboxRoom.ts`) is the argument; this is the one card both uses share.
//
//   set     "Set a PIN for your seat"    -- the seat's own player chooses (or changes) its PIN.
//   rejoin  "Rejoin a seat"              -- pick a seat that has a PIN, type it, and this device becomes that
//                                           seat (`adoptSeat` reloads with the id and the PIN in hand).
//
// ONE COMPONENT, MOUNTED TWICE -- by the waiting room (which owns its own open/close state) and by the shell's
// room strip in-game (one `useState` and one mount in `App.tsx`, nothing more). The copy says, every time, that
// the PIN is for THIS room and nothing else.

import React, { useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { claimSeat, roomDocOnServer, setSeatPin } from "../utils/roomDocLink";
import type { SandboxRoomPlayer } from "../utils/sandboxRoom";
import { adoptSeat, isValidSeatPin, readSeatPin, storeSeatPin, storeSeatToken } from "../utils/seatPin";

export interface SeatPinModalProps {
  mode: "set" | "rejoin";
  roomCode: string;
  localPlayerId: string;
  players: readonly SandboxRoomPlayer[];
  /** Rejoin: the seat to preselect, when the click came from a roster row. */
  initialSeatId?: string | null;
  /** Design note #1352: called just before the adopting reload -- the lobby uses it to point the next load at
   *  the room. In-room callers need nothing here; the reload lands where they already are. */
  onAdopt?: (roomCode: string, playerId: string) => void;
  onClose: () => void;
}

export function SeatPinModal({ mode, roomCode, localPlayerId, players, initialSeatId = null, onAdopt, onClose }: SeatPinModalProps) {
  const me = players.find((player) => player.id === localPlayerId) ?? null;
  /* #1341a: EVERY OTHER SEAT, not only the ones with a PIN. Filtering to `hasPin` was right while an
     unPINned seat could not be claimed -- it hid an option that would only have been refused. Now an
     unPINned seat adopts the PIN it is offered, so hiding it hides the migration itself: the seats that
     most need this list are exactly the ones claimed before PINs existed. The option says which is which. */
  const rejoinable = players.filter((player) => player.id !== localPlayerId);
  const [seatId, setSeatId] = useState<string>(initialSeatId ?? rejoinable[0]?.id ?? "");
  const [pin, setPin] = useState("");
  const [currentPin, setCurrentPin] = useState(readSeatPin(roomCode) ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const onServer = roomDocOnServer();
  const changing = mode === "set" && me?.hasPin === true;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isValidSeatPin(pin)) {
      setNote("A PIN is exactly four digits.");
      return;
    }
    setBusy(true);
    setNote(null);
    if (mode === "set") {
      const answer = await setSeatPin(roomCode, localPlayerId, pin, changing ? currentPin : undefined);
      setBusy(false);
      if (!answer.ok) {
        setNote(answer.reason ?? "The server refused that PIN.");
        return;
      }
      storeSeatPin(roomCode, pin);
      if (answer.token) storeSeatToken(roomCode, answer.token);
      onClose();
      return;
    }
    if (!seatId) {
      setBusy(false);
      setNote("Choose a seat.");
      return;
    }
    const answer = await claimSeat(roomCode, localPlayerId, seatId, pin);
    if (!answer.ok) {
      setBusy(false);
      setNote(answer.reason ?? "The server refused that seat.");
      return;
    }
    onAdopt?.(roomCode, seatId);
    adoptSeat(roomCode, seatId, pin, answer.token ?? ""); // reloads
  };

  return (
    <div style={styles.backdrop} role="presentation" onClick={onClose}>
      <form
        style={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "set" ? "Set a seat PIN" : "Rejoin a seat"}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div style={styles.header}>
          <span style={styles.heading}>{mode === "set" ? (changing ? "Change your seat PIN" : "Set a PIN for your seat") : "Rejoin a seat"}</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p style={styles.body}>
          {mode === "set"
            ? "Four digits that let you pick this seat up on another device -- a laptop to an iPad mid-game."
            : "Moved to another device? Choose your seat and type its PIN; this device becomes that seat. " +
              "A seat that has no PIN yet takes the one you type, and asks for it from then on."}{" "}
          <strong>The PIN is only for room {roomCode}.</strong> It is not an account and unlocks nothing else.
        </p>

        {!onServer && <p style={styles.warning}>Seat PINs need the game server; this room is not on one.</p>}

        {mode === "rejoin" && (
          <label style={styles.field}>
            <span style={styles.label}>Seat</span>
            <select value={seatId} onChange={(event) => setSeatId(event.target.value)} style={styles.input} disabled={rejoinable.length === 0}>
              {rejoinable.length === 0 && <option value="">There is no other seat in this room</option>}
              {rejoinable.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.nickname || "unnamed"}
                  {player.hasPin ? "" : " -- no PIN yet, the one you type becomes it"}
                </option>
              ))}
            </select>
          </label>
        )}

        {changing && (
          <label style={styles.field}>
            <span style={styles.label}>Current PIN</span>
            <input
              style={styles.input}
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={currentPin}
              onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
            />
          </label>
        )}

        <label style={styles.field}>
          <span style={styles.label}>{changing ? "New PIN" : "PIN"}</span>
          <input
            style={styles.input}
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            placeholder="4 digits"
            value={pin}
            autoFocus
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
          />
        </label>

        {note && <p style={styles.warning}>{note}</p>}

        <div style={styles.footer}>
          <button type="button" style={styles.secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            style={{ ...styles.primaryButton, ...(busy || !onServer ? styles.primaryButtonDisabled : {}) }}
            disabled={busy || !onServer}
          >
            {mode === "set" ? "Save PIN" : "Rejoin seat"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default SeatPinModal;

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
  field: { display: "flex", flexDirection: "column", gap: "4px" },
  label: { fontSize: FONT_SIZE.micro, textTransform: "uppercase", letterSpacing: "0.08em", color: "#a8a6a0" },
  input: {
    padding: "7px 10px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.body,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "0.2em",
  },
  warning: { fontSize: FONT_SIZE.small, color: "#e0b062", lineHeight: 1.4, margin: 0 },
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
  primaryButtonDisabled: { borderColor: "#3a3a3a", backgroundColor: "#1c1c1c", color: "#6e6c68", cursor: "not-allowed" },
};
