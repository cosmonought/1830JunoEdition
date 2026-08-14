// frontend/src/utils/lobby.ts
//
// The off-chain half of the pre-game lobby: room discovery, seat claiming,
// readiness, and heartbeat presence. Lives in `utils/` (not `components/`)
// for the same reason `utils/gameState.ts` does -- it is a data layer with
// subscription hooks, consumed by a view, and `utils/feed.ts`'s own note
// about dependencies running the wrong way applies here too: a component
// must never be the place a transport lives.
//
// ===================================================================
//  DESIGN NOTE 0: WHAT IS AND IS NOT AUTHORITATIVE HERE
// ===================================================================
//
// Read `config/firebase.ts` design note #0 first. Everything in this file
// is off-chain staging data with exactly one job: getting a group of
// players agreed on who is playing BEFORE any real JUNO moves. Once the
// host launches, the contract takes over completely and this data becomes
// a directory entry.
//
// The lifecycle, and which system owns each step:
//
//   staging   Firestore only. Players discover the room, claim seats, chat
//             and toggle Ready. ZERO gas, no contract, works with an
//             entirely unconfigured chain. This is the phase that exists to
//             stop dead on-chain rooms being created for games that never
//             fill.
//   launching The host has broadcast `CreateGameRoom` and is awaiting the
//             tx. A transient state, held so the other players see
//             "Launching..." instead of a room that appears frozen.
//   live      `chainGameId` is bound. The contract is now the source of
//             truth. Non-host players ante in via `JoinGameRoom` and their
//             seat is marked `onChain`.
//   closed    Host cancelled, or the game ended.
//
// `seatCount`/`ready`/`displayName` are staging conveniences and are NOT
// consulted once a room is live -- the on-chain `player_addresses` from
// `GetGameState` is the real roster from that point on. A player who
// somehow holds a Firestore seat but never anted simply is not in the
// contract's roster and cannot act; Firestore cannot grant them a turn.
//
// ===================================================================
//  DESIGN NOTE 1: PRESENCE IS A HEARTBEAT, AND IS CLOCK-SKEW-IMMUNE
// ===================================================================
//
// HONEST LIMITATION, read this before relying on presence. Cloud Firestore
// has NO `onDisconnect` primitive -- that is Realtime Database, a different
// product. There is therefore no way to learn that a browser closed; the
// only thing available is "this client stopped saying it was alive."
//
// So presence here is: each player writes `lastSeen` to their own seat doc
// every PRESENCE_HEARTBEAT_MS, and a seat unseen for PRESENCE_STALE_MS is
// shown as dropped. Consequences worth stating rather than discovering:
//
//   - Detection is DELAYED by up to PRESENCE_STALE_MS. A player who closes
//     their laptop reads as online for up to a minute.
//   - A backgrounded tab is throttled by the browser (`setInterval` in a
//     hidden tab is clamped, often to >=1/minute). PRESENCE_STALE_MS is set
//     to 3x the heartbeat specifically to tolerate that, and the heartbeat
//     also fires on `visibilitychange` so returning to the tab clears a
//     false "dropped" immediately instead of waiting for the next tick.
//   - This is a UI HINT ONLY. It must never gate a game action. The
//     contract has its own on-chain Inactivity Timeout Safety Valve
//     (`state::PLAYER_JUNO_ANTE` / `execute_claim_timeout_refund`) and that
//     is the only mechanism permitted to have consequences for a player who
//     disappears. Presence tells the table why nobody is moving; the
//     contract decides what to do about it.
//
// Staleness is measured against the NEWEST `lastSeen` in the room, not
// against the local clock. `lastSeen` is a `serverTimestamp()`, so every
// value comes from one clock (Google's), while `Date.now()` on the
// observer's machine is a different and possibly badly-skewed clock.
// Comparing the two would let a user with a wrong system time see the whole
// table as dropped, or a genuinely dropped player as online. Since the
// observer is themselves heartbeating, the newest server timestamp in the
// room IS approximately "now" on the server clock -- so comparing server
// times to server times is both simpler and correct. See
// `derivePresence` below.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Timestamp,
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  type DocumentData,
  type FirestoreError,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

