// frontend/src/components/SandboxRoomBar.tsx
//
// The Sandbox multiplayer lobby: host a room, or join one by code.
//
// ===================================================================
//  DESIGN NOTE 521: A BAR, NOT A GATE
// ===================================================================
//
// The obvious shape for "Host Game / Join Game" is a modal that blocks the
// board until one is chosen. That would be wrong here, and the reason is
// what the sandbox is FOR.
//
// Offline Sandbox Mode is the one place this app runs end to end with no
// wallet, no chain and no second player -- it is how the rail map, the
// tile picker and the whole Operating Round get exercised at all. A modal
// asking "host or join?" before any of that is reachable would put a
// multiplayer decision in front of the single-player mode's front door, and
// every solo session would begin by dismissing it.
//
// So this is a strip that sits above the board and offers the two actions
// without demanding either. Solo play is unchanged and needs no gesture;
// multiplayer is one click away when somebody wants it.
//
// ===================================================================
//  DESIGN NOTE 521a: WHAT THE STRIP SAYS WHEN IT CANNOT WORK
// ===================================================================
//
// Firestore is optional in this app by construction (`config/firebase.ts`
// design note #1: losing the rail map because nobody configured a chat
// backend is an absurd failure mode). So an unconfigured build reaches this
// component, and the honest thing is to say so once rather than to offer two
// buttons that fail on click.
//
// The controls are hidden rather than disabled in that state. A disabled
// control invites the player to work out how to enable it; this is a
// deployment fact they cannot act on from inside the game.

import React, { useState } from "react";

import { FONT_SIZE } from "../styles/typography";

export interface SandboxRoomBarProps {
  /** `null` when not in a room -- the ordinary solo sandbox. */
  roomCode: string | null;
  /** False when Firestore is not configured; the strip explains and offers
   *  nothing. */
  available: boolean;
  /** How many actions have been replayed, for the connected readout. */
  appliedCount: number;
  /** A live error from the room, or `null`. */
  error: string | null;
  busy: boolean;
  onHost: () => void;
  onJoin: (code: string) => void;
  onLeave: () => void;
}

export function SandboxRoomBar({
  roomCode,
  available,
  appliedCount,
  error,
  busy,
  onHost,
  onJoin,
  onLeave,
}: SandboxRoomBarProps) {
  const [joining, setJoining] = useState(false);
  const [codeText, setCodeText] = useState("");

  if (!available) {
    return (
      <div style={styles.bar}>
        <span style={styles.muted}>
          Sandbox multiplayer needs Firestore, which this build has not been configured with.
          Solo sandbox is unaffected.
        </span>
      </div>
    );
  }

  if (roomCode) {
    return (
      <div style={styles.bar}>
        <span style={styles.label}>Room</span>
        {/* The code is the one thing a player has to relay to somebody else,
            so it is selectable text at a readable size rather than a chip
            they would have to retype from a screenshot. */}
        <code style={styles.code}>{roomCode}</code>
        <span style={styles.muted}>
          {appliedCount} action{appliedCount === 1 ? "" : "s"} synced
        </span>
        {error && <span style={styles.error}>{error}</span>}
        <button type="button" style={styles.button} onClick={onLeave}>
          Leave room
        </button>
      </div>
    );
  }

  return (
    <div style={styles.bar}>
      <span style={styles.label}>Sandbox multiplayer</span>
      <button type="button" style={styles.buttonPrimary} onClick={onHost} disabled={busy}>
        Host game
      </button>
      {joining ? (
        <form
          style={styles.joinRow}
          onSubmit={(event) => {
            event.preventDefault();
            onJoin(codeText);
          }}
        >
          <input
            style={styles.input}
            value={codeText}
            onChange={(event) => setCodeText(event.target.value)}
            placeholder="JUNO-4T2"
            aria-label="Room code"
            autoFocus
          />
          <button type="submit" style={styles.button} disabled={busy}>
            Join
          </button>
          <button
            type="button"
            style={styles.buttonQuiet}
            onClick={() => {
              setJoining(false);
              setCodeText("");
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" style={styles.button} onClick={() => setJoining(true)} disabled={busy}>
          Join game
        </button>
      )}
      {error && <span style={styles.error}>{error}</span>}
    </div>
  );
}

export default SandboxRoomBar;

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "10px",
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid #2b3242",
    backgroundColor: "#161b27",
    fontSize: FONT_SIZE.small,
  },
  label: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#9aa0ac",
  },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.08em",
    color: "#7ee0a1",
    userSelect: "all",
  },
  muted: { color: "#8a90a0" },
  error: { color: "#e07a7a" },
  joinRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: "6px" },
  input: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    padding: "5px 8px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#0f131b",
    color: "#e2e6ee",
    width: "110px",
    textTransform: "uppercase",
  },
  button: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "5px 12px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#232936",
    color: "#c8cdd8",
    cursor: "pointer",
  },
  buttonPrimary: {
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    padding: "5px 12px",
    borderRadius: "6px",
    border: "1px solid #2f6f6a",
    backgroundColor: "#14312f",
    color: "#7fe0d0",
    cursor: "pointer",
  },
  buttonQuiet: {
    fontSize: FONT_SIZE.small,
    padding: "5px 10px",
    borderRadius: "6px",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "#8a90a0",
    cursor: "pointer",
  },
};
