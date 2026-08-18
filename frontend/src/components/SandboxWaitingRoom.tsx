// frontend/src/components/SandboxWaitingRoom.tsx
//
// The anteroom: who is here, what they are called, and who may start.
//
// ===================================================================
//  DESIGN NOTE 529: THE GAME DOES NOT EXIST YET
// ===================================================================
//
// This screen replaces the board entirely rather than sitting over it, and
// that is the requirement's own instruction for a reason worth stating:
// before the setup action lands there IS no game. The player count is not
// decided, so starting cash and the certificate limit are not decided
// either -- and those are what the ledger, the stock cards and the
// certificate counter all render from.
//
// Showing the board underneath would therefore mean showing a game dealt for
// the fixture's roster, which is about to be replaced by one dealt for the
// real one. Every number on it would be wrong, and wrong in the specific way
// that looks right: a plausible board, correctly rendered, describing a game
// nobody is playing.
//
// ===================================================================
//  DESIGN NOTE 529a: READY IS A CLAIM, START IS AN ACT
// ===================================================================
//
// Everyone gets "Ready to play"; only the host gets "Start game", and it is
// enabled only when the whole room is ready. That asymmetry is deliberate.
//
// The start action is the one write that DEALS THE GAME -- it fixes the
// player count, the starting cash and the turn order for everybody. If any
// client could send it, two of them could send it twice, and the log would
// contain two setups with different shuffles. Every client would replay both
// and the second would silently redeal a game already in progress.
//
// One host, one button, one setup entry. `canStart` additionally requires
// enough players to deal a legal 1830 game, because "everyone is ready" is
// trivially true of a room containing one person.

import React, { useState } from "react";

import { FONT_SIZE, LINE_HEIGHT } from "../styles/typography";
import type { SandboxRoomDoc } from "../utils/sandboxRoom";
import { MAX_PLAYERS, MIN_PLAYERS, certLimitForPlayers, startingCashForPlayers } from "../utils/gameSetup";