import {
  CHAT_SUBCOLLECTION,
  ROOMS_COLLECTION,
  SEATS_SUBCOLLECTION,
  firebaseConfigError,
  getFirestoreDb,
} from "../config/firebase";

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** How often each client re-stamps its own seat's `lastSeen`. */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/** How long a seat may go unseen before it is shown as dropped. 3x the
 *  heartbeat -- see design note #1 on background-tab throttling. */
export const PRESENCE_STALE_MS = 60_000;

/** How many rooms the discovery list subscribes to. Bounded because this is
 *  a live listener: an unbounded `games/` subscription bills for, and
 *  re-renders on, every room anyone has ever created. */
export const ROOM_LIST_LIMIT = 60;

/** The contract's own bounds -- `msg.rs`'s `CreateGameRoom { max_players }`
 *  doc comment ("2-6"). Mirrored here ONLY to keep the UI from offering a
 *  choice the contract will reject; the contract still validates. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

const DISPLAY_NAME_STORAGE_KEY = "18cosmos.display_name.v1";
const MAX_DISPLAY_NAME_LENGTH = 24;

/* ------------------------------------------------------------------ */
/* Document shapes                                                     */
/* ------------------------------------------------------------------ */

export type RoomStatus = "staging" | "launching" | "live" | "closed";

/** One row in the room-discovery list -- `games/{roomId}`. */
export interface RoomDoc {
  /** Firestore document id. NOT the on-chain game id -- see `chainGameId`. */
  id: string;
  name: string;
  hostAddress: string;
  hostDisplayName: string;
  maxPlayers: number;
  /** Maintained transactionally alongside the seat docs -- see
   *  `claimSeat`. Denormalised because a Firestore transaction cannot run a
   *  collection query, so the capacity check needs a counter it can read as
   *  a single document. */
  seatCount: number;
  status: RoomStatus;
  /** The `u64` the CONTRACT assigned, parsed from `CreateGameRoom`'s
   *  `game_id` tx attribute. `null` until the host launches.
   *
   *  A pointer, not state (see `config/firebase.ts` design note #0):
   *  write-once, and only ever used as the argument to a real on-chain
   *  query. `firestore.rules` enforces the write-once part. */
  chainGameId: number | null;
  /** The exact `ujuno` deposit every player must attach, as a base-denom
   *  INTEGER STRING (never a number -- `Uint128` overflows a JS double, the
   *  same discipline `config.ts`'s `formatNativeAmount` keeps).
   *
   *  Advertised here so joiners can attach the right amount up front. The
   *  contract's Uniform Ante Rule still enforces it to the last `ujuno`
   *  (`ContractError::InvalidAnteAmount`); this only saves a player from
   *  discovering the number by having a transaction rejected. */
  anteUjuno: string;
  /** `CreateGameRoom { virtual_bank_start }`, integer string, same reason. */
  virtualBankStart: string;
  createdAtMs: number;
  /** Surfaced to every player in the room, not just the host, so a failed
   *  launch explains itself to the people waiting on it. */
  launchError: string | null;
}

/** One claimed seat -- `games/{roomId}/seats/{address}`. The player's
 *  `juno1...` address IS the document id, which is what makes a double
 *  claim by the same wallet structurally impossible. */
export interface SeatDoc {
  address: string;
  displayName: string;
  ready: boolean;
  isHost: boolean;
  /** Whether this player has completed their on-chain ante. The host is
   *  `true` from launch (the contract registers the creator as the room's
   *  first player); everyone else flips when their `JoinGameRoom` confirms. */
  onChain: boolean;
  joinedAtMs: number;
  /** `serverTimestamp()` in milliseconds, or `null` while the write is
   *  still pending locally -- see `derivePresence`. */
  lastSeenMs: number | null;
}

export type PresenceState = "online" | "dropped";

/* ------------------------------------------------------------------ */
/* Display names                                                       */
/* ------------------------------------------------------------------ */
//
// Self-asserted and spoofable: Firestore is in Test Mode with no auth, so
// nothing stops a client writing any name it likes. The WALLET ADDRESS
// therefore remains the real identity everywhere identity matters -- turn
// order, ownership, payouts -- all of which are on-chain anyway and never
// read this field. A display name is a readability affordance for chat and
// the seat list, nothing more, which is why `SeatCard` and `ChatBox` both
// still show the truncated address alongside it.

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
/* Snapshot decoding                                                   */
/* ------------------------------------------------------------------ */
//
// Every field is read defensively with a fallback. This is not paranoia
// about Firestore -- it is that Test Mode lets ANY client write ANY shape
// to these documents, so a malformed doc is a thing that can actually
// happen, and one bad room must not throw inside a snapshot callback and
// tear down the whole listener for every other room.

