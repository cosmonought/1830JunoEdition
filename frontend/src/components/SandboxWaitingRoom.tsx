// The anteroom: who is here, what they are called, and who may start.
//
// Design note #529: this REPLACES the board rather than sitting over it. Before
// setup lands there is no game -- the player count is undecided, so starting
// cash and the certificate limit are too, and showing the board underneath would
// show a plausible, correctly-rendered game nobody is playing.
//
// Design note #529a: everyone gets Ready; only the host gets Start. Start is the
// one write that DEALS the game, and two clients sending it would put two setups
// with different shuffles in the log, each replayed by every client.
//
// See docs/ai_architecture/firebase_middleware.md, SandboxWaitingRoom.tsx #529.

import React, { useState } from "react";

import { FONT_SIZE, LINE_HEIGHT } from "../styles/typography";
import type { SandboxRoomDoc } from "../utils/sandboxRoom";
import { MAX_PLAYERS, MIN_PLAYERS, certLimitForPlayers, startingCashForPlayers } from "../utils/gameSetup";
import { SEAT_COLORS, SEAT_COLOR_NAMES } from "../utils/playerLabels";

export interface SandboxWaitingRoomProps {
  roomCode: string;
  room: SandboxRoomDoc | null;
  /** This browser's seat -- design note #528. */
  localPlayerId: string;
  error: string | null;
  busy: boolean;
  onSetNickname: (nickname: string) => void;
  /** Design note #569: `null` returns this seat to the assigned default. */
  onSetColor: (color: string | null) => void;
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
  onSetColor,
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

  /* Design note #529: the numbers this room WOULD be dealt, shown live as people
     arrive. They are the whole consequence of the player count, and a lobby that
     hides them makes the count feel cosmetic. `null` off the printed table. */
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

        {/* Design note #569a: optional by construction -- a seat that never touches this
           gets the palette by index and is never colourless. Taken colours are DISABLED
           rather than hidden: a greyed swatch with the holder's name says why it cannot
           be chosen, where removing it would make the palette a different size for every
           player and look like a bug. */}
        <div style={styles.colorRow} role="group" aria-label="Your colour">
          <span style={styles.colorLabel}>Colour</span>
          {SEAT_COLORS.map((color) => {
            const holder = players.find(
              (player) => player.color === color && player.id !== localPlayerId,
            );
            const mine = me?.color === color;
            return (
              <button
                key={color}
                type="button"
                aria-pressed={mine}
                aria-label={SEAT_COLOR_NAMES[color] ?? color}
                disabled={busy || !me || holder !== undefined}
                onClick={() => onSetColor(mine ? null : color)}
                title={
                  holder
                    ? `${holder.nickname || "Another player"} has taken ${SEAT_COLOR_NAMES[color] ?? "this"}.`
                    : mine
                      ? `${SEAT_COLOR_NAMES[color] ?? "This colour"} — click again to let the game assign one.`
                      : (SEAT_COLOR_NAMES[color] ?? color)
                }
                style={{
                  ...styles.swatch,
                  backgroundColor: color,
                  ...(mine ? styles.swatchMine : {}),
                  ...(holder ? styles.swatchTaken : {}),
                }}
              />
            );
          })}
        </div>

        <div style={styles.roster} role="list" aria-label="Players in this room">
          {players.length === 0 ? (
            <span style={styles.note}>Nobody here yet.</span>
          ) : (
            players.map((player) => (
              <span key={player.id} style={styles.rosterRow} role="listitem">
                <span style={styles.rosterName}>
                  {/* Design note #569: the seat's colour, where the seat is
                      named -- so a player can see the assignment before the
                      game starts rather than discovering it on the board. */}
                  <span
                    style={{
                      ...styles.rosterDot,
                      backgroundColor:
                        player.color ?? SEAT_COLORS[players.indexOf(player) % SEAT_COLORS.length],
                    }}
                    aria-hidden="true"
                  />
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
              Project 18XX is dealt for {MIN_PLAYERS}–{MAX_PLAYERS} players. Waiting for more.
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
                  ? `Project 18XX needs at least ${MIN_PLAYERS} players.`
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
  colorRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: "6px" },
  colorLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#9aa0ac",
    marginRight: "2px",
  },
  swatch: {
    width: "26px",
    height: "26px",
    borderRadius: "50%",
    border: "2px solid transparent",
    cursor: "pointer",
    padding: 0,
  },
  swatchMine: { borderColor: "#e2e6ee", boxShadow: "0 0 0 2px rgba(226,230,238,0.25)" },
  swatchTaken: { opacity: 0.28, cursor: "not-allowed" },
  rosterDot: { width: "10px", height: "10px", borderRadius: "50%", flex: "none" },
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
