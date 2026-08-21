// frontend/src/utils/sandboxRoom.ts
//
// Real-time sandbox multiplayer as an append-only action log on Firestore.
//
// State is NOT mirrored: the sandbox is three atoms plus a turn cursor that
// advance together, so replaying the log reproduces them by running the code
// that produced them. A browser with no state reads from index 0 and catches up.
//
// Entries carry a monotonic integer `index` and readers sort by it -- 1830 is
// not commutative, and serverTimestamp() is null in the optimistic local
// snapshot. Simultaneous writes at one index are resolved identically by every
// client (document id tie-break); what that cannot prevent is the second action
// having been computed against a state without the first.
//
// See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #0, #1, #2

import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type FirestoreError,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

import { getFirestoreDb } from "../config/firebase";
/* Design note #530: `GameplayExecuteMsg` is no longer imported here --
   `SandboxLogMsg` is the union of it and the setup event, and this module
   only ever handles the union. */
import type { SandboxLogMsg, SetupPlayer } from "./gameSetup";

/** A new top-level collection beside `games`: a sandbox room shares none of RoomDoc's shape, and firestore.rules guards that collection for a different document.
 *  See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #519 */
export const SANDBOX_ROOMS_COLLECTION = "sandbox_rooms";
export const SANDBOX_ACTIONS_SUBCOLLECTION = "actions";

/* The alphabet drops 0/O, 1/I/L and 5/S because the code is read aloud; the JUNO- prefix is part of it. The harness asserts the PROPERTY, since the first draft kept 0 despite the rule written to remove it.
   See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #520 */
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
const ROOM_CODE_LENGTH = 3;
const ROOM_CODE_PREFIX = "JUNO-";

/** A fresh room code, e.g. `JUNO-4T2`. */
export function generateRoomCode(): string {
  let out = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return `${ROOM_CODE_PREFIX}${out}`;
}

/** Forgiving on input, strict on output: a bad code resolves to null rather than to a plausible room nobody is in.
 *  See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #520 */
export function parseRoomCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, "");
  const body = cleaned.startsWith(ROOM_CODE_PREFIX)
    ? cleaned.slice(ROOM_CODE_PREFIX.length)
    : cleaned;
  if (body.length !== ROOM_CODE_LENGTH) return null;
  for (const character of body) {
    if (!ROOM_CODE_ALPHABET.includes(character)) return null;
  }
  return `${ROOM_CODE_PREFIX}${body}`;
}

/** One entry in the room's append-only log. */
export interface SandboxAction {
  /** Design note #1: the sequencer. Monotonic from 0. */
  index: number;
  /** Firestore document id -- the deterministic tie-break for two entries
   *  that raced onto the same index. */
  id: string;
  /** Who dispatched it, for the log and for "whose turn" display. Not a
   *  permission: the sandbox has no authentication. */
  actor: string;
  /** Stored as JSON text, not a nested map -- Firestore rejects nested arrays and RunManualRoute.path is one. Round-tripping also guarantees every client applies a structurally identical object.
   *  See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #1 */
  payload: string;
  /* createdAt is read back so a replayed entry keeps its own clock; stamping Date.now() during a rebuild made every entry share one instant. undefined for older entries and unresolved writes.
     See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #643 */
  at?: number;
  /** Design note #668: dispatched BY THE GAME rather than by the player -- the
   *  auto-skip and the forced withhold. Recorded on the entry because it is a
   *  fact about the history that Undo has to read, and the acting client is the
   *  only party that ever knows it.
   *
   *  NOT the same question as `runGameplayAction`'s `automatic`, which is a turn
   *  gate: a home station placement and a B&O par are dispatched automatically
   *  and are still decisions the player made and may take back.
   *
   *  Absent on entries written before this field existed, which read as `false`
   *  -- the behaviour those rooms already had. */
  derived: boolean;
}

/** `payload` decoded, or `null` when it cannot be. A single unparseable
 *  entry must not take down a whole room's replay. */
