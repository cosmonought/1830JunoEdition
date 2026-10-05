// frontend/src/components/GameClockChip.tsx
//
/* ==================================================================
    PHASE 3 LANE A (AUD-11.04 / U-10): THE GAMEPLAY CLOCK IN THE ROOM STRIP
   ==================================================================
   One small chip beside the strip's other standing facts: the table's mode (Live / Async), whose turn is being timed, and
   the server's figure -- time left, or time on the turn when no limit is set -- with "paused" or "Time expired" when that
   is the state. It does not dominate the table: no modal, no sound, no flashing, no live-region chatter (the figure is a
   `timer`, which screen readers do not announce on every tick); the tooltip carries the one sentence of detail.

   THE SERVER IS THE CLOCK (`gameClockView.ts`): the chip counts on from the server's view by the MONOTONIC time since it
   arrived and shows no figure at all while this tab is not current -- its room link down, its board not the room's, a
   catch-up running, or a clock naming a seat the board on screen does not.

   THE HOST'S PAUSE / RESUME pauses the CLOCK, never the game, and names the clock revision this tab saw: a stale tab is
   refused (`clock-stale`) and simply shows the server's clock again when it next arrives. Expiry is never a forfeit:
   "Time expired", and play continues. */

import React, { useEffect, useMemo, useState } from "react";

import { styles } from "../styles/appStyles";
import { CLOCK_PAUSE_OP, CLOCK_RESUME_OP, type RoomClockView } from "../utils/clockProtocol";
import { presentClock, type ClockTone } from "../utils/gameClockView";
import { roomOp, roomViewReceivedAt, watchRoomLink } from "../utils/roomLink";
import type { RoomViewPlayer } from "../utils/roomProtocol";

export interface GameClockChipProps {
  gameId: string;
  clock: RoomClockView | undefined;
  players: readonly RoomViewPlayer[];
  viewerPlayerId: string | null;
  isHost: boolean;
  /** This tab's own currency: no connection notice standing, the board the room's, no catch-up. */
  current: boolean;
  /** The acting seat on the board this tab has applied (`actingAddress`), or `null`. */
  boardSeat: string | null;
  /** TESTS: a monotonic clock (`performance.now` when absent). */
  monotonic?: () => number;
  /** TESTS: the op sender (`roomOp` when absent). */
  sendOp?: typeof roomOp;
  /** TESTS: the room-link watcher (`watchRoomLink` when absent). */
  watchLink?: typeof watchRoomLink;
  /** TESTS: when the newest room view arrived, on the `monotonic` clock (`roomViewReceivedAt` when absent). */
  receivedAtOf?: (gameId: string) => number | null;
}

const TONE_STYLE: Record<ClockTone, React.CSSProperties> = {
  normal: { borderColor: "#3a3a3a", color: "#d8d5ce" },
  warning: { borderColor: "#6b5a24", color: "#d9b95c" },
  expired: { borderColor: "#6b3a34", color: "#f0b0a8" },
  muted: { borderColor: "#2a2a2a", color: "#8a8780" },
};

const chipStyle: React.CSSProperties = {
  ...styles.forcedSignChip,
  cursor: "default",
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  fontVariantNumeric: "tabular-nums",
};

const modeStyle: React.CSSProperties = { opacity: 0.75, fontWeight: 700 };

const buttonStyle: React.CSSProperties = {
  font: "inherit",
  fontSize: "inherit",
  fontWeight: 700,
  padding: "0 6px",
  marginLeft: "2px",
  borderRadius: "999px",
  border: "1px solid #3a3a3a",
  backgroundColor: "#1c1c1c",
  color: "#d8d5ce",
  cursor: "pointer",
};

const defaultMonotonic = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

export function GameClockChip({ gameId, clock, players, viewerPlayerId, isHost, current, boardSeat, monotonic = defaultMonotonic, sendOp = roomOp, watchLink = watchRoomLink, receivedAtOf = roomViewReceivedAt }: GameClockChipProps) {
  /* When this view of the clock ARRIVED (monotonic): the room link's own receipt time of the frame that carried it (a
     view replayed from the link's cache to a newly mounted chip is as old as its frame -- review finding 6), else now. */
  const arrivedAt = () => receivedAtOf(gameId) ?? monotonic();
  const [seen, setSeen] = useState<{ clock: RoomClockView | undefined; at: number }>(() => ({ clock, at: arrivedAt() }));
  if (seen.clock !== clock) setSeen({ clock, at: arrivedAt() });
  const receivedAt = seen.clock === clock ? seen.at : arrivedAt();
  const [, setTick] = useState(0);
  const [linkOpen, setLinkOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => watchLink(gameId, setLinkOpen), [gameId, watchLink]);

  const nameOf = useMemo(() => {
    const names = new Map(players.map((player) => [player.id, player.nickname] as const));
    return (playerId: string) => names.get(playerId) ?? "Another player";
  }, [players]);

  const presentation = presentClock({
    clock,
    sinceReceiptMs: monotonic() - receivedAt,
    current: current && linkOpen,
    boardSeat,
    viewerPlayerId,
    isHost,
    nameOf,
  });

  /* Re-render once a second while the figure moves; nothing runs while it does not. */
  useEffect(() => {
    if (!presentation.ticking) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [presentation.ticking]);

  /* A refusal is about the clock it was sent against: a newer clock retires it. */
  useEffect(() => setRefusal(null), [clock?.revision]);

  if (!presentation.visible || clock === undefined) return null;

  const press = (type: typeof CLOCK_PAUSE_OP | typeof CLOCK_RESUME_OP) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    void sendOp({ type, revision: clock.revision }, gameId).then((answer) => {
      setBusy(false);
      if (!answer.ok) setRefusal(answer.reason);
    });
  };

  const title = [presentation.detail, refusal].filter((line): line is string => line !== null && line !== "").join(" ") || undefined;

  return (
    <span style={{ ...chipStyle, ...TONE_STYLE[presentation.tone] }} title={title} data-testid="game-clock" data-state={presentation.state} data-mode={clock.mode}>
      <span style={modeStyle} data-testid="game-clock-mode">
        {presentation.modeLabel}
      </span>
      <span aria-hidden="true">·</span>
      <span data-testid="game-clock-label">{presentation.label}</span>
      {presentation.value !== null && (
        <span role="timer" aria-label={`${presentation.label}: ${presentation.value}`} data-testid="game-clock-value">
          {presentation.value}
        </span>
      )}
      {presentation.canPause && (
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => press(CLOCK_PAUSE_OP)} data-testid="game-clock-pause" title="Pause the clock (the game itself is not paused)">
          Pause clock
        </button>
      )}
      {presentation.canResume && (
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => press(CLOCK_RESUME_OP)} data-testid="game-clock-resume">
          Resume clock
        </button>
      )}
      {refusal !== null && (
        <span role="status" style={{ color: "#f0b0a8" }} data-testid="game-clock-refusal">
          {refusal}
        </span>
      )}
    </span>
  );
}

export default GameClockChip;
