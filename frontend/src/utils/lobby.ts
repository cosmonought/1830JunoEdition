// frontend/src/utils/lobby.ts
//
// The lobby's data layer: the public table list, and the small display helpers the lobby and chat share. In `utils/`
// rather than `components/` for the same reason `gameState.ts` is -- a data layer with subscription hooks, consumed
// by a view. A component must never be the place a transport lives.
//
// ==================================================================
//  LIVE-2D: ONE LIST, THE SERVER'S -- THE STAGING LOBBY IS DELETED
// ==================================================================
//
// This file used to carry two lobbies on the legacy room socket: the parked on-chain STAGING lobby (rooms, seats,
// wallet heartbeats, `create-room` / `claim-seat` / `mark-on-chain` / `bind-chain-game-id` writes -- LIVE-0 had
// switched it off; RUST-RETIRE-1 2B.3 scheduled its deletion here) and the public sandbox list, which rode the
// staging lobby's `lobby-hello`. Both frames are gone from the protocol. The public list is `rooms-watch` now: the
// server's `RoomSummary` of every PUBLIC table that is waiting or playing, newest first -- names yes, ids no (beyond
// the game id and the code), and never a private table.

import { useEffect, useState } from "react";
import { type GameVariants } from "../gameEngine/gameVariants";
import { backendConfigError } from "../config/backend";
import { roomLinkAvailable, roomOp, watchPublicRooms } from "./roomLink";
import { myTablesOf, refusalMessage, type MyTableSummary, type RoomSummary } from "./roomProtocol";

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** How often each client re-stamps its own seat's `lastSeen`. */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/** How long a seat may go unseen before it is shown as dropped. 3x the
 *  heartbeat -- see design note #1 on background-tab throttling. */
export const PRESENCE_STALE_MS = 60_000;

/** The contract's own bounds -- `msg.rs`'s `CreateGameRoom { max_players }`
 *  doc comment ("2-6"). Mirrored here ONLY to keep the UI from offering a
 *  choice the contract will reject; the contract still validates. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
/** Design note #1320: the Level Playing Field seats seven. The contract's own bound is still 2-6 and is a
 *  Phase 5 question; the room document is where a sandbox table's size lives today. */
export const LPF_MAX_PLAYERS = 7;

/** The largest table a room with these variants may be created for. */
export function maxPlayersForVariants(variants: Pick<GameVariants, "levelPlayingField"> | null | undefined): number {
  return variants?.levelPlayingField ? LPF_MAX_PLAYERS : MAX_PLAYERS;
}

const DISPLAY_NAME_STORAGE_KEY = "18cosmos.display_name.v1";
const MAX_DISPLAY_NAME_LENGTH = 24;

// Display names are self-asserted and spoofable: the local-play identity believes what it is told (#1210), so
// nothing stops a client writing any name it likes. THE WALLET ADDRESS therefore remains the real identity
// everywhere identity matters -- turn order, ownership, payouts -- all of which are on-chain anyway and never
// read this field. A display name is a readability affordance for chat and the seat list, which is why both
// surfaces still show the truncated address alongside it.

/** Trims, collapses whitespace and clamps to a sane length. Rejects the
 *  empty string by returning `null`, so callers fall back to the address. */
export function normalizeDisplayName(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
  return cleaned.length === 0 ? null : cleaned;
}

/** The name this browser last used, if any. Persisted in `localStorage`
 *  (not `sessionStorage`) deliberately -- unlike the ephemeral session key
 *  in `sessionKey.ts`, a display name should survive closing the tab. */
export function loadDisplayName(): string | null {
  try {
    return normalizeDisplayName(window.localStorage.getItem(DISPLAY_NAME_STORAGE_KEY) ?? "");
  } catch {
    // Private browsing / disabled storage. Not worth failing over.
    return null;
  }
}

export function saveDisplayName(name: string): void {
  const normalized = normalizeDisplayName(name);
  try {
    if (normalized) window.localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, normalized);
    else window.localStorage.removeItem(DISPLAY_NAME_STORAGE_KEY);
  } catch {
    /* ignore -- see loadDisplayName */
  }
}

/** Shortens a `juno1...` address for display. Same 8/4 split as
 *  `feed.ts`'s `truncateChatAddress`, kept consistent so one player reads
 *  as the same string in the seat list and in chat. */
export function truncateAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

/** The label to show for a seat: the display name when set, otherwise the
 *  truncated address. Never returns an empty string. */
export function seatLabel(seat: { address: string; displayName?: string | null }): string {
  return normalizeDisplayName(seat.displayName ?? "") ?? truncateAddress(seat.address);
}

/* ------------------------------------------------------------------ */
/* The public list -- LIVE-2D                                          */
/* ------------------------------------------------------------------ */

function unavailableMessage(): string {
  return backendConfigError() ?? "[server] The game server is unavailable.";
}

export interface PublicRoomsResult {
  rooms: RoomSummary[];
  loading: boolean;
  error: string | null;
  available: boolean;
}

/** The public table list (`rooms-watch`), pushed by the server on every change (coalesced to one a second). */
export function usePublicRooms(): PublicRoomsResult {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const available = roomLinkAvailable();

  useEffect(() => {
    if (!available) {
      setRooms([]);
      setLoading(false);
      setError(unavailableMessage());
      return undefined;
    }
    setLoading(true);
    return watchPublicRooms(
      (next) => {
        setRooms(next);
        setLoading(false);
        setError(null);
      },
      (message) => {
        setLoading(false);
        setError(`Could not load the game list. ${message}`);
      },
    );
  }, [available]);

  return { rooms, loading, error, available };
}

/* ------------------------------------------------------------------ */
/* "Your tables" -- LIVE-2F/3D (C9-01)                                 */
/* ------------------------------------------------------------------ */

/** How often an open lobby asks again (and whenever the page becomes visible). A read, on the lobby channel. */
export const MY_TABLES_REFRESH_MS = 60_000;
/** The least time between two asks a page's return to view may cause. */
export const MY_TABLES_VISIBLE_MIN_MS = 15_000;

export interface MyTablesResult {
  tables: MyTableSummary[];
  error: string | null;
}

/** The tables this profile is seated at, from the server (`room-op {type:"my-tables"}`) -- the way back to a seat
 *  from any tab, device or browser the profile is signed in on. */
export function useMyTables(): MyTablesResult {
  const [tables, setTables] = useState<MyTableSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const available = roomLinkAvailable();

  useEffect(() => {
    if (!available) {
      setTables([]);
      return undefined;
    }
    let live = true;
    void roomOp({ type: "my-tables" }).then((answer) => {
      if (!live) return;
      if (answer.ok) {
        setTables(myTablesOf(answer.data));
        setError(null);
      } else if (answer.code !== "rate-limited") {
        setError(`Could not load your tables. ${refusalMessage(answer.code, answer.reason)}`);
      }
    });
    return () => {
      live = false;
    };
  }, [available, asked]);

  useEffect(() => {
    if (!available) return undefined;
    let lastAsked = Date.now();
    const ask = () => {
      lastAsked = Date.now();
      setAsked((count) => count + 1);
    };
    const timer = setInterval(ask, MY_TABLES_REFRESH_MS);
    /* A page coming back asks again -- at most every 15 s (independent review IR-08): the read shares the lobby socket's
       room-op budget with Create and Join, and tab-switching must never spend it. */
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible" && Date.now() - lastAsked >= MY_TABLES_VISIBLE_MIN_MS) ask();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  }, [available]);

  return { tables, error };
}