export function decodeAction(action: SandboxAction): SandboxLogMsg | null {
  try {
    return JSON.parse(action.payload) as SandboxLogMsg;
  } catch {
    return null;
  }
}

/** Design note #1/#2: index first, document id as the deterministic
 *  tie-break. Exported because the ordering IS the correctness property and
 *  a test should be able to state it directly. */
export function sortActions(actions: readonly SandboxAction[]): SandboxAction[] {
  return [...actions].sort((a, b) => (a.index !== b.index ? a.index - b.index : a.id < b.id ? -1 : 1));
}

/** Whether the history a client has ALREADY APPLIED is still a prefix of the
 *  history the room now reports.
 *
 *  Design note #668: the drain used to detect a rewind by LENGTH -- a shorter
 *  effective history meant an undo had landed. Length is not enough, and this is
 *  the desync. Two clients writing at the same index both see their own
 *  optimistic entry first; the doc-id tie-break in `sortActions` then decides the
 *  real order, and for one of them that order REPLACES an entry it has already
 *  applied with a different one AT THE SAME LENGTH. Nothing shrank, so nothing
 *  rebuilt, and that client played on from a board no other client shares --
 *  which is what strands one player in OR 2.2 while the rest reach SR3.
 *
 *  Compares document ids, not payloads: two entries can carry identical JSON and
 *  still be different events, and the id is the only thing about an entry that is
 *  unique and agreed on by everybody. */
export function appliedPrefixHolds(
  appliedIds: readonly string[],
  history: readonly { id: string }[],
): boolean {
  if (appliedIds.length > history.length) return false;
  for (let at = 0; at < appliedIds.length; at += 1) {
    if (appliedIds[at] !== history[at].id) return false;
  }
  return true;
}

function toAction(snapshot: QueryDocumentSnapshot<DocumentData>): SandboxAction | null {
  const data = snapshot.data();
  const index = Number(data.index);
  if (!Number.isFinite(index)) return null;
  if (typeof data.payload !== "string") return null;
  /* Design note #643: `createdAt` is a Firestore `Timestamp` once the server
     has resolved it, and `null` in the brief local-echo window before that.
     `toMillis` is guarded rather than assumed -- an optimistic snapshot
     arriving without it is ordinary, not an error. */
  const createdAt = data.createdAt;
  const at =
    createdAt && typeof createdAt.toMillis === "function"
      ? Number(createdAt.toMillis())
      : undefined;
  return {
    index,
    id: snapshot.id,
    actor: typeof data.actor === "string" ? data.actor : "",
    payload: data.payload,
    // Design note #668: `=== true`, so a missing field on an older entry is
    // `false` rather than `undefined` leaking into the undo walk.
    derived: data.derived === true,
    ...(Number.isFinite(at) ? { at: at as number } : {}),
  };
}

/** Creates the room document. Returns the code, or `null` when Firestore is
 *  not configured -- which is a legitimate state (design note #1 in
 *  `config/firebase.ts`: the sandbox runs with no backend at all), so the
 *  caller reports it rather than this throwing. */
export async function hostSandboxRoom(hostId: string, nickname: string): Promise<string | null> {
  const db = getFirestoreDb();
  if (!db) return null;
  const code = generateRoomCode();
  await setDoc(doc(db, SANDBOX_ROOMS_COLLECTION, code), {
    code,
    hostId,
    /* Design note #527: every room opens in the anteroom. The host is
       seeded as its first player rather than joining afterwards, so the
       roster is never briefly empty in a room that plainly has somebody in
       it. */
    status: "waiting" as SandboxRoomStatus,
    players: [{ id: hostId, nickname, isReady: false }],
    createdAt: serverTimestamp(),
  });
  return code;
}

/** nextIndex comes from the CALLER, which is why this is not a transaction: the caller is already subscribed to the log, and a re-read per dispatch buys a guarantee #2 says is unobtainable anyway.
 *  See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #2 */