export interface SandboxWaitingRoomProps {
  roomCode: string;
  room: SandboxRoomDoc | null;
  /** This browser's seat -- design note #528. */
  localPlayerId: string;
  error: string | null;
  busy: boolean;
  onSetNickname: (nickname: string) => void;
  onToggleReady: (isReady: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
}

export function SandboxWaitingRoom({
  roomCode,
  room,
  localPlayerId,
  error,
  busy,
  onSetNickname,
  onToggleReady,
  onStart,
  onLeave,
}: SandboxWaitingRoomProps) {
  const players = room?.players ?? [];
  const me = players.find((player) => player.id === localPlayerId) ?? null;
  const isHost = room?.hostId === localPlayerId;
  const [nicknameText, setNicknameText] = useState(me?.nickname ?? "");

  const enough = players.length >= MIN_PLAYERS;
  const allReady = players.length > 0 && players.every((player) => player.isReady);
  const canStart = isHost && enough && allReady;

  /* Design note #529: the numbers this room WOULD be dealt, shown live as
     people arrive. They are the whole consequence of the player count, and
     a lobby that hides them makes the count feel cosmetic -- a player
     joining a four-hander should be able to see their $600 before they
     commit to it. `null` off the printed table, which is what the count
     guard below is about. */
  const cash = startingCashForPlayers(players.length);
  const certs = certLimitForPlayers(players.length);

  return (
    <div style={styles.root}>
      <div style={styles.panel}>
        <div style={styles.headerRow}>
          <span style={styles.title}>Sandbox waiting room</span>
          <button type="button" style={styles.quiet} onClick={onLeave}>
            Leave
          </button>
        </div>

        {/* The code, at the size of the thing people have to read aloud. */}
        <div style={styles.codeBlock}>
          <span style={styles.codeLabel}>Room code</span>
          <code style={styles.code}>{roomCode}</code>
          <span style={styles.note}>Anyone with this code can join from the lobby.</span>
        </div>

        <form
          style={styles.nickRow}
          onSubmit={(event) => {
            event.preventDefault();
            onSetNickname(nicknameText);
          }}
        >
          <input
            style={styles.input}
            value={nicknameText}
            onChange={(event) => setNicknameText(event.target.value)}
            placeholder="Your name"
            aria-label="Your nickname"
            maxLength={20}
          />
          <button type="submit" style={styles.button} disabled={busy}>
            Set name
          </button>
        </form>

        <div style={styles.roster} role="list" aria-label="Players in this room">
          {players.length === 0 ? (
            <span style={styles.note}>Nobody here yet.</span>
          ) : (
            players.map((player) => (
              <span key={player.id} style={styles.rosterRow} role="listitem">
                <span style={styles.rosterName}>
                  {player.nickname || "unnamed"}
                  {player.id === room?.hostId && <span style={styles.hostTag}>HOST</span>}
                  {player.id === localPlayerId && <span style={styles.youTag}>YOU</span>}
                </span>
                <span style={player.isReady ? styles.ready : styles.notReady}>
                  {player.isReady ? "Ready" : "Not ready"}
                </span>
              </span>
            ))
          )}
        </div>

        {/* Design note #529: what this many players are dealt. */}
        <div style={styles.dealRow}>
          {cash !== null && certs !== null ? (
            <span style={styles.note}>
              {players.length} players — <strong style={styles.figure}>${cash}</strong> each,
              certificate limit <strong style={styles.figure}>{certs}</strong>.
            </span>
          ) : (
            <span style={styles.note}>
              1830 is dealt for {MIN_PLAYERS}–{MAX_PLAYERS} players. Waiting for more.
            </span>
          )}
        </div>

        <div style={styles.actionRow}>
          <button
            type="button"
            style={me?.isReady ? styles.button : styles.buttonPrimary}
            onClick={() => onToggleReady(!(me?.isReady ?? false))}
            disabled={busy || !me}
          >
            {me?.isReady ? "Not ready" : "Ready to play"}
          </button>
          {isHost && (
            <button
              type="button"
              style={{ ...styles.buttonStart, ...(canStart ? {} : styles.buttonDisabled) }}
              onClick={onStart}
              disabled={!canStart || busy}
              /* A disabled control with no explanation is the thing this
                 codebase's own prop conventions exist to prevent, so the
                 reason names whichever condition is actually blocking. */
              title={
                !enough
                  ? `1830 needs at least ${MIN_PLAYERS} players.`
                  : !allReady
                    ? "Waiting for everyone to mark themselves ready."
                    : "Deal the game and begin."
              }
            >
              Start game
            </button>
          )}
        </div>

        {error && <span style={styles.error}>{error}</span>}
      </div>
    </div>
  );
}

export default SandboxWaitingRoom;

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", justifyContent: "center", padding: "40px 20px" },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    width: "100%",
    maxWidth: "520px",
    padding: "22px 24px",
    borderRadius: "12px",
    border: "1px solid #2b3242",
    backgroundColor: "#161b27",
  },
  headerRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#e2e6ee" },
  codeBlock: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "12px 14px",
    borderRadius: "8px",
    backgroundColor: "#0f131b",
    border: "1px solid #2b3242",
  },
  codeLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#9aa0ac",
  },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "28px",
    fontWeight: 800,
    letterSpacing: "0.12em",
    color: "#7ee0a1",
    userSelect: "all",
  },
  note: { fontSize: FONT_SIZE.small, color: "#8a90a0", lineHeight: LINE_HEIGHT.normal },
  figure: { color: "#e2e6ee", fontVariantNumeric: "tabular-nums" },
  nickRow: { display: "flex", flexDirection: "row", gap: "8px" },
  input: {
    flex: 1,
    fontSize: FONT_SIZE.control,
    padding: "7px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#0f131b",
    color: "#e2e6ee",
  },
  roster: { display: "flex", flexDirection: "column", gap: "4px" },
  rosterRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    borderRadius: "6px",
    backgroundColor: "#1b2029",
    fontSize: FONT_SIZE.small,
    color: "#c8cdd8",
  },
  rosterName: { display: "inline-flex", alignItems: "center", gap: "7px", fontWeight: 700 },
  hostTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
    color: "#d9c0f5",
  },
  youTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
    color: "#9ec5ff",
  },
  ready: { color: "#7ee0a1", fontWeight: 700 },
  notReady: { color: "#8a90a0" },
  dealRow: { paddingTop: "2px" },
  actionRow: { display: "flex", flexDirection: "row", gap: "8px", flexWrap: "wrap" },
  button: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#232936",
    color: "#c8cdd8",
    cursor: "pointer",
  },
  buttonPrimary: {
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #2f6f6a",
    backgroundColor: "#14312f",
    color: "#7fe0d0",
    cursor: "pointer",
  },
  buttonStart: {
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: "8px 18px",
    borderRadius: "8px",
    border: "1px solid #38bdf8",
    backgroundColor: "#1d3a55",
    color: "#9ec5ff",
    cursor: "pointer",
    marginLeft: "auto",
  },
  buttonDisabled: { opacity: 0.4, cursor: "not-allowed" },
  quiet: {
    fontSize: FONT_SIZE.small,
    padding: "5px 10px",
    borderRadius: "6px",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "#8a90a0",
    cursor: "pointer",
  },
  error: { fontSize: FONT_SIZE.small, color: "#e07a7a" },
};