function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function toIntegerString(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d+$/.test(value) ? value : fallback;
}

function decodeRoom(snapshot: QueryDocumentSnapshot<DocumentData>): RoomDoc {
  const data = snapshot.data() ?? {};
  const status = data.status;
  const chainGameId = data.chainGameId;
  return {
    id: snapshot.id,
    name: typeof data.name === "string" && data.name.trim() ? data.name : "Untitled room",
    hostAddress: typeof data.hostAddress === "string" ? data.hostAddress : "",
    hostDisplayName: typeof data.hostDisplayName === "string" ? data.hostDisplayName : "",
    maxPlayers:
      typeof data.maxPlayers === "number" && data.maxPlayers >= MIN_PLAYERS && data.maxPlayers <= MAX_PLAYERS
        ? data.maxPlayers
        : MAX_PLAYERS,
    seatCount: typeof data.seatCount === "number" && data.seatCount >= 0 ? data.seatCount : 0,
    status:
      status === "staging" || status === "launching" || status === "live" || status === "closed"
        ? status
        : "closed",
    // `Number.isSafeInteger` rather than a bare typeof: a `u64` game id
    // beyond 2^53 could not be used in a query without silent precision
    // loss, so treat it as absent rather than querying the wrong room.
    chainGameId: typeof chainGameId === "number" && Number.isSafeInteger(chainGameId) ? chainGameId : null,
    anteUjuno: toIntegerString(data.anteUjuno, "0"),
    virtualBankStart: toIntegerString(data.virtualBankStart, "0"),
    createdAtMs: toMillis(data.createdAt) ?? 0,
    launchError: typeof data.launchError === "string" && data.launchError ? data.launchError : null,
  };
}

function decodeSeat(snapshot: QueryDocumentSnapshot<DocumentData>): SeatDoc {
  const data = snapshot.data() ?? {};
  return {
    address: typeof data.address === "string" && data.address ? data.address : snapshot.id,
    displayName: typeof data.displayName === "string" ? data.displayName : "",
    ready: data.ready === true,
    isHost: data.isHost === true,
    onChain: data.onChain === true,
    joinedAtMs: toMillis(data.joinedAt) ?? 0,
    lastSeenMs: toMillis(data.lastSeen),
  };
}

/* ------------------------------------------------------------------ */
/* Presence derivation -- design note #1                               */
/* ------------------------------------------------------------------ */

/** Classifies every seat as online or dropped, measuring against the
 *  newest `lastSeen` in the room rather than the local clock.
 *
 *  A `null` `lastSeenMs` means the `serverTimestamp()` write is still
 *  pending locally -- which is only possible for a doc THIS client just
 *  wrote, i.e. one that is alive by definition. Treated as online, never as
 *  stale, so a player never briefly sees themselves as dropped in the
 *  moment they join. */
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
  return firebaseConfigError() ?? "[firebase] Firestore is unavailable.";
}

export interface LobbyRoomsResult {
  rooms: RoomDoc[];
  loading: boolean;
  /** Non-null means the list could not be loaded. Show it -- an empty list
   *  and a broken list look identical otherwise, and the second one lies. */
  error: string | null;
  /** `false` when Firebase is unconfigured, so the UI can say so plainly
   *  instead of rendering a permanently empty lobby. */
  available: boolean;
}

/** Live subscription to the room-discovery list.
 *
 *  Ordered by `createdAt` alone and filtered by status CLIENT-SIDE, on
 *  purpose: adding `where("status", "in", [...])` to an `orderBy` query
 *  makes it a composite query, which Firestore refuses to serve until
 *  someone manually creates a composite index in the console. A single-field
 *  `orderBy` runs on the automatic index that always exists. At
 *  ROOM_LIST_LIMIT rooms the client-side filter is free, and it keeps
 *  first-run setup to "enable Firestore" with no index step. */
