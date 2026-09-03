// The Sandbox multiplayer lobby: host a room, or join one by code.
//
// Design note #521: a BAR, not a gate. Offline Sandbox is the one mode that runs
// end to end with no wallet, chain or second player, so a modal asking "host or
// join?" would put a multiplayer decision in front of the single-player front
// door and every solo session would begin by dismissing it.
//
// Design note #521a: with Firestore unconfigured the controls are HIDDEN rather
// than disabled. A disabled control invites the player to work out how to enable
// it; this is a deployment fact they cannot act on from inside the game.
//
// See docs/ai_architecture/firebase_middleware.md, SandboxRoomBar.tsx #521.

import React, { useState } from "react";

import { FONT_SIZE } from "../styles/typography";

export interface SandboxRoomBarProps {
  /** `null` when not in a room -- the ordinary solo sandbox. */
  roomCode: string | null;
  /** False when Firestore is not configured; the strip explains and offers
   *  nothing. */
  available: boolean;
  /** A live error from the room, or `null`. Reported here only while JOINING -- once in a room the title
   *  strip carries it, beside `chatError` (#1083). */
  error: string | null;
  busy: boolean;
  onHost: () => void;
  onJoin: (code: string) => void;
  /** ==================================================================
   *   DESIGN NOTE 1131: THE SAME CONTROLS, WITHOUT THE TRAY THEY SIT IN
   *  ==================================================================
   *
   * REPORTED of the lobby: "the Host Game and Join Game buttons are still inside a box. Move them out of
   * that." THE BOX IS THIS COMPONENT'S OWN -- a bordered `#0f0f0f` strip with an uppercase label -- and it is
   * right where this bar appears in the GAME, which is a dense screen where an unbounded row of controls
   * would float free of everything around it.
   * SO IT IS A SURFACE FLAG, NOT A DELETION, the same shape `AppFooter` uses. `bare` drops the tray, the
   * label and the padding; the buttons, the join form and the error are untouched, because those are the
   * component and the rest was packaging.
   * THE LABEL GOES WITH THE TRAY rather than being conditioned separately: "SANDBOX MULTIPLAYER" was naming
   * the box's contents, and on a title screen the buttons say what they are. */
  bare?: boolean;
}

export function SandboxRoomBar({
  roomCode,
  available,
  error,
  busy,
  onHost,
  onJoin,
  bare = false,
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

  /* ==================================================================
      DESIGN NOTE 1083: THE IN-ROOM BAR IS GONE, AND EVERY PIECE OF IT WENT SOMEWHERE
     ==================================================================
     RULED: "Completely delete the '68 actions' text ... Completely delete the 'Leave Room' button. Players
     will use the existing '<- Lobby' button in the title area to navigate away ... Move the remaining Room
     Name information into the Title area."

     THAT IS THREE REMOVALS AND ONE MOVE, and taken together they empty the branch. Worth stating as a whole
     rather than as four edits, because what is left over decides whether the branch should exist:

       "N actions synced"  DELETED. A replay counter is a fact about the transport, not about the game -- it
                           told a player their client was keeping up, which is the sort of thing that belongs
                           in a console when it is true and in an error when it is not.
       "Leave room"        DELETED. The title area's back-arrow already leaves, and two exits mean a player
                           has to work out whether they differ. They did not.
       the room code       MOVED to the title, where the room's identity now lives beside the app's.
       the error           MOVED to the title strip, beside `chatError` -- the two are the same KIND of fact
                           (this room's connection is unhappy) and were being reported in two places.

     SO THE BRANCH IS DELETED RATHER THAN EMPTIED. A `<div>` that renders an empty flex row is a gap in the
     layout with no explanation, and this batch is about removing exactly that.

     WHAT SURVIVES IS THE JOIN/HOST FORM BELOW, which is the bar's actual job: it is how a solo sandbox
     BECOMES a room. Once you are in one it has nothing left to offer. */
  if (roomCode) return null;

  return (
    <div style={bare ? styles.barBare : styles.bar}>
      {!bare && <span style={styles.label}>Sandbox multiplayer</span>}
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
  /* Design note #1131: the tray, minus the tray. Kept as its own object rather than as a spread-with-
     overrides, because "no border, no fill, no padding" said three times in overrides is harder to read than
     the four properties that actually remain. */
  barBare: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "12px",
    fontSize: FONT_SIZE.small,
  },
  bar: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "10px",
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#0f0f0f",
    fontSize: FONT_SIZE.small,
  },
  label: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#a8a6a0",
  },
  /* Design note #1083: `code` is DELETED, not left unused. Its one caller was the in-room branch and the
     room code now renders in the title strip, which carries its own copy of this treatment -- an orphaned
     style for a thing this component no longer shows is an invitation to show it again. */
  muted: { color: "#8a8a86" },
  error: { color: "#e07a7a" },
  joinRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: "6px" },
  input: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    padding: "5px 8px",
    borderRadius: "6px",
    border: "1px solid #3a3a3a",
    backgroundColor: "#141414",
    color: "#f2f0eb",
    width: "110px",
    textTransform: "uppercase",
  },
  button: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "5px 12px",
    borderRadius: "6px",
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
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
    color: "#8a8a86",
    cursor: "pointer",
  },
};
