// frontend/src/utils/lobby.ts
//
// The off-chain half of the pre-game lobby: room discovery, seat claiming, readiness, and heartbeat presence.
// In `utils/` rather than `components/` for the same reason `gameState.ts` is -- a data layer with subscription
// hooks, consumed by a view. A component must never be the place a transport lives.
//
// Design note #0: WHAT IS AND IS NOT AUTHORITATIVE HERE. Everything is off-chain staging data with one job:
// getting a group agreed on who is playing BEFORE any real JUNO moves. staging is the game server only, at zero
// gas and with an entirely unconfigured chain; launching is a transient state held so others see "Launching..."
// rather than a frozen room; live means `chainGameId` is bound and the contract is the source of truth.
// `seatCount`/`ready`/`displayName` are staging conveniences and are NOT consulted once a room is live -- a
// player holding a staging seat who never anted is not in the contract's roster and cannot act.
//
// Design note #1: PRESENCE IS A HEARTBEAT, AND IS CLOCK-SKEW-IMMUNE. Detection is DELAYED by up to the stale
// window; a backgrounded tab is throttled, which the 3x window and a `visibilitychange` heartbeat tolerate; and
// THIS IS A UI HINT ONLY -- the contract's own Inactivity Timeout Safety Valve is the only mechanism permitted
// to have consequences. Staleness is measured against the NEWEST `lastSeen` in the room, not the local clock:
// every stamp is the server's, so comparing them to `Date.now()` would let a skewed machine see the whole table
// as dropped.
//
// #1361b: THE TRANSPORT IS THE GAME SERVER, over the room-doc socket (`roomDocLink`). It was Firestore; the
// record and every write it accepts are in `lobbyProtocol.ts`, and the server applies each write under the
// rule the Firestore transaction used to carry. The hooks and mutations below keep their exact signatures, so
// `Lobby.tsx` is unchanged.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type GameVariants } from "./gameVariants";
import { backendConfigError } from "../config/backend";
import {
  LOBBY_ROOM_KEY,
  dropStanding,
  roomDocOnServer,
  sendFrame,
  sendStanding,
  subscribeFrame,
} from "./roomDocLink";
import { localPlayerId } from "./seatPin";
import type {
  LobbyAckFrame,
  LobbyFrame,
  LobbyRoomFrame,
  LobbyWrite,
  RoomDoc,
  RoomStatus,
  SeatDoc,
} from "./lobbyProtocol";

export type { RoomDoc, RoomStatus, SeatDoc } from "./lobbyProtocol";
export { ROOM_LIST_LIMIT } from "./lobbyProtocol";

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

export type PresenceState = "online" | "dropped";

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
export function seatLabel(seat: Pick<SeatDoc, "address" | "displayName">): string {
  return normalizeDisplayName(seat.displayName ?? "") ?? truncateAddress(seat.address);
}

/* ------------------------------------------------------------------ */
/* Presence derivation -- design note #1                               */
/* ------------------------------------------------------------------ */

/** Classifies every seat as online or dropped, measuring against the newest `lastSeen` in the room rather than
 *  the local clock. A `null` timestamp means a write still pending locally -- only possible for a doc THIS
 *  client just wrote, i.e. one that is alive by definition. Treated as online, never as stale, so a player
 *  never briefly sees themselves as dropped in the moment they join. */