export function useLobbyRooms(): LobbyRoomsResult {
  const [rooms, setRooms] = useState<RoomDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const db = getFirestoreDb();
  const available = db !== null;

  useEffect(() => {
    if (!db) {
      setRooms([]);
      setLoading(false);
      setError(unavailableMessage());
      return;
    }

    setLoading(true);
    const roomsQuery = query(
      collection(db, ROOMS_COLLECTION),
      orderBy("createdAt", "desc"),
      limit(ROOM_LIST_LIMIT),
    );

    const unsubscribe = onSnapshot(
      roomsQuery,
      (snapshot) => {
        setRooms(snapshot.docs.map(decodeRoom).filter((room) => room.status !== "closed"));
        setLoading(false);
        setError(null);
      },
      (snapshotError: FirestoreError) => {
        setLoading(false);
        setError(`[firebase] Could not load the room list: ${snapshotError.message}`);
      },
    );

    return unsubscribe;
  }, [db]);

  return { rooms, loading, error, available };
}

export interface RoomResult {
  room: RoomDoc | null;
  seats: SeatDoc[];
  presence: Map<string, PresenceState>;
  loading: boolean;
  error: string | null;
}

/** Live subscription to one room and its seats. Two listeners rather than
 *  one: seats carry a heartbeat that rewrites every PRESENCE_HEARTBEAT_MS,
 *  and folding them into the room document would re-fire the room snapshot
 *  -- and every consumer's re-render -- several times a minute for a
 *  document whose real contents almost never change. */
