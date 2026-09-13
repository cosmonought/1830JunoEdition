// frontend/src/components/JoinGameCard.tsx
//
/* ==================================================================
    DESIGN NOTE 1415: JOIN GAME IS A LIST, WITH THE CODE BOX BESIDE IT
   ==================================================================
   ASKED: "When players click 'Join Game' on the Lobby, we need to display all currently open (not yet started)
   public games alongside the room code textbox" -- each card showing the type, the pace, the ante, who is
   seated and how many seats there are, and the variants in force -- with an Ongoing tab to watch a public game
   already under way. Private games are in neither list: the code is their only door, and once dealt not even
   that (they are not spectatable).
   THE LIST IS THE SERVER'S `rooms` FRAME (`useSandboxRooms`), pushed on every room write, so a card's seat
   count moves as people sit down and a room leaves the Open tab the moment its host presses Start. A full
   table's Join is disabled with the reason -- the server would refuse it anyway (#1415 server), and a button
   that only ever earns a refusal should say so first.
   THE CODE BOX STAYS, for the private room and for the player who was told a code aloud; the rejoin-by-code
   path (#1352) rides with it as before. */

import React, { useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { BANK_SIZE_BY_LENGTH, GAME_MODE_COPY, GAME_TYPE_COPY, gameTypeOf } from "../utils/gameVariants";
import type { SandboxRoomSummary } from "../utils/sandboxRoomSummary";
import { formatJuno } from "../utils/anteMath";

export interface JoinGameCardProps {
  rooms: readonly SandboxRoomSummary[];
  loading: boolean;
  /** The list's own error -- the server could not be reached -- as opposed to a join's. */
  listError: string | null;
  /** The join's verdict, owned by the parent (#1137). */
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onJoin: (code: string) => void;
  /** Design note #1352: the by-code rejoin. Absent hides the button. */
  onRejoin?: (code: string) => void;
  onSpectate: (code: string) => void;
  onClearError: () => void;
}

type Tab = "open" | "ongoing";

/** The rule variants a card names, in the house-rules order, by their short titles. */
const RULE_TITLES: ReadonlyArray<{ key: "gentleRust" | "dynamicStockMarket" | "delayedAuction" | "unpredictableRevenue" | "plusTiles"; title: string }> = [
  { key: "plusTiles", title: "18XX+ tiles" },
  { key: "gentleRust", title: "Gentle Rust" },
  { key: "dynamicStockMarket", title: "Dynamic Market" },
  { key: "delayedAuction", title: "Delayed Auction" },
  { key: "unpredictableRevenue", title: "Unpredictable Routes" },
];

export function variantChipsFor(room: Pick<SandboxRoomSummary, "variants">): string[] {
  const chips: string[] = [];
  if (room.variants.length !== "standard") chips.push(`$${BANK_SIZE_BY_LENGTH[room.variants.length].toLocaleString("en-US")} bank`);
  for (const rule of RULE_TITLES) {
    /* The tray is the type's own under the Level Playing Field; a chip for it there says nothing. */
    if (rule.key === "plusTiles" && room.variants.levelPlayingField) continue;
    if (room.variants[rule.key]) chips.push(rule.title);
  }
  return chips;
}

export function JoinGameCard({
  rooms,
  loading,
  listError,
  error,
  busy,
  onClose,
  onJoin,
  onRejoin,
  onSpectate,
  onClearError,
}: JoinGameCardProps) {
  const [tab, setTab] = useState<Tab>("open");
  const [codeText, setCodeText] = useState("");

  const open = rooms.filter((room) => room.status === "waiting");
  const ongoing = rooms.filter((room) => room.status === "playing");
  const shown = tab === "open" ? open : ongoing;

  return (
    <div style={styles.backdrop} role="presentation" onClick={busy ? undefined : onClose}>
      <div style={styles.card} role="dialog" aria-modal="true" aria-label="Join a game" onClick={(event) => event.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.heading}>Join a game</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close" disabled={busy}>
            ×
          </button>
        </div>

        <form
          style={styles.codeRow}
          onSubmit={(event) => {
            event.preventDefault();
            onJoin(codeText);
          }}
        >
          <input
            style={styles.input}
            value={codeText}
            onChange={(event) => {
              // Design note #1137: the verdict was about the old string.
              if (codeText !== event.target.value) onClearError();
              setCodeText(event.target.value);
            }}
            placeholder="JUNO-4T2"
            aria-label="Room code"
            autoFocus
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
            >
              Rejoin seat
            </button>
          )}
        </form>
        <span style={styles.note}>A private game is joined by its code only, and cannot be watched.</span>

        {error && <p style={styles.warning}>{error}</p>}

        <div style={styles.tabs} role="tablist">
          {(["open", "ongoing"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={tab === candidate}
              style={{ ...styles.tab, ...(tab === candidate ? styles.tabSelected : {}) }}
              onClick={() => setTab(candidate)}
              data-testid={`join-tab-${candidate}`}
            >
              {candidate === "open" ? `Open (${open.length})` : `Ongoing (${ongoing.length})`}
            </button>
          ))}
        </div>

        <div style={styles.list} role="list" aria-label={tab === "open" ? "Open public games" : "Ongoing public games"}>
          {listError ? (
            <span style={styles.warning}>{listError}</span>
          ) : loading ? (
            <span style={styles.note}>Fetching the game list…</span>
          ) : shown.length === 0 ? (
            <span style={styles.note}>
              {tab === "open" ? "No public games are waiting for players. Host one, or join by code." : "No public games are under way."}
            </span>
          ) : (
            shown.map((room) => {
              const full = room.players.length >= room.seatCap;
              const chips = variantChipsFor(room);
              return (
                <div key={room.code} style={styles.room} role="listitem" data-testid={`room-card-${room.code}`}>
                  <div style={styles.roomHead}>
                    <span style={styles.roomTitle}>
                      <span style={styles.roomType}>{GAME_TYPE_COPY[gameTypeOf(room.variants)].label}</span>
                      <span style={styles.roomMeta}>
                        {GAME_MODE_COPY[room.variants.mode].label} · ante {formatJuno(room.anteUjuno)} · {room.code}
                      </span>
                    </span>
                    <span style={styles.seats}>
                      {room.players.length}/{room.seatCap}
                      {room.playerCount !== null ? " exactly" : ""}
                    </span>
                  </div>
                  <span style={styles.roster}>
                    {room.players.map((player) => (player.nickname || "unnamed") + (player.isReady ? " ✓" : "")).join(", ") || "Nobody seated"}
                  </span>
                  {chips.length > 0 && (
                    <span style={styles.chips}>
                      {chips.map((chip) => (
                        <span key={chip} style={styles.chip}>
                          {chip}
                        </span>
                      ))}
                    </span>
                  )}
                  <div style={styles.roomActions}>
                    {tab === "open" ? (
                      <button
                        type="button"
                        style={{ ...styles.primaryButton, ...(busy || full ? styles.disabled : {}) }}
                        disabled={busy || full}
                        onClick={() => onJoin(room.code)}
                        title={full ? `This table is full (${room.seatCap} seats).` : `Take a seat at ${room.hostNickname}'s table.`}
                        data-testid={`join-room-${room.code}`}
                      >
                        {full ? "Full" : "Join"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        style={{ ...styles.secondaryButton, ...(busy ? styles.disabled : {}) }}
                        disabled={busy}
                        onClick={() => onSpectate(room.code)}
                        title="Watch this game. You will not have a seat."
                        data-testid={`watch-room-${room.code}`}
                      >
                        Watch
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div style={styles.footer}>
          <button type="button" style={styles.secondaryButton} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default JoinGameCard;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 4200,
    pointerEvents: "auto", // #1360
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
    overflowY: "auto",
  },
  card: {
    width: "min(640px, 100%)",
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
  tabs: { display: "flex", gap: "6px", borderBottom: "1px solid #2a2a2a", paddingBottom: "6px" },
  tab: {
    padding: "5px 12px",
    borderRadius: RADIUS.card,
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "#a8a6a0",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
  tabSelected: { borderColor: "#3a3a3a", backgroundColor: "#1c1c1c", color: "#f2f0eb" },
  list: { display: "flex", flexDirection: "column", gap: "8px", minHeight: "80px" },
  room: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 12px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
  },
  roomHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px" },
  roomTitle: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  roomType: { fontSize: FONT_SIZE.body, fontWeight: 800 },
  roomMeta: { fontSize: FONT_SIZE.micro, color: "#8a8a86", letterSpacing: "0.02em" },
  seats: { fontSize: FONT_SIZE.small, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "#c8c6c0", whiteSpace: "nowrap" },
  roster: { fontSize: FONT_SIZE.small, color: "#c8c6c0", lineHeight: 1.4 },
  chips: { display: "flex", flexWrap: "wrap", gap: "4px" },
  chip: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "2px 7px",
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    color: "#a8a6a0",
  },
  roomActions: { display: "flex", justifyContent: "flex-end", gap: "6px" },
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
  disabled: { borderColor: "#3a3a3a", backgroundColor: "#1c1c1c", color: "#6e6c68", cursor: "not-allowed" },
};
