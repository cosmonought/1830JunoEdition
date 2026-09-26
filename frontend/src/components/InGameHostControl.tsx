// frontend/src/components/InGameHostControl.tsx
//
// ==================================================================
//  LIVE-2E: HANDING THE HOST ROLE ON DURING A GAME
// ==================================================================
//
// LIVE-2D's reachability audit found `transfer-host` server-reachable during an active game (roomAuthz: the host, in
// the waiting, active and held stages) with no control once the board was up -- a host who had to leave mid-game
// could not hand the table on. This is that control. It is the same named op as the waiting room's "Make host",
// asked twice (a pick, then a confirm), and the server stays the authority: a refusal is shown by the shell like
// any room refusal.
//
// WHAT MOVES WITH THE ROLE (the only gameplay-adjacent power the host holds after the deal): the host's undo reach
// over another seat's last action (`UndoPolicy.host_undo`), read by the server from the GameRecord at each submit.
// Nothing is written to the game log -- the host is room administration, not a move.
//
// NEVER AUTOMATIC. A disconnect or a closed browser does not hand the role on; the host keeps the seat, and signing
// back in brings the same seat -- and the role -- back.

import React, { useState } from "react";

import type { RoomView } from "../utils/roomProtocol";

export interface InGameHostControlProps {
  room: RoomView | null;
  busy: boolean;
  onTransferHost: (playerId: string) => void;
}

export function InGameHostControl({ room, busy, onTransferHost }: InGameHostControlProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  if (room === null || room.you.role !== "host" || room.lifecycle !== "active") return null;
  const others = room.players.filter((player) => player.id !== room.hostId);
  if (others.length === 0) return null;
  const chosenName = others.find((player) => player.id === chosen)?.nickname ?? null;
  return (
    <span style={styles.wrap} data-testid="ingame-host-control">
      {!open ? (
        <button
          type="button"
          style={styles.button}
          onClick={() => setOpen(true)}
          disabled={busy}
          title="Hand the host role to another seated player. Their undo reach over other players' last actions goes with it."
          data-testid="ingame-host-open"
        >
          Host ⇄
        </button>
      ) : chosen === null ? (
        <span style={styles.panel} role="group" aria-label="Make another player the host">
          <span style={styles.label}>Make host:</span>
          {others.map((player) => (
            <button
              key={player.id}
              type="button"
              style={styles.button}
              disabled={busy}
              onClick={() => setChosen(player.id)}
              data-testid={`ingame-host-pick-${player.id}`}
            >
              {player.nickname}
            </button>
          ))}
          <button type="button" style={styles.button} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <span style={styles.panel} role="group" aria-label="Confirm the new host">
          <span style={styles.label}>Make {chosenName} the host?</span>
          <button
            type="button"
            style={styles.button}
            disabled={busy}
            onClick={() => {
              const to = chosen;
              setChosen(null);
              setOpen(false);
              onTransferHost(to);
            }}
            data-testid="ingame-host-confirm"
          >
            Make host
          </button>
          <button type="button" style={styles.button} onClick={() => setChosen(null)}>
            Keep
          </button>
        </span>
      )}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8 },
  panel: { display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  label: { fontSize: 12, opacity: 0.85 },
  button: {
    fontSize: 12,
    padding: "2px 8px",
    borderRadius: 4,
    border: "1px solid rgba(255,255,255,0.35)",
    background: "rgba(255,255,255,0.08)",
    color: "inherit",
    cursor: "pointer",
  },
};