export async function appendSandboxAction(
  roomCode: string,
  nextIndex: number,
  actor: string,
  /* Design note #530: the log carries the setup event as well as gameplay
     messages. Both are single-key objects and both round-trip as JSON, so
     widening this changes nothing about how an entry is written. */
  msg: SandboxLogMsg,
  /** Design note #668: whether the GAME dispatched this rather than the player.
   *  Written into the entry, because a client replaying somebody else's log has
   *  no other way to tell an auto-skip from a deliberate one. */
  derived = false,
): Promise<boolean> {
  const db = getFirestoreDb();
  if (!db) return false;
  await addDoc(
    collection(db, SANDBOX_ROOMS_COLLECTION, roomCode, SANDBOX_ACTIONS_SUBCOLLECTION),
    {
      index: nextIndex,
      actor,
      payload: JSON.stringify(msg),
      derived,
      createdAt: serverTimestamp(),
    },
  );
  return true;
}

/** Reads the whole log once. Used to decide whether a joined room exists and
 *  what its length is before the live subscription opens. */
export async function readSandboxLog(roomCode: string): Promise<SandboxAction[]> {
  const db = getFirestoreDb();
  if (!db) return [];
  const snapshot = await getDocs(
    query(
      collection(db, SANDBOX_ROOMS_COLLECTION, roomCode, SANDBOX_ACTIONS_SUBCOLLECTION),
      orderBy("index"),
    ),
  );
  const out: SandboxAction[] = [];
  snapshot.forEach((entry) => {
    const action = toAction(entry);
    if (action) out.push(action);
  });
  return sortActions(out);
}

/** Hands back the WHOLE ordered log, not a delta -- a delta is identical when nothing goes wrong and a silent desync on a dropped snapshot or reconnect. The caller keeps the cursor.
 *  See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #0 */
export function subscribeSandboxLog(
  roomCode: string,
  onActions: (actions: SandboxAction[]) => void,
  onError?: (message: string) => void,
): () => void {
  const db = getFirestoreDb();
  if (!db) return () => undefined;
  return onSnapshot(
    query(
      collection(db, SANDBOX_ROOMS_COLLECTION, roomCode, SANDBOX_ACTIONS_SUBCOLLECTION),
      orderBy("index"),
    ),
    (snapshot) => {
      const out: SandboxAction[] = [];
      snapshot.forEach((entry) => {
        const action = toAction(entry);
        if (action) out.push(action);
      });
      onActions(sortActions(out));
    },
    (error: FirestoreError) => onError?.(error.message),
  );
}

/* The room document is the ANTEROOM: unordered lobby facts where a late write simply wins. status: "playing" is the latch, and everything after it comes from the log.
   See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #527 */
export type SandboxRoomStatus = "waiting" | "playing";

export interface SandboxRoomPlayer {
  id: string;
  nickname: string;
  isReady: boolean;
  /** Design note #569: this seat's chosen colour, or absent for "assign me
   *  one". Absent rather than pre-filled so the roster can tell a deliberate
   *  choice from a default -- only the former should block another player
   *  from picking it. */
  color?: string;
}

export interface SandboxRoomDoc {
  code: string;
  /** The `id` of whoever opened the room -- the only seat that may start. */
  hostId: string;
  status: SandboxRoomStatus;
  players: SandboxRoomPlayer[];
}

function toRoomDoc(code: string, data: DocumentData | undefined): SandboxRoomDoc | null {
  if (!data) return null;
  const players = Array.isArray(data.players) ? data.players : [];
  return {
    code,
    hostId: typeof data.hostId === "string" ? data.hostId : "",
    status: data.status === "playing" ? "playing" : "waiting",
    players: players
      .filter((entry: unknown): entry is DocumentData => typeof entry === "object" && entry !== null)
      .map((entry: DocumentData) => ({
        id: String(entry.id ?? ""),
        nickname: String(entry.nickname ?? ""),
        isReady: entry.isReady === true,
        // Design note #569: absent stays absent -- "" would read as a
        // deliberate choice of no colour and block nobody from anything.
        ...(typeof entry.color === "string" && entry.color ? { color: entry.color } : {}),
      }))
      .filter((entry: SandboxRoomPlayer) => entry.id.length > 0),
  };
}