export function useRoom(roomId: string | null): RoomResult {
  const [room, setRoom] = useState<RoomDoc | null>(null);
  const [seats, setSeats] = useState<SeatDoc[]>([]);
  const [loading, setLoading] = useState(roomId !== null);
  const [error, setError] = useState<string | null>(null);

  const db = getFirestoreDb();

  useEffect(() => {
    if (!roomId) {
      setRoom(null);
      setSeats([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (!db) {
      setLoading(false);
      setError(unavailableMessage());
      return;
    }

    setLoading(true);
    const roomRef = doc(db, ROOMS_COLLECTION, roomId);
    const seatsQuery = query(collection(db, ROOMS_COLLECTION, roomId, SEATS_SUBCOLLECTION));

    const unsubscribeRoom = onSnapshot(
      roomRef,
      (snapshot) => {
        // `exists()` is a type guard narrowing to `QueryDocumentSnapshot`,
        // which is what `decodeRoom` needs -- no cast required.
        setRoom(snapshot.exists() ? decodeRoom(snapshot) : null);
        setLoading(false);
        setError(null);
      },
      (snapshotError: FirestoreError) => {
        setLoading(false);
        setError(`[firebase] Could not load the room: ${snapshotError.message}`);
      },
    );

    const unsubscribeSeats = onSnapshot(
      seatsQuery,
      (snapshot) => {
        // Sorted by join time so the seat list does not reshuffle on every
        // heartbeat -- Firestore returns documents in id (i.e. address)
        // order otherwise, which is stable but arbitrary, and any ordering
        // that changes as `lastSeen` changes would make the list jump.
        setSeats(snapshot.docs.map(decodeSeat).sort((a, b) => a.joinedAtMs - b.joinedAtMs));
      },
      (snapshotError: FirestoreError) => {
        setError(`[firebase] Could not load the seat list: ${snapshotError.message}`);
      },
    );

    return () => {
      unsubscribeRoom();
      unsubscribeSeats();
    };
  }, [db, roomId]);

  const presence = useMemo(() => derivePresence(seats), [seats]);

  return { room, seats, presence, loading, error };
}

/* ------------------------------------------------------------------ */
/* Heartbeat -- design note #1                                         */
/* ------------------------------------------------------------------ */

/** Keeps this player's own seat marked alive for as long as the component
 *  is mounted with a seat in `roomId`.
 *
 *  Deliberately usable from BOTH the lobby and the live game: a table needs
 *  to know the active turn-holder has dropped far more urgently mid-game
 *  than it does while waiting in a staging room. `App.tsx` mounts this for
 *  the whole session; `Lobby.tsx` mounts it while staging.
 *
 *  Writes are fire-and-forget. A failed heartbeat is not worth surfacing --
 *  it self-corrects on the next tick, and the failure it most often
 *  indicates (offline) is one the player can already see. */
export function usePresenceHeartbeat(roomId: string | null, address: string | null): void {
  const db = getFirestoreDb();
  // Held in a ref so `beat` stays referentially stable and the effect below
  // does not tear down and re-establish its interval on every render.
  const targetRef = useRef<{ roomId: string; address: string } | null>(null);
  targetRef.current = roomId && address ? { roomId, address } : null;

  const beat = useCallback(() => {
    const target = targetRef.current;
    if (!db || !target) return;
    const seatRef = doc(db, ROOMS_COLLECTION, target.roomId, SEATS_SUBCOLLECTION, target.address);
    void updateDoc(seatRef, { lastSeen: serverTimestamp() }).catch(() => {
      /* see doc comment -- self-correcting, not worth surfacing */
    });
  }, [db]);

  useEffect(() => {
    if (!db || !roomId || !address) return;

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
  }, [db, roomId, address, beat]);
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */
//
// Every one of these throws on failure rather than returning an error
// value. They are all invoked from an explicit user action (a button), so
// there is always a handler in a position to catch and display -- which is
// the same "throw at the point of use, where the UI is alive to show it"
// rule `config.ts` design note #0 sets out.

function requireDb() {
  const db = getFirestoreDb();
  if (!db) throw new Error(unavailableMessage());
  return db;
}

export interface CreateRoomInput {
  name: string;
  maxPlayers: number;
  hostAddress: string;
  hostDisplayName: string;
  /** Base-denom integer strings -- see `RoomDoc.anteUjuno`. */
  anteUjuno: string;
  virtualBankStart: string;
}

/** Creates a STAGING room. Touches no chain and costs no gas -- see design
 *  note #0 on why the on-chain room is deferred until launch. Returns the
 *  new Firestore room id, and seats the host immediately. */
export async function createStagingRoom(input: CreateRoomInput): Promise<string> {
  const db = requireDb();

  const maxPlayers = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.round(input.maxPlayers)));
  const name = input.name.trim().slice(0, 48) || "Untitled room";

  const roomRef = await addDoc(collection(db, ROOMS_COLLECTION), {
    name,
    hostAddress: input.hostAddress,
    hostDisplayName: input.hostDisplayName,
    maxPlayers,
    seatCount: 0,
    status: "staging" satisfies RoomStatus,
    chainGameId: null,
    anteUjuno: input.anteUjuno,
    virtualBankStart: input.virtualBankStart,
    createdAt: serverTimestamp(),
    launchError: null,
  });

  // Separate call, not part of the create: `claimSeat` is the ONE place a
  // seat is ever created, so its capacity accounting and its rejoin
  // handling cannot drift from a second inlined copy here.
  await claimSeat(roomRef.id, input.hostAddress, input.hostDisplayName, true);

  return roomRef.id;
}

/** Claims a seat, atomically.
 *
 *  A transaction, not a plain write, because two players clicking Join on
 *  the last seat of a room at the same moment is an ordinary race, not an
 *  exotic one -- and the consequence of losing it is a 5-player Firestore
 *  roster for a 4-player on-chain room, discovered only when someone's ante
 *  is rejected with `ContractError::RoomFull` after they have already
 *  signed. The capacity check and the seat write have to be one operation.
 *
 *  Re-claiming a seat you already hold is a no-op refresh, not an error:
 *  reloading the page mid-staging must not read as an attempt to take a
 *  second seat. The address being the document id is what makes that
 *  distinction free. */
export async function claimSeat(
  roomId: string,
  address: string,
  displayName: string,
  asHost = false,
): Promise<void> {
  const db = requireDb();
  const roomRef = doc(db, ROOMS_COLLECTION, roomId);
  const seatRef = doc(db, ROOMS_COLLECTION, roomId, SEATS_SUBCOLLECTION, address);

  await runTransaction(db, async (tx) => {
    // Firestore requires ALL reads before ANY writes inside a transaction.
    const roomSnapshot = await tx.get(roomRef);
    const seatSnapshot = await tx.get(seatRef);

    if (!roomSnapshot.exists()) throw new Error("That room no longer exists.");
    const room = roomSnapshot.data() ?? {};

    if (seatSnapshot.exists()) {
      tx.update(seatRef, { displayName, lastSeen: serverTimestamp() });
      return;
    }

    if (room.status !== "staging") {
      throw new Error("That room has already launched and is no longer accepting new seats.");
    }

    const seatCount = typeof room.seatCount === "number" ? room.seatCount : 0;
    const maxPlayers = typeof room.maxPlayers === "number" ? room.maxPlayers : MAX_PLAYERS;
    if (seatCount >= maxPlayers) throw new Error("That room is full.");

    tx.set(seatRef, {
      address,
      displayName,
      ready: asHost, // the host is implicitly ready; they are the one launching
      isHost: asHost,
      onChain: false,
      joinedAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
    });
    tx.update(roomRef, { seatCount: seatCount + 1 });
  });
}

/** Releases a seat, decrementing the counter in the same transaction that
 *  deletes the doc -- otherwise a room leaks capacity every time someone
 *  leaves and eventually reads as full with visibly empty seats. */
export async function releaseSeat(roomId: string, address: string): Promise<void> {
  const db = requireDb();
  const roomRef = doc(db, ROOMS_COLLECTION, roomId);
  const seatRef = doc(db, ROOMS_COLLECTION, roomId, SEATS_SUBCOLLECTION, address);

  await runTransaction(db, async (tx) => {
    const roomSnapshot = await tx.get(roomRef);
    const seatSnapshot = await tx.get(seatRef);
    if (!seatSnapshot.exists()) return;

    tx.delete(seatRef);
    if (roomSnapshot.exists()) {
      const raw = roomSnapshot.data().seatCount;
      const seatCount = typeof raw === "number" ? raw : 1;
      tx.update(roomRef, { seatCount: Math.max(0, seatCount - 1) });
    }
  });
}

export async function setSeatReady(roomId: string, address: string, ready: boolean): Promise<void> {
  const db = requireDb();
  await updateDoc(doc(db, ROOMS_COLLECTION, roomId, SEATS_SUBCOLLECTION, address), {
    ready,
    lastSeen: serverTimestamp(),
  });
}

export async function setSeatDisplayName(roomId: string, address: string, displayName: string): Promise<void> {
  const db = requireDb();
  await updateDoc(doc(db, ROOMS_COLLECTION, roomId, SEATS_SUBCOLLECTION, address), {
    displayName,
    lastSeen: serverTimestamp(),
  });
}

/** Marks a seat as having completed its on-chain ante. Called only after a
 *  `JoinGameRoom` transaction has actually confirmed -- never optimistically,
 *  because a seat that claims to be on-chain and is not would show the table
 *  a full roster for a game the contract will not let that player act in. */
export async function markSeatOnChain(roomId: string, address: string): Promise<void> {
  const db = requireDb();
  await updateDoc(doc(db, ROOMS_COLLECTION, roomId, SEATS_SUBCOLLECTION, address), {
    onChain: true,
    lastSeen: serverTimestamp(),
  });
}

export async function setRoomStatus(roomId: string, status: RoomStatus, launchError: string | null = null): Promise<void> {
  const db = requireDb();
  await updateDoc(doc(db, ROOMS_COLLECTION, roomId), { status, launchError });
}

/** Binds the room to the game id the CONTRACT assigned, flipping it live.
 *
 *  `chainGameId` is write-once by convention here and by rule in
 *  `firestore.rules`. It is the single field in this entire schema that
 *  other clients act on without verifying -- they pass it to
 *  `GetGameState` -- so it is the single field worth protecting hardest.
 *  Even so, the blast radius of a bad value is a failed or wrong query, not
 *  a corrupted game: the contract cannot be talked into agreeing. */
export async function bindChainGameId(roomId: string, chainGameId: number): Promise<void> {
  const db = requireDb();
  if (!Number.isSafeInteger(chainGameId) || chainGameId < 0) {
    throw new Error(`Refusing to bind a non-integer on-chain game id: ${chainGameId}`);
  }
  await updateDoc(doc(db, ROOMS_COLLECTION, roomId), {
    chainGameId,
    status: "live" satisfies RoomStatus,
    launchError: null,
  });
}

/* ------------------------------------------------------------------ */
/* Chat path helper                                                    */
/* ------------------------------------------------------------------ */

/** `games/{roomId}/chat`. Exported so `ChatBox.tsx` and this module cannot
 *  disagree about where chat lives -- and so the staging room and the live
 *  game demonstrably share ONE transcript, since both pass the same
 *  Firestore room id here. */
export function chatCollectionPath(roomId: string): [string, string, string] {
  return [ROOMS_COLLECTION, roomId, CHAT_SUBCOLLECTION];
}