export function derivePresence(seats: readonly SeatDoc[]): Map<string, PresenceState> {
  const stamps = seats
    .map((seat) => seat.lastSeenMs)
    .filter((value): value is number => value !== null);
  const reference = stamps.length > 0 ? Math.max(...stamps) : 0;

  const result = new Map<string, PresenceState>();
  for (const seat of seats) {
    if (seat.lastSeenMs === null) {
      result.set(seat.address, "online");
      continue;
    }
    result.set(seat.address, reference - seat.lastSeenMs > PRESENCE_STALE_MS ? "dropped" : "online");
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

function unavailableMessage(): string {
  return backendConfigError() ?? "[server] The game server is unavailable.";
}

/** #1361b: the lobby rides the lobby connection (#1355), keyed by no room. The claim is this tab's id. */
const lobbyClaim = () => localPlayerId();

export interface LobbyRoomsResult {
  rooms: RoomDoc[];
  loading: boolean;
  /** Non-null means the list could not be loaded. Show it -- an empty list
   *  and a broken list look identical otherwise, and the second one lies. */
  error: string | null;
  /** `false` when the game server is unconfigured, so the UI can say so plainly
   *  instead of rendering a permanently empty lobby. */
  available: boolean;
}

/** Live subscription to the room-discovery list. The server sends every room it holds, newest first, minus the
 *  closed ones; the client-side filter stays as a belt to the server's braces. */
export function useLobbyRooms(): LobbyRoomsResult {
  const [rooms, setRooms] = useState<RoomDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const available = roomDocOnServer();

  useEffect(() => {
    if (!available) {
      setRooms([]);
      setLoading(false);
      setError(unavailableMessage());
      return;
    }

    setLoading(true);
    const claim = lobbyClaim();
    const unsubscribe = subscribeFrame<LobbyFrame>(
      LOBBY_ROOM_KEY,
      claim,
      "lobby",
      (frame) => {
        setRooms((Array.isArray(frame.rooms) ? frame.rooms : []).filter((room) => room.status !== "closed"));
        setLoading(false);
        setError(null);
      },
      (message) => {
        setLoading(false);
        setError(`[server] Could not load the room list: ${message}`);
      },
    );
    /* A standing subscription: said again after every reconnect, so a dropped tunnel does not leave a lobby
       that never updates. */
    sendStanding(LOBBY_ROOM_KEY, claim, "lobby-hello", { kind: "lobby-hello" });

    return () => {
      unsubscribe();
      dropStanding(LOBBY_ROOM_KEY, "lobby-hello");
    };
  }, [available]);

  return { rooms, loading, error, available };
}

export interface RoomResult {
  room: RoomDoc | null;
  seats: SeatDoc[];
  presence: Map<string, PresenceState>;
  loading: boolean;
  error: string | null;
}

/** Live subscription to one room and its seats. One frame carries both; the seat list is sorted by join time
 *  so it does not reshuffle on every heartbeat. */
export function useRoom(roomId: string | null): RoomResult {
  const [room, setRoom] = useState<RoomDoc | null>(null);
  const [seats, setSeats] = useState<SeatDoc[]>([]);
  const [loading, setLoading] = useState(roomId !== null);
  const [error, setError] = useState<string | null>(null);

  const available = roomDocOnServer();

  useEffect(() => {
    if (!roomId) {
      setRoom(null);
      setSeats([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (!available) {
      setLoading(false);
      setError(unavailableMessage());
      return;
    }

    setLoading(true);
    const claim = lobbyClaim();
    const unsubscribe = subscribeFrame<LobbyRoomFrame>(
      LOBBY_ROOM_KEY,
      claim,
      "lobby-room",
      (frame) => {
        if (frame.roomId !== roomId) return;
        setRoom(frame.room ?? null);
        setSeats([...(Array.isArray(frame.seats) ? frame.seats : [])].sort((a, b) => a.joinedAtMs - b.joinedAtMs));
        setLoading(false);
        setError(null);
      },
      (message) => {
        setLoading(false);
        setError(`[server] Could not load the room: ${message}`);
      },
    );
    sendStanding(LOBBY_ROOM_KEY, claim, "lobby-watch", { kind: "lobby-watch", roomId });

    return () => {
      unsubscribe();
      dropStanding(LOBBY_ROOM_KEY, "lobby-watch");
      sendFrame(LOBBY_ROOM_KEY, claim, { kind: "lobby-watch", roomId: null });
    };
  }, [available, roomId]);

  const presence = useMemo(() => derivePresence(seats), [seats]);

  return { room, seats, presence, loading, error };
}

/* ------------------------------------------------------------------ */
/* Heartbeat -- design note #1                                         */
/* ------------------------------------------------------------------ */

/** Keeps this player's own seat marked alive for as long as the component is mounted with a seat in the room.
 *  Deliberately usable from BOTH the lobby and the live game: a table needs to know the active turn-holder has
 *  dropped far more urgently mid-game than while waiting in a staging room.
 *  Writes are fire-and-forget. A failed heartbeat is not worth surfacing -- it self-corrects on the next tick,
 *  and the failure it most often indicates (offline) is one the player can already see. */
export function usePresenceHeartbeat(roomId: string | null, address: string | null): void {
  const available = roomDocOnServer();
  // Held in a ref so `beat` stays referentially stable and the effect below
  // does not tear down and re-establish its interval on every render.
  const targetRef = useRef<{ roomId: string; address: string } | null>(null);
  targetRef.current = roomId && address ? { roomId, address } : null;

  const beat = useCallback(() => {
    const target = targetRef.current;
    if (!available || !target) return;
    void write({ op: "heartbeat", roomId: target.roomId, address: target.address }).catch(() => {
      /* see doc comment -- self-correcting, not worth surfacing */
    });
  }, [available]);

  useEffect(() => {
    if (!available || !roomId || !address) return;

    beat(); // immediately, so a fresh seat is never briefly "dropped"
    const interval = window.setInterval(beat, PRESENCE_HEARTBEAT_MS);

    // Design note #1: browsers throttle timers in hidden tabs, so a player
    // returning to the tab could otherwise show as dropped to everyone else
    // for up to a full stale window. Beat on the way back in.
    const onVisibility = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [available, roomId, address, beat]);
}

// Mutations. Every one throws on failure rather than returning an error value: they are all invoked from an
// explicit user action, so there is always a handler in a position to catch and display -- the same "throw at
// the point of use, where the UI is alive to show it" rule `config.ts #0` sets out.

/** #1361b: how long a write may wait for its answer before it is reported as lost. Generous: the wire may
 *  be a tunnel (#1358). */
export const LOBBY_WRITE_TIMEOUT_MS = 12_000;

/** One write, one answer. Resolves with the ack; rejects with the server's sentence when it refused. */
function write(payload: LobbyWrite): Promise<LobbyAckFrame> {
  if (!roomDocOnServer()) return Promise.reject(new Error(unavailableMessage()));
  const claim = lobbyClaim();
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<LobbyAckFrame>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      unsubscribe();
      fn();
    };
    const unsubscribe = subscribeFrame<LobbyAckFrame>(LOBBY_ROOM_KEY, claim, "lobby-ack", (frame) => {
      if (frame.requestId !== requestId) return;
      finish(() => (frame.ok ? resolve(frame) : reject(new Error(frame.reason ?? "The server refused that."))));
    });
    const timer = window.setTimeout(
      () => finish(() => reject(new Error("The game server did not answer. Check the connection and try again."))),
      LOBBY_WRITE_TIMEOUT_MS,
    );
    sendFrame(LOBBY_ROOM_KEY, claim, { kind: "lobby-write", requestId, write: payload });
  });
}

export interface CreateRoomInput {
  name: string;
  maxPlayers: number;
  hostAddress: string;
  hostDisplayName: string;
  /** Base-denom integer strings -- see `RoomDoc.anteUjuno`. */
  anteUjuno: string;
  virtualBankStart: string;
  /** Design note #902: the house rules the host chose. Stored on the room so joining players can SEE them
   *  before they sit down -- a table's variants are part of what somebody is agreeing to when they take a
   *  seat, and finding out after the deal is not a choice. */
  variants: GameVariants;
}

/** Creates a STAGING room. Touches no chain and costs no gas -- see design
 *  note #0 on why the on-chain room is deferred until launch. Returns the
 *  new room id; the server seats the host in the same step. */
export async function createStagingRoom(input: CreateRoomInput): Promise<string> {
  const maxPlayers = Math.min(
    maxPlayersForVariants(input.variants),
    Math.max(MIN_PLAYERS, Math.round(input.maxPlayers)),
  );
  const name = input.name.trim().slice(0, 48) || "Untitled room";
  const answer = await write({
    op: "create-room",
    name,
    maxPlayers,
    hostAddress: input.hostAddress,
    hostDisplayName: input.hostDisplayName,
    anteUjuno: input.anteUjuno,
    virtualBankStart: input.virtualBankStart,
    variants: input.variants,
  });
  if (!answer.roomId) throw new Error("The server created the room but did not say which.");
  return answer.roomId;
}

/** Claims a seat. The server checks capacity and writes the seat in one step, so two players clicking Join on
 *  the last seat at the same moment cannot both win it. Re-claiming a seat you already hold is a no-op refresh,
 *  not an error: reloading the page mid-staging must not read as an attempt to take a second seat. */
export async function claimSeat(
  roomId: string,
  address: string,
  displayName: string,
  asHost = false,
): Promise<void> {
  await write({ op: "claim-seat", roomId, address, displayName, asHost });
}

/** Releases a seat, decrementing the counter in the same step that deletes it -- otherwise a room leaks
 *  capacity every time someone leaves and eventually reads as full with visibly empty seats. */
export async function releaseSeat(roomId: string, address: string): Promise<void> {
  await write({ op: "release-seat", roomId, address });
}

export async function setSeatReady(roomId: string, address: string, ready: boolean): Promise<void> {
  await write({ op: "set-ready", roomId, address, ready });
}

export async function setSeatDisplayName(roomId: string, address: string, displayName: string): Promise<void> {
  await write({ op: "set-display-name", roomId, address, displayName });
}

/** Marks a seat as having completed its on-chain ante. Called only after a
 *  `JoinGameRoom` transaction has actually confirmed -- never optimistically,
 *  because a seat that claims to be on-chain and is not would show the table
 *  a full roster for a game the contract will not let that player act in. */
export async function markSeatOnChain(roomId: string, address: string): Promise<void> {
  await write({ op: "mark-on-chain", roomId, address });
}

export async function setRoomStatus(roomId: string, status: RoomStatus, launchError: string | null = null): Promise<void> {
  await write({ op: "set-status", roomId, status, launchError });
}

/** Binds the room to the game id the CONTRACT assigned, flipping it live. `chainGameId` is write-once: the
 *  server refuses a second bind. It is the single field in this schema that other clients act on without
 *  verifying -- they pass it to `GetGameState` -- so it is the single field worth protecting hardest. Even so,
 *  the blast radius of a bad value is a failed or wrong query, not a corrupted game: the contract cannot be
 *  talked into agreeing. */
export async function bindChainGameId(roomId: string, chainGameId: number): Promise<void> {
  if (!Number.isSafeInteger(chainGameId) || chainGameId < 0) {
    throw new Error(`Refusing to bind a non-integer on-chain game id: ${chainGameId}`);
  }
  await write({ op: "bind-chain-game-id", roomId, chainGameId });
}