/** Subscribes to the room document -- the waiting room's own state. */
export function subscribeSandboxRoom(
  roomCode: string,
  onRoom: (room: SandboxRoomDoc | null) => void,
  onError?: (message: string) => void,
): () => void {
  const db = getFirestoreDb();
  if (!db) return () => undefined;
  return onSnapshot(
    doc(db, SANDBOX_ROOMS_COLLECTION, roomCode),
    (snapshot) => onRoom(snapshot.exists() ? toRoomDoc(roomCode, snapshot.data()) : null),
    (error: FirestoreError) => onError?.(error.message),
  );
}

/** A TRANSACTION, unlike the append: the players array is a read-modify-write on one document several clients touch, which is the classic lost join.
 *  See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #527 */
export async function upsertSandboxPlayer(
  roomCode: string,
  player: SandboxRoomPlayer,
): Promise<boolean> {
  const db = getFirestoreDb();
  if (!db) return false;
  const ref = doc(db, SANDBOX_ROOMS_COLLECTION, roomCode);
  await runTransaction(db, async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists()) return;
    const room = toRoomDoc(roomCode, snapshot.data());
    /* An existing player is updated IN PLACE. Filter-and-append moved them to the back on every rename, and toSetupPlayers reads this order to build the shuffle payload.
       See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #541 */
    const existing = room?.players ?? [];
    const index = existing.findIndex((entry) => entry.id === player.id);
    const players =
      index === -1
        ? [...existing, player]
        : existing.map((entry, at) => (at === index ? player : entry));
    tx.update(ref, { players });
  });
  return true;
}

/** Latches the room into play. Design note #527: the handover. */
export async function markSandboxRoomPlaying(roomCode: string): Promise<void> {
  const db = getFirestoreDb();
  if (!db) return;
  await updateDoc(doc(db, SANDBOX_ROOMS_COLLECTION, roomCode), { status: "playing" });
}

/** Both conditions: all ready AND enough players. One person alone satisfies "all ready" trivially, and 1830 needs two.
 *  See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #527 */
export function canStartSandboxGame(room: SandboxRoomDoc | null, minPlayers: number): boolean {
  if (!room || room.status !== "waiting") return false;
  if (room.players.length < minPlayers) return false;
  return room.players.every((player) => player.isReady);
}

/** The waiting room's roster, as the setup payload wants it. */
export function toSetupPlayers(room: SandboxRoomDoc): SetupPlayer[] {
  return room.players.map((player) => ({
    id: player.id,
    nickname: player.nickname,
    // Design note #569: carried into the game, so every client paints the
    // same seat the same colour.
    color: player.color,
  }));
}

/* sessionStorage, not localStorage: two tabs must be two players, which is how one developer playtests this. It survives a refresh so a reloading player reclaims their own seat.
   See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #528 */
const PLAYER_ID_STORAGE_KEY = "juno.sandbox.playerId";

export function localPlayerId(): string {
  try {
    const existing = window.sessionStorage.getItem(PLAYER_ID_STORAGE_KEY);
    if (existing) return existing;
    const minted = `p-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(PLAYER_ID_STORAGE_KEY, minted);
    return minted;
  } catch {
    /* Private browsing. A per-render id would make this player a new seat on
       every render, so it is minted once per module load instead -- the
       session lasts as long as the tab, which is the same guarantee. */
    return FALLBACK_PLAYER_ID;
  }
}

const FALLBACK_PLAYER_ID = `p-${Math.random().toString(36).slice(2, 10)}`;
